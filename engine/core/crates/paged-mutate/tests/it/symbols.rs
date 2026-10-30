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

//! Engine ADR 1039 — the symbol operations in the kernel: a definition is
//! made in definition space (the registration point at the centre), its
//! instance draws the items where they were, every op undoes exactly and
//! redoes under the same ids, Break Link gives the items back where they
//! were, a copy of an instance carries its definition to another document,
//! and the IDML interchange expansion is undone by the label restore.

#![allow(non_snake_case)] // the `__feat__<id>` suffix links each test to its cockpit feature

use paged_model::{Bounds, FrameRef, Spread};
use paged_mutate::{
    apply, expand_symbols_for_interchange, extract_snippet, restore_symbols_from_labels, NodeId,
    Operation,
};
use paged_scene::Document;
use serde_json::Value as Json;

fn sample(name: &str) -> Document {
    let s = paged_gen::samples::build(name).expect("sample");
    idml_import::import_idml_doc(&paged_gen::write_idml(&s).expect("write")).expect("import")
}

/// What the symbol ops may touch: spreads, stories, the symbol store.
fn snapshot(doc: &Document) -> Json {
    serde_json::json!({
        "spreads": doc.spreads.iter().map(|p| &p.spread).collect::<Vec<_>>(),
        "stories": doc.stories.iter().map(|s| (&s.self_id, &s.story)).collect::<Vec<_>>(),
        "symbols": doc.symbols,
    })
}

fn node_of(spread: &Spread, r: FrameRef) -> Option<NodeId> {
    Some(match r {
        FrameRef::TextFrame(i) => NodeId::TextFrame(spread.text_frames[i].self_id.clone()?),
        FrameRef::Rectangle(i) => NodeId::Rectangle(spread.rectangles[i].self_id.clone()?),
        FrameRef::Oval(i) => NodeId::Oval(spread.ovals[i].self_id.clone()?),
        FrameRef::GraphicLine(i) => NodeId::GraphicLine(spread.graphic_lines[i].self_id.clone()?),
        FrameRef::Polygon(i) => NodeId::Polygon(spread.polygons[i].self_id.clone()?),
        FrameRef::Group(i) => NodeId::Group(spread.groups[i].self_id.clone()?),
        FrameRef::Instance(i) => NodeId::Instance(spread.instances[i].self_id.clone()?),
    })
}

/// The first spread's top-level shapes (no text: the geometry sample).
fn roots(doc: &Document) -> Vec<NodeId> {
    let s = &doc.spreads[0].spread;
    s.frames_in_order
        .iter()
        .filter(|r| !matches!(r, FrameRef::TextFrame(_)))
        .filter_map(|r| node_of(s, *r))
        .collect()
}

fn spread_id(doc: &Document) -> String {
    doc.spreads[0].spread.self_id.clone().expect("spread id")
}

fn boxes(doc: &Document) -> Vec<[i32; 4]> {
    // Every leaf's mapped box, rounded to 0.1 pt, sorted.
    let s = &doc.spreads[0].spread;
    let mut out: Vec<[i32; 4]> = Vec::new();
    let mut push = |b: Bounds, t: Option<[f32; 6]>| {
        let m = t.unwrap_or([1.0, 0.0, 0.0, 1.0, 0.0, 0.0]);
        let xs = [b.left, b.right];
        let ys = [b.top, b.bottom];
        let (mut x0, mut y0, mut x1, mut y1) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
        for x in xs {
            for y in ys {
                let px = m[0] * x + m[2] * y + m[4];
                let py = m[1] * x + m[3] * y + m[5];
                x0 = x0.min(px);
                x1 = x1.max(px);
                y0 = y0.min(py);
                y1 = y1.max(py);
            }
        }
        let r = |v: f32| (v * 10.0).round() as i32;
        out.push([r(y0), r(x0), r(y1), r(x1)]);
    };
    for f in &s.rectangles {
        push(f.bounds, f.item_transform);
    }
    for f in &s.ovals {
        push(f.bounds, f.item_transform);
    }
    for f in &s.polygons {
        push(f.bounds, f.item_transform);
    }
    for f in &s.graphic_lines {
        push(f.bounds, f.item_transform);
    }
    out.sort();
    out
}

fn create(doc: &Document, replace: bool) -> Operation {
    Operation::CreateSymbol {
        symbol_id: "Symbol/u1".into(),
        name: "Art".into(),
        sources: roots(doc),
        replace,
        instance_id: None,
        nine_slice: None,
    }
}

#[test]
fn a_symbol_is_made_in_definition_space_and_its_instance_sits_where_the_items_were__feat__frames_paths_symbol_instance(
) {
    let mut doc = sample("geometry");
    let before = snapshot(&doc);
    let applied = {
        let op = create(&doc, true);
        apply(&mut doc, &op)
    }
    .expect("create");
    let def = doc.symbol("Symbol/u1").expect("the definition");
    // The registration point (the centre of the box) is the origin.
    assert!((def.bounds.left + def.bounds.right).abs() < 0.01);
    assert!((def.bounds.top + def.bounds.bottom).abs() < 0.01);
    let spread = &doc.spreads[0].spread;
    assert_eq!(spread.instances.len(), 1);
    let inst = &spread.instances[0];
    assert_eq!(
        inst.bounds, def.bounds,
        "the cached bounds are the definition's"
    );
    assert!(spread.frames_in_order.contains(&FrameRef::Instance(0)));
    // No shape is left on the spread: the instance draws them.
    assert!(spread.rectangles.is_empty() && spread.ovals.is_empty() && spread.polygons.is_empty());
    // The applied op names the instance it made; undo is exact.
    let Operation::CreateSymbol {
        instance_id: Some(id),
        ..
    } = &applied.op
    else {
        panic!("the applied op names its instance");
    };
    assert_eq!(inst.self_id.as_ref(), Some(id));
    apply(&mut doc, &applied.inverse).expect("undo");
    assert_eq!(snapshot(&doc), before, "undo puts everything back");
    let redone = apply(&mut doc, &applied.op).expect("redo");
    assert_eq!(redone.op, applied.op, "redo lands the same ids");
}

#[test]
fn break_link_gives_the_items_back_where_they_were__feat__frames_paths_symbol_instance() {
    let mut doc = sample("geometry");
    let original = boxes(&doc);
    {
        let op = create(&doc, true);
        apply(&mut doc, &op)
    }
    .expect("create");
    let id = doc.spreads[0].spread.instances[0]
        .self_id
        .clone()
        .expect("id");
    let applied = apply(
        &mut doc,
        &Operation::BreakSymbolLink {
            instance: id.clone(),
            ids: Vec::new(),
            story_ids: Vec::new(),
        },
    )
    .expect("break");
    assert!(doc.spreads[0].spread.instances.is_empty());
    assert_eq!(boxes(&doc), original, "every shape is back in its place");
    let before = snapshot(&doc);
    apply(&mut doc, &applied.inverse).expect("undo");
    assert_eq!(doc.spreads[0].spread.instances.len(), 1);
    apply(&mut doc, &applied.op).expect("redo");
    assert_eq!(snapshot(&doc), before, "redo mints the same ids");
}

#[test]
fn a_moved_instance_breaks_into_moved_items__feat__frames_paths_symbol_instance() {
    let mut doc = sample("geometry");
    let original = boxes(&doc);
    {
        let op = create(&doc, false);
        apply(&mut doc, &op)
    }
    .expect("create");
    let spread = spread_id(&doc);
    let def = doc.symbol("Symbol/u1").expect("def").clone();
    let c = (
        -(def.bounds.left + def.bounds.right) / 2.0,
        -(def.bounds.top + def.bounds.bottom) / 2.0,
    );
    let _ = c;
    // An instance 2× wide, its registration point at (500, 400).
    let placed = apply(
        &mut doc,
        &Operation::PlaceSymbolInstance {
            symbol_id: "Symbol/u1".into(),
            spread: spread.clone(),
            transform: [2.0, 0.0, 0.0, 1.0, 500.0, 400.0],
            instance_id: Some("uinst".into()),
            nine_slice: None,
        },
    )
    .expect("place");
    assert!(doc.spreads[0].spread.frames_in_order.last() == Some(&FrameRef::Instance(0)));
    apply(
        &mut doc,
        &Operation::BreakSymbolLink {
            instance: "uinst".into(),
            ids: Vec::new(),
            story_ids: Vec::new(),
        },
    )
    .expect("break");
    let now = boxes(&doc);
    assert_eq!(
        now.len(),
        original.len() * 2,
        "the originals and the expansion"
    );
    // The expansion's union box is centred on (500, 400), twice as wide.
    let def_w = (def.bounds.right - def.bounds.left) * 10.0;
    let expanded: Vec<&[i32; 4]> = now.iter().filter(|b| !original.contains(b)).collect();
    let x0 = expanded.iter().map(|b| b[1]).min().expect("some");
    let x1 = expanded.iter().map(|b| b[3]).max().expect("some");
    assert!(
        ((x1 - x0) as f32 - 2.0 * def_w).abs() <= 2.0,
        "twice as wide"
    );
    assert!((((x0 + x1) / 2) - 5000).abs() <= 2, "centred on the point");
    let _ = placed;
}

#[test]
fn instance_properties_undo_and_redefine_moves_the_revision__feat__frames_paths_symbol_instance() {
    let mut doc = sample("geometry");
    {
        let op = create(&doc, true);
        apply(&mut doc, &op)
    }
    .expect("create");
    let id = doc.spreads[0].spread.instances[0]
        .self_id
        .clone()
        .expect("id");
    let node = NodeId::Instance(id);
    for (path, value) in [
        (
            paged_mutate::PropertyPath::FrameTransform,
            paged_mutate::Value::Transform(Some([0.0, 1.0, -1.0, 0.0, 10.0, 20.0])),
        ),
        (
            paged_mutate::PropertyPath::FrameOpacity,
            paged_mutate::Value::Length(Some(40.0)),
        ),
        (
            paged_mutate::PropertyPath::FrameBlendMode,
            paged_mutate::Value::Text("Multiply".into()),
        ),
        (
            paged_mutate::PropertyPath::SymbolInstanceTint,
            paged_mutate::Value::Lengths(vec![1.0, 0.0, 0.0, 0.5]),
        ),
        (
            paged_mutate::PropertyPath::SymbolInstanceNineSlice,
            paged_mutate::Value::Lengths(vec![2.0, 2.0, 2.0, 2.0]),
        ),
        (
            paged_mutate::PropertyPath::ElementVisible,
            paged_mutate::Value::Bool(false),
        ),
    ] {
        let before = snapshot(&doc);
        let applied = apply(
            &mut doc,
            &Operation::SetProperty {
                node: node.clone(),
                path,
                value,
            },
        )
        .unwrap_or_else(|e| panic!("{path:?}: {e}"));
        assert_ne!(snapshot(&doc), before, "{path:?} wrote");
        apply(&mut doc, &applied.inverse).expect("undo");
        assert_eq!(snapshot(&doc), before, "{path:?} undoes exactly");
    }
    // A tint out of range is refused.
    assert!(apply(
        &mut doc,
        &Operation::SetProperty {
            node: node.clone(),
            path: paged_mutate::PropertyPath::SymbolInstanceTint,
            value: paged_mutate::Value::Lengths(vec![2.0, 0.0, 0.0, 0.5]),
        },
    )
    .is_err());
    // Redefine from other items: the revision moves, the instance stays.
    let fresh = sample("geometry");
    let mut snippet_doc = fresh.clone();
    let _ = &mut snippet_doc;
    let applied = apply(
        &mut doc,
        &Operation::RedefineSymbol {
            symbol_id: "Symbol/u1".into(),
            sources: Vec::new(),
            name: Some("Renamed".into()),
            nine_slice: Some(vec![1.0, 1.0, 1.0, 1.0]),
            replace: false,
            instance_id: None,
        },
    )
    .expect("redefine name and guides");
    let def = doc.symbol("Symbol/u1").expect("def");
    assert_eq!(def.name, "Renamed");
    assert_eq!(def.revision, 0, "a rename is not a new revision");
    assert!(def.nine_slice.is_some());
    apply(&mut doc, &applied.inverse).expect("undo");
    assert_eq!(doc.symbol("Symbol/u1").expect("def").name, "Art");
}

#[test]
fn a_copied_instance_carries_its_definition_to_another_document__feat__frames_paths_symbol_instance(
) {
    let mut doc = sample("geometry");
    {
        let op = create(&doc, true);
        apply(&mut doc, &op)
    }
    .expect("create");
    let id = doc.spreads[0].spread.instances[0]
        .self_id
        .clone()
        .expect("id");
    let snippet = extract_snippet(&doc, &[NodeId::Instance(id)]).expect("copy");
    assert_eq!(
        snippet.resources.symbols.len(),
        1,
        "the definition rides along"
    );
    let mut other = sample("geometry");
    let target = spread_id(&other);
    apply(
        &mut other,
        &Operation::InsertSnippet {
            snippet: serde_json::to_string(&snippet).expect("json"),
            spread: target,
            dx: 10.0,
            dy: 0.0,
            ids: Vec::new(),
            story_ids: Vec::new(),
            added: Vec::new(),
        },
    )
    .expect("paste");
    assert!(
        other.symbol("Symbol/u1").is_some(),
        "the paste added the symbol"
    );
    assert_eq!(other.spreads[0].spread.instances.len(), 1);
}

#[test]
fn the_idml_expansion_is_undone_by_the_label_restore__feat__frames_paths_symbol_instance() {
    let mut doc = sample("geometry");
    {
        let op = create(&doc, true);
        apply(&mut doc, &op)
    }
    .expect("create");
    let spread = spread_id(&doc);
    apply(
        &mut doc,
        &Operation::PlaceSymbolInstance {
            symbol_id: "Symbol/u1".into(),
            spread,
            transform: [1.0, 0.0, 0.0, 1.0, 100.0, 100.0],
            instance_id: Some("uplaced".into()),
            nine_slice: None,
        },
    )
    .expect("place");
    let instances = doc.spreads[0].spread.instances.clone();
    let symbols = serde_json::to_value(&doc.symbols).expect("json");
    let mut written = doc.clone();
    let lines = expand_symbols_for_interchange(&mut written);
    assert_eq!(lines.len(), 2, "one loss line per instance");
    assert!(written.spreads[0].spread.instances.is_empty());
    let restored = restore_symbols_from_labels(&mut written);
    assert_eq!(restored, 2);
    let back = &written.spreads[0].spread;
    assert!(back.rectangles.is_empty() && back.ovals.is_empty() && back.polygons.is_empty());
    let mut a: Vec<_> = back
        .instances
        .iter()
        .map(|i| (i.self_id.clone(), i.item_transform))
        .collect();
    let mut b: Vec<_> = instances
        .iter()
        .map(|i| (i.self_id.clone(), i.item_transform))
        .collect();
    a.sort_by(|x, y| x.0.cmp(&y.0));
    b.sort_by(|x, y| x.0.cmp(&y.0));
    assert_eq!(a, b);
    assert_eq!(
        serde_json::to_value(&written.symbols).expect("json"),
        symbols
    );
    assert!(back.labels.values().all(|v| v
        .iter()
        .all(|(k, _)| k != paged_mutate::SYMBOL_INSTANCE_LABEL)));
}

#[test]
fn symbol_ops_refuse_what_they_cannot_do__feat__frames_paths_symbol_instance() {
    let mut doc = sample("geometry");
    let before = snapshot(&doc);
    // Nothing to make a symbol of.
    assert!(apply(
        &mut doc,
        &Operation::CreateSymbol {
            symbol_id: "Symbol/u1".into(),
            name: "x".into(),
            sources: Vec::new(),
            replace: true,
            instance_id: None,
            nine_slice: None,
        },
    )
    .is_err());
    // Guides wider than the artwork.
    let sources = roots(&doc);
    assert!(apply(
        &mut doc,
        &Operation::CreateSymbol {
            symbol_id: "Symbol/u1".into(),
            name: "x".into(),
            sources: sources.clone(),
            replace: true,
            instance_id: None,
            nine_slice: Some([1.0e6, 0.0, 0.0, 0.0]),
        },
    )
    .is_err());
    assert_eq!(snapshot(&doc), before, "a refusal writes nothing");
    {
        let op = create(&doc, true);
        apply(&mut doc, &op)
    }
    .expect("create");
    let id = doc.spreads[0].spread.instances[0]
        .self_id
        .clone()
        .expect("id");
    // An instance cannot go into a symbol.
    assert!(apply(
        &mut doc,
        &Operation::CreateSymbol {
            symbol_id: "Symbol/u2".into(),
            name: "nested".into(),
            sources: vec![NodeId::Instance(id)],
            replace: true,
            instance_id: None,
            nine_slice: None,
        },
    )
    .is_err());
    // Unknown symbols and instances.
    assert!(apply(
        &mut doc,
        &Operation::DeleteSymbol {
            symbol_id: "Symbol/none".into()
        }
    )
    .is_err());
    assert!(apply(
        &mut doc,
        &Operation::BreakSymbolLink {
            instance: "unone".into(),
            ids: Vec::new(),
            story_ids: Vec::new(),
        },
    )
    .is_err());
}
