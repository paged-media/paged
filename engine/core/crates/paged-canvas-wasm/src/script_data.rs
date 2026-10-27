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

//! `paged.data.*` for the editor's scripts: a [`ScriptData`] whose calls go
//! to the embedder through one synchronous function (core ADR 1014,
//! amendment 2).
//!
//! The editor runs scripts in its canvas worker, while the data lives on
//! the main thread behind an async service. The worker hands this crate a
//! JS function, `bridge(method, argsJson) -> answerJson`, which posts the
//! call to the main thread and blocks on `Atomics.wait` until the answer is
//! written into shared memory. From Rust's side the call is synchronous, as
//! `ScriptData` needs. This module is the target-agnostic half: how a call
//! becomes `(method, argsJson)` and how the answer comes back, so it is
//! tested natively with a closure in the function's place; the wasm shell
//! (`lib.rs`) only wraps the `js_sys::Function`. The door is a plain wasm
//! export, not a message of the channel: no protocol change.
//!
//! The call, positional like the data service's own signatures:
//!
//! | method     | args JSON                     |
//! |------------|-------------------------------|
//! | `tables`   | `[]`                          |
//! | `records`  | `[table, { offset, limit? }]` |
//! | `query`    | `[sql]`                       |
//! | `evaluate` | `[query, expr, record]`       |
//!
//! The answer is an envelope, `{ "ok": value }` or `{ "error": "message" }`:
//! a bare value would be ambiguous, since `evaluate` answers an object with
//! an `error` field of its own. The bridge itself may fail (no answer in
//! time, the worker could not reach the main thread); it then returns
//! `Err(message)`, which the script sees like any refusal.

use paged_script::ScriptData;
use serde_json::{json, Value};

/// One call across the bridge: `(method, args JSON)` to the answer JSON, or
/// the reason no answer came.
pub type BridgeCall = dyn FnMut(&str, &str) -> Result<String, String>;

/// A [`ScriptData`] over a bridge function.
pub struct BridgeData {
    call: Box<BridgeCall>,
}

impl BridgeData {
    pub fn new(call: impl FnMut(&str, &str) -> Result<String, String> + 'static) -> Self {
        Self {
            call: Box::new(call),
        }
    }

    fn ask(&mut self, method: &str, args: Value) -> Result<Value, String> {
        let answer = (self.call)(method, &args.to_string())?;
        unwrap_answer(method, &answer)
    }
}

/// The content of an `{ ok }` / `{ error }` envelope.
pub fn unwrap_answer(method: &str, answer: &str) -> Result<Value, String> {
    let malformed =
        || format!("the editor's answer to {method} is not an {{ ok }} / {{ error }} envelope");
    let parsed: Value = serde_json::from_str(answer)
        .map_err(|e| format!("the editor's answer to {method} is not JSON ({e})"))?;
    let Value::Object(mut envelope) = parsed else {
        return Err(malformed());
    };
    if let Some(error) = envelope.remove("error") {
        return Err(match error {
            Value::String(s) => s,
            other => other.to_string(),
        });
    }
    envelope.remove("ok").ok_or_else(malformed)
}

impl ScriptData for BridgeData {
    fn tables(&mut self) -> Result<Value, String> {
        self.ask("tables", json!([]))
    }

    fn records(
        &mut self,
        table: &str,
        offset: usize,
        limit: Option<usize>,
    ) -> Result<Value, String> {
        let mut range = json!({ "offset": offset });
        if let Some(limit) = limit {
            range["limit"] = json!(limit);
        }
        self.ask("records", json!([table, range]))
    }

    fn query(&mut self, sql: &str) -> Result<Value, String> {
        self.ask("query", json!([sql]))
    }

    fn evaluate(&mut self, query: &str, expr: &str, record: usize) -> Result<Value, String> {
        self.ask("evaluate", json!([query, expr, record]))
    }
}
