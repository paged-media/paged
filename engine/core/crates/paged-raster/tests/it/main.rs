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

//! paged-raster integration tests. Every TIFF is generated in the test:
//! through `encode_tiff` (and `tiff`'s encoder) for the strip matrix, and
//! through [`raw_tiff`] for the layouts no encoder writes (tiles, planar,
//! 1-bit, palette, YCbCr, Lab, big-endian).
//!
//! The `__feat__images_graphics_tiff_raster` suffix links the main tests
//! to the `images-graphics.tiff-raster` feature row; it is the evidence
//! join's convention, hence the lint allowance.
#![allow(non_snake_case)]

mod colour;
mod formats;
mod layouts;
mod matrix;
mod metadata;
mod raw_tiff;
mod support;
