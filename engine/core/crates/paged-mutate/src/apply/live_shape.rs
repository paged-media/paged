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

//! Engine ADR 10XX — the live-shape writes: a polygon's side count and
//! star inset, an oval's pie angles.
//!
//! A polygon write redraws the anchors (and the frame box follows them),
//! so its inverse is a batch: the parameters as they were (cleared, or
//! set back), then the anchors and the box as they were — the
//! parameters' own redraw comes first and the old path last, so undo
//! restores the model exactly (ADR 197) whether the path was live, stale
//! or never a live shape.

use paged_model::live_shape::{
    anchor_box, circle_box, live_polygon, polygon_anchors, polygon_anchors_in, PieAngles,
    PolygonShape, MAX_SIDES, MAX_STAR_INSET, MIN_SIDES,
};
use paged_scene::Document;

use super::helpers::{expect_length, find_oval_mut, find_polygon_mut};
use crate::error::OperationError;
use crate::operation::{
    AppliedOperation, InvalidationHint, NodeId, Operation, PathAnchorSpec, PropertyPath, Value,
};

fn geometry(node: &NodeId) -> InvalidationHint {
    InvalidationHint {
        frame_geometry: vec![node.clone()],
        ..Default::default()
    }
}

/// `FrameShapeSides` / `FrameShapeStarInset` on a Polygon.
pub(super) fn apply_polygon_shape(
    doc: &mut Document,
    node: &NodeId,
    id: &str,
    path: PropertyPath,
    value: &Value,
) -> Result<AppliedOperation, OperationError> {
    let invalid = |reason: String| OperationError::InvalidValue {
        node: node.clone(),
        path,
        reason,
    };
    let requested = expect_length(path, value)?;
    let poly =
        find_polygon_mut(doc, id).ok_or_else(|| OperationError::NodeNotFound(node.clone()))?;
    let live = live_polygon(poly);
    let prev_shape = poly.live_shape;
    let prev_anchors: Vec<PathAnchorSpec> = poly
        .anchors
        .iter()
        .map(PathAnchorSpec::from_parse)
        .collect();
    let prev_starts = poly.subpath_starts.clone();
    let prev_bounds = poly.bounds;

    // `None` = end the live shape (sides) / no inset.
    let next: Option<PolygonShape> = match path {
        PropertyPath::FrameShapeSides => match requested {
            None => None,
            Some(n) => {
                if !n.is_finite()
                    || n.fract() != 0.0
                    || n < MIN_SIDES as f32
                    || n > MAX_SIDES as f32
                {
                    return Err(invalid(format!(
                        "a polygon has a whole number of sides from {MIN_SIDES} to {MAX_SIDES}, not {n}"
                    )));
                }
                Some(PolygonShape::new(
                    n as u32,
                    live.map_or(0.0, |s| s.star_inset),
                ))
            }
        },
        _ => {
            let inset = requested.unwrap_or(0.0);
            if !inset.is_finite() || !(0.0..=MAX_STAR_INSET).contains(&inset) {
                return Err(invalid(format!(
                    "a star inset is a percentage from 0 to {MAX_STAR_INSET}, not {inset}"
                )));
            }
            match live {
                Some(shape) => Some(PolygonShape::new(shape.sides, inset)),
                // `None` on a path that is not live is what it reads: no
                // change.
                None if requested.is_none() => prev_shape,
                None => {
                    return Err(invalid(
                        "the path is not a live polygon; set its sides (frameShapeSides) first"
                            .into(),
                    ))
                }
            }
        }
    };

    let unchanged = path == PropertyPath::FrameShapeStarInset && live.is_none();
    if let Some(shape) = next.filter(|_| !unchanged) {
        let single_closed = poly.subpath_starts.len() <= 1
            && poly.subpath_starts.first().is_none_or(|s| *s == 0)
            && !poly.subpath_open.iter().any(|o| *o);
        if !single_closed {
            return Err(invalid(
                "a live polygon is one closed contour; this path is open or compound".into(),
            ));
        }
        // A live shape keeps its circle (the outer radius stays where it
        // was, as in Illustrator); any other path is fitted to its own
        // box (its points', or the frame's bounds for a polygon drawn from
        // its box alone).
        let frame = anchor_box(&poly.anchors).unwrap_or(poly.bounds);
        poly.anchors = match live {
            Some(current) => polygon_anchors_in(circle_box(frame, current), shape),
            None => polygon_anchors(frame, shape),
        };
        // The frame box follows the path (a pentagon is shorter than the
        // hexagon in the same circle), as it does after any path rewrite.
        if let Some(b) = anchor_box(&poly.anchors) {
            poly.bounds = b;
        }
    }
    poly.live_shape = next;

    // The inverse: parameters first, then the old anchors verbatim.
    let set = |path: PropertyPath, v: Option<f32>| Operation::SetProperty {
        node: node.clone(),
        path,
        value: Value::Length(v),
    };
    let mut ops = match prev_shape {
        None => vec![set(PropertyPath::FrameShapeSides, None)],
        Some(s) => vec![
            set(PropertyPath::FrameShapeSides, Some(s.sides as f32)),
            set(PropertyPath::FrameShapeStarInset, Some(s.star_inset)),
        ],
    };
    ops.push(Operation::SetProperty {
        node: node.clone(),
        path: PropertyPath::FramePath,
        value: Value::FramePath {
            anchors: prev_anchors,
            subpath_starts: prev_starts,
        },
    });
    ops.push(Operation::SetProperty {
        node: node.clone(),
        path: PropertyPath::FrameBounds,
        value: Value::Bounds([
            prev_bounds.top,
            prev_bounds.left,
            prev_bounds.bottom,
            prev_bounds.right,
        ]),
    });
    Ok(AppliedOperation {
        op: Operation::SetProperty {
            node: node.clone(),
            path,
            value: value.clone(),
        },
        inverse: Operation::Batch { ops },
        invalidation: geometry(node),
    })
}

/// `FrameShapePieStart` / `FrameShapePieEnd` on an Oval. The inverse is
/// the angle it replaced (the other angle is untouched, so setting it
/// back makes the same pie — or the whole ellipse — again).
pub(super) fn apply_pie_angle(
    doc: &mut Document,
    node: &NodeId,
    id: &str,
    path: PropertyPath,
    value: &Value,
) -> Result<AppliedOperation, OperationError> {
    let requested = expect_length(path, value)?;
    if requested.is_some_and(|v| !v.is_finite()) {
        return Err(OperationError::InvalidValue {
            node: node.clone(),
            path,
            reason: "a pie angle is a finite number of degrees".into(),
        });
    }
    let oval = find_oval_mut(doc, id).ok_or_else(|| OperationError::NodeNotFound(node.clone()))?;
    let start = paged_model::live_shape::pie_start(oval);
    let end = paged_model::live_shape::pie_end(oval);
    let (prev, pie) = if path == PropertyPath::FrameShapePieStart {
        (start, PieAngles::new(requested.unwrap_or(0.0), end))
    } else {
        (end, PieAngles::new(start, requested.unwrap_or(360.0)))
    };
    oval.pie = pie;
    Ok(AppliedOperation {
        op: Operation::SetProperty {
            node: node.clone(),
            path,
            value: value.clone(),
        },
        inverse: Operation::SetProperty {
            node: node.clone(),
            path,
            value: Value::Length(Some(prev)),
        },
        invalidation: geometry(node),
    })
}
