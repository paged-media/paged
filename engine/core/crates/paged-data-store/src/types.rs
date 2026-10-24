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

//! The column types the store declares, and how a declared type reads back.
//!
//! SQLite stores NULL, INTEGER, REAL, TEXT and BLOB. The other types a source
//! has are declared on the column and stored in one of those: a DATE or
//! TIMESTAMP as ISO text, a BOOLEAN as 0/1, a DECIMAL(18, s) as a REAL. A
//! query that reads the column gets its declared type back from Turso
//! (`get_column_decltype`), and [`field_of_declared`] turns it into the
//! engine's field type; a computed column has none and is typed by its values.

use data_core::FieldType;

/// The type of an imported column.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ColumnType {
    Integer,
    /// A number written with a fixed number of decimals (`1234.50`): stored
    /// as a REAL, displayed with `scale` digits after the point.
    Decimal {
        scale: u8,
    },
    Real,
    Boolean,
    /// `YYYY-MM-DD`, stored as that text.
    Date,
    /// `YYYY-MM-DD HH:MM:SS[.fff]`, stored as that text.
    Timestamp,
    Text,
}

impl ColumnType {
    /// The declared SQL type.
    pub fn sql(self) -> String {
        match self {
            ColumnType::Integer => "INTEGER".into(),
            // Turso keeps a declared type's name without its parameters
            // (`DECIMAL(18,2)` reads back as `DECIMAL`), so the scale is part
            // of the name. The name keeps SQLite's NUMERIC affinity.
            ColumnType::Decimal { scale } => format!("DECIMAL_S{scale}"),
            ColumnType::Real => "REAL".into(),
            ColumnType::Boolean => "BOOLEAN".into(),
            ColumnType::Date => "DATE".into(),
            ColumnType::Timestamp => "TIMESTAMP".into(),
            ColumnType::Text => "TEXT".into(),
        }
    }
}

impl ColumnType {
    /// The type as the panels and the query builders show it
    /// (`DECIMAL(18,2)`); [`ColumnType::sql`] is what the store declares.
    pub fn name(self) -> String {
        match self {
            ColumnType::Decimal { scale } => format!("DECIMAL(18,{scale})"),
            other => other.sql(),
        }
    }
}

/// The engine's field type (and a decimal's scale) for a declared SQL type,
/// or `None` for a declaration that says nothing the values would not
/// (`NUMERIC`, `ANY`, an empty declaration).
pub fn field_of_declared(decl: &str) -> Option<(FieldType, Option<u8>)> {
    let d = decl.trim().to_ascii_uppercase();
    if d.is_empty() {
        return None;
    }
    if d.contains("BOOL") {
        return Some((FieldType::Bool, None));
    }
    if d.contains("TIMESTAMP") || d.contains("DATETIME") {
        return Some((FieldType::DateTime, None));
    }
    if d == "DATE" {
        return Some((FieldType::Date, None));
    }
    if d.contains("INT") {
        return Some((FieldType::Int, None));
    }
    if let Some(scale) = d.strip_prefix("DECIMAL_S") {
        return scale
            .parse::<u8>()
            .ok()
            .map(|s| (FieldType::Float, Some(s)));
    }
    if d.starts_with("DECIMAL") || d.starts_with("NUMERIC") {
        // DECIMAL(p, s): the scale after the comma.
        let scale = d
            .split_once(',')
            .and_then(|(_, s)| s.trim_end_matches(')').trim().parse::<u8>().ok());
        return scale.map(|s| (FieldType::Float, Some(s)));
    }
    if d.contains("REAL") || d.contains("FLOA") || d.contains("DOUB") {
        return Some((FieldType::Float, None));
    }
    if d.contains("CHAR") || d.contains("CLOB") || d.contains("TEXT") {
        return Some((FieldType::Text, None));
    }
    if d.contains("BLOB") {
        return Some((FieldType::Bytes, None));
    }
    None
}

/// The type name a field type is shown as (the query builders read it).
pub fn type_name(ty: FieldType, scale: Option<u8>) -> String {
    match (ty, scale) {
        (FieldType::Float, Some(s)) => format!("DECIMAL(18,{s})"),
        (FieldType::Bool, _) => "BOOLEAN".into(),
        (FieldType::Int, _) => "INTEGER".into(),
        (FieldType::Float, None) => "REAL".into(),
        (FieldType::Text, _) => "TEXT".into(),
        (FieldType::Date, _) => "DATE".into(),
        (FieldType::DateTime, _) => "TIMESTAMP".into(),
        (FieldType::Bytes, _) => "BLOB".into(),
        (FieldType::Null, _) => "NULL".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_declared_type_reads_back_as_itself() {
        for (ty, field, scale) in [
            (ColumnType::Integer, FieldType::Int, None),
            (ColumnType::Decimal { scale: 2 }, FieldType::Float, Some(2)),
            (ColumnType::Real, FieldType::Float, None),
            (ColumnType::Boolean, FieldType::Bool, None),
            (ColumnType::Date, FieldType::Date, None),
            (ColumnType::Timestamp, FieldType::DateTime, None),
            (ColumnType::Text, FieldType::Text, None),
        ] {
            assert_eq!(field_of_declared(&ty.sql()), Some((field, scale)), "{ty:?}");
            assert_eq!(type_name(field, scale), ty.name());
        }
    }

    #[test]
    fn a_type_reads_back_under_the_name_the_builders_show() {
        assert_eq!(type_name(FieldType::Float, Some(2)), "DECIMAL(18,2)");
        assert_eq!(
            field_of_declared("DECIMAL(10,3)"),
            Some((FieldType::Float, Some(3)))
        );
        assert_eq!(type_name(FieldType::DateTime, None), "TIMESTAMP");
    }

    #[test]
    fn sqlite_affinity_names_map_to_field_types() {
        assert_eq!(
            field_of_declared("varchar(20)"),
            Some((FieldType::Text, None))
        );
        assert_eq!(field_of_declared("BIGINT"), Some((FieldType::Int, None)));
        assert_eq!(
            field_of_declared("DOUBLE PRECISION"),
            Some((FieldType::Float, None))
        );
        assert_eq!(field_of_declared("NUMERIC"), None);
        assert_eq!(field_of_declared(""), None);
    }
}
