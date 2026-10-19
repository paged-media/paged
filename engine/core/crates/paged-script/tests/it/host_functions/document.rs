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

//! Document-level writes: the generic `paged.set`, defaults, colour
//! management, inks, metadata, conditions, text variables, guides,
//! sections and bookmarks.

use super::*;

#[test]
fn set() {
    covers!("script:paged.set");
    let mut m = blank();
    refuses(&mut m, "paged.set()", "false");
    refuses(&mut m, "paged.set('doc', 'notAPath', 1)", "false");
    refuses(
        &mut m,
        "paged.set('doc', 'documentBleedTop', 'wide')",
        "false",
    );
    refuses(
        &mut m,
        "paged.set('nonsense:::', 'documentBleedTop', '3mm')",
        "false",
    );
    throws(
        &mut m,
        "paged.set('doc', Symbol('p'), '3mm')",
        SYMBOL_TO_STRING,
    );
    writes(
        &mut m,
        "paged.set('doc', 'documentBleedTop', '3mm')",
        "true",
    );
    let back = json_of(&ok(&mut m, "paged.get('doc', 'documentBleedTop')"));
    assert_eq!(back["type"], "length", "{back}");
    let pt = back["value"].as_f64().expect("a number");
    assert!((pt - 8.503).abs() < 0.01, "3mm in points, got {pt}");
    // An element path through the same door.
    let pid = page_id(&mut m);
    let oval = ok(
        &mut m,
        &format!("paged.insertOval({pid:?}, [100, 100, 200, 200])"),
    );
    writes(
        &mut m,
        &format!("paged.set({oval:?}, 'frameOpacity', 40)"),
        "true",
    );
}

#[test]
fn set_document_defaults() {
    covers!("script:paged.setDocumentDefaults");
    let mut m = blank();
    // Every field is optional: nothing given sets nothing. A field whose
    // value has no string form is dropped the same way.
    no_op(&mut m, "paged.setDocumentDefaults()", "true");
    no_op(
        &mut m,
        "paged.setDocumentDefaults({ fill: Symbol('f') })",
        "true",
    );
    sets(
        &mut m,
        "paged.setDocumentDefaults({ stroke: 'Color/Black', weight: 1 })",
        "true",
    );
    let meta = json_of(&ok(&mut m, "paged.documentMeta()"));
    assert_eq!(meta["defaultStrokeColor"], "Color/Black");
    assert_eq!(meta["defaultStrokeWeight"], 1.0);
}

#[test]
fn set_color_settings() {
    covers!("script:paged.setColorSettings");
    let mut m = blank();
    refuses(&mut m, "paged.setColorSettings()", "false");
    refuses(&mut m, "paged.setColorSettings({ bpc: 'yes' })", "false");
    sets(
        &mut m,
        "paged.setColorSettings({ intent: 'Perceptual', bpc: false })",
        "true",
    );
    let meta = json_of(&ok(&mut m, "paged.documentMeta()"));
    assert_eq!(meta["renderingIntent"], "Perceptual");
    assert_eq!(meta["blackPointCompensation"], false);
}

#[test]
fn set_proof_setup() {
    covers!("script:paged.setProofSetup");
    let mut m = blank();
    refuses(&mut m, "paged.setProofSetup()", "false");
    refuses(
        &mut m,
        "paged.setProofSetup({ simulatePaperWhite: 'yes' })",
        "false",
    );
    // A profile the host has not registered is refused.
    refuses(
        &mut m,
        "paged.setProofSetup({ profileName: 'No Such Profile' })",
        "false",
    );
    // No profile named turns proofing off, which it already is: nothing
    // changes. (Proofing ON needs a registered ICC profile, which the
    // public repository does not carry.)
    no_op(
        &mut m,
        "paged.setProofSetup({ simulatePaperWhite: true })",
        "true",
    );
    assert_eq!(
        json_of(&ok(&mut m, "paged.documentMeta()"))["proofProfileName"],
        Value::Null
    );
}

#[test]
fn import_swatch_library() {
    covers!("script:paged.importSwatchLibrary");
    let mut source = blank();
    ok(
        &mut source,
        "paged.createSwatch({ space: 'CMYK', value: [0, 100, 100, 0], name: 'Brand Red' })",
    );
    let ase = source.export_ase(None);
    assert!(ase.starts_with(b"ASEF"), "an ASE file");
    let bytes = format!("{:?}", ase);
    let mut m = blank();
    refuses(&mut m, "paged.importSwatchLibrary()", "false");
    refuses(&mut m, "paged.importSwatchLibrary([1, 2, 3])", "false");
    refuses(&mut m, "paged.importSwatchLibrary('ASEF')", "false");
    writes(
        &mut m,
        &format!("paged.importSwatchLibrary({bytes}, 'Brand')"),
        "true",
    );
    assert!(ok(&mut m, "paged.swatches()").contains("Brand Red"));
}

#[test]
fn set_ink_setting() {
    covers!("script:paged.setInkSetting");
    // The swatches sample carries a spot ink and no history.
    let mut m = sample("swatches");
    let spot = "Color/InkFull";
    refuses(
        &mut m,
        "paged.setInkSetting('Color/no-such-ink', { convertToProcess: true })",
        "false",
    );
    throws(
        &mut m,
        "paged.setInkSetting(Symbol('i'), { convertToProcess: true })",
        SYMBOL_TO_STRING,
    );
    sets(
        &mut m,
        &format!("paged.setInkSetting({spot:?}, {{ convertToProcess: true }})"),
        "true",
    );
}

#[test]
fn set_use_standard_lab_for_spots() {
    covers!("script:paged.setUseStandardLabForSpots");
    let mut m = blank();
    // Any value is read as a boolean; there is nothing to refuse.
    sets(&mut m, "paged.setUseStandardLabForSpots(true)", "true");
    assert_eq!(
        json_of(&ok(&mut m, "paged.documentMeta()"))["useStandardLabForSpots"],
        true
    );
    sets(&mut m, "paged.setUseStandardLabForSpots(0)", "true");
    assert_eq!(
        json_of(&ok(&mut m, "paged.documentMeta()"))["useStandardLabForSpots"],
        false
    );
}

const ENVELOPE: &str = r#"'{"v":1,"data":{"role":"hero"}}'"#;

#[test]
fn set_plugin_metadata() {
    covers!("script:paged.setPluginMetadata");
    let mut m = blank();
    let pid = page_id(&mut m);
    let oval = ok(
        &mut m,
        &format!("paged.insertOval({pid:?}, [100, 100, 200, 200])"),
    );
    refuses(
        &mut m,
        &format!("paged.setPluginMetadata('not an address', 'x-paged:role', {ENVELOPE})"),
        "false",
    );
    refuses(
        &mut m,
        &format!("paged.setPluginMetadata('oval:no-such-oval', 'x-paged:role', {ENVELOPE})"),
        "false",
    );
    throws(
        &mut m,
        &format!("paged.setPluginMetadata({oval:?}, Symbol('k'), {ENVELOPE})"),
        SYMBOL_TO_STRING,
    );
    writes(
        &mut m,
        &format!("paged.setPluginMetadata({oval:?}, 'x-paged:role', {ENVELOPE})"),
        "true",
    );
    assert!(snapshot(&m).to_string().contains("x-paged:role"));
    // No value deletes it.
    writes(
        &mut m,
        &format!("paged.setPluginMetadata({oval:?}, 'x-paged:role')"),
        "true",
    );
}

#[test]
fn set_document_metadata() {
    covers!("script:paged.setDocumentMetadata");
    let mut m = blank();
    throws(
        &mut m,
        &format!("paged.setDocumentMetadata(Symbol('k'), {ENVELOPE})"),
        SYMBOL_TO_STRING,
    );
    writes(
        &mut m,
        &format!("paged.setDocumentMetadata('x-paged:brand', {ENVELOPE})"),
        "true",
    );
    assert!(snapshot(&m).to_string().contains("x-paged:brand"));
    writes(&mut m, "paged.setDocumentMetadata('x-paged:brand')", "true");
}

fn conditions(m: &mut CanvasModel) -> Value {
    json_of(&ok(m, "paged.conditions()"))
}

#[test]
fn set_condition_visible() {
    covers!("script:paged.setConditionVisible");
    let mut m = sample("conditions");
    let all = conditions(&mut m);
    let first = &all[0];
    has_keys(first, &["selfId", "visible"]);
    let id = first["selfId"].as_str().unwrap().to_string();
    let was = first["visible"].as_bool().unwrap();
    refuses(
        &mut m,
        "paged.setConditionVisible('Condition/no-such-condition', false)",
        "false",
    );
    throws(
        &mut m,
        "paged.setConditionVisible(Symbol('c'), false)",
        SYMBOL_TO_STRING,
    );
    writes(
        &mut m,
        &format!("paged.setConditionVisible({id:?}, {})", !was),
        "true",
    );
    assert_eq!(conditions(&mut m)[0]["visible"].as_bool(), Some(!was));
}

#[test]
fn activate_condition_set() {
    covers!("script:paged.activateConditionSet");
    let mut m = sample("conditions");
    let sets = json_of(&ok(&mut m, "paged.conditionSets()"));
    refuses(
        &mut m,
        "paged.activateConditionSet('ConditionSet/no-such-set')",
        "false",
    );
    refuses(&mut m, "paged.activateConditionSet()", "false");
    throws(
        &mut m,
        "paged.activateConditionSet(Symbol('s'))",
        SYMBOL_TO_STRING,
    );
    let id = sets[0]["selfId"]
        .as_str()
        .expect("the conditions sample has a set")
        .to_string();
    let before = snapshot(&m);
    assert_eq!(
        ok(&mut m, &format!("paged.activateConditionSet({id:?})")),
        "true"
    );
    if snapshot(&m) != before {
        assert_eq!(ok(&mut m, "paged.undo()"), "true");
        assert!(
            snapshot(&m) == before,
            "undo restores the condition visibility"
        );
    }
}

#[test]
fn create_text_variable() {
    covers!("script:paged.createTextVariable");
    let mut m = blank();
    throws(
        &mut m,
        "paged.createTextVariable(Symbol('n'))",
        SYMBOL_TO_STRING,
    );
    let id = mints(
        &mut m,
        "paged.createTextVariable('Edition', 'Autumn', '(', ')')",
        |s| s.starts_with("textVariable:"),
    );
    assert!(snapshot(&m).to_string().contains("Autumn"), "{id}");
    // The same name twice is refused.
    refuses(
        &mut m,
        "paged.createTextVariable('Edition', 'Winter')",
        "null",
    );
}

#[test]
fn delete_text_variable() {
    covers!("script:paged.deleteTextVariable");
    let mut m = blank();
    let id = ok(&mut m, "paged.createTextVariable('Edition', 'Autumn')");
    refuses(&mut m, "paged.deleteTextVariable()", "false");
    refuses(
        &mut m,
        "paged.deleteTextVariable('textVariable:no-such-variable')",
        "false",
    );
    throws(
        &mut m,
        "paged.deleteTextVariable(Symbol('v'))",
        SYMBOL_TO_STRING,
    );
    writes(&mut m, &format!("paged.deleteTextVariable({id:?})"), "true");
    assert!(!snapshot(&m).to_string().contains("Autumn"));
}

fn spread_and_guides(m: &mut CanvasModel) -> (String, Value) {
    let spread = json_of(&ok(m, "paged.collection('spreads')"))[0].clone();
    (
        spread["selfId"].as_str().expect("selfId").to_string(),
        spread["guides"].clone(),
    )
}

#[test]
fn insert_guide() {
    covers!("script:paged.insertGuide");
    let mut m = blank();
    let (spread, guides) = spread_and_guides(&mut m);
    let n = guides.as_array().map_or(0, Vec::len);
    refuses(
        &mut m,
        &format!("paged.insertGuide({spread:?}, 'diagonal', 144)"),
        "false",
    );
    refuses(&mut m, &format!("paged.insertGuide({spread:?})"), "false");
    refuses(
        &mut m,
        "paged.insertGuide('no-such-spread', 'vertical', 144)",
        "false",
    );
    throws(
        &mut m,
        &format!("paged.insertGuide({spread:?}, 'vertical', Symbol('p'))"),
        SYMBOL_TO_STRING,
    );
    writes(
        &mut m,
        &format!("paged.insertGuide({spread:?}, 'vertical', 144, 0)"),
        "true",
    );
    let (_, after) = spread_and_guides(&mut m);
    assert_eq!(after.as_array().map_or(0, Vec::len), n + 1);
    has_keys(&after[n], &["id"]);
}

fn with_guide() -> (CanvasModel, String) {
    let mut m = blank();
    let (spread, _) = spread_and_guides(&mut m);
    ok(
        &mut m,
        &format!("paged.insertGuide({spread:?}, 'vertical', 144, 0)"),
    );
    let (_, guides) = spread_and_guides(&mut m);
    let g = guides.as_array().and_then(|a| a.last()).expect("a guide")["id"]
        .as_str()
        .expect("id")
        .to_string();
    (m, g)
}

#[test]
fn move_guide() {
    covers!("script:paged.moveGuide");
    let (mut m, g) = with_guide();
    refuses(&mut m, "paged.moveGuide('no-such-guide', 216)", "false");
    throws(
        &mut m,
        &format!("paged.moveGuide({g:?}, Symbol('p'))"),
        SYMBOL_TO_STRING,
    );
    writes(&mut m, &format!("paged.moveGuide({g:?}, 216)"), "true");
    assert!(ok(&mut m, "paged.collection('spreads')").contains("216"));
}

#[test]
fn delete_guide() {
    covers!("script:paged.deleteGuide");
    let (mut m, g) = with_guide();
    refuses(&mut m, "paged.deleteGuide()", "false");
    refuses(&mut m, "paged.deleteGuide('no-such-guide')", "false");
    throws(&mut m, "paged.deleteGuide(Symbol('g'))", SYMBOL_TO_STRING);
    writes(&mut m, &format!("paged.deleteGuide({g:?})"), "true");
    assert!(!ok(&mut m, "paged.collection('spreads')").contains(g.as_str()));
}

fn sections(m: &mut CanvasModel) -> Value {
    json_of(&ok(m, "paged.collection('sections')"))
}

#[test]
fn insert_section() {
    covers!("script:paged.insertSection");
    let mut m = blank();
    let pid = page_id(&mut m);
    let n = sections(&mut m).as_array().map_or(0, Vec::len);
    refuses(
        &mut m,
        "paged.insertSection('no-such-page', { style: 'lowerRoman' })",
        "false",
    );
    throws(&mut m, "paged.insertSection(Symbol('p'))", SYMBOL_TO_STRING);
    writes(
        &mut m,
        &format!("paged.insertSection({pid:?}, {{ prefix: 'A-', style: 'lowerRoman', start: 3 }})"),
        "true",
    );
    let after = sections(&mut m);
    assert!(after.as_array().map_or(0, Vec::len) >= n.max(1), "{after}");
    has_keys(&after[0], &["selfId"]);
}

fn with_section() -> (CanvasModel, String) {
    let mut m = blank();
    let pid = page_id(&mut m);
    ok(
        &mut m,
        &format!("paged.insertSection({pid:?}, {{ style: 'arabic', start: 1 }})"),
    );
    let id = sections(&mut m)[0]["selfId"]
        .as_str()
        .expect("selfId")
        .to_string();
    (m, id)
}

#[test]
fn edit_section() {
    covers!("script:paged.editSection");
    let (mut m, id) = with_section();
    refuses(&mut m, &format!("paged.editSection({id:?})"), "false");
    refuses(
        &mut m,
        "paged.editSection('no-such-section', { prefix: 'B-' })",
        "false",
    );
    throws(
        &mut m,
        &format!("paged.editSection({id:?}, {{ prefix: Symbol('p') }})"),
        SYMBOL_TO_STRING,
    );
    writes(
        &mut m,
        &format!("paged.editSection({id:?}, {{ prefix: 'B-' }})"),
        "true",
    );
    assert!(sections(&mut m).to_string().contains("B-"));
}

#[test]
fn delete_section() {
    covers!("script:paged.deleteSection");
    let (mut m, id) = with_section();
    refuses(&mut m, "paged.deleteSection()", "false");
    refuses(&mut m, "paged.deleteSection('no-such-section')", "false");
    throws(&mut m, "paged.deleteSection(Symbol('s'))", SYMBOL_TO_STRING);
    writes(&mut m, &format!("paged.deleteSection({id:?})"), "true");
    assert!(!sections(&mut m).to_string().contains(id.as_str()));
}

fn bookmarks(m: &mut CanvasModel) -> Value {
    json_of(&ok(m, "paged.collection('bookmarks')"))
}

#[test]
fn create_bookmark() {
    covers!("script:paged.createBookmark");
    let mut m = blank();
    let pid = page_id(&mut m);
    throws(
        &mut m,
        "paged.createBookmark(Symbol('n'))",
        SYMBOL_TO_STRING,
    );
    let id = mints(
        &mut m,
        &format!("paged.createBookmark('Intro', {{ page: {pid:?} }})"),
        |s| !s.is_empty() && s != "null",
    );
    let all = bookmarks(&mut m);
    assert!(all.to_string().contains("Intro"), "{all}");
    has_keys(&all[0], &["selfId", "name"]);
    let child = mints(
        &mut m,
        &format!("paged.createBookmark('Part', {{ page: {pid:?}, parent: {id:?} }})"),
        |s| !s.is_empty() && s != "null",
    );
    assert_ne!(child, id);
}

fn with_bookmarks() -> (CanvasModel, String, String) {
    let mut m = blank();
    let pid = page_id(&mut m);
    let a = ok(
        &mut m,
        &format!("paged.createBookmark('Intro', {{ page: {pid:?} }})"),
    );
    let b = ok(
        &mut m,
        &format!("paged.createBookmark('Outro', {{ page: {pid:?} }})"),
    );
    (m, a, b)
}

#[test]
fn delete_bookmark() {
    covers!("script:paged.deleteBookmark");
    let (mut m, a, _) = with_bookmarks();
    refuses(&mut m, "paged.deleteBookmark()", "false");
    refuses(&mut m, "paged.deleteBookmark('no-such-bookmark')", "false");
    throws(
        &mut m,
        "paged.deleteBookmark(Symbol('b'))",
        SYMBOL_TO_STRING,
    );
    writes(&mut m, &format!("paged.deleteBookmark({a:?})"), "true");
    assert!(!bookmarks(&mut m).to_string().contains("Intro"));
}

#[test]
fn rename_bookmark() {
    covers!("script:paged.renameBookmark");
    let (mut m, a, _) = with_bookmarks();
    refuses(
        &mut m,
        "paged.renameBookmark('no-such-bookmark', 'X')",
        "false",
    );
    throws(
        &mut m,
        &format!("paged.renameBookmark({a:?}, Symbol('n'))"),
        SYMBOL_TO_STRING,
    );
    // finding SCR-1: a missing name is renamed to the text "undefined"; it should be refused.
    writes(&mut m, &format!("paged.renameBookmark({a:?})"), "true");
    assert!(bookmarks(&mut m).to_string().contains("\"undefined\""));
    writes(
        &mut m,
        &format!("paged.renameBookmark({a:?}, 'Preface')"),
        "true",
    );
    assert!(bookmarks(&mut m).to_string().contains("Preface"));
}

#[test]
fn move_bookmark() {
    covers!("script:paged.moveBookmark");
    let (mut m, a, b) = with_bookmarks();
    refuses(&mut m, "paged.moveBookmark('no-such-bookmark')", "false");
    throws(
        &mut m,
        &format!("paged.moveBookmark({a:?}, null, Symbol('i'))"),
        SYMBOL_TO_STRING,
    );
    writes(
        &mut m,
        &format!("paged.moveBookmark({b:?}, null, 0)"),
        "true",
    );
    assert_eq!(bookmarks(&mut m)[0]["selfId"], b.as_str());
    writes(&mut m, &format!("paged.moveBookmark({a:?}, {b:?})"), "true");
}
