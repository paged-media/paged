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

//! Engine ADR 1055 — comment threads that are not on a text range.
//!
//! The thread store (`Document::comment_threads`) and the people list
//! (`Document::people`) change through these operations. Every one is undone by
//! [`Operation::RestoreCommentThreads`], which carries both lists as they were:
//! the store is small, and a snapshot cannot drift from what the operation did.
//!
//! The text-range operations of ADR 1020 (`ResolveComment`, `EditComment`,
//! `DeleteComment`) find a comment by id in the stories first and in this store
//! second, so one set of ids and one set of operations serves both.

use paged_model::{
    Comment, CommentAnchor, CommentTask, CommentThread, Mention, Person, Reaction, ReviewState,
    ThreadKind,
};
use paged_scene::Document;

use crate::error::OperationError;
use crate::operation::{
    AppliedOperation, CommentAnchorSpec, CommentSpec, InvalidationHint, Operation, PersonSpec,
};

fn json<T: serde::Serialize>(v: &T) -> String {
    // Plain data: serializing it cannot fail.
    serde_json::to_string(v).expect("model data serializes")
}

fn capture(doc: &Document) -> Operation {
    Operation::RestoreCommentThreads {
        threads_json: json(&doc.comment_threads),
        people_json: json(&doc.people),
    }
}

fn applied(op: Operation, inverse: Operation) -> AppliedOperation {
    AppliedOperation {
        op,
        inverse,
        invalidation: InvalidationHint::default(),
    }
}

fn not_found(id: &str) -> OperationError {
    OperationError::CollectionEntryNotFound {
        collection: "comments".to_string(),
        id: id.to_string(),
    }
}

fn refuse(reason: impl Into<String>) -> OperationError {
    OperationError::InvalidDocumentMetadata {
        reason: reason.into(),
    }
}

/// An anchor on the wire as the model's.
pub(crate) fn anchor_of(spec: &CommentAnchorSpec) -> CommentAnchor {
    match spec {
        CommentAnchorSpec::Item { item, at } => CommentAnchor::Item {
            item: item.clone(),
            at: *at,
        },
        CommentAnchorSpec::Page { page, at } => CommentAnchor::Page {
            page: page.clone(),
            at: *at,
        },
        CommentAnchorSpec::Region { item, rect } => CommentAnchor::Region {
            item: item.clone(),
            rect: *rect,
        },
        CommentAnchorSpec::Cell { item, address } => CommentAnchor::Cell {
            item: item.clone(),
            address: address.clone(),
        },
    }
}

fn empty_anchor(anchor: &CommentAnchorSpec) -> bool {
    match anchor {
        CommentAnchorSpec::Item { item, .. } | CommentAnchorSpec::Region { item, .. } => {
            item.is_empty()
        }
        CommentAnchorSpec::Page { page, .. } => page.is_empty(),
        CommentAnchorSpec::Cell { item, address } => item.is_empty() || address.is_empty(),
    }
}

fn review_state(s: &str) -> Option<ReviewState> {
    Some(match s {
        "accepted" => ReviewState::Accepted,
        "rejected" => ReviewState::Rejected,
        "cancelled" => ReviewState::Cancelled,
        "completed" => ReviewState::Completed,
        _ => return None,
    })
}

/// A comment from its wire spec (the id is the caller's).
pub(crate) fn comment_from(spec: &CommentSpec, id: String) -> Comment {
    Comment {
        id,
        parent: spec.parent_id.clone(),
        author: spec.author.clone(),
        initials: spec.initials.clone(),
        date: spec.date.clone(),
        text: spec.text.replace("\r\n", "\n").replace('\r', "\n"),
        resolved: spec.resolved,
        modified: spec.modified.clone(),
        person: spec.person.clone(),
        mentions: spec
            .mentions
            .iter()
            .map(|m| Mention {
                person: m.person.clone(),
                start: m.start,
                end: m.end,
            })
            .collect(),
        task: spec.task.as_ref().map(|t| CommentTask {
            assignee: t.assignee.clone(),
            due: t.due.clone(),
            priority: t.priority,
            title: t.title.clone(),
        }),
        reactions: spec
            .reactions
            .iter()
            .map(|r| Reaction {
                person: r.person.clone(),
                emoji: r.emoji.clone(),
            })
            .collect(),
        review_state: spec.review_state.as_deref().and_then(review_state),
    }
}

/// The source a spec carries, keyed by the comment's id.
fn source_of(spec: &CommentSpec, id: &str) -> Vec<(String, paged_model::SourceBlob)> {
    spec.source
        .iter()
        .map(|s| {
            (
                id.to_string(),
                paged_model::SourceBlob {
                    format: s.format.clone(),
                    data: s.data.clone(),
                },
            )
        })
        .collect()
}

/// Every comment id of the document: text comments and thread comments.
fn all_ids(doc: &Document) -> impl Iterator<Item = &str> {
    doc.stories
        .iter()
        .flat_map(|s| s.story.comments.iter().map(|c| c.id.as_str()))
        .chain(
            doc.comment_threads
                .iter()
                .flat_map(|t| t.comments.iter().map(|c| c.id.as_str())),
        )
}

/// A comment id no comment of the document carries (the same numbering the
/// text comments of ADR 1020 use, so ids never collide across the two stores).
pub fn next_id(doc: &Document) -> String {
    let max = all_ids(doc).filter_map(|id| id.parse::<u64>().ok()).max();
    max.map_or(1, |m| m + 1).to_string()
}

/// The thread holding comment `id`, and the comment's place in it.
pub fn find(doc: &Document, id: &str) -> Option<(usize, usize)> {
    doc.comment_threads
        .iter()
        .enumerate()
        .find_map(|(ti, t)| t.comments.iter().position(|c| c.id == id).map(|k| (ti, k)))
}

pub(super) fn apply_insert_thread(
    doc: &mut Document,
    anchor: &CommentAnchorSpec,
    kind: Option<&str>,
    spec: &CommentSpec,
) -> Result<AppliedOperation, OperationError> {
    if empty_anchor(anchor) {
        return Err(refuse(
            "a comment anchor names an empty item, page or address",
        ));
    }
    if spec.parent_id.is_some() {
        return Err(refuse(
            "a thread's root has no parent; reply with ReplyCommentThread",
        ));
    }
    let kind = match kind {
        None | Some("comment") => ThreadKind::Comment,
        Some("note") => ThreadKind::Note,
        Some(other) => return Err(refuse(format!("unknown comment kind {other:?}"))),
    };
    let id = spec.id.clone().unwrap_or_else(|| next_id(doc));
    if all_ids(doc).any(|c| c == id) {
        return Err(OperationError::DuplicateNodeId { id });
    }
    let inverse = capture(doc);
    doc.comment_threads.push(CommentThread {
        id: id.clone(),
        anchor: Some(anchor_of(anchor)),
        kind,
        comments: vec![comment_from(spec, id.clone())],
        source: source_of(spec, &id),
        ..Default::default()
    });
    let mut echoed = spec.clone();
    echoed.id = Some(id);
    Ok(applied(
        Operation::InsertCommentThread {
            anchor: anchor.clone(),
            thread_kind: Some(
                match kind {
                    ThreadKind::Comment => "comment",
                    ThreadKind::Note => "note",
                }
                .to_string(),
            ),
            comment: echoed,
        },
        inverse,
    ))
}

pub(super) fn apply_reply(
    doc: &mut Document,
    thread_id: &str,
    spec: &CommentSpec,
) -> Result<AppliedOperation, OperationError> {
    let ti = doc
        .comment_threads
        .iter()
        .position(|t| t.id == thread_id)
        .ok_or_else(|| not_found(thread_id))?;
    if doc.comment_threads[ti].kind == ThreadKind::Note {
        return Err(refuse("a note takes no replies"));
    }
    let id = spec
        .id
        .clone()
        .unwrap_or_else(|| doc.comment_threads[ti].next_reply_id());
    if all_ids(doc).any(|c| c == id) {
        return Err(OperationError::DuplicateNodeId { id });
    }
    let inverse = capture(doc);
    let mut c = comment_from(spec, id.clone());
    c.parent = Some(thread_id.to_string());
    // A reply joins a resolved thread open, as Word's does not: it reopens it.
    let thread = &mut doc.comment_threads[ti];
    if thread.is_resolved() {
        for x in &mut thread.comments {
            x.resolved = false;
        }
    }
    thread.comments.push(c);
    thread.source.extend(source_of(spec, &id));
    let mut echoed = spec.clone();
    echoed.id = Some(id);
    Ok(applied(
        Operation::ReplyCommentThread {
            thread_id: thread_id.to_string(),
            comment: echoed,
        },
        inverse,
    ))
}

pub(super) fn apply_set_anchor(
    doc: &mut Document,
    thread_id: &str,
    anchor: &CommentAnchorSpec,
) -> Result<AppliedOperation, OperationError> {
    if empty_anchor(anchor) {
        return Err(refuse(
            "a comment anchor names an empty item, page or address",
        ));
    }
    let ti = doc
        .comment_threads
        .iter()
        .position(|t| t.id == thread_id)
        .ok_or_else(|| not_found(thread_id))?;
    let inverse = capture(doc);
    let thread = &mut doc.comment_threads[ti];
    thread.anchor = Some(anchor_of(anchor));
    thread.orphaned = None;
    Ok(applied(
        Operation::SetCommentAnchor {
            thread_id: thread_id.to_string(),
            anchor: anchor.clone(),
        },
        inverse,
    ))
}

pub(super) fn apply_set_person(
    doc: &mut Document,
    spec: &PersonSpec,
) -> Result<AppliedOperation, OperationError> {
    if spec.id.is_empty() {
        return Err(refuse("a person needs an id"));
    }
    let inverse = capture(doc);
    let person = Person {
        id: spec.id.clone(),
        name: spec.name.clone(),
        initials: spec.initials.clone(),
        user_id: spec.user_id.clone(),
        provider_id: spec.provider_id.clone(),
    };
    match doc.people.iter_mut().find(|p| p.id == person.id) {
        Some(p) => *p = person,
        None => doc.people.push(person),
    }
    Ok(applied(
        Operation::SetPerson {
            person: spec.clone(),
        },
        inverse,
    ))
}

pub(super) fn apply_restore(
    doc: &mut Document,
    threads_json: &str,
    people_json: &str,
) -> Result<AppliedOperation, OperationError> {
    let threads: Vec<CommentThread> =
        serde_json::from_str(threads_json).map_err(|e| refuse(format!("comment threads: {e}")))?;
    let people: Vec<Person> =
        serde_json::from_str(people_json).map_err(|e| refuse(format!("people list: {e}")))?;
    let inverse = capture(doc);
    doc.comment_threads = threads;
    doc.people = people;
    Ok(applied(
        Operation::RestoreCommentThreads {
            threads_json: threads_json.to_string(),
            people_json: people_json.to_string(),
        },
        inverse,
    ))
}

// -- the ADR 1020 operations, on a thread comment ---------------------------

/// `ResolveComment` on a thread comment: the whole thread is resolved.
pub(super) fn resolve(
    doc: &mut Document,
    comment_id: &str,
    resolved: bool,
) -> Option<AppliedOperation> {
    let (ti, _) = find(doc, comment_id)?;
    let inverse = capture(doc);
    for c in &mut doc.comment_threads[ti].comments {
        c.resolved = resolved;
    }
    Some(applied(
        Operation::ResolveComment {
            comment_id: comment_id.to_string(),
            resolved,
        },
        inverse,
    ))
}

/// `EditComment` on a thread comment.
pub(super) fn edit(
    doc: &mut Document,
    comment_id: &str,
    text: &str,
    date: Option<&str>,
) -> Option<AppliedOperation> {
    let (ti, k) = find(doc, comment_id)?;
    let inverse = capture(doc);
    let c = &mut doc.comment_threads[ti].comments[k];
    c.text = text.replace("\r\n", "\n").replace('\r', "\n");
    if let Some(d) = date {
        c.modified = Some(d.to_string());
    }
    Some(applied(
        Operation::EditComment {
            comment_id: comment_id.to_string(),
            text: text.to_string(),
            date: date.map(str::to_string),
        },
        inverse,
    ))
}

/// `DeleteComment` on a thread comment: a root takes the thread with it.
pub(super) fn delete(doc: &mut Document, comment_id: &str) -> Option<AppliedOperation> {
    let (ti, k) = find(doc, comment_id)?;
    let inverse = capture(doc);
    if k == 0 {
        doc.comment_threads.remove(ti);
    } else {
        let thread = &mut doc.comment_threads[ti];
        thread.comments.remove(k);
        thread.source.retain(|(id, _)| id != comment_id);
    }
    Some(applied(
        Operation::DeleteComment {
            comment_id: comment_id.to_string(),
        },
        inverse,
    ))
}
