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

//! `paged.data.*` (PM-0015, "One script interpreter"; core ADR 1014): the
//! data a run is given, from a script.
//!
//! The interpreter holds no data of its own. The embedder that has a data
//! session (the `paged` CLI's `script --source`) implements [`ScriptData`]
//! over it and installs it for one run with [`with_data`]; the door is
//! removed when the run returns, so it never leaks into the next one.
//!
//! - `paged.data.tables()` — what the run can read (the embedder's shape;
//!   the CLI answers `{ sources, queries, tables }`).
//! - `paged.data.records(table, { offset?, limit? })` — a window of a table.
//! - `paged.data.query(sql)` — one guarded SELECT over the tables.
//! - `paged.data.evaluate(query, expr, record)` — a binding expression's
//!   value at a record of a query (`{ display, value, error? }`).
//!
//! Record sets are the provider shape `{ schema: { fields: [{ name, ty }] },
//! columns, rowCount }`. With no door installed (the editor's worker today)
//! every call throws a TypeError that says so: never an empty answer that
//! looks like data.

use std::cell::RefCell;

use boa_engine::object::ObjectInitializer;
use boa_engine::{js_string, Context, JsArgs, JsNativeError, JsObject, JsResult, JsValue};
use serde_json::Value;

/// The data a script run reads, provided by its embedder.
///
/// Each method answers JSON or an error message; the bridge turns an error
/// into a JavaScript `Error` the script can catch.
pub trait ScriptData {
    /// What the run can read.
    fn tables(&mut self) -> Result<Value, String>;
    /// A window of `table` (`limit: None` reads to the end) as a record set.
    fn records(&mut self, table: &str, offset: usize, limit: Option<usize>)
        -> Result<Value, String>;
    /// The rows of `sql` as a record set. An implementation guards the query
    /// (one SELECT over the tables, no file or URL reads) before it runs.
    fn query(&mut self, sql: &str) -> Result<Value, String>;
    /// `expr`'s value at record `record` of `query`.
    fn evaluate(&mut self, query: &str, expr: &str, record: usize) -> Result<Value, String>;
}

type DataPtr = *mut (dyn ScriptData + 'static);

thread_local! {
    /// The door of the run in flight, if its embedder installed one. Set and
    /// cleared by [`with_data`] on the same stack, like `MODEL_PTR`.
    static DATA: RefCell<Option<DataPtr>> = const { RefCell::new(None) };
}

/// Restores the slot when the run returns or unwinds.
struct Installed(Option<DataPtr>);

impl Drop for Installed {
    fn drop(&mut self) {
        DATA.with(|d| *d.borrow_mut() = self.0.take());
    }
}

/// Run `f` (a script run: `execute_script`, a session's dispatch of
/// `ExecuteScript`, …) with `data` as its `paged.data`. The door is removed
/// when `f` returns, so the next run without one gets the honest TypeError.
pub fn with_data<R>(data: &mut dyn ScriptData, f: impl FnOnce() -> R) -> R {
    let ptr: *mut (dyn ScriptData + '_) = data;
    // SAFETY: the lifetime is erased only for the slot. `Installed` clears
    // the slot (restoring what was there) before this function returns or
    // unwinds, and the slot is read only by the host functions below, which
    // run synchronously inside `f` on this thread. So the pointer is never
    // read after `data`'s borrow ends.
    let ptr: DataPtr = unsafe { std::mem::transmute::<*mut (dyn ScriptData + '_), DataPtr>(ptr) };
    let previous = DATA.with(|d| d.borrow_mut().replace(ptr));
    let _restore = Installed(previous);
    f()
}

fn no_data() -> boa_engine::JsError {
    JsNativeError::typ()
        .with_message(
            "paged.data: no data is attached to this run (the embedder gave the script no data \
             session; the paged CLI attaches one with `paged script --source ID=FILE`)",
        )
        .into()
}

fn with_door(
    ctx: &mut Context,
    f: impl FnOnce(&mut dyn ScriptData) -> Result<Value, String>,
) -> JsResult<JsValue> {
    let ptr = DATA.with(|d| *d.borrow()).ok_or_else(no_data)?;
    // SAFETY: installed by `with_data`, whose borrow outlives this call (see
    // there). The door is not re-entered: it cannot call back into a script.
    let answer = f(unsafe { &mut *ptr });
    match answer {
        Ok(v) => JsValue::from_json(&v, ctx),
        Err(message) => Err(JsNativeError::error()
            .with_message(format!("paged.data: {message}"))
            .into()),
    }
}

fn text(v: &JsValue, what: &str, ctx: &mut Context) -> JsResult<String> {
    if v.is_undefined() || v.is_null() {
        return Err(JsNativeError::typ()
            .with_message(format!("paged.data: {what} is required"))
            .into());
    }
    Ok(v.to_string(ctx)?.to_std_string_escaped())
}

fn count(v: &JsValue, what: &str, ctx: &mut Context) -> JsResult<Option<usize>> {
    if v.is_undefined() || v.is_null() {
        return Ok(None);
    }
    let n = v.to_number(ctx)?;
    if !(n.is_finite() && n >= 0.0 && n.fract() == 0.0) {
        return Err(JsNativeError::typ()
            .with_message(format!(
                "paged.data: {what} is a non-negative integer, got {n}"
            ))
            .into());
    }
    Ok(Some(n as usize))
}

fn tables(_this: &JsValue, _args: &[JsValue], ctx: &mut Context) -> JsResult<JsValue> {
    with_door(ctx, |d| d.tables())
}

fn records(_this: &JsValue, args: &[JsValue], ctx: &mut Context) -> JsResult<JsValue> {
    let table = text(args.get_or_undefined(0), "the table", ctx)?;
    let (offset, limit) = match args.get_or_undefined(1) {
        v if v.is_undefined() || v.is_null() => (None, None),
        v => {
            let o = v.as_object().ok_or_else(|| {
                JsNativeError::typ()
                    .with_message("paged.data.records takes (table, { offset?, limit? })")
            })?;
            let offset = o.get(js_string!("offset"), ctx)?;
            let limit = o.get(js_string!("limit"), ctx)?;
            (count(&offset, "offset", ctx)?, count(&limit, "limit", ctx)?)
        }
    };
    with_door(ctx, |d| d.records(&table, offset.unwrap_or(0), limit))
}

fn query(_this: &JsValue, args: &[JsValue], ctx: &mut Context) -> JsResult<JsValue> {
    let sql = text(args.get_or_undefined(0), "the SQL", ctx)?;
    with_door(ctx, |d| d.query(&sql))
}

fn evaluate(_this: &JsValue, args: &[JsValue], ctx: &mut Context) -> JsResult<JsValue> {
    let query = text(args.get_or_undefined(0), "the query", ctx)?;
    let expr = text(args.get_or_undefined(1), "the expression", ctx)?;
    let record = count(args.get_or_undefined(2), "the record", ctx)?.unwrap_or(0);
    with_door(ctx, |d| d.evaluate(&query, &expr, record))
}

/// A host function of the bridge.
type HostFn = fn(&JsValue, &[JsValue], &mut Context) -> JsResult<JsValue>;

/// The `paged.data` object; `guard` is the bridge's deadline wrapper.
pub(crate) fn object(
    ctx: &mut Context,
    guard: fn(HostFn) -> boa_engine::NativeFunction,
) -> JsObject {
    ObjectInitializer::new(ctx)
        .function(guard(tables), js_string!("tables"), 0)
        .function(guard(records), js_string!("records"), 2)
        .function(guard(query), js_string!("query"), 1)
        .function(guard(evaluate), js_string!("evaluate"), 3)
        .build()
}
