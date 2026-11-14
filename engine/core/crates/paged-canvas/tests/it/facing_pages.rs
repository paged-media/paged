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

//! Engine ADR 1312 — facing pages on an existing document: Document
//! Setup's Facing Pages lays every page out again, each page's items with
//! it, as one undo step; a page inserted into or removed from a facing
//! document keeps page 1 on the right and the pairs after it.

use paged_canvas::channel::{BindingEdgeWire, Mutation};
use paged_canvas::element_selection::ElementId;
use paged_canvas::{CanvasModel, CanvasOptions};
use paged_wire::PageId;

use BindingEdgeWire::{Left as R, Right as V};

/// A document of `n` single pages with a frame on each page, 30 pt in.
fn single_pages(n: u32) -> (CanvasModel, Vec<ElementId>) {
    let mut m =
        CanvasModel::new_blank_layout("single", 400.0, 600.0, n, false, CanvasOptions::default())
            .expect("a blank loads");
    let mut frames = Vec::new();
    for p in m.pages() {
        let id = m
            .apply_mutation(&Mutation::InsertFrame {
                page_id: PageId(p.self_id.clone()),
                bounds: (30.0, 30.0, 130.0, 230.0),
            })
            .expect("insert")
            .created_id
            .expect("created");
        frames.push(id);
    }
    (m, frames)
}

/// Each page's side and spread, in page order.
fn layout(m: &CanvasModel) -> Vec<(String, Option<BindingEdgeWire>, Option<String>)> {
    m.pages()
        .into_iter()
        .map(|p| (p.self_id, p.binding_edge, p.spread_id))
        .collect()
}

fn sides(m: &CanvasModel) -> Vec<Option<BindingEdgeWire>> {
    layout(m).into_iter().map(|(_, side, _)| side).collect()
}

/// Which pages share a spread: the spread index of each page.
fn pairs(m: &CanvasModel) -> Vec<usize> {
    let mut seen: Vec<Option<String>> = Vec::new();
    layout(m)
        .into_iter()
        .map(
            |(_, _, spread)| match seen.iter().position(|s| *s == spread) {
                Some(i) => i,
                None => {
                    seen.push(spread);
                    seen.len() - 1
                }
            },
        )
        .collect()
}

/// Where a frame sits: its page, its box and its transform on that page.
type Place = (Option<String>, [f32; 4], Option<[f32; 6]>);

/// Where each frame sits: on which page, at which place on it.
fn places(m: &CanvasModel, frames: &[ElementId]) -> Vec<Place> {
    m.element_geometry(frames)
        .into_iter()
        // An identity transform and none place the item alike.
        .map(|g| {
            let m = g.item_transform.unwrap_or([1.0, 0.0, 0.0, 1.0, 0.0, 0.0]);
            (g.page_id.map(|p| p.0), g.bounds, Some(m))
        })
        .collect()
}

#[test]
fn facing_pages_on_an_existing_document_pairs_its_pages_and_keeps_every_item_in_place() {
    let (mut m, frames) = single_pages(5);
    let hash = m.scene().canonical_hash();
    let before = places(&m, &frames);
    let order: Vec<String> = m.pages().into_iter().map(|p| p.self_id).collect();
    assert_eq!(pairs(&m), [0, 1, 2, 3, 4]);
    let steps = m.applied_log_len();

    m.apply_mutation(&Mutation::SetFacingPages { facing: true })
        .expect("facing pages");
    assert_eq!(m.applied_log_len(), steps + 1, "one step");
    // Page 1 alone on the right, then left/right pairs.
    assert_eq!(pairs(&m), [0, 1, 1, 2, 2]);
    assert_eq!(sides(&m), [Some(R), Some(V), Some(R), Some(V), Some(R)]);
    let now: Vec<String> = m.pages().into_iter().map(|p| p.self_id).collect();
    assert_eq!(now, order, "the pages keep their order and ids");
    assert_eq!(
        places(&m, &frames),
        before,
        "every item stays on its page, in its place"
    );
    assert_eq!(
        m.scene().designmap.document_preference.facing_pages,
        Some(true)
    );

    // Undo puts the document back exactly; redo lays it out again.
    m.undo().expect("undo");
    assert_eq!(
        m.scene().canonical_hash(),
        hash,
        "undo restores the document"
    );
    assert_eq!(pairs(&m), [0, 1, 2, 3, 4]);
    m.redo().expect("redo");
    assert_eq!(pairs(&m), [0, 1, 1, 2, 2]);

    // Off again: one page per spread, every page binding on its left.
    m.apply_mutation(&Mutation::SetFacingPages { facing: false })
        .expect("single pages");
    assert_eq!(pairs(&m), [0, 1, 2, 3, 4]);
    assert_eq!(sides(&m), [Some(R); 5]);
    assert_eq!(places(&m, &frames), before);
    assert_eq!(
        m.scene().designmap.document_preference.facing_pages,
        Some(false)
    );

    // The IDML it saves opens as what it shows.
    m.apply_mutation(&Mutation::SetFacingPages { facing: true })
        .expect("facing again");
    let idml = m.export_idml().expect("export");
    let reopened = CanvasModel::load("reopened", &idml, CanvasOptions::default()).expect("reopen");
    assert_eq!(pairs(&reopened), [0, 1, 1, 2, 2]);
    assert_eq!(
        sides(&reopened),
        [Some(R), Some(V), Some(R), Some(V), Some(R)]
    );
    assert_eq!(
        reopened.scene().designmap.document_preference.facing_pages,
        Some(true)
    );
}

#[test]
fn a_page_inserted_into_a_facing_document_re_pairs_the_pages_after_it() {
    let mut m =
        CanvasModel::new_blank_layout("facing", 400.0, 600.0, 4, true, CanvasOptions::default())
            .expect("a facing blank loads");
    let hash = m.scene().canonical_hash();
    let ids: Vec<String> = m.pages().into_iter().map(|p| p.self_id).collect();
    assert_eq!(pairs(&m), [0, 1, 1, 2]);

    // After page 2, the verso of the first pair: the new page faces it,
    // and page 3 moves to the next spread's left.
    let out = m
        .apply_mutation(&Mutation::InsertPage {
            after_page_id: Some(PageId(ids[1].clone())),
            master_id: None,
        })
        .expect("insert");
    let order: Vec<String> = m.pages().into_iter().map(|p| p.self_id).collect();
    assert_eq!(order.len(), 5);
    assert_eq!(order[0], ids[0]);
    assert_eq!(order[1], ids[1]);
    assert_eq!(
        &order[3..],
        &ids[2..],
        "the pages after it keep their order"
    );
    let new_page = order[2].clone();
    assert!(!ids.contains(&new_page));
    assert_eq!(
        out.created_pages
            .iter()
            .map(|p| p.0.clone())
            .collect::<Vec<_>>(),
        [new_page],
        "the reply names the page it made"
    );
    assert_eq!(pairs(&m), [0, 1, 1, 2, 2]);
    assert_eq!(sides(&m), [Some(R), Some(V), Some(R), Some(V), Some(R)]);

    m.undo().expect("undo");
    assert_eq!(
        m.scene().canonical_hash(),
        hash,
        "undo restores the spreads"
    );
    m.redo().expect("redo");
    let redone: Vec<String> = m.pages().into_iter().map(|p| p.self_id).collect();
    assert_eq!(redone, order, "redo makes the same page");
}

#[test]
fn a_page_removed_from_a_facing_document_takes_its_items_and_re_pairs_the_rest() {
    let (mut m, frames) = single_pages(5);
    m.apply_mutation(&Mutation::SetFacingPages { facing: true })
        .expect("facing");
    let hash = m.scene().canonical_hash();
    let ids: Vec<String> = m.pages().into_iter().map(|p| p.self_id).collect();
    let before = places(&m, &frames);

    // Page 2 sits in a two-page spread; it goes with its frame.
    m.apply_mutation(&Mutation::DeletePage {
        page_id: PageId(ids[1].clone()),
    })
    .expect("a page of a facing spread can be removed");
    let order: Vec<String> = m.pages().into_iter().map(|p| p.self_id).collect();
    assert_eq!(
        order,
        [
            ids[0].clone(),
            ids[2].clone(),
            ids[3].clone(),
            ids[4].clone()
        ]
    );
    assert_eq!(pairs(&m), [0, 1, 1, 2]);
    assert_eq!(sides(&m), [Some(R), Some(V), Some(R), Some(V)]);
    let kept: Vec<ElementId> = [0usize, 2, 3, 4]
        .iter()
        .map(|&i| frames[i].clone())
        .collect();
    let expected: Vec<_> = [0usize, 2, 3, 4]
        .iter()
        .map(|&i| before[i].clone())
        .collect();
    assert_eq!(
        places(&m, &kept),
        expected,
        "the others stay in place on their pages"
    );
    assert!(
        m.element_geometry(&[frames[1].clone()]).is_empty(),
        "the removed page's frame went with it"
    );

    m.undo().expect("undo");
    assert_eq!(
        m.scene().canonical_hash(),
        hash,
        "undo restores page and frame"
    );
    // The only page stays.
    let (mut one, _) = single_pages(1);
    one.apply_mutation(&Mutation::SetFacingPages { facing: true })
        .expect("facing");
    let only = one.pages()[0].self_id.clone();
    assert!(one
        .apply_mutation(&Mutation::DeletePage {
            page_id: PageId(only)
        })
        .is_err());
}
