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

/// The cubic control-point distance, in radii, of a quarter circle: the one
/// constant every ellipse, oval and rounded-corner builder reads
/// (`4/3 * (sqrt 2 - 1)`, rounded to `f64`).
pub const KAPPA: f64 = 0.552_284_749_830_793_4;

/// [`KAPPA`] in single precision: the same `f32` the `0.552_284_8` literals
/// it replaces denote (checked by `tests::kappa_f32_is_the_old_literal`).
pub const KAPPA_F32: f32 = KAPPA as f32;

pub mod affine;
pub mod affine64;
pub mod bezier_conv;
pub mod ellipse;
pub mod flatten;
pub mod kurbo_kernel;
pub mod orientation;
pub mod pathfinder;
pub mod planar;
mod planar_dcel;
pub mod stroke_kernel;
pub mod trim;

pub use ellipse::{arc_cubics, arc_handle, oval_anchors};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kappa_f32_is_the_old_literal() {
        assert_eq!(KAPPA_F32.to_bits(), 0.552_284_8_f32.to_bits());
    }

    #[test]
    fn kappa_is_the_quarter_circle_distance() {
        let exact = 4.0 / 3.0 * (2.0_f64.sqrt() - 1.0);
        assert!((KAPPA - exact).abs() < 1e-15);
    }
}
