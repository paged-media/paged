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

//! Engine ADRs 1040 and 1020 on the canvas: the tracked-edit lane, and the
//! reads of tracked changes and comments.
//!
//! **The tracked-edit lane.** While the document tracks changes, a wire
//! `insertText` or `deleteRange` is lowered to one batch (one undo step):
//!
//! - an insert is the untracked insert followed by `recordChange insert`
//!   over the typed characters and `insertMark` on each paragraph whose
//!   mark it typed;
//! - a delete is, from the range's end back to its start, a real delete
//!   of what the same author inserted (Word removes your own insertion
//!   outright), nothing for text already deleted, and `recordChange
//!   delete` (or `deleteMark`) for everything else, whose text stays.
//!
//! The batch's undo is its children's inverses, each exact, so the
//! document returns to exactly where it was.

use paged_model::review::{isolate_para_chars, paragraph_chars, story_char_pieces};
use paged_model::{Change, ChangeKind, Paragraph};
use paged_mutate::{ChangeSpec, ChangeSpecKind};
use paged_scene::Document;

use crate::channel::{ChangeContent, CommentSummary, Mutation, TrackedChangeSummary};
use crate::mutate::{char_to_content_offset, content_offset_to_char};
use crate::selection::TextCellAddr;

/// A change as the reads name it.
pub(crate) fn change_content(c: &Change) -> ChangeContent {
    ChangeContent {
        id: c.id.clone(),
        kind: c.kind.as_str().to_string(),
        author: c.author.clone(),
        date: c.date.clone(),
    }
}

/// Take the insertion or deletion off story chars `[start, end)`: text the
/// untracked lane typed into a changed run.
pub(crate) fn clear_revisions(paragraphs: &mut [Paragraph], start: u32, end: u32) {
    for (pi, from, to) in story_char_pieces(paragraphs, start, end) {
        let para = &mut paragraphs[pi];
        let mut pos = 0u32;
        let touched = para.runs.iter().any(|r| {
            let n = r.text.chars().count() as u32;
            let hit = r.revision.is_some() && pos < to && pos + n > from;
            pos += n;
            hit
        });
        if !touched {
            continue;
        }
        for ri in isolate_para_chars(para, from, to) {
            para.runs[ri].revision = None;
        }
    }
}

/// The ISO 8601 date (UTC, seconds) of `ms` milliseconds since the epoch:
/// how the worker's clock stamps a tracked change (Word's `w:date`).
pub fn iso_date(ms: f64) -> String {
    let secs = (ms / 1000.0).floor() as i64;
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    // Civil from days (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

fn stream<'a>(
    doc: &'a Document,
    story_id: &str,
    cell: Option<&TextCellAddr>,
) -> Option<&'a Vec<Paragraph>> {
    let story = &doc.stories.iter().find(|s| s.self_id == story_id)?.story;
    let Some(addr) = cell else {
        return Some(&story.paragraphs);
    };
    story.paragraphs.iter().find_map(|p| {
        let t = p.table.as_ref()?;
        if t.self_id.as_deref() != Some(addr.table_id.as_str()) {
            return None;
        }
        t.cells
            .iter()
            .find(|c| c.coords() == Some((addr.col, addr.row)))
            .map(|c| &c.paragraphs)
    })
}

fn spec(kind: ChangeSpecKind, author: &Option<String>, date: &Option<String>) -> ChangeSpec {
    ChangeSpec {
        kind,
        id: None,
        author: author.clone(),
        date: date.clone(),
        before_character_style: None,
        before_paragraph_style: None,
    }
}

/// The paragraph content offset `offset` stands in (a paragraph break
/// counts to the paragraph before it).
fn paragraph_of_content(paragraphs: &[Paragraph], offset: u32) -> usize {
    let mut consumed = 0u32;
    for (i, p) in paragraphs.iter().enumerate() {
        if i > 0 {
            consumed += 1;
        }
        let len: u32 = p.runs.iter().map(|r| r.text.len() as u32).sum();
        if offset <= consumed + len {
            return i;
        }
        consumed += len;
    }
    paragraphs.len().saturating_sub(1)
}

/// The batch a tracked text edit lowers to, or `None` when `m` is not a
/// text edit the lane records (or its story does not resolve: the plain
/// apply reports that).
pub(crate) fn lower_tracked(doc: &Document, m: &Mutation) -> Option<Vec<Mutation>> {
    let pref = &doc.designmap.document_preference;
    let (author, date) = (pref.track_changes_author.clone(), pref.review_clock.clone());
    match m {
        Mutation::InsertText {
            story_id,
            offset,
            text,
            cell,
        } => {
            let paragraphs = stream(doc, story_id, cell.as_ref())?;
            let text_n = text.replace("\r\n", "\n").replace(['\r', '\u{2029}'], "\n");
            let c0 = content_offset_to_char(paragraphs, *offset);
            let pi = paragraph_of_content(paragraphs, *offset);
            let chars = text_n.chars().filter(|c| *c != '\n').count() as u32;
            let marks = text_n.chars().filter(|c| *c == '\n').count() as u32;
            let mut ops = vec![m.clone()];
            if chars > 0 {
                ops.push(Mutation::RecordChange {
                    story_id: story_id.clone(),
                    start: c0,
                    end: c0 + chars,
                    cell: cell.clone(),
                    paragraph: None,
                    change: spec(ChangeSpecKind::Insert, &author, &date),
                });
            }
            for j in 0..marks {
                ops.push(Mutation::RecordChange {
                    story_id: story_id.clone(),
                    start: 0,
                    end: 0,
                    cell: cell.clone(),
                    paragraph: Some(pi as u32 + j),
                    change: spec(ChangeSpecKind::InsertMark, &author, &date),
                });
            }
            Some(ops)
        }
        Mutation::DeleteRange {
            story_id,
            start,
            end,
            cell,
        } => {
            let paragraphs = stream(doc, story_id, cell.as_ref())?;
            if end <= start {
                return None;
            }
            let own = |c: Option<&Change>| {
                c.is_some_and(|c| c.kind == ChangeKind::Insert && c.author == author)
            };
            let deleted = |c: Option<&Change>| c.is_some_and(|c| c.kind == ChangeKind::Delete);
            #[derive(PartialEq, Clone, Copy)]
            enum Act {
                Real,
                Mark,
                Skip,
            }
            // (action, char start, char end) for text; separators as marks.
            enum Piece {
                Text(Act, u32, u32),
                Break(Act, usize),
            }
            let (c_start, c_end) = (
                content_offset_to_char(paragraphs, *start),
                content_offset_to_char(paragraphs, *end),
            );
            let mut pieces: Vec<Piece> = Vec::new();
            let mut consumed = 0u32; // content offset of the paragraph start
            let mut pos = 0u32; // char offset of the paragraph start
            for (i, p) in paragraphs.iter().enumerate() {
                if i > 0 {
                    // The break between paragraph i-1 and i.
                    let sep = consumed;
                    if sep >= *start && sep < *end {
                        let m = paragraphs[i - 1].mark_revision.as_ref();
                        let act = if own(m) {
                            Act::Real
                        } else if deleted(m) {
                            Act::Skip
                        } else {
                            Act::Mark
                        };
                        pieces.push(Piece::Break(act, i - 1));
                    }
                    consumed += 1;
                }
                let mut rpos = pos;
                for r in &p.runs {
                    let n = r.text.chars().count() as u32;
                    let (a, b) = (c_start.max(rpos), c_end.min(rpos + n));
                    if a < b {
                        let act = if own(r.revision.as_ref()) {
                            Act::Real
                        } else if deleted(r.revision.as_ref()) {
                            Act::Skip
                        } else {
                            Act::Mark
                        };
                        match pieces.last_mut() {
                            Some(Piece::Text(last, _, e)) if *last == act && *e == a => *e = b,
                            _ => pieces.push(Piece::Text(act, a, b)),
                        }
                    }
                    rpos += n;
                }
                consumed += p.runs.iter().map(|r| r.text.len() as u32).sum::<u32>();
                pos += paragraph_chars(p);
            }
            let mut ops = Vec::new();
            for piece in pieces.into_iter().rev() {
                match piece {
                    Piece::Text(Act::Real, a, b) => ops.push(Mutation::DeleteRange {
                        story_id: story_id.clone(),
                        start: char_to_content_offset(paragraphs, a),
                        end: char_to_content_offset(paragraphs, b),
                        cell: cell.clone(),
                    }),
                    Piece::Text(Act::Mark, a, b) => ops.push(Mutation::RecordChange {
                        story_id: story_id.clone(),
                        start: a,
                        end: b,
                        cell: cell.clone(),
                        paragraph: None,
                        change: spec(ChangeSpecKind::Delete, &author, &date),
                    }),
                    Piece::Break(Act::Real, i) => {
                        // The break's content offset: the end of paragraph i.
                        let at: u32 = paragraphs[..=i]
                            .iter()
                            .map(|p| p.runs.iter().map(|r| r.text.len() as u32).sum::<u32>())
                            .sum::<u32>()
                            + i as u32;
                        ops.push(Mutation::DeleteRange {
                            story_id: story_id.clone(),
                            start: at,
                            end: at + 1,
                            cell: cell.clone(),
                        });
                    }
                    Piece::Break(Act::Mark, i) => ops.push(Mutation::RecordChange {
                        story_id: story_id.clone(),
                        start: 0,
                        end: 0,
                        cell: cell.clone(),
                        paragraph: Some(i as u32),
                        change: spec(ChangeSpecKind::DeleteMark, &author, &date),
                    }),
                    _ => {}
                }
            }
            Some(ops)
        }
        _ => None,
    }
}

/// The tracked changes of a story's body, one row per change id, in text
/// order of their first place.
pub(crate) fn change_rows(story_id: &str, paragraphs: &[Paragraph]) -> Vec<TrackedChangeSummary> {
    let mut rows: Vec<TrackedChangeSummary> = Vec::new();
    let mut add = |c: &Change, kind: &str, start: u32, end: u32, text: &str, para: Option<u32>| {
        if let Some(row) = rows
            .iter_mut()
            .find(|r| r.id.as_deref() == Some(c.id.as_str()))
        {
            row.offset = row.offset.min(start);
            row.end = Some(row.end.unwrap_or(end).max(end));
            row.text.push_str(text);
            // A text change names the row; a mark joins it.
            if row.kind.as_deref().is_some_and(|k| k.ends_with("Mark")) && !kind.ends_with("Mark") {
                row.kind = Some(kind.to_string());
            }
            return;
        }
        rows.push(TrackedChangeSummary {
            story_id: story_id.to_string(),
            offset: start,
            change_type: match c.kind {
                ChangeKind::Insert => "InsertedText",
                ChangeKind::Delete => "DeletedText",
                ChangeKind::Format => "FormatChange",
                ChangeKind::ParaProps => "ParagraphChange",
            }
            .to_string(),
            user_name: c.author.clone(),
            date: c.date.clone(),
            text: text.to_string(),
            id: Some(c.id.clone()),
            kind: Some(kind.to_string()),
            end: Some(end),
            paragraph: para,
        });
    };
    let mut pos = 0u32;
    for (pi, p) in paragraphs.iter().enumerate() {
        let n = paragraph_chars(p);
        if let Some(pc) = p.props_change.as_ref() {
            add(&pc.change, "paraProps", pos, pos + n, "", Some(pi as u32));
        }
        let mut rpos = pos;
        for r in &p.runs {
            let m = r.text.chars().count() as u32;
            if let Some(c) = r.revision.as_ref() {
                add(c, c.kind.as_str(), rpos, rpos + m, &r.text, None);
            }
            if let Some(fc) = r.format_change.as_ref() {
                add(&fc.change, "format", rpos, rpos + m, &r.text, None);
            }
            rpos += m;
        }
        if let Some(c) = p.mark_revision.as_ref() {
            let kind = if c.kind == ChangeKind::Delete {
                "deleteMark"
            } else {
                "insertMark"
            };
            add(c, kind, pos + n, pos + n, "\r", Some(pi as u32));
        }
        pos += n;
    }
    rows
}

/// A story's comments, each thread's root followed by its replies.
pub(crate) fn comment_rows(story_id: &str, story: &paged_model::Story) -> Vec<CommentSummary> {
    let range = |id: &str| -> Option<(u32, u32, String)> {
        let mut pos = 0u32;
        let mut out: Option<(u32, u32, String)> = None;
        for p in &story.paragraphs {
            for r in &p.runs {
                let n = r.text.chars().count() as u32;
                if r.comments.iter().any(|c| c == id) {
                    let e = out.get_or_insert((pos, pos + n, String::new()));
                    e.1 = pos + n;
                    e.2.push_str(&r.text);
                }
                pos += n;
            }
        }
        out
    };
    let row = |c: &paged_model::Comment, root: &str| {
        let r = range(root);
        CommentSummary {
            id: c.id.clone(),
            story_id: story_id.to_string(),
            parent_id: c.parent.clone(),
            start: r.as_ref().map(|r| r.0),
            end: r.as_ref().map(|r| r.1),
            anchor_text: r.map(|r| r.2).unwrap_or_default(),
            text: c.text.clone(),
            author: c.author.clone(),
            initials: c.initials.clone(),
            date: c.date.clone(),
            resolved: c.resolved,
        }
    };
    let mut out = Vec::new();
    for root in story.comments.iter().filter(|c| c.parent.is_none()) {
        out.push(row(root, &root.id));
        for reply in story
            .comments
            .iter()
            .filter(|c| c.parent.as_deref() == Some(root.id.as_str()))
        {
            out.push(row(reply, &root.id));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_date_reads_the_epoch_and_a_leap_day() {
        assert_eq!(iso_date(0.0), "1970-01-01T00:00:00Z");
        // 2024-02-29T12:34:56Z
        assert_eq!(iso_date(1_709_210_096_000.0), "2024-02-29T12:34:56Z");
    }
}
