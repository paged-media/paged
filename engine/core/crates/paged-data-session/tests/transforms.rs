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

//! Transforms (data ADR 562): JavaScript over the store's tables, run in the
//! sandboxed interpreter, giving derived tables queries and bindings read.

#![allow(non_snake_case)] // the `__feat__<id>` suffix links each test to its cockpit feature

use data_session::core::{DataSession, DocumentPayload, TransformDef};
use data_store::Format;
use serde_json::json;

fn session() -> DataSession {
    let mut s = DataSession::new(0);
    s.store_import(
        "products",
        Format::Csv,
        b"sku,name,price\nA-1,Ada,9.50\nB-2,Grace,12.00\n",
        None,
    )
    .unwrap();
    s.store_import("stock", Format::Csv, b"sku,qty\nA-1,3\nB-2,0\n", None)
        .unwrap();
    s
}

fn transform(id: &str, inputs: &[&str], source: &str, params: serde_json::Value) -> TransformDef {
    TransformDef {
        id: id.into(),
        inputs: inputs.iter().map(|s| s.to_string()).collect(),
        source: source.into(),
        params: params.as_object().cloned().unwrap_or_default(),
    }
}

#[test]
fn a_transform_joins_two_tables_into_a_derived_table__feat__data_transforms() {
    let mut s = session();
    s.define_transform(transform(
        "catalogue",
        &["products", "stock"],
        "(t, p) => t.products.map((r) => ({ sku: r.sku, label: r.name.toUpperCase(), \
         gross: Math.round(r.price * (1 + p.vat) * 100) / 100, \
         inStock: t.stock.find((s) => s.sku === r.sku).qty > 0 }))",
        json!({ "vat": 0.2 }),
    ));
    let runs = s.run_transforms();
    assert_eq!(runs[0].outcome, Ok(2), "{runs:?}");
    let p = s
        .store_preview("SELECT * FROM catalogue ORDER BY sku", 10)
        .unwrap();
    assert_eq!(
        p.columns
            .iter()
            .map(|c| c.name.as_str())
            .collect::<Vec<_>>(),
        ["sku", "label", "gross", "inStock"],
        "the transform's key order is the table's column order"
    );
    assert_eq!(
        p.rows,
        vec![
            vec![
                Some("A-1".into()),
                Some("ADA".into()),
                Some("11.4".into()),
                Some("true".into())
            ],
            vec![
                Some("B-2".into()),
                Some("GRACE".into()),
                Some("14.4".into()),
                Some("false".into())
            ],
        ]
    );
    // A later transform reads an earlier one; queries read both.
    s.define_transform(transform(
        "inStock",
        &["catalogue"],
        "(t) => t.catalogue.filter((r) => r.inStock)",
        json!({}),
    ));
    assert_eq!(s.run_transforms()[1].outcome, Ok(1));
    assert_eq!(
        s.store_preview("SELECT sku FROM inStock", 10).unwrap().rows,
        vec![vec![Some("A-1".into())]]
    );
}

#[test]
fn transforms_round_trip_with_the_recipe__feat__data_transforms() {
    let mut s = session();
    s.define_transform(transform(
        "t",
        &["products"],
        "(t) => t.products",
        json!({ "x": 1 }),
    ));
    let payload = s.payload();
    let text = serde_json::to_string(&payload).unwrap();
    assert!(text.contains("\"transforms\""));
    let back: DocumentPayload = serde_json::from_str(&text).unwrap();
    assert_eq!(
        DataSession::from_payload(back, 0).transforms(),
        s.transforms()
    );
    // A recipe without transforms writes no key (the additive rule).
    assert!(!serde_json::to_string(&DataSession::new(0).payload())
        .unwrap()
        .contains("transforms"));
    assert!(s.remove_transform("t"));
    assert!(s.transforms().is_empty());
}

#[test]
fn a_failing_transform_is_reported_and_reaches_nothing__feat__data_transforms() {
    let mut s = session();
    s.define_transform(transform(
        "net",
        &["products"],
        "() => fetch('https://x.example')",
        json!({}),
    ));
    s.define_transform(transform("after", &["net"], "(t) => t.net", json!({})));
    s.define_transform(transform("odd", &["products"], "() => 42", json!({})));
    s.define_transform(transform("missing", &["nope"], "(t) => []", json!({})));
    let runs = s.run_transforms();
    let msg = |i: usize| runs[i].outcome.clone().unwrap_err();
    assert!(msg(0).contains("ReferenceError"), "{}", msg(0));
    assert!(msg(1).contains("input net"), "{}", msg(1));
    assert!(msg(2).contains("array of rows"), "{}", msg(2));
    assert!(msg(3).contains("input nope"), "{}", msg(3));
}

#[test]
fn a_passed_through_row_keeps_its_table_column_order__feat__data_transforms() {
    let mut s = session();
    s.define_transform(transform(
        "cheap",
        &["products"],
        "(t, p) => t.products.filter((r) => r.price < p.below)",
        json!({ "below": 10 }),
    ));
    assert_eq!(s.run_transforms()[0].outcome, Ok(1));
    let p = s.store_preview("SELECT * FROM cheap", 10).unwrap();
    assert_eq!(
        p.columns
            .iter()
            .map(|c| c.name.as_str())
            .collect::<Vec<_>>(),
        ["sku", "name", "price"],
        "a filter keeps the source's column order"
    );
}
