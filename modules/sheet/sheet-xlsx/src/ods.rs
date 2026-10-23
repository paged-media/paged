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

//! OpenDocument spreadsheet READ (`.ods`, `.ots`; sheet ADR 521). The
//! document becomes an ordinary SpreadsheetML package — the way the CSV
//! import does it — which then opens through [`crate::XlsxDocument::open`],
//! so an imported ODS edits, saves (as `.xlsx`) and lowers like any
//! workbook and nothing downstream needs an ODS case. It is a one-way
//! import: nothing is written back as ODS.
//!
//! What is read (OpenDocument 1.2/1.3, `content.xml` + `styles.xml`):
//!
//! - every table as a sheet, in order, with its name (made a legal Excel
//!   sheet name); a table whose style hides it is a hidden sheet;
//! - cell values by `office:value-type`: numbers, percentages and currency
//!   from `office:value`, dates and times as serials, booleans, text
//!   (paragraphs joined by line breaks; annotations and frames skipped);
//!   repeated rows and columns are expanded only where they hold something;
//! - formulas: the OpenFormula `of:=` text translated to Excel's syntax
//!   (`[.A1:.B2]` → `A1:B2`, `[Sheet2.C3]` → `Sheet2!C3`, `;` → `,`, inline
//!   arrays, `!` intersection), with the cached value kept beside it. A
//!   formula the translation cannot express (a union `~`, an external
//!   reference) keeps only its cached value; one the engine then cannot
//!   parse keeps its text and cached value like any unparsed formula;
//! - named ranges and named expressions as defined names;
//! - merged cells (`number-columns-spanned` / `number-rows-spanned`);
//! - cell styles: the data style as an Excel number-format code (number,
//!   percentage, currency, scientific, fraction, date, time and text styles,
//!   with `style:map` sections and a red negative colour), bold, italic,
//!   underline, font colour, the background fill, horizontal alignment and
//!   wrapping, resolved through the style's parents.
//!
//! What is not: column widths and row heights, borders, conditional formats,
//! validations, charts and images, comments, and a null date other than
//! 1899-12-30 or 1904-01-01.

use std::collections::BTreeMap;

use quick_xml::events::{BytesStart, Event};

use crate::error::XlsxError;

/// The OpenDocument spreadsheet media types (`mimetype`).
const ODS_MIME: &str = "application/vnd.oasis.opendocument.spreadsheet";
const OTS_MIME: &str = "application/vnd.oasis.opendocument.spreadsheet-template";

/// The cap on cells a repeated run may materialize (a styled empty run of a
/// million rows is common and means nothing).
const MAX_RUN_CELLS: u64 = 100_000;

/// Excel's last 0-based row and column.
const MAX_ROW: u32 = 1_048_575;
const MAX_COL: u32 = 16_383;

/// Is `bytes` an OpenDocument spreadsheet (by its `mimetype` entry)?
pub fn is_ods(bytes: &[u8]) -> bool {
    // The first entry is the uncompressed `mimetype` (ODF 1.2 §3.3), so the
    // media type sits at a fixed offset; reading the zip confirms it.
    bytes.starts_with(b"PK")
        && bytes
            .windows(ODS_MIME.len())
            .take(128)
            .any(|w| w == ODS_MIME.as_bytes())
}

/// The attributes of one element: `(qualified name, value)`.
fn attrs(e: &BytesStart<'_>) -> Result<Vec<(String, String)>, XlsxError> {
    let mut out = Vec::new();
    for a in e.attributes() {
        let a = a.map_err(quick_xml::Error::from)?;
        let k = String::from_utf8_lossy(a.key.as_ref()).into_owned();
        let v = a
            .normalized_value(quick_xml::XmlVersion::Implicit1_0)?
            .into_owned();
        out.push((k, v));
    }
    Ok(out)
}

/// An attribute by qualified name, else by local name.
fn get<'a>(a: &'a [(String, String)], qname: &str) -> Option<&'a str> {
    a.iter()
        .find(|(k, _)| k == qname)
        .or_else(|| {
            let local = qname.rsplit(':').next().unwrap_or(qname);
            a.iter()
                .find(|(k, _)| k.rsplit(':').next() == Some(local) && !k.starts_with("calcext:"))
        })
        .map(|(_, v)| v.as_str())
}

fn local(qname: &[u8]) -> &[u8] {
    match qname.iter().position(|&b| b == b':') {
        Some(i) => &qname[i + 1..],
        None => qname,
    }
}

// ───────────────────────────────────────────────────────────── styles

/// One element of an ODF data style.
#[derive(Debug, Clone)]
enum Piece {
    Number {
        decimals: Option<u32>,
        min_int: u32,
        grouping: bool,
    },
    Scientific {
        decimals: u32,
        min_int: u32,
        exp_digits: u32,
    },
    Fraction {
        min_int: Option<u32>,
        num_digits: u32,
        den_digits: u32,
        den_value: Option<u32>,
    },
    Text(String),
    Currency(String),
    TextContent,
    Day(bool),
    Month {
        long: bool,
        textual: bool,
    },
    Year(bool),
    DayOfWeek(bool),
    Hours(bool),
    Minutes(bool),
    Seconds {
        long: bool,
        decimals: u32,
    },
    AmPm,
    Boolean,
}

#[derive(Debug, Clone, Default)]
struct DataStyle {
    percentage: bool,
    /// `number:truncate-on-overflow="false"`: elapsed hours (`[h]`).
    elapsed: bool,
    pieces: Vec<Piece>,
    /// `(condition, applied style name)`.
    maps: Vec<(String, String)>,
    red: bool,
}

#[derive(Debug, Clone, Default)]
struct CellStyleDef {
    parent: Option<String>,
    data_style: Option<String>,
    bold: Option<bool>,
    italic: Option<bool>,
    underline: Option<bool>,
    color: Option<String>,
    fill: Option<Option<String>>,
    align: Option<String>,
    wrap: Option<bool>,
}

/// A small name → value table (a few hundred styles at most): a linear
/// scan keeps the wasm free of another hash map instantiation.
struct Named<T>(Vec<(String, T)>);

impl<T> Default for Named<T> {
    fn default() -> Self {
        Named(Vec::new())
    }
}

impl<T> Named<T> {
    fn get(&self, name: &str) -> Option<&T> {
        self.0.iter().rev().find(|(n, _)| n == name).map(|(_, v)| v)
    }

    fn insert(&mut self, name: String, value: T) {
        self.0.push((name, value));
    }
}

#[derive(Default)]
struct Styles {
    data: Named<DataStyle>,
    cells: Named<CellStyleDef>,
    /// Table styles that hide their table.
    hidden_tables: Vec<String>,
}

/// `#rrggbb` → `FFRRGGBB`.
fn argb(hex: &str) -> Option<String> {
    let h = hex.trim().strip_prefix('#')?;
    (h.len() == 6 && h.chars().all(|c| c.is_ascii_hexdigit()))
        .then(|| format!("FF{}", h.to_ascii_uppercase()))
}

fn is_red(hex: &str) -> bool {
    let Some(h) = hex.trim().strip_prefix('#') else {
        return false;
    };
    let c = |i: usize| u8::from_str_radix(h.get(i..i + 2).unwrap_or("00"), 16).unwrap_or(0);
    h.len() == 6 && c(0) > 0x99 && c(2) < 0x60 && c(4) < 0x60
}

/// Read the style definitions of one part (`styles.xml` or `content.xml`).
fn read_styles(xml: &[u8], styles: &mut Styles) -> Result<(), XlsxError> {
    let mut reader = quick_xml::Reader::from_reader(xml);
    reader.config_mut().trim_text(false);
    let mut buf = Vec::new();
    let mut data: Option<(String, DataStyle)> = None;
    let mut cell: Option<(String, CellStyleDef)> = None;
    let mut text: Option<String> = None;
    let mut table_style: Option<String> = None;
    loop {
        let ev = reader.read_event_into(&mut buf)?;
        let (e, empty) = match &ev {
            Event::Start(e) => (Some(e), false),
            Event::Empty(e) => (Some(e), true),
            _ => (None, false),
        };
        if let Some(e) = e {
            let name = e.name();
            let qn = name.as_ref();
            // The automatic styles precede the body; the body holds none.
            if qn == b"office:body" {
                break;
            }
            let a = attrs(e)?;
            match qn {
                b"number:number-style"
                | b"number:percentage-style"
                | b"number:currency-style"
                | b"number:date-style"
                | b"number:time-style"
                | b"number:boolean-style"
                | b"number:text-style" => {
                    let ds = DataStyle {
                        percentage: qn == b"number:percentage-style",
                        elapsed: get(&a, "number:truncate-on-overflow") == Some("false"),
                        ..DataStyle::default()
                    };
                    let name = get(&a, "style:name").unwrap_or("").to_string();
                    if empty {
                        styles.data.insert(name, ds);
                    } else {
                        data = Some((name, ds));
                    }
                }
                _ if data.is_some() => {
                    let (_, ds) = data.as_mut().expect("checked");
                    let num = |k: &str| get(&a, k).and_then(|v| v.trim().parse::<u32>().ok());
                    let long = get(&a, "number:style") == Some("long");
                    let piece = match local(qn) {
                        b"number" => Some(Piece::Number {
                            decimals: num("number:decimal-places"),
                            min_int: num("number:min-integer-digits").unwrap_or(1),
                            grouping: get(&a, "number:grouping") == Some("true"),
                        }),
                        b"scientific-number" => Some(Piece::Scientific {
                            decimals: num("number:decimal-places").unwrap_or(2),
                            min_int: num("number:min-integer-digits").unwrap_or(1),
                            exp_digits: num("number:min-exponent-digits").unwrap_or(2),
                        }),
                        b"fraction" => Some(Piece::Fraction {
                            min_int: num("number:min-integer-digits"),
                            num_digits: num("number:min-numerator-digits").unwrap_or(1),
                            den_digits: num("number:min-denominator-digits").unwrap_or(1),
                            den_value: num("number:denominator-value"),
                        }),
                        b"text-content" => Some(Piece::TextContent),
                        b"day" => Some(Piece::Day(long)),
                        b"month" => Some(Piece::Month {
                            long,
                            textual: get(&a, "number:textual") == Some("true"),
                        }),
                        b"year" => Some(Piece::Year(long)),
                        b"day-of-week" => Some(Piece::DayOfWeek(long)),
                        b"hours" => Some(Piece::Hours(long)),
                        b"minutes" => Some(Piece::Minutes(long)),
                        b"seconds" => Some(Piece::Seconds {
                            long,
                            decimals: num("number:decimal-places").unwrap_or(0),
                        }),
                        b"am-pm" => Some(Piece::AmPm),
                        b"boolean" => Some(Piece::Boolean),
                        b"text" | b"currency-symbol" if !empty => {
                            text = Some(String::new());
                            None
                        }
                        b"map" => {
                            if let (Some(c), Some(s)) = (
                                get(&a, "style:condition"),
                                get(&a, "style:apply-style-name"),
                            ) {
                                ds.maps.push((c.to_string(), s.to_string()));
                            }
                            None
                        }
                        b"text-properties" => {
                            ds.red = get(&a, "fo:color").is_some_and(is_red);
                            None
                        }
                        _ => None,
                    };
                    if let Some(p) = piece {
                        ds.pieces.push(p);
                    }
                }
                b"style:style" => {
                    let family = get(&a, "style:family").unwrap_or("");
                    let name = get(&a, "style:name").unwrap_or("").to_string();
                    if family == "table-cell" {
                        let def = CellStyleDef {
                            parent: get(&a, "style:parent-style-name").map(str::to_string),
                            data_style: get(&a, "style:data-style-name").map(str::to_string),
                            ..CellStyleDef::default()
                        };
                        if empty {
                            styles.cells.insert(name, def);
                        } else {
                            cell = Some((name, def));
                        }
                    } else if family == "table" && !empty {
                        // `table:display` lives on the table-properties child.
                        table_style = Some(name);
                    }
                }
                b"style:table-properties" => {
                    if get(&a, "table:display") == Some("false") {
                        if let Some(name) = table_style.clone() {
                            styles.hidden_tables.push(name);
                        }
                    }
                }
                b"style:text-properties" if cell.is_some() => {
                    let (_, def) = cell.as_mut().expect("checked");
                    if let Some(w) = get(&a, "fo:font-weight") {
                        def.bold = Some(w == "bold" || w.parse::<u32>().is_ok_and(|n| n >= 600));
                    }
                    if let Some(s) = get(&a, "fo:font-style") {
                        def.italic = Some(s == "italic" || s == "oblique");
                    }
                    if let Some(u) = get(&a, "style:text-underline-style") {
                        def.underline = Some(u != "none");
                    }
                    if let Some(c) = get(&a, "fo:color").and_then(argb) {
                        def.color = Some(c);
                    }
                }
                b"style:table-cell-properties" if cell.is_some() => {
                    let (_, def) = cell.as_mut().expect("checked");
                    if let Some(bg) = get(&a, "fo:background-color") {
                        def.fill = Some(argb(bg));
                    }
                    if let Some(w) = get(&a, "fo:wrap-option") {
                        def.wrap = Some(w == "wrap");
                    }
                }
                b"style:paragraph-properties" if cell.is_some() => {
                    let (_, def) = cell.as_mut().expect("checked");
                    if let Some(al) = get(&a, "fo:text-align") {
                        def.align = Some(al.to_string());
                    }
                }
                _ => {}
            }
        }
        match ev {
            Event::Text(t) => {
                if let Some(s) = text.as_mut() {
                    s.push_str(&t.xml10_content()?);
                }
            }
            Event::GeneralRef(r) => {
                if let Some(s) = text.as_mut() {
                    s.push_str(&crate::opc::general_ref(&r)?);
                }
            }
            Event::End(e) => {
                let name = e.name();
                let qn = name.as_ref();
                match qn {
                    b"number:text" | b"number:currency-symbol" => {
                        if let (Some(t), Some((_, ds))) = (text.take(), data.as_mut()) {
                            ds.pieces.push(if qn == b"number:text" {
                                Piece::Text(t)
                            } else {
                                Piece::Currency(t)
                            });
                        }
                    }
                    b"number:number-style"
                    | b"number:percentage-style"
                    | b"number:currency-style"
                    | b"number:date-style"
                    | b"number:time-style"
                    | b"number:boolean-style"
                    | b"number:text-style" => {
                        if let Some((n, ds)) = data.take() {
                            styles.data.insert(n, ds);
                        }
                    }
                    b"style:style" => {
                        if let Some((n, def)) = cell.take() {
                            styles.cells.insert(n, def);
                        }
                        table_style = None;
                    }
                    _ => {}
                }
            }
            Event::Eof => break,
            _ => {}
        }
        buf.clear();
    }
    Ok(())
}

/// A literal in an Excel format code.
fn quote_literal(s: &str, out: &mut String) {
    if s.is_empty() {
        return;
    }
    if s.chars().all(|c| " $-+/():!^&'~{}<>=,".contains(c)) {
        out.push_str(s);
    } else {
        out.push('"');
        out.push_str(&s.replace('"', "\"\""));
        out.push('"');
    }
}

/// One section's code from a data style's pieces.
fn section_code(ds: &DataStyle) -> String {
    let mut out = String::new();
    if ds.red {
        out.push_str("[Red]");
    }
    let mut hours_seen = false;
    for p in &ds.pieces {
        match p {
            Piece::Number {
                decimals,
                min_int,
                grouping,
            } => {
                let int = if *min_int == 0 {
                    "#".to_string()
                } else {
                    "0".repeat(*min_int as usize)
                };
                if *grouping {
                    out.push_str(if int.len() == 1 { "#,##" } else { "#," });
                }
                out.push_str(&int);
                if let Some(d) = decimals.filter(|d| *d > 0) {
                    out.push('.');
                    out.push_str(&"0".repeat(d.min(30) as usize));
                }
            }
            Piece::Scientific {
                decimals,
                min_int,
                exp_digits,
            } => {
                out.push_str(&"0".repeat((*min_int).max(1) as usize));
                if *decimals > 0 {
                    out.push('.');
                    out.push_str(&"0".repeat((*decimals).min(30) as usize));
                }
                out.push_str("E+");
                out.push_str(&"0".repeat((*exp_digits).max(1) as usize));
            }
            Piece::Fraction {
                min_int,
                num_digits,
                den_digits,
                den_value,
            } => {
                if let Some(n) = min_int {
                    out.push_str(if *n == 0 { "#" } else { "0" });
                    out.push(' ');
                }
                out.push_str(&"?".repeat((*num_digits).clamp(1, 5) as usize));
                out.push('/');
                match den_value {
                    Some(d) => out.push_str(&d.to_string()),
                    None => out.push_str(&"?".repeat((*den_digits).clamp(1, 5) as usize)),
                }
            }
            Piece::Text(t) => {
                if ds.percentage && t.contains('%') {
                    let mut parts = t.split('%');
                    quote_literal(parts.next().unwrap_or(""), &mut out);
                    for rest in parts {
                        out.push('%');
                        quote_literal(rest, &mut out);
                    }
                } else {
                    quote_literal(t, &mut out);
                }
            }
            Piece::Currency(sym) => {
                if sym.is_empty() {
                    continue;
                }
                out.push_str("[$");
                out.push_str(&sym.replace(']', ""));
                out.push(']');
            }
            Piece::TextContent => out.push('@'),
            Piece::Day(l) => out.push_str(if *l { "dd" } else { "d" }),
            Piece::Month { long, textual } => out.push_str(match (textual, long) {
                (true, true) => "mmmm",
                (true, false) => "mmm",
                (false, true) => "mm",
                (false, false) => "m",
            }),
            Piece::Year(l) => out.push_str(if *l { "yyyy" } else { "yy" }),
            Piece::DayOfWeek(l) => out.push_str(if *l { "dddd" } else { "ddd" }),
            Piece::Hours(l) => {
                let h = if *l { "hh" } else { "h" };
                if ds.elapsed && !hours_seen {
                    out.push('[');
                    out.push_str(h);
                    out.push(']');
                } else {
                    out.push_str(h);
                }
                hours_seen = true;
            }
            Piece::Minutes(l) => out.push_str(if *l { "mm" } else { "m" }),
            Piece::Seconds { long, decimals } => {
                out.push_str(if *long { "ss" } else { "s" });
                if *decimals > 0 {
                    out.push('.');
                    out.push_str(&"0".repeat((*decimals).min(3) as usize));
                }
            }
            Piece::AmPm => out.push_str("AM/PM"),
            Piece::Boolean => {}
        }
    }
    out
}

/// The Excel number-format code of data style `name`, or `None` for General.
fn number_format(styles: &Styles, name: &str) -> Option<String> {
    let ds = styles.data.get(name)?;
    let general = ds.maps.is_empty()
        && !ds.red
        && matches!(
            ds.pieces.as_slice(),
            [Piece::Number {
                decimals: None,
                grouping: false,
                ..
            }] | [Piece::Boolean]
                | []
        );
    if general {
        return None;
    }
    let own = section_code(ds);
    if ds.maps.is_empty() {
        return Some(own);
    }
    // `style:map` sections: positive, negative, zero, in Excel's order.
    let mut sections: [Option<String>; 3] = [None, None, None];
    for (cond, style) in &ds.maps {
        let c: String = cond.chars().filter(|c| !c.is_whitespace()).collect();
        let slot = if c.contains(">=0") || c.contains(">0") {
            0
        } else if c.contains("<0") {
            1
        } else if c.contains("=0") {
            2
        } else {
            continue;
        };
        if let Some(mapped) = styles.data.get(style) {
            sections[slot] = Some(section_code(mapped));
        }
    }
    if let Some(slot) = sections.iter().position(Option::is_none) {
        sections[slot] = Some(own);
    }
    let last = sections.iter().rposition(Option::is_some).unwrap_or(0);
    Some(
        sections[..=last]
            .iter()
            .map(|s| s.clone().unwrap_or_default())
            .collect::<Vec<_>>()
            .join(";"),
    )
}

/// A resolved cell look: what the generated `styles.xml` needs.
#[derive(Clone, Debug, Default, PartialEq, Eq, Hash)]
struct Look {
    num_fmt: Option<String>,
    bold: bool,
    italic: bool,
    underline: bool,
    color: Option<String>,
    fill: Option<String>,
    align: Option<String>,
    wrap: bool,
}

impl Look {
    fn has_fill(&self) -> bool {
        self.fill.is_some()
    }
}

fn resolve_look(styles: &Styles, name: &str) -> Look {
    let mut def = CellStyleDef::default();
    let mut cur = Some(name.to_string());
    let mut guard = 0;
    while let Some(n) = cur.take() {
        guard += 1;
        let Some(s) = styles.cells.get(&n) else { break };
        def.data_style = def.data_style.or_else(|| s.data_style.clone());
        def.bold = def.bold.or(s.bold);
        def.italic = def.italic.or(s.italic);
        def.underline = def.underline.or(s.underline);
        def.color = def.color.or_else(|| s.color.clone());
        def.fill = def.fill.or_else(|| s.fill.clone());
        def.align = def.align.or_else(|| s.align.clone());
        def.wrap = def.wrap.or(s.wrap);
        if guard < 16 {
            cur = s.parent.clone();
        }
    }
    let align = def.align.and_then(|a| match a.as_str() {
        "center" => Some("center".to_string()),
        "end" | "right" => Some("right".to_string()),
        "start" | "left" => Some("left".to_string()),
        "justify" => Some("justify".to_string()),
        _ => None,
    });
    Look {
        num_fmt: def.data_style.and_then(|d| number_format(styles, &d)),
        bold: def.bold.unwrap_or(false),
        italic: def.italic.unwrap_or(false),
        underline: def.underline.unwrap_or(false),
        color: def.color.filter(|c| c != "FF000000"),
        fill: def.fill.flatten(),
        align,
        wrap: def.wrap.unwrap_or(false),
    }
}

// ─────────────────────────────────────────────────────────── values

/// Days from 1970-01-01 of a civil date (proleptic Gregorian).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = (if y >= 0 { y } else { y - 399 }) / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// An ISO `YYYY-MM-DD[THH:MM:SS[.f]]` date as days since 1970 (fractional).
fn iso_days(s: &str) -> Option<f64> {
    let s = s.trim();
    let (date, time) = match s.split_once('T') {
        Some((d, t)) => (d, Some(t)),
        None => (s, None),
    };
    let mut it = date.splitn(3, '-');
    let (neg, first) = match it.next()? {
        "" => (true, it.next()?),
        y => (false, y),
    };
    let y: i64 = first.parse().ok()?;
    let y = if neg { -y } else { y };
    let m: i64 = it.next()?.parse().ok()?;
    let d: i64 = it.next()?.get(..2).unwrap_or("").parse().ok()?;
    let mut days = days_from_civil(y, m, d) as f64;
    if let Some(t) = time {
        let t = t.trim_end_matches('Z');
        let mut p = t.splitn(3, ':');
        let h: f64 = p.next()?.parse().ok()?;
        let mi: f64 = p.next().unwrap_or("0").parse().ok()?;
        let se: f64 = p.next().unwrap_or("0").parse().ok()?;
        days += (h * 3600.0 + mi * 60.0 + se) / 86_400.0;
    }
    Some(days)
}

/// An ISO 8601 duration (`PT12H30M00S`, `P1DT2H`) in days.
fn iso_duration(s: &str) -> Option<f64> {
    let s = s.trim();
    let (neg, s) = match s.strip_prefix('-') {
        Some(r) => (true, r),
        None => (false, s),
    };
    let s = s.strip_prefix('P')?;
    let mut total = 0.0;
    let mut num = String::new();
    let mut in_time = false;
    for c in s.chars() {
        match c {
            'T' => in_time = true,
            '0'..='9' | '.' | ',' => num.push(if c == ',' { '.' } else { c }),
            _ => {
                let n: f64 = num.parse().ok()?;
                num.clear();
                total += match (c, in_time) {
                    ('D', _) => n * 86_400.0,
                    ('H', true) => n * 3600.0,
                    ('M', true) => n * 60.0,
                    ('S', true) => n,
                    ('Y', false) => n * 365.0 * 86_400.0,
                    ('M', false) => n * 30.0 * 86_400.0,
                    ('W', false) => n * 7.0 * 86_400.0,
                    _ => return None,
                };
            }
        }
    }
    let days = total / 86_400.0;
    Some(if neg { -days } else { days })
}

/// The cached value of one cell.
#[derive(Debug, Clone, PartialEq)]
enum Value {
    Empty,
    Number(f64),
    Bool(bool),
    Text(String),
    Error(&'static str),
}

const EXCEL_ERRORS: [&str; 7] = [
    "#NULL!", "#DIV/0!", "#VALUE!", "#REF!", "#NAME?", "#NUM!", "#N/A",
];

// ────────────────────────────────────────────────────────── formulas

/// A sheet name as a formula writes it (quoted unless a plain identifier).
fn sheet_prefix(name: &str) -> String {
    let plain = name
        .chars()
        .next()
        .is_some_and(|c| c.is_alphabetic() || c == '_')
        && name.chars().all(|c| c.is_alphanumeric() || c == '_')
        && !looks_like_ref(name);
    if plain {
        name.to_string()
    } else {
        format!("'{}'", name.replace('\'', "''"))
    }
}

/// A name that would read as a cell reference (`A1`, `R1C1`).
fn looks_like_ref(name: &str) -> bool {
    let up = name.to_ascii_uppercase();
    let letters = up.chars().take_while(char::is_ascii_alphabetic).count();
    letters > 0
        && letters <= 3
        && up.len() > letters
        && up[letters..].chars().all(|c| c.is_ascii_digit())
        || up.starts_with('R') && up[1..].chars().any(|c| c == 'C')
}

/// One endpoint of an ODF reference: `$Sheet.$A$1`, `.A1`, `'x y'.A:A`.
struct RefPart {
    sheet: Option<String>,
    cell: String,
}

fn parse_ref_part(s: &str) -> Option<RefPart> {
    let s = s.trim();
    let (sheet, cell) = if let Some(rest) = s.strip_prefix('.') {
        (None, rest)
    } else {
        let rest = s.strip_prefix('$').unwrap_or(s);
        if let Some(q) = rest.strip_prefix('\'') {
            // A quoted sheet name, `''` escaping a quote.
            let mut name = String::new();
            let mut chars = q.char_indices().peekable();
            let mut end = None;
            while let Some((i, c)) = chars.next() {
                if c == '\'' {
                    if chars.peek().is_some_and(|(_, n)| *n == '\'') {
                        name.push('\'');
                        chars.next();
                    } else {
                        end = Some(i + 1);
                        break;
                    }
                } else {
                    name.push(c);
                }
            }
            let tail = &q[end?..];
            (Some(name), tail.strip_prefix('.')?)
        } else {
            let (name, cell) = rest.rsplit_once('.')?;
            (Some(name.to_string()), cell)
        }
    };
    let ok = !cell.is_empty()
        && cell.chars().all(|c| c.is_ascii_alphanumeric() || c == '$')
        && !cell.contains('#');
    ok.then(|| RefPart {
        sheet,
        cell: cell.to_ascii_uppercase(),
    })
}

/// An ODF reference body (inside `[` `]`, or a bare range address) as Excel
/// text. `None` for what Excel cannot say (an external document).
fn translate_ref(body: &str, names: &BTreeMap<String, String>) -> Option<String> {
    let body = body.trim();
    if body.starts_with("#REF") {
        return Some("#REF!".into());
    }
    // Split at the `:` outside quotes.
    let mut split = None;
    let mut quoted = false;
    for (i, c) in body.char_indices() {
        match c {
            '\'' => quoted = !quoted,
            ':' if !quoted => {
                split = Some(i);
                break;
            }
            _ => {}
        }
    }
    let rename = |s: &str| names.get(s).cloned().unwrap_or_else(|| s.to_string());
    match split {
        None => {
            let p = parse_ref_part(body)?;
            Some(match p.sheet {
                Some(s) => format!("{}!{}", sheet_prefix(&rename(&s)), p.cell),
                None => p.cell,
            })
        }
        Some(i) => {
            let a = parse_ref_part(&body[..i])?;
            let b = parse_ref_part(&body[i + 1..])?;
            let range = format!("{}:{}", a.cell, b.cell);
            Some(match (a.sheet, b.sheet) {
                (Some(s1), Some(s2)) if s1 != s2 => {
                    // A 3D reference: `First:Last!A1:B2`, quoted as one.
                    let (s1, s2) = (rename(&s1), rename(&s2));
                    let joined = format!("{s1}:{s2}");
                    let q = sheet_prefix(&s1) != s1 || sheet_prefix(&s2) != s2;
                    if q {
                        format!("'{}'!{range}", joined.replace('\'', "''"))
                    } else {
                        format!("{joined}!{range}")
                    }
                }
                (Some(s), _) => format!("{}!{range}", sheet_prefix(&rename(&s))),
                (None, _) => range,
            })
        }
    }
}

/// An OpenFormula cell formula (`of:=SUM([.A1:.B2])`) as Excel formula text
/// without the `=` (`SUM(A1:B2)`). `None` when it holds something Excel
/// cannot say, or is not OpenFormula. `names` renames sheets the import had
/// to rename.
fn translate_formula(src: &str, names: &BTreeMap<String, String>) -> Option<String> {
    let (ns, body) = match src.split_once(':') {
        Some((ns, b)) if !ns.contains(['(', '[', '"']) => (ns, b),
        _ => ("of", src),
    };
    let body = body.strip_prefix('=').unwrap_or(body);
    match ns {
        "msoxl" => return Some(body.to_string()),
        "of" | "oooc" => {}
        _ => return None,
    }
    let chars: Vec<char> = body.chars().collect();
    let mut out = String::with_capacity(body.len());
    let mut braces = 0usize;
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        match c {
            '"' => {
                out.push('"');
                i += 1;
                while i < chars.len() {
                    out.push(chars[i]);
                    if chars[i] == '"' {
                        if chars.get(i + 1) == Some(&'"') {
                            out.push('"');
                            i += 2;
                            continue;
                        }
                        i += 1;
                        break;
                    }
                    i += 1;
                }
            }
            '[' => {
                let start = i + 1;
                let mut quoted = false;
                i += 1;
                while i < chars.len() && (quoted || chars[i] != ']') {
                    if chars[i] == '\'' {
                        quoted = !quoted;
                    }
                    i += 1;
                }
                let inner: String = chars[start..i.min(chars.len())].iter().collect();
                i += 1;
                out.push_str(&translate_ref(&inner, names)?);
            }
            '{' => {
                braces += 1;
                out.push(c);
                i += 1;
            }
            '}' => {
                braces = braces.saturating_sub(1);
                out.push(c);
                i += 1;
            }
            ';' => {
                out.push(',');
                i += 1;
            }
            '|' if braces > 0 => {
                out.push(';');
                i += 1;
            }
            '~' => return None,
            '!' => {
                out.push(' ');
                i += 1;
            }
            c if c.is_alphabetic() || c == '_' => {
                let start = i;
                while i < chars.len()
                    && (chars[i].is_alphanumeric() || matches!(chars[i], '_' | '.'))
                {
                    i += 1;
                }
                let word: String = chars[start..i].iter().collect();
                if chars.get(i) == Some(&'(') {
                    let up = word.to_ascii_uppercase();
                    let name = up
                        .strip_prefix("COM.MICROSOFT.")
                        .or_else(|| up.strip_prefix("LEGACY."))
                        .or_else(|| up.strip_prefix("_XLFN."))
                        .unwrap_or(&up);
                    out.push_str(name);
                } else {
                    out.push_str(&word);
                }
            }
            _ => {
                out.push(c);
                i += 1;
            }
        }
    }
    Some(out)
}

// ─────────────────────────────────────────────────────────── content

#[derive(Default)]
struct Sheet {
    name: String,
    hidden: bool,
    /// `(row, col)` → (value, formula, look index).
    cells: BTreeMap<(u32, u32), (Value, Option<String>, usize)>,
    merges: Vec<(u32, u32, u32, u32)>,
}

/// The cell being read.
#[derive(Default)]
struct CellState {
    covered: bool,
    repeat: u32,
    span_cols: u32,
    span_rows: u32,
    value_type: Option<String>,
    value: Option<String>,
    date: Option<String>,
    time: Option<String>,
    boolean: Option<String>,
    string: Option<String>,
    formula: Option<String>,
    style: Option<String>,
    paragraphs: Vec<String>,
}

struct Reader<'s> {
    styles: &'s Styles,
    looks: Vec<Look>,
    look_ids: Named<usize>,
    sheets: Vec<Sheet>,
    /// ODS sheet name → the name Excel gets.
    renames: BTreeMap<String, String>,
    names: Vec<(String, String)>,
    /// Days since 1970 of the null date.
    null_date: f64,
    date1904: bool,
}

impl Reader<'_> {
    fn look(&mut self, style: Option<&str>) -> usize {
        let Some(style) = style else { return 0 };
        if let Some(&i) = self.look_ids.get(style) {
            return i;
        }
        let look = resolve_look(self.styles, style);
        let i = match self.looks.iter().position(|l| *l == look) {
            Some(i) => i,
            None => {
                self.looks.push(look);
                self.looks.len() - 1
            }
        };
        self.look_ids.insert(style.to_string(), i);
        i
    }

    fn date_serial(&self, days_1970: f64) -> f64 {
        let serial = days_1970 - self.null_date;
        if self.date1904 || serial >= 61.0 || serial < 1.0 {
            serial
        } else {
            // Excel's 1900 calendar counts a 29 February 1900.
            serial - 1.0
        }
    }

    fn cell_value(&self, c: &CellState) -> Value {
        let text = || c.paragraphs.join("\n");
        match c.value_type.as_deref() {
            Some("float" | "percentage" | "currency") => c
                .value
                .as_deref()
                .and_then(|v| v.trim().parse().ok())
                .map(Value::Number)
                .unwrap_or(Value::Empty),
            Some("date") => c
                .date
                .as_deref()
                .and_then(iso_days)
                .map(|d| Value::Number(self.date_serial(d)))
                .unwrap_or(Value::Empty),
            Some("time") => c
                .time
                .as_deref()
                .and_then(iso_duration)
                .map(Value::Number)
                .unwrap_or(Value::Empty),
            Some("boolean") => Value::Bool(matches!(
                c.boolean.as_deref().map(str::trim),
                Some("true" | "1")
            )),
            Some("string") => Value::Text(c.string.clone().unwrap_or_else(text)),
            _ => {
                let t = text();
                if let Some(e) = EXCEL_ERRORS.iter().find(|e| **e == t) {
                    Value::Error(e)
                } else if c.formula.is_some() && t.starts_with("Err:") {
                    Value::Error("#VALUE!")
                } else if t.is_empty() {
                    Value::Empty
                } else {
                    Value::Text(t)
                }
            }
        }
    }
}

/// Legal, unique Excel sheet names for the ODS tables.
fn excel_sheet_name(raw: &str, taken: &[Sheet]) -> String {
    let base: String = raw
        .chars()
        .filter(|c| !matches!(c, ':' | '\\' | '/' | '?' | '*' | '[' | ']'))
        .take(31)
        .collect();
    let base = base.trim_matches('\'').to_string();
    let base = if base.is_empty() {
        format!("Sheet{}", taken.len() + 1)
    } else {
        base
    };
    let mut name = base.clone();
    let mut n = 2;
    while taken.iter().any(|s| s.name.eq_ignore_ascii_case(&name)) {
        let suffix = format!(" ({n})");
        let keep = 31usize.saturating_sub(suffix.chars().count());
        name = format!("{}{suffix}", base.chars().take(keep).collect::<String>());
        n += 1;
    }
    name
}

fn read_content(xml: &[u8], r: &mut Reader<'_>) -> Result<(), XlsxError> {
    let mut reader = quick_xml::Reader::from_reader(xml);
    reader.config_mut().trim_text(false);
    let mut buf = Vec::new();
    let mut sheet: Option<Sheet> = None;
    let mut col_defaults: Vec<(u32, Option<String>)> = Vec::new();
    let mut row: u32 = 0;
    let mut col: u32 = 0;
    let mut row_repeat: u32 = 1;
    let mut row_default: Option<String> = None;
    let mut row_cells: Vec<(u32, Value, Option<String>, usize)> = Vec::new();
    let mut row_merges: Vec<(u32, u32, u32)> = Vec::new();
    let mut cell: Option<CellState> = None;
    let mut para: Option<String> = None;
    // Inside an annotation, a frame or a shape: text that is not the cell's.
    let mut skip_depth = 0usize;

    loop {
        let ev = reader.read_event_into(&mut buf)?;
        match &ev {
            Event::Start(e) | Event::Empty(e) => {
                let empty = matches!(ev, Event::Empty(_));
                let name = e.name();
                let qn = name.as_ref();
                if skip_depth > 0 {
                    if !empty {
                        skip_depth += 1;
                    }
                    buf.clear();
                    continue;
                }
                match qn {
                    b"office:annotation" | b"draw:frame" | b"draw:custom-shape"
                    | b"table:shapes"
                        if !empty =>
                    {
                        skip_depth = 1;
                    }
                    b"table:null-date" => {
                        let a = attrs(e)?;
                        if let Some(d) = get(&a, "table:date-value").and_then(iso_days) {
                            r.null_date = d;
                            r.date1904 = d == days_from_civil(1904, 1, 1) as f64;
                        }
                    }
                    b"table:table" => {
                        let a = attrs(e)?;
                        let raw = get(&a, "table:name").unwrap_or("");
                        let name = excel_sheet_name(raw, &r.sheets);
                        if name != raw {
                            r.renames.insert(raw.to_string(), name.clone());
                        }
                        let hidden = get(&a, "table:style-name")
                            .is_some_and(|s| r.styles.hidden_tables.iter().any(|h| h == s));
                        sheet = Some(Sheet {
                            name,
                            hidden,
                            ..Sheet::default()
                        });
                        col_defaults.clear();
                        row = 0;
                    }
                    b"table:table-column" => {
                        let a = attrs(e)?;
                        let n = get(&a, "table:number-columns-repeated")
                            .and_then(|v| v.parse().ok())
                            .unwrap_or(1u32);
                        let style = get(&a, "table:default-cell-style-name")
                            .filter(|s| *s != "Default")
                            .map(str::to_string);
                        col_defaults.push((n, style));
                    }
                    b"table:table-row" => {
                        let a = attrs(e)?;
                        row_repeat = get(&a, "table:number-rows-repeated")
                            .and_then(|v| v.parse().ok())
                            .unwrap_or(1u32)
                            .max(1);
                        row_default = get(&a, "table:default-cell-style-name").map(str::to_string);
                        col = 0;
                        row_cells.clear();
                        row_merges.clear();
                        if empty {
                            row = row.saturating_add(row_repeat);
                        }
                    }
                    b"table:table-cell" | b"table:covered-table-cell" => {
                        let a = attrs(e)?;
                        let num = |k: &str| get(&a, k).and_then(|v| v.parse::<u32>().ok());
                        let c = CellState {
                            covered: qn == b"table:covered-table-cell",
                            repeat: num("table:number-columns-repeated").unwrap_or(1).max(1),
                            span_cols: num("table:number-columns-spanned").unwrap_or(1),
                            span_rows: num("table:number-rows-spanned").unwrap_or(1),
                            value_type: get(&a, "office:value-type").map(str::to_string),
                            value: get(&a, "office:value").map(str::to_string),
                            date: get(&a, "office:date-value").map(str::to_string),
                            time: get(&a, "office:time-value").map(str::to_string),
                            boolean: get(&a, "office:boolean-value").map(str::to_string),
                            string: get(&a, "office:string-value").map(str::to_string),
                            formula: get(&a, "table:formula").map(str::to_string),
                            style: get(&a, "table:style-name").map(str::to_string),
                            paragraphs: Vec::new(),
                        };
                        if empty {
                            finish_cell(
                                r,
                                c,
                                &mut col,
                                &col_defaults,
                                row_default.as_deref(),
                                &mut row_cells,
                                &mut row_merges,
                            );
                        } else {
                            cell = Some(c);
                        }
                    }
                    b"text:p" | b"text:h" if cell.is_some() => {
                        if empty {
                            if let Some(c) = cell.as_mut() {
                                c.paragraphs.push(String::new());
                            }
                        } else {
                            para = Some(String::new());
                        }
                    }
                    b"text:s" => {
                        if let Some(p) = para.as_mut() {
                            let a = attrs(e)?;
                            let n = get(&a, "text:c")
                                .and_then(|v| v.parse::<usize>().ok())
                                .unwrap_or(1);
                            p.push_str(&" ".repeat(n.min(1000)));
                        }
                    }
                    b"text:tab" => {
                        if let Some(p) = para.as_mut() {
                            p.push('\t');
                        }
                    }
                    b"text:line-break" => {
                        if let Some(p) = para.as_mut() {
                            p.push('\n');
                        }
                    }
                    b"table:named-range" | b"table:named-expression" => {
                        let a = attrs(e)?;
                        if let Some(n) = get(&a, "table:name") {
                            if let Some(addr) = get(&a, "table:cell-range-address") {
                                r.names.push((n.to_string(), format!("@{addr}")));
                            } else if let Some(x) = get(&a, "table:expression") {
                                r.names.push((n.to_string(), x.to_string()));
                            }
                        }
                    }
                    _ => {}
                }
            }
            Event::End(e) => {
                let name = e.name();
                let qn = name.as_ref();
                if skip_depth > 0 {
                    skip_depth -= 1;
                    buf.clear();
                    continue;
                }
                match qn {
                    b"text:p" | b"text:h" => {
                        if let (Some(p), Some(c)) = (para.take(), cell.as_mut()) {
                            c.paragraphs.push(p);
                        }
                    }
                    b"table:table-cell" | b"table:covered-table-cell" => {
                        if let Some(c) = cell.take() {
                            finish_cell(
                                r,
                                c,
                                &mut col,
                                &col_defaults,
                                row_default.as_deref(),
                                &mut row_cells,
                                &mut row_merges,
                            );
                        }
                    }
                    b"table:table-row" => {
                        if let Some(s) = sheet.as_mut() {
                            // A repeated row materializes only what it holds,
                            // and only within the cap.
                            let reps = if row_cells.is_empty() {
                                0
                            } else {
                                let per = row_cells.len() as u64;
                                (u64::from(row_repeat))
                                    .min(MAX_RUN_CELLS / per.max(1))
                                    .max(1) as u32
                            };
                            for k in 0..reps {
                                let at = row.saturating_add(k);
                                if at > MAX_ROW {
                                    break;
                                }
                                for (c, v, f, look) in &row_cells {
                                    s.cells.insert((at, *c), (v.clone(), f.clone(), *look));
                                }
                            }
                            for (c, cs, rs) in &row_merges {
                                let r1 = row.saturating_add(rs - 1).min(MAX_ROW);
                                let c1 = c.saturating_add(cs - 1).min(MAX_COL);
                                if row <= MAX_ROW && (r1 > row || c1 > *c) {
                                    s.merges.push((row, *c, r1, c1));
                                }
                            }
                        }
                        row = row.saturating_add(row_repeat);
                        row_cells.clear();
                        row_merges.clear();
                    }
                    b"table:table" => {
                        if let Some(s) = sheet.take() {
                            r.sheets.push(s);
                        }
                    }
                    _ => {}
                }
            }
            Event::Text(t) => {
                if let Some(p) = para.as_mut() {
                    p.push_str(&t.xml10_content()?);
                }
            }
            Event::GeneralRef(g) => {
                if let Some(p) = para.as_mut() {
                    p.push_str(&crate::opc::general_ref(g)?);
                }
            }
            Event::CData(c) => {
                if let Some(p) = para.as_mut() {
                    p.push_str(&String::from_utf8_lossy(c));
                }
            }
            Event::Eof => break,
            _ => {}
        }
        buf.clear();
    }
    Ok(())
}

/// The default style of 0-based column `col` from the column runs.
fn column_default(runs: &[(u32, Option<String>)], col: u32) -> Option<&str> {
    let mut at = 0u32;
    for (n, s) in runs {
        at = at.saturating_add(*n);
        if col < at {
            return s.as_deref();
        }
    }
    None
}

#[allow(clippy::too_many_arguments)]
fn finish_cell(
    r: &mut Reader<'_>,
    c: CellState,
    col: &mut u32,
    col_defaults: &[(u32, Option<String>)],
    row_default: Option<&str>,
    row_cells: &mut Vec<(u32, Value, Option<String>, usize)>,
    row_merges: &mut Vec<(u32, u32, u32)>,
) {
    let start = *col;
    *col = col.saturating_add(c.repeat);
    if c.covered || start > MAX_COL {
        return;
    }
    let value = r.cell_value(&c);
    let formula = c
        .formula
        .as_deref()
        .and_then(|f| translate_formula(f, &r.renames));
    if c.span_cols > 1 || c.span_rows > 1 {
        row_merges.push((start, c.span_cols.max(1), c.span_rows.max(1)));
    }
    let style = c
        .style
        .clone()
        .or_else(|| row_default.map(str::to_string))
        .or_else(|| column_default(col_defaults, start).map(str::to_string));
    let look = r.look(style.as_deref());
    let has_content = value != Value::Empty || formula.is_some();
    if !has_content && !r.looks[look].has_fill() {
        return;
    }
    let reps = if has_content {
        c.repeat
    } else {
        // A styled empty run: kept only while it is small.
        if u64::from(c.repeat) > MAX_RUN_CELLS / 100 {
            return;
        }
        c.repeat
    };
    for k in 0..reps {
        let at = start.saturating_add(k);
        if at > MAX_COL {
            break;
        }
        row_cells.push((at, value.clone(), formula.clone(), look));
    }
}

// ─────────────────────────────────────────────────────────── writing

fn esc(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn col_name(mut c: u32) -> String {
    let mut s = Vec::new();
    loop {
        s.push(b'A' + (c % 26) as u8);
        if c < 26 {
            break;
        }
        c = c / 26 - 1;
    }
    s.reverse();
    String::from_utf8(s).expect("ascii")
}

fn a1(row: u32, col: u32) -> String {
    format!("{}{}", col_name(col), row + 1)
}

fn num_text(n: f64) -> String {
    if n.fract() == 0.0 && n.abs() < 1e15 {
        format!("{}", n as i64)
    } else {
        format!("{n}")
    }
}

/// The generated `styles.xml` and each look's `cellXfs` index.
fn styles_xml(looks: &[Look]) -> (String, Vec<usize>) {
    let mut num_fmts: Vec<String> = Vec::new();
    let mut fonts: Vec<(bool, bool, bool, Option<String>)> = vec![(false, false, false, None)];
    let mut fills: Vec<String> = Vec::new();
    let mut xfs: Vec<String> =
        vec![r#"<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>"#.to_string()];
    let mut xf_of = Vec::with_capacity(looks.len());
    for look in looks {
        if *look == Look::default() {
            xf_of.push(0);
            continue;
        }
        let fmt_id = match &look.num_fmt {
            None => 0,
            Some(code) => {
                let i = match num_fmts.iter().position(|c| c == code) {
                    Some(i) => i,
                    None => {
                        num_fmts.push(code.clone());
                        num_fmts.len() - 1
                    }
                };
                164 + i
            }
        };
        let font = (look.bold, look.italic, look.underline, look.color.clone());
        let font_id = match fonts.iter().position(|f| *f == font) {
            Some(i) => i,
            None => {
                fonts.push(font);
                fonts.len() - 1
            }
        };
        let fill_id = match &look.fill {
            None => 0,
            Some(c) => {
                let i = match fills.iter().position(|f| f == c) {
                    Some(i) => i,
                    None => {
                        fills.push(c.clone());
                        fills.len() - 1
                    }
                };
                2 + i
            }
        };
        let mut xf = format!(
            r#"<xf numFmtId="{fmt_id}" fontId="{font_id}" fillId="{fill_id}" borderId="0" xfId="0""#
        );
        if fmt_id != 0 {
            xf.push_str(r#" applyNumberFormat="1""#);
        }
        if font_id != 0 {
            xf.push_str(r#" applyFont="1""#);
        }
        if fill_id != 0 {
            xf.push_str(r#" applyFill="1""#);
        }
        if look.align.is_some() || look.wrap {
            xf.push_str(r#" applyAlignment="1"><alignment"#);
            if let Some(h) = &look.align {
                xf.push_str(&format!(r#" horizontal="{h}""#));
            }
            if look.wrap {
                xf.push_str(r#" wrapText="1""#);
            }
            xf.push_str("/></xf>");
        } else {
            xf.push_str("/>");
        }
        let i = match xfs.iter().position(|x| *x == xf) {
            Some(i) => i,
            None => {
                xfs.push(xf);
                xfs.len() - 1
            }
        };
        xf_of.push(i);
    }
    let mut s = String::from(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">"#,
    );
    if !num_fmts.is_empty() {
        s.push_str(&format!(r#"<numFmts count="{}">"#, num_fmts.len()));
        for (i, code) in num_fmts.iter().enumerate() {
            s.push_str(&format!(
                r#"<numFmt numFmtId="{}" formatCode="{}"/>"#,
                164 + i,
                esc(code)
            ));
        }
        s.push_str("</numFmts>");
    }
    s.push_str(&format!(r#"<fonts count="{}">"#, fonts.len()));
    for (b, i, u, color) in &fonts {
        s.push_str("<font>");
        if *b {
            s.push_str("<b/>");
        }
        if *i {
            s.push_str("<i/>");
        }
        if *u {
            s.push_str("<u/>");
        }
        s.push_str(r#"<sz val="11"/>"#);
        if let Some(c) = color {
            s.push_str(&format!(r#"<color rgb="{c}"/>"#));
        }
        s.push_str(r#"<name val="Calibri"/></font>"#);
    }
    s.push_str("</fonts>");
    s.push_str(&format!(
        r#"<fills count="{}"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>"#,
        2 + fills.len()
    ));
    for c in &fills {
        s.push_str(&format!(
            r#"<fill><patternFill patternType="solid"><fgColor rgb="{c}"/><bgColor indexed="64"/></patternFill></fill>"#
        ));
    }
    s.push_str("</fills>");
    s.push_str(
        r#"<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>"#,
    );
    s.push_str(&format!(r#"<cellXfs count="{}">"#, xfs.len()));
    for x in &xfs {
        s.push_str(x);
    }
    s.push_str(
        r#"</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>"#,
    );
    (s, xf_of)
}

fn sheet_xml(s: &Sheet, xf_of: &[usize]) -> String {
    let mut out = String::from(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>"#,
    );
    let mut cur_row: Option<u32> = None;
    for (&(r, c), (v, f, look)) in &s.cells {
        if cur_row != Some(r) {
            if cur_row.is_some() {
                out.push_str("</row>");
            }
            out.push_str(&format!(r#"<row r="{}">"#, r + 1));
            cur_row = Some(r);
        }
        let xf = xf_of.get(*look).copied().unwrap_or(0);
        let st = if xf == 0 {
            String::new()
        } else {
            format!(r#" s="{xf}""#)
        };
        let fx = f
            .as_ref()
            .map(|f| format!("<f>{}</f>", esc(f)))
            .unwrap_or_default();
        let at = a1(r, c);
        match v {
            Value::Empty => out.push_str(&format!(r#"<c r="{at}"{st}>{fx}</c>"#)),
            Value::Number(n) => out.push_str(&format!(
                r#"<c r="{at}"{st}>{fx}<v>{}</v></c>"#,
                num_text(*n)
            )),
            Value::Bool(b) => out.push_str(&format!(
                r#"<c r="{at}"{st} t="b">{fx}<v>{}</v></c>"#,
                u8::from(*b)
            )),
            Value::Error(e) => out.push_str(&format!(
                r#"<c r="{at}"{st} t="e">{fx}<v>{}</v></c>"#,
                esc(e)
            )),
            Value::Text(t) if f.is_some() => out.push_str(&format!(
                r#"<c r="{at}"{st} t="str">{fx}<v>{}</v></c>"#,
                esc(t)
            )),
            Value::Text(t) => out.push_str(&format!(
                r#"<c r="{at}"{st} t="inlineStr"><is><t xml:space="preserve">{}</t></is></c>"#,
                esc(t)
            )),
        }
    }
    if cur_row.is_some() {
        out.push_str("</row>");
    }
    out.push_str("</sheetData>");
    if !s.merges.is_empty() {
        out.push_str(&format!(r#"<mergeCells count="{}">"#, s.merges.len()));
        for (r0, c0, r1, c1) in &s.merges {
            out.push_str(&format!(
                r#"<mergeCell ref="{}:{}"/>"#,
                a1(*r0, *c0),
                a1(*r1, *c1)
            ));
        }
        out.push_str("</mergeCells>");
    }
    out.push_str("</worksheet>");
    out
}

/// A defined name's Excel text from an ODS named range (`@` + a range
/// address) or named expression.
fn defined_name_text(raw: &str, renames: &BTreeMap<String, String>) -> Option<String> {
    match raw.strip_prefix('@') {
        Some(addr) => translate_ref(addr, renames),
        None => translate_formula(raw, renames),
    }
}

/// Convert an OpenDocument spreadsheet into an XLSX package.
pub fn ods_to_xlsx(bytes: &[u8]) -> Result<Vec<u8>, XlsxError> {
    let mut mime: Option<String> = None;
    let mut content: Option<Vec<u8>> = None;
    let mut styles_part: Option<Vec<u8>> = None;
    paged_ooxml::read_zip_each(bytes, crate::MAX_UNCOMPRESSED_BYTES, |entry| {
        if let paged_ooxml::ZipEntry::File { name, bytes } = entry {
            match name.as_str() {
                "mimetype" => mime = Some(String::from_utf8_lossy(&bytes).trim().to_string()),
                "content.xml" => content = Some(bytes),
                "styles.xml" => styles_part = Some(bytes),
                _ => {}
            }
        }
        Ok::<(), XlsxError>(())
    })?;
    if let Some(m) = &mime {
        if m != ODS_MIME && m != OTS_MIME {
            return Err(XlsxError::Structure(format!(
                "not an OpenDocument spreadsheet ({m})"
            )));
        }
    }
    let content = content.ok_or_else(|| XlsxError::Structure("ods: missing content.xml".into()))?;
    let mut styles = Styles::default();
    if let Some(s) = &styles_part {
        read_styles(s, &mut styles)?;
    }
    read_styles(&content, &mut styles)?;

    let mut r = Reader {
        styles: &styles,
        looks: vec![Look::default()],
        look_ids: Named::default(),
        sheets: Vec::new(),
        renames: BTreeMap::new(),
        names: Vec::new(),
        null_date: days_from_civil(1899, 12, 30) as f64,
        date1904: false,
    };
    read_content(&content, &mut r)?;
    if r.sheets.is_empty() {
        r.sheets.push(Sheet {
            name: "Sheet1".into(),
            ..Sheet::default()
        });
    }
    if r.sheets.iter().all(|s| s.hidden) {
        r.sheets[0].hidden = false;
    }

    let (styles_xml, xf_of) = styles_xml(&r.looks);
    let mut files: Vec<(String, String)> = Vec::new();
    let mut overrides = String::new();
    let mut rels = String::new();
    let mut sheets_xml = String::new();
    for (i, s) in r.sheets.iter().enumerate() {
        let n = i + 1;
        overrides.push_str(&format!(
            r#"<Override PartName="/xl/worksheets/sheet{n}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>"#
        ));
        rels.push_str(&format!(
            r#"<Relationship Id="rId{n}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet{n}.xml"/>"#
        ));
        let state = if s.hidden { r#" state="hidden""# } else { "" };
        sheets_xml.push_str(&format!(
            r#"<sheet name="{}" sheetId="{n}"{state} r:id="rId{n}"/>"#,
            esc(&s.name)
        ));
        files.push((format!("xl/worksheets/sheet{n}.xml"), sheet_xml(s, &xf_of)));
    }
    let styles_rid = r.sheets.len() + 1;
    rels.push_str(&format!(
        r#"<Relationship Id="rId{styles_rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>"#
    ));
    let mut defined = String::new();
    for (name, raw) in &r.names {
        if let Some(text) = defined_name_text(raw, &r.renames) {
            defined.push_str(&format!(
                r#"<definedName name="{}">{}</definedName>"#,
                esc(name),
                esc(&text)
            ));
        }
    }
    let defined = if defined.is_empty() {
        String::new()
    } else {
        format!("<definedNames>{defined}</definedNames>")
    };
    let wb_pr = if r.date1904 {
        r#"<workbookPr date1904="1"/>"#
    } else {
        ""
    };
    files.push((
        "xl/workbook.xml".into(),
        format!(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">{wb_pr}<sheets>{sheets_xml}</sheets>{defined}</workbook>"#
        ),
    ));
    files.push((
        "xl/_rels/workbook.xml.rels".into(),
        format!(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">{rels}</Relationships>"#
        ),
    ));
    files.push(("xl/styles.xml".into(), styles_xml));
    files.push((
        "[Content_Types].xml".into(),
        format!(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>{overrides}</Types>"#
        ),
    ));
    files.push((
        "_rels/.rels".into(),
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>"#
            .into(),
    ));
    // `[Content_Types].xml` first, as Office writes it.
    files.rotate_right(2);
    Ok(crate::write::write_package(
        files.iter().map(|(n, b)| (n.as_str(), b.as_bytes())),
    ))
}

#[cfg(test)]
#[allow(non_snake_case)]
mod tests {
    use super::*;

    fn names() -> BTreeMap<String, String> {
        BTreeMap::new()
    }

    #[test]
    fn openformula_translates_to_excel__feat__sheet_import_ods() {
        let t = |s: &str| translate_formula(s, &names());
        assert_eq!(t("of:=SUM([.A1:.B2])").as_deref(), Some("SUM(A1:B2)"));
        assert_eq!(
            t("of:=IF([.A1]>0;[Sheet2.$C$3];\"a;b\")").as_deref(),
            Some("IF(A1>0,Sheet2!$C$3,\"a;b\")")
        );
        assert_eq!(
            t("of:=['My Sheet'.A1]+[$Data.B2]").as_deref(),
            Some("'My Sheet'!A1+Data!B2")
        );
        assert_eq!(
            t("of:=SUM([Jan.A1:Mar.A1])").as_deref(),
            Some("SUM(Jan:Mar!A1:A1)")
        );
        assert_eq!(t("of:={1;2|3;4}").as_deref(), Some("{1,2;3,4}"));
        assert_eq!(
            t("of:=COM.MICROSOFT.IFS([.A1]=1;\"x\")").as_deref(),
            Some("IFS(A1=1,\"x\")")
        );
        assert_eq!(t("of:=[.A1:.B2]![.B1:.C3]").as_deref(), Some("A1:B2 B1:C3"));
        assert_eq!(t("of:=SUM([.A1]~[.B1])"), None);
        assert_eq!(t("msoxl:=SUM(A1,B1)").as_deref(), Some("SUM(A1,B1)"));
        assert_eq!(t("of:=[#REF!]+1").as_deref(), Some("#REF!+1"));
        assert_eq!(t("of:=SUM([.A:.A])").as_deref(), Some("SUM(A:A)"));
    }

    #[test]
    fn dates_times_and_durations__feat__sheet_import_ods() {
        let null = days_from_civil(1899, 12, 30) as f64;
        let serial = |s: &str| iso_days(s).unwrap() - null;
        assert_eq!(serial("2026-10-04"), 46299.0);
        assert_eq!(serial("1900-03-01"), 61.0);
        assert!((serial("2026-10-04T12:00:00") - 46299.5).abs() < 1e-9);
        assert!((iso_duration("PT12H30M00S").unwrap() - 0.520_833_333).abs() < 1e-6);
        assert!((iso_duration("PT36H").unwrap() - 1.5).abs() < 1e-9);
        assert!((iso_duration("P1DT6H").unwrap() - 1.25).abs() < 1e-9);
    }

    #[test]
    fn data_styles_become_format_codes__feat__sheet_import_ods() {
        let xml = r##"<office:document-styles xmlns:office="o" xmlns:number="n" xmlns:style="s" xmlns:fo="f"><office:styles>
<number:number-style style:name="N2"><number:number number:decimal-places="2" number:min-integer-digits="1" number:grouping="true"/></number:number-style>
<number:percentage-style style:name="P1"><number:number number:decimal-places="1" number:min-integer-digits="1"/><number:text>%</number:text></number:percentage-style>
<number:date-style style:name="D1"><number:day number:style="long"/><number:text>.</number:text><number:month number:style="long"/><number:text>.</number:text><number:year number:style="long"/></number:date-style>
<number:time-style style:name="T1" number:truncate-on-overflow="false"><number:hours/><number:text>:</number:text><number:minutes number:style="long"/></number:time-style>
<number:currency-style style:name="C0P0"><number:number number:decimal-places="2" number:min-integer-digits="1" number:grouping="true"/><number:text> </number:text><number:currency-symbol>€</number:currency-symbol></number:currency-style>
<number:currency-style style:name="C0"><style:text-properties fo:color="#ff0000"/><number:text>-</number:text><number:number number:decimal-places="2" number:min-integer-digits="1" number:grouping="true"/><number:text> </number:text><number:currency-symbol>€</number:currency-symbol><style:map style:condition="value()&gt;=0" style:apply-style-name="C0P0"/></number:currency-style>
<number:number-style style:name="G"><number:number number:min-integer-digits="1"/></number:number-style>
</office:styles></office:document-styles>"##
            .as_bytes();
        let mut s = Styles::default();
        read_styles(xml, &mut s).unwrap();
        assert_eq!(number_format(&s, "N2").as_deref(), Some("#,##0.00"));
        assert_eq!(number_format(&s, "P1").as_deref(), Some("0.0%"));
        assert_eq!(
            number_format(&s, "D1").as_deref(),
            Some("dd\".\"mm\".\"yyyy")
        );
        assert_eq!(number_format(&s, "T1").as_deref(), Some("[h]:mm"));
        assert_eq!(
            number_format(&s, "C0").as_deref(),
            Some("#,##0.00 [$€];[Red]-#,##0.00 [$€]")
        );
        assert_eq!(number_format(&s, "G"), None);
    }
}
