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

//! IDML sample-corpus generator.
//!
//! Produces deterministic IDML packages for the renderer's diff
//! harness. Each emitted `.idml` is a multi-page document whose pages
//! each exercise one renderable feature variant — failure attribution
//! comes from per-page heatmaps + `Page.Name` carrying the variant
//! descriptor, so a single InDesign export covers many test cases.
//!
//! See `docs/idml-sample-generator.md` for the strategic argument and
//! `crates/paged-gen/src/samples/` for the concrete sample definitions.

pub mod geometry;
pub mod ids;
pub mod package;
pub mod xml;

pub mod builders;
pub mod samples;

pub use package::{write_idml, Sample};
