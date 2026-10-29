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

//! Doc ADR 613 — tracked changes and comments: read as the engine's
//! changes and comment threads, and saved back as Word's (`w:ins`,
//! `w:del`, `w:rPrChange`, `w:pPrChange`, a mark's change, the three
//! comment parts) when they are accepted, rejected, recorded or added in
//! paged. A zero-edit save stays byte-identical.

// Test names end in their cockpit feature (`__feat__<id>`).
#![allow(non_snake_case)]

use docx_conformance::{
    review_docx, tracked_changes_docx, tracked_changes_no_moves_docx, w0_plain_docx,
};
use docx_core::{Block, ChangeKind};
use docx_export::review::content_of;
use docx_export::{ChangeContentIn, CommentContentIn, ParagraphContentIn, StoryContentIn};
use docx_import::import_docx;
use docx_js::DocSession;
use docx_lower::ir::{LoweredBlock, LoweredDoc};
use paged_ooxml::OpcPackage;

fn part(bytes: &[u8], name: &str) -> Option<String> {
    let pkg = OpcPackage::read(bytes).unwrap();
    pkg.part(name)
        .map(|b| String::from_utf8(b.to_vec()).unwrap())
}

fn doc_xml(bytes: &[u8]) -> String {
    part(bytes, "word/document.xml").unwrap()
}

/// Every part of a saved package reads as XML.
fn assert_well_formed(bytes: &[u8]) {
    let pkg = OpcPackage::read(bytes).unwrap();
    for name in pkg.file_names() {
        if !(name.ends_with(".xml") || name.ends_with(".rels")) {
            continue;
        }
        if let Err(e) = paged_ooxml::tree::parse(pkg.part(name).unwrap()) {
            panic!("{name} does not read: {e}");
        }
    }
}

fn assert_parts_identical(original: &[u8], saved: &[u8]) {
    let a = OpcPackage::read(original).unwrap();
    let b = OpcPackage::read(saved).unwrap();
    for name in a.file_names() {
        assert_eq!(a.part(name), b.part(name), "part {name} byte-identical");
    }
}

/// The host's read-back of an unedited document: every paragraph with its
/// runs, looks and review markup, and the comments.
fn read_back(base: &LoweredDoc) -> StoryContentIn {
    StoryContentIn {
        self_id: "Story/doc".into(),
        paragraphs: base
            .story
            .blocks
            .iter()
            .filter_map(|b| match b {
                LoweredBlock::Paragraph(p) => Some(content_of(p)),
                _ => None,
            })
            .collect(),
        comments: base
            .comments
            .iter()
            .map(|c| CommentContentIn {
                id: c.id.clone(),
                parent_id: c.parent_id.clone(),
                text: c.text.clone(),
                author: c.author.clone(),
                initials: c.initials.clone(),
                date: c.date.clone(),
                resolved: c.resolved,
                ..Default::default()
            })
            .collect(),
    }
}

/// With `REVIEW_PROBE_OUT` set, keep a saved package for the Word probe
/// (`scripts/word-review-probe.sh` opens each in Word).
fn probe_out(name: &str, bytes: &[u8]) {
    if let Ok(dir) = std::env::var("REVIEW_PROBE_OUT") {
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(format!("{dir}/{name}.docx"), bytes).unwrap();
    }
}

fn texts(bytes: &[u8]) -> Vec<String> {
    import_docx(bytes)
        .unwrap()
        .body
        .iter()
        .filter_map(|b| match b {
            Block::Paragraph(p) => Some(p.runs.iter().map(|r| r.text.as_str()).collect()),
            Block::Table(_) => None,
        })
        .collect()
}

fn change(id: &str, kind: &str) -> ChangeContentIn {
    ChangeContentIn {
        id: id.into(),
        kind: kind.into(),
        author: Some("Author A".into()),
        date: Some("2026-10-29T08:00:00Z".into()),
    }
}

// ---------------------------------------------------------------------------
// Reading

#[test]
fn tracked_changes_are_read_as_changes__feat__plugin_doc_read_path() {
    let doc = import_docx(&tracked_changes_docx()).unwrap();
    let Block::Paragraph(p1) = &doc.body[1] else {
        panic!("a paragraph")
    };
    let kinds: Vec<_> = p1
        .runs
        .iter()
        .map(|r| (r.text.as_str(), r.change.as_ref().map(|c| c.kind)))
        .collect();
    assert_eq!(
        kinds,
        [
            ("Before ", None),
            ("inserted", Some(ChangeKind::Insert)),
            ("deleted", Some(ChangeKind::Delete)),
            (" after.", None),
        ]
    );
    let ins = p1.runs[1].change.as_ref().unwrap();
    assert_eq!(ins.revision.id, "1");
    assert_eq!(ins.revision.author.as_deref(), Some("Reviewer"));
    assert_eq!(ins.revision.date.as_deref(), Some("2026-10-01T10:00:00Z"));
    // The paragraph deleted whole stays, its mark carrying the deletion.
    let Block::Paragraph(p4) = &doc.body[4] else {
        panic!("a paragraph")
    };
    assert_eq!(p4.runs[0].text, "Gone paragraph");
    assert_eq!(p4.review.mark.as_ref().unwrap().kind, ChangeKind::Delete);
    let Block::Paragraph(p5) = &doc.body[5] else {
        panic!("a paragraph")
    };
    assert_eq!(p5.review.props.as_ref().unwrap().revision.id, "8");
    let fc = p5.runs[0].format_change.as_ref().unwrap();
    assert_eq!(fc.revision.id, "9");
    assert_eq!(fc.old_props.bold, None, "plain before");

    let ir = docx_lower::lower(&doc);
    let LoweredBlock::Paragraph(lp) = &ir.story.blocks[1] else {
        panic!("a paragraph")
    };
    assert_eq!(lp.runs[1].change.as_ref().unwrap().id, "docx-r1");
    assert_eq!(lp.runs[2].change.as_ref().unwrap().kind, "delete");
    let LoweredBlock::Paragraph(l4) = &ir.story.blocks[4] else {
        panic!("a paragraph")
    };
    assert_eq!(l4.mark_change.as_ref().unwrap().kind, "deleteMark");
    let LoweredBlock::Paragraph(l5) = &ir.story.blocks[5] else {
        panic!("a paragraph")
    };
    assert_eq!(l5.props_change.as_ref().unwrap().change.kind, "paraProps");
    let f = l5.runs[0].format_change.as_ref().unwrap();
    assert!(
        f.before_char_style_id.is_some(),
        "a look before to go back to"
    );
    assert!(ir
        .diagnostics
        .iter()
        .any(|d| d.message.starts_with("9 tracked change(s) read")));
}

#[test]
fn comment_threads_are_read_with_their_ranges__feat__plugin_doc_read_path() {
    let doc = import_docx(&review_docx()).unwrap();
    assert!(doc.track_revisions);
    assert_eq!(doc.comments.len(), 3);
    assert_eq!(doc.comments[1].parent, Some(0), "the reply's thread");
    assert!(doc.comments[2].done, "resolved");
    assert_eq!(doc.comments[0].durable_id.as_deref(), Some("11111111"));
    let runs = |b: usize| match &doc.body[b] {
        Block::Paragraph(p) => p
            .runs
            .iter()
            .filter(|r| !r.text.is_empty())
            .map(|r| (r.text.clone(), r.comments.clone()))
            .collect::<Vec<_>>(),
        Block::Table(_) => panic!("a paragraph"),
    };
    assert_eq!(
        runs(1),
        [("Commented text".to_string(), vec![0])],
        "a reply's range is its thread's"
    );
    assert_eq!(
        runs(2),
        [
            ("Second ".to_string(), vec![]),
            ("start".to_string(), vec![2])
        ]
    );
    assert_eq!(runs(3), [("Third paragraph.".to_string(), vec![2])]);
    let ir = docx_lower::lower(&doc);
    assert!(ir.track_changes);
    assert_eq!(ir.comments[1].parent_id.as_deref(), Some("docx-c0"));
    assert!(ir.comments[2].resolved);
}

// ---------------------------------------------------------------------------
// Saving

#[test]
fn a_zero_edit_save_is_byte_identical__feat__plugin_doc_save_back() {
    for (name, original) in [
        // Not for the Word probe: Word stops on the fixture's own move.
        ("", tracked_changes_docx()),
        ("tracked", tracked_changes_no_moves_docx()),
        ("review", review_docx()),
    ] {
        let session = DocSession::load(&original).unwrap();
        let content = read_back(&session.lowered());
        let (saved, skips) = session.save_edited_from_content(&content).unwrap();
        assert!(skips.is_empty(), "{skips:?}");
        assert_parts_identical(&original, &saved);
        if !name.is_empty() {
            probe_out(name, &original);
        }
    }
}

#[test]
fn accepting_and_rejecting_are_written_as_word_resolves_them__feat__plugin_doc_save_back() {
    let original = tracked_changes_no_moves_docx();
    let session = DocSession::load(&original).unwrap();
    let base = session.lowered();

    // Accept everything in p1: the insertion stays as text, the deletion goes.
    let mut content = read_back(&base);
    let p1 = &mut content.paragraphs[1];
    p1.runs[1].change = None;
    p1.runs.remove(2);
    let (saved, skips) = session.save_edited_from_content(&content).unwrap();
    assert!(skips.is_empty(), "{skips:?}");
    probe_out("tracked-accept", &saved);
    assert_well_formed(&saved);
    let xml = doc_xml(&saved);
    assert!(!xml.contains("<w:ins w:id=\"1\""), "{xml}");
    assert!(!xml.contains("deleted"), "{xml}");
    assert_eq!(texts(&saved)[1], "Before inserted after.");
    let re = import_docx(&saved).unwrap();
    let Block::Paragraph(p) = &re.body[1] else {
        panic!()
    };
    assert!(p.runs.iter().all(|r| r.change.is_none()), "no change left");

    // Reject everything in p1: the insertion goes, the deletion comes back.
    let mut content = read_back(&base);
    let p1 = &mut content.paragraphs[1];
    p1.runs.remove(1);
    p1.runs[1].change = None;
    let (saved, skips) = session.save_edited_from_content(&content).unwrap();
    assert!(skips.is_empty(), "{skips:?}");
    probe_out("tracked-reject", &saved);
    assert_well_formed(&saved);
    assert_eq!(texts(&saved)[1], "Before deleted after.");
    assert!(!doc_xml(&saved).contains("deleted</w:delText>"));

    // Every other paragraph is untouched.
    let (a, b) = (doc_xml(&original), doc_xml(&saved));
    assert!(b.contains("<w:del w:id=\"3\""));
    assert!(b.contains("<w:pPrChange w:id=\"8\""));
    assert!(a.contains("<w:t>Plain paragraph.</w:t>") && b.contains("<w:t>Plain paragraph.</w:t>"));
}

#[test]
fn a_format_and_a_paragraph_change_resolve__feat__plugin_doc_save_back() {
    let original = tracked_changes_no_moves_docx();
    let session = DocSession::load(&original).unwrap();
    let base = session.lowered();
    // Accept both changes of p5: the bold and the centring stay, unmarked.
    let mut content = read_back(&base);
    content.paragraphs[5].props_change = None;
    content.paragraphs[5].runs[0].format_change = None;
    let (saved, skips) = session.save_edited_from_content(&content).unwrap();
    assert!(skips.is_empty(), "{skips:?}");
    probe_out("format-accept", &saved);
    assert_well_formed(&saved);
    let xml = doc_xml(&saved);
    assert!(
        !xml.contains("pPrChange") && !xml.contains("rPrChange"),
        "{xml}"
    );
    assert!(xml.contains("<w:jc w:val=\"center\"/>") && xml.contains("<w:b/>"));

    // Reject the bold: the run's look goes back to the plain one.
    let mut content = read_back(&base);
    let before = content.paragraphs[5].runs[0]
        .format_change
        .as_ref()
        .unwrap()
        .before
        .character_style
        .clone();
    content.paragraphs[5].runs[0].format_change = None;
    content.paragraphs[5].runs[0].character_style = before;
    let (saved, skips) = session.save_edited_from_content(&content).unwrap();
    assert!(skips.is_empty(), "{skips:?}");
    probe_out("format-reject", &saved);
    let re = import_docx(&saved).unwrap();
    let Block::Paragraph(p) = &re.body[5] else {
        panic!()
    };
    assert_ne!(p.runs[0].props.bold, Some(true), "{:?}", p.runs[0].props);
    assert!(p.runs[0].format_change.is_none());
}

#[test]
fn changes_recorded_in_paged_are_written_as_words__feat__plugin_doc_save_back() {
    let original = w0_plain_docx();
    let session = DocSession::load(&original).unwrap();
    let base = session.lowered();
    let mut content = read_back(&base);
    // Typed with tracking on: " new" inserted at the end of p0, and the
    // first word deleted.
    let p0 = &mut content.paragraphs[0];
    let text = p0.runs[0].text.clone();
    let (first, rest) = text.split_at(text.find(' ').unwrap());
    let style = p0.runs[0].character_style.clone();
    let run = |t: &str, c: Option<ChangeContentIn>| docx_export::RunContentIn {
        text: t.into(),
        character_style: style.clone(),
        change: c,
        ..Default::default()
    };
    p0.runs = vec![
        run(first, Some(change("7", "delete"))),
        run(rest, None),
        run(" new", Some(change("8", "insert"))),
    ];
    let (saved, skips) = session.save_edited_from_content(&content).unwrap();
    assert!(skips.is_empty(), "{skips:?}");
    probe_out("tracked-recorded", &saved);
    assert_well_formed(&saved);
    let xml = doc_xml(&saved);
    assert!(
        xml.contains("w:author=\"Author A\" w:date=\"2026-10-29T08:00:00Z\""),
        "{xml}"
    );
    let re = import_docx(&saved).unwrap();
    let Block::Paragraph(p) = &re.body[0] else {
        panic!()
    };
    let kinds: Vec<_> = p
        .runs
        .iter()
        .map(|r| r.change.as_ref().map(|c| c.kind))
        .collect();
    assert_eq!(
        kinds,
        [Some(ChangeKind::Delete), None, Some(ChangeKind::Insert)]
    );
}

#[test]
fn a_mark_inserted_splits_and_a_mark_removed_joins__feat__plugin_doc_save_back() {
    let original = w0_plain_docx();
    let session = DocSession::load(&original).unwrap();
    let base = session.lowered();
    let n = read_back(&base).paragraphs.len();

    // Enter typed with tracking on in the middle of p0: two paragraphs, the
    // first's mark inserted.
    let mut content = read_back(&base);
    let p0 = content.paragraphs[0].clone();
    let text = p0.runs[0].text.clone();
    let cut = text.find(' ').unwrap();
    let mut a = p0.clone();
    a.runs[0].text = text[..cut].to_string();
    a.mark_change = Some(change("9", "insert"));
    let mut b = p0.clone();
    b.runs[0].text = text[cut..].to_string();
    content.paragraphs.splice(0..1, [a, b]);
    let (saved, skips) = session.save_edited_from_content(&content).unwrap();
    assert!(skips.is_empty(), "{skips:?}");
    probe_out("tracked-split", &saved);
    assert_well_formed(&saved);
    let t = texts(&saved);
    assert_eq!(t.len(), n + 1);
    assert_eq!(t[0], text[..cut]);
    let re = import_docx(&saved).unwrap();
    let Block::Paragraph(p) = &re.body[0] else {
        panic!()
    };
    assert_eq!(p.review.mark.as_ref().unwrap().kind, ChangeKind::Insert);

    // Accepting the deletion of a paragraph mark joins it to the next.
    let original = tracked_changes_no_moves_docx();
    let session = DocSession::load(&original).unwrap();
    let base = session.lowered();
    let mut content = read_back(&base);
    // p4 "Gone paragraph" (mark and text deleted) accepted whole: its text
    // goes and it joins p5.
    let p4 = content.paragraphs.remove(4);
    assert!(p4.mark_change.is_some());
    let (saved, skips) = session.save_edited_from_content(&content).unwrap();
    assert!(skips.is_empty(), "{skips:?}");
    probe_out("tracked-join", &saved);
    assert_well_formed(&saved);
    let t = texts(&saved);
    eprintln!("{}", doc_xml(&saved));
    assert_eq!(t.len(), 5, "{t:?}");
    assert_eq!(t[4], "Bold now");
    assert!(!doc_xml(&saved).contains("Gone paragraph"));
}

#[test]
fn comments_are_answered_resolved_added_and_removed__feat__plugin_doc_save_back() {
    let original = review_docx();
    let session = DocSession::load(&original).unwrap();
    let base = session.lowered();

    // A reply and the first thread resolved.
    let mut content = read_back(&base);
    content.comments[0].resolved = true;
    content.comments.push(CommentContentIn {
        id: "41".into(),
        parent_id: Some("docx-c0".into()),
        text: "Done & dusted".into(),
        author: Some("Author B".into()),
        date: Some("2026-10-29T09:00:00Z".into()),
        resolved: true,
        ..Default::default()
    });
    let (saved, skips) = session.save_edited_from_content(&content).unwrap();
    assert!(skips.is_empty(), "{skips:?}");
    probe_out("comments-reply-resolve", &saved);
    assert_well_formed(&saved);
    let comments = part(&saved, "word/comments.xml").unwrap();
    assert!(comments.contains("Done &amp; dusted"), "{comments}");
    let doc = import_docx(&saved).unwrap();
    assert_eq!(doc.comments.len(), 4);
    let reply = doc
        .comments
        .iter()
        .find(|c| c.text == "Done & dusted")
        .unwrap();
    assert_eq!(reply.parent, Some(0));
    assert!(doc.comments[0].done);
    let xml = doc_xml(&saved);
    assert!(xml.contains(&format!("<w:commentReference w:id=\"{}\"/>", reply.id)));

    // The second thread removed: its range and reference go, its comment too.
    let mut content = read_back(&base);
    content.comments.retain(|c| c.id != "docx-c2");
    for p in content.paragraphs.iter_mut() {
        for r in p.runs.iter_mut() {
            r.comments.retain(|c| c != "docx-c2");
        }
    }
    let (saved, skips) = session.save_edited_from_content(&content).unwrap();
    assert!(skips.is_empty(), "{skips:?}");
    probe_out("comments-remove", &saved);
    assert_well_formed(&saved);
    let xml = doc_xml(&saved);
    assert!(!xml.contains("w:id=\"2\""), "{xml}");
    let doc = import_docx(&saved).unwrap();
    assert_eq!(doc.comments.len(), 2);
    assert_eq!(texts(&saved)[2], "Second start");
}

#[test]
fn a_first_comment_makes_the_comment_parts__feat__plugin_doc_save_back() {
    let original = w0_plain_docx();
    let session = DocSession::load(&original).unwrap();
    let base = session.lowered();
    let mut content = read_back(&base);
    for r in content.paragraphs[0].runs.iter_mut() {
        r.comments = vec!["5".into()];
    }
    content.comments.push(CommentContentIn {
        id: "5".into(),
        text: "Check this\nTwo lines".into(),
        author: Some("Author A".into()),
        initials: Some("AA".into()),
        date: Some("2026-10-29T10:00:00Z".into()),
        ..Default::default()
    });
    let (saved, skips) = session.save_edited_from_content(&content).unwrap();
    assert!(skips.is_empty(), "{skips:?}");
    probe_out("comments-first", &saved);
    assert_well_formed(&saved);
    let types = part(&saved, "[Content_Types].xml").unwrap();
    for ct in ["comments+xml", "commentsExtended+xml", "commentsIds+xml"] {
        assert!(types.contains(ct), "{types}");
    }
    let rels = part(&saved, "word/_rels/document.xml.rels").unwrap();
    assert!(rels.contains("relationships/comments\""), "{rels}");
    let doc = import_docx(&saved).unwrap();
    assert_eq!(doc.comments.len(), 1);
    assert_eq!(doc.comments[0].text, "Check this\nTwo lines");
    let Block::Paragraph(p) = &doc.body[0] else {
        panic!()
    };
    assert!(p
        .runs
        .iter()
        .filter(|r| !r.text.is_empty())
        .all(|r| r.comments == [doc.comments[0].id]));
}

#[test]
fn a_paragraph_this_writer_cannot_write_is_refused_and_named__feat__plugin_doc_save_back() {
    let original = tracked_changes_docx();
    let session = DocSession::load(&original).unwrap();
    let mut content = read_back(&session.lowered());
    // p2 holds a move: accepting it in paged is not written.
    let p2: &mut ParagraphContentIn = &mut content.paragraphs[2];
    p2.runs[2].change = None;
    let (saved, skips) = session.save_edited_from_content(&content).unwrap();
    assert!(
        skips
            .iter()
            .any(|s| s.starts_with("tracked changes not saved: block 2")),
        "{skips:?}"
    );
    assert_eq!(doc_xml(&saved), doc_xml(&original));
}
