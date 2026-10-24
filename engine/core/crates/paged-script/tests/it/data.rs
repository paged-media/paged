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

//! `paged.data.*` (PM-0015): a script reads the data its embedder attached
//! to the run; with none attached every call throws, and a door attached to
//! one run is gone in the next.

#![allow(non_snake_case)] // the `__feat__<id>` suffix links each test to its cockpit feature

use paged_canvas::{CanvasModel, CanvasOptions};
use paged_script::{execute_script, with_data, ScriptData};
use serde_json::{json, Value};

/// One table, `people(name, age)`, and a log of what the script asked.
#[derive(Default)]
struct People {
    asked: Vec<String>,
}

fn record_set(rows: &[(&str, f64)]) -> Value {
    json!({
        "schema": { "fields": [{ "name": "name", "ty": "text" }, { "name": "age", "ty": "number" }] },
        "columns": [
            rows.iter().map(|r| r.0).collect::<Vec<_>>(),
            rows.iter().map(|r| r.1).collect::<Vec<_>>(),
        ],
        "rowCount": rows.len(),
    })
}

const ROWS: &[(&str, f64)] = &[("Ada", 36.0), ("Grace", 85.0), ("Linus", 54.0)];

impl ScriptData for People {
    fn tables(&mut self) -> Result<Value, String> {
        self.asked.push("tables".into());
        Ok(json!({ "sources": ["people"], "queries": [], "tables": ["people"] }))
    }
    fn records(
        &mut self,
        table: &str,
        offset: usize,
        limit: Option<usize>,
    ) -> Result<Value, String> {
        self.asked
            .push(format!("records {table} {offset} {limit:?}"));
        if table != "people" {
            return Err(format!("no table {table}"));
        }
        let end = limit.map_or(ROWS.len(), |l| (offset + l).min(ROWS.len()));
        Ok(record_set(&ROWS[offset.min(end)..end]))
    }
    fn query(&mut self, sql: &str) -> Result<Value, String> {
        self.asked.push(format!("query {sql}"));
        if sql.contains("read_csv") {
            return Err("read_csv() reads files or URLs".into());
        }
        Ok(record_set(&ROWS[..1]))
    }
    fn evaluate(&mut self, query: &str, expr: &str, record: usize) -> Result<Value, String> {
        self.asked.push(format!("evaluate {query} {expr} {record}"));
        Ok(json!({ "display": ROWS[record].0, "value": ROWS[record].0 }))
    }
}

fn blank() -> CanvasModel {
    CanvasModel::new_blank("data", 612.0, 792.0, CanvasOptions::default()).unwrap()
}

#[test]
fn a_script_reads_the_data_attached_to_its_run__feat__data_bind_labels_native() {
    let mut model = blank();
    let mut people = People::default();
    let r = with_data(&mut people, || {
        execute_script(
            &mut model,
            r#"
            const t = paged.data.tables();
            const all = paged.data.records("people");
            const page = paged.data.records("people", { offset: 1, limit: 1 });
            const q = paged.data.query("SELECT * FROM people LIMIT 1");
            const e = paged.data.evaluate("q", "name", 2);
            console.log(t.tables.join(","), all.rowCount, page.columns[0][0],
              q.schema.fields.map((f) => f.name).join("|"), q.columns[0][0], e.display);
            "#,
        )
    });
    assert!(r.error.is_none(), "{:?}", r.error);
    assert_eq!(r.output, ["[log] people 3 Grace name|age Ada Linus"]);
    assert_eq!(
        people.asked,
        [
            "tables",
            "records people 0 None",
            "records people 1 Some(1)",
            "query SELECT * FROM people LIMIT 1",
            "evaluate q name 2",
        ]
    );
}

#[test]
fn a_door_s_refusal_is_an_error_the_script_can_catch__feat__data_bind_labels_native() {
    let mut model = blank();
    let mut people = People::default();
    let r = with_data(&mut people, || {
        execute_script(
            &mut model,
            r#"
            try { paged.data.query("SELECT * FROM read_csv('/etc/passwd')"); }
            catch (e) { console.log(e.message); }
            try { paged.data.records("people", { limit: -1 }); }
            catch (e) { console.log(e.name); }
            "#,
        )
    });
    assert!(r.error.is_none(), "{:?}", r.error);
    assert_eq!(
        r.output,
        [
            "[log] paged.data: read_csv() reads files or URLs",
            "[log] TypeError",
        ]
    );
}

#[test]
fn without_a_door_every_call_throws_and_a_door_never_outlives_its_run__feat__data_bind_labels_native(
) {
    let mut model = blank();
    let probe = r#"
        const said = [];
        for (const call of [() => paged.data.tables(), () => paged.data.records("people"),
                            () => paged.data.query("SELECT 1"), () => paged.data.evaluate("q", "1", 0)]) {
          try { call(); said.push("answered"); }
          catch (e) { said.push(e instanceof TypeError && e.message.includes("no data is attached")); }
        }
        console.log(said.join(","));
    "#;
    let r = execute_script(&mut model, probe);
    assert_eq!(r.output, ["[log] true,true,true,true"], "{:?}", r.error);

    let mut people = People::default();
    let r = with_data(&mut people, || execute_script(&mut model, probe));
    assert_eq!(r.output, ["[log] answered,answered,answered,answered"]);

    let r = execute_script(&mut model, probe);
    assert_eq!(r.output, ["[log] true,true,true,true"], "{:?}", r.error);
}
