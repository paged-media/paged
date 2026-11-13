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

//! Engine ADR 1099 — the layer-style parameters of the effect stack.
//!
//! The effect stack (engine ADR 1008) speaks InDesign's parameters. A
//! layer style (Photoshop's, and every raster editor's that copied it)
//! needs more: a contour that reshapes a falloff, a glow's range and
//! jitter and gradient fill, a gradient overlay's shape, scale and offset
//! with separate opacity stops, a stroke or overlay filled with a raster
//! pattern, a bevel's gloss contour and its Contour and Texture panes.
//! These are the types of those parameters. Each effect carries them as
//! OPTIONAL fields that are absent on everything InDesign wrote, so a
//! document without them serialises, hashes and renders as before.
//!
//! An entry drawn by the layer-style evaluator (`paged-layer-fx`) says so
//! with [`crate::effect_stack::EffectConvention::LayerStyle`]; the fields
//! here are read by that evaluator only.

use serde::{Deserialize, Serialize};

fn is_false(v: &bool) -> bool {
    !*v
}

fn half() -> f32 {
    0.5
}

fn hundred() -> f32 {
    100.0
}

/// One point of a [`FxContour`], on a 0–255 grid.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FxCurvePoint {
    pub x: f32,
    pub y: f32,
    /// A corner (the curve bends here) rather than a smooth point.
    #[serde(default, skip_serializing_if = "is_false")]
    pub corner: bool,
}

/// A CONTOUR: the transfer curve an effect's falloff passes through,
/// a natural cubic spline through its points, split at every corner.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FxContour {
    /// The preset's name, kept for a round trip ("Linear", "Cone", …).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub name: String,
    pub points: Vec<FxCurvePoint>,
}

impl Default for FxContour {
    fn default() -> Self {
        FxContour::linear()
    }
}

impl FxContour {
    /// The identity.
    pub fn linear() -> FxContour {
        FxContour {
            name: "Linear".into(),
            points: vec![
                FxCurvePoint {
                    x: 0.0,
                    y: 0.0,
                    corner: false,
                },
                FxCurvePoint {
                    x: 255.0,
                    y: 255.0,
                    corner: false,
                },
            ],
        }
    }

    /// Exactly the two end points of the identity.
    pub fn is_linear(&self) -> bool {
        self.points.len() == 2
            && self.points[0].x == 0.0
            && self.points[0].y == 0.0
            && self.points[1].x == 255.0
            && self.points[1].y == 255.0
    }
}

/// A colour stop of a [`FxRamp`]: position 0–1, sRGB colour, and the
/// midpoint (0–1) toward the next stop.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FxColorStop {
    pub at: f32,
    pub rgb: [u8; 3],
    #[serde(default = "half")]
    pub midpoint: f32,
}

/// An opacity stop of a [`FxRamp`]: position 0–1, opacity 0–1, midpoint.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FxAlphaStop {
    pub at: f32,
    pub opacity: f32,
    #[serde(default = "half")]
    pub midpoint: f32,
}

/// A gradient ramp with colour and opacity stops at their own positions,
/// eased by a smoothness.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FxRamp {
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub name: String,
    /// 0–100 %.
    #[serde(default = "hundred")]
    pub smoothness_pct: f32,
    pub color_stops: Vec<FxColorStop>,
    #[serde(default)]
    pub alpha_stops: Vec<FxAlphaStop>,
}

impl Default for FxRamp {
    fn default() -> Self {
        FxRamp::two([0, 0, 0], [255, 255, 255])
    }
}

impl FxRamp {
    /// From `a` to `b`, both opaque.
    pub fn two(a: [u8; 3], b: [u8; 3]) -> FxRamp {
        let c = |at, rgb| FxColorStop {
            at,
            rgb,
            midpoint: 0.5,
        };
        let o = |at| FxAlphaStop {
            at,
            opacity: 1.0,
            midpoint: 0.5,
        };
        FxRamp {
            name: "Custom".into(),
            smoothness_pct: 100.0,
            color_stops: vec![c(0.0, a), c(1.0, b)],
            alpha_stops: vec![o(0.0), o(1.0)],
        }
    }
}

/// The shape a gradient fill is drawn in.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FxGradientShape {
    #[default]
    Linear,
    Radial,
    Angle,
    Reflected,
    Diamond,
}

/// A gradient as a layer style's overlay or stroke draws it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FxGradientFill {
    pub ramp: FxRamp,
    #[serde(default)]
    pub shape: FxGradientShape,
    /// Degrees, counter-clockwise from 3 o'clock.
    #[serde(default)]
    pub angle_deg: f32,
    #[serde(default = "hundred")]
    pub scale_pct: f32,
    #[serde(default, skip_serializing_if = "is_false")]
    pub reverse: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub dither: bool,
    /// The gradient spans the item's bounds (`true`) or the whole canvas.
    #[serde(default)]
    pub align: bool,
    /// The centre's offset, percent of the span `[x, y]`.
    #[serde(default)]
    pub offset_pct: [f32; 2],
}

impl Default for FxGradientFill {
    fn default() -> Self {
        FxGradientFill {
            ramp: FxRamp::default(),
            shape: FxGradientShape::Linear,
            angle_deg: 90.0,
            scale_pct: 100.0,
            reverse: false,
            dither: false,
            align: true,
            offset_pct: [0.0, 0.0],
        }
    }
}

/// A raster pattern as a layer style's overlay, stroke or bevel texture
/// draws it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FxPatternFill {
    /// The pattern's id in its source's pattern table.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub pattern_id: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub pattern_name: String,
    #[serde(default = "hundred")]
    pub scale_pct: f32,
    /// The pattern moves with the item.
    #[serde(default)]
    pub link: bool,
    /// The pattern's origin offset, `[x, y]` in the effect's units.
    #[serde(default)]
    pub phase: [f32; 2],
    /// The tile itself, when the entry carries it (a page item made from
    /// a PSD layer has no pattern table to look it up in).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tile: Option<FxPatternTile>,
}

impl Default for FxPatternFill {
    fn default() -> Self {
        FxPatternFill {
            pattern_id: String::new(),
            pattern_name: String::new(),
            scale_pct: 100.0,
            link: true,
            phase: [0.0, 0.0],
            tile: None,
        }
    }
}

/// A pattern's tile: straight RGBA8, row-major.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FxPatternTile {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

/// What a layer-style stroke is filled with.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FxFill {
    /// One sRGB colour (the entry's `color` swatch names it too).
    Color {
        rgb: [u8; 3],
    },
    Gradient(FxGradientFill),
    Pattern(FxPatternFill),
}

/// Bevel & Emboss's Contour pane.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FxBevelContour {
    #[serde(default = "yes")]
    pub enabled: bool,
    pub contour: FxContour,
    #[serde(default, skip_serializing_if = "is_false")]
    pub anti_aliased: bool,
    /// Percent.
    #[serde(default = "fifty")]
    pub range_pct: f32,
}

/// Bevel & Emboss's Texture pane.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FxBevelTexture {
    #[serde(default = "yes")]
    pub enabled: bool,
    pub fill: FxPatternFill,
    /// Percent, −1000…1000.
    #[serde(default = "hundred")]
    pub depth_pct: f32,
    #[serde(default, skip_serializing_if = "is_false")]
    pub invert: bool,
}

fn yes() -> bool {
    true
}

fn fifty() -> f32 {
    50.0
}

/// A pattern overlay: a raster tile over the item's shape.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatternOverlayParams {
    pub fill: FxPatternFill,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_serialise_compactly() {
        let c = serde_json::to_string(&FxContour::linear()).unwrap();
        assert_eq!(
            c,
            r#"{"name":"Linear","points":[{"x":0.0,"y":0.0},{"x":255.0,"y":255.0}]}"#
        );
        let f: FxFill = serde_json::from_str(r#"{"kind":"color","rgb":[1,2,3]}"#).unwrap();
        assert_eq!(f, FxFill::Color { rgb: [1, 2, 3] });
    }
}
