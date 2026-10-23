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

//! W3 math & trigonometry kernels: the modern rounding forms, the matrix
//! functions, the reciprocal trigonometric functions and the paired-array
//! sums. Every behaviour below is Excel-recorded
//! (`corpus/fn-corpus/math3`, `sheet-conformance/oracle/excel/recorded/math3.tsv`).
//!
//! ## Rulings
//!
//! - **Rounding to a multiple** (`CEILING.MATH`, `CEILING.PRECISE`,
//!   `ISO.CEILING`, `FLOOR.MATH`, `FLOOR.PRECISE`) uses `|significance|`, a
//!   zero significance gives `0`, and the quotient `number / significance` is
//!   first rounded to 15 significant digits — so `CEILING.MATH(4.42, 0.01)` is
//!   `4.42`, not the `4.43` a raw `442.00000000000006` would ceil to — and the
//!   result is `quotient × significance` (`CEILING.MATH(0.3, 0.1)` is
//!   `0.30000000000000004`, as in Excel). `mode` only matters for a negative
//!   number: `CEILING.MATH` rounds it away from zero, `FLOOR.MATH` toward it.
//! - **Trigonometric range.** `COT`, `CSC` and `SEC` are `#NUM!` for
//!   `|x| >= 2^27`, the argument limit of Excel's trigonometric functions; a
//!   pole at zero is `#DIV/0!`. `ACOT` is evaluated as `atan(1/x)` (plus `π`
//!   below zero) so `ACOT(1E+300)` keeps its `1E-300`.
//! - **QUOTIENT** and the matrix functions reject logical scalars (the
//!   Analysis ToolPak rule).
//! - **MDETERM / MINVERSE** need a square block of numbers: a blank or text
//!   cell is `#VALUE!`, an error cell is that error; a singular matrix inverts
//!   to `#NUM!` (its determinant is `0`).
//! - **MULTINOMIAL** truncates; a text cell even inside a range is `#VALUE!`;
//!   `(Σ aᵢ)!` beyond `170!` is `#NUM!` (Excel computes through the
//!   factorial of the sum).
//! - **SERIESSUM** skips blank coefficient cells (the remaining ones are
//!   consecutive terms); `0^0` is `#NUM!`.
//! - **SUMX2MY2 / SUMX2PY2 / SUMXMY2** pair the two arrays element by element
//!   in row-major order (shapes may differ, counts may not: `#N/A`); a pair
//!   with any non-number is skipped, and no remaining pair is `#DIV/0!`.
//! - **PERCENTOF** is `SUM(subset) / SUM(all)` with `SUM`'s skipping rules,
//!   except that an error cell inside a reference is `#NUM!` (Excel-recorded).

use sheet_core::{CellError, CellValue};

use super::linalg;
use super::util::{atp_num, finite, flat, grid, num, num_or, round_sig, shape};
use crate::arg::Arg;
use crate::coerce;
use crate::ctx::EvalCtx;
use crate::result::FnResult;

fn err(e: CellError) -> CellValue {
    CellValue::Error(e)
}

/// Unwrap a `Result<f64, CellError>` inside a kernel.
macro_rules! tri {
    ($e:expr) => {
        match $e {
            Ok(v) => v,
            Err(e) => return CellValue::Error(e),
        }
    };
}

// ---- rounding to a multiple --------------------------------------------------

/// `number / significance` rounded to 15 significant digits.
fn quotient15(x: f64, sig: f64) -> f64 {
    round_sig(x / sig, 15)
}

fn ceiling_math_of(x: f64, sig: f64, away: bool) -> CellValue {
    let s = sig.abs();
    if s == 0.0 || x == 0.0 {
        return CellValue::Number(0.0);
    }
    let q = quotient15(x, s);
    let r = if x < 0.0 && away { q.floor() } else { q.ceil() };
    finite(r * s + 0.0)
}

fn floor_math_of(x: f64, sig: f64, toward_zero: bool) -> CellValue {
    let s = sig.abs();
    if s == 0.0 || x == 0.0 {
        return CellValue::Number(0.0);
    }
    let q = quotient15(x, s);
    let r = if x < 0.0 && toward_zero {
        q.ceil()
    } else {
        q.floor()
    };
    finite(r * s + 0.0)
}

/// `CEILING.MATH(number, [significance=1], [mode=0])`.
pub fn ceiling_math(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    let x = tri!(num(args.first()));
    let sig = tri!(num_or(args.get(1), 1.0));
    let mode = tri!(num_or(args.get(2), 0.0));
    ceiling_math_of(x, sig, mode != 0.0)
}

/// `CEILING.PRECISE(number, [significance=1])` — and `ISO.CEILING`: toward
/// +∞ whatever the signs.
pub fn ceiling_precise(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    let x = tri!(num(args.first()));
    let sig = tri!(num_or(args.get(1), 1.0));
    ceiling_math_of(x, sig, false)
}

/// `FLOOR.MATH(number, [significance=1], [mode=0])`.
pub fn floor_math(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    let x = tri!(num(args.first()));
    let sig = tri!(num_or(args.get(1), 1.0));
    let mode = tri!(num_or(args.get(2), 0.0));
    floor_math_of(x, sig, mode != 0.0)
}

/// `FLOOR.PRECISE(number, [significance=1])` — toward −∞ whatever the signs.
pub fn floor_precise(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    let x = tri!(num(args.first()));
    let sig = tri!(num_or(args.get(1), 1.0));
    floor_math_of(x, sig, false)
}

/// `QUOTIENT(numerator, denominator)` — the integer part of the division.
pub fn quotient(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    let n = tri!(atp_num(args.first()));
    let d = tri!(atp_num(args.get(1)));
    if d == 0.0 {
        return err(CellError::Div0);
    }
    finite((n / d).trunc() + 0.0)
}

// ---- matrices ------------------------------------------------------------------

/// A square block of numbers, or the error Excel gives for it.
fn square_matrix(arg: &Arg) -> Result<Vec<Vec<f64>>, CellError> {
    let g = grid(arg);
    let n = g.len();
    if n == 0 || g.iter().any(|row| row.len() != n) {
        return Err(CellError::Value);
    }
    let mut out = Vec::with_capacity(n);
    for row in g {
        let mut r = Vec::with_capacity(n);
        for v in row {
            match v {
                CellValue::Number(x) => r.push(x),
                CellValue::Error(e) => return Err(e),
                _ => return Err(CellError::Value),
            }
        }
        out.push(r);
    }
    Ok(out)
}

/// `MDETERM(array)`.
pub fn mdeterm(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    match square_matrix(&args[0]) {
        Ok(m) => finite(linalg::determinant(m) + 0.0),
        Err(e) => err(e),
    }
}

/// `MINVERSE(array)` — a spilled block.
pub fn minverse(args: &[Arg], _ctx: &EvalCtx) -> FnResult {
    let m = match square_matrix(&args[0]) {
        Ok(m) => m,
        Err(e) => return FnResult::Scalar(err(e)),
    };
    match linalg::invert(m) {
        Some(inv) => FnResult::Array(
            inv.into_iter()
                .map(|row| row.into_iter().map(|x| finite(x + 0.0)).collect())
                .collect(),
        ),
        None => FnResult::Scalar(err(CellError::Num)),
    }
}

/// `MUNIT(dimension)` — the identity matrix.
pub fn munit(args: &[Arg], _ctx: &EvalCtx) -> FnResult {
    let n = match num(args.first()) {
        Ok(n) => n.trunc(),
        Err(e) => return FnResult::Scalar(err(e)),
    };
    if !(1.0..=1_048_576.0).contains(&n) {
        return FnResult::Scalar(err(CellError::Value));
    }
    let n = n as usize;
    FnResult::Array(
        (0..n)
            .map(|i| {
                (0..n)
                    .map(|j| CellValue::Number(if i == j { 1.0 } else { 0.0 }))
                    .collect()
            })
            .collect(),
    )
}

// ---- counting --------------------------------------------------------------------

/// `MULTINOMIAL(number1, …)` — `(Σ aᵢ)! / Π aᵢ!`.
pub fn multinomial(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    let mut parts = Vec::new();
    for a in args {
        for v in flat(a) {
            match v {
                CellValue::Bool(_) if matches!(a, Arg::Range(_)) => return err(CellError::Value),
                CellValue::Empty => parts.push(0.0),
                other => {
                    let x = tri!(coerce::to_number(&other)).trunc();
                    if x < 0.0 {
                        return err(CellError::Num);
                    }
                    parts.push(x);
                }
            }
        }
    }
    let total: f64 = parts.iter().sum();
    if total > 170.0 {
        return err(CellError::Num);
    }
    // Π C(partial sum, aᵢ) — exact in f64 while the result is below 2^53.
    let mut acc = 1.0;
    let mut running = 0.0;
    for &a in &parts {
        running += a;
        acc *= super::math2::n_choose_k(running, a);
    }
    finite(acc)
}

/// `COMBINA(number, number_chosen)` — combinations with repetition,
/// `C(n + k − 1, k)`.
pub fn combina(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    let n = tri!(num(args.first())).trunc();
    let k = tri!(num(args.get(1))).trunc();
    if n < 0.0 || k < 0.0 {
        return err(CellError::Num);
    }
    if n == 0.0 && k == 0.0 {
        return CellValue::Number(1.0);
    }
    if n == 0.0 {
        return err(CellError::Num);
    }
    finite(super::math2::n_choose_k(n + k - 1.0, k))
}

// ---- reciprocal trigonometry -----------------------------------------------------

/// Excel's trigonometric argument limit.
const TRIG_LIMIT: f64 = 134_217_728.0; // 2^27

fn unary(args: &[Arg], f: impl FnOnce(f64) -> CellValue) -> CellValue {
    match num(args.first()) {
        Ok(x) => f(x),
        Err(e) => err(e),
    }
}

/// `ACOT(number)` — in `(0, π)`.
pub fn acot(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    unary(args, |x| {
        if x == 0.0 {
            CellValue::Number(std::f64::consts::FRAC_PI_2)
        } else if x > 0.0 {
            finite((1.0 / x).atan())
        } else {
            finite(std::f64::consts::PI + (1.0 / x).atan())
        }
    })
}

/// `ACOTH(number)`, `|x| > 1` — `½·ln(1 + 2/(x − 1))`.
pub fn acoth(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    unary(args, |x| {
        if x.abs() <= 1.0 {
            return err(CellError::Num);
        }
        let (s, a) = (x.signum(), x.abs());
        finite(s * 0.5 * (2.0 / (a - 1.0)).ln_1p())
    })
}

/// `COT(number)`.
pub fn cot(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    unary(args, |x| {
        if x.abs() >= TRIG_LIMIT {
            err(CellError::Num)
        } else if x == 0.0 {
            err(CellError::Div0)
        } else {
            finite(1.0 / x.tan())
        }
    })
}

/// `COTH(number)`.
pub fn coth(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    unary(args, |x| {
        if x == 0.0 {
            err(CellError::Div0)
        } else {
            finite(1.0 / x.tanh())
        }
    })
}

/// `CSC(number)`.
pub fn csc(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    unary(args, |x| {
        if x.abs() >= TRIG_LIMIT {
            err(CellError::Num)
        } else if x == 0.0 {
            err(CellError::Div0)
        } else {
            finite(1.0 / x.sin())
        }
    })
}

/// `CSCH(number)`.
pub fn csch(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    unary(args, |x| {
        if x == 0.0 {
            err(CellError::Div0)
        } else {
            finite(1.0 / x.sinh())
        }
    })
}

/// `SEC(number)`.
pub fn sec(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    unary(args, |x| {
        if x.abs() >= TRIG_LIMIT {
            err(CellError::Num)
        } else {
            finite(1.0 / x.cos())
        }
    })
}

/// `SECH(number)`.
pub fn sech(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    unary(args, |x| finite(1.0 / x.cosh()))
}

// ---- series and paired sums --------------------------------------------------------

/// `SERIESSUM(x, n, m, coefficients)` — `Σ aᵢ · x^(n + i·m)`.
pub fn seriessum(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    let x = tri!(num(args.first()));
    let n = tri!(num(args.get(1)));
    let m = tri!(num(args.get(2)));
    let mut coefs = Vec::new();
    for v in flat(&args[3]) {
        match v {
            CellValue::Empty => {}
            CellValue::Number(a) => coefs.push(a),
            CellValue::Error(e) => return err(e),
            _ => return err(CellError::Value),
        }
    }
    let mut sum = 0.0;
    for (i, a) in coefs.iter().enumerate() {
        let p = n + i as f64 * m;
        if x == 0.0 && p <= 0.0 {
            return err(if p == 0.0 {
                CellError::Num
            } else {
                CellError::Div0
            });
        }
        sum += a * x.powf(p);
    }
    finite(sum)
}

/// The numeric pairs of two equally long arrays (row-major); an error in
/// either propagates, a pair with a non-number is skipped.
fn pairs(args: &[Arg]) -> Result<Vec<(f64, f64)>, CellError> {
    let (xs, ys) = (flat(&args[0]), flat(&args[1]));
    let (sx, sy) = (shape(&args[0]), shape(&args[1]));
    if sx.0 * sx.1 != sy.0 * sy.1 {
        return Err(CellError::Na);
    }
    if let Some(e) = xs.iter().chain(ys.iter()).find_map(|v| match v {
        CellValue::Error(e) => Some(*e),
        _ => None,
    }) {
        return Err(e);
    }
    let out: Vec<(f64, f64)> = xs
        .iter()
        .zip(ys.iter())
        .filter_map(|(a, b)| match (a, b) {
            (CellValue::Number(a), CellValue::Number(b)) => Some((*a, *b)),
            _ => None,
        })
        .collect();
    if out.is_empty() {
        return Err(CellError::Div0);
    }
    Ok(out)
}

fn paired_sum(args: &[Arg], f: impl Fn(f64, f64) -> f64) -> CellValue {
    match pairs(args) {
        Ok(p) => finite(p.into_iter().map(|(a, b)| f(a, b)).sum()),
        Err(e) => err(e),
    }
}

/// `SUMX2MY2(array_x, array_y)` — `Σ (x² − y²)`.
pub fn sumx2my2(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    paired_sum(args, |x, y| x * x - y * y)
}

/// `SUMX2PY2(array_x, array_y)` — `Σ (x² + y²)`.
pub fn sumx2py2(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    paired_sum(args, |x, y| x * x + y * y)
}

/// `SUMXMY2(array_x, array_y)` — `Σ (x − y)²`.
pub fn sumxmy2(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    paired_sum(args, |x, y| (x - y) * (x - y))
}

/// `SUM` of one `PERCENTOF` argument: a reference skips text and logicals and
/// turns an error cell into `#NUM!`; a scalar coerces.
fn percent_sum(arg: &Arg) -> Result<f64, CellError> {
    match arg {
        Arg::Range(r) => {
            let mut s = 0.0;
            for v in r.iter() {
                match v {
                    CellValue::Number(x) => s += x,
                    CellValue::Error(_) => return Err(CellError::Num),
                    _ => {}
                }
            }
            Ok(s)
        }
        Arg::Scalar(v) => coerce::to_number(v),
    }
}

/// `PERCENTOF(data_subset, data_all)`.
pub fn percentof(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    let a = tri!(percent_sum(&args[0]));
    let b = tri!(percent_sum(&args[1]));
    if b == 0.0 {
        return err(CellError::Div0);
    }
    finite(a / b)
}
