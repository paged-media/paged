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

//! W3 financial functions (F3): the coupon schedule and the bond family
//! (`COUP*`, `PRICE`, `YIELD`, `DURATION`, `MDURATION`, `ACCRINT`,
//! `ACCRINTM`, the discount securities, `PRICEMAT`/`YIELDMAT`, the T-bill
//! functions, the odd first and last periods), French depreciation
//! (`AMORDEGRC`, `AMORLINC`), `VDB`, `CUMIPMT`/`CUMPRINC`, `EFFECT`/`NOMINAL`,
//! `ISPMT`, `PDURATION`, `RRI`, `FVSCHEDULE`, `DOLLARDE`/`DOLLARFR`. Every
//! behaviour is Excel-recorded (`corpus/fn-corpus/fin2`,
//! `sheet-conformance/oracle/excel/recorded/fin2.tsv`); provenance is
//! Microsoft's function reference, with the conventions it leaves open
//! taken from the recordings.
//!
//! ## Rulings
//!
//! - **The coupon schedule** steps back from maturity in `12/frequency`
//!   months; a maturity on the last day of its month puts every coupon date on
//!   a month end, otherwise the day is the maturity's, clamped. `COUPDAYS` on
//!   the actual basis is the days from the previous coupon date to that date
//!   plus one period (day clamped, no month-end rule), or to maturity in the
//!   last period; the days to the next coupon in the bond formulas are
//!   `COUPDAYS − COUPDAYBS`.
//! - **30/360 (basis 0)** in the coupon and discount functions: a start on
//!   the last day of February or the 31st becomes the 30th, an end on the 31st
//!   becomes the 30th when the start was the 30th or 31st, and an end on the
//!   last day of February too when the start was. `PRICEMAT`/`YIELDMAT` use the
//!   rule without the February adjustments; the days to maturity of an odd
//!   last period move every 31st end to the 30th.
//! - **Year fractions** follow `YEARFRAC` (basis 1: the actual year length, or
//!   the average over the calendar years spanned beyond one year).
//! - **Iterative results** (`YIELD`, `ODDFYIELD`) solve to full precision;
//!   Excel stops its iteration earlier, so they agree to about 1e-10 (listed).
//! - **Divergences** (listed rows): the long odd first period of
//!   `ODDFPRICE`/`ODDFYIELD` follows Microsoft's documented formula, which
//!   Excel's own values do not match when settlement falls after the first
//!   quasi-coupon date; `ACCRINT` and `ODDLPRICE` on the actual basis over
//!   several quasi-periods.

use sheet_core::{CellError, CellValue, DateSystem};
use sheet_format::serial::{serial_to_ymd, ymd_to_serial};

use super::util::{finite, flat, num, scalar};
use crate::arg::Arg;
use crate::coerce;
use crate::ctx::EvalCtx;
use crate::special::solve_bracketed;

type R<T = f64> = Result<T, CellError>;

fn out(r: R) -> CellValue {
    match r {
        Ok(v) => finite(v),
        Err(e) => CellValue::Error(e),
    }
}

fn nerr<T>() -> R<T> {
    Err(CellError::Num)
}

fn n(args: &[Arg], i: usize) -> R {
    num(args.get(i))
}

fn opt(args: &[Arg], i: usize, default: f64) -> R {
    match args.get(i) {
        None | Some(Arg::Scalar(CellValue::Empty)) => Ok(default),
        Some(a) => num(Some(a)),
    }
}

// ---- dates ------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
struct Day {
    serial: i64,
    y: i32,
    m: u32,
    d: u32,
}

fn is_leap(y: i32) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

fn dim(y: i32, m: u32) -> u32 {
    match m {
        2 => {
            if is_leap(y) {
                29
            } else {
                28
            }
        }
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

fn day(serial: i64, sys: DateSystem) -> R<Day> {
    if serial < 0 {
        return nerr();
    }
    let (y, m, d) = serial_to_ymd(serial as f64, sys).ok_or(CellError::Num)?;
    Ok(Day { serial, y, m, d })
}

fn ymd(y: i32, m: u32, d: u32, sys: DateSystem) -> R<Day> {
    let s = ymd_to_serial(y, m, d, sys).ok_or(CellError::Num)?;
    Ok(Day {
        serial: s as i64,
        y,
        m,
        d,
    })
}

fn date_arg(args: &[Arg], i: usize, sys: DateSystem) -> R<Day> {
    // A date written as text reads as DATEVALUE would (Excel-recorded).
    if let Some(CellValue::Text(t)) = scalar(args.get(i)) {
        if let Some(v) = super::date2::parse_date(t.trim(), sys) {
            return day(v.trunc() as i64, sys);
        }
    }
    let v = n(args, i)?;
    day(v.trunc() as i64, sys)
}

/// `anchor` moved by `months` (negative: back); `eom` keeps month ends.
fn add_months(anchor: Day, months: i64, eom: bool, sys: DateSystem) -> R<Day> {
    let t = i64::from(anchor.y) * 12 + i64::from(anchor.m) - 1 + months;
    let y = t.div_euclid(12) as i32;
    let m = (t.rem_euclid(12) + 1) as u32;
    let d = if eom {
        dim(y, m)
    } else {
        anchor.d.min(dim(y, m))
    };
    ymd(y, m, d, sys)
}

fn is_month_end(d: Day) -> bool {
    d.d == dim(d.y, d.m)
}

#[derive(Clone, Copy)]
enum D360 {
    /// The coupon/discount 30/360 rule (see the module doc).
    Nasd,
    /// Without the February adjustments.
    Plain,
    /// The odd-last-period days to maturity.
    EndAll,
    /// European.
    Eu,
}

fn d360(a: Day, b: Day, rule: D360) -> i64 {
    let (mut d1, mut d2) = (a.d, b.d);
    let lf1 = a.m == 2 && a.d == dim(a.y, 2);
    let lf2 = b.m == 2 && b.d == dim(b.y, 2);
    match rule {
        D360::Nasd => {
            let o1 = d1;
            if lf1 && lf2 {
                d2 = 30;
            }
            if d2 == 31 && o1 >= 30 {
                d2 = 30;
            }
            if lf1 || d1 == 31 {
                d1 = 30;
            }
        }
        D360::Plain => {
            if d2 == 31 && d1 >= 30 {
                d2 = 30;
            }
            if d1 == 31 {
                d1 = 30;
            }
        }
        D360::EndAll => {
            if lf1 || d1 == 31 {
                d1 = 30;
            }
            if d2 == 31 {
                d2 = 30;
            }
        }
        D360::Eu => {
            d1 = d1.min(30);
            d2 = d2.min(30);
        }
    }
    i64::from(b.y - a.y) * 360
        + (i64::from(b.m) - i64::from(a.m)) * 30
        + (i64::from(d2) - i64::from(d1))
}

/// Days between two dates on a basis (30/360 for 0 and 4, actual else).
fn days(a: Day, b: Day, basis: i64) -> f64 {
    match basis {
        0 => d360(a, b, D360::Nasd) as f64,
        4 => d360(a, b, D360::Eu) as f64,
        _ => (b.serial - a.serial) as f64,
    }
}

/// `YEARFRAC(a, b, basis)` with Excel's actual/actual rule.
fn yearfrac(a: Day, b: Day, basis: i64, sys: DateSystem) -> R {
    let (a, b) = if a <= b { (a, b) } else { (b, a) };
    Ok(match basis {
        0 => d360(a, b, D360::Nasd) as f64 / 360.0,
        4 => d360(a, b, D360::Eu) as f64 / 360.0,
        2 => (b.serial - a.serial) as f64 / 360.0,
        3 => (b.serial - a.serial) as f64 / 365.0,
        _ => {
            let within =
                a.y == b.y || (b.y == a.y + 1 && (a.m > b.m || (a.m == b.m && a.d >= b.d)));
            let den = if within {
                if a.y == b.y && is_leap(a.y) {
                    366.0
                } else {
                    let mut feb = false;
                    for y in [a.y, b.y] {
                        if is_leap(y) {
                            let f = ymd(y, 2, 29, sys)?;
                            if a <= f && f <= b {
                                feb = true;
                            }
                        }
                    }
                    if feb {
                        366.0
                    } else {
                        365.0
                    }
                }
            } else {
                let total: f64 = (a.y..=b.y)
                    .map(|y| if is_leap(y) { 366.0 } else { 365.0 })
                    .sum();
                total / f64::from(b.y - a.y + 1)
            };
            (b.serial - a.serial) as f64 / den
        }
    })
}

fn basis_arg(args: &[Arg], i: usize) -> R<i64> {
    let b = opt(args, i, 0.0)?.trunc();
    if !(0.0..=4.0).contains(&b) {
        return nerr();
    }
    Ok(b as i64)
}

fn freq_arg(args: &[Arg], i: usize) -> R<i64> {
    let f = n(args, i)?.trunc();
    if f != 1.0 && f != 2.0 && f != 4.0 {
        return nerr();
    }
    Ok(f as i64)
}

// ---- the coupon schedule ----------------------------------------------------

struct Coupon {
    pcd: Day,
    ncd: Day,
    count: i64,
    /// COUPDAYS.
    e: f64,
    /// COUPDAYBS.
    a: f64,
    /// COUPDAYSNC.
    dsc: f64,
}

fn coupon(s: Day, m: Day, f: i64, basis: i64, sys: DateSystem) -> R<Coupon> {
    if s >= m {
        return nerr();
    }
    let months = 12 / f;
    let eom = is_month_end(m);
    let mut k = 1;
    let (pcd, ncd) = loop {
        let d = add_months(m, -k * months, eom, sys)?;
        if d <= s {
            break (d, add_months(m, -(k - 1) * months, eom, sys)?);
        }
        k += 1;
    };
    let e = match basis {
        1 => {
            let end = if ncd == m {
                m
            } else {
                add_months(pcd, months, false, sys)?
            };
            (end.serial - pcd.serial) as f64
        }
        3 => 365.0 / f as f64,
        _ => 360.0 / f as f64,
    };
    let a = days(pcd, s, basis);
    let dsc = match basis {
        0 => e - a,
        _ => days(s, ncd, basis),
    };
    Ok(Coupon {
        pcd,
        ncd,
        count: k,
        e,
        a,
        dsc,
    })
}

fn coupon_args(args: &[Arg], ctx: &EvalCtx) -> R<Coupon> {
    let sys = ctx.date_system;
    let s = date_arg(args, 0, sys)?;
    let m = date_arg(args, 1, sys)?;
    let f = freq_arg(args, 2)?;
    let b = basis_arg(args, 3)?;
    coupon(s, m, f, b, sys)
}

/// `COUPDAYBS(settlement, maturity, frequency, [basis])`.
pub fn coupdaybs(args: &[Arg], ctx: &EvalCtx) -> CellValue {
    out(coupon_args(args, ctx).map(|c| c.a))
}

/// `COUPDAYS(settlement, maturity, frequency, [basis])`.
pub fn coupdays(args: &[Arg], ctx: &EvalCtx) -> CellValue {
    out(coupon_args(args, ctx).map(|c| c.e))
}

/// `COUPDAYSNC(settlement, maturity, frequency, [basis])`.
pub fn coupdaysnc(args: &[Arg], ctx: &EvalCtx) -> CellValue {
    out(coupon_args(args, ctx).map(|c| c.dsc))
}

/// `COUPNCD(settlement, maturity, frequency, [basis])`.
pub fn coupncd(args: &[Arg], ctx: &EvalCtx) -> CellValue {
    out(coupon_args(args, ctx).map(|c| c.ncd.serial as f64))
}

/// `COUPNUM(settlement, maturity, frequency, [basis])`.
pub fn coupnum(args: &[Arg], ctx: &EvalCtx) -> CellValue {
    out(coupon_args(args, ctx).map(|c| c.count as f64))
}

/// `COUPPCD(settlement, maturity, frequency, [basis])`.
pub fn couppcd(args: &[Arg], ctx: &EvalCtx) -> CellValue {
    out(coupon_args(args, ctx).map(|c| c.pcd.serial as f64))
}

// ---- PRICE / YIELD / DURATION -------------------------------------------------

/// The bond price per 100 face (Microsoft's PRICE formula), with
/// `DSC = E − A`.
fn bond_price(c: &Coupon, rate: f64, yld: f64, red: f64, f: f64) -> f64 {
    let (e, a) = (c.e, c.a);
    let dsc = e - a;
    let t = 100.0 * rate / f;
    if c.count == 1 {
        return (red + t) / (1.0 + dsc / e * yld / f) - t * a / e;
    }
    let v = 1.0 + yld / f;
    let x = dsc / e;
    let nn = c.count as f64;
    let mut p = red / v.powf(nn - 1.0 + x);
    for k in 1..=c.count {
        p += t / v.powf(k as f64 - 1.0 + x);
    }
    p - t * a / e
}

struct Bond {
    c: Coupon,
    f: f64,
}

fn bond_args(args: &[Arg], ctx: &EvalCtx, f_at: usize) -> R<(Bond, [f64; 3])> {
    let sys = ctx.date_system;
    let s = date_arg(args, 0, sys)?;
    let m = date_arg(args, 1, sys)?;
    let x0 = n(args, 2)?;
    let x1 = n(args, 3)?;
    let x2 = if f_at == 5 { n(args, 4)? } else { 0.0 };
    let f = freq_arg(args, f_at)?;
    let b = basis_arg(args, f_at + 1)?;
    let c = coupon(s, m, f, b, sys)?;
    Ok((Bond { c, f: f as f64 }, [x0, x1, x2]))
}

/// `PRICE(settlement, maturity, rate, yld, redemption, frequency, [basis])`.
pub fn price(args: &[Arg], ctx: &EvalCtx) -> CellValue {
    out(bond_args(args, ctx, 5).and_then(|(b, [rate, yld, red])| {
        if rate < 0.0 || yld < 0.0 || red <= 0.0 {
            return nerr();
        }
        Ok(bond_price(&b.c, rate, yld, red, b.f))
    }))
}

/// Solve `price(y) = target` for `y` (bracket then Brent).
fn solve_yield(price_of: impl Fn(f64) -> f64, target: f64) -> R {
    let g = |y: f64| price_of(y) - target;
    // Price falls as the yield rises: bracket a sign change.
    let (mut lo, mut hi) = (0.0, 0.1);
    if g(lo) < 0.0 {
        // A negative yield: go down towards −f (price → ∞).
        hi = lo;
        lo = -0.1;
        let mut k = 0;
        while g(lo) < 0.0 {
            hi = lo;
            lo = lo * 2.0 - 0.1;
            k += 1;
            if k > 60 || lo < -0.99 {
                lo = -0.99;
                if g(lo) < 0.0 {
                    return nerr();
                }
                break;
            }
        }
    } else {
        let mut k = 0;
        while g(hi) > 0.0 {
            lo = hi;
            hi *= 2.0;
            k += 1;
            if k > 60 {
                return nerr();
            }
        }
    }
    let y = solve_bracketed(g, lo, hi);
    if y.is_finite() {
        Ok(y)
    } else {
        nerr()
    }
}

/// `YIELD(settlement, maturity, rate, pr, redemption, frequency, [basis])`.
pub fn yield_fn(args: &[Arg], ctx: &EvalCtx) -> CellValue {
    out(bond_args(args, ctx, 5).and_then(|(b, [rate, pr, red])| {
        if rate < 0.0 || pr <= 0.0 || red <= 0.0 {
            return nerr();
        }
        let c = &b.c;
        if c.count == 1 {
            let (e, a) = (c.e, c.a);
            let dsr = e - a;
            let base = pr / 100.0 + a / e * rate / b.f;
            return Ok(((red / 100.0 + rate / b.f) - base) / base * b.f * e / dsr);
        }
        solve_yield(|y| bond_price(c, rate, y, red, b.f), pr)
    }))
}

fn macaulay(c: &Coupon, coupon_rate: f64, yld: f64, f: f64) -> f64 {
    let x = (c.e - c.a) / c.e;
    let t = 100.0 * coupon_rate / f;
    let v = 1.0 + yld / f;
    let (mut num_, mut den) = (0.0, 0.0);
    for k in 1..=c.count {
        let tk = k as f64 - 1.0 + x;
        let cf = t + if k == c.count { 100.0 } else { 0.0 };
        let pv = cf / v.powf(tk);
        num_ += tk * pv;
        den += pv;
    }
    num_ / den / f
}

/// `DURATION(settlement, maturity, coupon, yld, frequency, [basis])`.
pub fn duration(args: &[Arg], ctx: &EvalCtx) -> CellValue {
    out(bond_args(args, ctx, 4).and_then(|(b, [cpn, yld, _])| {
        if cpn < 0.0 || yld < 0.0 {
            return nerr();
        }
        Ok(macaulay(&b.c, cpn, yld, b.f))
    }))
}

/// `MDURATION(settlement, maturity, coupon, yld, frequency, [basis])`.
pub fn mduration(args: &[Arg], ctx: &EvalCtx) -> CellValue {
    out(bond_args(args, ctx, 4).and_then(|(b, [cpn, yld, _])| {
        if cpn < 0.0 || yld < 0.0 {
            return nerr();
        }
        Ok(macaulay(&b.c, cpn, yld, b.f) / (1.0 + yld / b.f))
    }))
}

// ---- accrued interest ---------------------------------------------------------

/// The normal length of a quasi-coupon period on a basis.
fn period_len(p: Day, nx: Day, f: f64, basis: i64) -> f64 {
    match basis {
        1 => (nx.serial - p.serial) as f64,
        3 => 365.0 / f,
        _ => 360.0 / f,
    }
}

/// `ACCRINT(issue, first_interest, settlement, rate, par, frequency, [basis],
/// [calc_method])`: accrued from issue to settlement (Excel-recorded: the
/// calc_method gives the same result in every recorded case).
pub fn accrint(args: &[Arg], ctx: &EvalCtx) -> CellValue {
    out((|| {
        let sys = ctx.date_system;
        let issue = date_arg(args, 0, sys)?;
        let first = date_arg(args, 1, sys)?;
        let s = date_arg(args, 2, sys)?;
        let rate = n(args, 3)?;
        let par = n(args, 4)?;
        let f = freq_arg(args, 5)?;
        let b = basis_arg(args, 6)?;
        if let Some(a) = args.get(7) {
            if let Some(v) = scalar(Some(a)) {
                if !matches!(v, CellValue::Empty) {
                    coerce::to_bool(&v)?;
                }
            }
        }
        if rate <= 0.0 || par <= 0.0 || issue >= s {
            return nerr();
        }
        let ff = f as f64;
        if b != 1 {
            // A straight day count over the year basis.
            let yb = if b == 3 { 365.0 } else { 360.0 };
            return Ok(par * rate * days(issue, s, b) / yb);
        }
        let months = 12 / f;
        let eom = is_month_end(first);
        let mut k = 0i64;
        while add_months(first, -k * months, eom, sys)? > issue {
            k += 1;
        }
        let mut total = 0.0;
        loop {
            let p = add_months(first, -k * months, eom, sys)?;
            let nx = add_months(first, -(k - 1) * months, eom, sys)?;
            let a = p.max(issue);
            let e = nx.min(s);
            if e > a {
                total += days(a, e, b) / period_len(p, nx, ff, b);
            }
            if nx >= s {
                break;
            }
            k -= 1;
        }
        Ok(par * rate / ff * total)
    })())
}

/// `ACCRINTM(issue, settlement, rate, par, [basis])`.
pub fn accrintm(args: &[Arg], ctx: &EvalCtx) -> CellValue {
    out((|| {
        let sys = ctx.date_system;
        let issue = date_arg(args, 0, sys)?;
        let s = date_arg(args, 1, sys)?;
        let rate = n(args, 2)?;
        let par = n(args, 3)?;
        let b = basis_arg(args, 4)?;
        if rate <= 0.0 || par <= 0.0 || issue > s {
            return nerr();
        }
        Ok(par * rate * yearfrac(issue, s, b, sys)?)
    })())
}

// ---- discount securities ------------------------------------------------------

fn disc_args(args: &[Arg], ctx: &EvalCtx) -> R<(f64, f64, f64)> {
    let sys = ctx.date_system;
    let s = date_arg(args, 0, sys)?;
    let m = date_arg(args, 1, sys)?;
    let x = n(args, 2)?;
    let y = n(args, 3)?;
    let b = basis_arg(args, 4)?;
    if s >= m || x <= 0.0 || y <= 0.0 {
        return nerr();
    }
    Ok((x, y, yearfrac(s, m, b, sys)?))
}

/// `DISC(settlement, maturity, pr, redemption, [basis])`.
pub fn disc(args: &[Arg], ctx: &EvalCtx) -> CellValue {
    out(disc_args(args, ctx).map(|(pr, red, t)| (red - pr) / red / t))
}

/// `INTRATE(settlement, maturity, investment, redemption, [basis])`.
pub fn intrate(args: &[Arg], ctx: &EvalCtx) -> CellValue {
    out(disc_args(args, ctx).map(|(inv, red, t)| (red - inv) / inv / t))
}

/// `RECEIVED(settlement, maturity, investment, discount, [basis])`.
pub fn received(args: &[Arg], ctx: &EvalCtx) -> CellValue {
    out(disc_args(args, ctx).and_then(|(inv, d, t)| {
        let v = 1.0 - d * t;
        if v <= 0.0 {
            return nerr();
        }
        Ok(inv / v)
    }))
}

/// `PRICEDISC(settlement, maturity, discount, redemption, [basis])`.
pub fn pricedisc(args: &[Arg], ctx: &EvalCtx) -> CellValue {
    out(disc_args(args, ctx).map(|(d, red, t)| red * (1.0 - d * t)))
}

/// `YIELDDISC(settlement, maturity, pr, redemption, [basis])`.
pub fn yielddisc(args: &[Arg], ctx: &EvalCtx) -> CellValue {
    out(disc_args(args, ctx).map(|(pr, red, t)| (red - pr) / pr / t))
}

/// The year fractions `(issue→maturity, settlement→maturity,
/// issue→settlement)` of PRICEMAT/YIELDMAT: 30/360 without the February
/// rule on basis 0, and on basis 1 the year length of issue→settlement.
fn mat_fracs(args: &[Arg], ctx: &EvalCtx) -> R<(f64, f64, f64, f64, f64)> {
    let sys = ctx.date_system;
    let s = date_arg(args, 0, sys)?;
    let m = date_arg(args, 1, sys)?;
    let i = date_arg(args, 2, sys)?;
    let rate = n(args, 3)?;
    let x = n(args, 4)?;
    let b = basis_arg(args, 5)?;
    if s >= m || i >= s || rate < 0.0 {
        return nerr();
    }
    let frac = |a: Day, c: Day| -> R {
        Ok(match b {
            0 => d360(a, c, D360::Plain) as f64 / 360.0,
            1 => {
                let yl = (s.serial - i.serial) as f64 / yearfrac(i, s, 1, sys)?;
                (c.serial - a.serial) as f64 / yl
            }
            _ => yearfrac(a, c, b, sys)?,
        })
    };
    Ok((frac(i, m)?, frac(s, m)?, frac(i, s)?, rate, x))
}

/// `PRICEMAT(settlement, maturity, issue, rate, yld, [basis])`.
pub fn pricemat(args: &[Arg], ctx: &EvalCtx) -> CellValue {
    out(mat_fracs(args, ctx).and_then(|(dim_, dsm, a, rate, yld)| {
        if yld < 0.0 {
            return nerr();
        }
        Ok((100.0 + dim_ * rate * 100.0) / (1.0 + dsm * yld) - a * rate * 100.0)
    }))
}

/// `YIELDMAT(settlement, maturity, issue, rate, pr, [basis])`.
pub fn yieldmat(args: &[Arg], ctx: &EvalCtx) -> CellValue {
    out(mat_fracs(args, ctx).and_then(|(dim_, dsm, a, rate, pr)| {
        if pr <= 0.0 {
            return nerr();
        }
        let base = pr / 100.0 + a * rate;
        Ok(((1.0 + dim_ * rate) - base) / base / dsm)
    }))
}

fn tbill_args(args: &[Arg], ctx: &EvalCtx) -> R<(f64, f64)> {
    let sys = ctx.date_system;
    let s = date_arg(args, 0, sys)?;
    let m = date_arg(args, 1, sys)?;
    let x = n(args, 2)?;
    let dsm = (m.serial - s.serial) as f64;
    if dsm <= 0.0 || dsm > 365.0 || x <= 0.0 {
        return nerr();
    }
    Ok((dsm, x))
}

/// `TBILLPRICE(settlement, maturity, discount)`.
pub fn tbillprice(args: &[Arg], ctx: &EvalCtx) -> CellValue {
    out(tbill_args(args, ctx).and_then(|(dsm, d)| {
        let p = 100.0 * (1.0 - d * dsm / 360.0);
        if p <= 0.0 {
            return nerr();
        }
        Ok(p)
    }))
}

/// `TBILLYIELD(settlement, maturity, pr)`.
pub fn tbillyield(args: &[Arg], ctx: &EvalCtx) -> CellValue {
    out(tbill_args(args, ctx).map(|(dsm, pr)| (100.0 - pr) / pr * 360.0 / dsm))
}

/// `TBILLEQ(settlement, maturity, discount)`.
pub fn tbilleq(args: &[Arg], ctx: &EvalCtx) -> CellValue {
    out(tbill_args(args, ctx).and_then(|(dsm, d)| {
        if dsm <= 182.0 {
            return Ok(365.0 * d / (360.0 - d * dsm));
        }
        let p = 100.0 * (1.0 - d * dsm / 360.0);
        if p <= 0.0 {
            return nerr();
        }
        let x = dsm / 365.0;
        Ok((-x + (x * x - (2.0 * x - 1.0) * (1.0 - 100.0 / p)).sqrt()) / (x - 0.5))
    }))
}

// ---- odd periods --------------------------------------------------------------

struct OddFirst {
    /// Σ DC_i/NL_i over issue→first coupon (the first coupon's fraction).
    dc: f64,
    /// Σ A_i/NL_i over issue→settlement.
    acc: f64,
    /// DSC/NL of the quasi period holding settlement.
    x: f64,
    /// Whole quasi periods between that period's end and the first coupon.
    nq: f64,
    /// Regular coupons after the first one.
    count: i64,
}

fn odd_first(s: Day, m: Day, issue: Day, fc: Day, f: i64, b: i64, sys: DateSystem) -> R<OddFirst> {
    if !(issue < s && s < fc && fc < m) {
        return nerr();
    }
    let months = 12 / f;
    let ff = f as f64;
    let eom = is_month_end(fc);
    let q = |k: i64| add_months(fc, -k * months, eom, sys);
    // The first coupon must lie on maturity's schedule.
    let mut count = 0i64;
    loop {
        let d = q(-(count + 1))?;
        if d > m {
            return nerr();
        }
        count += 1;
        if d == m {
            break;
        }
    }
    let (mut dc, mut acc) = (0.0, 0.0);
    let mut k = 0;
    loop {
        let p = q(k + 1)?;
        let nx = q(k)?;
        let nl = period_len(p, nx, ff, b);
        let a = p.max(issue);
        dc += days(a, nx, b) / nl;
        let e = nx.min(s);
        if e > a {
            acc += days(a, e, b) / nl;
        }
        if p <= issue {
            break;
        }
        k += 1;
    }
    let mut k = 0;
    while q(k)? > s {
        k += 1;
    }
    let p = q(k)?;
    let nx = q(k - 1)?;
    let x = days(s, nx, b) / period_len(p, nx, ff, b);
    Ok(OddFirst {
        dc,
        acc,
        x,
        nq: (k - 1) as f64,
        count,
    })
}

fn odd_first_price(o: &OddFirst, rate: f64, yld: f64, red: f64, f: f64) -> f64 {
    let t = 100.0 * rate / f;
    let v = 1.0 + yld / f;
    let base = o.x + o.nq;
    let mut p = red / v.powf(base + o.count as f64);
    p += t * o.dc / v.powf(base);
    for j in 1..=o.count {
        p += t / v.powf(base + j as f64);
    }
    p - t * o.acc
}

fn odd_first_args(args: &[Arg], ctx: &EvalCtx) -> R<(OddFirst, f64, f64, f64, f64)> {
    let sys = ctx.date_system;
    let s = date_arg(args, 0, sys)?;
    let m = date_arg(args, 1, sys)?;
    let issue = date_arg(args, 2, sys)?;
    let fc = date_arg(args, 3, sys)?;
    let rate = n(args, 4)?;
    let x = n(args, 5)?;
    let red = n(args, 6)?;
    let f = freq_arg(args, 7)?;
    let b = basis_arg(args, 8)?;
    if rate < 0.0 || red <= 0.0 {
        return nerr();
    }
    Ok((
        odd_first(s, m, issue, fc, f, b, sys)?,
        rate,
        x,
        red,
        f as f64,
    ))
}

/// `ODDFPRICE(settlement, maturity, issue, first_coupon, rate, yld,
/// redemption, frequency, [basis])`.
pub fn oddfprice(args: &[Arg], ctx: &EvalCtx) -> CellValue {
    out(
        odd_first_args(args, ctx).and_then(|(o, rate, yld, red, f)| {
            if yld < 0.0 {
                return nerr();
            }
            Ok(odd_first_price(&o, rate, yld, red, f))
        }),
    )
}

/// `ODDFYIELD(settlement, maturity, issue, first_coupon, rate, pr,
/// redemption, frequency, [basis])`.
pub fn oddfyield(args: &[Arg], ctx: &EvalCtx) -> CellValue {
    out(odd_first_args(args, ctx).and_then(|(o, rate, pr, red, f)| {
        if pr <= 0.0 {
            return nerr();
        }
        solve_yield(|y| odd_first_price(&o, rate, y, red, f), pr)
    }))
}

/// `(Σ DC/NL, Σ A/NL, Σ DSC/NL)` over the quasi periods from the last
/// coupon to maturity (actual days and lengths on bases 1–3).
fn odd_last(s: Day, m: Day, last: Day, f: i64, b: i64, sys: DateSystem) -> R<(f64, f64, f64)> {
    if !(last < s && s < m) {
        return nerr();
    }
    let months = 12 / f;
    let eom = is_month_end(last);
    let (mut dc, mut acc, mut dsc) = (0.0, 0.0, 0.0);
    let mut j = 0;
    loop {
        let p = add_months(last, j * months, eom, sys)?;
        let nx = add_months(last, (j + 1) * months, eom, sys)?;
        let nl = match b {
            1..=3 => (nx.serial - p.serial) as f64,
            _ => 360.0 / f as f64,
        };
        let e = nx.min(m);
        dc += days(p, e, b) / nl;
        if s > p {
            acc += days(p, s.min(e), b) / nl;
        }
        if e > s {
            let a = s.max(p);
            let d = if b == 0 {
                d360(a, e, D360::EndAll) as f64
            } else {
                days(a, e, b)
            };
            dsc += d / nl;
        }
        if nx >= m {
            break;
        }
        j += 1;
    }
    Ok((dc, acc, dsc))
}

/// `((Σ DC/NL, Σ A/NL, Σ DSC/NL), rate, yld or pr, redemption, frequency)`.
type OddLast = ((f64, f64, f64), f64, f64, f64, f64);

fn odd_last_args(args: &[Arg], ctx: &EvalCtx) -> R<OddLast> {
    let sys = ctx.date_system;
    let s = date_arg(args, 0, sys)?;
    let m = date_arg(args, 1, sys)?;
    let last = date_arg(args, 2, sys)?;
    let rate = n(args, 3)?;
    let x = n(args, 4)?;
    let red = n(args, 5)?;
    let f = freq_arg(args, 6)?;
    let b = basis_arg(args, 7)?;
    if rate < 0.0 || red <= 0.0 {
        return nerr();
    }
    Ok((odd_last(s, m, last, f, b, sys)?, rate, x, red, f as f64))
}

/// `ODDLPRICE(settlement, maturity, last_interest, rate, yld, redemption,
/// frequency, [basis])`.
pub fn oddlprice(args: &[Arg], ctx: &EvalCtx) -> CellValue {
    out(
        odd_last_args(args, ctx).and_then(|((dc, acc, dsc), rate, yld, red, f)| {
            if yld < 0.0 {
                return nerr();
            }
            let t = 100.0 * rate / f;
            Ok((red + dc * t) / (1.0 + dsc * yld / f) - acc * t)
        }),
    )
}

/// `ODDLYIELD(settlement, maturity, last_interest, rate, pr, redemption,
/// frequency, [basis])`.
pub fn oddlyield(args: &[Arg], ctx: &EvalCtx) -> CellValue {
    out(
        odd_last_args(args, ctx).and_then(|((dc, acc, dsc), rate, pr, red, f)| {
            if pr <= 0.0 {
                return nerr();
            }
            let t = 100.0 * rate / f;
            let base = pr + acc * t;
            Ok(((red + dc * t) - base) / base * f / dsc)
        }),
    )
}

// ---- French depreciation ------------------------------------------------------

fn amor_args(args: &[Arg], ctx: &EvalCtx) -> R<(f64, f64, f64, f64, f64)> {
    let sys = ctx.date_system;
    let cost = n(args, 0)?;
    let dp = date_arg(args, 1, sys)?;
    let fp = date_arg(args, 2, sys)?;
    let salvage = n(args, 3)?;
    let per = n(args, 4)?.trunc();
    let rate = n(args, 5)?;
    let b = basis_arg(args, 6)?;
    if cost < 0.0
        || salvage < 0.0
        || salvage > cost
        || per < 0.0
        || rate <= 0.0
        || b == 2
        || dp > fp
    {
        return nerr();
    }
    Ok((cost, salvage, per, rate, yearfrac(dp, fp, b, sys)?))
}

/// Round half away from zero to an integer.
fn round0(x: f64) -> f64 {
    x.signum() * (x.abs() + 0.5).floor()
}

/// `AMORDEGRC(cost, date_purchased, first_period, salvage, period, rate,
/// [basis])`: degressive, the rate times 1.5 (life up to 4 years), 2 (up to
/// 6) or 2.5, each period rounded; the last two periods of the life share the
/// remaining value equally (nothing once it is below salvage).
pub fn amordegrc(args: &[Arg], ctx: &EvalCtx) -> CellValue {
    out(
        amor_args(args, ctx).and_then(|(cost, salvage, per, rate, yf)| {
            let life = 1.0 / rate;
            if life < 2.0 {
                return nerr();
            }
            let coef = if life <= 4.0 {
                1.5
            } else if life <= 6.0 {
                2.0
            } else {
                2.5
            };
            let r = rate * coef;
            let nlife = life.ceil() as i64;
            let first = round0(yf * r * cost);
            if per == 0.0 {
                return Ok(first);
            }
            let mut c = cost - first;
            let mut half: Option<f64> = None;
            let mut d = 0.0;
            for k in 1..=(per as i64) {
                d = if k >= nlife {
                    0.0
                } else if k == nlife - 2 {
                    let h = round0(c * 0.5);
                    half = Some(h);
                    h
                } else if k == nlife - 1 {
                    let h = *half.get_or_insert(round0(c * 0.5));
                    if c >= salvage {
                        h
                    } else {
                        0.0
                    }
                } else {
                    round0(r * c)
                };
                c -= d;
            }
            Ok(d)
        }),
    )
}

/// `AMORLINC(cost, date_purchased, first_period, salvage, period, rate,
/// [basis])`: linear, the first period prorated by the year fraction.
pub fn amorlinc(args: &[Arg], ctx: &EvalCtx) -> CellValue {
    out(amor_args(args, ctx).map(|(cost, salvage, per, rate, yf)| {
        let one = cost * rate;
        let first = yf * rate * cost;
        let full = ((cost - salvage - first) / one).trunc();
        if per == 0.0 {
            first
        } else if per <= full {
            one
        } else if per == full + 1.0 {
            cost - salvage - one * full - first
        } else {
            0.0
        }
    }))
}

// ---- VDB ----------------------------------------------------------------------

/// Declining balance from `t0` to `t1` (unit steps from `t0`), switching to
/// straight line when that is larger; returns `(depreciation, book value)`.
fn vdb_run(
    mut book: f64,
    salvage: f64,
    life: f64,
    t0: f64,
    t1: f64,
    factor: f64,
    no_switch: bool,
) -> (f64, f64) {
    let mut total = 0.0;
    let mut t = t0;
    let mut switched = false;
    while t < t1 - 1e-12 {
        let rem = life - t;
        let raw = book * factor / life;
        let sl = if rem > 0.0 {
            (book - salvage) / rem
        } else {
            0.0
        };
        let d = if !no_switch && (switched || sl > raw) {
            switched = true;
            sl
        } else {
            raw.min(book - salvage)
        };
        let step = (t1 - t).min(1.0);
        total += d * step;
        book -= d * step;
        t += step;
    }
    (total, book)
}

/// `VDB(cost, salvage, life, start_period, end_period, [factor],
/// [no_switch])`.
pub fn vdb(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    out((|| {
        let cost = n(args, 0)?;
        let salvage = n(args, 1)?;
        let life = n(args, 2)?;
        let start = n(args, 3)?;
        let end = n(args, 4)?;
        let factor = opt(args, 5, 2.0)?;
        let no_switch = match args.get(6) {
            None | Some(Arg::Scalar(CellValue::Empty)) => false,
            Some(a) => coerce::to_bool(&scalar(Some(a)).unwrap_or(CellValue::Empty))?,
        };
        if cost < 0.0
            || salvage < 0.0
            || life <= 0.0
            || start < 0.0
            || end < start
            || end > life
            || factor < 0.0
        {
            return nerr();
        }
        if no_switch {
            // Whole-period declining balance, prorated at fractional ends.
            let mut book = cost;
            let mut total = 0.0;
            let mut k = 0.0;
            while k < end.ceil() {
                let d = (book * factor / life).min(book - salvage);
                let a = start.max(k);
                let b = end.min(k + 1.0);
                if b > a {
                    total += d * (b - a);
                }
                book -= d;
                k += 1.0;
            }
            return Ok(total);
        }
        let (_, book) = vdb_run(cost, salvage, life, 0.0, start, factor, false);
        Ok(vdb_run(book, salvage, life, start, end, factor, false).0)
    })())
}

// ---- cumulative interest and principal ----------------------------------------

fn annuity_payment(r: f64, nper: f64, pv: f64, t: f64) -> f64 {
    let g = (1.0 + r).powf(nper);
    -pv * g * r / ((1.0 + r * t) * (g - 1.0))
}

fn fv_at(r: f64, k: f64, pmt: f64, pv: f64, t: f64) -> f64 {
    let g = (1.0 + r).powf(k);
    -(pv * g + pmt * (1.0 + r * t) * (g - 1.0) / r)
}

fn interest_at(r: f64, per: f64, pv: f64, t: f64, pmt: f64) -> f64 {
    if per == 1.0 && t == 1.0 {
        0.0
    } else if t == 1.0 {
        (fv_at(r, per - 2.0, pmt, pv, 1.0) - pmt) * r
    } else {
        fv_at(r, per - 1.0, pmt, pv, 0.0) * r
    }
}

fn cumulative(args: &[Arg], principal: bool) -> R {
    let r = n(args, 0)?;
    let nper = n(args, 1)?;
    let pv = n(args, 2)?;
    let start = n(args, 3)?;
    let end = n(args, 4)?;
    let t = n(args, 5)?;
    if r <= 0.0
        || nper <= 0.0
        || pv <= 0.0
        || start < 1.0
        || end < start
        || end > nper
        || (t != 0.0 && t != 1.0)
    {
        return nerr();
    }
    let pmt = annuity_payment(r, nper, pv, t);
    let (s, e) = (start.ceil() as i64, end.trunc() as i64);
    let mut total = 0.0;
    for per in s..=e {
        let i = interest_at(r, per as f64, pv, t, pmt);
        total += if principal { pmt - i } else { i };
    }
    Ok(total)
}

/// `CUMIPMT(rate, nper, pv, start_period, end_period, type)`.
pub fn cumipmt(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    out(cumulative(args, false))
}

/// `CUMPRINC(rate, nper, pv, start_period, end_period, type)`.
pub fn cumprinc(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    out(cumulative(args, true))
}

// ---- simple closed forms ------------------------------------------------------

/// `EFFECT(nominal_rate, npery)`.
pub fn effect(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    out((|| {
        let r = n(args, 0)?;
        let p = n(args, 1)?.trunc();
        if r <= 0.0 || p < 1.0 {
            return nerr();
        }
        Ok((1.0 + r / p).powf(p) - 1.0)
    })())
}

/// `NOMINAL(effect_rate, npery)`.
pub fn nominal(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    out((|| {
        let r = n(args, 0)?;
        let p = n(args, 1)?.trunc();
        if r <= 0.0 || p < 1.0 {
            return nerr();
        }
        Ok(((1.0 + r).powf(1.0 / p) - 1.0) * p)
    })())
}

/// `ISPMT(rate, per, nper, pv)`.
pub fn ispmt(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    out((|| {
        let r = n(args, 0)?;
        let per = n(args, 1)?;
        let nper = n(args, 2)?;
        let pv = n(args, 3)?;
        if nper == 0.0 {
            return Err(CellError::Div0);
        }
        Ok(pv * r * (per / nper - 1.0))
    })())
}

/// `PDURATION(rate, pv, fv)`.
pub fn pduration(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    out((|| {
        let r = n(args, 0)?;
        let pv = n(args, 1)?;
        let fv = n(args, 2)?;
        if r <= 0.0 || pv <= 0.0 || fv <= 0.0 {
            return nerr();
        }
        // Excel-recorded: ln(1 + rate) as written.
        Ok((fv.ln() - pv.ln()) / (1.0 + r).ln())
    })())
}

/// `RRI(nper, pv, fv)`.
pub fn rri(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    out((|| {
        let nper = n(args, 0)?;
        let pv = n(args, 1)?;
        let fv = n(args, 2)?;
        if nper <= 0.0 || pv == 0.0 {
            return nerr();
        }
        let q = fv / pv;
        if q < 0.0 {
            return nerr();
        }
        Ok(q.powf(1.0 / nper) - 1.0)
    })())
}

/// `FVSCHEDULE(principal, schedule)`: blanks count as 0; text in a
/// reference is `#VALUE!`.
pub fn fvschedule(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    out((|| {
        let mut p = n(args, 0)?;
        let rates: Vec<CellValue> = match &args[1] {
            Arg::Scalar(v) => vec![CellValue::Number(coerce::to_number(v)?)],
            a => flat(a),
        };
        for v in rates {
            match v {
                CellValue::Number(r) => p *= 1.0 + r,
                CellValue::Empty => {}
                CellValue::Error(e) => return Err(e),
                _ => return Err(CellError::Value),
            }
        }
        Ok(p)
    })())
}

fn fraction_arg(args: &[Arg]) -> R {
    let f = n(args, 1)?;
    if f < 0.0 {
        return nerr();
    }
    let f = f.trunc();
    if f == 0.0 {
        return Err(CellError::Div0);
    }
    Ok(f)
}

/// The power of ten at or above the fraction's denominator (Excel: 16 → 2
/// digits, 100 → 2, 1 → 0).
fn digits_of(f: f64) -> i32 {
    f.log10().ceil() as i32
}

/// `DOLLARDE(fractional_dollar, fraction)`.
pub fn dollarde(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    out((|| {
        let x = n(args, 0)?;
        let f = fraction_arg(args)?;
        let ip = x.trunc();
        let frac = x - ip;
        let scale = 10f64.powi(digits_of(f));
        Ok(ip + frac * scale / f)
    })())
}

/// `DOLLARFR(decimal_dollar, fraction)`.
pub fn dollarfr(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    out((|| {
        let x = n(args, 0)?;
        let f = fraction_arg(args)?;
        let ip = x.trunc();
        let frac = x - ip;
        let scale = 10f64.powi(digits_of(f));
        Ok(ip + frac * f / scale)
    })())
}
