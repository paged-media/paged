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

//! gpu↔ref parity and behaviour proofs for `families::adjust_ext` (WP5.2):
//! Desaturate, Shadows/Highlights, HDR Toning, Match Color, Replace Color.
//! Each scalar twin mirrors its WGSL module step for step (the taps are
//! the same integer offsets, the sums run in the same order), so the
//! declared tolerance is the only slack. Match Color's twin converts with
//! the engine's own `paged_color::lab`, which the module writes out — so
//! the parity also pins the shader to the shared conversion.
//!
//! The parity tests report `unavailable: GPU adapter` without one and fail
//! under `PAGED_REQUIRE_GPU=1` (never a silent pass).
#![allow(non_snake_case)]

use image_conformance::harness::{assert_within, parity_windowed, ParityResult, RefTile};
use image_conformance::Px;
use image_kernels::families::adjust_ext::{
    disc_taps, DesaturateParams, HdrToningParams, MatchColorParams, ReplaceColorParams,
    ShadowsHighlightsParams, ADJUST_DESATURATE, ADJUST_HDR_TONING, ADJUST_MATCH_COLOR,
    ADJUST_REPLACE_COLOR, ADJUST_SHADOWS_HIGHLIGHTS,
};
use image_kernels::KernelDef;

// ───────────────────────────── shared twin ─────────────────────────────

pub(crate) fn unpremul(c: Px) -> [f32; 3] {
    if c.0[3] <= 0.0 {
        return [0.0; 3];
    }
    [0, 1, 2].map(|i| (c.0[i] / c.0[3]).clamp(0.0, 1.0))
}

pub(crate) fn luma(c: [f32; 3]) -> f32 {
    c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722
}

pub(crate) fn texel(win: &[Px], w: u32, h: u32, x: i32, y: i32) -> Px {
    let x = x.clamp(0, w as i32 - 1) as u32;
    let y = y.clamp(0, h as i32 - 1) as u32;
    win[(y * w + x) as usize]
}

pub(crate) fn hue_of(c: [f32; 3]) -> f32 {
    let mx = c[0].max(c[1].max(c[2]));
    let mn = c[0].min(c[1].min(c[2]));
    let d = mx - mn;
    if d <= 0.0 {
        return 0.0;
    }
    let mut h = if mx == c[0] {
        (c[1] - c[2]) / d
    } else if mx == c[1] {
        (c[2] - c[0]) / d + 2.0
    } else {
        (c[0] - c[1]) / d + 4.0
    };
    h *= 60.0;
    if h < 0.0 {
        h += 360.0;
    }
    h
}

pub(crate) fn sat_of(c: [f32; 3]) -> f32 {
    let mx = c[0].max(c[1].max(c[2]));
    let mn = c[0].min(c[1].min(c[2]));
    let l = (mx + mn) * 0.5;
    let d = mx - mn;
    if d <= 0.0 {
        return 0.0;
    }
    d / (1.0 - (2.0 * l - 1.0).abs())
}

pub(crate) fn hsl_rgb(h: f32, s: f32, l: f32) -> [f32; 3] {
    let c = (1.0 - (2.0 * l - 1.0).abs()) * s;
    let hp = h / 60.0;
    let x = c * (1.0 - (hp - 2.0 * (hp * 0.5).floor() - 1.0).abs());
    let rgb = if hp < 1.0 {
        [c, x, 0.0]
    } else if hp < 2.0 {
        [x, c, 0.0]
    } else if hp < 3.0 {
        [0.0, c, x]
    } else if hp < 4.0 {
        [0.0, x, c]
    } else if hp < 5.0 {
        [x, 0.0, c]
    } else {
        [c, 0.0, x]
    };
    rgb.map(|v| v + (l - c * 0.5))
}

pub(crate) fn c01(c: [f32; 3]) -> [f32; 3] {
    c.map(|v| v.clamp(0.0, 1.0))
}

pub(crate) fn out(c: [f32; 3], a: Px) -> Px {
    Px([c[0] * a.0[3], c[1] * a.0[3], c[2] * a.0[3], a.0[3]])
}

/// The disc mean of the luminance, the module's `disc_mean_fn`.
pub(crate) fn disc_mean(win: &[Px], w: u32, h: u32, x: i32, y: i32, taps: &[[i32; 4]; 12]) -> f32 {
    let mut s = luma(unpremul(texel(win, w, h, x, y)));
    for t in taps {
        s += luma(unpremul(texel(win, w, h, x + t[0], y + t[1])));
        s += luma(unpremul(texel(win, w, h, x + t[2], y + t[3])));
    }
    s * 0.04
}

/// A structured stimulus: ramps plus a hashed component (so local means
/// have something to average), a dark and a bright region, and a band at
/// alpha 0.6 (premultiplied) so the dissociation is exercised.
pub(crate) fn stimulus(w: u32, h: u32) -> RefTile {
    RefTile::from_fn(w, h, |x, y| {
        let hsh = |c: u32| ((7 * x + 13 * y + 29 * c + 17 * ((x * y) % 11)) % 257) as f32 / 256.0;
        let base = if x < w / 3 {
            0.15
        } else if x > 2 * w / 3 {
            0.8
        } else {
            0.45
        };
        let a = if (h / 2..h / 2 + 6).contains(&y) {
            0.6
        } else {
            1.0
        };
        let c = [
            (base + 0.25 * (hsh(0) - 0.5) + 0.1 * (y as f32 / h as f32)).clamp(0.0, 1.0),
            (base + 0.2 * (hsh(1) - 0.5)).clamp(0.0, 1.0),
            (base * 0.8 + 0.3 * (hsh(2) - 0.5)).clamp(0.0, 1.0),
        ];
        Px([c[0] * a, c[1] * a, c[2] * a, a])
    })
}

fn check(result: Option<ParityResult>, def: &KernelDef) {
    if let Some(r) = result {
        eprintln!("{}: measured max f16 ULP {}", def.id, r.max_ulp);
        assert_within(r, def);
    }
}

const W: u32 = 48;
const H: u32 = 40;

// ───────────────────────────── desaturate ─────────────────────────────

fn desaturate_ref(win: &[Px], w: u32, _h: u32, x: u32, y: u32, _p: &DesaturateParams) -> Px {
    let a = win[(y * w + x) as usize];
    let c = unpremul(a);
    let l = (c[0].max(c[1].max(c[2])) + c[0].min(c[1].min(c[2]))) * 0.5;
    out([l; 3], a)
}

#[test]
fn adjust_desaturate_parity__feat__image_editor_filters() {
    let win = stimulus(W, H);
    check(
        parity_windowed(
            &ADJUST_DESATURATE,
            desaturate_ref,
            &win,
            W,
            H,
            &DesaturateParams::new(),
        ),
        &ADJUST_DESATURATE,
    );
}

#[test]
fn adjust_desaturate_makes_greys_of_hsl_lightness__feat__image_editor_filters() {
    let win = stimulus(W, H).quantized_px();
    for (i, px) in win.iter().enumerate() {
        let o = desaturate_ref(
            &win,
            W,
            H,
            i as u32 % W,
            i as u32 / W,
            &DesaturateParams::new(),
        );
        let c = unpremul(o);
        assert!(c[0] == c[1] && c[1] == c[2], "a grey at {i}");
        let s = unpremul(*px);
        let want = (s[0].max(s[1]).max(s[2]) + s[0].min(s[1]).min(s[2])) / 2.0;
        assert!((c[0] - want).abs() < 1e-6);
    }
}

// ───────────────────────── shadows / highlights ─────────────────────────

fn smooth01(t: f32) -> f32 {
    let x = t.clamp(0.0, 1.0);
    x * x * (3.0 - 2.0 * x)
}

fn sh_ref(win: &[Px], w: u32, h: u32, x: u32, y: u32, p: &ShadowsHighlightsParams) -> Px {
    let (xi, yi) = (x as i32, y as i32);
    let a = win[(y * w + x) as usize];
    let rgb = unpremul(a);
    let l = luma(rgb);
    let mut dl = 0.0f32;
    if p.sh_amount != 0.0 && p.sh_tone > 0.0 {
        let ms = disc_mean(win, w, h, xi, yi, &p.taps_s);
        let ws = smooth01(1.0 - ms / p.sh_tone);
        dl += p.sh_amount * ws * (1.0 - ms) * 0.8;
    }
    if p.hi_amount != 0.0 && p.hi_tone > 0.0 {
        let mh = disc_mean(win, w, h, xi, yi, &p.taps_h);
        let wh = smooth01((mh - (1.0 - p.hi_tone)) / p.hi_tone);
        dl -= p.hi_amount * wh * mh * 0.8;
    }
    let mut l2 = (l + dl).clamp(0.0, 1.0);
    if p.midtone != 0.0 {
        l2 = (l2 + p.midtone * (l2 - 0.5) * 4.0 * l2 * (1.0 - l2)).clamp(0.0, 1.0);
    }
    let mut o = rgb;
    if l2 != l {
        let k = l2 - l;
        o = c01(rgb.map(|v| v + k));
        if p.color_corr != 0.0 {
            let f = 1.0 + p.color_corr * (k.abs() * 4.0).min(1.0);
            o = c01(o.map(|v| l2 + (v - l2) * f));
        }
    }
    out(o, a)
}

#[test]
fn adjust_shadows_highlights_parity__feat__image_editor_filters() {
    let win = stimulus(W, H);
    for v in [
        [0.35, 0.5, 6.0, 0.0, 0.5, 6.0, 0.2, 0.0],
        [0.7, 0.8, 4.0, 0.5, 0.4, 9.0, 0.4, 0.3],
        [0.0, 0.5, 6.0, 0.0, 0.5, 6.0, 0.0, -0.4],
    ] {
        let p = ShadowsHighlightsParams::from_values(v);
        check(
            parity_windowed(&ADJUST_SHADOWS_HIGHLIGHTS, sh_ref, &win, W, H, &p),
            &ADJUST_SHADOWS_HIGHLIGHTS,
        );
    }
}

#[test]
fn adjust_shadows_highlights_lifts_dark_regions_and_keeps_their_detail__feat__image_editor_filters()
{
    let win = stimulus(W, H).quantized_px();
    let p = ShadowsHighlightsParams::from_values([0.6, 0.6, 6.0, 0.0, 0.5, 6.0, 0.0, 0.0]);
    let (mut before, mut after) = (Vec::new(), Vec::new());
    for y in 0..H / 2 {
        for x in 2..W / 3 - 2 {
            before.push(luma(unpremul(win[(y * W + x) as usize])));
            after.push(luma(unpremul(sh_ref(&win, W, H, x, y, &p))));
        }
    }
    let mean = |v: &[f32]| v.iter().sum::<f32>() / v.len() as f32;
    let sd = |v: &[f32]| {
        let m = mean(v);
        (v.iter().map(|x| (x - m) * (x - m)).sum::<f32>() / v.len() as f32).sqrt()
    };
    assert!(mean(&after) > mean(&before) + 0.1, "the shadows are lifted");
    assert!(
        sd(&after) > 0.6 * sd(&before),
        "the detail inside the region survives (an added lift, not a flattening curve)"
    );
    // A bright region is left alone by the shadow side.
    for y in 0..H / 2 {
        let x = W - 3;
        let i = (y * W + x) as usize;
        let d = (luma(unpremul(sh_ref(&win, W, H, x, y, &p))) - luma(unpremul(win[i]))).abs();
        assert!(d < 0.02, "a bright pixel moved by {d}");
    }
    // Zero amounts: exact identity.
    let id = ShadowsHighlightsParams::from_values([0.0, 0.5, 6.0, 0.0, 0.5, 6.0, 0.5, 0.0]);
    for (i, px) in win.iter().enumerate() {
        let o = sh_ref(&win, W, H, i as u32 % W, i as u32 / W, &id);
        for c in 0..3 {
            assert!((o.0[c] - px.0[c]).abs() < 1e-6);
        }
    }
}

// ──────────────────────────────── hdr ────────────────────────────────

fn hdr_ref(win: &[Px], w: u32, h: u32, x: u32, y: u32, p: &HdrToningParams) -> Px {
    let (xi, yi) = (x as i32, y as i32);
    let a = win[(y * w + x) as usize];
    let rgb = unpremul(a);
    let mut o = rgb;
    let tonal = p.gamma != 1.0
        || p.exposure != 0.0
        || p.detail != 0.0
        || p.shadow != 0.0
        || p.highlight != 0.0;
    if tonal {
        let l = luma(rgb);
        let mut s = l;
        let mut wsum = 1.0f32;
        for t in &p.taps {
            let l1 = luma(unpremul(texel(win, w, h, xi + t[0], yi + t[1])));
            let w1 = 1.0 / (1.0 + p.strength * 8.0 * (l1 - l).abs());
            s += w1 * l1;
            wsum += w1;
            let l2 = luma(unpremul(texel(win, w, h, xi + t[2], yi + t[3])));
            let w2 = 1.0 / (1.0 + p.strength * 8.0 * (l2 - l).abs());
            s += w2 * l2;
            wsum += w2;
        }
        let base = s / wsum;
        let mut b = base.max(0.0);
        if p.gamma != 1.0 {
            b = b.powf(p.gamma.max(0.01));
        }
        if p.exposure != 0.0 {
            b *= p.exposure.exp2();
        }
        if p.shadow != 0.0 {
            b += p.shadow * 0.25 * (1.0 - b) * (1.0 - b);
        }
        if p.highlight != 0.0 {
            b += p.highlight * 0.25 * b * b;
        }
        let l2 = (b + (l - base) * (1.0 + p.detail)).clamp(0.0, 1.0);
        o = c01(rgb.map(|v| v + (l2 - l)));
    }
    if p.vibrance != 0.0 || p.saturation != 0.0 {
        let lum = luma(o);
        let s = o[0].max(o[1].max(o[2])) - o[0].min(o[1].min(o[2]));
        let f = (1.0 + p.saturation + p.vibrance * (1.0 - s)).max(0.0);
        o = c01(o.map(|v| lum + (v - lum) * f));
    }
    out(o, a)
}

#[test]
fn adjust_hdr_toning_parity__feat__image_editor_filters() {
    let win = stimulus(W, H);
    for v in [
        [8.0, 0.5, 1.0, 0.0, 0.6, 0.0, 0.0, 0.0, 0.0],
        [5.0, 1.2, 0.7, 0.4, 0.3, 0.4, -0.3, 0.2, 0.1],
    ] {
        let p = HdrToningParams::from_values(v);
        check(
            parity_windowed(&ADJUST_HDR_TONING, hdr_ref, &win, W, H, &p),
            &ADJUST_HDR_TONING,
        );
    }
}

#[test]
fn adjust_hdr_toning_detail_raises_local_contrast_and_neutral_is_identity__feat__image_editor_filters(
) {
    let win = stimulus(W, H).quantized_px();
    let id = HdrToningParams::from_values([8.0, 0.5, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]);
    let more = HdrToningParams::from_values([8.0, 0.5, 1.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0]);
    let mut spread = (0.0f32, 0.0f32);
    for y in 4..H - 4 {
        for x in W / 3 + 2..2 * W / 3 - 2 {
            let i = (y * W + x) as usize;
            let o = hdr_ref(&win, W, H, x, y, &id);
            for c in 0..4 {
                assert!(
                    (o.0[c] - win[i].0[c]).abs() < 1e-6,
                    "the neutral setting is the identity"
                );
            }
            let m = hdr_ref(&win, W, H, x, y, &more);
            let l0 = luma(unpremul(win[i]));
            spread.0 += (l0 - 0.45).abs();
            spread.1 += (luma(unpremul(m)) - 0.45).abs();
        }
    }
    assert!(
        spread.1 > spread.0 * 1.2,
        "detail +1 spreads the region: {spread:?}"
    );
}

// ─────────────────────────────── match ───────────────────────────────

fn match_ref(win: &[Px], w: u32, _h: u32, x: u32, y: u32, p: &MatchColorParams) -> Px {
    let a = win[(y * w + x) as usize];
    let rgb = unpremul(a);
    let lab = paged_color::lab::srgb_to_lab_d50(rgb);
    let mut t = [0.0f32; 3];
    for i in 0..3 {
        let ratio = p.src_std[i] / p.dst_std[i].max(0.001);
        t[i] = (lab[i] - p.dst_mean[i]) * ratio + p.src_mean[i];
    }
    t = [
        (t[0] * p.luminance).clamp(0.0, 100.0),
        t[1] * p.intensity,
        t[2] * p.intensity,
    ];
    let moved = c01(paged_color::lab::lab_d50_to_srgb_encoded(t[0], t[1], t[2]));
    let o = [0, 1, 2].map(|i| moved[i] * (1.0 - p.fade) + rgb[i] * p.fade);
    out(o, a)
}

#[test]
fn adjust_match_color_parity__feat__image_editor_filters() {
    let win = stimulus(W, H);
    let src = [60.0, 10.0, -5.0, 20.0, 8.0, 10.0];
    let dst = [45.0, 2.0, 6.0, 25.0, 5.0, 7.0];
    for (lum, int, fade) in [(1.0, 1.0, 0.0), (1.2, 0.6, 0.3)] {
        let p = MatchColorParams::new(src, dst, lum, int, fade);
        check(
            parity_windowed(&ADJUST_MATCH_COLOR, match_ref, &win, W, H, &p),
            &ADJUST_MATCH_COLOR,
        );
    }
}

/// The transfer moves the image's statistics onto the source's: measured
/// with the same CPU readout the door uses.
#[test]
fn adjust_match_color_transfers_the_source_statistics__feat__image_editor_filters() {
    let win = stimulus(W, H).quantized_px();
    let to_rgba8 = |px: &[Px]| -> Vec<u8> {
        px.iter()
            .flat_map(|p| {
                let c = unpremul(*p);
                [
                    (c[0] * 255.0).round() as u8,
                    (c[1] * 255.0).round() as u8,
                    (c[2] * 255.0).round() as u8,
                    255,
                ]
            })
            .collect()
    };
    let dst = image_js::adjust_readouts::color_stats(&to_rgba8(&win), W, H, None).expect("stats");
    let src = [62.0, 18.0, -12.0, 12.0, 6.0, 9.0];
    let p = MatchColorParams::new(src, dst, 1.0, 1.0, 0.0);
    let moved: Vec<Px> = (0..W * H)
        .map(|i| match_ref(&win, W, H, i % W, i / W, &p))
        .collect();
    let got = image_js::adjust_readouts::color_stats(&to_rgba8(&moved), W, H, None).expect("stats");
    for i in 0..3 {
        assert!(
            (got[i] - src[i]).abs() < 2.0,
            "mean {i}: {} vs {}",
            got[i],
            src[i]
        );
        assert!(
            (got[3 + i] - src[3 + i]).abs() < 2.5,
            "std {i}: {} vs {}",
            got[3 + i],
            src[3 + i]
        );
    }
    // Fade 1 is the identity.
    let p1 = MatchColorParams::new(src, dst, 1.0, 1.0, 1.0);
    for (i, px) in win.iter().enumerate() {
        let o = match_ref(&win, W, H, i as u32 % W, i as u32 / W, &p1);
        for c in 0..3 {
            assert!((o.0[c] - px.0[c]).abs() < 1e-6);
        }
    }
}

// ────────────────────────────── replace ──────────────────────────────

fn replace_ref(win: &[Px], w: u32, _h: u32, x: u32, y: u32, p: &ReplaceColorParams) -> Px {
    let a = win[(y * w + x) as usize];
    let rgb = unpremul(a);
    let mut o = rgb;
    if p.hue != 0.0 || p.saturation != 0.0 || p.lightness != 0.0 {
        let dv = [rgb[0] - p.r, rgb[1] - p.g, rgb[2] - p.b];
        let dist = (dv[0] * dv[0] + dv[1] * dv[1] + dv[2] * dv[2]).sqrt() * 255.0;
        let wgt = if p.fuzziness > 0.0 {
            (1.0 - dist / p.fuzziness).clamp(0.0, 1.0)
        } else if dist == 0.0 {
            1.0
        } else {
            0.0
        };
        if wgt > 0.0 {
            let mx = rgb[0].max(rgb[1].max(rgb[2]));
            let mn = rgb[0].min(rgb[1].min(rgb[2]));
            let l = (mx + mn) * 0.5;
            let mut h = hue_of(rgb) + p.hue;
            h -= 360.0 * (h / 360.0).floor();
            let mut s = sat_of(rgb);
            if p.saturation >= 0.0 {
                if p.saturation < 1.0 {
                    s = (s / (1.0 - p.saturation)).min(1.0);
                } else if s > 0.0 {
                    s = 1.0;
                }
            } else {
                s *= 1.0 + p.saturation;
            }
            let mut c = c01(hsl_rgb(h, s.clamp(0.0, 1.0), l));
            c = if p.lightness >= 0.0 {
                c.map(|v| v + (1.0 - v) * p.lightness)
            } else {
                c.map(|v| v * (1.0 + p.lightness))
            };
            let c = c01(c);
            o = [0, 1, 2].map(|i| rgb[i] * (1.0 - wgt) + c[i] * wgt);
        }
    }
    out(o, a)
}

#[test]
fn adjust_replace_color_parity__feat__image_editor_filters() {
    let win = stimulus(W, H);
    for p in [
        ReplaceColorParams::new([0.45, 0.45, 0.36], 60.0, 120.0, 0.2, 0.1),
        ReplaceColorParams::new([0.15, 0.15, 0.12], 120.0, -40.0, -0.5, -0.2),
    ] {
        check(
            parity_windowed(&ADJUST_REPLACE_COLOR, replace_ref, &win, W, H, &p),
            &ADJUST_REPLACE_COLOR,
        );
    }
}

#[test]
fn adjust_replace_color_recolours_only_near_the_sample__feat__image_editor_filters() {
    let red = Px([0.8, 0.1, 0.1, 1.0]);
    let blue = Px([0.1, 0.2, 0.9, 1.0]);
    let win = vec![red, blue];
    let p = ReplaceColorParams::new([0.8, 0.1, 0.1], 40.0, 120.0, 0.0, 0.0);
    let r = unpremul(replace_ref(&win, 2, 1, 0, 0, &p));
    assert!(r[1] > r[0], "red turned toward green: {r:?}");
    let b = replace_ref(&win, 2, 1, 1, 0, &p);
    assert_eq!(b.0, blue.0, "a far colour is untouched");
    let id = ReplaceColorParams::new([0.8, 0.1, 0.1], 200.0, 0.0, 0.0, 0.0);
    assert_eq!(replace_ref(&win, 2, 1, 0, 0, &id).0, red.0);
}

/// The CPU taps the kernels read are the sunflower at the radius: radius
/// 0 is the centre, and every tap lies inside the disc.
#[test]
fn adjust_ext_disc_taps_stay_inside_the_radius__feat__image_editor_filters() {
    assert_eq!(disc_taps(0.0), [[0; 4]; 12]);
    for r in [1.0f32, 4.0, 30.0, 64.0] {
        let t = disc_taps(r);
        for q in t {
            for k in [0, 2] {
                let d = ((q[k] * q[k] + q[k + 1] * q[k + 1]) as f32).sqrt();
                assert!(d <= r + 0.75, "tap {q:?} outside radius {r}");
            }
        }
    }
}
