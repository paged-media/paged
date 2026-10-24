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

//! Actions written in JavaScript (feature `js`).
//!
//! The source is a function expression, `(input, params) => output`, run in
//! a fresh, bare Boa context: the ECMAScript built-ins and nothing else (no
//! `paged`, no `fetch`, no filesystem), with a loop and a recursion budget.
//! So a document can carry one (a data transform, data ADR 562) and be
//! opened without trusting it with anything but computing.
//!
//! Values cross as JSON: an asset as `{ bytes: number[], mediaType }`, a
//! table in the provider shape, a selection as an array of addresses.

use std::rc::Rc;

use boa_engine::context::time::{Clock, JsInstant};
use boa_engine::{Context, JsValue, Source};
use serde_json::{Map, Value};

use crate::{Action, ActionKind, ActionValue};

/// The budget of one run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct JsBudget {
    pub loop_iterations: u64,
    pub recursion_depth: usize,
}

impl Default for JsBudget {
    fn default() -> Self {
        JsBudget {
            loop_iterations: 10_000_000,
            recursion_depth: 512,
        }
    }
}

/// An action whose `run` is JavaScript.
#[derive(Debug, Clone)]
pub struct JsAction {
    pub id: String,
    pub title: String,
    pub input: ActionKind,
    pub output: ActionKind,
    pub params: Map<String, Value>,
    /// `(input, params) => output`.
    pub source: String,
    pub budget: JsBudget,
}

fn to_json(v: &ActionValue) -> Value {
    match v {
        ActionValue::Asset { bytes, media_type } => {
            serde_json::json!({ "bytes": bytes, "mediaType": media_type })
        }
        ActionValue::Table(t) | ActionValue::Value(t) => t.clone(),
        ActionValue::Selection(s) => Value::from(s.clone()),
    }
}

fn from_json(kind: ActionKind, v: Value) -> Result<ActionValue, String> {
    Ok(match kind {
        ActionKind::Value => ActionValue::Value(v),
        ActionKind::Table => {
            if !v.get("columns").is_some_and(Value::is_array)
                || !v.get("schema").is_some_and(Value::is_object)
            {
                return Err("a table is { schema: { fields }, columns, rowCount }".into());
            }
            ActionValue::Table(v)
        }
        ActionKind::Selection => ActionValue::Selection(
            v.as_array()
                .ok_or("a selection is an array of addresses")?
                .iter()
                .map(|a| {
                    a.as_str()
                        .map(str::to_string)
                        .ok_or("a selection is an array of addresses")
                })
                .collect::<Result<_, _>>()?,
        ),
        ActionKind::Asset => {
            let bytes = v
                .get("bytes")
                .and_then(Value::as_array)
                .ok_or("an asset is { bytes, mediaType }")?
                .iter()
                .map(|b| {
                    b.as_u64()
                        .filter(|b| *b < 256)
                        .map(|b| b as u8)
                        .ok_or("asset bytes are 0–255")
                })
                .collect::<Result<Vec<u8>, _>>()?;
            let media_type = v
                .get("mediaType")
                .and_then(Value::as_str)
                .ok_or("an asset is { bytes, mediaType }")?
                .to_string();
            ActionValue::Asset { bytes, media_type }
        }
    })
}

/// The epoch, always (see [`call`]).
struct FixedClock;

impl Clock for FixedClock {
    fn now(&self) -> JsInstant {
        JsInstant::new(0, 0)
    }
    fn system_time_millis(&self) -> i64 {
        0
    }
}

/// A JS error's first line (Boa appends the call stack).
fn message(e: impl std::fmt::Display) -> String {
    e.to_string().lines().next().unwrap_or_default().to_string()
}

/// A bare context: the built-ins, the budget, a fixed clock. The clock is
/// fixed because an action is pure and cached by its input, so the time must
/// not reach its result (`Date.now()` is the epoch); Boa's default clock also
/// panics on wasm32-unknown-unknown.
fn context(budget: JsBudget) -> Result<Context, String> {
    let mut ctx = Context::builder()
        .clock(Rc::new(FixedClock))
        .build()
        .map_err(message)?;
    ctx.runtime_limits_mut()
        .set_loop_iteration_limit(budget.loop_iterations);
    ctx.runtime_limits_mut()
        .set_recursion_limit(budget.recursion_depth);
    Ok(ctx)
}

/// Evaluate a script in a bare context and give its completion value as
/// JSON (`None` for `undefined`): a build script that computes and returns a
/// spec (paged.data's automation, data spec §10).
pub fn eval(source: &str, budget: JsBudget) -> Result<Option<Value>, String> {
    let mut ctx = context(budget)?;
    let out = ctx.eval(Source::from_bytes(source)).map_err(message)?;
    out.to_json(&mut ctx).map_err(message)
}

/// Evaluate `source` (a function expression) on `args` in a bare context.
pub fn call(source: &str, args: &[Value], budget: JsBudget) -> Result<Value, String> {
    let mut ctx = context(budget)?;
    let f = ctx
        .eval(Source::from_bytes(&format!("({source}\n)")))
        .map_err(message)?;
    let f = f.as_callable().ok_or("the source is not a function")?;
    let args = args
        .iter()
        .map(|a| JsValue::from_json(a, &mut ctx))
        .collect::<Result<Vec<_>, _>>()
        .map_err(message)?;
    let out = f
        .call(&JsValue::undefined(), &args, &mut ctx)
        .map_err(message)?;
    Ok(out
        .to_json(&mut ctx)
        .map_err(message)?
        .unwrap_or(Value::Null))
}

impl Action for JsAction {
    fn id(&self) -> &str {
        &self.id
    }
    fn title(&self) -> &str {
        &self.title
    }
    fn input(&self) -> ActionKind {
        self.input
    }
    fn output(&self) -> ActionKind {
        self.output
    }
    fn params(&self) -> Map<String, Value> {
        self.params.clone()
    }
    fn run(&self, input: &ActionValue, params: &Map<String, Value>) -> Result<ActionValue, String> {
        let out = call(
            &self.source,
            &[to_json(input), Value::Object(params.clone())],
            self.budget,
        )?;
        from_json(self.output, out)
    }
}
