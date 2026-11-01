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

//! Engine ADR 1055 — comments anchored to anything, not only to text.
//!
//! A comment on a text range lives with its story (ADR 1020,
//! [`crate::Story::comments`]); every other comment is a [`CommentThread`] in the
//! document's thread store, anchored to a page item, a point on a page, a
//! region of an item, or an address only the owning module can resolve (an
//! Excel cell). Both kinds share [`crate::Comment`], so a reader, a panel or
//! a writer handles one comment shape.
//!
//! Each comment names its author as a [`Person`] of the document's people
//! list, and keeps the source element of each format it was read from
//! ([`SourceBlob`]), so a thread nobody edited is written back byte for byte.

use serde::{Deserialize, Serialize};

use crate::Comment;

/// An author of comments. One entry per person; comments refer to it by
/// [`Person::id`]. Word's `people.xml`, Excel's `persons` and PowerPoint's
/// `authors.xml` read into this, as an Acrobat annotation's `/T` does (a person
/// with a name and no ids).
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Person {
    /// The id comments name. Unique in the document.
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub initials: Option<String>,
    /// The account id the product gave the author (Word's `w15:userId`, Excel's
    /// `persons` `userId`, PowerPoint's `userId`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_id: Option<String>,
    /// The identity provider (`AD`, `Windows Live`, `None`, …).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
}

/// What a [`CommentThread`] is attached to.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CommentAnchor {
    /// A page item (a shape, frame, group or picture), optionally at a point
    /// in the item's own space (points from its top-left).
    #[serde(rename_all = "camelCase")]
    Item {
        item: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        at: Option<[f64; 2]>,
    },
    /// A point on a page or artboard, in page space (points from its top-left).
    #[serde(rename_all = "camelCase")]
    Page { page: String, at: [f64; 2] },
    /// A rectangle of an item (`[x, y, width, height]` in the item's space): a
    /// raster area, a PDF markup rectangle.
    #[serde(rename_all = "camelCase")]
    Region { item: String, rect: [f64; 4] },
    /// An address in a space the owning module resolves to geometry: an Excel
    /// cell or range (`Sheet1!B3`) on a sheet frame, a web element.
    #[serde(rename_all = "camelCase")]
    Cell { item: String, address: String },
}

impl CommentAnchor {
    /// The page item the anchor names, if it names one.
    pub fn item(&self) -> Option<&str> {
        match self {
            CommentAnchor::Item { item, .. }
            | CommentAnchor::Region { item, .. }
            | CommentAnchor::Cell { item, .. } => Some(item),
            CommentAnchor::Page { .. } => None,
        }
    }
}

/// Whether a thread is a threaded conversation or a single annotation.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ThreadKind {
    /// Word, PowerPoint modern, Excel threaded comments, Acrobat with replies.
    #[default]
    Comment,
    /// Excel legacy note, InDesign note, a PDF sticky note: one annotation,
    /// no replies.
    Note,
}

/// The element a format wrote a comment as, kept so the writer can give it
/// back unchanged. `format` names the family (`docx`, `xlsx`, `pptx`, `pdf`, `idml`,
/// `odf`); `data` is its XML (or the annotation dictionary as text).
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceBlob {
    pub format: String,
    pub data: String,
}

/// The review state of a PDF annotation (`/State` with `/StateModel` `Review`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ReviewState {
    Accepted,
    Rejected,
    Cancelled,
    Completed,
}

/// A task attached to a comment (PowerPoint and Excel threaded comments).
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommentTask {
    /// A [`Person::id`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assignee: Option<String>,
    /// ISO 8601 date.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub due: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

/// A mention of a person inside a comment's text, as the characters
/// `[start, end)` of [`Comment::text`] (counted in `char`s).
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Mention {
    pub person: String,
    pub start: u32,
    pub end: u32,
}

/// A reaction to a comment.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Reaction {
    pub person: String,
    pub emoji: String,
}

/// A conversation (or a single note) attached to something other than a
/// text range. The first comment is the root; the others are replies, in
/// order. A thread's id is its root comment's id.
#[derive(Debug, Default, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommentThread {
    pub id: String,
    /// `None` only while a thread is orphaned (its anchor's target is gone, see
    /// [`CommentThread::orphaned`]); a thread read from a file always has one.
    pub anchor: Option<CommentAnchor>,
    #[serde(default)]
    pub kind: ThreadKind,
    /// Where the thread was last shown when its anchor target was deleted: the
    /// page id and the point on it. The thread is kept, never deleted with its
    /// target; a panel lists it and offers to re-anchor or delete it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub orphaned: Option<(String, [f64; 2])>,
    /// Root first, then the replies in order.
    #[serde(default)]
    pub comments: Vec<Comment>,
    /// What the formats this thread was read from wrote, per comment id.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub source: Vec<(String, SourceBlob)>,
}

impl CommentThread {
    /// The root comment.
    pub fn root(&self) -> Option<&Comment> {
        self.comments.first()
    }

    /// True when the thread is resolved (Word's Resolve resolves the whole
    /// thread, so the root says it).
    pub fn is_resolved(&self) -> bool {
        self.root().is_some_and(|c| c.resolved)
    }

    /// The comment with `id`, root or reply.
    pub fn comment(&self, id: &str) -> Option<&Comment> {
        self.comments.iter().find(|c| c.id == id)
    }

    /// The next comment id not used in this thread, `"<thread>.<n>"`.
    pub fn next_reply_id(&self) -> String {
        let mut n = self.comments.len();
        loop {
            let id = format!("{}.{n}", self.id);
            if self.comment(&id).is_none() {
                return id;
            }
            n += 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn comment(id: &str, text: &str) -> Comment {
        Comment {
            id: id.into(),
            text: text.into(),
            ..Default::default()
        }
    }

    #[test]
    fn a_thread_round_trips_through_json_and_old_documents_read_unchanged() {
        let thread = CommentThread {
            id: "c1".into(),
            anchor: Some(CommentAnchor::Cell {
                item: "u1f".into(),
                address: "Sheet1!B3".into(),
            }),
            kind: ThreadKind::Comment,
            comments: vec![comment("c1", "check this"), comment("c1.1", "done")],
            source: vec![(
                "c1".into(),
                SourceBlob {
                    format: "xlsx".into(),
                    data: "<threadedComment/>".into(),
                },
            )],
            ..Default::default()
        };
        let json = serde_json::to_string(&thread).unwrap();
        assert!(json.contains(r#""kind":"cell""#) && json.contains(r#""address":"Sheet1!B3""#));
        assert_eq!(
            serde_json::from_str::<CommentThread>(&json).unwrap(),
            thread
        );
        // A comment written before the new fields existed still reads.
        let old: Comment = serde_json::from_str(r#"{"id":"3","text":"x"}"#).unwrap();
        assert_eq!(old.id, "3");
    }

    #[test]
    fn anchors_name_their_item_and_threads_mint_reply_ids() {
        let item = CommentAnchor::Item {
            item: "u9".into(),
            at: None,
        };
        let page = CommentAnchor::Page {
            page: "p1".into(),
            at: [10.0, 20.0],
        };
        assert_eq!(item.item(), Some("u9"));
        assert_eq!(page.item(), None);
        let mut t = CommentThread {
            id: "t".into(),
            comments: vec![comment("t", "a")],
            ..Default::default()
        };
        assert_eq!(t.next_reply_id(), "t.1");
        t.comments.push(comment("t.1", "b"));
        assert_eq!(t.next_reply_id(), "t.2");
        assert!(!t.is_resolved());
        t.comments[0].resolved = true;
        assert!(t.is_resolved());
    }
}
