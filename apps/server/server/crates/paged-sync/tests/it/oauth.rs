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

//! Sign-in end to end against a running paged.server (`PAGED_SERVER_URL`; see
//! tests/it/sync.rs), with this test standing in for the identity provider on
//! 127.0.0.1:8792 — the issuer the server's local `.dev.vars` names. It walks
//! the flow an MCP client walks: discover, register, authorize (PKCE), follow
//! the provider round trip, exchange the code, call the API, refresh.

use std::collections::BTreeMap;
use std::sync::{Mutex, OnceLock};

use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use base64::Engine;
use paged_repo::{Ctx, MemoryStore, Policy, Repo};
use paged_sync::Remote;
use sha2::{Digest, Sha256};

const IDP: &str = "127.0.0.1:8792";
const CLIENT_SECRET: &str = "fake-idp-secret";
const REDIRECT: &str = "http://127.0.0.1:9999/cb";

fn s256(v: &str) -> String {
    B64.encode(Sha256::digest(v.as_bytes()))
}

fn query(url: &str) -> BTreeMap<String, String> {
    let q = url.split_once('?').map_or("", |(_, q)| q);
    url::form_urlencoded::parse(q.as_bytes())
        .into_owned()
        .collect()
}

/// The fake provider: discovery, an authorize that signs in "alice" at once,
/// and a token endpoint that checks its client secret and PKCE.
fn idp() {
    static STARTED: OnceLock<()> = OnceLock::new();
    STARTED.get_or_init(|| {
        let server = tiny_http::Server::http(IDP).expect("port 8792 is free");
        let codes: Mutex<BTreeMap<String, (String, String)>> = Mutex::new(BTreeMap::new());
        std::thread::spawn(move || {
            for mut req in server.incoming_requests() {
                let url = req.url().to_string();
                let json = |v: serde_json::Value| {
                    tiny_http::Response::from_string(v.to_string()).with_header(
                        "content-type: application/json"
                            .parse::<tiny_http::Header>()
                            .unwrap(),
                    )
                };
                if url.starts_with("/.well-known/openid-configuration") {
                    let _ = req.respond(json(serde_json::json!({
                        "issuer": format!("http://{IDP}"),
                        "authorization_endpoint": format!("http://{IDP}/authorize"),
                        "token_endpoint": format!("http://{IDP}/token"),
                    })));
                } else if url.starts_with("/authorize") {
                    let q = query(&url);
                    let code = format!("idp-{}", codes.lock().unwrap().len());
                    codes.lock().unwrap().insert(
                        code.clone(),
                        (q["nonce"].clone(), q["code_challenge"].clone()),
                    );
                    let to = format!("{}?code={code}&state={}", q["redirect_uri"], q["state"]);
                    let _ = req.respond(
                        tiny_http::Response::empty(302).with_header(
                            format!("location: {to}")
                                .parse::<tiny_http::Header>()
                                .unwrap(),
                        ),
                    );
                } else if url.starts_with("/token") {
                    let mut body = String::new();
                    req.as_reader().read_to_string(&mut body).unwrap();
                    let f: BTreeMap<String, String> = url::form_urlencoded::parse(body.as_bytes())
                        .into_owned()
                        .collect();
                    let entry = codes.lock().unwrap().remove(&f["code"]);
                    let ok = f["client_secret"] == CLIENT_SECRET
                        && entry
                            .as_ref()
                            .is_some_and(|(_, ch)| *ch == s256(&f["code_verifier"]));
                    if !ok {
                        let _ = req.respond(
                            json(serde_json::json!({ "error": "invalid_grant" }))
                                .with_status_code(400),
                        );
                        continue;
                    }
                    let claims = serde_json::json!({
                        "iss": format!("http://{IDP}"), "aud": f["client_id"], "sub": "alice",
                        "exp": 4_000_000_000u64, "nonce": entry.unwrap().0,
                    });
                    let id_token = format!("e30.{}.unsigned", B64.encode(claims.to_string()));
                    let _ = req.respond(json(
                        serde_json::json!({ "id_token": id_token, "token_type": "Bearer" }),
                    ));
                } else {
                    let _ = req.respond(tiny_http::Response::empty(404));
                }
            }
        });
    });
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new().redirects(0).build()
}

fn location(r: &ureq::Response) -> String {
    assert_eq!(r.status(), 302, "expected a redirect from {}", r.get_url());
    r.header("location").expect("a location").to_string()
}

/// Registers a client and signs in, returning (client_id, code, verifier).
fn sign_in(url: &str) -> (String, String, String) {
    let reg: serde_json::Value = ureq::post(&format!("{url}/oauth/register"))
        .send_json(serde_json::json!({ "client_name": "test", "redirect_uris": [REDIRECT] }))
        .unwrap()
        .into_json()
        .unwrap();
    let client_id = reg["client_id"].as_str().unwrap().to_string();
    let verifier = "a-verifier-that-is-at-least-forty-three-characters-long".to_string();
    let a = agent();
    let start = format!(
        "{url}/oauth/authorize?response_type=code&client_id={client_id}&redirect_uri={}&code_challenge={}&code_challenge_method=S256&state=xyz&scope=paged",
        url::form_urlencoded::byte_serialize(REDIRECT.as_bytes()).collect::<String>(),
        s256(&verifier),
    );
    let to_idp = location(&a.get(&start).call().unwrap());
    assert!(to_idp.starts_with(&format!("http://{IDP}/authorize")));
    let to_callback = location(&a.get(&to_idp).call().unwrap());
    let to_client = location(&a.get(&to_callback).call().unwrap());
    assert!(to_client.starts_with(REDIRECT), "{to_client}");
    let q = query(&to_client);
    assert_eq!(q["state"], "xyz", "the client's state comes back");
    (client_id, q["code"].clone(), verifier)
}

fn exchange(url: &str, form: &[(&str, &str)]) -> Result<serde_json::Value, (u16, String)> {
    match ureq::post(&format!("{url}/oauth/token")).send_form(form) {
        Ok(r) => Ok(r.into_json().unwrap()),
        Err(ureq::Error::Status(s, r)) => Err((s, r.into_string().unwrap())),
        Err(e) => panic!("{e}"),
    }
}

/// `PAGED_SERVER_URL`, or `None` after reporting the server unavailable
/// (`PAGED_REQUIRE_SERVER=1` makes that a failure).
fn server() -> Option<String> {
    paged_test_resources::env_var(paged_test_resources::Resource::Server, "PAGED_SERVER_URL")
}

#[test]
#[ignore = "server: a running paged.server (PAGED_SERVER_URL)"]
fn an_mcp_client_signs_in_and_calls_the_api() {
    let Some(url) = server() else {
        return;
    };
    idp();

    let meta: serde_json::Value =
        ureq::get(&format!("{url}/.well-known/oauth-authorization-server"))
            .call()
            .unwrap()
            .into_json()
            .unwrap();
    assert_eq!(meta["code_challenge_methods_supported"][0], "S256");
    match ureq::get(&format!("{url}/v1/r/anything/refs")).call() {
        Err(ureq::Error::Status(401, r)) => {
            assert!(r
                .header("www-authenticate")
                .unwrap()
                .contains("oauth-protected-resource"))
        }
        other => panic!("expected 401, got {other:?}"),
    }
    let bad = ureq::post(&format!("{url}/oauth/register"))
        .send_json(serde_json::json!({ "redirect_uris": ["http://evil.example/cb"] }));
    assert!(
        matches!(bad, Err(ureq::Error::Status(400, _))),
        "plain http off loopback is refused"
    );

    let (client_id, code, verifier) = sign_in(&url);
    let form = [
        ("grant_type", "authorization_code"),
        ("code", code.as_str()),
        ("client_id", client_id.as_str()),
        ("redirect_uri", REDIRECT),
        ("code_verifier", verifier.as_str()),
    ];
    let tokens = exchange(&url, &form).unwrap();
    let access = tokens["access_token"].as_str().unwrap().to_string();
    assert_eq!(tokens["token_type"], "Bearer");
    assert!(exchange(&url, &form).is_err(), "a code is spent once");

    // The access token is an identity the API knows: alice owns what she pushes.
    let name = format!("signin-{}", std::process::id());
    let remote = Remote::new(&url, &name, &access);
    let me = Ctx::human("user:alice@127.0.0.1", 1);
    let mut repo = Repo::new(
        MemoryStore::default(),
        Ok(Policy::local("user:alice@127.0.0.1")),
    );
    let file = {
        use std::io::Write;
        let mut z = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        z.start_file("designmap.xml", zip::write::SimpleFileOptions::default())
            .unwrap();
        z.write_all(b"<Document/>").unwrap();
        z.finish().unwrap().into_inner()
    };
    repo.import(&file, "d", "main", &me).unwrap();
    remote.push(&repo, "main").unwrap();
    let log: Vec<serde_json::Value> = ureq::get(&format!("{url}/v1/r/{name}/log/main"))
        .set("authorization", &format!("Bearer {access}"))
        .call()
        .unwrap()
        .into_json()
        .unwrap();
    assert_eq!(log[0]["commit"]["author"]["id"], "user:alice@127.0.0.1");
    // The service-token user did not push this and has no role in it.
    assert!(Remote::new(&url, &name, "dev-token")
        .file("main", false)
        .is_err());

    // Refresh rotates: the new one works, the old one is spent.
    let refresh = tokens["refresh_token"].as_str().unwrap();
    let rf = [
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh),
        ("client_id", client_id.as_str()),
    ];
    let renewed = exchange(&url, &rf).unwrap();
    assert!(renewed["access_token"].is_string());
    assert!(
        exchange(&url, &rf).is_err(),
        "a refresh token is spent once"
    );

    // A forged token is no identity.
    let forged = format!("{}x", &access[..access.len() - 1]);
    assert!(Remote::new(&url, &name, &forged).refs().is_err());
}

#[test]
#[ignore = "server: a running paged.server (PAGED_SERVER_URL)"]
fn a_wrong_verifier_or_redirect_gets_no_token() {
    let Some(url) = server() else {
        return;
    };
    idp();
    let (client_id, code, _) = sign_in(&url);
    let r = exchange(
        &url,
        &[
            ("grant_type", "authorization_code"),
            ("code", code.as_str()),
            ("client_id", client_id.as_str()),
            ("redirect_uri", REDIRECT),
            (
                "code_verifier",
                "not-the-verifier-not-the-verifier-not-the-verifier",
            ),
        ],
    );
    assert!(matches!(r, Err((400, ref b)) if b.contains("invalid_grant")));
    let (client_id, code, verifier) = sign_in(&url);
    let r = exchange(
        &url,
        &[
            ("grant_type", "authorization_code"),
            ("code", code.as_str()),
            ("client_id", client_id.as_str()),
            ("redirect_uri", "http://127.0.0.1:9999/elsewhere"),
            ("code_verifier", verifier.as_str()),
        ],
    );
    assert!(matches!(r, Err((400, _))));
}
