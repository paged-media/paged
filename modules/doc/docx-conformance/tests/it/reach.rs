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

//! Doc ADR 623 — cropped pictures (`docx_conformance::reach` fixtures). A
//! picture's `a:srcRect` rides the IR with the picture's placement in its
//! frame.

#![allow(non_snake_case)]

use docx_conformance::{
    picture_crop_cell_docx, picture_crop_docx, CELL_CROP_CASES, CROP_CASES, CROP_PNG_H, CROP_PNG_W,
};
use docx_core::{Block, DocxDocument};
use docx_lower::ir::LoweredBlock;

fn paragraphs(doc: &DocxDocument) -> Vec<&docx_core::Paragraph> {
    doc.body
        .iter()
        .filter_map(|b| match b {
            Block::Paragraph(p) => Some(p),
            _ => None,
        })
        .collect()
}

#[test]
fn every_srcrect_reaches_the_image_and_the_ir() {
    let doc = docx_import::import_docx(&picture_crop_docx()).expect("import");
    let mut crops = Vec::new();
    for p in paragraphs(&doc) {
        for r in &p.runs {
            for i in &r.images {
                crops.push(i.crop);
            }
        }
    }
    // Inline, then anchored: the same four cases; the first crops nothing.
    let want: Vec<_> = CROP_CASES
        .iter()
        .map(|(c, _)| Some(*c).filter(|c| *c != (0, 0, 0, 0)))
        .collect();
    assert_eq!(crops.len(), 8);
    assert_eq!(&crops[..4], &want[..]);
    assert_eq!(&crops[4..], &want[..]);

    let lowered = docx_lower::lower(&doc);
    let mut got = Vec::new();
    for b in &lowered.story.blocks {
        if let LoweredBlock::Paragraph(p) = b {
            for i in &p.images {
                got.push(i.crop);
            }
        }
    }
    assert_eq!(got.len(), 8);
    assert_eq!(got[0], None);
    let c = got[1].expect("l=25% r=25%");
    assert_eq!((c.l, c.t, c.r, c.b), (0.25, 0.0, 0.25, 0.0));
    let c = got[2].expect("t=10% b=40%");
    assert_eq!((c.l, c.t, c.r, c.b), (0.0, 0.1, 0.0, 0.4));
    // The anchored copies carry it too.
    assert_eq!(got[5], got[1]);

    // The placement is where the engine puts the picture in its frame
    // (natural pixels to points, the frame's box from (0, 0)): the frame
    // shows exactly the part of the image `a:srcRect` leaves, and nothing
    // else. The expected geometry, as Word renders `a:srcRect`: the picture
    // is `wp:extent` big on the page and shows the pixels from
    // `l * width` to `(1 - r) * width` and `t * height` to `(1 - b) *
    // height` (the Word render comparison is pending, see
    // docs/reference/drop-cap-and-picture-crop.md).
    let (pw, ph) = (CROP_PNG_W as f32, CROP_PNG_H as f32);
    for (i, ((_, (cx, cy)), c)) in CROP_CASES.iter().zip(&got).enumerate() {
        let Some(c) = c else { continue };
        let [a, b, cc, d, e, f] = c.placement.expect("a PNG's size is read");
        assert_eq!((b, cc), (0.0, 0.0), "case {i}: axis aligned");
        let (w, h) = (*cx as f32 / 12_700.0, *cy as f32 / 12_700.0);
        let near = |x: f32, y: f32| (x - y).abs() < 1e-3;
        // The frame's left edge (0) and right edge (w) are the image's
        // `l` and `1 - r` in pixels.
        assert!(near((c.l * pw) * a + e, 0.0), "case {i}: left edge");
        assert!(near(((1.0 - c.r) * pw) * a + e, w), "case {i}: right edge");
        assert!(near((c.t * ph) * d + f, 0.0), "case {i}: top edge");
        assert!(near(((1.0 - c.b) * ph) * d + f, h), "case {i}: bottom edge");
    }
    // l=25% r=25% of a 200 px, 72 pt wide picture: the middle 100 px
    // (50 to 150) stretched over the 72 pt frame.
    let [a, _, _, d, e, f] = got[1].unwrap().placement.unwrap();
    assert_eq!((a, d, e, f), (0.72, 0.72, -36.0, 0.0));

    // Every crop is placed: nothing is reported as shown whole.
    assert!(
        !lowered
            .diagnostics
            .iter()
            .any(|d| d.message.contains("cropped picture")),
        "{:?}",
        lowered.diagnostics
    );
}

/// Cropped pictures in table cells take the same path as those in the body:
/// the cell paragraph's images carry the crop and the placement, the
/// floating one stands against its cell.
#[test]
fn a_cropped_picture_in_a_table_cell_reaches_the_ir_inline_and_anchored() {
    let doc = docx_import::import_docx(&picture_crop_cell_docx()).expect("import");
    let lowered = docx_lower::lower(&doc);
    let table = lowered
        .story
        .blocks
        .iter()
        .find_map(|b| match b {
            LoweredBlock::Table(t) => Some(t),
            _ => None,
        })
        .expect("a table");
    assert!(table.flow.is_empty(), "the table is native");
    let images: Vec<_> = table
        .cells
        .iter()
        .flat_map(|c| c.paragraphs.iter())
        .flat_map(|p| p.images.iter())
        .collect();
    assert_eq!(images.len(), 2);
    assert!(images[0].anchor.is_none(), "the first is inline");
    assert!(
        images[1].anchor.is_some(),
        "the second floats against its cell"
    );
    let (pw, ph) = (CROP_PNG_W as f32, CROP_PNG_H as f32);
    for (i, (((l, t, r, b), (cx, cy)), img)) in CELL_CROP_CASES.iter().zip(&images).enumerate() {
        assert_eq!(
            img.drawing,
            Some(i as u32),
            "picture {i}: its drawing ordinal"
        );
        let c = img.crop.expect("the cell picture is cropped");
        let f = |v: i32| v as f32 / 100_000.0;
        assert_eq!((c.l, c.t, c.r, c.b), (f(*l), f(*t), f(*r), f(*b)));
        let [a, bb, cc, d, e, g] = c.placement.expect("a PNG's size is read");
        assert_eq!((bb, cc), (0.0, 0.0), "picture {i}: axis aligned");
        // The frame shows the image from `l` to `1 - r` and `t` to `1 - b`,
        // the OOXML definition of `a:srcRect` (as the body pictures above).
        let (w, h) = (*cx as f32 / 12_700.0, *cy as f32 / 12_700.0);
        let near = |x: f32, y: f32| (x - y).abs() < 1e-3;
        assert!(near((c.l * pw) * a + e, 0.0), "picture {i}: left edge");
        assert!(
            near(((1.0 - c.r) * pw) * a + e, w),
            "picture {i}: right edge"
        );
        assert!(near((c.t * ph) * d + g, 0.0), "picture {i}: top edge");
        assert!(
            near(((1.0 - c.b) * ph) * d + g, h),
            "picture {i}: bottom edge"
        );
    }
    assert!(
        !lowered
            .diagnostics
            .iter()
            .any(|d| d.message.contains("cropped picture")),
        "{:?}",
        lowered.diagnostics
    );
}
