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

//! [scripting.data] `paged.data.*` in the worker (core ADR 1014, amendment
//! 2): the bridge adapter maps each call to `(method, argsJson)` and the
//! `{ ok }` / `{ error }` envelope back, and `WorkerCore` installs it around
//! every dispatched message, so a script run reads the embedder's data.
//! The JS function the wasm shell wraps is a closure here.

use std::cell::RefCell;
use std::rc::Rc;

use paged_canvas_wasm::dispatch::WorkerCore;
use paged_canvas_wasm::script_data::{unwrap_answer, BridgeData};
use paged_script::ScriptData;
use serde_json::{json, Value};

type Calls = Rc<RefCell<Vec<(String, Value)>>>;

/// A bridge that records each call and answers with `answer(method, args)`.
fn recording(answer: impl Fn(&str, &Value) -> String + 'static) -> (BridgeData, Calls) {
    let calls: Calls = Rc::default();
    let seen = calls.clone();
    let bridge = BridgeData::new(move |method, args| {
        let args: Value = serde_json::from_str(args).expect("args are JSON");
        let out = answer(method, &args);
        seen.borrow_mut().push((method.to_string(), args));
        Ok(out)
    });
    (bridge, calls)
}

#[test]
fn each_call_crosses_as_its_method_and_positional_args() {
    let (mut data, calls) = recording(|_, _| json!({ "ok": [] }).to_string());
    data.tables().unwrap();
    data.records("people", 2, Some(5)).unwrap();
    data.records("people", 0, None).unwrap();
    data.query("SELECT 1").unwrap();
    data.evaluate("q", "upper(name)", 3).unwrap();
    assert_eq!(
        *calls.borrow(),
        vec![
            ("tables".to_string(), json!([])),
            (
                "records".to_string(),
                json!(["people", { "offset": 2, "limit": 5 }])
            ),
            ("records".to_string(), json!(["people", { "offset": 0 }])),
            ("query".to_string(), json!(["SELECT 1"])),
            ("evaluate".to_string(), json!(["q", "upper(name)", 3])),
        ]
    );
}

#[test]
fn the_envelope_carries_a_value_an_error_or_a_refusal_of_its_shape() {
    // `evaluate`'s own `error` field is inside `ok`, not the envelope's.
    let evaluated = json!({ "display": "", "value": null, "error": "no field x" });
    assert_eq!(
        unwrap_answer("evaluate", &json!({ "ok": evaluated }).to_string()),
        Ok(evaluated)
    );
    assert_eq!(
        unwrap_answer("query", r#"{"error":"only SELECT"}"#),
        Err("only SELECT".to_string())
    );
    assert!(unwrap_answer("tables", "not json")
        .unwrap_err()
        .contains("not JSON"));
    assert!(unwrap_answer("tables", "[1]")
        .unwrap_err()
        .contains("envelope"));
    assert!(unwrap_answer("tables", "{}")
        .unwrap_err()
        .contains("envelope"));
}

#[test]
fn a_failed_bridge_is_the_calls_error() {
    let mut data = BridgeData::new(|_, _| Err("no answer within 30000 ms".to_string()));
    assert_eq!(data.tables(), Err("no answer within 30000 ms".to_string()));
}

fn blank_core() -> WorkerCore {
    let mut core = WorkerCore::new();
    let (reply, _) = core.handle_message(
        &json!({ "seq": 1, "protocol": 0, "kind": "newBlankDocument",
            "payload": { "widthPt": 612.0, "heightPt": 792.0 } })
        .to_string(),
        &|| 0.0,
    );
    assert!(reply.contains("documentLoaded"), "{reply}");
    core
}

fn run(core: &mut WorkerCore, source: &str) -> Value {
    let (reply, _) = core.handle_message(
        &json!({ "seq": 2, "protocol": 0, "kind": "executeScript",
            "payload": { "source": source } })
        .to_string(),
        &|| 0.0,
    );
    let reply: Value = serde_json::from_str(&reply).unwrap();
    assert_eq!(reply["kind"], "scriptResult", "{reply}");
    reply["payload"].clone()
}

#[test]
fn a_script_run_reads_the_installed_door_and_sees_its_refusals() {
    let mut core = blank_core();
    let (data, calls) = recording(|method, args| match method {
        "tables" => json!({ "ok": [{ "name": "people", "rowCount": 2 }] }).to_string(),
        "query" if args[0] == "DROP TABLE people" => {
            json!({ "error": "only one SELECT is allowed" }).to_string()
        }
        _ => json!({ "ok": { "rowCount": 0 } }).to_string(),
    });
    core.set_script_data(Some(Box::new(data)));

    let out = run(
        &mut core,
        "const t = paged.data.tables(); console.log(t[0].name, t[0].rowCount);",
    );
    assert_eq!(out["error"], Value::Null, "{out}");
    assert_eq!(out["output"], json!(["[log] people 2"]));

    let out = run(
        &mut core,
        "try { paged.data.query('DROP TABLE people'); } catch (e) { console.log(e.message); }",
    );
    assert_eq!(
        out["output"],
        json!(["[log] paged.data: only one SELECT is allowed"])
    );
    assert_eq!(calls.borrow().len(), 2);

    // Removed, the interpreter's own refusal is back.
    core.set_script_data(None);
    let out = run(&mut core, "paged.data.tables()");
    assert!(
        out["error"]
            .as_str()
            .unwrap_or_default()
            .contains("no data is attached"),
        "{out}"
    );
}
