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

//! Evaluating a formula that is not stored in a cell (sheet ADR 517): a
//! data-validation rule, a table's totals function, a list source. The
//! formula is evaluated as if it stood at `(sheet, row, col)` — relative
//! references read from there — against the current values, without
//! touching the model, the graph or the dirty set.

use sheet_core::{CellRef, CellValue, Formula, RangeRef, SheetId};
use sheet_fn::FnResult;

use crate::{eval, volatile, Engine, IntoShown};

impl Engine {
    fn adhoc_ctx(&self, sheet: SheetId, row: u32, col: u32) -> sheet_fn::EvalCtx {
        let cref = CellRef {
            sheet,
            row,
            col,
            row_abs: false,
            col_abs: false,
        };
        let seed = volatile::cell_seed(self.config.rng_seed, self.pass, cref);
        eval::ctx_for(&self.model, cref, self.config.now_serial, seed)
    }

    /// The scalar value of `f` evaluated at `(sheet, row, col)`.
    pub fn eval_formula_at(&self, sheet: SheetId, row: u32, col: u32, f: &Formula) -> CellValue {
        let ctx = self.adhoc_ctx(sheet, row, col);
        eval::eval_root(&self.model, &f.root, &ctx, &self.spills).into_shown()
    }

    /// The value of `f` at `(sheet, row, col)` as a block (a scalar is a 1×1
    /// block): what a list source or an array condition yields.
    pub fn eval_formula_block_at(
        &self,
        sheet: SheetId,
        row: u32,
        col: u32,
        f: &Formula,
    ) -> Vec<Vec<CellValue>> {
        let ctx = self.adhoc_ctx(sheet, row, col);
        match eval::eval_array(&self.model, &f.root, &ctx, &self.spills) {
            FnResult::Scalar(v) => vec![vec![v]],
            FnResult::Array(g) => g,
        }
    }

    /// The area `f` denotes when it is reference-shaped (`A1:A9`, a name,
    /// `OFFSET(…)`, `INDIRECT(…)`), evaluated at `(sheet, row, col)`.
    pub fn eval_reference_at(
        &self,
        sheet: SheetId,
        row: u32,
        col: u32,
        f: &Formula,
    ) -> Option<RangeRef> {
        let ctx = self.adhoc_ctx(sheet, row, col);
        eval::eval_as_reference(&self.model, &f.root, &ctx, &self.spills)
    }
}
