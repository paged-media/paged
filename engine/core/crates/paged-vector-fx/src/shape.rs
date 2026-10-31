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

//! The working representation: an item's outline as contours of cubic
//! anchors in f64, converted from and to the model's [`PathAnchor`] table
//! (`anchors`, `subpath_starts`, `subpath_open`).

use kurbo::{BezPath, CubicBez, ParamCurve, ParamCurveArclen, Point, Rect, Shape as _, Vec2};
use paged_model::PathAnchor;

/// One anchor: the on-curve point and its two handles.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Node {
    pub p: Point,
    /// The incoming handle.
    pub l: Point,
    /// The outgoing handle.
    pub r: Point,
}

impl Node {
    pub fn corner(p: Point) -> Self {
        Self { p, l: p, r: p }
    }

    /// Map the point and both handles.
    pub fn map(&self, f: &mut impl FnMut(Point) -> Point) -> Self {
        Self {
            p: f(self.p),
            l: f(self.l),
            r: f(self.r),
        }
    }
}

/// One contour.
#[derive(Debug, Clone, PartialEq)]
pub struct Contour {
    pub nodes: Vec<Node>,
    pub closed: bool,
}

impl Contour {
    /// The segments as cubics, the closing one included for a closed
    /// contour.
    pub fn segments(&self) -> Vec<CubicBez> {
        let n = self.nodes.len();
        if n < 2 {
            return Vec::new();
        }
        let count = if self.closed { n } else { n - 1 };
        (0..count)
            .map(|i| {
                let a = &self.nodes[i];
                let b = &self.nodes[(i + 1) % n];
                CubicBez::new(a.p, a.r, b.l, b.p)
            })
            .collect()
    }
}

/// An outline: any number of contours.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Shape {
    pub contours: Vec<Contour>,
}

fn pt(p: (f32, f32)) -> Point {
    Point::new(f64::from(p.0), f64::from(p.1))
}

fn xy(p: Point) -> (f32, f32) {
    (p.x as f32, p.y as f32)
}

/// Whether a segment is a straight line: both handles on the chord
/// between its ends (collapsed handles, IDML's straight edge, or the
/// third points a converter writes).
pub fn is_straight(c: &CubicBez) -> bool {
    let chord = c.p3 - c.p0;
    let len = chord.hypot();
    if len < 1e-9 {
        return (c.p1 - c.p0).hypot() < 1e-6 && (c.p2 - c.p3).hypot() < 1e-6;
    }
    let off = |q: Point| ((q - c.p0).cross(chord) / len).abs();
    off(c.p1) < 1e-4 && off(c.p2) < 1e-4
}

/// The point at arc-length fraction `f` of a segment (straight segments
/// interpolate linearly: their handles may sit anywhere on the chord).
pub fn point_at_fraction(c: &CubicBez, f: f64) -> Point {
    if is_straight(c) {
        return c.p0.lerp(c.p3, f);
    }
    let total = c.arclen(1e-4);
    let t = c.inv_arclen(total * f, 1e-4);
    c.eval(t)
}

/// A segment's length.
pub fn length(c: &CubicBez) -> f64 {
    if is_straight(c) {
        (c.p3 - c.p0).hypot()
    } else {
        c.arclen(1e-4)
    }
}

impl Shape {
    /// From the model's anchor table.
    pub fn from_anchors(anchors: &[PathAnchor], starts: &[usize], open: &[bool]) -> Self {
        let n = anchors.len();
        let starts: Vec<usize> = if starts.is_empty() {
            vec![0]
        } else {
            starts.to_vec()
        };
        let mut contours = Vec::new();
        for (si, &s) in starts.iter().enumerate() {
            let e = starts.get(si + 1).copied().unwrap_or(n).min(n);
            if e <= s {
                continue;
            }
            contours.push(Contour {
                nodes: anchors[s..e]
                    .iter()
                    .map(|a| Node {
                        p: pt(a.anchor),
                        l: pt(a.left),
                        r: pt(a.right),
                    })
                    .collect(),
                closed: !open.get(si).copied().unwrap_or(false),
            });
        }
        Self { contours }
    }

    /// To the model's anchor table: `(anchors, subpath_starts,
    /// subpath_open)`, with `subpath_starts` empty and `subpath_open`
    /// `[true]` or empty for a single contour, as the IDML reader writes
    /// it.
    pub fn to_anchors(&self) -> (Vec<PathAnchor>, Vec<usize>, Vec<bool>) {
        let mut anchors = Vec::new();
        let mut starts = Vec::new();
        let mut open = Vec::new();
        for c in &self.contours {
            if c.nodes.is_empty() {
                continue;
            }
            starts.push(anchors.len());
            open.push(!c.closed);
            anchors.extend(c.nodes.iter().map(|n| PathAnchor {
                anchor: xy(n.p),
                left: xy(n.l),
                right: xy(n.r),
            }));
        }
        if starts.len() <= 1 {
            starts.clear();
            if open.first() != Some(&true) {
                open.clear();
            }
        }
        (anchors, starts, open)
    }

    /// The outline as a kurbo path.
    pub fn to_bezpath(&self) -> BezPath {
        let mut path = BezPath::new();
        for c in &self.contours {
            let Some(first) = c.nodes.first() else {
                continue;
            };
            path.move_to(first.p);
            for seg in c.segments() {
                path.curve_to(seg.p1, seg.p2, seg.p3);
            }
            if c.closed {
                path.close_path();
            }
        }
        path
    }

    /// From a kurbo path (lines become corner anchors; a closing segment
    /// back onto the start folds into it).
    pub fn from_bezpath(path: &BezPath) -> Self {
        let (a, s, o) = paged_geom::kurbo_kernel::bezpath_to_anchors(path);
        Self::from_anchors(&a, &s, &o)
    }

    /// The geometric bounds (curve extrema, not control points).
    pub fn bounds(&self) -> Option<Rect> {
        let mut out: Option<Rect> = None;
        for c in &self.contours {
            for n in &c.nodes {
                let r = Rect::from_points(n.p, n.p);
                out = Some(out.map_or(r, |o| o.union(r)));
            }
            for seg in c.segments() {
                let r = seg.bounding_box();
                out = Some(out.map_or(r, |o| o.union(r)));
            }
        }
        out
    }

    /// Map every point and handle.
    pub fn map(&self, mut f: impl FnMut(Point) -> Point) -> Self {
        Self {
            contours: self
                .contours
                .iter()
                .map(|c| Contour {
                    nodes: c.nodes.iter().map(|n| n.map(&mut f)).collect(),
                    closed: c.closed,
                })
                .collect(),
        }
    }

    /// Whether every coordinate is finite.
    pub fn is_finite(&self) -> bool {
        self.contours.iter().all(|c| {
            c.nodes
                .iter()
                .all(|n| n.p.is_finite() && n.l.is_finite() && n.r.is_finite())
        })
    }

    /// Every segment cut into `pieces(segment)` parts of equal length;
    /// the original anchors stay, each new point is a corner anchor on
    /// the curve with handles matching the curve (de Casteljau). Returns
    /// the cut shape.
    pub fn subdivide(&self, mut pieces: impl FnMut(&CubicBez) -> usize) -> Self {
        let mut out = Vec::new();
        for c in &self.contours {
            let segs = c.segments();
            if segs.is_empty() {
                out.push(c.clone());
                continue;
            }
            let mut nodes: Vec<Node> = Vec::new();
            for (i, seg) in segs.iter().enumerate() {
                let k = pieces(seg).max(1);
                let start = if i == 0 {
                    c.nodes[0]
                } else {
                    nodes.pop().expect("the previous segment's end")
                };
                let parts = split_even(seg, k);
                let mut cur = start;
                for part in &parts {
                    cur.r = part.p1;
                    nodes.push(cur);
                    cur = Node {
                        p: part.p3,
                        l: part.p2,
                        r: part.p3,
                    };
                }
                let end_idx = (i + 1) % c.nodes.len();
                cur.r = c.nodes[end_idx].r;
                nodes.push(cur);
            }
            if c.closed {
                // The last node is the first again: fold its incoming
                // handle into the first.
                if let Some(last) = nodes.pop() {
                    nodes[0].l = last.l;
                }
            }
            out.push(Contour {
                nodes,
                closed: c.closed,
            });
        }
        Self { contours: out }
    }
}

/// Split a segment into `k` parts of equal arc length.
pub fn split_even(seg: &CubicBez, k: usize) -> Vec<CubicBez> {
    if k <= 1 {
        return vec![*seg];
    }
    if is_straight(seg) {
        return (0..k)
            .map(|i| {
                let a = seg.p0.lerp(seg.p3, i as f64 / k as f64);
                let b = seg.p0.lerp(seg.p3, (i + 1) as f64 / k as f64);
                CubicBez::new(a, a.lerp(b, 1.0 / 3.0), a.lerp(b, 2.0 / 3.0), b)
            })
            .collect();
    }
    let total = seg.arclen(1e-4);
    let ts: Vec<f64> = (0..=k)
        .map(|i| {
            if i == 0 {
                0.0
            } else if i == k {
                1.0
            } else {
                seg.inv_arclen(total * i as f64 / k as f64, 1e-4)
            }
        })
        .collect();
    ts.windows(2).map(|w| seg.subsegment(w[0]..w[1])).collect()
}

/// The unit normal to the left of `d` on a Y-down page (outward for a
/// clockwise contour), or zero.
pub fn left_normal(d: Vec2) -> Vec2 {
    let len = d.hypot();
    if len < 1e-12 {
        return Vec2::ZERO;
    }
    Vec2::new(d.y / len, -d.x / len)
}

/// Map a shape through a non-linear point map: every segment is first
/// cut in two until the mapped cubic stays within `tolerance` of the
/// mapped curve (at most 64 parts), then every anchor and handle is
/// mapped.
pub fn map_nonlinear(shape: &Shape, f: impl Fn(Point) -> Point, tolerance: f64) -> Shape {
    let cut = shape.subdivide(|seg| {
        let mut k = 1usize;
        while k < 64 {
            let ok = split_even(seg, k).iter().all(|part| {
                let mapped = CubicBez::new(f(part.p0), f(part.p1), f(part.p2), f(part.p3));
                [0.25, 0.5, 0.75]
                    .iter()
                    .all(|t| (mapped.eval(*t) - f(part.eval(*t))).hypot() < tolerance)
            });
            if ok {
                break;
            }
            k *= 2;
        }
        k
    });
    cut.map(f)
}
