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

//! `diff(base, edited) -> EditSet`: the seam the live readback door will target
//! (it will re-lower the edited native model to a `LoweredDoc` and diff it against
//! the import-time baseline). Increment 1 covers STRUCTURE-PRESERVING edits (same
//! block/run counts); a count mismatch skips that block (structural insert/delete
//! is a later increment).
//!
//! Runs are compared on their RESOLVED effective formatting, not their lowered
//! style-id strings: synthesized `docx-auto-cN` ids are positional and renumber
//! between two independent lowerings, so only the inverted `RunProps`/`rStyle`
//! comparison is stable.

use std::collections::HashMap;

use docx_core::{RunProps, VertAlign};
use docx_lower::ir::{LoweredBlock, LoweredDoc, PropValue, StyleProp};
use docx_lower::twips_of_tracking;

use crate::bindings::{BlockBinding, DocxBindings};
use crate::edit::{CellRunEdit, EditSet, ParaEdit, RunEdit, RunFormat, RunPiece, StructuralEdit};

/// Diff two lowerings into the edits needed to turn `base` into `edited`.
pub fn diff(base: &LoweredDoc, edited: &LoweredDoc, bindings: &DocxBindings) -> EditSet {
    let mut runs = Vec::new();
    let mut structural: Vec<StructuralEdit> = Vec::new();
    let mut cells: Vec<CellRunEdit> = Vec::new();
    let mut paragraphs: Vec<ParaEdit> = Vec::new();

    // Increment 3d — align the story's BLOCKS by identity (an LCS), not by
    // index. A MIDDLE deletion must delete that paragraph and leave the
    // survivors' own `<w:p>` nodes intact; index-pairing would rewrite the wrong
    // node and destroy the trailing one (its `<w:pPr>`, rsids and unmodelled
    // children) — correct text, wrong source node.
    let bkeys: Vec<String> = base.story.blocks.iter().map(block_key).collect();
    let ekeys: Vec<String> = edited.story.blocks.iter().map(block_key).collect();
    let mut pairs: Vec<(usize, usize)> = Vec::new();
    let mut anchor: Option<usize> = None;
    for step in lcs_align(&bkeys, &ekeys) {
        match step {
            Align::Match(bi, ei) => {
                anchor = Some(bi);
                pairs.push((bi, ei));
            }
            Align::Del(bi) => {
                if matches!(base.story.blocks[bi], LoweredBlock::Paragraph(_)) {
                    structural.push(StructuralEdit::DeleteParagraph { block: bi });
                }
            }
            Align::Ins(ei) => {
                if let (Some(a), LoweredBlock::Paragraph(ep)) = (anchor, &edited.story.blocks[ei]) {
                    let text: String = ep.runs.iter().map(|r| r.text.as_str()).collect();
                    let (props, rstyle) = ep
                        .runs
                        .first()
                        .map(|r| {
                            effective_props(
                                r.char_style_id.as_deref(),
                                ep.para_style_id.as_deref(),
                                edited,
                                bindings,
                            )
                        })
                        .unwrap_or_default();
                    structural.push(StructuralEdit::InsertParagraph {
                        block: a,
                        text,
                        props,
                        para_style: ep.para_style_id.clone(),
                        rstyle,
                    });
                }
            }
        }
    }

    for (block_idx, edited_idx) in pairs {
        let bb = &base.story.blocks[block_idx];
        let eb = &edited.story.blocks[edited_idx];
        // Tables: row structure first, then cell content.
        if let (LoweredBlock::Table(bt), LoweredBlock::Table(et)) = (bb, eb) {
            // Increment 3e — align ROWS by identity too (the same defect the
            // block alignment fixed, one level down): a MIDDLE row deletion must
            // drop that `<w:tr>` and leave the survivors' own nodes — including
            // properties paged does not model (`w:trPr`, rsids) — intact.
            let brows = rows_of(bt);
            let erows = rows_of(et);
            let bkeys: Vec<String> = brows.iter().map(|r| row_key(bt, r)).collect();
            let ekeys: Vec<String> = erows.iter().map(|r| row_key(et, r)).collect();
            let mut row_pairs: Vec<(usize, usize)> = Vec::new();
            let mut row_anchor: Option<usize> = None;
            let row_steps = lcs_align(&bkeys, &ekeys);
            // A row added above every kept row goes before the first kept.
            let first_kept = row_steps.iter().find_map(|s| match s {
                Align::Match(b, _) => Some(*b),
                _ => None,
            });
            for step in row_steps {
                match step {
                    Align::Match(bi, ei) => {
                        row_anchor = Some(bi);
                        row_pairs.push((bi, ei));
                    }
                    Align::Del(bi) => structural.push(StructuralEdit::DeleteRow {
                        block: block_idx,
                        row: bi as u32,
                    }),
                    Align::Ins(ei) => {
                        let at = match (row_anchor, first_kept) {
                            (Some(a), _) => Some((a, false)),
                            (None, Some(f)) => Some((f, true)),
                            (None, None) => None,
                        };
                        if let Some((a, before)) = at {
                            let cells_text: Vec<String> = erows[ei]
                                .iter()
                                .map(|&ci| cell_text(&et.cells[ci]))
                                .collect();
                            structural.push(StructuralEdit::InsertRow {
                                block: block_idx,
                                after_row: a as u32,
                                cells: cells_text,
                                before,
                            });
                        }
                    }
                }
            }

            // Cell content, compared only within MATCHED row pairs so an edit
            // never lands on a row that is about to be deleted.
            for (bi, ei) in row_pairs {
                for (&bci, &eci) in brows[bi].iter().zip(&erows[ei]) {
                    let (bc, ec) = (&bt.cells[bci], &et.cells[eci]);
                    let cell_idx = bci;
                    // The cell's paragraphs, paired base → edited. Same count:
                    // index for index. A paragraph added or removed on the
                    // canvas: aligned by text, the rest structural ops.
                    let para_pairs: Vec<(usize, usize)> =
                        if bc.paragraphs.len() == ec.paragraphs.len() {
                            (0..bc.paragraphs.len()).map(|k| (k, k)).collect()
                        } else {
                            align_cell(
                                (block_idx, cell_idx),
                                (bc, ec),
                                (base, edited),
                                bindings,
                                &mut structural,
                            )
                        };
                    for (para_idx, epara_idx) in para_pairs {
                        let (bpara, epara) = (&bc.paragraphs[para_idx], &ec.paragraphs[epara_idx]);
                        if bpara.runs.is_empty() && !epara.runs.is_empty() {
                            // Text typed into an empty Word paragraph: there is
                            // no run to patch, so one is added.
                            structural.push(StructuralEdit::InsertCellRun {
                                block: block_idx,
                                cell: cell_idx,
                                para: para_idx,
                                text: para_text(epara),
                            });
                            continue;
                        }
                        // The runs, mapped character by character
                        // (`plan_runs`): an edit in place, a run emptied,
                        // or a run split where its text took another look.
                        let plans = plan_runs(
                            (&bpara.runs, bpara.para_style_id.as_deref()),
                            (&epara.runs, epara.para_style_id.as_deref()),
                            base,
                            edited,
                            bindings,
                        );
                        for (run_idx, (plan, look)) in plans.into_iter().enumerate() {
                            let at = |edit: CellRunEdit| CellRunEdit {
                                block: block_idx,
                                cell: cell_idx,
                                para: para_idx,
                                run: run_idx,
                                ..edit
                            };
                            match plan {
                                RunPlan::Keep => {}
                                // Removed, or emptied where it holds more
                                // than text, as a body run is.
                                RunPlan::Delete => cells.push(at(CellRunEdit {
                                    delete: true,
                                    ..Default::default()
                                })),
                                RunPlan::Edit { text, format } => cells.push(at(CellRunEdit {
                                    new_text: text,
                                    rstyle: format.as_ref().map(|f| f.rstyle.clone()),
                                    new_props: format.map(|f| f.props),
                                    base: Some(look),
                                    ..Default::default()
                                })),
                                RunPlan::Split(pieces) => {
                                    structural.push(StructuralEdit::SplitCellRun {
                                        block: block_idx,
                                        cell: cell_idx,
                                        para: para_idx,
                                        run: run_idx,
                                        base: look,
                                        pieces,
                                    })
                                }
                            }
                        }
                    }
                }
            }
            continue;
        }
        let (LoweredBlock::Paragraph(bp), LoweredBlock::Paragraph(ep)) = (bb, eb) else {
            continue; // a paragraph↔table swap — structural, deferred
        };
        if bp.runs.is_empty() {
            // Increment 2 — text in a paragraph that had no run: the new
            // runs are inserted at its start.
            structural.extend(align_runs(block_idx, bp, ep, edited, bindings));
        } else {
            // The runs, mapped character by character (`plan_runs`): an edit
            // in place (text, look), a run removed, or a run split where part
            // of its text took another look (a word made bold, a character
            // style applied to part of it). Runs the engine joined map back
            // onto their Word runs; untouched runs are not addressed at all.
            let plans = plan_runs(
                (&bp.runs, bp.para_style_id.as_deref()),
                (&ep.runs, ep.para_style_id.as_deref()),
                base,
                edited,
                bindings,
            );
            for (run_idx, (plan, look)) in plans.into_iter().enumerate() {
                match plan {
                    RunPlan::Keep => {}
                    RunPlan::Delete => structural.push(StructuralEdit::DeleteRun {
                        block: block_idx,
                        run: run_idx,
                    }),
                    RunPlan::Edit { text, format } => runs.push(RunEdit {
                        block: block_idx,
                        run: run_idx,
                        new_text: text,
                        rstyle: format.as_ref().map(|f| f.rstyle.clone()),
                        new_props: format.map(|f| f.props),
                        base: Some(look),
                    }),
                    RunPlan::Split(pieces) => structural.push(StructuralEdit::SplitRun {
                        block: block_idx,
                        run: run_idx,
                        base: look,
                        pieces,
                    }),
                }
            }
        }

        // Increment 3 — the paragraph's own `<w:pPr>` (style + direct formatting).
        let (mut b_props, b_style) =
            effective_para_props(bp.para_style_id.as_deref(), base, bindings);
        let (mut e_props, e_style) =
            effective_para_props(ep.para_style_id.as_deref(), edited, bindings);
        // A paragraph with an absolute-position tab lowers with the ptab's
        // position as its tab stop, not Word's own stops: where the edit
        // kept that stop, Word's stops are what goes back.
        if let Some(BlockBinding::Paragraph {
            word_tabs: Some(word_tabs),
            ..
        }) = bindings.blocks.get(block_idx)
        {
            if e_props.tabs == b_props.tabs {
                e_props.tabs = word_tabs.clone();
                b_props.tabs = word_tabs.clone();
            }
        }
        if b_props != e_props || b_style != e_style {
            paragraphs.push(ParaEdit {
                block: block_idx,
                new_props: e_props,
                pstyle: Some(e_style),
            });
        }
    }
    EditSet {
        runs,
        structural,
        cells,
        paragraphs,
    }
}

/// The effective DIRECT paragraph formatting a lowered paragraph-style token maps
/// to, plus the real `<w:pStyle>` it should carry — the paragraph twin of
/// [`effective_props`].
pub(crate) fn effective_para_props(
    token: Option<&str>,
    doc: &LoweredDoc,
    bindings: &DocxBindings,
) -> (docx_core::ParaProps, Option<String>) {
    let Some(token) = token else {
        return (docx_core::ParaProps::default(), None);
    };
    if let Some(style_id) = bindings.para_token_to_style_id.get(token) {
        return (docx_core::ParaProps::default(), Some(style_id.clone()));
    }
    if let Some(style) = doc.styles.iter().find(|s| s.id == token) {
        let props = invert_para_props(&style.props);
        let pstyle = style
            .based_on
            .as_deref()
            .and_then(|b| bindings.para_token_to_style_id.get(b).cloned());
        return (props, pstyle);
    }
    (docx_core::ParaProps::default(), None)
}

/// Invert a synthesized paragraph style's `StyleProp`s back to `ParaProps` — the
/// reverse of `docx-lower`'s `para_props` (points → twips, 20 twips per point).
pub(crate) fn invert_para_props(props: &[StyleProp]) -> docx_core::ParaProps {
    use docx_core::Justification as J;
    let tw = |pt: f32| (pt * 20.0).round() as i32;
    let mut p = docx_core::ParaProps::default();
    for sp in props {
        match (sp.path.as_str(), &sp.value) {
            ("paragraphJustification", PropValue::Text(v)) => {
                p.justification = match v.as_str() {
                    "CenterAlign" => Some(J::Center),
                    "RightAlign" => Some(J::Right),
                    "LeftJustified" => Some(J::Both),
                    "FullyJustified" => Some(J::Distribute),
                    _ => Some(J::Left),
                };
            }
            ("paragraphLeftIndent", PropValue::Length(v)) => p.left_indent = Some(tw(*v)),
            ("paragraphRightIndent", PropValue::Length(v)) => p.right_indent = Some(tw(*v)),
            ("paragraphFirstLineIndent", PropValue::Length(v)) => {
                // A NEGATIVE first-line indent is Word's hanging indent.
                if *v < 0.0 {
                    p.hanging_indent = Some(tw(-*v));
                } else {
                    p.first_line_indent = Some(tw(*v));
                }
            }
            ("paragraphSpaceBefore", PropValue::Length(v)) => p.space_before = Some(tw(*v)),
            ("paragraphSpaceAfter", PropValue::Length(v)) => p.space_after = Some(tw(*v)),
            ("paragraphKeepWithNext", PropValue::Length(v)) => p.keep_next = Some(*v > 0.0),
            ("paragraphKeepLinesTogether", PropValue::Bool(b)) => p.keep_lines = Some(*b),
            // Doc ADR 620.
            ("paragraphDirection", PropValue::Text(d)) => {
                p.bidi = match d.as_str() {
                    "rtl" => Some(true),
                    "ltr" => Some(false),
                    _ => None,
                }
            }
            // The lowering also gives a paragraph NextPage when a page break
            // ended the paragraph before it; re-emitted as pageBreakBefore
            // that lays out the same (it already opens the page).
            ("paragraphStartParagraph", PropValue::Text(v)) => match v.as_str() {
                "NextPage" => p.page_break_before = Some(true),
                "Anywhere" => p.page_break_before = Some(false),
                _ => {}
            },
            ("paragraphTabStops", PropValue::TabStops(stops)) => {
                p.tabs = stops
                    .iter()
                    .map(|t| docx_core::TabStop {
                        position: tw(t.position),
                        alignment: t.alignment.clone(),
                        leader: None,
                    })
                    .collect();
            }
            _ => {}
        }
    }
    p
}

/// A table's cell indices grouped by row, in emission order. A `rowSpan>1` cell
/// belongs to its RESTART row only (it is emitted once), matching `lower_table`.
pub(crate) fn rows_of(t: &docx_lower::ir::LoweredTable) -> Vec<Vec<usize>> {
    let mut rows: Vec<Vec<usize>> = vec![Vec::new(); t.rows as usize];
    for (i, c) in t.cells.iter().enumerate() {
        if let Some(r) = rows.get_mut(c.row as usize) {
            r.push(i);
        }
    }
    rows
}

/// A cell's full text (its paragraphs' runs concatenated).
fn cell_text(c: &docx_lower::ir::LoweredCell) -> String {
    c.paragraphs
        .iter()
        .flat_map(|p| p.runs.iter())
        .map(|r| r.text.as_str())
        .collect()
}

/// A paragraph's text (its runs concatenated).
fn para_text(p: &docx_lower::ir::LoweredParagraph) -> String {
    p.runs.iter().map(|r| r.text.as_str()).collect()
}

/// Align a cell's base paragraphs with its edited ones (a paragraph count
/// change) by [`align_cell_paragraphs`]: a removed paragraph becomes a
/// `DeleteCellParagraph`, an added one a `CloneCellParagraph` of the
/// paragraph before it (or, at the cell's start, of the one after it).
/// Answers the matched pairs, whose runs are compared as before.
fn align_cell(
    (block, cell): (usize, usize),
    (bc, ec): (&docx_lower::ir::LoweredCell, &docx_lower::ir::LoweredCell),
    (base, edited): (&LoweredDoc, &LoweredDoc),
    bindings: &DocxBindings,
    structural: &mut Vec<StructuralEdit>,
) -> Vec<(usize, usize)> {
    let old: Vec<String> = bc.paragraphs.iter().map(para_text).collect();
    let new: Vec<String> = ec.paragraphs.iter().map(para_text).collect();
    let steps = align_cell_paragraphs(&old, &new);
    let first_match = steps.iter().find_map(|s| match s {
        Align::Match(b, _) => Some(*b),
        _ => None,
    });
    let mut pairs = Vec::new();
    let mut anchor: Option<usize> = None;
    for step in steps {
        match step {
            Align::Match(b, e) => {
                anchor = Some(b);
                pairs.push((b, e));
            }
            Align::Del(b) => structural.push(StructuralEdit::DeleteCellParagraph {
                block,
                cell,
                para: b,
            }),
            Align::Ins(e) => {
                let (para, before) = match (anchor, first_match) {
                    (Some(a), _) => (a, false),
                    (None, Some(f)) => (f, true),
                    (None, None) => continue, // a cell with no paragraph
                };
                // The look of the run whose `<w:rPr>` the copy takes (the
                // neighbour's last run after it, its first before it), and
                // the new paragraph's runs relative to it.
                let neighbour = &bc.paragraphs[para];
                let source = if before {
                    neighbour.runs.first()
                } else {
                    neighbour.runs.last()
                };
                let (look, pieces) = match source {
                    Some(r) => {
                        let (props, rstyle) = effective_props(
                            r.char_style_id.as_deref(),
                            neighbour.para_style_id.as_deref(),
                            base,
                            bindings,
                        );
                        let look = RunFormat { props, rstyle };
                        let added = &ec.paragraphs[e];
                        let pieces = added
                            .runs
                            .iter()
                            .filter(|r| !r.text.is_empty())
                            .map(|r| {
                                let (props, rstyle) = effective_props(
                                    r.char_style_id.as_deref(),
                                    added.para_style_id.as_deref(),
                                    edited,
                                    bindings,
                                );
                                let own = RunFormat { props, rstyle };
                                RunPiece {
                                    text: r.text.clone(),
                                    format: (own != look).then_some(own),
                                }
                            })
                            .collect();
                        (Some(look), pieces)
                    }
                    None => (None, Vec::new()),
                };
                // A paragraph style of its own (Enter in a heading gives
                // the next style): the copy's `<w:pPr>` takes it.
                let (n_props, n_style) =
                    effective_para_props(neighbour.para_style_id.as_deref(), base, bindings);
                let (a_props, a_style) = effective_para_props(
                    ec.paragraphs[e].para_style_id.as_deref(),
                    edited,
                    bindings,
                );
                let new_ppr =
                    (n_props != a_props || n_style != a_style).then_some((a_props, a_style));
                structural.push(StructuralEdit::CloneCellParagraph {
                    block,
                    cell,
                    para,
                    before,
                    text: new[e].clone(),
                    base: look,
                    pieces,
                    new_ppr,
                });
            }
        }
    }
    pairs
}

/// The alignment of a cell's paragraphs, by text ([`lcs_align`]), with one
/// rule on top: the cell's LAST paragraph is never removed — Word requires a
/// `<w:tc>` to end in a `<w:p>`, and what follows the last paragraph (a
/// nested table, a bookmark end) is not known here. When the alignment
/// would remove it, it takes the last edited paragraph instead, and the
/// base paragraph that had matched that one (if any) is removed. The
/// overlay and the differ both align through this, so they agree.
pub(crate) fn align_cell_paragraphs(old: &[String], new: &[String]) -> Vec<Align> {
    let steps = lcs_align(old, new);
    let (n, m) = (old.len(), new.len());
    if n == 0
        || m == 0
        || !steps
            .iter()
            .any(|s| matches!(s, Align::Del(b) if *b == n - 1))
    {
        return steps;
    }
    let mut out: Vec<Align> = Vec::with_capacity(steps.len());
    for s in steps {
        match s {
            Align::Del(b) if b == n - 1 => {}
            Align::Match(b, e) if e == m - 1 => out.push(Align::Del(b)),
            Align::Ins(e) if e == m - 1 => {}
            other => out.push(other),
        }
    }
    // Every other step addresses an earlier base and edited paragraph, so
    // the kept last paragraph pairs last.
    out.push(Align::Match(n - 1, m - 1));
    out
}

/// A row's identity for alignment: its cells' text.
pub(crate) fn row_key(t: &docx_lower::ir::LoweredTable, row: &[usize]) -> String {
    row.iter()
        .map(|&i| cell_text(&t.cells[i]))
        .collect::<Vec<_>>()
        .join("\u{1f}")
}

/// One step of a block alignment.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Align {
    Match(usize, usize),
    Del(usize),
    Ins(usize),
}

/// A block's identity for alignment: a paragraph is keyed by its style + full
/// text, a table by its shape. Keys only decide WHICH nodes pair up; the pair is
/// then compared field-by-field as before.
fn block_key(b: &LoweredBlock) -> String {
    match b {
        LoweredBlock::Paragraph(p) => {
            let text: String = p.runs.iter().map(|r| r.text.as_str()).collect();
            format!("P|{}|{text}", p.para_style_id.as_deref().unwrap_or(""))
        }
        LoweredBlock::Table(t) => format!("T|{}x{}", t.rows, t.cols),
    }
}

/// A standard LCS alignment, with one post-pass that matters here: an adjacent
/// Del+Ins is coalesced into a MATCH. Without it, editing a paragraph's text
/// changes its key, and the pair would be reported as delete-then-insert —
/// destroying the very `<w:p>` we want to patch in place. Coalescing keeps an
/// edit an edit, and leaves a true deletion a deletion.
pub(crate) fn lcs_align(a: &[String], b: &[String]) -> Vec<Align> {
    lcs_align_within(a, b, LCS_TABLE_CELLS, LCS_GREEDY_EDITS)
}

/// The largest LCS table [`lcs_align`] fills (cells of four bytes). Past it
/// the alignment is computed without the table.
const LCS_TABLE_CELLS: usize = 4_000_000;

/// The most differing blocks the greedy alignment ([`lcs_greedy`]) follows
/// before the linear-space one takes over; its memory grows with the square
/// of this.
const LCS_GREEDY_EDITS: usize = 2048;

/// [`lcs_align`] with its two budgets given. The table is quadratic in the
/// two lengths, and a document's block count is the file's: the common start
/// is matched first (the table's walk matches it the same way), so the table
/// spans only what follows the first difference. When even that is too
/// large, the common end is matched too and the rest aligned without the
/// table: by Myers' greedy algorithm while the lists differ in at most
/// `greedy` blocks (a long document with a few edits far apart: time in
/// proportion to the edits), else by Hirschberg's linear-space LCS. Both
/// find as long a match as the table, in bounded memory.
pub(crate) fn lcs_align_within(
    a: &[String],
    b: &[String],
    budget: usize,
    greedy: usize,
) -> Vec<Align> {
    // Keys as numbers: one string comparison per key, not per table cell.
    let mut ids: HashMap<&str, u32> = HashMap::new();
    let a = intern(a, &mut ids);
    let b = intern(b, &mut ids);

    let prefix = a.iter().zip(&b).take_while(|(x, y)| x == y).count();
    let mut raw: Vec<Align> = (0..prefix).map(|i| Align::Match(i, i)).collect();
    let (mut am, mut bm) = (&a[prefix..], &b[prefix..]);
    let cells = |n: usize, m: usize| (n + 1).saturating_mul(m + 1);
    let mut suffix = 0usize;
    if cells(am.len(), bm.len()) > budget {
        suffix = am
            .iter()
            .rev()
            .zip(bm.iter().rev())
            .take_while(|(x, y)| x == y)
            .count();
        am = &am[..am.len() - suffix];
        bm = &bm[..bm.len() - suffix];
    }
    if cells(am.len(), bm.len()) <= budget {
        lcs_table(am, bm, prefix, &mut raw);
    } else {
        let from = raw.len();
        if !lcs_greedy(am, bm, prefix, greedy, &mut raw) {
            lcs_linear(am, bm, prefix, prefix, &mut raw);
        }
        deletions_first(&mut raw[from..]);
    }
    raw.extend((0..suffix).map(|k| Align::Match(a.len() - suffix + k, b.len() - suffix + k)));

    // Coalesce a stretch of Dels immediately followed by a stretch of Ins
    // into Matches, pairwise in order: editing k ADJACENT paragraphs changes k
    // keys at once, and pairing only the last Del with the first Ins would
    // match the wrong nodes and delete-then-insert the rest (losing their
    // `<w:pPr>` and every unmodelled child). With unequal counts the extra
    // Dels lead (k > k'), the extra Ins trail (k < k') — for one Del or one
    // Ins that is the single-pair rule this pass started as.
    let mut out: Vec<Align> = Vec::with_capacity(raw.len());
    let mut k = 0usize;
    while k < raw.len() {
        let dels: Vec<usize> = raw[k..]
            .iter()
            .map_while(|s| match s {
                Align::Del(x) => Some(*x),
                _ => None,
            })
            .collect();
        let ins: Vec<usize> = raw[k + dels.len()..]
            .iter()
            .map_while(|s| match s {
                Align::Ins(x) => Some(*x),
                _ => None,
            })
            .collect();
        if !dels.is_empty() && !ins.is_empty() {
            let pairs = dels.len().min(ins.len());
            let lead = dels.len() - pairs;
            out.extend(dels[..lead].iter().map(|&d| Align::Del(d)));
            out.extend(
                dels[lead..]
                    .iter()
                    .zip(&ins[..pairs])
                    .map(|(&d, &e)| Align::Match(d, e)),
            );
            out.extend(ins[pairs..].iter().map(|&e| Align::Ins(e)));
            k += dels.len() + ins.len();
            continue;
        }
        out.push(match raw[k] {
            Align::Match(x, y) => Align::Match(x, y),
            Align::Del(x) => Align::Del(x),
            Align::Ins(x) => Align::Ins(x),
        });
        k += 1;
    }
    out
}

/// Each key as the number of the first key equal to it.
fn intern<'k>(keys: &'k [String], ids: &mut HashMap<&'k str, u32>) -> Vec<u32> {
    keys.iter()
        .map(|k| {
            let next = ids.len() as u32;
            *ids.entry(k.as_str()).or_insert(next)
        })
        .collect()
}

/// The LCS table's alignment of `a` against `b` (both `at` blocks into
/// their lists): a match wherever the two heads are equal, else a deletion
/// while that keeps the longest match.
fn lcs_table(a: &[u32], b: &[u32], at: usize, raw: &mut Vec<Align>) {
    let (n, m) = (a.len(), b.len());
    let cell = |i: usize, j: usize| i * (m + 1) + j;
    let mut lcs = vec![0u32; (n + 1) * (m + 1)];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            lcs[cell(i, j)] = if a[i] == b[j] {
                lcs[cell(i + 1, j + 1)] + 1
            } else {
                lcs[cell(i + 1, j)].max(lcs[cell(i, j + 1)])
            };
        }
    }
    let (mut i, mut j) = (0usize, 0usize);
    while i < n && j < m {
        if a[i] == b[j] {
            raw.push(Align::Match(at + i, at + j));
            i += 1;
            j += 1;
        } else if lcs[cell(i + 1, j)] >= lcs[cell(i, j + 1)] {
            raw.push(Align::Del(at + i));
            i += 1;
        } else {
            raw.push(Align::Ins(at + j));
            j += 1;
        }
    }
    raw.extend((i..n).map(|i| Align::Del(at + i)));
    raw.extend((j..m).map(|j| Align::Ins(at + j)));
}

/// Between two matches the order of deletions and insertions is free: put
/// the deletions first, as the table's walk does, so the pass that pairs a
/// stretch of deletions with the insertions after it sees them.
fn deletions_first(steps: &mut [Align]) {
    let mut k = 0usize;
    while k < steps.len() {
        let end = steps[k..]
            .iter()
            .position(|s| matches!(s, Align::Match(..)))
            .map_or(steps.len(), |n| k + n);
        // Stable: each kind keeps its own order.
        steps[k..end].sort_by_key(|s| matches!(s, Align::Ins(_)));
        k = end + 1;
    }
}

/// Myers' greedy algorithm: the shortest edit script from `a` to `b` (both
/// `at` blocks into their lists), which leaves an LCS matched, found in time
/// and memory that grow with the number of edits rather than the lengths.
/// Gives up (`false`, nothing written) past `max_edits` edits.
fn lcs_greedy(a: &[u32], b: &[u32], at: usize, max_edits: usize, raw: &mut Vec<Align>) -> bool {
    let (n, m) = (a.len() as isize, b.len() as isize);
    let max = max_edits.min(a.len() + b.len()) as isize;
    // `v[k + max + 1]`: the furthest `x` reached on diagonal `k = x - y`.
    let mut v = vec![0isize; 2 * max as usize + 3];
    let at_k = |k: isize| (k + max + 1) as usize;
    // Per edit count `d`, the diagonals `-d..=d` as they stood before it.
    let mut trace: Vec<Vec<isize>> = Vec::new();
    let mut found = None;
    'search: for d in 0..=max {
        trace.push(v[at_k(-d)..=at_k(d)].to_vec());
        let mut k = -d;
        while k <= d {
            let mut x = if k == -d || (k != d && v[at_k(k - 1)] < v[at_k(k + 1)]) {
                v[at_k(k + 1)]
            } else {
                v[at_k(k - 1)] + 1
            };
            let mut y = x - k;
            while x < n && y < m && a[x as usize] == b[y as usize] {
                x += 1;
                y += 1;
            }
            v[at_k(k)] = x;
            if x >= n && y >= m {
                found = Some(d);
                break 'search;
            }
            k += 2;
        }
    }
    let Some(edits) = found else {
        return false;
    };
    // Walk back from the end, one edit per step.
    let mut steps: Vec<Align> = Vec::new();
    let (mut x, mut y) = (n, m);
    for d in (0..=edits).rev() {
        // `trace[d]` holds diagonals `-d..=d`.
        let before = |k: isize| trace[d as usize][(k + d) as usize];
        let k = x - y;
        let down = k == -d || (k != d && before(k - 1) < before(k + 1));
        let prev_k = if down { k + 1 } else { k - 1 };
        let (prev_x, prev_y) = if d == 0 {
            (0, 0)
        } else {
            (before(prev_k), before(prev_k) - prev_k)
        };
        // The diagonal run after the edit, then the edit itself.
        let (edit_x, edit_y) = if d == 0 {
            (0, 0)
        } else if down {
            (prev_x, prev_y + 1)
        } else {
            (prev_x + 1, prev_y)
        };
        while x > edit_x && y > edit_y {
            x -= 1;
            y -= 1;
            steps.push(Align::Match(at + x as usize, at + y as usize));
        }
        if d > 0 {
            steps.push(if down {
                Align::Ins(at + prev_y as usize)
            } else {
                Align::Del(at + prev_x as usize)
            });
        }
        (x, y) = (prev_x, prev_y);
    }
    raw.extend(steps.into_iter().rev());
    true
}

/// Hirschberg's algorithm: an LCS alignment of `a` (from block `ai`)
/// against `b` (from block `bj`) in memory linear in the shorter side's
/// length, by splitting `a` in half and `b` where the two halves' LCS
/// lengths add up to the most.
fn lcs_linear(a: &[u32], b: &[u32], ai: usize, bj: usize, raw: &mut Vec<Align>) {
    let (n, m) = (a.len(), b.len());
    if n == 0 {
        raw.extend((0..m).map(|j| Align::Ins(bj + j)));
        return;
    }
    if n == 1 {
        match b.iter().position(|y| *y == a[0]) {
            Some(k) => {
                raw.extend((0..k).map(|j| Align::Ins(bj + j)));
                raw.push(Align::Match(ai, bj + k));
                raw.extend((k + 1..m).map(|j| Align::Ins(bj + j)));
            }
            None => {
                raw.push(Align::Del(ai));
                raw.extend((0..m).map(|j| Align::Ins(bj + j)));
            }
        }
        return;
    }
    let mid = n / 2;
    // LCS lengths of `a[..mid]` against every prefix of `b`, and of
    // `a[mid..]` against every suffix.
    let head = lcs_lengths(a[..mid].iter(), b.iter(), m);
    let tail = lcs_lengths(a[mid..].iter().rev(), b.iter().rev(), m);
    let split = (0..=m)
        .max_by_key(|&j| (head[j] + tail[m - j], std::cmp::Reverse(j)))
        .unwrap_or(0);
    lcs_linear(&a[..mid], &b[..split], ai, bj, raw);
    lcs_linear(&a[mid..], &b[split..], ai + mid, bj + split, raw);
}

/// The last row of the LCS table of `a` against `b` (of `m` keys): entry
/// `j` is the LCS length of all of `a` and the first `j` keys of `b`.
fn lcs_lengths<'k>(
    a: impl Iterator<Item = &'k u32>,
    b: impl Iterator<Item = &'k u32> + Clone,
    m: usize,
) -> Vec<u32> {
    let mut row = vec![0u32; m + 1];
    for x in a {
        // `diagonal` is the previous row's entry left of the one written.
        let mut diagonal = 0u32;
        for (j, y) in b.clone().enumerate() {
            let above = row[j + 1];
            row[j + 1] = if x == y {
                diagonal + 1
            } else {
                above.max(row[j])
            };
            diagonal = above;
        }
    }
    row
}

/// Align a paragraph's baseline runs against its edited runs by (text, style)
/// identity and emit the insert/delete ops that turn one into the other. A
/// classic LCS: matched runs are left alone, unmatched baseline runs are
/// deleted, unmatched edited runs are inserted after the preceding match (or at
/// the paragraph start).
fn align_runs(
    block: usize,
    bp: &docx_lower::ir::LoweredParagraph,
    ep: &docx_lower::ir::LoweredParagraph,
    edited: &LoweredDoc,
    bindings: &DocxBindings,
) -> Vec<StructuralEdit> {
    let key = |r: &docx_lower::ir::LoweredRun| (r.text.clone(), r.char_style_id.clone());
    let a: Vec<_> = bp.runs.iter().map(key).collect();
    let b: Vec<_> = ep.runs.iter().map(key).collect();

    // LCS table over the two run lists.
    let (n, m) = (a.len(), b.len());
    let mut lcs = vec![vec![0usize; m + 1]; n + 1];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            lcs[i][j] = if a[i] == b[j] {
                lcs[i + 1][j + 1] + 1
            } else {
                lcs[i + 1][j].max(lcs[i][j + 1])
            };
        }
    }

    let mut ops = Vec::new();
    let (mut i, mut j) = (0usize, 0usize);
    // The last baseline run index that survives — new runs anchor after it.
    let mut anchor: Option<usize> = None;
    while i < n && j < m {
        if a[i] == b[j] {
            anchor = Some(i);
            i += 1;
            j += 1;
        } else if lcs[i + 1][j] >= lcs[i][j + 1] {
            ops.push(StructuralEdit::DeleteRun { block, run: i });
            i += 1;
        } else {
            ops.push(insert_run_op(
                block,
                anchor,
                &ep.runs[j],
                ep.para_style_id.as_deref(),
                edited,
                bindings,
            ));
            j += 1;
        }
    }
    while i < n {
        ops.push(StructuralEdit::DeleteRun { block, run: i });
        i += 1;
    }
    while j < m {
        ops.push(insert_run_op(
            block,
            anchor,
            &ep.runs[j],
            ep.para_style_id.as_deref(),
            edited,
            bindings,
        ));
        j += 1;
    }
    ops
}

fn insert_run_op(
    block: usize,
    after: Option<usize>,
    run: &docx_lower::ir::LoweredRun,
    para: Option<&str>,
    edited: &LoweredDoc,
    bindings: &DocxBindings,
) -> StructuralEdit {
    let (props, rstyle) = effective_props(run.char_style_id.as_deref(), para, edited, bindings);
    StructuralEdit::InsertRun {
        block,
        run: after,
        text: run.text.clone(),
        props,
        rstyle,
    }
}

/// The effective DIRECT character formatting a run's lowered style token maps to,
/// plus the real `w:rStyle` id it should carry. A real Word style ⇒ rStyle + no
/// direct props; a synthesized style ⇒ its inverted props + (its `basedOn`'s real
/// style, if any); no style ⇒ cleared formatting.
///
/// `para` is the run's paragraph style token: with the run's own, it gives
/// the size the run is set in, which Word's absolute character spacing is
/// relative to as the engine's tracking.
pub(crate) fn effective_props(
    token: Option<&str>,
    para: Option<&str>,
    doc: &LoweredDoc,
    bindings: &DocxBindings,
) -> (RunProps, Option<String>) {
    let size_pt = token_size(token, doc)
        .or_else(|| token_size(para, doc))
        .unwrap_or(WORD_DEFAULT_SIZE_PT);
    effective_props_at(token, size_pt, doc, bindings)
}

/// Word's type size where nothing sets one (the lowering's default too).
const WORD_DEFAULT_SIZE_PT: f32 = 10.0;

/// The size a lowered style token sets, itself or through its `basedOn`
/// chain (`characterFontSize`).
fn token_size(token: Option<&str>, doc: &LoweredDoc) -> Option<f32> {
    let mut next = token;
    for _ in 0..64 {
        let style = doc.styles.iter().find(|s| Some(s.id.as_str()) == next)?;
        let own = style
            .props
            .iter()
            .find_map(|p| match (p.path.as_str(), &p.value) {
                ("characterFontSize", PropValue::Length(pt)) => Some(*pt),
                _ => None,
            });
        if own.is_some() {
            return own;
        }
        next = style.based_on.as_deref();
    }
    None
}

/// [`effective_props`] for a run set in `size_pt`.
fn effective_props_at(
    token: Option<&str>,
    size_pt: f32,
    doc: &LoweredDoc,
    bindings: &DocxBindings,
) -> (RunProps, Option<String>) {
    let Some(token) = token else {
        return (RunProps::default(), None);
    };
    if let Some(style_id) = bindings.char_token_to_style_id.get(token) {
        return (RunProps::default(), Some(style_id.clone()));
    }
    if let Some(style) = doc.styles.iter().find(|s| s.id == token) {
        if token.starts_with(EDIT_STYLE_PREFIX) {
            // A canvas edit's direct formatting over the run's style.
            let (mut props, rstyle) =
                effective_props_at(style.based_on.as_deref(), size_pt, doc, bindings);
            apply_overrides(&mut props, &style.props, size_pt, doc);
            return (props, rstyle);
        }
        let props = invert_props(&style.props, size_pt, doc);
        let rstyle = style
            .based_on
            .as_deref()
            .and_then(|b| bindings.char_token_to_style_id.get(b).cloned());
        return (props, rstyle);
    }
    (RunProps::default(), None)
}

/// The token prefix of the character styles the overlay makes for a run
/// the canvas formatted directly (`overlay::run_token`): based on the run's
/// own style token, holding only the direct overrides the engine read back.
pub(crate) const EDIT_STYLE_PREFIX: &str = "CharacterStyle/docx-edit-";

/// Apply a canvas edit's direct overrides (engine `StyleProp`s) over a
/// run's effective properties. A toggle the run does not set stays unset
/// when the override only says "off" (the engine reads a plain run as
/// `Regular`, not underlined, …), so turning nothing on writes nothing.
fn apply_overrides(r: &mut RunProps, overrides: &[StyleProp], size_pt: f32, doc: &LoweredDoc) {
    fn set(field: &mut Option<bool>, on: bool) {
        if on || field.is_some() {
            *field = Some(on);
        }
    }
    for p in overrides {
        match (p.path.as_str(), &p.value) {
            ("characterFontFamily", PropValue::Text(f)) => {
                r.font = Some(f.clone());
                r.font_theme = theme_font_slot(f, doc);
            }
            ("characterFontStyle", PropValue::Text(s)) => {
                set(&mut r.bold, s.contains("Bold"));
                set(&mut r.italic, s.contains("Italic") || s.contains("Oblique"));
            }
            ("characterFontSize", PropValue::Length(pt)) => {
                r.size_half_pts = Some((pt * 2.0).round() as u32);
            }
            ("characterFillColor", PropValue::ColorRef(id)) => {
                if let Some((hex, theme)) = swatch_color(id, doc) {
                    r.color = Some(hex);
                    r.theme_color = theme;
                }
            }
            ("characterUnderline", PropValue::Bool(u)) => set(&mut r.underline, *u),
            ("characterStrikethru", PropValue::Bool(s)) => set(&mut r.strike, *s),
            ("characterCase", PropValue::Text(c)) => {
                set(&mut r.caps, c == "AllCaps");
                set(&mut r.small_caps, c == "SmallCaps");
            }
            ("characterPosition", PropValue::Text(pos)) => {
                r.vert_align = match pos.as_str() {
                    "Superscript" | "OTSuperscript" => Some(VertAlign::Superscript),
                    "Subscript" | "OTSubscript" => Some(VertAlign::Subscript),
                    _ => r.vert_align.map(|_| VertAlign::Baseline),
                };
            }
            ("characterBaselineShift", PropValue::Length(pt)) => {
                let half = (pt * 2.0).round() as i32;
                if half != 0 || r.baseline_half_pts.is_some() {
                    r.baseline_half_pts = Some(half);
                }
            }
            ("characterTracking", PropValue::Length(t)) => {
                let twips = twips_of_tracking(*t, size_pt);
                if twips != 0 || r.spacing_twips.is_some() {
                    r.spacing_twips = Some(twips);
                }
            }
            (path, value) => {
                apply_script_prop(r, path, value);
            }
        }
    }
}

/// Doc ADR 620 — a script path's value onto `r` (the reverse of
/// `docx_lower::script_props`). `false` when `path` is not one.
pub(crate) fn apply_script_prop(r: &mut RunProps, path: &str, value: &PropValue) -> bool {
    match (path, value) {
        ("characterEastAsianFont", PropValue::Text(f)) => {
            r.font_east_asia = (!f.is_empty()).then(|| f.clone())
        }
        ("characterComplexFont", PropValue::Text(f)) => {
            r.font_cs = (!f.is_empty()).then(|| f.clone())
        }
        ("characterComplexFontSize", PropValue::Length(pt)) => {
            r.size_cs_half_pts = Some((pt * 2.0).round() as u32)
        }
        ("characterComplexBold", PropValue::Bool(b)) => r.bold_cs = Some(*b),
        ("characterComplexItalic", PropValue::Bool(b)) => r.italic_cs = Some(*b),
        ("characterComplexScript", PropValue::Bool(b)) => r.complex_script = Some(*b),
        ("characterDirection", PropValue::Text(d)) => {
            r.rtl = match d.as_str() {
                "rtl" => Some(true),
                "ltr" => Some(false),
                _ => None,
            }
        }
        ("characterFontHint", PropValue::Text(h)) => {
            r.font_hint = (!h.is_empty()).then(|| h.clone())
        }
        _ => return false,
    }
    true
}

/// What becomes of one baseline run ([`plan_runs`]).
#[derive(Debug, Clone, PartialEq)]
// Short-lived (one per run of an edited paragraph): boxing the look would
// cost an allocation per edit to save stack space nobody keeps.
#[allow(clippy::large_enum_variant)]
pub(crate) enum RunPlan {
    /// Untouched: not addressed, its bytes stay.
    Keep,
    /// All its text is gone.
    Delete,
    /// One piece: a new text and/or a new look (`None` = unchanged).
    Edit {
        text: Option<String>,
        format: Option<RunFormat>,
    },
    /// Several pieces, in order (a piece's `format` is `None` in the
    /// run's own look).
    Split(Vec<RunPiece>),
}

/// Map an edited paragraph's runs back onto its baseline runs, character by
/// character, and say per baseline run what becomes of it, with the run's
/// own look. The two texts are aligned (common start and end, then a
/// longest common subsequence of what lies between): a kept character
/// stays in its baseline run, taking the look of the edited run it is in
/// now; new text goes to the run of the first character it replaces, or —
/// typed between two runs — to the run before (or after) whose look it
/// has, else the run before it, as typing at the end of a word extends that
/// run. A baseline run whose characters all kept its look is untouched; one
/// whose characters now have one other look is edited in place; one whose
/// characters have several looks is split. Runs the engine joined (one
/// style) map back onto their Word runs this way; nothing is ever merged.
pub(crate) fn plan_runs(
    (base_runs, base_para): (&[docx_lower::ir::LoweredRun], Option<&str>),
    (edited_runs, edited_para): (&[docx_lower::ir::LoweredRun], Option<&str>),
    base: &LoweredDoc,
    edited: &LoweredDoc,
    bindings: &DocxBindings,
) -> Vec<(RunPlan, RunFormat)> {
    let look = |r: &docx_lower::ir::LoweredRun, para: Option<&str>, doc: &LoweredDoc| {
        let (props, rstyle) = effective_props(r.char_style_id.as_deref(), para, doc, bindings);
        RunFormat { props, rstyle }
    };
    let base_looks: Vec<RunFormat> = base_runs.iter().map(|r| look(r, base_para, base)).collect();
    let edited_looks: Vec<RunFormat> = edited_runs
        .iter()
        .map(|r| look(r, edited_para, edited))
        .collect();
    let old: Vec<(char, usize)> = base_runs
        .iter()
        .enumerate()
        .flat_map(|(k, r)| r.text.chars().map(move |c| (c, k)))
        .collect();
    let new: Vec<(char, usize)> = edited_runs
        .iter()
        .enumerate()
        .flat_map(|(j, r)| r.text.chars().map(move |c| (c, j)))
        .collect();
    let a: Vec<char> = old.iter().map(|(c, _)| *c).collect();
    let b: Vec<char> = new.iter().map(|(c, _)| *c).collect();

    // Each baseline run's characters as they are now: (char, edited run).
    let mut assigned: Vec<Vec<(char, usize)>> = vec![Vec::new(); base_runs.len()];
    let mut gap_dels: Vec<usize> = Vec::new();
    let mut gap_ins: Vec<usize> = Vec::new();
    // The baseline character before the open gap (its index in `old`).
    let mut prev: Option<usize> = None;
    let flush = |assigned: &mut Vec<Vec<(char, usize)>>,
                 dels: &mut Vec<usize>,
                 ins: &mut Vec<usize>,
                 prev: Option<usize>,
                 next: Option<usize>| {
        if !ins.is_empty() {
            if let Some(&d) = dels.first() {
                let k = old[d].1;
                assigned[k].extend(ins.iter().map(|&e| new[e]));
            } else {
                let before = prev.map(|i| old[i].1);
                let after = next.map(|i| old[i].1);
                let mut to_after = false;
                let mut tail: Vec<(char, usize)> = Vec::new();
                for &e in ins.iter() {
                    let l = &edited_looks[new[e].1];
                    if !to_after {
                        let fits_before = before.is_some_and(|k| base_looks[k] == *l);
                        let fits_after = after.is_some_and(|k| base_looks[k] == *l);
                        to_after = before.is_none() || (!fits_before && fits_after);
                    }
                    match (to_after, before, after) {
                        (false, Some(k), _) => assigned[k].push(new[e]),
                        (_, _, Some(_)) => tail.push(new[e]),
                        (_, Some(k), None) => assigned[k].push(new[e]),
                        (_, None, None) => {
                            if let Some(first) = assigned.first_mut() {
                                first.push(new[e]);
                            }
                        }
                    }
                }
                if let Some(k) = after {
                    // The run after: the new text goes before its characters.
                    let rest = std::mem::take(&mut assigned[k]);
                    assigned[k] = tail;
                    assigned[k].extend(rest);
                }
            }
        }
        dels.clear();
        ins.clear();
    };
    for step in align_chars(&a, &b) {
        match step {
            Align::Match(i, e) => {
                flush(&mut assigned, &mut gap_dels, &mut gap_ins, prev, Some(i));
                assigned[old[i].1].push((old[i].0, new[e].1));
                prev = Some(i);
            }
            Align::Del(i) => gap_dels.push(i),
            Align::Ins(e) => gap_ins.push(e),
        }
    }
    // The gap at the end: nothing follows it.
    flush(&mut assigned, &mut gap_dels, &mut gap_ins, prev, None);

    base_runs
        .iter()
        .zip(assigned)
        .zip(base_looks)
        .map(|((run, chars), own)| {
            // Group the run's characters by look.
            let mut pieces: Vec<(String, RunFormat)> = Vec::new();
            for (c, j) in chars {
                let l = &edited_looks[j];
                match pieces.last_mut() {
                    Some((t, pl)) if pl == l => t.push(c),
                    _ => pieces.push((c.to_string(), l.clone())),
                }
            }
            let plan = match pieces.len() {
                0 if run.text.is_empty() => RunPlan::Keep,
                0 => RunPlan::Delete,
                1 => {
                    let (text, l) = pieces.pop().unwrap_or_default();
                    let text = (text != run.text).then_some(text);
                    let format = (l != own).then_some(l);
                    if text.is_none() && format.is_none() {
                        RunPlan::Keep
                    } else {
                        RunPlan::Edit { text, format }
                    }
                }
                _ => RunPlan::Split(
                    pieces
                        .into_iter()
                        .map(|(text, l)| RunPiece {
                            text,
                            format: (l != own).then_some(l),
                        })
                        .collect(),
                ),
            };
            (plan, own)
        })
        .collect()
}

/// Align two texts character by character: the common start and end
/// match; what lies between is aligned by a longest common subsequence
/// (deletions before insertions in a gap, matches as late as they can be),
/// or, past a size where the table
/// would grow too large, replaced whole.
pub(crate) fn align_chars(a: &[char], b: &[char]) -> Vec<Align> {
    let prefix = a.iter().zip(b).take_while(|(x, y)| x == y).count();
    let max_suffix = a.len().min(b.len()) - prefix;
    let suffix = a
        .iter()
        .rev()
        .zip(b.iter().rev())
        .take(max_suffix)
        .take_while(|(x, y)| x == y)
        .count();
    let (am, bm) = (&a[prefix..a.len() - suffix], &b[prefix..b.len() - suffix]);
    let mut out: Vec<Align> = (0..prefix).map(|i| Align::Match(i, i)).collect();
    let (n, m) = (am.len(), bm.len());
    if n.saturating_mul(m) <= 4_000_000 {
        let mut lcs = vec![0u32; (n + 1) * (m + 1)];
        let at = |i: usize, j: usize| i * (m + 1) + j;
        for i in (0..n).rev() {
            for j in (0..m).rev() {
                lcs[at(i, j)] = if am[i] == bm[j] {
                    lcs[at(i + 1, j + 1)] + 1
                } else {
                    lcs[at(i + 1, j)].max(lcs[at(i, j + 1)])
                };
            }
        }
        // Matches as late as the subsequence allows: a character is
        // deleted, else inserted, while that keeps the longest match, so
        // the kept text stays together (deleting " bold red" before " text."
        // keeps " text." whole rather than matching its space to the one
        // inside the deleted words).
        let (mut i, mut j) = (0usize, 0usize);
        while i < n && j < m {
            let here = lcs[at(i, j)];
            if lcs[at(i + 1, j)] == here {
                out.push(Align::Del(prefix + i));
                i += 1;
            } else if lcs[at(i, j + 1)] == here {
                out.push(Align::Ins(prefix + j));
                j += 1;
            } else {
                out.push(Align::Match(prefix + i, prefix + j));
                i += 1;
                j += 1;
            }
        }
        out.extend((i..n).map(|i| Align::Del(prefix + i)));
        out.extend((j..m).map(|j| Align::Ins(prefix + j)));
    } else {
        out.extend((0..n).map(|i| Align::Del(prefix + i)));
        out.extend((0..m).map(|j| Align::Ins(prefix + j)));
    }
    out.extend((0..suffix).map(|k| Align::Match(a.len() - suffix + k, b.len() - suffix + k)));
    out
}

/// Invert a synthesized character style's `StyleProp`s back to `RunProps` — the
/// exact reverse of `docx-lower`'s `run_props`.
pub(crate) fn invert_props(props: &[StyleProp], size_pt: f32, doc: &LoweredDoc) -> RunProps {
    let mut r = RunProps::default();
    for p in props {
        match (p.path.as_str(), &p.value) {
            ("characterFontFamily", PropValue::Text(f)) => {
                r.font = Some(f.clone());
                r.font_theme = theme_font_slot(f, doc);
            }
            ("characterFontStyle", PropValue::Text(s)) => {
                let (b, i) = match s.as_str() {
                    "Bold Italic" => (true, true),
                    "Bold" => (true, false),
                    "Italic" => (false, true),
                    _ => (false, false), // "Regular"
                };
                r.bold = Some(b);
                r.italic = Some(i);
            }
            ("characterFontSize", PropValue::Length(pt)) => {
                r.size_half_pts = Some((pt * 2.0).round() as u32);
            }
            ("characterFillColor", PropValue::ColorRef(id)) => {
                let (hex, theme) = swatch_color(id, doc).unzip();
                r.color = hex;
                r.theme_color = theme.flatten();
            }
            ("characterUnderline", PropValue::Bool(u)) => r.underline = Some(*u),
            ("characterStrikethru", PropValue::Bool(s)) => r.strike = Some(*s),
            ("characterPosition", PropValue::Text(pos)) => {
                r.vert_align = match pos.as_str() {
                    "Superscript" => Some(VertAlign::Superscript),
                    "Subscript" => Some(VertAlign::Subscript),
                    _ => None,
                };
            }
            ("characterCase", PropValue::Text(c)) => match c.as_str() {
                "SmallCaps" => r.small_caps = Some(true),
                "AllCaps" => r.caps = Some(true),
                _ => {}
            },
            ("characterBaselineShift", PropValue::Length(pt)) => {
                r.baseline_half_pts = Some((pt * 2.0).round() as i32);
            }
            ("characterTracking", PropValue::Length(t)) => {
                r.spacing_twips = Some(twips_of_tracking(*t, size_pt));
            }
            (path, value) => {
                apply_script_prop(&mut r, path, value);
            }
        }
    }
    r
}

/// Resolve a swatch id to its `RRGGBB` hex (the inverse of `swatch_for`)
/// and, for a theme colour's swatch that still shows the colour it had at
/// import (doc ADR 609), the theme reference Word wrote: an edited theme
/// swatch, or any other swatch, writes plain hex.
pub(crate) fn swatch_color(
    id: &str,
    doc: &LoweredDoc,
) -> Option<(String, Option<docx_core::ThemeColorRef>)> {
    let sw = doc.swatches.iter().find(|s| s.id == id)?;
    if sw.value.len() < 3 {
        return None;
    }
    let hex = format!(
        "{:02X}{:02X}{:02X}",
        sw.value[0].round() as u8,
        sw.value[1].round() as u8,
        sw.value[2].round() as u8
    );
    let theme = sw
        .theme
        .as_ref()
        .filter(|t| t.rgb.eq_ignore_ascii_case(&hex))
        .map(|t| t.color.clone());
    Some((hex, theme))
}

/// The theme font a family is (doc ADR 609): `minorHAnsi` for the theme's
/// body face, `majorHAnsi` for its heading face, else none.
pub(crate) fn theme_font_slot(family: &str, doc: &LoweredDoc) -> Option<String> {
    let fonts = doc.theme_fonts.as_ref()?;
    if fonts.minor.as_deref() == Some(family) {
        Some("minorHAnsi".into())
    } else if fonts.major.as_deref() == Some(family) {
        Some("majorHAnsi".into())
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn align(a: &[&str], b: &[&str]) -> Vec<String> {
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        lcs_align(&s(a), &s(b))
            .into_iter()
            .map(|step| match step {
                Align::Match(x, y) => format!("={x}{y}"),
                Align::Del(x) => format!("-{x}"),
                Align::Ins(y) => format!("+{y}"),
            })
            .collect()
    }

    fn align_cell(a: &[&str], b: &[&str]) -> Vec<String> {
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        align_cell_paragraphs(&s(a), &s(b))
            .into_iter()
            .map(|step| match step {
                Align::Match(x, y) => format!("={x}{y}"),
                Align::Del(x) => format!("-{x}"),
                Align::Ins(y) => format!("+{y}"),
            })
            .collect()
    }

    /// A deterministic sequence of keys from a small alphabet (so the two
    /// lists share many, in different orders).
    fn keys(seed: u64, len: usize, alphabet: u64) -> Vec<String> {
        let mut x = seed;
        (0..len)
            .map(|_| {
                x = x
                    .wrapping_mul(6364136223846793005)
                    .wrapping_add(1442695040888963407);
                format!("k{}", (x >> 33) % alphabet)
            })
            .collect()
    }

    /// The LCS length, by the two-row table.
    fn lcs_len(a: &[String], b: &[String]) -> usize {
        let mut row = vec![0usize; b.len() + 1];
        for x in a {
            let mut diagonal = 0;
            for (j, y) in b.iter().enumerate() {
                let above = row[j + 1];
                row[j + 1] = if x == y {
                    diagonal + 1
                } else {
                    above.max(row[j])
                };
                diagonal = above;
            }
        }
        row[b.len()]
    }

    /// Whether `steps` is an edit script from `a` to `b`: every base and
    /// every edited block named once, each list in order.
    fn assert_script(steps: &[Align], a: &[String], b: &[String]) {
        let (mut i, mut j) = (0usize, 0usize);
        for s in steps {
            match *s {
                Align::Match(x, y) => {
                    assert_eq!((x, y), (i, j));
                    i += 1;
                    j += 1;
                }
                Align::Del(x) => {
                    assert_eq!(x, i);
                    i += 1;
                }
                Align::Ins(y) => {
                    assert_eq!(y, j);
                    j += 1;
                }
            }
        }
        assert_eq!((i, j), (a.len(), b.len()));
    }

    #[test]
    fn every_path_aligns_as_long_a_match_as_the_table() {
        for seed in 0..40u64 {
            let a = keys(seed, 5 + (seed as usize * 7) % 60, 2 + seed % 9);
            let b = keys(seed + 1000, 5 + (seed as usize * 11) % 60, 2 + seed % 9);
            let want = lcs_len(&a, &b);
            // The matches of equal keys: a coalesced Del + Ins pair is a
            // match of different ones.
            let equal = |steps: &[Align]| {
                steps
                    .iter()
                    .filter(|s| matches!(s, Align::Match(x, y) if a[*x] == b[*y]))
                    .count()
            };
            let table = lcs_align_within(&a, &b, usize::MAX, 0);
            assert_script(&table, &a, &b);
            assert_eq!(equal(&table), want, "seed {seed}, table");
            // No table: the greedy path, then (no edits allowed) the
            // linear-space one.
            for greedy in [usize::MAX, 0] {
                let steps = lcs_align_within(&a, &b, 0, greedy);
                assert_script(&steps, &a, &b);
                assert_eq!(equal(&steps), want, "seed {seed}, greedy {greedy}");
            }
        }
    }

    #[test]
    fn without_the_table_an_edit_is_still_an_edit() {
        // The pairing of a deleted stretch with the inserted one after it
        // holds on every path.
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        let (a, b) = (
            s(&["a", "b", "c", "d", "e"]),
            s(&["a", "B", "C", "d", "x", "e"]),
        );
        let want = [
            Align::Match(0, 0),
            Align::Match(1, 1),
            Align::Match(2, 2),
            Align::Match(3, 3),
            Align::Ins(4),
            Align::Match(4, 5),
        ];
        assert_eq!(lcs_align_within(&a, &b, usize::MAX, 0), want);
        assert_eq!(lcs_align_within(&a, &b, 0, usize::MAX), want);
        assert_eq!(lcs_align_within(&a, &b, 0, 0), want);
    }

    #[test]
    fn the_start_matched_first_changes_no_alignment() {
        // The table over everything (the alignment before the common start
        // was matched ahead of it) and over what follows the start agree.
        for seed in 0..40u64 {
            let mut a = keys(seed, 30, 4);
            let mut b = a.clone();
            a.extend(keys(seed + 7, 20, 4));
            b.extend(keys(seed + 9, 25, 4));
            let (ia, ib): (Vec<u32>, Vec<u32>) = {
                let id = |k: &String| k[1..].parse::<u32>().unwrap();
                (a.iter().map(id).collect(), b.iter().map(id).collect())
            };
            let mut whole = Vec::new();
            lcs_table(&ia, &ib, 0, &mut whole);
            let prefix = ia.iter().zip(&ib).take_while(|(x, y)| x == y).count();
            let mut split: Vec<Align> = (0..prefix).map(|i| Align::Match(i, i)).collect();
            lcs_table(&ia[prefix..], &ib[prefix..], prefix, &mut split);
            assert_eq!(whole, split, "seed {seed}");
        }
    }

    #[test]
    fn a_long_document_edited_at_both_ends_aligns_in_bounded_memory() {
        // 60 000 blocks, one edited near the start and one deleted near the
        // end: a full table would hold 3.6 billion cells; the greedy
        // alignment follows the two edits.
        let a: Vec<String> = (0..60_000).map(|i| format!("p{i}")).collect();
        let mut b = a.clone();
        b[10] = "edited".into();
        b.remove(59_990);
        let steps = lcs_align(&a, &b);
        assert_script(&steps, &a, &b);
        assert_eq!(steps[10], Align::Match(10, 10));
        assert_eq!(
            steps
                .iter()
                .filter(|s| !matches!(s, Align::Match(..)))
                .collect::<Vec<_>>(),
            [&Align::Del(59_990)]
        );
    }

    #[test]
    fn a_cell_keeps_its_last_paragraph() {
        // A middle paragraph removed: it goes.
        assert_eq!(
            align_cell(&["a", "b", "c"], &["a", "c"]),
            ["=00", "-1", "=21"]
        );
        // The last removed: the last paragraph takes the last text, and the
        // one that held it goes.
        assert_eq!(align_cell(&["a", "b"], &["a"]), ["-0", "=10"]);
        assert_eq!(
            align_cell(&["a", "b", "c"], &["a", "b"]),
            ["=00", "-1", "=21"]
        );
        // Added paragraphs are insertions; the last is untouched.
        assert_eq!(
            align_cell(&["a", "c"], &["a", "b", "c"]),
            ["=00", "+1", "=12"]
        );
        assert_eq!(align_cell(&["a"], &["a", "b"]), ["=00", "+1"]);
    }

    #[test]
    fn adjacent_edits_pair_in_order() {
        // Three adjacent paragraphs edited at once: three in-place edits,
        // not one mismatched pair and four structural ops.
        assert_eq!(
            align(&["a", "b", "c", "d"], &["a", "B", "C", "D"]),
            ["=00", "=11", "=22", "=33"]
        );
        // Two deleted where one was edited: the extra Del leads.
        assert_eq!(
            align(&["a", "b", "c", "d"], &["a", "X", "d"]),
            ["=00", "-1", "=21", "=32"]
        );
        // One edited and one inserted: the extra Ins trails.
        assert_eq!(
            align(&["a", "b", "d"], &["a", "X", "Y", "d"]),
            ["=00", "=11", "+2", "=23"]
        );
        // A plain deletion stays a deletion.
        assert_eq!(align(&["a", "b", "c"], &["a", "c"]), ["=00", "-1", "=21"]);
    }
}
