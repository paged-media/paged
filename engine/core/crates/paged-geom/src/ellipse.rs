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

//! Ellipses and circular arcs as cubic Béziers: the one oval outline and the
//! one arc split every builder reads (capability register, geometry).

use paged_model::{Bounds, PathAnchor};

use crate::KAPPA_F32;

/// The ellipse inscribed in `b` as four cubic arcs, spelled the way InDesign
/// spells an `<Oval>` path (measured on InDesign 20.0.1): edge midpoints
/// bottom → right → top → left, each handle κ·r along the tangent. The model
/// keeps an oval as bounds only; every reader that needs its outline (the
/// IDML writers, the `pathAnchors` door, snapping, the planar arrangement)
/// takes it from here.
pub fn oval_anchors(b: Bounds) -> Vec<PathAnchor> {
    let (cx, cy) = ((b.left + b.right) * 0.5, (b.top + b.bottom) * 0.5);
    let kx = (b.right - b.left) * 0.5 * KAPPA_F32;
    let ky = (b.bottom - b.top) * 0.5 * KAPPA_F32;
    let point = |anchor: (f32, f32), left: (f32, f32), right: (f32, f32)| PathAnchor {
        anchor,
        left,
        right,
    };
    vec![
        point((cx, b.bottom), (cx - kx, b.bottom), (cx + kx, b.bottom)),
        point((b.right, cy), (b.right, cy + ky), (b.right, cy - ky)),
        point((cx, b.top), (cx + kx, b.top), (cx - kx, b.top)),
        point((b.left, cy), (b.left, cy - ky), (b.left, cy + ky)),
    ]
}

/// The handle length, in radii, of one cubic spanning `sweep` radians of a
/// circle: `4/3 · tan(sweep / 4)` ([`KAPPA`](crate::KAPPA) at a quarter turn).
pub fn arc_handle(sweep: f64) -> f64 {
    4.0 / 3.0 * (sweep / 4.0).tan()
}

/// [`arc_handle`] in single precision, for the `f32` path builders.
pub fn arc_handle_f32(sweep: f32) -> f32 {
    4.0 / 3.0 * (sweep / 4.0).tan()
}

/// How an arc of `sweep` radians splits into cubics: the piece count (each
/// at most a quarter turn, at least one) and the signed sweep of each.
pub fn arc_split(sweep: f64) -> (usize, f64) {
    let n = (sweep.abs() / std::f64::consts::FRAC_PI_2).ceil().max(1.0) as usize;
    (n, sweep / n as f64)
}

/// [`arc_split`] in single precision.
pub fn arc_split_f32(sweep: f32) -> (usize, f32) {
    let n = (sweep.abs() / std::f32::consts::FRAC_PI_2).ceil().max(1.0) as usize;
    (n, sweep / n as f32)
}

/// One cubic piece of an arc: the two control points and the end point.
pub type ArcCubic = [(f64, f64); 3];

/// The arc of the ellipse `centre + major·cos t + minor·sin t` from
/// parameter `t0` through `sweep` radians (negative: the other way round),
/// as cubics of at most a quarter turn each. The arc starts at
/// [`ellipse_point`]`(centre, major, minor, t0)`; a circle of radius `r` is
/// `major = (r, 0)`, `minor = (0, r)`.
pub fn arc_cubics(
    centre: (f64, f64),
    major: (f64, f64),
    minor: (f64, f64),
    t0: f64,
    sweep: f64,
) -> Vec<ArcCubic> {
    let at = |t: f64| ellipse_point(centre, major, minor, t);
    let tangent = |t: f64| {
        (
            major.0 * -t.sin() + minor.0 * t.cos(),
            major.1 * -t.sin() + minor.1 * t.cos(),
        )
    };
    let (pieces, step) = arc_split(sweep);
    let k = arc_handle(step);
    let mut out = Vec::with_capacity(pieces);
    let mut t = t0;
    for _ in 0..pieces {
        let (p0, p3) = (at(t), at(t + step));
        let (d0, d3) = (tangent(t), tangent(t + step));
        out.push([
            (p0.0 + d0.0 * k, p0.1 + d0.1 * k),
            (p3.0 - d3.0 * k, p3.1 - d3.1 * k),
            p3,
        ]);
        t += step;
    }
    out
}

/// The point at parameter `t` of the ellipse `centre + major·cos t +
/// minor·sin t`.
pub fn ellipse_point(
    centre: (f64, f64),
    major: (f64, f64),
    minor: (f64, f64),
    t: f64,
) -> (f64, f64) {
    let (c, s) = (t.cos(), t.sin());
    (
        centre.0 + (major.0 * c + minor.0 * s),
        centre.1 + (major.1 * c + minor.1 * s),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_quarter_turn_handle_is_kappa() {
        let k = arc_handle(std::f64::consts::FRAC_PI_2);
        assert!((k - crate::KAPPA).abs() < 1e-15);
        assert_eq!(arc_split(std::f64::consts::PI).0, 2);
        assert_eq!(arc_split(0.0).0, 1);
    }

    #[test]
    fn a_circle_closes_on_its_start() {
        let c = arc_cubics(
            (10.0, 20.0),
            (5.0, 0.0),
            (0.0, 5.0),
            0.0,
            std::f64::consts::TAU,
        );
        assert_eq!(c.len(), 4);
        let end = c[3][2];
        assert!((end.0 - 15.0).abs() < 1e-12 && (end.1 - 20.0).abs() < 1e-12);
        // The first handle points along +y, κ·r long.
        assert!((c[0][0].1 - (20.0 + 5.0 * crate::KAPPA)).abs() < 1e-12);
    }

    #[test]
    fn an_oval_is_four_midpoint_anchors_from_the_bottom() {
        let a = oval_anchors(Bounds {
            top: 0.0,
            left: 0.0,
            bottom: 20.0,
            right: 40.0,
        });
        assert_eq!(a[0].anchor, (20.0, 20.0));
        assert_eq!(a[1].anchor, (40.0, 10.0));
        assert_eq!(a[0].right.0, 20.0 + 20.0 * KAPPA_F32);
    }
}
