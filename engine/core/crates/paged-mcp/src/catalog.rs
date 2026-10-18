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

//! `lookup_api`: a search over the engine's capability catalog
//! (`paged-introspect/catalog.json`, the same contract every surface is
//! generated from — ADR 019), embedded so a host needs no engine to answer.

use serde_json::{json, Value};

const CATALOG: &str = include_str!("../../paged-introspect/catalog.json");

/// The catalog entries that best match `query`, at most `limit`, as
/// `{section, entry}`. Every word must appear; names count more than prose.
pub fn lookup(query: &str, limit: usize) -> Value {
    let catalog: Value = serde_json::from_str(CATALOG).expect("the catalog is JSON");
    let words: Vec<String> = query
        .split(|c: char| !c.is_alphanumeric() && c != '.' && c != '_')
        .filter(|w| !w.is_empty())
        .map(str::to_lowercase)
        .collect();
    let mut hits: Vec<(usize, Value)> = Vec::new();
    if let Some(sections) = catalog.as_object() {
        for (section, entries) in sections {
            for entry in entries.as_array().into_iter().flatten() {
                let text = entry.to_string().to_lowercase();
                if words.is_empty() || !words.iter().all(|w| text.contains(w.as_str())) {
                    continue;
                }
                let name = entry
                    .get("name")
                    .or_else(|| entry.get("form"))
                    .or_else(|| entry.get("path"))
                    .map(Value::to_string)
                    .unwrap_or_else(|| text.clone())
                    .to_lowercase();
                let score = words.iter().filter(|w| name.contains(w.as_str())).count() * 10
                    + usize::from(section == "hostFunctions") * 3
                    + 1000 / (text.len() + 10);
                hits.push((score, json!({ "section": section, "entry": entry })));
            }
        }
    }
    hits.sort_by(|a, b| b.0.cmp(&a.0));
    let found: Vec<Value> = hits.into_iter().take(limit).map(|(_, v)| v).collect();
    json!({ "query": query, "matches": found.len(), "results": found })
}

/// The scripting constraints, always worth reading before a first script.
pub fn constraints() -> Value {
    let catalog: Value = serde_json::from_str(CATALOG).expect("the catalog is JSON");
    catalog["constraints"].clone()
}
