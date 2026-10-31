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

//! The ordered effect stack of a frame's object target (engine ADR 1008).
//!
//! A frame without a stored stack renders as it always did: its InDesign
//! effects in InDesign's fixed composite. A frame WITH one renders its
//! body (fill, picture, stroke, and — through the text slot — its text)
//! as the base run, then applies the stack to that run entry by entry, in
//! the stack's order, so each entry acts on what the entries before it
//! produced:
//!
//! - **behind** (drop shadow, outer glow, reflection) is drawn under the
//!   run;
//! - **over** (inner shadow, inner glow, bevel, satin, outline stroke,
//!   the overlays) is drawn over it;
//! - **mask** (the three feathers, soft edge) fades the run by its
//!   outline;
//! - **filter** (Gaussian blur, noise, colour adjustment) wraps the run in
//!   an effect layer.
//!
//! When the stack's InDesign entries come first and in InDesign's order,
//! the body keeps drawing them itself (byte-identical to a frame without a
//! stack); otherwise every entry, InDesign's included, is drawn here, in
//! the stack's order.
//!
//! Behind and over effects take the frame's OUTLINE, not the pixels the
//! run painted so far: a drop shadow after a blur is the outline's crisp
//! shadow under a blurred object.

use paged_compose::{
    BlendMode, Color, DisplayCommand, Feather, FeatherCornerType, GradientFeather,
    GradientFeatherKind, GradientFeatherStop, LayerEffect, LineCap, LineJoin, LinearGradient,
    Paint, PathData, PathId, PathSegment, Rect, Stroke, Transform,
};
use paged_model::effect_stack::{Effect, EffectEntry, IndesignEffect, StrokePosition};
use paged_model::{DropShadowSetting, FrameEffects, Graphic};

use super::ResolvedFrame;
use crate::pipeline::{blend_mode_from_idml, BuiltPage, ColorCtx};

/// How a stored stack is drawn.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum StackMode {
    /// The body draws the InDesign effects in InDesign's composite; the
    /// stack applies only its own effects, after them.
    IndesignFirst,
    /// The body draws no effects; the stack draws all of them in order.
    Ordered,
}

/// Whether `stack` changes how a frame is drawn, and how. `None`: draw
/// the frame as if it had no stack (a stack of InDesign effects only, in
/// InDesign's order, with disabled ones parked — which the slots already
/// say).
pub(crate) fn stack_mode(stack: &[EffectEntry]) -> Option<StackMode> {
    if stack.is_empty() {
        return None;
    }
    let mut seen_own = false;
    let mut last_rank = None;
    let mut indesign_first = true;
    let mut has_own = false;
    for e in stack.iter().filter(|e| e.enabled) {
        match e.effect.indesign() {
            Some(k) => {
                if seen_own || last_rank.is_some_and(|r| r > k.rank()) {
                    indesign_first = false;
                }
                last_rank = Some(k.rank());
            }
            None => {
                seen_own = true;
                has_own = true;
            }
        }
    }
    match (indesign_first, has_own) {
        (true, false) => None,
        (true, true) => Some(StackMode::IndesignFirst),
        (false, _) => Some(StackMode::Ordered),
    }
}

/// What the stack draws on: the frame's outline and its visible outline
/// (grown to the stroke's outer edge), both in the frame's inner
/// coordinates under `outer`.
pub(crate) struct StackGeometry {
    pub outline: PathId,
    pub grown: PathId,
    pub outer: Transform,
    /// The visible outline's bounds in inner coordinates.
    pub bbox: Rect,
    pub stroke_outset: f32,
}

impl StackGeometry {
    pub(crate) fn new(
        page: &mut BuiltPage,
        frame: &ResolvedFrame<'_>,
        outer: Transform,
    ) -> Option<Self> {
        let (own, grown) = super::drop_shadow::stack_outlines(frame)?;
        let bbox = path_bbox(&grown)?;
        let outline = page.list.paths.push_anon(own);
        let grown = page.list.paths.push_anon(grown);
        Some(Self {
            outline,
            grown,
            outer,
            bbox,
            stroke_outset: frame.stroke_outset_pt(),
        })
    }

    /// The visible outline's bounds on the page.
    fn page_bbox(&self) -> Rect {
        rect_in_page(self.bbox, self.outer)
    }
}

fn path_bbox(path: &PathData) -> Option<Rect> {
    let (mut x0, mut y0, mut x1, mut y1) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
    let mut add = |x: f32, y: f32| {
        x0 = x0.min(x);
        y0 = y0.min(y);
        x1 = x1.max(x);
        y1 = y1.max(y);
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
    (x1 >= x0 && y1 >= y0).then_some(Rect {
        x: x0,
        y: y0,
        w: x1 - x0,
        h: y1 - y0,
    })
}

fn rect_in_page(r: Rect, t: Transform) -> Rect {
    let pts = [
        t.apply(r.x, r.y),
        t.apply(r.x + r.w, r.y),
        t.apply(r.x, r.y + r.h),
        t.apply(r.x + r.w, r.y + r.h),
    ];
    let x0 = pts.iter().map(|p| p.0).fold(f32::MAX, f32::min);
    let y0 = pts.iter().map(|p| p.1).fold(f32::MAX, f32::min);
    let x1 = pts.iter().map(|p| p.0).fold(f32::MIN, f32::max);
    let y1 = pts.iter().map(|p| p.1).fold(f32::MIN, f32::max);
    Rect {
        x: x0,
        y: y0,
        w: x1 - x0,
        h: y1 - y0,
    }
}

fn rect_path(r: Rect) -> PathData {
    PathData::new(vec![
        PathSegment::MoveTo { x: r.x, y: r.y },
        PathSegment::LineTo {
            x: r.x + r.w,
            y: r.y,
        },
        PathSegment::LineTo {
            x: r.x + r.w,
            y: r.y + r.h,
        },
        PathSegment::LineTo {
            x: r.x,
            y: r.y + r.h,
        },
        PathSegment::Close,
    ])
}

fn pad(r: Rect, d: f32) -> Rect {
    Rect {
        x: r.x - d,
        y: r.y - d,
        w: r.w + 2.0 * d,
        h: r.h + 2.0 * d,
    }
}

/// The frame's InDesign effects, read from the ORIGINAL frame (the body
/// drew a copy with them stripped in [`StackMode::Ordered`]).
pub(crate) struct IndesignSource<'a> {
    pub frame: &'a ResolvedFrame<'a>,
    pub effects: Option<&'a FrameEffects>,
    pub drop_shadow: Option<&'a DropShadowSetting>,
}

/// Where the body's run sits in the command list: it starts at `lo`,
/// the body's own commands end at `body_end` (where the frame's text
/// goes) and the stack's appended commands end at `hi`.
struct Run {
    lo: usize,
    body_end: usize,
    hi: usize,
    front: usize,
}

impl Run {
    fn put(page: &mut BuiltPage, at: usize, cmds: Vec<DisplayCommand>) -> usize {
        let n = cmds.len();
        for (k, c) in cmds.into_iter().enumerate() {
            page.list.insert_command(at + k, c);
        }
        n
    }

    /// Insert under everything the run paints.
    fn front(&mut self, page: &mut BuiltPage, cmds: Vec<DisplayCommand>) {
        let n = Self::put(page, self.lo, cmds);
        self.body_end += n;
        self.hi += n;
        self.front += n;
    }

    /// Append over everything the run paints (after the body's text).
    fn back(&mut self, page: &mut BuiltPage, cmds: Vec<DisplayCommand>) {
        let n = Self::put(page, self.hi, cmds);
        self.hi += n;
    }
}

/// Run `f` and take back the commands it pushed.
fn capture(page: &mut BuiltPage, f: impl FnOnce(&mut BuiltPage)) -> Vec<DisplayCommand> {
    let at = page.list.commands.len();
    f(page);
    page.list.commands.split_off(at)
}

/// Wrap `cmds` in an effect layer carrying the entry's blend mode and
/// opacity, when it has either.
fn with_entry_group(
    e: &EffectEntry,
    bounds: Rect,
    cmds: Vec<DisplayCommand>,
) -> Vec<DisplayCommand> {
    let blend = blend_mode_from_idml(e.blend_mode.as_deref());
    let opacity = e.opacity();
    if cmds.is_empty() || (blend == BlendMode::Normal && opacity >= 1.0) {
        return cmds;
    }
    let mut out = Vec::with_capacity(cmds.len() + 2);
    out.push(DisplayCommand::PushLayer {
        bounds,
        effect: LayerEffect::None,
        blend_mode: blend,
        opacity,
        transform: Transform::IDENTITY,
    });
    out.extend(cmds);
    out.push(DisplayCommand::PopLayer(Transform::IDENTITY));
    out
}

/// Apply `stack` to the run the frame's body emitted from `run_start` to
/// the end of the list. Returns the text slot's new position when the
/// body gave one (`slot`), or — when the stack wrapped the run — the
/// position the text must go to so the stack applies to it too.
#[allow(clippy::too_many_arguments)]
pub(crate) fn apply(
    page: &mut BuiltPage,
    run_start: usize,
    slot: Option<usize>,
    stack: &[EffectEntry],
    mode: StackMode,
    geom: &StackGeometry,
    source: &IndesignSource<'_>,
    palette: &Graphic,
    color_ctx: ColorCtx<'_>,
) -> Option<usize> {
    let end = page.list.commands.len();
    // Inside the object's own group when the body opened one around the
    // whole run: the stack composites inside the object's opacity and
    // blend mode, as InDesign's effects do.
    let (lo, hi) = match page.list.commands.get(run_start) {
        Some(DisplayCommand::BeginBlendGroup { .. })
            if matches!(
                page.list.commands.last(),
                Some(DisplayCommand::EndBlendGroup(_))
            ) && group_end(&page.list.commands, run_start) == Some(end - 1) =>
        {
            (run_start + 1, end - 1)
        }
        _ => (run_start, end),
    };
    let mut run = Run {
        lo,
        body_end: hi,
        hi,
        front: 0,
    };
    for e in stack {
        if !e.enabled {
            continue;
        }
        match &e.effect {
            Effect::GaussianBlur(p) => {
                wrap_layer(
                    page,
                    &mut run,
                    e,
                    geom,
                    LayerEffect::GaussianBlur {
                        sigma_pt: p.radius_pt.max(0.0),
                    },
                );
            }
            Effect::Noise(p) => {
                wrap_layer(
                    page,
                    &mut run,
                    e,
                    geom,
                    LayerEffect::Noise {
                        amount: (p.amount_pct / 100.0).clamp(0.0, 1.0),
                        monochromatic: p.monochromatic,
                    },
                );
            }
            Effect::ColorAdjust(p) => {
                wrap_layer(
                    page,
                    &mut run,
                    e,
                    geom,
                    LayerEffect::ColorAdjust {
                        brightness: p.brightness / 100.0,
                        contrast: p.contrast / 100.0,
                        saturation: p.saturation / 100.0,
                        hue_deg: p.hue_deg,
                    },
                );
            }
            Effect::SoftEdge(p) => {
                let feather = Feather {
                    width: p.size_pt.max(0.0),
                    corner_type: FeatherCornerType::Rounded,
                    noise: 0.0,
                    choke: 0.0,
                };
                let pid = salted(page, geom.grown);
                let cmds = vec![DisplayCommand::Feather {
                    path_id: pid,
                    transform: geom.outer,
                    params: feather,
                }];
                mask_run(page, &mut run, pid, geom.outer, cmds);
            }
            Effect::OutlineStroke(p) => {
                let cmds = outline_stroke(page, geom, p, palette, color_ctx);
                let bounds = pad(geom.page_bbox(), p.size_pt.max(0.0) + 1.0);
                let cmds = with_entry_group(e, bounds, cmds);
                run.back(page, cmds);
            }
            Effect::ColorOverlay(p) => {
                let paint = p
                    .color
                    .as_deref()
                    .and_then(|id| {
                        crate::pipeline::color_id_to_paint_with_list(
                            id,
                            palette,
                            color_ctx,
                            &mut page.list,
                        )
                    })
                    .unwrap_or(Paint::Solid(Color::rgba(0.0, 0.0, 0.0, 1.0)));
                let cmds = overlay(geom, paint);
                let cmds = with_entry_group(e, geom.page_bbox(), cmds);
                run.back(page, cmds);
            }
            Effect::GradientOverlay(p) => {
                let paint = gradient_overlay_paint(page, geom, p, palette, color_ctx);
                let cmds = overlay(geom, paint);
                let cmds = with_entry_group(e, geom.page_bbox(), cmds);
                run.back(page, cmds);
            }
            Effect::Reflection(p) => {
                let cmds = reflection(page, &run, geom, p);
                let bounds = geom.page_bbox();
                let bounds = Rect {
                    h: bounds.h * 2.0 + p.distance_pt.max(0.0) + 3.0 * p.blur_pt.max(0.0),
                    ..pad(bounds, 3.0 * p.blur_pt.max(0.0) + 1.0)
                };
                let cmds = with_entry_group(e, bounds, cmds);
                run.front(page, cmds);
            }
            _ if mode == StackMode::IndesignFirst => {}
            other => {
                if let Some(kind) = other.indesign() {
                    indesign_entry(page, &mut run, kind, geom, source, palette, color_ctx);
                }
            }
        }
    }
    // The frame's text belongs at the body's end, so the stack applies to
    // it as well: the body's own slot, moved by what went in front, or —
    // when the body gave none — its end, once the stack added anything.
    match slot {
        Some(s) => Some(s + if s >= lo { run.front } else { 0 }),
        None if run.hi > run.body_end || run.front > 0 => Some(run.body_end),
        None => None,
    }
}

fn group_end(cmds: &[DisplayCommand], start: usize) -> Option<usize> {
    let mut depth = 0i32;
    for (i, c) in cmds.iter().enumerate().skip(start) {
        match c {
            DisplayCommand::BeginBlendGroup { .. } => depth += 1,
            DisplayCommand::EndBlendGroup(_) => {
                depth -= 1;
                if depth == 0 {
                    return Some(i);
                }
            }
            _ => {}
        }
    }
    None
}

/// A copy of `path` under its own id, so a mask entry's marker pairs with
/// its own feather and no other.
fn salted(page: &mut BuiltPage, path: PathId) -> PathId {
    match page.list.paths.get(path).cloned() {
        Some(p) => page.list.paths.push_anon(p),
        None => path,
    }
}

/// Fade the run by a feather: its marker opens the run, the feather
/// command closes it.
fn mask_run(
    page: &mut BuiltPage,
    run: &mut Run,
    path_id: PathId,
    transform: Transform,
    feathers: Vec<DisplayCommand>,
) {
    run.front(
        page,
        vec![DisplayCommand::BeginFeatheredObject {
            path_id,
            transform,
            content_shaped: false,
        }],
    );
    run.back(page, feathers);
}

/// Wrap the run in an effect layer.
fn wrap_layer(
    page: &mut BuiltPage,
    run: &mut Run,
    e: &EffectEntry,
    geom: &StackGeometry,
    effect: LayerEffect,
) {
    run.front(
        page,
        vec![DisplayCommand::PushLayer {
            // Grown to what the run paints by the build's group fit.
            bounds: geom.page_bbox(),
            effect,
            blend_mode: blend_mode_from_idml(e.blend_mode.as_deref()),
            opacity: e.opacity(),
            transform: Transform::IDENTITY,
        }],
    );
    run.back(page, vec![DisplayCommand::PopLayer(Transform::IDENTITY)]);
}

/// Photoshop's Stroke: the visible outline stroked at twice the size and
/// clipped to the outside or the inside of it, or at the size centred.
fn outline_stroke(
    page: &mut BuiltPage,
    geom: &StackGeometry,
    p: &paged_model::effect_stack::OutlineStrokeParams,
    palette: &Graphic,
    color_ctx: ColorCtx<'_>,
) -> Vec<DisplayCommand> {
    let size = p.size_pt.max(0.0);
    if size <= 0.0 {
        return Vec::new();
    }
    let paint = p
        .color
        .as_deref()
        .and_then(|id| {
            crate::pipeline::color_id_to_paint_with_list(id, palette, color_ctx, &mut page.list)
        })
        .unwrap_or(Paint::Solid(Color::rgba(0.0, 0.0, 0.0, 1.0)));
    let width = match p.position {
        StrokePosition::Center => size,
        _ => size * 2.0,
    };
    let stroke = Stroke {
        width,
        cap: LineCap::Round,
        join: LineJoin::Round,
        miter_limit: 4.0,
        dash: Default::default(),
    };
    let draw = DisplayCommand::StrokePath {
        path_id: geom.grown,
        paint,
        stroke,
        transform: geom.outer,
    };
    let clip = match p.position {
        StrokePosition::Center => None,
        StrokePosition::Inside => Some(geom.grown),
        StrokePosition::Outside => {
            // The outside: a box around the band, minus the outline.
            let mut segments = rect_path(pad(geom.bbox, size * 2.0 + 1.0)).segments;
            if let Some(g) = page.list.paths.get(geom.grown) {
                segments.extend(g.segments.iter().cloned());
            }
            Some(page.list.paths.push_anon(
                PathData::new(segments).with_fill_rule(paged_compose::FillRule::EvenOdd),
            ))
        }
    };
    match clip {
        None => vec![draw],
        Some(path_id) => vec![
            DisplayCommand::PushClip {
                path_id,
                transform: geom.outer,
            },
            draw,
            DisplayCommand::PopClip(Transform::IDENTITY),
        ],
    }
}

/// An overlay: the visible outline's box filled with `paint`, clipped to
/// the outline.
fn overlay(geom: &StackGeometry, paint: Paint) -> Vec<DisplayCommand> {
    vec![
        DisplayCommand::PushClip {
            path_id: geom.grown,
            transform: geom.outer,
        },
        DisplayCommand::FillPath {
            path_id: geom.grown,
            paint,
            transform: geom.outer,
        },
        DisplayCommand::PopClip(Transform::IDENTITY),
    ]
}

/// A gradient overlay's paint: the gradient swatch along the entry's
/// angle across the outline's box, or black to white.
fn gradient_overlay_paint(
    page: &mut BuiltPage,
    geom: &StackGeometry,
    p: &paged_model::effect_stack::GradientOverlayParams,
    palette: &Graphic,
    color_ctx: ColorCtx<'_>,
) -> Paint {
    let angle = p.angle_deg.unwrap_or(0.0);
    // The fill paints the outline path in inner coordinates, so the
    // gradient's unit space is the outline's box: map it there.
    let (sin, cos) = angle.to_radians().sin_cos();
    let (bx, by, bw, bh) = (
        geom.bbox.x,
        geom.bbox.y,
        geom.bbox.w.max(1e-3),
        geom.bbox.h.max(1e-3),
    );
    let (cx, cy) = (bx + bw / 2.0, by + bh / 2.0);
    let half = 0.5 * (bw * cos.abs() + bh * sin.abs());
    let (mut start, mut end) = (
        (cx - cos * half, cy + sin * half),
        (cx + cos * half, cy - sin * half),
    );
    if p.reverse {
        std::mem::swap(&mut start, &mut end);
    }
    let stops = p
        .gradient
        .as_deref()
        .and_then(|id| {
            crate::pipeline::color_id_to_paint_with_list(id, palette, color_ctx, &mut page.list)
        })
        .and_then(|paint| match paint {
            Paint::LinearGradient(id) => page
                .list
                .gradients
                .get(id.0 as usize)
                .map(|g| g.stops.clone()),
            Paint::RadialGradient(id) => page
                .list
                .radial_gradients
                .get(id.0 as usize)
                .map(|g| g.stops.clone()),
            _ => None,
        })
        .unwrap_or_else(|| {
            vec![
                paged_compose::GradientStop {
                    offset: 0.0,
                    color: Color::rgba(0.0, 0.0, 0.0, 1.0),
                },
                paged_compose::GradientStop {
                    offset: 1.0,
                    color: Color::rgba(1.0, 1.0, 1.0, 1.0),
                },
            ]
        });
    // The command's transform maps the path's inner coordinates; a
    // gradient's endpoints are in the path's unit space, which for an
    // inner-coordinate path is the same space.
    let id = page
        .list
        .push_linear_gradient(LinearGradient { start, end, stops });
    Paint::LinearGradient(id)
}

/// PowerPoint's reflection: the run so far, mirrored below the object's
/// visible bottom edge at `distance_pt`, fading from `start_opacity_pct`
/// to `end_opacity_pct` over `size_pct` of its height, blurred by
/// `blur_pt`.
fn reflection(
    page: &mut BuiltPage,
    run: &Run,
    geom: &StackGeometry,
    p: &paged_model::effect_stack::ReflectionParams,
) -> Vec<DisplayCommand> {
    let b = geom.page_bbox();
    if b.h <= 0.0 {
        return Vec::new();
    }
    let bottom = b.y + b.h;
    let gap = p.distance_pt.max(0.0);
    let mirror_y = bottom + gap / 2.0;
    let m = Transform([1.0, 0.0, 0.0, -1.0, 0.0, 2.0 * mirror_y]);
    let mut copy: Vec<DisplayCommand> = page.list.commands[run.lo..run.hi].to_vec();
    for c in copy.iter_mut() {
        match c {
            DisplayCommand::BeginBlendGroup { bounds, .. }
            | DisplayCommand::PushLayer { bounds, .. } => {
                *bounds = Rect {
                    y: 2.0 * mirror_y - (bounds.y + bounds.h),
                    ..*bounds
                };
            }
            _ => {
                let t = c.transform_mut();
                *t = m.compose(t);
            }
        }
    }
    let top = bottom + gap;
    let size = (p.size_pct / 100.0).clamp(0.0, 1.0) * b.h;
    let fade_box = Rect {
        x: b.x - geom.stroke_outset - 1.0,
        y: top,
        w: b.w + 2.0 * geom.stroke_outset + 2.0,
        h: b.h + 1.0,
    };
    let fade = page.list.paths.push_anon(rect_path(fade_box));
    let cx = b.x + b.w / 2.0;
    let params = GradientFeather {
        kind: GradientFeatherKind::Linear,
        start_x: cx,
        start_y: top,
        end_x: cx,
        end_y: top + size.max(1e-3),
        stops: vec![
            GradientFeatherStop {
                location: 0.0,
                alpha: (p.start_opacity_pct / 100.0).clamp(0.0, 1.0),
            },
            GradientFeatherStop {
                location: 1.0,
                alpha: (p.end_opacity_pct / 100.0).clamp(0.0, 1.0),
            },
        ],
        radial_aspect: 1.0,
    };
    let mut out = Vec::with_capacity(copy.len() + 4);
    let blur = p.blur_pt.max(0.0);
    if blur > 0.0 {
        out.push(DisplayCommand::PushLayer {
            bounds: fade_box,
            effect: LayerEffect::GaussianBlur { sigma_pt: blur },
            blend_mode: BlendMode::Normal,
            opacity: 1.0,
            transform: Transform::IDENTITY,
        });
    }
    out.push(DisplayCommand::BeginFeatheredObject {
        path_id: fade,
        transform: Transform::IDENTITY,
        content_shaped: false,
    });
    out.extend(copy);
    out.push(DisplayCommand::GradientFeather {
        path_id: fade,
        transform: Transform::IDENTITY,
        params,
    });
    if blur > 0.0 {
        out.push(DisplayCommand::PopLayer(Transform::IDENTITY));
    }
    out
}

/// One InDesign effect drawn at its place in the stack
/// ([`StackMode::Ordered`]).
#[allow(clippy::too_many_arguments)]
fn indesign_entry(
    page: &mut BuiltPage,
    run: &mut Run,
    kind: IndesignEffect,
    geom: &StackGeometry,
    source: &IndesignSource<'_>,
    palette: &Graphic,
    color_ctx: ColorCtx<'_>,
) {
    let only = |f: &dyn Fn(&FrameEffects, &mut FrameEffects)| -> Option<FrameEffects> {
        let src = source.effects?;
        let mut out = FrameEffects::default();
        f(src, &mut out);
        Some(out)
    };
    match kind {
        IndesignEffect::DropShadow => {
            if source.drop_shadow.is_none() {
                return;
            }
            let frame = source.frame;
            let outer = geom.outer;
            let cmds = capture(page, |page| {
                super::drop_shadow_module(frame, page, palette, color_ctx, None, outer)
            });
            run.front(page, cmds);
        }
        IndesignEffect::OuterGlow => {
            let Some(fx) = only(&|s, o| o.outer_glow = s.outer_glow.clone()) else {
                return;
            };
            let cmds = capture(page, |page| {
                super::emit_effects_pre_fill(
                    page,
                    &fx,
                    geom.outline,
                    geom.outer,
                    palette,
                    color_ctx,
                )
            });
            run.front(page, cmds);
        }
        IndesignEffect::InnerShadow
        | IndesignEffect::InnerGlow
        | IndesignEffect::BevelEmboss
        | IndesignEffect::Satin => {
            let Some(fx) = only(&|s, o| match kind {
                IndesignEffect::InnerShadow => o.inner_shadow = s.inner_shadow.clone(),
                IndesignEffect::InnerGlow => o.inner_glow = s.inner_glow.clone(),
                IndesignEffect::BevelEmboss => o.bevel = s.bevel.clone(),
                _ => o.satin = s.satin.clone(),
            }) else {
                return;
            };
            let cmds = capture(page, |page| {
                super::effects::emit_interior_effects(
                    page,
                    &fx,
                    geom.outline,
                    geom.outer,
                    palette,
                    color_ctx,
                )
            });
            run.back(page, cmds);
        }
        IndesignEffect::Feather
        | IndesignEffect::DirectionalFeather
        | IndesignEffect::GradientFeather => {
            let Some(fx) = only(&|s, o| match kind {
                IndesignEffect::Feather => o.feather = s.feather.clone(),
                IndesignEffect::DirectionalFeather => {
                    o.directional_feather = s.directional_feather.clone()
                }
                _ => o.gradient_feather = s.gradient_feather.clone(),
            }) else {
                return;
            };
            let fpid = salted(page, geom.grown);
            let cmds = capture(page, |page| {
                super::emit_feathers(
                    page,
                    &fx,
                    fpid,
                    geom.outline,
                    geom.outer,
                    None,
                    geom.stroke_outset,
                )
            });
            mask_run(page, run, fpid, geom.outer, cmds);
        }
    }
}
