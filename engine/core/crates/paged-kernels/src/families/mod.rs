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

//! The kernel families whose definitions the engine can reach (engine
//! ADR 1013). `modules/image/image-kernels` re-exports each under its old
//! `families::<name>` path and keeps the registry that points at them.

pub mod adjust;
pub mod adjust_ext;
pub mod arithmetic;
pub mod band;
pub mod blurgal;
pub mod boolean;
pub mod cast;
pub mod compose;
pub mod conv;
pub mod develop;
pub mod gallery;
pub mod linear;
pub mod minmax;
pub mod relational;
pub mod select;
pub mod stylize;
