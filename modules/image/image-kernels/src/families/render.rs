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

//! Render family (WP5.2): Clouds, Difference Clouds, Fibers, Lens Flare,
//! Lighting Effects.
//!
//! The first three are GENERATORS that also read their input (Difference
//! Clouds blends against it; all three keep the selection mask). They are
//! `Point`-class handwritten modules over the whole image.
//!
//! * **No host randomness.** Every random pattern is value noise over the
//!   PCG output-permutation hash of (global lattice coordinate, seed),
//!   the same `pcg`/`hash21` the gallery family uses, character for
//!   character — so a seed reproduces its pixels on every adapter, and the
//!   scalar twin reproduces them in the conformance suite.
//! * **Position enters through `ox`/`oy`**, so a tiled dispatch does not
//!   restart the pattern at each tile.
//! * **Opaque output.** Clouds and Fibers fill the target opaque, as
//!   Photoshop's do on an empty layer; Difference Clouds keeps the input's
//!   alpha. Lens Flare is screened onto the image; Lighting Effects shades
//!   it — both keep alpha.
//!
//! Provenance: value noise with a Hermite fade and fractional Brownian
//! motion (Perlin, SIGGRAPH 1985; Ebert et al., *Texturing & Modeling*);
//! the PCG hash (O'Neill 2014; Jarzynski & Olano, JCGT 2020); Lambertian
//! diffuse plus Blinn–Phong specular shading with a bump map from a
//! heightfield (Blinn, SIGGRAPH 1977/1978); a spot light's smooth cone
//! falloff; lens-flare glow, ring, streak and ghost discs along the line
//! through the optical centre (a camera-optics description of what a
//! flare shows). No reference implementation was read.

use crate::{KernelClass, KernelDef, ParamField, ParamsLayout, Tolerance};

macro_rules! bindings_wgsl {
    () => {
        "
@group(0) @binding(0) var in0 : texture_2d<f32>;
@group(1) @binding(0) var<uniform> params : Params;
@group(2) @binding(0) var mask : texture_2d<f32>;
@group(3) @binding(0) var outp : texture_storage_2d<rgba16float, write>;
"
    };
}

/// Value noise over the PCG hash (kept character-identical to gallery.rs
/// for `pcg`/`hash21`).
macro_rules! noise_wgsl {
    () => {
        "
fn pcg(v: u32) -> u32 {
    let state = v * 747796405u + 2891336453u;
    let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
    return (word >> 22u) ^ word;
}

fn hash21(x: i32, y: i32, seed: u32) -> f32 {
    let h = pcg(bitcast<u32>(x) ^ pcg(bitcast<u32>(y) ^ pcg(seed)));
    return f32(h >> 8u) * 5.9604644775390625e-8;
}

fn vnoise(p: vec2<f32>, seed: u32) -> f32 {
    let i = floor(p);
    let f = p - i;
    let ix = i32(i.x);
    let iy = i32(i.y);
    let u = f * f * (vec2<f32>(3.0, 3.0) - 2.0 * f);
    let v00 = hash21(ix, iy, seed);
    let v10 = hash21(ix + 1, iy, seed);
    let v01 = hash21(ix, iy + 1, seed);
    let v11 = hash21(ix + 1, iy + 1, seed);
    let top = v00 * (1.0 - u.x) + v10 * u.x;
    let bot = v01 * (1.0 - u.x) + v11 * u.x;
    return top * (1.0 - u.y) + bot * u.y;
}
"
    };
}

/// Octaves of the clouds' fBm.
pub const CLOUD_OCTAVES: u32 = 8;
/// The fBm's contrast stretch about 0.5 (an fBm sum clusters at the mean).
pub const CLOUD_STRETCH: f32 = 1.6;

// ───────────────────────────── clouds ──────────────────────────────

/// `render.clouds` params.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, ::bytemuck::Pod, ::bytemuck::Zeroable)]
pub struct RenderCloudsParams {
    pub ox: i32,
    pub oy: i32,
    pub seed: u32,
    /// 1 = Difference Clouds (`|input − clouds|`), 0 = Clouds.
    pub difference: u32,
    pub fg_r: f32,
    pub fg_g: f32,
    pub fg_b: f32,
    /// The base feature size, px.
    pub scale_px: f32,
    pub bg_r: f32,
    pub bg_g: f32,
    pub bg_b: f32,
    pub _pad0: u32,
    pub _pad1: u32,
    pub _pad2: u32,
    pub _pad3: u32,
    pub _abi_pad: u32,
}

impl RenderCloudsParams {
    pub fn new(seed: u32, fg: [f32; 3], bg: [f32; 3], difference: bool, scale_px: f32) -> Self {
        Self {
            ox: 0,
            oy: 0,
            seed,
            difference: u32::from(difference),
            fg_r: fg[0],
            fg_g: fg[1],
            fg_b: fg[2],
            scale_px,
            bg_r: bg[0],
            bg_g: bg[1],
            bg_b: bg[2],
            _pad0: 0,
            _pad1: 0,
            _pad2: 0,
            _pad3: 0,
            _abi_pad: 0,
        }
    }

    /// The scale the doors use for a `w`×`h` canvas: a quarter of the long
    /// side, kept between 32 and 256 px.
    pub fn scale_for(w: u32, h: u32) -> f32 {
        (w.max(h) as f32 / 4.0).clamp(32.0, 256.0)
    }

    pub fn as_bytes(&self) -> &[u8] {
        ::bytemuck::bytes_of(self)
    }
}

/// Clouds / Difference Clouds: an 8-octave fBm of value noise, stretched
/// about its mean, mapped from the foreground colour (low) to the
/// background colour (high). Clouds writes it opaque; Difference Clouds
/// writes `|input − clouds|` per rgb and keeps the input's alpha.
pub static RENDER_CLOUDS: KernelDef = KernelDef {
    id: "render.clouds",
    class: KernelClass::Point,
    inputs: 1,
    params: ParamsLayout {
        size: ::core::mem::size_of::<RenderCloudsParams>(),
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
                name: "difference",
                wgsl_ty: "u32",
            },
            ParamField {
                name: "fg_r",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "fg_g",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "fg_b",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "scale_px",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "bg_r",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "bg_g",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "bg_b",
                wgsl_ty: "f32",
            },
        ],
    },
    wgsl: RENDER_CLOUDS_WGSL,
    module: true,
    mip_exact: false,
    gpu_tolerance: Tolerance::ChannelEpsF16(4),
};

const RENDER_CLOUDS_WGSL: &str = concat!(
    "// paged.image kernel `render.clouds` — handwritten under ABI v1.1.
// AGPL-3.0-only OR LicenseRef-PMEL; (c) And The Next GmbH.

struct Params {
    ox: i32,
    oy: i32,
    seed: u32,
    difference: u32,
    fg_r: f32,
    fg_g: f32,
    fg_b: f32,
    scale_px: f32,
    bg_r: f32,
    bg_g: f32,
    bg_b: f32,
    _pad0: u32,
    _pad1: u32,
    _pad2: u32,
    _pad3: u32,
    _abi_pad: u32,
}
",
    bindings_wgsl!(),
    noise_wgsl!(),
    "
@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
    let d = textureDimensions(outp);
    if (gid.x >= d.x || gid.y >= d.y) { return; }
    let xy = vec2<i32>(i32(gid.x), i32(gid.y));
    let a = textureLoad(in0, xy, 0);
    let pos = vec2<f32>(f32(params.ox + xy.x) + 0.5, f32(params.oy + xy.y) + 0.5);
    var q = pos / max(params.scale_px, 1.0);
    var sum = 0.0;
    var amp = 0.5;
    var norm = 0.0;
    for (var o = 0u; o < 8u; o = o + 1u) {
        sum = sum + amp * vnoise(q, params.seed + o * 7919u);
        norm = norm + amp;
        amp = amp * 0.5;
        q = q * 2.0;
    }
    let v = clamp((sum / norm - 0.5) * 1.6 + 0.5, 0.0, 1.0);
    let fg = vec3<f32>(params.fg_r, params.fg_g, params.fg_b);
    let bg = vec3<f32>(params.bg_r, params.bg_g, params.bg_b);
    let cl = fg * (1.0 - v) + bg * v;
    var result = vec4<f32>(cl, 1.0);
    if (params.difference == 1u) {
        var c = a.rgb;
        if (a.a > 0.0) { c = a.rgb / a.a; }
        result = vec4<f32>(abs(c - cl) * a.a, a.a);
    }
    let m = textureLoad(mask, xy, 0).r;
    textureStore(outp, xy, mix(a, result, vec4<f32>(m)));
}
"
);

// ───────────────────────────── fibers ──────────────────────────────

/// `render.fibers` params.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, ::bytemuck::Pod, ::bytemuck::Zeroable)]
pub struct RenderFibersParams {
    pub ox: i32,
    pub oy: i32,
    pub seed: u32,
    /// 1..64: how fast the colour varies across the fibres.
    pub variance: f32,
    /// 1..64: how long the fibres run.
    pub strength: f32,
    pub fg_r: f32,
    pub fg_g: f32,
    pub fg_b: f32,
    pub bg_r: f32,
    pub bg_g: f32,
    pub bg_b: f32,
    pub _pad0: u32,
    pub _pad1: u32,
    pub _pad2: u32,
    pub _pad3: u32,
    pub _abi_pad: u32,
}

impl RenderFibersParams {
    pub fn new(seed: u32, variance: f32, strength: f32, fg: [f32; 3], bg: [f32; 3]) -> Self {
        Self {
            ox: 0,
            oy: 0,
            seed,
            variance,
            strength,
            fg_r: fg[0],
            fg_g: fg[1],
            fg_b: fg[2],
            bg_r: bg[0],
            bg_g: bg[1],
            bg_b: bg[2],
            _pad0: 0,
            _pad1: 0,
            _pad2: 0,
            _pad3: 0,
            _abi_pad: 0,
        }
    }

    pub fn as_bytes(&self) -> &[u8] {
        ::bytemuck::bytes_of(self)
    }
}

/// Fibers: three octaves of value noise ANISOTROPIC in y — cells
/// `64 / variance` px wide and `8 · strength` px tall — so the noise
/// streaks into vertical fibres, mapped from the foreground (low) to the
/// background colour (high), opaque.
pub static RENDER_FIBERS: KernelDef = KernelDef {
    id: "render.fibers",
    class: KernelClass::Point,
    inputs: 1,
    params: ParamsLayout {
        size: ::core::mem::size_of::<RenderFibersParams>(),
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
                name: "variance",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "strength",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "fg_r",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "fg_g",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "fg_b",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "bg_r",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "bg_g",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "bg_b",
                wgsl_ty: "f32",
            },
        ],
    },
    wgsl: RENDER_FIBERS_WGSL,
    module: true,
    mip_exact: false,
    gpu_tolerance: Tolerance::ChannelEpsF16(4),
};

const RENDER_FIBERS_WGSL: &str = concat!(
    "// paged.image kernel `render.fibers` — handwritten under ABI v1.1.
// AGPL-3.0-only OR LicenseRef-PMEL; (c) And The Next GmbH.

struct Params {
    ox: i32,
    oy: i32,
    seed: u32,
    variance: f32,
    strength: f32,
    fg_r: f32,
    fg_g: f32,
    fg_b: f32,
    bg_r: f32,
    bg_g: f32,
    bg_b: f32,
    _pad0: u32,
    _pad1: u32,
    _pad2: u32,
    _pad3: u32,
    _abi_pad: u32,
}
",
    bindings_wgsl!(),
    noise_wgsl!(),
    "
@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
    let d = textureDimensions(outp);
    if (gid.x >= d.x || gid.y >= d.y) { return; }
    let xy = vec2<i32>(i32(gid.x), i32(gid.y));
    let a = textureLoad(in0, xy, 0);
    let pos = vec2<f32>(f32(params.ox + xy.x) + 0.5, f32(params.oy + xy.y) + 0.5);
    let cell = vec2<f32>(64.0 / clamp(params.variance, 1.0, 64.0), 8.0 * clamp(params.strength, 1.0, 64.0));
    let q = pos / cell;
    let n = 0.6 * vnoise(q, params.seed)
        + 0.3 * vnoise(q * 2.0, params.seed + 1u)
        + 0.1 * vnoise(q * 4.0, params.seed + 2u);
    let v = clamp((n - 0.5) * 2.0 + 0.5, 0.0, 1.0);
    let fg = vec3<f32>(params.fg_r, params.fg_g, params.fg_b);
    let bg = vec3<f32>(params.bg_r, params.bg_g, params.bg_b);
    let result = vec4<f32>(fg * (1.0 - v) + bg * v, 1.0);
    let m = textureLoad(mask, xy, 0).r;
    textureStore(outp, xy, mix(a, result, vec4<f32>(m)));
}
"
);

// ──────────────────────────── lens flare ───────────────────────────

/// Lens types.
pub const FLARE_ZOOM: u32 = 0;
pub const FLARE_35MM: u32 = 1;
pub const FLARE_105MM: u32 = 2;
pub const FLARE_MOVIE: u32 = 3;

/// `render.lens_flare` params.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, ::bytemuck::Pod, ::bytemuck::Zeroable)]
pub struct RenderLensFlareParams {
    /// The flare centre, px.
    pub cx: f32,
    pub cy: f32,
    /// 0.1..3 (Photoshop's brightness percent / 100).
    pub brightness: f32,
    /// [`FLARE_ZOOM`], [`FLARE_35MM`], [`FLARE_105MM`] or [`FLARE_MOVIE`].
    pub kind: u32,
    pub _pad0: u32,
    pub _pad1: u32,
    pub _pad2: u32,
    pub _abi_pad: u32,
}

impl RenderLensFlareParams {
    pub fn new(cx: f32, cy: f32, brightness: f32, kind: u32) -> Self {
        Self {
            cx,
            cy,
            brightness,
            kind,
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

/// Lens Flare, SCREENED onto the image: a hot core and a soft glow at
/// the centre, a ring (zoom, 35 mm and 105 mm lenses — at a radius each
/// lens sets), six-fold rays (zoom and 105 mm), a horizontal streak
/// (movie prime), and five tinted ghost discs along the line from the
/// flare through the canvas centre. Distances are in units of the
/// canvas diagonal, so the flare looks the same at any size.
pub static RENDER_LENS_FLARE: KernelDef = KernelDef {
    id: "render.lens_flare",
    class: KernelClass::Point,
    inputs: 1,
    params: ParamsLayout {
        size: ::core::mem::size_of::<RenderLensFlareParams>(),
        fields: &[
            ParamField {
                name: "cx",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "cy",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "brightness",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "kind",
                wgsl_ty: "u32",
            },
        ],
    },
    wgsl: RENDER_LENS_FLARE_WGSL,
    module: true,
    mip_exact: false,
    gpu_tolerance: Tolerance::ChannelEpsF16(16),
};

const RENDER_LENS_FLARE_WGSL: &str = concat!(
    "// paged.image kernel `render.lens_flare` — handwritten under ABI v1.1.
// AGPL-3.0-only OR LicenseRef-PMEL; (c) And The Next GmbH.

struct Params {
    cx: f32,
    cy: f32,
    brightness: f32,
    kind: u32,
    _pad0: u32,
    _pad1: u32,
    _pad2: u32,
    _abi_pad: u32,
}
",
    bindings_wgsl!(),
    "
fn flare(p: vec2<f32>, dims: vec2<f32>) -> vec3<f32> {
    let diag = length(dims);
    let c = vec2<f32>(params.cx, params.cy);
    let dv = (p - c) / diag;
    let r = length(dv);
    let k = params.kind;
    var f = (exp(-r * r / 0.0008) + 0.4 * exp(-r / 0.06)) * vec3<f32>(1.0, 0.95, 0.85);
    if (k != 3u) {
        var r0 = 0.12;
        if (k == 1u) { r0 = 0.09; }
        if (k == 2u) { r0 = 0.15; }
        let ring = exp(-((r - r0) / 0.008) * ((r - r0) / 0.008)) * 0.25;
        f = f + ring * vec3<f32>(0.7, 0.8, 1.0);
    }
    if (k == 0u || k == 2u) {
        let th = atan2(dv.y, dv.x);
        let rays = 0.15 * pow(abs(cos(th * 3.0)), 8.0) * exp(-r / 0.1);
        f = f + vec3<f32>(rays);
    }
    if (k == 3u) {
        let streak = exp(-abs(dv.y) / 0.003) * exp(-abs(dv.x) / 0.35) * 0.8;
        f = f + streak * vec3<f32>(0.6, 0.75, 1.0);
    }
    let axis = dims * 0.5 - c;
    for (var i = 0u; i < 5u; i = i + 1u) {
        let fi = f32(i);
        let t = 0.4 + 0.35 * fi + 0.05 * f32(k);
        let g = c + axis * t;
        let size = 0.02 + 0.015 * f32((i * 7u + k * 3u) % 5u);
        let gd = length(p - g) / diag;
        let disc = clamp((size - gd) / (0.2 * size), 0.0, 1.0) * 0.12;
        let h = fi * 1.7 + f32(k);
        f = f + disc * vec3<f32>(0.6 + 0.4 * sin(h), 0.6 + 0.4 * sin(h + 2.1), 0.6 + 0.4 * sin(h + 4.2));
    }
    return f * params.brightness;
}

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
    let d = textureDimensions(outp);
    if (gid.x >= d.x || gid.y >= d.y) { return; }
    let xy = vec2<i32>(i32(gid.x), i32(gid.y));
    let a = textureLoad(in0, xy, 0);
    var c = a.rgb;
    if (a.a > 0.0) { c = a.rgb / a.a; }
    let f = clamp(flare(vec2<f32>(f32(xy.x) + 0.5, f32(xy.y) + 0.5), vec2<f32>(f32(d.x), f32(d.y))),
        vec3<f32>(0.0), vec3<f32>(1.0));
    let s = vec3<f32>(1.0) - (vec3<f32>(1.0) - c) * (vec3<f32>(1.0) - f);
    let result = vec4<f32>(s * a.a, a.a);
    let m = textureLoad(mask, xy, 0).r;
    textureStore(outp, xy, mix(a, result, vec4<f32>(m)));
}
"
);

// ───────────────────────── lighting effects ────────────────────────

/// Light types.
pub const LIGHT_SPOT: u32 = 0;
pub const LIGHT_POINT: u32 = 1;
pub const LIGHT_INFINITE: u32 = 2;

/// The settings array length the door takes (see [`RenderLightingParams::from_settings`]).
pub const LIGHTING_SETTINGS: usize = 19;

/// `render.lighting` params — the derived form of the 19 settings.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, ::bytemuck::Pod, ::bytemuck::Zeroable)]
pub struct RenderLightingParams {
    pub kind: u32,
    /// 0 none, 1 R, 2 G, 3 B, 4 alpha, 5 luminance.
    pub tex: u32,
    pub white_high: u32,
    pub _pad0: u32,
    /// Light position, px (z over the canvas).
    pub lx: f32,
    pub ly: f32,
    pub lz: f32,
    /// 0..2.
    pub intensity: f32,
    /// The direction the light SHINES (spot, infinite), unit.
    pub dx: f32,
    pub dy: f32,
    pub dz: f32,
    pub cos_cone: f32,
    pub cos_outer: f32,
    pub r: f32,
    pub g: f32,
    pub b: f32,
    pub gloss: f32,
    pub metallic: f32,
    pub exposure: f32,
    pub ambience: f32,
    /// 0..1.
    pub bump: f32,
    pub _pad1: u32,
    pub _pad2: u32,
    pub _abi_pad: u32,
}

impl RenderLightingParams {
    /// Derive from the door's 19 settings on a `w`×`h` canvas:
    /// `[type, x 0..1, y 0..1, height 0..1, direction°, cone°, intensity,
    /// r, g, b, gloss, metallic, exposure, ambience, texture channel,
    /// bump height 0..100, white is high, focus, elevation°]`.
    pub fn from_settings(s: &[f32; LIGHTING_SETTINGS], w: u32, h: u32) -> Self {
        let (wf, hf) = (w as f32, h as f32);
        let kind = (s[0].round().clamp(0.0, 2.0)) as u32;
        let ang = s[4].to_radians();
        let (sa, ca) = ang.sin_cos();
        let (dx, dy, dz) = if kind == LIGHT_INFINITE {
            let e = s[18].clamp(0.0, 90.0).to_radians();
            let (se, ce) = e.sin_cos();
            // The light comes FROM (cos a·cos e, −sin a·cos e, sin e).
            (-ca * ce, sa * ce, -se)
        } else {
            let n = (ca * ca + sa * sa + 1.0).sqrt();
            (ca / n, -sa / n, -1.0 / n)
        };
        let cone = s[5].clamp(1.0, 90.0);
        let focus = s[17].clamp(-100.0, 100.0);
        let outer = (cone * (1.05 + (100.0 - focus) / 200.0 * 0.95)).min(179.0);
        Self {
            kind,
            tex: (s[14].round().clamp(0.0, 5.0)) as u32,
            white_high: u32::from(s[16] >= 0.5),
            _pad0: 0,
            lx: s[1] * wf,
            ly: s[2] * hf,
            lz: (s[3] * wf.max(hf)).max(1.0),
            intensity: 1.0 + s[6].clamp(-100.0, 100.0) / 100.0,
            dx,
            dy,
            dz,
            cos_cone: cone.to_radians().cos(),
            cos_outer: outer.to_radians().cos(),
            r: s[7],
            g: s[8],
            b: s[9],
            gloss: s[10].clamp(-100.0, 100.0),
            metallic: s[11].clamp(-100.0, 100.0),
            exposure: s[12].clamp(-100.0, 100.0),
            ambience: s[13].clamp(-100.0, 100.0),
            bump: s[15].clamp(0.0, 100.0) / 100.0,
            _pad1: 0,
            _pad2: 0,
            _abi_pad: 0,
        }
    }

    pub fn as_bytes(&self) -> &[u8] {
        ::bytemuck::bytes_of(self)
    }
}

/// Lighting Effects: one spot, point (omni) or infinite light shading the
/// image as a surface. The surface normal comes from a TEXTURE CHANNEL
/// read as a heightfield (white high, or inverted), scaled by the bump
/// height; the light colour drives Lambertian diffuse and a Blinn–Phong
/// highlight whose sharpness is the gloss and whose colour moves from the
/// light's toward the surface's with the metallic setting. Ambience lifts
/// the unlit level, exposure scales the result in stops (±1 at ±100).
pub static RENDER_LIGHTING: KernelDef = KernelDef {
    id: "render.lighting",
    class: KernelClass::Point,
    inputs: 1,
    params: ParamsLayout {
        size: ::core::mem::size_of::<RenderLightingParams>(),
        fields: &[
            ParamField {
                name: "kind",
                wgsl_ty: "u32",
            },
            ParamField {
                name: "tex",
                wgsl_ty: "u32",
            },
            ParamField {
                name: "white_high",
                wgsl_ty: "u32",
            },
            ParamField {
                name: "_pad0",
                wgsl_ty: "u32",
            },
            ParamField {
                name: "lx",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "ly",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "lz",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "intensity",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "dx",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "dy",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "dz",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "cos_cone",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "cos_outer",
                wgsl_ty: "f32",
            },
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
                name: "gloss",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "metallic",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "exposure",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "ambience",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "bump",
                wgsl_ty: "f32",
            },
        ],
    },
    wgsl: RENDER_LIGHTING_WGSL,
    module: true,
    mip_exact: false,
    gpu_tolerance: Tolerance::ChannelEpsF16(16),
};

const RENDER_LIGHTING_WGSL: &str = concat!(
    "// paged.image kernel `render.lighting` — handwritten under ABI v1.1.
// AGPL-3.0-only OR LicenseRef-PMEL; (c) And The Next GmbH.

struct Params {
    kind: u32,
    tex: u32,
    white_high: u32,
    _pad0: u32,
    lx: f32,
    ly: f32,
    lz: f32,
    intensity: f32,
    dx: f32,
    dy: f32,
    dz: f32,
    cos_cone: f32,
    cos_outer: f32,
    r: f32,
    g: f32,
    b: f32,
    gloss: f32,
    metallic: f32,
    exposure: f32,
    ambience: f32,
    bump: f32,
    _pad1: u32,
    _pad2: u32,
    _abi_pad: u32,
}
",
    bindings_wgsl!(),
    "
fn height_at(q: vec2<i32>) -> f32 {
    let dm = vec2<i32>(textureDimensions(in0));
    let t = textureLoad(in0, clamp(q, vec2<i32>(0, 0), dm - vec2<i32>(1, 1)), 0);
    var c = t.rgb;
    if (t.a > 0.0) { c = t.rgb / t.a; }
    var v = 0.0;
    if (params.tex == 1u) { v = c.r; }
    if (params.tex == 2u) { v = c.g; }
    if (params.tex == 3u) { v = c.b; }
    if (params.tex == 4u) { v = t.a; }
    if (params.tex == 5u) { v = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b; }
    if (params.white_high == 0u) { v = 1.0 - v; }
    return v;
}

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
    let d = textureDimensions(outp);
    if (gid.x >= d.x || gid.y >= d.y) { return; }
    let xy = vec2<i32>(i32(gid.x), i32(gid.y));
    let a = textureLoad(in0, xy, 0);
    var c = a.rgb;
    if (a.a > 0.0) { c = a.rgb / a.a; }
    var n = vec3<f32>(0.0, 0.0, 1.0);
    if (params.tex != 0u) {
        let gx = (height_at(xy + vec2<i32>(1, 0)) - height_at(xy - vec2<i32>(1, 0))) * 0.5;
        let gy = (height_at(xy + vec2<i32>(0, 1)) - height_at(xy - vec2<i32>(0, 1))) * 0.5;
        let k = params.bump * 8.0;
        n = normalize(vec3<f32>(-gx * k, -gy * k, 1.0));
    }
    let pos = vec3<f32>(f32(xy.x) + 0.5, f32(xy.y) + 0.5, 0.0);
    let dir = vec3<f32>(params.dx, params.dy, params.dz);
    var l = -dir;
    var spot = 1.0;
    if (params.kind != 2u) {
        l = normalize(vec3<f32>(params.lx, params.ly, params.lz) - pos);
        if (params.kind == 0u) {
            spot = smoothstep(params.cos_outer, params.cos_cone, dot(-l, dir));
        }
    }
    let diff = max(dot(n, l), 0.0) * spot * params.intensity;
    let hv = normalize(l + vec3<f32>(0.0, 0.0, 1.0));
    let shin = 2.0 + (params.gloss + 100.0) * 0.49;
    let ks = (params.gloss + 100.0) / 200.0 * 0.6;
    let spec = pow(max(dot(n, hv), 0.000001), shin) * ks * spot * params.intensity;
    let metal = (params.metallic + 100.0) / 200.0;
    let lc = vec3<f32>(params.r, params.g, params.b);
    let sc = lc * (1.0 - metal) + c * metal;
    let amb = (params.ambience + 100.0) / 200.0 * 0.6;
    let e = exp2(params.exposure / 100.0);
    let rgb = clamp(e * (c * (amb + diff * lc) + spec * sc), vec3<f32>(0.0), vec3<f32>(1.0));
    let result = vec4<f32>(rgb * a.a, a.a);
    let m = textureLoad(mask, xy, 0).r;
    textureStore(outp, xy, mix(a, result, vec4<f32>(m)));
}
"
);

/// Every kernel of this family (the conformance gate joins it to the registry).
pub static FAMILY: &[&KernelDef] = &[
    &RENDER_CLOUDS,
    &RENDER_FIBERS,
    &RENDER_LENS_FLARE,
    &RENDER_LIGHTING,
];
