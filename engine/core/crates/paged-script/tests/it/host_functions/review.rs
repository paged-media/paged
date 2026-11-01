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

//! Engine ADRs 1040 and 1020 — tracked changes and comments from a script.

use super::*;

fn with_insertion() -> (CanvasModel, String) {
    let (mut m, _, _, story) = with_story("One two three");
    ok(
        &mut m,
        &format!(
            "paged.recordChange({story:?}, 4, 7, {{kind: 'insert', id: '5', author: 'Author A'}})"
        ),
    );
    (m, story)
}

fn with_comment() -> (CanvasModel, String) {
    let (mut m, _, _, story) = with_story("One two three");
    ok(
        &mut m,
        &format!(
            "paged.insertComment({story:?}, 4, 7, {{id: '1', text: 'Why?', author: 'Author A'}})"
        ),
    );
    (m, story)
}

#[test]
fn record_change() {
    covers!("script:paged.recordChange");
    let (mut m, _, _, story) = with_story("One two three");
    refuses(
        &mut m,
        &format!("paged.recordChange({story:?}, 0, 3, {{}})"),
        "false",
    );
    writes(
        &mut m,
        &format!("paged.recordChange({story:?}, 0, 3, {{kind: 'delete', author: 'Author A'}})"),
        "true",
    );
    throws(
        &mut m,
        "paged.recordChange(Symbol('s'), 0, 1, {kind: 'insert'})",
        SYMBOL_TO_STRING,
    );
}

#[test]
fn accept_change() {
    covers!("script:paged.acceptChange");
    let (mut m, _) = with_insertion();
    refuses(&mut m, "paged.acceptChange({id: 'nope'})", "false");
    writes(&mut m, "paged.acceptChange({id: '5'})", "true");
}

#[test]
fn reject_change() {
    covers!("script:paged.rejectChange");
    let (mut m, _) = with_insertion();
    refuses(&mut m, "paged.rejectChange({id: 'nope'})", "false");
    writes(&mut m, "paged.rejectChange({author: 'Author A'})", "true");
}

#[test]
fn insert_comment() {
    covers!("script:paged.insertComment");
    let (mut m, _, _, story) = with_story("One two three");
    refuses(
        &mut m,
        &format!("paged.insertComment({story:?}, 3, 3, {{text: 'Empty'}})"),
        "false",
    );
    writes(
        &mut m,
        &format!("paged.insertComment({story:?}, 0, 3, {{text: 'Check', author: 'Author A'}})"),
        "true",
    );
    throws(
        &mut m,
        "paged.insertComment(Symbol('s'), 0, 1, {text: 'x'})",
        SYMBOL_TO_STRING,
    );
}

#[test]
fn reply_comment() {
    covers!("script:paged.replyComment");
    let (mut m, _) = with_comment();
    refuses(&mut m, "paged.replyComment('nope', {text: 'Hi'})", "false");
    writes(
        &mut m,
        "paged.replyComment('1', {text: 'Because.', author: 'Author B'})",
        "true",
    );
}

#[test]
fn resolve_comment() {
    covers!("script:paged.resolveComment");
    let (mut m, _) = with_comment();
    refuses(&mut m, "paged.resolveComment('nope')", "false");
    writes(&mut m, "paged.resolveComment('1')", "true");
}

#[test]
fn delete_comment() {
    covers!("script:paged.deleteComment");
    let (mut m, _) = with_comment();
    refuses(&mut m, "paged.deleteComment('nope')", "false");
    writes(&mut m, "paged.deleteComment('1')", "true");
}

#[test]
fn edit_comment() {
    covers!("script:paged.editComment");
    let (mut m, _) = with_comment();
    refuses(&mut m, "paged.editComment('nope', 'x')", "false");
    writes(&mut m, "paged.editComment('1', 'Why not?')", "true");
}

#[test]
fn insert_comment_thread() {
    covers!("script:paged.insertCommentThread");
    let (mut m, _page, frame, _story) = with_story("One two three");
    // An anchor that is not an anchor, and a comment that is not one.
    refuses(
        &mut m,
        "paged.insertCommentThread('nope', {text: 'x'})",
        "false",
    );
    refuses(
        &mut m,
        &format!("paged.insertCommentThread({{kind: 'item', item: {frame:?}}}, 'nope')"),
        "false",
    );
    writes(
        &mut m,
        &format!(
            "paged.insertCommentThread({{kind: 'item', item: {frame:?}}}, \
             {{text: 'Check this', author: 'Author A'}})"
        ),
        "true",
    );
}

#[test]
fn set_comment_anchor() {
    covers!("script:paged.setCommentAnchor");
    let (mut m, page, frame, _story) = with_story("One two three");
    ok(
        &mut m,
        &format!(
            "paged.insertCommentThread({{kind: 'item', item: {frame:?}}}, \
             {{id: 't1', text: 'Check this', author: 'Author A'}})"
        ),
    );
    refuses(&mut m, "paged.setCommentAnchor('t1', 'nope')", "false");
    writes(
        &mut m,
        &format!("paged.setCommentAnchor('t1', {{kind: 'page', page: {page:?}, at: [10, 20]}})"),
        "true",
    );
}

#[test]
fn set_person() {
    covers!("script:paged.setPerson");
    let (mut m, _, _, _) = with_story("One two three");
    refuses(&mut m, "paged.setPerson('nope')", "false");
    writes(
        &mut m,
        "paged.setPerson({id: 'p1', name: 'Ann Author', initials: 'AA'})",
        "true",
    );
}

#[test]
fn set_theme() {
    covers!("script:paged.setTheme");
    let (mut m, _, _, _) = with_story("One two three");
    refuses(&mut m, "paged.setTheme('nope')", "false");
    refuses(
        &mut m,
        "paged.setTheme({name: 'T', colors: [{slot: 'accent9', value: 'FF0000'}]})",
        "false",
    );
    writes(
        &mut m,
        "paged.setTheme({name: 'Mine', colors: [{slot: 'accent1', value: 'ff0000'}], \
         major: {latin: 'Georgia'}})",
        "true",
    );
}

#[test]
fn set_theme_color() {
    covers!("script:paged.setThemeColor");
    let (mut m, _, _, _) = with_story("One two three");
    // No theme yet: refused.
    refuses(&mut m, "paged.setThemeColor('accent1', 'FF0000')", "false");
    ok(&mut m, "paged.setTheme({name: 'Mine', colors: []})");
    refuses(&mut m, "paged.setThemeColor('accent9', 'FF0000')", "false");
    refuses(&mut m, "paged.setThemeColor('accent1', 'red')", "false");
    writes(&mut m, "paged.setThemeColor('accent1', '#00ff00')", "true");
}

#[test]
fn set_theme_fonts() {
    covers!("script:paged.setThemeFonts");
    let (mut m, _, _, _) = with_story("One two three");
    refuses(
        &mut m,
        "paged.setThemeFonts('major', {latin: 'Georgia'})",
        "false",
    );
    ok(&mut m, "paged.setTheme({name: 'Mine', colors: []})");
    refuses(
        &mut m,
        "paged.setThemeFonts('heading', {latin: 'Georgia'})",
        "false",
    );
    writes(
        &mut m,
        "paged.setThemeFonts('minor', {latin: 'Verdana', scripts: [{script: 'Jpan', typeface: 'Yu Gothic'}]})",
        "true",
    );
}
