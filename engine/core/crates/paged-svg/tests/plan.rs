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

//! Engine ADR 1031 — the import plan and the export, at the crate level:
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

/// Draw ADR 364 — a shape of several contours is ONE compound element,
/// its holes cut: the bug of the TypeScript reader this import replaced
/// (a compound split into one element per contour, holes painted).
#[test]
fn a_ring_is_one_compound_element_with_its_hole() {
    for (rule, even_odd) in [("evenodd", true), ("nonzero", false)] {
        let p = plan(&format!(
            r##"<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">
            <path fill-rule="{rule}" fill="#000" d="M0 0 H100 V100 H0 Z M25 25 V75 H75 V25 Z"/></svg>"##
        ));
        let ops = ops(&p);
        let inserts = ops
            .iter()
            .filter(|o| matches!(o, Mutation::InsertPath { .. }))
            .count();
        assert_eq!(inserts, 1, "{rule}: one element");
        let starts = ops.iter().find_map(|o| match o {
            Mutation::SetElementProperty {
                value: paged_mutate::Value::FramePath { subpath_starts, .. },
                ..
            } => Some(subpath_starts.clone()),
            _ => None,
        });
        assert_eq!(starts, Some(vec![0, 4]), "{rule}: both contours on it");
        let has_rule = ops.iter().any(|o| {
            matches!(
                o,
                Mutation::SetElementProperty {
                    path: paged_mutate::PropertyPath::FrameFillRule,
                    ..
                }
            )
        });
        assert_eq!(has_rule, even_odd, "{rule}");
        assert_eq!(p.report.items, 1);
    }
}

/// Draw ADR 364 — a named `<g>` (a layer) names the group it becomes.
#[test]
fn a_named_group_names_its_group() {
    let p = plan(
        r##"<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">
        <g id="Walls"><rect width="10" height="10"/><rect x="20" width="10" height="10"/></g>
        <g><rect y="20" width="10" height="10"/><rect x="20" y="20" width="10" height="10"/></g></svg>"##,
    );
    let names: Vec<String> = ops(&p)
        .iter()
        .filter_map(|o| match o {
            Mutation::SetElementProperty {
                path: paged_mutate::PropertyPath::ItemName,
                value: paged_mutate::Value::Text(t),
                ..
            } => Some(t.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(names, vec!["Walls".to_string()]);
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

// ------------------------------------------------------------- limits

/// A file over the byte limit is refused before it is parsed.
#[test]
fn an_oversize_file_is_refused_with_its_reason() {
    let pad = paged_svg::limits::MAX_SVG_BYTES;
    let svg = format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><!--{}--><rect width="5" height="5"/></svg>"#,
        " ".repeat(pad)
    );
    let p = plan(&svg);
    assert!(p.mutation.is_none());
    let e = p.error.expect("an error");
    assert!(e.contains("too large"), "{e}");
}

/// More paths than the node limit allows: refused, not planned.
#[test]
fn a_file_of_too_many_paths_is_refused() {
    let n = paged_svg::limits::MAX_SVG_NODES as usize + 1;
    let mut svg =
        String::from(r#"<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">"#);
    for i in 0..n {
        svg.push_str(&format!(r#"<path d="M{} 0h1v1z"/>"#, i % 10));
    }
    svg.push_str("</svg>");
    let p = plan(&svg);
    assert!(p.mutation.is_none());
    let e = p.error.expect("an error");
    assert!(e.contains("XML nodes"), "{e}");
}

fn nested(depth: usize) -> String {
    format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">{}<rect width="5" height="5"/>{}</svg>"#,
        "<g>".repeat(depth),
        "</g>".repeat(depth)
    )
}

/// Nesting far past the depth limit is refused without recursing into it.
#[test]
fn a_deeply_nested_file_is_refused() {
    let p = plan(&nested(100_000));
    assert!(p.mutation.is_none());
    let e = p.error.expect("an error");
    assert!(e.contains("nest"), "{e}");
}

/// The deepest file the limit admits imports on a 1 MiB stack, the wasm
/// worker's.
#[test]
fn the_deepest_admitted_file_imports_on_a_small_stack() {
    // The root `<svg>` and the rect are two of the levels.
    let depth = paged_svg::limits::MAX_SVG_DEPTH as usize - 2;
    let p = std::thread::Builder::new()
        .stack_size(1 << 20)
        .spawn(move || plan(&nested(depth)))
        .unwrap()
        .join()
        .expect("no stack overflow");
    assert!(p.error.is_none(), "{:?}", p.error);
    assert!(p.mutation.is_some());
    let p = plan(&nested(depth + 1));
    assert!(p.error.expect("an error").contains("nest"));
}
