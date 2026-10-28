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

//! Paths and matrices on kurbo, the engine's geometry crate (PM-0014,
//! shared capability C8): PostScript's matrices are [`Affine`]s, its
//! paths [`BezPath`]s, its arcs [`kurbo::Arc`]s. What is PostScript's own
//! is here: the current point and subpath start a path carries (PLRM
//! 4.4), and the `concatmatrix` argument order.
//!
//! A path is kept in device space, as PostScript defines it: each point
//! is transformed by the CTM in force when it is appended.

pub use kurbo::{Affine, BezPath, PathEl, Point};

/// The matrix operations in PostScript's terms, on [`Affine`].
pub trait Ps {
    /// `self` applied first, then `then` (`m1 m2 concatmatrix`).
    fn then(&self, then: &Affine) -> Affine;
    fn apply(&self, x: f64, y: f64) -> Point;
    /// A distance (`dtransform`): the linear part only.
    fn apply_delta(&self, x: f64, y: f64) -> Point;
    /// The inverse, or `None` for a singular matrix.
    fn invert(&self) -> Option<Affine>;
}

impl Ps for Affine {
    fn then(&self, then: &Affine) -> Affine {
        *then * *self
    }
    fn apply(&self, x: f64, y: f64) -> Point {
        *self * Point::new(x, y)
    }
    fn apply_delta(&self, x: f64, y: f64) -> Point {
        let c = self.as_coeffs();
        Affine::new([c[0], c[1], c[2], c[3], 0.0, 0.0]) * Point::new(x, y)
    }
    fn invert(&self) -> Option<Affine> {
        let det = self.determinant();
        (det != 0.0 && det.is_finite()).then(|| self.inverse())
    }
}

/// PostScript's `rotate`: degrees.
pub fn rotate_deg(deg: f64) -> Affine {
    Affine::rotate(deg.to_radians())
}

/// A path under construction: the Bézier path and PostScript's current
/// point and subpath start.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Path {
    pub bez: BezPath,
    pub cur: Option<Point>,
    pub start: Option<Point>,
}

impl Path {
    pub fn is_empty(&self) -> bool {
        self.bez.elements().is_empty()
    }
    pub fn len(&self) -> usize {
        self.bez.elements().len()
    }
    pub fn move_to(&mut self, p: Point) {
        // Consecutive movetos collapse into the last (PLRM 4.4.1).
        if let Some(PathEl::MoveTo(last)) = self.bez.elements_mut().last_mut() {
            *last = p;
        } else {
            self.bez.move_to(p);
        }
        self.cur = Some(p);
        self.start = Some(p);
    }
    /// A segment after a closepath starts a new subpath at the current
    /// point (PLRM 4.4.1); one with no current point at all starts at
    /// its own end, as a moveto would.
    fn open(&mut self, at: Point) -> bool {
        let needs = matches!(self.bez.elements().last(), None | Some(PathEl::ClosePath));
        if needs {
            match self.cur {
                Some(c) => self.bez.move_to(c),
                None => {
                    self.move_to(at);
                    return false;
                }
            }
        }
        true
    }
    pub fn line_to(&mut self, p: Point) {
        if self.open(p) {
            self.bez.line_to(p);
        }
        self.cur = Some(p);
    }
    pub fn curve_to(&mut self, a: Point, b: Point, c: Point) {
        if self.open(c) {
            self.bez.curve_to(a, b, c);
        }
        self.cur = Some(c);
    }
    pub fn close(&mut self) {
        if self.cur.is_some()
            && !matches!(self.bez.elements().last(), Some(PathEl::ClosePath) | None)
        {
            self.bez.close_path();
            self.cur = self.start;
        }
    }
    /// Append another path's elements; the current point stays this
    /// path's.
    pub fn append(&mut self, other: &BezPath) {
        self.bez.extend(other.elements().iter().copied());
    }
    pub fn transformed(&self, m: &Affine) -> Path {
        Path {
            bez: *m * self.bez.clone(),
            cur: self.cur.map(|p| *m * p),
            start: self.start.map(|p| *m * p),
        }
    }
    /// `[x0, y0, x1, y1]`, or the current point alone for a path of one
    /// moveto.
    pub fn bbox(&self) -> Option<[f64; 4]> {
        bbox(&self.bez).or_else(|| self.cur.map(|p| [p.x, p.y, p.x, p.y]))
    }
    /// Curves replaced by line segments (`flattenpath`), within
    /// `tolerance` device units.
    pub fn flattened(&self, tolerance: f64) -> Path {
        let mut bez = BezPath::new();
        kurbo::flatten(
            self.bez.elements().iter().copied(),
            tolerance.max(0.01),
            |el| bez.push(el),
        );
        Path {
            bez,
            cur: self.cur,
            start: self.start,
        }
    }
    /// Each subpath reversed (`reversepath`).
    pub fn reversed(&self) -> Path {
        let bez = self.bez.reverse_subpaths();
        let cur = bez.elements().iter().rev().find_map(|e| match e {
            PathEl::MoveTo(p)
            | PathEl::LineTo(p)
            | PathEl::CurveTo(_, _, p)
            | PathEl::QuadTo(_, p) => Some(*p),
            PathEl::ClosePath => None,
        });
        Path {
            bez,
            cur: cur.or(self.cur),
            start: self.start,
        }
    }
}

/// The bounding box of a path, `None` when it has no extent and no
/// points.
pub fn bbox(p: &BezPath) -> Option<[f64; 4]> {
    if p.elements().is_empty() {
        return None;
    }
    let r = kurbo::Shape::bounding_box(p);
    Some([r.x0, r.y0, r.x1, r.y1])
}

/// The cubic segments of a circular arc in user space (PLRM `arc`):
/// centre, radius, angles in degrees, counter-clockwise when `ccw`.
/// Returns the start point and the curves.
pub fn arc_curves(cx: f64, cy: f64, r: f64, a1: f64, a2: f64, ccw: bool) -> (Point, Vec<PathEl>) {
    let mut a2 = a2;
    if ccw {
        while a2 < a1 {
            a2 += 360.0;
        }
    } else {
        while a2 > a1 {
            a2 -= 360.0;
        }
    }
    let arc = kurbo::Arc::new(
        (cx, cy),
        (r, r),
        a1.to_radians(),
        (a2 - a1).to_radians(),
        0.0,
    );
    let start = Point::new(
        cx + r * a1.to_radians().cos(),
        cy + r * a1.to_radians().sin(),
    );
    (start, arc.append_iter((r.abs() * 1e-4).max(1e-9)).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use kurbo::ParamCurve;

    #[test]
    fn concat_order_matches_postscript() {
        // scale then translate: a point is scaled first, then moved.
        let m = Affine::scale(2.0).then(&Affine::translate((10.0, 0.0)));
        assert_eq!(m.apply(1.0, 1.0), Point::new(12.0, 2.0));
        let p = m.invert().unwrap().apply(12.0, 2.0);
        assert!((p.x - 1.0).abs() < 1e-12 && (p.y - 1.0).abs() < 1e-12);
        assert!(Affine::scale(0.0).invert().is_none());
    }

    #[test]
    fn a_quarter_arc_is_one_curve_on_the_circle() {
        let (s, c) = arc_curves(0.0, 0.0, 10.0, 0.0, 90.0, true);
        assert!((s.x - 10.0).abs() < 1e-9 && s.y.abs() < 1e-9);
        let PathEl::CurveTo(a, b, e) = c[0] else {
            panic!()
        };
        let mid = kurbo::CubicBez::new(s, a, b, e).eval(0.5);
        assert!((mid.x.hypot(mid.y) - 10.0).abs() < 0.01);
        let end = |c: &[PathEl]| match c.last() {
            Some(PathEl::CurveTo(_, _, p)) => *p,
            _ => panic!(),
        };
        let e = end(&c);
        assert!((e.x).abs() < 1e-9 && (e.y - 10.0).abs() < 1e-9);
        // Clockwise from 90° to 0° ends on the x axis.
        let e = end(&arc_curves(0.0, 0.0, 1.0, 90.0, 0.0, false).1);
        assert!((e.x - 1.0).abs() < 1e-9 && e.y.abs() < 1e-9);
    }

    #[test]
    fn reversepath_walks_each_subpath_backwards() {
        let mut p = Path::default();
        p.move_to(Point::new(0.0, 0.0));
        p.line_to(Point::new(1.0, 0.0));
        p.line_to(Point::new(1.0, 1.0));
        p.close();
        let r = p.reversed();
        assert_eq!(r.bez.elements()[0], PathEl::MoveTo(Point::new(1.0, 1.0)));
        assert!(r.bez.elements().contains(&PathEl::ClosePath));
    }
}
