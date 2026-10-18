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

//! The headless lane end to end: no editor tab, the engine is `paged
//! engine-serve` (the server's PAGED_ENGINE_URL; locally on 127.0.0.1:8793).
//! Needs PAGED_SERVER_URL and PAGED_BIN (the core `paged` binary, to make the
//! document); skipped without them.

use std::time::{SystemTime, UNIX_EPOCH};

use paged_repo::{Ctx, MemoryStore, Policy, Repo};
use paged_sync::Remote;
use serde_json::{json, Value};

struct Mcp {
    url: String,
    token: String,
    session: String,
}

impl Mcp {
    fn connect(url: &str, token: &str) -> Mcp {
        let r = ureq::post(&format!("{url}/mcp"))
            .set("authorization", &format!("Bearer {token}"))
            .send_json(json!({ "jsonrpc": "2.0", "id": 0, "method": "initialize", "params": { "protocolVersion": "2025-06-18", "capabilities": {} } }))
            .unwrap();
        let session = r.header("mcp-session-id").unwrap().to_string();
        Mcp {
            url: url.into(),
            token: token.into(),
            session,
        }
    }

    fn as_other(&self, token: &str) -> Mcp {
        Mcp {
            url: self.url.clone(),
            token: token.into(),
            session: self.session.clone(),
        }
    }

    fn tool(&self, name: &str, args: Value) -> Value {
        let r: Value = ureq::post(&format!("{}/mcp", self.url))
            .set("authorization", &format!("Bearer {}", self.token))
            .set("mcp-session-id", &self.session)
            .send_json(json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": name, "arguments": args } }))
            .unwrap()
            .into_json()
            .unwrap();
        r["result"].clone()
    }
}

#[test]
fn a_model_scripts_renders_and_saves_with_no_tab_open() {
    let (Ok(url), Ok(bin)) = (
        std::env::var("PAGED_SERVER_URL"),
        std::env::var("PAGED_BIN"),
    ) else {
        return;
    };
    let dir = std::env::temp_dir().join(format!("paged-headless-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("d.paged");
    assert!(std::process::Command::new(&bin)
        .args(["new", "--size", "a5", "--out"])
        .arg(&file)
        .status()
        .unwrap()
        .success());
    let name = format!(
        "hl-{:x}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    let me = Ctx::human("user:dev", 1);
    let mut repo = Repo::new(MemoryStore::default(), Ok(Policy::local("user:dev")));
    repo.import(&std::fs::read(&file).unwrap(), "d.paged", "main", &me)
        .unwrap();
    let remote = Remote::new(&url, &name, "dev-token");
    remote.push(&repo, "main").unwrap();

    let mcp = Mcp::connect(&url, "dev-token");
    let opened = mcp.tool("open_document", json!({ "document": name }));
    assert_eq!(opened["isError"], false, "{opened}");
    assert_eq!(opened["structuredContent"]["engine"], "headless");

    let script = r#"
        const p = paged.pages(); const list = typeof p === "string" ? JSON.parse(p) : p;
        paged.insertTextFrame(list[0].selfId, [72, 72, 200, 300]);
        console.log("pages:" + list.length);
    "#;
    let ran = mcp.tool("run_script", json!({ "source": script }));
    assert_eq!(ran["isError"], false, "{ran}");
    assert!(ran["structuredContent"]["output"]
        .to_string()
        .contains("pages:1"));
    let page = mcp.tool("render_page", json!({ "page": 1 }));
    assert_eq!(page["content"][0]["type"], "image");

    // Someone else cannot drive this run's working copy.
    let theirs = mcp
        .as_other("other-token")
        .tool("run_script", json!({ "source": "1" }));
    assert_eq!(theirs["isError"], true);

    let saved = mcp.tool("save_document", json!({ "message": "A frame" }));
    assert_eq!(saved["isError"], false, "{saved}");
    let branch = saved["structuredContent"]["saved"]["ref"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(branch.ends_with("/headless"));
    let refs = remote.refs().unwrap();
    assert_eq!(
        refs["main"],
        repo.head("main").unwrap(),
        "main has not moved"
    );
    let history = mcp.tool("history", json!({ "document": name, "ref": branch }));
    let newest = &history["structuredContent"]["versions"][0];
    assert_eq!(newest["agent"], true);
    assert_eq!(newest["for"], "user:dev");
    let _ = std::fs::remove_dir_all(&dir);
}
