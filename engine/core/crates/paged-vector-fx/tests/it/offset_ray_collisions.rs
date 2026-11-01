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

//! Offset Path after other effects must not abort the engine.
//!
//! `flo_curves`'s `ray_collisions()` used to order the collisions of a ray
//! cast with a tolerance-based comparison that is not a total order, so
//! `sort_by` panicked ("user-provided comparison function does not correctly
//! implement a total order"), which cannot be caught under the wasm
//! worker's `panic = abort`. The pinned fork sorts them with a valid order.

use paged_model::effect_stack::Effect;
use paged_vector_fx::{apply_effect, Context, PaintRole, Shape};

use super::poly;

fn run(mut s: Shape, stack: &[Effect]) -> Shape {
    let mut paint = PaintRole::Keep;
    for e in stack {
        s = apply_effect(&s, e, &Context::default(), &mut paint);
    }
    s
}

fn rect_at(x: f32, y: f32, w: f32, h: f32) -> Shape {
    poly(&[(x, y), (x + w, y), (x + w, y + h), (x, y + h)])
}

#[test]
fn offset_path_after_warp_survives_a_rectangle_that_used_to_abort() {
    let out = run(
        rect_at(249.875, 171.375, 241.8036, 287.89938),
        &[
            Effect::Warp(Default::default()),
            Effect::OffsetPath(Default::default()),
        ],
    );
    assert!(!out.contours.is_empty(), "the offset outline is not empty");
}

#[test]
fn offset_path_after_twist_and_warp_survives_the_rectangles_that_used_to_abort() {
    for (x, y, w, h) in [
        (194.375, 49.875, 85.258896, 128.53462),
        (316.0, 304.25, 225.46326, 306.89536),
        (329.375, 203.0, 155.7059, 177.64706),
    ] {
        let out = run(
            rect_at(x, y, w, h),
            &[
                Effect::Twist(Default::default()),
                Effect::Warp(Default::default()),
                Effect::OffsetPath(Default::default()),
            ],
        );
        assert!(
            !out.contours.is_empty(),
            "({x}, {y}, {w}, {h}): the offset outline is not empty"
        );
    }
}

#[test]
fn offset_path_after_distorting_effects_never_panics_over_many_rectangles() {
    // A deterministic sweep (no RNG dependency); before the fix roughly
    // one rectangle in sixty aborted with Twist + Warp + Offset Path.
    let mut seed = 12345u64;
    let mut rnd = move || {
        seed = seed
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        ((seed >> 33) as f32) / (1u64 << 31) as f32
    };
    let stack = [
        Effect::Twist(Default::default()),
        Effect::Warp(Default::default()),
        Effect::OffsetPath(Default::default()),
    ];
    for _ in 0..300 {
        let x = (rnd() * 400.0 * 8.0).round() / 8.0;
        let y = (rnd() * 400.0 * 8.0).round() / 8.0;
        let (w, h) = (20.0 + rnd() * 300.0, 20.0 + rnd() * 300.0);
        let _ = run(rect_at(x, y, w, h), &stack);
    }
}
