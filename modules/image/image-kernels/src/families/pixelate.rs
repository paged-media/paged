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

//! Pixelate family (WP5.2): **Crystallize**, **Pointillize**,
//! **Mezzotint** and **Color Halftone** — Photoshop's Filter ▸ Pixelate
//! entries beyond `geom.mosaic` (Mosaic) and `gallery.halftone` (the
//! gallery's single-screen halftone).
//!
//! **Facet is not a kernel here.** It clumps similarly coloured pixels
//! into flat patches while keeping the edges between them, which is what
//! the Kuwahara filter does: the glue runs `gallery.kuwahara` at radius 2
//! (full amount) for it, rather than shipping a near-duplicate.
//!
//! All four are handwritten ABI v1.1 `Point` modules over the whole image
//! (`in0` at the output dims, any pixel reachable, clamped), with the
//! gallery's conventions (gallery.rs): `amount` last (`amount = 0` is the
//! identity), positional patterns through `ox`/`oy`, randomness only from
//! the PCG hash of (global coordinate, seed), copied character-identical.
//!
//! Provenance: Voronoi / cellular texturing over a jittered grid (Worley,
//! SIGGRAPH 1996) for Crystallize and Pointillize; ordered and random
//! dither thresholds (Ulichney, *Digital Halftoning*, 1987) for Mezzotint's
//! dot, line and stroke screens; rotated per-channel dot screens with
//! area-proportional dots from print practice for Color Halftone (the
//! default screen angles 108°, 162°, 90°, 45° are Photoshop's documented
//! defaults); the PCG hash (Jarzynski & Olano, JCGT 2020). The behaviour
//! of each filter is taken from Photoshop's user guide. No Adobe code and
//! no reference implementation was read.

use crate::{KernelClass, KernelDef, ParamField, ParamsLayout, Tolerance};

const fn pf(name: &'static str, wgsl_ty: &'static str) -> ParamField {
    ParamField { name, wgsl_ty }
}

macro_rules! params_impl {
    ($t:ident) => {
        impl $t {
            /// The uniform upload / cache-key bytes.
            pub fn as_bytes(&self) -> &[u8] {
                ::bytemuck::bytes_of(self)
            }
        }
    };
}

/// The smallest and largest cell Crystallize and Pointillize take (px).
pub const CELL_MIN: f32 = 3.0;
pub const CELL_MAX: f32 = 300.0;

// ───────────────────────────── crystallize ─────────────────────────

/// `pixelate.crystallize` params: tile origin, hash `seed`, `cell_px`,
/// and the effect blend.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, ::bytemuck::Pod, ::bytemuck::Zeroable)]
pub struct PixelateCrystallizeParams {
    pub ox: i32,
    pub oy: i32,
    pub seed: u32,
    pub cell_px: f32,
    pub amount: f32,
    pub _pad0: u32,
    pub _pad1: u32,
    pub _abi_pad: u32,
}

impl PixelateCrystallizeParams {
    pub fn new(ox: i32, oy: i32, seed: u32, cell_px: f32, amount: f32) -> Self {
        Self {
            ox,
            oy,
            seed,
            cell_px,
            amount,
            _pad0: 0,
            _pad1: 0,
            _abi_pad: 0,
        }
    }
}
params_impl!(PixelateCrystallizeParams);

/// Crystallize: the image as flat polygons — the Voronoi cells of one
/// jittered site per `cell_px` lattice square, each filled with the
/// image's colour AT its site. Nearest site over the 3×3 lattice
/// neighbourhood, ascending scan, strict `<`.
///
/// IDENTITY: `amount = 0.0`.
pub static PIXELATE_CRYSTALLIZE: KernelDef = KernelDef {
    id: "pixelate.crystallize",
    class: KernelClass::Point,
    inputs: 1,
    params: ParamsLayout {
        size: ::core::mem::size_of::<PixelateCrystallizeParams>(),
        fields: &[
            pf("ox", "i32"),
            pf("oy", "i32"),
            pf("seed", "u32"),
            pf("cell_px", "f32"),
            pf("amount", "f32"),
        ],
    },
    wgsl: PIXELATE_CRYSTALLIZE_WGSL,
    module: true,
    mip_exact: false,
    gpu_tolerance: Tolerance::ChannelEpsF16(2),
};

const PIXELATE_CRYSTALLIZE_WGSL: &str = "\
// paged.image kernel `pixelate.crystallize` — handwritten under ABI v1.1.
// AGPL-3.0-only OR LicenseRef-PMEL; (c) And The Next GmbH.

struct Params {
    ox: i32,
    oy: i32,
    seed: u32,
    cell_px: f32,
    amount: f32,
    _pad0: u32,
    _pad1: u32,
    _abi_pad: u32,
}

@group(0) @binding(0) var in0 : texture_2d<f32>;
@group(1) @binding(0) var<uniform> params : Params;
@group(2) @binding(0) var mask : texture_2d<f32>;
@group(3) @binding(0) var outp : texture_storage_2d<rgba16float, write>;

fn pcg(v: u32) -> u32 {
    let state = v * 747796405u + 2891336453u;
    let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
    return (word >> 22u) ^ word;
}

fn hash21(x: i32, y: i32, seed: u32) -> f32 {
    let h = pcg(bitcast<u32>(x) ^ pcg(bitcast<u32>(y) ^ pcg(seed)));
    return f32(h >> 8u) * 5.9604644775390625e-8;
}

fn tap(c: vec2<i32>) -> vec4<f32> {
    let din = vec2<i32>(textureDimensions(in0));
    return textureLoad(in0, clamp(c, vec2<i32>(0), din - vec2<i32>(1)), 0);
}

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
    let d = textureDimensions(outp);
    if (gid.x >= d.x || gid.y >= d.y) { return; }
    let xy = vec2<i32>(i32(gid.x), i32(gid.y));
    let a = tap(xy);
    let s = clamp(params.cell_px, 3.0, 300.0);
    let o = vec2<f32>(f32(params.ox), f32(params.oy));
    let gp = vec2<f32>(xy) + vec2<f32>(0.5) + o;
    let lp = gp / s;
    let li = floor(lp);
    var d1 = 1.0e9;
    var best = lp;
    for (var j : i32 = -1; j <= 1; j = j + 1) {
        for (var i : i32 = -1; i <= 1; i = i + 1) {
            let cellc = li + vec2<f32>(f32(i), f32(j));
            let jx = hash21(i32(cellc.x), i32(cellc.y), params.seed);
            let jy = hash21(i32(cellc.x), i32(cellc.y), params.seed ^ 3037000493u);
            let site = cellc + vec2<f32>(jx, jy);
            let dv = lp - site;
            let dd = dv.x * dv.x + dv.y * dv.y;
            if (dd < d1) {
                d1 = dd;
                best = site;
            }
        }
    }
    let sp = best * s - o;
    let styled = tap(vec2<i32>(i32(floor(sp.x)), i32(floor(sp.y))));
    let result = mix(a, styled, vec4<f32>(clamp(params.amount, 0.0, 1.0)));
    let m = textureLoad(mask, xy, 0).r;
    textureStore(outp, xy, mix(a, result, vec4<f32>(m)));
}
";

// ───────────────────────────── pointillize ─────────────────────────

/// `pixelate.pointillize` params: tile origin, hash `seed`, `cell_px`,
/// the background colour (straight rgb) and the effect blend.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, ::bytemuck::Pod, ::bytemuck::Zeroable)]
pub struct PixelatePointillizeParams {
    pub ox: i32,
    pub oy: i32,
    pub seed: u32,
    pub cell_px: f32,
    pub bg_r: f32,
    pub bg_g: f32,
    pub bg_b: f32,
    pub amount: f32,
    pub _pad0: u32,
    pub _pad1: u32,
    pub _pad2: u32,
    pub _abi_pad: u32,
}

impl PixelatePointillizeParams {
    pub fn new(ox: i32, oy: i32, seed: u32, cell_px: f32, bg: [f32; 3], amount: f32) -> Self {
        Self {
            ox,
            oy,
            seed,
            cell_px,
            bg_r: bg[0],
            bg_g: bg[1],
            bg_b: bg[2],
            amount,
            _pad0: 0,
            _pad1: 0,
            _pad2: 0,
            _abi_pad: 0,
        }
    }
}
params_impl!(PixelatePointillizeParams);

/// Pointillize: one round dot per jittered lattice site, in the image's
/// colour at the site, of a hashed radius between 0.55 and 0.75 cells, on
/// the background colour; dot edges are antialiased over one pixel. Where
/// dots overlap the most-covering one wins (ascending scan, strict `>`).
///
/// IDENTITY: `amount = 0.0`.
pub static PIXELATE_POINTILLIZE: KernelDef = KernelDef {
    id: "pixelate.pointillize",
    class: KernelClass::Point,
    inputs: 1,
    params: ParamsLayout {
        size: ::core::mem::size_of::<PixelatePointillizeParams>(),
        fields: &[
            pf("ox", "i32"),
            pf("oy", "i32"),
            pf("seed", "u32"),
            pf("cell_px", "f32"),
            pf("bg_r", "f32"),
            pf("bg_g", "f32"),
            pf("bg_b", "f32"),
            pf("amount", "f32"),
        ],
    },
    wgsl: PIXELATE_POINTILLIZE_WGSL,
    module: true,
    mip_exact: false,
    gpu_tolerance: Tolerance::ChannelEpsF16(4),
};

const PIXELATE_POINTILLIZE_WGSL: &str = "\
// paged.image kernel `pixelate.pointillize` — handwritten under ABI v1.1.
// AGPL-3.0-only OR LicenseRef-PMEL; (c) And The Next GmbH.

struct Params {
    ox: i32,
    oy: i32,
    seed: u32,
    cell_px: f32,
    bg_r: f32,
    bg_g: f32,
    bg_b: f32,
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

fn pcg(v: u32) -> u32 {
    let state = v * 747796405u + 2891336453u;
    let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
    return (word >> 22u) ^ word;
}

fn hash21(x: i32, y: i32, seed: u32) -> f32 {
    let h = pcg(bitcast<u32>(x) ^ pcg(bitcast<u32>(y) ^ pcg(seed)));
    return f32(h >> 8u) * 5.9604644775390625e-8;
}

fn tap(c: vec2<i32>) -> vec4<f32> {
    let din = vec2<i32>(textureDimensions(in0));
    return textureLoad(in0, clamp(c, vec2<i32>(0), din - vec2<i32>(1)), 0);
}

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
    let d = textureDimensions(outp);
    if (gid.x >= d.x || gid.y >= d.y) { return; }
    let xy = vec2<i32>(i32(gid.x), i32(gid.y));
    let a = tap(xy);
    let s = clamp(params.cell_px, 3.0, 300.0);
    let o = vec2<f32>(f32(params.ox), f32(params.oy));
    let gp = vec2<f32>(xy) + vec2<f32>(0.5) + o;
    let lp = gp / s;
    let li = floor(lp);
    var best_cov = 0.0;
    var best = lp;
    for (var j : i32 = -1; j <= 1; j = j + 1) {
        for (var i : i32 = -1; i <= 1; i = i + 1) {
            let cellc = li + vec2<f32>(f32(i), f32(j));
            let cx = i32(cellc.x);
            let cy = i32(cellc.y);
            let site = cellc + vec2<f32>(
                hash21(cx, cy, params.seed),
                hash21(cx, cy, params.seed ^ 3037000493u));
            let rad = 0.55 + 0.2 * hash21(cx, cy, params.seed ^ 1640531527u);
            let dv = (lp - site) * s;
            let dist = sqrt(dv.x * dv.x + dv.y * dv.y);
            let cov = clamp(rad * s - dist + 0.5, 0.0, 1.0);
            if (cov > best_cov) {
                best_cov = cov;
                best = site;
            }
        }
    }
    let sp = best * s - o;
    let dot_c = tap(vec2<i32>(i32(floor(sp.x)), i32(floor(sp.y))));
    let bg = vec4<f32>(vec3<f32>(params.bg_r, params.bg_g, params.bg_b) * a.a, a.a);
    let styled = mix(bg, dot_c, vec4<f32>(best_cov));
    let result = mix(a, styled, vec4<f32>(clamp(params.amount, 0.0, 1.0)));
    let m = textureLoad(mask, xy, 0).r;
    textureStore(outp, xy, mix(a, result, vec4<f32>(m)));
}
";

// ────────────────────────────── mezzotint ──────────────────────────

/// `pixelate.mezzotint` params: tile origin, hash `seed`, `kind` (0 fine
/// dots, 1 medium dots, 2 grainy dots, 3 coarse dots, 4 short lines,
/// 5 medium lines, 6 long lines, 7 short strokes, 8 medium strokes,
/// 9 long strokes), and the effect blend.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, ::bytemuck::Pod, ::bytemuck::Zeroable)]
pub struct PixelateMezzotintParams {
    pub ox: i32,
    pub oy: i32,
    pub seed: u32,
    pub kind: u32,
    pub amount: f32,
    pub _pad0: u32,
    pub _pad1: u32,
    pub _abi_pad: u32,
}

impl PixelateMezzotintParams {
    pub fn new(ox: i32, oy: i32, seed: u32, kind: u32, amount: f32) -> Self {
        Self {
            ox,
            oy,
            seed,
            kind,
            amount,
            _pad0: 0,
            _pad1: 0,
            _abi_pad: 0,
        }
    }
}
params_impl!(PixelateMezzotintParams);

/// Mezzotint: every channel thresholded against a random screen, so it
/// becomes fully on or off — dots of 1, 2 or 4 px (grainy mixes two
/// sizes), horizontal lines of 4, 8 or 16 px, or diagonal strokes of 4, 8
/// or 16 px, each channel with a screen of its own. The probability a
/// channel is on equals its value, so tone survives on average.
///
/// IDENTITY: `amount = 0.0`.
pub static PIXELATE_MEZZOTINT: KernelDef = KernelDef {
    id: "pixelate.mezzotint",
    class: KernelClass::Point,
    inputs: 1,
    params: ParamsLayout {
        size: ::core::mem::size_of::<PixelateMezzotintParams>(),
        fields: &[
            pf("ox", "i32"),
            pf("oy", "i32"),
            pf("seed", "u32"),
            pf("kind", "u32"),
            pf("amount", "f32"),
        ],
    },
    wgsl: PIXELATE_MEZZOTINT_WGSL,
    module: true,
    mip_exact: false,
    gpu_tolerance: Tolerance::ChannelEpsF16(2),
};

const PIXELATE_MEZZOTINT_WGSL: &str = "\
// paged.image kernel `pixelate.mezzotint` — handwritten under ABI v1.1.
// AGPL-3.0-only OR LicenseRef-PMEL; (c) And The Next GmbH.

struct Params {
    ox: i32,
    oy: i32,
    seed: u32,
    kind: u32,
    amount: f32,
    _pad0: u32,
    _pad1: u32,
    _abi_pad: u32,
}

@group(0) @binding(0) var in0 : texture_2d<f32>;
@group(1) @binding(0) var<uniform> params : Params;
@group(2) @binding(0) var mask : texture_2d<f32>;
@group(3) @binding(0) var outp : texture_storage_2d<rgba16float, write>;

fn pcg(v: u32) -> u32 {
    let state = v * 747796405u + 2891336453u;
    let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
    return (word >> 22u) ^ word;
}

fn hash21(x: i32, y: i32, seed: u32) -> f32 {
    let h = pcg(bitcast<u32>(x) ^ pcg(bitcast<u32>(y) ^ pcg(seed)));
    return f32(h >> 8u) * 5.9604644775390625e-8;
}

fn unpremul(c: vec4<f32>) -> vec3<f32> {
    if (c.a == 0.0) { return vec3<f32>(0.0); }
    return c.rgb / c.a;
}

// Floor division (the lattice must not fold at zero).
fn fdiv(a: i32, b: i32) -> i32 {
    return i32(floor(f32(a) / f32(b)));
}

fn screen(gx: i32, gy: i32, seed: u32) -> f32 {
    let k = params.kind;
    if (k == 0u) { return hash21(gx, gy, seed); }
    if (k == 1u) { return hash21(fdiv(gx, 2), fdiv(gy, 2), seed); }
    if (k == 2u) {
        return 0.5 * (hash21(gx, gy, seed) + hash21(fdiv(gx, 2), fdiv(gy, 2), seed ^ 2246822519u));
    }
    if (k == 3u) { return hash21(fdiv(gx, 4), fdiv(gy, 4), seed); }
    var len = 4;
    if (k == 5u || k == 8u) { len = 8; }
    if (k == 6u || k == 9u) { len = 16; }
    var u = gx;
    var v = gy;
    if (k >= 7u) {
        u = gx + gy;
        v = gx - gy;
    }
    // Each line or stroke row starts its runs at a hashed phase.
    let sh = i32(floor(hash21(0, v, seed ^ 3266489917u) * f32(len)));
    return hash21(fdiv(u + sh, len), v, seed);
}

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
    let d = textureDimensions(outp);
    if (gid.x >= d.x || gid.y >= d.y) { return; }
    let xy = vec2<i32>(i32(gid.x), i32(gid.y));
    let a = textureLoad(in0, xy, 0);
    let v = unpremul(a);
    let gx = params.ox + xy.x;
    let gy = params.oy + xy.y;
    let n = vec3<f32>(
        screen(gx, gy, params.seed ^ 2654435769u),
        screen(gx, gy, params.seed ^ 1013904242u),
        screen(gx, gy, params.seed ^ 3668340011u));
    let on = select(vec3<f32>(0.0), vec3<f32>(1.0), v > n);
    let styled = vec4<f32>(on * a.a, a.a);
    let result = mix(a, styled, vec4<f32>(clamp(params.amount, 0.0, 1.0)));
    let m = textureLoad(mask, xy, 0).r;
    textureStore(outp, xy, mix(a, result, vec4<f32>(m)));
}
";

// ──────────────────────────── color halftone ───────────────────────

/// `pixelate.color_halftone` params: `max_radius` (px), the four screen
/// angles (degrees; an RGB image uses the first three), the effect blend,
/// and the tile origin.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, ::bytemuck::Pod, ::bytemuck::Zeroable)]
pub struct PixelateColorHalftoneParams {
    pub max_radius: f32,
    pub angle1: f32,
    pub angle2: f32,
    pub angle3: f32,
    pub angle4: f32,
    pub amount: f32,
    pub ox: i32,
    pub oy: i32,
    pub _pad0: u32,
    pub _pad1: u32,
    pub _pad2: u32,
    pub _abi_pad: u32,
}

impl PixelateColorHalftoneParams {
    pub fn new(ox: i32, oy: i32, max_radius: f32, angles: [f32; 4], amount: f32) -> Self {
        Self {
            max_radius,
            angle1: angles[0],
            angle2: angles[1],
            angle3: angles[2],
            angle4: angles[3],
            amount,
            ox,
            oy,
            _pad0: 0,
            _pad1: 0,
            _pad2: 0,
            _abi_pad: 0,
        }
    }
}
params_impl!(PixelateColorHalftoneParams);

/// Color Halftone: each channel through a dot screen of its own angle,
/// as an INK separation — dark dots on white, the dot growing as the
/// channel darkens (the polarity the Photoshop probe records: regional
/// means follow the input). The screen's cells are `2·max_radius` wide;
/// a cell's dot takes the channel's ink `1 − v` at the cell centre
/// (bilinear) and a radius of `max_radius · √(2(1 − v))`, so a black
/// channel closes the screen and a full one leaves white. A pixel's
/// channel is `1 −` the dot coverage there (the 3×3 neighbouring cells,
/// the largest), antialiased over one pixel.
///
/// IDENTITY: `amount = 0.0`.
pub static PIXELATE_COLOR_HALFTONE: KernelDef = KernelDef {
    id: "pixelate.color_halftone",
    class: KernelClass::Point,
    inputs: 1,
    params: ParamsLayout {
        size: ::core::mem::size_of::<PixelateColorHalftoneParams>(),
        fields: &[
            pf("max_radius", "f32"),
            pf("angle1", "f32"),
            pf("angle2", "f32"),
            pf("angle3", "f32"),
            pf("angle4", "f32"),
            pf("amount", "f32"),
            pf("ox", "i32"),
            pf("oy", "i32"),
        ],
    },
    wgsl: PIXELATE_COLOR_HALFTONE_WGSL,
    module: true,
    mip_exact: false,
    gpu_tolerance: Tolerance::ChannelEpsF16(8),
};

const PIXELATE_COLOR_HALFTONE_WGSL: &str = "\
// paged.image kernel `pixelate.color_halftone` — handwritten under ABI v1.1.
// AGPL-3.0-only OR LicenseRef-PMEL; (c) And The Next GmbH.

struct Params {
    max_radius: f32,
    angle1: f32,
    angle2: f32,
    angle3: f32,
    angle4: f32,
    amount: f32,
    ox: i32,
    oy: i32,
    _pad0: u32,
    _pad1: u32,
    _pad2: u32,
    _abi_pad: u32,
}

@group(0) @binding(0) var in0 : texture_2d<f32>;
@group(1) @binding(0) var<uniform> params : Params;
@group(2) @binding(0) var mask : texture_2d<f32>;
@group(3) @binding(0) var outp : texture_storage_2d<rgba16float, write>;

fn tap(c: vec2<i32>) -> vec4<f32> {
    let din = vec2<i32>(textureDimensions(in0));
    return textureLoad(in0, clamp(c, vec2<i32>(0), din - vec2<i32>(1)), 0);
}

// Bilinear sample at a LOCAL position (pixel centres at +0.5), straight.
fn sample_straight(p: vec2<f32>) -> vec3<f32> {
    let q = p - vec2<f32>(0.5);
    let f0 = floor(q);
    let f = q - f0;
    let i = vec2<i32>(i32(f0.x), i32(f0.y));
    let c00 = tap(i);
    let c10 = tap(i + vec2<i32>(1, 0));
    let c01 = tap(i + vec2<i32>(0, 1));
    let c11 = tap(i + vec2<i32>(1, 1));
    let top = c00 + (c10 - c00) * f.x;
    let bot = c01 + (c11 - c01) * f.x;
    let c = top + (bot - top) * f.y;
    if (c.a <= 0.0) { return vec3<f32>(0.0); }
    return clamp(c.rgb / c.a, vec3<f32>(0.0), vec3<f32>(1.0));
}

fn channel_cov(gp: vec2<f32>, deg: f32, ch: i32, r_max: f32) -> f32 {
    let th = deg * 0.017453292519943295;
    let cs = cos(th);
    let sn = sin(th);
    let cell = 2.0 * r_max;
    let u = vec2<f32>(cs * gp.x + sn * gp.y, cs * gp.y - sn * gp.x);
    let idx = floor(u / cell);
    let o = vec2<f32>(f32(params.ox), f32(params.oy));
    var best = 0.0;
    for (var j : i32 = -1; j <= 1; j = j + 1) {
        for (var i : i32 = -1; i <= 1; i = i + 1) {
            let uc = (idx + vec2<f32>(f32(i), f32(j)) + vec2<f32>(0.5)) * cell;
            let pc = vec2<f32>(cs * uc.x - sn * uc.y, sn * uc.x + cs * uc.y) - o;
            let s = sample_straight(pc);
            var v = s.r;
            if (ch == 1) { v = s.g; }
            if (ch == 2) { v = s.b; }
            let rad = r_max * sqrt(2.0 * (1.0 - v));
            let dv = u - uc;
            let dist = sqrt(dv.x * dv.x + dv.y * dv.y);
            best = max(best, clamp(rad - dist + 0.5, 0.0, 1.0));
        }
    }
    return best;
}

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
    let d = textureDimensions(outp);
    if (gid.x >= d.x || gid.y >= d.y) { return; }
    let xy = vec2<i32>(i32(gid.x), i32(gid.y));
    let a = tap(xy);
    let r_max = clamp(params.max_radius, 4.0, 127.0);
    let gp = vec2<f32>(xy) + vec2<f32>(0.5) + vec2<f32>(f32(params.ox), f32(params.oy));
    let ink = vec3<f32>(
        channel_cov(gp, params.angle1, 0, r_max),
        channel_cov(gp, params.angle2, 1, r_max),
        channel_cov(gp, params.angle3, 2, r_max));
    let styled = vec4<f32>((vec3<f32>(1.0) - ink) * a.a, a.a);
    let result = mix(a, styled, vec4<f32>(clamp(params.amount, 0.0, 1.0)));
    let m = textureLoad(mask, xy, 0).r;
    textureStore(outp, xy, mix(a, result, vec4<f32>(m)));
}
";

/// Every kernel of this family (the conformance gate joins it to the registry).
pub static FAMILY: &[&KernelDef] = &[
    &PIXELATE_CRYSTALLIZE,
    &PIXELATE_POINTILLIZE,
    &PIXELATE_MEZZOTINT,
    &PIXELATE_COLOR_HALFTONE,
];
