/*
 * This file is part of paged (https://paged.media): paged.server, the optional
 * remote for paged repositories.
 *
 * paged is free software: you may redistribute it and/or modify it under the
 * terms of the GNU Affero General Public License, version 3, as published by
 * the Free Software Foundation, OR under the Paged Media Enterprise License
 * (PMEL), a commercial license available from And The Next GmbH. Full
 * copyright and license information is available in LICENSE.md, distributed
 * with this source code.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    AGPL-3.0-only OR Paged Media Enterprise License (PMEL)
 */

//! The sign-in state that must be strongly consistent: registered clients,
//! logins waiting for the identity provider, one-time codes, and refresh
//! tokens. One Durable Object holds them, so "take" (read and delete) is
//! atomic and a code or refresh token is spent exactly once — which an
//! eventually consistent store could not promise. Access tokens are signed and
//! checked without it.

use serde::Deserialize;
use serde_json::{json, Value};
use worker::{
    durable_object, DurableObject, Env, Request, Response, Result, SqlStorageValue as V, State,
};

const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS items (tbl TEXT NOT NULL, key TEXT NOT NULL,
  data TEXT NOT NULL, exp INTEGER NOT NULL, PRIMARY KEY (tbl, key));";

#[durable_object]
pub struct AuthObject {
    state: State,
    #[allow(dead_code)]
    env: Env,
}

#[derive(Deserialize)]
struct Op {
    op: String,
    tbl: String,
    key: String,
    #[serde(default)]
    data: Value,
    #[serde(default)]
    ttl: i64,
}

fn now() -> i64 {
    worker::Date::now().as_millis() as i64
}

impl DurableObject for AuthObject {
    fn new(state: State, env: Env) -> Self {
        if let Err(e) = state.storage().sql().exec(SCHEMA, None) {
            worker::console_error!("auth schema: {e}");
        }
        AuthObject { state, env }
    }

    async fn fetch(&self, mut req: Request) -> Result<Response> {
        let op: Op = req.json().await?;
        let sql = self.state.storage().sql();
        let t = now();
        sql.exec("DELETE FROM items WHERE exp < ?", vec![V::Integer(t)])?;
        match op.op.as_str() {
            "put" => {
                sql.exec(
                    "INSERT OR REPLACE INTO items (tbl, key, data, exp) VALUES (?, ?, ?, ?)",
                    vec![
                        V::String(op.tbl),
                        V::String(op.key),
                        V::String(op.data.to_string()),
                        V::Integer(t + op.ttl * 1000),
                    ],
                )?;
                Response::from_json(&json!({ "ok": true }))
            }
            "get" | "take" => {
                let rows: Vec<Vec<V>> = sql
                    .exec(
                        "SELECT data FROM items WHERE tbl = ? AND key = ?",
                        vec![V::String(op.tbl.clone()), V::String(op.key.clone())],
                    )?
                    .raw()
                    .filter_map(|r| r.ok())
                    .collect();
                let data = match rows.first().map(|r| &r[0]) {
                    Some(V::String(s)) => serde_json::from_str::<Value>(s).unwrap_or(Value::Null),
                    _ => Value::Null,
                };
                if op.op == "take" {
                    sql.exec(
                        "DELETE FROM items WHERE tbl = ? AND key = ?",
                        vec![V::String(op.tbl), V::String(op.key)],
                    )?;
                }
                Response::from_json(&json!({ "data": data }))
            }
            _ => Response::error("no such op", 400),
        }
    }
}

/// The Worker's side: one call into the auth object.
pub async fn call(
    env: &Env,
    op: &str,
    tbl: &str,
    key: &str,
    data: Value,
    ttl: i64,
) -> Result<Value> {
    let stub = env
        .durable_object("AUTH")?
        .id_from_name("auth")?
        .get_stub()?;
    let body = json!({ "op": op, "tbl": tbl, "key": key, "data": data, "ttl": ttl });
    let mut init = worker::RequestInit::new();
    init.with_method(worker::Method::Post)
        .with_body(Some(body.to_string().into()));
    let mut resp = stub
        .fetch_with_request(Request::new_with_init("https://auth/op", &init)?)
        .await?;
    let v: Value = resp.json().await?;
    Ok(v.get("data").cloned().unwrap_or(Value::Null))
}
