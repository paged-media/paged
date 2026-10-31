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

//! Warp: Illustrator's fifteen styles as point maps over the bounding
//! box.
//!
//! In the box's normalised frame (`u`, `v` in −1..1, `v` down the page)
//! each style moves a point by a closed-form displacement scaled by the
//! bend `b` (−1..1); a vertical warp is the horizontal one on the
//! transposed box. The horizontal and vertical distortions then add a
//! perspective: `distort_h` scales `v` across `u`, `distort_v` scales `u`
//! across `v`. Curves are cut until the mapped cubic stays within 0.05 pt
//! of the mapped curve.
//!
//! The forms are this engine's. Illustrator's warp could not be driven
//! from a script (its live effect, `Adobe Deform`, takes no parameters
//! through `applyEffect`; ADR 1042), so the styles were not recorded;
//! each keeps the character its name and Illustrator's preview give it,
//! and the box's corners stay where Illustrator puts them for the
//! envelope styles (Arc moves them, the edge styles do not).

use std::f64::consts::PI;

use kurbo::Point;
use paged_model::vector_effect::{WarpParams, WarpStyle};

use crate::shape::{map_nonlinear, Shape};

/// The displacement of one normalised point `(u, v)` with bend `b`, as
/// the new `(u, v)`. `aspect` is height / width (Arc keeps its arcs
/// circular on the page).
pub fn warp_point(style: WarpStyle, b: f64, u: f64, v: f64, aspect: f64) -> (f64, f64) {
    let edge = 1.0 - u * u;
    match style {
        WarpStyle::Arc => {
            if b.abs() < 1e-9 {
                return (u, v);
            }
            // Concentric circular arcs: the middle line keeps its length
            // and turns through `b · π`; a line `v` above it lies on the
            // circle `aspect · v` farther out.
            let theta = b * PI;
            let r0 = 2.0 / theta;
            let phi = u * theta / 2.0;
            let r = r0 - v * aspect;
            let x = r * phi.sin();
            let y = r0 - r * phi.cos();
            (x, y / aspect)
        }
        WarpStyle::ArcLower => (u, v + b * edge * (1.0 + v) / 2.0),
        WarpStyle::ArcUpper => (u, v - b * edge * (1.0 - v) / 2.0),
        WarpStyle::Arch => (u, v - b * edge),
        WarpStyle::Bulge => (u, v + b * edge * v),
        WarpStyle::ShellLower => (u, v - b * u * u * (1.0 + v) / 2.0),
        WarpStyle::ShellUpper => (u, v + b * u * u * (1.0 - v) / 2.0),
        WarpStyle::Flag => (u, v - b * 0.5 * (PI * u).sin()),
        // A wave whose swing grows down the box.
        WarpStyle::Wave => (u, v - b * 0.5 * (PI * u).sin() * (1.0 + v) / 2.0),
        WarpStyle::Fish => {
            // A body swelling towards the head (left) and a pinched tail.
            let swell = (PI * (u + 1.0) / 2.0).sin() * (1.0 - u) / 2.0;
            (u, v * (1.0 + b * swell))
        }
        WarpStyle::Rise => (u, v - b * 0.5 * (u + 1.0) * (1.0 - (u - 1.0).powi(2) / 4.0)),
        WarpStyle::Fisheye => {
            // A lens: the most at the centre, falling off fast, nothing
            // at the corners.
            let r2 = (u * u + v * v).min(2.0);
            let k = 1.0 + b * (1.0 - r2 / 2.0).powi(2);
            (u * k, v * k)
        }
        WarpStyle::Inflate => {
            // Blown up evenly: everything but the corners swells.
            let r2 = (u * u + v * v).min(2.0);
            let k = 1.0 + b * 0.5 * (1.0 - r2 / 2.0);
            (u * k, v * k)
        }
        WarpStyle::Squeeze => (
            u * (1.0 - b * 0.5 * (1.0 - v * v)),
            v * (1.0 + b * 0.5 * edge),
        ),
        WarpStyle::Twist => {
            let r = (u * u + v * v).sqrt().min(2f64.sqrt()) / 2f64.sqrt();
            let a = b * PI / 2.0 * (1.0 - r);
            let (s, c) = a.sin_cos();
            (u * c - v * s, u * s + v * c)
        }
    }
}

/// Warp a shape.
pub fn warp(shape: &Shape, p: &WarpParams) -> Shape {
    let Some(bx) = shape.bounds() else {
        return shape.clone();
    };
    if bx.width() <= 1e-9 || bx.height() <= 1e-9 {
        return shape.clone();
    }
    let b = f64::from(p.bend_pct.clamp(-100.0, 100.0)) / 100.0;
    let dh = f64::from(p.distort_h_pct.clamp(-100.0, 100.0)) / 100.0;
    let dv = f64::from(p.distort_v_pct.clamp(-100.0, 100.0)) / 100.0;
    let c = bx.center();
    let (hw, hh) = (bx.width() / 2.0, bx.height() / 2.0);
    let horizontal = p.horizontal;
    let style = p.style;
    let map = move |q: Point| -> Point {
        let (mut u, mut v) = ((q.x - c.x) / hw, (q.y - c.y) / hh);
        // Perspective first, as Illustrator's distortions read.
        v *= 1.0 + dh * u * 0.5;
        u *= 1.0 + dv * v * 0.5;
        let (u2, v2) = if horizontal {
            warp_point(style, b, u, v, hh / hw)
        } else {
            let (a, bb) = warp_point(style, b, v, u, hw / hh);
            (bb, a)
        };
        Point::new(c.x + u2 * hw, c.y + v2 * hh)
    };
    let out = map_nonlinear(shape, map, 0.05);
    if out.is_finite() {
        out
    } else {
        shape.clone()
    }
}
