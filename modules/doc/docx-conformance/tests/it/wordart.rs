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

//! Engine ADR 1091, amendment 2 — turned WordArt: a text box's
//! `a:xfrm/@rot` is read beside its warp and turns the box it becomes, a
//! page item's text frame about its centre on the page, an anchored frame
//! about the centre of the box it is placed in.

#![allow(non_snake_case)]

use docx_conformance::wordart_docx;
use docx_core::{Block, TextBox};
use docx_lower::ir::{LoweredBlock, LoweredItemKind};
use docx_lower::LowerOptions;

fn boxes(doc: &docx_core::DocxDocument) -> Vec<&TextBox> {
    doc.body
        .iter()
        .filter_map(|b| match b {
            Block::Paragraph(p) => Some(p),
            _ => None,
        })
        .flat_map(|p| p.runs.iter().flat_map(|r| r.text_boxes.iter()))
        .collect()
}

fn near(m: [f32; 6], want: [f32; 6]) -> bool {
    m.iter().zip(want).all(|(a, b)| (a - b).abs() < 1e-3)
}

#[test]
fn a_turned_wordart_box_keeps_its_turn__feat__doc_wordart() {
    let doc = docx_import::import_docx(&wordart_docx()).expect("import");
    let got: Vec<_> = boxes(&doc)
        .iter()
        .map(|b| {
            (
                b.rotation,
                b.warp
                    .as_ref()
                    .map(|w| w.preset.clone())
                    .unwrap_or_default(),
            )
        })
        .collect();
    assert_eq!(
        got,
        [
            (1_800_000, "textArchUp".to_string()),
            (20_400_000, "textWave1".to_string())
        ]
    );
}

#[test]
fn a_turned_wordart_box_lowers_and_builds_turned__feat__doc_wordart() {
    let doc = docx_import::import_docx(&wordart_docx()).expect("import");
    let ir = docx_lower::lower(&doc);
    // The first paragraph's box is a page item, turned 30 degrees.
    let item = ir
        .page_items
        .iter()
        .find(|i| matches!(i.item, LoweredItemKind::TextBox { .. }))
        .expect("the page's box");
    let LoweredItemKind::TextBox { rotation, warp, .. } = &item.item else {
        unreachable!()
    };
    assert_eq!(*rotation, 30.0);
    assert_eq!(warp.as_ref().map(|w| w.preset.as_str()), Some("textArchUp"));
    // The third paragraph's box is anchored in it, turned 340 degrees.
    let anchored: Vec<f32> = ir
        .story
        .blocks
        .iter()
        .filter_map(|b| match b {
            LoweredBlock::Paragraph(p) => Some(p),
            _ => None,
        })
        .flat_map(|p| p.text_boxes.iter().map(|t| t.rotation))
        .collect();
    assert_eq!(anchored, [340.0]);

    // The anchored frame turns by its linear part about the box it is
    // placed in (engine ADR 1050, amendment).
    let stories = docx_skeleton::body::native_stories(&ir).expect("the whole body is native");
    let frames: Vec<_> = stories.stories[0]
        .iter()
        .flat_map(|p| p.anchored_frames.iter())
        .filter(|f| {
            f.self_id
                .as_deref()
                .is_some_and(|i| i.starts_with("docx_box"))
        })
        .collect();
    assert_eq!(frames.len(), 1);
    let (s, c) = 340f32.to_radians().sin_cos();
    let m = frames[0].item_transform.expect("turned");
    assert!(near(m, [c, s, -s, c, 0.0, 0.0]), "{m:?}");

    // The page item's text frame turns about its centre on the page.
    let pages = docx_skeleton::skeleton_pages(&doc);
    let mut skeleton = docx_skeleton::native::skeleton_document(&pages, "wordart.docx");
    let items: Vec<_> = docx_lower::objects::plan_page_items(&doc, LowerOptions::default())
        .into_iter()
        .map(|(_, i)| i)
        .collect();
    docx_skeleton::items::add_page_items(&mut skeleton, &items);
    let frame = skeleton
        .spreads
        .iter()
        .flat_map(|s| &s.spread.text_frames)
        .find(|f| f.self_id.as_deref() == Some(item.id.as_str()))
        .expect("the page item's frame");
    let b = frame.bounds;
    let (cx, cy) = ((b.left + b.right) / 2.0, (b.top + b.bottom) / 2.0);
    let (s, c) = 30f32.to_radians().sin_cos();
    let m = frame.item_transform.expect("turned");
    assert!(
        near(m, [c, s, -s, c, cx - c * cx + s * cy, cy - s * cx - c * cy]),
        "{m:?}"
    );
    assert_eq!(
        frame.text_warp.as_ref().map(|w| w.preset.as_str()),
        Some("textArchUp")
    );
}
