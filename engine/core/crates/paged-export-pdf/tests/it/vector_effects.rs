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

//! Engine ADR 1042 — live vector effects in PDF: the export draws the
//! effected outline as vector paths (the same display list both
//! rasterizers draw), no raster and no finding.

use paged_export_pdf::{export_pdf, ExportInkSettings, ExportInput, ExportOptions, ExportProfiles};
use paged_model::effect_stack::{Effect, EffectEntry};
use paged_model::vector_effect::ZigZagParams;
use paged_renderer::pipeline::{self, FontTable, PipelineOptions};

/// The page content of the geometry sample, its first filled rectangle
/// carrying `stack`, and the export's findings.
fn export_with(stack: Vec<EffectEntry>) -> (String, usize) {
    let bytes =
        paged_gen::write_idml(&paged_gen::samples::geometry_groups::build()).expect("emit sample");
    let mut document = idml_import::import_idml_doc(&bytes).expect("import sample");
    let rect = document.spreads[0]
        .spread
        .rectangles
        .iter_mut()
        .find(|r| r.fill_color.is_some())
        .expect("a filled rectangle");
    rect.effect_stack = stack;
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
    (
        String::from_utf8_lossy(&out).into_owned(),
        result.findings.len(),
    )
}

fn segments(content: &str) -> usize {
    content
        .lines()
        .filter(|l| l.ends_with(" l") || l.ends_with(" c"))
        .count()
}

#[test]
#[allow(non_snake_case)]
fn a_zig_zag_is_exported_as_its_outline__feat__effects_transparency_live_vector_effects() {
    let (plain, plain_findings) = export_with(Vec::new());
    let (zig, zig_findings) = export_with(vec![EffectEntry::new(Effect::ZigZag(ZigZagParams {
        size: 6.0,
        ridges: 5,
        ..Default::default()
    }))]);
    // A rectangle's 4 edges become 4 × 6 zig zag edges.
    assert!(
        segments(&zig) >= segments(&plain) + 20,
        "{} vs {} path segments",
        segments(&zig),
        segments(&plain)
    );
    assert_eq!(
        zig_findings, plain_findings,
        "vector paths: nothing rasterised, nothing to report"
    );
}
