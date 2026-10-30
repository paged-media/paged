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

// ─────────────────────────── warp_field ─────────────────────────────
//
// `geom.warp_field` (WP5.6, image ADR 483): the displacement-field warp of
// Liquify and Puppet Warp. The scalar twin reads the SAME packed window
// the GPU does (source above, the field's nodes below or beside it, each
// node as an f16 integer part and fraction), so the lanes differ only in
// the f32 rounding of the blend and the taps.
//
// feat: geom.warp_field (registry/kernels.yaml), image.editor.transform-warp.

use image_kernels::families::warp::{WarpFieldParams, GEOM_WARP_FIELD};
use paged_warp::field::{Brush, Field, Liquify, LiquifyTool};
use paged_warp::puppet::{self, Pin, PuppetMesh, PuppetMode};

/// Pack `src` and `field` into one window the way image-js does.
fn pack_field(src: &RefTile, field: &Field, interp: u32) -> (RefTile, WarpFieldParams) {
    let (mut p, ww, wh) =
        WarpFieldParams::layout(src.w, src.h, field.cols, field.rows, field.step, 8192)
            .expect("fits");
    p.interp = interp;
    let win = RefTile::from_fn(ww, wh, |x, y| {
        if x < src.w && y < src.h {
            return src.px[(y * src.w + x) as usize];
        }
        let (i, j) = (x.wrapping_sub(p.field_x), y.wrapping_sub(p.field_y));
        if x >= p.field_x && y >= p.field_y && i < field.cols && j < field.rows {
            let d = field.d[(j * field.cols + i) as usize];
            return Px(WarpFieldParams::encode_node(d[0], d[1]));
        }
        Px([0.0; 4])
    });
    (win, p)
}

fn cr(t: f32) -> [f32; 4] {
    let t2 = t * t;
    let t3 = t2 * t;
    [
        -0.5 * t3 + t2 - 0.5 * t,
        1.5 * t3 - 2.5 * t2 + 1.0,
        -1.5 * t3 + 2.0 * t2 + 0.5 * t,
        0.5 * t3 - 0.5 * t2,
    ]
}

/// The scalar twin of `geom.warp_field` (unmasked lane).
fn warp_field_ref(
    win: &[Px],
    win_w: u32,
    _win_h: u32,
    ox: u32,
    oy: u32,
    p: &WarpFieldParams,
) -> Px {
    let node = |i: i32, j: i32| -> Px {
        let ci = i.clamp(0, p.cols as i32 - 1) as u32;
        let cj = j.clamp(0, p.rows as i32 - 1) as u32;
        win[((p.field_y + cj) * win_w + p.field_x + ci) as usize]
    };
    let src = |x: i32, y: i32| -> Px {
        if x < 0 || y < 0 || x >= p.src_w as i32 || y >= p.src_h as i32 {
            return Px([0.0; 4]);
        }
        win[(y as u32 * win_w + x as u32) as usize]
    };
    let gx = (ox as f32 / p.step).clamp(0.0, (p.cols - 1) as f32);
    let gy = (oy as f32 / p.step).clamp(0.0, (p.rows - 1) as f32);
    let (g0x, g0y) = (gx.floor(), gy.floor());
    let (fx, fy) = (gx - g0x, gy - g0y);
    let (i, j) = (g0x as i32, g0y as i32);
    let n = [
        node(i, j),
        node(i + 1, j),
        node(i, j + 1),
        node(i + 1, j + 1),
    ];
    if n.iter().any(|v| v.0[0] >= 20000.0) {
        return Px([0.0; 4]);
    }
    let d = |v: &Px| [v.0[0] + v.0[1], v.0[2] + v.0[3]];
    let mx =
        |a: [f32; 2], b: [f32; 2], t: f32| [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    let dd = mx(mx(d(&n[0]), d(&n[1]), fx), mx(d(&n[2]), d(&n[3]), fx), fy);
    let (sx, sy) = (ox as f32 + dd[0], oy as f32 + dd[1]);
    let (x0, y0) = (sx.floor(), sy.floor());
    let (tx, ty) = (sx - x0, sy - y0);
    let (ix, iy) = (x0 as i32, y0 as i32);
    if p.interp == 1 {
        let (wx, wy) = (cr(tx), cr(ty));
        let mut acc = [0f32; 4];
        for (r, wyr) in wy.iter().enumerate() {
            let mut row = [0f32; 4];
            for (c, wxc) in wx.iter().enumerate() {
                let t = src(ix - 1 + c as i32, iy - 1 + r as i32);
                for (r, v) in row.iter_mut().zip(t.0) {
                    *r += v * wxc;
                }
            }
            for (a, r) in acc.iter_mut().zip(row) {
                *a += r * wyr;
            }
        }
        let a = acc[3].clamp(0.0, 1.0);
        return Px([
            acc[0].clamp(0.0, a),
            acc[1].clamp(0.0, a),
            acc[2].clamp(0.0, a),
            a,
        ]);
    }
    lerp(
        lerp(src(ix, iy), src(ix + 1, iy), tx),
        lerp(src(ix, iy + 1), src(ix + 1, iy + 1), tx),
        ty,
    )
}

fn liquified(w: u32, h: u32) -> Field {
    let mut l = Liquify::new(w, h, 16);
    let b = Brush {
        size: 14.0,
        pressure: 1.0,
        density: 0.5,
        rate: 1.0,
    };
    l.stroke(LiquifyTool::ForwardWarp, &b, &[(8.0, 10.0), (20.0, 12.0)]);
    l.stroke(LiquifyTool::TwirlClockwise, &b, &[(26.0, 8.0), (27.0, 9.0)]);
    l.stroke(LiquifyTool::Bloat, &b, &[(12.0, 4.0)]);
    l.field
}

#[test]
#[allow(non_snake_case)]
fn geom_warp_field_identity_is_a_passthrough__feat__image_editor_transform_warp() {
    let (w, h) = (24u32, 16u32);
    let src = stimulus(w, h);
    let (win, p) = pack_field(&src, &Field::new(w, h, 4), 1);
    let q = win.quantized_px();
    for y in 0..h {
        for x in 0..w {
            let got = warp_field_ref(&q, win.w, win.h, x, y, &p);
            let want = q[(y * win.w + x) as usize];
            for c in 0..4 {
                assert!((got.0[c] - want.0[c]).abs() < 1e-4, "({x},{y})");
            }
        }
    }
}

#[test]
#[allow(non_snake_case)]
fn geom_warp_field_reads_the_displaced_source_and_nothing_where_none__feat__image_editor_transform_warp(
) {
    let (w, h) = (20u32, 12u32);
    let src = stimulus(w, h);
    let mut f = Field::new(w, h, 1);
    for v in &mut f.d {
        *v = [3.0, -2.0];
    }
    f.d[5 * 20 + 7] = [f32::NAN; 2];
    let (win, p) = pack_field(&src, &f, 0);
    let q = win.quantized_px();
    let got = warp_field_ref(&q, win.w, win.h, 4, 6, &p);
    let want = q[(4 * win.w + 7) as usize];
    assert!((got.0[0] - want.0[0]).abs() < 1e-4, "reads (7, 4)");
    assert_eq!(warp_field_ref(&q, win.w, win.h, 7, 5, &p).0, [0.0; 4]);
    // Off the source's right edge: transparent.
    assert_eq!(warp_field_ref(&q, win.w, win.h, 18, 6, &p).0, [0.0; 4]);
}

fn field_parity(field: &Field, w: u32, h: u32, interp: u32, what: &str) {
    let src = stimulus(w, h);
    let (win, p) = pack_field(&src, field, interp);
    match parity_windowed(&GEOM_WARP_FIELD, warp_field_ref, &win, w, h, &p) {
        Some(r) => {
            eprintln!("geom.warp_field[{what}]: max f16 ULP {}", r.max_ulp);
            assert_within(r, &GEOM_WARP_FIELD);
        }
        None => eprintln!("unavailable: GPU adapter: geom.warp_field parity"),
    }
}

#[test]
#[allow(non_snake_case)]
fn geom_warp_field_parity_liquify__feat__image_editor_transform_warp() {
    let f = liquified(36, 20);
    field_parity(&f, 36, 20, 0, "liquify bilinear");
    field_parity(&f, 36, 20, 1, "liquify bicubic");
}

#[test]
#[allow(non_snake_case)]
fn geom_warp_field_parity_puppet__feat__image_editor_transform_warp() {
    let (w, h) = (40u32, 24u32);
    let alpha = vec![255u8; (w * h) as usize];
    let mesh = PuppetMesh::from_alpha(&alpha, w, h, 6.0, 0.0, 0);
    let pins = [
        Pin {
            at: [0.0, 12.0],
            to: [0.0, 12.0],
        },
        Pin {
            at: [40.0, 12.0],
            to: [36.0, 4.0],
        },
    ];
    let bent = puppet::solve(&mesh, &pins, PuppetMode::Rigid);
    let f = puppet::backward_field(&mesh, &bent, w, h);
    field_parity(&f, w, h, 1, "puppet bicubic");
}

/// The CPU twin (paged-resample's `warp_map_rgba8` through the field)
/// agrees with the kernel's scalar twin within the 8-bit rounding.
#[test]
#[allow(non_snake_case)]
fn geom_warp_field_cpu_twin_agrees__feat__image_editor_transform_warp() {
    let (w, h) = (36u32, 20u32);
    let f = liquified(w, h);
    let rgba: Vec<u8> = (0..w * h)
        .flat_map(|i| {
            let (x, y) = (i % w, i / w);
            [(x * 7) as u8, (y * 12) as u8, ((x * y) % 255) as u8, 255]
        })
        .collect();
    let src = RefTile::from_fn(w, h, |x, y| {
        let i = ((y * w + x) * 4) as usize;
        Px(std::array::from_fn(|c| f32::from(rgba[i + c]) / 255.0))
    });
    let (win, p) = pack_field(&src, &f, 1);
    let q = win.quantized_px();
    let cpu = paged_resample::warp_map_rgba8(
        &rgba,
        w,
        h,
        paged_resample::Window { x: 0, y: 0, w, h },
        paged_resample::WarpFilter::Bicubic,
        |x, y| f.source(x - 0.5, y - 0.5),
    )
    .unwrap();
    let mut worst = 0f32;
    for y in 0..h {
        for x in 0..w {
            let r = warp_field_ref(&q, win.w, win.h, x, y, &p);
            let i = ((y * w + x) * 4) as usize;
            for c in 0..4 {
                worst = worst.max((r.0[c] * 255.0 - f32::from(cpu[i + c])).abs());
            }
        }
    }
    assert!(worst <= 2.0, "worst {worst} levels");
}
