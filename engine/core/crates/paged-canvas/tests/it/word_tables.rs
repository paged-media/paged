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

//! Engine ADR 1025 on the wire: a table laid out by Word's rules — rows
//! that split across frames (unless `cantSplit`), autofit columns, an
//! indent — and a row held at an exact height.

use paged_canvas::{CanvasModel, CanvasOptions, ElementId, Mutation, PageId, TextCellAddr};
use paged_mutate::operation::{CellWidthSpec, TableWidthSpec, WordTableSpec};

/// Two linked frames side by side, `(top, left, bottom, right)` each, and
/// their story.
fn two_frames() -> (CanvasModel, String) {
    let idml = paged_canvas::blank::blank_idml(612.0, 792.0);
    let inter = std::fs::read(
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../corpus/fonts/Inter.ttf"),
    )
    .expect("read Inter.ttf");
    let mut m = CanvasModel::load(
        "doc",
        &idml,
        CanvasOptions {
            fonts: vec![inter],
            ..CanvasOptions::default()
        },
    )
    .expect("load");
    let page = m.scene().spreads[0].spread.pages[0]
        .self_id
        .clone()
        .expect("page id");
    let mut frames = Vec::new();
    for bounds in [(36.0, 36.0, 236.0, 296.0), (36.0, 316.0, 236.0, 576.0)] {
        let out = m
            .apply_mutation(&Mutation::InsertTextFrame {
                page_id: PageId(page.clone()),
                bounds,
            })
            .expect("frame");
        let Some(ElementId::TextFrame(id)) = out.created_id else {
            panic!("expected a frame");
        };
        frames.push(id);
    }
    m.apply_mutation(&Mutation::LinkFrames {
        from: frames[0].clone(),
        to: frames[1].clone(),
    })
    .expect("link");
    let story = m.scene().spreads[0]
        .spread
        .text_frames
        .iter()
        .find(|f| f.self_id.as_deref() == Some(frames[0].as_str()))
        .and_then(|f| f.parent_story.clone())
        .expect("story");
    (m, story)
}

fn table(
    m: &mut CanvasModel,
    story: &str,
    widths: Vec<f32>,
    word: Option<WordTableSpec>,
) -> String {
    let out = m
        .apply_mutation(&Mutation::InsertTable {
            story_id: story.into(),
            rows: 1,
            cols: widths.len() as u32,
            header_rows: 0,
            footer_rows: 0,
            column_widths: widths,
            row_heights: Vec::new(),
            cell: None,
            word,
            paragraph: None,
        })
        .expect("table");
    match out.created_id {
        Some(ElementId::Table { table_id, .. }) => table_id,
        other => panic!("expected a table, got {other:?}"),
    }
}

fn fill(m: &mut CanvasModel, story: &str, table: &str, col: u32, text: &str) {
    m.apply_mutation(&Mutation::InsertText {
        story_id: story.into(),
        offset: 0,
        text: text.into(),
        cell: Some(TextCellAddr {
            table_id: table.into(),
            row: 0,
            col,
        }),
    })
    .expect("cell text");
}

/// The page-local rects `[x, y, w, h]` drawn for cell `(0, col)`.
fn rects(m: &CanvasModel, table: &str, col: u32) -> Vec<[f32; 4]> {
    m.built()
        .pages
        .iter()
        .flat_map(|p| &p.cell_rects)
        .filter(|c| c.table_id == table && c.row == 0 && c.col == col)
        .map(|c| c.rect)
        .collect()
}

fn cell_lines(m: &CanvasModel, story: &str) -> Vec<f32> {
    m.built()
        .story_layout(story)
        .iter()
        .filter(|l| l.cell.is_some())
        .map(|l| l.clusters.first().map_or(f32::NAN, |c| c.x_pt))
        .collect()
}

fn long_text() -> String {
    (0..30)
        .map(|i| format!("Paragraph {i} of a cell that is taller than its frame."))
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
fn a_word_row_splits_across_frames_and_an_indesign_row_does_not() {
    let (mut m, story) = two_frames();
    let t = table(&mut m, &story, vec![240.0], Some(WordTableSpec::default()));
    fill(&mut m, &story, &t, 0, &long_text());
    let pieces = rects(&m, &t, 0);
    assert_eq!(pieces.len(), 2, "{pieces:?}");
    assert!(pieces[0][0] < 100.0 && pieces[1][0] > 300.0, "{pieces:?}");
    let xs = cell_lines(&m, &story);
    let left = xs.iter().filter(|x| **x < 300.0).count();
    let right = xs.iter().filter(|x| **x > 300.0).count();
    assert!(left > 5 && right > 5, "lines {left} + {right}");

    // InDesign's rule: the row never splits; it stays in its frame and the
    // lines past the frame are overset, none continues in the next.
    let (mut m2, story2) = two_frames();
    let t2 = table(&mut m2, &story2, vec![240.0], None);
    fill(&mut m2, &story2, &t2, 0, &long_text());
    assert!(cell_lines(&m2, &story2).iter().all(|x| *x < 300.0));
    assert!(rects(&m2, &t2, 0).len() == 1);
}

#[test]
fn a_cant_split_row_moves_whole() {
    let (mut m, story) = two_frames();
    let spec = WordTableSpec {
        cant_split_rows: vec![0],
        ..WordTableSpec::default()
    };
    let t = table(&mut m, &story, vec![240.0], Some(spec));
    fill(&mut m, &story, &t, 0, &long_text());
    assert!(rects(&m, &t, 0).len() <= 1);
}

#[test]
fn an_autofit_column_grows_to_its_longest_word() {
    let (mut m, story) = two_frames();
    let spec = WordTableSpec {
        autofit: true,
        ..WordTableSpec::default()
    };
    let t = table(&mut m, &story, vec![20.0, 220.0], Some(spec));
    fill(&mut m, &story, &t, 0, "Incomprehensibilities");
    fill(&mut m, &story, &t, 1, "short");
    let c0 = rects(&m, &t, 0)[0];
    let c1 = rects(&m, &t, 1)[0];
    assert!(c0[2] > 60.0, "column 0 {c0:?}");
    assert!((c0[2] + c1[2] - 240.0).abs() < 0.5, "{c0:?} {c1:?}");
    // A fixed table keeps its grid.
    let (mut m2, story2) = two_frames();
    let t2 = table(
        &mut m2,
        &story2,
        vec![20.0, 220.0],
        Some(WordTableSpec::default()),
    );
    fill(&mut m2, &story2, &t2, 0, "Incomprehensibilities");
    assert!((rects(&m2, &t2, 0)[0][2] - 20.0).abs() < 0.01);
}

#[test]
fn a_percent_wide_table_scales_its_columns() {
    let (mut m, story) = two_frames();
    let spec = WordTableSpec {
        autofit: true,
        width: Some(TableWidthSpec::Percent(50.0)),
        cell_widths: vec![CellWidthSpec {
            row: 0,
            col: 1,
            width: TableWidthSpec::Points(60.0),
        }],
        ..WordTableSpec::default()
    };
    let t = table(&mut m, &story, vec![60.0, 0.0], Some(spec));
    let total = rects(&m, &t, 0)[0][2] + rects(&m, &t, 1)[0][2];
    assert!(
        (total - 130.0).abs() < 0.5,
        "half of the 260 pt column: {total}"
    );
}

#[test]
fn an_indented_table_stands_in_from_its_column() {
    let x = |indent: f32| {
        let (mut m, story) = two_frames();
        let spec = WordTableSpec {
            indent,
            ..WordTableSpec::default()
        };
        let t = table(&mut m, &story, vec![100.0], Some(spec));
        rects(&m, &t, 0)[0][0]
    };
    assert!((x(30.0) - x(0.0) - 30.0).abs() < 0.01);
}

#[test]
fn an_exact_row_keeps_its_height() {
    let (mut m, story) = two_frames();
    let t = table(&mut m, &story, vec![200.0], Some(WordTableSpec::default()));
    fill(&mut m, &story, &t, 0, "one\ntwo\nthree\nfour");
    let grown = rects(&m, &t, 0)[0][3];
    m.apply_mutation(&Mutation::SetRowHeight {
        story_id: story.clone(),
        table_id: t.clone(),
        row: 0,
        height: Some(20.0),
        auto_grow: Some(false),
    })
    .expect("exact row");
    assert!((rects(&m, &t, 0)[0][3] - 20.0).abs() < 0.01);
    m.undo().expect("undo");
    assert!((rects(&m, &t, 0)[0][3] - grown).abs() < 0.01);
}

#[test]
fn a_split_row_continues_under_the_repeated_header() {
    let (mut m, story) = two_frames();
    let out = m
        .apply_mutation(&Mutation::InsertTable {
            story_id: story.clone(),
            rows: 2,
            cols: 1,
            header_rows: 1,
            footer_rows: 0,
            column_widths: vec![240.0],
            row_heights: Vec::new(),
            cell: None,
            word: Some(WordTableSpec::default()),
            paragraph: None,
        })
        .expect("table");
    let Some(ElementId::Table { table_id: t, .. }) = out.created_id else {
        panic!("table");
    };
    fill(&mut m, &story, &t, 0, "Head");
    m.apply_mutation(&Mutation::InsertText {
        story_id: story.clone(),
        offset: 0,
        text: long_text(),
        cell: Some(TextCellAddr {
            table_id: t.clone(),
            row: 1,
            col: 0,
        }),
    })
    .expect("body text");
    let header = rects(&m, &t, 0);
    assert_eq!(
        header.len(),
        2,
        "the header repeats in the second frame: {header:?}"
    );
    let body: Vec<_> = m.built().pages[0]
        .cell_rects
        .iter()
        .filter(|c| c.table_id == t && c.row == 1)
        .map(|c| c.rect)
        .collect();
    assert_eq!(body.len(), 2);
    assert!(
        body[1][1] > header[1][1],
        "the continued row stands under the header"
    );
}
