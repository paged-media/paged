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

//! `paged-kernels` — one kernel definition for the engine and paged.image
//! (PM-0014). This is the first step of the move engine ADR 1013 plans:
//! the pixel type, the param blocks and the shipped CPU twins of the
//! adjustment and convolution kernels, which the engine's image filter
//! stack (engine ADR 1037) evaluates. The kernel definitions themselves
//! (`KernelDef`, the WGSL, the registry build) are still in
//! `modules/image/image-kernels`, which re-exports everything here under
//! its old paths; the rest of the crate moves into this one by `git mv`.
//!
//! Pure Rust, no I/O, wasm-safe; depends on nothing in the workspace.

pub mod cpu;
pub mod params;
mod px;

pub use px::Px;
