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

//! Sign-in: paged.server is an OAuth 2.1 authorization server for its clients
//! (an MCP client such as Claude, the editor, the CLI) and delegates who-you-are
//! to an upstream OpenID Connect provider.
//!
//! - Discovery: RFC 8414 (`/.well-known/oauth-authorization-server`) and
//!   RFC 9728 (`/.well-known/oauth-protected-resource`), which a 401 names.
//! - Clients register dynamically (RFC 7591) and are public: PKCE S256 only,
//!   redirect URIs matched exactly, https or loopback.
//! - Upstream: the provider's discovery document; authorization code + PKCE +
//!   nonce. Its ID token arrives from its token endpoint over TLS with our
//!   client secret, so (OIDC Core 3.1.3.7) issuer, audience, expiry and nonce
//!   are checked and the signature is not: there is no JWKS code here.
//! - Tokens: access tokens are signed (HMAC) and live an hour, so checking one
//!   needs no lookup; refresh tokens live in the auth object and rotate on use.
//!
//! The actor a sign-in yields is `user:<sub>@<issuer host>`.

use serde_json::{json, Value};
use worker::{Env, Fetch, Headers, Method, Request, RequestInit, Response, Result, Url};

use crate::auth_object::call;
use crate::crypto::{b64, hmac, hmac_ok, random, s256, sha256_hex, unb64};

const ACCESS_TTL: i64 = 3600;
const REFRESH_TTL: i64 = 30 * 24 * 3600;
const CODE_TTL: i64 = 120;
const PENDING_TTL: i64 = 600;
const TOKEN_PREFIX: &str = "pat1.";

pub struct Config {
    issuer: String,
    client_id: String,
    client_secret: String,
    secret: Vec<u8>,
}

impl Config {
    /// Everything sign-in needs, or None: then every sign-in route answers 503.
    pub fn from(env: &Env) -> Option<Config> {
        let var = |k: &str| {
            env.var(k)
                .ok()
                .map(|v| v.to_string())
                .filter(|v| !v.is_empty())
        };
        let secret = |k: &str| {
            env.secret(k)
                .ok()
                .map(|v| v.to_string())
                .filter(|v| !v.is_empty())
        };
        let token_secret = secret("PAGED_TOKEN_SECRET")?;
        if token_secret.len() < 32 {
            return None;
        }
        Some(Config {
            issuer: var("OIDC_ISSUER")?.trim_end_matches('/').to_string(),
            client_id: var("OIDC_CLIENT_ID")?,
            client_secret: secret("OIDC_CLIENT_SECRET")?,
            secret: token_secret.into_bytes(),
        })
    }
}

pub fn origin(url: &Url) -> String {
    url.origin().ascii_serialization()
}

fn now_s() -> i64 {
    (worker::Date::now().as_millis() / 1000) as i64
}

fn json_no_store(v: &Value, status: u16) -> Result<Response> {
    let mut r = Response::from_json(v)?.with_status(status);
    r.headers_mut().set("cache-control", "no-store")?;
    Ok(r)
}

/// An OAuth error response (RFC 6749 §5.2), the shape OAuth clients expect.
fn oauth_error(error: &str, description: &str) -> Result<Response> {
    json_no_store(
        &json!({ "error": error, "error_description": description }),
        400,
    )
}

pub fn authorization_server_metadata(url: &Url) -> Result<Response> {
    let o = origin(url);
    Response::from_json(&json!({
        "issuer": o,
        "authorization_endpoint": format!("{o}/oauth/authorize"),
        "token_endpoint": format!("{o}/oauth/token"),
        "registration_endpoint": format!("{o}/oauth/register"),
        "response_types_supported": ["code"],
        "grant_types_supported": ["authorization_code", "refresh_token"],
        "code_challenge_methods_supported": ["S256"],
        "token_endpoint_auth_methods_supported": ["none"],
        "scopes_supported": ["paged"],
    }))
}

pub fn protected_resource_metadata(url: &Url) -> Result<Response> {
    let o = origin(url);
    Response::from_json(&json!({
        "resource": o,
        "authorization_servers": [o],
        "bearer_methods_supported": ["header"],
        "scopes_supported": ["paged"],
    }))
}

/// `WWW-Authenticate` for a 401: where a client learns how to sign in.
pub fn challenge(url: &Url) -> String {
    format!(
        r#"Bearer resource_metadata="{}/.well-known/oauth-protected-resource""#,
        origin(url)
    )
}

fn redirect_ok(uri: &str) -> bool {
    let Ok(u) = Url::parse(uri) else { return false };
    let loopback = matches!(
        u.host_str(),
        Some("127.0.0.1") | Some("localhost") | Some("[::1]")
    );
    u.fragment().is_none() && (u.scheme() == "https" || (u.scheme() == "http" && loopback))
}

pub async fn register(mut req: Request, env: &Env) -> Result<Response> {
    let body: Value = match req.json().await {
        Ok(b) => b,
        Err(_) => return oauth_error("invalid_client_metadata", "a JSON body is required"),
    };
    let uris: Vec<String> = body["redirect_uris"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    if uris.is_empty() || !uris.iter().all(|u| redirect_ok(u)) {
        return json_no_store(
            &json!({ "error": "invalid_redirect_uri", "error_description": "https or loopback, no fragment" }),
            400,
        );
    }
    let client_id = random(16);
    let name = body["client_name"]
        .as_str()
        .unwrap_or("")
        .chars()
        .take(100)
        .collect::<String>();
    let record = json!({ "redirect_uris": uris, "client_name": name });
    // Registrations do not expire on their own; a year is a backstop.
    call(
        env,
        "put",
        "client",
        &client_id,
        record.clone(),
        365 * 24 * 3600,
    )
    .await?;
    json_no_store(
        &json!({
            "client_id": client_id,
            "client_name": name,
            "redirect_uris": uris,
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
            "token_endpoint_auth_method": "none",
        }),
        201,
    )
}

async fn discovery(cfg: &Config) -> Result<Value> {
    let url = Url::parse(&format!("{}/.well-known/openid-configuration", cfg.issuer))?;
    let mut r = Fetch::Url(url).send().await?;
    if r.status_code() != 200 {
        return Err(format!("identity provider discovery answered {}", r.status_code()).into());
    }
    r.json().await
}

pub async fn authorize(req: Request, env: &Env, cfg: &Config) -> Result<Response> {
    let url = req.url()?;
    let q: std::collections::BTreeMap<String, String> = url.query_pairs().into_owned().collect();
    let get = |k: &str| q.get(k).cloned().unwrap_or_default();
    let (client_id, redirect_uri) = (get("client_id"), get("redirect_uri"));
    let client = call(env, "get", "client", &client_id, Value::Null, 0).await?;
    let registered = client["redirect_uris"]
        .as_array()
        .is_some_and(|a| a.iter().any(|u| u.as_str() == Some(redirect_uri.as_str())));
    // Never redirect to an unverified URI: an error goes to the screen.
    if client.is_null() || !registered {
        return crate::problem::problem(
            400,
            "Unknown client or redirect URI",
            "register the client first",
        );
    }
    let back = |error: &str| -> Result<Response> {
        let mut u = Url::parse(&redirect_uri)?;
        u.query_pairs_mut()
            .append_pair("error", error)
            .append_pair("state", &get("state"));
        Response::redirect(u)
    };
    if get("response_type") != "code" {
        return back("unsupported_response_type");
    }
    if get("code_challenge_method") != "S256" || get("code_challenge").len() < 43 {
        return back("invalid_request");
    }

    let upstream = discovery(cfg).await?;
    let Some(endpoint) = upstream["authorization_endpoint"].as_str() else {
        return crate::problem::problem(502, "Identity provider", "no authorization endpoint");
    };
    let (state, nonce, verifier) = (random(24), random(24), random(32));
    let pending = json!({
        "client_id": client_id, "redirect_uri": redirect_uri,
        "code_challenge": get("code_challenge"), "state": get("state"), "scope": get("scope"),
        "nonce": nonce, "verifier": verifier,
    });
    call(env, "put", "pending", &state, pending, PENDING_TTL).await?;
    let mut to = Url::parse(endpoint)?;
    to.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", &cfg.client_id)
        .append_pair("redirect_uri", &format!("{}/oauth/callback", origin(&url)))
        .append_pair("scope", "openid")
        .append_pair("state", &state)
        .append_pair("nonce", &nonce)
        .append_pair("code_challenge", &s256(&verifier))
        .append_pair("code_challenge_method", "S256");
    Response::redirect(to)
}

fn id_token_claims(id_token: &str) -> Option<Value> {
    let payload = id_token.split('.').nth(1)?;
    serde_json::from_slice(&unb64(payload)?).ok()
}

pub async fn callback(req: Request, env: &Env, cfg: &Config) -> Result<Response> {
    let url = req.url()?;
    let q: std::collections::BTreeMap<String, String> = url.query_pairs().into_owned().collect();
    let pending = call(
        env,
        "take",
        "pending",
        q.get("state").map_or("", |s| s),
        Value::Null,
        0,
    )
    .await?;
    if pending.is_null() {
        return crate::problem::problem(400, "Sign-in expired", "start again from the client");
    }
    let s = |k: &str| pending[k].as_str().unwrap_or("").to_string();
    let back = |params: &[(&str, &str)]| -> Result<Response> {
        let mut u = Url::parse(&s("redirect_uri"))?;
        {
            let mut qp = u.query_pairs_mut();
            for (k, v) in params {
                qp.append_pair(k, v);
            }
            qp.append_pair("state", &s("state"));
        }
        Response::redirect(u)
    };
    let Some(code) = q.get("code") else {
        return back(&[("error", "access_denied")]);
    };

    let upstream = discovery(cfg).await?;
    let Some(token_endpoint) = upstream["token_endpoint"].as_str() else {
        return crate::problem::problem(502, "Identity provider", "no token endpoint");
    };
    let form: String = worker::url::form_urlencoded::Serializer::new(String::new())
        .append_pair("grant_type", "authorization_code")
        .append_pair("code", code)
        .append_pair("redirect_uri", &format!("{}/oauth/callback", origin(&url)))
        .append_pair("client_id", &cfg.client_id)
        .append_pair("client_secret", &cfg.client_secret)
        .append_pair("code_verifier", &s("verifier"))
        .finish();
    let headers = Headers::new();
    headers.set("content-type", "application/x-www-form-urlencoded")?;
    headers.set("accept", "application/json")?;
    let mut init = RequestInit::new();
    init.with_method(Method::Post)
        .with_headers(headers)
        .with_body(Some(form.into()));
    let mut resp = Fetch::Request(Request::new_with_init(token_endpoint, &init)?)
        .send()
        .await?;
    let tokens: Value = resp.json().await.unwrap_or(Value::Null);
    let claims = tokens["id_token"]
        .as_str()
        .and_then(id_token_claims)
        .unwrap_or(Value::Null);

    let aud_ok = match &claims["aud"] {
        Value::String(a) => a == &cfg.client_id,
        Value::Array(a) => a.iter().any(|v| v.as_str() == Some(cfg.client_id.as_str())),
        _ => false,
    };
    let valid = claims["iss"].as_str().map(|i| i.trim_end_matches('/'))
        == Some(cfg.issuer.as_str())
        && aud_ok
        && claims["exp"].as_i64().is_some_and(|e| e > now_s())
        && claims["nonce"].as_str() == Some(s("nonce").as_str())
        && claims["sub"].as_str().is_some_and(|s| !s.is_empty());
    if !valid {
        return back(&[
            ("error", "access_denied"),
            (
                "error_description",
                "the identity provider's answer did not check out",
            ),
        ]);
    }
    let host = Url::parse(&cfg.issuer)
        .ok()
        .and_then(|u| u.host_str().map(String::from))
        .unwrap_or_default();
    let actor = format!("user:{}@{}", claims["sub"].as_str().unwrap_or(""), host);

    let ours = random(32);
    let grant = json!({
        "client_id": s("client_id"), "redirect_uri": s("redirect_uri"),
        "code_challenge": s("code_challenge"), "scope": s("scope"), "actor": actor,
    });
    call(env, "put", "code", &ours, grant, CODE_TTL).await?;
    back(&[("code", &ours)])
}

/// A signed access token: `pat1.<claims>.<hmac>`.
fn mint_access(cfg: &Config, actor: &str, client_id: &str, scope: &str) -> String {
    let claims =
        json!({ "sub": actor, "cid": client_id, "scope": scope, "exp": now_s() + ACCESS_TTL });
    let body = b64(claims.to_string().as_bytes());
    let tag = b64(&hmac(&cfg.secret, body.as_bytes()));
    format!("{TOKEN_PREFIX}{body}.{tag}")
}

/// The actor and client a signed access token names, if it is genuine and current.
pub fn verify_access(cfg: &Config, token: &str) -> Option<(String, String)> {
    let rest = token.strip_prefix(TOKEN_PREFIX)?;
    let (body, tag) = rest.split_once('.')?;
    if !hmac_ok(&cfg.secret, body.as_bytes(), &unb64(tag)?) {
        return None;
    }
    let claims: Value = serde_json::from_slice(&unb64(body)?).ok()?;
    if claims["exp"].as_i64()? <= now_s() {
        return None;
    }
    Some((
        claims["sub"].as_str()?.to_string(),
        claims["cid"].as_str().unwrap_or("").to_string(),
    ))
}

/// A signed, short-lived download link: `{origin}/v1/dl/<claims>.<hmac>`.
pub fn mint_link(
    cfg: &Config,
    origin: &str,
    object: &str,
    workspace: Option<&str>,
    reference: &str,
    actor: &str,
) -> String {
    let claims =
        json!({ "o": object, "w": workspace, "r": reference, "a": actor, "exp": now_s() + 600 });
    let body = b64(claims.to_string().as_bytes());
    let tag = b64(&hmac(&cfg.secret, format!("dl.{body}").as_bytes()));
    format!("{origin}/v1/dl/{body}.{tag}")
}

/// What a download link names, if genuine and current: (object, workspace, ref, actor).
pub fn verify_link(cfg: &Config, token: &str) -> Option<(String, Option<String>, String, String)> {
    let (body, tag) = token.split_once('.')?;
    if !hmac_ok(&cfg.secret, format!("dl.{body}").as_bytes(), &unb64(tag)?) {
        return None;
    }
    let c: Value = serde_json::from_slice(&unb64(body)?).ok()?;
    if c["exp"].as_i64()? <= now_s() {
        return None;
    }
    Some((
        c["o"].as_str()?.to_string(),
        c["w"].as_str().map(String::from),
        c["r"].as_str()?.to_string(),
        c["a"].as_str()?.to_string(),
    ))
}

async fn issue(
    env: &Env,
    cfg: &Config,
    actor: &str,
    client_id: &str,
    scope: &str,
) -> Result<Response> {
    let refresh = random(32);
    let record = json!({ "actor": actor, "client_id": client_id, "scope": scope });
    call(
        env,
        "put",
        "refresh",
        &sha256_hex(refresh.as_bytes()),
        record,
        REFRESH_TTL,
    )
    .await?;
    json_no_store(
        &json!({
            "access_token": mint_access(cfg, actor, client_id, scope),
            "token_type": "Bearer",
            "expires_in": ACCESS_TTL,
            "refresh_token": refresh,
            "scope": scope,
        }),
        200,
    )
}

pub async fn token(mut req: Request, env: &Env, cfg: &Config) -> Result<Response> {
    let body = req.text().await?;
    let form: std::collections::BTreeMap<String, String> =
        worker::url::form_urlencoded::parse(body.as_bytes())
            .into_owned()
            .collect();
    let get = |k: &str| form.get(k).cloned().unwrap_or_default();
    match get("grant_type").as_str() {
        "authorization_code" => {
            let grant = call(env, "take", "code", &get("code"), Value::Null, 0).await?;
            if grant.is_null() {
                return oauth_error("invalid_grant", "unknown, expired or already used code");
            }
            let s = |k: &str| grant[k].as_str().unwrap_or("").to_string();
            if s("client_id") != get("client_id") || s("redirect_uri") != get("redirect_uri") {
                return oauth_error(
                    "invalid_grant",
                    "the code was issued to another client or redirect",
                );
            }
            if s256(&get("code_verifier")) != s("code_challenge") {
                return oauth_error("invalid_grant", "PKCE verification failed");
            }
            issue(env, cfg, &s("actor"), &s("client_id"), &s("scope")).await
        }
        "refresh_token" => {
            let key = sha256_hex(get("refresh_token").as_bytes());
            let record = call(env, "take", "refresh", &key, Value::Null, 0).await?;
            if record.is_null() || record["client_id"].as_str() != Some(get("client_id").as_str()) {
                return oauth_error(
                    "invalid_grant",
                    "unknown, expired or already used refresh token",
                );
            }
            let s = |k: &str| record[k].as_str().unwrap_or("").to_string();
            issue(env, cfg, &s("actor"), &s("client_id"), &s("scope")).await
        }
        _ => oauth_error(
            "unsupported_grant_type",
            "authorization_code or refresh_token",
        ),
    }
}
