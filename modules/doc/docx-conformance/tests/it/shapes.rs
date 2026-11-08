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

//! Doc ADR 627 — shapes without text: read from `wps:wsp`, completed from
//! `wps:style`, lowered to anchored frames along their outline, and the
//! ones the lowering does not draw told.

#![allow(non_snake_case)]

use docx_conformance::{shapes_docx, SHAPE_CASES};
use docx_core::{Block, DocxDocument, Shape, ShapeGeometry};
use docx_lower::ir::{LoweredBlock, LoweredShape};
use paged_ooxml::drawingml::{ColorBase, Fill};

fn shapes(doc: &DocxDocument) -> Vec<&Shape> {
    doc.body
        .iter()
        .filter_map(|b| match b {
            Block::Paragraph(p) => Some(p),
            _ => None,
        })
        .flat_map(|p| p.runs.iter().flat_map(|r| r.shapes.iter()))
        .collect()
}

fn preset(s: &Shape) -> &str {
    match &s.geometry {
        ShapeGeometry::Preset { name, .. } => name,
        ShapeGeometry::Custom(_) => "custGeom",
        ShapeGeometry::Unsupported => "unsupported",
    }
}

fn lowered_shapes(ir: &docx_lower::ir::LoweredDoc) -> Vec<&LoweredShape> {
    ir.story
        .blocks
        .iter()
        .filter_map(|b| match b {
            LoweredBlock::Paragraph(p) => Some(p),
            _ => None,
        })
        .flat_map(|p| p.shapes.iter())
        .collect()
}

#[test]
fn every_shape_without_text_is_read__feat__doc_shapes() {
    let doc = docx_import::import_docx(&shapes_docx()).expect("import");
    let got = shapes(&doc);
    assert_eq!(
        got.iter().map(|s| preset(s)).collect::<Vec<_>>(),
        SHAPE_CASES.iter().map(|(n, _)| *n).collect::<Vec<_>>()
    );
    // Not counted as drawings that are not carried.
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
    // Extents, floats and the rotation.
    assert_eq!((got[0].width_emu, got[0].height_emu), (1_828_800, 914_400));
    assert!(got[0].float.is_none() && got[1].float.is_some());
    assert_eq!(got[4].rotation, 5_400_000);
    // The authored triangle keeps its guide.
    assert_eq!(
        got[2].geometry,
        ShapeGeometry::Preset {
            name: "triangle".into(),
            adjust: vec![("adj".into(), 30000)]
        }
    );
}

#[test]
fn a_shape_leaves_its_fill_and_line_to_wps_style__feat__doc_shapes() {
    let doc = docx_import::import_docx(&shapes_docx()).expect("import");
    let got = shapes(&doc);
    // The rectangle states both.
    let rect = got[0].look.as_ref().expect("look").shape.clone();
    assert!(matches!(rect.fill, Some(Fill::Solid(_))));
    assert_eq!(rect.line.as_ref().and_then(|l| l.width), Some(19050));
    // The ellipse states neither: the fill is accent1 (fillRef), the line
    // the theme's second line style (12700 EMU) in accent1's shade.
    let ellipse = got[1].look.as_ref().expect("look").shape.clone();
    match ellipse.fill {
        Some(Fill::Solid(c)) => {
            assert_eq!(c.base, ColorBase::Scheme("accent1".into()))
        }
        other => panic!("fill from fillRef: {other:?}"),
    }
    let line = ellipse.line.expect("line from lnRef");
    assert_eq!(line.width, Some(12700));
    assert!(matches!(line.fill, Some(Fill::Solid(_))));
    // The triangle says `a:ln` is `noFill`: that stays.
    let tri = got[2].look.as_ref().expect("look").shape.clone();
    assert!(matches!(tri.line.and_then(|l| l.fill), Some(Fill::None)));
}

#[test]
fn the_lowering_draws_the_outlines_it_has_and_tells_the_rest__feat__doc_shapes() {
    let doc = docx_import::import_docx(&shapes_docx()).expect("import");
    let ir = docx_lower::lower(&doc);
    let drawn = lowered_shapes(&ir);
    // Every case but the cloud callout.
    assert_eq!(drawn.len(), SHAPE_CASES.iter().filter(|(_, d)| *d).count());
    // The triangle (third case): three anchors on the box, apex at 30 %.
    let tri = drawn[2];
    assert_eq!(tri.anchors.len(), 3);
    assert!((tri.anchors[1][0] - 0.3 * tri.width_pt).abs() < 0.01 && tri.anchors[1][1] == 0.0);
    assert_eq!(
        (tri.starts.clone(), tri.open.clone()),
        (vec![0], vec![false])
    );
    // The line is one open contour; it has a look with an outline only.
    let line = drawn[3];
    assert_eq!(line.open, vec![true]);
    assert!(line.fx.as_ref().is_some_and(|fx| fx.fill.is_none()));
    // The ellipse floats: an anchor with a wrap.
    assert!(drawn[1].anchor.is_some());
    // The inline rectangle does not.
    assert!(drawn[0].anchor.is_none());
    // Told: the preset it does not draw, and the shapes it does.
    let messages: Vec<&str> = ir.diagnostics.iter().map(|d| d.message.as_str()).collect();
    assert!(
        messages
            .iter()
            .any(|m| m.contains("cloudCallout") && m.contains("NOT shown")),
        "{messages:?}"
    );
    assert!(messages
        .iter()
        .any(|m| m.contains("6 shape(s) without text placed")));
}

#[test]
fn an_unedited_save_keeps_the_drawings__feat__doc_shapes() {
    let bytes = shapes_docx();
    let session = docx_js::DocSession::load(&bytes).expect("load");
    assert_eq!(session.save_verbatim(), bytes);
}
