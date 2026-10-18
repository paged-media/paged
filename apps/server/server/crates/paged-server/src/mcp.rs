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

//! `/mcp`: paged.server as an MCP server (Streamable HTTP, one JSON answer per
//! POST, no server-initiated stream), for a model client such as Claude.
//!
//! The tools are core's `paged-mcp` catalog. The caller signs in with OAuth
//! (a 401 names the protected-resource metadata), and every call is an
//! agent's: `agent:<client>` acting for the signed-in person, in a run named by
//! the MCP session. Repositories check that person's role and the kernel
//! confines the agent to `agent/<run>/…` refs at the default autonomy, so what
//! a model writes reaches `main` only through a change request a person
//! approves. Engine tools act in the person's open editor tab (`session`).

use paged_mcp::{tools, Host, Outcome};
use serde_json::{json, Value};
use worker::{Env, Headers, Method, Request, RequestInit, Response, Result};

use crate::problem::problem;
use crate::{
    auth, oauth, ACTOR_HEADER, CLIENT_HEADER, ON_BEHALF_HEADER, REPO_HEADER, ROUTE_HEADER,
    RUN_HEADER, WORKSPACE_HEADER,
};

const SESSION_HEADER: &str = "mcp-session-id";

pub struct WorkerHost<'a> {
    env: &'a Env,
    principal: String,
    client: String,
    run: String,
    origin: String,
}

fn valid(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// `repo` or `workspace/repo`.
fn document(args: &Value) -> std::result::Result<(Option<String>, String), String> {
    let d = args["document"].as_str().unwrap_or("");
    match d.split_once('/') {
        Some((ws, repo)) if valid(ws) && valid(repo) => {
            Ok((Some(ws.into()), format!("{ws}/{repo}")))
        }
        None if valid(d) => Ok((None, d.into())),
        _ => Err(format!(
            "`{d}` is not a document name (repository, or workspace/repository)"
        )),
    }
}

fn reference(args: &Value, key: &str) -> String {
    args[key]
        .as_str()
        .filter(|s| !s.is_empty())
        .unwrap_or("main")
        .to_string()
}

fn enc(s: &str) -> String {
    worker::url::form_urlencoded::byte_serialize(s.as_bytes()).collect()
}

impl WorkerHost<'_> {
    fn agent(&self) -> String {
        format!(
            "agent:{}",
            if self.client.is_empty() {
                "mcp"
            } else {
                &self.client
            }
        )
    }

    /// One call into a Durable Object, as this agent (or, for a directory, as the person).
    async fn call_object(
        &self,
        ns: &str,
        object: &str,
        headers: &[(&str, &str)],
        method: Method,
        url: &str,
        body: Option<Value>,
    ) -> std::result::Result<(u16, Vec<u8>), String> {
        let h = Headers::new();
        for (k, v) in headers {
            h.set(k, v).map_err(|e| e.to_string())?;
        }
        let mut init = RequestInit::new();
        init.with_method(method).with_headers(h);
        if let Some(b) = body {
            init.with_body(Some(b.to_string().into()));
        }
        let req = Request::new_with_init(url, &init).map_err(|e| e.to_string())?;
        let namespace = self.env.durable_object(ns).map_err(|e| e.to_string())?;
        let stub = namespace
            .id_from_name(object)
            .and_then(|id| id.get_stub())
            .map_err(|e| e.to_string())?;
        let mut resp = stub
            .fetch_with_request(req)
            .await
            .map_err(|e| e.to_string())?;
        let status = resp.status_code();
        let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
        Ok((status, bytes))
    }

    async fn repo(
        &self,
        args: &Value,
        method: Method,
        route: &str,
        query: &str,
        body: Option<Value>,
    ) -> std::result::Result<Vec<u8>, String> {
        let (ws, name) = document(args)?;
        let agent = self.agent();
        let mut headers = vec![
            (ACTOR_HEADER, agent.as_str()),
            (ON_BEHALF_HEADER, self.principal.as_str()),
            (RUN_HEADER, self.run.as_str()),
            (CLIENT_HEADER, self.client.as_str()),
            (ROUTE_HEADER, route),
            (REPO_HEADER, name.as_str()),
        ];
        if let Some(ws) = &ws {
            headers.push((WORKSPACE_HEADER, ws.as_str()));
        }
        let url = format!("https://repo/mcp?{query}");
        let (status, bytes) = self
            .call_object("REPO", &name, &headers, method, &url, body)
            .await?;
        if status >= 400 {
            let p: Value = serde_json::from_slice(&bytes).unwrap_or_default();
            return Err(format!(
                "{} — {}",
                p["title"].as_str().unwrap_or("refused"),
                p["detail"].as_str().unwrap_or("")
            ));
        }
        Ok(bytes)
    }

    async fn repo_json(
        &self,
        args: &Value,
        method: Method,
        route: &str,
        query: &str,
        body: Option<Value>,
    ) -> Outcome {
        match self.repo(args, method, route, query, body).await {
            Ok(b) => Outcome::json(serde_json::from_slice(&b).unwrap_or(Value::Null)),
            Err(e) => Outcome::error(e),
        }
    }

    async fn list_documents(&self, args: &Value) -> Outcome {
        let (object, route, headers) = match args["workspace"].as_str() {
            Some(ws) if valid(ws) => (
                ws.to_string(),
                "repos",
                vec![(ACTOR_HEADER, self.principal.as_str())],
            ),
            Some(ws) => return Outcome::error(format!("`{ws}` is not a workspace name")),
            None => (format!("home:{}", self.principal), "internal/repos", vec![]),
        };
        let mut headers = headers;
        headers.push((ROUTE_HEADER, route));
        let url = format!("https://workspace/v1/w/{object}/{route}");
        match self
            .call_object("WORKSPACE", &object, &headers, Method::Get, &url, None)
            .await
        {
            Ok((s, b)) if s < 400 => Outcome::json(
                json!({ "documents": serde_json::from_slice::<Value>(&b).unwrap_or_default() }),
            ),
            Ok(_) => Outcome::error("no such workspace, or you are not a member"),
            Err(e) => Outcome::error(e),
        }
    }
}

impl Host for WorkerHost<'_> {
    fn name(&self) -> &str {
        "paged.server"
    }

    fn tools(&self) -> Vec<tools::Tool> {
        tools::select(&[tools::STORE, tools::REFERENCE, tools::ENGINE, tools::LIVE])
    }

    fn view(&self) -> Option<String> {
        Some(crate::view::HTML.to_string())
    }

    async fn call(&self, tool: &str, args: Value) -> Outcome {
        match tool {
            "list_documents" => self.list_documents(&args).await,
            "describe_document" => {
                let q = format!("ref={}", enc(&reference(&args, "ref")));
                self.repo_json(&args, Method::Get, "tree", &q, None).await
            }
            "read_part" => {
                let path = args["path"].as_str().unwrap_or("");
                let q = format!("ref={}&path={}", enc(&reference(&args, "ref")), enc(path));
                match self.repo(&args, Method::Get, "part", &q, None).await {
                    Ok(b) => match String::from_utf8(b) {
                        Ok(t) if t.len() <= 200_000 => Outcome::ok(t),
                        Ok(t) => Outcome::ok(format!(
                            "{path}: {} bytes of text; too long to show whole.\n{}",
                            t.len(),
                            &t[..t.char_indices().nth(20_000).map_or(t.len(), |(i, _)| i)]
                        )),
                        Err(e) => {
                            Outcome::ok(format!("{path}: {} bytes, not text", e.as_bytes().len()))
                        }
                    },
                    Err(e) => Outcome::error(e),
                }
            }
            "history" => {
                let route = format!("log/{}", reference(&args, "ref"));
                match self.repo(&args, Method::Get, &route, "", None).await {
                    Ok(b) => {
                        let log: Vec<Value> = serde_json::from_slice(&b).unwrap_or_default();
                        let versions: Vec<Value> = log
                            .iter()
                            .map(|e| {
                                let c = &e["commit"];
                                json!({
                                    "version": e["hash"], "message": c["message"], "author": c["author"]["id"],
                                    "agent": c["author"]["kind"] == "agent", "ts": c["ts"],
                                    "for": c["provenance"]["on_behalf_of"],
                                })
                            })
                            .collect();
                        Outcome::json(json!({ "versions": versions }))
                    }
                    Err(e) => Outcome::error(e),
                }
            }
            "diff" => {
                let q = format!(
                    "from={}&to={}",
                    enc(&reference(&args, "from")),
                    enc(&reference(&args, "to"))
                );
                self.repo_json(&args, Method::Get, "diff", &q, None).await
            }
            "create_branch" => {
                let name = args["name"].as_str().unwrap_or("");
                if !valid(name) {
                    return Outcome::error("a branch name is lowercase letters, digits and '-'");
                }
                let to = format!("agent/{}/{name}", self.run);
                let body = json!({ "from": reference(&args, "from"), "to": to });
                self.repo_json(&args, Method::Post, "branch", "", Some(body))
                    .await
            }
            "commit_parts" => {
                let body = json!({ "branch": args["branch"], "message": args["message"], "parts": args["parts"] });
                self.repo_json(&args, Method::Post, "commit", "", Some(body))
                    .await
            }
            "propose_change" => {
                let body = json!({ "source": args["branch"], "target": reference(&args, "target"), "title": args["title"] });
                match self.repo(&args, Method::Post, "cr", "", Some(body)).await {
                    Ok(b) => {
                        let cr: Value = serde_json::from_slice(&b).unwrap_or_default();
                        Outcome::json(json!({
                            "change_request": cr,
                            "next": "A person with review rights approves it and merges it; it is not on main yet.",
                        }))
                    }
                    Err(e) => Outcome::error(e),
                }
            }
            "list_changes" => self.repo_json(&args, Method::Get, "cr", "", None).await,
            "download_link" => {
                let Some(cfg) = oauth::Config::from(self.env) else {
                    return Outcome::error("this server signs no links (no token secret)");
                };
                let (ws, name) = match document(&args) {
                    Ok(d) => d,
                    Err(e) => return Outcome::error(e),
                };
                let link = oauth::mint_link(
                    &cfg,
                    &self.origin,
                    &name,
                    ws.as_deref(),
                    &reference(&args, "ref"),
                    &self.principal,
                );
                Outcome::json(json!({ "url": link, "expires_in": 600 }))
            }
            "lookup_api" => {
                Outcome::json(paged_mcp::lookup(args["query"].as_str().unwrap_or(""), 12))
            }
            t if tools::ENGINE.contains(&t) || tools::LIVE.contains(&t) => {
                crate::session::engine_call(
                    self.env,
                    &self.principal,
                    &self.agent(),
                    &self.run,
                    t,
                    args,
                )
                .await
            }
            other => Outcome::error(format!("no tool {other}")),
        }
    }
}

/// `/mcp` itself.
pub async fn serve(mut req: Request, env: &Env) -> Result<Response> {
    let url = req.url()?;
    if req.method() != Method::Post {
        let mut r = problem(
            405,
            "Method not allowed",
            "POST JSON-RPC messages; this server opens no stream",
        )?;
        r.headers_mut().set("allow", "POST")?;
        return Ok(r);
    }
    let who = match auth::principal(&req, env) {
        Ok(p) => p,
        Err(_) => {
            let mut r = problem(401, "Unauthenticated", "sign in with OAuth")?;
            r.headers_mut()
                .set("www-authenticate", &oauth::challenge(&url))?;
            return Ok(r);
        }
    };
    let session = req.headers().get(SESSION_HEADER)?.filter(|s| {
        !s.is_empty() && s.len() <= 64 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
    });
    let msg: Value = match req.json().await {
        Ok(m) => m,
        Err(_) => {
            return Response::from_json(
                &json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": "parse error" } }),
            )
        }
    };
    let initializing = msg["method"] == "initialize";
    // A new session names a run; a session's calls share it, so its branches do.
    let run = match (&session, initializing) {
        (Some(s), false) => s.to_lowercase(),
        _ => crate::crypto::random(9).to_lowercase().replace('_', "-"),
    };
    let host = WorkerHost {
        env,
        principal: who.id,
        client: who
            .client
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
            .take(32)
            .collect::<String>()
            .to_lowercase(),
        run: run
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
            .collect(),
        origin: oauth::origin(&url),
    };
    match paged_mcp::handle(&host, &msg).await {
        None => Ok(Response::empty()?.with_status(202)),
        Some(answer) => {
            let mut r = Response::from_json(&answer)?;
            if initializing {
                r.headers_mut().set(SESSION_HEADER, &host.run)?;
            }
            Ok(r)
        }
    }
}
