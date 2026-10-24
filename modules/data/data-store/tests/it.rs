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

//! The store (ADR 561): files into tables, queries into record sets.

#![allow(non_snake_case)] // the `__feat__<id>` suffix links each test to its cockpit feature

use data_core::{FieldType, Value};
use data_store::read::{csv, infer_column, normal_timestamp, sniff_delimiter, timestamp_ms};
use data_store::{ColumnType, Format, Store, StoreError};

fn lane(parts: &[&str]) -> std::path::PathBuf {
    let mut p = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../conformance");
    for part in parts {
        p.push(part);
    }
    p
}

fn text(v: &Value) -> String {
    v.as_display()
}

#[test]
fn csv_columns_are_typed_from_their_fields__feat__data_store_turso() {
    use ColumnType::*;
    let cases: [(&[&str], ColumnType); 11] = [
        (&["1", "-20", ""], Integer),
        (&["1.50", "2", "10.125"], Decimal { scale: 3 }),
        (&["1e3", "2.5"], Real),
        (&["true", "FALSE"], Boolean),
        (&["2024-02-29", ""], Date),
        (&["2024-02-29 10:00", "2024-03-01T08:30:15.250Z"], Timestamp),
        (&["2024-02-29", "2024-03-01 08:30:00"], Timestamp),
        (&["2024-02-30"], Text),
        (&["", ""], Text),
        // A leading zero or an explicit + is a code: its text matters.
        (&["0007", "-3"], Text),
        (&["1.5", "+12"], Text),
    ];
    for (fields, ty) in cases {
        assert_eq!(infer_column(fields.iter().copied()), ty, "{fields:?}");
    }
    assert_eq!(infer_column(["inf", "1"].into_iter()), Text);
    assert_eq!(
        normal_timestamp("2024-01-02T03:04Z").as_deref(),
        Some("2024-01-02 03:04:00")
    );
    assert_eq!(timestamp_ms("1970-01-02 00:00:01.5"), Some(86_401_500));
}

#[test]
fn a_csv_delimiter_is_sniffed_and_its_header_named__feat__data_store_turso() {
    assert_eq!(sniff_delimiter("a;b;c\n1;2;3\n"), b';');
    assert_eq!(sniff_delimiter("a\tb\n1\t2\n"), b'\t');
    assert_eq!(sniff_delimiter("name\nPen, blue\n"), b',');
    let (typed, written) = csv("\u{feff}sku;;sku\nA;1;x\nB\n", None).unwrap();
    let names: Vec<&str> = typed.columns.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(names, ["sku", "column_2", "sku_2"]);
    // A short line reads as empty fields.
    assert_eq!(typed.rows.len(), 2);
    assert_eq!(
        written
            .columns
            .iter()
            .filter(|c| c.ty == ColumnType::Text)
            .count(),
        3
    );
}

#[test]
fn a_query_reads_declared_types_back__feat__data_store_turso() {
    let s = Store::new().unwrap();
    let csv = "sku,price,qty,launched,updated,active,note\n\
               A-1,1234.50,3,2026-01-15,2026-01-15 09:30:00,true,first\n\
               A-2,2.00,,2026-02-01,2026-02-01 00:00:00,false,\n";
    let r = s.import("p", Format::Csv, csv.as_bytes(), None).unwrap();
    assert_eq!(r.rows, 2);
    assert!(r.as_written);
    let rs = s.query("SELECT * FROM p ORDER BY sku").unwrap();
    let ty: Vec<(FieldType, Option<u8>)> =
        rs.schema.fields.iter().map(|f| (f.ty, f.scale)).collect();
    use FieldType::*;
    assert_eq!(
        ty,
        [
            (Text, None),
            (Float, Some(2)),
            (Int, None),
            (Date, None),
            (DateTime, None),
            (Bool, None),
            (Text, None)
        ]
    );
    assert_eq!(rs.value(0, 1), Some(&Value::Number(1234.5)));
    assert_eq!(rs.value(1, 2), Some(&Value::Null));
    assert_eq!(text(rs.value(0, 3).unwrap()), "2026-01-15");
    assert_eq!(text(rs.value(0, 4).unwrap()), "2026-01-15 09:30:00");
    assert_eq!(rs.value(1, 5), Some(&Value::Bool(false)));
    // A computed column is typed by its values.
    let g = s
        .query("SELECT count(*) AS n, sum(price) AS total FROM p")
        .unwrap();
    assert_eq!((g.schema.fields[0].ty, g.schema.fields[1].ty), (Int, Float));
    assert_eq!(g.value(0, 1), Some(&Value::Number(1236.5)));
}

#[test]
fn the_query_connection_refuses_writes__feat__data_store_turso() {
    let s = Store::new().unwrap();
    s.import("t", Format::Csv, b"k\na\n", None).unwrap();
    for sql in [
        "INSERT INTO t VALUES ('b')",
        "DELETE FROM t",
        "DROP TABLE t",
        "CREATE TABLE u (x)",
    ] {
        match s.query(sql) {
            Err(StoreError::Sql(_)) => {}
            other => panic!("{sql}: {other:?}"),
        }
    }
    assert_eq!(s.query("SELECT * FROM t").unwrap().row_count, 1);
    assert_eq!(s.tables().unwrap(), ["t"]);
}

#[test]
fn indesign_merge_csvs_read_as_written__feat__data_store_turso() {
    let dir = lane(&["indesign-merge", "csv"]);
    let mut paths: Vec<_> = std::fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    paths.sort();
    let (mut fields, mut same) = (0, 0);
    for path in paths {
        let raw = std::fs::read_to_string(&path).unwrap();
        let s = Store::new().unwrap();
        s.import("m", Format::Csv, raw.as_bytes(), None).unwrap();
        let rs = s
            .query_as_written("SELECT * FROM m", &["m".to_string()])
            .unwrap()
            .expect("a CSV has a twin");
        let mut rdr =
            ::csv::ReaderBuilder::new().from_reader(raw.trim_start_matches('\u{feff}').as_bytes());
        for (r, rec) in rdr.records().enumerate() {
            for (c, f) in rec.unwrap().iter().enumerate() {
                fields += 1;
                if text(rs.value(r, c).unwrap()) == f {
                    same += 1;
                }
            }
        }
        // The typed table is back under its name afterwards.
        assert_eq!(s.tables().unwrap(), ["m"]);
        assert!(s.query("SELECT * FROM m").is_ok());
    }
    assert_eq!((fields, same), (261, 261));
}

#[test]
fn json_arrays_and_lines_import__feat__data_store_turso() {
    let s = Store::new().unwrap();
    let array = br#"[{"sku":"A","n":1,"price":2.5,"on":true,"day":"2026-01-02","tags":["x"]},
                     {"sku":"B","n":2,"extra":"late"}]"#;
    let r = s.import("a", Format::Json, array, None).unwrap();
    let cols: Vec<(String, String)> = r
        .columns
        .iter()
        .map(|c| (c.name.clone(), c.ty.name()))
        .collect();
    assert_eq!(
        cols,
        [
            ("sku".into(), "TEXT".into()),
            ("n".into(), "INTEGER".into()),
            ("price".into(), "REAL".into()),
            ("on".into(), "BOOLEAN".into()),
            ("day".into(), "DATE".into()),
            ("tags".into(), "TEXT".into()),
            ("extra".into(), "TEXT".into()),
        ]
    );
    let rs = s.query("SELECT tags, extra FROM a ORDER BY sku").unwrap();
    assert_eq!(text(rs.value(0, 0).unwrap()), r#"["x"]"#);
    assert_eq!(rs.value(1, 1), Some(&Value::Text("late".into())));
    let lines = b"{\"k\":1}\n\n{\"k\":2}\n";
    assert_eq!(s.import("l", Format::Json, lines, None).unwrap().rows, 2);
    match s.import("bad", Format::Json, b"[1,2]", None) {
        Err(StoreError::Read(m)) => assert!(m.contains("not an object"), "{m}"),
        other => panic!("{other:?}"),
    }
}

#[test]
fn the_parquet_fixture_imports__feat__data_store_turso() {
    let s = Store::new().unwrap();
    let bytes = std::fs::read(lane(&["sources", "products.parquet"])).unwrap();
    let r = s.import("p", Format::Parquet, &bytes, None).unwrap();
    let cols: Vec<(String, String)> = r
        .columns
        .iter()
        .map(|c| (c.name.clone(), c.ty.name()))
        .collect();
    assert_eq!(
        cols,
        [
            ("sku".into(), "TEXT".into()),
            ("price".into(), "DECIMAL(18,2)".into()),
            ("qty".into(), "INTEGER".into()),
            ("launched".into(), "DATE".into()),
        ]
    );
    assert_eq!(r.rows, 3);
    let p = s.preview("SELECT * FROM p ORDER BY sku", 10).unwrap();
    assert_eq!(p.count, 3);
    assert_eq!(p.rows[0][1].as_deref().map(|v| v.contains('.')), Some(true));
}

#[test]
fn the_xlsx_fixture_imports_with_its_worksheet_types__feat__data_store_turso() {
    let s = Store::new().unwrap();
    let bytes = std::fs::read(lane(&["sources", "products.xlsx"])).unwrap();
    let r = s.import("x", Format::Xlsx, &bytes, None).unwrap();
    assert_eq!(r.sheet.as_deref(), Some("Products"));
    assert_eq!(
        r.sheets.as_deref(),
        Some(&["Products".to_string(), "Prices".to_string()][..])
    );
    assert_eq!(r.error_cells, 1);
    let rs = s
        .query("SELECT sku, launched, active FROM x ORDER BY sku")
        .unwrap();
    assert_eq!(rs.schema.fields[1].ty, FieldType::Date);
    assert_eq!(rs.schema.fields[2].ty, FieldType::Bool);
    assert_eq!(rs.row_count, 4);
    let prices = s.import("y", Format::Xlsx, &bytes, Some("Prices")).unwrap();
    assert_eq!(prices.sheet.as_deref(), Some("Prices"));
}

#[test]
fn describe_and_preview_show_what_a_query_makes__feat__data_store_turso() {
    let s = Store::new().unwrap();
    s.import(
        "t",
        Format::Csv,
        b"k,v,d\na,1.50,2026-01-02\nb,2.25,\na,3.00,2026-01-04\n",
        None,
    )
    .unwrap();
    let cols = s.describe("SELECT k, v, d, v * 2 AS w FROM t").unwrap();
    let ty: Vec<&str> = cols.iter().map(|c| c.ty.as_str()).collect();
    assert_eq!(ty, ["TEXT", "DECIMAL(18,2)", "DATE", "REAL"]);
    let p = s.preview("SELECT k, v, d FROM t ORDER BY v", 2).unwrap();
    assert_eq!(p.count, 3);
    assert_eq!(
        p.rows,
        [
            vec![
                Some("a".into()),
                Some("1.50".into()),
                Some("2026-01-02".into())
            ],
            vec![Some("b".into()), Some("2.25".into()), None],
        ]
    );
}

#[test]
fn a_failing_query_is_a_diagnostic__feat__data_store_turso() {
    let s = Store::new().unwrap();
    s.import("t", Format::Csv, b"k\na\n", None).unwrap();
    let diag = |sql: &str| match s.query(sql) {
        Err(StoreError::Sql(d)) => d,
        other => panic!("{sql}: {other:?}"),
    };
    let d = diag("SELECT * FROM nope");
    assert_eq!(d.kind, "Catalog", "{d:?}");
    let d = diag("SELECT k FROM t WHERE");
    assert_eq!(d.kind, "Parser", "{d:?}");
    let d = diag("SELECT 1::INT");
    assert_eq!((d.kind.as_str(), d.offset), ("Parser", Some(8)), "{d:?}");
    let d = diag("SELECT 'open");
    assert_eq!(d.kind, "Parser", "{d:?}");
    assert!(d.offset.is_some(), "{d:?}");
}

#[test]
fn a_source_imported_again_replaces_its_table__feat__data_store_turso() {
    let s = Store::new().unwrap();
    s.import("t", Format::Csv, b"k\na\nb\n", None).unwrap();
    s.import("t", Format::Json, br#"[{"x":1}]"#, None).unwrap();
    let rs = s.query("SELECT * FROM t").unwrap();
    assert_eq!((rs.schema.fields[0].name.as_str(), rs.row_count), ("x", 1));
    // JSON keeps no twin: an as-written query has nothing to read.
    assert!(s
        .query_as_written("SELECT * FROM t", &["t".to_string()])
        .unwrap()
        .is_none());
    s.drop_source("t").unwrap();
    assert!(s.tables().unwrap().is_empty());
}
