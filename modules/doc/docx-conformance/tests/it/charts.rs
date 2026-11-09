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

//! Doc ADR 628 — charts: read from their chart parts through the shared
//! DrawingML chart reader, drawn from the cached values by paged.slide's
//! chart layout as anchored groups, the chart parts kept on save.

#![allow(non_snake_case)]

use docx_conformance::{
    charts_docx, CHART_CATEGORIES, CHART_PARTS, CHART_SERIES, CHART_TITLE, CHART_WORKBOOK,
};
use docx_core::{Block, ChartDrawing, DocxDocument};
use docx_export::{EditSet, RunEdit};
use docx_js::DocSession;
use docx_lower::ir::{LoweredBlock, LoweredGroup, LoweredPiece};
use paged_ooxml::OpcPackage;

fn charts(doc: &DocxDocument) -> Vec<&ChartDrawing> {
    doc.body
        .iter()
        .filter_map(|b| match b {
            Block::Paragraph(p) => Some(p),
            _ => None,
        })
        .flat_map(|p| p.runs.iter().flat_map(|r| r.charts.iter()))
        .collect()
}

fn lowered_charts(ir: &docx_lower::ir::LoweredDoc) -> Vec<&LoweredGroup> {
    ir.story
        .blocks
        .iter()
        .filter_map(|b| match b {
            LoweredBlock::Paragraph(p) => Some(p),
            _ => None,
        })
        .flat_map(|p| p.charts.iter())
        .collect()
}

/// The text of a chart's labels, in z-order.
fn labels(c: &LoweredGroup) -> Vec<String> {
    c.pieces
        .iter()
        .filter_map(|p| match p {
            LoweredPiece::Label { paragraphs, .. } => Some(
                paragraphs
                    .iter()
                    .flat_map(|p| p.runs.iter().map(|r| r.text.as_str()))
                    .collect::<String>(),
            ),
            LoweredPiece::Shape { .. } => None,
        })
        .collect()
}

#[test]
fn a_chart_is_read_from_its_part_with_the_cached_values__feat__doc_charts() {
    let doc = docx_import::import_docx(&charts_docx()).expect("import");
    let got = charts(&doc);
    // The two body charts; the one in a table cell is read where its cell is.
    assert_eq!(got.len(), 2);
    assert_eq!(got[0].part, "word/charts/chart1.xml");
    assert_eq!(got[1].part, "word/charts/chart2.xml");
    assert!(got[0].float.is_none() && got[1].float.is_some());
    assert_eq!(
        (got[0].width_emu, got[0].height_emu),
        (4_572_000, 2_743_200)
    );
    let bar = &got[0].chart;
    assert_eq!(
        bar.title.as_ref().map(|t| t.text.as_str()),
        Some(CHART_TITLE)
    );
    let series = &bar.plots[0].series;
    assert_eq!(series.len(), 2);
    assert_eq!(series[0].name, CHART_SERIES[0]);
    assert_eq!(series[1].values, vec![Some(2.4), Some(4.4), Some(1.8)]);
    assert_eq!(
        series[0].categories,
        CHART_CATEGORIES
            .iter()
            .map(|c| c.to_string())
            .collect::<Vec<_>>()
    );
    // Not counted among the drawings that are not carried.
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
    assert_eq!(others, 0);
}

#[test]
fn a_chart_lowers_to_an_anchored_group_of_its_pieces__feat__doc_charts() {
    let doc = docx_import::import_docx(&charts_docx()).expect("import");
    let ir = docx_lower::lower(&doc);
    let drawn = lowered_charts(&ir);
    assert_eq!(drawn.len(), 2);
    let bar = drawn[0];
    assert_eq!((bar.width_pt, bar.height_pt), (360.0, 216.0));
    assert!(bar.anchor.is_none(), "an inline chart is a character");
    assert!(drawn[1].anchor.is_some(), "the pie floats");
    // The title, the legend's series names and the categories are labels.
    let text = labels(bar);
    for want in [CHART_TITLE, CHART_SERIES[0], CHART_SERIES[1]]
        .iter()
        .chain(CHART_CATEGORIES.iter())
    {
        assert!(text.iter().any(|t| t == want), "{want} in {text:?}");
    }
    // Six bars (two series by three quarters), each a filled closed
    // contour inside the chart's box.
    let bars: Vec<_> = bar
        .pieces
        .iter()
        .filter_map(|p| match p {
            LoweredPiece::Shape {
                bounds,
                anchors,
                open,
                fx,
                ..
            } if anchors.len() == 4 && open == &vec![false] => fx
                .as_ref()
                .and_then(|f| f.fill.clone())
                .map(|f| (bounds, f)),
            _ => None,
        })
        .collect();
    let fills: std::collections::BTreeSet<_> = bars.iter().map(|(_, f)| f.clone()).collect();
    assert!(bars.len() >= 6, "{bars:?}");
    assert!(fills.len() >= 2, "each series its own colour: {fills:?}");
    for (b, _) in &bars {
        assert!(b[0] >= 0.0 && b[1] >= 0.0);
        assert!(b[0] + b[2] <= bar.width_pt + 0.01 && b[1] + b[3] <= bar.height_pt + 0.01);
    }
    // The pie: three wedges (contours with arcs) of three colours.
    let wedges: std::collections::BTreeSet<_> = drawn[1]
        .pieces
        .iter()
        .filter_map(|p| match p {
            LoweredPiece::Shape { anchors, fx, .. }
                if anchors
                    .iter()
                    .any(|a| (a[2], a[3]) != (a[0], a[1]) || (a[4], a[5]) != (a[0], a[1])) =>
            {
                fx.as_ref().and_then(|f| f.fill.clone())
            }
            _ => None,
        })
        .collect();
    assert_eq!(wedges.len(), 3, "{wedges:?}");
    // Told: the charts drawn, the one in a table cell among them.
    let messages: Vec<&str> = ir.diagnostics.iter().map(|d| d.message.as_str()).collect();
    assert!(
        messages.iter().any(|m| m.contains("3 chart(s) drawn")),
        "{messages:?}"
    );
    assert!(
        !messages.iter().any(|m| m.contains("in table cells")),
        "{messages:?}"
    );
}

/// The charts of the table cells' paragraphs.
fn cell_charts(ir: &docx_lower::ir::LoweredDoc) -> Vec<&LoweredGroup> {
    ir.story
        .blocks
        .iter()
        .filter_map(|b| match b {
            LoweredBlock::Table(t) => Some(t),
            _ => None,
        })
        .flat_map(|t| t.cells.iter().flat_map(|c| c.paragraphs.iter()))
        .flat_map(|p| p.charts.iter())
        .collect()
}

#[test]
fn a_chart_in_a_table_cell_is_a_character_of_the_cells_line__feat__doc_charts() {
    // Doc ADR 628 amendment 1: the cell's chart lowers as a body chart
    // does, an inline group at offset 0 of the cell's paragraph.
    let doc = docx_import::import_docx(&charts_docx()).expect("import");
    let ir = docx_lower::lower(&doc);
    let cell = cell_charts(&ir);
    assert_eq!(cell.len(), 1);
    let c = cell[0];
    assert_eq!((c.width_pt, c.height_pt), (180.0, 108.0));
    assert!(c.anchor.is_none(), "inline in its cell");
    assert_eq!(c.at, 0);
    assert_eq!(c.part, "word/charts/chart1.xml");
    // Its labels are the bar chart's, lowered as the frame's paragraphs
    // (not the cell's).
    let text = labels(c);
    assert!(text.iter().any(|t| t == CHART_TITLE), "{text:?}");
}

#[test]
fn the_chart_parts_are_byte_identical_on_save__feat__doc_charts() {
    let bytes = charts_docx();
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
    for part in CHART_PARTS {
        assert_eq!(after.part(part), before.part(part), "{part}");
    }
    assert_eq!(
        after.part("word/embeddings/Microsoft_Excel_Worksheet1.xlsx"),
        Some(CHART_WORKBOOK)
    );
    assert_ne!(
        after.part("word/document.xml"),
        before.part("word/document.xml")
    );
    // The drawings that name the charts are kept in the edited body.
    let doc = String::from_utf8(after.part("word/document.xml").unwrap().to_vec()).unwrap();
    assert_eq!(doc.matches(r#"<c:chart r:id="rChart1"/>"#).count(), 2);
    assert_eq!(doc.matches(r#"<c:chart r:id="rChart2"/>"#).count(), 1);
}
