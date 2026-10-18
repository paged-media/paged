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

//! paged.server: an optional remote for paged repositories (core ADR 180).
//!
//! The Worker authenticates and routes; each repository is one Durable Object
//! (`RepoObject`), the single writer of its refs; large blobs live in R2.
//!
//!   POST /v1/r/{repo}/have           JSON [address] -> the ones the server lacks
//!   PUT  /v1/r/{repo}/objects        a pack -> every record checked, then stored
//!   GET  /v1/r/{repo}/refs           {name: address}
//!   POST /v1/r/{repo}/fetch          {want, have} -> one pack of what `want` adds
//!   POST /v1/r/{repo}/refs/{name}    {expected, new} -> compare-and-set, governed
//!   GET  /v1/r/{repo}/log/{ref}      first-parent history
//!   GET  /v1/r/{repo}/objects/{a}    one object, immutable
//!   GET  /v1/r/{repo}/file/{ref}     the .paged projection (?history=1 carries it)
//!   GET  /v1/r/{repo}/evidence       the evidence log
//!   …/cr, …/cr/{id}/{approve,merge,close}   change requests
//!
//! The same routes under /v1/w/{ws}/r/{repo}/ are a workspace's repository,
//! governed by the workspace's policy (`WorkspaceObject`, /v1/w/{ws}/policy).
//!
//!   /.well-known/oauth-authorization-server, /.well-known/oauth-protected-resource,
//!   /oauth/{register,authorize,callback,token}   sign-in (see `oauth`)
//!
//! Errors are RFC 9457 problem+json (the OAuth token endpoint answers in OAuth's own shape).

mod auth;
mod auth_object;
mod cors;
mod crypto;
mod oauth;
mod problem;
mod repo_object;
mod store;
mod workspace_object;

pub use auth_object::AuthObject;
pub use repo_object::RepoObject;
pub use workspace_object::WorkspaceObject;

use worker::{event, Context, Env, Headers, Method, Request, RequestInit, Response, Result};

use crate::problem::problem;

/// The header the Worker uses to tell a repository who is calling. Anything a
/// client sends under this name is dropped before forwarding.
pub(crate) const ACTOR_HEADER: &str = "x-paged-actor";
/// Which repository and route a forwarded request is for, and its workspace.
pub(crate) const REPO_HEADER: &str = "x-paged-repo";
pub(crate) const ROUTE_HEADER: &str = "x-paged-route";
pub(crate) const WORKSPACE_HEADER: &str = "x-paged-workspace";

fn valid_repo(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

#[event(fetch)]
async fn fetch(req: Request, env: Env, _ctx: Context) -> Result<Response> {
    let origin = cors::allowed(&env, req.headers().get("origin")?);
    if req.method() == Method::Options {
        return cors::apply(Response::empty()?.with_status(204), origin.as_deref());
    }
    let resp = route(req, env).await?;
    cors::apply(resp, origin.as_deref())
}

async fn route(mut req: Request, env: Env) -> Result<Response> {
    let url = req.url()?;
    let path = url.path().to_string();
    match (req.method(), path.as_str()) {
        (_, "/healthz") => return Response::ok("ok"),
        (Method::Get, "/.well-known/oauth-authorization-server") => {
            return oauth::authorization_server_metadata(&url)
        }
        (Method::Get, "/.well-known/oauth-protected-resource") => {
            return oauth::protected_resource_metadata(&url)
        }
        _ => {}
    }
    if let Some(route) = path.strip_prefix("/oauth/") {
        let Some(cfg) = oauth::Config::from(&env) else {
            return problem(
                503,
                "Sign-in not configured",
                "no identity provider or token secret",
            );
        };
        return match (req.method(), route) {
            (Method::Post, "register") => oauth::register(req, &env).await,
            (Method::Get, "authorize") => oauth::authorize(req, &env, &cfg).await,
            (Method::Get, "callback") => oauth::callback(req, &env, &cfg).await,
            (Method::Post, "token") => oauth::token(req, &env, &cfg).await,
            _ => problem(404, "Not found", "no such route"),
        };
    }
    // Which Durable Object answers: a personal repository, a workspace's
    // repository, or the workspace itself.
    let segments: Vec<&str> = path.trim_start_matches('/').splitn(6, '/').collect();
    let (ns, object, workspace, repo_name, rest) = match segments.as_slice() {
        ["v1", "r", repo, rest @ ..] => (
            "REPO",
            repo.to_string(),
            None,
            Some(repo.to_string()),
            rest.join("/"),
        ),
        ["v1", "w", ws, "r", repo, rest @ ..] => {
            if !valid_repo(repo) {
                return problem(
                    400,
                    "Bad repository name",
                    "lowercase letters, digits and '-', at most 64",
                );
            }
            let name = format!("{ws}/{repo}");
            (
                "REPO",
                name.clone(),
                Some(ws.to_string()),
                Some(name),
                rest.join("/"),
            )
        }
        ["v1", "w", ws, rest @ ..] => (
            "WORKSPACE",
            ws.to_string(),
            Some(ws.to_string()),
            None,
            rest.join("/"),
        ),
        _ => return problem(404, "Not found", "no such route"),
    };
    let first = object.split('/').next().unwrap_or("");
    if !valid_repo(first) || workspace.as_deref().is_some_and(|w| !valid_repo(w)) {
        return problem(
            400,
            "Bad name",
            "lowercase letters, digits and '-', at most 64",
        );
    }
    if rest.starts_with("internal") {
        return problem(404, "Not found", "no such route");
    }
    let actor = match auth::actor(&req, &env) {
        Ok(a) => a,
        Err(auth::Denied::Unauthenticated) => {
            let mut r = problem(
                401,
                "Unauthenticated",
                "a bearer token this server knows is required",
            )?;
            r.headers_mut()
                .set("www-authenticate", &oauth::challenge(&url))?;
            return Ok(r);
        }
        Err(auth::Denied::NotConfigured) => {
            return problem(
                503,
                "Not configured",
                "this server has no valid token table",
            )
        }
    };

    let headers = Headers::new();
    if let Some(ct) = req.headers().get("content-type")? {
        headers.set("content-type", &ct)?;
    }
    headers.set(ACTOR_HEADER, &actor)?;
    headers.set(ROUTE_HEADER, &rest)?;
    if let Some(name) = &repo_name {
        headers.set(REPO_HEADER, name)?;
    }
    if let (Some(ws), Some(_)) = (&workspace, &repo_name) {
        headers.set(WORKSPACE_HEADER, ws)?;
    }
    let mut init = RequestInit::new();
    init.with_method(req.method()).with_headers(headers);
    if !matches!(req.method(), Method::Get | Method::Head) {
        let body = req.bytes().await?;
        init.with_body(Some(
            worker::js_sys::Uint8Array::from(body.as_slice()).into(),
        ));
    }
    let forwarded = Request::new_with_init(url.as_str(), &init)?;
    let stub = env.durable_object(ns)?.id_from_name(&object)?.get_stub()?;
    stub.fetch_with_request(forwarded).await
}
