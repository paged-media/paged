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

//! W3 array kernels: `EXPAND`, `WRAPROWS`, `WRAPCOLS`, `TRIMRANGE`.
//! Excel-recorded (`corpus/fn-corpus/array3`).
//!
//! ## Rulings
//!
//! - **EXPAND(array, rows, [columns], [pad_with])**: an omitted size keeps
//!   the array's; a size below the array's is `#VALUE!`; past 1,048,576 rows
//!   or 16,384 columns `#NUM!`; sizes truncate; padding defaults to `#N/A`.
//! - **WRAPROWS / WRAPCOLS(vector, wrap_count, [pad_with])**: the vector must
//!   be one row or one column (`#VALUE!`), `wrap_count` truncates and must be
//!   at least 1 (`#NUM!`); the last row/column pads with `pad_with`
//!   (default `#N/A`); a blank cell stays blank.
//! - **TRIMRANGE(range, [trim_rows=3], [trim_cols=3])**: 0 keeps, 1 trims
//!   leading, 2 trailing, 3 both, blank rows / columns (an empty text is not
//!   blank); an all-blank range is `#REF!`; another mode `#VALUE!`.

use sheet_core::{CellError, CellValue};

use super::util::{grid, num, num_or, scalar, shape};
use crate::arg::Arg;
use crate::ctx::EvalCtx;
use crate::result::FnResult;

fn fail(e: CellError) -> FnResult {
    FnResult::Scalar(CellValue::Error(e))
}

const MAX_ROWS: f64 = 1_048_576.0;
const MAX_COLS: f64 = 16_384.0;

fn pad_arg(args: &[Arg], i: usize) -> CellValue {
    match args.get(i) {
        None | Some(Arg::Scalar(CellValue::Empty)) => CellValue::Error(CellError::Na),
        Some(a) => scalar(Some(a)).unwrap_or(CellValue::Error(CellError::Na)),
    }
}

/// An optional size: absent / blank keeps `current`.
fn size(args: &[Arg], i: usize, current: usize, max: f64) -> Result<usize, CellError> {
    match args.get(i) {
        None | Some(Arg::Scalar(CellValue::Empty)) => Ok(current),
        Some(a) => {
            let n = num(Some(a))?.trunc();
            if n > max {
                return Err(CellError::Num);
            }
            if n < current as f64 {
                return Err(CellError::Value);
            }
            Ok(n as usize)
        }
    }
}

/// `EXPAND(array, rows, [columns], [pad_with])`.
pub fn expand(args: &[Arg], _ctx: &EvalCtx) -> FnResult {
    let g = grid(&args[0]);
    let (r0, c0) = shape(&args[0]);
    let rows = match size(args, 1, r0, MAX_ROWS) {
        Ok(n) => n,
        Err(e) => return fail(e),
    };
    let cols = match size(args, 2, c0, MAX_COLS) {
        Ok(n) => n,
        Err(e) => return fail(e),
    };
    let pad = pad_arg(args, 3);
    FnResult::Array(
        (0..rows)
            .map(|r| {
                (0..cols)
                    .map(|c| {
                        g.get(r)
                            .and_then(|row| row.get(c))
                            .cloned()
                            .unwrap_or_else(|| pad.clone())
                    })
                    .collect()
            })
            .collect(),
    )
}

fn wrap(args: &[Arg], by_rows: bool) -> FnResult {
    let (r, c) = shape(&args[0]);
    if r > 1 && c > 1 {
        return fail(CellError::Value);
    }
    let v: Vec<CellValue> = grid(&args[0]).into_iter().flatten().collect();
    let n = match num(args.get(1)) {
        Ok(n) => n.trunc(),
        Err(e) => return fail(e),
    };
    if n < 1.0 {
        return fail(CellError::Num);
    }
    let n = (n as usize).min(v.len().max(1));
    let pad = pad_arg(args, 2);
    let lines = v.len().div_ceil(n);
    let at = |i: usize| v.get(i).cloned().unwrap_or_else(|| pad.clone());
    let block: Vec<Vec<CellValue>> = if by_rows {
        (0..lines)
            .map(|l| (0..n).map(|k| at(l * n + k)).collect())
            .collect()
    } else {
        (0..n)
            .map(|k| (0..lines).map(|l| at(l * n + k)).collect())
            .collect()
    };
    FnResult::Array(block)
}

/// `WRAPROWS(vector, wrap_count, [pad_with])`.
pub fn wraprows(args: &[Arg], _ctx: &EvalCtx) -> FnResult {
    wrap(args, true)
}

/// `WRAPCOLS(vector, wrap_count, [pad_with])`.
pub fn wrapcols(args: &[Arg], _ctx: &EvalCtx) -> FnResult {
    wrap(args, false)
}

/// `TRIMRANGE(range, [trim_rows], [trim_cols])`.
pub fn trimrange(args: &[Arg], _ctx: &EvalCtx) -> FnResult {
    let mode = |i: usize| -> Result<u8, CellError> {
        let m = num_or(args.get(i), 3.0)?.trunc();
        if (0.0..=3.0).contains(&m) {
            Ok(m as u8)
        } else {
            Err(CellError::Value)
        }
    };
    let (mr, mc) = match (mode(1), mode(2)) {
        (Ok(a), Ok(b)) => (a, b),
        (Err(e), _) | (_, Err(e)) => return fail(e),
    };
    let g = grid(&args[0]);
    let blank = |v: &CellValue| matches!(v, CellValue::Empty);
    let rows = g.len();
    let cols = g.first().map_or(0, Vec::len);
    let row_used: Vec<bool> = g.iter().map(|r| !r.iter().all(blank)).collect();
    let col_used: Vec<bool> = (0..cols).map(|c| !g.iter().all(|r| blank(&r[c]))).collect();
    let (Some(fr), Some(lr)) = (
        row_used.iter().position(|&u| u),
        row_used.iter().rposition(|&u| u),
    ) else {
        return fail(CellError::Ref);
    };
    let fc = col_used.iter().position(|&u| u).unwrap_or(0);
    let lc = col_used
        .iter()
        .rposition(|&u| u)
        .unwrap_or(cols.saturating_sub(1));
    let (r0, r1) = (
        if mr & 1 != 0 { fr } else { 0 },
        if mr & 2 != 0 { lr } else { rows - 1 },
    );
    let (c0, c1) = (
        if mc & 1 != 0 { fc } else { 0 },
        if mc & 2 != 0 { lc } else { cols - 1 },
    );
    FnResult::Array(g[r0..=r1].iter().map(|r| r[c0..=c1].to_vec()).collect())
}
