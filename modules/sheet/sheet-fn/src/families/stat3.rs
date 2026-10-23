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

//! W3 statistics (F2): the `A` aggregates, the probability distributions and
//! their inverses, the hypothesis tests, the moment and covariance functions,
//! `GROWTH`/`LOGEST`, and the legacy compatibility names. The numerics live in
//! [`crate::special`] (Lanczos ln Γ, the regularised incomplete gamma and beta
//! functions, Loader's discrete densities, a bracketed root finder). Every
//! behaviour below is Excel-recorded (`corpus/fn-corpus/stat3`,
//! `sheet-conformance/oracle/excel/recorded/stat3.tsv`); provenance is the
//! published mathematics and Microsoft's function reference.
//!
//! ## Rulings
//!
//! - **Arguments.** Every scalar argument coerces as a number (numeric text
//!   and logical values included) in argument order, the first failure wins;
//!   the domain checks follow. Integer parameters (counts, degrees of freedom)
//!   are truncated.
//! - **The `A` aggregates** count a text cell and `FALSE` as 0 and `TRUE` as
//!   1 inside a reference; blanks are skipped; an error cell propagates. In an
//!   array computed inside the formula (`{1,"a",TRUE}`) only the numbers take
//!   part — `AVERAGEA` alone also counts the array's text as 0.
//! - **Degrees of freedom** below 1 or above `10^10` are `#NUM!` (Excel's
//!   limits for the chi-squared, t and F families).
//! - **The inverses** solve on the smaller tail to full precision; Excel's
//!   own results carry its iteration tolerance, so a recorded inverse agrees
//!   to about 1e-9 relative rather than to the last digit (listed rows).
//! - **The legacy names** keep their legacy arguments: `CHIDIST`, `FDIST`,
//!   `FINV`, `CHIINV` are right-tailed, `TDIST(x, df, tails)` refuses a
//!   negative `x`, `TINV` is two-tailed, `NORMSDIST` and `LOGNORMDIST` are
//!   cumulative only, `HYPGEOMDIST` and `NEGBINOMDIST` are the densities.

use sheet_core::{CellError, CellValue};

use super::linalg::invert;
use super::stat2::{std_norm_cdf, std_norm_inv};
use super::util::{finite, flat, grid, num, num_or, shape};
use crate::arg::Arg;
use crate::coerce;
use crate::ctx::EvalCtx;
use crate::result::FnResult;
use crate::special::{
    beta_i, dbinom_raw, dpois_raw, gamma, gamma_p_q, invert_beta, invert_tails, ln_beta, ln_gamma,
};

type R = Result<f64, CellError>;

fn out(r: R) -> CellValue {
    match r {
        Ok(v) => finite(v),
        Err(e) => CellValue::Error(e),
    }
}

fn n_at(args: &[Arg], i: usize) -> R {
    num(args.get(i))
}

fn b_at(args: &[Arg], i: usize) -> Result<bool, CellError> {
    match super::util::scalar(args.get(i)) {
        Some(v) => coerce::to_bool(&v),
        None => Err(CellError::Value),
    }
}

fn num_err<T>() -> Result<T, CellError> {
    Err(CellError::Num)
}

const DF_MAX: f64 = 1e10;

/// Truncated degrees of freedom in `[1, 10^10]`.
fn df_of(x: f64) -> R {
    let d = x.trunc();
    if !(1.0..=DF_MAX).contains(&d) {
        return num_err();
    }
    Ok(d)
}

// ---- the A aggregates ---------------------------------------------------------

/// The values of the `A` aggregates: references count text and `FALSE` as 0,
/// `TRUE` as 1; scalars coerce (non-numeric text is `#VALUE!`); an array
/// computed in the formula keeps only its numbers — except that AVERAGEA
/// counts its text as 0 (Excel-recorded: `AVERAGEA({1,"a",4})` is 5/3,
/// `AVERAGEA({1,TRUE,4})` 2.5, `MAXA({-1,"a"})` −1).
fn a_values(args: &[Arg], ctx: &EvalCtx, array_text: bool) -> Result<Vec<f64>, CellError> {
    let mut out = Vec::new();
    for a in args {
        match a {
            Arg::Scalar(CellValue::Empty) => out.push(0.0),
            Arg::Scalar(v) => out.push(coerce::to_number(v)?),
            Arg::Range(r) => {
                let computed = r.origin() == ctx.current;
                for v in r.iter_live() {
                    match v {
                        CellValue::Number(n) => out.push(n),
                        CellValue::Error(e) => return Err(e),
                        CellValue::Bool(b) if !computed => out.push(if b { 1.0 } else { 0.0 }),
                        CellValue::Text(_) if !computed || array_text => out.push(0.0),
                        _ => {}
                    }
                }
            }
        }
    }
    Ok(out)
}

fn mean(v: &[f64]) -> f64 {
    v.iter().sum::<f64>() / v.len() as f64
}

fn sum_sq_dev(v: &[f64]) -> f64 {
    let m = mean(v);
    v.iter().map(|x| (x - m) * (x - m)).sum()
}

fn variance(v: &[f64], population: bool) -> R {
    let n = v.len();
    if n == 0 || (!population && n < 2) {
        return Err(CellError::Div0);
    }
    Ok(sum_sq_dev(v) / if population { n as f64 } else { n as f64 - 1.0 })
}

/// `AVERAGEA(value1, …)`.
pub fn averagea(args: &[Arg], ctx: &EvalCtx) -> CellValue {
    out(a_values(args, ctx, true).and_then(|v| {
        if v.is_empty() {
            Err(CellError::Div0)
        } else {
            Ok(mean(&v))
        }
    }))
}

/// `MAXA(value1, …)` (no values: 0).
pub fn maxa(args: &[Arg], ctx: &EvalCtx) -> CellValue {
    out(a_values(args, ctx, false).map(|v| v.into_iter().reduce(f64::max).unwrap_or(0.0)))
}

/// `MINA(value1, …)` (no values: 0).
pub fn mina(args: &[Arg], ctx: &EvalCtx) -> CellValue {
    out(a_values(args, ctx, false).map(|v| v.into_iter().reduce(f64::min).unwrap_or(0.0)))
}

/// `STDEVA(value1, …)`.
pub fn stdeva(args: &[Arg], ctx: &EvalCtx) -> CellValue {
    out(a_values(args, ctx, false)
        .and_then(|v| variance(&v, false))
        .map(f64::sqrt))
}

/// `STDEVPA(value1, …)`.
pub fn stdevpa(args: &[Arg], ctx: &EvalCtx) -> CellValue {
    out(a_values(args, ctx, false)
        .and_then(|v| variance(&v, true))
        .map(f64::sqrt))
}

/// `VARA(value1, …)`.
pub fn vara(args: &[Arg], ctx: &EvalCtx) -> CellValue {
    out(a_values(args, ctx, false).and_then(|v| variance(&v, false)))
}

/// `VARPA(value1, …)`.
pub fn varpa(args: &[Arg], ctx: &EvalCtx) -> CellValue {
    out(a_values(args, ctx, false).and_then(|v| variance(&v, true)))
}

// ---- beta ---------------------------------------------------------------------

fn beta_pdf(x: f64, a: f64, b: f64) -> f64 {
    if x == 0.0 || x == 1.0 {
        // The density's limit at the end points.
        let e = if x == 0.0 { a } else { b };
        if e < 1.0 {
            return f64::INFINITY;
        }
        if e > 1.0 {
            return 0.0;
        }
        return (-ln_beta(a, b)).exp();
    }
    ((a - 1.0) * x.ln() + (b - 1.0) * (-x).ln_1p() - ln_beta(a, b)).exp()
}

fn beta_dist_impl(args: &[Arg], cumulative: Option<usize>, ab_at: usize) -> R {
    let x = n_at(args, 0)?;
    let a = n_at(args, 1)?;
    let b = n_at(args, 2)?;
    let cum = match cumulative {
        Some(i) => b_at(args, i)?,
        None => true,
    };
    let lo = num_or(args.get(ab_at), 0.0)?;
    let hi = num_or(args.get(ab_at + 1), 1.0)?;
    if a <= 0.0 || b <= 0.0 || x < lo || x > hi || lo == hi {
        return num_err();
    }
    let z = (x - lo) / (hi - lo);
    if cum {
        Ok(beta_i(a, b, z, (hi - x) / (hi - lo)).0)
    } else if z == 0.0 || z == 1.0 {
        // Excel-recorded: no density at the end points.
        num_err()
    } else {
        Ok(beta_pdf(z, a, b) / (hi - lo))
    }
}

/// `BETA.DIST(x, alpha, beta, cumulative, [A], [B])`.
pub fn beta_dist(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    out(beta_dist_impl(args, Some(3), 4))
}

/// `BETADIST(x, alpha, beta, [A], [B])` — cumulative.
pub fn betadist(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    out(beta_dist_impl(args, None, 3))
}

/// `BETA.INV(probability, alpha, beta, [A], [B])` (and `BETAINV`).
pub fn beta_inv(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    out((|| {
        let p = n_at(args, 0)?;
        let a = n_at(args, 1)?;
        let b = n_at(args, 2)?;
        let lo = num_or(args.get(3), 0.0)?;
        let hi = num_or(args.get(4), 1.0)?;
        if p <= 0.0 || p >= 1.0 || a <= 0.0 || b <= 0.0 || lo == hi {
            return num_err();
        }
        let z = invert_beta(a, b, p, 1.0 - p).0;
        Ok(lo + z * (hi - lo))
    })())
}

// ---- binomial -----------------------------------------------------------------

fn binom_args(args: &[Arg]) -> Result<(f64, f64, f64), CellError> {
    let s = n_at(args, 0)?.trunc();
    let n = n_at(args, 1)?.trunc();
    let p = n_at(args, 2)?;
    if s < 0.0 || s > n || !(0.0..=1.0).contains(&p) {
        return num_err();
    }
    Ok((s, n, p))
}

fn binom_cdf(s: f64, n: f64, p: f64) -> f64 {
    let q = 1.0 - p;
    let mut sum = 0.0;
    let mut k = 0.0;
    while k <= s {
        sum += dbinom_raw(k, n, p, q);
        k += 1.0;
    }
    sum.min(1.0)
}

fn binom_dist_impl(args: &[Arg]) -> R {
    let (s, n, p) = binom_args(args)?;
    let cum = b_at(args, 3)?;
    if cum {
        if s >= n {
            return Ok(1.0);
        }
        // The shorter tail by summation, the other by complement.
        if s <= n / 2.0 || n <= 1000.0 {
            Ok(binom_cdf(s, n, p))
        } else {
            Ok(beta_i(s + 1.0, n - s, 1.0 - p, p).0)
        }
    } else {
        Ok(dbinom_raw(s, n, p, 1.0 - p))
    }
}

/// `BINOM.DIST(number_s, trials, probability_s, cumulative)` (and
/// `BINOMDIST`).
pub fn binom_dist(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    out(binom_dist_impl(args))
}

/// `BINOM.DIST.RANGE(trials, probability_s, number_s, [number_s2])`.
pub fn binom_dist_range(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    out((|| {
        let n = n_at(args, 0)?.trunc();
        let p = n_at(args, 1)?;
        let s = n_at(args, 2)?.trunc();
        let s2 = match args.get(3) {
            None | Some(Arg::Scalar(CellValue::Empty)) => s,
            Some(_) => n_at(args, 3)?.trunc(),
        };
        if n < 0.0 || !(0.0..=1.0).contains(&p) || s < 0.0 || s > n || s2 < s || s2 > n {
            return num_err();
        }
        let q = 1.0 - p;
        let mut sum = 0.0;
        let mut k = s;
        while k <= s2 {
            sum += dbinom_raw(k, n, p, q);
            k += 1.0;
        }
        Ok(sum.min(1.0))
    })())
}

/// `BINOM.INV(trials, probability_s, alpha)` (and `CRITBINOM`): the smallest
/// count whose cumulative probability reaches `alpha`.
pub fn binom_inv(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    out((|| {
        let n = n_at(args, 0)?.trunc();
        let p = n_at(args, 1)?;
        let alpha = n_at(args, 2)?;
        if n < 0.0 || p <= 0.0 || p >= 1.0 || alpha <= 0.0 || alpha >= 1.0 {
            return num_err();
        }
        let q = 1.0 - p;
        let mut sum = 0.0;
        let mut k = 0.0;
        while k < n {
            sum += dbinom_raw(k, n, p, q);
            if sum >= alpha {
                return Ok(k);
            }
            k += 1.0;
        }
        Ok(n)
    })())
}

// ---- chi-squared --------------------------------------------------------------

fn chisq_pdf(x: f64, df: f64) -> f64 {
    gamma_pdf(x, df / 2.0, 2.0)
}

fn chisq_args(args: &[Arg]) -> Result<(f64, f64), CellError> {
    let x = n_at(args, 0)?;
    let df = n_at(args, 1)?;
    let df = df_of(df)?;
    if x < 0.0 {
        return num_err();
    }
    Ok((x, df))
}

/// `CHISQ.DIST(x, deg_freedom, cumulative)`.
pub fn chisq_dist(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    out((|| {
        let x = n_at(args, 0)?;
        let df = n_at(args, 1)?;
        let cum = b_at(args, 2)?;
        let df = df_of(df)?;
        if x < 0.0 {
            return num_err();
        }
        Ok(if cum {
            gamma_p_q(df / 2.0, x / 2.0).0
        } else {
            chisq_pdf(x, df)
        })
    })())
}

/// `CHISQ.DIST.RT(x, deg_freedom)` (and `CHIDIST`).
pub fn chisq_dist_rt(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    out(chisq_args(args).map(|(x, df)| gamma_p_q(df / 2.0, x / 2.0).1))
}

fn chisq_inv_impl(args: &[Arg], right: bool) -> R {
    let p = n_at(args, 0)?;
    let df = n_at(args, 1)?;
    let df = df_of(df)?;
    if !(0.0..=1.0).contains(&p) {
        return num_err();
    }
    let (lo, hi) = if right { (1.0 - p, p) } else { (p, 1.0 - p) };
    if lo == 0.0 {
        return Ok(0.0);
    }
    if hi == 0.0 {
        return num_err();
    }
    Ok(2.0 * invert_tails(|x| gamma_p_q(df / 2.0, x), lo, hi, None))
}

/// `CHISQ.INV(probability, deg_freedom)`.
pub fn chisq_inv(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    out(chisq_inv_impl(args, false))
}

/// `CHISQ.INV.RT(probability, deg_freedom)` (and `CHIINV`).
pub fn chisq_inv_rt(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    out(chisq_inv_impl(args, true))
}

/// Two equally sized blocks of an argument pair, cell by cell (`#N/A` for
/// different shapes).
/// Two blocks' cells and their shared shape.
type Blocks = (Vec<CellValue>, Vec<CellValue>, (usize, usize));

fn two_blocks(args: &[Arg]) -> Result<Blocks, CellError> {
    let (sa, sb) = (shape(&args[0]), shape(&args[1]));
    if sa != sb {
        return Err(CellError::Na);
    }
    Ok((flat(&args[0]), flat(&args[1]), sa))
}

/// `CHISQ.TEST(actual_range, expected_range)` (and `CHITEST`).
pub fn chisq_test(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    out((|| {
        let (a, e, (rows, cols)) = two_blocks(args)?;
        let mut stat = 0.0;
        let mut any = false;
        for (x, m) in a.iter().zip(&e) {
            if let CellValue::Error(err) = x {
                return Err(*err);
            }
            if let CellValue::Error(err) = m {
                return Err(*err);
            }
            if let (CellValue::Number(x), CellValue::Number(m)) = (x, m) {
                if *m < 0.0 {
                    return num_err();
                }
                if *m == 0.0 {
                    return Err(CellError::Div0);
                }
                stat += (x - m) * (x - m) / m;
                any = true;
            }
        }
        if !any {
            return Err(CellError::Div0);
        }
        let df = if rows == 1 || cols == 1 {
            (rows * cols) as f64 - 1.0
        } else {
            ((rows - 1) * (cols - 1)) as f64
        };
        if df < 1.0 {
            return Err(CellError::Na);
        }
        Ok(gamma_p_q(df / 2.0, stat / 2.0).1)
    })())
}

// ---- F ------------------------------------------------------------------------

/// The F distribution's tails `(P(F <= x), P(F > x))`.
fn f_tails(x: f64, d1: f64, d2: f64) -> (f64, f64) {
    if x <= 0.0 {
        return (0.0, 1.0);
    }
    let den = d1 * x + d2;
    beta_i(d1 / 2.0, d2 / 2.0, d1 * x / den, d2 / den)
}

fn f_pdf(x: f64, d1: f64, d2: f64) -> f64 {
    if x == 0.0 {
        return if d1 < 2.0 {
            f64::INFINITY
        } else if d1 == 2.0 {
            1.0
        } else {
            0.0
        };
    }
    let lnum =
        (d1 / 2.0) * (d1 * x).ln() + (d2 / 2.0) * d2.ln() - ((d1 + d2) / 2.0) * (d1 * x + d2).ln();
    (lnum - x.ln() - ln_beta(d1 / 2.0, d2 / 2.0)).exp()
}

fn f_args(args: &[Arg]) -> Result<(f64, f64, f64), CellError> {
    let x = n_at(args, 0)?;
    let d1 = n_at(args, 1)?;
    let d2 = n_at(args, 2)?;
    let (d1, d2) = (df_of(d1)?, df_of(d2)?);
    if x < 0.0 {
        return num_err();
    }
    Ok((x, d1, d2))
}

/// `F.DIST(x, deg_freedom1, deg_freedom2, cumulative)`.
pub fn f_dist(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    out((|| {
        let x = n_at(args, 0)?;
        let d1 = n_at(args, 1)?;
        let d2 = n_at(args, 2)?;
        let cum = b_at(args, 3)?;
        let (d1, d2) = (df_of(d1)?, df_of(d2)?);
        if x < 0.0 {
            return num_err();
        }
        Ok(if cum {
            f_tails(x, d1, d2).0
        } else {
            f_pdf(x, d1, d2)
        })
    })())
}

/// `F.DIST.RT(x, deg_freedom1, deg_freedom2)` (and `FDIST`).
pub fn f_dist_rt(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    out(f_args(args).map(|(x, d1, d2)| f_tails(x, d1, d2).1))
}

fn f_inv_impl(args: &[Arg], right: bool) -> R {
    let p = n_at(args, 0)?;
    let d1 = n_at(args, 1)?;
    let d2 = n_at(args, 2)?;
    let (d1, d2) = (df_of(d1)?, df_of(d2)?);
    if !(0.0..=1.0).contains(&p) {
        return num_err();
    }
    let (lo, hi) = if right { (1.0 - p, p) } else { (p, 1.0 - p) };
    if lo == 0.0 {
        return Ok(0.0);
    }
    if hi == 0.0 {
        return num_err();
    }
    // Solve on the beta variable z = d1 x / (d1 x + d2), then map back.
    let (z, y) = invert_beta(d1 / 2.0, d2 / 2.0, lo, hi);
    Ok(d2 * z / (d1 * y))
}

/// `F.INV(probability, deg_freedom1, deg_freedom2)`.
pub fn f_inv(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    out(f_inv_impl(args, false))
}

/// `F.INV.RT(probability, deg_freedom1, deg_freedom2)` (and `FINV`).
pub fn f_inv_rt(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    out(f_inv_impl(args, true))
}

/// The numbers of a value argument (reference cells: numbers only; an error
/// propagates).
fn numbers(arg: &Arg) -> Result<Vec<f64>, CellError> {
    let mut v = Vec::new();
    match arg {
        Arg::Scalar(s) => v.push(coerce::to_number(s)?),
        Arg::Range(r) => {
            for c in r.iter_live() {
                match c {
                    CellValue::Number(n) => v.push(n),
                    CellValue::Error(e) => return Err(e),
                    _ => {}
                }
            }
        }
    }
    Ok(v)
}

/// `F.TEST(array1, array2)` (and `FTEST`): the two-tailed probability of the
/// variance ratio.
pub fn f_test(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    out((|| {
        let a = numbers(&args[0])?;
        let b = numbers(&args[1])?;
        if a.len() < 2 || b.len() < 2 {
            return Err(CellError::Div0);
        }
        let (va, vb) = (variance(&a, false)?, variance(&b, false)?);
        if va == 0.0 || vb == 0.0 {
            return Err(CellError::Div0);
        }
        let (d1, d2) = ((a.len() - 1) as f64, (b.len() - 1) as f64);
        let (lo, hi) = f_tails(va / vb, d1, d2);
        Ok((2.0 * lo.min(hi)).min(1.0))
    })())
}

// ---- t ------------------------------------------------------------------------

/// Student's t tails `(P(T <= t), P(T > t))`.
pub(crate) fn t_tails(t: f64, df: f64) -> (f64, f64) {
    let t2 = t * t;
    // The two-sided tail P(|T| > |t|) = I_{df/(df+t²)}(df/2, 1/2).
    let den = df + t2;
    let (two_tail, _) = if t2 < df {
        let (lo, hi) = beta_i(0.5, df / 2.0, t2 / den, df / den);
        (hi, lo)
    } else {
        beta_i(df / 2.0, 0.5, df / den, t2 / den)
    };
    let half = two_tail / 2.0;
    if t >= 0.0 {
        (1.0 - half, half)
    } else {
        (half, 1.0 - half)
    }
}

fn t_pdf(t: f64, df: f64) -> f64 {
    (ln_gamma((df + 1.0) / 2.0)
        - ln_gamma(df / 2.0)
        - 0.5 * (df * std::f64::consts::PI).ln()
        - (df + 1.0) / 2.0 * (t * t / df).ln_1p())
    .exp()
}

/// `T.DIST(x, deg_freedom, cumulative)`.
pub fn t_dist(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    out((|| {
        let x = n_at(args, 0)?;
        let df = n_at(args, 1)?;
        let cum = b_at(args, 2)?;
        let df = df_of(df)?;
        Ok(if cum { t_tails(x, df).0 } else { t_pdf(x, df) })
    })())
}

/// `T.DIST.2T(x, deg_freedom)`.
pub fn t_dist_2t(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    out((|| {
        let x = n_at(args, 0)?;
        let df = n_at(args, 1)?;
        let df = df_of(df)?;
        if x < 0.0 {
            return num_err();
        }
        Ok((2.0 * t_tails(x, df).1).min(1.0))
    })())
}

/// `T.DIST.RT(x, deg_freedom)`.
pub fn t_dist_rt(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    out((|| {
        let x = n_at(args, 0)?;
        let df = n_at(args, 1)?;
        let df = df_of(df)?;
        Ok(t_tails(x, df).1)
    })())
}

/// `TDIST(x, deg_freedom, tails)` — legacy: `x >= 0`, `tails` 1 or 2.
pub fn tdist(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    out((|| {
        let x = n_at(args, 0)?;
        let df = n_at(args, 1)?;
        let tails = n_at(args, 2)?.trunc();
        let df = df_of(df)?;
        if x < 0.0 || (tails != 1.0 && tails != 2.0) {
            return num_err();
        }
        Ok((tails * t_tails(x, df).1).min(1.0))
    })())
}

/// The `t` with upper tail `q`, `0 < q < 1` (a `q` above ½ gives a negative
/// `t`; `1 − q` is formed only there, where it is exact).
fn t_upper_inv(q: f64, df: f64) -> f64 {
    if q == 0.5 {
        return 0.0;
    }
    if q > 0.5 {
        return -t_upper_inv(1.0 - q, df);
    }
    // P(|T| > t) = I_{df/(df+t²)}(df/2, 1/2) = 2q; t = √(df (1 − z) / z).
    let (z, y) = invert_beta(df / 2.0, 0.5, 2.0 * q, 1.0 - 2.0 * q);
    (df * y / z).sqrt()
}

/// `T.INV(probability, deg_freedom)` — left-tailed.
pub fn t_inv(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    out((|| {
        let p = n_at(args, 0)?;
        let df = n_at(args, 1)?;
        let df = df_of(df)?;
        if p <= 0.0 || p >= 1.0 {
            return num_err();
        }
        Ok(if p < 0.5 {
            -t_upper_inv(p, df)
        } else {
            t_upper_inv(1.0 - p, df)
        })
    })())
}

/// `T.INV.2T(probability, deg_freedom)` (and `TINV`).
pub fn t_inv_2t(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    out((|| {
        let p = n_at(args, 0)?;
        let df = n_at(args, 1)?;
        let df = df_of(df)?;
        // Excel-recorded: a probability in (1, 2) gives the negative root.
        if p <= 0.0 || p >= 2.0 {
            return num_err();
        }
        Ok(t_upper_inv(p / 2.0, df))
    })())
}

/// `T.TEST(array1, array2, tails, type)` (and `TTEST`).
pub fn t_test(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    out((|| {
        let tails = n_at(args, 2)?.trunc();
        let kind = n_at(args, 3)?.trunc();
        if (tails != 1.0 && tails != 2.0) || !(1.0..=3.0).contains(&kind) {
            return num_err();
        }
        let (t, df) = if kind == 1.0 {
            let a = flat(&args[0]);
            let b = flat(&args[1]);
            if a.len() != b.len() {
                return Err(CellError::Na);
            }
            let mut d = Vec::new();
            for (x, y) in a.iter().zip(&b) {
                if let CellValue::Error(e) = x {
                    return Err(*e);
                }
                if let CellValue::Error(e) = y {
                    return Err(*e);
                }
                if let (CellValue::Number(x), CellValue::Number(y)) = (x, y) {
                    d.push(x - y);
                }
            }
            if d.len() < 2 {
                return Err(CellError::Div0);
            }
            let n = d.len() as f64;
            let v = variance(&d, false)?;
            if v == 0.0 {
                return Err(CellError::Div0);
            }
            (mean(&d) / (v / n).sqrt(), n - 1.0)
        } else {
            let a = numbers(&args[0])?;
            let b = numbers(&args[1])?;
            if a.len() < 2 || b.len() < 2 {
                return Err(CellError::Div0);
            }
            let (na, nb) = (a.len() as f64, b.len() as f64);
            let (va, vb) = (variance(&a, false)?, variance(&b, false)?);
            let diff = mean(&a) - mean(&b);
            if kind == 2.0 {
                let pooled = ((na - 1.0) * va + (nb - 1.0) * vb) / (na + nb - 2.0);
                let se = (pooled * (1.0 / na + 1.0 / nb)).sqrt();
                if se == 0.0 {
                    return Err(CellError::Div0);
                }
                (diff / se, na + nb - 2.0)
            } else {
                let (sa, sb) = (va / na, vb / nb);
                let se = (sa + sb).sqrt();
                if se == 0.0 {
                    return Err(CellError::Div0);
                }
                let df = (sa + sb) * (sa + sb) / (sa * sa / (na - 1.0) + sb * sb / (nb - 1.0));
                (diff / se, df)
            }
        };
        Ok((tails * t_tails_real(t.abs(), df).1).min(1.0))
    })())
}

/// t tails for a real (non-integer) df (Welch).
fn t_tails_real(t: f64, df: f64) -> (f64, f64) {
    t_tails(t, df)
}

/// `Z.TEST(array, x, [sigma])` (and `ZTEST`).
pub fn z_test(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    out((|| {
        let v = numbers(&args[0])?;
        let x = n_at(args, 1)?;
        let sigma = match args.get(2) {
            None | Some(Arg::Scalar(CellValue::Empty)) => None,
            Some(_) => Some(n_at(args, 2)?),
        };
        if v.is_empty() {
            return Err(CellError::Na);
        }
        let n = v.len() as f64;
        let s = match sigma {
            Some(s) => {
                if s <= 0.0 {
                    return num_err();
                }
                s
            }
            None => variance(&v, false)?.sqrt(),
        };
        if s == 0.0 {
            return Err(CellError::Div0);
        }
        let z = (mean(&v) - x) / (s / n.sqrt());
        Ok(1.0 - std_norm_cdf(z))
    })())
}

// ---- exponential, gamma -------------------------------------------------------

/// `EXPON.DIST(x, lambda, cumulative)` (and `EXPONDIST`).
pub fn expon_dist(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    out((|| {
        let x = n_at(args, 0)?;
        let l = n_at(args, 1)?;
        let cum = b_at(args, 2)?;
        if x < 0.0 || l <= 0.0 {
            return num_err();
        }
        Ok(if cum {
            -(-l * x).exp_m1()
        } else {
            l * (-l * x).exp()
        })
    })())
}

/// `GAMMA(number)`.
pub fn gamma_fn(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    out(n_at(args, 0).and_then(|x| {
        let g = gamma(x);
        if g.is_nan() || g.is_infinite() {
            num_err()
        } else {
            Ok(g)
        }
    }))
}

/// `GAMMALN(x)` (and `GAMMALN.PRECISE`).
pub fn gammaln(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    out(n_at(args, 0).and_then(|x| if x <= 0.0 { num_err() } else { Ok(ln_gamma(x)) }))
}

fn gamma_pdf(x: f64, a: f64, b: f64) -> f64 {
    if x == 0.0 {
        return if a < 1.0 {
            f64::INFINITY
        } else if a == 1.0 {
            1.0 / b
        } else {
            0.0
        };
    }
    let z = x / b;
    // Loader's form for a > 1: dpois(a − 1, z) / b keeps the far tails.
    if a >= 1.0 {
        return dpois_cont(a - 1.0, z) / b;
    }
    ((a - 1.0) * z.ln() - z - ln_gamma(a)).exp() / b
}

/// The Poisson density at a real count (the gamma density's kernel).
fn dpois_cont(k: f64, l: f64) -> f64 {
    if k == k.floor() {
        return dpois_raw(k, l);
    }
    (k * l.ln() - l - ln_gamma(k + 1.0)).exp()
}

/// `GAMMA.DIST(x, alpha, beta, cumulative)` (and `GAMMADIST`).
pub fn gamma_dist(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    out((|| {
        let x = n_at(args, 0)?;
        let a = n_at(args, 1)?;
        let b = n_at(args, 2)?;
        let cum = b_at(args, 3)?;
        if x < 0.0 || a <= 0.0 || b <= 0.0 || (x == 0.0 && !cum) {
            return num_err();
        }
        Ok(if cum {
            gamma_p_q(a, x / b).0
        } else {
            gamma_pdf(x, a, b)
        })
    })())
}

/// `GAMMA.INV(probability, alpha, beta)` (and `GAMMAINV`).
pub fn gamma_inv(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    out((|| {
        let p = n_at(args, 0)?;
        let a = n_at(args, 1)?;
        let b = n_at(args, 2)?;
        if !(0.0..=1.0).contains(&p) || a <= 0.0 || b <= 0.0 {
            return num_err();
        }
        if p == 0.0 {
            return Ok(0.0);
        }
        if p == 1.0 {
            return num_err();
        }
        Ok(b * invert_tails(|x| gamma_p_q(a, x), p, 1.0 - p, None))
    })())
}

/// `GAUSS(z)`: `Φ(z) − ½`.
pub fn gauss(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    // ½ erf(z/√2) near zero, Φ(|z|) − ½ with the sign of z beyond: GAUSS is
    // exactly odd.
    out(n_at(args, 0).map(|z| {
        if z.abs() < 1.0 {
            0.5 * crate::special::erf(z / std::f64::consts::SQRT_2)
        } else {
            z.signum() * (std_norm_cdf(z.abs()) - 0.5)
        }
    }))
}

/// `PHI(x)`: the standard normal density.
pub fn phi(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    out(n_at(args, 0).map(|x| (-0.5 * x * x).exp() / (2.0 * std::f64::consts::PI).sqrt()))
}

// ---- hypergeometric, lognormal, negative binomial, Poisson, Weibull -----------

fn hyp_pmf(x: f64, n: f64, m: f64, pop: f64) -> f64 {
    if x > n.min(m) || x < (n - pop + m).max(0.0) {
        return 0.0;
    }
    let p = n / pop;
    let q = (pop - n) / pop;
    let p1 = dbinom_raw(x, m, p, q);
    let p2 = dbinom_raw(n - x, pop - m, p, q);
    let p3 = dbinom_raw(n, pop, p, q);
    p1 * p2 / p3
}

fn hyp_args(args: &[Arg]) -> Result<(f64, f64, f64, f64), CellError> {
    let x = n_at(args, 0)?.trunc();
    let n = n_at(args, 1)?.trunc();
    let m = n_at(args, 2)?.trunc();
    let pop = n_at(args, 3)?.trunc();
    if x < 0.0 || n < 0.0 || m < 0.0 || pop <= 0.0 || n > pop || m > pop {
        return num_err();
    }
    Ok((x, n, m, pop))
}

/// `HYPGEOM.DIST(sample_s, number_sample, population_s, number_pop,
/// cumulative)`.
pub fn hypgeom_dist(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    out((|| {
        let (x, n, m, pop) = hyp_args(args)?;
        let cum = b_at(args, 4)?;
        if !cum {
            return Ok(hyp_pmf(x, n, m, pop));
        }
        let mut s = 0.0;
        let mut k = (n - pop + m).max(0.0);
        let x = x.min(n.min(m));
        while k <= x {
            s += hyp_pmf(k, n, m, pop);
            k += 1.0;
        }
        Ok(s.min(1.0))
    })())
}

/// `HYPGEOMDIST(sample_s, number_sample, population_s, number_pop)` — the
/// density.
pub fn hypgeomdist(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    out(hyp_args(args).map(|(x, n, m, pop)| hyp_pmf(x, n, m, pop)))
}

fn lognorm_args(args: &[Arg]) -> Result<(f64, f64, f64), CellError> {
    let x = n_at(args, 0)?;
    let mu = n_at(args, 1)?;
    let sd = n_at(args, 2)?;
    if x <= 0.0 || sd <= 0.0 {
        return num_err();
    }
    Ok((x, mu, sd))
}

/// `LOGNORM.DIST(x, mean, standard_dev, cumulative)`.
pub fn lognorm_dist(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    out((|| {
        let (x, mu, sd) = lognorm_args(args)?;
        let cum = b_at(args, 3)?;
        let z = (x.ln() - mu) / sd;
        Ok(if cum {
            std_norm_cdf(z)
        } else {
            (-0.5 * z * z).exp() / (x * sd * (2.0 * std::f64::consts::PI).sqrt())
        })
    })())
}

/// `LOGNORMDIST(x, mean, standard_dev)` — cumulative.
pub fn lognormdist(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    out(lognorm_args(args).map(|(x, mu, sd)| std_norm_cdf((x.ln() - mu) / sd)))
}

/// `LOGNORM.INV(probability, mean, standard_dev)` (and `LOGINV`).
pub fn lognorm_inv(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    out((|| {
        let p = n_at(args, 0)?;
        let mu = n_at(args, 1)?;
        let sd = n_at(args, 2)?;
        if p <= 0.0 || p >= 1.0 || sd <= 0.0 {
            return num_err();
        }
        Ok((mu + sd * std_norm_inv(p)).exp())
    })())
}

fn negbinom_args(args: &[Arg]) -> Result<(f64, f64, f64), CellError> {
    let f = n_at(args, 0)?.trunc();
    let s = n_at(args, 1)?.trunc();
    let p = n_at(args, 2)?;
    if f < 0.0 || s < 1.0 || p <= 0.0 || p >= 1.0 {
        return num_err();
    }
    Ok((f, s, p))
}

fn negbinom_pmf(f: f64, s: f64, p: f64) -> f64 {
    s / (f + s) * dbinom_raw(s, f + s, p, 1.0 - p)
}

/// `NEGBINOM.DIST(number_f, number_s, probability_s, cumulative)`.
pub fn negbinom_dist(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    out((|| {
        let (f, s, p) = negbinom_args(args)?;
        let cum = b_at(args, 3)?;
        if cum {
            Ok(beta_i(s, f + 1.0, p, 1.0 - p).0)
        } else {
            Ok(negbinom_pmf(f, s, p))
        }
    })())
}

/// `NEGBINOMDIST(number_f, number_s, probability_s)` — the density.
pub fn negbinomdist(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    out(negbinom_args(args).map(|(f, s, p)| negbinom_pmf(f, s, p)))
}

/// `POISSON.DIST(x, mean, cumulative)` (and `POISSON`).
pub fn poisson_dist(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    out((|| {
        let x = n_at(args, 0)?.trunc();
        let l = n_at(args, 1)?;
        let cum = b_at(args, 2)?;
        if x < 0.0 || l < 0.0 {
            return num_err();
        }
        if !cum {
            return Ok(dpois_raw(x, l));
        }
        if l == 0.0 {
            return Ok(1.0);
        }
        if x <= 1000.0 {
            let mut s = 0.0;
            let mut k = 0.0;
            while k <= x {
                s += dpois_raw(k, l);
                k += 1.0;
            }
            Ok(s.min(1.0))
        } else {
            Ok(gamma_p_q(x + 1.0, l).1)
        }
    })())
}

/// `WEIBULL.DIST(x, alpha, beta, cumulative)` (and `WEIBULL`).
pub fn weibull_dist(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    out((|| {
        let x = n_at(args, 0)?;
        let a = n_at(args, 1)?;
        let b = n_at(args, 2)?;
        let cum = b_at(args, 3)?;
        if x < 0.0 || a <= 0.0 || b <= 0.0 {
            return num_err();
        }
        let z = (x / b).powf(a);
        Ok(if cum {
            -(-z).exp_m1()
        } else if x == 0.0 {
            // Excel-recorded: the density at 0 is 0 for every shape.
            0.0
        } else {
            a / b * (x / b).powf(a - 1.0) * (-z).exp()
        })
    })())
}

// ---- confidence, covariance, correlation --------------------------------------

/// `CONFIDENCE.NORM(alpha, standard_dev, size)` (and `CONFIDENCE`).
pub fn confidence_norm(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    out((|| {
        let alpha = n_at(args, 0)?;
        let sd = n_at(args, 1)?;
        let n = n_at(args, 2)?.trunc();
        if alpha <= 0.0 || alpha >= 1.0 || sd <= 0.0 || n < 1.0 {
            return num_err();
        }
        // Excel-recorded: the quantile of 1 − α/2 as written.
        Ok(std_norm_inv(1.0 - alpha / 2.0) * sd / n.sqrt())
    })())
}

/// `CONFIDENCE.T(alpha, standard_dev, size)`.
pub fn confidence_t(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    out((|| {
        let alpha = n_at(args, 0)?;
        let sd = n_at(args, 1)?;
        let n = n_at(args, 2)?.trunc();
        if alpha <= 0.0 || alpha >= 1.0 || sd <= 0.0 || n < 1.0 {
            return num_err();
        }
        if n == 1.0 {
            return Err(CellError::Div0);
        }
        Ok(t_upper_inv(alpha / 2.0, n - 1.0) * sd / n.sqrt())
    })())
}

/// The numeric pairs of two equally counted arrays (`#N/A` for different
/// counts); a pair with a non-number is dropped; errors propagate.
fn pairs(args: &[Arg]) -> Result<Vec<(f64, f64)>, CellError> {
    let a = flat(&args[0]);
    let b = flat(&args[1]);
    if a.len() != b.len() {
        return Err(CellError::Na);
    }
    let mut v = Vec::new();
    for (x, y) in a.iter().zip(&b) {
        if let CellValue::Error(e) = x {
            return Err(*e);
        }
        if let CellValue::Error(e) = y {
            return Err(*e);
        }
        if let (CellValue::Number(x), CellValue::Number(y)) = (x, y) {
            v.push((*x, *y));
        }
    }
    Ok(v)
}

/// `(n, Σ(x−x̄)², Σ(y−ȳ)², Σ(x−x̄)(y−ȳ))` of the pairs.
fn centred(p: &[(f64, f64)]) -> (f64, f64, f64, f64) {
    let n = p.len() as f64;
    let mx = p.iter().map(|q| q.0).sum::<f64>() / n;
    let my = p.iter().map(|q| q.1).sum::<f64>() / n;
    let (mut sxx, mut syy, mut sxy) = (0.0, 0.0, 0.0);
    for &(x, y) in p {
        sxx += (x - mx) * (x - mx);
        syy += (y - my) * (y - my);
        sxy += (x - mx) * (y - my);
    }
    (n, sxx, syy, sxy)
}

/// `COVARIANCE.P(array1, array2)` (and `COVAR`).
pub fn covariance_p(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    out(pairs(args).and_then(|p| {
        if p.is_empty() {
            return Err(CellError::Div0);
        }
        let (n, _, _, sxy) = centred(&p);
        Ok(sxy / n)
    }))
}

/// `COVARIANCE.S(array1, array2)`.
pub fn covariance_s(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    out(pairs(args).and_then(|p| {
        if p.len() < 2 {
            return Err(CellError::Div0);
        }
        let (n, _, _, sxy) = centred(&p);
        Ok(sxy / (n - 1.0))
    }))
}

/// `PEARSON(array1, array2)`.
pub fn pearson(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    out(pairs(args).and_then(|p| {
        if p.is_empty() {
            return Err(CellError::Div0);
        }
        let (_, sxx, syy, sxy) = centred(&p);
        let d = (sxx * syy).sqrt();
        if d == 0.0 {
            return Err(CellError::Div0);
        }
        Ok(sxy / d)
    }))
}

/// `STEYX(known_y's, known_x's)`.
pub fn steyx(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    out(pairs(args).and_then(|p| {
        // pairs() reads (y, x): the first argument is known_y's.
        if p.len() < 3 {
            return Err(CellError::Div0);
        }
        let (n, syy, sxx, sxy) = centred(&p);
        if sxx == 0.0 {
            return Err(CellError::Div0);
        }
        Ok(((syy - sxy * sxy / sxx) / (n - 2.0)).max(0.0).sqrt())
    }))
}

// ---- moments ------------------------------------------------------------------

fn value_numbers(args: &[Arg]) -> Result<Vec<f64>, CellError> {
    let mut v = Vec::new();
    for a in args {
        v.extend(numbers(a)?);
    }
    Ok(v)
}

/// `KURT(number1, …)`.
pub fn kurt(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    out(value_numbers(args).and_then(|v| {
        let n = v.len() as f64;
        if v.len() < 4 {
            return Err(CellError::Div0);
        }
        let m = mean(&v);
        let s2 = sum_sq_dev(&v) / (n - 1.0);
        if s2 == 0.0 {
            return Err(CellError::Div0);
        }
        let s4: f64 = v.iter().map(|x| ((x - m) * (x - m) / s2).powi(2)).sum();
        Ok(n * (n + 1.0) / ((n - 1.0) * (n - 2.0) * (n - 3.0)) * s4
            - 3.0 * (n - 1.0) * (n - 1.0) / ((n - 2.0) * (n - 3.0)))
    }))
}

/// `SKEW(number1, …)`.
pub fn skew(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    out(value_numbers(args).and_then(|v| {
        let n = v.len() as f64;
        if v.len() < 3 {
            return Err(CellError::Div0);
        }
        let m = mean(&v);
        let s = (sum_sq_dev(&v) / (n - 1.0)).sqrt();
        if s == 0.0 {
            return Err(CellError::Div0);
        }
        let s3: f64 = v.iter().map(|x| ((x - m) / s).powi(3)).sum();
        Ok(n / ((n - 1.0) * (n - 2.0)) * s3)
    }))
}

/// `SKEW.P(number1, …)`.
pub fn skew_p(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    out(value_numbers(args).and_then(|v| {
        let n = v.len() as f64;
        if v.len() < 3 {
            return Err(CellError::Div0);
        }
        let m = mean(&v);
        let s = (sum_sq_dev(&v) / n).sqrt();
        if s == 0.0 {
            return Err(CellError::Div0);
        }
        let s3: f64 = v.iter().map(|x| ((x - m) / s).powi(3)).sum();
        Ok(s3 / n)
    }))
}

/// `STANDARDIZE(x, mean, standard_dev)`.
pub fn standardize(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    out((|| {
        let x = n_at(args, 0)?;
        let m = n_at(args, 1)?;
        let sd = n_at(args, 2)?;
        if sd <= 0.0 {
            return num_err();
        }
        Ok((x - m) / sd)
    })())
}

/// `TRIMMEAN(array, percent)`: drops `⌊n·percent/2⌋` values at each end.
pub fn trimmean(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    out((|| {
        let v = numbers(&args[0])?;
        let pct = n_at(args, 1)?;
        if !(0.0..1.0).contains(&pct) || v.is_empty() {
            return num_err();
        }
        let mut s = v;
        s.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let k = ((s.len() as f64 * pct / 2.0) + 1e-9).floor() as usize;
        let kept = &s[k..s.len() - k];
        if kept.is_empty() {
            return num_err();
        }
        Ok(mean(kept))
    })())
}

/// `MODE.MULT(number1, …)`: the most frequent values in order of first
/// appearance, as a column.
pub fn mode_mult(args: &[Arg], _ctx: &EvalCtx) -> FnResult {
    let v = match value_numbers(args) {
        Ok(v) => v,
        Err(e) => return FnResult::Scalar(CellValue::Error(e)),
    };
    let mut counts: Vec<(f64, usize)> = Vec::new();
    for x in v {
        match counts.iter_mut().find(|c| c.0 == x) {
            Some(c) => c.1 += 1,
            None => counts.push((x, 1)),
        }
    }
    let best = counts.iter().map(|c| c.1).max().unwrap_or(0);
    if best < 2 {
        return FnResult::Scalar(CellValue::Error(CellError::Na));
    }
    FnResult::Array(
        counts
            .into_iter()
            .filter(|c| c.1 == best)
            .map(|c| vec![CellValue::Number(c.0)])
            .collect(),
    )
}

/// `RANK.AVG(number, ref, [order])`: tied values share the average rank.
pub fn rank_avg(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    out((|| {
        let x = n_at(args, 0)?;
        let pool = numbers(&args[1])?;
        let asc = match args.get(2) {
            None | Some(Arg::Scalar(CellValue::Empty)) => false,
            Some(_) => n_at(args, 2)? != 0.0,
        };
        let eq = pool.iter().filter(|&&v| v == x).count();
        if eq == 0 {
            return Err(CellError::Na);
        }
        let better = pool
            .iter()
            .filter(|&&v| if asc { v < x } else { v > x })
            .count();
        Ok(better as f64 + (eq as f64 + 1.0) / 2.0)
    })())
}

/// `PERMUTATIONA(number, number_chosen)`: `n^k`.
pub fn permutationa(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    out((|| {
        let n = n_at(args, 0)?.trunc();
        let k = n_at(args, 1)?.trunc();
        if n < 0.0 || k < 0.0 {
            return num_err();
        }
        Ok(n.powf(k))
    })())
}

/// `PROB(x_range, prob_range, lower_limit, [upper_limit])`.
pub fn prob(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    out((|| {
        let xs = flat(&args[0]);
        let ps = flat(&args[1]);
        if xs.len() != ps.len() {
            return Err(CellError::Na);
        }
        let lo = n_at(args, 2)?;
        let hi = match args.get(3) {
            None | Some(Arg::Scalar(CellValue::Empty)) => lo,
            Some(_) => n_at(args, 3)?,
        };
        let mut total = 0.0;
        let mut acc = 0.0;
        for (x, p) in xs.iter().zip(&ps) {
            if let CellValue::Error(e) = x {
                return Err(*e);
            }
            if let CellValue::Error(e) = p {
                return Err(*e);
            }
            // Excel-recorded: a non-number in either range is #NUM!; a single
            // probability outside [0, 1] is not, only their sum must be 1.
            let (CellValue::Number(x), CellValue::Number(p)) = (x, p) else {
                return num_err();
            };
            total += p;
            if *x >= lo && *x <= hi {
                acc += p;
            }
        }
        if (total - 1.0).abs() > 1e-9 {
            return num_err();
        }
        Ok(acc)
    })())
}

/// `FISHER(x)`.
pub fn fisher(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    out(n_at(args, 0).and_then(|x| {
        if x <= -1.0 || x >= 1.0 {
            num_err()
        } else {
            // Excel-recorded: ½ ln((1+x)/(1−x)) as written.
            Ok(0.5 * ((1.0 + x) / (1.0 - x)).ln())
        }
    }))
}

/// `FISHERINV(y)`.
pub fn fisherinv(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    // Excel-recorded: (e^{2y} − 1)/(e^{2y} + 1) as written.
    out(n_at(args, 0).map(|y| {
        let e = (2.0 * y).exp();
        if e.is_infinite() {
            1.0
        } else {
            (e - 1.0) / (e + 1.0)
        }
    }))
}

// ---- GROWTH / LOGEST ----------------------------------------------------------

/// Every cell of a grid as a number (errors propagate, anything else is
/// `#VALUE!`).
fn strict(g: &[Vec<CellValue>]) -> Result<Vec<Vec<f64>>, CellError> {
    g.iter()
        .map(|row| {
            row.iter()
                .map(|v| match v {
                    CellValue::Number(n) => Ok(*n),
                    CellValue::Error(e) => Err(*e),
                    _ => Err(CellError::Value),
                })
                .collect()
        })
        .collect()
}

/// The log-linear regression shared by GROWTH and LOGEST: `ln y = b + Σ mᵢxᵢ`.
/// Returns the coefficients (`m_1 … m_k`, then `b`), the regressor rows, the
/// orientation, and the fit statistics inputs.
struct LogFit {
    beta: Vec<f64>,
    k: usize,
    with_const: bool,
    y_is_col: bool,
    xrows: Vec<Vec<f64>>,
    ly: Vec<f64>,
    inv: Vec<Vec<f64>>,
}

fn log_fit(args: &[Arg], const_at: usize) -> Result<LogFit, CellError> {
    let yg = grid(&args[0]);
    let ys: Vec<f64> = strict(&yg)?.into_iter().flatten().collect();
    if ys.iter().any(|&y| y <= 0.0) {
        return num_err();
    }
    let ly: Vec<f64> = ys.iter().map(|y| y.ln()).collect();
    let n = ly.len();
    let y_is_col = yg.first().map_or(0, Vec::len) == 1;
    let xrows: Vec<Vec<f64>> = match args.get(1) {
        None | Some(Arg::Scalar(CellValue::Empty)) => (1..=n).map(|i| vec![i as f64]).collect(),
        Some(a) => {
            let g = strict(&grid(a))?;
            let (gr, gc) = (g.len(), g.first().map_or(0, Vec::len));
            if y_is_col && gr == n {
                g
            } else if !y_is_col && gc == n && gr >= 1 {
                (0..n)
                    .map(|c| g.iter().map(|row| row[c]).collect())
                    .collect()
            } else if gr * gc == n {
                g.into_iter().flatten().map(|x| vec![x]).collect()
            } else {
                return Err(CellError::Ref);
            }
        }
    };
    let k = xrows.first().map_or(0, Vec::len);
    let with_const = match args.get(const_at) {
        None | Some(Arg::Scalar(CellValue::Empty)) => true,
        Some(_) => b_at(args, const_at)?,
    };
    let p = k + usize::from(with_const);
    let row = |r: &[f64]| -> Vec<f64> {
        let mut v = r.to_vec();
        if with_const {
            v.push(1.0);
        }
        v
    };
    let mut xtx = vec![vec![0.0; p]; p];
    let mut xty = vec![0.0; p];
    for (i, y) in ly.iter().enumerate() {
        let r = row(&xrows[i]);
        for a in 0..p {
            xty[a] += r[a] * y;
            for b in 0..p {
                xtx[a][b] += r[a] * r[b];
            }
        }
    }
    let inv = invert(xtx).ok_or(CellError::Num)?;
    let beta: Vec<f64> = (0..p)
        .map(|a| (0..p).map(|b| inv[a][b] * xty[b]).sum())
        .collect();
    Ok(LogFit {
        beta,
        k,
        with_const,
        y_is_col,
        xrows,
        ly,
        inv,
    })
}

/// `GROWTH(known_y's, [known_x's], [new_x's], [const])`.
pub fn growth(args: &[Arg], _ctx: &EvalCtx) -> FnResult {
    let fail = |e: CellError| FnResult::Scalar(CellValue::Error(e));
    let fit = match log_fit(args, 3) {
        Ok(f) => f,
        Err(e) => return fail(e),
    };
    let predict = |r: &[f64]| -> CellValue {
        let mut s = if fit.with_const { fit.beta[fit.k] } else { 0.0 };
        for (j, x) in r.iter().enumerate() {
            s += fit.beta[j] * x;
        }
        finite(s.exp())
    };
    match args.get(2) {
        None | Some(Arg::Scalar(CellValue::Empty)) => {
            let preds: Vec<CellValue> = fit.xrows.iter().map(|r| predict(r)).collect();
            FnResult::Array(if fit.y_is_col {
                preds.into_iter().map(|v| vec![v]).collect()
            } else {
                vec![preds]
            })
        }
        Some(a) => {
            let g = grid(a);
            let ng = match strict(&g) {
                Ok(g) => g,
                Err(e) => return fail(e),
            };
            if fit.k == 1 {
                FnResult::Array(
                    ng.iter()
                        .map(|row| row.iter().map(|x| predict(&[*x])).collect())
                        .collect(),
                )
            } else if fit.y_is_col {
                if ng.iter().any(|r| r.len() != fit.k) {
                    return fail(CellError::Ref);
                }
                FnResult::Array(ng.iter().map(|r| vec![predict(r)]).collect())
            } else {
                if ng.len() != fit.k {
                    return fail(CellError::Ref);
                }
                let cols = ng.first().map_or(0, Vec::len);
                let preds: Vec<CellValue> = (0..cols)
                    .map(|c| {
                        let r: Vec<f64> = ng.iter().map(|row| row[c]).collect();
                        predict(&r)
                    })
                    .collect();
                FnResult::Array(vec![preds])
            }
        }
    }
}

/// `LOGEST(known_y's, [known_x's], [const], [stats])`: `y = b · Π mᵢ^xᵢ`; the
/// statistics rows are those of the linear fit of `ln y` (as LINEST).
pub fn logest(args: &[Arg], _ctx: &EvalCtx) -> FnResult {
    let fail = |e: CellError| FnResult::Scalar(CellValue::Error(e));
    let fit = match log_fit(args, 2) {
        Ok(f) => f,
        Err(e) => return fail(e),
    };
    let stats = match args.get(3) {
        None | Some(Arg::Scalar(CellValue::Empty)) => false,
        Some(_) => match b_at(args, 3) {
            Ok(b) => b,
            Err(e) => return fail(e),
        },
    };
    let k = fit.k;
    let b = if fit.with_const { fit.beta[k] } else { 0.0 };
    let mut first: Vec<CellValue> = (0..k).rev().map(|j| finite(fit.beta[j].exp())).collect();
    first.push(finite(b.exp()));
    if !stats {
        return FnResult::Array(vec![first]);
    }
    let n = fit.ly.len();
    let p = k + usize::from(fit.with_const);
    let fitted: Vec<f64> = fit
        .xrows
        .iter()
        .map(|r| {
            let mut s = b;
            for (j, x) in r.iter().enumerate() {
                s += fit.beta[j] * x;
            }
            s
        })
        .collect();
    let ss_resid: f64 = fit
        .ly
        .iter()
        .zip(&fitted)
        .map(|(y, f)| (y - f).powi(2))
        .sum();
    let ss_reg: f64 = if fit.with_const {
        let m = mean(&fit.ly);
        fitted.iter().map(|f| (f - m).powi(2)).sum()
    } else {
        fitted.iter().map(|f| f * f).sum()
    };
    let df = n as f64 - p as f64;
    let na = CellValue::Error(CellError::Na);
    let cols = k + 1;
    let pad = |mut v: Vec<CellValue>| {
        v.resize(cols, na.clone());
        v
    };
    let sey2 = if df > 0.0 { ss_resid / df } else { f64::NAN };
    let se = |j: usize| -> CellValue {
        if df > 0.0 {
            finite((fit.inv[j][j] * sey2).sqrt())
        } else {
            CellValue::Error(CellError::Num)
        }
    };
    let mut second: Vec<CellValue> = (0..k).rev().map(se).collect();
    second.push(if fit.with_const { se(k) } else { na.clone() });
    let r2 = if ss_reg + ss_resid == 0.0 {
        CellValue::Number(1.0)
    } else {
        finite(ss_reg / (ss_reg + ss_resid))
    };
    let sey = if df > 0.0 {
        finite(sey2.sqrt())
    } else {
        CellValue::Error(CellError::Num)
    };
    let f = if df > 0.0 && ss_resid > 0.0 {
        finite((ss_reg / k as f64) / (ss_resid / df))
    } else {
        CellValue::Error(CellError::Num)
    };
    FnResult::Array(vec![
        first,
        second,
        pad(vec![r2, sey]),
        pad(vec![f, CellValue::Number(df)]),
        pad(vec![finite(ss_reg), finite(ss_resid)]),
    ])
}
