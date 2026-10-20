/*
 * This file is part of paged (https://paged.media).
 *
 * paged is free software: you may redistribute it and/or modify it under the
 * terms of the GNU Affero General Public License, version 3, as published by
 * the Free Software Foundation, OR under the Paged Media Enterprise License
 * (PMEL), a commercial license available from And The Next GmbH. Full
 * copyright and license information is available in LICENSE.md, distributed
 * with this source code.
 *
 * paged is distributed in the hope that it will be useful, but WITHOUT ANY
 * WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE. See the licenses for details.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    AGPL-3.0-only OR Paged Media Enterprise License (PMEL)
 */

//! Goldens of the container and host commands: `parts`, `library`,
//! `session` (and `paged-run`, which must answer it byte for byte),
//! `mcp` (and the MCP tool catalog) and `engine-serve`.
//!
//! The protocol commands' success goldens are their transcripts: the
//! requests sent, one reply per line, canonicalised like every other
//! JSON output (`golden.rs`).

use std::io::{Read as _, Write as _};
use std::net::{TcpListener, TcpStream};
use std::time::Duration;

use base64::Engine as _;
use paged_test_resources::{covers, skip, Resource};
use serde_json::{json, Value};

use crate::golden::{canonical, check_golden, golden_dir, Fx};

// ── parts ───────────────────────────────────────────────────────────

#[test]
fn parts() {
    covers!("cli:paged parts");
    let fx = Fx::new("parts");
    fx.help("paged parts");
    fx.run(&["parts"])
        .code(2)
        .golden("paged parts", "usage-no-subcommand");
}

#[test]
fn parts_list() {
    covers!("cli:paged parts list");
    let fx = Fx::new("parts-list");
    fx.help("paged parts list");
    fx.seeded("doc.paged");
    fx.run(&["parts", "list"])
        .code(2)
        .golden("paged parts list", "usage-no-doc");
    fx.run(&["parts", "list", "missing.paged"])
        .code(1)
        .golden("paged parts list", "input-missing-doc");
    fx.run(&["parts", "list", "doc.paged"])
        .code(0)
        .golden("paged parts list", "model-part");
    fx.run(&["parts", "list", "doc.paged", "paged/plugins/"])
        .code(0)
        .golden("paged parts list", "empty-prefix");
}

#[test]
fn parts_read() {
    covers!("cli:paged parts read");
    let fx = Fx::new("parts-read");
    fx.help("paged parts read");
    fx.seeded("doc.paged");
    fx.write("data.json", r#"{"a":1}"#);
    fx.run(&[
        "parts",
        "write",
        "doc.paged",
        "paged/tool/data.json",
        "data.json",
        "--caller",
        "tool",
        "--save",
        "w.paged",
    ])
    .code(0);
    fx.run(&["parts", "read", "w.paged"])
        .code(2)
        .golden("paged parts read", "usage-no-path");
    fx.run(&["parts", "read", "w.paged", "paged/none.json"])
        .code(1)
        .golden("paged parts read", "input-no-such-part");
    fx.run(&["parts", "read", "w.paged", "paged/tool/data.json"])
        .code(0)
        .golden("paged parts read", "json-part");
    fx.run(&[
        "parts",
        "read",
        "w.paged",
        "paged/tool/data.json",
        "-o",
        "back.json",
    ])
    .code(0)
    .golden("paged parts read", "to-file");
    assert_eq!(fx.read("back.json"), br#"{"a":1}"#);
}

#[test]
fn parts_write() {
    covers!("cli:paged parts write");
    let fx = Fx::new("parts-write");
    fx.help("paged parts write");
    fx.seeded("doc.paged");
    fx.write("data.json", r#"{"a":1}"#);
    fx.run(&["parts", "write", "doc.paged", "paged/tool/data.json"])
        .code(2)
        .golden("paged parts write", "usage-no-source");
    fx.run(&[
        "parts",
        "write",
        "doc.paged",
        "paged/tool/data.json",
        "data.json",
        "--caller",
        "other",
    ])
    .code(1)
    .golden("paged parts write", "input-caller-gate");
    fx.run(&[
        "parts",
        "write",
        "doc.paged",
        "paged/tool/x.json",
        "missing.json",
        "--caller",
        "tool",
    ])
    .code(1)
    .golden("paged parts write", "input-missing-source");
    fx.run(&[
        "parts",
        "write",
        "doc.paged",
        "paged/tool/data.json",
        "data.json",
        "--caller",
        "tool",
    ])
    .code(0)
    .golden("paged parts write", "not-saved-without-save");
    fx.run(&[
        "parts",
        "write",
        "doc.paged",
        "paged/tool/data.json",
        "data.json",
        "--caller",
        "tool",
        "--save",
        "w.paged",
    ])
    .code(0)
    .golden("paged parts write", "saved");
    fx.run(&["parts", "list", "w.paged"])
        .code(0)
        .golden("paged parts write", "listed-after-save");
}

#[test]
fn parts_delete() {
    covers!("cli:paged parts delete");
    let fx = Fx::new("parts-delete");
    fx.help("paged parts delete");
    fx.seeded("doc.paged");
    fx.write("data.json", r#"{"a":1}"#);
    fx.run(&[
        "parts",
        "write",
        "doc.paged",
        "paged/tool/data.json",
        "data.json",
        "--caller",
        "tool",
        "--save",
        "w.paged",
    ])
    .code(0);
    fx.run(&["parts", "delete", "w.paged"])
        .code(2)
        .golden("paged parts delete", "usage-no-path");
    fx.run(&[
        "parts",
        "delete",
        "w.paged",
        "paged/tool/data.json",
        "--caller",
        "other",
    ])
    .code(1)
    .golden("paged parts delete", "input-caller-gate");
    fx.run(&[
        "parts",
        "delete",
        "w.paged",
        "paged/tool/data.json",
        "--caller",
        "tool",
        "--save",
        "d.paged",
    ])
    .code(0)
    .golden("paged parts delete", "saved");
    fx.run(&["parts", "list", "d.paged", "paged/tool/"])
        .code(0)
        .golden("paged parts delete", "gone-after-save");
}

// ── library ─────────────────────────────────────────────────────────

#[test]
fn library() {
    covers!("cli:paged library");
    let fx = Fx::new("library");
    fx.help("paged library");
    fx.run(&["library"])
        .code(2)
        .golden("paged library", "usage-no-subcommand");
}

#[test]
fn library_import() {
    covers!("cli:paged library import");
    let fx = Fx::new("library-import");
    fx.help("paged library import");
    fx.seeded("brochure.paged");
    fx.write("junk.idml", "not a zip");
    fx.run(&["library", "import", "--library", "lib"])
        .code(2)
        .golden("paged library import", "usage-no-file");
    fx.run(&["library", "import", "missing.paged", "--library", "lib"])
        .code(1)
        .golden("paged library import", "input-missing-file");
    fx.run(&["library", "import", "junk.idml", "--library", "lib"])
        .code(1)
        .golden("paged library import", "input-not-a-package");
    fx.run(&[
        "library",
        "import",
        "brochure.paged",
        "--library",
        "lib",
        "--name",
        "Brochure",
    ])
    .code(1)
    .golden("paged library import", "input-bad-name");
    fx.run(&["library", "import", "brochure.paged", "--library", "lib"])
        .code(0)
        .golden("paged library import", "named-after-the-file");
    fx.run(&["library", "import", "brochure.paged", "--library", "lib"])
        .code(1)
        .golden("paged library import", "input-name-taken");
    fx.run(&[
        "library",
        "import",
        "brochure.paged",
        "--library",
        "lib",
        "--name",
        "copy-2",
    ])
    .code(0)
    .golden("paged library import", "explicit-name");
}

/// `<name>\t<head>`: the head is a content hash, masked by the golden.
#[test]
fn library_list() {
    covers!("cli:paged library list");
    let fx = Fx::new("library-list");
    fx.help("paged library list");
    fx.run(&["library", "list", "--library", "lib", "extra"])
        .code(2)
        .golden("paged library list", "usage-unexpected-argument");
    fx.run(&["library", "list", "--library", "lib"])
        .code(0)
        .golden("paged library list", "empty");
    fx.seeded("brochure.paged");
    fx.run(&["library", "import", "brochure.paged", "--library", "lib"])
        .code(0);
    fx.run(&["library", "list", "--library", "lib"])
        .code(0)
        .golden("paged library list", "one-document");
    // The default library is `$HOME/.paged/library` (HOME is the fixture).
    fx.run(&["library", "import", "brochure.paged"]).code(0);
    fx.run(&["library", "list"])
        .code(0)
        .golden("paged library list", "default-library");
    assert!(
        fx.exists(".paged/library"),
        "the default library is under HOME"
    );
    // A library whose document record is not JSON is an input error.
    fx.write("broken/repos/brochure/meta.json", "not json");
    fx.run(&["library", "list", "--library", "broken"])
        .code(1)
        .golden("paged library list", "input-corrupt-record");
}

// ── session and paged-run ───────────────────────────────────────────

/// The requests a session golden sends: the original commands, a script,
/// the refusals (an unknown command, a line that is not JSON, a backend
/// the CLI will not fake), then `quit`.
fn session_requests() -> String {
    [
        json!({"cmd": "pages"}).to_string(),
        json!({"cmd": "new-blank", "width": 200, "height": 100}).to_string(),
        json!({"cmd": "pages"}).to_string(),
        json!({"cmd": "run-script", "source": "console.log(JSON.parse(paged.pages()).length)"})
            .to_string(),
        json!({"cmd": "digest"}).to_string(),
        json!({"cmd": "render", "page": 0, "dpi": 36, "out": "p.png"}).to_string(),
        json!({"cmd": "render", "page": 0, "backend": "vello", "out": "q.png"}).to_string(),
        json!({"cmd": "export", "format": "paged", "out": "s.paged"}).to_string(),
        json!({"cmd": "nope"}).to_string(),
        "not json".to_string(),
        json!({"cmd": "quit"}).to_string(),
    ]
    .join("\n")
        + "\n"
}

#[test]
fn session() {
    covers!("cli:paged session");
    let fx = Fx::new("session");
    fx.help("paged session");
    fx.run(&["session", "extra"])
        .code(2)
        .golden("paged session", "usage-unexpected-argument");
    let input = session_requests();
    let r = fx.run_stdin(&["session"], Some(input.as_bytes())).code(0);
    let replies: Vec<Value> = r
        .stdout
        .lines()
        .map(|l| serde_json::from_str(l).expect("one JSON reply per line"))
        .collect();
    // A greeting, then one reply per request before `quit`.
    assert_eq!(replies.len(), input.lines().count(), "{}", r.stdout);
    assert_eq!(replies[0]["ready"], true);
    assert_eq!(
        replies[1]["ok"], false,
        "pages before a document is refused"
    );
    assert_eq!(
        replies[2]["pageIds"].as_array().map(Vec::len),
        Some(1),
        "new-blank"
    );
    assert!(replies[3]["pages"].is_array(), "pages after a document");
    assert!(fx.path("p.png").is_file(), "render wrote the page");
    assert_eq!(
        replies[7]["ok"], false,
        "the vello backend is refused, not faked"
    );
    assert!(fx.path("s.paged").is_file(), "export wrote the container");
    r.golden("paged session", "transcript");
}

#[test]
fn paged_run() {
    covers!("cli:paged-run");
    // The shim delegates; the transcript is the session's, byte for byte.
    let shim = include_str!("../../../paged-run/src/main.rs");
    assert!(
        shim.contains("paged_cli::session::run"),
        "paged-run delegates to the session"
    );
    let Some(bin) = crate::session_compat::paged_run() else {
        skip!(
            Resource::Fixtures,
            "paged-run is absent or older than the engine sources; build the whole workspace \
             (`cargo nextest run --workspace`, as CI does)"
        );
    };
    let fx = Fx::new("paged-run");
    let input = session_requests();
    let via_run = fx
        .run_bin(
            "paged-run",
            bin.to_str().unwrap(),
            &[],
            Some(input.as_bytes()),
        )
        .code(0);
    let via_paged = fx.run_stdin(&["session"], Some(input.as_bytes())).code(0);
    assert_eq!(
        via_run.stdout, via_paged.stdout,
        "paged-run answers what `paged session` answers"
    );
    // The same golden file: a difference between the two binaries is a
    // golden failure here as well as an inequality above.
    let mut expected = std::fs::read_to_string(golden_dir("paged session").join("transcript.txt"))
        .unwrap_or_default();
    expected = expected.replacen("$ paged session", "$ paged-run", 1);
    assert_eq!(
        via_run.transcript(),
        expected,
        "paged-run's transcript is the session golden"
    );
}

// ── mcp ─────────────────────────────────────────────────────────────

fn rpc(id: u64, method: &str, params: Value) -> String {
    json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}).to_string()
}

#[test]
fn mcp() {
    covers!("cli:paged mcp");
    let fx = Fx::new("mcp");
    fx.help("paged mcp");
    fx.run(&["mcp", "--port", "1"])
        .code(2)
        .golden("paged mcp", "usage-unknown-flag");
    fx.seeded("brochure.paged");
    fx.run(&["library", "import", "brochure.paged", "--library", "lib"])
        .code(0);
    let input = [
        rpc(
            1,
            "initialize",
            json!({"protocolVersion": "2025-06-18", "capabilities": {}}),
        ),
        json!({"jsonrpc": "2.0", "method": "notifications/initialized"}).to_string(),
        rpc(
            2,
            "tools/call",
            json!({"name": "list_documents", "arguments": {}}),
        ),
        rpc(
            3,
            "tools/call",
            json!({"name": "no_such_tool", "arguments": {}}),
        ),
        rpc(
            4,
            "tools/call",
            json!({"name": "describe_document", "arguments": {"document": "nope"}}),
        ),
        rpc(5, "no/such/method", json!({})),
        "{not json".to_string(),
    ]
    .join("\n")
        + "\n";
    let r = fx
        .run_stdin(&["mcp", "--library", "lib"], Some(input.as_bytes()))
        .code(0);
    let replies: Vec<Value> = r
        .stdout
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    // The notification gets no answer.
    assert_eq!(replies.len(), 6, "{}", r.stdout);
    assert_eq!(replies[0]["result"]["serverInfo"]["name"], "paged (local)");
    assert_eq!(
        replies[5]["error"]["code"], -32700,
        "a line that is not JSON"
    );
    r.golden("paged mcp", "stdio-transcript");

    // The tools this host serves, with their schemas: the surface a
    // model is shown.
    let listed = fx
        .run_stdin(
            &["mcp", "--library", "lib"],
            Some((rpc(1, "tools/list", json!({})) + "\n").as_bytes()),
        )
        .code(0);
    let names: Vec<String> = listed.json()["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap().to_string())
        .collect();
    assert!(names.contains(&"run_script".to_string()));
    assert!(
        !names.contains(&"list_live_sessions".to_string()),
        "no live sessions without a server"
    );
    listed.golden("paged mcp", "tools-list");

    // And the whole catalog, every host's tools, as paged-mcp declares it.
    let catalog: Vec<Value> = paged_mcp::tools::catalog()
        .iter()
        .map(|t| t.to_json())
        .collect();
    let text =
        serde_json::to_string_pretty(&canonical(&Value::Array(catalog), None)).unwrap() + "\n";
    check_golden(&golden_dir("paged mcp").join("tool-catalog.txt"), &text);
}

// ── engine-serve ────────────────────────────────────────────────────

fn free_port() -> u16 {
    TcpListener::bind(("127.0.0.1", 0))
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .expect("a free port")
}

fn post(port: u16, body: &str) -> (u16, Value) {
    let mut s = TcpStream::connect(("127.0.0.1", port)).expect("connect");
    write!(
        s,
        "POST /run HTTP/1.1\r\nhost: x\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{body}",
        body.len()
    )
    .unwrap();
    let mut out = String::new();
    let _ = s.read_to_string(&mut out);
    // No status line at all is status 0: the server closed without one.
    let status: u16 = out
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    let body = out
        .split_once("\r\n\r\n")
        .map(|(_, b)| b)
        .unwrap_or_default();
    (
        status,
        serde_json::from_str(body).unwrap_or(Value::String(body.to_string())),
    )
}

#[test]
fn engine_serve() {
    covers!("cli:paged engine-serve");
    let fx = Fx::new("engine-serve");
    fx.help("paged engine-serve");
    fx.run(&["engine-serve", "--port", "http"])
        .code(2)
        .golden("paged engine-serve", "usage-port-not-a-number");
    // A port somebody holds: the bind fails, exit 1.
    let held = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = held.local_addr().unwrap().port().to_string();
    fx.run(&["engine-serve", "--port", &port])
        .code(1)
        .mask(&port, "<PORT>")
        .golden("paged engine-serve", "input-port-in-use");
    drop(held);

    // Success: serve, take one call, answer it.
    fx.blank("blank.paged");
    let port = free_port();
    let mut child = fx
        .command(
            env!("CARGO_BIN_EXE_paged"),
            &["engine-serve", "--port", &port.to_string()],
        )
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .expect("spawn engine-serve");
    let mut up = false;
    for _ in 0..200 {
        if TcpStream::connect(("127.0.0.1", port)).is_ok() {
            up = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    assert!(up, "engine-serve listens on {port}");
    let b64 = base64::engine::general_purpose::STANDARD;
    let call = json!({
        "file": b64.encode(fx.read("blank.paged")),
        "script": "console.log('pages', JSON.parse(paged.pages()).length)",
    });
    let (ok_status, ok) = post(port, &call.to_string());
    let (refused_status, refused) = post(port, &json!({"script": "1"}).to_string());
    let (bad_status, bad) = post(port, "{not json");
    let _ = child.kill();
    let out = child.wait_with_output().expect("wait");
    let greeting = String::from_utf8_lossy(&out.stderr)
        .lines()
        .next()
        .unwrap_or_default()
        .replace(&port.to_string(), "<PORT>");
    assert_eq!(ok_status, 200, "{ok}");
    assert_eq!(
        refused_status, 422,
        "a call without a document is refused: {refused}"
    );
    // finding CLI-9 (fixed): a body that is not JSON got no HTTP answer at
    // all. It is a 400 with a JSON error body.
    assert_eq!(bad_status, 400, "a body that is not JSON: {bad}");
    assert!(
        bad["error"]
            .as_str()
            .is_some_and(|e| e.contains("not JSON")),
        "{bad}"
    );
    let mask = |v: &Value| {
        let mut v = v.clone();
        if let Some(obj) = v.as_object_mut() {
            for key in ["file", "png", "pdf"] {
                if obj.get(key).is_some_and(Value::is_string) {
                    obj.insert(key.into(), json!("<BASE64>"));
                }
            }
        }
        serde_json::to_string_pretty(&canonical(&v, None)).unwrap()
    };
    let transcript = format!(
        "$ paged engine-serve --port <PORT>\n--- stderr (first line)\n{greeting}\n\
         --- POST /run (blank document, a script)\n{ok_status}\n{}\n\
         --- POST /run (no document)\n{refused_status}\n{}\n\
         --- POST /run (not JSON)\n{bad_status}\n{}\n",
        mask(&ok),
        mask(&refused),
        mask(&bad),
    );
    check_golden(
        &golden_dir("paged engine-serve").join("call.txt"),
        &transcript,
    );
}
