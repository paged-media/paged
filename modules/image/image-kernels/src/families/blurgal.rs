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

//! Blur Gallery family (WP5.2): Field, Iris, Tilt-Shift, Path and Spin
//! blur — spatially varying kernels.
//!
//! Photoshop's Blur Gallery is five blurs whose strength VARIES across the
//! image with geometry the user places on the canvas: pins (Field), an
//! ellipse (Iris), a band (Tilt-Shift), a polyline (Path), an ellipse
//! with an arc (Spin). Each kernel here is the same two steps:
//!
//! 1. compute a per-pixel blur — a radius (Field, Iris, Tilt-Shift), a
//!    direction and length (Path), an arc (Spin) — from the geometry in
//!    the params;
//! 2. integrate the source over that support with a FIXED tap schedule:
//!    a golden-angle (Vogel) disc for the radial three, a line for Path,
//!    an arc about the centre for Spin. Taps are bilinear, so a radius
//!    that varies smoothly gives a blur that varies smoothly.
//!
//! `light_bokeh` (0..1) weights bright taps up before the average and
//! divides by the same weights after — the standard real-time bokeh
//! approximation `conv.lens` uses too — so specular points bloom into
//! discs instead of averaging away.
//!
//! CLASS. Every kernel reads arbitrary source positions, so each is
//! `Resample` (the source window is the whole image), like
//! `geom.warp_backward` and `geom.mosaic`, never `Point` (Engine A fuses
//! point kernels per tile). Geometry is in IMAGE pixels; the doors
//! dispatch the whole image at once.
//!
//! IDENTITY. A support below half a pixel returns the source pixel
//! itself (blur 0, speed 0, arc 0) — no tap arithmetic, so it is exact.
//!
//! Provenance: Vogel's sunflower spiral for uniform disc sampling
//! (Mathematical Biosciences 1979); Shepard's inverse-distance
//! interpolation (ACM 1968) for the field between pins; line and arc
//! integration are textbook motion-blur constructions; the highlight
//! weight is the common real-time bokeh approximation. Behaviour derived
//! from Photoshop's public documentation of the Blur Gallery; no
//! reference code was read.

use crate::{KernelClass, KernelDef, ParamField, ParamsLayout, Tolerance};

/// The largest blur radius (and Path length) any Blur Gallery kernel
/// takes, in image px; the doors refuse more.
pub const BLUR_MAX_PX: f32 = 128.0;
/// Pins of a Field blur, points of a Path blur.
pub const BLUR_MAX_POINTS: usize = 8;
/// The disc's tap budget: `clamp(ceil(3·r − 0.001), 8, DISC_MAX_TAPS)`.
/// The small bias keeps the count stable where `3·r` is a whole number:
/// a Field blur's radius is `Σw·b / Σw`, which lands an ulp either side of
/// the pin's value, and an unbiased `ceil` then flips between two tap
/// counts — two different images for the same setting.
pub const DISC_MAX_TAPS: u32 = 192;

// ── shared WGSL ─────────────────────────────────────────────────────
//
// Repeated verbatim in each module (WGSL has no include here). The
// golden angle enters as a TURN FRACTION (`fract(k · 0.381966…)`) so the
// trigonometry always sees an argument in [0, 2π) — `cos(458.0)` is where
// GPU transcendentals lose their precision, and the twin must agree.
// (The shared helpers below are spliced into each module's text.)

/// The module prologue: the generated header line, the Params struct
/// and the common helpers.
macro_rules! blur_module {
    ($id:literal, $params:literal, $body:literal) => {
        concat!(
            "// paged.image kernel `",
            $id,
            "` — handwritten under ABI v1.1.\n",
            "// AGPL-3.0-only OR LicenseRef-PMEL; (c) And The Next GmbH.\n\n",
            "struct Params {\n",
            $params,
            "}\n",
            $body
        )
    };
}

macro_rules! pod_params {
    ($name:ident) => {
        #[allow(clippy::new_without_default)]
        impl $name {
            pub fn as_bytes(&self) -> &[u8] {
                ::bytemuck::bytes_of(self)
            }
        }
    };
}

// ──────────────────────────────── field ─────────────────────────────

/// `blur.field` params: up to eight pins `(x, y, blur_px)` in image px.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, ::bytemuck::Pod, ::bytemuck::Zeroable)]
pub struct BlurFieldParams {
    pub count: u32,
    pub light_bokeh: f32,
    pub p0x: f32,
    pub p0y: f32,
    pub p0b: f32,
    pub p1x: f32,
    pub p1y: f32,
    pub p1b: f32,
    pub p2x: f32,
    pub p2y: f32,
    pub p2b: f32,
    pub p3x: f32,
    pub p3y: f32,
    pub p3b: f32,
    pub p4x: f32,
    pub p4y: f32,
    pub p4b: f32,
    pub p5x: f32,
    pub p5y: f32,
    pub p5b: f32,
    pub p6x: f32,
    pub p6y: f32,
    pub p6b: f32,
    pub p7x: f32,
    pub p7y: f32,
    pub p7b: f32,
    pub _pad0: u32,
    pub _abi_pad: u32,
}
pod_params!(BlurFieldParams);

impl BlurFieldParams {
    /// `pins` past [`BLUR_MAX_POINTS`] are ignored (the door refuses them).
    pub fn new(pins: &[(f32, f32, f32)], light_bokeh: f32) -> Self {
        let mut p: Self = ::bytemuck::Zeroable::zeroed();
        p.count = pins.len().min(BLUR_MAX_POINTS) as u32;
        p.light_bokeh = light_bokeh;
        let slots: &mut [f32] =
            &mut ::bytemuck::cast_slice_mut::<Self, f32>(::core::slice::from_mut(&mut p))
                [2..2 + 3 * BLUR_MAX_POINTS];
        for (i, (x, y, b)) in pins.iter().take(BLUR_MAX_POINTS).enumerate() {
            slots[3 * i] = *x;
            slots[3 * i + 1] = *y;
            slots[3 * i + 2] = *b;
        }
        p
    }

    /// Pin `i` as `(x, y, blur_px)`.
    pub fn pin(&self, i: usize) -> (f32, f32, f32) {
        let f: &[f32] = ::bytemuck::cast_slice(::core::slice::from_ref(self));
        (f[2 + 3 * i], f[3 + 3 * i], f[4 + 3 * i])
    }
}

/// FIELD BLUR — a blur radius at every pin, interpolated between them by
/// inverse squared distance (Shepard), so one pin blurs everything evenly
/// and two pins (0 and 20 px) grade from sharp to blurred.
///
/// IDENTITY: every pin at 0 px returns the input exactly.
pub static BLUR_FIELD: KernelDef = KernelDef {
    id: "blur.field",
    class: KernelClass::Resample { support: 1.0 },
    inputs: 1,
    params: ParamsLayout {
        size: ::core::mem::size_of::<BlurFieldParams>(),
        fields: &[
            ParamField {
                name: "count",
                wgsl_ty: "u32",
            },
            ParamField {
                name: "light_bokeh",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "p0x",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "p0y",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "p0b",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "p1x",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "p1y",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "p1b",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "p2x",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "p2y",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "p2b",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "p3x",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "p3y",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "p3b",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "p4x",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "p4y",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "p4b",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "p5x",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "p5y",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "p5b",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "p6x",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "p6y",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "p6b",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "p7x",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "p7y",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "p7b",
                wgsl_ty: "f32",
            },
        ],
    },
    wgsl: BLUR_FIELD_WGSL,
    module: true,
    mip_exact: false,
    gpu_tolerance: Tolerance::ChannelEpsF16(8),
};

const BLUR_FIELD_WGSL: &str = blur_module!(
    "blur.field",
    "    count: u32,
    light_bokeh: f32,
    p0x: f32,
    p0y: f32,
    p0b: f32,
    p1x: f32,
    p1y: f32,
    p1b: f32,
    p2x: f32,
    p2y: f32,
    p2b: f32,
    p3x: f32,
    p3y: f32,
    p3b: f32,
    p4x: f32,
    p4y: f32,
    p4b: f32,
    p5x: f32,
    p5y: f32,
    p5b: f32,
    p6x: f32,
    p6y: f32,
    p6b: f32,
    p7x: f32,
    p7y: f32,
    p7b: f32,
    _pad0: u32,
    _abi_pad: u32,
",
    "@group(0) @binding(0) var in0 : texture_2d<f32>;
@group(1) @binding(0) var<uniform> params : Params;
@group(2) @binding(0) var mask : texture_2d<f32>;
@group(3) @binding(0) var outp : texture_storage_2d<rgba16float, write>;

const TAU : f32 = 6.2831853;
const GOLDEN_TURN : f32 = 0.381966011;
const DISC_MAX : i32 = 192;
const BLUR_MAX : f32 = 128.0;

fn tap(c: vec2<i32>) -> vec4<f32> {
    let din = vec2<i32>(textureDimensions(in0));
    return textureLoad(in0, clamp(c, vec2<i32>(0), din - vec2<i32>(1)), 0);
}

// Bilinear at a continuous position, pixel centres at +0.5: the pixel's
// own centre lands on t = 0 and returns that pixel.
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

fn bokeh_w(s: vec4<f32>, bokeh: f32) -> f32 {
    return 1.0 + clamp(bokeh, 0.0, 1.0) * 16.0 * max(luma(s.rgb) - 0.7, 0.0);
}

// The Vogel disc of radius r about p.
fn disc(p: vec2<f32>, r: f32, bokeh: f32) -> vec4<f32> {
    let n = clamp(i32(ceil(3.0 * r - 0.001)), 8, DISC_MAX);
    var acc = vec4<f32>(0.0);
    var wsum = 0.0;
    for (var k : i32 = 0; k < DISC_MAX; k = k + 1) {
        if (k >= n) { break; }
        let fk = f32(k);
        let rho = r * sqrt((fk + 0.5) / f32(n));
        let th = fract(fk * GOLDEN_TURN) * TAU;
        let s = bilin(p + rho * vec2<f32>(cos(th), sin(th)));
        let w = bokeh_w(s, bokeh);
        acc = acc + s * w;
        wsum = wsum + w;
    }
    return acc / wsum;
}

fn smooth01(t: f32) -> f32 {
    let u = clamp(t, 0.0, 1.0);
    return u * u * (3.0 - 2.0 * u);
}

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
    let d = textureDimensions(outp);
    if (gid.x >= d.x || gid.y >= d.y) { return; }
    let xy = vec2<i32>(i32(gid.x), i32(gid.y));
    let a = tap(xy);
    let p = vec2<f32>(xy) + vec2<f32>(0.5);
    var pins = array<vec3<f32>, 8>(
        vec3<f32>(params.p0x, params.p0y, params.p0b),
        vec3<f32>(params.p1x, params.p1y, params.p1b),
        vec3<f32>(params.p2x, params.p2y, params.p2b),
        vec3<f32>(params.p3x, params.p3y, params.p3b),
        vec3<f32>(params.p4x, params.p4y, params.p4b),
        vec3<f32>(params.p5x, params.p5y, params.p5b),
        vec3<f32>(params.p6x, params.p6y, params.p6b),
        vec3<f32>(params.p7x, params.p7y, params.p7b));
    let cnt = min(params.count, 8u);
    var ws = 0.0;
    var bs = 0.0;
    for (var i : u32 = 0u; i < 8u; i = i + 1u) {
        if (i >= cnt) { break; }
        let q = pins[i];
        let dv = p - q.xy;
        let w = 1.0 / (dot(dv, dv) + 1.0);
        ws = ws + w;
        bs = bs + w * clamp(q.z, 0.0, BLUR_MAX);
    }
    var r = 0.0;
    if (ws > 0.0) { r = bs / ws; }
    var result = a;
    if (r >= 0.5) { result = disc(p, r, params.light_bokeh); }
    let m = textureLoad(mask, xy, 0).r;
    textureStore(outp, xy, mix(a, result, vec4<f32>(m)));
}
"
);

// ──────────────────────────────── iris ──────────────────────────────

/// `blur.iris` params: the ellipse (centre, radii, rotation), the blur
/// outside it and the sharp core as a fraction of the ellipse.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, ::bytemuck::Pod, ::bytemuck::Zeroable)]
pub struct BlurIrisParams {
    pub cx: f32,
    pub cy: f32,
    pub rx: f32,
    pub ry: f32,
    pub rotation_deg: f32,
    pub blur_px: f32,
    pub feather: f32,
    pub light_bokeh: f32,
    pub _pad0: u32,
    pub _pad1: u32,
    pub _pad2: u32,
    pub _abi_pad: u32,
}
pod_params!(BlurIrisParams);

impl BlurIrisParams {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        cx: f32,
        cy: f32,
        rx: f32,
        ry: f32,
        rotation_deg: f32,
        blur_px: f32,
        feather: f32,
        light_bokeh: f32,
    ) -> Self {
        Self {
            cx,
            cy,
            rx,
            ry,
            rotation_deg,
            blur_px,
            feather,
            light_bokeh,
            _pad0: 0,
            _pad1: 0,
            _pad2: 0,
            _abi_pad: 0,
        }
    }
}

/// IRIS BLUR — sharp inside an ellipse, blurred outside it, with a smooth
/// transition from the sharp core (`feather` of the ellipse, normalised
/// distance) to the rim, where the full `blur_px` is reached.
///
/// IDENTITY: `blur_px` 0 returns the input exactly.
pub static BLUR_IRIS: KernelDef = KernelDef {
    id: "blur.iris",
    class: KernelClass::Resample { support: 1.0 },
    inputs: 1,
    params: ParamsLayout {
        size: ::core::mem::size_of::<BlurIrisParams>(),
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
                name: "rx",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "ry",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "rotation_deg",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "blur_px",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "feather",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "light_bokeh",
                wgsl_ty: "f32",
            },
        ],
    },
    wgsl: BLUR_IRIS_WGSL,
    module: true,
    mip_exact: false,
    gpu_tolerance: Tolerance::ChannelEpsF16(8),
};

const BLUR_IRIS_WGSL: &str = blur_module!(
    "blur.iris",
    "    cx: f32,
    cy: f32,
    rx: f32,
    ry: f32,
    rotation_deg: f32,
    blur_px: f32,
    feather: f32,
    light_bokeh: f32,
    _pad0: u32,
    _pad1: u32,
    _pad2: u32,
    _abi_pad: u32,
",
    "@group(0) @binding(0) var in0 : texture_2d<f32>;
@group(1) @binding(0) var<uniform> params : Params;
@group(2) @binding(0) var mask : texture_2d<f32>;
@group(3) @binding(0) var outp : texture_storage_2d<rgba16float, write>;

const TAU : f32 = 6.2831853;
const GOLDEN_TURN : f32 = 0.381966011;
const DISC_MAX : i32 = 192;
const BLUR_MAX : f32 = 128.0;

fn tap(c: vec2<i32>) -> vec4<f32> {
    let din = vec2<i32>(textureDimensions(in0));
    return textureLoad(in0, clamp(c, vec2<i32>(0), din - vec2<i32>(1)), 0);
}

// Bilinear at a continuous position, pixel centres at +0.5: the pixel's
// own centre lands on t = 0 and returns that pixel.
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

fn bokeh_w(s: vec4<f32>, bokeh: f32) -> f32 {
    return 1.0 + clamp(bokeh, 0.0, 1.0) * 16.0 * max(luma(s.rgb) - 0.7, 0.0);
}

// The Vogel disc of radius r about p.
fn disc(p: vec2<f32>, r: f32, bokeh: f32) -> vec4<f32> {
    let n = clamp(i32(ceil(3.0 * r - 0.001)), 8, DISC_MAX);
    var acc = vec4<f32>(0.0);
    var wsum = 0.0;
    for (var k : i32 = 0; k < DISC_MAX; k = k + 1) {
        if (k >= n) { break; }
        let fk = f32(k);
        let rho = r * sqrt((fk + 0.5) / f32(n));
        let th = fract(fk * GOLDEN_TURN) * TAU;
        let s = bilin(p + rho * vec2<f32>(cos(th), sin(th)));
        let w = bokeh_w(s, bokeh);
        acc = acc + s * w;
        wsum = wsum + w;
    }
    return acc / wsum;
}

fn smooth01(t: f32) -> f32 {
    let u = clamp(t, 0.0, 1.0);
    return u * u * (3.0 - 2.0 * u);
}

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
    let d = textureDimensions(outp);
    if (gid.x >= d.x || gid.y >= d.y) { return; }
    let xy = vec2<i32>(i32(gid.x), i32(gid.y));
    let a = tap(xy);
    let p = vec2<f32>(xy) + vec2<f32>(0.5);
    let rad = radians(params.rotation_deg);
    let cs = cos(rad);
    let sn = sin(rad);
    let dv = p - vec2<f32>(params.cx, params.cy);
    let u = (cs * dv.x + sn * dv.y) / max(params.rx, 1.0);
    let v = (cs * dv.y - sn * dv.x) / max(params.ry, 1.0);
    let e = sqrt(u * u + v * v);
    let f = clamp(params.feather, 0.0, 1.0);
    var t = 0.0;
    if (f < 1.0) {
        t = smooth01((e - f) / (1.0 - f));
    } else if (e >= 1.0) {
        t = 1.0;
    }
    let r = clamp(params.blur_px, 0.0, BLUR_MAX) * t;
    var result = a;
    if (r >= 0.5) { result = disc(p, r, params.light_bokeh); }
    let m = textureLoad(mask, xy, 0).r;
    textureStore(outp, xy, mix(a, result, vec4<f32>(m)));
}
"
);

// ────────────────────────────── tilt-shift ──────────────────────────

/// `blur.tilt_shift` params: the band's centre line (through `cx, cy` at
/// `angle_deg`), its sharp half-height, the transition, and the blur.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, ::bytemuck::Pod, ::bytemuck::Zeroable)]
pub struct BlurTiltShiftParams {
    pub cx: f32,
    pub cy: f32,
    pub angle_deg: f32,
    pub sharp_px: f32,
    pub feather_px: f32,
    pub blur_px: f32,
    pub symmetric: u32,
    pub light_bokeh: f32,
    pub _pad0: u32,
    pub _pad1: u32,
    pub _pad2: u32,
    pub _abi_pad: u32,
}
pod_params!(BlurTiltShiftParams);

impl BlurTiltShiftParams {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        cx: f32,
        cy: f32,
        angle_deg: f32,
        sharp_px: f32,
        feather_px: f32,
        blur_px: f32,
        symmetric: bool,
        light_bokeh: f32,
    ) -> Self {
        Self {
            cx,
            cy,
            angle_deg,
            sharp_px,
            feather_px,
            blur_px,
            symmetric: u32::from(symmetric),
            light_bokeh,
            _pad0: 0,
            _pad1: 0,
            _pad2: 0,
            _abi_pad: 0,
        }
    }
}

/// TILT-SHIFT — a sharp band along a line, blurring away from it on both
/// sides (`symmetric`) or only on the side the line's normal points to
/// (the normal is the line direction turned +90°, i.e. "below" at 0°).
///
/// IDENTITY: `blur_px` 0 returns the input exactly.
pub static BLUR_TILT_SHIFT: KernelDef = KernelDef {
    id: "blur.tilt_shift",
    class: KernelClass::Resample { support: 1.0 },
    inputs: 1,
    params: ParamsLayout {
        size: ::core::mem::size_of::<BlurTiltShiftParams>(),
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
                name: "angle_deg",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "sharp_px",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "feather_px",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "blur_px",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "symmetric",
                wgsl_ty: "u32",
            },
            ParamField {
                name: "light_bokeh",
                wgsl_ty: "f32",
            },
        ],
    },
    wgsl: BLUR_TILT_SHIFT_WGSL,
    module: true,
    mip_exact: false,
    gpu_tolerance: Tolerance::ChannelEpsF16(8),
};

const BLUR_TILT_SHIFT_WGSL: &str = blur_module!(
    "blur.tilt_shift",
    "    cx: f32,
    cy: f32,
    angle_deg: f32,
    sharp_px: f32,
    feather_px: f32,
    blur_px: f32,
    symmetric: u32,
    light_bokeh: f32,
    _pad0: u32,
    _pad1: u32,
    _pad2: u32,
    _abi_pad: u32,
",
    "@group(0) @binding(0) var in0 : texture_2d<f32>;
@group(1) @binding(0) var<uniform> params : Params;
@group(2) @binding(0) var mask : texture_2d<f32>;
@group(3) @binding(0) var outp : texture_storage_2d<rgba16float, write>;

const TAU : f32 = 6.2831853;
const GOLDEN_TURN : f32 = 0.381966011;
const DISC_MAX : i32 = 192;
const BLUR_MAX : f32 = 128.0;

fn tap(c: vec2<i32>) -> vec4<f32> {
    let din = vec2<i32>(textureDimensions(in0));
    return textureLoad(in0, clamp(c, vec2<i32>(0), din - vec2<i32>(1)), 0);
}

// Bilinear at a continuous position, pixel centres at +0.5: the pixel's
// own centre lands on t = 0 and returns that pixel.
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

fn bokeh_w(s: vec4<f32>, bokeh: f32) -> f32 {
    return 1.0 + clamp(bokeh, 0.0, 1.0) * 16.0 * max(luma(s.rgb) - 0.7, 0.0);
}

// The Vogel disc of radius r about p.
fn disc(p: vec2<f32>, r: f32, bokeh: f32) -> vec4<f32> {
    let n = clamp(i32(ceil(3.0 * r - 0.001)), 8, DISC_MAX);
    var acc = vec4<f32>(0.0);
    var wsum = 0.0;
    for (var k : i32 = 0; k < DISC_MAX; k = k + 1) {
        if (k >= n) { break; }
        let fk = f32(k);
        let rho = r * sqrt((fk + 0.5) / f32(n));
        let th = fract(fk * GOLDEN_TURN) * TAU;
        let s = bilin(p + rho * vec2<f32>(cos(th), sin(th)));
        let w = bokeh_w(s, bokeh);
        acc = acc + s * w;
        wsum = wsum + w;
    }
    return acc / wsum;
}

fn smooth01(t: f32) -> f32 {
    let u = clamp(t, 0.0, 1.0);
    return u * u * (3.0 - 2.0 * u);
}

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
    let d = textureDimensions(outp);
    if (gid.x >= d.x || gid.y >= d.y) { return; }
    let xy = vec2<i32>(i32(gid.x), i32(gid.y));
    let a = tap(xy);
    let p = vec2<f32>(xy) + vec2<f32>(0.5);
    let rad = radians(params.angle_deg);
    let nrm = vec2<f32>(-sin(rad), cos(rad));
    let dist = dot(p - vec2<f32>(params.cx, params.cy), nrm);
    var t = 0.0;
    if (params.symmetric != 0u || dist >= 0.0) {
        let over = abs(dist) - max(params.sharp_px, 0.0);
        if (params.feather_px > 0.0) {
            t = smooth01(over / params.feather_px);
        } else if (over > 0.0) {
            t = 1.0;
        }
    }
    let r = clamp(params.blur_px, 0.0, BLUR_MAX) * t;
    var result = a;
    if (r >= 0.5) { result = disc(p, r, params.light_bokeh); }
    let m = textureLoad(mask, xy, 0).r;
    textureStore(outp, xy, mix(a, result, vec4<f32>(m)));
}
"
);

// ──────────────────────────────── path ──────────────────────────────

/// `blur.path` params: one polyline of up to eight points, the blur
/// length (`speed_px`), its taper toward the path's end, and whether the
/// blur is centred on the pixel or trails behind it.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, ::bytemuck::Pod, ::bytemuck::Zeroable)]
pub struct BlurPathParams {
    pub count: u32,
    pub speed_px: f32,
    pub taper: f32,
    pub centered: u32,
    pub q0x: f32,
    pub q0y: f32,
    pub q1x: f32,
    pub q1y: f32,
    pub q2x: f32,
    pub q2y: f32,
    pub q3x: f32,
    pub q3y: f32,
    pub q4x: f32,
    pub q4y: f32,
    pub q5x: f32,
    pub q5y: f32,
    pub q6x: f32,
    pub q6y: f32,
    pub q7x: f32,
    pub q7y: f32,
    pub _pad0: u32,
    pub _pad1: u32,
    pub _pad2: u32,
    pub _abi_pad: u32,
}
pod_params!(BlurPathParams);

impl BlurPathParams {
    /// `points` past [`BLUR_MAX_POINTS`] are ignored (the door refuses them).
    pub fn new(points: &[(f32, f32)], speed_px: f32, taper: f32, centered: bool) -> Self {
        let mut p: Self = ::bytemuck::Zeroable::zeroed();
        p.count = points.len().min(BLUR_MAX_POINTS) as u32;
        p.speed_px = speed_px;
        p.taper = taper;
        p.centered = u32::from(centered);
        let slots: &mut [f32] =
            &mut ::bytemuck::cast_slice_mut::<Self, f32>(::core::slice::from_mut(&mut p))
                [4..4 + 2 * BLUR_MAX_POINTS];
        for (i, (x, y)) in points.iter().take(BLUR_MAX_POINTS).enumerate() {
            slots[2 * i] = *x;
            slots[2 * i + 1] = *y;
        }
        p
    }

    /// Point `i` as `(x, y)`.
    pub fn point(&self, i: usize) -> (f32, f32) {
        let f: &[f32] = ::bytemuck::cast_slice(::core::slice::from_ref(self));
        (f[4 + 2 * i], f[5 + 2 * i])
    }
}

/// PATH BLUR — a motion blur whose DIRECTION follows a drawn path: each
/// pixel blurs along the tangent of the path's segments, weighted by
/// inverse squared distance, over `speed_px` (less toward the path's end
/// as `taper` rises). `centered` spreads the blur both ways; otherwise it
/// trails behind the pixel against the path's direction.
///
/// IDENTITY: `speed_px` 0 returns the input exactly.
pub static BLUR_PATH: KernelDef = KernelDef {
    id: "blur.path",
    class: KernelClass::Resample { support: 1.0 },
    inputs: 1,
    params: ParamsLayout {
        size: ::core::mem::size_of::<BlurPathParams>(),
        fields: &[
            ParamField {
                name: "count",
                wgsl_ty: "u32",
            },
            ParamField {
                name: "speed_px",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "taper",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "centered",
                wgsl_ty: "u32",
            },
            ParamField {
                name: "q0x",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "q0y",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "q1x",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "q1y",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "q2x",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "q2y",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "q3x",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "q3y",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "q4x",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "q4y",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "q5x",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "q5y",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "q6x",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "q6y",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "q7x",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "q7y",
                wgsl_ty: "f32",
            },
        ],
    },
    wgsl: BLUR_PATH_WGSL,
    module: true,
    mip_exact: false,
    gpu_tolerance: Tolerance::ChannelEpsF16(8),
};

const BLUR_PATH_WGSL: &str = blur_module!(
    "blur.path",
    "    count: u32,
    speed_px: f32,
    taper: f32,
    centered: u32,
    q0x: f32,
    q0y: f32,
    q1x: f32,
    q1y: f32,
    q2x: f32,
    q2y: f32,
    q3x: f32,
    q3y: f32,
    q4x: f32,
    q4y: f32,
    q5x: f32,
    q5y: f32,
    q6x: f32,
    q6y: f32,
    q7x: f32,
    q7y: f32,
    _pad0: u32,
    _pad1: u32,
    _pad2: u32,
    _abi_pad: u32,
",
    "@group(0) @binding(0) var in0 : texture_2d<f32>;
@group(1) @binding(0) var<uniform> params : Params;
@group(2) @binding(0) var mask : texture_2d<f32>;
@group(3) @binding(0) var outp : texture_storage_2d<rgba16float, write>;

const TAU : f32 = 6.2831853;
const GOLDEN_TURN : f32 = 0.381966011;
const DISC_MAX : i32 = 192;
const BLUR_MAX : f32 = 128.0;

fn tap(c: vec2<i32>) -> vec4<f32> {
    let din = vec2<i32>(textureDimensions(in0));
    return textureLoad(in0, clamp(c, vec2<i32>(0), din - vec2<i32>(1)), 0);
}

// Bilinear at a continuous position, pixel centres at +0.5: the pixel's
// own centre lands on t = 0 and returns that pixel.
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

fn bokeh_w(s: vec4<f32>, bokeh: f32) -> f32 {
    return 1.0 + clamp(bokeh, 0.0, 1.0) * 16.0 * max(luma(s.rgb) - 0.7, 0.0);
}

// The Vogel disc of radius r about p.
fn disc(p: vec2<f32>, r: f32, bokeh: f32) -> vec4<f32> {
    let n = clamp(i32(ceil(3.0 * r - 0.001)), 8, DISC_MAX);
    var acc = vec4<f32>(0.0);
    var wsum = 0.0;
    for (var k : i32 = 0; k < DISC_MAX; k = k + 1) {
        if (k >= n) { break; }
        let fk = f32(k);
        let rho = r * sqrt((fk + 0.5) / f32(n));
        let th = fract(fk * GOLDEN_TURN) * TAU;
        let s = bilin(p + rho * vec2<f32>(cos(th), sin(th)));
        let w = bokeh_w(s, bokeh);
        acc = acc + s * w;
        wsum = wsum + w;
    }
    return acc / wsum;
}

fn smooth01(t: f32) -> f32 {
    let u = clamp(t, 0.0, 1.0);
    return u * u * (3.0 - 2.0 * u);
}

const LINE_MAX : i32 = 64;

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
    let d = textureDimensions(outp);
    if (gid.x >= d.x || gid.y >= d.y) { return; }
    let xy = vec2<i32>(i32(gid.x), i32(gid.y));
    let a = tap(xy);
    let p = vec2<f32>(xy) + vec2<f32>(0.5);
    var pts = array<vec2<f32>, 8>(
        vec2<f32>(params.q0x, params.q0y),
        vec2<f32>(params.q1x, params.q1y),
        vec2<f32>(params.q2x, params.q2y),
        vec2<f32>(params.q3x, params.q3y),
        vec2<f32>(params.q4x, params.q4y),
        vec2<f32>(params.q5x, params.q5y),
        vec2<f32>(params.q6x, params.q6y),
        vec2<f32>(params.q7x, params.q7y));
    let cnt = min(params.count, 8u);
    var tang = vec2<f32>(0.0);
    var ws = 0.0;
    var sacc = 0.0;
    var cum = 0.0;
    for (var i : u32 = 0u; i < 7u; i = i + 1u) {
        if (i + 1u >= cnt) { break; }
        let a0 = pts[i];
        let seg = pts[i + 1u] - a0;
        let len = length(seg);
        if (len < 0.0001) { continue; }
        let t = clamp(dot(p - a0, seg) / (len * len), 0.0, 1.0);
        let dq = p - (a0 + seg * t);
        let w = 1.0 / (dot(dq, dq) + 1.0);
        tang = tang + seg * (w / len);
        sacc = sacc + w * (cum + t * len);
        ws = ws + w;
        cum = cum + len;
    }
    var result = a;
    let tl = length(tang);
    if (ws > 0.0 && tl > 0.000001) {
        let dir = tang / tl;
        let s = (sacc / ws) / max(cum, 0.0001);
        let l = clamp(params.speed_px, 0.0, BLUR_MAX) * (1.0 - clamp(params.taper, 0.0, 1.0) * s);
        if (l >= 0.5) {
            let n = clamp(i32(ceil(l)), 1, LINE_MAX);
            var acc = vec4<f32>(0.0);
            for (var j : i32 = 0; j <= LINE_MAX; j = j + 1) {
                if (j > n) { break; }
                let f = f32(j) / f32(n);
                var off = -f * l;
                if (params.centered != 0u) { off = (f - 0.5) * l; }
                acc = acc + bilin(p + dir * off);
            }
            result = acc / f32(n + 1);
        }
    }
    let m = textureLoad(mask, xy, 0).r;
    textureStore(outp, xy, mix(a, result, vec4<f32>(m)));
}
"
);

// ──────────────────────────────── spin ──────────────────────────────

/// `blur.spin` params: the ellipse, the blur arc, and the rim falloff.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, ::bytemuck::Pod, ::bytemuck::Zeroable)]
pub struct BlurSpinParams {
    pub cx: f32,
    pub cy: f32,
    pub rx: f32,
    pub ry: f32,
    pub rotation_deg: f32,
    pub angle_deg: f32,
    pub feather: f32,
    pub _abi_pad: u32,
}
pod_params!(BlurSpinParams);

impl BlurSpinParams {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        cx: f32,
        cy: f32,
        rx: f32,
        ry: f32,
        rotation_deg: f32,
        angle_deg: f32,
        feather: f32,
    ) -> Self {
        Self {
            cx,
            cy,
            rx,
            ry,
            rotation_deg,
            angle_deg,
            feather,
            _abi_pad: 0,
        }
    }
}

/// SPIN BLUR — a rotational blur inside an ellipse: each pixel averages
/// along the arc about the centre that `angle_deg` spans (centred on the
/// pixel), fading to none across the rim band `feather`; outside the
/// ellipse the image is untouched.
///
/// IDENTITY: `angle_deg` 0 returns the input exactly.
pub static BLUR_SPIN: KernelDef = KernelDef {
    id: "blur.spin",
    class: KernelClass::Resample { support: 1.0 },
    inputs: 1,
    params: ParamsLayout {
        size: ::core::mem::size_of::<BlurSpinParams>(),
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
                name: "rx",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "ry",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "rotation_deg",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "angle_deg",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "feather",
                wgsl_ty: "f32",
            },
        ],
    },
    wgsl: BLUR_SPIN_WGSL,
    module: true,
    mip_exact: false,
    gpu_tolerance: Tolerance::ChannelEpsF16(8),
};

const BLUR_SPIN_WGSL: &str = blur_module!(
    "blur.spin",
    "    cx: f32,
    cy: f32,
    rx: f32,
    ry: f32,
    rotation_deg: f32,
    angle_deg: f32,
    feather: f32,
    _abi_pad: u32,
",
    "@group(0) @binding(0) var in0 : texture_2d<f32>;
@group(1) @binding(0) var<uniform> params : Params;
@group(2) @binding(0) var mask : texture_2d<f32>;
@group(3) @binding(0) var outp : texture_storage_2d<rgba16float, write>;

const TAU : f32 = 6.2831853;
const GOLDEN_TURN : f32 = 0.381966011;
const DISC_MAX : i32 = 192;
const BLUR_MAX : f32 = 128.0;

fn tap(c: vec2<i32>) -> vec4<f32> {
    let din = vec2<i32>(textureDimensions(in0));
    return textureLoad(in0, clamp(c, vec2<i32>(0), din - vec2<i32>(1)), 0);
}

// Bilinear at a continuous position, pixel centres at +0.5: the pixel's
// own centre lands on t = 0 and returns that pixel.
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

fn bokeh_w(s: vec4<f32>, bokeh: f32) -> f32 {
    return 1.0 + clamp(bokeh, 0.0, 1.0) * 16.0 * max(luma(s.rgb) - 0.7, 0.0);
}

// The Vogel disc of radius r about p.
fn disc(p: vec2<f32>, r: f32, bokeh: f32) -> vec4<f32> {
    let n = clamp(i32(ceil(3.0 * r - 0.001)), 8, DISC_MAX);
    var acc = vec4<f32>(0.0);
    var wsum = 0.0;
    for (var k : i32 = 0; k < DISC_MAX; k = k + 1) {
        if (k >= n) { break; }
        let fk = f32(k);
        let rho = r * sqrt((fk + 0.5) / f32(n));
        let th = fract(fk * GOLDEN_TURN) * TAU;
        let s = bilin(p + rho * vec2<f32>(cos(th), sin(th)));
        let w = bokeh_w(s, bokeh);
        acc = acc + s * w;
        wsum = wsum + w;
    }
    return acc / wsum;
}

fn smooth01(t: f32) -> f32 {
    let u = clamp(t, 0.0, 1.0);
    return u * u * (3.0 - 2.0 * u);
}

const ARC_MAX : i32 = 64;

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
    let d = textureDimensions(outp);
    if (gid.x >= d.x || gid.y >= d.y) { return; }
    let xy = vec2<i32>(i32(gid.x), i32(gid.y));
    let a = tap(xy);
    let p = vec2<f32>(xy) + vec2<f32>(0.5);
    let c = vec2<f32>(params.cx, params.cy);
    let rad = radians(params.rotation_deg);
    let cs = cos(rad);
    let sn = sin(rad);
    let dv = p - c;
    let u = (cs * dv.x + sn * dv.y) / max(params.rx, 1.0);
    let v = (cs * dv.y - sn * dv.x) / max(params.ry, 1.0);
    let e = sqrt(u * u + v * v);
    var result = a;
    if (e < 1.0) {
        let f = clamp(params.feather, 0.0, 1.0);
        var k = 1.0;
        if (f > 0.0) { k = smooth01((1.0 - e) / f); }
        let span = radians(clamp(params.angle_deg, 0.0, 360.0)) * k;
        let arc = span * length(dv);
        if (arc >= 0.5) {
            let n = clamp(i32(ceil(arc)), 1, ARC_MAX);
            var acc = vec4<f32>(0.0);
            for (var j : i32 = 0; j <= ARC_MAX; j = j + 1) {
                if (j > n) { break; }
                let th = (f32(j) / f32(n) - 0.5) * span;
                let ct = cos(th);
                let st = sin(th);
                let q = c + vec2<f32>(ct * dv.x - st * dv.y, st * dv.x + ct * dv.y);
                acc = acc + bilin(q);
            }
            result = acc / f32(n + 1);
        }
    }
    let m = textureLoad(mask, xy, 0).r;
    textureStore(outp, xy, mix(a, result, vec4<f32>(m)));
}
"
);

/// Every kernel of this family (the conformance gate joins it to the registry).
pub static FAMILY: &[&KernelDef] = &[
    &BLUR_FIELD,
    &BLUR_IRIS,
    &BLUR_TILT_SHIFT,
    &BLUR_PATH,
    &BLUR_SPIN,
];
