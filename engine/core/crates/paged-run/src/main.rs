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

//! `paged-run`: the headless NDJSON engine session, now `paged
//! session` under a second name.
//!
//! The session itself moved to `paged_cli::session` so the `paged`
//! binary can offer it as a subcommand without a second implementation
//! of the protocol. This binary stays because three consumers spawn it
//! by name, with no argv, and would all break on a rename:
//!
//!   * editor-server's document-automation lane spawns
//!     `PAGED_RUN_BIN` (default: the bare string `"paged-run"`) with an
//!     empty argv;
//!   * the docs scripting gate resolves
//!     `core/target/{debug,release}/paged-run` directly;
//!   * this workspace's own `tests/session.rs` uses
//!     `env!("CARGO_BIN_EXE_paged-run")`.
//!
//! It takes no arguments — anything it accepted would be a second,
//! divergent surface for the same protocol.

fn main() -> anyhow::Result<()> {
    paged_cli::session::run()
}
