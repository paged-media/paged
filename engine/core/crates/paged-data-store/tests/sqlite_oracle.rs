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

//! The SQLite SQL oracle (docs/design/oracles.md): the recorded answers of the
//! native sqlite3 CLI (`tests/sqlite-sql/recorded/results.json`) for
//! the cases of `cases.json`, replayed through the store. Values compare as
//! the CLI's JSON writes them: a number (within 1e-12, the CLI prints 1e300 as
//! 9.999999999999999e+299), a string, null. A case marked `gap` is one Turso
//! answers differently or not at all; it is pinned as such.

#![allow(non_snake_case)] // the `__feat__<id>` suffix links each test to its cockpit feature

use data_core::Value;
use data_store::{Store, StoreError};
use serde_json::Value as Json;

fn lane(file: &str) -> Json {
    let p = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/sqlite-sql")
        .join(file);
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

fn same(ours: &Value, theirs: &Json) -> bool {
    match (ours, theirs) {
        (Value::Null, Json::Null) => true,
        (Value::Text(a), Json::String(b)) => a.as_str() == b,
        (Value::Number(a), Json::Number(b)) => {
            let b = b.as_f64().unwrap();
            a == &b || (a - b).abs() <= 1e-12 * a.abs().max(b.abs())
        }
        _ => false,
    }
}

#[test]
fn the_store_answers_as_sqlite_does__feat__data_store_turso() {
    let cases = lane("cases.json");
    let recorded = lane("recorded/results.json");
    let store = Store::new().unwrap();
    for s in cases["setup"].as_array().unwrap() {
        store.execute_trusted(s.as_str().unwrap()).unwrap();
    }
    let (mut agree, mut gaps) = (Vec::new(), Vec::new());
    let mut wrong = Vec::new();
    for c in cases["cases"].as_array().unwrap() {
        let id = c["id"].as_str().unwrap();
        let theirs = &recorded["results"][id]["rows"];
        assert!(
            theirs.is_array(),
            "{id}: sqlite did not answer ({})",
            recorded["results"][id]
        );
        let ours = store.query(c["sql"].as_str().unwrap());
        let matches = match &ours {
            Ok(rs) => {
                let rows = theirs.as_array().unwrap();
                rs.row_count == rows.len()
                    && rows.iter().enumerate().all(|(r, row)| {
                        let row = row.as_array().unwrap();
                        row.len() == rs.columns.len()
                            && row
                                .iter()
                                .enumerate()
                                .all(|(col, v)| same(rs.value(r, col).unwrap(), v))
                    })
            }
            Err(_) => false,
        };
        let detail = match &ours {
            Ok(rs) => format!(
                "{:?}",
                (0..rs.row_count)
                    .map(|r| (0..rs.columns.len())
                        .map(|c| rs.value(r, c).unwrap().as_display())
                        .collect::<Vec<_>>())
                    .collect::<Vec<_>>()
            ),
            Err(StoreError::Sql(d)) => d.to_string(),
            Err(e) => e.to_string(),
        };
        match (c.get("gap"), matches) {
            (None, true) => agree.push(id),
            (Some(_), false) => gaps.push(id),
            (None, false) => wrong.push(format!("{id}: ours {detail}, sqlite {theirs}")),
            (Some(g), true) => {
                wrong.push(format!("{id}: the gap is closed ({g}) — remove the pin"))
            }
        }
    }
    println!(
        "agree {}: {agree:?}\ngaps {}: {gaps:?}",
        agree.len(),
        gaps.len()
    );
    assert!(wrong.is_empty(), "{wrong:#?}");
    assert_eq!((agree.len(), gaps.len()), (24, 1));
}
