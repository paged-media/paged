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

//! Floating drawings (`wp:anchor`, thoughts ADR 035, RFI DOC-07) from
//! `floats_docx()`: their position and wrap are read and carried in the
//! lowered IR, and each is placed (doc ADR 614) as a page item where its
//! page is known, else as an anchored object of its paragraph, and counted
//! in a diagnostic by how.

#![allow(non_snake_case)] // `…__feat__<id>` test names link the cockpit feature

use docx_conformance::{floats_docx, image_docx, FLOAT_CASES};
use docx_core::{Block, FloatWrap, Paragraph};
use docx_import::import_docx;
use docx_lower::ir::{LoweredDoc, LoweredItemHost, LoweredItemKind};

fn para(doc: &docx_core::DocxDocument, i: usize) -> &Paragraph {
    match &doc.body[i] {
        Block::Paragraph(p) => p,
        Block::Table(_) => panic!("block {i} is a table"),
    }
}

fn lowered() -> LoweredDoc {
    docx_lower::lower(&import_docx(&floats_docx()).unwrap())
}

#[test]
fn a_floats_position_and_wrap_are_read__feat__plugin_doc_read_path() {
    let doc = import_docx(&floats_docx()).unwrap();
    let float = |i: usize| {
        para(&doc, i).runs[0].images[0]
            .float
            .clone()
            .expect("a float")
    };

    let f1 = float(0);
    assert_eq!(f1.wrap, FloatWrap::Square);
    assert_eq!(f1.wrap_text.as_deref(), Some("bothSides"));
    let h = f1.horizontal.unwrap();
    assert_eq!(
        (h.relative_from.as_str(), h.offset),
        ("column", Some(152400))
    );
    let v = f1.vertical.unwrap();
    assert_eq!((v.relative_from.as_str(), v.offset), ("paragraph", Some(0)));
    assert_eq!((f1.dist_left, f1.dist_right), (114300, 114300));
    assert!(f1.allow_overlap && f1.layout_in_cell && !f1.behind_doc && !f1.locked);
    assert_eq!(f1.relative_height, 251659264);

    let f2 = float(1);
    assert_eq!(f2.wrap, FloatWrap::TopAndBottom);
    let h = f2.horizontal.unwrap();
    assert_eq!(
        (h.relative_from.as_str(), h.align.as_deref()),
        ("margin", Some("center"))
    );
    assert_eq!(f2.vertical.unwrap().offset, Some(914400));
    assert_eq!((f2.dist_top, f2.dist_bottom), (25400, 50800));
    assert!(f2.locked && !f2.allow_overlap);

    let f3 = float(2);
    assert_eq!(f3.wrap, FloatWrap::None);
    assert!(f3.behind_doc);
    assert_eq!(f3.vertical.unwrap().align.as_deref(), Some("top"));

    let f4 = float(3);
    assert_eq!(f4.wrap, FloatWrap::Tight);
    assert_eq!(f4.wrap_text.as_deref(), Some("right"));
    assert_eq!(f4.simple_pos, Some((1270000, 2540000)));
    assert_eq!(
        (f4.dist_left, f4.dist_right),
        (38100, 38100),
        "the wrap's own distances"
    );

    // An inline picture has no float.
    let inline = import_docx(&image_docx()).unwrap();
    assert!(para(&inline, 1).runs[0].images[0].float.is_none());
}

#[test]
fn every_drawing_in_a_run_is_kept_and_a_non_picture_is_counted__feat__plugin_doc_read_path() {
    let doc = import_docx(&floats_docx()).unwrap();
    let n = FLOAT_CASES.len();
    let two = &para(&doc, n).runs[0];
    assert_eq!(two.images.len(), 2, "the inline picture AND the float");
    assert!(two.images[0].float.is_none() && two.images[1].float.is_some());
    let chart = &para(&doc, n + 2).runs[0];
    assert!(chart.images.is_empty());
    assert_eq!(chart.other_drawings, 1);
}

#[test]
fn the_lowered_ir_carries_the_float_in_points_and_places_it__feat__plugin_doc_read_path() {
    let ir = lowered();
    let p = ir.story.paragraphs();
    // F1 stands in the story's first paragraph, on the story's own page: a
    // page item with Word's square wrap, not a picture of the text.
    assert!(p[0].images.is_empty(), "F1 is a page item");
    let f1 = &ir.page_items[0];
    assert_eq!(
        f1.host,
        LoweredItemHost::Page {
            page_id: "docx_p0".into()
        }
    );
    // 12 pt right of the column (72 pt margin), at the paragraph's top.
    assert_eq!(f1.bounds, [72.0, 84.0, 126.0, 156.0]);
    let wrap = f1.wrap.as_ref().expect("square wraps");
    assert_eq!(wrap.mode, "BoundingBoxTextWrap");
    assert_eq!(wrap.offsets_pt, [0.0, 9.0, 0.0, 9.0]);
    assert_eq!(wrap.side.as_deref(), Some("BothSides"));
    assert!(matches!(f1.item, LoweredItemKind::Picture { .. }));

    // F2, top and bottom: custom at Word's position, centred as Word centres
    // it on the margin, and the text jumps it (engine ADR 1050), Word's
    // distance below it.
    let f2 = &p[1].images[0];
    let a2 = f2.anchor.as_ref().expect("anchored");
    assert_eq!(
        (a2.position.as_str(), a2.horizontal_alignment.as_str()),
        ("Anchored", "CenterAlign")
    );
    let w2 = f2
        .layout
        .as_ref()
        .and_then(|l| l.wrap.as_ref())
        .expect("wraps");
    assert_eq!(w2.mode, "JumpObjectTextWrap");
    assert_eq!(w2.offsets_pt[2], 4.0);
    assert_eq!(f2.at, 0, "at its paragraph's start");
    let f = f2.float.as_ref().expect("the float is carried");
    assert_eq!(f.wrap, "wrapTopAndBottom");

    // F3, behind the text: custom, at the page's left edge and the margin's
    // top.
    let a3 = p[2].images[0].anchor.as_ref().unwrap();
    assert_eq!(a3.position, "Anchored");
    assert_eq!(
        (
            a3.anchor_point.as_str(),
            a3.horizontal_reference.as_str(),
            a3.horizontal_alignment.as_str(),
            a3.vertical_reference.as_str(),
            a3.vertical_alignment.as_str(),
        ),
        (
            "TopLeftAnchor",
            "PageEdge",
            "LeftAlign",
            "TextFrame",
            "TopAlign"
        )
    );

    // F4, a simple position: against the page's top-left.
    let a4 = p[3].images[0].anchor.as_ref().unwrap();
    assert_eq!(
        (
            a4.horizontal_reference.as_str(),
            a4.vertical_reference.as_str(),
            a4.x_offset_pt,
            a4.y_offset_pt
        ),
        ("PageEdge", "PageEdge", 100.0, 200.0)
    );
    assert_eq!(
        p[3].images[0].float.as_ref().unwrap().simple_pos_pt,
        Some((100.0, 200.0))
    );
    // Its wrap polygon, in the picture's points.
    assert_eq!(
        p[3].images[0].float.as_ref().unwrap().wrap_polygon_pt,
        vec![
            (0.0, 0.0),
            (0.0, 54.0),
            (72.0, 54.0),
            (72.0, 0.0),
            (0.0, 0.0)
        ]
    );

    // Both drawings of the two-drawing run reach the paragraph; the float,
    // past the story's first paragraph, is anchored against the column and
    // its paragraph.
    let two = &p[FLOAT_CASES.len()].images;
    assert_eq!(two.len(), 2);
    assert!(two[0].anchor.is_none(), "the inline picture");
    let a5 = two[1].anchor.as_ref().unwrap();
    assert_eq!(
        (
            a5.horizontal_reference.as_str(),
            a5.x_offset_pt,
            a5.vertical_reference.as_str(),
            a5.y_offset_pt
        ),
        ("ColumnEdge", 12.0, "TopOfLeading", 0.0)
    );
    assert_eq!((two[1].width_pt, two[1].height_pt), (72.0, 54.0));
    // The JSON the bundle reads: an inline picture carries no `float` key.
    let json = serde_json::to_value(&ir).unwrap();
    let images = &json["story"]["blocks"][FLOAT_CASES.len()]["images"];
    assert!(images[0].get("float").is_none(), "{images}");
    assert!(images[0].get("anchor").is_none(), "{images}");
    assert_eq!(images[1]["float"]["wrapText"], "bothSides");
    assert_eq!(images[1]["float"]["horizontal"]["offsetPt"], 12.0);
    assert_eq!(images[1]["anchor"]["position"], "Anchored");
}

#[test]
fn every_floating_picture_is_counted_in_a_diagnostic__feat__plugin_doc_read_path() {
    let ir = lowered();
    let msgs: Vec<&str> = ir.diagnostics.iter().map(|d| d.message.as_str()).collect();
    let find = |needle: &str| {
        msgs.iter()
            .find(|m| m.contains(needle))
            .unwrap_or_else(|| panic!("no diagnostic with {needle:?}: {msgs:#?}"))
    };
    // F1 is a page item; F2 to F5 and the float in a cell are anchored
    // objects at Word's position, and four of them wrap the text as Word
    // does (engine ADR 1050).
    assert!(find("placed as page items").contains("1 floating picture(s) and 0 text box(es)"));
    let custom = find("as anchored objects");
    assert!(custom.contains("5 floating picture(s)"), "{custom}");
    assert!(
        custom.contains("4 of them wrap the text as Word does"),
        "{custom}"
    );
    let cell = msgs
        .iter()
        .find(|m| m.contains("table cells"))
        .expect("the cell-picture diagnostic");
    assert!(
        cell.contains("1 picture(s) in table cells shown in their cells (1 of them floating"),
        "{cell}"
    );
    let chart = msgs
        .iter()
        .find(|m| m.contains("not pictures"))
        .expect("the non-picture diagnostic");
    assert!(
        chart.contains(&format!("body block {}", FLOAT_CASES.len() + 2)),
        "{chart}"
    );

    // An inline picture is not diagnosed as a float.
    let inline = docx_lower::lower(&import_docx(&image_docx()).unwrap());
    assert!(!inline
        .diagnostics
        .iter()
        .any(|d| d.message.contains("floating")));
}
