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

//! LAYER EFFECTS (Photoshop's layer STYLE) — the `lfx2` / `lmfx`
//! descriptor read into a typed model, and the model written back.
//!
//! The model ([`LayerStyle`]) holds every effect Photoshop's Layer Style
//! dialog has — Drop Shadow, Inner Shadow, Outer Glow, Inner Glow, Bevel &
//! Emboss (with its Contour and Texture panes), Satin, Color Overlay,
//! Gradient Overlay, Pattern Overlay and Stroke — with every parameter in
//! Photoshop's own units (percent, pixels, degrees, 0–255 colours). It is
//! format-neutral data: the image module draws it, a page renderer can map
//! it (PM-0014, the shared effect mapping).
//!
//! An effect switched off stays in the model (`enabled: false`), so the
//! dialog shows its settings and a save keeps them. A layer whose effects
//! are all off — or whose master switch is off — draws nothing, and
//! [`Effects::enabled`] is empty for it.
//!
//! Writing: [`LayerStyle::to_descriptor`] builds the descriptor from the
//! model, each effect starting from the descriptor it was read from (its
//! `source`) so keys this model does not carry (`showInDialog`,
//! `overprint`, interpolation methods) survive. A style with more than one
//! instance of an effect is the `lmfx` block (Photoshop writes it so);
//! otherwise `lfx2` ([`LayerStyle::block_key`]).
//!
//! Provenance: Adobe Photoshop File Formats specification — Additional
//! Layer Information, Object-based effects layer info (`lfx2`: a version
//! word, then a versioned descriptor), the descriptor structure and the
//! effect keys of the "Effects Layer" section [PUB]; each key's meaning
//! and unit checked against effects Photoshop 27.10 wrote itself
//! (`modules/image/image-conformance/fixtures/photoshop/layer-styles/`,
//! `…/layer-effects/`) [OBS]: the `*Multi` list form and the `lmfx` block
//! for several instances, `Ckmt` (spread / choke) a percentage stored
//! with the pixel unit, `layerConceals` (Layer Knocks Out Drop Shadow),
//! `present` beside `enab`, `Cnty` on a contour point (false = corner).

use crate::descriptor::build::{en, key, obj, rgb as rgb_value, unit};
use crate::descriptor::{
    read_versioned_descriptor, write_versioned_descriptor, Descriptor, DescriptorValue, Key,
};
use crate::reader::ByteReader;
use crate::Result;

#[cfg(feature = "serde")]
use serde::{Deserialize, Serialize};

// ───────────────────────────── vocabulary ─────────────────────────────

/// A blend mode, in the vocabulary of every module (`normal`,
/// `linear_burn`, …): the 27 Photoshop modes plus Dissolve.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
#[cfg_attr(
    feature = "serde",
    derive(Serialize, Deserialize),
    serde(rename_all = "snake_case")
)]
pub enum BlendMode {
    #[default]
    Normal,
    Dissolve,
    Darken,
    Multiply,
    ColorBurn,
    LinearBurn,
    DarkerColor,
    Lighten,
    Screen,
    ColorDodge,
    LinearDodge,
    LighterColor,
    Overlay,
    SoftLight,
    HardLight,
    VividLight,
    LinearLight,
    PinLight,
    HardMix,
    Difference,
    Exclusion,
    Subtract,
    Divide,
    Hue,
    Saturation,
    Color,
    Luminosity,
}

/// (mode, wire name, the string id Photoshop 27 writes, the legacy
/// four-character id, the layer-record key).
const BLEND_TABLE: &[(BlendMode, &str, &str, &str, &[u8; 4])] = &[
    (BlendMode::Normal, "normal", "normal", "Nrml", b"norm"),
    (BlendMode::Dissolve, "dissolve", "dissolve", "Dslv", b"diss"),
    (BlendMode::Darken, "darken", "darken", "Drkn", b"dark"),
    (BlendMode::Multiply, "multiply", "multiply", "Mltp", b"mul "),
    (
        BlendMode::ColorBurn,
        "color_burn",
        "colorBurn",
        "CBrn",
        b"idiv",
    ),
    (
        BlendMode::LinearBurn,
        "linear_burn",
        "linearBurn",
        "",
        b"lbrn",
    ),
    (
        BlendMode::DarkerColor,
        "darker_color",
        "darkerColor",
        "",
        b"dkCl",
    ),
    (BlendMode::Lighten, "lighten", "lighten", "Lghn", b"lite"),
    (BlendMode::Screen, "screen", "screen", "Scrn", b"scrn"),
    (
        BlendMode::ColorDodge,
        "color_dodge",
        "colorDodge",
        "CDdg",
        b"div ",
    ),
    (
        BlendMode::LinearDodge,
        "linear_dodge",
        "linearDodge",
        "",
        b"lddg",
    ),
    (
        BlendMode::LighterColor,
        "lighter_color",
        "lighterColor",
        "",
        b"lgCl",
    ),
    (BlendMode::Overlay, "overlay", "overlay", "Ovrl", b"over"),
    (
        BlendMode::SoftLight,
        "soft_light",
        "softLight",
        "SftL",
        b"sLit",
    ),
    (
        BlendMode::HardLight,
        "hard_light",
        "hardLight",
        "HrdL",
        b"hLit",
    ),
    (
        BlendMode::VividLight,
        "vivid_light",
        "vividLight",
        "",
        b"vLit",
    ),
    (
        BlendMode::LinearLight,
        "linear_light",
        "linearLight",
        "",
        b"lLit",
    ),
    (BlendMode::PinLight, "pin_light", "pinLight", "", b"pLit"),
    (BlendMode::HardMix, "hard_mix", "hardMix", "", b"hMix"),
    (
        BlendMode::Difference,
        "difference",
        "difference",
        "Dfrn",
        b"diff",
    ),
    (
        BlendMode::Exclusion,
        "exclusion",
        "exclusion",
        "Xclu",
        b"smud",
    ),
    (
        BlendMode::Subtract,
        "subtract",
        "blendSubtraction",
        "",
        b"fsub",
    ),
    (BlendMode::Divide, "divide", "blendDivide", "", b"fdiv"),
    (BlendMode::Hue, "hue", "hue", "H   ", b"hue "),
    (
        BlendMode::Saturation,
        "saturation",
        "saturation",
        "Strt",
        b"sat ",
    ),
    (BlendMode::Color, "color", "color", "Clr ", b"colr"),
    (
        BlendMode::Luminosity,
        "luminosity",
        "luminosity",
        "Lmns",
        b"lum ",
    ),
];

impl BlendMode {
    fn row(
        self,
    ) -> &'static (
        BlendMode,
        &'static str,
        &'static str,
        &'static str,
        &'static [u8; 4],
    ) {
        BLEND_TABLE
            .iter()
            .find(|r| r.0 == self)
            .expect("every mode has a row")
    }

    /// The wire name (`linear_burn`) — the image module's `compose.*`
    /// suffix.
    pub fn name(self) -> &'static str {
        self.row().1
    }

    pub fn from_name(name: &str) -> Option<BlendMode> {
        BLEND_TABLE.iter().find(|r| r.1 == name).map(|r| r.0)
    }

    /// The layer-record key (`lbrn`).
    pub fn layer_key(self) -> [u8; 4] {
        *self.row().4
    }

    pub fn from_layer_key(k: &[u8; 4]) -> Option<BlendMode> {
        BLEND_TABLE.iter().find(|r| r.4 == k).map(|r| r.0)
    }

    /// A descriptor `BlnM` enum value in either dialect (`Mltp` or
    /// `multiply`; both occur, the corpus writes the first, Photoshop 27
    /// the second [OBS]).
    pub fn from_descriptor_id(id: &str) -> Option<BlendMode> {
        BLEND_TABLE
            .iter()
            .find(|r| r.2 == id || (!r.3.is_empty() && r.3 == id))
            .map(|r| r.0)
    }

    /// The string id Photoshop 27 writes.
    pub fn descriptor_id(self) -> &'static str {
        self.row().2
    }
}

/// The descriptor enum value of a blend mode (`BlnM`) as the layer
/// record's four-character key.
pub fn blend_key_of(mode: &str) -> Option<[u8; 4]> {
    BlendMode::from_descriptor_id(mode).map(BlendMode::layer_key)
}

/// One point of a contour, on Photoshop's 0–255 grid.
#[derive(Debug, Clone, Copy, PartialEq)]
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
pub struct ContourPoint {
    pub x: f32,
    pub y: f32,
    /// A corner (the curve bends here) rather than a smooth point.
    #[cfg_attr(feature = "serde", serde(default))]
    pub corner: bool,
}

/// A CONTOUR: the transfer curve an effect's falloff passes through
/// (Photoshop's `ShpC`).
#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(
    feature = "serde",
    derive(Serialize, Deserialize),
    serde(default, rename_all = "camelCase")
)]
pub struct Contour {
    pub name: String,
    pub points: Vec<ContourPoint>,
}

impl Default for Contour {
    fn default() -> Self {
        Contour::linear()
    }
}

impl Contour {
    /// Photoshop's "Linear": the identity.
    pub fn linear() -> Contour {
        Contour {
            name: "Linear".into(),
            points: vec![
                ContourPoint {
                    x: 0.0,
                    y: 0.0,
                    corner: false,
                },
                ContourPoint {
                    x: 255.0,
                    y: 255.0,
                    corner: false,
                },
            ],
        }
    }

    pub fn is_linear(&self) -> bool {
        self.points.len() == 2
            && self.points[0].x == 0.0
            && self.points[0].y == 0.0
            && self.points[1].x == 255.0
            && self.points[1].y == 255.0
    }

    /// The curve at 256 evenly spaced inputs, each in `[0, 1]`: a natural
    /// cubic spline through the points (the Curves dialog's curve,
    /// `paged_pixel::curve_natural_f32`), split at every corner point into
    /// pieces that each are such a spline.
    pub fn lut(&self) -> [f32; 256] {
        let mut pts: Vec<ContourPoint> = self.points.clone();
        pts.sort_by(|a, b| a.x.total_cmp(&b.x));
        if pts.len() < 2 {
            return paged_pixel::curve_natural_f32(&[]);
        }
        let norm = |p: &ContourPoint| (p.x / 255.0, p.y / 255.0);
        // Pieces between corners (a corner ends one piece and starts the
        // next); the end points are corners by construction.
        let mut cuts = vec![0usize];
        for (i, p) in pts.iter().enumerate().take(pts.len() - 1).skip(1) {
            if p.corner {
                cuts.push(i);
            }
        }
        cuts.push(pts.len() - 1);
        let mut out = [0.0f32; 256];
        let first = norm(&pts[0]);
        let last = norm(&pts[pts.len() - 1]);
        for (k, slot) in out.iter_mut().enumerate() {
            let x = k as f32 / 255.0;
            *slot = if x <= first.0 {
                first.1
            } else if x >= last.0 {
                last.1
            } else {
                0.0
            };
        }
        for w in cuts.windows(2) {
            let piece: Vec<(f32, f32)> = pts[w[0]..=w[1]].iter().map(norm).collect();
            let lut = paged_pixel::curve_natural_f32(&piece);
            let (x0, x1) = (piece[0].0, piece[piece.len() - 1].0);
            for (k, slot) in out.iter_mut().enumerate() {
                let x = k as f32 / 255.0;
                if x >= x0 && x <= x1 {
                    *slot = lut[k];
                }
            }
        }
        out
    }
}

/// A colour stop of a gradient: position 0–1, colour, and the midpoint
/// (0–1) toward the next stop.
#[derive(Debug, Clone, Copy, PartialEq)]
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
pub struct GradientColorStop {
    pub at: f32,
    pub rgb: [u8; 3],
    #[cfg_attr(feature = "serde", serde(default = "half"))]
    pub midpoint: f32,
}

/// An opacity stop: position 0–1, opacity 0–1, midpoint 0–1.
#[derive(Debug, Clone, Copy, PartialEq)]
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
pub struct GradientOpacityStop {
    pub at: f32,
    pub opacity: f32,
    #[cfg_attr(feature = "serde", serde(default = "half"))]
    pub midpoint: f32,
}

#[cfg(feature = "serde")]
fn half() -> f32 {
    0.5
}

/// A gradient (Photoshop's `Grdn`, the solid kind): colour and opacity
/// stops.
#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(
    feature = "serde",
    derive(Serialize, Deserialize),
    serde(default, rename_all = "camelCase")
)]
pub struct Gradient {
    pub name: String,
    /// Smoothness, 0–100 % (`Intr` on 0–4096).
    pub smoothness: f32,
    pub stops: Vec<GradientColorStop>,
    pub opacity_stops: Vec<GradientOpacityStop>,
    #[cfg_attr(feature = "serde", serde(skip))]
    pub source: Option<Descriptor>,
}

impl Default for Gradient {
    fn default() -> Self {
        Gradient::two([0, 0, 0], [255, 255, 255])
    }
}

impl Gradient {
    /// From `a` to `b`, both opaque.
    pub fn two(a: [u8; 3], b: [u8; 3]) -> Gradient {
        Gradient {
            name: "Custom".into(),
            smoothness: 100.0,
            stops: vec![
                GradientColorStop {
                    at: 0.0,
                    rgb: a,
                    midpoint: 0.5,
                },
                GradientColorStop {
                    at: 1.0,
                    rgb: b,
                    midpoint: 0.5,
                },
            ],
            opacity_stops: vec![
                GradientOpacityStop {
                    at: 0.0,
                    opacity: 1.0,
                    midpoint: 0.5,
                },
                GradientOpacityStop {
                    at: 1.0,
                    opacity: 1.0,
                    midpoint: 0.5,
                },
            ],
            source: None,
        }
    }

    /// The gradient at 256 evenly spaced positions as straight
    /// `[r, g, b, a]` in `[0, 1]`, `reverse`d when asked. Between two stops
    /// the blend reaches one half at the midpoint (piecewise linear on
    /// either side of it), eased by the smoothness.
    pub fn lut(&self, reverse: bool) -> [[f32; 4]; 256] {
        fn ramp<const N: usize>(
            stops: &[(f32, [f32; N], f32)],
            t: f32,
            fallback: [f32; N],
            ease: f32,
        ) -> [f32; N] {
            if stops.is_empty() {
                return fallback;
            }
            let first = &stops[0];
            let last = &stops[stops.len() - 1];
            if t <= first.0 {
                return first.1;
            }
            if t >= last.0 {
                return last.1;
            }
            for w in stops.windows(2) {
                let (a, b) = (&w[0], &w[1]);
                if t >= a.0 && t <= b.0 {
                    let span = (b.0 - a.0).max(1e-6);
                    let u = (t - a.0) / span;
                    let m = a.2.clamp(0.01, 0.99);
                    let f = if u <= m {
                        0.5 * u / m
                    } else {
                        0.5 + 0.5 * (u - m) / (1.0 - m)
                    };
                    // SMOOTHNESS eases each segment: half way to a
                    // smoothstep at 100 % (fitted to Photoshop's own
                    // black-to-white overlay within a level).
                    let f = f + ease * (f * f * (3.0 - 2.0 * f) - f);
                    let mut out = a.1;
                    for (o, (x, y)) in out.iter_mut().zip(a.1.iter().zip(b.1.iter())) {
                        *o = x + (y - x) * f;
                    }
                    return out;
                }
            }
            last.1
        }
        let mut colors: Vec<(f32, [f32; 3], f32)> = self
            .stops
            .iter()
            .map(|s| (s.at, s.rgb.map(|v| f32::from(v) / 255.0), s.midpoint))
            .collect();
        colors.sort_by(|a, b| a.0.total_cmp(&b.0));
        let mut alphas: Vec<(f32, [f32; 1], f32)> = self
            .opacity_stops
            .iter()
            .map(|s| (s.at, [s.opacity], s.midpoint))
            .collect();
        alphas.sort_by(|a, b| a.0.total_cmp(&b.0));
        let ease = 0.5 * (self.smoothness / 100.0).clamp(0.0, 1.0);
        std::array::from_fn(|i| {
            let t = i as f32 / 255.0;
            let t = if reverse { 1.0 - t } else { t };
            let c = ramp(&colors, t, [t, t, t], ease);
            let a = ramp(&alphas, t, [1.0], ease);
            [c[0], c[1], c[2], a[0]]
        })
    }
}

/// The shape a gradient is drawn in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
#[cfg_attr(
    feature = "serde",
    derive(Serialize, Deserialize),
    serde(rename_all = "snake_case")
)]
pub enum GradientStyle {
    #[default]
    Linear,
    Radial,
    Angle,
    Reflected,
    Diamond,
}

impl GradientStyle {
    fn code(self) -> &'static [u8] {
        match self {
            GradientStyle::Linear => b"Lnr ",
            GradientStyle::Radial => b"Rdl ",
            GradientStyle::Angle => b"Angl",
            GradientStyle::Reflected => b"Rflc",
            GradientStyle::Diamond => b"Dmnd",
        }
    }

    fn from_code(c: &[u8]) -> GradientStyle {
        match c {
            b"Rdl " | b"radial" => GradientStyle::Radial,
            b"Angl" | b"angle" => GradientStyle::Angle,
            b"Rflc" | b"reflected" => GradientStyle::Reflected,
            b"Dmnd" | b"diamond" => GradientStyle::Diamond,
            _ => GradientStyle::Linear,
        }
    }
}

/// A gradient as an overlay or a stroke draws it.
#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(
    feature = "serde",
    derive(Serialize, Deserialize),
    serde(default, rename_all = "camelCase")
)]
pub struct GradientFill {
    pub gradient: Gradient,
    pub style: GradientStyle,
    /// Degrees, counter-clockwise from 3 o'clock.
    pub angle: f32,
    /// Percent.
    pub scale: f32,
    pub reverse: bool,
    pub dither: bool,
    /// Align with Layer: the gradient spans the layer's bounds, not the
    /// canvas.
    pub align: bool,
    /// The centre's offset, percent of the span (x, y).
    pub offset: (f32, f32),
}

impl Default for GradientFill {
    fn default() -> Self {
        GradientFill {
            gradient: Gradient::default(),
            style: GradientStyle::Linear,
            angle: 90.0,
            scale: 100.0,
            reverse: false,
            dither: false,
            align: true,
            offset: (0.0, 0.0),
        }
    }
}

/// A pattern as a style refers to it: its name and the id it is known by
/// in the document's or the application's pattern list.
#[derive(Debug, Clone, PartialEq, Default)]
#[cfg_attr(
    feature = "serde",
    derive(Serialize, Deserialize),
    serde(default, rename_all = "camelCase")
)]
pub struct PatternRef {
    pub name: String,
    pub id: String,
}

/// A pattern as an overlay, a stroke or a bevel texture draws it.
#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(
    feature = "serde",
    derive(Serialize, Deserialize),
    serde(default, rename_all = "camelCase")
)]
pub struct PatternFill {
    pub pattern: PatternRef,
    /// Percent.
    pub scale: f32,
    /// Link with Layer: the pattern moves with the layer.
    pub link: bool,
    /// The pattern's origin offset, pixels.
    pub phase: (f32, f32),
}

impl Default for PatternFill {
    fn default() -> Self {
        PatternFill {
            pattern: PatternRef::default(),
            scale: 100.0,
            link: true,
            phase: (0.0, 0.0),
        }
    }
}

// ───────────────────────────── the effects ─────────────────────────────

/// Drop Shadow and Inner Shadow (`DrSh`, `IrSh`).
#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(
    feature = "serde",
    derive(Serialize, Deserialize),
    serde(default, rename_all = "camelCase")
)]
pub struct Shadow {
    pub enabled: bool,
    pub blend: BlendMode,
    pub color: [u8; 3],
    /// Percent.
    pub opacity: f32,
    pub use_global_light: bool,
    /// Degrees (the light's direction; the shadow falls opposite).
    pub angle: f32,
    /// Pixels.
    pub distance: f32,
    /// Spread (drop) or Choke (inner), percent of the size.
    pub spread: f32,
    /// Pixels.
    pub size: f32,
    /// Percent.
    pub noise: f32,
    pub contour: Contour,
    pub anti_aliased: bool,
    /// Layer Knocks Out Drop Shadow (drop shadows only).
    pub knocks_out: bool,
    #[cfg_attr(feature = "serde", serde(skip))]
    pub source: Option<Descriptor>,
}

impl Shadow {
    /// Photoshop's defaults for a new Drop Shadow.
    pub fn drop_default() -> Shadow {
        Shadow {
            enabled: true,
            blend: BlendMode::Multiply,
            color: [0, 0, 0],
            opacity: 35.0,
            use_global_light: true,
            angle: 120.0,
            distance: 3.0,
            spread: 0.0,
            size: 7.0,
            noise: 0.0,
            contour: Contour::linear(),
            anti_aliased: false,
            knocks_out: true,
            source: None,
        }
    }

    /// Photoshop's defaults for a new Inner Shadow.
    pub fn inner_default() -> Shadow {
        Shadow {
            knocks_out: false,
            ..Shadow::drop_default()
        }
    }
}

impl Default for Shadow {
    fn default() -> Self {
        Shadow::drop_default()
    }
}

/// How a glow's falloff is made: blurred (Softer) or by distance
/// (Precise).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
#[cfg_attr(
    feature = "serde",
    derive(Serialize, Deserialize),
    serde(rename_all = "snake_case")
)]
pub enum GlowTechnique {
    #[default]
    Softer,
    Precise,
}

/// Where an Inner Glow starts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
#[cfg_attr(
    feature = "serde",
    derive(Serialize, Deserialize),
    serde(rename_all = "snake_case")
)]
pub enum GlowSource {
    Center,
    #[default]
    Edge,
}

/// A glow's fill: one colour, or a gradient across the falloff.
#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(
    feature = "serde",
    derive(Serialize, Deserialize),
    serde(tag = "kind", rename_all = "snake_case")
)]
pub enum GlowFill {
    Color { rgb: [u8; 3] },
    Gradient { gradient: Gradient },
}

/// Outer Glow and Inner Glow (`OrGl`, `IrGl`).
#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(
    feature = "serde",
    derive(Serialize, Deserialize),
    serde(default, rename_all = "camelCase")
)]
pub struct Glow {
    pub enabled: bool,
    pub blend: BlendMode,
    pub fill: GlowFill,
    /// Percent.
    pub opacity: f32,
    pub technique: GlowTechnique,
    /// Spread (outer) or Choke (inner), percent.
    pub spread: f32,
    /// Pixels.
    pub size: f32,
    /// Percent.
    pub range: f32,
    /// Percent (a gradient's colours vary by it).
    pub jitter: f32,
    /// Percent.
    pub noise: f32,
    pub contour: Contour,
    pub anti_aliased: bool,
    /// Inner Glow only.
    pub source: GlowSource,
    #[cfg_attr(feature = "serde", serde(skip))]
    pub descriptor: Option<Descriptor>,
}

impl Default for Glow {
    fn default() -> Self {
        Glow {
            enabled: true,
            blend: BlendMode::Screen,
            fill: GlowFill::Color {
                rgb: [255, 255, 190],
            },
            opacity: 75.0,
            technique: GlowTechnique::Softer,
            spread: 0.0,
            size: 5.0,
            range: 50.0,
            jitter: 0.0,
            noise: 0.0,
            contour: Contour::linear(),
            anti_aliased: false,
            source: GlowSource::Edge,
            descriptor: None,
        }
    }
}

/// Bevel & Emboss's style.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
#[cfg_attr(
    feature = "serde",
    derive(Serialize, Deserialize),
    serde(rename_all = "snake_case")
)]
pub enum BevelStyle {
    OuterBevel,
    #[default]
    InnerBevel,
    Emboss,
    PillowEmboss,
    StrokeEmboss,
}

/// Bevel & Emboss's technique.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
#[cfg_attr(
    feature = "serde",
    derive(Serialize, Deserialize),
    serde(rename_all = "snake_case")
)]
pub enum BevelTechnique {
    #[default]
    Smooth,
    ChiselHard,
    ChiselSoft,
}

/// Bevel & Emboss's Texture pane.
#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(
    feature = "serde",
    derive(Serialize, Deserialize),
    serde(default, rename_all = "camelCase")
)]
pub struct BevelTexture {
    pub enabled: bool,
    pub fill: PatternFill,
    /// Percent, −1000…1000.
    pub depth: f32,
    pub invert: bool,
}

impl Default for BevelTexture {
    fn default() -> Self {
        BevelTexture {
            enabled: true,
            fill: PatternFill::default(),
            depth: 100.0,
            invert: false,
        }
    }
}

/// Bevel & Emboss's Contour pane.
#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(
    feature = "serde",
    derive(Serialize, Deserialize),
    serde(default, rename_all = "camelCase")
)]
pub struct BevelContour {
    pub enabled: bool,
    pub contour: Contour,
    pub anti_aliased: bool,
    /// Percent.
    pub range: f32,
}

impl Default for BevelContour {
    fn default() -> Self {
        BevelContour {
            enabled: true,
            contour: Contour::linear(),
            anti_aliased: false,
            range: 50.0,
        }
    }
}

/// One of Bevel & Emboss's two lights' colour, mode and opacity.
#[derive(Debug, Clone, Copy, PartialEq)]
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
pub struct BevelLight {
    pub blend: BlendMode,
    pub color: [u8; 3],
    /// Percent.
    pub opacity: f32,
}

/// Bevel & Emboss (`ebbl`).
#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(
    feature = "serde",
    derive(Serialize, Deserialize),
    serde(default, rename_all = "camelCase")
)]
pub struct Bevel {
    pub enabled: bool,
    pub style: BevelStyle,
    pub technique: BevelTechnique,
    /// Percent, 1–1000.
    pub depth: f32,
    /// Direction Down (the bevel sinks in).
    pub down: bool,
    /// Pixels.
    pub size: f32,
    /// Pixels.
    pub soften: f32,
    pub use_global_light: bool,
    pub angle: f32,
    /// Degrees above the horizon.
    pub altitude: f32,
    pub gloss: Contour,
    pub gloss_anti_aliased: bool,
    pub highlight: BevelLight,
    pub shadow: BevelLight,
    pub contour: Option<BevelContour>,
    pub texture: Option<BevelTexture>,
    #[cfg_attr(feature = "serde", serde(skip))]
    pub source: Option<Descriptor>,
}

impl Default for Bevel {
    fn default() -> Self {
        Bevel {
            enabled: true,
            style: BevelStyle::InnerBevel,
            technique: BevelTechnique::Smooth,
            depth: 100.0,
            down: false,
            size: 5.0,
            soften: 0.0,
            use_global_light: true,
            angle: 120.0,
            altitude: 30.0,
            gloss: Contour::linear(),
            gloss_anti_aliased: false,
            highlight: BevelLight {
                blend: BlendMode::Screen,
                color: [255, 255, 255],
                opacity: 75.0,
            },
            shadow: BevelLight {
                blend: BlendMode::Multiply,
                color: [0, 0, 0],
                opacity: 75.0,
            },
            contour: None,
            texture: None,
            source: None,
        }
    }
}

/// Satin (`ChFX`).
#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(
    feature = "serde",
    derive(Serialize, Deserialize),
    serde(default, rename_all = "camelCase")
)]
pub struct Satin {
    pub enabled: bool,
    pub blend: BlendMode,
    pub color: [u8; 3],
    /// Percent.
    pub opacity: f32,
    pub angle: f32,
    /// Pixels.
    pub distance: f32,
    /// Pixels.
    pub size: f32,
    pub contour: Contour,
    pub anti_aliased: bool,
    pub invert: bool,
    #[cfg_attr(feature = "serde", serde(skip))]
    pub source: Option<Descriptor>,
}

impl Default for Satin {
    fn default() -> Self {
        Satin {
            enabled: true,
            blend: BlendMode::Multiply,
            color: [0, 0, 0],
            opacity: 50.0,
            angle: 19.0,
            distance: 11.0,
            size: 14.0,
            contour: Contour::linear(),
            anti_aliased: false,
            invert: true,
            source: None,
        }
    }
}

/// Color Overlay (`SoFi`).
#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(
    feature = "serde",
    derive(Serialize, Deserialize),
    serde(default, rename_all = "camelCase")
)]
pub struct ColorFill {
    pub enabled: bool,
    pub blend: BlendMode,
    pub color: [u8; 3],
    /// The colour as INK (0–255 = 0–100 %), when the descriptor gives it
    /// in CMYK (`CMYC`), as in a CMYK document; `color` is then filled in
    /// by the importer through the document's ink transform.
    #[cfg_attr(feature = "serde", serde(skip))]
    pub cmyk: Option<[u8; 4]>,
    /// Percent.
    pub opacity: f32,
    #[cfg_attr(feature = "serde", serde(skip))]
    pub source: Option<Descriptor>,
}

impl Default for ColorFill {
    fn default() -> Self {
        ColorFill {
            enabled: true,
            blend: BlendMode::Normal,
            color: [255, 0, 0],
            cmyk: None,
            opacity: 100.0,
            source: None,
        }
    }
}

/// Gradient Overlay (`GrFl`).
#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(
    feature = "serde",
    derive(Serialize, Deserialize),
    serde(default, rename_all = "camelCase")
)]
pub struct GradientOverlay {
    pub enabled: bool,
    pub blend: BlendMode,
    /// Percent.
    pub opacity: f32,
    pub fill: GradientFill,
    #[cfg_attr(feature = "serde", serde(skip))]
    pub source: Option<Descriptor>,
}

impl Default for GradientOverlay {
    fn default() -> Self {
        GradientOverlay {
            enabled: true,
            blend: BlendMode::Normal,
            opacity: 100.0,
            fill: GradientFill::default(),
            source: None,
        }
    }
}

/// Pattern Overlay (`patternFill`).
#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(
    feature = "serde",
    derive(Serialize, Deserialize),
    serde(default, rename_all = "camelCase")
)]
pub struct PatternOverlay {
    pub enabled: bool,
    pub blend: BlendMode,
    /// Percent.
    pub opacity: f32,
    pub fill: PatternFill,
    #[cfg_attr(feature = "serde", serde(skip))]
    pub source: Option<Descriptor>,
}

impl Default for PatternOverlay {
    fn default() -> Self {
        PatternOverlay {
            enabled: true,
            blend: BlendMode::Normal,
            opacity: 100.0,
            fill: PatternFill::default(),
            source: None,
        }
    }
}

/// Where a stroke lies relative to the layer's edge.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
#[cfg_attr(
    feature = "serde",
    derive(Serialize, Deserialize),
    serde(rename_all = "snake_case")
)]
pub enum StrokePosition {
    #[default]
    Outside,
    Inside,
    Center,
}

/// What a stroke is filled with.
#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(
    feature = "serde",
    derive(Serialize, Deserialize),
    serde(tag = "kind", rename_all = "snake_case")
)]
pub enum StrokeFill {
    Color { rgb: [u8; 3] },
    Gradient(GradientFill),
    Pattern(PatternFill),
}

/// Stroke (`FrFX`).
#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(
    feature = "serde",
    derive(Serialize, Deserialize),
    serde(default, rename_all = "camelCase")
)]
pub struct Stroke {
    pub enabled: bool,
    pub position: StrokePosition,
    pub fill: StrokeFill,
    pub blend: BlendMode,
    /// Percent.
    pub opacity: f32,
    /// Pixels.
    pub size: f32,
    #[cfg_attr(feature = "serde", serde(skip))]
    pub source: Option<Descriptor>,
}

impl Default for Stroke {
    fn default() -> Self {
        Stroke {
            enabled: true,
            position: StrokePosition::Outside,
            fill: StrokeFill::Color { rgb: [0, 0, 0] },
            blend: BlendMode::Normal,
            opacity: 100.0,
            size: 3.0,
            source: None,
        }
    }
}

/// A layer's STYLE: every effect it carries, in Photoshop's units.
#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(
    feature = "serde",
    derive(Serialize, Deserialize),
    serde(default, rename_all = "camelCase")
)]
pub struct LayerStyle {
    /// The master switch (`masterFXSwitch`): off hides every effect.
    pub enabled: bool,
    /// Scale Effects, percent: sizes and distances are multiplied by it.
    pub scale: f32,
    pub drop_shadows: Vec<Shadow>,
    pub inner_shadows: Vec<Shadow>,
    pub outer_glow: Option<Glow>,
    pub inner_glow: Option<Glow>,
    pub bevel: Option<Bevel>,
    pub satin: Option<Satin>,
    pub color_overlays: Vec<ColorFill>,
    pub gradient_overlays: Vec<GradientOverlay>,
    pub pattern_overlay: Option<PatternOverlay>,
    pub strokes: Vec<Stroke>,
    #[cfg_attr(feature = "serde", serde(skip))]
    pub source: Option<Descriptor>,
}

impl Default for LayerStyle {
    fn default() -> Self {
        LayerStyle {
            enabled: true,
            scale: 100.0,
            drop_shadows: Vec::new(),
            inner_shadows: Vec::new(),
            outer_glow: None,
            inner_glow: None,
            bevel: None,
            satin: None,
            color_overlays: Vec::new(),
            gradient_overlays: Vec::new(),
            pattern_overlay: None,
            strokes: Vec::new(),
            source: None,
        }
    }
}

/// The effect kinds, by their descriptor key, in the order the Layer Style
/// dialog lists them.
pub const EFFECT_KEYS: &[&str] = &[
    "ebbl",
    "FrFX",
    "IrSh",
    "IrGl",
    "ChFX",
    "SoFi",
    "GrFl",
    "patternFill",
    "OrGl",
    "DrSh",
];

/// A layer record's STYLE: its `lmfx` block (several instances of an
/// effect) or else its `lfx2`, read; `None` without one or when it does
/// not parse.
pub fn layer_style(rec: &crate::model::LayerRecord) -> Option<LayerStyle> {
    let block = |k: &[u8; 4]| rec.addl.iter().find(|a| &a.key == k);
    // `lmfx` / `lfx2` keep a 4-byte length in a PSB too.
    let payload = block(b"lmfx")
        .or_else(|| block(b"lfx2"))?
        .payload(crate::Container::Psd);
    LayerStyle::parse(payload).ok()
}

impl LayerStyle {
    /// Is any effect drawn?
    pub fn draws(&self) -> bool {
        self.enabled && !self.enabled_keys().is_empty()
    }

    /// The keys of the enabled effects, in [`EFFECT_KEYS`] order.
    pub fn enabled_keys(&self) -> Vec<&'static str> {
        let on = |b: bool| b;
        let mut out = Vec::new();
        for k in EFFECT_KEYS {
            let any = match *k {
                "ebbl" => self.bevel.as_ref().is_some_and(|b| on(b.enabled)),
                "FrFX" => self.strokes.iter().any(|s| s.enabled),
                "IrSh" => self.inner_shadows.iter().any(|s| s.enabled),
                "IrGl" => self.inner_glow.as_ref().is_some_and(|g| g.enabled),
                "ChFX" => self.satin.as_ref().is_some_and(|s| s.enabled),
                "SoFi" => self.color_overlays.iter().any(|c| c.enabled),
                "GrFl" => self.gradient_overlays.iter().any(|g| g.enabled),
                "patternFill" => self.pattern_overlay.as_ref().is_some_and(|p| p.enabled),
                "OrGl" => self.outer_glow.as_ref().is_some_and(|g| g.enabled),
                "DrSh" => self.drop_shadows.iter().any(|s| s.enabled),
                _ => false,
            };
            if any {
                out.push(*k);
            }
        }
        out
    }

    /// Does the style draw anything that needs a pattern's pixels?
    pub fn uses_patterns(&self) -> bool {
        self.pattern_overlay.as_ref().is_some_and(|p| p.enabled)
            || self
                .strokes
                .iter()
                .any(|s| s.enabled && matches!(s.fill, StrokeFill::Pattern(_)))
            || self
                .bevel
                .as_ref()
                .is_some_and(|b| b.enabled && b.texture.as_ref().is_some_and(|t| t.enabled))
    }

    /// Does any kind carry more than one instance (the `lmfx` block)?
    pub fn is_multi(&self) -> bool {
        self.drop_shadows.len() > 1
            || self.inner_shadows.len() > 1
            || self.color_overlays.len() > 1
            || self.gradient_overlays.len() > 1
            || self.strokes.len() > 1
    }

    /// The additional-layer-info key this style is written under.
    pub fn block_key(&self) -> [u8; 4] {
        if self.is_multi() {
            *b"lmfx"
        } else {
            *b"lfx2"
        }
    }

    /// Carry each effect's source descriptor over from `old` (the style
    /// it replaces) where the new one has none — an edit made through the
    /// model keeps the keys the model does not carry.
    pub fn adopt_sources(&mut self, old: &LayerStyle) {
        fn each<T: Clone>(
            new: &mut [T],
            old: &[T],
            get: fn(&mut T) -> &mut Option<Descriptor>,
            read: fn(&T) -> &Option<Descriptor>,
        ) {
            for (n, o) in new.iter_mut().zip(old) {
                let slot = get(n);
                if slot.is_none() {
                    *slot = read(o).clone();
                }
            }
        }
        each(
            &mut self.drop_shadows,
            &old.drop_shadows,
            |s| &mut s.source,
            |s| &s.source,
        );
        each(
            &mut self.inner_shadows,
            &old.inner_shadows,
            |s| &mut s.source,
            |s| &s.source,
        );
        each(
            &mut self.color_overlays,
            &old.color_overlays,
            |s| &mut s.source,
            |s| &s.source,
        );
        each(
            &mut self.gradient_overlays,
            &old.gradient_overlays,
            |s| &mut s.source,
            |s| &s.source,
        );
        each(
            &mut self.strokes,
            &old.strokes,
            |s| &mut s.source,
            |s| &s.source,
        );
        if let (Some(n), Some(o)) = (&mut self.outer_glow, &old.outer_glow) {
            n.descriptor = n.descriptor.take().or_else(|| o.descriptor.clone());
        }
        if let (Some(n), Some(o)) = (&mut self.inner_glow, &old.inner_glow) {
            n.descriptor = n.descriptor.take().or_else(|| o.descriptor.clone());
        }
        if let (Some(n), Some(o)) = (&mut self.bevel, &old.bevel) {
            n.source = n.source.take().or_else(|| o.source.clone());
        }
        if let (Some(n), Some(o)) = (&mut self.satin, &old.satin) {
            n.source = n.source.take().or_else(|| o.source.clone());
        }
        if let (Some(n), Some(o)) = (&mut self.pattern_overlay, &old.pattern_overlay) {
            n.source = n.source.take().or_else(|| o.source.clone());
        }
        if self.source.is_none() {
            self.source = old.source.clone();
        }
    }

    /// Read an `lfx2` or `lmfx` payload (the bytes after the block
    /// length): a version word, then a versioned descriptor.
    pub fn parse(payload: &[u8]) -> Result<LayerStyle> {
        let mut r = ByteReader::new(payload);
        let _version = r.u32()?;
        let (_, d) = read_versioned_descriptor(&mut r)?;
        Ok(LayerStyle::from_descriptor(&d))
    }

    /// The block payload for this style (version word 0, then the
    /// versioned descriptor) — what [`parse`](Self::parse) reads.
    pub fn to_payload(&self) -> Vec<u8> {
        let mut out = 0u32.to_be_bytes().to_vec();
        write_versioned_descriptor(&mut out, &self.to_descriptor());
        out
    }

    pub fn from_descriptor(d: &Descriptor) -> LayerStyle {
        let mut s = LayerStyle {
            enabled: d.bool(b"masterFXSwitch").unwrap_or(true),
            scale: unit_any(d, b"Scl ").unwrap_or(100.0),
            source: Some(d.clone()),
            ..LayerStyle::default()
        };
        for (k, value) in &d.items {
            let name = k.text_lossy();
            let kind = match name.strip_suffix("Multi").unwrap_or(&name) {
                "solidFill" | "SoFi" => "SoFi",
                "frameFX" | "FrFX" => "FrFX",
                "gradientFill" | "GrFl" => "GrFl",
                "dropShadow" | "DrSh" => "DrSh",
                "innerShadow" | "IrSh" => "IrSh",
                "outerGlow" | "OrGl" => "OrGl",
                "innerGlow" | "IrGl" => "IrGl",
                "bevelEmboss" | "ebbl" => "ebbl",
                "chromeFX" | "ChFX" => "ChFX",
                "patternFill" => "patternFill",
                _ => continue,
            };
            let instances: Vec<&Descriptor> = match value {
                DescriptorValue::Descriptor(e) => vec![e],
                DescriptorValue::List(l) => l
                    .iter()
                    .filter_map(DescriptorValue::as_descriptor)
                    .collect(),
                _ => continue,
            };
            for e in instances {
                // `present: false` is the template Photoshop keeps for an
                // effect the user never added: not part of the style.
                if e.bool(b"present") == Some(false) && e.bool(b"enab") != Some(true) {
                    continue;
                }
                match kind {
                    "DrSh" => s.drop_shadows.push(read_shadow(e, true)),
                    "IrSh" => s.inner_shadows.push(read_shadow(e, false)),
                    "OrGl" => s.outer_glow = Some(read_glow(e)),
                    "IrGl" => s.inner_glow = Some(read_glow(e)),
                    "ebbl" => s.bevel = Some(read_bevel(e)),
                    "ChFX" => s.satin = Some(read_satin(e)),
                    "SoFi" => s.color_overlays.push(read_color_fill(e)),
                    "GrFl" => s.gradient_overlays.push(GradientOverlay {
                        enabled: on(e),
                        blend: blend_of(e, b"Md  "),
                        opacity: unit_any(e, b"Opct").unwrap_or(100.0),
                        fill: read_gradient_fill(e),
                        source: Some(e.clone()),
                    }),
                    "patternFill" => {
                        s.pattern_overlay = Some(PatternOverlay {
                            enabled: on(e),
                            blend: blend_of(e, b"Md  "),
                            opacity: unit_any(e, b"Opct").unwrap_or(100.0),
                            fill: read_pattern_fill(e),
                            source: Some(e.clone()),
                        })
                    }
                    "FrFX" => s.strokes.push(read_stroke(e)),
                    _ => {}
                }
            }
        }
        s
    }

    /// The descriptor of this style. Each effect starts from the
    /// descriptor it was read from, so keys the model does not carry
    /// survive; the modelled keys are set from the model.
    pub fn to_descriptor(&self) -> Descriptor {
        let mut items: Vec<(Key, DescriptorValue)> = vec![
            (key(b"Scl "), unit(b"#Prc", f64::from(self.scale))),
            (key(b"masterFXSwitch"), DescriptorValue::Bool(self.enabled)),
        ];
        let mut put = |single: &[u8], multi: &str, list: Vec<Descriptor>| {
            if list.is_empty() {
                return;
            }
            if list.len() == 1 && (!self.is_multi() || multi.is_empty()) {
                let d = list.into_iter().next().expect("one");
                items.push((key(single), DescriptorValue::Descriptor(d)));
            } else {
                items.push((
                    Key::long(multi),
                    DescriptorValue::List(
                        list.into_iter().map(DescriptorValue::Descriptor).collect(),
                    ),
                ));
            }
        };
        put(
            b"DrSh",
            "dropShadowMulti",
            self.drop_shadows
                .iter()
                .map(|s| write_shadow(s, b"DrSh", true))
                .collect(),
        );
        put(
            b"IrSh",
            "innerShadowMulti",
            self.inner_shadows
                .iter()
                .map(|s| write_shadow(s, b"IrSh", false))
                .collect(),
        );
        if let Some(g) = &self.outer_glow {
            put(b"OrGl", "", vec![write_glow(g, b"OrGl", false)]);
        }
        put(
            b"SoFi",
            "solidFillMulti",
            self.color_overlays.iter().map(write_color_fill).collect(),
        );
        put(
            b"GrFl",
            "gradientFillMulti",
            self.gradient_overlays
                .iter()
                .map(|g| {
                    let mut d = start(&g.source, b"GrFl");
                    set_common(&mut d, g.enabled);
                    set(&mut d, b"Md  ", blend_value(g.blend));
                    set(&mut d, b"Opct", unit(b"#Prc", f64::from(g.opacity)));
                    write_gradient_fill(&mut d, &g.fill);
                    d
                })
                .collect(),
        );
        if let Some(p) = &self.pattern_overlay {
            let mut d = start(&p.source, b"patternFill");
            set_common(&mut d, p.enabled);
            set(&mut d, b"Md  ", blend_value(p.blend));
            set(&mut d, b"Opct", unit(b"#Prc", f64::from(p.opacity)));
            write_pattern_fill(&mut d, &p.fill);
            put(b"patternFill", "", vec![d]);
        }
        put(
            b"FrFX",
            "frameFXMulti",
            self.strokes.iter().map(write_stroke).collect(),
        );
        if let Some(g) = &self.inner_glow {
            put(b"IrGl", "", vec![write_glow(g, b"IrGl", true)]);
        }
        if let Some(b) = &self.bevel {
            put(b"ebbl", "", vec![write_bevel(b)]);
        }
        if let Some(s) = &self.satin {
            put(b"ChFX", "", vec![write_satin(s)]);
        }
        let mut d = Descriptor {
            class_name: String::new(),
            class_id: key(b"null"),
            items,
        };
        if let Some(src) = &self.source {
            d.class_name.clone_from(&src.class_name);
            d.class_id = src.class_id.clone();
        }
        d
    }
}

/// The document's GLOBAL LIGHT: the angle and altitude every effect with
/// Use Global Light shares (image resources 1037 and 1049, each a 4-byte
/// integer of degrees [PUB]).
#[derive(Debug, Clone, Copy, PartialEq)]
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
pub struct GlobalLight {
    pub angle: f32,
    pub altitude: f32,
}

impl Default for GlobalLight {
    /// Photoshop's defaults when a document carries neither resource.
    fn default() -> Self {
        GlobalLight {
            angle: 120.0,
            altitude: 30.0,
        }
    }
}

/// Image resource id of the global angle.
pub const RES_GLOBAL_ANGLE: u16 = 1037;
/// Image resource id of the global altitude.
pub const RES_GLOBAL_ALTITUDE: u16 = 1049;

impl GlobalLight {
    /// The document's Global Light (defaults where a resource is absent).
    pub fn of(file: &crate::PsdFile) -> GlobalLight {
        let read = |id: u16| -> Option<f32> {
            let data = file.resources.data(id)?;
            let b: [u8; 4] = data.get(..4)?.try_into().ok()?;
            Some(i32::from_be_bytes(b) as f32)
        };
        let d = GlobalLight::default();
        GlobalLight {
            angle: read(RES_GLOBAL_ANGLE).unwrap_or(d.angle),
            altitude: read(RES_GLOBAL_ALTITUDE).unwrap_or(d.altitude),
        }
    }

    /// Write this light into `file`'s resources (replacing the two blocks
    /// or adding them).
    pub fn store(&self, file: &mut crate::PsdFile) {
        file.resources
            .set_data(RES_GLOBAL_ANGLE, &(self.angle.round() as i32).to_be_bytes());
        file.resources.set_data(
            RES_GLOBAL_ALTITUDE,
            &(self.altitude.round() as i32).to_be_bytes(),
        );
    }
}

// ───────────────────────────── reading ─────────────────────────────

fn on(e: &Descriptor) -> bool {
    e.bool(b"enab").unwrap_or(true) && e.bool(b"present").unwrap_or(true)
}

/// A unit float's value whatever its unit (Photoshop stores `Ckmt`, a
/// percentage, with the pixel unit [OBS]), or a plain number.
fn unit_any(d: &Descriptor, k: &[u8]) -> Option<f32> {
    let v = d.get(k)?;
    v.as_unit_float()
        .map(|(_, x)| x as f32)
        .or_else(|| v.as_number().map(|x| x as f32))
}

fn enum_id(d: &Descriptor, k: &[u8]) -> Option<String> {
    d.enum_value(k).map(|(_, v)| v.text_lossy())
}

fn blend_of(d: &Descriptor, k: &[u8]) -> BlendMode {
    enum_id(d, k)
        .and_then(|m| BlendMode::from_descriptor_id(&m))
        .unwrap_or_default()
}

/// An `RGBC` colour (or a `CMYC` one, whose inks are returned apart).
fn color_of(d: &Descriptor, k: &[u8]) -> ([u8; 3], Option<[u8; 4]>) {
    let Some(c) = d.descriptor(k) else {
        return ([0, 0, 0], None);
    };
    if c.class_id.matches(b"CMYC") {
        let ink = |k: &[u8]| {
            (c.number(k).unwrap_or(0.0) * 255.0 / 100.0)
                .round()
                .clamp(0.0, 255.0) as u8
        };
        return (
            [0, 0, 0],
            Some([ink(b"Cyn "), ink(b"Mgnt"), ink(b"Ylw "), ink(b"Blck")]),
        );
    }
    if c.class_id.matches(b"Grsc") {
        let g = (255.0 - c.number(b"Gry ").unwrap_or(0.0) * 255.0 / 100.0)
            .round()
            .clamp(0.0, 255.0) as u8;
        return ([g, g, g], None);
    }
    let ch = |k: &[u8]| c.number(k).unwrap_or(0.0).round().clamp(0.0, 255.0) as u8;
    ([ch(b"Rd  "), ch(b"Grn "), ch(b"Bl  ")], None)
}

fn read_contour(d: &Descriptor, k: &[u8]) -> Contour {
    let Some(c) = d.descriptor(k) else {
        return Contour::linear();
    };
    let points: Vec<ContourPoint> = c
        .list(b"Crv ")
        .unwrap_or(&[])
        .iter()
        .filter_map(DescriptorValue::as_descriptor)
        .map(|p| ContourPoint {
            x: p.number(b"Hrzn").unwrap_or(0.0) as f32,
            y: p.number(b"Vrtc").unwrap_or(0.0) as f32,
            corner: p.bool(b"Cnty") == Some(false),
        })
        .collect();
    if points.len() < 2 {
        return Contour::linear();
    }
    Contour {
        name: c.text(b"Nm  ").unwrap_or("Custom").to_string(),
        points,
    }
}

pub(crate) fn read_gradient(d: &Descriptor) -> Gradient {
    let loc = |s: &Descriptor| (s.number(b"Lctn").unwrap_or(0.0) / 4096.0).clamp(0.0, 1.0) as f32;
    let mid = |s: &Descriptor| (s.number(b"Mdpn").unwrap_or(50.0) / 100.0).clamp(0.0, 1.0) as f32;
    let stops = d
        .list(b"Clrs")
        .unwrap_or(&[])
        .iter()
        .filter_map(DescriptorValue::as_descriptor)
        .map(|s| GradientColorStop {
            at: loc(s),
            rgb: color_of(s, b"Clr ").0,
            midpoint: mid(s),
        })
        .collect();
    let opacity_stops = d
        .list(b"Trns")
        .unwrap_or(&[])
        .iter()
        .filter_map(DescriptorValue::as_descriptor)
        .map(|s| GradientOpacityStop {
            at: loc(s),
            opacity: (unit_any(s, b"Opct").unwrap_or(100.0) / 100.0).clamp(0.0, 1.0),
            midpoint: mid(s),
        })
        .collect();
    Gradient {
        name: d.text(b"Nm  ").unwrap_or("Custom").to_string(),
        smoothness: (d.number(b"Intr").unwrap_or(4096.0) / 4096.0 * 100.0) as f32,
        stops,
        opacity_stops,
        source: Some(d.clone()),
    }
}

fn read_gradient_fill(e: &Descriptor) -> GradientFill {
    let offset = e
        .descriptor(b"Ofst")
        .map(|o| {
            (
                unit_any(o, b"Hrzn").unwrap_or(0.0),
                unit_any(o, b"Vrtc").unwrap_or(0.0),
            )
        })
        .unwrap_or((0.0, 0.0));
    GradientFill {
        gradient: e.descriptor(b"Grad").map(read_gradient).unwrap_or_default(),
        style: e
            .enum_value(b"Type")
            .map(|(_, v)| GradientStyle::from_code(v.as_bytes()))
            .unwrap_or_default(),
        angle: unit_any(e, b"Angl").unwrap_or(90.0),
        scale: unit_any(e, b"Scl ").unwrap_or(100.0),
        reverse: e.bool(b"Rvrs").unwrap_or(false),
        dither: e.bool(b"Dthr").unwrap_or(false),
        align: e.bool(b"Algn").unwrap_or(true),
        offset,
    }
}

fn read_pattern_ref(e: &Descriptor) -> PatternRef {
    e.descriptor(b"Ptrn")
        .map(|p| PatternRef {
            name: p.text(b"Nm  ").unwrap_or("").to_string(),
            id: p.text(b"Idnt").unwrap_or("").to_string(),
        })
        .unwrap_or_default()
}

fn read_pattern_fill(e: &Descriptor) -> PatternFill {
    let phase = e
        .descriptor(b"phase")
        .map(|o| {
            (
                unit_any(o, b"Hrzn").unwrap_or(0.0),
                unit_any(o, b"Vrtc").unwrap_or(0.0),
            )
        })
        .unwrap_or((0.0, 0.0));
    PatternFill {
        pattern: read_pattern_ref(e),
        scale: unit_any(e, b"Scl ").unwrap_or(100.0),
        link: e.bool(b"Algn").unwrap_or(true),
        phase,
    }
}

fn read_shadow(e: &Descriptor, drop: bool) -> Shadow {
    Shadow {
        enabled: on(e),
        blend: blend_of(e, b"Md  "),
        color: color_of(e, b"Clr ").0,
        opacity: unit_any(e, b"Opct").unwrap_or(75.0),
        use_global_light: e.bool(b"uglg").unwrap_or(true),
        angle: unit_any(e, b"lagl").unwrap_or(120.0),
        distance: unit_any(e, b"Dstn").unwrap_or(5.0),
        spread: unit_any(e, b"Ckmt").unwrap_or(0.0),
        size: unit_any(e, b"blur").unwrap_or(5.0),
        noise: unit_any(e, b"Nose").unwrap_or(0.0),
        contour: read_contour(e, b"TrnS"),
        anti_aliased: e.bool(b"AntA").unwrap_or(false),
        knocks_out: drop && e.bool(b"layerConceals").unwrap_or(true),
        source: Some(e.clone()),
    }
}

fn read_glow(e: &Descriptor) -> Glow {
    let fill = match e.descriptor(b"Grad") {
        Some(g) => GlowFill::Gradient {
            gradient: read_gradient(g),
        },
        None => GlowFill::Color {
            rgb: color_of(e, b"Clr ").0,
        },
    };
    Glow {
        enabled: on(e),
        blend: blend_of(e, b"Md  "),
        fill,
        opacity: unit_any(e, b"Opct").unwrap_or(75.0),
        technique: match enum_id(e, b"GlwT").as_deref() {
            Some("PrBL") | Some("precise") => GlowTechnique::Precise,
            _ => GlowTechnique::Softer,
        },
        spread: unit_any(e, b"Ckmt").unwrap_or(0.0),
        size: unit_any(e, b"blur").unwrap_or(5.0),
        range: unit_any(e, b"Inpr").unwrap_or(50.0),
        jitter: unit_any(e, b"ShdN").unwrap_or(0.0),
        noise: unit_any(e, b"Nose").unwrap_or(0.0),
        contour: read_contour(e, b"TrnS"),
        anti_aliased: e.bool(b"AntA").unwrap_or(false),
        source: match enum_id(e, b"glwS").as_deref() {
            Some("SrcC") | Some("centerGlow") => GlowSource::Center,
            _ => GlowSource::Edge,
        },
        descriptor: Some(e.clone()),
    }
}

fn read_bevel(e: &Descriptor) -> Bevel {
    let light = |m: &[u8], c: &[u8], o: &[u8]| BevelLight {
        blend: blend_of(e, m),
        color: color_of(e, c).0,
        opacity: unit_any(e, o).unwrap_or(75.0),
    };
    Bevel {
        enabled: on(e),
        style: match enum_id(e, b"bvlS").as_deref() {
            Some("OtrB") | Some("outerBevel") => BevelStyle::OuterBevel,
            Some("Embs") | Some("emboss") => BevelStyle::Emboss,
            Some("PlEb") | Some("pillowEmboss") => BevelStyle::PillowEmboss,
            Some("strokeEmboss") => BevelStyle::StrokeEmboss,
            _ => BevelStyle::InnerBevel,
        },
        technique: match enum_id(e, b"bvlT").as_deref() {
            Some("PrBL") | Some("preciseMatte") => BevelTechnique::ChiselHard,
            Some("Slmt") | Some("slopeLimitMatte") => BevelTechnique::ChiselSoft,
            _ => BevelTechnique::Smooth,
        },
        depth: unit_any(e, b"srgR").unwrap_or(100.0),
        down: matches!(
            enum_id(e, b"bvlD").as_deref(),
            Some("Out ") | Some("stampOut")
        ),
        size: unit_any(e, b"blur").unwrap_or(5.0),
        soften: unit_any(e, b"Sftn").unwrap_or(0.0),
        use_global_light: e.bool(b"uglg").unwrap_or(true),
        angle: unit_any(e, b"lagl").unwrap_or(120.0),
        altitude: unit_any(e, b"Lald").unwrap_or(30.0),
        gloss: read_contour(e, b"TrnS"),
        gloss_anti_aliased: e.bool(b"antialiasGloss").unwrap_or(false),
        highlight: light(b"hglM", b"hglC", b"hglO"),
        shadow: light(b"sdwM", b"sdwC", b"sdwO"),
        contour: (e.bool(b"useShape") == Some(true) || e.contains(b"MpgS")).then(|| BevelContour {
            enabled: e.bool(b"useShape").unwrap_or(false),
            contour: read_contour(e, b"MpgS"),
            anti_aliased: e.bool(b"AntA").unwrap_or(false),
            range: unit_any(e, b"Inpr").unwrap_or(50.0),
        }),
        texture: (e.bool(b"useTexture") == Some(true) || e.contains(b"Ptrn")).then(|| {
            BevelTexture {
                enabled: e.bool(b"useTexture").unwrap_or(false),
                fill: PatternFill {
                    pattern: read_pattern_ref(e),
                    scale: unit_any(e, b"Scl ").unwrap_or(100.0),
                    link: e.bool(b"Algn").unwrap_or(true),
                    phase: e
                        .descriptor(b"phase")
                        .map(|o| {
                            (
                                unit_any(o, b"Hrzn").unwrap_or(0.0),
                                unit_any(o, b"Vrtc").unwrap_or(0.0),
                            )
                        })
                        .unwrap_or((0.0, 0.0)),
                },
                depth: unit_any(e, b"textureDepth").unwrap_or(100.0),
                invert: e.bool(b"InvT").unwrap_or(false),
            }
        }),
        source: Some(e.clone()),
    }
}

fn read_satin(e: &Descriptor) -> Satin {
    Satin {
        enabled: on(e),
        blend: blend_of(e, b"Md  "),
        color: color_of(e, b"Clr ").0,
        opacity: unit_any(e, b"Opct").unwrap_or(50.0),
        angle: unit_any(e, b"lagl").unwrap_or(19.0),
        distance: unit_any(e, b"Dstn").unwrap_or(11.0),
        size: unit_any(e, b"blur").unwrap_or(14.0),
        contour: read_contour(e, b"MpgS"),
        anti_aliased: e.bool(b"AntA").unwrap_or(false),
        invert: e.bool(b"Invr").unwrap_or(true),
        source: Some(e.clone()),
    }
}

fn read_color_fill(e: &Descriptor) -> ColorFill {
    let (color, cmyk) = color_of(e, b"Clr ");
    ColorFill {
        enabled: on(e),
        blend: blend_of(e, b"Md  "),
        color,
        cmyk,
        opacity: unit_any(e, b"Opct").unwrap_or(100.0),
        source: Some(e.clone()),
    }
}

fn read_stroke(e: &Descriptor) -> Stroke {
    let fill = match enum_id(e, b"PntT").as_deref() {
        Some("GrFl") | Some("gradientFill") => StrokeFill::Gradient(read_gradient_fill(e)),
        Some("Ptrn") | Some("pattern") => StrokeFill::Pattern(read_pattern_fill(e)),
        _ => StrokeFill::Color {
            rgb: color_of(e, b"Clr ").0,
        },
    };
    Stroke {
        enabled: on(e),
        position: match enum_id(e, b"Styl").as_deref() {
            Some("InsF") | Some("insetFrame") => StrokePosition::Inside,
            Some("CtrF") | Some("centeredFrame") => StrokePosition::Center,
            _ => StrokePosition::Outside,
        },
        fill,
        blend: blend_of(e, b"Md  "),
        opacity: unit_any(e, b"Opct").unwrap_or(100.0),
        size: unit_any(e, b"Sz  ").unwrap_or(3.0),
        source: Some(e.clone()),
    }
}

// ───────────────────────────── writing ─────────────────────────────

/// Start an effect's descriptor: the one it was read from, or a fresh one
/// of `class`.
fn start(source: &Option<Descriptor>, class: &[u8]) -> Descriptor {
    source.clone().unwrap_or_else(|| Descriptor {
        class_name: String::new(),
        class_id: key(class),
        items: Vec::new(),
    })
}

/// Set `k` to `v`: in place when the key is there, appended otherwise.
fn set(d: &mut Descriptor, k: &[u8], v: DescriptorValue) {
    match d.items.iter_mut().find(|(key, _)| key.matches(k)) {
        Some(slot) => slot.1 = v,
        None => d.items.push((key(k), v)),
    }
}

fn remove(d: &mut Descriptor, k: &[u8]) {
    d.items.retain(|(key, _)| !key.matches(k));
}

fn set_common(d: &mut Descriptor, enabled: bool) {
    set(d, b"enab", DescriptorValue::Bool(enabled));
    set(d, b"present", DescriptorValue::Bool(true));
    if !d.contains(b"showInDialog") {
        set(d, b"showInDialog", DescriptorValue::Bool(true));
    }
}

fn blend_value(b: BlendMode) -> DescriptorValue {
    DescriptorValue::Enum {
        type_key: key(b"BlnM"),
        value: Key::long(b.descriptor_id()),
    }
}

fn contour_value(c: &Contour) -> DescriptorValue {
    obj(
        b"ShpC",
        vec![
            (b"Nm  ", DescriptorValue::Text(c.name.clone())),
            (
                b"Crv ",
                DescriptorValue::List(
                    c.points
                        .iter()
                        .map(|p| {
                            let mut items = vec![
                                (&b"Hrzn"[..], DescriptorValue::Double(f64::from(p.x))),
                                (&b"Vrtc"[..], DescriptorValue::Double(f64::from(p.y))),
                            ];
                            if p.corner {
                                items.push((&b"Cnty"[..], DescriptorValue::Bool(false)));
                            }
                            obj(b"CrPt", items)
                        })
                        .collect(),
                ),
            ),
        ],
    )
}

pub(crate) fn gradient_value(g: &Gradient) -> DescriptorValue {
    let mut d = start(&g.source, b"Grdn");
    set(&mut d, b"Nm  ", DescriptorValue::Text(g.name.clone()));
    set(&mut d, b"GrdF", en(b"GrdF", b"CstS"));
    set(
        &mut d,
        b"Intr",
        DescriptorValue::Double(f64::from(g.smoothness) / 100.0 * 4096.0),
    );
    let loc = |at: f32| DescriptorValue::Integer((at.clamp(0.0, 1.0) * 4096.0).round() as i32);
    let mid = |m: f32| DescriptorValue::Integer((m.clamp(0.0, 1.0) * 100.0).round() as i32);
    set(
        &mut d,
        b"Clrs",
        DescriptorValue::List(
            g.stops
                .iter()
                .map(|s| {
                    obj(
                        b"Clrt",
                        vec![
                            (b"Clr ", rgb_value(s.rgb)),
                            (b"Type", en(b"Clry", b"UsrS")),
                            (b"Lctn", loc(s.at)),
                            (b"Mdpn", mid(s.midpoint)),
                        ],
                    )
                })
                .collect(),
        ),
    );
    set(
        &mut d,
        b"Trns",
        DescriptorValue::List(
            g.opacity_stops
                .iter()
                .map(|s| {
                    obj(
                        b"TrnS",
                        vec![
                            (b"Opct", unit(b"#Prc", f64::from(s.opacity) * 100.0)),
                            (b"Lctn", loc(s.at)),
                            (b"Mdpn", mid(s.midpoint)),
                        ],
                    )
                })
                .collect(),
        ),
    );
    DescriptorValue::Descriptor(d)
}

fn write_gradient_fill(d: &mut Descriptor, g: &GradientFill) {
    set(d, b"Grad", gradient_value(&g.gradient));
    set(d, b"Angl", unit(b"#Ang", f64::from(g.angle)));
    set(d, b"Type", en(b"GrdT", g.style.code()));
    set(d, b"Rvrs", DescriptorValue::Bool(g.reverse));
    set(d, b"Dthr", DescriptorValue::Bool(g.dither));
    set(d, b"Algn", DescriptorValue::Bool(g.align));
    set(d, b"Scl ", unit(b"#Prc", f64::from(g.scale)));
    set(
        d,
        b"Ofst",
        obj(
            b"Pnt ",
            vec![
                (b"Hrzn", unit(b"#Prc", f64::from(g.offset.0))),
                (b"Vrtc", unit(b"#Prc", f64::from(g.offset.1))),
            ],
        ),
    );
}

fn pattern_ref_value(p: &PatternRef) -> DescriptorValue {
    obj(
        b"Ptrn",
        vec![
            (b"Nm  ", DescriptorValue::Text(p.name.clone())),
            (b"Idnt", DescriptorValue::Text(p.id.clone())),
        ],
    )
}

fn write_pattern_fill(d: &mut Descriptor, p: &PatternFill) {
    set(d, b"Ptrn", pattern_ref_value(&p.pattern));
    set(d, b"Scl ", unit(b"#Prc", f64::from(p.scale)));
    set(d, b"Algn", DescriptorValue::Bool(p.link));
    set(
        d,
        b"phase",
        obj(
            b"Pnt ",
            vec![
                (b"Hrzn", DescriptorValue::Double(f64::from(p.phase.0))),
                (b"Vrtc", DescriptorValue::Double(f64::from(p.phase.1))),
            ],
        ),
    );
}

fn write_shadow(s: &Shadow, class: &[u8], drop: bool) -> Descriptor {
    let mut d = start(&s.source, class);
    set_common(&mut d, s.enabled);
    set(&mut d, b"Md  ", blend_value(s.blend));
    set(&mut d, b"Clr ", rgb_value(s.color));
    set(&mut d, b"Opct", unit(b"#Prc", f64::from(s.opacity)));
    set(&mut d, b"uglg", DescriptorValue::Bool(s.use_global_light));
    set(&mut d, b"lagl", unit(b"#Ang", f64::from(s.angle)));
    set(&mut d, b"Dstn", unit(b"#Pxl", f64::from(s.distance)));
    set(&mut d, b"Ckmt", unit(b"#Pxl", f64::from(s.spread)));
    set(&mut d, b"blur", unit(b"#Pxl", f64::from(s.size)));
    set(&mut d, b"Nose", unit(b"#Prc", f64::from(s.noise)));
    set(&mut d, b"AntA", DescriptorValue::Bool(s.anti_aliased));
    set(&mut d, b"TrnS", contour_value(&s.contour));
    if drop {
        set(
            &mut d,
            b"layerConceals",
            DescriptorValue::Bool(s.knocks_out),
        );
    }
    d
}

fn write_glow(g: &Glow, class: &[u8], inner: bool) -> Descriptor {
    let mut d = start(&g.descriptor, class);
    set_common(&mut d, g.enabled);
    set(&mut d, b"Md  ", blend_value(g.blend));
    match &g.fill {
        GlowFill::Color { rgb } => {
            remove(&mut d, b"Grad");
            set(&mut d, b"Clr ", rgb_value(*rgb));
        }
        GlowFill::Gradient { gradient } => {
            remove(&mut d, b"Clr ");
            set(&mut d, b"Grad", gradient_value(gradient));
        }
    }
    set(&mut d, b"Opct", unit(b"#Prc", f64::from(g.opacity)));
    set(
        &mut d,
        b"GlwT",
        en(
            b"BETE",
            match g.technique {
                GlowTechnique::Softer => b"SfBL",
                GlowTechnique::Precise => b"PrBL",
            },
        ),
    );
    set(&mut d, b"Ckmt", unit(b"#Pxl", f64::from(g.spread)));
    set(&mut d, b"blur", unit(b"#Pxl", f64::from(g.size)));
    set(&mut d, b"Nose", unit(b"#Prc", f64::from(g.noise)));
    set(&mut d, b"ShdN", unit(b"#Prc", f64::from(g.jitter)));
    set(&mut d, b"AntA", DescriptorValue::Bool(g.anti_aliased));
    set(&mut d, b"TrnS", contour_value(&g.contour));
    set(&mut d, b"Inpr", unit(b"#Prc", f64::from(g.range)));
    if inner {
        set(
            &mut d,
            b"glwS",
            en(
                b"IGSr",
                match g.source {
                    GlowSource::Center => b"SrcC",
                    GlowSource::Edge => b"SrcE",
                },
            ),
        );
    }
    d
}

fn write_bevel(b: &Bevel) -> Descriptor {
    let mut d = start(&b.source, b"ebbl");
    set_common(&mut d, b.enabled);
    set(&mut d, b"hglM", blend_value(b.highlight.blend));
    set(&mut d, b"hglC", rgb_value(b.highlight.color));
    set(
        &mut d,
        b"hglO",
        unit(b"#Prc", f64::from(b.highlight.opacity)),
    );
    set(&mut d, b"sdwM", blend_value(b.shadow.blend));
    set(&mut d, b"sdwC", rgb_value(b.shadow.color));
    set(&mut d, b"sdwO", unit(b"#Prc", f64::from(b.shadow.opacity)));
    set(
        &mut d,
        b"bvlT",
        en(
            b"bvlT",
            match b.technique {
                BevelTechnique::Smooth => b"SfBL",
                BevelTechnique::ChiselHard => b"PrBL",
                BevelTechnique::ChiselSoft => b"Slmt",
            },
        ),
    );
    let style: &[u8] = match b.style {
        BevelStyle::OuterBevel => b"OtrB",
        BevelStyle::InnerBevel => b"InrB",
        BevelStyle::Emboss => b"Embs",
        BevelStyle::PillowEmboss => b"PlEb",
        BevelStyle::StrokeEmboss => b"strokeEmboss",
    };
    set(&mut d, b"bvlS", en(b"BESl", style));
    set(&mut d, b"uglg", DescriptorValue::Bool(b.use_global_light));
    set(&mut d, b"lagl", unit(b"#Ang", f64::from(b.angle)));
    set(&mut d, b"Lald", unit(b"#Ang", f64::from(b.altitude)));
    set(&mut d, b"srgR", unit(b"#Prc", f64::from(b.depth)));
    set(&mut d, b"blur", unit(b"#Pxl", f64::from(b.size)));
    set(
        &mut d,
        b"bvlD",
        en(b"BESs", if b.down { b"Out " } else { b"In  " }),
    );
    set(&mut d, b"TrnS", contour_value(&b.gloss));
    set(
        &mut d,
        b"antialiasGloss",
        DescriptorValue::Bool(b.gloss_anti_aliased),
    );
    set(&mut d, b"Sftn", unit(b"#Pxl", f64::from(b.soften)));
    match &b.contour {
        Some(c) => {
            set(&mut d, b"useShape", DescriptorValue::Bool(c.enabled));
            set(&mut d, b"MpgS", contour_value(&c.contour));
            set(&mut d, b"AntA", DescriptorValue::Bool(c.anti_aliased));
            set(&mut d, b"Inpr", unit(b"#Prc", f64::from(c.range)));
        }
        None => set(&mut d, b"useShape", DescriptorValue::Bool(false)),
    }
    match &b.texture {
        Some(t) => {
            set(&mut d, b"useTexture", DescriptorValue::Bool(t.enabled));
            set(&mut d, b"Ptrn", pattern_ref_value(&t.fill.pattern));
            set(&mut d, b"Scl ", unit(b"#Prc", f64::from(t.fill.scale)));
            set(&mut d, b"textureDepth", unit(b"#Prc", f64::from(t.depth)));
            set(&mut d, b"InvT", DescriptorValue::Bool(t.invert));
            set(&mut d, b"Algn", DescriptorValue::Bool(t.fill.link));
            set(
                &mut d,
                b"phase",
                obj(
                    b"Pnt ",
                    vec![
                        (b"Hrzn", DescriptorValue::Double(f64::from(t.fill.phase.0))),
                        (b"Vrtc", DescriptorValue::Double(f64::from(t.fill.phase.1))),
                    ],
                ),
            );
        }
        None => set(&mut d, b"useTexture", DescriptorValue::Bool(false)),
    }
    d
}

fn write_satin(s: &Satin) -> Descriptor {
    let mut d = start(&s.source, b"ChFX");
    set_common(&mut d, s.enabled);
    set(&mut d, b"Md  ", blend_value(s.blend));
    set(&mut d, b"Clr ", rgb_value(s.color));
    set(&mut d, b"AntA", DescriptorValue::Bool(s.anti_aliased));
    set(&mut d, b"Invr", DescriptorValue::Bool(s.invert));
    set(&mut d, b"Opct", unit(b"#Prc", f64::from(s.opacity)));
    set(&mut d, b"lagl", unit(b"#Ang", f64::from(s.angle)));
    set(&mut d, b"Dstn", unit(b"#Pxl", f64::from(s.distance)));
    set(&mut d, b"blur", unit(b"#Pxl", f64::from(s.size)));
    set(&mut d, b"MpgS", contour_value(&s.contour));
    d
}

fn write_color_fill(c: &ColorFill) -> Descriptor {
    let mut d = start(&c.source, b"SoFi");
    set_common(&mut d, c.enabled);
    set(&mut d, b"Md  ", blend_value(c.blend));
    // A colour read in CMYK keeps its inks unless it was changed.
    let keep_cmyk = c.cmyk.is_some()
        && c.source
            .as_ref()
            .and_then(|s| s.descriptor(b"Clr "))
            .is_some_and(|clr| clr.class_id.matches(b"CMYC"));
    if !keep_cmyk {
        set(&mut d, b"Clr ", rgb_value(c.color));
    }
    set(&mut d, b"Opct", unit(b"#Prc", f64::from(c.opacity)));
    d
}

fn write_stroke(s: &Stroke) -> Descriptor {
    let mut d = start(&s.source, b"FrFX");
    set_common(&mut d, s.enabled);
    set(
        &mut d,
        b"Styl",
        en(
            b"FStl",
            match s.position {
                StrokePosition::Outside => b"OutF",
                StrokePosition::Inside => b"InsF",
                StrokePosition::Center => b"CtrF",
            },
        ),
    );
    let paint: &[u8; 4] = match &s.fill {
        StrokeFill::Color { .. } => b"SClr",
        StrokeFill::Gradient(_) => b"GrFl",
        StrokeFill::Pattern(_) => b"Ptrn",
    };
    set(&mut d, b"PntT", en(b"FrFl", paint));
    set(&mut d, b"Md  ", blend_value(s.blend));
    set(&mut d, b"Opct", unit(b"#Prc", f64::from(s.opacity)));
    set(&mut d, b"Sz  ", unit(b"#Pxl", f64::from(s.size)));
    match &s.fill {
        StrokeFill::Color { rgb } => set(&mut d, b"Clr ", rgb_value(*rgb)),
        StrokeFill::Gradient(g) => write_gradient_fill(&mut d, g),
        StrokeFill::Pattern(p) => write_pattern_fill(&mut d, p),
    }
    d
}

// ───────────────────────────── the import's view ─────────────────────────────

/// A Color Overlay as the import judged it (kept for the import's
/// refusals in a CMYK document).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ColorOverlay {
    /// The colour in RGB. For a colour given in CMYK this is filled in by
    /// the importer through the document's ink transform (`cmyk`).
    pub rgb: [u8; 3],
    /// The colour as INK (0–255 = 0–100 %), when the descriptor gives it
    /// in CMYK (`CMYC`), as in a CMYK document.
    pub cmyk: Option<[u8; 4]>,
    /// The layer-record blend key (`norm`, `mul `, …) of the overlay's
    /// mode.
    pub blend_key: [u8; 4],
    /// 0–255.
    pub opacity: u8,
}

/// What a layer's `lfx2` / `lmfx` block draws.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Effects {
    /// The enabled effects' keys, in descriptor order, without the
    /// `Multi` suffix (`SoFi`, `FrFX`, …). Empty when nothing is drawn.
    pub enabled: Vec<String>,
    /// The Color Overlay, when exactly one is enabled; `Err` names why an
    /// enabled one is not representable.
    pub color_overlay: Option<std::result::Result<ColorOverlay, String>>,
    /// The whole style.
    pub style: LayerStyle,
}

impl Effects {
    /// Read an `lfx2` (or `lmfx`) payload (the bytes after the block
    /// length): a version word, then a versioned descriptor.
    pub fn parse_lfx2(payload: &[u8]) -> Result<Effects> {
        let style = LayerStyle::parse(payload)?;
        let enabled: Vec<String> = if style.enabled {
            style
                .enabled_keys()
                .into_iter()
                .map(str::to_string)
                .collect()
        } else {
            Vec::new()
        };
        let overlays: Vec<&ColorFill> = style.color_overlays.iter().filter(|c| c.enabled).collect();
        let color_overlay = (style.enabled && !overlays.is_empty()).then(|| {
            if overlays.len() > 1 {
                return Err("more than one Color Overlay".to_string());
            }
            let o = overlays[0];
            Ok(ColorOverlay {
                rgb: o.color,
                cmyk: o.cmyk,
                blend_key: o.blend.layer_key(),
                opacity: (o.opacity.clamp(0.0, 100.0) * 255.0 / 100.0).round() as u8,
            })
        });
        Ok(Effects {
            enabled,
            color_overlay,
            style,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn all_effects() -> LayerStyle {
        LayerStyle {
            enabled: true,
            scale: 80.0,
            drop_shadows: vec![
                Shadow::drop_default(),
                Shadow {
                    color: [255, 0, 0],
                    angle: 30.0,
                    spread: 40.0,
                    noise: 12.0,
                    knocks_out: false,
                    contour: Contour {
                        name: "Cone".into(),
                        points: vec![
                            ContourPoint {
                                x: 0.0,
                                y: 0.0,
                                corner: false,
                            },
                            ContourPoint {
                                x: 128.0,
                                y: 255.0,
                                corner: true,
                            },
                            ContourPoint {
                                x: 255.0,
                                y: 0.0,
                                corner: false,
                            },
                        ],
                    },
                    ..Shadow::drop_default()
                },
            ],
            inner_shadows: vec![Shadow::inner_default()],
            outer_glow: Some(Glow {
                fill: GlowFill::Gradient {
                    gradient: Gradient::two([0, 0, 255], [255, 0, 0]),
                },
                technique: GlowTechnique::Precise,
                jitter: 5.0,
                ..Glow::default()
            }),
            inner_glow: Some(Glow {
                source: GlowSource::Center,
                ..Glow::default()
            }),
            bevel: Some(Bevel {
                style: BevelStyle::PillowEmboss,
                technique: BevelTechnique::ChiselSoft,
                down: true,
                contour: Some(BevelContour::default()),
                texture: Some(BevelTexture {
                    fill: PatternFill {
                        pattern: PatternRef {
                            name: "Dots".into(),
                            id: "abc".into(),
                        },
                        ..PatternFill::default()
                    },
                    invert: true,
                    ..BevelTexture::default()
                }),
                ..Bevel::default()
            }),
            satin: Some(Satin::default()),
            color_overlays: vec![ColorFill::default()],
            gradient_overlays: vec![GradientOverlay {
                fill: GradientFill {
                    style: GradientStyle::Diamond,
                    offset: (10.0, -5.0),
                    reverse: true,
                    ..GradientFill::default()
                },
                ..GradientOverlay::default()
            }],
            pattern_overlay: Some(PatternOverlay {
                fill: PatternFill {
                    pattern: PatternRef {
                        name: "Grid".into(),
                        id: "id-1".into(),
                    },
                    scale: 50.0,
                    link: false,
                    phase: (3.0, 4.0),
                },
                ..PatternOverlay::default()
            }),
            strokes: vec![Stroke {
                position: StrokePosition::Center,
                fill: StrokeFill::Gradient(GradientFill::default()),
                ..Stroke::default()
            }],
            source: None,
        }
    }

    /// Strip the source descriptors (what a write starts from) so a model
    /// read back can be compared with the one written.
    fn bare(mut s: LayerStyle) -> LayerStyle {
        s.source = None;
        for x in s.drop_shadows.iter_mut().chain(s.inner_shadows.iter_mut()) {
            x.source = None;
        }
        for g in [&mut s.outer_glow, &mut s.inner_glow].into_iter().flatten() {
            g.descriptor = None;
            if let GlowFill::Gradient { gradient } = &mut g.fill {
                gradient.source = None;
            }
        }
        if let Some(b) = &mut s.bevel {
            b.source = None;
        }
        if let Some(x) = &mut s.satin {
            x.source = None;
        }
        for c in &mut s.color_overlays {
            c.source = None;
        }
        for g in &mut s.gradient_overlays {
            g.source = None;
            g.fill.gradient.source = None;
        }
        if let Some(p) = &mut s.pattern_overlay {
            p.source = None;
        }
        for st in &mut s.strokes {
            st.source = None;
            if let StrokeFill::Gradient(g) = &mut st.fill {
                g.gradient.source = None;
            }
        }
        s
    }

    #[test]
    #[allow(non_snake_case)]
    fn every_effect_writes_and_reads_back__feat__image_layers_styles() {
        let style = all_effects();
        assert!(style.is_multi(), "two drop shadows");
        assert_eq!(style.block_key(), *b"lmfx");
        let back = LayerStyle::parse(&style.to_payload()).expect("parse");
        assert_eq!(bare(back.clone()), bare(style.clone()));
        // A second write from what was read is the same bytes.
        assert_eq!(
            back.to_payload(),
            LayerStyle::parse(&back.to_payload()).unwrap().to_payload()
        );
        assert_eq!(
            back.enabled_keys(),
            vec![
                "ebbl",
                "FrFX",
                "IrSh",
                "IrGl",
                "ChFX",
                "SoFi",
                "GrFl",
                "patternFill",
                "OrGl",
                "DrSh"
            ]
        );
        assert!(back.uses_patterns());
    }

    #[test]
    #[allow(non_snake_case)]
    fn a_disabled_effect_is_kept_and_draws_nothing__feat__image_layers_styles() {
        let mut style = LayerStyle {
            strokes: vec![Stroke {
                enabled: false,
                ..Stroke::default()
            }],
            ..LayerStyle::default()
        };
        assert!(!style.draws());
        let back = LayerStyle::parse(&style.to_payload()).unwrap();
        assert_eq!(back.strokes.len(), 1);
        assert!(!back.strokes[0].enabled);
        let fx = Effects::parse_lfx2(&style.to_payload()).unwrap();
        assert!(fx.enabled.is_empty());
        // The master switch hides everything.
        style.strokes[0].enabled = true;
        style.enabled = false;
        let fx = Effects::parse_lfx2(&style.to_payload()).unwrap();
        assert!(fx.enabled.is_empty());
        assert_eq!(fx.style.strokes.len(), 1);
    }

    #[test]
    #[allow(non_snake_case)]
    fn a_contour_is_a_spline_split_at_corners__feat__image_layers_styles() {
        let lin = Contour::linear().lut();
        assert!((lin[0]).abs() < 1e-6 && (lin[255] - 1.0).abs() < 1e-6);
        assert!((lin[128] - 128.0 / 255.0).abs() < 1e-4);
        let cone = Contour {
            name: "Cone".into(),
            points: vec![
                ContourPoint {
                    x: 0.0,
                    y: 0.0,
                    corner: false,
                },
                ContourPoint {
                    x: 127.5,
                    y: 255.0,
                    corner: true,
                },
                ContourPoint {
                    x: 255.0,
                    y: 0.0,
                    corner: false,
                },
            ],
        };
        let l = cone.lut();
        // With a corner each half is a straight line: a tent.
        assert!((l[64] - 64.0 / 127.5).abs() < 1e-3, "{}", l[64]);
        assert!((l[191] - (255.0 - 191.0) / 127.5).abs() < 1e-3);
        // Smooth, the same three points overshoot nowhere above 1 and
        // round the peak.
        let mut smooth = cone.clone();
        smooth.points[1].corner = false;
        let s = smooth.lut();
        assert!(s.iter().all(|v| (0.0..=1.0).contains(v)));
        assert!(s[64] > l[64], "a smooth peak is fuller");
    }

    #[test]
    #[allow(non_snake_case)]
    fn a_gradient_lut_honours_midpoints_and_opacity__feat__image_layers_styles() {
        let mut g = Gradient::two([0, 0, 0], [255, 255, 255]);
        g.opacity_stops[1].opacity = 0.0;
        let l = g.lut(false);
        assert!(l[0][0] < 1e-6 && (l[255][0] - 1.0).abs() < 1e-6);
        assert!((l[255][3]).abs() < 1e-6 && (l[0][3] - 1.0).abs() < 1e-6);
        g.stops[0].midpoint = 0.25;
        let l = g.lut(false);
        // Half way to white at a quarter.
        assert!((l[64][0] - 0.5).abs() < 0.02, "{}", l[64][0]);
        let r = g.lut(true);
        assert!((r[0][0] - 1.0).abs() < 1e-6);
    }

    #[test]
    #[allow(non_snake_case)]
    fn blend_modes_map_in_every_dialect__feat__image_layers_styles() {
        assert_eq!(blend_key_of("Mltp"), Some(*b"mul "));
        assert_eq!(blend_key_of("multiply"), Some(*b"mul "));
        assert_eq!(blend_key_of("linearBurn"), Some(*b"lbrn"));
        assert_eq!(
            BlendMode::from_name("linear_burn"),
            Some(BlendMode::LinearBurn)
        );
        for row in BLEND_TABLE {
            assert_eq!(BlendMode::from_layer_key(row.4), Some(row.0));
            assert_eq!(
                BlendMode::from_descriptor_id(row.0.descriptor_id()),
                Some(row.0)
            );
        }
    }
}
