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

//! Distort & Transform: Zig Zag, Roughen, Pucker & Bloat, Twist, Tweak,
//! Transform (copies) and Free Distort.
//!
//! Where Illustrator's construction was recorded (the `vector-effects`
//! oracle, `tests/illustrator_oracle.rs`) these follow it step for step;
//! each function says what it reproduces.

use kurbo::{Affine, CubicBez, Point, Rect, Vec2};
use paged_model::vector_effect::{
    BoxPoint, FreeDistortParams, PuckerBloatParams, RoughenParams, TransformCopiesParams,
    TweakParams, TwistParams, ZigZagParams,
};

use crate::rng::Rng;
use crate::shape::{left_normal, length, point_at_fraction, Contour, Node, Shape};

/// 72 pt to the inch.
const PT_PER_INCH: f64 = 72.0;

fn diagonal(b: Rect) -> f64 {
    (b.width().powi(2) + b.height().powi(2)).sqrt()
}

/// One contour's points spread along it: every anchor, and `pieces(seg)
/// - 1` points evenly spaced by arc length inside each segment. The
/// points are the ORIGINAL ones; the effects displace them.
fn sample(c: &Contour, mut pieces: impl FnMut(&CubicBez) -> usize) -> Vec<Point> {
    let segs = c.segments();
    let mut out = Vec::new();
    if segs.is_empty() {
        out.extend(c.nodes.iter().map(|n| n.p));
        return out;
    }
    for seg in &segs {
        let k = pieces(seg).max(1);
        out.push(seg.p0);
        for j in 1..k {
            out.push(point_at_fraction(seg, j as f64 / k as f64));
        }
    }
    if !c.closed {
        out.push(segs.last().expect("non-empty").p3);
    }
    out
}

/// Displace sampled points along their normals, the way Illustrator's
/// Zig Zag and Roughen do (both recorded):
///
/// - a point's normal is perpendicular to the chord between its two
///   neighbours (an end of an open contour uses its one neighbour);
/// - `amount(i)` is the signed distance, positive to the left of the
///   travel direction (outward on a clockwise, Y-down contour);
/// - corner points keep collapsed handles; smooth ones get handles along
///   the chord, each half the distance to that neighbour;
/// - on a closed contour the LAST point's forward neighbour is the
///   already displaced FIRST point (its incoming handle when smooth).
///   That is Illustrator's in-place pass, and the recording shows it.
fn displace(
    pts: &[Point],
    closed: bool,
    smooth: bool,
    mut amount: impl FnMut(usize) -> f64,
) -> Contour {
    let n = pts.len();
    let mut nodes: Vec<Node> = Vec::with_capacity(n);
    if n < 2 {
        return Contour {
            nodes: pts.iter().map(|p| Node::corner(*p)).collect(),
            closed,
        };
    }
    for i in 0..n {
        let prev = if i > 0 {
            Some(pts[i - 1])
        } else if closed {
            Some(pts[n - 1])
        } else {
            None
        };
        let next = if i + 1 < n {
            Some(pts[i + 1])
        } else if closed {
            let first = nodes[0];
            Some(if smooth { first.l } else { first.p })
        } else {
            None
        };
        let p = pts[i];
        let chord = match (prev, next) {
            (Some(a), Some(b)) => b - a,
            (None, Some(b)) => b - p,
            (Some(a), None) => p - a,
            (None, None) => Vec2::ZERO,
        };
        let q = p + left_normal(chord) * amount(i);
        let mut node = Node::corner(q);
        if smooth {
            let len = chord.hypot();
            if len > 1e-12 {
                let dir = chord / len;
                let back = prev.map_or(0.0, |a| (p - a).hypot() / 2.0);
                let fwd = next.map_or(0.0, |b| (b - p).hypot() / 2.0);
                node.l = q - dir * back;
                node.r = q + dir * fwd;
            }
        }
        nodes.push(node);
    }
    Contour { nodes, closed }
}

/// Zig Zag. Each segment gets `ridges` new points at equal arc-length
/// steps; every point (anchors included) moves `size` to alternating
/// sides, starting outward. Recorded: Illustrator 30.1's `Adobe Zigzag`,
/// to 0.01 pt.
pub fn zig_zag(shape: &Shape, p: &ZigZagParams) -> Shape {
    let bounds = shape.bounds().unwrap_or(Rect::ZERO);
    let size = if p.relative {
        f64::from(p.size) / 100.0 * diagonal(bounds)
    } else {
        f64::from(p.size)
    };
    let ridges = p.ridges.min(1000) as usize;
    Shape {
        contours: shape
            .contours
            .iter()
            .map(|c| {
                let pts = sample(c, |_| ridges + 1);
                displace(&pts, c.closed, p.smooth, |i| {
                    if i % 2 == 0 {
                        size
                    } else {
                        -size
                    }
                })
            })
            .collect(),
    }
}

/// Roughen. Each segment is cut into `round(length in inches × detail)`
/// pieces; every point moves along its normal by a random distance in
/// `±size / 2`. Recorded: the piece count exactly, the displacement
/// statistically (Illustrator's sequence is its own; one seed here draws
/// one outline).
pub fn roughen(shape: &Shape, p: &RoughenParams, salt: u64) -> Shape {
    let bounds = shape.bounds().unwrap_or(Rect::ZERO);
    let size = if p.relative {
        f64::from(p.size) / 100.0 * diagonal(bounds)
    } else {
        f64::from(p.size)
    };
    let detail = f64::from(p.detail_per_inch.clamp(0.0, 1000.0));
    let mut rng = Rng::new(u64::from(p.seed) ^ salt);
    Shape {
        contours: shape
            .contours
            .iter()
            .map(|c| {
                let pts = sample(c, |seg| {
                    ((length(seg) / PT_PER_INCH * detail).round() as usize).clamp(1, 10_000)
                });
                let amounts: Vec<f64> = pts.iter().map(|_| rng.signed() * size / 2.0).collect();
                displace(&pts, c.closed, p.smooth, |i| amounts[i])
            })
            .collect(),
    }
}

/// Pucker & Bloat. With `f = amount / 100` and `C` the bounding box's
/// centre, every anchor moves to `P + f·(C − P)` and every handle to
/// `H − f·(C − H)`. Recorded exactly (`Adobe Punk and Bloat`, whose
/// `d_factor` is the percentage).
pub fn pucker_bloat(shape: &Shape, p: &PuckerBloatParams) -> Shape {
    let Some(b) = shape.bounds() else {
        return shape.clone();
    };
    let c = b.center();
    let f = f64::from(p.amount_pct.clamp(-200.0, 200.0)) / 100.0;
    Shape {
        contours: shape
            .contours
            .iter()
            .map(|ct| Contour {
                nodes: ct
                    .nodes
                    .iter()
                    .map(|n| Node {
                        p: n.p + (c - n.p) * f,
                        l: n.l - (c - n.l) * f,
                        r: n.r - (c - n.r) * f,
                    })
                    .collect(),
                closed: ct.closed,
            })
            .collect(),
    }
}

/// Twist. A point at distance `d` from the bounding box's centre turns
/// by `angle · (1 − d / R)` about it, `R` the farthest anchor's
/// distance: the centre the most, the farthest anchor not at all.
/// Segments are first cut until the turned curve stays within 0.1 pt of
/// the turned points (Illustrator cuts too; its output is rounded to
/// whole points, so the recording is matched to 1 pt).
pub fn twist(shape: &Shape, p: &TwistParams) -> Shape {
    let Some(b) = shape.bounds() else {
        return shape.clone();
    };
    let c = b.center();
    let r_max = shape
        .contours
        .iter()
        .flat_map(|ct| ct.nodes.iter())
        .map(|n| (n.p - c).hypot())
        .fold(0.0f64, f64::max);
    if r_max <= 1e-9 || p.angle_deg == 0.0 {
        return shape.clone();
    }
    let angle = f64::from(p.angle_deg).to_radians();
    let turn = |q: Point| -> Point {
        let v = q - c;
        let d = v.hypot();
        let th = angle * (1.0 - (d / r_max).min(1.0));
        let (s, co) = th.sin_cos();
        // Y down: a positive angle turns clockwise on the page.
        c + Vec2::new(v.x * co - v.y * s, v.x * s + v.y * co)
    };
    crate::shape::map_nonlinear(shape, turn, 0.1)
}

/// Tweak: every anchor and handle the flags name moves by a random
/// amount within `±horizontal` and `±vertical` (a percentage of the box's
/// width and height when `relative`). Seeded.
pub fn tweak(shape: &Shape, p: &TweakParams, salt: u64) -> Shape {
    let b = shape.bounds().unwrap_or(Rect::ZERO);
    let (h, v) = if p.relative {
        (
            f64::from(p.horizontal) / 100.0 * b.width(),
            f64::from(p.vertical) / 100.0 * b.height(),
        )
    } else {
        (f64::from(p.horizontal), f64::from(p.vertical))
    };
    let mut rng = Rng::new(u64::from(p.seed) ^ salt ^ 0x7357);
    let jitter = |q: Point, on: bool, rng: &mut Rng| -> Point {
        let dx = rng.signed() * h;
        let dy = rng.signed() * v;
        if on {
            q + Vec2::new(dx, dy)
        } else {
            q
        }
    };
    Shape {
        contours: shape
            .contours
            .iter()
            .map(|ct| Contour {
                nodes: ct
                    .nodes
                    .iter()
                    .map(|n| {
                        let p0 = jitter(n.p, p.anchors, &mut rng);
                        let moved = p0 - n.p;
                        // A handle that does not move on its own follows
                        // its anchor.
                        let l = if p.in_handles {
                            jitter(n.l, true, &mut rng)
                        } else {
                            n.l + moved
                        };
                        let r = if p.out_handles {
                            jitter(n.r, true, &mut rng)
                        } else {
                            n.r + moved
                        };
                        Node { p: p0, l, r }
                    })
                    .collect(),
                closed: ct.closed,
            })
            .collect(),
    }
}

fn box_point(b: Rect, at: BoxPoint) -> Point {
    let (fx, fy) = match at {
        BoxPoint::TopLeft => (0.0, 0.0),
        BoxPoint::Top => (0.5, 0.0),
        BoxPoint::TopRight => (1.0, 0.0),
        BoxPoint::Left => (0.0, 0.5),
        BoxPoint::Center => (0.5, 0.5),
        BoxPoint::Right => (1.0, 0.5),
        BoxPoint::BottomLeft => (0.0, 1.0),
        BoxPoint::Bottom => (0.5, 1.0),
        BoxPoint::BottomRight => (1.0, 1.0),
    };
    Point::new(b.x0 + fx * b.width(), b.y0 + fy * b.height())
}

/// The one step of the Transform effect: scale, reflect and rotate about
/// the pivot, then move. Rotation is counter-clockwise on the page.
pub fn transform_step(p: &TransformCopiesParams, pivot: Point) -> Affine {
    let sx = f64::from(p.scale_h_pct) / 100.0 * if p.reflect_x { -1.0 } else { 1.0 };
    let sy = f64::from(p.scale_v_pct) / 100.0 * if p.reflect_y { -1.0 } else { 1.0 };
    // Y down: counter-clockwise on the page is a negative kurbo angle.
    let rot = Affine::rotate(-f64::from(p.rotate_deg).to_radians());
    Affine::translate(Vec2::new(f64::from(p.move_h), f64::from(p.move_v)))
        * Affine::translate(pivot.to_vec2())
        * rot
        * Affine::scale_non_uniform(sx, sy)
        * Affine::translate(-pivot.to_vec2())
}

/// Transform (copies): the source and `copies` copies, copy `i` the
/// source transformed `i` times about the ORIGINAL box's pivot.
/// Recorded exactly (`Adobe Transform`: each copy's centre is the
/// previous one's mapped through the same transform about the same pin).
pub fn transform_copies(shape: &Shape, p: &TransformCopiesParams) -> Shape {
    let Some(b) = shape.bounds() else {
        return shape.clone();
    };
    let step = transform_step(p, box_point(b, p.origin));
    let copies = p.copies.min(1000);
    let mut out = Shape::default();
    if copies == 0 {
        // Illustrator's Transform with no copies moves the object itself.
        return shape.map(|q| step * q);
    }
    let mut m = Affine::IDENTITY;
    for _ in 0..=copies {
        let t = m;
        out.contours.extend(shape.map(|q| t * q).contours);
        m = step * m;
    }
    out
}

/// Free Distort: the projective map that takes the bounding box's
/// corners to `corners` (each in the box's unit square), applied to every
/// anchor and handle. A straight edge stays straight, as in Illustrator.
pub fn free_distort(shape: &Shape, p: &FreeDistortParams) -> Shape {
    if p.corners == FreeDistortParams::identity() {
        return shape.clone();
    }
    let Some(b) = shape.bounds() else {
        return shape.clone();
    };
    if b.width() <= 1e-9 || b.height() <= 1e-9 {
        return shape.clone();
    }
    let unit = |c: [f32; 2]| {
        (
            b.x0 + f64::from(c[0]) * b.width(),
            b.y0 + f64::from(c[1]) * b.height(),
        )
    };
    let src = [(b.x0, b.y0), (b.x1, b.y0), (b.x1, b.y1), (b.x0, b.y1)];
    let dst = [
        unit(p.corners[0]),
        unit(p.corners[1]),
        unit(p.corners[2]),
        unit(p.corners[3]),
    ];
    let Some(h) = paged_warp::from_quads(src, dst) else {
        return shape.clone();
    };
    let out = shape.map(|q| {
        let (x, y) = paged_warp::apply(&h, (q.x, q.y));
        Point::new(x, y)
    });
    if out.is_finite() {
        out
    } else {
        shape.clone()
    }
}
