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

//! Excel tables, editable (W2.6, sheet ADR 517): create a table from a
//! range (its part, relationship, content type and `<tablePart>`), resize
//! it, rename it, show the totals row with SUBTOTAL functions or a custom
//! formula, calculated columns filled down every data row, the 60 built-in
//! styles and the style switches, auto-expansion when a typed entry lands
//! directly below or to the right of a table, and a formula typed into an
//! empty table column becoming its calculated column. A header cell that
//! is edited renames its column, and the formulas over it follow.
//!
//! The table part stays the store of what the model does not hold
//! (`TableDef`); the model's `sheet_core::Table` follows every change, and
//! the engine is rebuilt over it so structured references resolve anew.

use std::collections::BTreeSet;

use sheet_core::ast::{Expr, Formula, StructuredRef};
use sheet_core::{CellRef, RangeRef, SheetModel, Table};
use sheet_parser::{parse, print, print_ooxml, rewrite_fill, strip_storage_prefixes};
use sheet_xlsx::table_doc::{new_table_node, TableColumnDef, TableDef};
use sheet_xlsx::table_style::builtin_names;

use super::{
    a1_of, cell_input_text, CellInput, ModelParseCtx, ModelSheetNames, SessionError, SetCellResult,
    SheetSession,
};

/// One table, read whole.
#[derive(serde::Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TableDetail {
    pub name: String,
    pub sheet: u16,
    /// The full extent, A1.
    pub range: String,
    pub header_row: bool,
    pub totals_row: bool,
    pub columns: Vec<TableColumnInfo>,
    pub style: Option<String>,
    pub first_column: bool,
    pub last_column: bool,
    pub banded_rows: bool,
    pub banded_columns: bool,
}

#[derive(serde::Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TableColumnInfo {
    pub name: String,
    /// The calculated-column formula, display dialect with `=`.
    pub calculated_formula: Option<String>,
    pub totals_function: Option<String>,
    pub totals_formula: Option<String>,
    pub totals_label: Option<String>,
}

/// A table's style switches (absent: kept).
#[derive(serde::Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct TableStyleArg {
    pub style: Option<String>,
    pub first_column: Option<bool>,
    pub last_column: Option<bool>,
    pub banded_rows: Option<bool>,
    pub banded_columns: Option<bool>,
}

/// A column name inside a structured reference: `[`, `]`, `#` and `'` are
/// escaped with `'` (ECMA-376 §18.17.2.4).
fn escape_column(n: &str) -> String {
    let mut out = String::with_capacity(n.len());
    for ch in n.chars() {
        if matches!(ch, '[' | ']' | '#' | '\'') {
            out.push('\'');
        }
        out.push(ch);
    }
    out
}

/// The SUBTOTAL code of a totals function.
fn subtotal_code(f: &str) -> Option<u32> {
    Some(match f {
        "average" => 101,
        "countNums" => 102,
        "count" => 103,
        "max" => 104,
        "min" => 105,
        "stdDev" => 107,
        "sum" => 109,
        "var" => 110,
        _ => return None,
    })
}

fn a1_range(r: (u32, u32, u32, u32)) -> String {
    format!("{}:{}", a1_of(r.0, r.1), a1_of(r.2, r.3))
}

/// Excel's table-name rules: a letter, `_` or `\` first; letters, digits,
/// `_` and `.` after; not a cell reference; at most 255 characters.
fn valid_table_name(n: &str) -> bool {
    let mut cs = n.chars();
    let Some(first) = cs.next() else {
        return false;
    };
    if !(first.is_alphabetic() || first == '_' || first == '\\') {
        return false;
    }
    if !n
        .chars()
        .all(|c| c.is_alphanumeric() || c == '_' || c == '.' || c == '\\')
    {
        return false;
    }
    if n.chars().count() > 255 || sheet_core::parse_a1(n).is_some() {
        return false;
    }
    !matches!(n.to_ascii_uppercase().as_str(), "R" | "C")
}

/// Rename structured references: table `old` → `new` (table rename), or a
/// column of table `table` from `old` to `new` (header edit).
fn rename_refs(e: &mut Expr, f: &impl Fn(&mut StructuredRef)) {
    match e {
        Expr::StructuredRef(s) => f(s),
        Expr::Unary(_, a) | Expr::SpillRef(a) => rename_refs(a, f),
        Expr::Binary(_, a, b) => {
            rename_refs(a, f);
            rename_refs(b, f);
        }
        Expr::Func(_, args) | Expr::UnknownFunc(_, args) => {
            for a in args {
                rename_refs(a, f);
            }
        }
        Expr::Call(c, args) => {
            rename_refs(c, f);
            for a in args {
                rename_refs(a, f);
            }
        }
        Expr::Array(rows) => {
            for r in rows {
                for a in r {
                    rename_refs(a, f);
                }
            }
        }
        _ => {}
    }
}

/// `formula` with every in-table `[@Col]` (a structured reference without
/// a table name) given the name of the table holding `(row, col)`, as the
/// file stores it (`Sales[[#This Row],[Col]]`). `None` when nothing needs
/// naming.
pub(crate) fn qualify_this_row(
    model: &SheetModel,
    sheet: u16,
    row: u32,
    col: u32,
    formula: &Formula,
) -> Option<Formula> {
    let table = model.sheet(sheet)?.tables.iter().find(|t| {
        let n = t.range.normalized();
        n.start.row <= row && row <= n.end.row && n.start.col <= col && col <= n.end.col
    })?;
    let mut g = formula.clone();
    let name = table.name.clone();
    rename_refs(&mut g.root, &|s: &mut StructuredRef| {
        if s.table.is_empty() {
            s.table = name.clone();
        }
    });
    (&g != formula).then_some(g)
}

/// Apply `f` to every formula of the model (cells and defined names that
/// hold an expression).
fn rewrite_all_formulas(model: &mut SheetModel, f: &impl Fn(&mut StructuredRef)) {
    let mut updates = Vec::new();
    for (si, ws) in model.sheets.iter().enumerate() {
        for (&(r, c), cell) in &ws.cells {
            if let Some(fid) = cell.formula {
                if let Some(form) = model.formula(fid) {
                    let mut g = form.clone();
                    rename_refs(&mut g.root, f);
                    if &g != form {
                        updates.push((si, r, c, g));
                    }
                }
            }
        }
    }
    for (si, r, c, g) in updates {
        let id = model.intern_formula(g);
        if let Some(cell) = model.sheets[si].cells.get_mut(&(r, c)) {
            cell.formula = Some(id);
        }
    }
}

impl SheetSession {
    /// Rebuild the engine over the model `f` changed, recalculating, and
    /// report every formula cell's display.
    fn rebuild(&mut self, f: impl FnOnce(&mut SheetModel)) -> SetCellResult {
        self.with_model(true, f);
        let model = self.engine().model();
        let mut cells = BTreeSet::new();
        for (si, ws) in model.sheets.iter().enumerate() {
            for (&(r, c), cell) in &ws.cells {
                if cell.formula.is_some() {
                    cells.insert((si as u16, r, c));
                }
            }
        }
        let (changed, circular) = self.collect_changes(&cells, &BTreeSet::new());
        SetCellResult {
            changed,
            circular,
            restyled: Vec::new(),
        }
    }

    /// Every formula cell's display (after a table change rebuilt the engine).
    pub(crate) fn rebuilt_changes(&self) -> Vec<super::CellChange> {
        let cells: BTreeSet<(u16, u32, u32)> = self.formula_cells().into_iter().collect();
        self.collect_changes(&cells, &BTreeSet::new()).0
    }

    /// The table named `name` (case-insensitive): its sheet and part.
    fn table_def(&self, name: &str) -> Result<(u16, TableDef), SessionError> {
        let n = self.engine().model().sheets.len() as u16;
        for s in 0..n {
            for t in self.doc.table_defs(s) {
                if t.name().eq_ignore_ascii_case(name) {
                    return Ok((s, t));
                }
            }
        }
        Err(SessionError(format!("no table named {name:?}")))
    }

    fn detail_of(&self, sheet: u16, t: &TableDef) -> TableDetail {
        let (style, first, last, rows, cols) = t.style();
        let range = t.range().unwrap_or((0, 0, 0, 0));
        let model = self.engine().model();
        let names = ModelSheetNames { model };
        let ctx = ModelParseCtx {
            model,
            current: sheet,
        };
        let shown = |f: &Option<String>| {
            f.as_ref()
                .map(|s| match parse(&strip_storage_prefixes(s), &ctx) {
                    Ok(p) => format!("={}", print(&p, sheet, &names)),
                    Err(_) => format!("={s}"),
                })
        };
        TableDetail {
            name: t.name(),
            sheet,
            range: a1_range(range),
            header_row: t.header_rows() > 0,
            totals_row: t.totals_rows() > 0,
            columns: t
                .columns()
                .iter()
                .map(|c| TableColumnInfo {
                    name: c.name.clone(),
                    calculated_formula: shown(&c.calculated),
                    totals_function: c.totals_function.clone(),
                    totals_formula: shown(&c.totals_formula),
                    totals_label: c.totals_label.clone(),
                })
                .collect(),
            style,
            first_column: first,
            last_column: last,
            banded_rows: rows,
            banded_columns: cols,
        }
    }

    /// Every table of the workbook, read whole.
    pub fn list_table_details(&self) -> Vec<TableDetail> {
        let n = self.engine().model().sheets.len() as u16;
        (0..n)
            .flat_map(|s| {
                self.doc
                    .table_defs(s)
                    .into_iter()
                    .map(move |t| (s, t))
                    .collect::<Vec<_>>()
            })
            .map(|(s, t)| self.detail_of(s, &t))
            .collect()
    }

    pub fn table_detail(&self, name: &str) -> Result<TableDetail, SessionError> {
        let (s, t) = self.table_def(name)?;
        Ok(self.detail_of(s, &t))
    }

    /// The 60 built-in table style names.
    pub fn table_style_names(&self) -> Vec<String> {
        builtin_names()
    }

    /// Store `def`, and make the model's table match it.
    fn commit_table(&mut self, sheet: u16, old_name: &str, def: &TableDef) -> SetCellResult {
        self.doc.store_table(def);
        self.extra_dirty.insert(sheet);
        let range = def.range().unwrap_or((0, 0, 0, 0));
        let mk = |row, col| CellRef {
            sheet,
            row,
            col,
            row_abs: false,
            col_abs: false,
        };
        let table = Table {
            name: def.name().into(),
            range: RangeRef {
                start: mk(range.0, range.1),
                end: mk(range.2, range.3),
            },
            columns: def
                .columns()
                .iter()
                .map(|c| c.name.as_str().into())
                .collect(),
            header_row: def.header_rows() > 0,
            totals_row: def.totals_rows() > 0,
            style_name: def.style().0.map(Into::into),
        };
        let old = old_name.to_string();
        self.rebuild(move |m| {
            if let Some(ws) = m.sheet_mut(sheet) {
                match ws
                    .tables
                    .iter_mut()
                    .find(|t| t.name.eq_ignore_ascii_case(&old))
                {
                    Some(t) => *t = table,
                    None => ws.tables.push(table),
                }
            }
        })
    }

    /// A unique column name from a header text.
    fn unique_names(raw: &[String]) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for (i, r) in raw.iter().enumerate() {
            let base = if r.trim().is_empty() {
                format!("Column{}", i + 1)
            } else {
                r.clone()
            };
            let mut name = base.clone();
            let mut k = 2;
            while out.iter().any(|o| o.eq_ignore_ascii_case(&name)) {
                name = format!("{base}{k}");
                k += 1;
            }
            out.push(name);
        }
        out
    }

    /// Insert ▸ Table: make `range` a table. With `has_headers` its first
    /// row names the columns (blank and repeated names are made unique, as
    /// Excel makes them, and written into the cells); without, the data
    /// moves down one row and a header row of `Column1…` is written above
    /// it (the row below the range must be empty).
    pub fn create_table(
        &mut self,
        sheet: u16,
        range: &str,
        has_headers: bool,
        style: Option<&str>,
        name: Option<&str>,
    ) -> Result<TableDetail, SessionError> {
        self.validate_sheet(sheet)?;
        self.guard_allow(sheet, super::protect::Allow::FormatCells)?;
        let cr = super::parse_range(range)?;
        let (r0, c0, mut r1, c1) = (
            cr.r0.min(cr.r1),
            cr.c0.min(cr.c1),
            cr.r0.max(cr.r1),
            cr.c0.max(cr.c1),
        );
        let overlaps = |a: (u32, u32, u32, u32)| !(a.2 < r0 || a.0 > r1 || a.3 < c0 || a.1 > c1);
        if self
            .doc
            .table_defs(sheet)
            .iter()
            .filter_map(|t| t.range())
            .any(overlaps)
        {
            return Err(SessionError("a table cannot overlap another table".into()));
        }
        {
            let ws = self.engine().model().sheet(sheet).expect("validated");
            if ws.merges.iter().any(|m| {
                let n = m.normalized();
                overlaps((n.start.row, n.start.col, n.end.row, n.end.col))
            }) {
                return Err(SessionError(
                    "a table cannot hold merged cells: unmerge them first".into(),
                ));
            }
        }
        let style = style.unwrap_or("TableStyleMedium2");
        if self.doc.table_style(style).is_none() {
            return Err(SessionError(format!("unknown table style {style:?}")));
        }
        let all = self.doc.all_table_defs();
        let name = match name {
            Some(n) => {
                if !valid_table_name(n) {
                    return Err(SessionError(format!("{n:?} is not a valid table name")));
                }
                if all.iter().any(|t| t.name().eq_ignore_ascii_case(n))
                    || self.engine().model().names.resolve(n, sheet).is_some()
                {
                    return Err(SessionError(format!("the name {n:?} is already taken")));
                }
                n.to_string()
            }
            None => {
                let mut k = all.len() + 1;
                loop {
                    let cand = format!("Table{k}");
                    if !all.iter().any(|t| t.name().eq_ignore_ascii_case(&cand)) {
                        break cand;
                    }
                    k += 1;
                }
            }
        };
        if !has_headers {
            // Move the data down one row; the header goes where it started.
            let below_free = (c0..=c1).all(|c| {
                self.engine()
                    .model()
                    .sheet(sheet)
                    .and_then(|w| w.cell(r1 + 1, c))
                    .is_none()
            });
            if !below_free {
                return Err(SessionError(
                    "the row below the range must be empty to add a header row".into(),
                ));
            }
            let model = self.engine().model();
            let mut moves = Vec::new();
            for r in (r0..=r1).rev() {
                for c in c0..=c1 {
                    moves.push(CellInput {
                        sheet,
                        row: r + 1,
                        col: c,
                        input: cell_input_text(model, sheet, r, c),
                    });
                }
            }
            for (i, c) in (c0..=c1).enumerate() {
                moves.push(CellInput {
                    sheet,
                    row: r0,
                    col: c,
                    input: format!("Column{}", i + 1),
                });
            }
            self.set_cells(&moves)?;
            r1 += 1;
        }
        let raw: Vec<String> = (c0..=c1)
            .map(|c| self.get_cell_display(sheet, r0, c))
            .collect();
        let names = Self::unique_names(&raw);
        let fixes: Vec<CellInput> = names
            .iter()
            .zip(&raw)
            .enumerate()
            .filter(|(_, (n, r))| n != r)
            .map(|(i, (n, _))| CellInput {
                sheet,
                row: r0,
                col: c0 + i as u32,
                input: format!("'{n}"),
            })
            .collect();
        if !fixes.is_empty() {
            self.set_cells(&fixes)?;
        }
        if r1 == r0 {
            // A header alone gets one data row (Excel's minimum).
            r1 += 1;
        }
        let id = all.iter().map(|t| t.id()).max().unwrap_or(0) + 1;
        let node = new_table_node(id, &name, (r0, c0, r1, c1), &names, style);
        self.doc
            .add_table_part(sheet, node)
            .map_err(|e| SessionError(e.to_string()))?;
        let (s, def) = self.table_def(&name)?;
        self.commit_table(s, &name, &def);
        self.table_detail(&name)
    }

    /// Resize a table to `range` (Table Design ▸ Resize Table): the header
    /// row stays where it is and the range must still cover it; columns
    /// added take their header cell's text (or `ColumnN`), columns removed go.
    pub fn resize_table(&mut self, name: &str, range: &str) -> Result<TableDetail, SessionError> {
        let (sheet, mut def) = self.table_def(name)?;
        self.guard_allow(sheet, super::protect::Allow::FormatCells)?;
        let old = def
            .range()
            .ok_or_else(|| SessionError("table without a range".into()))?;
        let cr = super::parse_range(range)?;
        let (r0, c0, r1, c1) = (
            cr.r0.min(cr.r1),
            cr.c0.min(cr.c1),
            cr.r0.max(cr.r1),
            cr.c0.max(cr.c1),
        );
        if def.header_rows() > 0 && r0 != old.0 {
            return Err(SessionError(
                "the header row must stay in the same row".into(),
            ));
        }
        if r1 < r0 + def.header_rows() + def.totals_rows() {
            return Err(SessionError("the table needs at least one data row".into()));
        }
        if self
            .doc
            .table_defs(sheet)
            .iter()
            .filter(|t| !t.name().eq_ignore_ascii_case(name))
            .filter_map(|t| t.range())
            .any(|a| !(a.2 < r0 || a.0 > r1 || a.3 < c0 || a.1 > c1))
        {
            return Err(SessionError("a table cannot overlap another table".into()));
        }
        let cols = def.columns();
        let mut next_id = cols.iter().map(|c| c.id).max().unwrap_or(0) + 1;
        let mut out: Vec<TableColumnDef> = Vec::new();
        for c in c0..=c1 {
            if c >= old.1 && c <= old.3 {
                out.push(cols[(c - old.1) as usize].clone());
            } else {
                let text = if def.header_rows() > 0 {
                    self.get_cell_display(sheet, r0, c)
                } else {
                    String::new()
                };
                out.push(TableColumnDef {
                    id: next_id,
                    name: text,
                    ..Default::default()
                });
                next_id += 1;
            }
        }
        let raw: Vec<String> = out.iter().map(|c| c.name.clone()).collect();
        let names = Self::unique_names(&raw);
        for (c, n) in out.iter_mut().zip(&names) {
            c.name = n.clone();
        }
        if def.header_rows() > 0 {
            let fixes: Vec<CellInput> = names
                .iter()
                .enumerate()
                .filter(|(i, n)| self.get_cell_display(sheet, r0, c0 + *i as u32) != **n)
                .map(|(i, n)| CellInput {
                    sheet,
                    row: r0,
                    col: c0 + i as u32,
                    input: format!("'{n}"),
                })
                .collect();
            if !fixes.is_empty() {
                self.set_cells(&fixes)?;
            }
        }
        def.set_columns(&out);
        def.set_range(r0, c0, r1, c1);
        let n = def.name();
        self.commit_table(sheet, &n, &def);
        self.fill_calculated(sheet, &n)?;
        self.table_detail(&n)
    }

    /// Rename a table; every structured reference to it follows.
    pub fn rename_table(
        &mut self,
        name: &str,
        new_name: &str,
    ) -> Result<TableDetail, SessionError> {
        let (sheet, mut def) = self.table_def(name)?;
        if !valid_table_name(new_name) {
            return Err(SessionError(format!(
                "{new_name:?} is not a valid table name"
            )));
        }
        if !new_name.eq_ignore_ascii_case(name)
            && (self
                .doc
                .all_table_defs()
                .iter()
                .any(|t| t.name().eq_ignore_ascii_case(new_name))
                || self
                    .engine()
                    .model()
                    .names
                    .resolve(new_name, sheet)
                    .is_some())
        {
            return Err(SessionError(format!(
                "the name {new_name:?} is already taken"
            )));
        }
        let old = def.name();
        def.node.set("name", Some(new_name.to_string()));
        def.node.set("displayName", Some(new_name.to_string()));
        self.doc.store_table(&def);
        self.extra_dirty.insert(sheet);
        let (o, n) = (old.clone(), new_name.to_string());
        let touched = self.formula_cells();
        self.rebuild(move |m| {
            for ws in &mut m.sheets {
                for t in &mut ws.tables {
                    if t.name.eq_ignore_ascii_case(&o) {
                        t.name = n.as_str().into();
                    }
                }
            }
            rewrite_all_formulas(m, &|s: &mut StructuredRef| {
                if s.table.eq_ignore_ascii_case(&o) {
                    s.table = n.as_str().into();
                }
            });
        });
        self.edited.extend(touched);
        self.table_detail(new_name)
    }

    fn formula_cells(&self) -> Vec<(u16, u32, u32)> {
        let model = self.engine().model();
        model
            .sheets
            .iter()
            .enumerate()
            .flat_map(|(si, ws)| {
                ws.cells
                    .iter()
                    .filter(|(_, c)| c.formula.is_some())
                    .map(move |(&(r, c), _)| (si as u16, r, c))
            })
            .collect()
    }

    /// Show or hide the totals row. Showing it takes the row below the
    /// table (it must be empty), labels the first column `Total` and sums
    /// (or counts) the last; hiding it clears the row.
    pub fn set_table_totals(
        &mut self,
        name: &str,
        show: bool,
    ) -> Result<TableDetail, SessionError> {
        let (sheet, mut def) = self.table_def(name)?;
        self.guard_allow(sheet, super::protect::Allow::FormatCells)?;
        let (r0, c0, r1, c1) = def.range().ok_or_else(|| SessionError("no range".into()))?;
        let has = def.totals_rows() > 0;
        if show == has {
            return self.table_detail(name);
        }
        let n = def.name();
        if show {
            let below = r1 + 1;
            let free = (c0..=c1).all(|c| {
                self.engine()
                    .model()
                    .sheet(sheet)
                    .and_then(|w| w.cell(below, c))
                    .is_none()
            });
            if !free {
                return Err(SessionError(
                    "the row below the table must be empty to show the totals row".into(),
                ));
            }
            let mut cols = def.columns();
            let numeric = (r0 + def.header_rows()..=r1).any(|r| {
                matches!(
                    self.engine()
                        .model()
                        .sheet(sheet)
                        .and_then(|w| w.cell(r, c1))
                        .map(|c| &c.value),
                    Some(sheet_core::CellValue::Number(_))
                )
            });
            let several = cols.len() > 1;
            if let Some(first) = cols.first_mut() {
                if several {
                    first.totals_label = Some("Total".into());
                }
            }
            if let Some(last) = cols.last_mut() {
                last.totals_function = Some(if numeric { "sum" } else { "count" }.into());
            }
            def.set_columns(&cols);
            def.set_totals_rows(1);
            def.set_range(r0, c0, r1 + 1, c1);
        } else {
            let clear: Vec<CellInput> = (c0..=c1)
                .map(|c| CellInput {
                    sheet,
                    row: r1,
                    col: c,
                    input: String::new(),
                })
                .collect();
            self.set_cells(&clear)?;
            def.set_totals_rows(0);
            def.set_range(r0, c0, r1 - 1, c1);
        }
        self.commit_table(sheet, &n, &def);
        if show {
            self.write_totals(sheet, &n)?;
        }
        self.table_detail(&n)
    }

    /// Write every totals-row cell from its column's function or label.
    fn write_totals(&mut self, sheet: u16, name: &str) -> Result<(), SessionError> {
        let (_, def) = self.table_def(name)?;
        if def.totals_rows() == 0 {
            return Ok(());
        }
        let (_, c0, r1, _) = def.range().ok_or_else(|| SessionError("no range".into()))?;
        let model = self.engine().model();
        let names = ModelSheetNames { model };
        let ctx = ModelParseCtx {
            model,
            current: sheet,
        };
        let mut writes = Vec::new();
        for (i, c) in def.columns().iter().enumerate() {
            let input = match (
                c.totals_function.as_deref(),
                &c.totals_formula,
                &c.totals_label,
            ) {
                (Some("custom"), Some(f), _) => match parse(&strip_storage_prefixes(f), &ctx) {
                    Ok(p) => format!("={}", print(&p, sheet, &names)),
                    Err(_) => format!("={f}"),
                },
                (Some(fun), _, _) => match subtotal_code(fun) {
                    Some(code) => format!(
                        "=SUBTOTAL({code},{}[{}])",
                        def.name(),
                        escape_column(&c.name)
                    ),
                    None => String::new(),
                },
                (None, _, Some(l)) => format!("'{l}"),
                _ => String::new(),
            };
            writes.push(CellInput {
                sheet,
                row: r1,
                col: c0 + i as u32,
                input,
            });
        }
        self.set_cells(&writes)?;
        Ok(())
    }

    /// Set one column's totals function (`sum`, `average`, `count`,
    /// `countNums`, `max`, `min`, `stdDev`, `var`, `none`), a custom
    /// formula (`custom` with `formula`), or a label (`label`).
    pub fn set_totals_function(
        &mut self,
        name: &str,
        column: &str,
        function: &str,
        formula_or_label: Option<&str>,
    ) -> Result<TableDetail, SessionError> {
        let (sheet, mut def) = self.table_def(name)?;
        if def.totals_rows() == 0 {
            return Err(SessionError("the table shows no totals row".into()));
        }
        let mut cols = def.columns();
        let col = cols
            .iter_mut()
            .find(|c| c.name.eq_ignore_ascii_case(column))
            .ok_or_else(|| SessionError(format!("no column {column:?} in {name}")))?;
        col.totals_formula = None;
        col.totals_label = None;
        match function {
            "none" => col.totals_function = None,
            "label" => {
                col.totals_function = None;
                col.totals_label = formula_or_label.map(str::to_string);
            }
            "custom" => {
                let text = formula_or_label
                    .ok_or_else(|| SessionError("a custom total needs a formula".into()))?;
                let t = text.trim().trim_start_matches('=');
                let model = self.engine().model();
                let ctx = ModelParseCtx {
                    model,
                    current: sheet,
                };
                let f = parse(t, &ctx).map_err(|e| SessionError(format!("{text:?}: {e}")))?;
                col.totals_function = Some("custom".into());
                col.totals_formula = Some(print_ooxml(&f, sheet, &ModelSheetNames { model }));
            }
            f if subtotal_code(f).is_some() => col.totals_function = Some(f.to_string()),
            other => {
                return Err(SessionError(format!(
                    "unknown totals function {other:?} (sum, average, count, countNums, max, min, stdDev, var, custom, label, none)"
                )))
            }
        }
        def.set_columns(&cols);
        let n = def.name();
        self.commit_table(sheet, &n, &def);
        self.write_totals(sheet, &n)?;
        self.table_detail(&n)
    }

    /// Make `formula` the calculated column of `column` (display dialect,
    /// written for the column's first data row), filling every data row;
    /// `None` removes the calculated formula (the cells keep theirs).
    pub fn set_calculated_column(
        &mut self,
        name: &str,
        column: &str,
        formula: Option<&str>,
    ) -> Result<TableDetail, SessionError> {
        let (sheet, mut def) = self.table_def(name)?;
        let mut cols = def.columns();
        let col = cols
            .iter_mut()
            .find(|c| c.name.eq_ignore_ascii_case(column))
            .ok_or_else(|| SessionError(format!("no column {column:?} in {name}")))?;
        col.calculated = match formula {
            None => None,
            Some(text) => {
                let t = text.trim().trim_start_matches('=');
                let model = self.engine().model();
                let ctx = ModelParseCtx {
                    model,
                    current: sheet,
                };
                let mut f = parse(t, &ctx).map_err(|e| SessionError(format!("{text:?}: {e}")))?;
                let tname = def.name();
                rename_refs(&mut f.root, &|s: &mut StructuredRef| {
                    if s.table.is_empty() {
                        s.table = tname.as_str().into();
                    }
                });
                Some(print_ooxml(&f, sheet, &ModelSheetNames { model }))
            }
        };
        def.set_columns(&cols);
        let n = def.name();
        self.commit_table(sheet, &n, &def);
        self.fill_calculated(sheet, &n)?;
        self.table_detail(&n)
    }

    /// Fill every calculated column of table `name` down its data rows.
    fn fill_calculated(&mut self, sheet: u16, name: &str) -> Result<(), SessionError> {
        let (_, def) = self.table_def(name)?;
        let (r0, c0, r1, _) = def.range().ok_or_else(|| SessionError("no range".into()))?;
        let d0 = r0 + def.header_rows();
        let d1 = r1 - def.totals_rows();
        let mut writes = Vec::new();
        {
            let model = self.engine().model();
            let names = ModelSheetNames { model };
            let ctx = ModelParseCtx {
                model,
                current: sheet,
            };
            for (i, c) in def.columns().iter().enumerate() {
                let Some(text) = &c.calculated else {
                    continue;
                };
                let Ok(f) = parse(&strip_storage_prefixes(text), &ctx) else {
                    continue;
                };
                for r in d0..=d1 {
                    let g: Formula = if r == d0 {
                        f.clone()
                    } else {
                        rewrite_fill(&f, i64::from(r - d0), 0)
                    };
                    let input = format!("={}", print(&g, sheet, &names));
                    if cell_input_text(model, sheet, r, c0 + i as u32) != input {
                        writes.push(CellInput {
                            sheet,
                            row: r,
                            col: c0 + i as u32,
                            input,
                        });
                    }
                }
            }
        }
        if !writes.is_empty() {
            self.set_cells(&writes)?;
        }
        Ok(())
    }

    /// Table Design ▸ style and its switches.
    pub fn set_table_style(
        &mut self,
        name: &str,
        arg: TableStyleArg,
    ) -> Result<TableDetail, SessionError> {
        let (sheet, mut def) = self.table_def(name)?;
        self.guard_allow(sheet, super::protect::Allow::FormatCells)?;
        let (style, first, last, rows, cols) = def.style();
        let style = match arg.style {
            Some(s) if s.is_empty() => None,
            Some(s) => {
                if self.doc.table_style(&s).is_none() {
                    return Err(SessionError(format!("unknown table style {s:?}")));
                }
                Some(s)
            }
            None => style,
        };
        def.set_style(
            style.as_deref(),
            arg.first_column.unwrap_or(first),
            arg.last_column.unwrap_or(last),
            arg.banded_rows.unwrap_or(rows),
            arg.banded_columns.unwrap_or(cols),
        );
        let n = def.name();
        self.doc.store_table(&def);
        self.extra_dirty.insert(sheet);
        // The model's style name follows; nothing recalculates.
        let s2 = style.clone();
        if let Some(ws) = self.engine_mut().sheet_tables_mut(sheet) {
            for t in ws.iter_mut() {
                if t.name.eq_ignore_ascii_case(&n) {
                    t.style_name = s2.as_deref().map(Into::into);
                }
            }
        }
        self.table_detail(&n)
    }

    /// After a typed entry at `(row, col)`: grow a table the entry lands
    /// directly below (no totals row) or to the right of, and make a
    /// formula typed into an empty table column its calculated column.
    /// Returns whether a table changed.
    pub(crate) fn table_after_entry(
        &mut self,
        sheet: u16,
        row: u32,
        col: u32,
        input: &str,
    ) -> Result<bool, SessionError> {
        if input.trim().is_empty() {
            return Ok(false);
        }
        for def in self.doc.table_defs(sheet) {
            let Some((r0, c0, r1, c1)) = def.range() else {
                continue;
            };
            let name = def.name();
            if def.totals_rows() == 0 && row == r1 + 1 && c0 <= col && col <= c1 {
                self.resize_table(&name, &a1_range((r0, c0, r1 + 1, c1)))?;
                return Ok(true);
            }
            if col == c1 + 1 && r0 <= row && row <= r1 - def.totals_rows() {
                self.resize_table(&name, &a1_range((r0, c0, r1, c1 + 1)))?;
                return Ok(true);
            }
            let d0 = r0 + def.header_rows();
            let d1 = r1 - def.totals_rows();
            if input.trim_start().starts_with('=')
                && (d0..=d1).contains(&row)
                && (c0..=c1).contains(&col)
                && d1 > d0
            {
                let others_empty = (d0..=d1).filter(|&r| r != row).all(|r| {
                    self.engine()
                        .model()
                        .sheet(sheet)
                        .and_then(|w| w.cell(r, col))
                        .is_none_or(|c| {
                            c.formula.is_none() && matches!(c.value, sheet_core::CellValue::Empty)
                        })
                });
                let column = def.columns()[(col - c0) as usize].clone();
                if others_empty && column.calculated.is_none() {
                    // The formula as written in this row, moved to the
                    // column's first data row.
                    let model = self.engine().model();
                    let ctx = ModelParseCtx {
                        model,
                        current: sheet,
                    };
                    let names = ModelSheetNames { model };
                    let t = input.trim().trim_start_matches('=');
                    if let Ok(f) = parse(t, &ctx) {
                        let first = rewrite_fill(&f, -(i64::from(row - d0)), 0);
                        let text = print(&first, sheet, &names);
                        self.set_calculated_column(&name, &column.name, Some(&text))?;
                        return Ok(true);
                    }
                }
            }
        }
        Ok(false)
    }

    /// After cells were written: a changed header cell renames its column
    /// (blank: `ColumnN`), and the formulas over it follow.
    pub(crate) fn table_sync_headers(
        &mut self,
        cells: &[(u16, u32, u32)],
    ) -> Result<(), SessionError> {
        let sheets: BTreeSet<u16> = cells.iter().map(|c| c.0).collect();
        for sheet in sheets {
            for mut def in self.doc.table_defs(sheet) {
                if def.header_rows() == 0 {
                    continue;
                }
                let Some((r0, c0, _, c1)) = def.range() else {
                    continue;
                };
                if !cells
                    .iter()
                    .any(|&(s, r, c)| s == sheet && r == r0 && c0 <= c && c <= c1)
                {
                    continue;
                }
                let mut cols = def.columns();
                let raw: Vec<String> = (c0..=c1)
                    .map(|c| self.get_cell_display(sheet, r0, c))
                    .collect();
                let names = Self::unique_names(&raw);
                let renames: Vec<(String, String)> = cols
                    .iter()
                    .zip(&names)
                    .filter(|(c, n)| c.name != **n)
                    .map(|(c, n)| (c.name.clone(), n.clone()))
                    .collect();
                if renames.is_empty() {
                    continue;
                }
                for (c, n) in cols.iter_mut().zip(&names) {
                    c.name = n.clone();
                }
                // A header cell left blank shows the generated name.
                let fixes: Vec<(u32, String)> = names
                    .iter()
                    .zip(&raw)
                    .enumerate()
                    .filter(|(_, (n, r))| n != r)
                    .map(|(i, (n, _))| (c0 + i as u32, n.clone()))
                    .collect();
                for (c, n) in fixes {
                    let input = self
                        .engine()
                        .parse_input(sheet, &format!("'{n}"))
                        .map_err(|e| SessionError(e.to_string()))?;
                    self.engine_mut().set_cells(vec![(sheet, r0, c, input)]);
                    self.edited.insert((sheet, r0, c));
                }
                def.set_columns(&cols);
                let tname = def.name();
                self.doc.store_table(&def);
                self.extra_dirty.insert(sheet);
                let touched = self.formula_cells();
                let new_cols: Vec<String> = names.clone();
                let t2 = tname.clone();
                self.rebuild(move |m| {
                    if let Some(ws) = m.sheet_mut(sheet) {
                        for t in &mut ws.tables {
                            if t.name.eq_ignore_ascii_case(&t2) {
                                t.columns = new_cols.iter().map(|c| c.as_str().into()).collect();
                            }
                        }
                    }
                    rewrite_all_formulas(m, &|s: &mut StructuredRef| {
                        if !s.table.eq_ignore_ascii_case(&t2) {
                            return;
                        }
                        for (old, new) in &renames {
                            for c in [&mut s.col_start, &mut s.col_end].into_iter().flatten() {
                                if c.eq_ignore_ascii_case(old) {
                                    *c = new.as_str().into();
                                }
                            }
                        }
                    });
                });
                self.edited.extend(touched);
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names() {
        assert!(valid_table_name("Sales_2026"));
        assert!(!valid_table_name("A1"));
        assert!(!valid_table_name("1abc"));
        assert!(!valid_table_name("R"));
        assert_eq!(
            SheetSession::unique_names(&["a".into(), "".into(), "A".into()]),
            vec!["a", "Column2", "A2"]
        );
    }
}
