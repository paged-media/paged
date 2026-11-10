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

//! Engine ADR 1094 — a page side over PDF's 14,400-unit limit is written in
//! a larger `/UserUnit`. The `gradients` gen sample (generated in-process) is
//! built, its page widened to 787 cm (a fence banner), and exported with
//! bleed and crop marks: the page must carry `/UserUnit 2`, boxes within the
//! limit that still measure 787 cm in user units, and content scaled by ½ —
//! including the gradients' shading patterns, whose matrix maps to the
//! page's default space.

use paged_export_pdf::{
    export_pdf, BleedOptions, ExportInkSettings, ExportInput, ExportOptions, ExportProfiles,
    MarkOptions, PdfStandard,
};
use paged_renderer::pipeline::{self, FontTable, PipelineOptions};

const CM: f32 = 72.0 / 2.54;

fn fallback_font() -> Vec<u8> {
    let manifest = env!("CARGO_MANIFEST_DIR");
    let path = std::path::Path::new(manifest).join("../../corpus/fonts/Inter.ttf");
    std::fs::read(path).expect("Inter.ttf fixture")
}

fn export_wide(width_pt: f32) -> Vec<u8> {
    let sample = paged_gen::samples::gradients::build();
    let bytes = paged_gen::write_idml(&sample).unwrap();
    let document = idml_import::import_idml_doc(&bytes).unwrap();
    let font = fallback_font();
    let mut opts = PipelineOptions {
        font: Some(&font),
        ..Default::default()
    };
    let fonts = FontTable::build(&document, &opts);
    opts.pre_built_font_table = Some(&fonts);
    let mut doc = pipeline::build_document(&document, &opts).unwrap();
    doc.pages.truncate(1);
    doc.pages[0].width_pt = width_pt;
    let palette = document.palette.clone();
    let cmm = paged_color::IccCmm::new(None, paged_color::DisplaySetup::default());
    let input = ExportInput {
        doc: &doc,
        palette: &palette,
        fonts: Some(&fonts),
        cmm: &cmm,
        profiles: ExportProfiles {
            cmyk_working: None,
            output_intent: None,
            srgb: None,
        },
        inks: ExportInkSettings::default(),
        options: ExportOptions {
            standard: PdfStandard::Pdf17,
            bleed: BleedOptions {
                override_pt: Some([3.0 * CM; 4]),
            },
            marks: MarkOptions {
                crop_marks: true,
                ..Default::default()
            },
            ..Default::default()
        },
        doc_bleed: [0.0; 4],
        doc_slug: [0.0; 4],
    };
    export_pdf(input).expect("export").bytes
}

fn rect(page: &lopdf::Dictionary, key: &[u8]) -> [f32; 4] {
    let a = page.get(key).unwrap().as_array().unwrap();
    let n: Vec<f32> = a.iter().map(|o| o.as_float().unwrap()).collect();
    [n[0], n[1], n[2], n[3]]
}

#[test]
fn an_oversized_page_is_written_in_a_larger_user_unit() {
    let bytes = export_wide(787.0 * CM);
    let doc = lopdf::Document::load_mem(&bytes).unwrap();
    let (_, page_id) = doc.get_pages().into_iter().next().unwrap();
    let page = doc.get_dictionary(page_id).unwrap();

    let unit = page.get(b"UserUnit").unwrap().as_float().unwrap();
    assert_eq!(unit, 2.0);

    let media = rect(page, b"MediaBox");
    assert!(media[2] <= 14_400.0 && media[3] <= 14_400.0, "{media:?}");
    let trim = rect(page, b"TrimBox");
    let trim_w_cm = (trim[2] - trim[0]) * unit / CM;
    assert!(
        (trim_w_cm - 787.0).abs() < 0.01,
        "trim width {trim_w_cm} cm"
    );
    let bleed = rect(page, b"BleedBox");
    let bleed_cm = (trim[0] - bleed[0]) * unit / CM;
    assert!((bleed_cm - 3.0).abs() < 0.01, "bleed {bleed_cm} cm");

    // The content and the marks are drawn at half scale.
    let content = doc.get_page_content(page_id);
    let ops = lopdf::content::Content::decode(&content)
        .unwrap()
        .operations;
    let cms: Vec<Vec<f32>> = ops
        .iter()
        .filter(|op| op.operator == "cm")
        .map(|op| op.operands.iter().map(|o| o.as_float().unwrap()).collect())
        .collect();
    assert_eq!(
        &cms[0][..4],
        &[0.5, 0.0, 0.0, -0.5],
        "page CTM {:?}",
        cms[0]
    );
    assert!(
        cms.iter().any(|m| m[..4] == [0.5, 0.0, 0.0, 0.5]),
        "marks are scaled into the unit"
    );

    // Every shading pattern's matrix carries the same scale.
    for obj in doc.objects.values() {
        let Ok(d) = obj.as_dict() else { continue };
        if d.get(b"PatternType").and_then(|t| t.as_i64()).ok() == Some(2) {
            let m: Vec<f32> = d
                .get(b"Matrix")
                .unwrap()
                .as_array()
                .unwrap()
                .iter()
                .map(|o| o.as_float().unwrap())
                .collect();
            assert_eq!(m[0].abs(), 0.5, "pattern matrix {m:?}");
        }
    }
}

#[test]
fn a_page_within_the_limit_has_no_user_unit() {
    let bytes = export_wide(480.0 * CM);
    let doc = lopdf::Document::load_mem(&bytes).unwrap();
    let (_, page_id) = doc.get_pages().into_iter().next().unwrap();
    let page = doc.get_dictionary(page_id).unwrap();
    assert!(page.get(b"UserUnit").is_err());
}
