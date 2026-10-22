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

//! Small argument helpers shared by the W3 families (`eng`, `complex`,
//! `math3`, `text3`, `array3`, `info3`). Every kernel still goes through
//! [`crate::coerce`] for the conversion rulings; these only spare each family
//! the same `Arg` unpacking.

use sheet_core::{CellError, CellValue};

use crate::arg::Arg;
use crate::coerce;

/// Wrap an `f64`, mapping a non-finite outcome to `#NUM!`.
#[inline]
pub(crate) fn finite(n: f64) -> CellValue {
    if n.is_finite() {
        CellValue::Number(n)
    } else {
        CellValue::Error(CellError::Num)
    }
}

/// The scalar value of an argument: a range reads its top-left cell (the
/// 1×1 range a single reference materializes to); an absent argument is
/// `None`.
#[inline]
pub(crate) fn scalar(arg: Option<&Arg>) -> Option<CellValue> {
    match arg? {
        Arg::Scalar(v) => Some(v.clone()),
        Arg::Range(r) => Some(r.get(0, 0)),
    }
}

/// An argument as a number through [`coerce::to_number`] (a missing argument
/// is `#VALUE!`).
#[inline]
pub(crate) fn num(arg: Option<&Arg>) -> Result<f64, CellError> {
    match scalar(arg) {
        Some(v) => coerce::to_number(&v),
        None => Err(CellError::Value),
    }
}

/// An optional numeric argument: absent or an omitted (blank) slot is
/// `default`.
#[inline]
pub(crate) fn num_or(arg: Option<&Arg>, default: f64) -> Result<f64, CellError> {
    match arg {
        None | Some(Arg::Scalar(CellValue::Empty)) => Ok(default),
        Some(a) => num(Some(a)),
    }
}

/// The Analysis ToolPak number rule (the engineering and some math
/// functions): like [`num`], but a logical value is `#VALUE!` instead of
/// 0/1 (Excel-recorded: `DELTA(TRUE,1)`, `ERF(TRUE)`, `QUOTIENT(TRUE,1)`).
#[inline]
pub(crate) fn atp_num(arg: Option<&Arg>) -> Result<f64, CellError> {
    match scalar(arg) {
        Some(CellValue::Bool(_)) => Err(CellError::Value),
        Some(v) => coerce::to_number(&v),
        None => Err(CellError::Value),
    }
}

/// [`atp_num`] with a default for an absent or blank argument.
#[inline]
pub(crate) fn atp_num_or(arg: Option<&Arg>, default: f64) -> Result<f64, CellError> {
    match arg {
        None | Some(Arg::Scalar(CellValue::Empty)) => Ok(default),
        Some(a) => atp_num(Some(a)),
    }
}

/// An argument as a row-major grid (a scalar is 1×1).
pub(crate) fn grid(arg: &Arg) -> Vec<Vec<CellValue>> {
    match arg {
        Arg::Scalar(v) => vec![vec![v.clone()]],
        Arg::Range(r) => (0..r.rows())
            .map(|rr| (0..r.cols()).map(|cc| r.get(rr, cc)).collect())
            .collect(),
    }
}

/// Every value of an argument, row-major (a scalar is one value).
pub(crate) fn flat(arg: &Arg) -> Vec<CellValue> {
    match arg {
        Arg::Scalar(v) => vec![v.clone()],
        Arg::Range(r) => r.iter().collect(),
    }
}

/// `(rows, cols)` of an argument (a scalar is 1×1).
pub(crate) fn shape(arg: &Arg) -> (usize, usize) {
    match arg {
        Arg::Scalar(_) => (1, 1),
        Arg::Range(r) => (r.rows() as usize, r.cols() as usize),
    }
}

/// Round `x` to `digits` significant decimal digits (exact decimal rounding
/// of the binary value, half away from zero on the printed digits).
pub(crate) fn round_sig(x: f64, digits: usize) -> f64 {
    if x == 0.0 || !x.is_finite() {
        return x;
    }
    let s = format!("{:.*e}", digits.saturating_sub(1), x);
    s.parse().unwrap_or(x)
}
