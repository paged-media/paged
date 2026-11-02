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

//! Engine ADR 1045 — an anchored frame's look, through the free frames'
//! own paths.
//!
//! An anchored frame (`paged_model::AnchoredFrame`, on a paragraph of its
//! story) is addressed by its own page-item `NodeId` — the kind it is
//! (`Rectangle`, `TextFrame`) and its `Self` id — exactly as the
//! anchored-object settings are (W1.16). The frame paths a free frame
//! takes reach it too: its fill and stroke colours, weight and tint (the
//! arms below), and, through the finders in `helpers` and the effect
//! stack's `find_bearing_mut`, the stroke style, the gradient placement,
//! the opacity and blend mode, the drop shadow, InDesign's other effects,
//! the effect stack and the three transparency targets. A free frame of
//! the same id is always found first: the anchored frame is the fallback.

use paged_scene::Document;

use super::helpers::{
    expect_color_ref, expect_length, expect_transform, frame_style_hint, node_exists,
};
use crate::error::OperationError;
use crate::operation::{InvalidationHint, NodeId, PropertyPath, Value};

/// Whether `node` names an anchored frame and no page item on a spread: a
/// `Rectangle` or `TextFrame` id found in a story. An anchored `Group`
/// is not one: its members paint, and the renderer draws no look of the
/// group's own, so its look paths stay refused rather than stored
/// undrawn.
pub(super) fn names_anchored(doc: &Document, node: &NodeId) -> bool {
    let id = match node {
        NodeId::Rectangle(id) | NodeId::TextFrame(id) => id.as_str(),
        _ => return false,
    };
    !node_exists(doc, node)
        && frame(doc, id)
            .is_some_and(|f| !matches!(f.frame_kind, paged_model::AnchoredFrameKind::Group))
}

fn frame<'a>(doc: &'a Document, id: &str) -> Option<&'a paged_model::AnchoredFrame> {
    // Engine ADR 1050: the frames in table cells too.
    doc.stories
        .iter()
        .find_map(|s| paged_model::anchored_frame_in(&s.story.paragraphs, id))
}

/// The anchored frame `self_id`, at any depth of an anchored group and in
/// table cells.
pub(super) fn find_anchored_frame_mut<'a>(
    doc: &'a mut Document,
    self_id: &str,
) -> Option<&'a mut paged_model::AnchoredFrame> {
    doc.stories
        .iter_mut()
        .find_map(|s| paged_model::anchored_frame_in_mut(&mut s.story.paragraphs, self_id))
}

/// The anchored frame `node` names (see [`names_anchored`]); the caller
/// has checked that it names one.
pub(super) fn frame_mut<'a>(
    doc: &'a mut Document,
    node: &NodeId,
) -> Option<&'a mut paged_model::AnchoredFrame> {
    find_anchored_frame_mut(doc, node.self_id())
}

/// The fill and stroke paths whose free-frame arms address the frame kind
/// directly: on an anchored frame, the previous value and the hint, or
/// `None` when `node` is not an anchored frame or `path` is not one of
/// them.
pub(super) fn apply_paint(
    doc: &mut Document,
    node: &NodeId,
    path: PropertyPath,
    value: &Value,
) -> Option<Result<(Value, InvalidationHint), OperationError>> {
    if !matches!(
        path,
        PropertyPath::FrameFillColor
            | PropertyPath::FrameStrokeColor
            | PropertyPath::FrameStrokeWeight
            | PropertyPath::FrameFillTint
            | PropertyPath::FrameOpacity
            | PropertyPath::ImageContentTransform
    ) || !names_anchored(doc, node)
    {
        return None;
    }
    if path == PropertyPath::ImageContentTransform {
        return Some(image_placement(doc, node, value));
    }
    Some(paint(doc, node, path, value))
}

/// Engine ADR 1045 amendment — the placement of an anchored picture
/// (`imageContentTransform`): the inner `<Image>` transform a free
/// rectangle carries, in the frame's own box (origin at its top left,
/// natural pixels to points), which is how a crop or a fit reaches a
/// picture the lowering placed with `insertAnchoredFrame`. Only a
/// picture frame has an image to place.
fn image_placement(
    doc: &mut Document,
    node: &NodeId,
    value: &Value,
) -> Result<(Value, InvalidationHint), OperationError> {
    let path = PropertyPath::ImageContentTransform;
    let next = expect_transform(path, value)?;
    let f = frame_mut(doc, node).ok_or_else(|| OperationError::NodeNotFound(node.clone()))?;
    if f.image_link.is_none() {
        return Err(OperationError::UnsupportedProperty {
            node: node.clone(),
            path,
        });
    }
    let prev = std::mem::replace(&mut f.image_item_transform, next);
    Ok((
        Value::Transform(prev),
        InvalidationHint {
            frame_geometry: vec![node.clone()],
            ..Default::default()
        },
    ))
}

fn paint(
    doc: &mut Document,
    node: &NodeId,
    path: PropertyPath,
    value: &Value,
) -> Result<(Value, InvalidationHint), OperationError> {
    let previous = match path {
        PropertyPath::FrameFillColor | PropertyPath::FrameStrokeColor => {
            let next = expect_color_ref(path, value)?;
            let f =
                frame_mut(doc, node).ok_or_else(|| OperationError::NodeNotFound(node.clone()))?;
            let slot = if path == PropertyPath::FrameFillColor {
                &mut f.fill_color
            } else {
                &mut f.stroke_color
            };
            Value::ColorRef(std::mem::replace(slot, next))
        }
        _ => {
            let next = expect_length(path, value)?;
            let f =
                frame_mut(doc, node).ok_or_else(|| OperationError::NodeNotFound(node.clone()))?;
            let slot = match path {
                PropertyPath::FrameStrokeWeight => &mut f.stroke_weight,
                PropertyPath::FrameFillTint => &mut f.fill_tint,
                _ => &mut f.opacity,
            };
            Value::Length(std::mem::replace(slot, next))
        }
    };
    Ok((previous, frame_style_hint(node)))
}
