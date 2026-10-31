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

//! Engine ADR 1007 — paint model v2 rides the native model: a stop's
//! opacity and inline colour, a conic gradient and a stroke's gradient
//! mode come back as written, and a document that uses none of them
//! writes no key (its bytes and its state hash are those of a document
//! saved before paint v2 existed).

use idml_import::{Bounds, GraphicLine, Rectangle, Spread};
use paged_model::{
    ColorSpace, GradientEntry, GradientKind, GradientStopRef, InlineStopColor, StrokeGradientMode,
};
use paged_scene::{Document, ParsedSpread};

fn bounds() -> Bounds {
    Bounds {
        top: 10.0,
        left: 10.0,
        bottom: 60.0,
        right: 110.0,
    }
}

fn doc(v2: bool) -> Document {
    let mut spread = Spread::default();
    let mode = if v2 {
        StrokeGradientMode::Along
    } else {
        StrokeGradientMode::Within
    };
    spread.rectangles.push(Rectangle {
        gradient_stroke_mode: mode,
        ..Rectangle::new("rect", bounds())
    });
    spread.graphic_lines.push(GraphicLine {
        gradient_stroke_mode: if v2 {
            StrokeGradientMode::Across
        } else {
            StrokeGradientMode::Within
        },
        ..GraphicLine::new("line", bounds())
    });
    let mut d = Document {
        spreads: vec![ParsedSpread {
            src: "Spreads/Spread_s1.xml".into(),
            spread,
        }],
        ..Default::default()
    };
    let mut fade = GradientStopRef::swatch("Color/Black", 100.0, None);
    let mut first = GradientStopRef::swatch("Color/Black", 0.0, None);
    if v2 {
        fade.opacity_pct = Some(0.0);
        first.stop_color = String::new();
        first.inline_color = Some(InlineStopColor {
            space: ColorSpace::Rgb,
            value: vec![255.0, 0.0, 0.0],
        });
    }
    d.palette.gradients.insert(
        "Gradient/Fade".into(),
        GradientEntry {
            self_id: "Gradient/Fade".into(),
            name: Some("Fade".into()),
            kind: if v2 {
                GradientKind::Conic
            } else {
                GradientKind::Linear
            },
            stops: vec![first, fade],
        },
    );
    d
}

#[test]
#[allow(non_snake_case)]
fn paint_v2_round_trips_through_the_native_model__feat__color_swatches_paint_v2() {
    let back = paged_store::from_bytes(&paged_store::to_bytes(&doc(true)).unwrap()).unwrap();
    let s = &back.spreads[0].spread;
    assert_eq!(
        s.rectangles[0].gradient_stroke_mode,
        StrokeGradientMode::Along
    );
    assert_eq!(
        s.graphic_lines[0].gradient_stroke_mode,
        StrokeGradientMode::Across
    );
    let g = &back.palette.gradients["Gradient/Fade"];
    assert_eq!(g.kind, GradientKind::Conic);
    assert_eq!(g.stops[1].opacity_pct, Some(0.0));
    assert_eq!(
        g.stops[0].inline_color,
        Some(InlineStopColor {
            space: ColorSpace::Rgb,
            value: vec![255.0, 0.0, 0.0],
        })
    );
    assert_eq!(back.canonical_hash(), doc(true).canonical_hash());
}

#[test]
#[allow(non_snake_case)]
fn a_document_without_paint_v2_writes_no_key__feat__color_swatches_paint_v2() {
    let bytes = paged_store::to_bytes(&doc(false)).unwrap();
    let text = String::from_utf8_lossy(&bytes);
    for key in ["opacity_pct", "inline_color", "gradient_stroke_mode"] {
        assert!(!text.contains(key), "{key} is written only when used");
    }
    let back = paged_store::from_bytes(&bytes).expect("loads");
    let g = &back.palette.gradients["Gradient/Fade"];
    assert_eq!(g.stops[1].opacity_pct, None);
    assert_eq!(
        back.spreads[0].spread.rectangles[0].gradient_stroke_mode,
        StrokeGradientMode::Within
    );
    assert_eq!(doc(false).canonical_hash(), back.canonical_hash());
    assert_ne!(doc(false).canonical_hash(), doc(true).canonical_hash());
}
