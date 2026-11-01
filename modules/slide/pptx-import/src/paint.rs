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

//! Colours, fills, lines and effects (`a:` DrawingML paint), read by the
//! shared DrawingML reader (`paged_ooxml::drawingml`, slide ADR 722) with
//! this part's relationships.

use paged_ooxml::drawingml;
use pptx_core::{Blip, Color, Effects, Fill, Line};

use crate::xml::El;
use crate::Ctx;

pub use paged_ooxml::drawingml::rect_attrs;

/// The part (or, for an external relationship, the URL) a relationship id
/// names.
fn rel(ctx: &Ctx, id: &str) -> Option<String> {
    let r = ctx.rels.by_id(id)?;
    Some(if r.target_mode.as_deref() == Some("External") {
        r.target.clone()
    } else {
        ctx.resolve(&r.target)
    })
}

/// The first colour element among `el`'s children, if any.
pub fn color_in(el: &El) -> Option<Color> {
    drawingml::color_in(el)
}

/// The fill choice among `el`'s children (`a:noFill`, `a:solidFill`, …).
pub fn fill_in(el: &El, ctx: &Ctx) -> Option<Fill> {
    drawingml::fill_in(el, &|id| rel(ctx, id))
}

/// One fill element.
pub fn fill(el: &El, ctx: &Ctx) -> Option<Fill> {
    drawingml::fill(el, &|id| rel(ctx, id))
}

/// A blip fill (`p:blipFill`, `a:blipFill`).
pub fn blip(el: &El, ctx: &Ctx) -> Blip {
    drawingml::blip(el, &|id| rel(ctx, id))
}

/// `a:ln`.
pub fn line(el: &El, ctx: &Ctx) -> Line {
    drawingml::line(el, &|id| rel(ctx, id))
}

/// `a:effectLst`. Children the shared reader does not model are reported
/// through `ctx`; what the engine cannot draw of the rest is reported when
/// the deck is lowered.
pub fn effects(el: &El, ctx: &Ctx) -> Effects {
    let fx = drawingml::effects(el, &|id| rel(ctx, id));
    for name in &fx.unknown {
        ctx.note(format!("effect a:{name} is not carried"));
    }
    fx
}

/// The effects of a shape's properties (`a:spPr`, an `a:effectStyle`):
/// its effect list ([`effects`]) and its 3-D look (`a:scene3d`,
/// `a:sp3d`) beside it; `None` when it has neither.
pub fn shape_effects(el: &El, ctx: &Ctx) -> Option<Effects> {
    let mut fx = paged_ooxml::drawingml::effect::container(el).map(|e| effects(e, ctx));
    if let Some(t) = paged_ooxml::drawingml::three_d(el) {
        let only = fx.is_none();
        let fx = fx.get_or_insert_with(Effects::default);
        fx.three_d = Some(t);
        fx.three_d_only = only;
    }
    fx
}
