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

//! gpu↔ref parity and behaviour proofs for `families::gallery_ext` (WP5.2).
//! Scalar twins mirror each WGSL module step for step (the stroke smear's
//! tap schedule and PCG jitter, the box-smoothed luminance, the cosine
//! remap, the x²⁴ highlight by squaring); the declared tolerance is the
//! only slack. Behaviour proofs run on the twins.
#![allow(non_snake_case)]

use crate::filters_blurgal::stimulus;
use crate::filters_blurgal::twin::{bilin, luma, mixp, radians, scale, tap, TAU};
use image_conformance::harness::{assert_within, parity_windowed, RefTile};
use image_conformance::Px;
use image_kernels::families::gallery_ext::{
    GalleryChromeParams, GalleryPlasticWrapParams, GalleryStrokesParams, GALLERY_CHROME,
    GALLERY_PLASTIC_WRAP, GALLERY_STROKES, STROKES_MAX_LENGTH,
};
use image_kernels::KernelDef;

const W: u32 = 48;
const H: u32 = 40;

fn require<P: bytemuck::Pod>(
    def: &'static KernelDef,
    reference: impl Fn(&[Px], u32, u32, u32, u32, &P) -> Px,
    p: &P,
) {
    let win = stimulus(W, H);
    if let Some(r) = parity_windowed(def, reference, &win, W, H, p) {
        eprintln!("{}: measured max f16 ULP {}", def.id, r.max_ulp);
        assert_within(r, def);
    }
}

fn run_on<P>(
    src: &[Px],
    reference: impl Fn(&[Px], u32, u32, u32, u32, &P) -> Px,
    p: &P,
) -> Vec<Px> {
    let mut out = Vec::with_capacity(src.len());
    for y in 0..H {
        for x in 0..W {
            out.push(reference(src, W, H, x, y, p));
        }
    }
    out
}

fn pcg(v: u32) -> u32 {
    let state = v.wrapping_mul(747_796_405).wrapping_add(2_891_336_453);
    let word = ((state >> ((state >> 28) + 4)) ^ state).wrapping_mul(277_803_737);
    (word >> 22) ^ word
}

fn hash21(x: i32, y: i32, seed: u32) -> f32 {
    let h = pcg((x as u32) ^ pcg((y as u32) ^ pcg(seed)));
    (h >> 8) as f32 * 5.960_464_5e-8
}

fn finish(a: Px, styled_rgb: [f32; 3], amount: f32) -> Px {
    let styled = Px([styled_rgb[0], styled_rgb[1], styled_rgb[2], a.0[3]]);
    mixp(a, styled, amount.clamp(0.0, 1.0))
}

// ───────────────────────────── twins ────────────────────────────────

fn strokes_ref(win: &[Px], w: u32, h: u32, ox: u32, oy: u32, p: &GalleryStrokesParams) -> Px {
    let (x, y) = (ox as i32, oy as i32);
    let a = tap(win, w, h, x, y);
    let (px, py) = (x as f32 + 0.5, y as f32 + 0.5);
    let rad = radians(p.angle_deg);
    let (mut dx, mut dy) = (rad.cos(), rad.sin());
    if p.mode == 1 {
        let l = |ddx: i32, ddy: i32| luma(tap(win, w, h, x + ddx, y + ddy));
        let gx = (l(1, -1) + 2.0 * l(1, 0) + l(1, 1)) - (l(-1, -1) + 2.0 * l(-1, 0) + l(-1, 1));
        let gy = (l(-1, 1) + 2.0 * l(0, 1) + l(1, 1)) - (l(-1, -1) + 2.0 * l(0, -1) + l(1, -1));
        let gl = (gx * gx + gy * gy).sqrt();
        if gl > 0.001 {
            dx = -gy / gl;
            dy = gx / gl;
        }
    } else if p.mode == 2 && luma(a) < 0.5 {
        (dx, dy) = (-dy, dx);
    }
    let hsh = hash21(p.ox + x, p.oy + y, p.seed);
    let len = p.length_px.clamp(0.0, 24.0) * (0.6 + 0.4 * hsh);
    let smear = if len >= 0.5 {
        let n = (len.ceil() as i32).clamp(1, 24);
        let mut acc = Px([0.0; 4]);
        for j in -n..=n {
            let t = j as f32 / n as f32 * len;
            acc = acc + bilin(win, w, h, px + dx * t, py + dy * t);
        }
        scale(acc, 1.0 / (2 * n + 1) as f32)
    } else {
        a
    };
    let l = luma(smear);
    let d = p.darkness * (l - 0.5);
    let t = |c: usize| (smear.0[c] + d).clamp(0.0, 1.0);
    finish(a, [t(0), t(1), t(2)], p.amount)
}

fn box_luma(win: &[Px], w: u32, h: u32, x: i32, y: i32, r: i32) -> f32 {
    let mut s = 0.0;
    for dy in -r..=r {
        for dx in -r..=r {
            s += luma(tap(win, w, h, x + dx, y + dy));
        }
    }
    let n = (2 * r + 1) as f32;
    s / (n * n)
}

fn chrome_ref(win: &[Px], w: u32, h: u32, ox: u32, oy: u32, p: &GalleryChromeParams) -> Px {
    let (x, y) = (ox as i32, oy as i32);
    let a = tap(win, w, h, x, y);
    let r = (p.smoothness.clamp(0.0, 10.0) + 0.5).floor() as i32;
    let l = box_luma(win, w, h, x, y, r);
    let freq = 1.0 + p.detail.clamp(0.0, 10.0) * 0.3;
    let f = freq * l;
    let g = 0.5 - 0.5 * (TAU * (f - f.floor())).cos();
    let v = g * a.0[3];
    finish(a, [v, v, v], p.amount)
}

fn p24(x: f32) -> f32 {
    let x2 = x * x;
    let x4 = x2 * x2;
    let x8 = x4 * x4;
    x8 * x8 * x8
}

fn normalize3(v: [f32; 3]) -> [f32; 3] {
    let l = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
    [v[0] / l, v[1] / l, v[2] / l]
}

fn plastic_ref(win: &[Px], w: u32, h: u32, ox: u32, oy: u32, p: &GalleryPlasticWrapParams) -> Px {
    let (x, y) = (ox as i32, oy as i32);
    let a = tap(win, w, h, x, y);
    let r = (p.smoothness.clamp(1.0, 15.0) * 0.5 + 0.5)
        .floor()
        .clamp(0.0, 8.0) as i32;
    let st = ((16.0 - p.detail.clamp(1.0, 15.0)) / 3.0 + 0.5)
        .floor()
        .clamp(1.0, 5.0) as i32;
    let hx = box_luma(win, w, h, x + st, y, r) - box_luma(win, w, h, x - st, y, r);
    let hy = box_luma(win, w, h, x, y + st, r) - box_luma(win, w, h, x, y - st, r);
    let k = 24.0 / (2 * st) as f32;
    let n = normalize3([-hx * k, -hy * k, 1.0]);
    let hv = normalize3([-0.6, -0.6, 0.53 + 1.0]);
    let flat = p24(hv[2]);
    let d = (n[0] * hv[0] + n[1] * hv[1] + n[2] * hv[2]).max(0.0);
    let spec = (p24(d) - flat).max(0.0) / (1.0 - flat);
    let ks = p.strength.clamp(0.0, 20.0) / 20.0;
    let dark = 1.0 - ks * 0.6 * ((1.0 - n[2]) * 4.0).clamp(0.0, 1.0);
    let add = ks * spec * 1.5 * a.0[3];
    let t = |c: usize| (a.0[c] * dark + add).clamp(0.0, 1.0);
    finish(a, [t(0), t(1), t(2)], p.amount)
}

// ───────────────────────────── parity ───────────────────────────────

#[test]
fn gallery_strokes_parity_every_mode__feat__image_editor_filters() {
    for mode in 0..3 {
        let p = GalleryStrokesParams::new(11, 35.0, 9.0, mode, 0.4, 0.85);
        require(&GALLERY_STROKES, strokes_ref, &p);
    }
}

#[test]
fn gallery_chrome_parity__feat__image_editor_filters() {
    require(
        &GALLERY_CHROME,
        chrome_ref,
        &GalleryChromeParams::new(4.0, 3.0, 1.0),
    );
}

#[test]
fn gallery_plastic_wrap_parity__feat__image_editor_filters() {
    require(
        &GALLERY_PLASTIC_WRAP,
        plastic_ref,
        &GalleryPlasticWrapParams::new(15.0, 9.0, 7.0, 1.0),
    );
}

// ───────────────────────────── behaviour ────────────────────────────

#[test]
fn gallery_ext_amount_zero_is_the_identity__feat__image_editor_filters() {
    let src = stimulus(W, H).quantized_px();
    assert_eq!(
        run_on(
            &src,
            strokes_ref,
            &GalleryStrokesParams::new(3, 20.0, 12.0, 1, 0.5, 0.0)
        ),
        src
    );
    assert_eq!(
        run_on(&src, chrome_ref, &GalleryChromeParams::new(5.0, 4.0, 0.0)),
        src
    );
    assert_eq!(
        run_on(
            &src,
            plastic_ref,
            &GalleryPlasticWrapParams::new(20.0, 9.0, 7.0, 0.0)
        ),
        src
    );
}

#[test]
fn strokes_smear_along_their_angle_only__feat__image_editor_filters() {
    // Horizontal bands (vary in y only): horizontal strokes read along a
    // row and leave them; vertical strokes smear across them.
    let bands = RefTile::from_fn(W, H, |_, y| {
        let v = if y % 4 < 2 { 0.9 } else { 0.1 };
        Px([v, v, v, 1.0])
    })
    .quantized_px();
    let along = run_on(
        &bands,
        strokes_ref,
        &GalleryStrokesParams::new(1, 0.0, 8.0, 0, 0.0, 1.0),
    );
    for (i, (a, s)) in along.iter().zip(&bands).enumerate() {
        assert!((a.0[0] - s.0[0]).abs() < 1e-5, "texel {i}");
    }
    let across = run_on(
        &bands,
        strokes_ref,
        &GalleryStrokesParams::new(1, 90.0, 8.0, 0, 0.0, 1.0),
    );
    let k = (20 * W + 10) as usize;
    assert!(
        (across[k].0[0] - 0.5).abs() < 0.25,
        "smeared: {}",
        across[k].0[0]
    );
    assert!(STROKES_MAX_LENGTH == 24.0);
}

#[test]
fn chrome_is_grey_and_plastic_wrap_leaves_flat_areas__feat__image_editor_filters() {
    let src = stimulus(W, H).quantized_px();
    for px in run_on(&src, chrome_ref, &GalleryChromeParams::new(4.0, 3.0, 1.0)) {
        assert_eq!(px.0[0], px.0[1]);
        assert_eq!(px.0[1], px.0[2]);
    }
    let flat = vec![Px([0.4, 0.5, 0.6, 1.0]); (W * H) as usize];
    let out = run_on(
        &flat,
        plastic_ref,
        &GalleryPlasticWrapParams::new(20.0, 9.0, 7.0, 1.0),
    );
    for (o, f) in out.iter().zip(&flat) {
        for c in 0..4 {
            assert!((o.0[c] - f.0[c]).abs() < 1e-6, "flat stays flat");
        }
    }
    // A relief does shine somewhere.
    let lit = run_on(
        &src,
        plastic_ref,
        &GalleryPlasticWrapParams::new(20.0, 12.0, 5.0, 1.0),
    );
    assert!(lit.iter().zip(&src).any(|(o, s)| o.0[0] > s.0[0] + 0.05));
}
