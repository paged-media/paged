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

//! Engine tools over the relay to a person's open editor tab. (Filled in with
//! the Session Durable Object; until a tab connects, they say so.)

use paged_mcp::Outcome;
use serde_json::{json, Value};
use worker::Env;

pub async fn engine_call(
    _env: &Env,
    _principal: &str,
    _agent: &str,
    _run: &str,
    tool: &str,
    _args: Value,
) -> Outcome {
    if tool == "list_live_sessions" {
        return Outcome::json(json!({ "sessions": [] }));
    }
    Outcome::error(
        "No editor tab is connected. Open the document in the paged editor and connect it \
         (Library ▸ Connect to Claude), or run `paged mcp` to use the engine locally.",
    )
}
