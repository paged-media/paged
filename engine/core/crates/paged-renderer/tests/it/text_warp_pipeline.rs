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

//! Engine ADR 1091 — a text frame's WordArt warp bends its laid-out text:
//! the glyphs become paths in page space whose ink fills the warp's shape in
//! the frame's text area. Set on the `blank-paragraphs` fixture's first
//! frame ("A", "B" in Inter 10/12).

use paged_compose::{DisplayCommand, PathSegment, Transform};
use paged_gen::samples::blank_paragraphs::story_id;
use paged_model::text_warp::TextWarp;
use paged_renderer::{pipeline, PipelineOptions};

fn inter_font() -> Vec<u8> {
    let p =
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../corpus/fonts/Inter.ttf");
    std::fs::read(&p).unwrap_or_else(|e| panic!("read Inter.ttf: {e}"))
}

fn document(warp: Option<&str>) -> paged_scene::Document {
    turned_document(warp, 0.0)
}

/// The fixture with its first frame turned `deg` degrees clockwise about
/// its centre.
fn turned_document(warp: Option<&str>, deg: f32) -> paged_scene::Document {
    let bytes =
        paged_gen::write_idml(&paged_gen::samples::blank_paragraphs::build()).expect("idml");
    let mut doc = idml_import::import_idml_doc(&bytes).expect("import");
    let story = story_id(0);
    for s in &mut doc.spreads {
        for f in &mut s.spread.text_frames {
            if f.parent_story.as_deref() == Some(story.as_str()) {
                f.text_warp = warp.map(|p| TextWarp {
                    preset: p.into(),
                    adjusts: Vec::new(),
                });
                if deg != 0.0 {
                    let m = f.item_transform.unwrap_or([1.0, 0.0, 0.0, 1.0, 0.0, 0.0]);
                    let (cx, cy) = centre(f);
                    let (sn, cs) = deg.to_radians().sin_cos();
                    let r = [
                        cs,
                        sn,
                        -sn,
                        cs,
                        cx - cs * cx + sn * cy,
                        cy - sn * cx - cs * cy,
                    ];
                    f.item_transform = Some([
                        r[0] * m[0] + r[2] * m[1],
                        r[1] * m[0] + r[3] * m[1],
                        r[0] * m[2] + r[2] * m[3],
                        r[1] * m[2] + r[3] * m[3],
                        r[0] * m[4] + r[2] * m[5] + r[4],
                        r[1] * m[4] + r[3] * m[5] + r[5],
                    ]);
                }
            }
        }
    }
    doc
}

fn build(doc: &paged_scene::Document) -> pipeline::BuiltDocument {
    let font = inter_font();
    let opts = PipelineOptions {
        font: Some(&font),
        ..PipelineOptions::default()
    };
    pipeline::build_document(doc, &opts).expect("build")
}

/// The page's untransformed fill paths.
fn plain_paths(built: &pipeline::BuiltDocument) -> Vec<Vec<PathSegment>> {
    let list = &built.pages[0].list;
    let identity = Transform([1.0, 0.0, 0.0, 1.0, 0.0, 0.0]);
    list.commands
        .iter()
        .filter_map(|c| match c {
            DisplayCommand::FillPath {
                path_id, transform, ..
            } if *transform == identity => list.paths.get(*path_id).map(|p| p.segments.clone()),
            _ => None,
        })
        .collect()
}

/// The extent of the page's untransformed fill paths that the unbent build
/// does not draw (the bent glyphs).
fn bent_extent(built: &pipeline::BuiltDocument) -> Option<(f32, f32, f32, f32)> {
    let before = plain_paths(&build(&document(None)));
    let (mut x0, mut y0, mut x1, mut y1) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
    let mut any = false;
    for segments in plain_paths(built) {
        if before.contains(&segments) {
            continue;
        }
        for s in &segments {
            if let PathSegment::MoveTo { x, y } | PathSegment::LineTo { x, y } = *s {
                any = true;
                x0 = x0.min(x);
                y0 = y0.min(y);
                x1 = x1.max(x);
                y1 = y1.max(y);
            }
        }
    }
    any.then_some((x0, y0, x1, y1))
}

/// A frame's centre, spread pt.
fn centre(f: &paged_model::TextFrame) -> (f32, f32) {
    let (x, y) = (
        (f.bounds.left + f.bounds.right) / 2.0,
        (f.bounds.top + f.bounds.bottom) / 2.0,
    );
    match f.item_transform {
        Some(m) => (m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]),
        None => (x, y),
    }
}

/// The first frame's text area, page pt: its box less its insets.
fn text_area(doc: &paged_scene::Document) -> (f32, f32, f32, f32) {
    let story = story_id(0);
    let f = doc
        .spreads
        .iter()
        .flat_map(|s| &s.spread.text_frames)
        .find(|f| f.parent_story.as_deref() == Some(story.as_str()))
        .expect("frame");
    let i = f.inset_spacing.unwrap_or([0.0; 4]);
    let (x, y) = match f.item_transform {
        Some(m) => (
            m[0] * f.bounds.left + m[2] * f.bounds.top + m[4],
            m[1] * f.bounds.left + m[3] * f.bounds.top + m[5],
        ),
        None => (f.bounds.left, f.bounds.top),
    };
    (
        x + i[1],
        y + i[0],
        x + f.bounds.width() - i[3],
        y + f.bounds.height() - i[2],
    )
}

#[test]
fn the_plain_warp_stretches_the_text_onto_its_area() {
    let doc = document(Some("textPlain"));
    let built = build(&doc);
    let (x0, y0, x1, y1) = bent_extent(&built).expect("bent glyphs");
    // The page's origin is the spread's for this one-page fixture.
    let origin = built.pages[0].spread_origin;
    let (ax0, ay0, ax1, ay1) = text_area(&doc);
    let tol = 0.05;
    assert!((x0 - (ax0 - origin.0)).abs() < tol, "left {x0} vs {ax0}");
    assert!((y0 - (ay0 - origin.1)).abs() < tol, "top {y0} vs {ay0}");
    assert!((x1 - (ax1 - origin.0)).abs() < tol, "right {x1} vs {ax1}");
    assert!((y1 - (ay1 - origin.1)).abs() < tol, "bottom {y1} vs {ay1}");
}

/// Every point of the bent glyphs.
fn bent_points(built: &pipeline::BuiltDocument) -> Vec<(f32, f32)> {
    bent_points_turned(built, 0.0)
}

/// [`bent_points`] of a frame turned `deg` degrees.
fn bent_points_turned(built: &pipeline::BuiltDocument, deg: f32) -> Vec<(f32, f32)> {
    let before = plain_paths(&build(&turned_document(None, deg)));
    plain_paths(built)
        .into_iter()
        .filter(|p| !before.contains(p))
        .flatten()
        .filter_map(|s| match s {
            PathSegment::MoveTo { x, y } | PathSegment::LineTo { x, y } => Some((x, y)),
            _ => None,
        })
        .collect()
}

#[test]
fn an_arch_bends_the_text_inside_the_areas_ellipse() {
    let doc = document(Some("textArchUp"));
    let built = build(&doc);
    let pts = bent_points(&built);
    assert!(!pts.is_empty(), "bent glyphs");
    let origin = built.pages[0].spread_origin;
    let (ax0, ay0, ax1, ay1) = text_area(&doc);
    let (cx, cy) = ((ax0 + ax1) / 2.0 - origin.0, (ay0 + ay1) / 2.0 - origin.1);
    let (rx, ry) = ((ax1 - ax0) / 2.0, (ay1 - ay0) / 2.0);
    // The arch's guides are arcs of the ellipse inscribed in the area and
    // of one inside it, on the same rays: the text stays inside it, and
    // above its centre (an arch up of 180 degrees).
    for &(x, y) in &pts {
        let d = ((x - cx) / rx).powi(2) + ((y - cy) / ry).powi(2);
        assert!(d <= 1.001, "({x}, {y}) is outside the ellipse: {d}");
        assert!(y <= cy + 0.01, "({x}, {y}) is below the centre {cy}");
    }
    // It spans most of the ellipse's width.
    let (x0, x1) = pts
        .iter()
        .fold((f32::MAX, f32::MIN), |(a, b), p| (a.min(p.0), b.max(p.0)));
    assert!(x1 - x0 > rx, "{x0}..{x1}");
}

/// Engine ADR 1091, amendment 2 — a turned frame's warp turns with it: the
/// arch of a frame turned a quarter clockwise, turned back about the frame's
/// centre, is the upright frame's arch.
#[test]
fn a_turned_frames_arch_turns_with_the_frame() {
    let upright = turned_document(Some("textArchUp"), 0.0);
    let turned = turned_document(Some("textArchUp"), 90.0);
    let built = build(&turned);
    let pts = bent_points_turned(&built, 90.0);
    assert!(!pts.is_empty(), "bent glyphs");
    let origin = built.pages[0].spread_origin;
    let story = story_id(0);
    let frame = turned
        .spreads
        .iter()
        .flat_map(|s| &s.spread.text_frames)
        .find(|f| f.parent_story.as_deref() == Some(story.as_str()))
        .expect("frame");
    let (fx, fy) = centre(frame);
    let (fx, fy) = (fx - origin.0, fy - origin.1);
    let (ax0, ay0, ax1, ay1) = text_area(&upright);
    let (cx, cy) = ((ax0 + ax1) / 2.0 - origin.0, (ay0 + ay1) / 2.0 - origin.1);
    let (rx, ry) = ((ax1 - ax0) / 2.0, (ay1 - ay0) / 2.0);
    let mut x_span = (f32::MAX, f32::MIN);
    for &(x, y) in &pts {
        // A quarter back (anticlockwise) about the frame's centre.
        let (dx, dy) = (x - fx, y - fy);
        let (ux, uy) = (fx + dy, fy - dx);
        let d = ((ux - cx) / rx).powi(2) + ((uy - cy) / ry).powi(2);
        assert!(d <= 1.002, "({ux}, {uy}) is outside the ellipse: {d}");
        assert!(uy <= cy + 0.02, "({ux}, {uy}) is below the centre {cy}");
        x_span = (x_span.0.min(ux), x_span.1.max(ux));
    }
    assert!(x_span.1 - x_span.0 > rx, "{x_span:?}");
}
