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

//! One repository, one Durable Object: the single writer of its refs, so a
//! ref's compare-and-set is atomic for free.
//!
//! Each request builds a `Repo` over the object's SQLite store; nothing is kept
//! between requests but what SQLite holds. An operation that needs an object in
//! R2 fails with `Missing`; `faulting` fetches it and runs the operation again.
//! Operations are safe to run again: nothing moves before every read succeeded.

use std::collections::BTreeMap;

use paged_repo::{
    reachable, read_records, Actor, ActorKind, Ctx, Error, Hash, Kind, Policy, Refusal, Repo, Store,
};
use serde::Deserialize;
use worker::{
    durable_object, Bucket, DurableObject, Env, Method, Request, Response, Result, State,
};

use crate::problem::problem;
use crate::store::{DoStore, INLINE_MAX, SCHEMA};
use crate::ACTOR_HEADER;

#[durable_object]
pub struct RepoObject {
    state: State,
    env: Env,
}

#[derive(Deserialize)]
struct RefMove {
    expected: Option<String>,
    new: Option<String>,
}

fn now() -> i64 {
    worker::Date::now().as_millis() as i64
}

fn parse(h: &str) -> Option<Hash> {
    Hash::from_hex(h)
}

/// The kernel's verdicts as HTTP.
fn answer(e: Error) -> Result<Response> {
    match e {
        Error::Refused(r) => problem(403, "Refused", &r.to_string()),
        Error::RefConflict { name, found, .. } => {
            let found = found
                .map(|h| h.to_hex())
                .unwrap_or_else(|| "nothing".into());
            problem(409, "Ref moved", &format!("`{name}` is at {found}"))
        }
        Error::Missing(h) => problem(422, "Objects missing", &format!("upload {h} first")),
        Error::Tampered(h) => problem(422, "Object does not match its address", &h.to_hex()),
        other => problem(400, "Bad request", &other.to_string()),
    }
}

impl RepoObject {
    fn bucket(&self) -> Result<Bucket> {
        self.env.bucket("BLOBS")
    }

    fn policy(store: &DoStore) -> Option<std::result::Result<Policy, Refusal>> {
        store.meta("policy").map(|b| Policy::parse(&b))
    }

    /// Reads what `objects` names from R2 into the store's cache.
    async fn fetch_r2(
        &self,
        store: &DoStore,
        hashes: impl IntoIterator<Item = Hash>,
    ) -> Result<()> {
        let bucket = self.bucket()?;
        for h in hashes {
            if store.in_r2(&h).is_none() {
                continue;
            }
            let missing = || worker::Error::from(format!("object {h} is recorded but not in R2"));
            let obj = bucket
                .get(store.r2_key(&h))
                .execute()
                .await?
                .ok_or_else(missing)?;
            let bytes = obj.body().ok_or_else(missing)?.bytes().await?;
            store
                .provide(h, bytes)
                .map_err(|e| worker::Error::from(e.to_string()))?;
        }
        Ok(())
    }

    /// Runs `op`, fetching whatever R2 object it reports missing, until it is done.
    async fn faulting<T>(
        &self,
        repo: &mut Repo<DoStore>,
        mut op: impl FnMut(&mut Repo<DoStore>) -> std::result::Result<T, Error>,
    ) -> Result<std::result::Result<T, Error>> {
        loop {
            match op(repo) {
                Err(Error::Missing(h)) if repo.store.in_r2(&h).is_some() => {
                    self.fetch_r2(&repo.store, [h]).await?;
                }
                other => return Ok(other),
            }
        }
    }
}

impl DurableObject for RepoObject {
    fn new(state: State, env: Env) -> Self {
        if let Err(e) = state.storage().sql().exec(SCHEMA, None) {
            worker::console_error!("schema: {e}");
        }
        RepoObject { state, env }
    }

    async fn fetch(&self, mut req: Request) -> Result<Response> {
        let url = req.url()?;
        let path = url.path().to_string();
        let mut parts = path.trim_start_matches("/v1/r/").splitn(2, '/');
        let name = parts.next().unwrap_or("").to_string();
        let route = parts.next().unwrap_or("").to_string();
        let Some(actor_id) = req.headers().get(ACTOR_HEADER)? else {
            return problem(401, "Unauthenticated", "no actor");
        };
        let kind = if actor_id.starts_with("svc:") {
            ActorKind::Service
        } else {
            ActorKind::Human
        };
        let ctx = Ctx {
            actor: Actor {
                id: actor_id.clone(),
                kind,
            },
            ts: now(),
            provenance: None,
        };

        let store = DoStore::new(self.state.storage().sql(), &name);
        let policy = Self::policy(&store);
        // Reading needs a role; a repository nobody has written yet has none to read.
        let may_read = matches!(&policy, Some(Ok(p)) if p.role(&actor_id).is_some());
        let may_write = match &policy {
            None => true,
            Some(Ok(p)) => p
                .role(&actor_id)
                .is_some_and(|r| r >= paged_repo::Role::Editor),
            Some(Err(_)) => false,
        };

        match (req.method(), route.as_str()) {
            (Method::Post, "have") => {
                if !may_write {
                    return problem(403, "Refused", "uploading needs write access");
                }
                let offered: Vec<String> = req.json().await?;
                let missing: Vec<String> = offered
                    .iter()
                    .filter_map(|h| parse(h))
                    .filter(|h| !store.has(h))
                    .map(|h| h.to_hex())
                    .collect();
                Response::from_json(&missing)
            }
            (Method::Put, "objects") => {
                if !may_write {
                    return problem(403, "Refused", "uploading needs write access");
                }
                let body = req.bytes().await?;
                let records = match read_records(&body) {
                    Ok(r) => r,
                    Err(e) => return answer(e),
                };
                let bucket = self.bucket()?;
                let mut stored = 0;
                for (kind, hash, bytes) in records {
                    if store.has(&hash) {
                        continue;
                    }
                    if kind == Kind::Blob && bytes.len() > INLINE_MAX {
                        // R2 first, then the row: a row never names bytes that are not there.
                        bucket
                            .put(store.r2_key(&hash), bytes.clone())
                            .execute()
                            .await?;
                        store.record(kind, &hash, None, bytes.len() as u64);
                    } else {
                        store.record(kind, &hash, Some(&bytes), bytes.len() as u64);
                    }
                    stored += 1;
                }
                Response::from_json(&serde_json::json!({ "stored": stored }))
            }
            (Method::Post, "fetch") => {
                if !may_read {
                    return problem(404, "Not found", "no such repository");
                }
                #[derive(Deserialize)]
                struct Want {
                    want: String,
                    #[serde(default)]
                    have: Vec<String>,
                }
                let w: Want = req.json().await?;
                let Some(want) = parse(&w.want) else {
                    return problem(400, "Bad request", "want is an address");
                };
                // What `want` reaches, less what the client's heads already reach.
                let have: std::collections::BTreeSet<Hash> = w
                    .have
                    .iter()
                    .filter_map(|h| parse(h))
                    .filter(|h| store.has(h))
                    .collect();
                let objects = match reachable(&store, &[want], |c| have.contains(c)) {
                    Ok(o) => o,
                    Err(e) => return answer(e),
                };
                self.fetch_r2(&store, objects.iter().map(|(_, h)| *h))
                    .await?;
                match paged_repo::pack_of(&store, &objects) {
                    Ok(pack) => {
                        let mut resp = Response::from_bytes(pack)?;
                        resp.headers_mut()
                            .set("content-type", "application/octet-stream")?;
                        Ok(resp)
                    }
                    Err(e) => answer(e),
                }
            }
            (Method::Get, "refs") => {
                if !may_read {
                    return problem(404, "Not found", "no such repository");
                }
                let refs: BTreeMap<String, String> = store
                    .refs()
                    .into_iter()
                    .map(|(k, v)| (k, v.to_hex()))
                    .collect();
                Response::from_json(&refs)
            }
            (Method::Post, r) if r.starts_with("refs/") => {
                let ref_name = r.trim_start_matches("refs/").to_string();
                let mv: RefMove = req.json().await?;
                let (expected, new) = (
                    mv.expected.as_deref().map(parse),
                    mv.new.as_deref().map(parse),
                );
                if matches!(expected, Some(None)) || matches!(new, Some(None)) {
                    return problem(400, "Bad request", "expected and new are addresses or null");
                }
                // The first writer owns a new repository (until workspaces assign roles).
                let policy = match policy {
                    Some(p) => p,
                    None => {
                        let p = Policy::local(&actor_id);
                        store.set_meta("policy", &serde_json::to_vec(&p).expect("serializes"));
                        Ok(p)
                    }
                };
                let mut repo = Repo::new(store, policy);
                let (expected, new) = (expected.flatten(), new.flatten());
                let r = self
                    .faulting(&mut repo, |repo| {
                        repo.receive(BTreeMap::new(), &ref_name, expected, new, &ctx, false)
                    })
                    .await?;
                match r {
                    Ok(()) => {
                        Response::from_json(&serde_json::json!({ "ref": ref_name, "at": mv.new }))
                    }
                    Err(e) => answer(e),
                }
            }
            (Method::Get, r) if r.starts_with("log/") => {
                if !may_read {
                    return problem(404, "Not found", "no such repository");
                }
                let mut repo = Repo::new(
                    store,
                    policy.unwrap_or_else(|| Err(Refusal::PolicyInvalid("none".into()))),
                );
                let ref_name = r.trim_start_matches("log/").to_string();
                match self.faulting(&mut repo, |repo| repo.log(&ref_name)).await? {
                    Ok(log) => {
                        let out: Vec<serde_json::Value> = log
                            .into_iter()
                            .map(|(h, c)| serde_json::json!({ "hash": h.to_hex(), "commit": c }))
                            .collect();
                        Response::from_json(&out)
                    }
                    Err(e) => answer(e),
                }
            }
            (Method::Get, r) if r.starts_with("objects/") => {
                if !may_read {
                    return problem(404, "Not found", "no such repository");
                }
                let Some(h) = parse(r.trim_start_matches("objects/")) else {
                    return problem(400, "Bad request", "not an address");
                };
                self.fetch_r2(&store, [h]).await?;
                let Some(bytes) = store.get(&h) else {
                    return problem(404, "Not found", "no such object");
                };
                let mut resp = Response::from_bytes(bytes)?;
                resp.headers_mut()
                    .set("cache-control", "public, max-age=31536000, immutable")?;
                Ok(resp)
            }
            (Method::Get, r) if r.starts_with("file/") => {
                if !may_read {
                    return problem(404, "Not found", "no such repository");
                }
                let ref_name = r
                    .trim_start_matches("file/")
                    .trim_end_matches(".paged")
                    .to_string();
                let history = url.query_pairs().any(|(k, v)| k == "history" && v == "1");
                let Some(head) = store.get_ref(&ref_name) else {
                    return problem(404, "Not found", "no such ref");
                };
                // Everything the projection reads, fetched from R2 in one pass.
                let heads: Vec<Hash> = if history {
                    store.refs().into_iter().map(|(_, h)| h).collect()
                } else {
                    vec![head]
                };
                let wanted = match reachable(&store, &heads, |c| !history && *c != head) {
                    Ok(w) => w,
                    Err(e) => return answer(e),
                };
                self.fetch_r2(&store, wanted.into_iter().map(|(_, h)| h))
                    .await?;
                let mut repo = Repo::new(
                    store,
                    policy.unwrap_or_else(|| Err(Refusal::PolicyInvalid("none".into()))),
                );
                match self
                    .faulting(&mut repo, |repo| repo.export(&ref_name, &ctx, history))
                    .await?
                {
                    Ok(bytes) => {
                        let mut resp = Response::from_bytes(bytes)?;
                        resp.headers_mut()
                            .set("content-type", "application/x-paged+zip")?;
                        Ok(resp)
                    }
                    Err(e) => answer(e),
                }
            }
            (Method::Get, "evidence") => {
                if !may_read {
                    return problem(404, "Not found", "no such repository");
                }
                let entries: Vec<serde_json::Value> = store
                    .evidence()
                    .iter()
                    .filter_map(|b| serde_json::from_slice(b).ok())
                    .collect();
                Response::from_json(&entries)
            }
            _ => problem(404, "Not found", "no such route"),
        }
    }
}
