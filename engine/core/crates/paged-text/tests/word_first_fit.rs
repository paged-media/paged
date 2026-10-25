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
//! on real shaped text. JetBrains Mono advances every glyph 0.6 em, so a
//! line's natural width is its character count times 6 pt at 10 pt and
//! each measure below sits a few tenths of a point either side of a word
//! end: what is tested is the breaking rule, not the face.
//!
//! The rules are Word's documented behaviour for Word 2013+ layout
//! (compatibilityMode 15), the mode the doc module's `first_fit_docx()`
//! probe asks Word to confirm (`scripts/word-first-fit-probe.sh`): a word
//! stays on a line when its glyphs end on or before the margin (the
//! space after it may hang), justified lines are never compressed, a
//! hyphen the text has is an ordinary break, and a word wider than the
//! measure starts its own line and is split where it overflows.

use paged_text::{
    layout_runs, Alignment, Face, LayoutOptions, ShapingFeatures, SingleLineOptions, StyledRun,
};

const CHAR: f32 = 6.0;

fn face_bytes() -> Vec<u8> {
    std::fs::read(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../corpus/fonts/JetBrainsMono-VF.ttf"),
    )
    .expect("corpus/fonts/JetBrainsMono-VF.ttf")
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

fn word(text: &str, measure: f32, align: Alignment) -> Vec<String> {
    lines(text, measure, align, Some(SingleLineOptions::word()))
}

fn width(s: &str) -> f32 {
    s.chars().count() as f32 * CHAR
}

const RAGGED: &str = "R01 aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii jjjj kkkk llll";

#[test]
fn a_word_ending_on_or_inside_the_margin_stays() {
    let head = "R01 aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii";
    let l = word(RAGGED, width(head) + 0.3, Alignment::Left);
    assert_eq!(l[0], head);
    // The space after it does not fit and does not matter.
    let l = word(RAGGED, width(head) + 3.0, Alignment::Left);
    assert_eq!(l[0], head);
    let l = word(RAGGED, width(head) - 0.3, Alignment::Left);
    assert_eq!(l[0], "R01 aaaa bbbb cccc dddd eeee ffff gggg hhhh");
}

#[test]
fn a_justified_line_is_never_compressed() {
    let text = "J01 aa bb cc dd ee ff gg hh ii jj kk ll mm nn oo pp qq rr ss tt";
    let head = "J01 aa bb cc dd ee ff gg hh ii jj kk ll mm nn oo";
    let measure = width(head) - 0.5;
    // InDesign's Single-line Composer compresses its 14 spaces to keep
    // "oo"; Word wraps it.
    let indesign = lines(
        text,
        measure,
        Alignment::Justify,
        Some(SingleLineOptions::default()),
    );
    assert_eq!(indesign[0], head);
    let w = word(text, measure, Alignment::Justify);
    assert_eq!(w[0], "J01 aa bb cc dd ee ff gg hh ii jj kk ll mm nn");
}

#[test]
fn a_hyphen_in_the_text_is_an_ordinary_break() {
    let text = "H01 aaaa bbbb cccc dddd eeee well-known ffff gggg";
    let head = "H01 aaaa bbbb cccc dddd eeee well-";
    let l = word(text, width(head) + 0.3, Alignment::Left);
    assert_eq!(l[0], head);
    assert!(l[1].starts_with("known"), "{l:?}");
    // With the hyphen past the margin the compound wraps whole.
    let l = word(
        text,
        width("H01 aaaa bbbb cccc dddd eeee well") + 0.3,
        Alignment::Left,
    );
    assert_eq!(l[0], "H01 aaaa bbbb cccc dddd eeee");
}

#[test]
fn a_word_wider_than_the_measure_starts_a_line_and_splits_where_it_overflows() {
    let long: String = std::iter::repeat_n('x', 100).collect();
    let text = format!("L01 aa {long} bb cc");
    let l = word(&text, 468.0, Alignment::Left);
    assert_eq!(l[0], "L01 aa");
    assert_eq!(l[1].chars().count(), 78, "{l:?}");
    assert_eq!(l[2], format!("{} bb cc", "x".repeat(22)));
}
