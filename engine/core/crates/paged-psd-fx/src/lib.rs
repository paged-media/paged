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

//! Engine ADR 1044, amended by engine ADR 1099 — a Photoshop layer STYLE
//! (`paged-psd`'s [`LayerStyle`], read from `lfx2` / `lmfx`) mapped onto
//! the engine's ordered effect stack (engine ADR 1008), and back.
//!
//! [`map_layer_style`] is pure and LOSSLESS: every effect of the style
//! becomes an entry of the OBJECT target's stack drawn by the layer-style
//! convention (`EffectConvention::LayerStyle`), with every parameter in
//! the stack's layer-style fields (`paged_model::layer_style`): InDesign's
//! kinds carry theirs on the entry (parked, as a stored stack carries
//! them), the stack-only kinds carry their own. [`unmap_layer_style`] is
//! its inverse: `unmap(map(style)) == style` for every style at Scale
//! Effects 100 % (the scale is folded into the sizes), which is what lets
//! paged.image draw its layers' styles through the engine's evaluator
//! (`paged-layer-fx`) and still match Photoshop.
//!
//! | Photoshop | stack entry |
//! | --- | --- |
//! | Drop Shadow (each) | `dropShadow` (the first in the slot, the others carrying theirs) |
//! | Inner Shadow (each) | `innerShadow` (likewise) |
//! | Outer Glow, Inner Glow | `outerGlow`, `innerGlow` (contour, range, jitter, gradient fill) |
//! | Bevel & Emboss | `bevelEmboss` (gloss contour, Contour and Texture panes) |
//! | Satin | `satin` (contour) |
//! | Color Overlay (each) | `colorOverlay` |
//! | Gradient Overlay (each) | `gradientOverlay` (the whole gradient fill) |
//! | Pattern Overlay | `patternOverlay` |
//! | Stroke (each) | `outlineStroke` (its colour, gradient or pattern fill) |
//!
//! Losses, named: a Texture pane (kept, not drawn), a pattern whose tile
//! the caller cannot supply when it asks for tiles to be embedded.
//!
//! Order: the stack takes the effects in Photoshop's compositing order,
//! bottom first: drop shadows and the outer glow, then the pattern,
//! gradient and colour overlays, satin, the inner glow, the inner
//! shadows, the strokes and the bevel. Of several instances the first
//! listed in the dialog is the top-most, so they enter the stack last
//! listed first.
//!
//! Units: Photoshop sizes and distances are pixels of the document; they
//! are scaled by the style's Scale Effects and by `pt_per_px` (72 / the
//! document's ppi); a pattern's phase by `pt_per_px` alone. Opacities,
//! spreads, ranges and jitter are percentages on both sides; angles are
//! the light's direction on both sides.

pub mod adjustment;
pub mod place;

use paged_model::effect_stack::{
    ColorOverlayParams, Effect, EffectBearing, EffectConvention, EffectEntry, EffectTarget,
    GradientOverlayParams, IndesignParams, OutlineStrokeParams, StackError, StrokePosition,
};
use paged_model::layer_style::{
    FxAlphaStop, FxBevelContour, FxBevelTexture, FxColorStop, FxContour, FxCurvePoint, FxFill,
    FxGradientFill, FxGradientShape, FxPatternFill, FxPatternTile, FxRamp, PatternOverlayParams,
};
use paged_model::report::LossSeverity;
use paged_model::{
    BevelEmbossParams, ColorEntry, ColorModel, ColorSpace, DropShadowSetting, GradientEntry,
    GradientKind, GradientStopRef, Graphic, InnerGlowParams, InnerShadowParams, OuterGlowParams,
    SatinParams,
};
use paged_psd::effects::{
    Bevel, BevelContour, BevelLight, BevelStyle, BevelTechnique, BevelTexture, BlendMode,
    ColorFill, Contour, ContourPoint, Glow, GlowFill, GlowSource, GlowTechnique, Gradient,
    GradientColorStop, GradientFill, GradientOpacityStop, GradientOverlay, GradientStyle,
    LayerStyle, PatternFill, PatternOverlay, PatternRef, Satin, Shadow, Stroke, StrokeFill,
};

/// A pattern's tile, looked up by the pattern's id and name.
pub type TileLookup<'a> = &'a dyn Fn(&str, &str) -> Option<FxPatternTile>;

/// How Photoshop's pixels become the page's points, and where a
/// pattern's tile comes from.
#[derive(Clone, Copy)]
pub struct MapOptions<'a> {
    /// Points per document pixel: 72 / ppi (1.0 at 72 ppi).
    pub pt_per_px: f32,
    /// Embed each pattern's tile in its entry (a page item has no
    /// pattern table to look it up in); a pattern this cannot find is a
    /// loss. `None` leaves the tiles to the caller (paged.image resolves
    /// them from its document's patterns).
    pub tiles: Option<TileLookup<'a>>,
}

impl Default for MapOptions<'_> {
    fn default() -> Self {
        Self {
            pt_per_px: 1.0,
            tiles: None,
        }
    }
}

/// Something of the style the stack cannot say: the shared loss entry
/// (capability register C18), the Photoshop effect (`"Bevel & Emboss"`) as
/// its code and what of it is lost as its message.
pub type StyleLoss = paged_model::report::LossEntry;

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

impl MappedStyle {
    /// Each entry with the parameters it carries: what the layer-style
    /// evaluator plans from (`paged_layer_fx::FxPlan::of`).
    pub fn entries(&self) -> Vec<(EffectEntry, Option<IndesignParams>)> {
        self.stack
            .iter()
            .map(|e| (e.clone(), e.effect.carried()))
            .collect()
    }

    /// The sRGB colour a swatch the entries name stands for.
    pub fn color(&self, id: Option<&str>) -> Option<[u8; 3]> {
        swatch_rgb(&self.colors, id?)
    }
}

/// The sRGB value of an RGB swatch in `colors`.
pub fn swatch_rgb(colors: &[ColorEntry], id: &str) -> Option<[u8; 3]> {
    let c = colors.iter().find(|c| c.self_id == id)?;
    (c.value.len() == 3).then(|| [0, 1, 2].map(|i| c.value[i].round().clamp(0.0, 255.0) as u8))
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
            theme_ref: None,
        });
    }
    id
}

/// The IDML `BlendMode` of a Photoshop mode, or `None` for a mode IDML
/// has no name for (InDesign's readers draw those as the nearest one).
#[must_use]
pub fn idml_blend(mode: BlendMode) -> Option<&'static str> {
    mode.is_native().then(|| mode.name())
}

fn contour(c: &Contour) -> FxContour {
    FxContour {
        name: c.name.clone(),
        points: c
            .points
            .iter()
            .map(|p| FxCurvePoint {
                x: p.x,
                y: p.y,
                corner: p.corner,
            })
            .collect(),
    }
}

fn psd_contour(c: &FxContour) -> Contour {
    Contour {
        name: c.name.clone(),
        points: c
            .points
            .iter()
            .map(|p| ContourPoint {
                x: p.x,
                y: p.y,
                corner: p.corner,
            })
            .collect(),
    }
}

fn ramp(g: &Gradient) -> FxRamp {
    FxRamp {
        name: g.name.clone(),
        smoothness_pct: g.smoothness,
        color_stops: g
            .stops
            .iter()
            .map(|s| FxColorStop {
                at: s.at,
                rgb: s.rgb,
                midpoint: s.midpoint,
            })
            .collect(),
        alpha_stops: g
            .opacity_stops
            .iter()
            .map(|s| FxAlphaStop {
                at: s.at,
                opacity: s.opacity,
                midpoint: s.midpoint,
            })
            .collect(),
    }
}

fn psd_gradient(r: &FxRamp) -> Gradient {
    Gradient {
        name: r.name.clone(),
        smoothness: r.smoothness_pct,
        stops: r
            .color_stops
            .iter()
            .map(|s| GradientColorStop {
                at: s.at,
                rgb: s.rgb,
                midpoint: s.midpoint,
            })
            .collect(),
        opacity_stops: r
            .alpha_stops
            .iter()
            .map(|s| GradientOpacityStop {
                at: s.at,
                opacity: s.opacity,
                midpoint: s.midpoint,
            })
            .collect(),
        source: None,
    }
}

fn gradient_fill(g: &GradientFill) -> FxGradientFill {
    FxGradientFill {
        ramp: ramp(&g.gradient),
        shape: match g.style {
            GradientStyle::Linear => FxGradientShape::Linear,
            GradientStyle::Radial => FxGradientShape::Radial,
            GradientStyle::Angle => FxGradientShape::Angle,
            GradientStyle::Reflected => FxGradientShape::Reflected,
            GradientStyle::Diamond => FxGradientShape::Diamond,
        },
        angle_deg: g.angle,
        scale_pct: g.scale,
        reverse: g.reverse,
        dither: g.dither,
        align: g.align,
        offset_pct: [g.offset.0, g.offset.1],
    }
}

fn psd_gradient_fill(g: &FxGradientFill) -> GradientFill {
    GradientFill {
        gradient: psd_gradient(&g.ramp),
        style: match g.shape {
            FxGradientShape::Linear => GradientStyle::Linear,
            FxGradientShape::Radial => GradientStyle::Radial,
            FxGradientShape::Angle => GradientStyle::Angle,
            FxGradientShape::Reflected => GradientStyle::Reflected,
            FxGradientShape::Diamond => GradientStyle::Diamond,
        },
        angle: g.angle_deg,
        scale: g.scale_pct,
        reverse: g.reverse,
        dither: g.dither,
        align: g.align,
        offset: (g.offset_pct[0], g.offset_pct[1]),
    }
}

/// A blend mode by its model spelling (`BlendMode::name`, all 27).
fn mode_of(name: Option<&str>, default: BlendMode) -> BlendMode {
    name.and_then(BlendMode::from_name).unwrap_or(default)
}

struct Mapper<'a, 'o> {
    scale: f32,
    pt_per_px: f32,
    tiles: Option<TileLookup<'o>>,
    out: &'a mut MappedStyle,
}

impl Mapper<'_, '_> {
    fn px(&self, v: f32) -> f32 {
        v * self.scale
    }

    fn lose(&mut self, effect: &'static str, severity: LossSeverity, what: impl Into<String>) {
        self.out.losses.push(StyleLoss::new(effect, severity, what));
    }

    fn color(&mut self, rgb: [u8; 3]) -> String {
        rgb_swatch(rgb, &mut self.out.colors)
    }

    fn push(&mut self, enabled: bool, effect: Effect) {
        self.out.stack.push(EffectEntry {
            enabled,
            convention: Some(EffectConvention::LayerStyle),
            ..EffectEntry::new(effect)
        });
    }

    /// A stack-only entry with its own blend and opacity.
    fn push_own(&mut self, enabled: bool, blend: BlendMode, opacity: f32, effect: Effect) {
        self.out.stack.push(EffectEntry {
            enabled,
            blend_mode: (blend != BlendMode::Normal).then(|| blend.name().to_string()),
            opacity_pct: ((opacity - 100.0).abs() > f32::EPSILON).then_some(opacity),
            convention: Some(EffectConvention::LayerStyle),
            effect,
        });
    }

    /// A gradient swatch of the ramp's colours, for the stack's readers
    /// that do not draw layer styles.
    fn gradient(&mut self, g: &Gradient) -> String {
        // Named by its stops, so the same gradient is one swatch however
        // many layers name it, and two different ones never share a name.
        let key: String = g
            .stops
            .iter()
            .map(|s| format!("{:?}@{}/{};", s.rgb, s.at, s.midpoint))
            .collect();
        let id = format!(
            "Gradient/PSD {:016x}",
            paged_pixel::fnv1a_64(key.as_bytes())
        );
        if self.out.gradients.iter().any(|x| x.self_id == id) {
            return id;
        }
        let stops = g
            .stops
            .iter()
            .map(|s| GradientStopRef {
                stop_color: self.color(s.rgb),
                location_pct: s.at * 100.0,
                midpoint_pct: Some(s.midpoint * 100.0),
                opacity_pct: None,
                inline_color: None,
            })
            .collect();
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

    fn pattern(&mut self, effect: &'static str, p: &PatternFill) -> FxPatternFill {
        let tile = self.tiles.and_then(|look| {
            let t = look(&p.pattern.id, &p.pattern.name);
            if t.is_none() {
                self.out.losses.push(StyleLoss::new(
                    effect,
                    LossSeverity::Dropped,
                    format!("the pattern {:?} (not in the file)", p.pattern.name),
                ));
            }
            t
        });
        FxPatternFill {
            pattern_id: p.pattern.id.clone(),
            pattern_name: p.pattern.name.clone(),
            scale_pct: p.scale,
            link: p.link,
            phase: [p.phase.0 * self.pt_per_px, p.phase.1 * self.pt_per_px],
            tile,
        }
    }

    fn shadow(&mut self, s: &Shadow, drop: bool) {
        let color = self.color(s.color);
        let blend = Some(s.blend.name().to_string());
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
                blend_mode: blend,
                spread_pct: Some(s.spread),
                noise_pct: Some(s.noise),
                knocked_out: Some(s.knocks_out),
                use_global_light: Some(s.use_global_light),
                angle_deg: Some(s.angle),
                distance: Some(distance),
                contour: Some(contour(&s.contour)),
                anti_aliased: Some(s.anti_aliased),
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
                blend_mode: blend,
                noise_pct: Some(s.noise),
                use_global_light: Some(s.use_global_light),
                contour: Some(contour(&s.contour)),
                anti_aliased: Some(s.anti_aliased),
                ..Default::default()
            };
            self.push(s.enabled, Effect::InnerShadow { parked: Some(p) });
        }
    }

    fn glow(&mut self, g: &Glow, outer: bool) {
        let (color, gradient) = match &g.fill {
            GlowFill::Color { rgb } => (self.color(*rgb), None),
            GlowFill::Gradient { gradient } => {
                let first = gradient.stops.first().map_or([255, 255, 255], |s| s.rgb);
                (self.color(first), Some(ramp(gradient)))
            }
        };
        let blend = Some(g.blend.name().to_string());
        let technique = Some(
            match g.technique {
                GlowTechnique::Softer => "Softer",
                GlowTechnique::Precise => "Precise",
            }
            .to_string(),
        );
        let size = Some(self.px(g.size));
        if outer {
            let p = OuterGlowParams {
                size,
                opacity_pct: Some(g.opacity),
                effect_color: Some(color),
                spread_pct: Some(g.spread),
                blend_mode: blend,
                noise_pct: Some(g.noise),
                technique,
                contour: Some(contour(&g.contour)),
                anti_aliased: Some(g.anti_aliased),
                range_pct: Some(g.range),
                jitter_pct: Some(g.jitter),
                gradient,
            };
            self.push(g.enabled, Effect::OuterGlow { parked: Some(p) });
        } else {
            let p = InnerGlowParams {
                size,
                opacity_pct: Some(g.opacity),
                effect_color: Some(color),
                choke_pct: Some(g.spread),
                blend_mode: blend,
                source: Some(
                    match g.source {
                        GlowSource::Edge => "EdgeGlow",
                        GlowSource::Center => "CenterGlow",
                    }
                    .to_string(),
                ),
                noise_pct: Some(g.noise),
                technique,
                contour: Some(contour(&g.contour)),
                anti_aliased: Some(g.anti_aliased),
                range_pct: Some(g.range),
                jitter_pct: Some(g.jitter),
                gradient,
            };
            self.push(g.enabled, Effect::InnerGlow { parked: Some(p) });
        }
    }

    fn bevel(&mut self, b: &Bevel) {
        let name = "Bevel & Emboss";
        if b.texture.as_ref().is_some_and(|t| t.enabled) {
            self.lose(
                name,
                LossSeverity::Approximated,
                "the Texture pane (kept, drawn without)",
            );
        }
        let texture = b.texture.as_ref().map(|t| FxBevelTexture {
            enabled: t.enabled,
            fill: self.pattern(name, &t.fill),
            depth_pct: t.depth,
            invert: t.invert,
        });
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
            highlight_blend_mode: Some(b.highlight.blend.name().to_string()),
            shadow_blend_mode: Some(b.shadow.blend.name().to_string()),
            use_global_light: Some(b.use_global_light),
            gloss_contour: Some(contour(&b.gloss)),
            gloss_anti_aliased: Some(b.gloss_anti_aliased),
            contour: b.contour.as_ref().map(|c| FxBevelContour {
                enabled: c.enabled,
                contour: contour(&c.contour),
                anti_aliased: c.anti_aliased,
                range_pct: c.range,
            }),
            texture,
        };
        self.push(b.enabled, Effect::BevelEmboss { parked: Some(p) });
    }

    fn satin(&mut self, s: &Satin) {
        let p = SatinParams {
            size: Some(self.px(s.size)),
            angle_deg: Some(s.angle),
            distance: Some(self.px(s.distance)),
            effect_color: Some(self.color(s.color)),
            opacity_pct: Some(s.opacity),
            blend_mode: Some(s.blend.name().to_string()),
            invert: Some(s.invert),
            contour: Some(contour(&s.contour)),
            anti_aliased: Some(s.anti_aliased),
        };
        self.push(s.enabled, Effect::Satin { parked: Some(p) });
    }

    fn color_overlay(&mut self, c: &ColorFill) {
        let color = self.color(c.color);
        self.push_own(
            c.enabled,
            c.blend,
            c.opacity,
            Effect::ColorOverlay(ColorOverlayParams { color: Some(color) }),
        );
    }

    fn gradient_overlay(&mut self, g: &GradientOverlay) {
        let gradient = self.gradient(&g.fill.gradient);
        self.push_own(
            g.enabled,
            g.blend,
            g.opacity,
            Effect::GradientOverlay(GradientOverlayParams {
                gradient: Some(gradient),
                angle_deg: Some(g.fill.angle),
                reverse: g.fill.reverse,
                fill: Some(gradient_fill(&g.fill)),
            }),
        );
    }

    fn pattern_overlay(&mut self, o: &PatternOverlay) {
        let fill = self.pattern("Pattern Overlay", &o.fill);
        self.push_own(
            o.enabled,
            o.blend,
            o.opacity,
            Effect::PatternOverlay(PatternOverlayParams { fill }),
        );
    }

    fn stroke(&mut self, s: &Stroke) {
        let (rgb, fill) = match &s.fill {
            StrokeFill::Color { rgb } => (*rgb, FxFill::Color { rgb: *rgb }),
            StrokeFill::Gradient(g) => (
                g.gradient.stops.first().map_or([0, 0, 0], |st| st.rgb),
                FxFill::Gradient(gradient_fill(g)),
            ),
            StrokeFill::Pattern(p) => ([0, 0, 0], FxFill::Pattern(self.pattern("Stroke", p))),
        };
        let color = self.color(rgb);
        let position = match s.position {
            paged_psd::effects::StrokePosition::Outside => StrokePosition::Outside,
            paged_psd::effects::StrokePosition::Inside => StrokePosition::Inside,
            paged_psd::effects::StrokePosition::Center => StrokePosition::Center,
        };
        let size_pt = self.px(s.size);
        self.push_own(
            s.enabled,
            s.blend,
            s.opacity,
            Effect::OutlineStroke(OutlineStrokeParams {
                size_pt,
                position,
                color: Some(color),
                fill: Some(fill),
            }),
        );
    }
}

/// Map `style` onto the object target's stack.
#[must_use]
pub fn map_layer_style(style: &LayerStyle, opts: &MapOptions<'_>) -> MappedStyle {
    let mut out = MappedStyle::default();
    let mut m = Mapper {
        scale: opts.pt_per_px * style.scale / 100.0,
        pt_per_px: opts.pt_per_px,
        tiles: opts.tiles,
        out: &mut out,
    };
    // Bottom to top: the reverse of the Layer Style dialog, and of each
    // effect's instances.
    for s in style.drop_shadows.iter().rev() {
        m.shadow(s, true);
    }
    if let Some(g) = &style.outer_glow {
        m.glow(g, true);
    }
    if let Some(p) = &style.pattern_overlay {
        m.pattern_overlay(p);
    }
    for g in style.gradient_overlays.iter().rev() {
        m.gradient_overlay(g);
    }
    for c in style.color_overlays.iter().rev() {
        m.color_overlay(c);
    }
    if let Some(s) = &style.satin {
        m.satin(s);
    }
    if let Some(g) = &style.inner_glow {
        m.glow(g, false);
    }
    for s in style.inner_shadows.iter().rev() {
        m.shadow(s, false);
    }
    for s in style.strokes.iter().rev() {
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
    opts: &MapOptions<'_>,
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
    opts: &MapOptions<'_>,
    item: &mut impl EffectBearing,
    graphic: &mut Graphic,
) -> Result<Vec<StyleLoss>, StackError> {
    apply_mapped(map_layer_style(style, opts), item, graphic)
}

/// The inverse of [`map_layer_style`]: the layer style a stack's
/// layer-style entries make, in Photoshop's pixels at `pt_per_px` and
/// Scale Effects 100 %. `entries` are a resolved stack with each entry's
/// parameters (`SlotsRef::with_params`, or [`MappedStyle::entries`]);
/// `color` resolves a swatch to sRGB. An entry of another convention (an
/// InDesign effect) is read with its InDesign parameters where Photoshop
/// has the effect, and a loss where it has not (feathers, blur, noise,
/// reflection, soft edge, colour adjustment, the vector effects).
pub fn unmap_layer_style(
    entries: &[(EffectEntry, Option<IndesignParams>)],
    pt_per_px: f32,
    color: &dyn Fn(Option<&str>) -> Option<[u8; 3]>,
) -> (LayerStyle, Vec<StyleLoss>) {
    let px = |v: f32| v / pt_per_px;
    let rgb = |id: &Option<String>, d: [u8; 3]| color(id.as_deref()).unwrap_or(d);
    let lin = |c: &Option<FxContour>| c.as_ref().map_or_else(Contour::linear, psd_contour);
    let mut st = LayerStyle {
        enabled: entries.iter().any(|(e, _)| e.enabled) || entries.is_empty(),
        ..LayerStyle::default()
    };
    let mut losses = Vec::new();
    for (e, params) in entries {
        let enabled = e.enabled || !st.enabled;
        let own_blend = mode_of(e.blend_mode.as_deref(), BlendMode::Normal);
        let own_opacity = e.opacity_pct.unwrap_or(100.0);
        match (&e.effect, params) {
            (Effect::DropShadow { .. }, Some(IndesignParams::DropShadow(d))) => {
                let (angle, distance) = match (d.angle_deg, d.distance) {
                    (Some(a), Some(dist)) => (a, dist),
                    _ => (
                        d.y_offset.atan2(-d.x_offset).to_degrees(),
                        d.x_offset.hypot(d.y_offset),
                    ),
                };
                st.drop_shadows.insert(
                    0,
                    Shadow {
                        enabled,
                        blend: mode_of(d.blend_mode.as_deref(), BlendMode::Multiply),
                        color: rgb(&d.effect_color, [0, 0, 0]),
                        opacity: d.opacity_pct,
                        use_global_light: d.use_global_light.unwrap_or(false),
                        angle,
                        distance: px(distance),
                        spread: d.spread_pct.unwrap_or(0.0),
                        size: px(d.size),
                        noise: d.noise_pct.unwrap_or(0.0),
                        contour: lin(&d.contour),
                        anti_aliased: d.anti_aliased.unwrap_or(false),
                        knocks_out: d.knocked_out.unwrap_or(true),
                        source: None,
                    },
                );
            }
            (Effect::InnerShadow { .. }, Some(IndesignParams::InnerShadow(s))) => {
                let (angle, distance) = match (s.angle_deg, s.distance) {
                    (Some(a), Some(d)) => (a, d),
                    _ => {
                        let (x, y) = (s.x_offset.unwrap_or(0.0), s.y_offset.unwrap_or(0.0));
                        (y.atan2(-x).to_degrees(), x.hypot(y))
                    }
                };
                st.inner_shadows.insert(
                    0,
                    Shadow {
                        enabled,
                        blend: mode_of(s.blend_mode.as_deref(), BlendMode::Multiply),
                        color: rgb(&s.effect_color, [0, 0, 0]),
                        opacity: s.opacity_pct.unwrap_or(75.0),
                        use_global_light: s.use_global_light.unwrap_or(false),
                        angle,
                        distance: px(distance),
                        spread: s.choke_pct.unwrap_or(0.0),
                        size: px(s.size.unwrap_or(0.0)),
                        noise: s.noise_pct.unwrap_or(0.0),
                        contour: lin(&s.contour),
                        anti_aliased: s.anti_aliased.unwrap_or(false),
                        knocks_out: false,
                        source: None,
                    },
                );
            }
            (Effect::OuterGlow { .. }, Some(IndesignParams::OuterGlow(g))) => {
                st.outer_glow = Some(unmap_glow(
                    enabled,
                    &g.blend_mode,
                    rgb(&g.effect_color, [255, 255, 190]),
                    &g.gradient,
                    g.opacity_pct,
                    &g.technique,
                    g.spread_pct,
                    g.size.map(px),
                    g.range_pct,
                    g.jitter_pct,
                    g.noise_pct,
                    lin(&g.contour),
                    g.anti_aliased,
                    GlowSource::Edge,
                ));
            }
            (Effect::InnerGlow { .. }, Some(IndesignParams::InnerGlow(g))) => {
                st.inner_glow = Some(unmap_glow(
                    enabled,
                    &g.blend_mode,
                    rgb(&g.effect_color, [255, 255, 190]),
                    &g.gradient,
                    g.opacity_pct,
                    &g.technique,
                    g.choke_pct,
                    g.size.map(px),
                    g.range_pct,
                    g.jitter_pct,
                    g.noise_pct,
                    lin(&g.contour),
                    g.anti_aliased,
                    if g.source.as_deref() == Some("CenterGlow") {
                        GlowSource::Center
                    } else {
                        GlowSource::Edge
                    },
                ));
            }
            (Effect::Satin { .. }, Some(IndesignParams::Satin(s))) => {
                st.satin = Some(Satin {
                    enabled,
                    blend: mode_of(s.blend_mode.as_deref(), BlendMode::Multiply),
                    color: rgb(&s.effect_color, [0, 0, 0]),
                    opacity: s.opacity_pct.unwrap_or(50.0),
                    angle: s.angle_deg.unwrap_or(19.0),
                    distance: px(s.distance.unwrap_or(0.0)),
                    size: px(s.size.unwrap_or(0.0)),
                    contour: lin(&s.contour),
                    anti_aliased: s.anti_aliased.unwrap_or(false),
                    invert: s.invert.unwrap_or(true),
                    source: None,
                });
            }
            (Effect::BevelEmboss { .. }, Some(IndesignParams::BevelEmboss(b))) => {
                let light = |blend: &Option<String>,
                             d: BlendMode,
                             c: &Option<String>,
                             fallback: [u8; 3],
                             o: Option<f32>| BevelLight {
                    blend: mode_of(blend.as_deref(), d),
                    color: rgb(c, fallback),
                    opacity: o.unwrap_or(75.0),
                };
                st.bevel = Some(Bevel {
                    enabled,
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
                    size: px(b.size.unwrap_or(0.0)),
                    soften: px(b.soften.unwrap_or(0.0)),
                    use_global_light: b.use_global_light.unwrap_or(false),
                    angle: b.angle_deg.unwrap_or(120.0),
                    altitude: b.altitude_deg.unwrap_or(30.0),
                    gloss: lin(&b.gloss_contour),
                    gloss_anti_aliased: b.gloss_anti_aliased.unwrap_or(false),
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
                    contour: b.contour.as_ref().map(|c| BevelContour {
                        enabled: c.enabled,
                        contour: psd_contour(&c.contour),
                        anti_aliased: c.anti_aliased,
                        range: c.range_pct,
                    }),
                    texture: b.texture.as_ref().map(|t| BevelTexture {
                        enabled: t.enabled,
                        fill: psd_pattern(&t.fill, pt_per_px),
                        depth: t.depth_pct,
                        invert: t.invert,
                    }),
                    source: None,
                });
            }
            (Effect::ColorOverlay(c), _) => st.color_overlays.insert(
                0,
                ColorFill {
                    enabled,
                    blend: own_blend,
                    color: rgb(&c.color, [0, 0, 0]),
                    cmyk: None,
                    opacity: own_opacity,
                    source: None,
                },
            ),
            (Effect::GradientOverlay(g), _) => st.gradient_overlays.insert(
                0,
                GradientOverlay {
                    enabled,
                    blend: own_blend,
                    opacity: own_opacity,
                    fill: g.fill.as_ref().map_or_else(
                        || GradientFill {
                            angle: g.angle_deg.unwrap_or(0.0),
                            reverse: g.reverse,
                            ..GradientFill::default()
                        },
                        psd_gradient_fill,
                    ),
                    source: None,
                },
            ),
            (Effect::PatternOverlay(o), _) => {
                st.pattern_overlay = Some(PatternOverlay {
                    enabled,
                    blend: own_blend,
                    opacity: own_opacity,
                    fill: psd_pattern(&o.fill, pt_per_px),
                    source: None,
                });
            }
            (Effect::OutlineStroke(s), _) => st.strokes.insert(
                0,
                Stroke {
                    enabled,
                    position: match s.position {
                        StrokePosition::Outside => paged_psd::effects::StrokePosition::Outside,
                        StrokePosition::Inside => paged_psd::effects::StrokePosition::Inside,
                        StrokePosition::Center => paged_psd::effects::StrokePosition::Center,
                    },
                    fill: match &s.fill {
                        Some(FxFill::Gradient(g)) => StrokeFill::Gradient(psd_gradient_fill(g)),
                        Some(FxFill::Pattern(p)) => StrokeFill::Pattern(psd_pattern(p, pt_per_px)),
                        Some(FxFill::Color { rgb }) => StrokeFill::Color { rgb: *rgb },
                        None => StrokeFill::Color {
                            rgb: rgb(&s.color, [0, 0, 0]),
                        },
                    },
                    blend: own_blend,
                    opacity: own_opacity,
                    size: px(s.size_pt),
                    source: None,
                },
            ),
            (other, _) => losses.push(StyleLoss::new(
                other.kind_name(),
                LossSeverity::Dropped,
                "a layer style has no such effect",
            )),
        }
    }
    (st, losses)
}

fn psd_pattern(p: &FxPatternFill, pt_per_px: f32) -> PatternFill {
    PatternFill {
        pattern: PatternRef {
            name: p.pattern_name.clone(),
            id: p.pattern_id.clone(),
        },
        scale: p.scale_pct,
        link: p.link,
        phase: (p.phase[0] / pt_per_px, p.phase[1] / pt_per_px),
    }
}

#[allow(clippy::too_many_arguments)]
fn unmap_glow(
    enabled: bool,
    blend: &Option<String>,
    rgb: [u8; 3],
    gradient: &Option<FxRamp>,
    opacity: Option<f32>,
    technique: &Option<String>,
    spread: Option<f32>,
    size: Option<f32>,
    range: Option<f32>,
    jitter: Option<f32>,
    noise: Option<f32>,
    contour: Contour,
    anti_aliased: Option<bool>,
    source: GlowSource,
) -> Glow {
    Glow {
        enabled,
        blend: mode_of(blend.as_deref(), BlendMode::Screen),
        fill: match gradient {
            Some(g) => GlowFill::Gradient {
                gradient: psd_gradient(g),
            },
            None => GlowFill::Color { rgb },
        },
        opacity: opacity.unwrap_or(75.0),
        technique: if technique.as_deref() == Some("Precise") {
            GlowTechnique::Precise
        } else {
            GlowTechnique::Softer
        },
        spread: spread.unwrap_or(0.0),
        size: size.unwrap_or(0.0),
        range: range.unwrap_or(50.0),
        jitter: jitter.unwrap_or(0.0),
        noise: noise.unwrap_or(0.0),
        contour,
        anti_aliased: anti_aliased.unwrap_or(false),
        source,
        descriptor: None,
    }
}
