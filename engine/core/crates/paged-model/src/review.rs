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

//! Engine ADRs 1040 and 1020 — tracked changes over text ranges and range
//! comments with threads, Word's review model.
//!
//! A change is carried by what it changed, as Word carries `w:ins`,
//! `w:del`, `w:rPrChange` and `w:pPrChange`: an inserted or deleted run
//! names its [`Change`] in [`CharacterRun::revision`], a run whose
//! formatting changed keeps its properties before in
//! [`CharacterRun::format_change`], a paragraph its properties before in
//! [`Paragraph::props_change`], and a paragraph mark that was inserted or
//! deleted is [`Paragraph::mark_revision`]. Text edits split and join runs
//! with the change they carry, so a change's range follows its text. A
//! deleted run keeps its text; the [`MarkupView`] decides what shows.
//!
//! A comment's range is the runs that name its id in
//! [`CharacterRun::comments`]; the thread (the root and its replies) is
//! [`crate::Story::comments`].

use serde::{Deserialize, Serialize};

use crate::{CharacterRun, ColorEntry, ColorModel, ColorSpace, Paragraph};

/// What a tracked change did.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ChangeKind {
    /// Text (or a paragraph mark) inserted: `w:ins`.
    Insert,
    /// Text (or a paragraph mark) deleted: `w:del`.
    Delete,
    /// Character formatting changed: `w:rPrChange`.
    Format,
    /// Paragraph formatting changed: `w:pPrChange`.
    ParaProps,
}

impl ChangeKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ChangeKind::Insert => "insert",
            ChangeKind::Delete => "delete",
            ChangeKind::Format => "format",
            ChangeKind::ParaProps => "paraProps",
        }
    }
}

/// One tracked change: its id (unique in the document), what it did, who
/// did it and when. The engine reads no clock: `date` is what the host
/// stamped (Word's `w:date`, ISO 8601), and may be absent as Word allows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Change {
    pub id: String,
    pub kind: ChangeKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub date: Option<String>,
}

/// A tracked formatting change on a run: the change and the run's
/// properties before it (a run with no text and no review state).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FormatChange {
    pub change: Change,
    pub before: Box<CharacterRun>,
}

/// A tracked paragraph-formatting change: the change and the paragraph's
/// properties before it (a paragraph with no content).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParaPropsChange {
    pub change: Change,
    pub before: Box<Paragraph>,
}

/// One comment of a thread (engine ADR 1020): Word's `w:comment`, with
/// `commentsExtended`' parent and done flag. A root comment (no `parent`)
/// covers the runs that name its id; a reply names its root.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Comment {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub initials: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub date: Option<String>,
    /// The comment's text, its paragraphs separated by `\n`.
    #[serde(default)]
    pub text: String,
    /// Word's "Resolve" (`w15:done`).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub resolved: bool,
}

/// How tracked changes and comments show (Word's Review ▸ Display for
/// Review). A render option of the document.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MarkupView {
    /// Simple Markup: the text as if every change were accepted.
    Simple,
    /// All Markup: insertions underlined and deletions struck through in
    /// their author's colour, commented text highlighted.
    #[default]
    All,
    /// No Markup: the text as if every change were accepted.
    None,
    /// Original: the text as if every change were rejected.
    Original,
}

impl MarkupView {
    pub fn as_str(self) -> &'static str {
        match self {
            MarkupView::Simple => "simple",
            MarkupView::All => "all",
            MarkupView::None => "none",
            MarkupView::Original => "original",
        }
    }

    pub fn parse(s: &str) -> Option<MarkupView> {
        Some(match s {
            "simple" => MarkupView::Simple,
            "all" => MarkupView::All,
            "none" => MarkupView::None,
            "original" => MarkupView::Original,
            _ => return None,
        })
    }

    /// Whether the view hides a run carrying `revision`.
    pub fn hides(self, revision: Option<&Change>) -> bool {
        matches!(
            (self, revision.map(|c| c.kind)),
            (
                MarkupView::Simple | MarkupView::None,
                Some(ChangeKind::Delete)
            ) | (MarkupView::Original, Some(ChangeKind::Insert))
        )
    }
}

impl CharacterRun {
    /// The run's properties alone: no text, no content identity, no review
    /// state. What a [`FormatChange`] keeps as `before`.
    pub fn props_snapshot(&self) -> CharacterRun {
        let mut p = self.clone();
        p.text.clear();
        p.hyperlink_source = None;
        p.text_variable = None;
        p.placeholder = None;
        p.field = None;
        p.revision = None;
        p.format_change = None;
        p.comments.clear();
        p.nested_character_style = None;
        p
    }

    /// This run with the properties of `before` (a [`Self::props_snapshot`])
    /// and its own text, content and review state: what rejecting a
    /// formatting change leaves. The format change itself is gone.
    pub fn with_props_of(&self, before: &CharacterRun) -> CharacterRun {
        let mut p = before.clone();
        p.text = self.text.clone();
        p.hyperlink_source = self.hyperlink_source.clone();
        p.text_variable = self.text_variable.clone();
        p.placeholder = self.placeholder.clone();
        p.field = self.field.clone();
        p.revision = self.revision.clone();
        p.comments = self.comments.clone();
        p.nested_character_style = self.nested_character_style.clone();
        p.format_change = None;
        p
    }
}

impl Paragraph {
    /// The paragraph's properties alone: no runs, no anchored content, no
    /// review state. What a [`ParaPropsChange`] keeps as `before`.
    pub fn props_snapshot(&self) -> Paragraph {
        let mut p = self.clone();
        p.runs.clear();
        p.anchored_frames.clear();
        p.anchored_frame_offsets.clear();
        p.table = None;
        p.table_anchor = None;
        p.footnotes.clear();
        p.endnote_references.clear();
        p.endnote_ranges.clear();
        p.notes.clear();
        p.tracked_deletions.clear();
        p.index_markers.clear();
        p.toc = None;
        p.mark_revision = None;
        p.props_change = None;
        p
    }

    /// Give this paragraph the properties of `before` (a
    /// [`Self::props_snapshot`]) and keep its own content and review state
    /// (the paragraph-formatting change itself is gone): what rejecting a
    /// paragraph-formatting change leaves.
    pub fn restore_props(&mut self, before: &Paragraph) {
        let mut p = before.clone();
        p.runs = std::mem::take(&mut self.runs);
        p.anchored_frames = std::mem::take(&mut self.anchored_frames);
        p.anchored_frame_offsets = std::mem::take(&mut self.anchored_frame_offsets);
        p.table = self.table.take();
        p.table_anchor = self.table_anchor.take();
        p.footnotes = std::mem::take(&mut self.footnotes);
        p.endnote_references = std::mem::take(&mut self.endnote_references);
        p.endnote_ranges = std::mem::take(&mut self.endnote_ranges);
        p.notes = std::mem::take(&mut self.notes);
        p.tracked_deletions = std::mem::take(&mut self.tracked_deletions);
        p.index_markers = std::mem::take(&mut self.index_markers);
        p.toc = self.toc.take();
        p.mark_revision = self.mark_revision.take();
        p.props_change = None;
        *self = p;
    }
}

/// The reserved colour ids the markup is drawn in: one per author slot.
/// They resolve without a swatch ([`review_color`]), so a document needs
/// none of its own.
pub const REVIEW_COLOR_PREFIX: &str = "Color/paged-review-";

/// The reserved highlight ids commented text is shaded with, per slot.
pub const REVIEW_HIGHLIGHT_PREFIX: &str = "Color/paged-review-hl-";

/// Word's author colours (By author), in sRGB 0..255: the k-th author slot
/// draws in the k-th.
const AUTHOR_RGB: [[f32; 3]; 8] = [
    [182.0, 18.0, 52.0],  // red
    [36.0, 86.0, 196.0],  // blue
    [0.0, 128.0, 64.0],   // green
    [148.0, 54.0, 160.0], // violet
    [196.0, 102.0, 0.0],  // orange
    [0.0, 128.0, 140.0],  // teal
    [120.0, 76.0, 40.0],  // brown
    [196.0, 0.0, 128.0],  // magenta
];

/// The author slot of `author`: a stable hash of the name, so an author
/// keeps one colour across documents and sessions.
pub fn author_slot(author: Option<&str>) -> usize {
    let name = author.unwrap_or("");
    // FNV-1a.
    let mut h: u32 = 0x811c_9dc5;
    for b in name.bytes() {
        h ^= u32::from(b);
        h = h.wrapping_mul(0x0100_0193);
    }
    (h as usize) % AUTHOR_RGB.len()
}

/// The colour id the markup of `author`'s changes is drawn in.
pub fn review_color_id(author: Option<&str>) -> String {
    format!("{REVIEW_COLOR_PREFIX}{}", author_slot(author))
}

/// The highlight id `author`'s commented text is shaded with.
pub fn review_highlight_id(author: Option<&str>) -> String {
    format!("{REVIEW_HIGHLIGHT_PREFIX}{}", author_slot(author))
}

static REVIEW_COLORS: std::sync::LazyLock<Vec<ColorEntry>> = std::sync::LazyLock::new(|| {
    let entry = |id: String, rgb: [f32; 3]| ColorEntry {
        self_id: id,
        name: None,
        space: ColorSpace::Rgb,
        value: rgb.to_vec(),
        model: ColorModel::Process,
        alternate_space: None,
        alternate_value: Vec::new(),
        tint: None,
        alpha: None,
    };
    let mut out = Vec::new();
    for (k, rgb) in AUTHOR_RGB.iter().enumerate() {
        out.push(entry(format!("{REVIEW_COLOR_PREFIX}{k}"), *rgb));
    }
    for (k, rgb) in AUTHOR_RGB.iter().enumerate() {
        // A pale tint of the author's colour, for the band behind the text.
        let pale = rgb.map(|c| 255.0 - (255.0 - c) * 0.22);
        out.push(entry(format!("{REVIEW_HIGHLIGHT_PREFIX}{k}"), pale));
    }
    out
});

/// A reserved review colour, when `id` names one.
pub fn review_color(id: &str) -> Option<&'static ColorEntry> {
    if !id.starts_with(REVIEW_COLOR_PREFIX) {
        return None;
    }
    REVIEW_COLORS.iter().find(|e| e.self_id == id)
}

/// The character count of a paragraph's text (its runs').
pub fn paragraph_chars(p: &Paragraph) -> u32 {
    p.runs.iter().map(|r| r.text.chars().count() as u32).sum()
}

/// Split the runs of `para` so that paragraph-local characters `[from, to)`
/// are whole runs, and return the indices of those runs (empty for an
/// empty range). Runs outside keep their text and properties.
pub fn isolate_para_chars(para: &mut Paragraph, from: u32, to: u32) -> std::ops::Range<usize> {
    if from >= to {
        return 0..0;
    }
    let split_at = |para: &mut Paragraph, at: u32| {
        let mut pos = 0u32;
        for i in 0..para.runs.len() {
            let n = para.runs[i].text.chars().count() as u32;
            if at > pos && at < pos + n {
                let k = (at - pos) as usize;
                let byte = para.runs[i]
                    .text
                    .char_indices()
                    .nth(k)
                    .map_or(para.runs[i].text.len(), |(b, _)| b);
                let tail_text = para.runs[i].text.split_off(byte);
                let mut tail = para.runs[i].clone();
                tail.text = tail_text;
                para.runs.insert(i + 1, tail);
                return;
            }
            pos += n;
        }
    };
    split_at(para, from);
    split_at(para, to);
    let mut pos = 0u32;
    let (mut first, mut last) = (usize::MAX, 0usize);
    for (i, r) in para.runs.iter().enumerate() {
        let n = r.text.chars().count() as u32;
        if n > 0 && pos >= from && pos + n <= to {
            first = first.min(i);
            last = i + 1;
        }
        pos += n;
    }
    if first == usize::MAX {
        0..0
    } else {
        first..last
    }
}

/// The paragraph-local pieces of story characters `[start, end)` (counted
/// contiguously over the paragraphs' runs, no separators): `(paragraph,
/// from, to)` per paragraph the range touches.
pub fn story_char_pieces(paragraphs: &[Paragraph], start: u32, end: u32) -> Vec<(usize, u32, u32)> {
    let mut out = Vec::new();
    let mut pos = 0u32;
    for (i, p) in paragraphs.iter().enumerate() {
        let n = paragraph_chars(p);
        let (a, b) = (start.max(pos), end.min(pos + n));
        if a < b {
            out.push((i, a - pos, b - pos));
        }
        pos += n;
    }
    out
}

/// Every [`Change`] the paragraphs carry, with the place it is carried
/// (run revisions, format changes, paragraph marks and paragraph
/// formatting), table cells included, in text order.
pub fn changes_in(paragraphs: &[Paragraph]) -> Vec<&Change> {
    let mut out = Vec::new();
    fn walk<'a>(paragraphs: &'a [Paragraph], out: &mut Vec<&'a Change>) {
        for p in paragraphs {
            if let Some(c) = p.props_change.as_ref() {
                out.push(&c.change);
            }
            for r in &p.runs {
                if let Some(c) = r.revision.as_ref() {
                    out.push(c);
                }
                if let Some(c) = r.format_change.as_ref() {
                    out.push(&c.change);
                }
            }
            if let Some(t) = p.table.as_ref() {
                for cell in &t.cells {
                    walk(&cell.paragraphs, out);
                }
            }
            if let Some(c) = p.mark_revision.as_ref() {
                out.push(c);
            }
        }
    }
    walk(paragraphs, &mut out);
    out
}
