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

//! Morphology + rank filters (T3, spec §11) — handwritten WGSL modules
//! under the ABI v1.1 contract (`abi::assemble` docs). Every kernel here
//! is windowed, following the `conv.box` windowed convention: output
//! texel `(x, y)` maps to window center `(x + rx, y + ry)` in `in0`
//! coords — with `(rx, ry)` the CLASS radius, which is always the
//! ROI-planning MAXIMUM and not necessarily the radius a given dispatch
//! actually reads — and the module applies the ABI selection mask itself
//! as `mix(center, result, m)`.
//!
//! - `morph.dilate`: per-channel MAX over the 3×3 window.
//! - `morph.erode`:  per-channel MIN over the 3×3 window.
//! - `rank.median3`: per-channel MEDIAN of the 9 window samples, via a
//!   fixed comparator network (see [`MEDIAN3_WGSL`] docs).
//! - `rank.despeckle`: the 3×3 median, but substituted ONLY where the
//!   window's INNER range says the neighbourhood is flat-plus-noise
//!   rather than an edge (see [`RANK_DESPECKLE`] docs).
//! - `rank.dust_scratches`: the median over a RUNTIME radius (≤ 4, see
//!   below), substituted for the centre only where the centre departs
//!   from it by more than a threshold (see [`RANK_DUST_SCRATCHES`]).
//!
//! All but `rank.despeckle` are EXACT (`Tolerance::Exact`): max/min
//! select an existing f16 window value, the median network is built
//! purely from componentwise `min`/`max` of existing samples, and
//! dust-and-scratches SELECTS (never averages) between the centre and
//! the median — so every output texel is one of the input f16 values
//! reproduced bit-for-bit. `rank.despeckle` carries a small tolerance
//! only because of its `amount` lerp. NONE is `mip_exact`:
//! neighbourhood max/min/median do not commute with mip downsampling (a
//! max over a box of averages ≠ the average of a box of maxes), so the
//! engine recomputes per level rather than scaling params.
//!
//! WINDOW SIZE: dilate/erode/median3/despeckle are 3×3 — the fixed
//! comparator networks are exactly what make them cheap AND exact, and
//! a comparator network's shape is straight-line code, so it cannot
//! depend on a runtime radius. `rank.dust_scratches` is the
//! params-driven case: a `radius` uniform plus a dynamic window loop,
//! bounded at 4 because its runtime-radius selection method is
//! quadratic in the tap count (its doc comment argues the bound).
//! Dilate/erode would generalize trivially and have not been asked to;
//! a rank filter at large radius needs a histogram method, which is a
//! different kernel rather than a bigger loop bound here.
//!
//! Provenance: mathematical morphology (dilation/erosion as per-channel
//! sup/inf over a flat structuring element) and rank filtering (the
//! median as the order-statistic at rank 5 of 9) are standard textbook
//! material; the median selection network is a standard 19-comparator
//! median-of-9 network; count-below (rank-bracket) selection of an order
//! statistic is textbook selection. No reference reading.

use crate::{KernelClass, KernelDef, ParamField, ParamsLayout, Tolerance};

/// Bare ABI-pad params — morphology/median3 take no parameters in the
/// 3×3 form. (A `radius` field arrives with the larger-window follow-up.)
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, ::bytemuck::Pod, ::bytemuck::Zeroable)]
pub struct MorphParams {
    pub _abi_pad: u32,
}

#[allow(clippy::new_without_default)]
impl MorphParams {
    pub fn new() -> Self {
        Self { _abi_pad: 0 }
    }

    pub fn as_bytes(&self) -> &[u8] {
        ::bytemuck::bytes_of(self)
    }
}

// ───────────────────────────── dilate ──────────────────────────────

/// out = per-channel MAX of the 3×3 window (radius (1, 1)); mask-mixed
/// against the window center per the windowed convention. Exact: `max`
/// selects an existing f16 sample.
pub static MORPH_DILATE: KernelDef = KernelDef {
    id: "morph.dilate",
    class: KernelClass::Windowed { radius: (1, 1) },
    inputs: 1,
    params: ParamsLayout {
        size: ::core::mem::size_of::<MorphParams>(),
        fields: &[],
    },
    wgsl: MORPH_DILATE_WGSL,
    module: true,
    mip_exact: false,
    gpu_tolerance: Tolerance::Exact,
};

// Reduction order: dy outer ascending, dx inner ascending (the
// `conv.box` convention); the scalar reference folds the 9 samples with
// `max` in that exact order. `max` is associative/commutative over real
// values, but the order is fixed anyway to keep the two lanes
// byte-identical by construction (§6.3).
const MORPH_DILATE_WGSL: &str = "\
// paged.image kernel `morph.dilate` — handwritten under ABI v1.1.
// AGPL-3.0-only OR LicenseRef-PMEL; (c) And The Next GmbH.

struct Params {
    _abi_pad: u32,
}

@group(0) @binding(0) var in0 : texture_2d<f32>;
@group(1) @binding(0) var<uniform> params : Params;
@group(2) @binding(0) var mask : texture_2d<f32>;
@group(3) @binding(0) var outp : texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
    let dims = textureDimensions(outp);
    if (gid.x >= dims.x || gid.y >= dims.y) { return; }
    let xy = vec2<i32>(i32(gid.x), i32(gid.y));
    // Window center: output (x, y) maps to in0 (x + 1, y + 1).
    let c = xy + vec2<i32>(1, 1);
    var acc = textureLoad(in0, c + vec2<i32>(-1, -1), 0);
    for (var dy = -1; dy <= 1; dy = dy + 1) {
        for (var dx = -1; dx <= 1; dx = dx + 1) {
            acc = max(acc, textureLoad(in0, c + vec2<i32>(dx, dy), 0));
        }
    }
    let center = textureLoad(in0, c, 0);
    let m = textureLoad(mask, xy, 0).r;
    textureStore(outp, xy, mix(center, acc, vec4<f32>(m)));
}
";

// ────────────────────────────── erode ──────────────────────────────

/// out = per-channel MIN of the 3×3 window (radius (1, 1)); mask-mixed
/// against the window center. Exact: `min` selects an existing f16
/// sample.
pub static MORPH_ERODE: KernelDef = KernelDef {
    id: "morph.erode",
    class: KernelClass::Windowed { radius: (1, 1) },
    inputs: 1,
    params: ParamsLayout {
        size: ::core::mem::size_of::<MorphParams>(),
        fields: &[],
    },
    wgsl: MORPH_ERODE_WGSL,
    module: true,
    mip_exact: false,
    gpu_tolerance: Tolerance::Exact,
};

const MORPH_ERODE_WGSL: &str = "\
// paged.image kernel `morph.erode` — handwritten under ABI v1.1.
// AGPL-3.0-only OR LicenseRef-PMEL; (c) And The Next GmbH.

struct Params {
    _abi_pad: u32,
}

@group(0) @binding(0) var in0 : texture_2d<f32>;
@group(1) @binding(0) var<uniform> params : Params;
@group(2) @binding(0) var mask : texture_2d<f32>;
@group(3) @binding(0) var outp : texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
    let dims = textureDimensions(outp);
    if (gid.x >= dims.x || gid.y >= dims.y) { return; }
    let xy = vec2<i32>(i32(gid.x), i32(gid.y));
    // Window center: output (x, y) maps to in0 (x + 1, y + 1).
    let c = xy + vec2<i32>(1, 1);
    var acc = textureLoad(in0, c + vec2<i32>(-1, -1), 0);
    for (var dy = -1; dy <= 1; dy = dy + 1) {
        for (var dx = -1; dx <= 1; dx = dx + 1) {
            acc = min(acc, textureLoad(in0, c + vec2<i32>(dx, dy), 0));
        }
    }
    let center = textureLoad(in0, c, 0);
    let m = textureLoad(mask, xy, 0).r;
    textureStore(outp, xy, mix(center, acc, vec4<f32>(m)));
}
";

// ───────────────────────────── median3 ─────────────────────────────
//
// Per-channel median of the 9 samples of the 3×3 window. The 9 window
// taps are loaded into s0..s8 in raster order (dy outer ascending, dx
// inner ascending), i.e.:
//
//     s0 s1 s2        (dy = -1: dx = -1, 0, +1)
//     s3 s4 s5        (dy =  0)
//     s6 s7 s8        (dy = +1)
//
// The median (the rank-5 order statistic of 9) is selected by a FIXED
// 19-comparator selection network — the standard median-of-9 network
// that produces only the median (not a full sort). Each comparator is a
// componentwise compare-exchange `op2(a, b)` that replaces (a, b) with
// (min(a, b), max(a, b)); applied per channel via the vec4 builtins.
// Because the network is built purely from `min`/`max` of existing
// samples, the result is bit-for-bit one of the input f16 values — hence
// `Tolerance::Exact`. The Rust reference mirrors this network step for
// step, in the same order, so both lanes select the same sample (§6.3).
//
// Network (s4 holds the median after the final step):
//   op2(s1,s2) op2(s4,s5) op2(s7,s8)
//   op2(s0,s1) op2(s3,s4) op2(s6,s7)
//   op2(s1,s2) op2(s4,s5) op2(s7,s8)
//   op2(s0,s3) op2(s5,s8) op2(s4,s7)
//   op2(s3,s6) op2(s1,s4) op2(s2,s5)
//   op2(s4,s7) op2(s4,s2) op2(s6,s4)
//   op2(s4,s2)
//   median = s4

/// out = per-channel median of the 9 samples of the 3×3 window (radius
/// (1, 1)); mask-mixed against the window center. Exact: the selection
/// network is pure `min`/`max` of existing samples, so the median is one
/// of the input f16 values reproduced bit-for-bit.
pub static RANK_MEDIAN3: KernelDef = KernelDef {
    id: "rank.median3",
    class: KernelClass::Windowed { radius: (1, 1) },
    inputs: 1,
    params: ParamsLayout {
        size: ::core::mem::size_of::<MorphParams>(),
        fields: &[],
    },
    wgsl: MEDIAN3_WGSL,
    module: true,
    mip_exact: false,
    gpu_tolerance: Tolerance::Exact,
};

const MEDIAN3_WGSL: &str = "\
// paged.image kernel `rank.median3` — handwritten under ABI v1.1.
// AGPL-3.0-only OR LicenseRef-PMEL; (c) And The Next GmbH.

struct Params {
    _abi_pad: u32,
}

@group(0) @binding(0) var in0 : texture_2d<f32>;
@group(1) @binding(0) var<uniform> params : Params;
@group(2) @binding(0) var mask : texture_2d<f32>;
@group(3) @binding(0) var outp : texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
    let dims = textureDimensions(outp);
    if (gid.x >= dims.x || gid.y >= dims.y) { return; }
    let xy = vec2<i32>(i32(gid.x), i32(gid.y));
    // Window center: output (x, y) maps to in0 (x + 1, y + 1).
    let c = xy + vec2<i32>(1, 1);
    // 9 taps in raster order (dy outer asc, dx inner asc).
    var s0 = textureLoad(in0, c + vec2<i32>(-1, -1), 0);
    var s1 = textureLoad(in0, c + vec2<i32>( 0, -1), 0);
    var s2 = textureLoad(in0, c + vec2<i32>( 1, -1), 0);
    var s3 = textureLoad(in0, c + vec2<i32>(-1,  0), 0);
    var s4 = textureLoad(in0, c + vec2<i32>( 0,  0), 0);
    var s5 = textureLoad(in0, c + vec2<i32>( 1,  0), 0);
    var s6 = textureLoad(in0, c + vec2<i32>(-1,  1), 0);
    var s7 = textureLoad(in0, c + vec2<i32>( 0,  1), 0);
    var s8 = textureLoad(in0, c + vec2<i32>( 1,  1), 0);
    // 19-comparator median-of-9 selection network. Each line is a
    // componentwise compare-exchange (lo := min, hi := max).
    var lo : vec4<f32>;
    var hi : vec4<f32>;
    lo = min(s1, s2); hi = max(s1, s2); s1 = lo; s2 = hi;
    lo = min(s4, s5); hi = max(s4, s5); s4 = lo; s5 = hi;
    lo = min(s7, s8); hi = max(s7, s8); s7 = lo; s8 = hi;
    lo = min(s0, s1); hi = max(s0, s1); s0 = lo; s1 = hi;
    lo = min(s3, s4); hi = max(s3, s4); s3 = lo; s4 = hi;
    lo = min(s6, s7); hi = max(s6, s7); s6 = lo; s7 = hi;
    lo = min(s1, s2); hi = max(s1, s2); s1 = lo; s2 = hi;
    lo = min(s4, s5); hi = max(s4, s5); s4 = lo; s5 = hi;
    lo = min(s7, s8); hi = max(s7, s8); s7 = lo; s8 = hi;
    lo = min(s0, s3); hi = max(s0, s3); s0 = lo; s3 = hi;
    lo = min(s5, s8); hi = max(s5, s8); s5 = lo; s8 = hi;
    lo = min(s4, s7); hi = max(s4, s7); s4 = lo; s7 = hi;
    lo = min(s3, s6); hi = max(s3, s6); s3 = lo; s6 = hi;
    lo = min(s1, s4); hi = max(s1, s4); s1 = lo; s4 = hi;
    lo = min(s2, s5); hi = max(s2, s5); s2 = lo; s5 = hi;
    lo = min(s4, s7); hi = max(s4, s7); s4 = lo; s7 = hi;
    lo = min(s4, s2); hi = max(s4, s2); s4 = lo; s2 = hi;
    lo = min(s6, s4); hi = max(s6, s4); s6 = lo; s4 = hi;
    lo = min(s4, s2); hi = max(s4, s2); s4 = lo; s2 = hi;
    let result = s4;
    let center = textureLoad(in0, c, 0);
    let m = textureLoad(mask, xy, 0).r;
    textureStore(outp, xy, mix(center, result, vec4<f32>(m)));
}
";

// ──────────────────────────── despeckle ────────────────────────────

/// Despeckle params: the edge gate and the strength blend.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, ::bytemuck::Pod, ::bytemuck::Zeroable)]
pub struct RankDespeckleParams {
    /// Inner-range (rank-8 minus rank-2 of 9) at or below which the
    /// window counts as flat-plus-noise rather than an edge.
    pub edge_threshold: f32,
    /// 0 = identity, 1 = the median wherever the gate is open.
    pub amount: f32,
    pub _abi_pad: u32,
}

#[allow(clippy::new_without_default)]
impl RankDespeckleParams {
    pub fn new(edge_threshold: f32, amount: f32) -> Self {
        Self {
            edge_threshold,
            amount,
            _abi_pad: 0,
        }
    }

    pub fn as_bytes(&self) -> &[u8] {
        ::bytemuck::bytes_of(self)
    }
}

/// DESPECKLE — the 3×3 median, but only where the neighbourhood is
/// flat-plus-noise. A plain median softens every edge it crosses:
/// straddle an edge and the middle sample of the window is a compromise
/// between the two sides, so the edge moves. Photoshop's Despeckle is
/// specified the other way round — detect the edges, blur everything
/// else — so the detector IS the kernel; the smoothing behind it is
/// just `rank.median3`.
///
/// The detector is the window's INNER range: the distance between the
/// rank-8 and the rank-2 sample of 9 (`s[7] - s[1]` once sorted), i.e.
/// the range with the two most extreme samples dropped from each end.
/// That choice is the whole point. A speckle is BY CONSTRUCTION an
/// extreme of its window, so it inflates the full range (max − min)
/// while leaving the inner range untouched; a real edge puts three or
/// more samples on each side of the step, so it shows up in the inner
/// range too. Gating on the full range instead would make the filter
/// refuse to touch precisely the pixels it exists to fix — which is why
/// the two dropped ranks are not a robustness detail but the mechanism.
/// The size of the trim is also the size of the claim: ONE rank is
/// dropped per end, so a lone outlier is invisible to the gate, while
/// TWO outliers on the same side of the window are not — the gate shuts
/// and the centre is preserved. That is the conservative failure, and it
/// is the right one for a filter whose entire job is to leave detail
/// alone.
///
/// So: inner range ≤ `edge_threshold` ⇒ the only variation present is
/// at noise scale ⇒ substitute the median; otherwise the centre
/// survives untouched. Per channel, like every rank filter here.
///
/// Both ends of `edge_threshold` are meaningful: 0 fires only where the
/// middle seven samples are identical (pure impulse removal), and a
/// threshold at or above the data range opens the gate everywhere, so at
/// `amount = 1` it degrades to `rank.median3` — the exact behaviour this
/// kernel exists to avoid, reachable on purpose. (Degrades to it within
/// tolerance, not bit-for-bit: the median still travels through the lerp
/// below, which is why this kernel is not `Tolerance::Exact`.)
///
/// IDENTITY: `amount = 0`. The output is `mix(center, …, 0)`, which is
/// `center` bit-for-bit for every texel and every mask value (the ABI
/// epilogue's `mix(center, center, m)` is likewise exactly `center`).
/// The window is fixed at 3×3, so there is no radius-0 identity here;
/// that one belongs to `rank.dust_scratches`.
///
/// NOT `Tolerance::Exact`: at an `amount` strictly between 0 and 1 the
/// output is a lerp, not one of the input samples. The GATE decision
/// stays bit-identical across lanes — it compares a difference of two
/// f16-quantized samples, computed the same way in WGSL and in the Rust
/// twin — so the lanes never disagree about WHICH branch a texel takes
/// (which no ULP tolerance could have covered); only the lerp needs the
/// tolerance, and 2 f16 ULPs is the rounding of one multiply-add.
pub static RANK_DESPECKLE: KernelDef = KernelDef {
    id: "rank.despeckle",
    class: KernelClass::Windowed { radius: (1, 1) },
    inputs: 1,
    params: ParamsLayout {
        size: ::core::mem::size_of::<RankDespeckleParams>(),
        fields: &[
            ParamField {
                name: "edge_threshold",
                wgsl_ty: "f32",
            },
            ParamField {
                name: "amount",
                wgsl_ty: "f32",
            },
        ],
    },
    wgsl: RANK_DESPECKLE_WGSL,
    module: true,
    mip_exact: false,
    gpu_tolerance: Tolerance::ChannelEpsF16(2),
};

// The 9 taps are loaded in the family's raster order (dy outer
// ascending, dx inner ascending) and then FULLY sorted, because this
// kernel needs ranks 1, 4 and 7 — not just the median, which is all the
// 19-comparator network above produces. The sort is a fixed bubble
// schedule (36 compare-exchanges): being data-oblivious it IS a sorting
// network, so it sorts every channel independently and correctly by
// construction, and at n = 9 the 11 comparators it spends over the
// optimal 25-comparator network cost nothing measurable — correctness
// by construction beats a hand-transcribed optimal network.
const RANK_DESPECKLE_WGSL: &str = "\
// paged.image kernel `rank.despeckle` — handwritten under ABI v1.1.
// AGPL-3.0-only OR LicenseRef-PMEL; (c) And The Next GmbH.

struct Params {
    edge_threshold: f32,
    amount: f32,
    _abi_pad: u32,
}

@group(0) @binding(0) var in0 : texture_2d<f32>;
@group(1) @binding(0) var<uniform> params : Params;
@group(2) @binding(0) var mask : texture_2d<f32>;
@group(3) @binding(0) var outp : texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
    let dims = textureDimensions(outp);
    if (gid.x >= dims.x || gid.y >= dims.y) { return; }
    let xy = vec2<i32>(i32(gid.x), i32(gid.y));
    // Window center: output (x, y) maps to in0 (x + 1, y + 1).
    let c = xy + vec2<i32>(1, 1);
    // 9 taps in raster order (dy outer asc, dx inner asc).
    var s : array<vec4<f32>, 9>;
    s[0] = textureLoad(in0, c + vec2<i32>(-1, -1), 0);
    s[1] = textureLoad(in0, c + vec2<i32>( 0, -1), 0);
    s[2] = textureLoad(in0, c + vec2<i32>( 1, -1), 0);
    s[3] = textureLoad(in0, c + vec2<i32>(-1,  0), 0);
    s[4] = textureLoad(in0, c + vec2<i32>( 0,  0), 0);
    s[5] = textureLoad(in0, c + vec2<i32>( 1,  0), 0);
    s[6] = textureLoad(in0, c + vec2<i32>(-1,  1), 0);
    s[7] = textureLoad(in0, c + vec2<i32>( 0,  1), 0);
    s[8] = textureLoad(in0, c + vec2<i32>( 1,  1), 0);
    // Full sort — a fixed (data-oblivious) bubble schedule, so each
    // componentwise compare-exchange sorts all four channels at once.
    for (var i = 0; i < 8; i = i + 1) {
        for (var j = 0; j < 8 - i; j = j + 1) {
            let lo = min(s[j], s[j + 1]);
            let hi = max(s[j], s[j + 1]);
            s[j] = lo;
            s[j + 1] = hi;
        }
    }
    let med = s[4];
    // INNER range: rank 8 minus rank 2 (0-indexed 7 and 1) — the range
    // with the two extremes dropped from each end. An impulse inflates
    // max - min but not this; a real edge inflates this too.
    let spread = s[7] - s[1];
    // A range is non-negative, so a negative threshold would only add a
    // second, silent identity; clamp it to one well-defined floor.
    let t = max(params.edge_threshold, 0.0);
    let flat = spread <= vec4<f32>(t);
    let center = textureLoad(in0, c, 0);
    let smoothed = mix(center, med, clamp(params.amount, 0.0, 1.0));
    // Componentwise: a channel with a quiet neighbourhood is smoothed
    // even if another channel of the same texel is sitting on an edge.
    let result = select(center, smoothed, flat);
    let m = textureLoad(mask, xy, 0).r;
    textureStore(outp, xy, mix(center, result, vec4<f32>(m)));
}
";

// ───────────────────────── dust & scratches ────────────────────────

/// Compile-time MAX Dust & Scratches radius — the windowed ROI bound
/// (§8.3) AND the honest limit of the selection method (see
/// [`RANK_DUST_SCRATCHES`] for why it is 4 and not larger).
pub const DUST_SCRATCHES_MAX_RADIUS: u16 = 4;

/// Dust & Scratches params: the window radius (clamped ≤ 4) and the
/// difference a centre must clear before its median replaces it.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, ::bytemuck::Pod, ::bytemuck::Zeroable)]
pub struct RankDustScratchesParams {
    pub radius: u32,
    pub threshold: f32,
    pub _abi_pad: u32,
}

#[allow(clippy::new_without_default)]
impl RankDustScratchesParams {
    pub fn new(radius: u32, threshold: f32) -> Self {
        Self {
            radius,
            threshold,
            _abi_pad: 0,
        }
    }

    pub fn as_bytes(&self) -> &[u8] {
        ::bytemuck::bytes_of(self)
    }
}

/// DUST & SCRATCHES — median substitution under a threshold. Take the
/// median of the (2r+1)² neighbourhood and write it over the centre
/// ONLY where `|centre − median| > threshold`. A dust speck or a
/// scratch is an outlier against its surroundings, so it clears the
/// threshold and is replaced; ordinary detail sits close to its own
/// median and is left exactly alone. The threshold is the entire
/// difference between this and a destructive blanket median — it is
/// what lets the radius be raised far enough to swallow a scratch
/// without the rest of the image paying for it.
///
/// IDENTITY: `threshold = 1.0`. Channel values live in [0, 1], so
/// `|centre − median| ≤ 1` always, and the comparison is STRICT `>` —
/// the centre is written back bit-for-bit everywhere. `radius = 0` is a
/// second identity: a one-tap window's median is the centre itself, so
/// the difference is 0 and no threshold ≥ 0 can be exceeded. At the
/// other end, `threshold = 0` replaces every centre that differs from
/// its median at all: a plain median filter.
/// HONEST CAVEAT on the first identity: on scene-referred data outside
/// [0, 1] a difference CAN exceed 1, and then 1.0 is a real threshold
/// rather than an off switch. That is the correct reading of a
/// threshold expressed in the units of the data, not a bug — callers
/// wanting an unconditional off switch should use `radius = 0`.
///
/// RADIUS BOUND = 4 (a 9×9, 81-tap window), and the reason is the
/// selection method, not taste. A median is an order statistic, and the
/// fixed comparator network `rank.median3` uses does not generalize: a
/// sorting network's shape is straight-line code, so it cannot depend on
/// a runtime radius, and one for 81 inputs would be hundreds of
/// comparators. What DOES work at runtime radius is COUNT-BELOW
/// selection: for each candidate tap count how many taps are below it
/// and how many are at-or-below it; the median is the candidate whose
/// rank interval brackets ⌊n/2⌋. That is EXACT — no histogram, no
/// bucketing, no approximation — but it is O(n²) in taps, so the cost
/// is (2r+1)⁴: 81 iterations at r = 1, 6 561 at r = 4, and 390 625 at
/// r = 12. Four is where the quadratic stops being honest work. A
/// larger radius needs a histogram (or a separable) method, and that is
/// a different kernel rather than a bigger loop bound here — so this
/// kernel does not pretend to offer it. The shader CLAMPS `radius` to
/// the bound instead of misbehaving: an over-large request degrades to
/// r = 4 rather than sampling outside the ROI it was given.
///
/// Note the loop bounds are the RUNTIME radius, not the bound: r = 1
/// (the common case) pays 81 iterations, not 6 561. Only the ROI —
/// `in0` expanded by 4 on every side — is fixed, because ROI planning
/// happens before the params are known.
///
/// `Tolerance::Exact`: both branches write an existing f16 sample —
/// the centre, or the median, which count-below SELECTS rather than
/// averages. The only arithmetic is the decision
/// `abs(centre − median) > threshold`, computed identically on both
/// lanes from the same f16-quantized inputs.
pub static RANK_DUST_SCRATCHES: KernelDef = KernelDef {
    id: "rank.dust_scratches",
    class: KernelClass::Windowed {
        radius: (DUST_SCRATCHES_MAX_RADIUS, DUST_SCRATCHES_MAX_RADIUS),
    },
    inputs: 1,
    params: ParamsLayout {
        size: ::core::mem::size_of::<RankDustScratchesParams>(),
        fields: &[
            ParamField {
                name: "radius",
                wgsl_ty: "u32",
            },
            ParamField {
                name: "threshold",
                wgsl_ty: "f32",
            },
        ],
    },
    wgsl: RANK_DUST_SCRATCHES_WGSL,
    module: true,
    mip_exact: false,
    gpu_tolerance: Tolerance::Exact,
};

// in0 = out + 2·(4, 4); output (x, y) ↔ window center (x + 4, y + 4).
// Both the candidate scan and the counting scan run dy outer ascending,
// dx inner ascending (the family's fixed reduction order); the counts
// are integers held in f32, exact up to 81, so the order cannot change
// a count — it is fixed anyway so the Rust twin can mirror it (§6.3).
const RANK_DUST_SCRATCHES_WGSL: &str = "\
// paged.image kernel `rank.dust_scratches` — handwritten under ABI v1.1.
// AGPL-3.0-only OR LicenseRef-PMEL; (c) And The Next GmbH.

struct Params {
    radius: u32,
    threshold: f32,
    _abi_pad: u32,
}

@group(0) @binding(0) var in0 : texture_2d<f32>;
@group(1) @binding(0) var<uniform> params : Params;
@group(2) @binding(0) var mask : texture_2d<f32>;
@group(3) @binding(0) var outp : texture_storage_2d<rgba16float, write>;

// The ROI bound: in0 is ALWAYS the output region expanded by this in
// both axes, so taps for any clamped radius stay inside the window.
const R_MAX : i32 = 4;

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
    let dims = textureDimensions(outp);
    if (gid.x >= dims.x || gid.y >= dims.y) { return; }
    let xy = vec2<i32>(i32(gid.x), i32(gid.y));
    // Window center: in0 expanded by the fixed MAX radius 4 in x and y.
    let c = xy + vec2<i32>(R_MAX, R_MAX);
    let center = textureLoad(in0, c, 0);
    // CLAMP rather than trust: an over-large radius degrades to the ROI
    // bound instead of reading outside the window we were handed.
    let r = i32(min(params.radius, u32(R_MAX)));
    // n is odd, so the median is the single rank-k sample with
    // k = n / 2 (integer division, 0-indexed): 4 of 9, 40 of 81.
    let n = (2 * r + 1) * (2 * r + 1);
    let k = f32(n / 2);
    // COUNT-BELOW SELECTION. `med` starts at the centre so that a
    // window containing NaN — where every IEEE comparison is false, so
    // no candidate can qualify — deterministically preserves the centre
    // on BOTH lanes instead of leaving the result undefined.
    var med = center;
    for (var cy = -r; cy <= r; cy = cy + 1) {
        for (var cx = -r; cx <= r; cx = cx + 1) {
            let cand = textureLoad(in0, c + vec2<i32>(cx, cy), 0);
            var lt = vec4<f32>(0.0);
            var le = vec4<f32>(0.0);
            for (var dy = -r; dy <= r; dy = dy + 1) {
                for (var dx = -r; dx <= r; dx = dx + 1) {
                    let s = textureLoad(in0, c + vec2<i32>(dx, dy), 0);
                    lt = lt + select(vec4<f32>(0.0), vec4<f32>(1.0), s < cand);
                    le = le + select(vec4<f32>(0.0), vec4<f32>(1.0), s <= cand);
                }
            }
            // #below <= k < #at-or-below  <=>  cand IS the rank-k value.
            // Ties are harmless: every candidate that qualifies holds
            // the SAME value (that is exactly what the bracket asserts),
            // so which one wins the select cannot change the result.
            let hit = (lt <= vec4<f32>(k)) & (le > vec4<f32>(k));
            med = select(med, cand, hit);
        }
    }
    // Substitute only where the centre is an outlier against its own
    // median. STRICT `>` is what makes threshold 1.0 the identity for
    // [0, 1] data (see the doc comment).
    let t = max(params.threshold, 0.0);
    let outlier = abs(center - med) > vec4<f32>(t);
    let result = select(center, med, outlier);
    let m = textureLoad(mask, xy, 0).r;
    textureStore(outp, xy, mix(center, result, vec4<f32>(m)));
}
";

// ─────────────────── runtime-radius max / min / median ───────────────────
//
// Filter ▸ Other ▸ Maximum / Minimum and Filter ▸ Noise ▸ Median with a
// RADIUS, as Photoshop has them (the 3×3 kernels above are their r = 1
// case and stay, because a fixed comparator network is the cheapest
// exact 3×3 median). One params block for the three: the radius (the
// shader clamps it to the class bound, so an over-large request
// degrades to the bound rather than reading outside the window) and the
// neighbourhood SHAPE — 0 square (Photoshop's "Squareness"), 1 round
// (a disc: taps with dx² + dy² ≤ r², Photoshop's "Roundness").
//
// The halo is DERIVED from the bound textures (`(in0 − out) / 2`), as
// `conv.bilateral` does, so each kernel is right under the windowed
// dispatcher (halo = class radius) and the one-shot one (halo 0, taps
// clamped to the edge) alike. Taps are clamped into the window: the
// edge pixel repeats, which is the convolution edge rule everywhere in
// this family.
//
// Radius 0 is the identity for all three (a one-tap neighbourhood).

/// Compile-time MAX radius of `morph.dilate_r` / `morph.erode_r` — the
/// windowed ROI bound (§8.3). The cost is (2r + 1)² loads per texel,
/// 4 225 at the bound: a max/min is one compare per tap, so that stays
/// interactive on a GPU where a sorting method would not.
pub const MORPH_MAX_RADIUS: u16 = 32;

/// Compile-time MAX radius of `rank.median_r`. The median costs one
/// pass per bisection step over the (2r + 1)² taps (see
/// [`RANK_MEDIAN_R`]); 33 passes over 441 taps at the bound.
pub const MEDIAN_MAX_RADIUS: u16 = 10;

/// Bisection steps of `rank.median_r` — enough that the bracket is
/// narrower than the f16 spacing anywhere in a ±256 range, which is
/// what makes the final selection exact (see [`RANK_MEDIAN_R`]).
pub const MEDIAN_BISECTION_STEPS: u32 = 32;

/// `morph.dilate_r` / `morph.erode_r` / `rank.median_r` params.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, ::bytemuck::Pod, ::bytemuck::Zeroable)]
pub struct MorphRadiusParams {
    /// Neighbourhood radius in px (clamped to the kernel's bound).
    pub radius: u32,
    /// 0 = square neighbourhood, 1 = round (a disc).
    pub round: u32,
    pub _pad0: u32,
    pub _abi_pad: u32,
}

impl MorphRadiusParams {
    pub fn new(radius: u32, round: bool) -> Self {
        Self {
            radius,
            round: u32::from(round),
            _pad0: 0,
            _abi_pad: 0,
        }
    }

    pub fn as_bytes(&self) -> &[u8] {
        ::bytemuck::bytes_of(self)
    }
}

const MORPH_RADIUS_FIELDS: &[ParamField] = &[
    ParamField {
        name: "radius",
        wgsl_ty: "u32",
    },
    ParamField {
        name: "round",
        wgsl_ty: "u32",
    },
    ParamField {
        name: "_pad0",
        wgsl_ty: "u32",
    },
    ParamField {
        name: "_abi_pad",
        wgsl_ty: "u32",
    },
];

/// Filter ▸ Other ▸ MAXIMUM at a radius: per-channel max over the
/// square (or round) neighbourhood. Exact — `max` selects an existing
/// f16 sample.
pub static MORPH_DILATE_R: KernelDef = KernelDef {
    id: "morph.dilate_r",
    class: KernelClass::Windowed {
        radius: (MORPH_MAX_RADIUS, MORPH_MAX_RADIUS),
    },
    inputs: 1,
    params: ParamsLayout {
        size: ::core::mem::size_of::<MorphRadiusParams>(),
        fields: MORPH_RADIUS_FIELDS,
    },
    wgsl: MORPH_DILATE_R_WGSL,
    module: true,
    mip_exact: false,
    gpu_tolerance: Tolerance::Exact,
};

/// Filter ▸ Other ▸ MINIMUM at a radius: per-channel min, as
/// [`MORPH_DILATE_R`]. Exact.
pub static MORPH_ERODE_R: KernelDef = KernelDef {
    id: "morph.erode_r",
    class: KernelClass::Windowed {
        radius: (MORPH_MAX_RADIUS, MORPH_MAX_RADIUS),
    },
    inputs: 1,
    params: ParamsLayout {
        size: ::core::mem::size_of::<MorphRadiusParams>(),
        fields: MORPH_RADIUS_FIELDS,
    },
    wgsl: MORPH_ERODE_R_WGSL,
    module: true,
    mip_exact: false,
    gpu_tolerance: Tolerance::Exact,
};

/// The shared body of the two runtime-radius morphology modules; `OP`
/// is replaced by `max` or `min`. Reduction order: dy outer ascending,
/// dx inner ascending, seeded with the centre (max/min are order-free
/// over reals, but the order is fixed so the twin mirrors it).
macro_rules! morph_r_wgsl {
    ($id:literal, $op:literal) => {
        concat!(
            "// paged.image kernel `",
            $id,
            "` — handwritten under ABI v1.1.
// AGPL-3.0-only OR LicenseRef-PMEL; (c) And The Next GmbH.

struct Params {
    radius: u32,
    round: u32,
    _pad0: u32,
    _abi_pad: u32,
}

@group(0) @binding(0) var in0 : texture_2d<f32>;
@group(1) @binding(0) var<uniform> params : Params;
@group(2) @binding(0) var mask : texture_2d<f32>;
@group(3) @binding(0) var outp : texture_storage_2d<rgba16float, write>;

const R_MAX : u32 = 32u;

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
    let d = textureDimensions(outp);
    if (gid.x >= d.x || gid.y >= d.y) { return; }
    let xy = vec2<i32>(i32(gid.x), i32(gid.y));
    let wd = textureDimensions(in0);
    let win = vec2<i32>(i32(wd.x), i32(wd.y));
    let halo = (win - vec2<i32>(i32(d.x), i32(d.y))) / 2;
    let base = xy + halo;
    let center = textureLoad(in0, base, 0);
    let r = i32(min(params.radius, R_MAX));
    var acc = center;
    for (var dy = -r; dy <= r; dy = dy + 1) {
        for (var dx = -r; dx <= r; dx = dx + 1) {
            if (params.round != 0u && dx * dx + dy * dy > r * r) { continue; }
            let c = clamp(base + vec2<i32>(dx, dy), vec2<i32>(0, 0), win - vec2<i32>(1, 1));
            acc = ",
            $op,
            "(acc, textureLoad(in0, c, 0));
        }
    }
    let m = textureLoad(mask, xy, 0).r;
    textureStore(outp, xy, mix(center, acc, vec4<f32>(m)));
}
"
        )
    };
}

const MORPH_DILATE_R_WGSL: &str = morph_r_wgsl!("morph.dilate_r", "max");
const MORPH_ERODE_R_WGSL: &str = morph_r_wgsl!("morph.erode_r", "min");

/// Filter ▸ Noise ▸ MEDIAN at a radius: the per-channel median of the
/// square (or round) neighbourhood.
///
/// THE METHOD. A comparator network cannot take a runtime radius and
/// count-below selection (`rank.dust_scratches`) is O(n²) in taps, so
/// this BISECTS ON THE VALUE instead. With `k = ⌊n/2⌋` (0-indexed) the
/// median is the smallest sample `m` with `#(s ≤ m) > k`. Start from
/// `lo = min`, `hi = max` (if `#(s ≤ lo) > k` the median IS the
/// minimum); keep `#(s ≤ lo) ≤ k < #(s ≤ hi)` while halving the bracket
/// for [`MEDIAN_BISECTION_STEPS`] steps, one counting pass each. Then
/// the median is the smallest sample above `lo`: after 32 halvings the
/// bracket is narrower than the spacing of f16 values anywhere in a
/// ±256 range, so no sample other than the median fits between `lo` and
/// it. The result is therefore an EXISTING sample — the tolerance is
/// `Exact` — at a cost of 33 passes over the taps (14 553 loads per
/// texel at r = 10) instead of (2r + 1)⁴.
///
/// All four channels bisect at once (vec4 brackets, componentwise
/// selects), so the loads are shared.
pub static RANK_MEDIAN_R: KernelDef = KernelDef {
    id: "rank.median_r",
    class: KernelClass::Windowed {
        radius: (MEDIAN_MAX_RADIUS, MEDIAN_MAX_RADIUS),
    },
    inputs: 1,
    params: ParamsLayout {
        size: ::core::mem::size_of::<MorphRadiusParams>(),
        fields: MORPH_RADIUS_FIELDS,
    },
    wgsl: RANK_MEDIAN_R_WGSL,
    module: true,
    mip_exact: false,
    gpu_tolerance: Tolerance::Exact,
};

const RANK_MEDIAN_R_WGSL: &str = "\
// paged.image kernel `rank.median_r` — handwritten under ABI v1.1.
// AGPL-3.0-only OR LicenseRef-PMEL; (c) And The Next GmbH.

struct Params {
    radius: u32,
    round: u32,
    _pad0: u32,
    _abi_pad: u32,
}

@group(0) @binding(0) var in0 : texture_2d<f32>;
@group(1) @binding(0) var<uniform> params : Params;
@group(2) @binding(0) var mask : texture_2d<f32>;
@group(3) @binding(0) var outp : texture_storage_2d<rgba16float, write>;

const R_MAX : u32 = 10u;
const STEPS : i32 = 32;

var<private> g_base : vec2<i32>;
var<private> g_win : vec2<i32>;
var<private> g_r : i32;

fn inside(dx: i32, dy: i32) -> bool {
    return params.round == 0u || dx * dx + dy * dy <= g_r * g_r;
}

fn tap(dx: i32, dy: i32) -> vec4<f32> {
    let c = clamp(g_base + vec2<i32>(dx, dy), vec2<i32>(0, 0), g_win - vec2<i32>(1, 1));
    return textureLoad(in0, c, 0);
}

/// #(s <= t) per channel over the neighbourhood.
fn count_le(t: vec4<f32>) -> vec4<f32> {
    var n = vec4<f32>(0.0);
    for (var dy = -g_r; dy <= g_r; dy = dy + 1) {
        for (var dx = -g_r; dx <= g_r; dx = dx + 1) {
            if (!inside(dx, dy)) { continue; }
            n = n + select(vec4<f32>(0.0), vec4<f32>(1.0), tap(dx, dy) <= t);
        }
    }
    return n;
}

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
    let d = textureDimensions(outp);
    if (gid.x >= d.x || gid.y >= d.y) { return; }
    let xy = vec2<i32>(i32(gid.x), i32(gid.y));
    let wd = textureDimensions(in0);
    g_win = vec2<i32>(i32(wd.x), i32(wd.y));
    g_base = xy + (g_win - vec2<i32>(i32(d.x), i32(d.y))) / 2;
    g_r = i32(min(params.radius, R_MAX));
    let center = textureLoad(in0, g_base, 0);

    // Pass 0: the bracket and the tap count.
    var lo = center;
    var hi = center;
    var n = 0.0;
    for (var dy = -g_r; dy <= g_r; dy = dy + 1) {
        for (var dx = -g_r; dx <= g_r; dx = dx + 1) {
            if (!inside(dx, dy)) { continue; }
            let s = tap(dx, dy);
            lo = min(lo, s);
            hi = max(hi, s);
            n = n + 1.0;
        }
    }
    let k = vec4<f32>(floor(n * 0.5));
    let lo0 = lo;
    let at_min = count_le(lo) > k;

    for (var i = 0; i < STEPS; i = i + 1) {
        let mid = (lo + hi) * 0.5;
        let up = count_le(mid) > k;
        hi = select(hi, mid, up);
        lo = select(mid, lo, up);
    }

    // The smallest sample above `lo` is the median.
    var med = hi;
    for (var dy = -g_r; dy <= g_r; dy = dy + 1) {
        for (var dx = -g_r; dx <= g_r; dx = dx + 1) {
            if (!inside(dx, dy)) { continue; }
            let s = tap(dx, dy);
            med = select(med, min(med, s), s > lo);
        }
    }
    let result = select(med, lo0, at_min);
    let m = textureLoad(mask, xy, 0).r;
    textureStore(outp, xy, mix(center, result, vec4<f32>(m)));
}
";

pub static FAMILY: &[&KernelDef] = &[
    &MORPH_DILATE,
    &MORPH_ERODE,
    &RANK_MEDIAN3,
    &RANK_DESPECKLE,
    &RANK_DUST_SCRATCHES,
    &MORPH_DILATE_R,
    &MORPH_ERODE_R,
    &RANK_MEDIAN_R,
];
