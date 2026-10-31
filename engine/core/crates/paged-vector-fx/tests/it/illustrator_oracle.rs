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

//! The Illustrator oracle (engine ADR 1042): `tests/fixtures/
//! vector-effects.illustrator.json`, recorded from Illustrator 30.1 by
//! draw's `scripts/illustrator/probes/vector-effects.jsx` (its
//! provenance is in the fixture). Every case runs the same effect with
//! the same parameters on the same input here and compares:
//!
//! | effect | compared | tolerance |
//! | --- | --- | --- |
//! | Zig Zag (corner, smooth) | every anchor and handle | 0.01 pt (one handle: below) |
//! | Pucker & Bloat | every anchor and handle | 0.001 pt |
//! | Round Corners | every anchor and handle | 0.001 pt |
//! | Offset Path | area, bounds | 0.1 %, 0.05 pt |
//! | Transform (copies) | every copy's area and bounds | 0.01 pt², 0.01 pt |
//! | Twist | bounds, area, the fixed corners | 1.5 pt, 1.5 %, exact |
//! | Roughen, Tweak | statistics (seeded here, Illustrator's own random) | below |
//!
//! Recorded conventions (each asserted with both numbers):
//!
//! - Zig Zag smooth: the closing anchor's OUTGOING handle. Illustrator
//!   derives it from its in-place pass, 11.21 pt long; ours is half the
//!   distance to the neighbour it reads (10.15 pt). The anchor and its
//!   direction agree.
//! - Twist: Illustrator rounds the expanded twist to whole points and
//!   cuts the edges at its own places (9 anchors on the rectangle at
//!   45°); ours cuts until the curve is within 0.1 pt. Bounds and area
//!   agree to the stated tolerance, and every corner at the farthest
//!   distance stays put in both.
//! - Roughen: the piece count is Illustrator's exactly (44 on the
//!   rectangle at 10 per inch, 68 on the circle at 20), and no point
//!   moves more than size / 2 off the outline in either; the mean move
//!   is within 25 % of each other (1.25 pt expected for a uniform ±2.5).
//!   The sequences differ: Illustrator draws its own random numbers and
//!   its two recordings of one case differ from each other.
//! - Tweak: every anchor and handle within the amounts in both.
//!
//! Not recorded: Warp (Illustrator's `Adobe Deform` changed nothing
//! through `applyEffect` with any dictionary tried), Free Distort (its
//! corner dictionary's frame was not settled by the first recording),
//! Scribble, Convert to Shape (no oracle case yet). ADR 1042 says so.

use kurbo::Point;
use paged_model::effect_stack::Effect;
use paged_model::vector_effect::*;
use paged_vector_fx::{apply_effect, Context, PaintRole, Shape};
use serde_json::Value;

fn fixture() -> Value {
    let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/vector-effects.illustrator.json");
    serde_json::from_str(&std::fs::read_to_string(p).expect("the fixture")).expect("json")
}

fn pt(v: &Value) -> Point {
    Point::new(v[0].as_f64().unwrap(), v[1].as_f64().unwrap())
}

fn shape_of(paths: &Value) -> Shape {
    let mut contours = Vec::new();
    for p in paths.as_array().unwrap() {
        contours.push(paged_vector_fx::Contour {
            nodes: p["anchors"]
                .as_array()
                .unwrap()
                .iter()
                .map(|a| paged_vector_fx::Node {
                    p: pt(&a["anchor"]),
                    l: pt(&a["left"]),
                    r: pt(&a["right"]),
                })
                .collect(),
            closed: p["closed"].as_bool().unwrap(),
        });
    }
    Shape { contours }
}

fn case<'a>(f: &'a Value, id: &str) -> &'a Value {
    f["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["id"] == id)
        .unwrap_or_else(|| panic!("no case {id}"))
}

fn run(c: &Value, effect: Effect) -> (Shape, Shape) {
    let input = shape_of(&c["input"]["paths"]);
    let ours = apply_effect(&input, &effect, &Context::default(), &mut PaintRole::Keep);
    (ours, shape_of(&c["measured"]["paths"]))
}

fn num(c: &Value, k: &str) -> f32 {
    c["parameters"][k].as_f64().unwrap() as f32
}

fn assert_nodes(ours: &Shape, theirs: &Shape, tol: f64, skip_last_r: bool, id: &str) {
    assert_eq!(ours.contours.len(), theirs.contours.len(), "{id}: contours");
    for (a, b) in ours.contours.iter().zip(&theirs.contours) {
        assert_eq!(a.nodes.len(), b.nodes.len(), "{id}: anchors");
        let n = a.nodes.len();
        for (i, (x, y)) in a.nodes.iter().zip(&b.nodes).enumerate() {
            assert!(
                (x.p - y.p).hypot() < tol,
                "{id} #{i} anchor {:?} vs {:?}",
                x.p,
                y.p
            );
            assert!(
                (x.l - y.l).hypot() < tol,
                "{id} #{i} left {:?} vs {:?}",
                x.l,
                y.l
            );
            if !(skip_last_r && i + 1 == n) {
                assert!(
                    (x.r - y.r).hypot() < tol,
                    "{id} #{i} right {:?} vs {:?}",
                    x.r,
                    y.r
                );
            }
        }
    }
}

fn area(s: &Shape) -> f64 {
    super::area(s).abs()
}

#[test]
#[allow(non_snake_case)]
fn zig_zag_matches_illustrator__feat__effects_transparency_live_vector_effects() {
    let f = fixture();
    for (id, smooth) in [
        ("zigzag-rect-corner", false),
        ("zigzag-rect-smooth", true),
        ("zigzag-tri-corner", false),
    ] {
        let c = case(&f, id);
        let (ours, theirs) = run(
            c,
            Effect::ZigZag(ZigZagParams {
                size: num(c, "size"),
                ridges: num(c, "ridges") as u32,
                smooth,
                relative: false,
            }),
        );
        assert_nodes(&ours, &theirs, 0.01, smooth, id);
        if smooth {
            // The recorded convention: the closing anchor's outgoing handle.
            let a = ours.contours[0].nodes.last().unwrap();
            let b = theirs.contours[0].nodes.last().unwrap();
            let (la, lb) = ((a.r - a.p).hypot(), (b.r - b.p).hypot());
            assert!(
                (la - 10.15).abs() < 0.01 && (lb - 11.21).abs() < 0.01,
                "{la} vs {lb}"
            );
        }
    }
}

#[test]
fn pucker_and_bloat_match_illustrator() {
    let f = fixture();
    // `d_factor` is the percentage (0.5 % here, read from the dictionary).
    for (id, pct) in [
        ("bloat-50-rect", 0.5),
        ("pucker-50-rect", -0.5),
        ("bloat-30-circle", 0.3),
        ("pucker-30-tri", -0.3),
    ] {
        let c = case(&f, id);
        let (ours, theirs) = run(
            c,
            Effect::PuckerBloat(PuckerBloatParams { amount_pct: pct }),
        );
        assert_nodes(&ours, &theirs, 1e-3, false, id);
    }
}

#[test]
fn round_corners_match_illustrator() {
    let f = fixture();
    for id in ["round-10-rect", "round-15-tri"] {
        let c = case(&f, id);
        let (ours, theirs) = run(
            c,
            Effect::RoundCorners(RoundCornersParams {
                radius: num(c, "radius"),
            }),
        );
        assert_nodes(&ours, &theirs, 1e-3, false, id);
    }
}

#[test]
fn offset_path_matches_illustrator() {
    let f = fixture();
    let c = case(&f, "offset-8-tri-round");
    let (ours, theirs) = run(
        c,
        Effect::OffsetPath(OffsetPathParams {
            offset: num(c, "offset"),
            join: PathJoin::Round,
            miter_limit: num(c, "miterLimit"),
        }),
    );
    let (a, b) = (area(&ours), area(&theirs));
    assert!((a - b).abs() / b < 1e-3, "area {a} vs {b}");
    let (ba, bb) = (ours.bounds().unwrap(), theirs.bounds().unwrap());
    for (x, y) in [
        (ba.x0, bb.x0),
        (ba.y0, bb.y0),
        (ba.x1, bb.x1),
        (ba.y1, bb.y1),
    ] {
        assert!((x - y).abs() < 0.05, "bounds {ba:?} vs {bb:?}");
    }
}

#[test]
fn transform_copies_match_illustrator() {
    let f = fixture();
    let c = case(&f, "transform-copies-rect");
    let p = &c["parameters"];
    let (ours, theirs) = run(
        c,
        Effect::TransformCopies(TransformCopiesParams {
            scale_h_pct: p["scaleHPct"].as_f64().unwrap() as f32,
            scale_v_pct: p["scaleVPct"].as_f64().unwrap() as f32,
            move_h: p["moveH"].as_f64().unwrap() as f32,
            // Illustrator's vertical move is up the page; ours is down.
            move_v: -(p["moveV"].as_f64().unwrap() as f32),
            rotate_deg: p["rotateDeg"].as_f64().unwrap() as f32,
            copies: p["copies"].as_u64().unwrap() as u32,
            ..Default::default()
        }),
    );
    assert_eq!(ours.contours.len(), theirs.contours.len());
    // Illustrator lists the copies front (last) to back; compare as sets.
    let key = |s: &Shape, i: usize| {
        let one = Shape {
            contours: vec![s.contours[i].clone()],
        };
        let b = one.bounds().unwrap();
        (area(&one), b)
    };
    for i in 0..ours.contours.len() {
        let (a, b) = key(&ours, i);
        assert!(
            (0..theirs.contours.len()).any(|j| {
                let (a2, b2) = key(&theirs, j);
                (a - a2).abs() < 0.01
                    && (b.x0 - b2.x0).abs() < 0.01
                    && (b.y0 - b2.y0).abs() < 0.01
                    && (b.x1 - b2.x1).abs() < 0.01
                    && (b.y1 - b2.y1).abs() < 0.01
            }),
            "copy {i}: {a} {b:?}"
        );
    }
}

#[test]
fn twist_matches_illustrator_within_its_rounding() {
    let f = fixture();
    for id in ["twist-45-rect", "twist-90-tri"] {
        let c = case(&f, id);
        let (ours, theirs) = run(
            c,
            Effect::Twist(TwistParams {
                angle_deg: num(c, "angleDeg"),
            }),
        );
        let (a, b) = (area(&ours), area(&theirs));
        assert!((a - b).abs() / b < 0.015, "{id}: area {a} vs {b}");
        let (ba, bb) = (ours.bounds().unwrap(), theirs.bounds().unwrap());
        for (x, y) in [
            (ba.x0, bb.x0),
            (ba.y0, bb.y0),
            (ba.x1, bb.x1),
            (ba.y1, bb.y1),
        ] {
            assert!((x - y).abs() < 1.5, "{id}: bounds {ba:?} vs {bb:?}");
        }
        // The input's corners all lie at the farthest distance: fixed.
        let input = shape_of(&c["input"]["paths"]);
        for n in &input.contours[0].nodes {
            for s in [&ours, &theirs] {
                assert!(
                    s.contours[0]
                        .nodes
                        .iter()
                        .any(|m| (m.p - n.p).hypot() < 0.5),
                    "{id}: corner {:?} moved",
                    n.p
                );
            }
        }
    }
}

/// Every anchor's distance from the input outline (a polygon here).
fn distances(input: &Shape, out: &Shape) -> Vec<f64> {
    let input_path = input.to_bezpath();
    out.contours[0]
        .nodes
        .iter()
        .map(|n| {
            let mut best = f64::INFINITY;
            for seg in kurbo::segments(input_path.elements().iter().copied()) {
                use kurbo::ParamCurveNearest;
                best = best.min(seg.nearest(n.p, 1e-6).distance_sq.sqrt());
            }
            best
        })
        .collect()
}

#[test]
fn roughen_matches_illustrator_statistically() {
    let f = fixture();
    for (id, smooth, count) in [
        ("roughen-rect-corner-a", false, 44),
        ("roughen-rect-corner-b", false, 44),
        ("roughen-circle-smooth", true, 68),
    ] {
        let c = case(&f, id);
        let size = num(c, "size");
        let (ours, theirs) = run(
            c,
            Effect::Roughen(RoughenParams {
                size,
                detail_per_inch: num(c, "detailPerInch"),
                smooth,
                relative: false,
                seed: 7,
            }),
        );
        assert_eq!(super::anchor_count(&ours), count, "{id}: ours");
        assert_eq!(super::anchor_count(&theirs), count, "{id}: Illustrator's");
        let input = shape_of(&c["input"]["paths"]);
        let mean = |d: &[f64]| d.iter().sum::<f64>() / d.len() as f64;
        let (da, db) = (distances(&input, &ours), distances(&input, &theirs));
        let half = f64::from(size) / 2.0 + 0.05;
        assert!(da.iter().all(|d| *d <= half), "{id}: ours within size/2");
        assert!(
            db.iter().all(|d| *d <= half),
            "{id}: Illustrator's within size/2"
        );
        let (ma, mb) = (mean(&da), mean(&db));
        assert!((ma - mb).abs() / mb < 0.25, "{id}: mean move {ma} vs {mb}");
    }
}

#[test]
fn tweak_stays_within_its_amounts_like_illustrator() {
    let f = fixture();
    let c = case(&f, "tweak-rect");
    let (h, v) = (num(c, "horizontal"), num(c, "vertical"));
    let (ours, theirs) = run(
        c,
        Effect::Tweak(TweakParams {
            horizontal: h,
            vertical: v,
            ..Default::default()
        }),
    );
    let input = shape_of(&c["input"]["paths"]);
    for s in [&ours, &theirs] {
        assert_eq!(super::anchor_count(s), 4);
        for (a, b) in s.contours[0].nodes.iter().zip(&input.contours[0].nodes) {
            for (x, y) in [(a.p, b.p), (a.l, b.l), (a.r, b.r)] {
                assert!(
                    (x.x - y.x).abs() <= f64::from(h) + 1e-3
                        && (x.y - y.y).abs() <= f64::from(v) + 1e-3
                );
            }
        }
    }
}
