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

//! ADR 193 — page-item snippets: `extract_snippet` (Copy, Cut) and
//! `Operation::InsertSnippet` (Paste).
//!
//! What is pinned: a paste is the whole copy (a group with its members and
//! nested groups, a text frame with a copy of its story) under fresh ids,
//! on top of the target spread, moved by the offset; it works after the
//! source is gone (Cut) and in another document, adding the styles and
//! swatches the items name where that document lacks them; undo removes
//! exactly what it added and redo brings back the same ids; Copy refuses
//! what a duplicate refuses, and items on different spreads.

use std::path::PathBuf;

use paged_model::FrameRef;
use paged_mutate::{
    apply, extract_snippet, parse_snippet, snippet_demand, snippet_roots, ItemSnippet, NodeId,
    Operation, SNIPPET_FORMAT,
};
use paged_scene::Document;
use serde_json::Value as Json;

fn fixture(name: &str) -> Document {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("corpus")
        .join("generated")
        .join(format!("{name}.idml"));
    let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    idml_import::import_idml_doc(&bytes).expect("open")
}

/// The whole document as a value: spreads, stories, styles, palette and
/// hyperlinks — what a paste may touch.
fn snapshot(doc: &Document) -> Json {
    let spreads: Vec<Json> = doc
        .spreads
        .iter()
        .map(|p| serde_json::json!({ "src": p.src, "spread": p.spread }))
        .collect();
    let stories: Vec<Json> = doc
        .stories
        .iter()
        .map(|s| serde_json::json!({ "id": s.self_id, "src": s.src, "story": s.story }))
        .collect();
    serde_json::json!({
        "spreads": spreads,
        "stories": stories,
        "styles": doc.styles,
        "palette": doc.palette,
        "hyperlinks": doc.designmap.hyperlinks,
    })
}

fn spread_id(doc: &Document, si: usize) -> String {
    doc.spreads[si]
        .spread
        .self_id
        .clone()
        .unwrap_or_else(|| doc.spreads[si].src.clone())
}

fn paste(snippet: &ItemSnippet, spread: String, dx: f32, dy: f32) -> Operation {
    Operation::InsertSnippet {
        snippet: serde_json::to_string(snippet).expect("a snippet serialises"),
        spread,
        dx,
        dy,
        ids: Vec::new(),
        story_ids: Vec::new(),
        added: Vec::new(),
    }
}

fn minted(op: &Operation) -> (Vec<String>, Vec<String>, Vec<String>) {
    match op {
        Operation::InsertSnippet {
            ids,
            story_ids,
            added,
            ..
        } => (ids.clone(), story_ids.clone(), added.clone()),
        other => panic!("expected the paste echoed, got {other:?}"),
    }
}

/// `(spread index, ref)` of a page item, by id.
fn locate(doc: &Document, id: &str) -> Option<(usize, FrameRef)> {
    for (si, parsed) in doc.spreads.iter().enumerate() {
        let s = &parsed.spread;
        let at = |ids: Vec<Option<&str>>| ids.iter().position(|x| *x == Some(id));
        if let Some(i) = at(s.text_frames.iter().map(|f| f.self_id.as_deref()).collect()) {
            return Some((si, FrameRef::TextFrame(i)));
        }
        if let Some(i) = at(s.rectangles.iter().map(|f| f.self_id.as_deref()).collect()) {
            return Some((si, FrameRef::Rectangle(i)));
        }
        if let Some(i) = at(s.ovals.iter().map(|f| f.self_id.as_deref()).collect()) {
            return Some((si, FrameRef::Oval(i)));
        }
        if let Some(i) = at(s
            .graphic_lines
            .iter()
            .map(|f| f.self_id.as_deref())
            .collect())
        {
            return Some((si, FrameRef::GraphicLine(i)));
        }
        if let Some(i) = at(s.polygons.iter().map(|f| f.self_id.as_deref()).collect()) {
            return Some((si, FrameRef::Polygon(i)));
        }
        if let Some(i) = at(s.groups.iter().map(|f| f.self_id.as_deref()).collect()) {
            return Some((si, FrameRef::Group(i)));
        }
    }
    None
}

fn id_of(doc: &Document, si: usize, r: FrameRef) -> String {
    let s = &doc.spreads[si].spread;
    match r {
        FrameRef::TextFrame(i) => s.text_frames[i].self_id.clone(),
        FrameRef::Rectangle(i) => s.rectangles[i].self_id.clone(),
        FrameRef::Oval(i) => s.ovals[i].self_id.clone(),
        FrameRef::GraphicLine(i) => s.graphic_lines[i].self_id.clone(),
        FrameRef::Polygon(i) => s.polygons[i].self_id.clone(),
        FrameRef::Group(i) => s.groups[i].self_id.clone(),
        FrameRef::Instance(i) => s.instances[i].self_id.clone(),
    }
    .expect("an item with an id")
}

/// The ids of the subtree at `id`, pre-order.
fn subtree(doc: &Document, id: &str) -> Vec<String> {
    let (si, r) = locate(doc, id).unwrap_or_else(|| panic!("no item {id}"));
    let spread = &doc.spreads[si].spread;
    let mut out = vec![id.to_string()];
    if let FrameRef::Group(gi) = r {
        for m in &spread.groups[gi].members {
            out.extend(subtree(doc, &id_of(doc, si, *m)));
        }
    }
    if let Some(children) = spread.nested_children.get(id) {
        for c in children {
            out.extend(subtree(doc, &id_of(doc, si, *c)));
        }
    }
    out
}

fn translation(m: Option<[f32; 6]>) -> (f32, f32) {
    m.map(|m| (m[4], m[5])).unwrap_or((0.0, 0.0))
}

fn transform_of(doc: &Document, id: &str) -> Option<[f32; 6]> {
    let (si, r) = locate(doc, id)?;
    let s = &doc.spreads[si].spread;
    match r {
        FrameRef::TextFrame(i) => s.text_frames[i].item_transform,
        FrameRef::Rectangle(i) => s.rectangles[i].item_transform,
        FrameRef::Oval(i) => s.ovals[i].item_transform,
        FrameRef::GraphicLine(i) => s.graphic_lines[i].item_transform,
        FrameRef::Polygon(i) => s.polygons[i].item_transform,
        FrameRef::Group(i) => s.groups[i].item_transform,
        FrameRef::Instance(i) => Some(s.instances[i].item_transform),
    }
}

/// The outermost group holding the most nested structure.
fn nested_group(doc: &Document) -> String {
    doc.spreads
        .iter()
        .flat_map(|p| p.spread.groups.iter())
        .filter(|g| g.members.iter().any(|m| matches!(m, FrameRef::Group(_))))
        .filter_map(|g| g.self_id.clone())
        .max_by_key(|id| subtree(doc, id).len())
        .expect("nested-groups carries a group of groups")
}

/// A plain (unthreaded) text frame with a story, and that story's id.
fn plain_text_frame(doc: &Document) -> (String, String) {
    doc.spreads
        .iter()
        .flat_map(|p| p.spread.text_frames.iter())
        .find_map(|f| {
            let id = f.self_id.clone()?;
            let story = f.parent_story.clone()?;
            extract_snippet(doc, &[NodeId::TextFrame(id.clone())])
                .is_ok()
                .then_some((id, story))
        })
        .expect("the fixture carries a plain, unthreaded text frame")
}

#[test]
fn a_group_pastes_whole_on_top_moved_by_the_offset() {
    let mut doc = fixture("nested-groups");
    let group = nested_group(&doc);
    let source_tree = subtree(&doc, &group);
    let (si, _) = locate(&doc, &group).expect("the group");
    let snippet = extract_snippet(&doc, &[NodeId::Group(group.clone())]).expect("copy");
    assert_eq!(snippet.format, SNIPPET_FORMAT);
    assert_eq!(snippet.spread.frames_in_order.len(), 1, "one root");
    assert_eq!(snippet_demand(&snippet).items, source_tree.len());
    let before = snapshot(&doc);

    let applied = {
        let op = paste(&snippet, spread_id(&doc, si), 40.0, 10.0);
        apply(&mut doc, &op)
    }
    .expect("the group pastes");
    let (ids, _, _) = minted(&applied.op);
    assert_eq!(ids.len(), source_tree.len(), "one id per node");
    let root = ids[0].clone();
    assert_eq!(
        snippet_roots(&applied.op),
        vec![NodeId::Group(root.clone())]
    );
    assert_eq!(
        subtree(&doc, &root),
        ids,
        "the copy's subtree is the minted ids"
    );
    for id in &ids {
        assert!(!source_tree.contains(id), "{id} is fresh");
    }
    // On top of the spread's z-order.
    let spread = &doc.spreads[si].spread;
    let (_, root_ref) = locate(&doc, &root).expect("the copy");
    assert_eq!(spread.frames_in_order.last(), Some(&root_ref));
    // Moved by the offset: the root group's own transform and every leaf
    // (spread space); a nested group rides its parent and keeps its own.
    for (s, c) in source_tree.iter().zip(&ids) {
        let (_, r) = locate(&doc, c).expect("a copy");
        let nested_group = *c != root && matches!(r, FrameRef::Group(_));
        let (sx, sy) = translation(transform_of(&doc, s));
        let (cx, cy) = translation(transform_of(&doc, c));
        let (dx, dy) = if nested_group {
            (0.0, 0.0)
        } else {
            (40.0, 10.0)
        };
        assert!(
            (cx - sx - dx).abs() < 1e-3 && (cy - sy - dy).abs() < 1e-3,
            "{c} sits ({dx}, {dy}) from {s}"
        );
    }
    // A nested group precedes its outer in the vec (the renderer brackets
    // innermost first).
    for (gi, g) in spread.groups.iter().enumerate() {
        for m in &g.members {
            if let FrameRef::Group(inner) = m {
                assert!(*inner < gi, "nested group {inner} precedes its outer {gi}");
            }
        }
    }

    let after = snapshot(&doc);
    let undone = apply(&mut doc, &applied.inverse).expect("undo");
    assert_eq!(snapshot(&doc), before, "undo removes the whole paste");
    apply(&mut doc, &undone.inverse).expect("redo");
    assert_eq!(snapshot(&doc), after, "redo brings back the same ids");
}

#[test]
fn a_cut_item_pastes_back_in_place_after_its_source_is_gone() {
    let mut doc = fixture("geometry-groups");
    let (si, rect) = doc
        .spreads
        .iter()
        .enumerate()
        .find_map(|(si, p)| {
            p.spread
                .rectangles
                .iter()
                .find_map(|r| r.self_id.clone())
                .map(|id| (si, id))
        })
        .expect("a rectangle");
    let node = NodeId::Rectangle(rect.clone());
    let snippet = extract_snippet(&doc, std::slice::from_ref(&node)).expect("copy");
    let source = transform_of(&doc, &rect);
    // Cut: the copy is taken, then the item deleted.
    apply(&mut doc, &Operation::RemoveNode { node }).expect("delete");
    assert!(locate(&doc, &rect).is_none());

    let applied = {
        let op = paste(&snippet, spread_id(&doc, si), 0.0, 0.0);
        apply(&mut doc, &op)
    }
    .expect("paste");
    let (ids, _, _) = minted(&applied.op);
    assert_eq!(ids.len(), 1);
    assert_eq!(
        transform_of(&doc, &ids[0]),
        source,
        "Paste in Place: where it was"
    );
}

#[test]
fn a_text_frame_pastes_into_another_document_with_its_story_and_styles() {
    let mut source_doc = fixture("text");
    let (frame, story) = plain_text_frame(&source_doc);
    // A style of the source's own, so the target certainly lacks one, and
    // based on another, so the copy has to follow the chain.
    let base = source_doc
        .styles
        .paragraph_styles
        .keys()
        .next()
        .cloned()
        .expect("a paragraph style");
    source_doc.styles.paragraph_styles.insert(
        "ParagraphStyle/uxaCopied".into(),
        paged_model::ParagraphStyleDef {
            based_on: Some(base.clone()),
            ..Default::default()
        },
    );
    if let Some(parsed) = source_doc.stories.iter_mut().find(|s| s.self_id == story) {
        parsed.story.paragraphs[0].paragraph_style = Some("ParagraphStyle/uxaCopied".into());
    }
    let snippet = extract_snippet(&source_doc, &[NodeId::TextFrame(frame.clone())]).expect("copy");
    assert!(
        snippet.resources.paragraph_styles.contains_key(&base),
        "the BasedOn chain travels too"
    );
    assert_eq!(snippet.stories.len(), 1);
    assert_eq!(snippet.stories[0].self_id, story);
    assert!(!snippet.text.is_empty(), "the copy carries its plain text");
    // Its paragraphs' styles travel with it.
    let named: Vec<String> = snippet.stories[0]
        .story
        .paragraphs
        .iter()
        .filter_map(|p| p.paragraph_style.clone())
        .collect();
    for id in &named {
        assert!(
            snippet.resources.paragraph_styles.contains_key(id),
            "{id} is in the snippet"
        );
    }

    let mut doc = fixture("geometry-groups");
    // A style the target lacks, so the paste has something to add.
    let missing: Vec<String> = named
        .iter()
        .filter(|id| !doc.styles.paragraph_styles.contains_key(*id))
        .cloned()
        .collect();
    assert!(missing.contains(&"ParagraphStyle/uxaCopied".to_string()));
    let before = snapshot(&doc);
    let stories_before = doc.stories.len();
    let applied = {
        let op = paste(&snippet, spread_id(&doc, 0), 0.0, 0.0);
        apply(&mut doc, &op)
    }
    .expect("paste");
    let (ids, story_ids, added) = minted(&applied.op);
    assert_eq!((ids.len(), story_ids.len()), (1, 1));
    assert_eq!(doc.stories.len(), stories_before + 1);
    let copy = doc
        .stories
        .iter()
        .find(|s| s.self_id == story_ids[0])
        .expect("the copied story");
    assert_eq!(
        serde_json::to_value(&copy.story).unwrap(),
        serde_json::to_value(&snippet.stories[0].story).unwrap(),
        "the same text and formatting"
    );
    for id in &missing {
        assert!(doc.styles.paragraph_styles.contains_key(id), "{id} added");
        assert!(added.contains(&format!("paragraphStyle:{id}")));
    }
    let undone = apply(&mut doc, &applied.inverse).expect("undo");
    assert_eq!(
        snapshot(&doc),
        before,
        "undo removes the frame, the story and the styles it added"
    );
    apply(&mut doc, &undone.inverse).expect("redo");
}

#[test]
fn an_item_on_a_layer_the_target_lacks_goes_to_the_default_layer() {
    let mut doc = fixture("geometry-groups");
    let rect = doc.spreads[0]
        .spread
        .rectangles
        .iter()
        .find_map(|r| r.self_id.clone())
        .expect("a rectangle");
    let mut snippet = extract_snippet(&doc, &[NodeId::Rectangle(rect)]).expect("copy");
    snippet.spread.rectangles[0].item_layer = Some("Layer/elsewhere".into());
    let applied = {
        let op = paste(&snippet, spread_id(&doc, 0), 5.0, 5.0);
        apply(&mut doc, &op)
    }
    .expect("paste");
    let (ids, _, _) = minted(&applied.op);
    let (si, r) = locate(&doc, &ids[0]).expect("the copy");
    let FrameRef::Rectangle(i) = r else {
        panic!("a rectangle")
    };
    assert_eq!(doc.spreads[si].spread.rectangles[i].item_layer, None);
}

#[test]
fn copy_refuses_what_a_duplicate_refuses_and_items_on_two_spreads() {
    let doc = fixture("text");
    // A threaded frame (one that a NextTextFrame names, or that names one).
    let threaded = doc
        .spreads
        .iter()
        .flat_map(|p| p.spread.text_frames.iter())
        .find(|f| {
            f.next_text_frame
                .as_deref()
                .is_some_and(|n| !n.is_empty() && n != "n")
        })
        .and_then(|f| f.self_id.clone());
    if let Some(id) = threaded {
        let err = extract_snippet(&doc, &[NodeId::TextFrame(id)]).expect_err("refused");
        assert!(err.to_string().contains("threaded"), "{err}");
    }
    // Two spreads.
    let multi = fixture("geometry-groups");
    let mut per_spread = multi.spreads.iter().filter_map(|p| {
        p.spread
            .rectangles
            .iter()
            .find_map(|r| r.self_id.clone())
            .map(NodeId::Rectangle)
    });
    if let (Some(a), Some(b)) = (per_spread.next(), per_spread.next()) {
        let err = extract_snippet(&multi, &[a, b]).expect_err("refused");
        assert!(err.to_string().contains("different spreads"), "{err}");
    }
    // Not a page item.
    assert!(extract_snippet(&doc, &[NodeId::Spread("x".into())]).is_err());
}

#[test]
fn a_snippet_round_trips_as_json_and_foreign_text_is_refused() {
    let doc = fixture("geometry-groups");
    let rect = doc.spreads[0]
        .spread
        .rectangles
        .iter()
        .find_map(|r| r.self_id.clone())
        .expect("a rectangle");
    let snippet = extract_snippet(&doc, &[NodeId::Rectangle(rect)]).expect("copy");
    let json = serde_json::to_string(&snippet).expect("serialises");
    let back = parse_snippet(&json).expect("parses");
    assert_eq!(serde_json::to_string(&back).unwrap(), json);
    assert!(parse_snippet("hello").is_err(), "plain text is no snippet");
    let mut other = snippet.clone();
    other.format = "someone.else/1".into();
    let err = parse_snippet(&serde_json::to_string(&other).unwrap()).expect_err("refused");
    assert!(err.to_string().contains("someone.else/1"), "{err}");
    // A paste needs exactly the ids it mints.
    let mut doc = doc;
    let op = Operation::InsertSnippet {
        snippet: json,
        spread: spread_id(&doc, 0),
        dx: 0.0,
        dy: 0.0,
        ids: vec!["a".into(), "b".into()],
        story_ids: Vec::new(),
        added: Vec::new(),
    };
    assert!(apply(&mut doc, &op).is_err(), "two ids for one item");
}

/// Engine ADR 1036 — a snippet whose item carries an opacity mask (C-28)
/// pastes the mask with it: the mask item is copied under a fresh id,
/// listed in no z-order, and the copy's mask entry names it; an item's
/// name rides along. Undo removes both. The PDF import's place-as-vectors
/// (publish ADR 658) writes such snippets; Copy still refuses a masked
/// item, as a duplicate does.
#[test]
#[allow(non_snake_case)]
fn a_masked_named_item_pastes_with_its_mask_and_name__feat__editor_shell_import_svg_pdf_vectors() {
    let mut doc = fixture("geometry-groups");
    let (si, r) = (0..doc.spreads.len())
        .find_map(|si| {
            doc.spreads[si]
                .spread
                .frames_in_order
                .iter()
                .find(|r| matches!(r, FrameRef::Polygon(_)))
                .map(|r| (si, *r))
        })
        .expect("a polygon");
    let id = id_of(&doc, si, r);
    let mut snippet = extract_snippet(&doc, &[NodeId::Polygon(id.clone())]).expect("copy");
    // Give the copied polygon a mask item (a copy of itself, in no
    // z-order) and a name.
    let mut mask = snippet.spread.polygons[0].clone();
    mask.self_id = Some("mask-art".into());
    snippet.spread.polygons.push(mask);
    snippet.spread.opacity_masks.insert(
        id.clone(),
        paged_model::OpacityMask {
            mask_item: "mask-art".into(),
            mask_type: paged_model::OpacityMaskType::Alpha,
            invert: true,
            clip: true,
        },
    );
    snippet
        .spread
        .item_names
        .insert(id.clone(), "Placed art".into());
    assert_eq!(
        snippet_demand(&snippet).items,
        2,
        "the mask item is minted too"
    );
    let before = snapshot(&doc);
    let op = paste(&snippet, spread_id(&doc, si), 5.0, 5.0);
    let applied = apply(&mut doc, &op).expect("paste");
    let (ids, _, _) = minted(&applied.op);
    assert_eq!(ids.len(), 2);
    let spread = &doc.spreads[si].spread;
    let entry = spread
        .opacity_masks
        .get(&ids[0])
        .expect("the copy is masked");
    assert_eq!(entry.mask_item, ids[1], "by the copied mask item");
    assert_eq!(entry.mask_type, paged_model::OpacityMaskType::Alpha);
    assert!(entry.invert);
    let (_, mask_ref) = locate(&doc, &ids[1]).expect("the mask item exists");
    assert!(
        !doc.spreads[si].spread.frames_in_order.contains(&mask_ref),
        "a mask item paints only through its mask"
    );
    assert_eq!(
        doc.spreads[si]
            .spread
            .item_names
            .get(&ids[0])
            .map(String::as_str),
        Some("Placed art")
    );
    apply(&mut doc, &applied.inverse).expect("undo");
    assert_eq!(
        snapshot(&doc),
        before,
        "undo removes the mask with the item"
    );
}
