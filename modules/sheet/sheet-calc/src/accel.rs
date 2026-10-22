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

//! Range-dependency accelerators (sheet ADR 512). One recalc evaluates many
//! formulas over the SAME columns — a running total reads `A1:A1`, `A1:A2`,
//! …, `A1:An`; ten thousand lookups read one table. Read through the sparse
//! row-major grid, each evaluation pays a tree lookup per cell, so those
//! recalcs are quadratic. This module keeps, for the length of ONE
//! [`Engine::recalc_dirty`](crate::Engine::recalc_dirty) call:
//!
//! 1. **Column snapshots** — a dense `Vec<CellValue>` per `(sheet, column)`
//!    over the rows ranges have asked for (always inside the sheet's
//!    populated rows), built on a column's SECOND range request (a lone
//!    formula keeps the plain grid read) and grown by doubling. Range views
//!    ([`crate::argview`]) read them instead of the grid. Every engine write
//!    during the recalc goes through [`note_write`], which updates the
//!    snapshot in place and drops what was derived from the old value, so a
//!    snapshot is always exactly the grid.
//! 2. **Anchored prefix aggregates** — for `SUM`, `COUNT`, `COUNTA`,
//!    `AVERAGE`, `MIN`, `MAX` over one column: the running fold from an
//!    anchor row, extended lazily. A range is answered from the prefix only
//!    when its scan starts AT the anchor, so the value is the kernel's own
//!    left-to-right fold, bit for bit (a difference of two prefixes would not
//!    be).
//! 3. **Exact-match indexes** — value → sorted rows, for `VLOOKUP`, `MATCH`,
//!    `XMATCH`, `XLOOKUP` (exact mode) and `COUNTIF` / `SUMIF` with an
//!    equality criterion; approximate `VLOOKUP` / `MATCH` binary-search a
//!    column proven sorted over the searched rows. Wildcard keys and
//!    criteria are never indexed.
//!
//! ## The kernels stay the specification
//!
//! Kernels are untouched and pure. A fast path either computes exactly what
//! the kernel's documented scan computes (the aggregates, the position
//! answers of `MATCH`/`XMATCH`/`XLOOKUP`, `COUNTIF`/`SUMIF`), or narrows a
//! lookup table to the one row the index found and lets the kernel answer
//! (`VLOOKUP`). Any argument shape a fast path does not recognise falls
//! through to the kernel. `tests/accel_equivalence.rs` runs random sheets
//! with the accelerators on and off ([`crate::Engine::set_accelerators`])
//! and requires bit-identical results.
//!
//! ## Scope
//!
//! The state is thread-local and lives exactly as long as the [`Scope`] the
//! engine opens around a recalc; a view of a different model, or any
//! evaluation outside a recalc, reads the grid as before.

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::OnceLock;

use rustc_hash::FxHashMap;
use sheet_core::{CellError, CellRef, CellValue, FuncId, SheetId, SheetModel};
use sheet_fn::coerce;

use crate::argview::{self, RangeBuf};
use crate::eval::ArgPlan;

/// The fewest live rows a range needs before it reads snapshots (below it
/// the grid read is cheaper than the bookkeeping).
pub(crate) const MIN_ROWS: u32 = 32;
/// The widest range (columns) that reads snapshots.
pub(crate) const MAX_COLS: u32 = 8;
/// Prefix anchors kept per column snapshot.
const MAX_ANCHORS: usize = 8;
/// A snapshot this long that is this sparse (`non-empty * SPARSE < rows`) is
/// abandoned for the pass: on a sparse sheet the grid read is cheaper.
const SPARSE_ROWS: usize = 4096;
const SPARSE: usize = 16;

// ---------------------------------------------------------------------------
// Per-recalc state
// ---------------------------------------------------------------------------

/// One column's state in the current recalc.
enum Col {
    /// Requested this many times without a snapshot.
    Seen,
    /// Snapshotted.
    Snap(Rc<ColSnap>),
    /// Not worth a snapshot this pass (sparse).
    Off,
}

struct State {
    /// The model the views must belong to (identity only, never read).
    model: *const SheetModel,
    cols: FxHashMap<(SheetId, u32), Col>,
}

thread_local! {
    static ACTIVE: RefCell<Option<State>> = const { RefCell::new(None) };
}

/// The accelerator state for one recalc: opened by the engine around
/// `recalc_dirty`, restored (to the enclosing state, normally none) on drop.
pub(crate) struct Scope {
    prev: Option<State>,
}

impl Scope {
    /// Open a scope over `model`. With `on == false` the scope is a hard
    /// "off" — nothing inside it is accelerated.
    pub(crate) fn enter(model: &SheetModel, on: bool) -> Scope {
        let next = on.then(|| State {
            model: model as *const SheetModel,
            cols: FxHashMap::default(),
        });
        let prev = ACTIVE.with(|a| std::mem::replace(&mut *a.borrow_mut(), next));
        Scope { prev }
    }
}

impl Drop for Scope {
    fn drop(&mut self) {
        let prev = self.prev.take();
        ACTIVE.with(|a| *a.borrow_mut() = prev);
    }
}

/// The engine wrote `value` at `cell` (a computed value, a spilled cell, a
/// cleared spill cell). Keeps the snapshot of that column exact.
pub(crate) fn note_write(cell: CellRef, value: &CellValue) {
    ACTIVE.with(|a| {
        let mut a = a.borrow_mut();
        let Some(state) = a.as_mut() else {
            return;
        };
        let key = (cell.sheet, cell.col);
        let Some(Col::Snap(rc)) = state.cols.get_mut(&key) else {
            return;
        };
        if cell.row < rc.lo || cell.row >= rc.hi() {
            // The snapshot does not claim this row (a later request that
            // needs it grows the snapshot from the grid).
            return;
        }
        match Rc::get_mut(rc) {
            Some(snap) => snap.write(cell.row, value.clone()),
            // A view still holds it (never during a write in practice):
            // forget it rather than let it go stale.
            None => {
                state.cols.insert(key, Col::Seen);
            }
        }
    });
}

/// The snapshot of `(sheet, col)` covering rows `lo..=hi` (inside the sheet's
/// populated rows), or `None` when there is no active scope for `model`, the
/// column was not asked for before in this recalc, or it is too sparse.
pub(crate) fn column(
    model: &SheetModel,
    sheet: SheetId,
    col: u32,
    lo: u32,
    hi: u32,
) -> Option<Rc<ColSnap>> {
    ACTIVE.with(|a| {
        let mut a = a.borrow_mut();
        let state = a.as_mut()?;
        if !std::ptr::eq(state.model, model) {
            return None;
        }
        let ws = model.sheet(sheet)?;
        let (pop_lo, pop_hi) = (ws.cells.keys().next()?.0, ws.cells.keys().next_back()?.0);
        let key = (sheet, col);
        let (new_lo, new_hi, old) = match state.cols.get(&key) {
            None => {
                state.cols.insert(key, Col::Seen);
                return None;
            }
            Some(Col::Off) => return None,
            Some(Col::Seen) => (lo, hi, None),
            Some(Col::Snap(rc)) => {
                if rc.lo <= lo && hi < rc.hi() {
                    return Some(rc.clone());
                }
                // Grow by doubling (amortized linear for a range that widens
                // a row at a time), clipped to the populated rows.
                let len = rc.values.len() as u32;
                let glo = lo.min(rc.lo.saturating_sub(len)).max(pop_lo).min(lo);
                let ghi = hi.max(rc.hi() - 1 + len).min(pop_hi).max(hi);
                (glo, ghi, Some(rc.clone()))
            }
        };
        let snap = build(
            ws,
            sheet,
            col,
            new_lo,
            new_hi,
            pop_lo,
            pop_hi,
            old.as_deref(),
        );
        let rows = snap.values.len();
        if rows >= SPARSE_ROWS {
            let filled = snap.values.iter().filter(|v| !v.is_blank()).count();
            if filled * SPARSE < rows {
                state.cols.insert(key, Col::Off);
                return None;
            }
        }
        let rc = Rc::new(snap);
        state.cols.insert(key, Col::Snap(rc.clone()));
        Some(rc)
    })
}

/// Read rows `lo..=hi` of column `col` out of the grid, reusing the rows an
/// older snapshot already holds (and its prefixes, which a growth leaves
/// valid: values only ever get added around them).
#[allow(clippy::too_many_arguments)]
fn build(
    ws: &sheet_core::Worksheet,
    sheet: SheetId,
    col: u32,
    lo: u32,
    hi: u32,
    pop_lo: u32,
    pop_hi: u32,
    old: Option<&ColSnap>,
) -> ColSnap {
    let len = (hi - lo + 1) as usize;
    let mut values = vec![CellValue::Empty; len];
    let fill = |values: &mut [CellValue], a: u32, b: u32| {
        fill_rows(ws, col, lo, values, a, b, pop_lo, pop_hi)
    };
    let mut prefixes = Vec::new();
    match old {
        Some(o) if o.lo >= lo && o.hi() <= hi + 1 => {
            if o.lo > lo {
                fill(&mut values, lo, o.lo - 1);
            }
            let at = (o.lo - lo) as usize;
            values[at..at + o.values.len()].clone_from_slice(&o.values);
            fill(&mut values, o.hi(), hi);
            prefixes = o.derived.borrow().prefixes.clone();
        }
        _ => fill(&mut values, lo, hi),
    }
    ColSnap {
        sheet,
        col,
        lo,
        values,
        derived: RefCell::new(Derived {
            prefixes,
            ..Derived::default()
        }),
    }
}

/// Copy grid rows `a..=b` of column `col` into `values` (indexed from `lo`).
#[allow(clippy::too_many_arguments)]
fn fill_rows(
    ws: &sheet_core::Worksheet,
    col: u32,
    lo: u32,
    values: &mut [CellValue],
    a: u32,
    b: u32,
    pop_lo: u32,
    pop_hi: u32,
) {
    if a > b {
        return;
    }
    perf_count!(cells_read, b - a + 1);
    perf_count!(snapshot_cells, b - a + 1);
    // Row-major grid: a key range over the rows visits every cell of them;
    // cheaper than a lookup per row unless the rows are wide.
    let rows = u64::from(b - a + 1);
    let pop_rows = u64::from(pop_hi.saturating_sub(pop_lo)) + 1;
    let est = rows * ws.cells.len() as u64 / pop_rows;
    if est <= rows * 4 {
        for (&(r, c), cell) in ws.cells.range((a, col)..=(b, col)) {
            if c == col {
                values[(r - lo) as usize] = cell.value.clone();
            }
        }
    } else {
        for r in a..=b {
            if let Some(cell) = ws.cell(r, col) {
                values[(r - lo) as usize] = cell.value.clone();
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Column snapshot + what is derived from it
// ---------------------------------------------------------------------------

/// A dense copy of one column over rows `lo..lo+values.len()`.
pub(crate) struct ColSnap {
    #[allow(dead_code)]
    sheet: SheetId,
    #[allow(dead_code)]
    col: u32,
    lo: u32,
    values: Vec<CellValue>,
    derived: RefCell<Derived>,
}

#[derive(Default)]
struct Derived {
    prefixes: Vec<Prefix>,
    exact: Option<Rc<ExactIndex>>,
    num_any: Option<Rc<FxHashMap<u64, Vec<u32>>>>,
    num_nontext: Option<Rc<FxHashMap<u64, Vec<u32>>>>,
    text_any: Option<Rc<FxHashMap<String, Vec<u32>>>>,
    sorted: Option<Rc<SortInfo>>,
}

impl ColSnap {
    /// One past the last row held.
    pub(crate) fn hi(&self) -> u32 {
        self.lo + self.values.len() as u32
    }

    /// The value at `row`, if held.
    pub(crate) fn get(&self, row: u32) -> Option<&CellValue> {
        row.checked_sub(self.lo)
            .and_then(|i| self.values.get(i as usize))
    }

    fn write(&mut self, row: u32, value: CellValue) {
        let i = (row - self.lo) as usize;
        self.values[i] = value;
        let d = self.derived.get_mut();
        for p in &mut d.prefixes {
            if p.anchor <= row {
                p.truncate((row - p.anchor) as usize);
            }
        }
        d.exact = None;
        d.num_any = None;
        d.num_nontext = None;
        d.text_any = None;
        d.sorted = None;
    }

    /// The fold of rows `anchor..anchor+len` (all held).
    fn prefix(&self, anchor: u32, len: usize) -> Fold {
        let mut d = self.derived.borrow_mut();
        let at = match d.prefixes.iter().position(|p| p.anchor == anchor) {
            Some(i) => i,
            None => {
                if d.prefixes.len() >= MAX_ANCHORS {
                    d.prefixes.remove(0);
                }
                d.prefixes.push(Prefix::new(anchor));
                d.prefixes.len() - 1
            }
        };
        let p = &mut d.prefixes[at];
        let start = (anchor - self.lo) as usize;
        p.extend_to(len, &self.values[start..start + len]);
        p.at(len)
    }

    fn exact(&self) -> Rc<ExactIndex> {
        let mut d = self.derived.borrow_mut();
        d.exact
            .get_or_insert_with(|| Rc::new(ExactIndex::build(self.lo, &self.values)))
            .clone()
    }

    fn num_any(&self) -> Rc<FxHashMap<u64, Vec<u32>>> {
        let mut d = self.derived.borrow_mut();
        d.num_any
            .get_or_insert_with(|| {
                Rc::new(num_index(self.lo, &self.values, |v| {
                    coerce::to_number(v).ok()
                }))
            })
            .clone()
    }

    fn num_nontext(&self) -> Rc<FxHashMap<u64, Vec<u32>>> {
        let mut d = self.derived.borrow_mut();
        d.num_nontext
            .get_or_insert_with(|| {
                Rc::new(num_index(self.lo, &self.values, |v| match v {
                    CellValue::Number(_) | CellValue::Bool(_) | CellValue::Empty => {
                        coerce::to_number(v).ok()
                    }
                    _ => None,
                }))
            })
            .clone()
    }

    fn text_any(&self) -> Rc<FxHashMap<String, Vec<u32>>> {
        let mut d = self.derived.borrow_mut();
        d.text_any
            .get_or_insert_with(|| {
                let mut m: FxHashMap<String, Vec<u32>> = FxHashMap::default();
                for (i, v) in self.values.iter().enumerate() {
                    let t = coerce::to_text(v).as_str().to_ascii_lowercase();
                    m.entry(t).or_default().push(self.lo + i as u32);
                }
                Rc::new(m)
            })
            .clone()
    }

    fn sorted(&self) -> Rc<SortInfo> {
        let mut d = self.derived.borrow_mut();
        d.sorted
            .get_or_insert_with(|| Rc::new(SortInfo::build(self.lo, &self.values)))
            .clone()
    }
}

/// The running fold of `SUM`/`COUNT`/`COUNTA`/`AVERAGE`/`MIN`/`MAX` from an
/// anchor row; entry `j` covers rows `anchor..=anchor+j`.
#[derive(Clone)]
struct Prefix {
    anchor: u32,
    sum: Vec<f64>,
    count: Vec<u32>,
    counta: Vec<u32>,
    min: Vec<f64>,
    max: Vec<f64>,
    /// The first error cell (entry index, error) among the computed entries.
    first_err: Option<(usize, CellError)>,
}

/// One answer read off a [`Prefix`].
struct Fold {
    sum: f64,
    count: u32,
    counta: u32,
    min: f64,
    max: f64,
    err: Option<CellError>,
}

impl Prefix {
    fn new(anchor: u32) -> Prefix {
        Prefix {
            anchor,
            sum: Vec::new(),
            count: Vec::new(),
            counta: Vec::new(),
            min: Vec::new(),
            max: Vec::new(),
            first_err: None,
        }
    }

    fn truncate(&mut self, len: usize) {
        self.sum.truncate(len);
        self.count.truncate(len);
        self.counta.truncate(len);
        self.min.truncate(len);
        self.max.truncate(len);
        if self.first_err.is_some_and(|(i, _)| i >= len) {
            self.first_err = None;
        }
    }

    /// Extend to `len` entries; `values` are rows `anchor..anchor+len`.
    fn extend_to(&mut self, len: usize, values: &[CellValue]) {
        let mut j = self.sum.len();
        let (mut sum, mut count, mut counta, mut min, mut max) = match j {
            0 => (0.0, 0, 0, 0.0, 0.0),
            _ => (
                self.sum[j - 1],
                self.count[j - 1],
                self.counta[j - 1],
                self.min[j - 1],
                self.max[j - 1],
            ),
        };
        while j < len {
            match &values[j] {
                // The kernels' own folds: `acc = acc + n` from 0.0, and
                // `if n < a { n } else { a }` from the first number.
                CellValue::Number(n) => {
                    let n = *n;
                    sum += n;
                    if count == 0 {
                        min = n;
                        max = n;
                    } else {
                        min = if n < min { n } else { min };
                        max = if n > max { n } else { max };
                    }
                    count += 1;
                    counta += 1;
                }
                CellValue::Error(e) => {
                    counta += 1;
                    if self.first_err.is_none() {
                        self.first_err = Some((j, *e));
                    }
                }
                CellValue::Text(_) | CellValue::Bool(_) => counta += 1,
                CellValue::Empty => {}
            }
            self.sum.push(sum);
            self.count.push(count);
            self.counta.push(counta);
            self.min.push(min);
            self.max.push(max);
            j += 1;
        }
    }

    fn at(&self, len: usize) -> Fold {
        let i = len - 1;
        Fold {
            sum: self.sum[i],
            count: self.count[i],
            counta: self.counta[i],
            min: self.min[i],
            max: self.max[i],
            err: self.first_err.filter(|(at, _)| *at < len).map(|(_, e)| e),
        }
    }
}

/// An exact-match key under the lookup equality rules: numbers by value
/// (`-0 == 0`), booleans, errors, and text ASCII-case-folded (text matches
/// text only). Blank cells are kept apart (`empties`): they equal `0`,
/// `FALSE` and a blank key under [`coerce::compare`].
#[derive(Clone, PartialEq, Eq, Hash)]
enum Key {
    Num(u64),
    Bool(bool),
    Err(u8),
    Text(String),
}

fn num_key(n: f64) -> u64 {
    // `-0.0 == 0.0` for every comparison the kernels make.
    if n == 0.0 {
        0.0f64.to_bits()
    } else {
        n.to_bits()
    }
}

/// The key of a number in a CRITERIA index: criteria compare numbers at 15
/// significant digits (`sheet_fn::coerce::eq15`), so equal-at-15-digits
/// values share a key. (The lookup index keeps [`num_key`]: MATCH and
/// VLOOKUP compare exactly.)
fn crit_key(n: f64) -> u64 {
    num_key(coerce::round15(n))
}

struct ExactIndex {
    map: FxHashMap<Key, Vec<u32>>,
    empties: Vec<u32>,
    /// A NaN number makes `coerce::compare` answer `Equal` against
    /// anything; such a column is never indexed.
    has_nan: bool,
}

impl ExactIndex {
    fn build(lo: u32, values: &[CellValue]) -> ExactIndex {
        let mut map: FxHashMap<Key, Vec<u32>> = FxHashMap::default();
        let mut empties = Vec::new();
        let mut has_nan = false;
        for (i, v) in values.iter().enumerate() {
            let row = lo + i as u32;
            let k = match v {
                CellValue::Empty => {
                    empties.push(row);
                    continue;
                }
                CellValue::Number(n) => {
                    if n.is_nan() {
                        has_nan = true;
                    }
                    Key::Num(num_key(*n))
                }
                CellValue::Bool(b) => Key::Bool(*b),
                CellValue::Error(e) => Key::Err(*e as u8),
                CellValue::Text(t) => Key::Text(t.as_str().to_ascii_lowercase()),
            };
            map.entry(k).or_default().push(row);
        }
        ExactIndex {
            map,
            empties,
            has_nan,
        }
    }

    fn rows(&self, k: &Key) -> &[u32] {
        self.map.get(k).map_or(&[], |v| v.as_slice())
    }
}

fn num_index(
    lo: u32,
    values: &[CellValue],
    f: impl Fn(&CellValue) -> Option<f64>,
) -> FxHashMap<u64, Vec<u32>> {
    let mut m: FxHashMap<u64, Vec<u32>> = FxHashMap::default();
    for (i, v) in values.iter().enumerate() {
        if let Some(n) = f(v) {
            if !n.is_nan() {
                m.entry(crit_key(n)).or_default().push(lo + i as u32);
            }
        }
    }
    m
}

/// The non-blank cells of a column in row order with running counts of
/// order breaks, so "is this row window sorted" is two lookups.
struct SortInfo {
    rows: Vec<u32>,
    /// `desc[k]`: steps `j <= k` (j >= 1) where value j < value j-1.
    desc: Vec<u32>,
    /// `asc[k]`: steps `j <= k` where value j > value j-1.
    asc: Vec<u32>,
    has_nan: bool,
}

impl SortInfo {
    fn build(lo: u32, values: &[CellValue]) -> SortInfo {
        let mut rows = Vec::new();
        let mut desc = Vec::new();
        let mut asc = Vec::new();
        let mut has_nan = false;
        let mut prev: Option<&CellValue> = None;
        let (mut d, mut a) = (0u32, 0u32);
        for (i, v) in values.iter().enumerate() {
            if v.is_blank() {
                continue;
            }
            if matches!(v, CellValue::Number(n) if n.is_nan()) {
                has_nan = true;
            }
            if let Some(p) = prev {
                match coerce::compare(v, p) {
                    std::cmp::Ordering::Less => d += 1,
                    std::cmp::Ordering::Greater => a += 1,
                    std::cmp::Ordering::Equal => {}
                }
            }
            rows.push(lo + i as u32);
            desc.push(d);
            asc.push(a);
            prev = Some(v);
        }
        SortInfo {
            rows,
            desc,
            asc,
            has_nan,
        }
    }

    /// The non-blank index window for rows `[a, b)`.
    fn window(&self, a: u32, b: u32) -> (usize, usize) {
        (
            self.rows.partition_point(|&r| r < a),
            self.rows.partition_point(|&r| r < b),
        )
    }
}

// ---------------------------------------------------------------------------
// Fast paths
// ---------------------------------------------------------------------------

struct Ids {
    sum: Option<FuncId>,
    count: Option<FuncId>,
    counta: Option<FuncId>,
    average: Option<FuncId>,
    min: Option<FuncId>,
    max: Option<FuncId>,
    vlookup: Option<FuncId>,
    match_: Option<FuncId>,
    xmatch: Option<FuncId>,
    xlookup: Option<FuncId>,
    countif: Option<FuncId>,
    sumif: Option<FuncId>,
}

fn ids() -> &'static Ids {
    static IDS: OnceLock<Ids> = OnceLock::new();
    IDS.get_or_init(|| {
        let f = sheet_core::funcs::lookup_func;
        Ids {
            sum: f("SUM"),
            count: f("COUNT"),
            counta: f("COUNTA"),
            average: f("AVERAGE"),
            min: f("MIN"),
            max: f("MAX"),
            vlookup: f("VLOOKUP"),
            match_: f("MATCH"),
            xmatch: f("XMATCH"),
            xlookup: f("XLOOKUP"),
            countif: f("COUNTIF"),
            sumif: f("SUMIF"),
        }
    })
}

/// What a fast path did with a call.
pub(crate) enum Fast {
    /// The call's value, computed without the kernel.
    Value(CellValue),
    /// An argument was narrowed in place; run the kernel on it.
    Narrowed,
    /// Not accelerated; run the kernel as usual.
    No,
}

/// Try to answer `fid(args)` from the snapshots behind `bufs`. Only ever
/// active inside a recalc scope (snapshot-backed views exist nowhere else).
pub(crate) fn try_eval<'m>(
    model: &'m SheetModel,
    fid: FuncId,
    bufs: &mut [RangeBuf<'m>],
    plans: &[ArgPlan],
) -> Fast {
    if !bufs.iter().any(|b| b.src().is_some()) {
        return Fast::No;
    }
    let ids = ids();
    let is = |id: Option<FuncId>| id == Some(fid);
    let out = if is(ids.sum)
        || is(ids.count)
        || is(ids.counta)
        || is(ids.average)
        || is(ids.min)
        || is(ids.max)
    {
        aggregate(fid, ids, bufs, plans)
    } else if is(ids.vlookup) {
        return vlookup(model, bufs, plans);
    } else if is(ids.match_) {
        match_fn(bufs, plans)
    } else if is(ids.xmatch) {
        xlookup(bufs, plans, false)
    } else if is(ids.xlookup) {
        xlookup(bufs, plans, true)
    } else if is(ids.countif) {
        countif(bufs, plans)
    } else if is(ids.sumif) {
        sumif(bufs, plans)
    } else {
        None
    };
    match out {
        Some(v) => {
            perf_count!(accel_hits, 1);
            Fast::Value(v)
        }
        None => Fast::No,
    }
}

/// The single-column snapshot area of argument `i`, when it has one.
fn col_arg<'a>(bufs: &'a [RangeBuf<'_>], plans: &[ArgPlan], i: usize) -> Option<&'a argview::Src> {
    match plans.get(i)? {
        ArgPlan::BufAt(b) => bufs[*b].src().filter(|s| s.cols == 1),
        ArgPlan::Scalar(_) => None,
    }
}

fn scalar(plans: &[ArgPlan], i: usize) -> Option<&CellValue> {
    match plans.get(i)? {
        ArgPlan::Scalar(v) => Some(v),
        ArgPlan::BufAt(_) => None,
    }
}

fn aggregate(
    fid: FuncId,
    ids: &Ids,
    bufs: &[RangeBuf<'_>],
    plans: &[ArgPlan],
) -> Option<CellValue> {
    if plans.len() != 1 {
        return None;
    }
    let src = col_arg(bufs, plans, 0)?;
    let (llo, lhi) = src.live;
    if llo >= lhi {
        return None;
    }
    // The kernels scan the live rows only; the fold from the first live row
    // is theirs exactly.
    let anchor = src.row0 + llo;
    let snap = &src.snaps[0];
    let f = snap.prefix(anchor, (lhi - llo) as usize);
    let is = |id: Option<FuncId>| id == Some(fid);
    Some(if is(ids.sum) {
        match f.err {
            Some(e) => CellValue::Error(e),
            None if f.sum.is_finite() => CellValue::Number(f.sum),
            None => CellValue::Error(CellError::Num),
        }
    } else if is(ids.count) {
        CellValue::Number(f64::from(f.count))
    } else if is(ids.counta) {
        CellValue::Number(f64::from(f.counta))
    } else if let Some(e) = f.err {
        CellValue::Error(e)
    } else if is(ids.average) {
        if f.count == 0 {
            CellValue::Error(CellError::Div0)
        } else {
            CellValue::Number(f.sum / f64::from(f.count))
        }
    } else if f.count == 0 {
        CellValue::Number(0.0)
    } else if is(ids.min) {
        CellValue::Number(f.min)
    } else {
        CellValue::Number(f.max)
    })
}

/// Rows of the column (absolute, ascending) equal to `key` under the
/// lookup rules, merged with the blank rows when a blank equals `key`.
/// `None` when the key cannot be indexed.
struct Matches {
    lists: smallvec::SmallVec<[Rc<[u32]>; 3]>,
}

impl Matches {
    fn first_in(&self, a: u32, b: u32) -> Option<u32> {
        self.lists
            .iter()
            .filter_map(|l| {
                let i = l.partition_point(|&r| r < a);
                l.get(i).copied().filter(|&r| r < b)
            })
            .min()
    }

    fn last_in(&self, a: u32, b: u32) -> Option<u32> {
        self.lists
            .iter()
            .filter_map(|l| {
                let i = l.partition_point(|&r| r < b);
                i.checked_sub(1).map(|i| l[i]).filter(|&r| r >= a)
            })
            .max()
    }
}

/// How a lookup kernel compares a key with a candidate.
#[derive(Copy, Clone, PartialEq, Eq)]
enum Rule {
    /// `lookup::exact_pos` — a text key is a (wildcard) pattern over text
    /// candidates; anything else is `coerce::compare == Equal`.
    Lookup,
    /// `lookup2::values_equal` — text equals text case-insensitively, never
    /// across types; anything else is `coerce::compare == Equal`.
    Values,
}

/// The rows equal to `key` (blank rows inside the snapshot included when a
/// blank equals the key) and whether a blank equals the key.
fn matches(snap: &ColSnap, key: &CellValue, rule: Rule) -> Option<(Matches, bool)> {
    let idx = snap.exact();
    if idx.has_nan {
        return None;
    }
    let list = |k: &Key| -> Rc<[u32]> { Rc::from(idx.rows(k)) };
    let empties = || -> Rc<[u32]> { Rc::from(idx.empties.as_slice()) };
    let mut lists = smallvec::SmallVec::new();
    let blank_eq = match key {
        CellValue::Text(t) => {
            // A pattern key (wildcards / escapes) is never indexed.
            if rule == Rule::Lookup && t.contains(['*', '?', '~']) {
                return None;
            }
            lists.push(list(&Key::Text(t.as_str().to_ascii_lowercase())));
            false
        }
        CellValue::Number(n) => {
            if n.is_nan() {
                return None;
            }
            lists.push(list(&Key::Num(num_key(*n))));
            *n == 0.0
        }
        CellValue::Bool(b) => {
            lists.push(list(&Key::Bool(*b)));
            !*b
        }
        CellValue::Empty => {
            lists.push(list(&Key::Num(num_key(0.0))));
            lists.push(list(&Key::Bool(false)));
            if rule == Rule::Lookup {
                // `compare(Empty, Text(""))` is Equal on the compare path.
                lists.push(list(&Key::Text(String::new())));
            }
            true
        }
        CellValue::Error(_) => return None,
    };
    if blank_eq {
        lists.push(empties());
    }
    Some((Matches { lists }, blank_eq))
}

/// `VLOOKUP(key, table, col, [range_lookup])`: find the row through the
/// index (exact) or a binary search over a sorted key column (approximate),
/// then hand the kernel the table cut to that one row (or to no rows).
fn vlookup<'m>(model: &'m SheetModel, bufs: &mut [RangeBuf<'m>], plans: &[ArgPlan]) -> Fast {
    let Some(rel) = vlookup_row(bufs, plans) else {
        return Fast::No;
    };
    let ArgPlan::BufAt(t) = plans[1] else {
        return Fast::No;
    };
    let cut = match rel {
        Some(r) => argview::narrow(model, &bufs[t], r, 1),
        None => Some(bufs[t].no_rows()),
    };
    match cut {
        Some(cut) => {
            bufs[t] = cut;
            perf_count!(accel_hits, 1);
            Fast::Narrowed
        }
        None => Fast::No,
    }
}

/// The relative row a `VLOOKUP` finds (`Some(None)` = proven no match), or
/// `None` when the call is not accelerated.
fn vlookup_row(bufs: &[RangeBuf<'_>], plans: &[ArgPlan]) -> Option<Option<u32>> {
    if !(3..=4).contains(&plans.len()) {
        return None;
    }
    let key = scalar(plans, 0)?;
    if key.is_blank() || matches!(key, CellValue::Error(_)) {
        return None;
    }
    let ArgPlan::BufAt(t) = plans[1] else {
        return None;
    };
    let src = bufs[t].src()?;
    let approximate = match scalar_or_absent(plans, 3)? {
        None | Some(CellValue::Bool(true)) => true,
        Some(CellValue::Number(n)) if *n == 1.0 => true,
        Some(CellValue::Bool(false)) => false,
        Some(CellValue::Number(n)) if *n == 0.0 => false,
        _ => return None,
    };
    // The kernel searches rows [0, min(rows, live end)) of the key column.
    let (llo, lhi) = src.live;
    let search = src.rows.min(lhi);
    let snap = &src.snaps[0];
    if approximate {
        return approx_row(snap, key, src.row0, llo, search, true);
    }
    let (m, blank_eq) = matches(snap, key, Rule::Lookup)?;
    if blank_eq && llo > 0 && search > 0 {
        // The blank rows above the data match first; the cut would hide
        // them from the kernel's live span. Let the kernel scan.
        return None;
    }
    Some(
        m.first_in(src.row0 + llo, src.row0 + search)
            .map(|r| r - src.row0),
    )
}

/// `None` = the argument is absent; `Some(v)` = a scalar; a range argument
/// makes the whole call unaccelerated (outer `None`).
fn scalar_or_absent(plans: &[ArgPlan], i: usize) -> Option<Option<&CellValue>> {
    match plans.get(i) {
        None => Some(None),
        Some(ArgPlan::Scalar(v)) => Some(Some(v)),
        Some(ArgPlan::BufAt(_)) => None,
    }
}

/// The approximate-match answer (`lookup::approximate_pos_asc` when `asc`,
/// `approximate_pos_desc` otherwise) over relative rows `[0, search)`, by
/// binary search — only when the non-blank cells there are sorted the way
/// the kernel assumes (on unsorted data its linear scan has its own answer).
fn approx_row(
    snap: &ColSnap,
    key: &CellValue,
    row0: u32,
    llo: u32,
    search: u32,
    asc: bool,
) -> Option<Option<u32>> {
    use std::cmp::Ordering::*;
    if matches!(key, CellValue::Number(n) if n.is_nan()) {
        return None;
    }
    let s = snap.sorted();
    if s.has_nan {
        return None;
    }
    let (i0, i1) = s.window(row0 + llo.min(search), row0 + search);
    if i0 >= i1 {
        return Some(None);
    }
    let breaks = if asc { &s.desc } else { &s.asc };
    if breaks[i1 - 1] != breaks[i0] {
        return None;
    }
    let val = |k: usize| snap.get(s.rows[k]).expect("held");
    // First non-blank at or past the key in the sort direction.
    let past = |k: usize| {
        let o = coerce::compare(val(k), key);
        if asc {
            o != Less
        } else {
            o != Greater
        }
    };
    let (mut lo, mut hi) = (i0, i1);
    while lo < hi {
        let mid = lo + (hi - lo) / 2;
        if past(mid) {
            hi = mid;
        } else {
            lo = mid + 1;
        }
    }
    let q = lo;
    let found = if q < i1 && coerce::compare(val(q), key) == Equal {
        Some(q)
    } else if q > i0 {
        Some(q - 1)
    } else {
        None
    };
    Some(found.map(|k| s.rows[k] - row0))
}

/// `MATCH(key, column, [type])` answered from the index / a sorted search.
fn match_fn(bufs: &[RangeBuf<'_>], plans: &[ArgPlan]) -> Option<CellValue> {
    if !(2..=3).contains(&plans.len()) {
        return None;
    }
    let key = scalar(plans, 0)?;
    if key.is_blank() || matches!(key, CellValue::Error(_)) {
        return None;
    }
    let src = col_arg(bufs, plans, 1)?;
    let mtype = match scalar_or_absent(plans, 2)? {
        None => 1,
        Some(CellValue::Number(n)) => {
            let t = n.trunc();
            if t == 0.0 {
                0
            } else if t > 0.0 {
                1
            } else {
                -1
            }
        }
        _ => return None,
    };
    let (llo, lhi) = src.live;
    let len = src.rows.min(lhi);
    let snap = &src.snaps[0];
    let rel = if mtype == 0 {
        let (m, blank_eq) = matches(snap, key, Rule::Lookup)?;
        if blank_eq && llo > 0 && len > 0 {
            Some(0)
        } else {
            m.first_in(src.row0 + llo, src.row0 + len)
                .map(|r| r - src.row0)
        }
    } else {
        approx_row(snap, key, src.row0, llo, len, mtype > 0)?
    };
    Some(match rel {
        Some(r) => CellValue::Number(f64::from(r + 1)),
        None => CellValue::Error(CellError::Na),
    })
}

/// `XMATCH(key, column, [0], [1|-1])` / `XLOOKUP(key, column, return,
/// [if_not_found], [0], [1|-1])` in exact mode, answered from the index.
fn xlookup(bufs: &[RangeBuf<'_>], plans: &[ArgPlan], lookup: bool) -> Option<CellValue> {
    let (min, max, mm, sm) = if lookup { (3, 6, 4, 5) } else { (2, 4, 2, 3) };
    if !(min..=max).contains(&plans.len()) {
        return None;
    }
    let key = scalar(plans, 0)?;
    if matches!(key, CellValue::Error(_)) {
        return None;
    }
    let src = col_arg(bufs, plans, 1)?;
    match scalar_or_absent(plans, mm)? {
        None => {}
        Some(CellValue::Number(n)) if n.trunc() == 0.0 => {}
        _ => return None,
    }
    let backwards = match scalar_or_absent(plans, sm)? {
        None => false,
        Some(CellValue::Number(n)) if n.trunc() == 1.0 => false,
        Some(CellValue::Number(n)) if n.trunc() == -1.0 => true,
        _ => return None,
    };
    let ret = if lookup {
        let ArgPlan::BufAt(r) = plans[2] else {
            return None;
        };
        let rb = &bufs[r];
        if rb.cols() != 1 || rb.rows() != src.rows {
            return None;
        }
        if let Some(ArgPlan::BufAt(_)) = plans.get(3) {
            return None;
        }
        Some(rb)
    } else {
        None
    };
    let (m, blank_eq) = matches(&src.snaps[0], key, Rule::Values)?;
    let (llo, lhi, rows, row0) = (src.live.0, src.live.1, src.rows, src.row0);
    // Rows outside the live span are blank.
    let rel = if !backwards {
        if blank_eq && llo > 0 {
            Some(0)
        } else {
            m.first_in(row0 + llo, row0 + lhi)
                .map(|r| r - row0)
                .or((blank_eq && lhi < rows).then_some(lhi))
        }
    } else if blank_eq && lhi < rows {
        Some(rows - 1)
    } else {
        m.last_in(row0 + llo, row0 + lhi)
            .map(|r| r - row0)
            .or_else(|| (blank_eq && llo > 0).then(|| llo - 1))
    };
    Some(match (rel, ret) {
        (Some(r), Some(rb)) => rb.view().get(r, 0),
        (Some(r), None) => CellValue::Number(f64::from(r + 1)),
        (None, Some(_)) => match plans.get(3) {
            Some(ArgPlan::Scalar(v)) => v.clone(),
            _ => CellValue::Error(CellError::Na),
        },
        (None, None) => CellValue::Error(CellError::Na),
    })
}

/// The rows of a column satisfying an equality criterion, or `None` when
/// the criterion is not one the index answers (operators, wildcards, a blank
/// criterion).
fn criterion_rows(snap: &ColSnap, crit: &CellValue) -> Option<Matches> {
    let mut lists: smallvec::SmallVec<[Rc<[u32]>; 3]> = smallvec::SmallVec::new();
    match crit {
        // `criteria::Kind::Number { Eq }`: to_number(candidate) == n.
        CellValue::Number(n) => {
            if n.is_nan() {
                return None;
            }
            let m = snap.num_any();
            lists.push(Rc::from(m.get(&crit_key(*n)).map_or(&[][..], |v| v)));
        }
        // `criteria::Kind::BareEq`: a number spelling meets numbers, logicals
        // and blanks by value; the text spelling meets every cell's text.
        CellValue::Text(t) => {
            if t.is_empty() || t.starts_with(['<', '>', '=']) || t.contains(['*', '?', '~']) {
                return None;
            }
            if let Ok(n) = coerce::to_number(crit) {
                if n.is_nan() {
                    return None;
                }
                let m = snap.num_nontext();
                lists.push(Rc::from(m.get(&crit_key(n)).map_or(&[][..], |v| v)));
            }
            let m = snap.text_any();
            lists.push(Rc::from(
                m.get(&t.as_str().to_ascii_lowercase())
                    .map_or(&[][..], |v| v),
            ));
        }
        // `criteria::Kind::BareValue`: candidate == criterion.
        CellValue::Bool(b) => {
            let idx = snap.exact();
            lists.push(Rc::from(idx.rows(&Key::Bool(*b))));
        }
        CellValue::Error(e) => {
            let idx = snap.exact();
            lists.push(Rc::from(idx.rows(&Key::Err(*e as u8))));
        }
        CellValue::Empty => return None,
    }
    Some(Matches { lists })
}

/// The matching rows inside `[a, b)`, ascending, de-duplicated.
fn rows_in(m: &Matches, a: u32, b: u32) -> Vec<u32> {
    let mut out: Vec<u32> = Vec::new();
    for l in &m.lists {
        let i = l.partition_point(|&r| r < a);
        let j = l.partition_point(|&r| r < b);
        out.extend_from_slice(&l[i..j]);
    }
    if m.lists.len() > 1 {
        out.sort_unstable();
        out.dedup();
    }
    out
}

fn count_in(m: &Matches, a: u32, b: u32) -> usize {
    if m.lists.len() == 1 {
        let l = &m.lists[0];
        return l.partition_point(|&r| r < b) - l.partition_point(|&r| r < a);
    }
    rows_in(m, a, b).len()
}

/// `COUNTIF(column, criterion)` with an equality criterion.
fn countif(bufs: &[RangeBuf<'_>], plans: &[ArgPlan]) -> Option<CellValue> {
    if plans.len() != 2 {
        return None;
    }
    let src = col_arg(bufs, plans, 0)?;
    let crit = scalar(plans, 1)?;
    let m = criterion_rows(&src.snaps[0], crit)?;
    let (llo, lhi) = src.live;
    let mut n = count_in(&m, src.row0 + llo, src.row0 + lhi) as u64;
    // The kernel counts the blank rows outside the live span in one step
    // when a blank satisfies the criterion.
    if sheet_fn::criteria::matches(&sheet_fn::criteria::parse_criteria(crit), &CellValue::Empty) {
        n += u64::from(src.rows - (lhi - llo));
    }
    Some(CellValue::Number(n as f64))
}

/// `SUMIF(column, criterion, [sum_range])` with an equality criterion that a
/// blank does not satisfy (the kernel then scans the criteria column's live
/// rows only).
fn sumif(bufs: &[RangeBuf<'_>], plans: &[ArgPlan]) -> Option<CellValue> {
    if !(2..=3).contains(&plans.len()) {
        return None;
    }
    let src = col_arg(bufs, plans, 0)?;
    let crit = scalar(plans, 1)?;
    if sheet_fn::criteria::matches(&sheet_fn::criteria::parse_criteria(crit), &CellValue::Empty) {
        return None;
    }
    let sum_buf = match plans.get(2) {
        None => match plans[0] {
            ArgPlan::BufAt(b) => &bufs[b],
            ArgPlan::Scalar(_) => return None,
        },
        Some(ArgPlan::BufAt(b)) => &bufs[*b],
        Some(ArgPlan::Scalar(_)) => return None,
    };
    let m = criterion_rows(&src.snaps[0], crit)?;
    let (llo, lhi) = src.live;
    let view = sum_buf.view();
    let mut sum = 0.0f64;
    for r in rows_in(&m, src.row0 + llo, src.row0 + lhi) {
        match view.get(r - src.row0, 0) {
            CellValue::Number(n) => sum += n,
            CellValue::Error(e) => return Some(CellValue::Error(e)),
            _ => {}
        }
    }
    Some(CellValue::Number(sum))
}
