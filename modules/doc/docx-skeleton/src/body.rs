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

//! The body of a Word document as native paragraphs, built in Rust (doc
//! ADR 625, slice 1): the engine's own `paged_model::Paragraph` and
//! `CharacterRun`, with Word's direct formatting set as the paragraph's and
//! the run's own properties instead of a synthesized named style.
//!
//! The lowering ([`docx_lower`]) still produces the plugin-local IR, and
//! the IR still names a `docx-auto-pN` / `docx-auto-cN` style for every
//! distinct set of direct formatting, because the host's mutation door
//! styles a range only by applying a named style (ADR 600). This module is
//! the seam that undoes that for the blocks it can build: it reads the IR,
//! resolves each synthesized style to the Word style it is based on plus the
//! properties it carries, and sets those properties on the model. A block it
//! cannot build whole (a field, a picture, a list, a tracked change, a
//! property it has no model field for) is returned as [`NativeBlock::Deferred`]
//! with the reason, and the old path pours it. Blocks keep their index in
//! [`docx_lower::ir::LoweredStory::blocks`], so save-back's ordinal map
//! (`docx-export` `bindings.rs`) is unchanged.
//!
//! Nothing here invents an id: a paragraph's style is the Word style's
//! token, or `None`.

use std::collections::{BTreeMap, HashMap};

use docx_lower::ir::{
    LoweredBlock, LoweredDoc, LoweredParagraph, LoweredRun, LoweredStyle, LoweredTable, PropValue,
    StyleProp,
};
use paged_model::script::{CharacterDirection, FontHint};
use paged_model::{
    CellWidth, CharacterRun, Justification, Paragraph, Table, TableCell, TableColumn, TableRow,
    TableWidth, WordTableLayout,
};

/// The id prefix of the styles the lowering synthesizes for direct
/// formatting (`docx-lower` `synthesize`).
const AUTO_PARA: &str = "ParagraphStyle/docx-auto-p";
const AUTO_CHAR: &str = "CharacterStyle/docx-auto-c";

/// One block of the story as slice 1 sees it.
#[derive(Debug, Clone)]
pub enum NativeBlock {
    /// Built as a model paragraph.
    Paragraph(Box<Paragraph>),
    /// A native table, in a paragraph of its own (doc ADR 625, slice 3).
    Table(Box<Paragraph>),
    /// Left to the old path, with the reason (an honest, countable
    /// degradation: nothing is dropped).
    Deferred { reason: String },
}

/// The story's blocks, one per [`LoweredBlock`] and at its index.
#[derive(Debug, Clone, Default)]
pub struct NativeBody {
    pub blocks: Vec<NativeBlock>,
}

impl NativeBody {
    /// How many blocks were built natively.
    pub fn built(&self) -> usize {
        self.blocks
            .iter()
            .filter(|b| !matches!(b, NativeBlock::Deferred { .. }))
            .count()
    }
}

/// Whether `id` names a style the lowering synthesized for direct
/// formatting.
pub fn is_synthesized(id: &str) -> bool {
    id.starts_with(AUTO_PARA) || id.starts_with(AUTO_CHAR)
}

fn is_char_path(path: &str) -> bool {
    path.starts_with("character")
}

/// The style catalogue by id.
fn catalogue(doc: &LoweredDoc) -> HashMap<&str, &LoweredStyle> {
    doc.styles.iter().map(|s| (s.id.as_str(), s)).collect()
}

/// The properties `id` resolves to: its `basedOn` chain from the root down,
/// a child's value replacing its parent's. An unknown id resolves to none.
pub fn resolve_style(doc: &LoweredDoc, id: &str) -> BTreeMap<String, PropValue> {
    let styles = catalogue(doc);
    let mut chain = Vec::new();
    let mut at = Some(id);
    while let Some(i) = at {
        let Some(s) = styles.get(i) else { break };
        if chain.len() > 64 {
            break;
        }
        chain.push(*s);
        at = s.based_on.as_deref();
    }
    let mut out = BTreeMap::new();
    for s in chain.iter().rev() {
        for p in &s.props {
            out.insert(p.path.clone(), p.value.clone());
        }
    }
    out
}

/// A synthesized style split into the Word style it stands on and its own
/// properties (a synthesized style may be based on another synthesized one:
/// the chain is flattened, the nearest style's value last).
struct Direct<'a> {
    base: Option<&'a str>,
    props: Vec<&'a StyleProp>,
}

fn split_style<'a>(
    styles: &'a HashMap<&str, &LoweredStyle>,
    id: Option<&'a str>,
) -> Result<Direct<'a>, String> {
    let Some(id) = id else {
        return Ok(Direct {
            base: None,
            props: Vec::new(),
        });
    };
    if !is_synthesized(id) {
        return Ok(Direct {
            base: Some(id),
            props: Vec::new(),
        });
    }
    let mut chain: Vec<&LoweredStyle> = Vec::new();
    let mut at = Some(id);
    let mut base = None;
    while let Some(i) = at {
        if !is_synthesized(i) {
            base = Some(i);
            break;
        }
        let Some(s) = styles.get(i) else {
            return Err(format!("synthesized style {i} is not in the catalogue"));
        };
        if chain.len() > 16 {
            return Err(format!("{id} is based on too long a chain"));
        }
        chain.push(s);
        at = s.based_on.as_deref();
    }
    let props = chain.iter().rev().flat_map(|s| s.props.iter()).collect();
    Ok(Direct { base, props })
}

fn len_of(v: &PropValue) -> Option<f32> {
    match v {
        PropValue::Length(f) => Some(*f),
        _ => None,
    }
}

fn bool_of(v: &PropValue) -> Option<bool> {
    match v {
        PropValue::Bool(b) => Some(*b),
        _ => None,
    }
}

fn text_of(v: &PropValue) -> Option<&str> {
    match v {
        PropValue::Text(t) => Some(t),
        _ => None,
    }
}

fn count(f: f32) -> u32 {
    f.max(0.0).round() as u32
}

/// Set one paragraph property on the model, as the engine's
/// `setElementProperty` does. `false`: the path (or its value shape) is not
/// one slice 1 builds.
pub fn set_paragraph_prop(p: &mut Paragraph, prop: &StyleProp) -> bool {
    let v = &prop.value;
    match prop.path.as_str() {
        "paragraphJustification" => match text_of(v).and_then(Justification::from_idml) {
            Some(j) => p.justification = Some(j),
            None => return false,
        },
        "paragraphLeftIndent" => return len_of(v).map(|f| p.left_indent = Some(f)).is_some(),
        "paragraphRightIndent" => return len_of(v).map(|f| p.right_indent = Some(f)).is_some(),
        "paragraphFirstLineIndent" => {
            return len_of(v).map(|f| p.first_line_indent = Some(f)).is_some();
        }
        "paragraphSpaceBefore" => return len_of(v).map(|f| p.space_before = Some(f)).is_some(),
        "paragraphSpaceAfter" => return len_of(v).map(|f| p.space_after = Some(f)).is_some(),
        "paragraphKeepWithNext" => {
            return len_of(v)
                .map(|f| p.keep_with_next = Some(count(f)))
                .is_some();
        }
        "paragraphKeepFirstLines" => {
            return len_of(v)
                .map(|f| p.keep_first_lines = Some(count(f)))
                .is_some();
        }
        "paragraphKeepLastLines" => {
            return len_of(v)
                .map(|f| p.keep_last_lines = Some(count(f)))
                .is_some();
        }
        "paragraphKeepLinesTogether" => {
            return bool_of(v)
                .map(|b| p.keep_lines_together = Some(b))
                .is_some();
        }
        "paragraphKeepAllLinesTogether" => {
            return bool_of(v)
                .map(|b| p.keep_all_lines_together = Some(b))
                .is_some();
        }
        _ => return false,
    }
    true
}

fn opt_text(v: &PropValue) -> Option<Option<String>> {
    text_of(v).map(|t| (!t.is_empty()).then(|| t.to_owned()))
}

/// Set one character property on a model run (see [`set_paragraph_prop`]).
pub fn set_run_prop(r: &mut CharacterRun, prop: &StyleProp) -> bool {
    let v = &prop.value;
    match prop.path.as_str() {
        "characterFontFamily" => return opt_text(v).map(|t| r.font = t).is_some(),
        "characterFontStyle" => return opt_text(v).map(|t| r.font_style = t).is_some(),
        "characterCase" => return opt_text(v).map(|t| r.capitalization = t).is_some(),
        "characterPosition" => return opt_text(v).map(|t| r.position = t).is_some(),
        "characterFontSize" => return len_of(v).map(|f| r.point_size = Some(f)).is_some(),
        "characterLeading" => return len_of(v).map(|f| r.leading = Some(f)).is_some(),
        "characterTracking" => return len_of(v).map(|f| r.tracking = Some(f)).is_some(),
        "characterBaselineShift" => {
            return len_of(v).map(|f| r.baseline_shift = Some(f)).is_some();
        }
        "characterUnderline" => return bool_of(v).map(|b| r.underline = Some(b)).is_some(),
        "characterStrikethru" => return bool_of(v).map(|b| r.strikethru = Some(b)).is_some(),
        // Engine ADR 1051 — the script slots (doc ADR 620).
        "characterEastAsianFont" => {
            return opt_text(v).map(|t| r.script.east_asian_font = t).is_some();
        }
        "characterComplexFont" => {
            return opt_text(v).map(|t| r.script.complex_font = t).is_some();
        }
        "characterComplexFontSize" => {
            return len_of(v)
                .filter(|f| f.is_finite() && *f > 0.0)
                .map(|f| r.script.complex_point_size = Some(f))
                .is_some();
        }
        "characterComplexBold" => {
            return bool_of(v)
                .map(|b| r.script.complex_bold = Some(b))
                .is_some();
        }
        "characterComplexItalic" => {
            return bool_of(v)
                .map(|b| r.script.complex_italic = Some(b))
                .is_some();
        }
        "characterComplexScript" => {
            return bool_of(v).map(|b| r.script.complex = Some(b)).is_some();
        }
        "characterDirection" => match text_of(v).and_then(CharacterDirection::from_name) {
            Some(d) => r.script.direction = Some(d),
            None => return false,
        },
        "characterFontHint" => match text_of(v).and_then(FontHint::from_name) {
            Some(h) => r.script.hint = Some(h),
            None => return false,
        },
        "characterFillColor" => match v {
            PropValue::ColorRef(c) => r.fill_color = Some(c.clone()),
            _ => return false,
        },
        _ => return false,
    }
    true
}

/// The paragraph properties slice 1 builds, read back off the model in the
/// IR's vocabulary (what the comparison test resolves against).
pub fn read_paragraph_props(p: &Paragraph) -> BTreeMap<String, PropValue> {
    let mut m = BTreeMap::new();
    let mut put = |k: &str, v: PropValue| {
        m.insert(k.to_owned(), v);
    };
    if let Some(j) = p.justification {
        put(
            "paragraphJustification",
            PropValue::Text(j.as_idml().into()),
        );
    }
    let lens = [
        ("paragraphLeftIndent", p.left_indent),
        ("paragraphRightIndent", p.right_indent),
        ("paragraphFirstLineIndent", p.first_line_indent),
        ("paragraphSpaceBefore", p.space_before),
        ("paragraphSpaceAfter", p.space_after),
        ("paragraphKeepWithNext", p.keep_with_next.map(|n| n as f32)),
        (
            "paragraphKeepFirstLines",
            p.keep_first_lines.map(|n| n as f32),
        ),
        (
            "paragraphKeepLastLines",
            p.keep_last_lines.map(|n| n as f32),
        ),
    ];
    for (k, v) in lens {
        if let Some(f) = v {
            put(k, PropValue::Length(f));
        }
    }
    let bools = [
        ("paragraphKeepLinesTogether", p.keep_lines_together),
        ("paragraphKeepAllLinesTogether", p.keep_all_lines_together),
    ];
    for (k, v) in bools {
        if let Some(b) = v {
            put(k, PropValue::Bool(b));
        }
    }
    m
}

/// The character properties slice 1 builds, read back off a model run.
pub fn read_run_props(r: &CharacterRun) -> BTreeMap<String, PropValue> {
    let mut m = BTreeMap::new();
    let mut put = |k: &str, v: PropValue| {
        m.insert(k.to_owned(), v);
    };
    let texts = [
        ("characterFontFamily", &r.font),
        ("characterFontStyle", &r.font_style),
        ("characterCase", &r.capitalization),
        ("characterPosition", &r.position),
    ];
    for (k, v) in texts {
        if let Some(t) = v {
            put(k, PropValue::Text(t.clone()));
        }
    }
    let lens = [
        ("characterFontSize", r.point_size),
        ("characterLeading", r.leading),
        ("characterTracking", r.tracking),
        ("characterBaselineShift", r.baseline_shift),
    ];
    for (k, v) in lens {
        if let Some(f) = v {
            put(k, PropValue::Length(f));
        }
    }
    let sc = &r.script;
    for (k, v) in [
        ("characterEastAsianFont", &sc.east_asian_font),
        ("characterComplexFont", &sc.complex_font),
    ] {
        if let Some(t) = v {
            put(k, PropValue::Text(t.clone()));
        }
    }
    if let Some(f) = sc.complex_point_size {
        put("characterComplexFontSize", PropValue::Length(f));
    }
    for (k, v) in [
        ("characterComplexBold", sc.complex_bold),
        ("characterComplexItalic", sc.complex_italic),
        ("characterComplexScript", sc.complex),
    ] {
        if let Some(b) = v {
            put(k, PropValue::Bool(b));
        }
    }
    if let Some(d) = sc.direction {
        put("characterDirection", PropValue::Text(d.as_name().into()));
    }
    if let Some(h) = sc.hint {
        put("characterFontHint", PropValue::Text(h.as_name().into()));
    }
    if let Some(b) = r.underline {
        put("characterUnderline", PropValue::Bool(b));
    }
    if let Some(b) = r.strikethru {
        put("characterStrikethru", PropValue::Bool(b));
    }
    if let Some(c) = &r.fill_color {
        put("characterFillColor", PropValue::ColorRef(c.clone()));
    }
    m
}

/// Why a run is not slice 1's, if it is not: everything beyond text and
/// formatting waits for its own slice.
fn run_deferral(r: &LoweredRun) -> Option<&'static str> {
    if r.hyperlink_url.is_some() {
        Some("hyperlink")
    } else if r.merge_field.is_some() {
        Some("merge field")
    } else if r.field.is_some() {
        Some("field")
    } else if r.note.is_some() {
        Some("note reference")
    } else if r.change.is_some() || r.format_change.is_some() {
        Some("tracked change")
    } else if !r.comments.is_empty() {
        Some("comment")
    } else if r.control.is_some() {
        Some("content control")
    } else {
        None
    }
}

fn paragraph_deferral(p: &LoweredParagraph) -> Option<&'static str> {
    if !p.images.is_empty() {
        Some("picture")
    } else if !p.segments.is_empty() {
        Some("page or column break inside the paragraph")
    } else if !p.bookmarks.is_empty() {
        Some("bookmark")
    } else if p.list.is_some() {
        Some("list item")
    } else if p.mark_change.is_some() || p.props_change.is_some() {
        Some("tracked change")
    } else if !p.text_boxes.is_empty() {
        Some("text box")
    } else if p.drop_cap.is_some() {
        Some("drop cap")
    } else {
        p.runs.iter().find_map(run_deferral)
    }
}

fn build_paragraph(
    doc: &LoweredDoc,
    styles: &HashMap<&str, &LoweredStyle>,
    p: &LoweredParagraph,
) -> Result<Paragraph, String> {
    if let Some(why) = paragraph_deferral(p) {
        return Err(why.into());
    }
    let direct = split_style(styles, p.para_style_id.as_deref())?;
    let mut para = Paragraph {
        paragraph_style: direct.base.map(str::to_owned),
        ..Paragraph::default()
    };
    // Character properties that sit in a paragraph style (the line pitch, a
    // size) reach each run as the run's own. In the cascade they sit below a
    // character style; as a run's own they would sit above it. A run's own
    // synthesized properties are laid over them, as the old cascade does, so
    // only a Word character style that sets one of the same paths changes
    // the result: that paragraph is left to the old path.
    let mut para_chars = Vec::new();
    for prop in &direct.props {
        if is_char_path(&prop.path) {
            para_chars.push(prop);
        } else if !set_paragraph_prop(&mut para, prop) {
            return Err(format!("no model field for {}", prop.path));
        }
    }
    for r in &p.runs {
        let Some(base) = split_style(styles, r.char_style_id.as_deref())?.base else {
            continue;
        };
        let theirs = resolve_style(doc, base);
        if para_chars.iter().any(|c| theirs.contains_key(&c.path)) {
            return Err("paragraph character properties under a character style".into());
        }
    }
    if !para_chars.is_empty() && p.runs.iter().all(|r| r.text.is_empty()) {
        return Err("paragraph character properties on an empty paragraph".into());
    }
    for r in p.runs.iter().filter(|r| !r.text.is_empty()) {
        let run_direct = split_style(styles, r.char_style_id.as_deref())?;
        let mut run = CharacterRun {
            character_style: run_direct.base.map(str::to_owned),
            text: r.text.clone(),
            ..CharacterRun::default()
        };
        for prop in &para_chars {
            if !set_run_prop(&mut run, prop) {
                return Err(format!("no model field for {}", prop.path));
            }
        }
        for prop in &run_direct.props {
            if !set_run_prop(&mut run, prop) {
                return Err(format!("no model field for {}", prop.path));
            }
        }
        para.runs.push(run);
    }
    Ok(para)
}

/// InDesign's new-table edges, which `insertTable` stamps on every cell
/// (`paged-mutate` `new_table_cell`).
const NEW_CELL_EDGE_COLOR: &str = "Color/Black";
const NEW_CELL_EDGE_WEIGHT_PT: f32 = 1.0;

fn new_table_cell(col: u32, row: u32) -> TableCell {
    let mut cell = TableCell {
        name: Some(format!("{col}:{row}")),
        row_span: 1,
        column_span: 1,
        ..TableCell::default()
    };
    for (color, weight) in [
        (
            &mut cell.top_edge_stroke_color,
            &mut cell.top_edge_stroke_weight,
        ),
        (
            &mut cell.bottom_edge_stroke_color,
            &mut cell.bottom_edge_stroke_weight,
        ),
        (
            &mut cell.left_edge_stroke_color,
            &mut cell.left_edge_stroke_weight,
        ),
        (
            &mut cell.right_edge_stroke_color,
            &mut cell.right_edge_stroke_weight,
        ),
    ] {
        *color = Some(NEW_CELL_EDGE_COLOR.to_string());
        *weight = Some(NEW_CELL_EDGE_WEIGHT_PT);
    }
    cell
}

/// A Word table as the model's table in a paragraph of its own (doc ADR 625,
/// slice 3), as `insertTable` and the cell pour of the bundle make it.
fn build_table(
    doc: &LoweredDoc,
    styles: &HashMap<&str, &LoweredStyle>,
    t: &LoweredTable,
    made: &mut usize,
) -> Result<Paragraph, String> {
    if !t.flow.is_empty() {
        return Err("table poured as text".into());
    }
    if let Some(l) = &t.layout {
        if l.exact_rows.iter().any(|e| *e) {
            return Err("table with rows held at an exact height".into());
        }
    }
    // The table's own paragraph: its style aligns the table.
    let direct = split_style(styles, t.para_style_id.as_deref())?;
    let mut host = Paragraph {
        paragraph_style: direct.base.map(str::to_owned),
        ..Paragraph::default()
    };
    for prop in &direct.props {
        if is_char_path(&prop.path) || !set_paragraph_prop(&mut host, prop) {
            return Err(format!("no model field for {} on a table", prop.path));
        }
    }
    let (rows, cols) = (t.rows, t.cols);
    let header = t.header_rows.min(rows);
    let layout = t.layout.clone().unwrap_or_default();
    let width = match (layout.width_pt, layout.width_pct) {
        (Some(w), _) => Some(TableWidth::Points(w)),
        (None, Some(p)) => Some(TableWidth::Percent(p)),
        _ => None,
    };
    let mut cell_widths = Vec::new();
    for (i, w) in layout.cell_widths_pt.iter().enumerate() {
        if let (Some(w), Some(c)) = (w, t.cells.get(i)) {
            cell_widths.push(CellWidth {
                row: c.row,
                col: c.col,
                width: TableWidth::Points(*w),
            });
        }
    }
    let mut cells: Vec<TableCell> = Vec::with_capacity((rows * cols) as usize);
    for c in 0..cols {
        for r in 0..rows {
            cells.push(new_table_cell(c, r));
        }
    }
    for lc in &t.cells {
        if lc.look.is_some() {
            return Err("table cell with borders or shading".into());
        }
        if !lc.nested.is_empty() {
            return Err("nested table".into());
        }
        if lc.paragraphs.iter().any(|p| !p.images.is_empty()) {
            return Err("picture in a table cell".into());
        }
        if lc.row >= rows || lc.col >= cols {
            return Err("table cell outside the grid".into());
        }
        // The engine keeps a span inside the grid.
        if lc.col + lc.col_span.max(1) > cols || lc.row + lc.row_span.max(1) > rows {
            return Err("table cell span outside the grid".into());
        }
        let cell = &mut cells[(lc.col * rows + lc.row) as usize];
        if let Some([top, left, bottom, right]) = lc.insets_pt {
            cell.text_top_inset = top;
            cell.text_left_inset = left;
            cell.text_bottom_inset = bottom;
            cell.text_right_inset = right;
        }
        if let Some(v) = &lc.v_align {
            cell.vertical_justification = Some(v.clone());
        }
        let text_empty = lc
            .paragraphs
            .iter()
            .all(|p| p.runs.iter().all(|r| r.text.is_empty()))
            && lc.paragraphs.len() <= 1;
        let styled_empty = lc.paragraphs.iter().any(|p| p.para_style_id.is_some());
        if !(text_empty && !styled_empty) {
            for p in &lc.paragraphs {
                let para = build_paragraph(doc, styles, p)?;
                if para.runs.iter().any(|r| r.text.contains(['\n', '\r'])) {
                    return Err("line feed in a table cell".into());
                }
                cell.paragraphs.push(para);
            }
        }
        cell.row_span = lc.row_span.max(1);
        cell.column_span = lc.col_span.max(1);
    }
    let table = Table {
        word: Some(WordTableLayout {
            indent: layout.indent_pt.unwrap_or(0.0),
            autofit: !layout.fixed,
            width,
            cell_widths,
            cant_split_rows: layout
                .cant_split
                .iter()
                .enumerate()
                .filter_map(|(r, c)| c.then_some(r as u32))
                .collect(),
        }),
        self_id: Some(format!("Table/docx_t{}", *made)),
        header_row_count: header,
        footer_row_count: 0,
        body_row_count: rows - header,
        column_count: cols,
        rows: (0..rows)
            .map(|r| TableRow {
                name: Some(r.to_string()),
                single_row_height: t.row_heights_pt.get(r as usize).copied(),
                ..TableRow::default()
            })
            .collect(),
        columns: (0..cols)
            .map(|c| TableColumn {
                name: Some(c.to_string()),
                single_column_width: t.column_widths_pt.get(c as usize).copied(),
                ..TableColumn::default()
            })
            .collect(),
        cells,
        ..Table::default()
    };
    *made += 1;
    host.table = Some(table);
    Ok(host)
}

/// Build the story's blocks that slice 1 can, directly on the model.
pub fn native_body(doc: &LoweredDoc) -> NativeBody {
    let styles = catalogue(doc);
    let mut tables = 0usize;
    let blocks = doc
        .story
        .blocks
        .iter()
        .map(|b| match b {
            LoweredBlock::Table(t) => match build_table(doc, &styles, t, &mut tables) {
                Ok(para) => NativeBlock::Table(Box::new(para)),
                Err(reason) => NativeBlock::Deferred { reason },
            },
            LoweredBlock::Paragraph(p) => match build_paragraph(doc, &styles, p) {
                Ok(para) => NativeBlock::Paragraph(Box::new(para)),
                Err(reason) => NativeBlock::Deferred { reason },
            },
        })
        .collect();
    NativeBody { blocks }
}

/// The body's native stories, one per skeleton story and in its order, when
/// the WHOLE body can be built natively; `None` otherwise (the document
/// then opens by the old path, whole: a story half built here and half
/// poured would split a paragraph range between two mechanisms).
///
/// Stories group the blocks as the bundle's `sectionBlocks` does: a section
/// that joins the story before it adds its blocks to that story.
pub fn native_stories(doc: &LoweredDoc) -> Option<Vec<Vec<Paragraph>>> {
    // What the body carries outside its blocks and the old path places.
    if !doc.comments.is_empty() || !doc.tocs.is_empty() || doc.track_changes {
        return None;
    }
    let body = native_body(doc);
    let mut paras = Vec::with_capacity(body.blocks.len());
    for b in body.blocks {
        match b {
            NativeBlock::Paragraph(p) | NativeBlock::Table(p) => {
                // The old pour reads a line feed as a paragraph break.
                if p.runs.iter().any(|r| r.text.contains(['\n', '\r'])) {
                    return None;
                }
                paras.push(*p);
            }
            NativeBlock::Deferred { .. } => return None,
        }
    }
    let sections: Vec<_> = if doc.sections.is_empty() {
        vec![&doc.section]
    } else {
        doc.sections.iter().collect()
    };
    let mut starts = Vec::new();
    for (k, s) in sections.iter().enumerate() {
        let joins = k > 0 && s.story == sections[k - 1].story;
        if !joins {
            starts.push(s.first_block);
        }
    }
    let mut out = Vec::with_capacity(starts.len());
    for (k, &start) in starts.iter().enumerate() {
        let end = starts.get(k + 1).copied().unwrap_or(paras.len());
        let slice = paras.get(start..end.min(paras.len()))?;
        out.push(slice.to_vec());
    }
    Some(out)
}
