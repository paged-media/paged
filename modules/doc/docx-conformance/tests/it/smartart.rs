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

//! Doc ADR 629 — SmartArt: the drawing Word saved of a diagram's layout,
//! read through the diagram's data part, lowered as Word shapes with their
//! text, the diagram's parts kept on save.

#![allow(non_snake_case)]

use docx_conformance::{smartart_docx, SMARTART_PARTS, SMARTART_TEXTS};
use docx_core::{Block, DiagramDrawing, DocxDocument, ShapeGeometry};
use docx_export::{EditSet, RunEdit};
use docx_js::DocSession;
use docx_lower::ir::{LoweredBlock, LoweredGroup, LoweredPiece};
use paged_ooxml::drawingml::{ColorBase, Fill};
use paged_ooxml::OpcPackage;

fn diagrams(doc: &DocxDocument) -> Vec<&DiagramDrawing> {
    doc.body
        .iter()
        .filter_map(|b| match b {
            Block::Paragraph(p) => Some(p),
            _ => None,
        })
        .flat_map(|p| p.runs.iter().flat_map(|r| r.diagrams.iter()))
        .collect()
}

fn lowered(ir: &docx_lower::ir::LoweredDoc) -> Vec<&LoweredGroup> {
    ir.story
        .blocks
        .iter()
        .filter_map(|b| match b {
            LoweredBlock::Paragraph(p) => Some(p),
            _ => None,
        })
        .flat_map(|p| p.diagrams.iter())
        .collect()
}

#[test]
fn a_diagram_is_read_from_the_drawing_word_saved__feat__doc_smartart() {
    let doc = docx_import::import_docx(&smartart_docx()).expect("import");
    let got = diagrams(&doc);
    // The diagram without a drawing is a drawing that is not carried.
    assert_eq!(got.len(), 1);
    let others: u32 = doc
        .body
        .iter()
        .filter_map(|b| match b {
            Block::Paragraph(p) => Some(p),
            _ => None,
        })
        .flat_map(|p| p.runs.iter())
        .map(|r| r.other_drawings)
        .sum();
    assert_eq!(others, 1);
    let d = got[0];
    assert_eq!(d.part, "word/diagrams/drawing1.xml");
    assert_eq!(d.shapes.len(), 4);
    let names: Vec<_> = d
        .shapes
        .iter()
        .map(|s| match &s.shape.geometry {
            ShapeGeometry::Preset { name, .. } => name.as_str(),
            _ => "?",
        })
        .collect();
    assert_eq!(names, ["roundRect", "rightArrow", "chevron", "ellipse"]);
    // The group halves the chevron and moves it to its offset.
    let chevron = &d.shapes[2];
    assert_eq!((chevron.x_emu, chevron.y_emu), (1_935_480, 0));
    assert_eq!(
        (chevron.shape.width_emu, chevron.shape.height_emu),
        (1_371_600, 914_400)
    );
    let text = chevron.text.as_ref().expect("text");
    assert_eq!((text.x_emu, text.width_emu), (1_935_480 + 457_200, 457_200));
    // The texts, the insets, the anchor and the style's font colour.
    let texts: Vec<_> = d
        .shapes
        .iter()
        .filter_map(|s| s.text.as_ref())
        .map(|t| t.paragraphs[0].runs[0].text.as_str())
        .collect();
    assert_eq!(texts, SMARTART_TEXTS);
    let plan = d.shapes[0].text.as_ref().unwrap();
    assert_eq!(plan.insets_emu, [76_200; 4]);
    assert_eq!(plan.anchor, "ctr");
    assert_eq!(plan.paragraphs[0].line_pct, Some(90_000));
    match &plan.paragraphs[0].runs[0].fill {
        Some(Fill::Solid(c)) => assert_eq!(c.base, ColorBase::Scheme("lt1".into())),
        other => panic!("the font colour from dsp:style: {other:?}"),
    }
    assert!(d.shapes[1].text.is_none(), "the arrow holds no text");
}

#[test]
fn a_diagram_lowers_to_an_anchored_group_of_shapes_and_texts__feat__doc_smartart() {
    let doc = docx_import::import_docx(&smartart_docx()).expect("import");
    let ir = docx_lower::lower(&doc);
    let got = lowered(&ir);
    assert_eq!(got.len(), 1);
    let g = got[0];
    assert!((g.width_pt - 345.6).abs() < 0.01 && (g.height_pt - 72.0).abs() < 0.01);
    let shapes: Vec<_> = g
        .pieces
        .iter()
        .filter_map(|p| match p {
            LoweredPiece::Shape { anchors, fx, .. } => Some((anchors.len(), fx.clone())),
            LoweredPiece::Label { .. } => None,
        })
        .collect();
    assert_eq!(shapes.len(), 4);
    // The chevron's six corners (Annex D through dml-geom), filled.
    assert_eq!(shapes[2].0, 6);
    assert!(shapes
        .iter()
        .all(|(_, fx)| fx.as_ref().is_some_and(|f| f.fill.is_some())));
    let labels: Vec<String> = g
        .pieces
        .iter()
        .filter_map(|p| match p {
            LoweredPiece::Label { paragraphs, .. } => Some(
                paragraphs
                    .iter()
                    .flat_map(|p| p.runs.iter().map(|r| r.text.as_str()))
                    .collect(),
            ),
            LoweredPiece::Shape { .. } => None,
        })
        .collect();
    assert_eq!(labels, SMARTART_TEXTS);
    let messages: Vec<&str> = ir.diagnostics.iter().map(|d| d.message.as_str()).collect();
    assert!(
        messages
            .iter()
            .any(|m| m.contains("2 SmartArt diagram(s) drawn")),
        "{messages:?}"
    );
    assert!(
        !messages.iter().any(|m| m.contains("in table cells")),
        "{messages:?}"
    );
}

#[test]
fn a_diagram_in_a_table_cell_lowers_as_a_body_one__feat__doc_smartart() {
    // Doc ADR 629 amendment 2: the cell's diagram is the body's first one
    // again, an inline group of the cell's paragraph.
    let doc = docx_import::import_docx(&smartart_docx()).expect("import");
    let ir = docx_lower::lower(&doc);
    let body = lowered(&ir)[0];
    let cell: Vec<&LoweredGroup> = ir
        .story
        .blocks
        .iter()
        .filter_map(|b| match b {
            LoweredBlock::Table(t) => Some(t),
            _ => None,
        })
        .flat_map(|t| t.cells.iter().flat_map(|c| c.paragraphs.iter()))
        .flat_map(|p| p.diagrams.iter())
        .collect();
    assert_eq!(cell.len(), 1);
    let g = cell[0];
    assert!(g.anchor.is_none(), "inline in its cell");
    assert_eq!(g.at, 0);
    assert_eq!((g.width_pt, g.height_pt), (body.width_pt, body.height_pt));
    assert_eq!(g.pieces.len(), body.pieces.len());
}

#[test]
fn the_diagram_parts_are_byte_identical_on_save__feat__doc_smartart() {
    let bytes = smartart_docx();
    let session = DocSession::load(&bytes).expect("load");
    assert_eq!(session.save_verbatim(), bytes);
    let edits = EditSet {
        runs: vec![RunEdit::text(0, 0, "Edited line")],
        ..Default::default()
    };
    let (edited, skips) = session.save_edited(&edits).expect("save");
    assert!(skips.is_empty(), "{skips:?}");
    let before = OpcPackage::read(&bytes).unwrap();
    let after = OpcPackage::read(&edited).unwrap();
    for part in SMARTART_PARTS {
        assert!(before.part(part).is_some(), "{part}");
        assert_eq!(after.part(part), before.part(part), "{part}");
    }
    let doc = String::from_utf8(after.part("word/document.xml").unwrap().to_vec()).unwrap();
    assert_eq!(doc.matches("<dgm:relIds ").count(), 3);
}
