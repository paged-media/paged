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

//! Word's first-fit composer (`SingleLineOptions::word`, engine ADR 1016)
//! against Word's own line breaks: `fixtures/first-fit.word.json` is what
//! Microsoft Word 16 set for the doc module's `first_fit_docx()` probe
//! (`modules/doc/scripts/word-first-fit-probe.sh`), every line with its
//! words.
//!
//! Word set the probe in Courier New 10 pt, every glyph 1229/2048 em
//! (`char_pt`). The test sets the same texts in JetBrains Mono, every glyph
//! 0.6 em, at each case's measure scaled by the ratio of the two advances,
//! so a measure that ends 0.3 pt past a word in Word ends 0.3 pt past the
//! same word here: what is compared is the breaking rule, not the face.
//! The picture cases (P..) are the line-height rules of the renderer
//! (`paged-renderer`, `anchored::line_object_shift`); their words are
//! checked here too where the text alone decides them.

use paged_text::{
    layout_runs, Alignment, Face, LayoutOptions, ShapingFeatures, SingleLineOptions, StyledRun,
};
use serde_json::Value;

const CHAR: f32 = 6.0;

fn face_bytes() -> Vec<u8> {
    std::fs::read(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../corpus/fonts/JetBrainsMono-VF.ttf"),
    )
    .expect("corpus/fonts/JetBrainsMono-VF.ttf")
}

fn word_answer() -> Value {
    serde_json::from_str(include_str!("fixtures/first-fit.word.json")).expect("first-fit.word.json")
}

/// The lines `text` breaks into at `measure` pt, as text.
fn lines(text: &str, measure: f32, align: Alignment, sl: Option<SingleLineOptions>) -> Vec<String> {
    let bytes = face_bytes();
    let face = Face::from_slice(&bytes, 0).expect("parse JetBrains Mono");
    let run = StyledRun {
        text,
        face: &face,
        point_size: 10.0,
        tracking: None,
        font_id: 1,
        underline: false,
        strikethru: false,
        substituted: false,
        baseline_shift_pt: 0.0,
        horizontal_scale_pct: 100.0,
        vertical_scale_pct: 100.0,
        skew_deg: 0.0,
        fallback_faces: &[],
        shaping_features: ShapingFeatures::default(),
    };
    let mut opts = LayoutOptions::new(measure, 10.0);
    opts.alignment = align;
    opts.compose.single_line = sl;
    layout_runs(&[run], &opts)
        .lines
        .iter()
        .map(|l| text[l.byte_range.clone()].trim().to_string())
        .collect()
}

/// One case of the answer: its text set by `sl` at the case's measure,
/// and Word's lines, each as its words joined by a space.
fn case_lines(case: &Value, char_pt: f32, sl: SingleLineOptions) -> (Vec<String>, Vec<String>) {
    let text = case["text"].as_str().unwrap();
    let measure = case["measure_pt"].as_f64().unwrap() as f32 / char_pt * CHAR;
    let align = match case["align"].as_str().unwrap() {
        "both" => Alignment::Justify,
        _ => Alignment::Left,
    };
    let word: Vec<String> = case["word_lines"]
        .as_array()
        .expect("Word set every case")
        .iter()
        .map(|l| {
            l["words"]
                .as_array()
                .unwrap()
                .iter()
                .map(|w| w["t"].as_str().unwrap())
                .collect::<Vec<_>>()
                .join(" ")
        })
        .collect();
    (lines(text, measure, align, Some(sl)), word)
}

/// Every text case Word answered (R ragged fits, J justified, H breaks
/// inside a word, L words wider than the measure) breaks into Word's
/// lines, word for word.
#[test]
fn every_text_case_breaks_where_word_broke_it() {
    let answer = word_answer();
    let char_pt = answer["char_pt"].as_f64().unwrap() as f32;
    let mut checked = 0;
    let mut misses = Vec::new();
    for case in answer["cases"].as_array().unwrap() {
        if !case["picture"].is_null() || !case["spacing"].is_null() {
            continue;
        }
        let label = case["label"].as_str().unwrap();
        let (ours, word) = case_lines(case, char_pt, SingleLineOptions::word());
        checked += 1;
        if ours != word {
            misses.push(format!("{label}: ours {ours:?}\n      Word {word:?}"));
        }
    }
    assert_eq!(checked, 22, "the answer's single-spaced text cases");
    assert!(misses.is_empty(), "{}", misses.join("\n"));
}

/// The picture cases and the cases under 1.5-line, at-least and exact
/// spacing break where Word broke them too: line spacing never moves a
/// break. A picture's U+FFFC is no word of Word's PDF text; here it is a
/// glyph narrower than the 20 pt picture, which moves no break in these
/// texts (the picture's line holds at most 110 pt of a 120 pt measure).
#[test]
fn the_picture_and_spaced_cases_break_where_word_broke_them() {
    let answer = word_answer();
    let char_pt = answer["char_pt"].as_f64().unwrap() as f32;
    let mut checked = 0;
    let mut misses = Vec::new();
    for case in answer["cases"].as_array().unwrap() {
        if case["picture"].is_null() && case["spacing"].is_null() {
            continue;
        }
        let label = case["label"].as_str().unwrap();
        let (ours, word) = case_lines(case, char_pt, SingleLineOptions::word());
        let ours: Vec<String> = ours
            .iter()
            .map(|l| {
                l.split_whitespace()
                    .filter(|w| *w != "\u{FFFC}")
                    .collect::<Vec<_>>()
                    .join(" ")
            })
            .collect();
        checked += 1;
        if ours != word {
            misses.push(format!("{label}: ours {ours:?}\n      Word {word:?}"));
        }
    }
    assert_eq!(checked, 11, "the picture and spaced cases");
    assert!(misses.is_empty(), "{}", misses.join("\n"));
}

/// The rules Word's answer settled, each against the Single-line Composer
/// it was split from, so the IDML composer is seen not to move.
#[test]
fn a_justified_line_compresses_a_little_for_word_and_more_for_indesign() {
    let answer = word_answer();
    let char_pt = answer["char_pt"].as_f64().unwrap() as f32;
    let case = |label: &str| {
        answer["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["label"] == label)
            .unwrap()
            .clone()
    };
    // J02: 3 pt over 15 spaces. Word keeps "oo", compressed.
    let (ours, word) = case_lines(&case("J02"), char_pt, SingleLineOptions::word());
    assert_eq!(ours, word);
    assert!(ours[0].ends_with(" oo"), "{ours:?}");
    // J03: 8 pt over. Word wraps "oo"; the Single-line Composer, which
    // may compress a space to 80 %, keeps it.
    let (ours, word) = case_lines(&case("J03"), char_pt, SingleLineOptions::word());
    assert_eq!(ours, word);
    assert!(ours[0].ends_with(" nn"), "{ours:?}");
    let (indesign, _) = case_lines(&case("J03"), char_pt, SingleLineOptions::default());
    assert!(indesign[0].ends_with(" oo"), "{indesign:?}");
}

#[test]
fn a_dash_is_a_break_for_word_and_not_for_indesign() {
    let answer = word_answer();
    let char_pt = answer["char_pt"].as_f64().unwrap() as f32;
    for label in ["H03", "H04"] {
        let case = answer["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["label"] == label)
            .unwrap();
        let (ours, word) = case_lines(case, char_pt, SingleLineOptions::word());
        assert_eq!(ours, word, "{label}");
        // InDesign offered no break at a dash (`hard_hyphen_opportunities`):
        // the Single-line Composer keeps the dashed word whole.
        let (indesign, _) = case_lines(case, char_pt, SingleLineOptions::default());
        assert!(
            indesign[0].ends_with("eeee"),
            "{label}: InDesign {indesign:?}"
        );
    }
}
