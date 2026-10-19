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

//! Tables: insert and delete, rows, columns, header and footer rows,
//! sizes and spans. Read back through the table's address (`paged.get`).

use super::*;

/// A story holding a 3 × 3 table; returns the model, story and table ids.
fn with_table() -> (CanvasModel, String, String) {
    let (mut m, _, _, sid) = with_story("Prices");
    let tid = ok(
        &mut m,
        &format!("paged.insertTable({sid:?}, {{ rows: 3, cols: 3 }})"),
    );
    (m, sid, tid)
}

/// The table's row and column counts, read through its address.
fn shape(m: &mut CanvasModel) -> (u64, u64) {
    let addr = ok(m, "JSON.parse(paged.query('table'))[0]");
    let count = |m: &mut CanvasModel, path: &str| {
        let v = json_of(&ok(m, &format!("paged.get({addr:?}, '{path}')")));
        v["value"].as_f64().unwrap_or_else(|| panic!("{path}: {v}")) as u64
    };
    (count(m, "tableRowCount"), count(m, "tableColumnCount"))
}

fn rows(m: &mut CanvasModel, _tid: &str) -> u64 {
    shape(m).0
}

fn cols(m: &mut CanvasModel, _tid: &str) -> u64 {
    shape(m).1
}

#[test]
fn insert_table() {
    covers!("script:paged.insertTable");
    let (mut m, _, _, sid) = with_story("Prices");
    refuses(&mut m, &format!("paged.insertTable({sid:?})"), "null");
    refuses(
        &mut m,
        &format!("paged.insertTable({sid:?}, {{ rows: 'many', cols: 2 }})"),
        "null",
    );
    refuses(
        &mut m,
        "paged.insertTable('no-such-story', { rows: 2, cols: 2 })",
        "null",
    );
    throws(
        &mut m,
        "paged.insertTable(Symbol('s'), { rows: 2, cols: 2 })",
        SYMBOL_TO_STRING,
    );
    let tid = mints(
        &mut m,
        &format!("paged.insertTable({sid:?}, {{ rows: 2, cols: 3, headerRows: 1 }})"),
        |s| !s.is_empty() && s != "null",
    );
    assert_eq!(
        ok(&mut m, "JSON.parse(paged.query('table')).length"),
        "1",
        "{tid}"
    );
    assert_eq!(
        shape(&mut m),
        (2, 3),
        "{tid}: rows counts the header row too"
    );
}

#[test]
fn delete_table() {
    covers!("script:paged.deleteTable");
    let (mut m, sid, tid) = with_table();
    refuses(&mut m, &format!("paged.deleteTable({sid:?})"), "false");
    refuses(
        &mut m,
        &format!("paged.deleteTable({sid:?}, 'no-such-table')"),
        "false",
    );
    throws(
        &mut m,
        &format!("paged.deleteTable({sid:?}, Symbol('t'))"),
        SYMBOL_TO_STRING,
    );
    writes(
        &mut m,
        &format!("paged.deleteTable({sid:?}, {tid:?})"),
        "true",
    );
    assert_eq!(ok(&mut m, "paged.query('table')"), "[]");
}

#[test]
fn insert_table_row() {
    covers!("script:paged.insertTableRow");
    let (mut m, sid, tid) = with_table();
    refuses(
        &mut m,
        &format!("paged.insertTableRow({sid:?}, 'no-such-table', 0)"),
        "false",
    );
    throws(
        &mut m,
        &format!("paged.insertTableRow({sid:?}, {tid:?}, Symbol('a'))"),
        SYMBOL_TO_STRING,
    );
    writes(
        &mut m,
        &format!("paged.insertTableRow({sid:?}, {tid:?}, 1)"),
        "true",
    );
    assert_eq!(rows(&mut m, &tid), 4);
}

/// The serialized table (the first paragraph that hosts one).
fn table_json(m: &CanvasModel) -> Value {
    snapshot(m)["scene"]["stories"][0]["story"]["paragraphs"]
        .as_array()
        .and_then(|ps| ps.iter().find(|p| !p["table"].is_null()))
        .map(|p| p["table"].clone())
        .expect("a table")
}

fn cell_count(m: &CanvasModel) -> usize {
    table_json(m)["cells"].as_array().map_or(0, Vec::len)
}

/// A delete of one row or column of the 3 × 3 table, then its undo.
///
/// finding SCR-7: the undo brings every cell back, but not in the order the
/// table held them (the cell list is reordered, so the table does not equal
/// its before-state); it should restore the table exactly. Asserts the
/// CURRENT behaviour: the same cells, sorted by name, in a different order.
fn delete_then_undo(m: &mut CanvasModel, call: &str) {
    let by_name = |t: &Value| {
        let mut cells = t["cells"].as_array().cloned().unwrap_or_default();
        cells.sort_by_key(|c| c["name"].as_str().unwrap_or_default().to_string());
        cells
    };
    let before = table_json(m);
    assert_eq!(ok(m, call), "true", "{call}");
    assert_eq!(cell_count(m), 6, "{call}: three cells go");
    assert_eq!(ok(m, "paged.undo()"), "true");
    let undone = table_json(m);
    assert_eq!(
        by_name(&undone),
        by_name(&before),
        "{call}: every cell is back"
    );
    assert_ne!(undone["cells"], before["cells"], "{call}: in another order");
    assert_eq!(ok(m, "paged.redo()"), "true");
    assert_eq!(cell_count(m), 6);
}

#[test]
fn delete_table_row() {
    covers!("script:paged.deleteTableRow");
    let (mut m, sid, tid) = with_table();
    refuses(
        &mut m,
        &format!("paged.deleteTableRow({sid:?}, {tid:?}, 99)"),
        "false",
    );
    throws(
        &mut m,
        &format!("paged.deleteTableRow({sid:?}, {tid:?}, Symbol('a'))"),
        SYMBOL_TO_STRING,
    );
    delete_then_undo(
        &mut m,
        &format!("paged.deleteTableRow({sid:?}, {tid:?}, 1)"),
    );
    assert_eq!(rows(&mut m, &tid), 2);
}

#[test]
fn insert_table_column() {
    covers!("script:paged.insertTableColumn");
    let (mut m, sid, tid) = with_table();
    refuses(
        &mut m,
        &format!("paged.insertTableColumn({sid:?}, 'no-such-table', 0)"),
        "false",
    );
    throws(
        &mut m,
        &format!("paged.insertTableColumn({sid:?}, {tid:?}, Symbol('a'))"),
        SYMBOL_TO_STRING,
    );
    writes(
        &mut m,
        &format!("paged.insertTableColumn({sid:?}, {tid:?}, 1)"),
        "true",
    );
    assert_eq!(cols(&mut m, &tid), 4);
}

#[test]
fn delete_table_column() {
    covers!("script:paged.deleteTableColumn");
    let (mut m, sid, tid) = with_table();
    refuses(
        &mut m,
        &format!("paged.deleteTableColumn({sid:?}, {tid:?}, 99)"),
        "false",
    );
    throws(
        &mut m,
        &format!("paged.deleteTableColumn({sid:?}, {tid:?}, Symbol('a'))"),
        SYMBOL_TO_STRING,
    );
    delete_then_undo(
        &mut m,
        &format!("paged.deleteTableColumn({sid:?}, {tid:?}, 1)"),
    );
    assert_eq!(cols(&mut m, &tid), 2);
}

/// Header/footer add and remove share `(storyId, tableId) -> bool`.
fn band(add: &str, remove: &str) {
    let (mut m, sid, tid) = with_table();
    refuses(&mut m, &format!("paged.{add}({sid:?})"), "false");
    refuses(
        &mut m,
        &format!("paged.{add}({sid:?}, 'no-such-table')"),
        "false",
    );
    throws(
        &mut m,
        &format!("paged.{add}({sid:?}, Symbol('t'))"),
        SYMBOL_TO_STRING,
    );
    writes(&mut m, &format!("paged.{add}({sid:?}, {tid:?})"), "true");
    assert_eq!(rows(&mut m, &tid), 4, "{add}");
    refuses(
        &mut m,
        &format!("paged.{remove}({sid:?}, 'no-such-table')"),
        "false",
    );
    throws(
        &mut m,
        &format!("paged.{remove}({sid:?}, Symbol('t'))"),
        SYMBOL_TO_STRING,
    );
    writes(&mut m, &format!("paged.{remove}({sid:?}, {tid:?})"), "true");
    assert_eq!(rows(&mut m, &tid), 3, "{remove}");
}

#[test]
fn insert_header_row() {
    covers!("script:paged.insertHeaderRow");
    band("insertHeaderRow", "removeHeaderRow");
}

#[test]
fn remove_header_row() {
    covers!("script:paged.removeHeaderRow");
    let (mut m, sid, tid) = with_table();
    refuses(
        &mut m,
        &format!("paged.removeHeaderRow({sid:?}, {tid:?})"),
        "false",
    );
    ok(&mut m, &format!("paged.insertHeaderRow({sid:?}, {tid:?})"));
    writes(
        &mut m,
        &format!("paged.removeHeaderRow({sid:?}, {tid:?})"),
        "true",
    );
}

#[test]
fn insert_footer_row() {
    covers!("script:paged.insertFooterRow");
    band("insertFooterRow", "removeFooterRow");
}

#[test]
fn remove_footer_row() {
    covers!("script:paged.removeFooterRow");
    let (mut m, sid, tid) = with_table();
    refuses(
        &mut m,
        &format!("paged.removeFooterRow({sid:?}, {tid:?})"),
        "false",
    );
    ok(&mut m, &format!("paged.insertFooterRow({sid:?}, {tid:?})"));
    writes(
        &mut m,
        &format!("paged.removeFooterRow({sid:?}, {tid:?})"),
        "true",
    );
}

#[test]
fn set_row_height() {
    covers!("script:paged.setRowHeight");
    let (mut m, sid, tid) = with_table();
    refuses(
        &mut m,
        &format!("paged.setRowHeight({sid:?}, 'no-such-table', 0, 30)"),
        "false",
    );
    refuses(
        &mut m,
        &format!("paged.setRowHeight({sid:?}, {tid:?}, 99, 30)"),
        "false",
    );
    throws(
        &mut m,
        &format!("paged.setRowHeight({sid:?}, {tid:?}, Symbol('r'), 30)"),
        SYMBOL_TO_STRING,
    );
    writes(
        &mut m,
        &format!("paged.setRowHeight({sid:?}, {tid:?}, 0, 30)"),
        "true",
    );
}

#[test]
fn set_column_width() {
    covers!("script:paged.setColumnWidth");
    let (mut m, sid, tid) = with_table();
    refuses(
        &mut m,
        &format!("paged.setColumnWidth({sid:?}, 'no-such-table', 0, 80)"),
        "false",
    );
    refuses(
        &mut m,
        &format!("paged.setColumnWidth({sid:?}, {tid:?}, 99, 80)"),
        "false",
    );
    throws(
        &mut m,
        &format!("paged.setColumnWidth({sid:?}, {tid:?}, Symbol('c'), 80)"),
        SYMBOL_TO_STRING,
    );
    writes(
        &mut m,
        &format!("paged.setColumnWidth({sid:?}, {tid:?}, 0, 80)"),
        "true",
    );
}

#[test]
fn set_cell_span() {
    covers!("script:paged.setCellSpan");
    let (mut m, sid, tid) = with_table();
    refuses(
        &mut m,
        &format!("paged.setCellSpan({sid:?}, 'no-such-table', 0, 0, 1, 2)"),
        "false",
    );
    throws(
        &mut m,
        &format!("paged.setCellSpan({sid:?}, {tid:?}, Symbol('r'), 0, 1, 2)"),
        SYMBOL_TO_STRING,
    );
    writes(
        &mut m,
        &format!("paged.setCellSpan({sid:?}, {tid:?}, 0, 0, 1, 2)"),
        "true",
    );
    assert_eq!(table_json(&m)["cells"][0]["column_span"], 2);
    // finding SCR-8: a span past the table's edge (9 columns of a 3-column table) is
    // stored; it should be refused.
    writes(
        &mut m,
        &format!("paged.setCellSpan({sid:?}, {tid:?}, 0, 0, 1, 9)"),
        "true",
    );
    assert_eq!(table_json(&m)["cells"][0]["column_span"], 9);
}
