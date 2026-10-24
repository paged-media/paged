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

//! gpu↔ref parity and behaviour proofs for the filter-dialog kernels
//! (WP5.2): `morph.dilate_r` / `morph.erode_r` / `rank.median_r` (Maximum,
//! Minimum and Median with a radius), `conv.box_r` (Box Blur),
//! `conv.surface` (Surface Blur), `conv.high_pass` (High Pass) and
//! `gen.add_noise` (Add Noise). Each scalar twin below mirrors its WGSL
//! module step for step — tap order, clamping, the bisection schedule,
//! the PCG stream — so the declared tolerance is the only slack.
//!
//! The parity tests fail without an adapter under `PAGED_REQUIRE_GPU=1`
//! and report `unavailable: GPU adapter` otherwise (never a silent pass).
//! Test names carry their cockpit feature (`__feat__<id>`).
#![allow(non_snake_case)]

use half::f16;
use image_conformance::harness::{assert_within, parity_windowed, RefTile};
use image_conformance::quantize::{f16_ulp_distance, f32_to_f16_bits};
use image_conformance::Px;
use image_kernels::families::conv::{
    ConvBoxRadiusParams, ConvHighPassParams, ConvSurfaceParams, CONV_BOX_R, CONV_HIGH_PASS,
    CONV_SURFACE,
};
use image_kernels::families::gen::{GenAddNoiseParams, GEN_ADD_NOISE};
use image_kernels::families::morph::{
    MorphRadiusParams, MEDIAN_BISECTION_STEPS, MORPH_DILATE_R, MORPH_ERODE_R, RANK_MEDIAN_R,
};
use image_kernels::{KernelClass, KernelDef, Tolerance};

// ───────────────────────────── stimulus ─────────────────────────────

/// The class radius (the windowed dispatcher's halo).
fn halo(def: &KernelDef) -> u32 {
    match def.class {
        KernelClass::Windowed { radius: (rx, ry) } => {
            assert_eq!(rx, ry, "{}: square halo", def.id);
            u32::from(rx)
        }
        _ => unreachable!("{} is windowed", def.id),
    }
}

/// A finite, structured window: smooth ramps plus a hashed component,
/// so neighbourhoods are neither flat nor monotone (a median or a range
/// weight has something to decide). Values in [0, 1].
fn window(def: &KernelDef, out_w: u32, out_h: u32) -> RefTile {
    let r = halo(def);
    RefTile::from_fn(out_w + 2 * r, out_h + 2 * r, |x, y| {
        let h = |c: u32| ((7 * x + 13 * y + 29 * c + 17 * ((x * y) % 11)) % 257) as f32 / 256.0;
        Px([
            0.5 * (x as f32 * 0.013).fract() + 0.5 * h(0),
            0.5 * (y as f32 * 0.027).fract() + 0.5 * h(1),
            h(2),
            0.75 + 0.25 * h(3),
        ])
    })
}

/// The tap at offset `(dx, dy)` from window position `(bx, by)`,
/// clamped into the window — the modules' edge rule.
fn tap(win: &[Px], ww: u32, wh: u32, bx: i32, by: i32, dx: i32, dy: i32) -> Px {
    let x = (bx + dx).clamp(0, ww as i32 - 1) as u32;
    let y = (by + dy).clamp(0, wh as i32 - 1) as u32;
    win[(y * ww + x) as usize]
}

/// Window position of output `(ox, oy)`: the halo the module derives,
/// `(win − out) / 2`, which the tests always make the class radius.
fn base(def: &KernelDef, ox: u32, oy: u32) -> (i32, i32) {
    let r = halo(def) as i32;
    (ox as i32 + r, oy as i32 + r)
}

fn require_gpu_parity(result: Option<image_conformance::harness::ParityResult>, def: &KernelDef) {
    // `None`: `test_device` already reported `unavailable: GPU adapter`
    // (or failed under PAGED_REQUIRE_GPU=1).
    if let Some(r) = result {
        eprintln!("{}: measured max f16 ULP {}", def.id, r.max_ulp);
        assert_within(r, def);
    }
}

// ─────────────────────── max / min / median (r) ───────────────────────

fn inside(p: &MorphRadiusParams, r: i32, dx: i32, dy: i32) -> bool {
    p.round == 0 || dx * dx + dy * dy <= r * r
}

fn morph_r_ref(
    def: &'static KernelDef,
    op: fn(f32, f32) -> f32,
) -> impl Fn(&[Px], u32, u32, u32, u32, &MorphRadiusParams) -> Px {
    move |win, ww, wh, ox, oy, p| {
        let (bx, by) = base(def, ox, oy);
        let r = p.radius.min(32) as i32;
        let mut acc = tap(win, ww, wh, bx, by, 0, 0);
        for dy in -r..=r {
            for dx in -r..=r {
                if !inside(p, r, dx, dy) {
                    continue;
                }
                acc = acc.zip(tap(win, ww, wh, bx, by, dx, dy), op);
            }
        }
        acc
    }
}

/// The bisection median, channel by channel, exactly as the module runs
/// it (the module does all four channels at once with componentwise
/// selects, which is the same arithmetic).
fn median_r_ref(win: &[Px], ww: u32, wh: u32, ox: u32, oy: u32, p: &MorphRadiusParams) -> Px {
    let (bx, by) = base(&RANK_MEDIAN_R, ox, oy);
    let r = p.radius.min(10) as i32;
    let mut taps = Vec::new();
    for dy in -r..=r {
        for dx in -r..=r {
            if inside(p, r, dx, dy) {
                taps.push(tap(win, ww, wh, bx, by, dx, dy));
            }
        }
    }
    let center = tap(win, ww, wh, bx, by, 0, 0);
    let k = (taps.len() as f32 * 0.5).floor();
    let count_le = |c: usize, t: f32| taps.iter().filter(|s| s.0[c] <= t).count() as f32;
    Px(std::array::from_fn(|c| {
        let mut lo = center.0[c];
        let mut hi = center.0[c];
        for s in &taps {
            lo = lo.min(s.0[c]);
            hi = hi.max(s.0[c]);
        }
        let lo0 = lo;
        if count_le(c, lo) > k {
            return lo0;
        }
        for _ in 0..MEDIAN_BISECTION_STEPS {
            let mid = (lo + hi) * 0.5;
            if count_le(c, mid) > k {
                hi = mid;
            } else {
                lo = mid;
            }
        }
        let mut med = hi;
        for s in &taps {
            if s.0[c] > lo {
                med = med.min(s.0[c]);
            }
        }
        med
    }))
}

/// The true median by sorting — what the bisection must equal.
fn median_by_sort(
    win: &[Px],
    ww: u32,
    wh: u32,
    ox: u32,
    oy: u32,
    p: &MorphRadiusParams,
) -> [f32; 4] {
    let (bx, by) = base(&RANK_MEDIAN_R, ox, oy);
    let r = p.radius.min(10) as i32;
    std::array::from_fn(|c| {
        let mut v = Vec::new();
        for dy in -r..=r {
            for dx in -r..=r {
                if inside(p, r, dx, dy) {
                    v.push(tap(win, ww, wh, bx, by, dx, dy).0[c]);
                }
            }
        }
        v.sort_by(f32::total_cmp);
        v[v.len() / 2]
    })
}

#[test]
fn morph_dilate_r_parity__feat__image_editor_rank_filters() {
    for (radius, round) in [(3, false), (5, true)] {
        let p = MorphRadiusParams::new(radius, round);
        let win = window(&MORPH_DILATE_R, 64, 48);
        let r = parity_windowed(
            &MORPH_DILATE_R,
            morph_r_ref(&MORPH_DILATE_R, f32::max),
            &win,
            64,
            48,
            &p,
        );
        require_gpu_parity(r, &MORPH_DILATE_R);
    }
}

#[test]
fn morph_erode_r_parity__feat__image_editor_rank_filters() {
    for (radius, round) in [(2, false), (7, true)] {
        let p = MorphRadiusParams::new(radius, round);
        let win = window(&MORPH_ERODE_R, 64, 48);
        let r = parity_windowed(
            &MORPH_ERODE_R,
            morph_r_ref(&MORPH_ERODE_R, f32::min),
            &win,
            64,
            48,
            &p,
        );
        require_gpu_parity(r, &MORPH_ERODE_R);
    }
}

#[test]
fn rank_median_r_parity__feat__image_editor_rank_filters() {
    for (radius, round) in [(1, false), (3, false), (4, true)] {
        let p = MorphRadiusParams::new(radius, round);
        let win = window(&RANK_MEDIAN_R, 48, 40);
        let r = parity_windowed(&RANK_MEDIAN_R, median_r_ref, &win, 48, 40, &p);
        require_gpu_parity(r, &RANK_MEDIAN_R);
    }
}

#[test]
fn rank_median_r_bisection_is_the_true_median__feat__image_editor_rank_filters() {
    // The proof the method needs: over a structured window, at several
    // radii and both shapes, the bisection selects EXACTLY the sorted
    // median (an existing f16 sample), not an approximation of it.
    let win = window(&RANK_MEDIAN_R, 24, 20);
    let q = win.quantized_px();
    for (radius, round) in [(1, false), (2, false), (2, true), (6, false), (10, true)] {
        let p = MorphRadiusParams::new(radius, round);
        for oy in 0..20 {
            for ox in 0..24 {
                let got = median_r_ref(&q, win.w, win.h, ox, oy, &p);
                let want = median_by_sort(&q, win.w, win.h, ox, oy, &p);
                assert_eq!(got.0, want, "r={radius} round={round} at ({ox},{oy})");
            }
        }
    }
}

#[test]
fn radius_zero_is_the_identity_for_max_min_median__feat__image_editor_rank_filters() {
    let p = MorphRadiusParams::new(0, false);
    for (def, op) in [
        (&MORPH_DILATE_R, f32::max as fn(f32, f32) -> f32),
        (&MORPH_ERODE_R, f32::min),
    ] {
        let win = window(def, 16, 16);
        let q = win.quantized_px();
        let f = morph_r_ref(def, op);
        for oy in 0..16 {
            for ox in 0..16 {
                let (bx, by) = base(def, ox, oy);
                assert_eq!(
                    f(&q, win.w, win.h, ox, oy, &p).0,
                    tap(&q, win.w, win.h, bx, by, 0, 0).0
                );
            }
        }
    }
    let win = window(&RANK_MEDIAN_R, 16, 16);
    let q = win.quantized_px();
    for oy in 0..16 {
        for ox in 0..16 {
            let (bx, by) = base(&RANK_MEDIAN_R, ox, oy);
            assert_eq!(
                median_r_ref(&q, win.w, win.h, ox, oy, &p).0,
                tap(&q, win.w, win.h, bx, by, 0, 0).0
            );
        }
    }
}

#[test]
fn a_wider_maximum_spreads_a_bright_point_by_its_radius__feat__image_editor_rank_filters() {
    // A single bright texel spreads to a (2r+1)² square, and to a disc
    // when round: the meaning of the radius and the shape.
    let r = halo(&MORPH_DILATE_R);
    let (ow, oh) = (21u32, 21u32);
    let (ww, wh) = (ow + 2 * r, oh + 2 * r);
    let mut win = vec![Px([0.2, 0.2, 0.2, 1.0]); (ww * wh) as usize];
    let c = (10 + r, 10 + r);
    win[(c.1 * ww + c.0) as usize] = Px([0.9, 0.9, 0.9, 1.0]);
    for round in [false, true] {
        let p = MorphRadiusParams::new(4, round);
        let f = morph_r_ref(&MORPH_DILATE_R, f32::max);
        for oy in 0..oh {
            for ox in 0..ow {
                let (dx, dy) = (ox as i32 - 10, oy as i32 - 10);
                let reached = if round {
                    dx * dx + dy * dy <= 16
                } else {
                    dx.abs() <= 4 && dy.abs() <= 4
                };
                let got = f(&win, ww, wh, ox, oy, &p).0[0];
                assert_eq!(got, if reached { 0.9 } else { 0.2 }, "({ox},{oy}) {round}");
            }
        }
    }
}

// ─────────────────────────────── box (r) ───────────────────────────────

fn box_r_ref(win: &[Px], ww: u32, wh: u32, ox: u32, oy: u32, p: &ConvBoxRadiusParams) -> Px {
    let (bx, by) = base(&CONV_BOX_R, ox, oy);
    let r = p.radius.min(32) as i32;
    let mut sum = Px([0.0; 4]);
    for dy in -r..=r {
        for dx in -r..=r {
            sum = sum.zip(tap(win, ww, wh, bx, by, dx, dy), |a, b| a + b);
        }
    }
    let side = (2 * r + 1) as f32;
    let n = side * side;
    Px(sum.0.map(|v| v / n))
}

#[test]
fn conv_box_r_parity__feat__image_editor_filter_dialogs() {
    for radius in [0, 2, 9] {
        let p = ConvBoxRadiusParams::new(radius);
        let win = window(&CONV_BOX_R, 64, 48);
        let r = parity_windowed(&CONV_BOX_R, box_r_ref, &win, 64, 48, &p);
        require_gpu_parity(r, &CONV_BOX_R);
    }
}

#[test]
fn conv_box_r_flattens_a_field_to_its_mean__feat__image_editor_filter_dialogs() {
    // Radius 0 is the identity; a constant field stays constant at any
    // radius (the weights sum to one).
    let win = window(&CONV_BOX_R, 8, 8);
    let q = win.quantized_px();
    let p0 = ConvBoxRadiusParams::new(0);
    for oy in 0..8 {
        for ox in 0..8 {
            let (bx, by) = base(&CONV_BOX_R, ox, oy);
            assert_eq!(
                box_r_ref(&q, win.w, win.h, ox, oy, &p0).0,
                tap(&q, win.w, win.h, bx, by, 0, 0).0
            );
        }
    }
    let r = halo(&CONV_BOX_R);
    let flat = vec![Px([0.25, 0.5, 0.75, 1.0]); ((8 + 2 * r) * (8 + 2 * r)) as usize];
    let got = box_r_ref(
        &flat,
        8 + 2 * r,
        8 + 2 * r,
        3,
        3,
        &ConvBoxRadiusParams::new(5),
    );
    for (g, w) in got.0.iter().zip([0.25, 0.5, 0.75, 1.0]) {
        assert!((g - w).abs() < 1e-6, "{g} vs {w}");
    }
}

// ─────────────────────────────── surface ───────────────────────────────

fn surface_ref(win: &[Px], ww: u32, wh: u32, ox: u32, oy: u32, p: &ConvSurfaceParams) -> Px {
    let (bx, by) = base(&CONV_SURFACE, ox, oy);
    let center = tap(win, ww, wh, bx, by, 0, 0);
    if p.threshold <= 0.0 {
        return center;
    }
    let r = p.radius.min(16) as i32;
    let inv = 1.0 / (2.5 * p.threshold);
    let mut acc = [0.0f32; 4];
    let mut wsum = [0.0f32; 4];
    for dy in -r..=r {
        for dx in -r..=r {
            let s = tap(win, ww, wh, bx, by, dx, dy);
            for c in 0..4 {
                let w = (1.0 - (s.0[c] - center.0[c]).abs() * inv).max(0.0);
                acc[c] += s.0[c] * w;
                wsum[c] += w;
            }
        }
    }
    Px(std::array::from_fn(|c| acc[c] / wsum[c]))
}

#[test]
fn conv_surface_parity__feat__image_editor_filter_dialogs() {
    for (radius, threshold) in [(3, 0.1), (8, 0.3), (5, 0.0)] {
        let p = ConvSurfaceParams::new(radius, threshold);
        let win = window(&CONV_SURFACE, 64, 48);
        let r = parity_windowed(&CONV_SURFACE, surface_ref, &win, 64, 48, &p);
        require_gpu_parity(r, &CONV_SURFACE);
    }
}

#[test]
fn conv_surface_keeps_an_edge_and_smooths_beside_it__feat__image_editor_filter_dialogs() {
    // A step edge (0.2 | 0.8) with ±0.02 noise on each side: a threshold
    // well under the step smooths the noise and leaves the step whole.
    let r = halo(&CONV_SURFACE);
    let (ow, oh) = (20u32, 8u32);
    let (ww, wh) = (ow + 2 * r, oh + 2 * r);
    let px = RefTile::from_fn(ww, wh, |x, y| {
        let level = if x < ww / 2 { 0.2 } else { 0.8 };
        let n = if (x + y) % 2 == 0 { 0.02 } else { -0.02 };
        Px([level + n, level + n, level + n, 1.0])
    });
    let q = px.quantized_px();
    let p = ConvSurfaceParams::new(3, 0.05);
    for ox in 0..ow {
        let got = surface_ref(&q, ww, wh, ox, 3, &p).0[0];
        let wx = ox + r;
        let level = if wx < ww / 2 { 0.2 } else { 0.8 };
        assert!(
            (got - level).abs() < 0.012,
            "x={ox}: {got} should be smoothed towards {level} without crossing the edge"
        );
    }
}

// ────────────────────────────── high pass ──────────────────────────────

fn high_pass_ref(win: &[Px], ww: u32, wh: u32, ox: u32, oy: u32, p: &ConvHighPassParams) -> Px {
    let (bx, by) = base(&CONV_HIGH_PASS, ox, oy);
    let a = tap(win, ww, wh, bx, by, 0, 0);
    let sigma = p.radius_px.clamp(0.0, 32.0 / 3.0);
    let r = ((3.0 * sigma).ceil() as i32).min(32);
    let inv2s2 = 1.0 / (2.0 * (sigma * sigma).max(1e-6));
    let mut acc = [0.0f32; 4];
    let mut wsum = 0.0f32;
    for dy in -r..=r {
        for dx in -r..=r {
            let w = (-((dx * dx + dy * dy) as f32) * inv2s2).exp();
            let s = tap(win, ww, wh, bx, by, dx, dy);
            for (a, v) in acc.iter_mut().zip(s.0) {
                *a += v * w;
            }
            wsum += w;
        }
    }
    let al = a.0[3];
    Px([
        (a.0[0] - acc[0] / wsum + 0.5 * al).clamp(0.0, al),
        (a.0[1] - acc[1] / wsum + 0.5 * al).clamp(0.0, al),
        (a.0[2] - acc[2] / wsum + 0.5 * al).clamp(0.0, al),
        al,
    ])
}

#[test]
fn conv_high_pass_parity__feat__image_editor_filter_dialogs() {
    for radius in [0.0, 1.5, 4.0] {
        let p = ConvHighPassParams::new(radius);
        let win = window(&CONV_HIGH_PASS, 64, 48);
        let r = parity_windowed(&CONV_HIGH_PASS, high_pass_ref, &win, 64, 48, &p);
        require_gpu_parity(r, &CONV_HIGH_PASS);
    }
}

#[test]
fn conv_high_pass_turns_flat_areas_mid_grey__feat__image_editor_filter_dialogs() {
    let r = halo(&CONV_HIGH_PASS);
    let flat = vec![Px([0.9, 0.1, 0.4, 1.0]); ((4 + 2 * r) * (4 + 2 * r)) as usize];
    let got = high_pass_ref(
        &flat,
        4 + 2 * r,
        4 + 2 * r,
        1,
        1,
        &ConvHighPassParams::new(3.0),
    );
    for c in 0..3 {
        assert!(
            (got.0[c] - 0.5).abs() < 1e-5,
            "flat → 50 % grey: {:?}",
            got.0
        );
    }
    assert_eq!(got.0[3], 1.0, "alpha kept");
}

// ────────────────────────────── add noise ──────────────────────────────

fn pcg_ref(v: u32) -> u32 {
    let state = v.wrapping_mul(747_796_405).wrapping_add(2_891_336_453);
    let word = ((state >> ((state >> 28) + 4)) ^ state).wrapping_mul(277_803_737);
    (word >> 22) ^ word
}

fn add_noise_ref(a: Px, x: u32, y: u32, p: &GenAddNoiseParams) -> Px {
    const INV_2_24: f32 = 1.0 / 16_777_216.0;
    let gx = (p.ox + x as i32) as u32;
    let gy = (p.oy + y as i32) as u32;
    let mut state = pcg_ref(gx ^ pcg_ref(gy ^ pcg_ref(p.seed)));
    let mut draw = || {
        state = pcg_ref(state);
        (state >> 8) as f32 * INV_2_24
    };
    let mut sample = || {
        if p.gaussian != 0 {
            let u1 = draw();
            let u2 = draw();
            let u3 = draw();
            let u4 = draw();
            (((u1 + u2) + u3) + u4 - 2.0) * 0.5
        } else {
            draw() - 0.5
        }
    };
    let n = if p.mono != 0 {
        let v = sample();
        [v, v, v]
    } else {
        let r = sample();
        let g = sample();
        let b = sample();
        [r, g, b]
    };
    let al = a.0[3];
    let k = p.amount * al;
    Px([
        (a.0[0] + n[0] * k).clamp(0.0, al),
        (a.0[1] + n[1] * k).clamp(0.0, al),
        (a.0[2] + n[2] * k).clamp(0.0, al),
        al,
    ])
}

/// Point parity with the texel's coordinate, which the harness's
/// `parity` cannot hand a reference.
fn add_noise_parity(p: &GenAddNoiseParams, w: u32, h: u32) {
    let Some(ctx) = image_conformance::device::test_device() else {
        return;
    };
    let img = RefTile::from_fn(w, h, |x, y| {
        let v = ((x * 7 + y * 13) % 97) as f32 / 96.0;
        Px([v, 1.0 - v, 0.5 * v, 1.0])
    });
    let out = image_gpu::execute_tile_once(
        ctx,
        &GEN_ADD_NOISE,
        &[image_gpu::TileInput {
            f16_bytes: &img.f16_bytes(),
        }],
        bytemuck::bytes_of(p),
        None,
        w,
        h,
    )
    .expect("gen.add_noise");
    let q = img.quantized_px();
    let limit = match GEN_ADD_NOISE.gpu_tolerance {
        Tolerance::ChannelEpsF16(n) => n,
        other => panic!("unexpected tolerance {other:?}"),
    };
    let mut max_ulp = 0;
    for y in 0..h {
        for x in 0..w {
            let i = (y * w + x) as usize;
            let want = add_noise_ref(q[i], x, y, p);
            for c in 0..4 {
                let got = u16::from_le_bytes([out[i * 8 + c * 2], out[i * 8 + c * 2 + 1]]);
                max_ulp = max_ulp.max(f16_ulp_distance(f32_to_f16_bits(want.0[c]), got));
            }
        }
    }
    eprintln!("gen.add_noise: measured max f16 ULP {max_ulp}");
    assert!(max_ulp <= limit, "gen.add_noise: {max_ulp} ULP > {limit}");
}

#[test]
fn gen_add_noise_parity__feat__image_editor_filter_dialogs() {
    add_noise_parity(&GenAddNoiseParams::new(7, 0.25, false, false), 64, 48);
    add_noise_parity(&GenAddNoiseParams::new(7, 0.25, true, false), 64, 48);
    add_noise_parity(&GenAddNoiseParams::new(99, 0.5, true, true), 40, 40);
}

#[test]
fn gen_add_noise_is_seeded_bounded_and_mono_when_asked__feat__image_editor_filter_dialogs() {
    let a = Px([0.5, 0.5, 0.5, 1.0]);
    let zero = GenAddNoiseParams::new(3, 0.0, true, false);
    assert_eq!(
        add_noise_ref(a, 5, 9, &zero).0,
        a.0,
        "amount 0 is the identity"
    );
    let mut any_diff = false;
    let n = 64 * 64;
    for gaussian in [false, true] {
        let p = GenAddNoiseParams::new(3, 0.4, gaussian, false);
        let m = GenAddNoiseParams::new(3, 0.4, gaussian, true);
        let mut sum = 0.0f64;
        let mut sum2 = 0.0f64;
        for y in 0..64 {
            for x in 0..64 {
                let v = add_noise_ref(a, x, y, &p);
                assert_eq!(v.0, add_noise_ref(a, x, y, &p).0, "deterministic");
                assert!(v.0.iter().all(|c| (0.0..=1.0).contains(c)));
                if v.0[0] != v.0[1] {
                    any_diff = true;
                }
                let mv = add_noise_ref(a, x, y, &m);
                assert_eq!(mv.0[0], mv.0[1], "mono shares one draw");
                assert_eq!(mv.0[1], mv.0[2]);
                let d = f64::from(v.0[0] - 0.5) / 0.4;
                sum += d;
                sum2 += d * d;
            }
        }
        let mean = sum / n as f64;
        let sd = (sum2 / n as f64 - mean * mean).sqrt();
        // Both forms are zero-mean with σ = 1/√12 ≈ 0.289 before scaling.
        assert!(mean.abs() < 0.02, "gaussian={gaussian}: mean {mean}");
        assert!((sd - 0.2887).abs() < 0.02, "gaussian={gaussian}: σ {sd}");
    }
    assert!(any_diff, "colour noise draws per channel");
    let t = add_noise_ref(
        Px([0.0; 4]),
        1,
        1,
        &GenAddNoiseParams::new(3, 1.0, false, false),
    );
    assert_eq!(t.0, [0.0; 4], "a transparent pixel stays transparent");
}

#[test]
fn the_new_kernels_quantise_like_their_declared_tolerance() {
    // Exact kernels must only select existing samples: re-check that the
    // reference output of each is bit-identical once quantised.
    let win = window(&MORPH_DILATE_R, 8, 8);
    let q = win.quantized_px();
    let p = MorphRadiusParams::new(2, false);
    let f = morph_r_ref(&MORPH_DILATE_R, f32::max);
    for oy in 0..8 {
        for ox in 0..8 {
            for v in f(&q, win.w, win.h, ox, oy, &p).0 {
                assert_eq!(f16::from_f32(v).to_f32(), v);
            }
        }
    }
    assert_eq!(MORPH_DILATE_R.gpu_tolerance, Tolerance::Exact);
    assert_eq!(MORPH_ERODE_R.gpu_tolerance, Tolerance::Exact);
    assert_eq!(RANK_MEDIAN_R.gpu_tolerance, Tolerance::Exact);
}
