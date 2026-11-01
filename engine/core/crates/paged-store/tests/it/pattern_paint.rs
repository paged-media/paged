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

//! Engine ADR 1041 — a pattern swatch and a frame's pattern transform
//! ride the native model as written, and a document without them writes
//! no key (its bytes and state hash are those of a document saved before
//! patterns).

use idml_import::{Bounds, Rectangle, Spread};
use paged_model::{
    FillRule, PathAnchor, PatternColor, PatternEntry, PatternItem, PatternLayout, PatternPlacement,
};
use paged_scene::{Document, ParsedSpread};

fn pattern() -> PatternEntry {
    let p = |x: f32, y: f32| PathAnchor {
        anchor: (x, y),
        left: (x, y),
        right: (x, y),
    };
    PatternEntry {
        self_id: "Pattern/p".into(),
        name: Some("P".into()),
        width: 12.0,
        height: 8.0,
        layout: PatternLayout::default(),
        placement: PatternPlacement {
            rotation_deg: 45.0,
            ..Default::default()
        },
        items: vec![PatternItem {
            anchors: vec![p(0.0, 0.0), p(6.0, 0.0), p(3.0, 6.0)],
            subpath_starts: vec![],
            subpath_open: vec![],
            fill_rule: FillRule::EvenOdd,
            fill: Some(PatternColor::Swatch("Color/Black".into())),
            stroke: None,
            stroke_weight: 0.0,
        }],
    }
}

fn doc(with: bool) -> Document {
    let mut spread = Spread::default();
    spread.rectangles.push(Rectangle {
        fill_color: Some(if with { "Pattern/p" } else { "Color/Black" }.into()),
        pattern_transform: with.then_some([1.0, 0.0, 0.0, 1.0, 3.0, 0.0]),
        ..Rectangle::new(
            "rect",
            Bounds {
                top: 10.0,
                left: 10.0,
                bottom: 60.0,
                right: 110.0,
            },
        )
    });
    let mut d = Document {
        spreads: vec![ParsedSpread {
            src: "Spreads/Spread_s1.xml".into(),
            spread,
        }],
        ..Default::default()
    };
    if with {
        d.palette.patterns.insert("Pattern/p".into(), pattern());
    }
    d
}

#[test]
#[allow(non_snake_case)]
fn a_pattern_round_trips_through_the_native_model__feat__color_swatches_pattern_paint() {
    let back = paged_store::from_bytes(&paged_store::to_bytes(&doc(true)).unwrap()).unwrap();
    assert_eq!(back.palette.patterns.get("Pattern/p"), Some(&pattern()));
    assert_eq!(
        back.spreads[0].spread.rectangles[0].pattern_transform,
        Some([1.0, 0.0, 0.0, 1.0, 3.0, 0.0])
    );
    assert_eq!(back.canonical_hash(), doc(true).canonical_hash());
}

#[test]
#[allow(non_snake_case)]
fn a_document_without_a_pattern_writes_no_key__feat__color_swatches_pattern_paint() {
    let bytes = paged_store::to_bytes(&doc(false)).unwrap();
    let text = String::from_utf8_lossy(&bytes);
    assert!(!text.contains("patterns") && !text.contains("pattern_transform"));
    let back = paged_store::from_bytes(&bytes).expect("loads");
    assert!(back.palette.patterns.is_empty());
    assert_eq!(doc(false).canonical_hash(), back.canonical_hash());
    assert_ne!(doc(false).canonical_hash(), doc(true).canonical_hash());
}
