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

//! Engine ADR 1099 — the layer-style evaluator of the effect stack.
//!
//! A layer style's effects (drop and inner shadows, outer and inner
//! glows, satin, colour, gradient and pattern overlays, the stroke, bevel
//! and emboss) are drawn from a layer's ALPHA, with Photoshop's falloffs,
//! light and compositing places — measured against Photoshop 27.10 by
//! paged.image's `psd_layer_styles` goldens. This crate is their one
//! implementation:
//!
//! - [`plan`] resolves the effect stack's layer-style entries
//!   (`EffectConvention::LayerStyle`, engine ADR 1099) into [`plan::Fx`]
//!   and places them: beneath the layer, inside it, on top;
//! - [`draw`] draws one effect as kernel dispatches (`style.*`, `gen.*`,
//!   `compose.*` — `paged-kernels`) on a [`draw::FxDevice`];
//! - [`cpu`] is the device that runs those kernels' shipped scalar twins
//!   (feature `cpu`): paged.image's CPU fold and the engine renderer use
//!   it; paged.image's GPU fold runs the same dispatches on its GPU batch.
//!
//! The layer's own compositing around the effects (its body, its fill
//! and opacity, a mask that hides effects, Blend Interior Effects as
//! Group) is the caller's: paged.image's fold, or the renderer's group.

#[cfg(feature = "cpu")]
pub mod cpu;
pub mod draw;
pub mod lut;
pub mod plan;

pub use draw::{
    alpha_bounds, blend_def, draw, paints, size_box_radius, source_alpha, Frame, FxDevice, FxPaint,
    Source,
};
pub use plan::{EffectStep, Fx, FxPlan, Light, PatternTile, Rect};
