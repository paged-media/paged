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

//! Engine ADR 1045 — an anchored frame's look in PDF: it reaches the
//! exporter through the same display list a free frame's does, so its
//! opacity is an ExtGState, its blur a rasterised layer (reported), and
//! its InDesign effects as they always export.

use paged_export_pdf::{export_pdf, ExportInkSettings, ExportInput, ExportOptions, ExportProfiles};
use paged_model::effect_stack::{
    Effect, EffectBearing, EffectEntry, EffectTarget, GaussianBlurParams,
};
use paged_renderer::pipeline::{self, FontTable, PipelineOptions};

struct Exported {
    content: String,
    findings: Vec<String>,
    smask_images: usize,
}

/// A text frame whose story opens with a filled 60 pt inline frame,
/// then a word.
fn package() -> Vec<u8> {
    use std::io::Write;
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let stored =
        zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    let mut put = |name: &str, body: &[u8]| {
        zip.start_file(name, stored).unwrap();
        zip.write_all(body).unwrap();
    };
    put("mimetype", b"application/vnd.adobe.indesign-idml-package");
    put(
        "designmap.xml",
        br#"<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">
  <idPkg:Graphic src="Resources/Graphic.xml"/>
  <idPkg:Spread src="Spreads/Spread_sp1.xml"/>
  <idPkg:Story src="Stories/Story_st1.xml"/>
</Document>"#,
    );
    put(
        "Resources/Graphic.xml",
        br#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Graphic xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">
  <Color Self="Color/Black" Name="Black" Model="Process" Space="CMYK" ColorValue="0 0 0 100"/>
</idPkg:Graphic>"#,
    );
    put(
        "Spreads/Spread_sp1.xml",
        br#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Spread xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">
  <Spread Self="sp1">
    <Page Self="p1" GeometricBounds="0 0 200 200" ItemTransform="1 0 0 1 0 0"/>
    <TextFrame Self="tf1" ParentStory="st1" GeometricBounds="20 20 180 180" ItemTransform="1 0 0 1 0 0"/>
  </Spread>
</idPkg:Spread>"#,
    );
    put(
        "Stories/Story_st1.xml",
        br#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Story xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">
<Story Self="st1"><ParagraphStyleRange><CharacterStyleRange AppliedFont="Open Sans" PointSize="12">
<Rectangle Self="a1" GeometricBounds="0 0 60 60" FillColor="Color/Black" StrokeWeight="0">
<AnchoredObjectSetting AnchoredPosition="InlinePosition"/>
</Rectangle>
<Content>x</Content>
</CharacterStyleRange></ParagraphStyleRange></Story></idPkg:Story>"#,
    );
    zip.finish().unwrap().into_inner()
}

/// The package with its anchored frame given `look`, exported.
fn export_with(look: impl Fn(&mut paged_model::AnchoredFrame)) -> Exported {
    let mut document = idml_import::import_idml_doc(&package()).expect("import");
    let frame = document.stories[0].story.paragraphs[0]
        .anchored_frames
        .first_mut()
        .expect("the anchored frame");
    look(frame);
    let mut assets = paged_renderer::BytesResolver::new();
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
    let fonts = FontTable::build(&document, &opts);
    let doc = pipeline::build_document(&document, &opts).expect("build document");
    let cmm = paged_color::IccCmm::new(None, paged_color::DisplaySetup::default());
    let result = export_pdf(ExportInput {
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
    .expect("export");
    let parsed = lopdf::Document::load_mem(&result.bytes).expect("re-parse");
    let mut out = Vec::new();
    for (_, page_id) in parsed.get_pages() {
        out.extend(parsed.get_page_content(page_id));
        out.push(b'\n');
    }
    let smask_images = parsed
        .objects
        .values()
        .filter_map(|o| o.as_stream().ok())
        .filter(|s| {
            s.dict.get(b"Subtype").and_then(|v| v.as_name()).ok() == Some(b"Image".as_slice())
                && s.dict.get(b"SMask").is_ok()
                && s.dict.get(b"Width").and_then(|w| w.as_i64()).unwrap_or(0) > 1
        })
        .count();
    Exported {
        content: String::from_utf8_lossy(&out).into_owned(),
        findings: result.findings.iter().map(|f| f.code.to_string()).collect(),
        smask_images,
    }
}

#[test]
#[allow(non_snake_case)]
fn an_anchored_blur_is_rasterised_and_reported__feat__anchored_inline_objects_anchored_effects() {
    let plain = export_with(|_| {});
    assert_eq!(plain.smask_images, 0);
    assert!(!plain.findings.iter().any(|c| c == "effect_rasterized"));
    let blurred = export_with(|f| {
        f.effect_slots_mut(EffectTarget::Object)
            .set_stack(vec![EffectEntry::new(Effect::GaussianBlur(
                GaussianBlurParams { radius_pt: 3.0 },
            ))])
            .expect("stack");
    });
    assert_eq!(blurred.smask_images, 1, "the blurred layer is one image");
    assert!(
        blurred.findings.iter().any(|c| c == "effect_rasterized"),
        "{:?}",
        blurred.findings
    );
}

#[test]
#[allow(non_snake_case)]
fn an_anchored_frames_opacity_is_a_graphics_state__feat__anchored_inline_objects_anchored_effects()
{
    let plain = export_with(|_| {});
    let faded = export_with(|f| f.opacity = Some(40.0));
    let gs = |c: &str| c.split_whitespace().filter(|t| *t == "gs").count();
    assert!(
        gs(&faded.content) > gs(&plain.content),
        "the frame's group sets its opacity"
    );
    assert_eq!(faded.smask_images, 0, "opacity stays vector");
}
