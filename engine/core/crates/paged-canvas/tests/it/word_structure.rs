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

//! Engine ADR 1022 over the wire: Word sections pick first / odd / even
//! masters and start on odd or even pages; Word fields, F9 and field codes;
//! bookmarks, cross-references, a table of contents in the text, and index
//! markers.
// Test names carry their feature row (`…__feat__…`).
#![allow(non_snake_case)]

use paged_canvas::{CanvasModel, CanvasOptions, Mutation};
use paged_gen::samples::docx_pagination::{section_story_id, sections};
use paged_wire::SectionStartSpec;

fn inter() -> Vec<u8> {
    let p =
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../corpus/fonts/Inter.ttf");
    std::fs::read(&p).expect("read Inter.ttf")
}

/// The `docx-pagination` skeleton: two Word sections (3 and 2 pages once
/// they grow), each a story on a page of its own with a grow rule.
fn sections_model() -> CanvasModel {
    let idml = paged_gen::write_idml(&paged_gen::samples::docx_pagination::build()).expect("idml");
    let mut doc = idml_import::import_idml_doc(&idml).expect("import");
    let ids: Vec<String> = (0..sections().len() as u32).map(section_story_id).collect();
    for s in doc.stories.iter_mut() {
        if ids.contains(&s.self_id) {
            s.story.grow = Some(paged_model::FlowGrowRule {
                copy_frame_options: true,
                ..Default::default()
            });
        }
    }
    let paged =
        paged_store::package::wrap_document(&doc, "Imported.docx", 612.0, 792.0).expect("wrap");
    let opts = CanvasOptions {
        fonts: vec![inter()],
        ..CanvasOptions::default()
    };
    CanvasModel::load("doc1", &paged, opts).expect("load .paged")
}

fn masters(m: &CanvasModel) -> Vec<Option<String>> {
    m.pages().into_iter().map(|p| p.applied_master).collect()
}

fn grow(story: u32, rule: impl FnOnce(&mut Mutation)) -> Mutation {
    let mut m = Mutation::SetFlowGrowRule {
        story_id: section_story_id(story),
        grow: true,
        max_pages: None,
        copy_frame_options: Some(true),
        master: None,
        first_master: None,
        even_master: None,
        section_start: None,
    };
    rule(&mut m);
    m
}

/// Three masters copied from section 1's: first, odd, even.
fn with_word_masters(m: &mut CanvasModel) {
    let base = masters(m)[0].clone().expect("section 1 has a master");
    for id in ["wFirst", "wOdd", "wEven"] {
        m.apply_mutation(&Mutation::CreateMaster {
            master: id.into(),
            name: Some(id.into()),
            width_pt: 0.0,
            height_pt: 0.0,
            duplicate_of: Some(base.clone()),
        })
        .expect("create master");
    }
}

fn set_masters(
    first: Option<&str>,
    odd: Option<&str>,
    even: Option<&str>,
) -> impl FnOnce(&mut Mutation) {
    let (first, odd, even) = (
        first.map(str::to_string),
        odd.map(str::to_string),
        even.map(str::to_string),
    );
    move |m| {
        if let Mutation::SetFlowGrowRule {
            master,
            first_master,
            even_master,
            ..
        } = m
        {
            *master = odd;
            *first_master = first;
            *even_master = even;
        }
    }
}

#[test]
fn a_section_alternates_first_odd_and_even_masters__feat__doc_word_headers_footers() {
    let mut m = sections_model();
    let before = masters(&m);
    assert_eq!(before.len(), 5, "Word paginates this document to 5 pages");
    with_word_masters(&mut m);
    let hash = m.scene().canonical_hash();
    m.apply_mutation(&grow(
        0,
        set_masters(Some("wFirst"), Some("wOdd"), Some("wEven")),
    ))
    .expect("rule");
    let got = masters(&m);
    assert_eq!(
        got[..3],
        [
            Some("wFirst".to_string()),
            Some("wEven".to_string()),
            Some("wOdd".to_string())
        ],
        "first page, then even and odd by page number"
    );
    assert_eq!(got[3..], before[3..], "section 2 keeps its masters");
    // Generated pages are derived; the authored page's master in the
    // model is untouched.
    m.undo().expect("undo");
    assert_eq!(m.scene().canonical_hash(), hash, "undo restores the rule");
    assert_eq!(masters(&m), before);
}

#[test]
fn without_a_first_master_the_first_page_takes_its_parity__feat__doc_word_headers_footers() {
    let mut m = sections_model();
    with_word_masters(&mut m);
    m.apply_mutation(&grow(0, set_masters(None, Some("wOdd"), Some("wEven"))))
        .expect("rule");
    assert_eq!(
        masters(&m)[..3],
        [
            Some("wOdd".to_string()),
            Some("wEven".to_string()),
            Some("wOdd".to_string())
        ]
    );
    // One master for every page (no "different odd & even").
    m.apply_mutation(&grow(0, set_masters(None, Some("wFirst"), None)))
        .expect("rule");
    assert!(masters(&m)[..3]
        .iter()
        .all(|x| x.as_deref() == Some("wFirst")));
}

#[test]
fn an_odd_page_section_start_inserts_a_blank_page__feat__doc_word_headers_footers() {
    let mut m = sections_model();
    with_word_masters(&mut m);
    m.apply_mutation(&grow(
        0,
        set_masters(Some("wFirst"), Some("wOdd"), Some("wEven")),
    ))
    .expect("rule 1");
    // Section 2 starts on page 4: an odd-page start puts a blank page 4 in
    // front and the section opens on page 5.
    m.apply_mutation(&grow(1, |r| {
        if let Mutation::SetFlowGrowRule { section_start, .. } = r {
            *section_start = Some(SectionStartSpec::OddPage);
        }
    }))
    .expect("rule 2");
    let pages = m.pages();
    assert_eq!(pages.len(), 6);
    let blank = paged_scene::grow::generated_blank_page_id(&section_story_id(1));
    assert_eq!(pages[3].self_id, blank);
    assert_eq!(
        pages[3].applied_master.as_deref(),
        Some("wEven"),
        "the blank page shows section 1's even header, as Word prints it"
    );
    assert!(
        m.built().pages[3].story_layout.is_empty(),
        "nothing is set on the blank page"
    );
    let text_pages: Vec<usize> = m
        .built()
        .pages
        .iter()
        .enumerate()
        .filter(|(_, p)| {
            p.story_layout
                .iter()
                .any(|l| l.story_id == section_story_id(1))
        })
        .map(|(i, _)| i)
        .collect();
    assert_eq!(text_pages, vec![4, 5], "section 2 opens on page 5");

    // An even-page start on page 4 needs no blank page.
    m.apply_mutation(&grow(1, |r| {
        if let Mutation::SetFlowGrowRule { section_start, .. } = r {
            *section_start = Some(SectionStartSpec::EvenPage);
        }
    }))
    .expect("rule 2 even");
    assert_eq!(m.pages().len(), 5);
}

#[test]
fn the_rule_reads_back_with_its_masters__feat__doc_word_headers_footers() {
    let mut m = sections_model();
    with_word_masters(&mut m);
    m.apply_mutation(&grow(0, |r| {
        set_masters(Some("wFirst"), Some("wOdd"), Some("wEven"))(r);
        if let Mutation::SetFlowGrowRule { section_start, .. } = r {
            *section_start = Some(SectionStartSpec::OddPage);
        }
    }))
    .expect("rule");
    let story = m
        .stories()
        .into_iter()
        .find(|s| s.self_id == section_story_id(0))
        .expect("story");
    let rule = story.grow_rule.expect("rule");
    assert_eq!(rule.first_master.as_deref(), Some("wFirst"));
    assert_eq!(rule.master.as_deref(), Some("wOdd"));
    assert_eq!(rule.even_master.as_deref(), Some("wEven"));
    assert_eq!(rule.section_start, SectionStartSpec::OddPage);
}

// ---------------------------------------------------------------------
// Fields, bookmarks, cross-references, tables of contents, index markers
// ---------------------------------------------------------------------

/// `sections_model` with a `Heading 1` style (the body style's look, so
/// the pagination stays Word's) on S1 P001, S1 P054, S1 P108 and S2 P001:
/// pages 1, 2, 3 and 4.
fn headed_model() -> CanvasModel {
    let mut m = sections_model();
    let s1 = section_story_id(0);
    let s2 = section_story_id(1);
    let scene = m.scene_mut();
    let body = scene
        .stories
        .iter()
        .find(|s| s.self_id == s1)
        .unwrap()
        .story
        .paragraphs[0]
        .paragraph_style
        .clone();
    scene.styles.paragraph_styles.insert(
        "ParagraphStyle/Heading 1".into(),
        paged_model::ParagraphStyleDef {
            self_id: "ParagraphStyle/Heading 1".into(),
            name: Some("Heading 1".into()),
            based_on: body,
            ..Default::default()
        },
    );
    // Pages numbered by position, as a Word document's are (the skeleton's
    // baked page names would hold the authored pages' numbers).
    for sp in scene.spreads.iter_mut() {
        for p in sp.spread.pages.iter_mut() {
            p.name = None;
        }
    }
    for (story, para) in [(&s1, 0usize), (&s1, 53), (&s1, 107), (&s2, 0)] {
        let s = scene
            .stories
            .iter_mut()
            .find(|s| &s.self_id == story)
            .unwrap();
        s.story.paragraphs[para].paragraph_style = Some("ParagraphStyle/Heading 1".into());
    }
    m
}

fn story<'a>(m: &'a CanvasModel, id: &str) -> &'a paged_model::Story {
    &m.scene()
        .stories
        .iter()
        .find(|s| s.self_id == id)
        .expect("story")
        .story
}

fn para_text(p: &paged_model::Paragraph) -> String {
    p.runs.iter().map(|r| r.text.as_str()).collect()
}

/// The text of the field runs of a paragraph, in order.
fn field_texts(p: &paged_model::Paragraph) -> Vec<String> {
    p.runs
        .iter()
        .filter(|r| r.field.is_some())
        .map(|r| r.text.clone())
        .collect()
}

/// Story char offset of paragraph `p`'s start.
fn char_at(m: &CanvasModel, id: &str, p: usize) -> u32 {
    story(m, id).paragraphs[..p]
        .iter()
        .map(|p| para_text(p).chars().count() as u32)
        .sum()
}

/// Caret offset (UTF-8 bytes, one per paragraph break) of paragraph `p`'s start.
fn caret_at(m: &CanvasModel, id: &str, p: usize) -> u32 {
    story(m, id).paragraphs[..p]
        .iter()
        .map(|p| para_text(p).len() as u32 + 1)
        .sum()
}

fn word_field(story_id: &str, offset: u32, code: &str) -> Mutation {
    Mutation::InsertField {
        story_id: story_id.into(),
        offset,
        field: paged_mutate::operation::FieldKind::Word {
            code: code.into(),
            result: None,
        },
        content_offset: None,
    }
}

fn update(story_id: Option<&str>, now: Option<&str>) -> Mutation {
    Mutation::UpdateFields {
        story_id: story_id.map(str::to_string),
        offset: None,
        now: now.map(str::to_string),
    }
}

/// The label of the page paragraph `p` of `id` is laid out on (the page's
/// name, as the Pages panel shows it).
fn page_of(m: &CanvasModel, id: &str, p: usize) -> String {
    let i = m.built().paragraph_pages()[id][&p];
    m.pages()[i].name.clone()
}

#[test]
fn inserted_fields_show_their_result_and_f9_updates_them__feat__doc_word_fields() {
    let mut m = headed_model();
    let s1 = section_story_id(0);
    m.apply_mutation(&word_field(&s1, 0, r#"DATE \@ "d MMMM yyyy""#))
        .expect("date");
    m.apply_mutation(&word_field(&s1, 0, "NUMPAGES"))
        .expect("numpages");
    m.apply_mutation(&word_field(&s1, 0, "PAGE")).expect("page");
    let p0 = &story(&m, &s1).paragraphs[0];
    assert_eq!(
        field_texts(p0),
        vec![
            "1".to_string(),
            "5".to_string(),
            r#"{ DATE \@ "d MMMM yyyy" }"#.to_string()
        ],
        "a date without a clock shows its code until F9"
    );
    let before = m.scene().canonical_hash();
    m.apply_mutation(&update(None, Some("2026-10-25T09:30:00")))
        .expect("F9");
    assert_eq!(
        field_texts(&story(&m, &s1).paragraphs[0])[2],
        "25 October 2026"
    );
    m.undo().expect("undo");
    assert_eq!(m.scene().canonical_hash(), before, "F9 is one undo step");
    // Nothing to change is a refusal, not an empty undo step.
    assert!(m.apply_mutation(&update(Some(&s1), None)).is_err());
    assert!(m.apply_mutation(&update(None, Some("yesterday"))).is_err());
}

#[test]
fn seq_fields_count_in_document_order__feat__doc_word_fields() {
    let mut m = headed_model();
    let s1 = section_story_id(0);
    let at3 = char_at(&m, &s1, 3) + 1;
    m.apply_mutation(&word_field(&s1, at3, "SEQ Figure"))
        .expect("seq 1");
    let at2 = char_at(&m, &s1, 2) + 1;
    m.apply_mutation(&word_field(&s1, at2, "SEQ Figure"))
        .expect("seq 2");
    let st = story(&m, &s1);
    assert_eq!(field_texts(&st.paragraphs[2]), vec!["1".to_string()]);
    assert_eq!(
        field_texts(&st.paragraphs[3]),
        vec!["1".to_string()],
        "stale until F9, as in Word"
    );
    m.apply_mutation(&update(None, None)).expect("F9");
    let st = story(&m, &s1);
    assert_eq!(field_texts(&st.paragraphs[2]), vec!["1".to_string()]);
    assert_eq!(field_texts(&st.paragraphs[3]), vec!["2".to_string()]);
}

#[test]
fn a_cross_reference_follows_its_heading_after_a_reflow__feat__doc_word_cross_references() {
    let mut m = headed_model();
    let s1 = section_story_id(0);
    let s2 = section_story_id(1);
    let target = paged_wire::CrossReferenceTarget {
        bookmark: None,
        story_id: Some(s2.clone()),
        paragraph: Some(0),
    };
    let before = m.scene().canonical_hash();
    m.apply_mutation(&Mutation::InsertCrossReference {
        story_id: s1.clone(),
        offset: 0,
        content_offset: None,
        target: target.clone(),
        refer_to: paged_wire::CrossReferenceKind::PageNumber,
        hyperlink: None,
    })
    .expect("xref page");
    // Word's hidden bookmark at the heading.
    let dests = &story(&m, &s2).destinations;
    assert_eq!(dests.len(), 1);
    assert_eq!(dests[0].name.as_deref(), Some("_Ref1"));
    let p0 = &story(&m, &s1).paragraphs[0];
    let field = p0.runs.iter().find(|r| r.field.is_some()).unwrap();
    assert_eq!(field.field.as_ref().unwrap().code, r"PAGEREF _Ref1 \h");
    let label4 = page_of(&m, &s2, 0);
    assert_eq!(label4, "4");
    assert_eq!(field.text, "4");
    m.undo().expect("undo");
    assert_eq!(
        m.scene().canonical_hash(),
        before,
        "one step takes the field and the bookmark back"
    );
    m.redo().expect("redo");
    // Its text: the same bookmark, reused.
    m.apply_mutation(&Mutation::InsertCrossReference {
        story_id: s1.clone(),
        offset: 0,
        content_offset: None,
        target,
        refer_to: paged_wire::CrossReferenceKind::Text,
        hyperlink: Some(false),
    })
    .expect("xref text");
    assert_eq!(story(&m, &s2).destinations.len(), 1);
    assert_eq!(
        field_texts(&story(&m, &s1).paragraphs[0]),
        vec!["S2 P001 of the second section.".to_string(), label4]
    );
    // Delete S1 P010–P109: section 1 shrinks to 1 page, so S2 P001 is on
    // page 2. F9 says so.
    let (start, end) = (caret_at(&m, &s1, 9), caret_at(&m, &s1, 109));
    m.apply_mutation(&Mutation::DeleteRange {
        story_id: s1.clone(),
        start,
        end,
        cell: None,
    })
    .expect("delete");
    let i = m.built().paragraph_pages()[&s2][&0];
    assert_eq!(i, 1, "S2 P001 moved to page 2");
    let label3 = page_of(&m, &s2, 0);
    assert_eq!(label3, "2");
    m.apply_mutation(&update(Some(&s1), None)).expect("F9");
    assert_eq!(
        field_texts(&story(&m, &s1).paragraphs[0]),
        vec!["S2 P001 of the second section.".to_string(), label3]
    );
}

#[test]
fn bookmarks_are_text_anchors_that_follow_their_text__feat__doc_word_cross_references() {
    let mut m = headed_model();
    let s1 = section_story_id(0);
    let at = char_at(&m, &s1, 5) + 3;
    m.apply_mutation(&Mutation::InsertTextAnchor {
        story_id: s1.clone(),
        offset: at,
        content_offset: None,
        name: "Here".into(),
    })
    .expect("bookmark");
    assert!(
        m.apply_mutation(&Mutation::InsertTextAnchor {
            story_id: s1.clone(),
            offset: 0,
            content_offset: None,
            name: "Here".into(),
        })
        .is_err(),
        "bookmark names are unique"
    );
    let d = story(&m, &s1).destinations[0].clone();
    assert_eq!((d.paragraph, d.offset), (5, 3));
    // Typing a paragraph break before it moves it on a paragraph.
    m.apply_mutation(&Mutation::InsertText {
        story_id: s1.clone(),
        offset: 2,
        text: "\n".into(),
        cell: None,
    })
    .expect("enter");
    let d = story(&m, &s1).destinations[0].clone();
    assert_eq!((d.paragraph, d.offset), (6, 3));
    m.apply_mutation(&Mutation::DeleteTextAnchor {
        anchor_id: d.self_id.clone(),
    })
    .expect("delete bookmark");
    assert!(story(&m, &s1).destinations.is_empty());
    m.undo().expect("undo");
    assert_eq!(story(&m, &s1).destinations[0], d);
}

#[test]
fn a_table_of_contents_in_the_text_is_inserted_and_updated__feat__doc_word_toc() {
    let mut m = headed_model();
    let s1 = section_story_id(0);
    let before = m.scene().canonical_hash();
    m.apply_mutation(&Mutation::InsertTableOfContents {
        story_id: s1.clone(),
        offset: 0,
        content_offset: None,
        levels: vec![paged_wire::TocLevelSpec {
            style: "ParagraphStyle/Heading 1".into(),
            level: 1,
        }],
        title: Some("Contents".into()),
        toc_style_name: None,
        page_numbers: None,
        leader: None,
        tab_position: None,
    })
    .expect("insert toc");
    let st = story(&m, &s1);
    let toc: Vec<&paged_model::Paragraph> = st
        .paragraphs
        .iter()
        .take_while(|p| p.toc.is_some())
        .collect();
    assert_eq!(toc.len(), 5, "the title and four entries");
    assert_eq!(para_text(toc[0]), "Contents");
    assert_eq!(
        toc[1].paragraph_style.as_deref(),
        Some("ParagraphStyle/TOC 1")
    );
    let tab = &m.scene().styles.paragraph_styles["ParagraphStyle/TOC 1"].tab_list[0];
    assert_eq!(tab.alignment.as_deref(), Some("RightAlign"));
    assert_eq!(tab.leader.as_deref(), Some("."));
    // Each entry's number is the page its heading stands on AFTER the
    // insertion (the table itself moves them).
    let entries: Vec<String> = toc[1..].iter().map(|p| para_text(p)).collect();
    let pages = [
        page_of(&m, &s1, 5),
        page_of(&m, &s1, 58),
        page_of(&m, &s1, 112),
        page_of(&m, &section_story_id(1), 0),
    ];
    assert!(entries[0].starts_with("S1 P001 of the first section.\t"));
    for (e, p) in entries.iter().zip(pages) {
        assert!(e.ends_with(&format!("\t{p}")), "{e:?} ends with page {p}");
    }
    // Edit: delete S1 P010–P069, then update the table in place.
    let (start, end) = (caret_at(&m, &s1, 14), caret_at(&m, &s1, 74));
    m.apply_mutation(&Mutation::DeleteRange {
        story_id: s1.clone(),
        start,
        end,
        cell: None,
    })
    .expect("delete");
    m.apply_mutation(&Mutation::UpdateTableOfContents {
        story_id: s1.clone(),
    })
    .expect("update toc");
    let st = story(&m, &s1);
    let toc: Vec<String> = st
        .paragraphs
        .iter()
        .take_while(|p| p.toc.is_some())
        .map(para_text)
        .collect();
    assert_eq!(toc.len(), 4, "S1 P054 was deleted: three entries left");
    let heading_pages: Vec<String> = st
        .paragraphs
        .iter()
        .enumerate()
        .filter(|(_, p)| p.paragraph_style.as_deref() == Some("ParagraphStyle/Heading 1"))
        .map(|(i, _)| page_of(&m, &s1, i))
        .collect();
    assert_eq!(heading_pages.len(), 2);
    assert!(toc[1].ends_with(&format!("\t{}", heading_pages[0])));
    assert!(toc[2].ends_with(&format!("\t{}", heading_pages[1])));
    assert!(toc[3].ends_with(&format!("\t{}", page_of(&m, &section_story_id(1), 0))));
    // Undo the update, the delete and the insertion: the model as it was.
    m.undo().expect("undo update");
    m.undo().expect("undo delete");
    m.undo().expect("undo insert");
    assert_eq!(m.scene().canonical_hash(), before);
}

#[test]
fn index_markers_reach_generate_index__feat__doc_word_index() {
    let mut m = headed_model();
    let s1 = section_story_id(0);
    let s2 = section_story_id(1);
    let at54 = char_at(&m, &s1, 53) + 2;
    m.apply_mutation(&Mutation::InsertIndexMarker {
        story_id: s1.clone(),
        offset: at54,
        content_offset: None,
        topic: vec!["Apples".into()],
        sort_order: None,
    })
    .expect("marker");
    let at108 = char_at(&m, &s1, 107);
    m.apply_mutation(&Mutation::InsertIndexMarker {
        story_id: s1.clone(),
        offset: at108,
        content_offset: None,
        topic: vec!["Fruit".into(), "Pears".into()],
        sort_order: None,
    })
    .expect("sub marker");
    assert!(m
        .apply_mutation(&Mutation::InsertIndexMarker {
            story_id: s1.clone(),
            offset: 0,
            content_offset: None,
            topic: vec![],
            sort_order: None,
        })
        .is_err());
    m.apply_mutation(&Mutation::GenerateIndex {
        story_id: s2.clone(),
    })
    .expect("generate");
    let texts: Vec<String> = story(&m, &s2).paragraphs.iter().map(para_text).collect();
    assert!(texts.contains(&"Apples  2".to_string()), "{texts:?}");
    assert!(texts.contains(&"Fruit".to_string()), "{texts:?}");
    assert!(texts.contains(&"Pears  3".to_string()), "{texts:?}");
    // One undo takes the index back; two more the markers and topics.
    m.undo().expect("undo index");
    m.undo().expect("undo marker 2");
    assert!(m
        .scene()
        .designmap
        .index_topics
        .iter()
        .all(|t| t.name.as_deref() == Some("Apples")));
}

#[test]
fn word_fields_export_to_idml_as_variables_or_text__feat__doc_word_fields() {
    let mut m = headed_model();
    let s1 = section_story_id(0);
    for code in [
        "PAGEREF Nowhere",
        r#"STYLEREF "Heading 1""#,
        "SECTIONPAGES",
        "NUMPAGES",
        "PAGE",
    ] {
        m.apply_mutation(&word_field(&s1, 0, code)).expect(code);
    }
    let idml = m.export_idml().expect("export");
    let back = idml_import::import_idml_doc(&idml).expect("reimport");
    let st = &back
        .stories
        .iter()
        .find(|s| s.self_id == s1)
        .expect("story")
        .story;
    let runs = &st.paragraphs[0].runs;
    assert!(runs.iter().all(|r| r.field.is_none()), "IDML has no fields");
    let vars: Vec<&str> = runs
        .iter()
        .filter_map(|r| r.text_variable.as_deref())
        .collect();
    assert_eq!(
        vars,
        vec![
            "dTextVariablenWord NUMPAGES",
            "dTextVariablenWord SECTIONPAGES",
            "dTextVariablenWord STYLEREF Heading 1"
        ]
    );
    let types: Vec<(Option<&str>, Option<&str>)> = vars
        .iter()
        .map(|id| {
            let v = back
                .designmap
                .text_variables
                .iter()
                .find(|v| v.self_id == *id)
                .expect("defined");
            (v.variable_type.as_deref(), v.page_number_scope.as_deref())
        })
        .collect();
    assert_eq!(
        types,
        vec![
            (Some("LastPageNumberType"), Some("DocumentScope")),
            (Some("LastPageNumberType"), Some("SectionScope")),
            (Some("MatchParagraphStyleType"), None)
        ]
    );
    let text = para_text(&st.paragraphs[0]);
    assert!(
        text.starts_with(paged_model::AUTO_PAGE_NUMBER_MARKER),
        "PAGE is InDesign's page number: {text:?}"
    );
    assert!(
        text.contains("Error! Bookmark not defined."),
        "PAGEREF is written as its result"
    );
    // The `.paged` model part keeps the fields themselves.
    let paged = m
        .export_paged(paged_canvas::PROTOCOL_VERSION.0)
        .expect("paged");
    let reopened = CanvasModel::load(
        "doc2",
        &paged,
        CanvasOptions {
            fonts: vec![inter()],
            ..CanvasOptions::default()
        },
    )
    .expect("reload");
    let fields = story(&reopened, &s1).paragraphs[0]
        .runs
        .iter()
        .filter(|r| r.field.is_some())
        .count();
    assert_eq!(fields, 5);
}

#[test]
fn show_field_codes_is_a_document_flag__feat__doc_word_fields() {
    let mut m = headed_model();
    let before = m.scene().canonical_hash();
    m.apply_mutation(&Mutation::Set {
        address: paged_wire::Address::parse("doc").expect("address"),
        path: "documentShowFieldCodes".into(),
        value: paged_mutate::Value::Bool(true),
    })
    .expect("show codes");
    assert_eq!(
        m.scene().designmap.document_preference.show_field_codes,
        Some(true)
    );
    m.undo().expect("undo");
    assert_eq!(m.scene().canonical_hash(), before);
}
