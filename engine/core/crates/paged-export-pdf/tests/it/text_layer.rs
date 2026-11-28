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

//! The PDF's text layer reads as the source does: a ligature's glyph
//! maps to every letter it stands for (its `/ToUnicode` entry, or an
//! `/ActualText` span), and text on a path has a text layer at all. The
//! test exports a frame and a path whose words ligate, reads the text
//! back out of the written content stream and fonts, and compares it
//! with what was typed.

use std::collections::HashMap;
use std::io::Write;

use paged_export_pdf::{export_pdf, ExportInkSettings, ExportInput, ExportOptions, ExportProfiles};
use paged_renderer::pipeline::{self, FontTable, PipelineOptions};
use paged_renderer::BytesResolver;
use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

const FRAME_TEXT: &str = "office waffle fine";
const PATH_TEXT: &str = "fluffy file";

fn story(id: &str, text: &str) -> (String, String) {
    (
        format!("Stories/Story_{id}.xml"),
        format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Story xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging" DOMVersion="20.0"><Story Self="{id}"><ParagraphStyleRange><CharacterStyleRange AppliedFont="Open Sans" FontStyle="Regular" PointSize="24" FillColor="Color/Black"><Content>{text}</Content></CharacterStyleRange></ParagraphStyleRange></Story></idPkg:Story>"#
        ),
    )
}

/// One page: a text frame holding `FRAME_TEXT` and a straight open path
/// carrying `PATH_TEXT`.
fn package() -> Vec<u8> {
    let mut zip = ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    let deflated = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    zip.start_file("mimetype", stored).unwrap();
    zip.write_all(b"application/vnd.adobe.indesign-idml-package")
        .unwrap();
    let files = vec![
        (
            "designmap.xml".to_string(),
            r#"<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging" DOMVersion="20.0">
  <idPkg:Graphic src="Resources/Graphic.xml"/>
  <idPkg:Spread src="Spreads/Spread_sp1.xml"/>
  <idPkg:Story src="Stories/Story_s1.xml"/>
  <idPkg:Story src="Stories/Story_s2.xml"/>
</Document>"#
                .to_string(),
        ),
        (
            "Resources/Graphic.xml".to_string(),
            r#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Graphic xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">
  <Color Self="Color/Black" Name="Black" Model="Process" Space="CMYK" ColorValue="0 0 0 100"/>
</idPkg:Graphic>"#
                .to_string(),
        ),
        (
            "Spreads/Spread_sp1.xml".to_string(),
            r#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Spread xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging" DOMVersion="20.0">
  <Spread Self="sp1">
    <Page Self="p1" GeometricBounds="0 0 400 600"/>
    <TextFrame Self="tf1" ParentStory="s1" GeometricBounds="40 40 160 560"/>
    <Polygon Self="pg1" ItemTransform="1 0 0 1 0 0" StrokeWeight="0">
      <Properties>
        <PathGeometry>
          <GeometryPathType PathOpen="true">
            <PathPointArray>
              <PathPointType Anchor="40 300" LeftDirection="40 300" RightDirection="40 300"/>
              <PathPointType Anchor="560 300" LeftDirection="560 300" RightDirection="560 300"/>
            </PathPointArray>
          </GeometryPathType>
        </PathGeometry>
      </Properties>
      <TextPath Self="tp1" ParentStory="s2"/>
    </Polygon>
  </Spread>
</idPkg:Spread>"#
                .to_string(),
        ),
        story("s1", FRAME_TEXT),
        story("s2", PATH_TEXT),
    ];
    for (name, body) in files {
        zip.start_file(name, deflated).unwrap();
        zip.write_all(body.as_bytes()).unwrap();
    }
    zip.finish().unwrap().into_inner()
}

fn export() -> Vec<u8> {
    let mut assets = BytesResolver::new();
    let font = std::fs::read(
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../corpus/fonts/OpenSans.ttf"),
    )
    .expect("corpus/fonts/OpenSans.ttf");
    assets.add_font("Open Sans", None, font);
    let opts = PipelineOptions {
        assets: Some(&assets),
        collect_glyph_runs: true,
        ..PipelineOptions::default()
    };
    let document = idml_import::import_idml_doc(&package()).expect("import");
    let fonts = FontTable::build(&document, &opts);
    let doc = {
        let o = PipelineOptions {
            pre_built_font_table: Some(&fonts),
            ..opts
        };
        pipeline::build_document(&document, &o).expect("build document")
    };
    let cmm = paged_color::IccCmm::new(None, paged_color::DisplaySetup::default());
    export_pdf(ExportInput {
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
    .bytes
}

/// A `/ToUnicode` CMap's `bfchar` entries: code to text.
fn to_unicode(cmap: &str) -> HashMap<u16, String> {
    let mut map = HashMap::new();
    let mut inside = false;
    for line in cmap.lines() {
        let line = line.trim();
        if line.ends_with("beginbfchar") {
            inside = true;
        } else if line == "endbfchar" {
            inside = false;
        } else if inside {
            let mut parts = line.split(['<', '>']).filter(|p| !p.trim().is_empty());
            let code = u16::from_str_radix(parts.next().expect("code"), 16).expect("hex code");
            let hex = parts.next().expect("text");
            let units: Vec<u16> = (0..hex.len() / 4)
                .map(|i| u16::from_str_radix(&hex[i * 4..i * 4 + 4], 16).expect("hex unit"))
                .collect();
            map.insert(code, String::from_utf16(&units).expect("UTF-16"));
        }
    }
    map
}

/// A PDF text string (UTF-16BE with a byte-order mark, or PDFDocEncoding
/// for plain ASCII) as text.
fn text_string(bytes: &[u8]) -> String {
    match bytes.strip_prefix(&[0xFE, 0xFF]) {
        Some(utf16) => {
            let units: Vec<u16> = utf16
                .as_chunks::<2>()
                .0
                .iter()
                .map(|b| u16::from_be_bytes(*b))
                .collect();
            String::from_utf16(&units).expect("UTF-16")
        }
        None => String::from_utf8_lossy(bytes).into_owned(),
    }
}

/// What the page's text layer says, one string per text object, as a
/// PDF reader extracts it: every shown code through its font's
/// `/ToUnicode`, or the `/ActualText` of the span around it. Also the
/// multi-character `/ToUnicode` entries met on the way.
fn extract(pdf: &[u8]) -> (Vec<String>, Vec<String>) {
    let doc = lopdf::Document::load_mem(pdf).expect("re-parse");
    let (_, page_id) = doc.get_pages().into_iter().next().expect("a page");
    let page = doc.get_dictionary(page_id).expect("page dict");
    let resources = doc
        .dereference(page.get(b"Resources").expect("Resources"))
        .expect("deref Resources")
        .1
        .as_dict()
        .expect("dict");
    let font_dict = resources
        .get(b"Font")
        .and_then(|f| doc.dereference(f))
        .expect("fonts")
        .1
        .as_dict()
        .expect("font dict");
    let mut fonts: HashMap<Vec<u8>, HashMap<u16, String>> = HashMap::new();
    let mut ligatures = Vec::new();
    for (name, font) in font_dict.iter() {
        let font = doc
            .dereference(font)
            .expect("font")
            .1
            .as_dict()
            .expect("dict");
        let cmap = doc
            .dereference(font.get(b"ToUnicode").expect("every font has a ToUnicode"))
            .expect("cmap")
            .1
            .as_stream()
            .expect("stream");
        let map = to_unicode(&String::from_utf8_lossy(&cmap.content));
        ligatures.extend(map.values().filter(|t| t.chars().count() > 1).cloned());
        fonts.insert(name.clone(), map);
    }
    ligatures.sort();

    let content =
        lopdf::content::Content::decode(&doc.get_page_content(page_id)).expect("operators");
    let mut objects = Vec::new();
    let mut current = String::new();
    let mut font: Option<&HashMap<u16, String>> = None;
    // The ActualText of the open marked-content sequences, innermost last.
    let mut spans: Vec<Option<String>> = Vec::new();
    for op in &content.operations {
        match op.operator.as_str() {
            "BT" => current.clear(),
            "ET" => objects.push(std::mem::take(&mut current)),
            "Tf" => font = fonts.get(op.operands[0].as_name().expect("font name")),
            "BDC" => {
                let actual = op
                    .operands
                    .get(1)
                    .and_then(|p| p.as_dict().ok())
                    .and_then(|d| {
                        d.get(b"ActualText")
                            .and_then(|t| t.as_str())
                            .ok()
                            .map(text_string)
                    });
                if let Some(text) = &actual {
                    current.push_str(text);
                }
                spans.push(actual);
            }
            "BMC" => spans.push(None),
            "EMC" => {
                spans.pop();
            }
            "Tj" => {
                // Inside an ActualText span the span's text stands for
                // whatever is shown.
                if spans.iter().any(Option::is_some) {
                    continue;
                }
                let codes = op.operands[0].as_str().expect("shown string");
                for code in codes.as_chunks::<2>().0 {
                    let code = u16::from_be_bytes(*code);
                    let text = font
                        .and_then(|f| f.get(&code))
                        .unwrap_or_else(|| panic!("code {code:#06x} has no ToUnicode entry"));
                    current.push_str(text);
                }
            }
            _ => {}
        }
    }
    (objects, ligatures)
}

fn letters(text: &str) -> String {
    text.chars().filter(|c| !c.is_whitespace()).collect()
}

#[test]
fn ligatures_and_text_on_a_path_extract_as_typed() {
    let pdf = export();
    let (objects, ligatures) = extract(&pdf);
    // The words ligate, or the test proves nothing about ligatures.
    assert!(
        !ligatures.is_empty(),
        "the font set no ligature; text objects: {objects:?}"
    );
    for lig in &ligatures {
        assert!(
            ["ff", "fi", "fl", "ffi", "ffl"].contains(&lig.as_str()),
            "a multi-character mapping that is no ligature of the text: {lig:?}"
        );
    }
    // A space draws nothing and has no glyph in the layer; the letters
    // are what a search finds.
    let mut got: Vec<String> = objects.iter().map(|o| letters(o)).collect();
    got.retain(|o| !o.is_empty());
    got.sort();
    let mut want = vec![letters(FRAME_TEXT), letters(PATH_TEXT)];
    want.sort();
    assert_eq!(
        got.concat().len(),
        want.concat().len(),
        "every letter once: {objects:?}"
    );
    assert_eq!(got, want, "ligature mappings: {ligatures:?}");
}
