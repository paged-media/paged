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

//! Engine tools over the relay to a person's open editor tab (`SessionObject`).

use paged_mcp::{Content, Outcome};
use serde_json::{json, Value};
use worker::{Env, Method, Request, RequestInit};

/// The person's connected tabs, from their home directory.
async fn live_sessions(env: &Env, principal: &str) -> Vec<Value> {
    let home = format!("home:{principal}");
    let Ok(ns) = env.durable_object("WORKSPACE") else {
        return vec![];
    };
    let Ok(stub) = ns.id_from_name(&home).and_then(|id| id.get_stub()) else {
        return vec![];
    };
    let Ok(mut r) = stub
        .fetch_with_str(&format!("https://workspace/v1/w/{home}/internal/live"))
        .await
    else {
        return vec![];
    };
    r.json::<Vec<Value>>().await.unwrap_or_default()
}

/// A `CallToolResult` from the tab, as an outcome.
fn outcome(result: &Value) -> Outcome {
    let content = result["content"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|c| match c["type"].as_str() {
            Some("text") => Some(Content::Text(c["text"].as_str().unwrap_or("").to_string())),
            Some("image") => Some(Content::Image {
                data: c["data"].as_str().unwrap_or("").to_string(),
                mime: c["mimeType"].as_str().unwrap_or("image/png").to_string(),
            }),
            _ => None,
        })
        .collect();
    Outcome {
        content,
        structured: result
            .get("structuredContent")
            .cloned()
            .filter(|v| !v.is_null()),
        is_error: result["isError"] == true,
    }
}

pub async fn engine_call(
    env: &Env,
    principal: &str,
    agent: &str,
    run: &str,
    tool: &str,
    args: Value,
) -> Outcome {
    let sessions = live_sessions(env, principal).await;
    if tool == "list_live_sessions" {
        return Outcome::json(json!({ "sessions": sessions }));
    }
    let chosen = match args["session"].as_str() {
        Some(s) => s.to_string(),
        None if sessions.len() == 1 => sessions[0]["session"].as_str().unwrap_or("").to_string(),
        None if sessions.is_empty() => {
            return Outcome::error(
                "No editor tab is connected. Open the document in the paged editor and connect it \
                 (Library ▸ Connect to Claude), or run `paged mcp` to use the engine locally.",
            )
        }
        None => {
            return Outcome::error(format!(
                "More than one editor tab is connected; pass `session`, one of: {}",
                sessions
                    .iter()
                    .filter_map(|s| s["session"].as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            ))
        }
    };
    let call =
        json!({ "principal": principal, "tool": tool, "args": args, "agent": agent, "run": run });
    let mut init = RequestInit::new();
    init.with_method(Method::Post)
        .with_body(Some(call.to_string().into()));
    let ns = match env.durable_object("SESSION") {
        Ok(ns) => ns,
        Err(e) => return Outcome::error(e.to_string()),
    };
    let stub = match ns.id_from_name(&chosen).and_then(|id| id.get_stub()) {
        Ok(s) => s,
        Err(e) => return Outcome::error(e.to_string()),
    };
    let req = match Request::new_with_init("https://session/call", &init) {
        Ok(r) => r,
        Err(e) => return Outcome::error(e.to_string()),
    };
    match stub.fetch_with_request(req).await {
        Ok(mut r) if r.status_code() < 400 => match r.json::<Value>().await {
            Ok(v) => outcome(&v),
            Err(e) => Outcome::error(e.to_string()),
        },
        Ok(mut r) => {
            let p: Value = r.json().await.unwrap_or_default();
            Outcome::error(format!(
                "{} — {}",
                p["title"].as_str().unwrap_or("refused"),
                p["detail"].as_str().unwrap_or("")
            ))
        }
        Err(e) => Outcome::error(e.to_string()),
    }
}
