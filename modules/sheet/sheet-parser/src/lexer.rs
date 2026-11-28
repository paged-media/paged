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

//! The formula lexer (spec §6.1). Turns Excel-dialect formula text (without
//! the leading `=`) into a flat token stream. Whitespace is NOT a token: the
//! space-as-intersection operator (ECMA-376 §18.17.2) is reconstructed by
//! the parser from each token's `ws_before` flag — a space is significant
//! only *between* two operand tokens, which only the grammar can decide.
//!
//! Numbers, double-quoted strings (with `""` escapes), `TRUE`/`FALSE`, the
//! eight error literals, A1 references with `$` flags, sheet-qualified and
//! `'quoted''sheet'`-qualified references, and identifiers (a name, or a
//! function iff immediately followed by `(`) are all recognized here. A name
//! is letters of any script, digits, `_` and `.` (`Übersicht!A1`, `Größe`),
//! as in Excel.

use std::ops::Range;

use crate::error::ParseError;

/// A lexical token plus its byte span and whether whitespace preceded it.
#[derive(Clone, Debug, PartialEq)]
pub struct Token {
    pub kind: TokKind,
    pub span: Range<usize>,
    /// True if one or more ASCII whitespace chars immediately preceded this
    /// token. The parser uses this to detect the intersection operator.
    pub ws_before: bool,
}

/// The lexical token kinds.
#[derive(Clone, Debug, PartialEq)]
pub enum TokKind {
    /// A numeric literal (already parsed to f64; covers `1.5E-3`).
    Number(f64),
    /// A string literal (with `""` un-escaped to `"`).
    Str(String),
    /// A boolean literal `TRUE`/`FALSE` (case-insensitive).
    Bool(bool),
    /// An error literal, e.g. `#DIV/0!`. Carries the parsed `CellError`.
    Error(sheet_core::CellError),
    /// A bare A1 cell token, e.g. `$B$7` — column/row + `$` flags, no sheet.
    Cell {
        row: u32,
        col: u32,
        row_abs: bool,
        col_abs: bool,
    },
    /// A sheet qualifier `Sheet1!` or `'Quoted''Name'!` (un-escaped name).
    /// Always immediately followed (no whitespace) by a `Cell`, `Cols` or `Rows`.
    SheetQual(String),
    /// A whole-column range `A:C` / `$A:$A` (0-based columns + `$` flags of
    /// each endpoint). Lexed as ONE token: `A` alone is not a reference.
    Cols {
        c0: u32,
        c1: u32,
        abs0: bool,
        abs1: bool,
    },
    /// A whole-row range `1:3` / `$1:$1` (0-based rows + `$` flags).
    Rows {
        r0: u32,
        r1: u32,
        abs0: bool,
        abs1: bool,
    },
    /// An identifier: a defined-name or a function name. The parser decides
    /// which by peeking for a following `(`.
    Ident(String),
    /// A whole structured (table) reference (spec §6.4): the bracket grammar is
    /// self-contained, so the lexer consumes `Table1[Col]`, `[[#Headers],[Col]]`,
    /// `[@Col]`, etc. into one token built by [`crate::structured`].
    Structured(sheet_core::ast::StructuredRef),
    /// The postfix spill operator `#` (`A1#` → the anchor's spill range).
    Hash,
    /// The prefix implicit-intersection operator `@` (`@A1:A3`).
    At,
    LParen,
    RParen,
    LBrace,
    RBrace,
    Comma,
    Semicolon,
    Colon,
    Plus,
    Minus,
    Star,
    Slash,
    Caret,
    Amp,
    Percent,
    Eq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
}

/// Tokenize `input` (formula text without the leading `=`).
pub fn lex(input: &str) -> Result<Vec<Token>, ParseError> {
    Lexer {
        src: input,
        bytes: input.as_bytes(),
        pos: 0,
    }
    .run()
}

struct Lexer<'a> {
    src: &'a str,
    bytes: &'a [u8],
    pos: usize,
}

impl Lexer<'_> {
    fn run(mut self) -> Result<Vec<Token>, ParseError> {
        let mut out = Vec::new();
        loop {
            let ws_before = self.skip_ws();
            if self.pos >= self.bytes.len() {
                break;
            }
            let start = self.pos;
            let kind = self.next_token()?;
            out.push(Token {
                kind,
                span: start..self.pos,
                ws_before,
            });
        }
        Ok(out)
    }

    /// Advance over ASCII whitespace; return whether any was consumed.
    fn skip_ws(&mut self) -> bool {
        let start = self.pos;
        while self.pos < self.bytes.len() && self.bytes[self.pos].is_ascii_whitespace() {
            self.pos += 1;
        }
        self.pos != start
    }

    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.pos).copied()
    }

    /// The character starting at byte `i` (a character boundary).
    fn char_at(&self, i: usize) -> Option<char> {
        match self.bytes.get(i) {
            Some(&b) if b < 0x80 => Some(b as char),
            Some(_) => self.src[i..].chars().next(),
            None => None,
        }
    }

    /// The end of the run of name characters starting at byte `i`, with `$`
    /// counted in when `dollar` (the `$B$7` form of a cell).
    fn name_run(&self, mut i: usize, dollar: bool) -> usize {
        while let Some(c) = self.char_at(i) {
            if is_name_char(c) || (dollar && c == '$') {
                i += c.len_utf8();
            } else {
                break;
            }
        }
        i
    }

    fn next_token(&mut self) -> Result<TokKind, ParseError> {
        let b = self.bytes[self.pos];
        if matches!(b, b'$' | b'0'..=b'9' | b'A'..=b'Z' | b'a'..=b'z') {
            if let Some(k) = self.whole_band() {
                return Ok(k);
            }
        }
        match b {
            b'"' => self.lex_string(),
            // `#` begins an error literal (`#DIV/0!`, `#N/A`, …) — all of
            // which are `#` + an ASCII letter — OR is the postfix spill
            // operator (`A1#`) when not so followed. The parser turns a
            // trailing `Hash` into `Expr::SpillRef`.
            b'#' if self
                .bytes
                .get(self.pos + 1)
                .is_some_and(u8::is_ascii_alphabetic) =>
            {
                self.lex_error_literal()
            }
            b'#' => self.one(TokKind::Hash),
            b'\'' => self.lex_quoted_sheet(),
            b'0'..=b'9' => self.lex_number(),
            b'.' if self.bytes.get(self.pos + 1).is_some_and(u8::is_ascii_digit) => {
                self.lex_number()
            }
            b'(' => self.one(TokKind::LParen),
            b')' => self.one(TokKind::RParen),
            b'{' => self.one(TokKind::LBrace),
            b'}' => self.one(TokKind::RBrace),
            // A leading `[` begins a no-table structured reference (`[@Col]`,
            // `[[#Headers],[Col]]`, `[Col]`) — anchored to the formula's own
            // table in eval (spec §6.4).
            b'[' => match self.external_sheet_qual() {
                Some(k) => Ok(k),
                None => self.lex_bare_structured(),
            },
            b',' => self.one(TokKind::Comma),
            b';' => self.one(TokKind::Semicolon),
            b':' => self.one(TokKind::Colon),
            b'+' => self.one(TokKind::Plus),
            b'-' => self.one(TokKind::Minus),
            b'*' => self.one(TokKind::Star),
            b'/' => self.one(TokKind::Slash),
            b'^' => self.one(TokKind::Caret),
            b'&' => self.one(TokKind::Amp),
            b'%' => self.one(TokKind::Percent),
            b'@' => self.one(TokKind::At),
            b'=' => self.one(TokKind::Eq),
            b'<' => {
                self.pos += 1;
                match self.peek() {
                    Some(b'=') => {
                        self.pos += 1;
                        Ok(TokKind::Le)
                    }
                    Some(b'>') => {
                        self.pos += 1;
                        Ok(TokKind::Ne)
                    }
                    _ => Ok(TokKind::Lt),
                }
            }
            b'>' => {
                self.pos += 1;
                if self.peek() == Some(b'=') {
                    self.pos += 1;
                    Ok(TokKind::Ge)
                } else {
                    Ok(TokKind::Gt)
                }
            }
            // `$` or a letter begins a cell ref or an identifier.
            b'$' | b'A'..=b'Z' | b'a'..=b'z' | b'_' => self.lex_ref_or_ident(),
            // So does a letter of any other script (`Übersicht!A1`, `Größe`).
            _ if self.char_at(self.pos).is_some_and(is_name_start) => self.lex_ref_or_ident(),
            _ => {
                let start = self.pos;
                // Span the offending UTF-8 char.
                let ch_len = utf8_len(b);
                self.pos = (self.pos + ch_len).min(self.bytes.len());
                Err(ParseError::new(
                    format!("unexpected character {:?}", &self.src[start..self.pos]),
                    start..self.pos,
                ))
            }
        }
    }

    fn one(&mut self, k: TokKind) -> Result<TokKind, ParseError> {
        self.pos += 1;
        Ok(k)
    }

    /// `"..."`, with `""` meaning a literal `"`.
    fn lex_string(&mut self) -> Result<TokKind, ParseError> {
        let start = self.pos;
        self.pos += 1; // opening quote
        let mut s = String::new();
        loop {
            match self.peek() {
                None => {
                    return Err(ParseError::new(
                        "unterminated string literal",
                        start..self.pos,
                    ))
                }
                Some(b'"') => {
                    if self.bytes.get(self.pos + 1) == Some(&b'"') {
                        s.push('"');
                        self.pos += 2;
                    } else {
                        self.pos += 1; // closing quote
                        return Ok(TokKind::Str(s));
                    }
                }
                Some(_) => {
                    // Copy one whole UTF-8 char.
                    let ch_len = utf8_len(self.bytes[self.pos]);
                    let end = (self.pos + ch_len).min(self.bytes.len());
                    s.push_str(&self.src[self.pos..end]);
                    self.pos = end;
                }
            }
        }
    }

    /// `#DIV/0!`, `#N/A`, etc.: the longest of Excel's error codes
    /// ([`ERROR_CODES`]) that the text at `#` spells, case-insensitively, and
    /// nothing after it, so `#N/A/1` is `#N/A` divided by 1. A code the
    /// engine's values cannot hold (`#CALC!`, …) is an error naming it.
    fn lex_error_literal(&mut self) -> Result<TokKind, ParseError> {
        let start = self.pos;
        let rest = &self.bytes[start..];
        let code = ERROR_CODES
            .iter()
            .filter(|c| rest.len() >= c.len() && rest[..c.len()].eq_ignore_ascii_case(c.as_bytes()))
            .max_by_key(|c| c.len());
        let Some(code) = code else {
            // Span the run an error literal could have been, for the message.
            let mut end = start + 1;
            while self.bytes.get(end).is_some_and(|c| {
                c.is_ascii_alphanumeric() || matches!(c, b'/' | b'!' | b'?' | b'_')
            }) {
                end += 1;
            }
            self.pos = end;
            return Err(ParseError::new(
                format!("invalid error literal {:?}", &self.src[start..end]),
                start..end,
            ));
        };
        self.pos = start + code.len();
        match sheet_core::CellError::parse(code) {
            Some(e) => Ok(TokKind::Error(e)),
            None => Err(ParseError::new(
                format!("error literal {code} is not supported"),
                start..self.pos,
            )),
        }
    }

    /// `'Quoted''Sheet'!` — a sheet qualifier whose name needs quoting.
    fn lex_quoted_sheet(&mut self) -> Result<TokKind, ParseError> {
        let start = self.pos;
        self.pos += 1; // opening '
        let mut name = String::new();
        loop {
            match self.peek() {
                None => {
                    return Err(ParseError::new(
                        "unterminated quoted sheet name",
                        start..self.pos,
                    ))
                }
                Some(b'\'') => {
                    if self.bytes.get(self.pos + 1) == Some(&b'\'') {
                        name.push('\'');
                        self.pos += 2;
                    } else {
                        self.pos += 1; // closing '
                        break;
                    }
                }
                Some(_) => {
                    let ch_len = utf8_len(self.bytes[self.pos]);
                    let end = (self.pos + ch_len).min(self.bytes.len());
                    name.push_str(&self.src[self.pos..end]);
                    self.pos = end;
                }
            }
        }
        // A quoted sheet must be followed by '!'.
        if self.peek() == Some(b'!') {
            self.pos += 1;
            Ok(TokKind::SheetQual(name))
        } else {
            Err(ParseError::new(
                "expected '!' after quoted sheet name",
                start..self.pos,
            ))
        }
    }

    /// A numeric literal, incl. a fractional part and scientific exponent.
    /// One past f64's range is an error, as in Excel: as infinity it would
    /// print as `inf`, which no formula can spell.
    fn lex_number(&mut self) -> Result<TokKind, ParseError> {
        let start = self.pos;
        while self.peek().is_some_and(|c| c.is_ascii_digit()) {
            self.pos += 1;
        }
        if self.peek() == Some(b'.') {
            self.pos += 1;
            while self.peek().is_some_and(|c| c.is_ascii_digit()) {
                self.pos += 1;
            }
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            // Only consume the exponent if it is well-formed; otherwise the
            // `e`/`E` belongs to a following token (it cannot, since digits
            // were just seen — but a trailing sign needs a digit).
            let save = self.pos;
            self.pos += 1;
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.pos += 1;
            }
            if self.peek().is_some_and(|c| c.is_ascii_digit()) {
                while self.peek().is_some_and(|c| c.is_ascii_digit()) {
                    self.pos += 1;
                }
            } else {
                self.pos = save; // not an exponent after all
            }
        }
        // The grammar above only emits valid f64 syntax.
        let n: f64 = self.src[start..self.pos].parse().unwrap();
        if !n.is_finite() {
            return Err(ParseError::new("number is too large", start..self.pos));
        }
        Ok(TokKind::Number(n))
    }

    /// Either a sheet-qualified ref prefix (`Sheet1!`), a bare A1 cell, or a
    /// plain identifier. Disambiguation: read the maximal `$`/letter/digit
    /// run; if it is followed by `!` it is an unquoted sheet qualifier; else
    /// if it parses as A1 it is a `Cell`; else it is an `Ident`.
    fn lex_ref_or_ident(&mut self) -> Result<TokKind, ParseError> {
        let start = self.pos;

        // First: scan an unquoted sheet name candidate (letters of any
        // script, digits, `_`, `.`) NOT containing `$` — only if it is
        // terminated by `!`.
        let j = self.name_run(self.pos, false);
        if self.bytes.get(j) == Some(&b'!') && j > self.pos && self.bytes[self.pos] != b'$' {
            let name = self.src[self.pos..j].to_string();
            self.pos = j + 1; // consume the '!'
            return Ok(TokKind::SheetQual(name));
        }
        // A 3D span `First:Last!` — two unquoted sheet names around `:`. The
        // qualifier carries `First:Last`; the parser splits it.
        if self.bytes.get(j) == Some(&b':') && j > self.pos && self.bytes[self.pos] != b'$' {
            let k = self.name_run(j + 1, false);
            if k > j + 1 && self.bytes.get(k) == Some(&b'!') {
                let name = self.src[self.pos..k].to_string();
                self.pos = k + 1;
                return Ok(TokKind::SheetQual(name));
            }
        }

        // Otherwise: consume an A1/identifier run including a leading `$`,
        // letters, digits, `.`, and `_` (a `$` may also appear mid-token for
        // `$B$7`). We then classify.
        let k = self.name_run(self.pos, true);
        let tok = &self.src[self.pos..k];
        self.pos = k;

        // A table name immediately followed by `[` (no whitespace) is a
        // structured (table) reference: `Table1[Col]`, `Table1[[#All]]`, …
        // The whole bracket spec lexes into one `Structured` token (spec §6.4).
        // A leading `$` cannot start a table name, so guard it out.
        if self.peek() == Some(b'[') && !tok.contains('$') && !tok.is_empty() {
            let (kind, end) = crate::structured::lex_structured(self.src, start, tok, self.pos)?;
            self.pos = end;
            return Ok(kind);
        }

        // TRUE / FALSE keywords (only when not a function call — the parser
        // re-routes `TRUE(` to a function by re-reading the ident; but a bare
        // `TRUE` followed by `(` cannot happen because `(` ends this run).
        if tok.eq_ignore_ascii_case("TRUE") && self.peek() != Some(b'(') {
            return Ok(TokKind::Bool(true));
        }
        if tok.eq_ignore_ascii_case("FALSE") && self.peek() != Some(b'(') {
            return Ok(TokKind::Bool(false));
        }

        // A1 cell? — but a run immediately followed by `(` is a CALL, never a
        // ref: `LOG10` is the one registered name that is also a valid A1
        // address (cols L-O-G, row 10), and Excel itself resolves `LOG10(` as
        // the function. The `(`-peek keeps `LOG10(8)` a call while a bare
        // `LOG10` stays the cell ref (matching Excel's own disambiguation).
        if self.peek() != Some(b'(') {
            if let Some((row, col, row_abs, col_abs)) = sheet_core::parse_a1(tok) {
                return Ok(TokKind::Cell {
                    row,
                    col,
                    row_abs,
                    col_abs,
                });
            }
        }

        // Plain identifier (name or function). Reject a `$` here: `$foo` is
        // neither a valid cell nor a valid name.
        if tok.contains('$') {
            return Err(ParseError::new(
                format!("invalid reference or name {tok:?}"),
                start..self.pos,
            ));
        }
        Ok(TokKind::Ident(tok.to_string()))
    }

    /// A whole-column (`A:C`, `$A:$A`) or whole-row (`1:3`, `$1:$1`) range,
    /// consumed as one token when the text at the cursor is exactly
    /// `part ':' part` of the same kind followed by a reference boundary.
    /// Anything else (`A1:B2`, a name, a number) answers `None` and lexes as
    /// before.
    fn whole_band(&mut self) -> Option<TokKind> {
        let b = self.bytes;
        // One endpoint: optional `$`, then a run of letters OR digits.
        let part = |mut i: usize| -> Option<(bool, bool, usize, usize)> {
            let abs = b.get(i) == Some(&b'$');
            if abs {
                i += 1;
            }
            let start = i;
            let letters = b.get(i)?.is_ascii_alphabetic();
            while i < b.len()
                && (if letters {
                    b[i].is_ascii_alphabetic()
                } else {
                    b[i].is_ascii_digit()
                })
            {
                i += 1;
            }
            (i > start).then_some((abs, letters, start, i))
        };
        let (abs0, letters0, s0, e0) = part(self.pos)?;
        if b.get(e0) != Some(&b':') {
            return None;
        }
        let (abs1, letters1, s1, e1) = part(e0 + 1)?;
        if letters0 != letters1 {
            return None;
        }
        // The band must END here: `A:B2`, `A:Bx`, `1:2.5`, `A:B(` are not bands.
        if self
            .char_at(e1)
            .is_some_and(|c| is_name_char(c) || matches!(c, '$' | '(' | '[' | '!'))
        {
            return None;
        }
        let kind = if letters0 {
            let c0 = sheet_core::a1_to_col(&self.src[s0..e0])?;
            let c1 = sheet_core::a1_to_col(&self.src[s1..e1])?;
            TokKind::Cols { c0, c1, abs0, abs1 }
        } else {
            let row = |t: &str| -> Option<u32> {
                let n: u32 = t.parse().ok()?;
                (1..=sheet_core::MAX_ROW + 1).contains(&n).then(|| n - 1)
            };
            TokKind::Rows {
                r0: row(&self.src[s0..e0])?,
                r1: row(&self.src[s1..e1])?,
                abs0,
                abs1,
            }
        };
        self.pos = e1;
        Some(kind)
    }

    /// An external-workbook sheet qualifier `[n]Sheet!` (the unquoted form;
    /// `'[n]Sheet name'!` arrives through the quoted path). The qualifier is
    /// the sheet NAME `[n]Sheet`, resolved by the context like any sheet.
    fn external_sheet_qual(&mut self) -> Option<TokKind> {
        let b = self.bytes;
        let mut j = self.pos + 1;
        let digits = j;
        while j < b.len() && b[j].is_ascii_digit() {
            j += 1;
        }
        if j == digits || b.get(j) != Some(&b']') {
            return None;
        }
        j += 1;
        let name = j;
        let j = self.name_run(name, false);
        if j == name || b.get(j) != Some(&b'!') {
            return None;
        }
        let q = self.src[self.pos..j].to_string();
        self.pos = j + 1;
        Some(TokKind::SheetQual(q))
    }

    /// A no-table structured reference whose body starts at the current `[`
    /// (the `[@Col]` / `[[#Headers],[Col]]` / `[Col]` forms). The table is
    /// resolved from the formula's own cell in eval (empty table name here).
    fn lex_bare_structured(&mut self) -> Result<TokKind, ParseError> {
        let start = self.pos;
        let (kind, end) = crate::structured::lex_structured(self.src, start, "", self.pos)?;
        self.pos = end;
        Ok(kind)
    }
}

/// Excel's error codes, as a formula spells them: the seven of ECMA-376
/// §18.17.2 and `#GETTING_DATA` ([MS-XLSX] 2.2.2; ERROR.TYPE 1–8), then the
/// dynamic-array and service errors of Excel's `ErrorCellValueType`. The
/// engine's values hold the first seven and `#SPILL!`
/// ([`sheet_core::CellError`]); the lexer knows them all, so a literal
/// ends where its code ends.
const ERROR_CODES: [&str; 17] = [
    "#NULL!",
    "#DIV/0!",
    "#VALUE!",
    "#REF!",
    "#NAME?",
    "#NUM!",
    "#N/A",
    "#GETTING_DATA",
    "#SPILL!",
    "#CALC!",
    "#FIELD!",
    "#BLOCKED!",
    "#CONNECT!",
    "#BUSY!",
    "#UNKNOWN!",
    "#EXTERNAL!",
    "#PYTHON!",
];

/// Whether `c` may start a name: a letter of any script, or `_`. Excel's rule
/// for defined names, table names and unquoted sheet names (its third
/// starter, the backslash, is not read here).
fn is_name_start(c: char) -> bool {
    c.is_alphabetic() || c == '_'
}

/// Whether `c` may continue a name: a letter or digit of any script, `_` or
/// `.`.
fn is_name_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_' || c == '.'
}

/// Byte length of the UTF-8 char starting with lead byte `b`.
fn utf8_len(b: u8) -> usize {
    if b < 0x80 {
        1
    } else if b >> 5 == 0b110 {
        2
    } else if b >> 4 == 0b1110 {
        3
    } else {
        4
    }
}

#[cfg(test)]
#[allow(non_snake_case)]
mod tests {
    use super::*;
    use crate::{parse, print, ParseCtx, SheetNames};
    use sheet_core::ast::{Expr, NameId};
    use sheet_core::SheetId;

    fn kinds(s: &str) -> Vec<TokKind> {
        lex(s).unwrap().into_iter().map(|t| t.kind).collect()
    }

    fn cell(row: u32, col: u32) -> TokKind {
        TokKind::Cell {
            row,
            col,
            row_abs: false,
            col_abs: false,
        }
    }

    #[test]
    fn unquoted_sheet_names_take_letters_of_any_script__feat__sheet_parser_dialect() {
        for name in [
            "Übersicht",
            "Résumé",
            "Данные",
            "データ",
            "Größe_2.1",
            "Sheet1",
        ] {
            assert_eq!(
                kinds(&format!("{name}!A1")),
                vec![TokKind::SheetQual(name.into()), cell(0, 0)],
                "{name}"
            );
        }
        // A non-ASCII letter after an ASCII start, and a 3D span.
        assert_eq!(
            kinds("Ertrag_März:Ertrag_Mai!B2"),
            vec![
                TokKind::SheetQual("Ertrag_März:Ertrag_Mai".into()),
                cell(1, 1)
            ]
        );
        assert_eq!(
            kinds("[1]Übersicht!A1"),
            vec![TokKind::SheetQual("[1]Übersicht".into()), cell(0, 0)]
        );
    }

    #[test]
    fn quoted_sheet_names_keep_any_text__feat__sheet_parser_dialect() {
        assert_eq!(
            kinds("'Übersicht 2026'!A1"),
            vec![TokKind::SheetQual("Übersicht 2026".into()), cell(0, 0)]
        );
        assert_eq!(
            kinds("'Übersicht'!A1+'L''été'!B1"),
            vec![
                TokKind::SheetQual("Übersicht".into()),
                cell(0, 0),
                TokKind::Plus,
                TokKind::SheetQual("L'été".into()),
                cell(0, 1),
            ]
        );
    }

    #[test]
    fn names_take_letters_of_any_script__feat__sheet_parser_dialect() {
        assert_eq!(
            kinds("Umsatzerlöse*Steuersatz_Österreich"),
            vec![
                TokKind::Ident("Umsatzerlöse".into()),
                TokKind::Star,
                TokKind::Ident("Steuersatz_Österreich".into()),
            ]
        );
        assert_eq!(kinds("Ärger"), vec![TokKind::Ident("Ärger".into())]);
        assert_eq!(kinds("収益.合計"), vec![TokKind::Ident("収益.合計".into())]);
        // A letter ends neither a cell nor a column band: `A1ä` and `A:Bä`
        // are names, not `A1` and `A:B` with a stray letter.
        assert_eq!(kinds("A1ä"), vec![TokKind::Ident("A1ä".into())]);
        assert_eq!(
            kinds("A:Bä"),
            vec![
                TokKind::Ident("A".into()),
                TokKind::Colon,
                TokKind::Ident("Bä".into()),
            ]
        );
        // The spans are byte spans on character boundaries.
        let toks = lex("Größe+1").unwrap();
        assert_eq!(toks[0].span, 0..7);
        assert_eq!(toks[1].span, 7..8);
    }

    #[test]
    fn what_is_no_letter_is_still_refused__feat__sheet_parser_dialect() {
        for bad in ["€", "1+→", "A1 ∑ 2", "\u{00a0}A1"] {
            assert!(lex(bad).is_err(), "{bad}");
        }
    }

    struct Book;

    impl ParseCtx for Book {
        fn sheet_id(&self, name: &str) -> Option<SheetId> {
            ["Start", "Übersicht", "Übersicht 2026"]
                .iter()
                .position(|s| *s == name)
                .map(|i| i as SheetId)
        }
        fn name_id(&self, name: &str) -> Option<NameId> {
            (name == "Umsatzerlöse").then_some(NameId(0))
        }
        fn current_sheet(&self) -> SheetId {
            0
        }
    }

    impl SheetNames for Book {
        fn sheet_name(&self, id: SheetId) -> Option<&str> {
            ["Start", "Übersicht", "Übersicht 2026"]
                .get(id as usize)
                .copied()
        }
        fn defined_name(&self, _id: NameId) -> Option<&str> {
            Some("Umsatzerlöse")
        }
    }

    #[test]
    fn a_formula_over_non_ascii_sheets_and_names_parses_and_prints_back__feat__sheet_parser_dialect(
    ) {
        let f = parse("Übersicht!A1", &Book).unwrap();
        assert!(matches!(&f.root, Expr::Ref(r) if r.sheet == 1 && (r.row, r.col) == (0, 0)));
        assert_eq!(print(&f, 0, &Book), "Übersicht!A1");

        let f = parse("'Übersicht 2026'!B2", &Book).unwrap();
        assert!(matches!(&f.root, Expr::Ref(r) if r.sheet == 2 && (r.row, r.col) == (1, 1)));
        assert_eq!(print(&f, 0, &Book), "'Übersicht 2026'!B2");

        let f = parse("Umsatzerlöse*2", &Book).unwrap();
        assert!(matches!(&f.root, Expr::Binary(_, l, _) if **l == Expr::Name(NameId(0))));
        assert_eq!(print(&f, 0, &Book), "Umsatzerlöse*2");

        let f = parse("SUM(Übersicht!A1:B2)", &Book).unwrap();
        assert_eq!(print(&f, 0, &Book), "SUM(Übersicht!A1:B2)");
    }
}
