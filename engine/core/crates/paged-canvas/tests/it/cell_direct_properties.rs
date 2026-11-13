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
//! Engine ADR 1098 — a table cell's text takes direct character and
//! paragraph properties through a cell-qualified `storyRange`. Before it,
//! the only door into a cell's text was `applyStyle`, so the modules minted
//! a named style for every distinct cell formatting. Every case writes a
//! cell whose offsets overlap real body text: the body stays as it was,
//! the cell's runs and paragraphs carry the values, a read of the same
//! range answers them, undo restores the cell, and IDML export writes them
//! as local overrides on the cell's ranges (what InDesign writes).

use std::io::Cursor;

use paged_canvas::{CanvasModel, CanvasOptions, ElementId, Mutation, PageId, TextCellAddr};
use paged_mutate::{PropertyPath as P, Value as V};

struct Fixture {
    m: CanvasModel,
    story: String,
    cell: TextCellAddr,
}

/// A frame whose story holds a body paragraph, then a 2x2 table with
/// "Total" in cell (1,1).
fn fixture() -> Fixture {
    let idml = paged_canvas::blank::blank_idml(612.0, 792.0);
    let mut m = CanvasModel::load("doc", &idml, CanvasOptions::default()).expect("load");
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
    m.apply_mutation(&Mutation::InsertText {
        story_id: story.clone(),
        offset: 0,
        text: "Body text".into(),
        cell: None,
    })
    .expect("body text");
    let out = m
        .apply_mutation(&Mutation::InsertTable {
            story_id: story.clone(),
            rows: 2,
            cols: 2,
            header_rows: 0,
            footer_rows: 0,
            column_widths: vec![],
            row_heights: vec![],
            cell: None,
            word: None,
            paragraph: None,
        })
        .expect("table");
    let Some(ElementId::Table { table_id, .. }) = out.created_id else {
        panic!("expected a table, got {:?}", out.created_id);
    };
    let cell = TextCellAddr {
        table_id,
        row: 1,
        col: 1,
    };
    m.apply_mutation(&Mutation::InsertText {
        story_id: story.clone(),
        offset: 0,
        text: "Total".into(),
        cell: Some(cell.clone()),
    })
    .expect("cell text");
    Fixture { m, story, cell }
}

/// (body runs, cell runs) as (text, point size, font style), and the cell's
/// paragraph justification.
type State = (
    Vec<(String, Option<f32>, Option<String>)>,
    Vec<(String, Option<f32>, Option<String>)>,
    Option<String>,
);

impl Fixture {
    fn range(&self, start: u32, end: u32) -> ElementId {
        ElementId::StoryRange {
            story_id: self.story.clone(),
            start,
            end,
            cell: Some(self.cell.clone()),
            paragraph: None,
        }
    }

    fn set(&mut self, start: u32, end: u32, path: P, value: V) {
        self.m
            .apply_mutation(&Mutation::SetElementProperty {
                element_id: self.range(start, end),
                path,
                value,
            })
            .expect("a direct property on the cell's text");
    }

    fn state(&self) -> State {
        let story = &self
            .m
            .scene()
            .stories
            .iter()
            .find(|s| s.self_id == self.story)
            .expect("story")
            .story;
        let runs = |ps: &[paged_model::Paragraph]| {
            ps.iter()
                .filter(|p| p.table.is_none())
                .flat_map(|p| p.runs.iter())
                .filter(|r| !r.text.is_empty())
                .map(|r| (r.text.clone(), r.point_size, r.font_style.clone()))
                .collect::<Vec<_>>()
        };
        let cell = paged_model::cell_paragraphs_in(
            &story.paragraphs,
            &self.cell.table_id,
            self.cell.col,
            self.cell.row,
        )
        .expect("cell (1,1)");
        let just = cell[0].justification.map(|j| j.as_idml().to_string());
        (runs(&story.paragraphs), runs(cell), just)
    }
}

#[test]
fn a_cells_text_takes_direct_character_and_paragraph_properties() {
    let mut f = fixture();
    let before = f.state();
    f.set(0, 5, P::CharacterFontSize, V::Length(Some(14.0)));
    f.set(0, 3, P::CharacterFontStyle, V::Text("Bold".into()));
    f.set(
        0,
        5,
        P::ParagraphJustification,
        V::Text("RightAlign".into()),
    );
    let (body, cell, just) = f.state();
    assert_eq!(body, before.0, "a cell edit touched the body");
    assert_eq!(
        cell,
        vec![
            ("Tot".into(), Some(14.0), Some("Bold".into())),
            ("al".into(), Some(14.0), None),
        ]
    );
    assert_eq!(just.as_deref(), Some("RightAlign"));

    // The same address reads what the cell's text is set with.
    let props = f.m.element_properties(&f.range(0, 3)).expect("a read");
    let value = |path| {
        props
            .entries
            .iter()
            .find(|e| e.path == path)
            .and_then(|e| e.value.clone())
    };
    assert_eq!(value(P::CharacterFontSize), Some(V::Length(Some(14.0))));
    assert_eq!(
        value(P::ParagraphJustification),
        Some(V::Text("RightAlign".into()))
    );

    // Undo walks the three edits back in the cell; redo re-applies them.
    let after = f.state();
    for _ in 0..3 {
        f.m.undo().expect("undo");
    }
    assert_eq!(
        f.state().1.iter().map(|r| r.1).collect::<Vec<_>>(),
        vec![None; f.state().1.len()]
    );
    assert_eq!(f.state().0, before.0);
    assert_eq!(f.state().2, before.2);
    for _ in 0..3 {
        f.m.redo().expect("redo");
    }
    assert_eq!(f.state(), after);
}

#[test]
fn idml_export_writes_a_cells_direct_properties_as_local_overrides() {
    let mut f = fixture();
    f.set(0, 5, P::CharacterFontSize, V::Length(Some(14.0)));
    f.set(0, 5, P::CharacterFontStyle, V::Text("Bold".into()));
    f.set(
        0,
        5,
        P::ParagraphJustification,
        V::Text("CenterAlign".into()),
    );
    let bytes = f.m.export_idml().expect("export");
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
    let mut e = zip
        .by_name(&format!("Stories/Story_{}.xml", f.story.replace('/', "_")))
        .unwrap();
    let mut xml = String::new();
    std::io::Read::read_to_string(&mut e, &mut xml).unwrap();
    let cell = &xml[xml.find("<Cell ").expect("a cell")..];
    let total = cell.find(">Total<").expect("the cell's text");
    let range = &cell[..total];
    let csr = &range[range.rfind("<CharacterStyleRange").expect("its range")..];
    assert!(csr.contains("PointSize=\"14\""), "{csr}");
    assert!(csr.contains("FontStyle=\"Bold\""), "{csr}");
    let psr = &range[range.rfind("<ParagraphStyleRange").expect("its paragraph")..];
    assert!(psr.contains("Justification=\"CenterAlign\""), "{psr}");
}
