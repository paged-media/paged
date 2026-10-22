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

//! W3 text kernels: the regular-expression functions, `ARRAYTOTEXT` /
//! `VALUETOTEXT`, `BAHTTEXT`, the width functions, `PHONETIC`,
//! `ENCODEURL`, `FILTERXML` and `EUROCONVERT`. (The `…B` byte variants are
//! registry rows on the plain kernels: in a single-byte locale a byte is a
//! character — Excel-recorded, `LENB("日本")` is 2 in en-US.)
//!
//! ## Rulings (Excel-recorded, `corpus/fn-corpus/text3`)
//!
//! - **Regular expressions** follow PCRE2 as Excel does, through
//!   `fancy-regex` (backtracking, so look-around, back-references, atomic
//!   groups and possessive quantifiers compile). `(?#…)` comments are removed
//!   first. Of the Unicode property classes only `\p{L}` and `\p{N}` (and
//!   their negations) are available, outside brackets: the general-category
//!   tables are left out of the wasm (≈ 50 KB); any other `\p{…}` is
//!   `#VALUE!`. A pattern that does not compile, a `case_sensitivity` other than
//!   0/1 or a `return_mode` other than 0/1/2 is `#VALUE!`. Global matching
//!   is PCRE's: an empty match is kept and the search then moves one
//!   character on (`REGEXEXTRACT("a,b,,c","[^,]*",1)` has seven items).
//!   `REGEXEXTRACT` returns all matches (mode 1) and the groups of the first
//!   match (mode 2, an unmatched group `#N/A`, no groups `#VALUE!`) as a
//!   row; no match is `#N/A`. `REGEXREPLACE` takes PCRE2's extended
//!   replacement: `$n`, `${n}`, `${name}`, `$$`, and the case escapes `\u`
//!   `\l` `\U` `\L` `\E`; an unknown group, a lone `$` or `\digit` is
//!   `#VALUE!`. `occurrence` 0 replaces all, `n` the n-th, `-n` the n-th from
//!   the end.
//! - **ARRAYTOTEXT** concise form joins with `", "`; the strict form is the
//!   array literal (`{1,"x";TRUE,}`), text quoted with doubled quotes, a
//!   blank cell empty. **VALUETOTEXT** quotes text only in the strict form;
//!   a blank is `""` in both. `format` other than 0/1 is `#VALUE!`.
//! - **ASC / DBCS** return their text unchanged: Excel converts widths only
//!   under a double-byte (CJK) language setting, which the engine's locale
//!   set does not include (en-US Excel-recorded: `ASC("ＡＢＣ")` stays
//!   full-width). **JIS** is DBCS's name in the Japanese UI.
//! - **PHONETIC** returns the reference's text (a workbook carries no
//!   furigana runs the engine reads).
//! - **ENCODEURL** percent-encodes the UTF-8 bytes of everything but the
//!   RFC 3986 unreserved characters.
//! - **FILTERXML** parses the XML itself and evaluates an XPath 1.0 location
//!   path subset (`/`, `//`, `*`, `@attr`, `text()`, `[n]`, `[last()]`,
//!   `[@a]`, `[@a='v']`, `[child='v']`); several nodes spill as a column,
//!   numeric text reads as a number, no node or malformed XML is `#VALUE!`.
//! - **EUROCONVERT** uses the fixed conversion rates of the euro legacy
//!   currencies with each currency's calculation precision (Microsoft
//!   reference); `triangulation_precision` below 3 is `#VALUE!`.

use compact_str::CompactString;
use sheet_core::{CellError, CellValue};

use super::util::{grid, num, num_or, scalar};
use crate::arg::Arg;
use crate::coerce;
use crate::ctx::EvalCtx;
use crate::result::FnResult;

fn err(e: CellError) -> CellValue {
    CellValue::Error(e)
}

fn text_of(v: &CellValue) -> Result<CompactString, CellError> {
    match v {
        CellValue::Error(e) => Err(*e),
        other => Ok(coerce::to_text(other)),
    }
}

fn arg_text(arg: Option<&Arg>) -> Result<CompactString, CellError> {
    match scalar(arg) {
        Some(v) => text_of(&v),
        None => Err(CellError::Value),
    }
}

/// An integer flag argument restricted to `allowed` (absent / blank = 0).
fn flag(arg: Option<&Arg>, allowed: &[i64]) -> Result<i64, CellError> {
    let x = num_or(arg, 0.0)?.trunc();
    let x = x as i64;
    if allowed.contains(&x) {
        Ok(x)
    } else {
        Err(CellError::Value)
    }
}

macro_rules! tri {
    ($e:expr) => {
        match $e {
            Ok(v) => v,
            Err(e) => return CellValue::Error(e),
        }
    };
}

// ---- regular expressions -----------------------------------------------------

/// Translate the PCRE pattern for fancy-regex: drop `(?#…)` comments and map
/// `\p{L}` / `\p{N}` onto the linked Perl classes (outside brackets).
fn translate_pattern(p: &str) -> String {
    let mut out = String::with_capacity(p.len());
    let b: Vec<char> = p.chars().collect();
    let mut i = 0;
    let mut in_class = false;
    while i < b.len() {
        let c = b[i];
        // \p{L} / \P{L} / \p{N}: the general-category tables are not
        // linked (wasm size); the common letter and number classes map onto
        // the Unicode Perl classes, which are.
        if !in_class && c == '\\' && matches!(b.get(i + 1), Some('p' | 'P')) {
            let rest: String = b[i + 2..].iter().take(10).collect();
            let negate = b[i + 1] == 'P';
            let map = [
                ("{L}", "[^\\W\\d_]", "[\\W\\d_]"),
                ("{Letter}", "[^\\W\\d_]", "[\\W\\d_]"),
                ("{N}", "\\d", "\\D"),
                ("{Nd}", "\\d", "\\D"),
            ];
            if let Some((name, pos, neg)) = map.iter().find(|(n, _, _)| rest.starts_with(n)) {
                out.push_str(if negate { neg } else { pos });
                i += 2 + name.chars().count();
                continue;
            }
        }
        if c == '\\' && i + 1 < b.len() {
            out.push(c);
            out.push(b[i + 1]);
            i += 2;
            continue;
        }
        if in_class {
            if c == ']' {
                in_class = false;
            }
            out.push(c);
            i += 1;
            continue;
        }
        if c == '[' {
            in_class = true;
            out.push(c);
            i += 1;
            continue;
        }
        if c == '(' && b.get(i + 1) == Some(&'?') && b.get(i + 2) == Some(&'#') {
            while i < b.len() && b[i] != ')' {
                i += 1;
            }
            i += 1;
            continue;
        }
        out.push(c);
        i += 1;
    }
    out
}

fn compile(pattern: &str, insensitive: bool) -> Result<fancy_regex::Regex, CellError> {
    fancy_regex::RegexBuilder::new(&translate_pattern(pattern))
        .case_insensitive(insensitive)
        .backtrack_limit(1_000_000)
        .build()
        .map_err(|_| CellError::Value)
}

/// Every match as `(start, end)` with PCRE's global iteration.
fn all_matches(re: &fancy_regex::Regex, text: &str) -> Result<Vec<(usize, usize)>, CellError> {
    let mut out = Vec::new();
    let mut pos = 0;
    while pos <= text.len() {
        let Some(m) = re.find_from_pos(text, pos).map_err(|_| CellError::Value)? else {
            break;
        };
        out.push((m.start(), m.end()));
        if m.end() > m.start() {
            pos = m.end();
        } else {
            // Empty match: move one character on.
            match text[m.end()..].chars().next() {
                Some(c) => pos = m.end() + c.len_utf8(),
                None => break,
            }
        }
    }
    Ok(out)
}

/// `REGEXTEST(text, pattern, [case_sensitivity])`.
pub fn regextest(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    let text = tri!(arg_text(args.first()));
    let pat = tri!(arg_text(args.get(1)));
    let ci = tri!(flag(args.get(2), &[0, 1]));
    let re = tri!(compile(&pat, ci == 1));
    match re.is_match(&text) {
        Ok(b) => CellValue::Bool(b),
        Err(_) => err(CellError::Value),
    }
}

fn extract_one(text: &str, re: &fancy_regex::Regex, mode: i64) -> FnResult {
    let fail = |e| FnResult::Scalar(err(e));
    match mode {
        0 => match re.find(text) {
            Ok(Some(m)) => FnResult::Scalar(CellValue::Text(m.as_str().into())),
            Ok(None) => fail(CellError::Na),
            Err(_) => fail(CellError::Value),
        },
        1 => match all_matches(re, text) {
            Ok(v) if v.is_empty() => fail(CellError::Na),
            Ok(v) => FnResult::Array(vec![v
                .into_iter()
                .map(|(s, e)| CellValue::Text(text[s..e].into()))
                .collect()]),
            Err(e) => fail(e),
        },
        _ => {
            if re.captures_len() <= 1 {
                return fail(CellError::Value);
            }
            match re.captures(text) {
                Ok(Some(c)) => FnResult::Array(vec![(1..c.len())
                    .map(|i| match c.get(i) {
                        Some(m) => CellValue::Text(m.as_str().into()),
                        None => err(CellError::Na),
                    })
                    .collect()]),
                Ok(None) => fail(CellError::Na),
                Err(_) => fail(CellError::Value),
            }
        }
    }
}

/// `REGEXEXTRACT(text, pattern, [return_mode], [case_sensitivity])`. A range
/// of texts in mode 0 maps element by element.
pub fn regexextract(args: &[Arg], _ctx: &EvalCtx) -> FnResult {
    let fail = |e| FnResult::Scalar(err(e));
    let pat = match arg_text(args.get(1)) {
        Ok(p) => p,
        Err(e) => return fail(e),
    };
    let mode = match flag(args.get(2), &[0, 1, 2]) {
        Ok(m) => m,
        Err(e) => return fail(e),
    };
    let ci = match flag(args.get(3), &[0, 1]) {
        Ok(c) => c,
        Err(e) => return fail(e),
    };
    let re = match compile(&pat, ci == 1) {
        Ok(r) => r,
        Err(e) => return fail(e),
    };
    match &args[0] {
        Arg::Range(r) if mode == 0 && (r.rows() > 1 || r.cols() > 1) => FnResult::Array(
            grid(&args[0])
                .into_iter()
                .map(|row| {
                    row.into_iter()
                        .map(|v| match text_of(&v) {
                            Ok(t) => match extract_one(&t, &re, 0) {
                                FnResult::Scalar(x) => x,
                                FnResult::Array(_) => err(CellError::Value),
                            },
                            Err(e) => err(e),
                        })
                        .collect()
                })
                .collect(),
        ),
        _ => match arg_text(args.first()) {
            Ok(t) => extract_one(&t, &re, mode),
            Err(e) => fail(e),
        },
    }
}

/// One piece of a parsed PCRE2 extended replacement.
enum Piece {
    Lit(String),
    Group(usize),
    Case(char),
}

fn parse_replacement(rep: &str, re: &fancy_regex::Regex) -> Result<Vec<Piece>, CellError> {
    let names: Vec<Option<&str>> = re.capture_names().collect();
    let ngroups = re.captures_len();
    let group_of = |name: &str| -> Result<usize, CellError> {
        if let Ok(n) = name.parse::<usize>() {
            return if n < ngroups {
                Ok(n)
            } else {
                Err(CellError::Value)
            };
        }
        names
            .iter()
            .position(|n| *n == Some(name))
            .ok_or(CellError::Value)
    };
    let chars: Vec<char> = rep.chars().collect();
    let mut out = Vec::new();
    let mut lit = String::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '$' {
            let next = chars.get(i + 1).copied().ok_or(CellError::Value)?;
            if next == '$' {
                lit.push('$');
                i += 2;
                continue;
            }
            let (name, adv) = if next == '{' {
                let close = chars[i + 2..]
                    .iter()
                    .position(|&x| x == '}')
                    .ok_or(CellError::Value)?;
                (
                    chars[i + 2..i + 2 + close].iter().collect::<String>(),
                    close + 3,
                )
            } else if next.is_ascii_digit() {
                let len = chars[i + 1..]
                    .iter()
                    .take_while(|x| x.is_ascii_digit())
                    .count();
                (chars[i + 1..i + 1 + len].iter().collect(), len + 1)
            } else if next.is_alphanumeric() || next == '_' {
                let len = chars[i + 1..]
                    .iter()
                    .take_while(|x| x.is_alphanumeric() || **x == '_')
                    .count();
                (chars[i + 1..i + 1 + len].iter().collect(), len + 1)
            } else {
                return Err(CellError::Value);
            };
            if !lit.is_empty() {
                out.push(Piece::Lit(std::mem::take(&mut lit)));
            }
            out.push(Piece::Group(group_of(&name)?));
            i += adv;
            continue;
        }
        if c == '\\' {
            let next = chars.get(i + 1).copied().ok_or(CellError::Value)?;
            match next {
                'u' | 'l' | 'U' | 'L' | 'E' => {
                    if !lit.is_empty() {
                        out.push(Piece::Lit(std::mem::take(&mut lit)));
                    }
                    out.push(Piece::Case(next));
                }
                'n' => lit.push('\n'),
                't' => lit.push('\t'),
                'r' => lit.push('\r'),
                d if d.is_ascii_digit() => return Err(CellError::Value),
                other => lit.push(other),
            }
            i += 2;
            continue;
        }
        lit.push(c);
        i += 1;
    }
    if !lit.is_empty() {
        out.push(Piece::Lit(lit));
    }
    Ok(out)
}

/// Expand a parsed replacement for one match, applying the case escapes.
fn expand(pieces: &[Piece], caps: &fancy_regex::Captures, out: &mut String) {
    let mut one: Option<char> = None; // 'u' / 'l' for the next character
    let mut all: Option<char> = None; // 'U' / 'L' until \E
    let mut push = |s: &str, one: &mut Option<char>, all: Option<char>| {
        for ch in s.chars() {
            let ch: String = match (one.take(), all) {
                (Some('u'), _) => ch.to_uppercase().collect(),
                (Some('l'), _) => ch.to_lowercase().collect(),
                (_, Some('U')) => ch.to_uppercase().collect(),
                (_, Some('L')) => ch.to_lowercase().collect(),
                _ => ch.to_string(),
            };
            out.push_str(&ch);
        }
    };
    for p in pieces {
        match p {
            Piece::Lit(s) => push(s, &mut one, all),
            Piece::Group(g) => {
                let s = caps.get(*g).map(|m| m.as_str()).unwrap_or("");
                push(s, &mut one, all);
            }
            Piece::Case('E') => {
                all = None;
                one = None;
            }
            Piece::Case(c @ ('U' | 'L')) => all = Some(*c),
            Piece::Case(c) => one = Some(*c),
        }
    }
}

/// `REGEXREPLACE(text, pattern, replacement, [occurrence], [case_sensitivity])`.
pub fn regexreplace(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    let text = tri!(arg_text(args.first()));
    let pat = tri!(arg_text(args.get(1)));
    let rep = tri!(arg_text(args.get(2)));
    let occ = tri!(num_or(args.get(3), 0.0)).trunc();
    let ci = tri!(flag(args.get(4), &[0, 1]));
    let re = tri!(compile(&pat, ci == 1));
    let pieces = tri!(parse_replacement(&rep, &re));
    let spans = tri!(all_matches(&re, &text));
    let n = spans.len() as i64;
    let pick: Option<usize> = if occ == 0.0 {
        None
    } else {
        let k = occ as i64;
        let idx = if k > 0 { k - 1 } else { n + k };
        if idx < 0 || idx >= n {
            return CellValue::Text(text);
        }
        Some(idx as usize)
    };
    let mut out = String::with_capacity(text.len());
    let mut last = 0;
    for (i, &(s, e)) in spans.iter().enumerate() {
        if pick.is_some_and(|p| p != i) {
            continue;
        }
        out.push_str(&text[last..s]);
        match re.captures_from_pos(&text, s) {
            Ok(Some(c)) => expand(&pieces, &c, &mut out),
            _ => return err(CellError::Value),
        }
        last = e;
    }
    out.push_str(&text[last..]);
    CellValue::Text(out.into())
}

// ---- array / value to text --------------------------------------------------------

fn strict_value(v: &CellValue) -> String {
    match v {
        CellValue::Text(t) => format!("\"{}\"", t.replace('"', "\"\"")),
        other => coerce::to_text(other).to_string(),
    }
}

/// `ARRAYTOTEXT(array, [format])`.
pub fn arraytotext(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    // A scalar error (not an error inside an array) propagates.
    if let Arg::Scalar(CellValue::Error(e)) = &args[0] {
        return err(*e);
    }
    let strict = tri!(flag(args.get(1), &[0, 1])) == 1;
    let g = grid(&args[0]);
    if strict {
        let rows: Vec<String> = g
            .iter()
            .map(|r| r.iter().map(strict_value).collect::<Vec<_>>().join(","))
            .collect();
        CellValue::Text(format!("{{{}}}", rows.join(";")).into())
    } else {
        let parts: Vec<String> = g
            .iter()
            .flatten()
            .map(|v| coerce::to_text(v).to_string())
            .collect();
        CellValue::Text(parts.join(", ").into())
    }
}

/// `VALUETOTEXT(value, [format])`.
pub fn valuetotext(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    let strict = tri!(flag(args.get(1), &[0, 1])) == 1;
    let v = scalar(args.first()).unwrap_or(CellValue::Empty);
    let s = if strict {
        strict_value(&v)
    } else {
        coerce::to_text(&v).to_string()
    };
    CellValue::Text(s.into())
}

// ---- BAHTTEXT ------------------------------------------------------------------------

const THAI_DIGITS: [&str; 10] = [
    "ศูนย์",
    "หนึ่ง",
    "สอง",
    "สาม",
    "สี่",
    "ห้า",
    "หก",
    "เจ็ด",
    "แปด",
    "เก้า",
];
const THAI_PLACES: [&str; 6] = ["", "สิบ", "ร้อย", "พัน", "หมื่น", "แสน"];

/// Thai words for `n < 1_000_000`; `higher` = digits stand above this group
/// (a final 1 is then เอ็ด).
fn thai_group(n: u64, higher: bool, out: &mut String) {
    let digits: Vec<u64> = (0..6).map(|i| (n / 10u64.pow(i)) % 10).collect();
    for place in (0..6).rev() {
        let d = digits[place] as usize;
        if d == 0 {
            continue;
        }
        match place {
            0 => {
                let above = higher || n >= 10;
                out.push_str(if d == 1 && above {
                    "เอ็ด"
                } else {
                    THAI_DIGITS[d]
                });
            }
            1 => {
                match d {
                    1 => {}
                    2 => out.push_str("ยี่"),
                    _ => out.push_str(THAI_DIGITS[d]),
                }
                out.push_str(THAI_PLACES[1]);
            }
            p => {
                out.push_str(THAI_DIGITS[d]);
                out.push_str(THAI_PLACES[p]);
            }
        }
    }
}

/// Thai words for any non-negative integer (groups of a million, ล้าน).
fn thai_number(n: u64, higher: bool, out: &mut String) {
    if n >= 1_000_000 {
        thai_number(n / 1_000_000, higher, out);
        out.push_str("ล้าน");
        thai_group(n % 1_000_000, true, out);
    } else {
        thai_group(n, higher, out);
    }
}

/// `BAHTTEXT(number)`.
pub fn bahttext(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    let x = tri!(super::util::atp_num(args.first()));
    if !x.is_finite() || x.abs() >= 1e18 {
        return err(CellError::Num);
    }
    let cents = (x.abs() * 100.0).round() as u64;
    let (baht, satang) = (cents / 100, cents % 100);
    let mut out = String::new();
    if x < 0.0 && cents > 0 {
        out.push_str("ลบ");
    }
    if baht > 0 {
        thai_number(baht, false, &mut out);
        out.push_str("บาท");
    }
    if satang > 0 {
        thai_group(satang, false, &mut out);
        out.push_str("สตางค์");
    } else if baht > 0 {
        out.push_str("ถ้วน");
    } else {
        out.push_str("ศูนย์บาทถ้วน");
    }
    CellValue::Text(out.into())
}

// ---- width functions, phonetic --------------------------------------------------

/// `ASC(text)`, `DBCS(text)`, `JIS(text)` — unchanged outside a DBCS locale.
pub fn width_identity(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    match arg_text(args.first()) {
        Ok(t) => CellValue::Text(t),
        Err(e) => err(e),
    }
}

/// `PHONETIC(reference)` — the top-left cell's text.
pub fn phonetic(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    match scalar(args.first()) {
        Some(CellValue::Error(e)) => err(e),
        Some(v) => CellValue::Text(coerce::to_text(&v)),
        None => err(CellError::Value),
    }
}

// ---- ENCODEURL -----------------------------------------------------------------------

/// `ENCODEURL(text)`.
pub fn encodeurl(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    let t = tri!(arg_text(args.first()));
    let mut out = String::with_capacity(t.len());
    for b in t.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    CellValue::Text(out.into())
}

// ---- FILTERXML -------------------------------------------------------------------------

/// A parsed XML element.
#[derive(Debug, Default)]
struct Node {
    name: String,
    attrs: Vec<(String, String)>,
    children: Vec<Child>,
}

#[derive(Debug)]
enum Child {
    El(Node),
    Text(String),
}

impl Node {
    fn text(&self) -> String {
        let mut s = String::new();
        for c in &self.children {
            match c {
                Child::Text(t) => s.push_str(t),
                Child::El(n) => s.push_str(&n.text()),
            }
        }
        s
    }

    fn elements(&self) -> impl Iterator<Item = &Node> {
        self.children.iter().filter_map(|c| match c {
            Child::El(n) => Some(n),
            Child::Text(_) => None,
        })
    }
}

fn unescape_xml(s: &str) -> Option<String> {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        let semi = rest[i..].find(';')? + i;
        let ent = &rest[i + 1..semi];
        let ch = match ent {
            "lt" => '<',
            "gt" => '>',
            "amp" => '&',
            "quot" => '"',
            "apos" => '\'',
            _ if ent.starts_with("#x") => char::from_u32(u32::from_str_radix(&ent[2..], 16).ok()?)?,
            _ if ent.starts_with('#') => char::from_u32(ent[1..].parse().ok()?)?,
            _ => return None,
        };
        out.push(ch);
        rest = &rest[semi + 1..];
    }
    out.push_str(rest);
    Some(out)
}

/// A small well-formedness-checking XML parser (elements, attributes, text,
/// CDATA, comments; declarations and processing instructions skipped).
struct XmlParser<'a> {
    s: &'a str,
    i: usize,
}

impl<'a> XmlParser<'a> {
    fn starts(&self, p: &str) -> bool {
        self.s[self.i..].starts_with(p)
    }

    fn skip_ws(&mut self) {
        while self.i < self.s.len() && self.s.as_bytes()[self.i].is_ascii_whitespace() {
            self.i += 1;
        }
    }

    fn skip_misc(&mut self) -> Option<()> {
        loop {
            self.skip_ws();
            if self.starts("<?") {
                self.i += self.s[self.i..].find("?>")? + 2;
            } else if self.starts("<!--") {
                self.i += self.s[self.i..].find("-->")? + 3;
            } else if self.starts("<!DOCTYPE") {
                self.i += self.s[self.i..].find('>')? + 1;
            } else {
                return Some(());
            }
        }
    }

    fn name(&mut self) -> Option<String> {
        let start = self.i;
        while self.i < self.s.len() {
            let c = self.s[self.i..].chars().next()?;
            if c.is_alphanumeric() || matches!(c, '_' | '-' | '.' | ':') {
                self.i += c.len_utf8();
            } else {
                break;
            }
        }
        (self.i > start).then(|| self.s[start..self.i].to_string())
    }

    fn element(&mut self) -> Option<Node> {
        if !self.starts("<") {
            return None;
        }
        self.i += 1;
        let mut node = Node {
            name: self.name()?,
            ..Node::default()
        };
        loop {
            self.skip_ws();
            if self.starts("/>") {
                self.i += 2;
                return Some(node);
            }
            if self.starts(">") {
                self.i += 1;
                break;
            }
            let key = self.name()?;
            self.skip_ws();
            if !self.starts("=") {
                return None;
            }
            self.i += 1;
            self.skip_ws();
            let q = self.s[self.i..].chars().next()?;
            if q != '"' && q != '\'' {
                return None;
            }
            self.i += 1;
            let end = self.s[self.i..].find(q)? + self.i;
            let val = unescape_xml(&self.s[self.i..end])?;
            self.i = end + 1;
            node.attrs.push((key, val));
        }
        loop {
            if self.starts("</") {
                self.i += 2;
                let close = self.name()?;
                self.skip_ws();
                if close != node.name || !self.starts(">") {
                    return None;
                }
                self.i += 1;
                return Some(node);
            }
            if self.starts("<!--") {
                self.i += self.s[self.i..].find("-->")? + 3;
            } else if self.starts("<![CDATA[") {
                let start = self.i + 9;
                let end = self.s[start..].find("]]>")? + start;
                node.children
                    .push(Child::Text(self.s[start..end].to_string()));
                self.i = end + 3;
            } else if self.starts("<?") {
                self.i += self.s[self.i..].find("?>")? + 2;
            } else if self.starts("<") {
                let child = self.element()?;
                node.children.push(Child::El(child));
            } else {
                let end = self.s[self.i..].find('<')? + self.i;
                let t = unescape_xml(&self.s[self.i..end])?;
                node.children.push(Child::Text(t));
                self.i = end;
            }
        }
    }

    fn document(s: &'a str) -> Option<Node> {
        let mut p = XmlParser { s, i: 0 };
        p.skip_misc()?;
        let root = p.element()?;
        p.skip_misc()?;
        (p.i == s.len()).then_some(root)
    }
}

/// One XPath result: an element's text or an attribute value.
fn xpath(root: &Node, path: &str) -> Option<Vec<String>> {
    let path = path.trim();
    if !path.starts_with('/') {
        return None;
    }
    // Tokenise into (descendant, step) pairs.
    let mut steps: Vec<(bool, String)> = Vec::new();
    let mut rest = path;
    while !rest.is_empty() {
        let desc = rest.starts_with("//");
        rest = &rest[if desc { 2 } else { 1 }..];
        let mut depth = 0;
        let mut end = rest.len();
        for (i, c) in rest.char_indices() {
            match c {
                '[' => depth += 1,
                ']' => depth -= 1,
                '/' if depth == 0 => {
                    end = i;
                    break;
                }
                _ => {}
            }
        }
        steps.push((desc, rest[..end].to_string()));
        rest = &rest[end..];
    }
    // Context: a list of element references; start with a virtual parent of
    // the root element.
    let holder = [root];
    let mut ctx: Vec<&Node> = Vec::new();
    let mut first = true;
    let mut out_text: Option<Vec<String>> = None;
    for (i, (desc, step)) in steps.iter().enumerate() {
        let last_step = i + 1 == steps.len();
        let (test, preds) = match step.find('[') {
            Some(p) => (&step[..p], &step[p..]),
            None => (step.as_str(), ""),
        };
        if let Some(attr) = test.strip_prefix('@') {
            if !last_step || !preds.is_empty() {
                return None;
            }
            let base: Vec<&Node> = if *desc {
                ctx.iter().flat_map(|n| descendants_or_self(n)).collect()
            } else {
                ctx.clone()
            };
            out_text = Some(
                base.iter()
                    .filter_map(|n| {
                        n.attrs
                            .iter()
                            .find(|(k, _)| k == attr)
                            .map(|(_, v)| v.clone())
                    })
                    .collect(),
            );
            break;
        }
        if test == "text()" {
            if !last_step {
                return None;
            }
            out_text = Some(
                ctx.iter()
                    .flat_map(|n| {
                        n.children.iter().filter_map(|c| match c {
                            Child::Text(t) => Some(t.clone()),
                            Child::El(_) => None,
                        })
                    })
                    .collect(),
            );
            break;
        }
        let mut next: Vec<&Node> = Vec::new();
        let groups: Vec<Vec<&Node>> = if first {
            let base: Vec<&Node> = holder.to_vec();
            if *desc {
                vec![base.iter().flat_map(|n| descendants_or_self(n)).collect()]
            } else {
                vec![base]
            }
        } else if *desc {
            ctx.iter()
                .map(|n| n.elements().flat_map(|c| descendants_or_self(c)).collect())
                .collect()
        } else {
            ctx.iter()
                .map(|p| p.elements().collect::<Vec<_>>())
                .collect()
        };
        for g in groups {
            let matched: Vec<&Node> = g
                .into_iter()
                .filter(|n| test == "*" || n.name == test)
                .collect();
            next.extend(apply_predicates(matched, preds)?);
        }
        ctx = next;
        first = false;
    }
    Some(out_text.unwrap_or_else(|| ctx.iter().map(|n| n.text()).collect()))
}

fn descendants_or_self(n: &Node) -> Vec<&Node> {
    let mut out = vec![n];
    for c in n.elements() {
        out.extend(descendants_or_self(c));
    }
    out
}

fn apply_predicates<'n>(mut set: Vec<&'n Node>, preds: &str) -> Option<Vec<&'n Node>> {
    let mut rest = preds;
    while let Some(r) = rest.strip_prefix('[') {
        let close = r.find(']')?;
        let p = r[..close].trim();
        rest = &r[close + 1..];
        set = if p == "last()" {
            set.last().copied().into_iter().collect()
        } else if let Ok(k) = p.parse::<usize>() {
            set.get(k.wrapping_sub(1)).copied().into_iter().collect()
        } else if let Some(a) = p.strip_prefix('@') {
            match a.split_once('=') {
                Some((k, v)) => {
                    let v = v.trim().trim_matches(|c| c == '\'' || c == '"');
                    let k = k.trim();
                    set.into_iter()
                        .filter(|n| n.attrs.iter().any(|(ak, av)| ak == k && av == v))
                        .collect()
                }
                None => set
                    .into_iter()
                    .filter(|n| n.attrs.iter().any(|(ak, _)| ak == a.trim()))
                    .collect(),
            }
        } else if let Some((k, v)) = p.split_once('=') {
            let v = v.trim().trim_matches(|c| c == '\'' || c == '"');
            let k = k.trim();
            set.into_iter()
                .filter(|n| n.elements().any(|c| c.name == k && c.text() == v))
                .collect()
        } else {
            return None;
        };
    }
    rest.is_empty().then_some(set)
}

fn xml_value(s: String) -> CellValue {
    match coerce::to_number(&CellValue::Text(s.as_str().into())) {
        Ok(n) if !s.trim().is_empty() => CellValue::Number(n),
        _ => CellValue::Text(s.into()),
    }
}

/// `FILTERXML(xml, xpath)`.
pub fn filterxml(args: &[Arg], _ctx: &EvalCtx) -> FnResult {
    let fail = |e| FnResult::Scalar(err(e));
    let (xml, path) = match (arg_text(args.first()), arg_text(args.get(1))) {
        (Ok(a), Ok(b)) => (a, b),
        (Err(e), _) | (_, Err(e)) => return fail(e),
    };
    let Some(root) = XmlParser::document(&xml) else {
        return fail(CellError::Value);
    };
    match xpath(&root, &path) {
        Some(v) if v.len() == 1 => {
            FnResult::Scalar(xml_value(v.into_iter().next().unwrap_or_default()))
        }
        Some(v) if !v.is_empty() => {
            FnResult::Array(v.into_iter().map(|s| vec![xml_value(s)]).collect())
        }
        _ => fail(CellError::Value),
    }
}

// ---- EUROCONVERT -----------------------------------------------------------------------

/// `(units per euro, calculation precision)` of a euro legacy currency.
fn euro_rate(code: &str) -> Option<(f64, i32)> {
    Some(match code.to_ascii_uppercase().as_str() {
        "BEF" | "LUF" => (40.3399, 0),
        "DEM" => (1.95583, 2),
        "ESP" => (166.386, 0),
        "FRF" => (6.55957, 2),
        "IEP" => (0.787564, 2),
        "ITL" => (1936.27, 0),
        "NLG" => (2.20371, 2),
        "ATS" => (13.7603, 2),
        "PTE" => (200.482, 1),
        "FIM" => (5.94573, 2),
        "GRD" => (340.750, 0),
        "SIT" => (239.640, 2),
        "EUR" => (1.0, 2),
        _ => return None,
    })
}

fn round_to(x: f64, digits: i32) -> f64 {
    let f = 10f64.powi(digits);
    (x * f).round() / f
}

/// `EUROCONVERT(number, source, target, [full_precision], [triangulation_precision])`.
pub fn euroconvert(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    let x = tri!(num(args.first()));
    let src = tri!(arg_text(args.get(1)));
    let dst = tri!(arg_text(args.get(2)));
    let full = tri!(super::util::bool_arg_or(args.get(3), false));
    let tri_prec = match args.get(4) {
        None | Some(Arg::Scalar(CellValue::Empty)) => None,
        Some(a) => {
            let p = tri!(num(Some(a))).trunc();
            if p < 3.0 {
                return err(CellError::Value);
            }
            Some(p as usize)
        }
    };
    let (Some((rs, _)), Some((rd, pd))) = (euro_rate(&src), euro_rate(&dst)) else {
        return err(CellError::Value);
    };
    let mut euros = x / rs;
    if let Some(p) = tri_prec {
        if rs != 1.0 && rd != 1.0 {
            euros = super::util::round_sig(euros, p);
        }
    }
    let v = euros * rd;
    CellValue::Number(if full { v } else { round_to(v, pd) })
}
