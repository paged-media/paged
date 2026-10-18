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

//! Emit the capability catalog as pretty JSON — the committed build-time
//! artifact (`crates/paged-introspect/catalog.json`) that off-engine consumers
//! (the plugin SDK sync, `state`'s catalog ingest, docs) read without booting
//! wasm. Regenerate after any catalog change:
//!
//! ```sh
//! cargo run -p paged-introspect --example emit-catalog > crates/paged-introspect/catalog.json
//! ```
//!
//! The `catalog_json_artifact_is_current` test fails if the committed file
//! drifts from `api_catalog()`.

fn main() {
    let json = serde_json::to_string_pretty(&paged_introspect::api_catalog())
        .expect("serialize the capability catalog");
    println!("{json}");
}
