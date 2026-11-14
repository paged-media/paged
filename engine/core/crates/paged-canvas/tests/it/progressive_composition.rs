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

//! Engine ADR 1314 — progressive composition. A progressive load composes
//! the pages asked for first and answers a provisional document; steps
//! compose the pages in view; the last step is the whole document's build.
//! The determinism guarantee: whatever order the pages were composed in,
//! the final model is the whole document's composition — page for page the
//! same display lists, line geometry and diagnostics as a model loaded
//! whole, and the same as a cold build of its scene (the ADR 027 digest
//! gate). And a provisional page is never final: the model says so until
//! the last step.

use paged_canvas::{CanvasModel, CanvasOptions, Mutation};

fn corpus(rel: &str) -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../corpus")
        .join(rel)
}

fn opts() -> CanvasOptions {
    CanvasOptions {
        fonts: vec![std::fs::read(corpus("fonts/Inter.ttf")).expect("read Inter.ttf")],
        ..CanvasOptions::default()
    }
}

fn sample(build: fn() -> paged_gen::package::Sample) -> Vec<u8> {
    paged_gen::write_idml(&build()).expect("write_idml")
}

/// The samples the determinism test runs over: several pages and
/// spreads, threaded stories, masters with page numbers, cross-story
/// lists, variables and running headers, a table of contents, growing
/// stories, footnotes, pictures.
fn samples() -> Vec<(&'static str, Vec<u8>)> {
    use paged_gen::samples as s;
    vec![
        ("annual-base", sample(s::annual_base::build)),
        ("masters", sample(s::masters::build)),
        ("navigation", sample(s::navigation::build)),
        ("numbering", sample(s::numbering::build)),
        ("variables", sample(s::variables::build)),
        ("toc", sample(s::toc::build)),
        ("reflow", sample(s::reflow::build)),
        ("footnotes", sample(s::footnotes::build)),
        ("images", sample(s::images::build)),
        ("layout", sample(s::layout::build)),
        ("keeps", sample(s::keeps::build)),
        ("xref", sample(s::xref::build)),
    ]
}

/// Page for page: ids, sizes, places, display lists, line geometry.
fn assert_same_pages(name: &str, a: &CanvasModel, b: &CanvasModel) {
    let (pa, pb) = (&a.built().pages, &b.built().pages);
    assert_eq!(pa.len(), pb.len(), "{name}: page count");
    for (i, (x, y)) in pa.iter().zip(pb).enumerate() {
        assert_eq!(x.id, y.id, "{name}: page {i} id");
        assert_eq!(
            (x.width_pt, x.height_pt, x.canvas_origin),
            (y.width_pt, y.height_pt, y.canvas_origin),
            "{name}: page {i} geometry"
        );
        assert_eq!(
            x.list.digest(),
            y.list.digest(),
            "{name}: page {i} display list"
        );
        assert_eq!(
            format!("{:?}", x.story_layout),
            format!("{:?}", y.story_layout),
            "{name}: page {i} lines"
        );
    }
    assert_eq!(
        format!("{:?}", a.built().diagnostics),
        format!("{:?}", b.built().diagnostics),
        "{name}: diagnostics"
    );
}

/// Step until done, the pages in `view` first; returns the steps taken.
fn compose_all(m: &mut CanvasModel, view: &[usize]) -> usize {
    let mut steps = 0;
    loop {
        steps += 1;
        assert!(steps < 64, "the composition never finished");
        if m.compose_next(view).expect("step").done {
            return steps;
        }
    }
}

#[test]
fn progressive_composition_ends_in_the_whole_documents_composition() {
    for (name, bytes) in samples() {
        let whole = CanvasModel::load("whole", &bytes, opts()).expect("load");
        let pages = whole.built().pages.len();
        // Page 1 first; the last page first; the pages in view from the
        // middle to the end, one step each.
        let mid = pages / 2;
        let orders: Vec<(Vec<usize>, Vec<usize>)> = vec![
            (vec![0], vec![]),
            (vec![pages - 1], vec![0]),
            (vec![mid], (mid..pages).collect()),
        ];
        for (first, view) in orders {
            let mut m = CanvasModel::load_progressive("p", &bytes, opts(), &first)
                .unwrap_or_else(|e| panic!("{name}: progressive load: {e:?}"));
            assert!(
                m.page_composed(first[0]),
                "{name}: the first page is composed"
            );
            if m.composed_page_count() < pages {
                assert!(
                    m.is_provisional(),
                    "{name}: provisional until the last step"
                );
                assert!(m.handle().provisional);
            }
            // The provisional page list is the document's.
            let ids: Vec<_> = m.built().pages.iter().map(|p| p.id.clone()).collect();
            let whole_ids: Vec<_> = whole.built().pages.iter().map(|p| p.id.clone()).collect();
            if m.is_provisional() && !name.starts_with("reflow") {
                assert_eq!(ids, whole_ids, "{name}: the provisional page list");
            }
            // A page not composed is empty: never shown as a finished page.
            for (i, p) in m.built().pages.iter().enumerate() {
                if !m.page_composed(i) {
                    assert!(p.list.commands.is_empty(), "{name}: page {i} is not empty");
                }
            }
            compose_all(&mut m, &view);
            assert!(!m.is_provisional(), "{name}: final after the last step");
            assert!(!m.handle().provisional);
            assert_eq!(m.composed_page_count(), m.built().pages.len());
            assert_same_pages(name, &m, &whole);
            m.digest_gate_check()
                .unwrap_or_else(|e| panic!("{name}: final is not a cold build: {e}"));
        }
    }
}

#[test]
fn a_story_threaded_from_an_earlier_spread_arrives_with_its_text() {
    // The first page asked for is the last: every spread holding an earlier
    // frame of a story that reaches it is laid out too, so its lines are the
    // whole document's.
    for (name, bytes) in samples() {
        let whole = CanvasModel::load("whole", &bytes, opts()).expect("load");
        let last = whole.built().pages.len() - 1;
        let m = CanvasModel::load_progressive("p", &bytes, opts(), &[last]).expect("load");
        if m.built().pages.len() != whole.built().pages.len() {
            continue; // a growing story: the provisional document has fewer pages
        }
        let lines = |m: &CanvasModel| {
            m.built().pages[last]
                .story_layout
                .iter()
                .filter(|l| !l.story_id.is_empty())
                .map(|l| (l.story_id.clone(), l.paragraph_idx, l.byte_range.clone()))
                .collect::<Vec<_>>()
        };
        // Stories that read the whole document (lists counted across
        // stories, running headers, page references) may differ; the text
        // that flows in a story's own frames does not.
        let a = lines(&m);
        let b = lines(&whole);
        assert_eq!(a, b, "{name}: the lines on the last page");
    }
}

#[test]
fn an_edit_while_provisional_is_made_on_the_whole_document() {
    let bytes = sample(paged_gen::samples::navigation::build);
    let mut m = CanvasModel::load_progressive("p", &bytes, opts(), &[0]).expect("load");
    let story = m
        .scene()
        .stories
        .iter()
        .find(|s| !s.story.paragraphs.is_empty())
        .expect("a story")
        .self_id
        .clone();
    m.apply_mutation(&Mutation::InsertText {
        story_id: story,
        offset: 0,
        text: "x".into(),
        cell: None,
    })
    .expect("insert");
    assert!(
        !m.is_provisional(),
        "an edit's rebuild is the whole document's"
    );
    m.digest_gate_check()
        .expect("the edit's build is a cold build");
}

#[test]
fn a_page_asked_for_is_composed_on_demand() {
    let bytes = sample(paged_gen::samples::annual_base::build);
    let mut m = CanvasModel::load_progressive("p", &bytes, opts(), &[0]).expect("load");
    let pages = m.built().pages.len();
    assert!(pages > 2);
    let id = m.built().pages[pages - 1].id.clone();
    if !m.page_composed(pages - 1) {
        assert!(m.ensure_composed(&id).expect("compose"));
    }
    assert!(m.page_composed(pages - 1));
    assert!(!m.built().pages[pages - 1].list.commands.is_empty());
    assert!(!m.ensure_composed(&id).expect("again"), "composed once");
}
