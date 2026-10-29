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
//!   preset shadow as a plain drop shadow; blur, reflection, fill overlay
//!   and shadow distortion reported, because the engine cannot hold them
//!   yet.
//! - **Pictures** ([`Mapper::picture`]): `a:alphaModFix` as opacity;
//!   `a:lum`, `a:duotone`, `a:grayscl`, `a:biLevel` and `a:hsl` as the
//!   image frame's filter stack (engine ADR 1037); the Office 2010
//!   corrections and artistic effects are already in the image Office
//!   stored; every other picture effect is reported.
//! - **The inverse** ([`effects_of`], [`dash_of`]): the engine's drop
//!   shadow, effects and dash pattern back as the neutral IR, which
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

use paged_model::{
    ArrowheadType, ColorEntry, ColorModel, ColorSpace, DropShadowSetting, FeatherParams,
    FrameEffects, GradientEntry, GradientFeatherParams, GradientFeatherStop, GradientKind,
    GradientStopRef, InnerShadowParams, OuterGlowParams, RasterOp,
};
pub use paged_ooxml::drawingml::resolved::{
    radial_reach, Blur, Effects, FillOverlay, Glow, ImageEffect, Paint, PatternPaint, Picture,
    PresetShadow, Reflection, Rgb, Shadow, Stop, Stroke,
};

/// The None swatch: no paint.
pub const NONE_SWATCH: &str = "Swatch/None";

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

/// The swatches a document's paints need.
#[derive(Debug, Clone, Default)]
pub struct Palette {
    colors: BTreeMap<Rgb, String>,
    theme_names: BTreeMap<Rgb, String>,
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

    /// The RGB colour entries of every colour minted.
    pub fn color_entries(&self) -> Vec<ColorEntry> {
        self.colors
            .iter()
            .map(|(rgb, id)| ColorEntry {
                self_id: id.clone(),
                name: Some(id.trim_start_matches("Color/").to_string()),
                space: ColorSpace::Rgb,
                value: rgb.iter().map(|&c| c as f32).collect(),
                model: ColorModel::Process,
                alternate_space: None,
                alternate_value: Vec::new(),
                tint: None,
                alpha: None,
            })
            .collect()
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
}

impl Mapper {
    pub fn new(theme_colors: &[(String, Rgb)]) -> Self {
        Mapper {
            palette: Palette::new(theme_colors),
            losses: Vec::new(),
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
            Paint::Solid { rgb, .. } => self.palette.color(*rgb),
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
        if fx.blur.is_some() {
            self.lose("a:blur is not carried (no blur effect yet)");
        }
        if fx.reflection.is_some() {
            self.lose("a:reflection is not carried (no reflection effect yet)");
        }
        if fx.fill_overlay.is_some() {
            self.lose("a:fillOverlay is not carried");
        }
        if let Some(gf) = fade.and_then(feather_of) {
            effects.gradient_feather = Some(gf);
            any = true;
        }
        if any {
            t.effects = Some(effects);
        }
        t
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

    /// A picture's opacity factor (0–1) and its filter stack (engine ADR
    /// 1037) from its blip, reporting the picture effects the engine
    /// cannot apply.
    ///
    /// `a:lum` becomes brightness/contrast, `a:duotone` a duotone,
    /// `a:grayscl` a black & white mixed with the luma weights Office
    /// greys by (0.3, 0.59, 0.11), `a:biLevel` a threshold and `a:hsl` a
    /// hue/saturation, in the blip's order. A colour change, a colour
    /// replacement, a tint and a picture blur have no op and are reported.
    pub fn picture(&mut self, pic: &Picture) -> MappedPicture {
        let unit = |c: Rgb| c.map(|v| f32::from(v) / 255.0);
        let mut adjustments = Vec::new();
        for e in &pic.effects {
            let what = match e {
                // Office stores the image these produce as the blip: the
                // picture as placed already shows them.
                ImageEffect::Office2010 { .. } => continue,
                ImageEffect::Luminance { bright, contrast } => {
                    // Contrast in Office is a percentage of the full
                    // slope: +50 % doubles it, −50 % halves it.
                    let c = contrast.clamp(-1.0, 0.99);
                    let slope = if c >= 0.0 { 1.0 / (1.0 - c) } else { 1.0 + c };
                    adjustments.push(RasterOp::BrightnessContrast {
                        brightness: bright.clamp(-1.0, 1.0) as f32,
                        contrast: (slope as f32).min(10.0),
                    });
                    continue;
                }
                ImageEffect::Duotone { dark, light } => {
                    adjustments.push(RasterOp::Duotone {
                        shadow: unit(*dark),
                        highlight: unit(*light),
                    });
                    continue;
                }
                ImageEffect::Grayscale => {
                    adjustments.push(RasterOp::BlackWhite {
                        reds: 0.3,
                        yellows: 0.89,
                        greens: 0.59,
                        cyans: 0.7,
                        blues: 0.11,
                        magentas: 0.41,
                    });
                    continue;
                }
                ImageEffect::BiLevel { threshold } => {
                    adjustments.push(RasterOp::Threshold {
                        level: threshold.clamp(0.0, 1.0) as f32,
                    });
                    continue;
                }
                ImageEffect::Hsl { hue, sat, lum } => {
                    adjustments.push(RasterOp::HueSaturation {
                        hue: (hue.rem_euclid(360.0)) as f32,
                        saturation: sat.clamp(-1.0, 1.0) as f32,
                        lightness: lum.clamp(-1.0, 1.0) as f32,
                    });
                    continue;
                }
                ImageEffect::ColorChange { .. } => "a:clrChange",
                ImageEffect::ColorReplace { .. } => "a:clrRepl",
                ImageEffect::Tint { .. } => "a:tint",
                ImageEffect::Blur { .. } => "a:blur on a picture",
                ImageEffect::Alpha(n) | ImageEffect::Other(n) => {
                    self.lose(format!(
                        "picture effect a:{n} is not carried (no image adjustment for it)"
                    ));
                    continue;
                }
            };
            self.lose(format!(
                "picture effect {what} is not carried (no image adjustment for it)"
            ));
        }
        MappedPicture {
            opacity: pic.opacity,
            adjustments,
        }
    }
}

/// A picture as [`Mapper::picture`] maps it.
#[derive(Debug, Clone, PartialEq)]
pub struct MappedPicture {
    /// The opacity factor, 0–1 (`a:alphaModFix`).
    pub opacity: f64,
    /// The image frame's filter stack (engine ADR 1037), in blip order.
    pub adjustments: Vec<RasterOp>,
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
