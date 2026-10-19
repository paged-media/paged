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

//! Frames and groups: inserts, images, grouping, duplication, deletion,
//! placement, threading, z-order, nesting, opacity masks and anchored
//! frames.

use super::*;

/// A 1×1 PNG, as the JS byte array `replaceImageBytes` takes.
const PNG: &str = "[137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,1,0,0,0,1,8,6,0,0,0,31,21,196,137,\
0,0,0,13,73,68,65,84,120,218,99,100,96,248,95,15,0,2,135,1,128,235,71,186,146,0,0,0,0,73,69,78,68,174,66,96,130]";

/// A blank page with two overlapping ovals; returns the model, the page id
/// and both addresses.
fn two_ovals() -> (CanvasModel, String, String, String) {
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
    (m, pid, a, b)
}

fn is_address(prefix: &'static str) -> impl Fn(&str) -> bool {
    move |s: &str| s.starts_with(prefix) && s.len() > prefix.len()
}

fn count(m: &mut CanvasModel, selector: &str) -> usize {
    json_of(&ok(m, &format!("paged.query({selector:?})")))
        .as_array()
        .map_or(0, Vec::len)
}

#[test]
fn insert_text_frame() {
    covers!("script:paged.insertTextFrame");
    let mut m = blank();
    let pid = page_id(&mut m);
    refuses(&mut m, &format!("paged.insertTextFrame({pid:?})"), "null");
    refuses(
        &mut m,
        &format!("paged.insertTextFrame({pid:?}, [0, 0, 10])"),
        "null",
    );
    refuses(
        &mut m,
        &format!("paged.insertTextFrame({pid:?}, 'big')"),
        "null",
    );
    refuses(
        &mut m,
        "paged.insertTextFrame('no-such-page', [72, 72, 400, 400])",
        "null",
    );
    throws(
        &mut m,
        "paged.insertTextFrame(Symbol('p'), [72, 72, 400, 400])",
        SYMBOL_TO_STRING,
    );
    let tf = mints(
        &mut m,
        &format!("paged.insertTextFrame({pid:?}, [72, 72, 400, 400])"),
        is_address("textFrame:"),
    );
    assert_eq!(count(&mut m, "textFrame"), 1);
    assert_eq!(
        json_of(&ok(&mut m, "paged.stories()"))
            .as_array()
            .map(Vec::len),
        Some(1)
    );
    let bare = tf.trim_start_matches("textFrame:");
    assert_eq!(
        ok(&mut m, "paged.selection()"),
        format!("[{{\"kind\":\"textFrame\",\"id\":\"{bare}\"}}]"),
        "the new frame is selected"
    );
}

#[test]
fn insert_frame() {
    covers!("script:paged.insertFrame");
    let mut m = blank();
    let pid = page_id(&mut m);
    refuses(&mut m, &format!("paged.insertFrame({pid:?})"), "null");
    refuses(
        &mut m,
        &format!("paged.insertFrame({pid:?}, [0, 0])"),
        "null",
    );
    refuses(
        &mut m,
        "paged.insertFrame('no-such-page', [72, 72, 400, 400])",
        "null",
    );
    throws(
        &mut m,
        "paged.insertFrame(Symbol('p'), [72, 72, 400, 400])",
        SYMBOL_TO_STRING,
    );
    let f = mints(
        &mut m,
        &format!("paged.insertFrame({pid:?}, [72, 72, 200, 200])"),
        |s| s.contains(':'),
    );
    assert_eq!(
        ok(&mut m, "paged.stories()"),
        "[]",
        "a graphic frame mints no story: {f}"
    );
}

#[test]
fn place_image() {
    covers!("script:paged.placeImage");
    let mut m = blank();
    let pid = page_id(&mut m);
    let f = ok(
        &mut m,
        &format!("paged.insertFrame({pid:?}, [72, 72, 200, 200])"),
    );
    refuses(
        &mut m,
        "paged.placeImage('rectangle:no-such-frame', 'https://example.com/a.png')",
        "false",
    );
    throws(
        &mut m,
        &format!("paged.placeImage({f:?}, Symbol('u'))"),
        SYMBOL_TO_STRING,
    );
    // finding SCR-4: the address `insertFrame` answered is refused (the bridge hands it
    // to the engine unresolved, unlike every other frame fn); it should place the image.
    refuses(
        &mut m,
        &format!("paged.placeImage({f:?}, 'https://example.com/a.png')"),
        "false",
    );
    // The bare id is what the engine resolves today.
    let bare = f
        .split_once(':')
        .map_or(f.as_str(), |(_, id)| id)
        .to_string();
    writes(
        &mut m,
        &format!("paged.placeImage({bare:?}, 'https://example.com/a.png')"),
        "true",
    );
    assert!(snapshot(&m)
        .to_string()
        .contains("https://example.com/a.png"));

    // With a fit, on a second frame.
    let g = ok(
        &mut m,
        &format!("paged.insertFrame({pid:?}, [300, 72, 400, 200])"),
    );
    let g = g
        .split_once(':')
        .map_or(g.as_str(), |(_, id)| id)
        .to_string();
    let fitting = |m: &CanvasModel| {
        let rects = &snapshot(m)["scene"]["spreads"][0]["spread"]["rectangles"];
        rects
            .as_array()
            .and_then(|r| r.iter().find(|r| r["self_id"] == g.as_str()))
            .map(|r| r["frame_fitting"].clone())
            .expect("the frame")
    };
    assert_eq!(fitting(&m), Value::Null, "no fitting before");
    let call =
        format!("paged.placeImage({g:?}, 'https://example.com/b.png', 'FillProportionally')");
    assert_eq!(ok(&mut m, &call), "true");
    assert_eq!(fitting(&m)["fitting_on_empty_frame"], "FillProportionally");
    assert_eq!(ok(&mut m, "paged.undo()"), "true");
    // finding SCR-5: undo leaves an empty fitting option (every field null) on a frame
    // that had none; it should restore no fitting at all.
    let left = fitting(&m);
    assert!(left.is_object(), "{left}");
    assert!(
        left.as_object().unwrap().values().all(Value::is_null),
        "{left}"
    );
}

#[test]
fn replace_image_bytes() {
    covers!("script:paged.replaceImageBytes");
    let mut m = blank();
    let pid = page_id(&mut m);
    let f = ok(
        &mut m,
        &format!("paged.insertFrame({pid:?}, [72, 72, 200, 200])"),
    );
    refuses(
        &mut m,
        &format!("paged.replaceImageBytes('rectangle:no-such-frame', {PNG})"),
        "false",
    );
    refuses(
        &mut m,
        &format!("paged.replaceImageBytes({f:?}, 'not bytes')"),
        "false",
    );
    throws(
        &mut m,
        &format!("paged.replaceImageBytes(Symbol('f'), {PNG})"),
        SYMBOL_TO_STRING,
    );
    writes(
        &mut m,
        &format!("paged.replaceImageBytes({f:?}, {PNG})"),
        "true",
    );
    // `null` clears the picture again.
    writes(
        &mut m,
        &format!("paged.replaceImageBytes({f:?}, null)"),
        "true",
    );
}

#[test]
fn create_group() {
    covers!("script:paged.createGroup");
    let (mut m, _, a, b) = two_ovals();
    refuses(&mut m, "paged.createGroup()", "false");
    refuses(&mut m, &format!("paged.createGroup({a:?})"), "false");
    refuses(&mut m, &format!("paged.createGroup([{a:?}])"), "false");
    refuses(
        &mut m,
        &format!("paged.createGroup([{a:?}, 'not an address'])"),
        "false",
    );
    throws(
        &mut m,
        &format!("paged.createGroup([{a:?}, Symbol('b')])"),
        SYMBOL_TO_STRING,
    );
    writes(
        &mut m,
        &format!("paged.createGroup([{a:?}, {b:?}])"),
        "true",
    );
    assert_eq!(count(&mut m, "group"), 1);
}

#[test]
fn dissolve_group() {
    covers!("script:paged.dissolveGroup");
    let (mut m, _, a, b) = two_ovals();
    ok(&mut m, &format!("paged.createGroup([{a:?}, {b:?}])"));
    let group = ok(&mut m, "JSON.parse(paged.query('group'))[0]");
    refuses(&mut m, "paged.dissolveGroup()", "false");
    refuses(
        &mut m,
        "paged.dissolveGroup('group:no-such-group')",
        "false",
    );
    throws(&mut m, "paged.dissolveGroup(Symbol('g'))", SYMBOL_TO_STRING);
    writes(&mut m, &format!("paged.dissolveGroup({group:?})"), "true");
    assert_eq!(count(&mut m, "group"), 0);
    assert_eq!(count(&mut m, "oval"), 2);
}

#[test]
fn copy_elements() {
    covers!("script:paged.copyElements");
    let (mut m, _, a, b) = two_ovals();
    refuses(&mut m, "paged.copyElements()", "null");
    refuses(&mut m, "paged.copyElements(['not an address'])", "null");
    // A read: the snippet, and nothing written.
    let before_count = count(&mut m, "oval");
    let out = ok(&mut m, &format!("paged.copyElements([{a:?}, {b:?}])"));
    let snippet = json_of(last_line(&out));
    assert_eq!(snippet["format"], "paged.snippet/1");
    assert_eq!(
        snippet["spread"]["frames_in_order"]
            .as_array()
            .map(Vec::len),
        Some(2)
    );
    assert_eq!(count(&mut m, "oval"), before_count);
}

#[test]
fn paste_elements() {
    covers!("script:paged.pasteElements");
    let (mut m, pid, a, _) = two_ovals();
    refuses(
        &mut m,
        &format!("paged.pasteElements('not a snippet', {pid:?})"),
        "null",
    );
    let out = mints(
        &mut m,
        &format!("var s = paged.copyElements([{a:?}]); paged.pasteElements(s, {pid:?}, 300, 300)"),
        |s| s.starts_with('['),
    );
    let copies: Vec<String> = serde_json::from_str(&out).expect("a JSON array of addresses");
    assert_eq!(copies.len(), 1);
    assert!(
        copies[0].starts_with("oval:") && copies[0] != a,
        "{copies:?}"
    );
    assert_eq!(count(&mut m, "oval"), 3);
}

#[test]
fn duplicate_elements() {
    covers!("script:paged.duplicateElements");
    let (mut m, _, a, b) = two_ovals();
    refuses(&mut m, "paged.duplicateElements()", "null");
    refuses(&mut m, "paged.duplicateElements([])", "null");
    refuses(
        &mut m,
        &format!("paged.duplicateElements([{a:?}, 'not an address'], 10, 10)"),
        "null",
    );
    throws(
        &mut m,
        &format!("paged.duplicateElements([{a:?}], Symbol('x'))"),
        SYMBOL_TO_STRING,
    );
    let out = mints(
        &mut m,
        &format!("paged.duplicateElements([{a:?}, {b:?}], 10, 20)"),
        |s| s.starts_with('['),
    );
    let clones: Vec<String> = serde_json::from_str(&out).expect("a JSON array of addresses");
    assert_eq!(clones.len(), 2);
    assert!(
        clones
            .iter()
            .all(|c| c.starts_with("oval:") && *c != a && *c != b),
        "{clones:?}"
    );
    assert_eq!(count(&mut m, "oval"), 4);
}

#[test]
fn delete_element() {
    covers!("script:paged.deleteElement");
    let (mut m, _, a, _) = two_ovals();
    refuses(&mut m, "paged.deleteElement()", "false");
    refuses(&mut m, "paged.deleteElement('oval:no-such-oval')", "false");
    throws(&mut m, "paged.deleteElement(Symbol('e'))", SYMBOL_TO_STRING);
    writes(&mut m, &format!("paged.deleteElement({a:?})"), "true");
    assert_eq!(count(&mut m, "oval"), 1);
}

#[test]
fn move_frame() {
    covers!("script:paged.moveFrame");
    let (mut m, _, a, _) = two_ovals();
    refuses(&mut m, &format!("paged.moveFrame({a:?})"), "false");
    refuses(
        &mut m,
        &format!("paged.moveFrame({a:?}, [1, 0, 0, 1])"),
        "false",
    );
    refuses(
        &mut m,
        "paged.moveFrame('oval:no-such-oval', [1, 0, 0, 1, 10, 10])",
        "false",
    );
    throws(
        &mut m,
        "paged.moveFrame(Symbol('e'), [1, 0, 0, 1, 10, 10])",
        SYMBOL_TO_STRING,
    );
    writes(
        &mut m,
        &format!("paged.moveFrame({a:?}, [1, 0, 0, 1, 30, 40])"),
        "true",
    );
}

#[test]
fn resize_frame() {
    covers!("script:paged.resizeFrame");
    let (mut m, _, a, _) = two_ovals();
    refuses(&mut m, &format!("paged.resizeFrame({a:?})"), "false");
    refuses(
        &mut m,
        &format!("paged.resizeFrame({a:?}, [1, 2, 3])"),
        "false",
    );
    refuses(
        &mut m,
        "paged.resizeFrame('oval:no-such-oval', [0, 0, 50, 50])",
        "false",
    );
    throws(
        &mut m,
        "paged.resizeFrame(Symbol('e'), [0, 0, 50, 50])",
        SYMBOL_TO_STRING,
    );
    writes(
        &mut m,
        &format!("paged.resizeFrame({a:?}, [100, 100, 300, 260])"),
        "true",
    );
}

/// Two text frames, the first holding a story long enough to overflow.
fn two_text_frames() -> (CanvasModel, String, String) {
    let (mut m, pid, first, _) = with_story(&"overflow ".repeat(200));
    let second = ok(
        &mut m,
        &format!("paged.insertTextFrame({pid:?}, [450, 72, 700, 400])"),
    );
    (m, first, second)
}

#[test]
fn link_frames() {
    covers!("script:paged.linkFrames");
    let (mut m, first, second) = two_text_frames();
    refuses(&mut m, &format!("paged.linkFrames({first:?})"), "false");
    refuses(
        &mut m,
        &format!("paged.linkFrames({first:?}, 'textFrame:no-such-frame')"),
        "false",
    );
    throws(
        &mut m,
        &format!("paged.linkFrames({first:?}, Symbol('t'))"),
        SYMBOL_TO_STRING,
    );
    writes(
        &mut m,
        &format!("paged.linkFrames({first:?}, {second:?})"),
        "true",
    );
    let frames = snapshot(&m)["scene"]["spreads"][0]["spread"]["text_frames"].clone();
    assert_eq!(
        frames[1]["parent_story"], frames[0]["parent_story"],
        "the threaded frames share one story"
    );
    // finding SCR-6: the second frame's own (empty) story stays in the document,
    // held by no frame; linking should remove it.
    let stories = json_of(&ok(&mut m, "paged.stories()"));
    assert_eq!(stories.as_array().map(Vec::len), Some(2), "{stories}");
    assert_eq!(stories[1]["characterCount"], 0);
}

#[test]
fn unlink_frames() {
    covers!("script:paged.unlinkFrames");
    let (mut m, first, second) = two_text_frames();
    ok(&mut m, &format!("paged.linkFrames({first:?}, {second:?})"));
    refuses(&mut m, "paged.unlinkFrames()", "false");
    refuses(
        &mut m,
        "paged.unlinkFrames('textFrame:no-such-frame')",
        "false",
    );
    throws(&mut m, "paged.unlinkFrames(Symbol('t'))", SYMBOL_TO_STRING);
    writes(&mut m, &format!("paged.unlinkFrames({first:?})"), "true");
}

#[test]
fn reorder_element() {
    covers!("script:paged.reorderElement");
    let (mut m, _, a, _) = two_ovals();
    refuses(&mut m, &format!("paged.reorderElement({a:?})"), "false");
    refuses(
        &mut m,
        &format!("paged.reorderElement({a:?}, 'bringToFront')"),
        "false",
    );
    refuses(
        &mut m,
        "paged.reorderElement('not an address', 'front')",
        "false",
    );
    throws(
        &mut m,
        "paged.reorderElement(Symbol('e'), 'front')",
        SYMBOL_TO_STRING,
    );
    let order = |m: &mut CanvasModel| ok(m, "paged.query('oval')");
    let before = order(&mut m);
    writes(
        &mut m,
        &format!("paged.reorderElement({a:?}, 'front')"),
        "true",
    );
    assert_ne!(order(&mut m), before, "the oval moved in the paint order");
    writes(
        &mut m,
        &format!("paged.reorderElement({a:?}, {{ index: 0 }})"),
        "true",
    );
    assert_eq!(order(&mut m), before);
}

#[test]
fn paste_into() {
    covers!("script:paged.pasteInto");
    let mut m = blank();
    let pid = page_id(&mut m);
    let frame = ok(
        &mut m,
        &format!("paged.insertFrame({pid:?}, [300, 300, 420, 420])"),
    );
    let child = ok(
        &mut m,
        &format!("paged.insertOval({pid:?}, [320, 320, 360, 360])"),
    );
    refuses(&mut m, &format!("paged.pasteInto({frame:?})"), "false");
    refuses(
        &mut m,
        &format!("paged.pasteInto('not an address', {child:?})"),
        "false",
    );
    throws(
        &mut m,
        &format!("paged.pasteInto({frame:?}, Symbol('c'))"),
        SYMBOL_TO_STRING,
    );
    writes(
        &mut m,
        &format!("paged.pasteInto({frame:?}, {child:?})"),
        "true",
    );
}

#[test]
fn release_from() {
    covers!("script:paged.releaseFrom");
    let mut m = blank();
    let pid = page_id(&mut m);
    let frame = ok(
        &mut m,
        &format!("paged.insertFrame({pid:?}, [300, 300, 420, 420])"),
    );
    let child = ok(
        &mut m,
        &format!("paged.insertOval({pid:?}, [320, 320, 360, 360])"),
    );
    ok(&mut m, &format!("paged.pasteInto({frame:?}, {child:?})"));
    refuses(&mut m, "paged.releaseFrom()", "false");
    refuses(&mut m, "paged.releaseFrom('oval:no-such-oval')", "false");
    throws(&mut m, "paged.releaseFrom(Symbol('c'))", SYMBOL_TO_STRING);
    writes(&mut m, &format!("paged.releaseFrom({child:?})"), "true");
}

#[test]
fn apply_opacity_mask() {
    covers!("script:paged.applyOpacityMask");
    let (mut m, _, art, mask) = two_ovals();
    refuses(&mut m, &format!("paged.applyOpacityMask({art:?})"), "false");
    refuses(
        &mut m,
        &format!("paged.applyOpacityMask({art:?}, 'not an address')"),
        "false",
    );
    throws(
        &mut m,
        &format!("paged.applyOpacityMask({art:?}, Symbol('m'))"),
        SYMBOL_TO_STRING,
    );
    writes(
        &mut m,
        &format!("paged.applyOpacityMask({art:?}, {mask:?}, {{ invert: true }})"),
        "true",
    );
}

#[test]
fn release_opacity_mask() {
    covers!("script:paged.releaseOpacityMask");
    let (mut m, _, art, mask) = two_ovals();
    ok(
        &mut m,
        &format!("paged.applyOpacityMask({art:?}, {mask:?})"),
    );
    refuses(&mut m, "paged.releaseOpacityMask()", "false");
    refuses(
        &mut m,
        "paged.releaseOpacityMask('oval:no-such-oval')",
        "false",
    );
    throws(
        &mut m,
        "paged.releaseOpacityMask(Symbol('t'))",
        SYMBOL_TO_STRING,
    );
    writes(
        &mut m,
        &format!("paged.releaseOpacityMask({art:?})"),
        "true",
    );
}

#[test]
fn insert_anchored_frame() {
    covers!("script:paged.insertAnchoredFrame");
    let (mut m, _, _, sid) = with_story("Read the manual");
    refuses(
        &mut m,
        "paged.insertAnchoredFrame('no-such-story', 4, 40, 20)",
        "false",
    );
    throws(
        &mut m,
        &format!("paged.insertAnchoredFrame({sid:?}, Symbol('o'), 40, 20)"),
        SYMBOL_TO_STRING,
    );
    throws(
        &mut m,
        "paged.insertAnchoredFrame(Symbol('s'), 4, 40, 20)",
        SYMBOL_TO_STRING,
    );
    writes(
        &mut m,
        &format!("paged.insertAnchoredFrame({sid:?}, 4, 40, 20)"),
        "true",
    );
    assert!(serde_json::to_string(&m.scene().stories)
        .unwrap()
        .contains("anchored"));
}
