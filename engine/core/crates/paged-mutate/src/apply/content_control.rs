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

//! Engine ADR 1052 — a content control's value: set (free text, an item,
//! a date, a checkbox state), undone by putting the control's runs back
//! exactly as they were.

use super::*;
use crate::InvalidationHint;

/// Where a control's runs are: (story index, paragraph index, run range).
fn locate(
    doc: &Document,
    story_id: &str,
    control_id: &str,
) -> Result<(usize, usize, std::ops::Range<usize>), OperationError> {
    let not_found = || OperationError::CollectionEntryNotFound {
        collection: "contentControls".to_string(),
        id: control_id.to_string(),
    };
    let si = doc
        .stories
        .iter()
        .position(|s| s.self_id == story_id)
        .ok_or_else(|| OperationError::NodeNotFound(NodeId::Story(story_id.to_string())))?;
    for (pi, para) in doc.stories[si].story.paragraphs.iter().enumerate() {
        let is_it =
            |r: &paged_model::CharacterRun| r.control.as_ref().is_some_and(|c| c.id == control_id);
        if let Some(start) = para.runs.iter().position(is_it) {
            let len = para.runs[start..].iter().take_while(|r| is_it(r)).count();
            return Ok((si, pi, start..start + len));
        }
    }
    Err(not_found())
}

fn reflow(doc: &Document, story_id: &str) -> InvalidationHint {
    match doc
        .frame_for_story
        .get(story_id)
        .and_then(|f| f.self_id.clone())
    {
        Some(id) => InvalidationHint {
            text_reflow: vec![NodeId::TextFrame(id)],
            ..Default::default()
        },
        None => InvalidationHint::default(),
    }
}

fn invalid(control_id: &str, reason: String) -> OperationError {
    OperationError::InvalidControlValue {
        control_id: control_id.to_string(),
        reason,
    }
}

/// `SetContentControlValue`: the control's runs become one run with the
/// value's text, formatted as the control's first run (a checkbox's glyph
/// in its glyph's font; a placeholder's character style dropped).
pub(super) fn apply_set_value(
    doc: &mut Document,
    story_id: &str,
    control_id: &str,
    value: &str,
) -> Result<AppliedOperation, OperationError> {
    let (si, pi, range) = locate(doc, story_id, control_id)?;
    let runs = &doc.stories[si].story.paragraphs[pi].runs;
    let first = runs[range.start].clone();
    let control = first.control.clone().expect("located by its control");
    if control.content_locked() {
        return Err(invalid(control_id, "the control is locked".to_string()));
    }
    let (next, text) = control
        .with_value(value)
        .map_err(|reason| invalid(control_id, reason))?;
    let prior: Vec<paged_model::CharacterRun> = runs[range.clone()].to_vec();
    let mut run = first;
    if control.showing_placeholder
        && control.placeholder_style.is_some()
        && run.character_style == control.placeholder_style
    {
        run.character_style = None;
    }
    if let Some(font) = next.glyph_font() {
        run.font = Some(font.to_string());
    }
    run.text = text;
    run.control = Some(next);
    doc.stories[si].story.paragraphs[pi]
        .runs
        .splice(range, [run]);
    Ok(AppliedOperation {
        op: Operation::SetContentControlValue {
            story_id: story_id.to_string(),
            control_id: control_id.to_string(),
            value: value.to_string(),
        },
        inverse: Operation::RestoreContentControl {
            story_id: story_id.to_string(),
            control_id: control_id.to_string(),
            runs_json: serde_json::to_string(&prior).expect("runs serialise"),
        },
        invalidation: reflow(doc, story_id),
    })
}

/// `RestoreContentControl`: the control's runs replaced by `runs_json`
/// (the inverse of a value set, and of itself).
pub(super) fn apply_restore(
    doc: &mut Document,
    story_id: &str,
    control_id: &str,
    runs_json: &str,
) -> Result<AppliedOperation, OperationError> {
    let runs: Vec<paged_model::CharacterRun> = serde_json::from_str(runs_json)
        .map_err(|e| invalid(control_id, format!("runs_json: {e}")))?;
    if runs.is_empty()
        || runs
            .iter()
            .any(|r| r.control.as_ref().is_none_or(|c| c.id != control_id))
    {
        return Err(invalid(
            control_id,
            "the restored runs must all be the control's".to_string(),
        ));
    }
    let (si, pi, range) = locate(doc, story_id, control_id)?;
    let prior: Vec<paged_model::CharacterRun> =
        doc.stories[si].story.paragraphs[pi].runs[range.clone()].to_vec();
    doc.stories[si].story.paragraphs[pi]
        .runs
        .splice(range, runs);
    Ok(AppliedOperation {
        op: Operation::RestoreContentControl {
            story_id: story_id.to_string(),
            control_id: control_id.to_string(),
            runs_json: runs_json.to_string(),
        },
        inverse: Operation::RestoreContentControl {
            story_id: story_id.to_string(),
            control_id: control_id.to_string(),
            runs_json: serde_json::to_string(&prior).expect("runs serialise"),
        },
        invalidation: reflow(doc, story_id),
    })
}

/// The `CharacterContentControl` value: a JSON control, or `""` for none.
pub(crate) fn parse_control(value: &Value) -> Result<Option<paged_model::ContentControl>, String> {
    let Value::Text(s) = value else {
        return Err("expected Text".to_string());
    };
    if s.is_empty() {
        return Ok(None);
    }
    serde_json::from_str(s)
        .map(Some)
        .map_err(|e| format!("not a content control: {e}"))
}

/// Set a run's control; the prior value as the inverse carries it.
pub(crate) fn set_run_control(
    slot: &mut Option<paged_model::ContentControl>,
    path: PropertyPath,
    value: &Value,
) -> Result<(Value, Value), OperationError> {
    let next = parse_control(value).map_err(|reason| OperationError::InvalidValue {
        node: NodeId::Document(String::new()),
        path,
        reason,
    })?;
    let prev = std::mem::replace(slot, next);
    let prev = prev
        .map(|c| serde_json::to_string(&c).expect("a control serialises"))
        .unwrap_or_default();
    Ok((Value::Text(prev), value.clone()))
}
