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

//! The complex-number functions (`COMPLEX`, `IM*`) over a small own
//! [`Complex`] type that reads and writes Excel's text form.
//!
//! ## The text form (Excel-recorded, `corpus/fn-corpus/eng/im*.golden.tsv`)
//!
//! - **Reading.** `[±]real[(±)[imag](i|j)]` or `[±][imag](i|j)`; a coefficient
//!   is a decimal with optional exponent (`3.`, `.5`, `1e+2`); a bare `i` is a
//!   unit coefficient. Spaces are ignored. A plain number argument is a real
//!   value; a logical or anything else is `#NUM!` (`#VALUE!` for a logical).
//! - **Writing.** Each part with 15 significant digits, in fixed notation
//!   while that takes at most 21 characters and in `d.dddE±XX` form beyond
//!   (`100000000000000000000`, `1E+21`, `0.0000123456789012345`,
//!   `9.99999999999999E-06`); a zero part is left out, a unit imaginary part
//!   is written as the bare suffix (`i`, `-i`); both zero is `0`.
//! - **Suffix.** The result keeps the inputs' suffix (`j` stays `j`); mixing
//!   `i` and `j` is `#VALUE!` for `IMSUM`/`IMPRODUCT` and `#NUM!` for
//!   `IMSUB`/`IMDIV` (Excel-recorded).
//! - **Arithmetic** is Excel's: powers, roots and logarithms go through the
//!   polar form (`IMPOWER("i",2)` is `-1+1.22464679914735E-16i`), the
//!   trigonometric functions through their real decompositions; an overflow
//!   or a part beyond Excel's trigonometric limit (`|x| >= 2^27`) is `#NUM!`.

use sheet_core::{CellError, CellValue};

use super::util::{finite, flat, scalar};
use crate::arg::Arg;
use crate::coerce;
use crate::ctx::EvalCtx;

/// A complex value and the suffix it was written with (`None` = not stated,
/// as for a real number).
#[derive(Copy, Clone, Debug, PartialEq)]
pub(crate) struct Complex {
    pub re: f64,
    pub im: f64,
    pub suffix: Option<char>,
}

impl Complex {
    fn new(re: f64, im: f64) -> Self {
        // A signed zero carries no meaning here (`IMSQRT("-4-0i")` is
        // `…+2i` in Excel): normalise it away.
        Complex {
            re: re + 0.0,
            im: im + 0.0,
            suffix: None,
        }
    }

    fn with(self, suffix: Option<char>) -> Self {
        Complex { suffix, ..self }
    }

    fn abs(self) -> f64 {
        self.re.hypot(self.im)
    }

    fn arg(self) -> f64 {
        self.im.atan2(self.re)
    }

    fn mul(self, o: Complex) -> Complex {
        Complex::new(
            self.re * o.re - self.im * o.im,
            self.re * o.im + self.im * o.re,
        )
    }

    fn div(self, o: Complex) -> Option<Complex> {
        let d = o.re * o.re + o.im * o.im;
        if d == 0.0 {
            return None;
        }
        Some(Complex::new(
            (self.re * o.re + self.im * o.im) / d,
            (self.im * o.re - self.re * o.im) / d,
        ))
    }

    fn is_finite(self) -> bool {
        self.re.is_finite() && self.im.is_finite()
    }
}

/// Parse one coefficient (`3`, `3.`, `.5`, `1e+2`) at the start of `s`;
/// returns the value and the rest.
fn coefficient(s: &str) -> Option<(f64, &str)> {
    let b = s.as_bytes();
    let mut i = 0;
    let mut digits = 0;
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
        digits += 1;
    }
    if i < b.len() && b[i] == b'.' {
        i += 1;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
            digits += 1;
        }
    }
    if digits == 0 {
        return None;
    }
    if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        let mut j = i + 1;
        if j < b.len() && (b[j] == b'+' || b[j] == b'-') {
            j += 1;
        }
        let start = j;
        while j < b.len() && b[j].is_ascii_digit() {
            j += 1;
        }
        if j > start {
            i = j;
        } else {
            return None;
        }
    }
    let v: f64 = s[..i].parse().ok()?;
    Some((v, &s[i..]))
}

/// An optional sign at the start of `s`.
fn sign(s: &str) -> (f64, &str, bool) {
    match s.as_bytes().first() {
        Some(b'+') => (1.0, &s[1..], true),
        Some(b'-') => (-1.0, &s[1..], true),
        _ => (1.0, s, false),
    }
}

/// Parse Excel's complex text form.
pub(crate) fn parse_complex(text: &str) -> Option<Complex> {
    let compact: String = text.chars().filter(|c| *c != ' ').collect();
    let s = compact.as_str();
    if s.is_empty() {
        return None;
    }
    let (s1, rest, _) = sign(s);
    // Imaginary-only forms: "i", "-j", "4i".
    let is_suffix = |r: &str| matches!(r, "i" | "j");
    if is_suffix(rest) {
        return Some(Complex::new(0.0, s1).with(rest.chars().next()));
    }
    let (a, rest) = coefficient(rest)?;
    if rest.is_empty() {
        return Some(Complex::new(s1 * a, 0.0));
    }
    if is_suffix(rest) {
        return Some(Complex::new(0.0, s1 * a).with(rest.chars().next()));
    }
    let (s2, rest, had) = sign(rest);
    if !had {
        return None;
    }
    if is_suffix(rest) {
        return Some(Complex::new(s1 * a, s2).with(rest.chars().next()));
    }
    let (b, rest) = coefficient(rest)?;
    if is_suffix(rest) {
        return Some(Complex::new(s1 * a, s2 * b).with(rest.chars().next()));
    }
    None
}

/// One part of the written form: 15 significant digits, fixed notation while
/// it fits 21 characters, scientific beyond.
fn part_text(x: f64) -> String {
    let x = if x == 0.0 { 0.0 } else { x };
    let sci = format!("{:.14e}", x.abs());
    let (mant, exp) = sci.split_once('e').unwrap_or((sci.as_str(), "0"));
    let exp: i32 = exp.parse().unwrap_or(0);
    let digits: String = mant.chars().filter(|c| c.is_ascii_digit()).collect();
    let digits = digits.trim_end_matches('0');
    let digits = if digits.is_empty() { "0" } else { digits };
    let neg = if x < 0.0 { "-" } else { "" };
    // Fixed form of d.ddd × 10^exp.
    let fixed = if exp >= 0 {
        let e = exp as usize;
        if digits.len() <= e + 1 {
            format!("{digits}{}", "0".repeat(e + 1 - digits.len()))
        } else {
            format!("{}.{}", &digits[..=e], &digits[e + 1..])
        }
    } else {
        format!("0.{}{digits}", "0".repeat((-exp - 1) as usize))
    };
    if fixed.len() <= 21 {
        return format!("{neg}{fixed}");
    }
    let m = if digits.len() > 1 {
        format!("{}.{}", &digits[..1], &digits[1..])
    } else {
        digits.to_string()
    };
    let es = if exp < 0 { '-' } else { '+' };
    format!("{neg}{m}E{es}{:02}", exp.abs())
}

/// Write `z` in Excel's text form.
pub(crate) fn complex_text(z: Complex) -> String {
    let sfx = z.suffix.unwrap_or('i');
    let (re, im) = (z.re, z.im);
    let mut out = String::new();
    if re != 0.0 {
        out.push_str(&part_text(re));
    }
    if im != 0.0 {
        if im > 0.0 && !out.is_empty() {
            out.push('+');
        }
        if im == 1.0 {
        } else if im == -1.0 {
            out.push('-');
        } else {
            out.push_str(&part_text(im));
        }
        out.push(sfx);
    }
    if out.is_empty() {
        out.push('0');
    }
    out
}

/// A complex argument: text in the text form, a number as a real value; a
/// logical is `#VALUE!`, anything unparseable `#NUM!`.
fn value_complex(v: &CellValue) -> Result<Complex, CellError> {
    match v {
        CellValue::Number(x) => Ok(Complex::new(*x, 0.0)),
        CellValue::Text(t) => parse_complex(t).ok_or(CellError::Num),
        CellValue::Bool(_) => Err(CellError::Value),
        CellValue::Error(e) => Err(*e),
        CellValue::Empty => Ok(Complex::new(0.0, 0.0)),
    }
}

fn arg_complex(arg: Option<&Arg>) -> Result<Complex, CellError> {
    match scalar(arg) {
        Some(v) => value_complex(&v),
        None => Err(CellError::Value),
    }
}

/// The suffix two operands agree on, or `None` when they disagree.
fn merge_suffix(a: Option<char>, b: Option<char>) -> Result<Option<char>, ()> {
    match (a, b) {
        (Some(x), Some(y)) if x != y => Err(()),
        (Some(x), _) | (_, Some(x)) => Ok(Some(x)),
        _ => Ok(None),
    }
}

fn out(z: Complex) -> CellValue {
    if !z.is_finite() {
        return CellValue::Error(CellError::Num);
    }
    CellValue::Text(complex_text(z).into())
}

macro_rules! tri {
    ($e:expr) => {
        match $e {
            Ok(v) => v,
            Err(e) => return CellValue::Error(e),
        }
    };
}

/// `COMPLEX(real_num, i_num, [suffix])`.
pub fn complex(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    let re = tri!(super::util::atp_num(args.first()));
    let im = tri!(super::util::atp_num(args.get(1)));
    let sfx = match scalar(args.get(2)) {
        None | Some(CellValue::Empty) => 'i',
        Some(CellValue::Error(e)) => return CellValue::Error(e),
        Some(v) => match coerce::to_text(&v).as_str() {
            "" | "i" => 'i',
            "j" => 'j',
            _ => return CellValue::Error(CellError::Value),
        },
    };
    out(Complex::new(re, im).with(Some(sfx)))
}

fn unary_real(args: &[Arg], f: impl FnOnce(Complex) -> CellValue) -> CellValue {
    f(tri!(arg_complex(args.first())))
}

/// `IMABS(inumber)`.
pub fn imabs(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    unary_real(args, |z| finite(z.abs()))
}

/// `IMAGINARY(inumber)`.
pub fn imaginary(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    unary_real(args, |z| CellValue::Number(z.im + 0.0))
}

/// `IMREAL(inumber)`.
pub fn imreal(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    unary_real(args, |z| CellValue::Number(z.re + 0.0))
}

/// `IMARGUMENT(inumber)` — `#DIV/0!` at zero.
pub fn imargument(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    unary_real(args, |z| {
        if z.re == 0.0 && z.im == 0.0 {
            CellValue::Error(CellError::Div0)
        } else {
            finite(z.arg())
        }
    })
}

/// A complex → complex function keeping the input's suffix.
fn unary(args: &[Arg], f: impl FnOnce(Complex) -> Option<Complex>) -> CellValue {
    let z = tri!(arg_complex(args.first()));
    match f(z) {
        Some(r) => out(r.with(z.suffix)),
        None => CellValue::Error(CellError::Num),
    }
}

const TRIG_LIMIT: f64 = 134_217_728.0;

/// `sinh` and `cosh` from the exponential, as Excel evaluates them inside the
/// complex functions (the last digits of `IMSIN("4j")` depend on it).
fn sinh_e(x: f64) -> f64 {
    let e = x.exp();
    (e - 1.0 / e) / 2.0
}

fn cosh_e(x: f64) -> f64 {
    let e = x.exp();
    (e + 1.0 / e) / 2.0
}

fn sin_c(z: Complex) -> Option<Complex> {
    (z.re.abs() < TRIG_LIMIT)
        .then(|| Complex::new(z.re.sin() * cosh_e(z.im), z.re.cos() * sinh_e(z.im)))
}

fn cos_c(z: Complex) -> Option<Complex> {
    (z.re.abs() < TRIG_LIMIT)
        .then(|| Complex::new(z.re.cos() * cosh_e(z.im), -(z.re.sin() * sinh_e(z.im))))
}

fn sinh_c(z: Complex) -> Option<Complex> {
    (z.im.abs() < TRIG_LIMIT)
        .then(|| Complex::new(sinh_e(z.re) * z.im.cos(), cosh_e(z.re) * z.im.sin()))
}

fn cosh_c(z: Complex) -> Option<Complex> {
    (z.im.abs() < TRIG_LIMIT)
        .then(|| Complex::new(cosh_e(z.re) * z.im.cos(), sinh_e(z.re) * z.im.sin()))
}

fn recip(z: Option<Complex>) -> Option<Complex> {
    let z = z?;
    if !z.is_finite() {
        return None;
    }
    Complex::new(1.0, 0.0).div(z)
}

/// `IMCONJUGATE(inumber)`.
pub fn imconjugate(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    unary(args, |z| Some(Complex::new(z.re, -z.im)))
}

/// `IMSIN(inumber)`.
pub fn imsin(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    unary(args, sin_c)
}

/// `IMCOS(inumber)`.
pub fn imcos(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    unary(args, cos_c)
}

/// The reciprocal and quotient functions evaluate their double-angle forms
/// with the library `sinh` and the exponential `cosh` — the combination that
/// reproduces Excel's last digits on the recorded cases.
fn dbl_den_plus(z: Complex) -> f64 {
    (2.0 * z.re).cos() + cosh_e(2.0 * z.im)
}

fn dbl_den_minus(z: Complex) -> f64 {
    cosh_e(2.0 * z.im) - (2.0 * z.re).cos()
}

fn checked(z: Complex, d: f64, re: f64, im: f64) -> Option<Complex> {
    if z.re.abs() >= TRIG_LIMIT || d == 0.0 {
        return None;
    }
    Some(Complex::new(re / d, im / d))
}

/// `IMTAN(inumber)` — `(sin 2a + i sinh 2b) / (cos 2a + cosh 2b)`.
pub fn imtan(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    unary(args, |z| {
        let d = dbl_den_plus(z);
        checked(z, d, (2.0 * z.re).sin(), (2.0 * z.im).sinh())
    })
}

/// `IMCOT(inumber)` — `(sin 2a − i sinh 2b) / (cosh 2b − cos 2a)`.
pub fn imcot(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    unary(args, |z| {
        let d = dbl_den_minus(z);
        checked(z, d, (2.0 * z.re).sin(), -(2.0 * z.im).sinh())
    })
}

/// `IMSEC(inumber)` — `2(cos a cosh b + i sin a sinh b) / (cos 2a + cosh 2b)`.
pub fn imsec(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    unary(args, |z| {
        let d = dbl_den_plus(z);
        checked(
            z,
            d,
            2.0 * z.re.cos() * cosh_e(z.im),
            2.0 * z.re.sin() * z.im.sinh(),
        )
    })
}

/// `IMCSC(inumber)` — `2(sin a cosh b − i cos a sinh b) / (cosh 2b − cos 2a)`.
pub fn imcsc(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    unary(args, |z| {
        let d = dbl_den_minus(z);
        checked(
            z,
            d,
            2.0 * z.re.sin() * cosh_e(z.im),
            -2.0 * z.re.cos() * z.im.sinh(),
        )
    })
}

/// `IMSINH(inumber)`.
pub fn imsinh(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    unary(args, sinh_c)
}

/// `IMCOSH(inumber)`.
pub fn imcosh(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    unary(args, cosh_c)
}

/// `IMSECH(inumber)` — `1 / cosh z` (library `sinh`, exponential `cosh`).
pub fn imsech(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    unary(args, |z| {
        (z.im.abs() < TRIG_LIMIT)
            .then(|| Complex::new(cosh_e(z.re) * z.im.cos(), z.re.sinh() * z.im.sin()))
            .and_then(|c| recip(Some(c)))
    })
}

/// `IMCSCH(inumber)` — `1 / sinh z` (library `sinh`, exponential `cosh`).
pub fn imcsch(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    unary(args, |z| {
        (z.im.abs() < TRIG_LIMIT)
            .then(|| Complex::new(z.re.sinh() * z.im.cos(), cosh_e(z.re) * z.im.sin()))
            .and_then(|c| recip(Some(c)))
    })
}

/// `IMEXP(inumber)`.
pub fn imexp(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    unary(args, |z| {
        let r = z.re.exp();
        (z.im.abs() < TRIG_LIMIT).then(|| Complex::new(r * z.im.cos(), r * z.im.sin()))
    })
}

fn ln_c(z: Complex) -> Option<Complex> {
    if z.re == 0.0 && z.im == 0.0 {
        return None;
    }
    Some(Complex::new(z.abs().ln(), z.arg()))
}

/// `IMLN(inumber)`.
pub fn imln(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    unary(args, ln_c)
}

/// `IMLOG10(inumber)`.
pub fn imlog10(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    unary(args, |z| {
        let l = ln_c(z)?;
        // Excel's last digits: the modulus part through log10(e), the
        // argument through 1/ln(10) (searched against the recordings).
        Some(Complex::new(
            l.re * std::f64::consts::LOG10_E,
            l.im * (1.0 / std::f64::consts::LN_10),
        ))
    })
}

/// `IMLOG2(inumber)`.
pub fn imlog2(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    unary(args, |z| {
        let l = ln_c(z)?;
        Some(Complex::new(
            l.re * std::f64::consts::LOG2_E,
            l.im * (1.0 / std::f64::consts::LN_2),
        ))
    })
}

/// `z^n` through the polar form.
fn pow_c(z: Complex, n: f64) -> Option<Complex> {
    if z.re == 0.0 && z.im == 0.0 {
        return (n > 0.0).then(|| Complex::new(0.0, 0.0));
    }
    let r = z.abs().powf(n);
    let t = z.arg() * n;
    if t.abs() >= TRIG_LIMIT {
        return None;
    }
    Some(Complex::new(r * t.cos(), r * t.sin()))
}

/// `IMSQRT(inumber)`.
pub fn imsqrt(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    unary(args, |z| {
        if z.re == 0.0 && z.im == 0.0 {
            return Some(z);
        }
        let r = z.abs().sqrt();
        let t = z.arg() / 2.0;
        Some(Complex::new(r * t.cos(), r * t.sin()))
    })
}

/// `IMPOWER(inumber, number)`.
pub fn impower(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    let z = tri!(arg_complex(args.first()));
    let n = tri!(super::util::num(args.get(1)));
    match pow_c(z, n) {
        Some(r) => out(r.with(z.suffix)),
        None => CellValue::Error(CellError::Num),
    }
}

/// `IMDIV(inumber1, inumber2)`.
pub fn imdiv(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    let a = tri!(arg_complex(args.first()));
    let b = tri!(arg_complex(args.get(1)));
    let Ok(sfx) = merge_suffix(a.suffix, b.suffix) else {
        return CellValue::Error(CellError::Num);
    };
    match a.div(b) {
        Some(r) => out(r.with(sfx)),
        None => CellValue::Error(CellError::Num),
    }
}

/// `IMSUB(inumber1, inumber2)`.
pub fn imsub(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    let a = tri!(arg_complex(args.first()));
    let b = tri!(arg_complex(args.get(1)));
    let Ok(sfx) = merge_suffix(a.suffix, b.suffix) else {
        return CellValue::Error(CellError::Num);
    };
    out(Complex::new(a.re - b.re, a.im - b.im).with(sfx))
}

/// Every operand of a variadic complex function: blanks inside a range are
/// skipped; the suffixes must agree (`#VALUE!`).
fn operands(args: &[Arg]) -> Result<(Vec<Complex>, Option<char>), CellError> {
    let mut zs = Vec::new();
    let mut sfx = None;
    for a in args {
        let values = match a {
            Arg::Scalar(v) => vec![v.clone()],
            Arg::Range(_) => flat(a)
                .into_iter()
                .filter(|v| !matches!(v, CellValue::Empty))
                .collect(),
        };
        for v in values {
            let z = value_complex(&v)?;
            sfx = merge_suffix(sfx, z.suffix).map_err(|()| CellError::Value)?;
            zs.push(z);
        }
    }
    Ok((zs, sfx))
}

/// `IMSUM(inumber1, …)`.
pub fn imsum(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    let (zs, sfx) = tri!(operands(args));
    let (re, im) = zs.iter().fold((0.0, 0.0), |(r, i), z| (r + z.re, i + z.im));
    out(Complex::new(re, im).with(sfx))
}

/// `IMPRODUCT(inumber1, …)`.
pub fn improduct(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    let (zs, sfx) = tri!(operands(args));
    let mut acc = Complex::new(1.0, 0.0);
    for z in zs {
        acc = acc.mul(z);
    }
    out(acc.with(sfx))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_form_round_trip() {
        let z = parse_complex("3+4i").unwrap();
        assert_eq!((z.re, z.im, z.suffix), (3.0, 4.0, Some('i')));
        assert_eq!(parse_complex("-j").unwrap().im, -1.0);
        assert_eq!(parse_complex("1e+2i").unwrap().im, 100.0);
        assert!(parse_complex("3+4ij").is_none());
        assert!(parse_complex("i5").is_none());
        assert_eq!(part_text(1e20), "100000000000000000000");
        assert_eq!(part_text(1e21), "1E+21");
        assert_eq!(part_text(1.23456789012345e-5), "0.0000123456789012345");
        assert_eq!(part_text(9.99999999999999e-6), "9.99999999999999E-06");
        assert_eq!(complex_text(Complex::new(0.0, -1.0)), "-i");
    }
}
