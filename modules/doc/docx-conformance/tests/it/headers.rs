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

//! Every section's headers and footers (`headers_docx()`, thoughts ADR 033,
//! RFI DOC-05), against Word's answer (`fixtures/headers.word.json`,
//! `scripts/word-headers-probe.sh`): which header and footer each page
//! shows, with Word's inheritance between sections.

#![allow(non_snake_case)] // `…__feat__<id>` test names link the cockpit feature

use docx_conformance::{headers_docx, zip_parts};
use docx_core::{DocxDocument, HeaderFooterKind};
use docx_import::import_docx;
use docx_js::DocSession;
use paged_ooxml::OpcPackage;
use serde_json::Value;

fn word() -> Value {
    serde_json::from_str(include_str!("../../fixtures/headers.word.json"))
        .expect("headers.word.json")
}

/// `headers_docx()` without `w:evenAndOddHeaders`, as the probe makes it.
fn headers_no_even_docx() -> Vec<u8> {
    let pkg = OpcPackage::read(&headers_docx()).unwrap();
    let names: Vec<String> = pkg.file_names().map(str::to_string).collect();
    let parts: Vec<(String, Vec<u8>)> = names
        .iter()
        .map(|n| {
            let mut b = pkg.part(n).unwrap().to_vec();
            if n == "word/settings.xml" {
                b = String::from_utf8(b)
                    .unwrap()
                    .replace("<w:evenAndOddHeaders/>", "")
                    .into_bytes();
            }
            (n.clone(), b)
        })
        .collect();
    let refs: Vec<(&str, &[u8])> = parts
        .iter()
        .map(|(n, b)| (n.as_str(), b.as_slice()))
        .collect();
    zip_parts(&refs)
}

/// Every section of the fixture is three pages.
const PAGES_PER_SECTION: i32 = 3;

/// One page as the model predicts it: (header, footer, body), each the
/// header/footer's text before its PAGE field plus the page number Word
/// prints, or "" for a blank one; `None` for a blank page Word inserts.
fn predicted(doc: &DocxDocument) -> Vec<Option<(String, String, String)>> {
    let label = |section: usize, footer: bool, first: bool, number: i32| {
        doc.header_footer_for(section, footer, first, number)
            .map(|h| {
                let text: String = h.paragraphs[0]
                    .runs
                    .iter()
                    .filter(|r| r.field.is_none())
                    .map(|r| r.text.as_str())
                    .collect();
                format!("{text}{number}")
            })
            .unwrap_or_default()
    };
    let mut pages = Vec::new();
    let mut number = 0;
    for (k, s) in doc.sections.iter().enumerate() {
        let first = s.page_number_start.unwrap_or(number + 1);
        // Word's blank page: with even/odd headers, a section whose first
        // number has the parity of the page before it (two odd pages in a
        // row) gets a blank page in between (fixtures/headers.word.json).
        if k > 0 && doc.even_and_odd_headers && first % 2 == number % 2 {
            pages.push(None);
        }
        for p in 0..PAGES_PER_SECTION {
            number = first + p;
            pages.push(Some((
                label(k, false, p == 0, number),
                label(k, true, p == 0, number),
                format!("S{} page {}", k + 1, p + 1),
            )));
        }
    }
    pages
}

fn assert_matches_word(doc: &DocxDocument, key: &str) {
    let word = word();
    let pages = word[key].as_array().unwrap();
    let ours = predicted(doc);
    assert_eq!(ours.len(), pages.len(), "{key}: page count");
    for (i, (ours, w)) in ours.iter().zip(pages).enumerate() {
        let text = |band: &str| w[band].as_str().unwrap().to_string();
        match ours {
            None => assert_eq!(
                (text("header"), text("body"), text("footer")),
                (String::new(), String::new(), String::new()),
                "{key} page {}: Word's blank page",
                i + 1
            ),
            Some((h, f, b)) => {
                assert_eq!(&text("body"), b, "{key} page {}: body", i + 1);
                assert_eq!(&text("header"), h, "{key} page {}: header", i + 1);
                assert_eq!(&text("footer"), f, "{key} page {}: footer", i + 1);
            }
        }
    }
}

#[test]
fn every_sections_header_references_are_read_with_words_inheritance__feat__plugin_doc_read_path() {
    let doc = import_docx(&headers_docx()).unwrap();
    assert!(doc.even_and_odd_headers);
    assert_eq!(doc.sections.len(), 3);
    // Five parts, each read once, with the section that first names it.
    assert_eq!(doc.headers_footers.len(), 5);
    let part = |k: usize, footer: bool, kind: HeaderFooterKind| {
        let s = &doc.sections[k];
        let set = if footer { &s.footers } else { &s.headers };
        set.get(kind)
            .map(|r| (doc.headers_footers[r.index].part.as_str(), r.inherited))
    };
    use HeaderFooterKind::{Default, Even, First};
    assert_eq!(part(0, false, First), Some(("word/header2.xml", false)));
    assert_eq!(part(0, true, First), None, "S1 names no first footer");
    // S2 names nothing: everything is S1's.
    assert_eq!(part(1, false, Default), Some(("word/header1.xml", true)));
    assert_eq!(part(1, false, Even), Some(("word/header3.xml", true)));
    assert_eq!(part(1, true, Default), Some(("word/footer1.xml", true)));
    // S3 names its own default header only.
    assert_eq!(part(2, false, Default), Some(("word/header4.xml", false)));
    assert_eq!(part(2, false, First), Some(("word/header2.xml", true)));
    assert_eq!(part(2, true, Default), Some(("word/footer1.xml", true)));
    let s = &doc.sections;
    assert_eq!(
        (s[0].title_page, s[1].title_page, s[2].title_page),
        (true, false, true),
        "titlePg is per section"
    );
    assert_eq!(s[1].page_number_start, Some(1));
    assert_eq!(
        (s[0].header_distance, s[0].footer_distance),
        (Some(360), Some(360))
    );
}

#[test]
fn the_header_and_footer_of_every_page_are_words__feat__plugin_doc_read_path() {
    assert_matches_word(&import_docx(&headers_docx()).unwrap(), "even_and_odd");
    let no_even = import_docx(&headers_no_even_docx()).unwrap();
    assert!(!no_even.even_and_odd_headers);
    assert_matches_word(&no_even, "no_even_and_odd");
}

#[test]
fn headers_are_carried_per_section_and_honestly_diagnosed__feat__plugin_doc_read_path() {
    let ir = docx_lower::lower(&import_docx(&headers_docx()).unwrap());
    assert!(ir.even_and_odd_headers);
    let hf: Vec<_> = ir
        .sections
        .iter()
        .map(|s| s.header_footer.clone().expect("every section has headers"))
        .collect();
    assert_eq!(hf[0].header.first.as_deref(), Some("word/header2.xml"));
    assert_eq!(hf[1].header.even.as_deref(), Some("word/header3.xml"));
    assert_eq!(hf[2].header.default.as_deref(), Some("word/header4.xml"));
    assert_eq!(hf[2].footer.first, None);
    assert!(hf[0].title_page && !hf[1].title_page);
    assert_eq!(hf[0].header_distance_pt, Some(18.0));
    assert_eq!(hf[1].page_number_start, Some(1));

    let msgs: Vec<&str> = ir.diagnostics.iter().map(|d| d.message.as_str()).collect();
    let msg = msgs
        .iter()
        .find(|m| m.contains("header(s)"))
        .expect("a header diagnostic");
    assert!(
        msg.contains("4 header(s) + 1 footer(s) across 3 section(s)"),
        "{msg}"
    );
    assert!(msg.contains("placed on section masters"), "{msg}");
    assert!(msg.contains("inherited from an earlier section"), "{msg}");
    let blank = msgs
        .iter()
        .find(|m| m.contains("blank page"))
        .expect("the blank-page diagnostic");
    assert!(blank.contains("section 2"), "{blank}");
    // Never faked into the body.
    let flow: String = ir
        .story
        .paragraphs()
        .iter()
        .flat_map(|p| p.runs.iter())
        .map(|r| r.text.as_str())
        .collect();
    assert!(!flow.contains("H1-"), "{flow}");
}

#[test]
fn a_body_edit_leaves_every_header_footer_and_settings_part_byte_identical__feat__plugin_doc_save_back(
) {
    use docx_export::{ParagraphContentIn, RunContentIn, StoryContentIn};
    let original = headers_docx();
    let session = DocSession::load(&original).unwrap();
    let base = session.lowered();
    let mut content = StoryContentIn {
        comments: Vec::new(),
        self_id: "Story/doc".into(),
        paragraphs: base
            .story
            .paragraphs()
            .iter()
            .map(|p| ParagraphContentIn {
                mark_change: None,
                props_change: None,
                paragraph_style: p.para_style_id.clone(),
                runs: p
                    .runs
                    .iter()
                    .map(|r| RunContentIn {
                        text: r.text.clone(),
                        character_style: r.char_style_id.clone(),
                        ..Default::default()
                    })
                    .collect(),
            })
            .collect(),
    };
    // Zero edits first: every part byte-identical.
    let orig = OpcPackage::read(&original).unwrap();
    let (saved, _) = session.save_edited_from_content(&content).unwrap();
    let saved = OpcPackage::read(&saved).unwrap();
    for name in orig.file_names() {
        assert_eq!(orig.part(name), saved.part(name), "zero edit: part {name}");
    }
    // Then one body edit: only document.xml changes.
    content.paragraphs[0].runs[0].text = "S1 page one".into();
    let (saved, skips) = session.save_edited_from_content(&content).unwrap();
    assert!(skips.is_empty(), "{skips:?}");
    let saved = OpcPackage::read(&saved).unwrap();
    for name in orig.file_names() {
        if name == "word/document.xml" {
            assert_ne!(orig.part(name), saved.part(name));
        } else {
            assert_eq!(orig.part(name), saved.part(name), "edited: part {name}");
        }
    }
    let reopened = import_docx(&OpcPackage::write(&saved).unwrap()).unwrap();
    assert_eq!(reopened.headers_footers.len(), 5);
    assert_eq!(
        reopened.sections[2].headers,
        import_docx(&original).unwrap().sections[2].headers
    );
}

/// Doc ADR 611: the masters the lowering plans, picked per page as the
/// engine's grow rule picks them (engine ADR 1022: the section's first page
/// takes the first master, a page whose number is even the even master,
/// every other page the master), print Word's header and footer on every
/// page of both documents. The header and footer text is read from the
/// lowered parts the masters' stories are poured with; the PAGE field is a
/// live field there, so it prints the page's number.
fn assert_masters_match_word(bytes: &[u8], key: &str) {
    let doc = import_docx(bytes).unwrap();
    let ir = docx_lower::lower(&doc);
    let word = word();
    let pages: Vec<&Value> = word[key]
        .as_array()
        .unwrap()
        .iter()
        .filter(|p| !p["body"].as_str().unwrap().is_empty())
        .collect();
    let text = |part: Option<usize>, number: i32| {
        part.map(|i| {
            let p = &ir.header_footer_parts[i].paragraphs[0];
            let fixed: String = p
                .runs
                .iter()
                .filter(|r| r.field.is_none())
                .map(|r| r.text.as_str())
                .collect();
            assert!(
                p.runs
                    .iter()
                    .any(|r| r.field.as_ref().is_some_and(|f| f.code.starts_with("PAGE"))),
                "the page number is a live PAGE field"
            );
            format!("{fixed}{number}")
        })
        .unwrap_or_default()
    };
    let mut page = 0usize;
    let mut number = 0;
    for (k, s) in doc.sections.iter().enumerate() {
        let masters = ir.sections[k]
            .masters
            .clone()
            .expect("a story-opening section");
        let first = s.page_number_start.unwrap_or(number + 1);
        for p in 0..PAGES_PER_SECTION {
            number = first + p;
            let id = if p == 0 && masters.first_master.is_some() {
                masters.first_master.clone()
            } else if number % 2 == 0 && masters.even_master.is_some() {
                masters.even_master.clone()
            } else {
                masters.master.clone()
            }
            .unwrap();
            let m = ir.masters.iter().find(|m| m.id == id).unwrap();
            let w = pages[page];
            assert_eq!(
                text(m.header.as_ref().map(|f| f.part), number),
                w["header"].as_str().unwrap(),
                "{key} page {}: header ({id})",
                page + 1
            );
            assert_eq!(
                text(m.footer.as_ref().map(|f| f.part), number),
                w["footer"].as_str().unwrap(),
                "{key} page {}: footer ({id})",
                page + 1
            );
            page += 1;
        }
    }
    assert_eq!(page, pages.len(), "{key}: every printed page checked");
}

#[test]
fn the_section_masters_print_words_header_and_footer_on_every_page__feat__doc_word_headers_footers()
{
    assert_masters_match_word(&headers_docx(), "even_and_odd");
    assert_masters_match_word(&headers_no_even_docx(), "no_even_and_odd");
}

#[test]
fn a_section_that_links_to_the_previous_one_takes_its_masters__feat__doc_word_headers_footers() {
    let ir = docx_lower::lower(&import_docx(&headers_docx()).unwrap());
    let m: Vec<_> = ir
        .sections
        .iter()
        .map(|s| s.masters.clone().unwrap())
        .collect();
    // S2 names no header or footer: "link to previous" is S1's masters.
    assert_eq!(m[1].master, m[0].master);
    assert_eq!(m[1].even_master, m[0].even_master);
    assert_eq!(m[1].first_master, None, "S2 has no different first page");
    // S3 has its own default header, so its own default and even masters,
    // and S1's first page header again (inherited) on a first master that
    // shows it with S3's own footer.
    assert_ne!(m[2].master, m[0].master);
    assert!(m[0].first_master.is_some() && m[2].first_master.is_some());
    // Masters are the section's page with a header frame on the header
    // distance and a footer frame on the footer distance.
    let first = ir
        .masters
        .iter()
        .find(|x| Some(&x.id) == m[0].first_master.as_ref())
        .unwrap();
    let header = first.header.as_ref().unwrap();
    assert_eq!(header.bounds[0], 18.0, "w:pgMar/@w:header 360 twips");
    assert_eq!(ir.header_footer_parts[header.part].part, "word/header2.xml");
    let default = ir
        .masters
        .iter()
        .find(|x| Some(&x.id) == m[0].master.as_ref())
        .unwrap();
    let footer = default.footer.as_ref().unwrap();
    assert!(footer.bottom_aligned);
    assert_eq!(footer.bounds[2], default.page_height_pt - 18.0);
    // Story and frame ids are the skeleton's.
    assert_eq!(header.story_id, format!("{}_h", first.id));
    assert_eq!(footer.frame_id, format!("{}_ff", default.id));
}
