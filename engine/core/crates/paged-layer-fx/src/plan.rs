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

//! The effect stack's layer-style entries, resolved into what the
//! evaluator draws ([`Fx`]) and placed where a layer style composites
//! them ([`FxPlan`]).

use std::sync::Arc;

use paged_blend::BlendMode;
use paged_model::effect_stack::{Effect, EffectEntry, IndesignParams, StrokePosition};
use paged_model::layer_style::{
    FxBevelContour, FxContour, FxFill, FxGradientFill, FxPatternFill, FxRamp,
};

/// A rectangle in the device's canvas pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
}

impl Rect {
    pub const fn new(x: i32, y: i32, w: u32, h: u32) -> Rect {
        Rect { x, y, w, h }
    }
}

/// The light every effect with Use Global Light is lit by: degrees,
/// counter-clockwise from 3 o'clock, and degrees above the horizon.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Light {
    pub angle: f32,
    pub altitude: f32,
}

impl Default for Light {
    fn default() -> Self {
        Light {
            angle: 120.0,
            altitude: 30.0,
        }
    }
}

/// Drop Shadow and Inner Shadow, resolved (sizes in device pixels).
#[derive(Debug, Clone, PartialEq)]
pub struct Shadow {
    pub blend: BlendMode,
    pub color: [u8; 3],
    /// Percent.
    pub opacity: f32,
    pub use_global_light: bool,
    pub angle: f32,
    pub distance: f32,
    /// Spread (drop) or choke (inner), percent of the size.
    pub spread: f32,
    pub size: f32,
    /// Percent.
    pub noise: f32,
    pub contour: FxContour,
    /// Layer Knocks Out Drop Shadow.
    pub knocks_out: bool,
}

/// How a glow's falloff is made.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GlowTechnique {
    Softer,
    Precise,
}

/// A glow's fill: one colour, or a ramp across the falloff.
#[derive(Debug, Clone, PartialEq)]
pub enum GlowFill {
    Color([u8; 3]),
    Ramp(FxRamp),
}

/// Outer Glow and Inner Glow, resolved.
#[derive(Debug, Clone, PartialEq)]
pub struct Glow {
    pub blend: BlendMode,
    pub fill: GlowFill,
    pub opacity: f32,
    pub technique: GlowTechnique,
    pub spread: f32,
    pub size: f32,
    pub range: f32,
    pub jitter: f32,
    pub noise: f32,
    pub contour: FxContour,
    /// An inner glow from the centre.
    pub center: bool,
}

/// Bevel & Emboss's style.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BevelStyle {
    OuterBevel,
    InnerBevel,
    Emboss,
    PillowEmboss,
    StrokeEmboss,
}

/// Bevel & Emboss's technique.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BevelTechnique {
    Smooth,
    ChiselHard,
    ChiselSoft,
}

/// One of a bevel's two lights.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BevelLight {
    pub blend: BlendMode,
    pub color: [u8; 3],
    pub opacity: f32,
}

/// Bevel & Emboss, resolved.
#[derive(Debug, Clone, PartialEq)]
pub struct Bevel {
    pub style: BevelStyle,
    pub technique: BevelTechnique,
    pub depth: f32,
    pub down: bool,
    pub size: f32,
    pub soften: f32,
    pub use_global_light: bool,
    pub angle: f32,
    pub altitude: f32,
    pub gloss: FxContour,
    pub highlight: BevelLight,
    pub shadow: BevelLight,
    pub contour: Option<FxBevelContour>,
}

/// Satin, resolved.
#[derive(Debug, Clone, PartialEq)]
pub struct Satin {
    pub blend: BlendMode,
    pub color: [u8; 3],
    pub opacity: f32,
    pub angle: f32,
    pub distance: f32,
    pub size: f32,
    pub contour: FxContour,
    pub invert: bool,
}

/// An overlay's or a stroke's compositing.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Paint {
    pub blend: BlendMode,
    pub opacity: f32,
}

/// What a stroke is filled with, resolved.
#[derive(Debug, Clone, PartialEq)]
pub enum StrokeFill {
    Color([u8; 3]),
    Gradient(FxGradientFill),
    Pattern(FxPatternFill),
}

/// A stroke, resolved.
#[derive(Debug, Clone, PartialEq)]
pub struct Stroke {
    pub paint: Paint,
    pub fill: StrokeFill,
}

/// Which side of the layer's edge a stroke draws on. Photoshop draws a
/// stroke's OUTER part beneath the layer (the layer's anti-aliased edge
/// blends over it) and its INNER part inside the layer, replacing the
/// layer's pixels there (an inside stroke's edge texel shows the stroke
/// over the backdrop, not over the layer) — measured on its strokes of an
/// anti-aliased ellipse.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum StrokePart {
    /// The shape grown by this many px, beneath the layer.
    Outer(f32),
    /// This many px inward from the edge, inside the layer.
    Inner(f32),
}

/// One effect as the evaluator draws it.
#[derive(Debug, Clone, PartialEq)]
pub enum Fx {
    DropShadow(Shadow),
    InnerShadow(Shadow),
    OuterGlow(Glow),
    InnerGlow(Glow),
    Satin(Satin),
    ColorOverlay(Paint, [u8; 3]),
    GradientOverlay(Paint, FxGradientFill),
    PatternOverlay(Paint, FxPatternFill),
    Stroke(Stroke, StrokePart),
    Bevel(Bevel),
}

impl Fx {
    /// The pattern this effect draws, if any.
    pub fn pattern(&self) -> Option<&FxPatternFill> {
        match self {
            Fx::PatternOverlay(_, p) => Some(p),
            Fx::Stroke(s, _) => match &s.fill {
                StrokeFill::Pattern(p) => Some(p),
                _ => None,
            },
            _ => None,
        }
    }

    /// The blend modes it composites in.
    pub fn blends(&self) -> impl Iterator<Item = BlendMode> {
        let (a, b) = match self {
            Fx::DropShadow(s) | Fx::InnerShadow(s) => (s.blend, None),
            Fx::OuterGlow(g) | Fx::InnerGlow(g) => (g.blend, None),
            Fx::Satin(s) => (s.blend, None),
            Fx::ColorOverlay(p, _) | Fx::GradientOverlay(p, _) | Fx::PatternOverlay(p, _) => {
                (p.blend, None)
            }
            Fx::Stroke(s, _) => (s.paint.blend, None),
            Fx::Bevel(b) => (b.highlight.blend, Some(b.shadow.blend)),
        };
        std::iter::once(a).chain(b)
    }

    /// Does it need the layer's bounds (a gradient or pattern aligned
    /// with the layer)?
    pub fn needs_bounds(&self) -> bool {
        match self {
            Fx::GradientOverlay(_, g) => g.align,
            Fx::Stroke(s, _) => matches!(&s.fill, StrokeFill::Gradient(g) if g.align),
            _ => self.pattern().is_some(),
        }
    }

    /// How far the effect reads and writes beyond a texel, px: the halo a
    /// tile of the canvas needs around it to draw what the whole canvas
    /// draws there.
    pub fn reach(&self, stroke_reach: f32) -> f32 {
        match self {
            Fx::DropShadow(s) | Fx::InnerShadow(s) => 2.0 * (s.distance + s.size),
            Fx::OuterGlow(g) | Fx::InnerGlow(g) => 2.0 * g.size,
            Fx::Satin(s) => 2.0 * (s.distance + s.size),
            Fx::Stroke(_, StrokePart::Outer(d) | StrokePart::Inner(d)) => 2.0 * d.max(0.0),
            Fx::Bevel(b) => 2.0 * (2.0 * b.size + b.soften) + 2.0 * stroke_reach,
            Fx::ColorOverlay(..) | Fx::GradientOverlay(..) | Fx::PatternOverlay(..) => 0.0,
        }
    }
}

/// A pattern's tile, premultiplied as the evaluator uploads it: straight
/// RGBA8, row-major.
#[derive(Debug, Clone, PartialEq)]
pub struct PatternTile {
    pub width: u32,
    pub height: u32,
    pub rgba: Arc<[u8]>,
}

/// One effect as the device draws it: the effect, the light it is lit
/// by, the layer's bounds (gradients and patterns aligned with the
/// layer), the pattern tile it draws, the noise seed, the layer's fill
/// opacity and how far the style's stroke reaches outside the edge.
#[derive(Debug, Clone, PartialEq)]
pub struct EffectStep {
    pub fx: Fx,
    pub light: Light,
    pub bounds: Rect,
    pub pattern: Option<Arc<PatternTile>>,
    /// The noise stream's seed (the layer id).
    pub seed: u32,
    /// The layer's fill opacity (0–1): a drop shadow is knocked out by the
    /// part of the layer its fill leaves transparent.
    pub fill: f32,
    /// How far the style's stroke reaches outside the layer's edge, px —
    /// where a Stroke Emboss bevel's edge lies.
    pub stroke_reach: f32,
}

impl EffectStep {
    /// The halo, px ([`Fx::reach`]).
    pub fn reach(&self) -> f32 {
        self.fx.reach(self.stroke_reach)
    }
}

/// A style's effects in the places a layer style composites them, each
/// bottom-up: beneath the layer, inside it (with Blend Interior Effects
/// as Group: before its mode applies), inside it always after, and on
/// top.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct FxPlan {
    pub exterior: Vec<Fx>,
    pub interior: Vec<Fx>,
    pub interior_top: Vec<Fx>,
    pub top: Vec<Fx>,
    /// How far the style's (top-most) stroke reaches outside the edge.
    pub stroke_reach: f32,
}

impl FxPlan {
    pub fn is_empty(&self) -> bool {
        self.exterior.is_empty()
            && self.interior.is_empty()
            && self.interior_top.is_empty()
            && self.top.is_empty()
    }

    /// Every effect, in no particular order.
    pub fn all(&self) -> impl Iterator<Item = &Fx> {
        self.exterior
            .iter()
            .chain(&self.interior)
            .chain(&self.interior_top)
            .chain(&self.top)
    }

    /// Plan the ENABLED layer-style entries of a resolved stack
    /// (`SlotsRef::with_params`, or a mapped style's entries with their
    /// carried parameters), in stack order: the entries are bottom-up
    /// within each place. Sizes and distances are multiplied by
    /// `px_per_unit` (device pixels per the entries' unit); `color`
    /// resolves a swatch reference to sRGB.
    pub fn of(
        entries: &[(EffectEntry, Option<IndesignParams>)],
        px_per_unit: f32,
        color: &dyn Fn(Option<&str>) -> [u8; 3],
    ) -> FxPlan {
        let mut p = FxPlan::default();
        let r = Resolve {
            k: px_per_unit,
            color,
        };
        for (e, params) in entries {
            if !e.enabled || !e.is_layer_style() {
                continue;
            }
            let paint = Paint {
                blend: blend(e.blend_mode.as_deref(), BlendMode::Normal),
                opacity: e.opacity_pct.unwrap_or(100.0),
            };
            match (&e.effect, params) {
                (Effect::DropShadow { .. }, Some(IndesignParams::DropShadow(d))) => {
                    p.exterior.push(Fx::DropShadow(r.drop_shadow(d)));
                }
                (Effect::OuterGlow { .. }, Some(IndesignParams::OuterGlow(g))) => {
                    p.exterior.push(Fx::OuterGlow(r.outer_glow(g)));
                }
                (Effect::InnerShadow { .. }, Some(IndesignParams::InnerShadow(s))) => {
                    p.interior_top.push(Fx::InnerShadow(r.inner_shadow(s)));
                }
                (Effect::InnerGlow { .. }, Some(IndesignParams::InnerGlow(g))) => {
                    p.interior.push(Fx::InnerGlow(r.inner_glow(g)));
                }
                (Effect::Satin { .. }, Some(IndesignParams::Satin(s))) => {
                    p.interior.push(Fx::Satin(r.satin(s)));
                }
                (Effect::BevelEmboss { .. }, Some(IndesignParams::BevelEmboss(b))) => {
                    p.top.push(Fx::Bevel(r.bevel(b)));
                }
                (Effect::ColorOverlay(c), _) => {
                    p.interior
                        .push(Fx::ColorOverlay(paint, (r.color)(c.color.as_deref())));
                }
                (Effect::GradientOverlay(g), _) => {
                    let fill = g.fill.clone().unwrap_or_else(|| FxGradientFill {
                        angle_deg: g.angle_deg.unwrap_or(0.0),
                        reverse: g.reverse,
                        ..FxGradientFill::default()
                    });
                    p.interior.push(Fx::GradientOverlay(paint, fill));
                }
                (Effect::PatternOverlay(o), _) => {
                    let mut fill = o.fill.clone();
                    fill.phase = fill.phase.map(|v| v * r.k);
                    p.interior.push(Fx::PatternOverlay(paint, fill));
                }
                (Effect::OutlineStroke(s), _) => {
                    let fill = match &s.fill {
                        Some(FxFill::Gradient(g)) => StrokeFill::Gradient(g.clone()),
                        Some(FxFill::Pattern(pf)) => {
                            let mut pf = pf.clone();
                            pf.phase = pf.phase.map(|v| v * r.k);
                            StrokeFill::Pattern(pf)
                        }
                        Some(FxFill::Color { rgb }) => StrokeFill::Color(*rgb),
                        None => StrokeFill::Color((r.color)(s.color.as_deref())),
                    };
                    let size = s.size_pt * r.k;
                    let stroke = Stroke { paint, fill };
                    match s.position {
                        StrokePosition::Outside => {
                            p.exterior.push(Fx::Stroke(stroke, StrokePart::Outer(size)));
                            p.stroke_reach = size;
                        }
                        StrokePosition::Center => {
                            p.exterior
                                .push(Fx::Stroke(stroke.clone(), StrokePart::Outer(size / 2.0)));
                            p.interior_top
                                .push(Fx::Stroke(stroke, StrokePart::Inner(size / 2.0)));
                            p.stroke_reach = size / 2.0;
                        }
                        StrokePosition::Inside => {
                            p.interior_top
                                .push(Fx::Stroke(stroke, StrokePart::Inner(size)));
                            p.stroke_reach = 0.0;
                        }
                    }
                }
                // InDesign's feathers and the stack's other kinds are not a
                // layer style's.
                _ => {}
            }
        }
        p
    }
}

/// A blend mode by its model spelling (`paged_blend::BlendMode::name`).
fn blend(name: Option<&str>, default: BlendMode) -> BlendMode {
    name.and_then(BlendMode::from_name).unwrap_or(default)
}

struct Resolve<'a> {
    k: f32,
    color: &'a dyn Fn(Option<&str>) -> [u8; 3],
}

impl Resolve<'_> {
    fn contour(c: &Option<FxContour>) -> FxContour {
        c.clone().unwrap_or_else(FxContour::linear)
    }

    fn drop_shadow(&self, d: &paged_model::DropShadowSetting) -> Shadow {
        // The polar form when the entry keeps it; else the offsets'.
        let (angle, distance) = match (d.angle_deg, d.distance) {
            (Some(a), Some(dist)) => (a, dist),
            _ => (
                (d.y_offset).atan2(-d.x_offset).to_degrees(),
                d.x_offset.hypot(d.y_offset),
            ),
        };
        Shadow {
            blend: blend(d.blend_mode.as_deref(), BlendMode::Multiply),
            color: (self.color)(d.effect_color.as_deref()),
            opacity: d.opacity_pct,
            use_global_light: d.use_global_light.unwrap_or(false),
            angle,
            distance: distance * self.k,
            spread: d.spread_pct.unwrap_or(0.0),
            size: d.size * self.k,
            noise: d.noise_pct.unwrap_or(0.0),
            contour: Self::contour(&d.contour),
            knocks_out: d.knocked_out.unwrap_or(true),
        }
    }

    fn inner_shadow(&self, s: &paged_model::InnerShadowParams) -> Shadow {
        Shadow {
            blend: blend(s.blend_mode.as_deref(), BlendMode::Multiply),
            color: (self.color)(s.effect_color.as_deref()),
            opacity: s.opacity_pct.unwrap_or(75.0),
            use_global_light: s.use_global_light.unwrap_or(false),
            angle: s.angle_deg.unwrap_or(120.0),
            distance: s.distance.unwrap_or(0.0) * self.k,
            spread: s.choke_pct.unwrap_or(0.0),
            size: s.size.unwrap_or(0.0) * self.k,
            noise: s.noise_pct.unwrap_or(0.0),
            contour: Self::contour(&s.contour),
            knocks_out: false,
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn glow(
        &self,
        blend_mode: &Option<String>,
        color: &Option<String>,
        gradient: &Option<FxRamp>,
        opacity: Option<f32>,
        technique: &Option<String>,
        spread: Option<f32>,
        size: Option<f32>,
        range: Option<f32>,
        jitter: Option<f32>,
        noise: Option<f32>,
        contour: &Option<FxContour>,
        center: bool,
    ) -> Glow {
        Glow {
            blend: blend(blend_mode.as_deref(), BlendMode::Screen),
            fill: match gradient {
                Some(g) => GlowFill::Ramp(g.clone()),
                None => GlowFill::Color((self.color)(color.as_deref())),
            },
            opacity: opacity.unwrap_or(75.0),
            technique: if technique.as_deref() == Some("Precise") {
                GlowTechnique::Precise
            } else {
                GlowTechnique::Softer
            },
            spread: spread.unwrap_or(0.0),
            size: size.unwrap_or(0.0) * self.k,
            range: range.unwrap_or(50.0),
            jitter: jitter.unwrap_or(0.0),
            noise: noise.unwrap_or(0.0),
            contour: Self::contour(contour),
            center,
        }
    }

    fn outer_glow(&self, g: &paged_model::OuterGlowParams) -> Glow {
        self.glow(
            &g.blend_mode,
            &g.effect_color,
            &g.gradient,
            g.opacity_pct,
            &g.technique,
            g.spread_pct,
            g.size,
            g.range_pct,
            g.jitter_pct,
            g.noise_pct,
            &g.contour,
            false,
        )
    }

    fn inner_glow(&self, g: &paged_model::InnerGlowParams) -> Glow {
        self.glow(
            &g.blend_mode,
            &g.effect_color,
            &g.gradient,
            g.opacity_pct,
            &g.technique,
            g.choke_pct,
            g.size,
            g.range_pct,
            g.jitter_pct,
            g.noise_pct,
            &g.contour,
            g.source.as_deref() == Some("CenterGlow"),
        )
    }

    fn satin(&self, s: &paged_model::SatinParams) -> Satin {
        Satin {
            blend: blend(s.blend_mode.as_deref(), BlendMode::Multiply),
            color: (self.color)(s.effect_color.as_deref()),
            opacity: s.opacity_pct.unwrap_or(50.0),
            angle: s.angle_deg.unwrap_or(19.0),
            distance: s.distance.unwrap_or(0.0) * self.k,
            size: s.size.unwrap_or(0.0) * self.k,
            contour: Self::contour(&s.contour),
            invert: s.invert.unwrap_or(true),
        }
    }

    fn bevel(&self, b: &paged_model::BevelEmbossParams) -> Bevel {
        let light = |blend_mode: &Option<String>,
                     default: BlendMode,
                     color: &Option<String>,
                     fallback: [u8; 3],
                     opacity: Option<f32>| BevelLight {
            blend: blend(blend_mode.as_deref(), default),
            color: match color {
                Some(_) => (self.color)(color.as_deref()),
                None => fallback,
            },
            opacity: opacity.unwrap_or(75.0),
        };
        Bevel {
            style: match b.style.as_deref() {
                Some("OuterBevel") => BevelStyle::OuterBevel,
                Some("Emboss") => BevelStyle::Emboss,
                Some("PillowEmboss") => BevelStyle::PillowEmboss,
                Some("StrokeEmboss") => BevelStyle::StrokeEmboss,
                _ => BevelStyle::InnerBevel,
            },
            technique: match b.technique.as_deref() {
                Some("ChiselHard") => BevelTechnique::ChiselHard,
                Some("ChiselSoft") => BevelTechnique::ChiselSoft,
                _ => BevelTechnique::Smooth,
            },
            depth: b.depth_pct.unwrap_or(100.0),
            down: b.direction.as_deref() == Some("Down"),
            size: b.size.unwrap_or(0.0) * self.k,
            soften: b.soften.unwrap_or(0.0) * self.k,
            use_global_light: b.use_global_light.unwrap_or(false),
            angle: b.angle_deg.unwrap_or(120.0),
            altitude: b.altitude_deg.unwrap_or(30.0),
            gloss: Self::contour(&b.gloss_contour),
            highlight: light(
                &b.highlight_blend_mode,
                BlendMode::Screen,
                &b.highlight_color,
                [255, 255, 255],
                b.highlight_opacity_pct,
            ),
            shadow: light(
                &b.shadow_blend_mode,
                BlendMode::Multiply,
                &b.shadow_color,
                [0, 0, 0],
                b.shadow_opacity_pct,
            ),
            contour: b.contour.clone(),
        }
    }
}
