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

//! Engine ADR 1010 — a clip group, written as InDesign's paste-into.
//!
//! IDML has no clip group, but it has the construct that paints the
//! same: a frame with content pasted into it. So before the spreads are
//! written, every clip group is LOWERED on a copy of the model:
//!
//! * its clipping path (the top-most member) leaves the group and takes
//!   the group's place in whichever list named the group (the spread's
//!   z-order, a parent group's members, a container's children);
//! * the group, the clipping path removed, is pasted into it — the one
//!   entry of the path's `nested_children`;
//! * the path loses its paint (fill and stroke `Swatch/None`, no shadow):
//!   a clipping path paints nothing, and InDesign paints a container's
//!   own fill and stroke;
//! * the group's stored frame becomes spread space, the convention of a
//!   pasted-in group (a nested clip group's was relative to its parent).
//!
//! The writers then see an ordinary container holding a pasted-in group.
//! The reader opens that as exactly that (the clip group's structure
//! does not come back; its picture does). The `.paged` model part is
//! written from the model itself and keeps the clip group.

use idml_import::{FrameRef, Spread};
use paged_scene::Document;

/// The model to write, when it holds a clip group; `None` writes `doc`.
pub(crate) fn lower(doc: &Document) -> Option<Document> {
    let any = |s: &Spread| s.groups.iter().any(|g| g.clip_member().is_some());
    if !doc.spreads.iter().any(|p| any(&p.spread))
        && !doc.master_spreads.values().any(|m| any(&m.spread))
    {
        return None;
    }
    let mut out = doc.clone();
    for parsed in out.spreads.iter_mut() {
        lower_spread(&mut parsed.spread);
    }
    for master in out.master_spreads.values_mut() {
        lower_spread(&mut master.spread);
    }
    Some(out)
}

const NONE_SWATCH: &str = "Swatch/None";

fn compose(a: Option<[f32; 6]>, b: Option<[f32; 6]>) -> Option<[f32; 6]> {
    match (a, b) {
        (None, x) | (x, None) => x,
        (Some(a), Some(b)) => {
            let [a1, b1, c1, d1, tx1, ty1] = a;
            let [a2, b2, c2, d2, tx2, ty2] = b;
            Some([
                a1 * a2 + c1 * b2,
                b1 * a2 + d1 * b2,
                a1 * c2 + c1 * d2,
                b1 * c2 + d1 * d2,
                a1 * tx2 + c1 * ty2 + tx1,
                b1 * tx2 + d1 * ty2 + ty1,
            ])
        }
    }
}

fn self_id(spread: &Spread, r: FrameRef) -> Option<String> {
    match r {
        FrameRef::Rectangle(i) => spread.rectangles.get(i)?.self_id.clone(),
        FrameRef::Oval(i) => spread.ovals.get(i)?.self_id.clone(),
        FrameRef::Polygon(i) => spread.polygons.get(i)?.self_id.clone(),
        _ => None,
    }
}

fn unpaint(spread: &mut Spread, r: FrameRef) {
    macro_rules! clear {
        ($f:expr) => {{
            let f = $f;
            f.fill_color = Some(NONE_SWATCH.to_string());
            f.stroke_color = Some(NONE_SWATCH.to_string());
            f.drop_shadow = None;
        }};
    }
    match r {
        FrameRef::Rectangle(i) => clear!(&mut spread.rectangles[i]),
        FrameRef::Oval(i) => clear!(&mut spread.ovals[i]),
        FrameRef::Polygon(i) => clear!(&mut spread.polygons[i]),
        _ => {}
    }
}

fn lower_spread(spread: &mut Spread) {
    let parent_of = |spread: &Spread, gi: usize| {
        spread
            .groups
            .iter()
            .position(|g| g.members.contains(&FrameRef::Group(gi)))
    };
    // Each clip group, its clipping path and its frame in spread space,
    // all read before anything moves.
    let mut plan: Vec<(usize, FrameRef, String, Option<[f32; 6]>)> = Vec::new();
    for (gi, g) in spread.groups.iter().enumerate() {
        let Some(path) = g.clip_member() else {
            continue;
        };
        let Some(path_id) = self_id(spread, path) else {
            continue;
        };
        let mut frame = g.item_transform;
        let mut cur = parent_of(spread, gi);
        for _ in 0..spread.groups.len() {
            let Some(p) = cur else { break };
            frame = compose(spread.groups[p].item_transform, frame);
            cur = parent_of(spread, p);
        }
        plan.push((gi, path, path_id, frame));
    }
    for (gi, path, path_id, frame) in plan {
        let me = FrameRef::Group(gi);
        let swap = |list: &mut Vec<FrameRef>| {
            if let Some(slot) = list.iter().position(|r| *r == me) {
                list[slot] = path;
            }
        };
        swap(&mut spread.frames_in_order);
        for g in spread.groups.iter_mut() {
            swap(&mut g.members);
        }
        for children in spread.nested_children.values_mut() {
            swap(children);
        }
        let g = &mut spread.groups[gi];
        g.members.retain(|r| *r != path);
        g.clip = false;
        g.item_transform = frame;
        spread.nested_children.entry(path_id).or_default().push(me);
        unpaint(spread, path);
    }
}
