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

//! The engine's query guard against the bundle's matrix
//! (`modules/data/conformance/query-guard/cases.json`): every reach outside
//! the imported tables is refused for the same reason, and every ordinary
//! query is admitted and answers the same rows in the store.

#![allow(non_snake_case)] // the `__feat__<id>` suffix links each test to its cockpit feature

use data_store::guard::{check_query, trim_sql};
use data_store::{Format, Store};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Matrix {
    fixture_csv: std::collections::BTreeMap<String, String>,
    refused: Vec<Refused>,
    allowed: Vec<Allowed>,
}

#[derive(Deserialize)]
struct Refused {
    sql: String,
    why: String,
}

#[derive(Deserialize)]
struct Allowed {
    sql: String,
    rows: Vec<Vec<Option<String>>>,
}

fn matrix() -> Matrix {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../../modules/data/conformance/query-guard/cases.json");
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    serde_json::from_str(&text).expect("cases.json")
}

#[test]
fn the_guard_refuses_what_the_bundle_refuses__feat__data_security_gates() {
    let m = matrix();
    assert!(m.refused.len() >= 40);
    for r in &m.refused {
        match check_query(&r.sql) {
            Ok(()) => panic!("admitted {:?}", r.sql),
            Err(e) => assert!(
                e.message.contains(&r.why),
                "{:?}: refused with {:?}, expected it to say {:?}",
                r.sql,
                e.message,
                r.why
            ),
        }
    }
}

#[test]
fn the_guard_admits_what_the_bundle_admits_and_the_store_answers__feat__data_security_gates() {
    let m = matrix();
    let store = Store::new().unwrap();
    for (name, csv) in &m.fixture_csv {
        store
            .import(name, Format::Csv, csv.as_bytes(), None)
            .unwrap();
    }
    for a in &m.allowed {
        if let Err(e) = check_query(&a.sql) {
            panic!("refused {:?}: {e}", a.sql);
        }
        let got = store
            .preview(trim_sql(&a.sql), usize::MAX)
            .unwrap_or_else(|e| panic!("{:?}: {e}", a.sql));
        assert_eq!(got.rows, a.rows, "{:?}", a.sql);
    }
}

#[test]
fn a_refusal_points_at_the_word_it_refuses() {
    let e = check_query("SELECT 1 FROM people WHERE x IN (DELETE)").unwrap_err();
    assert_eq!(e.at, Some(33));
    assert!(check_query("SELECT (1")
        .unwrap_err()
        .message
        .contains("missing"));
    assert!(check_query("SELECT 1)")
        .unwrap_err()
        .message
        .contains("closes nothing"));
    assert!(check_query("SELECT EXTRACT(year FROM d) FROM people").is_ok());
    assert!(check_query("SELECT a IS DISTINCT FROM b FROM people").is_ok());
}
