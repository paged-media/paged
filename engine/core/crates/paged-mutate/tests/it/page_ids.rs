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

//! A page's copy and a new page take ids nothing in the document holds: a
//! copied spread's symbol instances get ids of their own, and an inserted
//! page's ids start past the whole shared `u<hex>` line (masters, layers
//! and the rest), not past the document spreads alone.

use std::collections::HashSet;

use paged_model::{FrameRef, Spread};
use paged_mutate::{apply, ids::u_hex_number, NodeId, Operation};
use paged_scene::Document;

fn sample(name: &str) -> Document {
    let s = paged_gen::samples::build(name).expect("sample");
    idml_import::import_idml_doc(&paged_gen::write_idml(&s).expect("write")).expect("import")
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

/// Every self id of the document spreads' pages and items, spread ids
/// included, in document order (duplicates kept).
fn spread_ids(doc: &Document) -> Vec<String> {
    let mut out = Vec::new();
    for parsed in &doc.spreads {
        let s = &parsed.spread;
        out.extend(s.self_id.clone());
        out.extend(s.pages.iter().filter_map(|p| p.self_id.clone()));
        out.extend(s.text_frames.iter().filter_map(|f| f.self_id.clone()));
        out.extend(s.rectangles.iter().filter_map(|f| f.self_id.clone()));
        out.extend(s.ovals.iter().filter_map(|f| f.self_id.clone()));
        out.extend(s.graphic_lines.iter().filter_map(|f| f.self_id.clone()));
        out.extend(s.polygons.iter().filter_map(|f| f.self_id.clone()));
        out.extend(s.groups.iter().filter_map(|f| f.self_id.clone()));
        out.extend(s.instances.iter().filter_map(|f| f.self_id.clone()));
    }
    out
}

fn assert_unique(ids: &[String]) {
    let mut seen = HashSet::new();
    for id in ids {
        assert!(seen.insert(id), "id {id} is in the document twice: {ids:?}");
    }
}

fn first_page(doc: &Document) -> String {
    doc.spreads[0].spread.pages[0]
        .self_id
        .clone()
        .expect("page id")
}

fn snapshot(doc: &Document) -> serde_json::Value {
    serde_json::json!({
        "spreads": doc.spreads.iter().map(|p| &p.spread).collect::<Vec<_>>(),
        "stories": doc.stories.iter().map(|s| (&s.self_id, &s.story)).collect::<Vec<_>>(),
        "symbols": doc.symbols,
    })
}

#[test]
fn a_copied_pages_symbol_instances_take_ids_of_their_own() {
    let mut doc = sample("geometry");
    let sources: Vec<NodeId> = {
        let s = &doc.spreads[0].spread;
        s.frames_in_order
            .iter()
            .filter(|r| !matches!(r, FrameRef::TextFrame(_)))
            .filter_map(|r| node_of(s, *r))
            .collect()
    };
    apply(
        &mut doc,
        &Operation::CreateSymbol {
            symbol_id: "Symbol/u1".into(),
            name: "Art".into(),
            sources,
            replace: true,
            instance_id: None,
            nine_slice: None,
        },
    )
    .expect("create the symbol");
    let source_instance = doc.spreads[0].spread.instances[0]
        .self_id
        .clone()
        .expect("instance id");
    let before = snapshot(&doc);

    let page = first_page(&doc);
    let applied = apply(
        &mut doc,
        &Operation::DuplicatePage {
            page,
            clone_spread_json: None,
        },
    )
    .expect("duplicate the page");
    let instances: Vec<&paged_model::SymbolInstance> = doc
        .spreads
        .iter()
        .flat_map(|s| s.spread.instances.iter())
        .collect();
    assert_eq!(instances.len(), 2, "the copy draws the symbol too");
    assert!(instances.iter().all(|i| i.symbol == "Symbol/u1"));
    let ids: Vec<&str> = instances
        .iter()
        .map(|i| i.self_id.as_deref().expect("an instance id"))
        .collect();
    assert_ne!(ids[0], ids[1], "the copy's instance has an id of its own");
    assert!(
        ids.contains(&source_instance.as_str()),
        "the source keeps its id"
    );
    assert_unique(&spread_ids(&doc));

    // Undo is exact, and redo lands the same ids.
    let after = snapshot(&doc);
    apply(&mut doc, &applied.inverse).expect("undo");
    assert_eq!(snapshot(&doc), before);
    apply(&mut doc, &applied.op).expect("redo");
    assert_eq!(snapshot(&doc), after);
}

#[test]
fn an_inserted_pages_ids_start_past_the_masters_and_the_layers() {
    let mut doc = sample("geometry");
    // Ids the document spreads do not hold: a layer's, and a master
    // spread's with an item on it, all past everything the sample has.
    let base = paged_mutate::ids::highest_u_hex_id(&doc) + 0x10;
    let (layer_id, master_id, item_id) = (
        format!("u{:x}", base),
        format!("u{:x}", base + 1),
        format!("u{:x}", base + 2),
    );
    doc.designmap.layers.push(paged_model::Layer {
        self_id: layer_id,
        name: Some("Extra".into()),
        visible: true,
        locked: false,
        printable: true,
        parent_id: None,
    });
    let mut master = paged_scene::ParsedMasterSpread {
        src: String::new(),
        self_id: master_id.clone(),
        spread: Spread::default(),
        name: None,
    };
    master.spread.self_id = Some(master_id.clone());
    master.spread.rectangles.push(paged_model::Rectangle::new(
        &item_id,
        paged_model::Bounds::ZERO,
    ));
    doc.master_spreads.insert(master_id, master);
    let floor = paged_mutate::ids::highest_u_hex_id(&doc);
    assert_eq!(floor, base + 2);
    assert!(
        spread_ids(&doc)
            .iter()
            .filter_map(|id| u_hex_number(id))
            .all(|n| n < base),
        "the document spreads alone sit below the layer and the master"
    );

    let applied = apply(
        &mut doc,
        &Operation::InsertPage {
            after_page_id: None,
            master_id: None,
            spread_self_id: None,
            page_self_id: None,
            restore_spread_json: None,
        },
    )
    .expect("insert a page");
    let Operation::InsertPage {
        spread_self_id: Some(spread),
        page_self_id: Some(page),
        ..
    } = &applied.op
    else {
        panic!("the applied op names the ids it minted");
    };
    for id in [spread, page] {
        assert!(
            u_hex_number(id).is_some_and(|n| n > floor),
            "{id} is not past the document's highest id ({floor:x})"
        );
    }
    assert_ne!(spread, page);
    assert_unique(&spread_ids(&doc));
}
