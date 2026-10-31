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

//! style family — the kernels Photoshop's LAYER STYLES are drawn with
//! (WP5.4). They make COVERAGE (how much of an effect a texel gets) out of
//! a layer's alpha; the compose kernels then blend each effect's colour
//! through that coverage. All twelve run over whole canvas-sized
//! textures in the layer fold (`GpuBatch`), so each reads `in0` at the
//! output's own coordinates and treats texels beyond the canvas
//! explicitly (`outside`, or clamped where noted) — none relies on a
//! dispatcher's halo, so the ones that read neighbours are declared
//! `Resample` (the whole source window), not `Windowed`. Each honours the
//! ABI's selection mask like any module (`mix(in0, result, m)`); the fold
//! binds the constant-1 mask.
//!
//! * `style.shift` — one channel moved by a (sub-pixel) offset, bilinear,
//!   optionally inverted: the offset of a drop/inner shadow and a satin.
//! * `style.blur_h` / `style.blur_v` — a separable Gaussian with a
//!   runtime radius up to [`STYLE_MAX_BLUR_RADIUS`]: the softness of
//!   shadows, glows, satin and a smooth bevel's height.
//! * `style.jfa_seed`, `style.jfa_step`, `style.distance` — a SIGNED
//!   DISTANCE FIELD of the layer's edge by jump flooding (Rong & Tan,
//!   "Jump flooding in GPU with applications to Voronoi diagram and
//!   distance transform", I3D 2006): both the outside distance (to the
//!   nearest inside texel) and the inside one, in one rgba texture, then
//!   combined with the coverage: an anti-aliased edge texel takes its
//!   distance from its own coverage (`0.5 − c`), any other the distance
//!   to its nearest seed corrected by where the edge lies inside that
//!   seed (the seed's coverage), which keeps a curve's anti-aliasing. Spread, choke, stroke,
//!   the precise glow and the chisel bevels read it.
//! * `style.ramp` — coverage from a signed distance: a band between two
//!   offsets (a stroke, a dilation) or a linear falloff (a precise glow,
//!   a chisel bevel's height).
//! * `style.contour` — a CONTOUR: a 256-entry curve (interpolated), after
//!   a range remap, optionally inverted.
//! * `style.colorize` — coverage to a premultiplied colour: a 256-entry
//!   RGBA lookup (one colour, or a gradient across the falloff or along a
//!   gradient's parameter), with NOISE (alpha) and JITTER (gradient
//!   position) from a hashed integer stream.
//! * `style.bevel` — Lambert shading of a height field lit from an
//!   azimuth and altitude (surface normal from central differences).
//! * `style.split` — shading into the highlight (above the flat
//!   surface's shade) and the shadow (below it).
//! * `style.absdiff` — `|a − b|`, satin's two shifted copies.
//!
//! Each kernel's scalar twin is in [`reference`] (feature `reference`,
//! test-only): the same arithmetic in the same order, held to the
//! kernel's declared tolerance by `image-conformance/tests/it/family_style.rs`.
//!
//! Provenance: the effects' parameters and what they mean follow Adobe's
//! Photoshop User Guide ("Layer effects and styles", "Layer style
//! options") and the shapes Photoshop 27.10 draws for each
//! (`image-conformance/fixtures/photoshop/layer-styles/`); jump flooding
//! from the paper above; Lambert shading and the Gaussian are textbook.
//! No reference implementation was read.

use crate::{KernelClass, KernelDef, ParamField, ParamsLayout, Tolerance};

/// Largest blur radius (taps each side) `style.blur_*` honour.
pub const STYLE_MAX_BLUR_RADIUS: u32 = 1024;

/// The "no seed" distance of the jump flood (exact in f16).
pub const JFA_FAR: f32 = 2048.0;

macro_rules! style_params {
    ($(#[$m:meta])* $name:ident, $fields:ident { $($f:ident : $t:ty => $w:literal),* $(,)? }) => {
        $(#[$m])*
        #[repr(C)]
        #[derive(Debug, Clone, Copy, PartialEq, ::bytemuck::Pod, ::bytemuck::Zeroable)]
        pub struct $name {
            $(pub $f: $t,)*
            pub _abi_pad: u32,
        }

        impl $name {
            pub fn as_bytes(&self) -> &[u8] {
                ::bytemuck::bytes_of(self)
            }
        }

        const $fields: &[ParamField] = &[
            $(ParamField { name: stringify!($f), wgsl_ty: $w },)*
            ParamField { name: "_abi_pad", wgsl_ty: "u32" },
        ];
    };
}

const fn def(
    id: &'static str,
    class: KernelClass,
    inputs: u8,
    size: usize,
    fields: &'static [ParamField],
    wgsl: &'static str,
    tolerance: Tolerance,
) -> KernelDef {
    KernelDef {
        id,
        class,
        inputs,
        params: ParamsLayout { size, fields },
        wgsl,
        module: true,
        mip_exact: false,
        gpu_tolerance: tolerance,
    }
}

// ───────────────────────────── shift ─────────────────────────────

style_params!(
    /// `style.shift`: take `channel` (0–3) at `(x − dx, y − dy)`, bilinear,
    /// `outside` beyond the canvas; `invert` returns `1 − v`.
    StyleShiftParams, SHIFT_FIELDS {
        dx: f32 => "f32", dy: f32 => "f32", invert: u32 => "u32", channel: u32 => "u32", outside: f32 => "f32",
    }
);

impl StyleShiftParams {
    pub fn new(dx: f32, dy: f32, channel: u32, invert: bool, outside: f32) -> Self {
        Self {
            dx,
            dy,
            invert: u32::from(invert),
            channel,
            outside,
            _abi_pad: 0,
        }
    }
}

pub static STYLE_SHIFT: KernelDef = def(
    "style.shift",
    KernelClass::Resample { support: 1.0 },
    1,
    core::mem::size_of::<StyleShiftParams>(),
    SHIFT_FIELDS,
    r#"// paged.image kernel `style.shift` — handwritten under ABI v1.1.
// AGPL-3.0-only OR LicenseRef-PMEL; (c) And The Next GmbH.
struct Params {
    dx: f32,
    dy: f32,
    invert: u32,
    channel: u32,
    outside: f32,
    _abi_pad: u32,
}

@group(0) @binding(0) var in0 : texture_2d<f32>;
@group(1) @binding(0) var<uniform> params : Params;
@group(2) @binding(0) var mask : texture_2d<f32>;
@group(3) @binding(0) var outp : texture_storage_2d<rgba16float, write>;

fn tap(p: vec2<i32>, dims: vec2<i32>) -> f32 {
    if (p.x < 0 || p.y < 0 || p.x >= dims.x || p.y >= dims.y) { return params.outside; }
    return textureLoad(in0, p, 0)[params.channel];
}

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
    let d = textureDimensions(outp);
    if (gid.x >= d.x || gid.y >= d.y) { return; }
    let dims = vec2<i32>(i32(d.x), i32(d.y));
    let xy = vec2<i32>(i32(gid.x), i32(gid.y));
    let s = vec2<f32>(f32(xy.x) - params.dx, f32(xy.y) - params.dy);
    let b = floor(s);
    let f = s - b;
    let p = vec2<i32>(i32(b.x), i32(b.y));
    let top = mix(tap(p, dims), tap(p + vec2<i32>(1, 0), dims), f.x);
    let bot = mix(tap(p + vec2<i32>(0, 1), dims), tap(p + vec2<i32>(1, 1), dims), f.x);
    var v = mix(top, bot, f.y);
    if (params.invert != 0u) { v = 1.0 - v; }
    textureStore(outp, xy, mix(textureLoad(in0, xy, 0), vec4<f32>(v), vec4<f32>(textureLoad(mask, xy, 0).r)));
}
"#,
    Tolerance::ChannelEpsF16(4),
);

// ───────────────────────────── blur ─────────────────────────────

style_params!(
    /// `style.blur_*`: `kind` 0 — a Gaussian of `sigma` over `radius` taps
    /// each side; `kind` 1 — a BOX of fractional radius `sigma` (weight 1
    /// out to `floor(sigma)`, the fraction at the next tap). A texel beyond
    /// the canvas counts as `outside` in every channel (a negative
    /// `outside`: the nearest edge texel).
    StyleBlurParams, BLUR_FIELDS {
        sigma: f32 => "f32", radius: u32 => "u32", outside: f32 => "f32", kind: u32 => "u32",
    }
);

impl StyleBlurParams {
    /// A Gaussian of `sigma` over `radius` taps each side.
    pub fn new(sigma: f32, radius: u32, outside: f32) -> Self {
        Self {
            sigma,
            radius: radius.min(STYLE_MAX_BLUR_RADIUS),
            outside,
            kind: 0,
            _abi_pad: 0,
        }
    }

    /// A box of fractional radius `r`.
    pub fn boxed(r: f32, outside: f32) -> Self {
        let r = r.clamp(0.0, STYLE_MAX_BLUR_RADIUS as f32 - 1.0);
        Self {
            sigma: r,
            radius: r.floor() as u32 + 1,
            outside,
            kind: 1,
            _abi_pad: 0,
        }
    }

    /// The weight of tap `i`.
    pub fn weight(&self, i: i32) -> f32 {
        let fi = i as f32;
        if self.kind == 1 {
            let whole = self.sigma.floor();
            let a = fi.abs();
            if a <= whole {
                1.0
            } else if a <= whole + 1.0 {
                self.sigma - whole
            } else {
                0.0
            }
        } else {
            (-(fi * fi) / (2.0 * self.sigma * self.sigma)).exp()
        }
    }
}

pub static STYLE_BLUR_H: KernelDef = def(
    "style.blur_h",
    KernelClass::Resample { support: 1024.0 },
    1,
    core::mem::size_of::<StyleBlurParams>(),
    BLUR_FIELDS,
    r#"// paged.image kernel `style.blur_h` — handwritten under ABI v1.1.
// AGPL-3.0-only OR LicenseRef-PMEL; (c) And The Next GmbH.
struct Params {
    sigma: f32,
    radius: u32,
    outside: f32,
    kind: u32,
    _abi_pad: u32,
}

@group(0) @binding(0) var in0 : texture_2d<f32>;
@group(1) @binding(0) var<uniform> params : Params;
@group(2) @binding(0) var mask : texture_2d<f32>;
@group(3) @binding(0) var outp : texture_storage_2d<rgba16float, write>;

fn weight(i: i32) -> f32 {
    let fi = f32(i);
    if (params.kind == 1u) {
        let whole = floor(params.sigma);
        let a = abs(fi);
        if (a <= whole) { return 1.0; }
        if (a <= whole + 1.0) { return params.sigma - whole; }
        return 0.0;
    }
    return exp(-(fi * fi) / (2.0 * params.sigma * params.sigma));
}

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
    let d = textureDimensions(outp);
    if (gid.x >= d.x || gid.y >= d.y) { return; }
    let xy = vec2<i32>(i32(gid.x), i32(gid.y));
    let r = i32(min(params.radius, 1024u));
    if (r == 0 || params.sigma <= 0.0) {
        textureStore(outp, xy, textureLoad(in0, xy, 0));

        return;
    }
    var s = 0.0;
    var acc = vec4<f32>(0.0);
    for (var i = -r; i <= r; i = i + 1) {
        let w = weight(i);
        s = s + w;
        let p = xy + vec2<i32>(i, 0);
        var v = vec4<f32>(params.outside);
        if (p.x >= 0 && p.x < i32(d.x)) { v = textureLoad(in0, p, 0); }
        else if (params.outside < 0.0) { v = textureLoad(in0, clamp(p, vec2<i32>(0), vec2<i32>(i32(d.x) - 1, i32(d.y) - 1)), 0); }
        acc = acc + v * w;
    }
    textureStore(outp, xy, mix(textureLoad(in0, xy, 0), acc / s, vec4<f32>(textureLoad(mask, xy, 0).r)));
}
"#,
    Tolerance::ChannelEpsF16(8),
);

pub static STYLE_BLUR_V: KernelDef = def(
    "style.blur_v",
    KernelClass::Resample { support: 1024.0 },
    1,
    core::mem::size_of::<StyleBlurParams>(),
    BLUR_FIELDS,
    r#"// paged.image kernel `style.blur_v` — handwritten under ABI v1.1.
// AGPL-3.0-only OR LicenseRef-PMEL; (c) And The Next GmbH.
struct Params {
    sigma: f32,
    radius: u32,
    outside: f32,
    kind: u32,
    _abi_pad: u32,
}

@group(0) @binding(0) var in0 : texture_2d<f32>;
@group(1) @binding(0) var<uniform> params : Params;
@group(2) @binding(0) var mask : texture_2d<f32>;
@group(3) @binding(0) var outp : texture_storage_2d<rgba16float, write>;

fn weight(i: i32) -> f32 {
    let fi = f32(i);
    if (params.kind == 1u) {
        let whole = floor(params.sigma);
        let a = abs(fi);
        if (a <= whole) { return 1.0; }
        if (a <= whole + 1.0) { return params.sigma - whole; }
        return 0.0;
    }
    return exp(-(fi * fi) / (2.0 * params.sigma * params.sigma));
}

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
    let d = textureDimensions(outp);
    if (gid.x >= d.x || gid.y >= d.y) { return; }
    let xy = vec2<i32>(i32(gid.x), i32(gid.y));
    let r = i32(min(params.radius, 1024u));
    if (r == 0 || params.sigma <= 0.0) {
        textureStore(outp, xy, textureLoad(in0, xy, 0));

        return;
    }
    var s = 0.0;
    var acc = vec4<f32>(0.0);
    for (var i = -r; i <= r; i = i + 1) {
        let w = weight(i);
        s = s + w;
        let p = xy + vec2<i32>(0, i);
        var v = vec4<f32>(params.outside);
        if (p.y >= 0 && p.y < i32(d.y)) { v = textureLoad(in0, p, 0); }
        else if (params.outside < 0.0) { v = textureLoad(in0, clamp(p, vec2<i32>(0), vec2<i32>(i32(d.x) - 1, i32(d.y) - 1)), 0); }
        acc = acc + v * w;
    }
    textureStore(outp, xy, mix(textureLoad(in0, xy, 0), acc / s, vec4<f32>(textureLoad(mask, xy, 0).r)));
}
"#,
    Tolerance::ChannelEpsF16(8),
);

// ───────────────────────────── jump flood ─────────────────────────────

style_params!(
    /// `style.jfa_seed`: texels whose coverage (`.r`) is at least
    /// `threshold` seed the OUTSIDE field (`.xy`, the vector to the
    /// nearest inside texel), the others the INSIDE field (`.zw`).
    StyleJfaSeedParams, JFA_SEED_FIELDS { threshold: f32 => "f32" }
);

impl StyleJfaSeedParams {
    pub fn new(threshold: f32) -> Self {
        Self {
            threshold,
            _abi_pad: 0,
        }
    }
}

pub static STYLE_JFA_SEED: KernelDef = def(
    "style.jfa_seed",
    KernelClass::Point,
    1,
    core::mem::size_of::<StyleJfaSeedParams>(),
    JFA_SEED_FIELDS,
    r#"// paged.image kernel `style.jfa_seed` — handwritten under ABI v1.1.
// AGPL-3.0-only OR LicenseRef-PMEL; (c) And The Next GmbH.
struct Params {
    threshold: f32,
    _abi_pad: u32,
}

@group(0) @binding(0) var in0 : texture_2d<f32>;
@group(1) @binding(0) var<uniform> params : Params;
@group(2) @binding(0) var mask : texture_2d<f32>;
@group(3) @binding(0) var outp : texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
    let d = textureDimensions(outp);
    if (gid.x >= d.x || gid.y >= d.y) { return; }
    let xy = vec2<i32>(i32(gid.x), i32(gid.y));
    let far = 2048.0;
    if (textureLoad(in0, xy, 0).r >= params.threshold) {
        textureStore(outp, xy, mix(textureLoad(in0, xy, 0), vec4<f32>(0.0, 0.0, far, far), vec4<f32>(textureLoad(mask, xy, 0).r)));
    } else {
        textureStore(outp, xy, mix(textureLoad(in0, xy, 0), vec4<f32>(far, far, 0.0, 0.0), vec4<f32>(textureLoad(mask, xy, 0).r)));
    }
}
"#,
    Tolerance::Exact,
);

style_params!(
    /// `style.jfa_step`: one jump-flood pass at `step` texels.
    StyleJfaStepParams, JFA_STEP_FIELDS { step: i32 => "i32" }
);

impl StyleJfaStepParams {
    pub fn new(step: i32) -> Self {
        Self { step, _abi_pad: 0 }
    }
}

pub static STYLE_JFA_STEP: KernelDef = def(
    "style.jfa_step",
    KernelClass::Resample { support: 1024.0 },
    1,
    core::mem::size_of::<StyleJfaStepParams>(),
    JFA_STEP_FIELDS,
    r#"// paged.image kernel `style.jfa_step` — handwritten under ABI v1.1.
// AGPL-3.0-only OR LicenseRef-PMEL; (c) And The Next GmbH.
struct Params {
    step: i32,
    _abi_pad: u32,
}

@group(0) @binding(0) var in0 : texture_2d<f32>;
@group(1) @binding(0) var<uniform> params : Params;
@group(2) @binding(0) var mask : texture_2d<f32>;
@group(3) @binding(0) var outp : texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
    let d = textureDimensions(outp);
    if (gid.x >= d.x || gid.y >= d.y) { return; }
    let dims = vec2<i32>(i32(d.x), i32(d.y));
    let xy = vec2<i32>(i32(gid.x), i32(gid.y));
    let far = 2048.0;
    let cur = textureLoad(in0, xy, 0);
    var bo = cur.xy;
    var lo = 1e30;
    if (cur.x < far) { lo = dot(bo, bo); }
    var bi = cur.zw;
    var li = 1e30;
    if (cur.z < far) { li = dot(bi, bi); }
    for (var dy = -1; dy <= 1; dy = dy + 1) {
        for (var dx = -1; dx <= 1; dx = dx + 1) {
            if (dx == 0 && dy == 0) { continue; }
            let o = vec2<i32>(dx, dy) * params.step;
            let q = xy + o;
            if (q.x < 0 || q.y < 0 || q.x >= dims.x || q.y >= dims.y) { continue; }
            let n = textureLoad(in0, q, 0);
            let off = vec2<f32>(f32(o.x), f32(o.y));
            if (n.x < far) {
                let c = n.xy + off;
                let l = dot(c, c);
                if (l < lo && abs(c.x) < far && abs(c.y) < far) { lo = l; bo = c; }
            }
            if (n.z < far) {
                let c = n.zw + off;
                let l = dot(c, c);
                if (l < li && abs(c.x) < far && abs(c.y) < far) { li = l; bi = c; }
            }
        }
    }
    textureStore(outp, xy, mix(textureLoad(in0, xy, 0), vec4<f32>(bo, bi), vec4<f32>(textureLoad(mask, xy, 0).r)));
}
"#,
    Tolerance::Exact,
);

style_params!(
    /// `style.distance`: `in0` the flooded field, `in1` the coverage → the
    /// signed distance to the edge in `.r` (negative inside).
    StyleDistanceParams, DISTANCE_FIELDS {}
);

impl StyleDistanceParams {
    #[allow(clippy::new_without_default)]
    pub fn new() -> Self {
        Self { _abi_pad: 0 }
    }
}

pub static STYLE_DISTANCE: KernelDef = def(
    "style.distance",
    KernelClass::Point,
    2,
    core::mem::size_of::<StyleDistanceParams>(),
    DISTANCE_FIELDS,
    r#"// paged.image kernel `style.distance` — handwritten under ABI v1.1.
// AGPL-3.0-only OR LicenseRef-PMEL; (c) And The Next GmbH.
struct Params {
    _abi_pad: u32,
}

@group(0) @binding(0) var in0 : texture_2d<f32>;
@group(0) @binding(1) var in1 : texture_2d<f32>;
@group(1) @binding(0) var<uniform> params : Params;
@group(2) @binding(0) var mask : texture_2d<f32>;
@group(3) @binding(0) var outp : texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
    let d = textureDimensions(outp);
    if (gid.x >= d.x || gid.y >= d.y) { return; }
    let xy = vec2<i32>(i32(gid.x), i32(gid.y));
    let far = 2048.0;
    let f = textureLoad(in0, xy, 0);
    let c = textureLoad(in1, xy, 0).r;
    let dims = vec2<i32>(i32(d.x), i32(d.y));
    var sd = 0.0;
    if (c > 0.0 && c < 1.0) {
        sd = 0.5 - c;
    } else if (c >= 1.0) {
        if (f.z >= far) { sd = -far; } else {
            let q = clamp(xy + vec2<i32>(i32(f.z), i32(f.w)), vec2<i32>(0), dims - vec2<i32>(1));
            let cs = textureLoad(in1, q, 0).r;
            sd = -(length(f.zw) - (0.5 - cs));
        }
    } else {
        if (f.x >= far) { sd = far; } else {
            let q = clamp(xy + vec2<i32>(i32(f.x), i32(f.y)), vec2<i32>(0), dims - vec2<i32>(1));
            let cs = textureLoad(in1, q, 0).r;
            sd = length(f.xy) - (cs - 0.5);
        }
    }
    textureStore(outp, xy, mix(textureLoad(in0, xy, 0), vec4<f32>(sd), vec4<f32>(textureLoad(mask, xy, 0).r)));
}
"#,
    Tolerance::ChannelEpsF16(2),
);

// ───────────────────────────── ramp ─────────────────────────────

/// `style.ramp` modes.
pub const RAMP_BAND: u32 = 0;
pub const RAMP_FALLOFF: u32 = 1;

style_params!(
    /// `style.ramp`: from the signed distance `sd` in `.r` — BAND
    /// `clamp(½ + hi − sd) − clamp(½ + lo − sd)` (coverage between the
    /// offsets `lo` < `hi`, anti-aliased), or FALLOFF
    /// `clamp((hi − sd) / (hi − lo))` (1 at `lo`, 0 at `hi`).
    StyleRampParams, RAMP_FIELDS { lo: f32 => "f32", hi: f32 => "f32", mode: u32 => "u32" }
);

impl StyleRampParams {
    pub fn band(lo: f32, hi: f32) -> Self {
        Self {
            lo,
            hi,
            mode: RAMP_BAND,
            _abi_pad: 0,
        }
    }

    pub fn falloff(lo: f32, hi: f32) -> Self {
        Self {
            lo,
            hi,
            mode: RAMP_FALLOFF,
            _abi_pad: 0,
        }
    }
}

pub static STYLE_RAMP: KernelDef = def(
    "style.ramp",
    KernelClass::Point,
    1,
    core::mem::size_of::<StyleRampParams>(),
    RAMP_FIELDS,
    r#"// paged.image kernel `style.ramp` — handwritten under ABI v1.1.
// AGPL-3.0-only OR LicenseRef-PMEL; (c) And The Next GmbH.
struct Params {
    lo: f32,
    hi: f32,
    mode: u32,
    _abi_pad: u32,
}

@group(0) @binding(0) var in0 : texture_2d<f32>;
@group(1) @binding(0) var<uniform> params : Params;
@group(2) @binding(0) var mask : texture_2d<f32>;
@group(3) @binding(0) var outp : texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
    let d = textureDimensions(outp);
    if (gid.x >= d.x || gid.y >= d.y) { return; }
    let xy = vec2<i32>(i32(gid.x), i32(gid.y));
    let sd = textureLoad(in0, xy, 0).r;
    var v = 0.0;
    if (params.mode == 0u) {
        v = clamp(0.5 + params.hi - sd, 0.0, 1.0) - clamp(0.5 + params.lo - sd, 0.0, 1.0);
    } else {
        v = clamp((params.hi - sd) / max(params.hi - params.lo, 0.0001), 0.0, 1.0);
    }
    textureStore(outp, xy, mix(textureLoad(in0, xy, 0), vec4<f32>(max(v, 0.0)), vec4<f32>(textureLoad(mask, xy, 0).r)));
}
"#,
    Tolerance::ChannelEpsF16(2),
);

// ───────────────────────────── contour ─────────────────────────────

style_params!(
    /// `style.contour`: `v = channel`, remapped `clamp((v − lo) / (hi −
    /// lo))`, through the 256-entry curve `lut` (linear between entries),
    /// `1 − ·` when `invert`; splatted.
    StyleContourParams, CONTOUR_FIELDS {
        lut: [[f32; 4]; 64] => "array<vec4<f32>, 64>",
        lo: f32 => "f32", hi: f32 => "f32", invert: u32 => "u32", channel: u32 => "u32",
        _pad0: u32 => "u32", _pad1: u32 => "u32", _pad2: u32 => "u32",
    }
);

impl StyleContourParams {
    pub fn new(curve: &[f32; 256], lo: f32, hi: f32, invert: bool, channel: u32) -> Self {
        let mut lut = [[0.0f32; 4]; 64];
        for (i, v) in curve.iter().enumerate() {
            lut[i / 4][i % 4] = *v;
        }
        Self {
            lut,
            lo,
            hi,
            invert: u32::from(invert),
            channel,
            _pad0: 0,
            _pad1: 0,
            _pad2: 0,
            _abi_pad: 0,
        }
    }

    /// The identity curve.
    pub fn identity(invert: bool, channel: u32) -> Self {
        Self::new(
            &std::array::from_fn(|i| i as f32 / 255.0),
            0.0,
            1.0,
            invert,
            channel,
        )
    }
}

pub static STYLE_CONTOUR: KernelDef = def(
    "style.contour",
    KernelClass::Point,
    1,
    core::mem::size_of::<StyleContourParams>(),
    CONTOUR_FIELDS,
    r#"// paged.image kernel `style.contour` — handwritten under ABI v1.1.
// AGPL-3.0-only OR LicenseRef-PMEL; (c) And The Next GmbH.
struct Params {
    lut: array<vec4<f32>, 64>,
    lo: f32,
    hi: f32,
    invert: u32,
    channel: u32,
    _pad0: u32,
    _pad1: u32,
    _pad2: u32,
    _abi_pad: u32,
}

@group(0) @binding(0) var in0 : texture_2d<f32>;
@group(1) @binding(0) var<uniform> params : Params;
@group(2) @binding(0) var mask : texture_2d<f32>;
@group(3) @binding(0) var outp : texture_storage_2d<rgba16float, write>;

fn entry(i: u32) -> f32 { return params.lut[i / 4u][i % 4u]; }

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
    let d = textureDimensions(outp);
    if (gid.x >= d.x || gid.y >= d.y) { return; }
    let xy = vec2<i32>(i32(gid.x), i32(gid.y));
    let raw = textureLoad(in0, xy, 0)[params.channel];
    let v = clamp((raw - params.lo) / max(params.hi - params.lo, 0.000001), 0.0, 1.0);
    let x = v * 255.0;
    let i = min(u32(floor(x)), 254u);
    let f = x - f32(i);
    var r = mix(entry(i), entry(i + 1u), f);
    if (params.invert != 0u) { r = 1.0 - r; }
    textureStore(outp, xy, mix(textureLoad(in0, xy, 0), vec4<f32>(r), vec4<f32>(textureLoad(mask, xy, 0).r)));
}
"#,
    Tolerance::ChannelEpsF16(4),
);

// ───────────────────────────── colorize ─────────────────────────────

/// `style.colorize` modes: alpha is the coverage times the lookup's alpha
/// (an effect's colour) …
pub const COLORIZE_COVERAGE: u32 = 0;
/// … or the lookup's alpha alone (a gradient indexed by its parameter) …
pub const COLORIZE_LOOKUP: u32 = 1;
/// … or a GLOW'S GRADIENT: the lookup at `1 − v` (its start at the edge),
/// alpha `lut.a · min(1, 4·v)` — the falloff Photoshop draws a gradient
/// glow with (measured on a size-12 glow, `psd_layer_styles.rs`: the ratio
/// of its alpha to the coverage is 4 ± 0.2 along the whole tail).
pub const COLORIZE_GLOW_GRADIENT: u32 = 2;

style_params!(
    /// `style.colorize`: `v = channel`, the colour `lut[v ± jitter]`
    /// (straight RGBA, linear between entries), alpha per `mode`, then
    /// NOISE: `± noise / 2` (`h − ½`, `h` a hashed value in [0, 1) per
    /// texel and `seed`) where the effect has any alpha — Photoshop's
    /// noise darkens and lightens the shadow alike and stays inside its
    /// reach (measured on a noise-40 shadow); premultiplied out. The
    /// hash reads CANVAS coordinates: `(ox, oy)` is where the output's
    /// first texel lies on the canvas (0 for a whole canvas; a tile's
    /// origin in the tiled fold, so its noise is the canvas's).
    StyleColorizeParams, COLORIZE_FIELDS {
        lut: [[f32; 4]; 256] => "array<vec4<f32>, 256>",
        mode: u32 => "u32", channel: u32 => "u32", noise: f32 => "f32", jitter: f32 => "f32",
        seed: u32 => "u32", ox: i32 => "i32", oy: i32 => "i32",
    }
);

impl StyleColorizeParams {
    pub fn new(
        lut: [[f32; 4]; 256],
        mode: u32,
        channel: u32,
        noise: f32,
        jitter: f32,
        seed: u32,
    ) -> Self {
        Self {
            lut,
            mode,
            channel,
            noise,
            jitter,
            seed,
            ox: 0,
            oy: 0,
            _abi_pad: 0,
        }
    }

    /// The same, drawn into a texture whose first texel lies at
    /// `(ox, oy)` on the canvas.
    pub fn at(self, ox: i32, oy: i32) -> Self {
        Self { ox, oy, ..self }
    }

    /// One straight colour (`rgb` in [0, 1]) at full alpha everywhere.
    pub fn solid(rgb: [f32; 3], channel: u32, noise: f32, seed: u32) -> Self {
        Self::new(
            [[rgb[0], rgb[1], rgb[2], 1.0]; 256],
            COLORIZE_COVERAGE,
            channel,
            noise,
            0.0,
            seed,
        )
    }
}

pub static STYLE_COLORIZE: KernelDef = def(
    "style.colorize",
    KernelClass::Point,
    1,
    core::mem::size_of::<StyleColorizeParams>(),
    COLORIZE_FIELDS,
    r#"// paged.image kernel `style.colorize` — handwritten under ABI v1.1.
// AGPL-3.0-only OR LicenseRef-PMEL; (c) And The Next GmbH.
struct Params {
    lut: array<vec4<f32>, 256>,
    mode: u32,
    channel: u32,
    noise: f32,
    jitter: f32,
    seed: u32,
    ox: i32,
    oy: i32,
    _abi_pad: u32,
}

@group(0) @binding(0) var in0 : texture_2d<f32>;
@group(1) @binding(0) var<uniform> params : Params;
@group(2) @binding(0) var mask : texture_2d<f32>;
@group(3) @binding(0) var outp : texture_storage_2d<rgba16float, write>;

fn hash(x: u32, y: u32, s: u32) -> f32 {
    var h = x * 0x8da6b343u ^ y * 0xd8163841u ^ s * 0xcb1ab31fu;
    h = (h ^ (h >> 16u)) * 0x7feb352du;
    h = (h ^ (h >> 15u)) * 0x846ca68bu;
    h = h ^ (h >> 16u);
    return f32(h >> 8u) / 16777216.0;
}

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
    let d = textureDimensions(outp);
    if (gid.x >= d.x || gid.y >= d.y) { return; }
    let xy = vec2<i32>(i32(gid.x), i32(gid.y));
    let cx = u32(params.ox + xy.x);
    let cy = u32(params.oy + xy.y);
    let v = clamp(textureLoad(in0, xy, 0)[params.channel], 0.0, 1.0);
    var t = v;
    if (params.mode == 2u) { t = 1.0 - v; }
    if (params.jitter > 0.0) {
        t = clamp(t + params.jitter * (hash(cx, cy, params.seed + 1u) - 0.5), 0.0, 1.0);
    }
    let x = t * 255.0;
    let i = min(u32(floor(x)), 254u);
    let c = mix(params.lut[i], params.lut[i + 1u], x - f32(i));
    var a = c.a;
    if (params.mode == 0u) { a = a * v; }
    if (params.mode == 2u) { a = a * min(1.0, 4.0 * v); }
    if (params.noise > 0.0 && a > 0.004) {
        a = clamp(a + params.noise * (hash(cx, cy, params.seed) - 0.5), 0.0, 1.0);
    }
    textureStore(outp, xy, mix(textureLoad(in0, xy, 0), vec4<f32>(c.rgb * a, a), vec4<f32>(textureLoad(mask, xy, 0).r)));
}
"#,
    Tolerance::ChannelEpsF16(4),
);

// ───────────────────────────── bevel ─────────────────────────────

style_params!(
    /// `style.bevel`: the height `h` in `.r` (clamped at the canvas edge),
    /// surface normal `normalize(−depth·∂h/∂x, −depth·∂h/∂y, 1)` by central
    /// differences, Lambert shade `max(n · l, 0)` toward the unit light
    /// `(lx, ly, lz)` (image axes, y down); splatted.
    StyleBevelParams, BEVEL_FIELDS {
        depth: f32 => "f32", lx: f32 => "f32", ly: f32 => "f32", lz: f32 => "f32",
    }
);

impl StyleBevelParams {
    /// Light from `angle` (degrees counter-clockwise from 3 o'clock) at
    /// `altitude` degrees above the surface.
    pub fn new(depth: f32, angle: f32, altitude: f32) -> Self {
        let (a, e) = (angle.to_radians(), altitude.to_radians());
        Self {
            depth,
            lx: a.cos() * e.cos(),
            ly: -a.sin() * e.cos(),
            lz: e.sin(),
            _abi_pad: 0,
        }
    }
}

pub static STYLE_BEVEL: KernelDef = def(
    "style.bevel",
    KernelClass::Resample { support: 1.0 },
    1,
    core::mem::size_of::<StyleBevelParams>(),
    BEVEL_FIELDS,
    r#"// paged.image kernel `style.bevel` — handwritten under ABI v1.1.
// AGPL-3.0-only OR LicenseRef-PMEL; (c) And The Next GmbH.
struct Params {
    depth: f32,
    lx: f32,
    ly: f32,
    lz: f32,
    _abi_pad: u32,
}

@group(0) @binding(0) var in0 : texture_2d<f32>;
@group(1) @binding(0) var<uniform> params : Params;
@group(2) @binding(0) var mask : texture_2d<f32>;
@group(3) @binding(0) var outp : texture_storage_2d<rgba16float, write>;

fn h(p: vec2<i32>, dims: vec2<i32>) -> f32 {
    return textureLoad(in0, clamp(p, vec2<i32>(0), dims - vec2<i32>(1)), 0).r;
}

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
    let d = textureDimensions(outp);
    if (gid.x >= d.x || gid.y >= d.y) { return; }
    let dims = vec2<i32>(i32(d.x), i32(d.y));
    let xy = vec2<i32>(i32(gid.x), i32(gid.y));
    let gx = (h(xy + vec2<i32>(1, 0), dims) - h(xy - vec2<i32>(1, 0), dims)) * 0.5 * params.depth;
    let gy = (h(xy + vec2<i32>(0, 1), dims) - h(xy - vec2<i32>(0, 1), dims)) * 0.5 * params.depth;
    let n = normalize(vec3<f32>(-gx, -gy, 1.0));
    let s = max(dot(n, vec3<f32>(params.lx, params.ly, params.lz)), 0.0);
    textureStore(outp, xy, mix(textureLoad(in0, xy, 0), vec4<f32>(s), vec4<f32>(textureLoad(mask, xy, 0).r)));
}
"#,
    Tolerance::ChannelEpsF16(8),
);

style_params!(
    /// `style.split`: a shade `s` (`.r`) against the flat surface's shade
    /// `flat` → highlight `clamp((s − flat) / (1 − flat))` in `.r`, shadow
    /// `clamp((flat − s) / flat)` in `.g`.
    StyleSplitParams, SPLIT_FIELDS { flat: f32 => "f32" }
);

impl StyleSplitParams {
    pub fn new(flat: f32) -> Self {
        Self { flat, _abi_pad: 0 }
    }
}

pub static STYLE_SPLIT: KernelDef = def(
    "style.split",
    KernelClass::Point,
    1,
    core::mem::size_of::<StyleSplitParams>(),
    SPLIT_FIELDS,
    r#"// paged.image kernel `style.split` — handwritten under ABI v1.1.
// AGPL-3.0-only OR LicenseRef-PMEL; (c) And The Next GmbH.
struct Params {
    flat: f32,
    _abi_pad: u32,
}

@group(0) @binding(0) var in0 : texture_2d<f32>;
@group(1) @binding(0) var<uniform> params : Params;
@group(2) @binding(0) var mask : texture_2d<f32>;
@group(3) @binding(0) var outp : texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
    let d = textureDimensions(outp);
    if (gid.x >= d.x || gid.y >= d.y) { return; }
    let xy = vec2<i32>(i32(gid.x), i32(gid.y));
    let s = textureLoad(in0, xy, 0).r;
    let f = clamp(params.flat, 0.0001, 0.9999);
    let hi = clamp((s - f) / (1.0 - f), 0.0, 1.0);
    let sh = clamp((f - s) / f, 0.0, 1.0);
    textureStore(outp, xy, mix(textureLoad(in0, xy, 0), vec4<f32>(hi, sh, 0.0, 1.0), vec4<f32>(textureLoad(mask, xy, 0).r)));
}
"#,
    Tolerance::ChannelEpsF16(4),
);

style_params!(
    /// `style.absdiff`: `|a.r − b.r|`, splatted.
    StyleAbsDiffParams, ABSDIFF_FIELDS {}
);

impl StyleAbsDiffParams {
    #[allow(clippy::new_without_default)]
    pub fn new() -> Self {
        Self { _abi_pad: 0 }
    }
}

pub static STYLE_ABSDIFF: KernelDef = def(
    "style.absdiff",
    KernelClass::Point,
    2,
    core::mem::size_of::<StyleAbsDiffParams>(),
    ABSDIFF_FIELDS,
    r#"// paged.image kernel `style.absdiff` — handwritten under ABI v1.1.
// AGPL-3.0-only OR LicenseRef-PMEL; (c) And The Next GmbH.
struct Params {
    _abi_pad: u32,
}

@group(0) @binding(0) var in0 : texture_2d<f32>;
@group(0) @binding(1) var in1 : texture_2d<f32>;
@group(1) @binding(0) var<uniform> params : Params;
@group(2) @binding(0) var mask : texture_2d<f32>;
@group(3) @binding(0) var outp : texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
    let d = textureDimensions(outp);
    if (gid.x >= d.x || gid.y >= d.y) { return; }
    let xy = vec2<i32>(i32(gid.x), i32(gid.y));
    let v = abs(textureLoad(in0, xy, 0).r - textureLoad(in1, xy, 0).r);
    textureStore(outp, xy, mix(textureLoad(in0, xy, 0), vec4<f32>(v), vec4<f32>(textureLoad(mask, xy, 0).r)));
}
"#,
    Tolerance::ChannelEpsF16(2),
);

pub static FAMILY: &[&KernelDef] = &[
    &STYLE_SHIFT,
    &STYLE_BLUR_H,
    &STYLE_BLUR_V,
    &STYLE_JFA_SEED,
    &STYLE_JFA_STEP,
    &STYLE_DISTANCE,
    &STYLE_RAMP,
    &STYLE_CONTOUR,
    &STYLE_COLORIZE,
    &STYLE_BEVEL,
    &STYLE_SPLIT,
    &STYLE_ABSDIFF,
];

/// The scalar twins (test-only): one function per kernel over a whole
/// image of straight `[f32; 4]` texels, row-major `w × h` — the same
/// arithmetic, in the same order, as the module.
#[cfg(feature = "reference")]
pub mod reference {
    use super::*;

    pub type Img = Vec<[f32; 4]>;

    fn at(img: &[[f32; 4]], w: u32, x: i32, y: i32) -> [f32; 4] {
        img[(y as usize) * (w as usize) + x as usize]
    }

    pub fn shift(img: &[[f32; 4]], w: u32, h: u32, p: &StyleShiftParams) -> Img {
        let tap = |x: i32, y: i32| -> f32 {
            if x < 0 || y < 0 || x >= w as i32 || y >= h as i32 {
                p.outside
            } else {
                at(img, w, x, y)[p.channel as usize]
            }
        };
        let mut out = Vec::with_capacity(img.len());
        for y in 0..h as i32 {
            for x in 0..w as i32 {
                let (sx, sy) = (x as f32 - p.dx, y as f32 - p.dy);
                let (bx, by) = (sx.floor(), sy.floor());
                let (fx, fy) = (sx - bx, sy - by);
                let (px, py) = (bx as i32, by as i32);
                let top = tap(px, py) + (tap(px + 1, py) - tap(px, py)) * fx;
                let bot = tap(px, py + 1) + (tap(px + 1, py + 1) - tap(px, py + 1)) * fx;
                let mut v = top + (bot - top) * fy;
                if p.invert != 0 {
                    v = 1.0 - v;
                }
                out.push([v; 4]);
            }
        }
        out
    }

    pub fn blur(img: &[[f32; 4]], w: u32, h: u32, p: &StyleBlurParams, vertical: bool) -> Img {
        let r = p.radius.min(STYLE_MAX_BLUR_RADIUS) as i32;
        if r == 0 || p.sigma <= 0.0 {
            return img.to_vec();
        }
        let mut out = Vec::with_capacity(img.len());
        for y in 0..h as i32 {
            for x in 0..w as i32 {
                let mut s = 0.0f32;
                let mut acc = [0.0f32; 4];
                for i in -r..=r {
                    let wt = p.weight(i);
                    s += wt;
                    let (qx, qy) = if vertical { (x, y + i) } else { (x + i, y) };
                    let inside = qx >= 0 && qy >= 0 && qx < w as i32 && qy < h as i32;
                    let v = if inside {
                        at(img, w, qx, qy)
                    } else if p.outside < 0.0 {
                        at(img, w, qx.clamp(0, w as i32 - 1), qy.clamp(0, h as i32 - 1))
                    } else {
                        [p.outside; 4]
                    };
                    for c in 0..4 {
                        acc[c] += v[c] * wt;
                    }
                }
                out.push(acc.map(|a| a / s));
            }
        }
        out
    }

    pub fn jfa_seed(img: &[[f32; 4]], p: &StyleJfaSeedParams) -> Img {
        img.iter()
            .map(|t| {
                if t[0] >= p.threshold {
                    [0.0, 0.0, JFA_FAR, JFA_FAR]
                } else {
                    [JFA_FAR, JFA_FAR, 0.0, 0.0]
                }
            })
            .collect()
    }

    pub fn jfa_step(img: &[[f32; 4]], w: u32, h: u32, p: &StyleJfaStepParams) -> Img {
        let far = JFA_FAR;
        let mut out = Vec::with_capacity(img.len());
        for y in 0..h as i32 {
            for x in 0..w as i32 {
                let cur = at(img, w, x, y);
                let (mut bo, mut lo) = ([cur[0], cur[1]], 1e30f32);
                if cur[0] < far {
                    lo = bo[0] * bo[0] + bo[1] * bo[1];
                }
                let (mut bi, mut li) = ([cur[2], cur[3]], 1e30f32);
                if cur[2] < far {
                    li = bi[0] * bi[0] + bi[1] * bi[1];
                }
                for dy in -1..=1 {
                    for dx in -1..=1 {
                        if dx == 0 && dy == 0 {
                            continue;
                        }
                        let (ox, oy) = (dx * p.step, dy * p.step);
                        let (qx, qy) = (x + ox, y + oy);
                        if qx < 0 || qy < 0 || qx >= w as i32 || qy >= h as i32 {
                            continue;
                        }
                        let n = at(img, w, qx, qy);
                        if n[0] < far {
                            let c = [n[0] + ox as f32, n[1] + oy as f32];
                            let l = c[0] * c[0] + c[1] * c[1];
                            if l < lo && c[0].abs() < far && c[1].abs() < far {
                                lo = l;
                                bo = c;
                            }
                        }
                        if n[2] < far {
                            let c = [n[2] + ox as f32, n[3] + oy as f32];
                            let l = c[0] * c[0] + c[1] * c[1];
                            if l < li && c[0].abs() < far && c[1].abs() < far {
                                li = l;
                                bi = c;
                            }
                        }
                    }
                }
                out.push([bo[0], bo[1], bi[0], bi[1]]);
            }
        }
        out
    }

    pub fn distance(field: &[[f32; 4]], cov: &[[f32; 4]], w: u32, h: u32) -> Img {
        let far = JFA_FAR;
        let seed = |k: usize, vx: f32, vy: f32| -> f32 {
            let (x, y) = ((k as u32 % w) as i32, (k as u32 / w) as i32);
            let qx = (x + vx as i32).clamp(0, w as i32 - 1);
            let qy = (y + vy as i32).clamp(0, h as i32 - 1);
            cov[(qy as usize) * (w as usize) + qx as usize][0]
        };
        field
            .iter()
            .zip(cov)
            .enumerate()
            .map(|(k, (f, c))| {
                let c = c[0];
                let sd = if c > 0.0 && c < 1.0 {
                    0.5 - c
                } else if c >= 1.0 {
                    if f[2] >= far {
                        -far
                    } else {
                        -((f[2] * f[2] + f[3] * f[3]).sqrt() - (0.5 - seed(k, f[2], f[3])))
                    }
                } else if f[0] >= far {
                    far
                } else {
                    (f[0] * f[0] + f[1] * f[1]).sqrt() - (seed(k, f[0], f[1]) - 0.5)
                };
                [sd; 4]
            })
            .collect()
    }

    pub fn ramp(img: &[[f32; 4]], p: &StyleRampParams) -> Img {
        img.iter()
            .map(|t| {
                let sd = t[0];
                let v = if p.mode == RAMP_BAND {
                    (0.5 + p.hi - sd).clamp(0.0, 1.0) - (0.5 + p.lo - sd).clamp(0.0, 1.0)
                } else {
                    ((p.hi - sd) / (p.hi - p.lo).max(0.0001)).clamp(0.0, 1.0)
                };
                [v.max(0.0); 4]
            })
            .collect()
    }

    pub fn contour(img: &[[f32; 4]], p: &StyleContourParams) -> Img {
        let entry = |i: usize| p.lut[i / 4][i % 4];
        img.iter()
            .map(|t| {
                let raw = t[p.channel as usize];
                let v = ((raw - p.lo) / (p.hi - p.lo).max(0.000001)).clamp(0.0, 1.0);
                let x = v * 255.0;
                let i = (x.floor() as usize).min(254);
                let f = x - i as f32;
                let mut r = entry(i) + (entry(i + 1) - entry(i)) * f;
                if p.invert != 0 {
                    r = 1.0 - r;
                }
                [r; 4]
            })
            .collect()
    }

    /// The module's integer hash, bit for bit.
    pub fn hash(x: u32, y: u32, s: u32) -> f32 {
        let mut h =
            x.wrapping_mul(0x8da6_b343) ^ y.wrapping_mul(0xd816_3841) ^ s.wrapping_mul(0xcb1a_b31f);
        h = (h ^ (h >> 16)).wrapping_mul(0x7feb_352d);
        h = (h ^ (h >> 15)).wrapping_mul(0x846c_a68b);
        h ^= h >> 16;
        (h >> 8) as f32 / 16_777_216.0
    }

    pub fn colorize(img: &[[f32; 4]], w: u32, p: &StyleColorizeParams) -> Img {
        img.iter()
            .enumerate()
            .map(|(k, t)| {
                let (x, y) = ((k as u32) % w, (k as u32) / w);
                let v = t[p.channel as usize].clamp(0.0, 1.0);
                let mut tt = v;
                if p.mode == COLORIZE_GLOW_GRADIENT {
                    tt = 1.0 - v;
                }
                if p.jitter > 0.0 {
                    tt = (tt + p.jitter * (hash(x, y, p.seed.wrapping_add(1)) - 0.5))
                        .clamp(0.0, 1.0);
                }
                let xx = tt * 255.0;
                let i = (xx.floor() as usize).min(254);
                let f = xx - i as f32;
                let (a0, a1) = (p.lut[i], p.lut[i + 1]);
                let c: [f32; 4] = std::array::from_fn(|ch| a0[ch] + (a1[ch] - a0[ch]) * f);
                let mut a = c[3];
                if p.mode == COLORIZE_COVERAGE {
                    a *= v;
                }
                if p.mode == COLORIZE_GLOW_GRADIENT {
                    a *= (4.0 * v).min(1.0);
                }
                if p.noise > 0.0 && a > 0.004 {
                    a = (a + p.noise * (hash(x, y, p.seed) - 0.5)).clamp(0.0, 1.0);
                }
                [c[0] * a, c[1] * a, c[2] * a, a]
            })
            .collect()
    }

    pub fn bevel(img: &[[f32; 4]], w: u32, h: u32, p: &StyleBevelParams) -> Img {
        let hh = |x: i32, y: i32| at(img, w, x.clamp(0, w as i32 - 1), y.clamp(0, h as i32 - 1))[0];
        let mut out = Vec::with_capacity(img.len());
        for y in 0..h as i32 {
            for x in 0..w as i32 {
                let gx = (hh(x + 1, y) - hh(x - 1, y)) * 0.5 * p.depth;
                let gy = (hh(x, y + 1) - hh(x, y - 1)) * 0.5 * p.depth;
                let n = [-gx, -gy, 1.0f32];
                let len = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
                let s = ((n[0] * p.lx + n[1] * p.ly + n[2] * p.lz) / len).max(0.0);
                out.push([s; 4]);
            }
        }
        out
    }

    pub fn split(img: &[[f32; 4]], p: &StyleSplitParams) -> Img {
        let f = p.flat.clamp(0.0001, 0.9999);
        img.iter()
            .map(|t| {
                let s = t[0];
                [
                    ((s - f) / (1.0 - f)).clamp(0.0, 1.0),
                    ((f - s) / f).clamp(0.0, 1.0),
                    0.0,
                    1.0,
                ]
            })
            .collect()
    }

    pub fn absdiff(a: &[[f32; 4]], b: &[[f32; 4]]) -> Img {
        a.iter()
            .zip(b)
            .map(|(x, y)| [(x[0] - y[0]).abs(); 4])
            .collect()
    }
}
