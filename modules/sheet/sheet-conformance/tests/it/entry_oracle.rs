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

// Test names end in `__feat__<cockpit id>` (the cockpit linking convention).
#![allow(non_snake_case)]

//! The Excel oracle's ENTRY lane (ruling `sheet.edit.typed-entry`).
//!
//! `oracle/excel/drive.sh --entry <locale>` typed every raw text of
//! `entry_cases.py` into a cell of real Excel and read back the stored value,
//! its type, the cell's number format and the quote prefix
//! (`recorded/entry.tsv` en-US, `entry-{de,fr,es,it}.tsv` under those
//! regions with the UI language en-US). This lane replays each row twice:
//!
//! - through the pure parser, `sheet_format::entry::parse_entry` (the rows
//!   typed into a General cell; formulas are the engine's), and
//! - through the session's `set_cell` — the door the grid uses — after
//!   giving the cell the recorded pre-entry format (`pre-*` rows), reading
//!   back the stored value, the cell's format code and its quote prefix.
//!
//! Numbers agree as in `excel_oracle.rs` (equal, relative 1e-12, or equal at
//! 15 significant digits); text, bools, errors and format codes exactly.
//! Every disagreement is LISTED in `oracle/excel/entry-divergences.tsv` with
//! a reason, and the list is checked both ways (an unlisted disagreement
//! fails, a listed row that now agrees fails).

use std::collections::BTreeMap;
use std::path::PathBuf;

use sheet_core::{CellValue, DateSystem, Locale};
use sheet_format::entry::{parse_entry, EntryCtx};
use sheet_format::serial::ymd_to_serial;
use sheet_js::core::{SheetSession, StylePatchArg};

fn oracle_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("oracle/excel")
}

fn unescape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut it = s.chars();
    while let Some(c) = it.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match it.next() {
            Some('t') => out.push('\t'),
            Some('n') => out.push('\n'),
            Some('r') => out.push('\r'),
            Some(o) => out.push(o),
            None => out.push('\\'),
        }
    }
    out
}

/// One recorded entry.
struct Row {
    id: String,
    raw: String,
    pre: String,
    ty: String,
    value: String,
    numfmt: String,
    numfmt_id: u32,
    quote: bool,
}

/// One recording: its locale, the day it was recorded (the clock a date
/// without a year needs) and the rows.
struct Recording {
    file: &'static str,
    locale: Locale,
    tag: &'static str,
    now: f64,
    rows: Vec<Row>,
}

fn load(file: &'static str, locale: Locale, tag: &'static str) -> Recording {
    let path = oracle_dir().join("recorded").join(file);
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display()));
    let mut now = None;
    let mut rows = Vec::new();
    for line in text.lines() {
        if let Some(h) = line.strip_prefix("# excel:") {
            let date = h
                .split("recorded: ")
                .nth(1)
                .expect("the header names the recording date");
            let p: Vec<u32> = date.trim().split('-').map(|x| x.parse().unwrap()).collect();
            now = ymd_to_serial(p[0] as i32, p[1], p[2], DateSystem::Date1900);
            assert!(
                h.contains(&format!("locale: {tag}")),
                "{file}: recorded under another locale: {h}"
            );
            continue;
        }
        if line.starts_with('#') || line.is_empty() {
            continue;
        }
        let c: Vec<&str> = line.split('\t').collect();
        assert_eq!(c.len(), 8, "{file}: bad row {line:?}");
        rows.push(Row {
            id: c[0].to_string(),
            raw: unescape(c[1]),
            pre: unescape(c[2]),
            ty: c[3].to_string(),
            value: unescape(c[4]),
            numfmt: unescape(c[5]),
            numfmt_id: c[6].parse().unwrap(),
            quote: c[7] == "1",
        });
    }
    Recording {
        file,
        locale,
        tag,
        now: now.expect("recording date header"),
        rows,
    }
}

fn recordings() -> Vec<Recording> {
    vec![
        load("entry.tsv", Locale::EnUs, "en-US"),
        load("entry-de.tsv", Locale::DeDe, "de-DE"),
        load("entry-fr.tsv", Locale::FrFr, "fr-FR"),
        load("entry-es.tsv", Locale::EsEs, "es-ES"),
        load("entry-it.tsv", Locale::ItIt, "it-IT"),
    ]
}

fn sig15(x: f64) -> String {
    format!("{x:.14e}")
}

fn numbers_agree(a: f64, b: f64) -> bool {
    a == b || (a - b).abs() <= 1e-12 * a.abs().max(b.abs()) || sig15(a) == sig15(b)
}

/// The engine's stored value as a token.
fn value_token(v: &CellValue) -> String {
    match v {
        CellValue::Number(n) => format!("n:{n}"),
        CellValue::Text(t) => format!("s:{t}"),
        CellValue::Bool(b) => format!("b:{}", u8::from(*b)),
        CellValue::Error(e) => format!("e:{}", e.as_str()),
        CellValue::Empty => "blank:".to_string(),
    }
}

fn value_agrees(v: &CellValue, r: &Row) -> bool {
    match (v, r.ty.as_str()) {
        (CellValue::Number(n), "n" | "f") => {
            r.value.parse::<f64>().is_ok_and(|x| numbers_agree(*n, x))
        }
        (CellValue::Text(t), "s" | "f") => t.as_str() == r.value,
        (CellValue::Bool(b), "b") => (r.value == "1") == *b,
        (CellValue::Bool(b), "f") => r.value == if *b { "TRUE" } else { "FALSE" },
        (CellValue::Error(e), "e" | "f") => e.as_str() == r.value,
        (CellValue::Empty, "blank") => true,
        _ => false,
    }
}

/// The format Excel recorded, as the code the engine spells for `locale`.
/// en-US: Excel's own name. The other regions report Excel's built-in
/// names, which are the REGION's formats for the locale-dependent ids (14,
/// 22 the short date, 6/8 the currency): map those to the engine's codes.
fn expected_format(r: &Row, locale: Locale) -> String {
    use sheet_format::entry::FormatHint as H;
    if locale == Locale::EnUs || !r.pre.is_empty() {
        return r.numfmt.clone();
    }
    match r.numfmt_id {
        14 => H::Date.code(locale).to_string(),
        22 => H::DateTime.code(locale).to_string(),
        6 => H::Currency { decimals: false }.code(locale).to_string(),
        8 => H::Currency { decimals: true }.code(locale).to_string(),
        _ => r.numfmt.clone(),
    }
}

/// The comparable token of one outcome: value | format | quote.
fn outcome(v: &CellValue, fmt: &str, quote: bool) -> String {
    format!("{}|{fmt}|q{}", value_token(v), u8::from(quote))
}

fn excel_outcome(r: &Row, locale: Locale) -> String {
    let v = match r.ty.as_str() {
        "n" | "f" if r.value.parse::<f64>().is_ok() => format!("n:{}", r.value),
        "f" | "s" => format!("s:{}", r.value),
        t => format!("{t}:{}", r.value),
    };
    format!("{v}|{}|q{}", expected_format(r, locale), u8::from(r.quote))
}

/// An `entry-divergences.tsv` row.
struct Listed {
    engine: String,
    excel: String,
}

fn load_divergences() -> BTreeMap<(String, String, String), Listed> {
    let path = oracle_dir().join("entry-divergences.tsv");
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display()));
    let mut out = BTreeMap::new();
    for line in text.lines() {
        if line.starts_with('#') || line.trim().is_empty() {
            continue;
        }
        let c: Vec<&str> = line.split('\t').collect();
        assert!(
            c.len() >= 6,
            "want file, id, lane, engine, excel, reason: {line:?}"
        );
        assert!(
            c[2] == "parse" || c[2] == "session",
            "lane must be parse|session: {line:?}"
        );
        assert!(
            !c[5].trim().is_empty(),
            "a divergence needs a reason: {line:?}"
        );
        let key = (c[0].to_string(), c[1].to_string(), c[2].to_string());
        assert!(!out.contains_key(&key), "{key:?} listed twice");
        out.insert(
            key,
            Listed {
                engine: unescape(c[3]),
                excel: unescape(c[4]),
            },
        );
    }
    out
}

/// Compare one lane's outcomes against the recordings and the list.
fn judge(lane: &str, results: Vec<(String, String, String, String, bool)>) {
    let listed = load_divergences();
    let mut problems = Vec::new();
    let mut by_file: BTreeMap<String, (usize, usize, usize)> = BTreeMap::new();
    for (file, id, engine, excel, agree) in &results {
        let stat = by_file.entry(file.clone()).or_default();
        stat.0 += 1;
        let key = (file.clone(), id.clone(), lane.to_string());
        match (agree, listed.get(&key)) {
            (true, None) => stat.1 += 1,
            (true, Some(_)) => problems.push(format!(
                "{file} {id} [{lane}]: listed as a divergence but now AGREES — delete the row"
            )),
            (false, None) => problems.push(format!(
                "{file}\t{id}\t{lane}\t{engine}\t{excel}\t<reason>  (UNLISTED disagreement)"
            )),
            (false, Some(l)) => {
                stat.2 += 1;
                if &l.engine != engine || &l.excel != excel {
                    problems.push(format!(
                        "{file} {id} [{lane}]: listed values are stale — engine now {engine:?} (listed {:?}), Excel {excel:?} (listed {:?})",
                        l.engine, l.excel
                    ));
                }
            }
        }
    }
    for (file, id, l) in listed.keys() {
        if l == lane && !results.iter().any(|r| &r.0 == file && &r.1 == id) {
            problems.push(format!("{file} {id} [{lane}]: listed but not recorded"));
        }
    }
    for (file, (n, agree, div)) in &by_file {
        println!(
            "entry lane [{lane}] {file}: {agree}/{n} agree, {div} recorded divergence(s), {} unexplained",
            n - agree - div
        );
    }
    assert!(problems.is_empty(), "{}", problems.join("\n"));
}

/// Every General-cell row through the pure parser.
#[test]
fn excel_entry_lane_parse__feat__sheet_edit_typed_entry() {
    let mut results = Vec::new();
    for rec in recordings() {
        let ctx = EntryCtx::new(rec.locale, DateSystem::Date1900, rec.now);
        for r in rec.rows.iter().filter(|r| r.pre.is_empty() && r.ty != "f") {
            let e = parse_entry(&r.raw, &ctx);
            let fmt = e.hint.map_or("General", |h| h.code(rec.locale));
            let engine = outcome(&e.value, fmt, e.quote_prefix);
            let excel = excel_outcome(r, rec.locale);
            let agree = value_agrees(&e.value, r)
                && fmt == expected_format(r, rec.locale)
                && e.quote_prefix == r.quote;
            results.push((rec.file.to_string(), r.id.clone(), engine, excel, agree));
        }
    }
    judge("parse", results);
}

/// Every row through the session's `set_cell` (pre-formatted cells
/// included): the stored value, the cell's format code and quote prefix.
#[test]
fn excel_entry_lane_session__feat__sheet_edit_typed_entry() {
    let mut results = Vec::new();
    for rec in recordings() {
        // A one-cell CSV in the region's locale gives the session that
        // workbook locale (the date code's LCID); en-US is a fresh workbook.
        let mut s = if rec.locale == Locale::EnUs {
            SheetSession::new()
        } else {
            SheetSession::load_csv("x", None, rec.tag, "S", rec.now).unwrap()
        };
        s.set_now(rec.now);
        assert_eq!(s.model().calc.locale, rec.locale, "{}", rec.file);
        for (i, r) in rec.rows.iter().enumerate() {
            let row = i as u32 + 1;
            if !r.pre.is_empty() {
                s.set_style(
                    0,
                    &format!("A{}", row + 1),
                    StylePatchArg {
                        num_fmt: Some(r.pre.clone()),
                        ..StylePatchArg::default()
                    },
                )
                .unwrap_or_else(|e| panic!("{} pre-format {:?}: {e:?}", r.id, r.pre));
            }
            s.set_cell(0, row, 0, &r.raw)
                .unwrap_or_else(|e| panic!("{} set_cell {:?}: {e:?}", r.id, r.raw));
            let model = s.model();
            let cell = model.sheet(0).and_then(|ws| ws.cell(row, 0));
            let v = cell.map(|c| c.value.clone()).unwrap_or(CellValue::Empty);
            let fmt = cell
                .map(|c| model.styles.num_fmt_of(c.style).to_string())
                .unwrap_or_else(|| "General".into());
            let quote = s.get_style(0, row, 0).unwrap().quote_prefix == Some(true);
            let engine = outcome(&v, &fmt, quote);
            let excel = excel_outcome(r, rec.locale);
            let agree =
                value_agrees(&v, r) && fmt == expected_format(r, rec.locale) && quote == r.quote;
            results.push((rec.file.to_string(), r.id.clone(), engine, excel, agree));
        }
    }
    judge("session", results);
}

// ── round trip: parse → format with the hinted format → re-parse ─────────

mod roundtrip {
    use proptest::prelude::*;
    use sheet_core::{CellValue, DateSystem, Locale};
    use sheet_format::entry::{parse_entry, EntryCtx};
    use sheet_format::serial::ymd_to_serial;
    use sheet_format::{compile, format_value, FormatCtx};

    const LOCALES: [Locale; 5] = [
        Locale::EnUs,
        Locale::DeDe,
        Locale::FrFr,
        Locale::EsEs,
        Locale::ItIt,
    ];

    fn ctx(locale: Locale) -> EntryCtx {
        EntryCtx::new(
            locale,
            DateSystem::Date1900,
            ymd_to_serial(2026, 10, 22, DateSystem::Date1900).unwrap(),
        )
    }

    /// Typed texts in the locale's own spelling, one shape per hint family.
    fn typed(locale: Locale) -> impl Strategy<Value = String> {
        let (d, g) = match locale {
            Locale::EnUs => (".", ","),
            Locale::FrFr => (",", " "),
            _ => (",", "."),
        };
        let cur = move |n: String| match locale {
            Locale::EnUs => format!("${n}"),
            _ => format!("{n} €"),
        };
        let date = move |y: u32, m: u32, day: u32| match locale {
            Locale::EnUs => format!("{m}/{day}/{y}"),
            Locale::DeDe => format!("{day}.{m}.{y}"),
            _ => format!("{day}/{m}/{y}"),
        };
        prop_oneof![
            (1u32..999, 0u32..1000, 0u32..100)
                .prop_map(move |(a, b, c)| format!("{a}{g}{b:03}{d}{c:02}")),
            (0u32..100_000).prop_map(|n| format!("{n}%")),
            (0u32..10_000, 0u32..100).prop_map(move |(n, c)| format!("{n}{d}{c:02}%")),
            (1u32..1_000_000, 0u32..100).prop_map(move |(n, c)| cur(format!("{n}{d}{c:02}"))),
            (1u32..9, 0u32..100, -20i32..20).prop_map(move |(a, b, e)| format!("{a}{d}{b:02}E{e}")),
            // A whole part of 0 displays as ` 1/2`, which re-types as a DATE
            // — in Excel too; the round trip holds from a whole part of 1.
            (1u32..100, 1u32..9, 2u32..10).prop_map(|(w, n, den)| format!("{w} {n}/{den}")),
            (1930u32..2030, 1u32..13, 1u32..29).prop_map(move |(y, m, day)| date(y, m, day)),
            (0u32..24, 0u32..60).prop_map(|(h, m)| format!("{h}:{m:02}")),
            (0u32..24, 0u32..60, 0u32..60).prop_map(|(h, m, s)| format!("{h}:{m:02}:{s:02}")),
            (1u32..13, 0u32..60, any::<bool>())
                .prop_map(|(h, m, pm)| format!("{h}:{m:02} {}", if pm { "PM" } else { "AM" })),
        ]
    }

    fn locale_and_text() -> impl Strategy<Value = (Locale, String)> {
        (0usize..LOCALES.len()).prop_flat_map(|i| (Just(LOCALES[i]), typed(LOCALES[i])))
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(512))]

        /// Whatever a typed text implies, the cell's DISPLAY under that
        /// format re-types to the same value (and the same format family when shown):
        /// what the grid shows is what the person can type back.
        #[test]
        fn typed_entry_display_retypes_to_the_same_value__feat__sheet_edit_typed_entry(
            (locale, raw) in locale_and_text()
        ) {
            let c = ctx(locale);
            let first = parse_entry(&raw, &c);
            let CellValue::Number(v) = first.value else {
                return Err(TestCaseError::fail(format!("{raw:?} did not type as a number: {first:?}")));
            };
            let hint = first.hint.ok_or_else(|| TestCaseError::fail(format!("{raw:?}: no format")))?;
            let shown = format_value(
                &CellValue::Number(v),
                &compile(hint.code(locale)).unwrap(),
                &FormatCtx::new(DateSystem::Date1900, locale),
            );
            let again = parse_entry(shown.trim(), &c);
            let CellValue::Number(w) = again.value else {
                return Err(TestCaseError::fail(format!("{raw:?} → {shown:?} re-typed as {:?}", again.value)));
            };
            prop_assert!((v - w).abs() <= 1e-9 * v.abs().max(1.0),
                "{:?} → {} shown {:?} → {}", raw, v, shown, w);
            // The family survives too, except where the display drops it
            // (a whole number under `# ?/?` shows no fraction).
            prop_assert!(again.hint.is_none_or(|h| h.category() == hint.category()),
                "{:?} shown {:?} re-typed as {:?}", raw, shown, again.hint);
        }
    }
}
