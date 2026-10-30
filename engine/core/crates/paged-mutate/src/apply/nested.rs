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

//! B-18 nested content (InDesign paste-into): `Operation::PasteInto` /
//! `Operation::ReleaseFrom` — move a top-level page item into a
//! container's [`Spread::nested_children`] side map and back. Pure
//! bookkeeping between the spread's z-table (`frames_in_order`) and
//! the nested-children map: the child's spread-space `item_transform`
//! is untouched in BOTH directions, so nothing moves on canvas — only
//! clipping and stacking scope change. (IDML's parent-relative nested
//! `ItemTransform` is derived by the writer on export.)

use paged_model::{FrameRef, Spread};

use super::insert_node::ensure_frames_in_order;
use crate::error::OperationError;
use crate::operation::{AppliedOperation, InvalidationHint, NodeId, Operation, PropertyPath};

/// Resolve a `FrameRef`'s `Self` id against its spread's backing vecs.
pub(super) fn frame_ref_self_id(spread: &Spread, r: FrameRef) -> Option<&str> {
    match r {
        FrameRef::TextFrame(i) => spread.text_frames.get(i)?.self_id.as_deref(),
        FrameRef::Rectangle(i) => spread.rectangles.get(i)?.self_id.as_deref(),
        FrameRef::Oval(i) => spread.ovals.get(i)?.self_id.as_deref(),
        FrameRef::GraphicLine(i) => spread.graphic_lines.get(i)?.self_id.as_deref(),
        FrameRef::Polygon(i) => spread.polygons.get(i)?.self_id.as_deref(),
        FrameRef::Group(i) => spread.groups.get(i)?.self_id.as_deref(),
        FrameRef::Instance(i) => spread.instances.get(i)?.self_id.as_deref(),
    }
}

/// Resolve a leaf page-item `NodeId` to its `FrameRef` within one
/// spread. `None` when the id isn't in this spread (or the NodeId is
/// not a leaf page-item kind).
pub(super) fn leaf_ref_in_spread(spread: &Spread, node: &NodeId) -> Option<FrameRef> {
    match node {
        NodeId::TextFrame(id) => spread
            .text_frames
            .iter()
            .position(|f| f.self_id.as_deref() == Some(id.as_str()))
            .map(FrameRef::TextFrame),
        NodeId::Rectangle(id) => spread
            .rectangles
            .iter()
            .position(|f| f.self_id.as_deref() == Some(id.as_str()))
            .map(FrameRef::Rectangle),
        NodeId::Oval(id) => spread
            .ovals
            .iter()
            .position(|f| f.self_id.as_deref() == Some(id.as_str()))
            .map(FrameRef::Oval),
        NodeId::GraphicLine(id) => spread
            .graphic_lines
            .iter()
            .position(|f| f.self_id.as_deref() == Some(id.as_str()))
            .map(FrameRef::GraphicLine),
        NodeId::Polygon(id) => spread
            .polygons
            .iter()
            .position(|f| f.self_id.as_deref() == Some(id.as_str()))
            .map(FrameRef::Polygon),
        _ => None,
    }
}

/// The list that names `r`, as the item owning it: the group whose
/// members hold it, or the container it is pasted into. `None` at the
/// spread's top level (or for an item no list names).
fn owner_of(spread: &Spread, r: FrameRef) -> Option<FrameRef> {
    if let Some(gi) = spread.groups.iter().position(|g| g.members.contains(&r)) {
        return Some(FrameRef::Group(gi));
    }
    let (host, _) = spread
        .nested_children
        .iter()
        .find(|(_, children)| children.contains(&r))?;
    container_ref(spread, host)
}

/// The `FrameRef` of the container whose `Self` id is `id`.
fn container_ref(spread: &Spread, id: &str) -> Option<FrameRef> {
    let is = |s: &Option<String>| s.as_deref() == Some(id);
    if let Some(i) = spread.rectangles.iter().position(|f| is(&f.self_id)) {
        return Some(FrameRef::Rectangle(i));
    }
    if let Some(i) = spread.ovals.iter().position(|f| is(&f.self_id)) {
        return Some(FrameRef::Oval(i));
    }
    spread
        .polygons
        .iter()
        .position(|f| is(&f.self_id))
        .map(FrameRef::Polygon)
}

/// Engine ADR 1010 — the page item a paste-into or a release acts on
/// for `node`: the item itself, or, for a grouped item, the OUTERMOST
/// group above it (InDesign and Illustrator paste and release a group
/// whole; a member cannot leave its group that way). Climbs groups only:
/// a group pasted into a container is where the climb stops.
fn acting_ref(spread: &Spread, node: &NodeId) -> Option<FrameRef> {
    let mut r = super::layer::member_frame_ref(spread, node)?;
    for _ in 0..=spread.groups.len() {
        match spread.groups.iter().position(|g| g.members.contains(&r)) {
            Some(gi) => r = FrameRef::Group(gi),
            None => break,
        }
    }
    Some(r)
}

/// B-18: true when `node` is currently pasted into some container.
/// `apply_remove_node` gates on this — deleting a nested child
/// directly would produce a RemoveNode inverse that restores it
/// TOP-LEVEL, breaking the mutate-then-undo identity invariant.
/// Callers release the child first.
pub(super) fn is_nested_child(doc: &paged_scene::Document, node: &NodeId) -> bool {
    for parsed in &doc.spreads {
        let spread = &parsed.spread;
        if spread.nested_children.is_empty() {
            continue;
        }
        if let Some(child_ref) = super::layer::member_frame_ref(spread, node) {
            if spread
                .nested_children
                .values()
                .any(|v| v.contains(&child_ref))
            {
                return true;
            }
        }
    }
    false
}

fn invalid(node: &NodeId, reason: String) -> OperationError {
    OperationError::InvalidValue {
        node: node.clone(),
        path: PropertyPath::FrameTransform,
        reason,
    }
}

/// B-18 — `Operation::PasteInto`. See the operation doc for the
/// contract; geometry is preserved in document space (the child's
/// composed `item_transform` is not touched).
///
/// Engine ADR 1010: the child may be a group, and a grouped item stands
/// for its outermost group, which is what moves (the applied op names
/// that group, so redo and the inverse act on it too). A group keeps its
/// stored transform: a pasted-in group's frame is spread space, like a
/// top-level group's.
pub(super) fn apply_paste_into(
    doc: &mut paged_scene::Document,
    container: &NodeId,
    child: &NodeId,
    child_index: Option<usize>,
) -> Result<AppliedOperation, OperationError> {
    // Container kind gate — the frame kinds whose outline the
    // renderer clips by (B-18 scope).
    let container_id = match container {
        NodeId::Rectangle(s) | NodeId::Oval(s) | NodeId::Polygon(s) => s.clone(),
        _ => {
            return Err(OperationError::InvalidParent {
                parent: container.clone(),
                child_kind: child.kind().to_string(),
            });
        }
    };
    if !matches!(
        child,
        NodeId::TextFrame(_)
            | NodeId::Rectangle(_)
            | NodeId::Oval(_)
            | NodeId::GraphicLine(_)
            | NodeId::Polygon(_)
            | NodeId::Group(_)
    ) {
        return Err(invalid(
            child,
            format!("B-18: a {} cannot be pasted into a frame", child.kind()),
        ));
    }
    if child.self_id() == container_id {
        return Err(invalid(child, "cannot paste an item into itself".into()));
    }

    for parsed in doc.spreads.iter_mut() {
        let spread = &mut parsed.spread;
        if super::layer::member_frame_ref(spread, child).is_none() {
            continue;
        }
        let Some(container_ref) = container_ref(spread, &container_id) else {
            return Err(invalid(
                container,
                "B-18: container and child must live on the same spread".into(),
            ));
        };
        let child_ref = acting_ref(spread, child).expect("resolved above");
        let Some(acting) = super::layer::node_for_frame_ref(spread, child_ref) else {
            return Err(invalid(child, "B-18: the item's group has no id".into()));
        };
        // No cycles: the container must not sit (directly or through
        // any chain of groups and containers) inside the child.
        let mut cursor = container_ref;
        for _ in 0..=64 {
            if cursor == child_ref {
                return Err(invalid(
                    child,
                    "B-18: pasting here would nest the container inside its own child".into(),
                ));
            }
            match owner_of(spread, cursor) {
                Some(up) => cursor = up,
                None => break,
            }
        }
        // A clip group's clipping path paints nothing of its own, and
        // content pasted into it would surface inside the clip once the
        // IDML writer lowers the group to paste-into.
        if spread
            .groups
            .iter()
            .any(|g| g.clip_member() == Some(container_ref))
        {
            return Err(invalid(
                container,
                "the frame is a clipping path (release the clipping mask first)".into(),
            ));
        }
        // The child must currently be top-level.
        if spread
            .nested_children
            .values()
            .any(|v| v.contains(&child_ref))
        {
            return Err(invalid(
                child,
                "B-18: the item is already pasted into a container (release it first)".into(),
            ));
        }
        ensure_frames_in_order(spread);
        let Some(slot) = spread.frames_in_order.iter().position(|r| *r == child_ref) else {
            return Err(invalid(child, "B-18: the item is not top-level".into()));
        };
        spread.frames_in_order.remove(slot);
        let children = spread
            .nested_children
            .entry(container_id.clone())
            .or_default();
        let idx = child_index.unwrap_or(children.len()).min(children.len());
        children.insert(idx, child_ref);
        return Ok(AppliedOperation {
            op: Operation::PasteInto {
                container: container.clone(),
                child: acting.clone(),
                child_index,
            },
            inverse: Operation::ReleaseFrom {
                child: acting.clone(),
                restore_slot: Some(slot),
            },
            invalidation: InvalidationHint {
                structural: true,
                frame_geometry: vec![acting],
                ..Default::default()
            },
        });
    }
    Err(OperationError::NodeNotFound(child.clone()))
}

/// B-18 — `Operation::ReleaseFrom`. World transform preserved (see
/// the operation doc); the inverse `PasteInto` carries the host and
/// the child's slot in the host's list so undo re-nests exactly.
pub(super) fn apply_release_from(
    doc: &mut paged_scene::Document,
    child: &NodeId,
    restore_slot: Option<usize>,
) -> Result<AppliedOperation, OperationError> {
    for parsed in doc.spreads.iter_mut() {
        let spread = &mut parsed.spread;
        let Some(child_ref) = acting_ref(spread, child) else {
            continue;
        };
        let Some(acting) = super::layer::node_for_frame_ref(spread, child_ref) else {
            return Err(invalid(child, "B-18: the item's group has no id".into()));
        };
        let mut found: Option<(String, usize)> = None;
        for (host, children) in &spread.nested_children {
            if let Some(i) = children.iter().position(|r| *r == child_ref) {
                found = Some((host.clone(), i));
                break;
            }
        }
        let Some((host_id, child_idx)) = found else {
            return Err(invalid(
                child,
                "B-18: the item is not pasted into any container".into(),
            ));
        };
        // Resolve the host's kind for the inverse's NodeId. An
        // orphaned entry (its container was deleted) still releases —
        // that's the recovery path for trapped content — but its
        // inverse would name the dead container and fail on undo
        // (honest, and unreachable through the wire: deleting a
        // container is the only way to orphan an entry).
        let host_node = if spread
            .rectangles
            .iter()
            .any(|r| r.self_id.as_deref() == Some(host_id.as_str()))
        {
            NodeId::Rectangle(host_id.clone())
        } else if spread
            .ovals
            .iter()
            .any(|o| o.self_id.as_deref() == Some(host_id.as_str()))
        {
            NodeId::Oval(host_id.clone())
        } else {
            NodeId::Polygon(host_id.clone())
        };
        if let Some(children) = spread.nested_children.get_mut(&host_id) {
            children.remove(child_idx);
            if children.is_empty() {
                spread.nested_children.remove(&host_id);
            }
        }
        ensure_frames_in_order(spread);
        let len = spread.frames_in_order.len();
        let slot = restore_slot.unwrap_or(len).min(len);
        spread.frames_in_order.insert(slot, child_ref);
        return Ok(AppliedOperation {
            op: Operation::ReleaseFrom {
                child: acting.clone(),
                restore_slot,
            },
            inverse: Operation::PasteInto {
                container: host_node,
                child: acting.clone(),
                child_index: Some(child_idx),
            },
            invalidation: InvalidationHint {
                structural: true,
                frame_geometry: vec![acting],
                ..Default::default()
            },
        });
    }
    Err(OperationError::NodeNotFound(child.clone()))
}
