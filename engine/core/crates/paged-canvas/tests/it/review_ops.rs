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

//! Engine ADRs 1040 and 1020 over the wire: typing, deleting and
//! formatting while Track Changes is on record changes; accepting and
//! rejecting resolve them, each other's opposite (a proptest); comments
//! with threads are inserted, replied to, resolved and deleted; every step
//! undoes to the exact model before it.
// Test names carry their feature row (`…__feat__…`).
#![allow(non_snake_case)]

use paged_canvas::{CanvasModel, CanvasOptions, Mutation};
use paged_mutate::{ChangeSpec, ChangeSpecKind, CommentSpec, Value};
use paged_wire::Address;
use proptest::prelude::*;

const AUTHOR: &str = "Author A";

fn model_with(paragraphs: &[&str]) -> (CanvasModel, String) {
    let idml = paged_gen::write_idml(&paged_gen::samples::notes::build()).expect("idml");
    let mut m = CanvasModel::load("doc", &idml, CanvasOptions::default()).expect("load");
    let story = m.scene().stories[0].self_id.clone();
    {
        let s = &mut m.scene_mut().stories[0].story;
        let template = s.paragraphs[0].clone();
        s.paragraphs = paragraphs
            .iter()
            .map(|t| {
                let mut p = paged_model::Paragraph {
                    paragraph_style: template.paragraph_style.clone(),
                    ..Default::default()
                };
                p.runs = vec![paged_model::CharacterRun {
                    character_style: template.runs[0].character_style.clone(),
                    text: (*t).to_string(),
                    ..Default::default()
                }];
                p
            })
            .collect();
    }
    (m, story)
}

fn set(m: &mut CanvasModel, path: &str, value: Value) {
    m.apply_mutation(&Mutation::Set {
        address: Address::parse("doc").expect("address"),
        path: path.into(),
        value,
    })
    .expect(path);
}

fn track(m: &mut CanvasModel, author: &str) {
    set(m, "documentTrackChangesAuthor", Value::Text(author.into()));
    set(m, "documentTrackChanges", Value::Bool(true));
    m.set_review_clock(Some("2026-10-29T09:00:00Z".into()));
}

/// Every character of the story (deleted ones too), paragraphs joined by
/// `\n`.
fn raw(m: &CanvasModel, story: &str) -> String {
    paragraphs(m, story)
        .iter()
        .map(|p| p.runs.iter().map(|r| r.text.as_str()).collect::<String>())
        .collect::<Vec<_>>()
        .join("\n")
}

fn paragraphs(m: &CanvasModel, story: &str) -> Vec<paged_model::Paragraph> {
    m.scene()
        .stories
        .iter()
        .find(|s| s.self_id == story)
        .unwrap()
        .story
        .paragraphs
        .clone()
}

/// The text with the characters of `kind` left out.
fn without(m: &CanvasModel, story: &str, kind: paged_model::ChangeKind) -> String {
    paragraphs(m, story)
        .iter()
        .map(|p| {
            p.runs
                .iter()
                .filter(|r| r.revision.as_ref().map(|c| c.kind) != Some(kind))
                .map(|r| r.text.as_str())
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn insert(m: &mut CanvasModel, story: &str, offset: u32, text: &str) {
    m.apply_mutation(&Mutation::InsertText {
        story_id: story.into(),
        offset,
        text: text.into(),
        cell: None,
    })
    .expect("insert");
}

fn delete(m: &mut CanvasModel, story: &str, start: u32, end: u32) {
    m.apply_mutation(&Mutation::DeleteRange {
        story_id: story.into(),
        start,
        end,
        cell: None,
    })
    .expect("delete");
}

fn accept_all(m: &mut CanvasModel) {
    m.apply_mutation(&Mutation::AcceptChange {
        story_id: None,
        id: None,
        author: None,
    })
    .expect("accept all");
}

fn reject_all(m: &mut CanvasModel) {
    m.apply_mutation(&Mutation::RejectChange {
        story_id: None,
        id: None,
        author: None,
    })
    .expect("reject all");
}

#[test]
fn typing_while_tracking_records_one_insertion__feat__doc_word_track_changes() {
    let (mut m, story) = model_with(&["Alpha beta."]);
    let before = m.scene().canonical_hash();
    track(&mut m, AUTHOR);
    insert(&mut m, &story, 6, "n");
    insert(&mut m, &story, 7, "e");
    insert(&mut m, &story, 8, "w ");
    assert_eq!(raw(&m, &story), "Alpha new beta.");
    let rows = m.tracked_changes();
    assert_eq!(rows.len(), 1, "typed letters join one change: {rows:?}");
    assert_eq!(rows[0].kind.as_deref(), Some("insert"));
    assert_eq!((rows[0].offset, rows[0].end), (6, Some(10)));
    assert_eq!(rows[0].text, "new ");
    assert_eq!(rows[0].user_name.as_deref(), Some(AUTHOR));
    assert_eq!(rows[0].date.as_deref(), Some("2026-10-29T09:00:00Z"));
    // Each edit undoes exactly: back to the document before tracking.
    for _ in 0..5 {
        m.undo().expect("undo");
    }
    assert_eq!(m.scene().canonical_hash(), before);
}

#[test]
fn deleting_keeps_the_text_and_your_own_insertion_goes__feat__doc_word_track_changes() {
    let (mut m, story) = model_with(&["Alpha beta gamma."]);
    track(&mut m, AUTHOR);
    delete(&mut m, &story, 6, 11); // "beta "
    assert_eq!(raw(&m, &story), "Alpha beta gamma.");
    assert_eq!(
        without(&m, &story, paged_model::ChangeKind::Delete),
        "Alpha gamma."
    );
    insert(&mut m, &story, 17, " delta");
    // Deleting your own insertion removes it outright.
    delete(&mut m, &story, 17, 20);
    assert_eq!(raw(&m, &story), "Alpha beta gamma.lta");
    let kinds: Vec<_> = m
        .tracked_changes()
        .into_iter()
        .filter_map(|r| r.kind)
        .collect();
    assert_eq!(kinds, ["delete", "insert"]);
}

#[test]
fn accept_and_reject_resolve_what_was_recorded__feat__doc_word_track_changes() {
    let (mut m, story) = model_with(&["Alpha beta gamma."]);
    let original = raw(&m, &story);
    track(&mut m, AUTHOR);
    delete(&mut m, &story, 6, 11);
    insert(&mut m, &story, 0, "New ");
    let tracked = m.scene().canonical_hash();
    reject_all(&mut m);
    assert_eq!(raw(&m, &story), original);
    assert!(m.tracked_changes().is_empty());
    m.undo().expect("undo reject");
    assert_eq!(m.scene().canonical_hash(), tracked);
    accept_all(&mut m);
    assert_eq!(raw(&m, &story), "New Alpha gamma.");
    m.undo().expect("undo accept");
    assert_eq!(m.scene().canonical_hash(), tracked);
    // One change by id.
    let insertion = m
        .tracked_changes()
        .into_iter()
        .find(|r| r.kind.as_deref() == Some("insert"))
        .and_then(|r| r.id)
        .unwrap();
    m.apply_mutation(&Mutation::RejectChange {
        story_id: None,
        id: Some(insertion),
        author: None,
    })
    .unwrap();
    assert_eq!(raw(&m, &story), "Alpha beta gamma.");
    assert_eq!(m.tracked_changes().len(), 1);
}

#[test]
fn by_author_resolves_only_that_authors_changes__feat__doc_word_track_changes() {
    let (mut m, story) = model_with(&["One two."]);
    track(&mut m, "Author A");
    insert(&mut m, &story, 0, "A ");
    track(&mut m, "Author B");
    insert(&mut m, &story, 10, " B");
    m.apply_mutation(&Mutation::RejectChange {
        story_id: None,
        id: None,
        author: Some("Author B".into()),
    })
    .unwrap();
    assert_eq!(raw(&m, &story), "A One two.");
    assert_eq!(m.tracked_changes().len(), 1);
}

#[test]
fn a_tracked_return_inserts_a_mark_and_rejecting_joins__feat__doc_word_track_changes() {
    let (mut m, story) = model_with(&["Alpha beta.", "Gamma."]);
    let original = m.scene().canonical_hash();
    let text = raw(&m, &story);
    track(&mut m, AUTHOR);
    let after_track = m.scene().canonical_hash();
    insert(&mut m, &story, 5, "\n");
    assert_eq!(raw(&m, &story), "Alpha\n beta.\nGamma.");
    let rows = m.tracked_changes();
    assert_eq!(rows[0].kind.as_deref(), Some("insertMark"));
    // Deleting the break between paragraph 2 and 3 marks it deleted.
    delete(&mut m, &story, 12, 13);
    assert_eq!(raw(&m, &story), "Alpha\n beta.\nGamma.");
    let tracked = m.scene().canonical_hash();
    reject_all(&mut m);
    assert_eq!(raw(&m, &story), text);
    m.undo().unwrap();
    assert_eq!(m.scene().canonical_hash(), tracked);
    accept_all(&mut m);
    assert_eq!(raw(&m, &story), "Alpha\n beta.Gamma.");
    m.undo().unwrap();
    m.undo().unwrap();
    m.undo().unwrap();
    assert_eq!(m.scene().canonical_hash(), after_track);
    let _ = original;
}

#[test]
fn formatting_while_tracking_records_the_formatting_before__feat__doc_word_track_changes() {
    let (mut m, story) = model_with(&["Alpha beta."]);
    track(&mut m, AUTHOR);
    let before = m.scene().canonical_hash();
    m.apply_mutation(&Mutation::Set {
        address: Address::parse(&format!("storyRange:{story}@0..5")).unwrap(),
        path: "characterFontSize".into(),
        value: Value::Length(Some(30.0)),
    })
    .expect("size");
    let rows = m.tracked_changes();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].kind.as_deref(), Some("format"));
    assert_eq!(rows[0].text, "Alpha");
    let content = m.story_content(&story).unwrap();
    let fc = content.paragraphs[0].runs[0]
        .format_change
        .as_ref()
        .unwrap();
    assert_eq!(fc.before.point_size, None);
    // Undo is one step and exact.
    m.undo().unwrap();
    assert_eq!(m.scene().canonical_hash(), before);
    m.redo().unwrap();
    reject_all(&mut m);
    assert_eq!(paragraphs(&m, &story)[0].runs[0].point_size, None);
    assert!(m.tracked_changes().is_empty());
}

#[test]
fn an_importer_records_changes_with_their_ids__feat__doc_word_track_changes() {
    let (mut m, story) = model_with(&["Alpha beta.", "Gamma."]);
    let spec = |kind, id: &str| ChangeSpec {
        kind,
        id: Some(id.into()),
        author: Some("Author B".into()),
        date: Some("2026-01-02T03:04:05Z".into()),
        before_character_style: None,
        before_paragraph_style: Some("ParagraphStyle/Before".into()),
    };
    m.apply_mutation(&Mutation::Batch {
        ops: vec![
            Mutation::RecordChange {
                story_id: story.clone(),
                start: 0,
                end: 5,
                cell: None,
                paragraph: None,
                change: spec(ChangeSpecKind::Insert, "7"),
            },
            Mutation::RecordChange {
                story_id: story.clone(),
                start: 6,
                end: 10,
                cell: None,
                paragraph: None,
                change: spec(ChangeSpecKind::Delete, "8"),
            },
            Mutation::RecordChange {
                story_id: story.clone(),
                start: 0,
                end: 0,
                cell: None,
                paragraph: Some(1),
                change: spec(ChangeSpecKind::ParaProps, "9"),
            },
        ],
    })
    .expect("record");
    let rows = m.tracked_changes();
    let ids: Vec<_> = rows.iter().filter_map(|r| r.id.clone()).collect();
    assert_eq!(ids, ["7", "8", "9"]);
    let content = m.story_content(&story).unwrap();
    assert_eq!(
        content.paragraphs[0].runs[0].change.as_ref().unwrap().id,
        "7"
    );
    assert_eq!(
        content.paragraphs[1]
            .props_change
            .as_ref()
            .unwrap()
            .before_paragraph_style
            .as_deref(),
        Some("ParagraphStyle/Before")
    );
    // The markup view is a document setting.
    set(&mut m, "documentMarkupView", Value::Text("original".into()));
    assert_eq!(
        m.scene().designmap.document_preference.markup_view,
        Some(paged_model::MarkupView::Original)
    );
}

#[test]
fn comments_thread_resolve_and_go__feat__doc_word_comments() {
    let (mut m, story) = model_with(&["Alpha beta gamma."]);
    let before = m.scene().canonical_hash();
    let spec = |id: &str, text: &str| CommentSpec {
        id: Some(id.into()),
        author: Some(AUTHOR.into()),
        initials: Some("AA".into()),
        date: Some("2026-10-29T10:00:00Z".into()),
        text: text.into(),
        ..Default::default()
    };
    m.apply_mutation(&Mutation::InsertComment {
        story_id: story.clone(),
        start: 6,
        end: 10,
        cell: None,
        comment: spec("1", "Why beta?"),
    })
    .unwrap();
    m.apply_mutation(&Mutation::ReplyComment {
        parent_id: "1".into(),
        comment: spec("2", "Because."),
    })
    .unwrap();
    let rows = m.comments();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].anchor_text, "beta");
    assert_eq!((rows[0].start, rows[0].end), (Some(6), Some(10)));
    assert_eq!(rows[1].parent_id.as_deref(), Some("1"));
    assert_eq!(rows[1].anchor_text, "beta");
    // Typing inside the range widens it, as in Word.
    insert(&mut m, &story, 8, "X");
    assert_eq!(m.comments()[0].anchor_text, "beXta");
    m.apply_mutation(&Mutation::ResolveComment {
        comment_id: "2".into(),
        resolved: true,
    })
    .unwrap();
    assert!(m.comments().iter().all(|c| c.resolved));
    let content = m.story_content(&story).unwrap();
    assert_eq!(content.comments.len(), 2);
    m.apply_mutation(&Mutation::DeleteComment {
        comment_id: "1".into(),
    })
    .unwrap();
    assert!(m.comments().is_empty());
    assert!(paragraphs(&m, &story)[0]
        .runs
        .iter()
        .all(|r| r.comments.is_empty()));
    for _ in 0..5 {
        m.undo().unwrap();
    }
    assert_eq!(m.scene().canonical_hash(), before);
}

/// One edit of the proptest, in the tracked document's own coordinates.
#[derive(Debug, Clone)]
enum Edit {
    Insert(u32, String),
    Delete(u32, u32),
}

fn edits() -> impl Strategy<Value = Vec<Edit>> {
    prop::collection::vec(
        prop_oneof![
            (0u32..200, "[a-z ]{1,4}").prop_map(|(p, s)| Edit::Insert(p, s)),
            (0u32..200, 1u32..6).prop_map(|(p, n)| Edit::Delete(p, n)),
        ],
        1..12,
    )
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum St {
    Orig,
    Ins,
    Del,
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(48))]

    /// Engine ADR 1040 — accepting and rejecting are each other's opposite:
    /// over any tracked edits, rejecting everything gives back the text
    /// before them, accepting everything the text the same edits make
    /// untracked, and either undoes to the tracked document exactly.
    #[test]
    fn accept_and_reject_are_exact_inverses__feat__doc_word_track_changes(edits in edits()) {
        let original = "The quick brown fox jumps.";
        let (mut m, story) = model_with(&[original]);
        let pristine = m.scene().canonical_hash();
        track(&mut m, AUTHOR);
        let mut sim: Vec<(char, St)> = original.chars().map(|c| (c, St::Orig)).collect();
        for e in &edits {
            let len = sim.len() as u32;
            match e {
                Edit::Insert(p, s) => {
                    let p = p % (len + 1);
                    insert(&mut m, &story, p, s);
                    for (k, c) in s.chars().enumerate() {
                        sim.insert(p as usize + k, (c, St::Ins));
                    }
                }
                Edit::Delete(p, n) => {
                    if len == 0 { continue; }
                    let a = p % len;
                    let b = (a + n).min(len);
                    delete(&mut m, &story, a, b);
                    let mut i = a as usize;
                    for _ in a..b {
                        match sim[i].1 {
                            St::Ins => { sim.remove(i); }
                            St::Orig => { sim[i].1 = St::Del; i += 1; }
                            St::Del => { i += 1; }
                        }
                    }
                }
            }
            let expect: String = sim.iter().map(|(c, _)| *c).collect();
            prop_assert_eq!(raw(&m, &story), expect);
        }
        let tracked = m.scene().canonical_hash();
        reject_all(&mut m);
        prop_assert_eq!(raw(&m, &story), original);
        m.undo().unwrap();
        prop_assert_eq!(m.scene().canonical_hash(), tracked);
        accept_all(&mut m);
        let accepted: String = sim.iter().filter(|(_, s)| *s != St::Del).map(|(c, _)| *c).collect();
        prop_assert_eq!(raw(&m, &story), accepted);
        m.undo().unwrap();
        prop_assert_eq!(m.scene().canonical_hash(), tracked);
        // And the whole history undoes to the untracked document.
        while m.scene().canonical_hash() != pristine {
            if m.undo().is_none() { break; }
        }
        prop_assert_eq!(m.scene().canonical_hash(), pristine);
    }
}
