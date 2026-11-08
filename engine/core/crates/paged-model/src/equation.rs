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

//! Equations in text (engine ADR 1090).
//!
//! An equation is a math tree ([`paged_math::Math`]) standing at a character
//! offset of its paragraph. The renderer sets it with `paged_math::layout`
//! at the size of the run it stands in and puts the box on the line as an
//! inline object: as wide as the equation, its ascent above the baseline and
//! its descent below. A display equation (`Math::display`) is set in display
//! style; a reader puts it in a paragraph of its own, centred, as Word does.

use serde::{Deserialize, Serialize};

/// The math tree's crate, for building one (`math::Node`, `math::Run`).
pub use paged_math as math;
pub use paged_math::Math;

/// One equation of a paragraph.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct Equation {
    /// The character offset of its place in the paragraph's text (Unicode
    /// scalars, counted contiguously over the runs); past the text, at its
    /// end.
    pub offset: u32,
    pub math: Math,
}
