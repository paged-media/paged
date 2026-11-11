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
//! Engine ADR 1096 — the preset writes and the preset follow.
//!
//! - `frameShapePreset` (`Value::Text`): a [`PresetShape`] as JSON sets the
//!   item's preset and draws its anchors for it (unless they already are
//!   what it draws); `""` ends it and keeps the path (Expand Shape).
//! - `frameShapePresetAdjust` (`Value::Text`): adjust values as JSON
//!   (`[["adj", "val 5000"]]`), merged into the preset's, and the anchors
//!   drawn again.
//! - `frameShapePresetHandle` (`Value::PathPoint`): adjust handle
//!   `address.index` dragged to `position` (the item's own coordinates);
//!   the engine solves the adjust values and draws the preset again.
//! - **Follow.** After a write that moves or resizes an item (its path,
//!   transform, scale, rotation, flips or box), a live preset on it is
//!   refitted for its new box, the other items of the same shape (its
//!   detail item, its text frame) follow, and every connector glued to a
//!   moved item is routed again between its sites — in the same apply.
//!
//! Every inverse restores the touched items verbatim through the raw form
//! of `frameShapePreset` (`{"restore": …}`: preset, anchors, contour starts
//! and open flags, box and transform), which neither redraws nor follows,
//! so undo restores the model exactly (ADR 197).

use paged_model::live_shape::PresetShape;
use paged_model::{Bounds, PathAnchor, Polygon};
use paged_preset_geom::model as pm;
use paged_preset_geom::Site;
use paged_scene::Document;
use serde::{Deserialize, Serialize};

use super::helpers::find_polygon_mut;
use crate::error::OperationError;
use crate::operation::{
    AppliedOperation, InvalidationHint, NodeId, Operation, PathPointRole, PropertyPath, Value,
};

/// An item restored verbatim.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Restore {
    #[serde(default)]
    preset: Option<PresetShape>,
    anchors: Vec<[f32; 6]>,
    #[serde(default)]
    starts: Vec<usize>,
    #[serde(default)]
    open: Vec<bool>,
    bounds: [f32; 4],
    #[serde(default)]
    transform: Option<[f32; 6]>,
}

#[derive(Deserialize)]
struct RestoreEnvelope {
    restore: Restore,
}

fn flat(a: &PathAnchor) -> [f32; 6] {
    [
        a.anchor.0, a.anchor.1, a.left.0, a.left.1, a.right.0, a.right.1,
    ]
}

fn unflat(a: &[f32; 6]) -> PathAnchor {
    PathAnchor {
        anchor: (a[0], a[1]),
        left: (a[2], a[3]),
        right: (a[4], a[5]),
    }
}

fn bounds_array(b: Bounds) -> [f32; 4] {
    [b.top, b.left, b.bottom, b.right]
}

fn snapshot(p: &Polygon) -> Restore {
    Restore {
        preset: p.preset.clone(),
        anchors: p.anchors.iter().map(flat).collect(),
        starts: p.subpath_starts.clone(),
        open: p.subpath_open.clone(),
        bounds: bounds_array(p.bounds),
        transform: p.item_transform,
    }
}

fn put(p: &mut Polygon, r: Restore) {
    p.preset = r.preset;
    p.anchors = r.anchors.iter().map(unflat).collect();
    p.subpath_starts = r.starts;
    p.subpath_open = r.open;
    let [top, left, bottom, right] = r.bounds;
    p.bounds = Bounds {
        top,
        left,
        bottom,
        right,
    };
    p.item_transform = r.transform;
}

fn restore_op(id: &str, r: &Restore) -> Operation {
    Operation::SetProperty {
        node: NodeId::Polygon(id.to_string()),
        path: PropertyPath::FrameShapePreset,
        value: Value::Text(serde_json::json!({ "restore": r }).to_string()),
    }
}

fn geometry(nodes: Vec<NodeId>) -> InvalidationHint {
    InvalidationHint {
        frame_geometry: nodes,
        ..Default::default()
    }
}

/// Put drawn anchors on a polygon; its box follows them.
fn set_drawn(p: &mut Polygon, d: pm::Drawn) {
    if let Some(b) = d.bounds() {
        p.bounds = b;
    }
    p.anchors = d.anchors;
    p.subpath_starts = d.starts;
    p.subpath_open = d.open;
}

/// The three preset writes on a Polygon.
pub(super) fn apply_preset(
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
    let poly =
        find_polygon_mut(doc, id).ok_or_else(|| OperationError::NodeNotFound(node.clone()))?;
    let before = snapshot(poly);
    match (path, value) {
        (PropertyPath::FrameShapePreset, Value::Text(text)) => {
            let text = text.trim();
            if text.is_empty() {
                // Expand Shape: the path stays.
                poly.preset = None;
            } else if let Ok(env) = serde_json::from_str::<RestoreEnvelope>(text) {
                put(poly, env.restore);
            } else {
                let p: PresetShape = serde_json::from_str(text)
                    .map_err(|e| invalid(format!("not a preset shape: {e}")))?;
                if paged_preset_geom::preset_geometry(&p.name).is_none() {
                    return Err(invalid(format!("no preset named {:?}", p.name)));
                }
                if !(p.frame[2].is_finite() && p.frame[3].is_finite())
                    || p.frame[2] < 0.0
                    || p.frame[3] < 0.0
                {
                    return Err(invalid("a preset's box has a finite size".into()));
                }
                if !pm::anchors_are(&p, &poly.anchors, &poly.subpath_starts) {
                    let d =
                        pm::draw(&p).ok_or_else(|| invalid("the preset draws nothing".into()))?;
                    set_drawn(poly, d);
                }
                poly.preset = Some(p);
            }
        }
        (PropertyPath::FrameShapePresetAdjust, Value::Text(text)) => {
            let Some(mut p) = pm::live_preset(poly).cloned() else {
                return Err(invalid(
                    "the path is not a live preset; set its preset (frameShapePreset) first".into(),
                ));
            };
            let adj: Vec<(String, String)> = serde_json::from_str(text)
                .map_err(|e| invalid(format!("adjust values are [[name, formula], …]: {e}")))?;
            for (n, f) in adj {
                match p.adjusts.iter_mut().find(|(m, _)| *m == n) {
                    Some(slot) => slot.1 = f,
                    None => p.adjusts.push((n, f)),
                }
            }
            let d = pm::draw(&p).ok_or_else(|| invalid("the preset draws nothing".into()))?;
            set_drawn(poly, d);
            poly.preset = Some(p);
        }
        (PropertyPath::FrameShapePresetHandle, Value::PathPoint { address, position }) => {
            if address.role != PathPointRole::Anchor {
                return Err(invalid("an adjust handle is addressed by its index".into()));
            }
            let Some(mut p) = pm::live_preset(poly).cloned() else {
                return Err(invalid("the path is not a live preset".into()));
            };
            let adj = pm::drag_handle(
                &p,
                address.index,
                (f64::from(position[0]), f64::from(position[1])),
            )
            .ok_or_else(|| invalid(format!("the preset has no handle {}", address.index)))?;
            p.adjusts = adj;
            let d = pm::draw(&p).ok_or_else(|| invalid("the preset draws nothing".into()))?;
            set_drawn(poly, d);
            poly.preset = Some(p);
        }
        _ => {
            return Err(OperationError::TypeMismatch {
                path,
                expected: if path == PropertyPath::FrameShapePresetHandle {
                    "PathPoint".into()
                } else {
                    "Text".into()
                },
            })
        }
    }
    Ok(AppliedOperation {
        op: Operation::SetProperty {
            node: node.clone(),
            path,
            value: value.clone(),
        },
        inverse: restore_op(id, &before),
        invalidation: geometry(vec![node.clone()]),
    })
}

// ─── follow ─────────────────────────────────────────────────────────

/// The writes after which an item's presets and the connectors glued to
/// it follow.
pub(super) fn follows(path: PropertyPath) -> bool {
    matches!(
        path,
        PropertyPath::FramePath
            | PropertyPath::FrameTransform
            | PropertyPath::FrameBounds
            | PropertyPath::FrameScaleX
            | PropertyPath::FrameScaleY
            | PropertyPath::FrameRotationAngle
            | PropertyPath::FrameFlipH
            | PropertyPath::FrameFlipV
    )
}

/// Where an item glued to is: its preset (a polygon's) or its box, and
/// its transform.
fn glue_target(
    doc: &Document,
    id: &str,
) -> Option<(Option<PresetShape>, Bounds, Option<[f32; 6]>)> {
    for parsed in &doc.spreads {
        let s = &parsed.spread;
        let hit = |sid: &Option<String>| sid.as_deref() == Some(id);
        if let Some(p) = s.polygons.iter().find(|p| hit(&p.self_id)) {
            return Some((pm::live_preset(p).cloned(), p.bounds, p.item_transform));
        }
        if let Some(r) = s.rectangles.iter().find(|r| hit(&r.self_id)) {
            return Some((None, r.bounds, r.item_transform));
        }
        if let Some(f) = s.text_frames.iter().find(|f| hit(&f.self_id)) {
            return Some((None, f.bounds, f.item_transform));
        }
        if let Some(o) = s.ovals.iter().find(|o| hit(&o.self_id)) {
            return Some((None, o.bounds, o.item_transform));
        }
    }
    None
}

fn site_of(doc: &Document, id: &str, index: u32) -> Option<Site> {
    let (preset, bounds, t) = glue_target(doc, id)?;
    let sites = match preset {
        Some(p) => pm::sites(&p, t),
        None => pm::box_sites(bounds, t),
    };
    sites.get(index as usize).copied()
}

/// The id an item write addresses, when it is a page item.
fn item_id(node: &NodeId) -> Option<&str> {
    match node {
        NodeId::Polygon(id)
        | NodeId::Rectangle(id)
        | NodeId::TextFrame(id)
        | NodeId::Oval(id)
        | NodeId::GraphicLine(id) => Some(id),
        _ => None,
    }
}

/// What a follow will touch, snapshotted before the write.
pub(super) struct Before {
    item: Option<(String, Restore)>,
    companions: Vec<(String, Restore)>,
    texts: Vec<(String, Bounds, Option<[f32; 6]>)>,
    connectors: Vec<(String, Restore)>,
}

fn near_t(a: Option<[f32; 6]>, b: Option<[f32; 6]>) -> bool {
    let a = a.unwrap_or([1.0, 0.0, 0.0, 1.0, 0.0, 0.0]);
    let b = b.unwrap_or([1.0, 0.0, 0.0, 1.0, 0.0, 0.0]);
    a.iter().zip(b).all(|(x, y)| (x - y).abs() < 1e-3)
}

/// Snapshot what a follow after a write to `node` may touch; `None` when
/// nothing would follow (no preset on the item, nothing glued to it), so
/// the write keeps its own inverse.
pub(super) fn before(doc: &Document, node: &NodeId, path: PropertyPath) -> Option<Before> {
    if !follows(path) {
        return None;
    }
    let id = item_id(node)?;
    let mut b = Before {
        item: None,
        companions: Vec::new(),
        texts: Vec::new(),
        connectors: Vec::new(),
    };
    for parsed in &doc.spreads {
        let s = &parsed.spread;
        let Some(me) = s.polygons.iter().find(|p| p.self_id.as_deref() == Some(id)) else {
            continue;
        };
        if me.preset.is_some() && matches!(node, NodeId::Polygon(_)) {
            b.item = Some((id.to_string(), snapshot(me)));
            if let Some(key) = me.preset.as_ref().and_then(|p| p.key.clone()) {
                for p in &s.polygons {
                    let same = p.preset.as_ref().and_then(|q| q.key.as_deref()) == Some(&key);
                    if same
                        && p.self_id.as_deref() != Some(id)
                        && near_t(p.item_transform, me.item_transform)
                    {
                        b.companions
                            .push((p.self_id.clone().unwrap_or_default(), snapshot(p)));
                    }
                }
                for f in &s.text_frames {
                    let same = f.preset_text.as_ref().map(|t| t.key.as_str()) == Some(&key);
                    if same && near_t(f.item_transform, me.item_transform) {
                        b.texts.push((
                            f.self_id.clone().unwrap_or_default(),
                            f.bounds,
                            f.item_transform,
                        ));
                    }
                }
            }
        }
        break;
    }
    // Connectors glued to the item or one of its companions.
    let mut glued_to: Vec<&str> = vec![id];
    glued_to.extend(b.companions.iter().map(|(c, _)| c.as_str()));
    glued_to.extend(b.texts.iter().map(|(t, _, _)| t.as_str()));
    for parsed in &doc.spreads {
        for p in &parsed.spread.polygons {
            let Some(c) = p.preset.as_ref().and_then(|q| q.connector.as_ref()) else {
                continue;
            };
            let to = |g: &Option<paged_model::live_shape::PresetGlue>| {
                g.as_ref()
                    .is_some_and(|g| glued_to.contains(&g.item.as_str()))
            };
            if (to(&c.start) || to(&c.end)) && p.self_id.as_deref() != Some(id) {
                b.connectors
                    .push((p.self_id.clone().unwrap_or_default(), snapshot(p)));
            }
        }
    }
    (b.item.is_some() || !b.connectors.is_empty()).then_some(b)
}

fn find_text_frame_mut<'a>(
    doc: &'a mut Document,
    id: &str,
) -> Option<&'a mut paged_model::TextFrame> {
    super::helpers::find_text_frame_mut(doc, id)
}

/// After the write: refit the item's preset and its companions, route its
/// connectors. Returns the inverse that restores everything the write and
/// the follow touched, and the nodes the follow redrew; `None` when the
/// follow changed nothing (the write keeps its own inverse).
pub(super) fn follow(
    doc: &mut Document,
    before: Before,
    own_inverse: &Operation,
) -> Option<(Operation, Vec<NodeId>)> {
    let mut touched: Vec<NodeId> = Vec::new();
    let mut ops: Vec<Operation> = Vec::new();
    let mut item_restored = false;

    // 1. The item's own preset.
    if let Some((id, restore)) = &before.item {
        let refit = find_polygon_mut(doc, id).and_then(|p| pm::refit(p));
        if let Some(pm::Refit::Refitted(r)) = refit {
            let old = restore.preset.clone();
            if let Some(p) = find_polygon_mut(doc, id) {
                set_drawn(p, r.drawn.clone());
                p.item_transform = r.transform;
                p.preset = Some(r.preset.clone());
            }
            ops.push(restore_op(id, restore));
            item_restored = true;
            touched.push(NodeId::Polygon(id.clone()));
            // Its companions on the same box.
            for (cid, cr) in &before.companions {
                let Some(cp) = cr.preset.as_ref() else {
                    continue;
                };
                let Some((next, drawn)) = pm::companion(cp, &r.preset) else {
                    continue;
                };
                if let Some(c) = find_polygon_mut(doc, cid) {
                    set_drawn(c, drawn);
                    c.item_transform = r.transform;
                    c.preset = Some(next);
                    ops.push(restore_op(cid, cr));
                    touched.push(NodeId::Polygon(cid.clone()));
                }
            }
            // Its text frames: scaled with the box about its place.
            let (x, y) = old
                .as_ref()
                .map_or((0.0, 0.0), |p| (p.frame[0], p.frame[1]));
            let [nx, ny, _, _] = r.preset.frame;
            let (sx, sy) = (r.scale.0 as f32, r.scale.1 as f32);
            for (tid, tb, tt) in &before.texts {
                if let Some(f) = find_text_frame_mut(doc, tid) {
                    f.bounds = Bounds {
                        top: ny + (tb.top - y) * sy,
                        left: nx + (tb.left - x) * sx,
                        bottom: ny + (tb.bottom - y) * sy,
                        right: nx + (tb.right - x) * sx,
                    };
                    f.item_transform = r.transform;
                    ops.push(Operation::SetProperty {
                        node: NodeId::TextFrame(tid.clone()),
                        path: PropertyPath::FrameBounds,
                        value: Value::Bounds(bounds_array(*tb)),
                    });
                    ops.push(Operation::SetProperty {
                        node: NodeId::TextFrame(tid.clone()),
                        path: PropertyPath::FrameTransform,
                        value: Value::Transform(*tt),
                    });
                    touched.push(NodeId::TextFrame(tid.clone()));
                }
            }
        }
    }

    // 2. Connectors glued to what moved.
    for (cid, cr) in &before.connectors {
        let Some(cp) = cr.preset.clone() else {
            continue;
        };
        let Some(c) = cp.connector.clone() else {
            continue;
        };
        let Some((first, last)) = find_polygon_mut(doc, cid).and_then(|p| pm::connector_ends(p))
        else {
            continue;
        };
        let start = c
            .start
            .as_ref()
            .and_then(|g| site_of(doc, &g.item, g.site))
            .unwrap_or(Site {
                pos: first,
                angle: 180.0,
            });
        let end = c
            .end
            .as_ref()
            .and_then(|g| site_of(doc, &g.item, g.site))
            .unwrap_or(Site {
                pos: last,
                angle: 0.0,
            });
        let moved =
            |a: (f64, f64), b: (f64, f64)| (a.0 - b.0).abs() > 0.01 || (a.1 - b.1).abs() > 0.01;
        if !moved(start.pos, first) && !moved(end.pos, last) {
            continue;
        }
        let Some(routed) = pm::route(&cp, start, end) else {
            continue;
        };
        if let Some(p) = find_polygon_mut(doc, cid) {
            set_drawn(p, routed.drawn);
            p.item_transform = Some(routed.transform);
            p.preset = Some(routed.preset);
            ops.push(restore_op(cid, cr));
            touched.push(NodeId::Polygon(cid.clone()));
        }
    }

    if ops.is_empty() {
        return None;
    }
    // The item's own write is undone by its raw restore when it was
    // refitted; otherwise by its own inverse, first, so the connectors'
    // restores land last.
    let mut all = Vec::new();
    if !item_restored {
        all.push(own_inverse.clone());
    }
    all.extend(ops);
    Some((Operation::Batch { ops: all }, touched))
}
