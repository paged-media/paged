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

//! The store: one in-memory Turso database, a writer connection for imports
//! and a reader connection in `query_only` mode for every query.

use std::num::NonZero;
use std::sync::Arc;

use data_core::{fmt_number_scaled, FieldType, RecordSet, Schema, Value};
use serde::Serialize;
use turso_core::{Connection, Database, Numeric, OpenOptions, Row, SqliteDialect, StepResult, IO};

use crate::clock::StoreIO;
use crate::read::{self, iso_date, timestamp_ms, Cell, Column, Format, Table};
use crate::types::{field_of_declared, type_name};
use crate::{Diagnostic, Result, StoreError};

/// The table a CSV source's as-written twin is kept under.
pub const AS_WRITTEN_PREFIX: &str = "__paged_text_";
/// Where a source's typed table waits while a query reads its twin.
const TYPED_ASIDE_PREFIX: &str = "__paged_typed_";

/// What an import loaded.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ImportReport {
    pub table: String,
    pub columns: Vec<Column>,
    pub rows: usize,
    /// The worksheet read (XLSX only).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sheet: Option<String>,
    /// Every worksheet of the workbook (XLSX only).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sheets: Option<Vec<String>>,
    /// Error cells read as NULL (XLSX only).
    #[serde(rename = "errorCells")]
    pub error_cells: usize,
    /// Whether the source is also kept as written (CSV, TSV).
    #[serde(rename = "asWritten")]
    pub as_written: bool,
}

/// A result column: its name and its type as the query builders read it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ColumnInfo {
    pub name: String,
    #[serde(rename = "type")]
    pub ty: String,
}

/// The first rows of a query as text (`None` for SQL NULL), and how many
/// rows it has in all.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Preview {
    pub columns: Vec<ColumnInfo>,
    pub rows: Vec<Vec<Option<String>>>,
    pub count: usize,
}

pub struct Store {
    io: Arc<dyn IO>,
    writer: Arc<Connection>,
    reader: Arc<Connection>,
}

fn sql_err(sql: &str) -> impl Fn(turso_core::LimboError) -> StoreError + '_ {
    move |e| StoreError::Sql(Diagnostic::of(&e, sql))
}

/// A double-quoted SQL identifier.
pub fn ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

impl Store {
    pub fn new() -> Result<Store> {
        // `:memory:` bypasses the process-wide registry: every store is its
        // own database.
        let io: Arc<dyn IO> = Arc::new(StoreIO::new());
        let db = Database::open(
            io.clone(),
            ":memory:",
            OpenOptions::new(Arc::new(SqliteDialect)),
        )
        .map_err(sql_err(""))?;
        let writer = db.connect().map_err(sql_err(""))?;
        let reader = db.connect().map_err(sql_err(""))?;
        reader.set_query_only(true);
        Ok(Store { io, writer, reader })
    }

    fn exec(&self, sql: &str) -> Result<()> {
        self.writer.execute(sql).map_err(sql_err(sql))
    }

    /// Run one of the engine's own statements (DDL, an insert) on the writer
    /// connection. Never a user's or a document's SQL: those are queries, and
    /// go through [`Store::query`] after the guard.
    pub fn execute_trusted(&self, sql: &str) -> Result<()> {
        self.exec(sql)
    }

    /// Step `stmt` to the end, handing each row to `row` until it answers
    /// `false`.
    fn drive(
        &self,
        stmt: &mut turso_core::Statement,
        sql: &str,
        mut row: impl FnMut(&Row) -> bool,
    ) -> Result<()> {
        loop {
            match stmt.step().map_err(sql_err(sql))? {
                StepResult::Done => return Ok(()),
                StepResult::Row => {
                    if !row(stmt.row().expect("a row after StepResult::Row")) {
                        return Ok(());
                    }
                }
                StepResult::IO | StepResult::Yield | StepResult::Sleep { .. } => {
                    self.io.step().map_err(sql_err(sql))?
                }
                StepResult::Interrupt | StepResult::Busy => {
                    return Err(StoreError::Sql(Diagnostic::store(
                        "Error",
                        "the statement was interrupted",
                    )))
                }
            }
        }
    }

    /// Read `bytes` as `format` into the table `name`, replacing it.
    pub fn import(
        &self,
        name: &str,
        format: Format,
        bytes: &[u8],
        sheet: Option<&str>,
    ) -> Result<ImportReport> {
        let r = read::read(format, bytes, sheet)?;
        self.load(name, &r.table)?;
        match &r.as_written {
            Some(text) => self.load(&format!("{AS_WRITTEN_PREFIX}{name}"), text)?,
            None => self.exec(&format!(
                "DROP TABLE IF EXISTS {}",
                ident(&format!("{AS_WRITTEN_PREFIX}{name}"))
            ))?,
        }
        let (sheet, sheets) = match r.sheet {
            Some((s, all)) => (Some(s), Some(all)),
            None => (None, None),
        };
        Ok(ImportReport {
            table: name.to_string(),
            rows: r.table.rows.len(),
            columns: r.table.columns,
            sheet,
            sheets,
            error_cells: r.error_cells,
            as_written: r.as_written.is_some(),
        })
    }

    /// Load `table` as the table `name`, replacing any table of that name,
    /// in one transaction.
    pub fn load(&self, name: &str, table: &Table) -> Result<()> {
        if table.columns.is_empty() {
            return Err(StoreError::Read(format!("\"{name}\" has no columns")));
        }
        let t = ident(name);
        let columns: Vec<String> = table
            .columns
            .iter()
            .map(|c| format!("{} {}", ident(&c.name), c.ty.sql()))
            .collect();
        self.exec("BEGIN")?;
        let loaded = (|| -> Result<()> {
            self.exec(&format!("DROP TABLE IF EXISTS {t}"))?;
            self.exec(&format!("CREATE TABLE {t} ({})", columns.join(", ")))?;
            let marks = vec!["?"; table.columns.len()].join(", ");
            let insert = format!("INSERT INTO {t} VALUES ({marks})");
            let mut stmt = self.writer.prepare(&insert).map_err(sql_err(&insert))?;
            for row in &table.rows {
                for (i, cell) in row.iter().enumerate() {
                    let v = match cell {
                        Cell::Null => turso_core::Value::Null,
                        Cell::Int(n) => turso_core::Value::from_i64(*n),
                        Cell::Real(f) => turso_core::Value::from_f64(*f),
                        Cell::Bool(b) => turso_core::Value::from_i64(*b as i64),
                        Cell::Text(s) => turso_core::Value::build_text(s.clone()),
                    };
                    stmt.bind_at(NonZero::new(i + 1).expect("1-based"), v)
                        .map_err(sql_err(&insert))?;
                }
                self.drive(&mut stmt, &insert, |_| true)?;
                stmt.reset().map_err(sql_err(&insert))?;
            }
            Ok(())
        })();
        match loaded {
            Ok(()) => self.exec("COMMIT"),
            Err(e) => {
                let _ = self.exec("ROLLBACK");
                Err(e)
            }
        }
    }

    /// Drop a source's table and its as-written twin.
    pub fn drop_source(&self, name: &str) -> Result<()> {
        self.exec(&format!("DROP TABLE IF EXISTS {}", ident(name)))?;
        self.exec(&format!(
            "DROP TABLE IF EXISTS {}",
            ident(&format!("{AS_WRITTEN_PREFIX}{name}"))
        ))
    }

    fn all_tables(&self) -> Result<Vec<String>> {
        let sql = "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name";
        let mut stmt = self.writer.prepare(sql).map_err(sql_err(sql))?;
        let mut out = Vec::new();
        self.drive(&mut stmt, sql, |r| {
            if let turso_core::Value::Text(t) = r.get_value(0) {
                out.push(t.as_str().to_string());
            }
            true
        })?;
        Ok(out)
    }

    /// The source tables, by name (twins and the engine's own tables left out).
    pub fn tables(&self) -> Result<Vec<String>> {
        Ok(self
            .all_tables()?
            .into_iter()
            .filter(|t| !t.starts_with("__paged_") && !t.starts_with("sqlite_"))
            .collect())
    }

    /// Run one query on the `query_only` connection: its rows as a record set.
    /// A column that reads a table column has that column's declared type; a
    /// computed one is typed by its first value.
    pub fn query(&self, sql: &str) -> Result<RecordSet> {
        let mut stmt = self.reader.prepare(sql).map_err(sql_err(sql))?;
        let n = stmt.num_columns();
        let names: Vec<String> = (0..n)
            .map(|i| stmt.get_column_name(i).into_owned())
            .collect();
        let declared: Vec<Option<(FieldType, Option<u8>)>> = (0..n)
            .map(|i| {
                stmt.get_column_decltype(i)
                    .and_then(|d| field_of_declared(&d))
            })
            .collect();
        let mut columns: Vec<Vec<Value>> = vec![Vec::new(); n];
        let mut seen: Vec<Option<FieldType>> = vec![None; n];
        self.drive(&mut stmt, sql, |row| {
            for (c, column) in columns.iter_mut().enumerate() {
                let raw = row.get_value(c);
                if seen[c].is_none() {
                    seen[c] = observed(raw);
                }
                column.push(to_value(raw, declared[c].map(|d| d.0)));
            }
            true
        })?;
        let fields = names
            .into_iter()
            .enumerate()
            .map(|(c, name)| data_core::Field {
                name,
                ty: declared[c]
                    .map(|d| d.0)
                    .or(seen[c])
                    .unwrap_or(FieldType::Null),
                nullable: true,
                scale: declared[c].and_then(|d| d.1),
            });
        RecordSet::new(
            Schema {
                fields: fields.collect(),
            },
            columns,
        )
        .map_err(|e| StoreError::Read(e.to_string()))
    }

    /// Run `sql` over the CSV `sources` as written: for the one query, each
    /// source's as-written twin takes the source's name. `None` when no
    /// source has a twin. A query that does not run over text (a computation
    /// that needs numbers, without a CAST) fails with the engine's message.
    pub fn query_as_written(&self, sql: &str, sources: &[String]) -> Result<Option<RecordSet>> {
        let have = self.all_tables()?;
        let swap: Vec<&String> = sources
            .iter()
            .filter(|s| have.contains(s) && have.contains(&format!("{AS_WRITTEN_PREFIX}{s}")))
            .collect();
        if swap.is_empty() {
            return Ok(None);
        }
        let rename =
            |from: &str, to: &str| format!("ALTER TABLE {} RENAME TO {}", ident(from), ident(to));
        let flip = |forward: bool| -> Result<()> {
            self.exec("BEGIN")?;
            let done = (|| -> Result<()> {
                for s in &swap {
                    let (typed, aside, twin) = (
                        s.to_string(),
                        format!("{TYPED_ASIDE_PREFIX}{s}"),
                        format!("{AS_WRITTEN_PREFIX}{s}"),
                    );
                    if forward {
                        self.exec(&rename(&typed, &aside))?;
                        self.exec(&rename(&twin, &typed))?;
                    } else {
                        self.exec(&rename(&typed, &twin))?;
                        self.exec(&rename(&aside, &typed))?;
                    }
                }
                Ok(())
            })();
            match done {
                Ok(()) => self.exec("COMMIT"),
                Err(e) => {
                    let _ = self.exec("ROLLBACK");
                    Err(e)
                }
            }
        };
        flip(true)?;
        let result = self.query(sql);
        flip(false)?;
        result.map(Some)
    }

    /// The columns a query produces, with their types. A computed column is
    /// typed by the first of its first 100 values that is not NULL.
    pub fn describe(&self, sql: &str) -> Result<Vec<ColumnInfo>> {
        let mut stmt = self.reader.prepare(sql).map_err(sql_err(sql))?;
        let n = stmt.num_columns();
        let names: Vec<String> = (0..n)
            .map(|i| stmt.get_column_name(i).into_owned())
            .collect();
        let declared: Vec<Option<(FieldType, Option<u8>)>> = (0..n)
            .map(|i| {
                stmt.get_column_decltype(i)
                    .and_then(|d| field_of_declared(&d))
            })
            .collect();
        let mut seen: Vec<Option<FieldType>> = vec![None; n];
        if declared.iter().any(Option::is_none) {
            let mut left = 100;
            self.drive(&mut stmt, sql, |row| {
                for (c, s) in seen.iter_mut().enumerate() {
                    if s.is_none() {
                        *s = observed(row.get_value(c));
                    }
                }
                left -= 1;
                left > 0
                    && seen
                        .iter()
                        .zip(&declared)
                        .any(|(s, d)| s.is_none() && d.is_none())
            })?;
        }
        Ok(names
            .into_iter()
            .enumerate()
            .map(|(c, name)| {
                let (ty, scale) = declared[c].unwrap_or((seen[c].unwrap_or(FieldType::Null), None));
                ColumnInfo {
                    name,
                    ty: type_name(ty, scale),
                }
            })
            .collect())
    }

    /// The first `limit` rows of a query as text, and its row count. A value
    /// reads as the field of a binding displays it: a decimal with its scale
    /// (`1234.50`), a date as `YYYY-MM-DD`, a boolean as `true`/`false`.
    pub fn preview(&self, sql: &str, limit: usize) -> Result<Preview> {
        let columns = self.describe(sql)?;
        let mut stmt = self.reader.prepare(sql).map_err(sql_err(sql))?;
        let declared: Vec<Option<(FieldType, Option<u8>)>> = (0..stmt.num_columns())
            .map(|i| {
                stmt.get_column_decltype(i)
                    .and_then(|d| field_of_declared(&d))
            })
            .collect();
        let mut rows = Vec::new();
        let mut count = 0;
        self.drive(&mut stmt, sql, |row| {
            if rows.len() < limit {
                rows.push(
                    declared
                        .iter()
                        .enumerate()
                        .map(|(c, d)| {
                            let v = to_value(row.get_value(c), d.map(|d| d.0));
                            display(&v, d.and_then(|d| d.1))
                        })
                        .collect(),
                );
            }
            count += 1;
            true
        })?;
        Ok(Preview {
            columns,
            rows,
            count,
        })
    }
}

/// The field type a raw value shows when nothing is declared.
fn observed(v: &turso_core::Value) -> Option<FieldType> {
    match v {
        turso_core::Value::Null => None,
        turso_core::Value::Numeric(Numeric::Integer(_)) => Some(FieldType::Int),
        turso_core::Value::Numeric(_) => Some(FieldType::Float),
        turso_core::Value::Text(_) => Some(FieldType::Text),
        turso_core::Value::Blob(_) => Some(FieldType::Bytes),
    }
}

/// A raw value as the engine's value, read as the declared type `ty` where
/// it has one: a BOOLEAN's 0/1 as a bool, a DATE's or TIMESTAMP's ISO text as
/// a date or a timestamp. A value the declaration does not fit (SQLite keeps
/// what it is given) stays what it is.
fn to_value(v: &turso_core::Value, ty: Option<FieldType>) -> Value {
    use turso_core::Value as T;
    match (v, ty) {
        (T::Null, _) => Value::Null,
        (T::Numeric(n), Some(FieldType::Bool)) => Value::Bool(n.to_f64() != 0.0),
        (T::Numeric(n), _) => Value::Number(n.to_f64()),
        (T::Text(t), Some(FieldType::Date)) => iso_date(t.as_str())
            .map(Value::Date)
            .unwrap_or_else(|| Value::Text(t.as_str().into())),
        (T::Text(t), Some(FieldType::DateTime)) => timestamp_ms(t.as_str())
            .or_else(|| iso_date(t.as_str()).map(|d| d as i64 * 86_400_000))
            .map(Value::DateTime)
            .unwrap_or_else(|| Value::Text(t.as_str().into())),
        (T::Text(t), Some(FieldType::Bool)) if t.as_str().eq_ignore_ascii_case("true") => {
            Value::Bool(true)
        }
        (T::Text(t), Some(FieldType::Bool)) if t.as_str().eq_ignore_ascii_case("false") => {
            Value::Bool(false)
        }
        (T::Text(t), _) => Value::Text(t.as_str().into()),
        (T::Blob(_), _) => Value::Bytes(v.to_blob().map(<[u8]>::to_vec).unwrap_or_default()),
    }
}

/// A value as preview text (`None` for NULL).
fn display(v: &Value, scale: Option<u8>) -> Option<String> {
    Some(match (v, scale) {
        (Value::Null, _) => return None,
        (Value::Number(n), Some(s)) => fmt_number_scaled(*n, s),
        (Value::Bool(b), _) => b.to_string(),
        (Value::DateTime(ms), _) => read::iso_of_ms(*ms),
        (v, _) => v.as_display(),
    })
}
