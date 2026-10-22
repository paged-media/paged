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

//! The information functions that read the workbook (W3): `SHEET`,
//! `SHEETS`, `CELL`, `INFO` and `ISOMITTED` are evaluator special forms —
//! they need the sheet list, a cell's style, the column widths, the
//! calculation settings or the unevaluated argument, none of which a pure
//! kernel sees. Excel-recorded (`corpus/fn-corpus/info3`).
//!
//! ## Rulings
//!
//! - **SHEET** with no argument is the formula's sheet, a reference (3D: its
//!   first sheet) its sheet, a text a sheet name (case-insensitive) or
//!   `#N/A`, any other value `#N/A`. **SHEETS** with no argument counts the
//!   workbook's sheets; a 3D reference counts its span, any other reference 1,
//!   a value `#N/A`. Positions are 1-based in workbook order.
//! - **CELL(info_type, [reference])** reads the top-left cell of the
//!   reference (no reference: the formula's own cell — Excel uses the last
//!   changed cell, which a recalculation engine does not track). `contents`
//!   of a blank is 0; `type` is `b`/`l`/`v`; `format` is Excel's code
//!   (`G`, `F2`, `,0`, `C2-`, `P0`, `S2`, `D1`…`D9`, `()` for parenthesised
//!   positives); `width` spills `{width, is_default}` (whole characters,
//!   8 for the default 8.43); `filename` is `[document]sheet` when the host
//!   named the document, `""` otherwise (Excel: an unsaved workbook);
//!   `protect` is 1 (cells are locked by default and the engine has no
//!   unlocked style). An unknown type is `#VALUE!`.
//! - **INFO** answers for the engine, not the machine: `numfile` is the
//!   sheet count, `recalc` the calculation mode, `release` `16.0`, `system`
//!   `pcdos`, `origin` `$A:$A$1`, `directory` `""`, `osversion` `Paged`.
//! - **ISOMITTED(x)** is TRUE when `x` is a LAMBDA parameter whose argument
//!   was left empty (`LAMBDA(a,b,ISOMITTED(b))(1,)`); anything else is FALSE.

use sheet_core::ast::Expr;
use sheet_core::calc_settings::CalcMode;
use sheet_core::refs::format_a1;
use sheet_core::{CellError, CellRef, CellValue, SheetModel};
use sheet_fn::{EvalCtx, FnResult};

use super::{eval, eval_as_ref};
use crate::argview;
use crate::spill::SpillState;

fn err(e: CellError) -> CellValue {
    CellValue::Error(e)
}

/// `SHEET([value])`.
pub(super) fn sheet(
    model: &SheetModel,
    args: &[Expr],
    ctx: &EvalCtx,
    spills: &SpillState,
) -> CellValue {
    let Some(arg) = args.first().filter(|a| !matches!(a, Expr::Missing)) else {
        return CellValue::Number(f64::from(ctx.current.sheet) + 1.0);
    };
    match arg {
        Expr::Ref3D(r) => return CellValue::Number(f64::from(r.sheets.first) + 1.0),
        Expr::Range3D(r) => return CellValue::Number(f64::from(r.sheets.first) + 1.0),
        _ => {}
    }
    if let Some(r) = eval_as_ref(model, arg, ctx, spills) {
        return CellValue::Number(f64::from(r.start.sheet) + 1.0);
    }
    match eval(model, arg, ctx, spills) {
        CellValue::Error(e) => err(e),
        CellValue::Text(t) => match model.sheets.iter().position(|ws| {
            ws.name.eq_ignore_ascii_case(&t) || ws.name.to_lowercase() == t.to_lowercase()
        }) {
            Some(i) => CellValue::Number(i as f64 + 1.0),
            None => err(CellError::Na),
        },
        _ => err(CellError::Na),
    }
}

/// `SHEETS([reference])`.
pub(super) fn sheets(
    model: &SheetModel,
    args: &[Expr],
    ctx: &EvalCtx,
    spills: &SpillState,
) -> CellValue {
    let Some(arg) = args.first().filter(|a| !matches!(a, Expr::Missing)) else {
        return CellValue::Number(model.sheets.len() as f64);
    };
    match arg {
        Expr::Ref3D(r) => {
            return CellValue::Number(f64::from(r.sheets.last) - f64::from(r.sheets.first) + 1.0)
        }
        Expr::Range3D(r) => {
            return CellValue::Number(f64::from(r.sheets.last) - f64::from(r.sheets.first) + 1.0)
        }
        _ => {}
    }
    if eval_as_ref(model, arg, ctx, spills).is_some() {
        return CellValue::Number(1.0);
    }
    match eval(model, arg, ctx, spills) {
        CellValue::Error(e) => err(e),
        _ => err(CellError::Na),
    }
}

/// `ISOMITTED(argument)`.
pub(super) fn isomitted(args: &[Expr]) -> CellValue {
    CellValue::Bool(matches!(args.first(), Some(Expr::Missing)))
}

fn text_arg(
    model: &SheetModel,
    e: &Expr,
    ctx: &EvalCtx,
    spills: &SpillState,
) -> Result<String, CellError> {
    match eval(model, e, ctx, spills) {
        CellValue::Text(t) => Ok(t.to_lowercase().to_string()),
        CellValue::Error(e) => Err(e),
        _ => Err(CellError::Value),
    }
}

/// `INFO(type_text)`.
pub(super) fn info(
    model: &SheetModel,
    args: &[Expr],
    ctx: &EvalCtx,
    spills: &SpillState,
) -> CellValue {
    let t = match text_arg(model, &args[0], ctx, spills) {
        Ok(t) => t,
        Err(e) => return err(e),
    };
    let text = |s: &str| CellValue::Text(s.into());
    match t.as_str() {
        "numfile" => CellValue::Number(model.sheets.len() as f64),
        "recalc" => text(match model.calc.calc_mode {
            CalcMode::Manual => "Manual",
            _ => "Automatic",
        }),
        "release" => text("16.0"),
        "system" => text("pcdos"),
        "origin" => text("$A:$A$1"),
        "directory" => text(""),
        "osversion" => text("Paged"),
        _ => err(CellError::Value),
    }
}

/// A sheet name as it appears in a reference (quoted when needed).
fn sheet_ref_name(name: &str) -> String {
    let plain = name
        .chars()
        .all(|c| c.is_alphanumeric() || c == '_' || c == '.')
        && !name.chars().next().is_some_and(|c| c.is_ascii_digit())
        && sheet_core::refs::parse_a1(name).is_none();
    if plain {
        name.to_string()
    } else {
        format!("'{}'", name.replace('\'', "''"))
    }
}

/// Excel's `CELL("format")` code for a number format.
pub(crate) fn format_code(fmt: &str) -> String {
    let sections: Vec<&str> = split_sections(fmt);
    let first = sections.first().copied().unwrap_or("General");
    // Strip quoted literals and escapes to read the tokens.
    let bare = strip_literals(first);
    let lower = bare.to_lowercase();
    let neg_colour = sections
        .get(1)
        .is_some_and(|s| s.contains('[') && !s.trim_start().starts_with("[$"));
    let parens = first.contains('(');
    let suffix = format!(
        "{}{}",
        if neg_colour { "-" } else { "" },
        if parens { "()" } else { "" }
    );
    if lower.trim().is_empty() || lower.contains("general") || lower.trim() == "@" {
        return format!("G{suffix}");
    }
    // Dates and times.
    let has = |t: &str| lower.contains(t);
    if has("y") || has("d") || (has("m") && !has("e")) || has("h") || has("s") {
        let code = if has("h") {
            let secs = has("s");
            let ampm = has("am/pm") || has("a/p");
            match (ampm, secs) {
                (true, true) => "D6",
                (true, false) => "D7",
                (false, true) => "D8",
                (false, false) => "D9",
            }
        } else if has("mmm") && has("yy") && !has("d") {
            "D3"
        } else if has("mmm") && has("d") && has("yy") {
            "D1"
        } else if has("mmm") && has("d") {
            "D2"
        } else if has("/") && !has("y") {
            "D5"
        } else {
            "D4"
        };
        return code.to_string();
    }
    if lower.contains('?') && lower.contains('/') {
        return format!("G{suffix}");
    }
    let decimals = match bare.find('.') {
        Some(p) => bare[p + 1..]
            .chars()
            .take_while(|c| matches!(c, '0' | '#' | '?'))
            .count(),
        None => 0,
    };
    let kind = if lower.contains('%') {
        "P"
    } else if lower.contains("e+") || lower.contains("e-") {
        "S"
    } else if first.contains('$')
        || first.contains("[$")
        || first.contains('€')
        || first.contains('£')
    {
        "C"
    } else if bare.contains(',') {
        ","
    } else {
        "F"
    };
    format!("{kind}{decimals}{suffix}")
}

fn split_sections(fmt: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let (mut start, mut in_q, mut esc) = (0, false, false);
    for (i, c) in fmt.char_indices() {
        if esc {
            esc = false;
            continue;
        }
        match c {
            '\\' => esc = true,
            '"' => in_q = !in_q,
            ';' if !in_q => {
                out.push(&fmt[start..i]);
                start = i + 1;
            }
            _ => {}
        }
    }
    out.push(&fmt[start..]);
    out
}

fn strip_literals(s: &str) -> String {
    let mut out = String::new();
    let (mut in_q, mut esc, mut in_b) = (false, false, false);
    for c in s.chars() {
        if esc {
            esc = false;
            continue;
        }
        match c {
            '\\' if !in_q => esc = true,
            '"' => in_q = !in_q,
            '[' if !in_q => in_b = true,
            ']' if in_b => in_b = false,
            '_' | '*' if !in_q && !in_b => esc = true,
            _ if in_q || in_b => {}
            _ => out.push(c),
        }
    }
    out
}

/// The default column width (characters) of a sheet without a stored one.
const DEFAULT_WIDTH: f64 = 8.43;

/// `CELL(info_type, [reference])` through the rich door (`width` spills).
pub(super) fn cell_rich(
    model: &SheetModel,
    args: &[Expr],
    ctx: &EvalCtx,
    spills: &SpillState,
) -> FnResult {
    let s = |v: CellValue| FnResult::Scalar(v);
    let t = match text_arg(model, &args[0], ctx, spills) {
        Ok(t) => t,
        Err(e) => return s(err(e)),
    };
    let target: CellRef = match args.get(1).filter(|a| !matches!(a, Expr::Missing)) {
        None => ctx.current,
        Some(e) => match eval_as_ref(model, e, ctx, spills) {
            Some(r) => r.normalized().start,
            None => {
                return s(match eval(model, e, ctx, spills) {
                    CellValue::Error(x) => err(x),
                    _ => err(CellError::Value),
                })
            }
        },
    };
    let ws = model.sheet(target.sheet);
    let cell = ws.and_then(|w| w.cell(target.row, target.col));
    let value = argview::cell_value(model, target);
    let style = cell.map(|c| c.style).unwrap_or_default();
    let fmt = model.styles.num_fmt_of(style);
    let num = |x: u32| s(CellValue::Number(f64::from(x)));
    let text = |x: String| s(CellValue::Text(x.into()));
    match t.as_str() {
        "address" => {
            let a1 = format_a1(target.row, target.col, true, true);
            if target.sheet == ctx.current.sheet {
                text(a1.to_string())
            } else {
                let name = ws.map(|w| w.name.to_string()).unwrap_or_default();
                let book = model
                    .document_name
                    .as_ref()
                    .map(|d| format!("[{d}]"))
                    .unwrap_or_default();
                let sheet = if book.is_empty() {
                    sheet_ref_name(&name)
                } else {
                    format!("{book}{name}")
                };
                text(format!("{sheet}!{a1}"))
            }
        }
        "col" => num(target.col + 1),
        "row" => num(target.row + 1),
        "contents" => s(match value {
            CellValue::Empty => CellValue::Number(0.0),
            v => v,
        }),
        "type" => text(
            match value {
                CellValue::Empty => "b",
                CellValue::Text(_) => "l",
                _ => "v",
            }
            .to_string(),
        ),
        "format" => text(format_code(fmt)),
        "color" => num(u32::from(format_code(fmt).contains('-'))),
        "parentheses" => num(u32::from(format_code(fmt).ends_with("()"))),
        "prefix" => text(match value {
            CellValue::Text(_) => match model.styles.style(style).align {
                sheet_core::style::Align::Right => "\"",
                sheet_core::style::Align::Center => "^",
                _ => "'",
            }
            .to_string(),
            _ => String::new(),
        }),
        "protect" => num(1),
        "width" => {
            let stored = ws.and_then(|w| w.col_widths.get(&target.col).copied());
            let w = stored.unwrap_or(DEFAULT_WIDTH);
            FnResult::Array(vec![vec![
                CellValue::Number(w.trunc()),
                CellValue::Bool(stored.is_none()),
            ]])
        }
        "filename" => text(match (&model.document_name, ws) {
            (Some(d), Some(w)) => format!("[{d}]{}", w.name),
            _ => String::new(),
        }),
        _ => s(err(CellError::Value)),
    }
}

#[cfg(test)]
mod tests {
    use super::format_code;

    #[test]
    fn cell_format_codes() {
        assert_eq!(format_code("General"), "G");
        assert_eq!(format_code("0"), "F0");
        assert_eq!(format_code("0.00"), "F2");
        assert_eq!(format_code("#,##0"), ",0");
        assert_eq!(format_code("#,##0.00"), ",2");
        assert_eq!(format_code("0%"), "P0");
        assert_eq!(format_code("0.00%"), "P2");
        assert_eq!(format_code("0.00E+00"), "S2");
        assert_eq!(format_code("$#,##0_);($#,##0)"), "C0");
        assert_eq!(format_code("$#,##0.00_);[Red]($#,##0.00)"), "C2-");
        assert_eq!(format_code("m/d/yy"), "D4");
        assert_eq!(format_code("d-mmm-yy"), "D1");
        assert_eq!(format_code("d-mmm"), "D2");
        assert_eq!(format_code("mmm-yy"), "D3");
        assert_eq!(format_code("mm/dd"), "D5");
        assert_eq!(format_code("h:mm AM/PM"), "D7");
        assert_eq!(format_code("h:mm:ss AM/PM"), "D6");
        assert_eq!(format_code("h:mm"), "D9");
        assert_eq!(format_code("h:mm:ss"), "D8");
        assert_eq!(format_code("(0.00)"), "F2()");
    }
}
