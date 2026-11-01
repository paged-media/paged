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

//! The ordered effect stack of a page item's transparency target (engine
//! ADR 1008).
//!
//! InDesign gives each target (the object, its fill, its stroke, its
//! content) nine effects in fixed slots and composites them in a fixed
//! order. The model keeps those slots where they always were: the
//! target's [`DropShadowSetting`] and its [`FrameEffects`] bag. The stack
//! adds what the slots cannot say:
//!
//! - the ORDER of the effects, chosen by the user;
//! - an enabled flag per effect, so an effect can be switched off without
//!   losing its parameters (a disabled InDesign effect's parameters are
//!   PARKED on its stack entry and its slot is empty, so every reader of
//!   the slots — renderer, PDF, IDML — sees it off);
//! - effects InDesign does not have: Gaussian blur, an outline stroke
//!   (Photoshop's layer-style Stroke), colour and gradient overlays, a
//!   reflection (PowerPoint's), a soft edge, noise and a colour
//!   adjustment.
//!
//! **The canonical form.** A target whose effects are InDesign's, all
//! enabled, in InDesign's order, needs no stack: its slots say all of it.
//! Such a target stores an EMPTY stack, and [`SlotsRef::resolved`] derives
//! the entries from the slots. Every imported document is in that form, so
//! documents without the new effects serialise, hash and render exactly as
//! before the stack existed. [`SlotsMut::set_stack`] normalises a stack that
//! comes out canonical back to empty.

use serde::{Deserialize, Serialize};

use crate::{
    BevelEmbossParams, DirectionalFeatherParams, DropShadowSetting, FeatherParams, FrameEffects,
    GradientFeatherParams, InnerGlowParams, InnerShadowParams, OuterGlowParams, SatinParams,
};

/// One of InDesign's nine effects: a slot of the target, not a stack-only
/// effect.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum IndesignEffect {
    DropShadow,
    InnerShadow,
    OuterGlow,
    InnerGlow,
    BevelEmboss,
    Satin,
    Feather,
    DirectionalFeather,
    GradientFeather,
}

impl IndesignEffect {
    /// InDesign's order: the order of its Effects dialog, and the order the
    /// IDML writer emits the settings in.
    pub const ORDER: [IndesignEffect; 9] = [
        IndesignEffect::DropShadow,
        IndesignEffect::InnerShadow,
        IndesignEffect::OuterGlow,
        IndesignEffect::InnerGlow,
        IndesignEffect::BevelEmboss,
        IndesignEffect::Satin,
        IndesignEffect::Feather,
        IndesignEffect::DirectionalFeather,
        IndesignEffect::GradientFeather,
    ];

    /// Position in [`Self::ORDER`].
    pub fn rank(self) -> usize {
        Self::ORDER.iter().position(|k| *k == self).unwrap_or(0)
    }

    /// The camelCase kind name the stack serialises (`"innerShadow"`).
    pub fn kind_name(self) -> &'static str {
        match self {
            IndesignEffect::DropShadow => "dropShadow",
            IndesignEffect::InnerShadow => "innerShadow",
            IndesignEffect::OuterGlow => "outerGlow",
            IndesignEffect::InnerGlow => "innerGlow",
            IndesignEffect::BevelEmboss => "bevelEmboss",
            IndesignEffect::Satin => "satin",
            IndesignEffect::Feather => "feather",
            IndesignEffect::DirectionalFeather => "directionalFeather",
            IndesignEffect::GradientFeather => "gradientFeather",
        }
    }

    /// The parameters an effect starts from when it is switched on with
    /// none of its own: InDesign's dialog presets.
    pub fn default_params(self) -> IndesignParams {
        match self {
            IndesignEffect::DropShadow => IndesignParams::DropShadow(defaults::drop_shadow()),
            IndesignEffect::InnerShadow => IndesignParams::InnerShadow(defaults::inner_shadow()),
            IndesignEffect::OuterGlow => IndesignParams::OuterGlow(defaults::outer_glow()),
            IndesignEffect::InnerGlow => IndesignParams::InnerGlow(defaults::inner_glow()),
            IndesignEffect::BevelEmboss => IndesignParams::BevelEmboss(defaults::bevel()),
            IndesignEffect::Satin => IndesignParams::Satin(defaults::satin()),
            IndesignEffect::Feather => IndesignParams::Feather(defaults::feather()),
            IndesignEffect::DirectionalFeather => {
                IndesignParams::DirectionalFeather(defaults::directional_feather())
            }
            IndesignEffect::GradientFeather => {
                IndesignParams::GradientFeather(defaults::gradient_feather())
            }
        }
    }
}

/// The parameters of one InDesign effect, whichever it is.
#[derive(Debug, Clone)]
pub enum IndesignParams {
    DropShadow(DropShadowSetting),
    InnerShadow(InnerShadowParams),
    OuterGlow(OuterGlowParams),
    InnerGlow(InnerGlowParams),
    BevelEmboss(BevelEmbossParams),
    Satin(SatinParams),
    Feather(FeatherParams),
    DirectionalFeather(DirectionalFeatherParams),
    GradientFeather(GradientFeatherParams),
}

/// InDesign's dialog presets for its effects, the parameters an effect
/// switched on without any of its own starts from. One definition: the
/// mutation layer's per-field editors materialise the same values.
pub mod defaults {
    use crate::{
        BevelEmbossParams, DirectionalFeatherParams, DropShadowSetting, FeatherParams,
        GradientFeatherParams, GradientFeatherStop, InnerGlowParams, InnerShadowParams,
        OuterGlowParams, SatinParams,
    };

    pub fn drop_shadow() -> DropShadowSetting {
        DropShadowSetting {
            mode: "Drop".to_string(),
            x_offset: 3.0,
            y_offset: 3.0,
            size: 4.0,
            opacity_pct: 30.0,
            effect_color: None,
            ..Default::default()
        }
    }

    pub fn inner_shadow() -> InnerShadowParams {
        InnerShadowParams {
            x_offset: None,
            y_offset: None,
            size: Some(5.0),
            opacity_pct: Some(75.0),
            effect_color: None,
            angle_deg: Some(120.0),
            distance: Some(5.0),
            choke_pct: Some(0.0),
            blend_mode: Some("Multiply".to_string()),
            noise_pct: Some(0.0),
            ..Default::default()
        }
    }

    pub fn outer_glow() -> OuterGlowParams {
        OuterGlowParams {
            size: Some(5.0),
            opacity_pct: Some(75.0),
            effect_color: None,
            spread_pct: Some(0.0),
            blend_mode: Some("Screen".to_string()),
            noise_pct: Some(0.0),
            ..Default::default()
        }
    }

    pub fn inner_glow() -> InnerGlowParams {
        InnerGlowParams {
            size: Some(5.0),
            opacity_pct: Some(75.0),
            effect_color: None,
            choke_pct: Some(0.0),
            blend_mode: Some("Screen".to_string()),
            source: Some("EdgeGlow".to_string()),
            noise_pct: Some(0.0),
            ..Default::default()
        }
    }

    pub fn bevel() -> BevelEmbossParams {
        BevelEmbossParams {
            depth_pct: Some(100.0),
            size: Some(5.0),
            angle_deg: Some(120.0),
            altitude_deg: Some(30.0),
            highlight_color: None,
            shadow_color: None,
            highlight_opacity_pct: Some(75.0),
            shadow_opacity_pct: Some(75.0),
            style: Some("InnerBevel".to_string()),
            direction: Some("Up".to_string()),
            technique: Some("Smooth".to_string()),
            soften: Some(0.0),
            ..Default::default()
        }
    }

    pub fn satin() -> SatinParams {
        SatinParams {
            size: Some(14.0),
            angle_deg: Some(19.0),
            distance: Some(11.0),
            effect_color: None,
            opacity_pct: Some(50.0),
            blend_mode: Some("Multiply".to_string()),
            invert: Some(true),
        }
    }

    pub fn feather() -> FeatherParams {
        FeatherParams {
            width: Some(5.0),
            corner_type: Some("Diffusion".to_string()),
            noise_pct: Some(0.0),
            choke_pct: Some(0.0),
        }
    }

    pub fn directional_feather() -> DirectionalFeatherParams {
        DirectionalFeatherParams {
            left_width: Some(5.0),
            right_width: Some(5.0),
            top_width: Some(5.0),
            bottom_width: Some(5.0),
            angle_deg: Some(0.0),
            noise_pct: Some(0.0),
            choke_pct: Some(0.0),
            corner_type: None,
            ..Default::default()
        }
    }

    /// InDesign's default gradient feather: linear, opaque to clear.
    pub fn gradient_feather() -> GradientFeatherParams {
        GradientFeatherParams {
            gradient_type: Some("Linear".to_string()),
            angle_deg: Some(0.0),
            stops: vec![
                GradientFeatherStop {
                    stop_color: None,
                    location_pct: 0.0,
                    alpha_pct: 100.0,
                    midpoint_pct: 50.0,
                },
                GradientFeatherStop {
                    stop_color: None,
                    location_pct: 100.0,
                    alpha_pct: 0.0,
                    midpoint_pct: 50.0,
                },
            ],
            ..Default::default()
        }
    }
}

/// One effect on the stack. The InDesign kinds name their slot and carry
/// their parameters only while they are disabled (`parked`); the others
/// carry their own.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Effect {
    DropShadow {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        parked: Option<DropShadowSetting>,
    },
    InnerShadow {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        parked: Option<InnerShadowParams>,
    },
    OuterGlow {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        parked: Option<OuterGlowParams>,
    },
    InnerGlow {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        parked: Option<InnerGlowParams>,
    },
    BevelEmboss {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        parked: Option<BevelEmbossParams>,
    },
    Satin {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        parked: Option<SatinParams>,
    },
    Feather {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        parked: Option<FeatherParams>,
    },
    DirectionalFeather {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        parked: Option<DirectionalFeatherParams>,
    },
    GradientFeather {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        parked: Option<GradientFeatherParams>,
    },
    /// A separable Gaussian blur of everything the stack has painted so far.
    GaussianBlur(GaussianBlurParams),
    /// Photoshop's layer-style Stroke: a band along the outline, outside,
    /// inside or centred on it.
    OutlineStroke(OutlineStrokeParams),
    /// A flat colour over the object's outline.
    ColorOverlay(ColorOverlayParams),
    /// A gradient over the object's outline.
    GradientOverlay(GradientOverlayParams),
    /// PowerPoint's reflection: a mirrored, fading copy below the object.
    Reflection(ReflectionParams),
    /// PowerPoint's soft edges: the outline fades inward over `size_pt`.
    SoftEdge(SoftEdgeParams),
    /// Photoshop's Add Noise over everything painted so far.
    Noise(NoiseParams),
    /// A colour adjustment of everything painted so far.
    ColorAdjust(ColorAdjustParams),
    // Live vector effects (engine ADR 1042): they change the item's
    // geometry before anything paints it, in their order among
    // themselves; the paint and raster entries above act on the result.
    Roughen(crate::vector_effect::RoughenParams),
    ZigZag(crate::vector_effect::ZigZagParams),
    PuckerBloat(crate::vector_effect::PuckerBloatParams),
    Twist(crate::vector_effect::TwistParams),
    Tweak(crate::vector_effect::TweakParams),
    TransformCopies(crate::vector_effect::TransformCopiesParams),
    FreeDistort(crate::vector_effect::FreeDistortParams),
    Warp(crate::vector_effect::WarpParams),
    /// Envelope Distort: the box bent through a Bézier patch mesh.
    Envelope(crate::vector_effect::EnvelopeParams),
    OffsetPath(crate::vector_effect::OffsetPathParams),
    OutlinePath(crate::vector_effect::OutlinePathParams),
    RoundCorners(crate::vector_effect::RoundCornersParams),
    Scribble(crate::vector_effect::ScribbleParams),
    ConvertToShape(crate::vector_effect::ConvertToShapeParams),
    /// On a group only: its members combined into one outline.
    Pathfinder(crate::vector_effect::PathfinderParams),
}

/// The stack-only effect kinds, by their serialised names.
pub const STACK_ONLY_KINDS: [&str; 8] = [
    "gaussianBlur",
    "outlineStroke",
    "colorOverlay",
    "gradientOverlay",
    "reflection",
    "softEdge",
    "noise",
    "colorAdjust",
];

impl Effect {
    /// The InDesign slot this effect is, if it is one.
    pub fn indesign(&self) -> Option<IndesignEffect> {
        Some(match self {
            Effect::DropShadow { .. } => IndesignEffect::DropShadow,
            Effect::InnerShadow { .. } => IndesignEffect::InnerShadow,
            Effect::OuterGlow { .. } => IndesignEffect::OuterGlow,
            Effect::InnerGlow { .. } => IndesignEffect::InnerGlow,
            Effect::BevelEmboss { .. } => IndesignEffect::BevelEmboss,
            Effect::Satin { .. } => IndesignEffect::Satin,
            Effect::Feather { .. } => IndesignEffect::Feather,
            Effect::DirectionalFeather { .. } => IndesignEffect::DirectionalFeather,
            Effect::GradientFeather { .. } => IndesignEffect::GradientFeather,
            _ => return None,
        })
    }

    /// The camelCase kind name (`"gaussianBlur"`), as serialised.
    pub fn kind_name(&self) -> &'static str {
        if let Some(k) = self.indesign() {
            return k.kind_name();
        }
        match self {
            Effect::GaussianBlur(_) => "gaussianBlur",
            Effect::OutlineStroke(_) => "outlineStroke",
            Effect::ColorOverlay(_) => "colorOverlay",
            Effect::GradientOverlay(_) => "gradientOverlay",
            Effect::Reflection(_) => "reflection",
            Effect::SoftEdge(_) => "softEdge",
            Effect::Noise(_) => "noise",
            Effect::ColorAdjust(_) => "colorAdjust",
            Effect::Roughen(_) => "roughen",
            Effect::ZigZag(_) => "zigZag",
            Effect::PuckerBloat(_) => "puckerBloat",
            Effect::Twist(_) => "twist",
            Effect::Tweak(_) => "tweak",
            Effect::TransformCopies(_) => "transformCopies",
            Effect::FreeDistort(_) => "freeDistort",
            Effect::Warp(_) => "warp",
            Effect::Envelope(_) => "envelope",
            Effect::OffsetPath(_) => "offsetPath",
            Effect::OutlinePath(_) => "outlinePath",
            Effect::RoundCorners(_) => "roundCorners",
            Effect::Scribble(_) => "scribble",
            Effect::ConvertToShape(_) => "convertToShape",
            Effect::Pathfinder(_) => "pathfinder",
            _ => unreachable!("InDesign kinds return above"),
        }
    }

    /// An InDesign effect's entry with nothing parked.
    pub fn slot(kind: IndesignEffect) -> Self {
        Self::with_parked(kind, None)
    }

    fn with_parked(kind: IndesignEffect, params: Option<IndesignParams>) -> Self {
        use IndesignParams as P;
        match (kind, params) {
            (IndesignEffect::DropShadow, Some(P::DropShadow(p))) => {
                Effect::DropShadow { parked: Some(p) }
            }
            (IndesignEffect::DropShadow, _) => Effect::DropShadow { parked: None },
            (IndesignEffect::InnerShadow, Some(P::InnerShadow(p))) => {
                Effect::InnerShadow { parked: Some(p) }
            }
            (IndesignEffect::InnerShadow, _) => Effect::InnerShadow { parked: None },
            (IndesignEffect::OuterGlow, Some(P::OuterGlow(p))) => {
                Effect::OuterGlow { parked: Some(p) }
            }
            (IndesignEffect::OuterGlow, _) => Effect::OuterGlow { parked: None },
            (IndesignEffect::InnerGlow, Some(P::InnerGlow(p))) => {
                Effect::InnerGlow { parked: Some(p) }
            }
            (IndesignEffect::InnerGlow, _) => Effect::InnerGlow { parked: None },
            (IndesignEffect::BevelEmboss, Some(P::BevelEmboss(p))) => {
                Effect::BevelEmboss { parked: Some(p) }
            }
            (IndesignEffect::BevelEmboss, _) => Effect::BevelEmboss { parked: None },
            (IndesignEffect::Satin, Some(P::Satin(p))) => Effect::Satin { parked: Some(p) },
            (IndesignEffect::Satin, _) => Effect::Satin { parked: None },
            (IndesignEffect::Feather, Some(P::Feather(p))) => Effect::Feather { parked: Some(p) },
            (IndesignEffect::Feather, _) => Effect::Feather { parked: None },
            (IndesignEffect::DirectionalFeather, Some(P::DirectionalFeather(p))) => {
                Effect::DirectionalFeather { parked: Some(p) }
            }
            (IndesignEffect::DirectionalFeather, _) => Effect::DirectionalFeather { parked: None },
            (IndesignEffect::GradientFeather, Some(P::GradientFeather(p))) => {
                Effect::GradientFeather { parked: Some(p) }
            }
            (IndesignEffect::GradientFeather, _) => Effect::GradientFeather { parked: None },
        }
    }

    /// Take the parked parameters of an InDesign entry.
    fn take_parked(&mut self) -> Option<IndesignParams> {
        use IndesignParams as P;
        match self {
            Effect::DropShadow { parked } => parked.take().map(P::DropShadow),
            Effect::InnerShadow { parked } => parked.take().map(P::InnerShadow),
            Effect::OuterGlow { parked } => parked.take().map(P::OuterGlow),
            Effect::InnerGlow { parked } => parked.take().map(P::InnerGlow),
            Effect::BevelEmboss { parked } => parked.take().map(P::BevelEmboss),
            Effect::Satin { parked } => parked.take().map(P::Satin),
            Effect::Feather { parked } => parked.take().map(P::Feather),
            Effect::DirectionalFeather { parked } => parked.take().map(P::DirectionalFeather),
            Effect::GradientFeather { parked } => parked.take().map(P::GradientFeather),
            _ => None,
        }
    }

    /// Whether an InDesign entry carries parked parameters.
    pub fn has_parked(&self) -> bool {
        match self {
            Effect::DropShadow { parked } => parked.is_some(),
            Effect::InnerShadow { parked } => parked.is_some(),
            Effect::OuterGlow { parked } => parked.is_some(),
            Effect::InnerGlow { parked } => parked.is_some(),
            Effect::BevelEmboss { parked } => parked.is_some(),
            Effect::Satin { parked } => parked.is_some(),
            Effect::Feather { parked } => parked.is_some(),
            Effect::DirectionalFeather { parked } => parked.is_some(),
            Effect::GradientFeather { parked } => parked.is_some(),
            _ => false,
        }
    }

    /// A stack-only effect with its default parameters, by kind name.
    pub fn stack_only_default(kind: &str) -> Option<Self> {
        Some(match kind {
            "gaussianBlur" => Effect::GaussianBlur(GaussianBlurParams::default()),
            "outlineStroke" => Effect::OutlineStroke(OutlineStrokeParams::default()),
            "colorOverlay" => Effect::ColorOverlay(ColorOverlayParams::default()),
            "gradientOverlay" => Effect::GradientOverlay(GradientOverlayParams::default()),
            "reflection" => Effect::Reflection(ReflectionParams::default()),
            "softEdge" => Effect::SoftEdge(SoftEdgeParams::default()),
            "noise" => Effect::Noise(NoiseParams::default()),
            "colorAdjust" => Effect::ColorAdjust(ColorAdjustParams::default()),
            _ => return Self::vector_default(kind),
        })
    }

    /// A vector effect (engine ADR 1042) with its default parameters, by
    /// kind name.
    pub fn vector_default(kind: &str) -> Option<Self> {
        use crate::vector_effect as v;
        Some(match kind {
            "roughen" => Effect::Roughen(v::RoughenParams::default()),
            "zigZag" => Effect::ZigZag(v::ZigZagParams::default()),
            "puckerBloat" => Effect::PuckerBloat(v::PuckerBloatParams::default()),
            "twist" => Effect::Twist(v::TwistParams::default()),
            "tweak" => Effect::Tweak(v::TweakParams::default()),
            "transformCopies" => Effect::TransformCopies(v::TransformCopiesParams::default()),
            "freeDistort" => Effect::FreeDistort(v::FreeDistortParams::default()),
            "warp" => Effect::Warp(v::WarpParams::default()),
            "envelope" => Effect::Envelope(v::EnvelopeParams::default()),
            "offsetPath" => Effect::OffsetPath(v::OffsetPathParams::default()),
            "outlinePath" => Effect::OutlinePath(v::OutlinePathParams::default()),
            "roundCorners" => Effect::RoundCorners(v::RoundCornersParams::default()),
            "scribble" => Effect::Scribble(v::ScribbleParams::default()),
            "convertToShape" => Effect::ConvertToShape(v::ConvertToShapeParams::default()),
            "pathfinder" => Effect::Pathfinder(v::PathfinderParams::default()),
            _ => return None,
        })
    }

    /// Whether this entry changes the item's geometry (engine ADR 1042)
    /// rather than painting over, under or through it.
    pub fn is_vector(&self) -> bool {
        matches!(
            self,
            Effect::Roughen(_)
                | Effect::ZigZag(_)
                | Effect::PuckerBloat(_)
                | Effect::Twist(_)
                | Effect::Tweak(_)
                | Effect::TransformCopies(_)
                | Effect::FreeDistort(_)
                | Effect::Warp(_)
                | Effect::Envelope(_)
                | Effect::OffsetPath(_)
                | Effect::OutlinePath(_)
                | Effect::RoundCorners(_)
                | Effect::Scribble(_)
                | Effect::ConvertToShape(_)
                | Effect::Pathfinder(_)
        )
    }
}

/// The enabled vector entries of a stack, in order (engine ADR 1042).
pub fn vector_entries(stack: &[EffectEntry]) -> impl Iterator<Item = &EffectEntry> {
    stack.iter().filter(|e| e.enabled && e.effect.is_vector())
}

/// Whether a stack carries any vector entry, enabled or not.
pub fn has_vector(stack: &[EffectEntry]) -> bool {
    stack.iter().any(|e| e.effect.is_vector())
}

fn yes() -> bool {
    true
}
fn is_true(b: &bool) -> bool {
    *b
}

/// One entry of a target's effect stack.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EffectEntry {
    /// Off keeps the effect and its parameters but paints nothing.
    #[serde(default = "yes", skip_serializing_if = "is_true")]
    pub enabled: bool,
    /// How a stack-only effect composites onto what lies under it, an
    /// IDML `BlendMode` name. `None` is the kind's own default (Normal).
    /// The InDesign kinds keep theirs in their parameters and leave this
    /// `None`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blend_mode: Option<String>,
    /// A stack-only effect's opacity, 0..=100. `None` is 100. The InDesign
    /// kinds keep theirs in their parameters.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opacity_pct: Option<f32>,
    pub effect: Effect,
}

impl EffectEntry {
    pub fn new(effect: Effect) -> Self {
        Self {
            enabled: true,
            blend_mode: None,
            opacity_pct: None,
            effect,
        }
    }

    /// The entry's opacity as a fraction.
    pub fn opacity(&self) -> f32 {
        self.opacity_pct
            .map(|p| (p / 100.0).clamp(0.0, 1.0))
            .unwrap_or(1.0)
    }
}

/// Gaussian blur.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GaussianBlurParams {
    /// The Gaussian's σ in pt — Photoshop's "Radius", measured on the page.
    #[serde(default = "GaussianBlurParams::default_radius")]
    pub radius_pt: f32,
}
impl GaussianBlurParams {
    fn default_radius() -> f32 {
        2.0
    }
}
impl Default for GaussianBlurParams {
    fn default() -> Self {
        Self {
            radius_pt: Self::default_radius(),
        }
    }
}

/// Where an outline stroke sits against the outline.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum StrokePosition {
    /// The whole band outside the outline (Photoshop's default).
    #[default]
    Outside,
    /// The whole band inside.
    Inside,
    /// Centred on the outline.
    Center,
}

/// Photoshop's layer-style Stroke (fill type Color).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlineStrokeParams {
    /// The band's width in pt.
    #[serde(default = "OutlineStrokeParams::default_size")]
    pub size_pt: f32,
    #[serde(default)]
    pub position: StrokePosition,
    /// A swatch reference. `None` is black.
    #[serde(default)]
    pub color: Option<String>,
}
impl OutlineStrokeParams {
    fn default_size() -> f32 {
        3.0
    }
}
impl Default for OutlineStrokeParams {
    fn default() -> Self {
        Self {
            size_pt: Self::default_size(),
            position: StrokePosition::Outside,
            color: None,
        }
    }
}

/// A flat colour over the outline.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColorOverlayParams {
    /// A swatch reference. `None` is black.
    #[serde(default)]
    pub color: Option<String>,
}

/// A gradient over the outline.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GradientOverlayParams {
    /// A gradient swatch reference. `None` is black to white.
    #[serde(default)]
    pub gradient: Option<String>,
    /// The axis angle in degrees, counter-clockwise from +x. `None` is 0.
    #[serde(default)]
    pub angle_deg: Option<f32>,
    /// Run the gradient end to start.
    #[serde(default)]
    pub reverse: bool,
}

/// PowerPoint's reflection.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReflectionParams {
    /// The gap between the object's bottom edge and the reflection, pt.
    #[serde(default)]
    pub distance_pt: f32,
    /// How much of the object's height the reflection shows, 0..=100.
    #[serde(default = "ReflectionParams::default_size")]
    pub size_pct: f32,
    /// The reflection's opacity where it meets the object, 0..=100.
    #[serde(default = "ReflectionParams::default_start")]
    pub start_opacity_pct: f32,
    /// Its opacity at `size_pct`, 0..=100.
    #[serde(default)]
    pub end_opacity_pct: f32,
    /// A blur of the reflection, σ in pt.
    #[serde(default)]
    pub blur_pt: f32,
}
impl ReflectionParams {
    fn default_size() -> f32 {
        50.0
    }
    fn default_start() -> f32 {
        50.0
    }
}
impl Default for ReflectionParams {
    fn default() -> Self {
        Self {
            distance_pt: 0.0,
            size_pct: Self::default_size(),
            start_opacity_pct: Self::default_start(),
            end_opacity_pct: 0.0,
            blur_pt: 0.0,
        }
    }
}

/// PowerPoint's soft edges.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SoftEdgeParams {
    /// How far in from the outline the fade reaches, pt.
    #[serde(default = "SoftEdgeParams::default_size")]
    pub size_pt: f32,
}
impl SoftEdgeParams {
    fn default_size() -> f32 {
        5.0
    }
}
impl Default for SoftEdgeParams {
    fn default() -> Self {
        Self {
            size_pt: Self::default_size(),
        }
    }
}

/// Photoshop's Add Noise (uniform distribution).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoiseParams {
    /// 0..=100: the largest change a channel takes, as a share of its range.
    #[serde(default = "NoiseParams::default_amount")]
    pub amount_pct: f32,
    /// One random value for all three channels (grey grain) instead of one
    /// per channel.
    #[serde(default = "yes")]
    pub monochromatic: bool,
}
impl NoiseParams {
    fn default_amount() -> f32 {
        10.0
    }
}
impl Default for NoiseParams {
    fn default() -> Self {
        Self {
            amount_pct: Self::default_amount(),
            monochromatic: true,
        }
    }
}

/// A colour adjustment: brightness and contrast, then hue and saturation.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColorAdjustParams {
    /// −100..=100.
    #[serde(default)]
    pub brightness: f32,
    /// −100..=100.
    #[serde(default)]
    pub contrast: f32,
    /// −100..=100; −100 is grey.
    #[serde(default)]
    pub saturation: f32,
    /// −180..=180 degrees.
    #[serde(default)]
    pub hue_deg: f32,
}

/// Which transparency target a stack belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum EffectTarget {
    Object,
    Fill,
    Stroke,
    Content,
}

impl EffectTarget {
    pub const ALL: [EffectTarget; 4] = [
        EffectTarget::Object,
        EffectTarget::Fill,
        EffectTarget::Stroke,
        EffectTarget::Content,
    ];
}

/// Why a stack was refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StackError {
    /// An InDesign effect is listed twice; its slot holds one.
    Duplicate(&'static str),
    /// The target has no slot for this InDesign effect (a polygon's stroke
    /// carries no drop shadow).
    NoSlot(&'static str),
    /// Stack-only effects are drawn on the object target (ADR 1008).
    ObjectOnly(&'static str),
    /// The Pathfinder effect combines a group's members; a page item has
    /// none (ADR 1042).
    GroupOnly(&'static str),
}

impl std::fmt::Display for StackError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StackError::Duplicate(k) => write!(f, "effect `{k}` is listed twice"),
            StackError::NoSlot(k) => write!(f, "this target has no `{k}`"),
            StackError::ObjectOnly(k) => {
                write!(f, "`{k}` is applied to the object target only")
            }
            StackError::GroupOnly(k) => write!(f, "`{k}` is applied to a group only"),
        }
    }
}

/// A target's effects, read.
#[derive(Clone, Copy)]
pub struct SlotsRef<'a> {
    pub target: EffectTarget,
    /// The target's drop-shadow slot, `None` when it has none.
    pub drop_shadow: Option<&'a Option<DropShadowSetting>>,
    pub effects: Option<&'a FrameEffects>,
    pub stack: &'a [EffectEntry],
}

/// A target's effects, written.
pub struct SlotsMut<'a> {
    pub target: EffectTarget,
    pub drop_shadow: Option<&'a mut Option<DropShadowSetting>>,
    pub effects: &'a mut Option<FrameEffects>,
    pub stack: &'a mut Vec<EffectEntry>,
}

fn slot_present(
    drop_shadow: Option<&Option<DropShadowSetting>>,
    effects: Option<&FrameEffects>,
    kind: IndesignEffect,
) -> bool {
    match kind {
        IndesignEffect::DropShadow => drop_shadow.is_some_and(|d| d.is_some()),
        IndesignEffect::InnerShadow => effects.is_some_and(|e| e.inner_shadow.is_some()),
        IndesignEffect::OuterGlow => effects.is_some_and(|e| e.outer_glow.is_some()),
        IndesignEffect::InnerGlow => effects.is_some_and(|e| e.inner_glow.is_some()),
        IndesignEffect::BevelEmboss => effects.is_some_and(|e| e.bevel.is_some()),
        IndesignEffect::Satin => effects.is_some_and(|e| e.satin.is_some()),
        IndesignEffect::Feather => effects.is_some_and(|e| e.feather.is_some()),
        IndesignEffect::DirectionalFeather => {
            effects.is_some_and(|e| e.directional_feather.is_some())
        }
        IndesignEffect::GradientFeather => effects.is_some_and(|e| e.gradient_feather.is_some()),
    }
}

/// True when `stack` says nothing the slots do not: InDesign's effects
/// only, all enabled, in InDesign's order, with no entry-level blend or
/// opacity.
pub fn is_canonical(stack: &[EffectEntry]) -> bool {
    let mut last = None;
    for e in stack {
        let Some(k) = e.effect.indesign() else {
            return false;
        };
        if !e.enabled || e.blend_mode.is_some() || e.opacity_pct.is_some() {
            return false;
        }
        if last.is_some_and(|l| l >= k.rank()) {
            return false;
        }
        last = Some(k.rank());
    }
    true
}

impl<'a> SlotsRef<'a> {
    /// Whether the target has a slot for `kind` at all.
    pub fn has_slot(&self, kind: IndesignEffect) -> bool {
        kind != IndesignEffect::DropShadow || self.drop_shadow.is_some()
    }

    /// Whether `kind`'s slot holds parameters (the effect is on).
    pub fn is_present(&self, kind: IndesignEffect) -> bool {
        slot_present(self.drop_shadow, self.effects, kind)
    }

    /// The stack as the user sees it: the stored one, or — in the
    /// canonical form — the slots that are on, in InDesign's order.
    pub fn resolved(&self) -> Vec<EffectEntry> {
        if !self.stack.is_empty() {
            return self.stack.to_vec();
        }
        IndesignEffect::ORDER
            .iter()
            .filter(|k| self.is_present(**k))
            .map(|k| EffectEntry::new(Effect::slot(*k)))
            .collect()
    }

    /// The stored stack is not the canonical one: the user reordered,
    /// disabled or added something.
    pub fn is_custom(&self) -> bool {
        !self.stack.is_empty()
    }

    /// The InDesign effects are not in InDesign's order among themselves.
    pub fn indesign_order_differs(&self) -> bool {
        let mut last = None;
        for e in self.stack {
            if let Some(k) = e.effect.indesign() {
                if last.is_some_and(|l| l > k.rank()) {
                    return true;
                }
                last = Some(k.rank());
            }
        }
        false
    }
}

impl<'a> SlotsMut<'a> {
    pub fn as_ref(&self) -> SlotsRef<'_> {
        SlotsRef {
            target: self.target,
            drop_shadow: self.drop_shadow.as_deref(),
            effects: self.effects.as_ref(),
            stack: self.stack,
        }
    }

    fn take_slot(&mut self, kind: IndesignEffect) -> Option<IndesignParams> {
        use IndesignParams as P;
        if kind == IndesignEffect::DropShadow {
            return self.drop_shadow.as_mut()?.take().map(P::DropShadow);
        }
        let e = self.effects.as_mut()?;
        match kind {
            IndesignEffect::DropShadow => None,
            IndesignEffect::InnerShadow => e.inner_shadow.take().map(P::InnerShadow),
            IndesignEffect::OuterGlow => e.outer_glow.take().map(P::OuterGlow),
            IndesignEffect::InnerGlow => e.inner_glow.take().map(P::InnerGlow),
            IndesignEffect::BevelEmboss => e.bevel.take().map(P::BevelEmboss),
            IndesignEffect::Satin => e.satin.take().map(P::Satin),
            IndesignEffect::Feather => e.feather.take().map(P::Feather),
            IndesignEffect::DirectionalFeather => {
                e.directional_feather.take().map(P::DirectionalFeather)
            }
            IndesignEffect::GradientFeather => e.gradient_feather.take().map(P::GradientFeather),
        }
    }

    fn put_slot(&mut self, params: IndesignParams) {
        use IndesignParams as P;
        if let P::DropShadow(p) = params {
            if let Some(slot) = self.drop_shadow.as_mut() {
                **slot = Some(p);
            }
            return;
        }
        let e = self.effects.get_or_insert_with(Default::default);
        match params {
            P::DropShadow(_) => {}
            P::InnerShadow(p) => e.inner_shadow = Some(p),
            P::OuterGlow(p) => e.outer_glow = Some(p),
            P::InnerGlow(p) => e.inner_glow = Some(p),
            P::BevelEmboss(p) => e.bevel = Some(p),
            P::Satin(p) => e.satin = Some(p),
            P::Feather(p) => e.feather = Some(p),
            P::DirectionalFeather(p) => e.directional_feather = Some(p),
            P::GradientFeather(p) => e.gradient_feather = Some(p),
        }
    }

    /// An effects bag with every slot empty reads as no bag.
    fn tidy(&mut self) {
        if self.effects.as_ref().is_some_and(|e| {
            e.inner_shadow.is_none()
                && e.outer_glow.is_none()
                && e.inner_glow.is_none()
                && e.bevel.is_none()
                && e.satin.is_none()
                && e.feather.is_none()
                && e.directional_feather.is_none()
                && e.gradient_feather.is_none()
        }) {
            *self.effects = None;
        }
        if is_canonical(self.stack) {
            self.stack.clear();
        }
    }

    /// Replace the stack. Each InDesign entry keeps the parameters its
    /// effect had (in its slot or parked), or starts from InDesign's
    /// preset; an enabled one goes to its slot, a disabled one is parked.
    /// An InDesign effect the new stack leaves out is removed. A stack
    /// that comes out canonical is stored empty.
    ///
    /// An InDesign entry that arrives with parked parameters of its own (a
    /// restored snapshot) keeps those.
    pub fn set_stack(&mut self, new: Vec<EffectEntry>) -> Result<(), StackError> {
        let mut seen = std::collections::HashSet::new();
        for e in &new {
            match e.effect.indesign() {
                Some(k) => {
                    if !seen.insert(k) {
                        return Err(StackError::Duplicate(k.kind_name()));
                    }
                    if !self.as_ref().has_slot(k) {
                        return Err(StackError::NoSlot(k.kind_name()));
                    }
                }
                None if self.target != EffectTarget::Object => {
                    return Err(StackError::ObjectOnly(e.effect.kind_name()));
                }
                None if matches!(e.effect, Effect::Pathfinder(_)) => {
                    return Err(StackError::GroupOnly(e.effect.kind_name()));
                }
                None => {}
            }
        }
        // Every InDesign effect's current parameters, wherever they are.
        let mut current: std::collections::HashMap<IndesignEffect, IndesignParams> =
            std::collections::HashMap::new();
        for k in IndesignEffect::ORDER {
            if let Some(p) = self.take_slot(k) {
                current.insert(k, p);
            }
        }
        for e in self.stack.iter_mut() {
            if let Some(k) = e.effect.indesign() {
                if let Some(p) = e.effect.take_parked() {
                    current.entry(k).or_insert(p);
                }
            }
        }
        let mut out = Vec::with_capacity(new.len());
        for mut e in new {
            if let Some(k) = e.effect.indesign() {
                let params = e
                    .effect
                    .take_parked()
                    .or_else(|| current.remove(&k))
                    .unwrap_or_else(|| k.default_params());
                e.blend_mode = None;
                e.opacity_pct = None;
                if e.enabled {
                    self.put_slot(params);
                    e.effect = Effect::slot(k);
                } else {
                    e.effect = Effect::with_parked(k, Some(params));
                }
            }
            out.push(e);
        }
        *self.stack = out;
        self.tidy();
        Ok(())
    }

    /// Move the parked parameters of the disabled InDesign entries into
    /// their slots, so a per-field editor writes them; returns the kinds
    /// moved, for [`Self::repark`].
    pub fn unpark(&mut self) -> Vec<IndesignEffect> {
        let mut moved = Vec::new();
        let mut params = Vec::new();
        for e in self.stack.iter_mut() {
            if e.enabled {
                continue;
            }
            if let Some(k) = e.effect.indesign() {
                if let Some(p) = e.effect.take_parked() {
                    moved.push(k);
                    params.push(p);
                }
            }
        }
        for p in params {
            self.put_slot(p);
        }
        moved
    }

    /// Park again what [`Self::unpark`] moved, then bring the stack in line
    /// with the slots: an InDesign effect a per-field editor switched on
    /// joins the stack at its place in InDesign's order, one it switched
    /// off leaves it.
    pub fn repark(&mut self, moved: &[IndesignEffect]) {
        for k in moved {
            let p = self.take_slot(*k);
            if let Some(e) = self
                .stack
                .iter_mut()
                .find(|e| e.effect.indesign() == Some(*k))
            {
                e.effect = Effect::with_parked(*k, p.or_else(|| Some(k.default_params())));
            }
        }
        self.reconcile();
    }

    /// Bring a stored stack in line with the slots (see [`Self::repark`]).
    pub fn reconcile(&mut self) {
        if self.stack.is_empty() {
            self.tidy();
            return;
        }
        let view = self.as_ref();
        let present: Vec<IndesignEffect> = IndesignEffect::ORDER
            .iter()
            .copied()
            .filter(|k| view.is_present(*k))
            .collect();
        // Enabled entries whose slot was emptied leave.
        self.stack.retain(|e| match e.effect.indesign() {
            Some(k) if e.enabled => present.contains(&k),
            _ => true,
        });
        for k in present {
            if let Some(e) = self
                .stack
                .iter_mut()
                .find(|e| e.effect.indesign() == Some(k))
            {
                if !e.enabled {
                    // A slot filled under a disabled entry: the slot wins.
                    e.enabled = true;
                    e.effect = Effect::slot(k);
                }
                continue;
            }
            // Insert before the first InDesign entry that InDesign orders
            // after it, else after the last InDesign entry, else first.
            let at = self
                .stack
                .iter()
                .position(|e| e.effect.indesign().is_some_and(|o| o.rank() > k.rank()))
                .or_else(|| {
                    self.stack
                        .iter()
                        .rposition(|e| e.effect.indesign().is_some())
                        .map(|i| i + 1)
                })
                .unwrap_or(0);
            self.stack.insert(at, EffectEntry::new(Effect::slot(k)));
        }
        self.tidy();
    }
}

/// The state a stack write may change on one target, for an exact undo.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TargetEffectState {
    #[serde(default)]
    pub drop_shadow: Option<DropShadowSetting>,
    #[serde(default)]
    pub effects: Option<FrameEffects>,
    #[serde(default)]
    pub stack: Vec<EffectEntry>,
    /// For the fill, stroke and content targets: whether the item carried
    /// a transparency setting for the target at all.
    #[serde(default)]
    pub had_target: bool,
}

/// The page items that carry effect stacks: text frames, rectangles,
/// ovals and polygons (the effect-bearing kinds of the renderer).
pub trait EffectBearing {
    fn effect_slots(&self, target: EffectTarget) -> SlotsRef<'_>;
    /// Mutable slots; a fill, stroke or content target materialises its
    /// transparency setting (`tidy_targets` folds an empty one away).
    fn effect_slots_mut(&mut self, target: EffectTarget) -> SlotsMut<'_>;
    /// Fold away a fill, stroke or content setting the stack write left
    /// empty, so a write that changes nothing changes no bytes.
    fn tidy_targets(&mut self);
    fn effect_state(&self, target: EffectTarget) -> TargetEffectState;
    fn restore_effect_state(&mut self, target: EffectTarget, state: TargetEffectState);
}

fn target_is_empty(t: &crate::TargetTransparency) -> bool {
    t.opacity.is_none()
        && t.blend_mode.is_none()
        && t.effects.is_none()
        && t.effect_stack.is_empty()
}

macro_rules! effect_bearing {
    ($ty:ty, $stroke_shadow:tt) => {
        impl EffectBearing for $ty {
            fn effect_slots(&self, target: EffectTarget) -> SlotsRef<'_> {
                const EMPTY: &[EffectEntry] = &[];
                match target {
                    EffectTarget::Object => SlotsRef {
                        target,
                        drop_shadow: Some(&self.drop_shadow),
                        effects: self.effects.as_ref(),
                        stack: &self.effect_stack,
                    },
                    EffectTarget::Fill => SlotsRef {
                        target,
                        drop_shadow: Some(&self.fill_drop_shadow),
                        effects: Option::as_ref(&self.fill_transparency).and_then(|t| t.effects.as_ref()),
                        stack: Option::as_ref(&self.fill_transparency)
                            .map(|t| t.effect_stack.as_slice())
                            .unwrap_or(EMPTY),
                    },
                    EffectTarget::Stroke => SlotsRef {
                        target,
                        drop_shadow: effect_bearing!(@stroke_ref self, $stroke_shadow),
                        effects: Option::as_ref(&self.stroke_transparency).and_then(|t| t.effects.as_ref()),
                        stack: Option::as_ref(&self.stroke_transparency)
                            .map(|t| t.effect_stack.as_slice())
                            .unwrap_or(EMPTY),
                    },
                    EffectTarget::Content => SlotsRef {
                        target,
                        drop_shadow: Some(&self.content_drop_shadow),
                        effects: Option::as_ref(&self.content_transparency).and_then(|t| t.effects.as_ref()),
                        stack: Option::as_ref(&self.content_transparency)
                            .map(|t| t.effect_stack.as_slice())
                            .unwrap_or(EMPTY),
                    },
                }
            }

            fn effect_slots_mut(&mut self, target: EffectTarget) -> SlotsMut<'_> {
                match target {
                    EffectTarget::Object => SlotsMut {
                        target,
                        drop_shadow: Some(&mut self.drop_shadow),
                        effects: &mut self.effects,
                        stack: &mut self.effect_stack,
                    },
                    EffectTarget::Fill => {
                        let t = self.fill_transparency.get_or_insert_with(Default::default);
                        SlotsMut {
                            target,
                            drop_shadow: Some(&mut self.fill_drop_shadow),
                            effects: &mut t.effects,
                            stack: &mut t.effect_stack,
                        }
                    }
                    EffectTarget::Stroke => {
                        let t = self.stroke_transparency.get_or_insert_with(Default::default);
                        SlotsMut {
                            target,
                            drop_shadow: effect_bearing!(@stroke_mut self, $stroke_shadow),
                            effects: &mut t.effects,
                            stack: &mut t.effect_stack,
                        }
                    }
                    EffectTarget::Content => {
                        let t = self.content_transparency.get_or_insert_with(Default::default);
                        SlotsMut {
                            target,
                            drop_shadow: Some(&mut self.content_drop_shadow),
                            effects: &mut t.effects,
                            stack: &mut t.effect_stack,
                        }
                    }
                }
            }

            fn tidy_targets(&mut self) {
                for t in [
                    &mut self.fill_transparency,
                    &mut self.stroke_transparency,
                    &mut self.content_transparency,
                ] {
                    if t.as_ref().is_some_and(target_is_empty) {
                        *t = None;
                    }
                }
            }

            fn effect_state(&self, target: EffectTarget) -> TargetEffectState {
                let s = self.effect_slots(target);
                TargetEffectState {
                    drop_shadow: s.drop_shadow.cloned().flatten(),
                    effects: s.effects.cloned(),
                    stack: s.stack.to_vec(),
                    had_target: match target {
                        EffectTarget::Object => true,
                        EffectTarget::Fill => self.fill_transparency.is_some(),
                        EffectTarget::Stroke => self.stroke_transparency.is_some(),
                        EffectTarget::Content => self.content_transparency.is_some(),
                    },
                }
            }

            fn restore_effect_state(&mut self, target: EffectTarget, state: TargetEffectState) {
                {
                    let s = self.effect_slots_mut(target);
                    if let Some(d) = s.drop_shadow {
                        *d = state.drop_shadow;
                    }
                    *s.effects = state.effects;
                    *s.stack = state.stack;
                }
                if !state.had_target {
                    match target {
                        EffectTarget::Object => {}
                        EffectTarget::Fill => self.fill_transparency = None,
                        EffectTarget::Stroke => self.stroke_transparency = None,
                        EffectTarget::Content => self.content_transparency = None,
                    }
                }
            }
        }
    };
    (@stroke_ref $s:ident, yes) => {
        Some(&$s.stroke_drop_shadow)
    };
    (@stroke_ref $s:ident, no) => {
        None
    };
    (@stroke_mut $s:ident, yes) => {
        Some(&mut $s.stroke_drop_shadow)
    };
    (@stroke_mut $s:ident, no) => {
        None
    };
}

effect_bearing!(crate::TextFrame, yes);
effect_bearing!(crate::Rectangle, yes);
effect_bearing!(crate::Oval, yes);
effect_bearing!(crate::Polygon, no);
// Engine ADR 1045 — an anchored frame carries the free frames' slots.
effect_bearing!(crate::AnchoredFrame, yes);

/// The IDML label that carries a page item's effect stacks through an
/// IDML round trip (engine ADR 1008): IDML has InDesign's nine effects in
/// fixed slots and nothing else, so the writer keeps the stacks in the
/// item's `<Properties><Label>` (which InDesign preserves) and the reader
/// lifts them back. The slots themselves travel as InDesign's own
/// settings; the label adds only the order, the enabled flags (with a
/// disabled effect's parked parameters) and the stack-only effects.
pub mod label {
    use super::{EffectBearing, EffectEntry, EffectTarget};
    use serde::{Deserialize, Serialize};

    /// The label key.
    pub const KEY: &str = "paged:effectStack";

    #[derive(Default, Serialize, Deserialize)]
    struct Stacks {
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        object: Vec<EffectEntry>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        fill: Vec<EffectEntry>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        stroke: Vec<EffectEntry>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        content: Vec<EffectEntry>,
    }

    /// The label value for `item`, `None` when every target is canonical.
    pub fn encode(item: &impl EffectBearing) -> Option<String> {
        let get = |t| item.effect_slots(t).stack.to_vec();
        let s = Stacks {
            object: get(EffectTarget::Object),
            fill: get(EffectTarget::Fill),
            stroke: get(EffectTarget::Stroke),
            content: get(EffectTarget::Content),
        };
        if s.object.is_empty() && s.fill.is_empty() && s.stroke.is_empty() && s.content.is_empty() {
            return None;
        }
        serde_json::to_string(&s).ok()
    }

    /// Restore `item`'s stacks from a label value. The slots were read
    /// from the IDML; each stack is set over them, so an effect InDesign
    /// removed meanwhile leaves the stack and one it added joins it.
    /// Returns `false` for a value that does not parse.
    pub fn decode_into(item: &mut impl EffectBearing, value: &str) -> bool {
        let Ok(s) = serde_json::from_str::<Stacks>(value) else {
            return false;
        };
        for (t, stack) in [
            (EffectTarget::Object, s.object),
            (EffectTarget::Fill, s.fill),
            (EffectTarget::Stroke, s.stroke),
            (EffectTarget::Content, s.content),
        ] {
            if stack.is_empty() {
                continue;
            }
            let mut slots = item.effect_slots_mut(t);
            // Entries for InDesign effects keep only their place and
            // their flag: an enabled one is whatever the IDML says now,
            // a disabled one keeps what was parked.
            let enabled_present: Vec<_> = stack
                .iter()
                .filter(|e| {
                    e.effect
                        .indesign()
                        .is_none_or(|k| !e.enabled || slots.as_ref().is_present(k))
                })
                .cloned()
                .collect();
            *slots.stack = enabled_present.clone();
            slots.reconcile();
        }
        item.tidy_targets();
        true
    }

    /// Lift every item's label on `spread` into its stacks and drop the
    /// label from the side map, so the model holds the stacks once.
    pub fn lift(spread: &mut crate::Spread) {
        if !spread
            .labels
            .values()
            .any(|v| v.iter().any(|(k, _)| k == KEY))
        {
            return;
        }
        let mut take = |id: &Option<String>| -> Option<String> {
            let entries = spread.labels.get_mut(id.as_deref()?)?;
            let at = entries.iter().position(|(k, _)| k == KEY)?;
            Some(entries.remove(at).1)
        };
        let mut found: Vec<(usize, usize, String)> = Vec::new();
        for (i, f) in spread.text_frames.iter().enumerate() {
            if let Some(v) = take(&f.self_id) {
                found.push((0, i, v));
            }
        }
        for (i, f) in spread.rectangles.iter().enumerate() {
            if let Some(v) = take(&f.self_id) {
                found.push((1, i, v));
            }
        }
        for (i, f) in spread.ovals.iter().enumerate() {
            if let Some(v) = take(&f.self_id) {
                found.push((2, i, v));
            }
        }
        for (i, f) in spread.polygons.iter().enumerate() {
            if let Some(v) = take(&f.self_id) {
                found.push((3, i, v));
            }
        }
        spread.labels.retain(|_, v| !v.is_empty());
        for (kind, i, v) in found {
            match kind {
                0 => decode_into(&mut spread.text_frames[i], &v),
                1 => decode_into(&mut spread.rectangles[i], &v),
                2 => decode_into(&mut spread.ovals[i], &v),
                _ => decode_into(&mut spread.polygons[i], &v),
            };
        }
    }

    /// Put every item's stacks on `spread` into its label, for an IDML
    /// writer. Returns whether anything was added.
    pub fn stamp(spread: &mut crate::Spread) -> bool {
        let mut add: Vec<(String, String)> = Vec::new();
        let mut visit = |id: &Option<String>, v: Option<String>| {
            if let (Some(id), Some(v)) = (id, v) {
                add.push((id.clone(), v));
            }
        };
        for f in &spread.text_frames {
            visit(&f.self_id, encode(f));
        }
        for f in &spread.rectangles {
            visit(&f.self_id, encode(f));
        }
        for f in &spread.ovals {
            visit(&f.self_id, encode(f));
        }
        for f in &spread.polygons {
            visit(&f.self_id, encode(f));
        }
        let any = !add.is_empty();
        for (id, v) in add {
            let entries = spread.labels.entry(id).or_default();
            entries.retain(|(k, _)| k != KEY);
            entries.push((KEY.to_string(), v));
        }
        any
    }

    /// Whether any item on `spread` has a stored stack.
    pub fn any(spread: &crate::Spread) -> bool {
        let has = |b: &dyn EffectBearing| {
            EffectTarget::ALL
                .iter()
                .any(|t| !b.effect_slots(*t).stack.is_empty())
        };
        spread.text_frames.iter().any(|f| has(f))
            || spread.rectangles.iter().any(|f| has(f))
            || spread.ovals.iter().any(|f| has(f))
            || spread.polygons.iter().any(|f| has(f))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Rectangle;

    fn rect_with_shadow_and_glow() -> Rectangle {
        Rectangle {
            drop_shadow: Some(defaults::drop_shadow()),
            effects: Some(FrameEffects {
                outer_glow: Some(defaults::outer_glow()),
                ..Default::default()
            }),
            ..Rectangle::new("r", crate::Bounds::ZERO)
        }
    }

    fn kinds(stack: &[EffectEntry]) -> Vec<&'static str> {
        stack.iter().map(|e| e.effect.kind_name()).collect()
    }

    #[test]
    fn an_imported_item_reads_its_slots_in_indesign_order() {
        let r = rect_with_shadow_and_glow();
        let s = r.effect_slots(EffectTarget::Object);
        assert!(!s.is_custom());
        assert_eq!(kinds(&s.resolved()), ["dropShadow", "outerGlow"]);
    }

    #[test]
    fn a_canonical_stack_is_stored_empty() {
        let mut r = rect_with_shadow_and_glow();
        let stack = r.effect_slots(EffectTarget::Object).resolved();
        r.effect_slots_mut(EffectTarget::Object)
            .set_stack(stack)
            .unwrap();
        assert!(r.effect_stack.is_empty());
        assert!(r.drop_shadow.is_some());
        assert!(r.effects.as_ref().unwrap().outer_glow.is_some());
    }

    #[test]
    fn a_blur_and_a_reorder_are_stored() {
        let mut r = rect_with_shadow_and_glow();
        let mut stack = r.effect_slots(EffectTarget::Object).resolved();
        stack.reverse();
        stack.push(EffectEntry::new(Effect::GaussianBlur(
            GaussianBlurParams::default(),
        )));
        r.effect_slots_mut(EffectTarget::Object)
            .set_stack(stack)
            .unwrap();
        assert_eq!(
            kinds(&r.effect_stack),
            ["outerGlow", "dropShadow", "gaussianBlur"]
        );
        assert!(r
            .effect_slots(EffectTarget::Object)
            .indesign_order_differs());
        // The parameters stayed in their slots.
        assert_eq!(r.drop_shadow.as_ref().unwrap().x_offset, 3.0);
    }

    #[test]
    fn disabling_parks_the_parameters_and_enabling_restores_them() {
        let mut r = rect_with_shadow_and_glow();
        r.drop_shadow.as_mut().unwrap().x_offset = 9.0;
        let mut stack = r.effect_slots(EffectTarget::Object).resolved();
        stack[0].enabled = false;
        r.effect_slots_mut(EffectTarget::Object)
            .set_stack(stack.clone())
            .unwrap();
        assert!(r.drop_shadow.is_none(), "a disabled effect paints nothing");
        assert!(r.effect_stack[0].effect.has_parked());
        let mut stack = r.effect_slots(EffectTarget::Object).resolved();
        stack[0].enabled = true;
        r.effect_slots_mut(EffectTarget::Object)
            .set_stack(stack)
            .unwrap();
        assert_eq!(r.drop_shadow.as_ref().unwrap().x_offset, 9.0);
        assert!(r.effect_stack.is_empty(), "back to canonical");
    }

    #[test]
    fn removing_an_indesign_effect_empties_its_slot() {
        let mut r = rect_with_shadow_and_glow();
        let stack = vec![EffectEntry::new(Effect::slot(IndesignEffect::OuterGlow))];
        r.effect_slots_mut(EffectTarget::Object)
            .set_stack(stack)
            .unwrap();
        assert!(r.drop_shadow.is_none());
        assert!(r.effect_stack.is_empty());
    }

    #[test]
    fn duplicates_and_stack_only_targets_are_refused() {
        let mut r = Rectangle::new("r", crate::Bounds::ZERO);
        let dup = vec![
            EffectEntry::new(Effect::slot(IndesignEffect::Satin)),
            EffectEntry::new(Effect::slot(IndesignEffect::Satin)),
        ];
        assert_eq!(
            r.effect_slots_mut(EffectTarget::Object).set_stack(dup),
            Err(StackError::Duplicate("satin"))
        );
        let blur = vec![EffectEntry::new(Effect::GaussianBlur(Default::default()))];
        assert_eq!(
            r.effect_slots_mut(EffectTarget::Fill).set_stack(blur),
            Err(StackError::ObjectOnly("gaussianBlur"))
        );
        r.tidy_targets();
        assert!(r.fill_transparency.is_none());
    }

    #[test]
    fn a_polygon_stroke_has_no_drop_shadow_slot() {
        let mut p = crate::Polygon::new("p", crate::Bounds::ZERO);
        let shadow = vec![EffectEntry::new(Effect::slot(IndesignEffect::DropShadow))];
        assert_eq!(
            p.effect_slots_mut(EffectTarget::Stroke).set_stack(shadow),
            Err(StackError::NoSlot("dropShadow"))
        );
    }

    #[test]
    fn a_per_field_switch_on_joins_a_custom_stack_in_indesign_order() {
        let mut r = rect_with_shadow_and_glow();
        let mut stack = r.effect_slots(EffectTarget::Object).resolved();
        stack.insert(
            0,
            EffectEntry::new(Effect::GaussianBlur(Default::default())),
        );
        r.effect_slots_mut(EffectTarget::Object)
            .set_stack(stack)
            .unwrap();
        // The satin is switched on through its own path.
        r.effects.as_mut().unwrap().satin = Some(defaults::satin());
        r.effect_slots_mut(EffectTarget::Object).reconcile();
        assert_eq!(
            kinds(&r.effect_stack),
            ["gaussianBlur", "dropShadow", "outerGlow", "satin"]
        );
        // And off again.
        r.effects.as_mut().unwrap().outer_glow = None;
        r.effect_slots_mut(EffectTarget::Object).reconcile();
        assert_eq!(
            kinds(&r.effect_stack),
            ["gaussianBlur", "dropShadow", "satin"]
        );
    }

    #[test]
    fn unpark_lets_a_field_edit_reach_a_disabled_effect() {
        let mut r = rect_with_shadow_and_glow();
        let mut stack = r.effect_slots(EffectTarget::Object).resolved();
        stack[1].enabled = false;
        stack.push(EffectEntry::new(Effect::Noise(Default::default())));
        r.effect_slots_mut(EffectTarget::Object)
            .set_stack(stack)
            .unwrap();
        let moved = r.effect_slots_mut(EffectTarget::Object).unpark();
        assert_eq!(moved, [IndesignEffect::OuterGlow]);
        r.effects
            .as_mut()
            .unwrap()
            .outer_glow
            .as_mut()
            .unwrap()
            .size = Some(12.0);
        r.effect_slots_mut(EffectTarget::Object).repark(&moved);
        assert!(r.effects.is_none(), "still off");
        match &r.effect_stack[1].effect {
            Effect::OuterGlow { parked: Some(p) } => assert_eq!(p.size, Some(12.0)),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn the_stack_serialises_with_kind_tags_and_round_trips() {
        let mut r = Rectangle::new("r", crate::Bounds::ZERO);
        let stack = vec![
            EffectEntry::new(Effect::OutlineStroke(OutlineStrokeParams {
                size_pt: 4.0,
                position: StrokePosition::Inside,
                color: Some("Color/Red".into()),
            })),
            EffectEntry {
                enabled: false,
                ..EffectEntry::new(Effect::slot(IndesignEffect::InnerGlow))
            },
        ];
        r.effect_slots_mut(EffectTarget::Object)
            .set_stack(stack)
            .unwrap();
        let json = serde_json::to_string(&r.effect_stack).unwrap();
        assert!(json.contains("\"kind\":\"outlineStroke\""), "{json}");
        assert!(json.contains("\"enabled\":false"), "{json}");
        let back: Vec<EffectEntry> = serde_json::from_str(&json).unwrap();
        assert_eq!(kinds(&back), ["outlineStroke", "innerGlow"]);
        assert!(back[1].effect.has_parked());
    }

    #[test]
    fn an_item_without_a_stack_serialises_as_before() {
        let r = rect_with_shadow_and_glow();
        let json = serde_json::to_string(&r).unwrap();
        assert!(!json.contains("effect_stack"), "{json}");
        let t = crate::TargetTransparency::default();
        let json = serde_json::to_string(&t).unwrap();
        assert!(!json.contains("effect_stack"), "{json}");
    }

    #[test]
    fn the_label_round_trips_a_custom_stack_over_the_slots() {
        let mut r = rect_with_shadow_and_glow();
        let mut stack = r.effect_slots(EffectTarget::Object).resolved();
        stack.reverse();
        stack[0].enabled = false;
        stack.push(EffectEntry::new(Effect::Reflection(Default::default())));
        r.effect_slots_mut(EffectTarget::Object)
            .set_stack(stack)
            .unwrap();
        let v = label::encode(&r).expect("custom");
        // The twin has the slots InDesign keeps, no stack.
        let mut twin = rect_with_shadow_and_glow();
        twin.effects = None;
        assert!(label::decode_into(&mut twin, &v));
        assert_eq!(
            kinds(&twin.effect_stack),
            ["outerGlow", "dropShadow", "reflection"]
        );
        assert!(!twin.effect_stack[0].enabled);
        assert!(twin.effect_stack[0].effect.has_parked());
        assert!(label::encode(&rect_with_shadow_and_glow()).is_none());
    }

    #[test]
    fn a_state_snapshot_restores_exactly() {
        let mut r = rect_with_shadow_and_glow();
        let before = serde_json::to_string(&r).unwrap();
        let state = r.effect_state(EffectTarget::Fill);
        r.effect_slots_mut(EffectTarget::Fill)
            .set_stack(vec![EffectEntry::new(Effect::slot(IndesignEffect::Satin))])
            .unwrap();
        assert!(r.fill_transparency.is_some());
        r.restore_effect_state(EffectTarget::Fill, state);
        assert_eq!(serde_json::to_string(&r).unwrap(), before);
    }
}
