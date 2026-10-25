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

//! T0 kernel families (spec §11). One file per family; each file owns
//! its `kernel_family!` rows, its registry entries
//! (`registry/kernels.yaml`), and its conformance tests — the
//! conflict-free fan-out unit (spec §16.3 rule 5).
//!
//! `linear` was the phase-0 codegen proof; the other six land with the
//! M0 fan-out (one agent per file).

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
pub mod distort;
pub mod gallery;
pub mod gallery_ext;
pub mod gen;
pub mod geom;
pub mod linear;
pub mod minmax;
pub mod morph;
pub mod pixelate;
pub mod relational;
pub mod render;
pub mod resample;
pub mod stylize;

use crate::KernelDef;

/// Every family's definition slice — `all_defined()` concatenates
/// these; the conformance gate asserts set-equality with the
/// registry-generated dispatch table.
pub static ALL_FAMILIES: &[&[&KernelDef]] = &[
    adjust::FAMILY,
    adjust_ext::FAMILY,
    arithmetic::FAMILY,
    band::FAMILY,
    blurgal::FAMILY,
    boolean::FAMILY,
    cast::FAMILY,
    compose::FAMILY,
    compose::GAMMA_FAMILY,
    conv::FAMILY,
    develop::FAMILY,
    distort::FAMILY,
    gallery::FAMILY,
    gallery_ext::FAMILY,
    gen::FAMILY,
    geom::FAMILY,
    linear::FAMILY,
    minmax::FAMILY,
    morph::FAMILY,
    pixelate::FAMILY,
    relational::FAMILY,
    render::FAMILY,
    resample::FAMILY,
    stylize::FAMILY,
];
