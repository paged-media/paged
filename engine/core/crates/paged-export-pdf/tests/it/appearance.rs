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

//! Engine ADR 1043 — an appearance in PDF. Each layer is its own paint
//! operator, in the layer order; a layer with a blend mode or an opacity
//! is a transparency group of its own (an ExtGState with its `/BM` and
//! `/ca`); a layer's blur is rasterised into the layer, as an object's
//! is (engine ADR 1008).

use paged_export_pdf::{export_pdf, ExportInkSettings, ExportInput, ExportOptions, ExportProfiles};
use paged_model::appearance::PaintLayer;
use paged_model::effect_stack::{Effect, EffectEntry, GaussianBlurParams};
use paged_renderer::pipeline::{self, FontTable, PipelineOptions};

struct Exported {
    content: String,
    ext_g_states: Vec<String>,
    findings: Vec<String>,
    smask_images: usize,
}

fn export_with(layers: Vec<PaintLayer>) -> Exported {
    let bytes =
        paged_gen::write_idml(&paged_gen::samples::geometry_groups::build()).expect("emit sample");
    let mut document = idml_import::import_idml_doc(&bytes).expect("import sample");
    let rect = document.spreads[0]
        .spread
        .rectangles
        .iter_mut()
        .find(|r| r.fill_color.is_some())
        .expect("a filled rectangle");
    rect.stroke_color = Some("Color/Black".into());
    rect.stroke_weight = Some(1.0);
    rect.appearance = layers;
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
    // A transparency group is a form XObject with a stream of its own.
    for o in parsed.objects.values() {
        if let Ok(st) = o.as_stream() {
            if st.dict.get(b"Subtype").and_then(|v| v.as_name()).ok() == Some(b"Form".as_slice()) {
                let mut st = st.clone();
                let _ = st.decompress();
                out.extend_from_slice(&st.content);
                out.push(b'\n');
            }
        }
    }
    let ext_g_states = parsed
        .objects
        .values()
        .filter_map(|o| o.as_dict().ok())
        .filter(|d| {
            d.get(b"Type").and_then(|v| v.as_name()).ok() == Some(b"ExtGState".as_slice())
                || d.get(b"BM").is_ok()
        })
        .map(|d| format!("{d:?}"))
        .collect();
    Exported {
        ext_g_states,
        content: String::from_utf8_lossy(&out).into_owned(),
        findings: result.findings.iter().map(|f| f.code.to_string()).collect(),
        smask_images,
    }
}

fn ops(content: &str, op: &str) -> usize {
    content.split_whitespace().filter(|t| *t == op).count()
}

fn multiply_red() -> PaintLayer {
    let mut red = PaintLayer::fill("Color/Red");
    red.blend_mode = Some("Multiply".into());
    red.opacity = Some(50.0);
    red
}

#[test]
#[allow(non_snake_case)]
fn each_layer_is_its_own_paint_operator__feat__frames_paths_native_appearance() {
    let plain = export_with(Vec::new());
    let layered = export_with(vec![
        PaintLayer::frame_fill(),
        multiply_red(),
        PaintLayer::frame_stroke(),
        PaintLayer::stroke("Color/Black", 6.0),
    ]);
    let fills = |c: &str| ops(c, "f") + ops(c, "f*");
    assert_eq!(
        fills(&layered.content),
        fills(&plain.content) + 1,
        "one more fill"
    );
    assert_eq!(
        ops(&layered.content, "S"),
        ops(&plain.content, "S") + 1,
        "one more stroke"
    );
    assert!(
        layered
            .ext_g_states
            .iter()
            .any(|g| g.contains("Multiply") && g.contains("0.5")),
        "the red layer composites Multiply at 50 %: {:?}",
        layered.ext_g_states
    );
    assert!(
        !plain.ext_g_states.iter().any(|g| g.contains("Multiply")),
        "{:?}",
        plain.ext_g_states
    );
    assert_eq!(layered.smask_images, 0, "every layer stays vector");
}

#[test]
#[allow(non_snake_case)]
fn a_layers_blur_is_rasterised_into_that_layer__feat__frames_paths_native_appearance() {
    let mut blurred = PaintLayer::fill("Color/Red");
    blurred
        .effects
        .push(EffectEntry::new(Effect::GaussianBlur(GaussianBlurParams {
            radius_pt: 3.0,
        })));
    let out = export_with(vec![blurred]);
    assert_eq!(out.smask_images, 1, "the blurred layer is one image");
    assert!(
        out.findings.iter().any(|c| c == "effect_rasterized"),
        "{:?}",
        out.findings
    );
}
