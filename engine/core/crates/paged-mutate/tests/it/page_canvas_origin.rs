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

//! Engine ADR 1011 — `PageCanvasOrigin`: a page's place on the canvas.
//! Forward stores the origin, the inverse restores the previous one
//! exactly (including "no origin", the default slot), and a malformed
//! value is refused, never stored.

use paged_model::{Bounds, Page, Spread};
use paged_mutate::{apply, NodeId, Operation, OperationError, PropertyPath, Value};
use paged_scene::{Document, ParsedSpread};

fn two_page_doc() -> Document {
    let mut doc = Document::default();
    for (i, id) in ["pA", "pB"].iter().enumerate() {
        let spread = Spread {
            self_id: Some(format!("s{i}")),
            pages: vec![Page::new(
                *id,
                Bounds {
                    top: 0.0,
                    left: 0.0,
                    bottom: 792.0,
                    right: 612.0,
                },
            )],
            ..Spread::default()
        };
        doc.spreads.push(ParsedSpread {
            src: format!("Spreads/Spread_s{i}.xml"),
            spread,
        });
    }
    doc
}

fn origin_of(doc: &Document, id: &str) -> Option<[f32; 2]> {
    doc.spreads
        .iter()
        .flat_map(|s| s.spread.pages.iter())
        .find(|p| p.self_id.as_deref() == Some(id))
        .expect("page present")
        .canvas_origin
}

fn place(id: &str, xy: Vec<f32>) -> Operation {
    Operation::SetProperty {
        node: NodeId::Page(id.to_string()),
        path: PropertyPath::PageCanvasOrigin,
        value: Value::Lengths(xy),
    }
}

#[test]
#[allow(non_snake_case)]
fn placing_a_page_round_trips__feat__layout_model_artboards() {
    let mut doc = two_page_doc();
    let applied = apply(&mut doc, &place("pB", vec![700.0, 0.0])).expect("place");
    assert_eq!(origin_of(&doc, "pB"), Some([700.0, 0.0]));
    assert_eq!(origin_of(&doc, "pA"), None, "the other page keeps its slot");
    assert!(applied.invalidation.structural);
    // The inverse is the default slot: an empty list.
    assert_eq!(applied.inverse, place("pB", Vec::new()));
    apply(&mut doc, &applied.inverse).expect("undo");
    assert_eq!(origin_of(&doc, "pB"), None);

    // Moving a placed page again: the inverse names the previous place.
    apply(&mut doc, &place("pB", vec![700.0, 0.0])).unwrap();
    let again = apply(&mut doc, &place("pB", vec![10.0, -20.0])).unwrap();
    assert_eq!(again.inverse, place("pB", vec![700.0, 0.0]));
}

#[test]
#[allow(non_snake_case)]
fn a_malformed_origin_is_refused__feat__layout_model_artboards() {
    let mut doc = two_page_doc();
    for bad in [vec![1.0], vec![1.0, 2.0, 3.0], vec![f32::NAN, 0.0]] {
        let err = apply(&mut doc, &place("pA", bad)).unwrap_err();
        assert!(
            matches!(err, OperationError::TypeMismatch { .. }),
            "{err:?}"
        );
    }
    let err = apply(
        &mut doc,
        &Operation::SetProperty {
            node: NodeId::Page("pA".into()),
            path: PropertyPath::PageCanvasOrigin,
            value: Value::Bounds([0.0; 4]),
        },
    )
    .unwrap_err();
    assert!(matches!(err, OperationError::TypeMismatch { .. }));
    assert!(matches!(
        apply(&mut doc, &place("nope", vec![0.0, 0.0])).unwrap_err(),
        OperationError::NodeNotFound(_)
    ));
    assert_eq!(origin_of(&doc, "pA"), None);
}
