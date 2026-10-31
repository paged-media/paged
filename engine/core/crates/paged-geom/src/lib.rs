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

//! Path geometry kernels (plan C8, PM-0014 L2): one definition of the path
//! algebra the editor's operations (outline stroke, offset path, simplify,
//! the Pathfinder booleans and the planar arrangement) and the build
//! pipeline's live vector effects (engine ADR 1042) both run.
//!
//! The modules moved here from `paged-mutate`, which re-exports each one
//! under its old path, so `paged_mutate::kurbo_kernel::…` and the rest
//! still resolve. The crate depends on the model's `PathAnchor` and the two
//! curve libraries only: the read-only viewer may link it.

pub mod bezier_conv;
pub mod kurbo_kernel;
pub mod orientation;
pub mod pathfinder;
pub mod planar;
mod planar_dcel;
pub mod stroke_kernel;
