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

//! The DOC-03 read → edited-`LoweredDoc` mapper. The host's structured read
//! (`host.document.storyContent`, core wire `StoryContent`) hands back the EDITED
//! story as paragraphs → runs → text + applied styles. Because paged.doc created
//! every style via `applyStyle`, a run's `characterStyle` IS the plugin's own
//! `char_style_id` token — so the read overlays cleanly onto the import baseline,
//! yielding the "edited" lowering that `diff` compares against the baseline.
//!
//! Isolation-clean: this mirrors the core wire shape as a plugin-local type
//! (deserialized from the JSON the bundle forwards) — no core dependency.

use docx_lower::ir::{
    LoweredBlock, LoweredDoc, LoweredParagraph, LoweredRun, LoweredStyle, PropValue,
    StyleCollection, StyleProp,
};

use crate::diff::{Align, EDIT_STYLE_PREFIX};
use serde::{Deserialize, Serialize};

/// Plugin-local twin of the core `StoryContent` wire struct (camelCase JSON).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoryContentIn {
    pub self_id: String,
    pub paragraphs: Vec<ParagraphContentIn>,
}

/// One read-back paragraph.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParagraphContentIn {
    #[serde(default)]
    pub paragraph_style: Option<String>,
    pub runs: Vec<RunContentIn>,
}

/// One read-back run: its text, its applied character style, and the
/// direct character formatting the canvas gave it (each `None` = none). A
/// run with direct formatting overlays as an edit style over its character
/// style ([`run_token`]); `tracking` becomes Word's character spacing at
/// the run's size (`w:spacing`).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunContentIn {
    pub text: String,
    #[serde(default)]
    pub character_style: Option<String>,
    #[serde(default)]
    pub font: Option<String>,
    #[serde(default)]
    pub font_style: Option<String>,
    #[serde(default)]
    pub point_size: Option<f32>,
    #[serde(default)]
    pub fill_color: Option<String>,
    #[serde(default)]
    pub underline: Option<bool>,
    #[serde(default)]
    pub strikethru: Option<bool>,
    #[serde(default)]
    pub capitalization: Option<String>,
    #[serde(default)]
    pub baseline_shift: Option<f32>,
    #[serde(default)]
    pub position: Option<String>,
    #[serde(default)]
    pub tracking: Option<f32>,
    /// The Word field this run is the result of, as the engine reads it
    /// back (engine ADR 1022): its instruction.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub field_code: Option<String>,
    /// Doc ADR 620 — the run's own script slots and direction, as the
    /// engine reads them back (engine ADR 1051).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub script: Option<RunScriptIn>,
    /// Doc ADR 614 — the content control the run is content of, as the
    /// engine reads it back (engine ADR 1052).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub control: Option<ControlIn>,
}

/// Doc ADR 620 — a read-back run's script properties (the engine's
/// `RunScriptContent`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunScriptIn {
    #[serde(default)]
    pub direction: Option<String>,
    #[serde(default)]
    pub east_asian_font: Option<String>,
    #[serde(default)]
    pub complex_font: Option<String>,
    #[serde(default)]
    pub complex_point_size: Option<f32>,
    #[serde(default)]
    pub complex_bold: Option<bool>,
    #[serde(default)]
    pub complex_italic: Option<bool>,
    #[serde(default)]
    pub complex: Option<bool>,
    #[serde(default)]
    pub hint: Option<String>,
}

/// Doc ADR 614 — a read-back content control (the engine's
/// `ContentControlContent`): what save-back writes into its `w:sdt`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlIn {
    pub id: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub showing_placeholder: bool,
    #[serde(default)]
    pub checked: Option<bool>,
    #[serde(default)]
    pub value: Option<String>,
}

impl RunContentIn {
    /// The run's direct formatting as engine style properties (the paths
    /// `docx-lower` writes a synthesized character style with).
    pub(crate) fn overrides(&self) -> Vec<StyleProp> {
        let mut out = Vec::new();
        let mut push = |path: &str, value: PropValue| {
            out.push(StyleProp {
                path: path.to_string(),
                value,
            })
        };
        if let Some(f) = &self.font {
            push("characterFontFamily", PropValue::Text(f.clone()));
        }
        if let Some(f) = &self.font_style {
            push("characterFontStyle", PropValue::Text(f.clone()));
        }
        if let Some(pt) = self.point_size {
            push("characterFontSize", PropValue::Length(pt));
        }
        if let Some(c) = &self.fill_color {
            push("characterFillColor", PropValue::ColorRef(c.clone()));
        }
        if let Some(u) = self.underline {
            push("characterUnderline", PropValue::Bool(u));
        }
        if let Some(st) = self.strikethru {
            push("characterStrikethru", PropValue::Bool(st));
        }
        if let Some(c) = &self.capitalization {
            push("characterCase", PropValue::Text(c.clone()));
        }
        if let Some(b) = self.baseline_shift {
            push("characterBaselineShift", PropValue::Length(b));
        }
        if let Some(p) = &self.position {
            push("characterPosition", PropValue::Text(p.clone()));
        }
        if let Some(t) = self.tracking {
            push("characterTracking", PropValue::Length(t));
        }
        if let Some(s) = &self.script {
            let text = |v: &Option<String>| v.clone().map(PropValue::Text);
            for (path, value) in [
                ("characterEastAsianFont", text(&s.east_asian_font)),
                ("characterComplexFont", text(&s.complex_font)),
                (
                    "characterComplexFontSize",
                    s.complex_point_size.map(PropValue::Length),
                ),
                ("characterComplexBold", s.complex_bold.map(PropValue::Bool)),
                (
                    "characterComplexItalic",
                    s.complex_italic.map(PropValue::Bool),
                ),
                ("characterComplexScript", s.complex.map(PropValue::Bool)),
                ("characterDirection", text(&s.direction)),
                ("characterFontHint", text(&s.hint)),
            ] {
                if let Some(v) = value {
                    push(path, v);
                }
            }
        }
        out
    }
}

/// The lowered style token a read-back run overlays with: its character
/// style, or — when the canvas formatted it directly — an edit style
/// (`EDIT_STYLE_PREFIX`) based on that style and holding the overrides,
/// added to `styles` once per distinct (style, overrides). The differ
/// resolves it to the run's look with the overrides applied.
fn run_token(styles: &mut Vec<LoweredStyle>, r: &RunContentIn) -> Option<String> {
    let props = r.overrides();
    if props.is_empty() {
        return r.character_style.clone();
    }
    if let Some(s) = styles.iter().find(|s| {
        s.id.starts_with(EDIT_STYLE_PREFIX) && s.based_on == r.character_style && s.props == props
    }) {
        return Some(s.id.clone());
    }
    let n = styles
        .iter()
        .filter(|s| s.id.starts_with(EDIT_STYLE_PREFIX))
        .count();
    let id = format!("{EDIT_STYLE_PREFIX}{n}");
    styles.push(LoweredStyle {
        id: id.clone(),
        name: format!("docx-edit-{n}"),
        collection: StyleCollection::Character,
        based_on: r.character_style.clone(),
        props,
    });
    Some(id)
}

/// A paragraph's runs as read back, each with its token ([`run_token`]).
/// Where the count is the baseline's, the baseline runs keep their other
/// fields (a hyperlink target, a merge field).
fn overlay_runs(styles: &mut Vec<LoweredStyle>, runs: &mut Vec<LoweredRun>, read: &[RunContentIn]) {
    let tokens: Vec<Option<String>> = read.iter().map(|r| run_token(styles, r)).collect();
    if read.len() == runs.len() {
        for ((run, r), token) in runs.iter_mut().zip(read).zip(tokens) {
            run.text = r.text.clone();
            run.char_style_id = token;
            if let Some(code) = &r.field_code {
                run.field = Some(field_of(code));
            }
        }
    } else {
        *runs = read
            .iter()
            .zip(tokens)
            .map(|(r, token)| LoweredRun {
                text: r.text.clone(),
                char_style_id: token,
                field: r.field_code.as_deref().map(field_of),
                ..Default::default()
            })
            .collect();
    }
}

/// A read-back field instruction as the lowering's field.
fn field_of(code: &str) -> docx_lower::ir::LoweredField {
    docx_lower::ir::LoweredField {
        code: code.trim().to_string(),
        seq: 0,
    }
}

/// The read-back paragraphs one baseline paragraph poured as, folded back into
/// ONE (ADR 028/029): a page/column break inside a Word paragraph pours as
/// `1 + segments` native paragraphs. Where a break fell inside a baseline run,
/// that run came back as two (the end of one part, the start of the next) and
/// is joined again; empty runs of an empty part are dropped.
fn fold_segments(
    baseline: &docx_lower::ir::LoweredParagraph,
    parts: &[ParagraphContentIn],
) -> ParagraphContentIn {
    let mut runs: Vec<RunContentIn> = parts.first().map(|p| p.runs.clone()).unwrap_or_default();
    // Run boundaries in the baseline's contiguous char space.
    let mut bounds = vec![0u32];
    for r in &baseline.runs {
        bounds.push(bounds.last().copied().unwrap_or(0) + r.text.chars().count() as u32);
    }
    for (k, part) in parts.iter().enumerate().skip(1) {
        let at = baseline.segments.get(k - 1).map_or(0, |s| s.at);
        let splits_a_run = !bounds.contains(&at);
        let mut next = part.runs.iter().filter(|r| !r.text.is_empty()).cloned();
        if splits_a_run {
            if let (Some(last), Some(first)) = (runs.last_mut(), next.next()) {
                last.text.push_str(&first.text);
            }
        }
        runs.extend(next);
    }
    ParagraphContentIn {
        paragraph_style: parts.first().and_then(|p| p.paragraph_style.clone()),
        runs,
    }
}

/// Overlay the read-back story onto the import `baseline`, producing the EDITED
/// lowering. Structure-preserving: read-back paragraphs map 1:1 onto the
/// baseline's PARAGRAPH blocks in order (table blocks are skipped: the read-back
/// story holds no native table, its cells come through [`overlay_cells`]); a
/// paragraph's runs become the runs read back, a directly formatted run with
/// an edit style ([`run_token`]), and the differ maps them onto the Word runs.
///
/// This is the layout of documents poured before native tables took a
/// paragraph of their own: the paragraph after a table continued in the
/// table's paragraph, so a native table has no read-back paragraph. The
/// bundle's pour now gives each native table its own paragraph
/// ([`overlay_story_content_in`] with [`TableParagraphs::Own`]).
///
/// A paragraph takes the paragraph style read back when the lowering knows
/// it (a Word style, a style the lowering synthesized): the paragraph
/// style applied on the canvas is saved (ADR 610). A style the lowering does
/// not know (the engine's own default) leaves the paragraph's as it was;
/// [`overlay_story_content_with`] names the styles made in paged too.
pub fn overlay_story_content(baseline: &LoweredDoc, content: &StoryContentIn) -> LoweredDoc {
    overlay_story_content_with(baseline, content, TableParagraphs::Joined, &|_| false)
}

/// Where the native tables of a read-back story stand among its paragraphs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum TableParagraphs {
    /// Each native table is a paragraph of its own (holding only the table),
    /// between the paragraphs of the Word blocks around it: the pour's layout.
    Own,
    /// A native table has no paragraph of its own: the paragraph after it
    /// continued in the table's paragraph (documents poured before the
    /// tables took their own; the default when the bundle does not say).
    #[default]
    Joined,
}

/// [`overlay_story_content`] for a story whose native tables stand as
/// `tables` says: with [`TableParagraphs::Own`] each native table consumes
/// the one read-back paragraph that holds it.
pub fn overlay_story_content_in(
    baseline: &LoweredDoc,
    content: &StoryContentIn,
    tables: TableParagraphs,
) -> LoweredDoc {
    overlay_story_content_with(baseline, content, tables, &|_| false)
}

/// [`overlay_story_content`], with `created` answering for the paragraph
/// styles made in paged that save-back writes into `styles.xml`.
pub fn overlay_story_content_known(
    baseline: &LoweredDoc,
    content: &StoryContentIn,
    created: &dyn Fn(&str) -> bool,
) -> LoweredDoc {
    overlay_story_content_with(baseline, content, TableParagraphs::Joined, created)
}

/// The overlay with both choices: where native tables stand (`tables`) and
/// which paragraph styles were made in paged (`created`).
pub fn overlay_story_content_with(
    baseline: &LoweredDoc,
    content: &StoryContentIn,
    tables: TableParagraphs,
    created: &dyn Fn(&str) -> bool,
) -> LoweredDoc {
    let mut edited = baseline.clone();
    // The edit styles are gathered here while the blocks are borrowed.
    let mut styles = std::mem::take(&mut edited.styles);
    let mut ci = 0usize;
    for block in edited.story.blocks.iter_mut() {
        let p = match block {
            LoweredBlock::Paragraph(p) => p,
            LoweredBlock::Table(t) => {
                // A table that FLOWED as text is in the read-back
                // paragraphs: skip them (the Word table is left as it was).
                ci += t.flow.iter().map(|p| 1 + p.segments.len()).sum::<usize>();
                // A native table poured into a paragraph of its own: that
                // paragraph holds no Word text, skip it.
                if t.flow.is_empty() && tables == TableParagraphs::Own {
                    ci += 1;
                }
                continue;
            }
        };
        let parts = 1 + p.segments.len();
        if ci >= content.paragraphs.len() {
            break; // read-back ran out of paragraphs
        }
        let end = (ci + parts).min(content.paragraphs.len());
        let folded = fold_segments(p, &content.paragraphs[ci..end]);
        ci = end;
        if let Some(style) = folded
            .paragraph_style
            .as_deref()
            .filter(|t| known_para_style(&styles, t) || created(t))
        {
            if p.para_style_id.as_deref() != Some(style) {
                p.para_style_id = Some(style.to_string());
            }
        }
        // The run list as read back: the differ maps it onto the Word runs
        // character by character (text edits, runs the engine joined, a
        // run split by a new look, direct formatting).
        overlay_runs(&mut styles, &mut p.runs, &folded.runs);
    }
    edited.styles = styles;
    edited
}

/// Whether `token` is a paragraph style of the lowering (a Word style or
/// one it synthesized).
fn known_para_style(styles: &[LoweredStyle], token: &str) -> bool {
    styles
        .iter()
        .any(|s| s.collection == StyleCollection::Paragraph && s.id == token)
}

/// Give `edited` the swatches the canvas made that the import did not
/// (`colors`: swatch id → the RGB the host displays it in, `RRGGBB`, a
/// leading `#` allowed), so the differ resolves a run filled with one to
/// its `w:color` — any document swatch, CMYK, spot or Lab included, is
/// written as the hex it shows. A value that is not six hex digits is left
/// out (the run's colour is then not written).
///
/// A theme colour's swatch (doc ADR 609) the user edited shows another
/// colour now: it takes that colour, so its runs are written with the new
/// hex instead of the theme reference. A display within 2 of the import's
/// colour per channel is the same colour (colour management may round).
pub fn add_canvas_colors(
    edited: &mut LoweredDoc,
    colors: &std::collections::BTreeMap<String, String>,
) {
    for (id, hex) in colors {
        let hex = hex.trim_start_matches('#');
        if hex.len() != 6 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
            continue;
        }
        let channel = |i: usize| u8::from_str_radix(&hex[i..i + 2], 16).map(f32::from);
        let (Ok(r), Ok(g), Ok(b)) = (channel(0), channel(2), channel(4)) else {
            continue;
        };
        if let Some(sw) = edited.swatches.iter_mut().find(|s| &s.id == id) {
            let moved = sw.theme.is_some()
                && sw.value.len() >= 3
                && [r, g, b]
                    .iter()
                    .zip(&sw.value)
                    .any(|(new, old)| (new - old).abs() > 2.0);
            if moved {
                sw.value = vec![r, g, b];
            }
            continue;
        }
        edited.swatches.push(docx_lower::ir::LoweredSwatch {
            id: id.clone(),
            name: id.clone(),
            space: "RGB".into(),
            value: vec![r, g, b],
            theme: None,
        });
    }
}

/// One native table cell as the host reads it back: the table's `block` in
/// the lowered story, the `cell`'s index in its lowered cell list, and its
/// live text — its paragraphs joined by `\n`, as the engine reads a cell's
/// `text` (the read-back story holds no table, so cells come separately).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CellContentIn {
    pub block: usize,
    pub cell: usize,
    pub text: String,
    /// The cell's paragraphs with their runs and formatting, as the engine
    /// reads a cell's `paragraphs` (the story read's shape), when the host
    /// has that read. With it, runs split or joined and direct formatting
    /// in the cell are written back as they are in body paragraphs; without
    /// it only the text is (the run list kept).
    #[serde(default)]
    pub paragraphs: Option<Vec<ParagraphContentIn>>,
}

/// Overlay read-back table cells onto the `edited` lowering (the cell
/// patcher): each cell paragraph whose text changed keeps its run list, and
/// the changed span — what lies between the text the old and the new share
/// at the start and at the end — goes into the run it starts in; the runs it
/// covered further on lose their covered text. Run count and run properties
/// stay, so `diff` reports run text edits that patch the cell's `<w:t>`s in
/// place. A paragraph with no run that gains text gets one run.
///
/// A cell whose paragraph count changed on the canvas (paragraphs added or
/// removed) is aligned paragraph by paragraph by text
/// (`align_cell_paragraphs`, the alignment `diff` makes again): a kept
/// paragraph is patched as above, an added one is a copy of its neighbour —
/// the paragraph before it, or the one after it at the cell's start — with
/// one run carrying its text, and a removed one is dropped (never the cell's
/// last: Word requires it). `diff` turns these into cell paragraph clones
/// and deletes. With the cell's styled read (`paragraphs`), a kept
/// paragraph takes the runs read back instead, as a body paragraph does
/// ([`overlay_story_content`]), so runs split by a new look and direct
/// formatting are written too, and a paragraph added in the cell takes the
/// runs read back (its words' own looks over its neighbour's). A table poured as text, or a cell that is not in the
/// lowering, is left as it was and reported in the returned ledger.
pub fn overlay_cells(edited: &mut LoweredDoc, cells: &[CellContentIn]) -> Vec<String> {
    overlay_cells_known(edited, cells, &|_| false)
}

/// [`overlay_cells`], with `created` answering for the paragraph styles made
/// in paged: a paragraph added in a cell takes the paragraph style read back
/// when it is a style the lowering knows or one of these (ADR 610), not its
/// neighbour's.
pub fn overlay_cells_known(
    edited: &mut LoweredDoc,
    cells: &[CellContentIn],
    created: &dyn Fn(&str) -> bool,
) -> Vec<String> {
    let mut styles = std::mem::take(&mut edited.styles);
    let skips = overlay_cells_into(edited, &mut styles, cells, created);
    edited.styles = styles;
    skips
}

fn overlay_cells_into(
    edited: &mut LoweredDoc,
    styles: &mut Vec<LoweredStyle>,
    cells: &[CellContentIn],
    created: &dyn Fn(&str) -> bool,
) -> Vec<String> {
    let mut skips = Vec::new();
    for c in cells {
        let Some(LoweredBlock::Table(t)) = edited.story.blocks.get_mut(c.block) else {
            skips.push(format!(
                "block {}: no table to write the cell into",
                c.block
            ));
            continue;
        };
        if !t.flow.is_empty() {
            skips.push(format!(
                "block {}: a table poured as text keeps its Word cells",
                c.block
            ));
            continue;
        }
        let Some(cell) = t.cells.get_mut(c.cell) else {
            skips.push(format!("block {}: no cell {}", c.block, c.cell));
            continue;
        };
        // The styled read, when it agrees with the text read (an emptied
        // cell can read back with no paragraph at all: then the text read,
        // one empty paragraph, is the one to follow).
        let styled = c.paragraphs.as_ref().filter(|ps| {
            ps.len() == c.text.split('\n').count()
                && ps
                    .iter()
                    .map(|p| p.runs.iter().map(|r| r.text.as_str()).collect::<String>())
                    .collect::<Vec<_>>()
                    .join("\n")
                    == c.text
        });
        let texts: Vec<String> = c.text.split('\n').map(str::to_string).collect();
        if texts.len() != cell.paragraphs.len() {
            cell.paragraphs = restructure_cell(&cell.paragraphs, &texts, styled, styles, created);
            continue;
        }
        if let Some(read) = styled {
            for (p, rp) in cell.paragraphs.iter_mut().zip(read) {
                if !(p.runs.is_empty() && rp.runs.iter().all(|r| r.text.is_empty())) {
                    overlay_runs(styles, &mut p.runs, &rp.runs);
                }
            }
            continue;
        }
        for (k, (p, new)) in cell.paragraphs.iter_mut().zip(&texts).enumerate() {
            if let Err(why) = patch_paragraph(p, new) {
                skips.push(format!(
                    "block {} cell {} paragraph {k}: {why}",
                    c.block, c.cell
                ));
            }
        }
    }
    skips
}

/// A native table whose ROW count changed on the canvas (rows added or
/// removed), read back whole: each live row's cells' texts (a cell's
/// paragraphs joined by `\n`, as the engine reads a cell), in order.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableContentIn {
    pub block: usize,
    pub rows: Vec<Vec<String>>,
}

/// Overlay tables whose rows were added or removed on the canvas onto the
/// `edited` lowering. The live rows are aligned with the lowered rows by
/// their text, as the differ aligns them (`row_key`, `lcs_align`): a kept
/// row keeps its cells and takes the live texts (its runs patched, its
/// paragraphs aligned as a cell's are), an added row is a copy of the row
/// before it (or, above every kept row, of the first kept one) with the
/// live texts, and a removed row goes. The differ then writes the rows as
/// `InsertRow` / `DeleteRow` and the kept rows' cells as cell edits. A
/// table with merged cells, or whose column count changed, is left as it
/// was and reported: a merged cell spans rows the alignment would split,
/// and a column op needs the column's identity, which a row of texts does
/// not carry.
pub fn overlay_tables(edited: &mut LoweredDoc, tables: &[TableContentIn]) -> Vec<String> {
    let mut styles = std::mem::take(&mut edited.styles);
    let mut skips = Vec::new();
    for t in tables {
        let Some(LoweredBlock::Table(tb)) = edited.story.blocks.get_mut(t.block) else {
            skips.push(format!(
                "block {}: no table to write the rows into",
                t.block
            ));
            continue;
        };
        if !tb.flow.is_empty() {
            skips.push(format!(
                "block {}: a table poured as text keeps its Word rows",
                t.block
            ));
            continue;
        }
        if tb.cells.iter().any(|c| c.row_span > 1 || c.col_span > 1) {
            skips.push(format!(
                "block {}: rows added or removed in a table with merged cells are not saved; it keeps its Word rows",
                t.block
            ));
            continue;
        }
        if t.rows.iter().any(|r| r.len() != tb.cols as usize) {
            skips.push(format!(
                "block {}: columns added or removed on the canvas are not saved; the table keeps its Word columns",
                t.block
            ));
            continue;
        }
        let rows = crate::diff::rows_of(tb);
        let old: Vec<String> = rows.iter().map(|r| crate::diff::row_key(tb, r)).collect();
        // The differ's key: a cell's paragraphs' runs, joined without a
        // separator.
        let new: Vec<String> = t
            .rows
            .iter()
            .map(|r| {
                r.iter()
                    .map(|c| c.replace('\n', ""))
                    .collect::<Vec<_>>()
                    .join("\u{1f}")
            })
            .collect();
        let steps = crate::diff::lcs_align(&old, &new);
        let first_kept = steps.iter().find_map(|s| match s {
            Align::Match(b, _) => Some(*b),
            _ => None,
        });
        let heights = std::mem::take(&mut tb.row_heights_pt);
        let mut cells: Vec<docx_lower::ir::LoweredCell> = Vec::new();
        let mut new_heights: Vec<f32> = Vec::new();
        let mut anchor: Option<usize> = None;
        for step in steps {
            let (from, e, kept) = match step {
                Align::Match(b, e) => {
                    anchor = Some(b);
                    (b, e, true)
                }
                Align::Del(_) => continue,
                Align::Ins(e) => match anchor.or(first_kept) {
                    Some(b) => (b, e, false),
                    None => continue, // a table with no row to copy
                },
            };
            for &ci in &rows[from] {
                let mut cell = tb.cells[ci].clone();
                let text = &t.rows[e][cell.col as usize];
                let texts: Vec<String> = text.split('\n').map(str::to_string).collect();
                cell.row = e as u32;
                if kept {
                    if texts.len() == cell.paragraphs.len() {
                        for (p, new) in cell.paragraphs.iter_mut().zip(&texts) {
                            if let Err(why) = patch_paragraph(p, new) {
                                skips.push(format!(
                                    "block {} row {e} column {}: {why}",
                                    t.block, cell.col
                                ));
                            }
                        }
                    } else {
                        cell.paragraphs =
                            restructure_cell(&cell.paragraphs, &texts, None, &mut styles, &|_| {
                                false
                            });
                    }
                } else {
                    // A new row's cell: one paragraph per line, in the look
                    // of the copied cell's first paragraph and run.
                    let model = cell.paragraphs.first().cloned().unwrap_or_default();
                    let run_style = model.runs.first().and_then(|r| r.char_style_id.clone());
                    cell.paragraphs = texts
                        .iter()
                        .map(|line| LoweredParagraph {
                            para_style_id: model.para_style_id.clone(),
                            list: model.list,
                            source_index: model.source_index,
                            runs: if line.is_empty() {
                                Vec::new()
                            } else {
                                vec![LoweredRun {
                                    text: line.clone(),
                                    char_style_id: run_style.clone(),
                                    ..Default::default()
                                }]
                            },
                            ..Default::default()
                        })
                        .collect();
                }
                cells.push(cell);
            }
            if let Some(h) = heights.get(from) {
                new_heights.push(*h);
            }
        }
        cells.sort_by_key(|c| (c.row, c.col));
        tb.rows = t.rows.len() as u32;
        tb.cells = cells;
        if !heights.is_empty() {
            tb.row_heights_pt = new_heights;
        }
    }
    edited.styles = styles;
    skips
}

/// Patch `new` into one cell paragraph's runs ([`patch_runs`]); a paragraph
/// with no run that gains text gets one (`diff` adds it as a run).
fn patch_paragraph(p: &mut LoweredParagraph, new: &str) -> Result<(), String> {
    if p.runs.is_empty() && !new.is_empty() {
        p.runs.push(LoweredRun {
            text: new.to_string(),
            ..Default::default()
        });
        return Ok(());
    }
    patch_runs(&mut p.runs, new)
}

/// A cell's paragraphs once the read-back `texts` (a different count) are
/// aligned onto them — see [`overlay_cells`].
fn restructure_cell(
    paras: &[LoweredParagraph],
    texts: &[String],
    styled: Option<&Vec<ParagraphContentIn>>,
    styles: &mut Vec<LoweredStyle>,
    created: &dyn Fn(&str) -> bool,
) -> Vec<LoweredParagraph> {
    let old: Vec<String> = paras
        .iter()
        .map(|p| p.runs.iter().map(|r| r.text.as_str()).collect())
        .collect();
    let steps = crate::diff::align_cell_paragraphs(&old, texts);
    let first_match = steps.iter().find_map(|s| match s {
        Align::Match(b, _) => Some(*b),
        _ => None,
    });
    let mut out: Vec<LoweredParagraph> = Vec::with_capacity(texts.len());
    let mut anchor: Option<usize> = None;
    for step in steps {
        match step {
            Align::Match(b, e) => {
                anchor = Some(b);
                let mut p = paras[b].clone();
                match styled.and_then(|ps| ps.get(e)) {
                    // Its runs as read, formatting included.
                    Some(rp) if !p.runs.is_empty() => overlay_runs(styles, &mut p.runs, &rp.runs),
                    // A run-less paragraph gains its run; `patch_runs`
                    // cannot fail otherwise.
                    _ => {
                        let _ = patch_paragraph(&mut p, &texts[e]);
                    }
                }
                out.push(p);
            }
            Align::Del(_) => {}
            Align::Ins(e) => {
                let (from, last) = match (anchor, first_match) {
                    (Some(a), _) => (&paras[a], true),
                    (None, Some(f)) => (&paras[f], false),
                    (None, None) => continue,
                };
                let run = if last {
                    from.runs.last()
                } else {
                    from.runs.first()
                };
                let mut runs = vec![LoweredRun {
                    text: texts[e].clone(),
                    char_style_id: run.and_then(|r| r.char_style_id.clone()),
                    ..Default::default()
                }];
                // Its runs as read, formatting included: the differ writes
                // them as the copy's runs; and its own paragraph style, when
                // the canvas gave it one save-back can write.
                let mut para_style_id = from.para_style_id.clone();
                if let Some(rp) = styled.and_then(|ps| ps.get(e)) {
                    overlay_runs(styles, &mut runs, &rp.runs);
                    if let Some(t) = rp
                        .paragraph_style
                        .as_deref()
                        .filter(|t| known_para_style(styles, t) || created(t))
                    {
                        para_style_id = Some(t.to_string());
                    }
                }
                out.push(LoweredParagraph {
                    para_style_id,
                    list: from.list,
                    source_index: from.source_index,
                    runs,
                    ..Default::default()
                });
            }
        }
    }
    out
}

/// Rewrite `runs` so their texts concatenate to `new`, keeping the run list:
/// the span that differs from the old concatenation goes to the run it
/// starts in. Errors when there is no run to hold new text.
pub(crate) fn patch_runs(runs: &mut [LoweredRun], new: &str) -> Result<(), String> {
    let old: Vec<char> = runs.iter().flat_map(|r| r.text.chars()).collect();
    let next: Vec<char> = new.chars().collect();
    if old == next {
        return Ok(());
    }
    if runs.is_empty() {
        return Err("the Word paragraph has no run to hold the text".into());
    }
    let prefix = old.iter().zip(&next).take_while(|(a, b)| a == b).count();
    let max_suffix = old.len().min(next.len()) - prefix;
    let suffix = old
        .iter()
        .rev()
        .zip(next.iter().rev())
        .take(max_suffix)
        .take_while(|(a, b)| a == b)
        .count();
    let (cut_from, cut_to) = (prefix, old.len() - suffix);
    let insert: String = next[prefix..next.len() - suffix].iter().collect();
    // The run the change starts in: the one holding `cut_from`, or for an
    // insertion at a run boundary the run before it (it extends that run's
    // text, as typing at the end of a word does); at 0 the first run.
    let mut start = 0usize;
    let mut target = runs.len() - 1;
    for (i, r) in runs.iter().enumerate() {
        let len = r.text.chars().count();
        let end = start + len;
        if cut_from < end || (cut_from == end && cut_from == cut_to && len > 0) {
            target = i;
            break;
        }
        start = end;
    }
    let mut at = 0usize;
    for (i, r) in runs.iter_mut().enumerate() {
        let chars: Vec<char> = r.text.chars().collect();
        let (s, e) = (at, at + chars.len());
        at = e;
        // The run's own chars outside the cut span stay.
        let keep_head: String = chars[..cut_from.clamp(s, e) - s].iter().collect();
        let keep_tail: String = chars[cut_to.clamp(s, e) - s..].iter().collect();
        r.text = if i == target {
            format!("{keep_head}{insert}{keep_tail}")
        } else {
            format!("{keep_head}{keep_tail}")
        };
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn runs(texts: &[&str]) -> Vec<LoweredRun> {
        texts
            .iter()
            .map(|t| LoweredRun {
                text: (*t).to_string(),
                ..Default::default()
            })
            .collect()
    }

    fn texts(rs: &[LoweredRun]) -> Vec<&str> {
        rs.iter().map(|r| r.text.as_str()).collect()
    }

    #[test]
    fn a_change_inside_one_run_stays_in_it() {
        let mut rs = runs(&["Price ", "12.00", " EUR"]);
        patch_runs(&mut rs, "Price 14.50 EUR").unwrap();
        assert_eq!(texts(&rs), ["Price ", "14.50", " EUR"]);
    }

    #[test]
    fn typing_at_a_run_end_extends_that_run() {
        let mut rs = runs(&["Apple", " pie"]);
        patch_runs(&mut rs, "Apples pie").unwrap();
        assert_eq!(texts(&rs), ["Apples", " pie"]);
        let mut rs = runs(&["Apple"]);
        patch_runs(&mut rs, "Apple tart").unwrap();
        assert_eq!(texts(&rs), ["Apple tart"]);
    }

    #[test]
    fn a_change_across_runs_lands_in_the_first() {
        let mut rs = runs(&["one ", "two ", "three"]);
        patch_runs(&mut rs, "one 2 three").unwrap();
        assert_eq!(texts(&rs), ["one ", "2 ", "three"]);
        let mut rs = runs(&["ab", "cd"]);
        patch_runs(&mut rs, "aXd").unwrap();
        assert_eq!(texts(&rs), ["aX", "d"]);
        let mut rs = runs(&["ab", "cd"]);
        patch_runs(&mut rs, "").unwrap();
        assert_eq!(texts(&rs), ["", ""]);
    }

    #[test]
    fn an_empty_run_list_cannot_take_text() {
        let mut rs = runs(&[]);
        assert!(patch_runs(&mut rs, "x").is_err());
        assert!(patch_runs(&mut rs, "").is_ok());
    }

    fn para_doc(texts: &[&str]) -> LoweredDoc {
        let mut base = LoweredDoc::default();
        base.story
            .blocks
            .push(LoweredBlock::Paragraph(LoweredParagraph {
                runs: runs(texts),
                ..Default::default()
            }));
        base
    }

    fn read(runs: Vec<RunContentIn>) -> StoryContentIn {
        StoryContentIn {
            self_id: "s".into(),
            paragraphs: vec![ParagraphContentIn {
                paragraph_style: None,
                runs,
            }],
        }
    }

    fn plain(text: &str) -> RunContentIn {
        RunContentIn {
            text: text.into(),
            ..Default::default()
        }
    }

    fn bold(text: &str) -> RunContentIn {
        RunContentIn {
            text: text.into(),
            font_style: Some("Bold".into()),
            ..Default::default()
        }
    }

    fn edits(base: &LoweredDoc, content: &StoryContentIn) -> crate::EditSet {
        let edited = overlay_story_content(base, content);
        crate::diff(base, &edited, &crate::DocxBindings::default())
    }

    /// Word: "Before", a table, "After". The read-back story as each layout
    /// pours it, with "After" edited to "After all".
    #[test]
    fn a_native_table_takes_its_own_read_back_paragraph_in_the_own_layout() {
        use docx_lower::ir::{LoweredCell, LoweredTable};
        let mut base = para_doc(&["Before"]);
        base.story.blocks.push(LoweredBlock::Table(LoweredTable {
            rows: 1,
            cols: 1,
            cells: vec![LoweredCell::default()],
            ..Default::default()
        }));
        base.story
            .blocks
            .push(LoweredBlock::Paragraph(LoweredParagraph {
                runs: runs(&["After"]),
                ..Default::default()
            }));
        let story = |texts: &[&str]| StoryContentIn {
            self_id: "s".into(),
            paragraphs: texts
                .iter()
                .map(|t| ParagraphContentIn {
                    paragraph_style: None,
                    runs: vec![plain(t)],
                })
                .collect(),
        };
        let after = |edited: &LoweredDoc| match &edited.story.blocks[2] {
            LoweredBlock::Paragraph(p) => p.runs.iter().map(|r| r.text.clone()).collect::<String>(),
            LoweredBlock::Table(_) => unreachable!(),
        };
        // Own: the table's paragraph (empty) stands between the two.
        let own = overlay_story_content_in(
            &base,
            &story(&["Before", "", "After all"]),
            TableParagraphs::Own,
        );
        assert_eq!(after(&own), "After all");
        // Joined: "After" continued in the table's paragraph.
        let joined = overlay_story_content(&base, &story(&["Before", "After all"]));
        assert_eq!(after(&joined), "After all");
        // The own layout read as joined would put the table's empty
        // paragraph into "After": the layouts are not interchangeable.
        let wrong = overlay_story_content(&base, &story(&["Before", "", "After all"]));
        assert_eq!(after(&wrong), "");
    }

    #[test]
    fn runs_the_engine_joined_map_back_onto_their_word_runs() {
        let base = para_doc(&["Dear ", "«Name»"]);
        let same = edits(&base, &read(vec![plain("Dear «Name»")]));
        assert!(same.runs.is_empty() && same.structural.is_empty());
        let e = edits(&base, &read(vec![plain("Dear «Name»!")]));
        assert!(e.structural.is_empty());
        assert_eq!(e.runs.len(), 1);
        assert_eq!(e.runs[0].run, 1);
        assert_eq!(e.runs[0].new_text.as_deref(), Some("«Name»!"));
        assert!(e.runs[0].new_props.is_none());
    }

    #[test]
    fn a_word_made_bold_splits_its_run_and_leaves_the_others() {
        use crate::edit::{RunPiece, StructuralEdit};
        let base = para_doc(&["Intro. ", "Hello world!"]);
        let e = edits(
            &base,
            &read(vec![plain("Intro. Hello "), bold("world"), plain("!")]),
        );
        assert!(e.runs.is_empty(), "{:?}", e.runs);
        let [StructuralEdit::SplitRun {
            block: 0,
            run: 1,
            base: own,
            pieces,
        }] = e.structural.as_slice()
        else {
            panic!("one split of run 1: {:?}", e.structural)
        };
        assert_eq!(own.props, docx_core::RunProps::default());
        let bolded = crate::edit::RunFormat {
            props: docx_core::RunProps {
                bold: Some(true),
                ..Default::default()
            },
            rstyle: None,
        };
        assert_eq!(
            pieces,
            &[
                RunPiece {
                    text: "Hello ".into(),
                    format: None
                },
                RunPiece {
                    text: "world".into(),
                    format: Some(bolded.clone())
                },
                RunPiece {
                    text: "!".into(),
                    format: None
                },
            ]
        );
        // A whole run made bold is an edit of its look in place; typing
        // bold text right after it extends it.
        let e = edits(&base, &read(vec![plain("Intro. "), bold("Hello world!!")]));
        assert!(e.structural.is_empty());
        assert_eq!(e.runs.len(), 1);
        assert_eq!(e.runs[0].new_text.as_deref(), Some("Hello world!!"));
        assert_eq!(e.runs[0].new_props, Some(bolded.props.clone()));
        assert_eq!(e.runs[0].base, Some(crate::edit::RunFormat::default()));
    }

    #[test]
    fn typed_text_goes_to_the_run_whose_look_it_has() {
        use crate::edit::StructuralEdit;
        // Bold text typed between a plain and a bold run extends the bold
        // one at its start rather than splitting the plain one. The
        // baseline's second run is bold (an edit style's token).
        let base = overlay_story_content(
            &para_doc(&["Hello ", "world"]),
            &read(vec![plain("Hello "), bold("world")]),
        );
        let base2 = base.clone();
        let edited2 =
            overlay_story_content(&base2, &read(vec![plain("Hello "), bold("big world")]));
        let e = crate::diff(&base2, &edited2, &crate::DocxBindings::default());
        assert!(
            !e.structural
                .iter()
                .any(|s| matches!(s, StructuralEdit::SplitRun { .. })),
            "{:?}",
            e.structural
        );
        assert_eq!(e.runs.len(), 1);
        assert_eq!(e.runs[0].run, 1);
        assert_eq!(e.runs[0].new_text.as_deref(), Some("big world"));
        assert!(e.runs[0].new_props.is_none());
    }

    #[test]
    fn a_styled_cell_read_writes_a_split_in_the_cell() {
        use crate::edit::StructuralEdit;
        use docx_lower::ir::{LoweredCell, LoweredTable};
        let mut base = LoweredDoc::default();
        base.story.blocks.push(LoweredBlock::Table(LoweredTable {
            rows: 1,
            cols: 1,
            cells: vec![LoweredCell {
                paragraphs: vec![LoweredParagraph {
                    runs: runs(&["Total 12"]),
                    ..Default::default()
                }],
                ..Default::default()
            }],
            ..Default::default()
        }));
        let mut edited = base.clone();
        let skips = overlay_cells(
            &mut edited,
            &[CellContentIn {
                block: 0,
                cell: 0,
                text: "Total 12".into(),
                paragraphs: Some(vec![ParagraphContentIn {
                    paragraph_style: None,
                    runs: vec![plain("Total "), bold("12")],
                }]),
            }],
        );
        assert!(skips.is_empty());
        let e = crate::diff(&base, &edited, &crate::DocxBindings::default());
        assert!(e.cells.is_empty());
        let [StructuralEdit::SplitCellRun {
            block: 0,
            cell: 0,
            para: 0,
            run: 0,
            pieces,
            ..
        }] = e.structural.as_slice()
        else {
            panic!("{:?}", e.structural)
        };
        assert_eq!(pieces.len(), 2);
        assert!(pieces[0].format.is_none());
        assert_eq!(
            pieces[1].format.as_ref().map(|f| f.props.bold),
            Some(Some(true))
        );
        // A styled read that disagrees with the text read is not used.
        let mut edited = base.clone();
        overlay_cells(
            &mut edited,
            &[CellContentIn {
                block: 0,
                cell: 0,
                text: "Total 14".into(),
                paragraphs: Some(vec![ParagraphContentIn {
                    paragraph_style: None,
                    runs: vec![bold("Other")],
                }]),
            }],
        );
        let e = crate::diff(&base, &edited, &crate::DocxBindings::default());
        assert!(e.structural.is_empty());
        assert_eq!(e.cells.len(), 1);
        assert_eq!(e.cells[0].new_text.as_deref(), Some("Total 14"));
    }

    #[test]
    fn multibyte_text_is_cut_on_chars() {
        let mut rs = runs(&["Grüße ", "€5"]);
        patch_runs(&mut rs, "Grüße €7").unwrap();
        assert_eq!(texts(&rs), ["Grüße ", "€7"]);
    }
}
