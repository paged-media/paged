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

//! One test (or a few) per effect: the construction's defining property.

use kurbo::Point;
use paged_model::effect_stack::{Effect, EffectEntry};
use paged_model::vector_effect::*;
use paged_vector_fx::{
    apply_stack, distort, path, scribble, warp, Context, PaintRole, Shape, StrokeStyle,
};

use super::{anchor_count, area, poly, rect, tri};

fn bounds(s: &Shape) -> kurbo::Rect {
    s.bounds().expect("non-empty")
}

#[test]
fn zig_zag_moves_every_point_to_alternate_sides__feat__effects_transparency_live_vector_effects() {
    let out = distort::zig_zag(
        &rect(),
        &ZigZagParams {
            size: 10.0,
            ridges: 4,
            ..Default::default()
        },
    );
    // 4 anchors + 4 ridges on each of the 4 edges.
    assert_eq!(anchor_count(&out), 20);
    let b = bounds(&out);
    assert!(
        (b.x0 - 90.0).abs() < 1e-6 && (b.y0 - 90.0).abs() < 1e-6,
        "{b:?}"
    );
    // The top edge's ridge points sit at 120, 140, 160, 180, inward and
    // outward in turn.
    let ys: Vec<f64> = out.contours[0].nodes[1..5].iter().map(|n| n.p.y).collect();
    assert_eq!(
        ys.iter().map(|y| y.round()).collect::<Vec<_>>(),
        [110.0, 90.0, 110.0, 90.0]
    );
    let smooth = distort::zig_zag(
        &rect(),
        &ZigZagParams {
            size: 10.0,
            ridges: 4,
            smooth: true,
            ..Default::default()
        },
    );
    let n = smooth.contours[0].nodes[1];
    assert!(
        (n.r.x - n.p.x - 10.0).abs() < 1e-6,
        "half the spacing: {n:?}"
    );
}

#[test]
fn zig_zag_relative_size_scales_with_the_box() {
    let out = distort::zig_zag(
        &rect(),
        &ZigZagParams {
            size: 5.0,
            relative: true,
            ridges: 4,
            ..Default::default()
        },
    );
    let diag = (100.0f64 * 100.0 + 60.0 * 60.0).sqrt();
    // The second ridge point of the top edge moves outward.
    let y = out.contours[0].nodes[2].p.y;
    assert!((100.0 - y - 0.05 * diag).abs() < 1e-3, "{y}");
}

#[test]
fn pucker_and_bloat_follow_illustrators_formula() {
    let out = distort::pucker_bloat(&tri(), &PuckerBloatParams { amount_pct: -30.0 });
    // Centre (160, 145); an anchor moves by f·(C − P), its handles by −f·(C − H).
    let n = out.contours[0].nodes[0];
    assert!((n.p.x - (100.0 - 0.3 * 60.0)).abs() < 1e-9);
    assert!((n.r.x - (100.0 + 0.3 * 60.0)).abs() < 1e-9);
    let same = distort::pucker_bloat(&tri(), &PuckerBloatParams { amount_pct: 0.0 });
    assert_eq!(same, tri());
}

#[test]
fn twist_keeps_the_farthest_anchors_and_turns_the_rest() {
    let out = distort::twist(&tri(), &TwistParams { angle_deg: 90.0 });
    // All three corners are 75 from the box centre: none moves.
    for p in [(100.0, 100.0), (220.0, 100.0), (100.0, 190.0)] {
        assert!(
            out.contours[0]
                .nodes
                .iter()
                .any(|n| (n.p - Point::new(p.0, p.1)).hypot() < 1e-6),
            "{p:?}"
        );
    }
    assert!(anchor_count(&out) > 3, "the edges were cut");
    assert_eq!(
        distort::twist(&tri(), &TwistParams { angle_deg: 0.0 }),
        tri()
    );
}

#[test]
fn roughen_is_seeded_and_bounded() {
    let p = RoughenParams {
        size: 5.0,
        detail_per_inch: 10.0,
        ..Default::default()
    };
    let a = distort::roughen(&rect(), &p, 0);
    let b = distort::roughen(&rect(), &p, 0);
    assert_eq!(a, b, "one seed, one outline");
    let c = distort::roughen(
        &rect(),
        &RoughenParams {
            seed: 9,
            ..p.clone()
        },
        0,
    );
    assert_ne!(a, c);
    // round(100/72·10) = 14 and round(60/72·10) = 8 pieces per edge.
    assert_eq!(anchor_count(&a), 2 * (14 + 8));
    // No point leaves the outline by more than size / 2 along its normal.
    let bb = bounds(&a);
    assert!(
        bb.x0 >= 100.0 - 2.5 - 1e-6 && bb.x1 <= 200.0 + 2.5 + 1e-6,
        "{bb:?}"
    );
}

#[test]
fn tweak_moves_within_its_amounts() {
    let out = distort::tweak(
        &rect(),
        &TweakParams {
            horizontal: 10.0,
            vertical: 4.0,
            ..Default::default()
        },
        0,
    );
    for (a, b) in out.contours[0].nodes.iter().zip(&rect().contours[0].nodes) {
        assert!((a.p.x - b.p.x).abs() <= 10.0 && (a.p.y - b.p.y).abs() <= 4.0);
    }
    let still = distort::tweak(
        &rect(),
        &TweakParams {
            anchors: false,
            in_handles: false,
            out_handles: false,
            ..Default::default()
        },
        0,
    );
    assert_eq!(still, rect());
}

#[test]
fn transform_copies_repeat_the_step_about_the_original_pin() {
    let out = distort::transform_copies(
        &rect(),
        &TransformCopiesParams {
            scale_h_pct: 50.0,
            scale_v_pct: 50.0,
            move_h: 20.0,
            move_v: -10.0,
            rotate_deg: 30.0,
            copies: 2,
            ..Default::default()
        },
    );
    assert_eq!(out.contours.len(), 3);
    let centre = |i: usize| {
        let c = &out.contours[i];
        let n = c.nodes.len() as f64;
        let s = c
            .nodes
            .iter()
            .fold(kurbo::Vec2::ZERO, |a, n| a + n.p.to_vec2());
        (s / n).to_point()
    };
    // The recorded centres (Illustrator's Adobe Transform).
    assert!((centre(1) - Point::new(170.0, 120.0)).hypot() < 1e-6);
    assert!(
        (centre(2) - Point::new(176.160_254, 110.669_873)).hypot() < 1e-4,
        "{:?}",
        centre(2)
    );
    assert!((area(&out) - (6000.0 + 1500.0 + 375.0)).abs() < 1e-6);
}

#[test]
fn free_distort_maps_the_box_corners() {
    let p = FreeDistortParams {
        corners: [[-0.1, -0.1], [1.0, 0.0], [1.2, 1.1], [0.0, 1.0]],
    };
    let out = distort::free_distort(&rect(), &p);
    let n = &out.contours[0].nodes;
    assert!(
        (n[0].p - Point::new(90.0, 94.0)).hypot() < 1e-4,
        "{:?}",
        n[0].p
    );
    assert!(
        (n[2].p - Point::new(220.0, 166.0)).hypot() < 1e-4,
        "{:?}",
        n[2].p
    );
    assert_eq!(
        distort::free_distort(&rect(), &FreeDistortParams::default()),
        rect()
    );
}

#[test]
fn every_warp_style_bends_and_none_bends_at_zero() {
    for style in WarpStyle::ALL {
        let flat = warp::warp(
            &rect(),
            &WarpParams {
                style,
                bend_pct: 0.0,
                ..Default::default()
            },
        );
        assert!(
            (area(&flat) - 6000.0).abs() < 1e-3,
            "{style:?} at 0: {}",
            area(&flat)
        );
        for horizontal in [true, false] {
            let out = warp::warp(
                &rect(),
                &WarpParams {
                    style,
                    horizontal,
                    bend_pct: 50.0,
                    ..Default::default()
                },
            );
            assert!(out.is_finite(), "{style:?}");
            assert_ne!(out, rect(), "{style:?} bends");
        }
    }
}

#[test]
fn warp_arc_rises_and_keeps_its_middle_length() {
    let out = warp::warp(
        &rect(),
        &WarpParams {
            style: WarpStyle::Arc,
            bend_pct: 50.0,
            ..Default::default()
        },
    );
    let b = bounds(&out);
    // The middle is the arc's top: the ends fall away from it.
    assert!((b.y0 - 100.0).abs() < 1e-6 && b.y1 > 165.0, "{b:?}");
    let n = out.contours[0].nodes.len();
    assert!(n > 4, "the edges were cut to follow the arcs");
}

#[test]
fn offset_path_grows_and_shrinks() {
    let grown = path::offset_path(
        &rect(),
        &OffsetPathParams {
            offset: 10.0,
            join: PathJoin::Miter,
            miter_limit: 4.0,
        },
    );
    assert!(
        (area(&grown).abs() - 120.0 * 80.0).abs() < 1.0,
        "{}",
        area(&grown)
    );
    let gone = path::offset_path(
        &rect(),
        &OffsetPathParams {
            offset: -40.0,
            ..Default::default()
        },
    );
    assert!(gone.contours.is_empty());
}

#[test]
fn outline_stroke_fills_with_the_stroke() {
    let entries = vec![EffectEntry::new(Effect::OutlinePath(OutlinePathParams {}))];
    let ctx = Context {
        stroke: Some(StrokeStyle {
            weight: 4.0,
            ..Default::default()
        }),
    };
    let fx = apply_stack(&rect(), &entries, &ctx).expect("a vector entry");
    assert_eq!(fx.paint, PaintRole::StrokeAsFill);
    // The band: (104 × 64) − (96 × 56), plus the 2 × 2 loops the
    // stroker's inner joins draw at each corner (paged-geom keeps the raw
    // outline; a non-zero fill paints the band).
    assert!((area(&fx.shape).abs() - (104.0 * 64.0 - 96.0 * 56.0) - 8.0).abs() < 0.5);
    // Without a stroke nothing changes.
    let none = apply_stack(&rect(), &entries, &Context::default()).unwrap();
    assert_eq!(none.paint, PaintRole::Keep);
    assert_eq!(none.shape, rect());
}

#[test]
fn round_corners_cut_along_the_edges() {
    let out = path::round_corners(&tri(), &RoundCornersParams { radius: 15.0 });
    assert_eq!(anchor_count(&out), 6);
    let n = &out.contours[0].nodes;
    // The 36.87° corner at (220, 100): cut 15 along each edge, handles
    // 0.55 · 15 back towards it (recorded).
    assert!(
        (n[2].p - Point::new(205.0, 100.0)).hypot() < 1e-4,
        "{:?}",
        n[2]
    );
    assert!((n[2].r - Point::new(213.25, 100.0)).hypot() < 1e-4);
    assert!(
        (n[3].p - Point::new(208.0, 109.0)).hypot() < 1e-4,
        "{:?}",
        n[3]
    );
    assert!((n[3].l - Point::new(214.6, 104.05)).hypot() < 1e-4);
}

#[test]
fn convert_to_shape_draws_about_the_centre() {
    let e = path::convert_to_shape(
        &tri(),
        &ConvertToShapeParams {
            shape: ShapeKind::Ellipse,
            extra_width: 5.0,
            extra_height: 5.0,
            ..Default::default()
        },
    );
    let b = bounds(&e);
    assert!((b.width() - 130.0).abs() < 1e-6 && (b.height() - 100.0).abs() < 1e-6);
    let r = path::convert_to_shape(
        &tri(),
        &ConvertToShapeParams {
            shape: ShapeKind::RoundedRectangle,
            relative: false,
            width: 40.0,
            height: 20.0,
            corner_radius: 5.0,
            ..Default::default()
        },
    );
    assert_eq!(anchor_count(&r), 8);
    assert!((bounds(&r).center() - Point::new(160.0, 145.0)).hypot() < 1e-6);
}

#[test]
fn pathfinder_combines_members() {
    let a = poly(&[(0.0, 0.0), (100.0, 0.0), (100.0, 100.0), (0.0, 100.0)]);
    let b = poly(&[(50.0, 50.0), (150.0, 50.0), (150.0, 150.0), (50.0, 150.0)]);
    let members = [a, b];
    let union = path::pathfinder(&members, PathfinderOp::Add);
    assert!(
        (area(&union).abs() - 17_500.0).abs() < 1.0,
        "{}",
        area(&union)
    );
    let inter = path::pathfinder(&members, PathfinderOp::Intersect);
    assert!((area(&inter).abs() - 2_500.0).abs() < 1.0);
    let minus = path::pathfinder(&members, PathfinderOp::Subtract);
    assert!(
        (area(&minus).abs() - 7_500.0).abs() < 1.0,
        "back minus front"
    );
    let excl = path::pathfinder(&members, PathfinderOp::Exclude);
    assert!((area(&excl).abs() - 15_000.0).abs() < 1.0);
}

#[test]
fn scribble_draws_inside_the_box_and_fills_only() {
    let entries = vec![EffectEntry::new(
        Effect::Scribble(ScribbleParams::default()),
    )];
    let fx = apply_stack(&rect(), &entries, &Context::default()).unwrap();
    assert_eq!(fx.paint, PaintRole::FillOnly);
    assert!(!fx.shape.contours.is_empty());
    let b = bounds(&fx.shape);
    assert!(
        b.x0 > 90.0 && b.x1 < 210.0 && b.y0 > 90.0 && b.y1 < 170.0,
        "{b:?}"
    );
    let line = scribble::scribble_line(&rect(), &ScribbleParams::default(), 0).unwrap();
    assert!(line.elements().len() > 10);
}

#[test]
fn a_stack_runs_its_vector_entries_in_order_and_skips_the_rest() {
    let zig = EffectEntry::new(Effect::ZigZag(ZigZagParams {
        size: 5.0,
        ridges: 1,
        ..Default::default()
    }));
    let off = EffectEntry::new(Effect::OffsetPath(OffsetPathParams {
        offset: 5.0,
        ..Default::default()
    }));
    let blur = EffectEntry::new(Effect::GaussianBlur(Default::default()));
    let mut disabled = zig.clone();
    disabled.enabled = false;
    let ctx = Context::default();
    assert!(apply_stack(&rect(), std::slice::from_ref(&blur), &ctx).is_none());
    assert!(apply_stack(&rect(), &[disabled], &ctx).is_none());
    let ab = apply_stack(&rect(), &[zig.clone(), blur.clone(), off.clone()], &ctx).unwrap();
    let ba = apply_stack(&rect(), &[off, zig], &ctx).unwrap();
    assert_ne!(ab.shape, ba.shape, "order matters");
}

#[test]
fn the_cache_computes_once() {
    paged_vector_fx::cache::clear();
    let e = vec![EffectEntry::new(Effect::Twist(TwistParams {
        angle_deg: 33.0,
    }))];
    let (h0, m0) = paged_vector_fx::cache::stats();
    let a = apply_stack(&rect(), &e, &Context::default()).unwrap();
    let b = apply_stack(&rect(), &e, &Context::default()).unwrap();
    let (h1, m1) = paged_vector_fx::cache::stats();
    assert!(std::sync::Arc::ptr_eq(&a, &b));
    assert_eq!((h1 - h0, m1 - m0), (1, 1));
}
