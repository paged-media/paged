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

//! The 27 blend modes (engine ADR 1034).
//!
//! One enum, one set of names and one set of scalar formulas for every
//! consumer: the display list (`paged_compose::BlendMode` is this type),
//! the CPU lane's backdrop-reading composite of the modes Vello cannot
//! draw, the PDF and IDML writers' mapping, and paged.image's compose
//! reference twins (`image_conformance::compose_ref` calls these
//! functions, so the image module's Photoshop-recorded cases hold the
//! engine to the same arithmetic).
//!
//! Sixteen modes are PDF's (ISO 32000 §11.3.5) and InDesign's, and
//! Vello and `vello_cpu` draw them natively (`peniko::Mix`). The other
//! eleven are Photoshop's: [`BlendMode::Dissolve`], Linear Burn, Darker
//! Color, Linear Dodge, Lighter Color, Vivid Light, Linear Light, Pin
//! Light, Hard Mix, Subtract and Divide ([`BlendMode::is_native`] tells
//! them apart).
//!
//! # Model (W3C Compositing and Blending Level 1, §3 and §11.3)
//!
//! Colours are unpremultiplied in `[0, 1]`; `Cb` is the backdrop, `Cs`
//! the source. A separable mode applies `B(Cb, Cs)` per channel; a
//! non-separable one works on the rgb triple. The composite of a
//! premultiplied source over a premultiplied backdrop is
//!
//! ```text
//! co = αs·(1 − αb)·Cs + αs·αb·B(Cb, Cs) + (1 − αs)·αb·Cb
//! αo = αs + αb·(1 − αs)
//! ```
//!
//! summed in that order ([`composite`]). Dissolve is not a `B`: each
//! pixel shows the source, opaque, with a probability equal to its
//! alpha, and the backdrop otherwise ([`composite_dissolve`]).
//!
//! Provenance: the W3C formulas (public spec,
//! <https://www.w3.org/TR/compositing-1/>) and the publicly documented
//! Photoshop / PDF-extended formulas for the Photoshop modes. The
//! branch orders and tie rules were measured against Photoshop 2026 by
//! paged.image's oracle fixtures (`image-conformance/fixtures/photoshop`)
//! and moved here from `image_conformance::compose_ref` unchanged.

pub mod formulas;

/// A blend mode. `Normal` (source-over) is the default.
///
/// The declaration order is the order the variants were added — the
/// sixteen PDF modes first, as the display list always had them — and
/// carries no meaning; [`BlendMode::MENU`] is the order a picker lists.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash)]
pub enum BlendMode {
    #[default]
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
    /// Photoshop's Dissolve: a seeded, per-pixel random choice between
    /// the source (opaque) and the backdrop, the source's alpha the
    /// probability ([`composite_dissolve`]).
    Dissolve,
    LinearBurn,
    /// Photoshop's Linear Dodge (Add).
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

impl BlendMode {
    /// All 27, in Photoshop's menu order. [`BlendMode::MENU_GROUPS`]
    /// gives the separators.
    pub const MENU: [BlendMode; 27] = [
        BlendMode::Normal,
        BlendMode::Dissolve,
        BlendMode::Darken,
        BlendMode::Multiply,
        BlendMode::ColorBurn,
        BlendMode::LinearBurn,
        BlendMode::DarkerColor,
        BlendMode::Lighten,
        BlendMode::Screen,
        BlendMode::ColorDodge,
        BlendMode::LinearDodge,
        BlendMode::LighterColor,
        BlendMode::Overlay,
        BlendMode::SoftLight,
        BlendMode::HardLight,
        BlendMode::VividLight,
        BlendMode::LinearLight,
        BlendMode::PinLight,
        BlendMode::HardMix,
        BlendMode::Difference,
        BlendMode::Exclusion,
        BlendMode::Subtract,
        BlendMode::Divide,
        BlendMode::Hue,
        BlendMode::Saturation,
        BlendMode::Color,
        BlendMode::Luminosity,
    ];

    /// The sizes of Photoshop's six menu groups, in [`BlendMode::MENU`]
    /// order: Normal/Dissolve · the darkens · the lightens · the
    /// contrasts · the inversions · the components.
    pub const MENU_GROUPS: [usize; 6] = [2, 5, 5, 7, 4, 4];

    /// The model's spelling — the IDML `BlendMode` enum string for the
    /// sixteen, the same PascalCase for Photoshop's eleven. This is what
    /// `<BlendingSetting BlendMode>`, the `frameBlendMode` property and
    /// the `.paged` model part carry.
    pub const fn name(self) -> &'static str {
        match self {
            BlendMode::Normal => "Normal",
            BlendMode::Multiply => "Multiply",
            BlendMode::Screen => "Screen",
            BlendMode::Overlay => "Overlay",
            BlendMode::Darken => "Darken",
            BlendMode::Lighten => "Lighten",
            BlendMode::ColorDodge => "ColorDodge",
            BlendMode::ColorBurn => "ColorBurn",
            BlendMode::HardLight => "HardLight",
            BlendMode::SoftLight => "SoftLight",
            BlendMode::Difference => "Difference",
            BlendMode::Exclusion => "Exclusion",
            BlendMode::Hue => "Hue",
            BlendMode::Saturation => "Saturation",
            BlendMode::Color => "Color",
            BlendMode::Luminosity => "Luminosity",
            BlendMode::Dissolve => "Dissolve",
            BlendMode::LinearBurn => "LinearBurn",
            BlendMode::LinearDodge => "LinearDodge",
            BlendMode::DarkerColor => "DarkerColor",
            BlendMode::LighterColor => "LighterColor",
            BlendMode::VividLight => "VividLight",
            BlendMode::LinearLight => "LinearLight",
            BlendMode::PinLight => "PinLight",
            BlendMode::HardMix => "HardMix",
            BlendMode::Subtract => "Subtract",
            BlendMode::Divide => "Divide",
        }
    }

    /// The canonical id: snake_case, the spelling paged.image's
    /// `compose.<id>` kernels and its layer wire carry.
    pub const fn id(self) -> &'static str {
        match self {
            BlendMode::Normal => "normal",
            BlendMode::Multiply => "multiply",
            BlendMode::Screen => "screen",
            BlendMode::Overlay => "overlay",
            BlendMode::Darken => "darken",
            BlendMode::Lighten => "lighten",
            BlendMode::ColorDodge => "color_dodge",
            BlendMode::ColorBurn => "color_burn",
            BlendMode::HardLight => "hard_light",
            BlendMode::SoftLight => "soft_light",
            BlendMode::Difference => "difference",
            BlendMode::Exclusion => "exclusion",
            BlendMode::Hue => "hue",
            BlendMode::Saturation => "saturation",
            BlendMode::Color => "color",
            BlendMode::Luminosity => "luminosity",
            BlendMode::Dissolve => "dissolve",
            BlendMode::LinearBurn => "linear_burn",
            BlendMode::LinearDodge => "linear_dodge",
            BlendMode::DarkerColor => "darker_color",
            BlendMode::LighterColor => "lighter_color",
            BlendMode::VividLight => "vivid_light",
            BlendMode::LinearLight => "linear_light",
            BlendMode::PinLight => "pin_light",
            BlendMode::HardMix => "hard_mix",
            BlendMode::Subtract => "subtract",
            BlendMode::Divide => "divide",
        }
    }

    /// Parse the canonical id ([`BlendMode::id`]).
    pub fn from_id(id: &str) -> Option<BlendMode> {
        BlendMode::MENU.into_iter().find(|m| m.id() == id)
    }

    /// The English display name, as Photoshop's menu spells it. The
    /// editor's catalogues translate it by this text.
    pub const fn display_name(self) -> &'static str {
        match self {
            BlendMode::Normal => "Normal",
            BlendMode::Multiply => "Multiply",
            BlendMode::Screen => "Screen",
            BlendMode::Overlay => "Overlay",
            BlendMode::Darken => "Darken",
            BlendMode::Lighten => "Lighten",
            BlendMode::ColorDodge => "Color Dodge",
            BlendMode::ColorBurn => "Color Burn",
            BlendMode::HardLight => "Hard Light",
            BlendMode::SoftLight => "Soft Light",
            BlendMode::Difference => "Difference",
            BlendMode::Exclusion => "Exclusion",
            BlendMode::Hue => "Hue",
            BlendMode::Saturation => "Saturation",
            BlendMode::Color => "Color",
            BlendMode::Luminosity => "Luminosity",
            BlendMode::Dissolve => "Dissolve",
            BlendMode::LinearBurn => "Linear Burn",
            BlendMode::LinearDodge => "Linear Dodge (Add)",
            BlendMode::DarkerColor => "Darker Color",
            BlendMode::LighterColor => "Lighter Color",
            BlendMode::VividLight => "Vivid Light",
            BlendMode::LinearLight => "Linear Light",
            BlendMode::PinLight => "Pin Light",
            BlendMode::HardMix => "Hard Mix",
            BlendMode::Subtract => "Subtract",
            BlendMode::Divide => "Divide",
        }
    }

    /// The menu group (0–5, [`BlendMode::MENU_GROUPS`]) the mode sits in.
    pub fn menu_group(self) -> usize {
        let at = BlendMode::MENU.iter().position(|m| *m == self).unwrap_or(0);
        let mut end = 0;
        for (g, n) in BlendMode::MENU_GROUPS.iter().enumerate() {
            end += n;
            if at < end {
                return g;
            }
        }
        0
    }

    /// Parse the model's spelling ([`BlendMode::name`]). Unknown text is
    /// `None`; the renderer draws it `Normal`, as it always drew an
    /// unknown IDML value.
    pub fn from_name(name: &str) -> Option<BlendMode> {
        BlendMode::MENU.into_iter().find(|m| m.name() == name)
    }

    /// One of the sixteen modes PDF, InDesign, Vello and `vello_cpu`
    /// have. The other eleven need a backdrop-reading composite.
    pub const fn is_native(self) -> bool {
        !matches!(
            self,
            BlendMode::Dissolve
                | BlendMode::LinearBurn
                | BlendMode::LinearDodge
                | BlendMode::DarkerColor
                | BlendMode::LighterColor
                | BlendMode::VividLight
                | BlendMode::LinearLight
                | BlendMode::PinLight
                | BlendMode::HardMix
                | BlendMode::Subtract
                | BlendMode::Divide
        )
    }

    /// The native mode that looks most like this one: itself for the
    /// sixteen. What an IDML export writes (with a loss line) and what a
    /// lane that cannot read its backdrop draws.
    pub const fn nearest_native(self) -> BlendMode {
        match self {
            BlendMode::Dissolve => BlendMode::Normal,
            BlendMode::LinearBurn => BlendMode::Multiply,
            BlendMode::DarkerColor => BlendMode::Darken,
            BlendMode::LinearDodge => BlendMode::Screen,
            BlendMode::LighterColor => BlendMode::Lighten,
            BlendMode::VividLight | BlendMode::LinearLight | BlendMode::PinLight => {
                BlendMode::HardLight
            }
            BlendMode::HardMix => BlendMode::HardLight,
            BlendMode::Subtract => BlendMode::Difference,
            BlendMode::Divide => BlendMode::ColorDodge,
            native => native,
        }
    }

    /// Needs a backdrop-reading composite: not one of the sixteen.
    pub const fn needs_backdrop(self) -> bool {
        !self.is_native()
    }

    /// The PDF `/BM` name (ISO 32000-1 §11.3.5); `None` for Photoshop's
    /// eleven, which PDF cannot name.
    pub const fn pdf_name(self) -> Option<&'static str> {
        if self.is_native() {
            Some(self.name())
        } else {
            None
        }
    }

    /// The IDML `BlendMode` value a document carrying this mode writes:
    /// its own for the sixteen, the nearest one's for the rest (the IDML
    /// export reports that as a loss).
    pub const fn idml_name(self) -> &'static str {
        self.nearest_native().name()
    }

    /// The CSS `mix-blend-mode` keyword (Compositing and Blending Level
    /// 1); `None` for Photoshop's eleven, which CSS has no exact keyword
    /// for.
    pub const fn css_name(self) -> Option<&'static str> {
        Some(match self {
            BlendMode::Normal => "normal",
            BlendMode::Multiply => "multiply",
            BlendMode::Screen => "screen",
            BlendMode::Overlay => "overlay",
            BlendMode::Darken => "darken",
            BlendMode::Lighten => "lighten",
            BlendMode::ColorDodge => "color-dodge",
            BlendMode::ColorBurn => "color-burn",
            BlendMode::HardLight => "hard-light",
            BlendMode::SoftLight => "soft-light",
            BlendMode::Difference => "difference",
            BlendMode::Exclusion => "exclusion",
            BlendMode::Hue => "hue",
            BlendMode::Saturation => "saturation",
            BlendMode::Color => "color",
            BlendMode::Luminosity => "luminosity",
            _ => return None,
        })
    }

    /// Parse a CSS `mix-blend-mode` keyword.
    pub fn from_css_name(name: &str) -> Option<BlendMode> {
        BlendMode::MENU
            .into_iter()
            .find(|m| m.css_name() == Some(name))
    }

    /// DrawingML's `ST_BlendMode` (ECMA-376 §20.1.10.11, the `blend` of
    /// a fill overlay): five modes; `None` for the rest.
    pub const fn drawingml_name(self) -> Option<&'static str> {
        Some(match self {
            BlendMode::Normal => "over",
            BlendMode::Multiply => "mult",
            BlendMode::Screen => "screen",
            BlendMode::Darken => "darken",
            BlendMode::Lighten => "lighten",
            _ => return None,
        })
    }

    /// Parse a DrawingML `ST_BlendMode`.
    pub fn from_drawingml_name(name: &str) -> Option<BlendMode> {
        BlendMode::MENU
            .into_iter()
            .find(|m| m.drawingml_name() == Some(name))
    }

    /// Photoshop's long-form action-descriptor id (`BlnM` in layer
    /// effects and brushes: `colorBurn`, `blendSubtraction`, …).
    pub const fn descriptor_id(self) -> &'static str {
        match self {
            BlendMode::Normal => "normal",
            BlendMode::Multiply => "multiply",
            BlendMode::Screen => "screen",
            BlendMode::Overlay => "overlay",
            BlendMode::Darken => "darken",
            BlendMode::Lighten => "lighten",
            BlendMode::ColorDodge => "colorDodge",
            BlendMode::ColorBurn => "colorBurn",
            BlendMode::HardLight => "hardLight",
            BlendMode::SoftLight => "softLight",
            BlendMode::Difference => "difference",
            BlendMode::Exclusion => "exclusion",
            BlendMode::Hue => "hue",
            BlendMode::Saturation => "saturation",
            BlendMode::Color => "color",
            BlendMode::Luminosity => "luminosity",
            BlendMode::Dissolve => "dissolve",
            BlendMode::LinearBurn => "linearBurn",
            BlendMode::LinearDodge => "linearDodge",
            BlendMode::DarkerColor => "darkerColor",
            BlendMode::LighterColor => "lighterColor",
            BlendMode::VividLight => "vividLight",
            BlendMode::LinearLight => "linearLight",
            BlendMode::PinLight => "pinLight",
            BlendMode::HardMix => "hardMix",
            BlendMode::Subtract => "blendSubtraction",
            BlendMode::Divide => "blendDivide",
        }
    }

    /// Photoshop's legacy four-character descriptor code (`Nrml`,
    /// `Mltp`, …); `None` for the modes born after it, which only have a
    /// [`BlendMode::descriptor_id`].
    pub const fn descriptor_code(self) -> Option<&'static [u8; 4]> {
        Some(match self {
            BlendMode::Normal => b"Nrml",
            BlendMode::Dissolve => b"Dslv",
            BlendMode::Darken => b"Drkn",
            BlendMode::Multiply => b"Mltp",
            BlendMode::ColorBurn => b"CBrn",
            BlendMode::Lighten => b"Lghn",
            BlendMode::Screen => b"Scrn",
            BlendMode::ColorDodge => b"CDdg",
            BlendMode::Overlay => b"Ovrl",
            BlendMode::SoftLight => b"SftL",
            BlendMode::HardLight => b"HrdL",
            BlendMode::Difference => b"Dfrn",
            BlendMode::Exclusion => b"Xclu",
            BlendMode::Hue => b"H   ",
            BlendMode::Saturation => b"Strt",
            BlendMode::Color => b"Clr ",
            BlendMode::Luminosity => b"Lmns",
            _ => return None,
        })
    }

    /// Parse a descriptor value in either dialect: the long-form id or
    /// the four-character code.
    pub fn from_descriptor(value: &str) -> Option<BlendMode> {
        BlendMode::MENU.into_iter().find(|m| {
            m.descriptor_id() == value || m.descriptor_code().is_some_and(|c| c == value.as_bytes())
        })
    }

    /// Operates on the rgb triple rather than per channel.
    pub const fn is_non_separable(self) -> bool {
        matches!(
            self,
            BlendMode::Hue
                | BlendMode::Saturation
                | BlendMode::Color
                | BlendMode::Luminosity
                | BlendMode::DarkerColor
                | BlendMode::LighterColor
        )
    }

    /// The PSD layer record's blend-mode key (Adobe PSD specification,
    /// "Blend mode key"), Dissolve's `diss` included.
    pub const fn psd_key(self) -> &'static [u8; 4] {
        match self {
            BlendMode::Normal => b"norm",
            BlendMode::Multiply => b"mul ",
            BlendMode::Screen => b"scrn",
            BlendMode::Overlay => b"over",
            BlendMode::Darken => b"dark",
            BlendMode::Lighten => b"lite",
            BlendMode::ColorDodge => b"div ",
            BlendMode::ColorBurn => b"idiv",
            BlendMode::HardLight => b"hLit",
            BlendMode::SoftLight => b"sLit",
            BlendMode::Difference => b"diff",
            BlendMode::Exclusion => b"smud",
            BlendMode::Hue => b"hue ",
            BlendMode::Saturation => b"sat ",
            BlendMode::Color => b"colr",
            BlendMode::Luminosity => b"lum ",
            BlendMode::Dissolve => b"diss",
            BlendMode::LinearBurn => b"lbrn",
            BlendMode::LinearDodge => b"lddg",
            BlendMode::DarkerColor => b"dkCl",
            BlendMode::LighterColor => b"lgCl",
            BlendMode::VividLight => b"vLit",
            BlendMode::LinearLight => b"lLit",
            BlendMode::PinLight => b"pLit",
            BlendMode::HardMix => b"hMix",
            BlendMode::Subtract => b"fsub",
            BlendMode::Divide => b"fdiv",
        }
    }

    /// Reverse of [`BlendMode::psd_key`].
    pub fn from_psd_key(key: &[u8; 4]) -> Option<BlendMode> {
        BlendMode::MENU.into_iter().find(|m| m.psd_key() == key)
    }

    /// `B(Cb, Cs)` on unpremultiplied rgb. Normal and Dissolve return
    /// the source (Dissolve's choice is made by [`composite_dissolve`]).
    pub fn blend(self, cb: [f32; 3], cs: [f32; 3]) -> [f32; 3] {
        use formulas::*;
        let sep = |f: fn(f32, f32) -> f32| [f(cb[0], cs[0]), f(cb[1], cs[1]), f(cb[2], cs[2])];
        match self {
            BlendMode::Normal | BlendMode::Dissolve => cs,
            BlendMode::Multiply => sep(b_multiply),
            BlendMode::Screen => sep(b_screen),
            BlendMode::Overlay => sep(b_overlay),
            BlendMode::Darken => sep(b_darken),
            BlendMode::Lighten => sep(b_lighten),
            BlendMode::ColorDodge => sep(b_color_dodge),
            BlendMode::ColorBurn => sep(b_color_burn),
            BlendMode::HardLight => sep(b_hard_light),
            BlendMode::SoftLight => sep(b_soft_light),
            BlendMode::Difference => sep(b_difference),
            BlendMode::Exclusion => sep(b_exclusion),
            BlendMode::Hue => b_hue(cb, cs),
            BlendMode::Saturation => b_saturation(cb, cs),
            BlendMode::Color => b_color(cb, cs),
            BlendMode::Luminosity => b_luminosity(cb, cs),
            BlendMode::LinearBurn => sep(b_linear_burn),
            BlendMode::LinearDodge => sep(b_linear_dodge),
            BlendMode::DarkerColor => b_darker_color(cb, cs),
            BlendMode::LighterColor => b_lighter_color(cb, cs),
            BlendMode::VividLight => sep(b_vivid_light),
            BlendMode::LinearLight => sep(b_linear_light),
            BlendMode::PinLight => sep(b_pin_light),
            BlendMode::HardMix => sep(b_hard_mix),
            BlendMode::Subtract => sep(b_subtract),
            BlendMode::Divide => sep(b_divide),
        }
    }
}

/// Unpremultiply rgb; zero alpha is black (no Inf/NaN).
fn unpremul_rgb(p: [f32; 4]) -> [f32; 3] {
    let a = p[3];
    if a == 0.0 {
        [0.0, 0.0, 0.0]
    } else {
        [p[0] / a, p[1] / a, p[2] / a]
    }
}

/// Composite a premultiplied source `b` over a premultiplied backdrop
/// `a` with `mode` and layer `opacity`, returning the premultiplied
/// result.
///
/// 1. The opacity folds into the source: `b ← b · opacity`.
/// 2. Both are unpremultiplied (zero alpha → 0).
/// 3. `co = αs·(1−αb)·Cs + αs·αb·B(Cb, Cs) + (1−αs)·αb·Cb`, summed left
///    to right; `αo = αs + αb·(1−αs)`.
///
/// Dissolve composites `Normal` here; it needs a pixel position
/// ([`composite_dissolve`]).
pub fn composite(a: [f32; 4], b: [f32; 4], opacity: f32, mode: BlendMode) -> [f32; 4] {
    let bs = [
        b[0] * opacity,
        b[1] * opacity,
        b[2] * opacity,
        b[3] * opacity,
    ];
    let alpha_s = bs[3];
    let alpha_b = a[3];
    let cs = unpremul_rgb(bs);
    let cb = unpremul_rgb(a);
    let blended = mode.blend(cb, cs);
    let alpha_o = alpha_s + alpha_b * (1.0 - alpha_s);
    let mut out = [0.0f32; 4];
    for ch in 0..3 {
        let term1 = alpha_s * (1.0 - alpha_b) * cs[ch];
        let term2 = alpha_s * alpha_b * blended[ch];
        let term3 = (1.0 - alpha_s) * alpha_b * cb[ch];
        out[ch] = term1 + term2 + term3;
    }
    out[3] = alpha_o;
    out
}

/// Chris Wellons' `lowbias32` integer hash. Every operation is a
/// wrapping u32 operation WGSL has, so the image module's
/// `compose.dissolve` kernel computes the same bits.
pub const fn lowbias32(mut x: u32) -> u32 {
    x ^= x >> 16;
    x = x.wrapping_mul(0x7feb_352d);
    x ^= x >> 15;
    x = x.wrapping_mul(0x846c_a68b);
    x ^= x >> 16;
    x
}

/// Dissolve's threshold for the pixel `(x, y)` under `seed`: uniform in
/// `[0, 1)` on a 2⁻²⁴ grid, a pure function of the three.
pub fn dissolve_threshold(x: u32, y: u32, seed: u32) -> f32 {
    let h = lowbias32(x ^ lowbias32(y ^ lowbias32(seed)));
    (h >> 8) as f32 * (1.0 / 16_777_216.0)
}

/// Does Dissolve show the source at `(x, y)`? The source's effective
/// alpha `alpha` (its own alpha times the layer opacity) is the
/// probability.
pub fn dissolve_keeps(alpha: f32, x: u32, y: u32, seed: u32) -> bool {
    dissolve_threshold(x, y, seed) < alpha
}

/// Photoshop's Dissolve on premultiplied pixels: where the pixel's
/// threshold falls under the source's effective alpha
/// (`b.α · opacity`), the source's colour, OPAQUE; elsewhere the
/// backdrop unchanged. Antialiased edges and partial opacity dither
/// instead of fading.
///
/// `(x, y)` is the device pixel, `seed` the object's: the same object
/// rendered at the same resolution dissolves identically every time.
pub fn composite_dissolve(
    a: [f32; 4],
    b: [f32; 4],
    opacity: f32,
    x: u32,
    y: u32,
    seed: u32,
) -> [f32; 4] {
    let alpha = b[3] * opacity;
    if alpha > 0.0 && dissolve_keeps(alpha, x, y, seed) {
        let cs = unpremul_rgb(b);
        [cs[0], cs[1], cs[2], 1.0]
    } else {
        a
    }
}

/// A seed from a handful of words (an object's identity, its bounds'
/// bit patterns): `lowbias32` folded over them.
pub fn seed_of(words: &[u32]) -> u32 {
    words.iter().fold(0x9e37_79b9u32, |h, w| {
        lowbias32(h ^ w.wrapping_add(0x632b_e5ab))
    })
}
