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

//! The bind popover's preview (editor ADR 292): an expression's value at a
//! record, defining nothing.

#![allow(non_snake_case)] // the `__feat__<id>` suffix links each test to its cockpit feature

use data_core::{Query, QueryId, ResultShape};
use data_session::core::DataSession;
use data_store::Format;

#[test]
fn an_expression_is_previewed_at_a_record__feat__editor_shell_bind_popover() {
    let mut s = DataSession::new(0);
    s.store_import(
        "p",
        Format::Csv,
        b"sku,price,cat\nA-1,9.5,Sale\nB-2,12,New\n",
        None,
    )
    .unwrap();
    s.define_query(Query {
        id: QueryId::from("q"),
        sql: "SELECT * FROM p ORDER BY sku".into(),
        params: vec![],
        shape: ResultShape::RecordStream,
    });
    s.store_ingest(QueryId::from("q"), "SELECT * FROM p ORDER BY sku")
        .unwrap();
    let q = QueryId::from("q");
    let at = |expr: &str, r: usize| s.evaluate_at(&q, expr, r);
    assert_eq!(at("price * 2", 1).value, serde_json::json!(24.0));
    assert_eq!(at("UPPER(sku)", 0).display, "A-1");
    assert_eq!(
        at(r#"IF(cat = "Sale", 14, 10)"#, 0).value,
        serde_json::json!(14.0)
    );
    assert_eq!(
        at(r#"IF(cat = "Sale", 14, 10)"#, 1).value,
        serde_json::json!(10.0)
    );
    assert!(at("price +", 0).error.is_some());
    assert!(at("nope", 0).error.is_some(), "an unknown field says so");
    assert_eq!(
        at("price", 9).value,
        serde_json::Value::Null,
        "past the last record"
    );
    // Nothing was defined.
    assert!(s.payload().bindings.is_empty());
}
