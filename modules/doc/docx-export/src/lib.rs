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

//! paged.doc M2 edited save-back — the targeted-patch export engine.
//!
//! `apply_edits` resolves an [`EditSet`] (keyed by lowered story coordinates)
//! through the import-built [`DocxBindings`] to source `<w:p>`/`<w:r>` ordinals,
//! renders the replacement `<w:rPr>`/`<w:t>` fragments, byte-splices only those
//! holes in `word/document.xml`, and writes the patched part back into the
//! retained [`OpcPackage`]. Every other part — and every untouched subtree — is
//! re-emitted byte-identical (the preservation invariant). The ooxmlsdk
//! serializer is never linked (the wasm-budget guard).

mod bindings;
mod diff;
mod edit;
mod native;
pub mod notes;
mod overlay;
pub mod review;
mod rpr;
mod splice;
pub mod structure;
mod styles;
pub mod textbox;
mod write;

pub use bindings::{build_bindings, BlockBinding, DocxBindings, ParaUse, RunBinding, RunLock};
pub use diff::diff;
pub use edit::{
    AtomInsert, CellRunEdit, EditSet, ParaEdit, RunEdit, RunFormat, RunPiece, StructuralEdit,
};
pub use native::{native_document, NativeDocIn, PageIn};
pub use overlay::{
    add_canvas_colors, overlay_cells, overlay_cells_known, overlay_story_content,
    overlay_story_content_in, overlay_story_content_known, overlay_story_content_with,
    overlay_tables, CellContentIn, ChangeContentIn, CommentContentIn, FormatChangeContentIn,
    ParagraphContentIn, PropsChangeContentIn, RunContentIn, StoryContentIn, TableContentIn,
    TableParagraphs,
};
pub use styles::{
    plan_styles, splice_styles, CreatedStyle, ModifiedStyle, StyleEntryIn, StyleIn, StylePlan,
    WireValue,
};
pub use write::{heading_level, write_docx, WriteReport, DOCUMENT_MAIN};

use std::collections::BTreeMap;

use paged_ooxml::{OoxmlError, OpcPackage};
use splice::{
    patch_document_xml_cols, CellParaAction, ColumnAction, ResolvedCellTarget, ResolvedParaTarget,
    ResolvedRowTarget, ResolvedTarget,
};

/// Apply `edits` to `pkg`'s main document part in place. Non-patchable targets
/// (tables, hyperlink/field runs, out-of-range indices, non-uniform-grid
/// column ops) are skipped WITH a note — the returned `Vec<String>` is the
/// refusal ledger the caller surfaces as diagnostics (previously the doc
/// comment promised this and nothing carried it). A no-op edit set leaves
/// `pkg` untouched. On success the main part is dirtied; `pkg.write()` then
/// yields the saved `.docx` bytes.
pub fn apply_edits(
    pkg: &mut OpcPackage,
    main_part: &str,
    bindings: &DocxBindings,
    edits: &EditSet,
) -> Result<Vec<String>, OoxmlError> {
    apply_edits_with(pkg, main_part, bindings, edits, &[])
}

/// [`apply_edits`] plus `atoms`: note references, fields and bookmarks put
/// into body paragraphs ([`AtomInsert`], doc ADRs 611/612), patched in the
/// same pass. An atom aimed at a run another edit rewrites is refused.
pub fn apply_edits_with(
    pkg: &mut OpcPackage,
    main_part: &str,
    bindings: &DocxBindings,
    edits: &EditSet,
    atoms: &[AtomInsert],
) -> Result<Vec<String>, OoxmlError> {
    let mut skips: Vec<String> = Vec::new();
    let mut targets: Vec<ResolvedTarget> = Vec::new();
    let locks = Locks::of(bindings, edits);
    for e in &edits.runs {
        if let Some(why) = locks.run(e.block, e.run) {
            skips.push(format!(
                "run edit skipped: block {} run {} {why}",
                e.block, e.run
            ));
            continue;
        }
        let Some(addr) = bindings.resolve(e.block, e.run) else {
            skips.push(format!(
                "run edit skipped: block {} run {} is not patchable",
                e.block, e.run
            ));
            continue;
        };
        if e.new_text.is_none() && e.new_props.is_none() {
            continue;
        }
        let (new_rpr, rpr_merge) =
            resolve_look(e.new_props.as_ref(), e.rstyle.as_ref(), e.base.as_ref());
        targets.push(ResolvedTarget {
            para_ord: addr.para_ord,
            run_ord: addr.run_ord,
            wrapper: addr.wrapper,
            new_text: e.new_text.clone(),
            new_rpr,
            delete: false,
            insert_after: Vec::new(),
            label: format!("run edit skipped: block {} run {}", e.block, e.run),
            rpr_merge,
            split: Vec::new(),
            inside_at: None,
            between: Vec::new(),
        });
    }

    // Increment 2 — structural ops. All coordinates address the BASELINE, so
    // ops never shift each other's addresses; the patcher applies them in one
    // pass over the unmodified source.
    let mut paras: BTreeMap<u32, ResolvedParaTarget> = BTreeMap::new();
    let mut rows: BTreeMap<(u32, u32), ResolvedRowTarget> = BTreeMap::new();
    // At most ONE column action per table per save (they shift each other's
    // indices, so a second would need re-resolution against the patched grid).
    let mut columns: BTreeMap<u32, ColumnAction> = BTreeMap::new();
    // Cell paragraph actions, keyed by `(table_ord, row, cell, para)`.
    let mut cell_paras: BTreeMap<(u32, u32, u32, u32), CellParaAction> = BTreeMap::new();
    let cell_key = |p: docx_core::CellPath| (p.table_ord, p.row, p.cell, p.para);
    // Cell runs to split, resolved with the cell run edits below.
    #[allow(clippy::type_complexity)]
    let mut cell_splits: Vec<(usize, usize, usize, usize, RunFormat, Vec<RunPiece>)> = Vec::new();
    for s in &edits.structural {
        match s {
            StructuralEdit::DeleteCellParagraph { block, cell, para } => {
                if let Some(why) =
                    bindings.cell_paragraph_refusal(*block, *cell, *para, ParaUse::Delete)
                {
                    skips.push(format!(
                        "delete-cell-paragraph skipped: block {block} cell {cell} paragraph {para} {why}"
                    ));
                    continue;
                }
                let Some(path) = bindings.cell_para_path(*block, *cell, *para) else {
                    skips.push(format!(
                        "delete-cell-paragraph skipped: block {block} cell {cell} paragraph {para} is not a resolvable cell paragraph"
                    ));
                    continue;
                };
                cell_paras.entry(cell_key(path)).or_default().delete = true;
            }
            StructuralEdit::CloneCellParagraph {
                block,
                cell,
                para,
                before,
                text,
                base,
                pieces,
                new_ppr,
            } => {
                if let Some(why) =
                    bindings.cell_paragraph_refusal(*block, *cell, *para, ParaUse::Address)
                {
                    skips.push(format!(
                        "clone-cell-paragraph skipped: block {block} cell {cell} paragraph {para} {why}"
                    ));
                    continue;
                }
                let Some(path) = bindings.cell_para_path(*block, *cell, *para) else {
                    skips.push(format!(
                        "clone-cell-paragraph skipped: block {block} cell {cell} paragraph {para} is not a resolvable cell paragraph"
                    ));
                    continue;
                };
                let src = pkg.require(main_part)?;
                let ppr = new_ppr
                    .as_ref()
                    .map(|(props, style)| rpr::render_ppr(props, style.as_deref()));
                let Some(frag) = splice::clone_cell_paragraph(
                    src,
                    path,
                    text,
                    !*before,
                    base.as_ref(),
                    pieces,
                    ppr.as_deref(),
                ) else {
                    skips.push(format!(
                        "clone-cell-paragraph skipped: block {block} cell {cell} paragraph {para} is not in the document part"
                    ));
                    continue;
                };
                let action = cell_paras.entry(cell_key(path)).or_default();
                if *before {
                    action.insert_before.push(frag);
                } else {
                    action.insert_after.push(frag);
                }
            }
            StructuralEdit::InsertCellRun {
                block,
                cell,
                para,
                text,
            } => {
                if let Some(why) = locks.cell_para(*block, *cell, *para).or_else(|| {
                    bindings.cell_paragraph_refusal(*block, *cell, *para, ParaUse::Address)
                }) {
                    skips.push(format!(
                        "insert-cell-run skipped: block {block} cell {cell} paragraph {para} {why}"
                    ));
                    continue;
                }
                let Some(path) = bindings.cell_para_path(*block, *cell, *para) else {
                    skips.push(format!(
                        "insert-cell-run skipped: block {block} cell {cell} paragraph {para} is not a resolvable cell paragraph"
                    ));
                    continue;
                };
                cell_paras
                    .entry(cell_key(path))
                    .or_default()
                    .append_runs
                    .push(rpr::render_run(text, &docx_core::RunProps::default(), None));
            }
            StructuralEdit::SplitRun {
                block,
                run,
                base,
                pieces,
            } => {
                if let Some(why) = locks.run(*block, *run) {
                    skips.push(format!("run split skipped: block {block} run {run} {why}"));
                    continue;
                }
                let Some(a) = bindings.resolve(*block, *run) else {
                    skips.push(format!(
                        "run split skipped: block {block} run {run} is not patchable"
                    ));
                    continue;
                };
                let mut t = ResolvedTarget::edit(a.para_ord, a.run_ord);
                t.wrapper = a.wrapper;
                t.label = format!("run split skipped: block {block} run {run}");
                t.split = split_pieces(base, pieces);
                targets.push(t);
            }
            StructuralEdit::SplitCellRun {
                block,
                cell,
                para,
                run,
                base,
                pieces,
            } => {
                cell_splits.push((*block, *cell, *para, *run, base.clone(), pieces.clone()));
            }
            StructuralEdit::DeleteRun { block, run } => {
                if let Some(why) = locks.run(*block, *run) {
                    skips.push(format!("delete-run skipped: block {block} run {run} {why}"));
                    continue;
                }
                let Some(a) = bindings.resolve(*block, *run) else {
                    skips.push(format!(
                        "delete-run skipped: block {block} run {run} is not patchable"
                    ));
                    continue;
                };
                match targets.iter_mut().find(|t| {
                    t.para_ord == a.para_ord && t.run_ord == a.run_ord && t.wrapper == a.wrapper
                }) {
                    Some(t) => t.delete = true,
                    None => {
                        let mut t = ResolvedTarget::edit(a.para_ord, a.run_ord);
                        t.wrapper = a.wrapper;
                        t.delete = true;
                        targets.push(t);
                    }
                }
            }
            StructuralEdit::InsertRun {
                block,
                run,
                text,
                props,
                rstyle,
            } => {
                let frag = rpr::render_run(text, props, rstyle.as_deref());
                match run {
                    // After an existing run.
                    Some(run) => {
                        if let Some(why) = locks.run(*block, *run) {
                            skips
                                .push(format!("insert-run skipped: block {block} run {run} {why}"));
                            continue;
                        }
                        let Some(a) = bindings.resolve(*block, *run) else {
                            skips.push(format!(
                                "insert-run skipped: block {block} run {run} is not patchable"
                            ));
                            continue;
                        };
                        match targets.iter_mut().find(|t| {
                            t.para_ord == a.para_ord
                                && t.run_ord == a.run_ord
                                && t.wrapper == a.wrapper
                        }) {
                            Some(t) => t.insert_after.push(frag),
                            None => {
                                let mut t = ResolvedTarget::edit(a.para_ord, a.run_ord);
                                t.wrapper = a.wrapper;
                                t.insert_after.push(frag);
                                targets.push(t);
                            }
                        }
                    }
                    // At the paragraph's start.
                    None => {
                        if let Some(why) = locks
                            .paragraph(*block)
                            .or_else(|| bindings.paragraph_refusal(*block, ParaUse::Address))
                        {
                            skips.push(format!("insert-run skipped: block {block} {why}"));
                            continue;
                        }
                        let Some(p) = bindings.para_ord(*block) else {
                            skips.push(format!(
                                "insert-run skipped: block {block} is not a body paragraph"
                            ));
                            continue;
                        };
                        paras.entry(p).or_default().prepend_runs.push(frag);
                    }
                }
            }
            // Column ops require a UNIFORM grid (no gridSpan) — otherwise
            // whether a new column widens a span or splits it is ambiguous, so
            // the op is skipped rather than corrupting the table.
            StructuralEdit::DeleteColumn { block, col } => {
                if let Some(why) = bindings.table_refusal(*block) {
                    skips.push(format!(
                        "delete-column skipped: table at block {block} {why}"
                    ));
                    continue;
                }
                let Some(t) = bindings.uniform_table_ord(*block) else {
                    skips.push(format!(
                        "delete-column skipped: table at block {block} has a gridSpan \
                         (non-uniform grid — widen-vs-split is ambiguous)"
                    ));
                    continue;
                };
                columns.insert(t, ColumnAction::Delete { col: *col });
            }
            StructuralEdit::InsertColumn {
                block,
                after_col,
                text,
            } => {
                if let Some(why) = bindings.table_refusal(*block) {
                    skips.push(format!(
                        "insert-column skipped: table at block {block} {why}"
                    ));
                    continue;
                }
                let Some(t) = bindings.uniform_table_ord(*block) else {
                    skips.push(format!(
                        "insert-column skipped: table at block {block} has a gridSpan \
                         (non-uniform grid — widen-vs-split is ambiguous)"
                    ));
                    continue;
                };
                columns.insert(
                    t,
                    ColumnAction::Insert {
                        after_col: *after_col,
                        text: text.clone(),
                    },
                );
            }
            StructuralEdit::DeleteRow { block, row } => {
                if let Some(why) = bindings.table_refusal(*block) {
                    skips.push(format!("delete-row skipped: table at block {block} {why}"));
                    continue;
                }
                let Some(t) = bindings.table_ord(*block) else {
                    skips.push(format!(
                        "delete-row skipped: block {block} row {row} is not a resolvable table"
                    ));
                    continue;
                };
                rows.entry((t, *row)).or_default().delete = true;
            }
            StructuralEdit::InsertRow {
                block,
                after_row,
                cells,
                before,
            } => {
                if let Some(why) = bindings.table_refusal(*block) {
                    skips.push(format!("insert-row skipped: table at block {block} {why}"));
                    continue;
                }
                let Some(t) = bindings.table_ord(*block) else {
                    skips.push(format!(
                        "insert-row skipped: block {block} is not a resolvable table"
                    ));
                    continue;
                };
                let row = rows.entry((t, *after_row)).or_default();
                let frag = rpr::render_table_row(cells);
                if *before {
                    row.insert_before.push(frag);
                } else {
                    row.insert_after.push(frag);
                }
            }
            StructuralEdit::DeleteParagraph { block } => {
                if let Some(why) = bindings.paragraph_refusal(*block, ParaUse::Delete) {
                    skips.push(format!("delete-paragraph skipped: block {block} {why}"));
                    continue;
                }
                let Some(p) = bindings.para_ord(*block) else {
                    skips.push(format!(
                        "delete-paragraph skipped: block {block} is not a body paragraph"
                    ));
                    continue;
                };
                paras.entry(p).or_default().delete = true;
            }
            StructuralEdit::CloneParagraph {
                source,
                after,
                text,
            } => {
                if let Some(why) = bindings
                    .paragraph_refusal(*source, ParaUse::Address)
                    .or_else(|| bindings.paragraph_refusal(*after, ParaUse::Address))
                {
                    skips.push(format!(
                        "clone-paragraph skipped: block {source} or {after} {why}"
                    ));
                    continue;
                }
                let (Some(from), Some(at)) =
                    (bindings.para_ord(*source), bindings.para_ord(*after))
                else {
                    skips.push(format!(
                        "clone-paragraph skipped: block {source} or {after} is not a body paragraph"
                    ));
                    continue;
                };
                let src = pkg.require(main_part)?;
                match splice::clone_paragraph(src, from, text) {
                    Some(frag) => paras.entry(at).or_default().insert_after.push(frag),
                    None => skips.push(format!(
                        "clone-paragraph skipped: block {source} cannot be copied (it ends a section)"
                    )),
                }
            }
            StructuralEdit::InsertParagraph {
                block,
                text,
                props,
                para_style,
                rstyle,
            } => {
                if let Some(why) = bindings.paragraph_refusal(*block, ParaUse::Address) {
                    skips.push(format!("insert-paragraph skipped: block {block} {why}"));
                    continue;
                }
                let Some(p) = bindings.para_ord(*block) else {
                    skips.push(format!(
                        "insert-paragraph skipped: block {block} is not a body paragraph"
                    ));
                    continue;
                };
                let frag =
                    rpr::render_paragraph(text, props, rstyle.as_deref(), para_style.as_deref());
                paras.entry(p).or_default().insert_after.push(frag);
            }
        }
    }

    // Increment 3 — paragraph `<w:pPr>` edits.
    for pe in &edits.paragraphs {
        if let Some(why) = bindings.paragraph_refusal(pe.block, ParaUse::Format) {
            skips.push(format!(
                "paragraph-format edit skipped: block {} {why}",
                pe.block
            ));
            continue;
        }
        let Some(p) = bindings.para_ord(pe.block) else {
            skips.push(format!(
                "paragraph-format edit skipped: block {} is a table or out of range",
                pe.block
            ));
            continue;
        };
        let pstyle = pe.pstyle.as_ref().and_then(|o| o.as_deref());
        paras.entry(p).or_default().new_ppr = Some(rpr::render_ppr(&pe.new_props, pstyle));
    }

    // Table-cell run edits — their own `w:tbl`/`w:tr`/`w:tc`/`w:p` locator path.
    let mut cell_targets: Vec<ResolvedCellTarget> = Vec::new();
    for c in &edits.cells {
        if let Some(why) = locks.cell_run(c.block, c.cell, c.para, c.run) {
            skips.push(format!(
                "cell edit skipped: block {} cell {} para {} run {} {why}",
                c.block, c.cell, c.para, c.run
            ));
            continue;
        }
        let Some((path, run_ord, wrapper)) = bindings.resolve_cell(c.block, c.cell, c.para, c.run)
        else {
            skips.push(format!(
                "cell edit skipped: block {} cell {} para {} run {} is not patchable",
                c.block, c.cell, c.para, c.run
            ));
            continue;
        };
        if c.new_text.is_none() && c.new_props.is_none() && !c.delete {
            continue;
        }
        let (new_rpr, rpr_merge) =
            resolve_look(c.new_props.as_ref(), c.rstyle.as_ref(), c.base.as_ref());
        cell_targets.push(ResolvedCellTarget {
            table_ord: path.table_ord,
            row: path.row,
            cell: path.cell,
            para: path.para,
            run_ord,
            wrapper,
            new_text: c.new_text.clone(),
            new_rpr,
            label: format!(
                "cell edit skipped: block {} cell {} para {} run {}",
                c.block, c.cell, c.para, c.run
            ),
            rpr_merge,
            split: Vec::new(),
            delete: c.delete,
        });
    }
    for (block, cell, para, run, base, pieces) in &cell_splits {
        if let Some(why) = locks.cell_run(*block, *cell, *para, *run) {
            skips.push(format!(
                "cell run split skipped: block {block} cell {cell} para {para} run {run} {why}"
            ));
            continue;
        }
        let Some((path, run_ord, wrapper)) = bindings.resolve_cell(*block, *cell, *para, *run)
        else {
            skips.push(format!(
                "cell run split skipped: block {block} cell {cell} para {para} run {run} is not patchable"
            ));
            continue;
        };
        cell_targets.push(ResolvedCellTarget {
            table_ord: path.table_ord,
            row: path.row,
            cell: path.cell,
            para: path.para,
            run_ord,
            wrapper,
            new_text: None,
            new_rpr: None,
            label: format!(
                "cell run split skipped: block {block} cell {cell} para {para} run {run}"
            ),
            rpr_merge: None,
            split: split_pieces(base, pieces),
            delete: false,
        });
    }

    // Doc ADRs 611/612 — note references, fields and bookmarks put into
    // body paragraphs, grouped by the run they go into.
    let mut groups: BTreeMap<(usize, Option<usize>), Vec<&AtomInsert>> = BTreeMap::new();
    for a in atoms {
        groups.entry((a.block, a.run)).or_default().push(a);
    }
    for ((block, run), mut group) in groups {
        let label = format!("insertion skipped: block {block}");
        let Some(run) = run else {
            if let Some(why) = locks
                .paragraph(block)
                .or_else(|| bindings.paragraph_refusal(block, ParaUse::Address))
            {
                skips.push(format!("{label} {why}"));
                continue;
            }
            let Some(p) = bindings.para_ord(block) else {
                skips.push(format!("{label} is not a body paragraph"));
                continue;
            };
            let frags = group.iter().map(|a| a.xml.as_bytes().to_vec());
            let entry = paras.entry(p).or_default();
            entry.prepend_runs.extend(frags);
            continue;
        };
        if let Some(why) = locks.run(block, run) {
            skips.push(format!("{label} run {run} {why}"));
            continue;
        }
        let Some(a) = bindings.resolve(block, run) else {
            skips.push(format!("{label} run {run} is not patchable"));
            continue;
        };
        if targets
            .iter()
            .any(|t| t.para_ord == a.para_ord && t.run_ord == a.run_ord && t.wrapper == a.wrapper)
        {
            skips.push(format!(
                "{label} run {run}: the run's text was edited too; save the insertion on its own"
            ));
            continue;
        }
        group.sort_by_key(|g| g.before.chars().count());
        let mut t = ResolvedTarget::edit(a.para_ord, a.run_ord);
        t.wrapper = a.wrapper;
        t.label = format!("{label} run {run}");
        let full = format!("{}{}", group[0].before, group[0].after);
        let total = full.chars().count();
        let mut cut = 0usize;
        let chars: Vec<char> = full.chars().collect();
        for g in &group {
            let at = g.before.chars().count().min(total);
            if at >= total {
                t.insert_after.push(g.xml.as_bytes().to_vec());
                continue;
            }
            if at > cut || t.split.is_empty() {
                t.split.push(splice::SplitPiece {
                    text: chars[cut..at].iter().collect(),
                    rpr_merge: None,
                });
                cut = at;
            }
            t.between
                .push((t.split.len() - 1, g.xml.as_bytes().to_vec()));
        }
        if !t.split.is_empty() {
            t.split.push(splice::SplitPiece {
                text: chars[cut..].iter().collect(),
                rpr_merge: None,
            });
        }
        targets.push(t);
    }

    if targets.is_empty()
        && paras.is_empty()
        && cell_targets.is_empty()
        && rows.is_empty()
        && columns.is_empty()
        && cell_paras.is_empty()
    {
        return Ok(skips);
    }

    let (patched, refused) = {
        let src = pkg.require(main_part)?;
        patch_document_xml_cols(
            src,
            &targets,
            &paras,
            &cell_targets,
            &rows,
            &columns,
            &cell_paras,
        )
    };
    skips.extend(refused);
    // Every edit refused: the part is untouched, so keep it lazy-verbatim.
    if patched.as_slice() != pkg.require(main_part)? {
        pkg.set_part(main_part, patched);
    }
    Ok(skips)
}

/// Write `plan` into the styles part `styles_part` of `pkg` (doc ADR 610):
/// modified Word styles spliced in place, created ones appended. Answers
/// what could not be written. Without a styles part, or with nothing to
/// write, the package is untouched.
pub fn apply_style_plan(
    pkg: &mut OpcPackage,
    styles_part: Option<&str>,
    plan: &StylePlan,
) -> Result<Vec<String>, OoxmlError> {
    if plan.is_empty() {
        return Ok(Vec::new());
    }
    let Some(part) = styles_part else {
        return Ok(vec![
            "the document has no styles part: style changes are not saved".into(),
        ]);
    };
    let (patched, skips) = splice_styles(pkg.require(part)?, plan);
    if patched.as_slice() != pkg.require(part)? {
        pkg.set_part(part, patched);
    }
    Ok(skips)
}

/// The paragraphs an edit reaches a locked run in (a run inside a tracked
/// change or a content control). Every run-level edit of such a paragraph
/// is refused, not only the one on the locked run: the canvas text is one
/// edit, and applying part of it would leave Word's paragraph saying
/// something neither the source nor the canvas says.
struct Locks<'b> {
    bindings: &'b DocxBindings,
    blocks: std::collections::BTreeMap<usize, RunLock>,
    cell_paras: std::collections::BTreeMap<(usize, usize, usize), RunLock>,
}

impl<'b> Locks<'b> {
    fn of(bindings: &'b DocxBindings, edits: &EditSet) -> Self {
        let mut blocks = std::collections::BTreeMap::new();
        let mut cell_paras = std::collections::BTreeMap::new();
        let mut body = |block: usize, run: usize| {
            if let Some(lock) = bindings.run_lock(block, run) {
                blocks.entry(block).or_insert(lock);
            }
        };
        for e in &edits.runs {
            body(e.block, e.run);
        }
        for s in &edits.structural {
            match s {
                StructuralEdit::DeleteRun { block, run }
                | StructuralEdit::SplitRun { block, run, .. }
                | StructuralEdit::InsertRun {
                    block,
                    run: Some(run),
                    ..
                } => body(*block, *run),
                StructuralEdit::SplitCellRun {
                    block,
                    cell,
                    para,
                    run,
                    ..
                } => {
                    if let Some(lock) = bindings.cell_run_lock(*block, *cell, *para, *run) {
                        cell_paras.entry((*block, *cell, *para)).or_insert(lock);
                    }
                }
                _ => {}
            }
        }
        for c in &edits.cells {
            if let Some(lock) = bindings.cell_run_lock(c.block, c.cell, c.para, c.run) {
                cell_paras.entry((c.block, c.cell, c.para)).or_insert(lock);
            }
        }
        Locks {
            bindings,
            blocks,
            cell_paras,
        }
    }

    /// Why a run-level edit of body run `(block, run)` is refused.
    fn run(&self, block: usize, run: usize) -> Option<String> {
        if let Some(lock) = self.bindings.run_lock(block, run) {
            return Some(format!("is {}", lock.describe()));
        }
        self.paragraph(block).map(str::to_string)
    }

    /// Why any run-level edit of body block `block` is refused.
    fn paragraph(&self, block: usize) -> Option<&'static str> {
        self.blocks.get(&block).map(|_| {
            "is kept as it was: the edit of its paragraph reaches text inside a tracked \
             change or a content control"
        })
    }

    fn cell_run(&self, block: usize, cell: usize, para: usize, run: usize) -> Option<String> {
        if let Some(lock) = self.bindings.cell_run_lock(block, cell, para, run) {
            return Some(format!("is {}", lock.describe()));
        }
        self.cell_para(block, cell, para).map(str::to_string)
    }

    fn cell_para(&self, block: usize, cell: usize, para: usize) -> Option<&'static str> {
        self.cell_paras.get(&(block, cell, para)).map(|_| {
            "is kept as it was: the edit of its paragraph reaches text inside a tracked \
             change or a content control"
        })
    }
}

/// How a run edit's new look is written: merged into the run's own
/// `<w:rPr>` when its old look is known (`base`), else as a whole new
/// `<w:rPr>` (`Some(Some(id))` sets a real Word rStyle; anything else
/// omits it — a whole-`rPr` replacement cannot keep an old rStyle, so the
/// differ passes it explicitly).
#[allow(clippy::type_complexity)]
fn resolve_look(
    props: Option<&docx_core::RunProps>,
    rstyle: Option<&Option<String>>,
    base: Option<&RunFormat>,
) -> (Option<Vec<u8>>, Option<(RunFormat, RunFormat)>) {
    let Some(props) = props else {
        return (None, None);
    };
    let rstyle = rstyle.and_then(|o| o.as_deref());
    match base {
        Some(base) => (
            None,
            Some((
                base.clone(),
                RunFormat {
                    props: props.clone(),
                    rstyle: rstyle.map(str::to_string),
                },
            )),
        ),
        None => (Some(rpr::render_rpr(props, rstyle)), None),
    }
}

/// A split's pieces for the patcher: a piece in the run's own look keeps
/// its `<w:rPr>`; another has what differs from `base` merged into it.
fn split_pieces(base: &RunFormat, pieces: &[RunPiece]) -> Vec<splice::SplitPiece> {
    pieces
        .iter()
        .map(|p| splice::SplitPiece {
            text: p.text.clone(),
            rpr_merge: p
                .format
                .as_ref()
                .filter(|f| *f != base)
                .map(|f| (base.clone(), f.clone())),
        })
        .collect()
}
