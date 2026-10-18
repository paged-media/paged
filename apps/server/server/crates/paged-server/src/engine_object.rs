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

//! The headless lane: engine tools with no editor tab open. One `EngineObject`
//! per MCP run holds the run's working document (sealed in R2 under a per-run
//! key) and calls the engine — `paged engine-serve` — which is stateless: each
//! call brings the document and takes back what the engine made of it.
//!
//! In production the engine is a Cloudflare Container attached to this class
//! (`state.container()`); in local development it is `paged engine-serve` on
//! the port `PAGED_ENGINE_URL` names. With neither, the lane is absent and
//! engine tools say so.

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use worker::{
    durable_object, DurableObject, Env, Fetch, Headers, Method, Request, RequestInit, Response,
    Result, State, Url,
};

use crate::problem::problem;

#[durable_object]
pub struct EngineObject {
    state: State,
    env: Env,
}

#[derive(Serialize, Deserialize, Clone)]
struct Run {
    principal: String,
    document: String,
    reference: String,
    key: Vec<u8>,
}

fn b64() -> base64::engine::GeneralPurpose {
    base64::engine::general_purpose::STANDARD
}

/// Whether this deployment has an engine for the headless lane: a container
/// (`PAGED_ENGINE_CONTAINER=1`, set where one is attached) or a local one.
pub fn available(env: &Env) -> bool {
    let set = |k: &str| env.var(k).is_ok_and(|v| !v.to_string().is_empty());
    set("PAGED_ENGINE_URL")
        || env
            .var("PAGED_ENGINE_CONTAINER")
            .is_ok_and(|v| v.to_string() == "1")
}

impl EngineObject {
    fn key(&self, run: &str) -> String {
        format!("w/{run}.paged")
    }

    async fn engine(&self, call: &Value) -> Result<Value> {
        let headers = Headers::new();
        headers.set("content-type", "application/json")?;
        let mut init = RequestInit::new();
        init.with_method(Method::Post)
            .with_headers(headers)
            .with_body(Some(call.to_string().into()));
        let mut resp = if let Some(container) = self.state.container() {
            if !container.running() {
                container.start(None)?;
            }
            container
                .get_tcp_port(8080)?
                .fetch("http://engine/run", Some(init))
                .await?
        } else {
            let base = self.env.var("PAGED_ENGINE_URL")?.to_string();
            let url = Url::parse(&format!("{}/run", base.trim_end_matches('/')))?;
            Fetch::Request(Request::new_with_init(url.as_str(), &init)?)
                .send()
                .await?
        };
        let status = resp.status_code();
        let body: Value = resp.json().await?;
        if status >= 400 {
            return Err(format!(
                "the engine refused: {}",
                body["error"].as_str().unwrap_or("?")
            )
            .into());
        }
        Ok(body)
    }

    async fn working(&self, run: &str, meta: &Run) -> Result<Vec<u8>> {
        let obj = self
            .env
            .bucket("BLOBS")?
            .get(self.key(run))
            .execute()
            .await?
            .ok_or_else(|| worker::Error::from("open a document first"))?;
        let sealed = obj
            .body()
            .ok_or_else(|| worker::Error::from("empty"))?
            .bytes()
            .await?;
        let kept = crate::crypto::open(&meta.key, run.as_bytes(), &sealed)
            .ok_or_else(|| worker::Error::from("the working copy does not open"))?;
        paged_repo::kept_bytes(&kept, &paged_repo::Hash([0; 32]))
            .map_err(|e| worker::Error::from(e.to_string()))
    }

    async fn keep(&self, run: &str, meta: &Run, bytes: &[u8]) -> Result<()> {
        let sealed = crate::crypto::seal(&meta.key, run.as_bytes(), &paged_repo::keep_bytes(bytes));
        self.env
            .bucket("BLOBS")?
            .put(self.key(run), sealed)
            .execute()
            .await?;
        Ok(())
    }
}

impl DurableObject for EngineObject {
    fn new(state: State, env: Env) -> Self {
        EngineObject { state, env }
    }

    async fn fetch(&self, mut req: Request) -> Result<Response> {
        let h = |k: &str| req.headers().get(k).ok().flatten().unwrap_or_default();
        let (run, principal, op) = (
            h("x-paged-run"),
            h("x-paged-on-behalf-of"),
            h("x-paged-engine-op"),
        );
        let stored: Option<Run> = self.state.storage().get("run").await.ok().flatten();
        if let Some(r) = &stored {
            if r.principal != principal {
                return problem(403, "Refused", "this run is someone else's");
            }
        }
        match op.as_str() {
            "open" => {
                let meta = Run {
                    principal,
                    document: h("x-paged-document"),
                    reference: h("x-paged-ref"),
                    key: stored
                        .map(|r| r.key)
                        .unwrap_or_else(|| crate::crypto::random_bytes(32)),
                };
                let bytes = req.bytes().await?;
                self.keep(&run, &meta, &bytes).await?;
                self.state.storage().put("run", &meta).await?;
                Response::from_json(
                    &json!({ "document": meta.document, "ref": meta.reference, "bytes": bytes.len() }),
                )
            }
            "run" => {
                let Some(meta) = stored else {
                    return problem(409, "Nothing open", "open a document first");
                };
                let mut call: Value = req.json().await?;
                call["file"] = json!(b64().encode(self.working(&run, &meta).await?));
                if call.get("script").is_some() {
                    call["export"] = json!(true);
                }
                let mut out = self.engine(&call).await?;
                if let Some(file) = out.get("file").and_then(Value::as_str) {
                    let bytes = b64()
                        .decode(file)
                        .map_err(|e| worker::Error::from(e.to_string()))?;
                    self.keep(&run, &meta, &bytes).await?;
                }
                if let Some(o) = out.as_object_mut() {
                    o.remove("file");
                }
                Response::from_json(&out)
            }
            "file" => {
                let Some(meta) = stored else {
                    return problem(409, "Nothing open", "open a document first");
                };
                let bytes = self.working(&run, &meta).await?;
                let mut r = Response::from_bytes(bytes)?;
                r.headers_mut().set("x-paged-document", &meta.document)?;
                r.headers_mut().set("x-paged-ref", &meta.reference)?;
                Ok(r)
            }
            _ => problem(404, "Not found", "open, run or file"),
        }
    }
}
