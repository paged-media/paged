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
//! (`def`, and the families in `families` that the engine can reach, engine
//! ADR 1013) move here by `git mv`; the registry build and the families only
//! paged.image runs are still in `modules/image/image-kernels`, which
//! re-exports everything here under its old paths.
//!
//! The kernel macro (`family`), the ABI assembler (`abi`) and the reference
//! prelude moved here with the first families that need them (engine ADR 1013).
//!
//! Pure Rust, no I/O, wasm-safe; depends only on the leaf `paged-blend`
//! (the compose twin's blend formulas, engine ADR 1034).

pub mod abi;
pub mod blur;
/// The compose family's scalar twins: the test-only reference, and (feature
/// `cpu`) the CPU paths of paged.image's layer fold (image ADR 480) and of
/// the layer-style evaluator `paged-layer-fx`.
#[cfg(any(feature = "reference", feature = "cpu"))]
pub mod compose_twin;
pub mod coverage;
pub mod cpu;
pub mod def;
// Before `families`: textual macro scope runs in declaration order.
#[macro_use]
pub mod family;
pub mod families;
pub mod params;
mod px;
/// The Rust half of the kernel DSL: the scalar twins' prelude. Test-only
/// under `reference`, the shipped CPU path under `cpu` (image ADR 465).
#[cfg(any(feature = "reference", feature = "cpu"))]
pub mod reference_prelude;

pub use px::Px;
