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

//! Engine ADR 1043 — an appearance on the wire.

use serde::{Deserialize, Serialize};
use tsify_next::Tsify;

use crate::operation::{EffectEntrySpec, Value};

/// What a paint layer paints: an extra `fill` or `stroke`, or the item's
/// own fill (`frameFill`, with its picture) or stroke (`frameStroke`),
/// placed among the extra layers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Tsify)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[tsify(into_wasm_abi, from_wasm_abi)]
#[serde(rename_all = "camelCase")]
pub enum PaintLayerKind {
    Fill,
    Stroke,
    FrameFill,
    FrameStroke,
}

impl PaintLayerKind {
    fn to_model(self) -> paged_model::appearance::PaintLayerKind {
        use paged_model::appearance::PaintLayerKind as M;
        match self {
            PaintLayerKind::Fill => M::Fill,
            PaintLayerKind::Stroke => M::Stroke,
            PaintLayerKind::FrameFill => M::FrameFill,
            PaintLayerKind::FrameStroke => M::FrameStroke,
        }
    }

    fn from_model(k: paged_model::appearance::PaintLayerKind) -> Self {
        use paged_model::appearance::PaintLayerKind as M;
        match k {
            M::Fill => PaintLayerKind::Fill,
            M::Stroke => PaintLayerKind::Stroke,
            M::FrameFill => PaintLayerKind::FrameFill,
            M::FrameStroke => PaintLayerKind::FrameStroke,
        }
    }
}

fn spec_true() -> bool {
    true
}

/// Engine ADR 1043 — one layer of an appearance on the wire. Every field
/// but `kind` is optional; a fill reads the paint fields, a stroke the
/// paint fields (no `tint`, no `gradientStart`) and the stroke fields, a
/// placeholder only `enabled`.
///
/// | field | meaning |
/// | --- | --- |
/// | `color` | swatch, colour or gradient reference (`Color/…`, `Gradient/…`, `Swatch/None`) |
/// | `tint` | a fill's tint, 0..100 |
/// | `gradientAngle`, `gradientLength`, `gradientStart` | a gradient paint's geometry |
/// | `opacityPct` | the layer's opacity, 0..100 |
/// | `blendMode` | IDML blend mode name (`Multiply`, `Screen`, …) |
/// | `effects` | the layer's effect stack (the stack-only kinds of `EffectEntrySpec`) |
/// | `weight` | stroke weight in pt (default 1) |
/// | `alignment` | `CenterAlignment`, `InsideAlignment`, `OutsideAlignment` |
/// | `endCap`, `endJoin`, `miterLimit` | stroke caps and joins |
/// | `strokeType` | `StrokeStyle/…` reference |
/// | `dash` | dash and gap lengths in pt |
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Tsify)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[tsify(into_wasm_abi, from_wasm_abi, missing_as_null)]
#[serde(rename_all = "camelCase")]
pub struct PaintLayerSpec {
    pub kind: PaintLayerKind,
    #[serde(default = "spec_true")]
    pub enabled: bool,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub tint: Option<f32>,
    #[serde(default)]
    pub gradient_angle: Option<f32>,
    #[serde(default)]
    pub gradient_length: Option<f32>,
    #[serde(default)]
    pub gradient_start: Option<[f32; 2]>,
    #[serde(default)]
    pub opacity_pct: Option<f32>,
    #[serde(default)]
    pub blend_mode: Option<String>,
    #[serde(default)]
    pub effects: Vec<EffectEntrySpec>,
    #[serde(default)]
    pub weight: Option<f32>,
    #[serde(default)]
    pub alignment: Option<String>,
    #[serde(default)]
    pub end_cap: Option<String>,
    #[serde(default)]
    pub end_join: Option<String>,
    #[serde(default)]
    pub miter_limit: Option<f32>,
    #[serde(default)]
    pub stroke_type: Option<String>,
    #[serde(default)]
    pub dash: Vec<f32>,
}

impl PaintLayerSpec {
    /// A bare layer of `kind`, enabled, every field unset.
    pub fn new(kind: PaintLayerKind) -> Self {
        Self {
            kind,
            enabled: true,
            color: None,
            tint: None,
            gradient_angle: None,
            gradient_length: None,
            gradient_start: None,
            opacity_pct: None,
            blend_mode: None,
            effects: Vec::new(),
            weight: None,
            alignment: None,
            end_cap: None,
            end_join: None,
            miter_limit: None,
            stroke_type: None,
            dash: Vec::new(),
        }
    }

    /// The wire form of a model layer.
    pub fn from_model(l: &paged_model::appearance::PaintLayer) -> Self {
        Self {
            kind: PaintLayerKind::from_model(l.kind),
            enabled: l.enabled,
            color: l.color.clone(),
            tint: l.tint,
            gradient_angle: l.gradient_angle,
            gradient_length: l.gradient_length,
            gradient_start: l.gradient_start,
            opacity_pct: l.opacity,
            blend_mode: l.blend_mode.clone(),
            effects: l.effects.iter().map(EffectEntrySpec::from_model).collect(),
            weight: l.weight,
            alignment: l.alignment.clone(),
            end_cap: l.end_cap.clone(),
            end_join: l.end_join.clone(),
            miter_limit: l.miter_limit,
            stroke_type: l.stroke_type.clone(),
            dash: l.dash.clone(),
        }
    }

    /// The model layer, or why the spec is not one. The list it joins is
    /// checked as a whole by `paged_model::appearance::normalize`.
    pub fn to_model(&self) -> Result<paged_model::appearance::PaintLayer, String> {
        let effects = self
            .effects
            .iter()
            .map(EffectEntrySpec::to_model)
            .collect::<Result<Vec<_>, _>>()?;
        Ok(paged_model::appearance::PaintLayer {
            kind: self.kind.to_model(),
            enabled: self.enabled,
            color: self.color.clone(),
            tint: self.tint,
            gradient_angle: self.gradient_angle,
            gradient_length: self.gradient_length,
            gradient_start: self.gradient_start,
            opacity: self.opacity_pct,
            blend_mode: self.blend_mode.clone(),
            effects,
            weight: self.weight,
            alignment: self.alignment.clone(),
            end_cap: self.end_cap.clone(),
            end_join: self.end_join.clone(),
            miter_limit: self.miter_limit,
            stroke_type: self.stroke_type.clone(),
            dash: self.dash.clone(),
        })
    }
}

/// Engine ADR 1043 — the wire value of an item's appearance: its stored
/// layers (the empty list for an item that paints its one fill and
/// stroke).
pub fn appearance_value(item: &dyn paged_model::appearance::AppearanceBearing) -> Value {
    Value::Appearance {
        layers: item
            .appearance()
            .iter()
            .map(PaintLayerSpec::from_model)
            .collect(),
        prev: None,
    }
}
