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

//! Engine ADR 1008 — the effect stack in PDF. InDesign's effects export
//! as they always did; a blur, noise or colour adjustment has no PDF
//! operator, so its layer is drawn by the CPU rasterizer at the export's
//! effect resolution and placed as one image (with an alpha `/SMask`)
//! under the layer's blend mode, and the preflight says so. An outline
//! stroke stays vector.

use paged_export_pdf::{export_pdf, ExportInkSettings, ExportInput, ExportOptions, ExportProfiles};
use paged_model::effect_stack::EffectBearing;
use paged_model::effect_stack::{
    Effect, EffectEntry, EffectTarget, GaussianBlurParams, OutlineStrokeParams,
};
use paged_renderer::pipeline::{self, FontTable, PipelineOptions};

struct Exported {
    content: String,
    findings: Vec<String>,
    smask_images: usize,
}

fn export_with(stack: Vec<EffectEntry>) -> Exported {
    let bytes =
        paged_gen::write_idml(&paged_gen::samples::geometry_groups::build()).expect("emit sample");
    let mut document = idml_import::import_idml_doc(&bytes).expect("import sample");
    let rect = document.spreads[0]
        .spread
        .rectangles
        .iter_mut()
        .find(|r| r.fill_color.is_some())
        .expect("a filled rectangle");
    rect.effect_slots_mut(EffectTarget::Object)
        .set_stack(stack)
        .expect("stack");
    let opts = PipelineOptions::default();
    let fonts = FontTable::build(&document, &opts);
    let doc = {
        let o = PipelineOptions {
            pre_built_font_table: Some(&fonts),
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
fn a_blur_is_rasterised_into_its_group_and_reported__feat__effects_transparency_effect_stack() {
    let plain = export_with(Vec::new());
    assert_eq!(plain.smask_images, 0);
    assert!(!plain.findings.iter().any(|c| c == "effect_rasterized"));

    let blurred = export_with(vec![EffectEntry::new(Effect::GaussianBlur(
        GaussianBlurParams { radius_pt: 3.0 },
    ))]);
    assert_eq!(blurred.smask_images, 1, "the blurred layer is one image");
    assert!(
        blurred.content.contains("/Xl0 Do"),
        "the layer image is placed"
    );
    assert!(
        blurred.findings.iter().any(|c| c == "effect_rasterized"),
        "{:?}",
        blurred.findings
    );
}

#[test]
#[allow(non_snake_case)]
fn an_outline_stroke_stays_vector__feat__effects_transparency_effect_stack() {
    let stroked = export_with(vec![EffectEntry::new(Effect::OutlineStroke(
        OutlineStrokeParams::default(),
    ))]);
    assert_eq!(stroked.smask_images, 0);
    assert!(
        stroked.content.split_whitespace().any(|t| t == "S"),
        "the band is a stroked path"
    );
    assert!(!stroked.findings.iter().any(|c| c == "effect_rasterized"));
}
