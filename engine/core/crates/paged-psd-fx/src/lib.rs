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

//! Engine ADR 1044 (plan C16) — a Photoshop layer STYLE (`paged-psd`'s
//! [`LayerStyle`], read from `lfx2` / `lmfx`) mapped onto the engine's
//! ordered effect stack (engine ADR 1008), so a page item made from a PSD
//! layer carries its styles natively instead of baked into its pixels.
//!
//! [`map_layer_style`] is pure: it turns a style into the OBJECT target's
//! stack — InDesign's kinds with their parameters on the entry (parked, as
//! a stored stack carries them), the stack-only kinds with theirs — the
//! colour and gradient swatches those entries name, and a [`StyleLoss`]
//! for everything the stack cannot say. [`apply_layer_style`] writes the
//! result onto any [`EffectBearing`] page item and its document's
//! [`Graphic`].
//!
//! | Photoshop | stack entry | lost |
//! | --- | --- | --- |
//! | Drop Shadow | `dropShadow` (the first) | further drop shadows, a non-linear contour |
//! | Inner Shadow | `innerShadow` (the first) | further inner shadows, a contour |
//! | Outer Glow | `outerGlow` | a gradient fill (its first colour is kept), range, jitter, a contour |
//! | Inner Glow | `innerGlow` | the same |
//! | Bevel & Emboss | `bevelEmboss` | gloss contour, Contour and Texture panes |
//! | Satin | `satin` | a non-linear contour |
//! | Color Overlay | `colorOverlay` (each) | — |
//! | Gradient Overlay | `gradientOverlay` (each, linear) | a non-linear style, scale, offset, opacity stops |
//! | Pattern Overlay | — | the effect (no pattern paint on the stack yet) |
//! | Stroke | `outlineStroke` (each, colour) | a gradient or pattern fill (its first colour is kept) |
//!
//! Order: Photoshop composites its effects in a fixed order, the reverse of
//! its Layer Style dialog (`paged_psd::effects::EFFECT_KEYS`): drop shadow
//! and outer glow behind, then the overlays, satin, the inner glow and
//! shadow, the stroke and the bevel on top. The stack takes them in that
//! order, so each acts on what the ones before it drew, as in Photoshop.
//!
//! Units: Photoshop sizes and distances are pixels of the document; they
//! are scaled by the style's Scale Effects and by `pt_per_px` (72 / the
//! document's ppi). Opacities and spreads are percentages on both sides;
//! angles are the light's direction on both sides.

use std::fmt;

use paged_model::effect_stack::{
    ColorOverlayParams, Effect, EffectBearing, EffectEntry, EffectTarget, GradientOverlayParams,
    OutlineStrokeParams, StackError, StrokePosition,
};
use paged_model::{
    BevelEmbossParams, ColorEntry, ColorModel, ColorSpace, DropShadowSetting, GradientEntry,
    GradientKind, GradientStopRef, Graphic, InnerGlowParams, InnerShadowParams, OuterGlowParams,
    SatinParams,
};
use paged_psd::effects::{
    Bevel, BevelStyle, BevelTechnique, BlendMode, ColorFill, Contour, GlowFill, GlowSource,
    GlowTechnique, Gradient, GradientOverlay, GradientStyle, LayerStyle, Satin, Shadow, Stroke,
    StrokeFill,
};

/// How Photoshop's pixels become the page's points.
#[derive(Debug, Clone, Copy)]
pub struct MapOptions {
    /// Points per document pixel: 72 / ppi (1.0 at 72 ppi).
    pub pt_per_px: f32,
}

impl Default for MapOptions {
    fn default() -> Self {
        Self { pt_per_px: 1.0 }
    }
}

/// Something of the style the stack cannot say, named for a loss report.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StyleLoss {
    /// The Photoshop effect (`"Drop Shadow"`).
    pub effect: &'static str,
    /// What of it is lost.
    pub what: String,
}

impl fmt::Display for StyleLoss {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.effect, self.what)
    }
}

/// A style mapped onto the stack.
#[derive(Debug, Clone, Default)]
pub struct MappedStyle {
    /// The object target's stack, in Photoshop's compositing order. An
    /// effect switched off in Photoshop is a disabled entry that keeps
    /// its parameters.
    pub stack: Vec<EffectEntry>,
    /// The colour swatches the entries name (`Color/PSD R=… G=… B=…`).
    pub colors: Vec<ColorEntry>,
    /// The gradient swatches the entries name.
    pub gradients: Vec<GradientEntry>,
    pub losses: Vec<StyleLoss>,
}

/// The swatch reference of an sRGB colour, and its entry.
fn rgb_swatch(rgb: [u8; 3], colors: &mut Vec<ColorEntry>) -> String {
    let id = format!("Color/PSD R={} G={} B={}", rgb[0], rgb[1], rgb[2]);
    if !colors.iter().any(|c| c.self_id == id) {
        colors.push(ColorEntry {
            self_id: id.clone(),
            name: Some(id.trim_start_matches("Color/").to_string()),
            space: ColorSpace::Rgb,
            value: rgb.iter().map(|&c| f32::from(c)).collect(),
            model: ColorModel::Process,
            alternate_space: None,
            alternate_value: Vec::new(),
            tint: None,
            alpha: None,
        });
    }
    id
}

/// Whether a contour is the identity, whatever Photoshop named it (its
/// files call a straight curve "Custom" as often as "Linear"): every point
/// on the diagonal.
fn is_linear(c: &Contour) -> bool {
    c.points.iter().all(|p| (p.x - p.y).abs() < 0.5)
}

/// The IDML `BlendMode` of a Photoshop mode, or `None` for a mode IDML
/// has no name for (the stack composites those as Normal).
#[must_use]
pub fn idml_blend(mode: BlendMode) -> Option<&'static str> {
    Some(match mode {
        BlendMode::Normal => "Normal",
        BlendMode::Multiply => "Multiply",
        BlendMode::Screen => "Screen",
        BlendMode::Overlay => "Overlay",
        BlendMode::SoftLight => "SoftLight",
        BlendMode::HardLight => "HardLight",
        BlendMode::ColorDodge => "ColorDodge",
        BlendMode::ColorBurn => "ColorBurn",
        BlendMode::Darken => "Darken",
        BlendMode::Lighten => "Lighten",
        BlendMode::Difference => "Difference",
        BlendMode::Exclusion => "Exclusion",
        BlendMode::Hue => "Hue",
        BlendMode::Saturation => "Saturation",
        BlendMode::Color => "Color",
        BlendMode::Luminosity => "Luminosity",
        _ => return None,
    })
}

struct Mapper<'a> {
    scale: f32,
    out: &'a mut MappedStyle,
}

impl Mapper<'_> {
    fn px(&self, v: f32) -> f32 {
        v * self.scale
    }

    fn lose(&mut self, effect: &'static str, what: impl Into<String>) {
        self.out.losses.push(StyleLoss {
            effect,
            what: what.into(),
        });
    }

    fn color(&mut self, rgb: [u8; 3]) -> String {
        rgb_swatch(rgb, &mut self.out.colors)
    }

    fn blend(&mut self, effect: &'static str, mode: BlendMode) -> String {
        match idml_blend(mode) {
            Some(m) => m.to_string(),
            None => {
                self.lose(
                    effect,
                    format!("the {mode:?} blend mode is drawn as Normal"),
                );
                "Normal".to_string()
            }
        }
    }

    fn contour(&mut self, effect: &'static str, contour: &Contour) {
        if !is_linear(contour) {
            self.lose(effect, format!("the {:?} contour", contour.name));
        }
    }

    fn push(&mut self, enabled: bool, effect: Effect) {
        self.out.stack.push(EffectEntry {
            enabled,
            ..EffectEntry::new(effect)
        });
    }

    /// A stack-only entry with its own blend and opacity.
    fn push_own(
        &mut self,
        name: &'static str,
        enabled: bool,
        blend: BlendMode,
        opacity: f32,
        effect: Effect,
    ) {
        let mode = self.blend(name, blend);
        self.out.stack.push(EffectEntry {
            enabled,
            blend_mode: (mode != "Normal").then_some(mode),
            opacity_pct: ((opacity - 100.0).abs() > f32::EPSILON).then_some(opacity),
            effect,
        });
    }

    fn gradient(&mut self, effect: &'static str, g: &Gradient) -> String {
        let n = self.out.gradients.len() + 1;
        let id = format!("Gradient/PSD {n}");
        let stops = g
            .stops
            .iter()
            .map(|s| GradientStopRef {
                stop_color: self.color(s.rgb),
                location_pct: s.at * 100.0,
                midpoint_pct: Some(s.midpoint * 100.0),
            })
            .collect();
        if g.opacity_stops.iter().any(|o| o.opacity < 1.0) {
            self.lose(effect, "the gradient's opacity stops (drawn opaque)");
        }
        self.out.gradients.push(GradientEntry {
            self_id: id.clone(),
            name: Some(if g.name.is_empty() {
                id.trim_start_matches("Gradient/").to_string()
            } else {
                g.name.clone()
            }),
            kind: GradientKind::Linear,
            stops,
        });
        id
    }

    fn shadow(&mut self, s: &Shadow, drop: bool, first: bool) {
        let name = if drop { "Drop Shadow" } else { "Inner Shadow" };
        if !first {
            self.lose(name, "a second instance (the stack holds one)");
            return;
        }
        self.contour(name, &s.contour);
        let blend = self.blend(name, s.blend);
        let color = self.color(s.color);
        let distance = self.px(s.distance);
        let size = self.px(s.size);
        if drop {
            // The light's angle on both sides; the shadow falls opposite,
            // as the renderer's `polar_to_offset` reads it.
            let (sin, cos) = s.angle.to_radians().sin_cos();
            let p = DropShadowSetting {
                mode: "Drop".to_string(),
                x_offset: -distance * cos,
                y_offset: distance * sin,
                size,
                opacity_pct: s.opacity,
                effect_color: Some(color),
                blend_mode: Some(blend),
                spread_pct: Some(s.spread),
                noise_pct: Some(s.noise),
                knocked_out: Some(s.knocks_out),
                use_global_light: Some(s.use_global_light),
                ..Default::default()
            };
            self.push(s.enabled, Effect::DropShadow { parked: Some(p) });
        } else {
            let p = InnerShadowParams {
                size: Some(size),
                opacity_pct: Some(s.opacity),
                effect_color: Some(color),
                angle_deg: Some(s.angle),
                distance: Some(distance),
                choke_pct: Some(s.spread),
                blend_mode: Some(blend),
                noise_pct: Some(s.noise),
                use_global_light: Some(s.use_global_light),
                ..Default::default()
            };
            self.push(s.enabled, Effect::InnerShadow { parked: Some(p) });
        }
    }

    fn glow_color(&mut self, name: &'static str, fill: &GlowFill) -> String {
        match fill {
            GlowFill::Color { rgb } => self.color(*rgb),
            GlowFill::Gradient { gradient } => {
                self.lose(name, "the gradient fill (its first colour is kept)");
                let rgb = gradient.stops.first().map_or([255, 255, 255], |s| s.rgb);
                self.color(rgb)
            }
        }
    }

    // The model asks for `..Default::default()` so a mapper survives the
    // next attribute it adds (paged-model, R-11), even when every field is
    // set today.
    #[allow(clippy::needless_update)]
    fn glow(&mut self, g: &paged_psd::effects::Glow, outer: bool) {
        let name = if outer { "Outer Glow" } else { "Inner Glow" };
        self.contour(name, &g.contour);
        if (g.range - 50.0).abs() > 0.5 {
            self.lose(name, format!("the range ({}%)", g.range));
        }
        if g.jitter > 0.0 {
            self.lose(name, format!("the jitter ({}%)", g.jitter));
        }
        let color = self.glow_color(name, &g.fill);
        let blend = self.blend(name, g.blend);
        let technique = match g.technique {
            GlowTechnique::Softer => "Softer",
            GlowTechnique::Precise => "Precise",
        }
        .to_string();
        let size = self.px(g.size);
        if outer {
            let p = OuterGlowParams {
                size: Some(size),
                opacity_pct: Some(g.opacity),
                effect_color: Some(color),
                spread_pct: Some(g.spread),
                blend_mode: Some(blend),
                noise_pct: Some(g.noise),
                technique: Some(technique),
                ..Default::default()
            };
            self.push(g.enabled, Effect::OuterGlow { parked: Some(p) });
        } else {
            let p = InnerGlowParams {
                size: Some(size),
                opacity_pct: Some(g.opacity),
                effect_color: Some(color),
                choke_pct: Some(g.spread),
                blend_mode: Some(blend),
                source: Some(
                    match g.source {
                        GlowSource::Edge => "EdgeGlow",
                        GlowSource::Center => "CenterGlow",
                    }
                    .to_string(),
                ),
                noise_pct: Some(g.noise),
                technique: Some(technique),
                ..Default::default()
            };
            self.push(g.enabled, Effect::InnerGlow { parked: Some(p) });
        }
    }

    // The model asks for `..Default::default()` so a mapper survives the
    // next attribute it adds (paged-model, R-11), even when every field is
    // set today.
    #[allow(clippy::needless_update)]
    fn bevel(&mut self, b: &Bevel) {
        let name = "Bevel & Emboss";
        if !is_linear(&b.gloss) {
            self.lose(name, format!("the gloss contour {:?}", b.gloss.name));
        }
        if b.contour.as_ref().is_some_and(|c| c.enabled) {
            self.lose(name, "the Contour pane");
        }
        if b.texture.as_ref().is_some_and(|t| t.enabled) {
            self.lose(name, "the Texture pane");
        }
        let highlight_blend = self.blend(name, b.highlight.blend);
        let shadow_blend = self.blend(name, b.shadow.blend);
        let p = BevelEmbossParams {
            depth_pct: Some(b.depth),
            size: Some(self.px(b.size)),
            angle_deg: Some(b.angle),
            altitude_deg: Some(b.altitude),
            highlight_color: Some(self.color(b.highlight.color)),
            shadow_color: Some(self.color(b.shadow.color)),
            highlight_opacity_pct: Some(b.highlight.opacity),
            shadow_opacity_pct: Some(b.shadow.opacity),
            style: Some(
                match b.style {
                    BevelStyle::InnerBevel => "InnerBevel",
                    BevelStyle::OuterBevel => "OuterBevel",
                    BevelStyle::Emboss => "Emboss",
                    BevelStyle::PillowEmboss => "PillowEmboss",
                    BevelStyle::StrokeEmboss => "StrokeEmboss",
                }
                .to_string(),
            ),
            direction: Some(if b.down { "Down" } else { "Up" }.to_string()),
            technique: Some(
                match b.technique {
                    BevelTechnique::Smooth => "Smooth",
                    BevelTechnique::ChiselHard => "ChiselHard",
                    BevelTechnique::ChiselSoft => "ChiselSoft",
                }
                .to_string(),
            ),
            soften: Some(self.px(b.soften)),
            highlight_blend_mode: Some(highlight_blend),
            shadow_blend_mode: Some(shadow_blend),
            use_global_light: Some(b.use_global_light),
            ..Default::default()
        };
        self.push(b.enabled, Effect::BevelEmboss { parked: Some(p) });
    }

    fn satin(&mut self, s: &Satin) {
        let name = "Satin";
        self.contour(name, &s.contour);
        let p = SatinParams {
            size: Some(self.px(s.size)),
            angle_deg: Some(s.angle),
            distance: Some(self.px(s.distance)),
            effect_color: Some(self.color(s.color)),
            opacity_pct: Some(s.opacity),
            blend_mode: Some(self.blend(name, s.blend)),
            invert: Some(s.invert),
        };
        self.push(s.enabled, Effect::Satin { parked: Some(p) });
    }

    fn color_overlay(&mut self, c: &ColorFill) {
        let color = self.color(c.color);
        self.push_own(
            "Color Overlay",
            c.enabled,
            c.blend,
            c.opacity,
            Effect::ColorOverlay(ColorOverlayParams { color: Some(color) }),
        );
    }

    fn gradient_overlay(&mut self, g: &GradientOverlay) {
        let name = "Gradient Overlay";
        let fill = &g.fill;
        if fill.style != GradientStyle::Linear {
            self.lose(name, format!("the {:?} style (drawn linear)", fill.style));
        }
        if (fill.scale - 100.0).abs() > 0.5 {
            self.lose(name, format!("the scale ({}%)", fill.scale));
        }
        if fill.offset != (0.0, 0.0) {
            self.lose(name, "the offset");
        }
        let gradient = self.gradient(name, &fill.gradient);
        self.push_own(
            name,
            g.enabled,
            g.blend,
            g.opacity,
            Effect::GradientOverlay(GradientOverlayParams {
                gradient: Some(gradient),
                angle_deg: Some(fill.angle),
                reverse: fill.reverse,
            }),
        );
    }

    fn stroke(&mut self, s: &Stroke) {
        let name = "Stroke";
        let rgb = match &s.fill {
            StrokeFill::Color { rgb } => *rgb,
            StrokeFill::Gradient(g) => {
                self.lose(name, "the gradient fill (its first colour is kept)");
                g.gradient.stops.first().map_or([0, 0, 0], |st| st.rgb)
            }
            StrokeFill::Pattern(p) => {
                self.lose(
                    name,
                    format!("the pattern fill {:?} (drawn black)", p.pattern.name),
                );
                [0, 0, 0]
            }
        };
        let color = self.color(rgb);
        let position = match s.position {
            paged_psd::effects::StrokePosition::Outside => StrokePosition::Outside,
            paged_psd::effects::StrokePosition::Inside => StrokePosition::Inside,
            paged_psd::effects::StrokePosition::Center => StrokePosition::Center,
        };
        let size_pt = self.px(s.size);
        self.push_own(
            name,
            s.enabled,
            s.blend,
            s.opacity,
            Effect::OutlineStroke(OutlineStrokeParams {
                size_pt,
                position,
                color: Some(color),
            }),
        );
    }
}

/// Map `style` onto the object target's stack.
#[must_use]
pub fn map_layer_style(style: &LayerStyle, opts: &MapOptions) -> MappedStyle {
    let mut out = MappedStyle::default();
    let mut m = Mapper {
        scale: opts.pt_per_px * style.scale / 100.0,
        out: &mut out,
    };
    // Bottom to top: the reverse of the Layer Style dialog.
    for (i, s) in style.drop_shadows.iter().enumerate() {
        m.shadow(s, true, i == 0);
    }
    if let Some(g) = &style.outer_glow {
        m.glow(g, true);
    }
    if let Some(p) = &style.pattern_overlay {
        m.lose(
            "Pattern Overlay",
            format!(
                "the pattern {:?} (no pattern paint on the stack)",
                p.fill.pattern.name
            ),
        );
    }
    for g in &style.gradient_overlays {
        m.gradient_overlay(g);
    }
    for c in &style.color_overlays {
        m.color_overlay(c);
    }
    if let Some(s) = &style.satin {
        m.satin(s);
    }
    if let Some(g) = &style.inner_glow {
        m.glow(g, false);
    }
    for (i, s) in style.inner_shadows.iter().enumerate() {
        m.shadow(s, false, i == 0);
    }
    for s in &style.strokes {
        m.stroke(s);
    }
    if let Some(b) = &style.bevel {
        m.bevel(b);
    }
    // The master switch off: every effect kept, none drawn.
    if !style.enabled {
        for e in &mut out.stack {
            e.enabled = false;
        }
    }
    out
}

/// The style of a PSD layer record (`lmfx`, else `lfx2`), mapped; `None`
/// for a layer without one.
#[must_use]
pub fn map_layer_record(
    rec: &paged_psd::model::LayerRecord,
    opts: &MapOptions,
) -> Option<MappedStyle> {
    paged_psd::effects::layer_style(rec).map(|s| map_layer_style(&s, opts))
}

/// Write a mapped style onto a page item's object target and its swatches
/// into `graphic` (an existing swatch of the same name is kept). Returns
/// the losses.
pub fn apply_mapped(
    mapped: MappedStyle,
    item: &mut impl EffectBearing,
    graphic: &mut Graphic,
) -> Result<Vec<StyleLoss>, StackError> {
    for c in mapped.colors {
        graphic.colors.entry(c.self_id.clone()).or_insert(c);
    }
    for g in mapped.gradients {
        graphic.gradients.entry(g.self_id.clone()).or_insert(g);
    }
    item.effect_slots_mut(EffectTarget::Object)
        .set_stack(mapped.stack)?;
    item.tidy_targets();
    Ok(mapped.losses)
}

/// [`map_layer_style`] and [`apply_mapped`] in one.
pub fn apply_layer_style(
    style: &LayerStyle,
    opts: &MapOptions,
    item: &mut impl EffectBearing,
    graphic: &mut Graphic,
) -> Result<Vec<StyleLoss>, StackError> {
    apply_mapped(map_layer_style(style, opts), item, graphic)
}
