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

//! Engine ADR 1016 — the import plan and the export, at the crate level:
//! what the batch says for constructs the canvas suite does not draw,
//! and the export's own words for what SVG cannot say.

use paged_compose::{
    Color, DisplayCommand, DisplayList, GradientStop, Paint, PathData, PathSegment, SweepGradient,
    Transform,
};
use paged_svg::{
    export_display_list, plan_import, ExportInput, ImportTarget, SvgExportOptions, SvgImportOptions,
};
use paged_wire::{Mutation, PageId};

fn target() -> ImportTarget {
    ImportTarget {
        page_id: PageId("p".into()),
        page_origin: [0.0, 0.0],
        page_size: [612.0, 792.0],
    }
}

fn plan(svg: &str) -> paged_svg::SvgImportPlan {
    let o = SvgImportOptions {
        origin: Some([0.0, 0.0]),
        ..Default::default()
    };
    plan_import(svg.as_bytes(), &target(), &o, &[], &())
}

fn ops(p: &paged_svg::SvgImportPlan) -> &[Mutation] {
    match p.mutation.as_ref() {
        Some(Mutation::Batch { ops }) => ops,
        other => panic!("a batch, got {other:?}"),
    }
}

#[test]
fn a_compressed_file_imports_like_its_text() {
    use std::io::Write;
    let svg = r##"<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="5" height="5" fill="#123456"/></svg>"##;
    let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    gz.write_all(svg.as_bytes()).unwrap();
    let z = plan_import(
        &gz.finish().unwrap(),
        &target(),
        &SvgImportOptions::default(),
        &[],
        &(),
    );
    assert!(z.error.is_none());
    assert_eq!(z.report.items, plan(svg).report.items);
}

#[test]
fn a_mask_of_several_shapes_is_reported_and_left_out() {
    let p = plan(
        r##"<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">
        <mask id="m"><rect width="50" height="50" fill="#fff"/><rect x="60" width="20" height="50" fill="#fff"/></mask>
        <rect width="100" height="100" fill="#f00" mask="url(#m)"/></svg>"##,
    );
    assert!(p.report.get("mask.complex").is_some(), "{:?}", p.report);
    assert!(!ops(&p)
        .iter()
        .any(|o| matches!(o, Mutation::ApplyOpacityMask { .. })));
    assert_eq!(p.report.items, 1, "the masked rectangle alone");
}

#[test]
fn a_stroke_only_shape_with_open_contours_splits_into_a_group() {
    let p = plan(
        r##"<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">
        <path d="M0 0 L50 0 M0 10 L50 10" fill="none" stroke="#000"/></svg>"##,
    );
    let inserts: Vec<bool> = ops(&p)
        .iter()
        .filter_map(|o| match o {
            Mutation::InsertPath { open, .. } => Some(*open),
            _ => None,
        })
        .collect();
    assert_eq!(inserts, vec![true, true]);
    assert!(ops(&p)
        .iter()
        .any(|o| matches!(o, Mutation::CreateGroup { .. })));
    assert!(p.report.is_exact());
}

#[test]
fn every_created_item_is_bound_right_after_its_creating_child() {
    let p = plan(
        r##"<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">
        <g opacity="0.5"><rect width="10" height="10"/><circle cx="50" cy="50" r="5"/></g></svg>"##,
    );
    let ops = ops(&p);
    for (i, o) in ops.iter().enumerate() {
        if matches!(
            o,
            Mutation::InsertPath { .. } | Mutation::CreateGroup { .. }
        ) {
            assert!(
                matches!(ops.get(i + 1), Some(Mutation::BindCreated { .. })),
                "child {i} is not bound: {:?}",
                ops.get(i + 1)
            );
        }
    }
}

fn square() -> PathData {
    PathData::new(vec![
        PathSegment::MoveTo { x: 0.0, y: 0.0 },
        PathSegment::LineTo { x: 10.0, y: 0.0 },
        PathSegment::LineTo { x: 10.0, y: 10.0 },
        PathSegment::Close,
    ])
}

#[test]
fn a_conic_gradient_is_written_as_its_mean_colour_and_reported() {
    let mut list = DisplayList::new();
    let path_id = list.paths.push_anon(square());
    list.sweep_gradients.push(SweepGradient {
        center: (5.0, 5.0),
        start_angle: 0.0,
        stops: vec![
            GradientStop {
                offset: 0.0,
                color: Color::rgba(1.0, 0.0, 0.0, 1.0),
            },
            GradientStop {
                offset: 1.0,
                color: Color::rgba(0.0, 0.0, 1.0, 1.0),
            },
        ],
    });
    list.push(DisplayCommand::FillPath {
        path_id,
        paint: Paint::SweepGradient(paged_compose::GradientId(0)),
        transform: Transform([1.0, 0.0, 0.0, 1.0, 0.0, 0.0]),
    });
    let input = ExportInput {
        list: &list,
        width: 20.0,
        height: 20.0,
        fonts: &(),
        fit_to_content: false,
    };
    let (svg, report) = export_display_list(&input, &SvgExportOptions::default());
    assert!(report.get("gradient.conic").is_some());
    assert!(svg.contains("<path d=\"M0 0L10 0L10 10Z\""), "{svg}");
    let (min, _) = export_display_list(
        &input,
        &SvgExportOptions {
            minify: Some(true),
            ..Default::default()
        },
    );
    assert!(!min.trim_end().contains('\n'));
}
