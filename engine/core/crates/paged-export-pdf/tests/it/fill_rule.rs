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

//! Engine ADR 1006 — an even-odd outline exports as `f*` and clips as
//! `W* n`; a non-zero one keeps `f` and `W n`.

use paged_compose::{DisplayCommand, FillRule, Paint, PathData, PathSegment, Transform};
use paged_export_pdf::{export_pdf, ExportInkSettings, ExportInput, ExportOptions, ExportProfiles};
use paged_renderer::pipeline::{self, FontTable, PipelineOptions};

/// The geometry sample's compound polygon (two contours) with `rule`,
/// exported; and every content stream of the result.
fn export_compound(rule: paged_model::FillRule, extra_clip: bool) -> String {
    let bytes =
        paged_gen::write_idml(&paged_gen::samples::geometry_groups::build()).expect("emit sample");
    let mut document = idml_import::import_idml_doc(&bytes).expect("import sample");
    let mut compound = 0;
    for parsed in &mut document.spreads {
        for p in &mut parsed.spread.polygons {
            if p.subpath_starts.len() > 1 {
                p.fill_rule = rule;
                compound += 1;
            }
        }
    }
    assert!(compound > 0, "the sample has a compound polygon");
    let opts = PipelineOptions::default();
    let fonts = FontTable::build(&document, &opts);
    let mut doc = {
        let o = PipelineOptions {
            pre_built_font_table: Some(&fonts),
            ..PipelineOptions::default()
        };
        pipeline::build_document(&document, &o).expect("build document")
    };
    if extra_clip {
        // A clip by the list's own even-odd path, as a placed SVG's or
        // PDF's `W*` reaches the exporter.
        let list = &mut doc.pages[0].list;
        let square = |x: f32, s: f32| {
            vec![
                PathSegment::MoveTo { x, y: x },
                PathSegment::LineTo { x: x + s, y: x },
                PathSegment::LineTo { x: x + s, y: x + s },
                PathSegment::LineTo { x, y: x + s },
                PathSegment::Close,
            ]
        };
        let mut segments = square(10.0, 40.0);
        segments.extend(square(20.0, 20.0));
        let clip = list
            .paths
            .push_anon(PathData::new(segments).with_fill_rule(FillRule::EvenOdd));
        let unit = list.paths.push_anon(PathData::new(square(0.0, 1.0)));
        list.push(DisplayCommand::PushClip {
            path_id: clip,
            transform: Transform::IDENTITY,
        });
        list.push(DisplayCommand::FillPath {
            path_id: unit,
            paint: Paint::Solid(paged_compose::Color::rgba(0.0, 0.0, 0.0, 1.0)),
            transform: Transform([60.0, 0.0, 0.0, 60.0, 0.0, 0.0]),
        });
        list.push(DisplayCommand::PopClip(Transform::IDENTITY));
    }
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
    let parsed = lopdf::Document::load_mem(&pdf).expect("re-parse");
    let mut out = Vec::new();
    for (_, page_id) in parsed.get_pages() {
        out.extend(parsed.get_page_content(page_id));
        out.push(b'\n');
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn has_op(content: &str, op: &str) -> bool {
    content.split_whitespace().any(|t| t == op)
}

#[test]
#[allow(non_snake_case)]
fn an_even_odd_fill_exports_as_f_star__feat__frames_paths_fill_rule_even_odd() {
    let even_odd = export_compound(paged_model::FillRule::EvenOdd, false);
    assert!(has_op(&even_odd, "f*"), "an even-odd fill is `f*`");
    let non_zero = export_compound(paged_model::FillRule::NonZero, false);
    assert!(
        !has_op(&non_zero, "f*"),
        "a non-zero document writes no `f*`"
    );
    assert!(has_op(&non_zero, "f"));
}

#[test]
#[allow(non_snake_case)]
fn an_even_odd_clip_exports_as_w_star__feat__frames_paths_fill_rule_even_odd() {
    let content = export_compound(paged_model::FillRule::NonZero, true);
    let tokens: Vec<&str> = content.split_whitespace().collect();
    assert!(
        tokens.windows(2).any(|w| w == ["W*", "n"]),
        "an even-odd clip is `W* n`"
    );
}
