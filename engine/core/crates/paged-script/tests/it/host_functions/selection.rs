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

//! Selection: the element and content selections, read and set. These are
//! application state, not the document: no row may change the document,
//! and none enters the undo log.

use super::*;

/// A page with two ovals; returns the model and both addresses.
fn two_ovals() -> (CanvasModel, String, String) {
    let mut m = blank();
    let pid = page_id(&mut m);
    let a = ok(
        &mut m,
        &format!("paged.insertOval({pid:?}, [100, 100, 200, 200])"),
    );
    let b = ok(
        &mut m,
        &format!("paged.insertOval({pid:?}, [150, 150, 250, 250])"),
    );
    (m, a, b)
}

/// The element selection as addresses.
fn selected(m: &mut CanvasModel) -> Vec<String> {
    json_of(&reads(
        m,
        "JSON.stringify(JSON.parse(paged.selection()).map(id => paged.address(id)))",
    ))
    .as_array()
    .expect("an array")
    .iter()
    .map(|v| v.as_str().unwrap_or("null").to_string())
    .collect()
}

#[test]
fn selection() {
    covers!("script:paged.selection");
    let mut m = blank();
    assert_eq!(
        reads(&mut m, "paged.selection()"),
        "[]",
        "empty is [], never null"
    );
    let (mut m, _, b) = two_ovals();
    // An insert selects what it made.
    let ids = json_of(&reads(&mut m, "paged.selection()"));
    has_keys(&ids[0], &["kind", "id"]);
    assert_eq!(selected(&mut m), vec![b]);
}

#[test]
fn set_element_selection() {
    covers!("script:paged.setElementSelection");
    let (mut m, a, b) = two_ovals();
    let seq = m.last_applied_seq();
    // Unparseable ids are dropped; the answer is always true.
    assert_eq!(
        reads(
            &mut m,
            &format!("paged.setElementSelection([{a:?}, 'not an address', {b:?}])")
        ),
        "true"
    );
    assert_eq!(selected(&mut m), vec![a.clone(), b]);
    assert_eq!(reads(&mut m, "paged.setElementSelection('oval')"), "true");
    assert_eq!(
        selected(&mut m),
        Vec::<String>::new(),
        "a non-array selects nothing"
    );
    assert_eq!(reads(&mut m, "paged.setElementSelection()"), "true");
    // An entry with no string form is dropped like an unparseable one.
    assert_eq!(
        reads(
            &mut m,
            &format!("paged.setElementSelection([{a:?}, Symbol('b')])")
        ),
        "true"
    );
    assert_eq!(
        reads(&mut m, &format!("paged.setElementSelection([{a:?}])")),
        "true"
    );
    assert_eq!(selected(&mut m), vec![a]);
    // Not an undoable write: nothing entered the log.
    assert_eq!(m.last_applied_seq(), seq);
}

#[test]
fn clear_selection() {
    covers!("script:paged.clearSelection");
    let (mut m, _, _) = two_ovals();
    assert_eq!(selected(&mut m).len(), 1);
    assert_eq!(reads(&mut m, "paged.clearSelection()"), "true");
    assert_eq!(reads(&mut m, "paged.selection()"), "[]");
    assert_eq!(reads(&mut m, "paged.clearSelection('ignored')"), "true");
}

#[test]
fn content_selection() {
    covers!("script:paged.contentSelection");
    let (mut m, _, _, sid) = with_story("Hello world");
    assert_eq!(reads(&mut m, "paged.contentSelection()"), "null");
    ok(
        &mut m,
        &format!("paged.setContentSelection({{ storyId: {sid:?}, start: 0, end: 5 }})"),
    );
    let sel = json_of(&reads(&mut m, "paged.contentSelection()"));
    assert!(sel.to_string().contains(sid.as_str()), "{sel}");
}

#[test]
fn set_content_selection() {
    covers!("script:paged.setContentSelection");
    let (mut m, _, _, sid) = with_story("Hello world");
    assert_eq!(
        reads(&mut m, "paged.setContentSelection({ storyId: 7 })"),
        "false"
    );
    assert_eq!(
        reads(&mut m, "paged.setContentSelection('everything')"),
        "false"
    );
    assert_eq!(
        reads(&mut m, "paged.contentSelection()"),
        "null",
        "a refused shape sets nothing"
    );
    let set = format!("paged.setContentSelection({{ storyId: {sid:?}, start: 0, end: 5 }})");
    assert_eq!(reads(&mut m, &set), "true");
    assert_ne!(reads(&mut m, "paged.contentSelection()"), "null");
    // No argument (or null) clears it.
    assert_eq!(reads(&mut m, "paged.setContentSelection()"), "true");
    assert_eq!(reads(&mut m, "paged.contentSelection()"), "null");
    assert_eq!(reads(&mut m, &set), "true");
    assert_eq!(reads(&mut m, "paged.setContentSelection(null)"), "true");
    assert_eq!(reads(&mut m, "paged.contentSelection()"), "null");
}
