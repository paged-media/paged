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

//! Pages and masters: insert, delete, duplicate, resize, move, the applied
//! master, master CRUD, edits on a master, and page metadata.

use super::*;

fn page_ids(m: &mut CanvasModel) -> Vec<String> {
    json_of(&ok(m, "paged.pages()"))
        .as_array()
        .expect("pages")
        .iter()
        .map(|p| p["selfId"].as_str().expect("selfId").to_string())
        .collect()
}

fn two_pages() -> (CanvasModel, String, String) {
    let mut m = blank();
    let first = page_id(&mut m);
    let second = ok(&mut m, "paged.insertPage()");
    (m, first, second)
}

/// The master spreads' ids, sorted.
fn masters(m: &CanvasModel) -> Vec<String> {
    let mut ids: Vec<String> = m.scene().master_spreads.keys().cloned().collect();
    ids.sort();
    ids
}

/// The master a page applies (its bare id).
fn applied(m: &CanvasModel, page: &str) -> Option<String> {
    m.scene()
        .spreads
        .iter()
        .flat_map(|s| s.spread.pages.iter())
        .find(|p| p.self_id.as_deref() == Some(page))
        .and_then(|p| p.applied_master.clone())
        .map(|a| a.rsplit('/').next().unwrap_or_default().to_string())
}

#[test]
fn insert_page() {
    covers!("script:paged.insertPage");
    let mut m = blank();
    let first = page_id(&mut m);
    throws(&mut m, "paged.insertPage(Symbol('p'))", SYMBOL_TO_STRING);
    // No argument appends at the end; the answer is the new page's id.
    let made = mints(&mut m, "paged.insertPage()", |s| {
        !s.is_empty() && s != "null"
    });
    assert_eq!(page_ids(&mut m), vec![first.clone(), made.clone()]);
    let between = mints(&mut m, &format!("paged.insertPage({first:?})"), |s| {
        !s.is_empty() && s != "null"
    });
    assert_eq!(page_ids(&mut m), vec![first, between, made]);
    let summary = &json_of(&ok(&mut m, "paged.pages()"))[0];
    has_keys(summary, &["selfId", "index", "sizePt"]);
}

#[test]
fn delete_page() {
    covers!("script:paged.deletePage");
    let (mut m, first, second) = two_pages();
    refuses(&mut m, "paged.deletePage()", "false");
    refuses(&mut m, "paged.deletePage('no-such-page')", "false");
    throws(&mut m, "paged.deletePage(Symbol('p'))", SYMBOL_TO_STRING);
    writes(&mut m, &format!("paged.deletePage({second:?})"), "true");
    assert_eq!(page_ids(&mut m), vec![first]);
}

#[test]
fn duplicate_page() {
    covers!("script:paged.duplicatePage");
    let mut m = blank();
    let first = page_id(&mut m);
    ok(
        &mut m,
        &format!("paged.insertOval({first:?}, [100, 100, 200, 200])"),
    );
    refuses(&mut m, "paged.duplicatePage()", "null");
    refuses(&mut m, "paged.duplicatePage('no-such-page')", "null");
    throws(&mut m, "paged.duplicatePage(Symbol('p'))", SYMBOL_TO_STRING);
    let copy = mints(&mut m, &format!("paged.duplicatePage({first:?})"), |s| {
        !s.is_empty() && s != "null"
    });
    assert_eq!(page_ids(&mut m), vec![first, copy]);
    assert_eq!(
        ok(&mut m, "JSON.parse(paged.query('oval')).length"),
        "2",
        "the oval is copied"
    );
}

#[test]
fn resize_page() {
    covers!("script:paged.resizePage");
    let mut m = blank();
    let pid = page_id(&mut m);
    refuses(&mut m, &format!("paged.resizePage({pid:?})"), "false");
    refuses(
        &mut m,
        &format!("paged.resizePage({pid:?}, [0, 0, 500])"),
        "false",
    );
    refuses(
        &mut m,
        &format!("paged.resizePage({pid:?}, 'big')"),
        "false",
    );
    refuses(
        &mut m,
        "paged.resizePage('no-such-page', [0, 0, 500, 400])",
        "false",
    );
    throws(
        &mut m,
        "paged.resizePage(Symbol('p'), [0, 0, 500, 400])",
        SYMBOL_TO_STRING,
    );
    writes(
        &mut m,
        &format!("paged.resizePage({pid:?}, [0, 0, 500, 400])"),
        "true",
    );
    let size = &json_of(&ok(&mut m, "paged.pages()"))[0]["sizePt"];
    assert_eq!(size, &serde_json::json!([400.0, 500.0]), "width × height");
}

#[test]
fn move_page() {
    covers!("script:paged.movePage");
    let (mut m, first, second) = two_pages();
    refuses(&mut m, "paged.movePage('no-such-page')", "false");
    throws(&mut m, "paged.movePage(Symbol('p'))", SYMBOL_TO_STRING);
    // No `after`: to the front.
    writes(&mut m, &format!("paged.movePage({second:?})"), "true");
    assert_eq!(page_ids(&mut m), vec![second.clone(), first.clone()]);
    writes(
        &mut m,
        &format!("paged.movePage({second:?}, {first:?})"),
        "true",
    );
    assert_eq!(page_ids(&mut m), vec![first, second]);
}

#[test]
fn apply_master_to_page() {
    covers!("script:paged.applyMasterToPage");
    let mut m = sample("masters");
    let all = masters(&m);
    assert!(
        all.len() >= 2,
        "the masters sample has two masters: {all:?}"
    );
    let pid = page_id(&mut m);
    let current = applied(&m, &pid).expect("the first page applies a master");
    let other = all
        .iter()
        .find(|id| **id != current)
        .expect("another master")
        .clone();
    refuses(
        &mut m,
        "paged.applyMasterToPage('no-such-page', null)",
        "false",
    );
    throws(
        &mut m,
        "paged.applyMasterToPage(Symbol('p'))",
        SYMBOL_TO_STRING,
    );
    writes(
        &mut m,
        &format!("paged.applyMasterToPage({pid:?}, {other:?})"),
        "true",
    );
    assert_eq!(applied(&m, &pid).as_deref(), Some(other.as_str()));
    // No master detaches.
    writes(&mut m, &format!("paged.applyMasterToPage({pid:?})"), "true");
    assert_eq!(applied(&m, &pid), None);
}

#[test]
fn create_master() {
    covers!("script:paged.createMaster");
    let mut m = blank();
    let before = masters(&m);
    throws(
        &mut m,
        "paged.createMaster(Symbol('m'), {})",
        SYMBOL_TO_STRING,
    );
    refuses(
        &mut m,
        "paged.createMaster('B', { widthPt: 'wide' })",
        "false",
    );
    writes(
        &mut m,
        "paged.createMaster('uB', { name: 'B-Back', widthPt: 612, heightPt: 792 })",
        "true",
    );
    let after = masters(&m);
    assert_eq!(after.len(), before.len() + 1, "{after:?}");
    assert!(after.iter().any(|id| id == "uB"), "{after:?}");
}

#[test]
fn delete_master() {
    covers!("script:paged.deleteMaster");
    let mut m = blank();
    ok(
        &mut m,
        "paged.createMaster('uB', { name: 'B-Back', widthPt: 612, heightPt: 792 })",
    );
    refuses(&mut m, "paged.deleteMaster()", "false");
    refuses(&mut m, "paged.deleteMaster('no-such-master')", "false");
    throws(&mut m, "paged.deleteMaster(Symbol('m'))", SYMBOL_TO_STRING);
    // A master a page applies is refused.
    let pid = page_id(&mut m);
    if let Some(used) = applied(&m, &pid) {
        refuses(&mut m, &format!("paged.deleteMaster({used:?})"), "false");
    }
    writes(&mut m, "paged.deleteMaster('uB')", "true");
    assert!(!masters(&m).iter().any(|id| id == "uB"));
}

#[test]
fn rename_master() {
    covers!("script:paged.renameMaster");
    let mut m = blank();
    ok(
        &mut m,
        "paged.createMaster('uB', { name: 'B-Back', widthPt: 612, heightPt: 792 })",
    );
    refuses(&mut m, "paged.renameMaster('no-such-master', 'X')", "false");
    throws(
        &mut m,
        "paged.renameMaster(Symbol('m'), 'X')",
        SYMBOL_TO_STRING,
    );
    writes(&mut m, "paged.renameMaster('uB', 'C-Cover')", "true");
    let name = |m: &CanvasModel| serde_json::to_string(&m.scene().master_spreads["uB"]).unwrap();
    assert!(name(&m).contains("C-Cover"));
    // No name clears it.
    writes(&mut m, "paged.renameMaster('uB')", "true");
    assert!(!name(&m).contains("C-Cover"));
}

#[test]
fn on_master() {
    covers!("script:paged.onMaster");
    let mut m = sample("masters");
    let (master, rect) = m
        .scene()
        .master_spreads
        .iter()
        .find_map(|(id, ms)| {
            ms.spread
                .rectangles
                .first()
                .and_then(|r| r.self_id.clone())
                .map(|r| (id.clone(), r))
        })
        .expect("the masters sample has a master rectangle");
    let del = format!("{{ op: 'deleteFrame', args: {{ frameId: {rect:?} }} }}");
    refuses(&mut m, &format!("paged.onMaster({master:?})"), "false");
    refuses(
        &mut m,
        &format!("paged.onMaster({master:?}, {{ op: 'notAnOp' }})"),
        "false",
    );
    refuses(
        &mut m,
        &format!("paged.onMaster('no-such-master', {del})"),
        "false",
    );
    let pid = page_id(&mut m);
    refuses(
        &mut m,
        &format!(
            "paged.onMaster({master:?}, {{ op: 'duplicatePage', args: {{ page: {pid:?} }} }})"
        ),
        "false",
    );
    throws(
        &mut m,
        &format!("paged.onMaster(Symbol('m'), {del})"),
        SYMBOL_TO_STRING,
    );
    writes(
        &mut m,
        &format!("paged.onMaster({master:?}, {del})"),
        "true",
    );
    assert!(m.scene().master_spreads[&master]
        .spread
        .rectangles
        .iter()
        .all(|r| r.self_id.as_deref() != Some(rect.as_str())));
}

#[test]
fn set_page_metadata() {
    covers!("script:paged.setPageMetadata");
    let mut m = blank();
    let pid = page_id(&mut m);
    let envelope = r#"'{"v":1,"data":{"role":"cover"}}'"#;
    refuses(
        &mut m,
        &format!("paged.setPageMetadata('no-such-page', 'x-paged:role', {envelope})"),
        "false",
    );
    throws(
        &mut m,
        &format!("paged.setPageMetadata(Symbol('p'), 'k', {envelope})"),
        SYMBOL_TO_STRING,
    );
    throws(
        &mut m,
        &format!("paged.setPageMetadata({pid:?}, Symbol('k'), {envelope})"),
        SYMBOL_TO_STRING,
    );
    writes(
        &mut m,
        &format!("paged.setPageMetadata({pid:?}, 'x-paged:role', {envelope})"),
        "true",
    );
    assert!(snapshot(&m).to_string().contains("x-paged:role"));
    // No value deletes the entry.
    writes(
        &mut m,
        &format!("paged.setPageMetadata({pid:?}, 'x-paged:role')"),
        "true",
    );
    assert!(!snapshot(&m).to_string().contains("x-paged:role"));
}
