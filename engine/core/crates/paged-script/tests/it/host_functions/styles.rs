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

//! Styles (paragraph, character, object, cell, table: create, rename,
//! delete), style properties and numbering lists.

use super::*;

/// One style family: its fn stem and the collection that lists it.
struct Family {
    stem: &'static str,
    collection: &'static str,
}

const PARAGRAPH: Family = Family {
    stem: "ParagraphStyle",
    collection: "paragraphStyles",
};
const CHARACTER: Family = Family {
    stem: "CharacterStyle",
    collection: "characterStyles",
};
const OBJECT: Family = Family {
    stem: "ObjectStyle",
    collection: "objectStyles",
};
const CELL: Family = Family {
    stem: "CellStyle",
    collection: "cellStyles",
};
const TABLE: Family = Family {
    stem: "TableStyle",
    collection: "tableStyles",
};

fn names(m: &mut CanvasModel, f: &Family) -> Vec<String> {
    json_of(&ok(m, &format!("paged.collection('{}')", f.collection)))
        .as_array()
        .expect("an array")
        .iter()
        .filter_map(|s| s["name"].as_str().map(String::from))
        .collect()
}

fn create(f: &Family) {
    let mut m = blank();
    let stem = f.stem;
    // The spec is optional: no argument mints an unnamed style.
    let unnamed = mints(&mut m, &format!("paged.create{stem}()"), |s| {
        !s.is_empty() && s != "null"
    });
    // SCR-3 (fixed): a spec that is not an object (here the name alone) is
    // refused (null), the document untouched.
    refuses(&mut m, &format!("paged.create{stem}('Body')"), "null");
    refuses(&mut m, &format!("paged.create{stem}(42)"), "null");
    assert!(
        !names(&mut m, f).iter().any(|n| n == "Body"),
        "{stem}: {unnamed}"
    );
    let id = mints(
        &mut m,
        &format!("paged.create{stem}({{ name: 'Body' }})"),
        |s| !s.is_empty() && s != "null",
    );
    assert!(names(&mut m, f).iter().any(|n| n == "Body"), "{stem}: {id}");
    let based = mints(
        &mut m,
        &format!("paged.create{stem}({{ name: 'Lead', basedOn: {id:?} }})"),
        |s| !s.is_empty() && s != "null",
    );
    assert_ne!(based, id);
}

fn create_one(m: &mut CanvasModel, f: &Family, name: &str) -> String {
    ok(m, &format!("paged.create{}({{ name: {name:?} }})", f.stem))
}

fn rename(f: &Family) {
    let mut m = blank();
    let stem = f.stem;
    let id = create_one(&mut m, f, "Body");
    refuses(
        &mut m,
        &format!("paged.rename{stem}('{stem}/Nope', 'X')"),
        "false",
    );
    throws(
        &mut m,
        &format!("paged.rename{stem}(Symbol('s'), 'X')"),
        SYMBOL_TO_STRING,
    );
    throws(
        &mut m,
        &format!("paged.rename{stem}({id:?}, Symbol('n'))"),
        SYMBOL_TO_STRING,
    );
    // SCR-1 (fixed): a missing name is refused.
    refuses(&mut m, &format!("paged.rename{stem}({id:?})"), "false");
    assert!(!names(&mut m, f).iter().any(|n| n == "undefined"), "{stem}");
    writes(
        &mut m,
        &format!("paged.rename{stem}({id:?}, 'Text')"),
        "true",
    );
    let now = names(&mut m, f);
    assert!(
        now.iter().any(|n| n == "Text") && !now.iter().any(|n| n == "Body"),
        "{stem}: {now:?}"
    );
}

fn delete(f: &Family) {
    let mut m = blank();
    let stem = f.stem;
    let id = create_one(&mut m, f, "Body");
    refuses(&mut m, &format!("paged.delete{stem}()"), "false");
    refuses(
        &mut m,
        &format!("paged.delete{stem}('{stem}/Nope')"),
        "false",
    );
    throws(
        &mut m,
        &format!("paged.delete{stem}(Symbol('s'))"),
        SYMBOL_TO_STRING,
    );
    writes(&mut m, &format!("paged.delete{stem}({id:?})"), "true");
    assert!(!names(&mut m, f).iter().any(|n| n == "Body"), "{stem}");
}

#[test]
fn create_paragraph_style() {
    covers!("script:paged.createParagraphStyle");
    create(&PARAGRAPH);
}

#[test]
fn rename_paragraph_style() {
    covers!("script:paged.renameParagraphStyle");
    rename(&PARAGRAPH);
}

#[test]
fn delete_paragraph_style() {
    covers!("script:paged.deleteParagraphStyle");
    delete(&PARAGRAPH);
}

#[test]
fn create_character_style() {
    covers!("script:paged.createCharacterStyle");
    create(&CHARACTER);
}

#[test]
fn rename_character_style() {
    covers!("script:paged.renameCharacterStyle");
    rename(&CHARACTER);
}

#[test]
fn delete_character_style() {
    covers!("script:paged.deleteCharacterStyle");
    delete(&CHARACTER);
}

#[test]
fn create_object_style() {
    covers!("script:paged.createObjectStyle");
    create(&OBJECT);
}

#[test]
fn rename_object_style() {
    covers!("script:paged.renameObjectStyle");
    rename(&OBJECT);
}

#[test]
fn delete_object_style() {
    covers!("script:paged.deleteObjectStyle");
    delete(&OBJECT);
}

#[test]
fn create_cell_style() {
    covers!("script:paged.createCellStyle");
    create(&CELL);
}

#[test]
fn rename_cell_style() {
    covers!("script:paged.renameCellStyle");
    rename(&CELL);
}

#[test]
fn delete_cell_style() {
    covers!("script:paged.deleteCellStyle");
    delete(&CELL);
}

#[test]
fn create_table_style() {
    covers!("script:paged.createTableStyle");
    create(&TABLE);
}

#[test]
fn rename_table_style() {
    covers!("script:paged.renameTableStyle");
    rename(&TABLE);
}

#[test]
fn delete_table_style() {
    covers!("script:paged.deleteTableStyle");
    delete(&TABLE);
}

#[test]
fn set_style_property() {
    covers!("script:paged.setStyleProperty");
    let mut m = blank();
    let id = create_one(&mut m, &PARAGRAPH, "Body");
    refuses(
        &mut m,
        &format!("paged.setStyleProperty('nope', {id:?}, 'characterFontSize', 10)"),
        "false",
    );
    refuses(
        &mut m,
        &format!("paged.setStyleProperty('paragraph', {id:?}, 'notAPath', 10)"),
        "false",
    );
    refuses(
        &mut m,
        &format!("paged.setStyleProperty('paragraph', {id:?}, 'characterFontSize', 'big')"),
        "false",
    );
    refuses(&mut m, "paged.setStyleProperty('paragraph')", "false");
    throws(
        &mut m,
        "paged.setStyleProperty('paragraph', Symbol('s'), 'characterFontSize', 10)",
        SYMBOL_TO_STRING,
    );
    writes(
        &mut m,
        &format!("paged.setStyleProperty('paragraph', {id:?}, 'characterFontSize', 10)"),
        "true",
    );
    writes(
        &mut m,
        &format!("paged.setStyleProperty('paragraph', {id:?}, 'paragraphSpaceAfter', 4)"),
        "true",
    );
}

fn lists(m: &mut CanvasModel) -> Value {
    json_of(&ok(m, "paged.collection('numberingLists')"))
}

#[test]
fn create_numbering_list() {
    covers!("script:paged.createNumberingList");
    let mut m = blank();
    refuses(&mut m, "paged.createNumberingList()", "null");
    refuses(&mut m, "paged.createNumberingList('Steps')", "null");
    let id = mints(
        &mut m,
        "paged.createNumberingList({ name: 'Steps' })",
        |s| !s.is_empty() && s != "null",
    );
    let all = lists(&mut m);
    assert!(
        all.as_array()
            .unwrap()
            .iter()
            .any(|l| l["selfId"] == id.as_str()),
        "{all}"
    );
}

#[test]
fn edit_numbering_list() {
    covers!("script:paged.editNumberingList");
    let mut m = blank();
    let id = ok(&mut m, "paged.createNumberingList({ name: 'Steps' })");
    refuses(&mut m, &format!("paged.editNumberingList({id:?})"), "false");
    refuses(
        &mut m,
        &format!("paged.editNumberingList({id:?}, 'x')"),
        "false",
    );
    refuses(
        &mut m,
        "paged.editNumberingList('NumberingList/Nope', { name: 'X' })",
        "false",
    );
    throws(
        &mut m,
        "paged.editNumberingList(Symbol('l'), { name: 'X' })",
        SYMBOL_TO_STRING,
    );
    writes(
        &mut m,
        &format!("paged.editNumberingList({id:?}, {{ continueAcrossStories: true }})"),
        "true",
    );
}

#[test]
fn delete_numbering_list() {
    covers!("script:paged.deleteNumberingList");
    let mut m = blank();
    let id = ok(&mut m, "paged.createNumberingList({ name: 'Steps' })");
    refuses(&mut m, "paged.deleteNumberingList()", "false");
    refuses(
        &mut m,
        "paged.deleteNumberingList('NumberingList/Nope')",
        "false",
    );
    throws(
        &mut m,
        "paged.deleteNumberingList(Symbol('l'))",
        SYMBOL_TO_STRING,
    );
    writes(
        &mut m,
        &format!("paged.deleteNumberingList({id:?})"),
        "true",
    );
    assert!(!lists(&mut m).to_string().contains(id.as_str()));
}
