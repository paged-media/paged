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

//! Inspector API: read-side scene-graph introspection paired with
//! `paged-mutate` on the write side. The React app in `apps/devtools/`
//! consumes this crate (via `paged-introspect-wasm`).
//!
//! Three deliverables:
//!
//! 1. [`tree::build_tree`] — walk a [`Document`] into a serializable
//!    Spread → Page → Frame hierarchy the UI's tree pane renders.
//! 2. [`descriptor::describe`] — for a given [`NodeId`], list typed
//!    property descriptors (authored value + computed value + source).
//! 3. [`render_page_png`] — rasterise a single page to PNG bytes for
//!    the render pane. Behind the `render` feature so non-render
//!    consumers stay light.

pub mod catalog;
pub mod descriptor;
pub mod schema;
pub mod tree;
pub mod virtual_paths;

#[cfg(feature = "render")]
pub mod render;

#[cfg(test)]
mod testutil;

pub use catalog::{
    api_catalog, lookup_path, unadvertised_reason, wire_alias, wire_name, ApiCatalog, PathAlias,
};
pub use descriptor::{
    describe, AuthoredValue, ComputedValue, PropertyDescriptor, PropertyKind, PropertySource,
};
pub use tree::{build_tree, FrameEntry, InspectorTree, PageEntry, SpreadEntry};

#[cfg(feature = "render")]
pub use render::render_page_png;
