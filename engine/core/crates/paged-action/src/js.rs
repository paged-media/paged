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

use std::future::Future;
use std::rc::Rc;

use boa_engine::context::time::{Clock, JsInstant};
use boa_engine::object::builtins::{JsArray, JsProxy};
use boa_engine::property::Attribute;
use boa_engine::{js_string, Context, JsNativeError, JsResult, JsValue, Script, Source};
use serde_json::{Map, Value};

use crate::{Action, ActionKind, ActionValue};

/// The budget of one run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct JsBudget {
    /// Loop iterations. Boa counts them per call frame, so on its own the
    /// limit never trips on nested loops in separate functions or on
    /// recursion; [`eval`] and [`call`] therefore also hold the whole run
    /// to the work this many iterations buy ([`WORK_PER_ITERATION`]).
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

/// How a bare context is set up: the one sandbox of the engine's JavaScript
/// (core ADR 1015, amended by ADR 1059). `paged-script` (the editor's
/// scripts) builds its context here too, with the stack limit and, off wasm,
/// the host's clock.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Sandbox {
    pub budget: JsBudget,
    /// Boa's native stack limit; `None` keeps Boa's default.
    pub stack_size: Option<usize>,
    /// The clock is the epoch, always: an action is pure and cached by its
    /// input, so the time must not reach its result (`Date.now()` is the
    /// epoch). `false` keeps Boa's own clock, for a script that runs once
    /// against a live document; Boa's default clock panics on
    /// wasm32-unknown-unknown, so a wasm host sets `true`.
    pub fixed_clock: bool,
}

impl Sandbox {
    /// What an action and a build script run in: the budget, a fixed clock.
    pub fn pure(budget: JsBudget) -> Sandbox {
        Sandbox {
            budget,
            stack_size: None,
            fixed_clock: true,
        }
    }
}

/// A bare context: the built-ins, the limits, no host functions.
pub fn sandbox_context(sandbox: Sandbox) -> Result<Context, String> {
    let builder = Context::builder();
    let builder = if sandbox.fixed_clock {
        builder.clock(Rc::new(FixedClock))
    } else {
        builder
    };
    let mut ctx = builder.build().map_err(message)?;
    let limits = ctx.runtime_limits_mut();
    limits.set_loop_iteration_limit(sandbox.budget.loop_iterations);
    limits.set_recursion_limit(sandbox.budget.recursion_depth);
    if let Some(stack) = sandbox.stack_size {
        limits.set_stack_size_limit(stack);
    }
    Ok(ctx)
}

/// The work one budgeted loop iteration buys the whole run, in Boa's
/// instruction cost units (a loop's own bookkeeping is about ten; the
/// rest is its body).
pub const WORK_PER_ITERATION: u64 = 64;

/// Cost units between two looks at the run's budget.
const SLICE: u32 = 1 << 16;

/// What a run over its whole-run budget fails with.
pub const OVER_BUDGET: &str = "the script ran over its loop budget for the whole run";

/// Evaluate `source` in `ctx`, stopping once the whole run has spent the
/// work `budget.loop_iterations` buys. Boa's own loop limit is per call
/// frame; this one counts every instruction of the script and of the
/// functions it calls, however they nest or recurse. A context whose run
/// was stopped is left mid-script: drop it.
///
/// A callback a built-in calls (`forEach`, a `sort` comparator) runs to
/// its end inside one instruction; Boa's per-frame limits bound it.
pub fn eval_within_budget(
    ctx: &mut Context,
    source: &str,
    budget: JsBudget,
) -> Result<JsValue, String> {
    let script = Script::parse(Source::from_bytes(source), None, ctx).map_err(message)?;
    let slices = budget.loop_iterations.saturating_mul(WORK_PER_ITERATION) / u64::from(SLICE) + 1;
    let mut run = std::pin::pin!(script.evaluate_async_with_budget(ctx, SLICE));
    // The future only ever yields to hand the budget back; nothing wakes it.
    let mut task = std::task::Context::from_waker(std::task::Waker::noop());
    let mut spent = 0u64;
    while spent < slices {
        if let std::task::Poll::Ready(out) = run.as_mut().poll(&mut task) {
            return out.map_err(message);
        }
        spent += 1;
    }
    Err(OVER_BUDGET.to_string())
}

/// The most array slots and properties one value may have to cross as JSON.
pub const MAX_JSON_NODES: u64 = 1 << 24;

/// The deepest nesting of a value that crosses as JSON.
pub const MAX_JSON_DEPTH: usize = 256;

/// `value` as JSON (`None` for `undefined`), refused when it is larger
/// than [`MAX_JSON_NODES`] or deeper than [`MAX_JSON_DEPTH`].
///
/// Boa's own conversion reserves an array's `length` up front and recurses
/// per level, so `a.length = 2 ** 32 - 1` on an empty array asks for
/// gigabytes, an object tree that shares its children doubles per level,
/// and a deep or cyclic one runs the native stack out. This walks the same
/// data properties first and counts them.
pub fn value_to_json(value: &JsValue, ctx: &mut Context) -> JsResult<Option<Value>> {
    let too_large = || {
        JsNativeError::range()
            .with_message("the value is too large or too deeply nested to convert to JSON")
    };
    let mut nodes = 0u64;
    let mut stack: Vec<(JsValue, usize)> = vec![(value.clone(), 0)];
    while let Some((value, depth)) = stack.pop() {
        let Some(obj) = value.as_object() else {
            continue;
        };
        if depth >= MAX_JSON_DEPTH {
            return Err(too_large().into());
        }
        // The conversion reads a proxy's own storage, which is empty.
        if JsProxy::from_object(obj.clone()).is_ok() {
            continue;
        }
        let mut children: Vec<JsValue> = Vec::new();
        {
            let object = obj.borrow();
            let properties = object.properties();
            if obj.is_array() {
                let length = properties
                    .get(&js_string!("length").into())
                    .and_then(|d| d.value().and_then(JsValue::as_number))
                    .unwrap_or(0.0);
                nodes = nodes.saturating_add(length.max(0.0) as u64);
            }
            for v in properties.index_property_values() {
                nodes = nodes.saturating_add(1);
                if nodes > MAX_JSON_NODES {
                    return Err(too_large().into());
                }
                if let Some(v) = v.value().filter(|v| v.is_object()) {
                    children.push(v.clone());
                }
            }
        }
        if nodes > MAX_JSON_NODES {
            return Err(too_large().into());
        }
        if !obj.is_array() {
            for key in obj.own_property_keys(ctx)? {
                nodes = nodes.saturating_add(1);
                if nodes > MAX_JSON_NODES {
                    return Err(too_large().into());
                }
                let child = obj
                    .borrow()
                    .properties()
                    .get(&key)
                    .and_then(|d| d.value().cloned());
                if let Some(v) = child.filter(JsValue::is_object) {
                    children.push(v);
                }
            }
        }
        stack.extend(children.into_iter().map(|v| (v, depth + 1)));
    }
    value.to_json(ctx)
}

fn context(budget: JsBudget) -> Result<Context, String> {
    sandbox_context(Sandbox::pure(budget))
}

/// Evaluate a script in a bare context and give its completion value as
/// JSON (`None` for `undefined`): a build script that computes and returns a
/// spec (paged.data's automation, data spec §10).
pub fn eval(source: &str, budget: JsBudget) -> Result<Option<Value>, String> {
    let mut ctx = context(budget)?;
    let out = eval_within_budget(&mut ctx, source, budget)?;
    value_to_json(&out, &mut ctx).map_err(message)
}

/// Evaluate `source` (a function expression) on `args` in a bare context.
pub fn call(source: &str, args: &[Value], budget: JsBudget) -> Result<Value, String> {
    let mut ctx = context(budget)?;
    let f = eval_within_budget(&mut ctx, &format!("({source}\n)"), budget)?;
    if !f.is_callable() {
        return Err("the source is not a function".into());
    }
    let args = args
        .iter()
        .map(|a| JsValue::from_json(a, &mut ctx))
        .collect::<Result<Vec<_>, _>>()
        .map_err(message)?;
    // Called from a script, not through `JsObject::call`: only a script
    // runs under the whole-run budget.
    let args = JsArray::from_iter(args, &mut ctx);
    for (name, value) in [
        (js_string!("__action"), f),
        (js_string!("__arguments"), args.into()),
    ] {
        ctx.register_global_property(name, value, Attribute::empty())
            .map_err(message)?;
    }
    let out = eval_within_budget(&mut ctx, "__action(...__arguments)", budget)?;
    Ok(value_to_json(&out, &mut ctx)
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
