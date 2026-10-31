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

//! band family (T0, spec §11) — channel plumbing: identity passthrough,
//! single-channel extraction, alpha override, alpha broadcast, and the
//! layer fold's three helpers (take, fade toward neutral, blend-if
//! coverage). The first four and `take` are a pure rearrangement of the
//! input texels' f16 lanes (plus the one exact-in-f16 literal `1.0`), so
//! they are bit-exact gpu↔ref; `fade_neutral` and `blend_if` compute, and
//! declare an f16 tolerance.
//!
//! Provenance: elementary pointwise algebra / no reference reading; the
//! blending-range ramps follow Adobe's description of Blend If (Photoshop
//! User Guide, "Specify a tonal range for blending layers").

use crate::{KernelClass, KernelDef, Tolerance};

kernel_family! {
    /// out = a (the cache-identity op — materialize a node's pixels).
    static BAND_COPY, params BandCopyParams, ref band_copy {
        id: "band.copy",
        class: KernelClass::Point,
        inputs: 1,
        params: {},
        eval: |a, b, p| a,
        mip_exact: true,
        tolerance: Tolerance::Exact,
    }
}

kernel_family! {
    /// out = one channel splayed across rgb, opaque alpha (band → gray).
    static BAND_EXTRACT, params BandExtractParams, ref band_extract {
        id: "band.extract",
        class: KernelClass::Point,
        inputs: 1,
        params: { channel: u32 },
        eval: |a, b, p| pack4(a[p.channel], a[p.channel], a[p.channel], 1.0),
        mip_exact: true,
        tolerance: Tolerance::Exact,
    }
}

kernel_family! {
    /// out = rgb of a with alpha replaced by the param.
    static BAND_SET_ALPHA, params BandSetAlphaParams, ref band_set_alpha {
        id: "band.set_alpha",
        class: KernelClass::Point,
        inputs: 1,
        params: { alpha: f32 },
        eval: |a, b, p| pack4(a[0], a[1], a[2], p.alpha),
        mip_exact: true,
        tolerance: Tolerance::Exact,
    }
}

kernel_family! {
    /// out = alpha broadcast to all four channels (alpha → coverage map).
    static BAND_BROADCAST_ALPHA, params BandBroadcastAlphaParams, ref band_broadcast_alpha {
        id: "band.broadcast_alpha",
        class: KernelClass::Point,
        inputs: 1,
        params: {},
        eval: |a, b, p| splat4(a[3]),
        mip_exact: true,
        tolerance: Tolerance::Exact,
    }
}

kernel_family! {
    /// out = b: with the ABI mask this is `mix(a, b, m)` — "replace the
    /// backdrop by `b` where the mask says so" (a knockout's hole, a
    /// masked hand-over between two accumulators).
    static BAND_TAKE, params BandTakeParams, ref band_take {
        id: "band.take",
        class: KernelClass::Point,
        inputs: 2,
        params: {},
        eval: |a, b, p| b,
        mip_exact: true,
        tolerance: Tolerance::Exact,
    }
}

kernel_family! {
    /// out = rgb of a with the ALPHA of b — Lock Transparent Pixels: a
    /// paint result keeps the layer's own transparency (in0 = the
    /// painted window, in1 = the untouched base).
    static BAND_KEEP_ALPHA, params BandKeepAlphaParams, ref band_keep_alpha {
        id: "band.keep_alpha",
        class: KernelClass::Point,
        inputs: 2,
        params: {},
        eval: |a, b, p| pack4(a[0], a[1], a[2], b[3]),
        mip_exact: true,
        tolerance: Tolerance::Exact,
    }
}

kernel_family! {
    /// Fade a PREMULTIPLIED colour toward a neutral grey by `fill`:
    /// `rgb·fill + neutral·α·(1 − fill)`, alpha through. Photoshop's fill
    /// opacity on the special blend modes (Color Dodge, Linear Burn, …),
    /// where the fill acts inside the blend: the source moves toward the
    /// mode's neutral colour (black, white or mid-grey, which blend to
    /// the backdrop unchanged) instead of fading out.
    static BAND_FADE_NEUTRAL, params BandFadeNeutralParams, ref band_fade_neutral {
        id: "band.fade_neutral",
        class: KernelClass::Point,
        inputs: 1,
        params: { neutral: f32, fill: f32 },
        eval: |a, b, p| mix(pack4(p.neutral, p.neutral, p.neutral, 1.0) * splat4(a[3]), a, splat4(p.fill)),
        mip_exact: true,
        tolerance: Tolerance::ChannelEpsF16(2),
    }
}

kernel_family! {
    /// BLEND IF (Photoshop's blending ranges): the coverage, splatted to
    /// all four channels, with which a layer `b` blends over the backdrop
    /// `a` (both premultiplied). For each of gray, red, green and blue,
    /// of the layer (`s…`) and of what lies beneath (`d…`), the
    /// unpremultiplied value `v` passes two ramps — `clamp(v·lk + lo)`
    /// rising from the black slider, `clamp(v·hk + ho)` falling to the
    /// white one — and the coverage is their product. The caller encodes
    /// a slider pair as a ramp (a split pair as a slope, an unsplit one
    /// as a one-level step); `k = 0, o = 1` is a ramp that passes all.
    /// Gray is `0.3 r + 0.59 g + 0.11 b`.
    static BAND_BLEND_IF, params BandBlendIfParams, ref band_blend_if {
        id: "band.blend_if",
        class: KernelClass::Point,
        inputs: 2,
        params: { slk0: f32, slk1: f32, slk2: f32, slk3: f32, slo0: f32, slo1: f32, slo2: f32, slo3: f32, shk0: f32, shk1: f32, shk2: f32, shk3: f32, sho0: f32, sho1: f32, sho2: f32, sho3: f32, dlk0: f32, dlk1: f32, dlk2: f32, dlk3: f32, dlo0: f32, dlo1: f32, dlo2: f32, dlo3: f32, dhk0: f32, dhk1: f32, dhk2: f32, dhk3: f32, dho0: f32, dho1: f32, dho2: f32, dho3: f32 },
        eval: |a, b, p| clamp(splat4(((unpremul4(b) * pack4(0.3, 0.59, 0.11, 0.0))[0] + (unpremul4(b) * pack4(0.3, 0.59, 0.11, 0.0))[1] + (unpremul4(b) * pack4(0.3, 0.59, 0.11, 0.0))[2]) * p.slk0 + p.slo0), splat4(0.0), splat4(1.0))
            * clamp(splat4(((unpremul4(b) * pack4(0.3, 0.59, 0.11, 0.0))[0] + (unpremul4(b) * pack4(0.3, 0.59, 0.11, 0.0))[1] + (unpremul4(b) * pack4(0.3, 0.59, 0.11, 0.0))[2]) * p.shk0 + p.sho0), splat4(0.0), splat4(1.0))
            * clamp(splat4(unpremul4(b)[0] * p.slk1 + p.slo1), splat4(0.0), splat4(1.0))
            * clamp(splat4(unpremul4(b)[0] * p.shk1 + p.sho1), splat4(0.0), splat4(1.0))
            * clamp(splat4(unpremul4(b)[1] * p.slk2 + p.slo2), splat4(0.0), splat4(1.0))
            * clamp(splat4(unpremul4(b)[1] * p.shk2 + p.sho2), splat4(0.0), splat4(1.0))
            * clamp(splat4(unpremul4(b)[2] * p.slk3 + p.slo3), splat4(0.0), splat4(1.0))
            * clamp(splat4(unpremul4(b)[2] * p.shk3 + p.sho3), splat4(0.0), splat4(1.0))
            * clamp(splat4(((unpremul4(a) * pack4(0.3, 0.59, 0.11, 0.0))[0] + (unpremul4(a) * pack4(0.3, 0.59, 0.11, 0.0))[1] + (unpremul4(a) * pack4(0.3, 0.59, 0.11, 0.0))[2]) * p.dlk0 + p.dlo0), splat4(0.0), splat4(1.0))
            * clamp(splat4(((unpremul4(a) * pack4(0.3, 0.59, 0.11, 0.0))[0] + (unpremul4(a) * pack4(0.3, 0.59, 0.11, 0.0))[1] + (unpremul4(a) * pack4(0.3, 0.59, 0.11, 0.0))[2]) * p.dhk0 + p.dho0), splat4(0.0), splat4(1.0))
            * clamp(splat4(unpremul4(a)[0] * p.dlk1 + p.dlo1), splat4(0.0), splat4(1.0))
            * clamp(splat4(unpremul4(a)[0] * p.dhk1 + p.dho1), splat4(0.0), splat4(1.0))
            * clamp(splat4(unpremul4(a)[1] * p.dlk2 + p.dlo2), splat4(0.0), splat4(1.0))
            * clamp(splat4(unpremul4(a)[1] * p.dhk2 + p.dho2), splat4(0.0), splat4(1.0))
            * clamp(splat4(unpremul4(a)[2] * p.dlk3 + p.dlo3), splat4(0.0), splat4(1.0))
            * clamp(splat4(unpremul4(a)[2] * p.dhk3 + p.dho3), splat4(0.0), splat4(1.0)),
        mip_exact: true,
        tolerance: Tolerance::ChannelEpsF16(4),
    }
}

pub static FAMILY: &[&KernelDef] = &[
    &BAND_COPY,
    &BAND_EXTRACT,
    &BAND_SET_ALPHA,
    &BAND_BROADCAST_ALPHA,
    &BAND_TAKE,
    &BAND_FADE_NEUTRAL,
    &BAND_BLEND_IF,
    &BAND_KEEP_ALPHA,
];
