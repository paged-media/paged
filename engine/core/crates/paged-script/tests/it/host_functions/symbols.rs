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

//! Engine ADR 1039 — symbols: make one from items, place, redefine, break
//! the link, delete, and the read.

use super::*;

/// A blank page with one frame on it; the frame's address.
fn with_frame() -> (CanvasModel, String, String) {
    let mut m = blank();
    let page = page_id(&mut m);
    let frame = ok(
        &mut m,
        &format!("paged.insertFrame({page:?}, [100, 100, 160, 160])"),
    );
    (m, page, last_line(&frame).to_string())
}

/// `with_frame`, its frame made the symbol `Symbol/t` (kept on the page).
fn with_symbol() -> (CanvasModel, String, String) {
    let (mut m, page, frame) = with_frame();
    ok(
        &mut m,
        &format!(
            "paged.createSymbol('Tile', [{frame:?}], {{ symbolId: 'Symbol/t', replace: false }})"
        ),
    );
    (m, page, frame)
}

#[test]
fn create_symbol() {
    covers!("script:paged.createSymbol");
    let (mut m, _, frame) = with_frame();
    refuses(&mut m, "paged.createSymbol('x', [])", "null");
    refuses(&mut m, "paged.createSymbol('x', 'nope')", "null");
    refuses(
        &mut m,
        &format!("paged.createSymbol('x', [{frame:?}], {{ nineSlice: [1] }})"),
        "null",
    );
    throws(
        &mut m,
        "paged.createSymbol(Symbol('s'), [])",
        SYMBOL_TO_STRING,
    );
    let id = mints(
        &mut m,
        &format!("paged.createSymbol('Tile', [{frame:?}])"),
        |s| s.starts_with("Symbol/"),
    );
    let list = json_of(&ok(&mut m, "paged.symbols()"));
    assert_eq!(list[0]["id"], serde_json::json!(id));
    assert_eq!(list[0]["instances"].as_array().map(Vec::len), Some(1));
}

#[test]
fn redefine_symbol() {
    covers!("script:paged.redefineSymbol");
    let (mut m, _, _) = with_symbol();
    refuses(
        &mut m,
        "paged.redefineSymbol('Symbol/none', { name: 'x' })",
        "false",
    );
    refuses(
        &mut m,
        "paged.redefineSymbol('Symbol/t', { nineSlice: [1, 2] })",
        "false",
    );
    writes(
        &mut m,
        "paged.redefineSymbol('Symbol/t', { name: 'Renamed' })",
        "true",
    );
    writes(
        &mut m,
        "paged.redefineSymbol('Symbol/t', { nineSlice: [4, 4, 4, 4] })",
        "true",
    );
}

#[test]
fn place_symbol_instance() {
    covers!("script:paged.placeSymbolInstance");
    let (mut m, page, _) = with_symbol();
    refuses(
        &mut m,
        &format!("paged.placeSymbolInstance('Symbol/none', {page:?})"),
        "null",
    );
    refuses(
        &mut m,
        &format!("paged.placeSymbolInstance('Symbol/t', {page:?}, [1])"),
        "null",
    );
    let instance = mints(
        &mut m,
        &format!("paged.placeSymbolInstance('Symbol/t', {page:?}, [300, 300], [2, 0, 0, 2])"),
        |s| s.starts_with("instance:"),
    );
    let id = instance.trim_start_matches("instance:");
    assert_eq!(
        json_of(&ok(&mut m, "paged.selection()")),
        serde_json::json!([{ "kind": "instance", "id": id }])
    );
}

#[test]
fn break_symbol_link() {
    covers!("script:paged.breakSymbolLink");
    let (mut m, page, _) = with_symbol();
    let instance = ok(
        &mut m,
        &format!("paged.placeSymbolInstance('Symbol/t', {page:?}, [300, 300])"),
    );
    let instance = last_line(&instance).to_string();
    refuses(&mut m, "paged.breakSymbolLink('instance:none')", "null");
    refuses(&mut m, "paged.breakSymbolLink('not an address')", "null");
    mints(
        &mut m,
        &format!("paged.breakSymbolLink({instance:?})"),
        |s| s.starts_with("rectangle:"),
    );
}

#[test]
fn delete_symbol() {
    covers!("script:paged.deleteSymbol");
    let (mut m, page, _) = with_symbol();
    ok(
        &mut m,
        &format!("paged.placeSymbolInstance('Symbol/t', {page:?}, [300, 300])"),
    );
    refuses(&mut m, "paged.deleteSymbol('Symbol/none')", "false");
    writes(&mut m, "paged.deleteSymbol('Symbol/t')", "true");
}

#[test]
fn symbols() {
    covers!("script:paged.symbols");
    let mut m = blank();
    assert_eq!(
        json_of(&reads(&mut m, "paged.symbols()")),
        serde_json::json!([])
    );
    let (mut m, _, _) = with_symbol();
    let list = json_of(&reads(&mut m, "paged.symbols()"));
    has_keys(
        &list[0],
        &[
            "id",
            "name",
            "revision",
            "bounds",
            "nineSlice",
            "itemCount",
            "instances",
        ],
    );
}
