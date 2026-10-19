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

//! Text: insert and delete, styles on a range, fields, hyperlinks, the
//! generated stories (contents, index, cross-references), footnotes,
//! endnotes, notes, tracked changes and the flow's grow rule.

use super::*;

/// The story's text, as `paged.inspect("story:…")` reports it.
pub fn story_text(m: &mut CanvasModel, sid: &str) -> String {
    ok(
        m,
        &format!(
            "JSON.stringify(JSON.parse(paged.inspect('story:{sid}')).entries.find(e => e.path === 'text').value)"
        ),
    )
}

fn collection_ids(m: &mut CanvasModel, name: &str, key: &str) -> Vec<String> {
    json_of(&ok(m, &format!("paged.collection('{name}')")))
        .as_array()
        .expect("an array")
        .iter()
        .filter_map(|e| e[key].as_str().map(String::from))
        .collect()
}

#[test]
fn insert_text() {
    covers!("script:paged.insertText");
    let (mut m, _, _, sid) = with_story("Hello");
    refuses(&mut m, "paged.insertText('no-such-story', 0, 'x')", "false");
    throws(
        &mut m,
        &format!("paged.insertText({sid:?}, Symbol('o'), 'x')"),
        SYMBOL_TO_STRING,
    );
    throws(
        &mut m,
        &format!("paged.insertText({sid:?}, 0, Symbol('t'))"),
        SYMBOL_TO_STRING,
    );
    writes(
        &mut m,
        &format!("paged.insertText({sid:?}, 5, ' world')"),
        "true",
    );
    assert!(story_text(&mut m, &sid).contains("Hello world"));
    assert_eq!(
        json_of(&ok(&mut m, "paged.stories()"))[0]["characterCount"],
        11
    );
    // SCR-1 (fixed): a missing text is refused, the story untouched.
    refuses(&mut m, &format!("paged.insertText({sid:?}, 0)"), "false");
    refuses(&mut m, &format!("paged.insertText({sid:?}, 0, null)"), "false");
    assert!(!story_text(&mut m, &sid).contains("undefined"));
}

#[test]
fn delete_range() {
    covers!("script:paged.deleteRange");
    let (mut m, _, _, sid) = with_story("Hello world");
    refuses(&mut m, "paged.deleteRange('no-such-story', 0, 5)", "false");
    throws(
        &mut m,
        &format!("paged.deleteRange({sid:?}, Symbol('s'), 5)"),
        SYMBOL_TO_STRING,
    );
    writes(
        &mut m,
        &format!("paged.deleteRange({sid:?}, 5, 11)"),
        "true",
    );
    assert_eq!(
        json_of(&ok(&mut m, "paged.stories()"))[0]["characterCount"],
        5
    );
}

#[test]
fn apply_style() {
    covers!("script:paged.applyStyle");
    let (mut m, _, _, sid) = with_story("Hello world");
    let style = ok(&mut m, "paged.createParagraphStyle({ name: 'Body' })");
    refuses(
        &mut m,
        &format!("paged.applyStyle('no-such-story', 0, 5, {style:?})"),
        "false",
    );
    throws(
        &mut m,
        &format!("paged.applyStyle({sid:?}, Symbol('s'), 5, {style:?})"),
        SYMBOL_TO_STRING,
    );
    writes(
        &mut m,
        &format!("paged.applyStyle({sid:?}, 0, 5, {style:?})"),
        "true",
    );
    let paragraph = |m: &CanvasModel| {
        snapshot(m)["scene"]["stories"][0]["story"]["paragraphs"][0]["paragraph_style"].clone()
    };
    assert_eq!(paragraph(&m), style.as_str());
    // A character style lands on the range's runs.
    let cs = ok(&mut m, "paged.createCharacterStyle({ name: 'Em' })");
    let runs = |m: &CanvasModel| {
        snapshot(m)["scene"]["stories"][0]["story"]["paragraphs"][0]["runs"].clone()
    };
    let before = runs(&m);
    assert_eq!(before.as_array().map(Vec::len), Some(1));
    assert_eq!(
        ok(&mut m, &format!("paged.applyStyle({sid:?}, 0, 5, {cs:?})")),
        "true"
    );
    let styled = runs(&m);
    assert_eq!(styled[0]["character_style"], cs.as_str());
    assert_eq!(ok(&mut m, "paged.undo()"), "true");
    let undone = runs(&m);
    assert!(
        undone
            .as_array()
            .unwrap()
            .iter()
            .all(|r| r["character_style"].is_null()),
        "undo removes the style"
    );
    // finding SCR-10: undo leaves the text split into the runs the edit made; it
    // should restore the one run.
    assert!(undone.as_array().map(Vec::len) > Some(1), "{undone}");
    assert_eq!(ok(&mut m, "paged.redo()"), "true");
    // SCR-9 (fixed): a style the document does not have is refused.
    refuses(
        &mut m,
        &format!("paged.applyStyle({sid:?}, 0, 5, 'ParagraphStyle/NoSuchStyle')"),
        "false",
    );
    refuses(
        &mut m,
        &format!("paged.applyStyle({sid:?}, 0, 5, 'CharacterStyle/NoSuchStyle')"),
        "false",
    );
    assert_ne!(paragraph(&m), "ParagraphStyle/NoSuchStyle");
}

#[test]
fn insert_field() {
    covers!("script:paged.insertField");
    let (mut m, _, _, sid) = with_story("Page ");
    refuses(&mut m, &format!("paged.insertField({sid:?}, 5)"), "false");
    refuses(
        &mut m,
        &format!("paged.insertField({sid:?}, 5, 'notAField')"),
        "false",
    );
    refuses(
        &mut m,
        "paged.insertField('no-such-story', 0, 'pageNumber')",
        "false",
    );
    throws(
        &mut m,
        &format!("paged.insertField({sid:?}, Symbol('o'), 'pageNumber')"),
        SYMBOL_TO_STRING,
    );
    writes(
        &mut m,
        &format!("paged.insertField({sid:?}, 5, 'pageNumber')"),
        "true",
    );
    writes(
        &mut m,
        &format!(
            "paged.insertField({sid:?}, 0, {{ placeholder: {{ plugin: 'merge', key: 'price' }} }})"
        ),
        "true",
    );
}

#[test]
fn set_field_value() {
    covers!("script:paged.setFieldValue");
    let (mut m, _, _, sid) = with_story("x");
    ok(
        &mut m,
        &format!(
            "paged.insertField({sid:?}, 0, {{ placeholder: {{ plugin: 'merge', key: 'price' }} }})"
        ),
    );
    refuses(
        &mut m,
        &format!("paged.setFieldValue({sid:?}, 99, '$1')"),
        "false",
    );
    refuses(
        &mut m,
        "paged.setFieldValue('no-such-story', 0, '$1')",
        "false",
    );
    throws(
        &mut m,
        &format!("paged.setFieldValue({sid:?}, Symbol('o'), '$1')"),
        SYMBOL_TO_STRING,
    );
    writes(
        &mut m,
        &format!("paged.setFieldValue({sid:?}, 0, '$49.00')"),
        "true",
    );
    assert!(snapshot(&m).to_string().contains("$49.00"));
}

/// A story with one hyperlink over "manual"; returns its id too.
fn with_link() -> (CanvasModel, String, String) {
    let (mut m, _, _, sid) = with_story("Read the manual for details");
    ok(
        &mut m,
        &format!("paged.insertHyperlink({sid:?}, 9, 15, 'https://paged.media')"),
    );
    let id = collection_ids(&mut m, "hyperlinks", "selfId").remove(0);
    (m, sid, id)
}

#[test]
fn insert_hyperlink() {
    covers!("script:paged.insertHyperlink");
    let (mut m, _, _, sid) = with_story("Read the manual for details");
    refuses(
        &mut m,
        "paged.insertHyperlink('no-such-story', 9, 15, 'https://paged.media')",
        "false",
    );
    throws(
        &mut m,
        &format!("paged.insertHyperlink({sid:?}, 9, 15, Symbol('u'))"),
        SYMBOL_TO_STRING,
    );
    throws(
        &mut m,
        &format!("paged.insertHyperlink({sid:?}, Symbol('s'), 15, 'https://paged.media')"),
        SYMBOL_TO_STRING,
    );
    let runs = |m: &CanvasModel| {
        snapshot(m)["scene"]["stories"][0]["story"]["paragraphs"][0]["runs"]
            .as_array()
            .map_or(0, Vec::len)
    };
    let before = snapshot(&m);
    assert_eq!(runs(&m), 1);
    assert_eq!(
        ok(
            &mut m,
            &format!("paged.insertHyperlink({sid:?}, 9, 15, 'https://paged.media')")
        ),
        "true"
    );
    let links = json_of(&ok(&mut m, "paged.collection('hyperlinks')"));
    assert_eq!(links.as_array().map(Vec::len), Some(1));
    has_keys(&links[0], &["selfId", "destination"]);
    assert_eq!(runs(&m), 3, "the linked word is its own run");
    assert_eq!(ok(&mut m, "paged.undo()"), "true");
    assert_eq!(
        ok(&mut m, "paged.collection('hyperlinks')"),
        "[]",
        "undo removes the link"
    );
    // finding SCR-10: undo leaves the text split into the three runs the link made
    // (identical attributes, no link); it should restore the one run.
    let undone = snapshot(&m);
    assert_eq!(runs(&m), 3);
    assert!(undone != before, "{:?}", changed_paths(&before, &undone));
}

#[test]
fn delete_hyperlink() {
    covers!("script:paged.deleteHyperlink");
    let (mut m, _, id) = with_link();
    refuses(&mut m, "paged.deleteHyperlink()", "false");
    refuses(&mut m, "paged.deleteHyperlink('no-such-link')", "false");
    throws(
        &mut m,
        "paged.deleteHyperlink(Symbol('h'))",
        SYMBOL_TO_STRING,
    );
    writes(&mut m, &format!("paged.deleteHyperlink({id:?})"), "true");
    assert_eq!(ok(&mut m, "paged.collection('hyperlinks')"), "[]");
}

#[test]
fn edit_hyperlink() {
    covers!("script:paged.editHyperlink");
    let (mut m, _, id) = with_link();
    refuses(
        &mut m,
        "paged.editHyperlink('no-such-link', { url: 'https://example.com' })",
        "false",
    );
    throws(
        &mut m,
        "paged.editHyperlink(Symbol('h'), { url: 'https://example.com' })",
        SYMBOL_TO_STRING,
    );
    throws(
        &mut m,
        &format!("paged.editHyperlink({id:?}, {{ name: Symbol('n') }})"),
        SYMBOL_TO_STRING,
    );
    writes(
        &mut m,
        &format!("paged.editHyperlink({id:?}, {{ name: 'Docs', url: 'https://example.com' }})"),
        "true",
    );
    let links = ok(&mut m, "paged.collection('hyperlinks')");
    assert!(links.contains("Docs"), "{links}");
}

/// A sample's stories, and the one `fn_name` answers `true` for (it must
/// exist: the sample carries the generated story).
fn generated_story(sample_name: &str, fn_name: &str) -> (CanvasModel, String) {
    let mut m = sample(sample_name);
    let ids: Vec<String> = json_of(&ok(&mut m, "paged.stories()"))
        .as_array()
        .expect("stories")
        .iter()
        .map(|s| s["selfId"].as_str().expect("selfId").to_string())
        .collect();
    for id in &ids {
        let mut probe = sample(sample_name);
        if ok(&mut probe, &format!("paged.{fn_name}({id:?})")) == "true" {
            return (m, id.clone());
        }
    }
    panic!("{sample_name}: no story answers {fn_name} (stories {ids:?})");
}

#[test]
fn update_table_of_contents() {
    covers!("script:paged.updateTableOfContents");
    let (mut m, toc) = generated_story("toc", "updateTableOfContents");
    refuses(
        &mut m,
        "paged.updateTableOfContents('no-such-story')",
        "false",
    );
    refuses(&mut m, "paged.updateTableOfContents()", "false");
    throws(
        &mut m,
        "paged.updateTableOfContents(Symbol('s'))",
        SYMBOL_TO_STRING,
    );
    let before = snapshot(&m);
    assert_eq!(
        ok(&mut m, &format!("paged.updateTableOfContents({toc:?})")),
        "true"
    );
    if snapshot(&m) != before {
        assert_eq!(ok(&mut m, "paged.undo()"), "true");
        assert!(snapshot(&m) == before, "undo restores the contents");
    }
}

#[test]
fn generate_index() {
    covers!("script:paged.generateIndex");
    let (mut m, story) = generated_story("index", "generateIndex");
    refuses(&mut m, "paged.generateIndex('no-such-story')", "false");
    throws(&mut m, "paged.generateIndex(Symbol('s'))", SYMBOL_TO_STRING);
    let before = snapshot(&m);
    assert_eq!(
        ok(&mut m, &format!("paged.generateIndex({story:?})")),
        "true"
    );
    if snapshot(&m) != before {
        assert_eq!(ok(&mut m, "paged.undo()"), "true");
        assert!(snapshot(&m) == before, "undo restores the index story");
    }
}

#[test]
fn update_cross_references() {
    covers!("script:paged.updateCrossReferences");
    let mut m = sample("xref");
    refuses(
        &mut m,
        "paged.updateCrossReferences('no-such-source')",
        "false",
    );
    // No source: every cross-reference re-reads its target.
    writes(&mut m, "paged.updateCrossReferences()", "true");
    let sid = json_of(&ok(&mut m, "paged.stories()"))[0]["selfId"]
        .as_str()
        .unwrap()
        .to_string();
    let text = story_text(&mut m, &sid);
    assert!(
        text.contains("Where Things Are") && !text.contains("Old Heading"),
        "{text}"
    );
    // One source: already current, nothing to change.
    no_op(&mut m, "paged.updateCrossReferences('uxs1')", "true");
}

#[test]
fn insert_footnote() {
    covers!("script:paged.insertFootnote");
    let (mut m, _, _, sid) = with_story("A claim that needs a source.");
    refuses(
        &mut m,
        "paged.insertFootnote('no-such-story', 7, 'Source.')",
        "null",
    );
    throws(
        &mut m,
        &format!("paged.insertFootnote({sid:?}, Symbol('o'), 'Source.')"),
        SYMBOL_TO_STRING,
    );
    let id = mints(
        &mut m,
        &format!("paged.insertFootnote({sid:?}, 7, 'Source.')"),
        |s| !s.is_empty() && s != "null",
    );
    assert_eq!(collection_ids(&mut m, "footnotes", "selfId"), vec![id]);
}

#[test]
fn delete_footnote() {
    covers!("script:paged.deleteFootnote");
    let (mut m, _, _, sid) = with_story("A claim that needs a source.");
    let id = ok(
        &mut m,
        &format!("paged.insertFootnote({sid:?}, 7, 'Source.')"),
    );
    refuses(&mut m, &format!("paged.deleteFootnote({sid:?})"), "false");
    refuses(
        &mut m,
        &format!("paged.deleteFootnote({sid:?}, 'no-such-note')"),
        "false",
    );
    throws(
        &mut m,
        &format!("paged.deleteFootnote({sid:?}, Symbol('f'))"),
        SYMBOL_TO_STRING,
    );
    writes(
        &mut m,
        &format!("paged.deleteFootnote({sid:?}, {id:?})"),
        "true",
    );
    assert_eq!(ok(&mut m, "paged.collection('footnotes')"), "[]");
}

#[test]
fn convert_footnote_to_endnote() {
    covers!("script:paged.convertFootnoteToEndnote");
    let (mut m, _, _, sid) = with_story("A claim that needs a source.");
    let id = ok(
        &mut m,
        &format!("paged.insertFootnote({sid:?}, 7, 'Source.')"),
    );
    refuses(
        &mut m,
        &format!("paged.convertFootnoteToEndnote({sid:?}, 'no-such-note')"),
        "null",
    );
    throws(
        &mut m,
        &format!("paged.convertFootnoteToEndnote({sid:?}, Symbol('f'))"),
        SYMBOL_TO_STRING,
    );
    let endnote = mints(
        &mut m,
        &format!("paged.convertFootnoteToEndnote({sid:?}, {id:?})"),
        |s| !s.is_empty() && s != "null",
    );
    assert_eq!(ok(&mut m, "paged.collection('footnotes')"), "[]");
    assert!(ok(&mut m, "paged.collection('endnotes')").contains(endnote.as_str()));
}

#[test]
fn insert_endnote() {
    covers!("script:paged.insertEndnote");
    let (mut m, _, _, sid) = with_story("A claim that needs a source.");
    refuses(
        &mut m,
        "paged.insertEndnote('no-such-story', 7, 'Source.')",
        "null",
    );
    throws(
        &mut m,
        &format!("paged.insertEndnote({sid:?}, Symbol('o'), 'Source.')"),
        SYMBOL_TO_STRING,
    );
    let id = mints(
        &mut m,
        &format!("paged.insertEndnote({sid:?}, 7, 'Source.')"),
        |s| !s.is_empty() && s != "null",
    );
    assert!(ok(&mut m, "paged.collection('endnotes')").contains(id.as_str()));
}

#[test]
fn delete_endnote() {
    covers!("script:paged.deleteEndnote");
    let (mut m, _, _, sid) = with_story("A claim that needs a source.");
    let id = ok(
        &mut m,
        &format!("paged.insertEndnote({sid:?}, 7, 'Source.')"),
    );
    refuses(&mut m, "paged.deleteEndnote()", "false");
    refuses(&mut m, "paged.deleteEndnote('no-such-note')", "false");
    throws(&mut m, "paged.deleteEndnote(Symbol('e'))", SYMBOL_TO_STRING);
    writes(&mut m, &format!("paged.deleteEndnote({id:?})"), "true");
    assert!(!ok(&mut m, "paged.collection('endnotes')").contains(id.as_str()));
}

fn with_note() -> (CanvasModel, String, String) {
    let (mut m, _, _, sid) = with_story("Check this sentence.");
    let id = ok(
        &mut m,
        &format!("paged.insertNote({sid:?}, 5, 'Is this right?', 'Editor')"),
    );
    (m, sid, id)
}

#[test]
fn insert_note() {
    covers!("script:paged.insertNote");
    let (mut m, _, _, sid) = with_story("Check this sentence.");
    refuses(
        &mut m,
        "paged.insertNote('no-such-story', 5, 'Hm?')",
        "null",
    );
    throws(
        &mut m,
        &format!("paged.insertNote({sid:?}, Symbol('o'), 'Hm?')"),
        SYMBOL_TO_STRING,
    );
    let id = mints(
        &mut m,
        &format!("paged.insertNote({sid:?}, 5, 'Is this right?', 'Editor')"),
        |s| !s.is_empty() && s != "null",
    );
    let notes = ok(&mut m, "paged.collection('notes')");
    assert!(
        notes.contains(id.as_str()) && notes.contains("Is this right?"),
        "{notes}"
    );
}

#[test]
fn edit_note() {
    covers!("script:paged.editNote");
    let (mut m, _, id) = with_note();
    refuses(&mut m, "paged.editNote('no-such-note', 'x')", "false");
    throws(&mut m, "paged.editNote(Symbol('n'), 'x')", SYMBOL_TO_STRING);
    writes(
        &mut m,
        &format!("paged.editNote({id:?}, 'Confirmed.')"),
        "true",
    );
    assert!(ok(&mut m, "paged.collection('notes')").contains("Confirmed."));
}

#[test]
fn delete_note() {
    covers!("script:paged.deleteNote");
    let (mut m, _, id) = with_note();
    refuses(&mut m, "paged.deleteNote()", "false");
    refuses(&mut m, "paged.deleteNote('no-such-note')", "false");
    throws(&mut m, "paged.deleteNote(Symbol('n'))", SYMBOL_TO_STRING);
    writes(&mut m, &format!("paged.deleteNote({id:?})"), "true");
    assert_eq!(ok(&mut m, "paged.collection('notes')"), "[]");
}

#[test]
fn convert_note_to_text() {
    covers!("script:paged.convertNoteToText");
    let (mut m, sid, id) = with_note();
    refuses(&mut m, "paged.convertNoteToText('no-such-note')", "false");
    throws(
        &mut m,
        "paged.convertNoteToText(Symbol('n'))",
        SYMBOL_TO_STRING,
    );
    writes(&mut m, &format!("paged.convertNoteToText({id:?})"), "true");
    assert_eq!(ok(&mut m, "paged.collection('notes')"), "[]");
    assert!(story_text(&mut m, &sid).contains("Is this right?"));
}

/// The `notes` sample reduced to one paragraph with one tracked deletion
/// ("gamma ") at offset 20, as the engine's own tracked-change tests build it.
fn tracked() -> (CanvasModel, String) {
    let mut m = sample("notes");
    let story = m.scene().stories[0].self_id.clone();
    let s = &mut m.scene_mut().stories[0].story;
    s.paragraphs.truncate(1);
    let p = &mut s.paragraphs[0];
    p.runs.truncate(1);
    p.runs[0].text = format!(
        "Alpha beta INSERTED {}delta.",
        paged_model::TRACKED_DELETION_MARKER
    );
    p.notes.clear();
    p.footnotes.clear();
    p.tracked_deletions = vec![paged_model::TrackedChange {
        change_type: "DeletedText".into(),
        user_name: Some("Reviewer".into()),
        deleted_text: Some("gamma ".into()),
        ..Default::default()
    }];
    (m, story)
}

#[test]
fn accept_tracked_change() {
    covers!("script:paged.acceptTrackedChange");
    let (mut m, story) = tracked();
    refuses(
        &mut m,
        &format!("paged.acceptTrackedChange({story:?}, 3)"),
        "false",
    );
    refuses(
        &mut m,
        "paged.acceptTrackedChange('no-such-story', 20)",
        "false",
    );
    throws(
        &mut m,
        &format!("paged.acceptTrackedChange({story:?}, Symbol('o'))"),
        SYMBOL_TO_STRING,
    );
    writes(
        &mut m,
        &format!("paged.acceptTrackedChange({story:?}, 20)"),
        "true",
    );
    assert_eq!(ok(&mut m, "paged.collection('trackedChanges')"), "[]");
    assert!(!story_text(&mut m, &story).contains("gamma"));
}

#[test]
fn reject_tracked_change() {
    covers!("script:paged.rejectTrackedChange");
    let (mut m, story) = tracked();
    refuses(
        &mut m,
        &format!("paged.rejectTrackedChange({story:?}, 3)"),
        "false",
    );
    refuses(
        &mut m,
        "paged.rejectTrackedChange('no-such-story', 20)",
        "false",
    );
    throws(
        &mut m,
        &format!("paged.rejectTrackedChange({story:?}, Symbol('o'))"),
        SYMBOL_TO_STRING,
    );
    writes(
        &mut m,
        &format!("paged.rejectTrackedChange({story:?}, 20)"),
        "true",
    );
    assert!(story_text(&mut m, &story).contains("INSERTED gamma delta."));
}

#[test]
fn set_flow_grow_rule() {
    covers!("script:paged.setFlowGrowRule");
    let (mut m, _, _, sid) = with_story("Long text");
    refuses(
        &mut m,
        "paged.setFlowGrowRule('no-such-story', true)",
        "false",
    );
    throws(
        &mut m,
        "paged.setFlowGrowRule(Symbol('s'), true)",
        SYMBOL_TO_STRING,
    );
    throws(
        &mut m,
        &format!("paged.setFlowGrowRule({sid:?}, true, Symbol('n'))"),
        SYMBOL_TO_STRING,
    );
    writes(
        &mut m,
        &format!("paged.setFlowGrowRule({sid:?}, true, 3, false)"),
        "true",
    );
}
