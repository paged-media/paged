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

//! # dml-native — DrawingML paint onto the engine's model, once
//!
//! paged.slide and paged.doc both build the engine's native model from
//! DrawingML (PresentationML shapes, WordprocessingML drawings). The format
//! side is read once by `paged_ooxml::drawingml` into a neutral resolved IR
//! ([`Paint`], [`Stroke`], [`Effects`], [`Picture`]); this crate is the
//! one lowering of that IR onto `paged_model` (slide ADR 722):
//!
//! - **Swatches** ([`Palette`]): RGB colour swatches (a theme colour by its
//!   slot name), gradient swatches deduplicated by kind and stops, and the
//!   `ColorEntry` / `GradientEntry` resources they become.
//! - **Fills** ([`Mapper::paint`], [`placement`]): a solid colour; a linear
//!   gradient's angle and span as PowerPoint runs it (across the box
//!   projected on its direction); a radial one's centre and reach; a
//!   pattern as the mix of its two colours (the engine has no pattern
//!   paint yet: reported).
//! - **Strokes** ([`Mapper::stroke`]): weight, compound lines as stroke
//!   styles, preset and custom dashes as per-item dash patterns, caps,
//!   joins, the miter limit, inside alignment and arrowheads.
//! - **Transparency and effects** ([`Mapper::transparency`]): the item
//!   opacity; a gradient whose stops differ in alpha as a gradient feather
//!   (gradient swatches carry no alpha); the outer shadow as the drop
//!   shadow; the inner shadow, glow and soft edge as `FrameEffects`; a
//!   preset shadow as a plain drop shadow; the fill overlay, blur and
//!   reflection as the item's ordered effect stack (engine ADR 1008:
//!   colour overlay, Gaussian blur, reflection). A shadow's distortion, a
//!   reflection other than a mirror image below, and a gradient or
//!   picture overlay (which PowerPoint does not draw) are reported.
//! - **Pictures** ([`Mapper::picture_at`]): `a:alphaModFix` as opacity;
//!   `a:lum`, `a:duotone`, `a:grayscl`, `a:biLevel`, `a:hsl`, `a:clrRepl`
//!   and (given the picture's pixel density) `a:blur` as the image
//!   frame's filter stack (engine ADR 1037); the Office 2010 corrections
//!   and artistic effects are already in the image Office stored; a
//!   colour change and a tint, which have no equivalent op, are
//!   reported.
//! - **Fill rule** ([`Mapper::fill_rule`]): PowerPoint fills each
//!   `a:path` even-odd; an outline where that differs from non-zero takes
//!   the even-odd rule (engine ADR 1006).
//! - **The inverse** ([`effects_of`], [`effects_with_stack`],
//!   [`dash_of`]): the engine's drop shadow, effects, effect stack and
//!   dash pattern back as the neutral IR, which
//!   `paged_ooxml::drawingml::write` writes as DrawingML.
//!
//! - **For a module that places items through mutations** ([`native`]):
//!   [`native::Lowering`] runs the whole chain for a shape's or a
//!   picture's authored DrawingML and restates the result as
//!   [`native::NativeFx`], serialisable, colours as `#RRGGBB` (doc ADR
//!   618).
//!
//! What the engine cannot hold is never dropped silently: it goes to
//! [`Mapper::losses`], one line per kind of loss, for the module's
//! diagnostics.

use std::collections::BTreeMap;

pub mod native;

use paged_model::effect_stack::{
    ColorOverlayParams, Effect, EffectEntry, GaussianBlurParams, IndesignEffect, ReflectionParams,
};
use paged_model::{
    ArrowheadType, ColorEntry, ColorModel, ColorSpace, DropShadowSetting, FeatherParams, FillRule,
    FrameEffects, GradientEntry, GradientFeatherParams, GradientFeatherStop, GradientKind,
    GradientStopRef, InnerShadowParams, OuterGlowParams, PathAnchor, RasterOp,
};
pub use paged_ooxml::drawingml::resolved::{
    radial_reach, Blur, Effects, FillOverlay, Glow, ImageEffect, Paint, PatternPaint, Picture,
    PresetShadow, Reflection, Rgb, Shadow, Stop, Stroke,
};

/// The None swatch: no paint.
pub const NONE_SWATCH: &str = "Swatch/None";

/// A DrawingML blur radius (`a:blur rad`, a reflection's `blurRad`) as the
/// Gaussian's σ: PowerPoint's blur reaches about the radius on either side
/// of the edge, three σ (measured on PowerPoint's own PDF of a 10 pt blur:
/// the edge ramps from 16 % to 84 % over 6.6 pt, 2σ).
pub const BLUR_SIGMA_PER_RADIUS: f64 = 1.0 / 3.0;

/// A length or coordinate as the model keeps it: to the thousandth of a
/// point (and never `-0`).
pub fn pt(v: f64) -> f32 {
    let r = (v * 1000.0).round() / 1000.0;
    if r == 0.0 {
        0.0
    } else {
        r as f32
    }
}

/// A fill gradient's placement on an item: a linear one's angle (the
/// engine's, counter-clockwise) and span, a radial one's centre and reach.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Placement {
    pub angle: Option<f32>,
    pub length: Option<f32>,
    pub start: Option<[f32; 2]>,
}

/// Where a gradient paint sits on a `w` × `h` item (nothing for any other
/// paint).
pub fn placement(p: &Paint, w: f64, h: f64) -> Placement {
    match p {
        // DrawingML angles run clockwise on a y-down page; the engine's
        // gradient angle runs counter-clockwise.
        Paint::Linear { angle, .. } => span(-angle, w, h),
        Paint::Radial { center, .. } => Placement {
            angle: None,
            length: Some(pt(radial_reach(*center, w, h))),
            start: Some([pt(center.0 * w), pt(center.1 * h)]),
        },
        _ => Placement::default(),
    }
}

/// A linear gradient's angle and span: PowerPoint runs it across the box
/// projected on its direction (w·|cos| + h·|sin|), the engine across the
/// diagonal unless told the length.
pub fn span(angle: f64, w: f64, h: f64) -> Placement {
    let (sn, cs) = angle.to_radians().sin_cos();
    Placement {
        angle: Some(pt(angle)),
        length: Some(pt(w * cs.abs() + h * sn.abs())),
        start: None,
    }
}

/// Where a fill gradient's axis starts on a `w` × `h` box, relative to the
/// box's top-left: a radial one's centre ([`placement`] already says it);
/// for a linear one, the start of the axis PowerPoint and Excel run
/// through the box's centre, `length` long at the engine's (counter-
/// clockwise) angle. The engine starts an unplaced linear gradient at
/// the box's bottom-left corner, which is that start only for an axis
/// running up or right (0°–90°); a module that knows the item's inner
/// coordinates states the start instead (sheet ADR 527).
pub fn axis_start(p: &Placement, w: f64, h: f64) -> Option<[f32; 2]> {
    if p.start.is_some() {
        return p.start;
    }
    let (sn, cs) = (p.angle? as f64).to_radians().sin_cos();
    let half = p.length? as f64 / 2.0;
    // The engine's axis direction on the y-down page is (cos θ, −sin θ).
    Some([pt(w / 2.0 - half * cs), pt(h / 2.0 + half * sn)])
}

/// A gradient swatch: id, kind, (location %, colour id) stops.
type GradientSwatch = (String, GradientKind, Vec<(f64, String)>);

/// How a document names the theme colour a solid paint keeps
/// (`Paint::Solid::theme`): its swatch id and name, or `None` for a key it
/// does not keep live.
pub type ThemeNamer = fn(&str) -> Option<(String, String)>;

/// The swatches a document's paints need.
#[derive(Debug, Clone, Default)]
pub struct Palette {
    colors: BTreeMap<Rgb, String>,
    theme_names: BTreeMap<Rgb, String>,
    /// Swatches a paint names by id rather than by value: a live theme
    /// colour (`Color/accent1`, with its transforms) and, in a palette with
    /// a [`ThemeNamer`], a plain colour (`Color/RRRGGBB`). Id → (name, rgb).
    named: BTreeMap<String, (String, Rgb)>,
    /// In minting order.
    gradients: Vec<GradientSwatch>,
}

impl Palette {
    /// A palette whose colours that are theme colours take the slot's
    /// name (`Color/accent1`).
    pub fn new(theme_colors: &[(String, Rgb)]) -> Self {
        Palette {
            theme_names: theme_colors.iter().map(|(k, c)| (*c, k.clone())).collect(),
            ..Palette::default()
        }
    }

    /// The colour swatch of `rgb` (`Color/accent1` for a theme colour,
    /// else `Color/RRRGGBB`).
    pub fn color(&mut self, rgb: Rgb) -> String {
        if let Some(id) = self.colors.get(&rgb) {
            return id.clone();
        }
        let id = match self.theme_names.get(&rgb) {
            Some(name) => format!("Color/{name}"),
            None => format!("Color/R{:02X}{:02X}{:02X}", rgb[0], rgb[1], rgb[2]),
        };
        self.colors.insert(rgb, id.clone());
        id
    }

    /// The swatch `id` named `name` holding `rgb`: a theme colour a paint
    /// refers to by id, so that recolouring the swatch recolours the paint.
    pub fn themed(&mut self, id: &str, name: &str, rgb: Rgb) -> String {
        self.named
            .entry(id.to_string())
            .or_insert_with(|| (name.to_string(), rgb));
        id.to_string()
    }

    /// The swatch of `rgb` as a plain colour (`Color/RRRGGBB`), never a
    /// theme colour's, whatever its value.
    pub fn literal(&mut self, rgb: Rgb) -> String {
        let id = format!("Color/R{:02X}{:02X}{:02X}", rgb[0], rgb[1], rgb[2]);
        let name = id.trim_start_matches("Color/").to_string();
        self.named.entry(id.clone()).or_insert((name, rgb));
        id
    }

    /// The swatches minted by id ([`Palette::themed`], [`Palette::literal`]):
    /// id, name and colour.
    pub fn named(&self) -> impl Iterator<Item = (&String, &(String, Rgb))> {
        self.named.iter()
    }

    /// The gradient swatch of `kind` through `stops` (alpha aside: the
    /// engine's gradient swatches carry none).
    pub fn gradient(&mut self, kind: GradientKind, stops: &[Stop]) -> String {
        let refs: Vec<(f64, String)> = stops.iter().map(|s| (s.pos, self.color(s.rgb))).collect();
        if let Some((id, _, _)) = self
            .gradients
            .iter()
            .find(|(_, k, s)| *k == kind && *s == refs)
        {
            return id.clone();
        }
        let id = format!("Gradient/g{}", self.gradients.len() + 1);
        self.gradients.push((id.clone(), kind, refs));
        id
    }

    /// The colours minted, with their swatch ids, by colour.
    pub fn colors(&self) -> impl Iterator<Item = (&Rgb, &String)> {
        self.colors.iter()
    }

    /// The RGB colour entries of every colour minted, once per id (a
    /// swatch minted by id names it).
    pub fn color_entries(&self) -> Vec<ColorEntry> {
        let entry = |id: &String, name: String, rgb: &Rgb| ColorEntry {
            self_id: id.clone(),
            name: Some(name),
            space: ColorSpace::Rgb,
            value: rgb.iter().map(|&c| c as f32).collect(),
            model: ColorModel::Process,
            alternate_space: None,
            alternate_value: Vec::new(),
            tint: None,
            alpha: None,
        };
        let mut out: Vec<ColorEntry> = self
            .colors
            .iter()
            .filter(|(_, id)| !self.named.contains_key(*id))
            .map(|(rgb, id)| entry(id, id.trim_start_matches("Color/").to_string(), rgb))
            .collect();
        out.extend(
            self.named
                .iter()
                .map(|(id, (name, rgb))| entry(id, name.clone(), rgb)),
        );
        out
    }

    /// The gradient entries of every gradient minted.
    pub fn gradient_entries(&self) -> Vec<GradientEntry> {
        self.gradients
            .iter()
            .map(|(id, kind, stops)| GradientEntry {
                self_id: id.clone(),
                name: Some(id.trim_start_matches("Gradient/").to_string()),
                kind: *kind,
                stops: stops
                    .iter()
                    .map(|(pos, c)| GradientStopRef {
                        stop_color: c.clone(),
                        location_pct: pt(*pos),
                        midpoint_pct: None,
                        opacity_pct: None,
                        inline_color: None,
                    })
                    .collect(),
            })
            .collect()
    }
}

/// A stroke as the model's item fields hold it.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct StrokeFields {
    pub color: Option<String>,
    pub weight: Option<f32>,
    /// `StrokeType` (a compound line's style, or Dashed).
    pub kind: Option<String>,
    pub cap: Option<String>,
    pub join: Option<String>,
    pub miter_limit: Option<f32>,
    /// `StrokeAlignment`, when not centred.
    pub alignment: Option<String>,
    /// The per-item dash pattern (pt, on/off).
    pub dash: Vec<f32>,
    pub head: Option<ArrowheadType>,
    pub tail: Option<ArrowheadType>,
}

/// The transparency of an item: opacity, drop shadow, the other effects.
#[derive(Debug, Clone, Default)]
pub struct Transparency {
    pub opacity: Option<f32>,
    pub shadow: Option<DropShadowSetting>,
    pub effects: Option<FrameEffects>,
    /// The object's effect stack (engine ADR 1008) when it holds an effect
    /// InDesign has none of: every effect in the order it is drawn,
    /// InDesign's naming their slots (`shadow`, `effects`) first.
    /// Empty when InDesign's effects say all of it (the canonical form).
    pub stack: Vec<EffectEntry>,
}

/// The engine's blend mode (an IDML `BlendMode` name) for a DrawingML
/// `a:fillOverlay blend` (`ST_BlendMode`).
pub fn overlay_blend(blend: &str) -> &'static str {
    match blend {
        "mult" => "Multiply",
        "screen" => "Screen",
        "darken" => "Darken",
        "lighten" => "Lighten",
        _ => "Normal",
    }
}

/// The DrawingML `ST_BlendMode` for an engine blend mode, `over` for any
/// other ([`overlay_blend`]'s inverse).
pub fn overlay_blend_of(mode: Option<&str>) -> &'static str {
    match mode {
        Some("Multiply") => "mult",
        Some("Screen") => "screen",
        Some("Darken") => "darken",
        Some("Lighten") => "lighten",
        _ => "over",
    }
}

/// The engine stroke style for a compound line: DrawingML's `dbl` is two
/// equal lines a third of the width apart, InDesign's Thick - Thick; its
/// thick-thin pairs are InDesign's striped pairs. `tri` has no engine
/// style and draws single.
pub fn compound_type(compound: Option<&str>) -> Option<&'static str> {
    match compound? {
        "dbl" => Some("StrokeStyle/$ID/ThickThick"),
        "thickThin" => Some("StrokeStyle/$ID/ThickThin"),
        "thinThick" => Some("StrokeStyle/$ID/ThinThick"),
        _ => None,
    }
}

/// A preset dash (`ST_PresetLineDashVal`) as on/off lengths in multiples
/// of the line width (ECMA-376 §20.1.10.48).
pub fn preset_dash(name: &str) -> Option<&'static [f64]> {
    Some(match name {
        "dot" => &[1.0, 3.0],
        "dash" => &[4.0, 3.0],
        "lgDash" => &[8.0, 3.0],
        "dashDot" => &[4.0, 3.0, 1.0, 3.0],
        "lgDashDot" => &[8.0, 3.0, 1.0, 3.0],
        "lgDashDotDot" => &[8.0, 3.0, 1.0, 3.0, 1.0, 3.0],
        "sysDash" => &[3.0, 1.0],
        "sysDot" => &[1.0, 1.0],
        "sysDashDot" => &[3.0, 1.0, 1.0, 1.0],
        "sysDashDotDot" => &[3.0, 1.0, 1.0, 1.0, 1.0, 1.0],
        _ => return None,
    })
}

/// The DrawingML line end type for an engine arrowhead.
pub fn arrowhead(kind: &str) -> ArrowheadType {
    match kind {
        "triangle" => ArrowheadType::Triangle,
        "arrow" => ArrowheadType::Simple,
        "stealth" => ArrowheadType::Barbed,
        "diamond" => ArrowheadType::SquareSolid,
        "oval" => ArrowheadType::CircleSolid,
        _ => ArrowheadType::Triangle,
    }
}

/// The lowering of one document's DrawingML paint: its palette and what
/// the engine could not hold.
#[derive(Debug, Clone, Default)]
pub struct Mapper {
    pub palette: Palette,
    losses: Vec<String>,
    /// Live theme colours (slide ADR 713): a solid paint that names a
    /// theme colour fills with that colour's swatch, and one that names
    /// none with a plain colour's, even where its value equals a theme
    /// colour.
    theme_namer: Option<ThemeNamer>,
}

impl Mapper {
    pub fn new(theme_colors: &[(String, Rgb)]) -> Self {
        Mapper {
            palette: Palette::new(theme_colors),
            losses: Vec::new(),
            theme_namer: None,
        }
    }

    /// A mapper whose solid paints keep their theme colour by reference:
    /// `namer` gives the swatch of each `Paint::Solid::theme` key. Colours
    /// without one (gradient stops, effects) still take a theme colour's
    /// swatch when their value is one.
    pub fn with_theme_keys(theme_colors: &[(String, Rgb)], namer: ThemeNamer) -> Self {
        Mapper {
            theme_namer: Some(namer),
            ..Mapper::new(theme_colors)
        }
    }

    /// One line per kind of loss, in the order first met.
    pub fn losses(&self) -> &[String] {
        &self.losses
    }

    /// Take the losses reported so far.
    pub fn take_losses(&mut self) -> Vec<String> {
        std::mem::take(&mut self.losses)
    }

    /// Report a loss (once per distinct line).
    pub fn lose(&mut self, what: impl Into<String>) {
        let what = what.into();
        if !self.losses.contains(&what) {
            self.losses.push(what);
        }
    }

    /// The colour swatch of `rgb`.
    pub fn color(&mut self, rgb: Rgb) -> String {
        self.palette.color(rgb)
    }

    /// The swatch a paint fills with: the None swatch for no paint and for
    /// a picture (which is placed, not painted).
    pub fn paint(&mut self, p: &Paint) -> String {
        match p {
            Paint::None | Paint::Image { .. } => NONE_SWATCH.into(),
            Paint::Solid { rgb, theme, .. } => match self.theme_namer {
                Some(namer) => match theme.as_deref().and_then(namer) {
                    Some((id, name)) => self.palette.themed(&id, &name, *rgb),
                    None => self.palette.literal(*rgb),
                },
                None => self.palette.color(*rgb),
            },
            Paint::Linear { stops, .. } => self.palette.gradient(GradientKind::Linear, stops),
            Paint::Radial { stops, .. } => self.palette.gradient(GradientKind::Radial, stops),
            Paint::Pattern(pp) => {
                self.lose(
                    "pattern fill drawn as the mix of its two colours (no pattern paint yet)",
                );
                self.palette.color(pp.mix().0)
            }
        }
    }

    /// A stroke's fields; no stroke is the None swatch at weight 0.
    pub fn stroke(&mut self, s: Option<&Stroke>) -> StrokeFields {
        let Some(s) = s else {
            return StrokeFields {
                color: Some(NONE_SWATCH.into()),
                weight: Some(0.0),
                ..StrokeFields::default()
            };
        };
        let mut f = StrokeFields {
            color: Some(self.paint(&s.paint)),
            weight: Some(pt(s.width)),
            ..StrokeFields::default()
        };
        // One stroke style: a dashed line's dashes win over its compound.
        let dashed = s.dash.is_some() || !s.custom_dash.is_empty();
        if let Some(t) = compound_type(s.compound.as_deref()).filter(|_| !dashed) {
            f.kind = Some(t.into());
        }
        if s.compound.as_deref() == Some("tri") {
            self.lose("a triple line (cmpd=\"tri\") is drawn single");
        }
        if let Some(cap) = &s.cap {
            f.cap = Some(
                match cap.as_str() {
                    "rnd" => "RoundEndCap",
                    "sq" => "ProjectingEndCap",
                    _ => "ButtEndCap",
                }
                .into(),
            );
        }
        if let Some(j) = &s.join {
            f.join = Some(
                match j.as_str() {
                    "round" => "RoundEndJoin",
                    "bevel" => "BevelEndJoin",
                    _ => "MiterEndJoin",
                }
                .into(),
            );
        }
        f.miter_limit = s.miter_limit.map(pt);
        f.head = s.head.as_deref().map(arrowhead);
        f.tail = s.tail.as_deref().map(arrowhead);
        if dashed {
            f.kind = Some("StrokeStyle/$ID/Dashed".into());
            let unit: Vec<f64> = if !s.custom_dash.is_empty() {
                s.custom_dash.iter().flat_map(|&(d, sp)| [d, sp]).collect()
            } else {
                s.dash
                    .as_deref()
                    .and_then(preset_dash)
                    .map(<[f64]>::to_vec)
                    .unwrap_or_default()
            };
            // The pattern scales with the line; a hairline still dashes.
            let w = s.width.max(0.25);
            f.dash = unit.iter().map(|v| pt(v * w)).collect();
        }
        f
    }

    /// An item's opacity and effects. `fade` is the paint whose stops'
    /// alpha fades the item (a gradient fill's, or an unfilled shape's
    /// gradient line); `opacity` is 0–1.
    pub fn transparency(
        &mut self,
        opacity: f64,
        fx: &Effects,
        fade: Option<&Paint>,
    ) -> Transparency {
        let mut t = Transparency::default();
        if opacity < 0.999 {
            t.opacity = Some(pt(opacity * 100.0));
        }
        let mut effects = FrameEffects::default();
        let mut any = false;
        if let Some(s) = &fx.outer_shadow {
            t.shadow = Some(self.drop_shadow(s.dx, s.dy, s.blur, s.rgb, s.alpha));
            if s.distortion.is_some() {
                self.lose("a shadow's scale and skew are not carried: drawn undistorted");
            }
        } else if let Some(p) = &fx.preset_shadow {
            self.lose(format!(
                "preset shadow {} drawn as a plain drop shadow",
                p.preset
            ));
            t.shadow = Some(self.drop_shadow(p.dx, p.dy, 0.0, p.rgb, p.alpha));
        }
        if fx.outer_shadow.is_some() && fx.preset_shadow.is_some() {
            self.lose("a preset shadow beside an outer shadow is not drawn");
        }
        if let Some(s) = &fx.inner_shadow {
            effects.inner_shadow = Some(InnerShadowParams {
                x_offset: Some(pt(s.dx)),
                y_offset: Some(pt(s.dy)),
                size: Some(pt(s.blur / 2.0)),
                opacity_pct: Some(pt(s.alpha * 100.0)),
                effect_color: Some(self.palette.color(s.rgb)),
                blend_mode: Some("Normal".into()),
                ..InnerShadowParams::default()
            });
            any = true;
        }
        if let Some(g) = &fx.glow {
            effects.outer_glow = Some(OuterGlowParams {
                size: Some(pt(g.radius)),
                opacity_pct: Some(pt(g.alpha * 100.0)),
                effect_color: Some(self.palette.color(g.rgb)),
                blend_mode: Some("Normal".into()),
                ..OuterGlowParams::default()
            });
            any = true;
        }
        if let Some(rad) = fx.soft_edge {
            effects.feather = Some(FeatherParams {
                width: Some(pt(rad)),
                ..FeatherParams::default()
            });
            any = true;
        }
        if let Some(gf) = fade.and_then(feather_of) {
            effects.gradient_feather = Some(gf);
            any = true;
        }
        // The effects InDesign has none of, in the order PowerPoint draws
        // them: the overlay on the shape, the blur of it, its reflection.
        let mut extra: Vec<EffectEntry> = Vec::new();
        if let Some(o) = &fx.fill_overlay {
            extra.extend(self.overlay(o));
        }
        if let Some(b) = &fx.blur {
            if !b.grow {
                self.lose(
                    "a:blur grow=\"0\" is drawn past the shape's edge (the engine's blur grows)",
                );
            }
            if b.radius > 0.0 {
                extra.push(EffectEntry::new(Effect::GaussianBlur(GaussianBlurParams {
                    radius_pt: pt(b.radius * BLUR_SIGMA_PER_RADIUS),
                })));
            }
        }
        if let Some(r) = &fx.reflection {
            extra.push(EffectEntry::new(Effect::Reflection(self.reflection(r))));
        }
        if !extra.is_empty() {
            let present = |k: &IndesignEffect| match k {
                IndesignEffect::DropShadow => t.shadow.is_some(),
                IndesignEffect::InnerShadow => effects.inner_shadow.is_some(),
                IndesignEffect::OuterGlow => effects.outer_glow.is_some(),
                IndesignEffect::Feather => effects.feather.is_some(),
                IndesignEffect::GradientFeather => effects.gradient_feather.is_some(),
                _ => false,
            };
            t.stack = IndesignEffect::ORDER
                .iter()
                .filter(|k| present(k))
                .map(|k| EffectEntry::new(Effect::slot(*k)))
                .chain(extra)
                .collect();
        }
        if any {
            t.effects = Some(effects);
        }
        t
    }

    /// `a:fillOverlay` as a colour overlay under its blend mode; `None`
    /// (reported) for a paint the stack does not overlay.
    fn overlay(&mut self, o: &FillOverlay) -> Option<EffectEntry> {
        let opacity = |a: f64| (a < 0.999).then(|| pt(a * 100.0));
        let (effect, alpha) = match &o.paint {
            Paint::Solid { rgb, alpha, .. } => (
                Effect::ColorOverlay(ColorOverlayParams {
                    color: Some(self.palette.color(*rgb)),
                }),
                *alpha,
            ),
            // PowerPoint draws no gradient overlay (its own PDF of one
            // shows the shape unchanged; slide-conformance fixture
            // `effect-stack`): neither does the engine.
            Paint::Linear { .. } | Paint::Radial { .. } => {
                self.lose("a gradient fill overlay is not carried (PowerPoint does not draw it)");
                return None;
            }
            Paint::Pattern(pp) => {
                self.lose("a pattern fill overlay is drawn as the mix of its two colours (no pattern paint yet)");
                let (rgb, alpha) = pp.mix();
                (
                    Effect::ColorOverlay(ColorOverlayParams {
                        color: Some(self.palette.color(rgb)),
                    }),
                    alpha,
                )
            }
            Paint::None => return None,
            Paint::Image { .. } => {
                self.lose("a picture fill overlay is not carried");
                return None;
            }
        };
        let blend = overlay_blend(&o.blend);
        Some(EffectEntry {
            blend_mode: (blend != "Normal").then(|| blend.to_string()),
            opacity_pct: opacity(alpha),
            ..EffectEntry::new(effect)
        })
    }

    /// `a:reflection` as the engine's reflection: a mirror image below
    /// the shape, fading from its start to its end alpha over `endPos` of
    /// the shape's height. Any other direction, scale, skew or fade start
    /// is reported.
    fn reflection(&mut self, r: &Reflection) -> ReflectionParams {
        let near = |a: f64, b: f64| (a - b).abs() < 1e-3;
        let mirrored = near(r.direction.rem_euclid(360.0), 90.0)
            && near(r.fade_direction.rem_euclid(360.0), 90.0)
            && near(r.sx, 1.0)
            && near(r.sy, -1.0)
            && near(r.kx, 0.0)
            && near(r.ky, 0.0)
            && near(r.start_pos, 0.0);
        if !mirrored {
            self.lose("a reflection's direction, scale, skew or fade start are not carried: drawn as a mirror image below");
        }
        ReflectionParams {
            distance_pt: pt(r.distance.max(0.0)),
            size_pct: pt((r.end_pos * 100.0).clamp(0.0, 100.0)),
            start_opacity_pct: pt((r.start_alpha * 100.0).clamp(0.0, 100.0)),
            end_opacity_pct: pt((r.end_alpha * 100.0).clamp(0.0, 100.0)),
            blur_pt: pt(r.blur.max(0.0) * BLUR_SIGMA_PER_RADIUS),
        }
    }

    fn drop_shadow(
        &mut self,
        dx: f64,
        dy: f64,
        blur: f64,
        rgb: Rgb,
        alpha: f64,
    ) -> DropShadowSetting {
        DropShadowSetting {
            mode: "Drop".into(),
            x_offset: pt(dx),
            y_offset: pt(dy),
            size: pt(blur / 2.0),
            opacity_pct: pt(alpha * 100.0),
            effect_color: Some(self.palette.color(rgb)),
            ..DropShadowSetting::default()
        }
    }

    /// [`Mapper::picture_at`] without the picture's pixel density: a
    /// picture blur is reported.
    pub fn picture(&mut self, pic: &Picture) -> MappedPicture {
        self.picture_at(pic, None)
    }

    /// A picture's opacity factor (0–1) and its filter stack (engine ADR
    /// 1037) from its blip, reporting the picture effects the engine
    /// cannot apply. `px_per_pt` is the image's pixels per point as placed
    /// (a blur radius is in the picture's own pixels).
    ///
    /// `a:lum` becomes brightness/contrast, `a:duotone` a duotone,
    /// `a:grayscl` a black & white mixed with the luma weights Office
    /// greys by (0.3, 0.59, 0.11), `a:biLevel` a threshold, `a:hsl` a
    /// hue/saturation, `a:clrRepl` a duotone of one colour (every pixel
    /// that colour, its alpha kept) and `a:blur` a blur, in the blip's
    /// order. A colour change and a tint have no equivalent op and are
    /// reported.
    pub fn picture_at(&mut self, pic: &Picture, px_per_pt: Option<f64>) -> MappedPicture {
        let unit = |c: Rgb| c.map(|v| f32::from(v) / 255.0);
        let mut out = MappedPicture {
            opacity: pic.opacity,
            adjustments: Vec::new(),
            elements: Vec::new(),
        };
        for e in &pic.effects {
            let (element, op) = match e {
                // Office stores the image these produce as the blip: the
                // picture as placed already shows them.
                ImageEffect::Office2010 { .. } => continue,
                ImageEffect::Luminance { bright, contrast } => {
                    // Contrast in Office is a percentage of the full
                    // slope: +50 % doubles it, −50 % halves it.
                    let c = contrast.clamp(-1.0, 0.99);
                    let slope = if c >= 0.0 { 1.0 / (1.0 - c) } else { 1.0 + c };
                    (
                        "a:lum",
                        RasterOp::BrightnessContrast {
                            brightness: bright.clamp(-1.0, 1.0) as f32,
                            contrast: (slope as f32).min(10.0),
                        },
                    )
                }
                ImageEffect::Duotone { dark, light } => (
                    "a:duotone",
                    RasterOp::Duotone {
                        shadow: unit(*dark),
                        highlight: unit(*light),
                    },
                ),
                ImageEffect::Grayscale => (
                    "a:grayscl",
                    RasterOp::BlackWhite {
                        reds: 0.3,
                        yellows: 0.89,
                        greens: 0.59,
                        cyans: 0.7,
                        blues: 0.11,
                        magentas: 0.41,
                    },
                ),
                ImageEffect::BiLevel { threshold } => (
                    "a:biLevel",
                    RasterOp::Threshold {
                        level: threshold.clamp(0.0, 1.0) as f32,
                    },
                ),
                ImageEffect::Hsl { hue, sat, lum } => (
                    "a:hsl",
                    RasterOp::HueSaturation {
                        hue: (hue.rem_euclid(360.0)) as f32,
                        saturation: sat.clamp(-1.0, 1.0) as f32,
                        lightness: lum.clamp(-1.0, 1.0) as f32,
                    },
                ),
                ImageEffect::ColorReplace { rgb, alpha } => {
                    if *alpha < 0.999 {
                        self.lose("a:clrRepl's transparency is not carried (the colour replaces opaquely, the picture's alpha kept)");
                    }
                    (
                        "a:clrRepl",
                        RasterOp::Duotone {
                            shadow: unit(*rgb),
                            highlight: unit(*rgb),
                        },
                    )
                }
                ImageEffect::Blur { radius, .. } => {
                    let Some(scale) = px_per_pt.filter(|s| s.is_finite() && *s > 0.0) else {
                        self.lose("picture effect a:blur is not carried (the picture's pixel size is not known here)");
                        continue;
                    };
                    let sigma = radius * BLUR_SIGMA_PER_RADIUS * scale;
                    if sigma > 64.0 {
                        self.lose("a picture blur wider than 64 pixels (σ) is drawn at 64");
                    }
                    (
                        "a:blur",
                        RasterOp::Blur {
                            radius: sigma.clamp(0.0, 64.0) as f32,
                        },
                    )
                }
                ImageEffect::ColorChange { .. } => {
                    self.lose("picture effect a:clrChange is not carried (no equivalent image adjustment)");
                    continue;
                }
                ImageEffect::Tint { .. } => {
                    self.lose(
                        "picture effect a:tint is not carried (no equivalent image adjustment)",
                    );
                    continue;
                }
                ImageEffect::Alpha(n) | ImageEffect::Other(n) => {
                    self.lose(format!(
                        "picture effect a:{n} is not carried (no image adjustment for it)"
                    ));
                    continue;
                }
            };
            out.adjustments.push(op);
            out.elements.push(element);
        }
        out
    }

    /// The fill rule of an outline PowerPoint fills: `contour_paths` names
    /// each contour's `a:path`. PowerPoint fills every path on its own,
    /// even-odd (a contour inside another of the same path is a hole,
    /// whichever way it turns); the engine fills one rule per item. One
    /// path whose contours fill differently under the two rules is
    /// even-odd; otherwise the item stays non-zero, and several paths of
    /// which one would need even-odd are reported.
    pub fn fill_rule(
        &mut self,
        anchors: &[PathAnchor],
        subpath_starts: &[usize],
        subpath_open: &[bool],
        contour_paths: &[usize],
    ) -> FillRule {
        let ranges = |len: usize| -> Vec<std::ops::Range<usize>> {
            if subpath_starts.is_empty() {
                return std::iter::once(0..len).collect();
            }
            subpath_starts
                .iter()
                .enumerate()
                .map(|(i, &s)| s..subpath_starts.get(i + 1).copied().unwrap_or(len))
                .collect()
        };
        let contours = ranges(anchors.len());
        let differs = |sel: &[usize]| -> bool {
            // The path's contours alone, as one outline.
            let mut a = Vec::new();
            let mut starts = Vec::new();
            let mut open = Vec::new();
            for &i in sel {
                let Some(r) = contours.get(i) else { continue };
                starts.push(a.len());
                a.extend_from_slice(&anchors[r.clone()]);
                open.push(subpath_open.get(i).copied().unwrap_or(false));
            }
            match paged_model::winding::even_odd_as_non_zero(&a, &starts, &open) {
                Some(rewound) => rewound
                    .iter()
                    .zip(&a)
                    .any(|(r, o)| r.anchor != o.anchor || r.left != o.left),
                None => true,
            }
        };
        let by_path = |p: usize| -> Vec<usize> {
            (0..contours.len())
                .filter(|&i| contour_paths.get(i).copied().unwrap_or(0) == p)
                .collect()
        };
        let mut distinct: Vec<usize> = contour_paths.to_vec();
        distinct.sort_unstable();
        distinct.dedup();
        if distinct.len() <= 1 {
            let all: Vec<usize> = (0..contours.len()).collect();
            return if differs(&all) {
                FillRule::EvenOdd
            } else {
                FillRule::NonZero
            };
        }
        if distinct.iter().any(|&p| differs(&by_path(p))) {
            self.lose(
                "a geometry of several paths, one of which fills even-odd, is filled non-zero",
            );
        }
        FillRule::NonZero
    }
}

/// A picture as [`Mapper::picture_at`] maps it.
#[derive(Debug, Clone, PartialEq)]
pub struct MappedPicture {
    /// The opacity factor, 0–1 (`a:alphaModFix`).
    pub opacity: f64,
    /// The image frame's filter stack (engine ADR 1037), in blip order.
    pub adjustments: Vec<RasterOp>,
    /// The DrawingML element each adjustment came from (`a:lum`, …).
    pub elements: Vec<&'static str>,
}

impl MappedPicture {
    /// The losses of a lane that cannot hold an image filter stack: one
    /// line per adjustment ([`picture_adjustment_loss`]).
    pub fn native_lane_losses(&self) -> Vec<String> {
        self.adjustments
            .iter()
            .zip(&self.elements)
            .map(|(op, el)| adjustment_loss(el, op))
            .collect()
    }
}

fn adjustment_loss(element: &str, op: &RasterOp) -> String {
    format!(
        "{element} (picture adjustment {}) is not carried on the native lane",
        op.name()
    )
}

/// The loss a lane that cannot hold an image filter stack (engine ADR
/// 1037) reports for one of its ops: the DrawingML element it came from,
/// and the op it became on the mutation lane.
pub fn picture_adjustment_loss(op: &RasterOp) -> String {
    let element = match op {
        RasterOp::BrightnessContrast { .. } => "a:lum",
        RasterOp::Duotone { .. } => "a:duotone",
        RasterOp::BlackWhite { .. } => "a:grayscl",
        RasterOp::Threshold { .. } => "a:biLevel",
        RasterOp::HueSaturation { .. } => "a:hsl",
        RasterOp::Blur { .. } => "a:blur",
        _ => "a picture effect",
    };
    adjustment_loss(element, op)
}

/// A gradient feather for a gradient whose stops differ in alpha: the
/// engine's gradient swatches carry no alpha, so the fade rides on the
/// item instead. `None` for any other paint.
pub fn feather_of(p: &Paint) -> Option<GradientFeatherParams> {
    if p.uniform_alpha().is_some() {
        return None;
    }
    let (kind, angle, stops) = match p {
        Paint::Linear { stops, angle } => ("Linear", Some(-angle), stops),
        Paint::Radial { stops, .. } => ("Radial", None, stops),
        _ => return None,
    };
    Some(GradientFeatherParams {
        gradient_type: Some(kind.into()),
        start_point: None,
        end_point: None,
        angle_deg: angle.map(pt),
        stops: stops
            .iter()
            .map(|s| GradientFeatherStop {
                stop_color: None,
                location_pct: pt(s.pos),
                alpha_pct: pt(s.alpha * 100.0),
                midpoint_pct: 50.0,
            })
            .collect(),
        hilite_angle: None,
        hilite_length: None,
    })
}

/// A gradient swatch's stops for [`effects_with_stack`] (`None` for an id
/// that names none).
pub type GradientOf<'a> = &'a dyn Fn(&str) -> Option<Vec<Stop>>;

/// [`effects_of`] with the object's effect stack (engine ADR 1008): its
/// enabled colour or gradient overlay as `a:fillOverlay`, its Gaussian
/// blur as `a:blur` and its reflection as `a:reflection`, the inverse of
/// [`Mapper::transparency`]. `gradient_of` gives a gradient swatch's
/// stops. DrawingML holds one of each; a second is left out, as are the
/// stack's effects DrawingML has none of (outline stroke, noise, colour
/// adjustment) and a soft edge kept on the stack (the slot's feather is
/// written).
pub fn effects_with_stack(
    drop: Option<&DropShadowSetting>,
    fx: Option<&FrameEffects>,
    stack: &[EffectEntry],
    rgb_of: &dyn Fn(&str) -> Option<Rgb>,
    gradient_of: GradientOf<'_>,
) -> Effects {
    let mut out = effects_of(drop, fx, rgb_of);
    for e in stack.iter().filter(|e| e.enabled) {
        let alpha = e.opacity() as f64;
        let blend = || overlay_blend_of(e.blend_mode.as_deref()).to_string();
        match &e.effect {
            Effect::ColorOverlay(p) if out.fill_overlay.is_none() => {
                out.fill_overlay = Some(FillOverlay {
                    blend: blend(),
                    paint: Paint::Solid {
                        rgb: p.color.as_deref().and_then(rgb_of).unwrap_or([0, 0, 0]),
                        alpha,
                        theme: None,
                    },
                });
            }
            Effect::GradientOverlay(p) if out.fill_overlay.is_none() => {
                let mut stops = p
                    .gradient
                    .as_deref()
                    .and_then(gradient_of)
                    .unwrap_or_else(|| {
                        vec![
                            Stop {
                                pos: 0.0,
                                rgb: [0, 0, 0],
                                alpha: 1.0,
                            },
                            Stop {
                                pos: 100.0,
                                rgb: [255, 255, 255],
                                alpha: 1.0,
                            },
                        ]
                    });
                if p.reverse {
                    stops.reverse();
                    for s in &mut stops {
                        s.pos = 100.0 - s.pos;
                    }
                }
                for s in &mut stops {
                    s.alpha *= alpha;
                }
                out.fill_overlay = Some(FillOverlay {
                    blend: blend(),
                    paint: Paint::Linear {
                        stops,
                        angle: -(p.angle_deg.unwrap_or(0.0) as f64),
                    },
                });
            }
            Effect::GaussianBlur(p) if out.blur.is_none() => {
                out.blur = Some(Blur {
                    radius: p.radius_pt as f64 / BLUR_SIGMA_PER_RADIUS,
                    grow: true,
                });
            }
            Effect::Reflection(p) if out.reflection.is_none() => {
                out.reflection = Some(Reflection {
                    blur: p.blur_pt as f64 / BLUR_SIGMA_PER_RADIUS,
                    start_alpha: p.start_opacity_pct as f64 / 100.0,
                    start_pos: 0.0,
                    end_alpha: p.end_opacity_pct as f64 / 100.0,
                    end_pos: p.size_pct as f64 / 100.0,
                    distance: p.distance_pt as f64,
                    direction: 90.0,
                    fade_direction: 90.0,
                    sx: 1.0,
                    sy: -1.0,
                    kx: 0.0,
                    ky: 0.0,
                    align: "bl".into(),
                    rotate_with_shape: false,
                });
            }
            _ => {}
        }
    }
    out
}

/// The engine's drop shadow and effects back as the neutral IR, with
/// `rgb_of` naming a colour swatch's colour. What the engine holds and
/// DrawingML does not (bevel, satin, directional feather) is left out.
pub fn effects_of(
    drop: Option<&DropShadowSetting>,
    fx: Option<&FrameEffects>,
    rgb_of: &dyn Fn(&str) -> Option<Rgb>,
) -> Effects {
    let rgb = |id: &Option<String>| id.as_deref().and_then(rgb_of).unwrap_or([0, 0, 0]);
    let pct = |v: Option<f32>, d: f64| v.map(|v| v as f64 / 100.0).unwrap_or(d);
    let mut out = Effects {
        outer_shadow: drop.filter(|d| d.mode != "None").map(|d| Shadow {
            dx: d.x_offset as f64,
            dy: d.y_offset as f64,
            blur: d.size as f64 * 2.0,
            rgb: rgb(&d.effect_color),
            alpha: d.opacity_pct as f64 / 100.0,
            distortion: None,
        }),
        ..Effects::default()
    };
    if let Some(fx) = fx {
        out.inner_shadow = fx.inner_shadow.as_ref().map(|s| {
            let (dx, dy) = match (s.x_offset, s.y_offset) {
                (Some(x), Some(y)) => (x as f64, y as f64),
                _ => {
                    let a = (s.angle_deg.unwrap_or(0.0) as f64).to_radians();
                    let d = s.distance.unwrap_or(0.0) as f64;
                    (d * a.cos(), -d * a.sin())
                }
            };
            Shadow {
                dx,
                dy,
                blur: s.size.unwrap_or(0.0) as f64 * 2.0,
                rgb: rgb(&s.effect_color),
                alpha: pct(s.opacity_pct, 0.75),
                distortion: None,
            }
        });
        out.glow = fx.outer_glow.as_ref().map(|g| Glow {
            radius: g.size.unwrap_or(0.0) as f64,
            rgb: rgb(&g.effect_color),
            alpha: pct(g.opacity_pct, 0.75),
        });
        out.soft_edge = fx.feather.as_ref().and_then(|f| f.width).map(|w| w as f64);
    }
    out
}

/// A per-item dash pattern (pt) on a `width` pt line back as DrawingML: a
/// preset dash when it is one (to a hundredth of the width), else custom
/// (dash, space) pairs in 1 000ths of a percent of the width.
pub fn dash_of(pattern: &[f32], width: f64) -> Option<Result<&'static str, Vec<(i64, i64)>>> {
    if pattern.is_empty() {
        return None;
    }
    let w = width.max(0.25);
    let unit: Vec<f64> = pattern.iter().map(|&v| v as f64 / w).collect();
    for name in [
        "dot",
        "dash",
        "lgDash",
        "dashDot",
        "lgDashDot",
        "lgDashDotDot",
        "sysDash",
        "sysDot",
        "sysDashDot",
        "sysDashDotDot",
    ] {
        let p = preset_dash(name).unwrap_or_default();
        if p.len() == unit.len() && p.iter().zip(&unit).all(|(a, b)| (a - b).abs() < 0.01) {
            return Some(Ok(name));
        }
    }
    let pct = |v: f64| (v * 100_000.0).round() as i64;
    Some(Err(unit
        .chunks(2)
        .map(|c| (pct(c[0]), pct(c.get(1).copied().unwrap_or(0.0))))
        .collect()))
}
