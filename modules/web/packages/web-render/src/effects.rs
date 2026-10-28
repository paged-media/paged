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

//! CSS EFFECT GROUPS (ADR 415) — what an element's compositing layer carries
//! (`opacity`, `filter`, `mix-blend-mode`, `isolation`, `clip-path`,
//! `mask-image`), recorded beside the painted items so a BAKE can map it onto
//! native page items (a group's opacity and blend mode, a drop shadow, a clip
//! group, an opacity mask).
//!
//! The scene layer the canvas composes stays flat: the C-1 wire has no group
//! item, and nothing here changes it. The groups travel on their own channel
//! (`take_effects`, read after a render the way `take_text_advances` is),
//! as item ranges into the layer — `[start, end)` in painter's order, nested
//! through `parent`.
//!
//! Pure: no Blitz types. The capture layer fills [`WebEffect`] from the
//! element's computed style; [`crate::lower::lower`] turns each into a
//! [`SceneEffectGroup`].

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::display_list::WebDrawCmd;
use crate::wire::{SceneItem, ScenePathSeg};

/// One function of a CSS `filter` list, in the order the list applies them.
/// Lengths are content points; colours straight sRGB 0..1.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CssFilter {
    /// `blur(r)` — `radius` is the Gaussian's standard deviation.
    Blur { radius: f32 },
    /// `drop-shadow(dx dy blur colour)` — `blur` is the CSS blur radius.
    DropShadow {
        dx: f32,
        dy: f32,
        blur: f32,
        r: f32,
        g: f32,
        b: f32,
        a: f32,
    },
    /// `opacity(a)` — the same as the `opacity` property on the element.
    Opacity { amount: f32 },
    /// A colour function: `brightness`, `contrast`, `grayscale`,
    /// `hue-rotate` (`amount` in degrees), `invert`, `saturate`, `sepia`.
    Color { function: String, amount: f32 },
    /// `url(#filter)` — an SVG filter reference.
    Url,
}

impl CssFilter {
    /// Whether the function changes nothing (`opacity(1)`, `blur(0)`,
    /// `brightness(1)`, `hue-rotate(0deg)`, …) — nothing to map, nothing lost.
    pub fn is_identity(&self) -> bool {
        const E: f32 = 1e-4;
        match self {
            CssFilter::Blur { radius } => *radius <= E,
            CssFilter::DropShadow { a, .. } => *a <= 0.0,
            CssFilter::Opacity { amount } => (*amount - 1.0).abs() <= E,
            CssFilter::Color { function, amount } => match function.as_str() {
                "brightness" | "contrast" | "saturate" => (*amount - 1.0).abs() <= E,
                "hue-rotate" => (amount.rem_euclid(360.0)).abs() <= E,
                _ => amount.abs() <= E,
            },
            CssFilter::Url => false,
        }
    }
}

/// The effects of one element as the capture records them, opening a group
/// in the display list ([`WebDrawCmd::PushGroup`]).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct WebEffect {
    /// The layer's opacity (CSS `opacity`), 1 when the element has none.
    pub opacity: f32,
    /// The element's `mix-blend-mode` in its IDML spelling (`Multiply`),
    /// `None` for `normal`.
    pub blend: Option<String>,
    /// `isolation: isolate`.
    pub isolate: bool,
    /// The `filter` list, identities removed.
    pub filters: Vec<CssFilter>,
    /// The `clip-path` outline in content points, when the element has one
    /// the layout engine resolved.
    pub clip: Option<Vec<ScenePathSeg>>,
    /// What the `mask-image` layers painted (the alpha the element is
    /// multiplied by), in content points.
    pub mask: Vec<WebDrawCmd>,
    /// Effects of the element with no native equivalent, by key
    /// (`mixBlendMode.plusLighter`, `backdropFilter`, `clipPath.url`, …).
    pub losses: Vec<String>,
}

/// One effect group on the wire: the items `[start, end)` of the layer it
/// wraps, its parent group (an index into the same list), and the effects.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneEffectGroup {
    pub start: usize,
    pub end: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent: Option<usize>,
    pub opacity: f32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blend: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub isolate: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub filters: Vec<CssFilter>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clip: Option<Vec<ScenePathSeg>>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mask: Vec<SceneItem>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub losses: Vec<String>,
}

/// The effect channel of one layer: its groups, and the effects the capture
/// could not attach to any painted item (counted by key).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayerEffects {
    pub groups: Vec<SceneEffectGroup>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub losses: BTreeMap<String, usize>,
}

impl LayerEffects {
    pub fn is_empty(&self) -> bool {
        self.groups.is_empty() && self.losses.is_empty()
    }
}

/// A CSS blend keyword (`mix-blend-mode` / `background-blend-mode`) in the
/// IDML spelling the engine's `BlendMode` reads. `Ok(None)` for `normal`;
/// `Err(key)` for a keyword IDML has no mode for (`plus-lighter`), with the
/// loss key to report.
pub fn css_blend_to_idml(keyword: &str) -> Result<Option<&'static str>, String> {
    Ok(Some(match keyword {
        "normal" => return Ok(None),
        "multiply" => "Multiply",
        "screen" => "Screen",
        "overlay" => "Overlay",
        "darken" => "Darken",
        "lighten" => "Lighten",
        "color-dodge" => "ColorDodge",
        "color-burn" => "ColorBurn",
        "hard-light" => "HardLight",
        "soft-light" => "SoftLight",
        "difference" => "Difference",
        "exclusion" => "Exclusion",
        "hue" => "Hue",
        "saturation" => "Saturation",
        "color" => "Color",
        "luminosity" => "Luminosity",
        other => return Err(format!("mixBlendMode.{}", camel(other))),
    }))
}

/// `plus-lighter` → `plusLighter` (loss keys are camelCase).
fn camel(kebab: &str) -> String {
    let mut out = String::with_capacity(kebab.len());
    let mut up = false;
    for c in kebab.chars() {
        if c == '-' {
            up = true;
        } else if up {
            out.extend(c.to_uppercase());
            up = false;
        } else {
            out.push(c);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_css_blend_keyword_maps_to_its_idml_mode() {
        let pairs = [
            ("multiply", "Multiply"),
            ("screen", "Screen"),
            ("overlay", "Overlay"),
            ("darken", "Darken"),
            ("lighten", "Lighten"),
            ("color-dodge", "ColorDodge"),
            ("color-burn", "ColorBurn"),
            ("hard-light", "HardLight"),
            ("soft-light", "SoftLight"),
            ("difference", "Difference"),
            ("exclusion", "Exclusion"),
            ("hue", "Hue"),
            ("saturation", "Saturation"),
            ("color", "Color"),
            ("luminosity", "Luminosity"),
        ];
        for (css, idml) in pairs {
            assert_eq!(css_blend_to_idml(css), Ok(Some(idml)), "{css}");
        }
        assert_eq!(css_blend_to_idml("normal"), Ok(None));
        assert_eq!(
            css_blend_to_idml("plus-lighter"),
            Err("mixBlendMode.plusLighter".to_string())
        );
    }

    #[test]
    fn identity_filters_are_recognised() {
        assert!(CssFilter::Opacity { amount: 1.0 }.is_identity());
        assert!(CssFilter::Blur { radius: 0.0 }.is_identity());
        assert!(CssFilter::Color {
            function: "brightness".into(),
            amount: 1.0
        }
        .is_identity());
        assert!(CssFilter::Color {
            function: "grayscale".into(),
            amount: 0.0
        }
        .is_identity());
        assert!(CssFilter::Color {
            function: "hue-rotate".into(),
            amount: 360.0
        }
        .is_identity());
        assert!(!CssFilter::Color {
            function: "sepia".into(),
            amount: 0.5
        }
        .is_identity());
        assert!(!CssFilter::Url.is_identity());
        assert!(!CssFilter::Blur { radius: 2.0 }.is_identity());
    }

    #[test]
    fn a_group_serialises_camel_case_and_skips_empty_fields() {
        let g = SceneEffectGroup {
            start: 1,
            end: 3,
            opacity: 0.5,
            blend: Some("Multiply".into()),
            filters: vec![CssFilter::DropShadow {
                dx: 1.0,
                dy: 2.0,
                blur: 3.0,
                r: 0.0,
                g: 0.0,
                b: 0.0,
                a: 0.5,
            }],
            ..Default::default()
        };
        let json = serde_json::to_value(&g).expect("json");
        assert_eq!(json["start"], 1);
        assert_eq!(json["blend"], "Multiply");
        assert_eq!(json["filters"][0]["kind"], "dropShadow");
        assert!(json.get("parent").is_none());
        assert!(json.get("mask").is_none());
        assert!(json.get("isolate").is_none());
    }
}
