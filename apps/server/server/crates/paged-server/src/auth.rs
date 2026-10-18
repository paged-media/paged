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

//! Who is calling. M1 knows service tokens only: `PAGED_TOKENS` (a secret) maps
//! the SHA-256 of each token, in hex, to an actor id, so no token is stored.
//! OIDC sign-in and the OAuth server for MCP clients come next and resolve to
//! the same actor ids. With no `PAGED_TOKENS` every request is refused.

use std::collections::BTreeMap;

use sha2::{Digest, Sha256};
use worker::{Env, Request};

pub enum Denied {
    /// No credentials, or ones that name nobody.
    Unauthenticated,
    /// The server has no token table: it refuses everyone rather than no one.
    NotConfigured,
}

pub fn actor(req: &Request, env: &Env) -> Result<String, Denied> {
    let table = env
        .secret("PAGED_TOKENS")
        .map_err(|_| Denied::NotConfigured)?
        .to_string();
    let table: BTreeMap<String, String> =
        serde_json::from_str(&table).map_err(|_| Denied::NotConfigured)?;
    let header = req
        .headers()
        .get("authorization")
        .ok()
        .flatten()
        .ok_or(Denied::Unauthenticated)?;
    let token = header
        .strip_prefix("Bearer ")
        .ok_or(Denied::Unauthenticated)?;
    let digest: String = Sha256::digest(token.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let id = table.get(&digest).ok_or(Denied::Unauthenticated)?;
    if !(id.starts_with("user:") || id.starts_with("svc:")) {
        return Err(Denied::NotConfigured);
    }
    Ok(id.clone())
}
