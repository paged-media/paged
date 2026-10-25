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

//! Scalar reference implementations of the compose.* blend/composite
//! operators — shared by the compose parity tests AND the PSD flatten
//! render-oracle (test-only, like everything in this crate). Lands with
//! the M1 fan-out compose unit; the flatten unit consumes it.
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
//!
//! # One definition (engine ADR 1016)
//!
//! The blend functions, the mode enum, its PSD keys and the composite
//! spine live in the engine's dependency-free `paged-blend` crate, which
//! the engine's CPU lane composites Photoshop's modes with too. This
//! module re-exports them under the names the conformance tests always
//! used (`Blend`, `b_*`, `composite` on [`Px`]), so the image module's
//! Photoshop-recorded oracle cases hold the engine to the same
//! arithmetic. Only the `Px` adapters and the gamma twin are local.

use image_kernels::reference_prelude::Px;

pub use paged_blend::formulas::{
    b_color, b_color_burn, b_color_dodge, b_darken, b_darker_color, b_difference, b_divide,
    b_exclusion, b_hard_light, b_hard_mix, b_hue, b_lighten, b_lighter_color, b_linear_burn,
    b_linear_dodge, b_linear_light, b_luminosity, b_multiply, b_normal, b_overlay, b_pin_light,
    b_saturation, b_screen, b_soft_light, b_subtract, b_vivid_light, set_sat, COLOR_TIE,
};
/// The compose operator: `paged_blend::BlendMode` (27 modes, Dissolve
/// included). Its kernel is `compose.<id>` ([`kernel_id`]), its PSD key
/// [`paged_blend::BlendMode::psd_key`].
pub use paged_blend::BlendMode as Blend;

/// Unpremultiply guard mirroring `abi::unpremul4`: zero alpha → 0 rgb.
fn unpremul_rgb(p: Px) -> [f32; 3] {
    let alpha = p.0[3];
    if alpha == 0.0 {
        [0.0, 0.0, 0.0]
    } else {
        [p.0[0] / alpha, p.0[1] / alpha, p.0[2] / alpha]
    }
}

/// The `compose.*` kernel id of `blend` — the registry's row, found by
/// the mode's canonical id.
pub fn kernel_id(blend: Blend) -> &'static str {
    image_kernels::families::compose::FAMILY
        .iter()
        .map(|k| k.id)
        .find(|id| id.strip_prefix("compose.") == Some(blend.id()))
        .unwrap_or("compose.normal")
}

/// Composite premultiplied source `b` over premultiplied backdrop `a`
/// under `blend` with layer `opacity` — `paged_blend::composite` on
/// [`Px`]. Dissolve composites `Normal` here; it needs a pixel position
/// ([`composite_dissolve`]).
pub fn composite(a: Px, b: Px, opacity: f32, blend: Blend) -> Px {
    Px(paged_blend::composite(a.0, b.0, opacity, blend))
}

/// The scalar twin of `compose.dissolve`: `paged_blend::composite_dissolve`
/// at the canvas pixel `(x, y)` under `seed`.
pub fn composite_dissolve(a: Px, b: Px, opacity: f32, x: u32, y: u32, seed: u32) -> Px {
    Px(paged_blend::composite_dissolve(
        a.0, b.0, opacity, x, y, seed,
    ))
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
