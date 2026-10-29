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

//! Native appearance (engine ADR 1043): an item with several fills and
//! strokes.
//!
//! The item is drawn as its PARTS, bottom to top, each through the
//! ordinary emitter of its kind:
//!
//! - the item's own fill with its picture (and its own stroke with it when
//!   the stroke is drawn directly above the fill — the plain body);
//! - the item's own stroke on its own, when a layer sits between;
//! - one ordinary item per extra layer
//!   ([`AppearanceParts::layer_item`]): the layer's paint and stroke
//!   settings, its opacity and blend mode as that item's (so a layer that
//!   needs one is its own transparency group), its effects as that item's
//!   effect stack (engine ADR 1008).
//!
//! The item's opacity and blend mode wrap all the parts in one group, and
//! its object effects are applied to the whole run in their order, as a
//! stack in [`StackMode::Ordered`]: a drop shadow is cast by every layer
//! together, an inner glow lies over all of them. Display list, both
//! rasterizers and PDF see nothing new: groups and paths they already draw.

use paged_model::appearance::{drawn_order, AppearanceParts, PaintLayerKind};
use paged_model::effect_stack::{EffectBearing, EffectTarget};

use super::*;
use crate::module::effect_stack::StackMode;

/// The parts of `item`, bottom to top, each with whether it paints the
/// item's content.
fn parts<T: AppearanceParts>(item: &T) -> Vec<(T, bool)> {
    let order = drawn_order(item.appearance());
    let mut out = Vec::with_capacity(order.len());
    let mut i = 0;
    while i < order.len() {
        let l = &order[i];
        match l.kind {
            PaintLayerKind::FrameFill => {
                if let Some(s) = order
                    .get(i + 1)
                    .filter(|n| n.kind == PaintLayerKind::FrameStroke)
                {
                    out.push((item.base_item(l.enabled, s.enabled, true), true));
                    i += 2;
                    continue;
                }
                out.push((item.base_item(l.enabled, false, true), true));
            }
            PaintLayerKind::FrameStroke => {
                if l.enabled {
                    out.push((item.base_item(false, true, false), false));
                }
            }
            PaintLayerKind::Fill | PaintLayerKind::Stroke => {
                if l.paints() {
                    out.push((item.layer_item(l), false));
                }
            }
        }
        i += 1;
    }
    out
}

fn geometry_bounds(resolved: &ResolvedFrame<'_>) -> Rect {
    match &resolved.geometry {
        Geometry::TextFrameRect { rect } | Geometry::Rect { rect } | Geometry::Oval { rect } => {
            *rect
        }
        Geometry::Polygon { bbox, .. } => *bbox,
        Geometry::Line { p0, p1 } => Rect {
            x: p0.0.min(p1.0),
            y: p0.1.min(p1.1),
            w: (p0.0 - p1.0).abs(),
            h: (p0.1 - p1.1).abs(),
        },
    }
}

/// Open the object's group when its opacity or blend mode needs one.
fn open_object_group(page: &mut BuiltPage, resolved: &ResolvedFrame<'_>) -> bool {
    if !frame_needs_blend_group(resolved) {
        return false;
    }
    let outer = frame_outer_transform(page, resolved.item_transform);
    push_blend_group(
        page,
        geometry_bounds(resolved),
        outer,
        resolved.blend_mode,
        frame_group_opacity(resolved),
    );
    true
}

/// The object target's effects over the whole run, in their order.
#[allow(clippy::too_many_arguments)]
fn finish_object_effects(
    page: &mut BuiltPage,
    start: usize,
    slot: Option<usize>,
    item: &dyn EffectBearing,
    effects: Option<&paged_model::FrameEffects>,
    resolved: &ResolvedFrame<'_>,
    palette: &Graphic,
    color_ctx: ColorCtx<'_>,
) -> Option<usize> {
    let stack = item.effect_slots(EffectTarget::Object).resolved();
    if stack.is_empty() {
        return slot;
    }
    super::shapes::finish_effect_stack(
        page,
        start,
        slot,
        &stack,
        StackMode::Ordered,
        resolved,
        effects,
        palette,
        color_ctx,
    )
}

/// A rectangle with an appearance.
#[allow(clippy::too_many_arguments)]
pub(super) fn emit_rectangle(
    page: &mut BuiltPage,
    rect: &Rectangle,
    document: &Document,
    palette: &Graphic,
    fallback: Paint,
    color_ctx: ColorCtx<'_>,
    content: super::shapes::ContentPainter<'_>,
) {
    let mut resolved = ResolvedFrame::from_rectangle(rect);
    let style = crate::module::resolve_applied_style(&resolved, document);
    if let Some(s) = &style {
        crate::module::object_style_cascade(&mut resolved, s);
    }
    let frames = page.stats.frames;
    let start = page.list.commands.len();
    let group = open_object_group(page, &resolved);
    for (part, with_content) in parts(rect) {
        let mut none = |_: &mut BuiltPage| {};
        let c: super::shapes::ContentPainter<'_> = if with_content {
            &mut *content
        } else {
            &mut none
        };
        super::shapes::emit_rectangle_into(
            page, &part, document, palette, fallback, color_ctx, None, c,
        );
    }
    if group {
        pop_blend_group(page);
    }
    page.stats.frames = frames + 1;
    finish_object_effects(
        page,
        start,
        None,
        rect,
        rect.effects.as_ref(),
        &resolved,
        palette,
        color_ctx,
    );
}

/// An oval with an appearance.
pub(super) fn emit_oval(
    page: &mut BuiltPage,
    oval: &Oval,
    document: &Document,
    palette: &Graphic,
    fallback: Paint,
    color_ctx: ColorCtx<'_>,
    content: super::shapes::ContentPainter<'_>,
) {
    let mut resolved = ResolvedFrame::from_oval(oval);
    let style = crate::module::resolve_applied_style(&resolved, document);
    if let Some(s) = &style {
        crate::module::object_style_cascade(&mut resolved, s);
    }
    let frames = page.stats.frames;
    let start = page.list.commands.len();
    let group = open_object_group(page, &resolved);
    for (part, with_content) in parts(oval) {
        let mut none = |_: &mut BuiltPage| {};
        let c: super::shapes::ContentPainter<'_> = if with_content {
            &mut *content
        } else {
            &mut none
        };
        super::shapes::emit_oval_into(page, &part, document, palette, fallback, color_ctx, c);
    }
    if group {
        pop_blend_group(page);
    }
    page.stats.frames = frames + 1;
    finish_object_effects(
        page,
        start,
        None,
        oval,
        oval.effects.as_ref(),
        &resolved,
        palette,
        color_ctx,
    );
}

/// A polygon with an appearance.
pub(super) fn emit_polygon(
    page: &mut BuiltPage,
    poly: &Polygon,
    document: &Document,
    palette: &Graphic,
    fallback: Paint,
    color_ctx: ColorCtx<'_>,
    content: super::shapes::ContentPainter<'_>,
) {
    let mut resolved = ResolvedFrame::from_polygon(poly);
    let style = crate::module::resolve_applied_style(&resolved, document);
    if let Some(s) = &style {
        crate::module::object_style_cascade(&mut resolved, s);
    }
    let frames = page.stats.frames;
    let start = page.list.commands.len();
    let group = open_object_group(page, &resolved);
    for (part, with_content) in parts(poly) {
        let mut none = |_: &mut BuiltPage| {};
        let c: super::shapes::ContentPainter<'_> = if with_content {
            &mut *content
        } else {
            &mut none
        };
        super::text_path::emit_polygon_into(page, &part, document, palette, fallback, color_ctx, c);
    }
    if group {
        pop_blend_group(page);
    }
    page.stats.frames = frames + 1;
    finish_object_effects(
        page,
        start,
        None,
        poly,
        poly.effects.as_ref(),
        &resolved,
        palette,
        color_ctx,
    );
}

/// A text frame with an appearance. The story's glyphs go in over every
/// layer, inside the object's group.
pub(super) fn emit_text_frame(
    page: &mut BuiltPage,
    frame: &TextFrame,
    document: &Document,
    palette: &Graphic,
    fallback: Paint,
    color_ctx: ColorCtx<'_>,
    auto_sized_bounds: Option<paged_model::Bounds>,
) -> Option<super::text_frame::BodyTextSlot> {
    let mut resolved = ResolvedFrame::from_text_frame(frame);
    if let (Some(grown), Geometry::TextFrameRect { rect }) =
        (auto_sized_bounds, &mut resolved.geometry)
    {
        *rect = Rect {
            x: grown.left,
            y: grown.top,
            w: grown.width(),
            h: grown.height(),
        };
    }
    let style = crate::module::resolve_applied_style(&resolved, document);
    if let Some(s) = &style {
        crate::module::object_style_cascade(&mut resolved, s);
    }
    let frames = page.stats.frames;
    let start = page.list.commands.len();
    let group = open_object_group(page, &resolved);
    for (part, _) in parts(frame) {
        let _ = super::text_frame::emit_text_frame_into(
            page,
            &part,
            document,
            palette,
            fallback,
            color_ctx,
            None,
            auto_sized_bounds,
        );
    }
    let slot = page.list.commands.len();
    if group {
        pop_blend_group(page);
    }
    page.stats.frames = frames + 1;
    let slot = finish_object_effects(
        page,
        start,
        group.then_some(slot),
        frame,
        frame.effects.as_ref(),
        &resolved,
        palette,
        color_ctx,
    );
    slot.map(|slot| super::text_frame::BodyTextSlot {
        slot,
        in_object_group: group || slot < page.list.commands.len(),
    })
}
