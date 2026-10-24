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
    BlendMode as ComposeBlendMode, Color as ComposeColor, DisplayList, FillRule, LineCap, LineJoin,
    Paint, PathData, PathId, PathSegment, Transform,
};

#[cfg(feature = "vello-backend")]
pub(crate) use vello::{kurbo, peniko};
#[cfg(all(feature = "cpu", not(feature = "vello-backend")))]
pub(crate) use vello_cpu::{kurbo, peniko};

use kurbo::{Affine, BezPath, PathEl, Point};
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

/// The rule a fill or clip of `path_id` draws by (engine ADR 1006): the
/// path's own, `NonZero` for a missing path. A stroke outline is filled
/// `NonZero` whatever its source path says.
pub(crate) fn path_fill(list: &DisplayList, path_id: PathId) -> peniko::Fill {
    list.paths
        .get(path_id)
        .map_or(peniko::Fill::NonZero, |p| fill_of(p.fill_rule))
}

/// A display-list fill rule as both renderers take it.
pub(crate) fn fill_of(rule: FillRule) -> peniko::Fill {
    match rule {
        FillRule::NonZero => peniko::Fill::NonZero,
        FillRule::EvenOdd => peniko::Fill::EvenOdd,
    }
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
///
/// Photoshop's eleven modes (engine ADR 1016) have no `Mix`. Both lanes
/// composite a GROUP in one of them themselves, against its backdrop,
/// and never ask for its `Mix`; anything else that carries one (an
/// effect stamp's own blend) draws the nearest native mode.
pub(crate) fn blend_to_peniko(m: ComposeBlendMode) -> PenikoBlendMode {
    let mix = match m.nearest_native() {
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
        // `nearest_native` returned one of the sixteen.
        _ => Mix::Normal,
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

// ---------------------------------------------------------------------------
// Stroke adjustment
// ---------------------------------------------------------------------------
//
// PDF's stroke adjustment (the `SA` graphics-state flag), which Acrobat
// and poppler's Splash rasterizer (`pdftoppm`) apply to every page
// whatever the flag says: an edge that runs along a pixel row or column
// lands on a pixel boundary, so a rule or a frame edge is crisp rather
// than a band of part-covered pixels whose darkness depends on where the
// edge falls. Splash's rule, which this follows:
//
//  * a stroke is adjusted when every segment of it (after dashing) is a
//    straight line along an axis in device space: each side of each
//    segment, and each butt or square cap, moves to the nearest pixel
//    boundary, and a side pair that would collapse keeps one pixel;
//  * a fill is adjusted when it is one closed subpath of four corners
//    whose sides run along the axes: a rectangle, snapped the same way.
//    Glyph outlines are not fills in this sense — a PDF draws them as
//    text, and Splash renders text through its font engine, so a glyph
//    known as one (the display list's glyph-run table) is left alone.
//
// Splash snaps a hinted coordinate within 0.01 px of an edge, and moves
// the far edge 0.01 px back so its scan converter's inclusive spans stop
// short of the next pixel. These rasterizers compute exact area
// coverage, where an edge ON the boundary already covers the pixel
// exactly, so the far edge stays on the boundary.
//
// The adjustment happens here, on the path, so both lanes rasterize the
// same adjusted geometry: an adjusted stroke is drawn as a fill of its
// outline in both.

/// Splash's window: a coordinate this close to a hinted edge snaps.
const SA_WINDOW: f64 = 0.01;
/// How far a segment may lean (device px over its length) and still run
/// along an axis — float noise from the f32 transforms, nothing more.
const SA_AXIS_EPS: f64 = 1e-3;

/// One axis's snap targets: `(coordinate, snapped coordinate)`, sorted.
#[derive(Default)]
struct AxisSnaps(Vec<(f64, f64)>);

impl AxisSnaps {
    /// A pair of parallel edges at `a` and `b`: each moves to its nearest
    /// pixel boundary, a pair that would meet keeps one pixel between
    /// them, and a point midway between them (a stroke's centre line, where
    /// kurbo's inner miter joins meet) stays midway.
    fn pair(&mut self, a: f64, b: f64) {
        let (adj0, adj1) = if a <= b { (a, b) } else { (b, a) };
        let x0 = (adj0 + 0.5).floor();
        let mut x1 = (adj1 + 0.5).floor();
        if x1 == x0 {
            x1 = x0 + 1.0;
        }
        self.0.push((adj0, x0));
        self.0.push((adj1, x1));
        self.0.push((0.5 * (adj0 + adj1), 0.5 * (x0 + x1)));
    }

    fn finish(&mut self) {
        self.0.sort_by(|a, b| a.0.total_cmp(&b.0));
    }

    /// The snapped value of `v`: the nearest target within the window.
    fn snap(&self, v: f64) -> f64 {
        let lo = self.0.partition_point(|(c, _)| *c <= v - SA_WINDOW);
        let mut best: Option<(f64, f64)> = None;
        for &(c, t) in &self.0[lo..] {
            if c >= v + SA_WINDOW {
                break;
            }
            let d = (c - v).abs();
            if best.is_none_or(|(bd, _)| d < bd) {
                best = Some((d, t));
            }
        }
        best.map_or(v, |(_, t)| t)
    }
}

/// Snap every point of `path` (device space) by `xs` and `ys`.
fn snap_path(path: &mut BezPath, xs: &AxisSnaps, ys: &AxisSnaps) {
    let snap = |p: &mut Point| {
        p.x = xs.snap(p.x);
        p.y = ys.snap(p.y);
    };
    for el in path.elements_mut() {
        match el {
            PathEl::MoveTo(p) | PathEl::LineTo(p) => snap(p),
            PathEl::QuadTo(a, b) => {
                snap(a);
                snap(b);
            }
            PathEl::CurveTo(a, b, c) => {
                snap(a);
                snap(b);
                snap(c);
            }
            PathEl::ClosePath => {}
        }
    }
}

/// `to_px` as a uniform scale plus a translation, the only device
/// transform an adjustment is defined for: `Some(scale)`.
fn uniform_scale(to_px: Affine) -> Option<f64> {
    let [a, b, c, d, _, _] = to_px.as_coeffs();
    (b == 0.0 && c == 0.0 && a > 0.0 && (a - d).abs() <= a * 1e-9).then_some(a)
}

/// A straight subpath along the axes, in device space.
struct AxisPolyline {
    pts: Vec<Point>,
    closed: bool,
}

/// Is `p0 → p1` along an axis?
fn on_axis(p0: Point, p1: Point) -> bool {
    (p1.x - p0.x).abs() <= SA_AXIS_EPS || (p1.y - p0.y).abs() <= SA_AXIS_EPS
}

/// Is control point `c` on the axis-aligned segment `p0 → p1`, so a curve
/// through it is that straight segment?
fn on_segment(p0: Point, c: Point, p1: Point) -> bool {
    let within =
        |v: f64, a: f64, b: f64| v >= a.min(b) - SA_AXIS_EPS && v <= a.max(b) + SA_AXIS_EPS;
    on_axis(p0, p1)
        && on_axis(p0, c)
        && on_axis(c, p1)
        && within(c.x, p0.x, p1.x)
        && within(c.y, p0.y, p1.y)
}

/// The subpaths of `path` (device space) as polylines, when every
/// segment is a straight line along an axis; a curve counts when its
/// control points lie on its chord. `None` for anything else.
fn axis_polylines(path: &BezPath) -> Option<Vec<AxisPolyline>> {
    let mut out: Vec<AxisPolyline> = Vec::new();
    let mut last: Option<Point> = None;
    for el in path.elements() {
        let to = match *el {
            PathEl::MoveTo(p) => {
                out.push(AxisPolyline {
                    pts: vec![p],
                    closed: false,
                });
                last = Some(p);
                continue;
            }
            PathEl::ClosePath => {
                if let Some(sub) = out.last_mut() {
                    sub.closed = true;
                    let (first, end) = (sub.pts[0], *sub.pts.last()?);
                    if !on_axis(end, first) {
                        return None;
                    }
                    last = Some(first);
                }
                continue;
            }
            PathEl::LineTo(p) => p,
            PathEl::QuadTo(c, p) => {
                if !on_segment(last?, c, p) {
                    return None;
                }
                p
            }
            PathEl::CurveTo(c1, c2, p) => {
                let p0 = last?;
                if !on_segment(p0, c1, p) || !on_segment(p0, c2, p) {
                    return None;
                }
                p
            }
        };
        let from = last?;
        if !on_axis(from, to) {
            return None;
        }
        let sub = out.last_mut()?;
        if sub.closed {
            // A segment after a close starts a new subpath at the close
            // point, as kurbo and PDF read it.
            out.push(AxisPolyline {
                pts: vec![from, to],
                closed: false,
            });
        } else {
            sub.pts.push(to);
        }
        last = Some(to);
    }
    Some(out)
}

/// The non-degenerate segments of a polyline, closing segment included.
fn segments(line: &AxisPolyline) -> impl Iterator<Item = (Point, Point)> + '_ {
    let n = line.pts.len();
    let closing = (line.closed && n > 1).then(|| (line.pts[n - 1], line.pts[0]));
    line.pts
        .windows(2)
        .map(|w| (w[0], w[1]))
        .chain(closing)
        .filter(|(a, b)| a.distance(*b) > SA_AXIS_EPS)
}

/// The rectangle fill `path` (page space) becomes under stroke
/// adjustment at `to_px` (page → device pixels), in page space; `None`
/// when the path is not a rectangle along the axes, or `to_px` is not a
/// uniform scale.
fn adjusted_rect_fill(path: &BezPath, to_px: Affine) -> Option<BezPath> {
    uniform_scale(to_px)?;
    let mut dev = path.clone();
    dev.apply_affine(to_px);
    let lines = axis_polylines(&dev)?;
    let [line] = lines.as_slice() else {
        return None;
    };
    // Four corners: a closing point that repeats the first is not one.
    let mut pts = line.pts.clone();
    if pts.len() == 5 && pts[0].distance(pts[4]) <= SA_AXIS_EPS {
        pts.pop();
    }
    if pts.len() != 4 {
        return None;
    }
    // Splash's two hints pair the sides 0–1 with 2–3 and 1–2 with 3–0,
    // and hold only when both pairs run along an axis — a rectangle.
    let side = |i: usize| (pts[i], pts[(i + 1) % 4]);
    let vertical = |(a, b): (Point, Point)| (b.x - a.x).abs() <= SA_AXIS_EPS;
    let horizontal = |(a, b): (Point, Point)| (b.y - a.y).abs() <= SA_AXIS_EPS;
    let mut xs = AxisSnaps::default();
    let mut ys = AxisSnaps::default();
    for (s0, s1) in [(side(0), side(2)), (side(1), side(3))] {
        if vertical(s0) && vertical(s1) {
            xs.pair(s0.0.x, s1.0.x);
        } else if horizontal(s0) && horizontal(s1) {
            ys.pair(s0.0.y, s1.0.y);
        } else {
            return None;
        }
    }
    xs.finish();
    ys.finish();
    snap_path(&mut dev, &xs, &ys);
    dev.apply_affine(to_px.inverse());
    Some(dev)
}

/// The outline a stroke of `path` (page space) becomes under stroke
/// adjustment at `to_px`, in page space, to be FILLED (non-zero); `None`
/// when the stroke is not one adjustment applies to — a segment off the
/// axes, a curve, a transform that is not a uniform scale — and is drawn
/// as a stroke.
fn adjusted_stroke_outline(
    path: &BezPath,
    stroke: &kurbo::Stroke,
    to_px: Affine,
) -> Option<BezPath> {
    let scale = uniform_scale(to_px)?;
    if stroke.width.is_nan() || stroke.width <= 0.0 {
        return None;
    }
    let mut dev = path.clone();
    dev.apply_affine(to_px);
    // Reject early: a curve or a slanted segment anywhere.
    axis_polylines(&dev)?;
    let mut style = stroke.clone();
    style.width *= scale;
    let dashes: Vec<f64> = style.dash_pattern.iter().map(|d| d * scale).collect();
    let offset = style.dash_offset * scale;
    style.dash_pattern = Default::default();
    style.dash_offset = 0.0;
    // Dash first, so every dash is a subpath with its own caps — each
    // one is adjusted, as Splash adjusts the dashed path it strokes.
    let centre = if dashes.is_empty() {
        dev
    } else {
        BezPath::from_iter(kurbo::dash(dev.iter(), offset, &dashes))
    };
    let lines = axis_polylines(&centre)?;
    let hw = 0.5 * style.width;
    let mut xs = AxisSnaps::default();
    let mut ys = AxisSnaps::default();
    for line in &lines {
        for (a, b) in segments(line) {
            if (b.x - a.x).abs() <= SA_AXIS_EPS {
                let c = 0.5 * (a.x + b.x);
                xs.pair(c - hw, c + hw);
            } else {
                let c = 0.5 * (a.y + b.y);
                ys.pair(c - hw, c + hw);
            }
        }
        if line.closed {
            continue;
        }
        // The caps of an open subpath: a butt cap ends at its point, a
        // square one half the width past it; each is snapped with the
        // far end of its own segment, as Splash pairs them. A round cap
        // is a curve and stays.
        let ext = match style.start_cap {
            kurbo::Cap::Butt => 0.0,
            kurbo::Cap::Square => hw,
            kurbo::Cap::Round => continue,
        };
        let segs: Vec<(Point, Point)> = segments(line).collect();
        let (Some(&(f0, f1)), Some(&(l0, l1))) = (segs.first(), segs.last()) else {
            continue;
        };
        let single = segs.len() == 1;
        let cap = |snaps: &mut AxisSnaps, from: f64, to: f64, start_ext: f64, end_ext: f64| {
            let dir = if to >= from { 1.0 } else { -1.0 };
            snaps.pair(from - dir * start_ext, to + dir * end_ext);
        };
        let first_vertical = (f1.x - f0.x).abs() <= SA_AXIS_EPS;
        let last_vertical = (l1.x - l0.x).abs() <= SA_AXIS_EPS;
        let (fa, fb) = if first_vertical {
            (f0.y, f1.y)
        } else {
            (f0.x, f1.x)
        };
        let first_snaps = if first_vertical { &mut ys } else { &mut xs };
        cap(first_snaps, fa, fb, ext, if single { ext } else { 0.0 });
        if !single {
            let (la, lb) = if last_vertical {
                (l0.y, l1.y)
            } else {
                (l0.x, l1.x)
            };
            let last_snaps = if last_vertical { &mut ys } else { &mut xs };
            cap(last_snaps, la, lb, 0.0, ext);
        }
    }
    xs.finish();
    ys.finish();
    let mut outline = kurbo::stroke(
        centre.iter(),
        &style,
        &kurbo::StrokeOpts::default(),
        STROKE_TOLERANCE_PX,
    );
    snap_path(&mut outline, &xs, &ys);
    outline.apply_affine(to_px.inverse());
    Some(outline)
}

/// The tolerance, in device pixels, every filled curve is flattened to
/// before either rasterizer sees it.
///
/// Vello and `vello_cpu` flatten at a fixed 0.25 px. Chords cut inside a
/// convex curve, so at text sizes a glyph comes out measurably thinner
/// than the same outline rendered by a font engine — FreeType, which
/// draws the text of the fidelity gate's references, follows the curve
/// far more closely. Measured on the generated corpus at 144 dpi, the
/// match to those references improves down to about 0.1 px and no
/// further (0.025 px is slightly worse again). Flattening here, once, in
/// the mapping both lanes share also keeps them drawing the same lines.
pub(crate) const FLATTEN_TOLERANCE_PX: f64 = 0.1;

/// The fills of one render: the page-space path each fill command
/// draws, stroke-adjusted when it is a rectangle and with its curves
/// flattened to [`FLATTEN_TOLERANCE_PX`].
///
/// Flattening is done in the path's own space, to a tolerance divided by
/// the largest stretch of the transform to device pixels, and kept per
/// path and linear transform: every instance of a glyph at one size
/// reuses the same polyline and only moves it.
#[derive(Default)]
pub(crate) struct Fills {
    flattened: std::collections::HashMap<(PathId, [u32; 4], u64), BezPath>,
}

impl Fills {
    /// The path the fill of `path_id` under `transform` draws at `to_px`
    /// (page → device pixels), in page space. `glyph` leaves stroke
    /// adjustment out (see above). `None` for a missing path.
    pub(crate) fn path(
        &mut self,
        list: &DisplayList,
        path_id: PathId,
        transform: &Transform,
        to_px: Affine,
        glyph: bool,
    ) -> Option<BezPath> {
        let data = list.paths.get(path_id)?;
        if !glyph {
            let path = path_to_bez(data, transform);
            if let Some(adjusted) = adjusted_rect_fill(&path, to_px) {
                return Some(adjusted);
            }
            if !has_curves(data) {
                return Some(path);
            }
        } else if !has_curves(data) {
            return Some(path_to_bez(data, transform));
        }
        let [a, b, c, d, tx, ty] = transform.0.map(f64::from);
        let stretch = max_stretch(to_px * Affine::new([a, b, c, d, 0.0, 0.0]));
        if !(stretch.is_finite() && stretch > 0.0) {
            return Some(path_to_bez(data, transform));
        }
        let [ba, bb, bc, bd, _, _] = transform.0.map(f32::to_bits);
        let local = self
            .flattened
            .entry((path_id, [ba, bb, bc, bd], stretch.to_bits()))
            .or_insert_with(|| {
                let mut out = BezPath::new();
                let src = path_to_bez(data, &Transform::IDENTITY);
                kurbo::flatten(src.iter(), FLATTEN_TOLERANCE_PX / stretch, |el| {
                    out.push(el)
                });
                out
            });
        let mut path = local.clone();
        path.apply_affine(Affine::new([a, b, c, d, tx, ty]));
        Some(path)
    }
}

fn has_curves(data: &PathData) -> bool {
    data.segments
        .iter()
        .any(|s| matches!(s, PathSegment::QuadTo { .. } | PathSegment::CubicTo { .. }))
}

/// The largest factor `m` stretches a length by (its largest singular
/// value).
fn max_stretch(m: Affine) -> f64 {
    let [a, b, c, d, _, _] = m.as_coeffs();
    let s = a * a + b * b + c * c + d * d;
    let det = a * d - b * c;
    (0.5 * (s + (s * s - 4.0 * det * det).max(0.0).sqrt())).sqrt()
}

/// What a stroke draws after stroke adjustment at `to_px`.
pub(crate) enum StrokeGeometry {
    /// An adjusted outline, filled non-zero.
    Outline(BezPath),
    /// The path, stroked as it is.
    Stroke(BezPath, kurbo::Stroke),
}

pub(crate) fn stroke_geometry(
    path: BezPath,
    stroke: kurbo::Stroke,
    to_px: Affine,
) -> StrokeGeometry {
    match adjusted_stroke_outline(&path, &stroke, to_px) {
        Some(outline) => StrokeGeometry::Outline(outline),
        None => StrokeGeometry::Stroke(path, stroke),
    }
}

/// The tolerance (device px) an adjusted stroke's round caps and joins
/// are expanded to.
const STROKE_TOLERANCE_PX: f64 = 0.05;

/// The display-list indices of glyph FILLS, which stroke adjustment
/// leaves alone (see above). Known only from the glyph-run table;
/// without one, every fill that is a rectangle is adjusted.
pub(crate) fn glyph_fills(list: &DisplayList) -> std::collections::HashSet<usize> {
    list.glyph_runs
        .as_ref()
        .map(|t| {
            t.entries
                .iter()
                .filter(|e| !e.is_stroke)
                .map(|e| e.command_index as usize)
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use kurbo::Shape;
    use paged_compose::PathSegment::{Close, CubicTo, LineTo, MoveTo};

    fn rect(x0: f64, y0: f64, x1: f64, y1: f64) -> BezPath {
        let mut p = BezPath::new();
        p.move_to((x0, y0));
        p.line_to((x1, y0));
        p.line_to((x1, y1));
        p.line_to((x0, y1));
        p.close_path();
        p
    }

    /// Every point of `path`, mapped to device space by `to_px`.
    fn device_points(path: &BezPath, to_px: Affine) -> Vec<Point> {
        let mut out = Vec::new();
        for el in path.elements() {
            match *el {
                PathEl::MoveTo(p) | PathEl::LineTo(p) => out.push(to_px * p),
                PathEl::QuadTo(a, b) => out.extend([to_px * a, to_px * b]),
                PathEl::CurveTo(a, b, c) => out.extend([to_px * a, to_px * b, to_px * c]),
                PathEl::ClosePath => {}
            }
        }
        out
    }

    fn on_grid(v: f64, step: f64) -> bool {
        ((v / step) - (v / step).round()).abs() < 1e-6
    }

    fn extent(pts: &[Point]) -> (f64, f64, f64, f64) {
        let xs = pts.iter().map(|p| p.x);
        let ys = pts.iter().map(|p| p.y);
        (
            xs.clone().fold(f64::MAX, f64::min),
            ys.clone().fold(f64::MAX, f64::min),
            xs.fold(f64::MIN, f64::max),
            ys.fold(f64::MIN, f64::max),
        )
    }

    #[test]
    fn a_rectangle_fill_lands_on_pixel_boundaries() {
        // 2 px per pt: x 20.4 .. 41.4 px, y 10.2 .. 14.8 px.
        let to_px = Affine::scale(2.0);
        let out = adjusted_rect_fill(&rect(10.2, 5.1, 20.7, 7.4), to_px).expect("a rectangle");
        let pts = device_points(&out, to_px);
        assert!(pts.iter().all(|p| on_grid(p.x, 1.0) && on_grid(p.y, 1.0)));
        assert_eq!(extent(&pts), (20.0, 10.0, 41.0, 15.0));
    }

    #[test]
    fn a_rectangle_thinner_than_a_pixel_keeps_one() {
        // 0.2 px tall, both edges rounding to row 10.
        let to_px = Affine::scale(1.0);
        let out = adjusted_rect_fill(&rect(3.0, 10.1, 30.0, 10.3), to_px).expect("a rectangle");
        assert_eq!(extent(&device_points(&out, to_px)), (3.0, 10.0, 30.0, 11.0));
    }

    #[test]
    fn only_a_rectangle_along_the_axes_is_adjusted() {
        let to_px = Affine::scale(2.0);
        let mut slanted = BezPath::new();
        slanted.move_to((10.0, 10.0));
        slanted.line_to((20.0, 11.0));
        slanted.line_to((20.0, 20.0));
        slanted.line_to((10.0, 20.0));
        slanted.close_path();
        assert!(adjusted_rect_fill(&slanted, to_px).is_none());
        let circle = kurbo::Circle::new((20.0, 20.0), 8.0).to_path(0.01);
        assert!(adjusted_rect_fill(&circle, to_px).is_none());
        let mut two = rect(1.0, 1.0, 5.0, 5.0);
        two.extend(rect(7.0, 7.0, 9.0, 9.0));
        assert!(adjusted_rect_fill(&two, to_px).is_none());
        // A rotated device transform adjusts nothing.
        let rotated = Affine::rotate(0.3) * Affine::scale(2.0);
        assert!(adjusted_rect_fill(&rect(1.0, 1.0, 5.0, 5.0), rotated).is_none());
    }

    #[test]
    fn a_frame_stroke_along_the_axes_is_outlined_on_pixel_boundaries() {
        let to_px = Affine::scale(2.0);
        let stroke = kurbo::Stroke::new(1.1).with_join(kurbo::Join::Miter);
        let out = adjusted_stroke_outline(&rect(10.15, 20.1, 50.35, 40.3), &stroke, to_px)
            .expect("an axis-aligned stroke");
        // Edges on whole pixels; the inner miter joins' centre-line points
        // midway between two of them.
        let pts = device_points(&out, to_px);
        assert!(pts.iter().all(|p| on_grid(p.x, 0.5) && on_grid(p.y, 0.5)));
        // Centre line x 20.3 .. 100.7 px, half width 1.1 px.
        assert_eq!(extent(&pts), (19.0, 39.0, 102.0, 82.0));
    }

    #[test]
    fn a_hairline_rule_is_one_pixel_and_its_butt_ends_snap() {
        let to_px = Affine::scale(2.0);
        let mut rule = BezPath::new();
        rule.move_to((10.3, 20.1));
        rule.line_to((60.6, 20.1));
        // 0.25 pt = 0.5 px, centred on y 40.2 px: 39.95 .. 40.45.
        let stroke = kurbo::Stroke::new(0.25).with_caps(kurbo::Cap::Butt);
        let out = adjusted_stroke_outline(&rule, &stroke, to_px).expect("a horizontal rule");
        assert_eq!(
            extent(&device_points(&out, to_px)),
            (21.0, 40.0, 121.0, 41.0)
        );
    }

    #[test]
    fn every_dash_of_a_dashed_rule_snaps() {
        let to_px = Affine::scale(2.0);
        let mut rule = BezPath::new();
        rule.move_to((10.0, 20.1));
        rule.line_to((40.0, 20.1));
        let stroke = kurbo::Stroke::new(1.0)
            .with_caps(kurbo::Cap::Butt)
            .with_dashes(0.0, [3.3, 2.2]);
        let out = adjusted_stroke_outline(&rule, &stroke, to_px).expect("a dashed rule");
        let pts = device_points(&out, to_px);
        assert!(pts.iter().all(|p| on_grid(p.x, 1.0) && on_grid(p.y, 1.0)));
        let subpaths = out
            .elements()
            .iter()
            .filter(|e| matches!(e, PathEl::MoveTo(_)))
            .count();
        assert!(subpaths >= 5, "one outline per dash, got {subpaths}");
    }

    #[test]
    fn a_curved_or_slanted_stroke_stays_a_stroke() {
        let to_px = Affine::scale(2.0);
        let stroke = kurbo::Stroke::new(1.0);
        let mut slanted = BezPath::new();
        slanted.move_to((0.0, 0.0));
        slanted.line_to((10.0, 3.0));
        assert!(adjusted_stroke_outline(&slanted, &stroke, to_px).is_none());
        let circle = kurbo::Circle::new((20.0, 20.0), 8.0).to_path(0.01);
        assert!(adjusted_stroke_outline(&circle, &stroke, to_px).is_none());
        // A frame with one rounded corner is not adjusted at all, as in
        // Splash: its straight sides stay where they are.
        let mut rounded = BezPath::new();
        rounded.move_to((0.0, 0.0));
        rounded.line_to((20.0, 0.0));
        rounded.quad_to((30.0, 0.0), (30.0, 10.0));
        rounded.line_to((30.0, 30.0));
        rounded.line_to((0.0, 30.0));
        rounded.close_path();
        assert!(adjusted_stroke_outline(&rounded, &stroke, to_px).is_none());
    }

    #[test]
    fn a_straight_curve_counts_as_a_line() {
        // InDesign writes a straight side as a cubic whose handles sit on it.
        let to_px = Affine::scale(2.0);
        let mut p = BezPath::new();
        p.move_to((10.2, 10.2));
        p.curve_to((15.0, 10.2), (20.0, 10.2), (30.2, 10.2));
        p.line_to((30.2, 20.2));
        p.line_to((10.2, 20.2));
        p.close_path();
        assert!(adjusted_rect_fill(&p, to_px).is_some());
    }

    fn list_with(segments: Vec<PathSegment>) -> (DisplayList, PathId) {
        let mut list = DisplayList::new();
        let id = list.paths.push_anon(PathData::new(segments));
        (list, id)
    }

    #[test]
    fn a_glyph_that_is_a_rectangle_is_left_alone() {
        let (list, id) = list_with(vec![
            MoveTo { x: 0.0, y: 0.0 },
            LineTo { x: 100.0, y: 0.0 },
            LineTo { x: 100.0, y: 700.0 },
            LineTo { x: 0.0, y: 700.0 },
            Close,
        ]);
        let glyph = Transform([0.01, 0.0, 0.0, 0.01, 10.13, 20.07]);
        let to_px = Affine::scale(2.0);
        let mut fills = Fills::default();
        let as_glyph = fills.path(&list, id, &glyph, to_px, true).expect("path");
        assert_eq!(
            as_glyph,
            path_to_bez(list.paths.get(id).expect("path"), &glyph)
        );
        let as_shape = fills.path(&list, id, &glyph, to_px, false).expect("path");
        assert!(device_points(&as_shape, to_px)
            .iter()
            .all(|p| on_grid(p.x, 1.0) && on_grid(p.y, 1.0)));
    }

    #[test]
    fn fills_flatten_curves_to_the_tolerance_and_reuse_the_polyline() {
        // A quarter circle of radius 500 units, drawn at 0.02 pt per unit
        // (10 pt) and 2 px per pt: 20 px in device space.
        let k = 0.552_284_8 * 500.0;
        let (list, id) = list_with(vec![
            MoveTo { x: 500.0, y: 0.0 },
            CubicTo {
                cx1: 500.0,
                cy1: k,
                cx2: k,
                cy2: 500.0,
                x: 0.0,
                y: 500.0,
            },
            LineTo { x: 0.0, y: 0.0 },
            Close,
        ]);
        let to_px = Affine::scale(2.0);
        let mut fills = Fills::default();
        for tx in [10.0_f32, 37.25] {
            let t = Transform([0.02, 0.0, 0.0, 0.02, tx, 5.0]);
            let path = fills.path(&list, id, &t, to_px, true).expect("path");
            assert!(path
                .elements()
                .iter()
                .all(|e| matches!(e, PathEl::MoveTo(_) | PathEl::LineTo(_) | PathEl::ClosePath)));
            // The chords between the arc's vertices stay within the
            // tolerance of it (a chord's midpoint is its farthest point).
            let centre = to_px * Point::new(tx as f64, 5.0);
            let arc: Vec<Point> = device_points(&path, to_px)
                .into_iter()
                .filter(|p| (*p - centre).hypot() > 1.0)
                .collect();
            assert!(arc.len() > 8, "{} vertices", arc.len());
            for w in arc.windows(2) {
                let mid = w[0].midpoint(w[1]);
                let sag = 20.0 - (mid - centre).hypot();
                assert!(sag <= FLATTEN_TOLERANCE_PX + 0.01, "chord {w:?} sags {sag}");
            }
        }
        assert_eq!(
            fills.flattened.len(),
            1,
            "both instances share one polyline"
        );
    }
}
