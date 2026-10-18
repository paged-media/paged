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

//! paged.server's `/mcp` end to end (`PAGED_SERVER_URL`): a model client reads
//! a document, writes on its own branch, is refused on main, proposes; a person
//! approves and merges. The service token `dev-token` stands in for a signed-in
//! person (tests/it/oauth.rs covers signing in).

use std::io::{Cursor, Write};
use std::time::{SystemTime, UNIX_EPOCH};

use paged_repo::{Ctx, MemoryStore, Policy, Repo};
use paged_sync::Remote;
use serde_json::{json, Value};

struct Mcp {
    url: String,
    session: String,
    next: u64,
}

impl Mcp {
    fn connect(url: &str) -> Mcp {
        let resp = ureq::post(&format!("{url}/mcp"))
            .set("authorization", "Bearer dev-token")
            .send_json(json!({ "jsonrpc": "2.0", "id": 0, "method": "initialize",
                               "params": { "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": { "name": "test", "version": "0" } } }))
            .unwrap();
        let session = resp
            .header("mcp-session-id")
            .expect("a session id")
            .to_string();
        let init: Value = resp.into_json().unwrap();
        assert_eq!(init["result"]["protocolVersion"], "2025-06-18");
        let mut m = Mcp {
            url: url.to_string(),
            session,
            next: 1,
        };
        m.notify("notifications/initialized");
        m
    }

    fn notify(&mut self, method: &str) {
        let r = ureq::post(&format!("{}/mcp", self.url))
            .set("authorization", "Bearer dev-token")
            .set("mcp-session-id", &self.session)
            .send_json(json!({ "jsonrpc": "2.0", "method": method }))
            .unwrap();
        assert_eq!(r.status(), 202);
    }

    fn rpc(&mut self, method: &str, params: Value) -> Value {
        self.next += 1;
        ureq::post(&format!("{}/mcp", self.url))
            .set("authorization", "Bearer dev-token")
            .set("mcp-session-id", &self.session)
            .send_json(
                json!({ "jsonrpc": "2.0", "id": self.next, "method": method, "params": params }),
            )
            .unwrap()
            .into_json()
            .unwrap()
    }

    /// A tool's structured result, or its error text.
    fn tool(&mut self, name: &str, args: Value) -> Result<Value, String> {
        let r = self.rpc("tools/call", json!({ "name": name, "arguments": args }));
        let result = &r["result"];
        if result["isError"] == true {
            return Err(result["content"][0]["text"]
                .as_str()
                .unwrap_or("")
                .to_string());
        }
        Ok(result
            .get("structuredContent")
            .cloned()
            .unwrap_or_else(|| result["content"][0]["text"].clone()))
    }
}

fn story(text: &str) -> Vec<u8> {
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (p, b) in [
        ("designmap.xml", "<Document/>".to_string()),
        ("Stories/Story_u1.xml", format!("<Story>{text}</Story>")),
    ] {
        zip.start_file(p, zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(b.as_bytes()).unwrap();
    }
    zip.finish().unwrap().into_inner()
}

/// `PAGED_SERVER_URL`, or `None` after reporting the server unavailable
/// (`PAGED_REQUIRE_SERVER=1` makes that a failure).
fn server() -> Option<String> {
    paged_test_resources::env_var(paged_test_resources::Resource::Server, "PAGED_SERVER_URL")
}

#[test]
#[ignore = "server: a running paged.server (PAGED_SERVER_URL)"]
fn a_model_proposes_and_a_person_merges() {
    let Some(url) = server() else {
        return;
    };
    let name = format!(
        "mcp-{:x}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );

    let unauth = ureq::post(&format!("{url}/mcp"))
        .send_json(json!({ "jsonrpc": "2.0", "id": 1, "method": "ping" }));
    match unauth {
        Err(ureq::Error::Status(401, r)) => assert!(r
            .header("www-authenticate")
            .unwrap()
            .contains("resource_metadata")),
        other => panic!("expected 401, got {other:?}"),
    }

    // A person's document, pushed the ordinary way.
    let me = Ctx::human("user:dev", 1);
    let mut repo = Repo::new(MemoryStore::default(), Ok(Policy::local("user:dev")));
    repo.import(&story("Old headline"), "brochure.idml", "main", &me)
        .unwrap();
    let remote = Remote::new(&url, &name, "dev-token");
    remote.push(&repo, "main").unwrap();

    let mut mcp = Mcp::connect(&url);
    let tools = mcp.rpc("tools/list", json!({}));
    let tools = tools["result"]["tools"].as_array().unwrap();
    assert!(tools.iter().any(|t| t["name"] == "describe_document"
        && t["_meta"]["ui"]["resourceUri"] == "ui://paged/view"));

    let docs = mcp.tool("list_documents", json!({})).unwrap();
    assert!(docs["documents"]
        .as_array()
        .unwrap()
        .iter()
        .any(|d| d["name"] == name.as_str()));
    let described = mcp
        .tool("describe_document", json!({ "document": name }))
        .unwrap();
    assert!(described["parts"]
        .as_array()
        .unwrap()
        .iter()
        .any(|p| p["path"] == "Stories/Story_u1.xml"));
    let text = mcp
        .tool(
            "read_part",
            json!({ "document": name, "path": "Stories/Story_u1.xml" }),
        )
        .unwrap();
    assert_eq!(text, "<Story>Old headline</Story>");

    let branch = mcp
        .tool(
            "create_branch",
            json!({ "document": name, "name": "headline" }),
        )
        .unwrap();
    let branch = branch["ref"].as_str().unwrap().to_string();
    assert!(branch.starts_with("agent/"), "{branch}");
    mcp.tool(
        "commit_parts",
        json!({ "document": name, "branch": branch, "message": "A stronger headline",
                "parts": [{ "path": "Stories/Story_u1.xml", "text": "<Story>New headline</Story>" }] }),
    )
    .unwrap();

    // The model cannot write main, however it asks.
    let refused = mcp.tool(
        "commit_parts",
        json!({ "document": name, "branch": "main", "message": "straight in", "parts": [{ "path": "x.txt", "text": "x" }] }),
    );
    assert!(refused.unwrap_err().contains("Refused"));

    let history = mcp
        .tool("history", json!({ "document": name, "ref": branch }))
        .unwrap();
    let newest = &history["versions"][0];
    assert_eq!(newest["agent"], true);
    assert_eq!(
        newest["for"], "user:dev",
        "the agent's write names the person it acted for"
    );
    let diff = mcp
        .tool(
            "diff",
            json!({ "document": name, "from": "main", "to": branch }),
        )
        .unwrap();
    assert_eq!(diff[0]["path"], "Stories/Story_u1.xml");

    let proposed = mcp
        .tool(
            "propose_change",
            json!({ "document": name, "branch": branch, "title": "Headline" }),
        )
        .unwrap();
    let id = proposed["change_request"]["id"].as_i64().unwrap();

    // The person reviews and merges; the model cannot do that for them.
    remote.change(id, "approve").unwrap();
    let merged = remote.change(id, "merge").unwrap();
    assert_eq!(merged["status"], "merged");
    let text = mcp
        .tool(
            "read_part",
            json!({ "document": name, "path": "Stories/Story_u1.xml" }),
        )
        .unwrap();
    assert_eq!(text, "<Story>New headline</Story>");

    // A link a person can open without a token.
    let link = mcp
        .tool("download_link", json!({ "document": name }))
        .unwrap();
    let file = ureq::get(link["url"].as_str().unwrap()).call().unwrap();
    let mut bytes = Vec::new();
    std::io::Read::read_to_end(&mut file.into_reader(), &mut bytes).unwrap();
    assert_eq!(&bytes[..2], b"PK");
    let forged = format!("{}x", link["url"].as_str().unwrap());
    assert!(matches!(
        ureq::get(&forged).call(),
        Err(ureq::Error::Status(403, _))
    ));

    let api = mcp
        .tool("lookup_api", json!({ "query": "paged.set" }))
        .unwrap();
    assert!(api["matches"].as_u64().unwrap() > 0);
    // No tab, and nothing open in the headless engine (where one is configured).
    let early = mcp
        .tool("run_script", json!({ "source": "1" }))
        .unwrap_err();
    assert!(
        early.contains("No editor tab") || early.contains("open a document first"),
        "{early}"
    );
    let view = mcp.rpc("resources/read", json!({ "uri": "ui://paged/view" }));
    assert_eq!(
        view["result"]["contents"][0]["mimeType"],
        "text/html;profile=mcp-app"
    );
}
