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

//! THE VECTOR LIQUIFY: Illustrator's seven brush distortions (Warp,
//! Twirl, Pucker, Bloat, Scallop, Crystallize, Wrinkle) over anchor
//! tables, in page pt (y down).
//!
//! THE BRUSH is an ellipse `width` × `height` turned by `angle_deg`. A
//! point's weight is a smooth bump of its normalised elliptical distance
//! `r`: `(1 − r²)²` inside, 0 outside, times `strength`.
//!
//! ONE STEP ([`step`]) is one pointer sample (or one dwell tick):
//! 1. DENSIFY the segments the brush reaches by de Casteljau halving (the
//!    curve does not move) until each control polygon is at most
//!    [`spacing`] long — the brush's smaller radius over `detail + 1`;
//! 2. move the control points: the four smooth kernels send every control
//!    point through one point map ([`displace`], the maps of
//!    [`crate::point_map`] the raster Liquify reads backward); the three
//!    detail kernels move anchors along the path's outward normal and
//!    their handles as "Brush affects" says;
//! 3. mark every anchor moved or minted TOUCHED (the end-of-drag refit
//!    fits only those runs).
//!
//! DETERMINISM: the detail kernels' noise is a hash of an anchor's STABLE
//! id (an original anchor's index; a minted anchor's hash of where it was
//! minted, at 1/64 pt) and the seed, so a spike stays a spike while its
//! anchor moves, on every platform.

use std::f64::consts::PI;

use crate::point_map::{drag, scale_about, turn_about};

type P = [f64; 2];

/// One anchor and its two handles.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Anchor {
    pub anchor: P,
    pub left: P,
    pub right: P,
}

impl Anchor {
    pub const fn corner(p: P) -> Self {
        Self {
            anchor: p,
            left: p,
            right: p,
        }
    }
}

/// A path: its anchors, where each contour starts, which are open.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Table {
    pub anchors: Vec<Anchor>,
    pub subpath_starts: Vec<u32>,
    pub subpath_open: Vec<bool>,
}

/// A path being liquified: per anchor, touched or not and a stable id.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct State {
    pub table: Table,
    pub touched: Vec<bool>,
    pub ids: Vec<u64>,
}

/// The seven kernels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Warp,
    Twirl,
    Pucker,
    Bloat,
    Scallop,
    Crystallize,
    Wrinkle,
}

impl Kind {
    /// In the order of the wire code.
    pub const ALL: [Kind; 7] = [
        Kind::Warp,
        Kind::Twirl,
        Kind::Pucker,
        Kind::Bloat,
        Kind::Scallop,
        Kind::Crystallize,
        Kind::Wrinkle,
    ];

    pub fn from_code(n: u32) -> Option<Self> {
        Self::ALL.get(n as usize).copied()
    }

    /// Is it a point map (warp, twirl, pucker, bloat)?
    pub fn is_field(self) -> bool {
        matches!(self, Kind::Warp | Kind::Twirl | Kind::Pucker | Kind::Bloat)
    }
}

/// The brush: an ellipse on the page.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Brush {
    pub center: P,
    /// pt, the full width and height.
    pub width: f64,
    pub height: f64,
    /// Degrees, counter-clockwise on screen.
    pub angle_deg: f64,
    /// 0..1: Intensity, or the pen's pressure.
    pub strength: f64,
}

/// The kernel's options (Illustrator's tool options).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Params {
    pub kind: Kind,
    /// Warp: the pointer's move since the last step.
    pub delta: P,
    /// Twirl: degrees per full-strength step, positive counter-clockwise
    /// on screen.
    pub twirl_rate: f64,
    /// Scallop / Crystallize / Wrinkle: 0..15.
    pub complexity: f64,
    /// Wrinkle: 0..100 % horizontal and vertical.
    pub horizontal: f64,
    pub vertical: f64,
    /// The detail kernels: which control points move.
    pub affect_anchors: bool,
    pub affect_in: bool,
    pub affect_out: bool,
    pub seed: i32,
}

impl Params {
    /// `kind` with Illustrator's defaults.
    pub fn new(kind: Kind) -> Self {
        Self {
            kind,
            delta: [0.0, 0.0],
            twirl_rate: 40.0,
            complexity: 1.0,
            horizontal: 0.0,
            vertical: 100.0,
            affect_anchors: true,
            affect_in: true,
            affect_out: true,
            seed: 0,
        }
    }
}

const DEG: f64 = PI / 180.0;

/// Pucker / bloat (and the detail kernels): the fraction of the radius a
/// full-strength step moves a point at the centre.
pub const RATE: f64 = 0.08;

/// The most anchors one contour may grow to.
pub const MAX_ANCHORS: usize = 20_000;

/// The brush's smaller semi-axis.
pub fn radius(b: &Brush) -> f64 {
    (b.width.min(b.height) / 2.0).max(1e-6)
}

/// The densification spacing for a `detail` of 1..10.
pub fn spacing(b: &Brush, detail: f64) -> f64 {
    radius(b) / (detail.clamp(1.0, 10.0) + 1.0)
}

/// The normalised elliptical distance of `p` from the centre.
pub fn distance(b: &Brush, p: P) -> f64 {
    let a = -b.angle_deg * DEG;
    let (dx, dy) = (p[0] - b.center[0], p[1] - b.center[1]);
    let (s, c) = a.sin_cos();
    let u = c * dx + s * dy;
    let v = -s * dx + c * dy;
    (u / (b.width / 2.0).max(1e-6)).hypot(v / (b.height / 2.0).max(1e-6))
}

/// The falloff in [0, 1].
pub fn weight(b: &Brush, p: P) -> f64 {
    let r = distance(b, p);
    if r >= 1.0 {
        return 0.0;
    }
    let k = 1.0 - r * r;
    k * k
}

/// JavaScript's `Math.round(v) | 0`, the integer the hash keys on.
fn js_int(v: f64) -> u32 {
    let r = (v + 0.5).floor();
    if !r.is_finite() {
        return 0;
    }
    (r as i64) as u32
}

/// A 32-bit integer hash of a position and a seed onto [−1, 1).
pub fn hash_noise(x: f64, y: f64, seed: i32) -> f64 {
    let mut h = js_int(x * 64.0).wrapping_mul(0x27d4_eb2d)
        ^ js_int(y * 64.0).wrapping_mul(0x1656_67b1)
        ^ (seed as u32).wrapping_mul(0x9e37_79b1);
    h ^= h >> 15;
    h = h.wrapping_mul(0x85eb_ca6b);
    h ^= h >> 13;
    h = h.wrapping_mul(0xc2b2_ae35);
    h ^= h >> 16;
    f64::from(h) / 2_147_483_648.0 - 1.0
}

/// The smooth kernels' point map: where `p` goes in one step. The detail
/// kernels are not maps and answer `p`.
pub fn displace(b: &Brush, params: &Params, p: P) -> P {
    let w = weight(b, p) * b.strength.clamp(0.0, 1.0);
    if w == 0.0 {
        return p;
    }
    let c = (b.center[0], b.center[1]);
    let q = (p[0], p[1]);
    let out = match params.kind {
        Kind::Warp => drag(q, (params.delta[0], params.delta[1]), w),
        // Positive rate is counter-clockwise ON SCREEN: y points down, so a
        // negative angle in page coordinates.
        Kind::Twirl => turn_about(c, q, -params.twirl_rate * DEG * w),
        Kind::Pucker => scale_about(c, q, 1.0 - RATE * w),
        Kind::Bloat => scale_about(c, q, 1.0 + RATE * w),
        _ => q,
    };
    [out.0, out.1]
}

/// Each contour as `(from, to, closed)`: the open flag is read at the
/// contour's position among the non-empty ones.
fn contours(t: &Table) -> Vec<(usize, usize, bool)> {
    let n = t.anchors.len();
    if n == 0 {
        return Vec::new();
    }
    let starts: Vec<usize> = if t.subpath_starts.is_empty() {
        vec![0]
    } else {
        t.subpath_starts.iter().map(|&s| s as usize).collect()
    };
    let mut out = Vec::new();
    for (i, &from) in starts.iter().enumerate() {
        let to = starts.get(i + 1).copied().unwrap_or(n);
        if to > from && to <= n {
            out.push((from, to, false));
        }
    }
    for (k, c) in out.iter_mut().enumerate() {
        c.2 = !t.subpath_open.get(k).copied().unwrap_or(false);
    }
    out
}

fn brush_box(b: &Brush, margin: f64) -> [f64; 4] {
    let a = b.angle_deg * DEG;
    let (rx, ry) = (b.width / 2.0, b.height / 2.0);
    let hx = (rx * a.cos()).hypot(ry * a.sin()) + margin;
    let hy = (rx * a.sin()).hypot(ry * a.cos()) + margin;
    [
        b.center[0] - hx,
        b.center[1] - hy,
        b.center[0] + hx,
        b.center[1] + hy,
    ]
}

fn boxes_meet(pts: &[P; 4], b: &[f64; 4]) -> bool {
    let (mut x0, mut y0, mut x1, mut y1) = (
        f64::INFINITY,
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::NEG_INFINITY,
    );
    for p in pts {
        x0 = x0.min(p[0]);
        y0 = y0.min(p[1]);
        x1 = x1.max(p[0]);
        y1 = y1.max(p[1]);
    }
    !(x1 < b[0] || x0 > b[2] || y1 < b[1] || y0 > b[3])
}

fn polyline_length(c: &[P; 4]) -> f64 {
    c.windows(2)
        .map(|w| (w[1][0] - w[0][0]).hypot(w[1][1] - w[0][1]))
        .sum()
}

fn lerp(a: P, b: P, t: f64) -> P {
    [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]
}

/// A minted anchor's id: a hash of where it was minted.
fn mint_id(p: P) -> u64 {
    ((hash_noise(p[0], p[1], 0x5eed) + 1.0) * f64::from(0x3fff_ffffu32)).floor() as u64 + 0x10_0000
}

/// Subdivide every segment the brush (grown by one spacing) reaches until
/// its control polygon is at most `spacing` long. Exact: de Casteljau
/// halving moves no point of the curve. Minted anchors are touched.
pub fn densify(state: &State, b: &Brush, spacing: f64) -> State {
    let bx = brush_box(b, spacing);
    let sp = spacing.max(1e-3);
    let mut out_state = State::default();
    let cs = contours(&state.table);
    for &(from, to, closed) in &cs {
        out_state
            .table
            .subpath_starts
            .push(out_state.table.anchors.len() as u32);
        out_state.table.subpath_open.push(!closed);
        let src = &state.table.anchors[from..to];
        let flags = &state.touched[from..to];
        let src_ids = &state.ids[from..to];
        let m = src.len();
        let segs = if closed { m } else { m - 1 };
        let mut out: Vec<Anchor> = vec![src[0]];
        let mut out_flags = vec![flags.first().copied().unwrap_or(false)];
        let mut out_ids = vec![src_ids.first().copied().unwrap_or(0)];
        let mut budget = MAX_ANCHORS as i64 - m as i64;
        for s in 0..segs {
            let a = *out.last().expect("one anchor");
            let end = if s + 1 < m { src[s + 1] } else { out[0] };
            let p = [a.anchor, a.right, end.left, end.anchor];
            let mut stack: Vec<[P; 4]> = vec![p];
            let mut pieces: Vec<[P; 4]> = Vec::new();
            while let Some(c) = stack.pop() {
                if budget > 0
                    && polyline_length(&c) > sp
                    && boxes_meet(&c, &bx)
                    && pieces.len() + stack.len() < 4096
                {
                    let q0 = lerp(c[0], c[1], 0.5);
                    let q1 = lerp(c[1], c[2], 0.5);
                    let q2 = lerp(c[2], c[3], 0.5);
                    let r0 = lerp(q0, q1, 0.5);
                    let r1 = lerp(q1, q2, 0.5);
                    let mid = lerp(r0, r1, 0.5);
                    budget -= 1;
                    // The second half first, so the first is next.
                    stack.push([mid, r1, q2, c[3]]);
                    stack.push([c[0], q0, r0, mid]);
                } else {
                    pieces.push(c);
                }
            }
            let mut end_left = p[2];
            if pieces.len() > 1 {
                out.last_mut().expect("one anchor").right = pieces[0][1];
                for k in 1..pieces.len() {
                    let q = pieces[k];
                    let t = Anchor {
                        anchor: q[0],
                        left: pieces[k - 1][2],
                        right: q[1],
                    };
                    out.push(t);
                    out_flags.push(true);
                    out_ids.push(mint_id(t.anchor));
                }
                end_left = pieces[pieces.len() - 1][2];
            }
            if s + 1 < m {
                let mut e = src[s + 1];
                e.left = end_left;
                out.push(e);
                out_flags.push(flags[s + 1]);
                out_ids.push(src_ids[s + 1]);
            } else {
                out[0].left = end_left;
            }
        }
        out_state.table.anchors.extend(out);
        out_state.touched.extend(out_flags);
        out_state.ids.extend(out_ids);
    }
    out_state
}

fn add(a: P, b: P) -> P {
    [a[0] + b[0], a[1] + b[1]]
}
fn sub(a: P, b: P) -> P {
    [a[0] - b[0], a[1] - b[1]]
}
fn scale(a: P, k: f64) -> P {
    [a[0] * k, a[1] * k]
}

/// The detail kernels' move of one anchor and its handles.
fn detail_move(b: &Brush, params: &Params, a: Anchor, id: u64, outward: P) -> Anchor {
    let w = weight(b, a.anchor) * b.strength.clamp(0.0, 1.0);
    if w == 0.0 {
        return a;
    }
    let seed = params.seed;
    let complexity = params.complexity.clamp(0.0, 15.0);
    let r = radius(b);
    let n = hash_noise(id as f64, 0.0, seed);
    // Complexity: the fraction of anchors that are PEAKS, 15 % at 0 to
    // about 68 % at 15; the rest are valleys.
    let valley = (n + 1.0) / 2.0 >= 0.15 + 0.035 * complexity;
    let (mv, handle_move) = match params.kind {
        Kind::Scallop => {
            let k = RATE * w * r * if valley { 0.25 } else { 1.0 };
            (scale(outward, -k), scale(outward, k * 0.75))
        }
        Kind::Crystallize => {
            let k = if valley {
                0.0
            } else {
                RATE * w * r * (0.5 + 0.5 * n.abs())
            };
            (scale(outward, k), [0.0, 0.0])
        }
        Kind::Wrinkle => {
            let hx = params.horizontal / 100.0;
            let vy = params.vertical / 100.0;
            let n2 = hash_noise(id as f64, 1.0, seed.wrapping_add(7));
            let k = RATE * w * r;
            (
                [n * hx * k, n2 * vy * k],
                [-n2 * hx * k * 0.5, n * vy * k * 0.5],
            )
        }
        _ => return a,
    };
    let anchor = if params.affect_anchors {
        add(a.anchor, mv)
    } else {
        a.anchor
    };
    let shift = if params.affect_anchors {
        mv
    } else {
        [0.0, 0.0]
    };
    let mut left = add(a.left, shift);
    let mut right = add(a.right, shift);
    if params.kind == Kind::Crystallize {
        let pull = 1.0 - w.min(1.0);
        if params.affect_in {
            left = add(anchor, scale(sub(left, anchor), pull));
        }
        if params.affect_out {
            right = add(anchor, scale(sub(right, anchor), pull));
        }
    } else {
        if params.affect_in {
            left = add(left, handle_move);
        }
        if params.affect_out {
            right = add(right, scale(handle_move, -1.0));
        }
    }
    Anchor {
        anchor,
        left,
        right,
    }
}

/// Each anchor's outward unit normal: perpendicular to the chord between
/// its neighbours, outside a closed contour (by its signed area) and away
/// from the brush centre on an open one.
fn outward_normals(t: &Table, b: &Brush) -> Vec<P> {
    let mut out = vec![[0.0, -1.0]; t.anchors.len()];
    for (from, to, closed) in contours(t) {
        let m = to - from;
        if m < 2 {
            continue;
        }
        let at = |i: usize| t.anchors[from + i].anchor;
        let mut area = 0.0;
        for i in 0..m {
            let (p, q) = (at(i), at((i + 1) % m));
            area += p[0] * q[1] - q[0] * p[1];
        }
        for i in 0..m {
            let prev = at(if closed {
                (i + m - 1) % m
            } else {
                i.saturating_sub(1)
            });
            let next = at(if closed {
                (i + 1) % m
            } else {
                (i + 1).min(m - 1)
            });
            let (tx, ty) = (next[0] - prev[0], next[1] - prev[1]);
            let l = tx.hypot(ty);
            if l < 1e-12 {
                continue;
            }
            let mut n = [ty / l, -tx / l];
            let p = at(i);
            if closed {
                if area < 0.0 {
                    n = [-n[0], -n[1]];
                }
            } else if (p[0] - b.center[0]) * n[0] + (p[1] - b.center[1]) * n[1] < 0.0 {
                n = [-n[0], -n[1]];
            }
            out[from + i] = n;
        }
    }
    out
}

/// A fresh state: nothing touched, every anchor its own index as id.
pub fn start(table: Table) -> State {
    let n = table.anchors.len();
    State {
        table,
        touched: vec![false; n],
        ids: (0..n as u64).collect(),
    }
}

/// Did any step change the path?
pub fn changed(state: &State) -> bool {
    state.touched.iter().any(|&t| t)
}

/// One step: densify under the brush (`detail` 1..10), then move the
/// control points the kernel moves.
pub fn step(state: &State, b: &Brush, params: &Params, detail: f64) -> State {
    let mut dense = densify(state, b, spacing(b, detail));
    let field = params.kind.is_field();
    let normals = if field {
        Vec::new()
    } else {
        outward_normals(&dense.table, b)
    };
    let anchors = dense.table.anchors.iter_mut().zip(&mut dense.touched);
    for (i, (slot, touched)) in anchors.enumerate() {
        let a = *slot;
        let hit = weight(b, a.anchor) > 0.0 || weight(b, a.left) > 0.0 || weight(b, a.right) > 0.0;
        if !hit {
            continue;
        }
        *touched = true;
        *slot = if field {
            Anchor {
                anchor: displace(b, params, a.anchor),
                left: displace(b, params, a.left),
                right: displace(b, params, a.right),
            }
        } else {
            detail_move(b, params, a, dense.ids[i], normals[i])
        };
    }
    dense
}

#[cfg(test)]
mod tests {
    use super::*;

    const K: f64 = paged_geom::KAPPA * 100.0;

    fn circle() -> Table {
        Table {
            anchors: vec![
                Anchor {
                    anchor: [200.0, 100.0],
                    left: [200.0 - K, 100.0],
                    right: [200.0 + K, 100.0],
                },
                Anchor {
                    anchor: [300.0, 200.0],
                    left: [300.0, 200.0 - K],
                    right: [300.0, 200.0 + K],
                },
                Anchor {
                    anchor: [200.0, 300.0],
                    left: [200.0 + K, 300.0],
                    right: [200.0 - K, 300.0],
                },
                Anchor {
                    anchor: [100.0, 200.0],
                    left: [100.0, 200.0 + K],
                    right: [100.0, 200.0 - K],
                },
            ],
            subpath_starts: vec![0],
            subpath_open: vec![],
        }
    }

    fn line() -> Table {
        Table {
            anchors: vec![Anchor::corner([0.0, 200.0]), Anchor::corner([400.0, 200.0])],
            subpath_starts: vec![0],
            subpath_open: vec![true],
        }
    }

    fn square() -> Table {
        Table {
            anchors: [
                [100.0, 100.0],
                [300.0, 100.0],
                [300.0, 300.0],
                [100.0, 300.0],
            ]
            .map(Anchor::corner)
            .to_vec(),
            subpath_starts: vec![0],
            subpath_open: vec![],
        }
    }

    fn brush(c: P, w: f64, h: f64) -> Brush {
        Brush {
            center: c,
            width: w,
            height: h,
            angle_deg: 0.0,
            strength: 1.0,
        }
    }

    fn run(t: Table, b: &Brush, p: &Params, steps: usize, detail: f64) -> State {
        let mut s = start(t);
        for _ in 0..steps {
            s = step(&s, b, p, detail);
        }
        s
    }

    fn cubic(a: &Anchor, b: &Anchor, t: f64) -> P {
        let s = 1.0 - t;
        let w = [s * s * s, 3.0 * s * s * t, 3.0 * s * t * t, t * t * t];
        let q = [a.anchor, a.right, b.left, b.anchor];
        [
            (0..4).map(|k| w[k] * q[k][0]).sum(),
            (0..4).map(|k| w[k] * q[k][1]).sum(),
        ]
    }

    fn near(a: P, b: P, eps: f64) -> bool {
        (a[0] - b[0]).abs() < eps && (a[1] - b[1]).abs() < eps
    }

    #[test]
    fn the_brush_is_a_turned_ellipse_with_a_smooth_bump() {
        let b = brush([0.0, 0.0], 100.0, 100.0);
        assert_eq!(weight(&b, [0.0, 0.0]), 1.0);
        assert_eq!(weight(&b, [50.0, 0.0]), 0.0);
        assert!((weight(&b, [25.0, 0.0]) - 0.5625).abs() < 1e-12);
        let e = brush([0.0, 0.0], 200.0, 50.0);
        assert!((distance(&e, [100.0, 0.0]) - 1.0).abs() < 1e-12);
        assert!((distance(&e, [0.0, 25.0]) - 1.0).abs() < 1e-12);
        let turned = Brush {
            angle_deg: 90.0,
            ..e
        };
        assert!((distance(&turned, [0.0, 100.0]) - 1.0).abs() < 1e-9);
        assert!((spacing(&b, 1.0) - 25.0).abs() < 1e-12);
        assert!((spacing(&b, 4.0) - 10.0).abs() < 1e-12);
        assert_eq!(spacing(&b, 99.0), spacing(&b, 10.0));
    }

    #[test]
    fn densify_is_exact_and_local() {
        let b = brush([300.0, 200.0], 100.0, 100.0);
        let d = densify(&start(circle()), &b, 10.0);
        assert!(d.table.anchors.len() > 8);
        for (a, &t) in d.table.anchors.iter().zip(&d.touched) {
            if t {
                assert!((a.anchor[0] - 300.0).hypot(a.anchor[1] - 200.0) < 120.0);
            }
        }
        // Every densified piece lies on the original circle.
        let n = d.table.anchors.len();
        for i in 0..n {
            let (a, c) = (&d.table.anchors[i], &d.table.anchors[(i + 1) % n]);
            for k in 0..=8 {
                let p = cubic(a, c, f64::from(k) / 8.0);
                assert!(((p[0] - 200.0).hypot(p[1] - 200.0) - 100.0).abs() < 0.03);
            }
        }
        assert!(
            d.table.anchors.contains(&circle().anchors[3]),
            "far anchor unmoved"
        );
        // A straight edge splits into pieces no longer than the spacing.
        let wide = brush([200.0, 200.0], 400.0, 400.0);
        let d = densify(&start(line()), &wide, 20.0);
        let xs: Vec<f64> = d.table.anchors.iter().map(|a| a.anchor[0]).collect();
        assert!(xs.windows(2).all(|w| w[1] - w[0] <= 20.0 + 1e-9));
        assert_eq!((xs[0], xs[xs.len() - 1]), (0.0, 400.0));
        assert_eq!(d.table.subpath_open, vec![true]);
    }

    #[test]
    fn a_brush_away_from_the_path_changes_nothing() {
        let s = run(
            square(),
            &brush([600.0, 600.0], 100.0, 100.0),
            &Params::new(Kind::Pucker),
            1,
            2.0,
        );
        assert_eq!(s.table.anchors, square().anchors);
        assert!(!changed(&s));
    }

    #[test]
    fn the_four_point_maps() {
        let b = brush([200.0, 200.0], 100.0, 100.0);
        let warp = Params {
            delta: [10.0, -4.0],
            ..Params::new(Kind::Warp)
        };
        assert_eq!(displace(&b, &warp, [200.0, 200.0]), [210.0, 196.0]);
        let s = run(
            line(),
            &b,
            &Params {
                delta: [0.0, -30.0],
                ..Params::new(Kind::Warp)
            },
            1,
            2.0,
        );
        let top = s
            .table
            .anchors
            .iter()
            .map(|a| a.anchor[1])
            .fold(999.0, f64::min);
        assert!((top - 170.0).abs() < 1e-6);
        assert_eq!(s.table.anchors[0], line().anchors[0]);
        // Zero strength is the identity.
        let none = Brush { strength: 0.0, ..b };
        for k in [Kind::Warp, Kind::Twirl, Kind::Pucker, Kind::Bloat] {
            assert_eq!(
                displace(
                    &none,
                    &Params {
                        delta: [5.0, 5.0],
                        ..Params::new(k)
                    },
                    [210.0, 205.0]
                ),
                [210.0, 205.0]
            );
        }
        // Twirl keeps the distance; positive is counter-clockwise on screen.
        let big = brush([0.0, 0.0], 400.0, 400.0);
        let q = displace(
            &big,
            &Params {
                twirl_rate: 90.0,
                ..Params::new(Kind::Twirl)
            },
            [10.0, 0.0],
        );
        assert!((q[0].hypot(q[1]) - 10.0).abs() < 1e-9 && q[1] < 0.0);
        // Pucker pulls in, bloat pushes out.
        let b3 = brush([200.0, 200.0], 300.0, 300.0);
        let pu = displace(&b3, &Params::new(Kind::Pucker), [240.0, 200.0]);
        let bl = displace(&b3, &Params::new(Kind::Bloat), [240.0, 200.0]);
        assert!(pu[0] < 240.0 && pu[0] > 200.0 && pu[1] == 200.0 && bl[0] > 240.0);
    }

    #[test]
    fn the_detail_kernels() {
        let b = brush([300.0, 200.0], 120.0, 120.0);
        let r = |a: &Anchor| (a.anchor[0] - 200.0).hypot(a.anchor[1] - 200.0);
        let s = run(
            circle(),
            &b,
            &Params {
                complexity: 1.0,
                ..Params::new(Kind::Scallop)
            },
            3,
            3.0,
        );
        assert!(s
            .table
            .anchors
            .iter()
            .zip(&s.touched)
            .any(|(a, &t)| t && r(a) < 99.9));
        let s = run(
            circle(),
            &b,
            &Params {
                complexity: 4.0,
                ..Params::new(Kind::Crystallize)
            },
            3,
            4.0,
        );
        assert!(s.table.anchors.iter().map(r).fold(0.0, f64::max) > 102.0);
        assert!(s
            .table
            .anchors
            .iter()
            .zip(&s.touched)
            .any(|(a, &t)| t && r(a) < 100.5));
        // Wrinkle with horizontal 0 keeps every x of the densified line.
        let wb = brush([200.0, 200.0], 200.0, 200.0);
        let wr = Params {
            complexity: 2.0,
            ..Params::new(Kind::Wrinkle)
        };
        let s = run(line(), &wb, &wr, 1, 2.0);
        let dense = densify(&start(line()), &wb, spacing(&wb, 2.0));
        assert!(s
            .table
            .anchors
            .iter()
            .any(|a| (a.anchor[1] - 200.0).abs() > 0.1));
        assert!(s
            .table
            .anchors
            .iter()
            .zip(&dense.table.anchors)
            .all(|(a, d)| a.anchor[0] == d.anchor[0]));
        // Brush affects: anchors off, only the in handles move.
        let only_in = Params {
            affect_anchors: false,
            affect_out: false,
            ..Params::new(Kind::Scallop)
        };
        let s = run(line(), &wb, &only_in, 1, 2.0);
        for (a, d) in s.table.anchors.iter().zip(&dense.table.anchors) {
            assert_eq!((a.anchor, a.right), (d.anchor, d.right));
        }
        assert!(s
            .table
            .anchors
            .iter()
            .zip(&dense.table.anchors)
            .any(|(a, d)| a.left[1] != d.left[1]));
    }

    /// The crystallize is pinned to the numbers the TypeScript kernel this
    /// module replaced produced for the same input (its ids too): the
    /// noise is a hash, so a saved drag replays identically.
    #[test]
    fn crystallize_is_deterministic_and_pinned() {
        assert_eq!(hash_noise(1.25, -3.5, 0), -0.838_941_579_218_953_8);
        assert_eq!(hash_noise(123_456_789.0, 1.0, 10), -0.532_642_607_577_145_1);
        let b = brush([300.0, 200.0], 120.0, 120.0);
        let p = Params {
            complexity: 6.0,
            seed: 3,
            ..Params::new(Kind::Crystallize)
        };
        let s = run(circle(), &b, &p, 2, 2.0);
        assert_eq!(s, run(circle(), &b, &p, 2, 2.0));
        assert_ne!(
            s.table,
            run(circle(), &b, &Params { seed: 4, ..p }, 2, 2.0).table
        );
        assert_eq!(s.table.anchors.len(), 19);
        assert_eq!(&s.ids[..4], &[0, 644_623_995, 1_428_679_564, 663_918_977]);
        let spike = s.table.anchors[9];
        assert!(near(
            spike.anchor,
            [307.384_012_525_093_45, 210.460_298_476_866_23],
            1e-9
        ));
        assert!(near(
            spike.left,
            [307.385_346_725_781_7, 210.447_160_830_126_28],
            1e-9
        ));
    }

    #[test]
    fn repeated_steps_accumulate() {
        let b = brush([200.0, 200.0], 300.0, 300.0);
        let p = Params {
            twirl_rate: 10.0,
            ..Params::new(Kind::Twirl)
        };
        let angle = |t: &Table| {
            let a = t.anchors[0].anchor;
            (a[1] - 200.0).atan2(a[0] - 200.0)
        };
        let a0 = angle(&circle());
        let one = (angle(&run(circle(), &b, &p, 1, 2.0).table) - a0).abs();
        let five = (angle(&run(circle(), &b, &p, 5, 2.0).table) - a0).abs();
        assert!(five > one * 3.0);
    }
}
