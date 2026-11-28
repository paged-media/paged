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

/// The store ends a comment at the first `*/` and reads `` `…` `` as a
/// quoted name. A guard that nests comments, or reads a backtick as
/// punctuation, sees less code than the store runs: the write hides behind
/// what only the guard takes for a comment or a string.
#[test]
fn a_statement_hidden_behind_a_nested_comment_or_a_backtick_name_is_refused() {
    let hostile = [
        // A nesting lexer reads everything up to the last `*/` as comment.
        "SELECT 1 /* /* */ ; DROP TABLE people -- */",
        "SELECT 1 /* /* */ ; DELETE FROM people /* */ */",
        "SELECT * FROM people /* /* */ , read_csv('/etc/passwd') /* */ */",
        "SELECT 1 /* a /* b */ UNION SELECT * FROM pragma_table_info('people') -- */",
        "/* /* */ PRAGMA query_only = 0 -- */ SELECT 1",
        // The quote inside the backtick name is the name's; a lexer that
        // takes it for a string's start swallows the statements after it.
        "SELECT `'`; DELETE FROM people --'",
        "SELECT `'`; DROP TABLE people; SELECT '`'",
        "SELECT `'` FROM read_csv('/etc/passwd') --'",
        "SELECT `/*` FROM people; UPDATE people SET name = 'x' -- */",
        "SELECT `--` FROM people; DELETE FROM people",
        "SELECT `a``'` ; ATTACH 'x.db' AS x --'",
        // A backtick name in a table position is checked as a name.
        "SELECT * FROM `https://example.com/x.csv`",
        "SELECT * FROM `read_csv`('x.csv')",
        // Not terminated: nothing after it can be told from the name.
        "SELECT `people",
    ];
    for sql in hostile {
        assert!(check_query(sql).is_err(), "admitted {sql:?}");
    }
    let e = check_query("SELECT 1 /* /* */ ; DROP TABLE people -- */").unwrap_err();
    assert!(e.message.contains("a comment inside a comment"), "{e}");
    assert_eq!(e.at, Some(12));
    let e = check_query("SELECT `'`; DELETE FROM people --'").unwrap_err();
    assert!(e.message.contains("exactly one SELECT"), "{e}");
    // What stays a query: one comment, a backtick name, a backtick table.
    for sql in [
        "SELECT 1 /* one * / comment */ FROM people",
        "SELECT `name` FROM people",
        "SELECT `na``me'` FROM `people`",
        "SELECT name FROM main.`people`",
    ] {
        assert!(check_query(sql).is_ok(), "refused {sql:?}");
    }
}

/// Only what the store skips is space. Another space character is part of
/// a name there, so it must not split a word here.
#[test]
fn only_the_stores_space_characters_separate_tokens() {
    // U+00A0 joins the two words into one name: no DELETE word to refuse,
    // and none for the store to run either.
    assert!(check_query("SELECT 1\u{a0}DELETE").is_ok());
    assert!(check_query("SELECT 1 \t\n\u{c}\r FROM people").is_ok());
}
