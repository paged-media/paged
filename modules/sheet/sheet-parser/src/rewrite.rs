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

//! Structural rewrite (spec §6.1/§6.3): adjust the references in a formula
//! when rows/columns are inserted or deleted. Rulings:
//!
//! - **Absolute (`$`) flags do NOT exempt a ref from a structural shift.**
//!   In Excel `$` affects copy/fill, not insert/delete — `$A$1` still moves
//!   down when a row is inserted above it. (Copy/fill rewrite, where `$`
//!   *does* matter, is T1 — see [`rewrite_fill`], a documented stub.)
//! - **Out-of-bounds shift → `#REF!`.** A ref pushed past `MAX_ROW`/`MAX_COL`
//!   by an insert collapses to `Expr::Lit(Error(Ref))`.
//! - **A ref inside a deleted span → `#REF!`.** A range fully inside the span
//!   collapses; a range partially overlapping the span clips to the survivor.
//! - Only refs on the SAME `sheet` as the edit move; a 3D reference never
//!   moves (it addresses every sheet of its span).

use sheet_core::ast::{Expr, Formula, LitValue};
use sheet_core::{CellError, CellRef, RangeRef, SheetId, MAX_COL, MAX_ROW};

/// A structural edit. `at` is the 0-based first affected row/col; `n` the
/// count. `sheet` scopes the edit — refs on other sheets are untouched.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum Edit {
    InsertRows { sheet: SheetId, at: u32, n: u32 },
    DeleteRows { sheet: SheetId, at: u32, n: u32 },
    InsertCols { sheet: SheetId, at: u32, n: u32 },
    DeleteCols { sheet: SheetId, at: u32, n: u32 },
}

/// Which axis an edit operates on.
#[derive(Copy, Clone, PartialEq, Eq)]
enum Axis {
    Row,
    Col,
}

/// Insert vs delete.
#[derive(Copy, Clone, PartialEq, Eq)]
enum Kind {
    Insert,
    Delete,
}

struct Plan {
    sheet: SheetId,
    axis: Axis,
    kind: Kind,
    at: u32,
    n: u32,
}

impl Edit {
    fn plan(&self) -> Plan {
        match *self {
            Edit::InsertRows { sheet, at, n } => Plan {
                sheet,
                axis: Axis::Row,
                kind: Kind::Insert,
                at,
                n,
            },
            Edit::DeleteRows { sheet, at, n } => Plan {
                sheet,
                axis: Axis::Row,
                kind: Kind::Delete,
                at,
                n,
            },
            Edit::InsertCols { sheet, at, n } => Plan {
                sheet,
                axis: Axis::Col,
                kind: Kind::Insert,
                at,
                n,
            },
            Edit::DeleteCols { sheet, at, n } => Plan {
                sheet,
                axis: Axis::Col,
                kind: Kind::Delete,
                at,
                n,
            },
        }
    }
}

/// Rewrite every reference in `f` for the structural `edit`.
pub fn rewrite(f: &Formula, edit: &Edit) -> Formula {
    let plan = edit.plan();
    Formula {
        root: rewrite_expr(&f.root, &plan),
    }
}

/// Copy/fill/move rewrite (spec §6.1): the formula as it reads after being
/// copied `drow` rows down and `dcol` columns right. Unlike insert/delete this
/// HONOURS `$` flags: a relative coordinate shifts by the delta, an absolute
/// one does not (each range endpoint by its own flags). A coordinate pushed
/// off the grid makes that reference `#REF!` (Excel). Structured references
/// are name-anchored and do not move; a spill reference moves its anchor.
/// Used by the range sort, which moves formula rows the way Excel does.
pub fn rewrite_fill(f: &Formula, drow: i64, dcol: i64) -> Formula {
    Formula {
        root: fill_expr(&f.root, drow, dcol),
    }
}

fn fill_cell(c: CellRef, drow: i64, dcol: i64) -> Option<CellRef> {
    let shift = |v: u32, abs: bool, d: i64, max: u32| -> Option<u32> {
        if abs {
            return Some(v);
        }
        let n = v as i64 + d;
        (0..=max as i64).contains(&n).then_some(n as u32)
    };
    Some(CellRef {
        row: shift(c.row, c.row_abs, drow, MAX_ROW)?,
        col: shift(c.col, c.col_abs, dcol, MAX_COL)?,
        ..c
    })
}

fn fill_expr(e: &Expr, drow: i64, dcol: i64) -> Expr {
    let f = |x: &Expr| fill_expr(x, drow, dcol);
    match e {
        Expr::Lit(_) | Expr::Name(_) | Expr::StructuredRef(_) | Expr::Local(_) | Expr::Missing => {
            e.clone()
        }
        Expr::Ref(r) => match fill_cell(*r, drow, dcol) {
            Some(c) => Expr::Ref(c),
            None => ref_error(),
        },
        Expr::Range(r) => match (fill_cell(r.start, drow, dcol), fill_cell(r.end, drow, dcol)) {
            (Some(start), Some(end)) => Expr::Range(RangeRef { start, end }),
            _ => ref_error(),
        },
        Expr::Unary(op, a) => Expr::Unary(*op, Box::new(f(a))),
        Expr::Binary(op, a, b) => Expr::Binary(*op, Box::new(f(a)), Box::new(f(b))),
        Expr::Func(fid, args) => Expr::Func(*fid, args.iter().map(f).collect()),
        Expr::Array(rows) => Expr::Array(rows.iter().map(|r| r.iter().map(f).collect()).collect()),
        Expr::SpillRef(a) => Expr::SpillRef(Box::new(f(a))),
        Expr::Call(c, args) => Expr::Call(Box::new(f(c)), args.iter().map(f).collect()),
        // A copied 3D reference moves like a plain one (on every sheet).
        Expr::Ref3D(r) => match fill_cell(r.cell, drow, dcol) {
            Some(cell) => Expr::Ref3D(sheet_core::ast::Ref3D { cell, ..*r }),
            None => ref_error(),
        },
        Expr::Range3D(r) => match (
            fill_cell(r.range.start, drow, dcol),
            fill_cell(r.range.end, drow, dcol),
        ) {
            (Some(start), Some(end)) => Expr::Range3D(sheet_core::ast::Range3D {
                range: RangeRef { start, end },
                ..*r
            }),
            _ => ref_error(),
        },
        Expr::UnknownName(_) => e.clone(),
        Expr::UnknownFunc(name, args) => {
            Expr::UnknownFunc(name.clone(), args.iter().map(f).collect())
        }
    }
}

fn rewrite_expr(e: &Expr, plan: &Plan) -> Expr {
    match e {
        Expr::Lit(_) | Expr::Name(_) | Expr::Missing => e.clone(),
        Expr::Ref(r) => match shift_cell(*r, plan) {
            Some(c) => Expr::Ref(c),
            None => ref_error(),
        },
        Expr::Range(r) => match shift_range(*r, plan) {
            Some(rr) => Expr::Range(rr),
            None => ref_error(),
        },
        Expr::Unary(op, inner) => Expr::Unary(*op, Box::new(rewrite_expr(inner, plan))),
        Expr::Binary(op, a, b) => Expr::Binary(
            *op,
            Box::new(rewrite_expr(a, plan)),
            Box::new(rewrite_expr(b, plan)),
        ),
        Expr::Func(fid, args) => {
            Expr::Func(*fid, args.iter().map(|a| rewrite_expr(a, plan)).collect())
        }
        Expr::Array(rows) => Expr::Array(
            rows.iter()
                .map(|row| row.iter().map(|el| rewrite_expr(el, plan)).collect())
                .collect(),
        ),
        // Structured refs are NAME-anchored (they address a table by name and
        // a column by label, not by A1 geometry), so a row/col insert/delete
        // does not shift them — the table model moves with the edit and the
        // ref re-resolves through the (unchanged) name. Pass through verbatim.
        Expr::StructuredRef(_) => e.clone(),
        // A spill ref's geometry is its anchor's; rewrite the inner anchor and
        // keep the `#` (spill) wrapper.
        Expr::SpillRef(inner) => Expr::SpillRef(Box::new(rewrite_expr(inner, plan))),
        Expr::Local(_) => e.clone(),
        Expr::Call(callee, args) => Expr::Call(
            Box::new(rewrite_expr(callee, plan)),
            args.iter().map(|a| rewrite_expr(a, plan)).collect(),
        ),
        // A 3D reference addresses the same cells on EVERY sheet of its span,
        // so a row or column inserted on one of them does not move it (Excel
        // keeps a 3D reference's address; sheet ADR 513).
        Expr::Ref3D(_) | Expr::Range3D(_) | Expr::UnknownName(_) => e.clone(),
        Expr::UnknownFunc(name, args) => Expr::UnknownFunc(
            name.clone(),
            args.iter().map(|a| rewrite_expr(a, plan)).collect(),
        ),
    }
}

fn ref_error() -> Expr {
    Expr::Lit(LitValue::Error(CellError::Ref))
}

/// The coordinate of `cell` on `plan.axis`, plus the axis maximum.
fn coord(cell: &CellRef, axis: Axis) -> (u32, u32) {
    match axis {
        Axis::Row => (cell.row, MAX_ROW),
        Axis::Col => (cell.col, MAX_COL),
    }
}

/// Shift a single cell. Returns `None` (→ `#REF!`) if the cell is deleted or
/// pushed out of bounds. Cells on a different sheet are unchanged.
fn shift_cell(cell: CellRef, plan: &Plan) -> Option<CellRef> {
    if cell.sheet != plan.sheet {
        return Some(cell);
    }
    let (c, max) = coord(&cell, plan.axis);
    let nc = shift_coord(c, plan, max)?;
    Some(set_coord(cell, plan.axis, nc))
}

/// Shift a single coordinate (a cell's row or col). `None` = the cell is
/// inside a deleted span, or an insert pushed it past `max`.
fn shift_coord(c: u32, plan: &Plan, max: u32) -> Option<u32> {
    match plan.kind {
        Kind::Insert => {
            if c >= plan.at {
                let nc = c as u64 + plan.n as u64;
                if nc > max as u64 {
                    None // pushed off the grid
                } else {
                    Some(nc as u32)
                }
            } else {
                Some(c)
            }
        }
        Kind::Delete => {
            let end = plan.at as u64 + plan.n as u64; // exclusive
            if (c as u64) < plan.at as u64 {
                Some(c) // before the span: unchanged
            } else if (c as u64) < end {
                None // inside the span: deleted
            } else {
                Some((c as u64 - plan.n as u64) as u32) // after: shift back
            }
        }
    }
}

/// Shift a range. Endpoints are normalized on `plan.axis` first; a range
/// fully inside a deleted span → `None`; a partial overlap clips to the
/// surviving sub-interval; an insert that pushes the end off-grid → `None`.
fn shift_range(r: RangeRef, plan: &Plan) -> Option<RangeRef> {
    if r.start.sheet != plan.sheet {
        return Some(r);
    }
    // A whole-column band (`A:C`) never moves on a row edit, nor a whole-row
    // band (`1:3`) on a column edit: it still spans the whole grid (Excel).
    let whole = match plan.axis {
        Axis::Row => r.spans_all_rows(),
        Axis::Col => r.spans_all_cols(),
    };
    if whole {
        return Some(r);
    }
    let n = r.normalized();
    let (s, max) = coord(&n.start, plan.axis);
    let (e, _) = coord(&n.end, plan.axis);

    let (ns, ne) = match plan.kind {
        Kind::Insert => {
            // Both endpoints shift if at/after `at`; an insert never deletes.
            let ns = shift_coord(s, plan, max)?;
            let ne = shift_coord(e, plan, max)?;
            (ns, ne)
        }
        Kind::Delete => {
            let span_end = plan.at as u64 + plan.n as u64; // exclusive
            let s64 = s as u64;
            let e64 = e as u64;
            // Fully inside the deleted span → whole range gone.
            if s64 >= plan.at as u64 && e64 < span_end {
                return None;
            }
            // New start: if before the span, unchanged; if inside, clip to
            // the span's left edge (`at`, which after deletion is the first
            // surviving row); if after, shift back.
            let ns = if s64 < plan.at as u64 {
                s
            } else if s64 < span_end {
                plan.at // clip up to the boundary
            } else {
                (s64 - plan.n as u64) as u32
            };
            // New end: if before the span, unchanged; if inside, clip to the
            // last row before the span (`at - 1`, guaranteed >= ns here); if
            // after, shift back.
            let ne = if e64 < plan.at as u64 {
                e
            } else if e64 < span_end {
                plan.at.saturating_sub(1)
            } else {
                (e64 - plan.n as u64) as u32
            };
            (ns, ne)
        }
    };

    let start = set_coord(n.start, plan.axis, ns);
    let end = set_coord(n.end, plan.axis, ne);
    Some(RangeRef { start, end })
}

/// Return `cell` with its `axis` coordinate replaced.
fn set_coord(mut cell: CellRef, axis: Axis, v: u32) -> CellRef {
    match axis {
        Axis::Row => cell.row = v,
        Axis::Col => cell.col = v,
    }
    cell
}

// ── Text-level structural shift ─────────────────────────────────────────
//
// The preserved content of a workbook (conditional formats, validations,
// defined names, chart series, drawing anchors …) holds references as TEXT
// the engine never parses into an AST. A row/column insert or delete moves
// them exactly as [`rewrite`] moves a parsed formula: the same coordinate
// rules (`$` does not exempt, a deleted span is `#REF!`, a partially
// deleted range clips), applied token by token so everything else in the
// text — names, strings, functions, spacing — is kept byte for byte.

/// A structural edit as seen from one piece of reference TEXT: the edit, the
/// NAME of the edited sheet (a qualifier `Name!` matches it case-insensitively,
/// Excel sheet-name semantics) and whether an unqualified reference in this
/// text sits on the edited sheet (the text's host sheet is the edited one).
#[derive(Copy, Clone, Debug)]
pub struct TextShift<'a> {
    /// The edit; its `sheet` field is ignored (text names sheets by name).
    pub edit: Edit,
    /// The edited sheet's name.
    pub sheet_name: &'a str,
    /// True when unqualified references in the text are on the edited sheet.
    pub host_is_target: bool,
}

/// Why a reference text cannot be shifted. The caller keeps the text and
/// refuses the edit rather than leave it pointing at the wrong cells.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Unshiftable(pub String);

impl std::fmt::Display for Unshiftable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// One reference found in the token stream: its byte span (qualifier
/// included) and the range it names (a single cell is a 1×1 range).
struct TextRef {
    span: std::ops::Range<usize>,
    /// The qualifier text as written (`Sheet1!`, `'My Sheet'!`), if any.
    qual: Option<std::ops::Range<usize>>,
    on_target: bool,
    range: RangeRef,
    shape: RefShape,
}

#[derive(Copy, Clone, PartialEq, Eq)]
enum RefShape {
    Cell,
    Area,
    Cols,
    Rows,
}

/// The references of `text`, in order. `Err` when the text does not lex or
/// names a sheet span (`Sheet1:Sheet3!A1`) the text alone cannot place.
fn text_refs(text: &str, s: &TextShift<'_>) -> Result<Vec<TextRef>, Unshiftable> {
    use crate::lexer::{lex, TokKind};
    let toks = lex(text).map_err(|e| Unshiftable(format!("does not lex: {}", e.message)))?;
    let cell = |row: u32, col: u32, row_abs: bool, col_abs: bool, on: bool| CellRef {
        sheet: if on { 0 } else { 1 },
        row,
        col,
        row_abs,
        col_abs,
    };
    let mut out = Vec::new();
    let mut i = 0;
    while i < toks.len() {
        let start_tok = i;
        let mut on = s.host_is_target;
        let mut qual = None;
        if let TokKind::SheetQual(name) = &toks[i].kind {
            // `Jan:Mar!A1` lexes as `Jan` `:` `Mar!` — a 3D reference over a
            // span of sheets the text alone cannot place.
            let spans_sheets = i >= 2
                && matches!(toks[i - 1].kind, TokKind::Colon)
                && matches!(toks[i - 2].kind, TokKind::Ident(_) | TokKind::Cell { .. });
            if name.contains(':') || spans_sheets {
                return Err(Unshiftable(format!(
                    "a reference over a span of sheets (…:{name}!)"
                )));
            }
            on = name.eq_ignore_ascii_case(s.sheet_name);
            qual = Some(toks[i].span.clone());
            i += 1;
            if i >= toks.len() {
                break;
            }
        }
        let start = toks[start_tok].span.start;
        match toks[i].kind {
            TokKind::Cell {
                row,
                col,
                row_abs,
                col_abs,
            } => {
                let a = cell(row, col, row_abs, col_abs, on);
                // `A1:B2` (optionally `A1:Sheet!B2` with the same sheet).
                let mut end_tok = i;
                let mut b = a;
                if let (Some(colon), Some(next)) = (toks.get(i + 1), toks.get(i + 2)) {
                    if matches!(colon.kind, TokKind::Colon) && !colon.ws_before {
                        let (k, nq) = match &next.kind {
                            TokKind::SheetQual(n) => (i + 3, Some(n.as_str())),
                            _ => (i + 2, None),
                        };
                        let same_sheet =
                            nq.is_none_or(|n| n.eq_ignore_ascii_case(s.sheet_name) == on);
                        if let Some(TokKind::Cell {
                            row,
                            col,
                            row_abs,
                            col_abs,
                        }) = toks.get(k).map(|t| &t.kind)
                        {
                            if same_sheet && !toks[k].ws_before {
                                b = cell(*row, *col, *row_abs, *col_abs, on);
                                end_tok = k;
                            }
                        }
                    }
                }
                out.push(TextRef {
                    span: start..toks[end_tok].span.end,
                    qual,
                    on_target: on,
                    range: RangeRef { start: a, end: b },
                    shape: if end_tok == i {
                        RefShape::Cell
                    } else {
                        RefShape::Area
                    },
                });
                i = end_tok + 1;
            }
            TokKind::Cols { c0, c1, abs0, abs1 } => {
                out.push(TextRef {
                    span: start..toks[i].span.end,
                    qual,
                    on_target: on,
                    range: RangeRef {
                        start: cell(0, c0, true, abs0, on),
                        end: cell(MAX_ROW, c1, true, abs1, on),
                    },
                    shape: RefShape::Cols,
                });
                i += 1;
            }
            TokKind::Rows { r0, r1, abs0, abs1 } => {
                out.push(TextRef {
                    span: start..toks[i].span.end,
                    qual,
                    on_target: on,
                    range: RangeRef {
                        start: cell(r0, 0, abs0, true, on),
                        end: cell(r1, MAX_COL, abs1, true, on),
                    },
                    shape: RefShape::Rows,
                });
                i += 1;
            }
            _ => i += 1,
        }
    }
    Ok(out)
}

/// Print a shifted reference in the shape it was written in.
fn print_text_ref(r: &RangeRef, shape: RefShape) -> String {
    let d = |abs: bool| if abs { "$" } else { "" };
    let cell = |c: &CellRef| {
        format!(
            "{}{}{}{}",
            d(c.col_abs),
            sheet_core::col_to_a1(c.col),
            d(c.row_abs),
            c.row + 1
        )
    };
    match shape {
        RefShape::Cell => cell(&r.start),
        RefShape::Area => format!("{}:{}", cell(&r.start), cell(&r.end)),
        RefShape::Cols => format!(
            "{}{}:{}{}",
            d(r.start.col_abs),
            sheet_core::col_to_a1(r.start.col),
            d(r.end.col_abs),
            sheet_core::col_to_a1(r.end.col)
        ),
        RefShape::Rows => format!(
            "{}{}:{}{}",
            d(r.start.row_abs),
            r.start.row + 1,
            d(r.end.row_abs),
            r.end.row + 1
        ),
    }
}

/// The edit as a plan over the synthetic sheet 0 (the edited sheet).
fn text_plan(edit: &Edit) -> Plan {
    let mut p = edit.plan();
    p.sheet = 0;
    p
}

/// Shift one range by `plan`, keeping its written orientation for a single
/// cell (`None` = deleted / pushed off the grid).
fn shift_text_range(r: RangeRef, shape: RefShape, plan: &Plan) -> Option<RangeRef> {
    match shape {
        RefShape::Cell => shift_cell(r.start, plan).map(|c| RangeRef { start: c, end: c }),
        _ => shift_range(r, plan),
    }
}

/// `text` (a formula without its `=`, a defined name, a chart series `c:f`)
/// with every reference on the edited sheet moved by the edit. A deleted
/// reference reads `#REF!` (qualifier kept, as Excel writes `Sheet1!#REF!`).
/// Unchanged text is returned as it came.
pub fn shift_ref_text(text: &str, s: &TextShift<'_>) -> Result<String, Unshiftable> {
    let refs = text_refs(text, s)?;
    let plan = text_plan(&s.edit);
    let mut out = String::with_capacity(text.len() + 8);
    let mut last = 0;
    for r in refs.iter().filter(|r| r.on_target) {
        let body_start = r.qual.as_ref().map_or(r.span.start, |q| q.end);
        let piece = match shift_text_range(r.range, r.shape, &plan) {
            Some(nr) if nr == r.range => continue,
            Some(nr) => print_text_ref(&nr, r.shape),
            None => "#REF!".to_string(),
        };
        out.push_str(&text[last..body_start]);
        out.push_str(&piece);
        last = r.span.end;
    }
    out.push_str(&text[last..]);
    Ok(out)
}

/// A space-separated range list (`sqref`, `ref`, `xm:sqref`: `A1:B4 D7`) on
/// the edited sheet, shifted: a deleted range leaves the list, a partially
/// deleted one clips. `Ok(None)` when no range survives (the owner — a
/// conditional format, a validation, a hyperlink — goes with its cells, as
/// in Excel). An empty list stays empty.
pub fn shift_sqref(text: &str, s: &TextShift<'_>) -> Result<Option<String>, Unshiftable> {
    let plan = text_plan(&s.edit);
    let mut kept: Vec<String> = Vec::new();
    let mut any = false;
    for item in text.split_ascii_whitespace() {
        any = true;
        let refs = text_refs(item, s)?;
        let [r] = refs.as_slice() else {
            return Err(Unshiftable(format!("not a range list item: {item}")));
        };
        if r.span != (0..item.len()) {
            return Err(Unshiftable(format!("not a range list item: {item}")));
        }
        if !r.on_target {
            kept.push(item.to_string());
            continue;
        }
        if let Some(nr) = shift_text_range(r.range, r.shape, &plan) {
            kept.push(if nr == r.range {
                item.to_string()
            } else {
                let prefix = r.qual.as_ref().map_or("", |q| &item[q.clone()]);
                format!("{prefix}{}", print_text_ref(&nr, r.shape))
            });
        }
    }
    if !any {
        return Ok(Some(text.to_string()));
    }
    if kept.is_empty() {
        return Ok(None);
    }
    let joined = kept.join(" ");
    // Keep the original bytes (spacing) when nothing moved.
    if joined == text.split_ascii_whitespace().collect::<Vec<_>>().join(" ") {
        return Ok(Some(text.to_string()));
    }
    Ok(Some(joined))
}

/// One coordinate (a row or column INDEX, 0-based) on the edit's axis moved
/// by the edit: `None` when it is deleted or pushed off the grid. For the
/// anchors that store a bare index (drawing `xdr:row`, VML `x:Row`, page
/// breaks).
pub fn shift_index(edit: &Edit, index: u32) -> Option<u32> {
    let plan = edit.plan();
    let max = match plan.axis {
        Axis::Row => MAX_ROW,
        Axis::Col => MAX_COL,
    };
    shift_coord(index, &plan, max)
}

/// True when the edit works on rows (false: columns).
pub fn edit_is_rows(edit: &Edit) -> bool {
    edit.plan().axis == Axis::Row
}

/// A range moved by a structural edit on its own sheet (the A1 rules of
/// [`rewrite`]: an insert inside it grows it, a delete clips it). `None` when
/// the edit deletes all of it. A range on another sheet is returned as is.
pub fn shift_range_ref(r: RangeRef, edit: &Edit) -> Option<RangeRef> {
    shift_range(r, &edit.plan())
}

/// What a structural edit does to an Excel table (ListObject): its new
/// extent, the columns a column insert INSIDE it adds (offset in the new
/// column list + the generated header name) and the columns a delete removes
/// (offsets in the old list). Excel names an inserted column `ColumnN`, the
/// lowest `N` no other column of the table uses.
#[derive(Clone, Debug, PartialEq)]
pub struct TableShift {
    pub range: Option<RangeRef>,
    pub inserted: Vec<(u32, compact_str::CompactString)>,
    pub removed: Vec<u32>,
}

/// See [`TableShift`]. `range` is the table's full extent, `columns` its
/// header names left to right.
pub fn shift_table(
    range: RangeRef,
    columns: &[compact_str::CompactString],
    edit: &Edit,
) -> TableShift {
    let plan = edit.plan();
    let n = range.normalized();
    let new_range = shift_range(n, &plan);
    let mut out = TableShift {
        range: new_range,
        inserted: Vec::new(),
        removed: Vec::new(),
    };
    if n.start.sheet != plan.sheet || plan.axis != Axis::Col || new_range.is_none() {
        return out;
    }
    let (c0, c1) = (n.start.col, n.end.col);
    match plan.kind {
        Kind::Insert => {
            if plan.at > c0 && plan.at <= c1 {
                let mut used: Vec<String> = columns
                    .iter()
                    .map(|c| c.as_str().to_ascii_lowercase())
                    .collect();
                let mut k = 1u32;
                for i in 0..plan.n {
                    let name = loop {
                        let cand = format!("Column{k}");
                        k += 1;
                        if !used.contains(&cand.to_ascii_lowercase()) {
                            break cand;
                        }
                    };
                    used.push(name.to_ascii_lowercase());
                    out.inserted.push((plan.at - c0 + i, name.into()));
                }
            }
        }
        Kind::Delete => {
            let end = plan.at as u64 + plan.n as u64;
            for c in c0..=c1 {
                if (c as u64) >= plan.at as u64 && (c as u64) < end {
                    out.removed.push(c - c0);
                }
            }
        }
    }
    out
}

#[cfg(test)]
#[allow(non_snake_case)]
mod text_shift_tests {
    use super::*;

    fn ts(edit: Edit, host: bool) -> TextShift<'static> {
        TextShift {
            edit,
            sheet_name: "Data",
            host_is_target: host,
        }
    }
    const INS_ROW_2: Edit = Edit::InsertRows {
        sheet: 0,
        at: 1,
        n: 2,
    };
    const DEL_COL_B: Edit = Edit::DeleteCols {
        sheet: 0,
        at: 1,
        n: 1,
    };

    #[test]
    fn formula_text_moves_like_the_ast_rewrite__feat__sheet_calc_rewrite_structural_door() {
        let s = ts(INS_ROW_2, true);
        assert_eq!(
            shift_ref_text("SUM($A$1:A3)+B2*Rate+\"A5\"", &s).unwrap(),
            "SUM($A$1:A5)+B4*Rate+\"A5\""
        );
        // Qualified refs to another sheet stay; to the edited sheet move.
        assert_eq!(
            shift_ref_text("Other!A5+data!A5+'Data'!$B$9", &ts(INS_ROW_2, false)).unwrap(),
            "Other!A5+data!A7+'Data'!$B$11"
        );
        // Whole rows move on a row edit, whole columns do not.
        assert_eq!(
            shift_ref_text("SUM(3:4)+SUM(A:B)", &s).unwrap(),
            "SUM(5:6)+SUM(A:B)"
        );
    }

    #[test]
    fn deleted_refs_become_ref_errors_and_ranges_clip__feat__sheet_calc_rewrite_structural_door() {
        let s = ts(DEL_COL_B, true);
        assert_eq!(
            shift_ref_text("B1+C1+SUM(A1:C1)", &s).unwrap(),
            "#REF!+B1+SUM(A1:B1)"
        );
        assert_eq!(
            shift_ref_text("Data!B1", &ts(DEL_COL_B, false)).unwrap(),
            "Data!#REF!"
        );
        assert_eq!(
            shift_ref_text("SUM(B:B)+SUM(A:D)", &s).unwrap(),
            "SUM(#REF!)+SUM(A:C)"
        );
    }

    #[test]
    fn unchanged_text_is_returned_byte_for_byte__feat__sheet_calc_rewrite_structural_door() {
        let s = ts(INS_ROW_2, true);
        let t = "IF( A1 > 0 , \"x\" ,  Name1 )";
        assert_eq!(shift_ref_text(t, &s).unwrap(), t);
        assert!(shift_ref_text("\"open", &s).is_err());
        assert!(shift_ref_text("SUM(Jan:Mar!A1)", &s).is_err());
    }

    #[test]
    fn sqref_lists_shift_drop_and_clip__feat__sheet_calc_rewrite_structural_door() {
        let s = ts(INS_ROW_2, true);
        assert_eq!(
            shift_sqref("A1:B4 D7", &s).unwrap().as_deref(),
            Some("A1:B6 D9")
        );
        assert_eq!(shift_sqref("A1", &s).unwrap().as_deref(), Some("A1"));
        let d = ts(DEL_COL_B, true);
        assert_eq!(
            shift_sqref("B2 A1:C3", &d).unwrap().as_deref(),
            Some("A1:B3")
        );
        assert_eq!(shift_sqref("B2:B9", &d).unwrap(), None);
        assert_eq!(shift_sqref("", &d).unwrap().as_deref(), Some(""));
    }

    #[test]
    fn tables_grow_name_inserted_columns_and_drop_deleted_ones__feat__sheet_calc_rewrite_structural_door(
    ) {
        let r = |r0, c0, r1, c1| RangeRef {
            start: CellRef {
                sheet: 0,
                row: r0,
                col: c0,
                row_abs: false,
                col_abs: false,
            },
            end: CellRef {
                sheet: 0,
                row: r1,
                col: c1,
                row_abs: false,
                col_abs: false,
            },
        };
        let cols: Vec<compact_str::CompactString> = vec!["A".into(), "Column1".into(), "C".into()];
        let t = shift_table(
            r(0, 1, 4, 3),
            &cols,
            &Edit::InsertCols {
                sheet: 0,
                at: 2,
                n: 2,
            },
        );
        assert_eq!(t.range, Some(r(0, 1, 4, 5)));
        assert_eq!(
            t.inserted,
            vec![(1, "Column2".into()), (2, "Column3".into())]
        );
        let t = shift_table(
            r(0, 1, 4, 3),
            &cols,
            &Edit::DeleteCols {
                sheet: 0,
                at: 3,
                n: 5,
            },
        );
        assert_eq!((t.range, t.removed), (Some(r(0, 1, 4, 2)), vec![2]));
        let t = shift_table(
            r(0, 1, 4, 3),
            &cols,
            &Edit::InsertCols {
                sheet: 0,
                at: 1,
                n: 1,
            },
        );
        assert!(t.inserted.is_empty());
        let t = shift_table(
            r(0, 1, 4, 3),
            &cols,
            &Edit::DeleteRows {
                sheet: 0,
                at: 0,
                n: 9,
            },
        );
        assert_eq!(t.range, None);
    }

    #[test]
    fn bare_indexes_shift_on_their_axis__feat__sheet_calc_rewrite_structural_door() {
        assert_eq!(shift_index(&INS_ROW_2, 0), Some(0));
        assert_eq!(shift_index(&INS_ROW_2, 1), Some(3));
        assert_eq!(shift_index(&DEL_COL_B, 1), None);
        assert_eq!(shift_index(&DEL_COL_B, 5), Some(4));
        assert!(edit_is_rows(&INS_ROW_2) && !edit_is_rows(&DEL_COL_B));
    }
}
