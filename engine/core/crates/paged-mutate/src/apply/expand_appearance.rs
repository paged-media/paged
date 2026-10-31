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

//! Engine ADR 1042 — Expand Appearance: an item becomes, for good, the
//! item its live vector effects describe (`paged_vector_fx::bake`).
//!
//! - A rectangle, polygon or text frame is rewritten in place; the
//!   inverse puts the previous struct back (`restore`).
//! - An oval becomes a polygon of the same id at the same place in the
//!   z-order (or its group): removed, then the baked polygon inserted
//!   through the captured-node path, so undo is the two inverses.
//! - A group with a Pathfinder effect becomes one polygon of the group's
//!   id where the group was: its leaves removed (the group leaves with
//!   the last), the polygon inserted at the group's slot.

use paged_model::{FrameRef, Polygon, Rectangle, TextFrame};
use paged_scene::Document;

use super::helpers::{find_polygon_mut, find_rectangle_mut, find_text_frame_mut, spread_parent_id};
use super::insert_node::{ref_home, RefHome};
use crate::error::OperationError;
use crate::operation::{
    AppliedOperation, InvalidationHint, NodeId, NodeSpec, Operation, PropertyPath,
};

fn refuse(node: &NodeId, reason: impl Into<String>) -> OperationError {
    OperationError::InvalidValue {
        node: node.clone(),
        path: PropertyPath::FrameEffectStack,
        reason: reason.into(),
    }
}

fn structural() -> InvalidationHint {
    InvalidationHint {
        structural: true,
        ..Default::default()
    }
}

/// Put `next` in place of `item`, keeping the picture bytes (they do not
/// change, and a restore snapshot is written without them).
macro_rules! swap_in_place {
    ($item:expr, $next:expr) => {{
        let bytes = $item.image_bytes.take();
        let prev = std::mem::replace($item, $next);
        $item.image_bytes = bytes;
        prev
    }};
}

fn snapshot<T: serde::Serialize>(item: &T) -> Result<String, OperationError> {
    serde_json::to_string(item).map_err(|e| OperationError::InvalidValue {
        node: NodeId::Spread(String::new()),
        path: PropertyPath::FrameEffectStack,
        reason: format!("the item does not serialise: {e}"),
    })
}

pub(super) fn apply_expand_appearance(
    doc: &mut Document,
    node: &NodeId,
    restore: Option<&str>,
) -> Result<AppliedOperation, OperationError> {
    let applied = |inverse_restore: String| AppliedOperation {
        op: Operation::ExpandAppearance {
            node: node.clone(),
            restore: restore.map(str::to_string),
        },
        inverse: Operation::ExpandAppearance {
            node: node.clone(),
            restore: Some(inverse_restore),
        },
        invalidation: structural(),
    };
    match node {
        NodeId::Rectangle(id) => {
            let item = find_rectangle_mut(doc, id)
                .ok_or_else(|| OperationError::NodeNotFound(node.clone()))?;
            let next: Rectangle = match restore {
                Some(json) => serde_json::from_str(json)
                    .map_err(|e| refuse(node, format!("not a rectangle snapshot: {e}")))?,
                None => paged_vector_fx::bake::bake_rectangle(item)
                    .ok_or_else(|| refuse(node, "the item has no vector effects to expand"))?,
            };
            let prev = swap_in_place!(item, next);
            Ok(applied(snapshot(&prev)?))
        }
        NodeId::Polygon(id) => {
            let item = find_polygon_mut(doc, id)
                .ok_or_else(|| OperationError::NodeNotFound(node.clone()))?;
            let next: Polygon = match restore {
                Some(json) => serde_json::from_str(json)
                    .map_err(|e| refuse(node, format!("not a polygon snapshot: {e}")))?,
                None => paged_vector_fx::bake::bake_polygon(item)
                    .ok_or_else(|| refuse(node, "the item has no vector effects to expand"))?,
            };
            let prev = swap_in_place!(item, next);
            Ok(applied(snapshot(&prev)?))
        }
        NodeId::TextFrame(id) => {
            let item = find_text_frame_mut(doc, id)
                .ok_or_else(|| OperationError::NodeNotFound(node.clone()))?;
            let next: TextFrame = match restore {
                Some(json) => serde_json::from_str(json)
                    .map_err(|e| refuse(node, format!("not a text frame snapshot: {e}")))?,
                None => paged_vector_fx::bake::bake_text_frame(item)
                    .ok_or_else(|| refuse(node, "the item has no vector effects to expand"))?,
            };
            let prev = std::mem::replace(item, next);
            Ok(applied(snapshot(&prev)?))
        }
        NodeId::Oval(id) => expand_oval(doc, node, id),
        NodeId::Group(id) => expand_group(doc, node, id),
        _ => Err(refuse(
            node,
            "Expand Appearance takes a rectangle, oval, polygon, text frame or group",
        )),
    }
}

/// Apply `second` after `first` was applied; undo `first` if it fails.
fn then(
    doc: &mut Document,
    node: &NodeId,
    first: AppliedOperation,
    second: &Operation,
) -> Result<AppliedOperation, OperationError> {
    match super::apply_inner(doc, second) {
        Ok(done) => Ok(AppliedOperation {
            op: Operation::ExpandAppearance {
                node: node.clone(),
                restore: None,
            },
            inverse: Operation::Batch {
                ops: vec![done.inverse, first.inverse],
            },
            invalidation: structural(),
        }),
        Err(e) => {
            let _ = super::apply_inner(doc, &first.inverse);
            Err(e)
        }
    }
}

fn expand_oval(
    doc: &mut Document,
    node: &NodeId,
    id: &str,
) -> Result<AppliedOperation, OperationError> {
    let oval = doc
        .spreads
        .iter()
        .flat_map(|p| p.spread.ovals.iter())
        .find(|o| o.self_id.as_deref() == Some(id))
        .ok_or_else(|| OperationError::NodeNotFound(node.clone()))?;
    let poly = paged_vector_fx::bake::bake_oval(oval)
        .ok_or_else(|| refuse(node, "the item has no vector effects to expand"))?;
    let removed = super::apply_inner(doc, &Operation::RemoveNode { node: node.clone() })?;
    let Operation::InsertNode {
        parent,
        z_slot,
        node: NodeSpec::Captured {
            json, image_bytes, ..
        },
        ..
    } = &removed.inverse
    else {
        let _ = super::apply_inner(doc, &removed.inverse);
        return Err(refuse(node, "the oval could not be captured"));
    };
    let mut envelope: serde_json::Value = match serde_json::from_str(json) {
        Ok(v) => v,
        Err(e) => {
            let _ = super::apply_inner(doc, &removed.inverse);
            return Err(refuse(
                node,
                format!("the oval's capture does not read: {e}"),
            ));
        }
    };
    envelope["item"] = match serde_json::to_value(&poly) {
        Ok(v) => v,
        Err(e) => {
            let _ = super::apply_inner(doc, &removed.inverse);
            return Err(refuse(node, format!("the polygon does not serialise: {e}")));
        }
    };
    let insert = Operation::InsertNode {
        parent: parent.clone(),
        position: 0,
        node: NodeSpec::Captured {
            node: NodeId::Polygon(id.to_string()),
            json: envelope.to_string(),
            image_bytes: image_bytes.clone(),
        },
        z_slot: *z_slot,
    };
    then(doc, node, removed, &insert)
}

fn expand_group(
    doc: &mut Document,
    node: &NodeId,
    id: &str,
) -> Result<AppliedOperation, OperationError> {
    let (poly, parent, z_slot) = {
        let parsed = doc
            .spreads
            .iter()
            .find(|p| {
                p.spread
                    .groups
                    .iter()
                    .any(|g| g.self_id.as_deref() == Some(id))
            })
            .ok_or_else(|| OperationError::NodeNotFound(node.clone()))?;
        let spread = &parsed.spread;
        let gi = spread
            .groups
            .iter()
            .position(|g| g.self_id.as_deref() == Some(id))
            .expect("found above");
        if spread.groups[gi].members.iter().any(|m| {
            !matches!(
                m,
                FrameRef::Rectangle(_)
                    | FrameRef::Oval(_)
                    | FrameRef::Polygon(_)
                    | FrameRef::GraphicLine(_)
            )
        }) {
            return Err(refuse(
                node,
                "the group holds a text frame, a group or a symbol instance: expanding would take its content with it",
            ));
        }
        let poly = paged_vector_fx::bake::bake_group(spread, &spread.groups[gi])
            .ok_or_else(|| refuse(node, "the group has no Pathfinder effect to expand"))?;
        let (parent, z_slot) = match ref_home(spread, FrameRef::Group(gi)) {
            Some(RefHome::Root(slot)) => (spread_parent_id(parsed), Some(slot)),
            Some(RefHome::Group(pgi, slot)) => {
                let outer = &spread.groups[pgi];
                if outer.members.len() < 2 {
                    return Err(refuse(
                        node,
                        "the group is the only member of its group: expand that group's members first",
                    ));
                }
                match outer.self_id.clone() {
                    Some(pid) => (NodeId::Group(pid), Some(slot)),
                    None => return Err(refuse(node, "the enclosing group has no id")),
                }
            }
            _ => {
                return Err(refuse(
                    node,
                    "a group pasted into a frame expands once it is released",
                ))
            }
        };
        (poly, parent, z_slot)
    };
    let leaves = super::remove_node::removal_leaves(doc, node);
    let ops: Vec<Operation> = leaves
        .into_iter()
        .rev()
        .map(|leaf| Operation::RemoveNode { node: leaf })
        .collect();
    let removed = super::apply_inner(doc, &Operation::Batch { ops })?;
    let json = serde_json::json!({ "item": poly }).to_string();
    let insert = Operation::InsertNode {
        parent,
        position: 0,
        node: NodeSpec::Captured {
            node: NodeId::Polygon(id.to_string()),
            json,
            image_bytes: None,
        },
        z_slot,
    };
    then(doc, node, removed, &insert)
}

/// Engine ADR 1042 — the outline an item DRAWS when its live vector
/// effects change it, for the operations that read an item's region (the
/// Pathfinder booleans and the planar arrangement): `None` when it has
/// none, and the item's own path is the answer.
pub(crate) fn effected_path(
    doc: &Document,
    node: &NodeId,
) -> Option<(Vec<paged_model::PathAnchor>, Vec<usize>)> {
    use paged_vector_fx::bake;
    let raw = node.self_id();
    let fx = doc.spreads.iter().find_map(|p| {
        let s = &p.spread;
        match node {
            NodeId::Rectangle(_) => s
                .rectangles
                .iter()
                .find(|f| f.self_id.as_deref() == Some(raw))
                .map(bake::rectangle_effected),
            NodeId::Oval(_) => s
                .ovals
                .iter()
                .find(|f| f.self_id.as_deref() == Some(raw))
                .map(bake::oval_effected),
            NodeId::Polygon(_) => s
                .polygons
                .iter()
                .find(|f| f.self_id.as_deref() == Some(raw))
                .map(bake::polygon_effected),
            NodeId::TextFrame(_) => s
                .text_frames
                .iter()
                .find(|f| f.self_id.as_deref() == Some(raw))
                .map(bake::text_frame_effected),
            _ => None,
        }
    })??;
    let (a, s, _) = fx.shape.to_anchors();
    if a.is_empty() {
        return None;
    }
    Some((a, if s.is_empty() { vec![0] } else { s }))
}

/// The stack write that leaves `node`'s vector entries out, when it has
/// any: what a boolean that consumed the effected outline does to the
/// item it keeps (the outline is its path now; the effects are spent).
pub(crate) fn spend_vector_entries(doc: &Document, node: &NodeId) -> Option<Operation> {
    let raw = node.self_id();
    let stack = doc.spreads.iter().find_map(|p| {
        let s = &p.spread;
        match node {
            NodeId::Rectangle(_) => s
                .rectangles
                .iter()
                .find(|f| f.self_id.as_deref() == Some(raw))
                .map(|f| f.effect_stack.clone()),
            NodeId::Oval(_) => s
                .ovals
                .iter()
                .find(|f| f.self_id.as_deref() == Some(raw))
                .map(|f| f.effect_stack.clone()),
            NodeId::Polygon(_) => s
                .polygons
                .iter()
                .find(|f| f.self_id.as_deref() == Some(raw))
                .map(|f| f.effect_stack.clone()),
            NodeId::TextFrame(_) => s
                .text_frames
                .iter()
                .find(|f| f.self_id.as_deref() == Some(raw))
                .map(|f| f.effect_stack.clone()),
            _ => None,
        }
    })?;
    if !paged_model::effect_stack::has_vector(&stack) {
        return None;
    }
    let rest = paged_vector_fx::bake::without_vector(&stack);
    Some(Operation::SetProperty {
        node: node.clone(),
        path: PropertyPath::FrameEffectStack,
        value: crate::operation::Value::EffectStack {
            entries: rest
                .iter()
                .map(crate::operation::EffectEntrySpec::from_model)
                .collect(),
            prev: None,
        },
    })
}
