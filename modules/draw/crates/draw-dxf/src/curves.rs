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

//! CAD curves as cubic Béziers: elliptical arcs (circles, arcs, ellipses,
//! polyline bulges) and B-splines (DXF `SPLINE`).
//!
//! An arc is split into pieces of at most 90° and each piece is the
//! standard cubic (handle length `4/3 · tan(θ/4)` of the radius), mapped
//! through the ellipse's axes — exact to 0.03 % of the radius.
//!
//! A B-spline is cut into its Bézier pieces by knot insertion (Boehm), in
//! homogeneous coordinates so a rational spline's weights ride along. A
//! piece of degree 1–3 with equal weights IS a line, a quadratic or a
//! cubic, and is written exactly; any other piece (a higher degree, or
//! unequal weights — a rational conic) is approximated by Hermite cubics
//! that match its points and tangents at eight places, and the caller is
//! told.

/// A point (or a vector) in the plane.
pub type Pt = [f64; 2];

/// One segment of a contour, from the previous point.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Seg {
    Line(Pt),
    Cubic(Pt, Pt, Pt),
}

/// One contour: a start point and its segments.
#[derive(Debug, Clone, PartialEq)]
pub struct Contour {
    pub start: Pt,
    pub segs: Vec<Seg>,
    pub closed: bool,
}

impl Contour {
    pub fn new(start: Pt) -> Self {
        Contour {
            start,
            segs: Vec::new(),
            closed: false,
        }
    }

    /// The last point.
    pub fn end(&self) -> Pt {
        match self.segs.last() {
            Some(Seg::Line(p)) | Some(Seg::Cubic(_, _, p)) => *p,
            None => self.start,
        }
    }

    /// Every point of the contour (anchors and handles).
    pub fn points(&self) -> impl Iterator<Item = Pt> + '_ {
        std::iter::once(self.start).chain(self.segs.iter().flat_map(|s| match *s {
            Seg::Line(p) => vec![p],
            Seg::Cubic(a, b, p) => vec![a, b, p],
        }))
    }

    /// The contour under `m`.
    pub fn mapped(&self, m: &Affine) -> Contour {
        Contour {
            start: m.apply(self.start),
            segs: self
                .segs
                .iter()
                .map(|s| match *s {
                    Seg::Line(p) => Seg::Line(m.apply(p)),
                    Seg::Cubic(a, b, p) => Seg::Cubic(m.apply(a), m.apply(b), m.apply(p)),
                })
                .collect(),
            closed: self.closed,
        }
    }
}

/// `x' = a·x + c·y + e`, `y' = b·x + d·y + f`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Affine(pub [f64; 6]);

impl Affine {
    pub const IDENTITY: Affine = Affine([1.0, 0.0, 0.0, 1.0, 0.0, 0.0]);

    pub fn apply(&self, [x, y]: Pt) -> Pt {
        let [a, b, c, d, e, f] = self.0;
        [a * x + c * y + e, b * x + d * y + f]
    }

    /// `self ∘ other`: `other` applies first.
    pub fn then(&self, other: &Affine) -> Affine {
        let [a1, b1, c1, d1, e1, f1] = self.0;
        let [a2, b2, c2, d2, e2, f2] = other.0;
        Affine([
            a1 * a2 + c1 * b2,
            b1 * a2 + d1 * b2,
            a1 * c2 + c1 * d2,
            b1 * c2 + d1 * d2,
            a1 * e2 + c1 * f2 + e1,
            b1 * e2 + d1 * f2 + f1,
        ])
    }

    pub fn translate(x: f64, y: f64) -> Affine {
        Affine([1.0, 0.0, 0.0, 1.0, x, y])
    }

    pub fn scale(x: f64, y: f64) -> Affine {
        Affine([x, 0.0, 0.0, y, 0.0, 0.0])
    }

    pub fn rotate(rad: f64) -> Affine {
        let (s, c) = rad.sin_cos();
        Affine([c, s, -s, c, 0.0, 0.0])
    }
}

fn add(a: Pt, b: Pt) -> Pt {
    [a[0] + b[0], a[1] + b[1]]
}
fn sub(a: Pt, b: Pt) -> Pt {
    [a[0] - b[0], a[1] - b[1]]
}
fn mul(a: Pt, k: f64) -> Pt {
    [a[0] * k, a[1] * k]
}

/// The arc of the ellipse `centre + major·cos t + minor·sin t` from `t0`
/// through `sweep` radians (negative: clockwise in the ellipse's frame),
/// as cubics appended to `out`. Returns the start point.
pub fn ellipse_arc(
    centre: Pt,
    major: Pt,
    minor: Pt,
    t0: f64,
    sweep: f64,
    out: &mut Vec<Seg>,
) -> Pt {
    let at = |t: f64| add(centre, add(mul(major, t.cos()), mul(minor, t.sin())));
    let tangent = |t: f64| add(mul(major, -t.sin()), mul(minor, t.cos()));
    let pieces = ((sweep.abs() / std::f64::consts::FRAC_PI_2).ceil() as usize).max(1);
    let step = sweep / pieces as f64;
    let k = 4.0 / 3.0 * (step / 4.0).tan();
    let mut t = t0;
    for _ in 0..pieces {
        let (p0, p3) = (at(t), at(t + step));
        let c1 = add(p0, mul(tangent(t), k));
        let c2 = sub(p3, mul(tangent(t + step), k));
        out.push(Seg::Cubic(c1, c2, p3));
        t += step;
    }
    at(t0)
}

/// A polyline segment from `p0` to `p1` with DXF bulge `bulge` (the
/// tangent of a quarter of the included angle; positive: counter-
/// clockwise), appended to `out`.
pub fn bulge_segment(p0: Pt, p1: Pt, bulge: f64, out: &mut Vec<Seg>) {
    if bulge.abs() < 1e-12 || p0 == p1 {
        out.push(Seg::Line(p1));
        return;
    }
    let theta = 4.0 * bulge.atan();
    let v = sub(p1, p0);
    let len = (v[0] * v[0] + v[1] * v[1]).sqrt();
    let left = [-v[1] / len, v[0] / len];
    // The centre sits off the chord's midpoint, to the left for a
    // counter-clockwise arc.
    let off = len / 2.0 / (theta / 2.0).tan();
    let centre = add(add(p0, mul(v, 0.5)), mul(left, off));
    let r = len / 2.0 / (theta / 2.0).sin().abs();
    let a0 = (p0[1] - centre[1]).atan2(p0[0] - centre[0]);
    let mut segs = Vec::new();
    ellipse_arc(centre, [r, 0.0], [0.0, r], a0, theta, &mut segs);
    // Land exactly on the next vertex.
    if let Some(Seg::Cubic(_, _, p)) = segs.last_mut() {
        *p = p1;
    }
    out.extend(segs);
}

/// What a spline conversion could not carry exactly.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct SplineNotes {
    /// A piece was rational or above degree 3: approximated.
    pub approximated: bool,
    /// The spline had fit points only: a curve through them was drawn.
    pub fit_points: bool,
}

/// A B-spline of `degree` over `knots`, `control` points and `weights`
/// (empty: all 1) as one contour. `None` when it is malformed.
pub fn spline(
    degree: usize,
    knots: &[f64],
    control: &[Pt],
    weights: &[f64],
    notes: &mut SplineNotes,
) -> Option<Contour> {
    let n = control.len();
    if degree == 0 || n < degree + 1 || knots.len() != n + degree + 1 {
        return None;
    }
    if knots
        .windows(2)
        .any(|w| w[1].partial_cmp(&w[0]).is_none_or(|o| o.is_lt()))
        || control.iter().flatten().any(|v| !v.is_finite())
    {
        return None;
    }
    let w = |i: usize| weights.get(i).copied().filter(|w| *w > 0.0).unwrap_or(1.0);
    // Homogeneous control points: (w·x, w·y, w).
    let mut pts: Vec<[f64; 3]> = control
        .iter()
        .enumerate()
        .map(|(i, p)| [p[0] * w(i), p[1] * w(i), w(i)])
        .collect();
    let mut u = knots.to_vec();
    let p = degree;
    let (a, b) = (u[p], u[n]);
    if b.partial_cmp(&a) != Some(std::cmp::Ordering::Greater) {
        return None;
    }
    // Every distinct knot in [a, b] to multiplicity p.
    let mut values: Vec<f64> = u.iter().copied().filter(|k| *k >= a && *k <= b).collect();
    values.dedup();
    for v in values {
        while u.iter().filter(|k| **k == v).count() < p {
            insert_knot(&mut u, &mut pts, p, v)?;
        }
    }
    let mut out: Option<Contour> = None;
    for k in p..u.len() - p - 1 {
        if u[k] >= u[k + 1] || u[k] < a || u[k + 1] > b {
            continue;
        }
        let piece = &pts[k - p..=k];
        let c = out.get_or_insert_with(|| Contour::new(project(piece[0])));
        bezier_piece(piece, &mut c.segs, notes);
    }
    out
}

/// Boehm's insertion of knot `v` into `u` (degree `p`).
fn insert_knot(u: &mut Vec<f64>, pts: &mut Vec<[f64; 3]>, p: usize, v: f64) -> Option<()> {
    // The span k: u[k] <= v < u[k+1] — or, at the domain's end, where no
    // control point lies past it, the span on its left (u[k] < v <=
    // u[k+1]); the formula holds for v anywhere in [u[k], u[k+1]].
    let right = (0..u.len() - 1)
        .rev()
        .find(|&i| u[i] <= v && v < u[i + 1])
        .filter(|&k| k < pts.len());
    let k = match right {
        Some(k) => k,
        None => (0..u.len() - 1)
            .rev()
            .find(|&i| u[i] < v && v <= u[i + 1])?,
    };
    if k < p || k >= pts.len() {
        return None;
    }
    let mut q = Vec::with_capacity(pts.len() + 1);
    q.extend_from_slice(&pts[..=k - p]);
    for i in k - p + 1..=k {
        let alpha = (v - u[i]) / (u[i + p] - u[i]);
        let (a, b) = (pts[i - 1], pts[i]);
        q.push([
            (1.0 - alpha) * a[0] + alpha * b[0],
            (1.0 - alpha) * a[1] + alpha * b[1],
            (1.0 - alpha) * a[2] + alpha * b[2],
        ]);
    }
    q.extend_from_slice(&pts[k..]);
    *pts = q;
    u.insert(k + 1, v);
    Some(())
}

fn project(h: [f64; 3]) -> Pt {
    [h[0] / h[2], h[1] / h[2]]
}

/// One Bézier piece (homogeneous points) as cubic segments.
fn bezier_piece(piece: &[[f64; 3]], out: &mut Vec<Seg>, notes: &mut SplineNotes) {
    let w0 = piece[0][2];
    let polynomial = piece.iter().all(|h| (h[2] - w0).abs() <= 1e-9 * w0.abs());
    let q: Vec<Pt> = piece.iter().map(|h| project(*h)).collect();
    match (polynomial, q.len()) {
        (true, 2) => out.push(Seg::Line(q[1])),
        (true, 3) => out.push(Seg::Cubic(
            add(q[0], mul(sub(q[1], q[0]), 2.0 / 3.0)),
            add(q[2], mul(sub(q[1], q[2]), 2.0 / 3.0)),
            q[2],
        )),
        (true, 4) => out.push(Seg::Cubic(q[1], q[2], q[3])),
        _ => {
            notes.approximated = true;
            hermite(piece, out);
        }
    }
}

/// A rational Bézier (homogeneous points) at `t`: its point and
/// derivative.
fn eval(piece: &[[f64; 3]], t: f64) -> (Pt, Pt) {
    let deg = piece.len() - 1;
    let casteljau = |pts: &[[f64; 3]]| -> [f64; 3] {
        let mut v = pts.to_vec();
        for r in 1..v.len() {
            for i in 0..v.len() - r {
                let next = v[i + 1];
                for (c, n) in v[i].iter_mut().zip(next) {
                    *c = (1.0 - t) * *c + t * n;
                }
            }
        }
        v[0]
    };
    let a = casteljau(piece);
    let diff: Vec<[f64; 3]> = piece
        .windows(2)
        .map(|w| {
            [
                deg as f64 * (w[1][0] - w[0][0]),
                deg as f64 * (w[1][1] - w[0][1]),
                deg as f64 * (w[1][2] - w[0][2]),
            ]
        })
        .collect();
    let d = casteljau(&diff);
    let c = [a[0] / a[2], a[1] / a[2]];
    let dc = [(d[0] - d[2] * c[0]) / a[2], (d[1] - d[2] * c[1]) / a[2]];
    (c, dc)
}

/// Eight Hermite cubics matching the piece's points and tangents.
fn hermite(piece: &[[f64; 3]], out: &mut Vec<Seg>) {
    const N: usize = 8;
    let h = 1.0 / N as f64;
    let (mut p0, mut d0) = eval(piece, 0.0);
    for i in 1..=N {
        let (p1, d1) = eval(piece, i as f64 * h);
        out.push(Seg::Cubic(
            add(p0, mul(d0, h / 3.0)),
            sub(p1, mul(d1, h / 3.0)),
            p1,
        ));
        (p0, d0) = (p1, d1);
    }
}

/// A smooth curve through `fit` points (a spline stored by its fit
/// points alone): Catmull-Rom tangents, as cubics.
pub fn through(fit: &[Pt], closed: bool) -> Option<Contour> {
    if fit.len() < 2 {
        return None;
    }
    let n = fit.len();
    let at = |i: isize| -> Pt {
        if closed {
            fit[i.rem_euclid(n as isize) as usize]
        } else {
            fit[i.clamp(0, n as isize - 1) as usize]
        }
    };
    let mut c = Contour::new(fit[0]);
    let last = if closed { n } else { n - 1 };
    for i in 0..last as isize {
        let (p0, p1) = (at(i), at(i + 1));
        let t0 = mul(sub(at(i + 1), at(i - 1)), 1.0 / 6.0);
        let t1 = mul(sub(at(i + 2), at(i)), 1.0 / 6.0);
        c.segs.push(Seg::Cubic(add(p0, t0), sub(p1, t1), p1));
    }
    c.closed = closed;
    Some(c)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: Pt, b: Pt) -> bool {
        (a[0] - b[0]).abs() < 1e-6 && (a[1] - b[1]).abs() < 1e-6
    }

    #[test]
    fn a_circle_is_four_quarter_cubics() {
        let mut segs = Vec::new();
        let start = ellipse_arc(
            [0.0, 0.0],
            [10.0, 0.0],
            [0.0, 10.0],
            0.0,
            std::f64::consts::TAU,
            &mut segs,
        );
        assert!(close(start, [10.0, 0.0]));
        assert_eq!(segs.len(), 4);
        let Seg::Cubic(c1, _, p) = segs[0] else {
            panic!()
        };
        assert!(close(p, [0.0, 10.0]));
        // The quarter's handle: 0.5523 of the radius.
        assert!((c1[1] - 5.522847).abs() < 1e-4, "{c1:?}");
    }

    #[test]
    fn a_bulge_of_one_is_a_half_circle_to_the_left() {
        let mut segs = Vec::new();
        bulge_segment([0.0, 0.0], [10.0, 0.0], 1.0, &mut segs);
        assert_eq!(segs.len(), 2);
        let Seg::Cubic(_, _, mid) = segs[0] else {
            panic!()
        };
        // Counter-clockwise from (0,0) to (10,0) passes below the chord.
        assert!(close(mid, [5.0, -5.0]), "{mid:?}");
        assert_eq!(segs[1], {
            let Seg::Cubic(a, b, _) = segs[1] else {
                panic!()
            };
            Seg::Cubic(a, b, [10.0, 0.0])
        });
    }

    #[test]
    fn a_clamped_cubic_spline_is_its_bezier_pieces_exactly() {
        let ctrl = [
            [0.0, 0.0],
            [1.0, 2.0],
            [3.0, 2.0],
            [4.0, 0.0],
            [6.0, -2.0],
            [8.0, 0.0],
        ];
        let knots = [0.0, 0.0, 0.0, 0.0, 1.0, 2.0, 3.0, 3.0, 3.0, 3.0];
        let mut notes = SplineNotes::default();
        let c = spline(3, &knots, &ctrl, &[], &mut notes).unwrap();
        assert_eq!(c.segs.len(), 3);
        assert!(!notes.approximated);
        assert!(close(c.start, [0.0, 0.0]));
        assert!(close(c.end(), [8.0, 0.0]));
    }

    #[test]
    fn a_single_bezier_spline_keeps_its_control_points() {
        let ctrl = [[0.0, 0.0], [0.0, 10.0], [10.0, 10.0], [10.0, 0.0]];
        let knots = [0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 1.0, 1.0];
        let mut notes = SplineNotes::default();
        let c = spline(3, &knots, &ctrl, &[], &mut notes).unwrap();
        assert_eq!(
            c.segs,
            vec![Seg::Cubic([0.0, 10.0], [10.0, 10.0], [10.0, 0.0])]
        );
    }

    #[test]
    fn a_rational_quarter_circle_is_approximated_on_the_circle() {
        let s = std::f64::consts::FRAC_1_SQRT_2;
        let ctrl = [[10.0, 0.0], [10.0, 10.0], [0.0, 10.0]];
        let knots = [0.0, 0.0, 0.0, 1.0, 1.0, 1.0];
        let mut notes = SplineNotes::default();
        let c = spline(2, &knots, &ctrl, &[1.0, s, 1.0], &mut notes).unwrap();
        assert!(notes.approximated);
        for p in c.segs.iter().map(|s| match s {
            Seg::Cubic(_, _, p) | Seg::Line(p) => *p,
        }) {
            let r = (p[0] * p[0] + p[1] * p[1]).sqrt();
            assert!((r - 10.0).abs() < 1e-6, "{r}");
        }
    }

    #[test]
    fn an_unclamped_uniform_spline_is_cut_to_its_domain() {
        let ctrl = [[0.0, 0.0], [1.0, 1.0], [2.0, 0.0], [3.0, 1.0], [4.0, 0.0]];
        let knots: Vec<f64> = (0..9).map(f64::from).collect();
        let mut notes = SplineNotes::default();
        let c = spline(3, &knots, &ctrl, &[], &mut notes).unwrap();
        assert_eq!(c.segs.len(), 2);
        // A uniform cubic starts at (P0 + 4·P1 + P2) / 6.
        assert!(close(c.start, [1.0, 4.0 / 6.0]), "{:?}", c.start);
    }

    #[test]
    fn a_malformed_spline_is_none() {
        let mut notes = SplineNotes::default();
        assert!(spline(3, &[0.0; 3], &[[0.0, 0.0]; 4], &[], &mut notes).is_none());
    }
}
