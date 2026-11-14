/*
 * This file is part of paged (https://paged.media).
 *
 * paged is free software: you may redistribute it and/or modify it under the
 * terms of the GNU Affero General Public License, version 3, as published by
 * the Free Software Foundation, OR under the Paged Media Enterprise License
 * (PMEL), a commercial license available from And The Next GmbH. Full
 * copyright and license information is available in LICENSE.md, distributed
 * with this source code.
 *
 * paged is distributed in the hope that it will be useful, but WITHOUT ANY
 * WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE. See the licenses for details.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    AGPL-3.0-only OR Paged Media Enterprise License (PMEL)
 */

//! Engine ADR 1307 — a new document of facing pages; engine ADR 1308 —
//! relinking a placed picture is one undoable step that keeps the frame,
//! its fitting and the picture's size.

use std::io::Write;

use paged_canvas::channel::{BindingEdgeWire, Mutation};
use paged_canvas::{CanvasModel, CanvasOptions};
use paged_wire::ByteBuf;

#[test]
fn a_facing_document_puts_page_one_on_the_right_and_pairs_the_rest() {
    let m =
        CanvasModel::new_blank_layout("facing", 400.0, 600.0, 5, true, CanvasOptions::default())
            .expect("a facing blank loads");
    let pages = m.pages();
    assert_eq!(pages.len(), 5);
    let sides: Vec<_> = pages.iter().map(|p| p.binding_edge).collect();
    // A recto binds on its left edge, a verso on its right.
    assert_eq!(
        sides,
        [
            Some(BindingEdgeWire::Left),
            Some(BindingEdgeWire::Right),
            Some(BindingEdgeWire::Left),
            Some(BindingEdgeWire::Right),
            Some(BindingEdgeWire::Left),
        ]
    );
    let spreads: Vec<Option<String>> = pages.iter().map(|p| p.spread_id.clone()).collect();
    assert_ne!(spreads[0], spreads[1], "page 1 stands alone");
    assert_eq!(spreads[1], spreads[2], "pages 2 and 3 face each other");
    assert_eq!(spreads[3], spreads[4], "and 4 and 5");
    assert_eq!(
        m.scene().designmap.document_preference.facing_pages,
        Some(true)
    );
    // The IDML it saves says so.
    let idml = m.export_idml().expect("export");
    let doc = idml_import::import_idml(&idml).expect("reopen").0;
    assert_eq!(doc.designmap.document_preference.facing_pages, Some(true));
    assert_eq!(doc.spreads.len(), 3);
}

/// One page with a rectangle whose picture is linked to a file nobody
/// has, placed at half size 10 pt in.
fn missing_link_idml() -> Vec<u8> {
    use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};
    let mut zip = ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    let mut file = |name: &str, body: &str| {
        zip.start_file(name, stored).unwrap();
        zip.write_all(body.as_bytes()).unwrap();
    };
    file("mimetype", "application/vnd.adobe.indesign-idml-package");
    file(
        "designmap.xml",
        r#"<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging" Self="d1">
  <idPkg:Spread src="Spreads/Spread_sp1.xml"/>
</Document>"#,
    );
    file(
        "Spreads/Spread_sp1.xml",
        r#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Spread xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">
  <Spread Self="sp1">
    <Page Self="p1" GeometricBounds="0 0 400 400"/>
    <Rectangle Self="pic" GeometricBounds="20 20 220 220" StrokeWeight="0">
      <Image Self="img" ItemTransform="0.5 0 0 0.5 30 30">
        <Link Self="lnk" LinkResourceURI="file:missing.png"/>
      </Image>
    </Rectangle>
  </Spread>
</idPkg:Spread>"#,
    );
    zip.finish().unwrap().into_inner()
}

fn png(w: u32, h: u32) -> Vec<u8> {
    let rgba: Vec<u8> = [200u8, 40, 40, 255].repeat((w * h) as usize);
    paged_raster::encode_rgba8_png(&rgba, w, h).expect("png")
}

fn relink(m: &mut CanvasModel, uri: &str, bytes: Vec<u8>) {
    m.apply_mutation(&Mutation::RelinkImage {
        element_id: "pic".into(),
        uri: uri.into(),
        bytes: Some(ByteBuf(bytes)),
    })
    .expect("relink applies");
}

fn link(m: &CanvasModel) -> (String, String, Option<[f32; 6]>) {
    let l = m
        .links()
        .into_iter()
        .find(|l| l.host_self_id == "pic")
        .expect("the picture's link");
    (l.uri, l.status, l.image_transform)
}

#[test]
fn relinking_a_missing_picture_is_one_step_that_keeps_its_place() {
    let mut m =
        CanvasModel::load("relink", &missing_link_idml(), CanvasOptions::default()).expect("load");
    let hash = m.scene().canonical_hash();
    let before = link(&m);
    assert_eq!(before.0, "file:missing.png");
    assert_eq!(before.1, "missing");
    let steps = m.applied_log_len();

    relink(&mut m, "file:found.png", png(40, 20));
    let after = link(&m);
    assert_eq!(after.0, "file:found.png", "the link names its new source");
    assert_eq!(after.1, "ok", "and it draws");
    // The old source never drew, so its size is unknown: the picture
    // keeps its transform.
    assert_eq!(after.2, before.2);
    assert_eq!(m.applied_log_len(), steps + 1, "one step");

    m.undo().expect("undo");
    assert_eq!(link(&m), before);
    assert_eq!(
        m.scene().canonical_hash(),
        hash,
        "undo restores the document"
    );
    m.redo().expect("redo");
    assert_eq!(link(&m), after);
}

#[test]
fn a_relinked_picture_keeps_the_size_it_had_on_the_page() {
    let mut m =
        CanvasModel::load("relink", &missing_link_idml(), CanvasOptions::default()).expect("load");
    relink(&mut m, "file:small.png", png(40, 20));
    let (_, _, small) = link(&m);
    let small = small.expect("a transform");
    // Twice the pixels: the picture is drawn at half the scale, so it
    // covers the box the 40 × 20 one did.
    relink(&mut m, "file:large.png", png(80, 40));
    let (uri, status, large) = link(&m);
    assert_eq!((uri.as_str(), status.as_str()), ("file:large.png", "ok"));
    let large = large.expect("a transform");
    assert!(
        (large[0] - small[0] / 2.0).abs() < 1e-6,
        "{large:?} vs {small:?}"
    );
    assert!((large[3] - small[3] / 2.0).abs() < 1e-6);
    assert_eq!((large[4], large[5]), (small[4], small[5]), "same origin");
}

/// A page whose text frame holds a picture anchored in its text.
fn anchored_link_idml() -> Vec<u8> {
    use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};
    let mut zip = ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    let mut file = |name: &str, body: &str| {
        zip.start_file(name, stored).unwrap();
        zip.write_all(body.as_bytes()).unwrap();
    };
    file("mimetype", "application/vnd.adobe.indesign-idml-package");
    file(
        "designmap.xml",
        r#"<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging" Self="d1">
  <idPkg:Spread src="Spreads/Spread_sp1.xml"/>
  <idPkg:Story src="Stories/Story_s1.xml"/>
</Document>"#,
    );
    file(
        "Spreads/Spread_sp1.xml",
        r#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Spread xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">
  <Spread Self="sp1">
    <Page Self="p1" GeometricBounds="0 0 400 400"/>
    <TextFrame Self="tf" ParentStory="s1" GeometricBounds="20 20 300 380"/>
  </Spread>
</idPkg:Spread>"#,
    );
    file(
        "Stories/Story_s1.xml",
        r#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Story xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">
  <Story Self="s1">
    <ParagraphStyleRange>
      <CharacterStyleRange>
        <Content>Before </Content>
        <Rectangle Self="anc" GeometricBounds="0 0 40 40" StrokeWeight="0">
          <Image Self="aimg" ItemTransform="1 0 0 1 0 0">
            <Link Self="alnk" LinkResourceURI="file:old.png"/>
          </Image>
        </Rectangle>
        <Content> after</Content>
      </CharacterStyleRange>
    </ParagraphStyleRange>
  </Story>
</idPkg:Story>"#,
    );
    zip.finish().unwrap().into_inner()
}

#[test]
fn a_picture_anchored_in_the_text_is_relinked_by_its_uri() {
    let mut m = CanvasModel::load("anchored", &anchored_link_idml(), CanvasOptions::default())
        .expect("load");
    let uri = |m: &CanvasModel| {
        m.links()
            .into_iter()
            .find(|l| l.host_self_id == "anc")
            .map(|l| l.uri)
    };
    assert_eq!(uri(&m).as_deref(), Some("file:old.png"));
    // It has no embedded lane: bytes are refused, and nothing changes.
    assert!(m
        .apply_mutation(&Mutation::RelinkImage {
            element_id: "anc".into(),
            uri: "file:///new.png".into(),
            bytes: Some(ByteBuf(png(4, 4))),
        })
        .is_err());
    assert_eq!(uri(&m).as_deref(), Some("file:old.png"));
    // By its URI it is relinked, as one step.
    m.apply_mutation(&Mutation::RelinkImage {
        element_id: "anc".into(),
        uri: "https://example.com/new.png".into(),
        bytes: None,
    })
    .expect("relinked by uri");
    assert_eq!(uri(&m).as_deref(), Some("https://example.com/new.png"));
    m.undo().expect("undo");
    assert_eq!(uri(&m).as_deref(), Some("file:old.png"));
}
