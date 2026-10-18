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

//! How InDesign numbers footnotes (ADR 156), pinned against its PDFs of
//! `footnote-numbering.idml` and `footnote-restart.idml`: the notes of
//! each STORY are numbered through the story, restarting at each page
//! when `RestartNumbering` is `PageRestart`; the prefix and suffix stand
//! where `ShowPrefixSuffix` says.

use std::path::PathBuf;

use paged_gen::samples::footnote_numbering::{self as sample, Variant};
use paged_renderer::{pipeline, BytesResolver, PipelineOptions};

/// `(page, story, number as the note prints it, as the reference prints
/// it)` for every note, in page order, as InDesign 20.0.1 printed them.
fn notes(v: &Variant) -> Vec<(usize, String, String, String)> {
    let bytes = paged_gen::write_idml(&sample::build(v)).expect("write_idml");
    let document = idml_import::import_idml_doc(&bytes).expect("open");
    let mut resolver = BytesResolver::new();
    let inter = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../corpus/fonts/Inter.ttf");
    resolver.add_font("Inter", None, std::fs::read(inter).expect("Inter"));
    let opts = PipelineOptions {
        assets: Some(&resolver),
        ..PipelineOptions::default()
    };
    let built = pipeline::build_document(&document, &opts).expect("build");
    let options = &document.designmap.footnote_options;
    let mut out = Vec::new();
    for (page, p) in built.pages.iter().enumerate() {
        for note in &p.footnotes {
            let story = sample::stories()
                .iter()
                .find(|(name, _)| sample::story_id(v.sample, name) == note.host_story_id)
                .map(|(name, _)| name.to_string())
                .unwrap_or_default();
            out.push((
                page,
                story,
                options.text_label(note.number),
                options.reference_label(note.number),
            ));
        }
    }
    out.sort();
    out
}

fn row(page: usize, story: &str, text: &str, reference: &str) -> (usize, String, String, String) {
    (page, story.into(), text.into(), reference.into())
}

#[test]
fn notes_are_numbered_through_each_story() {
    assert_eq!(
        notes(&sample::NUMBERING),
        vec![
            row(0, "A", "[1]", "[1]"),
            row(0, "A", "[2]", "[2]"),
            row(0, "B", "[1]", "[1]"),
            row(0, "B", "[2]", "[2]"),
            row(1, "A", "[3]", "[3]"),
            row(1, "A", "[4]", "[4]"),
            row(1, "C", "[1]", "[1]"),
            row(1, "C", "[2]", "[2]"),
        ]
    );
}

#[test]
fn a_page_restart_numbers_each_page_of_a_story_from_one() {
    assert_eq!(
        notes(&sample::RESTART),
        vec![
            row(0, "A", "i", "(i)"),
            row(0, "A", "ii", "(ii)"),
            row(0, "B", "i", "(i)"),
            row(0, "B", "ii", "(ii)"),
            row(1, "A", "i", "(i)"),
            row(1, "A", "ii", "(ii)"),
            row(1, "C", "i", "(i)"),
            row(1, "C", "ii", "(ii)"),
        ]
    );
}
