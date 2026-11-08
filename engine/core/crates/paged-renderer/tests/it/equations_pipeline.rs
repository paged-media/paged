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

//! Engine ADR 1090 — an equation is a character of its line: it takes its
//! set width in the line, its rules and text are drawn where it landed, and
//! the text after it moves on by that width. Set in the `blank-paragraphs`
//! fixture's first frame ("A", "B" in Inter 10/12), with no math face at
//! hand: the run's face sets it, at TeX's constants.

use paged_compose::{DisplayCommand, PathSegment};
use paged_gen::samples::blank_paragraphs::story_id;
use paged_model::equation::math::{FracKind, Math, Node};
use paged_model::equation::Equation;
use paged_renderer::{pipeline, PipelineOptions};

fn inter_font() -> Vec<u8> {
    let p =
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../corpus/fonts/Inter.ttf");
    std::fs::read(&p).unwrap_or_else(|e| panic!("read Inter.ttf: {e}"))
}

fn document() -> paged_scene::Document {
    let bytes =
        paged_gen::write_idml(&paged_gen::samples::blank_paragraphs::build()).expect("idml");
    idml_import::import_idml_doc(&bytes).expect("import")
}

/// `a/b`, stacked.
fn fraction() -> Math {
    Math {
        display: false,
        body: vec![Node::Frac {
            num: vec![Node::run("a")],
            den: vec![Node::run("b")],
            kind: FracKind::Bar,
        }],
    }
}

fn build(doc: &paged_scene::Document) -> pipeline::BuiltDocument {
    let font = inter_font();
    let opts = PipelineOptions {
        font: Some(&font),
        ..PipelineOptions::default()
    };
    pipeline::build_document(doc, &opts).expect("build")
}

/// The first paragraph's ("A") first cluster's x and its line's baseline.
fn first_a(built: &pipeline::BuiltDocument) -> (f32, f32) {
    let lines = built.story_layout(&story_id(0));
    let line = lines
        .iter()
        .find(|l| l.paragraph_idx == 0)
        .expect("A's line");
    // The placeholder of an object is no character of the story; were it
    // listed, it would be at A's byte too, left of A.
    let x = line
        .clusters
        .iter()
        .filter(|c| c.byte == 0)
        .map(|c| c.x_pt)
        .fold(f32::MIN, f32::max);
    (x, line.baseline_y_pt)
}

/// Every filled rectangle on page 0 as `(x, y, w, h)`, page-local pt.
fn rects(built: &pipeline::BuiltDocument) -> Vec<(f32, f32, f32, f32)> {
    let list = &built.pages[0].list;
    let mut out = Vec::new();
    for c in &list.commands {
        let DisplayCommand::FillPath {
            path_id, transform, ..
        } = c
        else {
            continue;
        };
        let Some(path) = list.paths.get(*path_id) else {
            continue;
        };
        let pts: Vec<(f32, f32)> = path
            .segments
            .iter()
            .filter_map(|s| match *s {
                PathSegment::MoveTo { x, y } | PathSegment::LineTo { x, y } => {
                    Some(transform.apply(x, y))
                }
                _ => None,
            })
            .collect();
        if pts.len() != 4 || !matches!(path.segments.last(), Some(PathSegment::Close)) {
            continue;
        }
        let x0 = pts.iter().map(|p| p.0).fold(f32::MAX, f32::min);
        let x1 = pts.iter().map(|p| p.0).fold(f32::MIN, f32::max);
        let y0 = pts.iter().map(|p| p.1).fold(f32::MAX, f32::min);
        let y1 = pts.iter().map(|p| p.1).fold(f32::MIN, f32::max);
        out.push((x0, y0, x1 - x0, y1 - y0));
    }
    out
}

#[test]
fn an_equation_takes_its_width_in_the_line_and_draws_its_bar() {
    let plain = document();
    let before = build(&plain);
    let (x_before, baseline) = first_a(&before);

    let mut doc = plain.clone();
    let story = doc
        .stories
        .iter_mut()
        .find(|s| s.self_id == story_id(0))
        .expect("story 0");
    story.story.paragraphs[0].equations.push(Equation {
        offset: 0,
        math: fraction(),
    });
    let after = build(&doc);
    let (x_after, baseline_after) = first_a(&after);

    // The fraction stands before "A": "A" moves right by its width, a
    // letter's advance at most (a over b, Inter 10 pt in script size).
    let width = x_after - x_before;
    assert!(
        (2.0..10.0).contains(&width),
        "A moved by the fraction's width: {width}"
    );
    // A text-style fraction fits the 12 pt line: the baseline holds.
    assert!(
        (baseline_after - baseline).abs() < 0.01,
        "{baseline} -> {baseline_after}"
    );
    // The bar: TeX's rule (0.05 em = 0.5 pt) as wide as the fraction, at
    // the line's start, on the axis (0.25 em = 2.5 pt above the baseline).
    let bars: Vec<_> = rects(&after)
        .into_iter()
        .filter(|r| (r.3 - 0.5).abs() < 0.01)
        .collect();
    assert_eq!(bars.len(), 1, "one fraction bar: {bars:?}");
    let (bx, by, bw, _) = bars[0];
    assert!(
        (bx - x_before).abs() < 0.01,
        "bar at the pen: {bx} vs {x_before}"
    );
    assert!(
        (bw - width).abs() < 0.01,
        "bar as wide as the box: {bw} vs {width}"
    );
    assert!(
        (by + 0.25 - (baseline - 2.5)).abs() < 0.01,
        "bar centred on the axis: top {by}, baseline {baseline}"
    );
    // Its letters are drawn too: two more glyph fills than before.
    let fills = |b: &pipeline::BuiltDocument| {
        b.pages[0]
            .list
            .commands
            .iter()
            .filter(|c| matches!(c, DisplayCommand::FillPath { .. }))
            .count()
    };
    assert_eq!(fills(&after), fills(&before) + 3, "a, b and the bar");
}

#[test]
fn a_display_equation_rises_its_line() {
    // Display style: the fraction's parts in text size, shifted further.
    let mut doc = document();
    let story = doc
        .stories
        .iter_mut()
        .find(|s| s.self_id == story_id(0))
        .expect("story 0");
    let mut tall = fraction();
    tall.display = true;
    tall.body = vec![Node::Frac {
        num: tall.body.clone(),
        den: vec![Node::run("c")],
        kind: FracKind::Bar,
    }];
    story.story.paragraphs[0].equations.push(Equation {
        offset: 1,
        math: tall,
    });
    let plain = build(&document());
    let built = build(&doc);
    let (_, b0) = first_a(&plain);
    let (_, b1) = first_a(&built);
    // The nested display fraction reaches far above the 10 pt text, so the
    // line moves down to clear it (auto leading).
    assert!(b1 > b0 + 1.0, "the line grew: {b0} -> {b1}");
}
