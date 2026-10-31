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

//! Engine ADR 1007 — a gradient stroke applied ALONG or ACROSS its path.
//!
//! Neither rasteriser (Vello, `vello_cpu`) nor PDF has a paint whose
//! parameter is the arc length along a path or the distance across a
//! stroke, so the mapping happens here, at build time, into commands every
//! back end already draws alike: the stroke's outline becomes a clip, and
//! inside it the ramp is laid down as bands of solid colour, each a strip
//! of the stroke (`Along`: a stretch of the path, `Across`: a strip at a
//! fixed distance from the centreline). Because the back ends receive the
//! same solid fills, GPU, CPU and PDF agree by construction (ADR 146).
//!
//! **Tolerance.** A band shows the ramp's colour at its middle, so the
//! ramp is drawn as a staircase of at most [`MAX_BANDS`] steps per unit of
//! the parameter (and never narrower than [`MIN_BAND_PT`]): the colour
//! error is at most half a step, under one 8-bit level for a two-stop
//! ramp across the full range. Band edges fall on the stops, so a hard
//! stop stays hard. Each band overlaps the next by [`OVERLAP_PT`] and is
//! drawn before it, which hides the antialiasing seam two abutting fills
//! would leave; the band's sides reach [`PAD_PT`] beyond the stroke and
//! the clip draws the one antialiased edge. A ramp with translucent stops
//! draws its bands opaque under a luminosity soft mask of the same bands
//! in grey (the overlap would otherwise double their alpha).
//!
//! The path is flattened to 0.05 pt. A curve tighter than half the stroke
//! folds the offset strips over themselves on its inside; there a band may
//! show a neighbour's colour.

use kurbo::{BezPath, PathEl, Point, Vec2};
use paged_compose::{
    Color, DashPattern, DisplayCommand, GradientStop, Paint, PathData, PathSegment, SoftMaskType,
    Stroke, StrokeMarks, Transform,
};
use paged_model::StrokeGradientMode;

use crate::pipeline::BuiltPage;

/// Most bands per unit of the ramp's parameter.
pub(crate) const MAX_BANDS: f32 = 128.0;
/// The narrowest band, in pt.
pub(crate) const MIN_BAND_PT: f32 = 0.25;
/// How far each band reaches under the next, in pt.
pub(crate) const OVERLAP_PT: f64 = 0.25;
/// How far a band reaches beyond the stroke's sides (under the clip).
pub(crate) const PAD_PT: f64 = 1.0;
/// Flattening tolerance of the centreline, in pt.
const FLATTEN_PT: f64 = 0.05;

/// Emit a stroke through `emit`, mapping a gradient paint `Along` or
/// `Across` the path when `mode` says so. `emit` is the caller's own
/// stroke emitter (it may lay out dashes and marks); for `Within`, or a
/// solid paint, it runs once as it always did.
pub(crate) fn emit_mapped_stroke(
    page: &mut BuiltPage,
    mode: StrokeGradientMode,
    paint: Paint,
    stroke: Stroke,
    mut emit: impl FnMut(&mut BuiltPage, Paint, Stroke),
) {
    let stops = match mode {
        StrokeGradientMode::Within => None,
        StrokeGradientMode::Along | StrokeGradientMode::Across => ramp_stops(page, &paint),
    };
    let Some(stops) = stops else {
        emit(page, paint, stroke);
        return;
    };
    let s0 = page.list.commands.len();
    // The centrelines: the same stroke without its dashes or marks, so the
    // ramp runs along the whole path, gaps included.
    let mut solid = stroke;
    solid.dash = DashPattern {
        len: 0,
        pattern: [0.0; 8],
        marks: StrokeMarks::None,
    };
    emit(page, paint, solid);
    let centres: Vec<(BezPath, Stroke)> = page.list.commands[s0..]
        .iter()
        .filter_map(|c| match c {
            DisplayCommand::StrokePath {
                path_id,
                stroke,
                transform,
                ..
            } => {
                let path = page.list.paths.get(*path_id)?;
                Some((to_bez(path, transform), *stroke))
            }
            _ => None,
        })
        .collect();
    page.list.commands.truncate(s0);
    // What the stroke covers: its outline with its dashes and marks.
    emit(page, paint, stroke);
    let mut clip: Vec<PathSegment> = Vec::new();
    for c in &page.list.commands[s0..] {
        match c {
            DisplayCommand::StrokePath {
                path_id,
                stroke,
                transform,
                ..
            } => {
                if let Some(path) = page.list.paths.get(*path_id) {
                    let outline = outline_of(&to_bez(path, transform), stroke);
                    clip.extend(from_bez(&outline));
                }
            }
            DisplayCommand::FillPath {
                path_id, transform, ..
            } => {
                if let Some(path) = page.list.paths.get(*path_id) {
                    clip.extend(from_bez(&to_bez(path, transform)));
                }
            }
            _ => {}
        }
    }
    if centres.is_empty() || clip.is_empty() {
        // Nothing this module can map: leave the stroke as emitted.
        return;
    }
    page.list.commands.truncate(s0);

    let mut bands: Vec<(PathData, Color)> = Vec::new();
    for (centre, st) in &centres {
        for line in polylines(centre) {
            match mode {
                StrokeGradientMode::Along => along_bands(&line, st, &stops, &mut bands),
                StrokeGradientMode::Across => across_bands(&line, st, &stops, &mut bands),
                StrokeGradientMode::Within => {}
            }
        }
    }
    if bands.is_empty() {
        emit(page, paint, stroke);
        return;
    }
    let translucent = bands.iter().any(|(_, c)| c.a < 0.999);
    let clip_id = page.list.paths.push_anon(PathData::new(clip));
    page.list.push(DisplayCommand::PushClip {
        path_id: clip_id,
        transform: Transform::IDENTITY,
    });
    let ids: Vec<_> = bands
        .into_iter()
        .map(|(p, c)| (page.list.paths.push_anon(p), c))
        .collect();
    if translucent {
        page.list.push(DisplayCommand::BeginSoftMask {
            mask_type: SoftMaskType::Luminosity,
            invert: false,
            transform: Transform::IDENTITY,
        });
        for (id, c) in &ids {
            // Both back ends and PDF read a luminosity mask off the
            // sRGB-encoded colour, so the grey is the alpha decoded.
            let g = srgb_to_linear(c.a.clamp(0.0, 1.0));
            page.list.push(DisplayCommand::FillPath {
                path_id: *id,
                paint: Paint::Solid(Color::rgba(g, g, g, 1.0)),
                transform: Transform::IDENTITY,
            });
        }
        page.list
            .push(DisplayCommand::BeginMaskedContent(Transform::IDENTITY));
    }
    for (id, c) in &ids {
        page.list.push(DisplayCommand::FillPath {
            path_id: *id,
            paint: Paint::Solid(Color::rgba(c.r, c.g, c.b, 1.0)),
            transform: Transform::IDENTITY,
        });
    }
    if translucent {
        page.list
            .push(DisplayCommand::EndSoftMask(Transform::IDENTITY));
    }
    page.list.push(DisplayCommand::PopClip(Transform::IDENTITY));
}

/// The ramp of a gradient paint, by offset; `None` for a solid paint.
fn ramp_stops(page: &BuiltPage, paint: &Paint) -> Option<Vec<GradientStop>> {
    let list = &page.list;
    let stops = match paint {
        Paint::LinearGradient(id) => &list.linear_gradient(*id)?.stops,
        Paint::RadialGradient(id) => &list.radial_gradient(*id)?.stops,
        Paint::SweepGradient(id) => &list.sweep_gradient(*id)?.stops,
        Paint::Solid(_) | Paint::Cmyk { .. } => return None,
    };
    if stops.is_empty() {
        return None;
    }
    let mut v = stops.clone();
    v.sort_by(|a, b| a.offset.total_cmp(&b.offset));
    Some(v)
}

/// The ramp's colour at `t` — the shared sampler (`paged_compose::gradient_sample`).
pub(crate) fn sample(stops: &[GradientStop], t: f32) -> Color {
    paged_compose::gradient_sample::sample_ramp(stops, t)
}

/// The parameter intervals the bands cover: split at every stop, each
/// piece cut into steps no wider than `1 / bands_per_unit`.
pub(crate) fn band_intervals(stops: &[GradientStop], bands_per_unit: f32) -> Vec<(f32, f32)> {
    let mut cuts: Vec<f32> = vec![0.0, 1.0];
    cuts.extend(
        stops
            .iter()
            .map(|s| s.offset)
            .filter(|o| *o > 0.0 && *o < 1.0),
    );
    cuts.sort_by(f32::total_cmp);
    cuts.dedup_by(|a, b| (*a - *b).abs() < 1e-6);
    let mut out = Vec::new();
    for w in cuts.windows(2) {
        let (a, b) = (w[0], w[1]);
        let n = ((b - a) * bands_per_unit).ceil().max(1.0) as usize;
        for i in 0..n {
            let t0 = a + (b - a) * i as f32 / n as f32;
            let t1 = a + (b - a) * (i + 1) as f32 / n as f32;
            out.push((t0, t1));
        }
    }
    out
}

fn bands_per_unit(extent_pt: f32) -> f32 {
    (extent_pt / MIN_BAND_PT).clamp(1.0, MAX_BANDS)
}

/// A flattened contour of the centreline: its points and whether it
/// closes on itself (then the last point repeats the first).
pub(crate) struct Polyline {
    pub points: Vec<Point>,
    pub closed: bool,
}

pub(crate) fn polylines(path: &BezPath) -> Vec<Polyline> {
    let mut out: Vec<Polyline> = Vec::new();
    let mut cur: Vec<Point> = Vec::new();
    let finish = |pts: &mut Vec<Point>, closed: bool, out: &mut Vec<Polyline>| {
        let mut p: Vec<Point> = Vec::with_capacity(pts.len());
        for q in pts.drain(..) {
            if p.last().is_none_or(|l: &Point| l.distance(q) > 1e-4) {
                p.push(q);
            }
        }
        if closed && p.len() > 2 {
            if p[0].distance(p[p.len() - 1]) > 1e-4 {
                let first = p[0];
                p.push(first);
            }
        } else if closed && p.len() <= 2 {
            return;
        }
        if p.len() >= 2 {
            out.push(Polyline { points: p, closed });
        }
    };
    kurbo::flatten(path, FLATTEN_PT, |el| match el {
        PathEl::MoveTo(p) => {
            finish(&mut cur, false, &mut out);
            cur.push(p);
        }
        PathEl::LineTo(p) => cur.push(p),
        PathEl::ClosePath => {
            let start = cur.first().copied();
            finish(&mut cur, true, &mut out);
            if let Some(s) = start {
                cur.push(s);
            }
        }
        // `flatten` emits lines only.
        _ => {}
    });
    finish(&mut cur, false, &mut out);
    out
}

/// A contour ready for offsetting: points, arc lengths and the miter
/// vector at each point (the normal to its left of travel is `−m`, to
/// its right `+m`, scaled so an offset by `d` lands `d` from both
/// adjacent segments). An open contour is extended at both ends by
/// `ext` along its end tangents so square and round caps are covered.
struct Frame {
    p: Vec<Point>,
    s: Vec<f64>,
    m: Vec<Vec2>,
    length: f64,
    /// Arc length where the real path starts / ends (0 and `length` for
    /// a closed contour, the extension's ends lie outside).
    lo: f64,
    hi: f64,
}

fn normal(a: Point, b: Point) -> Vec2 {
    let t = (b - a).normalize();
    Vec2::new(-t.y, t.x)
}

fn frame(line: &Polyline, ext: f64) -> Option<Frame> {
    let pts = &line.points;
    let n = pts.len();
    if n < 2 {
        return None;
    }
    let normals: Vec<Vec2> = pts.windows(2).map(|w| normal(w[0], w[1])).collect();
    let miter = |a: Vec2, b: Vec2| -> Vec2 {
        let bis = a + b;
        if bis.hypot() < 1e-6 {
            return b;
        }
        let bis = bis.normalize();
        bis / bis.dot(b).max(0.25)
    };
    let mut m: Vec<Vec2> = Vec::with_capacity(n);
    for k in 0..n {
        let v = if k == 0 {
            if line.closed {
                miter(normals[n - 2], normals[0])
            } else {
                normals[0]
            }
        } else if k == n - 1 {
            if line.closed {
                miter(normals[n - 2], normals[0])
            } else {
                normals[n - 2]
            }
        } else {
            miter(normals[k - 1], normals[k])
        };
        m.push(v);
    }
    let mut s = Vec::with_capacity(n);
    let mut acc = 0.0;
    s.push(0.0);
    for w in pts.windows(2) {
        acc += w[0].distance(w[1]);
        s.push(acc);
    }
    let length = acc;
    if length < 1e-6 {
        return None;
    }
    let mut p = pts.clone();
    if !line.closed && ext > 0.0 {
        let t0 = (pts[1] - pts[0]).normalize();
        let t1 = (pts[n - 1] - pts[n - 2]).normalize();
        p.insert(0, pts[0] - t0 * ext);
        m.insert(0, normals[0]);
        s.insert(0, -ext);
        p.push(pts[n - 1] + t1 * ext);
        m.push(normals[n - 2]);
        s.push(length + ext);
    }
    let (lo, hi) = (s[0], s[s.len() - 1]);
    Some(Frame {
        p,
        s,
        m,
        length,
        lo,
        hi,
    })
}

impl Frame {
    /// The point and miter vector at arc length `at` (clamped).
    fn at(&self, at: f64) -> (Point, Vec2) {
        let at = at.clamp(self.lo, self.hi);
        let k = match self.s.iter().position(|&v| v >= at) {
            Some(0) | None => return (self.p[0], self.m[0]),
            Some(k) => k,
        };
        let (s0, s1) = (self.s[k - 1], self.s[k]);
        let f = if s1 - s0 > 1e-9 {
            (at - s0) / (s1 - s0)
        } else {
            1.0
        };
        (
            self.p[k - 1].lerp(self.p[k], f),
            self.m[k - 1].lerp(self.m[k], f),
        )
    }

    /// The strip of the stroke between arc lengths `a` and `b`, reaching
    /// `h` either side of the centreline.
    fn strip(&self, a: f64, b: f64, h: f64) -> Vec<Point> {
        let mut centre: Vec<(Point, Vec2)> = vec![self.at(a)];
        for k in 0..self.s.len() {
            if self.s[k] > a && self.s[k] < b {
                centre.push((self.p[k], self.m[k]));
            }
        }
        centre.push(self.at(b));
        let mut ring: Vec<Point> = centre.iter().map(|(p, m)| *p - *m * h).collect();
        ring.extend(centre.iter().rev().map(|(p, m)| *p + *m * h));
        ring
    }

    /// The band of the stroke between the offsets `da` and `db` from the
    /// centreline, along the whole contour.
    fn band(&self, da: f64, db: f64) -> Vec<Point> {
        let mut ring: Vec<Point> = self
            .p
            .iter()
            .zip(&self.m)
            .map(|(p, m)| *p + *m * da)
            .collect();
        ring.extend(self.p.iter().zip(&self.m).rev().map(|(p, m)| *p + *m * db));
        ring
    }
}

fn along_bands(
    line: &Polyline,
    stroke: &Stroke,
    stops: &[GradientStop],
    out: &mut Vec<(PathData, Color)>,
) {
    let w = f64::from(stroke.width);
    let ext = if line.closed { 0.0 } else { w };
    let Some(fr) = frame(line, ext) else {
        return;
    };
    let h = w * 0.5 + PAD_PT;
    let intervals = band_intervals(stops, bands_per_unit(fr.length as f32));
    let last = intervals.len().saturating_sub(1);
    for (i, (t0, t1)) in intervals.iter().enumerate() {
        let a = if i == 0 {
            fr.lo
        } else {
            f64::from(*t0) * fr.length
        };
        let b = if i == last {
            fr.hi
        } else {
            f64::from(*t1) * fr.length + OVERLAP_PT
        };
        let color = sample(stops, (t0 + t1) * 0.5);
        out.push((ring_path(&fr.strip(a, b, h)), color));
    }
}

fn across_bands(
    line: &Polyline,
    stroke: &Stroke,
    stops: &[GradientStop],
    out: &mut Vec<(PathData, Color)>,
) {
    let w = f64::from(stroke.width);
    if w <= 0.0 {
        return;
    }
    let ext = if line.closed { 0.0 } else { w };
    let Some(fr) = frame(line, ext) else {
        return;
    };
    let half = w * 0.5;
    let intervals = band_intervals(stops, bands_per_unit(stroke.width));
    let last = intervals.len().saturating_sub(1);
    for (i, (t0, t1)) in intervals.iter().enumerate() {
        // 0 on the left of travel (−m), 1 on the right (+m).
        let da = if i == 0 {
            -half - PAD_PT
        } else {
            -half + f64::from(*t0) * w
        };
        let db = if i == last {
            half + PAD_PT
        } else {
            -half + f64::from(*t1) * w + OVERLAP_PT
        };
        let color = sample(stops, (t0 + t1) * 0.5);
        out.push((ring_path(&fr.band(da, db)), color));
    }
}

fn ring_path(ring: &[Point]) -> PathData {
    let mut seg = Vec::with_capacity(ring.len() + 1);
    for (i, p) in ring.iter().enumerate() {
        let (x, y) = (p.x as f32, p.y as f32);
        seg.push(if i == 0 {
            PathSegment::MoveTo { x, y }
        } else {
            PathSegment::LineTo { x, y }
        });
    }
    seg.push(PathSegment::Close);
    PathData::new(seg)
}

/// A display-list path in page space, as kurbo takes it.
fn to_bez(path: &PathData, t: &Transform) -> BezPath {
    let p = |x: f32, y: f32| {
        let (x, y) = t.apply(x, y);
        Point::new(f64::from(x), f64::from(y))
    };
    let mut b = BezPath::new();
    for seg in &path.segments {
        match *seg {
            PathSegment::MoveTo { x, y } => b.move_to(p(x, y)),
            PathSegment::LineTo { x, y } => b.line_to(p(x, y)),
            PathSegment::QuadTo { cx, cy, x, y } => b.quad_to(p(cx, cy), p(x, y)),
            PathSegment::CubicTo {
                cx1,
                cy1,
                cx2,
                cy2,
                x,
                y,
            } => b.curve_to(p(cx1, cy1), p(cx2, cy2), p(x, y)),
            PathSegment::Close => b.close_path(),
        }
    }
    b
}

fn from_bez(b: &BezPath) -> Vec<PathSegment> {
    let f = |pt: Point| (pt.x as f32, pt.y as f32);
    b.elements()
        .iter()
        .map(|el| match *el {
            PathEl::MoveTo(a) => {
                let (x, y) = f(a);
                PathSegment::MoveTo { x, y }
            }
            PathEl::LineTo(a) => {
                let (x, y) = f(a);
                PathSegment::LineTo { x, y }
            }
            PathEl::QuadTo(c, a) => {
                let ((cx, cy), (x, y)) = (f(c), f(a));
                PathSegment::QuadTo { cx, cy, x, y }
            }
            PathEl::CurveTo(c1, c2, a) => {
                let ((cx1, cy1), (cx2, cy2), (x, y)) = (f(c1), f(c2), f(a));
                PathSegment::CubicTo {
                    cx1,
                    cy1,
                    cx2,
                    cy2,
                    x,
                    y,
                }
            }
            PathEl::ClosePath => PathSegment::Close,
        })
        .collect()
}

/// The closed outline `centre` covers when stroked (no dash: the caller
/// hands each dash piece over on its own).
fn outline_of(centre: &BezPath, stroke: &Stroke) -> BezPath {
    use kurbo::{Cap, Join, StrokeOpts};
    use paged_compose::{LineCap, LineJoin};
    let style = kurbo::Stroke::new(f64::from(stroke.width))
        .with_caps(match stroke.cap {
            LineCap::Butt => Cap::Butt,
            LineCap::Round => Cap::Round,
            LineCap::Square => Cap::Square,
        })
        .with_join(match stroke.join {
            LineJoin::Miter => Join::Miter,
            LineJoin::Round => Join::Round,
            LineJoin::Bevel => Join::Bevel,
        })
        .with_miter_limit(f64::from(stroke.miter_limit));
    kurbo::stroke(centre.iter(), &style, &StrokeOpts::default(), FLATTEN_PT)
}

use paged_compose::gradient_sample::srgb_decode as srgb_to_linear;

#[cfg(test)]
mod tests {
    use super::*;

    fn stop(offset: f32, c: Color) -> GradientStop {
        GradientStop { offset, color: c }
    }

    #[test]
    fn bands_break_at_every_stop_and_stay_fine() {
        let stops = [
            stop(0.0, Color::BLACK),
            stop(0.3, Color::WHITE),
            stop(0.3, Color::BLACK),
            stop(1.0, Color::WHITE),
        ];
        let iv = band_intervals(&stops, 10.0);
        assert!(iv.iter().any(|(_, b)| (*b - 0.3).abs() < 1e-6));
        assert!(iv.iter().all(|(a, b)| b - a <= 0.1 + 1e-6));
        assert_eq!(iv.first().unwrap().0, 0.0);
        assert_eq!(iv.last().unwrap().1, 1.0);
    }

    #[test]
    fn sample_blends_colour_and_alpha_apart() {
        let stops = [
            stop(0.0, Color::rgba(1.0, 0.0, 0.0, 1.0)),
            stop(1.0, Color::rgba(0.0, 0.0, 1.0, 0.0)),
        ];
        let c = sample(&stops, 0.5);
        // Half way in sRGB values: 0.5 encoded, about 0.214 linear.
        assert!((c.r - srgb_to_linear(0.5)).abs() < 1e-5);
        assert!((c.b - srgb_to_linear(0.5)).abs() < 1e-5);
        assert!((c.a - 0.5).abs() < 1e-6);
    }

    #[test]
    fn a_closed_square_flattens_to_one_closed_contour() {
        let mut b = BezPath::new();
        b.move_to((0.0, 0.0));
        b.line_to((10.0, 0.0));
        b.line_to((10.0, 10.0));
        b.line_to((0.0, 10.0));
        b.close_path();
        let lines = polylines(&b);
        assert_eq!(lines.len(), 1);
        assert!(lines[0].closed);
        assert_eq!(lines[0].points.len(), 5);
        let fr = frame(&lines[0], 0.0).unwrap();
        assert!((fr.length - 40.0).abs() < 1e-9);
        // The miter at a right-angle corner reaches √2 out.
        assert!((fr.m[1].hypot() - std::f64::consts::SQRT_2).abs() < 1e-9);
    }
}
