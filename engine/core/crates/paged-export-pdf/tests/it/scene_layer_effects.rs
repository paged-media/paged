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

//! Engine ADR 1046 — a plugin scene layer in PDF. It paints inside its
//! frame's transparency group, so a frame at 50 % opacity exports its box
//! and its scene layer into ONE transparency-group form drawn at 50 %; and
//! inside the frame's effect layers, so a blurred frame rasterises its
//! scene layer with the box into the one layer image instead of leaving it
//! sharp and vector on top.

use std::collections::HashMap;
use std::io::Write;

use paged_compose::{SceneItem, SceneLayer, ScenePaint, ScenePathSeg};
use paged_export_pdf::{export_pdf, ExportInkSettings, ExportInput, ExportOptions, ExportProfiles};
use paged_model::effect_stack::{
    Effect, EffectBearing, EffectEntry, EffectTarget, GaussianBlurParams,
};
use paged_renderer::pipeline::{self, FontTable, PipelineOptions};

fn idml() -> Vec<u8> {
    use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};
    let spread = r#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Spread xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">
  <Spread Self="sp1">
    <Page Self="p1" GeometricBounds="0 0 200 200"/>
    <Rectangle Self="sq" GeometricBounds="50 50 150 150" FillColor="Color/Black" StrokeWeight="0"/>
  </Spread>
</idPkg:Spread>"#;
    let buf = std::io::Cursor::new(Vec::new());
    let mut zip = ZipWriter::new(buf);
    let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    let deflated = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    zip.start_file("mimetype", stored).unwrap();
    zip.write_all(b"application/vnd.adobe.indesign-idml-package")
        .unwrap();
    zip.start_file("designmap.xml", deflated).unwrap();
    zip.write_all(
        br#"<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">
  <idPkg:Graphic src="Resources/Graphic.xml"/>
  <idPkg:Spread src="Spreads/Spread_sp1.xml"/>
</Document>"#,
    )
    .unwrap();
    zip.start_file("Resources/Graphic.xml", deflated).unwrap();
    zip.write_all(
        br#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Graphic xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">
  <Color Self="Color/Black" Model="Process" Space="CMYK" ColorValue="0 0 0 100" Name="Black"/>
</idPkg:Graphic>"#,
    )
    .unwrap();
    zip.start_file("Spreads/Spread_sp1.xml", deflated).unwrap();
    zip.write_all(spread.as_bytes()).unwrap();
    zip.finish().unwrap().into_inner()
}

fn red_half() -> SceneLayer {
    SceneLayer {
        items: vec![SceneItem::FillPath {
            path: vec![
                ScenePathSeg::MoveTo { x: 0.0, y: 0.0 },
                ScenePathSeg::LineTo { x: 50.0, y: 0.0 },
                ScenePathSeg::LineTo { x: 50.0, y: 100.0 },
                ScenePathSeg::LineTo { x: 0.0, y: 100.0 },
                ScenePathSeg::Close,
            ],
            paint: ScenePaint {
                r: 1.0,
                g: 0.0,
                b: 0.0,
                a: 1.0,
            },
        }],
    }
}

struct Exported {
    /// The fill operators the page's own content stream paints.
    page_fills: usize,
    /// The fill operators of each transparency-group form.
    group_fills: Vec<usize>,
    smask_images: usize,
    findings: Vec<String>,
}

fn fills(content: &[u8]) -> usize {
    String::from_utf8_lossy(content)
        .split_whitespace()
        .filter(|t| matches!(*t, "f" | "f*" | "F"))
        .count()
}

fn export(layer: bool, edit: impl FnOnce(&mut paged_model::Rectangle)) -> Exported {
    let mut document = idml_import::import_idml_doc(&idml()).expect("import");
    edit(&mut document.spreads[0].spread.rectangles[0]);
    let mut reg = HashMap::new();
    if layer {
        reg.insert("sq".to_string(), red_half());
    }
    let opts = PipelineOptions::default();
    let fonts = FontTable::build(&document, &opts);
    let doc = {
        let o = PipelineOptions {
            pre_built_font_table: Some(&fonts),
            scene_layers: Some(&reg),
            ..PipelineOptions::default()
        };
        pipeline::build_document(&document, &o).expect("build document")
    };
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
    let mut page_fills = 0;
    for (_, page_id) in parsed.get_pages() {
        page_fills += fills(&parsed.get_page_content(page_id));
    }
    let group_fills = parsed
        .objects
        .values()
        .filter_map(|o| o.as_stream().ok())
        .filter(|s| {
            s.dict
                .get(b"Group")
                .ok()
                .and_then(|g| g.as_dict().ok())
                .and_then(|g| g.get(b"S").ok())
                .and_then(|s| s.as_name().ok())
                == Some(b"Transparency".as_slice())
        })
        .map(|s| {
            fills(
                &s.decompressed_content()
                    .unwrap_or_else(|_| s.content.clone()),
            )
        })
        .collect();
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
        page_fills,
        group_fills,
        smask_images,
        findings: result.findings.iter().map(|f| f.code.to_string()).collect(),
    }
}

#[test]
#[allow(non_snake_case)]
fn a_faded_frame_exports_its_scene_layer_in_its_group__feat__effects_transparency_scene_layer_effects(
) {
    let fade = |r: &mut paged_model::Rectangle| r.opacity = Some(50.0);
    let plain = export(false, fade);
    let with = export(true, fade);
    assert_eq!(plain.page_fills, 0, "the box is in the group");
    assert_eq!(plain.group_fills, vec![1], "one group, the box");
    assert_eq!(
        with.page_fills, 0,
        "the scene layer is not painted over the group"
    );
    assert_eq!(
        with.group_fills,
        vec![2],
        "one group holds the box and the scene layer"
    );
}

#[test]
#[allow(non_snake_case)]
fn a_blurred_frame_rasterises_its_scene_layer_with_it__feat__effects_transparency_scene_layer_effects(
) {
    let blur = |r: &mut paged_model::Rectangle| {
        r.effect_slots_mut(EffectTarget::Object)
            .set_stack(vec![EffectEntry::new(Effect::GaussianBlur(
                GaussianBlurParams { radius_pt: 3.0 },
            ))])
            .expect("stack");
    };
    let with = export(true, blur);
    assert_eq!(with.smask_images, 1, "the blurred layer is one image");
    assert_eq!(
        with.page_fills + with.group_fills.iter().sum::<usize>(),
        0,
        "neither the box nor the scene layer stays vector"
    );
    assert!(
        with.findings.iter().any(|c| c == "effect_rasterized"),
        "{:?}",
        with.findings
    );
}
