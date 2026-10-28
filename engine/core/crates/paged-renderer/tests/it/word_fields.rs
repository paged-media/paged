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

//! Engine ADR 1022 — Word fields print the current layout's answer: the
//! page count, the section's page count, the page number, a bookmark's
//! page and a running head, on a Word document that grows its pages; "show
//! field codes" prints their codes.

use std::path::PathBuf;

use paged_gen::samples::docx_pagination::{section_story_id, sections};
use paged_renderer::pipeline;
use paged_renderer::PipelineOptions;

fn inter_font() -> Vec<u8> {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../corpus/fonts/Inter.ttf");
    std::fs::read(&p).unwrap_or_else(|e| panic!("read Inter.ttf: {e}"))
}

fn glyph_text(page: &paged_renderer::BuiltPage) -> String {
    let table = page
        .list
        .glyph_runs
        .as_ref()
        .expect("collect_glyph_runs must be on");
    let mut entries: Vec<_> = table.entries.iter().collect();
    entries.sort_by_key(|e| e.command_index);
    entries
        .iter()
        .filter_map(|e| e.unicode)
        .filter(|c| !c.is_whitespace())
        .collect()
}

fn field_run(
    template: &paged_model::CharacterRun,
    code: &str,
    stale: &str,
) -> paged_model::CharacterRun {
    let mut r = template.clone();
    r.text = stale.to_string();
    r.field = Some(paged_model::WordField::parse(code));
    r
}

fn text_run(template: &paged_model::CharacterRun, text: &str) -> paged_model::CharacterRun {
    let mut r = template.clone();
    r.text = text.to_string();
    r
}

/// Word's two-section document (pages 1–3 and 4–5), with stale fields in
/// its first paragraph and a running head on page 5.
fn document() -> paged_scene::Document {
    let bytes =
        paged_gen::write_idml(&paged_gen::samples::docx_pagination::build()).expect("write_idml");
    let mut doc = idml_import::import_idml_doc(&bytes).expect("import");
    let s1 = section_story_id(0);
    let s2 = section_story_id(1);
    let ids: Vec<String> = (0..sections().len() as u32).map(section_story_id).collect();
    for s in doc.stories.iter_mut() {
        if ids.contains(&s.self_id) {
            s.story.grow = Some(paged_model::FlowGrowRule {
                copy_frame_options: true,
                ..Default::default()
            });
        }
    }
    // A bookmark at S2 P001 (page 4).
    let story2 = doc.stories.iter_mut().find(|s| s.self_id == s2).unwrap();
    story2
        .story
        .destinations
        .push(paged_model::StoryDestination {
            self_id: "HyperlinkTextDestination/bm".into(),
            name: Some("Second".into()),
            paragraph: 0,
            offset: 0,
            paragraph_destination: false,
        });
    // A running head of the body style in S2 P035 (page 5).
    let style = story2.story.paragraphs[34].paragraph_style.clone().unwrap();
    let t = story2.story.paragraphs[34].runs[0].clone();
    story2.story.paragraphs[34].runs = vec![
        text_run(&t, "Head:"),
        field_run(&t, &format!("STYLEREF \"{style}\""), "stale"),
    ];
    let story1 = doc.stories.iter_mut().find(|s| s.self_id == s1).unwrap();
    let t = story1.story.paragraphs[0].runs[0].clone();
    story1.story.paragraphs[0].runs = vec![
        text_run(&t, "Pages:"),
        field_run(&t, r"NUMPAGES \* MERGEFORMAT", "99"),
        text_run(&t, " Sec:"),
        field_run(&t, "SECTIONPAGES", "99"),
        text_run(&t, " Here:"),
        field_run(&t, "PAGE", "99"),
        text_run(&t, " Ref:"),
        field_run(&t, r"PAGEREF Second \h", "99"),
        text_run(&t, " Seq:"),
        field_run(&t, r"SEQ Figure", "7"),
    ];
    doc
}

fn build(doc: &paged_scene::Document) -> paged_renderer::BuiltDocument {
    let font = inter_font();
    let opts = PipelineOptions {
        font: Some(&font),
        collect_glyph_runs: true,
        ..PipelineOptions::default()
    };
    pipeline::build_document(doc, &opts).expect("build")
}

#[test]
fn live_fields_print_the_layouts_answer() {
    let doc = document();
    let built = build(&doc);
    assert_eq!(
        built.pages.len(),
        5,
        "the fields do not change the pagination"
    );
    let p1 = glyph_text(&built.pages[0]);
    for want in ["Pages:5", "Sec:5", "Here:1", "Ref:4"] {
        assert!(p1.contains(want), "page 1 shows {want:?}: {p1}");
    }
    // A SEQ field is updated by F9, not at layout: it prints its result.
    assert!(p1.contains("Seq:7"), "{p1}");
    // STYLEREF on page 5: the first paragraph of the style on the page.
    let p5 = glyph_text(&built.pages[4]);
    assert!(
        p5.contains("Head:S2P029ofthesecondsection."),
        "page 5 shows its running head: {p5}"
    );
}

#[test]
fn show_field_codes_prints_the_codes() {
    let mut doc = document();
    doc.designmap.document_preference.show_field_codes = Some(true);
    let built = build(&doc);
    let p1 = glyph_text(&built.pages[0]);
    assert!(p1.contains("Pages:{NUMPAGES\\*MERGEFORMAT}"), "{p1}");
    assert!(p1.contains("Ref:{PAGEREFSecond\\h}"), "{p1}");
}

#[test]
fn a_missing_bookmark_prints_words_error() {
    let mut doc = document();
    for s in doc.stories.iter_mut() {
        s.story.destinations.clear();
    }
    let built = build(&doc);
    let p1 = glyph_text(&built.pages[0]);
    assert!(p1.contains("Ref:Error!Bookmarknotdefined."), "{p1}");
}
