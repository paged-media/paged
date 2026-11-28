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

//! CORS for the browser editor, which runs on another origin. Only origins in
//! `PAGED_ALLOWED_ORIGINS` (comma-separated) are answered; no wildcard, because
//! the API takes credentials. Sign-in's authorize and callback are navigations
//! and need none of this.

use worker::{Env, Headers, Response, Result};

pub fn allowed(env: &Env, origin: Option<String>) -> Option<String> {
    let origin = origin?;
    let list = env.var("PAGED_ALLOWED_ORIGINS").ok()?.to_string();
    list.split(',')
        .map(str::trim)
        .any(|o| !o.is_empty() && o == origin)
        .then_some(origin)
}

/// Every method a route answers to; a preflight for any other fails.
const ALLOW_METHODS: &str = "GET, POST, PUT, DELETE, OPTIONS";

/// What a response that depends on who asked says to caches.
pub const PRIVATE_NO_STORE: &str = "private, no-store";

/// Whether a path answers the same to everyone, so a cache may keep it. Every
/// other answer depends on the caller's identity or carries a secret.
pub fn public_path(path: &str) -> bool {
    matches!(
        path,
        "/healthz"
            | "/.well-known/oauth-authorization-server"
            | "/.well-known/oauth-protected-resource"
    )
}

/// The response as it leaves the Worker: `private, no-store` unless its path
/// is public, and CORS headers for `origin` when that origin is allowed.
/// Headers are copied rather than set in place: a response that came back from
/// a Durable Object may carry immutable ones. A WebSocket upgrade is passed on
/// as it is when there is nothing to add for CORS.
pub fn finish(resp: Response, origin: Option<&str>, private: bool) -> Result<Response> {
    let private = private && resp.status_code() != 101;
    if origin.is_none() && !private {
        return Ok(resp);
    }
    let headers = Headers::new();
    for (k, v) in resp.headers().entries() {
        headers.set(&k, &v)?;
    }
    if private {
        headers.set("cache-control", PRIVATE_NO_STORE)?;
    }
    if let Some(origin) = origin {
        headers.set("access-control-allow-origin", origin)?;
        headers.set("vary", "Origin")?;
        headers.set(
            "access-control-allow-headers",
            "authorization, content-type",
        )?;
        headers.set("access-control-allow-methods", ALLOW_METHODS)?;
        headers.set("access-control-expose-headers", "www-authenticate")?;
        headers.set("access-control-max-age", "600")?;
    }
    Ok(resp.with_headers(headers))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_metadata_and_health_paths_are_public() {
        assert!(public_path("/healthz"));
        assert!(public_path("/.well-known/oauth-authorization-server"));
        assert!(public_path("/.well-known/oauth-protected-resource"));
        for private in [
            "/v1/r/doc/refs",
            "/v1/r/doc/objects/00",
            "/v1/r/doc/file/main",
            "/v1/r/doc/evidence",
            "/v1/w/team/policy",
            "/v1/w/team/r/doc/log/main",
            "/v1/dl/token",
            "/v1/live",
            "/mcp",
            "/oauth/token",
            "/oauth/callback",
            "/oauth/consent",
            "/healthz/",
            "/.well-known/",
            "/",
            "",
        ] {
            assert!(!public_path(private), "{private}");
        }
    }

    #[test]
    fn a_preflight_allows_every_method_a_route_uses() {
        let allowed: Vec<&str> = ALLOW_METHODS.split(", ").collect();
        for method in ["GET", "POST", "PUT", "DELETE", "OPTIONS"] {
            assert!(allowed.contains(&method), "{method}");
        }
    }
}
