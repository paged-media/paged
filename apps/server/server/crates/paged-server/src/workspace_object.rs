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

//! A workspace: its members' roles, how far agents may go, and whether `main`
//! moves only by merge — the policy every repository in it obeys.
//!
//! The policy is governed data, not configuration: every version is kept in a
//! hash-chained log, a change names the version it replaces (compare-and-set),
//! only an owner makes one, agents never do, and a policy that does not parse
//! — or leaves no owner — is refused before it can lock anyone out. A
//! repository that cannot read its workspace's policy refuses every write.
//!
//!   POST /v1/w/{ws}                 create; the caller becomes its owner
//!   GET  /v1/w/{ws}/policy          {seq, policy}
//!   PUT  /v1/w/{ws}/policy          {expected_seq, policy}
//!   GET  /v1/w/{ws}/policy/log      every version: seq, actor, ts, hash, prev

use paged_repo::{Policy, Role};
use serde::Deserialize;
use serde_json::{json, Value};
use worker::{
    durable_object, DurableObject, Env, Method, Request, Response, Result, SqlStorageValue as V,
    State,
};

use crate::crypto::sha256_hex;
use crate::problem::problem;
use crate::{ACTOR_HEADER, ROUTE_HEADER};

const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS policy_log (seq INTEGER PRIMARY KEY,
  policy TEXT NOT NULL, actor TEXT NOT NULL, ts INTEGER NOT NULL, prev TEXT, hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS repos (name TEXT PRIMARY KEY, created INTEGER NOT NULL, updated INTEGER NOT NULL);";

/// The route a repository uses to read its workspace's policy. The Worker
/// never forwards a client path under `internal/`.
pub const INTERNAL_POLICY: &str = "internal/policy";

#[durable_object]
pub struct WorkspaceObject {
    state: State,
    #[allow(dead_code)]
    env: Env,
}

#[derive(Deserialize)]
struct Change {
    expected_seq: i64,
    policy: Value,
}

struct Entry {
    seq: i64,
    policy: String,
    hash: String,
}

impl WorkspaceObject {
    fn latest(&self) -> Result<Option<Entry>> {
        let rows: Vec<Vec<V>> = self
            .state
            .storage()
            .sql()
            .exec(
                "SELECT seq, policy, hash FROM policy_log ORDER BY seq DESC LIMIT 1",
                None,
            )?
            .raw()
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows.first().and_then(|r| match (&r[0], &r[1], &r[2]) {
            (V::Integer(seq), V::String(p), V::String(h)) => Some(Entry {
                seq: *seq,
                policy: p.clone(),
                hash: h.clone(),
            }),
            _ => None,
        }))
    }

    /// Appends a version. Its hash covers the version before it.
    fn append(&self, seq: i64, policy: &str, actor: &str, prev: Option<&str>) -> Result<String> {
        let ts = worker::Date::now().as_millis() as i64;
        let hash = sha256_hex(
            format!("{seq}\n{}\n{actor}\n{ts}\n{policy}", prev.unwrap_or("")).as_bytes(),
        );
        self.state.storage().sql().exec(
            "INSERT INTO policy_log (seq, policy, actor, ts, prev, hash) VALUES (?, ?, ?, ?, ?, ?)",
            vec![
                V::Integer(seq),
                V::String(policy.into()),
                V::String(actor.into()),
                V::Integer(ts),
                prev.map_or(V::Null, |p| V::String(p.into())),
                V::String(hash.clone()),
            ],
        )?;
        Ok(hash)
    }
}

impl WorkspaceObject {
    fn repos(&self) -> Result<Vec<Value>> {
        Ok(self
            .state
            .storage()
            .sql()
            .exec(
                "SELECT name, created, updated FROM repos ORDER BY updated DESC",
                None,
            )?
            .raw()
            .filter_map(|r| r.ok())
            .map(|r| {
                let v = |x: &V| match x {
                    V::String(s) => json!(s),
                    V::Integer(i) => json!(i),
                    _ => Value::Null,
                };
                json!({ "name": v(&r[0]), "created": v(&r[1]), "updated": v(&r[2]) })
            })
            .collect())
    }
}

impl DurableObject for WorkspaceObject {
    fn new(state: State, env: Env) -> Self {
        if let Err(e) = state.storage().sql().exec(SCHEMA, None) {
            worker::console_error!("workspace schema: {e}");
        }
        WorkspaceObject { state, env }
    }

    async fn fetch(&self, mut req: Request) -> Result<Response> {
        let path = req.path();
        // Clients arrive with the route the Worker resolved; a repository's
        // internal read arrives by path.
        let route = match req.headers().get(ROUTE_HEADER)? {
            Some(r) => r,
            None => path
                .trim_start_matches("/v1/w/")
                .split_once('/')
                .map_or("", |(_, r)| r)
                .to_string(),
        };
        let actor = req.headers().get(ACTOR_HEADER)?.unwrap_or_default();
        let latest = self.latest()?;

        // A repository reading the policy it must obey.
        if route == INTERNAL_POLICY {
            return Response::from_json(&json!({ "policy": latest.map(|e| e.policy) }));
        }
        // A repository noting itself in this directory (a workspace, or a person's home).
        if route == "internal/register" {
            let body: Value = req.json().await?;
            let name = body["name"].as_str().unwrap_or("").to_string();
            let ts = worker::Date::now().as_millis() as i64;
            self.state.storage().sql().exec(
                "INSERT INTO repos (name, created, updated) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET updated = excluded.updated",
                vec![V::String(name), V::Integer(ts), V::Integer(ts)],
            )?;
            return Response::from_json(&json!({ "ok": true }));
        }
        if route == "internal/repos" {
            return Response::from_json(&self.repos()?);
        }
        if actor.is_empty() {
            return problem(401, "Unauthenticated", "no actor");
        }
        let current = latest
            .as_ref()
            .and_then(|e| Policy::parse(e.policy.as_bytes()).ok());
        let role = current.as_ref().and_then(|p| p.role(&actor));

        match (req.method(), route.as_str()) {
            (Method::Post, "") => {
                if latest.is_some() {
                    return problem(409, "Exists", "this workspace exists");
                }
                if actor.starts_with("agent:") {
                    return problem(403, "Refused", "an agent does not create workspaces");
                }
                let p = serde_json::to_string(&Policy::local(&actor)).expect("serializes");
                self.append(1, &p, &actor, None)?;
                Response::from_json(
                    &json!({ "seq": 1, "policy": serde_json::from_str::<Value>(&p)? }),
                )
            }
            (Method::Get, "policy") => {
                let Some(e) = latest.filter(|_| role.is_some()) else {
                    return problem(404, "Not found", "no such workspace");
                };
                Response::from_json(
                    &json!({ "seq": e.seq, "policy": serde_json::from_str::<Value>(&e.policy)? }),
                )
            }
            (Method::Put, "policy") => {
                let Some(e) = latest else {
                    return problem(404, "Not found", "no such workspace");
                };
                if actor.starts_with("agent:") || role != Some(Role::Owner) {
                    return problem(403, "Refused", "only an owner changes the policy");
                }
                let change: Change = req.json().await?;
                if change.expected_seq != e.seq {
                    return problem(
                        409,
                        "Policy moved",
                        &format!("the policy is at version {}", e.seq),
                    );
                }
                let text = change.policy.to_string();
                // Validated before it can take effect: a policy that does not
                // parse, or leaves no owner, would lock everyone out.
                let parsed = match Policy::parse(text.as_bytes()) {
                    Ok(p) => p,
                    Err(r) => return problem(422, "Policy refused", &r.to_string()),
                };
                let canonical = serde_json::to_string(&parsed).expect("serializes");
                let seq = e.seq + 1;
                let hash = self.append(seq, &canonical, &actor, Some(&e.hash))?;
                Response::from_json(&json!({ "seq": seq, "hash": hash }))
            }
            (Method::Get, "repos") => {
                if role.is_none() {
                    return problem(404, "Not found", "no such workspace");
                }
                Response::from_json(&self.repos()?)
            }
            (Method::Get, "policy/log") => {
                if role.is_none() {
                    return problem(404, "Not found", "no such workspace");
                }
                let rows: Vec<Value> = self
                    .state
                    .storage()
                    .sql()
                    .exec("SELECT seq, policy, actor, ts, prev, hash FROM policy_log ORDER BY seq", None)?
                    .raw()
                    .filter_map(|r| r.ok())
                    .map(|r| {
                        let s = |v: &V| match v {
                            V::String(s) => Value::String(s.clone()),
                            V::Integer(i) => json!(i),
                            _ => Value::Null,
                        };
                        json!({ "seq": s(&r[0]), "policy": s(&r[1]), "actor": s(&r[2]), "ts": s(&r[3]), "prev": s(&r[4]), "hash": s(&r[5]) })
                    })
                    .collect();
                Response::from_json(&rows)
            }
            _ => problem(404, "Not found", "no such route"),
        }
    }
}
