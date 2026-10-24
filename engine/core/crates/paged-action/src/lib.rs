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

//! # paged-action — actions as a platform concept (core ADR 1015, PM-0015)
//!
//! An action is a named, typed, PURE step: an input ([`ActionValue`]: an
//! asset, a table, a selection or a JSON value) and parameters give an
//! output. It computes and never edits a document; a command may apply its
//! result in one undo step.
//!
//! - [`Registry`] holds actions by id, runs one ([`Registry::run`]) or a
//!   chain ([`Registry::run_chain`], kinds checked before anything runs), and
//!   caches each result under [`key`]: `hash(input).hash(chain)`, the same
//!   key the SDK's `actions@1` computes (`actionKey`), so a result is
//!   addressed alike in a bundle, a script and the command line.
//! - [`js::JsAction`] (feature `js`) is an action written in JavaScript, run
//!   in a sandboxed Boa context: no host functions, a loop and recursion
//!   budget. Data transforms (data ADR 562) are table → table JS actions.

mod key;
mod registry;
mod value;

#[cfg(feature = "js")]
pub mod js;

pub use key::{canonical, key};
pub use registry::{Action, ActionError, ActionInfo, Registry, RunResult, Step, CACHE_ENTRIES};
pub use value::{ActionKind, ActionValue};
