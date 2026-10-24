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

//! Engine ADR 1016 — PDF names the sixteen blend modes and none of
//! Photoshop's eleven: a group in one of those is drawn as the CPU
//! lane's composite of it over its backdrop (an image XObject with an
//! `/SMask`) and reported as a preflight finding; a native mode stays a
//! live `/BM`.

use paged_export_pdf::{export_pdf, ExportInkSettings, ExportInput, ExportOptions, ExportProfiles};
use paged_renderer::pipeline::{self, FontTable, PipelineOptions};

/// The transparency sample with every rectangle's blend set to `mode`:
/// the PDF bytes and the findings' codes.
fn export_with(mode: &str) -> (Vec<u8>, Vec<&'static str>) {
    let bytes =
        paged_gen::write_idml(&paged_gen::samples::transparency::build()).expect("emit sample");
    let mut document = idml_import::import_idml_doc(&bytes).expect("import sample");
    let mut set = 0;
    for parsed in &mut document.spreads {
        for r in &mut parsed.spread.rectangles {
            r.blend_mode = Some(mode.to_string());
            set += 1;
        }
    }
    assert!(set > 0, "the sample has rectangles");
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
    let codes = result.findings.iter().map(|f| f.code).collect();
    (result.bytes, codes)
}

fn contains(hay: &[u8], needle: &[u8]) -> bool {
    hay.windows(needle.len()).any(|w| w == needle)
}

#[test]
#[allow(non_snake_case)]
fn a_photoshop_mode_rasterises_its_group_and_reports__feat__effects_transparency_blend_modes_27() {
    let (pdf, codes) = export_with("LinearBurn");
    assert!(codes.contains(&"blend_mode_rasterized"), "{codes:?}");
    assert!(!contains(&pdf, b"/LinearBurn"), "PDF has no such /BM");
    let parsed = lopdf::Document::load_mem(&pdf).expect("re-parse");
    let mut content = Vec::new();
    for (_, page_id) in parsed.get_pages() {
        content.extend(parsed.get_page_content(page_id));
    }
    let content = String::from_utf8_lossy(&content);
    assert!(content.contains("/Xb"), "the bake is drawn: {content}");
    assert!(contains(&pdf, b"/SMask"), "with its alpha as a soft mask");

    // The control: a native mode stays live and is no finding.
    let (pdf, codes) = export_with("Multiply");
    assert!(!codes.contains(&"blend_mode_rasterized"), "{codes:?}");
    assert!(contains(&pdf, b"/Multiply"));
}
