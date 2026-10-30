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

//! Engine ADR 1043 — an appearance rides the native model: the layers come
//! back as written (kinds, order, paints, stroke settings, a layer's
//! effects, a switched-off layer), and an item without one writes no key,
//! so a document without appearances keeps its bytes and its state hash.

use idml_import::{Bounds, Rectangle, Spread};
use paged_model::appearance::{PaintLayer, PaintLayerKind};
use paged_model::effect_stack::{Effect, EffectEntry, GaussianBlurParams};
use paged_scene::{Document, ParsedSpread};

fn doc(layered: bool) -> Document {
    let mut rect = Rectangle::new(
        "rect",
        Bounds {
            top: 10.0,
            left: 10.0,
            bottom: 60.0,
            right: 110.0,
        },
    );
    if layered {
        let mut red = PaintLayer::fill("Color/Red");
        red.blend_mode = Some("Multiply".into());
        red.opacity = Some(40.0);
        red.effects
            .push(EffectEntry::new(Effect::GaussianBlur(GaussianBlurParams {
                radius_pt: 2.0,
            })));
        let mut blue = PaintLayer::stroke("Color/Blue", 6.0);
        blue.dash = vec![4.0, 2.0];
        blue.end_join = Some("RoundEndJoin".into());
        blue.enabled = false;
        rect.appearance = vec![
            PaintLayer::frame_stroke(),
            red,
            PaintLayer::frame_fill(),
            blue,
        ];
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
fn an_appearance_round_trips_through_the_native_model__feat__frames_paths_native_appearance() {
    let back = paged_store::from_bytes(&paged_store::to_bytes(&doc(true)).unwrap()).unwrap();
    let a = &back.spreads[0].spread.rectangles[0].appearance;
    let kinds: Vec<_> = a.iter().map(|l| l.kind).collect();
    assert_eq!(
        kinds,
        [
            PaintLayerKind::FrameStroke,
            PaintLayerKind::Fill,
            PaintLayerKind::FrameFill,
            PaintLayerKind::Stroke
        ]
    );
    assert_eq!(a[1].blend_mode.as_deref(), Some("Multiply"));
    assert_eq!(a[1].effects.len(), 1);
    assert_eq!(a[3].dash, [4.0, 2.0]);
    assert!(!a[3].enabled);
    assert_eq!(back.canonical_hash(), doc(true).canonical_hash());
}

#[test]
#[allow(non_snake_case)]
fn an_item_without_one_writes_no_key_and_hashes_as_before__feat__frames_paths_native_appearance() {
    let bytes = paged_store::to_bytes(&doc(false)).unwrap();
    assert!(!String::from_utf8_lossy(&bytes).contains("appearance"));
    let back = paged_store::from_bytes(&bytes).unwrap();
    assert_eq!(back.canonical_hash(), doc(false).canonical_hash());
    assert_ne!(doc(false).canonical_hash(), doc(true).canonical_hash());
}
