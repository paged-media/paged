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

//! Engine ADR 1055 over the wire: comment threads on a page item, a page
//! point, a region and a module address are inserted, replied to, resolved,
//! edited, re-anchored and deleted; ids never collide with the text comments of
//! ADR 1020; every step undoes to the exact model before it; and the threads
//! survive the native `.paged` encoding.
// Test names carry their feature row (`…__feat__…`).
#![allow(non_snake_case)]

use paged_canvas::{CanvasModel, CanvasOptions, Mutation};
use paged_mutate::operation::{CommentAnchorSpec, PersonSpec};
use paged_mutate::{CommentSpec, MentionSpec, SourceBlobSpec};

fn model() -> CanvasModel {
    let idml = paged_gen::write_idml(&paged_gen::samples::notes::build()).expect("idml");
    CanvasModel::load("doc", &idml, CanvasOptions::default()).expect("load")
}

fn spec(id: Option<&str>, who: &str, text: &str) -> CommentSpec {
    CommentSpec {
        id: id.map(str::to_string),
        author: Some(who.into()),
        initials: Some("AA".into()),
        date: Some("2026-11-01T09:00:00Z".into()),
        text: text.into(),
        ..Default::default()
    }
}

fn item(id: &str) -> CommentAnchorSpec {
    CommentAnchorSpec::Item {
        item: id.into(),
        at: Some([12.0, 34.0]),
    }
}

fn insert(m: &mut CanvasModel, anchor: CommentAnchorSpec, id: Option<&str>, text: &str) {
    m.apply_mutation(&Mutation::InsertCommentThread {
        anchor,
        thread_kind: None,
        comment: spec(id, "Author A", text),
    })
    .expect("insert thread");
}

#[test]
fn a_thread_is_inserted_replied_to_resolved_edited_and_deleted__feat__core_comments() {
    let mut m = model();
    let before = m.scene().canonical_hash();
    insert(&mut m, item("u1"), Some("t1"), "Check the margin");
    m.apply_mutation(&Mutation::ReplyComment {
        parent_id: "t1".into(),
        comment: spec(None, "Author B", "Fixed"),
    })
    .unwrap();
    let rows = m.comments();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].thread_id.as_deref(), Some("t1"));
    assert_eq!(rows[0].story_id, "");
    assert_eq!(rows[0].thread_kind.as_deref(), Some("comment"));
    assert!(matches!(
        &rows[0].anchor,
        Some(CommentAnchorSpec::Item { item, at: Some([12.0, 34.0]) }) if item == "u1"
    ));
    assert_eq!(rows[1].id, "t1.1"); // the reply's id is minted in the thread
    assert_eq!(rows[1].parent_id.as_deref(), Some("t1"));

    // Resolving any comment resolves the thread, as Word's Resolve does.
    m.apply_mutation(&Mutation::ResolveComment {
        comment_id: "t1.1".into(),
        resolved: true,
    })
    .unwrap();
    assert!(m.comments().iter().all(|c| c.resolved));

    // Editing stamps the modification time, not the creation time.
    m.apply_mutation(&Mutation::EditComment {
        comment_id: "t1".into(),
        text: "Check the margins".into(),
        date: Some("2026-11-01T10:30:00.250Z".into()),
    })
    .unwrap();
    let root = m.comments().into_iter().find(|c| c.id == "t1").unwrap();
    assert_eq!(root.text, "Check the margins");
    assert_eq!(root.date.as_deref(), Some("2026-11-01T09:00:00Z"));
    assert_eq!(root.modified.as_deref(), Some("2026-11-01T10:30:00.250Z"));

    // A reply reopens a resolved thread.
    m.apply_mutation(&Mutation::ReplyComment {
        parent_id: "t1".into(),
        comment: spec(None, "Author A", "Reopened"),
    })
    .unwrap();
    assert!(m.comments().iter().all(|c| !c.resolved));

    // Deleting a reply keeps the thread; deleting the root takes it all.
    m.apply_mutation(&Mutation::DeleteComment {
        comment_id: "t1.1".into(),
    })
    .unwrap();
    assert_eq!(m.comments().len(), 2);
    m.apply_mutation(&Mutation::DeleteComment {
        comment_id: "t1".into(),
    })
    .unwrap();
    assert!(m.comments().is_empty());

    // Seven steps (insert, reply, resolve, edit, reply, delete reply, delete root).
    for _ in 0..7 {
        m.undo().expect("undo");
    }
    assert_eq!(m.scene().canonical_hash(), before);
    assert!(m.comments().is_empty());
}

#[test]
fn every_anchor_kind_reads_back_and_a_thread_can_move__feat__core_comments() {
    let mut m = model();
    insert(
        &mut m,
        CommentAnchorSpec::Page {
            page: "p1".into(),
            at: [100.0, 200.0],
        },
        Some("a"),
        "page",
    );
    insert(
        &mut m,
        CommentAnchorSpec::Region {
            item: "img1".into(),
            rect: [0.0, 0.0, 50.0, 40.0],
        },
        Some("b"),
        "region",
    );
    insert(
        &mut m,
        CommentAnchorSpec::Cell {
            item: "sheet1".into(),
            address: "Sheet1!B3".into(),
        },
        Some("c"),
        "cell",
    );
    let rows = m.comments();
    assert!(matches!(&rows[0].anchor, Some(CommentAnchorSpec::Page { page, .. }) if page == "p1"));
    assert!(
        matches!(&rows[1].anchor, Some(CommentAnchorSpec::Region { rect, .. }) if rect[2] == 50.0)
    );
    assert!(
        matches!(&rows[2].anchor, Some(CommentAnchorSpec::Cell { address, .. }) if address == "Sheet1!B3")
    );

    m.apply_mutation(&Mutation::SetCommentAnchor {
        thread_id: "c".into(),
        anchor: CommentAnchorSpec::Cell {
            item: "sheet1".into(),
            address: "Sheet1!C9".into(),
        },
    })
    .unwrap();
    let moved = m.comments().into_iter().find(|c| c.id == "c").unwrap();
    assert!(
        matches!(&moved.anchor, Some(CommentAnchorSpec::Cell { address, .. }) if address == "Sheet1!C9")
    );
    m.undo().unwrap();
    let back = m.comments().into_iter().find(|c| c.id == "c").unwrap();
    assert!(
        matches!(&back.anchor, Some(CommentAnchorSpec::Cell { address, .. }) if address == "Sheet1!B3")
    );

    // An empty anchor is refused, and the failed step leaves nothing behind.
    let n = m.comments().len();
    assert!(m
        .apply_mutation(&Mutation::SetCommentAnchor {
            thread_id: "a".into(),
            anchor: CommentAnchorSpec::Item {
                item: String::new(),
                at: None,
            },
        })
        .is_err());
    assert_eq!(m.comments().len(), n);
}

#[test]
fn a_note_takes_no_replies_and_ids_are_unique_across_both_stores__feat__core_comments() {
    let mut m = model();
    m.apply_mutation(&Mutation::InsertCommentThread {
        anchor: item("u1"),
        thread_kind: Some("note".into()),
        comment: spec(Some("n1"), "Author A", "a sticky note"),
    })
    .unwrap();
    assert_eq!(m.comments()[0].thread_kind.as_deref(), Some("note"));
    assert!(m
        .apply_mutation(&Mutation::ReplyComment {
            parent_id: "n1".into(),
            comment: spec(None, "Author B", "reply to a note"),
        })
        .is_err());

    // A text comment and a thread comment never share an id; minted ids count
    // past both stores.
    let story = m.scene().stories[0].self_id.clone();
    m.apply_mutation(&Mutation::InsertComment {
        story_id: story,
        start: 0,
        end: 3,
        cell: None,
        comment: spec(Some("7"), "Author A", "on text"),
    })
    .unwrap();
    insert(&mut m, item("u2"), None, "minted");
    let ids: Vec<String> = m.comments().into_iter().map(|c| c.id).collect();
    assert!(ids.contains(&"8".to_string()), "{ids:?}");
    assert!(m
        .apply_mutation(&Mutation::InsertCommentThread {
            anchor: item("u3"),
            thread_kind: None,
            comment: spec(Some("7"), "Author A", "clash"),
        })
        .is_err());
}

#[test]
fn people_and_comment_fields_survive_the_native_encoding__feat__core_comments() {
    let mut m = model();
    m.apply_mutation(&Mutation::SetPerson {
        person: PersonSpec {
            id: "p-ann".into(),
            name: "Ann Author".into(),
            initials: Some("AA".into()),
            user_id: Some("S::ann@example.org::1".into()),
            provider_id: Some("AD".into()),
        },
    })
    .unwrap();
    m.apply_mutation(&Mutation::InsertCommentThread {
        anchor: item("u1"),
        thread_kind: None,
        comment: CommentSpec {
            person: Some("p-ann".into()),
            mentions: vec![MentionSpec {
                person: "p-ann".into(),
                start: 0,
                end: 4,
            }],
            ..spec(Some("t"), "Ann Author", "@Ann look")
        },
    })
    .unwrap();

    let bytes = paged_store::to_bytes(m.scene()).expect("encode");
    let back = paged_store::from_bytes(&bytes).expect("decode");
    assert_eq!(back.people.len(), 1);
    assert_eq!(
        back.people[0].user_id.as_deref(),
        Some("S::ann@example.org::1")
    );
    assert_eq!(back.comment_threads.len(), 1);
    let c = &back.comment_threads[0].comments[0];
    assert_eq!(c.person.as_deref(), Some("p-ann"));
    assert_eq!(c.mentions.len(), 1);
    assert_eq!(c.mentions[0].end, 4);
    assert_eq!(back.canonical_hash(), m.scene().canonical_hash());

    // Updating a person replaces the entry; undo restores it.
    m.apply_mutation(&Mutation::SetPerson {
        person: PersonSpec {
            id: "p-ann".into(),
            name: "Ann B. Author".into(),
            ..Default::default()
        },
    })
    .unwrap();
    assert_eq!(m.scene().people.len(), 1);
    assert_eq!(m.scene().people[0].name, "Ann B. Author");
    m.undo().unwrap();
    assert_eq!(m.scene().people[0].name, "Ann Author");
}

#[test]
fn a_comment_keeps_what_its_format_wrote_for_it__feat__core_comments() {
    let mut m = model();
    let blob = |data: &str| {
        Some(SourceBlobSpec {
            format: "pptx".into(),
            data: data.into(),
        })
    };
    m.apply_mutation(&Mutation::InsertCommentThread {
        anchor: item("u1"),
        thread_kind: None,
        comment: CommentSpec {
            source: blob(r#"{"id":"A","legacy":true}"#),
            ..spec(Some("A"), "Ann Author", "root")
        },
    })
    .unwrap();
    m.apply_mutation(&Mutation::ReplyComment {
        parent_id: "A".into(),
        comment: CommentSpec {
            source: blob(r#"{"id":"A.1"}"#),
            ..spec(Some("A.1"), "Bob", "reply")
        },
    })
    .unwrap();
    let rows = m.comments();
    let src = |id: &str| {
        rows.iter()
            .find(|r| r.id == id)
            .and_then(|r| r.source.clone())
            .map(|s| (s.format, s.data))
    };
    assert_eq!(
        src("A"),
        Some(("pptx".into(), r#"{"id":"A","legacy":true}"#.into()))
    );
    assert_eq!(src("A.1"), Some(("pptx".into(), r#"{"id":"A.1"}"#.into())));

    // A comment without one reports none; deleting a reply drops its source.
    m.apply_mutation(&Mutation::ReplyComment {
        parent_id: "A".into(),
        comment: spec(Some("A.2"), "Cy", "no source"),
    })
    .unwrap();
    assert!(m
        .comments()
        .iter()
        .find(|r| r.id == "A.2")
        .unwrap()
        .source
        .is_none());
    m.apply_mutation(&Mutation::DeleteComment {
        comment_id: "A.1".into(),
    })
    .unwrap();
    assert_eq!(m.scene().comment_threads[0].source.len(), 1);
    m.undo().unwrap();
    assert_eq!(m.scene().comment_threads[0].source.len(), 2);
}

#[test]
fn a_thread_reports_the_page_and_point_it_stands_at__feat__core_comments() {
    let mut m = model();
    let page = m.scene().spreads[0].spread.pages[0]
        .self_id
        .clone()
        .expect("a page id");
    let frame = m.scene().spreads[0].spread.text_frames[0]
        .self_id
        .clone()
        .expect("a text frame id");

    insert(
        &mut m,
        CommentAnchorSpec::Page {
            page: page.clone(),
            at: [40.0, 50.0],
        },
        Some("p"),
        "on the page",
    );
    // A page id used as a module address stands at the page's origin.
    insert(
        &mut m,
        CommentAnchorSpec::Cell {
            item: page.clone(),
            address: "shape:5".into(),
        },
        Some("c"),
        "a module address on a page",
    );
    insert(&mut m, item(&frame), Some("i"), "on an item");
    insert(
        &mut m,
        CommentAnchorSpec::Item {
            item: "no-such-item".into(),
            at: None,
        },
        Some("x"),
        "its target is not here",
    );

    let rows = m.comments();
    let at = |id: &str| {
        let r = rows.iter().find(|r| r.id == id).unwrap();
        (r.page.clone(), r.at)
    };
    assert_eq!(at("p"), (Some(page.clone()), Some([40.0, 50.0])));
    assert_eq!(at("c"), (Some(page.clone()), Some([0.0, 0.0])));
    let (item_page, item_at) = at("i");
    assert_eq!(item_page.as_deref(), Some(page.as_str()));
    // The anchor's own point (12, 34) is in the item's space, from its top-left.
    let origin = item_at.expect("a point");
    assert!(origin[0] >= 12.0 && origin[1] >= 34.0);
    assert_eq!(at("x"), (None, None));
}

fn export_pdf(m: &CanvasModel, comments: bool) -> String {
    use paged_canvas::channel::ExportPdfWireOptions;
    use paged_canvas::export::CanvasExportSession;
    let wire = ExportPdfWireOptions {
        comments,
        ..ExportPdfWireOptions::default()
    };
    let (mut session, pages) = CanvasExportSession::begin(m, &wire).expect("begin");
    for _ in 0..pages {
        session.export_next_page().expect("page");
    }
    let pdf = session.finish().expect("finish").pdf_bytes;
    String::from_utf8_lossy(&pdf).into_owned()
}

#[test]
fn comments_export_as_pdf_annotations_only_when_asked__feat__core_comments() {
    let mut m = model();
    let page = m.scene().spreads[0].spread.pages[0]
        .self_id
        .clone()
        .expect("a page id");
    // A story that is laid out on a page: the first text frame's.
    let story = m.scene().spreads[0].spread.text_frames[0]
        .parent_story
        .clone()
        .expect("a frame with a story");
    insert(
        &mut m,
        CommentAnchorSpec::Page {
            page,
            at: [40.0, 50.0],
        },
        Some("t1"),
        "Page note",
    );
    m.apply_mutation(&Mutation::ReplyComment {
        parent_id: "t1".into(),
        comment: spec(Some("t1.1"), "Bob", "Page reply"),
    })
    .unwrap();
    m.apply_mutation(&Mutation::InsertComment {
        story_id: story,
        start: 0,
        end: 4,
        cell: None,
        comment: spec(Some("9"), "Author A", "Text note"),
    })
    .unwrap();

    let without = export_pdf(&m, false);
    assert!(
        !without.contains("/Subtype /Text"),
        "no annotations by default"
    );

    let with = export_pdf(&m, true);
    for expected in ["(Page note)", "(Page reply)", "(Text note)"] {
        assert!(
            with.contains(&format!("/Contents {expected}")),
            "{expected}"
        );
    }
    assert!(with.contains("/T (Bob)"));
    assert!(with.contains("/IRT"), "the reply is in reply to its note");
    assert_eq!(with.matches("/Subtype /Text").count(), 3);
}

#[test]
fn deleting_the_item_a_thread_is_on_orphans_it_and_undo_brings_it_back__feat__core_comments() {
    let mut m = model();
    let frame = m.scene().spreads[0].spread.text_frames[0]
        .self_id
        .clone()
        .expect("a text frame id");
    insert(&mut m, item(&frame), Some("t1"), "Check this frame");
    let before = m.scene().canonical_hash();
    let row = |m: &CanvasModel| m.comments().into_iter().find(|c| c.id == "t1").unwrap();
    assert!(!row(&m).orphaned);
    assert!(row(&m).page.is_some());

    m.apply_mutation(&Mutation::DeleteFrame {
        frame_id: frame.clone(),
    })
    .unwrap();
    // The thread is kept, with its anchor, and reads as orphaned.
    let gone = row(&m);
    assert!(gone.orphaned);
    assert!(gone.page.is_none());
    assert!(matches!(&gone.anchor, Some(CommentAnchorSpec::Item { item, .. }) if item == &frame));

    // Re-anchoring it to a page brings it back.
    let page = m.scene().spreads[0].spread.pages[0]
        .self_id
        .clone()
        .expect("a page id");
    m.apply_mutation(&Mutation::SetCommentAnchor {
        thread_id: "t1".into(),
        anchor: CommentAnchorSpec::Page {
            page,
            at: [10.0, 10.0],
        },
    })
    .unwrap();
    assert!(!row(&m).orphaned);
    m.undo().unwrap();
    assert!(row(&m).orphaned);

    // Undoing the deletion restores the item, and the thread is anchored again.
    m.undo().unwrap();
    assert!(!row(&m).orphaned);
    assert_eq!(m.scene().canonical_hash(), before);
}
