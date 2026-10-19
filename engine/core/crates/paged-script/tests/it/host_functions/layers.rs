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

//! Layers: insert, remove, move and the four attribute setters, read back
//! through `paged.layers()`.

use super::*;

/// The layers, back to front as `paged.layers()` lists them.
fn layers(m: &mut CanvasModel) -> Value {
    json_of(&ok(m, "paged.layers()"))
}

/// A blank document (which lists no layer) with two: `Art` and `Ink`.
fn two_layers() -> CanvasModel {
    let mut m = blank();
    ok(
        &mut m,
        "paged.layerInsert(0, 'Art'); paged.layerInsert(1, 'Ink')",
    );
    assert_eq!(layers(&mut m).as_array().map(Vec::len), Some(2));
    m
}

#[test]
fn layer_insert() {
    covers!("script:paged.layerInsert");
    let mut m = blank();
    let n = layers(&mut m).as_array().map(Vec::len).unwrap_or(0);
    throws(
        &mut m,
        "paged.layerInsert(Symbol('p'), 'Art')",
        SYMBOL_TO_STRING,
    );
    throws(
        &mut m,
        "paged.layerInsert(0, Symbol('n'))",
        SYMBOL_TO_STRING,
    );
    // SCR-1 (fixed): a missing name is refused, no layer is added.
    refuses(&mut m, "paged.layerInsert(0)", "false");
    writes(&mut m, "paged.layerInsert(0, 'Art')", "true");
    let after = layers(&mut m);
    assert_eq!(after.as_array().map(Vec::len), Some(n + 1));
    assert!(
        after.as_array().unwrap().iter().any(|l| l["name"] == "Art"),
        "{after}"
    );
    has_keys(
        &after[0],
        &["selfId", "name", "visible", "locked", "printable", "z"],
    );
}

#[test]
fn layer_remove() {
    covers!("script:paged.layerRemove");
    let mut m = two_layers();
    refuses(&mut m, "paged.layerRemove()", "false");
    refuses(&mut m, "paged.layerRemove('no-such-layer')", "false");
    throws(&mut m, "paged.layerRemove(Symbol('l'))", SYMBOL_TO_STRING);
    let id = ok(
        &mut m,
        "JSON.parse(paged.layers()).find(l => l.name === 'Art').selfId",
    );
    writes(&mut m, &format!("paged.layerRemove({id:?})"), "true");
    assert!(!layers(&mut m).to_string().contains("\"Art\""));
}

#[test]
fn layer_move() {
    covers!("script:paged.layerMove");
    let mut m = two_layers();
    refuses(&mut m, "paged.layerMove('no-such-layer', 0)", "false");
    throws(&mut m, "paged.layerMove(Symbol('l'), 0)", SYMBOL_TO_STRING);
    let before = layers(&mut m);
    let first = before[0]["selfId"].as_str().unwrap().to_string();
    writes(&mut m, &format!("paged.layerMove({first:?}, 1)"), "true");
    assert_eq!(layers(&mut m)[1]["selfId"], first.as_str());
}

/// The three flag setters share one shape: `(layerId, bool)`.
fn flag(name: &str, field: &str) {
    let mut m = two_layers();
    let id = ok(&mut m, "JSON.parse(paged.layers())[0].selfId");
    refuses(
        &mut m,
        &format!("paged.{name}('no-such-layer', false)"),
        "false",
    );
    throws(
        &mut m,
        &format!("paged.{name}(Symbol('l'), false)"),
        SYMBOL_TO_STRING,
    );
    let was = layers(&mut m)[0][field].as_bool().expect("a flag");
    writes(&mut m, &format!("paged.{name}({id:?}, {})", !was), "true");
    assert_eq!(layers(&mut m)[0][field].as_bool(), Some(!was), "{name}");
}

#[test]
fn layer_set_visible() {
    covers!("script:paged.layerSetVisible");
    flag("layerSetVisible", "visible");
}

#[test]
fn layer_set_locked() {
    covers!("script:paged.layerSetLocked");
    flag("layerSetLocked", "locked");
}

#[test]
fn layer_set_printable() {
    covers!("script:paged.layerSetPrintable");
    flag("layerSetPrintable", "printable");
}

#[test]
fn layer_set_name() {
    covers!("script:paged.layerSetName");
    let mut m = two_layers();
    let id = ok(&mut m, "JSON.parse(paged.layers())[0].selfId");
    refuses(
        &mut m,
        "paged.layerSetName('no-such-layer', 'Ink')",
        "false",
    );
    // SCR-1 (fixed): a missing name is refused.
    refuses(&mut m, &format!("paged.layerSetName({id:?})"), "false");
    assert_ne!(layers(&mut m)[0]["name"], "undefined");
    throws(
        &mut m,
        &format!("paged.layerSetName({id:?}, Symbol('n'))"),
        SYMBOL_TO_STRING,
    );
    writes(
        &mut m,
        &format!("paged.layerSetName({id:?}, 'Ink')"),
        "true",
    );
    assert_eq!(layers(&mut m)[0]["name"], "Ink");
}
