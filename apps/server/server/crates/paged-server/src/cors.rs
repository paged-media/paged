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

/// The response with CORS headers for `origin`, or unchanged when it is not allowed.
/// Headers are copied rather than set in place: a response that came back from a
/// Durable Object may carry immutable ones.
pub fn apply(resp: Response, origin: Option<&str>) -> Result<Response> {
    let Some(origin) = origin else {
        return Ok(resp);
    };
    let headers = Headers::new();
    for (k, v) in resp.headers().entries() {
        headers.set(&k, &v)?;
    }
    headers.set("access-control-allow-origin", origin)?;
    headers.set("vary", "Origin")?;
    headers.set(
        "access-control-allow-headers",
        "authorization, content-type",
    )?;
    headers.set("access-control-allow-methods", "GET, POST, PUT, OPTIONS")?;
    headers.set("access-control-expose-headers", "www-authenticate")?;
    headers.set("access-control-max-age", "600")?;
    Ok(resp.with_headers(headers))
}
