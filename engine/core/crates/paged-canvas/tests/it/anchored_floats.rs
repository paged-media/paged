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

//! Engine ADR 1050 on the wire: an anchored object that wraps the text of
//! its story, sits behind it or keeps clear of other floats; an anchored
//! TEXT frame with a story of its own; a table nested in a cell; a picture
//! and a float in a table cell.

use paged_canvas::{CanvasModel, CanvasOptions, ElementId, Mutation, PageId, TextCellAddr};
use paged_mutate::operation::{AnchoredFrameInsertKind, AnchoredLayoutSpec, AnchoredWrapSpec};
use paged_mutate::{PropertyPath as P, Value as V};

const LOREM: &str = "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do \
eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis \
nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. ";

fn model_with(text: &str) -> (CanvasModel, String) {
    let idml = paged_canvas::blank::blank_idml(612.0, 792.0);
    let inter = std::fs::read(
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../corpus/fonts/Inter.ttf"),
    )
    .expect("read Inter.ttf");
    let opts = CanvasOptions {
        fonts: vec![inter],
        ..CanvasOptions::default()
    };
    let mut m = CanvasModel::load("doc", &idml, opts).expect("load");
    let page = m.scene().spreads[0].spread.pages[0]
        .self_id
        .clone()
        .expect("page id");
    let out = m
        .apply_mutation(&Mutation::InsertTextFrame {
            page_id: PageId(page),
            bounds: (36.0, 36.0, 576.0, 756.0),
        })
        .expect("frame");
    let Some(ElementId::TextFrame(frame)) = out.created_id else {
        panic!("expected a text frame, got {:?}", out.created_id);
    };
    let story = m.scene().spreads[0]
        .spread
        .text_frames
        .iter()
        .find(|f| f.self_id.as_deref() == Some(frame.as_str()))
        .and_then(|f| f.parent_story.clone())
        .expect("minted story");
    if !text.is_empty() {
        m.apply_mutation(&Mutation::InsertText {
            story_id: story.clone(),
            offset: 0,
            text: text.into(),
            cell: None,
        })
        .expect("insert text");
    }
    (m, story)
}

fn set(m: &mut CanvasModel, id: &ElementId, path: P, value: V) {
    m.apply_mutation(&Mutation::SetElementProperty {
        element_id: id.clone(),
        path,
        value,
    })
    .unwrap_or_else(|e| panic!("set {path:?}: {e:?}"));
}

/// A `w` × `h` float in the story's first paragraph, its top-left at the
/// column's left edge and the first line's top of leading.
fn float(m: &mut CanvasModel, story: &str, w: f32, h: f32, layout: AnchoredLayoutSpec) -> String {
    let out = m
        .apply_mutation(&Mutation::InsertAnchoredFrame {
            story_id: story.into(),
            offset: 0,
            width: w,
            height: h,
            image_uri: None,
            paragraph: Some(0),
            kind: None,
            layout: Some(layout),
            cell: None,
        })
        .expect("insert float");
    let Some(ElementId::Rectangle(id)) = out.created_id else {
        panic!("expected the float's id, got {:?}", out.created_id);
    };
    let el = ElementId::Rectangle(id.clone());
    set(m, &el, P::AnchoredPosition, V::Text("Anchored".into()));
    set(m, &el, P::AnchorPoint, V::Text("TopLeftAnchor".into()));
    set(
        m,
        &el,
        P::AnchoredHorizontalReference,
        V::Text("ColumnEdge".into()),
    );
    set(
        m,
        &el,
        P::AnchoredVerticalReference,
        V::Text("TopOfLeading".into()),
    );
    id
}

fn wrap(mode: &str, offsets: [f32; 4]) -> AnchoredLayoutSpec {
    AnchoredLayoutSpec {
        wrap: Some(AnchoredWrapSpec {
            mode: mode.into(),
            offsets,
            side: None,
            polygon: Vec::new(),
        }),
        ..AnchoredLayoutSpec::default()
    }
}

/// `(baseline, first character's x)` of every body line of `story`.
fn lines(m: &CanvasModel, story: &str) -> Vec<(f32, f32)> {
    m.built()
        .story_layout(story)
        .iter()
        .filter(|l| l.cell.is_none())
        .map(|l| {
            (
                l.baseline_y_pt,
                l.clusters.first().map_or(f32::NAN, |c| c.x_pt),
            )
        })
        .collect()
}

#[test]
fn a_float_with_a_bounding_box_wrap_narrows_its_own_paragraphs_lines() {
    let text = LOREM.repeat(12);
    let (mut m, story) = model_with(&text);
    let before = lines(&m, &story);
    assert!(before.iter().all(|(_, x)| *x < 40.0), "{before:?}");
    float(
        &mut m,
        &story,
        200.0,
        100.0,
        wrap("BoundingBoxTextWrap", [0.0, 0.0, 0.0, 10.0]),
    );
    let after = lines(&m, &story);
    let top = after[0].0 - 20.0;
    let beside: Vec<_> = after.iter().filter(|(b, _)| *b < top + 100.0).collect();
    let below: Vec<_> = after
        .iter()
        .filter(|(b, _)| *b > top + 100.0 + 30.0)
        .collect();
    assert!(beside.len() >= 4, "lines beside the float: {after:?}");
    for (b, x) in &beside {
        assert!(*x >= 36.0 + 200.0 + 10.0 - 0.5, "line at {b} starts at {x}");
    }
    assert!(!below.is_empty());
    for (b, x) in &below {
        assert!(*x < 40.0, "line at {b} below the float starts at {x}");
    }
    // Undo takes the float, and its wrap, away.
    m.undo().expect("undo layout");
    for _ in 0..4 {
        m.undo().expect("undo the settings");
    }
    assert_eq!(lines(&m, &story).len(), before.len());
}

#[test]
fn a_jump_object_float_moves_the_lines_below_it() {
    let text = LOREM.repeat(6);
    let (mut m, story) = model_with(&text);
    float(
        &mut m,
        &story,
        300.0,
        120.0,
        wrap("JumpObjectTextWrap", [0.0, 0.0, 6.0, 0.0]),
    );
    let after = lines(&m, &story);
    let first = after[0].0;
    // The first line stands below the object: its top of leading was the
    // object's top, so the object's height and bottom offset push it down.
    assert!(first > 36.0 + 120.0 + 6.0, "first baseline {first}");
}

#[test]
fn a_float_without_layout_does_not_wrap() {
    let text = LOREM.repeat(6);
    let (mut m, story) = model_with(&text);
    let before = lines(&m, &story);
    float(&mut m, &story, 200.0, 100.0, AnchoredLayoutSpec::default());
    assert_eq!(lines(&m, &story), before);
}

#[test]
fn a_float_that_may_not_overlap_moves_below_the_one_before() {
    let first_baseline = |allow: Option<bool>| {
        let (mut m, story) = model_with(&LOREM.repeat(4));
        for _ in 0..2 {
            let layout = AnchoredLayoutSpec {
                allow_overlap: allow,
                ..wrap("JumpObjectTextWrap", [0.0; 4])
            };
            float(&mut m, &story, 100.0, 50.0, layout);
        }
        lines(&m, &story)[0].0
    };
    let stacked = first_baseline(Some(false));
    let overlapping = first_baseline(None);
    // Overlapping, both stand at the first line's top and the text jumps
    // the 50 pt; kept apart, the second stands under the first and the
    // text jumps both.
    assert!(
        overlapping > 36.0 + 50.0 && overlapping < 36.0 + 100.0,
        "{overlapping}"
    );
    assert!(stacked > 36.0 + 100.0, "{stacked}");
}

#[test]
fn an_anchored_text_frame_holds_a_story_of_its_own() {
    let (mut m, story) = model_with("Body text.");
    let out = m
        .apply_mutation(&Mutation::Batch {
            ops: vec![
                Mutation::InsertAnchoredFrame {
                    story_id: story.clone(),
                    offset: 0,
                    width: 160.0,
                    height: 80.0,
                    image_uri: None,
                    paragraph: Some(0),
                    kind: Some(AnchoredFrameInsertKind::Text),
                    layout: Some(AnchoredLayoutSpec {
                        insets: Some([4.0, 6.0, 4.0, 6.0]),
                        ..AnchoredLayoutSpec::default()
                    }),
                    cell: None,
                },
                Mutation::BindCreated {
                    handle: "box".into(),
                },
                Mutation::InsertText {
                    story_id: "$h:box".into(),
                    offset: 0,
                    text: "Inside the box".into(),
                    cell: None,
                },
            ],
        })
        .expect("text box batch");
    let _ = out;
    let host = &m
        .scene()
        .stories
        .iter()
        .find(|s| s.self_id == story)
        .expect("host")
        .story
        .paragraphs[0];
    let af = &host.anchored_frames[0];
    assert_eq!(af.frame_kind, paged_model::AnchoredFrameKind::TextFrame);
    let own = af.parent_story.clone().expect("the box's story");
    assert_ne!(own, story);
    let own_story = m
        .scene()
        .stories
        .iter()
        .find(|s| s.self_id == own)
        .expect("the box's story exists");
    let text: String = own_story.story.paragraphs[0]
        .runs
        .iter()
        .map(|r| r.text.as_str())
        .collect();
    assert_eq!(text, "Inside the box");
    // Its lines are laid out as its story's, inside the insets.
    let box_lines = m.built().story_layout(&own);
    assert_eq!(box_lines.len(), 1, "{box_lines:?}");
    let x = box_lines[0].clusters[0].x_pt;
    assert!(x >= 36.0 + 6.0 - 0.5, "first character at {x}");
    // Undo removes the frame AND the story it minted.
    m.undo().expect("undo");
    assert!(m.scene().stories.iter().all(|s| s.self_id != own));
}

fn table(m: &mut CanvasModel, story: &str, cell: Option<TextCellAddr>, widths: Vec<f32>) -> String {
    let out = m
        .apply_mutation(&Mutation::InsertTable {
            story_id: story.into(),
            rows: 1,
            cols: widths.len() as u32,
            header_rows: 0,
            footer_rows: 0,
            column_widths: widths,
            row_heights: Vec::new(),
            cell,
            word: None,
            paragraph: None,
        })
        .expect("insert table");
    match out.created_id {
        Some(ElementId::Table { table_id, .. }) => table_id,
        other => panic!("expected a table, got {other:?}"),
    }
}

fn row_height(m: &CanvasModel, table: &str) -> f32 {
    m.built()
        .pages
        .iter()
        .flat_map(|p| &p.cell_rects)
        .filter(|c| c.table_id == table && c.row == 0 && c.col == 0)
        .map(|c| c.rect[3])
        .next()
        .expect("the cell's rect")
}

#[test]
fn a_table_nested_in_a_cell_is_made_and_filled_through_its_own_id() {
    let (mut m, story) = model_with("");
    let outer = table(&mut m, &story, None, vec![300.0, 200.0]);
    let empty = row_height(&m, &outer);
    let at = TextCellAddr {
        table_id: outer.clone(),
        row: 0,
        col: 0,
    };
    let inner = table(&mut m, &story, Some(at), vec![120.0, 120.0]);
    for (col, text) in [(0, "one"), (1, "two")] {
        m.apply_mutation(&Mutation::InsertText {
            story_id: story.clone(),
            offset: 0,
            text: text.into(),
            cell: Some(TextCellAddr {
                table_id: inner.clone(),
                row: 0,
                col,
            }),
        })
        .expect("text into the nested cell");
    }
    let host = m
        .scene()
        .stories
        .iter()
        .find(|s| s.self_id == story)
        .expect("story");
    let nested = paged_model::table_in(&host.story.paragraphs, &inner).expect("nested table");
    let texts: Vec<String> = nested
        .cells
        .iter()
        .map(|c| {
            c.paragraphs
                .iter()
                .flat_map(|p| &p.runs)
                .map(|r| r.text.clone())
                .collect()
        })
        .collect();
    assert_eq!(texts, ["one", "two"]);
    assert!(
        paged_model::table_in(&host.story.paragraphs[..0], &inner).is_none()
            && host.story.paragraphs.len() == 1,
        "the nested table lives in the outer cell, not in the story's body"
    );
    assert!(
        row_height(&m, &outer) > empty,
        "the outer row grows to hold it"
    );
    // Undo the two texts and the nested table: the outer cell is empty again.
    for _ in 0..3 {
        m.undo().expect("undo");
    }
    let host = m
        .scene()
        .stories
        .iter()
        .find(|s| s.self_id == story)
        .expect("story");
    assert!(paged_model::table_in(&host.story.paragraphs, &inner).is_none());
}

#[test]
fn a_picture_in_a_cell_grows_its_row_and_is_drawn() {
    let (mut m, story) = model_with("");
    let t = table(&mut m, &story, None, vec![200.0, 200.0]);
    let empty = row_height(&m, &t);
    m.apply_mutation(&Mutation::InsertAnchoredFrame {
        story_id: story.clone(),
        offset: 0,
        width: 80.0,
        height: 60.0,
        image_uri: None,
        paragraph: Some(0),
        kind: None,
        layout: None,
        cell: Some(TextCellAddr {
            table_id: t.clone(),
            row: 0,
            col: 0,
        }),
    })
    .expect("a picture into the cell");
    let grown = row_height(&m, &t);
    assert!(grown >= 60.0 && grown > empty, "row {empty} → {grown}");
    // Removing it (undo) shrinks the row back.
    m.undo().expect("undo");
    assert!((row_height(&m, &t) - empty).abs() < 0.01);
}

/// A fresh id sees the frames already in cells: a second picture put into
/// another cell, in a step of its own, does not take the first one's id
/// (the minter's scan stopped at the story's own paragraphs, so a real
/// document's second table of pictures was refused whole as a duplicate).
#[test]
fn a_second_picture_in_a_cell_takes_a_fresh_id() {
    let (mut m, story) = model_with("");
    let t = table(&mut m, &story, None, vec![200.0, 200.0]);
    for col in 0..2 {
        m.apply_mutation(&Mutation::InsertAnchoredFrame {
            story_id: story.clone(),
            offset: 0,
            width: 40.0,
            height: 30.0,
            image_uri: None,
            paragraph: Some(0),
            kind: None,
            layout: None,
            cell: Some(TextCellAddr {
                table_id: t.clone(),
                row: 0,
                col,
            }),
        })
        .unwrap_or_else(|e| panic!("a picture into cell {col}: {e:?}"));
    }
    let table = m
        .scene()
        .stories
        .iter()
        .find(|s| s.self_id == story)
        .unwrap()
        .story
        .paragraphs
        .iter()
        .find_map(|p| p.table.as_ref())
        .expect("the table");
    let ids: Vec<&str> = table
        .cells
        .iter()
        .flat_map(|c| &c.paragraphs)
        .flat_map(|p| &p.anchored_frames)
        .filter_map(|a| a.self_id.as_deref())
        .collect();
    assert_eq!(ids.len(), 2, "{ids:?}");
    assert_ne!(ids[0], ids[1]);
}

#[test]
fn a_nested_table_takes_the_cell_paragraph_it_names() {
    let (mut m, story) = model_with("");
    let outer = table(&mut m, &story, None, vec![300.0]);
    let at = TextCellAddr {
        table_id: outer.clone(),
        row: 0,
        col: 0,
    };
    m.apply_mutation(&Mutation::InsertText {
        story_id: story.clone(),
        offset: 0,
        text: "before\n\nafter".into(),
        cell: Some(at.clone()),
    })
    .expect("cell text");
    let out = m
        .apply_mutation(&Mutation::InsertTable {
            story_id: story.clone(),
            rows: 1,
            cols: 1,
            header_rows: 0,
            footer_rows: 0,
            column_widths: vec![100.0],
            row_heights: Vec::new(),
            cell: Some(at),
            paragraph: Some(1),
            word: None,
        })
        .expect("nested table on the empty middle paragraph");
    let Some(ElementId::Table {
        table_id: inner, ..
    }) = out.created_id
    else {
        panic!("a table");
    };
    let host = m
        .scene()
        .stories
        .iter()
        .find(|s| s.self_id == story)
        .expect("story");
    let cell = paged_model::cell_paragraphs_in(&host.story.paragraphs, &outer, 0, 0).expect("cell");
    assert_eq!(cell.len(), 3);
    assert_eq!(
        cell[1].table.as_ref().and_then(|t| t.self_id.as_deref()),
        Some(inner.as_str())
    );
}
