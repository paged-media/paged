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

//! # data-xlsx — one worksheet of an `.xlsx` as a typed table
//!
//! The store (`data-store`) reads CSV, JSON and Parquet with its own readers;
//! this crate reads a workbook with `sheet-xlsx` (the one XLSX reader of the
//! repository, no second parser) and hands
//! the store one worksheet as typed rows, so the table is made without
//! guessing. (It was written for DuckDB-WASM 1.29.0, whose `excel` extension
//! had no wasm build.)
//!
//! Data Merge semantics: the FIRST ROW of the used range names the columns;
//! every later row is a record. An empty header cell is named `column_<n>`
//! (1-based), a repeated name gets `_2`, `_3`, ….
//!
//! Types are decided per column over its non-empty cells:
//! - all integers (Excel stores numbers as floats; an integral float counts)
//!   → `BIGINT`; integers and fractions → `DOUBLE`;
//! - all booleans → `BOOLEAN`;
//! - all dates (a date-formatted cell with no time of day) → `DATE`; dates and
//!   date-times → `TIMESTAMP`;
//! - anything else, or a mix → `VARCHAR`, and every cell of that column is
//!   written as text;
//! - a column with no value at all → `VARCHAR`.
//!
//! Error cells (`#N/A`, `#DIV/0!`, …) become NULL and are counted.

use std::collections::BTreeMap;

use serde_json::{Map, Number, Value as Json};
use sheet_core::{CellValue, DateSystem};
use sheet_xlsx::XlsxDocument;
use thiserror::Error;

/// Why a workbook could not be read.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum XlsxError {
    #[error("not a readable .xlsx workbook: {0}")]
    Open(String),
    #[error("the workbook has no worksheet named \"{0}\"")]
    NoSuchSheet(String),
    #[error("the workbook has no worksheets")]
    NoSheets,
    #[error("worksheet \"{sheet}\" could not be read: {reason}")]
    Sheet { sheet: String, reason: String },
    #[error("worksheet \"{0}\" is empty — the first row must name the columns")]
    Empty(String),
}

/// The type a column is read as.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ColumnType {
    BigInt,
    Double,
    Boolean,
    Date,
    Timestamp,
    Varchar,
}

impl ColumnType {
    /// The SQL type name.
    pub fn sql(self) -> &'static str {
        match self {
            ColumnType::BigInt => "BIGINT",
            ColumnType::Double => "DOUBLE",
            ColumnType::Boolean => "BOOLEAN",
            ColumnType::Date => "DATE",
            ColumnType::Timestamp => "TIMESTAMP",
            ColumnType::Varchar => "VARCHAR",
        }
    }
}

/// One worksheet read as a table.
#[derive(Debug, Clone, PartialEq)]
pub struct SheetTable {
    /// The worksheet the table was read from.
    pub sheet: String,
    /// Column names, in sheet order, unique.
    pub columns: Vec<String>,
    /// The type of each column (same order as `columns`).
    pub types: Vec<ColumnType>,
    /// The records, one value per column (`Json::Null` for an empty cell).
    pub rows: Vec<Vec<Json>>,
    /// How many error cells (`#N/A`, …) were read as NULL.
    pub error_cells: usize,
}

/// A cell after the first pass, before its column's type is known.
#[derive(Debug, Clone, PartialEq)]
enum Cell {
    Empty,
    Int(i64),
    Float(f64),
    Bool(bool),
    Date(String),
    DateTime(String),
    Text(String),
}

/// A cell of the used range as the sheet reader hands it over: a value, an
/// error cell, or a text cell that is empty (it widens the used range and
/// the header, as a blank string does, but is no value).
#[derive(Debug, Clone, PartialEq)]
enum Raw {
    EmptyText,
    Error,
    Value(Cell),
}

/// The worksheet names of a workbook, in workbook order.
pub fn sheet_names(bytes: &[u8]) -> Result<Vec<String>, XlsxError> {
    let doc = open(bytes)?;
    Ok(doc
        .model
        .sheets
        .iter()
        .map(|s| s.name.to_string())
        .collect())
}

/// Read one worksheet (`None` = the first) as a [`SheetTable`].
pub fn read_sheet(bytes: &[u8], sheet: Option<&str>) -> Result<SheetTable, XlsxError> {
    let doc = open(bytes)?;
    let model = &doc.model;
    let names: Vec<&str> = model.sheets.iter().map(|s| s.name.as_str()).collect();
    let index = match sheet {
        Some(s) => names
            .iter()
            .position(|n| *n == s)
            .ok_or_else(|| XlsxError::NoSuchSheet(s.to_string()))?,
        None => {
            if names.is_empty() {
                return Err(XlsxError::NoSheets);
            }
            0
        }
    };
    let name = names[index].to_string();
    let ws = &model.sheets[index];
    let system = model.calc.date_system;

    // The used range is the box around every non-blank cell; the first row
    // of it is the header.
    let mut grid: BTreeMap<u32, BTreeMap<u32, Raw>> = BTreeMap::new();
    let (mut c0, mut c1) = (u32::MAX, 0u32);
    for (&(r, c), cell) in ws.iter_cells() {
        let raw = match &cell.value {
            CellValue::Empty => continue,
            CellValue::Error(_) => Raw::Error,
            CellValue::Text(t) if t.is_empty() => Raw::EmptyText,
            CellValue::Text(t) => Raw::Value(Cell::Text(t.to_string())),
            CellValue::Bool(b) => Raw::Value(Cell::Bool(*b)),
            CellValue::Number(n) => Raw::Value(number_cell(
                *n,
                date_kind(model.styles.num_fmt_of(cell.style)),
                system,
            )),
        };
        c0 = c0.min(c);
        c1 = c1.max(c);
        grid.entry(r).or_default().insert(c, raw);
    }
    let mut rows = grid.into_iter();
    let (_, header) = rows.next().ok_or_else(|| XlsxError::Empty(name.clone()))?;
    let header: Vec<Option<&Raw>> = (c0..=c1).map(|c| header.get(&c)).collect();
    let columns = column_names(&header);
    if columns.is_empty() {
        return Err(XlsxError::Empty(name));
    }

    let mut error_cells = 0usize;
    let mut cells: Vec<Vec<Cell>> = Vec::new();
    for (_, row) in rows {
        let mut out = Vec::with_capacity(columns.len());
        for i in 0..columns.len() {
            let raw = row.get(&(c0 + i as u32));
            if matches!(raw, Some(Raw::Error)) {
                error_cells += 1;
            }
            out.push(cell_of(raw));
        }
        // A wholly empty row inside the used range is not a record.
        if out.iter().all(|c| *c == Cell::Empty) {
            continue;
        }
        cells.push(out);
    }

    let types: Vec<ColumnType> = (0..columns.len())
        .map(|i| column_type(cells.iter().map(|r| &r[i])))
        .collect();
    let rows = cells
        .into_iter()
        .map(|r| {
            r.into_iter()
                .zip(&types)
                .map(|(c, t)| json_of(c, *t))
                .collect()
        })
        .collect();
    Ok(SheetTable {
        sheet: name,
        columns,
        types,
        rows,
        error_cells,
    })
}

impl SheetTable {
    /// The records as a JSON array of objects. Every object carries every
    /// column.
    pub fn to_json(&self) -> String {
        let records: Vec<Json> = self
            .rows
            .iter()
            .map(|r| {
                let mut m = Map::with_capacity(self.columns.len());
                for (name, v) in self.columns.iter().zip(r) {
                    m.insert(name.clone(), v.clone());
                }
                Json::Object(m)
            })
            .collect();
        Json::Array(records).to_string()
    }
}

fn open(bytes: &[u8]) -> Result<XlsxDocument, XlsxError> {
    XlsxDocument::open(bytes).map_err(|e| XlsxError::Open(e.to_string()))
}

/// Header row → unique, non-empty column names. Trailing empty header cells
/// past the last named one are dropped (a used range often runs wider than
/// the table's header).
fn column_names(header: &[Option<&Raw>]) -> Vec<String> {
    let last = header
        .iter()
        .rposition(|c| c.is_some())
        .map(|i| i + 1)
        .unwrap_or(0);
    let mut seen: Vec<String> = Vec::with_capacity(last);
    for (i, c) in header[..last].iter().enumerate() {
        let base = match cell_of(*c) {
            Cell::Empty => format!("column_{}", i + 1),
            other => text_of(&other).trim().to_string(),
        };
        let base = if base.is_empty() {
            format!("column_{}", i + 1)
        } else {
            base
        };
        let mut name = base.clone();
        let mut n = 2;
        while seen.iter().any(|s| s.eq_ignore_ascii_case(&name)) {
            name = format!("{base}_{n}");
            n += 1;
        }
        seen.push(name);
    }
    seen
}

fn cell_of(c: Option<&Raw>) -> Cell {
    match c {
        None | Some(Raw::EmptyText) | Some(Raw::Error) => Cell::Empty,
        Some(Raw::Value(v)) => v.clone(),
    }
}

/// How a number-format code reads a number.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DateKind {
    Plain,
    /// A date, a time of day or both.
    DateTime,
    /// An elapsed time (`[h]:mm:ss`): kept as the number of days.
    TimeDelta,
}

/// Whether a number-format code makes a number a date or a time: a date/time
/// letter (`d m y h s`, or `AM/PM`) outside quotes, brackets and escapes in
/// the first section; `[h]`/`[m]`/`[s]` alone is an elapsed time.
fn date_kind(format: &str) -> DateKind {
    let mut escaped = false;
    let mut quoted = false;
    let mut brackets = 0u8;
    let mut prev = ' ';
    let mut elapsed = false;
    let mut am_pm = false;
    for s in format.chars() {
        match (s, escaped, quoted, am_pm, brackets) {
            (_, true, ..) => escaped = false,
            ('_' | '\\' | '*', ..) => escaped = true,
            ('"', _, true, _, _) => quoted = false,
            (_, _, true, _, _) => (),
            ('"', ..) => quoted = true,
            (';', ..) => return DateKind::Plain,
            ('[', ..) => brackets += 1,
            (']', .., 1) if elapsed => return DateKind::TimeDelta,
            (']', ..) => brackets = brackets.saturating_sub(1),
            ('a' | 'A', _, _, false, 0) => am_pm = true,
            ('p' | 'm' | '/' | 'P' | 'M', _, _, true, 0) => return DateKind::DateTime,
            ('d' | 'm' | 'h' | 'y' | 's' | 'D' | 'M' | 'H' | 'Y' | 'S', _, _, false, 0) => {
                return DateKind::DateTime
            }
            _ => {
                if !(elapsed && s.eq_ignore_ascii_case(&prev)) {
                    elapsed = prev == '[' && matches!(s, 'm' | 'h' | 's' | 'M' | 'H' | 'S');
                }
            }
        }
        prev = s;
    }
    DateKind::Plain
}

/// A stored number as a cell: an integral number is an integer, a date
/// format makes it a date (no time of day) or a date-time.
fn number_cell(f: f64, kind: DateKind, system: DateSystem) -> Cell {
    match kind {
        DateKind::DateTime => {
            if let Some((y, mo, da, h, mi, s, ms)) = date_time_parts(f, system) {
                return if h == 0 && mi == 0 && s == 0 && ms == 0 {
                    Cell::Date(format!("{y:04}-{mo:02}-{da:02}"))
                } else if ms == 0 {
                    Cell::DateTime(format!("{y:04}-{mo:02}-{da:02} {h:02}:{mi:02}:{s:02}"))
                } else {
                    Cell::DateTime(format!(
                        "{y:04}-{mo:02}-{da:02} {h:02}:{mi:02}:{s:02}.{ms:03}"
                    ))
                };
            }
            Cell::Float(f)
        }
        // A duration-formatted number: keep the number of days as written.
        DateKind::TimeDelta => Cell::Float(f),
        DateKind::Plain => {
            if f.is_finite() && f.fract() == 0.0 && f.abs() < 9.007_199_254_740_992e15 {
                Cell::Int(f as i64)
            } else {
                Cell::Float(f)
            }
        }
    }
}

/// A date-time serial as `(year, month, day, hour, minute, second, milli)`,
/// rounded to the nearest millisecond: the time of day is rounded as a whole
/// (18:45:15 stored as 0.78142361111… is 18:45:15, not 18:45:14 + 1000 ms)
/// and a round-up past midnight moves to the next day. The calendar is
/// `sheet-format`'s, in either date system.
fn date_time_parts(v: f64, system: DateSystem) -> Option<(i32, u32, u32, u32, u32, u32, u32)> {
    if !v.is_finite() {
        return None;
    }
    let mut day = v.floor();
    let mut ms = ((v - day) * 86_400_000.0).round() as u64;
    if ms >= 86_400_000 {
        ms -= 86_400_000;
        day += 1.0;
    }
    let (y, mo, da) = sheet_format::serial::serial_to_ymd(day, system)?;
    Some((
        y,
        mo,
        da,
        (ms / 3_600_000) as u32,
        (ms / 60_000 % 60) as u32,
        (ms / 1000 % 60) as u32,
        (ms % 1000) as u32,
    ))
}

fn column_type<'a>(cells: impl Iterator<Item = &'a Cell>) -> ColumnType {
    let mut t: Option<ColumnType> = None;
    for c in cells {
        let ct = match c {
            Cell::Empty => continue,
            Cell::Int(_) => ColumnType::BigInt,
            Cell::Float(_) => ColumnType::Double,
            Cell::Bool(_) => ColumnType::Boolean,
            Cell::Date(_) => ColumnType::Date,
            Cell::DateTime(_) => ColumnType::Timestamp,
            Cell::Text(_) => return ColumnType::Varchar,
        };
        t = Some(match (t, ct) {
            (None, x) => x,
            (Some(a), b) if a == b => a,
            (Some(ColumnType::BigInt), ColumnType::Double)
            | (Some(ColumnType::Double), ColumnType::BigInt) => ColumnType::Double,
            (Some(ColumnType::Date), ColumnType::Timestamp)
            | (Some(ColumnType::Timestamp), ColumnType::Date) => ColumnType::Timestamp,
            _ => return ColumnType::Varchar,
        });
    }
    t.unwrap_or(ColumnType::Varchar)
}

fn json_of(c: Cell, t: ColumnType) -> Json {
    match (c, t) {
        (Cell::Empty, _) => Json::Null,
        (Cell::Int(i), ColumnType::BigInt) => Json::Number(i.into()),
        (Cell::Int(i), ColumnType::Double) => Number::from_f64(i as f64)
            .map(Json::Number)
            .unwrap_or(Json::Null),
        (Cell::Float(f), ColumnType::Double) => {
            Number::from_f64(f).map(Json::Number).unwrap_or(Json::Null)
        }
        (Cell::Bool(b), ColumnType::Boolean) => Json::Bool(b),
        (Cell::Date(d), ColumnType::Date) => Json::String(d),
        (Cell::Date(d), ColumnType::Timestamp) => Json::String(format!("{d} 00:00:00")),
        (Cell::DateTime(d), ColumnType::Timestamp) => Json::String(d),
        (other, _) => Json::String(text_of(&other)),
    }
}

/// A cell as text (a VARCHAR column, or a header).
fn text_of(c: &Cell) -> String {
    match c {
        Cell::Empty => String::new(),
        Cell::Int(i) => i.to_string(),
        Cell::Float(f) => f.to_string(),
        Cell::Bool(b) => if *b { "TRUE" } else { "FALSE" }.to_string(),
        Cell::Date(s) | Cell::DateTime(s) | Cell::Text(s) => s.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn integral_floats_are_integers_and_a_mix_widens() {
        let ints = [Cell::Int(1), Cell::Empty, Cell::Int(3)];
        assert_eq!(column_type(ints.iter()), ColumnType::BigInt);
        let mixed = [Cell::Int(1), Cell::Float(2.5)];
        assert_eq!(column_type(mixed.iter()), ColumnType::Double);
        let dates = [
            Cell::Date("2026-01-01".into()),
            Cell::DateTime("2026-01-01 10:00:00".into()),
        ];
        assert_eq!(column_type(dates.iter()), ColumnType::Timestamp);
        let text = [Cell::Int(1), Cell::Text("x".into())];
        assert_eq!(column_type(text.iter()), ColumnType::Varchar);
        let nothing = [Cell::Empty];
        assert_eq!(column_type(nothing.iter()), ColumnType::Varchar);
        assert_eq!(
            number_cell(4.0, DateKind::Plain, DateSystem::Date1900),
            Cell::Int(4)
        );
    }

    #[test]
    fn header_names_are_unique_and_never_empty() {
        let t = |s: &str| Raw::Value(Cell::Text(s.into()));
        let (sku, upper, price) = (t("sku"), t("SKU"), t(" price "));
        let header = [Some(&sku), None, Some(&upper), Some(&price), None];
        assert_eq!(
            column_names(&header),
            vec!["sku", "column_2", "SKU_2", "price"]
        );
    }

    #[test]
    fn a_varchar_column_writes_numbers_as_text() {
        assert_eq!(
            json_of(Cell::Int(7), ColumnType::Varchar),
            Json::String("7".into())
        );
        assert_eq!(
            json_of(Cell::Bool(true), ColumnType::Varchar),
            Json::String("TRUE".into())
        );
        assert_eq!(
            json_of(Cell::Date("2026-10-05".into()), ColumnType::Timestamp),
            Json::String("2026-10-05 00:00:00".into())
        );
    }

    #[test]
    fn times_round_to_the_millisecond_and_carry_past_midnight() {
        let at = |v: f64| date_time_parts(v, DateSystem::Date1900).unwrap();
        // 2026-03-01 18:45:15 as openpyxl writes it (just under :15).
        assert_eq!(at(46_082.781_423_611_11), (2026, 3, 1, 18, 45, 15, 0));
        assert_eq!(at(46037.0 + 0.4 / 86_400.0), (2026, 1, 15, 0, 0, 0, 400));
        // 23:59:59.9999 rounds to the next midnight.
        assert_eq!(at(46_037.999_999_999), (2026, 1, 16, 0, 0, 0, 0));
        // The 1904 epoch is kept.
        assert_eq!(
            date_time_parts(0.5, DateSystem::Date1904),
            Some((1904, 1, 1, 12, 0, 0, 0))
        );
    }

    #[test]
    fn number_formats_name_dates_times_and_elapsed_times() {
        assert_eq!(date_kind("DD/MM/YY"), DateKind::DateTime);
        assert_eq!(date_kind("H:MM:SS;@"), DateKind::DateTime);
        assert_eq!(date_kind("m\"M\"d\"D\";@"), DateKind::DateTime);
        assert_eq!(date_kind("[h]:mm:ss"), DateKind::TimeDelta);
        assert_eq!(date_kind("General"), DateKind::Plain);
        assert_eq!(date_kind("0.00"), DateKind::Plain);
        assert_eq!(date_kind("#,##0\\ [$\\u20bd-46D]"), DateKind::Plain);
        assert_eq!(date_kind("\"$\"#,##0_);[Red](\"$\"#,##0)"), DateKind::Plain);
        assert_eq!(date_kind("h:mm AM/PM"), DateKind::DateTime);
    }

    #[test]
    fn garbage_is_an_open_error() {
        assert!(matches!(
            read_sheet(b"not a zip", None),
            Err(XlsxError::Open(_))
        ));
    }
}
