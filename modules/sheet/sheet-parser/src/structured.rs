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

//! Structured (table) reference lexing (spec §6.4 / ECMA-376 §18.17.2.4,
//! Microsoft structured-reference syntax). A structured reference names an
//! Excel table region symbolically — `Table1[Col]`, `Table1[[#Headers],[Col]]`,
//! `Table1[[Col1]:[Col2]]`, the in-table `[@Col]`/`Table1[[#This Row],[Col]]`
//! forms — rather than by A1 geometry, so it is immune to structural rewrites.
//!
//! The bracket grammar is self-contained (it is not affected by operator
//! precedence), so the **lexer** consumes a whole structured reference into one
//! [`crate::lexer::TokKind::Structured`] token via [`lex_structured`]; the
//! parser then just lifts it into [`sheet_core::ast::Expr::StructuredRef`].
//! Printing (the inverse) lives in `print.rs` (frozen in M1 Phase A) — the
//! `parse ∘ print` fixpoint over these forms is property/golden tested.
//!
//! ## Grammar (the subset Excel emits, ECMA-376 §18.17.2.4)
//!
//! A structured ref is an optional table name immediately followed by a
//! bracketed *spec*:
//!
//! ```text
//! structured := table-name? "[" spec "]"
//! spec       := ""                       ; Table1[]       (the data body)
//!             | simple-column            ; Table1[Col]
//!             | area-keyword             ; Table1[#Totals]
//!             | "@" this-row             ; Table1[@Col]   (ThisRow shorthand)
//!             | items                    ; Table1[[#Headers],[Col]] etc.
//! this-row   := ""                       ; Table1[@]
//!             | simple-column            ; Table1[@Col]
//!             | "[" col "]"              ; Table1[@[Col Name]]
//!             | "[" col "]" ":" "[" col "]"  ; Table1[@[Jan]:[Mar]]
//! items      := (keyword ",")* keyword
//!             | (keyword ",")* "[" col "]" (":" "[" col "]")?
//! keyword    := "[" area-keyword "]"     ; [#All] [#Data] [#Headers] [#Totals]
//!             | "[" "#This Row" "]"      ; ThisRow (Excel 2007's spelling of `@`)
//! ```
//!
//! Spaces are allowed after a `[`, before a `]` and around `,` and `:`.
//!
//! ## Rulings (documented Excel-compat decisions, constitution §3)
//!
//! - **Column names may contain spaces and most punctuation.** In any column
//!   token the special characters `[ ] # ' @` are escaped with a leading `'`
//!   (ECMA-376 §18.17.2.4; Microsoft's structured-reference syntax rules); we
//!   un-escape on lex, and an unescaped one is a parse error. A *simple*
//!   column (no inner brackets, e.g. `Table1[Col]`) runs to the closing `]`.
//! - **A column is never empty.** `Table1[]` is the data body, but `[]` as a
//!   column (`Table1[[]]`, `[@[]]`, `[[A]:[]]`) is a parse error: Excel table
//!   headers are never empty.
//! - **`#This Row` and the `@` shorthand both mean [`TableArea::ThisRow`].**
//!   `@` only ever LEADS the spec (`[@Col]`, `[@[A]:[B]]`, `[@]`); it is not
//!   an item of a list. The bare-name `[@Col]` form (empty table name) is the
//!   in-table shorthand the printer round-trips; with a table name and `@` we
//!   keep the table name.
//! - **Items are comma-separated, the `#` specifiers first.** `[[#Headers],
//!   [Col]]`, never `[[Col],[#Headers]]` or `[[#Headers][Col]]`.
//! - **At most one column span.** Excel permits exactly one `[Col1]:[Col2]`
//!   span (plus an optional area keyword). More than two columns, or a span
//!   mixed with a third column, is a parse error.
//! - **At most one area keyword.** Two `#`-specifiers in one ref is an error.

use compact_str::CompactString;
use sheet_core::ast::{StructuredRef, TableArea};

use crate::error::ParseError;
use crate::lexer::TokKind;

/// Try to lex a structured reference starting at `start` in `src`. `table` is
/// the (already-consumed) table name preceding the `[` — empty for the bare
/// `[@Col]` / `[[#Headers],[Col]]` forms. `bracket_pos` is the byte offset of
/// the opening `[`. On success returns the token plus the byte offset just
/// past the closing `]`.
///
/// `start` is only used to anchor error spans at the reference's beginning.
pub(crate) fn lex_structured(
    src: &str,
    start: usize,
    table: &str,
    bracket_pos: usize,
) -> Result<(TokKind, usize), ParseError> {
    let bytes = src.as_bytes();
    debug_assert_eq!(bytes.get(bracket_pos), Some(&b'['));

    // Find the matching closing `]` for the OUTER bracket, honoring `'`-escapes
    // and nested `[ ]` (a bracketed item list). The outer span is everything
    // between the outer `[` and its matching `]`.
    let body_start = bracket_pos + 1;
    let mut i = body_start;
    let mut depth = 1usize;
    while i < bytes.len() {
        match bytes[i] {
            b'\'' => {
                // Escape: the next byte is literal, skip both.
                i += 2;
                continue;
            }
            b'[' => depth += 1,
            b']' => {
                depth -= 1;
                if depth == 0 {
                    break;
                }
            }
            _ => {}
        }
        i += 1;
    }
    if depth != 0 {
        return Err(ParseError::new(
            "unterminated structured reference (missing ']')",
            start..src.len(),
        ));
    }
    let body = &src[body_start..i];
    let end = i + 1; // past the closing ']'

    let sref = parse_spec(body, table, start..end)?;
    Ok((TokKind::Structured(sref), end))
}

/// Parse the inner *spec* (the text between the outer `[ ]`) into a
/// [`StructuredRef`]. `span` is the whole reference's span (for errors).
fn parse_spec(
    body: &str,
    table: &str,
    span: std::ops::Range<usize>,
) -> Result<StructuredRef, ParseError> {
    let trimmed = body.trim();

    // Empty body `Table1[]` → the whole Data body (no column span).
    if trimmed.is_empty() {
        return Ok(StructuredRef {
            table: table.into(),
            area: TableArea::Data,
            col_start: None,
            col_end: None,
        });
    }

    // The `@` ThisRow shorthand: `[@Col]`, `[@[Col Name]]`, or `[@]`.
    if let Some(rest) = trimmed.strip_prefix('@') {
        return parse_thisrow_shorthand(rest, table, span);
    }

    // A bracketed item list `[..],[..]` (or a single bracketed item). The body
    // begins with `[` exactly when items are individually bracketed.
    if trimmed.starts_with('[') {
        return parse_item_list(trimmed, table, span);
    }

    // Otherwise the body is a SIMPLE token: either a bare `#`-area keyword
    // (`Table1[#Totals]`) or a simple column name (`Table1[Col]`).
    if let Some(area) = area_keyword(trimmed) {
        return Ok(StructuredRef {
            table: table.into(),
            area,
            col_start: None,
            col_end: None,
        });
    }
    // A simple column: un-escape and store as the Data-area single column.
    Ok(StructuredRef {
        table: table.into(),
        area: TableArea::Data,
        col_start: Some(column_name(trimmed, &span)?),
        col_end: None,
    })
}

/// Parse the `@…` ThisRow shorthand body (text after the leading `@`). `rest`
/// may be a bare column (`@Col`), a bracketed column (`@[Col Name]`), a
/// bracketed column span (`@[Jan]:[Mar]` — Excel's this-row column range),
/// or empty (`@`).
fn parse_thisrow_shorthand(
    rest: &str,
    table: &str,
    span: std::ops::Range<usize>,
) -> Result<StructuredRef, ParseError> {
    let rest = rest.trim();
    let (col_start, col_end) = if rest.is_empty() {
        (None, None)
    } else if rest.starts_with('[') {
        // `@[Col Name]`, or the span `@[Col1]:[Col2]`.
        let (first, second) = match split_span(rest) {
            Some((l, r)) => (l, Some(r)),
            None => (rest, None),
        };
        let c0 = one_column(split_items(first, &span)?, "`@`", &span)?;
        let c1 = second
            .map(|r| one_column(split_items(r, &span)?, "a span's right side", &span))
            .transpose()?;
        (Some(c0), c1)
    } else {
        // `@Col` — a bare simple column.
        (Some(column_name(rest, &span)?), None)
    };
    Ok(StructuredRef {
        table: table.into(),
        area: TableArea::ThisRow,
        col_start,
        col_end,
    })
}

/// One parsed bracketed item.
enum Item {
    /// `[#All]`, `[#Data]`, `[#Headers]`, `[#Totals]`, `[#This Row]`.
    Area(TableArea),
    /// A column name (un-escaped).
    Column(CompactString),
}

/// Parse a bracketed item list `[..],[..]` (optionally with one `:` span) into
/// a [`StructuredRef`].
fn parse_item_list(
    body: &str,
    table: &str,
    span: std::ops::Range<usize>,
) -> Result<StructuredRef, ParseError> {
    // A column span uses `:` BETWEEN two bracketed columns: `[A]:[B]`. Detect a
    // top-level `:` separating two bracketed items (not inside a `[ ]`).
    if let Some((lhs, rhs)) = split_span(body) {
        let left = split_items(lhs, &span)?;
        let right = split_items(rhs, &span)?;
        // The left side may carry an optional leading area keyword; the right
        // side must be exactly one column.
        let (area, c0) = take_area_and_one_col(left, &span)?;
        let c1 = one_column(right, "a span's right side", &span)?;
        return Ok(StructuredRef {
            table: table.into(),
            area,
            col_start: Some(c0),
            col_end: Some(c1),
        });
    }

    // No span: a comma-separated list of items. Fold an optional area keyword
    // plus at most one column.
    let items = split_items(body, &span)?;
    fold_items(items, table, span)
}

/// Fold a flat (no-span) item list into a [`StructuredRef`]: at most one area
/// keyword and at most one column.
fn fold_items(
    items: Vec<Item>,
    table: &str,
    span: std::ops::Range<usize>,
) -> Result<StructuredRef, ParseError> {
    let mut area: Option<TableArea> = None;
    let mut col: Option<CompactString> = None;
    for it in items {
        match it {
            Item::Area(_) if col.is_some() => return Err(keyword_after_column(&span)),
            Item::Area(a) => set_area(&mut area, a, &span)?,
            Item::Column(c) => {
                if col.is_some() {
                    return Err(ParseError::new(
                        "structured reference has more than one column (use a span `[A]:[B]`)",
                        span,
                    ));
                }
                col = Some(c);
            }
        }
    }
    Ok(StructuredRef {
        table: table.into(),
        area: area.unwrap_or(TableArea::Data),
        col_start: col,
        col_end: None,
    })
}

/// Set the (single) area keyword, erroring on a second one.
fn set_area(
    slot: &mut Option<TableArea>,
    a: TableArea,
    span: &std::ops::Range<usize>,
) -> Result<(), ParseError> {
    *slot = Some(match *slot {
        None => a,
        Some(prev) => combine_areas(prev, a).ok_or_else(|| {
            ParseError::new(
                "structured reference has an unsupported #-area combination \
                 (only [#Headers],[#Data] and [#Data],[#Totals])",
                span.clone(),
            )
        })?,
    });
    Ok(())
}

/// The two-area specifiers Excel accepts, in either order: `[#Headers],[#Data]`
/// and `[#Data],[#Totals]`. Every other pair (including a repeat) is refused.
fn combine_areas(a: TableArea, b: TableArea) -> Option<TableArea> {
    use TableArea::*;
    match (a, b) {
        (Headers, Data) | (Data, Headers) => Some(HeadersData),
        (Data, Totals) | (Totals, Data) => Some(DataTotals),
        _ => None,
    }
}

/// From the LEFT side of a span: an optional area keyword plus exactly one
/// column endpoint.
fn take_area_and_one_col(
    items: Vec<Item>,
    span: &std::ops::Range<usize>,
) -> Result<(TableArea, CompactString), ParseError> {
    let mut area: Option<TableArea> = None;
    let mut col: Option<CompactString> = None;
    for it in items {
        match it {
            Item::Area(_) if col.is_some() => return Err(keyword_after_column(span)),
            Item::Area(a) => set_area(&mut area, a, span)?,
            Item::Column(c) => {
                if col.is_some() {
                    return Err(ParseError::new(
                        "structured reference span left side has two columns",
                        span.clone(),
                    ));
                }
                col = Some(c);
            }
        }
    }
    match col {
        Some(c) => Ok((area.unwrap_or(TableArea::Data), c)),
        None => Err(ParseError::new(
            "structured reference span is missing its first column",
            span.clone(),
        )),
    }
}

/// A `#` specifier after a column: Excel lists the specifiers first.
fn keyword_after_column(span: &std::ops::Range<usize>) -> ParseError {
    ParseError::new(
        "structured reference lists its #-specifiers before its columns",
        span.clone(),
    )
}

/// Exactly one column, no area keyword: the right side of a span, or what
/// follows `@`. `what` names the position for the error.
fn one_column(
    items: Vec<Item>,
    what: &str,
    span: &std::ops::Range<usize>,
) -> Result<CompactString, ParseError> {
    let mut items = items.into_iter();
    match (items.next(), items.next()) {
        (Some(Item::Column(c)), None) => Ok(c),
        _ => Err(ParseError::new(
            format!("structured reference: {what} must be a single column"),
            span.clone(),
        )),
    }
}

/// Split a bracketed-item body into its [`Item`]s: `[ ... ]` groups
/// separated by single commas, with optional spaces around them. An empty
/// body yields no items (the caller decides whether that is allowed).
fn split_items(body: &str, span: &std::ops::Range<usize>) -> Result<Vec<Item>, ParseError> {
    let bytes = body.as_bytes();
    let skip_ws = |mut i: usize| {
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        i
    };
    let mut items = Vec::new();
    let mut i = skip_ws(0);
    if i >= bytes.len() {
        return Ok(items);
    }
    loop {
        if bytes.get(i) != Some(&b'[') {
            return Err(ParseError::new(
                "expected `[` to start a structured-reference item",
                span.clone(),
            ));
        }
        // Consume one `[ ... ]` group, honoring `'`-escapes.
        i += 1;
        let inner_start = i;
        while i < bytes.len() {
            match bytes[i] {
                b'\'' => {
                    i += 2;
                    continue;
                }
                b']' => break,
                _ => {}
            }
            i += 1;
        }
        if i >= bytes.len() {
            return Err(ParseError::new(
                "unterminated structured-reference item (missing ']')",
                span.clone(),
            ));
        }
        items.push(parse_item(&body[inner_start..i], span)?);
        i = skip_ws(i + 1);
        if i >= bytes.len() {
            return Ok(items);
        }
        if bytes[i] != b',' {
            return Err(ParseError::new(
                "expected `,` between structured-reference items",
                span.clone(),
            ));
        }
        i = skip_ws(i + 1);
    }
}

/// Parse one bracketed item's inner text (already without its `[ ]`).
fn parse_item(inner: &str, span: &std::ops::Range<usize>) -> Result<Item, ParseError> {
    let t = inner.trim();
    if let Some(area) = area_keyword(t) {
        // `#This Row` is its own ThisRow area; the others map directly.
        return Ok(Item::Area(area));
    }
    Ok(Item::Column(column_name(t, span)?))
}

/// Find a TOP-LEVEL `:` span separator (between two bracketed groups), if any.
/// Returns the `(left, right)` substrings. A `:` inside a `[ ]` group (a column
/// name may contain `:`) is ignored.
fn split_span(body: &str) -> Option<(&str, &str)> {
    let bytes = body.as_bytes();
    let mut i = 0;
    let mut in_group = false;
    while i < bytes.len() {
        match bytes[i] {
            b'\'' if in_group => {
                i += 2;
                continue;
            }
            b'[' => in_group = true,
            b']' => in_group = false,
            b':' if !in_group => {
                return Some((&body[..i], &body[i + 1..]));
            }
            _ => {}
        }
        i += 1;
    }
    None
}

/// Map a `#`-area keyword spelling to its [`TableArea`] (case-insensitive;
/// `#This Row` tolerates collapsed internal whitespace). `None` if the text is
/// not a `#`-keyword (so it must be a column name).
fn area_keyword(s: &str) -> Option<TableArea> {
    let s = s.trim();
    if !s.starts_with('#') {
        return None;
    }
    let body = &s[1..];
    if body.eq_ignore_ascii_case("All") {
        Some(TableArea::All)
    } else if body.eq_ignore_ascii_case("Data") {
        Some(TableArea::Data)
    } else if body.eq_ignore_ascii_case("Headers") {
        Some(TableArea::Headers)
    } else if body.eq_ignore_ascii_case("Totals") {
        Some(TableArea::Totals)
    } else if is_this_row(body) {
        Some(TableArea::ThisRow)
    } else {
        // An unknown `#`-keyword: still not a column (column names cannot start
        // with `#` unescaped). Treat as ThisRow only for the exact spelling;
        // otherwise None lets the caller surface a column-name path, which for
        // a leading `#` is itself invalid — but Excel only emits the five.
        None
    }
}

/// True for `This Row` ignoring case and internal whitespace runs.
fn is_this_row(body: &str) -> bool {
    let collapsed: String = body.split_whitespace().collect::<Vec<_>>().join(" ");
    collapsed.eq_ignore_ascii_case("This Row")
}

/// A structured-ref column name from its token text: a `'` escapes the next
/// character (`'[`, `']`, `'#`, `''`, `'@`), and those five characters are
/// errors unescaped (Microsoft's structured-reference syntax rules).
/// Surrounding whitespace is trimmed; INNER spaces are preserved (column
/// names may contain spaces). An empty name is an error: a table header is
/// never empty.
fn column_name(s: &str, span: &std::ops::Range<usize>) -> Result<CompactString, ParseError> {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.trim().chars();
    while let Some(c) = chars.next() {
        match c {
            '\'' => match chars.next() {
                Some(n) => out.push(n),
                None => {
                    return Err(ParseError::new(
                        "a `'` in a column name escapes the character after it",
                        span.clone(),
                    ))
                }
            },
            '[' | ']' | '#' | '@' => {
                return Err(ParseError::new(
                    format!("`{c}` in a column name needs a `'` before it"),
                    span.clone(),
                ))
            }
            _ => out.push(c),
        }
    }
    let name = out.trim();
    if name.is_empty() {
        return Err(ParseError::new(
            "a structured reference names an empty column",
            span.clone(),
        ));
    }
    Ok(CompactString::new(name))
}
