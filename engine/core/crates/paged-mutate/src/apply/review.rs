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

//! Engine ADRs 1040 and 1020 — tracked changes recorded, accepted and
//! rejected, and range comments with threads.
//!
//! - [`Operation::RecordChange`] marks a range (or a paragraph) as
//!   changed: what an importer writes for Word's revisions, and what the
//!   canvas lowers a tracked text edit to.
//! - [`Operation::AcceptChange`] / [`Operation::RejectChange`] resolve one
//!   change, an author's or all. They are each other's opposite: over a
//!   document whose changes were all recorded by tracked edits, rejecting
//!   everything gives back the document before the edits, and accepting
//!   everything gives the document the same edits make untracked.
//! - While the document tracks changes, a character or paragraph property
//!   or a style set on a story range is applied and then recorded as a
//!   formatting change against the properties before it
//!   ([`tracked_format`]).
//! - The comment operations edit a story's threads and the runs their
//!   ranges cover.
//!
//! Every operation here undoes in one step through
//! [`Operation::RestoreParagraphs`] or [`Operation::RestoreStoryReview`].

use paged_model::review::{isolate_para_chars, paragraph_chars, story_char_pieces};
use paged_model::{
    Change, ChangeKind, CharacterRun, Comment, FormatChange, ParaPropsChange, Paragraph,
    NOTE_MARKER, TRACKED_DELETION_MARKER,
};
use paged_scene::Document;

use crate::error::OperationError;
use crate::operation::{
    AppliedOperation, CellAddr, ChangeSpec, ChangeSpecKind, CommentSpec, InvalidationHint, NodeId,
    Operation,
};

use super::path_topology::reflow_hint_for_story;

/// Whether the document records changes now.
pub(crate) fn tracking(doc: &Document) -> bool {
    doc.designmap.document_preference.track_changes == Some(true)
}

/// The author and date a change recorded now carries.
fn stamp(doc: &Document) -> (Option<String>, Option<String>) {
    (
        doc.designmap
            .document_preference
            .track_changes_author
            .clone(),
        doc.designmap.document_preference.review_clock.clone(),
    )
}

fn not_found(collection: &str, id: impl Into<String>) -> OperationError {
    OperationError::CollectionEntryNotFound {
        collection: collection.to_string(),
        id: id.into(),
    }
}

fn story_index(doc: &Document, story_id: &str) -> Result<usize, OperationError> {
    doc.stories
        .iter()
        .position(|s| s.self_id == story_id)
        .ok_or_else(|| OperationError::NodeNotFound(NodeId::Story(story_id.to_string())))
}

fn json<T: serde::Serialize>(v: &T) -> String {
    // Plain data: serializing it cannot fail.
    serde_json::to_string(v).expect("model data serializes")
}

/// One past the largest numeric id `ids` holds (Word's ids are numbers).
fn next_numeric<'a>(ids: impl Iterator<Item = &'a str>) -> String {
    let max = ids.filter_map(|id| id.parse::<u64>().ok()).max();
    max.map_or(1, |m| m + 1).to_string()
}

/// A change id no change of the document carries yet.
pub fn next_change_id(doc: &Document) -> String {
    let mut ids: Vec<&str> = Vec::new();
    for s in &doc.stories {
        for c in paged_model::review::changes_in(&s.story.paragraphs) {
            ids.push(&c.id);
        }
    }
    next_numeric(ids.into_iter())
}

/// A comment id no comment of the document carries yet.
pub fn next_comment_id(doc: &Document) -> String {
    next_numeric(
        doc.stories
            .iter()
            .flat_map(|s| s.story.comments.iter().map(|c| c.id.as_str())),
    )
}

/// The story holding comment `id`.
pub fn comment_story(doc: &Document, id: &str) -> Option<String> {
    doc.stories
        .iter()
        .find(|s| s.story.comments.iter().any(|c| c.id == id))
        .map(|s| s.self_id.clone())
}

// ---------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------

/// Remove paragraph-local chars `[from, to)` and what stands on them: the
/// notes and tracked deletions whose markers they are, and the footnotes
/// and anchored objects anchored inside them.
pub(crate) fn remove_para_chars(para: &mut Paragraph, from: u32, to: u32) {
    if from >= to {
        return;
    }
    let chars: Vec<char> = para.runs.iter().flat_map(|r| r.text.chars()).collect();
    // Markers counted by order: the k-th marker is the k-th entry.
    let drop_by_marker = |marker: char, len: usize| -> Vec<usize> {
        let mut k = 0usize;
        let mut out = Vec::new();
        for (i, c) in chars.iter().enumerate() {
            if *c == marker {
                if (i as u32) >= from && (i as u32) < to && k < len {
                    out.push(k);
                }
                k += 1;
            }
        }
        out
    };
    for k in drop_by_marker(NOTE_MARKER, para.notes.len())
        .into_iter()
        .rev()
    {
        para.notes.remove(k);
    }
    for k in drop_by_marker(TRACKED_DELETION_MARKER, para.tracked_deletions.len())
        .into_iter()
        .rev()
    {
        para.tracked_deletions.remove(k);
    }
    para.footnotes
        .retain(|f| f.anchor.is_none_or(|a| a < from || a >= to));
    let mut k = 0;
    while k < para.anchored_frame_offsets.len() {
        let a = para.anchored_frame_offsets[k];
        if a >= from && a < to && k < para.anchored_frames.len() {
            para.anchored_frame_offsets.remove(k);
            para.anchored_frames.remove(k);
        } else {
            k += 1;
        }
    }
    // The characters themselves.
    let mut pos = 0u32;
    for r in para.runs.iter_mut() {
        let n = r.text.chars().count() as u32;
        let (a, b) = (from.max(pos), to.min(pos + n));
        if a < b {
            let kept: String = r
                .text
                .chars()
                .enumerate()
                .filter(|(i, _)| {
                    let at = pos + *i as u32;
                    at < a || at >= b
                })
                .map(|(_, c)| c)
                .collect();
            r.text = kept;
        }
        pos += n;
    }
    drop_empty_runs(para);
    para.shift_anchors(from, -i64::from(to - from));
}

/// Drop runs left without text, keeping one (empty) run so the paragraph
/// keeps the formatting text typed into it takes.
fn drop_empty_runs(para: &mut Paragraph) {
    if para.runs.iter().all(|r| r.text.is_empty()) {
        para.runs.truncate(1);
        return;
    }
    para.runs.retain(|r| !r.text.is_empty());
}

/// Join paragraph `i` with the one after it, as removing `i`'s paragraph
/// mark does: `i` keeps its properties (as a text delete across the break
/// keeps them), takes the next one's text and anchored content, and ends
/// with the next one's mark.
pub(crate) fn join_with_next(paragraphs: &mut Vec<Paragraph>, i: usize) -> bool {
    if i + 1 >= paragraphs.len() {
        return false;
    }
    if paragraphs[i].table.is_some() && paragraphs[i + 1].table.is_some() {
        return false;
    }
    let next = paragraphs.remove(i + 1);
    let p = &mut paragraphs[i];
    let base = paragraph_chars(p);
    if p.runs.iter().all(|r| r.text.is_empty()) && !next.runs.is_empty() {
        p.runs.clear();
    }
    let next_runs: Vec<CharacterRun> = if next.runs.iter().all(|r| r.text.is_empty()) {
        Vec::new()
    } else {
        next.runs
    };
    p.runs.extend(next_runs);
    p.anchored_frames.extend(next.anchored_frames);
    p.anchored_frame_offsets
        .extend(next.anchored_frame_offsets.into_iter().map(|o| o + base));
    p.footnotes.extend(next.footnotes.into_iter().map(|mut f| {
        f.anchor = Some(f.anchor.unwrap_or(0) + base);
        f
    }));
    p.endnote_references.extend(next.endnote_references);
    p.endnote_ranges.extend(next.endnote_ranges);
    p.notes.extend(next.notes.into_iter().map(|mut n| {
        n.anchor += base;
        n
    }));
    p.tracked_deletions.extend(next.tracked_deletions);
    p.index_markers.extend(next.index_markers);
    if p.table.is_none() && next.table.is_some() {
        p.table = next.table;
        p.table_anchor = Some(next.table_anchor.unwrap_or(0) + base);
    }
    p.mark_revision = next.mark_revision;
    true
}

// ---------------------------------------------------------------------
// RecordChange
// ---------------------------------------------------------------------

/// The change a new change of `kind` by `author` over story chars
/// `[at, end)` joins: one its first character already carries, else the
/// one on the character just before it, else the one just after it.
fn adjacent_change(
    paragraphs: &[Paragraph],
    at: u32,
    end: u32,
    kind: ChangeKind,
    author: Option<&str>,
) -> Option<Change> {
    let covering = |c: u32| -> Option<&Change> {
        let mut pos = 0u32;
        for p in paragraphs {
            for r in &p.runs {
                let n = r.text.chars().count() as u32;
                if c >= pos && c < pos + n {
                    return r.revision.as_ref();
                }
                pos += n;
            }
        }
        None
    };
    let fits = |c: &&Change| c.kind == kind && c.author.as_deref() == author;
    covering(at)
        .filter(fits)
        .or_else(|| at.checked_sub(1).and_then(covering).filter(fits))
        .or_else(|| covering(end).filter(fits))
        .cloned()
}

#[allow(clippy::too_many_arguments)]
pub(super) fn apply_record_change(
    doc: &mut Document,
    story_id: &str,
    cell: Option<&CellAddr>,
    start: u32,
    end: u32,
    paragraph: Option<u32>,
    spec: &ChangeSpec,
) -> Result<AppliedOperation, OperationError> {
    let si = story_index(doc, story_id)?;
    let node = || NodeId::Story(story_id.to_string());
    let paragraph_kind = matches!(
        spec.kind,
        ChangeSpecKind::ParaProps | ChangeSpecKind::InsertMark | ChangeSpecKind::DeleteMark
    );
    let kind = match spec.kind {
        ChangeSpecKind::Insert | ChangeSpecKind::InsertMark => ChangeKind::Insert,
        ChangeSpecKind::Delete | ChangeSpecKind::DeleteMark => ChangeKind::Delete,
        ChangeSpecKind::Format => ChangeKind::Format,
        ChangeSpecKind::ParaProps => ChangeKind::ParaProps,
    };
    // The id: the caller's, an adjacent change's of the same kind and
    // author, or a new one.
    let joined = (spec.id.is_none()
        && matches!(spec.kind, ChangeSpecKind::Insert | ChangeSpecKind::Delete))
    .then(|| {
        let paragraphs = super::cell_paragraphs_mut(&mut doc.stories[si].story, cell)?;
        adjacent_change(paragraphs, start, end, kind, spec.author.as_deref())
    })
    .flatten();
    let change = match joined {
        Some(c) => c,
        None => Change {
            id: spec.id.clone().unwrap_or_else(|| next_change_id(doc)),
            kind,
            author: spec.author.clone(),
            date: spec.date.clone(),
        },
    };
    let paragraphs = super::cell_paragraphs_mut(&mut doc.stories[si].story, cell)
        .ok_or_else(|| OperationError::NodeNotFound(node()))?;
    // What the inverse puts back: the paragraphs the change lands on.
    let (first, last) = if paragraph_kind {
        let p = paragraph.ok_or_else(|| OperationError::TypeMismatch {
            path: crate::operation::PropertyPath::ParagraphJustification,
            expected: "a paragraph index for a paragraph change".to_string(),
        })? as usize;
        if p >= paragraphs.len() {
            return Err(OperationError::InvalidPosition {
                parent: node(),
                position: p,
                len: paragraphs.len(),
            });
        }
        (p, p)
    } else {
        let pieces = story_char_pieces(paragraphs, start, end);
        match (pieces.first(), pieces.last()) {
            (Some(a), Some(b)) => (a.0, b.0),
            // Nothing to mark: an empty range.
            _ => {
                return Ok(AppliedOperation {
                    op: Operation::RecordChange {
                        story_id: story_id.to_string(),
                        cell: cell.cloned(),
                        start,
                        end,
                        paragraph,
                        change: spec.clone(),
                    },
                    inverse: Operation::Batch { ops: Vec::new() },
                    invalidation: InvalidationHint::default(),
                })
            }
        }
    };
    let before_json = json(&paragraphs[first..=last].to_vec());
    match spec.kind {
        ChangeSpecKind::Insert | ChangeSpecKind::Delete | ChangeSpecKind::Format => {
            for (pi, from, to) in story_char_pieces(paragraphs, start, end) {
                let para = &mut paragraphs[pi];
                for ri in isolate_para_chars(para, from, to) {
                    let run = &mut para.runs[ri];
                    if spec.kind == ChangeSpecKind::Format {
                        if run.format_change.is_none() {
                            let mut before = run.props_snapshot();
                            if let Some(style) = &spec.before_character_style {
                                before.character_style = Some(style.clone());
                            }
                            run.format_change = Some(FormatChange {
                                change: change.clone(),
                                before: Box::new(before),
                            });
                        }
                    } else {
                        run.revision = Some(change.clone());
                    }
                }
            }
        }
        ChangeSpecKind::ParaProps => {
            let para = &mut paragraphs[first];
            if para.props_change.is_none() {
                let mut before = para.props_snapshot();
                if let Some(style) = &spec.before_paragraph_style {
                    before.paragraph_style = Some(style.clone());
                }
                para.props_change = Some(ParaPropsChange {
                    change: change.clone(),
                    before: Box::new(before),
                });
            }
        }
        ChangeSpecKind::InsertMark | ChangeSpecKind::DeleteMark => {
            paragraphs[first].mark_revision = Some(change.clone());
        }
    }
    let mut echoed = spec.clone();
    echoed.id = Some(change.id.clone());
    echoed.date = change.date.clone();
    Ok(AppliedOperation {
        op: Operation::RecordChange {
            story_id: story_id.to_string(),
            cell: cell.cloned(),
            start,
            end,
            paragraph,
            change: echoed,
        },
        inverse: Operation::RestoreParagraphs {
            story_id: story_id.to_string(),
            cell: cell.cloned(),
            first: first as u32,
            count: (last - first + 1) as u32,
            paragraphs_json: before_json,
        },
        invalidation: reflow_hint_for_story(doc, story_id),
    })
}

// ---------------------------------------------------------------------
// Accept / reject
// ---------------------------------------------------------------------

/// Resolve every change `pick` chooses in `paragraphs` (table cells
/// included): accept or reject. Whether anything changed.
pub fn resolve_changes(
    paragraphs: &mut Vec<Paragraph>,
    pick: &dyn Fn(&Change) -> bool,
    accept: bool,
) -> bool {
    let mut changed = false;
    for p in paragraphs.iter_mut() {
        if let Some(t) = p.table.as_mut() {
            for c in t.cells.iter_mut() {
                changed |= resolve_changes(&mut c.paragraphs, pick, accept);
            }
        }
        if let Some(pc) = p.props_change.as_ref().filter(|pc| pick(&pc.change)) {
            if accept {
                p.props_change = None;
            } else {
                let before = (*pc.before).clone();
                p.restore_props(&before);
            }
            changed = true;
        }
        let mut removals: Vec<(u32, u32)> = Vec::new();
        let mut pos = 0u32;
        for r in p.runs.iter_mut() {
            let n = r.text.chars().count() as u32;
            if let Some(fc) = r.format_change.as_ref().filter(|fc| pick(&fc.change)) {
                if accept {
                    r.format_change = None;
                } else {
                    let before = (*fc.before).clone();
                    *r = r.with_props_of(&before);
                }
                changed = true;
            }
            if let Some(c) = r.revision.as_ref().filter(|c| pick(c)) {
                let remove = matches!(
                    (c.kind, accept),
                    (ChangeKind::Insert, false) | (ChangeKind::Delete, true)
                );
                if remove && n > 0 {
                    removals.push((pos, pos + n));
                } else {
                    r.revision = None;
                }
                changed = true;
            }
            pos += n;
        }
        for (a, b) in removals.into_iter().rev() {
            remove_para_chars(p, a, b);
        }
    }
    let mut i = paragraphs.len();
    while i > 0 {
        i -= 1;
        let Some(m) = paragraphs[i].mark_revision.as_ref().filter(|m| pick(m)) else {
            continue;
        };
        let join = matches!(
            (m.kind, accept),
            (ChangeKind::Insert, false) | (ChangeKind::Delete, true)
        );
        if !(join && join_with_next(paragraphs, i)) {
            paragraphs[i].mark_revision = None;
        }
        changed = true;
    }
    changed
}

/// InDesign's tracked deletions (ADR 184) by `author` (any when `None`),
/// accepted or rejected in place. Whether any was.
fn resolve_indesign_deletions(
    paragraphs: &mut [Paragraph],
    author: Option<&str>,
    accept: bool,
) -> bool {
    let mut changed = false;
    for p in paragraphs.iter_mut() {
        if p.tracked_deletions.is_empty() {
            continue;
        }
        let markers: Vec<u32> = p
            .runs
            .iter()
            .flat_map(|r| r.text.chars())
            .enumerate()
            .filter(|(_, c)| *c == TRACKED_DELETION_MARKER)
            .map(|(i, _)| i as u32)
            .collect();
        for k in (0..p.tracked_deletions.len().min(markers.len())).rev() {
            let entry = &p.tracked_deletions[k];
            if author.is_some_and(|a| entry.user_name.as_deref() != Some(a)) {
                continue;
            }
            let at = markers[k];
            let text = if accept {
                String::new()
            } else {
                entry
                    .deleted_text
                    .clone()
                    .unwrap_or_default()
                    .replace('\r', "\n")
            };
            super::endnote::remove_chars(p, at, at + 1);
            p.tracked_deletions.remove(k);
            if !text.is_empty() {
                super::endnote::insert_str(p, at, &text);
            }
            changed = true;
        }
    }
    changed
}

pub(super) fn apply_resolve(
    doc: &mut Document,
    story_id: Option<&str>,
    id: Option<&str>,
    author: Option<&str>,
    accept: bool,
) -> Result<AppliedOperation, OperationError> {
    let pick = |c: &Change| {
        id.is_none_or(|id| c.id == id) && author.is_none_or(|a| c.author.as_deref() == Some(a))
    };
    let mut inverses = Vec::new();
    let mut invalidation = InvalidationHint::default();
    for si in 0..doc.stories.len() {
        let sid = doc.stories[si].self_id.clone();
        if story_id.is_some_and(|s| s != sid) {
            continue;
        }
        let story = &mut doc.stories[si].story;
        let before = json(&story.paragraphs);
        let mut changed = resolve_changes(&mut story.paragraphs, &pick, accept);
        if id.is_none() {
            changed |= resolve_indesign_deletions(&mut story.paragraphs, author, accept);
        }
        if changed {
            inverses.push(Operation::RestoreStoryReview {
                story_id: sid.clone(),
                paragraphs_json: Some(before),
                comments_json: json(&story.comments),
            });
            invalidation.merge(reflow_hint_for_story(doc, &sid));
        }
    }
    if inverses.is_empty() {
        if let Some(id) = id {
            return Err(not_found("trackedChanges", id));
        }
    }
    let op = if accept {
        Operation::AcceptChange {
            story_id: story_id.map(str::to_string),
            id: id.map(str::to_string),
            author: author.map(str::to_string),
        }
    } else {
        Operation::RejectChange {
            story_id: story_id.map(str::to_string),
            id: id.map(str::to_string),
            author: author.map(str::to_string),
        }
    };
    let inverse = if inverses.len() == 1 {
        inverses.pop().expect("one inverse")
    } else {
        Operation::Batch { ops: inverses }
    };
    Ok(AppliedOperation {
        op,
        inverse,
        invalidation,
    })
}

pub(super) fn apply_restore_story_review(
    doc: &mut Document,
    story_id: &str,
    paragraphs_json: Option<&str>,
    comments_json: &str,
) -> Result<AppliedOperation, OperationError> {
    let si = story_index(doc, story_id)?;
    let bad = |e: serde_json::Error| OperationError::InvalidParent {
        parent: NodeId::Story(story_id.to_string()),
        child_kind: format!("review state that does not read ({e})"),
    };
    let comments: Vec<Comment> = serde_json::from_str(comments_json).map_err(bad)?;
    let paragraphs: Option<Vec<Paragraph>> = paragraphs_json
        .map(serde_json::from_str)
        .transpose()
        .map_err(bad)?;
    let story = &mut doc.stories[si].story;
    let prev_comments = std::mem::replace(&mut story.comments, comments);
    let prev_paragraphs = paragraphs.map(|p| std::mem::replace(&mut story.paragraphs, p));
    Ok(AppliedOperation {
        op: Operation::RestoreStoryReview {
            story_id: story_id.to_string(),
            paragraphs_json: paragraphs_json.map(str::to_string),
            comments_json: comments_json.to_string(),
        },
        inverse: Operation::RestoreStoryReview {
            story_id: story_id.to_string(),
            paragraphs_json: prev_paragraphs.as_ref().map(json),
            comments_json: json(&prev_comments),
        },
        invalidation: reflow_hint_for_story(doc, story_id),
    })
}

// ---------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------

/// The inverse that puts story `si`'s threads (and, when `with_text`, its
/// paragraphs) back as they are now.
fn capture_review(doc: &Document, si: usize, with_text: bool) -> Operation {
    let story = &doc.stories[si].story;
    Operation::RestoreStoryReview {
        story_id: doc.stories[si].self_id.clone(),
        paragraphs_json: with_text.then(|| json(&story.paragraphs)),
        comments_json: json(&story.comments),
    }
}

fn comment_of(spec: &CommentSpec, id: String) -> Comment {
    Comment {
        id,
        parent: spec.parent_id.clone(),
        author: spec.author.clone(),
        initials: spec.initials.clone(),
        date: spec.date.clone(),
        text: spec.text.replace("\r\n", "\n").replace('\r', "\n"),
        resolved: spec.resolved,
    }
}

pub(super) fn apply_insert_comment(
    doc: &mut Document,
    story_id: &str,
    cell: Option<&CellAddr>,
    start: u32,
    end: u32,
    spec: &CommentSpec,
) -> Result<AppliedOperation, OperationError> {
    let si = story_index(doc, story_id)?;
    let id = spec.id.clone().unwrap_or_else(|| next_comment_id(doc));
    if doc
        .stories
        .iter()
        .any(|s| s.story.comments.iter().any(|c| c.id == id))
    {
        return Err(OperationError::DuplicateNodeId { id });
    }
    let reply = spec.parent_id.is_some();
    if let Some(parent) = &spec.parent_id {
        if !doc.stories[si]
            .story
            .comments
            .iter()
            .any(|c| &c.id == parent)
        {
            return Err(not_found("comments", parent.clone()));
        }
    } else if start >= end {
        return Err(OperationError::InvalidPosition {
            parent: NodeId::Story(story_id.to_string()),
            position: end as usize,
            len: start as usize,
        });
    }
    let inverse = capture_review(doc, si, !reply);
    let story = &mut doc.stories[si].story;
    if !reply {
        let paragraphs = super::cell_paragraphs_mut(story, cell)
            .ok_or_else(|| OperationError::NodeNotFound(NodeId::Story(story_id.to_string())))?;
        let pieces = story_char_pieces(paragraphs, start, end);
        if pieces.is_empty() {
            return Err(OperationError::InvalidPosition {
                parent: NodeId::Story(story_id.to_string()),
                position: end as usize,
                len: paragraph_total(paragraphs) as usize,
            });
        }
        for (pi, from, to) in pieces {
            let para = &mut paragraphs[pi];
            for ri in isolate_para_chars(para, from, to) {
                let ids = &mut para.runs[ri].comments;
                if !ids.contains(&id) {
                    ids.push(id.clone());
                }
            }
        }
    }
    story.comments.push(comment_of(spec, id.clone()));
    let mut echoed = spec.clone();
    echoed.id = Some(id);
    Ok(AppliedOperation {
        op: Operation::InsertComment {
            story_id: story_id.to_string(),
            cell: cell.cloned(),
            start,
            end,
            comment: echoed,
        },
        inverse,
        invalidation: reflow_hint_for_story(doc, story_id),
    })
}

fn paragraph_total(paragraphs: &[Paragraph]) -> u32 {
    paragraphs.iter().map(paragraph_chars).sum()
}

fn find_comment(doc: &Document, id: &str) -> Result<(usize, usize), OperationError> {
    doc.stories
        .iter()
        .enumerate()
        .find_map(|(si, s)| {
            s.story
                .comments
                .iter()
                .position(|c| c.id == id)
                .map(|k| (si, k))
        })
        .ok_or_else(|| not_found("comments", id))
}

pub(super) fn apply_resolve_comment(
    doc: &mut Document,
    comment_id: &str,
    resolved: bool,
) -> Result<AppliedOperation, OperationError> {
    let (si, k) = find_comment(doc, comment_id)?;
    let inverse = capture_review(doc, si, false);
    let story = &mut doc.stories[si].story;
    // A thread is resolved as a whole: the root and its replies.
    let root = story.comments[k]
        .parent
        .clone()
        .unwrap_or_else(|| comment_id.to_string());
    for c in story.comments.iter_mut() {
        if c.id == root || c.parent.as_deref() == Some(root.as_str()) {
            c.resolved = resolved;
        }
    }
    let sid = doc.stories[si].self_id.clone();
    Ok(AppliedOperation {
        op: Operation::ResolveComment {
            comment_id: comment_id.to_string(),
            resolved,
        },
        inverse,
        invalidation: reflow_hint_for_story(doc, &sid),
    })
}

/// Take comment id `id` off every run (table cells included).
fn unmark_comment(paragraphs: &mut [Paragraph], id: &str) {
    for p in paragraphs.iter_mut() {
        for r in p.runs.iter_mut() {
            r.comments.retain(|c| c != id);
        }
        if let Some(t) = p.table.as_mut() {
            for c in t.cells.iter_mut() {
                unmark_comment(&mut c.paragraphs, id);
            }
        }
    }
}

pub(super) fn apply_delete_comment(
    doc: &mut Document,
    comment_id: &str,
) -> Result<AppliedOperation, OperationError> {
    let (si, k) = find_comment(doc, comment_id)?;
    let root = doc.stories[si].story.comments[k].parent.is_none();
    let inverse = capture_review(doc, si, root);
    let story = &mut doc.stories[si].story;
    if root {
        unmark_comment(&mut story.paragraphs, comment_id);
        story
            .comments
            .retain(|c| c.id != comment_id && c.parent.as_deref() != Some(comment_id));
    } else {
        story.comments.remove(k);
    }
    let sid = doc.stories[si].self_id.clone();
    Ok(AppliedOperation {
        op: Operation::DeleteComment {
            comment_id: comment_id.to_string(),
        },
        inverse,
        invalidation: reflow_hint_for_story(doc, &sid),
    })
}

pub(super) fn apply_edit_comment(
    doc: &mut Document,
    comment_id: &str,
    text: &str,
    date: Option<&str>,
) -> Result<AppliedOperation, OperationError> {
    let (si, k) = find_comment(doc, comment_id)?;
    let inverse = capture_review(doc, si, false);
    let c = &mut doc.stories[si].story.comments[k];
    c.text = text.replace("\r\n", "\n").replace('\r', "\n");
    if let Some(d) = date {
        c.date = Some(d.to_string());
    }
    let sid = doc.stories[si].self_id.clone();
    Ok(AppliedOperation {
        op: Operation::EditComment {
            comment_id: comment_id.to_string(),
            text: text.to_string(),
            date: date.map(str::to_string),
        },
        inverse,
        invalidation: reflow_hint_for_story(doc, &sid),
    })
}

// ---------------------------------------------------------------------
// Tracked formatting
// ---------------------------------------------------------------------

/// The story range a formatting edit `op` writes, when the document
/// tracks changes and `op` is one: a property set on a story range, or a
/// style applied to one.
pub(crate) fn format_scope(doc: &Document, op: &Operation) -> Option<FormatScope> {
    if !tracking(doc) {
        return None;
    }
    match op {
        Operation::SetProperty {
            node:
                NodeId::StoryRange {
                    story_id,
                    start,
                    end,
                },
            ..
        } => Some(FormatScope {
            story_id: story_id.clone(),
            cell: None,
            start: *start,
            end: *end,
            paragraph: None,
        }),
        Operation::ApplyStyle {
            story_id,
            start,
            end,
            cell,
            paragraph,
            ..
        } => Some(FormatScope {
            story_id: story_id.clone(),
            cell: cell.clone(),
            start: *start,
            end: *end,
            paragraph: *paragraph,
        }),
        _ => None,
    }
}

pub(crate) struct FormatScope {
    story_id: String,
    cell: Option<CellAddr>,
    start: u32,
    end: u32,
    paragraph: Option<u32>,
}

/// The paragraphs `[first, last]` a formatting edit of `scope` touches:
/// those its characters fall in, or the one its caret stands in.
fn format_paragraphs(paragraphs: &[Paragraph], scope: &FormatScope) -> Option<(usize, usize)> {
    if let Some(p) = scope.paragraph {
        let p = p as usize;
        return (p < paragraphs.len()).then_some((p, p));
    }
    let pieces = story_char_pieces(paragraphs, scope.start, scope.end);
    if let (Some(a), Some(b)) = (pieces.first(), pieces.last()) {
        return Some((a.0, b.0));
    }
    // A caret: the paragraph it stands in (the last one at the end).
    let mut pos = 0u32;
    for (i, p) in paragraphs.iter().enumerate() {
        let n = paragraph_chars(p);
        if scope.start <= pos + n {
            return Some((i, i));
        }
        pos += n;
    }
    paragraphs.len().checked_sub(1).map(|i| (i, i))
}

fn same<T: serde::Serialize>(a: &T, b: &T) -> bool {
    serde_json::to_value(a).ok() == serde_json::to_value(b).ok()
}

/// Apply formatting edit `op` through `apply_fn` and record what it
/// changed as tracked formatting changes, against the properties the
/// runs and paragraphs had before. Its undo puts the paragraphs back as
/// they were, in one step.
pub(crate) fn tracked_format(
    doc: &mut Document,
    scope: FormatScope,
    apply_fn: impl FnOnce(&mut Document) -> Result<AppliedOperation, OperationError>,
) -> Result<AppliedOperation, OperationError> {
    let si = story_index(doc, &scope.story_id)?;
    let captured = super::cell_paragraphs_mut(&mut doc.stories[si].story, scope.cell.as_ref())
        .and_then(|ps| format_paragraphs(ps, &scope).map(|(f, l)| (f, l, ps[f..=l].to_vec())));
    let mut applied = apply_fn(doc)?;
    let Some((first, last, before)) = captured else {
        return Ok(applied);
    };
    let (author, date) = stamp(doc);
    let id = next_change_id(doc);
    let Some(paragraphs) =
        super::cell_paragraphs_mut(&mut doc.stories[si].story, scope.cell.as_ref())
    else {
        return Ok(applied);
    };
    if last >= paragraphs.len() {
        return Ok(applied);
    }
    let change = |kind| Change {
        id: id.clone(),
        kind,
        author: author.clone(),
        date: date.clone(),
    };
    let mut recorded = false;
    for (k, old) in before.iter().enumerate() {
        let para = &mut paragraphs[first + k];
        // Paragraph formatting.
        if !same(&old.props_snapshot(), &para.props_snapshot()) {
            match para.props_change.as_ref() {
                None => {
                    para.props_change = Some(ParaPropsChange {
                        change: change(ChangeKind::ParaProps),
                        before: Box::new(old.props_snapshot()),
                    });
                    recorded = true;
                }
                // Set back to what it was: no change any more.
                Some(pc) if same(&*pc.before, &para.props_snapshot()) => {
                    para.props_change = None;
                    recorded = true;
                }
                Some(_) => {}
            }
        }
        // Character formatting: each run against the run it was part of.
        let mut bounds = Vec::new();
        let mut pos = 0u32;
        for r in &old.runs {
            pos += r.text.chars().count() as u32;
            bounds.push(pos);
        }
        let total = paragraph_chars(para);
        for b in &bounds {
            if *b < total {
                isolate_para_chars(para, *b, total);
            }
        }
        let mut pos = 0u32;
        for r in para.runs.iter_mut() {
            let n = r.text.chars().count() as u32;
            if n == 0 {
                continue;
            }
            let mut at = 0u32;
            let old_run = old.runs.iter().find(|o| {
                let m = o.text.chars().count() as u32;
                let hit = m > 0 && pos >= at && pos < at + m;
                at += m;
                hit
            });
            pos += n;
            let Some(old_run) = old_run else { continue };
            if same(&old_run.props_snapshot(), &r.props_snapshot()) {
                continue;
            }
            match r.format_change.as_ref() {
                None => {
                    r.format_change = Some(FormatChange {
                        change: change(ChangeKind::Format),
                        before: Box::new(old_run.props_snapshot()),
                    });
                    recorded = true;
                }
                Some(fc) if same(&*fc.before, &r.props_snapshot()) => {
                    r.format_change = None;
                    recorded = true;
                }
                Some(_) => {}
            }
        }
    }
    if recorded {
        applied.inverse = Operation::RestoreParagraphs {
            story_id: scope.story_id.clone(),
            cell: scope.cell.clone(),
            first: first as u32,
            count: before.len() as u32,
            paragraphs_json: json(&before),
        };
    }
    Ok(applied)
}
