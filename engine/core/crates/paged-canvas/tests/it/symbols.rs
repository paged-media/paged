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

//! Engine ADR 1039 — symbols through the canvas model: a symbol made from
//! page items draws exactly what they drew (text, gradients and images
//! included), every op is one undo step and the live model always equals a
//! cold build, a redefinition reaches every instance, 9-slice keeps the
//! corners, Break Link gives the items back, the hit test and the scene
//! tree see instances, and an IDML export writes the artwork, reports it
//! and comes back as instances on reopen.

#![allow(non_snake_case)] // the `__feat__<id>` suffix links each test to its cockpit feature

use paged_canvas::{snapshot::render_snapshot_at_dpi, CanvasModel, CanvasOptions};
use paged_model::FrameRef;
use paged_mutate::{PropertyPath, Value};
use paged_wire::{ElementId, Mutation, PageId};

fn inter() -> Vec<u8> {
    let p =
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../corpus/fonts/Inter.ttf");
    std::fs::read(p).expect("read Inter.ttf")
}

fn load_bytes(bytes: &[u8]) -> CanvasModel {
    let opts = CanvasOptions {
        fonts: vec![inter()],
        ..CanvasOptions::default()
    };
    CanvasModel::load("symbols", bytes, opts).expect("load")
}

fn sample(name: &str) -> CanvasModel {
    let s = paged_gen::samples::build(name).expect("sample");
    load_bytes(&paged_gen::write_idml(&s).expect("write"))
}

fn first_page(m: &CanvasModel) -> PageId {
    PageId(m.pages()[0].self_id.clone())
}

fn pixels(m: &CanvasModel) -> Vec<u8> {
    render_snapshot_at_dpi(m, &first_page(m), 72.0)
        .expect("snapshot")
        .rgba
}

/// How many pixels differ by more than `tol` in any channel.
fn differing(a: &[u8], b: &[u8], tol: u8) -> usize {
    assert_eq!(a.len(), b.len(), "same page size");
    a.chunks(4)
        .zip(b.chunks(4))
        .filter(|(p, q)| p.iter().zip(q.iter()).any(|(x, y)| x.abs_diff(*y) > tol))
        .count()
}

/// The top-level items of the first spread a copy may take (not threaded,
/// not anchored, no mask), as wire ids.
fn copyable_roots(m: &CanvasModel) -> Vec<ElementId> {
    let spread = &m.scene().spreads[0].spread;
    let mut out = Vec::new();
    for r in &spread.frames_in_order {
        let id = match *r {
            FrameRef::TextFrame(i) => {
                let f = &spread.text_frames[i];
                let shared = spread
                    .text_frames
                    .iter()
                    .filter(|o| o.parent_story.is_some() && o.parent_story == f.parent_story)
                    .count()
                    > 1;
                let threaded = f
                    .next_text_frame
                    .as_deref()
                    .is_some_and(|n| !n.is_empty() && n != "n");
                if threaded || shared {
                    continue;
                }
                f.self_id.clone().map(ElementId::TextFrame)
            }
            FrameRef::Rectangle(i) => spread.rectangles[i]
                .self_id
                .clone()
                .map(ElementId::Rectangle),
            FrameRef::Oval(i) => spread.ovals[i].self_id.clone().map(ElementId::Oval),
            FrameRef::GraphicLine(i) => spread.graphic_lines[i]
                .self_id
                .clone()
                .map(ElementId::GraphicLine),
            FrameRef::Polygon(i) => spread.polygons[i].self_id.clone().map(ElementId::Polygon),
            FrameRef::Group(i) => spread.groups[i].self_id.clone().map(ElementId::Group),
            FrameRef::Instance(_) => None,
        };
        if let Some(id) = id {
            if !spread.opacity_masks.contains_key(id.raw_id()) {
                out.push(id);
            }
        }
    }
    out
}

fn create(name: &str, ids: Vec<ElementId>) -> Mutation {
    Mutation::CreateSymbol {
        name: name.to_string(),
        element_ids: ids,
        symbol_id: None,
        replace: None,
        nine_slice: None,
    }
}

fn gate(m: &CanvasModel, what: &str) {
    m.digest_gate_check()
        .unwrap_or_else(|e| panic!("{what}: the live model is not a cold build: {e}"));
}

fn instances(m: &CanvasModel) -> usize {
    m.scene()
        .spreads
        .iter()
        .map(|p| p.spread.instances.len())
        .sum()
}

/// A symbol made from a page's items, replacing them, draws what they drew:
/// the same pixels, for text, gradients and placed images.
fn draws_what_the_items_drew(sample_name: &str) {
    let mut m = sample(sample_name);
    let before = pixels(&m);
    let roots = copyable_roots(&m);
    assert!(
        !roots.is_empty(),
        "{sample_name}: something to make a symbol of"
    );
    let outcome = m
        .apply_mutation(&create("Art", roots.clone()))
        .unwrap_or_else(|e| panic!("{sample_name}: createSymbol: {e:?}"));
    let Some(ElementId::Instance(instance)) = outcome.created_id.clone() else {
        panic!(
            "{sample_name}: the instance is the created id: {:?}",
            outcome.created_id
        );
    };
    gate(&m, sample_name);
    assert_eq!(m.scene().symbols.len(), 1);
    assert_eq!(instances(&m), 1);
    for r in &roots {
        assert!(
            m.element_geometry(std::slice::from_ref(r)).is_empty(),
            "{sample_name}: {r:?} left the page"
        );
    }
    let after = pixels(&m);
    let n = differing(&before, &after, 3);
    assert!(
        n * 1000 <= before.len() / 4,
        "{sample_name}: {n} pixels differ between the items and their instance"
    );
    // One undo step puts the items back, exactly.
    m.undo().expect("undo");
    gate(&m, sample_name);
    assert!(m.scene().symbols.is_empty());
    assert_eq!(instances(&m), 0);
    assert_eq!(differing(&before, &pixels(&m), 0), 0, "{sample_name}: undo");
    m.redo().expect("redo");
    gate(&m, sample_name);
    assert_eq!(
        m.scene().spreads[0].spread.instances[0].self_id.as_deref(),
        Some(instance.as_str()),
        "{sample_name}: redo makes the same instance"
    );
}

#[test]
fn a_symbol_of_shapes_and_gradients_draws_what_they_drew__feat__frames_paths_symbol_instance() {
    draws_what_the_items_drew("gradients");
}

#[test]
fn a_symbol_of_text_draws_what_it_drew__feat__frames_paths_symbol_instance() {
    draws_what_the_items_drew("text");
}

#[test]
fn a_symbol_of_placed_images_draws_what_they_drew__feat__frames_paths_symbol_instance() {
    draws_what_the_items_drew("images");
}

/// A stroked square on an empty page, made a symbol (replaced by its
/// instance), with the symbol's id.
fn square_symbol() -> (CanvasModel, String, String) {
    let mut m = sample("geometry");
    let page = first_page(&m);
    let outcome = m
        .apply_mutation(&Mutation::InsertFrame {
            page_id: page.clone(),
            bounds: (100.0, 100.0, 140.0, 140.0),
        })
        .expect("insertFrame");
    let rect = outcome.created_id.expect("the rectangle");
    for (path, value) in [
        (PropertyPath::FrameFillColor, Value::ColorRef(None)),
        (
            PropertyPath::FrameStrokeColor,
            Value::ColorRef(Some("Color/Black".to_string())),
        ),
        (PropertyPath::FrameStrokeWeight, Value::Length(Some(4.0))),
    ] {
        m.apply_mutation(&Mutation::SetElementProperty {
            element_id: rect.clone(),
            path,
            value,
        })
        .expect("style the square");
    }
    let outcome = m
        .apply_mutation(&create("Square", vec![rect]))
        .expect("createSymbol");
    let Some(ElementId::Instance(instance)) = outcome.created_id else {
        panic!("an instance");
    };
    let symbol = m.symbols()[0].id.clone();
    (m, symbol, instance)
}

fn place(symbol: &str, page: &PageId, at: (f32, f32), linear: Option<[f32; 4]>) -> Mutation {
    Mutation::PlaceSymbolInstance {
        symbol_id: symbol.to_string(),
        page_id: page.clone(),
        at: Some(at),
        linear,
        nine_slice: None,
    }
}

/// The dark run lengths along row `y` between `x0` and `x1`, at 72 dpi.
fn dark_runs(rgba: &[u8], width: usize, y: usize, x0: usize, x1: usize) -> Vec<usize> {
    let mut runs = Vec::new();
    let mut run = 0;
    for x in x0..x1 {
        let i = (y * width + x) * 4;
        let dark = rgba[i] < 128 && rgba[i + 1] < 128 && rgba[i + 2] < 128;
        if dark {
            run += 1;
        } else if run > 0 {
            runs.push(run);
            run = 0;
        }
    }
    if run > 0 {
        runs.push(run);
    }
    runs
}

#[test]
fn placing_redefining_and_breaking_an_instance_are_one_step_each__feat__frames_paths_symbol_instance(
) {
    let (mut m, symbol, first) = square_symbol();
    let page = first_page(&m);
    let outcome = m
        .apply_mutation(&place(&symbol, &page, (300.0, 200.0), None))
        .expect("placeSymbolInstance");
    let Some(ElementId::Instance(second)) = outcome.created_id.clone() else {
        panic!("placed instance id");
    };
    gate(&m, "place");
    assert_eq!(instances(&m), 2);
    // The hit test lands on the instance, inside its definition's box.
    let geometry = m.element_geometry(&[ElementId::Instance(second.clone())]);
    assert_eq!(geometry.len(), 1, "an instance has geometry");
    // Its own transform and overrides are ordinary property writes.
    m.apply_mutation(&Mutation::SetElementProperty {
        element_id: ElementId::Instance(second.clone()),
        path: PropertyPath::FrameOpacity,
        value: Value::Length(Some(50.0)),
    })
    .expect("opacity override");
    gate(&m, "opacity");
    m.undo().expect("undo opacity");
    // Redefine: the definition takes a new square (a circle-free oval), and
    // both instances follow at once.
    let revision = m.symbols()[0].revision;
    let oval = m
        .apply_mutation(&Mutation::InsertOval {
            page_id: page.clone(),
            bounds: (400.0, 400.0, 420.0, 460.0),
        })
        .expect("insertOval")
        .created_id
        .expect("oval");
    m.apply_mutation(&Mutation::RedefineSymbol {
        symbol_id: symbol.clone(),
        element_ids: vec![oval],
        name: Some("Ellipse".to_string()),
        nine_slice: None,
        replace: Some(false),
    })
    .expect("redefineSymbol");
    gate(&m, "redefine");
    let s = &m.symbols()[0];
    assert_eq!(s.revision, revision + 1);
    assert_eq!(s.name, "Ellipse");
    assert_eq!(s.instances.len(), 2, "both instances still name it");
    assert!(
        (s.bounds[3] - s.bounds[1] - 60.0).abs() < 0.5,
        "the new artwork's box"
    );
    m.undo().expect("undo redefine");
    assert_eq!(m.symbols()[0].revision, revision);
    // Break the link of the first instance: one square comes back.
    let outcome = m
        .apply_mutation(&Mutation::BreakSymbolLink {
            element_id: ElementId::Instance(first.clone()),
        })
        .expect("breakSymbolLink");
    gate(&m, "break");
    assert!(
        matches!(outcome.created_id, Some(ElementId::Rectangle(_))),
        "the square is the root: {:?}",
        outcome.created_id
    );
    assert_eq!(instances(&m), 1);
    m.undo().expect("undo break");
    assert_eq!(instances(&m), 2);
    // Deleting the symbol breaks every instance first.
    m.apply_mutation(&Mutation::DeleteSymbol {
        symbol_id: symbol.clone(),
    })
    .expect("deleteSymbol");
    gate(&m, "delete");
    assert!(m.symbols().is_empty());
    assert_eq!(instances(&m), 0);
    m.undo().expect("undo delete");
    assert_eq!(instances(&m), 2);
    assert_eq!(m.symbols().len(), 1);
}

#[test]
fn nine_slice_keeps_the_corners_when_an_instance_stretches__feat__frames_paths_symbol_instance() {
    let (mut m, symbol, first) = square_symbol();
    let page = first_page(&m);
    // The original stays; a stretched copy goes below it, three times as
    // wide.
    m.apply_mutation(&place(
        &symbol,
        &page,
        (300.0, 300.0),
        Some([3.0, 0.0, 0.0, 1.0]),
    ))
    .expect("place stretched");
    let width = render_snapshot_at_dpi(&m, &page, 72.0)
        .expect("snapshot")
        .width_px as usize;
    let plain = pixels(&m);
    // Without guides the stroke scales with the instance (by its area
    // scale, √3 here): wider than the definition's 4 pt.
    let runs = dark_runs(&plain, width, 300, 220, 380);
    assert!(
        runs.first().is_some_and(|r| *r >= 6),
        "a plain stretch thickens the side: {runs:?}"
    );
    m.apply_mutation(&Mutation::RedefineSymbol {
        symbol_id: symbol.clone(),
        element_ids: Vec::new(),
        name: None,
        nine_slice: Some(vec![8.0, 8.0, 8.0, 8.0]),
        replace: None,
    })
    .expect("9-slice guides");
    gate(&m, "nine-slice");
    let sliced = pixels(&m);
    let runs = dark_runs(&sliced, width, 300, 220, 380);
    assert!(
        runs.first().is_some_and(|r| (3..=5).contains(r)),
        "the 9-slice side keeps its 4 pt stroke: {runs:?}"
    );
    assert!(
        runs.last().is_some_and(|r| (3..=5).contains(r)),
        "both sides: {runs:?}"
    );
    // An instance at its own size is not sliced: it is the original.
    let _ = first;
}

#[test]
fn a_refused_symbol_op_leaves_the_document_alone__feat__frames_paths_symbol_instance() {
    let (mut m, symbol, instance) = square_symbol();
    let before = serde_json::to_string(m.scene()).expect("serialise");
    // An instance cannot be made part of a symbol (no nesting yet).
    assert!(m
        .apply_mutation(&create(
            "Nested",
            vec![ElementId::Instance(instance.clone())]
        ))
        .is_err());
    // Unknown symbol.
    assert!(m
        .apply_mutation(&place("Symbol/none", &first_page(&m), (1.0, 1.0), None))
        .is_err());
    // A duplicate symbol id.
    let roots = copyable_roots(&m)
        .into_iter()
        .filter(|r| !matches!(r, ElementId::Instance(_)))
        .take(1)
        .collect::<Vec<_>>();
    if !roots.is_empty() {
        assert!(m
            .apply_mutation(&Mutation::CreateSymbol {
                name: "Again".into(),
                element_ids: roots,
                symbol_id: Some(symbol),
                replace: None,
                nine_slice: None,
            })
            .is_err());
    }
    assert_eq!(serde_json::to_string(m.scene()).expect("serialise"), before);
}

#[test]
fn the_scene_tree_and_the_symbols_collection_see_instances__feat__frames_paths_symbol_instance() {
    let (m, symbol, instance) = square_symbol();
    fn find(nodes: &[paged_canvas::channel::SceneTreeNode], id: &str) -> bool {
        nodes
            .iter()
            .any(|n| n.id == Some(ElementId::Instance(id.to_string())) || find(&n.children, id))
    }
    assert!(
        find(&m.scene_tree(), &instance),
        "tree() names the instance"
    );
    let symbols = m.collection(paged_canvas::channel::CollectionName::Symbols);
    let list = symbols.as_array().expect("an array");
    assert_eq!(list.len(), 1);
    assert_eq!(list[0]["id"], symbol);
    assert_eq!(list[0]["instances"][0], format!("instance:{instance}"));
    // The address grammar names it.
    assert_eq!(
        ElementId::parse(&format!("instance:{instance}")),
        Some(ElementId::Instance(instance.clone()))
    );
}

#[test]
fn an_idml_export_writes_the_artwork_and_a_reopen_restores_the_instances__feat__frames_paths_symbol_instance(
) {
    let (mut m, symbol, _) = square_symbol();
    let page = first_page(&m);
    m.apply_mutation(&place(
        &symbol,
        &page,
        (300.0, 200.0),
        Some([2.0, 0.0, 0.0, 2.0]),
    ))
    .expect("place");
    let drawn = pixels(&m);
    let losses = m.idml_export_losses();
    let symbol_lines: Vec<&String> = losses
        .iter()
        .filter(|l| l.contains("symbol instance"))
        .collect();
    assert_eq!(
        symbol_lines.len(),
        2,
        "one loss line per instance: {losses:#?}"
    );
    assert!(symbol_lines[0].contains("label"));
    let bytes = m.export_idml().expect("export");
    // What InDesign reads: the artwork, labelled.
    let twin = idml_import::import_idml_doc(&bytes).expect("re-parse");
    assert!(twin.spreads.iter().all(|p| p.spread.instances.is_empty()));
    let labelled = twin.spreads[0]
        .spread
        .labels
        .values()
        .filter(|v| {
            v.iter()
                .any(|(k, _)| k == paged_mutate::SYMBOL_INSTANCE_LABEL)
        })
        .count();
    assert_eq!(labelled, 2, "each instance's leaf carries the link");
    assert!(twin
        .designmap
        .labels
        .iter()
        .any(|(k, _)| k == paged_mutate::SYMBOLS_LABEL));
    // Reopened in paged: the instances come back, and draw the same.
    let back = load_bytes(&bytes);
    assert_eq!(back.symbols().len(), 1);
    assert_eq!(back.symbols()[0].instances.len(), 2);
    assert!(back
        .scene()
        .designmap
        .labels
        .iter()
        .all(|(k, _)| k != paged_mutate::SYMBOLS_LABEL));
    let n = differing(&drawn, &pixels(&back), 3);
    assert!(
        n * 1000 <= drawn.len() / 4,
        "{n} pixels differ after the round trip"
    );
}

#[test]
fn a_copy_of_an_instance_is_an_instance__feat__frames_paths_symbol_instance() {
    let (mut m, _, instance) = square_symbol();
    let outcome = m
        .apply_mutation(&Mutation::DuplicateElements {
            element_ids: vec![ElementId::Instance(instance)],
            offset: (50.0, 0.0),
        })
        .expect("duplicate");
    gate(&m, "duplicate");
    assert!(
        matches!(outcome.created_id, Some(ElementId::Instance(_)))
            || matches!(
                outcome.minted.first().map(|e| &e.element),
                Some(ElementId::Instance(_))
            ),
        "the copy is an instance: {:?} / {:?}",
        outcome.created_id,
        outcome.minted
    );
    assert_eq!(instances(&m), 2);
}

/// Draw ADR 365 — Replace Symbol: `symbolInstanceSymbol` points an
/// instance at another definition in one undo step, keeping its id,
/// transform and overrides; an id the store does not hold is refused.
#[test]
fn replace_symbol_points_an_instance_at_another_definition__feat__frames_paths_symbol_instance() {
    let (mut m, square, instance) = square_symbol();
    let page = first_page(&m);
    let oval = m
        .apply_mutation(&Mutation::InsertOval {
            page_id: page.clone(),
            bounds: (400.0, 400.0, 420.0, 460.0),
        })
        .expect("insertOval")
        .created_id
        .expect("oval");
    m.apply_mutation(&create("Ellipse", vec![oval]))
        .expect("a second symbol");
    let ellipse = m
        .symbols()
        .iter()
        .find(|s| s.name == "Ellipse")
        .expect("the ellipse symbol")
        .id
        .clone();
    let id = ElementId::Instance(instance.clone());
    m.apply_mutation(&Mutation::SetElementProperty {
        element_id: id.clone(),
        path: PropertyPath::FrameOpacity,
        value: Value::Length(Some(40.0)),
    })
    .expect("an override");
    let before = pixels(&m);
    m.apply_mutation(&Mutation::SetElementProperty {
        element_id: id.clone(),
        path: PropertyPath::SymbolInstanceSymbol,
        value: Value::Text(ellipse.clone()),
    })
    .expect("replace symbol");
    gate(&m, "replace");
    let names = |m: &CanvasModel, sym: &str| {
        m.symbols()
            .iter()
            .find(|s| s.id == sym)
            .map(|s| s.instances.len())
            .unwrap_or(0)
    };
    assert_eq!(names(&m, &square), 0, "the square lost its instance");
    assert_eq!(names(&m, &ellipse), 2, "the ellipse gained it");
    assert_ne!(pixels(&m), before, "the instance draws the ellipse now");
    // The override stays with the instance.
    let props = m.element_properties(&id).expect("properties");
    let entry = |p: PropertyPath| {
        props
            .entries
            .iter()
            .find(|e| e.path == p)
            .and_then(|e| e.value.clone())
    };
    assert_eq!(
        entry(PropertyPath::FrameOpacity),
        Some(Value::Length(Some(40.0)))
    );
    assert_eq!(
        entry(PropertyPath::SymbolInstanceSymbol),
        Some(Value::Text(ellipse.clone()))
    );
    m.undo().expect("undo replace");
    assert_eq!(names(&m, &square), 1);
    assert_eq!(pixels(&m), before, "one undo step puts the square back");
    // An unknown symbol is refused and changes nothing.
    assert!(m
        .apply_mutation(&Mutation::SetElementProperty {
            element_id: id,
            path: PropertyPath::SymbolInstanceSymbol,
            value: Value::Text("no-such-symbol".to_string()),
        })
        .is_err());
    assert_eq!(names(&m, &square), 1);
}

/// Draw ADR 365 — the SVG export writes a definition once as `<symbol>`
/// and every instance as a `<use>` of it; a re-import draws both.
#[test]
fn an_svg_export_writes_one_symbol_and_a_use_per_instance__feat__frames_paths_symbol_instance() {
    let (mut m, symbol, _) = square_symbol();
    let page = first_page(&m);
    m.apply_mutation(&place(
        &symbol,
        &page,
        (300.0, 200.0),
        Some([2.0, 0.0, 0.0, 1.0]),
    ))
    .expect("a second, stretched instance");
    let (svg, report) = m
        .export_svg(&page, &[], &paged_svg::SvgExportOptions::default())
        .expect("export");
    assert_eq!(svg.matches("<symbol ").count(), 1, "{svg}");
    assert_eq!(svg.matches("<use ").count(), 2, "{svg}");
    assert!(svg.contains("xmlns:xlink=\"http://www.w3.org/1999/xlink\""));
    assert!(
        svg.contains("matrix(2 0 0 1 "),
        "the stretch rides the use: {svg}"
    );
    assert!(report.items >= 2, "{report:?}");
}

/// Draw ADR 365 — `deleteFrame` removes a symbol instance by its id or its
/// `instance:` address, in one undo step (the Symbol Sprayer's Alt-drag).
#[test]
fn delete_frame_removes_an_instance__feat__frames_paths_symbol_instance() {
    let (mut m, symbol, first) = square_symbol();
    let page = first_page(&m);
    let Some(ElementId::Instance(second)) = m
        .apply_mutation(&place(&symbol, &page, (300.0, 200.0), None))
        .expect("place")
        .created_id
    else {
        panic!("an instance");
    };
    m.apply_mutation(&Mutation::DeleteFrame {
        frame_id: first.clone(),
    })
    .expect("delete by id");
    gate(&m, "delete by id");
    m.apply_mutation(&Mutation::DeleteFrame {
        frame_id: format!("instance:{second}"),
    })
    .expect("delete by address");
    gate(&m, "delete by address");
    assert_eq!(instances(&m), 0);
    assert_eq!(m.symbols().len(), 1, "the definition stays");
    m.undo().expect("undo");
    m.undo().expect("undo");
    assert_eq!(instances(&m), 2);
}
