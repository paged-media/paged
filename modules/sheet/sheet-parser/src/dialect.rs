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

//! The DISPLAY dialect of a formula (sheet ADR 521, amending ADR 509): what
//! the formula bar and the cell editor show and accept. Storage stays the
//! canonical en-US A1 text [`crate::parse`] reads and [`crate::print`]
//! writes; this module only translates text between the two, so the AST,
//! the parser and every stored formula are untouched.
//!
//! Two independent axes:
//!
//! - **Reference style.** A1 (`B3`, `$A$1`, `A:C`, `1:3`) or R1C1 relative to
//!   the formula's own cell (`R[1]C[-2]`, `R1C1`, `RC`, `C[2]`, `R[-1]:R[1]`).
//! - **Formula language.** Function names, boolean and error words, the
//!   argument separator, the decimal sign, the array-literal separators and
//!   the R1C1 letters. English is the identity; German comes from a small
//!   data table (`dialect/de.txt`, canonical → localized) — `SUMME`, `WENN`,
//!   `SVERWEIS`, `;` between arguments, `,` as the decimal sign, `Z1S1`.
//!
//! [`to_display`] lexes the canonical text with the parser's own lexer and
//! re-spells tokens (the whitespace between tokens is kept). [`from_display`]
//! scans the localized text by hand (a localized formula does not lex: `1,5`
//! is one number, `;` separates arguments) and emits canonical text, which
//! then goes through [`crate::parse`] like any typed formula. A name the table
//! does not know passes through unchanged in both directions, so the
//! canonical name is always accepted.

use std::sync::OnceLock;

use crate::lexer::{lex, TokKind};

/// How references are shown.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum RefStyle {
    /// `B3`, `$A$1` (the canonical form).
    #[default]
    A1,
    /// `R[1]C[-2]`, `R1C1` — relative to the formula's cell.
    R1C1,
}

/// The language function names and separators are shown in.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum FormulaLang {
    /// English names, `,` between arguments (the canonical form).
    #[default]
    En,
    /// German names (`SUMME`, `WENN`), `;` between arguments, `,` decimal.
    De,
}

impl FormulaLang {
    /// The language of a BCP-47-ish tag (`de-AT` → German). Languages without
    /// a table show the canonical English form.
    pub fn from_tag(tag: &str) -> FormulaLang {
        let lang = tag.split(['-', '_']).next().unwrap_or("");
        if lang.eq_ignore_ascii_case("de") {
            FormulaLang::De
        } else {
            FormulaLang::En
        }
    }

    /// The tag this language reports (`"en"`, `"de"`).
    pub fn tag(self) -> &'static str {
        match self {
            FormulaLang::En => "en",
            FormulaLang::De => "de",
        }
    }
}

/// A display dialect: the reference style plus the language.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Dialect {
    pub refs: RefStyle,
    pub lang: FormulaLang,
}

impl Dialect {
    /// The canonical dialect (A1, English): both translations are the identity.
    pub fn is_canonical(&self) -> bool {
        self.refs == RefStyle::A1 && self.lang == FormulaLang::En
    }
}

/// Everything language-specific, as data.
struct LangData {
    arg_sep: char,
    decimal: char,
    array_col: char,
    array_row: char,
    r: char,
    c: char,
    open: char,
    close: char,
    /// `CANONICAL LOCAL` lines (`#` comments).
    names: &'static str,
    /// Canonical → local error words.
    errors: &'static [(&'static str, &'static str)],
    /// Canonical → local structured-reference specifiers.
    specials: &'static [(&'static str, &'static str)],
}

const EN: LangData = LangData {
    arg_sep: ',',
    decimal: '.',
    array_col: ',',
    array_row: ';',
    r: 'R',
    c: 'C',
    open: '[',
    close: ']',
    names: "",
    errors: &[],
    specials: &[],
};

const DE: LangData = LangData {
    arg_sep: ';',
    decimal: ',',
    array_col: '.',
    array_row: ';',
    r: 'Z',
    c: 'S',
    open: '(',
    close: ')',
    names: include_str!("dialect/de.txt"),
    errors: &[
        ("#VALUE!", "#WERT!"),
        ("#REF!", "#BEZUG!"),
        ("#NUM!", "#ZAHL!"),
        ("#N/A", "#NV"),
        ("#SPILL!", "#ÜBERLAUF!"),
        ("#CALC!", "#KALK!"),
        ("#GETTING_DATA", "#DATEN_ABRUFEN"),
    ],
    specials: &[
        ("#All", "#Alle"),
        ("#Data", "#Daten"),
        ("#Headers", "#Kopfzeilen"),
        ("#Totals", "#Ergebnisse"),
        ("#This Row", "#Diese Zeile"),
    ],
};

fn data(lang: FormulaLang) -> &'static LangData {
    match lang {
        FormulaLang::En => &EN,
        FormulaLang::De => &DE,
    }
}

/// The parsed name table of a language: `(canonical, local)` pairs, built
/// once per language from the data text.
fn names(lang: FormulaLang) -> &'static [(&'static str, &'static str)] {
    static DE_NAMES: OnceLock<Vec<(&'static str, &'static str)>> = OnceLock::new();
    match lang {
        FormulaLang::En => &[],
        FormulaLang::De => DE_NAMES.get_or_init(|| parse_table(DE.names)),
    }
}

fn parse_table(text: &'static str) -> Vec<(&'static str, &'static str)> {
    text.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .filter_map(|l| l.split_once(' '))
        .map(|(a, b)| (a.trim(), b.trim()))
        .collect()
}

/// The localized name of canonical function `name`, if the table has one.
pub fn local_function_name(lang: FormulaLang, name: &str) -> Option<&'static str> {
    names(lang)
        .iter()
        .find(|(c, _)| c.eq_ignore_ascii_case(name))
        .map(|(_, l)| *l)
}

/// The canonical name of localized function `name`, if the table has one.
pub fn canonical_function_name(lang: FormulaLang, name: &str) -> Option<&'static str> {
    let upper = name.to_uppercase();
    names(lang)
        .iter()
        .find(|(_, l)| l.to_uppercase() == upper)
        .map(|(c, _)| *c)
}

/// Every `(canonical, local)` pair of a language's table (for autocomplete
/// and the table's own tests).
pub fn function_names(lang: FormulaLang) -> &'static [(&'static str, &'static str)] {
    names(lang)
}

/// Column letters of a 0-based column.
fn col_letters(mut c: u32, out: &mut String) {
    let mut buf = [0u8; 4];
    let mut n = 0;
    loop {
        buf[n] = b'A' + (c % 26) as u8;
        n += 1;
        if c < 26 {
            break;
        }
        c = c / 26 - 1;
    }
    for b in buf[..n].iter().rev() {
        out.push(*b as char);
    }
}

/// One R1C1 coordinate: absolute (`R5`), relative (`R[-2]`) or `R` alone.
fn r1c1_coord(out: &mut String, letter: char, d: &LangData, idx: u32, abs: bool, here: u32) {
    out.push(letter);
    if abs {
        out.push_str(&(idx + 1).to_string());
    } else if idx != here {
        out.push(d.open);
        out.push_str(&(i64::from(idx) - i64::from(here)).to_string());
        out.push(d.close);
    }
}

/// Re-spell a structured reference's text for `d`: the separator between
/// bracketed items and the `#…` specifiers. `to_local` picks the direction.
fn respell_structured(text: &str, d: &LangData, to_local: bool) -> String {
    let (from_sep, to_sep) = if to_local {
        (',', d.arg_sep)
    } else {
        (d.arg_sep, ',')
    };
    let mut out = String::with_capacity(text.len());
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let ch = chars[i];
        // An item separator: `]` `,` (optional spaces) `[`.
        if ch == from_sep && from_sep != to_sep && out.trim_end().ends_with(']') {
            let rest: String = chars[i + 1..].iter().collect();
            if rest.trim_start().starts_with('[') {
                out.push(to_sep);
                i += 1;
                continue;
            }
        }
        if ch == '#' {
            let rest: String = chars[i..].iter().collect();
            let hit = d.specials.iter().find_map(|(c, l)| {
                let (from, to) = if to_local { (c, l) } else { (l, c) };
                let n = from.chars().count();
                let head: String = rest.chars().take(n).collect();
                head.eq_ignore_ascii_case(from).then_some((n, *to))
            });
            if let Some((n, to)) = hit {
                out.push_str(to);
                i += n;
                continue;
            }
        }
        out.push(ch);
        i += 1;
    }
    out
}

/// Canonical formula text (no leading `=`) → the display dialect, for a
/// formula living at `(row, col)` (0-based; R1C1 is relative to it). Text the
/// lexer refuses is returned unchanged.
pub fn to_display(text: &str, dialect: Dialect, row: u32, col: u32) -> String {
    if dialect.is_canonical() {
        return text.to_string();
    }
    let Ok(tokens) = lex(text) else {
        return text.to_string();
    };
    let d = data(dialect.lang);
    let r1c1 = dialect.refs == RefStyle::R1C1;
    let mut out = String::with_capacity(text.len() + 8);
    let mut last = 0;
    let mut braces = 0usize;
    for (i, t) in tokens.iter().enumerate() {
        out.push_str(&text[last..t.span.start]);
        last = t.span.end;
        let src = &text[t.span.clone()];
        match &t.kind {
            TokKind::Number(_) => {
                out.extend(src.chars().map(|c| if c == '.' { d.decimal } else { c }))
            }
            TokKind::Bool(b) => {
                let canon = if *b { "TRUE" } else { "FALSE" };
                out.push_str(local_function_name(dialect.lang, canon).unwrap_or(canon));
            }
            TokKind::Error(_) => {
                let hit = d
                    .errors
                    .iter()
                    .find(|(c, _)| c.eq_ignore_ascii_case(src))
                    .map(|(_, l)| *l);
                out.push_str(hit.unwrap_or(src));
            }
            TokKind::Cell {
                row: r,
                col: c,
                row_abs,
                col_abs,
            } if r1c1 => {
                r1c1_coord(&mut out, d.r, d, *r, *row_abs, row);
                r1c1_coord(&mut out, d.c, d, *c, *col_abs, col);
            }
            TokKind::Rows { r0, r1, abs0, abs1 } if r1c1 => {
                r1c1_coord(&mut out, d.r, d, *r0, *abs0, row);
                if (r0, abs0) != (r1, abs1) {
                    out.push(':');
                    r1c1_coord(&mut out, d.r, d, *r1, *abs1, row);
                }
            }
            TokKind::Cols { c0, c1, abs0, abs1 } if r1c1 => {
                r1c1_coord(&mut out, d.c, d, *c0, *abs0, col);
                if (c0, abs0) != (c1, abs1) {
                    out.push(':');
                    r1c1_coord(&mut out, d.c, d, *c1, *abs1, col);
                }
            }
            TokKind::Ident(name)
                if matches!(tokens.get(i + 1).map(|n| &n.kind), Some(TokKind::LParen)) =>
            {
                let (prefix, bare) = split_prefix(name);
                out.push_str(prefix);
                out.push_str(local_function_name(dialect.lang, bare).unwrap_or(bare));
            }
            TokKind::Structured(_) => out.push_str(&respell_structured(src, d, true)),
            TokKind::LBrace => {
                braces += 1;
                out.push('{');
            }
            TokKind::RBrace => {
                braces = braces.saturating_sub(1);
                out.push('}');
            }
            TokKind::Comma => out.push(if braces > 0 { d.array_col } else { d.arg_sep }),
            TokKind::Semicolon => out.push(d.array_row),
            _ => out.push_str(src),
        }
    }
    out.push_str(&text[last..]);
    out
}

/// A storage prefix kept in front of a localized name (`_xlfn.`).
fn split_prefix(name: &str) -> (&str, &str) {
    for p in ["_xlfn._xlws.", "_xlfn.", "_xludf."] {
        if name.len() > p.len() && name[..p.len()].eq_ignore_ascii_case(p) {
            return name.split_at(p.len());
        }
    }
    ("", name)
}

/// A character that continues a name or a reference.
fn is_word(c: char, in_array: bool, d: &LangData) -> bool {
    c.is_alphanumeric()
        || matches!(c, '_' | '$' | '\\' | '?')
        || (c == '.' && !(in_array && d.array_col == '.'))
}

/// One parsed R1C1 coordinate: `Some(None)` when the letter is absent,
/// `Some(Some((index, absolute)))` when present.
type Coord = Option<(u32, bool)>;

/// Parse one coordinate (`R`, `R5`, `R[-2]`) at `chars[*i]` for `letter`.
fn parse_coord(
    chars: &[char],
    i: &mut usize,
    letter: char,
    d: &LangData,
    here: u32,
    max: u32,
) -> Option<Coord> {
    if chars
        .get(*i)
        .is_none_or(|c| !c.eq_ignore_ascii_case(&letter))
    {
        return Some(None);
    }
    let mut j = *i + 1;
    let digits = |j: &mut usize| {
        let s = *j;
        while chars.get(*j).is_some_and(char::is_ascii_digit) {
            *j += 1;
        }
        (s != *j).then(|| chars[s..*j].iter().collect::<String>())
    };
    let coord = if chars.get(j) == Some(&d.open) {
        j += 1;
        let neg = match chars.get(j) {
            Some('-') => {
                j += 1;
                true
            }
            Some('+') => {
                j += 1;
                false
            }
            _ => false,
        };
        let n: i64 = digits(&mut j)?.parse().ok()?;
        if chars.get(j) != Some(&d.close) {
            return None;
        }
        j += 1;
        let at = i64::from(here) + if neg { -n } else { n };
        if !(0..=i64::from(max)).contains(&at) {
            // Off the sheet: a reference that resolves to `#REF!`.
            *i = j;
            return Some(Some((u32::MAX, false)));
        }
        (at as u32, false)
    } else if let Some(n) = digits(&mut j) {
        let n: u32 = n.parse().ok()?;
        if n == 0 || n - 1 > max {
            return None;
        }
        (n - 1, true)
    } else {
        (here, false)
    };
    *i = j;
    Some(Some(coord))
}

/// An R1C1 reference at `chars[start]`: the end index and the A1 spelling of
/// its row part and column part.
fn parse_r1c1(
    chars: &[char],
    start: usize,
    d: &LangData,
    row: u32,
    col: u32,
    in_array: bool,
) -> Option<(usize, Coord, Coord)> {
    let mut i = start;
    let r = parse_coord(chars, &mut i, d.r, d, row, sheet_core::MAX_ROW)?;
    let c = parse_coord(chars, &mut i, d.c, d, col, sheet_core::MAX_COL)?;
    if r.is_none() && c.is_none() {
        return None;
    }
    // Followed by a name character or a call: a name, not a reference.
    if chars
        .get(i)
        .is_some_and(|&ch| is_word(ch, in_array, d) || ch == '(' || ch == '[')
    {
        return None;
    }
    Some((i, r, c))
}

fn push_row(out: &mut String, (r, abs): (u32, bool)) {
    if abs {
        out.push('$');
    }
    out.push_str(&(r + 1).to_string());
}

fn push_col(out: &mut String, (c, abs): (u32, bool)) {
    if abs {
        out.push('$');
    }
    col_letters(c, out);
}

/// Display-dialect text (no leading `=`) → canonical text, for a formula
/// living at `(row, col)`. What it cannot read is copied through, so the
/// parser reports it.
pub fn from_display(text: &str, dialect: Dialect, row: u32, col: u32) -> String {
    if dialect.is_canonical() {
        return text.to_string();
    }
    let d = data(dialect.lang);
    let r1c1 = dialect.refs == RefStyle::R1C1;
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len() + 8);
    let mut braces = 0usize;
    let mut i = 0;
    while i < chars.len() {
        let ch = chars[i];
        let in_array = braces > 0;
        match ch {
            '"' | '\'' => {
                // A string, or a quoted sheet name: copied whole.
                out.push(ch);
                i += 1;
                while i < chars.len() {
                    out.push(chars[i]);
                    if chars[i] == ch {
                        if chars.get(i + 1) == Some(&ch) {
                            out.push(ch);
                            i += 2;
                            continue;
                        }
                        i += 1;
                        break;
                    }
                    i += 1;
                }
            }
            '{' => {
                braces += 1;
                out.push(ch);
                i += 1;
            }
            '}' => {
                braces = braces.saturating_sub(1);
                out.push(ch);
                i += 1;
            }
            '[' => {
                // A structured reference's bracket group, balanced.
                let start = i;
                let mut depth = 0usize;
                while i < chars.len() {
                    match chars[i] {
                        '[' => depth += 1,
                        ']' => {
                            depth -= 1;
                            if depth == 0 {
                                i += 1;
                                break;
                            }
                        }
                        '\'' => i += 1, // an escaped bracket or quote
                        _ => {}
                    }
                    i += 1;
                }
                let group: String = chars[start..i.min(chars.len())].iter().collect();
                out.push_str(&respell_structured(&group, d, false));
            }
            '#' => {
                let rest: String = chars[i..].iter().take(16).collect();
                let hit = d.errors.iter().find_map(|(c, l)| {
                    let n = l.chars().count();
                    let head: String = rest.chars().take(n).collect();
                    (head.to_uppercase() == l.to_uppercase()).then_some((n, *c))
                });
                match hit {
                    Some((n, canon)) => {
                        out.push_str(canon);
                        i += n;
                    }
                    None => {
                        // A canonical error word or the spill operator.
                        out.push('#');
                        i += 1;
                        while i < chars.len()
                            && (chars[i].is_ascii_alphanumeric()
                                || matches!(chars[i], '/' | '!' | '?' | '_'))
                        {
                            out.push(chars[i]);
                            i += 1;
                        }
                    }
                }
            }
            c if c.is_ascii_digit()
                || (c == d.decimal && chars.get(i + 1).is_some_and(char::is_ascii_digit)) =>
            {
                // A number: the local decimal sign becomes `.`.
                while i < chars.len() {
                    let c = chars[i];
                    if c.is_ascii_digit() {
                        out.push(c);
                    } else if c == d.decimal && chars.get(i + 1).is_some_and(char::is_ascii_digit) {
                        out.push('.');
                    } else if (c == 'E' || c == 'e')
                        && (chars.get(i + 1).is_some_and(char::is_ascii_digit)
                            || (matches!(chars.get(i + 1), Some('+' | '-'))
                                && chars.get(i + 2).is_some_and(char::is_ascii_digit)))
                    {
                        out.push(c);
                        out.push(chars[i + 1]);
                        i += 1;
                    } else {
                        break;
                    }
                    i += 1;
                }
            }
            c if c == d.arg_sep && !in_array => {
                out.push(',');
                i += 1;
            }
            c if in_array && c == d.array_col => {
                out.push(',');
                i += 1;
            }
            c if in_array && c == d.array_row => {
                out.push(';');
                i += 1;
            }
            c if is_word(c, in_array, d) => {
                // An R1C1 reference (a whole-row or whole-column one may pair
                // with the next across `:`).
                if r1c1 {
                    if let Some((end, r, c)) = parse_r1c1(&chars, i, d, row, col, in_array) {
                        i = end;
                        if r.is_some_and(|r| r.0 == u32::MAX) || c.is_some_and(|c| c.0 == u32::MAX)
                        {
                            out.push_str("#REF!");
                            continue;
                        }
                        match (r, c) {
                            (Some(r), Some(c)) => {
                                push_col(&mut out, c);
                                push_row(&mut out, r);
                            }
                            (Some(r), None) => {
                                let mut r2 = r;
                                if chars.get(i) == Some(&':') {
                                    if let Some((e2, Some(b), None)) =
                                        parse_r1c1(&chars, i + 1, d, row, col, in_array)
                                    {
                                        r2 = b;
                                        i = e2;
                                    }
                                }
                                push_row(&mut out, r);
                                out.push(':');
                                push_row(&mut out, r2);
                            }
                            (None, Some(c)) => {
                                let mut c2 = c;
                                if chars.get(i) == Some(&':') {
                                    if let Some((e2, None, Some(b))) =
                                        parse_r1c1(&chars, i + 1, d, row, col, in_array)
                                    {
                                        c2 = b;
                                        i = e2;
                                    }
                                }
                                push_col(&mut out, c);
                                out.push(':');
                                push_col(&mut out, c2);
                            }
                            (None, None) => unreachable!("parse_r1c1 needs a coordinate"),
                        }
                        continue;
                    }
                }
                let start = i;
                while i < chars.len() && is_word(chars[i], in_array, d) {
                    i += 1;
                }
                let word: String = chars[start..i].iter().collect();
                let call = chars.get(i) == Some(&'(');
                let (prefix, bare) = split_prefix(&word);
                if call {
                    out.push_str(prefix);
                    out.push_str(canonical_function_name(dialect.lang, bare).unwrap_or(bare));
                } else if chars.get(i) == Some(&'!') {
                    out.push_str(&word); // a sheet name
                } else {
                    // A boolean word, else a name or an A1 reference.
                    let canon = canonical_function_name(dialect.lang, &word)
                        .filter(|c| matches!(*c, "TRUE" | "FALSE"));
                    out.push_str(canon.unwrap_or(&word));
                }
            }
            _ => {
                out.push(ch);
                i += 1;
            }
        }
    }
    out
}

#[cfg(test)]
#[allow(non_snake_case)]
mod tests {
    use super::*;

    const DE_R1C1: Dialect = Dialect {
        refs: RefStyle::R1C1,
        lang: FormulaLang::De,
    };
    const DE_A1: Dialect = Dialect {
        refs: RefStyle::A1,
        lang: FormulaLang::De,
    };
    const EN_R1C1: Dialect = Dialect {
        refs: RefStyle::R1C1,
        lang: FormulaLang::En,
    };

    fn both(canon: &str, d: Dialect, row: u32, col: u32, shown: &str) {
        assert_eq!(to_display(canon, d, row, col), shown, "to_display {canon}");
        assert_eq!(
            from_display(shown, d, row, col),
            canon,
            "from_display {shown}"
        );
    }

    #[test]
    fn r1c1_relative_absolute_and_mixed__feat__sheet_parser_dialect() {
        // The formula lives at C3 (row 2, col 2).
        both("A1+$B$2", EN_R1C1, 2, 2, "R[-2]C[-2]+R2C2");
        both("C3*2", EN_R1C1, 2, 2, "RC*2");
        both("$A4+B$1", EN_R1C1, 2, 2, "R[1]C1+R1C[-1]");
        both("SUM(A1:B2)", EN_R1C1, 2, 2, "SUM(R[-2]C[-2]:R[-1]C[-1])");
        both("SUM(A:A)", EN_R1C1, 2, 2, "SUM(C[-2])");
        both("SUM($1:$3)", EN_R1C1, 2, 2, "SUM(R1:R3)");
        both("Sheet2!A1", EN_R1C1, 0, 0, "Sheet2!RC");
        both("'My Sheet'!$B$2", EN_R1C1, 0, 0, "'My Sheet'!R2C2");
    }

    #[test]
    fn r1c1_accepts_what_it_does_not_print__feat__sheet_parser_dialect() {
        // `R` alone is the formula's own row; an explicit `+` is accepted.
        assert_eq!(from_display("R[+1]C", EN_R1C1, 0, 0), "A2");
        assert_eq!(from_display("ROUND(RC[1],2)", EN_R1C1, 0, 0), "ROUND(B1,2)");
        // A name that starts like a reference stays a name.
        assert_eq!(from_display("RCX+1", EN_R1C1, 0, 0), "RCX+1");
        // Off the sheet: `#REF!`, as Excel shows it.
        assert_eq!(from_display("R[-1]C+1", EN_R1C1, 0, 0), "#REF!+1");
    }

    #[test]
    fn german_names_separators_and_decimals__feat__sheet_parser_dialect() {
        both(
            "IF(SUM(A1:A3)>1.5,VLOOKUP(B1,D1:E9,2,FALSE),\"a,b\")",
            DE_A1,
            0,
            0,
            "WENN(SUMME(A1:A3)>1,5;SVERWEIS(B1;D1:E9;2;FALSCH);\"a,b\")",
        );
        both("{1.5,2;3,4}", DE_A1, 0, 0, "{1,5.2;3.4}");
        both("IFERROR(1/0,#N/A)", DE_A1, 0, 0, "WENNFEHLER(1/0;#NV)");
        both("TRUE+1E-3", DE_A1, 0, 0, "WAHR+1E-3");
        both(
            "_xlfn.XLOOKUP(1,A:A,B:B)",
            DE_A1,
            0,
            0,
            "_xlfn.XVERWEIS(1;A:A;B:B)",
        );
        // Unknown and English names pass through; English is accepted.
        both("MYFN(1,2)", DE_A1, 0, 0, "MYFN(1;2)");
        assert_eq!(from_display("SUM(1;2)", DE_A1, 0, 0), "SUM(1,2)");
        assert_eq!(from_display("summe(1;2)", DE_A1, 0, 0), "SUM(1,2)");
        assert_eq!(
            from_display("ZÄHLENWENN(A:A;\">1\")", DE_A1, 0, 0),
            "COUNTIF(A:A,\">1\")"
        );
    }

    #[test]
    fn german_r1c1_letters__feat__sheet_parser_dialect() {
        both("SUM(A1:B2)", DE_R1C1, 2, 2, "SUMME(Z(-2)S(-2):Z(-1)S(-1))");
        both("$A$1*C3", DE_R1C1, 2, 2, "Z1S1*ZS");
        // A function whose name begins with Z or S is still a call.
        both(
            "ROW(C3)+ROUND(1.25,1)",
            DE_R1C1,
            2,
            2,
            "ZEILE(ZS)+RUNDEN(1,25;1)",
        );
    }

    #[test]
    fn structured_references__feat__sheet_parser_dialect() {
        both(
            "SUM(Table1[[#Headers],[Col]])",
            DE_A1,
            0,
            0,
            "SUMME(Table1[[#Kopfzeilen];[Col]])",
        );
        both("Table1[@Col]*2", DE_A1, 0, 0, "Table1[@Col]*2");
    }

    #[test]
    fn canonical_dialect_is_identity__feat__sheet_parser_dialect() {
        let d = Dialect::default();
        assert_eq!(to_display("SUM(A1,1.5)", d, 0, 0), "SUM(A1,1.5)");
        assert_eq!(from_display("SUM(A1,1.5)", d, 0, 0), "SUM(A1,1.5)");
    }

    #[test]
    fn german_table_is_a_bijection__feat__sheet_parser_dialect() {
        let t = function_names(FormulaLang::De);
        assert!(t.len() > 250);
        let mut locals: Vec<String> = t.iter().map(|(_, l)| l.to_uppercase()).collect();
        locals.sort();
        let n = locals.len();
        locals.dedup();
        assert_eq!(n, locals.len(), "a German name is used twice");
        // No German name is another function's canonical name.
        for (c, l) in t {
            assert!(
                t.iter()
                    .all(|(c2, _)| c2 == c || !c2.eq_ignore_ascii_case(l)),
                "{l} is also a canonical name"
            );
        }
    }
}
