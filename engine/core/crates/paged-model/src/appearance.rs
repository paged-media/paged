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

//! Native appearance: several fills and strokes on one page item (engine
//! ADR 1043).
//!
//! An item's `appearance` lists paint layers BOTTOM TO TOP. A layer is a
//! fill or a stroke with its own paint (a swatch or gradient reference and
//! its tint and gradient geometry), opacity, blend mode, effect stack and —
//! for a stroke — its own stroke settings. Two placeholder kinds,
//! [`PaintLayerKind::FrameFill`] and [`PaintLayerKind::FrameStroke`], stand
//! for the item's OWN fill (with its picture) and stroke, the ones IDML and
//! every per-field path know; they put the extra layers in order with them.
//! A list without a placeholder implies it: the frame's fill at the
//! bottom, its stroke directly above the fill.
//!
//! The empty list is the canonical form and means exactly the frame as it
//! always was, so a document without appearances serialises, hashes and
//! renders byte for byte as before. A list of placeholders alone, enabled
//! and in the implied order, normalises back to empty.

use serde::{Deserialize, Serialize};

use crate::effect_stack::EffectEntry;

/// What a layer paints.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PaintLayerKind {
    /// An extra fill of the item's outline.
    Fill,
    /// An extra stroke of the item's outline.
    Stroke,
    /// The item's own fill and its content (picture), in place.
    FrameFill,
    /// The item's own stroke, in place.
    FrameStroke,
}

impl PaintLayerKind {
    pub fn is_placeholder(self) -> bool {
        matches!(
            self,
            PaintLayerKind::FrameFill | PaintLayerKind::FrameStroke
        )
    }

    /// The camelCase name, as serialised.
    pub fn name(self) -> &'static str {
        match self {
            PaintLayerKind::Fill => "fill",
            PaintLayerKind::Stroke => "stroke",
            PaintLayerKind::FrameFill => "frameFill",
            PaintLayerKind::FrameStroke => "frameStroke",
        }
    }
}

fn yes() -> bool {
    true
}
fn is_true(b: &bool) -> bool {
    *b
}

/// One layer of an appearance.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaintLayer {
    pub kind: PaintLayerKind,
    /// Off keeps the layer and paints nothing (Illustrator's eye).
    #[serde(default = "yes", skip_serializing_if = "is_true")]
    pub enabled: bool,
    /// The paint: a swatch, colour or gradient reference (`Color/…`,
    /// `Gradient/…`, `Swatch/None`), the frame paths' `colorRef`
    /// vocabulary. `None` paints nothing. Placeholders carry none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    /// A fill's tint, 0..=100 (`None` is the swatch's own).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tint: Option<f32>,
    /// A gradient paint's angle in degrees, as the frame's
    /// `GradientFillAngle` / `GradientStrokeAngle`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gradient_angle: Option<f32>,
    /// A gradient paint's length in pt.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gradient_length: Option<f32>,
    /// A fill gradient's start point in the item's inner coordinates.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gradient_start: Option<[f32; 2]>,
    /// The layer's opacity, 0..=100. `None` is 100.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opacity: Option<f32>,
    /// How the layer composites onto the layers under it, an IDML
    /// `BlendMode` name. `None` is Normal.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blend_mode: Option<String>,
    /// The layer's own effect stack (the stack-only effects of engine
    /// ADR 1008), applied to what the layer paints.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub effects: Vec<EffectEntry>,
    /// A stroke's weight in pt. `None` is 1.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub weight: Option<f32>,
    /// A stroke's alignment: `CenterAlignment` (default),
    /// `InsideAlignment` or `OutsideAlignment`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alignment: Option<String>,
    /// A stroke's end cap: `ButtEndCap`, `RoundEndCap`,
    /// `ProjectingEndCap`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_cap: Option<String>,
    /// A stroke's join: `MiterEndJoin`, `RoundEndJoin`, `BevelEndJoin`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_join: Option<String>,
    /// A stroke's miter limit.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub miter_limit: Option<f32>,
    /// A stroke's style, a `StrokeStyle/…` reference (`None` is solid).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stroke_type: Option<String>,
    /// A stroke's dash: alternating on / off lengths in pt.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dash: Vec<f32>,
}

impl PaintLayer {
    fn bare(kind: PaintLayerKind) -> Self {
        Self {
            kind,
            enabled: true,
            color: None,
            tint: None,
            gradient_angle: None,
            gradient_length: None,
            gradient_start: None,
            opacity: None,
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

    /// A fill of `color`.
    pub fn fill(color: impl Into<String>) -> Self {
        Self {
            color: Some(color.into()),
            ..Self::bare(PaintLayerKind::Fill)
        }
    }

    /// A stroke of `color`, `weight` pt wide.
    pub fn stroke(color: impl Into<String>, weight: f32) -> Self {
        Self {
            color: Some(color.into()),
            weight: Some(weight),
            ..Self::bare(PaintLayerKind::Stroke)
        }
    }

    /// The item's own fill, in place.
    pub fn frame_fill() -> Self {
        Self::bare(PaintLayerKind::FrameFill)
    }

    /// The item's own stroke, in place.
    pub fn frame_stroke() -> Self {
        Self::bare(PaintLayerKind::FrameStroke)
    }

    /// The layer's opacity as a fraction.
    pub fn opacity_fraction(&self) -> f32 {
        self.opacity
            .map(|p| (p / 100.0).clamp(0.0, 1.0))
            .unwrap_or(1.0)
    }

    /// The stroke weight in pt.
    pub fn stroke_weight(&self) -> f32 {
        self.weight.unwrap_or(1.0).max(0.0)
    }

    /// Whether the layer draws anything of its own: an enabled fill or
    /// stroke with a paint (and, for a stroke, a weight).
    pub fn paints(&self) -> bool {
        if !self.enabled || self.kind.is_placeholder() {
            return false;
        }
        let Some(c) = self.color.as_deref() else {
            return false;
        };
        if c.is_empty() || c == "Swatch/None" {
            return false;
        }
        self.kind != PaintLayerKind::Stroke || self.stroke_weight() > 0.0
    }
}

/// Why an appearance was refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AppearanceError {
    /// A placeholder is listed twice; the item has one fill and one stroke.
    DuplicatePlaceholder(&'static str),
    /// A layer's effect is one of InDesign's nine, whose parameters live in
    /// a target's slots; a layer takes the stack-only effects.
    IndesignEffect(&'static str),
    /// A number is not finite.
    NotFinite(&'static str),
}

impl std::fmt::Display for AppearanceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AppearanceError::DuplicatePlaceholder(k) => {
                write!(f, "the placeholder `{k}` is listed twice")
            }
            AppearanceError::IndesignEffect(k) => write!(
                f,
                "a paint layer takes the stack-only effects; `{k}` is an InDesign effect of the \
                 item's targets"
            ),
            AppearanceError::NotFinite(k) => write!(f, "`{k}` must be a finite number"),
        }
    }
}

/// Check and tidy a list for storing: placeholders once each, the
/// stack-only effects only, numbers finite and in range, the fields a
/// kind does not read cleared. The result is canonical: a list that says
/// nothing the frame does not comes back empty.
pub fn normalize(layers: Vec<PaintLayer>) -> Result<Vec<PaintLayer>, AppearanceError> {
    let mut seen_fill = false;
    let mut seen_stroke = false;
    let mut out = Vec::with_capacity(layers.len());
    for mut l in layers {
        match l.kind {
            PaintLayerKind::FrameFill if std::mem::replace(&mut seen_fill, true) => {
                return Err(AppearanceError::DuplicatePlaceholder("frameFill"));
            }
            PaintLayerKind::FrameStroke if std::mem::replace(&mut seen_stroke, true) => {
                return Err(AppearanceError::DuplicatePlaceholder("frameStroke"));
            }
            _ => {}
        }
        for e in &l.effects {
            if let Some(k) = e.effect.indesign() {
                return Err(AppearanceError::IndesignEffect(k.kind_name()));
            }
        }
        for (name, v) in [
            ("tint", l.tint),
            ("gradientAngle", l.gradient_angle),
            ("gradientLength", l.gradient_length),
            ("opacity", l.opacity),
            ("weight", l.weight),
            ("miterLimit", l.miter_limit),
        ] {
            if v.is_some_and(|x| !x.is_finite()) {
                return Err(AppearanceError::NotFinite(name));
            }
        }
        if l.gradient_start
            .is_some_and(|p| !p[0].is_finite() || !p[1].is_finite())
            || l.dash.iter().any(|d| !d.is_finite())
        {
            return Err(AppearanceError::NotFinite(if l.dash.is_empty() {
                "gradientStart"
            } else {
                "dash"
            }));
        }
        l.tint = l.tint.map(|t| t.clamp(0.0, 100.0));
        l.opacity = l.opacity.map(|o| o.clamp(0.0, 100.0));
        l.weight = l.weight.map(|w| w.max(0.0));
        l.miter_limit = l.miter_limit.map(|m| m.max(1.0));
        l.dash.iter_mut().for_each(|d| *d = d.max(0.0));
        l.color = l.color.filter(|c| !c.is_empty());
        l.blend_mode = l
            .blend_mode
            .filter(|b| !b.is_empty() && !b.eq_ignore_ascii_case("normal"));
        if l.kind.is_placeholder() {
            // The frame's own paint is the frame's: a placeholder keeps
            // only its place and its switch.
            l = PaintLayer {
                enabled: l.enabled,
                ..PaintLayer::bare(l.kind)
            };
        } else if l.kind == PaintLayerKind::Fill {
            l.weight = None;
            l.alignment = None;
            l.end_cap = None;
            l.end_join = None;
            l.miter_limit = None;
            l.stroke_type = None;
            l.dash.clear();
        } else {
            // A stroke has no tint (the frame's stroke has none) and no
            // gradient start (the frame's stroke gradient has none).
            l.tint = None;
            l.gradient_start = None;
        }
        out.push(l);
    }
    if is_canonical(&out) {
        out.clear();
    }
    Ok(out)
}

/// True when `layers` says nothing the frame does not: placeholders only,
/// enabled, in the implied order (fill under stroke).
pub fn is_canonical(layers: &[PaintLayer]) -> bool {
    let mut seen_stroke = false;
    for l in layers {
        match l.kind {
            PaintLayerKind::FrameFill if l.enabled && !seen_stroke => {}
            PaintLayerKind::FrameStroke if l.enabled => seen_stroke = true,
            _ => return false,
        }
    }
    true
}

/// The layers as drawn, bottom to top, with the implied placeholders made
/// explicit: the frame's fill at the bottom when the list does not place
/// it, the frame's stroke directly above the frame's fill when it does not
/// place that.
pub fn drawn_order(layers: &[PaintLayer]) -> Vec<PaintLayer> {
    let mut out = layers.to_vec();
    let has = |out: &[PaintLayer], k| out.iter().any(|l| l.kind == k);
    if !has(&out, PaintLayerKind::FrameFill) {
        out.insert(0, PaintLayer::frame_fill());
    }
    if !has(&out, PaintLayerKind::FrameStroke) {
        let at = out
            .iter()
            .position(|l| l.kind == PaintLayerKind::FrameFill)
            .map(|i| i + 1)
            .unwrap_or(0);
        out.insert(at, PaintLayer::frame_stroke());
    }
    out
}

/// The page items that carry an appearance: text frames, rectangles,
/// ovals and polygons (the effect-bearing kinds).
pub trait AppearanceBearing {
    fn appearance(&self) -> &[PaintLayer];
    fn appearance_mut(&mut self) -> &mut Vec<PaintLayer>;
}

/// The items an appearance is drawn and baked from: one ordinary item per
/// layer, and the item's own paint split into parts.
pub trait AppearanceParts: AppearanceBearing + Clone {
    /// An ordinary item (no appearance) with the item's outline that paints
    /// exactly `layer`: its paint, its stroke settings, its opacity and
    /// blend mode as the item's, its effects as the item's object stack.
    /// No content, no text wrap, none of the item's own effects.
    fn layer_item(&self, layer: &PaintLayer) -> Self;
    /// The item without its appearance and without its object-level
    /// opacity, blend mode and effects (the caller draws those around all
    /// the parts), keeping its own fill, stroke and content as asked.
    fn base_item(&self, fill: bool, stroke: bool, content: bool) -> Self;
    /// The item's own fill, as a layer.
    fn own_fill_layer(&self) -> PaintLayer;
    /// The item's own stroke, as a layer.
    fn own_stroke_layer(&self) -> PaintLayer;
}

const NONE_SWATCH: &str = "Swatch/None";

macro_rules! clear_picture {
    ($x:ident) => {{
        $x.image_link = None;
        $x.has_image_element = false;
        $x.has_inline_pdf = false;
        $x.has_inline_eps = false;
        $x.placed_pdf = None;
        $x.image_item_transform = None;
        $x.image_bytes = None;
        $x.image_clip = None;
    }};
}

macro_rules! appearance_parts {
    ($ty:ty, extras: |$x:ident, $l:ident| $extras:block, own_extras: |$o:ident, $s:ident| $own:block, content: |$c:ident| $content:block, stroke_shadow: |$d:ident| $ss:block) => {
        impl AppearanceBearing for $ty {
            fn appearance(&self) -> &[PaintLayer] {
                &self.appearance
            }
            fn appearance_mut(&mut self) -> &mut Vec<PaintLayer> {
                &mut self.appearance
            }
        }

        impl AppearanceParts for $ty {
            fn layer_item(&self, layer: &PaintLayer) -> Self {
                let mut x = self.base_item(false, false, false);
                x.text_wrap = None;
                x.opacity = layer.opacity;
                x.blend_mode = layer.blend_mode.clone();
                x.effect_stack = layer.effects.clone();
                if !layer.paints() {
                    return x;
                }
                match layer.kind {
                    PaintLayerKind::Fill => {
                        x.fill_color = layer.color.clone();
                        x.fill_tint = layer.tint;
                        x.gradient_fill_angle = layer.gradient_angle;
                        x.gradient_fill_length = layer.gradient_length;
                        x.gradient_fill_start = layer.gradient_start;
                    }
                    PaintLayerKind::Stroke => {
                        x.stroke_color = layer.color.clone();
                        x.stroke_weight = Some(layer.stroke_weight());
                        x.stroke_alignment = layer.alignment.clone();
                        x.stroke_type = layer.stroke_type.clone();
                        x.stroke_dash = layer.dash.clone();
                        x.stroke_gap_color = None;
                        x.stroke_gap_tint = None;
                        x.gradient_stroke_angle = layer.gradient_angle;
                        x.gradient_stroke_length = layer.gradient_length;
                        let $x = &mut x;
                        let $l = layer;
                        $extras
                    }
                    _ => {}
                }
                x
            }

            fn base_item(&self, fill: bool, stroke: bool, content: bool) -> Self {
                let mut x = self.clone();
                x.appearance.clear();
                x.opacity = None;
                x.blend_mode = None;
                x.effects = None;
                x.effect_stack.clear();
                x.drop_shadow = None;
                if !fill {
                    x.fill_color = Some(NONE_SWATCH.to_string());
                    x.fill_tint = None;
                    x.fill_transparency = None;
                    x.fill_drop_shadow = None;
                    x.gradient_fill_angle = None;
                    x.gradient_fill_length = None;
                    x.gradient_fill_start = None;
                }
                if !stroke {
                    x.stroke_color = Some(NONE_SWATCH.to_string());
                    x.stroke_weight = Some(0.0);
                    x.stroke_transparency = None;
                    x.stroke_gap_color = None;
                    x.gradient_stroke_angle = None;
                    x.gradient_stroke_length = None;
                    let $d = &mut x;
                    $ss
                }
                if !content {
                    x.content_transparency = None;
                    x.content_drop_shadow = None;
                    let $c = &mut x;
                    $content
                }
                x
            }

            fn own_fill_layer(&self) -> PaintLayer {
                let t = self.fill_transparency.as_ref();
                PaintLayer {
                    color: self.fill_color.clone(),
                    tint: self.fill_tint,
                    gradient_angle: self.gradient_fill_angle,
                    gradient_length: self.gradient_fill_length,
                    gradient_start: self.gradient_fill_start,
                    opacity: t.and_then(|t| t.opacity),
                    blend_mode: t.and_then(|t| t.blend_mode.clone()),
                    ..PaintLayer::bare(PaintLayerKind::Fill)
                }
            }

            fn own_stroke_layer(&self) -> PaintLayer {
                let t = self.stroke_transparency.as_ref();
                let mut l = PaintLayer {
                    color: self.stroke_color.clone(),
                    weight: self.stroke_weight,
                    alignment: self.stroke_alignment.clone(),
                    stroke_type: self.stroke_type.clone(),
                    dash: self.stroke_dash.clone(),
                    gradient_angle: self.gradient_stroke_angle,
                    gradient_length: self.gradient_stroke_length,
                    opacity: t.and_then(|t| t.opacity),
                    blend_mode: t.and_then(|t| t.blend_mode.clone()),
                    ..PaintLayer::bare(PaintLayerKind::Stroke)
                };
                let $o = self;
                let $s = &mut l;
                $own
                l
            }
        }
    };
}

appearance_parts!(crate::Rectangle,
    extras: |x, l| {
        x.end_cap = l.end_cap.clone();
        x.end_join = l.end_join.clone();
        x.miter_limit = l.miter_limit;
    },
    own_extras: |o, s| {
        s.end_cap = o.end_cap.clone();
        s.end_join = o.end_join.clone();
        s.miter_limit = o.miter_limit;
    },
    content: |x| {
        clear_picture!(x);
        x.text_paths.clear();
    },
    stroke_shadow: |x| { x.stroke_drop_shadow = None; }
);

appearance_parts!(crate::Oval,
    extras: |x, l| {
        x.end_cap = l.end_cap.clone();
    },
    own_extras: |o, s| {
        s.end_cap = o.end_cap.clone();
    },
    content: |x| {
        clear_picture!(x);
    },
    stroke_shadow: |x| { x.stroke_drop_shadow = None; }
);

appearance_parts!(crate::Polygon,
    extras: |x, l| {
        x.end_cap = l.end_cap.clone();
        x.end_join = l.end_join.clone();
        x.miter_limit = l.miter_limit;
    },
    own_extras: |o, s| {
        s.end_cap = o.end_cap.clone();
        s.end_join = o.end_join.clone();
        s.miter_limit = o.miter_limit;
    },
    content: |x| {
        clear_picture!(x);
        x.text_paths.clear();
    },
    stroke_shadow: |x| { let _ = x; }
);

// A text frame's content is its story, which the renderer places through
// the frame's text slot, not its body: the parts keep it.
appearance_parts!(crate::TextFrame,
    extras: |x, l| { let _ = (x, l); },
    own_extras: |o, s| { let _ = (o, s); },
    content: |x| { let _ = x; },
    stroke_shadow: |x| { x.stroke_drop_shadow = None; }
);

/// Whether any item on `spread` has an appearance.
pub fn any(spread: &crate::Spread) -> bool {
    spread.text_frames.iter().any(|f| !f.appearance.is_empty())
        || spread.rectangles.iter().any(|f| !f.appearance.is_empty())
        || spread.ovals.iter().any(|f| !f.appearance.is_empty())
        || spread.polygons.iter().any(|f| !f.appearance.is_empty())
}

pub mod interchange;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::effect_stack::{Effect, GaussianBlurParams};

    #[test]
    fn placeholders_alone_in_the_implied_order_are_canonical() {
        let l = vec![PaintLayer::frame_fill(), PaintLayer::frame_stroke()];
        assert!(normalize(l).unwrap().is_empty());
        let l = vec![PaintLayer::frame_stroke(), PaintLayer::frame_fill()];
        assert_eq!(
            normalize(l).unwrap().len(),
            2,
            "stroke under fill is an order"
        );
        assert!(normalize(Vec::new()).unwrap().is_empty());
    }

    #[test]
    fn implied_placeholders_put_the_frame_at_the_bottom() {
        let order = drawn_order(&[PaintLayer::fill("Color/Red")]);
        let kinds: Vec<_> = order.iter().map(|l| l.kind).collect();
        assert_eq!(
            kinds,
            [
                PaintLayerKind::FrameFill,
                PaintLayerKind::FrameStroke,
                PaintLayerKind::Fill
            ]
        );
        let order = drawn_order(&[
            PaintLayer::fill("Color/Red"),
            PaintLayer::frame_fill(),
            PaintLayer::stroke("Color/Blue", 4.0),
        ]);
        let kinds: Vec<_> = order.iter().map(|l| l.kind).collect();
        assert_eq!(
            kinds,
            [
                PaintLayerKind::Fill,
                PaintLayerKind::FrameFill,
                PaintLayerKind::FrameStroke,
                PaintLayerKind::Stroke
            ]
        );
    }

    #[test]
    fn refusals() {
        let dup = vec![PaintLayer::frame_fill(), PaintLayer::frame_fill()];
        assert_eq!(
            normalize(dup).unwrap_err(),
            AppearanceError::DuplicatePlaceholder("frameFill")
        );
        let mut l = PaintLayer::fill("Color/Red");
        l.effects
            .push(EffectEntry::new(Effect::DropShadow { parked: None }));
        assert_eq!(
            normalize(vec![l]).unwrap_err(),
            AppearanceError::IndesignEffect("dropShadow")
        );
        let mut l = PaintLayer::fill("Color/Red");
        l.opacity = Some(f32::NAN);
        assert_eq!(
            normalize(vec![l]).unwrap_err(),
            AppearanceError::NotFinite("opacity")
        );
    }

    #[test]
    fn normalising_clears_what_a_kind_does_not_read() {
        let mut f = PaintLayer::fill("Color/Red");
        f.weight = Some(3.0);
        f.dash = vec![2.0, 2.0];
        f.opacity = Some(140.0);
        f.blend_mode = Some("Normal".into());
        let mut s = PaintLayer::stroke("Color/Blue", -2.0);
        s.tint = Some(40.0);
        let mut p = PaintLayer::frame_stroke();
        p.color = Some("Color/Green".into());
        p.enabled = false;
        let out = normalize(vec![f, s, p]).unwrap();
        assert_eq!(out[0].weight, None);
        assert!(out[0].dash.is_empty());
        assert_eq!(out[0].opacity, Some(100.0));
        assert_eq!(out[0].blend_mode, None);
        assert_eq!(out[1].weight, Some(0.0));
        assert_eq!(out[1].tint, None);
        assert!(!out[1].paints(), "a zero-weight stroke paints nothing");
        assert_eq!(out[2].color, None);
        assert!(!out[2].enabled);
    }

    #[test]
    fn serialises_compactly_and_round_trips() {
        let mut f = PaintLayer::fill("Color/Red");
        f.opacity = Some(50.0);
        f.blend_mode = Some("Multiply".into());
        f.effects
            .push(EffectEntry::new(Effect::GaussianBlur(GaussianBlurParams {
                radius_pt: 2.0,
            })));
        let s = PaintLayer::stroke("Color/Blue", 4.0);
        let json = serde_json::to_string(&vec![f, s]).unwrap();
        assert_eq!(
            json,
            r#"[{"kind":"fill","color":"Color/Red","opacity":50.0,"blendMode":"Multiply","effects":[{"effect":{"kind":"gaussianBlur","radiusPt":2.0}}]},{"kind":"stroke","color":"Color/Blue","weight":4.0}]"#
        );
        let back: Vec<PaintLayer> = serde_json::from_str(&json).unwrap();
        assert_eq!(serde_json::to_string(&back).unwrap(), json);
    }
}
