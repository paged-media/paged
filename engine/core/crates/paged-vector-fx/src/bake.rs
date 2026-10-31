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

//! Page items through their vector effects: the item its effected
//! outline describes.
//!
//! A baked item is the source item with the effected outline as its path
//! (in the item's own space; its transform is untouched), its bounds
//! those of the outline, its vector entries gone from the stack, and its
//! paint moved where the effect says ([`PaintRole`]). The renderer draws
//! the baked item, so the GPU and CPU lanes and PDF export see the
//! effect; IDML export writes it (and keeps the stack in a label); the
//! editor's `expandAppearance` keeps it for good.
//!
//! An oval bakes to a polygon (an effected ellipse is a path). Live
//! corner options are not applied under a vector effect: the outline is
//! the effected path, drawn as it is.

use std::sync::Arc;

use kurbo::{Affine, Point};
use paged_geom::kurbo_kernel::{StrokeCap, StrokeJoin};
use paged_model::effect_stack::{has_vector, is_canonical, EffectEntry};
use paged_model::{
    Bounds, CornerSpec, FrameRef, GraphicLine, Oval, Polygon, Rectangle, Spread, TextFrame,
};

use crate::{apply_group, apply_stack, Context, Effected, PaintRole, Shape, StrokeStyle};

/// The model's "no paint" swatch.
pub const NONE: &str = "Swatch/None";

fn paints(color: Option<&str>) -> bool {
    color.is_some_and(|c| c != NONE && c != "n")
}

fn cap_of(name: Option<&str>) -> StrokeCap {
    match name {
        Some("RoundEndCap") => StrokeCap::Round,
        Some("ProjectingEndCap") => StrokeCap::Square,
        _ => StrokeCap::Butt,
    }
}

fn join_of(name: Option<&str>) -> StrokeJoin {
    match name {
        Some("RoundEndJoin") => StrokeJoin::Round,
        Some("BevelEndJoin") => StrokeJoin::Bevel,
        _ => StrokeJoin::Miter,
    }
}

/// The context of an item with this stroke.
pub fn context(
    stroke_color: Option<&str>,
    weight: Option<f32>,
    cap: Option<&str>,
    join: Option<&str>,
    miter: Option<f32>,
) -> Context {
    let weight = weight.unwrap_or(1.0);
    Context {
        stroke: (paints(stroke_color) && weight > 0.0).then(|| StrokeStyle {
            weight,
            cap: cap_of(cap),
            join: join_of(join),
            miter_limit: miter.unwrap_or(4.0),
        }),
    }
}

fn box_shape(b: Bounds) -> Shape {
    let anchors: Vec<paged_model::PathAnchor> = [
        (b.left, b.top),
        (b.right, b.top),
        (b.right, b.bottom),
        (b.left, b.bottom),
    ]
    .into_iter()
    .map(|p| paged_model::PathAnchor {
        anchor: p,
        left: p,
        right: p,
    })
    .collect();
    Shape::from_anchors(&anchors, &[], &[])
}

fn ellipse_shape(b: Bounds) -> Shape {
    crate::path::convert_to_shape(
        &box_shape(b),
        &paged_model::vector_effect::ConvertToShapeParams {
            shape: paged_model::vector_effect::ShapeKind::Ellipse,
            ..Default::default()
        },
    )
}

/// A path item's source outline: its anchors, or its box without any.
fn path_shape(
    b: Bounds,
    anchors: &[paged_model::PathAnchor],
    starts: &[usize],
    open: &[bool],
) -> Shape {
    if anchors.is_empty() {
        box_shape(b)
    } else {
        Shape::from_anchors(anchors, starts, open)
    }
}

pub fn rectangle_shape(r: &Rectangle) -> Shape {
    path_shape(r.bounds, &r.anchors, &r.subpath_starts, &r.subpath_open)
}
pub fn oval_shape(o: &Oval) -> Shape {
    ellipse_shape(o.bounds)
}
pub fn polygon_shape(p: &Polygon) -> Shape {
    path_shape(p.bounds, &p.anchors, &p.subpath_starts, &p.subpath_open)
}
pub fn text_frame_shape(t: &TextFrame) -> Shape {
    path_shape(t.bounds, &t.anchors, &t.subpath_starts, &t.subpath_open)
}
pub fn graphic_line_shape(l: &GraphicLine) -> Shape {
    if l.anchors.len() >= 2 {
        Shape::from_anchors(&l.anchors, &l.subpath_starts, &l.subpath_open)
    } else {
        let a = (l.bounds.left, l.bounds.top);
        let b = (l.bounds.right, l.bounds.bottom);
        let n = |p| paged_model::PathAnchor {
            anchor: p,
            left: p,
            right: p,
        };
        Shape::from_anchors(&[n(a), n(b)], &[], &[true])
    }
}

pub fn rectangle_effected(r: &Rectangle) -> Option<Arc<Effected>> {
    if !has_vector(&r.effect_stack) {
        return None;
    }
    let ctx = context(
        r.stroke_color.as_deref(),
        r.stroke_weight,
        r.end_cap.as_deref(),
        r.end_join.as_deref(),
        r.miter_limit,
    );
    apply_stack(&rectangle_shape(r), &r.effect_stack, &ctx)
}
pub fn oval_effected(o: &Oval) -> Option<Arc<Effected>> {
    if !has_vector(&o.effect_stack) {
        return None;
    }
    let ctx = context(
        o.stroke_color.as_deref(),
        o.stroke_weight,
        o.end_cap.as_deref(),
        None,
        None,
    );
    apply_stack(&oval_shape(o), &o.effect_stack, &ctx)
}
pub fn polygon_effected(p: &Polygon) -> Option<Arc<Effected>> {
    if !has_vector(&p.effect_stack) {
        return None;
    }
    let ctx = context(
        p.stroke_color.as_deref(),
        p.stroke_weight,
        p.end_cap.as_deref(),
        p.end_join.as_deref(),
        p.miter_limit,
    );
    apply_stack(&polygon_shape(p), &p.effect_stack, &ctx)
}
pub fn text_frame_effected(t: &TextFrame) -> Option<Arc<Effected>> {
    if !has_vector(&t.effect_stack) {
        return None;
    }
    let ctx = context(t.stroke_color.as_deref(), t.stroke_weight, None, None, None);
    apply_stack(&text_frame_shape(t), &t.effect_stack, &ctx)
}

/// The stack with its vector entries taken out, in canonical form.
pub fn without_vector(stack: &[EffectEntry]) -> Vec<EffectEntry> {
    let rest: Vec<EffectEntry> = stack
        .iter()
        .filter(|e| !e.effect.is_vector())
        .cloned()
        .collect();
    if is_canonical(&rest) {
        Vec::new()
    } else {
        rest
    }
}

fn bounds_of(shape: &Shape, fallback: Bounds) -> Bounds {
    shape.bounds().map_or(fallback, |b| Bounds {
        top: b.y0 as f32,
        left: b.x0 as f32,
        bottom: b.y1 as f32,
        right: b.x1 as f32,
    })
}

/// The fields every baked item sets the same way.
macro_rules! bake_paths {
    ($item:ident, $fx:ident) => {{
        let (a, s, o) = $fx.shape.to_anchors();
        $item.bounds = bounds_of(&$fx.shape, $item.bounds);
        $item.anchors = a;
        $item.subpath_starts = s;
        $item.subpath_open = o;
        $item.effect_stack = without_vector(&$item.effect_stack);
        $item.corners = <[CornerSpec; 4]>::default();
        $item.corner_radius = None;
        $item.corner_option = None;
        if $fx.shape.contours.is_empty() {
            // Nothing survived (an inset past every contour's middle).
            $item.fill_color = Some(NONE.to_string());
            $item.stroke_color = Some(NONE.to_string());
        }
        match $fx.paint {
            PaintRole::Keep => {}
            PaintRole::StrokeAsFill => {
                $item.fill_color = $item.stroke_color.clone();
                $item.gradient_fill_angle = $item.gradient_stroke_angle;
                $item.gradient_fill_length = $item.gradient_stroke_length;
                $item.gradient_fill_start = None;
                $item.overprint_fill = $item.overprint_stroke;
                $item.stroke_color = Some(NONE.to_string());
                $item.fill_rule = paged_model::FillRule::NonZero;
            }
            PaintRole::FillOnly => {
                $item.stroke_color = Some(NONE.to_string());
                $item.fill_rule = paged_model::FillRule::NonZero;
            }
        }
    }};
}

/// The rectangle its vector effects describe, `None` when its stack has
/// no vector entry (switched-off entries bake to the source outline).
pub fn bake_rectangle(r: &Rectangle) -> Option<Rectangle> {
    if !has_vector(&r.effect_stack) {
        return None;
    }
    let mut out = r.clone();
    match rectangle_effected(r) {
        Some(fx) => bake_paths!(out, fx),
        // Every vector entry is switched off: the source outline, the
        // entries kept out of the paint stack's way.
        None => out.effect_stack = without_vector(&r.effect_stack),
    }
    Some(out)
}

/// The polygon its vector effects describe, `None` without any.
pub fn bake_polygon(p: &Polygon) -> Option<Polygon> {
    if !has_vector(&p.effect_stack) {
        return None;
    }
    let mut out = p.clone();
    match polygon_effected(p) {
        Some(fx) => bake_paths!(out, fx),
        // Every vector entry is switched off: the source outline, the
        // entries kept out of the paint stack's way.
        None => out.effect_stack = without_vector(&p.effect_stack),
    }
    Some(out)
}

/// The text frame its vector effects describe (its outline; the story
/// still lays out in the source frame), `None` without any.
pub fn bake_text_frame(t: &TextFrame) -> Option<TextFrame> {
    if !has_vector(&t.effect_stack) {
        return None;
    }
    let mut out = t.clone();
    match text_frame_effected(t) {
        Some(fx) => bake_paths!(out, fx),
        // Every vector entry is switched off: the source outline, the
        // entries kept out of the paint stack's way.
        None => out.effect_stack = without_vector(&t.effect_stack),
    }
    Some(out)
}

/// An oval as the polygon of its own outline, every paint and setting
/// kept (a polygon has no stroke-target shadow; it is dropped).
pub fn oval_as_polygon(o: &Oval) -> Polygon {
    let (a, s, op) = oval_shape(o).to_anchors();
    let id = o.self_id.clone().unwrap_or_default();
    Polygon {
        self_id: o.self_id.clone(),
        bounds: o.bounds,
        item_transform: o.item_transform,
        fill_color: o.fill_color.clone(),
        fill_tint: o.fill_tint,
        stroke_color: o.stroke_color.clone(),
        stroke_weight: o.stroke_weight,
        stroke_type: o.stroke_type.clone(),
        stroke_alignment: o.stroke_alignment.clone(),
        stroke_gap_color: o.stroke_gap_color.clone(),
        stroke_gap_tint: o.stroke_gap_tint,
        stroke_dash: o.stroke_dash.clone(),
        applied_object_style: o.applied_object_style.clone(),
        anchors: a,
        subpath_starts: s,
        subpath_open: op,
        fill_rule: o.fill_rule,
        text_wrap: o.text_wrap,
        item_layer: o.item_layer.clone(),
        drop_shadow: o.drop_shadow.clone(),
        effects: o.effects.clone(),
        effect_stack: o.effect_stack.clone(),
        fill_transparency: o.fill_transparency.clone(),
        stroke_transparency: o.stroke_transparency.clone(),
        content_transparency: o.content_transparency.clone(),
        fill_drop_shadow: o.fill_drop_shadow.clone(),
        content_drop_shadow: o.content_drop_shadow.clone(),
        gradient_fill_angle: o.gradient_fill_angle,
        gradient_fill_length: o.gradient_fill_length,
        gradient_fill_start: o.gradient_fill_start,
        gradient_stroke_angle: o.gradient_stroke_angle,
        gradient_stroke_length: o.gradient_stroke_length,
        opacity: o.opacity,
        blend_mode: o.blend_mode.clone(),
        image_link: o.image_link.clone(),
        has_image_element: o.has_image_element,
        has_inline_pdf: o.has_inline_pdf,
        has_inline_eps: o.has_inline_eps,
        placed_pdf: o.placed_pdf.clone(),
        image_item_transform: o.image_item_transform,
        image_bytes: o.image_bytes.clone(),
        image_clip: o.image_clip.clone(),
        overprint_fill: o.overprint_fill,
        overprint_stroke: o.overprint_stroke,
        nonprinting: o.nonprinting,
        visible: o.visible,
        locked: o.locked,
        end_cap: o.end_cap.clone(),
        appearance: o.appearance.clone(),
        ..Polygon::new(id, o.bounds)
    }
}

/// The polygon an oval's vector effects describe, `None` without any.
pub fn bake_oval(o: &Oval) -> Option<Polygon> {
    if !has_vector(&o.effect_stack) {
        return None;
    }
    let mut out = oval_as_polygon(o);
    match oval_effected(o) {
        Some(fx) => bake_paths!(out, fx),
        None => out.effect_stack = without_vector(&o.effect_stack),
    }
    Some(out)
}

fn apply_matrix(m: Option<[f32; 6]>) -> Affine {
    match m {
        Some([a, b, c, d, e, f]) => Affine::new([
            f64::from(a),
            f64::from(b),
            f64::from(c),
            f64::from(d),
            f64::from(e),
            f64::from(f),
        ]),
        None => Affine::IDENTITY,
    }
}

/// A group member's outline in spread space (its own vector effects
/// applied first), and the polygon that carries its paint.
fn member(spread: &Spread, r: FrameRef) -> Option<(Shape, Polygon)> {
    let place = |s: Shape, m: Option<[f32; 6]>| {
        let t = apply_matrix(m);
        s.map(|p: Point| t * p)
    };
    match r {
        FrameRef::Rectangle(i) => {
            let it = spread.rectangles.get(i)?;
            let baked = bake_rectangle(it).unwrap_or_else(|| it.clone());
            let shape = rectangle_shape(&baked);
            let mut poly = Polygon::new(it.self_id.clone().unwrap_or_default(), baked.bounds);
            poly.fill_color = baked.fill_color.clone();
            poly.fill_tint = baked.fill_tint;
            poly.stroke_color = baked.stroke_color.clone();
            poly.stroke_weight = baked.stroke_weight;
            poly.stroke_type = baked.stroke_type.clone();
            poly.stroke_alignment = baked.stroke_alignment.clone();
            poly.end_join = baked.end_join.clone();
            poly.miter_limit = baked.miter_limit;
            poly.gradient_fill_angle = baked.gradient_fill_angle;
            poly.gradient_stroke_angle = baked.gradient_stroke_angle;
            poly.opacity = baked.opacity;
            poly.blend_mode = baked.blend_mode.clone();
            poly.applied_object_style = baked.applied_object_style.clone();
            poly.item_layer = baked.item_layer.clone();
            Some((place(shape, it.item_transform), poly))
        }
        FrameRef::Oval(i) => {
            let it = spread.ovals.get(i)?;
            let poly = bake_oval(it).unwrap_or_else(|| oval_as_polygon(it));
            Some((place(polygon_shape(&poly), it.item_transform), poly))
        }
        FrameRef::Polygon(i) => {
            let it = spread.polygons.get(i)?;
            let poly = bake_polygon(it).unwrap_or_else(|| it.clone());
            Some((place(polygon_shape(&poly), it.item_transform), poly))
        }
        FrameRef::TextFrame(i) => {
            let it = spread.text_frames.get(i)?;
            let baked = bake_text_frame(it).unwrap_or_else(|| it.clone());
            let mut poly = Polygon::new(it.self_id.clone().unwrap_or_default(), baked.bounds);
            poly.fill_color = baked.fill_color.clone();
            poly.fill_tint = baked.fill_tint;
            poly.stroke_color = baked.stroke_color.clone();
            poly.stroke_weight = baked.stroke_weight;
            poly.opacity = baked.opacity;
            poly.blend_mode = baked.blend_mode.clone();
            poly.item_layer = baked.item_layer.clone();
            Some((place(text_frame_shape(&baked), it.item_transform), poly))
        }
        FrameRef::GraphicLine(i) => {
            let it = spread.graphic_lines.get(i)?;
            let mut poly = Polygon::new(it.self_id.clone().unwrap_or_default(), it.bounds);
            poly.fill_color = Some(NONE.to_string());
            poly.stroke_color = it.stroke_color.clone();
            poly.stroke_weight = it.stroke_weight;
            poly.opacity = it.opacity;
            poly.blend_mode = it.blend_mode.clone();
            poly.item_layer = it.item_layer.clone();
            Some((place(graphic_line_shape(it), it.item_transform), poly))
        }
        _ => None,
    }
}

/// The polygon a group's Pathfinder effect describes, in spread space
/// (no item transform), painted as its frontmost member (its backmost
/// for Minus Front); `None` without an enabled Pathfinder entry or
/// without members it can read. Nested groups and other kinds take no
/// part.
pub fn bake_group(spread: &Spread, group: &paged_model::Group) -> Option<Polygon> {
    if !has_vector(&group.effect_stack) {
        return None;
    }
    let members: Vec<(Shape, Polygon)> = group
        .members
        .iter()
        .filter_map(|r| member(spread, *r))
        .collect();
    if members.is_empty() {
        return None;
    }
    let op = group.effect_stack.iter().find_map(|e| match &e.effect {
        paged_model::effect_stack::Effect::Pathfinder(p) if e.enabled => Some(p.op),
        _ => None,
    })?;
    let source = if op == paged_model::vector_effect::PathfinderOp::Subtract {
        &members[0].1
    } else {
        &members[members.len() - 1].1
    };
    let ctx = context(
        source.stroke_color.as_deref(),
        source.stroke_weight,
        source.end_cap.as_deref(),
        source.end_join.as_deref(),
        source.miter_limit,
    );
    let shapes: Vec<Shape> = members.iter().map(|(s, _)| s.clone()).collect();
    let fx = apply_group(&shapes, &group.effect_stack, &ctx)?;
    let mut out = source.clone();
    out.self_id = group.self_id.clone();
    out.item_transform = None;
    out.effect_stack = group.effect_stack.clone();
    bake_paths!(out, fx);
    Some(out)
}

// ---- Stroke styles (engine ADR 10XX) --------------------------------
//
// A stroke style takes the STROKE's place; the item's fill (and picture,
// and appearance) stays on the source outline. A consumer that draws one
// item per outline splits the item in two: its FILL PART (the item, the
// stroke switched off, the stroke styles taken out of its stack — its
// other vector entries still apply) and its STROKE ARTWORK (a polygon of
// the stroke style's outline, filled with the stroke's paint). The
// renderer draws the two as the parts of one appearance (ADR 1043);
// IDML export writes them as two items. [`bake_rectangle`] and its
// siblings bake the stroke part only: on an item that fills, a caller
// that wants both splits first ([`splits`]).

/// Whether an item with this stack, fill and content must be split to
/// draw its stroke style: it has an enabled one, and the source outline
/// paints something besides the stroke (a fill, a picture, an
/// appearance).
pub fn splits(stack: &[EffectEntry], fill_color: Option<&str>, other_content: bool) -> bool {
    paged_model::effect_stack::has_stroke_style(stack) && (paints(fill_color) || other_content)
}

/// The stack without its stroke styles, in canonical form.
pub fn without_stroke_style(stack: &[EffectEntry]) -> Vec<EffectEntry> {
    let rest: Vec<EffectEntry> = stack
        .iter()
        .filter(|e| !e.effect.is_stroke_style())
        .cloned()
        .collect();
    if is_canonical(&rest) {
        Vec::new()
    } else {
        rest
    }
}

fn has_picture(
    link: &Option<String>,
    element: bool,
    pdf: bool,
    eps: bool,
    placed: bool,
    bytes: bool,
) -> bool {
    link.is_some() || element || pdf || eps || placed || bytes
}

/// Whether a rectangle's stroke style needs the split ([`splits`]).
pub fn rectangle_splits(r: &Rectangle) -> bool {
    splits(
        &r.effect_stack,
        r.fill_color.as_deref(),
        !r.appearance.is_empty()
            || !r.text_paths.is_empty()
            || has_picture(
                &r.image_link,
                r.has_image_element,
                r.has_inline_pdf,
                r.has_inline_eps,
                r.placed_pdf.is_some(),
                r.image_bytes.is_some(),
            ),
    )
}
/// Whether an oval's stroke style needs the split.
pub fn oval_splits(o: &Oval) -> bool {
    splits(
        &o.effect_stack,
        o.fill_color.as_deref(),
        !o.appearance.is_empty()
            || has_picture(
                &o.image_link,
                o.has_image_element,
                o.has_inline_pdf,
                o.has_inline_eps,
                o.placed_pdf.is_some(),
                o.image_bytes.is_some(),
            ),
    )
}
/// Whether a polygon's stroke style needs the split.
pub fn polygon_splits(p: &Polygon) -> bool {
    splits(
        &p.effect_stack,
        p.fill_color.as_deref(),
        !p.appearance.is_empty()
            || !p.text_paths.is_empty()
            || has_picture(
                &p.image_link,
                p.has_image_element,
                p.has_inline_pdf,
                p.has_inline_eps,
                p.placed_pdf.is_some(),
                p.image_bytes.is_some(),
            ),
    )
}
/// Whether a text frame's stroke style needs the split (its story is
/// laid out in the source frame either way).
pub fn text_frame_splits(t: &TextFrame) -> bool {
    splits(
        &t.effect_stack,
        t.fill_color.as_deref(),
        !t.appearance.is_empty(),
    )
}

macro_rules! fill_part {
    ($item:expr) => {{
        let mut x = $item.clone();
        x.stroke_color = Some(NONE.to_string());
        x.effect_stack = without_stroke_style(&x.effect_stack);
        x
    }};
}

macro_rules! stroke_part {
    ($item:expr) => {{
        let mut x = $item.clone();
        x.fill_color = Some(NONE.to_string());
        x.appearance.clear();
        x
    }};
}

/// The fill part of a rectangle with a stroke style (see above).
pub fn fill_part_rectangle(r: &Rectangle) -> Rectangle {
    fill_part!(r)
}
/// The fill part of an oval with a stroke style.
pub fn fill_part_oval(o: &Oval) -> Oval {
    fill_part!(o)
}
/// The fill part of a polygon with a stroke style.
pub fn fill_part_polygon(p: &Polygon) -> Polygon {
    fill_part!(p)
}
/// The fill part of a text frame with a stroke style.
pub fn fill_part_text_frame(t: &TextFrame) -> TextFrame {
    fill_part!(t)
}

/// The polygon `id` that paints a baked stroke part: its outline, its
/// fill (the stroke's paint), the item's place and layer. Picture,
/// effects and transparency belong to the item.
fn art_polygon(
    id: String,
    item_transform: Option<[f32; 6]>,
    layer: Option<String>,
    part: &Polygon,
) -> Polygon {
    let mut out = Polygon::new(id, part.bounds);
    out.item_transform = item_transform;
    out.item_layer = layer;
    out.anchors = part.anchors.clone();
    out.subpath_starts = part.subpath_starts.clone();
    out.subpath_open = part.subpath_open.clone();
    out.fill_color = part.fill_color.clone();
    out.fill_tint = part.fill_tint;
    out.gradient_fill_angle = part.gradient_fill_angle;
    out.gradient_fill_length = part.gradient_fill_length;
    out.overprint_fill = part.overprint_fill;
    out.stroke_color = Some(NONE.to_string());
    out.stroke_weight = Some(0.0);
    out.fill_rule = paged_model::FillRule::NonZero;
    out
}

macro_rules! stroke_art_of {
    ($item:expr, $bake:expr, $poly:expr) => {{
        let item = $item;
        if !paged_model::effect_stack::has_stroke_style(&item.effect_stack) {
            return None;
        }
        let part = stroke_part!(item);
        let baked = $bake(&part)?;
        let poly: Polygon = $poly(&baked);
        if !paints(poly.fill_color.as_deref()) || poly.anchors.is_empty() {
            return None;
        }
        Some(art_polygon(
            format!("{}vfx", item.self_id.as_deref().unwrap_or("item")),
            item.item_transform,
            item.item_layer.clone(),
            &poly,
        ))
    }};
}

fn rect_as_poly(r: &Rectangle) -> Polygon {
    let mut p = Polygon::new(r.self_id.clone().unwrap_or_default(), r.bounds);
    p.anchors = r.anchors.clone();
    p.subpath_starts = r.subpath_starts.clone();
    p.subpath_open = r.subpath_open.clone();
    p.fill_color = r.fill_color.clone();
    p.fill_tint = r.fill_tint;
    p.gradient_fill_angle = r.gradient_fill_angle;
    p.gradient_fill_length = r.gradient_fill_length;
    p.overprint_fill = r.overprint_fill;
    p
}

fn text_as_poly(t: &TextFrame) -> Polygon {
    let mut p = Polygon::new(t.self_id.clone().unwrap_or_default(), t.bounds);
    p.anchors = t.anchors.clone();
    p.subpath_starts = t.subpath_starts.clone();
    p.subpath_open = t.subpath_open.clone();
    p.fill_color = t.fill_color.clone();
    p.fill_tint = t.fill_tint;
    p.gradient_fill_angle = t.gradient_fill_angle;
    p.gradient_fill_length = t.gradient_fill_length;
    p
}

/// The stroke artwork of a rectangle's stroke style, a polygon `<id>vfx`
/// in the rectangle's space; `None` without an enabled stroke style or
/// without a stroke that paints.
pub fn stroke_art_rectangle(r: &Rectangle) -> Option<Polygon> {
    stroke_art_of!(r, bake_rectangle, rect_as_poly)
}
/// The stroke artwork of an oval's stroke style.
pub fn stroke_art_oval(o: &Oval) -> Option<Polygon> {
    stroke_art_of!(o, bake_oval, |p: &Polygon| p.clone())
}
/// The stroke artwork of a polygon's stroke style.
pub fn stroke_art_polygon(p: &Polygon) -> Option<Polygon> {
    stroke_art_of!(p, bake_polygon, |p: &Polygon| p.clone())
}
/// The stroke artwork of a text frame's stroke style.
pub fn stroke_art_text_frame(t: &TextFrame) -> Option<Polygon> {
    stroke_art_of!(t, bake_text_frame, text_as_poly)
}
