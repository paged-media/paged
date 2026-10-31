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

//! Engine ADR 1042 — live vector effects, written baked.
//!
//! IDML has no live vector effect. Before the spreads are written, every
//! item whose effect stack holds vector entries is LOWERED, on a copy of
//! the model, to the item its effected outline describes
//! (`paged_vector_fx::bake`):
//!
//! * a rectangle, polygon or text frame keeps its kind and id, its path
//!   the effected outline;
//! * an oval becomes a polygon (`<id>vfx`) in the oval's place;
//! * a group with a Pathfinder effect keeps its place and its element,
//!   its members replaced by one polygon (`<id>vfx`), the outline.
//!
//! The source rides the written item's label (`paged:vectorSource`,
//! `paged_model::vector_effect::label`) with a fingerprint of the
//! outline written; the effect stack itself rides `paged:effectStack` as
//! before (ADR 1008). The reader restores both. The export's loss report
//! names every baked item (`paged-canvas`'s `vector_effect_losses`).

use idml_import::{FrameRef, Spread};
use paged_model::effect_stack::has_vector;
use paged_model::vector_effect::label::{self, Member, Source};
use paged_scene::Document;
use paged_vector_fx::bake;

/// The model to write, when an item has vector effects; `None` writes
/// `doc`.
pub(crate) fn lower(doc: &Document) -> Option<Document> {
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

fn any(s: &Spread) -> bool {
    s.rectangles.iter().any(|f| has_vector(&f.effect_stack))
        || s.ovals.iter().any(|f| has_vector(&f.effect_stack))
        || s.polygons.iter().any(|f| has_vector(&f.effect_stack))
        || s.text_frames.iter().any(|f| has_vector(&f.effect_stack))
        || s.groups.iter().any(|g| has_vector(&g.effect_stack))
}

fn written_id(id: &Option<String>) -> String {
    format!("{}vfx", id.as_deref().unwrap_or("item"))
}

fn lower_spread(spread: &mut Spread) {
    // Groups first: their members are read as they are.
    let mut gi = 0;
    while gi < spread.groups.len() {
        if !lower_group(spread, gi) {
            gi += 1;
        }
    }
    for i in 0..spread.rectangles.len() {
        let r = &spread.rectangles[i];
        if let Some(baked) = bake::bake_rectangle(r) {
            let mut source = r.clone();
            source.image_bytes = None;
            let id = r.self_id.clone();
            let src = Source::Rectangle {
                item: Box::new(source),
                fingerprint: label::fingerprint(&baked.anchors),
            };
            spread.rectangles[i] = baked;
            if let Some(id) = id {
                label::stamp(spread, &id, &src);
            }
        }
    }
    for i in 0..spread.polygons.len() {
        let p = &spread.polygons[i];
        if let Some(baked) = bake::bake_polygon(p) {
            let mut source = p.clone();
            source.image_bytes = None;
            let id = p.self_id.clone();
            let src = Source::Polygon {
                item: Box::new(source),
                fingerprint: label::fingerprint(&baked.anchors),
            };
            spread.polygons[i] = baked;
            if let Some(id) = id {
                label::stamp(spread, &id, &src);
            }
        }
    }
    for i in 0..spread.text_frames.len() {
        let t = &spread.text_frames[i];
        if let Some(baked) = bake::bake_text_frame(t) {
            let id = t.self_id.clone();
            let src = Source::TextFrame {
                item: Box::new(t.clone()),
                fingerprint: label::fingerprint(&baked.anchors),
            };
            spread.text_frames[i] = baked;
            if let Some(id) = id {
                label::stamp(spread, &id, &src);
            }
        }
    }
    let mut i = 0;
    while i < spread.ovals.len() {
        let o = &spread.ovals[i];
        let Some(mut poly) = bake::bake_oval(o) else {
            i += 1;
            continue;
        };
        let mut source = o.clone();
        source.image_bytes = None;
        let id = written_id(&o.self_id);
        poly.self_id = Some(id.clone());
        let src = Source::Oval {
            item: Box::new(source),
            fingerprint: label::fingerprint(&poly.anchors),
        };
        spread.polygons.push(poly);
        let to = FrameRef::Polygon(spread.polygons.len() - 1);
        label::replace_ref(spread, FrameRef::Oval(i), to);
        label::remove_item(spread, FrameRef::Oval(i));
        label::stamp(spread, &id, &src);
    }
}

/// Lower group `gi` when it has a Pathfinder effect over members the
/// effect reads: its members become the one outline (a polygon
/// `<id>vfx` inside it). Returns whether the group itself was removed
/// (never: the group is kept, so its element and transparency are).
fn lower_group(spread: &mut Spread, gi: usize) -> bool {
    let g = &spread.groups[gi];
    if !has_vector(&g.effect_stack) {
        return false;
    }
    // A text frame's story would leave with it (IDML drops a story no
    // frame places); such a group is written as it is, and reported.
    let readable = g.members.iter().all(|m| {
        matches!(
            m,
            FrameRef::Rectangle(_)
                | FrameRef::Oval(_)
                | FrameRef::Polygon(_)
                | FrameRef::GraphicLine(_)
        )
    });
    if !readable {
        return false;
    }
    let Some(mut poly) = bake::bake_group(spread, g) else {
        return false;
    };
    let members: Vec<Member> = g
        .members
        .iter()
        .filter_map(|m| {
            Some(match *m {
                FrameRef::Rectangle(i) => {
                    let mut it = spread.rectangles.get(i)?.clone();
                    it.image_bytes = None;
                    Member::Rectangle { item: Box::new(it) }
                }
                FrameRef::Oval(i) => {
                    let mut it = spread.ovals.get(i)?.clone();
                    it.image_bytes = None;
                    Member::Oval { item: Box::new(it) }
                }
                FrameRef::Polygon(i) => {
                    let mut it = spread.polygons.get(i)?.clone();
                    it.image_bytes = None;
                    Member::Polygon { item: Box::new(it) }
                }
                FrameRef::TextFrame(i) => Member::TextFrame {
                    item: Box::new(spread.text_frames.get(i)?.clone()),
                },
                FrameRef::GraphicLine(i) => Member::GraphicLine {
                    item: Box::new(spread.graphic_lines.get(i)?.clone()),
                },
                _ => return None,
            })
        })
        .collect();
    let id = written_id(&g.self_id);
    poly.self_id = Some(id.clone());
    let src = Source::Group {
        group: Box::new(g.clone()),
        members,
        fingerprint: label::fingerprint(&poly.anchors),
    };
    let member_refs = g.members.clone();
    // The group stays (its element, its transparency, its place); its
    // members give way to the one outline.
    spread.polygons.push(poly);
    let outline = FrameRef::Polygon(spread.polygons.len() - 1);
    let mut gone: Vec<(FrameRef, Option<String>)> = member_refs
        .iter()
        .map(|r| (*r, item_id(spread, *r)))
        .collect();
    spread.groups[gi].members = vec![outline];
    while let Some((kind, id)) = gone.pop() {
        if let Some(r) = find(spread, kind, id.as_deref()) {
            label::remove_item(spread, r);
        }
    }
    label::stamp(spread, &id, &src);
    // Not removed: the caller moves on to the next group.
    false
}

fn item_id(spread: &Spread, r: FrameRef) -> Option<String> {
    match r {
        FrameRef::Rectangle(i) => spread.rectangles.get(i)?.self_id.clone(),
        FrameRef::Oval(i) => spread.ovals.get(i)?.self_id.clone(),
        FrameRef::Polygon(i) => spread.polygons.get(i)?.self_id.clone(),
        FrameRef::TextFrame(i) => spread.text_frames.get(i)?.self_id.clone(),
        FrameRef::GraphicLine(i) => spread.graphic_lines.get(i)?.self_id.clone(),
        _ => None,
    }
}

fn find(spread: &Spread, kind: FrameRef, id: Option<&str>) -> Option<FrameRef> {
    let id = Some(id?);
    Some(match kind {
        FrameRef::Rectangle(_) => FrameRef::Rectangle(
            spread
                .rectangles
                .iter()
                .position(|f| f.self_id.as_deref() == id)?,
        ),
        FrameRef::Oval(_) => FrameRef::Oval(
            spread
                .ovals
                .iter()
                .position(|f| f.self_id.as_deref() == id)?,
        ),
        FrameRef::Polygon(_) => FrameRef::Polygon(
            spread
                .polygons
                .iter()
                .position(|f| f.self_id.as_deref() == id)?,
        ),
        FrameRef::TextFrame(_) => FrameRef::TextFrame(
            spread
                .text_frames
                .iter()
                .position(|f| f.self_id.as_deref() == id)?,
        ),
        FrameRef::GraphicLine(_) => FrameRef::GraphicLine(
            spread
                .graphic_lines
                .iter()
                .position(|f| f.self_id.as_deref() == id)?,
        ),
        _ => return None,
    })
}
