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

//! EPS programs run end to end through `paged_ps::interpret`: shapes,
//! arcs, clipping, images through each filter, colour spaces, shadings,
//! Type 3 and Type 1 fonts, the substitute font, DSC, the limits, and
//! robustness against random input.
//!
//! The `__feat__images_graphics_eps_postscript` suffix links these tests
//! to the cockpit feature.

#![allow(non_snake_case)]

mod fonts;
mod images;
mod oracle;
mod programs;
mod robustness;

use paged_ps::{Art, Element, Options};

/// `body` as an EPS with a 0 0 100 100 bounding box.
pub fn eps(body: &str) -> Vec<u8> {
    eps_bytes(body.as_bytes())
}

pub fn eps_bytes(body: &[u8]) -> Vec<u8> {
    let mut v = b"%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 100 100\n%%EndComments\n".to_vec();
    v.extend_from_slice(body);
    v.extend_from_slice(b"\n%%EOF\n");
    v
}

pub fn run(body: &str) -> Art {
    match paged_ps::interpret(&eps(body), &Options::default()) {
        Ok(a) => a,
        Err(e) => panic!("{e}: {body}"),
    }
}

pub fn fills(art: &Art) -> Vec<&Element> {
    art.elements
        .iter()
        .filter(|e| matches!(e, Element::Fill { .. }))
        .collect()
}

pub fn bbox(p: &paged_ps::BezPath) -> [f64; 4] {
    let r = paged_ps::kurbo::Shape::bounding_box(p);
    [r.x0, r.y0, r.x1, r.y1]
}

pub fn near(a: [f64; 4], b: [f64; 4], tol: f64) -> bool {
    a.iter().zip(b.iter()).all(|(x, y)| (x - y).abs() <= tol)
}
