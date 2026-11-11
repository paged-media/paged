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

//! THE BRUSH POINT MAPS: the three moves a Liquify brush makes, written
//! once. The vector Liquify (`crate::liquify`) sends a control point
//! FORWARD through them; the raster tools (`crate::field`) send an output
//! pixel BACKWARD through them (the opposite move) to find where it now
//! reads. Same arithmetic in both directions; only the sign of the amount
//! is the caller's.

/// `p` dragged by `d`, weighted by `w`: `p + d·w`.
#[inline]
pub fn drag(p: (f64, f64), d: (f64, f64), w: f64) -> (f64, f64) {
    (p.0 + d.0 * w, p.1 + d.1 * w)
}

/// `p` turned by `theta` radians about `c` (counter-clockwise in a y-up
/// frame, clockwise on a y-down page).
#[inline]
pub fn turn_about(c: (f64, f64), p: (f64, f64), theta: f64) -> (f64, f64) {
    let (sn, cs) = theta.sin_cos();
    let (vx, vy) = (p.0 - c.0, p.1 - c.1);
    (c.0 + cs * vx - sn * vy, c.1 + sn * vx + cs * vy)
}

/// `p` scaled by `k` about `c`.
#[inline]
pub fn scale_about(c: (f64, f64), p: (f64, f64), k: f64) -> (f64, f64) {
    (c.0 + (p.0 - c.0) * k, c.1 + (p.1 - c.1) * k)
}
