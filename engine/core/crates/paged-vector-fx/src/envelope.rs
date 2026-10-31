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

//! Envelope Distort (draw ADR 367): the item's bounding box bent through
//! a mesh of bicubic Bézier patches, Illustrator's Make with Mesh and Make
//! with Top Object. The net is in the box's unit square
//! ([`EnvelopeParams`]); a point of the box is found in its cell, and the
//! cell's sixteen control points map it through `paged-warp`'s patch
//! (`envelope::eval`), the one patch evaluator the image module's warps
//! use too. Curves are cut until the mapped cubic stays within 0.05 pt of
//! the mapped curve, as Warp's are.

use kurbo::Point;
use paged_model::vector_effect::EnvelopeParams;

use crate::shape::{map_nonlinear, Shape};

/// The point the envelope sends `(u, v)` (the box's unit square) to, in
/// the unit square. `net` is a `rows` × `columns` control net.
pub fn envelope_point(net: &[[f32; 2]], rows: u32, columns: u32, u: f64, v: f64) -> (f64, f64) {
    let (nr, nc) = (rows.max(1) as usize, columns.max(1) as usize);
    let stride = 3 * nc + 1;
    let cell = |t: f64, n: usize| -> (usize, f64) {
        let x = t * n as f64;
        let i = (x.floor().max(0.0) as usize).min(n - 1);
        (i, x - i as f64)
    };
    let (c, s) = cell(u, nc);
    let (r, t) = cell(v, nr);
    let mut patch = [[0.0f64; 2]; 16];
    for i in 0..4 {
        for j in 0..4 {
            let p = net[(3 * r + i) * stride + 3 * c + j];
            patch[i * 4 + j] = [f64::from(p[0]), f64::from(p[1])];
        }
    }
    paged_warp::envelope::eval(&patch, s, t)
}

/// Envelope a shape.
pub fn envelope(shape: &Shape, p: &EnvelopeParams) -> Shape {
    if p.mesh.is_empty() {
        return shape.clone();
    }
    let net = p.net();
    let Some(b) = shape.bounds() else {
        return shape.clone();
    };
    if b.width() <= 1e-9 || b.height() <= 1e-9 {
        return shape.clone();
    }
    let (rows, columns) = (p.rows, p.columns);
    let map = move |q: Point| -> Point {
        let (u, v) = ((q.x - b.x0) / b.width(), (q.y - b.y0) / b.height());
        let (x, y) = envelope_point(&net, rows, columns, u, v);
        Point::new(b.x0 + x * b.width(), b.y0 + y * b.height())
    };
    let out = map_nonlinear(shape, map, 0.05);
    if out.is_finite() {
        out
    } else {
        shape.clone()
    }
}
