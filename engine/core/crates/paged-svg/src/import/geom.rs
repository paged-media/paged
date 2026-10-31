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

//! Geometry of the import: affine transforms and usvg paths as native
//! anchor tables.

use paged_mutate::operation::PathAnchorSpec;

/// An affine map `x' = a·x + c·y + e`, `y' = b·x + d·y + f`, in the
/// order of SVG's `matrix(a b c d e f)` (and the engine's `[f32; 6]`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Affine(pub [f32; 6]);

impl Affine {
    pub const IDENTITY: Affine = Affine([1.0, 0.0, 0.0, 1.0, 0.0, 0.0]);

    pub fn translate(x: f32, y: f32) -> Self {
        Affine([1.0, 0.0, 0.0, 1.0, x, y])
    }

    pub fn scale(s: f32) -> Self {
        Affine([s, 0.0, 0.0, s, 0.0, 0.0])
    }

    pub fn from_usvg(t: usvg::Transform) -> Self {
        Affine([t.sx, t.ky, t.kx, t.sy, t.tx, t.ty])
    }

    /// `self ∘ other`: `other` first, then `self`.
    pub fn then(self, other: Affine) -> Affine {
        other.compose(self)
    }

    /// `self ∘ inner`: apply `inner`, then `self`.
    pub fn compose(self, inner: Affine) -> Affine {
        let [a, b, c, d, e, f] = self.0;
        let [a2, b2, c2, d2, e2, f2] = inner.0;
        Affine([
            a * a2 + c * b2,
            b * a2 + d * b2,
            a * c2 + c * d2,
            b * c2 + d * d2,
            a * e2 + c * f2 + e,
            b * e2 + d * f2 + f,
        ])
    }

    pub fn apply(&self, p: [f32; 2]) -> [f32; 2] {
        let [a, b, c, d, e, f] = self.0;
        [a * p[0] + c * p[1] + e, b * p[0] + d * p[1] + f]
    }

    /// The factor a length scales by on average: `√|det|`.
    pub fn mean_scale(&self) -> f32 {
        let [a, b, c, d, ..] = self.0;
        (a * d - b * c).abs().sqrt()
    }

    /// Whether lengths scale the same way in every direction (rotation,
    /// reflection, uniform scale, translation): circles stay circles.
    pub fn is_similarity(&self) -> bool {
        let [a, b, c, d, ..] = self.0;
        let (sx, sy) = ((a * a + b * b).sqrt(), (c * c + d * d).sqrt());
        let dot = a * c + b * d;
        let tol = 1e-3 * sx.max(sy).max(1e-6);
        (sx - sy).abs() <= tol && dot.abs() <= tol * sx.max(sy)
    }

    /// Whether the map only translates and scales by a positive factor
    /// per axis (an axis-aligned box stays an axis-aligned box, upright).
    pub fn is_axis_aligned(&self) -> bool {
        let [a, b, c, d, ..] = self.0;
        b.abs() < 1e-6 && c.abs() < 1e-6 && a > 0.0 && d > 0.0
    }

    pub fn is_finite(&self) -> bool {
        self.0.iter().all(|v| v.is_finite())
    }
}

/// One contour of a path, its anchors in final (page-local) points.
#[derive(Debug, Clone, PartialEq)]
pub struct Contour {
    pub anchors: Vec<PathAnchorSpec>,
    pub closed: bool,
}

fn corner(p: [f32; 2]) -> PathAnchorSpec {
    PathAnchorSpec {
        anchor: p,
        left: p,
        right: p,
    }
}

fn near(a: [f32; 2], b: [f32; 2]) -> bool {
    (a[0] - b[0]).abs() < 1e-3 && (a[1] - b[1]).abs() < 1e-3
}

/// The contours of `path` under `ts`. A closing segment back onto the
/// first anchor is folded into it (InDesign's closed paths do not repeat
/// their first point); degenerate contours (a lone move) are dropped.
pub fn contours(path: &usvg::tiny_skia_path::Path, ts: Affine) -> Vec<Contour> {
    use usvg::tiny_skia_path::PathSegment as S;
    let mut out: Vec<Contour> = Vec::new();
    let mut cur: Option<Contour> = None;
    let finish = |c: Option<Contour>, out: &mut Vec<Contour>| {
        if let Some(c) = c {
            if c.anchors.len() >= 2 {
                out.push(c);
            }
        }
    };
    let pt = |p: usvg::tiny_skia_path::Point| ts.apply([p.x, p.y]);
    for seg in path.segments() {
        match seg {
            S::MoveTo(p) => {
                finish(cur.take(), &mut out);
                cur = Some(Contour {
                    anchors: vec![corner(pt(p))],
                    closed: false,
                });
            }
            S::LineTo(p) => {
                if let Some(c) = cur.as_mut() {
                    c.anchors.push(corner(pt(p)));
                }
            }
            S::QuadTo(q, p) => {
                if let Some(c) = cur.as_mut() {
                    let (q, p) = (pt(q), pt(p));
                    let last = c.anchors.last_mut().expect("a contour starts with a move");
                    let s = last.anchor;
                    last.right = [
                        s[0] + 2.0 / 3.0 * (q[0] - s[0]),
                        s[1] + 2.0 / 3.0 * (q[1] - s[1]),
                    ];
                    c.anchors.push(PathAnchorSpec {
                        anchor: p,
                        left: [
                            p[0] + 2.0 / 3.0 * (q[0] - p[0]),
                            p[1] + 2.0 / 3.0 * (q[1] - p[1]),
                        ],
                        right: p,
                    });
                }
            }
            S::CubicTo(c1, c2, p) => {
                if let Some(c) = cur.as_mut() {
                    let last = c.anchors.last_mut().expect("a contour starts with a move");
                    last.right = pt(c1);
                    let p = pt(p);
                    c.anchors.push(PathAnchorSpec {
                        anchor: p,
                        left: pt(c2),
                        right: p,
                    });
                }
            }
            S::Close => {
                if let Some(mut c) = cur.take() {
                    c.closed = true;
                    if c.anchors.len() > 1 {
                        let (first, last) = (c.anchors[0].anchor, c.anchors[c.anchors.len() - 1]);
                        if near(first, last.anchor) {
                            c.anchors[0].left = last.left;
                            c.anchors.pop();
                        }
                    }
                    // A closed contour of one point is a dot: nothing to draw.
                    if c.anchors.len() >= 2 {
                        out.push(c);
                    }
                }
            }
        }
    }
    finish(cur, &mut out);
    out
}

/// `(top, left, bottom, right)` over every anchor and handle.
pub fn bounds(contours: &[Contour]) -> Option<[f32; 4]> {
    let (mut t, mut l, mut b, mut r) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
    for c in contours {
        for a in &c.anchors {
            for p in [a.anchor, a.left, a.right] {
                l = l.min(p[0]);
                r = r.max(p[0]);
                t = t.min(p[1]);
                b = b.max(p[1]);
            }
        }
    }
    (l <= r && t <= b).then_some([t, l, b, r])
}

/// Every coordinate finite (the engine refuses a non-finite one as a
/// malformed message, which would lose the whole batch).
pub fn finite(contours: &[Contour]) -> bool {
    contours.iter().all(|c| {
        c.anchors.iter().all(|a| {
            a.anchor
                .iter()
                .chain(a.left.iter())
                .chain(a.right.iter())
                .all(|v| v.is_finite())
        })
    })
}

/// The anchors moved by `(dx, dy)`.
pub fn shifted(anchors: &[PathAnchorSpec], dx: f32, dy: f32) -> Vec<PathAnchorSpec> {
    anchors
        .iter()
        .map(|a| PathAnchorSpec {
            anchor: [a.anchor[0] + dx, a.anchor[1] + dy],
            left: [a.left[0] + dx, a.left[1] + dy],
            right: [a.right[0] + dx, a.right[1] + dy],
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compose_applies_inner_first() {
        let m = Affine::translate(10.0, 0.0).compose(Affine::scale(2.0));
        assert_eq!(m.apply([1.0, 1.0]), [12.0, 2.0]);
        let n = Affine::scale(2.0).compose(Affine::translate(10.0, 0.0));
        assert_eq!(n.apply([1.0, 1.0]), [22.0, 2.0]);
    }

    #[test]
    fn similarity_and_axis_alignment() {
        let r = Affine([0.0, 1.0, -1.0, 0.0, 5.0, 5.0]);
        assert!(r.is_similarity());
        assert!(!r.is_axis_aligned());
        assert!(!Affine([2.0, 0.0, 0.0, 1.0, 0.0, 0.0]).is_similarity());
        assert!(Affine([2.0, 0.0, 0.0, 1.0, 0.0, 0.0]).is_axis_aligned());
    }
}
