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

//! What-if analysis (sheet ADR 517): `TABLE()` data tables evaluated and
//! Goal Seek as a one-shot command. Scenario Manager and Solver stay
//! preserved, never run.
//!
//! **Data tables** (`<f t="dataTable" ref r1 r2 dt2D dtr>`). For every
//! result cell the input cell(s) take the row / column value beside the
//! table, the workbook recalculates, and the formula cell's value is the
//! result — then the inputs are put back. A one-variable table laid out in
//! a column reads its values left of the results and its formulas above
//! them; laid out in a row (`dtr`), above and left; a two-variable table
//! has one formula in its corner, the row input (`r1`) takes the values
//! above, the column input (`r2`) those to the left. Tables recalculate
//! after every write while the calculation mode is automatic (not
//! "automatic except tables", nor manual: there Calculate Now does it).
//!
//! **Goal Seek** sets the changing cell (a constant) so the set cell (a
//! formula) reaches the target: the secant method from the cell's value,
//! falling back to bisection over a bracket when the secant stalls;
//! Excel's defaults, at most 100 iterations, done when the result is within
//! 0.001 of the target. The found value stays (the reply carries the old
//! input for the undo journal); a failed seek puts the old value back.

use std::collections::BTreeSet;

use sheet_calc::SetInput;
use sheet_core::{CalcMode, CellValue};

use super::{cell_input_text, CellInput, SessionError, SheetSession};

/// Excel's Goal Seek defaults.
const MAX_ITER: u32 = 100;
const MAX_CHANGE: f64 = 0.001;

/// What Goal Seek found.
#[derive(serde::Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GoalSeekResult {
    /// Whether the set cell reached the target (within 0.001).
    pub found: bool,
    /// The changing cell's value (the found one, or the old one).
    pub value: f64,
    /// The set cell's value at `value`.
    pub result: f64,
    pub iterations: u32,
    /// The changing cell's input before the seek (the undo journal's).
    pub prev_input: String,
}

impl SheetSession {
    /// Whether the workbook has data tables to keep current.
    pub(crate) fn has_data_tables(&self) -> bool {
        !self.doc.data_tables.is_empty()
    }

    fn number_at(&self, sheet: u16, row: u32, col: u32) -> Option<CellValue> {
        self.engine()
            .model()
            .sheet(sheet)
            .and_then(|w| w.cell(row, col))
            .map(|c| c.value.clone())
    }

    /// Recompute every data table; returns the result cells that changed.
    pub fn calculate_data_tables(&mut self) -> Result<Vec<(u16, u32, u32)>, SessionError> {
        let tables: Vec<(u16, sheet_xlsx::parts::worksheet::DataTableDef)> = self
            .doc
            .data_tables
            .iter()
            .flat_map(|(s, v)| v.iter().map(move |d| (*s, d.clone())))
            .collect();
        let mut changed = Vec::new();
        for (sheet, dt) in tables {
            let (r0, c0, r1, c1) = dt.range;
            if r0 == 0 || c0 == 0 {
                continue;
            }
            let Some(in1) = dt.r1 else {
                continue;
            };
            let in2 = dt.r2;
            if dt.two_d && in2.is_none() {
                continue;
            }
            // The inputs as they stand, to put back.
            let model = self.engine().model();
            let keep1 = cell_input_text(model, sheet, in1.0, in1.1);
            let keep2 = in2.map(|c| cell_input_text(model, sheet, c.0, c.1));
            let mut results: Vec<(u32, u32, CellValue)> = Vec::new();
            for r in r0..=r1 {
                for c in c0..=c1 {
                    let (subs, formula_at) = if dt.two_d {
                        (
                            vec![
                                (in1, self.number_at(sheet, r0 - 1, c)),
                                (in2.expect("2-D"), self.number_at(sheet, r, c0 - 1)),
                            ],
                            (r0 - 1, c0 - 1),
                        )
                    } else if dt.row {
                        (vec![(in1, self.number_at(sheet, r0 - 1, c))], (r, c0 - 1))
                    } else {
                        (vec![(in1, self.number_at(sheet, r, c0 - 1))], (r0 - 1, c))
                    };
                    let batch: Vec<_> = subs
                        .into_iter()
                        .map(|((ir, ic), v)| {
                            let input = match v {
                                Some(v) => SetInput::Value(v),
                                None => SetInput::Empty,
                            };
                            (sheet, ir, ic, input)
                        })
                        .collect();
                    self.engine_mut().set_cells(batch);
                    let v = self
                        .number_at(sheet, formula_at.0, formula_at.1)
                        .unwrap_or(CellValue::Empty);
                    results.push((r, c, v));
                }
            }
            // Put the inputs back.
            let mut restore = Vec::new();
            for ((ir, ic), text) in std::iter::once((in1, keep1)).chain(in2.zip(keep2)) {
                let input = self
                    .engine()
                    .parse_input(sheet, &text)
                    .map_err(|e| SessionError(e.to_string()))?;
                restore.push((sheet, ir, ic, input));
            }
            self.engine_mut().set_cells(restore);
            // Write the results that differ.
            let mut writes = Vec::new();
            for (r, c, v) in results {
                if self.number_at(sheet, r, c).unwrap_or(CellValue::Empty) != v {
                    writes.push((sheet, r, c, SetInput::Value(v)));
                    changed.push((sheet, r, c));
                }
            }
            if !writes.is_empty() {
                self.engine_mut().set_cells(writes);
                self.extra_dirty.insert(sheet);
            }
        }
        Ok(changed)
    }

    /// After a write: keep the data tables current (automatic calculation
    /// only). Returns the result cells that changed.
    pub(crate) fn data_tables_after_write(&mut self) -> Result<Vec<(u16, u32, u32)>, SessionError> {
        if !self.has_data_tables() || self.engine().model().calc.calc_mode != CalcMode::Auto {
            return Ok(Vec::new());
        }
        self.calculate_data_tables()
    }

    /// Goal Seek: set `(changing_row, changing_col)` so `(set_row,
    /// set_col)` reaches `target`.
    #[allow(clippy::too_many_arguments)]
    pub fn goal_seek(
        &mut self,
        sheet: u16,
        set_row: u32,
        set_col: u32,
        target: f64,
        changing_sheet: u16,
        changing_row: u32,
        changing_col: u32,
    ) -> Result<GoalSeekResult, SessionError> {
        self.validate_sheet(sheet)?;
        self.validate_sheet(changing_sheet)?;
        let model = self.engine().model();
        let set_is_formula = model
            .sheet(sheet)
            .and_then(|w| w.cell(set_row, set_col))
            .is_some_and(|c| c.formula.is_some());
        if !set_is_formula {
            return Err(SessionError("Cell must contain a formula.".into()));
        }
        let chg = model
            .sheet(changing_sheet)
            .and_then(|w| w.cell(changing_row, changing_col));
        if chg.is_some_and(|c| c.formula.is_some()) {
            return Err(SessionError("Cell must contain a value.".into()));
        }
        if !target.is_finite() {
            return Err(SessionError("the target must be a number".into()));
        }
        self.guard_cells([(changing_sheet, changing_row, changing_col)])?;
        let prev_input = cell_input_text(model, changing_sheet, changing_row, changing_col);
        let x_start = match chg.map(|c| &c.value) {
            Some(CellValue::Number(n)) => *n,
            _ => 0.0,
        };
        let iterations = std::cell::Cell::new(0u32);
        let eval = |s: &mut SheetSession, x: f64| -> Option<f64> {
            iterations.set(iterations.get() + 1);
            s.engine_mut().set_cells(vec![(
                changing_sheet,
                changing_row,
                changing_col,
                SetInput::Value(CellValue::Number(x)),
            )]);
            match s.number_at(sheet, set_row, set_col) {
                Some(CellValue::Number(y)) => Some(y - target),
                _ => None,
            }
        };
        let mut best: Option<(f64, f64)> = None;
        let note = |x: f64, f: f64, best: &mut Option<(f64, f64)>| {
            if best.is_none_or(|(_, bf)| f.abs() < bf.abs()) {
                *best = Some((x, f));
            }
        };
        // Secant from the current value.
        let mut x0 = x_start;
        let mut f0 = eval(self, x0);
        let mut x1 = if x0 == 0.0 { 0.01 } else { x0 * 1.01 };
        let mut f1 = eval(self, x1);
        let mut bracket: Option<(f64, f64, f64, f64)> = None;
        while iterations.get() < MAX_ITER {
            let (Some(a), Some(b)) = (f0, f1) else {
                break;
            };
            note(x0, a, &mut best);
            note(x1, b, &mut best);
            if b.abs() <= MAX_CHANGE {
                break;
            }
            if a.signum() != b.signum() {
                bracket = Some((x0, a, x1, b));
            }
            let d = b - a;
            if d == 0.0 || !d.is_finite() {
                break;
            }
            let x2 = x1 - b * (x1 - x0) / d;
            if !x2.is_finite() {
                break;
            }
            x0 = x1;
            f0 = f1;
            x1 = x2;
            f1 = eval(self, x1);
        }
        // Bisection over a bracket when the secant did not get there.
        if best.is_none_or(|(_, f)| f.abs() > MAX_CHANGE) {
            if bracket.is_none() {
                // Look for a sign change outwards from the start.
                let base = x_start;
                let fb = eval(self, base);
                let mut step = if base == 0.0 { 1.0 } else { base.abs() };
                while iterations.get() < MAX_ITER && bracket.is_none() {
                    for x in [base + step, base - step] {
                        if let (Some(fa), Some(fx)) = (fb, eval(self, x)) {
                            note(x, fx, &mut best);
                            if fa.signum() != fx.signum() {
                                bracket = Some((base, fa, x, fx));
                                break;
                            }
                        }
                    }
                    step *= 2.0;
                }
            }
            if let Some((mut lo, mut flo, mut hi, _)) = bracket {
                while iterations.get() < MAX_ITER {
                    let mid = 0.5 * (lo + hi);
                    let Some(fm) = eval(self, mid) else {
                        break;
                    };
                    note(mid, fm, &mut best);
                    if fm.abs() <= MAX_CHANGE {
                        break;
                    }
                    if fm.signum() == flo.signum() {
                        lo = mid;
                        flo = fm;
                    } else {
                        hi = mid;
                    }
                }
            }
        }
        let found = best.is_some_and(|(_, f)| f.abs() <= MAX_CHANGE);
        // Leave the found value as an entry (or the old input back).
        let final_input = match (found, best) {
            (true, Some((x, _))) => format!("{x}"),
            _ => prev_input.clone(),
        };
        self.set_cells(&[CellInput {
            sheet: changing_sheet,
            row: changing_row,
            col: changing_col,
            input: final_input,
        }])?;
        let value = match self.number_at(changing_sheet, changing_row, changing_col) {
            Some(CellValue::Number(n)) => n,
            _ => x_start,
        };
        let result = match self.number_at(sheet, set_row, set_col) {
            Some(CellValue::Number(n)) => n,
            _ => f64::NAN,
        };
        Ok(GoalSeekResult {
            found,
            value,
            result,
            iterations: iterations.get(),
            prev_input,
        })
    }

    /// The data tables of a sheet (their result ranges, A1).
    pub fn list_data_tables(&self) -> Vec<(u16, String)> {
        let mut seen = BTreeSet::new();
        self.doc
            .data_tables
            .iter()
            .flat_map(|(s, v)| {
                v.iter().map(move |d| {
                    let (r0, c0, r1, c1) = d.range;
                    (
                        *s,
                        format!("{}:{}", super::a1_of(r0, c0), super::a1_of(r1, c1)),
                    )
                })
            })
            .filter(|x| seen.insert(x.clone()))
            .collect()
    }
}
