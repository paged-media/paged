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

//! One connected editor tab: the relay between a model's engine tools and the
//! engine running in the person's browser.
//!
//! The tab connects over a WebSocket (hibernating, so an idle tab costs
//! nothing) with a one-minute ticket. A tool call arrives from `/mcp`, is sent
//! to the tab as `{type:"call", id, tool, args, agent, run}`, and is answered by
//! `{type:"result", id, result}` — after the tab has shown it, and asked the
//! person when the tab is set to ask. Only the tab's owner's agent may call it.

use std::cell::RefCell;
use std::collections::HashMap;
use std::time::Duration;

use futures_channel::oneshot;
use futures_util::future::{select, Either};
use serde_json::{json, Value};
use worker::{
    durable_object, DurableObject, Env, Method, Request, Response, Result, State, WebSocket,
    WebSocketIncomingMessage, WebSocketPair,
};

use crate::problem::problem;

/// How long a call waits for the tab: long enough for a person to approve it.
const CALL_TIMEOUT: Duration = Duration::from_secs(120);

#[durable_object]
pub struct SessionObject {
    state: State,
    env: Env,
    pending: RefCell<HashMap<String, oneshot::Sender<Value>>>,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct Meta {
    owner: String,
    session: String,
    document: String,
    title: String,
}

impl SessionObject {
    async fn meta(&self) -> Option<Meta> {
        self.state.storage().get("meta").await.ok().flatten()
    }

    /// Notes (or forgets) this tab in its owner's home directory.
    async fn announce(&self, meta: &Meta, connected: bool) {
        let home = format!("home:{}", meta.owner);
        let Ok(ns) = self.env.durable_object("WORKSPACE") else {
            return;
        };
        let Ok(stub) = ns.id_from_name(&home).and_then(|id| id.get_stub()) else {
            return;
        };
        let body = json!({ "session": meta.session, "document": meta.document, "title": meta.title, "connected": connected });
        let mut init = worker::RequestInit::new();
        init.with_method(Method::Post)
            .with_body(Some(body.to_string().into()));
        if let Ok(req) = Request::new_with_init(
            &format!("https://workspace/v1/w/{home}/internal/live"),
            &init,
        ) {
            let _ = stub.fetch_with_request(req).await;
        }
    }
}

impl DurableObject for SessionObject {
    fn new(state: State, env: Env) -> Self {
        SessionObject {
            state,
            env,
            pending: RefCell::new(HashMap::new()),
        }
    }

    async fn fetch(&self, mut req: Request) -> Result<Response> {
        let path = req.path();
        if path.ends_with("/ws") {
            // The Worker checked the ticket and says whose tab this is.
            let h = |k: &str| req.headers().get(k).ok().flatten().unwrap_or_default();
            let meta = Meta {
                owner: h("x-paged-actor"),
                session: h("x-paged-session"),
                document: h("x-paged-document"),
                title: h("x-paged-title"),
            };
            for old in self.state.get_websockets() {
                let _ = old.close(Some(4000), Some("replaced by a new connection"));
            }
            let pair = WebSocketPair::new()?;
            self.state.accept_web_socket(&pair.server);
            self.state.storage().put("meta", &meta).await?;
            self.announce(&meta, true).await;
            return Response::from_websocket(pair.client);
        }

        // A call from /mcp.
        let call: Value = req.json().await?;
        let Some(meta) = self.meta().await else {
            return problem(404, "Not found", "no such tab");
        };
        if call["principal"].as_str() != Some(meta.owner.as_str()) {
            return problem(403, "Refused", "that tab is someone else's");
        }
        let Some(ws) = self.state.get_websockets().into_iter().next() else {
            return problem(409, "Disconnected", "the tab is not connected");
        };
        let id = crate::crypto::random(9);
        let (tx, rx) = oneshot::channel();
        self.pending.borrow_mut().insert(id.clone(), tx);
        let msg = json!({ "type": "call", "id": id, "tool": call["tool"], "args": call["args"], "agent": call["agent"], "run": call["run"] });
        if ws.send_with_str(msg.to_string()).is_err() {
            self.pending.borrow_mut().remove(&id);
            return problem(409, "Disconnected", "the tab did not take the call");
        }
        let timeout = worker::Delay::from(CALL_TIMEOUT);
        match select(rx, timeout).await {
            Either::Left((Ok(result), _)) => Response::from_json(&result),
            _ => {
                self.pending.borrow_mut().remove(&id);
                problem(
                    504,
                    "No answer",
                    "the tab did not answer in time (or the person declined)",
                )
            }
        }
    }

    async fn websocket_message(
        &self,
        ws: WebSocket,
        message: WebSocketIncomingMessage,
    ) -> Result<()> {
        let WebSocketIncomingMessage::String(text) = message else {
            return Ok(());
        };
        let Ok(msg) = serde_json::from_str::<Value>(&text) else {
            return Ok(());
        };
        match msg["type"].as_str() {
            Some("result") => {
                let id = msg["id"].as_str().unwrap_or("");
                if let Some(tx) = self.pending.borrow_mut().remove(id) {
                    let _ = tx.send(msg["result"].clone());
                }
            }
            Some("hello") => {
                if let Some(mut meta) = self.meta().await {
                    meta.document = msg["document"].as_str().unwrap_or("").to_string();
                    meta.title = msg["title"]
                        .as_str()
                        .unwrap_or("")
                        .chars()
                        .take(120)
                        .collect();
                    self.state.storage().put("meta", &meta).await?;
                    self.announce(&meta, true).await;
                }
            }
            Some("ping") => {
                let _ = ws.send_with_str(r#"{"type":"pong"}"#);
            }
            _ => {}
        }
        Ok(())
    }

    async fn websocket_close(
        &self,
        _ws: WebSocket,
        _code: usize,
        _reason: String,
        _clean: bool,
    ) -> Result<()> {
        if let Some(meta) = self.meta().await {
            self.announce(&meta, false).await;
        }
        Ok(())
    }

    async fn websocket_error(&self, _ws: WebSocket, _error: worker::Error) -> Result<()> {
        if let Some(meta) = self.meta().await {
            self.announce(&meta, false).await;
        }
        Ok(())
    }
}
