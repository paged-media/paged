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

//! Envelope Distort (draw ADR 367): the box through a Bézier patch mesh.

use kurbo::Point;
use paged_model::effect_stack::{Effect, EffectEntry};
use paged_model::vector_effect::EnvelopeParams;
use paged_vector_fx::envelope::{envelope, envelope_point};
use paged_vector_fx::{apply_stack, Context, Shape};

use super::rect;

fn bent(rows: u32, columns: u32, edit: impl Fn(&mut Vec<[f32; 2]>)) -> EnvelopeParams {
    let mut mesh = EnvelopeParams::flat(rows, columns);
    edit(&mut mesh);
    EnvelopeParams {
        rows,
        columns,
        mesh,
    }
}

fn nodes(s: &Shape) -> Vec<Point> {
    s.contours[0].nodes.iter().map(|n| n.p).collect()
}

#[test]
fn a_flat_net_draws_the_item_as_drawn__feat__effects_transparency_live_vector_effects() {
    assert_eq!(envelope(&rect(), &EnvelopeParams::default()), rect());
    // The flat net written out maps every point onto itself.
    for (rows, columns) in [(1, 1), (2, 3), (4, 4)] {
        let net = EnvelopeParams::flat(rows, columns);
        for (u, v) in [(0.0, 0.0), (0.3, 0.7), (0.5, 0.5), (1.0, 1.0), (0.99, 0.01)] {
            let (x, y) = envelope_point(&net, rows, columns, u, v);
            assert!(
                (x - u).abs() < 1e-6 && (y - v).abs() < 1e-6,
                "{rows}×{columns} at ({u}, {v}): ({x}, {y})"
            );
        }
    }
}

#[test]
fn a_moved_corner_node_moves_the_box_corner__feat__effects_transparency_live_vector_effects() {
    // The rectangle is 100 × 60 at (100, 100).
    let p = bent(1, 1, |m| m[0] = [-0.1, -0.1]);
    let out = envelope(&rect(), &p);
    let n = nodes(&out);
    assert!((n[0] - Point::new(90.0, 94.0)).hypot() < 1e-6, "{:?}", n[0]);
    // The opposite corner stays.
    assert!(
        n.iter()
            .any(|q| (*q - Point::new(200.0, 160.0)).hypot() < 1e-6),
        "{n:?}"
    );
}

#[test]
fn an_inner_node_of_a_two_by_two_mesh_moves_the_centre__feat__effects_transparency_live_vector_effects(
) {
    // The centre node of a 2 × 2 net is row 3, column 3 of a 7 × 7 net.
    let p = bent(2, 2, |m| m[3 * 7 + 3] = [0.6, 0.4]);
    let (x, y) = envelope_point(&p.net(), 2, 2, 0.5, 0.5);
    assert!((x - 0.6).abs() < 1e-6 && (y - 0.4).abs() < 1e-6);
    // The box's corners do not move.
    for (u, v) in [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)] {
        let (x, y) = envelope_point(&p.net(), 2, 2, u, v);
        assert!((x - u).abs() < 1e-6 && (y - v).abs() < 1e-6);
    }
}

#[test]
fn a_bent_edge_is_followed_within_the_tolerance__feat__effects_transparency_live_vector_effects() {
    // Pull the top edge's two inner control points up by a fifth of the
    // height: the top edge becomes the cubic through them, and the cut
    // keeps the drawn outline within 0.05 pt of it.
    let p = bent(1, 1, |m| {
        m[1][1] = -0.2;
        m[2][1] = -0.2;
    });
    let out = envelope(&rect(), &p);
    // The mid-top of the box goes to the cubic's middle: y = 100 − 0.15 · 60.
    let top = out.contours[0]
        .nodes
        .iter()
        .map(|n| n.p.y)
        .fold(f64::INFINITY, f64::min);
    assert!((top - (100.0 - 0.15 * 60.0)).abs() < 0.05, "{top}");
    assert!(out.contours[0].nodes.len() > 4);
}

#[test]
fn the_stack_runs_an_envelope_entry__feat__effects_transparency_live_vector_effects() {
    let p = bent(1, 1, |m| m[15] = [1.2, 1.1]);
    let stack = vec![EffectEntry::new(Effect::Envelope(p.clone()))];
    let got = apply_stack(&rect(), &stack, &Context::default()).expect("effected");
    assert_eq!(got.shape, envelope(&rect(), &p));
    let n = nodes(&got.shape);
    assert!(
        n.iter()
            .any(|q| (*q - Point::new(220.0, 166.0)).hypot() < 1e-3),
        "{n:?}"
    );
}
