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

//! Engine ADR 1041 — a pattern swatch resolved into the display list's
//! pattern pool.
//!
//! The model's [`paged_model::PatternEntry::cell`] gives the period and
//! the copies; this resolves each item's colour through the document's
//! colour pipeline (a CMYK or spot swatch keeps its ink channels, ADR 106)
//! and its anchors into a path, and pushes one [`PatternPaint`] whose
//! placement takes pattern space to the frame's box space. The fill and
//! stroke modules then rebase it onto the path's local space
//! ([`rebase_to_box`]).

use std::sync::Arc;

use paged_compose::{
    DisplayList, Paint, PatternId, PatternPaint, PatternShape, PatternTile, Stroke, Transform,
};
use paged_model::{Graphic, PatternColor, PatternEntry};

use super::color_paint::{color_entry_to_paint, color_id_to_paint_with_list};
use super::ColorCtx;

/// Resolve one item colour to a solid or CMYK paint.
fn item_paint(
    color: &PatternColor,
    palette: &Graphic,
    color_ctx: ColorCtx<'_>,
    list: &mut DisplayList,
) -> Option<Paint> {
    let paint = match color {
        // Through the list resolver, so a spot swatch interns its ink.
        PatternColor::Swatch(id) => {
            if id.starts_with(paged_model::PATTERN_ID_PREFIX) || palette.gradients.contains_key(id)
            {
                return None;
            }
            color_id_to_paint_with_list(id, palette, color_ctx, list)?
        }
        PatternColor::Inline(c) => color_entry_to_paint(&c.as_entry(""), color_ctx)?,
    };
    matches!(paint, Paint::Solid(_) | Paint::Cmyk { .. }).then_some(paint)
}

/// The tile of `entry` with every colour resolved, or `None` when it
/// paints nothing.
pub(crate) fn pattern_tile(
    entry: &PatternEntry,
    palette: &Graphic,
    color_ctx: ColorCtx<'_>,
    list: &mut DisplayList,
) -> Option<PatternTile> {
    if !entry.is_drawable() {
        return None;
    }
    let mut items = Vec::with_capacity(entry.items.len());
    for item in &entry.items {
        let path = super::polygon_path_from_anchors_with_open(
            &item.anchors,
            &item.subpath_starts,
            &item.subpath_open,
        )
        .with_fill_rule(match item.fill_rule {
            paged_model::FillRule::NonZero => paged_compose::FillRule::NonZero,
            paged_model::FillRule::EvenOdd => paged_compose::FillRule::EvenOdd,
        });
        if path.segments.is_empty() {
            continue;
        }
        let fill = item
            .fill
            .as_ref()
            .and_then(|c| item_paint(c, palette, color_ctx, list));
        let stroke = item
            .stroke
            .as_ref()
            .filter(|_| item.stroke_weight.is_finite() && item.stroke_weight > 0.0)
            .and_then(|c| item_paint(c, palette, color_ctx, list))
            .map(|p| (p, Stroke::new(item.stroke_weight)));
        if fill.is_none() && stroke.is_none() {
            continue;
        }
        items.push(PatternShape { path, fill, stroke });
    }
    let cell = entry.cell();
    let tile = PatternTile::new(cell.period, items, cell.copies);
    tile.is_drawable().then_some(tile)
}

/// Push the pattern `entry` as a paint placed in the frame's BOX space
/// (the box's top-left is the origin); [`rebase_to_box`] finishes it.
pub(crate) fn pattern_paint(
    entry: &PatternEntry,
    palette: &Graphic,
    color_ctx: ColorCtx<'_>,
    list: &mut DisplayList,
) -> Option<Paint> {
    let tile = pattern_tile(entry, palette, color_ctx, list)?;
    let id = list.push_pattern(PatternPaint {
        tile: Arc::new(tile),
        to_local: Transform(entry.placement.matrix()),
    });
    Some(Paint::Pattern(id))
}

/// Rebase the pattern use `id` from box space onto a path's local space:
/// `box_to_local` takes the box's top-left-origin space to the path's
/// local coordinates, `frame` is the frame's own `pattern_transform`
/// (applied after the pattern's placement).
pub(crate) fn rebase_to_box(
    list: &mut DisplayList,
    id: PatternId,
    box_to_local: Transform,
    frame: Option<[f32; 6]>,
) {
    let Some(p) = list.patterns.get_mut(id.0 as usize) else {
        return;
    };
    let placed = match frame {
        Some(m) if m.iter().all(|v| v.is_finite()) => Transform(m).compose(&p.to_local),
        _ => p.to_local,
    };
    p.to_local = box_to_local.compose(&placed);
}
