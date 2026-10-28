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

//! gpu↔ref parity and behaviour proofs for `families::distort` (WP5.2):
//! Displace, Polar Coordinates, Ripple, Shear and ZigZag. Each scalar twin
//! mirrors its WGSL module step for step (the pixel-centre sampler, the
//! edge policy, the order of operations), so the declared tolerance is the
//! only slack. The parity tests report `unavailable: GPU adapter` without
//! a device (PAGED_REQUIRE_GPU=1 makes that a failure) — never a silent
//! pass. The shared GPU/compare helpers here are used by filters_render.rs.
#![allow(non_snake_case)]

use half::f16;
use image_conformance::harness::RefTile;
use image_conformance::quantize::{f16_ulp_distance, f32_to_f16_bits};
use image_conformance::Px;
use image_gpu::TileInput;
use image_kernels::families::distort::{
    DistortDisplaceParams, DistortPolarParams, DistortRippleParams, DistortShearParams,
    DistortZigzagParams, DISTORT_DISPLACE, DISTORT_POLAR, DISTORT_RIPPLE, DISTORT_SHEAR,
    DISTORT_ZIGZAG, EDGE_REPEAT, EDGE_WRAP, SHEAR_POINTS, ZIGZAG_AROUND_CENTER,
    ZIGZAG_OUT_FROM_CENTER, ZIGZAG_POND_RIPPLES,
};
use image_kernels::{KernelDef, Tolerance};

// ───────────────────────────── helpers ─────────────────────────────

/// Run `def` once on the test GPU over `inputs` (all at the output size);
/// the f32 texels, row-major. `None` without an adapter.
pub(crate) fn gpu(def: &'static KernelDef, inputs: &[&RefTile], params: &[u8]) -> Option<Vec<Px>> {
    let ctx = image_conformance::device::test_device()?;
    let (w, h) = (inputs[0].w, inputs[0].h);
    let bytes: Vec<Vec<u8>> = inputs.iter().map(|t| t.f16_bytes()).collect();
    let tin: Vec<TileInput<'_>> = bytes.iter().map(|b| TileInput { f16_bytes: b }).collect();
    let out = image_gpu::execute_tile_once(ctx, def, &tin, params, None, w, h).expect("dispatch");
    Some(
        out.as_chunks::<8>()
            .0
            .iter()
            .map(|c| {
                let mut p = [0f32; 4];
                for (k, v) in p.iter_mut().enumerate() {
                    *v = f16::from_bits(u16::from_le_bytes([c[k * 2], c[k * 2 + 1]])).to_f32();
                }
                Px(p)
            })
            .collect(),
    )
}

/// Max f16 ULP distance between the GPU texels and the twin's answer.
pub(crate) fn max_ulp(got: &[Px], w: u32, want: impl Fn(u32, u32) -> Px) -> (u32, usize, usize) {
    let mut worst = (0u32, 0usize, 0usize);
    for (i, g) in got.iter().enumerate() {
        let (x, y) = ((i as u32) % w, (i as u32) / w);
        let wv = want(x, y);
        for c in 0..4 {
            let d = f16_ulp_distance(f32_to_f16_bits(wv.0[c]), f16::from_f32(g.0[c]).to_bits());
            if d > worst.0 {
                worst = (d, i, c);
            }
        }
    }
    worst
}

/// GPU-vs-twin parity held to the kernel's declared tolerance.
pub(crate) fn parity(
    def: &'static KernelDef,
    inputs: &[&RefTile],
    params: &[u8],
    want: impl Fn(u32, u32) -> Px,
) {
    let Some(got) = gpu(def, inputs, params) else {
        eprintln!("unavailable: GPU adapter — {} parity not measured", def.id);
        return;
    };
    let (ulp, at, ch) = max_ulp(&got, inputs[0].w, want);
    let limit = match def.gpu_tolerance {
        Tolerance::ChannelEpsF16(n) => n,
        Tolerance::Exact => 0,
        Tolerance::PerceptualDeltaE(_) => unreachable!("channel tolerances only here"),
    };
    eprintln!("{}: measured max f16 ULP {ulp}", def.id);
    assert!(
        ulp <= limit,
        "{}: max f16 ULP {ulp} exceeds {limit} (texel {at}, channel {ch})",
        def.id
    );
}

/// A smooth, finite stimulus away from 0 (f16 ULPs near zero are tiny,
/// so a stimulus that touches 0 measures noise, not the kernel).
pub(crate) fn stimulus(w: u32, h: u32) -> RefTile {
    RefTile::from_fn(w, h, |x, y| {
        let (xf, yf) = (x as f32, y as f32);
        Px([
            0.2 + 0.6 * (0.5 + 0.5 * (xf * 0.21 + yf * 0.07).sin()),
            0.2 + 0.6 * (0.5 + 0.5 * (yf * 0.17 - xf * 0.05).cos()),
            0.3 + 0.5 * ((x + y) as f32 / (w + h) as f32),
            1.0,
        ])
    })
}

/// WGSL `mix` per its definition, `a·(1−t) + b·t`.
fn mixf(a: Px, b: Px, t: f32) -> Px {
    Px([0, 1, 2, 3].map(|c| a.0[c] * (1.0 - t) + b.0[c] * t))
}

/// The modules' `fetch`: an edge policy per axis.
fn fetch(win: &[Px], w: u32, h: u32, x: i32, y: i32, wrap_x: bool, wrap_y: bool) -> Px {
    let (wi, hi) = (w as i32, h as i32);
    let qx = if wrap_x {
        ((x % wi) + wi) % wi
    } else {
        x.clamp(0, wi - 1)
    };
    let qy = if wrap_y {
        ((y % hi) + hi) % hi
    } else {
        y.clamp(0, hi - 1)
    };
    win[(qy * wi + qx) as usize]
}

/// The modules' pixel-centre bilinear `sample`.
#[allow(clippy::too_many_arguments)]
fn sample(win: &[Px], w: u32, h: u32, sx: f32, sy: f32, wrap_x: bool, wrap_y: bool) -> Px {
    let (px, py) = (sx - 0.5, sy - 0.5);
    let (fx0, fy0) = (px.floor(), py.floor());
    let (fx, fy) = (px - fx0, py - fy0);
    let (ix, iy) = (fx0 as i32, fy0 as i32);
    let p00 = fetch(win, w, h, ix, iy, wrap_x, wrap_y);
    let p10 = fetch(win, w, h, ix + 1, iy, wrap_x, wrap_y);
    let p01 = fetch(win, w, h, ix, iy + 1, wrap_x, wrap_y);
    let p11 = fetch(win, w, h, ix + 1, iy + 1, wrap_x, wrap_y);
    mixf(mixf(p00, p10, fx), mixf(p01, p11, fx), fy)
}

fn bits(got: &[Px]) -> Vec<[u16; 4]> {
    got.iter()
        .map(|p| p.0.map(|c| f16::from_f32(c).to_bits()))
        .collect()
}

const W: u32 = 48;
const H: u32 = 40;
const TAU: f32 = std::f32::consts::TAU;

// ───────────────────────────── displace ────────────────────────────

fn displace_ref(win: &[Px], map: &[Px], p: &DistortDisplaceParams, x: u32, y: u32) -> Px {
    let mw = p.map_w.max(1);
    let mh = p.map_h.max(1);
    let mv = map[((y % mh) * W + (x % mw)) as usize];
    let (mut mx, mut my) = (0.5, 0.5);
    if mv.0[3] > 0.0 {
        mx = mv.0[0] / mv.0[3];
        my = mv.0[1] / mv.0[3];
    }
    let ox = (mx - 0.5) * 2.0 * p.scale_x;
    let oy = (my - 0.5) * 2.0 * p.scale_y;
    let wrap = p.edge == EDGE_WRAP;
    sample(
        win,
        W,
        H,
        x as f32 + 0.5 + ox,
        y as f32 + 0.5 + oy,
        wrap,
        wrap,
    )
}

/// A smooth map tiled at 20×16 inside the zero-padded 48×40 input.
fn map_tile() -> RefTile {
    RefTile::from_fn(W, H, |x, y| {
        if x >= 20 || y >= 16 {
            return Px([0.0; 4]);
        }
        Px([
            0.5 + 0.4 * (x as f32 * 0.31).sin(),
            0.5 + 0.4 * (y as f32 * 0.39).cos(),
            0.5,
            1.0,
        ])
    })
}

#[test]
fn distort_displace_parity__feat__image_editor_filters() {
    let img = stimulus(W, H);
    let map = map_tile();
    let (q, mq) = (img.quantized_px(), map.quantized_px());
    for edge in [EDGE_WRAP, EDGE_REPEAT] {
        let p = DistortDisplaceParams::new(20, 16, 6.5, -4.25, edge);
        parity(&DISTORT_DISPLACE, &[&img, &map], p.as_bytes(), |x, y| {
            displace_ref(&q, &mq, &p, x, y)
        });
    }
}

#[test]
fn distort_displace_grey_map_is_the_identity__feat__image_editor_filters() {
    let img = stimulus(W, H);
    let grey = RefTile::from_fn(W, H, |_, _| Px([0.5, 0.5, 0.5, 1.0]));
    let p = DistortDisplaceParams::new(W, H, 30.0, 30.0, EDGE_WRAP);
    let Some(got) = gpu(&DISTORT_DISPLACE, &[&img, &grey], p.as_bytes()) else {
        eprintln!("unavailable: GPU adapter");
        return;
    };
    assert_eq!(bits(&got), bits(&img.quantized_px()));
}

#[test]
fn distort_displace_white_red_shifts_by_the_scale__feat__image_editor_filters() {
    // R = 1 (full right pull), G = 0.5 (no vertical): out(x) = in(x + 4), wrapped.
    let img = stimulus(W, H);
    let map = RefTile::from_fn(W, H, |_, _| Px([1.0, 0.5, 0.5, 1.0]));
    let p = DistortDisplaceParams::new(W, H, 4.0, 9.0, EDGE_WRAP);
    let Some(got) = gpu(&DISTORT_DISPLACE, &[&img, &map], p.as_bytes()) else {
        eprintln!("unavailable: GPU adapter");
        return;
    };
    let q = img.quantized_px();
    for y in 0..H {
        for x in 0..W {
            let want = q[(y * W + (x + 4) % W) as usize];
            assert_eq!(
                bits(&[got[(y * W + x) as usize]]),
                bits(&[want]),
                "texel ({x},{y})"
            );
        }
    }
}

// ────────────────────────────── polar ──────────────────────────────

fn polar_ref(win: &[Px], to_polar: bool, x: u32, y: u32) -> Px {
    let (w, h) = (W as f32, H as f32);
    let (hw, hh) = (w * 0.5, h * 0.5);
    let (px, py) = (x as f32 + 0.5, y as f32 + 0.5);
    let (sx, sy) = if to_polar {
        let u = (px - hw) / hw;
        let v = (py - hh) / hh;
        let r = (u * u + v * v).sqrt();
        let mut th = u.atan2(-v);
        if th < 0.0 {
            th += TAU;
        }
        ((1.0 - th / TAU) * w, r * h)
    } else {
        let th = (1.0 - px / w) * TAU;
        let r = py / h;
        (hw + r * th.sin() * hw, hh - r * th.cos() * hh)
    };
    sample(win, W, H, sx, sy, to_polar, false)
}

#[test]
fn distort_polar_parity_both_ways__feat__image_editor_filters() {
    let img = stimulus(W, H);
    let q = img.quantized_px();
    for to_polar in [true, false] {
        let p = DistortPolarParams::new(to_polar);
        parity(&DISTORT_POLAR, &[&img], p.as_bytes(), |x, y| {
            polar_ref(&q, to_polar, x, y)
        });
    }
}

#[test]
fn distort_polar_rows_become_rings__feat__image_editor_filters() {
    // Square canvas, value by row only: rectangular → polar makes the
    // value a function of the radius alone (rows are rings).
    let n = 64u32;
    let rows = RefTile::from_fn(n, n, |_, y| {
        let v = 0.2 + 0.6 * y as f32 / n as f32;
        Px([v, v, v, 1.0])
    });
    let p = DistortPolarParams::new(true);
    let Some(got) = gpu(&DISTORT_POLAR, &[&rows], p.as_bytes()) else {
        eprintln!("unavailable: GPU adapter");
        return;
    };
    let at = |x: u32, y: u32| got[(y * n + x) as usize].0[0];
    // Four points at the same radius (16 px) on the four axes.
    let c = n / 2;
    let ring = [at(c + 16, c), at(c - 17, c), at(c, c + 16), at(c, c - 17)];
    for v in ring {
        assert!((v - ring[0]).abs() < 0.02, "a ring is one value: {ring:?}");
    }
    // Further out is brighter (later rows).
    assert!(at(c + 28, c) > at(c + 8, c) + 0.1);
}

// ────────────────────────────── ripple ─────────────────────────────

fn ripple_ref(win: &[Px], p: &DistortRippleParams, x: u32, y: u32) -> Px {
    let l = p.wavelength.max(1.0);
    let amp = p.amount * 0.01 * l * 0.25;
    let (px, py) = (x as f32 + 0.5, y as f32 + 0.5);
    let dx = amp * (0.75 * (TAU * py / l).sin() + 0.25 * (TAU * py / (1.7 * l) + 1.3).sin());
    let dy = amp * (0.75 * (TAU * px / l).sin() + 0.25 * (TAU * px / (1.7 * l) + 2.1).sin());
    sample(win, W, H, px + dx, py + dy, false, false)
}

#[test]
fn distort_ripple_parity__feat__image_editor_filters() {
    let img = stimulus(W, H);
    let q = img.quantized_px();
    for (amount, size) in [(100.0, 1u32), (-250.0, 0), (60.0, 2)] {
        let p = DistortRippleParams::new(amount, size);
        parity(&DISTORT_RIPPLE, &[&img], p.as_bytes(), |x, y| {
            ripple_ref(&q, &p, x, y)
        });
    }
}

#[test]
fn distort_ripple_zero_is_the_identity_and_waves_stay_in_range__feat__image_editor_filters() {
    let img = stimulus(W, H);
    let q = img.quantized_px();
    let zero = DistortRippleParams::new(0.0, 1);
    let Some(got) = gpu(&DISTORT_RIPPLE, &[&img], zero.as_bytes()) else {
        eprintln!("unavailable: GPU adapter");
        return;
    };
    assert_eq!(bits(&got), bits(&q));
    let p = DistortRippleParams::new(300.0, 1);
    let got = gpu(&DISTORT_RIPPLE, &[&img], p.as_bytes()).expect("device");
    assert_ne!(bits(&got), bits(&q), "a ripple moves pixels");
    // A resampling of the input never leaves its range.
    for c in 0..3 {
        let lo = q.iter().map(|p| p.0[c]).fold(f32::MAX, f32::min);
        let hi = q.iter().map(|p| p.0[c]).fold(f32::MIN, f32::max);
        assert!(got
            .iter()
            .all(|p| p.0[c] >= lo - 1e-3 && p.0[c] <= hi + 1e-3));
    }
}

// ────────────────────────────── shear ──────────────────────────────

fn shear_ref(win: &[Px], p: &DistortShearParams, x: u32, y: u32) -> Px {
    let py = y as f32 + 0.5;
    let t = py / H as f32 * 15.0;
    let i0 = t.floor();
    let f = t - i0;
    let i = i0 as i32;
    let (p0, p1, p2, p3) = (p.point(i - 1), p.point(i), p.point(i + 1), p.point(i + 2));
    let f2 = f * f;
    let f3 = f2 * f;
    let off = 0.5
        * (2.0 * p1
            + (p2 - p0) * f
            + (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * f2
            + (3.0 * p1 - p0 - 3.0 * p2 + p3) * f3);
    sample(
        win,
        W,
        H,
        x as f32 + 0.5 - off,
        py,
        p.edge == EDGE_WRAP,
        false,
    )
}

#[test]
fn distort_shear_parity__feat__image_editor_filters() {
    let img = stimulus(W, H);
    let q = img.quantized_px();
    let mut curve = [0.0f32; SHEAR_POINTS];
    for (i, v) in curve.iter_mut().enumerate() {
        *v = 9.0 * (i as f32 * 0.5).sin() - 2.5;
    }
    for wrap in [true, false] {
        let p = DistortShearParams::new(curve, wrap);
        parity(&DISTORT_SHEAR, &[&img], p.as_bytes(), |x, y| {
            shear_ref(&q, &p, x, y)
        });
    }
}

#[test]
fn distort_shear_flat_curve_translates_and_zero_is_the_identity__feat__image_editor_filters() {
    let img = stimulus(W, H);
    let q = img.quantized_px();
    let zero = DistortShearParams::new([0.0; SHEAR_POINTS], true);
    let Some(got) = gpu(&DISTORT_SHEAR, &[&img], zero.as_bytes()) else {
        eprintln!("unavailable: GPU adapter");
        return;
    };
    assert_eq!(bits(&got), bits(&q));
    let five = DistortShearParams::new([5.0; SHEAR_POINTS], true);
    let got = gpu(&DISTORT_SHEAR, &[&img], five.as_bytes()).expect("device");
    for y in 0..H {
        for x in 0..W {
            let want = q[(y * W + (x + W - 5) % W) as usize];
            assert_eq!(bits(&[got[(y * W + x) as usize]]), bits(&[want]));
        }
    }
}

// ───────────────────────────── zigzag ──────────────────────────────

fn zigzag_ref(win: &[Px], p: &DistortZigzagParams, x: u32, y: u32) -> Px {
    let c = (W as f32 * 0.5, H as f32 * 0.5);
    let big_r = c.0.min(c.1);
    let pp = (x as f32 + 0.5, y as f32 + 0.5);
    let dv = (pp.0 - c.0, pp.1 - c.1);
    let r = (dv.0 * dv.0 + dv.1 * dv.1).sqrt();
    let mut s = pp;
    if p.amount != 0.0 && r > 0.0 && r < big_r {
        let t = r / big_r;
        let fall = 1.0 - t;
        let wave = (TAU * p.ridges * t).sin() * fall * p.amount * 0.01;
        let mut ang = 0.0f32;
        let mut rr = r;
        if p.style != 1 {
            ang = wave * 0.5;
        }
        if p.style != 0 {
            rr = r + wave * big_r / (2.0 * p.ridges.max(1.0));
        }
        let k = rr / r;
        let (sn, cs) = (ang.sin(), ang.cos());
        let q = ((cs * dv.0 - sn * dv.1) * k, (sn * dv.0 + cs * dv.1) * k);
        s = (c.0 + q.0, c.1 + q.1);
    }
    sample(win, W, H, s.0, s.1, false, false)
}

#[test]
fn distort_zigzag_parity_every_style__feat__image_editor_filters() {
    let img = stimulus(W, H);
    let q = img.quantized_px();
    for style in [
        ZIGZAG_AROUND_CENTER,
        ZIGZAG_OUT_FROM_CENTER,
        ZIGZAG_POND_RIPPLES,
    ] {
        let p = DistortZigzagParams::new(70.0, 5.0, style);
        parity(&DISTORT_ZIGZAG, &[&img], p.as_bytes(), |x, y| {
            zigzag_ref(&q, &p, x, y)
        });
    }
}

#[test]
fn distort_zigzag_zero_is_identity_and_corners_stay__feat__image_editor_filters() {
    let img = stimulus(W, H);
    let q = img.quantized_px();
    let zero = DistortZigzagParams::new(0.0, 5.0, ZIGZAG_POND_RIPPLES);
    let Some(got) = gpu(&DISTORT_ZIGZAG, &[&img], zero.as_bytes()) else {
        eprintln!("unavailable: GPU adapter");
        return;
    };
    assert_eq!(bits(&got), bits(&q));
    let p = DistortZigzagParams::new(100.0, 6.0, ZIGZAG_POND_RIPPLES);
    let got = gpu(&DISTORT_ZIGZAG, &[&img], p.as_bytes()).expect("device");
    assert_ne!(bits(&got), bits(&q));
    // Outside the inscribed circle nothing moves.
    for (x, y) in [(0, 0), (W - 1, 0), (0, H - 1), (W - 1, H - 1), (2, 3)] {
        let i = (y * W + x) as usize;
        assert_eq!(bits(&[got[i]]), bits(&[q[i]]), "corner ({x},{y})");
    }
}
