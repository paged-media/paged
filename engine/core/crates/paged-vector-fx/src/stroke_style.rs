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

//! Stroke styles (engine ADR 1053): the item's stroke drawn as artwork
//! along its path — a variable-width band (the Width tool's width points,
//! a width profile) or one of Illustrator's Art, Scatter, Pattern and
//! Bristle brushes. Each returns the artwork as a filled outline, which
//! the caller paints with the stroke's paint ([`crate::PaintRole::StrokeAsFill`]).
//!
//! The constructions:
//!
//! - **Width profile:** the stroke weight times the profile's factor,
//!   sampled at evenly spaced stops over every contour's arc length, run
//!   through `paged-geom`'s variable-width outline (its caps, joins and
//!   miter limit are the item's).
//! - **Art:** the artwork's frame (`x` along 0..1, `y` across ±0.5) is
//!   bent onto each contour: `x` to the arc length, `y` along the left
//!   normal times the band's width there.
//! - **Pattern:** the tile is laid end to end, `n = round(L / pitch)`
//!   tiles stretched so they fill the contour exactly, each bent like the
//!   Art brush's artwork.
//! - **Scatter:** copies of the artwork, rigid, centred on points
//!   `pitch` apart, turned with the path plus the rotation, moved across
//!   by the scatter and resized from the seed.
//! - **Bristle:** strands across the band, each its own thin
//!   variable-width stroke tapering at its ends, their offsets,
//!   thicknesses and lengths from the seed.
//!
//! A width profile entry and a brush entry on one item combine: the
//! brush is as wide as the profile says.

use kurbo::{Affine, ParamCurve, PathEl, Point, Vec2};
use paged_geom::kurbo_kernel::StrokeCap;
use paged_model::vector_effect::{BrushArt, BrushKind, BrushParams, WidthProfileParams};
use paged_model::PathAnchor;

use crate::path::StrokeStyle;
use crate::rng::Rng;
use crate::shape::{left_normal, map_nonlinear, Contour, Node, Shape};

/// How closely the bent artwork follows its exact map, pt.
const TOLERANCE: f64 = 0.05;
/// Stops a width profile is sampled at, per contour.
const WIDTH_STOPS: usize = 129;
/// The most copies or tiles one contour draws (a scripted spacing of
/// nearly nothing must not flood the outline).
const MAX_COPIES: usize = 5000;
/// The most bristles.
const MAX_BRISTLES: u32 = 200;

/// The variable-width band of `shape`'s stroke.
pub fn width_outline(
    shape: &Shape,
    profile: &WidthProfileParams,
    stroke: &StrokeStyle,
) -> Option<Shape> {
    if stroke.weight <= 0.0 {
        return None;
    }
    if profile.points.is_empty() {
        return crate::path::outline_stroke(shape, stroke);
    }
    let widths: Vec<f32> = (0..WIDTH_STOPS)
        .map(|i| {
            let t = i as f32 / (WIDTH_STOPS - 1) as f32;
            stroke.weight * profile.factor_at(t)
        })
        .collect();
    // The kernel reads a width at every vertex of the centreline: cut it
    // so the profile has vertices to show on (a straight segment has
    // only its ends).
    let total: f64 = shape
        .contours
        .iter()
        .flat_map(|c| c.segments())
        .map(|seg| crate::shape::length(&seg))
        .sum();
    let step = (total / WIDTH_STOPS as f64).max(0.5);
    let cut =
        shape.subdivide(|seg| ((crate::shape::length(seg) / step).ceil() as usize).clamp(1, 256));
    let (a, s, o) = cut.to_anchors();
    let starts = if s.is_empty() { vec![0] } else { s };
    let open = if o.is_empty() {
        vec![false; starts.len()]
    } else {
        o
    };
    paged_geom::kurbo_kernel::variable_width_outline_stroke(
        &a,
        &starts,
        &open,
        &widths,
        stroke.cap,
        stroke.join,
        stroke.miter_limit,
    )
    .map(|(a, s, o)| Shape::from_anchors(&a, &s, &o))
}

/// A contour flattened for walking: points, the running arc length at
/// each, and a smooth unit tangent at each (the mean of its two chords).
struct Walk {
    pts: Vec<Point>,
    cum: Vec<f64>,
    tan: Vec<Vec2>,
    closed: bool,
}

impl Walk {
    fn new(c: &Contour) -> Option<Self> {
        let segs = c.segments();
        if segs.is_empty() {
            return None;
        }
        let mut pts: Vec<Point> = vec![segs[0].p0];
        for seg in &segs {
            let mut path = kurbo::BezPath::new();
            path.move_to(seg.p0);
            path.curve_to(seg.p1, seg.p2, seg.p3);
            kurbo::flatten(path, TOLERANCE, |el| {
                if let PathEl::LineTo(p) = el {
                    if (p - *pts.last().expect("a start")).hypot() > 1e-9 {
                        pts.push(p);
                    }
                }
            });
            // A degenerate segment flattens to nothing; its end is the
            // segment's end all the same.
            let end = seg.eval(1.0);
            if (end - *pts.last().expect("a start")).hypot() > 1e-9 {
                pts.push(end);
            }
        }
        if c.closed && pts.len() > 2 && (pts[0] - pts[pts.len() - 1]).hypot() < 1e-9 {
            pts.pop();
        }
        if pts.len() < 2 {
            return None;
        }
        let closed = c.closed && pts.len() >= 3;
        let n = pts.len();
        let mut cum = vec![0.0; n + usize::from(closed)];
        for i in 1..n {
            cum[i] = cum[i - 1] + (pts[i] - pts[i - 1]).hypot();
        }
        if closed {
            cum[n] = cum[n - 1] + (pts[0] - pts[n - 1]).hypot();
        }
        let chord = |i: usize| -> Vec2 {
            // The chord leaving point i.
            let j = if i + 1 < n { i + 1 } else { 0 };
            let d = pts[j] - pts[i];
            let l = d.hypot();
            if l < 1e-12 {
                Vec2::ZERO
            } else {
                d / l
            }
        };
        let tan: Vec<Vec2> = (0..n)
            .map(|i| {
                let out = if closed || i + 1 < n {
                    chord(i)
                } else {
                    chord(i - 1)
                };
                let inn = if i > 0 {
                    chord(i - 1)
                } else if closed {
                    chord(n - 1)
                } else {
                    out
                };
                let m = inn + out;
                let l = m.hypot();
                if l < 1e-9 {
                    out
                } else {
                    m / l
                }
            })
            .collect();
        Some(Self {
            pts,
            cum,
            tan,
            closed,
        })
    }

    fn len(&self) -> f64 {
        *self.cum.last().unwrap_or(&0.0)
    }

    /// The point and unit tangent at arc length `s` (clamped on an open
    /// contour, wrapped on a closed one). Past the ends of an open contour
    /// the end tangent extends the path straight.
    fn at(&self, s: f64) -> (Point, Vec2) {
        let total = self.len();
        let n = self.pts.len();
        if self.closed {
            let s = s.rem_euclid(total.max(1e-12));
            let i = self.cum.partition_point(|&c| c <= s).clamp(1, n) - 1;
            let j = (i + 1) % n;
            let span = (self.cum[i + 1] - self.cum[i]).max(1e-12);
            let u = ((s - self.cum[i]) / span).clamp(0.0, 1.0);
            return (
                self.pts[i].lerp(self.pts[j], u),
                lerp_dir(self.tan[i], self.tan[j], u),
            );
        }
        if s <= 0.0 {
            let t = self.tan[0];
            return (self.pts[0] + t * s, t);
        }
        if s >= total {
            let t = self.tan[n - 1];
            return (self.pts[n - 1] + t * (s - total), t);
        }
        let i = self.cum.partition_point(|&c| c <= s).clamp(1, n - 1) - 1;
        let span = (self.cum[i + 1] - self.cum[i]).max(1e-12);
        let u = ((s - self.cum[i]) / span).clamp(0.0, 1.0);
        (
            self.pts[i].lerp(self.pts[i + 1], u),
            lerp_dir(self.tan[i], self.tan[i + 1], u),
        )
    }
}

fn lerp_dir(a: Vec2, b: Vec2, u: f64) -> Vec2 {
    let m = a.lerp(b, u);
    let l = m.hypot();
    if l < 1e-9 {
        a
    } else {
        m / l
    }
}

fn art_shape(art: &BrushArt) -> Shape {
    let anchors: Vec<PathAnchor> = art
        .nodes
        .iter()
        .map(|n| PathAnchor {
            anchor: (n[0], n[1]),
            left: (n[2], n[3]),
            right: (n[4], n[5]),
        })
        .collect();
    let starts: Vec<usize> = art.starts.iter().map(|&s| s as usize).collect();
    let open: Vec<bool> = art.closed.iter().map(|c| !c).collect();
    Shape::from_anchors(&anchors, &starts, &open)
}

use paged_geom::KAPPA;

fn smooth(p: (f64, f64), l: (f64, f64), r: (f64, f64)) -> Node {
    Node {
        p: Point::new(p.0, p.1),
        l: Point::new(l.0, l.1),
        r: Point::new(r.0, r.1),
    }
}

/// The artwork a kind draws when the brush names none: a tapered lens
/// (Art), a chain of diamonds (Pattern), a dot (Scatter).
pub fn builtin_art(kind: BrushKind) -> Shape {
    let nodes = match kind {
        BrushKind::Art => vec![
            Node::corner(Point::new(0.0, 0.0)),
            smooth((0.5, 0.5), (0.2, 0.5), (0.8, 0.5)),
            Node::corner(Point::new(1.0, 0.0)),
            smooth((0.5, -0.5), (0.8, -0.5), (0.2, -0.5)),
        ],
        BrushKind::Pattern => vec![
            Node::corner(Point::new(0.0, 0.0)),
            Node::corner(Point::new(0.5, 0.5)),
            Node::corner(Point::new(1.0, 0.0)),
            Node::corner(Point::new(0.5, -0.5)),
        ],
        BrushKind::Scatter | BrushKind::Bristle => {
            let k = 0.5 * KAPPA;
            vec![
                smooth((0.0, 0.0), (0.0, -k), (0.0, k)),
                smooth((0.5, 0.5), (0.5 - k, 0.5), (0.5 + k, 0.5)),
                smooth((1.0, 0.0), (1.0, k), (1.0, -k)),
                smooth((0.5, -0.5), (0.5 + k, -0.5), (0.5 - k, -0.5)),
            ]
        }
    };
    Shape {
        contours: vec![Contour {
            nodes,
            closed: true,
        }],
    }
}

fn artwork(p: &BrushParams) -> Shape {
    let art = if p.art.is_empty() {
        builtin_art(p.brush_type)
    } else {
        art_shape(&p.art)
    };
    art.map(|q| {
        Point::new(
            if p.flip_along { 1.0 - q.x } else { q.x },
            if p.flip_across { -q.y } else { q.y },
        )
    })
}

fn factor(profile: Option<&WidthProfileParams>, t: f64) -> f64 {
    profile.map_or(1.0, |w| f64::from(w.factor_at(t as f32)))
}

/// Bend artwork in the brush frame onto `walk` between arc lengths `s0`
/// and `s1`: `x` 0..1 spans them, `y` goes along the left normal times
/// the band's width at that point.
fn bend(art: &Shape, walk: &Walk, s0: f64, s1: f64, band: impl Fn(f64) -> f64) -> Shape {
    map_nonlinear(
        art,
        |q| {
            let s = s0 + q.x * (s1 - s0);
            let (pt, t) = walk.at(s);
            pt + left_normal(t) * (q.y * band(s))
        },
        TOLERANCE,
    )
}

fn append(out: &mut Shape, part: Shape) {
    out.contours
        .extend(part.contours.into_iter().filter(|c| c.nodes.len() >= 2));
}

/// The brush's artwork along `shape`, with `stroke`'s weight and, when an
/// entry gives one, the width profile. `None` when nothing can be drawn
/// (no stroke weight, no contour with length).
pub fn brush(
    shape: &Shape,
    p: &BrushParams,
    stroke: &StrokeStyle,
    profile: Option<&WidthProfileParams>,
) -> Option<Shape> {
    let weight = f64::from(stroke.weight);
    if weight <= 0.0 {
        return None;
    }
    let width = weight * f64::from(p.scale_pct.max(0.0)) / 100.0;
    let art = artwork(p);
    let mut out = Shape::default();
    let mut rng = Rng::new(u64::from(p.seed));
    for c in &shape.contours {
        let Some(walk) = Walk::new(c) else {
            continue;
        };
        let len = walk.len();
        if len < 1e-6 {
            continue;
        }
        let band = |s: f64| width * factor(profile, s / len);
        match p.brush_type {
            BrushKind::Art => append(&mut out, bend(&art, &walk, 0.0, len, band)),
            BrushKind::Pattern => {
                let tile = (width * f64::from(p.tile_aspect.max(0.01))).max(1e-3);
                let pitch = (tile * f64::from(p.spacing_pct.max(1.0)) / 100.0).max(1e-3);
                let n = ((len / pitch).round() as usize).clamp(1, MAX_COPIES);
                let k = len / (n as f64 * pitch);
                for i in 0..n {
                    let s0 = i as f64 * pitch * k;
                    append(&mut out, bend(&art, &walk, s0, s0 + tile * k, band));
                }
            }
            BrushKind::Scatter => {
                let pitch = (width * f64::from(p.spacing_pct.max(1.0)) / 100.0).max(1e-3);
                let n = ((len / pitch).floor() as usize).clamp(1, MAX_COPIES);
                let start = (len - (n as f64 - 1.0) * pitch) / 2.0;
                for j in 0..n {
                    let s = if c.closed {
                        j as f64 * len / n as f64
                    } else {
                        start + j as f64 * pitch
                    };
                    let (pt, t) = walk.at(s);
                    let min = f64::from(p.size_min_pct.clamp(0.0, 100.0)) / 100.0;
                    let size = width * factor(profile, s / len) * (min + (1.0 - min) * rng.unit());
                    let turn =
                        f64::from(p.rotate_deg) + f64::from(p.rotate_variation_deg) * rng.signed();
                    let across = weight * f64::from(p.scatter_pct) / 100.0 * rng.signed();
                    let origin = pt + left_normal(t) * across;
                    let place = Affine::translate(origin.to_vec2())
                        * Affine::rotate(t.atan2() + turn.to_radians())
                        * Affine::scale_non_uniform(size, -size)
                        * Affine::translate(Vec2::new(-0.5, 0.0));
                    append(&mut out, art.map(|q| place * q));
                }
            }
            BrushKind::Bristle => {
                let count = p.bristles.clamp(1, MAX_BRISTLES);
                let thick = weight * f64::from(p.bristle_thickness_pct.max(0.1)) / 100.0;
                let steps = ((len / 2.0).ceil() as usize).clamp(8, 256);
                for _ in 0..count {
                    let v = rng.signed() * 0.5;
                    let th = thick * (0.5 + 0.5 * rng.unit());
                    let (a, b) = if c.closed {
                        (0.0, 1.0)
                    } else {
                        (rng.unit() * 0.08, 1.0 - rng.unit() * 0.08)
                    };
                    let anchors: Vec<PathAnchor> = (0..=steps)
                        .map(|i| {
                            let f = a + (b - a) * i as f64 / steps as f64;
                            let s = f * len;
                            let (pt, t) = walk.at(s);
                            let q = pt + left_normal(t) * (v * band(s));
                            let xy = (q.x as f32, q.y as f32);
                            PathAnchor {
                                anchor: xy,
                                left: xy,
                                right: xy,
                            }
                        })
                        .collect();
                    let widths: Vec<f32> = (0..=16)
                        .map(|i| {
                            let f = i as f64 / 16.0;
                            let taper = if c.closed {
                                1.0
                            } else {
                                (f.min(1.0 - f) * 8.0).clamp(0.15, 1.0)
                            };
                            (th * taper * factor(profile, a + (b - a) * f)) as f32
                        })
                        .collect();
                    if let Some((oa, os, oo)) =
                        paged_geom::kurbo_kernel::variable_width_outline_stroke(
                            &anchors,
                            &[0],
                            &[true],
                            &widths,
                            StrokeCap::Round,
                            paged_geom::kurbo_kernel::StrokeJoin::Round,
                            4.0,
                        )
                    {
                        append(&mut out, Shape::from_anchors(&oa, &os, &oo));
                    }
                }
            }
        }
    }
    (!out.contours.is_empty() && out.is_finite()).then_some(out)
}
