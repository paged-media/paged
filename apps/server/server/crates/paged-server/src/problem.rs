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

//! RFC 9457 problem details, the one error shape this server answers with.

use worker::{Response, Result};

pub fn problem(status: u16, title: &str, detail: &str) -> Result<Response> {
    let body = serde_json::json!({ "type": "about:blank", "title": title, "status": status, "detail": detail });
    let mut r = Response::from_json(&body)?.with_status(status);
    r.headers_mut()
        .set("content-type", "application/problem+json")?;
    Ok(r)
}
