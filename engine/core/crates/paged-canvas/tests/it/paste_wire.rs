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

//! ADR 193 on the WIRE — `exportElements` (Copy, Cut) and
//! `pasteElements { snippet, pageId, center? }` (Paste, Paste in Place),
//! and the Alt-drag that commits as a paste (findings GF-2, GF-3).
//!
//! `paged-mutate/tests/it/item_snippet.rs` proves the copy itself. This
//! file proves what a host sees: the wire spelling, where the copy lands
//! (centred on the view point, or in place), the reply's `minted`, ONE undo
//! step through the model's own history, the paste into ANOTHER document,
//! and a group that Alt-drag duplicates whole.

use paged_canvas::{
    channel::Mutation, gesture::GestureType, CanvasModel, CanvasOptions, ElementId,
    GestureModifiers, PageId,
};
use paged_mutate::{PropertyPath, Value};

fn model(sample: &str) -> CanvasModel {
    let sample = paged_gen::samples::build(sample).expect("sample");
    let bytes = paged_gen::write_idml(&sample).expect("write idml");
    CanvasModel::load("adr190", &bytes, CanvasOptions::default()).expect("load")
}

fn page(m: &CanvasModel, i: usize) -> PageId {
    PageId(m.pages()[i].self_id.clone())
}

/// A top-level group on the first spread, and how many items it holds
/// (itself included).
fn top_group(m: &CanvasModel) -> String {
    let s = &m.scene().spreads[0].spread;
    s.frames_in_order
        .iter()
        .find_map(|r| match r {
            paged_model::FrameRef::Group(gi) => s.groups[*gi].self_id.clone(),
            _ => None,
        })
        .expect("geometry-groups has a top-level group")
}

fn group_count(m: &CanvasModel) -> usize {
    m.scene()
        .spreads
        .iter()
        .map(|p| p.spread.groups.len())
        .sum()
}

fn item_count(m: &CanvasModel) -> usize {
    m.scene()
        .spreads
        .iter()
        .map(|p| {
            let s = &p.spread;
            s.text_frames.len()
                + s.rectangles.len()
                + s.ovals.len()
                + s.graphic_lines.len()
                + s.polygons.len()
                + s.groups.len()
        })
        .sum()
}

/// `[top, left, bottom, right]` in page space, as the frame-bounds read
/// answers it.
fn bounds(m: &CanvasModel, id: &ElementId) -> [f32; 4] {
    let v = m
        .element_properties(id)
        .and_then(|p| {
            p.entries
                .into_iter()
                .find(|e| e.path == PropertyPath::FrameBounds)
        })
        .and_then(|e| e.value)
        .unwrap_or_else(|| panic!("{id:?} reads its bounds"));
    match v {
        Value::Bounds(b) => b,
        other => panic!("bounds read as {other:?}"),
    }
}

fn copy(m: &CanvasModel, ids: &[ElementId]) -> String {
    let (snippet, _, count) = m.export_elements(ids).expect("copy");
    assert_eq!(count as usize, ids.len());
    snippet
}

#[test]
fn the_wire_shape_is_paste_elements_with_a_snippet_a_page_and_an_optional_centre() {
    let m: Mutation = serde_json::from_str(
        r#"{"op":"pasteElements","args":{"snippet":"{}","pageId":"p1","center":[10.5,-20]}}"#,
    )
    .expect("the documented shape deserialises");
    match &m {
        Mutation::PasteElements {
            snippet,
            page_id,
            center,
        } => {
            assert_eq!(snippet, "{}");
            assert_eq!(page_id.as_str(), "p1");
            assert_eq!(*center, Some((10.5, -20.0)));
        }
        other => panic!("decoded as {other:?}"),
    }
    assert_eq!(m.wire_tag(), "pasteElements");
    let in_place: Mutation =
        serde_json::from_str(r#"{"op":"pasteElements","args":{"snippet":"{}","pageId":"p1"}}"#)
            .expect("no centre: in place");
    assert!(matches!(
        in_place,
        Mutation::PasteElements { center: None, .. }
    ));
}

#[test]
fn paste_centres_a_copied_group_on_the_view_point_in_one_undo_step() {
    let mut m = model("geometry-groups");
    let group = ElementId::Group(top_group(&m));
    let snippet = copy(&m, std::slice::from_ref(&group));
    let (groups, items) = (group_count(&m), item_count(&m));
    let page_id = page(&m, 0);

    let out = m
        .apply_mutation(&Mutation::PasteElements {
            snippet,
            page_id,
            center: Some((300.0, 400.0)),
        })
        .expect("paste");
    let pasted = out.created_id.clone().expect("created id");
    assert!(matches!(pasted, ElementId::Group(_)), "a group: {pasted:?}");
    assert_eq!(out.minted.len(), 1, "one root copy");
    assert_eq!(out.minted[0].element, pasted);
    assert_ne!(pasted, group);
    // The whole group: itself and its members.
    let source_items = items;
    assert_eq!(group_count(&m), groups + 1);
    assert!(item_count(&m) > source_items + 1, "members came along");
    let b = bounds(&m, &pasted);
    let centre = ((b[1] + b[3]) / 2.0, (b[0] + b[2]) / 2.0);
    assert!(
        (centre.0 - 300.0).abs() < 0.01 && (centre.1 - 400.0).abs() < 0.01,
        "centred on the view point: {centre:?}"
    );

    m.undo().expect("undo");
    assert_eq!(
        (group_count(&m), item_count(&m)),
        (groups, items),
        "one undo"
    );
    m.redo().expect("redo");
    assert!(
        m.element_properties(&pasted).is_some(),
        "redo brings back the same id"
    );
}

#[test]
fn paste_in_place_after_a_cut_lands_where_the_item_was() {
    let mut m = model("geometry");
    let rect = m.scene().spreads[0]
        .spread
        .rectangles
        .iter()
        .find_map(|r| r.self_id.clone())
        .map(ElementId::Rectangle)
        .expect("a rectangle");
    let before = bounds(&m, &rect);
    let snippet = copy(&m, std::slice::from_ref(&rect));
    m.apply_mutation(&Mutation::DeleteFrame {
        frame_id: rect.raw_id().to_string(),
    })
    .expect("cut");
    let page_id = page(&m, 0);
    let out = m
        .apply_mutation(&Mutation::PasteElements {
            snippet,
            page_id,
            center: None,
        })
        .expect("paste in place");
    let pasted = out.created_id.expect("created id");
    let after = bounds(&m, &pasted);
    for k in 0..4 {
        assert!(
            (after[k] - before[k]).abs() < 0.01,
            "{after:?} vs {before:?}"
        );
    }
}

#[test]
fn a_copy_pastes_into_another_document() {
    let source = model("geometry-groups");
    let group = ElementId::Group(top_group(&source));
    let snippet = copy(&source, &[group]);
    let mut target = model("geometry");
    let (groups, page_id) = (group_count(&target), page(&target, 0));
    let out = target
        .apply_mutation(&Mutation::PasteElements {
            snippet,
            page_id,
            center: Some((200.0, 200.0)),
        })
        .expect("paste into another document");
    assert_eq!(group_count(&target), groups + 1);
    assert!(matches!(out.created_id, Some(ElementId::Group(_))));
}

#[test]
fn copy_and_paste_say_why_they_refuse() {
    let mut m = model("geometry");
    let err = m
        .export_elements(&[ElementId::Rectangle("nope".into())])
        .expect_err("an unknown element");
    assert!(!err.is_empty());
    let page_id = page(&m, 0);
    let err = m
        .apply_mutation(&Mutation::PasteElements {
            snippet: "plain text".into(),
            page_id,
            center: None,
        })
        .expect_err("not a snippet");
    assert!(
        format!("{err:?}").contains("no page items"),
        "the refusal says why: {err:?}"
    );
}

// ── GF-2 / GF-3: Alt-drag commits as a paste ───────────────────────────

fn alt(on: bool) -> GestureModifiers {
    GestureModifiers {
        shift: false,
        alt: on,
        disable_snap: true,
    }
}

#[test]
fn gf2_alt_dragging_a_group_duplicates_the_group() {
    let mut m = model("geometry-groups");
    let group = ElementId::Group(top_group(&m));
    let (groups, items) = (group_count(&m), item_count(&m));
    let before = bounds(&m, &group);
    let h = m
        .begin_gesture(vec![group.clone()], GestureType::Translate, None)
        .expect("begin");
    m.update_gesture(h, (0.0, 120.0), alt(true))
        .expect("update");
    let outcome = m.commit_gesture(h).expect("an Alt-drag of a group commits");
    assert!(matches!(
        outcome.applied.op,
        paged_mutate::Operation::InsertSnippet { .. }
    ));
    assert_eq!(group_count(&m), groups + 1, "one more group");
    // The original stays put.
    let after = bounds(&m, &group);
    for k in 0..4 {
        assert!((after[k] - before[k]).abs() < 0.01);
    }
    let roots = paged_mutate::snippet_roots(&outcome.applied.op);
    assert_eq!(
        roots.len(),
        1,
        "the group is the one root (members ride it)"
    );
    let copy = ElementId::Group(roots[0].self_id().to_string());
    let b = bounds(&m, &copy);
    assert!(
        (b[0] - before[0] - 120.0).abs() < 0.01,
        "moved down by the drag"
    );
    m.undo().expect("undo");
    assert_eq!((group_count(&m), item_count(&m)), (groups, items));
}

#[test]
fn gf3_pressing_alt_again_mid_drag_on_a_grouped_item_duplicates_it_once() {
    let mut m = model("geometry-groups");
    let s = &m.scene().spreads[0].spread;
    let member = s
        .groups
        .iter()
        .flat_map(|g| g.members.iter())
        .find_map(|r| match r {
            paged_model::FrameRef::Rectangle(i) => {
                s.rectangles[*i].self_id.clone().map(ElementId::Rectangle)
            }
            paged_model::FrameRef::Polygon(i) => {
                s.polygons[*i].self_id.clone().map(ElementId::Polygon)
            }
            paged_model::FrameRef::Oval(i) => s.ovals[*i].self_id.clone().map(ElementId::Oval),
            _ => None,
        })
        .expect("a grouped leaf");
    let items = item_count(&m);
    let h = m
        .begin_gesture(vec![member], GestureType::Translate, None)
        .expect("begin");
    for (d, on) in [(20.0, true), (30.0, false), (40.0, true)] {
        m.update_gesture(h, (d, 0.0), alt(on)).expect("update");
    }
    m.commit_gesture(h).expect("commits");
    assert_eq!(item_count(&m), items + 1, "duplicated once");
}
