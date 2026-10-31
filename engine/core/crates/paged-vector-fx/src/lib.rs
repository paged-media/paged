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

//! Live vector effects (engine ADR 1042, plan WP3.2, PM-0014 L2).
//!
//! A vector effect is an entry of an item's ordered effect stack (ADR
//! 1008) that changes the item's GEOMETRY: Roughen, Zig Zag, Pucker &
//! Bloat, Twist, Tweak, Transform (copies), Free Distort, Warp, Offset
//! Path, Outline Stroke, Round Corners, Scribble, Convert to Shape, and
//! on a group the Pathfinder shape modes. The model keeps the source
//! path and the parameters; this crate computes the effected outline.
//!
//! - [`apply_stack`] runs a stack's enabled vector entries, in their
//!   order, on a source [`Shape`], and caches the result by a hash of
//!   the source, the entries and the context ([`cache`]).
//! - [`bake`] turns a page item into the item its effected outline
//!   describes (what the renderer draws, what IDML export writes, what
//!   `expandAppearance` keeps).
//!
//! Everything is deterministic: the random effects draw from their own
//! seed, never from the clock or the item.

pub mod bake;
pub mod cache;
pub mod distort;
pub mod path;
pub mod rng;
pub mod scribble;
pub mod shape;
pub mod warp;

use std::sync::Arc;

use paged_model::effect_stack::{Effect, EffectEntry};

pub use path::StrokeStyle;
pub use shape::{Contour, Node, Shape};

/// What paints the effected outline.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash)]
pub enum PaintRole {
    /// The item's fill and stroke, as before.
    #[default]
    Keep,
    /// The outline IS the stroke (Outline Stroke): it is filled with the
    /// stroke's paint and not stroked.
    StrokeAsFill,
    /// The outline is filled and not stroked (Scribble: the line is the
    /// fill drawn).
    FillOnly,
}

/// The effected outline and what paints it.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Effected {
    pub shape: Shape,
    pub paint: PaintRole,
}

/// What an effect may read besides the outline.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Context {
    /// The item's stroke, `None` when it paints none (Outline Stroke
    /// then leaves the outline alone).
    pub stroke: Option<StrokeStyle>,
}

/// Run one vector effect. A non-vector effect returns the shape as it
/// is; so does the Pathfinder effect, which acts on a group's members
/// ([`apply_group`]).
pub fn apply_effect(shape: &Shape, effect: &Effect, ctx: &Context, paint: &mut PaintRole) -> Shape {
    match effect {
        Effect::Roughen(p) => distort::roughen(shape, p, 0),
        Effect::ZigZag(p) => distort::zig_zag(shape, p),
        Effect::PuckerBloat(p) => distort::pucker_bloat(shape, p),
        Effect::Twist(p) => distort::twist(shape, p),
        Effect::Tweak(p) => distort::tweak(shape, p, 0),
        Effect::TransformCopies(p) => distort::transform_copies(shape, p),
        Effect::FreeDistort(p) => distort::free_distort(shape, p),
        Effect::Warp(p) => warp::warp(shape, p),
        Effect::OffsetPath(p) => path::offset_path(shape, p),
        Effect::OutlinePath(_) => {
            // The stroke the outline outlines is the item's, once: an
            // outline already filled with the stroke's paint has none.
            match (ctx.stroke, *paint) {
                (Some(stroke), PaintRole::Keep) => match path::outline_stroke(shape, &stroke) {
                    Some(out) => {
                        *paint = PaintRole::StrokeAsFill;
                        out
                    }
                    None => shape.clone(),
                },
                _ => shape.clone(),
            }
        }
        Effect::RoundCorners(p) => path::round_corners(shape, p),
        Effect::Scribble(p) => {
            *paint = PaintRole::FillOnly;
            scribble::scribble(shape, p, 0)
        }
        Effect::ConvertToShape(p) => path::convert_to_shape(shape, p),
        _ => shape.clone(),
    }
}

/// Run every enabled vector entry of `stack` on `source`, in order.
/// `None` when the stack has none (the item draws its source outline).
/// Cached by hash ([`cache`]).
pub fn apply_stack(source: &Shape, stack: &[EffectEntry], ctx: &Context) -> Option<Arc<Effected>> {
    let entries: Vec<&EffectEntry> = paged_model::effect_stack::vector_entries(stack)
        .filter(|e| !matches!(e.effect, Effect::Pathfinder(_)))
        .collect();
    if entries.is_empty() {
        return None;
    }
    let key = cache::key(&[source], &entries, ctx);
    Some(cache::get_or_insert(key, || {
        let mut paint = PaintRole::Keep;
        let mut shape = source.clone();
        for e in &entries {
            shape = apply_effect(&shape, &e.effect, ctx, &mut paint);
        }
        Effected { shape, paint }
    }))
}

/// A group's effected outline: its members' outlines (back first, in one
/// space) combined by the stack's Pathfinder entry, then the stack's
/// other vector entries in order. `None` without an enabled Pathfinder
/// entry (the members draw themselves).
pub fn apply_group(
    members_back_first: &[Shape],
    stack: &[EffectEntry],
    ctx: &Context,
) -> Option<Arc<Effected>> {
    let entries: Vec<&EffectEntry> = paged_model::effect_stack::vector_entries(stack).collect();
    let op = entries.iter().find_map(|e| match &e.effect {
        Effect::Pathfinder(p) => Some(p.op),
        _ => None,
    })?;
    let refs: Vec<&Shape> = members_back_first.iter().collect();
    let key = cache::key(&refs, &entries, ctx);
    Some(cache::get_or_insert(key, || {
        let mut paint = PaintRole::Keep;
        let mut shape = path::pathfinder(members_back_first, op);
        for e in &entries {
            shape = apply_effect(&shape, &e.effect, ctx, &mut paint);
        }
        Effected { shape, paint }
    }))
}
