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

//! Engine ADR 1008 — the effect-stack paths (`FrameEffectStack` and the
//! three target twins), and the per-field effect paths on an item whose
//! object target stores a stack.
//!
//! A stack write replaces the target's whole stack
//! ([`SlotsMut::set_stack`]); its inverse carries a JSON snapshot of the
//! target's effect state, so undo restores the model exactly (ADR 197).
//!
//! A per-field write (`frameInnerShadowSize`, …) on an item with a stored
//! object stack reaches a DISABLED effect's parked parameters (they are
//! moved into the slot for the write and parked again after it), switches
//! a disabled effect back on in place (`*Enabled` true), and keeps the
//! stack in line with the slots. Its inverse is a stack snapshot too.

use paged_model::effect_stack::{EffectBearing, EffectTarget, IndesignEffect, TargetEffectState};
use paged_scene::Document;

use super::helpers::{
    find_oval_mut, find_polygon_mut, find_rectangle_mut, find_text_frame_mut, frame_style_hint,
};
use crate::error::OperationError;
use crate::operation::{
    AppliedOperation, EffectEntrySpec, InvalidationHint, NodeId, Operation, PropertyPath, Value,
};

/// The target a stack path addresses.
pub(super) fn stack_target(path: PropertyPath) -> Option<EffectTarget> {
    Some(match path {
        PropertyPath::FrameEffectStack => EffectTarget::Object,
        PropertyPath::FrameFillEffectStack => EffectTarget::Fill,
        PropertyPath::FrameStrokeEffectStack => EffectTarget::Stroke,
        PropertyPath::FrameContentEffectStack => EffectTarget::Content,
        _ => return None,
    })
}

fn find_bearing_mut<'a>(doc: &'a mut Document, node: &NodeId) -> Option<&'a mut dyn EffectBearing> {
    match node {
        NodeId::TextFrame(id) => find_text_frame_mut(doc, id).map(|f| f as &mut dyn EffectBearing),
        NodeId::Rectangle(id) => find_rectangle_mut(doc, id).map(|f| f as &mut dyn EffectBearing),
        NodeId::Oval(id) => find_oval_mut(doc, id).map(|f| f as &mut dyn EffectBearing),
        NodeId::Polygon(id) => find_polygon_mut(doc, id).map(|f| f as &mut dyn EffectBearing),
        _ => None,
    }
}

fn snapshot_value(item: &dyn EffectBearing, target: EffectTarget) -> Value {
    let state = item.effect_state(target);
    let Value::EffectStack { entries, .. } = crate::operation::effect_stack_value(item, target)
    else {
        unreachable!()
    };
    Value::EffectStack {
        entries,
        prev: serde_json::to_string(&state).ok(),
    }
}

fn applied(
    node: &NodeId,
    path: PropertyPath,
    value: &Value,
    inverse_path: PropertyPath,
    inverse: Value,
) -> AppliedOperation {
    AppliedOperation {
        op: Operation::SetProperty {
            node: node.clone(),
            path,
            value: value.clone(),
        },
        inverse: Operation::SetProperty {
            node: node.clone(),
            path: inverse_path,
            value: inverse,
        },
        invalidation: frame_style_hint(node),
    }
}

/// `FrameEffectStack` and its target twins.
pub(super) fn apply_effect_stack(
    doc: &mut Document,
    node: &NodeId,
    path: PropertyPath,
    value: &Value,
) -> Result<AppliedOperation, OperationError> {
    let target = stack_target(path).expect("a stack path");
    let Value::EffectStack { entries, prev } = value else {
        return Err(OperationError::TypeMismatch {
            path,
            expected: "EffectStack".to_string(),
        });
    };
    let refuse = |reason: String| OperationError::InvalidValue {
        node: node.clone(),
        path,
        reason,
    };
    let item =
        find_bearing_mut(doc, node).ok_or_else(|| OperationError::NodeNotFound(node.clone()))?;
    let inverse = snapshot_value(item, target);
    match prev {
        Some(json) => {
            let state: TargetEffectState = serde_json::from_str(json)
                .map_err(|e| refuse(format!("not an effect-state snapshot: {e}")))?;
            item.restore_effect_state(target, state);
        }
        None => {
            let stack = entries
                .iter()
                .map(EffectEntrySpec::to_model)
                .collect::<Result<Vec<_>, _>>()
                .map_err(refuse)?;
            let before = item.effect_state(target);
            if let Err(e) = item.effect_slots_mut(target).set_stack(stack) {
                item.restore_effect_state(target, before);
                return Err(refuse(e.to_string()));
            }
            item.tidy_targets();
        }
    }
    Ok(applied(node, path, value, path, inverse))
}

/// The InDesign effect an object-level per-field path edits, and whether
/// it is that effect's on/off switch.
fn object_effect_field(path: PropertyPath) -> Option<(IndesignEffect, bool)> {
    let name = format!("{path:?}");
    let rest = name.strip_prefix("Frame")?;
    let table: [(&str, IndesignEffect); 9] = [
        ("DropShadow", IndesignEffect::DropShadow),
        ("InnerShadow", IndesignEffect::InnerShadow),
        ("OuterGlow", IndesignEffect::OuterGlow),
        ("InnerGlow", IndesignEffect::InnerGlow),
        ("Bevel", IndesignEffect::BevelEmboss),
        ("Satin", IndesignEffect::Satin),
        ("DirectionalFeather", IndesignEffect::DirectionalFeather),
        ("GradientFeather", IndesignEffect::GradientFeather),
        ("Feather", IndesignEffect::Feather),
    ];
    let (kind, field) = table
        .iter()
        .find_map(|(p, k)| rest.strip_prefix(p).map(|f| (*k, f)))?;
    let switch = match kind {
        // `frameDropShadow` itself is the drop shadow's switch.
        IndesignEffect::DropShadow => field.is_empty(),
        _ => field == "Enabled",
    };
    Some((kind, switch))
}

/// Whether `node` stores an object-target stack.
fn has_object_stack(doc: &mut Document, node: &NodeId) -> bool {
    find_bearing_mut(doc, node)
        .is_some_and(|item| !item.effect_slots(EffectTarget::Object).stack.is_empty())
}

/// A per-field effect path on an item with a stored object stack, or
/// `None` to apply it the ordinary way.
pub(super) fn apply_effect_field_on_stack(
    doc: &mut Document,
    node: &NodeId,
    path: PropertyPath,
    value: &Value,
) -> Option<Result<AppliedOperation, OperationError>> {
    let (kind, switch) = object_effect_field(path)?;
    if !has_object_stack(doc, node) {
        return None;
    }
    let item = find_bearing_mut(doc, node)?;
    let inverse = snapshot_value(item, EffectTarget::Object);
    // `*Enabled` true on a disabled entry switches it back on in place,
    // with the parameters it had.
    if switch && matches!(value, Value::Bool(true)) {
        let mut stack = item.effect_slots(EffectTarget::Object).stack.to_vec();
        if let Some(e) = stack
            .iter_mut()
            .find(|e| e.effect.indesign() == Some(kind) && !e.enabled)
        {
            e.enabled = true;
            let result = item
                .effect_slots_mut(EffectTarget::Object)
                .set_stack(stack)
                .map_err(|e| OperationError::InvalidValue {
                    node: node.clone(),
                    path,
                    reason: e.to_string(),
                });
            return Some(
                result
                    .map(|()| applied(node, path, value, PropertyPath::FrameEffectStack, inverse)),
            );
        }
    }
    let moved = if switch {
        Vec::new()
    } else {
        item.effect_slots_mut(EffectTarget::Object).unpark()
    };
    let result = super::set_property::apply_set_property(doc, node, path, value);
    let item = find_bearing_mut(doc, node)?;
    item.effect_slots_mut(EffectTarget::Object).repark(&moved);
    Some(result.map(|a| AppliedOperation {
        inverse: Operation::SetProperty {
            node: node.clone(),
            path: PropertyPath::FrameEffectStack,
            value: inverse,
        },
        invalidation: merge(a.invalidation, frame_style_hint(node)),
        ..a
    }))
}

fn merge(mut a: InvalidationHint, b: InvalidationHint) -> InvalidationHint {
    for n in b.frame_style {
        if !a.frame_style.contains(&n) {
            a.frame_style.push(n);
        }
    }
    a
}
