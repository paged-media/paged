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

//! A picture's or text box's look on its anchored frame, built in Rust (doc
//! ADR 625, slice 4b: looks). A hand port of the lowering kit's translator
//! (`nativeFxOps` in `plugin-sdk` `lowering.ts`, extensions ADR 347) and of the
//! engine's `setElementProperty` arms for an anchored frame (engine ADR 1045):
//! the same writes, in the same order, onto the same fields of
//! [`paged_model::AnchoredFrame`], so the frame paints as the old pour's did.
//! `paged-mutate` itself is not linked: it adds 4.77 MiB to the doc wasm. The
//! comparison test (`tests/look_native.rs`) holds the port to the engine's own
//! operations.
//!
//! The look is a [`NativeFx`] (`dml-native`, colours as `#RRGGBB`). Each colour
//! is the document swatch `Color/docx-RRGGBB` the lowering minted for it; a
//! gradient is a content-addressed gradient swatch `Gradient/docx-…`. What the
//! frame needs of the document is collected in [`LookNeeds`] and made by
//! [`LookNeeds::make`].

use std::collections::BTreeSet;

use dml_native::native::{NativeEffect, NativeFx, NativeGradient};
use paged_model::effect_stack::{
    defaults, ColorOverlayParams, Effect, EffectBearing, EffectEntry, EffectTarget,
    GaussianBlurParams, IndesignEffect, ReflectionParams,
};
use paged_model::{
    AnchoredFrame, ColorEntry, ColorModel, ColorSpace, GradientEntry, GradientFeatherParams,
    GradientFeatherStop, GradientKind, GradientStopRef,
};
use paged_scene::Document;

/// The id prefix of the content-addressed gradient swatches of looks.
const GRADIENT_PREFIX: &str = "Gradient/docx-";

/// The swatch a look's `#RRGGBB` colour is painted with: the one the lowering
/// minted for it (`Color/docx-RRGGBB`, doc ADR 619).
pub fn look_swatch(hex: &str) -> String {
    format!("Color/docx-{}", hex.trim_start_matches('#'))
}

/// A location as an id segment: to the thousandth, `.` as `p`.
fn id_number(v: f32) -> String {
    let v = ((v as f64) * 1000.0).round() / 1000.0;
    format!("{v}").replace('.', "p")
}

/// `#rgb` / `#RRGGBB` (any case) as `RRGGBB`, else `000000`.
fn hex_body(hex: &str) -> String {
    let b = hex.trim().trim_start_matches('#');
    if !b.bytes().all(|c| c.is_ascii_hexdigit()) {
        return "000000".into();
    }
    match b.len() {
        3 => b.chars().flat_map(|c| [c, c]).collect::<String>(),
        6 => b.to_string(),
        _ => "000000".into(),
    }
    .to_ascii_uppercase()
}

/// The content-addressed id of a gradient swatch: its kind and its stops, so
/// the same ramp is one swatch however often it is used.
pub fn gradient_id(g: &NativeGradient) -> String {
    let stops: Vec<String> = g
        .stops
        .iter()
        .map(|(at, hex)| format!("{}-{}", id_number(*at), hex_body(hex)))
        .collect();
    format!(
        "{GRADIENT_PREFIX}{}-{}",
        if g.kind == "radial" { "R" } else { "L" },
        stops.join("-")
    )
}

/// What the looks of a document need of the document: the colours they paint
/// with (`RRGGBB`) and the gradients they fill with, in first-use order.
#[derive(Debug, Clone, Default)]
pub struct LookNeeds {
    pub colors: BTreeSet<String>,
    pub gradients: Vec<NativeGradient>,
}

impl LookNeeds {
    fn color(&mut self, hex: &str) -> String {
        self.colors.insert(hex.trim_start_matches('#').to_string());
        look_swatch(hex)
    }

    fn gradient(&mut self, g: &NativeGradient) -> String {
        let id = gradient_id(g);
        if !self.gradients.iter().any(|x| gradient_id(x) == id) {
            self.gradients.push(g.clone());
        }
        id
    }

    /// Whether any look is there.
    pub fn is_empty(&self) -> bool {
        self.colors.is_empty() && self.gradients.is_empty()
    }

    /// Make in `document` the swatches the looks name: a colour the lowering
    /// did not mint (a picture in a table cell has none) and each gradient,
    /// after the colours of its stops. A swatch the document holds is kept.
    pub fn make(&self, document: &mut Document) {
        for hex in &self.colors {
            let id = look_swatch(hex);
            if document.palette.colors.contains_key(&id) {
                continue;
            }
            let channel = |i: usize| {
                hex.get(i..i + 2)
                    .and_then(|c| u8::from_str_radix(c, 16).ok())
                    .unwrap_or(0) as f32
            };
            document.palette.colors.insert(
                id.clone(),
                ColorEntry {
                    self_id: id,
                    name: Some(format!("docx {hex}")),
                    space: ColorSpace::Rgb,
                    value: vec![channel(0), channel(2), channel(4)],
                    model: ColorModel::Process,
                    alternate_space: None,
                    alternate_value: Vec::new(),
                    tint: None,
                    alpha: None,
                    theme_ref: None,
                },
            );
        }
        let mut made = 0;
        for g in &self.gradients {
            let id = gradient_id(g);
            if document.palette.gradients.contains_key(&id) {
                continue;
            }
            made += 1;
            document.palette.gradients.insert(
                id.clone(),
                GradientEntry {
                    self_id: id,
                    name: Some(format!("docx picture gradient {made}")),
                    kind: if g.kind == "radial" {
                        GradientKind::Radial
                    } else {
                        GradientKind::Linear
                    },
                    stops: g
                        .stops
                        .iter()
                        .map(|(at, hex)| GradientStopRef::swatch(look_swatch(hex), *at, None))
                        .collect(),
                },
            );
        }
    }
}

fn nonempty(s: &str) -> Option<String> {
    (!s.is_empty()).then(|| s.to_string())
}

fn finite(name: &str, v: Option<f32>) -> Result<Option<f32>, String> {
    match v {
        Some(x) if !x.is_finite() => Err(format!("`{name}` must be a finite number")),
        _ => Ok(v),
    }
}

fn pct(name: &str, v: Option<f32>) -> Result<Option<f32>, String> {
    Ok(finite(name, v)?.map(|x| x.clamp(0.0, 100.0)))
}

fn length(name: &str, v: Option<f32>) -> Result<Option<f32>, String> {
    Ok(finite(name, v)?.map(|x| x.max(0.0)))
}

/// An InDesign effect by the name the stack serialises.
fn indesign(kind: &str) -> Option<IndesignEffect> {
    IndesignEffect::ORDER
        .into_iter()
        .find(|k| k.kind_name() == kind)
}

/// One entry of the object's effect stack (`EffectEntrySpec::to_model`, for
/// the kinds the mapper states: a blur, a colour overlay, a reflection, and
/// InDesign's, whose parameters are the frame's own fields).
fn stack_entry(e: &NativeEffect, needs: &mut LookNeeds) -> Result<EffectEntry, String> {
    let effect = match indesign(&e.kind) {
        Some(k) => Effect::slot(k),
        None => match e.kind.as_str() {
            "gaussianBlur" => {
                let d = GaussianBlurParams::default();
                Effect::GaussianBlur(GaussianBlurParams {
                    radius_pt: length("radiusPt", e.radius_pt)?.unwrap_or(d.radius_pt),
                })
            }
            "colorOverlay" => Effect::ColorOverlay(ColorOverlayParams {
                color: e
                    .color
                    .as_deref()
                    .map(|c| needs.color(c))
                    .filter(|c| !c.is_empty()),
            }),
            "reflection" => {
                let d = ReflectionParams::default();
                Effect::Reflection(ReflectionParams {
                    distance_pt: length("distancePt", e.distance_pt)?.unwrap_or(d.distance_pt),
                    size_pct: pct("sizePct", e.size_pct)?.unwrap_or(d.size_pct),
                    start_opacity_pct: pct("startOpacityPct", e.start_opacity_pct)?
                        .unwrap_or(d.start_opacity_pct),
                    end_opacity_pct: pct("endOpacityPct", e.end_opacity_pct)?
                        .unwrap_or(d.end_opacity_pct),
                    blur_pt: length("blurPt", e.blur_pt)?.unwrap_or(d.blur_pt),
                })
            }
            other => return Err(format!("effect `{other}` has no native form here")),
        },
    };
    let stack_only = effect.indesign().is_none();
    Ok(EffectEntry {
        enabled: true,
        blend_mode: if stack_only {
            e.blend_mode.clone().filter(|b| !b.is_empty())
        } else {
            None
        },
        opacity_pct: if stack_only {
            pct("opacityPct", e.opacity_pct)?
        } else {
            None
        },
        effect,
    })
}

/// Give the anchored frame `f` the look `fx` states: fill or gradient,
/// outline, opacity, drop and inner shadow, glow, soft edge, gradient feather
/// and the effect stack, in that order (the order of `nativeFxOps`). The
/// frame is a picture's or a text box's, which has a fill (`filled`); its
/// gradient starts in its own box (origin `[0, 0]`).
///
/// On an error the frame may be half written: the caller defers the whole
/// document then.
pub fn paint_frame(
    f: &mut AnchoredFrame,
    fx: &NativeFx,
    needs: &mut LookNeeds,
) -> Result<(), String> {
    // The fill: the gradient swatch behind a transparent picture, else the
    // solid colour.
    if let Some(g) = &fx.gradient {
        f.fill_color = Some(needs.gradient(g));
    } else if let Some(fill) = &fx.fill {
        f.fill_color = Some(needs.color(fill));
    }
    if let Some(g) = &fx.gradient {
        if let Some(a) = g.angle {
            f.gradient_fill_angle = Some(a);
        }
        if let Some(l) = g.length {
            f.gradient_fill_length = Some(l);
        }
        if let Some((x, y)) = g.start {
            f.gradient_fill_start = Some([x as f32, y as f32]);
        }
    }
    if let Some(s) = &fx.stroke {
        f.stroke_color = Some(needs.color(&s.color));
        f.stroke_weight = Some(s.weight);
        if let Some(k) = &s.kind {
            f.stroke_type = nonempty(k);
        }
        if !s.dash.is_empty() {
            f.stroke_dash = s.dash.clone();
        }
        if let Some(c) = &s.cap {
            f.end_cap = nonempty(c);
        }
        if let Some(j) = &s.join {
            f.end_join = nonempty(j);
        }
        if let Some(m) = s.miter_limit {
            f.miter_limit = Some(m);
        }
    }
    if let Some(o) = fx.opacity {
        f.opacity = Some(o);
    }
    if let Some(d) = &fx.drop_shadow {
        let ds = f.drop_shadow.get_or_insert_with(defaults::drop_shadow);
        ds.x_offset = d.x_offset;
        ds.y_offset = d.y_offset;
        ds.size = d.size;
        ds.opacity_pct = d.opacity;
        ds.effect_color = Some(needs.color(&d.color));
    }
    if let Some(i) = &fx.inner_shadow {
        let e = f
            .effects
            .get_or_insert_with(Default::default)
            .inner_shadow
            .get_or_insert_with(defaults::inner_shadow);
        e.blend_mode = Some("Normal".into());
        e.angle_deg = Some(i.angle);
        e.distance = Some(i.distance);
        e.size = Some(i.size);
        e.opacity_pct = Some(i.opacity);
        e.effect_color = Some(needs.color(&i.color));
    }
    if let Some(g) = &fx.outer_glow {
        let e = f
            .effects
            .get_or_insert_with(Default::default)
            .outer_glow
            .get_or_insert_with(defaults::outer_glow);
        e.blend_mode = Some("Normal".into());
        e.size = Some(g.size);
        e.opacity_pct = Some(g.opacity);
        e.effect_color = Some(needs.color(&g.color));
    }
    if let Some(w) = fx.feather {
        f.effects
            .get_or_insert_with(Default::default)
            .feather
            .get_or_insert_with(defaults::feather)
            .width = Some(w);
    }
    if let Some(gf) = &fx.gradient_feather {
        f.effects
            .get_or_insert_with(Default::default)
            .gradient_feather = Some(GradientFeatherParams {
            gradient_type: Some(gf.gradient_type.clone()),
            start_point: None,
            end_point: None,
            angle_deg: gf.angle,
            stops: gf
                .stops
                .iter()
                .map(|(location_pct, alpha_pct)| GradientFeatherStop {
                    stop_color: None,
                    location_pct: *location_pct,
                    alpha_pct: *alpha_pct,
                    midpoint_pct: 0.0,
                })
                .collect(),
            ..Default::default()
        });
    }
    // The stack last: its InDesign entries take the parameters written above.
    if !fx.effect_stack.is_empty() {
        let stack = fx
            .effect_stack
            .iter()
            .map(|e| stack_entry(e, needs))
            .collect::<Result<Vec<_>, _>>()?;
        let before = f.effect_state(EffectTarget::Object);
        if let Err(e) = f.effect_slots_mut(EffectTarget::Object).set_stack(stack) {
            f.restore_effect_state(EffectTarget::Object, before);
            return Err(e.to_string());
        }
        f.tidy_targets();
    }
    Ok(())
}
