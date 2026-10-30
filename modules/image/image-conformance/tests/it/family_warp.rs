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

//! gpu↔ref parity for `geom.warp_mesh` (WP5.10): the envelope warp a type
//! layer's Warp Text runs through. The scalar twin below mirrors the WGSL
//! term for term — the 9 × 9 seed, ten Newton steps with the same clamp,
//! the half-pixel residual test, the transparent-outside bilinear taps — so
//! the two lanes differ only where the GPU contracts the f32 sums.
//!
//! feat: geom.warp_mesh (registry/kernels.yaml), image.layers.type.

use image_conformance::harness::{assert_within, parity_windowed, RefTile};
use image_conformance::Px;
use image_kernels::families::warp::{WarpMeshParams, GEOM_WARP_MESH};
use paged_warp::envelope::{self, Rect, Warp, WarpStyle};

/// A smooth, premultiplied, opaque stimulus (the caller associates alpha).
fn stimulus(w: u32, h: u32) -> RefTile {
    RefTile::from_fn(w, h, |x, y| {
        Px([
            0.2 + 0.6 * x as f32 / w as f32,
            0.3 + 0.4 * y as f32 / h as f32,
            0.5,
            1.0,
        ])
    })
}

fn bern(t: f32) -> [f32; 4] {
    let s = 1.0 - t;
    [s * s * s, 3.0 * s * s * t, 3.0 * s * t * t, t * t * t]
}

fn bern_d(t: f32) -> [f32; 4] {
    let s = 1.0 - t;
    [
        -3.0 * s * s,
        3.0 * s * s - 6.0 * s * t,
        6.0 * s * t - 3.0 * t * t,
        3.0 * t * t,
    ]
}

fn ctrl(p: &WarpMeshParams) -> [[f32; 2]; 16] {
    std::array::from_fn(|i| [p.c[2 * i], p.c[2 * i + 1]])
}

fn patch(c: &[[f32; 2]; 16], bu: [f32; 4], bv: [f32; 4]) -> [f32; 2] {
    let mut q = [0.0f32; 2];
    for r in 0..4 {
        for s in 0..4 {
            let w = bv[r] * bu[s];
            q[0] += c[r * 4 + s][0] * w;
            q[1] += c[r * 4 + s][1] * w;
        }
    }
    q
}

fn tap(win: &[Px], w: u32, h: u32, x: i32, y: i32) -> Px {
    if x < 0 || y < 0 || x >= w as i32 || y >= h as i32 {
        return Px([0.0; 4]);
    }
    win[(y as u32 * w + x as u32) as usize]
}

fn lerp(a: Px, b: Px, t: f32) -> Px {
    Px(std::array::from_fn(|c| a.0[c] + t * (b.0[c] - a.0[c])))
}

/// The scalar twin of `geom.warp_mesh`.
fn warp_mesh_ref(win: &[Px], win_w: u32, win_h: u32, ox: u32, oy: u32, p: &WarpMeshParams) -> Px {
    let c = ctrl(p);
    let pt = [ox as f32 + 0.5, oy as f32 + 0.5];
    let mut best = [0.5f32, 0.5];
    let mut best_d = 3.0e38f32;
    for i in 0..=8 {
        let bv = bern(i as f32 / 8.0);
        for k in 0..=8 {
            let bu = bern(k as f32 / 8.0);
            let q = patch(&c, bu, bv);
            let e = [q[0] - pt[0], q[1] - pt[1]];
            let d = e[0] * e[0] + e[1] * e[1];
            if d < best_d {
                best_d = d;
                best = [k as f32 / 8.0, i as f32 / 8.0];
            }
        }
    }
    let mut uv = best;
    for _ in 0..10 {
        let (bu, bv, du, dv) = (bern(uv[0]), bern(uv[1]), bern_d(uv[0]), bern_d(uv[1]));
        let mut q = [0.0f32; 2];
        let mut ju = [0.0f32; 2];
        let mut jv = [0.0f32; 2];
        for r in 0..4 {
            for s in 0..4 {
                let cp = c[r * 4 + s];
                for a in 0..2 {
                    q[a] += cp[a] * (bv[r] * bu[s]);
                    ju[a] += cp[a] * (bv[r] * du[s]);
                    jv[a] += cp[a] * (dv[r] * bu[s]);
                }
            }
        }
        let err = [q[0] - pt[0], q[1] - pt[1]];
        let det = ju[0] * jv[1] - jv[0] * ju[1];
        if det.abs() < 1.0e-12 {
            break;
        }
        let su = (jv[1] * err[0] - jv[0] * err[1]) / det;
        let sv = (-ju[1] * err[0] + ju[0] * err[1]) / det;
        uv = [
            (uv[0] - su).clamp(-0.25, 1.25),
            (uv[1] - sv).clamp(-0.25, 1.25),
        ];
    }
    let q = patch(&c, bern(uv[0]), bern(uv[1]));
    let e = [q[0] - pt[0], q[1] - pt[1]];
    if e[0] * e[0] + e[1] * e[1] > 0.25 {
        return Px([0.0; 4]);
    }
    let snap = |v: f32| {
        if (v - v.round()).abs() < 1.0e-3 {
            v.round()
        } else {
            v
        }
    };
    let sx = snap(uv[0] * p.src_w - 0.5);
    let sy = snap(uv[1] * p.src_h - 0.5);
    let (x0, y0) = (sx.floor(), sy.floor());
    let (fx, fy) = (sx - x0, sy - y0);
    let (ix, iy) = (x0 as i32, y0 as i32);
    let t = |x: i32, y: i32| tap(win, win_w, win_h, x, y);
    lerp(
        lerp(t(ix, iy), t(ix + 1, iy), fx),
        lerp(t(ix, iy + 1), t(ix + 1, iy + 1), fx),
        fy,
    )
}

/// The mesh of `style` at `bend` over a `w × h` source, moved so its
/// extent starts at the output origin, and that extent's size.
fn placed(style: WarpStyle, bend: f64, w: u32, h: u32) -> (WarpMeshParams, u32, u32) {
    let rect = Rect {
        x: 0.0,
        y: 0.0,
        w: f64::from(w),
        h: f64::from(h),
    };
    let warp = Warp {
        style,
        bend,
        ..Warp::NONE
    };
    let mut m = envelope::mesh(&warp, rect);
    let e = envelope::extent(&m);
    for p in &mut m {
        p[0] -= e.x.floor();
        p[1] -= e.y.floor();
    }
    let ow = (e.x + e.w).ceil() - e.x.floor();
    let oh = (e.y + e.h).ceil() - e.y.floor();
    (WarpMeshParams::new(&m, w, h), ow as u32, oh as u32)
}

#[test]
#[allow(non_snake_case)]
fn geom_warp_mesh_identity_is_a_passthrough__feat__image_layers_type() {
    let (w, h) = (24u32, 16u32);
    let px = stimulus(w, h).quantized_px();
    let p = WarpMeshParams::identity(w, h);
    for y in 0..h {
        for x in 0..w {
            let got = warp_mesh_ref(&px, w, h, x, y, &p);
            let want = px[(y * w + x) as usize];
            for ch in 0..4 {
                assert!(
                    (got.0[ch] - want.0[ch]).abs() < 1e-4,
                    "({x},{y}) ch{ch}: {} vs {}",
                    got.0[ch],
                    want.0[ch]
                );
            }
        }
    }
}

#[test]
#[allow(non_snake_case)]
fn geom_warp_mesh_bends_the_source_and_clears_outside__feat__image_layers_type() {
    let (w, h) = (48u32, 16u32);
    let px = stimulus(w, h).quantized_px();
    let (p, ow, oh) = placed(WarpStyle::Arc, 0.6, w, h);
    assert!(oh > h, "an arc needs more height: {oh}");
    // The ends of an upward arc drop: the bottom corners of the output
    // hold the source's ends, its top corners nothing.
    let corner = warp_mesh_ref(&px, w, h, 0, 0, &p);
    assert_eq!(corner.0, [0.0; 4], "top-left corner is outside the arc");
    let middle_top = warp_mesh_ref(&px, w, h, ow / 2, 1, &p);
    assert!(
        middle_top.0[3] > 0.5,
        "the hump reaches the top: {middle_top:?}"
    );
}

fn parity_for(style: WarpStyle, bend: f64) {
    let (w, h) = (48u32, 20u32);
    let win = stimulus(w, h);
    let (p, ow, oh) = placed(style, bend, w, h);
    match parity_windowed(&GEOM_WARP_MESH, warp_mesh_ref, &win, ow, oh, &p) {
        Some(r) => {
            eprintln!("geom.warp_mesh[{style:?}]: max f16 ULP {}", r.max_ulp);
            assert_within(r, &GEOM_WARP_MESH);
        }
        None => eprintln!("unavailable: GPU adapter: geom.warp_mesh parity"),
    }
}

#[test]
#[allow(non_snake_case)]
fn geom_warp_mesh_parity_every_style__feat__image_layers_type() {
    for style in WarpStyle::ALL {
        parity_for(style, 0.5);
    }
}

#[test]
fn geom_warp_mesh_parity_negative_bend() {
    parity_for(WarpStyle::Arc, -0.7);
    parity_for(WarpStyle::Twist, -0.5);
}
