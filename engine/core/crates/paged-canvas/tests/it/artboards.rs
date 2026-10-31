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

//! Engine ADR 1011 — free page placement (artboards) through the canvas
//! model: `placePage` moves one page on the canvas and nothing else, the
//! handle, the pages collection and the build agree on where every page
//! sits, it is one undo step (a batch of them too), a `.paged` keeps it,
//! and the IDML export reports it as a loss.

#![allow(non_snake_case)] // the `__feat__<id>` suffix links each test to its cockpit feature

use paged_canvas::{CanvasModel, CanvasOptions};
use paged_wire::{Mutation, PageId};

fn load_bytes(bytes: &[u8]) -> CanvasModel {
    CanvasModel::load("artboards", bytes, CanvasOptions::default()).expect("load")
}

fn model() -> CanvasModel {
    let sample = paged_gen::samples::build("layout").expect("layout sample");
    let bytes = paged_gen::write_idml(&sample).expect("write");
    load_bytes(&bytes)
}

fn ids(m: &CanvasModel) -> Vec<String> {
    m.pages().into_iter().map(|p| p.self_id).collect()
}

fn origins(m: &CanvasModel) -> Vec<(f32, f32)> {
    m.handle().page_origins_pt
}

fn place(page: &str, at: Option<(f32, f32)>) -> Mutation {
    Mutation::PlacePage {
        page: PageId(page.to_string()),
        origin_pt: at,
    }
}

/// The default canvas layout: the vertical stack the editor always drew.
fn stacked(m: &CanvasModel) -> Vec<(f32, f32)> {
    let mut y = 0.0;
    m.handle()
        .page_sizes_pt
        .iter()
        .map(|(_, h)| {
            let at = (0.0, y);
            y += h + paged_model::CANVAS_PAGE_GAP_PT;
            at
        })
        .collect()
}

#[test]
fn an_unplaced_document_keeps_the_vertical_stack__feat__layout_model_artboards() {
    let m = model();
    assert!(ids(&m).len() >= 2, "the layout sample has several pages");
    assert_eq!(origins(&m), stacked(&m));
    let pages = m.pages();
    for (p, at) in pages.iter().zip(stacked(&m)) {
        assert_eq!(p.canvas_origin_pt, Some([at.0, at.1]));
        assert!(!p.canvas_placed);
    }
    assert!(
        m.idml_export_losses()
            .iter()
            .all(|l| !l.contains("on the canvas")),
        "an unplaced document reports no placement loss"
    );
}

#[test]
fn placing_a_page_moves_it_alone_in_one_undo_step__feat__layout_model_artboards() {
    let mut m = model();
    let before = origins(&m);
    let second = ids(&m)[1].clone();
    let outcome = m
        .apply_mutation(&place(&second, Some((900.0, -120.0))))
        .expect("placePage");
    assert!(
        outcome.page_structure_changed,
        "the editor's page grid refreshes"
    );
    let after = origins(&m);
    assert_eq!(after[1], (900.0, -120.0));
    for i in (0..after.len()).filter(|&i| i != 1) {
        assert_eq!(after[i], before[i], "page {i} did not move");
    }
    // The build carries it: what every presenter reads.
    assert_eq!(m.built().pages[1].canvas_origin, (900.0, -120.0));
    let summary = &m.pages()[1];
    assert_eq!(summary.canvas_origin_pt, Some([900.0, -120.0]));
    assert!(summary.canvas_placed);
    // The page order is movePage's, untouched.
    assert_eq!(summary.self_id, second);

    m.undo().expect("undo");
    assert_eq!(origins(&m), before);
    m.redo().expect("redo");
    assert_eq!(origins(&m)[1], (900.0, -120.0));

    // Back to the default slot.
    m.apply_mutation(&place(&second, None)).expect("unplace");
    assert_eq!(origins(&m), before);
    assert!(!m.pages()[1].canvas_placed);
}

#[test]
fn rearranging_every_artboard_is_one_undo_step__feat__layout_model_artboards() {
    let mut m = model();
    let before = origins(&m);
    let pages = ids(&m);
    let ops = pages
        .iter()
        .enumerate()
        .map(|(i, p)| place(p, Some((i as f32 * 700.0, 0.0))))
        .collect();
    m.apply_mutation(&Mutation::Batch { ops }).expect("batch");
    let grid = origins(&m);
    for (i, at) in grid.iter().enumerate() {
        assert_eq!(*at, (i as f32 * 700.0, 0.0));
    }
    m.undo().expect("one undo");
    assert_eq!(origins(&m), before);
}

#[test]
fn a_refused_placement_changes_nothing__feat__layout_model_artboards() {
    let mut m = model();
    let before = origins(&m);
    m.apply_mutation(&place("no-such-page", Some((1.0, 2.0))))
        .expect_err("an unknown page is refused");
    m.apply_mutation(&place(&ids(&m)[0], Some((f32::NAN, 0.0))))
        .expect_err("a non-finite origin is refused");
    assert_eq!(origins(&m), before);
}

#[test]
fn a_placed_page_is_kept_by_paged_and_reported_by_idml__feat__layout_model_artboards() {
    let mut m = model();
    let first = ids(&m)[0].clone();
    m.apply_mutation(&place(&first, Some((-800.0, 40.0))))
        .expect("placePage");
    m.refresh_model_part().expect("refresh model part");
    let bytes = m
        .export_paged(paged_canvas::channel::PROTOCOL_VERSION.0)
        .expect("export .paged");
    let reloaded = load_bytes(&bytes);
    assert_eq!(origins(&reloaded)[0], (-800.0, 40.0), ".paged keeps it");

    let losses = m.idml_export_losses();
    let line = losses
        .iter()
        .find(|l| l.contains(&format!("page `{first}`")) && l.contains("on the canvas"))
        .unwrap_or_else(|| panic!("a placement loss for {first}: {losses:#?}"));
    assert!(line.contains("[-800, 40]"), "{line}");
    // Through IDML the page opens in its default slot.
    let idml = m.export_idml().expect("export idml");
    let twin = load_bytes(&idml);
    assert_eq!(origins(&twin), stacked(&twin));
}

#[test]
fn a_placed_pages_copy_lands_beside_it__feat__layout_model_artboards() {
    let mut m = model();
    let first = ids(&m)[0].clone();
    m.apply_mutation(&place(&first, Some((100.0, 50.0))))
        .expect("placePage");
    let width = m.handle().page_sizes_pt[0].0;
    let outcome = m
        .apply_mutation(&Mutation::DuplicatePage {
            page: PageId(first.clone()),
        })
        .expect("duplicatePage");
    let copy = outcome.created_pages[0].0.clone();
    let i = ids(&m).iter().position(|p| *p == copy).expect("copy");
    assert_eq!(
        origins(&m)[i],
        (100.0 + width + paged_model::CANVAS_PAGE_GAP_PT, 50.0)
    );
}
