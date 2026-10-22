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

//! W3 engineering kernels: radix conversion, bitwise operations, the
//! Kronecker/step functions, the error function and the Bessel functions.
//! (`CONVERT` lives in [`super::units`], the complex numbers in
//! [`super::complex`].) Every behaviour below is Excel-recorded
//! (`corpus/fn-corpus/eng`, `oracle/excel/recorded/eng.tsv`).
//!
//! ## Rulings
//!
//! - **Radix conversion** (`BIN2DEC` … `OCT2HEX`, Microsoft reference): the
//!   input is at most 10 digits of its radix; ten digits whose top bit is set
//!   are a negative two's-complement number (40 bits hex, 30 bits octal, 10
//!   bits binary). A number argument is read through its General text
//!   (`BIN2DEC(1100100)`); a blank or `""` is 0; a logical is `#VALUE!`.
//!   Negative results are written as ten digits and ignore `places`;
//!   `places` truncates, must be 1..=10 and at least the digit count (else
//!   `#NUM!`), a non-numeric `places` is `#VALUE!`.
//! - **BITAND/BITOR/BITXOR** take integers in `0 ..= 2^48 − 1` (else
//!   `#NUM!`); logicals count as 0/1 (these are not Analysis ToolPak
//!   functions). **BITLSHIFT/BITRSHIFT** truncate the shift, `|shift| > 53`
//!   is `#NUM!` (unless the number is 0), a left shift by 49 to 53 bits is
//!   `0` (Excel-recorded: `BITLSHIFT(1,49)` is 0 while `BITLSHIFT(1,48)` is
//!   `#NUM!`), any other result above `2^48 − 1` is `#NUM!`.
//! - **DELTA, GESTEP, ERF, ERFC, ERF.PRECISE, ERFC.PRECISE, BESSEL\*** follow
//!   the Analysis ToolPak number rule: a logical is `#VALUE!`. `ERF` with a
//!   blank upper limit integrates to 0; `ERFC` underflow below the smallest
//!   normal double is 0.
//! - **BESSELI/J/K/Y** truncate the order; a negative order is `#NUM!`; `K`
//!   and `Y` need `x > 0`. The values are the classic approximations Excel
//!   uses (see [`crate::special`]).

use sheet_core::{CellError, CellValue};

use super::util::{atp_num, atp_num_or, finite, num, scalar};
use crate::arg::Arg;
use crate::coerce;
use crate::ctx::EvalCtx;
use crate::special;

fn err(e: CellError) -> CellValue {
    CellValue::Error(e)
}

macro_rules! tri {
    ($e:expr) => {
        match $e {
            Ok(v) => v,
            Err(e) => return CellValue::Error(e),
        }
    };
}

// ---- radix conversion ------------------------------------------------------------

#[derive(Copy, Clone)]
struct Radix {
    base: u32,
    /// Bits a ten-digit two's-complement number spans (10 / 30 / 40).
    bits: u32,
}

const BIN: Radix = Radix { base: 2, bits: 10 };
const OCT: Radix = Radix { base: 8, bits: 30 };
const HEX: Radix = Radix { base: 16, bits: 40 };
/// Decimal: the value range is the target's, so `bits` is unused.
const DEC: Radix = Radix { base: 10, bits: 0 };

/// The source digits of a radix-conversion argument.
fn source_text(arg: Option<&Arg>) -> Result<String, CellError> {
    match scalar(arg) {
        None | Some(CellValue::Empty) => Ok(String::new()),
        Some(CellValue::Bool(_)) => Err(CellError::Value),
        Some(CellValue::Error(e)) => Err(e),
        Some(v) => Ok(coerce::to_text(&v).to_string()),
    }
}

/// Parse up to ten digits of `r` into a signed value.
fn parse_radix(s: &str, r: Radix) -> Result<i64, CellError> {
    if s.is_empty() {
        return Ok(0);
    }
    if s.len() > 10 {
        return Err(CellError::Num);
    }
    let mut v: i64 = 0;
    for ch in s.chars() {
        let d = ch.to_digit(r.base).ok_or(CellError::Num)?;
        v = v * i64::from(r.base) + i64::from(d);
    }
    if s.len() == 10 && v >= 1 << (r.bits - 1) {
        v -= 1 << r.bits;
    }
    Ok(v)
}

/// The optional `places` argument: `None` when absent.
fn places_arg(arg: Option<&Arg>) -> Result<Option<usize>, CellError> {
    match arg {
        None => Ok(None),
        Some(a) => {
            let v = scalar(Some(a)).unwrap_or(CellValue::Empty);
            let p = match v {
                CellValue::Bool(_) => return Err(CellError::Value),
                other => coerce::to_number(&other)?,
            }
            .trunc();
            if !(1.0..=10.0).contains(&p) {
                return Err(CellError::Num);
            }
            Ok(Some(p as usize))
        }
    }
}

/// Render `v` in radix `r` (ten-digit two's complement when negative),
/// padded to `places`; out of the radix's range is `#NUM!`.
fn render_radix(v: i64, r: Radix, places: Option<usize>) -> CellValue {
    let lo = -(1i64 << (r.bits - 1));
    let hi = (1i64 << (r.bits - 1)) - 1;
    if v < lo || v > hi {
        return err(CellError::Num);
    }
    let u = if v < 0 { v + (1i64 << r.bits) } else { v } as u64;
    let mut digits = match r.base {
        2 => format!("{u:b}"),
        8 => format!("{u:o}"),
        _ => format!("{u:X}"),
    };
    if v >= 0 {
        if let Some(p) = places {
            if p < digits.len() {
                return err(CellError::Num);
            }
            digits = format!("{digits:0>p$}");
        }
    }
    CellValue::Text(digits.into())
}

fn convert_radix(args: &[Arg], from: Radix, to: Radix) -> CellValue {
    let value: i64 = if from.base == 10 {
        let x = tri!(atp_num(args.first()));
        if !x.is_finite() || x.abs() > 1e15 {
            return err(CellError::Num);
        }
        x.trunc() as i64
    } else {
        let s = tri!(source_text(args.first()));
        tri!(parse_radix(&s, from))
    };
    if to.base == 10 {
        return CellValue::Number(value as f64);
    }
    let places = tri!(places_arg(args.get(1)));
    render_radix(value, to, places)
}

macro_rules! radix_fn {
    ($(#[$m:meta])* $name:ident, $from:expr, $to:expr) => {
        $(#[$m])*
        pub fn $name(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
            convert_radix(args, $from, $to)
        }
    };
}

radix_fn!(/// `BIN2DEC(number)`.
    bin2dec, BIN, DEC);
radix_fn!(/// `BIN2HEX(number, [places])`.
    bin2hex, BIN, HEX);
radix_fn!(/// `BIN2OCT(number, [places])`.
    bin2oct, BIN, OCT);
radix_fn!(/// `DEC2BIN(number, [places])`.
    dec2bin, DEC, BIN);
radix_fn!(/// `DEC2HEX(number, [places])`.
    dec2hex, DEC, HEX);
radix_fn!(/// `DEC2OCT(number, [places])`.
    dec2oct, DEC, OCT);
radix_fn!(/// `HEX2BIN(number, [places])`.
    hex2bin, HEX, BIN);
radix_fn!(/// `HEX2DEC(number)`.
    hex2dec, HEX, DEC);
radix_fn!(/// `HEX2OCT(number, [places])`.
    hex2oct, HEX, OCT);
radix_fn!(/// `OCT2BIN(number, [places])`.
    oct2bin, OCT, BIN);
radix_fn!(/// `OCT2DEC(number)`.
    oct2dec, OCT, DEC);
radix_fn!(/// `OCT2HEX(number, [places])`.
    oct2hex, OCT, HEX);

// ---- bitwise -------------------------------------------------------------------

const BIT_MAX: u64 = (1 << 48) - 1;

fn bit_operand(arg: Option<&Arg>) -> Result<u64, CellError> {
    let x = num(arg)?;
    if x < 0.0 || x.fract() != 0.0 || x > BIT_MAX as f64 {
        return Err(CellError::Num);
    }
    Ok(x as u64)
}

fn bit_binary(args: &[Arg], f: impl Fn(u64, u64) -> u64) -> CellValue {
    let a = tri!(bit_operand(args.first()));
    let b = tri!(bit_operand(args.get(1)));
    CellValue::Number(f(a, b) as f64)
}

/// `BITAND(number1, number2)`.
pub fn bitand(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    bit_binary(args, |a, b| a & b)
}

/// `BITOR(number1, number2)`.
pub fn bitor(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    bit_binary(args, |a, b| a | b)
}

/// `BITXOR(number1, number2)`.
pub fn bitxor(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    bit_binary(args, |a, b| a ^ b)
}

/// Shift `n` left by `s` bits (right when negative) under Excel's rules.
fn shift(n: u64, s: f64) -> CellValue {
    let s = s.trunc();
    if n == 0 {
        return CellValue::Number(0.0);
    }
    if s.abs() > 53.0 {
        return err(CellError::Num);
    }
    let s = s as i32;
    let out = if s >= 49 {
        0
    } else if s >= 0 {
        n << s
    } else {
        n >> (-s)
    };
    if out > BIT_MAX {
        return err(CellError::Num);
    }
    CellValue::Number(out as f64)
}

/// `BITLSHIFT(number, shift_amount)`.
pub fn bitlshift(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    let n = tri!(bit_operand(args.first()));
    let s = tri!(num(args.get(1)));
    shift(n, s)
}

/// `BITRSHIFT(number, shift_amount)`.
pub fn bitrshift(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    let n = tri!(bit_operand(args.first()));
    let s = tri!(num(args.get(1)));
    shift(n, -s)
}

// ---- Kronecker delta, step -------------------------------------------------------

/// `DELTA(number1, [number2=0])`.
pub fn delta(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    let a = tri!(atp_num(args.first()));
    let b = tri!(atp_num_or(args.get(1), 0.0));
    CellValue::Number(if a == b { 1.0 } else { 0.0 })
}

/// `GESTEP(number, [step=0])`.
pub fn gestep(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    let a = tri!(atp_num(args.first()));
    let b = tri!(atp_num_or(args.get(1), 0.0));
    CellValue::Number(if a >= b { 1.0 } else { 0.0 })
}

// ---- error function --------------------------------------------------------------

fn flush(x: f64) -> f64 {
    if x.abs() < f64::MIN_POSITIVE {
        0.0
    } else {
        x
    }
}

/// `ERF(lower_limit, [upper_limit])`.
pub fn erf(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    let lo = tri!(atp_num(args.first()));
    match args.get(1) {
        None => finite(special::erf(lo)),
        Some(a) => {
            let hi = tri!(atp_num(Some(a)));
            finite(special::erf(hi) - special::erf(lo))
        }
    }
}

/// `ERF.PRECISE(x)`.
pub fn erf_precise(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    let x = tri!(atp_num(args.first()));
    finite(special::erf(x))
}

/// `ERFC(x)` and `ERFC.PRECISE(x)`.
pub fn erfc(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    let x = tri!(atp_num(args.first()));
    finite(flush(special::erfc(x)))
}

// ---- Bessel ------------------------------------------------------------------------

/// `(x, n)` for a Bessel call: the order truncates, a negative one is
/// `#NUM!`.
fn bessel_args(args: &[Arg]) -> Result<(f64, u32), CellError> {
    let x = atp_num(args.first())?;
    let n = atp_num(args.get(1))?.trunc();
    if n < 0.0 {
        return Err(CellError::Num);
    }
    if n > 1e6 {
        return Err(CellError::Num);
    }
    Ok((x, n as u32))
}

/// `BESSELI(x, n)`.
pub fn besseli(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    let (x, n) = tri!(bessel_args(args));
    finite(special::bessel_in(n, x))
}

/// `BESSELJ(x, n)`.
pub fn besselj(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    let (x, n) = tri!(bessel_args(args));
    finite(special::bessel_jn(n, x))
}

/// `BESSELK(x, n)`, `x > 0`.
pub fn besselk(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    let (x, n) = tri!(bessel_args(args));
    if x <= 0.0 {
        return err(CellError::Num);
    }
    finite(special::bessel_kn(n, x))
}

/// `BESSELY(x, n)`, `x > 0`.
pub fn bessely(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    let (x, n) = tri!(bessel_args(args));
    if x <= 0.0 {
        return err(CellError::Num);
    }
    finite(special::bessel_yn(n, x))
}
