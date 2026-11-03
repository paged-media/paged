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

//! The scalar twins of the compose.* blend/composite operators — the
//! compose parity tests' reference, the PSD flatten render-oracle, and
//! (feature `cpu`) the layer fold's CPU path where no GPU exists (image
//! ADR 480, a third exception to ADR 450 after 465 and 469). ONE body for
//! all three: `image-conformance`'s `compose_ref` re-exports this module.
//!
//! Provenance: W3C Compositing and Blending Level 1 (public spec,
//! <https://www.w3.org/TR/compositing-1/>); Porter–Duff `over` on
//! premultiplied data is the spine (docs/concept.md §8.4). The PSD merged-
//! composite oracle (psd_composite) joins on the `BlendMode` fourcc
//! mapping below.
//!
//! # Model (W3C §3 "Compositing and blending")
//!
//! Inputs are PREMULTIPLIED rgba: `a` = the backdrop (`Cb`·αb, αb),
//! `b` = the source layer (`Cs`·αs, αs). The layer `opacity` folds into
//! the source FIRST (W3C §5.1 group opacity for a single layer):
//! `b ← b · opacity` (the premultiplied source AND its alpha scale by
//! the same factor, so the unpremultiplied color `Cs` is unchanged).
//!
//! Then, per W3C §9 the unpremultiplied colors are blended and composited
//! source-over (W3C §11.3 "General formula", premultiplied form):
//!
//! ```text
//! Cs = unpremul(b).rgb,  Cb = unpremul(a).rgb     (zero-alpha → 0)
//! co = αs·(1 − αb)·Cs + αs·αb·B(Cb, Cs) + (1 − αs)·αb·Cb
//! αo = αs + αb·(1 − αs)
//! ```
//!
//! The output `(co, αo)` is already PREMULTIPLIED. Summation order in
//! `composite` is fixed (term1 + term2 + term3, left to right) and the
//! WGSL module mirrors it exactly (§6.3 determinism).
//!
//! The blend functions `B(Cb, Cs)` are the W3C §blending definitions.
//! Separable blends apply per channel; the non-separable four
//! (hue/saturation/color/luminosity) operate on the rgb triple via the
//! W3C §10.3 `Lum`/`ClipColor`/`SetLum`/`Sat`/`SetSat` pseudo-code,
//! transcribed identically here and in WGSL.

use crate::reference_prelude::Px;

// The blend functions `B(Cb, Cs)` are the engine's one definition
// (`paged-blend`, engine ADR 1034): the twin, the conformance oracle and
// the engine's CPU lane share them, and the WGSL mirrors them.
pub use paged_blend::formulas::{
    b_color, b_color_burn, b_color_dodge, b_darken, b_darker_color, b_difference, b_divide,
    b_exclusion, b_hard_light, b_hard_mix, b_hue, b_lighten, b_lighter_color, b_linear_burn,
    b_linear_dodge, b_linear_light, b_luminosity, b_multiply, b_normal, b_overlay, b_pin_light,
    b_saturation, b_screen, b_soft_light, b_subtract, b_vivid_light, clip_color, lum, sat, set_lum,
    set_sat, COLOR_TIE,
};

/// Unpremultiply guard mirroring `abi::unpremul4` / `reference_prelude`:
/// zero alpha maps to all-zero rgb (no Inf/NaN leak).
fn unpremul_rgb(p: Px) -> [f32; 3] {
    let alpha = p.0[3];
    if alpha == 0.0 {
        [0.0, 0.0, 0.0]
    } else {
        [p.0[0] / alpha, p.0[1] / alpha, p.0[2] / alpha]
    }
}

// ---------------------------------------------------------------------
// The blend dispatch — a kernel is identified by id (compose.<id>) and by
// the PSD `BlendMode` fourcc (`Blend::psd_key`, the flatten unit joins on
// it). The operator is the engine's enum (engine ADR 1034).
// ---------------------------------------------------------------------

/// One compose operator: `paged_blend::BlendMode`, whose `id()` names the
/// kernel (`compose.<id>`), whose `psd_key()` is the PSD blend-mode fourcc
/// and whose `blend()` is `B(Cb, Cs)`.
pub use paged_blend::BlendMode as Blend;

/// Every operator with a `compose.*` kernel, in the engine's declaration
/// order (Dissolve needs a pixel position and has its own kernel).
pub const ALL: [Blend; 26] = [
    Blend::Normal,
    Blend::Multiply,
    Blend::Screen,
    Blend::Overlay,
    Blend::Darken,
    Blend::Lighten,
    Blend::ColorDodge,
    Blend::ColorBurn,
    Blend::HardLight,
    Blend::SoftLight,
    Blend::Difference,
    Blend::Exclusion,
    Blend::Hue,
    Blend::Saturation,
    Blend::Color,
    Blend::Luminosity,
    Blend::LinearBurn,
    Blend::LinearDodge,
    Blend::DarkerColor,
    Blend::LighterColor,
    Blend::VividLight,
    Blend::LinearLight,
    Blend::PinLight,
    Blend::HardMix,
    Blend::Subtract,
    Blend::Divide,
];

/// The operator a `compose.*` kernel id names; `None` for any other id.
pub fn from_kernel_id(id: &str) -> Option<Blend> {
    let name = id.strip_prefix("compose.")?;
    ALL.iter().copied().find(|b| b.id() == name)
}

/// Composite premultiplied source `b` over premultiplied backdrop `a`
/// under `blend` with layer `opacity`, returning the PREMULTIPLIED
/// result. This is the single source of truth shared by the compose
/// parity tests and the PSD merged-composite oracle.
///
/// Steps (W3C §3 / §11.3, premultiplied form; fixed summation order):
/// 1. fold opacity into the source: `b ← b · opacity` (rgb AND alpha);
/// 2. unpremultiply both to `Cs`, `Cb` (zero-alpha → 0);
/// 3. `Bc = blend(Cb, Cs)`;
/// 4. `co = αs·(1−αb)·Cs + αs·αb·Bc + (1−αs)·αb·Cb` (left to right);
/// 5. `αo = αs + αb·(1−αs)`; output `(co, αo)`.
pub fn composite(a: Px, b: Px, opacity: f32, blend: Blend) -> Px {
    // 1. Fold layer opacity into the premultiplied source.
    let bs = Px([
        b.0[0] * opacity,
        b.0[1] * opacity,
        b.0[2] * opacity,
        b.0[3] * opacity,
    ]);

    // 2. Unpremultiply both (zero-alpha guard → 0).
    let alpha_s = bs.0[3];
    let alpha_b = a.0[3];
    let cs = unpremul_rgb(bs);
    let cb = unpremul_rgb(a);

    // 3. Blend the unpremultiplied colors.
    let blended = blend.blend(cb, cs);

    // 4/5. Source-over composite in premultiplied space; fixed term order.
    let alpha_o = alpha_s + alpha_b * (1.0 - alpha_s);
    let mut out = [0.0f32; 4];
    for ch in 0..3 {
        let term1 = alpha_s * (1.0 - alpha_b) * cs[ch];
        let term2 = alpha_s * alpha_b * blended[ch];
        let term3 = (1.0 - alpha_s) * alpha_b * cb[ch];
        out[ch] = term1 + term2 + term3;
    }
    out[3] = alpha_o;
    Px(out)
}

/// Scalar twin of `compose.normal_gamma`: normal source-over on colours
/// raised to `gamma`, taken back by `1/gamma` (premultiplied in and out).
pub fn composite_normal_gamma(a: Px, b: Px, opacity: f32, gamma: f32) -> Px {
    let bs = Px([
        b.0[0] * opacity,
        b.0[1] * opacity,
        b.0[2] * opacity,
        b.0[3] * opacity,
    ]);
    let (alpha_s, alpha_b) = (bs.0[3], a.0[3]);
    let cs = unpremul_rgb(bs).map(|c| c.clamp(0.0, 1.0).powf(gamma));
    let cb = unpremul_rgb(a).map(|c| c.clamp(0.0, 1.0).powf(gamma));
    let alpha_o = alpha_s + alpha_b * (1.0 - alpha_s);
    let mut out = [0.0f32; 4];
    if alpha_o > 0.0 {
        for ch in 0..3 {
            let mixed = (alpha_s * cs[ch] + (1.0 - alpha_s) * alpha_b * cb[ch]) / alpha_o;
            out[ch] = mixed.max(0.0).powf(1.0 / gamma) * alpha_o;
        }
    }
    out[3] = alpha_o;
    Px(out)
}
