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

//! Engine ADR 1308 — relink a placed picture: the frame's link source
//! (`LinkResourceURI`), its embedded bytes, the picture's transform inside
//! the frame and the link's recorded metadata, set together as one step.
//!
//! Every field is SET to what the op carries (an absent one clears), so
//! the inverse is the same op carrying the values it replaced, and undo
//! restores the link, the bytes, the transform and the metadata exactly.
//! The frame itself — its box, its path, its fitting — is not touched:
//! the model's lowering fills the transform so the new picture keeps the
//! size the old one had on the page.

use paged_scene::Document;

use crate::error::OperationError;
use crate::operation::{AppliedOperation, InvalidationHint, NodeId, Operation, PropertyPath};

use super::helpers::{find_oval_mut, find_polygon_mut, find_rectangle_mut};

/// The picture fields of a graphic frame, as one value.
struct Picture {
    link: Option<String>,
    bytes: Option<Vec<u8>>,
    transform: Option<[f32; 6]>,
    has_image_element: bool,
}

pub(super) fn apply_relink_image(
    doc: &mut Document,
    frame: &NodeId,
    image_uri: Option<&str>,
    bytes: Option<&[u8]>,
    image_transform: Option<[f32; 6]>,
    metadata_json: Option<&str>,
    // Inverse-only: the frame's `has_image_element` to restore; a forward
    // relink makes the frame an image frame.
    has_image_element: Option<bool>,
) -> Result<AppliedOperation, OperationError> {
    let id = match frame {
        NodeId::Rectangle(id) | NodeId::Oval(id) | NodeId::Polygon(id) => id.clone(),
        other => {
            return Err(OperationError::InvalidValue {
                node: other.clone(),
                path: PropertyPath::FrameFittingType,
                reason: "RelinkImage targets Rectangle / Oval / Polygon frames".to_string(),
            })
        }
    };
    let metadata: Option<paged_model::ImageMetadata> = match metadata_json {
        Some(json) => {
            Some(
                serde_json::from_str(json).map_err(|e| OperationError::InvalidValue {
                    node: frame.clone(),
                    path: PropertyPath::FrameFittingType,
                    reason: format!("malformed image metadata: {e}"),
                })?,
            )
        }
        None => None,
    };
    // A picture anchored in the text (ADR 208) keeps its link and its
    // transform on the story, and has no embedded-bytes lane.
    if matches!(frame, NodeId::Rectangle(_)) && find_rectangle_mut(doc, &id).is_none() {
        if let Some(af) = super::helpers::find_anchored_frame_mut(doc, &id) {
            if bytes.is_some() {
                return Err(OperationError::InvalidValue {
                    node: frame.clone(),
                    path: PropertyPath::FrameFittingType,
                    reason: "a picture anchored in the text is relinked to a source the engine \
                             can read (a URI without bytes): it has no embedded-bytes lane"
                        .to_string(),
                });
            }
            let prior_link = std::mem::replace(&mut af.image_link, image_uri.map(str::to_string));
            let prior_transform = std::mem::replace(&mut af.image_item_transform, image_transform);
            return Ok(AppliedOperation {
                op: Operation::RelinkImage {
                    frame: frame.clone(),
                    image_uri: image_uri.map(str::to_string),
                    bytes: None,
                    image_transform,
                    metadata_json: None,
                    has_image_element: None,
                },
                inverse: Operation::RelinkImage {
                    frame: frame.clone(),
                    image_uri: prior_link,
                    bytes: None,
                    image_transform: prior_transform,
                    metadata_json: None,
                    has_image_element: None,
                },
                invalidation: InvalidationHint {
                    structural: true,
                    ..Default::default()
                },
            });
        }
    }
    let next = Picture {
        link: image_uri.map(str::to_string),
        has_image_element: has_image_element.unwrap_or(true),
        bytes: bytes.map(<[u8]>::to_vec),
        transform: image_transform,
    };
    let prior = {
        let swap = |link: &mut Option<String>,
                    bytes: &mut Option<Vec<u8>>,
                    transform: &mut Option<[f32; 6]>,
                    has: &mut bool,
                    next: Picture| {
            Picture {
                link: std::mem::replace(link, next.link),
                bytes: std::mem::replace(bytes, next.bytes),
                transform: std::mem::replace(transform, next.transform),
                has_image_element: std::mem::replace(has, next.has_image_element),
            }
        };
        match frame {
            NodeId::Rectangle(_) => {
                let f = find_rectangle_mut(doc, &id)
                    .ok_or_else(|| OperationError::NodeNotFound(frame.clone()))?;
                swap(
                    &mut f.image_link,
                    &mut f.image_bytes,
                    &mut f.image_item_transform,
                    &mut f.has_image_element,
                    next,
                )
            }
            NodeId::Oval(_) => {
                let f = find_oval_mut(doc, &id)
                    .ok_or_else(|| OperationError::NodeNotFound(frame.clone()))?;
                swap(
                    &mut f.image_link,
                    &mut f.image_bytes,
                    &mut f.image_item_transform,
                    &mut f.has_image_element,
                    next,
                )
            }
            _ => {
                let f = find_polygon_mut(doc, &id)
                    .ok_or_else(|| OperationError::NodeNotFound(frame.clone()))?;
                swap(
                    &mut f.image_link,
                    &mut f.image_bytes,
                    &mut f.image_item_transform,
                    &mut f.has_image_element,
                    next,
                )
            }
        }
    };
    // The link's recorded metadata (colour space, ppi) describes the old
    // source; it lives in the frame's spread's side map.
    let mut prior_metadata = None;
    for parsed in &mut doc.spreads {
        let spread = &mut parsed.spread;
        let holds = spread
            .rectangles
            .iter()
            .any(|f| f.self_id.as_deref() == Some(id.as_str()))
            || spread
                .ovals
                .iter()
                .any(|f| f.self_id.as_deref() == Some(id.as_str()))
            || spread
                .polygons
                .iter()
                .any(|f| f.self_id.as_deref() == Some(id.as_str()));
        if holds {
            prior_metadata = spread.image_metadata.remove(&id);
            if let Some(m) = metadata.clone() {
                spread.image_metadata.insert(id.clone(), m);
            }
            break;
        }
    }
    let prior_metadata_json = prior_metadata
        .map(|m| serde_json::to_string(&m))
        .transpose()
        .map_err(|e| OperationError::InvalidValue {
            node: frame.clone(),
            path: PropertyPath::FrameFittingType,
            reason: format!("image metadata capture failed: {e}"),
        })?;
    Ok(AppliedOperation {
        op: Operation::RelinkImage {
            frame: frame.clone(),
            image_uri: image_uri.map(str::to_string),
            bytes: bytes.map(<[u8]>::to_vec),
            image_transform,
            metadata_json: metadata_json.map(str::to_string),
            has_image_element: Some(has_image_element.unwrap_or(true)),
        },
        inverse: Operation::RelinkImage {
            frame: frame.clone(),
            image_uri: prior.link,
            bytes: prior.bytes,
            image_transform: prior.transform,
            metadata_json: prior_metadata_json,
            has_image_element: Some(prior.has_image_element),
        },
        invalidation: InvalidationHint {
            frame_geometry: vec![frame.clone()],
            ..Default::default()
        },
    })
}
