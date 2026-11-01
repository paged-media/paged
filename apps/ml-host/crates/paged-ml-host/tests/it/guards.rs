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

use crate::support::{raw, request, Fake, TestHost};

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
        "PUT /api/ml/config HTTP/1.1\r\nHost: 127.0.0.1\r\nTransfer-Encoding: chunked\r\n\r\n{:x}\r\n{}\r\n0\r\n\r\n",
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
