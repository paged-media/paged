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

//! A feathered frame exports its stroke, and a feathered text frame its
//! text, under the feather's soft mask (engine ADR 204). The feathers
//! now follow the stroke and the text, and the soft-masked run reaches
//! from the frame's marker to its first feather.

use std::io::Write;

use paged_export_pdf::{export_pdf, ExportInkSettings, ExportInput, ExportOptions, ExportProfiles};
use paged_renderer::pipeline::{self, FontTable, PipelineOptions};
use paged_renderer::BytesResolver;
use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

const FEATHER: &str = r#"<FeatherSetting Mode="Standard" Width="10" CornerType="Sharp"/>"#;

fn package(item: &str, text: Option<&str>) -> Vec<u8> {
    let mut zip = ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    let deflated = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    zip.start_file("mimetype", stored).unwrap();
    zip.write_all(b"application/vnd.adobe.indesign-idml-package")
        .unwrap();
    let story_ref = if text.is_some() {
        r#"<idPkg:Story src="Stories/Story_s1.xml"/>"#
    } else {
        ""
    };
    let mut files = vec![
        (
            "designmap.xml".to_string(),
            format!(
                r#"<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging" DOMVersion="20.0">
  <idPkg:Graphic src="Resources/Graphic.xml"/>
  <idPkg:Spread src="Spreads/Spread_sp1.xml"/>
  {story_ref}
</Document>"#
            ),
        ),
        (
            "Resources/Graphic.xml".to_string(),
            r#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Graphic xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">
  <Color Self="Color/Black" Name="Black" Model="Process" Space="CMYK" ColorValue="0 0 0 100"/>
  <Color Self="Color/Yellow" Name="Yellow" Model="Process" Space="CMYK" ColorValue="0 0 100 0"/>
</idPkg:Graphic>"#
                .to_string(),
        ),
        (
            "Spreads/Spread_sp1.xml".to_string(),
            format!(
                r#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Spread xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging" DOMVersion="20.0">
  <Spread Self="sp1">
    <Page Self="p1" GeometricBounds="0 0 200 200"/>
    {item}
  </Spread>
</idPkg:Spread>"#
            ),
        ),
    ];
    if let Some(text) = text {
        files.push((
            "Stories/Story_s1.xml".to_string(),
            format!(
                r#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Story xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging" DOMVersion="20.0"><Story Self="s1"><ParagraphStyleRange><CharacterStyleRange AppliedFont="Open Sans" FontStyle="Regular" PointSize="30" FillColor="Color/Black"><Content>{text}</Content></CharacterStyleRange></ParagraphStyleRange></Story></idPkg:Story>"#
            ),
        ));
    }
    for (name, body) in files {
        zip.start_file(name, deflated).unwrap();
        zip.write_all(body.as_bytes()).unwrap();
    }
    zip.finish().unwrap().into_inner()
}

/// The page's content stream, exported with Open Sans available.
fn page_content(item: &str, text: Option<&str>) -> String {
    let mut assets = BytesResolver::new();
    let font = std::fs::read(
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../corpus/fonts/OpenSans.ttf"),
    )
    .expect("corpus/fonts/OpenSans.ttf");
    assets.add_font("Open Sans", None, font);
    let opts = PipelineOptions {
        assets: Some(&assets),
        ..PipelineOptions::default()
    };
    let document = idml_import::import_idml_doc(&package(item, text)).unwrap();
    let fonts = FontTable::build(&document, &opts);
    let doc = pipeline::build_document(&document, &opts).unwrap();
    let cmm = paged_color::IccCmm::new(None, paged_color::DisplaySetup::default());
    let pdf = export_pdf(ExportInput {
        doc: &doc,
        palette: &document.palette,
        fonts: Some(&fonts),
        cmm: &cmm,
        profiles: ExportProfiles::default(),
        inks: ExportInkSettings::default(),
        options: ExportOptions::default(),
        doc_bleed: [0.0; 4],
        doc_slug: [0.0; 4],
    })
    .expect("export")
    .bytes;
    let pdf = lopdf::Document::load_mem(&pdf).expect("re-parse");
    let (_, page) = pdf.get_pages().into_iter().next().unwrap();
    String::from_utf8_lossy(&pdf.get_page_content(page)).into_owned()
}

/// The text after the soft mask is set, up to the restore that ends it.
fn masked(content: &str) -> &str {
    let at = content
        .find("/GsSm")
        .unwrap_or_else(|| panic!("no feather soft mask in the page:\n{content}"));
    let rest = &content[at..];
    // The run is walked between `q /GsSm gs` and its `Q`; nested
    // save/restore pairs inside it balance.
    let mut depth = 0i32;
    for (i, line) in rest.split('\n').enumerate() {
        for op in line.split_whitespace() {
            match op {
                "q" => depth += 1,
                "Q" if depth == 0 => {
                    let end: usize = rest.split('\n').take(i).map(|l| l.len() + 1).sum();
                    return &rest[..end];
                }
                "Q" => depth -= 1,
                _ => {}
            }
        }
    }
    rest
}

/// A stroked frame's stroke paints under its feather's soft mask.
#[test]
fn a_feathered_frames_stroke_exports_under_the_soft_mask() {
    let item = format!(
        r#"<Rectangle Self="r1" GeometricBounds="40 40 160 160" FillColor="Color/Yellow" StrokeWeight="8" StrokeColor="Color/Black"><TransparencySetting>{FEATHER}</TransparencySetting></Rectangle>"#
    );
    let content = page_content(&item, None);
    let run = masked(&content);
    assert!(
        run.split_whitespace().any(|op| op == "S"),
        "the stroke paints inside the masked run:\n{content}"
    );
}

/// A feathered text frame's text paints under its soft mask.
#[test]
fn a_feathered_text_frames_text_exports_under_the_soft_mask() {
    let item = format!(
        r#"<TextFrame Self="t1" ParentStory="s1" GeometricBounds="70 40 130 160" FillColor="Color/Yellow"><Properties/><TransparencySetting>{FEATHER}</TransparencySetting><TextFramePreference InsetSpacing="0 0 0 0"/></TextFrame>"#
    );
    let content = page_content(&item, Some("HHHH"));
    let run = masked(&content);
    // The text exports as real text or, with no embeddable face, as one
    // filled outline per glyph after the box's own fill.
    let fills = run.split_whitespace().filter(|op| *op == "f").count();
    assert!(
        run.contains("Tj") || run.contains("TJ") || fills >= 5,
        "the text paints inside the masked run:\n{content}"
    );
}
