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

//! ENVELOPE warps: a rectangle bent through a bicubic Bézier patch (a 4×4
//! control mesh), and the fifteen warp STYLES of Photoshop's Warp Text
//! (Arc, Arc Lower, Arc Upper, Arch, Bulge, Shell Lower, Shell Upper,
//! Flag, Wave, Fish, Rise, Fish Eye, Inflate, Squeeze, Twist) as meshes.
//!
//! One API for both lanes, as the crate promises: [`eval`] maps a point of
//! the rectangle forward (vector artwork, a draw module's envelope), and
//! [`invert`] answers, for an output pixel, where in the rectangle it came
//! from (the backward sampler of a raster warp, `geom.warp_mesh`).
//!
//! # The style meshes
//!
//! Photoshop stores a style as its name, a bend and two distortions
//! (`warpStyle`, `warpValue`, `warpPerspective`, `warpPerspectiveOther`,
//! `warpRotate` in a text layer's warp descriptor) and renders it through a
//! 4×4 mesh; the mesh itself is not stored. Each style here is a closed-form
//! deformation of the centred unit square (circular arc, parabolic bulge,
//! sine flag, radial fish-eye, falloff twist, …), sampled at the sixteen
//! nodes `u, v ∈ {0, ⅓, ⅔, 1}` and turned into the INTERPOLATING bicubic
//! patch through them (the inverse of the Bernstein matrix at those nodes).
//! The distortions are a perspective homography (`crate::from_quads`)
//! applied before the fit. These are this crate's own forms, recorded
//! against Photoshop by the image module's warp-text probe; they are not
//! claimed to be Photoshop's.

use std::f64::consts::{FRAC_PI_2, PI};

/// A bicubic Bézier patch: sixteen control points, row-major — row `r`
/// is `v = r/3`'s row, column `c` runs along `u`. `(x, y)` in the caller's
/// units (pixels, points).
pub type Mesh = [[f64; 2]; 16];

/// An axis-aligned rectangle: the warp's source box.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// Photoshop's warp styles (Warp Text / Edit ▸ Transform ▸ Warp).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum WarpStyle {
    None,
    Arc,
    ArcLower,
    ArcUpper,
    Arch,
    Bulge,
    ShellLower,
    ShellUpper,
    Flag,
    Wave,
    Fish,
    Rise,
    FishEye,
    Inflate,
    Squeeze,
    Twist,
}

impl WarpStyle {
    /// Every style, `None` first, in Photoshop's menu order.
    pub const ALL: [WarpStyle; 16] = [
        WarpStyle::None,
        WarpStyle::Arc,
        WarpStyle::ArcLower,
        WarpStyle::ArcUpper,
        WarpStyle::Arch,
        WarpStyle::Bulge,
        WarpStyle::ShellLower,
        WarpStyle::ShellUpper,
        WarpStyle::Flag,
        WarpStyle::Wave,
        WarpStyle::Fish,
        WarpStyle::Rise,
        WarpStyle::FishEye,
        WarpStyle::Inflate,
        WarpStyle::Squeeze,
        WarpStyle::Twist,
    ];

    /// The wire name (camelCase): `none`, `arc`, `arcLower`, … `twist`.
    pub fn name(self) -> &'static str {
        match self {
            WarpStyle::None => "none",
            WarpStyle::Arc => "arc",
            WarpStyle::ArcLower => "arcLower",
            WarpStyle::ArcUpper => "arcUpper",
            WarpStyle::Arch => "arch",
            WarpStyle::Bulge => "bulge",
            WarpStyle::ShellLower => "shellLower",
            WarpStyle::ShellUpper => "shellUpper",
            WarpStyle::Flag => "flag",
            WarpStyle::Wave => "wave",
            WarpStyle::Fish => "fish",
            WarpStyle::Rise => "rise",
            WarpStyle::FishEye => "fishEye",
            WarpStyle::Inflate => "inflate",
            WarpStyle::Squeeze => "squeeze",
            WarpStyle::Twist => "twist",
        }
    }

    pub fn from_name(s: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|w| w.name() == s)
    }

    /// The `warpStyle` enum value a PSD stores (`warpArc`, …).
    pub fn psd_key(self) -> &'static str {
        match self {
            WarpStyle::None => "warpNone",
            WarpStyle::Arc => "warpArc",
            WarpStyle::ArcLower => "warpArcLower",
            WarpStyle::ArcUpper => "warpArcUpper",
            WarpStyle::Arch => "warpArch",
            WarpStyle::Bulge => "warpBulge",
            WarpStyle::ShellLower => "warpShellLower",
            WarpStyle::ShellUpper => "warpShellUpper",
            WarpStyle::Flag => "warpFlag",
            WarpStyle::Wave => "warpWave",
            WarpStyle::Fish => "warpFish",
            WarpStyle::Rise => "warpRise",
            WarpStyle::FishEye => "warpFisheye",
            WarpStyle::Inflate => "warpInflate",
            WarpStyle::Squeeze => "warpSqueeze",
            WarpStyle::Twist => "warpTwist",
        }
    }

    pub fn from_psd(key: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|w| w.psd_key() == key)
    }
}

/// A warp: a style, its bend and its two perspective distortions, each
/// −1 to 1 (Photoshop's −100 % to 100 %), and the axis it bends along.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Warp {
    pub style: WarpStyle,
    pub bend: f64,
    pub horizontal_distortion: f64,
    pub vertical_distortion: f64,
    /// Photoshop's "Vertical" orientation (`warpRotate` = `Vrtc`): the
    /// style bends the rectangle along its height instead.
    pub vertical: bool,
}

impl Warp {
    /// No warp.
    pub const NONE: Warp = Warp {
        style: WarpStyle::None,
        bend: 0.0,
        horizontal_distortion: 0.0,
        vertical_distortion: 0.0,
        vertical: false,
    };

    /// Does this warp leave every point where it is?
    pub fn is_identity(&self) -> bool {
        let none = self.style == WarpStyle::None || self.bend == 0.0;
        none && self.horizontal_distortion == 0.0 && self.vertical_distortion == 0.0
    }
}

/// The four cubic Bernstein polynomials at `t`.
pub fn bernstein(t: f64) -> [f64; 4] {
    let s = 1.0 - t;
    [s * s * s, 3.0 * s * s * t, 3.0 * s * t * t, t * t * t]
}

/// Their derivatives at `t`.
pub fn bernstein_d(t: f64) -> [f64; 4] {
    let s = 1.0 - t;
    [
        -3.0 * s * s,
        3.0 * s * s - 6.0 * s * t,
        6.0 * s * t - 3.0 * t * t,
        3.0 * t * t,
    ]
}

/// The patch at `(u, v)`.
pub fn eval(mesh: &Mesh, u: f64, v: f64) -> (f64, f64) {
    let (bu, bv) = (bernstein(u), bernstein(v));
    let (mut x, mut y) = (0.0, 0.0);
    for r in 0..4 {
        for c in 0..4 {
            let w = bv[r] * bu[c];
            x += w * mesh[r * 4 + c][0];
            y += w * mesh[r * 4 + c][1];
        }
    }
    (x, y)
}

/// `[[∂x/∂u, ∂x/∂v], [∂y/∂u, ∂y/∂v]]` at `(u, v)`.
pub fn jacobian(mesh: &Mesh, u: f64, v: f64) -> [[f64; 2]; 2] {
    let (bu, bv) = (bernstein(u), bernstein(v));
    let (du, dv) = (bernstein_d(u), bernstein_d(v));
    let mut j = [[0.0; 2]; 2];
    for r in 0..4 {
        for c in 0..4 {
            let p = mesh[r * 4 + c];
            let wu = bv[r] * du[c];
            let wv = dv[r] * bu[c];
            j[0][0] += wu * p[0];
            j[0][1] += wv * p[0];
            j[1][0] += wu * p[1];
            j[1][1] += wv * p[1];
        }
    }
    j
}

/// The coarse search grid [`invert`] seeds Newton from (per side).
pub const INVERT_GRID: usize = 8;
/// Newton steps [`invert`] takes at most.
pub const INVERT_STEPS: usize = 10;

/// Where in the unit square the patch sends to `(x, y)`: `Some((u, v))`
/// with `u, v ∈ [0, 1]`, or `None` when no point of the square lands
/// there (within `tolerance`, in the mesh's units). Seeded from the
/// nearest node of an `INVERT_GRID`² grid, then Newton on the 2×2
/// Jacobian. Where the patch folds over itself the seed's sheet wins.
pub fn invert(mesh: &Mesh, (x, y): (f64, f64), tolerance: f64) -> Option<(f64, f64)> {
    let n = INVERT_GRID;
    let mut best = (0.5, 0.5);
    let mut best_d = f64::INFINITY;
    for i in 0..=n {
        for k in 0..=n {
            let (u, v) = (k as f64 / n as f64, i as f64 / n as f64);
            let (px, py) = eval(mesh, u, v);
            let d = (px - x).powi(2) + (py - y).powi(2);
            if d < best_d {
                best_d = d;
                best = (u, v);
            }
        }
    }
    let (mut u, mut v) = best;
    for _ in 0..INVERT_STEPS {
        let (px, py) = eval(mesh, u, v);
        let (ex, ey) = (px - x, py - y);
        if ex * ex + ey * ey <= tolerance * tolerance * 1e-4 {
            break;
        }
        let j = jacobian(mesh, u, v);
        let det = j[0][0] * j[1][1] - j[0][1] * j[1][0];
        if det.abs() < 1e-12 {
            break;
        }
        let du = (j[1][1] * ex - j[0][1] * ey) / det;
        let dv = (-j[1][0] * ex + j[0][0] * ey) / det;
        u = (u - du).clamp(-0.25, 1.25);
        v = (v - dv).clamp(-0.25, 1.25);
    }
    let (px, py) = eval(mesh, u, v);
    let close = (px - x).powi(2) + (py - y).powi(2) <= tolerance * tolerance;
    let inside = (-1e-9..=1.0 + 1e-9).contains(&u) && (-1e-9..=1.0 + 1e-9).contains(&v);
    (close && inside).then_some((u.clamp(0.0, 1.0), v.clamp(0.0, 1.0)))
}

/// The box around the warped rectangle (sampled on a 17 × 17 grid, which
/// a style's interior can push past its edges, as Twist does).
pub fn extent(mesh: &Mesh) -> Rect {
    let (mut x0, mut y0, mut x1, mut y1) = (
        f64::INFINITY,
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::NEG_INFINITY,
    );
    for i in 0..=16 {
        for k in 0..=16 {
            let (x, y) = eval(mesh, k as f64 / 16.0, i as f64 / 16.0);
            x0 = x0.min(x);
            y0 = y0.min(y);
            x1 = x1.max(x);
            y1 = y1.max(y);
        }
    }
    Rect {
        x: x0,
        y: y0,
        w: x1 - x0,
        h: y1 - y0,
    }
}

/// The identity mesh of `rect`: the patch is the rectangle itself.
pub fn identity(rect: Rect) -> Mesh {
    from_points(|u, v| (rect.x + u * rect.w, rect.y + v * rect.h))
}

/// The mesh `warp` bends `rect` through.
pub fn mesh(warp: &Warp, rect: Rect) -> Mesh {
    if warp.is_identity() || rect.w <= 0.0 || rect.h <= 0.0 {
        return identity(rect);
    }
    let (cx, cy) = (rect.x + rect.w / 2.0, rect.y + rect.h / 2.0);
    let (hw, hh) = (rect.w / 2.0, rect.h / 2.0);
    let perspective = distortion(warp, rect);
    from_points(|u, v| {
        let (s, t) = (2.0 * u - 1.0, 2.0 * v - 1.0);
        let (dx, dy) = if warp.vertical {
            let (a, b) = style_offset(warp.style, warp.bend, t, s, hh, hw);
            (b, a)
        } else {
            style_offset(warp.style, warp.bend, s, t, hw, hh)
        };
        let p = (cx + dx, cy + dy);
        match &perspective {
            Some(h) => crate::apply(h, p),
            None => p,
        }
    })
}

/// The perspective the two distortions make: the rectangle onto a
/// trapezoid, the right edge `1 + h` times as tall as the middle and the
/// left `1 − h` (horizontal), the bottom `1 + v` times as wide and the top
/// `1 − v` (vertical).
fn distortion(warp: &Warp, r: Rect) -> Option<crate::Homography> {
    let (h, v) = (
        warp.horizontal_distortion.clamp(-0.95, 0.95),
        warp.vertical_distortion.clamp(-0.95, 0.95),
    );
    if h == 0.0 && v == 0.0 {
        return None;
    }
    let (cx, cy) = (r.x + r.w / 2.0, r.y + r.h / 2.0);
    let (hw, hh) = (r.w / 2.0, r.h / 2.0);
    // Corner (sx, sy) ∈ {±1}²: its half-height follows the side it is on
    // (horizontal), its half-width the edge (vertical).
    let corner = |sx: f64, sy: f64| {
        let ky = 1.0 + h * sx;
        let kx = 1.0 + v * sy;
        (cx + sx * hw * kx, cy + sy * hh * ky)
    };
    let src = [
        (r.x, r.y),
        (r.x + r.w, r.y),
        (r.x + r.w, r.y + r.h),
        (r.x, r.y + r.h),
    ];
    let dst = [
        corner(-1.0, -1.0),
        corner(1.0, -1.0),
        corner(1.0, 1.0),
        corner(-1.0, 1.0),
    ];
    crate::from_quads(src, dst)
}

/// One style's offset from the centre for the point `(s, t)` of the
/// centred square (`s, t ∈ [−1, 1]`, y down), on a box of half-width `w`
/// and half-height `h`, at `bend` ∈ [−1, 1]. The PRIMARY axis is x.
fn style_offset(style: WarpStyle, bend: f64, s: f64, t: f64, w: f64, h: f64) -> (f64, f64) {
    let b = bend.clamp(-1.0, 1.0);
    let v = (t + 1.0) / 2.0;
    let straight = (s * w, t * h);
    match style {
        WarpStyle::None => straight,
        WarpStyle::Arc => arc(b, s, t, w, h),
        WarpStyle::ArcLower => lerp(straight, arc(b, s, t, w, h), v),
        WarpStyle::ArcUpper => lerp(arc(b, s, t, w, h), straight, v),
        // The whole block bows; its columns stay upright.
        WarpStyle::Arch => (s * w, t * h - b * h * (1.0 - s * s)),
        // Top up and bottom down in the middle (or in, for a negative bend).
        WarpStyle::Bulge => (s * w, t * h * (1.0 + b * (1.0 - s * s))),
        WarpStyle::ShellLower => (s * w, t * h + b * h * (1.0 - s * s) * v),
        WarpStyle::ShellUpper => (s * w, t * h - b * h * (1.0 - s * s) * (1.0 - v)),
        // One period of a sine across the width, every row alike.
        WarpStyle::Flag => (s * w, t * h - b * h * 0.5 * (PI * s).sin()),
        // The flag with a phase that slides from top to bottom.
        WarpStyle::Wave => (s * w, t * h - b * h * 0.5 * (PI * s + t * PI / 4.0).sin()),
        // A body that swells, then a tail that narrows.
        WarpStyle::Fish => {
            let u = (s + 1.0) / 2.0;
            (s * w, t * h * (1.0 + b * 0.5 * (2.0 * PI * u).sin()))
        }
        // The far end rises, the near end sinks.
        WarpStyle::Rise => (s * w, t * h - b * h * (FRAC_PI_2 * s).sin()),
        WarpStyle::FishEye => {
            let r2 = (s * s + t * t) / 2.0;
            let k = 1.0 + b * 0.5 * (1.0 - r2);
            (s * w * k, t * h * k)
        }
        WarpStyle::Inflate => (
            s * w * (1.0 + b * 0.3 * (1.0 - t * t)),
            t * h * (1.0 + b * 0.3 * (1.0 - s * s)),
        ),
        WarpStyle::Squeeze => (
            s * w * (1.0 + b * 0.3 * (1.0 - t * t)),
            t * h * (1.0 - b * 0.5 * (1.0 - s * s)),
        ),
        // A rotation that is strongest at the centre and none at the corners.
        WarpStyle::Twist => {
            let rho = ((s * s + t * t) / 2.0).sqrt().min(1.0);
            let a = b * FRAC_PI_2 * (1.0 - rho);
            let (sn, cs) = a.sin_cos();
            let (x, y) = (s * w, t * h);
            (cs * x - sn * y, sn * x + cs * y)
        }
    }
}

/// The ARC: the box laid along a circle whose centre line keeps its length
/// (the half-width `w`) and spans `bend · 90°` on each side; a positive
/// bend humps upward, a negative one sags.
fn arc(b: f64, s: f64, t: f64, w: f64, h: f64) -> (f64, f64) {
    let phi = b.abs() * FRAC_PI_2;
    if phi < 1e-9 {
        return (s * w, t * h);
    }
    // The upward arc of |b|; a sag is its mirror (of the mirrored point).
    let tt = if b < 0.0 { -t } else { t };
    let radius = w / phi;
    let a = s * phi;
    let r = radius - tt * h;
    let (x, y) = (r * a.sin(), radius - r * a.cos());
    if b < 0.0 {
        (x, -y)
    } else {
        (x, y)
    }
}

fn lerp(a: (f64, f64), b: (f64, f64), t: f64) -> (f64, f64) {
    (a.0 + (b.0 - a.0) * t, a.1 + (b.1 - a.1) * t)
}

/// The interpolating patch through `f` at the sixteen nodes
/// `u, v ∈ {0, ⅓, ⅔, 1}`: control points = `M⁻¹ · P · M⁻ᵀ`, with `M` the
/// Bernstein matrix at the nodes.
fn from_points(f: impl Fn(f64, f64) -> (f64, f64)) -> Mesh {
    let mut p = [[0.0f64; 2]; 16];
    for r in 0..4 {
        for c in 0..4 {
            let (x, y) = f(c as f64 / 3.0, r as f64 / 3.0);
            p[r * 4 + c] = [x, y];
        }
    }
    let m = BERNSTEIN_INVERSE;
    let mut out = [[0.0f64; 2]; 16];
    for r in 0..4 {
        for c in 0..4 {
            let mut acc = [0.0f64; 2];
            for i in 0..4 {
                for k in 0..4 {
                    let w = m[r][i] * m[c][k];
                    acc[0] += w * p[i * 4 + k][0];
                    acc[1] += w * p[i * 4 + k][1];
                }
            }
            out[r * 4 + c] = acc;
        }
    }
    out
}

/// The inverse of `M[k][j] = B_j(k/3)`: `[1 0 0 0; 8 12 6 1 /27; 1 6 12 8
/// /27; 0 0 0 1]⁻¹`, exact in sixths.
const BERNSTEIN_INVERSE: [[f64; 4]; 4] = [
    [1.0, 0.0, 0.0, 0.0],
    [-5.0 / 6.0, 3.0, -3.0 / 2.0, 1.0 / 3.0],
    [1.0 / 3.0, -3.0 / 2.0, 3.0, -5.0 / 6.0],
    [0.0, 0.0, 0.0, 1.0],
];

#[cfg(test)]
mod tests {
    use super::*;

    const R: Rect = Rect {
        x: 10.0,
        y: 20.0,
        w: 200.0,
        h: 60.0,
    };

    fn warp(style: WarpStyle, bend: f64) -> Warp {
        Warp {
            style,
            bend,
            ..Warp::NONE
        }
    }

    #[test]
    fn the_bernstein_inverse_inverts_the_node_matrix() {
        for (k, row) in BERNSTEIN_INVERSE.iter().enumerate() {
            for j in 0..4 {
                let mut acc = 0.0;
                // (M⁻¹ · M)[k][j], with M[i][j] = B_j(i/3).
                for (i, m) in row.iter().enumerate() {
                    acc += m * bernstein(i as f64 / 3.0)[j];
                }
                let want = if j == k { 1.0 } else { 0.0 };
                assert!((acc - want).abs() < 1e-12, "({k},{j}) {acc}");
            }
        }
    }

    #[test]
    fn the_identity_mesh_is_the_rectangle() {
        let m = identity(R);
        for (u, v) in [(0.0, 0.0), (0.3, 0.7), (1.0, 1.0), (0.5, 0.25)] {
            let (x, y) = eval(&m, u, v);
            assert!((x - (R.x + u * R.w)).abs() < 1e-9);
            assert!((y - (R.y + v * R.h)).abs() < 1e-9);
        }
        assert_eq!(mesh(&warp(WarpStyle::Arc, 0.0), R), m);
        assert_eq!(mesh(&Warp::NONE, R), m);
    }

    #[test]
    fn the_patch_passes_through_the_style_at_its_nodes() {
        for style in WarpStyle::ALL {
            let m = mesh(&warp(style, 0.6), R);
            let (cx, cy) = (R.x + R.w / 2.0, R.y + R.h / 2.0);
            for r in 0..4 {
                for c in 0..4 {
                    let (u, v) = (c as f64 / 3.0, r as f64 / 3.0);
                    let (dx, dy) =
                        style_offset(style, 0.6, 2.0 * u - 1.0, 2.0 * v - 1.0, 100.0, 30.0);
                    let (x, y) = eval(&m, u, v);
                    assert!(
                        (x - cx - dx).abs() < 1e-9 && (y - cy - dy).abs() < 1e-9,
                        "{style:?} node ({r},{c})"
                    );
                }
            }
        }
    }

    #[test]
    fn invert_finds_the_source_point_for_every_style() {
        for style in WarpStyle::ALL {
            let m = mesh(&warp(style, 0.5), R);
            for i in 1..8 {
                for k in 1..8 {
                    let (u, v) = (k as f64 / 8.0, i as f64 / 8.0);
                    let p = eval(&m, u, v);
                    let (gu, gv) = invert(&m, p, 0.01)
                        .unwrap_or_else(|| panic!("{style:?} lost ({u},{v})"));
                    let back = eval(&m, gu, gv);
                    assert!(
                        (back.0 - p.0).abs() < 0.01 && (back.1 - p.1).abs() < 0.01,
                        "{style:?} ({u},{v}) → ({gu},{gv})"
                    );
                }
            }
            // Far outside the warped box nothing maps there.
            assert!(invert(&m, (R.x - 500.0, R.y - 500.0), 0.5).is_none());
        }
    }

    #[test]
    fn an_arc_humps_up_and_a_negative_one_sags() {
        let up = mesh(&warp(WarpStyle::Arc, 0.5), R);
        let (_, mid_top) = eval(&up, 0.5, 0.0);
        let (_, corner_top) = eval(&up, 0.0, 0.0);
        assert!(mid_top < corner_top, "the middle of the top edge is higher");
        // The centre line keeps the middle's height (the patch matches
        // the arc exactly at its nodes, and within a pixel between them).
        assert!((eval(&up, 0.5, 0.5).1 - (R.y + R.h / 2.0)).abs() < 1.0);
        let down = mesh(&warp(WarpStyle::Arc, -0.5), R);
        assert!(eval(&down, 0.5, 1.0).1 > eval(&down, 0.0, 1.0).1);
        // A bend grows the box it needs.
        let e = extent(&up);
        assert!(e.h > R.h + 10.0, "{e:?}");
    }

    #[test]
    fn arc_lower_and_upper_keep_the_other_edge_straight() {
        let lower = mesh(&warp(WarpStyle::ArcLower, 0.7), R);
        assert!((eval(&lower, 0.5, 0.0).1 - R.y).abs() < 1e-9);
        assert!((eval(&lower, 0.0, 0.0).1 - R.y).abs() < 1e-9);
        let upper = mesh(&warp(WarpStyle::ArcUpper, 0.7), R);
        assert!((eval(&upper, 0.5, 1.0).1 - (R.y + R.h)).abs() < 1e-9);
    }

    #[test]
    fn vertical_bends_along_the_height() {
        let mut w = warp(WarpStyle::Arch, 0.6);
        let horizontal = mesh(&w, R);
        w.vertical = true;
        let vertical = mesh(&w, R);
        // Horizontal arch moves y in the middle column; vertical moves x
        // in the middle row.
        assert!((eval(&horizontal, 0.5, 0.5).1 - (R.y + R.h / 2.0)).abs() > 1.0);
        assert!((eval(&vertical, 0.5, 0.5).0 - (R.x + R.w / 2.0)).abs() > 1.0);
        assert!((eval(&vertical, 0.5, 0.5).1 - (R.y + R.h / 2.0)).abs() < 1e-9);
    }

    #[test]
    fn a_horizontal_distortion_makes_one_side_taller() {
        let w = Warp {
            horizontal_distortion: 0.5,
            ..Warp::NONE
        };
        let m = mesh(&w, R);
        let left = eval(&m, 0.0, 1.0).1 - eval(&m, 0.0, 0.0).1;
        let right = eval(&m, 1.0, 1.0).1 - eval(&m, 1.0, 0.0).1;
        assert!(right > left * 2.0, "{left} {right}");
    }

    #[test]
    fn names_and_psd_keys_round_trip() {
        for s in WarpStyle::ALL {
            assert_eq!(WarpStyle::from_name(s.name()), Some(s));
            assert_eq!(WarpStyle::from_psd(s.psd_key()), Some(s));
        }
        assert_eq!(WarpStyle::from_name("spiral"), None);
    }
}
