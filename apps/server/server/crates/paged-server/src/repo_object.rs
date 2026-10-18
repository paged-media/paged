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
use std::time::Duration;

use paged_repo::{
    reachable, read_records, Actor, ActorKind, Ctx, Error, Hash, Kind, Policy, Refusal, Repo, Store,
};
use serde::Deserialize;
use worker::{
    durable_object, Bucket, DurableObject, Env, Method, Request, Response, Result,
    SqlStorageValue as V, State,
};

use crate::problem::problem;
use crate::store::{DoStore, INLINE_MAX, SCHEMA};
use crate::workspace_object::INTERNAL_POLICY;
use crate::{
    ACTOR_HEADER, CLIENT_HEADER, ON_BEHALF_HEADER, REPO_HEADER, ROUTE_HEADER, RUN_HEADER,
    WORKSPACE_HEADER,
};

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

    /// Notes this repository in its directory — the workspace's, or the
    /// writer's home — so `list_documents` can find it. Best effort.
    async fn register(&self, workspace: Option<&str>, name: &str, principal: &str) {
        let directory = match workspace {
            Some(ws) => ws.to_string(),
            None => format!("home:{principal}"),
        };
        let Ok(ns) = self.env.durable_object("WORKSPACE") else {
            return;
        };
        let Ok(stub) = ns.id_from_name(&directory).and_then(|id| id.get_stub()) else {
            return;
        };
        let mut init = worker::RequestInit::new();
        init.with_method(Method::Post)
            .with_body(Some(serde_json::json!({ "name": name }).to_string().into()));
        let url = format!("https://workspace/v1/w/{directory}/internal/register");
        if let Ok(req) = Request::new_with_init(&url, &init) {
            let _ = stub.fetch_with_request(req).await;
        }
    }

    /// After a ref moves: collection and a backup snapshot, ten minutes on.
    async fn schedule(&self, store: &DoStore, name: &str, workspace: Option<&str>) {
        store.set_meta("name", name.as_bytes());
        if let Some(ws) = workspace {
            store.set_meta("workspace", ws.as_bytes());
        }
        let storage = self.state.storage();
        let delay = self
            .env
            .var("PAGED_MAINTENANCE_DELAY_S")
            .ok()
            .and_then(|v| v.to_string().parse().ok())
            .unwrap_or(600);
        if matches!(storage.get_alarm().await, Ok(None)) {
            let _ = storage.set_alarm(Duration::from_secs(delay)).await;
        }
    }

    /// Removes what no ref reaches, except what arrived in the last hour (a
    /// push in flight uploads before it moves its ref). R2 bytes go too.
    async fn collect(&self, store: &DoStore) -> Result<serde_json::Value> {
        let heads: Vec<Hash> = store.refs().into_iter().map(|(_, h)| h).collect();
        let live: std::collections::BTreeSet<Hash> = match reachable(store, &heads, |_| false) {
            Ok(r) => r.into_iter().map(|(_, h)| h).collect(),
            Err(e) => return Ok(serde_json::json!({ "error": e.to_string() })),
        };
        let grace = self
            .env
            .var("PAGED_GC_GRACE_MS")
            .ok()
            .and_then(|v| v.to_string().parse().ok())
            .unwrap_or(3_600_000);
        let recent = store.recent(grace);
        let bucket = self.bucket()?;
        let (mut rows, mut r2) = (0, 0);
        for (h, in_r2) in store.rows_all() {
            if live.contains(&h) || recent.contains(&h) {
                continue;
            }
            if in_r2 {
                bucket.delete(store.r2_key(&h)).await?;
                bucket.delete(store.r2_plain_key(&h)).await?;
                r2 += 1;
            }
            let mut s = DoStore::new(self.state.storage().sql(), "");
            s.remove(&h);
            rows += 1;
        }
        Ok(serde_json::json!({ "removed": rows, "r2_removed": r2, "kept": live.len() }))
    }

    /// Deletes every R2 object under this repository's prefixes.
    async fn erase_r2(&self, store: &DoStore) -> Result<usize> {
        let bucket = self.bucket()?;
        let mut removed = 0;
        for prefix in store.r2_prefixes() {
            loop {
                let listed = bucket
                    .list()
                    .prefix(prefix.clone())
                    .limit(1000)
                    .execute()
                    .await?;
                let keys: Vec<String> = listed.objects().iter().map(|o| o.key()).collect();
                if keys.is_empty() {
                    break;
                }
                removed += keys.len();
                bucket.delete_multiple(keys).await?;
            }
        }
        Ok(removed)
    }

    async fn unregister(&self, workspace: Option<&str>, name: &str, principal: &str) {
        let directory = match workspace {
            Some(ws) => ws.to_string(),
            None => format!("home:{principal}"),
        };
        let Ok(ns) = self.env.durable_object("WORKSPACE") else {
            return;
        };
        let Ok(stub) = ns.id_from_name(&directory).and_then(|id| id.get_stub()) else {
            return;
        };
        let mut init = worker::RequestInit::new();
        init.with_method(Method::Post)
            .with_body(Some(serde_json::json!({ "name": name }).to_string().into()));
        let url = format!("https://workspace/v1/w/{directory}/internal/unregister");
        if let Ok(req) = Request::new_with_init(&url, &init) {
            let _ = stub.fetch_with_request(req).await;
        }
    }

    async fn workspace_policy(&self, ws: &str) -> std::result::Result<Policy, Refusal> {
        let none = || Refusal::PolicyInvalid(format!("workspace `{ws}` has no readable policy"));
        let Ok(ns) = self.env.durable_object("WORKSPACE") else {
            return Err(none());
        };
        let Ok(stub) = ns.id_from_name(ws).and_then(|id| id.get_stub()) else {
            return Err(none());
        };
        let url = format!("https://workspace/v1/w/{ws}/{INTERNAL_POLICY}");
        let Ok(mut resp) = stub.fetch_with_str(&url).await else {
            return Err(none());
        };
        let body: serde_json::Value = resp.json().await.map_err(|_| none())?;
        match body["policy"].as_str() {
            Some(p) => Policy::parse(p.as_bytes()),
            None => Err(none()),
        }
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
            let bytes = match bucket.get(store.r2_key(&h)).execute().await? {
                Some(obj) => {
                    let sealed = obj.body().ok_or_else(missing)?.bytes().await?;
                    store.unseal(&h, &sealed).ok_or_else(|| {
                        worker::Error::from(format!(
                            "object {h} does not open with this repository's key"
                        ))
                    })?
                }
                // Written before repositories had keys: plain, still checked by address.
                None => {
                    let obj = bucket
                        .get(store.r2_plain_key(&h))
                        .execute()
                        .await?
                        .ok_or_else(missing)?;
                    obj.body().ok_or_else(missing)?.bytes().await?
                }
            };
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
    /// Maintenance: collection, then a write-once backup snapshot of the refs
    /// and the evidence head (`b/<repo>/<ts>.json`; never overwritten).
    async fn alarm(&self) -> Result<Response> {
        let name = DoStore::new(self.state.storage().sql(), "")
            .meta("name")
            .map(|b| String::from_utf8_lossy(&b).to_string());
        let Some(name) = name else {
            return Response::ok("nothing to do");
        };
        let store = DoStore::new(self.state.storage().sql(), &name);
        let report = self.collect(&store).await?;
        let refs: BTreeMap<String, String> = store
            .refs()
            .into_iter()
            .map(|(k, v)| (k, v.to_hex()))
            .collect();
        let evidence = store.evidence();
        let head = evidence
            .last()
            .map(|b| paged_repo::address(Kind::Evidence, b).to_hex());
        let ts = now();
        let snapshot = serde_json::json!({ "repo": name, "ts": ts, "refs": refs, "evidence": { "entries": evidence.len(), "head": head }, "collected": report });
        self.bucket()?
            .put(
                format!("b/{name}/{ts}.json"),
                snapshot.to_string().into_bytes(),
            )
            .execute()
            .await?;
        Response::ok("maintained")
    }

    fn new(state: State, env: Env) -> Self {
        if let Err(e) = state.storage().sql().exec(SCHEMA, None) {
            worker::console_error!("schema: {e}");
        }
        RepoObject { state, env }
    }

    async fn fetch(&self, mut req: Request) -> Result<Response> {
        let url = req.url()?;
        // The Worker resolved which repository and route this is.
        let name = req.headers().get(REPO_HEADER)?.unwrap_or_default();
        let route = req.headers().get(ROUTE_HEADER)?.unwrap_or_default();
        let workspace = req.headers().get(WORKSPACE_HEADER)?;
        let Some(actor_id) = req.headers().get(ACTOR_HEADER)? else {
            return problem(401, "Unauthenticated", "no actor");
        };
        // An agent (a model through /mcp) acts for a person: its writes carry
        // provenance, and what it may touch is that person's role, narrowed by
        // the kernel to `agent/…` refs at the default autonomy.
        let on_behalf = req.headers().get(ON_BEHALF_HEADER)?;
        let principal = on_behalf.clone().unwrap_or_else(|| actor_id.clone());
        let kind = if on_behalf.is_some() {
            ActorKind::Agent
        } else if actor_id.starts_with("svc:") {
            ActorKind::Service
        } else {
            ActorKind::Human
        };
        let provenance = match &on_behalf {
            Some(human) => Some(paged_repo::Provenance {
                client: req
                    .headers()
                    .get(CLIENT_HEADER)?
                    .unwrap_or_else(|| "mcp".into()),
                model: None,
                run: req
                    .headers()
                    .get(RUN_HEADER)?
                    .unwrap_or_else(|| "run".into()),
                on_behalf_of: human.clone(),
            }),
            None => None,
        };
        let ctx = Ctx {
            actor: Actor {
                id: actor_id.clone(),
                kind,
            },
            ts: now(),
            provenance,
        };

        let store = DoStore::new(self.state.storage().sql(), &name);
        // A workspace repository obeys its workspace's policy, and refuses
        // everything when it cannot read one; a personal one keeps its own.
        let policy = match &workspace {
            Some(ws) => Some(self.workspace_policy(ws).await),
            None => Self::policy(&store),
        };
        // Reading needs a role; a repository nobody has written yet has none to read.
        let may_read = matches!(&policy, Some(Ok(p)) if p.role(&principal).is_some());
        let may_write = match &policy {
            None => workspace.is_none(),
            Some(Ok(p)) => p
                .role(&principal)
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
                            .put(store.r2_key(&hash), store.seal(&hash, &bytes))
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
                    None if workspace.is_some() => Err(Refusal::PolicyInvalid("no policy".into())),
                    None => {
                        let p = Policy::local(&principal);
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
                        self.register(workspace.as_deref(), &name, &principal).await;
                        self.schedule(&repo.store, &name, workspace.as_deref())
                            .await;
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
            (Method::Get, "tree") | (Method::Get, "part") | (Method::Get, "diff") => {
                if !may_read {
                    return problem(404, "Not found", "no such repository");
                }
                let q: BTreeMap<String, String> = url.query_pairs().into_owned().collect();
                let at = |k: &str| -> Option<Hash> {
                    let r = q.get(k).map_or("main", |s| s.as_str());
                    store.get_ref(r).or_else(|| parse(r))
                };
                let tree_of = |c: Hash| -> std::result::Result<paged_repo::Tree, Error> {
                    let commit: paged_repo::Commit =
                        paged_repo::decode(&store.get(&c).ok_or(Error::Missing(c))?)?;
                    let bytes = store.get(&commit.tree).ok_or(Error::Missing(commit.tree))?;
                    let tree: paged_repo::Tree = paged_repo::decode(&bytes)?;
                    Ok(tree)
                };
                match route.as_str() {
                    "tree" => {
                        let Some(c) = at("ref") else {
                            return problem(404, "Not found", "no such ref");
                        };
                        match tree_of(c) {
                            Ok(t) => {
                                let refs: BTreeMap<String, String> = store
                                    .refs()
                                    .into_iter()
                                    .map(|(k, v)| (k, v.to_hex()))
                                    .collect();
                                Response::from_json(&serde_json::json!({
                                    "version": c.to_hex(),
                                    "refs": refs,
                                    "parts": t.entries.iter().map(|e| serde_json::json!({ "path": e.path, "size": e.size })).collect::<Vec<_>>(),
                                }))
                            }
                            Err(e) => answer(e),
                        }
                    }
                    "diff" => {
                        let (Some(a), Some(b)) = (at("from"), at("to")) else {
                            return problem(404, "Not found", "no such ref");
                        };
                        match (tree_of(a), tree_of(b)) {
                            (Ok(ta), Ok(tb)) => {
                                let changes: Vec<serde_json::Value> = paged_repo::diff_trees(&ta, &tb)
                                    .into_iter()
                                    .map(|c| serde_json::json!({ "path": c.path, "change": format!("{:?}", c.kind).to_lowercase() }))
                                    .collect();
                                Response::from_json(&changes)
                            }
                            (Err(e), _) | (_, Err(e)) => answer(e),
                        }
                    }
                    _ => {
                        let Some(c) = at("ref") else {
                            return problem(404, "Not found", "no such ref");
                        };
                        let path = q.get("path").cloned().unwrap_or_default();
                        let entry = match tree_of(c) {
                            Ok(t) => t.get(&path).cloned(),
                            Err(e) => return answer(e),
                        };
                        let Some(entry) = entry else {
                            return problem(404, "Not found", "no such part");
                        };
                        let mut repo =
                            Repo::new(store, Err(Refusal::PolicyInvalid("read only".into())));
                        // Fetch the part's chunks first: a part may be many.
                        let mut want = vec![entry.hash];
                        if entry.kind == paged_repo::EntryKind::Chunks {
                            if let Some(list) = repo.store.get(&entry.hash) {
                                if let Ok(l) = paged_repo::decode::<paged_repo::ChunkList>(&list) {
                                    want.extend(l.chunks);
                                }
                            }
                        }
                        self.fetch_r2(&repo.store, want).await?;
                        match self
                            .faulting(&mut repo, |r| paged_repo::read_part(&r.store, &entry))
                            .await?
                        {
                            Ok(bytes) => Response::from_bytes(bytes),
                            Err(e) => answer(e),
                        }
                    }
                }
            }
            (Method::Post, "branch") => {
                if !may_write {
                    return problem(403, "Refused", "branching needs write access");
                }
                #[derive(Deserialize)]
                struct B {
                    from: String,
                    to: String,
                }
                let b: B = req.json().await?;
                let policy =
                    policy.unwrap_or_else(|| Err(Refusal::PolicyInvalid("no policy".into())));
                let mut repo = Repo::new(store, policy);
                match repo.branch(&b.from, &b.to, &ctx) {
                    Ok(h) => {
                        Response::from_json(&serde_json::json!({ "ref": b.to, "at": h.to_hex() }))
                    }
                    Err(e) => answer(e),
                }
            }
            (Method::Post, "commit") => {
                if !may_write {
                    return problem(403, "Refused", "writing needs write access");
                }
                #[derive(Deserialize)]
                struct P {
                    path: String,
                    #[serde(default)]
                    text: Option<String>,
                    #[serde(default)]
                    base64: Option<String>,
                    #[serde(default)]
                    delete: bool,
                }
                #[derive(Deserialize)]
                struct C {
                    branch: String,
                    message: String,
                    parts: Vec<P>,
                }
                let c: C = req.json().await?;
                let Some(head) = store.get_ref(&c.branch) else {
                    return problem(404, "Not found", "no such branch: start one first");
                };
                let base: paged_repo::Tree = match store
                    .get(&head)
                    .and_then(|b| paged_repo::decode::<paged_repo::Commit>(&b).ok())
                    .and_then(|commit| store.get(&commit.tree))
                    .and_then(|b| paged_repo::decode(&b).ok())
                {
                    Some(t) => t,
                    None => {
                        return problem(422, "Unreadable", "the branch's version could not be read")
                    }
                };
                let mut entries: BTreeMap<String, paged_repo::TreeEntry> = base
                    .entries
                    .into_iter()
                    .map(|e| (e.path.clone(), e))
                    .collect();
                let mut objects = BTreeMap::new();
                for part in c.parts {
                    if part.delete {
                        entries.remove(&part.path);
                        continue;
                    }
                    let bytes = match (part.text, part.base64) {
                        (Some(t), _) => t.into_bytes(),
                        (None, Some(b)) => match crate::crypto::unb64_std(&b) {
                            Some(b) => b,
                            None => {
                                return problem(
                                    400,
                                    "Bad part",
                                    &format!("`{}` is not base64", part.path),
                                )
                            }
                        },
                        _ => {
                            return problem(
                                400,
                                "Bad part",
                                &format!("`{}` needs text, base64 or delete", part.path),
                            )
                        }
                    };
                    let e = paged_repo::part_entry(part.path.clone(), bytes, &mut objects);
                    entries.insert(part.path, e);
                }
                let tree = paged_repo::Tree {
                    v: 1,
                    entries: entries.into_values().collect(),
                };
                if let Err(e) = tree.validate() {
                    return answer(e);
                }
                // Large blobs go to R2 before anything names them.
                let bucket = self.bucket()?;
                let mut small = BTreeMap::new();
                for (h, (kind, bytes)) in objects {
                    if kind == Kind::Blob && bytes.len() > INLINE_MAX {
                        if !store.has(&h) {
                            bucket
                                .put(store.r2_key(&h), store.seal(&h, &bytes))
                                .execute()
                                .await?;
                            store.record(kind, &h, None, bytes.len() as u64);
                        }
                    } else {
                        small.insert(h, (kind, bytes));
                    }
                }
                let tree_bytes = paged_repo::encode(&tree);
                let tree_hash = paged_repo::address(Kind::Tree, &tree_bytes);
                small.insert(tree_hash, (Kind::Tree, tree_bytes));
                let policy =
                    policy.unwrap_or_else(|| Err(Refusal::PolicyInvalid("no policy".into())));
                let mut repo = Repo::new(store, policy);
                let branch = c.branch.clone();
                let message = c.message.clone();
                let r = self
                    .faulting(&mut repo, |r| {
                        r.commit(small.clone(), tree_hash, &branch, &ctx, &message, None)
                    })
                    .await?;
                match r {
                    Ok(h) => {
                        self.register(workspace.as_deref(), &name, &principal).await;
                        self.schedule(&repo.store, &name, workspace.as_deref())
                            .await;
                        Response::from_json(
                            &serde_json::json!({ "ref": c.branch, "at": h.to_hex() }),
                        )
                    }
                    Err(e) => answer(e),
                }
            }
            (Method::Post, "gc") | (Method::Delete, "") => {
                let owner = matches!(&policy, Some(Ok(p)) if p.role(&principal) == Some(paged_repo::Role::Owner));
                if !owner || ctx.actor.kind == ActorKind::Agent {
                    return problem(
                        403,
                        "Refused",
                        "only an owner collects or erases a repository",
                    );
                }
                if req.method() == Method::Post {
                    let report = self.collect(&store).await?;
                    return Response::from_json(&report);
                }
                // Erasure: the key first, so whatever R2 still holds is unreadable
                // from this moment; then the bytes, the rows and the listing.
                store.set_meta("key", &[]);
                let removed = self.erase_r2(&store).await?;
                store.wipe();
                self.unregister(workspace.as_deref(), &name, &principal)
                    .await;
                Response::from_json(&serde_json::json!({ "erased": name, "r2_objects": removed }))
            }
            (Method::Post, "commit-file") => {
                // A whole saved file as a version on `branch` (started at `base`
                // when new): how the headless lane keeps what the engine made.
                if !may_write {
                    return problem(403, "Refused", "writing needs write access");
                }
                let q: BTreeMap<String, String> = url.query_pairs().into_owned().collect();
                let branch = q.get("branch").cloned().unwrap_or_default();
                let base = q.get("base").cloned().unwrap_or_else(|| "main".into());
                let message = q.get("message").cloned().unwrap_or_else(|| "Save".into());
                let file = req.bytes().await?;
                let snap = match paged_repo::import(&file, "save") {
                    Ok(s) => s,
                    Err(e) => return answer(e),
                };
                let policy =
                    policy.unwrap_or_else(|| Err(Refusal::PolicyInvalid("no policy".into())));
                let mut repo = Repo::new(store, policy);
                if repo.head(&branch).is_none() {
                    let Some(start) = repo.head(&base).or_else(|| parse(&base)) else {
                        return problem(404, "Not found", "no such base");
                    };
                    if let Err(e) =
                        repo.receive(BTreeMap::new(), &branch, None, Some(start), &ctx, false)
                    {
                        return answer(e);
                    }
                }
                let bucket = self.bucket()?;
                let mut small = BTreeMap::new();
                for (h, (kind, bytes)) in snap.objects {
                    if kind == Kind::Blob && bytes.len() > INLINE_MAX {
                        if !repo.store.has(&h) {
                            bucket
                                .put(repo.store.r2_key(&h), repo.store.seal(&h, &bytes))
                                .execute()
                                .await?;
                            repo.store.record(kind, &h, None, bytes.len() as u64);
                        }
                    } else {
                        small.insert(h, (kind, bytes));
                    }
                }
                let tree = snap.tree;
                let r = self
                    .faulting(&mut repo, |r| {
                        r.commit(small.clone(), tree, &branch, &ctx, &message, None)
                    })
                    .await?;
                match r {
                    Ok(h) => {
                        self.register(workspace.as_deref(), &name, &principal).await;
                        self.schedule(&repo.store, &name, workspace.as_deref())
                            .await;
                        Response::from_json(&serde_json::json!({ "ref": branch, "at": h.to_hex() }))
                    }
                    Err(e) => answer(e),
                }
            }
            (Method::Get, "cr") => {
                if !may_read {
                    return problem(404, "Not found", "no such repository");
                }
                Response::from_json(&change_requests(&store, None)?)
            }
            (Method::Post, "cr") => {
                if !may_write {
                    return problem(403, "Refused", "proposing needs write access");
                }
                #[derive(Deserialize)]
                struct Open {
                    source: String,
                    target: String,
                    #[serde(default)]
                    title: String,
                }
                let o: Open = req.json().await?;
                if store.get_ref(&o.source).is_none() || store.get_ref(&o.target).is_none() {
                    return problem(422, "No such ref", "push the source and target first");
                }
                store.sql().exec(
                    "INSERT INTO change_requests (source, target, title, author, status, created) VALUES (?, ?, ?, ?, 'open', ?)",
                    vec![
                        V::String(o.source),
                        V::String(o.target),
                        V::String(o.title.chars().take(200).collect()),
                        V::String(actor_id.clone()),
                        V::Integer(now()),
                    ],
                )?;
                let id = match store
                    .sql()
                    .exec("SELECT last_insert_rowid()", None)?
                    .raw()
                    .next()
                {
                    Some(Ok(r)) => match r[0] {
                        V::Integer(i) => i,
                        _ => 0,
                    },
                    _ => 0,
                };
                Response::from_json(&change_requests(&store, Some(id))?[0])
            }
            (Method::Post, r) if r.starts_with("cr/") => {
                let mut it = r.trim_start_matches("cr/").splitn(2, '/');
                let id: i64 = it.next().and_then(|i| i.parse().ok()).unwrap_or(-1);
                let action = it.next().unwrap_or("").to_string();
                let Some(cr) = change_requests(&store, Some(id))?.into_iter().next() else {
                    return problem(404, "Not found", "no such change request");
                };
                if cr["status"] != "open" {
                    return problem(
                        409,
                        "Not open",
                        &format!("this change request is {}", cr["status"]),
                    );
                }
                let s = |k: &str| cr[k].as_str().unwrap_or("").to_string();
                let policy = match policy {
                    Some(p) => p,
                    None => Err(Refusal::PolicyInvalid("no policy".into())),
                };
                let mut repo = Repo::new(store, policy);
                let Some(head) = repo.head(&s("source")) else {
                    return problem(422, "No such ref", "the source ref is gone");
                };
                match action.as_str() {
                    "approve" => {
                        // The kernel's rule: never one's own change, never an agent, reviewer up.
                        let author = match repo.read_commit(&head) {
                            Ok(c) => c.author.id,
                            Err(e) => return answer(e),
                        };
                        let verdict = repo
                            .policy()
                            .and_then(|p| p.authorize_approval(&ctx.actor, &author));
                        if let Err(r) = verdict {
                            repo.record(
                                &ctx,
                                "approve",
                                &format!("cr/{id}"),
                                &format!("refused: {r}"),
                            );
                            return problem(403, "Refused", &r.to_string());
                        }
                        repo.store.sql().exec(
                            "INSERT OR REPLACE INTO approvals (cr, actor, head, ts) VALUES (?, ?, ?, ?)",
                            vec![V::Integer(id), V::String(actor_id.clone()), V::String(head.to_hex()), V::Integer(now())],
                        )?;
                        repo.record(
                            &ctx,
                            "approve",
                            &format!("cr/{id}"),
                            &format!("ok {}", head.to_hex()),
                        );
                        Response::from_json(&change_requests(&repo.store, Some(id))?[0])
                    }
                    "merge" => {
                        // Only approvals of the head being merged count: a source
                        // that moved after an approval needs it again.
                        let approvers: Vec<Actor> = cr["approvals"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .filter(|a| a["head"].as_str() == Some(head.to_hex().as_str()))
                            .filter_map(|a| a["actor"].as_str())
                            .map(|a| Actor {
                                id: a.to_string(),
                                kind: ActorKind::Human,
                            })
                            .collect();
                        let (source, target) = (s("source"), s("target"));
                        match self
                            .faulting(&mut repo, |repo| {
                                repo.merge(&source, &target, &ctx, &approvers)
                            })
                            .await?
                        {
                            Ok(merged) => {
                                repo.store.sql().exec(
                                    "UPDATE change_requests SET status = 'merged', merged = ? WHERE id = ?",
                                    vec![V::String(merged.to_hex()), V::Integer(id)],
                                )?;
                                Response::from_json(&change_requests(&repo.store, Some(id))?[0])
                            }
                            Err(Error::Conflict(paths)) => problem(
                                409,
                                "Conflict",
                                &format!("both sides changed: {}", paths.join(", ")),
                            ),
                            Err(e) => answer(e),
                        }
                    }
                    "close" => {
                        let owner = repo.policy().ok().and_then(|p| p.role(&actor_id))
                            == Some(paged_repo::Role::Owner);
                        if s("author") != actor_id && !owner {
                            return problem(
                                403,
                                "Refused",
                                "only its author or an owner closes it",
                            );
                        }
                        repo.store.sql().exec(
                            "UPDATE change_requests SET status = 'closed' WHERE id = ?",
                            vec![V::Integer(id)],
                        )?;
                        repo.record(&ctx, "close", &format!("cr/{id}"), "ok");
                        Response::from_json(&change_requests(&repo.store, Some(id))?[0])
                    }
                    _ => problem(404, "Not found", "approve, merge or close"),
                }
            }
            _ => problem(404, "Not found", "no such route"),
        }
    }
}

/// Change requests (one, or all newest first) with their approvals.
fn change_requests(store: &DoStore, id: Option<i64>) -> Result<Vec<serde_json::Value>> {
    let text = |v: &V| match v {
        V::String(s) => serde_json::Value::String(s.clone()),
        V::Integer(i) => serde_json::json!(i),
        _ => serde_json::Value::Null,
    };
    let (q, b) = match id {
        Some(i) => ("SELECT id, source, target, title, author, status, created, merged FROM change_requests WHERE id = ?", vec![V::Integer(i)]),
        None => ("SELECT id, source, target, title, author, status, created, merged FROM change_requests ORDER BY id DESC", vec![]),
    };
    let rows: Vec<Vec<V>> = store
        .sql()
        .exec(q, b)?
        .raw()
        .filter_map(|r| r.ok())
        .collect();
    let mut out = Vec::new();
    for r in rows {
        let cr = match r[0] {
            V::Integer(i) => i,
            _ => continue,
        };
        let approvals: Vec<serde_json::Value> = store
            .sql()
            .exec("SELECT actor, head, ts FROM approvals WHERE cr = ? ORDER BY ts", vec![V::Integer(cr)])?
            .raw()
            .filter_map(|a| a.ok())
            .map(|a| serde_json::json!({ "actor": text(&a[0]), "head": text(&a[1]), "ts": text(&a[2]) }))
            .collect();
        out.push(serde_json::json!({
            "id": cr, "source": text(&r[1]), "target": text(&r[2]), "title": text(&r[3]),
            "author": text(&r[4]), "status": text(&r[5]), "created": text(&r[6]), "merged": text(&r[7]),
            "approvals": approvals,
        }));
    }
    Ok(out)
}
