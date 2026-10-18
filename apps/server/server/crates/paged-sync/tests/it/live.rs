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

//! The live relay end to end (`PAGED_SERVER_URL`): a stand-in editor tab
//! connects over a WebSocket with a ticket, and a model's engine tools reach it
//! through `/mcp`; nobody else's model can.

use std::net::TcpStream;
use std::thread;
use std::time::Duration;

use serde_json::{json, Value};
use tungstenite::{stream::MaybeTlsStream, Message, WebSocket};

fn mcp(url: &str, token: &str, method: &str, params: Value) -> Value {
    ureq::post(&format!("{url}/mcp"))
        .set("authorization", &format!("Bearer {token}"))
        .send_json(json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params }))
        .unwrap()
        .into_json()
        .unwrap()
}

fn tool(url: &str, token: &str, name: &str, args: Value) -> Value {
    mcp(
        url,
        token,
        "tools/call",
        json!({ "name": name, "arguments": args }),
    )["result"]
        .clone()
}

/// A tab that answers every call by echoing it (an image for render_page).
fn tab(url: &str) -> (String, thread::JoinHandle<Vec<Value>>) {
    let r: Value = ureq::post(&format!("{url}/v1/live"))
        .set("authorization", "Bearer dev-token")
        .send_json(json!({ "document": "brochure", "title": "Brochure" }))
        .unwrap()
        .into_json()
        .unwrap();
    let session = r["session"].as_str().unwrap().to_string();
    let ws_url = format!(
        "{}{}",
        url.replace("http://", "ws://"),
        r["url"].as_str().unwrap()
    );
    let (mut ws, _): (WebSocket<MaybeTlsStream<TcpStream>>, _) =
        tungstenite::connect(ws_url).unwrap();
    let handle = thread::spawn(move || {
        let mut seen = Vec::new();
        while let Ok(msg) = ws.read() {
            let Message::Text(t) = msg else { continue };
            let m: Value = serde_json::from_str(&t).unwrap();
            if m["type"] != "call" {
                continue;
            }
            let result = if m["tool"] == "render_page" {
                json!({ "content": [{ "type": "image", "data": "iVBORw0KGgo=", "mimeType": "image/png" }], "isError": false })
            } else {
                json!({ "content": [{ "type": "text", "text": "ok" }], "structuredContent": { "tool": m["tool"], "args": m["args"], "agent": m["agent"] }, "isError": false })
            };
            ws.send(Message::Text(
                json!({ "type": "result", "id": m["id"], "result": result }).to_string(),
            ))
            .unwrap();
            seen.push(m.clone());
            if m["args"]["source"] == "bye" {
                let _ = ws.close(None);
                break;
            }
        }
        seen
    });
    (session, handle)
}

/// `PAGED_SERVER_URL`, or `None` after reporting the server unavailable
/// (`PAGED_REQUIRE_SERVER=1` makes that a failure).
fn server() -> Option<String> {
    paged_test_resources::env_var(paged_test_resources::Resource::Server, "PAGED_SERVER_URL")
}

#[test]
#[ignore = "server: a running paged.server (PAGED_SERVER_URL)"]
fn engine_tools_reach_the_owners_tab_and_no_one_elses() {
    let Some(url) = server() else {
        return;
    };
    let (session, handle) = tab(&url);
    thread::sleep(Duration::from_millis(300));

    let listed = tool(&url, "dev-token", "list_live_sessions", json!({}));
    let sessions = listed["structuredContent"]["sessions"]
        .as_array()
        .unwrap()
        .clone();
    assert!(sessions
        .iter()
        .any(|s| s["session"] == session.as_str() && s["title"] == "Brochure"));

    let ran = tool(
        &url,
        "dev-token",
        "run_script",
        json!({ "source": "paged.pages()", "session": session }),
    );
    assert_eq!(ran["isError"], false, "{ran}");
    assert_eq!(ran["structuredContent"]["args"]["source"], "paged.pages()");
    assert!(ran["structuredContent"]["agent"]
        .as_str()
        .unwrap()
        .starts_with("agent:"));
    let page = tool(
        &url,
        "dev-token",
        "render_page",
        json!({ "page": 1, "session": session }),
    );
    assert_eq!(page["content"][0]["type"], "image");

    // Another person's model sees no tab and cannot call this one.
    let theirs = tool(&url, "other-token", "list_live_sessions", json!({}));
    assert!(!theirs["structuredContent"]["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .any(|s| s["session"] == session.as_str()));
    let refused = tool(
        &url,
        "other-token",
        "run_script",
        json!({ "source": "1", "session": session }),
    );
    assert_eq!(refused["isError"], true);
    assert!(refused["content"][0]["text"]
        .as_str()
        .unwrap()
        .contains("someone else"));

    // A forged ticket opens nothing.
    let forged = tungstenite::connect(format!(
        "{}/v1/live/{session}/ws?ticket=x.y",
        url.replace("http://", "ws://")
    ));
    assert!(forged.is_err());

    tool(
        &url,
        "dev-token",
        "run_script",
        json!({ "source": "bye", "session": session }),
    );
    let seen = handle.join().unwrap();
    assert_eq!(seen.len(), 3, "the tab saw each call once");
    thread::sleep(Duration::from_millis(500));
    let after = tool(&url, "dev-token", "list_live_sessions", json!({}));
    assert!(
        !after["structuredContent"]["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|s| s["session"] == session.as_str()),
        "a closed tab leaves the list"
    );
}
