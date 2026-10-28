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

//! Engine ADR 1022 — Word's fields, bookmarks, cross-references, tables of
//! contents and index markers.

use super::text::story_text;
use super::*;

#[test]
fn update_fields() {
    covers!("script:paged.updateFields");
    let (mut m, _, _, story) = with_story("One");
    ok(
        &mut m,
        &format!(r#"paged.insertField({story:?}, 0, {{word: {{code: 'DATE \\@ "yyyy-MM-dd"'}}}})"#),
    );
    refuses(&mut m, "paged.updateFields()", "false");
    refuses(&mut m, "paged.updateFields({now: 'not a date'})", "false");
    writes(
        &mut m,
        "paged.updateFields({now: '2026-10-25T09:30:00'})",
        "true",
    );
    ok(&mut m, "paged.updateFields({now: '2026-10-25T09:30:00'})");
    assert!(story_text(&mut m, &story).contains("2026-10-25"));
}

#[test]
fn insert_text_anchor() {
    covers!("script:paged.insertTextAnchor");
    let (mut m, _, _, story) = with_story("One two");
    refuses(&mut m, "paged.insertTextAnchor('nope', 0, 'A')", "null");
    let before = snapshot(&m);
    let id = ok(
        &mut m,
        &format!("paged.insertTextAnchor({story:?}, 4, 'Two')"),
    );
    assert!(id.starts_with("HyperlinkTextDestination/"), "{id}");
    assert_ne!(snapshot(&m), before);
    refuses(
        &mut m,
        &format!("paged.insertTextAnchor({story:?}, 0, 'Two')"),
        "null",
    );
    throws(
        &mut m,
        "paged.insertTextAnchor(Symbol('s'), 0, 'A')",
        SYMBOL_TO_STRING,
    );
}

#[test]
fn delete_text_anchor() {
    covers!("script:paged.deleteTextAnchor");
    let (mut m, _, _, story) = with_story("One two");
    let id = ok(
        &mut m,
        &format!("paged.insertTextAnchor({story:?}, 4, 'Two')"),
    );
    refuses(&mut m, "paged.deleteTextAnchor('nope')", "false");
    writes(&mut m, &format!("paged.deleteTextAnchor({id:?})"), "true");
    throws(
        &mut m,
        "paged.deleteTextAnchor(Symbol('s'))",
        SYMBOL_TO_STRING,
    );
}

#[test]
fn insert_cross_reference() {
    covers!("script:paged.insertCrossReference");
    let (mut m, _, _, story) = with_story("See \nTarget heading");
    refuses(
        &mut m,
        &format!("paged.insertCrossReference({story:?}, 4, {{bookmark: 'nope'}})"),
        "false",
    );
    refuses(
        &mut m,
        &format!("paged.insertCrossReference({story:?}, 4, 7)"),
        "false",
    );
    writes(
        &mut m,
        &format!(
            "paged.insertCrossReference({story:?}, 4, {{storyId: {story:?}, paragraph: 1}}, {{referTo: 'text'}})"
        ),
        "true",
    );
    ok(
        &mut m,
        &format!("paged.insertCrossReference({story:?}, 4, {{storyId: {story:?}, paragraph: 1}})"),
    );
    let text = story_text(&mut m, &story);
    assert!(text.contains("See Target heading"), "{text}");
    throws(
        &mut m,
        "paged.insertCrossReference(Symbol('s'), 0, {bookmark: 'a'})",
        SYMBOL_TO_STRING,
    );
}

#[test]
fn insert_table_of_contents() {
    covers!("script:paged.insertTableOfContents");
    let (mut m, _, _, story) = with_story("Intro\nBody");
    // The first paragraph is the heading, in a style of the document's.
    let style = m
        .scene()
        .styles
        .paragraph_styles
        .keys()
        .next()
        .expect("a paragraph style")
        .clone();
    m.scene_mut()
        .stories
        .iter_mut()
        .find(|s| s.self_id == story)
        .expect("story")
        .story
        .paragraphs[0]
        .paragraph_style = Some(style.clone());
    refuses(
        &mut m,
        &format!("paged.insertTableOfContents({story:?}, 0, [])"),
        "false",
    );
    refuses(
        &mut m,
        &format!("paged.insertTableOfContents({story:?}, 0, [{{style: 'ParagraphStyle/none', level: 1}}])"),
        "false",
    );
    writes(
        &mut m,
        &format!(
            "paged.insertTableOfContents({story:?}, 0, [{{style: {style:?}, level: 1}}], {{title: 'Contents'}})"
        ),
        "true",
    );
    throws(
        &mut m,
        "paged.insertTableOfContents(Symbol('s'), 0, [])",
        SYMBOL_TO_STRING,
    );
}

#[test]
fn insert_index_marker() {
    covers!("script:paged.insertIndexMarker");
    let (mut m, _, _, story) = with_story("Apples and pears");
    refuses(
        &mut m,
        &format!("paged.insertIndexMarker({story:?}, 0, [])"),
        "false",
    );
    writes(
        &mut m,
        &format!("paged.insertIndexMarker({story:?}, 0, 'Apples')"),
        "true",
    );
    writes(
        &mut m,
        &format!(
            "paged.insertIndexMarker({story:?}, 0, ['Fruit', 'Pears'], {{sortOrder: 'pears'}})"
        ),
        "true",
    );
    throws(
        &mut m,
        "paged.insertIndexMarker(Symbol('s'), 0, 'A')",
        SYMBOL_TO_STRING,
    );
}
