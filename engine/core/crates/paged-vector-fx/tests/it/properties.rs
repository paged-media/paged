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

//! Properties over random outlines: every effect returns finite
//! geometry, the identity parameters change nothing, and a seeded effect
//! is a function of its seed.

use paged_model::effect_stack::{Effect, EffectEntry};
use paged_model::vector_effect::*;
use paged_vector_fx::{apply_effect, Context, PaintRole, Shape};
use proptest::prelude::*;

fn polygon() -> impl Strategy<Value = Shape> {
    prop::collection::vec((0.0f32..400.0, 0.0f32..400.0), 3..9).prop_map(|pts| super::poly(&pts))
}

fn every_effect() -> Vec<Effect> {
    vec![
        Effect::Roughen(RoughenParams::default()),
        Effect::ZigZag(ZigZagParams::default()),
        Effect::PuckerBloat(PuckerBloatParams { amount_pct: 60.0 }),
        Effect::Twist(TwistParams { angle_deg: 120.0 }),
        Effect::Tweak(TweakParams::default()),
        Effect::TransformCopies(TransformCopiesParams {
            copies: 2,
            rotate_deg: 15.0,
            ..Default::default()
        }),
        Effect::FreeDistort(FreeDistortParams {
            corners: [[0.1, 0.0], [1.0, 0.2], [0.9, 1.0], [0.0, 0.8]],
        }),
        Effect::Warp(WarpParams::default()),
        Effect::OffsetPath(OffsetPathParams::default()),
        Effect::OutlinePath(OutlinePathParams {}),
        Effect::RoundCorners(RoundCornersParams::default()),
        Effect::Scribble(ScribbleParams::default()),
        Effect::ConvertToShape(ConvertToShapeParams::default()),
    ]
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(24))]

    #[test]
    fn every_effect_returns_finite_geometry(shape in polygon()) {
        let ctx = Context {
            stroke: Some(Default::default()),
        };
        for e in every_effect() {
            let mut paint = PaintRole::Keep;
            let out = apply_effect(&shape, &e, &ctx, &mut paint);
            prop_assert!(out.is_finite(), "{}", e.kind_name());
        }
    }

    #[test]
    fn identity_parameters_change_nothing(shape in polygon()) {
        let ctx = Context::default();
        for e in [
            Effect::PuckerBloat(PuckerBloatParams { amount_pct: 0.0 }),
            Effect::Twist(TwistParams { angle_deg: 0.0 }),
            Effect::FreeDistort(FreeDistortParams::default()),
            Effect::RoundCorners(RoundCornersParams { radius: 0.0 }),
            Effect::OffsetPath(OffsetPathParams { offset: 0.0, ..Default::default() }),
        ] {
            let mut paint = PaintRole::Keep;
            let out = apply_effect(&shape, &e, &ctx, &mut paint);
            prop_assert_eq!(&out, &shape, "{}", e.kind_name());
        }
    }

    #[test]
    fn a_seed_draws_one_outline(shape in polygon(), seed in 0u32..1000) {
        let e = EffectEntry::new(Effect::Roughen(RoughenParams { seed, ..Default::default() }));
        let a = apply_effect(&shape, &e.effect, &Context::default(), &mut PaintRole::Keep);
        let b = apply_effect(&shape, &e.effect, &Context::default(), &mut PaintRole::Keep);
        prop_assert_eq!(a, b);
    }
}

#[test]
fn every_vector_kind_has_a_default_and_round_trips() {
    for kind in paged_model::vector_effect::VECTOR_KINDS {
        let e = Effect::vector_default(kind).unwrap_or_else(|| panic!("{kind}"));
        assert!(e.is_vector());
        assert_eq!(e.kind_name(), kind);
        let entry = EffectEntry::new(e);
        let json = serde_json::to_string(&entry).unwrap();
        let back: EffectEntry = serde_json::from_str(&json).unwrap();
        assert_eq!(back.effect.kind_name(), kind);
        // An entry written with only its kind reads its defaults.
        let bare: EffectEntry =
            serde_json::from_str(&format!("{{\"effect\":{{\"kind\":\"{kind}\"}}}}")).unwrap();
        assert_eq!(bare.effect.kind_name(), kind);
    }
}
