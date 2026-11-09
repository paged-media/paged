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

//! Engine ADR 1061 — a shrink-to-fit frame sets its text smaller when it
//! does not fit: at the fit it names while the text fits there, else at the
//! first step below it that fits. Set on the `blank-paragraphs` fixture's
//! first frame (70 x 90 pt, "A" and "B" in Inter 10/12).

use paged_gen::samples::blank_paragraphs::story_id;
use paged_model::text_fit::ShrinkToFit;
use paged_renderer::diagnostics::DiagnosticCode;
use paged_renderer::{pipeline, PipelineOptions};

fn inter_font() -> Vec<u8> {
    let p =
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../corpus/fonts/Inter.ttf");
    std::fs::read(&p).unwrap_or_else(|e| panic!("read Inter.ttf: {e}"))
}

/// The fixture with frame 0's story `extra` paragraphs longer and frame 0
/// shrinking to `fit`.
fn document(fit: Option<ShrinkToFit>, extra: usize) -> paged_scene::Document {
    let bytes =
        paged_gen::write_idml(&paged_gen::samples::blank_paragraphs::build()).expect("idml");
    let mut doc = idml_import::import_idml_doc(&bytes).expect("import");
    let story = story_id(0);
    for s in &mut doc.spreads {
        for f in &mut s.spread.text_frames {
            if f.parent_story.as_deref() == Some(story.as_str()) {
                f.shrink_to_fit = fit;
            }
        }
    }
    let parsed = doc
        .stories
        .iter_mut()
        .find(|s| s.self_id == story)
        .expect("story");
    let a = parsed.story.paragraphs[0].clone();
    for _ in 0..extra {
        parsed.story.paragraphs.insert(1, a.clone());
    }
    doc.rebuild_indexes();
    doc
}

fn build(doc: &paged_scene::Document) -> pipeline::BuiltDocument {
    let font = inter_font();
    let opts = PipelineOptions {
        font: Some(&font),
        ..PipelineOptions::default()
    };
    pipeline::build_document(doc, &opts).expect("build")
}

/// Frame 0's line baselines, page pt.
fn baselines(built: &pipeline::BuiltDocument) -> Vec<f32> {
    built
        .story_layout(&story_id(0))
        .iter()
        .map(|l| l.baseline_y_pt)
        .collect()
}

fn overset(built: &pipeline::BuiltDocument) -> bool {
    built
        .diagnostics
        .items
        .iter()
        .any(|d| d.code == DiagnosticCode::OversetTextDropped)
}

#[test]
fn text_that_fits_at_its_saved_fit_keeps_it() {
    let plain = baselines(&build(&document(None, 0)));
    assert!((plain[1] - plain[0] - 12.0).abs() < 0.05, "{plain:?}");
    // No shrink is the text as written.
    let none = baselines(&build(&document(Some(ShrinkToFit::NONE), 0)));
    assert_eq!(none, plain);
    // A saved fit is kept while the text fits there, even with room to
    // spare: the leading follows the size and the line reduction.
    let half = baselines(&build(&document(Some(ShrinkToFit::new(0.5, 0.0)), 0)));
    assert!((half[1] - half[0] - 6.0).abs() < 0.05, "{half:?}");
    let reduced = baselines(&build(&document(Some(ShrinkToFit::new(0.5, 0.2)), 0)));
    assert!((reduced[1] - reduced[0] - 4.8).abs() < 0.05, "{reduced:?}");
}

#[test]
fn text_that_does_not_fit_steps_down_until_it_does() {
    // Fourteen lines at 12 pt do not fit a 90 pt frame.
    let grown = build(&document(None, 12));
    assert!(overset(&grown), "the long story oversets as written");
    let built = build(&document(Some(ShrinkToFit::NONE), 12));
    assert!(
        !overset(&built),
        "the shrunk story fits: {:?} {:?}",
        baselines(&built),
        built.diagnostics.items
    );
    let lines = baselines(&built);
    assert_eq!(lines.len(), 14);
    let pitch = lines[1] - lines[0];
    // A step of the ladder: smaller than written, and the largest that
    // fits (the step above it does not).
    let step = paged_model::text_fit::SHRINK_STEPS
        .iter()
        .find(|s| (12.0 * s.line_factor() - pitch).abs() < 0.05)
        .copied()
        .unwrap_or_else(|| panic!("pitch {pitch} is no step's"));
    assert!(step.is_below(&ShrinkToFit::NONE));
    let above = paged_model::text_fit::SHRINK_STEPS
        .iter()
        .rev()
        .find(|s| step.is_below(s))
        .copied()
        .expect("a step above");
    // Started from the step above, the text steps down to the same one.
    let from_above = baselines(&build(&document(Some(above), 12)));
    assert!(
        (from_above[1] - from_above[0] - pitch).abs() < 0.05,
        "{from_above:?}"
    );
}
