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

//! Files into tables. Each reader returns a [`Table`]: column names (unique,
//! never empty) with a [`ColumnType`], and the rows' [`Cell`]s already in the
//! form the store writes (a date as ISO text, a boolean as a bool, …).
//!
//! - **CSV / TSV**: the `csv` crate. The delimiter of a `.csv` is sniffed
//!   (`,`, `;`, tab, `|`: the one that gives every line of the sample the same
//!   number of fields, more than one); a `.tsv` is tab-separated. Types are
//!   inferred from the fields ([`infer_column`]); the same file is also read
//!   as written, every column text.
//! - **JSON**: an array of objects, or one object per line (NDJSON). Columns
//!   are the keys in the order they first appear; a nested value is kept as
//!   its JSON text.
//! - **Parquet**: the `parquet` crate's row reader (no Arrow). Snappy, gzip,
//!   brotli and lz4 pages read; zstd does not (its crate binds C).
//! - **XLSX**: `data-xlsx` (calamine), one worksheet.

use data_core::temporal::civil_from_days;
use serde::Serialize;
use serde_json::Value as Json;

use crate::types::ColumnType;
use crate::{Result, StoreError};

/// The formats a file can be imported as.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Csv,
    Tsv,
    Json,
    Parquet,
    Xlsx,
}

impl Format {
    /// The format named `csv`, `tsv`, `json`, `parquet` or `xlsx`.
    pub fn parse(name: &str) -> Option<Format> {
        Some(match name {
            "csv" => Format::Csv,
            "tsv" => Format::Tsv,
            "json" => Format::Json,
            "parquet" => Format::Parquet,
            "xlsx" => Format::Xlsx,
            _ => return None,
        })
    }
}

/// One value as the store writes it.
#[derive(Debug, Clone, PartialEq)]
pub enum Cell {
    Null,
    Int(i64),
    Real(f64),
    Bool(bool),
    Text(String),
}

/// A named, typed column.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Column {
    pub name: String,
    #[serde(rename = "type", serialize_with = "ser_type")]
    pub ty: ColumnType,
}

fn ser_type<S: serde::Serializer>(ty: &ColumnType, s: S) -> std::result::Result<S::Ok, S::Error> {
    s.serialize_str(&ty.name())
}

/// A file read as a table.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Table {
    pub columns: Vec<Column>,
    pub rows: Vec<Vec<Cell>>,
}

/// What reading a file produced.
#[derive(Debug, Clone, PartialEq)]
pub struct Read {
    pub table: Table,
    /// The same file with every column text, as written (CSV and TSV only).
    pub as_written: Option<Table>,
    /// The worksheet read and every worksheet of the workbook (XLSX only).
    pub sheet: Option<(String, Vec<String>)>,
    /// Error cells read as NULL (XLSX only).
    pub error_cells: usize,
}

/// Read `bytes` as `format`. `sheet` names an XLSX worksheet (`None`: the
/// first).
pub fn read(format: Format, bytes: &[u8], sheet: Option<&str>) -> Result<Read> {
    match format {
        Format::Csv | Format::Tsv => {
            let text = std::str::from_utf8(bytes)
                .map_err(|e| StoreError::Read(format!("the file is not UTF-8 text ({e})")))?;
            let delimiter = (format == Format::Tsv).then_some(b'\t');
            let (table, as_written) = csv(text, delimiter)?;
            Ok(Read {
                table,
                as_written: Some(as_written),
                sheet: None,
                error_cells: 0,
            })
        }
        Format::Json => Ok(plain(json(bytes)?)),
        Format::Parquet => Ok(plain(parquet(bytes)?)),
        Format::Xlsx => xlsx(bytes, sheet),
    }
}

fn plain(table: Table) -> Read {
    Read {
        table,
        as_written: None,
        sheet: None,
        error_cells: 0,
    }
}

// ---------------------------------------------------------------- names

/// Column names as the store uses them, the way `data-xlsx` names a
/// worksheet's: an empty name is `column_<n>` (1-based), a repeated one gets
/// `_2`, `_3`, … (compared without case, as SQL compares names).
pub fn unique_names(raw: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for (i, name) in raw.into_iter().enumerate() {
        let trimmed = name.trim();
        let base = if trimmed.is_empty() {
            format!("column_{}", i + 1)
        } else {
            trimmed.to_string()
        };
        let mut candidate = base.clone();
        let mut n = 2;
        while out.iter().any(|o| o.eq_ignore_ascii_case(&candidate)) {
            candidate = format!("{base}_{n}");
            n += 1;
        }
        out.push(candidate);
    }
    out
}

// ---------------------------------------------------------------- inference

/// Days since 1970-01-01 of a `YYYY-MM-DD` that names a real day (no
/// 2024-02-30).
pub fn iso_date(s: &str) -> Option<i32> {
    let b = s.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    let y: i32 = s[..4].parse().ok()?;
    let m: u32 = s[5..7].parse().ok()?;
    let d: u32 = s[8..10].parse().ok()?;
    let days = data_core::temporal::days_from_civil(y, m, d);
    (civil_from_days(days) == (y, m, d)).then_some(days)
}

fn is_int(s: &str) -> bool {
    let d = s.strip_prefix('-').unwrap_or(s);
    !d.is_empty() && d.bytes().all(|b| b.is_ascii_digit()) && s.parse::<i64>().is_ok()
}

/// Digits after the point of a plain decimal (`-12.50` → 2), or `None`.
fn decimal_scale(s: &str) -> Option<usize> {
    let d = s.strip_prefix('-').unwrap_or(s);
    let (int, frac) = d.split_once('.')?;
    let digits = |p: &str| p.bytes().all(|b| b.is_ascii_digit());
    (!frac.is_empty() && digits(int) && digits(frac)).then_some(frac.len())
}

fn is_real(s: &str) -> bool {
    // f64 parses "inf" and "NaN" too; a data file means a number.
    s.bytes()
        .all(|b| b.is_ascii_digit() || matches!(b, b'-' | b'+' | b'.' | b'e' | b'E'))
        && s.parse::<f64>().is_ok()
}

/// A number written as a code: an explicit `+`, or a leading zero before
/// another digit (`0007`, `-012`). Its text is what matters (an article
/// number, a postcode), so a column holding one stays text.
fn is_code_like(s: &str) -> bool {
    let d = s.strip_prefix('-').unwrap_or(s);
    s.starts_with('+') || (d.len() > 1 && d.starts_with('0') && d.as_bytes()[1].is_ascii_digit())
}

fn is_bool(s: &str) -> bool {
    s.eq_ignore_ascii_case("true") || s.eq_ignore_ascii_case("false")
}

/// `YYYY-MM-DD HH:MM[:SS[.f…]]` (or with `T`, an optional `Z`) as the store
/// writes it: `YYYY-MM-DD HH:MM:SS[.f…]`.
pub fn normal_timestamp(s: &str) -> Option<String> {
    let s = s.strip_suffix('Z').unwrap_or(s);
    if s.len() < 16 {
        return None;
    }
    let (date, time) = (s.get(..10)?, s.get(11..)?);
    if !matches!(s.as_bytes()[10], b' ' | b'T') || iso_date(date).is_none() {
        return None;
    }
    let (hms, frac) = match time.split_once('.') {
        Some((h, f)) if !f.is_empty() && f.bytes().all(|b| b.is_ascii_digit()) => (h, Some(f)),
        Some(_) => return None,
        None => (time, None),
    };
    let parts: Vec<&str> = hms.split(':').collect();
    let num = |p: &str, max: u32| p.len() == 2 && p.parse::<u32>().is_ok_and(|v| v <= max);
    let ok = match parts.as_slice() {
        [h, m] => num(h, 23) && num(m, 59),
        [h, m, sec] => num(h, 23) && num(m, 59) && num(sec, 60),
        _ => false,
    };
    if !ok {
        return None;
    }
    let seconds = if parts.len() == 2 { ":00" } else { "" };
    Some(match frac {
        Some(f) => format!("{date} {hms}{seconds}.{f}"),
        None => format!("{date} {hms}{seconds}"),
    })
}

/// Milliseconds since the Unix epoch of a stored timestamp.
pub fn timestamp_ms(s: &str) -> Option<i64> {
    let n = normal_timestamp(s)?;
    let days = iso_date(&n[..10])? as i64;
    let h: i64 = n[11..13].parse().ok()?;
    let m: i64 = n[14..16].parse().ok()?;
    let sec: i64 = n[17..19].parse().ok()?;
    let ms: i64 = match n.get(20..) {
        Some(f) => format!("{f:0<3}")[..3].parse().ok()?,
        None => 0,
    };
    Some(((days * 24 + h) * 60 + m) * 60_000 + sec * 1000 + ms)
}

/// The type of a column from its fields as written. Empty fields say
/// nothing; a column with none but empty fields is text.
pub fn infer_column<'a>(fields: impl Iterator<Item = &'a str> + Clone) -> ColumnType {
    let present = || fields.clone().filter(|f| !f.is_empty());
    if present().next().is_none() {
        return ColumnType::Text;
    }
    if present().all(is_bool) {
        return ColumnType::Boolean;
    }
    if present().any(is_code_like) {
        return ColumnType::Text;
    }
    if present().all(is_int) {
        return ColumnType::Integer;
    }
    if present().all(|f| is_int(f) || decimal_scale(f).is_some()) {
        let scale = present().filter_map(decimal_scale).max().unwrap_or(0);
        return if (1..=9).contains(&scale) {
            ColumnType::Decimal { scale: scale as u8 }
        } else {
            ColumnType::Real
        };
    }
    if present().all(is_real) {
        return ColumnType::Real;
    }
    if present().all(|f| iso_date(f).is_some()) {
        return ColumnType::Date;
    }
    if present().all(|f| iso_date(f).is_some() || normal_timestamp(f).is_some()) {
        return ColumnType::Timestamp;
    }
    ColumnType::Text
}

/// One field as a cell of a column of type `ty` (the field was inferred to
/// fit it). An empty field is NULL in every typed column.
pub fn cell_of(field: &str, ty: ColumnType) -> Cell {
    if field.is_empty() {
        return if ty == ColumnType::Text {
            Cell::Text(String::new())
        } else {
            Cell::Null
        };
    }
    match ty {
        ColumnType::Integer => field.parse().map(Cell::Int).unwrap_or(Cell::Null),
        ColumnType::Decimal { .. } | ColumnType::Real => {
            field.parse().map(Cell::Real).unwrap_or(Cell::Null)
        }
        ColumnType::Boolean => Cell::Bool(field.eq_ignore_ascii_case("true")),
        ColumnType::Date => Cell::Text(field.to_string()),
        ColumnType::Timestamp => {
            Cell::Text(normal_timestamp(field).unwrap_or_else(|| format!("{field} 00:00:00")))
        }
        ColumnType::Text => Cell::Text(field.to_string()),
    }
}

// ---------------------------------------------------------------- CSV

/// The delimiter of a CSV: of `,`, `;`, tab and `|`, the one that splits the
/// first lines into the same number (> 1) of fields, the most fields winning;
/// `,` when none does.
pub fn sniff_delimiter(text: &str) -> u8 {
    let sample: String = text.lines().take(20).collect::<Vec<_>>().join("\n");
    let mut best = (b',', 1usize);
    for d in *b",;\t|" {
        let mut rdr = csv::ReaderBuilder::new()
            .delimiter(d)
            .has_headers(false)
            .flexible(true)
            .from_reader(sample.as_bytes());
        let counts: Vec<usize> = rdr
            .records()
            .filter_map(|r| r.ok())
            .map(|r| r.len())
            .collect();
        // The header's field count, matched by at least 4 of 5 lines (a
        // short last line or a stray one does not decide against it; in a
        // sample of a few lines, all but one).
        let Some(&first) = counts.first() else {
            continue;
        };
        let agree = counts.iter().filter(|&&c| c == first).count();
        if first > best.1 && (agree * 5 >= counts.len() * 4 || agree + 1 >= counts.len()) {
            best = (d, first);
        }
    }
    best.0
}

/// A CSV text, typed and as written. `delimiter`: `None` sniffs it.
pub fn csv(text: &str, delimiter: Option<u8>) -> Result<(Table, Table)> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let delimiter = delimiter.unwrap_or_else(|| sniff_delimiter(text));
    let mut rdr = csv::ReaderBuilder::new()
        .delimiter(delimiter)
        .has_headers(true)
        .flexible(true)
        .from_reader(text.as_bytes());
    let header = rdr
        .headers()
        .map_err(|e| StoreError::Read(format!("the CSV does not read ({e})")))?
        .clone();
    if header.is_empty() {
        return Err(StoreError::Read(
            "the CSV is empty — the first line must name the columns".into(),
        ));
    }
    let names = unique_names(header.iter().map(str::to_owned));
    let width = names.len();
    let mut records: Vec<csv::StringRecord> = Vec::new();
    for (i, r) in rdr.records().enumerate() {
        records.push(r.map_err(|e| {
            StoreError::Read(format!("line {} of the CSV does not read ({e})", i + 2))
        })?);
    }
    fn field(r: &csv::StringRecord, c: usize) -> &str {
        r.get(c).unwrap_or("")
    }
    let types: Vec<ColumnType> = (0..width)
        .map(|c| infer_column(records.iter().map(move |r| field(r, c))))
        .collect();
    let typed = Table {
        columns: names
            .iter()
            .zip(&types)
            .map(|(n, t)| Column {
                name: n.clone(),
                ty: *t,
            })
            .collect(),
        rows: records
            .iter()
            .map(|r| (0..width).map(|c| cell_of(field(r, c), types[c])).collect())
            .collect(),
    };
    let as_written = Table {
        columns: names
            .iter()
            .map(|n| Column {
                name: n.clone(),
                ty: ColumnType::Text,
            })
            .collect(),
        rows: records
            .iter()
            .map(|r| {
                (0..width)
                    .map(|c| Cell::Text(field(r, c).to_string()))
                    .collect()
            })
            .collect(),
    };
    Ok((typed, as_written))
}

// ---------------------------------------------------------------- JSON

/// A JSON array of objects, or newline-delimited objects.
pub fn json(bytes: &[u8]) -> Result<Table> {
    let text = std::str::from_utf8(bytes)
        .map_err(|e| StoreError::Read(format!("the file is not UTF-8 text ({e})")))?;
    let text = text.strip_prefix('\u{feff}').unwrap_or(text).trim();
    let records: Vec<Record> = if text.starts_with('[') {
        let all: Vec<Item> = serde_json::from_str(text)
            .map_err(|e| StoreError::Read(format!("the JSON does not read ({e})")))?;
        all.into_iter()
            .enumerate()
            .map(|(i, v)| match v {
                Item::Object(r) => Ok(r),
                Item::Other => Err(StoreError::Read(format!(
                    "item {} of the JSON array is not an object",
                    i + 1
                ))),
            })
            .collect::<Result<_>>()?
    } else {
        text.lines()
            .enumerate()
            .filter(|(_, l)| !l.trim().is_empty())
            .map(|(i, l)| match serde_json::from_str::<Item>(l) {
                Ok(Item::Object(r)) => Ok(r),
                Ok(Item::Other) => Err(StoreError::Read(format!(
                    "line {} of the JSON is not an object",
                    i + 1
                ))),
                Err(e) => Err(StoreError::Read(format!(
                    "line {} of the JSON does not read ({e})",
                    i + 1
                ))),
            })
            .collect::<Result<_>>()?
    };
    let mut keys: Vec<String> = Vec::new();
    for r in &records {
        for (k, _) in &r.0 {
            if !keys.contains(k) {
                keys.push(k.clone());
            }
        }
    }
    let rows: Vec<Vec<&Json>> = records
        .iter()
        .map(|r| {
            keys.iter()
                .map(|k| r.get(k).unwrap_or(&Json::Null))
                .collect()
        })
        .collect();
    let names = unique_names(keys.iter().cloned());
    Ok(json_table(names, &rows))
}

/// A JSON object with its keys in the order the file has them (serde_json's
/// map sorts them).
struct Record(Vec<(String, Json)>);

impl Record {
    fn get(&self, key: &str) -> Option<&Json> {
        self.0.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }
}

/// One item of a JSON array or one NDJSON line: an object, or anything else.
enum Item {
    Object(Record),
    Other,
}

impl<'de> serde::Deserialize<'de> for Item {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        struct V;
        impl<'de> serde::de::Visitor<'de> for V {
            type Value = Item;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("a JSON value")
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(
                self,
                mut m: A,
            ) -> std::result::Result<Item, A::Error> {
                let mut out = Vec::new();
                while let Some((k, v)) = m.next_entry::<String, Json>()? {
                    out.push((k, v));
                }
                Ok(Item::Object(Record(out)))
            }
            fn visit_seq<A: serde::de::SeqAccess<'de>>(
                self,
                mut s: A,
            ) -> std::result::Result<Item, A::Error> {
                while s.next_element::<serde::de::IgnoredAny>()?.is_some() {}
                Ok(Item::Other)
            }
            fn visit_bool<E>(self, _: bool) -> std::result::Result<Item, E> {
                Ok(Item::Other)
            }
            fn visit_i64<E>(self, _: i64) -> std::result::Result<Item, E> {
                Ok(Item::Other)
            }
            fn visit_u64<E>(self, _: u64) -> std::result::Result<Item, E> {
                Ok(Item::Other)
            }
            fn visit_f64<E>(self, _: f64) -> std::result::Result<Item, E> {
                Ok(Item::Other)
            }
            fn visit_str<E>(self, _: &str) -> std::result::Result<Item, E> {
                Ok(Item::Other)
            }
            fn visit_unit<E>(self) -> std::result::Result<Item, E> {
                Ok(Item::Other)
            }
        }
        d.deserialize_any(V)
    }
}

/// Columns typed from JSON values: all integers → INTEGER, numbers → REAL,
/// booleans → BOOLEAN, strings → what [`infer_column`] makes of them (an ISO
/// date column is DATE); any mix, or a nested value, is TEXT.
fn json_table(names: Vec<String>, rows: &[Vec<&Json>]) -> Table {
    let types: Vec<ColumnType> = (0..names.len())
        .map(|c| {
            let present = || rows.iter().map(move |r| r[c]).filter(|v| !v.is_null());
            if present().next().is_none() {
                ColumnType::Text
            } else if present().all(|v| v.is_i64()) {
                ColumnType::Integer
            } else if present().all(Json::is_number) {
                ColumnType::Real
            } else if present().all(Json::is_boolean) {
                ColumnType::Boolean
            } else if present().all(Json::is_string) {
                match infer_column(present().map(|v| v.as_str().unwrap_or(""))) {
                    t @ (ColumnType::Date | ColumnType::Timestamp) => t,
                    _ => ColumnType::Text,
                }
            } else {
                ColumnType::Text
            }
        })
        .collect();
    let cell = |v: &Json, ty: ColumnType| match (v, ty) {
        (Json::Null, _) => Cell::Null,
        (Json::Bool(b), ColumnType::Boolean) => Cell::Bool(*b),
        (Json::Number(n), ColumnType::Integer) => n.as_i64().map(Cell::Int).unwrap_or(Cell::Null),
        (Json::Number(n), ColumnType::Real) => n.as_f64().map(Cell::Real).unwrap_or(Cell::Null),
        (Json::String(s), ColumnType::Date | ColumnType::Timestamp) => cell_of(s, ty),
        (Json::String(s), _) => Cell::Text(s.clone()),
        (other, _) => Cell::Text(other.to_string()),
    };
    Table {
        columns: names
            .into_iter()
            .zip(&types)
            .map(|(name, ty)| Column { name, ty: *ty })
            .collect(),
        rows: rows
            .iter()
            .map(|r| r.iter().zip(&types).map(|(v, t)| cell(v, *t)).collect())
            .collect(),
    }
}

// ---------------------------------------------------------------- Parquet

/// A Parquet file, every row group, through the row reader.
pub fn parquet(bytes: &[u8]) -> Result<Table> {
    use parquet::file::reader::{FileReader, SerializedFileReader};
    use parquet::record::Field;

    let fail = |e: parquet::errors::ParquetError| {
        let text = e.to_string();
        StoreError::Read(if text.to_ascii_lowercase().contains("zstd") {
            "the Parquet file is zstd-compressed, which this build does not read — write it with snappy, gzip, brotli or lz4".into()
        } else {
            format!("the Parquet file does not read ({text})")
        })
    };
    let reader = SerializedFileReader::new(bytes::Bytes::copy_from_slice(bytes)).map_err(fail)?;
    let schema = reader.metadata().file_metadata().schema_descr();
    let raw: Vec<String> = schema
        .root_schema()
        .get_fields()
        .iter()
        .map(|f| f.name().to_string())
        .collect();
    let width = raw.len();
    let names = unique_names(raw);
    let mut cells: Vec<Vec<Field>> = Vec::new();
    for row in reader.get_row_iter(None).map_err(fail)? {
        let row = row.map_err(fail)?;
        let mut out: Vec<Field> = row.get_column_iter().map(|(_, f)| f.clone()).collect();
        out.resize(width, Field::Null);
        cells.push(out);
    }
    // A Parquet column has one type; read it from the values the reader gives.
    let kind = |f: &Field| -> Option<ColumnType> {
        Some(match f {
            Field::Null => return None,
            Field::Bool(_) => ColumnType::Boolean,
            Field::Byte(_)
            | Field::Short(_)
            | Field::Int(_)
            | Field::Long(_)
            | Field::UByte(_)
            | Field::UShort(_)
            | Field::UInt(_)
            | Field::ULong(_) => ColumnType::Integer,
            Field::Float(_) | Field::Double(_) | Field::Float16(_) => ColumnType::Real,
            Field::Decimal(d) => ColumnType::Decimal {
                scale: d.scale().clamp(0, 9) as u8,
            },
            Field::Date(_) => ColumnType::Date,
            Field::TimestampMillis(_) | Field::TimestampMicros(_) => ColumnType::Timestamp,
            _ => ColumnType::Text,
        })
    };
    let types: Vec<ColumnType> = (0..width)
        .map(|c| {
            let mut seen = cells.iter().filter_map(|r| kind(&r[c]));
            match seen.next() {
                None => ColumnType::Text,
                Some(first) => {
                    if seen.all(|t| t == first) {
                        first
                    } else {
                        ColumnType::Text
                    }
                }
            }
        })
        .collect();
    let cell = |f: &Field, ty: ColumnType| -> Cell {
        match (f, ty) {
            (Field::Null, _) => Cell::Null,
            (Field::Bool(b), ColumnType::Boolean) => Cell::Bool(*b),
            (Field::Byte(v), ColumnType::Integer) => Cell::Int(*v as i64),
            (Field::Short(v), ColumnType::Integer) => Cell::Int(*v as i64),
            (Field::Int(v), ColumnType::Integer) => Cell::Int(*v as i64),
            (Field::Long(v), ColumnType::Integer) => Cell::Int(*v),
            (Field::UByte(v), ColumnType::Integer) => Cell::Int(*v as i64),
            (Field::UShort(v), ColumnType::Integer) => Cell::Int(*v as i64),
            (Field::UInt(v), ColumnType::Integer) => Cell::Int(*v as i64),
            (Field::ULong(v), ColumnType::Integer) => i64::try_from(*v)
                .map(Cell::Int)
                .unwrap_or(Cell::Real(*v as f64)),
            (Field::Float(v), ColumnType::Real) => Cell::Real(*v as f64),
            (Field::Double(v), ColumnType::Real) => Cell::Real(*v),
            (Field::Float16(v), ColumnType::Real) => Cell::Real(f64::from(*v)),
            (Field::Decimal(_), ColumnType::Decimal { .. }) => {
                f.to_string().parse().map(Cell::Real).unwrap_or(Cell::Null)
            }
            (Field::Date(days), ColumnType::Date) => {
                let (y, m, d) = civil_from_days(*days);
                Cell::Text(format!("{y:04}-{m:02}-{d:02}"))
            }
            (Field::TimestampMillis(ms), ColumnType::Timestamp) => Cell::Text(iso_of_ms(*ms)),
            (Field::TimestampMicros(us), ColumnType::Timestamp) => {
                Cell::Text(iso_of_ms(us.div_euclid(1000)))
            }
            (Field::Str(s), _) => Cell::Text(s.clone()),
            (other, _) => Cell::Text(other.to_string()),
        }
    };
    Ok(Table {
        columns: names
            .into_iter()
            .zip(&types)
            .map(|(name, ty)| Column { name, ty: *ty })
            .collect(),
        rows: cells
            .iter()
            .map(|r| r.iter().zip(&types).map(|(f, t)| cell(f, *t)).collect())
            .collect(),
    })
}

/// A timestamp's text as the store keeps it.
pub fn iso_of_ms(ms: i64) -> String {
    let days = ms.div_euclid(86_400_000) as i32;
    let (y, m, d) = civil_from_days(days);
    let rem = ms.rem_euclid(86_400_000);
    let (h, mi, s, frac) = (
        rem / 3_600_000,
        (rem / 60_000) % 60,
        (rem / 1000) % 60,
        rem % 1000,
    );
    if frac == 0 {
        format!("{y:04}-{m:02}-{d:02} {h:02}:{mi:02}:{s:02}")
    } else {
        format!("{y:04}-{m:02}-{d:02} {h:02}:{mi:02}:{s:02}.{frac:03}")
    }
}

// ---------------------------------------------------------------- XLSX

fn xlsx(bytes: &[u8], sheet: Option<&str>) -> Result<Read> {
    use data_xlsx::ColumnType as X;
    let sheets = data_xlsx::sheet_names(bytes).map_err(|e| StoreError::Read(e.to_string()))?;
    let t = data_xlsx::read_sheet(bytes, sheet).map_err(|e| StoreError::Read(e.to_string()))?;
    // The worksheet reader types every column itself; the store keeps them.
    let types: Vec<ColumnType> = t
        .types
        .iter()
        .map(|ty| match ty {
            X::BigInt => ColumnType::Integer,
            X::Double => ColumnType::Real,
            X::Boolean => ColumnType::Boolean,
            X::Date => ColumnType::Date,
            X::Timestamp => ColumnType::Timestamp,
            X::Varchar => ColumnType::Text,
        })
        .collect();
    let cell = |v: &Json, ty: ColumnType| match (v, ty) {
        (Json::Null, _) => Cell::Null,
        (Json::Bool(b), ColumnType::Boolean) => Cell::Bool(*b),
        (Json::Number(n), ColumnType::Integer) => n.as_i64().map(Cell::Int).unwrap_or(Cell::Null),
        (Json::Number(n), ColumnType::Real) => n.as_f64().map(Cell::Real).unwrap_or(Cell::Null),
        (Json::String(s), ColumnType::Date | ColumnType::Timestamp) => cell_of(s, ty),
        (Json::String(s), _) => Cell::Text(s.clone()),
        (other, _) => Cell::Text(other.to_string()),
    };
    let table = Table {
        columns: unique_names(t.columns.iter().cloned())
            .into_iter()
            .zip(&types)
            .map(|(name, ty)| Column { name, ty: *ty })
            .collect(),
        rows: t
            .rows
            .iter()
            .map(|r| r.iter().zip(&types).map(|(v, ty)| cell(v, *ty)).collect())
            .collect(),
    };
    Ok(Read {
        table,
        as_written: None,
        sheet: Some((t.sheet, sheets)),
        error_cells: t.error_cells,
    })
}
