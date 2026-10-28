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

//! Stylize family (WP5.2): **Wind**, **Extrude**, **Tiles**, **Solarize**
//! and **Trace Contour** — Photoshop's Filter ▸ Stylize entries that the
//! convolution family (`conv.emboss`, `conv.find_edges`) and the gallery
//! (`gallery.glowing_edges`) do not already cover.
//!
//! Every kernel is a handwritten ABI v1.1 module of class `Point`: the
//! one-shot doors and the layer fold hand a point module the WHOLE image
//! as `in0` (output dims), so a kernel that needs a neighbour — a wind
//! trail, a displaced tile, a contour test — `textureLoad`s it directly,
//! clamped to the image, the way `geom.mosaic` does.
//!
//! The family's conventions are the gallery's (gallery.rs):
//!
//! 1. **`amount` is the last word**: every kernel ends
//!    `mix(a, styled, amount)`, so `amount = 0` returns the input
//!    exactly (the identity the behavioural lane checks; the doors pass
//!    1, the Filter Gallery stack uses it as an effect's fade).
//! 2. **Position enters through `ox`/`oy`** for anything positional (the
//!    tile lattice, the per-row wind lengths), so a tiled dispatch does not
//!    restart the pattern at each tile.
//! 3. **No host randomness**: the PCG hash of (global coordinate, seed),
//!    character-identical to gallery.rs.
//! 4. **Colour maths on straight colour**: the doors associate alpha when
//!    an image has any, so a kernel that thresholds or inverts a VALUE
//!    unpremultiplies first and re-associates after; a kernel that only
//!    MOVES samples (wind, tiles) moves them as they come.
//!
//! Provenance: the behaviour of each filter as Photoshop's user guide
//! describes it (Filter ▸ Stylize: Wind's three methods and two
//! directions, Extrude's blocks/pyramids with random or level-based depth,
//! Tiles' count/offset/fill choices, Solarize "blends a negative and a
//! positive image", Trace Contour's level and upper/lower edge), and
//! textbook techniques — directional smear with a decaying weight, a swept
//! square for the extruded block (the parallel projection of a box), the
//! PCG hash (Jarzynski & Olano, JCGT 2020). No Adobe code and no
//! reference implementation was read.

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

// ───────────────────────────── solarize ────────────────────────────

/// `stylize.solarize` params: the effect blend only.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, ::bytemuck::Pod, ::bytemuck::Zeroable)]
pub struct StylizeSolarizeParams {
    pub amount: f32,
    pub _pad0: u32,
    pub _pad1: u32,
    pub _abi_pad: u32,
}

impl StylizeSolarizeParams {
    pub fn new(amount: f32) -> Self {
        Self {
            amount,
            _pad0: 0,
            _pad1: 0,
            _abi_pad: 0,
        }
    }
}
params_impl!(StylizeSolarizeParams);

/// Solarize: every straight channel above one half is inverted, so the
/// tone curve rises to 0.5 and falls back to 0 — a negative and a positive
/// of the image blended. Alpha passes through.
///
/// IDENTITY: `amount = 0.0`.
pub static STYLIZE_SOLARIZE: KernelDef = KernelDef {
    id: "stylize.solarize",
    class: KernelClass::Point,
    inputs: 1,
    params: ParamsLayout {
        size: ::core::mem::size_of::<StylizeSolarizeParams>(),
        fields: &[pf("amount", "f32")],
    },
    wgsl: STYLIZE_SOLARIZE_WGSL,
    module: true,
    mip_exact: true,
    gpu_tolerance: Tolerance::ChannelEpsF16(2),
};

const STYLIZE_SOLARIZE_WGSL: &str = "\
// paged.image kernel `stylize.solarize` — handwritten under ABI v1.1.
// AGPL-3.0-only OR LicenseRef-PMEL; (c) And The Next GmbH.

struct Params {
    amount: f32,
    _pad0: u32,
    _pad1: u32,
    _abi_pad: u32,
}

@group(0) @binding(0) var in0 : texture_2d<f32>;
@group(1) @binding(0) var<uniform> params : Params;
@group(2) @binding(0) var mask : texture_2d<f32>;
@group(3) @binding(0) var outp : texture_storage_2d<rgba16float, write>;

fn unpremul(c: vec4<f32>) -> vec3<f32> {
    if (c.a == 0.0) { return vec3<f32>(0.0); }
    return c.rgb / c.a;
}

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
    let d = textureDimensions(outp);
    if (gid.x >= d.x || gid.y >= d.y) { return; }
    let xy = vec2<i32>(i32(gid.x), i32(gid.y));
    let a = textureLoad(in0, xy, 0);
    let s = unpremul(a);
    let r = select(s, vec3<f32>(1.0) - s, s > vec3<f32>(0.5));
    let styled = vec4<f32>(r * a.a, a.a);
    let result = mix(a, styled, vec4<f32>(clamp(params.amount, 0.0, 1.0)));
    let m = textureLoad(mask, xy, 0).r;
    textureStore(outp, xy, mix(a, result, vec4<f32>(m)));
}
";

// ─────────────────────────── trace contour ─────────────────────────

/// `stylize.trace_contour` params: the `level` (0..1), which side of it
/// is outlined (`upper` 0 = lower, 1 = upper), and the effect blend.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, ::bytemuck::Pod, ::bytemuck::Zeroable)]
pub struct StylizeTraceContourParams {
    pub level: f32,
    pub upper: u32,
    pub amount: f32,
    pub _abi_pad: u32,
}

impl StylizeTraceContourParams {
    pub fn new(level: f32, upper: bool, amount: f32) -> Self {
        Self {
            level,
            upper: u32::from(upper),
            amount,
            _abi_pad: 0,
        }
    }
}
params_impl!(StylizeTraceContourParams);

/// Trace Contour: per channel, a pixel on the chosen side of `level` with
/// a 4-neighbour on the other side is a contour pixel and goes to 0; every
/// other pixel goes to 1 — thin coloured lines on white, one set per
/// channel, like a contour map. Lower: `v < level` beside `n ≥ level`;
/// upper: `v ≥ level` beside `n < level`. Alpha passes through.
///
/// IDENTITY: `amount = 0.0`.
pub static STYLIZE_TRACE_CONTOUR: KernelDef = KernelDef {
    id: "stylize.trace_contour",
    class: KernelClass::Point,
    inputs: 1,
    params: ParamsLayout {
        size: ::core::mem::size_of::<StylizeTraceContourParams>(),
        fields: &[pf("level", "f32"), pf("upper", "u32"), pf("amount", "f32")],
    },
    wgsl: STYLIZE_TRACE_CONTOUR_WGSL,
    module: true,
    mip_exact: false,
    gpu_tolerance: Tolerance::ChannelEpsF16(2),
};

const STYLIZE_TRACE_CONTOUR_WGSL: &str = "\
// paged.image kernel `stylize.trace_contour` — handwritten under ABI v1.1.
// AGPL-3.0-only OR LicenseRef-PMEL; (c) And The Next GmbH.

struct Params {
    level: f32,
    upper: u32,
    amount: f32,
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

fn unpremul(c: vec4<f32>) -> vec3<f32> {
    if (c.a == 0.0) { return vec3<f32>(0.0); }
    return c.rgb / c.a;
}

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
    let d = textureDimensions(outp);
    if (gid.x >= d.x || gid.y >= d.y) { return; }
    let xy = vec2<i32>(i32(gid.x), i32(gid.y));
    let a = tap(xy);
    let v = unpremul(a);
    let lv = vec3<f32>(params.level);
    // The outlined side, and whether ANY 4-neighbour is across the level.
    var side = v < lv;
    if (params.upper != 0u) { side = v >= lv; }
    var across = vec3<bool>(false);
    var offs = array<vec2<i32>, 4>(
        vec2<i32>(-1, 0), vec2<i32>(1, 0), vec2<i32>(0, -1), vec2<i32>(0, 1));
    for (var k : i32 = 0; k < 4; k = k + 1) {
        let n = unpremul(tap(xy + offs[k]));
        var other = n >= lv;
        if (params.upper != 0u) { other = n < lv; }
        across = across | other;
    }
    let on = side & across;
    let line = select(vec3<f32>(1.0), vec3<f32>(0.0), on);
    let styled = vec4<f32>(line * a.a, a.a);
    let result = mix(a, styled, vec4<f32>(clamp(params.amount, 0.0, 1.0)));
    let m = textureLoad(mask, xy, 0).r;
    textureStore(outp, xy, mix(a, result, vec4<f32>(m)));
}
";

// ──────────────────────────────── wind ─────────────────────────────

/// Longest trail any method draws (the loop bound; blast's rows reach it).
pub const WIND_MAX_LENGTH: u32 = 48;

/// `stylize.wind` params: tile origin, hash `seed`, `method` (0 wind,
/// 1 blast, 2 stagger), `from_left` (0 = the wind blows from the right),
/// and the effect blend.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, ::bytemuck::Pod, ::bytemuck::Zeroable)]
pub struct StylizeWindParams {
    pub ox: i32,
    pub oy: i32,
    pub seed: u32,
    pub method: u32,
    pub from_left: u32,
    pub amount: f32,
    pub _pad0: u32,
    pub _abi_pad: u32,
}

impl StylizeWindParams {
    pub fn new(ox: i32, oy: i32, seed: u32, method: u32, from_left: bool, amount: f32) -> Self {
        Self {
            ox,
            oy,
            seed,
            method,
            from_left: u32::from(from_left),
            amount,
            _pad0: 0,
            _abi_pad: 0,
        }
    }
}
params_impl!(StylizeWindParams);

/// Wind: thin horizontal streaks blown off every edge where a lighter
/// sample sits UPWIND of a darker one. Each row draws a trail of its own
/// (hashed) length; a trail sample `k` px upwind pulls the pixel toward
/// itself with weight `1 − k/(L+1)` (wind; blast squares the falloff and
/// runs longer; stagger breaks rows into runs whose lengths alternate),
/// and the lightest pull wins channel by channel, so trails stay on the
/// dark side of edges as streaks do.
///
/// IDENTITY: `amount = 0.0`.
pub static STYLIZE_WIND: KernelDef = KernelDef {
    id: "stylize.wind",
    class: KernelClass::Point,
    inputs: 1,
    params: ParamsLayout {
        size: ::core::mem::size_of::<StylizeWindParams>(),
        fields: &[
            pf("ox", "i32"),
            pf("oy", "i32"),
            pf("seed", "u32"),
            pf("method", "u32"),
            pf("from_left", "u32"),
            pf("amount", "f32"),
        ],
    },
    wgsl: STYLIZE_WIND_WGSL,
    module: true,
    mip_exact: false,
    gpu_tolerance: Tolerance::ChannelEpsF16(4),
};

const STYLIZE_WIND_WGSL: &str = "\
// paged.image kernel `stylize.wind` — handwritten under ABI v1.1.
// AGPL-3.0-only OR LicenseRef-PMEL; (c) And The Next GmbH.

struct Params {
    ox: i32,
    oy: i32,
    seed: u32,
    method: u32,
    from_left: u32,
    amount: f32,
    _pad0: u32,
    _abi_pad: u32,
}

@group(0) @binding(0) var in0 : texture_2d<f32>;
@group(1) @binding(0) var<uniform> params : Params;
@group(2) @binding(0) var mask : texture_2d<f32>;
@group(3) @binding(0) var outp : texture_storage_2d<rgba16float, write>;

const L_MAX : i32 = 48;

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
    let gy = params.oy + xy.y;
    let gx = params.ox + xy.x;
    // Upwind: from the right the sources sit at larger x.
    var dir = 1;
    if (params.from_left != 0u) { dir = -1; }
    // The row's trail length.
    var lmax = 12.0;
    var lmin = 0.35;
    if (params.method == 1u) { lmax = 48.0; lmin = 0.6; }
    var h = hash21(0, gy, params.seed);
    if (params.method == 2u) {
        // Stagger: the row breaks into 16 px runs, each with its own length.
        let run = i32(floor(f32(gx) / 16.0));
        h = hash21(run, gy, params.seed ^ 2654435769u);
        lmax = 20.0;
        lmin = 0.1;
    }
    let len = floor(lmax * (lmin + (1.0 - lmin) * h));
    var acc = a;
    for (var k : i32 = 1; k <= L_MAX; k = k + 1) {
        let kf = f32(k);
        if (kf > len) { break; }
        let s = tap(xy + vec2<i32>(dir * k, 0));
        var w = 1.0 - kf / (len + 1.0);
        if (params.method == 1u) { w = w * w; }
        let pull = a + (s - a) * w;
        // Only a lighter upwind sample blows over a darker pixel.
        acc = select(acc, max(acc, pull), s > a);
    }
    let styled = clamp(acc, vec4<f32>(0.0), vec4<f32>(1.0));
    let result = mix(a, styled, vec4<f32>(clamp(params.amount, 0.0, 1.0)));
    let m = textureLoad(mask, xy, 0).r;
    textureStore(outp, xy, mix(a, result, vec4<f32>(m)));
}
";

// ──────────────────────────────── tiles ────────────────────────────

/// `stylize.tiles` params: tile origin, hash `seed`, `tiles` across the
/// shorter side, `max_offset` (0..1 of a tile), `fill` (0 background
/// colour, 1 foreground colour, 2 inverse image, 3 unaltered image), the
/// two colours (straight rgb), and the effect blend.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, ::bytemuck::Pod, ::bytemuck::Zeroable)]
pub struct StylizeTilesParams {
    pub ox: i32,
    pub oy: i32,
    pub seed: u32,
    pub tiles: u32,
    pub max_offset: f32,
    pub fill: u32,
    pub fg_r: f32,
    pub fg_g: f32,
    pub fg_b: f32,
    pub bg_r: f32,
    pub bg_g: f32,
    pub bg_b: f32,
    pub amount: f32,
    pub _pad0: u32,
    pub _pad1: u32,
    pub _abi_pad: u32,
}

impl StylizeTilesParams {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        ox: i32,
        oy: i32,
        seed: u32,
        tiles: u32,
        max_offset: f32,
        fill: u32,
        fg: [f32; 3],
        bg: [f32; 3],
        amount: f32,
    ) -> Self {
        Self {
            ox,
            oy,
            seed,
            tiles,
            max_offset,
            fill,
            fg_r: fg[0],
            fg_g: fg[1],
            fg_b: fg[2],
            bg_r: bg[0],
            bg_g: bg[1],
            bg_b: bg[2],
            amount,
            _pad0: 0,
            _pad1: 0,
            _abi_pad: 0,
        }
    }
}
params_impl!(StylizeTilesParams);

/// Tiles: the image cut into square tiles (`tiles` across the shorter
/// side), each shifted by a hashed offset of up to `max_offset` of a tile;
/// where no tile lands the `fill` shows (a colour, the inverse image, or
/// the image itself). Overlapping tiles are decided by a hashed priority,
/// scanned in ascending order with a strict `>`, so both lanes agree.
///
/// IDENTITY: `amount = 0.0`.
pub static STYLIZE_TILES: KernelDef = KernelDef {
    id: "stylize.tiles",
    class: KernelClass::Point,
    inputs: 1,
    params: ParamsLayout {
        size: ::core::mem::size_of::<StylizeTilesParams>(),
        fields: &[
            pf("ox", "i32"),
            pf("oy", "i32"),
            pf("seed", "u32"),
            pf("tiles", "u32"),
            pf("max_offset", "f32"),
            pf("fill", "u32"),
            pf("fg_r", "f32"),
            pf("fg_g", "f32"),
            pf("fg_b", "f32"),
            pf("bg_r", "f32"),
            pf("bg_g", "f32"),
            pf("bg_b", "f32"),
            pf("amount", "f32"),
        ],
    },
    wgsl: STYLIZE_TILES_WGSL,
    module: true,
    mip_exact: false,
    gpu_tolerance: Tolerance::ChannelEpsF16(2),
};

const STYLIZE_TILES_WGSL: &str = "\
// paged.image kernel `stylize.tiles` — handwritten under ABI v1.1.
// AGPL-3.0-only OR LicenseRef-PMEL; (c) And The Next GmbH.

struct Params {
    ox: i32,
    oy: i32,
    seed: u32,
    tiles: u32,
    max_offset: f32,
    fill: u32,
    fg_r: f32,
    fg_g: f32,
    fg_b: f32,
    bg_r: f32,
    bg_g: f32,
    bg_b: f32,
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

fn unpremul(c: vec4<f32>) -> vec3<f32> {
    if (c.a == 0.0) { return vec3<f32>(0.0); }
    return c.rgb / c.a;
}

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
    let d = textureDimensions(outp);
    if (gid.x >= d.x || gid.y >= d.y) { return; }
    let xy = vec2<i32>(i32(gid.x), i32(gid.y));
    let a = tap(xy);
    let din = vec2<i32>(textureDimensions(in0));
    let n = f32(clamp(params.tiles, 1u, 99u));
    let s = max(1.0, floor(f32(min(din.x, din.y)) / n));
    let off_max = clamp(params.max_offset, 0.0, 1.0) * s;
    let gp = vec2<f32>(f32(params.ox + xy.x), f32(params.oy + xy.y));
    let ci = vec2<i32>(i32(floor(gp.x / s)), i32(floor(gp.y / s)));

    // The tile that lands here: own cell and its 8 neighbours (an offset
    // is at most one tile), highest hashed priority wins.
    var found = false;
    var best_pri = -1.0;
    var src = vec2<i32>(0);
    for (var j : i32 = -1; j <= 1; j = j + 1) {
        for (var i : i32 = -1; i <= 1; i = i + 1) {
            let c = ci + vec2<i32>(i, j);
            let ofs = vec2<f32>(
                floor((hash21(c.x, c.y, params.seed) * 2.0 - 1.0) * off_max),
                floor((hash21(c.x, c.y, params.seed ^ 3037000493u) * 2.0 - 1.0) * off_max));
            let lo = vec2<f32>(c) * s + ofs;
            let inside = gp.x >= lo.x && gp.x < lo.x + s && gp.y >= lo.y && gp.y < lo.y + s;
            let pri = hash21(c.x, c.y, params.seed ^ 1640531527u);
            if (inside && pri > best_pri) {
                found = true;
                best_pri = pri;
                src = xy - vec2<i32>(ofs);
            }
        }
    }
    var styled = a;
    if (found) {
        styled = tap(src);
    } else if (params.fill == 0u) {
        styled = vec4<f32>(vec3<f32>(params.bg_r, params.bg_g, params.bg_b) * a.a, a.a);
    } else if (params.fill == 1u) {
        styled = vec4<f32>(vec3<f32>(params.fg_r, params.fg_g, params.fg_b) * a.a, a.a);
    } else if (params.fill == 2u) {
        styled = vec4<f32>((vec3<f32>(1.0) - unpremul(a)) * a.a, a.a);
    }
    let result = mix(a, styled, vec4<f32>(clamp(params.amount, 0.0, 1.0)));
    let m = textureLoad(mask, xy, 0).r;
    textureStore(outp, xy, mix(a, result, vec4<f32>(m)));
}
";

// ─────────────────────────────── extrude ───────────────────────────

/// `stylize.extrude` params: tile origin, hash `seed`, `pyramids`
/// (0 blocks), `size_px` (2..255), `depth` (1..255), `level_based`
/// (0 = random depth), `solid_front`, `mask_incomplete`, and the effect
/// blend.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, ::bytemuck::Pod, ::bytemuck::Zeroable)]
pub struct StylizeExtrudeParams {
    pub ox: i32,
    pub oy: i32,
    pub seed: u32,
    pub pyramids: u32,
    pub size_px: f32,
    pub depth: f32,
    pub level_based: u32,
    pub solid_front: u32,
    pub mask_incomplete: u32,
    pub amount: f32,
    pub _pad0: u32,
    pub _abi_pad: u32,
}

impl StylizeExtrudeParams {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        ox: i32,
        oy: i32,
        seed: u32,
        pyramids: bool,
        size_px: f32,
        depth: f32,
        level_based: bool,
        solid_front: bool,
        mask_incomplete: bool,
        amount: f32,
    ) -> Self {
        Self {
            ox,
            oy,
            seed,
            pyramids: u32::from(pyramids),
            size_px,
            depth,
            level_based: u32::from(level_based),
            solid_front: u32::from(solid_front),
            mask_incomplete: u32::from(mask_incomplete),
            amount,
            _pad0: 0,
            _abi_pad: 0,
        }
    }
}
params_impl!(StylizeExtrudeParams);

/// Extrude: the image cut into `size_px` cells, each raised toward the
/// viewer by a depth that is random or follows the cell's luminance
/// (`level_based`).
///
/// * **Blocks**: a box seen in a parallel projection away from the canvas
///   centre — its front face is the cell's square displaced by
///   `(centre_of_cell − canvas_centre) · depth/255 · 0.35`, and the
///   footprint is the square SWEPT along that displacement. A pixel is in
///   a block when some `t ∈ [0, 1]` puts `p − t·d` in the base square; the
///   largest such `t` is 1 on the front face, below 1 on a side (which
///   side is the axis that limited `t`). The front shows the cell's own
///   pixels (`p − d`) or, with `solid_front`, the cell colour; sides show
///   the cell colour, shaded by orientation. Taller blocks occlude lower
///   ones (5×5 cells scanned, strict `>`).
/// * **Pyramids**: four triangular faces meeting at the cell centre,
///   shaded by orientation in proportion to the depth.
///
/// `mask_incomplete` leaves the pixels of a winning cell that runs over
/// the canvas edge unchanged.
///
/// IDENTITY: `amount = 0.0`.
pub static STYLIZE_EXTRUDE: KernelDef = KernelDef {
    id: "stylize.extrude",
    class: KernelClass::Point,
    inputs: 1,
    params: ParamsLayout {
        size: ::core::mem::size_of::<StylizeExtrudeParams>(),
        fields: &[
            pf("ox", "i32"),
            pf("oy", "i32"),
            pf("seed", "u32"),
            pf("pyramids", "u32"),
            pf("size_px", "f32"),
            pf("depth", "f32"),
            pf("level_based", "u32"),
            pf("solid_front", "u32"),
            pf("mask_incomplete", "u32"),
            pf("amount", "f32"),
        ],
    },
    wgsl: STYLIZE_EXTRUDE_WGSL,
    module: true,
    mip_exact: false,
    gpu_tolerance: Tolerance::ChannelEpsF16(4),
};

const STYLIZE_EXTRUDE_WGSL: &str = "\
// paged.image kernel `stylize.extrude` — handwritten under ABI v1.1.
// AGPL-3.0-only OR LicenseRef-PMEL; (c) And The Next GmbH.

struct Params {
    ox: i32,
    oy: i32,
    seed: u32,
    pyramids: u32,
    size_px: f32,
    depth: f32,
    level_based: u32,
    solid_front: u32,
    mask_incomplete: u32,
    amount: f32,
    _pad0: u32,
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

fn unpremul(c: vec4<f32>) -> vec3<f32> {
    if (c.a == 0.0) { return vec3<f32>(0.0); }
    return c.rgb / c.a;
}

fn luma(c: vec3<f32>) -> f32 {
    return c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722;
}

// A cell's colour: its centre pixel (local coordinates).
fn cell_colour(c: vec2<i32>, s: f32) -> vec4<f32> {
    let cc = (vec2<f32>(c) + vec2<f32>(0.5)) * s
        - vec2<f32>(f32(params.ox), f32(params.oy));
    return tap(vec2<i32>(i32(floor(cc.x)), i32(floor(cc.y))));
}

// A cell's height in [0, 1].
fn cell_height(c: vec2<i32>, s: f32) -> f32 {
    let dep = clamp(params.depth, 1.0, 255.0) / 255.0;
    if (params.level_based != 0u) {
        return luma(unpremul(cell_colour(c, s))) * dep;
    }
    return hash21(c.x, c.y, params.seed) * dep;
}

fn incomplete(c: vec2<i32>, s: f32, din: vec2<i32>) -> bool {
    let lo = vec2<f32>(c) * s - vec2<f32>(f32(params.ox), f32(params.oy));
    return lo.x < 0.0 || lo.y < 0.0 || lo.x + s > f32(din.x) || lo.y + s > f32(din.y);
}

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
    let d = textureDimensions(outp);
    if (gid.x >= d.x || gid.y >= d.y) { return; }
    let xy = vec2<i32>(i32(gid.x), i32(gid.y));
    let a = tap(xy);
    let din = vec2<i32>(textureDimensions(in0));
    let s = clamp(params.size_px, 2.0, 255.0);
    let o = vec2<f32>(f32(params.ox), f32(params.oy));
    let p = vec2<f32>(xy) + vec2<f32>(0.5);
    let gp = p + o;
    let ci = vec2<i32>(i32(floor(gp.x / s)), i32(floor(gp.y / s)));
    var styled = a;

    if (params.pyramids != 0u) {
        let h = cell_height(ci, s);
        let col = cell_colour(ci, s);
        let q = gp / s - vec2<f32>(ci) - vec2<f32>(0.5);
        // The face: which of |qx|, |qy| dominates, and its sign. The light
        // comes from the top left.
        var shade = 1.0;
        if (abs(q.x) >= abs(q.y)) {
            shade = select(1.0 + 0.25 * h, 1.0 - 0.45 * h, q.x > 0.0);
        } else {
            shade = select(1.0 + 0.4 * h, 1.0 - 0.6 * h, q.y > 0.0);
        }
        styled = vec4<f32>(clamp(col.rgb * shade, vec3<f32>(0.0), vec3<f32>(col.a)), col.a);
        if (params.mask_incomplete != 0u && incomplete(ci, s, din)) { styled = a; }
    } else {
        let centre = vec2<f32>(din) * 0.5;
        var best_h = -1.0;
        var best_t = 0.0;
        var best_axis = 0;
        var best_d = vec2<f32>(0.0);
        var best_c = ci;
        for (var j : i32 = -2; j <= 2; j = j + 1) {
            for (var i : i32 = -2; i <= 2; i = i + 1) {
                let c = ci + vec2<i32>(i, j);
                let h = cell_height(c, s);
                let lo = vec2<f32>(c) * s - o;
                let dd = ((lo + vec2<f32>(0.5 * s)) - centre) * (h * 0.35);
                // t-interval where p - t*dd lies in [lo, lo + s) per axis.
                var t0 = 0.0;
                var t1 = 1.0;
                var axis = 0;
                for (var k : i32 = 0; k < 2; k = k + 1) {
                    var pk = p.x;
                    var lk = lo.x;
                    var dk = dd.x;
                    if (k == 1) { pk = p.y; lk = lo.y; dk = dd.y; }
                    if (abs(dk) < 1e-6) {
                        if (pk < lk || pk >= lk + s) { t0 = 2.0; }
                    } else {
                        let ta = (pk - (lk + s)) / dk;
                        let tb = (pk - lk) / dk;
                        let tl = min(ta, tb);
                        let th = max(ta, tb);
                        t0 = max(t0, tl);
                        if (th < t1) { t1 = th; axis = k + 1; }
                    }
                }
                if (t0 <= t1 && h > best_h) {
                    best_h = h;
                    best_t = t1;
                    best_axis = axis;
                    best_d = dd;
                    best_c = c;
                }
            }
        }
        let col = cell_colour(best_c, s);
        if (best_axis == 0 || best_t >= 1.0) {
            // The front face.
            if (params.solid_front != 0u) {
                styled = col;
            } else {
                let q = p - best_d;
                styled = tap(vec2<i32>(i32(floor(q.x)), i32(floor(q.y))));
            }
        } else {
            // A side: lit when it faces up or left.
            var shade = 0.0;
            if (best_axis == 1) {
                shade = select(0.6, 0.85, best_d.x > 0.0);
            } else {
                shade = select(0.75, 0.5, best_d.y < 0.0);
            }
            styled = vec4<f32>(col.rgb * shade, col.a);
        }
        if (params.mask_incomplete != 0u && incomplete(best_c, s, din)) { styled = a; }
    }
    styled = clamp(styled, vec4<f32>(0.0), vec4<f32>(1.0));
    let result = mix(a, styled, vec4<f32>(clamp(params.amount, 0.0, 1.0)));
    let m = textureLoad(mask, xy, 0).r;
    textureStore(outp, xy, mix(a, result, vec4<f32>(m)));
}
";

/// Every kernel of this family (the conformance gate joins it to the registry).
pub static FAMILY: &[&KernelDef] = &[
    &STYLIZE_SOLARIZE,
    &STYLIZE_TRACE_CONTOUR,
    &STYLIZE_WIND,
    &STYLIZE_TILES,
    &STYLIZE_EXTRUDE,
];
