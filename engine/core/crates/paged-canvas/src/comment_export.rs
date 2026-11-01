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

//! Engine ADR 1055 — comments on IDML export.
//!
//! IDML's one comment is the `<Note>` (ADR 172): a single annotation at a
//! point in a story's text, with no replies. [`lower_for_idml`] therefore
//! writes each comment thread on a text range (ADR 1020) as a note standing
//! at the start of its range, in a copy of the scene: the root comment's text
//! is the note's first paragraphs, and each reply follows as a paragraph of
//! its own, `Author: text`, in order. A document thread anchored to an item,
//! a page, a region or a cell has no point in a story's text and is not
//! written.
//!
//! [`comment_losses`] names, per thread, what the export does not carry: a
//! thread dropped whole (its id, anchor kind and the reason), replies folded
//! into the note's text, a resolved state IDML has no place for. It is
//! declared from the model: the re-imported twin holds the note, so it
//! cannot tell a folded reply from one that never was.

use paged_model::{Comment, CommentAnchor, Note, Paragraph, ThreadKind, NOTE_MARKER};
use paged_scene::Document;

/// A date as InDesign spells a note's (`2026-10-16T09:59:49`): the first
/// nineteen characters of an ISO 8601 date-time, as given.
fn indesign_date(d: &str) -> Option<String> {
    let d = d.get(..19)?;
    (d.as_bytes()[10] == b'T').then(|| d.to_string())
}

/// The note text of a thread: the root's paragraphs, then each reply as a
/// paragraph `Author: text` (its own paragraphs follow, `\r`-separated).
fn note_text(root: &Comment, replies: &[&Comment]) -> String {
    let mut out = root.text.replace('\n', "\r");
    for r in replies {
        out.push('\r');
        if let Some(a) = r.author.as_deref().filter(|a| !a.is_empty()) {
            out.push_str(a);
            out.push_str(": ");
        }
        out.push_str(&r.text.replace('\n', "\r"));
    }
    out
}

/// Write the story comments of `scene` as notes.
pub(crate) fn lower_for_idml(scene: &mut Document) {
    for parsed in scene.stories.iter_mut() {
        let story = &mut parsed.story;
        if story.comments.is_empty() {
            continue;
        }
        let roots: Vec<Comment> = story
            .comments
            .iter()
            .filter(|c| c.parent.is_none())
            .cloned()
            .collect();
        for root in roots {
            let replies: Vec<&Comment> = story
                .comments
                .iter()
                .filter(|c| c.parent.as_deref() == Some(root.id.as_str()))
                .collect();
            let note = Note {
                id: root.id.clone(),
                text: note_text(&root, &replies),
                user_name: root.author.clone(),
                creation_date: root.date.as_deref().and_then(indesign_date),
                modification_date: root
                    .modified
                    .as_deref()
                    .or(root.date.as_deref())
                    .and_then(indesign_date),
                ..Note::default()
            };
            place(&mut story.paragraphs, &root.id, note);
        }
    }
}

/// Stand `note` at the start of the first run that names thread `id`, in the
/// first paragraph (a table cell's too) that holds one. Returns whether it
/// was placed.
fn place(paragraphs: &mut [Paragraph], id: &str, note: Note) -> bool {
    let mut note = Some(note);
    place_in(paragraphs, id, &mut note);
    note.is_none()
}

fn place_in(paragraphs: &mut [Paragraph], id: &str, note: &mut Option<Note>) {
    for para in paragraphs.iter_mut() {
        if let Some(ri) = para
            .runs
            .iter()
            .position(|r| r.comments.iter().any(|c| c == id))
        {
            let anchor: u32 = para.runs[..ri]
                .iter()
                .map(|r| r.text.chars().count() as u32)
                .sum();
            // The k-th marker is the k-th note: stand the new one among them
            // as the ops do, moving what stands at or after it on by one.
            let mut n = note.take().expect("placed once");
            n.anchor = anchor;
            para.shift_anchors(anchor, 1);
            para.runs[ri].text.insert(0, NOTE_MARKER);
            para.notes.push(n);
            para.notes.sort_by_key(|n| n.anchor);
            return;
        }
        if let Some(table) = para.table.as_mut() {
            for cell in table.cells.iter_mut() {
                place_in(&mut cell.paragraphs, id, note);
                if note.is_none() {
                    return;
                }
            }
        }
    }
}

/// The comments the IDML export does not carry whole, one line per thread.
pub(crate) fn comment_losses(scene: &Document) -> Vec<String> {
    let mut out = Vec::new();
    for t in &scene.comment_threads {
        let (kind, target) = match &t.anchor {
            Some(CommentAnchor::Item { item, .. }) => ("item", format!(" `{item}`")),
            Some(CommentAnchor::Page { page, .. }) => ("page", format!(" `{page}`")),
            Some(CommentAnchor::Region { item, .. }) => ("region", format!(" of `{item}`")),
            Some(CommentAnchor::Cell { item, address }) => {
                ("cell", format!(" `{address}` of `{item}`"))
            }
            None => ("orphaned", String::new()),
        };
        let n = t.comments.len();
        let replies = match n {
            0 | 1 => String::new(),
            2 => " with 1 reply".to_string(),
            _ => format!(" with {} replies", n - 1),
        };
        let what = match t.kind {
            ThreadKind::Comment => "comment",
            ThreadKind::Note => "note",
        };
        out.push(format!(
            "comment thread `{}` ({what}{replies}) on {kind}{target} is dropped — IDML's only \
             comment is the note, a point in a story's text, and this thread has none. \
             Save as `.paged` to keep it, or export PDF with comments.",
            t.id
        ));
    }
    for parsed in &scene.stories {
        let story = &parsed.story;
        for root in story.comments.iter().filter(|c| c.parent.is_none()) {
            let replies = story
                .comments
                .iter()
                .filter(|c| c.parent.as_deref() == Some(root.id.as_str()))
                .count();
            let placed = story_has_run(&story.paragraphs, &root.id);
            if !placed {
                out.push(format!(
                    "comment thread `{}` on a text range of story `{}` is dropped — its text \
                     is gone, so it has no point to stand at as an IDML note. Save as `.paged` \
                     to keep it.",
                    root.id, parsed.self_id
                ));
                continue;
            }
            if replies > 0 {
                out.push(format!(
                    "comment thread `{}` on story `{}`: its {replies} repl{} fold into the \
                     IDML note's text as paragraphs (`Author: text`) — a note has no replies. \
                     Save as `.paged` to keep the thread.",
                    root.id,
                    parsed.self_id,
                    if replies == 1 { "y" } else { "ies" }
                ));
            }
            if root.resolved {
                out.push(format!(
                    "comment thread `{}` on story `{}` is resolved — an IDML note has no \
                     resolved state, so it opens as an ordinary note.",
                    root.id, parsed.self_id
                ));
            }
        }
    }
    out
}

fn story_has_run(paragraphs: &[Paragraph], id: &str) -> bool {
    paragraphs.iter().any(|p| {
        p.runs.iter().any(|r| r.comments.iter().any(|c| c == id))
            || p.table
                .as_ref()
                .is_some_and(|t| t.cells.iter().any(|c| story_has_run(&c.paragraphs, id)))
    })
}
