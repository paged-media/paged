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

//! The Turso spike (PM-0015): an in-memory Turso database behind the data
//! engine's own seam. A CSV is read in Rust and loaded as one table; a query
//! comes back as a `data_core::RecordSet`, the type every consumer of the
//! engine already takes. Nothing here is shipped; the measurements are in
//! `docs/design/turso-spike-2026-10.md`.

use std::num::NonZero;
use std::sync::Arc;

use data_core::{FieldType, RecordSet, Schema};
use turso_core::{Connection, Database, OpenOptions, SqliteDialect, StepResult, IO};

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("turso: {0}")]
    Turso(#[from] turso_core::LimboError),
    #[error("csv: {0}")]
    Csv(#[from] csv::Error),
    #[error("record set: {0}")]
    Record(#[from] data_core::RecordError),
    #[error("{0}")]
    Input(String),
}

pub type Result<T> = std::result::Result<T, StoreError>;

/// How an imported CSV's columns are typed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Typing {
    /// Every field stays the text the file holds (the way Data Merge reads it).
    AsWritten,
    /// A column whose every non-empty field is an integer is INTEGER, a number
    /// REAL, anything else TEXT (the counterpart of DuckDB's sniffer).
    Infer,
}

/// The SQL type a CSV column is stored as.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ColumnType {
    Integer,
    Real,
    Text,
}

impl ColumnType {
    fn sql(self) -> &'static str {
        match self {
            ColumnType::Integer => "INTEGER",
            ColumnType::Real => "REAL",
            ColumnType::Text => "TEXT",
        }
    }
}

/// One in-memory database: a writer connection for imports and a reader
/// connection in `query_only` mode for every user query.
pub struct Store {
    io: Arc<dyn IO>,
    writer: Arc<Connection>,
    reader: Arc<Connection>,
}

impl Store {
    pub fn new() -> Result<Self> {
        // `:memory:` bypasses the process-wide registry, so every store is its
        // own database.
        let io: Arc<dyn IO> = Arc::new(clock::StoreIO::new());
        let db = Database::open(
            io.clone(),
            ":memory:",
            OpenOptions::new(Arc::new(SqliteDialect)),
        )?;
        let writer = db.connect()?;
        let reader = db.connect()?;
        reader.set_query_only(true);
        Ok(Store { io, writer, reader })
    }

    /// Run statements that return no rows on the writer connection.
    pub fn execute(&self, sql: &str) -> Result<()> {
        self.writer.execute(sql)?;
        Ok(())
    }

    /// Load `text` as table `name`, one row per CSV record after the header.
    /// Returns the column types chosen.
    pub fn import_csv(&self, name: &str, text: &str, typing: Typing) -> Result<Vec<ColumnType>> {
        let mut reader = csv::ReaderBuilder::new()
            .has_headers(true)
            .from_reader(text.as_bytes());
        let header: Vec<String> = reader.headers()?.iter().map(str::to_owned).collect();
        if header.is_empty() {
            return Err(StoreError::Input("the CSV has no header".into()));
        }
        let mut rows: Vec<csv::StringRecord> = Vec::new();
        for record in reader.records() {
            rows.push(record?);
        }
        let types: Vec<ColumnType> = (0..header.len())
            .map(|c| match typing {
                Typing::AsWritten => ColumnType::Text,
                Typing::Infer => infer(rows.iter().map(|r| r.get(c).unwrap_or(""))),
            })
            .collect();

        let columns: Vec<String> = header
            .iter()
            .zip(&types)
            .map(|(h, t)| format!("{} {}", quote_ident(h), t.sql()))
            .collect();
        self.writer.execute(format!(
            "CREATE TABLE {} ({})",
            quote_ident(name),
            columns.join(", ")
        ))?;

        let marks = vec!["?"; header.len()].join(", ");
        let mut insert = self.writer.prepare(format!(
            "INSERT INTO {} VALUES ({marks})",
            quote_ident(name)
        ))?;
        self.writer.execute("BEGIN")?;
        for row in &rows {
            for (c, ty) in types.iter().enumerate() {
                let field = row.get(c).unwrap_or("");
                insert.bind_at(
                    NonZero::new(c + 1).expect("1-based"),
                    field_value(field, *ty),
                )?;
            }
            loop {
                match insert.step()? {
                    StepResult::Done => break,
                    StepResult::Row => {}
                    StepResult::IO | StepResult::Yield | StepResult::Sleep { .. } => {
                        self.io.step()?
                    }
                    StepResult::Interrupt | StepResult::Busy => {
                        return Err(StoreError::Input("the insert was interrupted".into()))
                    }
                }
            }
            insert.reset()?;
        }
        self.writer.execute("COMMIT")?;
        Ok(types)
    }

    /// Run one query on the `query_only` connection and return its rows as the
    /// engine's columnar record set. A column's type is the declared type of
    /// the table column it reads, else the type of its first non-null value.
    pub fn query(&self, sql: &str) -> Result<RecordSet> {
        let mut stmt = self.reader.prepare(sql)?;
        let n = stmt.num_columns();
        let names: Vec<String> = (0..n)
            .map(|i| stmt.get_column_name(i).into_owned())
            .collect();
        let declared: Vec<Option<FieldType>> = (0..n)
            .map(|i| stmt.get_column_decltype(i).and_then(|d| declared_type(&d)))
            .collect();
        let mut columns: Vec<Vec<data_core::Value>> = vec![Vec::new(); n];
        let mut seen: Vec<Option<FieldType>> = vec![None; n];
        loop {
            match stmt.step()? {
                StepResult::Done => break,
                StepResult::Row => {
                    let row = stmt.row().expect("a row after StepResult::Row");
                    for (c, column) in columns.iter_mut().enumerate() {
                        let v = to_value(row.get_value(c));
                        if seen[c].is_none() {
                            seen[c] = observed_type(&v);
                        }
                        column.push(v);
                    }
                }
                StepResult::IO | StepResult::Yield | StepResult::Sleep { .. } => self.io.step()?,
                StepResult::Interrupt | StepResult::Busy => {
                    return Err(StoreError::Input("the query was interrupted".into()))
                }
            }
        }
        let fields = names.into_iter().enumerate().map(|(c, name)| {
            let ty = declared[c].or(seen[c]).unwrap_or(FieldType::Null);
            (name, ty)
        });
        Ok(RecordSet::new(Schema::from_fields(fields), columns)?)
    }
}

fn infer<'a>(fields: impl Iterator<Item = &'a str>) -> ColumnType {
    let mut ty = ColumnType::Integer;
    let mut any = false;
    for f in fields {
        if f.is_empty() {
            continue;
        }
        any = true;
        if ty == ColumnType::Integer && f.parse::<i64>().is_err() {
            ty = ColumnType::Real;
        }
        if ty == ColumnType::Real && f.parse::<f64>().is_err() {
            return ColumnType::Text;
        }
    }
    if any {
        ty
    } else {
        ColumnType::Text
    }
}

fn field_value(field: &str, ty: ColumnType) -> turso_core::Value {
    if field.is_empty() && ty != ColumnType::Text {
        return turso_core::Value::Null;
    }
    match ty {
        ColumnType::Integer => turso_core::Value::from_i64(field.parse().expect("inferred")),
        ColumnType::Real => turso_core::Value::from_f64(field.parse().expect("inferred")),
        ColumnType::Text => turso_core::Value::build_text(field.to_owned()),
    }
}

fn declared_type(decl: &str) -> Option<FieldType> {
    // SQLite's affinity rules (https://sqlite.org/datatype3.html §3.1).
    let d = decl.to_ascii_uppercase();
    if d.contains("INT") {
        Some(FieldType::Int)
    } else if d.contains("CHAR") || d.contains("CLOB") || d.contains("TEXT") {
        Some(FieldType::Text)
    } else if d.contains("BLOB") {
        Some(FieldType::Bytes)
    } else if d.contains("REAL") || d.contains("FLOA") || d.contains("DOUB") {
        Some(FieldType::Float)
    } else {
        None
    }
}

fn observed_type(v: &data_core::Value) -> Option<FieldType> {
    match v {
        data_core::Value::Null => None,
        data_core::Value::Number(_) => Some(FieldType::Float),
        data_core::Value::Text(_) => Some(FieldType::Text),
        data_core::Value::Bytes(_) => Some(FieldType::Bytes),
        data_core::Value::Bool(_) => Some(FieldType::Bool),
        data_core::Value::Date(_) => Some(FieldType::Date),
        data_core::Value::DateTime(_) => Some(FieldType::DateTime),
        data_core::Value::Error(_) => None,
    }
}

fn to_value(v: &turso_core::Value) -> data_core::Value {
    match v {
        turso_core::Value::Null => data_core::Value::Null,
        turso_core::Value::Numeric(n) => data_core::Value::Number(n.to_f64()),
        turso_core::Value::Text(t) => data_core::Value::Text(t.as_str().into()),
        turso_core::Value::Blob(_) => {
            data_core::Value::Bytes(v.to_blob().map(<[u8]>::to_vec).unwrap_or_default())
        }
    }
}

fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// The smallest export a wasm build keeps, so the cdylib's size is the store's
/// size: an import of a two-column CSV and a grouped query over it.
#[no_mangle]
pub extern "C" fn spike_smoke() -> u32 {
    panic_hook();
    let run = || -> Result<usize> {
        let store = Store::new()?;
        store.import_csv("t", "k,v\na,1\nb,2\na,3\n", Typing::Infer)?;
        Ok(store
            .query("SELECT k, sum(v) AS s FROM t GROUP BY k")?
            .row_count)
    };
    run().map(|n| n as u32).unwrap_or(u32::MAX)
}

thread_local! {
    static BENCH: std::cell::RefCell<Option<Store>> = const { std::cell::RefCell::new(None) };
}

/// Bench export for the wasm lane (`bench/wasm-1m.mjs`): import the 1M-row
/// CSV of the DuckDB baseline, generated in the module, into a fresh store.
/// Returns the row count (or `u32::MAX` on failure); the caller times it.
#[no_mangle]
pub extern "C" fn spike_bench_ingest(rows: u32) -> u32 {
    panic_hook();
    use std::fmt::Write;
    let n = rows as usize;
    let mut text = String::from("sku,name,price,cat\n");
    for i in 0..n {
        let _ = writeln!(
            text,
            "SKU-{},item {i},{},cat-{}",
            (i * 7919) % n,
            (i % 10_000) as f64 * 0.25,
            i % 100
        );
    }
    let run = || -> Result<u32> {
        let store = Store::new()?;
        store.import_csv("big", &text, Typing::Infer)?;
        BENCH.with(|b| *b.borrow_mut() = Some(store));
        Ok(rows)
    };
    run().unwrap_or(u32::MAX)
}

/// Bench export: the baseline's grouped query over the imported table, or,
/// with `all = 1`, `SELECT *` to a record set. Returns the row count.
#[no_mangle]
pub extern "C" fn spike_bench_query(all: u32) -> u32 {
    let sql = if all == 1 {
        "SELECT * FROM big"
    } else {
        "SELECT cat, count(*) AS n, sum(price) AS total FROM big GROUP BY cat ORDER BY cat"
    };
    BENCH.with(|b| match b.borrow().as_ref().map(|s| s.query(sql)) {
        Some(Ok(rs)) => rs.row_count as u32,
        _ => u32::MAX,
    })
}

fn panic_hook() {
    #[cfg(target_arch = "wasm32")]
    console_error_panic_hook::set_once();
}

/// Turso's `MemoryIO` reads the clock through `std::time`, which panics on
/// `wasm32-unknown-unknown`; on wasm the store wraps it with a clock read from
/// JavaScript (`performance.now`, `Date.now`). Native builds use it as is.
mod clock {
    #[cfg(not(target_arch = "wasm32"))]
    pub use turso_core::MemoryIO as StoreIO;

    #[cfg(target_arch = "wasm32")]
    pub use wasm::StoreIO;

    #[cfg(target_arch = "wasm32")]
    mod wasm {
        use std::sync::Arc;

        use turso_core::{
            Clock, Completion, File, MemoryIO, MonotonicInstant, OpenFlags, WallClockInstant, IO,
        };

        pub struct StoreIO(MemoryIO);

        impl StoreIO {
            pub fn new() -> Self {
                StoreIO(MemoryIO::new())
            }
        }

        impl Clock for StoreIO {
            fn current_time_monotonic(&self) -> MonotonicInstant {
                let ms = js_sys::Reflect::get(&js_sys::global(), &"performance".into())
                    .ok()
                    .and_then(|p| js_sys::Reflect::get(&p, &"now".into()).ok().map(|f| (p, f)))
                    .and_then(|(p, f)| js_sys::Function::from(f).call0(&p).ok())
                    .and_then(|v| v.as_f64())
                    .unwrap_or_else(js_sys::Date::now);
                MonotonicInstant::from_nanos((ms * 1_000_000.0) as u128)
            }

            fn current_time_wall_clock(&self) -> WallClockInstant {
                let ms = js_sys::Date::now();
                WallClockInstant {
                    secs: (ms / 1000.0).floor() as i64,
                    micros: ((ms % 1000.0) * 1000.0) as u32,
                }
            }
        }

        impl IO for StoreIO {
            fn open_file(
                &self,
                path: &str,
                flags: OpenFlags,
                direct: bool,
            ) -> turso_core::Result<Arc<dyn File>> {
                self.0.open_file(path, flags, direct)
            }

            fn remove_file(&self, path: &str) -> turso_core::Result<()> {
                self.0.remove_file(path)
            }

            fn step(&self) -> turso_core::Result<()> {
                self.0.step()
            }

            fn cancel(&self, c: &[Completion]) -> turso_core::Result<()> {
                self.0.cancel(c)
            }

            fn file_id(&self, path: &str) -> turso_core::Result<turso_core::io::FileId> {
                self.0.file_id(path)
            }
        }
    }
}
