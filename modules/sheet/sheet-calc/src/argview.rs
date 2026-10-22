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

//! Range-argument views (spec §6.2/§7). When the evaluator materializes a
//! function argument that is a range (an [`Expr::Range`], or a bare
//! [`Expr::Ref`] for a `ref_args` function), it must hand the kernel a
//! [`sheet_fn::RangeView`] that reads the **already-computed** cell values
//! out of the model. `topo` order guarantees those values are fresh.
//!
//! ## Borrowed, not copied
//!
//! A [`RangeBuf`] does NOT copy the range. It holds a lazy getter that reads
//! the model's sparse grid on demand, and lends it to the kernel through
//! [`sheet_fn::RangeView::from_fn`]. A kernel that reads three cells of a
//! 10 000-cell lookup table reads three cells; nothing is allocated per cell
//! and a blank is never stored. (Before 2026-10, every evaluation copied
//! every cell of every range argument, blanks included — a VLOOKUP over a
//! 1000×2 table copied 2000 cells per evaluation.)
//!
//! ## Used-range cap
//!
//! The view's GEOMETRY is the full requested range (`rows`/`cols` are what
//! the kernel expects — `ROWS`, `INDEX`, `COUNTBLANK` and `MATCH` positions
//! depend on it), but READS are capped at the sheet's populated rows: a read
//! above the first or below the last populated row answers
//! [`CellValue::Empty`] without touching the grid. The row bounds are the
//! sparse map's first and last keys (`O(log n)`, computed once per view), so
//! a whole-column reference costs nothing beyond the populated rows' lookups.
//! Columns are not capped (a column bound needs a full scan of the grid).
//!
//! `materialize_*` keep their names — they are what the evaluator calls — but
//! they build views, and the `cells_materialized` work counter (cells COPIED)
//! stays at zero; the cells a kernel actually reads are counted as
//! `cells_read`.

use std::rc::Rc;

use sheet_core::{CellRef, CellValue, RangeRef, SheetModel, Worksheet};

use crate::accel::{self, ColSnap};

/// A lazy getter over relative `(row, col)` coordinates.
type Getter<'m> = Box<dyn Fn(u32, u32) -> CellValue + 'm>;

/// A borrowed range argument: the geometry a [`sheet_fn::RangeView`] needs
/// plus a getter that reads the model on demand. Build with
/// [`materialize_range`], then call [`RangeBuf::view`] to lend a view to a
/// kernel. Borrows the model for `'m`.
pub struct RangeBuf<'m> {
    origin: CellRef,
    rows: u32,
    cols: u32,
    get: Getter<'m>,
    /// Relative rows `[lo, hi)` that may hold a value (the populated rows
    /// clipped to the window); `None` for an owned block.
    live: Option<(u32, u32)>,
    /// When the view reads per-recalc column snapshots ([`crate::accel`])
    /// instead of the sparse grid: the sheet range it covers and one snapshot
    /// per column. The accelerated function paths read it; kernels never do.
    src: Option<Src>,
}

/// The sheet area behind a snapshot-backed [`RangeBuf`] (see
/// [`crate::accel`]): normalized top-left, geometry, live rows and the
/// column snapshots covering `live` (one per column, left to right).
pub(crate) struct Src {
    pub(crate) sheet: sheet_core::SheetId,
    pub(crate) row0: u32,
    pub(crate) col0: u32,
    pub(crate) rows: u32,
    pub(crate) cols: u32,
    pub(crate) live: (u32, u32),
    pub(crate) snaps: smallvec::SmallVec<[Rc<ColSnap>; 2]>,
}

impl<'m> RangeBuf<'m> {
    /// Lend a [`sheet_fn::RangeView`] over this range. The view borrows the
    /// buffer for as long as the returned value lives.
    pub fn view(&self) -> sheet_fn::RangeView<'_> {
        let v = sheet_fn::RangeView::from_fn(self.origin, self.rows, self.cols, &*self.get);
        match self.live {
            Some((lo, hi)) => v.with_live_rows(lo, hi),
            None => v,
        }
    }

    /// Geometry accessors (used by `ROW`/`COLUMN` materialization in eval).
    pub fn rows(&self) -> u32 {
        self.rows
    }
    pub fn cols(&self) -> u32 {
        self.cols
    }
    pub fn origin(&self) -> CellRef {
        self.origin
    }

    /// Own an evaluated 2-D block (a nested dynamic-array result or an array
    /// literal used as an argument) so a kernel reads it through the same
    /// [`sheet_fn::RangeView`] door as a sheet range. Ragged rows pad with
    /// `Empty`; `origin` is only an anchor (the block has no sheet address).
    pub fn from_grid(origin: CellRef, grid: Vec<Vec<CellValue>>) -> RangeBuf<'m> {
        let rows = grid.len() as u32;
        let cols = grid.iter().map(|r| r.len()).max().unwrap_or(0) as u32;
        let mut cells = Vec::with_capacity(rows as usize * cols as usize);
        for mut row in grid {
            row.resize(cols as usize, CellValue::Empty);
            cells.extend(row);
        }
        // The block is owned by the getter (it is a computed value, not a
        // sheet range — there is no model to borrow).
        let get: Getter<'m> = Box::new(move |r: u32, c: u32| -> CellValue {
            cells
                .get(r as usize * cols as usize + c as usize)
                .cloned()
                .unwrap_or(CellValue::Empty)
        });
        RangeBuf {
            origin,
            rows,
            cols,
            get,
            live: None,
            src: None,
        }
    }

    /// The snapshot area behind this view, when it has one.
    pub(crate) fn src(&self) -> Option<&Src> {
        self.src.as_ref()
    }

    /// A zero-row view with this view's origin and width — what an
    /// accelerated lookup hands its kernel when the index proves there is no
    /// match (the kernel then answers its own not-found).
    pub(crate) fn no_rows(&self) -> RangeBuf<'m> {
        RangeBuf {
            origin: self.origin,
            rows: 0,
            cols: self.cols,
            get: Box::new(|_, _| CellValue::Empty),
            live: Some((0, 0)),
            src: None,
        }
    }
}

/// Read a single cell's current value out of the model (`Empty` if blank or
/// the sheet does not exist). The evaluator relies on `topo` order so this is
/// the *fresh* value, never a stale one.
pub fn cell_value(model: &SheetModel, cell: CellRef) -> CellValue {
    model
        .sheet(cell.sheet)
        .and_then(|ws| ws.cell(cell.row, cell.col))
        .map(|c| c.value.clone())
        .unwrap_or(CellValue::Empty)
}

/// The populated row span of a worksheet (`None` when it has no cells): the
/// first and last keys of the row-major sparse map, `O(log n)`.
fn populated_rows(ws: &Worksheet) -> Option<(u32, u32)> {
    let first = ws.cells.keys().next()?.0;
    let last = ws.cells.keys().next_back()?.0;
    Some((first, last))
}

/// Build the lazy getter for the normalized range `n`, optionally masking
/// cells (read as blank) for which `mask` answers `true`.
fn window<'m>(
    model: &'m SheetModel,
    n: RangeRef,
    mask: Option<fn(&SheetModel, CellRef) -> bool>,
) -> RangeBuf<'m> {
    perf_count!(ranges_materialized, 1);
    let (sheet, row0, col0) = (n.start.sheet, n.start.row, n.start.col);
    let ws = model.sheet(sheet);
    // Reads outside the populated rows answer Empty without a lookup.
    let bounds = ws.and_then(populated_rows);
    if mask.is_none() {
        if let Some(buf) = snapshot_window(model, n, bounds) {
            return buf;
        }
    }
    let get: Getter<'m> = Box::new(move |r: u32, c: u32| -> CellValue {
        let (Some(ws), Some((lo, hi))) = (ws, bounds) else {
            perf_count!(cells_visited, 1);
            return CellValue::Empty;
        };
        perf_count!(cells_visited, 1);
        let (row, col) = (row0.saturating_add(r), col0.saturating_add(c));
        if row < lo || row > hi {
            return CellValue::Empty;
        }
        perf_count!(cells_read, 1);
        let Some(cell) = ws.cell(row, col) else {
            return CellValue::Empty;
        };
        if let Some(mask) = mask {
            let at = CellRef {
                sheet,
                row,
                col,
                row_abs: false,
                col_abs: false,
            };
            if mask(model, at) {
                return CellValue::Empty;
            }
        }
        cell.value.clone()
    });
    // The window's live rows: the populated rows clipped to it, relative.
    let rows = n.rows();
    let live = match bounds {
        Some((lo, hi)) if hi >= row0 && lo <= row0.saturating_add(rows - 1) => {
            Some((lo.saturating_sub(row0), (hi - row0 + 1).min(rows)))
        }
        _ => Some((0, 0)),
    };
    RangeBuf {
        origin: n.start,
        rows,
        cols: n.cols(),
        get,
        live,
        src: None,
    }
}

/// The live rows of a window starting at `row0` with `rows` rows, given the
/// sheet's populated row span (relative `[lo, hi)`; empty when disjoint).
fn live_of(bounds: Option<(u32, u32)>, row0: u32, rows: u32) -> (u32, u32) {
    match bounds {
        Some((lo, hi)) if rows > 0 && hi >= row0 && lo <= row0.saturating_add(rows - 1) => {
            (lo.saturating_sub(row0), (hi - row0 + 1).min(rows))
        }
        _ => (0, 0),
    }
}

/// Build the view over per-recalc column snapshots ([`crate::accel`]) when
/// the accelerators are on, the range is narrow enough and its live rows are
/// many enough; `None` falls back to reading the sparse grid.
fn snapshot_window<'m>(
    model: &'m SheetModel,
    n: RangeRef,
    bounds: Option<(u32, u32)>,
) -> Option<RangeBuf<'m>> {
    let (sheet, row0, col0) = (n.start.sheet, n.start.row, n.start.col);
    let (rows, cols) = (n.rows(), n.cols());
    if cols > accel::MAX_COLS {
        return None;
    }
    let live = live_of(bounds, row0, rows);
    if live.1 - live.0 < accel::MIN_ROWS {
        return None;
    }
    let (a, b) = (row0 + live.0, row0 + live.1 - 1);
    let mut snaps: smallvec::SmallVec<[Rc<ColSnap>; 2]> = smallvec::SmallVec::new();
    for c in col0..col0 + cols {
        snaps.push(accel::column(model, sheet, c, a, b)?);
    }
    Some(snap_buf(
        model,
        Src {
            sheet,
            row0,
            col0,
            rows,
            cols,
            live,
            snaps,
        },
        n.start,
    ))
}

/// Wrap a snapshot area as a [`RangeBuf`]: the getter reads the snapshots
/// (rows outside `live` are blank by construction).
fn snap_buf<'m>(model: &'m SheetModel, src: Src, origin: CellRef) -> RangeBuf<'m> {
    let (row0, col0, live) = (src.row0, src.col0, src.live);
    let snaps = src.snaps.clone();
    let ws = model.sheet(src.sheet);
    let get: Getter<'m> = Box::new(move |r: u32, c: u32| -> CellValue {
        perf_count!(cells_visited, 1);
        if r < live.0 || r >= live.1 {
            return CellValue::Empty;
        }
        let row = row0 + r;
        match snaps.get(c as usize).and_then(|s| s.get(row)) {
            Some(v) => v.clone(),
            // Never reached (the snapshots cover the live rows); stay total.
            None => {
                perf_count!(cells_read, 1);
                ws.and_then(|ws| ws.cell(row, col0 + c))
                    .map(|cell| cell.value.clone())
                    .unwrap_or(CellValue::Empty)
            }
        }
    });
    RangeBuf {
        origin,
        rows: src.rows,
        cols: src.cols,
        get,
        live: Some(live),
        src: Some(src),
    }
}

/// The same snapshot area cut to `n_rows` rows starting `rel` rows below its
/// top (an accelerated lookup's one-row window onto the row it found). The
/// cut keeps the column snapshots, so it reads no grid cell.
pub(crate) fn narrow<'m>(
    model: &'m SheetModel,
    buf: &RangeBuf<'m>,
    rel: u32,
    n_rows: u32,
) -> Option<RangeBuf<'m>> {
    let src = buf.src.as_ref()?;
    let row0 = src.row0 + rel;
    let live = (
        src.live.0.saturating_sub(rel).min(n_rows),
        src.live.1.saturating_sub(rel).min(n_rows),
    );
    let origin = CellRef {
        row: row0,
        ..buf.origin
    };
    Some(snap_buf(
        model,
        Src {
            sheet: src.sheet,
            row0,
            col0: src.col0,
            rows: n_rows,
            cols: src.cols,
            live,
            snaps: src.snaps.clone(),
        },
        origin,
    ))
}

/// View a (possibly un-normalized) range as a [`RangeBuf`]. The geometry is
/// the FULL requested range (so `rows`/`cols` match what the kernel expects);
/// cells are read from the model on demand, blanks as [`CellValue::Empty`].
/// The `origin` is the normalized top-left.
pub fn materialize_range(model: &SheetModel, range: RangeRef) -> RangeBuf<'_> {
    window(model, range.normalized(), None)
}

/// View a range like [`materialize_range`], but MASK each cell for which
/// `mask` returns `true` to [`CellValue::Empty`]. Used by SUBTOTAL / AGGREGATE
/// to EXCLUDE cells that are themselves nested SUBTOTAL/AGGREGATE results
/// (ECMA-376 §18.17.7 — a SUBTOTAL never re-aggregates another SUBTOTAL inside
/// its range). A masked cell reads as blank, so every inner aggregate skips it
/// (value aggregates and COUNTA alike — `scan_refs` treats `Empty` as blank).
/// `mask` is called with the model and the cell's absolute [`CellRef`], for
/// populated cells only (a blank reads blank either way); the geometry is
/// still the FULL requested range.
pub fn materialize_range_masked(
    model: &SheetModel,
    range: RangeRef,
    mask: fn(&SheetModel, CellRef) -> bool,
) -> RangeBuf<'_> {
    window(model, range.normalized(), Some(mask))
}

/// View a single cell as a 1×1 [`RangeBuf`] carrying its origin — used for
/// `ref_args` functions (`ROW`/`COLUMN`) handed a bare cell reference: the
/// kernel needs the *reference*, not the value.
pub fn materialize_ref_1x1(model: &SheetModel, cell: CellRef) -> RangeBuf<'_> {
    let n = RangeRef {
        start: cell,
        end: cell,
    };
    // Not normalized: the origin keeps the caller's reference flags.
    window(model, n, None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sheet_core::Cell;

    fn cr(sheet: u16, row: u32, col: u32) -> CellRef {
        CellRef {
            sheet,
            row,
            col,
            row_abs: false,
            col_abs: false,
        }
    }

    fn model_with(cells: &[(u32, u32, CellValue)]) -> SheetModel {
        let mut m = SheetModel::new();
        m.add_sheet("Sheet1");
        let ws = m.sheet_mut(0).unwrap();
        for (r, c, v) in cells {
            ws.set_cell(
                *r,
                *c,
                Cell {
                    value: v.clone(),
                    ..Default::default()
                },
            );
        }
        m
    }

    #[test]
    fn materialize_row_major_with_blanks() {
        let m = model_with(&[
            (0, 0, CellValue::Number(1.0)),
            (0, 1, CellValue::Number(2.0)),
            // (1,0) blank
            (1, 1, CellValue::Number(4.0)),
        ]);
        let range = RangeRef {
            start: cr(0, 0, 0),
            end: cr(0, 1, 1),
        };
        let buf = materialize_range(&m, range);
        let v = buf.view();
        assert_eq!(v.rows(), 2);
        assert_eq!(v.cols(), 2);
        assert_eq!(v.get(0, 0), CellValue::Number(1.0));
        assert_eq!(v.get(0, 1), CellValue::Number(2.0));
        assert_eq!(v.get(1, 0), CellValue::Empty);
        assert_eq!(v.get(1, 1), CellValue::Number(4.0));
        assert_eq!(v.origin(), cr(0, 0, 0));
    }

    #[test]
    fn ref_1x1_carries_origin() {
        let m = model_with(&[(3, 4, CellValue::Number(9.0))]);
        let buf = materialize_ref_1x1(&m, cr(0, 3, 4));
        assert_eq!(buf.origin(), cr(0, 3, 4));
        assert_eq!(buf.view().get(0, 0), CellValue::Number(9.0));
    }

    #[test]
    fn cell_value_of_missing_is_empty() {
        let m = model_with(&[]);
        assert_eq!(cell_value(&m, cr(0, 0, 0)), CellValue::Empty);
        // Non-existent sheet -> Empty, never a panic.
        assert_eq!(cell_value(&m, cr(9, 0, 0)), CellValue::Empty);
    }
}
