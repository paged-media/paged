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
//!   POST /v1/r/{repo}/refs/{name}    {expected, new} -> compare-and-set, governed
//!   GET  /v1/r/{repo}/log/{ref}      first-parent history
//!   GET  /v1/r/{repo}/objects/{a}    one object, immutable
//!   GET  /v1/r/{repo}/file/{ref}     the .paged projection (?history=1 carries it)
//!   GET  /v1/r/{repo}/evidence       the evidence log
//!
//! Errors are RFC 9457 problem+json.

mod auth;
mod problem;
mod repo_object;
mod store;

pub use repo_object::RepoObject;

use worker::{event, Context, Env, Headers, Method, Request, RequestInit, Response, Result};

use crate::problem::problem;

/// The header the Worker uses to tell a repository who is calling. Anything a
/// client sends under this name is dropped before forwarding.
pub(crate) const ACTOR_HEADER: &str = "x-paged-actor";

fn valid_repo(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

#[event(fetch)]
async fn fetch(mut req: Request, env: Env, _ctx: Context) -> Result<Response> {
    let url = req.url()?;
    let path = url.path().to_string();
    if path == "/healthz" {
        return Response::ok("ok");
    }
    let Some(rest) = path.strip_prefix("/v1/r/") else {
        return problem(404, "Not found", "no such route");
    };
    let repo = rest.split('/').next().unwrap_or("");
    if !valid_repo(repo) {
        return problem(
            400,
            "Bad repository name",
            "lowercase letters, digits and '-', at most 64",
        );
    }
    let actor = match auth::actor(&req, &env) {
        Ok(a) => a,
        Err(auth::Denied::Unauthenticated) => {
            return problem(
                401,
                "Unauthenticated",
                "a bearer token this server knows is required",
            )
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
    let mut init = RequestInit::new();
    init.with_method(req.method()).with_headers(headers);
    if !matches!(req.method(), Method::Get | Method::Head) {
        let body = req.bytes().await?;
        init.with_body(Some(
            worker::js_sys::Uint8Array::from(body.as_slice()).into(),
        ));
    }
    let forwarded = Request::new_with_init(url.as_str(), &init)?;
    let stub = env.durable_object("REPO")?.id_from_name(repo)?.get_stub()?;
    stub.fetch_with_request(forwarded).await
}
