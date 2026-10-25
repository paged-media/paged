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

//! Adjustments (WP5.2): Shadows/Highlights, HDR Toning, Match Color,
//! Replace Color, Desaturate.
//!
//! Every kernel here works on UNPREMULTIPLIED rgb (the doors hand
//! associated alpha when an image has any), re-associates on the way out
//! and applies the selection mask itself (`mix(a, result, m)`).
//!
//! Shadows/Highlights and HDR Toning need a LOCAL MEAN of the luminance.
//! They are `Point` modules that read their neighbours from the whole
//! image in `in0` (the one-shot doors and the layer fold both bind the
//! whole canvas, as `geom.mosaic` relies on). The neighbourhood is a fixed
//! sunflower disc of 24 taps around the centre, scaled to the radius on
//! the CPU and handed over as INTEGER offsets ([`disc_taps`]): the shader
//! does no coordinate arithmetic in floating point, so the GPU and the
//! scalar twin read exactly the same texels.
//!
//! Equalize has no kernel: it is a CPU histogram readout turned into the
//! existing `adjust.lut1d` table (image-js `adjust_readouts`).
//!
//! Provenance: local-mean shadow/highlight recovery and local tone
//! adaptation are textbook (Reinhard et al., "Photographic Tone
//! Reproduction", SIGGRAPH 2002; Durand & Dorsey's base/detail split,
//! SIGGRAPH 2002); colour transfer by matching per-channel mean and
//! standard deviation is Reinhard, Ashikhmin, Gooch & Shirley, "Color
//! Transfer between Images" (IEEE CG&A 2001), done here in CIELAB(D50)
//! with the engine's own conversion (`paged-color::lab`); the HSL model is
//! Smith (SIGGRAPH 1978). The sunflower disc is Vogel's (1979). What each
//! Photoshop dialog does is taken from its published description; no
//! Adobe code and no reference implementation was read.

use crate::{KernelClass, KernelDef, ParamField, ParamsLayout, Tolerance};

/// Taps in the local-mean disc (plus the centre).
pub const DISC_TAPS: usize = 24;

/// The disc's 24 offsets at `radius` px as integer pairs, two per
/// `vec4<i32>` (`xy`, `zw`): Vogel's sunflower (r = √((i + ½)/24),
/// θ = i · golden angle), rounded to the pixel. Radius 0 puts every tap
/// on the centre, so the local mean is the pixel itself.
pub fn disc_taps(radius: f32) -> [[i32; 4]; 12] {
    let r = if radius.is_finite() {
        radius.clamp(0.0, 256.0)
    } else {
        0.0
    };
    let mut out = [[0i32; 4]; 12];
    for i in 0..DISC_TAPS {
        let rho = ((i as f32 + 0.5) / DISC_TAPS as f32).sqrt() * r;
        let th = i as f32 * 2.399_963_2;
        let (x, y) = ((rho * th.cos()).round() as i32, (rho * th.sin()).round() as i32);
        out[i / 2][(i % 2) * 2] = x;
        out[i / 2][(i % 2) * 2 + 1] = y;
    }
    out
}

/// The WGSL every module of this family shares (character-identical in
/// each, there being no include on this lane).
macro_rules! adjust_ext_common {
    () => {
        "
@group(0) @binding(0) var in0 : texture_2d<f32>;
@group(1) @binding(0) var<uniform> params : Params;
@group(2) @binding(0) var mask : texture_2d<f32>;
@group(3) @binding(0) var outp : texture_storage_2d<rgba16float, write>;

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
"
    };
}

/// The disc-mean helper (shared text; `T` is the taps field).
macro_rules! disc_mean_fn {
    ($name:literal, $field:literal) => {
        concat!(
            "
fn ",
            $name,
            "(c: vec2<i32>) -> f32 {
    var s = luma(unpremul(texel(c)));
    for (var i = 0u; i < 12u; i = i + 1u) {
        let t = params.",
            $field,
            "[i];
        s = s + luma(unpremul(texel(c + t.xy)));
        s = s + luma(unpremul(texel(c + t.zw)));
    }
    return s * 0.04;
}
"
        )
    };
}

// ─────────────────────────── desaturate ───────────────────────────
//
// Image ▸ Adjustments ▸ Desaturate: every pixel to the grey of its HSL
// lightness, (max + min) / 2 — the published description of the command
// ("equal red, green and blue values, the lightness unchanged").

/// `adjust.desaturate` takes no parameters.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, ::bytemuck::Pod, ::bytemuck::Zeroable)]
pub struct DesaturateParams {
    pub _abi_pad: u32,
}

#[allow(clippy::new_without_default)]
impl DesaturateParams {
    pub fn new() -> Self {
        Self { _abi_pad: 0 }
    }
    pub fn as_bytes(&self) -> &[u8] {
        ::bytemuck::bytes_of(self)
    }
}

/// Desaturate: rgb → ((max + min) / 2)³. A grey pixel is its own result.
pub static ADJUST_DESATURATE: KernelDef = KernelDef {
    id: "adjust.desaturate",
    class: KernelClass::Point,
    inputs: 1,
    params: ParamsLayout {
        size: ::core::mem::size_of::<DesaturateParams>(),
        fields: &[],
    },
    wgsl: ADJUST_DESATURATE_WGSL,
    module: true,
    mip_exact: true,
    gpu_tolerance: Tolerance::ChannelEpsF16(2),
};

const ADJUST_DESATURATE_WGSL: &str = concat!(
    "// paged.image kernel `adjust.desaturate` — handwritten under ABI v1.1.
// AGPL-3.0-only OR LicenseRef-PMEL; (c) And The Next GmbH.

struct Params {
    _abi_pad: u32,
}
",
    adjust_ext_common!(),
    "
@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
    let d = textureDimensions(outp);
    if (gid.x >= d.x || gid.y >= d.y) { return; }
    let xy = vec2<i32>(i32(gid.x), i32(gid.y));
    let a = textureLoad(in0, xy, 0);
    let c = unpremul(a);
    let l = (max(c.r, max(c.g, c.b)) + min(c.r, min(c.g, c.b))) * 0.5;
    let result = vec4<f32>(vec3<f32>(l) * a.a, a.a);
    let m = textureLoad(mask, xy, 0).r;
    textureStore(outp, xy, mix(a, result, vec4<f32>(m)));
}
"
);

// ──────────────────────── shadows_highlights ──────────────────────
//
// Image ▸ Adjustments ▸ Shadows/Highlights. Each side has an AMOUNT, a
// TONAL WIDTH and a RADIUS; the radius is the neighbourhood whose MEAN
// luminance decides how much a pixel belongs to the shadows (or the
// highlights). Because the correction is driven by the local mean and is
// ADDED (the same lift for every pixel of a dark region), the detail
// inside the region survives — the point of the dialog over a curve.
//
//   ms, mh = local means at the two radii
//   ws = smooth(1 − ms / tone_s)          wh = smooth((mh − (1 − tone_h)) / tone_h)
//   l'  = l + 0.8·(amount_s · ws · (1 − ms) − amount_h · wh · mh)
//   midtone contrast: l'' = l' + k·(l' − ½)·4·l'·(1 − l')
//   rgb' = rgb + (l'' − l); colour correction scales the chroma of the
//   changed pixels by 1 + cc·min(4·|Δl|, 1).
// Both amounts and the midtone contrast at 0 are the IDENTITY (exact: the
// tone path is skipped when l'' == l).

/// `adjust.shadows_highlights` params (amounts and tones 0..1, the
/// colour correction and midtone contrast −1..1; radii are in the taps).
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, ::bytemuck::Pod, ::bytemuck::Zeroable)]
pub struct ShadowsHighlightsParams {
    pub sh_amount: f32,
    pub sh_tone: f32,
    pub hi_amount: f32,
    pub hi_tone: f32,
    pub color_corr: f32,
    pub midtone: f32,
    pub _pad0: u32,
    pub _pad1: u32,
    pub taps_s: [[i32; 4]; 12],
    pub taps_h: [[i32; 4]; 12],
}

impl ShadowsHighlightsParams {
    /// From the dialog's eight values: `[shadows amount, shadow tone,
    /// shadow radius px, highlights amount, highlight tone, highlight
    /// radius px, colour correction, midtone contrast]`.
    pub fn from_values(v: [f32; 8]) -> Self {
        Self {
            sh_amount: v[0],
            sh_tone: v[1],
            hi_amount: v[3],
            hi_tone: v[4],
            color_corr: v[6],
            midtone: v[7],
            _pad0: 0,
            _pad1: 0,
            taps_s: disc_taps(v[2]),
            taps_h: disc_taps(v[5]),
        }
    }
    pub fn as_bytes(&self) -> &[u8] {
        ::bytemuck::bytes_of(self)
    }
}

/// Shadows/Highlights (see the section note).
pub static ADJUST_SHADOWS_HIGHLIGHTS: KernelDef = KernelDef {
    id: "adjust.shadows_highlights",
    class: KernelClass::Point,
    inputs: 1,
    params: ParamsLayout {
        size: ::core::mem::size_of::<ShadowsHighlightsParams>(),
        fields: &[
            ParamField {
                name: "sh_amount",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "sh_tone",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "hi_amount",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "hi_tone",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "color_corr",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "midtone",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "_pad0",
                wgsl_ty: "u32",
            },
            ParamField {
                name: "_pad1",
                wgsl_ty: "u32",
            },
            ParamField {
                name: "taps_s",
                wgsl_ty: "array<vec4<i32>, 12>",
            },
            ParamField {
                name: "taps_h",
                wgsl_ty: "array<vec4<i32>, 12>",
            },
        ],
    },
    wgsl: ADJUST_SHADOWS_HIGHLIGHTS_WGSL,
    module: true,
    mip_exact: false,
    gpu_tolerance: Tolerance::ChannelEpsF16(8),
};

const ADJUST_SHADOWS_HIGHLIGHTS_WGSL: &str = concat!(
    "// paged.image kernel `adjust.shadows_highlights` — handwritten under ABI v1.1.
// AGPL-3.0-only OR LicenseRef-PMEL; (c) And The Next GmbH.

struct Params {
    sh_amount: f32,
    sh_tone: f32,
    hi_amount: f32,
    hi_tone: f32,
    color_corr: f32,
    midtone: f32,
    _pad0: u32,
    _pad1: u32,
    taps_s: array<vec4<i32>, 12>,
    taps_h: array<vec4<i32>, 12>,
}
",
    adjust_ext_common!(),
    disc_mean_fn!("mean_s", "taps_s"),
    disc_mean_fn!("mean_h", "taps_h"),
    "
fn smooth01(t: f32) -> f32 {
    let x = clamp(t, 0.0, 1.0);
    return x * x * (3.0 - 2.0 * x);
}

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
    let d = textureDimensions(outp);
    if (gid.x >= d.x || gid.y >= d.y) { return; }
    let xy = vec2<i32>(i32(gid.x), i32(gid.y));
    let a = textureLoad(in0, xy, 0);
    let p = params;
    let rgb = unpremul(a);
    let l = luma(rgb);
    var dl = 0.0;
    if (p.sh_amount != 0.0 && p.sh_tone > 0.0) {
        let ms = mean_s(xy);
        let ws = smooth01(1.0 - ms / p.sh_tone);
        dl = dl + p.sh_amount * ws * (1.0 - ms) * 0.8;
    }
    if (p.hi_amount != 0.0 && p.hi_tone > 0.0) {
        let mh = mean_h(xy);
        let wh = smooth01((mh - (1.0 - p.hi_tone)) / p.hi_tone);
        dl = dl - p.hi_amount * wh * mh * 0.8;
    }
    var l2 = clamp(l + dl, 0.0, 1.0);
    if (p.midtone != 0.0) {
        l2 = clamp(l2 + p.midtone * (l2 - 0.5) * 4.0 * l2 * (1.0 - l2), 0.0, 1.0);
    }
    var o = rgb;
    if (l2 != l) {
        let k = l2 - l;
        o = clamp(rgb + vec3<f32>(k), vec3<f32>(0.0), vec3<f32>(1.0));
        if (p.color_corr != 0.0) {
            let f = 1.0 + p.color_corr * min(abs(k) * 4.0, 1.0);
            o = clamp(vec3<f32>(l2) + (o - vec3<f32>(l2)) * f, vec3<f32>(0.0), vec3<f32>(1.0));
        }
    }
    let result = vec4<f32>(o * a.a, a.a);
    let m = textureLoad(mask, xy, 0).r;
    textureStore(outp, xy, mix(a, result, vec4<f32>(m)));
}
"
);

// ──────────────────────────── hdr_toning ──────────────────────────
//
// Image ▸ Adjustments ▸ HDR Toning, Local Adaptation: split the
// luminance into a BASE (an edge-aware local mean — the tap weight
// 1 / (1 + 8·strength·|l_t − l|) keeps the mean from crossing a strong
// edge, which is what limits the halo) and the DETAIL above it; tone the
// base (gamma, exposure, a shadow lift, a highlight lift) and add the
// detail back scaled by 1 + detail:
//
//   base' = (base^gamma · 2^exposure) + shadow·¼·(1 − b)² + highlight·¼·b²
//   l'    = base' + (l − base)·(1 + detail)
//   rgb'  = rgb + (l' − l), then vibrance/saturation about the luminance.
// gamma 1, exposure, detail, shadow, highlight, vibrance and saturation 0
// is the IDENTITY (exact: every stage is skipped).

/// `adjust.hdr_toning` params (the radius is in the taps).
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, ::bytemuck::Pod, ::bytemuck::Zeroable)]
pub struct HdrToningParams {
    pub strength: f32,
    pub gamma: f32,
    pub exposure: f32,
    pub detail: f32,
    pub shadow: f32,
    pub highlight: f32,
    pub vibrance: f32,
    pub saturation: f32,
    pub taps: [[i32; 4]; 12],
}

impl HdrToningParams {
    /// From the dialog's nine values: `[radius px, strength, gamma,
    /// exposure, detail, shadow, highlight, vibrance, saturation]`.
    pub fn from_values(v: [f32; 9]) -> Self {
        Self {
            strength: v[1],
            gamma: v[2],
            exposure: v[3],
            detail: v[4],
            shadow: v[5],
            highlight: v[6],
            vibrance: v[7],
            saturation: v[8],
            taps: disc_taps(v[0]),
        }
    }
    pub fn as_bytes(&self) -> &[u8] {
        ::bytemuck::bytes_of(self)
    }
}

/// HDR Toning, Local Adaptation (see the section note).
pub static ADJUST_HDR_TONING: KernelDef = KernelDef {
    id: "adjust.hdr_toning",
    class: KernelClass::Point,
    inputs: 1,
    params: ParamsLayout {
        size: ::core::mem::size_of::<HdrToningParams>(),
        fields: &[
            ParamField {
                name: "strength",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "gamma",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "exposure",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "detail",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "shadow",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "highlight",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "vibrance",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "saturation",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "taps",
                wgsl_ty: "array<vec4<i32>, 12>",
            },
        ],
    },
    wgsl: ADJUST_HDR_TONING_WGSL,
    module: true,
    mip_exact: false,
    gpu_tolerance: Tolerance::ChannelEpsF16(12),
};

const ADJUST_HDR_TONING_WGSL: &str = concat!(
    "// paged.image kernel `adjust.hdr_toning` — handwritten under ABI v1.1.
// AGPL-3.0-only OR LicenseRef-PMEL; (c) And The Next GmbH.

struct Params {
    strength: f32,
    gamma: f32,
    exposure: f32,
    detail: f32,
    shadow: f32,
    highlight: f32,
    vibrance: f32,
    saturation: f32,
    taps: array<vec4<i32>, 12>,
}
",
    adjust_ext_common!(),
    "
fn base_at(c: vec2<i32>, l: f32) -> f32 {
    var s = l;
    var w = 1.0;
    for (var i = 0u; i < 12u; i = i + 1u) {
        let t = params.taps[i];
        let l1 = luma(unpremul(texel(c + t.xy)));
        let w1 = 1.0 / (1.0 + params.strength * 8.0 * abs(l1 - l));
        s = s + w1 * l1;
        w = w + w1;
        let l2 = luma(unpremul(texel(c + t.zw)));
        let w2 = 1.0 / (1.0 + params.strength * 8.0 * abs(l2 - l));
        s = s + w2 * l2;
        w = w + w2;
    }
    return s / w;
}

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
    let d = textureDimensions(outp);
    if (gid.x >= d.x || gid.y >= d.y) { return; }
    let xy = vec2<i32>(i32(gid.x), i32(gid.y));
    let a = textureLoad(in0, xy, 0);
    let p = params;
    let rgb = unpremul(a);
    var o = rgb;
    let tonal = p.gamma != 1.0 || p.exposure != 0.0 || p.detail != 0.0
        || p.shadow != 0.0 || p.highlight != 0.0;
    if (tonal) {
        let l = luma(rgb);
        let base = base_at(xy, l);
        var b = max(base, 0.0);
        if (p.gamma != 1.0) { b = pow(b, max(p.gamma, 0.01)); }
        if (p.exposure != 0.0) { b = b * exp2(p.exposure); }
        if (p.shadow != 0.0) { b = b + p.shadow * 0.25 * (1.0 - b) * (1.0 - b); }
        if (p.highlight != 0.0) { b = b + p.highlight * 0.25 * b * b; }
        let l2 = clamp(b + (l - base) * (1.0 + p.detail), 0.0, 1.0);
        o = clamp(rgb + vec3<f32>(l2 - l), vec3<f32>(0.0), vec3<f32>(1.0));
    }
    if (p.vibrance != 0.0 || p.saturation != 0.0) {
        let lum = luma(o);
        let s = max(o.r, max(o.g, o.b)) - min(o.r, min(o.g, o.b));
        let f = max(1.0 + p.saturation + p.vibrance * (1.0 - s), 0.0);
        o = clamp(vec3<f32>(lum) + (o - vec3<f32>(lum)) * f, vec3<f32>(0.0), vec3<f32>(1.0));
    }
    let result = vec4<f32>(o * a.a, a.a);
    let m = textureLoad(mask, xy, 0).r;
    textureStore(outp, xy, mix(a, result, vec4<f32>(m)));
}
"
);

// ──────────────────────────── match_color ─────────────────────────
//
// Image ▸ Adjustments ▸ Match Color: Reinhard's colour transfer. In
// CIELAB(D50) — the conversion is `paged-color::lab`'s, written out here
// with the same constants — each channel of the target is normalised by
// its own mean and standard deviation and re-expressed in the source's:
//
//   x' = (x − μ_t)·σ_s/σ_t + μ_s           (σ_t floored at 10⁻³)
//   L' ·= luminance;  a', b' ·= intensity   (both 1 = unchanged, 0 = grey)
//   out = mix(lab→rgb(x'), rgb, fade)
// The statistics travel in the params (the door measures both images on
// the CPU). fade 1 is the IDENTITY (exact: mix(·, rgb, 1) = rgb).

/// `adjust.match_color` params: `(L, a, b, _)` means and standard
/// deviations of the SOURCE and of the TARGET (this image), then the
/// sliders.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, ::bytemuck::Pod, ::bytemuck::Zeroable)]
pub struct MatchColorParams {
    pub src_mean: [f32; 4],
    pub src_std: [f32; 4],
    pub dst_mean: [f32; 4],
    pub dst_std: [f32; 4],
    pub luminance: f32,
    pub intensity: f32,
    pub fade: f32,
    pub _abi_pad: u32,
}

impl MatchColorParams {
    /// `src` / `dst` are `[L mean, a mean, b mean, L std, a std, b std]`.
    pub fn new(src: [f32; 6], dst: [f32; 6], luminance: f32, intensity: f32, fade: f32) -> Self {
        Self {
            src_mean: [src[0], src[1], src[2], 0.0],
            src_std: [src[3], src[4], src[5], 0.0],
            dst_mean: [dst[0], dst[1], dst[2], 0.0],
            dst_std: [dst[3], dst[4], dst[5], 0.0],
            luminance,
            intensity,
            fade,
            _abi_pad: 0,
        }
    }
    pub fn as_bytes(&self) -> &[u8] {
        ::bytemuck::bytes_of(self)
    }
}

/// Match Color (see the section note).
pub static ADJUST_MATCH_COLOR: KernelDef = KernelDef {
    id: "adjust.match_color",
    class: KernelClass::Point,
    inputs: 1,
    params: ParamsLayout {
        size: ::core::mem::size_of::<MatchColorParams>(),
        fields: &[
            ParamField {
                name: "src_mean",
                wgsl_ty: "vec4<f32>",
            },
            ParamField {
                name: "src_std",
                wgsl_ty: "vec4<f32>",
            },
            ParamField {
                name: "dst_mean",
                wgsl_ty: "vec4<f32>",
            },
            ParamField {
                name: "dst_std",
                wgsl_ty: "vec4<f32>",
            },
            ParamField {
                name: "luminance",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "intensity",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "fade",
                wgsl_ty: "f32",
            },
        ],
    },
    wgsl: ADJUST_MATCH_COLOR_WGSL,
    module: true,
    mip_exact: true,
    gpu_tolerance: Tolerance::ChannelEpsF16(16),
};

const ADJUST_MATCH_COLOR_WGSL: &str = concat!(
    "// paged.image kernel `adjust.match_color` — handwritten under ABI v1.1.
// AGPL-3.0-only OR LicenseRef-PMEL; (c) And The Next GmbH.

struct Params {
    src_mean: vec4<f32>,
    src_std: vec4<f32>,
    dst_mean: vec4<f32>,
    dst_std: vec4<f32>,
    luminance: f32,
    intensity: f32,
    fade: f32,
    _abi_pad: u32,
}
",
    adjust_ext_common!(),
    "
const KAPPA : f32 = 903.2963;
const EPSILON : f32 = 0.008856452;
const D50 : vec3<f32> = vec3<f32>(0.96422, 1.0, 0.82521);

fn to_lin(c: f32) -> f32 {
    if (c <= 0.04045) { return c / 12.92; }
    return pow((c + 0.055) / 1.055, 2.4);
}

fn to_srgb(v: f32) -> f32 {
    if (v <= 0.0031308) { return 12.92 * v; }
    return 1.055 * pow(v, 1.0 / 2.4) - 0.055;
}

fn lab_f(t: f32) -> f32 {
    if (t > EPSILON) { return pow(t, 1.0 / 3.0); }
    return (KAPPA * t + 16.0) / 116.0;
}

fn lab_f_inv(t: f32) -> f32 {
    let t3 = t * t * t;
    if (t3 > EPSILON) { return t3; }
    return (116.0 * t - 16.0) / KAPPA;
}

fn rgb_lab(c: vec3<f32>) -> vec3<f32> {
    let l = vec3<f32>(to_lin(c.r), to_lin(c.g), to_lin(c.b));
    let x65 = 0.4124564 * l.r + 0.3575761 * l.g + 0.1804375 * l.b;
    let y65 = 0.2126729 * l.r + 0.7151522 * l.g + 0.0721750 * l.b;
    let z65 = 0.0193339 * l.r + 0.1191920 * l.g + 0.9503041 * l.b;
    let x = 1.0478112 * x65 + 0.0228866 * y65 - 0.0501270 * z65;
    let y = 0.0295424 * x65 + 0.9904844 * y65 - 0.0170491 * z65;
    let z = -0.0092345 * x65 + 0.0150436 * y65 + 0.7521316 * z65;
    let fx = lab_f(x / D50.x);
    let fy = lab_f(y / D50.y);
    let fz = lab_f(z / D50.z);
    return vec3<f32>(116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz));
}

fn lab_rgb(lab: vec3<f32>) -> vec3<f32> {
    let fy = (lab.x + 16.0) / 116.0;
    let fx = fy + lab.y / 500.0;
    let fz = fy - lab.z / 200.0;
    var yr = lab.x / KAPPA;
    if (lab.x > KAPPA * EPSILON) { yr = fy * fy * fy; }
    let x = lab_f_inv(fx) * D50.x;
    let y = yr * D50.y;
    let z = lab_f_inv(fz) * D50.z;
    let x65 = 0.9555766 * x - 0.0230393 * y + 0.0631636 * z;
    let y65 = -0.0282895 * x + 1.0099416 * y + 0.0210077 * z;
    let z65 = 0.0122982 * x - 0.0204830 * y + 1.3299098 * z;
    let r = clamp(3.2404542 * x65 - 1.5371385 * y65 - 0.4985314 * z65, 0.0, 1.0);
    let g = clamp(-0.9692660 * x65 + 1.8760108 * y65 + 0.0415560 * z65, 0.0, 1.0);
    let b = clamp(0.0556434 * x65 - 0.2040259 * y65 + 1.0572252 * z65, 0.0, 1.0);
    return vec3<f32>(to_srgb(r), to_srgb(g), to_srgb(b));
}

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
    let d = textureDimensions(outp);
    if (gid.x >= d.x || gid.y >= d.y) { return; }
    let xy = vec2<i32>(i32(gid.x), i32(gid.y));
    let a = textureLoad(in0, xy, 0);
    let p = params;
    let rgb = unpremul(a);
    let lab = rgb_lab(rgb);
    let ratio = p.src_std.xyz / max(p.dst_std.xyz, vec3<f32>(0.001));
    var t = (lab - p.dst_mean.xyz) * ratio + p.src_mean.xyz;
    t = vec3<f32>(clamp(t.x * p.luminance, 0.0, 100.0), t.y * p.intensity, t.z * p.intensity);
    let moved = clamp(lab_rgb(t), vec3<f32>(0.0), vec3<f32>(1.0));
    let o = mix(moved, rgb, vec3<f32>(p.fade));
    let result = vec4<f32>(o * a.a, a.a);
    let m = textureLoad(mask, xy, 0).r;
    textureStore(outp, xy, mix(a, result, vec4<f32>(m)));
}
"
);

// ─────────────────────────── replace_color ────────────────────────
//
// Image ▸ Adjustments ▸ Replace Color: a soft selection of the colours
// near a sampled one, recoloured by a hue/saturation/lightness shift.
//
//   w  = fuzziness > 0 ? clamp(1 − 255·|rgb − target| / fuzziness, 0, 1)
//                      : [rgb == target]
//   h' = h + hue;  s' = sat ≥ 0 ? min(1, s / (1 − sat)) : s·(1 + sat)
//   rgb' = hsl→rgb(h', s', l), then lightness blended toward white/black
//   out = mix(rgb, rgb', w)
// The saturation and lightness rules are the ones adjust.hue_saturation
// measured on Photoshop's Hue/Saturation (the Replace Color dialog
// carries the same three sliders). hue, saturation and lightness 0 are
// the IDENTITY (exact: the shift is skipped).

/// `adjust.replace_color` params: the target colour (straight rgb 0..1),
/// fuzziness (0..200), hue (degrees) and saturation / lightness (−1..1).
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, ::bytemuck::Pod, ::bytemuck::Zeroable)]
pub struct ReplaceColorParams {
    pub r: f32,
    pub g: f32,
    pub b: f32,
    pub fuzziness: f32,
    pub hue: f32,
    pub saturation: f32,
    pub lightness: f32,
    pub _abi_pad: u32,
}

impl ReplaceColorParams {
    pub fn new(
        color: [f32; 3],
        fuzziness: f32,
        hue: f32,
        saturation: f32,
        lightness: f32,
    ) -> Self {
        Self {
            r: color[0],
            g: color[1],
            b: color[2],
            fuzziness,
            hue,
            saturation,
            lightness,
            _abi_pad: 0,
        }
    }
    pub fn as_bytes(&self) -> &[u8] {
        ::bytemuck::bytes_of(self)
    }
}

/// Replace Color (see the section note).
pub static ADJUST_REPLACE_COLOR: KernelDef = KernelDef {
    id: "adjust.replace_color",
    class: KernelClass::Point,
    inputs: 1,
    params: ParamsLayout {
        size: ::core::mem::size_of::<ReplaceColorParams>(),
        fields: &[
            ParamField {
                name: "r",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "g",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "b",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "fuzziness",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "hue",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "saturation",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "lightness",
                wgsl_ty: "f32",
            },
        ],
    },
    wgsl: ADJUST_REPLACE_COLOR_WGSL,
    module: true,
    mip_exact: true,
    gpu_tolerance: Tolerance::ChannelEpsF16(8),
};

const ADJUST_REPLACE_COLOR_WGSL: &str = concat!(
    "// paged.image kernel `adjust.replace_color` — handwritten under ABI v1.1.
// AGPL-3.0-only OR LicenseRef-PMEL; (c) And The Next GmbH.

struct Params {
    r: f32,
    g: f32,
    b: f32,
    fuzziness: f32,
    hue: f32,
    saturation: f32,
    lightness: f32,
    _abi_pad: u32,
}
",
    adjust_ext_common!(),
    "
@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
    let d = textureDimensions(outp);
    if (gid.x >= d.x || gid.y >= d.y) { return; }
    let xy = vec2<i32>(i32(gid.x), i32(gid.y));
    let a = textureLoad(in0, xy, 0);
    let p = params;
    let rgb = unpremul(a);
    var o = rgb;
    if (p.hue != 0.0 || p.saturation != 0.0 || p.lightness != 0.0) {
        let dv = rgb - vec3<f32>(p.r, p.g, p.b);
        let dist = sqrt(dot(dv, dv)) * 255.0;
        var w = 0.0;
        if (p.fuzziness > 0.0) { w = clamp(1.0 - dist / p.fuzziness, 0.0, 1.0); }
        else if (dist == 0.0) { w = 1.0; }
        if (w > 0.0) {
            let mx = max(rgb.r, max(rgb.g, rgb.b));
            let mn = min(rgb.r, min(rgb.g, rgb.b));
            let l = (mx + mn) * 0.5;
            var h = hue_of(rgb) + p.hue;
            h = h - 360.0 * floor(h / 360.0);
            var s = sat_of(rgb);
            if (p.saturation >= 0.0) {
                if (p.saturation < 1.0) { s = min(1.0, s / (1.0 - p.saturation)); }
                else if (s > 0.0) { s = 1.0; }
            } else {
                s = s * (1.0 + p.saturation);
            }
            var c = clamp(hsl_rgb(h, clamp(s, 0.0, 1.0), l), vec3<f32>(0.0), vec3<f32>(1.0));
            if (p.lightness >= 0.0) { c = c + (vec3<f32>(1.0) - c) * p.lightness; }
            else { c = c * (1.0 + p.lightness); }
            o = mix(rgb, clamp(c, vec3<f32>(0.0), vec3<f32>(1.0)), vec3<f32>(w));
        }
    }
    let result = vec4<f32>(o * a.a, a.a);
    let m = textureLoad(mask, xy, 0).r;
    textureStore(outp, xy, mix(a, result, vec4<f32>(m)));
}
"
);

/// Every kernel of this family (the conformance gate joins it to the registry).
pub static FAMILY: &[&KernelDef] = &[
    &ADJUST_DESATURATE,
    &ADJUST_SHADOWS_HIGHLIGHTS,
    &ADJUST_HDR_TONING,
    &ADJUST_MATCH_COLOR,
    &ADJUST_REPLACE_COLOR,
];
