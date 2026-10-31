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

//! Engine ADR 1008 — the effect stack rides the native model: a custom
//! stack comes back as written (order, flags, parked parameters, the
//! stack-only effects), and an item in the canonical form writes no key,
//! so a document without the new effects keeps its bytes and its state
//! hash.

use idml_import::{Bounds, Rectangle, Spread};
use paged_model::effect_stack::{
    defaults, Effect, EffectBearing, EffectEntry, EffectTarget, GaussianBlurParams, IndesignEffect,
};
use paged_scene::{Document, ParsedSpread};

fn doc(custom: bool) -> Document {
    let mut rect = Rectangle {
        drop_shadow: Some(defaults::drop_shadow()),
        ..Rectangle::new(
            "rect",
            Bounds {
                top: 10.0,
                left: 10.0,
                bottom: 60.0,
                right: 110.0,
            },
        )
    };
    if custom {
        let disabled = EffectEntry {
            enabled: false,
            ..EffectEntry::new(Effect::slot(IndesignEffect::DropShadow))
        };
        rect.effect_slots_mut(EffectTarget::Object)
            .set_stack(vec![
                EffectEntry::new(Effect::GaussianBlur(GaussianBlurParams { radius_pt: 4.0 })),
                disabled,
            ])
            .unwrap();
    }
    let mut spread = Spread::default();
    spread.rectangles.push(rect);
    Document {
        spreads: vec![ParsedSpread {
            src: "Spreads/Spread_s1.xml".into(),
            spread,
        }],
        ..Default::default()
    }
}

#[test]
#[allow(non_snake_case)]
fn a_custom_stack_round_trips_through_the_native_model__feat__effects_transparency_effect_stack() {
    let back = paged_store::from_bytes(&paged_store::to_bytes(&doc(true)).unwrap()).unwrap();
    let r = &back.spreads[0].spread.rectangles[0];
    let kinds: Vec<_> = r
        .effect_stack
        .iter()
        .map(|e| e.effect.kind_name())
        .collect();
    assert_eq!(kinds, ["gaussianBlur", "dropShadow"]);
    assert!(!r.effect_stack[1].enabled);
    assert!(r.effect_stack[1].effect.has_parked());
    assert!(r.drop_shadow.is_none(), "a disabled shadow paints nothing");
    assert_eq!(back.canonical_hash(), doc(true).canonical_hash());
}

#[test]
fn a_canonical_item_writes_no_stack_and_hashes_as_before() {
    let bytes = paged_store::to_bytes(&doc(false)).unwrap();
    assert!(!String::from_utf8_lossy(&bytes).contains("effect_stack"));
    let back = paged_store::from_bytes(&bytes).unwrap();
    assert_eq!(back.canonical_hash(), doc(false).canonical_hash());
    assert_ne!(doc(false).canonical_hash(), doc(true).canonical_hash());
}
