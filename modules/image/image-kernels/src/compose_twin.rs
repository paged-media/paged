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

/// Lift a per-channel separable blend over the rgb triple.
fn blend_separable(f: fn(f32, f32) -> f32, cb: [f32; 3], cs: [f32; 3]) -> [f32; 3] {
    [f(cb[0], cs[0]), f(cb[1], cs[1]), f(cb[2], cs[2])]
}

// ---------------------------------------------------------------------
// The blend dispatch — a kernel is identified by id (compose.*) and by
// the PSD `BlendMode` fourcc (the flatten unit joins on `psd_key`).
// ---------------------------------------------------------------------

/// One compose operator: its kernel id, its PSD blend-mode fourcc key,
/// and the blend `B(Cb, Cs)` it applies (separable or non-separable).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Blend {
    Normal,
    Multiply,
    Screen,
    Overlay,
    Darken,
    Lighten,
    ColorDodge,
    ColorBurn,
    HardLight,
    SoftLight,
    Difference,
    Exclusion,
    Hue,
    Saturation,
    Color,
    Luminosity,
    LinearBurn,
    LinearDodge,
    DarkerColor,
    LighterColor,
    VividLight,
    LinearLight,
    PinLight,
    HardMix,
    Subtract,
    Divide,
}

/// Every operator, in [`Blend`]'s order.
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

impl Blend {
    /// The compose.* kernel id (dispatch / registry key).
    pub fn kernel_id(self) -> &'static str {
        match self {
            Blend::Normal => "compose.normal",
            Blend::Multiply => "compose.multiply",
            Blend::Screen => "compose.screen",
            Blend::Overlay => "compose.overlay",
            Blend::Darken => "compose.darken",
            Blend::Lighten => "compose.lighten",
            Blend::ColorDodge => "compose.color_dodge",
            Blend::ColorBurn => "compose.color_burn",
            Blend::HardLight => "compose.hard_light",
            Blend::SoftLight => "compose.soft_light",
            Blend::Difference => "compose.difference",
            Blend::Exclusion => "compose.exclusion",
            Blend::Hue => "compose.hue",
            Blend::Saturation => "compose.saturation",
            Blend::Color => "compose.color",
            Blend::Luminosity => "compose.luminosity",
            Blend::LinearBurn => "compose.linear_burn",
            Blend::LinearDodge => "compose.linear_dodge",
            Blend::DarkerColor => "compose.darker_color",
            Blend::LighterColor => "compose.lighter_color",
            Blend::VividLight => "compose.vivid_light",
            Blend::LinearLight => "compose.linear_light",
            Blend::PinLight => "compose.pin_light",
            Blend::HardMix => "compose.hard_mix",
            Blend::Subtract => "compose.subtract",
            Blend::Divide => "compose.divide",
        }
    }

    /// The operator a `compose.*` kernel id names (the reverse of
    /// [`Blend::kernel_id`]); `None` for any other id.
    pub fn from_kernel_id(id: &str) -> Option<Blend> {
        ALL.iter().copied().find(|b| b.kernel_id() == id)
    }

    /// The PSD layer-record `BlendMode` four-character key (Adobe PSD
    /// spec, "Blend mode key"). Separable keys are space-padded to four
    /// chars (`"mul "`, `"div "`, `"dark"`, `"lite"`, `"hue "`, `"sat "`,
    /// `"lum "`); the rest are exact four-char codes. The PSD flatten
    /// unit reads this key from each layer and looks up the operator via
    /// [`Blend::from_psd_key`].
    pub fn psd_key(self) -> &'static str {
        match self {
            Blend::Normal => "norm",
            Blend::Multiply => "mul ",
            Blend::Screen => "scrn",
            Blend::Overlay => "over",
            Blend::Darken => "dark",
            Blend::Lighten => "lite",
            Blend::ColorDodge => "div ",
            Blend::ColorBurn => "idiv",
            Blend::HardLight => "hLit",
            Blend::SoftLight => "sLit",
            Blend::Difference => "diff",
            Blend::Exclusion => "smud",
            Blend::Hue => "hue ",
            Blend::Saturation => "sat ",
            Blend::Color => "colr",
            Blend::Luminosity => "lum ",
            Blend::LinearBurn => "lbrn",
            Blend::LinearDodge => "lddg",
            Blend::DarkerColor => "dkCl",
            Blend::LighterColor => "lgCl",
            Blend::VividLight => "vLit",
            Blend::LinearLight => "lLit",
            Blend::PinLight => "pLit",
            Blend::HardMix => "hMix",
            Blend::Subtract => "fsub",
            Blend::Divide => "fdiv",
        }
    }

    /// Reverse of [`Blend::psd_key`] — resolve a PSD blend-mode fourcc to
    /// its operator (used by the PSD flatten oracle). Unknown keys → None
    /// (the preservation path keeps the layer's bytes; flatten falls back
    /// to `Normal` at the call site).
    pub fn from_psd_key(key: &str) -> Option<Blend> {
        Some(match key {
            "norm" => Blend::Normal,
            "mul " => Blend::Multiply,
            "scrn" => Blend::Screen,
            "over" => Blend::Overlay,
            "dark" => Blend::Darken,
            "lite" => Blend::Lighten,
            "div " => Blend::ColorDodge,
            "idiv" => Blend::ColorBurn,
            "hLit" => Blend::HardLight,
            "sLit" => Blend::SoftLight,
            "diff" => Blend::Difference,
            "smud" => Blend::Exclusion,
            "hue " => Blend::Hue,
            "sat " => Blend::Saturation,
            "colr" => Blend::Color,
            "lum " => Blend::Luminosity,
            "lbrn" => Blend::LinearBurn,
            "lddg" => Blend::LinearDodge,
            "dkCl" => Blend::DarkerColor,
            "lgCl" => Blend::LighterColor,
            "vLit" => Blend::VividLight,
            "lLit" => Blend::LinearLight,
            "pLit" => Blend::PinLight,
            "hMix" => Blend::HardMix,
            "fsub" => Blend::Subtract,
            "fdiv" => Blend::Divide,
            _ => return None,
        })
    }

    /// Whether this blend is non-separable (operates on the rgb triple).
    pub fn is_non_separable(self) -> bool {
        matches!(
            self,
            Blend::Hue
                | Blend::Saturation
                | Blend::Color
                | Blend::Luminosity
                | Blend::DarkerColor
                | Blend::LighterColor
        )
    }

    /// Apply `B(Cb, Cs)` for unpremultiplied rgb triples.
    pub fn blend(self, cb: [f32; 3], cs: [f32; 3]) -> [f32; 3] {
        match self {
            Blend::Normal => blend_separable(b_normal, cb, cs),
            Blend::Multiply => blend_separable(b_multiply, cb, cs),
            Blend::Screen => blend_separable(b_screen, cb, cs),
            Blend::Overlay => blend_separable(b_overlay, cb, cs),
            Blend::Darken => blend_separable(b_darken, cb, cs),
            Blend::Lighten => blend_separable(b_lighten, cb, cs),
            Blend::ColorDodge => blend_separable(b_color_dodge, cb, cs),
            Blend::ColorBurn => blend_separable(b_color_burn, cb, cs),
            Blend::HardLight => blend_separable(b_hard_light, cb, cs),
            Blend::SoftLight => blend_separable(b_soft_light, cb, cs),
            Blend::Difference => blend_separable(b_difference, cb, cs),
            Blend::Exclusion => blend_separable(b_exclusion, cb, cs),
            Blend::Hue => b_hue(cb, cs),
            Blend::Saturation => b_saturation(cb, cs),
            Blend::Color => b_color(cb, cs),
            Blend::Luminosity => b_luminosity(cb, cs),
            Blend::LinearBurn => blend_separable(b_linear_burn, cb, cs),
            Blend::LinearDodge => blend_separable(b_linear_dodge, cb, cs),
            Blend::DarkerColor => b_darker_color(cb, cs),
            Blend::LighterColor => b_lighter_color(cb, cs),
            Blend::VividLight => blend_separable(b_vivid_light, cb, cs),
            Blend::LinearLight => blend_separable(b_linear_light, cb, cs),
            Blend::PinLight => blend_separable(b_pin_light, cb, cs),
            Blend::HardMix => blend_separable(b_hard_mix, cb, cs),
            Blend::Subtract => blend_separable(b_subtract, cb, cs),
            Blend::Divide => blend_separable(b_divide, cb, cs),
        }
    }
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
