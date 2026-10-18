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

//! A mutation's outcome names the pages it created.
//!
//! Pages are not elements, so `created_id` and `minted` never named a new
//! page. A host found one by reading the page list before and after the
//! mutation and diffing: two reads, and the new pages in DOCUMENT order,
//! so a batch of two inserts could not say which insert made which page.
//! `created_pages` lists them in creation order, from both batch lanes.

use paged_canvas::{channel::Mutation, CanvasModel, CanvasOptions};
use serde_json::{json, Value};

fn model() -> CanvasModel {
    let bytes = paged_gen::write_idml(&paged_gen::samples::text::build()).unwrap();
    CanvasModel::load("pages", &bytes, CanvasOptions::default()).expect("load")
}

fn mutation(v: Value) -> Mutation {
    serde_json::from_value(v).expect("wire spelling")
}

fn batch(ops: Vec<Value>) -> Mutation {
    mutation(json!({ "op": "batch", "args": { "ops": ops } }))
}

fn insert_after(page: &str) -> Value {
    json!({ "op": "insertPage", "args": { "afterPageId": page, "masterId": null } })
}

fn page_ids(m: &CanvasModel) -> Vec<String> {
    m.built().pages.iter().map(|p| p.id.0.clone()).collect()
}

fn created(outcome: &paged_canvas::model::MutationOutcome) -> Vec<String> {
    outcome.created_pages.iter().map(|p| p.0.clone()).collect()
}

fn position(m: &CanvasModel, page: &str) -> usize {
    page_ids(m)
        .iter()
        .position(|p| p == page)
        .unwrap_or_else(|| panic!("{page} is not in the document"))
}

#[test]
fn an_insert_names_its_page() {
    let mut m = model();
    let before = page_ids(&m);
    let outcome = m
        .apply_mutation(&mutation(insert_after(&before[0])))
        .expect("insert");
    let made = created(&outcome);
    assert_eq!(made.len(), 1, "one page created: {made:?}");
    assert!(!before.contains(&made[0]), "a new id: {made:?}");
    assert_eq!(position(&m, &made[0]), 1, "right after the first page");
    assert_eq!(outcome.created_id, None, "a page is not an element");
}

#[test]
fn a_duplicate_names_its_copy() {
    let mut m = model();
    let before = page_ids(&m);
    let outcome = m
        .apply_mutation(&mutation(
            json!({ "op": "duplicatePage", "args": { "page": before[0] } }),
        ))
        .expect("duplicate");
    let fresh: Vec<String> = page_ids(&m)
        .into_iter()
        .filter(|p| !before.contains(p))
        .collect();
    assert_eq!(fresh.len(), 1);
    assert_eq!(created(&outcome), fresh, "the copy, by its new id");
}

#[test]
fn a_batch_names_its_pages_in_creation_order() {
    let mut m = model();
    let before = page_ids(&m);
    let last = before.last().unwrap().clone();
    // The first insert lands at the END, the second right after the FIRST
    // page: in the document the second one comes first.
    let outcome = m
        .apply_mutation(&batch(vec![insert_after(&last), insert_after(&before[0])]))
        .expect("batch");
    let made = created(&outcome);
    assert_eq!(made.len(), 2, "two pages: {made:?}");
    assert_eq!(
        position(&m, &made[0]),
        before.len() + 1,
        "the first insert went last"
    );
    assert_eq!(
        position(&m, &made[1]),
        1,
        "the second went after the first page"
    );
    assert!(outcome.page_structure_changed);
}

#[test]
fn the_sequential_lane_names_them_too() {
    let mut m = model();
    let before = page_ids(&m);
    let story = m.stories()[0].self_id.clone();
    // A text edit sends the batch down the sequential lane, and the
    // handle makes the duplicate address the page the batch just made.
    let outcome = m
        .apply_mutation(&batch(vec![
            json!({ "op": "insertText", "args": { "storyId": story, "offset": 0, "text": "x" } }),
            insert_after(&before[0]),
            json!({ "op": "bindCreated", "args": { "handle": "p" } }),
            json!({ "op": "duplicatePage", "args": { "page": "$h:p" } }),
        ]))
        .expect("batch");
    let made = created(&outcome);
    assert_eq!(made.len(), 2, "the insert and its copy: {made:?}");
    assert_eq!(
        position(&m, &made[0]),
        1,
        "the inserted page, after the first"
    );
    assert_ne!(made[0], made[1]);
    assert!(
        made.iter().all(|p| !before.contains(p)),
        "both new: {made:?}"
    );
    assert_eq!(page_ids(&m).len(), before.len() + 2);
}

#[test]
fn a_page_the_batch_deleted_again_is_not_listed() {
    let mut m = model();
    let before = page_ids(&m);
    let outcome = m
        .apply_mutation(&batch(vec![
            insert_after(&before[0]),
            json!({ "op": "bindCreated", "args": { "handle": "gone" } }),
            insert_after(&before[0]),
            json!({ "op": "deletePage", "args": { "pageId": "$h:gone" } }),
        ]))
        .expect("batch");
    let made = created(&outcome);
    assert_eq!(made.len(), 1, "only the page that stayed: {made:?}");
    assert_eq!(page_ids(&m).len(), before.len() + 1);
    assert_eq!(position(&m, &made[0]), 1);
}

#[test]
fn other_mutations_create_no_pages() {
    let mut m = model();
    let pages = page_ids(&m);
    let story = m.stories()[0].self_id.clone();
    let text = m
        .apply_mutation(&mutation(
            json!({ "op": "insertText", "args": { "storyId": story, "offset": 0, "text": "x" } }),
        ))
        .expect("text");
    assert!(text.created_pages.is_empty());
    let resize = m
        .apply_mutation(&mutation(json!({ "op": "resizePage", "args": {
            "pageId": pages[0], "bounds": [0.0, 0.0, 500.0, 400.0]
        } })))
        .expect("resize");
    assert!(
        resize.page_structure_changed,
        "a resize changes the page list"
    );
    assert!(resize.created_pages.is_empty(), "but creates no page");
    let insert = m
        .apply_mutation(&mutation(insert_after(&pages[0])))
        .expect("insert");
    let made = created(&insert);
    let delete = m
        .apply_mutation(&mutation(
            json!({ "op": "deletePage", "args": { "pageId": made[0] } }),
        ))
        .expect("delete");
    assert!(delete.page_structure_changed);
    assert!(delete.created_pages.is_empty());
    assert_eq!(page_ids(&m), pages);
}
