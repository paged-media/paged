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

//! Engine ADR 1043 — the appearance paths (`FrameAppearance`,
//! `FrameAppearanceLayer`).
//!
//! A write replaces the stored layers with a normalised list
//! ([`paged_model::appearance::normalize`]); its inverse is a
//! `FrameAppearance` write carrying a JSON snapshot of the layers before,
//! so undo restores the model exactly (ADR 197).

use paged_model::appearance::{normalize, AppearanceBearing, PaintLayer};
use paged_scene::Document;

use super::helpers::{
    find_oval_mut, find_polygon_mut, find_rectangle_mut, find_text_frame_mut, frame_style_hint,
};
use crate::appearance_wire::PaintLayerSpec;
use crate::error::OperationError;
use crate::operation::{AppliedOperation, NodeId, Operation, PropertyPath, Value};

fn find_bearing_mut<'a>(
    doc: &'a mut Document,
    node: &NodeId,
) -> Option<&'a mut dyn AppearanceBearing> {
    match node {
        NodeId::TextFrame(id) => {
            find_text_frame_mut(doc, id).map(|f| f as &mut dyn AppearanceBearing)
        }
        NodeId::Rectangle(id) => {
            find_rectangle_mut(doc, id).map(|f| f as &mut dyn AppearanceBearing)
        }
        NodeId::Oval(id) => find_oval_mut(doc, id).map(|f| f as &mut dyn AppearanceBearing),
        NodeId::Polygon(id) => find_polygon_mut(doc, id).map(|f| f as &mut dyn AppearanceBearing),
        _ => None,
    }
}

/// `FrameAppearance` and `FrameAppearanceLayer`.
pub(super) fn apply_appearance(
    doc: &mut Document,
    node: &NodeId,
    path: PropertyPath,
    value: &Value,
) -> Result<AppliedOperation, OperationError> {
    let refuse = |reason: String| OperationError::InvalidValue {
        node: node.clone(),
        path,
        reason,
    };
    let item = match node {
        NodeId::TextFrame(_) | NodeId::Rectangle(_) | NodeId::Oval(_) | NodeId::Polygon(_) => {
            find_bearing_mut(doc, node).ok_or_else(|| OperationError::NodeNotFound(node.clone()))?
        }
        _ => {
            return Err(OperationError::UnsupportedProperty {
                node: node.clone(),
                path,
            })
        }
    };
    let before = item.appearance().to_vec();
    let next: Vec<PaintLayer> = match (path, value) {
        (
            PropertyPath::FrameAppearance,
            Value::Appearance {
                prev: Some(json), ..
            },
        ) => serde_json::from_str(json)
            .map_err(|e| refuse(format!("not an appearance snapshot: {e}")))?,
        (PropertyPath::FrameAppearance, Value::Appearance { layers, prev: None }) => {
            let layers = layers
                .iter()
                .map(PaintLayerSpec::to_model)
                .collect::<Result<Vec<_>, _>>()
                .map_err(refuse)?;
            normalize(layers).map_err(|e| refuse(e.to_string()))?
        }
        (PropertyPath::FrameAppearanceLayer, Value::AppearanceLayer { index, layer }) => {
            let layer = layer.to_model().map_err(refuse)?;
            let mut list = before.clone();
            let i = *index as usize;
            match i.cmp(&list.len()) {
                std::cmp::Ordering::Less => list[i] = layer,
                std::cmp::Ordering::Equal => list.push(layer),
                std::cmp::Ordering::Greater => {
                    return Err(refuse(format!(
                        "layer {i} is past the end of the appearance ({} layers)",
                        list.len()
                    )))
                }
            }
            normalize(list).map_err(|e| refuse(e.to_string()))?
        }
        _ => {
            return Err(OperationError::TypeMismatch {
                path,
                expected: if path == PropertyPath::FrameAppearance {
                    "Appearance"
                } else {
                    "AppearanceLayer"
                }
                .to_string(),
            })
        }
    };
    *item.appearance_mut() = next;
    let inverse = Value::Appearance {
        layers: before.iter().map(PaintLayerSpec::from_model).collect(),
        prev: serde_json::to_string(&before).ok(),
    };
    Ok(AppliedOperation {
        op: Operation::SetProperty {
            node: node.clone(),
            path,
            value: value.clone(),
        },
        inverse: Operation::SetProperty {
            node: node.clone(),
            path: PropertyPath::FrameAppearance,
            value: inverse,
        },
        invalidation: frame_style_hint(node),
    })
}
