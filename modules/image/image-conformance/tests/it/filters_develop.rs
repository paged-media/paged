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

//! gpu↔ref parity and behaviour proofs for `families::develop` (WP5.2):
//! the Develop adjustment's point stages (`develop.tone`) and
//! neighbourhood stages (`develop.detail`). The scalar twins mirror the
//! WGSL modules stage for stage, reading the same integer taps and
//! weights the CPU hands the shader.
//!
//! The parity tests report `unavailable: GPU adapter` without one and fail
//! under `PAGED_REQUIRE_GPU=1` (never a silent pass).
#![allow(non_snake_case)]

use image_conformance::harness::{assert_within, parity_windowed, ParityResult};
use image_conformance::Px;
use image_kernels::families::develop::{
    DevelopDetailParams, DevelopSettings, DevelopToneParams, DEVELOP_DETAIL, DEVELOP_LEN,
    DEVELOP_TONE,
};
use image_kernels::KernelDef;

use super::filters_adjust_ext::{
    c01, hsl_rgb, hue_of, luma, out, sat_of, stimulus, texel, unpremul,
};

const W: u32 = 48;
const H: u32 = 40;

fn check(result: Option<ParityResult>, def: &KernelDef) {
    if let Some(r) = result {
        eprintln!("{}: measured max f16 ULP {}", def.id, r.max_ulp);
        assert_within(r, def);
    }
}

fn get(s: &[[f32; 4]; 16], i: usize) -> f32 {
    s[i / 4][i % 4]
}

fn to_lin(c: f32) -> f32 {
    if c <= 0.04045 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
}

fn to_srgb(v: f32) -> f32 {
    if v <= 0.003_130_8 {
        12.92 * v
    } else {
        1.055 * v.powf(1.0 / 2.4) - 0.055
    }
}

const CENTRES: [f32; 8] = [0.0, 30.0, 60.0, 120.0, 180.0, 240.0, 270.0, 300.0];

fn tint(h: f32, s: f32) -> [f32; 3] {
    hsl_rgb(h - 360.0 * (h / 360.0).floor(), 1.0, 0.5).map(|v| (v - 0.5) * (s * 0.003))
}

fn tone_ref(win: &[Px], w: u32, _h: u32, x: u32, y: u32, p: &DevelopToneParams) -> Px {
    let s = &p.s;
    let a = win[(y * w + x) as usize];
    let mut c = unpremul(a);

    let temp = get(s, 0) * 0.01;
    let tnt = get(s, 1) * 0.01;
    let ev = get(s, 2);
    if temp != 0.0 || tnt != 0.0 || ev != 0.0 {
        let lin = c.map(to_lin);
        let g = [
            (0.25 * temp).exp2(),
            (-0.25 * tnt).exp2(),
            (-0.25 * temp).exp2(),
        ];
        let n = luma(g);
        let e = ev.exp2();
        let lin = c01([0, 1, 2].map(|i| lin[i] * (g[i] / n) * e));
        c = c01(lin.map(to_srgb));
    }

    let l = luma(c);
    let mut l2 = l;
    let k = get(s, 3) * 0.01;
    if k != 0.0 {
        l2 += k * (l2 - 0.5) * 4.0 * l2 * (1.0 - l2);
    }
    let hl = get(s, 4) * 0.01;
    if hl != 0.0 {
        l2 += hl * 0.35 * l2 * l2 * (1.0 - l2) * 4.0;
    }
    let sh = get(s, 5) * 0.01;
    if sh != 0.0 {
        l2 += sh * 0.35 * (1.0 - l2) * (1.0 - l2) * l2 * 4.0;
    }
    let wh = get(s, 6) * 0.01;
    if wh != 0.0 {
        l2 += wh * 0.25 * l2 * l2 * l2;
    }
    let bl = get(s, 7) * 0.01;
    if bl != 0.0 {
        l2 += bl * 0.25 * (1.0 - l2) * (1.0 - l2) * (1.0 - l2);
    }
    for r in 0..4 {
        let v = get(s, 51 + r) * 0.01;
        if v != 0.0 {
            let ctr = 0.875 - 0.25 * r as f32;
            let wt = (1.0 - (l2 - ctr).abs() * 4.0).max(0.0);
            l2 += v * 0.15 * wt;
        }
    }
    let l2 = l2.clamp(0.0, 1.0);
    if l2 != l {
        c = c01(c.map(|v| v + (l2 - l)));
    }

    if (13..=36).any(|i| get(s, i) != 0.0) {
        let mx = c[0].max(c[1].max(c[2]));
        let mn = c[0].min(c[1].min(c[2]));
        if mx > mn {
            let h = hue_of(c);
            let sat = sat_of(c);
            let lum = (mx + mn) * 0.5;
            let (mut lo, mut hi) = (7usize, 0usize);
            for j in 0..7 {
                if h >= CENTRES[j] && h < CENTRES[j + 1] {
                    lo = j;
                    hi = j + 1;
                }
            }
            let c_lo = CENTRES[lo];
            let c_hi = if lo == 7 { 360.0 } else { CENTRES[hi] };
            let t = (h - c_lo) / (c_hi - c_lo);
            let (w_lo, w_hi) = (1.0 - t, t);
            let dh = (w_lo * get(s, 13 + 3 * lo) + w_hi * get(s, 13 + 3 * hi)) * 0.3;
            let ds = (w_lo * get(s, 14 + 3 * lo) + w_hi * get(s, 14 + 3 * hi)) * 0.01;
            let dlum = (w_lo * get(s, 15 + 3 * lo) + w_hi * get(s, 15 + 3 * hi)) * 0.01;
            let mut h2 = h + dh;
            h2 -= 360.0 * (h2 / 360.0).floor();
            let s2 = (sat * (1.0 + ds)).clamp(0.0, 1.0);
            let l3 = (lum + dlum * 0.3 * sat).clamp(0.0, 1.0);
            c = c01(hsl_rgb(h2, s2, l3));
        }
    }

    let vib = get(s, 11) * 0.01;
    let satur = get(s, 12) * 0.01;
    if vib != 0.0 || satur != 0.0 {
        let lum = luma(c);
        let sp = c[0].max(c[1].max(c[2])) - c[0].min(c[1].min(c[2]));
        let f = (1.0 + satur + vib * (1.0 - sp)).max(0.0);
        c = c01(c.map(|v| lum + (v - lum) * f));
    }

    if [38, 39, 41, 42, 44, 45, 47, 48]
        .iter()
        .any(|&i| get(s, i) != 0.0)
    {
        let lum = luma(c);
        let b = (get(s, 49) * 0.01).max(0.01);
        let pv = (0.5 + get(s, 50) * 0.005).clamp(0.05, 0.95);
        let lo = pv - b * pv;
        let hi = pv + b * (1.0 - pv);
        let xx = ((lum - lo) / (hi - lo)).clamp(0.0, 1.0);
        let tt = xx * xx * (3.0 - 2.0 * xx);
        let ws = 1.0 - tt;
        let whh = tt;
        let wm = 4.0 * ws * whh;
        let ws2 = ws * (1.0 - wm);
        let wh2 = whh * (1.0 - wm);
        let (t1, t2, t3, t4) = (
            tint(get(s, 37), get(s, 38)),
            tint(get(s, 40), get(s, 41)),
            tint(get(s, 43), get(s, 44)),
            tint(get(s, 46), get(s, 47)),
        );
        let off = [0, 1, 2].map(|i| ws2 * t1[i] + wm * t2[i] + wh2 * t3[i] + t4[i]);
        let dl = (ws2 * get(s, 39) + wm * get(s, 42) + wh2 * get(s, 45) + get(s, 48)) * 0.002;
        c = c01([0, 1, 2].map(|i| c[i] + off[i] + dl));
    }
    out(c, a)
}

fn lum_at(win: &[Px], w: u32, h: u32, x: i32, y: i32) -> f32 {
    luma(unpremul(texel(win, w, h, x, y)))
}

fn dark_at(win: &[Px], w: u32, h: u32, x: i32, y: i32) -> f32 {
    let c = unpremul(texel(win, w, h, x, y));
    c[0].min(c[1].min(c[2]))
}

fn detail_ref(win: &[Px], w: u32, h: u32, x: u32, y: u32, p: &DevelopDetailParams) -> Px {
    let s = &p.s;
    let (xi, yi) = (x as i32, y as i32);
    let a = win[(y * w + x) as usize];
    let nr_l = get(s, 59) * 0.01;
    let nr_c = get(s, 60) * 0.01;
    let haze = get(s, 10) * 0.01;
    let tex = get(s, 8) * 0.01;
    let clar = get(s, 9) * 0.01;
    let sharp = get(s, 55) * 0.01;
    if nr_l == 0.0 && nr_c == 0.0 && haze == 0.0 && tex == 0.0 && clar == 0.0 && sharp == 0.0 {
        return a;
    }
    let mut c = unpremul(a);
    let l_in = luma(c);

    if nr_l != 0.0 || nr_c != 0.0 {
        let sigma = 0.05 + 0.45 * nr_l;
        let (mut sl, mut sw) = (0.0f32, 0.0f32);
        let mut sc = [0.0f32; 3];
        for dy in -2..=2 {
            for dx in -2..=2 {
                let t = unpremul(texel(win, w, h, xi + dx, yi + dy));
                let lt = luma(t);
                let wt = (1.0 - (lt - l_in).abs() / sigma).max(0.0);
                sl += wt * lt;
                sw += wt;
                for i in 0..3 {
                    sc[i] += t[i] - lt;
                }
            }
        }
        if nr_l != 0.0 {
            let k = (sl / sw - l_in) * nr_l;
            c = c01(c.map(|v| v + k));
        }
        if nr_c != 0.0 {
            let lc = luma(c);
            c = c01([0, 1, 2].map(|i| {
                let cur = c[i] - lc;
                lc + (cur * (1.0 - nr_c) + sc[i] * 0.04 * nr_c)
            }));
        }
    }

    if haze > 0.0 {
        let mut dc = dark_at(win, w, h, xi, yi);
        for t in &p.taps_haze {
            dc = dc.min(dark_at(win, w, h, xi + t[0], yi + t[1]).min(dark_at(
                win,
                w,
                h,
                xi + t[2],
                yi + t[3],
            )));
        }
        let tr = (1.0 - 0.9 * haze * dc).max(0.1);
        c = c01(c.map(|v| (v - 1.0) / tr + 1.0));
    } else if haze < 0.0 {
        c = c01(c.map(|v| v + (0.85 - v) * (-haze * 0.5)));
    }

    let mut dl = 0.0f32;
    if tex != 0.0 {
        let mut sm = l_in;
        for t in &p.taps_tex {
            sm += lum_at(win, w, h, xi + t[0], yi + t[1]);
            sm += lum_at(win, w, h, xi + t[2], yi + t[3]);
        }
        dl += tex * (l_in - sm * 0.04);
    }
    if clar != 0.0 {
        let mut sm = l_in;
        for t in &p.taps_clar {
            sm += lum_at(win, w, h, xi + t[0], yi + t[1]);
            sm += lum_at(win, w, h, xi + t[2], yi + t[3]);
        }
        let lc = luma(c);
        dl += clar * (l_in - sm * 0.04) * 4.0 * lc * (1.0 - lc);
    }
    if sharp != 0.0 {
        let wgt = |i: usize| p.w_sharp[i / 4][i % 4];
        let mut b = wgt(0) * l_in;
        for (i, t) in p.taps_sharp.iter().enumerate() {
            b += wgt(1 + 2 * i) * lum_at(win, w, h, xi + t[0], yi + t[1]);
            b += wgt(2 + 2 * i) * lum_at(win, w, h, xi + t[2], yi + t[3]);
        }
        let hp = l_in - b;
        let masking = get(s, 58) * 0.01;
        let mk = if masking > 0.0 {
            ((hp.abs() - masking * 0.05) * 40.0).clamp(0.0, 1.0)
        } else {
            1.0
        };
        let detail = get(s, 57) * 0.01;
        dl += sharp * hp * mk * (0.5 + detail);
    }
    if dl != 0.0 {
        c = c01(c.map(|v| v + dl));
    }
    out(c, a)
}

fn settings(pairs: &[(usize, f32)]) -> DevelopSettings {
    let mut s = DevelopSettings::identity();
    for &(i, v) in pairs {
        s.0[i] = v;
    }
    s
}

/// A spread of tone settings: white balance + exposure, the tonal
/// sliders and curve, HSL in several ranges, vibrance/saturation and the
/// grading wheels.
fn tone_cases() -> Vec<DevelopSettings> {
    vec![
        settings(&[(0, 30.0), (1, -15.0), (2, 0.6)]),
        settings(&[
            (3, 40.0),
            (4, -50.0),
            (5, 60.0),
            (6, 20.0),
            (7, -30.0),
            (51, 30.0),
            (54, -40.0),
        ]),
        settings(&[
            (13, 20.0),
            (14, 40.0),
            (15, -20.0),
            (22, -30.0),
            (23, 50.0),
            (31, 10.0),
            (11, 40.0),
            (12, -10.0),
        ]),
        settings(&[
            (37, 210.0),
            (38, 50.0),
            (39, -20.0),
            (43, 40.0),
            (44, 60.0),
            (46, 120.0),
            (47, 15.0),
            (50, 30.0),
        ]),
    ]
}

fn detail_cases() -> Vec<DevelopSettings> {
    vec![
        settings(&[(8, 50.0), (9, 60.0)]),
        settings(&[(10, 40.0), (55, 80.0), (56, 1.5), (58, 30.0)]),
        settings(&[(10, -50.0), (59, 50.0), (60, 60.0), (55, 40.0)]),
    ]
}

#[test]
fn develop_tone_parity__feat__image_editor_filters() {
    let win = stimulus(W, H);
    for s in tone_cases() {
        check(
            parity_windowed(&DEVELOP_TONE, tone_ref, &win, W, H, &s.tone_params()),
            &DEVELOP_TONE,
        );
    }
}

#[test]
fn develop_detail_parity__feat__image_editor_filters() {
    let win = stimulus(W, H);
    for s in detail_cases() {
        check(
            parity_windowed(&DEVELOP_DETAIL, detail_ref, &win, W, H, &s.detail_params()),
            &DEVELOP_DETAIL,
        );
    }
}

#[test]
fn develop_defaults_are_the_identity__feat__image_editor_filters() {
    let id = DevelopSettings::identity();
    assert!(id.is_identity() && id.tone_is_identity() && id.detail_is_identity());
    assert!(id.ops().is_empty(), "the defaults dispatch nothing");
    let win = stimulus(W, H).quantized_px();
    for (i, px) in win.iter().enumerate() {
        let (x, y) = (i as u32 % W, i as u32 / W);
        let t = tone_ref(&win, W, H, x, y, &id.tone_params());
        let d = detail_ref(&win, W, H, x, y, &id.detail_params());
        for c in 0..4 {
            assert!((t.0[c] - px.0[c]).abs() < 1e-6, "tone moved pixel {i}");
        }
        assert_eq!(d.0, px.0, "detail moved pixel {i}");
    }
    // One half at identity is skipped; both halves run tone then detail.
    assert_eq!(settings(&[(2, 1.0)]).ops().len(), 1);
    let both = settings(&[(2, 1.0), (9, 20.0)]).ops();
    assert_eq!(both.len(), 2);
    assert_eq!(both[0].0.id, "develop.tone");
    assert_eq!(both[1].0.id, "develop.detail");
}

#[test]
fn develop_settings_clamp_to_their_ranges__feat__image_editor_filters() {
    assert!(DevelopSettings::from_values(&[0.0; 60]).is_none());
    let mut v = DevelopSettings::identity().0.to_vec();
    v[2] = 9.0;
    v[37] = 500.0;
    v[56] = f32::NAN;
    let s = DevelopSettings::from_values(&v).expect("61 values");
    assert_eq!(s.0[2], 5.0);
    assert_eq!(s.0[37], 360.0);
    assert_eq!(s.0[56], 1.0, "a non-finite value takes its default");
    assert_eq!(s.0.len(), DEVELOP_LEN);
}

fn mean_luma(px: &[Px]) -> f32 {
    px.iter().map(|p| luma(unpremul(*p))).sum::<f32>() / px.len() as f32
}

fn run_tone(win: &[Px], s: &DevelopSettings) -> Vec<Px> {
    (0..W * H)
        .map(|i| tone_ref(win, W, H, i % W, i / W, &s.tone_params()))
        .collect()
}

fn run_detail(win: &[Px], s: &DevelopSettings) -> Vec<Px> {
    (0..W * H)
        .map(|i| detail_ref(win, W, H, i % W, i / W, &s.detail_params()))
        .collect()
}

#[test]
fn develop_exposure_brightens_and_temperature_warms__feat__image_editor_filters() {
    let win = stimulus(W, H).quantized_px();
    let base = mean_luma(&win);
    assert!(mean_luma(&run_tone(&win, &settings(&[(2, 1.0)]))) > base + 0.08);
    assert!(mean_luma(&run_tone(&win, &settings(&[(2, -1.0)]))) < base - 0.05);
    let warm = run_tone(&win, &settings(&[(0, 60.0)]));
    let (mut dr, mut db) = (0.0f32, 0.0f32);
    for (a, b) in win.iter().zip(&warm) {
        let (ca, cb) = (unpremul(*a), unpremul(*b));
        dr += cb[0] - ca[0];
        db += cb[2] - ca[2];
    }
    assert!(dr > 0.0 && db < 0.0, "warmer: red up {dr}, blue down {db}");
}

#[test]
fn develop_saturation_minus_100_is_grey__feat__image_editor_filters() {
    let win = stimulus(W, H).quantized_px();
    for p in run_tone(&win, &settings(&[(12, -100.0)])) {
        let c = unpremul(p);
        assert!(
            (c[0] - c[1]).abs() < 1e-5 && (c[1] - c[2]).abs() < 1e-5,
            "{c:?}"
        );
    }
}

#[test]
fn develop_clarity_raises_local_contrast_and_noise_reduction_lowers_it__feat__image_editor_filters()
{
    let win = stimulus(W, H).quantized_px();
    // Local contrast: the mean absolute difference to the right neighbour.
    let lc = |px: &[Px]| {
        let mut s = 0.0f32;
        for y in 0..H {
            for x in 0..W - 1 {
                let i = (y * W + x) as usize;
                s += (luma(unpremul(px[i])) - luma(unpremul(px[i + 1]))).abs();
            }
        }
        s
    };
    let base = lc(&win);
    assert!(lc(&run_detail(&win, &settings(&[(9, 80.0)]))) > base * 1.05);
    assert!(lc(&run_detail(&win, &settings(&[(8, 80.0)]))) > base * 1.05);
    assert!(lc(&run_detail(&win, &settings(&[(55, 120.0)]))) > base * 1.05);
    assert!(lc(&run_detail(&win, &settings(&[(59, 100.0)]))) < base * 0.95);
    // Dehaze deepens the darks (the dark channel is pushed down).
    let hz = run_detail(&win, &settings(&[(10, 80.0)]));
    assert!(mean_luma(&hz) < mean_luma(&win));
}
