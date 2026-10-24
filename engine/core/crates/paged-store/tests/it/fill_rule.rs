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

//! Engine ADR 1006 — a frame's fill rule rides the native model: an
//! even-odd frame comes back even-odd, a non-zero one writes no key (so
//! every document saved before the rule existed, or without it, keeps its
//! bytes and its state hash), and a `.pgm` without the key reads non-zero.

use idml_import::{Bounds, Polygon, Rectangle, Spread, TextFrame};
use paged_model::FillRule;
use paged_scene::{Document, ParsedSpread};

fn bounds() -> Bounds {
    Bounds {
        top: 10.0,
        left: 10.0,
        bottom: 60.0,
        right: 110.0,
    }
}

fn doc(rule: FillRule) -> Document {
    let mut spread = Spread::default();
    spread.polygons.push(Polygon {
        fill_rule: rule,
        ..Polygon::new("poly", bounds())
    });
    spread.rectangles.push(Rectangle {
        fill_rule: rule,
        ..Rectangle::new("rect", bounds())
    });
    spread.text_frames.push(TextFrame {
        fill_rule: rule,
        ..TextFrame::new("frame", None, bounds())
    });
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
fn the_fill_rule_round_trips_through_the_native_model__feat__frames_paths_fill_rule_even_odd() {
    let back =
        paged_store::from_bytes(&paged_store::to_bytes(&doc(FillRule::EvenOdd)).unwrap()).unwrap();
    let s = &back.spreads[0].spread;
    assert_eq!(s.polygons[0].fill_rule, FillRule::EvenOdd);
    assert_eq!(s.rectangles[0].fill_rule, FillRule::EvenOdd);
    assert_eq!(s.text_frames[0].fill_rule, FillRule::EvenOdd);
}

#[test]
fn a_non_zero_frame_writes_no_key_and_an_old_pgm_reads_non_zero() {
    let bytes = paged_store::to_bytes(&doc(FillRule::NonZero)).unwrap();
    let text = String::from_utf8_lossy(&bytes);
    assert!(
        !text.contains("fill_rule"),
        "a non-zero frame serialises as it did before the rule existed"
    );
    let back = paged_store::from_bytes(&bytes).expect("loads");
    assert_eq!(
        back.spreads[0].spread.polygons[0].fill_rule,
        FillRule::NonZero
    );
    // The state hash (ADR 195) streams the same serde form, so it cannot
    // tell a non-zero document from one saved before the field existed;
    // an even-odd one differs.
    assert_eq!(
        doc(FillRule::NonZero).canonical_hash(),
        back.canonical_hash()
    );
    assert_ne!(
        doc(FillRule::NonZero).canonical_hash(),
        doc(FillRule::EvenOdd).canonical_hash()
    );
}
