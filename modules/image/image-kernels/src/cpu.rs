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

//! The CPU twins that SHIP (feature `cpu`; ADR 465, the exception to
//! ADR 450).
//!
//! One scalar function per kernel the adjustment chain dispatches, so a
//! region filter can run where no GPU device exists (the Node CLI, a
//! headless host). The GPU stays the path wherever a device is present;
//! these run only when there is none.
//!
//! Each body mirrors its WGSL module term for term, in the same
//! evaluation order, over [`Px`] in `f32` — the same rule the test-only
//! references follow (ADR 451). They are held to each kernel's declared
//! `gpu_tolerance` against those references and, on a GPU lane, against
//! the shader itself (`image-conformance/tests/it/cpu_twins.rs`).
//!
//! The ABI mask (`mix(a, result, m)`) and the f16 storage between stages
//! are the caller's: a twin computes `result` for one pixel.

use crate::families::adjust::{
    adjust_invert_rgb, AdjustBlackWhiteParams, AdjustBrightnessContrastParams,
    AdjustChannelMixerParams, AdjustColorBalanceParams, AdjustExposureParams,
    AdjustHueRotateParams, AdjustHueSaturationParams, AdjustInvertRgbParams, AdjustLevelsParams,
    AdjustLevelsRgbParams, AdjustPhotoFilterParams, AdjustPosterizeParams, AdjustSaturationParams,
    AdjustThresholdParams, AdjustVibranceParams, AdjustWhiteBalanceParams, ADJUST_BLACK_WHITE,
    ADJUST_BRIGHTNESS_CONTRAST, ADJUST_CHANNEL_MIXER, ADJUST_COLOR_BALANCE, ADJUST_EXPOSURE,
    ADJUST_HUE_ROTATE, ADJUST_HUE_SATURATION, ADJUST_INVERT_RGB, ADJUST_LEVELS, ADJUST_LEVELS_RGB,
    ADJUST_PHOTO_FILTER, ADJUST_POSTERIZE, ADJUST_SATURATION, ADJUST_THRESHOLD, ADJUST_VIBRANCE,
    ADJUST_WHITE_BALANCE,
};
use crate::families::conv::{
    ConvGaussianParams, ConvUnsharpParams, CONV_GAUSSIAN_H, CONV_GAUSSIAN_V, CONV_UNSHARP,
    GAUSSIAN_MAX_RADIUS,
};
pub use crate::reference_prelude::Px;
use crate::KernelDef;

/// Every kernel with a shipped CPU twin: exactly the kernels the
/// adjustment chain (`image-js` `adjust_stages`) dispatches. A kernel
/// joins this list only with its twin and its tolerance test.
pub static CPU_KERNELS: &[&KernelDef] = &[
    &ADJUST_EXPOSURE,
    &ADJUST_WHITE_BALANCE,
    &ADJUST_LEVELS,
    &ADJUST_LEVELS_RGB,
    &ADJUST_BRIGHTNESS_CONTRAST,
    &ADJUST_COLOR_BALANCE,
    &ADJUST_PHOTO_FILTER,
    &ADJUST_CHANNEL_MIXER,
    &ADJUST_VIBRANCE,
    &ADJUST_SATURATION,
    &ADJUST_BLACK_WHITE,
    &ADJUST_POSTERIZE,
    &ADJUST_THRESHOLD,
    &ADJUST_HUE_ROTATE,
    &ADJUST_HUE_SATURATION,
    &ADJUST_INVERT_RGB,
    &CONV_GAUSSIAN_H,
    &CONV_GAUSSIAN_V,
    &CONV_UNSHARP,
];

/// The module preamble's `unpremul_rgb` (zero alpha → 0).
fn unpremul_rgb(a: Px) -> [f32; 3] {
    let al = a.0[3];
    if al == 0.0 {
        [0.0; 3]
    } else {
        [a.0[0] / al, a.0[1] / al, a.0[2] / al]
    }
}

/// `vec4(cp * a.a, a.a)`.
fn repremul(cp: [f32; 3], al: f32) -> Px {
    Px([cp[0] * al, cp[1] * al, cp[2] * al, al])
}

/// `0.3 r + 0.59 g + 0.11 b`, summed left to right.
fn lum3(c: [f32; 3]) -> f32 {
    0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2]
}

/// WGSL `smoothstep`.
fn smoothstep(e0: f32, e1: f32, x: f32) -> f32 {
    let t = ((x - e0) / (e1 - e0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// WGSL `mix` on scalars.
fn mix1(x: f32, y: f32, t: f32) -> f32 {
    x * (1.0 - t) + y * t
}

/// `adjust.exposure`.
pub fn exposure(a: Px, p: &AdjustExposureParams) -> Px {
    let k = p.ev.exp2();
    if p.encoding == 0 {
        return Px([a.0[0] * k, a.0[1] * k, a.0[2] * k, a.0[3]]);
    }
    let al = a.0[3];
    if al == 0.0 {
        return a;
    }
    let decode = |c: f32| c.max(0.0).powf(2.2);
    let encode = |l: f32| l.max(0.0).powf(1.0 / 2.2);
    let c = [a.0[0] / al, a.0[1] / al, a.0[2] / al];
    repremul(c.map(|x| encode(decode(x) * k)), al)
}

/// `adjust.brightness_contrast`.
pub fn brightness_contrast(a: Px, p: &AdjustBrightnessContrastParams) -> Px {
    let c = unpremul_rgb(a);
    repremul(
        c.map(|x| (x - 0.5) * p.contrast + (0.5 + p.brightness)),
        a.0[3],
    )
}

/// `adjust.levels`.
pub fn levels(a: Px, p: &AdjustLevelsParams) -> Px {
    let c = unpremul_rgb(a);
    let cp = c.map(|x| {
        let t0 = (x - p.in_black) / (p.in_white - p.in_black);
        let t1 = t0.clamp(0.0, 1.0);
        let t2 = t1.powf(1.0 / p.gamma);
        p.out_black + t2 * (p.out_white - p.out_black)
    });
    repremul(cp, a.0[3])
}

/// `adjust.levels_rgb`.
pub fn levels_rgb(a: Px, p: &AdjustLevelsRgbParams) -> Px {
    let c = unpremul_rgb(a);
    let ch = |x: f32, ib: f32, iw: f32, ga: f32| {
        let t0 = (x - ib) / (iw - ib);
        t0.clamp(0.0, 1.0).powf(1.0 / ga)
    };
    repremul(
        [
            ch(c[0], p.r_in_black, p.r_in_white, p.r_gamma),
            ch(c[1], p.g_in_black, p.g_in_white, p.g_gamma),
            ch(c[2], p.b_in_black, p.b_in_white, p.b_gamma),
        ],
        a.0[3],
    )
}

/// `adjust.saturation`.
pub fn saturation(a: Px, p: &AdjustSaturationParams) -> Px {
    let c = unpremul_rgb(a);
    let lum = lum3(c);
    repremul(c.map(|x| mix1(lum, x, p.sat)), a.0[3])
}

/// `adjust.hue_rotate`: the luminance-preserving rotation matrix.
pub fn hue_rotate(a: Px, p: &AdjustHueRotateParams) -> Px {
    let c = unpremul_rgb(a);
    let theta = p.degrees * std::f32::consts::PI / 180.0;
    let cs = theta.cos();
    let sn = theta.sin();
    let rr = (0.213 + cs * 0.787 + sn * (-0.213)) * c[0]
        + (0.715 + cs * (-0.715) + sn * (-0.715)) * c[1]
        + (0.072 + cs * (-0.072) + sn * 0.928) * c[2];
    let gg = (0.213 + cs * (-0.213) + sn * 0.143) * c[0]
        + (0.715 + cs * 0.285 + sn * 0.140) * c[1]
        + (0.072 + cs * (-0.072) + sn * (-0.283)) * c[2];
    let bb = (0.213 + cs * (-0.213) + sn * (-0.787)) * c[0]
        + (0.715 + cs * (-0.715) + sn * 0.715) * c[1]
        + (0.072 + cs * 0.928 + sn * 0.072) * c[2];
    repremul([rr, gg, bb], a.0[3])
}

/// `adjust.white_balance`.
pub fn white_balance(a: Px, p: &AdjustWhiteBalanceParams) -> Px {
    let c = unpremul_rgb(a);
    let gain = [1.0 + p.temp, 1.0 + p.tint, 1.0 - p.temp];
    repremul([c[0] * gain[0], c[1] * gain[1], c[2] * gain[2]], a.0[3])
}

/// `adjust.vibrance`.
pub fn vibrance(a: Px, p: &AdjustVibranceParams) -> Px {
    let c = unpremul_rgb(a);
    let lum = lum3(c);
    let mx = c[0].max(c[1].max(c[2]));
    let mn = c[0].min(c[1].min(c[2]));
    let f = 1.0 + p.saturation + p.vibrance * (1.0 - (mx - mn));
    repremul(c.map(|x| mix1(lum, x, f)), a.0[3])
}

/// `adjust.color_balance`.
pub fn color_balance(a: Px, p: &AdjustColorBalanceParams) -> Px {
    let c = unpremul_rgb(a);
    let lum = lum3(c);
    let ws = 1.0 - smoothstep(0.0, 0.5, lum);
    let wh = smoothstep(0.5, 1.0, lum);
    let wm = 1.0 - ws - wh;
    let rr = c[0] + p.sh_cr * ws + p.mid_cr * wm + p.hi_cr * wh;
    let gg = c[1] + p.sh_mg * ws + p.mid_mg * wm + p.hi_mg * wh;
    let bb = c[2] + p.sh_yb * ws + p.mid_yb * wm + p.hi_yb * wh;
    let d = lum - lum3([rr, gg, bb]);
    repremul([rr, gg, bb].map(|x| (x + d).clamp(0.0, 1.0)), a.0[3])
}

/// `adjust.black_white`: the six-sector grey mix.
pub fn black_white(a: Px, p: &AdjustBlackWhiteParams) -> Px {
    let [r, g, b] = unpremul_rgb(a);
    let gray = if r >= g && g >= b {
        b + (g - b) * p.yellows + (r - g) * p.reds
    } else if r >= b && b >= g {
        g + (b - g) * p.magentas + (r - b) * p.reds
    } else if g >= r && r >= b {
        b + (r - b) * p.yellows + (g - r) * p.greens
    } else if g >= b && b >= r {
        r + (b - r) * p.cyans + (g - b) * p.greens
    } else if b >= g && g >= r {
        r + (g - r) * p.cyans + (b - g) * p.blues
    } else {
        g + (r - g) * p.magentas + (b - r) * p.blues
    };
    let gc = gray.clamp(0.0, 1.0);
    repremul([gc; 3], a.0[3])
}

/// `adjust.posterize`.
pub fn posterize(a: Px, p: &AdjustPosterizeParams) -> Px {
    let c = unpremul_rgb(a);
    let n = p.levels.max(2.0);
    repremul(
        c.map(|x| ((x.clamp(0.0, 1.0) * n).floor() / (n - 1.0)).min(1.0)),
        a.0[3],
    )
}

/// `adjust.threshold`: compared in premultiplied space, as the shader does.
pub fn threshold(a: Px, p: &AdjustThresholdParams) -> Px {
    let lum_p = 0.3 * a.0[0] + 0.59 * a.0[1] + 0.11 * a.0[2];
    let v = if lum_p >= p.threshold * a.0[3] {
        a.0[3]
    } else {
        0.0
    };
    Px([v, v, v, a.0[3]])
}

/// `adjust.photo_filter`.
pub fn photo_filter(a: Px, p: &AdjustPhotoFilterParams) -> Px {
    let c = unpremul_rgb(a);
    let tinted = [c[0] * p.fr, c[1] * p.fg, c[2] * p.fb];
    let mut cp = [
        mix1(c[0], tinted[0], p.density),
        mix1(c[1], tinted[1], p.density),
        mix1(c[2], tinted[2], p.density),
    ];
    if p.preserve != 0 {
        let d = lum3(c) - lum3(cp);
        cp = cp.map(|x| (x + d).clamp(0.0, 1.0));
    }
    repremul(cp, a.0[3])
}

/// `adjust.channel_mixer`.
pub fn channel_mixer(a: Px, p: &AdjustChannelMixerParams) -> Px {
    let c = unpremul_rgb(a);
    repremul(
        [
            p.rr * c[0] + p.rg * c[1] + p.rb * c[2] + p.rc,
            p.gr * c[0] + p.gg * c[1] + p.gb * c[2] + p.gc,
            p.br * c[0] + p.bg * c[1] + p.bb * c[2] + p.bc,
        ],
        a.0[3],
    )
}

/// `adjust.hue_saturation`: the HSL round trip, the six range weights,
/// colorize.
pub fn hue_saturation(a: Px, p: &AdjustHueSaturationParams) -> Px {
    fn to_hsl(c: [f32; 3]) -> [f32; 3] {
        let mx = c[0].max(c[1].max(c[2]));
        let mn = c[0].min(c[1].min(c[2]));
        let l = (mx + mn) * 0.5;
        let d = mx - mn;
        if d <= 0.0 {
            return [0.0, 0.0, l];
        }
        let s = if l > 0.5 {
            d / (2.0 - mx - mn)
        } else {
            d / (mx + mn)
        };
        let h = if mx == c[0] {
            let h = (c[1] - c[2]) / d;
            if c[1] < c[2] {
                h + 6.0
            } else {
                h
            }
        } else if mx == c[1] {
            (c[2] - c[0]) / d + 2.0
        } else {
            (c[0] - c[1]) / d + 4.0
        };
        [h * 60.0, s, l]
    }
    fn channel(p: f32, q: f32, t0: f32) -> f32 {
        let mut t = t0;
        if t < 0.0 {
            t += 1.0;
        }
        if t > 1.0 {
            t -= 1.0;
        }
        if t < 1.0 / 6.0 {
            return p + (q - p) * 6.0 * t;
        }
        if t < 0.5 {
            return q;
        }
        if t < 2.0 / 3.0 {
            return p + (q - p) * (2.0 / 3.0 - t) * 6.0;
        }
        p
    }
    fn to_rgb(h: f32, s: f32, l: f32) -> [f32; 3] {
        if s <= 0.0 {
            return [l, l, l];
        }
        let q = if l < 0.5 {
            l * (1.0 + s)
        } else {
            l + s - l * s
        };
        let pp = 2.0 * l - q;
        let hh = h / 360.0;
        [
            channel(pp, q, hh + 1.0 / 3.0),
            channel(pp, q, hh),
            channel(pp, q, hh - 1.0 / 3.0),
        ]
    }
    let c = unpremul_rgb(a).map(|x| x.clamp(0.0, 1.0));
    let hsl = to_hsl(c);
    let (mut dh, mut ds, mut dl) = (p.master[0], p.master[1], p.master[2]);
    if hsl[1] > 0.0 {
        for (k, r) in p.ranges.iter().enumerate() {
            let mut d = (hsl[0] - k as f32 * 60.0).abs();
            d = d.min(360.0 - d);
            let w = ((45.0 - d) / 30.0).clamp(0.0, 1.0);
            dh += w * r[0];
            ds += w * r[1];
            dl += w * r[2];
        }
    }
    let mut h = hsl[0] + dh;
    h -= 360.0 * (h / 360.0).floor();
    let mut s = hsl[1];
    if p.colorize[0] != 0.0 {
        h = p.colorize[1];
        s = p.colorize[2];
        dl += p.colorize[3];
    }
    s = if ds >= 1.0 {
        if s > 0.0 {
            1.0
        } else {
            0.0
        }
    } else if ds >= 0.0 {
        (s / (1.0 - ds)).min(1.0)
    } else {
        s * (1.0 + ds)
    };
    s = s.clamp(0.0, 1.0);
    let o = to_rgb(h, s, hsl[2]).map(|c| {
        let c = if dl >= 0.0 {
            c + (1.0 - c) * dl
        } else {
            c * (1.0 + dl)
        };
        c.clamp(0.0, 1.0)
    });
    repremul(o, a.0[3])
}

/// `adjust.invert_rgb`: the `kernel_family!` twin itself (one expression
/// feeds the shader and this function, ADR 451).
pub fn invert_rgb(a: Px) -> Px {
    adjust_invert_rgb(a, a, &AdjustInvertRgbParams::new())
}

/// The normalised weights of one Gaussian pass, `w_i / S` for
/// `i = -r..=r` with `r = min(radius, 24)`; `S` summed ascending, as the
/// shader does.
pub fn gaussian_weights(p: &ConvGaussianParams) -> Vec<f32> {
    let r = p.radius.min(u32::from(GAUSSIAN_MAX_RADIUS)) as i32;
    let inv2s2 = 1.0 / (2.0 * p.sigma * p.sigma);
    let w = |i: i32| {
        let fi = i as f32;
        (-(fi * fi) * inv2s2).exp()
    };
    let mut s = 0.0f32;
    for i in -r..=r {
        s += w(i);
    }
    (-r..=r).map(|i| w(i) / s).collect()
}

/// One output of `conv.gaussian_h` or `conv.gaussian_v`: `sample(i)` is
/// the input `i` texels along the pass's axis from the centre (the
/// caller clamps to the image edge, as the pipeline's window does);
/// `weights` from [`gaussian_weights`]. Accumulated ascending.
pub fn gaussian_axis(sample: impl Fn(i32) -> Px, weights: &[f32]) -> Px {
    let r = (weights.len() / 2) as i32;
    let mut acc = Px([0.0; 4]);
    for (k, &w) in weights.iter().enumerate() {
        let px = sample(k as i32 - r);
        acc = acc + px.map(|c| c * w);
    }
    acc
}

/// `conv.unsharp`: `a + amount·(a − b)` per channel where `|a − b|`
/// exceeds the threshold.
pub fn unsharp(a: Px, b: Px, p: &ConvUnsharpParams) -> Px {
    let mut out = [0.0f32; 4];
    for (c, o) in out.iter_mut().enumerate() {
        let delta = a.0[c] - b.0[c];
        *o = if delta.abs() > p.threshold {
            a.0[c] + p.amount * delta
        } else {
            a.0[c]
        };
    }
    Px(out)
}
