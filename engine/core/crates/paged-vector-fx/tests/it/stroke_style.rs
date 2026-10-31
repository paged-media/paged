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

//! Engine ADR 10XX — the stroke styles: width profiles and the Art,
//! Scatter, Pattern and Bristle brushes, alone and on page items. Tests
//! named `*__feat__plugin_draw_brushes_width` are the evidence of the
//! feature row `plugin-draw.brushes-width`.

use paged_geom::kurbo_kernel::{StrokeCap, StrokeJoin};
use paged_model::effect_stack::{Effect, EffectEntry};
use paged_model::vector_effect::*;
use paged_model::{Bounds, PathAnchor, Polygon, Rectangle};
use paged_vector_fx::{
    apply_effect, apply_stack, bake, stroke_style, Context, PaintRole, Shape, StrokeStyle,
};

use crate::area;

/// An open horizontal line from (0, 0) to (100, 0).
fn line() -> Shape {
    let a = |x: f32| PathAnchor {
        anchor: (x, 0.0),
        left: (x, 0.0),
        right: (x, 0.0),
    };
    Shape::from_anchors(&[a(0.0), a(100.0)], &[], &[true])
}

fn stroke(weight: f32) -> StrokeStyle {
    StrokeStyle {
        weight,
        cap: StrokeCap::Butt,
        join: StrokeJoin::Miter,
        miter_limit: 4.0,
    }
}

fn ctx(weight: f32) -> Context {
    Context {
        stroke: Some(stroke(weight)),
    }
}

fn half_height_at(s: &Shape, x: f64) -> f64 {
    // The band's extent across the line near `x`, from the outline's
    // flattened points.
    let mut lo = f64::INFINITY;
    let mut hi = f64::NEG_INFINITY;
    let path = s.to_bezpath();
    kurbo::flatten(path, 0.01, |el| {
        let p = match el {
            kurbo::PathEl::MoveTo(p) | kurbo::PathEl::LineTo(p) => p,
            _ => return,
        };
        if (p.x - x).abs() < 1.0 {
            lo = lo.min(p.y);
            hi = hi.max(p.y);
        }
    });
    (hi - lo) / 2.0
}

fn profile(points: &[(f32, f32)]) -> WidthProfileParams {
    WidthProfileParams {
        points: points
            .iter()
            .map(|&(t, width)| WidthPoint { t, width })
            .collect(),
    }
    .normalized()
}

#[test]
fn a_width_profile_swells_the_band_where_its_points_say__feat__plugin_draw_brushes_width() {
    // Zero at the ends, three times the weight in the middle.
    let p = profile(&[(0.0, 0.0), (0.5, 3.0), (1.0, 0.0)]);
    let out = stroke_style::width_outline(&line(), &p, &stroke(4.0)).expect("an outline");
    let mid = half_height_at(&out, 50.0);
    assert!((mid - 6.0).abs() < 0.3, "half width in the middle {mid}");
    let near_end = half_height_at(&out, 2.0);
    assert!(near_end < 0.5, "tapers to the end, {near_end}");
    // Without points it is the uniform stroke band: 100 × 4.
    let uniform =
        stroke_style::width_outline(&line(), &WidthProfileParams::default(), &stroke(4.0))
            .expect("uniform");
    assert!(
        (area(&uniform).abs() - 400.0).abs() < 1.0,
        "{}",
        area(&uniform)
    );
}

#[test]
fn width_points_ease_and_hold_past_the_ends() {
    let p = profile(&[(0.25, 1.0), (0.75, 3.0)]);
    assert_eq!(p.factor_at(0.0), 1.0);
    assert_eq!(p.factor_at(1.0), 3.0);
    assert!((p.factor_at(0.5) - 2.0).abs() < 1e-6);
    assert_eq!(WidthProfileParams::default().factor_at(0.3), 1.0);
    // Normalised: sorted, clamped, finite only.
    let n = WidthProfileParams {
        points: vec![
            WidthPoint { t: 2.0, width: 1.0 },
            WidthPoint {
                t: -1.0,
                width: 500.0,
            },
            WidthPoint {
                t: f32::NAN,
                width: 1.0,
            },
        ],
    }
    .normalized();
    assert_eq!(n.points.len(), 2);
    assert_eq!(n.points[0].t, 0.0);
    assert_eq!(n.points[0].width, 100.0);
    assert_eq!(n.points[1].t, 1.0);
}

#[test]
fn an_art_brush_stretches_its_artwork_along_the_path__feat__plugin_draw_brushes_width() {
    let p = BrushParams::default();
    let out = stroke_style::brush(&line(), &p, &stroke(10.0), None).expect("art");
    let b = out.bounds().unwrap();
    assert!(
        (b.x0 - 0.0).abs() < 0.1 && (b.x1 - 100.0).abs() < 0.1,
        "{b:?}"
    );
    // The built-in lens is the stroke weight wide at its middle.
    assert!((b.height() - 10.0).abs() < 0.2, "{b:?}");
    // Its area is a lens's, about 0.6 of the band.
    let a = area(&out).abs();
    assert!(a > 400.0 && a < 800.0, "area {a}");
}

#[test]
fn an_art_brush_reads_the_width_profile() {
    let p = BrushParams::default();
    let w = profile(&[(0.0, 2.0), (1.0, 2.0)]);
    let out = stroke_style::brush(&line(), &p, &stroke(10.0), Some(&w)).unwrap();
    assert!((out.bounds().unwrap().height() - 20.0).abs() < 0.3);
}

#[test]
fn a_pattern_brush_fits_whole_tiles__feat__plugin_draw_brushes_width() {
    let p = BrushParams {
        brush_type: BrushKind::Pattern,
        ..Default::default()
    };
    // Tile 10 long on a 100 path: ten diamonds.
    let out = stroke_style::brush(&line(), &p, &stroke(10.0), None).unwrap();
    assert_eq!(out.contours.len(), 10);
    // 103 long: still ten tiles, stretched.
    let a = |x: f32| PathAnchor {
        anchor: (x, 0.0),
        left: (x, 0.0),
        right: (x, 0.0),
    };
    let longer = Shape::from_anchors(&[a(0.0), a(103.0)], &[], &[true]);
    let out = stroke_style::brush(&longer, &p, &stroke(10.0), None).unwrap();
    assert_eq!(out.contours.len(), 10);
    assert!((out.bounds().unwrap().x1 - 103.0).abs() < 0.1);
}

#[test]
fn a_scatter_brush_places_copies_and_its_seed_decides_where() {
    let base = BrushParams {
        brush_type: BrushKind::Scatter,
        spacing_pct: 200.0,
        scatter_pct: 100.0,
        rotate_variation_deg: 45.0,
        size_min_pct: 50.0,
        seed: 3,
        ..Default::default()
    };
    // Copies 10 wide every 20: five dots.
    let out = stroke_style::brush(&line(), &base, &stroke(10.0), None).unwrap();
    assert_eq!(out.contours.len(), 5);
    let again = stroke_style::brush(&line(), &base, &stroke(10.0), None).unwrap();
    assert_eq!(out, again, "one seed, one result");
    let other = stroke_style::brush(
        &line(),
        &BrushParams {
            seed: 4,
            ..base.clone()
        },
        &stroke(10.0),
        None,
    )
    .unwrap();
    assert_ne!(out, other);
    // Every copy stays within the scatter band.
    let b = out.bounds().unwrap();
    assert!(b.y0 > -16.0 && b.y1 < 16.0, "{b:?}");
}

#[test]
fn a_bristle_brush_draws_its_strands() {
    let p = BrushParams {
        brush_type: BrushKind::Bristle,
        bristles: 12,
        ..Default::default()
    };
    let out = stroke_style::brush(&line(), &p, &stroke(10.0), None).unwrap();
    assert!(out.contours.len() >= 12);
    let b = out.bounds().unwrap();
    assert!(b.height() <= 12.0, "within the band, {b:?}");
    assert!(out.is_finite());
}

#[test]
fn custom_artwork_and_flips_are_honoured() {
    // A right triangle pointing along the path.
    let art = BrushArt {
        nodes: vec![
            [0.0, -0.5, 0.0, -0.5, 0.0, -0.5],
            [1.0, 0.0, 1.0, 0.0, 1.0, 0.0],
            [0.0, 0.5, 0.0, 0.5, 0.0, 0.5],
        ],
        starts: vec![],
        closed: vec![true],
    };
    let p = BrushParams {
        art,
        ..Default::default()
    };
    let out = stroke_style::brush(&line(), &p, &stroke(10.0), None).unwrap();
    // Wide at the start: points near x = 0 span the band.
    assert!(half_height_at(&out, 0.0) > 4.5);
    let flipped = stroke_style::brush(
        &line(),
        &BrushParams {
            flip_along: true,
            ..p
        },
        &stroke(10.0),
        None,
    )
    .unwrap();
    assert!(half_height_at(&flipped, 100.0) > 4.5);
    assert!(half_height_at(&flipped, 0.5) < 1.0);
}

#[test]
fn a_stroke_style_takes_the_strokes_place_once() {
    let mut paint = PaintRole::Keep;
    let e = Effect::Brush(BrushParams::default());
    let out = apply_effect(&line(), &e, &ctx(10.0), &mut paint);
    assert_eq!(paint, PaintRole::StrokeAsFill);
    assert_ne!(out, line());
    // Without a stroke nothing changes.
    let mut paint = PaintRole::Keep;
    let out = apply_effect(&line(), &e, &Context::default(), &mut paint);
    assert_eq!(paint, PaintRole::Keep);
    assert_eq!(out, line());
}

#[test]
fn a_profile_and_a_brush_combine_in_a_stack() {
    let stack = vec![
        EffectEntry::new(Effect::WidthProfile(profile(&[(0.0, 2.0), (1.0, 2.0)]))),
        EffectEntry::new(Effect::Brush(BrushParams::default())),
    ];
    let fx = apply_stack(&line(), &stack, &ctx(10.0)).unwrap();
    assert_eq!(fx.paint, PaintRole::StrokeAsFill);
    assert!((fx.shape.bounds().unwrap().height() - 20.0).abs() < 0.3);
}

fn bounds() -> Bounds {
    Bounds {
        top: 0.0,
        left: 0.0,
        bottom: 50.0,
        right: 100.0,
    }
}

#[test]
fn an_item_that_strokes_only_bakes_to_its_artwork__feat__plugin_draw_brushes_width() {
    let mut p = Polygon::new("p", bounds());
    let a = |x: f32, y: f32| PathAnchor {
        anchor: (x, y),
        left: (x, y),
        right: (x, y),
    };
    p.anchors = vec![a(0.0, 0.0), a(100.0, 50.0)];
    p.subpath_open = vec![true];
    p.fill_color = Some(bake::NONE.into());
    p.stroke_color = Some("Color/Red".into());
    p.stroke_weight = Some(6.0);
    p.effect_stack = vec![EffectEntry::new(Effect::Brush(BrushParams::default()))];
    assert!(!bake::polygon_splits(&p));
    let baked = bake::bake_polygon(&p).unwrap();
    assert_eq!(baked.fill_color.as_deref(), Some("Color/Red"));
    assert_eq!(baked.stroke_color.as_deref(), Some(bake::NONE));
    assert!(baked.effect_stack.is_empty());
}

#[test]
fn an_item_that_fills_splits_into_its_fill_and_its_artwork__feat__plugin_draw_brushes_width() {
    let mut r = Rectangle::new("r", bounds());
    r.fill_color = Some("Color/Yellow".into());
    r.stroke_color = Some("Color/Blue".into());
    r.stroke_weight = Some(4.0);
    r.effect_stack = vec![
        EffectEntry::new(Effect::RoundCorners(RoundCornersParams { radius: 5.0 })),
        EffectEntry::new(Effect::WidthProfile(profile(&[
            (0.0, 0.5),
            (0.5, 2.0),
            (1.0, 0.5),
        ]))),
    ];
    assert!(bake::rectangle_splits(&r));
    let fill = bake::fill_part_rectangle(&r);
    assert_eq!(fill.stroke_color.as_deref(), Some(bake::NONE));
    assert_eq!(fill.effect_stack.len(), 1, "round corners stay");
    let art = bake::stroke_art_rectangle(&r).expect("artwork");
    assert_eq!(art.self_id.as_deref(), Some("rvfx"));
    assert_eq!(art.fill_color.as_deref(), Some("Color/Blue"));
    assert_eq!(art.stroke_color.as_deref(), Some(bake::NONE));
    // A ring: the band's outer and inner edges.
    assert!(art.subpath_starts.len() >= 2);
    // A switched-off stroke style does not split.
    r.effect_stack[1].enabled = false;
    assert!(!bake::rectangle_splits(&r));
    assert!(bake::stroke_art_rectangle(&r).is_none());
}
