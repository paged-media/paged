/*
 * This file is part of paged (https://paged.media).
 *
 * paged is free software: you may redistribute it and/or modify it under the
 * terms of the GNU Affero General Public License, version 3, as published by
 * the Free Software Foundation, OR under the Paged Media Enterprise License
 * (PMEL), a commercial license available from And The Next GmbH. Full
 * copyright and license information is available in LICENSE.md, distributed
 * with this source code.
 *
 * paged is distributed in the hope that it will be useful, but WITHOUT ANY
 * WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE. See the licenses for details.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    AGPL-3.0-only OR Paged Media Enterprise License (PMEL)
 */

//! `paged query` — which objects a selector names (ADR 131).
//!
//! The same `RequestQuery` the editor and `paged.query` send, so the three
//! answer alike. One canonical address per line by default (a shell
//! pipes it into `paged read element-properties`, `paged place` …);
//! `--json` prints the engine's reply envelope instead.

use std::path::Path;

use anyhow::{anyhow, Result};
use paged_canvas::channel::{MainToWorkerKind, WorkerToMainKind};

use crate::engine::Session;
use crate::options::DocumentOptions;

pub fn run(doc: &Path, assets: &DocumentOptions, selector: &str, json: bool) -> Result<()> {
    let mut session = Session::new();
    assets.open(&mut session, doc)?;
    let reply = session.send(MainToWorkerKind::RequestQuery {
        selector: selector.to_string(),
    })?;
    match &reply {
        WorkerToMainKind::QueryResult { error: Some(e), .. } => {
            // Point at the offending byte, the way a compiler would.
            let caret = " ".repeat(e.position as usize);
            Err(anyhow!(
                "selector does not parse: {}\n  {selector}\n  {caret}^",
                e.message
            ))
        }
        WorkerToMainKind::QueryResult { addresses, .. } => {
            if json {
                println!("{}", serde_json::to_string_pretty(&reply)?);
            } else {
                for a in addresses {
                    println!("{a}");
                }
            }
            Ok(())
        }
        other => Err(anyhow!("unexpected reply to a query: {other:?}")),
    }
}
