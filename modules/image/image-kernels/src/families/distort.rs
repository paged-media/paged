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

//! Distort family (WP5.2): Displace, Polar Coordinates, Ripple, Shear,
//! ZigZag.
//!
//! Every kernel here is a BACKWARD map: for each output texel it computes
//! the source position and samples the input there bilinearly. They are
//! `Point`-class handwritten modules — the one-shot doors and the layer
//! fold hand a point module the WHOLE image as `in0` (at the output
//! dims), so the source position may land anywhere on the canvas, as in
//! `geom.warp_backward`. Each module applies the selection mask itself.
//!
//! Two conventions hold throughout:
//!
//! * **Pixel-centre coordinates.** Texel `i` covers `[i, i + 1)` and its
//!   centre is `i + 0.5`; the sampler subtracts `0.5` before `floor`, so
//!   a source position that IS a texel centre returns that texel exactly.
//!   That is what makes every neutral setting (amount 0, an all-zero
//!   shear curve, a grey displacement map) the exact identity.
//! * **Edge policy per filter.** Positions outside the canvas either WRAP
//!   (Photoshop's "Wrap Around") or REPEAT the edge pixel ("Repeat Edge
//!   Pixels"); the polar transform wraps horizontally only, because its x
//!   axis is an angle.
//!
//! Provenance: standard geometric image transforms — inverse mapping with
//! bilinear reconstruction (Wolberg, *Digital Image Warping*, 1990), the
//! polar/rectangular coordinate change, sinusoidal displacement, the
//! Catmull–Rom spline (Catmull & Rom, 1974) for the shear curve, and
//! displacement mapping from a height/offset image. Written from those
//! sources and from what each Photoshop filter visibly does (its public
//! documentation); no reference implementation was read.

use crate::{KernelClass, KernelDef, ParamField, ParamsLayout, Tolerance};

/// The shared sampler, repeated verbatim in each module (WGSL has no
/// include on this lane). `fetch` applies the edge policy per axis.
macro_rules! sampler_wgsl {
    () => {
        "
fn fetch(c: vec2<i32>, wrap_x: bool, wrap_y: bool) -> vec4<f32> {
    let d = vec2<i32>(textureDimensions(in0));
    var q = c;
    if (wrap_x) { q.x = ((q.x % d.x) + d.x) % d.x; } else { q.x = clamp(q.x, 0, d.x - 1); }
    if (wrap_y) { q.y = ((q.y % d.y) + d.y) % d.y; } else { q.y = clamp(q.y, 0, d.y - 1); }
    return textureLoad(in0, q, 0);
}

fn sample(s: vec2<f32>, wrap_x: bool, wrap_y: bool) -> vec4<f32> {
    let p = s - vec2<f32>(0.5, 0.5);
    let f0 = floor(p);
    let f = p - f0;
    let i = vec2<i32>(i32(f0.x), i32(f0.y));
    let p00 = fetch(i, wrap_x, wrap_y);
    let p10 = fetch(i + vec2<i32>(1, 0), wrap_x, wrap_y);
    let p01 = fetch(i + vec2<i32>(0, 1), wrap_x, wrap_y);
    let p11 = fetch(i + vec2<i32>(1, 1), wrap_x, wrap_y);
    return mix(mix(p00, p10, vec4<f32>(f.x)), mix(p01, p11, vec4<f32>(f.x)), vec4<f32>(f.y));
}
"
    };
}

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

// ───────────────────────────── displace ─────────────────────────────

/// Edge policy shared by Displace and Shear.
pub const EDGE_WRAP: u32 = 0;
pub const EDGE_REPEAT: u32 = 1;

/// `distort.displace` params. The map arrives as `in1`, zero-padded at the
/// top-left to the output size; `map_w`/`map_h` are its real extent and it
/// TILES over the canvas (a stretched map is resampled by the door first).
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, ::bytemuck::Pod, ::bytemuck::Zeroable)]
pub struct DistortDisplaceParams {
    pub map_w: u32,
    pub map_h: u32,
    /// Horizontal shift at full deflection (map value 0 or 1), px.
    pub scale_x: f32,
    /// Vertical shift at full deflection, px.
    pub scale_y: f32,
    /// [`EDGE_WRAP`] or [`EDGE_REPEAT`].
    pub edge: u32,
    pub _pad0: u32,
    pub _pad1: u32,
    pub _abi_pad: u32,
}

impl DistortDisplaceParams {
    pub fn new(map_w: u32, map_h: u32, scale_x: f32, scale_y: f32, edge: u32) -> Self {
        Self {
            map_w,
            map_h,
            scale_x,
            scale_y,
            edge,
            _pad0: 0,
            _pad1: 0,
            _abi_pad: 0,
        }
    }

    pub fn as_bytes(&self) -> &[u8] {
        ::bytemuck::bytes_of(self)
    }
}

/// Displace: shift each texel by the displacement map under it. A map
/// value of 0.5 is no shift; 0 and 1 shift by `∓scale`. Red drives x,
/// green drives y (a grey map has both equal). The source position is
/// `centre + offset`, so a bright map pulls the content from the right
/// and below. IDENTITY: a 0.5-grey map, or both scales 0.
pub static DISTORT_DISPLACE: KernelDef = KernelDef {
    id: "distort.displace",
    class: KernelClass::Point,
    inputs: 2,
    params: ParamsLayout {
        size: ::core::mem::size_of::<DistortDisplaceParams>(),
        fields: &[
            ParamField {
                name: "map_w",
                wgsl_ty: "u32",
            },
            ParamField {
                name: "map_h",
                wgsl_ty: "u32",
            },
            ParamField {
                name: "scale_x",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "scale_y",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "edge",
                wgsl_ty: "u32",
            },
        ],
    },
    wgsl: DISTORT_DISPLACE_WGSL,
    module: true,
    mip_exact: false,
    gpu_tolerance: Tolerance::ChannelEpsF16(4),
};

const DISTORT_DISPLACE_WGSL: &str = concat!(
    "// paged.image kernel `distort.displace` — handwritten under ABI v1.1.
// AGPL-3.0-only OR LicenseRef-PMEL; (c) And The Next GmbH.

struct Params {
    map_w: u32,
    map_h: u32,
    scale_x: f32,
    scale_y: f32,
    edge: u32,
    _pad0: u32,
    _pad1: u32,
    _abi_pad: u32,
}

@group(0) @binding(0) var in0 : texture_2d<f32>;
@group(0) @binding(1) var in1 : texture_2d<f32>;
@group(1) @binding(0) var<uniform> params : Params;
@group(2) @binding(0) var mask : texture_2d<f32>;
@group(3) @binding(0) var outp : texture_storage_2d<rgba16float, write>;
",
    sampler_wgsl!(),
    "
@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
    let d = textureDimensions(outp);
    if (gid.x >= d.x || gid.y >= d.y) { return; }
    let xy = vec2<i32>(i32(gid.x), i32(gid.y));
    let a = textureLoad(in0, xy, 0);
    let mw = i32(max(params.map_w, 1u));
    let mh = i32(max(params.map_h, 1u));
    var mv = textureLoad(in1, vec2<i32>(xy.x % mw, xy.y % mh), 0);
    // The door associates alpha when either input has any; read the
    // map's own values back, and treat a transparent map texel as grey.
    var mx = 0.5;
    var my = 0.5;
    if (mv.a > 0.0) {
        mx = mv.r / mv.a;
        my = mv.g / mv.a;
    }
    let off = vec2<f32>((mx - 0.5) * 2.0 * params.scale_x, (my - 0.5) * 2.0 * params.scale_y);
    let s = vec2<f32>(f32(xy.x) + 0.5, f32(xy.y) + 0.5) + off;
    let wrap = params.edge == 0u;
    let result = sample(s, wrap, wrap);
    let m = textureLoad(mask, xy, 0).r;
    textureStore(outp, xy, mix(a, result, vec4<f32>(m)));
}
"
);

// ────────────────────────────── polar ──────────────────────────────

/// `distort.polar` modes.
pub const POLAR_TO_POLAR: u32 = 0;
pub const POLAR_TO_RECT: u32 = 1;

/// `distort.polar` params: the direction of the transform.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, ::bytemuck::Pod, ::bytemuck::Zeroable)]
pub struct DistortPolarParams {
    /// [`POLAR_TO_POLAR`] (rectangular → polar) or [`POLAR_TO_RECT`].
    pub mode: u32,
    pub _pad0: u32,
    pub _pad1: u32,
    pub _abi_pad: u32,
}

impl DistortPolarParams {
    pub fn new(to_polar: bool) -> Self {
        Self {
            mode: if to_polar {
                POLAR_TO_POLAR
            } else {
                POLAR_TO_RECT
            },
            _pad0: 0,
            _pad1: 0,
            _abi_pad: 0,
        }
    }

    pub fn as_bytes(&self) -> &[u8] {
        ::bytemuck::bytes_of(self)
    }
}

/// Polar Coordinates. RECTANGULAR → POLAR bends the image round the
/// canvas centre: the top edge collapses to the centre, the bottom edge
/// becomes the rim of the ellipse fitted to the canvas, and x runs
/// counter-clockwise from 12 o'clock (Photoshop's direction, per the
/// recorded probe) (so the left and right edges meet there and
/// x wraps). POLAR → RECTANGULAR is the exact inverse map. Outside the
/// ellipse the rectangular image's bottom row repeats.
pub static DISTORT_POLAR: KernelDef = KernelDef {
    id: "distort.polar",
    class: KernelClass::Point,
    inputs: 1,
    params: ParamsLayout {
        size: ::core::mem::size_of::<DistortPolarParams>(),
        fields: &[ParamField {
            name: "mode",
            wgsl_ty: "u32",
        }],
    },
    wgsl: DISTORT_POLAR_WGSL,
    module: true,
    mip_exact: false,
    gpu_tolerance: Tolerance::ChannelEpsF16(8),
};

const DISTORT_POLAR_WGSL: &str = concat!(
    "// paged.image kernel `distort.polar` — handwritten under ABI v1.1.
// AGPL-3.0-only OR LicenseRef-PMEL; (c) And The Next GmbH.

struct Params {
    mode: u32,
    _pad0: u32,
    _pad1: u32,
    _abi_pad: u32,
}
",
    bindings_wgsl!(),
    sampler_wgsl!(),
    "
const TAU : f32 = 6.283185307179586;

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
    let d = textureDimensions(outp);
    if (gid.x >= d.x || gid.y >= d.y) { return; }
    let xy = vec2<i32>(i32(gid.x), i32(gid.y));
    let a = textureLoad(in0, xy, 0);
    let w = f32(d.x);
    let h = f32(d.y);
    let hw = w * 0.5;
    let hh = h * 0.5;
    let px = f32(xy.x) + 0.5;
    let py = f32(xy.y) + 0.5;
    var s = vec2<f32>(px, py);
    if (params.mode == 0u) {
        let u = (px - hw) / hw;
        let v = (py - hh) / hh;
        let r = sqrt(u * u + v * v);
        var th = atan2(u, -v);
        if (th < 0.0) { th = th + TAU; }
        s = vec2<f32>((1.0 - th / TAU) * w, r * h);
    } else {
        let th = (1.0 - px / w) * TAU;
        let r = py / h;
        s = vec2<f32>(hw + r * sin(th) * hw, hh - r * cos(th) * hh);
    }
    let result = sample(s, params.mode == 0u, false);
    let m = textureLoad(mask, xy, 0).r;
    textureStore(outp, xy, mix(a, result, vec4<f32>(m)));
}
"
);

// ────────────────────────────── ripple ─────────────────────────────

/// The ripple wavelength per size (small, medium, large), px.
pub const RIPPLE_WAVELENGTH: [f32; 3] = [8.0, 16.0, 32.0];

/// `distort.ripple` params.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, ::bytemuck::Pod, ::bytemuck::Zeroable)]
pub struct DistortRippleParams {
    /// Photoshop's amount, −999..999.
    pub amount: f32,
    /// The wavelength, px ([`RIPPLE_WAVELENGTH`] by size).
    pub wavelength: f32,
    pub _pad0: u32,
    pub _abi_pad: u32,
}

impl DistortRippleParams {
    /// `size` 0 small, 1 medium, 2 large (clamped into the table).
    pub fn new(amount: f32, size: u32) -> Self {
        Self {
            amount,
            wavelength: RIPPLE_WAVELENGTH[(size as usize).min(2)],
            _pad0: 0,
            _abi_pad: 0,
        }
    }

    pub fn as_bytes(&self) -> &[u8] {
        ::bytemuck::bytes_of(self)
    }
}

/// Ripple: each row shifts sideways and each column up and down by a sum
/// of two sinusoids (the second at 1.7× the wavelength, so the waves do
/// not read as a regular grid). The amplitude is `amount / 100 ·
/// wavelength / 4`. Edges repeat. IDENTITY: amount 0.
pub static DISTORT_RIPPLE: KernelDef = KernelDef {
    id: "distort.ripple",
    class: KernelClass::Point,
    inputs: 1,
    params: ParamsLayout {
        size: ::core::mem::size_of::<DistortRippleParams>(),
        fields: &[
            ParamField {
                name: "amount",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "wavelength",
                wgsl_ty: "f32",
            },
        ],
    },
    wgsl: DISTORT_RIPPLE_WGSL,
    module: true,
    mip_exact: false,
    gpu_tolerance: Tolerance::ChannelEpsF16(8),
};

const DISTORT_RIPPLE_WGSL: &str = concat!(
    "// paged.image kernel `distort.ripple` — handwritten under ABI v1.1.
// AGPL-3.0-only OR LicenseRef-PMEL; (c) And The Next GmbH.

struct Params {
    amount: f32,
    wavelength: f32,
    _pad0: u32,
    _abi_pad: u32,
}
",
    bindings_wgsl!(),
    sampler_wgsl!(),
    "
const TAU : f32 = 6.283185307179586;

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
    let d = textureDimensions(outp);
    if (gid.x >= d.x || gid.y >= d.y) { return; }
    let xy = vec2<i32>(i32(gid.x), i32(gid.y));
    let a = textureLoad(in0, xy, 0);
    let l = max(params.wavelength, 1.0);
    let amp = params.amount * 0.01 * l * 0.25;
    let px = f32(xy.x) + 0.5;
    let py = f32(xy.y) + 0.5;
    let dx = amp * (0.75 * sin(TAU * py / l) + 0.25 * sin(TAU * py / (1.7 * l) + 1.3));
    let dy = amp * (0.75 * sin(TAU * px / l) + 0.25 * sin(TAU * px / (1.7 * l) + 2.1));
    let result = sample(vec2<f32>(px + dx, py + dy), false, false);
    let m = textureLoad(mask, xy, 0).r;
    textureStore(outp, xy, mix(a, result, vec4<f32>(m)));
}
"
);

// ────────────────────────────── shear ──────────────────────────────

/// Control points of the shear curve.
pub const SHEAR_POINTS: usize = 16;

/// `distort.shear` params: the curve's horizontal offsets, px, top to
/// bottom, at 16 evenly spaced heights.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, ::bytemuck::Pod, ::bytemuck::Zeroable)]
pub struct DistortShearParams {
    pub off: [[f32; 4]; 4],
    /// [`EDGE_WRAP`] or [`EDGE_REPEAT`].
    pub edge: u32,
    pub _pad0: u32,
    pub _pad1: u32,
    pub _abi_pad: u32,
}

impl DistortShearParams {
    pub fn new(offsets: [f32; SHEAR_POINTS], wrap: bool) -> Self {
        let mut off = [[0.0f32; 4]; 4];
        for (i, v) in offsets.iter().enumerate() {
            off[i / 4][i % 4] = *v;
        }
        Self {
            off,
            edge: if wrap { EDGE_WRAP } else { EDGE_REPEAT },
            _pad0: 0,
            _pad1: 0,
            _abi_pad: 0,
        }
    }

    /// Offset `i` (clamped into the curve).
    pub fn point(&self, i: i32) -> f32 {
        let i = i.clamp(0, SHEAR_POINTS as i32 - 1) as usize;
        self.off[i / 4][i % 4]
    }

    pub fn as_bytes(&self) -> &[u8] {
        ::bytemuck::bytes_of(self)
    }
}

/// Shear: each row moves sideways by the curve's offset at its height —
/// a Catmull–Rom spline through 16 control points spanning the canvas
/// top to bottom (Photoshop's Shear draws the same curve as a line you
/// bend). A positive offset moves the row right. Edges wrap or repeat.
/// IDENTITY: an all-zero curve.
pub static DISTORT_SHEAR: KernelDef = KernelDef {
    id: "distort.shear",
    class: KernelClass::Point,
    inputs: 1,
    params: ParamsLayout {
        size: ::core::mem::size_of::<DistortShearParams>(),
        fields: &[
            ParamField {
                name: "off",
                wgsl_ty: "array<vec4<f32>, 4>",
            },
            ParamField {
                name: "edge",
                wgsl_ty: "u32",
            },
        ],
    },
    wgsl: DISTORT_SHEAR_WGSL,
    module: true,
    mip_exact: false,
    gpu_tolerance: Tolerance::ChannelEpsF16(4),
};

const DISTORT_SHEAR_WGSL: &str = concat!(
    "// paged.image kernel `distort.shear` — handwritten under ABI v1.1.
// AGPL-3.0-only OR LicenseRef-PMEL; (c) And The Next GmbH.

struct Params {
    off: array<vec4<f32>, 4>,
    edge: u32,
    _pad0: u32,
    _pad1: u32,
    _abi_pad: u32,
}
",
    bindings_wgsl!(),
    sampler_wgsl!(),
    "
fn pt(i: i32) -> f32 {
    let k = clamp(i, 0, 15);
    return params.off[k / 4][k % 4];
}

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
    let d = textureDimensions(outp);
    if (gid.x >= d.x || gid.y >= d.y) { return; }
    let xy = vec2<i32>(i32(gid.x), i32(gid.y));
    let a = textureLoad(in0, xy, 0);
    let py = f32(xy.y) + 0.5;
    let t = py / f32(d.y) * 15.0;
    let i0 = floor(t);
    let f = t - i0;
    let i = i32(i0);
    let p0 = pt(i - 1);
    let p1 = pt(i);
    let p2 = pt(i + 1);
    let p3 = pt(i + 2);
    let f2 = f * f;
    let f3 = f2 * f;
    let off = 0.5 * (2.0 * p1 + (p2 - p0) * f + (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * f2
        + (3.0 * p1 - p0 - 3.0 * p2 + p3) * f3);
    let wrap = params.edge == 0u;
    let result = sample(vec2<f32>(f32(xy.x) + 0.5 - off, py), wrap, false);
    let m = textureLoad(mask, xy, 0).r;
    textureStore(outp, xy, mix(a, result, vec4<f32>(m)));
}
"
);

// ───────────────────────────── zigzag ──────────────────────────────

/// ZigZag styles.
pub const ZIGZAG_AROUND_CENTER: u32 = 0;
pub const ZIGZAG_OUT_FROM_CENTER: u32 = 1;
pub const ZIGZAG_POND_RIPPLES: u32 = 2;

/// `distort.zigzag` params.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, ::bytemuck::Pod, ::bytemuck::Zeroable)]
pub struct DistortZigzagParams {
    /// −100..100.
    pub amount: f32,
    /// Ridges across the radius, 0..20.
    pub ridges: f32,
    /// [`ZIGZAG_AROUND_CENTER`], [`ZIGZAG_OUT_FROM_CENTER`] or
    /// [`ZIGZAG_POND_RIPPLES`].
    pub style: u32,
    pub _abi_pad: u32,
}

impl DistortZigzagParams {
    pub fn new(amount: f32, ridges: f32, style: u32) -> Self {
        Self {
            amount,
            ridges,
            style,
            _abi_pad: 0,
        }
    }

    pub fn as_bytes(&self) -> &[u8] {
        ::bytemuck::bytes_of(self)
    }
}

/// ZigZag: concentric ridges inside the circle inscribed in the canvas,
/// fading to nothing at its rim. AROUND CENTRE twists each ring back and
/// forth (an angular displacement), OUT FROM CENTRE pushes rings in and
/// out (radial), POND RIPPLES does both at once. Outside the circle the
/// image is untouched. IDENTITY: amount 0 (guarded, so an adapter's
/// inexact `cos(0)` cannot shift a texel).
pub static DISTORT_ZIGZAG: KernelDef = KernelDef {
    id: "distort.zigzag",
    class: KernelClass::Point,
    inputs: 1,
    params: ParamsLayout {
        size: ::core::mem::size_of::<DistortZigzagParams>(),
        fields: &[
            ParamField {
                name: "amount",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "ridges",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "style",
                wgsl_ty: "u32",
            },
        ],
    },
    wgsl: DISTORT_ZIGZAG_WGSL,
    module: true,
    mip_exact: false,
    gpu_tolerance: Tolerance::ChannelEpsF16(8),
};

const DISTORT_ZIGZAG_WGSL: &str = concat!(
    "// paged.image kernel `distort.zigzag` — handwritten under ABI v1.1.
// AGPL-3.0-only OR LicenseRef-PMEL; (c) And The Next GmbH.

struct Params {
    amount: f32,
    ridges: f32,
    style: u32,
    _abi_pad: u32,
}
",
    bindings_wgsl!(),
    sampler_wgsl!(),
    "
const TAU : f32 = 6.283185307179586;

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
    let d = textureDimensions(outp);
    if (gid.x >= d.x || gid.y >= d.y) { return; }
    let xy = vec2<i32>(i32(gid.x), i32(gid.y));
    let a = textureLoad(in0, xy, 0);
    let c = vec2<f32>(f32(d.x) * 0.5, f32(d.y) * 0.5);
    let big_r = min(c.x, c.y);
    let p = vec2<f32>(f32(xy.x) + 0.5, f32(xy.y) + 0.5);
    let dv = p - c;
    let r = sqrt(dv.x * dv.x + dv.y * dv.y);
    var s = p;
    if (params.amount != 0.0 && r > 0.0 && r < big_r) {
        let t = r / big_r;
        let fall = 1.0 - t;
        let wave = sin(TAU * params.ridges * t) * fall * params.amount * 0.01;
        var ang = 0.0;
        var rr = r;
        if (params.style != 1u) { ang = wave * 0.5; }
        if (params.style != 0u) { rr = r + wave * big_r / (2.0 * max(params.ridges, 1.0)); }
        let k = rr / r;
        let cs = cos(ang);
        let sn = sin(ang);
        let q = vec2<f32>(cs * dv.x - sn * dv.y, sn * dv.x + cs * dv.y) * k;
        s = c + q;
    }
    let result = sample(s, false, false);
    let m = textureLoad(mask, xy, 0).r;
    textureStore(outp, xy, mix(a, result, vec4<f32>(m)));
}
"
);

/// Every kernel of this family (the conformance gate joins it to the registry).
pub static FAMILY: &[&KernelDef] = &[
    &DISTORT_DISPLACE,
    &DISTORT_POLAR,
    &DISTORT_RIPPLE,
    &DISTORT_SHEAR,
    &DISTORT_ZIGZAG,
];
