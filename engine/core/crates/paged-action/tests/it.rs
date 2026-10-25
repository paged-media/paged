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

//! Actions (core ADR 1015): the cache key the SDK computes, the registry's
//! chains and cache, and JavaScript actions in their sandbox.

#![allow(non_snake_case)] // the `__feat__<id>` suffix links each test to its cockpit feature

use std::sync::Arc;

use paged_action::js::{call, JsAction, JsBudget};
use paged_action::{key, Action, ActionError, ActionKind, ActionValue, Registry, Step};
use serde::Deserialize;
use serde_json::{json, Map, Value};

#[derive(Deserialize)]
struct Input {
    kind: String,
    value: Option<Value>,
    bytes: Option<Vec<u8>>,
    #[serde(rename = "mediaType")]
    media_type: Option<String>,
}

#[derive(Deserialize)]
struct Case {
    name: String,
    input: Input,
    steps: Vec<Step>,
    key: String,
}

#[test]
fn the_key_is_the_sdks__feat__plugin_platform_actions_door() {
    let text = include_str!("keys.json");
    let cases: Vec<Case> =
        serde_json::from_value(serde_json::from_str::<Value>(text).unwrap()["cases"].clone())
            .unwrap();
    assert_eq!(cases.len(), 4);
    for c in cases {
        let input = match c.input.kind.as_str() {
            "asset" => ActionValue::Asset {
                bytes: c.input.bytes.unwrap(),
                media_type: c.input.media_type.unwrap(),
            },
            "table" => ActionValue::Table(c.input.value.unwrap()),
            "selection" => {
                ActionValue::Selection(serde_json::from_value(c.input.value.unwrap()).unwrap())
            }
            _ => ActionValue::Value(c.input.value.unwrap()),
        };
        let steps: Vec<(String, Map<String, Value>)> =
            c.steps.into_iter().map(|s| (s.action, s.params)).collect();
        assert_eq!(key(&input, &steps), c.key, "{}", c.name);
    }
}

fn js(
    id: &str,
    input: ActionKind,
    output: ActionKind,
    params: Value,
    source: &str,
) -> Arc<dyn Action> {
    Arc::new(JsAction {
        id: id.into(),
        title: id.into(),
        input,
        output,
        params: params.as_object().cloned().unwrap_or_default(),
        source: source.into(),
        budget: JsBudget::default(),
    })
}

#[test]
fn a_chain_runs_once_and_answers_from_the_cache__feat__plugin_platform_actions_door() {
    let mut r = Registry::new();
    r.register(js(
        "t/scale",
        ActionKind::Value,
        ActionKind::Value,
        json!({ "by": 2 }),
        "(v, p) => v.map((x) => x * p.by)",
    ))
    .unwrap();
    r.register(js(
        "t/sum",
        ActionKind::Value,
        ActionKind::Value,
        json!({}),
        "(v) => v.reduce((a, b) => a + b, 0)",
    ))
    .unwrap();
    assert_eq!(
        r.register(js(
            "t/sum",
            ActionKind::Value,
            ActionKind::Value,
            json!({}),
            "(v) => v"
        )),
        Err(ActionError::Taken("t/sum".into()))
    );
    let steps = [
        Step {
            action: "t/scale".into(),
            params: Map::new(),
        },
        Step {
            action: "t/sum".into(),
            params: Map::new(),
        },
    ];
    let first = r
        .run_chain(&steps, ActionValue::Value(json!([1, 2, 3])))
        .unwrap();
    assert_eq!(first.output, ActionValue::Value(json!(12)));
    assert!(!first.cached);
    let again = r
        .run_chain(&steps, ActionValue::Value(json!([1, 2, 3])))
        .unwrap();
    assert!(again.cached);
    assert_eq!(again.key, first.key);
    let tripled = r
        .run(
            "t/scale",
            ActionValue::Value(json!([1])),
            json!({ "by": 3 }).as_object().unwrap().clone(),
        )
        .unwrap();
    assert_eq!(tripled.output, ActionValue::Value(json!([3])));
    assert_eq!(r.cached(), 2);
    assert_eq!(r.list(Some(ActionKind::Value)).len(), 2);
}

#[test]
fn kinds_that_do_not_meet_are_refused_before_anything_runs__feat__plugin_platform_actions_door() {
    let mut r = Registry::new();
    r.register(js(
        "t/len",
        ActionKind::Asset,
        ActionKind::Value,
        json!({}),
        "(a) => a.bytes.length",
    ))
    .unwrap();
    r.register(js(
        "t/invert",
        ActionKind::Asset,
        ActionKind::Asset,
        json!({}),
        "(a) => ({ bytes: a.bytes.map((b) => 255 - b), mediaType: a.mediaType })",
    ))
    .unwrap();
    let asset = ActionValue::Asset {
        bytes: vec![0, 10, 255],
        media_type: "image/x-gray".into(),
    };
    let inverted = r.run("t/invert", asset.clone(), Map::new()).unwrap().output;
    assert_eq!(
        inverted,
        ActionValue::Asset {
            bytes: vec![255, 245, 0],
            media_type: "image/x-gray".into()
        }
    );
    let bad = [
        Step {
            action: "t/len".into(),
            params: Map::new(),
        },
        Step {
            action: "t/invert".into(),
            params: Map::new(),
        },
    ];
    assert_eq!(
        r.run_chain(&bad, asset).unwrap_err().to_string(),
        "t/len gives value, t/invert takes asset"
    );
    assert!(matches!(
        r.run("t/len", ActionValue::Value(json!(1)), Map::new()),
        Err(ActionError::Input { .. })
    ));
    assert!(matches!(
        r.run("nope", ActionValue::Value(json!(1)), Map::new()),
        Err(ActionError::Unknown(_))
    ));
}

#[test]
fn a_js_action_reaches_nothing_and_runs_within_its_budget__feat__plugin_platform_actions_door() {
    for host in [
        "fetch('x')",
        "require('fs')",
        "paged.pages()",
        "process.exit(1)",
    ] {
        let e = call(&format!("() => {host}"), &[], JsBudget::default()).unwrap_err();
        assert!(
            e.contains("ReferenceError") || e.contains("not defined"),
            "{host}: {e}"
        );
    }
    let e = call(
        "() => { for (;;) {} }",
        &[],
        JsBudget {
            loop_iterations: 1000,
            recursion_depth: 64,
        },
    )
    .unwrap_err();
    assert!(e.to_lowercase().contains("loop"), "{e}");
    let e = call(
        "function f() { return f(); }",
        &[],
        JsBudget {
            loop_iterations: 1000,
            recursion_depth: 64,
        },
    )
    .unwrap_err();
    assert!(e.contains("recursive calls"), "{e}");
    assert!(!e.contains('\n'), "one line: {e}");
    assert_eq!(
        call(
            "(a, b) => a + b",
            &[json!(2), json!(3)],
            JsBudget::default()
        )
        .unwrap(),
        json!(5)
    );
    // Pure: the time does not reach a result.
    assert_eq!(
        call("() => Date.now()", &[], JsBudget::default()).unwrap(),
        json!(0)
    );
    assert!(call("42", &[], JsBudget::default())
        .unwrap_err()
        .contains("not a function"));
}
