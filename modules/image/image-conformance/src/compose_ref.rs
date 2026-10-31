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

//! Scalar reference implementations of the compose.* blend/composite
//! operators — shared by the compose parity tests AND the PSD flatten
//! render-oracle. Since image ADR 480 the body lives in `image-kernels`
//! (`compose_twin`), where the layer fold's CPU path ships the same
//! functions; this module re-exports it so the oracle and the shipped
//! twin cannot drift apart.

pub use image_kernels::compose_twin::*;
