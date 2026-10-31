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

//! Develop (WP5.2): the Camera Raw-class adjustment's kernels.
//!
//! One settings block of [`DEVELOP_LEN`] values in Lightroom / Camera Raw
//! units ([`DevelopSettings`], the layout below) drives two kernels:
//!
//! * `develop.tone` — a POINT kernel: white balance and exposure (in
//!   linear light), contrast, highlights / shadows / whites / blacks, the
//!   parametric tone curve, HSL per colour range, vibrance / saturation
//!   and colour grading (shadow / midtone / highlight / global wheels with
//!   blending and balance);
//! * `develop.detail` — the NEIGHBOURHOOD stages: noise reduction
//!   (luminance and colour, a 5×5 window), dehaze (a dark-channel
//!   estimate with the airlight taken as white), texture and clarity
//!   (local contrast against the mean at 3 px and at 20 px) and sharpening
//!   (an unsharp mask with radius, detail and masking). Each stage reads
//!   its statistic from the INPUT neighbourhood and adds its change to the
//!   centre pixel; the stages are not cascaded through one another, which
//!   one pass cannot do.
//!
//! Both are `Point` modules that read neighbours from the whole image in
//! `in0`, the way the doors and the layer fold bind it. Disc
//! neighbourhoods arrive as INTEGER tap offsets from the CPU
//! (`adjust_ext::disc_taps`), the sharpening weights as numbers, so the
//! shader does no floating-point coordinate maths.
//!
//! Every stage is SKIPPED when its parameters are at their defaults, so
//! the defaults are the exact identity ([`DevelopSettings::identity`]).
//!
//! ```text
//!  0 temperature −100..100     1 tint −100..100       2 exposure −5..5 EV
//!  3 contrast                  4 highlights           5 shadows
//!  6 whites                    7 blacks               8 texture
//!  9 clarity                  10 dehaze              11 vibrance
//! 12 saturation                                      (3..12: −100..100)
//! 13..36 HSL: 8 ranges (red, orange, yellow, green, aqua, blue, purple,
//!        magenta) × (hue, saturation, luminance) −100..100 at 13 + 3·r + k
//! 37..39 grading shadows (hue 0..360, saturation 0..100, luminance −100..100)
//! 40..42 midtones   43..45 highlights   46..48 global
//! 49 blending 0..100 (50)   50 balance −100..100
//! 51..54 parametric curve: highlights, lights, darks, shadows −100..100
//! 55 sharpen amount 0..150  56 radius 0.5..3 (1)  57 detail 0..100 (25)
//! 58 masking 0..100         59 noise reduction luminance 0..100
//! 60 noise reduction colour 0..100
//! ```
//!
//! Provenance: the controls are the published Lightroom / Camera Raw
//! ones; their curves here are this kernel's own smooth weightings (no
//! Adobe code read, no reference implementation read). Dark-channel
//! dehazing is He, Sun & Tang (CVPR 2009); unsharp masking and local
//! contrast are textbook; HSL is Smith (SIGGRAPH 1978); the sRGB transfer
//! is IEC 61966-2-1.

use crate::families::adjust_ext::disc_taps;
use crate::{KernelClass, KernelDef, ParamField, ParamsLayout, Tolerance};

/// The settings block's length.
pub const DEVELOP_LEN: usize = 61;

/// Indices of the defaults that are not zero.
pub const DEVELOP_BLENDING: usize = 49;
pub const DEVELOP_SHARPEN_RADIUS: usize = 56;
pub const DEVELOP_SHARPEN_DETAIL: usize = 57;

/// Radii of the detail stages' disc neighbourhoods, in px.
pub const TEXTURE_RADIUS: f32 = 3.0;
pub const CLARITY_RADIUS: f32 = 20.0;
pub const DEHAZE_RADIUS: f32 = 10.0;

/// The Develop settings (see the module docs for the layout).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DevelopSettings(pub [f32; DEVELOP_LEN]);

impl Default for DevelopSettings {
    fn default() -> Self {
        Self::identity()
    }
}

impl DevelopSettings {
    /// Every control at its default: the identity.
    pub fn identity() -> Self {
        let mut s = [0.0f32; DEVELOP_LEN];
        s[DEVELOP_BLENDING] = 50.0;
        s[DEVELOP_SHARPEN_RADIUS] = 1.0;
        s[DEVELOP_SHARPEN_DETAIL] = 25.0;
        Self(s)
    }

    /// The control's range `(min, max)` at index `i`.
    pub fn range(i: usize) -> (f32, f32) {
        match i {
            2 => (-5.0, 5.0),
            37 | 40 | 43 | 46 => (0.0, 360.0),
            38 | 41 | 44 | 47 | 49 => (0.0, 100.0),
            55 => (0.0, 150.0),
            56 => (0.5, 3.0),
            57..=60 => (0.0, 100.0),
            _ => (-100.0, 100.0),
        }
    }

    /// From `values`, every value clamped to its range (a non-finite one
    /// takes its default); `None` when the length is not [`DEVELOP_LEN`].
    pub fn from_values(values: &[f32]) -> Option<Self> {
        if values.len() != DEVELOP_LEN {
            return None;
        }
        let d = Self::identity();
        let mut s = [0.0f32; DEVELOP_LEN];
        for (i, v) in values.iter().enumerate() {
            let (lo, hi) = Self::range(i);
            s[i] = if v.is_finite() {
                v.clamp(lo, hi)
            } else {
                d.0[i]
            };
        }
        Some(Self(s))
    }

    /// Do the point stages leave every pixel as it is?
    pub fn tone_is_identity(&self) -> bool {
        let s = &self.0;
        let zero = |r: std::ops::RangeInclusive<usize>| r.into_iter().all(|i| s[i] == 0.0);
        zero(0..=7)
            && zero(11..=36)
            && [38, 39, 41, 42, 44, 45, 47, 48]
                .iter()
                .all(|&i| s[i] == 0.0)
            && zero(51..=54)
    }

    /// Do the neighbourhood stages leave every pixel as it is?
    pub fn detail_is_identity(&self) -> bool {
        let s = &self.0;
        [8, 9, 10, 55, 59, 60].iter().all(|&i| s[i] == 0.0)
    }

    pub fn is_identity(&self) -> bool {
        self.tone_is_identity() && self.detail_is_identity()
    }

    /// The settings as the shader's 16 `vec4<f32>`.
    pub fn packed(&self) -> [[f32; 4]; 16] {
        let mut out = [[0.0f32; 4]; 16];
        for (i, v) in self.0.iter().enumerate() {
            out[i / 4][i % 4] = *v;
        }
        out
    }

    pub fn tone_params(&self) -> DevelopToneParams {
        DevelopToneParams { s: self.packed() }
    }

    pub fn detail_params(&self) -> DevelopDetailParams {
        let r = self.0[DEVELOP_SHARPEN_RADIUS].clamp(0.5, 3.0);
        let taps = disc_taps(r * 1.5);
        // Gaussian weights of the sharpening blur (σ = radius), centre
        // first, normalised to sum 1.
        let mut w = [0.0f32; 28];
        w[0] = 1.0;
        for i in 0..24 {
            let t = taps[i / 2];
            let (x, y) = if i % 2 == 0 {
                (t[0], t[1])
            } else {
                (t[2], t[3])
            };
            let d2 = (x * x + y * y) as f32;
            w[i + 1] = (-d2 / (2.0 * r * r)).exp();
        }
        let sum: f32 = w.iter().sum();
        for v in w.iter_mut() {
            *v /= sum;
        }
        let mut w_sharp = [[0.0f32; 4]; 7];
        for (i, v) in w.iter().enumerate() {
            w_sharp[i / 4][i % 4] = *v;
        }
        DevelopDetailParams {
            s: self.packed(),
            taps_tex: disc_taps(TEXTURE_RADIUS),
            taps_clar: disc_taps(CLARITY_RADIUS),
            taps_haze: disc_taps(DEHAZE_RADIUS),
            taps_sharp: taps,
            w_sharp,
        }
    }

    /// The kernels a Develop pass runs, in order, skipping the identity
    /// halves: tone first, then detail.
    pub fn ops(&self) -> Vec<(&'static KernelDef, Vec<u8>)> {
        let mut out = Vec::new();
        if !self.tone_is_identity() {
            out.push((
                &DEVELOP_TONE,
                ::bytemuck::bytes_of(&self.tone_params()).to_vec(),
            ));
        }
        if !self.detail_is_identity() {
            out.push((
                &DEVELOP_DETAIL,
                ::bytemuck::bytes_of(&self.detail_params()).to_vec(),
            ));
        }
        out
    }
}

/// `develop.tone` params: the settings block.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, ::bytemuck::Pod, ::bytemuck::Zeroable)]
pub struct DevelopToneParams {
    pub s: [[f32; 4]; 16],
}

impl DevelopToneParams {
    pub fn as_bytes(&self) -> &[u8] {
        ::bytemuck::bytes_of(self)
    }
}

/// `develop.detail` params: the settings block, the four disc
/// neighbourhoods (texture 3 px, clarity 20 px, dehaze 10 px, the
/// sharpening disc at 1.5 × its radius) and the sharpening weights
/// (centre first, then the 24 taps; sum 1).
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, ::bytemuck::Pod, ::bytemuck::Zeroable)]
pub struct DevelopDetailParams {
    pub s: [[f32; 4]; 16],
    pub taps_tex: [[i32; 4]; 12],
    pub taps_clar: [[i32; 4]; 12],
    pub taps_haze: [[i32; 4]; 12],
    pub taps_sharp: [[i32; 4]; 12],
    pub w_sharp: [[f32; 4]; 7],
}

impl DevelopDetailParams {
    pub fn as_bytes(&self) -> &[u8] {
        ::bytemuck::bytes_of(self)
    }
}

macro_rules! develop_common {
    () => {
        "
@group(0) @binding(0) var in0 : texture_2d<f32>;
@group(1) @binding(0) var<uniform> params : Params;
@group(2) @binding(0) var mask : texture_2d<f32>;
@group(3) @binding(0) var outp : texture_storage_2d<rgba16float, write>;

fn S(i: u32) -> f32 { return params.s[i / 4u][i % 4u]; }

fn unpremul(c: vec4<f32>) -> vec3<f32> {
    if (c.a <= 0.0) { return vec3<f32>(0.0); }
    return clamp(c.rgb / c.a, vec3<f32>(0.0), vec3<f32>(1.0));
}

fn luma(c: vec3<f32>) -> f32 {
    return c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722;
}

fn texel(p: vec2<i32>) -> vec4<f32> {
    let d = vec2<i32>(textureDimensions(in0));
    return textureLoad(in0, clamp(p, vec2<i32>(0), d - vec2<i32>(1)), 0);
}

fn c01(v: vec3<f32>) -> vec3<f32> { return clamp(v, vec3<f32>(0.0), vec3<f32>(1.0)); }
"
    };
}

/// The point stages (see the module docs).
pub static DEVELOP_TONE: KernelDef = KernelDef {
    id: "develop.tone",
    class: KernelClass::Point,
    inputs: 1,
    params: ParamsLayout {
        size: ::core::mem::size_of::<DevelopToneParams>(),
        fields: &[ParamField {
            name: "s",
            wgsl_ty: "array<vec4<f32>, 16>",
        }],
    },
    wgsl: DEVELOP_TONE_WGSL,
    module: true,
    mip_exact: true,
    gpu_tolerance: Tolerance::ChannelEpsF16(4),
};

const DEVELOP_TONE_WGSL: &str = concat!(
    "// paged.image kernel `develop.tone` — handwritten under ABI v1.1.
// AGPL-3.0-only OR LicenseRef-PMEL; (c) And The Next GmbH.

struct Params {
    s: array<vec4<f32>, 16>,
}
",
    develop_common!(),
    "
fn to_lin(c: f32) -> f32 {
    if (c <= 0.04045) { return c / 12.92; }
    return pow((c + 0.055) / 1.055, 2.4);
}

fn to_srgb(v: f32) -> f32 {
    if (v <= 0.0031308) { return 12.92 * v; }
    return 1.055 * pow(v, 1.0 / 2.4) - 0.055;
}

fn hue_of(c: vec3<f32>) -> f32 {
    let mx = max(c.r, max(c.g, c.b));
    let mn = min(c.r, min(c.g, c.b));
    let d = mx - mn;
    if (d <= 0.0) { return 0.0; }
    var h = 0.0;
    if (mx == c.r) { h = (c.g - c.b) / d; }
    else if (mx == c.g) { h = (c.b - c.r) / d + 2.0; }
    else { h = (c.r - c.g) / d + 4.0; }
    h = h * 60.0;
    if (h < 0.0) { h = h + 360.0; }
    return h;
}

fn sat_of(c: vec3<f32>) -> f32 {
    let mx = max(c.r, max(c.g, c.b));
    let mn = min(c.r, min(c.g, c.b));
    let l = (mx + mn) * 0.5;
    let d = mx - mn;
    if (d <= 0.0) { return 0.0; }
    return d / (1.0 - abs(2.0 * l - 1.0));
}

fn hsl_rgb(h: f32, s: f32, l: f32) -> vec3<f32> {
    let c = (1.0 - abs(2.0 * l - 1.0)) * s;
    let hp = h / 60.0;
    let x = c * (1.0 - abs(hp - 2.0 * floor(hp * 0.5) - 1.0));
    var rgb = vec3<f32>(0.0);
    if (hp < 1.0) { rgb = vec3<f32>(c, x, 0.0); }
    else if (hp < 2.0) { rgb = vec3<f32>(x, c, 0.0); }
    else if (hp < 3.0) { rgb = vec3<f32>(0.0, c, x); }
    else if (hp < 4.0) { rgb = vec3<f32>(0.0, x, c); }
    else if (hp < 5.0) { rgb = vec3<f32>(x, 0.0, c); }
    else { rgb = vec3<f32>(c, 0.0, x); }
    return rgb + vec3<f32>(l - c * 0.5);
}

// The eight HSL range centres, degrees.
fn centre(k: u32) -> f32 {
    switch (k) {
        case 0u: { return 0.0; }
        case 1u: { return 30.0; }
        case 2u: { return 60.0; }
        case 3u: { return 120.0; }
        case 4u: { return 180.0; }
        case 5u: { return 240.0; }
        case 6u: { return 270.0; }
        default: { return 300.0; }
    }
}

fn tint(h: f32, s: f32) -> vec3<f32> {
    return (hsl_rgb(h - 360.0 * floor(h / 360.0), 1.0, 0.5) - vec3<f32>(0.5)) * (s * 0.003);
}

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
    let d = textureDimensions(outp);
    if (gid.x >= d.x || gid.y >= d.y) { return; }
    let xy = vec2<i32>(i32(gid.x), i32(gid.y));
    let a = textureLoad(in0, xy, 0);
    var c = unpremul(a);

    // White balance and exposure, in linear light.
    let temp = S(0u) * 0.01;
    let tnt = S(1u) * 0.01;
    let ev = S(2u);
    if (temp != 0.0 || tnt != 0.0 || ev != 0.0) {
        var lin = vec3<f32>(to_lin(c.r), to_lin(c.g), to_lin(c.b));
        let g = vec3<f32>(exp2(0.25 * temp), exp2(-0.25 * tnt), exp2(-0.25 * temp));
        let n = luma(g);
        lin = c01(lin * (g / n) * exp2(ev));
        c = c01(vec3<f32>(to_srgb(lin.r), to_srgb(lin.g), to_srgb(lin.b)));
    }

    // The tonal controls, on the luminance.
    let l = luma(c);
    var l2 = l;
    let k = S(3u) * 0.01;
    if (k != 0.0) { l2 = l2 + k * (l2 - 0.5) * 4.0 * l2 * (1.0 - l2); }
    let hl = S(4u) * 0.01;
    if (hl != 0.0) { l2 = l2 + hl * 0.35 * l2 * l2 * (1.0 - l2) * 4.0; }
    let sh = S(5u) * 0.01;
    if (sh != 0.0) { l2 = l2 + sh * 0.35 * (1.0 - l2) * (1.0 - l2) * l2 * 4.0; }
    let wh = S(6u) * 0.01;
    if (wh != 0.0) { l2 = l2 + wh * 0.25 * l2 * l2 * l2; }
    let bl = S(7u) * 0.01;
    if (bl != 0.0) { l2 = l2 + bl * 0.25 * (1.0 - l2) * (1.0 - l2) * (1.0 - l2); }
    for (var r = 0u; r < 4u; r = r + 1u) {
        let v = S(51u + r) * 0.01;
        if (v != 0.0) {
            let ctr = 0.875 - 0.25 * f32(r);
            let w = max(0.0, 1.0 - abs(l2 - ctr) * 4.0);
            l2 = l2 + v * 0.15 * w;
        }
    }
    l2 = clamp(l2, 0.0, 1.0);
    if (l2 != l) { c = c01(c + vec3<f32>(l2 - l)); }

    // HSL per colour range: linear weights between neighbouring centres.
    var any_hsl = false;
    for (var i = 13u; i <= 36u; i = i + 1u) { if (S(i) != 0.0) { any_hsl = true; } }
    if (any_hsl) {
        let mx = max(c.r, max(c.g, c.b));
        let mn = min(c.r, min(c.g, c.b));
        if (mx > mn) {
            let h = hue_of(c);
            let s = sat_of(c);
            let lum = (mx + mn) * 0.5;
            var lo = 7u;
            var hi = 0u;
            for (var j = 0u; j < 7u; j = j + 1u) {
                if (h >= centre(j) && h < centre(j + 1u)) { lo = j; hi = j + 1u; }
            }
            var c_lo = centre(lo);
            var c_hi = centre(hi);
            if (lo == 7u) { c_hi = 360.0; }
            let t = (h - c_lo) / (c_hi - c_lo);
            let w_lo = 1.0 - t;
            let w_hi = t;
            let dh = (w_lo * S(13u + 3u * lo) + w_hi * S(13u + 3u * hi)) * 0.3;
            let ds = (w_lo * S(14u + 3u * lo) + w_hi * S(14u + 3u * hi)) * 0.01;
            let dlum = (w_lo * S(15u + 3u * lo) + w_hi * S(15u + 3u * hi)) * 0.01;
            var h2 = h + dh;
            h2 = h2 - 360.0 * floor(h2 / 360.0);
            let s2 = clamp(s * (1.0 + ds), 0.0, 1.0);
            let l3 = clamp(lum + dlum * 0.3 * s, 0.0, 1.0);
            c = c01(hsl_rgb(h2, s2, l3));
        }
    }

    // Vibrance and saturation, about the luminance.
    let vib = S(11u) * 0.01;
    let sat = S(12u) * 0.01;
    if (vib != 0.0 || sat != 0.0) {
        let lum = luma(c);
        let s = max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b));
        let f = max(1.0 + sat + vib * (1.0 - s), 0.0);
        c = c01(vec3<f32>(lum) + (c - vec3<f32>(lum)) * f);
    }

    // Colour grading.
    let graded = S(38u) != 0.0 || S(39u) != 0.0 || S(41u) != 0.0 || S(42u) != 0.0
        || S(44u) != 0.0 || S(45u) != 0.0 || S(47u) != 0.0 || S(48u) != 0.0;
    if (graded) {
        let lum = luma(c);
        let b = max(S(49u) * 0.01, 0.01);
        let p = clamp(0.5 + S(50u) * 0.005, 0.05, 0.95);
        let lo = p - b * p;
        let hi = p + b * (1.0 - p);
        let x = clamp((lum - lo) / (hi - lo), 0.0, 1.0);
        let tt = x * x * (3.0 - 2.0 * x);
        let ws = 1.0 - tt;
        let wh = tt;
        let wm = 4.0 * ws * wh;
        let ws2 = ws * (1.0 - wm);
        let wh2 = wh * (1.0 - wm);
        let off = ws2 * tint(S(37u), S(38u)) + wm * tint(S(40u), S(41u))
            + wh2 * tint(S(43u), S(44u)) + tint(S(46u), S(47u));
        let dl = (ws2 * S(39u) + wm * S(42u) + wh2 * S(45u) + S(48u)) * 0.002;
        c = c01(c + off + vec3<f32>(dl));
    }

    let result = vec4<f32>(c * a.a, a.a);
    let m = textureLoad(mask, xy, 0).r;
    textureStore(outp, xy, mix(a, result, vec4<f32>(m)));
}
"
);

/// The neighbourhood stages (see the module docs).
pub static DEVELOP_DETAIL: KernelDef = KernelDef {
    id: "develop.detail",
    class: KernelClass::Point,
    inputs: 1,
    params: ParamsLayout {
        size: ::core::mem::size_of::<DevelopDetailParams>(),
        fields: &[
            ParamField {
                name: "s",
                wgsl_ty: "array<vec4<f32>, 16>",
            },
            ParamField {
                name: "taps_tex",
                wgsl_ty: "array<vec4<i32>, 12>",
            },
            ParamField {
                name: "taps_clar",
                wgsl_ty: "array<vec4<i32>, 12>",
            },
            ParamField {
                name: "taps_haze",
                wgsl_ty: "array<vec4<i32>, 12>",
            },
            ParamField {
                name: "taps_sharp",
                wgsl_ty: "array<vec4<i32>, 12>",
            },
            ParamField {
                name: "w_sharp",
                wgsl_ty: "array<vec4<f32>, 7>",
            },
        ],
    },
    wgsl: DEVELOP_DETAIL_WGSL,
    module: true,
    mip_exact: false,
    gpu_tolerance: Tolerance::ChannelEpsF16(4),
};

const DEVELOP_DETAIL_WGSL: &str = concat!(
    "// paged.image kernel `develop.detail` — handwritten under ABI v1.1.
// AGPL-3.0-only OR LicenseRef-PMEL; (c) And The Next GmbH.

struct Params {
    s: array<vec4<f32>, 16>,
    taps_tex: array<vec4<i32>, 12>,
    taps_clar: array<vec4<i32>, 12>,
    taps_haze: array<vec4<i32>, 12>,
    taps_sharp: array<vec4<i32>, 12>,
    w_sharp: array<vec4<f32>, 7>,
}
",
    develop_common!(),
    "
fn lum_at(p: vec2<i32>) -> f32 { return luma(unpremul(texel(p))); }

fn dark_at(p: vec2<i32>) -> f32 {
    let c = unpremul(texel(p));
    return min(c.r, min(c.g, c.b));
}

fn W(i: u32) -> f32 { return params.w_sharp[i / 4u][i % 4u]; }

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
    let d = textureDimensions(outp);
    if (gid.x >= d.x || gid.y >= d.y) { return; }
    let xy = vec2<i32>(i32(gid.x), i32(gid.y));
    let a = textureLoad(in0, xy, 0);
    let nr_l = S(59u) * 0.01;
    let nr_c = S(60u) * 0.01;
    let haze = S(10u) * 0.01;
    let tex = S(8u) * 0.01;
    let clar = S(9u) * 0.01;
    let sharp = S(55u) * 0.01;
    if (nr_l == 0.0 && nr_c == 0.0 && haze == 0.0 && tex == 0.0 && clar == 0.0 && sharp == 0.0) {
        textureStore(outp, xy, a);
        return;
    }
    var c = unpremul(a);
    let l_in = luma(c);

    // Noise reduction over the 5×5 window.
    if (nr_l != 0.0 || nr_c != 0.0) {
        let sigma = 0.05 + 0.45 * nr_l;
        var sl = 0.0;
        var sw = 0.0;
        var sc = vec3<f32>(0.0);
        for (var dy = -2; dy <= 2; dy = dy + 1) {
            for (var dx = -2; dx <= 2; dx = dx + 1) {
                let t = unpremul(texel(xy + vec2<i32>(dx, dy)));
                let lt = luma(t);
                let w = max(0.0, 1.0 - abs(lt - l_in) / sigma);
                sl = sl + w * lt;
                sw = sw + w;
                sc = sc + (t - vec3<f32>(lt));
            }
        }
        if (nr_l != 0.0) { c = c01(c + vec3<f32>((sl / sw - l_in) * nr_l)); }
        if (nr_c != 0.0) {
            let lc = luma(c);
            let ch = mix(c - vec3<f32>(lc), sc * 0.04, vec3<f32>(nr_c));
            c = c01(vec3<f32>(lc) + ch);
        }
    }

    // Dehaze: the dark channel of the disc, airlight white.
    if (haze > 0.0) {
        var dc = dark_at(xy);
        for (var i = 0u; i < 12u; i = i + 1u) {
            let t = params.taps_haze[i];
            dc = min(dc, min(dark_at(xy + t.xy), dark_at(xy + t.zw)));
        }
        let tr = max(1.0 - 0.9 * haze * dc, 0.1);
        c = c01((c - vec3<f32>(1.0)) / tr + vec3<f32>(1.0));
    } else if (haze < 0.0) {
        c = c01(c + (vec3<f32>(0.85) - c) * (-haze * 0.5));
    }

    // Texture, clarity and sharpening: changes of the luminance.
    var dl = 0.0;
    if (tex != 0.0) {
        var s = l_in;
        for (var i = 0u; i < 12u; i = i + 1u) {
            let t = params.taps_tex[i];
            s = s + lum_at(xy + t.xy);
            s = s + lum_at(xy + t.zw);
        }
        dl = dl + tex * (l_in - s * 0.04);
    }
    if (clar != 0.0) {
        var s = l_in;
        for (var i = 0u; i < 12u; i = i + 1u) {
            let t = params.taps_clar[i];
            s = s + lum_at(xy + t.xy);
            s = s + lum_at(xy + t.zw);
        }
        let lc = luma(c);
        dl = dl + clar * (l_in - s * 0.04) * 4.0 * lc * (1.0 - lc);
    }
    if (sharp != 0.0) {
        var b = W(0u) * l_in;
        for (var i = 0u; i < 12u; i = i + 1u) {
            let t = params.taps_sharp[i];
            b = b + W(1u + 2u * i) * lum_at(xy + t.xy);
            b = b + W(2u + 2u * i) * lum_at(xy + t.zw);
        }
        let hp = l_in - b;
        var mk = 1.0;
        let masking = S(58u) * 0.01;
        if (masking > 0.0) { mk = clamp((abs(hp) - masking * 0.05) * 40.0, 0.0, 1.0); }
        let detail = S(57u) * 0.01;
        dl = dl + sharp * hp * mk * (0.5 + detail);
    }
    if (dl != 0.0) { c = c01(c + vec3<f32>(dl)); }

    let result = vec4<f32>(c * a.a, a.a);
    let m = textureLoad(mask, xy, 0).r;
    textureStore(outp, xy, mix(a, result, vec4<f32>(m)));
}
"
);

/// Every kernel of this family (the conformance gate joins it to the registry).
pub static FAMILY: &[&KernelDef] = &[&DEVELOP_TONE, &DEVELOP_DETAIL];
