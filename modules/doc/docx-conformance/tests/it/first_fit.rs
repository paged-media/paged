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

//! ADR 617 / engine ADR 1016 — Word's answer to the first-fit probe
//! (`fixtures/first-fit.word.json`, `scripts/word-first-fit-probe.sh`), held
//! against what the lowering hands the engine for `first_fit_docx()`.
//!
//! The engine composes each case and compares its lines with Word's in two
//! places: `paged-text/tests/word_first_fit.rs` (the breaks, word for word)
//! and `paged-renderer`'s `anchored` tests (a picture's line). The headless
//! lane (`packages/doc-bundle/test/headless/first-fit.spec.ts`) opens
//! `first_fit_docx()` through the bundle's standalone open on the real
//! engine and compares every paragraph's lines. What this file holds is the
//! lowering's half: every case reaches the engine as Word's first-fit at
//! the measure Word had, and a picture paragraph with the leadings the
//! engine's Word rule reads.

// `__feat__<id>` names link these tests to the Cockpit feature row.
#![allow(non_snake_case)]

use docx_conformance::{first_fit_cases, first_fit_docx, FIRST_FIT_FULL_MEASURE_PT};
use docx_lower::ir::{LoweredBlock, LoweredDoc, PropValue, StyleCollection};

fn answer() -> serde_json::Value {
    serde_json::from_str(include_str!("../../fixtures/first-fit.word.json"))
        .expect("first-fit.word.json")
}

/// A style property through the lowered `basedOn` chain.
fn resolved(doc: &LoweredDoc, style: Option<&str>, path: &str) -> Option<PropValue> {
    let mut next = style.map(str::to_string);
    for _ in 0..32 {
        let s = doc.styles.iter().find(|s| Some(&s.id) == next.as_ref())?;
        if let Some(p) = s.props.iter().rev().find(|p| p.path == path) {
            return Some(p.value.clone());
        }
        next = s.based_on.clone();
    }
    None
}

fn length(doc: &LoweredDoc, style: Option<&str>, path: &str) -> Option<f32> {
    match resolved(doc, style, path) {
        Some(PropValue::Length(v)) => Some(v),
        _ => None,
    }
}

/// Word's single line for Courier New 10 pt: hhea 2320/2048 em.
const SINGLE: f32 = 2320.0 / 2048.0 * 10.0;

#[test]
fn the_answer_is_for_the_cases_this_crate_builds__feat__plugin_doc_word_pagination() {
    let answer = answer();
    let cases = first_fit_cases();
    let rows = answer["cases"].as_array().unwrap();
    assert_eq!(rows.len(), cases.len(), "one answer per case");
    for (c, row) in cases.iter().zip(rows) {
        assert_eq!(row["label"], c.label.as_str());
        assert_eq!(row["align"], c.align);
        assert_eq!(row["text"], c.text.as_str());
        let m = row["measure_pt"].as_f64().unwrap() as f32;
        assert!((m - c.measure_pt).abs() < 1e-3, "{}", c.label);
        assert_eq!(row["picture"].is_null(), c.picture.is_none(), "{}", c.label);
        assert_eq!(row["spacing"].is_null(), c.spacing.is_none(), "{}", c.label);
        // Word set every case: each paragraph's lines are in the answer.
        let lines = row["word_lines"].as_array();
        assert!(lines.is_some_and(|l| !l.is_empty()), "{}", c.label);
    }
    assert_eq!(
        answer["fonts_in_pdf"], "CourierNewPSMT",
        "Word used the face"
    );
    // The engine's copy is the same file.
    assert_eq!(
        include_str!("../../fixtures/first-fit.word.json"),
        include_str!(
            "../../../../../engine/core/crates/paged-text/tests/fixtures/first-fit.word.json"
        ),
        "copy the answer to engine/core/crates/paged-text/tests/fixtures/ too"
    );
}

#[test]
fn every_case_reaches_the_engine_as_word_first_fit_at_words_measure__feat__plugin_doc_word_pagination(
) {
    let doc = docx_import::import_docx(&first_fit_docx()).expect("import");
    let lowered = docx_lower::lower(&doc);
    let cases = first_fit_cases();
    let paras: Vec<_> = lowered
        .story
        .blocks
        .iter()
        .map(|b| match b {
            LoweredBlock::Paragraph(p) => p,
            LoweredBlock::Table(_) => panic!("no tables in the fixture"),
        })
        .collect();
    assert_eq!(paras.len(), cases.len(), "one paragraph per case");
    for (c, p) in cases.iter().zip(&paras) {
        let style = p.para_style_id.as_deref();
        assert_eq!(
            resolved(&lowered, style, docx_lower::PARAGRAPH_COMPOSER),
            Some(PropValue::Text(docx_lower::WORD_FIRST_FIT_COMPOSER.into())),
            "{}",
            c.label
        );
        let right = length(&lowered, style, "paragraphRightIndent").unwrap_or(0.0);
        assert!(
            (FIRST_FIT_FULL_MEASURE_PT - right - c.measure_pt).abs() < 1e-3,
            "{}: measure {} vs Word's {}",
            c.label,
            FIRST_FIT_FULL_MEASURE_PT - right,
            c.measure_pt
        );
        let justification = resolved(&lowered, style, "paragraphJustification");
        let want = if c.align == "both" {
            "LeftJustified"
        } else {
            "LeftAlign"
        };
        assert_eq!(
            justification,
            Some(PropValue::Text(want.into())),
            "{}",
            c.label
        );
    }
}

/// A picture's line is the engine's Word rule over the paragraph's auto
/// leading (`anchored::line_object_shift`): the picture above the
/// baseline, the auto-leaded line's share below it under. So the lowering
/// gives each picture paragraph auto leading at Word's pitch (P01, P02,
/// P05–P07), or, at least 14 pt (P03), at the single line with the text
/// runs carrying the 14 pt; exactly 14 pt (P04) stays fixed, Word clips.
#[test]
fn a_picture_paragraph_carries_the_leadings_words_line_rule_needs__feat__plugin_doc_word_pagination(
) {
    let doc = docx_import::import_docx(&first_fit_docx()).expect("import");
    let lowered = docx_lower::lower(&doc);
    let cases = first_fit_cases();
    let mut checked = 0;
    for (c, block) in cases.iter().zip(&lowered.story.blocks) {
        let LoweredBlock::Paragraph(p) = block else {
            unreachable!()
        };
        if c.picture.is_none() {
            continue;
        }
        checked += 1;
        let style = p.para_style_id.as_deref();
        let leading = length(&lowered, style, "characterLeading");
        let auto = length(&lowered, style, "paragraphAutoLeading");
        let run_leadings: Vec<Option<f32>> = p
            .runs
            .iter()
            .filter(|r| !r.text.is_empty())
            .map(|r| {
                let id = r.char_style_id.as_deref()?;
                let s = lowered
                    .styles
                    .iter()
                    .find(|s| s.id == id && s.collection == StyleCollection::Character)?;
                s.props
                    .iter()
                    .find(|p| p.path == "characterLeading")
                    .and_then(|p| match p.value {
                        PropValue::Length(v) => Some(v),
                        _ => None,
                    })
            })
            .collect();
        match c.spacing {
            Some((280, "exact")) => {
                assert_eq!(leading, Some(14.0), "{}: fixed", c.label);
            }
            Some((280, "atLeast")) => {
                assert_eq!(leading, Some(0.0), "{}: auto", c.label);
                let pct = auto.expect("auto leading");
                assert!((pct - SINGLE * 10.0).abs() < 0.01, "{}: {pct}", c.label);
                assert!(
                    run_leadings.iter().all(|l| *l == Some(14.0)),
                    "{}: the text runs keep 14 pt, {run_leadings:?}",
                    c.label
                );
            }
            spacing => {
                let pitch = match spacing {
                    Some((360, "auto")) => SINGLE * 1.5,
                    None => SINGLE,
                    other => panic!("{other:?}"),
                };
                assert_eq!(leading, Some(0.0), "{}: auto", c.label);
                let pct = auto.expect("auto leading");
                assert!(
                    (pct - pitch * 10.0).abs() < 0.01,
                    "{}: {pct} vs {}",
                    c.label,
                    pitch * 10.0
                );
                assert!(run_leadings.iter().all(Option::is_none), "{}", c.label);
            }
        }
    }
    assert_eq!(checked, 7, "P01-P07");
}
