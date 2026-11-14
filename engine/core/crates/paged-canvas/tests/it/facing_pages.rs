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
//! it, as one undo step; a page inserted into, removed from, moved or
//! duplicated in a facing document keeps page 1 on the right and the pairs
//! after it; a one-page master stays one page and shows alike on both
//! sides.

use paged_canvas::channel::{BindingEdgeWire, Mutation};
use paged_canvas::element_selection::ElementId;
use paged_canvas::{render_snapshot_png, CanvasModel, CanvasOptions};
use paged_mutate::{NodeId, NodeSpec, Operation};
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

fn ids(m: &CanvasModel) -> Vec<String> {
    m.pages().into_iter().map(|p| p.self_id).collect()
}

/// The master a page applies, as the scene holds it.
fn master_of(m: &CanvasModel, page: &str) -> Option<String> {
    m.scene()
        .spreads
        .iter()
        .flat_map(|s| s.spread.pages.iter())
        .find(|p| p.self_id.as_deref() == Some(page))
        .and_then(|p| p.applied_master.clone())
}

/// Every rectangle on `page`, with its place there.
fn rectangles_on(m: &CanvasModel, page: &str) -> Vec<Place> {
    let all: Vec<ElementId> = m
        .scene()
        .spreads
        .iter()
        .flat_map(|s| s.spread.rectangles.iter())
        .filter_map(|r| r.self_id.clone().map(ElementId::Rectangle))
        .collect();
    places(m, &all)
        .into_iter()
        .filter(|(on, _, _)| on.as_deref() == Some(page))
        .collect()
}

#[test]
fn a_page_moved_in_a_facing_document_re_pairs_the_pages_with_its_items_and_master() {
    let (mut m, frames) = single_pages(5);
    m.apply_mutation(&Mutation::SetFacingPages { facing: true })
        .expect("facing");
    let p = ids(&m);
    // Page 4 shows no master, so the move can be seen to keep its own.
    m.apply_mutation(&Mutation::ApplyMasterToPage {
        page: PageId(p[3].clone()),
        master: None,
    })
    .expect("no master on page 4");
    let master = master_of(&m, &p[0]);
    assert!(master.is_some(), "a blank's pages apply its master");
    let hash = m.scene().canonical_hash();
    let before = places(&m, &frames);
    let steps = m.applied_log_len();

    // Page 4 (the left-hand page of the last pair) after page 1: it
    // becomes the left-hand page of the first pair, and the pages after it
    // shuffle (InDesign 20.0.1, tooling/oracle/indesign/facing-pages-probe).
    m.apply_mutation(&Mutation::MovePage {
        page: PageId(p[3].clone()),
        after: Some(PageId(p[0].clone())),
    })
    .expect("a page of a facing spread moves");
    assert_eq!(m.applied_log_len(), steps + 1, "one step");
    assert_eq!(
        ids(&m),
        [&p[0], &p[3], &p[1], &p[2], &p[4]].map(String::clone)
    );
    assert_eq!(pairs(&m), [0, 1, 1, 2, 2]);
    assert_eq!(sides(&m), [Some(R), Some(V), Some(R), Some(V), Some(R)]);
    assert_eq!(
        places(&m, &frames),
        before,
        "every item stays on its page, in its place"
    );
    assert_eq!(
        master_of(&m, &p[3]),
        None,
        "the moved page keeps its master"
    );
    assert_eq!(master_of(&m, &p[1]), master);

    m.undo().expect("undo");
    assert_eq!(
        m.scene().canonical_hash(),
        hash,
        "undo restores the spreads"
    );
    m.redo().expect("redo");
    assert_eq!(
        ids(&m),
        [&p[0], &p[3], &p[1], &p[2], &p[4]].map(String::clone)
    );

    // To the front: the last page becomes page 1, alone on the right.
    m.apply_mutation(&Mutation::MovePage {
        page: PageId(p[4].clone()),
        after: None,
    })
    .expect("to the front");
    let order = [&p[4], &p[0], &p[3], &p[1], &p[2]].map(String::clone);
    assert_eq!(ids(&m), order);
    assert_eq!(pairs(&m), [0, 1, 1, 2, 2]);
    assert_eq!(sides(&m), [Some(R), Some(V), Some(R), Some(V), Some(R)]);
    assert_eq!(places(&m, &frames), before);

    // The IDML it saves opens as what it shows.
    let idml = m.export_idml().expect("export");
    let reopened = CanvasModel::load("reopened", &idml, CanvasOptions::default()).expect("reopen");
    assert_eq!(ids(&reopened), order);
    assert_eq!(pairs(&reopened), [0, 1, 1, 2, 2]);
    assert_eq!(
        sides(&reopened),
        [Some(R), Some(V), Some(R), Some(V), Some(R)]
    );
    assert_eq!(places(&reopened, &frames), before);
    assert_eq!(master_of(&reopened, &p[3]), None);
}

#[test]
fn a_page_duplicated_in_a_facing_document_lands_after_it_with_its_items_and_master() {
    let (mut m, frames) = single_pages(4);
    m.apply_mutation(&Mutation::SetFacingPages { facing: true })
        .expect("facing");
    let p = ids(&m);
    assert_eq!(pairs(&m), [0, 1, 1, 2]);
    m.apply_mutation(&Mutation::ApplyMasterToPage {
        page: PageId(p[1].clone()),
        master: None,
    })
    .expect("no master on page 2");
    let hash = m.scene().canonical_hash();
    let before = places(&m, &frames);
    let steps = m.applied_log_len();

    // Page 2, the left-hand page of a two-page spread: its copy faces it,
    // and pages 3 and 4 make the next pair.
    let out = m
        .apply_mutation(&Mutation::DuplicatePage {
            page: PageId(p[1].clone()),
        })
        .expect("a page of a facing spread duplicates");
    assert_eq!(m.applied_log_len(), steps + 1, "one step");
    let order = ids(&m);
    assert_eq!(order.len(), 5);
    let copy = order[2].clone();
    assert!(!p.contains(&copy), "the copy is a new page");
    assert_eq!(
        [&order[0], &order[1], &order[3], &order[4]].map(String::clone),
        [&p[0], &p[1], &p[2], &p[3]].map(String::clone)
    );
    assert_eq!(
        out.created_pages
            .iter()
            .map(|p| p.0.clone())
            .collect::<Vec<_>>(),
        [copy.as_str()],
        "the reply names the copy"
    );
    assert_eq!(pairs(&m), [0, 1, 1, 2, 2]);
    assert_eq!(sides(&m), [Some(R), Some(V), Some(R), Some(V), Some(R)]);
    assert_eq!(places(&m, &frames), before, "the originals stay in place");
    assert_eq!(
        master_of(&m, &copy),
        None,
        "the copy keeps its page's master"
    );
    // The copy holds a copy of the page's frame, at the same place.
    let (_, bounds, transform) = before[1].clone();
    assert_eq!(
        rectangles_on(&m, &copy),
        [(Some(copy.clone()), bounds, transform)]
    );

    m.undo().expect("undo");
    assert_eq!(
        m.scene().canonical_hash(),
        hash,
        "undo removes the copy and puts the spreads back"
    );
    m.redo().expect("redo");
    assert_eq!(ids(&m), order, "redo makes the same copy");
    assert_eq!(pairs(&m), [0, 1, 1, 2, 2]);

    // The first page duplicates too: its copy is the left-hand page of
    // the first pair.
    m.apply_mutation(&Mutation::DuplicatePage {
        page: PageId(p[0].clone()),
    })
    .expect("page 1 duplicates");
    assert_eq!(ids(&m)[0], p[0]);
    assert_eq!(pairs(&m), [0, 1, 1, 2, 2, 3]);

    let idml = m.export_idml().expect("export");
    let reopened = CanvasModel::load("reopened", &idml, CanvasOptions::default()).expect("reopen");
    assert_eq!(ids(&reopened), ids(&m));
    assert_eq!(pairs(&reopened), [0, 1, 1, 2, 2, 3]);
    assert_eq!(
        rectangles_on(&reopened, &copy),
        [(Some(copy.clone()), bounds, transform)]
    );
}

#[test]
fn a_one_page_master_stays_one_page_and_shows_alike_on_both_sides() {
    // InDesign 20.0.1 (tooling/oracle/indesign/facing-pages-probe): Facing
    // Pages leaves a one-page master one page, and every page, left-hand
    // or right-hand, shows it whole at the same place on the page.
    let mut m =
        CanvasModel::new_blank_layout("single", 400.0, 600.0, 3, false, CanvasOptions::default())
            .expect("a blank loads");
    let master = m
        .scene()
        .master_spreads
        .keys()
        .next()
        .cloned()
        .expect("a blank has a master");
    m.apply_operation(Operation::OnMaster {
        master_id: master.clone(),
        op: Box::new(Operation::InsertNode {
            parent: NodeId::Spread(master.clone()),
            position: 0,
            node: NodeSpec::Rectangle {
                self_id: "uEdge".into(),
                // Near the page's left edge, where a mirrored master would
                // move it.
                bounds: [30.0, 5.0, 60.0, 45.0],
                fill_color: Some("Color/Black".into()),
                stroke_color: None,
                stroke_weight: None,
                item_transform: None,
            },
            z_slot: None,
        }),
    })
    .expect("a black rectangle on the master");
    let p: Vec<PageId> = ids(&m).into_iter().map(PageId).collect();
    let png = |m: &CanvasModel, page: &PageId| {
        render_snapshot_png(m, page, 200)
            .expect("snapshot")
            .png_bytes
    };
    let single = png(&m, &p[1]);

    m.apply_mutation(&Mutation::SetFacingPages { facing: true })
        .expect("facing");
    assert_eq!(sides(&m), [Some(R), Some(V), Some(R)]);
    assert_eq!(
        m.scene().master_spreads[&master].spread.pages.len(),
        1,
        "the master keeps its one page"
    );
    let left = png(&m, &p[1]);
    assert_eq!(
        left, single,
        "the left-hand page shows the master as before"
    );
    assert_eq!(png(&m, &p[0]), left, "and the right-hand page alike");
    assert_eq!(png(&m, &p[2]), left);

    // The rectangle is drawn: a page without the master differs.
    m.apply_mutation(&Mutation::ApplyMasterToPage {
        page: p[2].clone(),
        master: None,
    })
    .expect("no master");
    assert_ne!(png(&m, &p[2]), left);
}
