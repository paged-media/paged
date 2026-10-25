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

//! `paged.actions.*` (core ADR 1015): the action registry from a script.
//!
//! - `paged.actions.register({ id, title?, input, output, params?, run })`
//!   keeps `run`'s SOURCE as a [`JsAction`]: it runs later in the bare
//!   sandbox (no `paged`, no host functions, a budget, a fixed clock), not in
//!   the script that registered it, so a registered action is pure whoever
//!   runs it.
//! - `paged.actions.list(input?)`, `paged.actions.run(id, input, params?)`
//!   and `paged.actions.runChain(steps, input)` answer `{ output, key,
//!   cached }`: the key is the one the SDK's `actions@1` computes.
//!
//! The registry lives as long as the engine (the editor's worker, a CLI
//! run): a later script runs what an earlier one registered.

use std::cell::RefCell;
use std::sync::Arc;

use boa_engine::object::ObjectInitializer;
use boa_engine::{
    js_string, Context, JsArgs, JsNativeError, JsObject, JsResult, JsValue, NativeFunction,
};
use paged_action::js::{JsAction, JsBudget};
use paged_action::{ActionKind, ActionValue, Registry, Step};
use serde_json::{Map, Value};

thread_local! {
    static ACTIONS: RefCell<Registry> = RefCell::new(Registry::new());
}

fn type_error(message: impl Into<String>) -> boa_engine::JsError {
    JsNativeError::typ().with_message(message.into()).into()
}

fn json(value: &JsValue, ctx: &mut Context) -> JsResult<Value> {
    Ok(value.to_json(ctx)?.unwrap_or(Value::Null))
}

fn kind(v: Option<&Value>, what: &str) -> JsResult<ActionKind> {
    serde_json::from_value(v.cloned().unwrap_or(Value::Null))
        .map_err(|_| type_error(format!("{what} is one of asset, table, selection, value")))
}

/// A script's value as the first action takes it.
fn input_of(kind: ActionKind, v: Value) -> JsResult<ActionValue> {
    Ok(match kind {
        ActionKind::Value => ActionValue::Value(v),
        ActionKind::Table => ActionValue::Table(v),
        ActionKind::Selection => ActionValue::Selection(
            serde_json::from_value(v)
                .map_err(|_| type_error("a selection is an array of addresses"))?,
        ),
        ActionKind::Asset => {
            let bytes: Vec<u8> =
                serde_json::from_value(v.get("bytes").cloned().unwrap_or(Value::Null))
                    .map_err(|_| type_error("an asset is { bytes: number[], mediaType }"))?;
            let media_type = v
                .get("mediaType")
                .and_then(Value::as_str)
                .ok_or_else(|| type_error("an asset is { bytes: number[], mediaType }"))?
                .to_string();
            ActionValue::Asset { bytes, media_type }
        }
    })
}

fn output_json(v: &ActionValue) -> Value {
    match v {
        ActionValue::Asset { bytes, media_type } => {
            serde_json::json!({ "bytes": bytes, "mediaType": media_type })
        }
        ActionValue::Table(t) | ActionValue::Value(t) => t.clone(),
        ActionValue::Selection(s) => Value::from(s.clone()),
    }
}

fn register(_this: &JsValue, args: &[JsValue], ctx: &mut Context) -> JsResult<JsValue> {
    let def = args.get_or_undefined(0);
    let obj = def
        .as_object()
        .ok_or_else(|| type_error("paged.actions.register takes { id, input, output, run }"))?;
    let run = obj.get(js_string!("run"), ctx)?;
    if !run.is_callable() {
        return Err(type_error("an action's run is a function"));
    }
    let source = run.to_string(ctx)?.to_std_string_escaped();
    let meta = json(def, ctx)?;
    let id = meta
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| type_error("an action has an id"))?
        .to_string();
    let action = JsAction {
        title: meta
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or(&id)
            .to_string(),
        input: kind(meta.get("input"), "input")?,
        output: kind(meta.get("output"), "output")?,
        params: meta
            .get("params")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default(),
        source,
        budget: JsBudget::default(),
        id,
    };
    ACTIONS
        .with(|r| r.borrow_mut().register(Arc::new(action)))
        .map_err(|e| type_error(e.to_string()))?;
    Ok(JsValue::undefined())
}

fn list(_this: &JsValue, args: &[JsValue], ctx: &mut Context) -> JsResult<JsValue> {
    let filter = match args.get_or_undefined(0) {
        v if v.is_undefined() => None,
        v => Some(kind(Some(&json(v, ctx)?), "input")?),
    };
    let rows = ACTIONS.with(|r| r.borrow().list(filter));
    JsValue::from_json(&serde_json::to_value(rows).unwrap_or(Value::Null), ctx)
}

fn run_steps(steps: Vec<Step>, input: Value, ctx: &mut Context) -> JsResult<JsValue> {
    let first = steps
        .first()
        .ok_or_else(|| type_error("the chain is empty"))?;
    let takes = ACTIONS
        .with(|r| {
            r.borrow()
                .list(None)
                .into_iter()
                .find(|a| a.id == first.action)
                .map(|a| a.input)
        })
        .ok_or_else(|| type_error(format!("no action {}", first.action)))?;
    let input = input_of(takes, input)?;
    let result = ACTIONS
        .with(|r| r.borrow_mut().run_chain(&steps, input))
        .map_err(|e| type_error(e.to_string()))?;
    JsValue::from_json(
        &serde_json::json!({
            "output": output_json(&result.output),
            "key": result.key,
            "cached": result.cached,
        }),
        ctx,
    )
}

fn run(_this: &JsValue, args: &[JsValue], ctx: &mut Context) -> JsResult<JsValue> {
    let action = args
        .get_or_undefined(0)
        .to_string(ctx)?
        .to_std_string_escaped();
    let input = json(args.get_or_undefined(1), ctx)?;
    let params: Map<String, Value> = match json(args.get_or_undefined(2), ctx)? {
        Value::Object(m) => m,
        _ => Map::new(),
    };
    run_steps(vec![Step { action, params }], input, ctx)
}

fn run_chain(_this: &JsValue, args: &[JsValue], ctx: &mut Context) -> JsResult<JsValue> {
    let steps: Vec<Step> = serde_json::from_value(json(args.get_or_undefined(0), ctx)?)
        .map_err(|_| type_error("a chain is [{ action, params? }, …]"))?;
    let input = json(args.get_or_undefined(1), ctx)?;
    run_steps(steps, input, ctx)
}

/// A host function of the bridge.
type HostFn = fn(&JsValue, &[JsValue], &mut Context) -> JsResult<JsValue>;

/// The `paged.actions` object; `guard` is the bridge's deadline wrapper.
pub(crate) fn object(ctx: &mut Context, guard: fn(HostFn) -> NativeFunction) -> JsObject {
    ObjectInitializer::new(ctx)
        .function(guard(register), js_string!("register"), 1)
        .function(guard(list), js_string!("list"), 1)
        .function(guard(run), js_string!("run"), 3)
        .function(guard(run_chain), js_string!("runChain"), 2)
        .build()
}

/// Forget every registered action (a test starts clean).
#[doc(hidden)]
pub fn clear_actions() {
    ACTIONS.with(|r| *r.borrow_mut() = Registry::new());
}
