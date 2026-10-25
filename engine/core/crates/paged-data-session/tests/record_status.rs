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

//! Per-record status (editor ADR 291): records new, changed, placed and
//! removed since the document was written from a query.

#![allow(non_snake_case)] // the `__feat__<id>` suffix links each test to its cockpit feature

use data_core::{BindingDef, Query, QueryId, ResultShape};
use data_session::core::DataSession;
use data_session::record_status::RecordStatusOptions;
use data_store::Format;

const CSV: &[u8] = b"sku,name,price\nA-1,Hammer,9.5\nB-2,Saw,12\nC-3,Rake,7\n";

fn session(sql: &str) -> DataSession {
    let mut s = DataSession::new(0);
    s.store_import("p", Format::Csv, CSV, None).unwrap();
    s.define_query(Query {
        id: QueryId::from("q"),
        sql: sql.into(),
        params: vec![],
        shape: ResultShape::RecordStream,
    });
    refresh(&mut s);
    s
}

fn refresh(s: &mut DataSession) {
    let runs = s.refresh_queries();
    assert!(runs.iter().all(|r| r.outcome.is_ok()), "{runs:?}");
}

fn bind(s: &mut DataSession, json: serde_json::Value) {
    s.define_binding(serde_json::from_value::<BindingDef>(json).unwrap());
}

fn edit(s: &mut DataSession, edits: serde_json::Value) {
    let edits: Vec<data_store::RowEdit> = serde_json::from_value(edits).unwrap();
    s.store_edit("p", &edits).unwrap();
    refresh(s);
}

fn q() -> QueryId {
    QueryId::from("q")
}

#[test]
fn a_query_never_written_from_is_a_baseline__feat__data_bind_record_status() {
    let mut s = session("SELECT * FROM p");
    let st = s
        .record_status(&q(), &RecordStatusOptions::default())
        .unwrap();
    assert!(st.baseline);
    assert!(st.added.is_empty() && st.changed.is_empty());
    assert_eq!(st.removed, 0);
    assert!(st.placed.is_empty(), "nothing reads the query");
    // A host instance (a merged record's frame) is taken as a current row.
    let st = s
        .record_status(
            &q(),
            &RecordStatusOptions {
                instances: vec![2, 9],
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(st.placed, [2]);
    assert_eq!(st.instances, [Some(2), None]);
    assert!(s
        .record_status(&QueryId::from("none"), &Default::default())
        .is_none());
    // A table shows every record.
    bind(
        &mut s,
        serde_json::json!({"id": "t", "kind": "table", "region": "fr",
            "query": "q", "columns": [{"header": "Name", "expr": "name"}]}),
    );
    let st = s
        .record_status(&q(), &RecordStatusOptions::default())
        .unwrap();
    assert_eq!(st.placed, [0, 1, 2]);
}

#[test]
fn added_changed_and_removed_records_are_matched_by_a_unique_column__feat__data_bind_record_status()
{
    let mut s = session("SELECT * FROM p");
    bind(
        &mut s,
        serde_json::json!({"id": "v", "kind": "variable", "target": "ph",
            "query": "q", "expr": "name"}),
    );
    s.mark_rows_applied();
    let opts = RecordStatusOptions {
        // Merged records B-2 and C-3 (rows 1 and 2 when written).
        instances: vec![1, 2],
        ..Default::default()
    };
    let st = s.record_status(&q(), &opts).unwrap();
    assert!(!st.baseline);
    assert_eq!(st.key, ["sku"], "the first column unique in both results");
    assert!(st.added.is_empty() && st.changed.is_empty());
    // The variable shows the first record; the merge records 1 and 2.
    assert_eq!(st.placed, [0, 1, 2]);
    assert_eq!(st.first, Some(0));

    // B-2's price changes, D-4 is added, A-1 (placed by the variable) is
    // deleted: the rows move up by one.
    edit(
        &mut s,
        serde_json::json!([
            {"op": "set", "row": 1, "field": "price", "value": 13},
            {"op": "insert", "values": {"sku": "D-4", "name": "Spade", "price": 20}},
            {"op": "delete", "row": 0}
        ]),
    );
    let st = s.record_status(&q(), &opts).unwrap();
    assert_eq!(st.added, [2], "D-4, now row 2");
    assert_eq!(st.changed, [0], "B-2, now row 0");
    assert_eq!(st.removed, 1, "A-1 was placed and is gone");
    assert_eq!(st.instances, [Some(0), Some(1)], "B-2 and C-3 moved up");
    assert_eq!(st.placed, [0, 1]);
    assert_eq!(st.first, None, "the record the variable showed is gone");

    // The variable filled at record 2 (C-3, row 1 now) instead of the first.
    let own = RecordStatusOptions {
        instances: vec![2],
        own_record: vec!["v".into()],
        ..Default::default()
    };
    let st = s.record_status(&q(), &own).unwrap();
    assert_eq!(st.removed, 0, "A-1 was never placed then");
    assert_eq!(st.first, None);
    assert_eq!(st.placed, [1]);

    // Writing the document again makes the current result the baseline.
    s.mark_query_applied(&q());
    let st = s.record_status(&q(), &opts).unwrap();
    assert!(st.added.is_empty() && st.changed.is_empty());
    assert_eq!(st.removed, 0);
}

#[test]
fn a_declared_key_wins_and_the_whole_row_never_reports_a_change__feat__data_bind_record_status() {
    let mut s = session("SELECT name, price FROM p");
    s.mark_rows_applied();
    edit(
        &mut s,
        serde_json::json!([{"op": "set", "row": 0, "field": "price", "value": 1}]),
    );
    // `name` is unique, so it is the default key: Hammer changed.
    let st = s.record_status(&q(), &Default::default()).unwrap();
    assert_eq!(st.key, ["name"]);
    assert_eq!(st.changed, [0]);
    // Keyed by price, Hammer at 1 is a record the snapshot did not have.
    let by_price = RecordStatusOptions {
        key: Some(vec!["price".into()]),
        instances: vec![0],
        ..Default::default()
    };
    let st = s.record_status(&q(), &by_price).unwrap();
    assert_eq!(st.key, ["price"]);
    assert_eq!(st.added, [0]);
    assert!(st.changed.is_empty());
    assert_eq!(st.removed, 1, "the placed Hammer at 9.5 is gone");
    assert_eq!(st.instances, [None]);
}

#[test]
fn without_a_unique_column_the_whole_row_is_the_key__feat__data_bind_record_status() {
    let mut s = DataSession::new(0);
    s.store_import("p", Format::Csv, b"cat,price\nA,1\nA,2\nB,2\n", None)
        .unwrap();
    s.define_query(Query {
        id: q(),
        sql: "SELECT * FROM p".into(),
        params: vec![],
        shape: ResultShape::RecordStream,
    });
    refresh(&mut s);
    s.mark_rows_applied();
    edit(
        &mut s,
        serde_json::json!([{"op": "set", "row": 2, "field": "price", "value": 3}]),
    );
    let st = s
        .record_status(
            &q(),
            &RecordStatusOptions {
                instances: vec![2],
                ..Default::default()
            },
        )
        .unwrap();
    assert!(st.key.is_empty());
    assert!(st.changed.is_empty(), "a changed row is another record");
    assert_eq!(st.added, [2]);
    assert_eq!(st.removed, 1);
}

#[test]
fn a_record_flow_names_the_row_each_instance_shows__feat__data_bind_record_status() {
    let mut s = session("SELECT * FROM p ORDER BY price DESC");
    s.template_from_text(&data_core::TemplateRef::from("card"), "<<name>>", 14.0)
        .unwrap();
    bind(
        &mut s,
        serde_json::json!({"id": "rf", "kind": "recordFlow", "chain": "c",
            "query": "q", "template": "card"}),
    );
    let id = data_core::BindingId::from("rf");
    let flow = s
        .lower_record_flow(
            &id,
            vec![data_lower::FrameCapacity {
                frame: "f0".into(),
                page: "p0".into(),
                height_pt: 1000.0,
            }],
            s.flow_layout(&id).unwrap(),
        )
        .unwrap();
    let rows: Vec<(String, Option<usize>)> = flow.frames[0]
        .blocks
        .iter()
        .filter_map(|b| match b {
            data_lower::FlowBlock::Record { cells, record, .. } => {
                Some((cells[0].clone(), *record))
            }
            _ => None,
        })
        .collect();
    assert_eq!(
        rows,
        [
            ("Saw".to_string(), Some(0)),
            ("Hammer".to_string(), Some(1)),
            ("Rake".to_string(), Some(2))
        ]
    );
    // A flow alone places nothing the host did not report.
    let st = s.record_status(&q(), &Default::default()).unwrap();
    assert!(st.placed.is_empty());
}

/// The session as a document reopens it: the payload through JSON, the
/// source imported again (the store is the data, not the recipe).
fn reopen(s: &DataSession) -> DataSession {
    let json = serde_json::to_string(&s.payload()).unwrap();
    let mut r = DataSession::from_payload(serde_json::from_str(&json).unwrap(), 0);
    r.store_import("p", Format::Csv, CSV, None).unwrap();
    refresh(&mut r);
    r
}

#[test]
fn the_payload_keeps_the_applied_snapshot_compact__feat__data_bind_record_status() {
    let mut s = session("SELECT * FROM p");
    assert!(s.payload().applied.is_empty(), "nothing written from yet");
    s.mark_rows_applied();
    let payload = s.payload();
    let snap = &payload.applied["q"];
    assert_eq!(snap.key, ["sku"]);
    assert_eq!(snap.rows.len(), 3);
    // A key hash and a content hash per record, no values.
    assert!(snap
        .rows
        .iter()
        .all(|r| r.len() == 32 && r.chars().all(|c| c.is_ascii_hexdigit())));
    let json = serde_json::to_string(&payload).unwrap();
    assert!(!json.contains("Hammer"), "{json}");
    // The round trip is exact, and a reopened session saves it again.
    let r = reopen(&s);
    assert_eq!(r.payload(), payload);
    // A payload written before the snapshot existed loads without one.
    let mut old: serde_json::Value = serde_json::to_value(&payload).unwrap();
    old.as_object_mut().unwrap().remove("applied");
    let mut o = DataSession::from_payload(serde_json::from_value(old).unwrap(), 0);
    o.store_import("p", Format::Csv, CSV, None).unwrap();
    refresh(&mut o);
    assert!(o.record_status(&q(), &Default::default()).unwrap().baseline);
}

#[test]
fn after_a_reopen_a_changed_row_reads_as_changed__feat__data_bind_record_status() {
    let mut s = session("SELECT * FROM p");
    bind(
        &mut s,
        serde_json::json!({"id": "v", "kind": "variable", "target": "ph",
            "query": "q", "expr": "name"}),
    );
    s.mark_rows_applied();
    let mut r = reopen(&s);
    let opts = RecordStatusOptions {
        instances: vec![1, 2],
        ..Default::default()
    };
    let st = r.record_status(&q(), &opts).unwrap();
    assert!(!st.baseline, "the snapshot came back with the document");
    assert!(st.added.is_empty() && st.changed.is_empty());
    assert_eq!(st.placed, [0, 1, 2]);

    edit(
        &mut r,
        serde_json::json!([
            {"op": "set", "row": 1, "field": "price", "value": 13},
            {"op": "insert", "values": {"sku": "D-4", "name": "Spade", "price": 20}},
            {"op": "delete", "row": 0}
        ]),
    );
    let st = r.record_status(&q(), &opts).unwrap();
    assert_eq!(st.key, ["sku"]);
    assert_eq!(st.added, [2]);
    assert_eq!(st.changed, [0], "B-2, its price changed");
    assert_eq!(st.removed, 1);
    assert_eq!(st.instances, [Some(0), Some(1)]);
    assert_eq!(st.first, None);

    // Another key than the saved one: the snapshot holds no values to key
    // again, so the whole row is the identity (a change is new + removed).
    let by_name = RecordStatusOptions {
        key: Some(vec!["name".into()]),
        ..Default::default()
    };
    let st = r.record_status(&q(), &by_name).unwrap();
    assert!(st.key.is_empty());
    assert!(st.changed.is_empty());
    assert_eq!(st.added, [0, 2]);

    // Writing the document again replaces the saved snapshot.
    r.mark_query_applied(&q());
    let st = r.record_status(&q(), &opts).unwrap();
    assert!(st.added.is_empty() && st.changed.is_empty() && st.removed == 0);
    assert_eq!(r.payload().applied["q"].rows.len(), 3);
}

#[test]
fn a_saved_whole_row_snapshot_matches_rows_by_content__feat__data_bind_record_status() {
    // No unique column (two rows read `true`): the whole row is the key.
    let mut s = session("SELECT price > 8 AS big FROM p");
    s.mark_rows_applied();
    let snap = &s.payload().applied["q"];
    assert!(snap.key.is_empty());
    assert!(
        snap.rows.iter().all(|r| r.len() == 16),
        "one hash per record"
    );
    let mut r = reopen(&s);
    let opts = RecordStatusOptions {
        instances: vec![2],
        ..Default::default()
    };
    let st = r.record_status(&q(), &opts).unwrap();
    assert!(!st.baseline);
    assert!(st.key.is_empty());
    assert!(st.added.is_empty() && st.changed.is_empty());
    assert_eq!(st.instances, [Some(2)]);
    // Rake at 50 is big now: its old row is gone, the new one is not new
    // (the whole row is its identity, and `true` was there).
    edit(
        &mut r,
        serde_json::json!([{"op": "set", "row": 2, "field": "price", "value": 50}]),
    );
    let st = r.record_status(&q(), &opts).unwrap();
    assert!(st.changed.is_empty());
    assert_eq!(st.removed, 1);
    assert_eq!(st.instances, [None]);
}
