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

//! ADR 205 — `RequestSnapshot.markers`: a snapshot is drawn as the exports
//! draw the page unless it asks for the canvas's editor-only markers (the
//! pink highlight behind text in a substitute face, the ghost-cross over
//! EPS/PDF content that cannot be drawn).

use paged_canvas::{
    render_snapshot_png, render_snapshot_png_hiding, CanvasModel, CanvasOptions, ElementId,
};
use paged_wire::PageId;

/// One text frame whose story asks for a family nobody has (served by the
/// default face, so substituted) and one rectangle holding an inline PDF
/// with no link (the ghost-cross case).
fn degraded_idml() -> Vec<u8> {
    idml("Ghost Family", true)
}

/// The same page set in `font`, with or without the undrawable PDF.
fn idml(font: &str, with_pdf: bool) -> Vec<u8> {
    use std::io::Write;
    use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};
    let mut zip = ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    let file = |zip: &mut ZipWriter<_>, name: &str, body: &str| {
        zip.start_file(name, stored).unwrap();
        zip.write_all(body.as_bytes()).unwrap();
    };
    file(
        &mut zip,
        "mimetype",
        "application/vnd.adobe.indesign-idml-package",
    );
    file(
        &mut zip,
        "designmap.xml",
        r#"<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging" Self="d1">
  <idPkg:Spread src="Spreads/Spread_sp1.xml"/>
  <idPkg:Story src="Stories/Story_s1.xml"/>
</Document>"#,
    );
    file(
        &mut zip,
        "Spreads/Spread_sp1.xml",
        &r#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Spread xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">
  <Spread Self="sp1">
    <Page Self="p1" GeometricBounds="0 0 400 400"/>
    <TextFrame Self="frameA" ParentStory="s1" GeometricBounds="20 20 120 380"/>
    {pdf}
  </Spread>
</idPkg:Spread>"#
            .replace(
                "{pdf}",
                if with_pdf {
                    r#"<Rectangle Self="r1" GeometricBounds="150 20 250 120"><PDF/></Rectangle>"#
                } else {
                    ""
                },
            ),
    );
    file(
        &mut zip,
        "Stories/Story_s1.xml",
        &r#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Story xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">
  <Story Self="s1">
    <ParagraphStyleRange>
      <CharacterStyleRange AppliedFont="{font}" PointSize="24">
        <Content>Missing font text</Content>
      </CharacterStyleRange>
    </ParagraphStyleRange>
  </Story>
</idPkg:Story>"#
            .replace("{font}", font),
    );
    zip.finish().unwrap().into_inner()
}

fn inter() -> Vec<u8> {
    std::fs::read(
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../corpus/fonts/Inter.ttf"),
    )
    .expect("Inter.ttf fixture")
}

fn load(bytes: &[u8]) -> CanvasModel {
    let opts = CanvasOptions {
        fonts: vec![inter()],
        ..CanvasOptions::default()
    };
    CanvasModel::load("markers", bytes, opts).expect("load")
}

fn page(m: &CanvasModel) -> PageId {
    PageId(m.pages()[0].self_id.clone())
}

/// The pixels of a PNG that read as the substituted-font pink: red at
/// full, blue clearly above green, both well below red. Text is black and
/// the page white, so nothing else on these pages comes near it.
fn pink_pixels(png: &[u8]) -> usize {
    let img = image::load_from_memory(png).expect("decode").to_rgba8();
    img.pixels()
        .filter(|p| {
            let [r, g, b, _] = p.0;
            r > 230 && g > 90 && g < 190 && b > g + 8 && b < r - 30
        })
        .count()
}

fn snapshot(m: &CanvasModel, markers: bool) -> Vec<u8> {
    render_snapshot_png_hiding(m, &page(m), 400, None, &[], markers)
        .expect("snapshot")
        .png_bytes
}

#[test]
fn a_snapshot_leaves_the_canvas_markers_out_unless_asked() {
    let m = load(&degraded_idml());
    assert!(
        m.live_build_has_markers(),
        "the fixture substitutes a face and carries an undrawable PDF"
    );
    let marked = snapshot(&m, true);
    assert!(
        pink_pixels(&marked) > 100,
        "asked for, the snapshot shows the pink highlight ({} pink pixels)",
        pink_pixels(&marked)
    );
    let clean = snapshot(&m, false);
    assert_eq!(
        pink_pixels(&clean),
        0,
        "by default the snapshot has no pink"
    );
    assert_ne!(clean, marked);

    // The canvas keeps its markers: the worker's tile loop draws the live
    // page, and the export build did not replace it.
    let tile = render_snapshot_png(&m, &page(&m), 400)
        .expect("tile")
        .png_bytes;
    assert_eq!(
        tile, marked,
        "the canvas's own page still carries the markers"
    );
    // A second clean snapshot reads the same export build.
    assert_eq!(snapshot(&m, false), clean);
}

#[test]
fn a_snapshot_of_a_page_with_items_hidden_has_no_markers_either() {
    let m = load(&degraded_idml());
    for markers in [false, true] {
        let png = render_snapshot_png_hiding(
            &m,
            &page(&m),
            400,
            None,
            &[ElementId::Rectangle("r1".into())],
            markers,
        )
        .expect("snapshot")
        .png_bytes;
        assert_eq!(
            pink_pixels(&png),
            0,
            "hidden-items snapshot, markers={markers}"
        );
    }
}

#[test]
fn a_document_without_markers_draws_the_same_either_way() {
    // The same text in the face the model has: nothing is substituted.
    let m = load(&idml("Inter", false));
    assert!(!m.live_build_has_markers());
    assert!(m.live_build_is_export_faithful());
    assert_eq!(snapshot(&m, false), snapshot(&m, true));
}

#[test]
fn an_edit_reaches_the_next_snapshot_drawn_for_export() {
    let mut m = load(&degraded_idml());
    let before = snapshot(&m, false);
    m.apply_mutation(&paged_canvas::Mutation::InsertText {
        story_id: "s1".into(),
        offset: 0,
        text: "More ".into(),
        cell: None,
    })
    .expect("insert text");
    let after = snapshot(&m, false);
    assert_ne!(after, before, "the export build is rebuilt after an edit");
    assert_eq!(pink_pixels(&after), 0);
    assert!(pink_pixels(&snapshot(&m, true)) > 100);
}
