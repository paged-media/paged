/*
 * This file is part of paged (https://paged.media): paged-ml-host, the local
 * generative-image host.
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

//! The loopback guards (Host, Origin), the body cap and unknown routes.

#![allow(non_snake_case)] // the `__feat__<id>` suffix links each test to its cockpit feature

use serde_json::json;

use crate::support::{raw, request, Fake, TestHost, NO_TOKEN};

#[test]
fn forbidden_host__feat__plugin_platform_ml_service() {
    let t = TestHost::new(Fake::default());
    let port = t.addr().port();
    for host in ["evil.example", "evil.example:7861", "127.0.0.1.nip.io"] {
        let r = request(t.addr(), "GET", "/api/ml/health", &[("Host", host)], None);
        assert_eq!(r.status, 403, "{host}");
        assert_eq!(r.code(), "forbidden_host");
    }
    for host in [
        format!("127.0.0.1:{port}"),
        format!("localhost:{port}"),
        format!("[::1]:{port}"),
        "localhost".to_string(),
    ] {
        let r = request(t.addr(), "GET", "/api/ml/health", &[("Host", &host)], None);
        assert_eq!(r.status, 200, "{host}");
    }
    // No Host header at all.
    let r = raw(t.addr(), b"GET /api/ml/health HTTP/1.1\r\n\r\n");
    assert_eq!(r.status, 403);
}

#[test]
fn forbidden_origin__feat__plugin_platform_ml_service() {
    let t = TestHost::with_origins(Fake::default(), vec!["https://editor.example".into()]);
    for origin in [
        "https://evil.example",
        "http://localhost.evil.example",
        "null",
    ] {
        let r = request(
            t.addr(),
            "GET",
            "/api/ml/health",
            &[("Origin", origin)],
            None,
        );
        assert_eq!(r.status, 403, "{origin}");
        assert_eq!(r.code(), "forbidden_origin");
    }
    for origin in [
        "http://localhost:5173",
        "http://127.0.0.1:8080",
        "http://[::1]:3000",
        "https://editor.example",
    ] {
        let r = request(
            t.addr(),
            "GET",
            "/api/ml/health",
            &[("Origin", origin)],
            None,
        );
        assert_eq!(r.status, 200, "{origin}");
        assert_eq!(r.header("Access-Control-Allow-Origin"), Some(origin));
    }
}

#[test]
fn too_large_body() {
    let t = TestHost::new(Fake::default());
    let r = raw(
        t.addr(),
        format!(
            "POST /api/ml/jobs HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: {}\r\n\r\n",
            64 * 1024 * 1024 + 1
        )
        .as_bytes(),
    );
    assert_eq!(r.status, 413);
    assert_eq!(r.code(), "too_large");
}

#[test]
fn chunked_bodies_are_read() {
    let t = TestHost::new(Fake::default());
    let body = t.good_config().to_string();
    let req = format!(
        "PUT /api/ml/config HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {}\r\nTransfer-Encoding: chunked\r\n\r\n{:x}\r\n{}\r\n0\r\n\r\n",
        t.token(),
        body.len(),
        body
    );
    let r = raw(t.addr(), req.as_bytes());
    assert_eq!(r.status, 200, "{}", r.text());
}

#[test]
fn unknown_routes_and_methods() {
    let t = TestHost::new(Fake::default());
    let r = t.get("/api/ml/nope");
    assert_eq!(r.status, 404);
    assert_eq!(r.code(), "not_found");
    let r = t.delete("/api/ml/health");
    assert_eq!(r.status, 405);
    let r = t.get("/api/ml/jobs/doesnotexist");
    assert_eq!(r.status, 404);
    assert_eq!(r.code(), "no_job");
    let r = t.get("/api/ml/jobs/doesnotexist/result");
    assert_eq!(r.status, 404);
    assert_eq!(r.code(), "no_job");
    let r = t.delete("/api/ml/jobs/doesnotexist");
    assert_eq!(r.status, 404);
    let (r, ev) = crate::support::events(t.addr(), "doesnotexist");
    assert_eq!(r.status, 404);
    assert!(ev.is_empty());
}

/// Every route of the API: `(method, path, body)`.
fn routes() -> Vec<(&'static str, &'static str, Option<String>)> {
    let job = json!({ "kind": "generate", "prompt": "x", "width": 64, "height": 64 }).to_string();
    vec![
        ("GET", "/api/ml/health", None),
        ("GET", "/api/ml/config", None),
        ("PUT", "/api/ml/config", Some("{}".into())),
        ("POST", "/api/ml/jobs", Some(job)),
        ("GET", "/api/ml/jobs/j1", None),
        ("DELETE", "/api/ml/jobs/j1", None),
        ("GET", "/api/ml/jobs/j1/result", None),
        ("GET", "/api/ml/jobs/j1/events", None),
    ]
}

#[test]
fn every_route_but_health_needs_the_token() {
    let t = TestHost::new(Fake::default());
    t.configure();
    let before = t.get("/api/ml/config").json();
    let wrong = "0".repeat(64);
    let presented: [(&str, Vec<(&str, String)>); 4] = [
        ("no token", vec![(NO_TOKEN.0, NO_TOKEN.1.into())]),
        (
            "another token",
            vec![("Authorization", format!("Bearer {wrong}"))],
        ),
        (
            "a prefix of the token",
            vec![("Authorization", format!("Bearer {}", &t.token()[..32]))],
        ),
        (
            "another scheme",
            vec![("Authorization", format!("Basic {}", t.token()))],
        ),
    ];
    for (method, path, body) in routes() {
        for (what, headers) in &presented {
            let headers: Vec<(&str, &str)> =
                headers.iter().map(|(n, v)| (*n, v.as_str())).collect();
            let r = request(
                t.addr(),
                method,
                path,
                &headers,
                body.as_deref().map(str::as_bytes),
            );
            if path == "/api/ml/health" {
                assert_eq!(r.status, 200, "{method} {path} with {what}");
                continue;
            }
            assert_eq!(r.status, 401, "{method} {path} with {what}");
            assert_eq!(r.code(), "unauthorized", "{method} {path} with {what}");
            assert_eq!(r.header("WWW-Authenticate"), Some("Bearer"));
        }
    }
    // Nothing ran and nothing was stored.
    assert!(t.invocations().is_empty());
    assert_eq!(t.get("/api/ml/config").json(), before);
    assert_eq!(t.get("/api/ml/health").json()["queue"]["queued"], 0);
}

#[test]
fn every_route_refuses_a_foreign_origin() {
    let t = TestHost::new(Fake::default());
    let site_headers: [Vec<(&str, &str)>; 4] = [
        vec![("Origin", "https://evil.example")],
        vec![("Origin", "null")],
        // A browser request that names no Origin.
        vec![("Sec-Fetch-Site", "cross-site")],
        vec![("Sec-Fetch-Site", "same-site")],
    ];
    for (method, path, body) in routes() {
        for headers in &site_headers {
            // With the token: the origin guard stands on its own.
            let r = request(
                t.addr(),
                method,
                path,
                headers,
                body.as_deref().map(str::as_bytes),
            );
            assert_eq!(r.status, 403, "{method} {path} {headers:?}");
            assert_eq!(r.code(), "forbidden_origin", "{method} {path} {headers:?}");
            assert_eq!(r.header("Access-Control-Allow-Origin"), None);
        }
    }
    // A preflight from a foreign origin is refused too.
    let r = request(
        t.addr(),
        "OPTIONS",
        "/api/ml/config",
        &[("Origin", "https://evil.example")],
        None,
    );
    assert_eq!(r.status, 403);
    assert_eq!(t.get("/api/ml/config").json()["model"], json!(null));
}

#[test]
fn every_route_refuses_a_foreign_host() {
    let t = TestHost::new(Fake::default());
    for (method, path, body) in routes() {
        for host in [
            "evil.example",
            "evil.example:7861",
            "127.0.0.1.evil.example",
        ] {
            let r = request(
                t.addr(),
                method,
                path,
                &[("Host", host)],
                body.as_deref().map(str::as_bytes),
            );
            assert_eq!(r.status, 403, "{method} {path} {host}");
            assert_eq!(r.code(), "forbidden_host", "{method} {path} {host}");
        }
    }
    assert_eq!(t.get("/api/ml/config").json()["model"], json!(null));
}

#[test]
fn a_same_origin_browser_request_and_a_preflight_pass() {
    let t = TestHost::new(Fake::default());
    for site in ["same-origin", "none"] {
        let r = request(
            t.addr(),
            "GET",
            "/api/ml/config",
            &[("Sec-Fetch-Site", site)],
            None,
        );
        assert_eq!(r.status, 200, "{site}");
    }
    // A preflight carries no credentials; it allows the token's header.
    let r = request(
        t.addr(),
        "OPTIONS",
        "/api/ml/config",
        &[("Origin", "http://localhost:5173"), NO_TOKEN],
        None,
    );
    assert_eq!(r.status, 204);
    assert!(r
        .header("Access-Control-Allow-Headers")
        .is_some_and(|h| h.contains("Authorization")));
    // A refusal for want of the token is readable by an allowed origin.
    let r = request(
        t.addr(),
        "GET",
        "/api/ml/config",
        &[("Origin", "http://localhost:5173"), NO_TOKEN],
        None,
    );
    assert_eq!(r.status, 401);
    assert_eq!(
        r.header("Access-Control-Allow-Origin"),
        Some("http://localhost:5173")
    );
}

#[test]
fn the_token_is_written_for_the_user_alone_and_removed_at_shutdown() {
    let mut t = TestHost::new(Fake::default());
    let path = t.config_path.with_extension("token");
    assert_eq!(std::fs::read_to_string(&path).unwrap().trim(), t.token());
    assert_eq!(t.token().len(), 64);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }
    t.host.take().unwrap().shutdown();
    assert!(!path.exists());
}

#[test]
fn a_supplied_token_is_used_and_not_written() {
    let dir = std::env::temp_dir().join(format!("paged-ml-host-test-token-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let options = |token: &str| paged_ml_host::Options {
        port: 0,
        config_path: dir.join("ml-host.json"),
        sd_binary: None,
        allow_origins: Vec::new(),
        token: Some(token.into()),
        work_parent: Some(dir.join("work")),
        keep_finished: 4,
    };
    assert!(paged_ml_host::start(options("too-short")).is_err());
    let token = "s".repeat(40);
    let host = paged_ml_host::start(options(&token)).unwrap();
    assert!(host.token_file().is_none());
    assert!(!dir.join("ml-host.token").exists());
    let auth = format!("Bearer {token}");
    let r = request(
        host.addr(),
        "GET",
        "/api/ml/config",
        &[("Authorization", &auth)],
        None,
    );
    assert_eq!(r.status, 200);
    let r = request(host.addr(), "GET", "/api/ml/config", &[], None);
    assert_eq!(r.status, 401);
    host.shutdown();
    let _ = std::fs::remove_dir_all(&dir);
}
