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

//! Filter Gallery breadth (WP5.2): the operations the remaining gallery
//! effects need beyond `gallery.rs`.
//!
//! `gallery.rs` builds a dozen OPERATIONS and lets presets name them
//! (see its module docs). Three families of Photoshop's gallery effects
//! were left without an operation, and these supply them:
//!
//! * `gallery.strokes` — a line-integral smear along a direction (fixed,
//!   following the edges, or alternating with tone): Angled Strokes, Dark
//!   Strokes, Sprayed Strokes, Sumi-e, Colored Pencil, Rough Pastels,
//!   Charcoal, Conté Crayon, Graphic Pen, Water Paper, Accented Edges;
//! * `gallery.chrome` — a periodic remap of smoothed luminance (Chrome);
//! * `gallery.plastic_wrap` — specular highlights off the smoothed
//!   luminance relief (Plastic Wrap).
//!
//! The conventions of `gallery.rs` hold: `amount` is the last word
//! (`amount = 0` is the identity), position-dependent noise reads
//! `ox + gid.x` and the PCG hash is character-identical to gallery.rs.
//!
//! Provenance: line integral convolution (Cabral & Leedom, SIGGRAPH
//! 1993) for the stroke smear; Sobel gradients for edge-following;
//! Blinn–Phong highlights over a luminance heightfield (bump mapping,
//! Blinn 1978); the PCG hash (Jarzynski & Olano, JCGT 2020). Behaviour
//! from what each named filter visibly does; no reference code read.

use crate::{KernelClass, KernelDef, ParamField, ParamsLayout, Tolerance};

/// The longest stroke `gallery.strokes` draws (each way), px.
pub const STROKES_MAX_LENGTH: f32 = 24.0;

// ───────────────────────────── strokes ─────────────────────────────

/// `gallery.strokes` params.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, ::bytemuck::Pod, ::bytemuck::Zeroable)]
pub struct GalleryStrokesParams {
    pub ox: i32,
    pub oy: i32,
    pub seed: u32,
    pub angle_deg: f32,
    pub length_px: f32,
    /// 0 fixed angle, 1 follow edges, 2 angled (light one way, dark the
    /// other).
    pub mode: u32,
    pub darkness: f32,
    pub amount: f32,
    pub _pad0: u32,
    pub _pad1: u32,
    pub _pad2: u32,
    pub _abi_pad: u32,
}

impl GalleryStrokesParams {
    pub fn new(
        seed: u32,
        angle_deg: f32,
        length_px: f32,
        mode: u32,
        darkness: f32,
        amount: f32,
    ) -> Self {
        Self {
            ox: 0,
            oy: 0,
            seed,
            angle_deg,
            length_px,
            mode,
            darkness,
            amount,
            _pad0: 0,
            _pad1: 0,
            _pad2: 0,
            _abi_pad: 0,
        }
    }

    pub fn as_bytes(&self) -> &[u8] {
        ::bytemuck::bytes_of(self)
    }
}

/// STROKES — each pixel becomes the mean along a short line through it
/// (`2n + 1` bilinear taps over ±`length_px`, the length jittered per
/// pixel by the seeded hash so strokes do not align into a texture),
/// then `darkness` pushes the tone away from (or toward) mid grey.
///
/// IDENTITY: `amount = 0.0` returns the input unchanged.
pub static GALLERY_STROKES: KernelDef = KernelDef {
    id: "gallery.strokes",
    class: KernelClass::Resample { support: 1.0 },
    inputs: 1,
    params: ParamsLayout {
        size: ::core::mem::size_of::<GalleryStrokesParams>(),
        fields: &[
            ParamField {
                name: "ox",
                wgsl_ty: "i32",
            },
            ParamField {
                name: "oy",
                wgsl_ty: "i32",
            },
            ParamField {
                name: "seed",
                wgsl_ty: "u32",
            },
            ParamField {
                name: "angle_deg",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "length_px",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "mode",
                wgsl_ty: "u32",
            },
            ParamField {
                name: "darkness",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "amount",
                wgsl_ty: "f32",
            },
        ],
    },
    wgsl: GALLERY_STROKES_WGSL,
    module: true,
    mip_exact: false,
    gpu_tolerance: Tolerance::ChannelEpsF16(8),
};

const GALLERY_STROKES_WGSL: &str = "\
// paged.image kernel `gallery.strokes` — handwritten under ABI v1.1.
// AGPL-3.0-only OR LicenseRef-PMEL; (c) And The Next GmbH.

struct Params {
    ox: i32,
    oy: i32,
    seed: u32,
    angle_deg: f32,
    length_px: f32,
    mode: u32,
    darkness: f32,
    amount: f32,
    _pad0: u32,
    _pad1: u32,
    _pad2: u32,
    _abi_pad: u32,
}

@group(0) @binding(0) var in0 : texture_2d<f32>;
@group(1) @binding(0) var<uniform> params : Params;
@group(2) @binding(0) var mask : texture_2d<f32>;
@group(3) @binding(0) var outp : texture_storage_2d<rgba16float, write>;

const TAU : f32 = 6.2831853;

fn tap(c: vec2<i32>) -> vec4<f32> {
    let din = vec2<i32>(textureDimensions(in0));
    return textureLoad(in0, clamp(c, vec2<i32>(0), din - vec2<i32>(1)), 0);
}

fn bilin(p: vec2<f32>) -> vec4<f32> {
    let q = p - vec2<f32>(0.5);
    let f = floor(q);
    let t = q - f;
    let i = vec2<i32>(f);
    let top = mix(tap(i), tap(i + vec2<i32>(1, 0)), vec4<f32>(t.x));
    let bot = mix(tap(i + vec2<i32>(0, 1)), tap(i + vec2<i32>(1, 1)), vec4<f32>(t.x));
    return mix(top, bot, vec4<f32>(t.y));
}

fn luma(c: vec3<f32>) -> f32 {
    return dot(c, vec3<f32>(0.2126, 0.7152, 0.0722));
}

const L_MAX : i32 = 24;

fn pcg(v: u32) -> u32 {
    let state = v * 747796405u + 2891336453u;
    let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
    return (word >> 22u) ^ word;
}

fn hash21(x: i32, y: i32, seed: u32) -> f32 {
    let h = pcg(bitcast<u32>(x) ^ pcg(bitcast<u32>(y) ^ pcg(seed)));
    return f32(h >> 8u) * 5.9604644775390625e-8;
}

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
    let d = textureDimensions(outp);
    if (gid.x >= d.x || gid.y >= d.y) { return; }
    let xy = vec2<i32>(i32(gid.x), i32(gid.y));
    let a = tap(xy);
    let p = vec2<f32>(xy) + vec2<f32>(0.5);
    let rad = radians(params.angle_deg);
    var dir = vec2<f32>(cos(rad), sin(rad));
    if (params.mode == 1u) {
        // Sobel on luminance; strokes run ALONG the edge (perpendicular
        // to the gradient). A flat neighbourhood keeps the fixed angle.
        let l00 = luma(tap(xy + vec2<i32>(-1, -1)).rgb);
        let l10 = luma(tap(xy + vec2<i32>(0, -1)).rgb);
        let l20 = luma(tap(xy + vec2<i32>(1, -1)).rgb);
        let l01 = luma(tap(xy + vec2<i32>(-1, 0)).rgb);
        let l21 = luma(tap(xy + vec2<i32>(1, 0)).rgb);
        let l02 = luma(tap(xy + vec2<i32>(-1, 1)).rgb);
        let l12 = luma(tap(xy + vec2<i32>(0, 1)).rgb);
        let l22 = luma(tap(xy + vec2<i32>(1, 1)).rgb);
        let gx = (l20 + 2.0 * l21 + l22) - (l00 + 2.0 * l01 + l02);
        let gy = (l02 + 2.0 * l12 + l22) - (l00 + 2.0 * l10 + l20);
        let gl = sqrt(gx * gx + gy * gy);
        if (gl > 0.001) { dir = vec2<f32>(-gy, gx) / gl; }
    } else if (params.mode == 2u) {
        if (luma(a.rgb) < 0.5) { dir = vec2<f32>(-dir.y, dir.x); }
    }
    let h = hash21(params.ox + xy.x, params.oy + xy.y, params.seed);
    let len = clamp(params.length_px, 0.0, f32(L_MAX)) * (0.6 + 0.4 * h);
    var smear = a;
    if (len >= 0.5) {
        let n = clamp(i32(ceil(len)), 1, L_MAX);
        var acc = vec4<f32>(0.0);
        for (var j : i32 = -L_MAX; j <= L_MAX; j = j + 1) {
            if (j < -n || j > n) { continue; }
            acc = acc + bilin(p + dir * (f32(j) / f32(n) * len));
        }
        smear = acc / f32(2 * n + 1);
    }
    let l = luma(smear.rgb);
    let toned = clamp(smear.rgb + vec3<f32>(params.darkness * (l - 0.5)), vec3<f32>(0.0), vec3<f32>(1.0));
    let styled = vec4<f32>(toned, a.a);
    let result = mix(a, styled, vec4<f32>(clamp(params.amount, 0.0, 1.0)));
    let m = textureLoad(mask, xy, 0).r;
    textureStore(outp, xy, mix(a, result, vec4<f32>(m)));
}
";

// ───────────────────────────── chrome ──────────────────────────────

/// `gallery.chrome` params.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, ::bytemuck::Pod, ::bytemuck::Zeroable)]
pub struct GalleryChromeParams {
    pub detail: f32,
    pub smoothness: f32,
    pub amount: f32,
    pub _abi_pad: u32,
}

impl GalleryChromeParams {
    pub fn new(detail: f32, smoothness: f32, amount: f32) -> Self {
        Self {
            detail,
            smoothness,
            amount,
            _abi_pad: 0,
        }
    }

    pub fn as_bytes(&self) -> &[u8] {
        ::bytemuck::bytes_of(self)
    }
}

/// CHROME — the luminance, box-smoothed over `round(smoothness)` px,
/// through a raised cosine of `1 + 0.3·detail` periods: dark and light
/// both map toward black, the mid tones toward white, which is the
/// polished-metal banding. Grey output.
///
/// IDENTITY: `amount = 0.0` returns the input unchanged.
pub static GALLERY_CHROME: KernelDef = KernelDef {
    id: "gallery.chrome",
    class: KernelClass::Resample { support: 1.0 },
    inputs: 1,
    params: ParamsLayout {
        size: ::core::mem::size_of::<GalleryChromeParams>(),
        fields: &[
            ParamField {
                name: "detail",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "smoothness",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "amount",
                wgsl_ty: "f32",
            },
        ],
    },
    wgsl: GALLERY_CHROME_WGSL,
    module: true,
    mip_exact: false,
    gpu_tolerance: Tolerance::ChannelEpsF16(8),
};

const GALLERY_CHROME_WGSL: &str = "\
// paged.image kernel `gallery.chrome` — handwritten under ABI v1.1.
// AGPL-3.0-only OR LicenseRef-PMEL; (c) And The Next GmbH.

struct Params {
    detail: f32,
    smoothness: f32,
    amount: f32,
    _abi_pad: u32,
}

@group(0) @binding(0) var in0 : texture_2d<f32>;
@group(1) @binding(0) var<uniform> params : Params;
@group(2) @binding(0) var mask : texture_2d<f32>;
@group(3) @binding(0) var outp : texture_storage_2d<rgba16float, write>;

const TAU : f32 = 6.2831853;

fn tap(c: vec2<i32>) -> vec4<f32> {
    let din = vec2<i32>(textureDimensions(in0));
    return textureLoad(in0, clamp(c, vec2<i32>(0), din - vec2<i32>(1)), 0);
}

fn bilin(p: vec2<f32>) -> vec4<f32> {
    let q = p - vec2<f32>(0.5);
    let f = floor(q);
    let t = q - f;
    let i = vec2<i32>(f);
    let top = mix(tap(i), tap(i + vec2<i32>(1, 0)), vec4<f32>(t.x));
    let bot = mix(tap(i + vec2<i32>(0, 1)), tap(i + vec2<i32>(1, 1)), vec4<f32>(t.x));
    return mix(top, bot, vec4<f32>(t.y));
}

fn luma(c: vec3<f32>) -> f32 {
    return dot(c, vec3<f32>(0.2126, 0.7152, 0.0722));
}

const R_MAX : i32 = 10;

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
    let d = textureDimensions(outp);
    if (gid.x >= d.x || gid.y >= d.y) { return; }
    let xy = vec2<i32>(i32(gid.x), i32(gid.y));
    let a = tap(xy);
    let r = i32(floor(clamp(params.smoothness, 0.0, 10.0) + 0.5));
    var s = 0.0;
    for (var dy : i32 = -R_MAX; dy <= R_MAX; dy = dy + 1) {
        if (dy < -r || dy > r) { continue; }
        for (var dx : i32 = -R_MAX; dx <= R_MAX; dx = dx + 1) {
            if (dx < -r || dx > r) { continue; }
            s = s + luma(tap(xy + vec2<i32>(dx, dy)).rgb);
        }
    }
    let w = f32(2 * r + 1);
    let l = s / (w * w);
    let freq = 1.0 + clamp(params.detail, 0.0, 10.0) * 0.3;
    let g = 0.5 - 0.5 * cos(TAU * fract(freq * l));
    let styled = vec4<f32>(vec3<f32>(g * a.a), a.a);
    let result = mix(a, styled, vec4<f32>(clamp(params.amount, 0.0, 1.0)));
    let m = textureLoad(mask, xy, 0).r;
    textureStore(outp, xy, mix(a, result, vec4<f32>(m)));
}
";

// ────────────────────────── plastic wrap ───────────────────────────

/// `gallery.plastic_wrap` params.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, ::bytemuck::Pod, ::bytemuck::Zeroable)]
pub struct GalleryPlasticWrapParams {
    pub strength: f32,
    pub detail: f32,
    pub smoothness: f32,
    pub amount: f32,
    pub _pad0: u32,
    pub _pad1: u32,
    pub _pad2: u32,
    pub _abi_pad: u32,
}

impl GalleryPlasticWrapParams {
    pub fn new(strength: f32, detail: f32, smoothness: f32, amount: f32) -> Self {
        Self {
            strength,
            detail,
            smoothness,
            amount,
            _pad0: 0,
            _pad1: 0,
            _pad2: 0,
            _abi_pad: 0,
        }
    }

    pub fn as_bytes(&self) -> &[u8] {
        ::bytemuck::bytes_of(self)
    }
}

/// PLASTIC WRAP — the box-smoothed luminance read as a heightfield;
/// its normal (central differences `step` px apart, smaller with more
/// `detail`) lit by a fixed upper-left light, a Blinn–Phong highlight of
/// exponent 24 (measured above a flat surface's, so flat areas get none) added
/// in white, and the slopes darkened a little, so
/// the image looks shrink-wrapped.
///
/// IDENTITY: `amount = 0.0` returns the input unchanged.
pub static GALLERY_PLASTIC_WRAP: KernelDef = KernelDef {
    id: "gallery.plastic_wrap",
    class: KernelClass::Resample { support: 1.0 },
    inputs: 1,
    params: ParamsLayout {
        size: ::core::mem::size_of::<GalleryPlasticWrapParams>(),
        fields: &[
            ParamField {
                name: "strength",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "detail",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "smoothness",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "amount",
                wgsl_ty: "f32",
            },
        ],
    },
    wgsl: GALLERY_PLASTIC_WRAP_WGSL,
    module: true,
    mip_exact: false,
    gpu_tolerance: Tolerance::ChannelEpsF16(8),
};

const GALLERY_PLASTIC_WRAP_WGSL: &str = "\
// paged.image kernel `gallery.plastic_wrap` — handwritten under ABI v1.1.
// AGPL-3.0-only OR LicenseRef-PMEL; (c) And The Next GmbH.

struct Params {
    strength: f32,
    detail: f32,
    smoothness: f32,
    amount: f32,
    _pad0: u32,
    _pad1: u32,
    _pad2: u32,
    _abi_pad: u32,
}

@group(0) @binding(0) var in0 : texture_2d<f32>;
@group(1) @binding(0) var<uniform> params : Params;
@group(2) @binding(0) var mask : texture_2d<f32>;
@group(3) @binding(0) var outp : texture_storage_2d<rgba16float, write>;

const TAU : f32 = 6.2831853;

fn tap(c: vec2<i32>) -> vec4<f32> {
    let din = vec2<i32>(textureDimensions(in0));
    return textureLoad(in0, clamp(c, vec2<i32>(0), din - vec2<i32>(1)), 0);
}

fn bilin(p: vec2<f32>) -> vec4<f32> {
    let q = p - vec2<f32>(0.5);
    let f = floor(q);
    let t = q - f;
    let i = vec2<i32>(f);
    let top = mix(tap(i), tap(i + vec2<i32>(1, 0)), vec4<f32>(t.x));
    let bot = mix(tap(i + vec2<i32>(0, 1)), tap(i + vec2<i32>(1, 1)), vec4<f32>(t.x));
    return mix(top, bot, vec4<f32>(t.y));
}

fn luma(c: vec3<f32>) -> f32 {
    return dot(c, vec3<f32>(0.2126, 0.7152, 0.0722));
}

const R_MAX : i32 = 8;

// x^24 by squaring — exact multiplications, so both lanes agree.
fn p24(x: f32) -> f32 {
    let x2 = x * x;
    let x4 = x2 * x2;
    let x8 = x4 * x4;
    return x8 * x8 * x8;
}

fn height(c: vec2<i32>, r: i32) -> f32 {
    var s = 0.0;
    for (var dy : i32 = -R_MAX; dy <= R_MAX; dy = dy + 1) {
        if (dy < -r || dy > r) { continue; }
        for (var dx : i32 = -R_MAX; dx <= R_MAX; dx = dx + 1) {
            if (dx < -r || dx > r) { continue; }
            s = s + luma(tap(c + vec2<i32>(dx, dy)).rgb);
        }
    }
    let w = f32(2 * r + 1);
    return s / (w * w);
}

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
    let d = textureDimensions(outp);
    if (gid.x >= d.x || gid.y >= d.y) { return; }
    let xy = vec2<i32>(i32(gid.x), i32(gid.y));
    let a = tap(xy);
    let r = i32(clamp(floor(clamp(params.smoothness, 1.0, 15.0) * 0.5 + 0.5), 0.0, 8.0));
    let st = i32(clamp(floor((16.0 - clamp(params.detail, 1.0, 15.0)) / 3.0 + 0.5), 1.0, 5.0));
    let hx = height(xy + vec2<i32>(st, 0), r) - height(xy - vec2<i32>(st, 0), r);
    let hy = height(xy + vec2<i32>(0, st), r) - height(xy - vec2<i32>(0, st), r);
    let k = 24.0 / f32(2 * st);
    let nrm = normalize(vec3<f32>(-hx * k, -hy * k, 1.0));
    // The highlight is measured ABOVE a flat surface's own, so a flat
    // area gets none: only slopes facing the light shine.
    let hv = normalize(vec3<f32>(-0.6, -0.6, 0.53) + vec3<f32>(0.0, 0.0, 1.0));
    let flat_spec = p24(hv.z);
    let spec = max(p24(max(dot(nrm, hv), 0.0)) - flat_spec, 0.0) / (1.0 - flat_spec);
    let ks = clamp(params.strength, 0.0, 20.0) / 20.0;
    let dark = 1.0 - ks * 0.6 * clamp((1.0 - nrm.z) * 4.0, 0.0, 1.0);
    let lit = clamp(a.rgb * dark + vec3<f32>(ks * spec * 1.5 * a.a), vec3<f32>(0.0), vec3<f32>(1.0));
    let styled = vec4<f32>(lit, a.a);
    let result = mix(a, styled, vec4<f32>(clamp(params.amount, 0.0, 1.0)));
    let m = textureLoad(mask, xy, 0).r;
    textureStore(outp, xy, mix(a, result, vec4<f32>(m)));
}
";

/// Every kernel of this family (the conformance gate joins it to the registry).
pub static FAMILY: &[&KernelDef] = &[&GALLERY_STROKES, &GALLERY_CHROME, &GALLERY_PLASTIC_WRAP];
