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

//! Misc T2 functions (spec §7/§11 T2 "remaining publishing-relevant
//! functions"): [`aggregate`], [`subtotal`], [`roman`], [`arabic`],
//! [`hyperlink`]. Pure kernels of the frozen signature
//! `fn(&[Arg], &EvalCtx) -> CellValue`; the arity guard runs in the generated
//! [`crate::dispatch`] before these are called. All coercion routes through
//! [`crate::coerce`]; arithmetic accumulation routes through the
//! [`crate::num`] seam (D-6).
//!
//! # Documented T2 subsets (these are RULINGS, not accidents — spec §3)
//!
//! ## `AGGREGATE(function_num, options, ref1, …)`
//!
//! Microsoft's `AGGREGATE` has 19 inner aggregates and 8 option modes. The T2
//! scope is the **publishing-relevant core** and is enforced, not faked:
//!
//! - **`function_num` 1–11** only — `AVERAGE`(1), `COUNT`(2), `COUNTA`(3),
//!   `MAX`(4), `MIN`(5), `PRODUCT`(6), `STDEV.S`(7), `STDEV.P`(8), `SUM`(9),
//!   `VAR.S`(10), `VAR.P`(11). `function_num` 12–19 (`MEDIAN`, `MODE.SNGL`,
//!   `LARGE`, `SMALL`, `PERCENTILE.INC`, `QUARTILE.INC`, `PERCENTILE.EXC`,
//!   `QUARTILE.EXC`) take a trailing `k`/quantile argument and are **deferred
//!   in T2** → `#VALUE!`. Any other `function_num` → `#VALUE!` (Excel).
//! - **`options` 0, 4, or 6** only. `0`/`4` = "ignore nothing" (they are
//!   identical here — both still EXCLUDE nested `SUBTOTAL`/`AGGREGATE` results,
//!   which Excel does for every option). `6` = "ignore error values" (an error
//!   cell inside a range is skipped rather than propagated). The hidden-row
//!   options (`1`,`2`,`3`,`5`,`7`) need row-visibility metadata that never
//!   reaches a pure kernel → `#VALUE!`. (Spec §2: no SDK/model access from a
//!   kernel.)
//!
//! Under option `0`/`4`, an error cell anywhere in a `ref` **is** the result
//! (first error wins, row-major) — exactly the aggregation family's ruling.
//! Under option `6`, error cells are skipped.
//!
//! **Nested-result exclusion (FINDING 3, now implemented eval-side):** like
//! `SUBTOTAL`, `AGGREGATE` skips cells in its ranges that are themselves
//! `SUBTOTAL`/`AGGREGATE` results. A pure kernel can't see precedent formulas,
//! so the evaluator masks those cells to blank during range materialization
//! (`sheet-calc/eval.rs` `plan_args` → `materialize_range_masked`) BEFORE this
//! kernel runs — the kernel just sees blanks and skips them.
//!
//! ## `SUBTOTAL(function_num, ref1, …)`
//!
//! `function_num` 1–11 (include manually-hidden rows) and 101–111 (ignore
//! manually-hidden rows) — same inner-aggregate mapping as `AGGREGATE` above.
//! **T2 ruling:** a pure kernel has no row-visibility metadata, so 1–11 and
//! 101–111 compute **identically** (all cells participate). `SUBTOTAL`
//! EXCLUDES the results of *nested* `SUBTOTAL`/`AGGREGATE` calls inside a `ref`
//! (ECMA-376 §18.17.7) — `SUBTOTAL(9, A1:A6)` where `A6 = SUBTOTAL(9, A1:A5)`
//! sums A1:A5 once, not twice. FINDING 3: a pure kernel can't see precedent
//! formulas, so this exclusion is done EVAL-SIDE — the evaluator masks nested
//! subtotal cells to blank during range materialization (`sheet-calc/eval.rs`
//! `plan_args` → `materialize_range_masked`, gated on the outer call being
//! SUBTOTAL/AGGREGATE) BEFORE this kernel runs. The kernel stays pure: it just
//! sees the masked blanks and skips them. (Only the direct `=SUBTOTAL(...)`
//! root is treated as a nested result, matching Excel; a SUBTOTAL inside a
//! larger expression is not.) An error cell in a `ref` propagates (first error
//! wins).
//!
//! ## `ROMAN(number, [form])` / `ARABIC(text)`
//!
//! `ROMAN` renders an integer 1–3999 as classic roman-numeral **text**;
//! `ROMAN(0)` → `""`; a negative number or >3999 → `#VALUE!` (Excel). The
//! optional `form` selects a more-concise style in Excel (0 = classic, 1–4
//! progressively shorter); **T2 implements form 0 (classic)** and accepts any
//! `form` 0–4 by rendering classic (documented simplification — the publishing
//! use is the classic numeral). `ARABIC` is the inverse: roman text → number,
//! a leading `-` negates, `""` → 0, non-roman text → `#VALUE!`.
//!
//! `CONVERT` moved to [`super::units`] (the full unit table, W3).
//!
//! ## `HYPERLINK(link_location, [friendly_name])`
//!
//! **T2 ruling: display-only.** A formula cell cannot host a navigable link on
//! the lowered page surface (spec §8), so `HYPERLINK` returns its
//! `friendly_name` text — or the `link_location` text when `friendly_name` is
//! absent or blank. The link target is preserved in the formula (round-trip)
//! but is **not navigable on the page**. Documented, not faked.

use sheet_core::{CellError, CellValue};

use crate::arg::Arg;
use crate::coerce;
use crate::ctx::EvalCtx;
use crate::num::{Numeric, F64};

// ============================================================================
// AGGREGATE / SUBTOTAL — function_num-selected aggregation
// ============================================================================

/// The inner aggregate an `AGGREGATE`/`SUBTOTAL` `function_num` selects
/// (1-based, the T2-supported 1–11 set). `SUBTOTAL`'s 101–111 map to the same
/// kernel here (T2 has no hidden-row metadata, see module docs).
#[derive(Copy, Clone, PartialEq, Eq, Debug)]
enum InnerFn {
    Average,
    Count,
    CountA,
    Max,
    Min,
    Product,
    StdevS,
    StdevP,
    Sum,
    VarS,
    VarP,
}

impl InnerFn {
    /// Map a 1–11 `function_num` to its inner aggregate (the shared
    /// `AGGREGATE`/`SUBTOTAL` selector). `None` for anything outside 1–11.
    fn from_num(n: u32) -> Option<InnerFn> {
        Some(match n {
            1 => InnerFn::Average,
            2 => InnerFn::Count,
            3 => InnerFn::CountA,
            4 => InnerFn::Max,
            5 => InnerFn::Min,
            6 => InnerFn::Product,
            7 => InnerFn::StdevS,
            8 => InnerFn::StdevP,
            9 => InnerFn::Sum,
            10 => InnerFn::VarS,
            11 => InnerFn::VarP,
            _ => return None,
        })
    }
}

/// What an inner aggregate counts vs. sums: most operate on the numeric values
/// of the participating cells; `COUNT`/`COUNTA` are pure counters.
fn apply_inner(inner: InnerFn, nums: &[f64], count_numbers: u64, count_nonblank: u64) -> CellValue {
    match inner {
        InnerFn::Count => CellValue::Number(count_numbers as f64),
        InnerFn::CountA => CellValue::Number(count_nonblank as f64),
        InnerFn::Average => {
            if nums.is_empty() {
                return CellValue::Error(CellError::Div0);
            }
            CellValue::Number(mean(nums))
        }
        InnerFn::Max => {
            let m = nums
                .iter()
                .copied()
                .fold(None, |a: Option<f64>, n| Some(a.map_or(n, |a| a.max(n))));
            CellValue::Number(m.unwrap_or(0.0))
        }
        InnerFn::Min => {
            let m = nums
                .iter()
                .copied()
                .fold(None, |a: Option<f64>, n| Some(a.map_or(n, |a| a.min(n))));
            CellValue::Number(m.unwrap_or(0.0))
        }
        InnerFn::Product => {
            // PRODUCT of no numbers is 0 (Excel).
            if nums.is_empty() {
                return CellValue::Number(0.0);
            }
            let mut p = F64::from_f64(1.0);
            for n in nums {
                p = p.mul(F64::from_f64(*n));
            }
            CellValue::Number(p.to_f64())
        }
        InnerFn::Sum => {
            let mut s = F64::from_f64(0.0);
            for n in nums {
                s = s.add(F64::from_f64(*n));
            }
            CellValue::Number(s.to_f64())
        }
        // Sample statistics need at least 2 points (n-1 divisor); population
        // needs at least 1. Too-few points -> #DIV/0! (Excel).
        InnerFn::VarS => {
            variance(nums, true).map_or(CellValue::Error(CellError::Div0), CellValue::Number)
        }
        InnerFn::VarP => {
            variance(nums, false).map_or(CellValue::Error(CellError::Div0), CellValue::Number)
        }
        InnerFn::StdevS => variance(nums, true).map_or(CellValue::Error(CellError::Div0), |v| {
            CellValue::Number(v.sqrt())
        }),
        InnerFn::StdevP => variance(nums, false).map_or(CellValue::Error(CellError::Div0), |v| {
            CellValue::Number(v.sqrt())
        }),
    }
}

/// Arithmetic mean (routes the running sum through the [`crate::num`] seam).
fn mean(nums: &[f64]) -> f64 {
    let mut s = F64::from_f64(0.0);
    for n in nums {
        s = s.add(F64::from_f64(*n));
    }
    s.div(F64::from_f64(nums.len() as f64)).to_f64()
}

/// Variance: `sample` selects the `n-1` divisor (`VAR.S`/`STDEV.S`) vs the `n`
/// divisor (`VAR.P`/`STDEV.P`). `None` when there are too few points for the
/// chosen divisor (sample needs ≥2, population needs ≥1).
fn variance(nums: &[f64], sample: bool) -> Option<f64> {
    let n = nums.len();
    let divisor = if sample { n.checked_sub(1)? } else { n };
    if divisor == 0 {
        return None;
    }
    let m = mean(nums);
    let mut acc = F64::from_f64(0.0);
    for x in nums {
        let d = F64::from_f64(*x).sub(F64::from_f64(m));
        acc = acc.add(d.mul(d));
    }
    Some(acc.div(F64::from_f64(divisor as f64)).to_f64())
}

/// Outcome of scanning the `ref` arguments of an `AGGREGATE`/`SUBTOTAL` call.
struct Scan {
    /// Numeric values participating in value-based aggregates.
    nums: Vec<f64>,
    /// Count of numeric cells (the `COUNT` answer).
    count_numbers: u64,
    /// Count of non-blank cells (the `COUNTA` answer).
    count_nonblank: u64,
    /// First error encountered (only set when errors are NOT skipped).
    first_error: Option<CellError>,
}

/// Scan the `ref` arguments past the leading selector args. `skip_errors`
/// controls error handling: when `true` (AGGREGATE option 6) an error cell is
/// skipped; when `false` the first error is captured for propagation.
///
/// Scalar args go through [`coerce::to_number`] (bool / numeric-text
/// participate), matching the aggregation family's scalar/range asymmetry; a
/// non-numeric scalar that fails coercion is treated as a value error (skipped
/// or propagated per `skip_errors`). Range cells: numbers participate, errors
/// per `skip_errors`, and text/bool/blank are skipped for value aggregates but
/// still feed `COUNTA` when non-blank.
fn scan_refs(refs: &[Arg], skip_errors: bool) -> Scan {
    let mut s = Scan {
        nums: Vec::new(),
        count_numbers: 0,
        count_nonblank: 0,
        first_error: None,
    };
    for a in refs {
        match a {
            Arg::Scalar(v) => {
                // A scalar argument is always "present" for COUNTA.
                if !v.is_blank() {
                    s.count_nonblank += 1;
                }
                match coerce::to_number(v) {
                    Ok(n) => {
                        s.nums.push(n);
                        s.count_numbers += 1;
                    }
                    Err(e) => {
                        // Numeric-text/bool already succeeded above; this is a
                        // genuine error or non-numeric text. Propagate the
                        // error variant unless errors are being skipped.
                        if matches!(v, CellValue::Error(_)) && !skip_errors {
                            s.first_error.get_or_insert(e);
                        }
                    }
                }
            }
            Arg::Range(view) => {
                for cell in view.iter() {
                    if !cell.is_blank() {
                        s.count_nonblank += 1;
                    }
                    match cell {
                        CellValue::Number(n) => {
                            s.nums.push(n);
                            s.count_numbers += 1;
                        }
                        CellValue::Error(e) if !skip_errors => {
                            s.first_error.get_or_insert(e);
                        }
                        // Text / Bool / Empty: skipped for value aggregates
                        // (already counted for COUNTA above when non-blank).
                        _ => {}
                    }
                }
            }
        }
    }
    s
}

/// `AGGREGATE(function_num, options, ref1, …)` and
/// `AGGREGATE(function_num, options, array, k)` (Microsoft reference).
/// `function_num` 1–11 are the SUBTOTAL aggregates, 12 MEDIAN, 13
/// MODE.SNGL, 14 LARGE, 15 SMALL, 16 PERCENTILE.INC, 17 QUARTILE.INC, 18
/// PERCENTILE.EXC, 19 QUARTILE.EXC (14–19 take `k`). `options` 0–7: 2, 3, 6
/// and 7 skip error values; the hidden-row and nested-subtotal parts are
/// applied by the evaluator before the kernel sees the references
/// (`sheet-calc` `subtotal_mask`). Anything else is `#VALUE!`.
pub fn aggregate(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    let fnum = match scalar_u32(args.first()) {
        Ok(n) => n,
        Err(e) => return CellValue::Error(e),
    };
    let options = match scalar_u32(args.get(1)) {
        Ok(n) => n,
        Err(e) => return CellValue::Error(e),
    };
    if options > 7 {
        return CellValue::Error(CellError::Value);
    }
    let skip_errors = matches!(options, 2 | 3 | 6 | 7);
    // The reference form (1–13) takes references; a value is #VALUE!
    // (Excel-recorded: AGGREGATE(9,5,5)). A single cell arrives as a 1×1
    // reference (the evaluator materializes it for this function).
    if fnum <= 13 && args[2..].iter().any(|a| matches!(a, Arg::Scalar(_))) {
        return CellValue::Error(CellError::Value);
    }
    if let Some(inner) = InnerFn::from_num(fnum) {
        let scan = scan_refs(&args[2..], skip_errors);
        // COUNT and COUNTA never propagate an error cell.
        if let Some(e) = scan
            .first_error
            .filter(|_| !matches!(inner, InnerFn::Count | InnerFn::CountA))
        {
            return CellValue::Error(e);
        }
        return apply_inner(inner, &scan.nums, scan.count_numbers, scan.count_nonblank);
    }
    if !(12..=19).contains(&fnum) {
        return CellValue::Error(CellError::Value);
    }
    let (data, k) = if fnum >= 14 {
        if args.len() < 4 {
            return CellValue::Error(CellError::Value);
        }
        let k = match scalar_number(args.get(3)) {
            Ok(k) => k,
            Err(e) => return CellValue::Error(e),
        };
        (&args[2..3], k)
    } else {
        (&args[2..], 0.0)
    };
    let scan = scan_refs(data, skip_errors);
    if let Some(e) = scan.first_error {
        return CellValue::Error(e);
    }
    let mut v = scan.nums;
    v.sort_by(f64::total_cmp);
    let num = |x: f64| CellValue::Number(x);
    let nume = CellValue::Error(CellError::Num);
    if v.is_empty() {
        return if fnum == 13 {
            CellValue::Error(CellError::Na)
        } else {
            nume
        };
    }
    match fnum {
        12 => num(super::stat::percentile_of_sorted(&v, 0.5)),
        13 => {
            // The most frequent value, the first to occur in a tie; none
            // repeated is #N/A.
            let mut best: Option<(f64, usize)> = None;
            for x in &scan_order(data, skip_errors) {
                let count = v.iter().filter(|y| *y == x).count();
                if count > 1 && best.is_none_or(|(_, c)| count > c) {
                    best = Some((*x, count));
                }
            }
            match best {
                Some((x, _)) => num(x),
                None => CellValue::Error(CellError::Na),
            }
        }
        14 | 15 => {
            let k = k.ceil();
            if k < 1.0 || k > v.len() as f64 {
                return nume;
            }
            let i = k as usize - 1;
            num(if fnum == 14 { v[v.len() - 1 - i] } else { v[i] })
        }
        16 => {
            if !(0.0..=1.0).contains(&k) {
                return nume;
            }
            num(super::stat::percentile_of_sorted(&v, k))
        }
        17 => {
            let q = k.trunc();
            if !(0.0..=4.0).contains(&q) {
                return nume;
            }
            num(super::stat::percentile_of_sorted(&v, q / 4.0))
        }
        18 => match super::stat2::percentile_exc_of(&v, k) {
            Ok(x) => num(x),
            Err(e) => CellValue::Error(e),
        },
        _ => {
            let q = k.trunc();
            if !(1.0..=3.0).contains(&q) {
                return nume;
            }
            match super::stat2::percentile_exc_of(&v, q / 4.0) {
                Ok(x) => num(x),
                Err(e) => CellValue::Error(e),
            }
        }
    }
}

/// The numbers of the references in their original order (MODE's tie rule).
fn scan_order(refs: &[Arg], skip_errors: bool) -> Vec<f64> {
    scan_refs(refs, skip_errors).nums
}

/// `SUBTOTAL(function_num, ref1, …)` (registry `sheet.fn.math.subtotal`).
/// `function_num` 1–11 (include hidden) and 101–111 (ignore hidden); T2 has no
/// row-visibility metadata so the two ranges compute identically (module
/// docs). NESTED SUBTOTAL/AGGREGATE cells inside a `ref` are excluded — but
/// that happens EVAL-SIDE (the evaluator masks them to blank before this kernel
/// runs; FINDING 3, module docs), so this pure kernel just sees blanks. Errors
/// propagate (first error wins). The leading arg is the selector; the rest are
/// the refs.
pub fn subtotal(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    let raw = match scalar_u32(args.first()) {
        Ok(n) => n,
        Err(e) => return CellValue::Error(e),
    };
    // 101-111 normalize to 1-11 (T2: no hidden-row distinction).
    let fnum = if (101..=111).contains(&raw) {
        raw - 100
    } else {
        raw
    };
    let Some(inner) = InnerFn::from_num(fnum) else {
        return CellValue::Error(CellError::Value);
    };

    let refs = &args[1..];
    // SUBTOTAL always propagates errors (there is no ignore-error option).
    let scan = scan_refs(refs, false);
    if let Some(e) = scan.first_error {
        return CellValue::Error(e);
    }
    apply_inner(inner, &scan.nums, scan.count_numbers, scan.count_nonblank)
}

/// Read a leading selector/option arg as a non-negative integer. The arg is
/// coerced to a number (bool/numeric-text accepted), truncated toward zero;
/// an error coercion propagates; a negative value is `#VALUE!` (no negative
/// function_num/option exists). A range arg uses its top-left cell.
fn scalar_u32(arg: Option<&Arg>) -> Result<u32, CellError> {
    let v = match arg {
        Some(Arg::Scalar(v)) => v.clone(),
        Some(Arg::Range(view)) => view.get(0, 0),
        None => return Err(CellError::Value),
    };
    let n = coerce::to_number(&v)?;
    if !n.is_finite() || n < 0.0 {
        return Err(CellError::Value);
    }
    Ok(n.trunc() as u32)
}

// ============================================================================
// ROMAN / ARABIC — roman-numeral <-> integer text conversions
// ============================================================================

/// The classic additive/subtractive roman-numeral table, descending.
/// Roman symbols with the form (0 classic … 4 simplified) from which each
/// subtractive pair is allowed: form 1 adds the "5 before 10x/50x" pairs
/// (VL, LD…), form 2 the "1 before 50x/100x" pairs (IL, XD…), forms 3 and 4
/// the widest (VD, VM; ID, IM). Greedy over this table reproduces Excel's
/// `ROMAN(499, 0..4)` = CDXCIX, LDVLIV, XDIX, VDIV, ID.
const ROMAN_TABLE: &[(u32, &str, u8)] = &[
    (1000, "M", 0),
    (999, "IM", 4),
    (995, "VM", 3),
    (990, "XM", 2),
    (950, "LM", 1),
    (900, "CM", 0),
    (500, "D", 0),
    (499, "ID", 4),
    (495, "VD", 3),
    (490, "XD", 2),
    (450, "LD", 1),
    (400, "CD", 0),
    (100, "C", 0),
    (99, "IC", 2),
    (95, "VC", 1),
    (90, "XC", 0),
    (50, "L", 0),
    (49, "IL", 2),
    (45, "VL", 1),
    (40, "XL", 0),
    (10, "X", 0),
    (9, "IX", 0),
    (5, "V", 0),
    (4, "IV", 0),
    (1, "I", 0),
];

/// `ROMAN(number, [form])` (registry `sheet.fn.math.roman`) — roman-numeral
/// text for an integer 0–3999 in one of Excel's five forms (0 classic … 4
/// simplified; `TRUE` is 0, `FALSE` 4). `0` → `""`; negative or >3999 →
/// `#VALUE!`; a form outside 0–4 is `#VALUE!`.
pub fn roman(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    let number = match scalar_number(args.first()) {
        Ok(n) => n,
        Err(e) => return CellValue::Error(e),
    };
    let form = match args.get(1) {
        None | Some(Arg::Scalar(CellValue::Empty)) => 0,
        Some(Arg::Scalar(CellValue::Bool(b))) => {
            if *b {
                0
            } else {
                4
            }
        }
        Some(a) => match scalar_number(Some(a)) {
            Ok(f) => {
                let f = f.trunc();
                if !(0.0..=4.0).contains(&f) {
                    return CellValue::Error(CellError::Value);
                }
                f as u8
            }
            Err(e) => return CellValue::Error(e),
        },
    };
    let n = number.trunc();
    if !(0.0..=3999.0).contains(&n) {
        return CellValue::Error(CellError::Value);
    }
    let mut v = n as u32;
    let mut out = String::new();
    for (val, sym, min_form) in ROMAN_TABLE {
        if *min_form > form {
            continue;
        }
        while v >= *val {
            out.push_str(sym);
            v -= *val;
        }
    }
    CellValue::Text(out.into())
}

/// `ARABIC(text)` (registry `sheet.fn.math.arabic`). The inverse of classic
/// `ROMAN`: parse roman-numeral text to a number. A leading `-` negates;
/// `""`/whitespace → `0`; any non-roman character → `#VALUE!`. Lower-case is
/// accepted (Excel folds case). An error scalar propagates.
pub fn arabic(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    let v = match args.first() {
        Some(Arg::Scalar(v)) => v.clone(),
        Some(Arg::Range(view)) => view.get(0, 0),
        None => return CellValue::Error(CellError::Value),
    };
    if let CellValue::Error(e) = v {
        return CellValue::Error(e);
    }
    let text = coerce::to_text(&v);
    let trimmed = text.trim();
    let (negative, body) = match trimmed.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, trimmed),
    };
    if body.is_empty() {
        return CellValue::Number(0.0);
    }
    match parse_roman(body) {
        Some(val) => CellValue::Number(if negative { -(val as f64) } else { val as f64 }),
        None => CellValue::Error(CellError::Value),
    }
}

/// Parse an upper/lower-case roman string to its integer value via the
/// standard subtractive scan (a smaller symbol before a larger one
/// subtracts). Returns `None` on any non-roman character. Permissive about
/// canonical form (Excel's `ARABIC` accepts non-canonical strings like
/// `"MCMXC"`); we accept any string of roman letters and sum subtractively.
fn parse_roman(s: &str) -> Option<u32> {
    fn digit(c: char) -> Option<u32> {
        Some(match c.to_ascii_uppercase() {
            'I' => 1,
            'V' => 5,
            'X' => 10,
            'L' => 50,
            'C' => 100,
            'D' => 500,
            'M' => 1000,
            _ => return None,
        })
    }
    let vals: Vec<u32> = s.chars().map(digit).collect::<Option<Vec<u32>>>()?;
    let mut total: i64 = 0;
    for i in 0..vals.len() {
        let cur = vals[i] as i64;
        // A smaller value immediately before a larger one is subtractive.
        if i + 1 < vals.len() && cur < vals[i + 1] as i64 {
            total -= cur;
        } else {
            total += cur;
        }
    }
    if total < 0 {
        None
    } else {
        Some(total as u32)
    }
}

// ============================================================================
// HYPERLINK — display-only (T2 ruling)
// ============================================================================

/// `HYPERLINK(link_location, [friendly_name])` (registry
/// `sheet.fn.lookup.hyperlink`). T2 ruling: display-only — returns the
/// `friendly_name` text, or the `link_location` text when `friendly_name` is
/// absent or blank. The link is not navigable on the page surface (module
/// docs). An error in either argument propagates.
pub fn hyperlink(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    if let Some(e) = coerce::first_error(args) {
        return CellValue::Error(e);
    }
    let link = match args.first() {
        Some(Arg::Scalar(v)) => v.clone(),
        Some(Arg::Range(view)) => view.get(0, 0),
        None => return CellValue::Error(CellError::Value),
    };
    // A given friendly_name is the cell's value AS IS (Excel 16: a number
    // stays a number, "" shows empty); only an absent/blank one shows the
    // link.
    let friendly = match args.get(1) {
        Some(Arg::Scalar(v)) => Some(v.clone()),
        Some(Arg::Range(view)) => Some(view.get(0, 0)),
        None => None,
    };
    match friendly {
        Some(CellValue::Empty) | None => CellValue::Text(coerce::to_text(&link)),
        Some(v) => v,
    }
}

// ============================================================================
// shared scalar readers
// ============================================================================

/// Read an argument as a number through [`coerce::to_number`] (a range uses
/// its top-left cell). Propagates a coercion error.
fn scalar_number(arg: Option<&Arg>) -> Result<f64, CellError> {
    let v = match arg {
        Some(Arg::Scalar(v)) => v.clone(),
        Some(Arg::Range(view)) => view.get(0, 0),
        None => return Err(CellError::Value),
    };
    coerce::to_number(&v)
}
