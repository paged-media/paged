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

//! paged.data's store (PM-0015, ADR 561): the imported sources live as tables
//! of an in-memory Turso database (`turso_core`, MIT, a Rust implementation of
//! SQLite), and every query over them comes back as a `data_core::RecordSet`,
//! the type the binding engine consumes. Nothing crosses a language boundary
//! between a query and the engine.
//!
//! - [`read`] turns a file (CSV/TSV, JSON, Parquet, XLSX) into a [`Table`]:
//!   named, typed columns and their cells.
//! - [`Store`] loads tables and answers queries. User queries run on a
//!   connection in `query_only` mode; the bundle's lexer guard (one SELECT over
//!   the source tables, no statement keyword) runs before any of them.
//! - SQLite has no DATE, TIMESTAMP, BOOLEAN or DECIMAL storage class. A column
//!   of one of those types is DECLARED with it ([`ColumnType::sql`]) and stored
//!   as ISO text, 0/1 or a REAL; a query reading the column maps the value back
//!   to `Value::Date` / `DateTime` / `Bool`, and a decimal keeps its scale
//!   (`1234.50`), so a field displays as the file wrote it.
//! - A CSV is kept twice: typed, and as written (every column text, the way
//!   InDesign's Data Merge reads it), for [`Store::query_as_written`].

mod clock;
mod diag;
pub mod guard;
pub mod read;
mod store;
mod types;

pub use diag::Diagnostic;
pub use read::{Cell, Column, Format, Table};
pub use store::{ColumnInfo, ImportReport, Preview, RowEdit, Store, AS_WRITTEN_PREFIX};
pub use types::ColumnType;

/// A store failure: an engine error (with the SQL's diagnostic), a file that
/// does not read, or a refused input.
#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("{0}")]
    Sql(Diagnostic),
    #[error("{0}")]
    Read(String),
}

pub type Result<T> = std::result::Result<T, StoreError>;
