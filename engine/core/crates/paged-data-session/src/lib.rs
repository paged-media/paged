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

//! # data-session — paged.data's session (PM-0015)
//!
//! [`core::DataSession`] joins the data crates: the source manifest and its
//! consent, the queries and the store they run on, the bindings with their
//! sync states, lowering, data sets and batch plans. It is plain Rust, so
//! the conformance suite, the module's CLI and script surface and the
//! engine's own CLI drive the same session the editor's wasm does
//! (`modules/data/data-js` is a forwarding shim over it).
//!
//! [`labels`] reads the bindings a document carries in its page items'
//! labels and its document label (core ADR 1014): the recipe a document
//! keeps through an InDesign save, rebuilt without the module.

pub mod columns;
pub mod core;
pub mod labels;
pub mod review;
