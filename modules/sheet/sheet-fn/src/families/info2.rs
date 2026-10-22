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

//! M1 information (M1 additions) family kernels (spec §7, §11 T1): `N`,
//! `TYPE`, `ERROR.TYPE`, `SHEET`, `SHEETS`, `ISEVEN`, `ISODD` (ECMA-376
//! §18.17.7 + Microsoft public function docs). Each kernel is the frozen pure
//! signature `fn(&[Arg], &EvalCtx) -> CellValue`; the generated
//! [`crate::dispatch`] arity-checks before calling (`N`/`TYPE`/`ERROR.TYPE`/
//! `ISEVEN`/`ISODD` exactly 1 arg; `SHEET`/`SHEETS` 0–1), so a kernel only
//! ever sees a well-formed argument list.
//!
//! # The split with `crate::families::info`
//!
//! The classic `IS*` predicates *inspect* their argument and never
//! propagate an argument error (`ISERROR(#DIV/0!)` is `TRUE`). The M1
//! additions are **not** all predicates and do **not** share that rule:
//!   - `N`/`ISEVEN`/`ISODD` are *coercions* — they route through
//!     [`crate::coerce::to_number`] and therefore **propagate** an error
//!     argument (`N(#DIV/0!)` is `#DIV/0!`), like a math kernel.
//!   - `TYPE`/`ERROR.TYPE` *classify* — they **inspect** the variant (an
//!     error argument is the subject, never returned): `TYPE(#N/A)` is `16`,
//!     `ERROR.TYPE(#NULL!)` is `1`.
//!   - `SHEET`/`SHEETS` are reference functions resolved from the argument's
//!     [`crate::arg::RangeView::origin`] (sheet id) or the current cell.
//!
//! # ISFORMULA — left PLANNED (T1 limitation; see the registry row)
//!
//! `ISFORMULA(reference)` must know whether the *referenced cell* stores a
//! formula. A pure `fn(&[Arg], &EvalCtx)` kernel receives only the cell's
//! **evaluated value** (an [`Arg::Range`]/[`Arg::Scalar`]) — neither [`Arg`]
//! nor [`EvalCtx`] carries a "this cell is a formula" flag, and there is no
//! cell→formula hook on the context. Implementing it from the value alone
//! would be a fabrication (a `2` is the same `Number(2.0)` whether typed or
//! computed). The row stays `planned` until the calling convention grows a
//! reference-introspection seam (an additive `EvalCtx` hook or an `Arg`
//! origin-formula flag) — flagged in the track report, not faked.

use sheet_core::{CellError, CellValue};

use crate::arg::Arg;
use crate::coerce;
use crate::ctx::EvalCtx;

/// Resolve a single info argument to the [`CellValue`] under inspection. A
/// scalar is taken as-is; a range collapses to its relative-`(0,0)` cell (the
/// implicit-intersection fallback — out-of-bounds yields `Empty`). Mirrors
/// `info::subject`.
fn subject(arg: &Arg) -> CellValue {
    match arg {
        Arg::Scalar(v) => v.clone(),
        Arg::Range(view) => view.get(0, 0),
    }
}

/// `N(value)` — coerce a value to a number (ECMA-376 §18.17.7). The narrow
/// coercion `N` performs:
/// - a number → itself;
/// - `TRUE` → `1`, `FALSE` → `0`;
/// - a **date** is already a serial number, so it returns that serial
///   unchanged (no special date handling — dates are numbers, §5);
/// - **text → `0`** (Excel's ruling: `N` does NOT parse numeric text;
///   `N("7")` is `0`, not `7` — this is the defining difference from the
///   general number coercion, which *would* parse it). A blank cell is `0`.
/// - an **error propagates** (`N(#DIV/0!)` is `#DIV/0!`).
pub fn n(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    match subject(&args[0]) {
        CellValue::Number(x) => CellValue::Number(x),
        CellValue::Bool(b) => CellValue::Number(if b { 1.0 } else { 0.0 }),
        CellValue::Empty => CellValue::Number(0.0),
        // Excel ruling: N does not parse numeric text — any text is 0.
        CellValue::Text(_) => CellValue::Number(0.0),
        CellValue::Error(e) => CellValue::Error(e),
    }
}

/// `TYPE(value)` — classify a value by type code (ECMA-376 §18.17.7):
/// `1` number, `2` text, `4` logical, `16` error, `64` array. **Inspects**
/// the variant — an error argument is the subject, classified as `16`, never
/// returned. A blank cell is treated as a number (`1`), matching Excel
/// (`TYPE(A1)` over an empty `A1` is `1`). The `64` (array) code cannot arise
/// here: the scalar door collapses a range to a single cell, so an inline
/// array argument is a T1-spill concern above this kernel; the code is
/// documented for completeness but unreachable through this path.
pub fn type_fn(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    let code = match subject(&args[0]) {
        // A blank cell classifies as a number in Excel's TYPE.
        CellValue::Number(_) | CellValue::Empty => 1.0,
        CellValue::Text(_) => 2.0,
        CellValue::Bool(_) => 4.0,
        CellValue::Error(_) => 16.0,
    };
    CellValue::Number(code)
}

/// `ERROR.TYPE(error_val)` — map an error value to its 1-based index
/// (ECMA-376 §18.17.7): `1` `#NULL!`, `2` `#DIV/0!`, `3` `#VALUE!`,
/// `4` `#REF!`, `5` `#NAME?`, `6` `#NUM!`, `7` `#N/A`, then Excel 365's
/// newer codes ([`CellError::type_number`]: `#SPILL!` 9 … `#CALC!` 14,
/// recorded against Excel). A **non-error** argument yields `#N/A` (Excel's
/// ruling — there is no error to index). Like `TYPE`, this **inspects**: the
/// error is the subject, never returned.
pub fn error_type(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    match subject(&args[0]) {
        CellValue::Error(e) => CellValue::Number(f64::from(e.type_number())),
        // A non-error subject has no error code.
        _ => CellValue::Error(CellError::Na),
    }
}

// `SHEET` / `SHEETS` read the workbook: evaluator special forms since W3
// (`sheet-calc/src/eval/info.rs`).

/// `ISNONTEXT(value)` — TRUE for anything but text: a number, a logical, a
/// blank, an error (Microsoft reference; Excel-recorded, `info3/isnontext`).
/// A reference reads its top-left cell.
pub fn isnontext(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    CellValue::Bool(!matches!(subject(&args[0]), CellValue::Text(_)))
}

/// `ISEVEN(number)` — `TRUE` iff the **truncated** number is even (ECMA-376
/// §18.17.7). The argument is coerced through [`coerce::to_number`] (so
/// numeric text like `"4"` works, `TRUE`→`1`, a blank→`0`), then truncated
/// toward zero; parity is tested on the integer part. Non-numeric text is
/// `#VALUE!`, and an error argument propagates (coercion contract).
pub fn iseven(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    match parity_is_odd(&subject(&args[0])) {
        Ok(is_odd) => CellValue::Bool(!is_odd),
        Err(e) => CellValue::Error(e),
    }
}

/// `ISODD(number)` — `TRUE` iff the **truncated** number is odd (ECMA-376
/// §18.17.7). The exact complement of [`iseven`]: same coercion, truncation,
/// and error rules; tests for an odd integer part.
pub fn isodd(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    match parity_is_odd(&subject(&args[0])) {
        Ok(is_odd) => CellValue::Bool(is_odd),
        Err(e) => CellValue::Error(e),
    }
}

/// Shared parity core for `ISEVEN`/`ISODD`: coerce to a number, truncate
/// toward zero, and report whether the integer part is odd. The truncation
/// uses `f64::trunc` (drop the fraction, keep the sign) — `ISODD(3.9)` is
/// `TRUE`, `ISEVEN(-2.5)` is `TRUE`. Parity is read off the low bit of the
/// truncated integer (computed in `i64`-safe space; magnitudes beyond `i64`
/// are even by construction since they are exact even doubles).
fn parity_is_odd(v: &CellValue) -> Result<bool, CellError> {
    // A logical is not coerced here (Excel 16: ISODD(TRUE) is #VALUE!).
    if matches!(v, CellValue::Bool(_)) {
        return Err(CellError::Value);
    }
    let x = coerce::to_number(v)?.trunc();
    // A truncated f64 with |x| ≥ 2^53 has no odd representable values (it is an
    // exact even integer), so the rem-2 test on the f64 is exact and total.
    Ok((x % 2.0).abs() == 1.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use compact_str::CompactString;
    use sheet_core::{CellRef, DateSystem};

    fn cr_at(sheet: u16, row: u32, col: u32) -> CellRef {
        CellRef {
            sheet,
            row,
            col,
            row_abs: false,
            col_abs: false,
        }
    }

    fn ctx() -> EvalCtx {
        EvalCtx::new(DateSystem::Date1900, cr_at(0, 0, 0), 45000.5, 42)
    }

    fn num(n: f64) -> CellValue {
        CellValue::Number(n)
    }
    fn txt(s: &str) -> CellValue {
        CellValue::from(s)
    }
    fn b(v: bool) -> CellValue {
        CellValue::Bool(v)
    }
    fn s(v: CellValue) -> Arg<'static> {
        Arg::Scalar(v)
    }

    #[test]
    fn n_coercions() {
        assert_eq!(n(&[s(num(7.0))], &ctx()), num(7.0));
        assert_eq!(n(&[s(b(true))], &ctx()), num(1.0));
        assert_eq!(n(&[s(b(false))], &ctx()), num(0.0));
        assert_eq!(n(&[s(CellValue::Empty)], &ctx()), num(0.0));
        // Excel ruling: text → 0, even numeric text (N does not parse it).
        assert_eq!(n(&[s(txt("7"))], &ctx()), num(0.0));
        assert_eq!(n(&[s(txt("hello"))], &ctx()), num(0.0));
    }

    #[test]
    fn n_propagates_error() {
        assert_eq!(
            n(&[s(CellValue::Error(CellError::Div0))], &ctx()),
            CellValue::Error(CellError::Div0)
        );
    }

    #[test]
    fn type_codes() {
        assert_eq!(type_fn(&[s(num(1.0))], &ctx()), num(1.0));
        assert_eq!(type_fn(&[s(txt("x"))], &ctx()), num(2.0));
        assert_eq!(type_fn(&[s(b(true))], &ctx()), num(4.0));
        // Inspects an error subject → 16 (never propagates).
        assert_eq!(
            type_fn(&[s(CellValue::Error(CellError::Na))], &ctx()),
            num(16.0)
        );
        // A blank cell classifies as a number.
        assert_eq!(type_fn(&[s(CellValue::Empty)], &ctx()), num(1.0));
    }

    #[test]
    fn error_type_indices() {
        assert_eq!(
            error_type(&[s(CellValue::Error(CellError::Null))], &ctx()),
            num(1.0)
        );
        assert_eq!(
            error_type(&[s(CellValue::Error(CellError::Div0))], &ctx()),
            num(2.0)
        );
        assert_eq!(
            error_type(&[s(CellValue::Error(CellError::Value))], &ctx()),
            num(3.0)
        );
        assert_eq!(
            error_type(&[s(CellValue::Error(CellError::Ref))], &ctx()),
            num(4.0)
        );
        assert_eq!(
            error_type(&[s(CellValue::Error(CellError::Name))], &ctx()),
            num(5.0)
        );
        assert_eq!(
            error_type(&[s(CellValue::Error(CellError::Num))], &ctx()),
            num(6.0)
        );
        assert_eq!(
            error_type(&[s(CellValue::Error(CellError::Na))], &ctx()),
            num(7.0)
        );
    }

    #[test]
    fn error_type_non_error_is_na() {
        assert_eq!(
            error_type(&[s(num(5.0))], &ctx()),
            CellValue::Error(CellError::Na)
        );
        assert_eq!(
            error_type(&[s(txt("x"))], &ctx()),
            CellValue::Error(CellError::Na)
        );
        // Excel 365's codes: #SPILL! 9, #CALC! 14.
        assert_eq!(
            error_type(&[s(CellValue::Error(CellError::Spill))], &ctx()),
            CellValue::Number(9.0)
        );
        assert_eq!(
            error_type(&[s(CellValue::Error(CellError::Calc))], &ctx()),
            CellValue::Number(14.0)
        );
    }

    #[test]
    fn iseven_isodd_basic_and_truncation() {
        assert_eq!(iseven(&[s(num(4.0))], &ctx()), b(true));
        assert_eq!(iseven(&[s(num(3.0))], &ctx()), b(false));
        assert_eq!(isodd(&[s(num(3.0))], &ctx()), b(true));
        assert_eq!(isodd(&[s(num(4.0))], &ctx()), b(false));
        // Truncation toward zero: 3.9 → 3 (odd), -2.5 → -2 (even).
        assert_eq!(isodd(&[s(num(3.9))], &ctx()), b(true));
        assert_eq!(iseven(&[s(num(-2.5))], &ctx()), b(true));
        // Zero is even.
        assert_eq!(iseven(&[s(num(0.0))], &ctx()), b(true));
    }

    #[test]
    fn iseven_isodd_coercion_and_errors() {
        // Numeric text coerces (the general to_number, unlike N).
        assert_eq!(iseven(&[s(txt("8"))], &ctx()), b(true));
        // A logical is not coerced (Excel 16: ISODD(TRUE) is #VALUE!).
        assert_eq!(
            isodd(&[s(b(true))], &ctx()),
            CellValue::Error(CellError::Value)
        );
        // Non-numeric text → #VALUE!.
        assert_eq!(
            iseven(&[s(txt("x"))], &ctx()),
            CellValue::Error(CellError::Value)
        );
        // An error argument propagates.
        assert_eq!(
            isodd(&[s(CellValue::Error(CellError::Ref))], &ctx()),
            CellValue::Error(CellError::Ref)
        );
    }

    #[test]
    fn range_arg_uses_top_left() {
        use crate::arg::RangeView;
        let cells = [
            CellValue::Text(CompactString::new("a")),
            CellValue::Number(2.0),
        ];
        let rv = RangeView::from_slice(cr_at(0, 0, 0), 1, 2, &cells);
        // Top-left is text → TYPE 2.
        assert_eq!(type_fn(&[Arg::Range(rv)], &ctx()), num(2.0));
    }
}
