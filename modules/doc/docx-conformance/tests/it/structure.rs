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

//! Doc ADRs 611 / 612 on `structure_docx()`: what the lowering places —
//! the section masters and their parts, the notes at their references, the
//! live fields, the bookmarks and the table of contents.

#![allow(non_snake_case)] // `…__feat__<id>` test names link the cockpit feature

use docx_conformance::{structure_docx, STRUCTURE_NOTES};
use docx_import::import_docx;
use docx_lower::ir::{LoweredBlock, LoweredDoc, LoweredParagraph};

fn lowered() -> LoweredDoc {
    docx_lower::lower(&import_docx(&structure_docx()).unwrap())
}

fn paragraphs(ir: &LoweredDoc) -> Vec<&LoweredParagraph> {
    ir.story
        .blocks
        .iter()
        .filter_map(|b| match b {
            LoweredBlock::Paragraph(p) => Some(p),
            _ => None,
        })
        .collect()
}

fn text(p: &LoweredParagraph) -> String {
    p.runs.iter().map(|r| r.text.as_str()).collect()
}

/// The parts' text without their fields.
fn part_text(ir: &LoweredDoc, part: usize) -> String {
    ir.header_footer_parts[part].paragraphs[0]
        .runs
        .iter()
        .filter(|r| r.field.is_none())
        .map(|r| r.text.as_str())
        .collect()
}

#[test]
fn each_section_takes_masters_with_its_own_or_its_linked_parts__feat__doc_word_headers_footers() {
    let ir = lowered();
    let s: Vec<_> = ir
        .sections
        .iter()
        .map(|s| s.masters.clone().unwrap())
        .collect();
    let master = |id: &Option<String>| {
        ir.masters
            .iter()
            .find(|m| Some(&m.id) == id.as_ref())
            .unwrap()
    };
    let header = |id: &Option<String>| master(id).header.as_ref().map(|f| part_text(&ir, f.part));
    let footer = |id: &Option<String>| master(id).footer.as_ref().map(|f| part_text(&ir, f.part));
    // S1: a different first page with its own header and no footer.
    assert_eq!(
        header(&s[0].first_master).as_deref(),
        Some("Title page header")
    );
    assert_eq!(footer(&s[0].first_master), None);
    assert_eq!(header(&s[0].master).as_deref(), Some("Report header"));
    assert_eq!(footer(&s[0].master).as_deref(), Some("Page  of "));
    // S2: its own header, S1's footer (linked to previous).
    assert_eq!(s[1].first_master, None);
    assert_eq!(header(&s[1].master).as_deref(), Some("Section two header"));
    assert_eq!(footer(&s[1].master).as_deref(), Some("Page  of "));
    assert_eq!(
        master(&s[0].master).footer.as_ref().unwrap().part,
        master(&s[1].master).footer.as_ref().unwrap().part,
        "one footer part, shown by both"
    );
    // The footer's fields are live.
    let codes: Vec<&str> =
        ir.header_footer_parts[master(&s[0].master).footer.as_ref().unwrap().part].paragraphs[0]
            .runs
            .iter()
            .filter_map(|r| r.field.as_ref().map(|f| f.code.as_str()))
            .collect();
    assert_eq!(codes, ["PAGE", "NUMPAGES"]);
    // Next-page sections need no section start; S2 restarts at 1.
    assert_eq!(ir.sections[1].section_start, None);
    assert_eq!(
        ir.sections[1]
            .header_footer
            .as_ref()
            .unwrap()
            .page_number_start,
        Some(1)
    );
}

#[test]
fn notes_are_placed_at_their_references_with_their_text__feat__doc_word_footnotes() {
    let ir = lowered();
    let refs: Vec<(i64, bool)> = paragraphs(&ir)
        .iter()
        .flat_map(|p| p.runs.iter())
        .filter_map(|r| r.note.map(|n| (n.id, n.endnote)))
        .collect();
    assert_eq!(refs, [(1, false), (1, true), (2, false)]);
    let notes: Vec<(bool, i64, &str)> = ir
        .notes
        .iter()
        .map(|n| (n.endnote, n.id, n.text.as_str()))
        .collect();
    let mut want = STRUCTURE_NOTES.to_vec();
    want.sort_by_key(|(e, id, _)| (*e, *id));
    let mut got = notes.clone();
    got.sort_by_key(|(e, id, _)| (*e, *id));
    assert_eq!(
        got, want,
        "Word's leading space after the mark is not the engine's"
    );
    // The reference reads as the engine's marker in its paragraph.
    let p = paragraphs(&ir)
        .into_iter()
        .find(|p| text(p).starts_with("Body text"))
        .unwrap();
    assert_eq!(text(p), "Body text with a note\u{E01C}.");
    // Note paragraphs keep their Word style.
    assert!(ir.notes[0].paragraphs[0]
        .para_style_id
        .as_deref()
        .is_some_and(|s| s.contains("FootnoteText") || s.contains("docx-auto")));
}

#[test]
fn fields_are_kept_live_with_their_results__feat__doc_word_fields() {
    let ir = lowered();
    let fields: Vec<(String, String)> = paragraphs(&ir)
        .iter()
        .flat_map(|p| p.runs.iter())
        .filter_map(|r| r.field.as_ref().map(|f| (f.code.clone(), r.text.clone())))
        .collect();
    assert_eq!(
        fields,
        [
            ("PAGEREF _Toc1 \\h".into(), "2".into()),
            ("PAGEREF _Toc2 \\h".into(), "2".into()),
            ("PAGEREF _Toc3 \\h".into(), "1".into()),
            ("REF _Toc2 \\h".into(), "Background".into()),
            ("PAGEREF _Toc2 \\h".into(), "2".into()),
            ("SEQ Figure \\* ARABIC".into(), "1".into()),
        ]
    );
    // The bookmarks they point at start their headings.
    let marks: Vec<&str> = paragraphs(&ir)
        .iter()
        .flat_map(|p| p.bookmarks.iter().map(String::as_str))
        .collect();
    assert_eq!(marks, ["_Toc1", "_Toc2", "_Toc3"]);
    assert!(ir
        .diagnostics
        .iter()
        .any(|d| d.message.contains("live Word fields")));
}

#[test]
fn the_table_of_contents_keeps_words_entries__feat__doc_word_toc() {
    let ir = lowered();
    assert_eq!(ir.tocs.len(), 1);
    let toc = &ir.tocs[0];
    assert_eq!(toc.instruction, r#"TOC \o "1-2" \h \z \u"#);
    assert_eq!(toc.levels, (1, 2));
    assert_eq!((toc.first_block, toc.end_block), (1, 4));
    let entries: Vec<String> = ir.story.blocks[toc.first_block..toc.end_block]
        .iter()
        .map(|b| match b {
            LoweredBlock::Paragraph(p) => text(p),
            _ => unreachable!(),
        })
        .collect();
    assert_eq!(entries, ["Introduction\t2", "Background\t2", "Results\t1"]);
}

/// The bundle's headless tests open `structure.docx`: it is this builder's
/// output (`WRITE_FIXTURES=1` writes it again).
#[test]
fn the_bundle_fixture_is_the_structure_builder__feat__doc_word_headers_footers() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../packages/doc-bundle/test/fixtures/structure.docx"
    );
    let built = structure_docx();
    if std::env::var("WRITE_FIXTURES").as_deref() == Ok("1") {
        std::fs::write(path, &built).unwrap();
    }
    let committed = std::fs::read(path).unwrap();
    let a = paged_ooxml::OpcPackage::read(&built).unwrap();
    let b = paged_ooxml::OpcPackage::read(&committed).unwrap();
    for name in a.file_names() {
        assert_eq!(a.part(name), b.part(name), "{name}");
    }
}

/// Word's answer for `structure_docx()` (`scripts/word-structure-probe.sh`,
/// Word 16 for Mac, 2026-10-28): three pages — S1's title page (its TOC),
/// S1's second page (the page break), S2's page restarting at 1 — and per
/// page the header and footer the lowering's masters print there, the
/// footer's PAGE and NUMPAGES with Word's numbers, and every footnote on
/// the page of its reference.
#[test]
fn the_masters_and_notes_print_where_word_prints_them__feat__doc_word_headers_footers() {
    let word: serde_json::Value =
        serde_json::from_str(include_str!("../../fixtures/structure.word.json")).unwrap();
    let pages = word["pages"].as_array().unwrap();
    assert_eq!(pages.len(), 3);
    let ir = lowered();
    let total = pages.len();
    // Word's pages: (section, first page of its section, page number).
    let layout = [(0usize, true, 1), (0, false, 2), (1, true, 1)];
    for ((k, first, number), w) in layout.iter().zip(pages) {
        let m = ir.sections[*k].masters.clone().unwrap();
        let id = if *first && m.first_master.is_some() {
            m.first_master
        } else {
            m.master
        }
        .unwrap();
        let master = ir.masters.iter().find(|x| x.id == id).unwrap();
        let print = |f: Option<&docx_lower::ir::LoweredMasterFrame>| {
            f.map(|f| {
                ir.header_footer_parts[f.part].paragraphs[0]
                    .runs
                    .iter()
                    .map(|r| match r.field.as_ref().map(|x| x.code.as_str()) {
                        Some("PAGE") => number.to_string(),
                        Some("NUMPAGES") => total.to_string(),
                        _ => r.text.clone(),
                    })
                    .collect::<String>()
            })
            .unwrap_or_default()
        };
        assert_eq!(print(master.header.as_ref()), w["header"].as_str().unwrap());
        assert_eq!(print(master.footer.as_ref()), w["footer"].as_str().unwrap());
    }
    // Each footnote's text is on the page of its reference.
    for (note, page) in [("First note text.", 1), ("Second note text.", 2)] {
        assert!(
            pages[page]["body"].as_str().unwrap().contains(note),
            "{note} on page {}",
            page + 1
        );
        assert!(ir.notes.iter().any(|n| n.text == note));
    }
    // Word puts the endnote after the document's last text, numbered in
    // lower roman (its default); the engine's endnote story is a page of
    // its own after the last, numbered 1 (doc ADR 611 residual).
    assert!(pages[2]["body"].as_str().unwrap().contains("An endnote. i"));
}
