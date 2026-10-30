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

//! Doc ADR 613 — tracked changes and comments saved back as Word's.
//!
//! The run patcher (ADR 602) addresses runs by their ordinal among a
//! paragraph's direct `<w:r>` children, and a run inside `w:ins` / `w:del`
//! has none. So a body paragraph whose review markup changed (a change
//! recorded, accepted or rejected in paged, a comment added, answered or
//! removed) or that holds review markup and was edited is written WHOLE
//! here, from the read-back runs, before the run patcher runs:
//!
//! - its `<w:p>` start tag and its `<w:pPr>` stay (with the paragraph
//!   edit the differ found merged in, and its mark's `w:ins` / `w:del` and
//!   `w:pPrChange` rewritten);
//! - each run keeps the `<w:rPr>` bytes of the Word run its text came from
//!   (with only what changed rewritten), wrapped in `w:ins` / `w:del` as its
//!   change says, its `w:rPrChange` kept or written;
//! - comment ranges and references are written where the read-back runs'
//!   comments start and end; bookmarks stay at their place in the text.
//!
//! A tracked paragraph mark inserted in paged splits the paragraph in two;
//! one removed (a rejected insertion, an accepted deletion) joins it to the
//! next, whose `<w:p>` goes. A paragraph holding what this writer cannot
//! write (a field, a picture, a hyperlink, a content control, a move) is
//! refused and named. The comment parts are then written from the
//! read-back comments: a comment whose text and state did not change keeps
//! its bytes; the parts, their relationships and content types are made
//! when missing.

use std::collections::{BTreeMap, BTreeSet};

use docx_lower::ir::{LoweredBlock, LoweredChange, LoweredDoc, LoweredParagraph, LoweredRun};
use paged_ooxml::splice::{root_children, Span};
use paged_ooxml::{OoxmlError, OpcPackage};
use quick_xml::events::Event;
use quick_xml::Reader;

use crate::bindings::DocxBindings;
use crate::diff::{align_chars, effective_props, Align};
use crate::edit::{AtomInsert, EditSet, ParaEdit, RunFormat, StructuralEdit};
use crate::overlay::{
    ChangeContentIn, CommentContentIn, ParagraphContentIn, PropsChangeContentIn, RunContentIn,
    StoryContentIn, TableParagraphs,
};
use crate::rpr;

/// The attribute that marks a `<w:p>` a join removes once the run patcher
/// is done (it never reaches a saved file).
const MERGED_MARK: &str = " paged-review-merged=\"1\"";

/// What the read-back paragraphs say beyond the 1:1 overlay: tracked
/// paragraph marks inserted (a block poured back as several paragraphs)
/// and removed (several blocks poured back as one).
#[derive(Debug, Clone, Default)]
pub struct ReviewPlan {
    /// Block → the run boundaries after which a new paragraph starts, each
    /// with the inserted mark of the paragraph that ends there.
    pub splits: BTreeMap<usize, Vec<(usize, LoweredChange)>>,
    /// Join head block → the blocks joined into it (their `<w:p>` goes).
    pub merged: BTreeMap<usize, Vec<usize>>,
    /// The read-back comments, every story's.
    pub comments: Vec<CommentContentIn>,
    /// What could not be lined up; the review pass is off when non-empty.
    pub skips: Vec<String>,
    /// The read-back paragraphs line up with the blocks.
    pub active: bool,
}

/// One read-back slot of the overlay walk.
#[derive(Clone, Copy)]
enum Slot {
    /// `n` read-back paragraphs taken as they are (a table's, a paragraph
    /// split by page breaks).
    Copy(usize),
    /// One Word paragraph (no break inside).
    Para(usize),
}

fn is_insert(kind: &str) -> bool {
    matches!(kind, "insert" | "insertMark")
}

/// The overlay's slots, as `overlay_story_content_with` walks the blocks.
fn slots(base: &LoweredDoc, tables: TableParagraphs) -> Vec<Slot> {
    let mut out = Vec::new();
    for (b, block) in base.story.blocks.iter().enumerate() {
        match block {
            LoweredBlock::Paragraph(p) if p.segments.is_empty() => out.push(Slot::Para(b)),
            LoweredBlock::Paragraph(p) => out.push(Slot::Copy(1 + p.segments.len())),
            LoweredBlock::Table(t) => {
                let n: usize = t.flow.iter().map(|p| 1 + p.segments.len()).sum();
                let n = n + usize::from(t.flow.is_empty() && tables == TableParagraphs::Own);
                if n > 0 {
                    out.push(Slot::Copy(n));
                }
            }
        }
    }
    out
}

/// A baseline paragraph as the engine would read it back unchanged (its
/// runs, looks and review markup).
pub fn content_of(p: &LoweredParagraph) -> ParagraphContentIn {
    let change = |c: &LoweredChange| ChangeContentIn {
        id: c.id.clone(),
        kind: c.kind.clone(),
        author: c.author.clone(),
        date: c.date.clone(),
    };
    ParagraphContentIn {
        paragraph_style: p.para_style_id.clone(),
        runs: p
            .runs
            .iter()
            .map(|r| RunContentIn {
                text: r.text.clone(),
                character_style: r.char_style_id.clone(),
                field_code: r.field.as_ref().map(|f| f.code.clone()),
                change: r.change.as_ref().map(change),
                format_change: r.format_change.as_ref().map(|f| {
                    Box::new(crate::overlay::FormatChangeContentIn {
                        change: change(&f.change),
                        before: RunContentIn {
                            character_style: f.before_char_style_id.clone(),
                            ..RunContentIn::default()
                        },
                    })
                }),
                comments: r.comments.clone(),
                ..RunContentIn::default()
            })
            .collect(),
        mark_change: p.mark_change.as_ref().map(change),
        props_change: p.props_change.as_ref().map(|c| PropsChangeContentIn {
            change: change(&c.change),
            before_paragraph_style: c.before_para_style_id.clone(),
        }),
    }
}

fn text_of(runs: &[RunContentIn]) -> String {
    runs.iter().map(|r| r.text.as_str()).collect()
}

/// Line the read-back paragraphs up with the blocks, and give the overlay
/// one read-back paragraph per slot: a block split in paged comes back as
/// its pieces joined (the split remembered), a block joined in paged gives
/// the next block's slot that block unchanged (the join remembered).
pub fn prepare(
    base: &LoweredDoc,
    content: &StoryContentIn,
    tables: TableParagraphs,
) -> (StoryContentIn, ReviewPlan) {
    let mut plan = ReviewPlan {
        comments: content.comments.clone(),
        ..ReviewPlan::default()
    };
    let slots = slots(base, tables);
    let paragraph = |b: usize| match &base.story.blocks[b] {
        LoweredBlock::Paragraph(p) => Some(p),
        LoweredBlock::Table(_) => None,
    };
    let base_marks: BTreeSet<&str> = base
        .story
        .blocks
        .iter()
        .filter_map(|b| match b {
            LoweredBlock::Paragraph(p) => p.mark_change.as_ref().map(|c| c.id.as_str()),
            LoweredBlock::Table(_) => None,
        })
        .collect();
    let read_marks: BTreeSet<&str> = content
        .paragraphs
        .iter()
        .filter_map(|p| p.mark_change.as_ref().map(|c| c.id.as_str()))
        .collect();
    let new_split = |p: &ParagraphContentIn| {
        p.mark_change
            .as_ref()
            .is_some_and(|c| is_insert(&c.kind) && !base_marks.contains(c.id.as_str()))
    };
    // Blocks whose mark change is gone from the read-back and that a
    // paragraph follows: the joins to choose from.
    let candidates: Vec<usize> = slots
        .windows(2)
        .filter_map(|w| match (w[0], w[1]) {
            (Slot::Para(a), Slot::Para(b)) if b == a + 1 => paragraph(a)
                .and_then(|p| p.mark_change.as_ref())
                .filter(|c| !read_marks.contains(c.id.as_str()))
                .map(|_| a),
            _ => None,
        })
        .collect();
    let expected: usize = slots
        .iter()
        .map(|s| match s {
            Slot::Copy(n) => *n,
            Slot::Para(_) => 1,
        })
        .sum();
    let n = content.paragraphs.len();
    let splits = content
        .paragraphs
        .iter()
        .take(n.saturating_sub(1))
        .filter(|p| new_split(p))
        .count();
    let joins = expected as i64 + splits as i64 - n as i64;
    let walk = |merges: &BTreeSet<usize>| -> Option<(Vec<ParagraphContentIn>, ReviewPlan, i64)> {
        let mut out = Vec::new();
        let mut p = ReviewPlan::default();
        let mut j = 0usize;
        let mut score = 0i64;
        let mut absorbed: BTreeSet<usize> = BTreeSet::new();
        for (k, slot) in slots.iter().enumerate() {
            match *slot {
                Slot::Copy(c) => {
                    if j + c > n {
                        return None;
                    }
                    out.extend(content.paragraphs[j..j + c].iter().cloned());
                    j += c;
                }
                Slot::Para(b) if absorbed.contains(&b) => {
                    out.push(content_of(paragraph(b)?));
                }
                Slot::Para(b) => {
                    if j >= n {
                        return None;
                    }
                    let mut group = vec![&content.paragraphs[j]];
                    j += 1;
                    let mut cuts = Vec::new();
                    while new_split(group[group.len() - 1]) && j < n {
                        let runs: usize = group.iter().map(|g| g.runs.len()).sum();
                        let mark = group[group.len() - 1]
                            .mark_change
                            .as_ref()
                            .map(|c| c.lowered(true))
                            .unwrap_or_default();
                        cuts.push((runs, mark));
                        group.push(&content.paragraphs[j]);
                        j += 1;
                    }
                    let mut joined = ParagraphContentIn {
                        paragraph_style: group[0].paragraph_style.clone(),
                        runs: group.iter().flat_map(|g| g.runs.iter().cloned()).collect(),
                        mark_change: group[group.len() - 1].mark_change.clone(),
                        props_change: group[0].props_change.clone(),
                    };
                    let mut base_text: String =
                        paragraph(b)?.runs.iter().map(|r| r.text.as_str()).collect();
                    if merges.contains(&b) {
                        let mut tail = Vec::new();
                        let mut at = k;
                        let mut cur = b;
                        while merges.contains(&cur) {
                            match slots.get(at + 1) {
                                Some(Slot::Para(next)) if *next == cur + 1 => {
                                    tail.push(*next);
                                    absorbed.insert(*next);
                                    base_text.extend(
                                        paragraph(*next)?.runs.iter().map(|r| r.text.as_str()),
                                    );
                                    cur = *next;
                                    at += 1;
                                }
                                _ => return None,
                            }
                        }
                        // The joined paragraph ends in the last one's mark.
                        joined.mark_change = group[group.len() - 1].mark_change.clone();
                        p.merged.insert(b, tail);
                    }
                    if !cuts.is_empty() {
                        p.splits.insert(b, cuts);
                    }
                    let read_text = text_of(&joined.runs);
                    score +=
                        (read_text.chars().count() as i64 - base_text.chars().count() as i64).abs();
                    let head = |s: &str| s.chars().take(24).collect::<String>();
                    if head(&read_text) != head(&base_text) {
                        score += 8;
                    }
                    out.push(joined);
                }
            }
        }
        (j == n).then_some((out, p, score))
    };
    let fail = |plan: &mut ReviewPlan, why: String| {
        plan.skips.push(why);
        plan.active = false;
    };
    let mut best: Option<(Vec<ParagraphContentIn>, ReviewPlan, i64)> = None;
    if joins < 0 || joins as usize > candidates.len() {
        if splits > 0 || !candidates.is_empty() {
            fail(
                &mut plan,
                format!(
                    "tracked changes not saved: the {n} read-back paragraph(s) do not line up with the document's {expected}"
                ),
            );
        }
        plan.active = plan.skips.is_empty() && n == expected;
        let mut c = content.clone();
        c.comments.clear();
        return (c, plan);
    }
    let k = joins as usize;
    if candidates.len() > 16 && k > 0 && k < candidates.len() {
        fail(
            &mut plan,
            "tracked changes not saved: too many paragraph joins to line up".into(),
        );
        return (content.clone(), plan);
    }
    // Every choice of `k` joins among the candidates (k = 0 or all: one).
    let mut choose = |set: &BTreeSet<usize>| {
        if let Some(found) = walk(set) {
            if best.as_ref().is_none_or(|b| found.2 < b.2) {
                best = Some(found);
            }
        }
    };
    if k == 0 {
        choose(&BTreeSet::new());
    } else if k == candidates.len() {
        choose(&candidates.iter().copied().collect());
    } else {
        let m = candidates.len();
        for mask in 0u32..(1u32 << m) {
            if mask.count_ones() as usize == k {
                let set = (0..m)
                    .filter(|i| mask & (1 << i) != 0)
                    .map(|i| candidates[i])
                    .collect();
                choose(&set);
            }
        }
    }
    match best {
        Some((paragraphs, p, _)) => {
            plan.splits = p.splits;
            plan.merged = p.merged;
            plan.active = true;
            (
                StoryContentIn {
                    self_id: content.self_id.clone(),
                    paragraphs,
                    comments: content.comments.clone(),
                },
                plan,
            )
        }
        None => {
            if splits > 0 || !candidates.is_empty() {
                fail(
                    &mut plan,
                    "tracked changes not saved: the read-back paragraphs do not line up with the document"
                        .into(),
                );
            }
            plan.active = false;
            (content.clone(), plan)
        }
    }
}

/// One char of a paragraph as save-back compares it: its text, its look,
/// its change, its format change and its comments.
type CharSig = (
    char,
    RunFormat,
    Option<(String, String)>,
    Option<String>,
    Vec<String>,
);

fn change_key(c: &Option<LoweredChange>) -> Option<(String, String)> {
    c.as_ref().map(|c| (c.id.clone(), c.kind.clone()))
}

fn has_review(p: &LoweredParagraph) -> bool {
    p.mark_change.is_some()
        || p.props_change.is_some()
        || p.runs
            .iter()
            .any(|r| r.change.is_some() || r.format_change.is_some() || !r.comments.is_empty())
}

fn signature(p: &LoweredParagraph, doc: &LoweredDoc, bindings: &DocxBindings) -> Vec<CharSig> {
    let para = p.para_style_id.as_deref();
    p.runs
        .iter()
        .flat_map(|r| {
            let (props, rstyle) = effective_props(r.char_style_id.as_deref(), para, doc, bindings);
            let look = RunFormat { props, rstyle };
            let change = change_key(&r.change);
            let format = r.format_change.as_ref().map(|f| f.change.id.clone());
            let comments = r.comments.clone();
            r.text
                .chars()
                .map(move |c| {
                    (
                        c,
                        look.clone(),
                        change.clone(),
                        format.clone(),
                        comments.clone(),
                    )
                })
                .collect::<Vec<_>>()
        })
        .collect()
}

/// The thread members (first comment, then replies) of each comment.
fn threads_of(comments: &[(String, Option<String>)]) -> BTreeMap<String, Vec<String>> {
    let mut out: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for (id, parent) in comments {
        match parent {
            None => out.entry(id.clone()).or_default().insert(0, id.clone()),
            Some(p) => out.entry(p.clone()).or_default().push(id.clone()),
        }
    }
    out
}

/// The body paragraph blocks this pass writes: every block a split or a
/// join touches, and every one with review markup (before or after) whose
/// text, look, markup or comment threads changed.
pub fn dirty_blocks(
    base: &LoweredDoc,
    edited: &LoweredDoc,
    bindings: &DocxBindings,
    plan: &ReviewPlan,
) -> BTreeSet<usize> {
    let mut out = BTreeSet::new();
    if !plan.active {
        return out;
    }
    out.extend(plan.splits.keys().copied());
    out.extend(plan.merged.keys().copied());
    let base_threads = threads_of(
        &base
            .comments
            .iter()
            .map(|c| (c.id.clone(), c.parent_id.clone()))
            .collect::<Vec<_>>(),
    );
    let read_threads = threads_of(
        &plan
            .comments
            .iter()
            .map(|c| (c.id.clone(), c.parent_id.clone()))
            .collect::<Vec<_>>(),
    );
    for (b, (x, y)) in base
        .story
        .blocks
        .iter()
        .zip(edited.story.blocks.iter())
        .enumerate()
    {
        let (LoweredBlock::Paragraph(x), LoweredBlock::Paragraph(y)) = (x, y) else {
            continue;
        };
        if !has_review(x) && !has_review(y) {
            continue;
        }
        let threads = |p: &LoweredParagraph, t: &BTreeMap<String, Vec<String>>| {
            let roots: BTreeSet<&String> = p.runs.iter().flat_map(|r| r.comments.iter()).collect();
            roots
                .into_iter()
                .map(|r| t.get(r).cloned().unwrap_or_default())
                .collect::<Vec<_>>()
        };
        if signature(x, base, bindings) != signature(y, edited, bindings)
            || change_key(&x.mark_change) != change_key(&y.mark_change)
            || x.props_change.as_ref().map(|c| &c.change.id)
                != y.props_change.as_ref().map(|c| &c.change.id)
            || x.para_style_id != y.para_style_id
            || threads(x, &base_threads) != threads(y, &read_threads)
        {
            out.insert(b);
        }
    }
    out
}

/// `edited` with every block this pass writes (and every block a join
/// takes) as it was: the differ then neither edits nor realigns around them.
pub fn masked(
    base: &LoweredDoc,
    edited: &LoweredDoc,
    dirty: &BTreeSet<usize>,
    plan: &ReviewPlan,
) -> LoweredDoc {
    let mut out = edited.clone();
    let joined: BTreeSet<usize> = plan.merged.values().flatten().copied().collect();
    for (b, block) in out.story.blocks.iter_mut().enumerate() {
        if dirty.contains(&b) || joined.contains(&b) {
            if let Some(orig) = base.story.blocks.get(b) {
                *block = orig.clone();
            }
        }
    }
    out
}

/// The paragraph edits of the blocks this pass writes: their style and
/// direct paragraph formatting read back, as the differ finds them.
pub fn para_edits(
    base: &LoweredDoc,
    edited: &LoweredDoc,
    bindings: &DocxBindings,
    dirty: &BTreeSet<usize>,
) -> Vec<ParaEdit> {
    let mut out = Vec::new();
    for &b in dirty {
        let (Some(LoweredBlock::Paragraph(bp)), Some(LoweredBlock::Paragraph(ep))) =
            (base.story.blocks.get(b), edited.story.blocks.get(b))
        else {
            continue;
        };
        let (b_props, b_style) =
            crate::diff::effective_para_props(bp.para_style_id.as_deref(), base, bindings);
        let (e_props, e_style) =
            crate::diff::effective_para_props(ep.para_style_id.as_deref(), edited, bindings);
        if b_props != e_props || b_style != e_style {
            out.push(ParaEdit {
                block: b,
                new_props: e_props,
                pstyle: Some(e_style),
            });
        }
    }
    out
}

/// `edits` without what targets a block this pass writes, and the
/// paragraph edits of those blocks (merged into their `w:pPr` here).
pub fn take_dirty(
    edits: &mut EditSet,
    atoms: &mut Vec<AtomInsert>,
    dirty: &BTreeSet<usize>,
) -> Vec<ParaEdit> {
    edits.runs.retain(|e| !dirty.contains(&e.block));
    edits.structural.retain(|s| match s {
        StructuralEdit::DeleteRun { block, .. }
        | StructuralEdit::InsertRun { block, .. }
        | StructuralEdit::SplitRun { block, .. }
        | StructuralEdit::DeleteParagraph { block } => !dirty.contains(block),
        _ => true,
    });
    atoms.retain(|a| !dirty.contains(&a.block));
    let (mine, rest): (Vec<ParaEdit>, Vec<ParaEdit>) = std::mem::take(&mut edits.paragraphs)
        .into_iter()
        .partition(|p| dirty.contains(&p.block));
    edits.paragraphs = rest;
    mine
}

// ---------------------------------------------------------------------------
// The source paragraph

/// A Word run of a paragraph that carries text, as the import counted it.
#[derive(Debug, Clone, Default)]
struct SrcRun {
    chars: u32,
    /// Its `<w:rPr>`, its `w:rPrChange` taken out.
    rpr: Option<Vec<u8>>,
    /// Its `w:rPrChange` element.
    rpr_change: Option<Vec<u8>>,
}

/// What this pass keeps of a source `<w:p>`.
#[derive(Debug, Clone, Default)]
struct SrcPara {
    start_tag: Vec<u8>,
    ppr: Option<Vec<u8>>,
    runs: Vec<SrcRun>,
    /// Bookmark starts and ends, each at the char offset it stands at.
    bookmarks: Vec<(u32, Vec<u8>)>,
}

/// The local name of a qualified name.
fn local(name: &[u8]) -> &[u8] {
    paged_ooxml::xml::local_name(name)
}

/// Read a source `<w:p>` (`xml` is the element). `Err` names what this
/// pass cannot write.
fn read_paragraph(xml: &[u8]) -> Result<SrcPara, String> {
    let mut r = Reader::from_reader(xml);
    r.config_mut().trim_text(false);
    let mut out = SrcPara::default();
    let mut depth = 0usize;
    // The open run and whether text is being read (`w:t`, `w:delText`).
    let mut run: Option<SrcRun> = None;
    let mut in_text = false;
    let mut chars = 0u32;
    loop {
        let start = r.buffer_position() as usize;
        let ev = r
            .read_event()
            .map_err(|e| format!("unreadable XML ({e})"))?;
        let end = r.buffer_position() as usize;
        match ev {
            Event::Start(_) | Event::Empty(_) if depth == 0 => {
                out.start_tag = xml[start..end].to_vec();
                if out.start_tag.ends_with(b"/>") {
                    let mut t = out.start_tag[..out.start_tag.len() - 2].to_vec();
                    while t.last() == Some(&b' ') {
                        t.pop();
                    }
                    t.push(b'>');
                    out.start_tag = t;
                    return Ok(out);
                }
                depth = 1;
            }
            Event::Start(e) => {
                let name = e.name().as_ref().to_vec();
                let ln = local(&name).to_vec();
                match (ln.as_slice(), run.is_some()) {
                    (b"pPr", false) if depth == 1 => {
                        r.read_to_end(quick_xml::name::QName(&name))
                            .map_err(|e| e.to_string())?;
                        out.ppr = Some(xml[start..r.buffer_position() as usize].to_vec());
                        continue;
                    }
                    (b"ins" | b"del", false) if depth == 1 => {}
                    (b"r", false) => run = Some(SrcRun::default()),
                    (b"rPr", true) => {
                        r.read_to_end(quick_xml::name::QName(&name))
                            .map_err(|e| e.to_string())?;
                        let bytes = &xml[start..r.buffer_position() as usize];
                        let (rpr, change) = split_rpr_change(bytes);
                        if let Some(run) = run.as_mut() {
                            run.rpr = Some(rpr);
                            run.rpr_change = change;
                        }
                        continue;
                    }
                    (b"t" | b"delText", true) => in_text = true,
                    (other, _) => {
                        return Err(format!(
                            "it holds a <{}> this writer does not write",
                            String::from_utf8_lossy(other)
                        ))
                    }
                }
                depth += 1;
            }
            Event::Empty(e) => {
                let name = e.name().as_ref().to_vec();
                let ln = local(&name).to_vec();
                match (ln.as_slice(), run.as_mut()) {
                    (b"bookmarkStart" | b"bookmarkEnd", None) => {
                        out.bookmarks.push((chars, xml[start..end].to_vec()));
                    }
                    (
                        b"commentRangeStart" | b"commentRangeEnd" | b"proofErr" | b"permStart"
                        | b"permEnd",
                        None,
                    ) => {}
                    (b"pPr", None) => out.ppr = Some(xml[start..end].to_vec()),
                    (b"r", None) => {}
                    (b"tab" | b"cr" | b"noBreakHyphen" | b"softHyphen", Some(run)) => {
                        run.chars += 1;
                        chars += 1;
                    }
                    (b"br", Some(run)) => {
                        let page = e.attributes().flatten().any(|a| {
                            local(a.key.as_ref()) == b"type"
                                && matches!(a.value.as_ref(), b"page" | b"column")
                        });
                        if page {
                            return Err("it holds a page or column break".into());
                        }
                        run.chars += 1;
                        chars += 1;
                    }
                    (
                        b"rPr"
                        | b"lastRenderedPageBreak"
                        | b"commentReference"
                        | b"annotationRef"
                        | b"t"
                        | b"delText",
                        Some(_),
                    ) => {}
                    (other, _) => {
                        return Err(format!(
                            "it holds a <{}> this writer does not write",
                            String::from_utf8_lossy(other)
                        ))
                    }
                }
            }
            Event::Text(t) if in_text => {
                let s = t.decode().map_err(|e| e.to_string())?;
                let n = s.chars().count() as u32;
                if let Some(run) = run.as_mut() {
                    run.chars += n;
                }
                chars += n;
            }
            Event::GeneralRef(_) if in_text => {
                if let Some(run) = run.as_mut() {
                    run.chars += 1;
                }
                chars += 1;
            }
            Event::End(e) => {
                let ln = local(e.name().as_ref()).to_vec();
                match ln.as_slice() {
                    b"t" | b"delText" => in_text = false,
                    b"r" => {
                        if let Some(done) = run.take() {
                            if done.chars > 0 {
                                out.runs.push(done);
                            }
                        }
                    }
                    _ => {}
                }
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    return Ok(out);
                }
            }
            Event::Eof => return Ok(out),
            _ => {}
        }
    }
}

/// A `<w:rPr>` without its `w:rPrChange`, and that element.
fn split_rpr_change(rpr: &[u8]) -> (Vec<u8>, Option<Vec<u8>>) {
    let Ok((kids, _)) = root_children(rpr) else {
        return (rpr.to_vec(), None);
    };
    let Some(c) = kids.iter().find(|k| k.local == "rPrChange") else {
        return (rpr.to_vec(), None);
    };
    let mut out = rpr[..c.start].to_vec();
    out.extend_from_slice(&rpr[c.end..]);
    (out, Some(rpr[c.start..c.end].to_vec()))
}

// ---------------------------------------------------------------------------
// Writing

fn esc(s: &str) -> String {
    paged_ooxml::xml::escape_attr(s)
}

fn esc_text(s: &str) -> String {
    paged_ooxml::xml::escape_text(s)
}

/// `w:id="…" w:author="…" w:date="…"` of a change written as Word's.
fn change_attrs(id: i64, c: &LoweredChange) -> String {
    let mut s = format!(
        " w:id=\"{id}\" w:author=\"{}\"",
        esc(c.author.as_deref().unwrap_or("Unknown"))
    );
    if let Some(d) = &c.date {
        s.push_str(&format!(" w:date=\"{}\"", esc(d)));
    }
    s
}

/// A run's text as WordprocessingML: tabs, breaks and hyphens as their
/// elements, the rest in `w:t` (`w:delText` for a deleted run).
fn render_text(text: &str, deleted: bool) -> String {
    let tag = if deleted { "w:delText" } else { "w:t" };
    let mut out = String::new();
    let mut buf = String::new();
    let flush = |out: &mut String, buf: &mut String| {
        if !buf.is_empty() {
            out.push_str(&format!(
                "<{tag} xml:space=\"preserve\">{}</{tag}>",
                esc_text(buf)
            ));
            buf.clear();
        }
    };
    for ch in text.chars() {
        let el = match ch {
            '\t' => Some("<w:tab/>"),
            '\u{2028}' => Some("<w:br/>"),
            '\u{2011}' => Some("<w:noBreakHyphen/>"),
            '\u{00AD}' => Some("<w:softHyphen/>"),
            _ => None,
        };
        match el {
            Some(e) => {
                flush(&mut out, &mut buf);
                out.push_str(e);
            }
            None => buf.push(ch),
        }
    }
    flush(&mut out, &mut buf);
    out
}

/// `rpr` with `change` (a `w:rPrChange` element) as its last child.
fn with_rpr_change(rpr: Option<Vec<u8>>, change: &str) -> Vec<u8> {
    match rpr {
        None => format!("<w:rPr>{change}</w:rPr>").into_bytes(),
        Some(r) if r.ends_with(b"/>") => {
            let s = String::from_utf8_lossy(&r);
            let open = s.trim_end_matches("/>").trim_end();
            let name = open
                .trim_start_matches('<')
                .split_whitespace()
                .next()
                .unwrap_or("w:rPr");
            format!("{open}>{change}</{name}>").into_bytes()
        }
        Some(r) => {
            let at = r.iter().rposition(|b| *b == b'<').unwrap_or(r.len());
            let mut out = r[..at].to_vec();
            out.extend_from_slice(change.as_bytes());
            out.extend_from_slice(&r[at..]);
            out
        }
    }
}

/// A `w:pPr` with its review markup set: the mark's insertion or deletion
/// (`mark`), the property change (`props`, a whole `w:pPrChange`), and
/// without its `w:sectPr` unless `keep_sect`.
fn ppr_with_review(
    ppr: Option<&[u8]>,
    mark: Option<String>,
    props: Option<String>,
    keep_sect: bool,
) -> Option<Vec<u8>> {
    let mut kids: Vec<(String, Vec<u8>)> = Vec::new();
    let mut open = b"<w:pPr>".to_vec();
    let mut close = b"</w:pPr>".to_vec();
    if let Some(src) = ppr {
        if let Ok((spans, _)) = root_children(src) {
            if let Some(first) = spans.first() {
                // The start tag is everything before the first child.
                open = src[..first.start].to_vec();
                let last = spans.last().map_or(first.end, |s| s.end);
                close = src[last..].to_vec();
            } else if !src.ends_with(b"/>") {
                let at = src.iter().position(|b| *b == b'>').map_or(0, |i| i + 1);
                open = src[..at].to_vec();
                close = src[at..].to_vec();
            }
            for s in &spans {
                kids.push((s.local.clone(), src[s.start..s.end].to_vec()));
            }
        }
    }
    kids.retain(|(n, _)| n != "pPrChange" && (keep_sect || n != "sectPr"));
    // The mark's own change, in `w:rPr`.
    for (n, bytes) in kids.iter_mut() {
        if n == "rPr" {
            *bytes = rpr_without_mark(bytes);
        }
    }
    if let Some(m) = mark {
        match kids.iter_mut().find(|(n, _)| n == "rPr") {
            Some((_, bytes)) => {
                let s = String::from_utf8_lossy(bytes).into_owned();
                let s = if s.ends_with("/>") {
                    format!("<w:rPr>{m}</w:rPr>")
                } else {
                    let at = s.find('>').map_or(0, |i| i + 1);
                    format!("{}{m}{}", &s[..at], &s[at..])
                };
                *bytes = s.into_bytes();
            }
            None => {
                let at = kids
                    .iter()
                    .position(|(n, _)| n == "sectPr")
                    .unwrap_or(kids.len());
                kids.insert(
                    at,
                    ("rPr".into(), format!("<w:rPr>{m}</w:rPr>").into_bytes()),
                );
            }
        }
    }
    if let Some(p) = props {
        kids.push(("pPrChange".into(), p.into_bytes()));
    }
    if kids.is_empty() {
        return None;
    }
    let mut out = open;
    for (_, b) in kids {
        out.extend_from_slice(&b);
    }
    out.extend_from_slice(&close);
    Some(out)
}

/// A paragraph mark's `w:rPr` without its `w:ins` / `w:del`.
fn rpr_without_mark(rpr: &[u8]) -> Vec<u8> {
    let Ok((spans, _)) = root_children(rpr) else {
        return rpr.to_vec();
    };
    let mut out = Vec::new();
    let mut at = 0usize;
    for s in spans
        .iter()
        .filter(|s| matches!(s.local.as_str(), "ins" | "del"))
    {
        out.extend_from_slice(&rpr[at..s.start]);
        at = s.end;
    }
    out.extend_from_slice(&rpr[at..]);
    out
}

/// The `w:pPr` children that are paragraph properties (what a
/// `w:pPrChange` records).
fn ppr_props_inner(ppr: Option<&[u8]>) -> String {
    let Some(src) = ppr else {
        return String::new();
    };
    let Ok((spans, _)) = root_children(src) else {
        return String::new();
    };
    spans
        .iter()
        .filter(|s| !matches!(s.local.as_str(), "rPr" | "sectPr" | "pPrChange"))
        .map(|s| String::from_utf8_lossy(&src[s.start..s.end]).into_owned())
        .collect()
}

/// The `w:pPrChange` element of a source `w:pPr`, as written.
fn source_ppr_change(ppr: Option<&[u8]>) -> Option<Vec<u8>> {
    let src = ppr?;
    let (spans, _) = root_children(src).ok()?;
    spans
        .iter()
        .find(|s| s.local == "pPrChange")
        .map(|s| src[s.start..s.end].to_vec())
}

/// The highest `w:id` of the revision elements in `xml`.
fn max_revision_id(xml: &[u8]) -> i64 {
    const REVISIONS: [&[u8]; 10] = [
        b"ins",
        b"del",
        b"moveFrom",
        b"moveTo",
        b"rPrChange",
        b"pPrChange",
        b"sectPrChange",
        b"tblPrChange",
        b"trPrChange",
        b"tcPrChange",
    ];
    let mut r = Reader::from_reader(xml);
    let mut best = 0i64;
    loop {
        match r.read_event() {
            Ok(Event::Start(e)) | Ok(Event::Empty(e)) => {
                if REVISIONS.contains(&local(e.name().as_ref())) {
                    if let Some(id) = e
                        .attributes()
                        .flatten()
                        .find(|a| local(a.key.as_ref()) == b"id")
                        .and_then(|a| String::from_utf8_lossy(&a.value).trim().parse::<i64>().ok())
                    {
                        best = best.max(id);
                    }
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    best
}

/// Engine comment ids and the `w:id`s they are written with: a comment
/// read from Word keeps its id, one made in paged takes the next free.
#[derive(Debug, Clone, Default)]
pub struct WordCommentIds {
    map: BTreeMap<String, i64>,
}

impl WordCommentIds {
    fn of(comments: &[CommentContentIn], taken: &BTreeSet<i64>) -> Self {
        let mut used = taken.clone();
        let mut map = BTreeMap::new();
        for c in comments {
            if let Some(n) = docx_core::review::comment_word_id(&c.id) {
                map.insert(c.id.clone(), n);
                used.insert(n);
            }
        }
        let mut next = used.iter().max().copied().unwrap_or(-1) + 1;
        for c in comments {
            if !map.contains_key(&c.id) {
                map.insert(c.id.clone(), next);
                next += 1;
            }
        }
        WordCommentIds { map }
    }

    fn get(&self, id: &str) -> Option<i64> {
        self.map.get(id).copied()
    }
}

/// The body's `<w:p>` children, in order.
fn body_paragraphs(xml: &[u8]) -> Vec<Span> {
    let Ok((roots, _)) = root_children(xml) else {
        return Vec::new();
    };
    let Some(body) = roots.iter().find(|s| s.local == "body") else {
        return Vec::new();
    };
    let Ok((kids, _)) = paged_ooxml::splice::children_of(xml, body) else {
        return Vec::new();
    };
    kids.into_iter().filter(|s| s.local == "p").collect()
}

/// Where each comment's range starts and ends among the edited body's
/// runs: `(block, run)` of its first and last run.
type Bounds = BTreeMap<String, ((usize, usize), (usize, usize))>;

fn comment_bounds(edited: &LoweredDoc) -> Bounds {
    let mut out: Bounds = BTreeMap::new();
    for (b, block) in edited.story.blocks.iter().enumerate() {
        let LoweredBlock::Paragraph(p) = block else {
            continue;
        };
        for (k, r) in p.runs.iter().enumerate() {
            if r.text.is_empty() {
                continue;
            }
            for id in &r.comments {
                out.entry(id.clone())
                    .and_modify(|e| e.1 = (b, k))
                    .or_insert(((b, k), (b, k)));
            }
        }
    }
    out
}

/// What one save of the review markup did.
#[derive(Debug, Clone, Default)]
pub struct ReviewSave {
    pub skips: Vec<String>,
    /// The comment ids written into the body, by engine id.
    pub comment_ids: WordCommentIds,
}

/// Write the dirty paragraphs into the main part (before the run patcher
/// runs), marking the paragraphs a join removes.
#[allow(clippy::too_many_arguments)]
pub fn write_paragraphs(
    pkg: &mut OpcPackage,
    main_part: &str,
    base: &LoweredDoc,
    edited: &LoweredDoc,
    bindings: &DocxBindings,
    dirty: &BTreeSet<usize>,
    plan: &ReviewPlan,
    para_edits: &[ParaEdit],
    source_comment_ids: &BTreeSet<i64>,
) -> Result<ReviewSave, OoxmlError> {
    let mut save = ReviewSave {
        comment_ids: WordCommentIds::of(&plan.comments, source_comment_ids),
        ..ReviewSave::default()
    };
    if dirty.is_empty() {
        return Ok(save);
    }
    let src = pkg.require(main_part)?.to_vec();
    let paras = body_paragraphs(&src);
    let mut next_rev = max_revision_id(&src) + 1;
    let bounds = comment_bounds(edited);
    let mut threads: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    for c in &plan.comments {
        match &c.parent_id {
            None => threads
                .entry(c.id.as_str())
                .or_default()
                .insert(0, c.id.as_str()),
            Some(p) => threads.entry(p.as_str()).or_default().push(c.id.as_str()),
        }
    }
    // (start, end, replacement) over the source part.
    let mut cuts: Vec<(usize, usize, Vec<u8>)> = Vec::new();
    for &b in dirty {
        let (Some(LoweredBlock::Paragraph(bp)), Some(LoweredBlock::Paragraph(ep))) =
            (base.story.blocks.get(b), edited.story.blocks.get(b))
        else {
            continue;
        };
        let label = |why: &str| format!("tracked changes not saved: block {b} {why}");
        let Some(q) = bindings.para_ord(b) else {
            save.skips
                .push(label("is not a body paragraph the patcher reaches"));
            continue;
        };
        let Some(span) = paras.get(q as usize) else {
            save.skips.push(label("is not in the document part"));
            continue;
        };
        let source = match read_paragraph(&src[span.start..span.end]) {
            Ok(s) => s,
            Err(why) => {
                save.skips.push(label(&why));
                continue;
            }
        };
        if bp
            .runs
            .iter()
            .chain(ep.runs.iter())
            .any(|r| r.field.is_some() || r.note.is_some() || r.hyperlink_url.is_some())
            || !bp.images.is_empty()
        {
            save.skips
                .push(label("holds a field, a note, a link or a picture"));
            continue;
        }
        // The joined paragraphs.
        let absorbed: Vec<(usize, Span, SrcPara)> = match plan.merged.get(&b) {
            Some(tail) => {
                let mut v = Vec::new();
                for &t in tail {
                    let sp = bindings
                        .para_ord(t)
                        .and_then(|q| paras.get(q as usize))
                        .cloned();
                    let Some(sp) = sp else {
                        break;
                    };
                    match read_paragraph(&src[sp.start..sp.end]) {
                        Ok(s) => v.push((t, sp, s)),
                        Err(_) => break,
                    }
                }
                if v.len() != tail.len() {
                    save.skips
                        .push(label("is joined to a paragraph this writer does not write"));
                    continue;
                }
                v
            }
            None => Vec::new(),
        };
        // The pPr: the differ's paragraph edit merged in.
        let mut ppr = source.ppr.clone();
        // A join keeps the last joined paragraph's when it carries the
        // section or the style read back.
        if let Some((t, _, last)) = absorbed.last() {
            let style_of = |blk: usize| match &base.story.blocks[blk] {
                LoweredBlock::Paragraph(p) => p.para_style_id.clone(),
                LoweredBlock::Table(_) => None,
            };
            let sect = last
                .ppr
                .as_deref()
                .is_some_and(|p| String::from_utf8_lossy(p).contains("sectPr"));
            if sect || (ep.para_style_id == style_of(*t) && ep.para_style_id != bp.para_style_id) {
                ppr = last.ppr.clone();
            }
        }
        if let Some(pe) = para_edits.iter().find(|p| p.block == b) {
            let pstyle = pe.pstyle.as_ref().and_then(|o| o.as_deref());
            ppr = Some(rpr::merge_ppr(
                ppr.as_deref(),
                &rpr::render_ppr(&pe.new_props, pstyle),
            ));
        }
        let mut fresh = || {
            next_rev += 1;
            next_rev - 1
        };
        let mark_el = |c: &LoweredChange, id: i64| {
            let el = if is_insert(&c.kind) { "w:ins" } else { "w:del" };
            format!("<{el}{}/>", change_attrs(id, c))
        };
        let props_el = |id: i64| -> Option<String> {
            let c = ep.props_change.as_ref()?;
            let kept = bp
                .props_change
                .as_ref()
                .is_some_and(|x| x.change.id == c.change.id);
            if kept {
                if let Some(bytes) = source_ppr_change(source.ppr.as_deref()) {
                    return Some(String::from_utf8_lossy(&bytes).into_owned());
                }
            }
            // Recorded in paged: what the paragraph had before is what the
            // source paragraph has.
            Some(format!(
                "<w:pPrChange{}><w:pPr>{}</w:pPr></w:pPrChange>",
                change_attrs(id, &c.change),
                ppr_props_inner(source.ppr.as_deref())
            ))
        };
        let props_id = fresh();
        let mark_id = fresh();
        let final_ppr = ppr_with_review(
            ppr.as_deref(),
            ep.mark_change.as_ref().map(|c| mark_el(c, mark_id)),
            props_el(props_id),
            true,
        );

        // Map the edited runs onto the Word runs their text came from (a
        // join's: every joined paragraph's).
        let mut base_runs: Vec<&LoweredRun> = bp.runs.iter().collect();
        let mut src_runs: Vec<SrcRun> = source.runs.clone();
        for (t, _, s) in &absorbed {
            if let Some(LoweredBlock::Paragraph(p)) = base.story.blocks.get(*t) {
                base_runs.extend(p.runs.iter());
            }
            src_runs.extend(s.runs.iter().cloned());
        }
        let reuse = src_runs.len() == base_runs.len()
            && src_runs
                .iter()
                .zip(&base_runs)
                .all(|(s, r)| s.chars as usize == r.text.chars().count());
        let base_chars: Vec<char> = base_runs.iter().flat_map(|r| r.text.chars()).collect();
        let edited_chars: Vec<char> = ep.runs.iter().flat_map(|r| r.text.chars()).collect();
        let mut base_run_of: Vec<usize> = Vec::with_capacity(base_chars.len());
        for (k, r) in base_runs.iter().enumerate() {
            base_run_of.extend(std::iter::repeat_n(k, r.text.chars().count()));
        }
        let mut matched: Vec<Option<usize>> = vec![None; edited_chars.len()];
        for step in align_chars(&base_chars, &edited_chars) {
            if let Align::Match(i, e) = step {
                matched[e] = Some(i);
            }
        }
        // A base char offset as an edited one (bookmarks).
        let edited_offset = |at: u32| -> usize {
            matched
                .iter()
                .position(|m| m.is_some_and(|i| i >= at as usize))
                .unwrap_or(edited_chars.len())
        };
        let para_b = bp.para_style_id.as_deref();
        let para_e = ep.para_style_id.as_deref();
        let look = |r: &LoweredRun, para: Option<&str>, doc: &LoweredDoc| {
            let (props, rstyle) = effective_props(r.char_style_id.as_deref(), para, doc, bindings);
            RunFormat { props, rstyle }
        };
        let mut body = String::new();
        let mut open: Option<(String, String)> = None; // (id, kind) of the open wrapper
        let close = |body: &mut String, open: &mut Option<(String, String)>| {
            if let Some((_, kind)) = open.take() {
                body.push_str(if is_insert(&kind) {
                    "</w:ins>"
                } else {
                    "</w:del>"
                });
            }
        };
        let mut pos = 0usize; // edited char offset
        let mut last_k: Option<usize> = None;
        let cuts_here: Vec<(usize, LoweredChange)> =
            plan.splits.get(&b).cloned().unwrap_or_default();
        let mut bookmarks: Vec<(usize, Vec<u8>)> = source
            .bookmarks
            .iter()
            .map(|(at, bytes)| (edited_offset(*at), bytes.clone()))
            .collect();
        for (_, _, a) in &absorbed {
            for (_, bytes) in &a.bookmarks {
                bookmarks.push((edited_chars.len(), bytes.clone()));
            }
        }
        let mut next_bookmark = 0usize;
        bookmarks.sort_by_key(|(at, _)| *at);
        // Each paragraph piece's pPr: a piece a tracked Enter ended carries
        // the inserted mark (and no section); the last one is the Word
        // paragraph's own.
        let mut piece_pprs: Vec<Option<Vec<u8>>> = cuts_here
            .iter()
            .filter(|(at, _)| *at > 0)
            .map(|(_, mark)| {
                ppr_with_review(
                    source.ppr.as_deref(),
                    Some(mark_el(mark, fresh())),
                    None,
                    false,
                )
            })
            .collect();
        piece_pprs.push(final_ppr.clone());
        let mut piece = 0usize;
        let comment_id = |id: &str| save.comment_ids.get(id);
        for (j, run) in ep.runs.iter().enumerate() {
            // A tracked paragraph mark inserted in paged ends a paragraph here.
            if cuts_here.iter().any(|(at, _)| *at == j && j > 0) {
                close(&mut body, &mut open);
                piece += 1;
                body.push_str("</w:p><w:p>");
                if let Some(p) = piece_pprs.get(piece).cloned().flatten() {
                    body.push_str(&String::from_utf8_lossy(&p));
                }
            }
            let n = run.text.chars().count();
            while next_bookmark < bookmarks.len() && bookmarks[next_bookmark].0 <= pos {
                close(&mut body, &mut open);
                body.push_str(&String::from_utf8_lossy(&bookmarks[next_bookmark].1));
                next_bookmark += 1;
            }
            if n == 0 {
                continue;
            }
            // Comment ranges starting here.
            for (id, ((sb, sk), _)) in &bounds {
                if (*sb, *sk) == (b, j) {
                    close(&mut body, &mut open);
                    for m in threads
                        .get(id.as_str())
                        .cloned()
                        .unwrap_or_else(|| vec![id.as_str()])
                    {
                        if let Some(w) = comment_id(m) {
                            body.push_str(&format!("<w:commentRangeStart w:id=\"{w}\"/>"));
                        }
                    }
                }
            }
            // The Word run this one's text came from.
            let k = matched[pos..pos + n]
                .iter()
                .find_map(|m| m.map(|i| base_run_of[i]))
                .or(last_k);
            last_k = k;
            let mine = look(run, para_e, edited);
            let rpr: Option<Vec<u8>> = match (reuse, k) {
                (true, Some(k)) => {
                    let own = look(base_runs[k], para_b, base);
                    let src_rpr = src_runs[k].rpr.clone();
                    if own == mine {
                        src_rpr
                    } else {
                        rpr::merge_rpr(src_rpr.as_deref(), &own, &mine).or(src_rpr)
                    }
                }
                _ => (mine.props != docx_core::RunProps::default() || mine.rstyle.is_some())
                    .then(|| rpr::render_rpr(&mine.props, mine.rstyle.as_deref())),
            };
            let rpr = match &run.format_change {
                Some(fc) => {
                    let kept = reuse
                        && k.is_some_and(|k| {
                            base_runs[k]
                                .format_change
                                .as_ref()
                                .is_some_and(|x| x.change.id == fc.change.id)
                                && src_runs[k].rpr_change.is_some()
                        });
                    let el = if kept {
                        String::from_utf8_lossy(
                            src_runs[k.unwrap_or(0)]
                                .rpr_change
                                .as_deref()
                                .unwrap_or_default(),
                        )
                        .into_owned()
                    } else {
                        let (p, rs) = effective_props(
                            fc.before_char_style_id.as_deref(),
                            para_e,
                            edited,
                            bindings,
                        );
                        let old = if p == docx_core::RunProps::default() && rs.is_none() {
                            "<w:rPr/>".to_string()
                        } else {
                            String::from_utf8_lossy(&rpr::render_rpr(&p, rs.as_deref()))
                                .into_owned()
                        };
                        format!(
                            "<w:rPrChange{}>{old}</w:rPrChange>",
                            change_attrs(fresh(), &fc.change)
                        )
                    };
                    Some(with_rpr_change(rpr, &el))
                }
                None => rpr,
            };
            // The wrapper its change puts it in.
            let want = run.change.as_ref().map(|c| (c.id.clone(), c.kind.clone()));
            if open != want {
                close(&mut body, &mut open);
                if let Some(c) = &run.change {
                    let el = if is_insert(&c.kind) { "w:ins" } else { "w:del" };
                    body.push_str(&format!("<{el}{}>", change_attrs(fresh(), c)));
                    open = want;
                }
            }
            let deleted = run.change.as_ref().is_some_and(|c| !is_insert(&c.kind));
            body.push_str("<w:r>");
            if let Some(r) = rpr {
                body.push_str(&String::from_utf8_lossy(&r));
            }
            body.push_str(&render_text(&run.text, deleted));
            body.push_str("</w:r>");
            pos += n;
            // Comment ranges ending here, then their references.
            for (id, (_, (eb, ek))) in &bounds {
                if (*eb, *ek) == (b, j) {
                    close(&mut body, &mut open);
                    let members = threads
                        .get(id.as_str())
                        .cloned()
                        .unwrap_or_else(|| vec![id.as_str()]);
                    for m in &members {
                        if let Some(w) = comment_id(m) {
                            body.push_str(&format!("<w:commentRangeEnd w:id=\"{w}\"/>"));
                        }
                    }
                    for m in &members {
                        if let Some(w) = comment_id(m) {
                            body.push_str(&format!(
                                "<w:r><w:commentReference w:id=\"{w}\"/></w:r>"
                            ));
                        }
                    }
                }
            }
        }
        close(&mut body, &mut open);
        for (_, bytes) in &bookmarks[next_bookmark..] {
            body.push_str(&String::from_utf8_lossy(bytes));
        }
        let mut out = source.start_tag.clone();
        if let Some(p) = piece_pprs.first().cloned().flatten() {
            out.extend_from_slice(&p);
        }
        out.extend_from_slice(body.as_bytes());
        out.extend_from_slice(b"</w:p>");
        cuts.push((span.start, span.end, out));
        for (_, sp, s) in &absorbed {
            // Marked for removal once the run patcher is done.
            let mut tag = s.start_tag.clone();
            let at = tag.len() - 1;
            tag.splice(at..at, MERGED_MARK.bytes());
            cuts.push((
                sp.start,
                sp.start + s.start_tag.len().min(sp.end - sp.start),
                tag,
            ));
        }
    }
    cuts.sort_by_key(|(s, _, _)| *s);
    let mut out = Vec::with_capacity(src.len());
    let mut at = 0usize;
    for (s, e, bytes) in cuts {
        if s < at {
            continue;
        }
        out.extend_from_slice(&src[at..s]);
        out.extend_from_slice(&bytes);
        at = e;
    }
    out.extend_from_slice(&src[at..]);
    if out != src {
        pkg.set_part(main_part, out);
    }
    Ok(save)
}

/// Remove the paragraphs a join took into the one before (after the run
/// patcher, which addressed them by their ordinals).
pub fn remove_joined(pkg: &mut OpcPackage, main_part: &str) -> Result<(), OoxmlError> {
    let src = pkg.require(main_part)?;
    let marker = MERGED_MARK.trim().as_bytes();
    if !src.windows(marker.len()).any(|w| w == marker) {
        return Ok(());
    }
    let src = src.to_vec();
    let mut r = Reader::from_reader(src.as_slice());
    r.config_mut().trim_text(false);
    let mut cut: Vec<(usize, usize)> = Vec::new();
    loop {
        let start = r.buffer_position() as usize;
        match r.read_event() {
            Ok(Event::Start(e)) => {
                let end = r.buffer_position() as usize;
                let tag = &src[start..end];
                if local(e.name().as_ref()) == b"p"
                    && tag.windows(marker.len()).any(|w| w == marker)
                {
                    let name = e.name().as_ref().to_vec();
                    if r.read_to_end(quick_xml::name::QName(&name)).is_ok() {
                        cut.push((start, r.buffer_position() as usize));
                    }
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    let mut out = Vec::with_capacity(src.len());
    let mut at = 0usize;
    for (s, e) in cut {
        out.extend_from_slice(&src[at..s]);
        at = e;
    }
    out.extend_from_slice(&src[at..]);
    pkg.set_part(main_part, out);
    Ok(())
}

// ---------------------------------------------------------------------------
// The comment parts

const W_NS: &str = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const W14_NS: &str = "http://schemas.microsoft.com/office/word/2010/wordml";
const W15_NS: &str = "http://schemas.microsoft.com/office/word/2012/wordml";
const W16CID_NS: &str = "http://schemas.microsoft.com/office/word/2016/wordml/cid";
const REL_COMMENTS: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments";
const REL_EXTENDED: &str =
    "http://schemas.microsoft.com/office/2011/relationships/commentsExtended";
const REL_IDS: &str = "http://schemas.microsoft.com/office/2016/09/relationships/commentsIds";
const CT_PREFIX: &str = "application/vnd.openxmlformats-officedocument.wordprocessingml.";

/// The comment ids referenced in `xml` (`w:commentReference`,
/// `w:commentRangeStart`).
fn referenced_comments(xml: &[u8]) -> BTreeSet<i64> {
    let mut r = Reader::from_reader(xml);
    let mut out = BTreeSet::new();
    loop {
        match r.read_event() {
            Ok(Event::Start(e)) | Ok(Event::Empty(e)) => {
                if matches!(
                    local(e.name().as_ref()),
                    b"commentReference" | b"commentRangeStart"
                ) {
                    if let Some(id) = e
                        .attributes()
                        .flatten()
                        .find(|a| local(a.key.as_ref()) == b"id")
                        .and_then(|a| String::from_utf8_lossy(&a.value).trim().parse::<i64>().ok())
                    {
                        out.insert(id);
                    }
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    out
}

/// Make a part with its relationship from the main part and its content
/// type, when it is not there; its name either way.
fn ensure_part(
    pkg: &mut OpcPackage,
    main_part: &str,
    existing: Option<String>,
    file: &str,
    rel_type: &str,
    content_type: &str,
    empty: String,
) -> String {
    if let Some(name) = existing {
        return name;
    }
    let dir = paged_ooxml::rels::part_dir(main_part);
    let name = if dir.is_empty() {
        file.to_string()
    } else {
        format!("{}/{file}", dir.trim_end_matches('/'))
    };
    pkg.set_part(&name, empty.into_bytes());
    let rels_name = paged_ooxml::rels::rels_part_name(main_part);
    let rels = pkg
        .part(&rels_name)
        .map(|b| String::from_utf8_lossy(b).into_owned())
        .unwrap_or_else(|| {
            "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\r\n<Relationships \
             xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"></Relationships>"
                .into()
        });
    let mut n = 1;
    while rels.contains(&format!("Id=\"rId{n}\"")) {
        n += 1;
    }
    let rel = format!("<Relationship Id=\"rId{n}\" Type=\"{rel_type}\" Target=\"{file}\"/>");
    if let Some(i) = rels.rfind("</Relationships>") {
        let mut r = rels.clone();
        r.insert_str(i, &rel);
        pkg.set_part(&rels_name, r.into_bytes());
    }
    if let Some(types) = pkg.part("[Content_Types].xml") {
        let mut t = String::from_utf8_lossy(types).into_owned();
        if !t.contains(&format!("PartName=\"/{name}\"")) {
            if let Some(i) = t.rfind("</Types>") {
                t.insert_str(
                    i,
                    &format!("<Override PartName=\"/{name}\" ContentType=\"{content_type}\"/>"),
                );
                pkg.set_part("[Content_Types].xml", t.into_bytes());
            }
        }
    }
    name
}

/// `xml` (a part) with `prefix` declared on its root, when it is not.
fn declare(xml: &str, prefix: &str, uri: &str) -> String {
    let decl = format!("xmlns:{prefix}=");
    let Some(root) = xml
        .char_indices()
        .filter(|(_, c)| *c == '<')
        .map(|(i, _)| i)
        .find(|&i| !xml[i..].starts_with("<?") && !xml[i..].starts_with("<!"))
    else {
        return xml.to_string();
    };
    let end = xml[root..].find('>').map_or(xml.len(), |e| root + e);
    if xml[root..end].contains(&decl) {
        return xml.to_string();
    }
    let at = if xml[..end].ends_with('/') {
        end - 1
    } else {
        end
    };
    format!("{} xmlns:{prefix}=\"{uri}\"{}", &xml[..at], &xml[at..])
}

/// A `w14:paraId` not used in `taken`.
fn fresh_para_id(seed: u64, taken: &mut BTreeSet<String>) -> String {
    let mut x = seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ 0x1234_5678;
    loop {
        let id = format!("{:08X}", (x as u32) & 0x7FFF_FFFE | 1);
        if taken.insert(id.clone()) {
            return id;
        }
        x = x.wrapping_add(0x6C8E_9CF5);
    }
}

/// One comment as Word writes it, its last paragraph `para_id`.
fn render_comment(c: &CommentContentIn, wid: i64, para_ids: &[String]) -> String {
    let mut s = format!("<w:comment w:id=\"{wid}\"");
    s.push_str(&format!(
        " w:author=\"{}\"",
        esc(c.author.as_deref().unwrap_or("Unknown"))
    ));
    if let Some(d) = &c.date {
        s.push_str(&format!(" w:date=\"{}\"", esc(d)));
    }
    if let Some(i) = &c.initials {
        s.push_str(&format!(" w:initials=\"{}\"", esc(i)));
    }
    s.push('>');
    let lines: Vec<&str> = c.text.split('\n').collect();
    for (k, line) in lines.iter().enumerate() {
        let pid = para_ids.get(k).cloned().unwrap_or_default();
        s.push_str(&format!(
            "<w:p w14:paraId=\"{pid}\" w14:textId=\"77777777\">"
        ));
        if k == 0 {
            s.push_str("<w:r><w:annotationRef/></w:r>");
        }
        if !line.is_empty() {
            s.push_str(&format!("<w:r>{}</w:r>", render_text(line, false)));
        }
        s.push_str("</w:p>");
    }
    s.push_str("</w:comment>");
    s
}

/// The root's children of a part by local name, with their bytes.
fn elements(xml: &[u8], name: &str) -> Vec<(Span, Vec<(String, String)>)> {
    let Ok((spans, _)) = root_children(xml) else {
        return Vec::new();
    };
    spans
        .into_iter()
        .filter(|s| s.local == name)
        .map(|s| {
            let attrs = paged_ooxml::splice::attrs_of(xml, &s).unwrap_or_default();
            (s, attrs)
        })
        .collect()
}

/// The comment parts a document has.
struct CommentParts {
    comments: Option<String>,
    extended: Option<String>,
    ids: Option<String>,
}

/// Write the comment parts from the read-back comments (doc ADR 613).
/// `source` is the document's comments as imported; nothing is written
/// when the read-back says the same.
pub fn save_comments(
    pkg: &mut OpcPackage,
    main_part: &str,
    base: &LoweredDoc,
    source: &[docx_core::Comment],
    plan: &ReviewPlan,
    ids: &WordCommentIds,
) -> Result<Vec<String>, OoxmlError> {
    let mut skips = Vec::new();
    if !plan.active {
        return Ok(skips);
    }
    let read = &plan.comments;
    let same = read.len() == base.comments.len()
        && read.iter().all(|c| {
            base.comments.iter().any(|b| {
                b.id == c.id
                    && b.parent_id == c.parent_id
                    && b.text == c.text
                    && b.resolved == c.resolved
                    && b.author == c.author
            })
        });
    if same {
        return Ok(skips);
    }
    let part = |suffix: &str| {
        crate::structure::related_part(pkg, main_part, suffix).filter(|n| pkg.part(n).is_some())
    };
    let parts = (
        part("/comments"),
        part("/commentsExtended"),
        part("/commentsIds"),
    );
    let parts = CommentParts {
        comments: parts.0,
        extended: parts.1,
        ids: parts.2,
    };
    // What the document references now, in every part that can hold one.
    let mut referenced = referenced_comments(pkg.require(main_part)?);
    let others: Vec<String> = pkg
        .names()
        .filter(|n| {
            let f = n.rsplit('/').next().unwrap_or(n);
            n.starts_with("word/")
                && (f.starts_with("header")
                    || f.starts_with("footer")
                    || f.starts_with("footnotes")
                    || f.starts_with("endnotes"))
                && f.ends_with(".xml")
        })
        .map(str::to_string)
        .collect();
    for n in others {
        if let Some(b) = pkg.part(&n) {
            referenced.extend(referenced_comments(b));
        }
    }
    let src_comments = parts
        .comments
        .as_ref()
        .and_then(|n| pkg.part(n))
        .map(<[u8]>::to_vec);
    let src_elements = src_comments
        .as_deref()
        .map(|x| elements(x, "comment"))
        .unwrap_or_default();
    let mut taken: BTreeSet<String> = source.iter().filter_map(|c| c.para_id.clone()).collect();
    // Each comment written: (w:id, its element, its last paraId, parent paraId, done).
    struct Out {
        wid: i64,
        xml: String,
        para_id: Option<String>,
        parent: Option<i64>,
        done: bool,
        durable: Option<String>,
    }
    let mut out: Vec<Out> = Vec::new();
    let by_wid = |wid: i64| read.iter().find(|c| ids.get(&c.id) == Some(wid));
    // The source comments, in their order.
    for (span, attrs) in &src_elements {
        let Some(wid) = attrs
            .iter()
            .find(|(k, _)| k.ends_with("id"))
            .and_then(|(_, v)| v.trim().parse::<i64>().ok())
        else {
            continue;
        };
        if !referenced.contains(&wid) {
            continue;
        }
        let src_c = source.iter().find(|c| c.id == wid);
        let bytes = String::from_utf8_lossy(
            &src_comments.as_deref().unwrap_or_default()[span.start..span.end],
        )
        .into_owned();
        match by_wid(wid) {
            Some(c) if src_c.is_some_and(|s| s.text != c.text) => {
                let lines = c.text.split('\n').count();
                let mut pids: Vec<String> = (0..lines)
                    .map(|k| fresh_para_id(wid as u64 * 64 + k as u64, &mut taken))
                    .collect();
                if let Some(p) = src_c.and_then(|s| s.para_id.clone()) {
                    if let Some(last) = pids.last_mut() {
                        *last = p;
                    }
                }
                out.push(Out {
                    wid,
                    xml: render_comment(c, wid, &pids),
                    para_id: pids.last().cloned(),
                    parent: c.parent_id.as_deref().and_then(|p| ids.get(p)),
                    done: c.resolved,
                    durable: src_c.and_then(|s| s.durable_id.clone()),
                });
            }
            Some(c) => out.push(Out {
                wid,
                xml: bytes,
                para_id: src_c.and_then(|s| s.para_id.clone()),
                parent: c.parent_id.as_deref().and_then(|p| ids.get(p)),
                done: c.resolved,
                durable: src_c.and_then(|s| s.durable_id.clone()),
            }),
            // Removed in paged but still referenced (a paragraph this
            // writer refused): kept as it was.
            None => out.push(Out {
                wid,
                xml: bytes,
                para_id: src_c.and_then(|s| s.para_id.clone()),
                parent: src_c.and_then(|s| s.parent),
                done: src_c.is_some_and(|s| s.done),
                durable: src_c.and_then(|s| s.durable_id.clone()),
            }),
        }
    }
    // Comments made in paged.
    for c in read {
        let Some(wid) = ids.get(&c.id) else {
            continue;
        };
        if out.iter().any(|o| o.wid == wid) {
            continue;
        }
        if !referenced.contains(&wid) {
            skips.push(format!(
                "comment {} not saved: its range is not in a paragraph this writer wrote",
                c.id
            ));
            continue;
        }
        let lines = c.text.split('\n').count();
        let pids: Vec<String> = (0..lines)
            .map(|k| fresh_para_id(wid as u64 * 64 + k as u64 + 7, &mut taken))
            .collect();
        out.push(Out {
            wid,
            xml: render_comment(c, wid, &pids),
            para_id: pids.last().cloned(),
            parent: c.parent_id.as_deref().and_then(|p| ids.get(p)),
            done: c.resolved,
            durable: None,
        });
    }
    // A reply's thread is resolved with its first comment.
    let done_of: BTreeMap<i64, bool> = out.iter().map(|o| (o.wid, o.done)).collect();
    for o in out.iter_mut() {
        if let Some(p) = o.parent {
            o.done = done_of.get(&p).copied().unwrap_or(o.done) || o.done;
        }
    }

    // comments.xml
    let empty_comments = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\r\n<w:comments xmlns:w=\"{W_NS}\" xmlns:w14=\"{W14_NS}\"></w:comments>"
    );
    let name = ensure_part(
        pkg,
        main_part,
        parts.comments.clone(),
        "comments.xml",
        REL_COMMENTS,
        &format!("{CT_PREFIX}comments+xml"),
        empty_comments,
    );
    let xml = String::from_utf8_lossy(pkg.require(&name)?).into_owned();
    let xml = declare(&xml, "w14", W14_NS);
    let body: String = out.iter().map(|o| o.xml.as_str()).collect();
    pkg.set_part(&name, replace_root_children(&xml, &body).into_bytes());

    // commentsExtended.xml
    let pid_of: BTreeMap<i64, String> = out
        .iter()
        .filter_map(|o| o.para_id.clone().map(|p| (o.wid, p)))
        .collect();
    let empty_ext = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\r\n<w15:commentsEx xmlns:w15=\"{W15_NS}\"></w15:commentsEx>"
    );
    let ext_name = ensure_part(
        pkg,
        main_part,
        parts.extended.clone(),
        "commentsExtended.xml",
        REL_EXTENDED,
        &format!("{CT_PREFIX}commentsExtended+xml"),
        empty_ext,
    );
    let ext = String::from_utf8_lossy(pkg.require(&ext_name)?).into_owned();
    let ext = declare(&ext, "w15", W15_NS);
    let entries: String = out
        .iter()
        .filter_map(|o| {
            let pid = o.para_id.as_ref()?;
            let mut s = format!("<w15:commentEx w15:paraId=\"{pid}\"");
            if let Some(pp) = o.parent.and_then(|p| pid_of.get(&p)) {
                s.push_str(&format!(" w15:paraIdParent=\"{pp}\""));
            }
            s.push_str(&format!(" w15:done=\"{}\"/>", u8::from(o.done)));
            Some(s)
        })
        .collect();
    pkg.set_part(
        &ext_name,
        replace_root_children(&ext, &entries).into_bytes(),
    );

    // commentsIds.xml
    let empty_ids = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\r\n<w16cid:commentsIds xmlns:w16cid=\"{W16CID_NS}\"></w16cid:commentsIds>"
    );
    let ids_name = ensure_part(
        pkg,
        main_part,
        parts.ids.clone(),
        "commentsIds.xml",
        REL_IDS,
        &format!("{CT_PREFIX}commentsIds+xml"),
        empty_ids,
    );
    let idx = String::from_utf8_lossy(pkg.require(&ids_name)?).into_owned();
    let idx = declare(&idx, "w16cid", W16CID_NS);
    let id_entries: String = out
        .iter()
        .filter_map(|o| {
            let pid = o.para_id.as_ref()?;
            let durable = o.durable.clone().unwrap_or_else(|| {
                format!(
                    "{:08X}",
                    (pid.bytes()
                        .fold(0x2545_F491u32, |h, b| h.rotate_left(5) ^ b as u32))
                        & 0x7FFF_FFFE
                )
            });
            Some(format!(
                "<w16cid:commentId w16cid:paraId=\"{pid}\" w16cid:durableId=\"{durable}\"/>"
            ))
        })
        .collect();
    pkg.set_part(
        &ids_name,
        replace_root_children(&idx, &id_entries).into_bytes(),
    );
    Ok(skips)
}

/// `xml` (a part) with its root's content replaced by `inner`.
fn replace_root_children(xml: &str, inner: &str) -> String {
    let bytes = xml.as_bytes();
    let Ok((roots, _)) = root_children(bytes) else {
        return xml.to_string();
    };
    // `root_children` gives the root's children; the root is around them.
    let mut r = Reader::from_reader(bytes);
    let mut root: Option<(usize, usize, bool, String)> = None;
    loop {
        let start = r.buffer_position() as usize;
        match r.read_event() {
            Ok(Event::Start(e)) => {
                root = Some((
                    start,
                    r.buffer_position() as usize,
                    false,
                    String::from_utf8_lossy(e.name().as_ref()).into_owned(),
                ));
                break;
            }
            Ok(Event::Empty(e)) => {
                root = Some((
                    start,
                    r.buffer_position() as usize,
                    true,
                    String::from_utf8_lossy(e.name().as_ref()).into_owned(),
                ));
                break;
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    let _ = roots;
    let Some((start, tag_end, empty, name)) = root else {
        return xml.to_string();
    };
    if empty {
        let open = xml[start..tag_end].trim_end_matches("/>").trim_end();
        return format!(
            "{}{open}>{inner}</{name}>{}",
            &xml[..start],
            &xml[tag_end..]
        );
    }
    let close = format!("</{name}>");
    let end = xml.rfind(&close).unwrap_or(xml.len());
    format!("{}{inner}{}", &xml[..tag_end], &xml[end..])
}
