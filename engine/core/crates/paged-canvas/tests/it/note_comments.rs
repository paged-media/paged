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

//! IDML notes in the one comment model (engine ADRs 172 and 1055): the
//! `comments` collection lists InDesign's notes as rows of kind `note`; a
//! comment on a text range exports as a note with its replies folded into the
//! text; a document thread IDML cannot carry is named in the export's loss
//! list. `indesign-notes-2025.idml` is what InDesign 2025 wrote for two
//! stories, a note of three paragraphs, and a note in a table cell.

use paged_canvas::{CanvasModel, CanvasOptions, Mutation};
use paged_gen::samples::notes as sample;

fn fixture() -> Vec<u8> {
    std::fs::read(
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/indesign-notes-2025.idml"),
    )
    .expect("fixture")
}

fn load(idml: &[u8]) -> CanvasModel {
    CanvasModel::load("doc", idml, CanvasOptions::default()).expect("load")
}

fn sample_model() -> CanvasModel {
    load(&paged_gen::write_idml(&sample::build()).expect("idml"))
}

#[test]
fn indesign_notes_are_comment_rows_of_kind_note() {
    let m = load(&fixture());
    let rows: Vec<_> = m
        .comments()
        .into_iter()
        .filter(|r| r.thread_kind.as_deref() == Some("note"))
        .collect();
    let mut seen: Vec<(String, Option<u32>)> =
        rows.iter().map(|r| (r.text.clone(), r.start)).collect();
    seen.sort();
    assert_eq!(
        seen,
        [
            ("Cell note.".to_string(), None),
            ("Other story note.".to_string(), Some(7)),
            ("Para one.\nPara two.\nPara three.".to_string(), Some(17)),
            ("Point note.".to_string(), Some(6)),
        ]
    );
    let point = rows.iter().find(|r| r.text == "Point note.").unwrap();
    assert_eq!(point.author.as_deref(), Some("Unbekannter Benutzername"));
    assert!(point.date.as_deref().unwrap().starts_with("2026-11-01T"));
    assert_eq!(point.end, point.start);
    assert!(point.thread_id.is_none() && !point.resolved && !point.orphaned);
    // Every note is also in the `notes` collection (the editing door).
    assert_eq!(m.notes().len(), 3);
}

#[test]
fn an_unedited_document_keeps_its_notes_through_a_save() {
    let m = load(&fixture());
    let saved = load(&m.export_idml().expect("export"));
    let texts = |m: &CanvasModel| {
        let mut v: Vec<_> = m
            .comments()
            .into_iter()
            .map(|r| (r.text, r.author, r.date, r.modified, r.start))
            .collect();
        v.sort();
        v
    };
    assert_eq!(texts(&saved), texts(&m));
    assert_eq!(texts(&m).len(), 4);
    // Nothing is reported lost for notes InDesign wrote.
    assert!(m
        .idml_export_losses()
        .iter()
        .all(|l| !l.message.contains("comment thread")));
}

#[test]
fn a_text_comment_with_replies_exports_as_one_note_and_the_fold_is_reported() {
    let mut m = sample_model();
    let story = sample::story_id();
    let before = m.notes().len();
    m.apply_mutation(&Mutation::InsertComment {
        story_id: story.clone(),
        start: 5,
        end: 9,
        cell: None,
        comment: paged_mutate::CommentSpec {
            id: Some("c1".into()),
            author: Some("Ada".into()),
            date: Some("2026-11-01T09:30:15Z".into()),
            text: "Is this right?".into(),
            ..Default::default()
        },
    })
    .expect("comment");
    m.apply_mutation(&Mutation::ReplyComment {
        parent_id: "c1".into(),
        comment: paged_mutate::CommentSpec {
            id: Some("c2".into()),
            author: Some("Grace".into()),
            text: "Yes.".into(),
            ..Default::default()
        },
    })
    .expect("reply");

    let lost: Vec<String> = m
        .idml_export_losses()
        .into_iter()
        .map(|l| l.message)
        .collect();
    assert!(
        lost.iter()
            .any(|l| l.contains("`c1`") && l.contains("1 reply") && l.contains("fold")),
        "{lost:#?}"
    );
    // Nothing else of the comment is reported as dropped.
    assert!(!lost.iter().any(|l| l.contains("is dropped")), "{lost:#?}");

    let twin = load(&m.export_idml().expect("export"));
    let notes = twin.notes();
    assert_eq!(notes.len(), before + 1);
    let note = notes.iter().find(|n| n.offset == 5).expect("at the range");
    assert_eq!(note.text, "Is this right?\rGrace: Yes.");
    assert_eq!(note.user_name.as_deref(), Some("Ada"));
    assert_eq!(note.creation_date.as_deref(), Some("2026-11-01T09:30:15"));
    // The notes that stood in the story are where they were, one marker on.
    let old: Vec<u32> = m.notes().iter().map(|n| n.offset + 1).collect();
    let moved: Vec<u32> = notes.iter().skip(1).map(|n| n.offset).collect();
    assert_eq!(moved, old);
}

#[test]
fn a_document_thread_is_named_in_the_loss_list() {
    let mut m = sample_model();
    assert!(m
        .idml_export_losses()
        .iter()
        .all(|l| !l.message.contains("comment thread")));
    m.apply_mutation(&Mutation::InsertCommentThread {
        anchor: paged_mutate::operation::CommentAnchorSpec::Cell {
            item: "frame1".into(),
            address: "Sheet1!B3".into(),
        },
        thread_kind: None,
        comment: paged_mutate::CommentSpec {
            id: Some("t1".into()),
            author: Some("Ada".into()),
            text: "Move this".into(),
            ..Default::default()
        },
    })
    .expect("thread");
    m.apply_mutation(&Mutation::ReplyComment {
        parent_id: "t1".into(),
        comment: paged_mutate::CommentSpec {
            id: Some("t1.1".into()),
            text: "Done".into(),
            ..Default::default()
        },
    })
    .expect("reply");
    let lost: Vec<String> = m
        .idml_export_losses()
        .into_iter()
        .map(|l| l.message)
        .collect();
    let line = lost
        .iter()
        .find(|l| l.contains("`t1`"))
        .unwrap_or_else(|| panic!("{lost:#?}"));
    assert!(line.contains("on cell `Sheet1!B3` of `frame1`") && line.contains("1 reply"));
    assert!(line.contains("is dropped"));
}

#[test]
fn a_note_added_to_a_story_with_a_split_range_keeps_the_whole_story() {
    // A comment splits the paragraph's first range into runs; a note typed
    // into one of them must not cost the runs after it (nor the other notes).
    let mut m = sample_model();
    let story = sample::story_id();
    m.apply_mutation(&Mutation::InsertComment {
        story_id: story.clone(),
        start: 5,
        end: 9,
        cell: None,
        comment: paged_mutate::CommentSpec {
            id: Some("c1".into()),
            text: "x".into(),
            ..Default::default()
        },
    })
    .expect("comment");
    m.apply_mutation(&Mutation::InsertNote {
        story_id: story,
        offset: 5,
        paragraph: None,
        text: "Z".into(),
        user: None,
        date: None,
    })
    .expect("note");
    let saved = load(&m.export_idml().expect("export"));
    let read = |m: &CanvasModel| -> Vec<(u32, String)> {
        m.notes().into_iter().map(|n| (n.offset, n.text)).collect()
    };
    // The comment is the note "x" now; the rest stand one marker on.
    let mut want = vec![(5, "x".to_string())];
    want.extend(read(&m).into_iter().map(|(at, t)| (at + 1, t)));
    assert_eq!(read(&saved), want);
    let text = |m: &CanvasModel| -> String {
        m.scene().stories[0]
            .story
            .paragraphs
            .iter()
            .map(|p| p.runs.iter().map(|r| r.text.as_str()).collect::<String>())
            .collect::<Vec<_>>()
            .join("\n")
            .replace(paged_model::NOTE_MARKER, "")
    };
    assert_eq!(text(&saved), text(&m));
}
