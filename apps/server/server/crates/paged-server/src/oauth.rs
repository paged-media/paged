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
//!   redirect URIs matched exactly, https or loopback. Anyone can register a
//!   client, so a registration earns nothing by itself: after the provider has
//!   said who is signing in, that person is asked whether this client, at this
//!   redirect address, may act for them (`/oauth/consent`). Only a yes mints
//!   a code.
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
const CONSENT_TTL: i64 = 300;
/// What one registration may hold.
const MAX_REDIRECT_URIS: usize = 8;
const MAX_REDIRECT_URI_LEN: usize = 2048;
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

/// Whether a client may register `uri`: https, or http on loopback; no
/// fragment, no user or password, no wildcard (a `*` is just a character of an
/// address nobody is redirected to unless they ask for exactly that).
fn redirect_ok(uri: &str) -> bool {
    if uri.len() > MAX_REDIRECT_URI_LEN {
        return false;
    }
    let Ok(u) = Url::parse(uri) else { return false };
    let loopback = matches!(
        u.host_str(),
        Some("127.0.0.1") | Some("localhost") | Some("[::1]")
    );
    u.fragment().is_none()
        && u.username().is_empty()
        && u.password().is_none()
        && u.host_str().is_some()
        && (u.scheme() == "https" || (u.scheme() == "http" && loopback))
}

/// Whether `uri` is one of the client's registered redirect URIs, character
/// for character: no prefix, no normalisation, no pattern.
fn redirect_registered(client: &Value, uri: &str) -> bool {
    !uri.is_empty()
        && client["redirect_uris"]
            .as_array()
            .is_some_and(|a| a.iter().any(|u| u.as_str() == Some(uri)))
}

/// The redirect URIs and display name of a registration request, or why not.
fn registration(body: &Value) -> std::result::Result<(Vec<String>, String), &'static str> {
    let Some(list) = body["redirect_uris"].as_array() else {
        return Err("redirect_uris is required");
    };
    if list.is_empty() || list.len() > MAX_REDIRECT_URIS {
        return Err("between one and eight redirect URIs");
    }
    let mut uris = Vec::new();
    for v in list {
        match v.as_str() {
            Some(u) if redirect_ok(u) => uris.push(u.to_string()),
            _ => return Err("https or loopback, no fragment, no credentials"),
        }
    }
    let name = body["client_name"]
        .as_str()
        .unwrap_or("")
        .chars()
        .filter(|c| !c.is_control())
        .take(100)
        .collect::<String>();
    Ok((uris, name))
}

pub async fn register(mut req: Request, env: &Env) -> Result<Response> {
    let body: Value = match req.json().await {
        Ok(b) => b,
        Err(_) => return oauth_error("invalid_client_metadata", "a JSON body is required"),
    };
    let (uris, name) = match registration(&body) {
        Ok(r) => r,
        Err(why) => {
            return json_no_store(
                &json!({ "error": "invalid_redirect_uri", "error_description": why }),
                400,
            )
        }
    };
    let client_id = random(16);
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
    // Never redirect to an unverified URI: an error goes to the screen.
    if client.is_null() || !redirect_registered(&client, &redirect_uri) {
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

    let Some(actor) = id_token_actor(&claims, &cfg.issuer, &cfg.client_id, &s("nonce"), now_s())
    else {
        return back(&[
            ("error", "access_denied"),
            (
                "error_description",
                "the identity provider's answer did not check out",
            ),
        ]);
    };

    // The provider said who this is. Whether this client may act for them is
    // theirs to say: nothing is minted until they do.
    let client = call(env, "get", "client", &s("client_id"), Value::Null, 0).await?;
    if !redirect_registered(&client, &s("redirect_uri")) {
        return crate::problem::problem(
            400,
            "Unknown client or redirect URI",
            "register the client first",
        );
    }
    let consent = random(32);
    let ask = json!({
        "client_id": s("client_id"), "redirect_uri": s("redirect_uri"),
        "code_challenge": s("code_challenge"), "scope": s("scope"), "state": s("state"),
        "actor": actor,
    });
    call(env, "put", "consent", &consent, ask, CONSENT_TTL).await?;
    let page = consent_page(
        client["client_name"].as_str().unwrap_or(""),
        &s("redirect_uri"),
        &actor,
        &consent,
    );
    let mut r = Response::from_html(page)?;
    let h = r.headers_mut();
    h.set("cache-control", "no-store")?;
    // The page runs nothing and loads nothing, and no other site may frame it.
    // No `form-action`: the answer to its form redirects to the client.
    h.set(
        "content-security-policy",
        "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
    )?;
    h.set("x-frame-options", "DENY")?;
    h.set("x-content-type-options", "nosniff")?;
    h.set("referrer-policy", "no-referrer")?;
    Ok(r)
}

/// The answer to the consent page. The consent id is the only way in: it was
/// shown to the signed-in person alone, lives five minutes and is spent by
/// either answer.
pub async fn consent(mut req: Request, env: &Env) -> Result<Response> {
    let url = req.url()?;
    let from = req.headers().get("origin")?;
    if !same_origin(from.as_deref(), &origin(&url)) {
        return crate::problem::problem(403, "Refused", "answer from the consent page");
    }
    let body = req.text().await?;
    let form: std::collections::BTreeMap<String, String> =
        worker::url::form_urlencoded::parse(body.as_bytes())
            .into_owned()
            .collect();
    let get = |k: &str| form.get(k).cloned().unwrap_or_default();
    let ask = call(env, "take", "consent", &get("consent"), Value::Null, 0).await?;
    if ask.is_null() {
        return crate::problem::problem(400, "Sign-in expired", "start again from the client");
    }
    let s = |k: &str| ask[k].as_str().unwrap_or("").to_string();
    let back = |params: &[(&str, &str)]| -> Result<Response> {
        let mut u = Url::parse(&s("redirect_uri"))?;
        {
            let mut qp = u.query_pairs_mut();
            for (k, v) in params {
                qp.append_pair(k, v);
            }
            qp.append_pair("state", &s("state"));
        }
        // 303: the browser follows a form's answer with a GET.
        Response::redirect_with_status(u, 303)
    };
    if get("decision") != "allow" {
        return back(&[("error", "access_denied")]);
    }
    let actor = s("actor");
    let ours = random(32);
    let grant = json!({
        "client_id": s("client_id"), "redirect_uri": s("redirect_uri"),
        "code_challenge": s("code_challenge"), "scope": s("scope"), "actor": actor,
    });
    call(env, "put", "code", &ours, grant, CODE_TTL).await?;
    back(&[("code", &ours)])
}

/// The actor an ID token's claims name — `user:<sub>@<issuer host>` — when
/// issuer, audience, expiry and nonce check out (OIDC Core 3.1.3.7).
fn id_token_actor(
    claims: &Value,
    issuer: &str,
    client_id: &str,
    nonce: &str,
    now: i64,
) -> Option<String> {
    let aud_ok = match &claims["aud"] {
        Value::String(a) => a == client_id,
        Value::Array(a) => a.iter().any(|v| v.as_str() == Some(client_id)),
        _ => false,
    };
    let sub = claims["sub"].as_str().filter(|s| !s.is_empty())?;
    let valid = claims["iss"].as_str().map(|i| i.trim_end_matches('/')) == Some(issuer)
        && aud_ok
        && claims["exp"].as_i64().is_some_and(|e| e > now)
        && !nonce.is_empty()
        && claims["nonce"].as_str() == Some(nonce);
    if !valid {
        return None;
    }
    let host = Url::parse(issuer).ok()?.host_str()?.to_string();
    Some(format!("user:{sub}@{host}"))
}

/// Whether a form post came from this server's own page. A browser names the
/// page's origin on a form post; a client that sends none is not a browser
/// carrying someone's session, and still needs the consent id.
fn same_origin(origin_header: Option<&str>, own: &str) -> bool {
    origin_header.is_none_or(|o| o == own)
}

fn html_escape(s: &str) -> String {
    // The shared XML escape, with `'` escaped too: the page's text and its
    // double-quoted attribute values both take it.
    let settings = paged_fmt::xml::AttrEscape {
        apos: true,
        ..Default::default()
    };
    paged_fmt::xml::escape_attr_with(s, settings).into_owned()
}

/// The consent page: who is signed in, which client asks, and where the
/// client's answer is sent. The name is the client's own claim; the address is
/// what was registered and matched.
fn consent_page(client_name: &str, redirect_uri: &str, actor: &str, consent: &str) -> String {
    let to = Url::parse(redirect_uri)
        .map(|u| u.origin().ascii_serialization())
        .unwrap_or_default();
    let name = if client_name.trim().is_empty() {
        "An application without a name".to_string()
    } else {
        format!("\u{201c}{}\u{201d}", html_escape(client_name.trim()))
    };
    let (to, actor, consent) = (html_escape(&to), html_escape(actor), html_escape(consent));
    format!(
        r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Allow access to your documents?</title>
<style>
body {{ font: 16px/1.5 system-ui, sans-serif; max-width: 30rem; margin: 4rem auto; padding: 0 1rem; }}
code {{ word-break: break-all; }}
button {{ font: inherit; padding: 0.5rem 1rem; margin-right: 0.5rem; }}
</style>
</head>
<body>
<h1>Allow access to your documents?</h1>
<p>{name} asks to read and change your paged documents as <code>{actor}</code>.</p>
<p>It calls itself that; what is certain is where it receives its access:
<code>{to}</code>. Allow it only if you started this from that application.</p>
<form method="post" action="/oauth/consent">
<input type="hidden" name="consent" value="{consent}">
<button type="submit" name="decision" value="deny">Deny</button>
<button type="submit" name="decision" value="allow">Allow</button>
</form>
</body>
</html>
"#
    )
}

/// `<claims>.<hmac>`: claims signed for one purpose. `purpose` goes in front
/// of what is signed, so a token of one kind never checks out as another.
fn sign(secret: &[u8], purpose: &str, claims: &Value) -> String {
    let body = b64(claims.to_string().as_bytes());
    let tag = b64(&hmac(secret, format!("{purpose}{body}").as_bytes()));
    format!("{body}.{tag}")
}

/// The claims of a `sign`ed token, if the signature is genuine for `purpose`
/// and `exp` lies after `now`. The signature is checked before anything in the
/// claims is read.
fn verified(secret: &[u8], purpose: &str, token: &str, now: i64) -> Option<Value> {
    let (body, tag) = token.split_once('.')?;
    if !hmac_ok(secret, format!("{purpose}{body}").as_bytes(), &unb64(tag)?) {
        return None;
    }
    let claims: Value = serde_json::from_slice(&unb64(body)?).ok()?;
    (claims["exp"].as_i64()? > now).then_some(claims)
}

/// A signed access token: `pat1.<claims>.<hmac>`.
fn mint_access_at(secret: &[u8], actor: &str, client_id: &str, scope: &str, now: i64) -> String {
    let claims = json!({ "sub": actor, "cid": client_id, "scope": scope, "exp": now + ACCESS_TTL });
    format!("{TOKEN_PREFIX}{}", sign(secret, "at.", &claims))
}

fn mint_access(cfg: &Config, actor: &str, client_id: &str, scope: &str) -> String {
    mint_access_at(&cfg.secret, actor, client_id, scope, now_s())
}

fn verify_access_at(secret: &[u8], token: &str, now: i64) -> Option<(String, String)> {
    let claims = verified(secret, "at.", token.strip_prefix(TOKEN_PREFIX)?, now)?;
    Some((
        claims["sub"]
            .as_str()
            .filter(|s| !s.is_empty())?
            .to_string(),
        claims["cid"].as_str().unwrap_or("").to_string(),
    ))
}

/// The actor and client a signed access token names, if it is genuine and current.
pub fn verify_access(cfg: &Config, token: &str) -> Option<(String, String)> {
    verify_access_at(&cfg.secret, token, now_s())
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
    format!("{origin}/v1/dl/{}", sign(&cfg.secret, "dl.", &claims))
}

/// What a download link names, if genuine and current: (object, workspace, ref, actor).
pub fn verify_link(cfg: &Config, token: &str) -> Option<(String, Option<String>, String, String)> {
    let c = verified(&cfg.secret, "dl.", token, now_s())?;
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

/// A one-minute ticket for an editor tab's live connection: a browser cannot
/// put a bearer token on a WebSocket, so it trades one for this first.
pub fn mint_ticket(
    cfg: &Config,
    session: &str,
    actor: &str,
    document: &str,
    title: &str,
) -> String {
    let claims =
        json!({ "s": session, "a": actor, "d": document, "t": title, "exp": now_s() + 60 });
    sign(&cfg.secret, "live.", &claims)
}

/// (session, actor, document, title) of a genuine, current ticket.
pub fn verify_ticket(cfg: &Config, ticket: &str) -> Option<(String, String, String, String)> {
    let c = verified(&cfg.secret, "live.", ticket, now_s())?;
    let s = |k: &str| c[k].as_str().unwrap_or("").to_string();
    Some((s("s"), s("a"), s("d"), s("t")))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &[u8] = b"a token secret of at least thirty-two bytes";
    const NOW: i64 = 1_800_000_000;

    #[test]
    fn a_redirect_uri_is_https_or_loopback_http() {
        for ok in [
            "https://app.example/cb",
            "https://app.example:8443/cb?x=1",
            "http://127.0.0.1:9999/cb",
            "http://localhost/cb",
            "http://[::1]:7777/cb",
        ] {
            assert!(redirect_ok(ok), "{ok}");
        }
        for bad in [
            "http://app.example/cb",
            "http://127.0.0.1.example/cb",
            "http://localhost.example/cb",
            "https://app.example/cb#fragment",
            "https://user@app.example/cb",
            "https://user:secret@app.example/cb",
            "http://user@127.0.0.1/cb",
            "app.example/cb",
            "//app.example/cb",
            "javascript:alert(1)",
            "data:text/html,x",
            "com.example.app:/cb",
            "",
        ] {
            assert!(!redirect_ok(bad), "{bad}");
        }
        let long = format!("https://app.example/{}", "a".repeat(MAX_REDIRECT_URI_LEN));
        assert!(!redirect_ok(&long));
    }

    #[test]
    fn a_redirect_uri_matches_only_itself() {
        let client =
            json!({ "redirect_uris": ["https://app.example/cb", "http://127.0.0.1:9999/cb"] });
        assert!(redirect_registered(&client, "https://app.example/cb"));
        assert!(redirect_registered(&client, "http://127.0.0.1:9999/cb"));
        for other in [
            "https://app.example/cb/",
            "https://app.example/cb?next=1",
            "https://app.example/cb/../elsewhere",
            "https://app.example/c",
            "https://app.example/",
            "https://APP.example/cb",
            "https://app.example:443/cb",
            "https://app.example.other.example/cb",
            "https://other.example/cb",
            "http://app.example/cb",
            "http://127.0.0.1:9998/cb",
            "http://127.0.0.1/cb",
            "http://localhost:9999/cb",
            "",
        ] {
            assert!(!redirect_registered(&client, other), "{other}");
        }
        // No registration, no match: an unknown client has no redirect URIs.
        assert!(!redirect_registered(&Value::Null, "https://app.example/cb"));
        assert!(!redirect_registered(&json!({}), ""));
        assert!(!redirect_registered(&json!({ "redirect_uris": [""] }), ""));
    }

    #[test]
    fn a_registration_holds_a_few_valid_redirect_uris() {
        let (uris, name) = registration(
            &json!({ "client_name": "An app", "redirect_uris": ["https://app.example/cb"] }),
        )
        .expect("a valid registration");
        assert_eq!(uris, ["https://app.example/cb"]);
        assert_eq!(name, "An app");

        assert!(registration(&json!({})).is_err());
        assert!(registration(&json!({ "redirect_uris": [] })).is_err());
        assert!(registration(&json!({ "redirect_uris": "https://app.example/cb" })).is_err());
        // One bad URI refuses the whole registration; a non-string is a bad URI.
        assert!(registration(
            &json!({ "redirect_uris": ["https://app.example/cb", "http://app.example/cb"] })
        )
        .is_err());
        assert!(registration(&json!({ "redirect_uris": ["https://app.example/cb", 7] })).is_err());
        let many: Vec<String> = (0..=MAX_REDIRECT_URIS)
            .map(|i| format!("https://app.example/cb{i}"))
            .collect();
        assert!(registration(&json!({ "redirect_uris": many })).is_err());

        let (_, name) = registration(&json!({
            "client_name": format!("line\nbreak{}", "x".repeat(200)),
            "redirect_uris": ["https://app.example/cb"],
        }))
        .unwrap();
        assert!(name.starts_with("linebreak"));
        assert_eq!(name.chars().count(), 100);
    }

    #[test]
    fn an_access_token_names_its_actor_until_it_expires() {
        let token = mint_access_at(SECRET, "user:alice@idp.example", "client-1", "paged", NOW);
        assert!(token.starts_with(TOKEN_PREFIX));
        assert_eq!(
            verify_access_at(SECRET, &token, NOW),
            Some(("user:alice@idp.example".into(), "client-1".into()))
        );
        assert!(verify_access_at(SECRET, &token, NOW + ACCESS_TTL - 1).is_some());
        assert!(verify_access_at(SECRET, &token, NOW + ACCESS_TTL).is_none());
    }

    #[test]
    fn a_forged_or_foreign_access_token_names_nobody() {
        let token = mint_access_at(SECRET, "user:alice@idp.example", "client-1", "paged", NOW);
        assert!(
            verify_access_at(b"another secret, also thirty-two bytes long", &token, NOW).is_none()
        );
        assert!(verify_access_at(SECRET, &token[TOKEN_PREFIX.len()..], NOW).is_none());
        assert!(verify_access_at(SECRET, "", NOW).is_none());
        assert!(verify_access_at(SECRET, TOKEN_PREFIX, NOW).is_none());
        assert!(verify_access_at(SECRET, "pat1.e30.", NOW).is_none());

        // Other claims under the genuine signature of the first.
        let rest = &token[TOKEN_PREFIX.len()..];
        let (_, tag) = rest.split_once('.').unwrap();
        let other = b64(
            json!({ "sub": "user:mallory@idp.example", "cid": "client-1", "exp": NOW + 60 })
                .to_string()
                .as_bytes(),
        );
        assert!(verify_access_at(SECRET, &format!("{TOKEN_PREFIX}{other}.{tag}"), NOW).is_none());

        // A changed signature, and a truncated one.
        let mut flipped = token.clone().into_bytes();
        let last = flipped.len() - 1;
        flipped[last] = if flipped[last] == b'A' { b'B' } else { b'A' };
        assert!(verify_access_at(SECRET, std::str::from_utf8(&flipped).unwrap(), NOW).is_none());
        assert!(verify_access_at(SECRET, &token[..token.len() - 4], NOW).is_none());
    }

    #[test]
    fn a_signed_token_without_a_subject_or_expiry_names_nobody() {
        let no_sub = sign(SECRET, "at.", &json!({ "cid": "c", "exp": NOW + 60 }));
        assert!(verify_access_at(SECRET, &format!("{TOKEN_PREFIX}{no_sub}"), NOW).is_none());
        let empty_sub = sign(SECRET, "at.", &json!({ "sub": "", "exp": NOW + 60 }));
        assert!(verify_access_at(SECRET, &format!("{TOKEN_PREFIX}{empty_sub}"), NOW).is_none());
        let no_exp = sign(SECRET, "at.", &json!({ "sub": "user:alice@idp.example" }));
        assert!(verify_access_at(SECRET, &format!("{TOKEN_PREFIX}{no_exp}"), NOW).is_none());
    }

    #[test]
    fn a_token_signed_for_one_purpose_is_not_one_for_another() {
        let claims = json!({ "sub": "user:alice@idp.example", "exp": NOW + 60 });
        let link = sign(SECRET, "dl.", &claims);
        let ticket = sign(SECRET, "live.", &claims);
        assert!(verified(SECRET, "dl.", &link, NOW).is_some());
        assert!(verified(SECRET, "live.", &ticket, NOW).is_some());
        assert!(verified(SECRET, "live.", &link, NOW).is_none());
        assert!(verified(SECRET, "dl.", &ticket, NOW).is_none());
        // Neither is an access token.
        assert!(verify_access_at(SECRET, &format!("{TOKEN_PREFIX}{link}"), NOW).is_none());
        assert!(verify_access_at(SECRET, &format!("{TOKEN_PREFIX}{ticket}"), NOW).is_none());
        // Expiry holds for every purpose.
        assert!(verified(SECRET, "dl.", &link, NOW + 60).is_none());
    }

    #[test]
    fn an_id_token_names_an_actor_only_when_every_claim_checks_out() {
        let good = json!({
            "iss": "https://idp.example/", "aud": "our-client", "sub": "alice",
            "exp": NOW + 60, "nonce": "n-1",
        });
        let actor = |c: &Value| id_token_actor(c, "https://idp.example", "our-client", "n-1", NOW);
        assert_eq!(actor(&good).as_deref(), Some("user:alice@idp.example"));
        let mut listed = good.clone();
        listed["aud"] = json!(["someone-else", "our-client"]);
        assert!(actor(&listed).is_some());

        for (claim, value) in [
            ("iss", json!("https://other.example")),
            ("aud", json!("someone-else")),
            ("aud", json!(["someone-else"])),
            ("aud", Value::Null),
            ("sub", json!("")),
            ("sub", Value::Null),
            ("exp", json!(NOW)),
            ("exp", Value::Null),
            ("nonce", json!("n-2")),
            ("nonce", Value::Null),
        ] {
            let mut bad = good.clone();
            bad[claim] = value.clone();
            assert!(actor(&bad).is_none(), "{claim} = {value}");
        }
        // A login that recorded no nonce accepts no token.
        assert!(id_token_actor(&good, "https://idp.example", "our-client", "", NOW).is_none());
        assert!(actor(&Value::Null).is_none());
    }

    #[test]
    fn the_consent_answer_comes_from_this_origin() {
        assert!(same_origin(
            Some("https://paged.example"),
            "https://paged.example"
        ));
        assert!(same_origin(None, "https://paged.example"));
        assert!(!same_origin(
            Some("https://other.example"),
            "https://paged.example"
        ));
        assert!(!same_origin(Some("null"), "https://paged.example"));
        assert!(!same_origin(
            Some("http://paged.example"),
            "https://paged.example"
        ));
    }

    #[test]
    fn the_consent_page_shows_the_client_as_text() {
        let page = consent_page(
            "<script>x</script>\"&",
            "https://app.example/cb?a=1",
            "user:alice@idp.example",
            "consent-id",
        );
        assert!(!page.contains("<script"));
        assert!(page.contains("&lt;script&gt;x&lt;/script&gt;&quot;&amp;"));
        // Where the answer goes is named by origin, and who is signed in.
        assert!(page.contains("<code>https://app.example</code>"));
        assert!(page.contains("<code>user:alice@idp.example</code>"));
        assert!(page.contains(r#"name="consent" value="consent-id""#));
        assert!(page.contains(r#"action="/oauth/consent""#));

        let unnamed = consent_page("  ", "http://127.0.0.1:9999/cb", "user:a@b", "id");
        assert!(unnamed.contains("An application without a name"));
        assert!(unnamed.contains("<code>http://127.0.0.1:9999</code>"));
        assert!(consent_page("x", "y", "z", "\"><i>").contains("value=\"&quot;&gt;&lt;i&gt;\""));
    }
}
