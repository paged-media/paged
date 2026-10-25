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

//! Engine ADR 1018 — list level and Restart Numbering on paragraphs, with
//! an exact undo (`SetParagraphListState`).

use super::*;
use crate::operation::ParagraphListState;
use crate::InvalidationHint;

/// The story's paragraphs touching chars `[start, end)` (the caret's at
/// `start == end`), as the paragraph properties choose them.
fn targets(
    doc: &Document,
    story_id: &str,
    start: u32,
    end: u32,
) -> Result<Vec<usize>, OperationError> {
    let node = NodeId::StoryRange {
        story_id: story_id.to_string(),
        start,
        end,
    };
    if start > end {
        return Err(OperationError::InvalidValue {
            node,
            path: PropertyPath::ParagraphNumberingLevel,
            reason: format!("inverted range: start={start} > end={end}"),
        });
    }
    let story = doc
        .stories
        .iter()
        .find(|s| s.self_id == story_id)
        .ok_or_else(|| OperationError::NodeNotFound(node.clone()))?;
    let paragraphs = &story.story.paragraphs;
    let mut spans = Vec::with_capacity(paragraphs.len());
    let mut at = 0u32;
    for p in paragraphs {
        let n: u32 = p.runs.iter().map(|r| r.text.chars().count() as u32).sum();
        spans.push((at, at + n));
        at += n;
    }
    let found: Vec<usize> = if start == end {
        super::paragraph::caret_paragraphs(paragraphs, &spans, start)
    } else {
        spans
            .iter()
            .enumerate()
            .filter(|(_, (s, e))| !(*e <= start || *s >= end))
            .map(|(i, _)| i)
            .collect()
    };
    if found.is_empty() {
        return Err(OperationError::InvalidValue {
            node,
            path: PropertyPath::ParagraphNumberingLevel,
            reason: format!("[{start}, {end}) addresses no paragraph (story length {at})"),
        });
    }
    Ok(found)
}

fn state_of(p: &paged_model::Paragraph, index: usize) -> ParagraphListState {
    ParagraphListState {
        paragraph: index as u32,
        level: p.list_level.level,
        numbering_continue: p.numbering_continue,
        numbering_start_at: p.numbering_start_at,
    }
}

fn story_paragraphs_mut<'a>(
    doc: &'a mut Document,
    story_id: &str,
) -> Result<&'a mut Vec<paged_model::Paragraph>, OperationError> {
    doc.stories
        .iter_mut()
        .find(|s| s.self_id == story_id)
        .map(|s| &mut s.story.paragraphs)
        .ok_or_else(|| OperationError::NodeNotFound(NodeId::Story(story_id.to_string())))
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

/// Write `next` over the targets, returning the applied op (`op`) and the
/// exact prior states as the inverse.
fn write_states(
    doc: &mut Document,
    story_id: &str,
    op: Operation,
    next: impl Fn(&paged_model::Paragraph, &Document) -> ParagraphListState,
    targets: &[usize],
) -> Result<AppliedOperation, OperationError> {
    let planned: Vec<(ParagraphListState, ParagraphListState)> = {
        let story = doc
            .stories
            .iter()
            .find(|s| s.self_id == story_id)
            .expect("targets found the story");
        targets
            .iter()
            .map(|&i| {
                let p = &story.story.paragraphs[i];
                let mut n = next(p, doc);
                n.paragraph = i as u32;
                (state_of(p, i), n)
            })
            .collect()
    };
    let paragraphs = story_paragraphs_mut(doc, story_id)?;
    for (_, n) in &planned {
        set_state(&mut paragraphs[n.paragraph as usize], n);
    }
    Ok(AppliedOperation {
        op,
        inverse: Operation::SetParagraphListState {
            story_id: story_id.to_string(),
            entries: planned.into_iter().map(|(prior, _)| prior).collect(),
        },
        invalidation: reflow(doc, story_id),
    })
}

fn set_state(p: &mut paged_model::Paragraph, s: &ParagraphListState) {
    p.list_level.level = s.level;
    p.numbering_continue = s.numbering_continue;
    p.numbering_start_at = s.numbering_start_at;
}

pub(super) fn apply_set_list_level(
    doc: &mut Document,
    story_id: &str,
    start: u32,
    end: u32,
    level: Option<u32>,
    delta: Option<i32>,
) -> Result<AppliedOperation, OperationError> {
    if level.is_none() == delta.is_none() {
        return Err(OperationError::InvalidValue {
            node: NodeId::Story(story_id.to_string()),
            path: PropertyPath::ParagraphNumberingLevel,
            reason: "setListLevel takes exactly one of `level` and `delta`".to_string(),
        });
    }
    if let Some(l) = level {
        if !(1..=9).contains(&l) {
            return Err(OperationError::InvalidValue {
                node: NodeId::Story(story_id.to_string()),
                path: PropertyPath::ParagraphNumberingLevel,
                reason: format!("a list level is 1 to 9, not {l}"),
            });
        }
    }
    let found = targets(doc, story_id, start, end)?;
    let op = Operation::SetListLevel {
        story_id: story_id.to_string(),
        start,
        end,
        level,
        delta,
    };
    write_states(
        doc,
        story_id,
        op,
        |p, doc| {
            let mut s = state_of(p, 0);
            let current = p.list_level.level.unwrap_or_else(|| {
                doc.resolved_paragraph_attrs(p)
                    .list_level
                    .level
                    .unwrap_or(1)
            });
            let new = match (level, delta) {
                (Some(l), _) => l,
                (None, Some(d)) => (current as i64 + d as i64).clamp(1, 9) as u32,
                (None, None) => current,
            };
            s.level = Some(new);
            s
        },
        &found,
    )
}

pub(super) fn apply_restart_numbering(
    doc: &mut Document,
    story_id: &str,
    start: u32,
    end: u32,
    start_at: Option<i32>,
    continue_numbering: bool,
) -> Result<AppliedOperation, OperationError> {
    let found = targets(doc, story_id, start, end)?;
    let op = Operation::RestartNumbering {
        story_id: story_id.to_string(),
        start,
        end,
        start_at,
        continue_numbering,
    };
    write_states(
        doc,
        story_id,
        op,
        |p, _| {
            let mut s = state_of(p, 0);
            s.numbering_continue = Some(continue_numbering);
            if let Some(n) = start_at {
                s.numbering_start_at = Some(n);
            }
            s
        },
        &found,
    )
}

pub(super) fn apply_list_state(
    doc: &mut Document,
    story_id: &str,
    entries: &[ParagraphListState],
) -> Result<AppliedOperation, OperationError> {
    let paragraphs = story_paragraphs_mut(doc, story_id)?;
    let mut prior = Vec::with_capacity(entries.len());
    for e in entries {
        let i = e.paragraph as usize;
        let Some(p) = paragraphs.get_mut(i) else {
            return Err(OperationError::InvalidValue {
                node: NodeId::Story(story_id.to_string()),
                path: PropertyPath::ParagraphNumberingLevel,
                reason: format!("no paragraph {i}"),
            });
        };
        prior.push(state_of(p, i));
        set_state(p, e);
    }
    Ok(AppliedOperation {
        op: Operation::SetParagraphListState {
            story_id: story_id.to_string(),
            entries: entries.to_vec(),
        },
        inverse: Operation::SetParagraphListState {
            story_id: story_id.to_string(),
            entries: prior,
        },
        invalidation: reflow(doc, story_id),
    })
}
