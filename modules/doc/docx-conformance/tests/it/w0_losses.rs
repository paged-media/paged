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

//! W0 of the Word-parity program, "stop the silent losses": tracked changes
//! show as accepted, content controls keep their content, hidden text is
//! not shown — each with its diagnostic — and save-back (ADR 602, the
//! 2026-10-24 amendment) never loses what the canvas does not show: an edit
//! either lands on the right `<w:r>` or is refused with its reason, and a
//! zero-edit save stays byte-identical.

// Test names end in their cockpit feature (`__feat__<id>`).
#![allow(non_snake_case)]

use docx_conformance::{content_controls_docx, hidden_text_docx, tracked_changes_docx};
use docx_core::{Block, DocxDocument, RunSource};
use docx_export::{CellRunEdit, EditSet, ParaEdit, RunEdit, StoryContentIn, StructuralEdit};
use docx_import::import_docx;
use docx_js::DocSession;
use docx_lower::ir::{LoweredBlock, LoweredDoc};
use paged_ooxml::OpcPackage;

fn doc_xml(bytes: &[u8]) -> String {
    let pkg = OpcPackage::read(bytes).unwrap();
    String::from_utf8(pkg.part("word/document.xml").unwrap().to_vec()).unwrap()
}

/// Every body block's text: a paragraph's runs joined, a table's cell
/// paragraphs joined with `|`.
fn block_texts(doc: &DocxDocument) -> Vec<String> {
    doc.body
        .iter()
        .map(|b| match b {
            Block::Paragraph(p) => p.runs.iter().map(|r| r.text.as_str()).collect(),
            Block::Table(t) => t
                .rows
                .iter()
                .flat_map(|r| &r.cells)
                .flat_map(|c| &c.paragraphs)
                .map(|p| p.runs.iter().map(|r| r.text.as_str()).collect::<String>())
                .collect::<Vec<_>>()
                .join("|"),
        })
        .collect()
}

/// The host's story read-back of an unedited document: the baseline's
/// paragraphs, run for run.
fn identity_content(base: &LoweredDoc) -> StoryContentIn {
    StoryContentIn {
        self_id: "Story/doc".into(),
        paragraphs: base
            .story
            .blocks
            .iter()
            .filter_map(|b| match b {
                LoweredBlock::Paragraph(p) => Some(docx_export::review::content_of(p)),
                _ => None,
            })
            .collect(),
        comments: Vec::new(),
    }
}

fn assert_parts_identical(original: &[u8], saved: &[u8]) {
    let a = OpcPackage::read(original).unwrap();
    let b = OpcPackage::read(saved).unwrap();
    for name in a.file_names() {
        assert_eq!(a.part(name), b.part(name), "part {name} byte-identical");
    }
}

fn diagnostics(bytes: &[u8]) -> Vec<String> {
    docx_lower::lower(&import_docx(bytes).unwrap())
        .diagnostics
        .iter()
        .map(|d| d.message.clone())
        .collect()
}

// ---------------------------------------------------------------------------
// Tracked changes

#[test]
fn tracked_changes_keep_their_runs_addressable__feat__plugin_doc_read_path() {
    // Doc ADR 613 replaced W0's "shown as accepted": every tracked run is
    // shown with its change (tests/it/review.rs); the run sources stay.
    let doc = import_docx(&tracked_changes_docx()).unwrap();
    assert_eq!(
        block_texts(&doc),
        [
            "Plain paragraph.",
            "Before inserteddeleted after.",
            "moved Stay moved",
            "Link new end",
            "Gone paragraph",
            "Bold now",
        ]
    );
    assert_eq!(doc.held.tracked_changes, 9);
    let Block::Paragraph(p1) = &doc.body[1] else {
        panic!("a paragraph")
    };
    let sources: Vec<_> = p1.runs.iter().map(|r| r.source).collect();
    assert_eq!(
        sources,
        [
            Some(RunSource::DirectRun(0)),
            Some(RunSource::Tracked),
            Some(RunSource::Tracked),
            Some(RunSource::DirectRun(1)),
        ]
    );
    assert_eq!(p1.held.unshown_runs, 0, "the deletion is shown");
    let Block::Paragraph(p3) = &doc.body[3] else {
        panic!("a paragraph")
    };
    let sources: Vec<_> = p3.runs.iter().map(|r| r.source).collect();
    assert_eq!(
        sources,
        [
            Some(RunSource::Hyperlink {
                link_ord: 0,
                run_ord: 0
            }),
            Some(RunSource::Tracked),
            Some(RunSource::Hyperlink {
                link_ord: 0,
                run_ord: 1
            }),
        ],
        "the insertion inside the hyperlink takes no wrapper ordinal"
    );
    let Block::Paragraph(p5) = &doc.body[5] else {
        panic!("a paragraph")
    };
    assert!(p5.held.tracked_ppr);
    assert_eq!(p5.runs[0].props.bold, Some(true), "the new formatting");
}

#[test]
fn tracked_changes_zero_edit_save_is_byte_identical__feat__plugin_doc_save_back() {
    let original = tracked_changes_docx();
    let session = DocSession::load(&original).unwrap();
    let (saved, skips) = session.save_edited(&EditSet::default()).unwrap();
    assert!(skips.is_empty(), "{skips:?}");
    assert_parts_identical(&original, &saved);
    let content = identity_content(&session.lowered());
    let (saved, skips) = session.save_edited_from_content(&content).unwrap();
    assert!(skips.is_empty(), "{skips:?}");
    assert_parts_identical(&original, &saved);
}

#[test]
fn an_unrelated_edit_keeps_the_tracked_changes__feat__plugin_doc_save_back() {
    let original = tracked_changes_docx();
    let session = DocSession::load(&original).unwrap();
    let mut content = identity_content(&session.lowered());
    content.paragraphs[0].runs[0].text = "Edited paragraph.".into();
    let (saved, skips) = session.save_edited_from_content(&content).unwrap();
    assert!(skips.is_empty(), "{skips:?}");
    let (before, after) = (doc_xml(&original), doc_xml(&saved));
    assert_eq!(
        after,
        before.replace(
            "<w:t>Plain paragraph.</w:t>",
            "<w:t xml:space=\"preserve\">Edited paragraph.</w:t>"
        ),
        "only the edited run's text changed"
    );
}

#[test]
fn an_edit_beside_an_insertion_lands_on_its_own_run__feat__plugin_doc_save_back() {
    let original = tracked_changes_docx();
    let session = DocSession::load(&original).unwrap();
    // Block 1 runs: "Before " (direct 0), "inserted" and "deleted" (tracked),
    // " after." (direct 1).
    let edits = EditSet {
        runs: vec![RunEdit::text(1, 3, " later.")],
        ..Default::default()
    };
    let (saved, skips) = session.save_edited(&edits).unwrap();
    assert!(skips.is_empty(), "{skips:?}");
    let xml = doc_xml(&saved);
    assert!(
        xml.contains("<w:t xml:space=\"preserve\"> later.</w:t>"),
        "{xml}"
    );
    assert!(xml.contains("<w:ins w:id=\"1\""), "the insertion is kept");
    assert!(
        xml.contains("<w:delText>deleted</w:delText>"),
        "the deletion is kept"
    );
    let re = import_docx(&saved).unwrap();
    assert_eq!(block_texts(&re)[1], "Before inserteddeleted later.");

    // Inside the hyperlink: " end" is the wrapper's SECOND `<w:r>` child —
    // the run inside the insertion must not shift it.
    let edits = EditSet {
        runs: vec![RunEdit::text(3, 2, " finish")],
        ..Default::default()
    };
    let (saved, skips) = session.save_edited(&edits).unwrap();
    assert!(skips.is_empty(), "{skips:?}");
    let re = import_docx(&saved).unwrap();
    assert_eq!(block_texts(&re)[3], "Link new finish");
}

#[test]
fn an_edit_reaching_a_tracked_change_is_refused_whole__feat__plugin_doc_save_back() {
    let original = tracked_changes_docx();
    let session = DocSession::load(&original).unwrap();

    // The inserted run itself.
    let edits = EditSet {
        runs: vec![RunEdit::text(1, 1, "changed")],
        ..Default::default()
    };
    let (saved, skips) = session.save_edited(&edits).unwrap();
    assert_eq!(doc_xml(&saved), doc_xml(&original), "nothing written");
    assert!(
        skips
            .iter()
            .any(|s| s.contains("block 1 run 1 is inside a tracked change")),
        "{skips:?}"
    );

    // A canvas edit across "Before " and "inserted" (doc ADR 613): the
    // paragraph holds review markup, so the review writer writes it whole,
    // the deletion kept.
    let mut content = identity_content(&session.lowered());
    content.paragraphs[1].runs[0].text = "Now ".into();
    content.paragraphs[1].runs[1].text = String::new();
    let (saved, skips) = session.save_edited_from_content(&content).unwrap();
    assert!(skips.is_empty(), "{skips:?}");
    let re = import_docx(&saved).unwrap();
    assert_eq!(block_texts(&re)[1], "Now deleted after.");
    assert!(doc_xml(&saved).contains("deleted</w:delText>"));
}

#[test]
fn paragraph_ops_keep_what_the_canvas_does_not_show__feat__plugin_doc_save_back() {
    let original = tracked_changes_docx();
    let session = DocSession::load(&original).unwrap();
    let edits = EditSet {
        structural: vec![StructuralEdit::DeleteParagraph { block: 0 }],
        // Block 5's `w:pPr` records a tracked change a rewrite would drop.
        paragraphs: vec![ParaEdit {
            block: 5,
            new_props: Default::default(),
            pstyle: Some(None),
        }],
        ..Default::default()
    };
    let (saved, skips) = session.save_edited(&edits).unwrap();
    assert!(
        skips
            .iter()
            .any(|s| s
                .starts_with("paragraph-format edit skipped: block 5 records a tracked change")),
        "{skips:?}"
    );
    let xml = doc_xml(&saved);
    assert!(!xml.contains("Plain paragraph."), "block 0 deleted");
    assert!(xml.contains("<w:delText>deleted</w:delText>"));
    assert!(xml.contains("<w:pPrChange w:id=\"8\""));
}

// ---------------------------------------------------------------------------
// Content controls

#[test]
fn content_controls_keep_their_content__feat__plugin_doc_read_path() {
    let doc = import_docx(&content_controls_docx()).unwrap();
    assert_eq!(
        block_texts(&doc),
        [
            "Intro.",
            "Name: Jane signed.",
            "Contents",
            "Heading one\t1",
            "Heading two\t2",
            "Heading three\t3",
            "Body after TOC.",
            "A1|In control|After control",
            "Boxed",
            "Second table",
            "R0|R1 in control|R2",
            "End.",
        ]
    );
    // Two run/block controls, the TOC, the cell's, the table's, the row's.
    assert_eq!(doc.held.content_controls, 5);
    let in_control: Vec<bool> = doc
        .body
        .iter()
        .map(|b| match b {
            Block::Paragraph(p) => p.held.in_content_control,
            Block::Table(_) => false,
        })
        .collect();
    assert_eq!(
        &in_control[..7],
        [false, false, true, true, true, true, false]
    );
    let Block::Paragraph(body_after) = &doc.body[6] else {
        panic!("a paragraph")
    };
    assert_eq!(
        body_after.source_para_ord, 2,
        "the TOC's paragraphs take no ordinal"
    );
    let Block::Table(rows) = &doc.body[10] else {
        panic!("a table")
    };
    assert!(rows.content_control_rows);

    let diags = diagnostics(&content_controls_docx());
    assert!(
        diags
            .iter()
            .any(|m| m.starts_with("5 content control(s) kept as plain content")),
        "{diags:?}"
    );
}

#[test]
fn content_controls_zero_edit_save_is_byte_identical__feat__plugin_doc_save_back() {
    let original = content_controls_docx();
    let session = DocSession::load(&original).unwrap();
    let (saved, skips) = session.save_edited(&EditSet::default()).unwrap();
    assert!(skips.is_empty(), "{skips:?}");
    assert_parts_identical(&original, &saved);
    let content = identity_content(&session.lowered());
    let (saved, skips) = session.save_edited_from_content(&content).unwrap();
    assert!(skips.is_empty(), "{skips:?}");
    assert_parts_identical(&original, &saved);
}

#[test]
fn edits_around_content_controls_land_on_the_right_nodes__feat__plugin_doc_save_back() {
    let original = content_controls_docx();
    let session = DocSession::load(&original).unwrap();
    let edits = EditSet {
        runs: vec![
            // After the TOC: the body's third direct `<w:p>`.
            RunEdit::text(6, 0, "Body edited."),
            // After the run control: the paragraph's second direct `<w:r>`.
            RunEdit::text(1, 2, " approved."),
        ],
        cells: vec![
            // The cell's own paragraph after its control.
            CellRunEdit::text(7, 1, 1, 0, "After edited"),
            // The table after the table inside a control.
            CellRunEdit::text(9, 0, 0, 0, "Second edited"),
            // A direct row after a row control.
            CellRunEdit::text(10, 2, 0, 0, "R2 edited"),
        ],
        ..Default::default()
    };
    let (saved, skips) = session.save_edited(&edits).unwrap();
    assert!(skips.is_empty(), "{skips:?}");
    let re = import_docx(&saved).unwrap();
    assert_eq!(
        block_texts(&re),
        [
            "Intro.",
            "Name: Jane approved.",
            "Contents",
            "Heading one\t1",
            "Heading two\t2",
            "Heading three\t3",
            "Body edited.",
            "A1|In control|After edited",
            "Boxed",
            "Second edited",
            "R0|R1 in control|R2 edited",
            "End.",
        ]
    );
    let xml = doc_xml(&saved);
    assert_eq!(xml.matches("<w:sdt>").count(), 5, "every control kept");
}

#[test]
fn edits_inside_content_controls_are_refused__feat__plugin_doc_save_back() {
    let original = content_controls_docx();
    let session = DocSession::load(&original).unwrap();
    let edits = EditSet {
        runs: vec![
            RunEdit::text(1, 1, "John"),
            RunEdit::text(3, 0, "Chapter one"),
        ],
        cells: vec![CellRunEdit::text(7, 1, 0, 0, "Edited control")],
        structural: vec![
            StructuralEdit::DeleteParagraph { block: 4 },
            StructuralEdit::DeleteRow { block: 10, row: 0 },
            StructuralEdit::InsertParagraph {
                block: 5,
                text: "New entry".into(),
                props: Default::default(),
                para_style: None,
                rstyle: None,
            },
        ],
        ..Default::default()
    };
    let (saved, skips) = session.save_edited(&edits).unwrap();
    assert_eq!(doc_xml(&saved), doc_xml(&original), "nothing written");
    for want in [
        "run edit skipped: block 1 run 1 is inside a content control",
        "run edit skipped: block 3 run 0 is inside a content control",
        "cell edit skipped: block 7 cell 1 para 0 run 0 is inside a content control",
        "delete-paragraph skipped: block 4 sits inside a content control",
        "delete-row skipped: table at block 10 holds rows or cells inside content controls",
        "insert-paragraph skipped: block 5 sits inside a content control",
    ] {
        assert!(skips.iter().any(|s| s == want), "{want}: {skips:?}");
    }
}

// ---------------------------------------------------------------------------
// Hidden text

#[test]
fn hidden_text_is_not_shown__feat__plugin_doc_read_path() {
    let doc = import_docx(&hidden_text_docx()).unwrap();
    assert_eq!(
        block_texts(&doc),
        ["Visible text.", "Shown", "Unhidden", "Other paragraph."]
    );
    assert_eq!(doc.held.hidden_runs, 2);
    let Block::Paragraph(p0) = &doc.body[0] else {
        panic!("a paragraph")
    };
    assert_eq!(
        p0.runs[1].source,
        Some(RunSource::DirectRun(2)),
        "the hidden run keeps its ordinal"
    );
    let diags = diagnostics(&hidden_text_docx());
    assert!(
        diags
            .iter()
            .any(|m| m.starts_with("2 hidden run(s) not shown")),
        "{diags:?}"
    );
}

#[test]
fn hidden_text_survives_save_back__feat__plugin_doc_save_back() {
    let original = hidden_text_docx();
    let session = DocSession::load(&original).unwrap();
    let (saved, skips) = session.save_edited(&EditSet::default()).unwrap();
    assert!(skips.is_empty(), "{skips:?}");
    assert_parts_identical(&original, &saved);
    let content = identity_content(&session.lowered());
    let (saved, _) = session.save_edited_from_content(&content).unwrap();
    assert_parts_identical(&original, &saved);

    // The run after the hidden one, and an unrelated paragraph.
    let mut content = identity_content(&session.lowered());
    content.paragraphs[0].runs[1].text = "words.".into();
    content.paragraphs[3].runs[0].text = "Changed paragraph.".into();
    let (saved, skips) = session.save_edited_from_content(&content).unwrap();
    assert!(skips.is_empty(), "{skips:?}");
    let xml = doc_xml(&saved);
    assert!(xml.contains(">secret </w:t>"), "the hidden run is kept");
    assert!(xml.contains("styled secret"));
    let re = import_docx(&saved).unwrap();
    assert_eq!(
        block_texts(&re),
        ["Visible words.", "Shown", "Unhidden", "Changed paragraph."]
    );

    // Deleting the paragraph would take the hidden run the user never saw.
    let edits = EditSet {
        structural: vec![StructuralEdit::DeleteParagraph { block: 0 }],
        ..Default::default()
    };
    let (saved, skips) = session.save_edited(&edits).unwrap();
    assert_eq!(doc_xml(&saved), doc_xml(&original));
    assert!(
        skips
            .iter()
            .any(|s| s.starts_with("delete-paragraph skipped: block 0 holds")),
        "{skips:?}"
    );
}
