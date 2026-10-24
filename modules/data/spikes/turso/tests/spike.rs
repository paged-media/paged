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

//! The spike's measurements, each printed for the report
//! (`docs/design/turso-spike-2026-10.md`) and pinned where the answer is a
//! behaviour rather than a time.

#![allow(non_snake_case)] // the `__feat__<id>` suffix links each test to its cockpit feature

use std::path::PathBuf;
use std::time::Instant;

use data_core::{FieldType, Value};
use data_store_spike::{ColumnType, Store, Typing};

fn lane(parts: &[&str]) -> PathBuf {
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../conformance");
    for part in parts {
        p.push(part);
    }
    p
}

#[test]
fn a_csv_becomes_a_table_and_a_query_a_record_set__feat__data_store_turso() {
    let store = Store::new().unwrap();
    let types = store
        .import_csv(
            "t",
            "sku,name,price\nA-1,Pen,1.50\nA-2,Ink,2\nA-3,Pad,\n",
            Typing::Infer,
        )
        .unwrap();
    assert_eq!(
        types,
        [ColumnType::Text, ColumnType::Text, ColumnType::Real]
    );
    let rs = store
        .query("SELECT sku, price FROM t WHERE price IS NOT NULL ORDER BY sku")
        .unwrap();
    assert_eq!(rs.row_count, 2);
    assert_eq!(rs.schema.fields[0].ty, FieldType::Text);
    assert_eq!(rs.schema.fields[1].ty, FieldType::Float);
    assert_eq!(rs.value(0, 1), Some(&Value::Number(1.5)));
}

#[test]
fn query_only_refuses_writes_but_not_the_pragma_that_lifts_it__feat__data_store_turso() {
    let store = Store::new().unwrap();
    store.import_csv("t", "k\na\n", Typing::AsWritten).unwrap();
    for sql in [
        "INSERT INTO t VALUES ('b')",
        "DELETE FROM t",
        "CREATE TABLE u (x)",
        "DROP TABLE t",
    ] {
        assert!(store.query(sql).is_err(), "query_only let through: {sql}");
    }
    // The pragma that turns the mode off is not a write, so the reader takes
    // it; the lexer guard (src/query/sql.ts) must keep refusing PRAGMA and
    // ATTACH, as it refuses every statement keyword today.
    assert!(store.query("PRAGMA query_only = 0").is_ok());
    assert!(
        store.query("INSERT INTO t VALUES ('b')").is_ok(),
        "Turso 0.8.3 lets a reader lift query_only; if this fails, the mode now holds"
    );
}

#[test]
fn the_duckdb_sql_cases_as_written__feat__data_store_turso() {
    let cases: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(lane(&["duckdb-sql", "cases.json"])).unwrap(),
    )
    .unwrap();
    let store = Store::new().unwrap();
    for name in ["quoting", "types", "utf8"] {
        let text =
            std::fs::read_to_string(lane(&["duckdb-sql", "csv", &format!("{name}.csv")])).unwrap();
        store.import_csv(name, &text, Typing::Infer).unwrap();
    }
    let mut ran = Vec::new();
    let mut failed = Vec::new();
    for case in cases["cases"].as_array().unwrap() {
        let id = case["id"].as_str().unwrap();
        match store.query(case["sql"].as_str().unwrap()) {
            Ok(rs) => ran.push(format!("{id} ({} rows)", rs.row_count)),
            Err(e) => failed.push(format!("{id}: {e}")),
        }
    }
    println!("ran as written: {}", ran.len());
    for r in &ran {
        println!("  ok   {r}");
    }
    for f in &failed {
        println!("  FAIL {f}");
    }
    assert_eq!(ran.len() + failed.len(), 18);
    // Pinned: the five that need no DuckDB syntax (casts with `::`, typed
    // literals, `t(v)` column aliases, `strlen`) and no ordered aggregate.
    assert_eq!(ran.len(), 5, "{failed:#?}");
}

#[test]
fn indesign_merge_csvs_keep_their_text__feat__data_store_turso() {
    let dir = lane(&["indesign-merge", "csv"]);
    let mut names: Vec<_> = std::fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    names.sort();
    let (mut fields, mut as_written, mut inferred) = (0, 0, 0);
    for path in names {
        let text = std::fs::read_to_string(&path).unwrap();
        let text = text.trim_start_matches('\u{feff}');
        let mut rdr = csv::ReaderBuilder::new().from_reader(text.as_bytes());
        let raw: Vec<Vec<String>> = rdr
            .records()
            .map(|r| r.unwrap().iter().map(str::to_owned).collect())
            .collect();
        for (typing, hits) in [
            (Typing::AsWritten, &mut as_written),
            (Typing::Infer, &mut inferred),
        ] {
            let store = Store::new().unwrap();
            store.import_csv("m", text, typing).unwrap();
            let rs = store.query("SELECT * FROM m").unwrap();
            for (r, row) in raw.iter().enumerate() {
                for (c, field) in row.iter().enumerate() {
                    let shown = rs.value(r, c).unwrap().as_display();
                    if &shown == field {
                        *hits += 1;
                    }
                }
            }
        }
        fields += raw.iter().map(Vec::len).sum::<usize>();
    }
    println!("InDesign merge CSV fields: {fields}; text kept as written: {as_written}; with inferred types: {inferred}");
    assert_eq!(
        as_written, fields,
        "as-written import changed a field's text"
    );
    // Inferred REAL drops trailing zeros (1234.50 → 1234.5), the DM-8 pattern.
    assert_eq!((fields, inferred), (261, 250));
}

/// Opt-in (`PERF_TURSO_1M=1`, run with `--release`): the 1M-row CSV of the
/// DuckDB baseline (`packages/data-bundle/test/perf/duckdb-1m.trend.spec.ts`).
#[test]
fn one_million_rows__feat__data_store_turso() {
    if std::env::var("PERF_TURSO_1M").as_deref() != Ok("1") {
        println!("skipped: set PERF_TURSO_1M=1");
        return;
    }
    let n: usize = 1_000_000;
    let mut text = String::from("sku,name,price,cat\n");
    for i in 0..n {
        use std::fmt::Write;
        writeln!(
            text,
            "SKU-{},item {i},{},cat-{}",
            (i * 7919) % n,
            (i % 10_000) as f64 * 0.25,
            i % 100
        )
        .unwrap();
    }
    println!("CSV bytes: {}", text.len());
    for run in 1..=2 {
        let store = Store::new().unwrap();
        let t = Instant::now();
        store.import_csv("big", &text, Typing::Infer).unwrap();
        let ingest = t.elapsed();
        let t = Instant::now();
        let g = store
            .query(
                "SELECT cat, count(*) AS n, sum(price) AS total FROM big GROUP BY cat ORDER BY cat",
            )
            .unwrap();
        let group = t.elapsed();
        assert_eq!(g.row_count, 100);
        let t = Instant::now();
        let all = store.query("SELECT * FROM big").unwrap();
        let select_all = t.elapsed();
        assert_eq!(all.row_count, n);
        println!(
            "run {run}: ingest {} ms, grouped query {} ms, SELECT * to RecordSet {} ms",
            ingest.as_millis(),
            group.as_millis(),
            select_all.as_millis()
        );
    }
}

/// Opt-in with the 1M lane: where the ingest time goes, and the two levers a
/// row store has for the grouped query.
#[test]
fn one_million_rows_levers__feat__data_store_turso() {
    if std::env::var("PERF_TURSO_1M").as_deref() != Ok("1") {
        println!("skipped: set PERF_TURSO_1M=1");
        return;
    }
    let n: usize = 1_000_000;
    let mut text = String::from("sku,name,price,cat\n");
    for i in 0..n {
        use std::fmt::Write;
        writeln!(
            text,
            "SKU-{},item {i},{},cat-{}",
            (i * 7919) % n,
            (i % 10_000) as f64 * 0.25,
            i % 100
        )
        .unwrap();
    }
    let t = Instant::now();
    let mut rdr = csv::ReaderBuilder::new().from_reader(text.as_bytes());
    let rows = rdr.records().inspect(|r| assert!(r.is_ok())).count();
    println!(
        "CSV parse alone ({rows} records): {} ms",
        t.elapsed().as_millis()
    );

    let store = Store::new().unwrap();
    store
        .execute("CREATE TABLE big (sku TEXT, name TEXT, price REAL, cat TEXT)")
        .unwrap();
    let t = Instant::now();
    store.execute("BEGIN").unwrap();
    let mut rdr = csv::ReaderBuilder::new().from_reader(text.as_bytes());
    let mut chunk = Vec::with_capacity(500);
    let flush = |chunk: &mut Vec<String>| {
        if !chunk.is_empty() {
            store
                .execute(&format!("INSERT INTO big VALUES {}", chunk.join(",")))
                .unwrap();
            chunk.clear();
        }
    };
    for r in rdr.records() {
        let r = r.unwrap();
        chunk.push(format!("('{}','{}',{},'{}')", &r[0], &r[1], &r[2], &r[3]));
        if chunk.len() == 500 {
            flush(&mut chunk);
        }
    }
    flush(&mut chunk);
    store.execute("COMMIT").unwrap();
    println!(
        "multi-row INSERT, 500 rows per statement: {} ms",
        t.elapsed().as_millis()
    );

    let q = "SELECT cat, count(*) AS n, sum(price) AS total FROM big GROUP BY cat ORDER BY cat";
    let t = Instant::now();
    assert_eq!(store.query(q).unwrap().row_count, 100);
    println!("grouped query, no index: {} ms", t.elapsed().as_millis());
    let t = Instant::now();
    store.execute("CREATE INDEX big_cat ON big(cat)").unwrap();
    println!("CREATE INDEX on cat: {} ms", t.elapsed().as_millis());
    let t = Instant::now();
    assert_eq!(store.query(q).unwrap().row_count, 100);
    println!(
        "grouped query, with the index: {} ms",
        t.elapsed().as_millis()
    );
}
