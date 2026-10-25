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

//! A placed SVG drawn as vectors (ADR 190, amendment of 2026-10-20).
//!
//! `usvg` parses the file; [`prepare`] walks its tree into [`SvgArt`], a
//! short list of operations the display list can express: paths with
//! their fills and strokes, solid and gradient paints, clip paths, and
//! groups with an opacity or a blend mode. [`draw`] writes them into the
//! page's display list under the placement's transform, the one the
//! raster of the same SVG would take, so the art stays vector on the
//! canvas at every zoom, on both rasterizers and in the PDF export.
//!
//! What the display list cannot say keeps the SVG on its raster lane
//! (`paged_gpu::svg`, ADR 190), whole: filters, masks, patterns, a
//! gradient that reflects or repeats, a focal radial gradient, a gradient
//! whose stops differ in opacity (the list interpolates premultiplied),
//! a dash offset, a
//! nested SVG image, and a clip path of several shapes that are not
//! single contours. An even-odd fill, whose contours may cross, is drawn
//! by the list's own even-odd rule (engine ADR 1006). [`prepare`]
//! returns `None` for those, and the caller decodes the raster. A stroke
//! or a radial gradient under a skew or an uneven scale draws the raster
//! too, decided per placement in [`draw`] (the list strokes one width and
//! paints circles).

use std::sync::Arc;

use paged_compose::{
    BlendMode, Color, DashPattern, DisplayCommand, DisplayList, FillRule, GradientStop, LineCap,
    LineJoin, LinearGradient, Paint, PathData, PathSegment, RadialGradient, Rect, Stroke,
    Transform,
};
use paged_model::winding::signed_area;

/// A placed SVG prepared for the display list.
#[derive(Debug)]
pub(crate) struct SvgArt {
    /// The SVG's size in user units, rounded up as its raster is (one
    /// pixel per user unit): the placed graphic's natural size.
    pub(crate) width: f32,
    pub(crate) height: f32,
    ops: Vec<Op>,
    /// The SVG itself, for the raster the art falls back to under such a
    /// placement.
    bytes: Arc<[u8]>,
}

/// A path in its own space, `ts` mapping it into the SVG's canvas.
#[derive(Debug)]
struct Shape {
    path: PathData,
    ts: Transform,
    fill: Option<ArtPaint>,
    stroke: Option<(ArtPaint, Stroke)>,
    stroke_first: bool,
}

#[derive(Debug)]
enum Op {
    Shape(Box<Shape>),
    /// A clip path in the SVG's canvas space.
    PushClip(PathData),
    PopClip,
    /// A group composited with `opacity` and `blend`; `bounds` (canvas
    /// space) is what the group can paint.
    BeginGroup {
        bounds: (f32, f32, f32, f32),
        blend: BlendMode,
        opacity: f32,
    },
    EndGroup,
}

#[derive(Debug, Clone)]
enum ArtPaint {
    Solid(Color),
    /// Endpoints in the gradient's space, `space` mapping it into the
    /// path's.
    Linear {
        start: (f32, f32),
        end: (f32, f32),
        space: Transform,
        stops: Vec<GradientStop>,
    },
    /// Centre and radius in the gradient's space.
    Radial {
        center: (f32, f32),
        radius: f32,
        space: Transform,
        stops: Vec<GradientStop>,
    },
}

/// Parse `bytes` as an SVG and prepare it for the display list, or
/// `None` when it is not an SVG `usvg` reads or uses something the list
/// cannot express (see the module docs).
pub(crate) fn prepare(bytes: &[u8]) -> Option<SvgArt> {
    let tree = usvg::Tree::from_data(bytes, &usvg::Options::default()).ok()?;
    let mut walk = Walk {
        ops: Vec::new(),
        failed: false,
        open: Vec::new(),
    };
    paged_svg::walk::walk_tree(&tree, (), &mut walk);
    if walk.failed {
        return None;
    }
    Some(SvgArt {
        width: tree.size().width().ceil().max(1.0),
        height: tree.size().height().ceil().max(1.0),
        ops: walk.ops,
        bytes: Arc::from(bytes),
    })
}

/// Draw `art` into `list`, `t` mapping its user units (its raster's
/// pixels) into page space. The art is clipped to the SVG's own canvas,
/// as its raster is.
///
/// Paths go into the list in page space. The list's readers place a
/// gradient differently (the rasterizers map its endpoints through the
/// path's transform; the PDF export reads a fill's endpoints as fractions
/// of the path's local box and a stroke's as fractions of its page box),
/// so a gradient fill is a square under a clip by the path, and a
/// gradient stroke is its path in the unit box of its page bounds: both
/// readers then see the same ramp.
pub(crate) fn draw(art: &SvgArt, t: Transform, list: &mut DisplayList) {
    if !art.follows(&t) {
        draw_raster(art, t, list);
        return;
    }
    let canvas = list
        .paths
        .push_anon(rect_path(0.0, 0.0, art.width, art.height));
    list.push(DisplayCommand::PushClip {
        path_id: canvas,
        transform: t,
    });
    for op in &art.ops {
        match op {
            Op::Shape(shape) => {
                let Shape {
                    path,
                    ts,
                    fill,
                    stroke,
                    stroke_first,
                } = &**shape;
                let full = t.compose(ts);
                let page = map_path(path, &full);
                let id = list.paths.push_anon(page.clone());
                if *stroke_first {
                    draw_stroke(stroke.as_ref(), &page, id, &full, list);
                    draw_fill(fill.as_ref(), &page, id, &full, list);
                } else {
                    draw_fill(fill.as_ref(), &page, id, &full, list);
                    draw_stroke(stroke.as_ref(), &page, id, &full, list);
                }
            }
            Op::PushClip(path) => {
                let id = list.paths.push_anon(path.clone());
                list.push(DisplayCommand::PushClip {
                    path_id: id,
                    transform: t,
                });
            }
            Op::PopClip => list.push(DisplayCommand::PopClip(Transform::IDENTITY)),
            Op::BeginGroup {
                bounds,
                blend,
                opacity,
            } => {
                list.push(DisplayCommand::BeginBlendGroup {
                    bounds: page_bounds(*bounds, &t),
                    blend_mode: *blend,
                    opacity: *opacity,
                    isolated: true,
                    knockout: false,
                    transform: Transform::IDENTITY,
                });
            }
            Op::EndGroup => list.push(DisplayCommand::EndBlendGroup(Transform::IDENTITY)),
        }
    }
    list.push(DisplayCommand::PopClip(Transform::IDENTITY));
}

fn draw_fill(
    fill: Option<&ArtPaint>,
    page: &PathData,
    id: paged_compose::PathId,
    full: &Transform,
    list: &mut DisplayList,
) {
    let Some(p) = fill else {
        return;
    };
    let ramp = match page_paint(p, full) {
        PagePaint::Solid(c) => {
            list.push(DisplayCommand::FillPath {
                path_id: id,
                paint: Paint::Solid(c),
                transform: Transform::IDENTITY,
            });
            return;
        }
        ramp => ramp,
    };
    // A square over the path's box, its unit square the local space the
    // gradient is given in, clipped by the path.
    let Some((x, y, w, h)) = bounds(page) else {
        return;
    };
    let s = w.max(h);
    if s <= 0.0 {
        return;
    }
    let square = Transform([s, 0.0, 0.0, s, x, y]);
    let local = |(px, py): (f32, f32)| ((px - x) / s, (py - y) / s);
    let paint = match ramp {
        PagePaint::Linear { start, end, stops } => {
            Paint::LinearGradient(list.push_linear_gradient(LinearGradient {
                start: local(start),
                end: local(end),
                stops,
            }))
        }
        PagePaint::Radial {
            center,
            radius,
            stops,
        } => Paint::RadialGradient(list.push_radial_gradient(RadialGradient {
            center: local(center),
            radius: radius / s,
            stops,
        })),
        PagePaint::Solid(_) => return,
    };
    let unit = list.paths.push_anon(rect_path(0.0, 0.0, 1.0, 1.0));
    list.push(DisplayCommand::PushClip {
        path_id: id,
        transform: Transform::IDENTITY,
    });
    list.push(DisplayCommand::FillPath {
        path_id: unit,
        paint,
        transform: square,
    });
    list.push(DisplayCommand::PopClip(Transform::IDENTITY));
}

fn draw_stroke(
    stroke: Option<&(ArtPaint, Stroke)>,
    page: &PathData,
    id: paged_compose::PathId,
    full: &Transform,
    list: &mut DisplayList,
) {
    let Some((p, s)) = stroke else {
        return;
    };
    // Widths and dashes are page points.
    let k = scale_of(full);
    let mut stroke = *s;
    stroke.width *= k;
    for d in stroke.dash.pattern.iter_mut() {
        *d *= k;
    }
    let (path_id, paint, transform) = match page_paint(p, full) {
        PagePaint::Solid(c) => (id, Paint::Solid(c), Transform::IDENTITY),
        PagePaint::Linear { start, end, stops } => {
            // The path in the unit box of its page bounds, which the
            // export's stroke shading spans; a flat axis keeps scale 1 and
            // the ramp's endpoints on the box's edge along it.
            let Some((x, y, w, h)) = bounds(page) else {
                return;
            };
            let (sx, sy) = (
                if w > 1e-6 { w } else { 1.0 },
                if h > 1e-6 { h } else { 1.0 },
            );
            let local = |(px, py): (f32, f32)| {
                (
                    if w > 1e-6 { (px - x) / sx } else { 0.0 },
                    if h > 1e-6 { (py - y) / sy } else { 0.0 },
                )
            };
            let boxed = Transform([sx, 0.0, 0.0, sy, x, y]);
            let Some(inv) = boxed.inverse() else {
                return;
            };
            let unit = list.paths.push_anon(map_path(page, &inv));
            let paint = Paint::LinearGradient(list.push_linear_gradient(LinearGradient {
                start: local(start),
                end: local(end),
                stops,
            }));
            (unit, paint, boxed)
        }
        // `prepare` keeps radial strokes on the raster lane.
        PagePaint::Radial { .. } => return,
    };
    list.push(DisplayCommand::StrokePath {
        path_id,
        paint,
        stroke,
        transform,
    });
}

/// The box of `path`'s points (control points included, so it covers
/// the curves) as `(x, y, w, h)`.
fn bounds(path: &PathData) -> Option<(f32, f32, f32, f32)> {
    let (mut lx, mut ly, mut hx, mut hy) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
    let mut add = |x: f32, y: f32| {
        lx = lx.min(x);
        ly = ly.min(y);
        hx = hx.max(x);
        hy = hy.max(y);
    };
    for s in &path.segments {
        match *s {
            PathSegment::MoveTo { x, y } | PathSegment::LineTo { x, y } => add(x, y),
            PathSegment::QuadTo { cx, cy, x, y } => {
                add(cx, cy);
                add(x, y);
            }
            PathSegment::CubicTo {
                cx1,
                cy1,
                cx2,
                cy2,
                x,
                y,
            } => {
                add(cx1, cy1);
                add(cx2, cy2);
                add(x, y);
            }
            PathSegment::Close => {}
        }
    }
    (lx <= hx && ly <= hy).then_some((lx, ly, hx - lx, hy - ly))
}

/// The art's SVG drawn as its raster (`paged_gpu::svg`, ADR 190), for a
/// placement the vectors cannot follow exactly.
fn draw_raster(art: &SvgArt, t: Transform, list: &mut DisplayList) {
    let Some(decoded) = super::image_decode::decode_svg_raster(&art.bytes) else {
        return;
    };
    let image_id = list.push_image(decoded);
    list.push(DisplayCommand::Image {
        image_id,
        transform: t.compose(&Transform::scale(art.width, art.height)),
    });
}

impl SvgArt {
    /// True when the vectors draw exactly under `t`: a stroke and a
    /// radial gradient keep their shape only without skew or uneven
    /// scale (the list strokes one width and paints circles).
    fn follows(&self, t: &Transform) -> bool {
        self.ops.iter().all(|op| {
            let Op::Shape(shape) = op else {
                return true;
            };
            let Shape {
                ts, fill, stroke, ..
            } = &**shape;
            let full = t.compose(ts);
            let round = |p: &ArtPaint| match p {
                ArtPaint::Radial { space, .. } => is_similarity(&full.compose(space)),
                _ => true,
            };
            fill.as_ref().is_none_or(round)
                && stroke
                    .as_ref()
                    .is_none_or(|(p, _)| is_similarity(&full) && round(p))
        })
    }
}

/// A paint resolved into page space.
enum PagePaint {
    Solid(Color),
    Linear {
        start: (f32, f32),
        end: (f32, f32),
        stops: Vec<GradientStop>,
    },
    Radial {
        center: (f32, f32),
        radius: f32,
        stops: Vec<GradientStop>,
    },
}

/// `p` in page space, `full` mapping the path's own space there.
fn page_paint(p: &ArtPaint, full: &Transform) -> PagePaint {
    match p {
        ArtPaint::Solid(c) => PagePaint::Solid(*c),
        ArtPaint::Linear {
            start,
            end,
            space,
            stops,
        } => {
            // A linear gradient is an affine ramp, which any affine map
            // keeps one: its page-space endpoints are where the ramp is 0
            // and 1 along the ramp's own gradient, perpendicular to its
            // isolines in page space.
            let g = full.compose(space);
            let (dx, dy) = (end.0 - start.0, end.1 - start.1);
            let len2 = dx * dx + dy * dy;
            let last = || PagePaint::Solid(stops.last().map_or(Color::BLACK, |s| s.color));
            let Some(inv) = g.inverse().filter(|_| len2 > 0.0) else {
                return last();
            };
            let [ia, ib, ic, id, _, _] = inv.0;
            let (ax, ay) = ((ia * dx + ib * dy) / len2, (ic * dx + id * dy) / len2);
            let a2 = ax * ax + ay * ay;
            if a2 <= 0.0 || !a2.is_finite() {
                return last();
            }
            let q0 = g.apply(start.0, start.1);
            PagePaint::Linear {
                start: q0,
                end: (q0.0 + ax / a2, q0.1 + ay / a2),
                stops: stops.clone(),
            }
        }
        ArtPaint::Radial {
            center,
            radius,
            space,
            stops,
        } => {
            let g = full.compose(space);
            PagePaint::Radial {
                center: g.apply(center.0, center.1),
                radius: radius * scale_of(&g),
                stops: stops.clone(),
            }
        }
    }
}

/// `path` with `t` applied to its points.
fn map_path(path: &PathData, t: &Transform) -> PathData {
    let segments = path
        .segments
        .iter()
        .map(|s| match *s {
            PathSegment::MoveTo { x, y } => {
                let (x, y) = t.apply(x, y);
                PathSegment::MoveTo { x, y }
            }
            PathSegment::LineTo { x, y } => {
                let (x, y) = t.apply(x, y);
                PathSegment::LineTo { x, y }
            }
            PathSegment::QuadTo { cx, cy, x, y } => {
                let ((cx, cy), (x, y)) = (t.apply(cx, cy), t.apply(x, y));
                PathSegment::QuadTo { cx, cy, x, y }
            }
            PathSegment::CubicTo {
                cx1,
                cy1,
                cx2,
                cy2,
                x,
                y,
            } => {
                let ((cx1, cy1), (cx2, cy2), (x, y)) =
                    (t.apply(cx1, cy1), t.apply(cx2, cy2), t.apply(x, y));
                PathSegment::CubicTo {
                    cx1,
                    cy1,
                    cx2,
                    cy2,
                    x,
                    y,
                }
            }
            PathSegment::Close => PathSegment::Close,
        })
        .collect();
    PathData::new(segments).with_fill_rule(path.fill_rule)
}

/// The page-space box of a canvas-space rectangle, a point wider on
/// every side for antialiasing.
fn page_bounds((x0, y0, x1, y1): (f32, f32, f32, f32), t: &Transform) -> Rect {
    let corners = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)].map(|(x, y)| t.apply(x, y));
    let (mut lx, mut ly, mut hx, mut hy) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
    for (x, y) in corners {
        lx = lx.min(x);
        ly = ly.min(y);
        hx = hx.max(x);
        hy = hy.max(y);
    }
    Rect {
        x: lx - 1.0,
        y: ly - 1.0,
        w: hx - lx + 2.0,
        h: hy - ly + 2.0,
    }
}

/// A rotation and a uniform scale (a reflection allowed): no skew, no
/// uneven scale.
fn is_similarity(t: &Transform) -> bool {
    let [a, b, c, d, _, _] = t.0;
    let s = a.hypot(b).max(c.hypot(d));
    if s <= 0.0 || !s.is_finite() {
        return false;
    }
    let tol = s * 1e-3;
    ((a - d).abs() <= tol && (b + c).abs() <= tol) || ((a + d).abs() <= tol && (b - c).abs() <= tol)
}

/// The length scale of `t`: the square root of its area scale.
fn scale_of(t: &Transform) -> f32 {
    let [a, b, c, d, _, _] = t.0;
    (a * d - b * c).abs().sqrt()
}

fn transform(t: usvg::Transform) -> Transform {
    Transform([t.sx, t.ky, t.kx, t.sy, t.tx, t.ty])
}

fn rect_path(x0: f32, y0: f32, x1: f32, y1: f32) -> PathData {
    PathData::new(vec![
        PathSegment::MoveTo { x: x0, y: y0 },
        PathSegment::LineTo { x: x1, y: y0 },
        PathSegment::LineTo { x: x1, y: y1 },
        PathSegment::LineTo { x: x0, y: y1 },
        PathSegment::Close,
    ])
}

/// `path` with `t` applied to its points (an affine map takes a Bézier
/// to the Bézier of its mapped control points).
fn path_data(path: &usvg::tiny_skia_path::Path, t: &Transform) -> PathData {
    use usvg::tiny_skia_path::PathSegment as S;
    let p = |q: usvg::tiny_skia_path::Point| t.apply(q.x, q.y);
    let segments = path
        .segments()
        .map(|seg| match seg {
            S::MoveTo(a) => {
                let (x, y) = p(a);
                PathSegment::MoveTo { x, y }
            }
            S::LineTo(a) => {
                let (x, y) = p(a);
                PathSegment::LineTo { x, y }
            }
            S::QuadTo(c, a) => {
                let ((cx, cy), (x, y)) = (p(c), p(a));
                PathSegment::QuadTo { cx, cy, x, y }
            }
            S::CubicTo(c1, c2, a) => {
                let ((cx1, cy1), (cx2, cy2), (x, y)) = (p(c1), p(c2), p(a));
                PathSegment::CubicTo {
                    cx1,
                    cy1,
                    cx2,
                    cy2,
                    x,
                    y,
                }
            }
            S::Close => PathSegment::Close,
        })
        .collect();
    PathData::new(segments)
}

/// sRGB-encoded `c` (0..255) in linear light, as the list composites.
fn linear(c: u8) -> f32 {
    let c = c as f32 / 255.0;
    if c <= 0.04045 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
}

fn color(c: usvg::Color, alpha: f32) -> Color {
    Color::rgba(linear(c.red), linear(c.green), linear(c.blue), alpha)
}

fn blend(mode: usvg::BlendMode) -> BlendMode {
    match mode {
        usvg::BlendMode::Normal => BlendMode::Normal,
        usvg::BlendMode::Multiply => BlendMode::Multiply,
        usvg::BlendMode::Screen => BlendMode::Screen,
        usvg::BlendMode::Overlay => BlendMode::Overlay,
        usvg::BlendMode::Darken => BlendMode::Darken,
        usvg::BlendMode::Lighten => BlendMode::Lighten,
        usvg::BlendMode::ColorDodge => BlendMode::ColorDodge,
        usvg::BlendMode::ColorBurn => BlendMode::ColorBurn,
        usvg::BlendMode::HardLight => BlendMode::HardLight,
        usvg::BlendMode::SoftLight => BlendMode::SoftLight,
        usvg::BlendMode::Difference => BlendMode::Difference,
        usvg::BlendMode::Exclusion => BlendMode::Exclusion,
        usvg::BlendMode::Hue => BlendMode::Hue,
        usvg::BlendMode::Saturation => BlendMode::Saturation,
        usvg::BlendMode::Color => BlendMode::Color,
        usvg::BlendMode::Luminosity => BlendMode::Luminosity,
    }
}

struct Walk {
    ops: Vec<Op>,
    /// The tree uses something the list cannot say.
    failed: bool,
    /// Per entered group: the clips it pushed and whether it composites.
    open: Vec<(usize, bool)>,
}

/// The vector lane's half of the shared walk (`paged_svg::walk`, engine
/// ADR 1031). Nodes carry their own absolute transforms here, so the walk
/// composes nothing (`Ts = ()`); the first construct the list cannot say
/// fails the whole art, which the raster lane then draws.
impl paged_svg::walk::Visitor for Walk {
    type Ts = ();

    fn compose(&self, _: (), _: usvg::Transform) {}

    fn enter_group(&mut self, g: &usvg::Group, _: ()) -> paged_svg::walk::Enter {
        if self.failed {
            return paged_svg::walk::Enter::Skip;
        }
        match self.begin_group(g) {
            Some(frame) => {
                self.open.push(frame);
                paged_svg::walk::Enter::Children
            }
            None => {
                self.failed = true;
                paged_svg::walk::Enter::Skip
            }
        }
    }

    fn leave_group(&mut self, _: &usvg::Group, _: ()) {
        let Some((clips, composite)) = self.open.pop() else {
            return;
        };
        if composite {
            self.ops.push(Op::EndGroup);
        }
        for _ in 0..clips {
            self.ops.push(Op::PopClip);
        }
    }

    fn path(&mut self, p: &usvg::Path, _: ()) {
        if !self.failed && self.path(p).is_none() {
            self.failed = true;
        }
    }

    // A nested SVG would need its own canvas; a raster inside an SVG is
    // not drawn on the raster lane either.
    fn nested_svg(&mut self, _: &usvg::Image, _: ()) -> paged_svg::walk::Enter {
        self.failed = true;
        paged_svg::walk::Enter::Skip
    }

    // usvg is built without fonts (ADR 189): it keeps no text to draw, as
    // on the raster lane.
    fn text(&mut self, _: &usvg::Text, _: ()) -> paged_svg::walk::Enter {
        paged_svg::walk::Enter::Skip
    }
}

impl Walk {
    /// Open `g`: its clips pushed and its composite begun. `None` for what
    /// the list cannot say (a filter, a mask, an unsayable clip).
    fn begin_group(&mut self, g: &usvg::Group) -> Option<(usize, bool)> {
        if !g.filters().is_empty() || g.mask().is_some() {
            return None;
        }
        let mut clips = 0;
        if let Some(clip) = g.clip_path() {
            clips = self.clip(clip, transform(g.abs_transform()))?;
        }
        let composite =
            g.opacity().get() < 1.0 || g.blend_mode() != usvg::BlendMode::Normal || g.isolate();
        if composite {
            let r = g.abs_layer_bounding_box();
            self.ops.push(Op::BeginGroup {
                bounds: (r.left(), r.top(), r.right(), r.bottom()),
                blend: blend(g.blend_mode()),
                opacity: g.opacity().get(),
            });
        }
        Some((clips, composite))
    }

    /// Push `clip` (and the clip paths it is clipped by), `base` mapping
    /// the clipped element's space into the canvas. Returns how many clips
    /// were pushed.
    fn clip(&mut self, clip: &usvg::ClipPath, base: Transform) -> Option<usize> {
        let ts = base.compose(&transform(clip.transform()));
        let mut shapes = Vec::new();
        clip_shapes(clip.root(), ts, &mut shapes)?;
        let path = match shapes.len() {
            // An empty clip path hides everything, which the raster
            // lane draws.
            0 => return None,
            1 => shapes.pop()?,
            // The union of single contours, each turned the same way:
            // one path has one rule, so an even-odd shape among several
            // is first turned into its non-zero equivalent.
            _ => {
                let mut segments = Vec::new();
                for shape in shapes {
                    let shape = match shape.fill_rule {
                        FillRule::EvenOdd => even_odd_as_non_zero(&shape)?,
                        FillRule::NonZero => shape,
                    };
                    let contours = contours(&shape.segments);
                    if contours.len() != 1 {
                        return None;
                    }
                    let c = contours[0];
                    if signed_area(&flatten(c)) < 0.0 {
                        segments.extend(reversed(c));
                    } else {
                        segments.extend_from_slice(c);
                    }
                }
                PathData::new(segments)
            }
        };
        self.ops.push(Op::PushClip(path));
        let mut pushed = 1;
        if let Some(inner) = clip.clip_path() {
            pushed += self.clip(inner, ts)?;
        }
        Some(pushed)
    }

    fn path(&mut self, p: &usvg::Path) -> Option<()> {
        if !p.is_visible() {
            return Some(());
        }
        let ts = transform(p.abs_transform());
        let local = path_data(p.data(), &Transform::IDENTITY);
        let fill = match p.fill() {
            Some(f) => {
                let b = p.data().bounds();
                if b.width() == 0.0 || b.height() == 0.0 {
                    None
                } else {
                    Some((self.paint(f.paint(), f.opacity().get())?, f.rule()))
                }
            }
            None => None,
        };
        let stroke = match p.stroke() {
            Some(s) => {
                let paint = self.paint(s.paint(), s.opacity().get())?;
                // The export strokes a radial ramp over its page box, the
                // rasterizers by the path's transform: no one placement
                // satisfies both.
                if matches!(paint, ArtPaint::Radial { .. }) {
                    return None;
                }
                Some((paint, stroke(s)?))
            }
            None => None,
        };
        // Fill and stroke share one path; the path carries the fill's
        // rule, which a stroke ignores.
        let path = match &fill {
            Some((_, usvg::FillRule::EvenOdd)) => local.with_fill_rule(FillRule::EvenOdd),
            _ => local,
        };
        self.ops.push(Op::Shape(Box::new(Shape {
            path,
            ts,
            fill: fill.map(|(paint, _)| paint),
            stroke,
            stroke_first: p.paint_order() == usvg::PaintOrder::StrokeAndFill,
        })));
        Some(())
    }

    fn paint(&mut self, paint: &usvg::Paint, opacity: f32) -> Option<ArtPaint> {
        let stops = |stops: &[usvg::Stop]| -> Option<Vec<GradientStop>> {
            // The list interpolates premultiplied; SVG straight. They
            // agree while every stop has the same opacity.
            let first = stops.first()?.opacity().get();
            if stops
                .iter()
                .any(|s| (s.opacity().get() - first).abs() > 1e-4)
            {
                return None;
            }
            Some(
                stops
                    .iter()
                    .map(|s| GradientStop {
                        offset: s.offset().get(),
                        color: color(s.color(), s.opacity().get() * opacity),
                    })
                    .collect(),
            )
        };
        match paint {
            usvg::Paint::Color(c) => Some(ArtPaint::Solid(color(*c, opacity))),
            usvg::Paint::LinearGradient(g) => {
                if g.spread_method() != usvg::SpreadMethod::Pad {
                    return None;
                }
                Some(ArtPaint::Linear {
                    start: (g.x1(), g.y1()),
                    end: (g.x2(), g.y2()),
                    space: transform(g.transform()),
                    stops: stops(g.stops())?,
                })
            }
            usvg::Paint::RadialGradient(g) => {
                let focal = (g.fx() - g.cx()).abs() > 1e-4
                    || (g.fy() - g.cy()).abs() > 1e-4
                    || g.fr().get() > 1e-4;
                if focal || g.spread_method() != usvg::SpreadMethod::Pad {
                    return None;
                }
                Some(ArtPaint::Radial {
                    center: (g.cx(), g.cy()),
                    radius: g.r().get(),
                    space: transform(g.transform()),
                    stops: stops(g.stops())?,
                })
            }
            usvg::Paint::Pattern(_) => None,
        }
    }
}

/// The list's stroke for `s`, in the path's own units (the emitter
/// scales it into page points).
fn stroke(s: &usvg::Stroke) -> Option<Stroke> {
    let mut out = Stroke::new(s.width().get());
    out.cap = match s.linecap() {
        usvg::LineCap::Butt => LineCap::Butt,
        usvg::LineCap::Round => LineCap::Round,
        usvg::LineCap::Square => LineCap::Square,
    };
    out.join = match s.linejoin() {
        usvg::LineJoin::Miter | usvg::LineJoin::MiterClip => LineJoin::Miter,
        usvg::LineJoin::Round => LineJoin::Round,
        usvg::LineJoin::Bevel => LineJoin::Bevel,
    };
    out.miter_limit = s.miterlimit().get();
    if let Some(dashes) = s.dasharray() {
        // The list has no dash offset.
        let period: f32 = dashes.iter().sum();
        if period > 0.0 && (s.dashoffset() % period).abs() > 1e-4 {
            return None;
        }
        let mut pattern = dashes.to_vec();
        if pattern.len() % 2 == 1 {
            pattern.extend_from_slice(dashes);
        }
        if pattern.len() > 8 {
            return None;
        }
        out.dash = DashPattern::from_slice(&pattern);
    }
    Some(out)
}

/// A clip path's shapes, each in canvas space and carrying its fill rule
/// (the shared walk's, `paged_svg::walk::clip_nodes`). `None` for what the
/// list cannot clip by: a nested clip path on one of its children.
fn clip_shapes(group: &usvg::Group, ts: Transform, out: &mut Vec<PathData>) -> Option<()> {
    let mut nested = false;
    let compose = |t: Transform, local: usvg::Transform| t.compose(&transform(local));
    paged_svg::walk::clip_nodes(group, ts, &compose, &mut |node| {
        match node {
            paged_svg::walk::ClipNode::Shape { path, ts, rule } => {
                let path = path_data(path.data(), &ts);
                out.push(match rule {
                    usvg::FillRule::EvenOdd => path.with_fill_rule(FillRule::EvenOdd),
                    usvg::FillRule::NonZero => path,
                });
            }
            paged_svg::walk::ClipNode::ClippedGroup { .. } => nested = true,
        }
        paged_svg::walk::Enter::Skip
    });
    (!nested).then_some(())
}

// ── Even-odd as non-zero ─────────────────────────────────────────────
//
// A path fills by its own rule, but a clip of several shapes is one path
// with one rule: each even-odd shape in it is turned into its non-zero
// equivalent first. Contours that neither cross themselves nor each other
// fill the same area under both rules once every contour turns the way
// its nesting depth says: even depths one way, odd depths the other, so
// each hole cancels the area around it. Contours that cross are left to
// the raster lane.

/// The contours of `segments`, each starting at its `MoveTo`.
fn contours(segments: &[PathSegment]) -> Vec<&[PathSegment]> {
    let mut out = Vec::new();
    let mut start = None;
    for (i, s) in segments.iter().enumerate() {
        if matches!(s, PathSegment::MoveTo { .. }) {
            if let Some(st) = start {
                out.push(&segments[st..i]);
            }
            start = Some(i);
        }
    }
    if let Some(st) = start {
        out.push(&segments[st..]);
    }
    out
}

/// The contour's points, its curves flattened into eight chords each.
fn flatten(contour: &[PathSegment]) -> Vec<(f32, f32)> {
    const STEPS: usize = 8;
    let mut pts: Vec<(f32, f32)> = Vec::new();
    let mut cur = (0.0, 0.0);
    for s in contour {
        match *s {
            PathSegment::MoveTo { x, y } | PathSegment::LineTo { x, y } => {
                cur = (x, y);
                pts.push(cur);
            }
            PathSegment::QuadTo { cx, cy, x, y } => {
                for i in 1..=STEPS {
                    let t = i as f32 / STEPS as f32;
                    let u = 1.0 - t;
                    pts.push((
                        u * u * cur.0 + 2.0 * u * t * cx + t * t * x,
                        u * u * cur.1 + 2.0 * u * t * cy + t * t * y,
                    ));
                }
                cur = (x, y);
            }
            PathSegment::CubicTo {
                cx1,
                cy1,
                cx2,
                cy2,
                x,
                y,
            } => {
                for i in 1..=STEPS {
                    let t = i as f32 / STEPS as f32;
                    let u = 1.0 - t;
                    let (a, b, c, d) = (u * u * u, 3.0 * u * u * t, 3.0 * u * t * t, t * t * t);
                    pts.push((
                        a * cur.0 + b * cx1 + c * cx2 + d * x,
                        a * cur.1 + b * cy1 + c * cy2 + d * y,
                    ));
                }
                cur = (x, y);
            }
            PathSegment::Close => {}
        }
    }
    // A closing point equal to the first is the same vertex.
    if pts.len() > 1 && pts.first() == pts.last() {
        pts.pop();
    }
    pts
}

/// `contour` traced the other way round, closed.
fn reversed(contour: &[PathSegment]) -> Vec<PathSegment> {
    let Some(&PathSegment::MoveTo { x: x0, y: y0 }) = contour.first() else {
        return contour.to_vec();
    };
    // Each drawing segment with the point it starts from.
    let mut segs: Vec<(PathSegment, (f32, f32))> = Vec::new();
    let mut cur = (x0, y0);
    for s in &contour[1..] {
        let end = match *s {
            PathSegment::LineTo { x, y }
            | PathSegment::QuadTo { x, y, .. }
            | PathSegment::CubicTo { x, y, .. } => (x, y),
            PathSegment::MoveTo { .. } | PathSegment::Close => continue,
        };
        segs.push((*s, cur));
        cur = end;
    }
    if cur != (x0, y0) {
        segs.push((PathSegment::LineTo { x: x0, y: y0 }, cur));
    }
    let mut out = vec![PathSegment::MoveTo { x: x0, y: y0 }];
    for (s, (fx, fy)) in segs.into_iter().rev() {
        out.push(match s {
            PathSegment::QuadTo { cx, cy, .. } => PathSegment::QuadTo {
                cx,
                cy,
                x: fx,
                y: fy,
            },
            PathSegment::CubicTo {
                cx1, cy1, cx2, cy2, ..
            } => PathSegment::CubicTo {
                cx1: cx2,
                cy1: cy2,
                cx2: cx1,
                cy2: cy1,
                x: fx,
                y: fy,
            },
            _ => PathSegment::LineTo { x: fx, y: fy },
        });
    }
    out.push(PathSegment::Close);
    out
}

/// `path` (filled even-odd) as a path the non-zero rule fills the same,
/// or `None` when its contours cross.
fn even_odd_as_non_zero(path: &PathData) -> Option<PathData> {
    let contours = contours(&path.segments);
    let polys: Vec<Vec<(f32, f32)>> = contours.iter().map(|c| flatten(c)).collect();
    let turns = paged_model::winding::non_zero_turns(&polys)?;
    let mut segments = Vec::new();
    for ((c, pts), turn) in contours.iter().zip(&polys).zip(turns) {
        if pts.len() < 3 || signed_area(pts) == 0.0 {
            continue;
        }
        if turn {
            segments.extend(reversed(c));
        } else {
            segments.extend_from_slice(c);
        }
    }
    Some(PathData::new(segments))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn square(x: f32, y: f32, s: f32, clockwise: bool) -> Vec<PathSegment> {
        let mut p = rect_path(x, y, x + s, y + s).segments;
        if !clockwise {
            p = reversed(&p);
        }
        p
    }

    #[test]
    fn nested_contours_alternate_their_turn() {
        // Both squares clockwise: non-zero would fill the hole.
        let mut segments = square(0.0, 0.0, 10.0, true);
        segments.extend(square(3.0, 3.0, 4.0, true));
        let out = even_odd_as_non_zero(&PathData::new(segments)).unwrap();
        let cs = contours(&out.segments);
        assert_eq!(cs.len(), 2);
        let a0 = signed_area(&flatten(cs[0]));
        let a1 = signed_area(&flatten(cs[1]));
        assert!(a0 > 0.0 && a1 < 0.0, "outer {a0}, hole {a1}");
    }

    #[test]
    fn crossing_contours_are_refused() {
        let mut segments = square(0.0, 0.0, 10.0, true);
        segments.extend(square(5.0, 5.0, 10.0, true));
        assert!(even_odd_as_non_zero(&PathData::new(segments)).is_none());
    }

    #[test]
    fn what_the_list_cannot_say_stays_raster() {
        let filtered = br#"<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20">
            <filter id="b"><feGaussianBlur stdDeviation="2"/></filter>
            <rect width="10" height="10" fill="red" filter="url(#b)"/></svg>"#;
        assert!(prepare(filtered).is_none());
        let reflect = br#"<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20">
            <linearGradient id="g" spreadMethod="reflect" x2="0.3"><stop stop-color="red"/>
            <stop offset="1" stop-color="blue"/></linearGradient>
            <rect width="10" height="10" fill="url(#g)"/></svg>"#;
        assert!(prepare(reflect).is_none());
        let plain = br#"<svg xmlns="http://www.w3.org/2000/svg" width="20.5" height="20">
            <rect width="10" height="10" fill="red"/></svg>"#;
        let art = prepare(plain).unwrap();
        assert_eq!((art.width, art.height), (21.0, 20.0));
        assert!(art.follows(&Transform::scale(2.0, 1.0)));
    }

    #[test]
    fn an_uneven_placement_of_a_stroke_draws_the_raster() {
        let stroked = br#"<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20">
            <rect x="2" y="2" width="10" height="10" fill="none" stroke="red"/></svg>"#;
        let art = prepare(stroked).unwrap();
        let mut list = DisplayList::default();
        draw(&art, Transform::scale(2.0, 1.0), &mut list);
        assert!(matches!(list.commands[..], [DisplayCommand::Image { .. }]));
        let mut list = DisplayList::default();
        draw(&art, Transform::scale(2.0, 2.0), &mut list);
        let width = list.commands.iter().find_map(|c| match c {
            DisplayCommand::StrokePath { stroke, .. } => Some(stroke.width),
            _ => None,
        });
        assert_eq!(width, Some(2.0));
    }
}
