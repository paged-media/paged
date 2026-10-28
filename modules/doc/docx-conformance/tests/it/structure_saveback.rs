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

//! Save-back of Word's document structure (doc ADRs 610–612): header and
//! footer edits spliced into their parts, note text edits, notes added and
//! removed on the canvas, field results, and fields and bookmarks added on
//! the canvas — each with every other part byte for byte as it was.

#![allow(non_snake_case)] // `…__feat__<id>` test names link the cockpit feature

use docx_conformance::{footnote_docx, header_field_docx, headers_docx, structure_docx};
use docx_core::Block;
use docx_export::structure::{AnchorIn, HeaderContentIn, NoteTextIn, StructureIn};
use docx_export::{ParagraphContentIn, RunContentIn, StoryContentIn, TableParagraphs};
use docx_import::import_docx;
use docx_js::DocSession;
use docx_lower::ir::{LoweredBlock, LoweredDoc, LoweredParagraph};
use paged_ooxml::OpcPackage;

fn part(bytes: &[u8], name: &str) -> Option<String> {
    OpcPackage::read(bytes)
        .unwrap()
        .part(name)
        .map(|b| String::from_utf8_lossy(b).into_owned())
}

fn paragraph_content(p: &LoweredParagraph) -> ParagraphContentIn {
    ParagraphContentIn {
        paragraph_style: p.para_style_id.clone(),
        runs: p
            .runs
            .iter()
            .map(|r| RunContentIn {
                text: r.text.clone(),
                character_style: r.char_style_id.clone(),
                field_code: r.field.as_ref().map(|f| f.code.clone()),
                ..Default::default()
            })
            .collect(),
    }
}

/// The body as the canvas reads it back unedited: markers and fields in.
fn body(base: &LoweredDoc) -> StoryContentIn {
    StoryContentIn {
        self_id: "docx_s0".into(),
        paragraphs: base
            .story
            .blocks
            .iter()
            .filter_map(|b| match b {
                LoweredBlock::Paragraph(p) => Some(paragraph_content(p)),
                LoweredBlock::Table(_) => None,
            })
            .collect(),
    }
}

/// Every master story read back unedited.
fn headers(base: &LoweredDoc) -> Vec<HeaderContentIn> {
    base.masters
        .iter()
        .flat_map(|m| [&m.header, &m.footer])
        .flatten()
        .map(|f| HeaderContentIn {
            part: f.part,
            content: StoryContentIn {
                self_id: f.story_id.clone(),
                paragraphs: base.header_footer_parts[f.part]
                    .paragraphs
                    .iter()
                    .map(paragraph_content)
                    .collect(),
            },
        })
        .collect()
}

/// The engine's notes unedited, per kind, in reference order.
fn notes(base: &LoweredDoc, endnote: bool) -> Vec<NoteTextIn> {
    base.story
        .blocks
        .iter()
        .filter_map(|b| match b {
            LoweredBlock::Paragraph(p) => Some(p),
            LoweredBlock::Table(_) => None,
        })
        .flat_map(|p| p.runs.iter())
        .filter_map(|r| r.note.filter(|n| n.endnote == endnote))
        .map(|n| NoteTextIn {
            text: base
                .notes
                .iter()
                .find(|x| x.id == n.id && x.endnote == endnote)
                .unwrap()
                .text
                .clone(),
        })
        .collect()
}

fn unedited(base: &LoweredDoc) -> StructureIn {
    StructureIn {
        headers: headers(base),
        footnotes: notes(base, false),
        endnotes: notes(base, true),
        anchors: Vec::new(),
    }
}

fn save(session: &DocSession, content: &StoryContentIn, s: &StructureIn) -> (Vec<u8>, Vec<String>) {
    session
        .save_edited_structure(
            content,
            &[],
            &[],
            &Default::default(),
            &[],
            TableParagraphs::Joined,
            s,
        )
        .unwrap()
}

fn assert_identical_except(original: &[u8], saved: &[u8], changed: &[&str]) {
    let a = OpcPackage::read(original).unwrap();
    let b = OpcPackage::read(saved).unwrap();
    for name in a.file_names() {
        if changed.contains(&name) {
            continue;
        }
        assert_eq!(a.part(name), b.part(name), "{name} changed");
    }
}

#[test]
fn an_unedited_structured_document_saves_every_part_byte_identical__feat__doc_word_headers_footers()
{
    for original in [
        structure_docx(),
        headers_docx(),
        footnote_docx(),
        header_field_docx(),
    ] {
        let session = DocSession::load(&original).unwrap();
        let base = session.lowered();
        let (saved, skips) = save(&session, &body(&base), &unedited(&base));
        assert!(skips.is_empty(), "{skips:?}");
        assert_identical_except(&original, &saved, &[]);
    }
}

#[test]
fn a_header_edit_is_spliced_into_its_part_only__feat__doc_word_headers_footers() {
    let original = header_field_docx();
    let session = DocSession::load(&original).unwrap();
    let base = session.lowered();
    let mut s = unedited(&base);
    let h = s
        .headers
        .iter_mut()
        .find(|h| !base.header_footer_parts[h.part].footer)
        .unwrap();
    h.content.paragraphs[0].runs[0].text = "Annual Report".into();
    let (saved, skips) = save(&session, &body(&base), &s);
    assert!(skips.is_empty(), "{skips:?}");
    let hdr = part(&saved, "word/header1.xml").unwrap();
    assert!(hdr.contains(">Annual Report</w:t>"), "{hdr}");
    assert_identical_except(&original, &saved, &["word/header1.xml"]);
    // Word reads it back.
    let doc = import_docx(&saved).unwrap();
    let header = doc.headers_footers.iter().find(|h| !h.footer).unwrap();
    assert_eq!(header.paragraphs[0].runs[0].text, "Annual Report");
}

#[test]
fn of_two_masters_showing_one_part_the_edited_one_is_saved__feat__doc_word_headers_footers() {
    let original = headers_docx();
    let session = DocSession::load(&original).unwrap();
    let base = session.lowered();
    let mut s = unedited(&base);
    // The part shown by more than one master story: edit its LAST copy.
    let shared = (0..base.header_footer_parts.len())
        .find(|i| s.headers.iter().filter(|h| h.part == *i).count() > 1)
        .expect("a part on two masters");
    let name = base.header_footer_parts[shared].part.clone();
    let last = s.headers.iter_mut().rfind(|h| h.part == shared).unwrap();
    let run = &mut last.content.paragraphs[0].runs[0];
    run.text = format!("X{}", run.text);
    let (saved, skips) = save(&session, &body(&base), &s);
    assert!(skips.is_empty(), "{skips:?}");
    assert!(part(&saved, &name).unwrap().contains(">X"), "{name}");
    assert_identical_except(&original, &saved, &[&name]);
}

#[test]
fn a_note_text_edit_is_spliced_into_the_notes_part__feat__doc_word_footnotes() {
    let original = footnote_docx();
    let session = DocSession::load(&original).unwrap();
    let base = session.lowered();
    let mut s = unedited(&base);
    assert_eq!(s.footnotes[0].text, "The note body.");
    s.footnotes[0].text = "The edited note.".into();
    let (saved, skips) = save(&session, &body(&base), &s);
    assert!(skips.is_empty(), "{skips:?}");
    let notes = part(&saved, "word/footnotes.xml").unwrap();
    assert!(notes.contains("The edited note."), "{notes}");
    assert_identical_except(&original, &saved, &["word/footnotes.xml"]);
    let doc = import_docx(&saved).unwrap();
    assert_eq!(doc.notes[0].paragraphs[0].runs[0].text, "The edited note.");
}

#[test]
fn a_note_added_on_the_canvas_makes_its_part_and_reference__feat__doc_word_footnotes() {
    // A document without notes.
    let original = header_field_docx();
    let session = DocSession::load(&original).unwrap();
    let base = session.lowered();
    let mut content = body(&base);
    // The canvas put a footnote after "Printed" ("Printed on " is run 0).
    let r0 = &mut content.paragraphs[0].runs[0];
    assert_eq!(r0.text, "Printed on ");
    r0.text = "Printed\u{E01C} on ".into();
    let mut s = unedited(&base);
    s.footnotes = vec![NoteTextIn {
        text: "A new note.".into(),
    }];
    let (saved, skips) = save(&session, &content, &s);
    assert!(skips.is_empty(), "{skips:?}");
    let notes = part(&saved, "word/footnotes.xml").expect("the footnotes part");
    assert!(notes.contains(r#"w:type="separator" w:id="-1""#), "{notes}");
    assert!(notes.contains(r#"<w:footnote w:id="1">"#), "{notes}");
    let rels = part(&saved, "word/_rels/document.xml.rels").unwrap();
    assert!(
        rels.contains("relationships/footnotes\" Target=\"footnotes.xml\""),
        "{rels}"
    );
    let types = part(&saved, "[Content_Types].xml").unwrap();
    assert!(
        types.contains("PartName=\"/word/footnotes.xml\""),
        "{types}"
    );
    let xml = part(&saved, "word/document.xml").unwrap();
    assert!(
        xml.contains(r#"Printed</w:t></w:r><w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:footnoteReference w:id="1"/></w:r><w:r><w:t xml:space="preserve"> on </w:t></w:r>"#),
        "{xml}"
    );
    // Word's reader takes it: the note and its reference.
    let doc = import_docx(&saved).unwrap();
    assert_eq!(doc.notes.len(), 1);
    assert_eq!(doc.notes[0].id, 1);
    let texts: String = doc.notes[0].paragraphs[0]
        .runs
        .iter()
        .map(|r| r.text.as_str())
        .collect();
    assert_eq!(texts, " A new note.");
    let Block::Paragraph(p) = &doc.body[0] else {
        panic!()
    };
    assert!(p.runs.iter().any(|r| r.note_ref == Some(1)));
    // The text around it is unchanged.
    let text: String = p.runs.iter().map(|r| r.text.as_str()).collect();
    assert_eq!(text, "Printed on 23 July 2026, page 7.");
}

#[test]
fn a_note_removed_on_the_canvas_leaves_with_its_reference__feat__doc_word_footnotes() {
    let original = footnote_docx();
    let session = DocSession::load(&original).unwrap();
    let base = session.lowered();
    let mut content = body(&base);
    content.paragraphs[0]
        .runs
        .retain(|r| !r.text.contains('\u{E01C}'));
    let mut s = unedited(&base);
    s.footnotes.clear();
    let (saved, skips) = save(&session, &content, &s);
    assert!(skips.is_empty(), "{skips:?}");
    let xml = part(&saved, "word/document.xml").unwrap();
    assert!(!xml.contains("footnoteReference"), "{xml}");
    let notes = part(&saved, "word/footnotes.xml").unwrap();
    assert!(!notes.contains("The note body."), "{notes}");
    assert!(notes.contains("separator"), "the separators stay: {notes}");
}

#[test]
fn an_updated_field_result_is_written_into_its_result_run__feat__doc_word_fields() {
    let original = header_field_docx();
    let session = DocSession::load(&original).unwrap();
    let base = session.lowered();
    let mut content = body(&base);
    let page = content.paragraphs[0]
        .runs
        .iter_mut()
        .find(|r| {
            r.field_code
                .as_deref()
                .is_some_and(|c| c.starts_with("PAGE"))
        })
        .expect("the PAGE field run");
    page.text = "1".into();
    let (saved, skips) = save(&session, &content, &unedited(&base));
    assert!(skips.is_empty(), "{skips:?}");
    let xml = part(&saved, "word/document.xml").unwrap();
    assert!(
        xml.contains(
            r#"<w:fldChar w:fldCharType="separate"/></w:r>
      <w:r><w:t xml:space="preserve">1</w:t></w:r>"#
        ),
        "{xml}"
    );
    assert!(
        xml.contains("PAGE  \\* MERGEFORMAT"),
        "the code stays: {xml}"
    );
    assert_identical_except(&original, &saved, &["word/document.xml"]);
}

#[test]
fn a_field_and_a_bookmark_added_on_the_canvas_are_written_as_words__feat__doc_word_fields() {
    let original = footnote_docx();
    let session = DocSession::load(&original).unwrap();
    let base = session.lowered();
    let mut content = body(&base);
    // "Body with a note" + marker + " and more." — a NUMPAGES field after
    // "Body", and a bookmark before "note".
    let runs = &mut content.paragraphs[0].runs;
    assert_eq!(runs[0].text, "Body with a note");
    runs[0].text = "Body".into();
    runs.insert(
        1,
        RunContentIn {
            text: "4".into(),
            field_code: Some("NUMPAGES".into()),
            ..Default::default()
        },
    );
    runs.insert(
        2,
        RunContentIn {
            text: " with a note".into(),
            ..Default::default()
        },
    );
    let mut s = unedited(&base);
    s.anchors = vec![AnchorIn {
        name: "_Ref1".into(),
        paragraph: 0,
        // "Body" "4" " with a " → offset 13 in the read-back paragraph.
        offset: 13,
    }];
    let (saved, skips) = save(&session, &content, &s);
    assert!(skips.is_empty(), "{skips:?}");
    let xml = part(&saved, "word/document.xml").unwrap();
    assert!(
        xml.contains(r#"<w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> NUMPAGES </w:instrText></w:r>"#),
        "{xml}"
    );
    assert!(
        xml.contains(r#"<w:bookmarkStart w:id="1" w:name="_Ref1"/><w:bookmarkEnd w:id="1"/>"#),
        "{xml}"
    );
    assert_identical_except(&original, &saved, &["word/document.xml"]);
    // Word's reader takes both.
    let doc = import_docx(&saved).unwrap();
    let Block::Paragraph(p) = &doc.body[0] else {
        panic!()
    };
    let field = p
        .runs
        .iter()
        .find(|r| r.field.as_deref() == Some("NUMPAGES"))
        .unwrap();
    assert_eq!(field.text, "4");
    assert_eq!(p.bookmarks, ["_Ref1"]);
    let text: String = p.runs.iter().map(|r| r.text.as_str()).collect();
    assert_eq!(text, "Body4 with a note and more.");
}

#[test]
fn footnote_and_endnote_edits_go_into_their_own_parts__feat__doc_word_footnotes() {
    let original = structure_docx();
    let session = DocSession::load(&original).unwrap();
    let base = session.lowered();
    let mut s = unedited(&base);
    assert!(!s.footnotes.is_empty() && !s.endnotes.is_empty());
    s.footnotes[0].text = format!("{} Edited.", s.footnotes[0].text);
    s.endnotes[0].text = format!("{} Also.", s.endnotes[0].text);
    let (saved, skips) = save(&session, &body(&base), &s);
    assert!(skips.is_empty(), "{skips:?}");
    assert!(part(&saved, "word/footnotes.xml")
        .unwrap()
        .contains(" Edited."));
    assert!(part(&saved, "word/endnotes.xml")
        .unwrap()
        .contains(" Also."));
    assert_identical_except(
        &original,
        &saved,
        &["word/footnotes.xml", "word/endnotes.xml"],
    );
    let doc = import_docx(&saved).unwrap();
    let edited = docx_lower::lower(&doc);
    assert_eq!(
        edited.notes.iter().find(|n| !n.endnote).unwrap().text,
        s.footnotes[0].text
    );
    assert_eq!(
        edited.notes.iter().find(|n| n.endnote).unwrap().text,
        s.endnotes[0].text
    );
}
