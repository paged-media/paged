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

//! Removing and restoring a whole story — the inverse steps of a text
//! frame insert that minted its story. Internal: no wire mutation
//! produces these ops; they ride the undo log only.

use paged_scene::{Document, ParsedStory};

use crate::error::OperationError;
use crate::operation::{AppliedOperation, InvalidationHint, Operation};

fn structural() -> InvalidationHint {
    InvalidationHint {
        structural: true,
        ..Default::default()
    }
}

/// Remove `story_id`, capturing it whole (and its index) for the inverse.
pub(super) fn apply_remove_story(
    doc: &mut Document,
    story_id: &str,
) -> Result<AppliedOperation, OperationError> {
    let position = doc
        .stories
        .iter()
        .position(|s| s.self_id == story_id)
        .ok_or_else(|| OperationError::CollectionEntryNotFound {
            collection: "stories".to_string(),
            id: story_id.to_string(),
        })?;
    // A parsed story is plain data: serializing it cannot fail.
    let story_json =
        serde_json::to_string(&doc.stories[position]).expect("a parsed story serializes");
    doc.stories.remove(position);
    Ok(AppliedOperation {
        op: Operation::RemoveStory {
            story_id: story_id.to_string(),
        },
        inverse: Operation::RestoreStory {
            position,
            story_json,
        },
        invalidation: structural(),
    })
}

/// Put a captured story back at `position` (clamped to the list's end).
pub(super) fn apply_restore_story(
    doc: &mut Document,
    position: usize,
    story_json: &str,
) -> Result<AppliedOperation, OperationError> {
    let story: ParsedStory =
        serde_json::from_str(story_json).map_err(|e| OperationError::CollectionEntryNotFound {
            collection: "stories (captured story does not decode)".to_string(),
            id: e.to_string(),
        })?;
    if doc.stories.iter().any(|s| s.self_id == story.self_id) {
        return Err(OperationError::DuplicateNodeId { id: story.self_id });
    }
    let story_id = story.self_id.clone();
    let at = position.min(doc.stories.len());
    doc.stories.insert(at, story);
    Ok(AppliedOperation {
        op: Operation::RestoreStory {
            position,
            story_json: story_json.to_string(),
        },
        inverse: Operation::RemoveStory { story_id },
        invalidation: structural(),
    })
}

/// v0.71.13 — set a story's paragraphs to `paragraphs_json` (a JSON
/// `Vec<Paragraph>`), as Update Table of Contents writes a TOC story
/// (ADR 165). The inverse carries the paragraphs it replaced.
pub(super) fn apply_replace_story_paragraphs(
    doc: &mut Document,
    story_id: &str,
    paragraphs_json: &str,
) -> Result<AppliedOperation, OperationError> {
    let paragraphs: Vec<paged_model::Paragraph> =
        serde_json::from_str(paragraphs_json).map_err(|e| OperationError::InvalidParent {
            parent: crate::operation::NodeId::Story(story_id.to_string()),
            child_kind: format!("paragraphs that do not read ({e})"),
        })?;
    let parsed = doc
        .stories
        .iter_mut()
        .find(|s| s.self_id == story_id)
        .ok_or_else(|| {
            OperationError::NodeNotFound(crate::operation::NodeId::Story(story_id.to_string()))
        })?;
    let before = std::mem::replace(&mut parsed.story.paragraphs, paragraphs);
    // Plain data: serializing it cannot fail.
    let before_json = serde_json::to_string(&before).expect("paragraphs serialize");
    let invalidation = super::path_topology::reflow_hint_for_story(doc, story_id);
    Ok(AppliedOperation {
        op: Operation::ReplaceStoryParagraphs {
            story_id: story_id.to_string(),
            paragraphs_json: paragraphs_json.to_string(),
        },
        inverse: Operation::ReplaceStoryParagraphs {
            story_id: story_id.to_string(),
            paragraphs_json: before_json,
        },
        invalidation,
    })
}

/// The paragraphs `[first, last]` a `[start, end)` range edit touches,
/// counted as the run splitters count (each paragraph's run characters).
fn touched_paragraphs(
    paragraphs: &[paged_model::Paragraph],
    start: u32,
    end: u32,
) -> Option<(usize, usize)> {
    let mut offset = 0u32;
    let mut touched: Option<(usize, usize)> = None;
    for (i, para) in paragraphs.iter().enumerate() {
        let chars: u32 = para
            .runs
            .iter()
            .map(|r| r.text.chars().count() as u32)
            .sum();
        let (para_start, para_end) = (offset, offset + chars);
        offset = para_end;
        if para_end > start && para_start < end {
            touched = Some((touched.map_or(i, |(f, _)| f), i));
        }
    }
    touched
}

/// The [`Operation::RestoreParagraphs`] that puts back, as they are now,
/// the paragraphs a `[start, end)` range edit of `story_id` (of `cell`)
/// is about to touch: the exact inverse of an edit that splits runs.
/// `None` when the story, the cell or the range does not resolve (the
/// edit then reports that itself).
pub(super) fn capture_range_paragraphs(
    doc: &mut Document,
    story_id: &str,
    cell: Option<&crate::operation::CellAddr>,
    start: u32,
    end: u32,
) -> Option<Operation> {
    let parsed = doc.stories.iter_mut().find(|s| s.self_id == story_id)?;
    let paragraphs = super::cell_paragraphs_mut(&mut parsed.story, cell)?;
    let (first, last) = touched_paragraphs(paragraphs, start, end)?;
    let captured = &paragraphs[first..=last];
    Some(Operation::RestoreParagraphs {
        story_id: story_id.to_string(),
        cell: cell.cloned(),
        first: first as u32,
        count: captured.len() as u32,
        // Plain data: serializing it cannot fail.
        paragraphs_json: serde_json::to_string(captured).expect("paragraphs serialize"),
    })
}

/// Replace paragraphs `[first, first + count)` of a story (or of a cell's
/// stream) with `paragraphs_json`; the inverse carries what it replaced.
pub(super) fn apply_restore_paragraphs(
    doc: &mut Document,
    story_id: &str,
    cell: Option<&crate::operation::CellAddr>,
    first: u32,
    count: u32,
    paragraphs_json: &str,
) -> Result<AppliedOperation, OperationError> {
    let node = crate::operation::NodeId::Story(story_id.to_string());
    let restored: Vec<paged_model::Paragraph> =
        serde_json::from_str(paragraphs_json).map_err(|e| OperationError::InvalidParent {
            parent: node.clone(),
            child_kind: format!("paragraphs that do not read ({e})"),
        })?;
    let parsed = doc
        .stories
        .iter_mut()
        .find(|s| s.self_id == story_id)
        .ok_or_else(|| OperationError::NodeNotFound(node.clone()))?;
    let paragraphs = super::cell_paragraphs_mut(&mut parsed.story, cell)
        .ok_or_else(|| OperationError::NodeNotFound(node.clone()))?;
    let (first_i, end_i) = (first as usize, first as usize + count as usize);
    if end_i > paragraphs.len() {
        return Err(OperationError::InvalidPosition {
            parent: node,
            position: end_i,
            len: paragraphs.len(),
        });
    }
    let new_count = restored.len() as u32;
    let replaced: Vec<paged_model::Paragraph> =
        paragraphs.splice(first_i..end_i, restored).collect();
    let replaced_json = serde_json::to_string(&replaced).expect("paragraphs serialize");
    let invalidation = super::path_topology::reflow_hint_for_story(doc, story_id);
    Ok(AppliedOperation {
        op: Operation::RestoreParagraphs {
            story_id: story_id.to_string(),
            cell: cell.cloned(),
            first,
            count,
            paragraphs_json: paragraphs_json.to_string(),
        },
        inverse: Operation::RestoreParagraphs {
            story_id: story_id.to_string(),
            cell: cell.cloned(),
            first,
            count: new_count,
            paragraphs_json: replaced_json,
        },
        invalidation,
    })
}
