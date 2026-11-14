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

//! The dry run of a write (engine ADR 1308): any mutation applied to a
//! sandbox — a copy of the document in a model of its own — and answered
//! as what it would create and remove and the outlines it would leave. The
//! document, its history and its revision are untouched; the write itself,
//! applied, leaves exactly what the preview showed.

use paged_canvas::channel::Mutation;
use paged_canvas::preview::PreviewQuery;
use paged_canvas::{CanvasModel, CanvasOptions, ElementId, PageId};
use paged_mutate::operation::PathAnchorSpec;
use paged_mutate::PathfinderKind;

fn model() -> CanvasModel {
    let sample = paged_gen::samples::build("geometry").expect("geometry sample");
    let bytes = paged_gen::write_idml(&sample).expect("write idml");
    CanvasModel::load("dry-run", &bytes, CanvasOptions::default()).expect("load")
}

/// Two overlapping closed quads inserted on page 1 as polygons:
/// (100,100)–(200,200) and (150,150)–(250,250).
fn two_overlapping(m: &mut CanvasModel) -> (ElementId, ElementId) {
    let page_id = PageId(m.pages()[0].self_id.clone());
    let corner = |p: [f32; 2]| PathAnchorSpec {
        anchor: p,
        left: p,
        right: p,
    };
    let mut quad = |x: f32, y: f32| {
        m.apply_mutation(&Mutation::InsertPath {
            page_id: page_id.clone(),
            anchors: vec![
                corner([x, y]),
                corner([x + 100.0, y]),
                corner([x + 100.0, y + 100.0]),
                corner([x, y + 100.0]),
            ],
            open: false,
            smooth: false,
        })
        .expect("insert path")
        .created_id
        .expect("created")
    };
    (quad(100.0, 100.0), quad(150.0, 150.0))
}

fn state(m: &CanvasModel) -> ([u8; 32], usize, u64) {
    (
        m.current_state_hash(),
        m.applied_log_len(),
        m.document_revision(),
    )
}

#[test]
fn a_union_previews_its_result_and_changes_nothing() {
    let mut m = model();
    let (a, b) = two_overlapping(&mut m);
    let before = state(&m);
    let union = Mutation::PathfinderBoolean {
        kept: a.clone(),
        others: vec![b.clone()],
        kind: PathfinderKind::Union,
    };
    let preview = m.preview(&PreviewQuery {
        mutation: union.clone(),
        items: vec![a.clone(), b.clone()],
        story: None,
    });
    assert!(preview.applied, "{:?}", preview.refused);
    // The kept item holds the result; the other is consumed.
    assert_eq!(preview.removed, vec![b.clone()]);
    let outline = preview
        .outlines
        .iter()
        .find(|o| o.id == a)
        .expect("the kept item's outline");
    // The union of two overlapping squares is an eight-sided outline.
    assert!(outline.anchors.len() >= 8, "{outline:?}");
    // Nothing moved in the document.
    assert_eq!(state(&m), before);
    assert!(m.path_anchors(&b).is_some(), "b is still there");
    // Applied, the write leaves what the preview showed: one undo step.
    m.apply_mutation(&union).expect("apply");
    assert_eq!(m.applied_log_len(), before.1 + 1);
    let applied = m.path_anchors(&a).expect("a");
    assert_eq!(applied.anchors.len(), outline.anchors.len());
    for (x, y) in applied.anchors.iter().zip(&outline.anchors) {
        assert_eq!(x.anchor, y.anchor);
    }
}

#[test]
fn a_region_verb_previews_the_items_it_would_mint() {
    let mut m = model();
    let (a, b) = two_overlapping(&mut m);
    let before = state(&m);
    let preview = m.preview(&PreviewQuery {
        mutation: Mutation::PathfinderDivide {
            element_ids: vec![b.clone(), a.clone()],
        },
        items: vec![a, b],
        story: None,
    });
    assert!(preview.applied, "{:?}", preview.refused);
    // Two overlapping squares divide into three regions.
    let made = preview.created.len() + (2 - preview.removed.len());
    assert!(made >= 3, "{preview:?}");
    assert!(preview.outlines.len() >= 3, "{:?}", preview.outlines);
    assert!(!preview.geometry.is_empty());
    assert_eq!(state(&m), before);
}

#[test]
fn a_refused_write_says_why_and_changes_nothing() {
    let m = model();
    let before = state(&m);
    let preview = m.preview(&PreviewQuery {
        mutation: Mutation::PathfinderBoolean {
            kept: ElementId::Rectangle("nope".into()),
            others: vec![ElementId::Rectangle("nada".into())],
            kind: PathfinderKind::Union,
        },
        items: Vec::new(),
        story: None,
    });
    assert!(!preview.applied);
    assert!(preview.refused.is_some_and(|r| !r.is_empty()));
    assert_eq!(state(&m), before);
}
