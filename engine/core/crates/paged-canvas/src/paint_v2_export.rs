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

//! Engine ADR 1007 — paint model v2 on IDML export.
//!
//! IDML's gradient is a list of swatch references with no opacity, of
//! kind linear or radial, and its stroke shows the gradient *within*.
//! [`lower_for_idml`] rewrites the export scene into what IDML can say:
//! an inline stop colour becomes an unnamed process colour the stop
//! references, and a fill's opacity stops become an equivalent gradient
//! feather where that is exact. [`paint_v2_losses`] names the rest, and
//! checks the lowering against the re-imported twin: a feather the
//! writer did not carry (a source item, whose effects the patch lane does
//! not rewrite) is a loss too.

use paged_model::{
    Bounds, FrameEffects, GradientEntry, GradientFeatherParams, GradientFeatherStop, GradientKind,
    Graphic, StrokeGradientMode,
};
use paged_scene::Document;

/// The id of the unnamed colour an inline stop exports as.
pub(crate) fn inline_stop_color_id(gradient_id: &str, index: usize) -> String {
    let tail: String = gradient_id
        .rsplit('/')
        .next()
        .unwrap_or(gradient_id)
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
    format!("Color/paged-stop-{tail}-{index}")
}

/// What the lowering and the loss report read of a frame.
struct FrameView<'a> {
    kind: &'static str,
    id: Option<&'a str>,
    fill: Option<&'a str>,
    stroke: Option<&'a str>,
    stroke_weight: Option<f32>,
    mode: StrokeGradientMode,
    effects: Option<&'a FrameEffects>,
    /// Text, a picture or a placed file: a feather would fade it too.
    has_content: bool,
    item_transform: Option<[f32; 6]>,
    bounds: Bounds,
    fill_angle: Option<f32>,
    fill_length: Option<f32>,
    fill_start: Option<[f32; 2]>,
    /// The kinds the feather lowering writes (it owns the frame's
    /// effects there).
    featherable: bool,
}

fn frames(doc: &Document) -> Vec<FrameView<'_>> {
    let mut out = Vec::new();
    for parsed in &doc.spreads {
        let sp = &parsed.spread;
        for f in &sp.text_frames {
            out.push(FrameView {
                kind: "text frame",
                id: f.self_id.as_deref(),
                fill: f.fill_color.as_deref(),
                stroke: f.stroke_color.as_deref(),
                stroke_weight: f.stroke_weight,
                mode: f.gradient_stroke_mode,
                effects: f.effects.as_ref(),
                has_content: true,
                item_transform: f.item_transform,
                bounds: f.bounds,
                fill_angle: f.gradient_fill_angle,
                fill_length: f.gradient_fill_length,
                fill_start: f.gradient_fill_start,
                featherable: false,
            });
        }
        for r in &sp.rectangles {
            out.push(FrameView {
                kind: "rectangle",
                id: r.self_id.as_deref(),
                fill: r.fill_color.as_deref(),
                stroke: r.stroke_color.as_deref(),
                stroke_weight: r.stroke_weight,
                mode: r.gradient_stroke_mode,
                effects: r.effects.as_ref(),
                has_content: r.image_link.is_some()
                    || r.has_image_element
                    || r.has_inline_pdf
                    || r.has_inline_eps
                    || r.placed_pdf.is_some()
                    || r.image_bytes.is_some(),
                item_transform: r.item_transform,
                bounds: r.bounds,
                fill_angle: r.gradient_fill_angle,
                fill_length: r.gradient_fill_length,
                fill_start: r.gradient_fill_start,
                featherable: true,
            });
        }
        for o in &sp.ovals {
            out.push(FrameView {
                kind: "oval",
                id: o.self_id.as_deref(),
                fill: o.fill_color.as_deref(),
                stroke: o.stroke_color.as_deref(),
                stroke_weight: o.stroke_weight,
                mode: o.gradient_stroke_mode,
                effects: o.effects.as_ref(),
                has_content: o.image_link.is_some(),
                item_transform: o.item_transform,
                bounds: o.bounds,
                fill_angle: o.gradient_fill_angle,
                fill_length: o.gradient_fill_length,
                fill_start: o.gradient_fill_start,
                featherable: true,
            });
        }
        for p in &sp.polygons {
            out.push(FrameView {
                kind: "polygon",
                id: p.self_id.as_deref(),
                fill: p.fill_color.as_deref(),
                stroke: p.stroke_color.as_deref(),
                stroke_weight: p.stroke_weight,
                mode: p.gradient_stroke_mode,
                effects: p.effects.as_ref(),
                has_content: p.image_link.is_some(),
                item_transform: p.item_transform,
                bounds: p.bounds,
                fill_angle: p.gradient_fill_angle,
                fill_length: p.gradient_fill_length,
                fill_start: p.gradient_fill_start,
                featherable: true,
            });
        }
        for l in &sp.graphic_lines {
            out.push(FrameView {
                kind: "line",
                id: l.self_id.as_deref(),
                fill: None,
                stroke: l.stroke_color.as_deref(),
                stroke_weight: l.stroke_weight,
                mode: l.gradient_stroke_mode,
                effects: l.effects.as_ref(),
                has_content: false,
                item_transform: l.item_transform,
                bounds: l.bounds,
                fill_angle: None,
                fill_length: None,
                fill_start: None,
                featherable: false,
            });
        }
    }
    out
}

fn strokes(f: &FrameView<'_>) -> bool {
    f.stroke
        .is_some_and(|s| s != "Swatch/None" && s != "Color/None" && !s.is_empty())
        && f.stroke_weight.unwrap_or(1.0) > 0.0
}

/// Whether `f`'s turn is none (a scale or a translation only): InDesign
/// starts a rotated frame's default gradient elsewhere, and the feather
/// would have to follow.
fn upright(f: &FrameView<'_>) -> bool {
    match f.item_transform {
        None => true,
        Some([a, b, c, d, ..]) => b.abs() < 1e-6 && c.abs() < 1e-6 && a > 0.0 && d > 0.0,
    }
}

/// The gradient feather that fades `f` as its fill's opacity stops do,
/// or `None` when no feather is exactly that.
fn equivalent_feather(f: &FrameView<'_>, g: &GradientEntry) -> Option<GradientFeatherParams> {
    if !f.featherable || f.has_content || strokes(f) || !upright(f) {
        return None;
    }
    if f.effects.is_some_and(|e| {
        e.gradient_feather.is_some() || e.feather.is_some() || e.directional_feather.is_some()
    }) {
        return None;
    }
    // The renderer's feather ignores midpoints; a bent segment would part.
    if g.stops
        .iter()
        .any(|s| s.midpoint_pct.is_some_and(|m| (m - 50.0).abs() > 1e-3))
    {
        return None;
    }
    let b = f.bounds;
    let (w, h) = (b.right - b.left, b.bottom - b.top);
    if !(w > 0.0 && h > 0.0) {
        return None;
    }
    let length = f.fill_length.filter(|l| l.is_finite() && *l > 0.0);
    let (kind, start, end) = match g.kind {
        GradientKind::Linear => {
            // The fill's axis (`pipeline::color_paint::linear_gradient_endpoints`):
            // from the box's bottom-left, as long as it is wide, at the angle.
            let s = f.fill_start.unwrap_or([b.left, b.bottom]);
            let l = length.unwrap_or(w);
            let (sin, cos) = f.fill_angle.unwrap_or(0.0).to_radians().sin_cos();
            ("Linear", s, [s[0] + l * cos, s[1] - l * sin])
        }
        GradientKind::Radial => {
            let (c, r) = match (f.fill_start, length) {
                (Some(s), Some(l)) => (s, l),
                _ => ([b.left, b.bottom], w.max(h)),
            };
            ("Radial", c, [c[0] + r, c[1]])
        }
        GradientKind::Conic | GradientKind::Unknown => return None,
    };
    Some(GradientFeatherParams {
        gradient_type: Some(kind.to_string()),
        start_point: Some((start[0], start[1])),
        end_point: Some((end[0], end[1])),
        angle_deg: Some(f.fill_angle.unwrap_or(0.0)),
        stops: g
            .stops
            .iter()
            .map(|s| GradientFeatherStop {
                stop_color: None,
                location_pct: s.location_pct,
                alpha_pct: s.opacity() * 100.0,
                midpoint_pct: 50.0,
            })
            .collect(),
        hilite_angle: None,
        hilite_length: None,
    })
}

/// Rewrite `scene` (the export's own copy) into what IDML says.
pub(crate) fn lower_for_idml(scene: &mut Document) {
    // A fill's opacity stops → a gradient feather on each frame where it
    // is exact. Decided on the frames before the stops change below.
    let mut feathers: Vec<(String, GradientFeatherParams)> = Vec::new();
    for f in frames(scene) {
        let (Some(id), Some(fill)) = (f.id, f.fill) else {
            continue;
        };
        let Some(g) = scene.palette.gradients.get(fill) else {
            continue;
        };
        if !g.has_opacity_stops() {
            continue;
        }
        if let Some(p) = equivalent_feather(&f, g) {
            feathers.push((id.to_string(), p));
        }
    }
    for parsed in &mut scene.spreads {
        let sp = &mut parsed.spread;
        let put = |id: Option<&str>, effects: &mut Option<FrameEffects>| {
            if let Some((_, p)) = feathers.iter().find(|(f, _)| Some(f.as_str()) == id) {
                effects
                    .get_or_insert_with(FrameEffects::default)
                    .gradient_feather = Some(p.clone());
            }
        };
        for r in &mut sp.rectangles {
            put(r.self_id.as_deref(), &mut r.effects);
        }
        for o in &mut sp.ovals {
            put(o.self_id.as_deref(), &mut o.effects);
        }
        for p in &mut sp.polygons {
            put(p.self_id.as_deref(), &mut p.effects);
        }
    }
    // An inline stop colour → an unnamed process colour the stop names.
    let palette: &mut Graphic = &mut scene.palette;
    let mut added = Vec::new();
    for (gid, g) in palette.gradients.iter_mut() {
        for (i, s) in g.stops.iter_mut().enumerate() {
            if let Some(c) = s.inline_color.take() {
                let id = inline_stop_color_id(gid, i);
                added.push(c.as_entry(&id));
                s.stop_color = id;
            }
        }
    }
    for entry in added {
        palette.colors.entry(entry.self_id.clone()).or_insert(entry);
    }
}

/// The paint-v2 constructs the IDML export cannot carry, one line each,
/// declared from `scene` and, where a lowering stands in for one,
/// checked against `twin` (the export re-imported).
pub(crate) fn paint_v2_losses(scene: &Document, twin: Option<&Document>) -> Vec<String> {
    let mut out = Vec::new();
    let palette = &scene.palette;
    for (gid, g) in &palette.gradients {
        if g.kind == GradientKind::Conic {
            out.push(format!(
                "conic gradient `{gid}` is a paged-native paint — IDML has no conic gradient, \
                 so it exports as a linear one of the same stops. Save as `.paged` to keep it."
            ));
        }
        if let Some(twin) = twin {
            for (i, s) in g.stops.iter().enumerate() {
                let Some(c) = &s.inline_color else { continue };
                let kept = twin.palette.gradients.get(gid).is_some_and(|tg| {
                    tg.stops.get(i).is_some_and(|ts| {
                        twin.palette
                            .resolve(&ts.stop_color)
                            .is_some_and(|e| e.space == c.space && e.value == c.value)
                    })
                });
                if !kept {
                    out.push(format!(
                        "stop {} of gradient `{gid}` carries its own colour, which the exported \
                         gradient does not — the IDML exporter writes a changed source gradient \
                         as it was. Save as `.paged` to keep it.",
                        i + 1
                    ));
                }
            }
        }
    }
    let twin_frames: Vec<FrameView<'_>> = twin.map(frames).unwrap_or_default();
    for f in frames(scene) {
        let id = f.id.unwrap_or("?");
        if let Some(g) = f.fill.and_then(|c| palette.gradients.get(c)) {
            if g.has_opacity_stops() {
                let feathered = twin_frames
                    .iter()
                    .find(|t| t.id == f.id && f.id.is_some())
                    .and_then(|t| t.effects)
                    .and_then(|e| e.gradient_feather.as_ref())
                    .is_some_and(|p| {
                        p.stops.len() == g.stops.len()
                            && p.stops
                                .iter()
                                .zip(&g.stops)
                                .all(|(a, b)| (a.alpha_pct - b.opacity() * 100.0).abs() < 0.5)
                    });
                if !feathered {
                    out.push(format!(
                        "the opacity stops of gradient `{}` on {} `{id}` are a paged-native paint \
                         — IDML stops have no opacity and no equivalent gradient feather was \
                         written, so the fill exports opaque. Save as `.paged` to keep it.",
                        f.fill.unwrap_or("?"),
                        f.kind
                    ));
                }
            }
        }
        if let Some(g) = f.stroke.and_then(|c| palette.gradients.get(c)) {
            if g.has_opacity_stops() {
                out.push(format!(
                    "the opacity stops of gradient `{}` on the stroke of {} `{id}` are a \
                     paged-native paint — IDML stops have no opacity (a feather would fade the \
                     whole object), so the stroke exports opaque. Save as `.paged` to keep it.",
                    f.stroke.unwrap_or("?"),
                    f.kind
                ));
            }
            if f.mode != StrokeGradientMode::Within {
                out.push(format!(
                    "the stroke gradient of {} `{id}` runs {} its path, a paged-native mapping — \
                     IDML strokes a gradient within the frame only, so it exports that way. Save \
                     as `.paged` to keep it.",
                    f.kind,
                    match f.mode {
                        StrokeGradientMode::Along => "along",
                        _ => "across",
                    }
                ));
            }
        }
    }
    out
}
