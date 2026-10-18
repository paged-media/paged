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

//! Emit the CLI's own command tree as pretty JSON — the committed
//! artifact (`crates/paged-cli/cli.json`) that docs.paged.media
//! generates its command reference from, the way `catalog.json` backs
//! the scripting reference. Regenerate after any change to the tree:
//!
//! ```sh
//! cargo run -p paged-cli --example emit-cli-surface > crates/paged-cli/cli.json
//! ```
//!
//! The `cli_json_artifact_is_current` test fails if the committed file
//! drifts from the parser.

fn main() {
    let json = serde_json::to_string_pretty(&paged_cli::cli::surface())
        .expect("serialize the CLI surface");
    println!("{json}");
}
