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

//! The structure reader (publish ADR 660) against InDesign. Every sample
//! of the engine's generated corpus exists twice: as the IDML the engine
//! builds (`paged-gen`) and as the PDF InDesign exported from it
//! (`engine/core/corpus/generated/<name>.pdf`). Reading the PDF back must
//! give the sample's words and its threads — the document, not a picture
//! of it.

use std::collections::BTreeMap;

use pdf_import::reconstruct::{reconstruct, FontBook, Recipe};

fn corpus_pdf(name: &str) -> Option<Vec<u8>> {
    let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../../engine/core/corpus/generated")
        .join(format!("{name}.pdf"));
    std::fs::read(p).ok()
}

fn sample(name: &str) -> paged_scene::Document {
    let s = paged_gen::samples::build(name).expect("a sample");
    let bytes = paged_gen::write_idml(&s).expect("idml");
    idml_import::import_idml_doc(&bytes).expect("imports")
}

/// The words of every story a page frame shows (master stories left out:
/// a PDF repeats them per page), as a multiset.
fn words(doc: &paged_scene::Document) -> BTreeMap<String, usize> {
    let mut on_pages = std::collections::BTreeSet::new();
    for sp in &doc.spreads {
        for tf in &sp.spread.text_frames {
            if let Some(s) = &tf.parent_story {
                on_pages.insert(s.clone());
            }
        }
    }
    let mut out = BTreeMap::new();
    for st in &doc.stories {
        if !on_pages.contains(&st.self_id) {
            continue;
        }
        for p in &st.story.paragraphs {
            // A discretionary hyphen is invisible where it does not break
            // the line: the PDF cannot say where the sample had one.
            let text: String = p
                .runs
                .iter()
                .map(|r| r.text.as_str())
                .collect::<String>()
                .replace('\u{ad}', "");
            for w in text
                .split(|c: char| c.is_whitespace() || c == '\u{2028}' || c.is_control())
                .map(|w| {
                    w.trim_matches(|c: char| !c.is_alphanumeric())
                        .to_lowercase()
                })
                .filter(|w| w.chars().any(|c| c.is_alphabetic()))
            {
                *out.entry(w).or_insert(0) += 1;
            }
        }
    }
    out
}

/// How much of `want` the read gives back (recall): the sample's words
/// found in the read, over the sample's. A PDF repeats master text on every
/// page and shows table cells the sample's page stories do not hold, so
/// words the read has beyond the sample's are not counted against it.
fn overlap(want: &BTreeMap<String, usize>, got: &BTreeMap<String, usize>) -> f32 {
    let total_w: usize = want.values().sum();
    let matched: usize = want
        .iter()
        .map(|(w, n)| (*n).min(*got.get(w).unwrap_or(&0)))
        .sum();
    matched as f32 / total_w.max(1) as f32
}

fn links(doc: &paged_scene::Document) -> usize {
    doc.spreads
        .iter()
        .flat_map(|s| s.spread.text_frames.iter())
        .filter(|f| f.next_text_frame.as_deref().is_some_and(|n| n != "n"))
        .count()
}

fn read(name: &str) -> Option<(paged_scene::Document, paged_scene::Document)> {
    let pdf = corpus_pdf(name)?;
    let r = reconstruct(&pdf, &Recipe::default(), &FontBook::default()).expect("reads");
    Some((sample(name), r.document))
}

/// The words come back: InDesign's PDF of each sample reads back to the
/// sample's own text.
#[test]
fn text_reads_back() {
    // name → the least share of words the read must give back. A sample
    // whose story oversets (composer, column-rules) has words InDesign never
    // drew; its floor is what the PDF shows, and column-rules (half its
    // text overset) is left out.
    let cases = [
        ("chain-widths", 0.97),
        ("annual-base", 0.90),
        ("composer", 0.95),
        ("justified-breaks", 0.95),
        ("forced-line-break", 0.95),
        ("hard-hyphen", 0.95),
        ("soft-hyphens", 0.95),
        ("mixed-leading", 0.95),
        ("paragraph-attrs", 0.90),
        ("keeps", 0.95),
    ];
    let mut report = Vec::new();
    for (name, floor) in cases {
        let Some((want, got)) = read(name) else {
            eprintln!("{name}: no PDF in the corpus, skipped");
            continue;
        };
        let (w, g) = (words(&want), words(&got));
        let score = overlap(&w, &g);
        if std::env::var_os("RECON_DEBUG").is_some() {
            let missing: Vec<_> = w
                .iter()
                .filter(|(k, n)| g.get(*k).copied().unwrap_or(0) < **n)
                .take(40)
                .collect();
            let extra: Vec<_> = g
                .iter()
                .filter(|(k, n)| w.get(*k).copied().unwrap_or(0) < **n)
                .take(40)
                .collect();
            eprintln!(
                "{name}: want {} got {}\n missing {missing:?}\n extra {extra:?}",
                w.values().sum::<usize>(),
                g.values().sum::<usize>()
            );
        }
        report.push(format!("{name}: {score:.3} (floor {floor})"));
        assert!(
            score >= floor,
            "{name}: {score:.3} of the words read back, floor {floor}\n{report:#?}"
        );
    }
    eprintln!("{report:#?}");
}

/// The threads come back: a story InDesign threads through several frames
/// reads back as one story through as many frames.
#[test]
fn threads_read_back() {
    let Some((want, got)) = read("chain-widths") else {
        return;
    };
    if std::env::var_os("RECON_DEBUG").is_some() {
        for (label, d) in [("want", &want), ("got", &got)] {
            for (i, sp) in d.spreads.iter().enumerate() {
                for tf in &sp.spread.text_frames {
                    eprintln!(
                        "{label} spread {i} frame {:?} {:?} story {:?} next {:?}",
                        tf.self_id, tf.bounds, tf.parent_story, tf.next_text_frame
                    );
                }
            }
        }
    }
    assert_eq!(links(&got), links(&want), "thread links");
}

/// Facing pages: a PDF exported as spreads reads back as spreads of two
/// pages, and every page of the PDF is a page of the document.
#[test]
fn page_count_matches() {
    for name in ["chain-widths", "annual-base", "keeps"] {
        let Some((want, got)) = read(name) else {
            continue;
        };
        let pages = |d: &paged_scene::Document| {
            d.spreads
                .iter()
                .map(|s| s.spread.pages.len())
                .sum::<usize>()
        };
        assert_eq!(pages(&got), pages(&want), "{name}: pages");
    }
}
