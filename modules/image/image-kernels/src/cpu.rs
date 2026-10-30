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

//! The CPU twins that SHIP (feature `cpu`; ADR 465, the exception to
//! ADR 450). Their bodies live in `paged-kernels` (engine ADR 1013's
//! first step), where the engine's image filter stack reaches them too;
//! this module re-exports them and keeps what is the module's own: the
//! list of kernels with a shipped twin, and the `kernel_family!` twin of
//! `adjust.invert_rgb`, which is generated from the same expression as
//! its shader.

pub use paged_kernels::cpu::*;

use crate::families::adjust::{
    adjust_invert_rgb, AdjustInvertRgbParams, ADJUST_BLACK_WHITE, ADJUST_BRIGHTNESS_CONTRAST,
    ADJUST_CHANNEL_MIXER, ADJUST_COLOR_BALANCE, ADJUST_EXPOSURE, ADJUST_GRADIENT_MAP,
    ADJUST_HUE_ROTATE, ADJUST_HUE_SATURATION, ADJUST_INVERT_RGB, ADJUST_LEVELS, ADJUST_LEVELS_RGB,
    ADJUST_PHOTO_FILTER, ADJUST_POSTERIZE, ADJUST_SATURATION, ADJUST_THRESHOLD, ADJUST_VIBRANCE,
    ADJUST_WHITE_BALANCE,
};
use crate::families::conv::{CONV_GAUSSIAN_H, CONV_GAUSSIAN_V, CONV_UNSHARP};
use crate::KernelDef;

/// Every kernel with a shipped CPU twin: the kernels the adjustment chain
/// (`image-js` `adjust_stages`) dispatches, and `adjust.gradient_map`,
/// which the engine's image filter stack evaluates for a duotone. A kernel
/// joins this list only with its twin and its tolerance test.
pub static CPU_KERNELS: &[&KernelDef] = &[
    &ADJUST_EXPOSURE,
    &ADJUST_WHITE_BALANCE,
    &ADJUST_LEVELS,
    &ADJUST_LEVELS_RGB,
    &ADJUST_BRIGHTNESS_CONTRAST,
    &ADJUST_COLOR_BALANCE,
    &ADJUST_PHOTO_FILTER,
    &ADJUST_CHANNEL_MIXER,
    &ADJUST_VIBRANCE,
    &ADJUST_SATURATION,
    &ADJUST_BLACK_WHITE,
    &ADJUST_POSTERIZE,
    &ADJUST_THRESHOLD,
    &ADJUST_HUE_ROTATE,
    &ADJUST_HUE_SATURATION,
    &ADJUST_INVERT_RGB,
    &ADJUST_GRADIENT_MAP,
    &CONV_GAUSSIAN_H,
    &CONV_GAUSSIAN_V,
    &CONV_UNSHARP,
];

/// `adjust.invert_rgb`: the `kernel_family!` twin itself (one expression
/// feeds the shader and this function, ADR 451).
pub fn invert_rgb(a: Px) -> Px {
    adjust_invert_rgb(a, a, &AdjustInvertRgbParams::new())
}
