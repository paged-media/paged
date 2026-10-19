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

//! Shapes and paths: line, oval and path inserts, point editing, the
//! stroke/offset/simplify rewrites, pathfinder, path topology and text on
//! a path.

use super::*;

const A: &str = "const A = (x, y) => ({ anchor: [x, y], left: [x, y], right: [x, y] });";

fn count(m: &mut CanvasModel, selector: &str) -> usize {
    json_of(&ok(m, &format!("paged.query({selector:?})")))
        .as_array()
        .map_or(0, Vec::len)
}

/// A blank page and an open three-point path on it.
fn open_path() -> (CanvasModel, String, String) {
    let mut m = blank();
    let pid = page_id(&mut m);
    let p = ok(
        &mut m,
        &format!(
            "{A} paged.insertPath({pid:?}, [A(100, 600), A(200, 600), A(200, 660)], true, false)"
        ),
    );
    (m, pid, p)
}

/// A blank page and two overlapping ovals.
fn pair() -> (CanvasModel, String, String) {
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

/// A closed square path with its top-left corner at `(x, y)`.
fn square(m: &mut CanvasModel, pid: &str, x: u32, y: u32) -> String {
    let (r, b) = (x + 180, y + 180);
    ok(
        m,
        &format!("{A} paged.insertPath({pid:?}, [A({x}, {y}), A({r}, {y}), A({r}, {b}), A({x}, {b})], false)"),
    )
}

/// A blank page and two overlapping closed square paths.
fn squares() -> (CanvasModel, String, String) {
    let mut m = blank();
    let pid = page_id(&mut m);
    let a = square(&mut m, &pid, 120, 120);
    let b = square(&mut m, &pid, 220, 220);
    (m, a, b)
}

#[test]
fn insert_line() {
    covers!("script:paged.insertLine");
    let mut m = blank();
    let pid = page_id(&mut m);
    refuses(&mut m, &format!("paged.insertLine({pid:?})"), "null");
    refuses(
        &mut m,
        &format!("paged.insertLine({pid:?}, [0, 0])"),
        "null",
    );
    refuses(
        &mut m,
        &format!("paged.insertLine({pid:?}, [0, 0, 1], [10, 10])"),
        "null",
    );
    refuses(
        &mut m,
        "paged.insertLine('no-such-page', [0, 0], [10, 10])",
        "null",
    );
    throws(
        &mut m,
        "paged.insertLine(Symbol('p'), [0, 0], [10, 10])",
        SYMBOL_TO_STRING,
    );
    mints(
        &mut m,
        &format!("paged.insertLine({pid:?}, [72, 72], [300, 72])"),
        |s| s.starts_with("graphicLine:"),
    );
    assert_eq!(count(&mut m, "graphicLine"), 1);
}

#[test]
fn insert_oval() {
    covers!("script:paged.insertOval");
    let mut m = blank();
    let pid = page_id(&mut m);
    refuses(&mut m, &format!("paged.insertOval({pid:?})"), "null");
    refuses(
        &mut m,
        &format!("paged.insertOval({pid:?}, [0, 0, 10])"),
        "null",
    );
    refuses(
        &mut m,
        "paged.insertOval('no-such-page', [0, 0, 10, 10])",
        "null",
    );
    throws(
        &mut m,
        "paged.insertOval(Symbol('p'), [0, 0, 10, 10])",
        SYMBOL_TO_STRING,
    );
    mints(
        &mut m,
        &format!("paged.insertOval({pid:?}, [100, 100, 200, 200])"),
        |s| s.starts_with("oval:"),
    );
    assert_eq!(count(&mut m, "oval"), 1);
}

#[test]
fn insert_path() {
    covers!("script:paged.insertPath");
    let mut m = blank();
    let pid = page_id(&mut m);
    refuses(&mut m, &format!("paged.insertPath({pid:?})"), "null");
    refuses(
        &mut m,
        &format!("paged.insertPath({pid:?}, [[0, 0], [1, 1]], true)"),
        "null",
    );
    refuses(
        &mut m,
        &format!("{A} paged.insertPath('no-such-page', [A(0, 0), A(9, 9)], true)"),
        "null",
    );
    throws(
        &mut m,
        &format!("{A} paged.insertPath(Symbol('p'), [A(0, 0), A(9, 9)], true)"),
        SYMBOL_TO_STRING,
    );
    mints(
        &mut m,
        &format!(
            "{A} paged.insertPath({pid:?}, [A(100, 600), A(200, 600), A(200, 660)], true, false)"
        ),
        |s| s.contains(':'),
    );
}

#[test]
fn path_point_insert() {
    covers!("script:paged.pathPointInsert");
    let (mut m, _, p) = open_path();
    refuses(&mut m, &format!("paged.pathPointInsert({p:?}, 1)"), "false");
    refuses(
        &mut m,
        &format!("paged.pathPointInsert({p:?}, 1, [5, 5])"),
        "false",
    );
    refuses(
        &mut m,
        &format!("{A} paged.pathPointInsert('not an address', 1, A(5, 5))"),
        "false",
    );
    throws(
        &mut m,
        &format!("{A} paged.pathPointInsert({p:?}, Symbol('i'), A(5, 5))"),
        SYMBOL_TO_STRING,
    );
    writes(
        &mut m,
        &format!("{A} paged.pathPointInsert({p:?}, 1, A(150, 600))"),
        "true",
    );
}

#[test]
fn path_point_remove() {
    covers!("script:paged.pathPointRemove");
    let (mut m, _, p) = open_path();
    refuses(
        &mut m,
        "paged.pathPointRemove('not an address', 0)",
        "false",
    );
    refuses(
        &mut m,
        &format!("paged.pathPointRemove({p:?}, 99)"),
        "false",
    );
    throws(
        &mut m,
        &format!("paged.pathPointRemove({p:?}, Symbol('i'))"),
        SYMBOL_TO_STRING,
    );
    writes(&mut m, &format!("paged.pathPointRemove({p:?}, 1)"), "true");
}

#[test]
fn path_point_curve_type() {
    covers!("script:paged.pathPointCurveType");
    let (mut m, _, p) = open_path();
    refuses(
        &mut m,
        "paged.pathPointCurveType('not an address', 1, true)",
        "false",
    );
    refuses(
        &mut m,
        &format!("paged.pathPointCurveType({p:?}, 99, true)"),
        "false",
    );
    throws(
        &mut m,
        &format!("paged.pathPointCurveType({p:?}, Symbol('i'), true)"),
        SYMBOL_TO_STRING,
    );
    writes(
        &mut m,
        &format!("paged.pathPointCurveType({p:?}, 1, true)"),
        "true",
    );
}

#[test]
fn path_point_set() {
    covers!("script:paged.pathPointSet");
    let (mut m, _, p) = open_path();
    refuses(
        &mut m,
        &format!("paged.pathPointSet({p:?}, 0, 'anchor')"),
        "false",
    );
    refuses(
        &mut m,
        &format!("paged.pathPointSet({p:?}, 0, 'middle', [1, 2])"),
        "false",
    );
    refuses(
        &mut m,
        "paged.pathPointSet('not an address', 0, 'anchor', [1, 2])",
        "false",
    );
    throws(
        &mut m,
        &format!("paged.pathPointSet({p:?}, Symbol('i'), 'anchor', [1, 2])"),
        SYMBOL_TO_STRING,
    );
    writes(
        &mut m,
        &format!("paged.pathPointSet({p:?}, 0, 'anchor', [110, 590])"),
        "true",
    );
}

#[test]
fn path_open_at() {
    covers!("script:paged.pathOpenAt");
    let (mut m, p, _) = squares();
    refuses(&mut m, "paged.pathOpenAt('not an address', 0)", "false");
    refuses(&mut m, &format!("paged.pathOpenAt({p:?}, 99)"), "false");
    throws(
        &mut m,
        &format!("paged.pathOpenAt({p:?}, Symbol('i'))"),
        SYMBOL_TO_STRING,
    );
    writes(&mut m, &format!("paged.pathOpenAt({p:?}, 0)"), "true");
}

#[test]
fn outline_stroke() {
    covers!("script:paged.outlineStroke");
    let mut m = blank();
    let pid = page_id(&mut m);
    let rule = ok(
        &mut m,
        &format!("paged.insertLine({pid:?}, [72, 96], [400, 300])"),
    );
    ok(
        &mut m,
        &format!("paged.set({rule:?}, 'frameStrokeWeight', 8)"),
    );
    refuses(
        &mut m,
        "paged.outlineStroke('not an address', 8, 'round', 'round', 4)",
        "false",
    );
    throws(
        &mut m,
        &format!("paged.outlineStroke({rule:?}, Symbol('w'), 'round', 'round', 4)"),
        SYMBOL_TO_STRING,
    );
    writes(
        &mut m,
        &format!("paged.outlineStroke({rule:?}, 8, 'round', 'round', 4)"),
        "true",
    );
}

#[test]
fn offset_path() {
    covers!("script:paged.offsetPath");
    let (mut m, a, _) = squares();
    refuses(
        &mut m,
        "paged.offsetPath('not an address', -10, 'miter', 4)",
        "false",
    );
    throws(
        &mut m,
        &format!("paged.offsetPath({a:?}, Symbol('d'), 'miter', 4)"),
        SYMBOL_TO_STRING,
    );
    writes(
        &mut m,
        &format!("paged.offsetPath({a:?}, -10, 'miter', 4)"),
        "true",
    );
}

#[test]
fn simplify_path() {
    covers!("script:paged.simplifyPath");
    let mut m = blank();
    let pid = page_id(&mut m);
    let pts: Vec<String> = (0..40)
        .map(|i| {
            format!(
                "A({}, {})",
                100 + i * 5,
                600.0 + (f64::from(i) * 0.3).sin() * 20.0
            )
        })
        .collect();
    let p = ok(
        &mut m,
        &format!(
            "{A} paged.insertPath({pid:?}, [{}], true, false)",
            pts.join(",")
        ),
    );
    refuses(&mut m, "paged.simplifyPath('not an address', 2)", "false");
    throws(
        &mut m,
        &format!("paged.simplifyPath({p:?}, Symbol('t'))"),
        SYMBOL_TO_STRING,
    );
    writes(&mut m, &format!("paged.simplifyPath({p:?}, 2)"), "true");
}

#[test]
fn pathfinder_boolean() {
    covers!("script:paged.pathfinderBoolean");
    let (mut m, a, b) = squares();
    refuses(
        &mut m,
        &format!("paged.pathfinderBoolean({a:?}, [{b:?}])"),
        "false",
    );
    refuses(
        &mut m,
        &format!("paged.pathfinderBoolean({a:?}, [{b:?}], 'glue')"),
        "false",
    );
    refuses(
        &mut m,
        &format!("paged.pathfinderBoolean('not an address', [{b:?}], 'union')"),
        "false",
    );
    throws(
        &mut m,
        &format!("paged.pathfinderBoolean(Symbol('k'), [{b:?}], 'union')"),
        SYMBOL_TO_STRING,
    );
    writes(
        &mut m,
        &format!("paged.pathfinderBoolean({a:?}, [{b:?}], 'union')"),
        "true",
    );
    assert_eq!(
        count(&mut m, "polygon"),
        1,
        "the union replaces both squares"
    );
}

/// finding SCR-2: an id list keeps only the entries that parse, so a typo
/// in one of them runs the verb on the others; it should be refused, as
/// `duplicateElements` refuses it. Asserts the CURRENT behaviour: `[a, bad]`
/// does exactly what `[a]` does.
fn drops_unparseable(call: impl Fn(&str, &str) -> String) {
    let (mut with_bad, a, _) = pair();
    let typo = js(&mut with_bad, &call(&a, "'not an address'"));
    let (mut alone, a2, _) = pair();
    let only = js(&mut alone, &call(&a2, ""));
    assert_eq!((typo.output, typo.error), (only.output, only.error));
    assert!(
        snapshot(&with_bad) == snapshot(&alone),
        "the unparseable id was dropped"
    );
}

/// The six region verbs share `([id, …]) -> bool`.
fn region(verb: &str) {
    let (mut m, a, b) = pair();
    refuses(&mut m, &format!("paged.{verb}()"), "false");
    refuses(&mut m, &format!("paged.{verb}([])"), "false");
    refuses(
        &mut m,
        &format!("paged.{verb}(['not an address'])"),
        "false",
    );
    drops_unparseable(|a, bad| {
        let rest = if bad.is_empty() {
            String::new()
        } else {
            format!(", {bad}")
        };
        format!("paged.{verb}([{a:?}{rest}])")
    });
    writes(&mut m, &format!("paged.{verb}([{a:?}, {b:?}])"), "true");
}

#[test]
fn pathfinder_divide() {
    covers!("script:paged.pathfinderDivide");
    region("pathfinderDivide");
}

#[test]
fn pathfinder_trim() {
    covers!("script:paged.pathfinderTrim");
    region("pathfinderTrim");
}

#[test]
fn pathfinder_merge() {
    covers!("script:paged.pathfinderMerge");
    region("pathfinderMerge");
}

#[test]
fn pathfinder_crop() {
    covers!("script:paged.pathfinderCrop");
    region("pathfinderCrop");
}

#[test]
fn pathfinder_outline() {
    covers!("script:paged.pathfinderOutline");
    region("pathfinderOutline");
}

#[test]
fn pathfinder_minus_back() {
    covers!("script:paged.pathfinderMinusBack");
    region("pathfinderMinusBack");
}

#[test]
fn pathfinder_faces() {
    covers!("script:paged.pathfinderFaces");
    let (mut m, a, b) = pair();
    let face = ok(
        &mut m,
        &format!("JSON.parse(paged.planarRegions([{a:?}, {b:?}])).faces[0].id"),
    );
    refuses(
        &mut m,
        &format!("paged.pathfinderFaces([], [{face:?}], 'keep')"),
        "false",
    );
    refuses(
        &mut m,
        &format!("paged.pathfinderFaces([{a:?}, {b:?}], [{face:?}], 'sideways')"),
        "false",
    );
    refuses(
        &mut m,
        &format!("paged.pathfinderFaces([{a:?}, {b:?}], [{face:?}])"),
        "false",
    );
    drops_unparseable(|a, bad| {
        let rest = if bad.is_empty() {
            String::new()
        } else {
            format!(", {bad}")
        };
        format!("paged.pathfinderFaces([{a:?}{rest}], ['0#0'], 'keep')")
    });
    writes(
        &mut m,
        &format!("paged.pathfinderFaces([{a:?}, {b:?}], [{face:?}], 'keep')"),
        "true",
    );
}

#[test]
fn close_path() {
    covers!("script:paged.closePath");
    let (mut m, _, p) = open_path();
    refuses(&mut m, "paged.closePath('not an address')", "false");
    throws(
        &mut m,
        &format!("paged.closePath({p:?}, Symbol('s'))"),
        SYMBOL_TO_STRING,
    );
    writes(&mut m, &format!("paged.closePath({p:?})"), "true");
}

#[test]
fn join_paths() {
    covers!("script:paged.joinPaths");
    let mut m = blank();
    let pid = page_id(&mut m);
    let p1 = ok(
        &mut m,
        &format!("{A} paged.insertPath({pid:?}, [A(300, 600), A(400, 600)], true, false)"),
    );
    let p2 = ok(
        &mut m,
        &format!("{A} paged.insertPath({pid:?}, [A(400, 600), A(500, 650)], true, false)"),
    );
    refuses(&mut m, &format!("paged.joinPaths({p1:?})"), "false");
    refuses(
        &mut m,
        &format!("paged.joinPaths({p1:?}, 'not an address')"),
        "false",
    );
    throws(
        &mut m,
        &format!("paged.joinPaths({p1:?}, Symbol('o'))"),
        SYMBOL_TO_STRING,
    );
    writes(&mut m, &format!("paged.joinPaths({p1:?}, {p2:?})"), "true");
}

/// A page with an open path and a story that no frame holds any more.
fn path_and_free_story() -> (CanvasModel, String, String) {
    let (mut m, pid, frame, sid) = with_story("Hello world");
    let path = ok(
        &mut m,
        &format!("{A} paged.insertPath({pid:?}, [A(100, 500), A(300, 500)], true, false)"),
    );
    // A story still flowing into a frame refuses a path ("one story, one flow").
    let busy = ok(
        &mut m,
        &format!("paged.attachTextToPath({path:?}, {sid:?})"),
    );
    assert_eq!(busy, "false");
    ok(&mut m, &format!("paged.deleteElement({frame:?})"));
    (m, path, sid)
}

#[test]
fn attach_text_to_path() {
    covers!("script:paged.attachTextToPath");
    let (mut m, path, sid) = path_and_free_story();
    refuses(
        &mut m,
        &format!("paged.attachTextToPath('not an address', {sid:?})"),
        "false",
    );
    refuses(
        &mut m,
        &format!("paged.attachTextToPath({path:?}, 'no-such-story')"),
        "false",
    );
    throws(
        &mut m,
        &format!("paged.attachTextToPath({path:?}, Symbol('s'))"),
        SYMBOL_TO_STRING,
    );
    writes(
        &mut m,
        &format!(
            "paged.attachTextToPath({path:?}, {sid:?}, {{ pathTypeAlignment: 'CenterPathType' }})"
        ),
        "true",
    );
}

#[test]
fn detach_text_from_path() {
    covers!("script:paged.detachTextFromPath");
    let (mut m, path, sid) = path_and_free_story();
    ok(
        &mut m,
        &format!("paged.attachTextToPath({path:?}, {sid:?})"),
    );
    refuses(&mut m, "paged.detachTextFromPath()", "false");
    refuses(
        &mut m,
        "paged.detachTextFromPath('not an address')",
        "false",
    );
    throws(
        &mut m,
        "paged.detachTextFromPath(Symbol('p'))",
        SYMBOL_TO_STRING,
    );
    writes(
        &mut m,
        &format!("paged.detachTextFromPath({path:?})"),
        "true",
    );
    assert_eq!(
        json_of(&ok(&mut m, "paged.stories()"))
            .as_array()
            .map(Vec::len),
        Some(1),
        "the text survives"
    );
}
