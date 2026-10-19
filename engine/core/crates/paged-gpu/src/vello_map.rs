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

//! The display list in Vello's vocabulary — shared by both rasterizers.
//!
//! The GPU lane (`vello_rs`, Vello on WebGPU) and the CPU lane (`vcpu`,
//! `vello_cpu`) draw the same model: kurbo paths, peniko paints, peniko
//! blend modes and kurbo strokes. This module is the one place a
//! display-list path, paint, stroke, colour or blend mode becomes that
//! model, so the two lanes cannot map a command differently. Both
//! renderers link the same `peniko` and `kurbo` releases (vello 0.11 and
//! vello_cpu 0.3 are one Linebender release train), so the types here
//! are the types each renderer takes.

use paged_compose::{
    BlendMode as ComposeBlendMode, Color as ComposeColor, DisplayList, LineCap, LineJoin, Paint,
    PathData, PathSegment, Transform,
};

#[cfg(feature = "vello-backend")]
pub(crate) use vello::{kurbo, peniko};
#[cfg(all(feature = "cpu", not(feature = "vello-backend")))]
pub(crate) use vello_cpu::{kurbo, peniko};

use peniko::{
    BlendMode as PenikoBlendMode, Color as PenikoColor, ColorStop as PenikoColorStop, Compose,
    Gradient as PenikoGradient, Mix,
};

/// A display-list path with `transform` applied to every control
/// point, so the path lives in page space and a stroke width given in
/// pt stays a width in pt under a non-uniform frame transform.
pub(crate) fn path_to_bez(data: &PathData, transform: &Transform) -> kurbo::BezPath {
    let apply = |x: f32, y: f32| -> kurbo::Point {
        let [a, b, c, d, tx, ty] = transform.0;
        kurbo::Point::new((a * x + c * y + tx) as f64, (b * x + d * y + ty) as f64)
    };
    let mut p = kurbo::BezPath::new();
    for seg in &data.segments {
        match seg {
            PathSegment::MoveTo { x, y } => p.move_to(apply(*x, *y)),
            PathSegment::LineTo { x, y } => p.line_to(apply(*x, *y)),
            PathSegment::QuadTo { cx, cy, x, y } => {
                p.quad_to(apply(*cx, *cy), apply(*x, *y));
            }
            PathSegment::CubicTo {
                cx1,
                cy1,
                cx2,
                cy2,
                x,
                y,
            } => {
                p.curve_to(apply(*cx1, *cy1), apply(*cx2, *cy2), apply(*x, *y));
            }
            PathSegment::Close => p.close_path(),
        }
    }
    p
}

/// A resolved paint: a solid colour or a gradient, in page space.
#[derive(Clone)]
pub(crate) enum PaintBrush {
    Solid(PenikoColor),
    Gradient(PenikoGradient),
}

/// Convert a display-list `Paint` into a brush. Gradient endpoints in
/// the display list live in the path's unit-rect local coordinates; the
/// path's `transform` takes them to page space, where the shape lives
/// once [`path_to_bez`] has run. `None` for a gradient that is missing
/// or has fewer than two stops — the command draws nothing.
pub(crate) fn resolve_paint(
    paint: &Paint,
    list: &DisplayList,
    transform: &Transform,
) -> Option<PaintBrush> {
    let stops_of = |stops: &[paged_compose::GradientStop]| -> Vec<PenikoColorStop> {
        stops
            .iter()
            .map(|s| PenikoColorStop {
                offset: s.offset.clamp(0.0, 1.0),
                color: linear_to_peniko(s.color).into(),
            })
            .collect()
    };
    match paint {
        Paint::Solid(c) => Some(PaintBrush::Solid(linear_to_peniko(*c))),
        // The pipeline baked the ICC-resolved display colour onto the
        // paint at compose time; the ink channels on it only matter to
        // the overprint composite and the separation, which read them
        // from the paint directly.
        Paint::Cmyk { rgb, .. } => Some(PaintBrush::Solid(linear_to_peniko(*rgb))),
        Paint::LinearGradient(id) => {
            let g = list.linear_gradient(*id)?;
            if g.stops.len() < 2 {
                return None;
            }
            let (sx, sy) = transform.apply(g.start.0, g.start.1);
            let (ex, ey) = transform.apply(g.end.0, g.end.1);
            let stops = stops_of(&g.stops);
            Some(PaintBrush::Gradient(
                PenikoGradient::new_linear(
                    kurbo::Point::new(sx as f64, sy as f64),
                    kurbo::Point::new(ex as f64, ey as f64),
                )
                .with_stops(stops.as_slice()),
            ))
        }
        Paint::RadialGradient(id) => {
            let g = list.radial_gradient(*id)?;
            if g.stops.len() < 2 {
                return None;
            }
            let (cx, cy) = transform.apply(g.center.0, g.center.1);
            // One circle for a non-square unit rect: the two mapped
            // per-axis radii averaged, so the gradient ovals with the
            // path the way InDesign warps a radial fill.
            let [a, b, c, d, _, _] = transform.0;
            let rx = (a * g.radius).hypot(b * g.radius);
            let ry = (c * g.radius).hypot(d * g.radius);
            let radius = (rx + ry) * 0.5;
            if !radius.is_finite() || radius <= 0.0 {
                return None;
            }
            let stops = stops_of(&g.stops);
            Some(PaintBrush::Gradient(
                PenikoGradient::new_radial(kurbo::Point::new(cx as f64, cy as f64), radius)
                    .with_stops(stops.as_slice()),
            ))
        }
        Paint::SweepGradient(id) => {
            let g = list.sweep_gradient(*id)?;
            if g.stops.len() < 2 {
                return None;
            }
            let (cx, cy) = transform.apply(g.center.0, g.center.1);
            // Radians, clockwise in a y-down space — the IR's own
            // convention — over one full turn.
            let start = g.start_angle;
            let end = g.start_angle + std::f32::consts::TAU;
            let stops = stops_of(&g.stops);
            Some(PaintBrush::Gradient(
                PenikoGradient::new_sweep(kurbo::Point::new(cx as f64, cy as f64), start, end)
                    .with_stops(stops.as_slice()),
            ))
        }
    }
}

/// Our `BlendMode` as peniko's `(Mix, Compose)` pair. `Normal` is
/// peniko's default (`Mix::Normal`, `Compose::SrcOver`); every other
/// mode lines up 1:1 with a `Mix`, composited source-over. The formulae
/// are W3C Compositing and Blending Level 1, which PDF 1.7 Annex H
/// agrees with for every separable mode and for Hue / Saturation /
/// Color / Luminosity; they part company only in edge cases of
/// HardLight, SoftLight and ColorBurn over a non-opaque backdrop.
pub(crate) fn blend_to_peniko(m: ComposeBlendMode) -> PenikoBlendMode {
    let mix = match m {
        ComposeBlendMode::Normal => Mix::Normal,
        ComposeBlendMode::Multiply => Mix::Multiply,
        ComposeBlendMode::Screen => Mix::Screen,
        ComposeBlendMode::Overlay => Mix::Overlay,
        ComposeBlendMode::Darken => Mix::Darken,
        ComposeBlendMode::Lighten => Mix::Lighten,
        ComposeBlendMode::ColorDodge => Mix::ColorDodge,
        ComposeBlendMode::ColorBurn => Mix::ColorBurn,
        ComposeBlendMode::HardLight => Mix::HardLight,
        ComposeBlendMode::SoftLight => Mix::SoftLight,
        ComposeBlendMode::Difference => Mix::Difference,
        ComposeBlendMode::Exclusion => Mix::Exclusion,
        ComposeBlendMode::Hue => Mix::Hue,
        ComposeBlendMode::Saturation => Mix::Saturation,
        ComposeBlendMode::Color => Mix::Color,
        ComposeBlendMode::Luminosity => Mix::Luminosity,
    };
    PenikoBlendMode::new(mix, Compose::SrcOver)
}

/// The kurbo stroke for a display-list stroke, dash included. The dash
/// pattern is in the path's own units, as the width is, and is taken
/// only when it is a real pattern: an even count of two or more
/// non-negative lengths with a positive sum. Anything else strokes
/// solid.
///
/// A dotted stroke is a ZERO-length dash with round caps. kurbo's
/// stroker drops a zero-length dash, caps and all, so the dots would
/// vanish (`strokes-fills` "japanese-dots"); a hair of length keeps the
/// caps, and with butt caps it is a sliver no wider than the hair.
pub(crate) fn kurbo_stroke(stroke: &paged_compose::Stroke) -> kurbo::Stroke {
    const DOT_PT: f64 = 1e-3;
    let ks = kurbo::Stroke::new(stroke.width.max(0.0) as f64)
        .with_caps(map_cap(stroke.cap))
        .with_join(map_join(stroke.join))
        .with_miter_limit(stroke.miter_limit.max(1.0) as f64);
    let dash = stroke.dash.as_slice();
    let valid = dash.len() >= 2
        && dash.len().is_multiple_of(2)
        && dash.iter().all(|d| d.is_finite() && *d >= 0.0)
        && dash.iter().sum::<f32>() > 0.0;
    if valid {
        ks.with_dashes(
            0.0,
            dash.iter().enumerate().map(|(i, d)| {
                let d = *d as f64;
                if i % 2 == 0 && d == 0.0 {
                    DOT_PT
                } else {
                    d
                }
            }),
        )
    } else {
        ks
    }
}

fn map_cap(c: LineCap) -> kurbo::Cap {
    match c {
        LineCap::Butt => kurbo::Cap::Butt,
        LineCap::Round => kurbo::Cap::Round,
        LineCap::Square => kurbo::Cap::Square,
    }
}

fn map_join(j: LineJoin) -> kurbo::Join {
    match j {
        LineJoin::Miter => kurbo::Join::Miter,
        LineJoin::Round => kurbo::Join::Round,
        LineJoin::Bevel => kurbo::Join::Bevel,
    }
}

/// Linear RGB (0..1) → the sRGB-encoded 8-bit peniko colour both
/// renderers take. The display list carries linear light; the paint
/// boundary is where it becomes sRGB, quantised once, the same way in
/// both lanes.
pub(crate) fn linear_to_peniko(c: ComposeColor) -> PenikoColor {
    let to_srgb = |v: f32| -> u8 {
        let s = if v <= 0.003_130_8 {
            12.92 * v
        } else {
            1.055 * v.powf(1.0 / 2.4) - 0.055
        };
        (s.clamp(0.0, 1.0) * 255.0).round() as u8
    };
    PenikoColor::from_rgba8(
        to_srgb(c.r),
        to_srgb(c.g),
        to_srgb(c.b),
        (c.a.clamp(0.0, 1.0) * 255.0).round() as u8,
    )
}
