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

// ADR 029 — the section skeleton of docx_conformance::pagination_docx(), the
// document Word paginated (docx-conformance/fixtures/pagination.word.json),
// asserted on the native document this crate builds (ADR 606), read back
// from its `.paged` package the way the engine reads it.

use std::io::Read;

use docx_skeleton::{section_frame_id, section_story_id, skeleton, Skeleton};
use paged_model::{FirstBaselineOffset, MarginPreference, TextFrame};
use paged_scene::Document;

fn pagination() -> docx_core::DocxDocument {
    docx_import::import_docx(&docx_conformance::pagination_docx()).expect("import")
}

/// The package's entry names, in order, and whether the first is stored.
fn entries(bytes: &[u8]) -> (Vec<String>, bool) {
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).expect("zip");
    let first_stored = zip.by_index(0).unwrap().compression() == zip::CompressionMethod::Stored;
    let names = (0..zip.len())
        .map(|i| zip.by_index(i).unwrap().name().unwrap().into_owned())
        .collect();
    (names, first_stored)
}

/// The document the engine opens from the package: its model part.
fn model(sk: &Skeleton) -> Document {
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(&sk.paged)).expect("zip");
    let mut pgm = Vec::new();
    zip.by_name(paged_store::DOCUMENT_PGM_PATH)
        .expect("the model part")
        .read_to_end(&mut pgm)
        .unwrap();
    paged_store::from_bytes(&pgm).expect("the model part decodes")
}

/// What story `k`'s spread holds: page bounds `[top, left, bottom,
/// right]`, margins, and the one frame.
struct SpreadView<'a> {
    page: [f32; 4],
    margin: &'a MarginPreference,
    frame: &'a TextFrame,
}

fn spread(doc: &Document, k: usize) -> SpreadView<'_> {
    let s = &doc.spreads[k];
    assert_eq!(s.src, format!("Spreads/Spread_docx_sp{k}.xml"));
    let s = &s.spread;
    assert_eq!(s.self_id.as_deref(), Some(format!("docx_sp{k}").as_str()));
    assert_eq!(s.pages.len(), 1, "a page per story");
    let page = &s.pages[0];
    let page_id = format!("docx_p{k}");
    assert_eq!(page.self_id.as_deref(), Some(page_id.as_str()));
    assert_eq!(page.item_transform, Some([1.0, 0.0, 0.0, 1.0, 0.0, 0.0]));
    assert_eq!(s.text_frames.len(), 1, "one frame per story");
    let frame = &s.text_frames[0];
    assert_eq!(frame.item_transform, Some([1.0, 0.0, 0.0, 1.0, 0.0, 0.0]));
    // The frame's path is its margin box.
    assert_eq!(frame.anchors.len(), 4, "a rectangle");
    let b = &frame.bounds;
    for a in &frame.anchors {
        assert!([b.left, b.right].contains(&a.anchor.0));
        assert!([b.top, b.bottom].contains(&a.anchor.1));
    }
    let p = &page.bounds;
    SpreadView {
        page: [p.top, p.left, p.bottom, p.right],
        margin: &s.page_margins[&page_id],
        frame,
    }
}

fn frame_box(f: &TextFrame) -> [f32; 4] {
    [f.bounds.top, f.bounds.left, f.bounds.bottom, f.bounds.right]
}

#[test]
fn the_package_is_a_native_document() {
    let sk = skeleton(&pagination(), "pagination.docx").expect("skeleton");
    let (names, first_stored) = entries(&sk.paged);
    assert_eq!(names[0], "mimetype", "OCF: mimetype first");
    assert!(first_stored, "OCF: mimetype stored");
    assert!(names.iter().any(|n| n == paged_store::DOCUMENT_PGM_PATH));

    // The manifest names every spread and story, in story order.
    let doc = model(&sk);
    let dm = &doc.designmap;
    assert_eq!(dm.document_name.as_deref(), Some("pagination.docx"));
    let srcs = |v: Vec<&str>| v.into_iter().map(str::to_string).collect::<Vec<_>>();
    assert_eq!(
        dm.spreads.iter().map(|s| s.src.clone()).collect::<Vec<_>>(),
        srcs(vec![
            "Spreads/Spread_docx_sp0.xml",
            "Spreads/Spread_docx_sp1.xml"
        ])
    );
    assert_eq!(
        dm.stories.iter().map(|s| s.src.clone()).collect::<Vec<_>>(),
        srcs(vec![
            "Stories/Story_docx_s0.xml",
            "Stories/Story_docx_s1.xml"
        ])
    );
    assert_eq!(
        doc.stories
            .iter()
            .map(|s| s.self_id.clone())
            .collect::<Vec<_>>(),
        vec![section_story_id(0), section_story_id(1)]
    );

    // Single-sided, sized like section 1.
    let dp = &dm.document_preference;
    assert_eq!(dp.facing_pages, Some(false));
    assert_eq!((dp.page_width, dp.page_height), (Some(612.0), Some(792.0)));
    // Every style and swatch the items reference is defined.
    assert!(doc
        .styles
        .paragraph_styles
        .contains_key("ParagraphStyle/$ID/[No paragraph style]"));
    assert!(doc
        .styles
        .character_styles
        .contains_key("CharacterStyle/$ID/[No character style]"));
    assert!(doc
        .styles
        .object_styles
        .contains_key("ObjectStyle/$ID/[None]"));
    assert!(doc.palette.swatches.contains_key("Swatch/None"));
}

#[test]
fn one_page_frame_and_empty_story_per_section() {
    let sk = skeleton(&pagination(), "pagination.docx").expect("skeleton");
    assert_eq!(
        sk.section_stories,
        vec![section_story_id(0), section_story_id(1)]
    );
    let doc = model(&sk);
    assert_eq!(doc.spreads.len(), 2);

    // Section 1: Letter, 1 in margins; section 2: A5 landscape, 0.5 in.
    let s1 = spread(&doc, 0);
    assert_eq!(s1.page, [0.0, 0.0, 792.0, 612.0]);
    assert_eq!(frame_box(s1.frame), [72.0, 72.0, 720.0, 540.0]);
    let m = s1.margin;
    assert_eq!([m.top, m.bottom, m.left, m.right], [72.0; 4]);
    assert_eq!(m.column_count, 1);
    let s2 = spread(&doc, 1);
    assert!((s2.page[2] - 419.55).abs() < 0.01 && (s2.page[3] - 595.3).abs() < 0.01);
    let f2 = frame_box(s2.frame);
    assert_eq!((f2[0], f2[1]), (36.0, 36.0));
    assert!((f2[3] - (595.3 - 36.0)).abs() < 0.01);

    for (k, s) in [s1, s2].iter().enumerate() {
        // Each section frame threads its own story, alone.
        let f = s.frame;
        assert_eq!(f.self_id.as_deref(), Some(section_frame_id(k).as_str()));
        assert_eq!(
            f.parent_story.as_deref(),
            Some(section_story_id(k).as_str())
        );
        assert_eq!(f.next_text_frame.as_deref(), Some("n"));
        // Word's line-box fit.
        assert_eq!(
            f.first_baseline_offset,
            Some(FirstBaselineOffset::LeadingOffset)
        );
        assert_eq!(f.inset_spacing, Some([0.0; 4]));
        assert_eq!(f.column_count, None);

        let story = &doc.stories[k];
        assert_eq!(story.self_id, section_story_id(k));
        assert_eq!(story.story.paragraphs.len(), 1, "one empty paragraph");
        assert!(story.story.paragraphs[0].runs.is_empty(), "no text");
    }
}

#[test]
fn the_package_is_deterministic() {
    let a = skeleton(&pagination(), "pagination.docx").unwrap().paged;
    let b = skeleton(&pagination(), "pagination.docx").unwrap().paged;
    assert_eq!(a, b);
}

/// ADR 029 — continuous sections that Word keeps on the page they continue
/// share that page's story (docx_conformance::continuous_docx(), measured in
/// docx-conformance/fixtures/continuous.word.json): 17 Word sections, 11
/// stories, and the lowering assigns every section the story it pours into.
#[test]
fn continuous_sections_share_the_story_of_the_page_they_continue() {
    let docx = docx_import::import_docx(&docx_conformance::continuous_docx()).expect("import");
    assert_eq!(docx.sections.len(), 17);
    let sk = skeleton(&docx, "continuous.docx").expect("skeleton");
    let doc = model(&sk);
    assert_eq!(doc.spreads.len(), 8, "a page per story, not per section");
    assert_eq!(doc.stories.len(), 8);
    for k in 0..8 {
        let s = spread(&doc, k);
        assert_eq!(
            s.frame.parent_story.as_deref(),
            Some(section_story_id(k).as_str())
        );
    }

    // Each story's page and frame are its FIRST section's: story 0 is A1's
    // (A2, A3 join it); story 1 is B1's page with the two columns the
    // lowering chose for B (B1 and B3 span them, ADR 029); story 3 is C1's
    // 0.5 in margins (C2's other margins become indents); story 6 is F2's
    // 6 in page.
    let s0 = spread(&doc, 0);
    assert_eq!((s0.page[3], s0.page[2]), (360.0, 312.0));
    assert_eq!(frame_box(s0.frame), [36.0, 36.0, 276.0, 324.0]);
    assert_eq!(s0.frame.column_count, None);
    let s1 = spread(&doc, 1);
    assert_eq!(s1.frame.column_count, Some(2));
    assert_eq!(s1.frame.column_gutter, Some(36.0));
    assert_eq!(s1.margin.column_count, 2);
    assert_eq!(
        spread(&doc, 2).frame.column_count,
        Some(2),
        "D1 + nextColumn D2"
    );
    let f3 = frame_box(spread(&doc, 3).frame);
    assert_eq!((f3[1], f3[3]), (36.0, 324.0));
    assert_eq!(spread(&doc, 6).page[3], 432.0);
    assert_eq!(spread(&doc, 7).page[3], 360.0);

    // The pour's view agrees: one block group per skeleton story.
    let ir = docx_lower::lower(&docx);
    let story_of: Vec<usize> = ir.sections.iter().map(|s| s.story).collect();
    assert_eq!(
        story_of,
        vec![0, 0, 0, 1, 1, 1, 1, 2, 2, 3, 3, 3, 4, 4, 5, 6, 7]
    );
    assert_eq!(sk.section_stories, docx_skeleton::story_ids(&docx));
    assert_eq!(sk.section_stories.len(), story_of.last().unwrap() + 1);

    // An engine without span/split columns: B's four sections are four
    // pages, as before, each frame with its own section's columns.
    let old = docx_lower::sections::LowerOptions {
        mid_page_columns: false,
    };
    let sk = docx_skeleton::skeleton_with(&docx, "continuous.docx", old).expect("skeleton");
    let doc = model(&sk);
    assert_eq!(doc.spreads.len(), 11);
    assert_eq!(spread(&doc, 1).frame.column_count, None);
    assert_eq!(spread(&doc, 2).frame.column_count, Some(2));
    assert_eq!(
        sk.section_stories,
        docx_skeleton::story_ids_with(&docx, old)
    );
}

/// Doc ADR 611: a document with headers and footers gets its section
/// masters in the skeleton, each a page of its section's size with a
/// header frame and a footer frame holding an empty story, and every
/// story's page shows its section's first master. A section restarting
/// its page numbers gets a numbering section on its page.
#[test]
#[allow(non_snake_case)]
fn the_skeleton_writes_the_section_masters_and_numbering__feat__doc_word_headers_footers() {
    let doc = docx_import::import_docx(&docx_conformance::headers_docx()).expect("import");
    let sk = skeleton(&doc, "headers.docx").unwrap();
    let m = model(&sk);
    let (masters, per_section) = docx_skeleton::masters_with(&doc, Default::default());
    assert!(masters.len() >= 3, "{masters:?}");
    for lm in &masters {
        let spread = &m.master_spreads[&lm.id];
        assert_eq!(spread.spread.pages.len(), 1);
        let ids: Vec<&str> = spread
            .spread
            .text_frames
            .iter()
            .filter_map(|f| f.self_id.as_deref())
            .collect();
        for f in [&lm.header, &lm.footer].into_iter().flatten() {
            assert!(ids.contains(&f.frame_id.as_str()), "{ids:?}");
            let story = m
                .stories
                .iter()
                .find(|s| s.self_id == f.story_id)
                .expect("the frame's story");
            assert_eq!(story.story.paragraphs.len(), 1, "an empty story to pour");
        }
    }
    // Each story page shows its section's first master (S1 and S3 have a
    // different first page; S2 its master).
    let applied: Vec<Option<String>> = m
        .spreads
        .iter()
        .map(|s| s.spread.pages[0].applied_master.clone())
        .collect();
    let want: Vec<Option<String>> = per_section
        .iter()
        .map(|p| {
            let p = p.clone().unwrap();
            p.first_master.or(p.master)
        })
        .collect();
    assert_eq!(applied, want);
    // S2 restarts at 1: a section on its page, after the first page's.
    let sections: Vec<(Option<&str>, bool, Option<u32>)> = m
        .designmap
        .sections
        .iter()
        .map(|s| (s.page_start.as_deref(), s.continue_numbering, s.start_at))
        .collect();
    assert_eq!(
        sections,
        [
            (Some("docx_p0"), false, Some(1)),
            (Some("docx_p1"), false, Some(1))
        ]
    );
}
