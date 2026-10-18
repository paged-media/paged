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

//! `paged` — the engine on the command line.
//!
//! A library as well as a binary, because `paged-run` is a shim over
//! [`session::run`]: that binary has three independent consumers who
//! spawn it by name, with no argv, from `target/<profile>/paged-run`
//! (editor-server's automation lane, the docs scripting gate, and this
//! workspace's own `CARGO_BIN_EXE_paged-run` test), so it keeps
//! existing exactly as it is while `paged session` speaks the same
//! protocol from the same code.

pub mod cli;
pub mod diff;
pub mod engine;
pub mod engine_serve;
pub mod export;
pub mod gen;
pub mod inspect;
pub mod invoke;
pub mod library;
pub mod mcp;
pub mod new;
pub mod object;
pub mod options;
pub mod package;
pub mod parts;
pub mod place;
pub mod query;
pub mod read;
pub mod render;
pub mod script;
pub mod session;
