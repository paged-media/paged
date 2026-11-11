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

//! Doc ADR 623 — a crop changed on the canvas is written back as the
//! picture's `a:srcRect`. The editor changes a picture's crop by setting
//! `imageContentTransform` on its anchored frame; the host reads the
//! placement back with the story (engine ADR 1045, amendment), and the
//! save-back inverts the lowering's placement into `l t r b` in 1/1000
//! percent and splices it into the drawing, nothing else moving.

#![allow(non_snake_case)]

use docx_conformance::{
    picture_crop_cell_docx, picture_crop_docx, CELL_CROP_CASES, CROP_CASES, CROP_PNG_H, CROP_PNG_W,
};
use docx_core::{Block, Crop};
use docx_export::crop::{CellPicturesIn, PictureIn, PicturesIn};
use docx_export::structure::StructureIn;
use docx_export::{ParagraphContentIn, RunContentIn, StoryContentIn, TableParagraphs};
use docx_import::import_docx;
use docx_js::DocSession;
use docx_lower::ir::{LoweredBlock, LoweredDoc, LoweredImage, LoweredParagraph};
use paged_ooxml::OpcPackage;

const MAIN: &str = "word/document.xml";

fn paragraph_content(p: &LoweredParagraph) -> ParagraphContentIn {
    ParagraphContentIn {
        mark_change: None,
        props_change: None,
        paragraph_style: p.para_style_id.clone(),
        runs: p
            .runs
            .iter()
            .map(|r| RunContentIn {
                text: r.text.clone(),
                character_style: r.char_style_id.clone(),
                ..Default::default()
            })
            .collect(),
    }
}

fn body(base: &LoweredDoc) -> StoryContentIn {
    StoryContentIn {
        comments: Vec::new(),
        self_id: "docx_s0".into(),
        paragraphs: base
            .story
            .blocks
            .iter()
            .filter_map(|b| match b {
                LoweredBlock::Paragraph(p) => Some(paragraph_content(p)),
                LoweredBlock::Table(_) => None,
            })
            .collect(),
    }
}

/// What the editor holds of a picture: its placement, as the lowering made it.
fn read(image: &LoweredImage, edit: &dyn Fn(u32) -> Option<Option<[f32; 6]>>) -> PictureIn {
    let placed = image.crop.and_then(|c| c.placement);
    PictureIn {
        frame_id: "frame".into(),
        offset: image.at,
        placement: image.drawing.and_then(edit).unwrap_or(placed),
        adjustments: Some(image.adjustments.clone()),
    }
}

/// The pictures read back for `base`, `edit` giving the placement the editor
/// changed a drawing's to (`None` leaves it).
fn pictures(base: &LoweredDoc, edit: &dyn Fn(u32) -> Option<Option<[f32; 6]>>) -> PicturesIn {
    let mut out = PicturesIn::default();
    for (b, block) in base.story.blocks.iter().enumerate() {
        match block {
            LoweredBlock::Paragraph(p) => out
                .body
                .push(p.images.iter().map(|i| read(i, edit)).collect()),
            LoweredBlock::Table(t) => {
                for (c, cell) in t.cells.iter().enumerate() {
                    out.cells.push(CellPicturesIn {
                        block: b,
                        cell: c,
                        paragraphs: cell
                            .paragraphs
                            .iter()
                            .map(|p| p.images.iter().map(|i| read(i, edit)).collect())
                            .collect(),
                    });
                }
            }
        }
    }
    out
}

fn save(
    session: &DocSession,
    edit: &dyn Fn(u32) -> Option<Option<[f32; 6]>>,
) -> (Vec<u8>, Vec<String>) {
    let base = session.lowered();
    session
        .save_edited_structure(
            &body(&base),
            &[],
            &[],
            &Default::default(),
            &[],
            TableParagraphs::Joined,
            &StructureIn {
                pictures: pictures(&base, edit),
                ..Default::default()
            },
        )
        .unwrap()
}

/// The placement the lowering makes of a crop of `(l, t, r, b)` 1/1000
/// percent, for a picture of `CROP_PNG_W` x `CROP_PNG_H` pixels shown at
/// `cx` x `cy` EMU (the OOXML definition of `a:srcRect`).
fn placement((l, t, r, b): Crop, (cx, cy): (i64, i64)) -> [f32; 6] {
    let f = |v: i32| v as f32 / 100_000.0;
    let (l, t, r, b) = (f(l), f(t), f(r), f(b));
    let (w, h) = (cx as f32 / 12_700.0, cy as f32 / 12_700.0);
    let (dw, dh) = (w / (1.0 - l - r), h / (1.0 - t - b));
    [
        dw / CROP_PNG_W as f32,
        0.0,
        0.0,
        dh / CROP_PNG_H as f32,
        -l * dw,
        -t * dh,
    ]
}

/// The crop of every picture of `bytes`, in the order the drawings stand.
fn crops(bytes: &[u8]) -> Vec<Option<Crop>> {
    let doc = import_docx(bytes).expect("import");
    let mut out = Vec::new();
    let mut take = |p: &docx_core::Paragraph| {
        for r in &p.runs {
            for i in &r.images {
                out.push(i.crop);
            }
        }
    };
    for b in &doc.body {
        match b {
            Block::Paragraph(p) => take(p),
            Block::Table(t) => {
                for p in t
                    .rows
                    .iter()
                    .flat_map(|r| r.cells.iter())
                    .flat_map(|c| c.paragraphs.iter())
                {
                    take(p);
                }
            }
        }
    }
    out
}

fn text(bytes: &[u8], name: &str) -> String {
    String::from_utf8_lossy(OpcPackage::read(bytes).unwrap().part(name).unwrap()).into_owned()
}

fn identical_except(original: &[u8], saved: &[u8], changed: &[&str]) {
    let a = OpcPackage::read(original).unwrap();
    let b = OpcPackage::read(saved).unwrap();
    assert_eq!(a.file_names().count(), b.file_names().count());
    for name in a.file_names() {
        if !changed.contains(&name) {
            assert_eq!(a.part(name), b.part(name), "{name} changed");
        }
    }
}

fn none(_: u32) -> Option<Option<[f32; 6]>> {
    None
}

#[test]
fn an_unedited_cropped_document_saves_every_part_byte_identical() {
    for original in [picture_crop_docx(), picture_crop_cell_docx()] {
        let session = DocSession::load(&original).unwrap();
        let (saved, skips) = save(&session, &none);
        assert!(skips.is_empty(), "{skips:?}");
        identical_except(&original, &saved, &[]);
    }
}

#[test]
fn picture_adjustments_set_in_the_editor_are_saved_as_blip_effects__feat__images_graphics_image_filter_stack(
) {
    // Engine ADR 1037, amendment 2026-11-11: a threshold set on drawing 1
    // is its blip's `a:biLevel`, and the import reads it back as the op.
    let original = picture_crop_docx();
    let session = DocSession::load(&original).unwrap();
    let base = session.lowered();
    let mut read = pictures(&base, &none);
    let op = dml_native::RasterOp::Threshold { level: 0.4 };
    // `pictures` lists one entry per lowered paragraph block, its pictures
    // in the lowering's order.
    let paragraphs = base.story.blocks.iter().filter_map(|b| match b {
        LoweredBlock::Paragraph(p) => Some(p),
        LoweredBlock::Table(_) => None,
    });
    for (p, read_back) in paragraphs.zip(read.body.iter_mut()) {
        for (image, r) in p.images.iter().zip(read_back.iter_mut()) {
            if image.drawing == Some(1) {
                r.adjustments = Some(vec![op.clone()]);
            }
        }
    }
    let (saved, skips) = session
        .save_edited_structure(
            &body(&base),
            &[],
            &[],
            &Default::default(),
            &[],
            TableParagraphs::Joined,
            &StructureIn {
                pictures: read,
                ..Default::default()
            },
        )
        .unwrap();
    assert!(skips.is_empty(), "{skips:?}");
    // For the Word oracle (`PAGED_DOC_EXPORT_DIR`).
    if let Ok(dir) = std::env::var("PAGED_DOC_EXPORT_DIR") {
        std::fs::write(
            std::path::Path::new(&dir).join("picture-filter-stack.docx"),
            &saved,
        )
        .unwrap();
    }
    assert!(text(&saved, MAIN).contains("<a:biLevel thresh=\"40000\"/>"));
    identical_except(&original, &saved, &[MAIN]);
    let again = DocSession::load(&saved).unwrap().lowered();
    let ops: Vec<_> = again
        .story
        .blocks
        .iter()
        .filter_map(|b| match b {
            LoweredBlock::Paragraph(p) => Some(p.images.iter()),
            LoweredBlock::Table(_) => None,
        })
        .flatten()
        .filter(|i| i.drawing == Some(1))
        .map(|i| i.adjustments.clone())
        .collect();
    assert_eq!(ops, vec![vec![op]]);
}

#[test]
fn a_changed_crop_is_written_as_srcrect_and_survives_a_round_trip() {
    let original = picture_crop_docx();
    let session = DocSession::load(&original).unwrap();
    // Drawing 1 is the inline picture cropped l = r = 25 %; the editor now
    // crops it l = 10 %, t = 5 %, r = 20 %, b = 30 %.
    let new: Crop = (10_000, 5_000, 20_000, 30_000);
    let to = placement(new, CROP_CASES[1].1);
    let (saved, skips) = save(&session, &|d| (d == 1).then_some(Some(to)));
    assert!(skips.is_empty(), "{skips:?}");

    let xml = text(&saved, MAIN);
    assert!(xml.contains(r#"<a:srcRect l="10000" t="5000" r="20000" b="30000"/>"#));
    // Only the document part changed, and only inside that rectangle.
    identical_except(&original, &saved, &[MAIN]);
    let was = text(&original, MAIN);
    let first = was.find(r#"<a:srcRect l="25000" r="25000"/>"#).unwrap();
    let expected = format!(
        "{}{}{}",
        &was[..first],
        r#"<a:srcRect l="10000" t="5000" r="20000" b="30000"/>"#,
        &was[first + r#"<a:srcRect l="25000" r="25000"/>"#.len()..]
    );
    assert_eq!(xml, expected);

    // Re-import gives the crop; the others are as they were.
    let got = crops(&saved);
    assert_eq!(got[1], Some(new));
    let was = crops(&original);
    for (i, (a, b)) in got.iter().zip(&was).enumerate() {
        if i != 1 {
            assert_eq!(a, b, "picture {i} moved");
        }
    }
    // The re-imported document lowers to the placement the editor set (the
    // fixed point: nothing left to write).
    let again = DocSession::load(&saved).unwrap();
    let lowered = again.lowered();
    let placed: Vec<_> = lowered
        .story
        .blocks
        .iter()
        .filter_map(|b| match b {
            LoweredBlock::Paragraph(p) => Some(p),
            _ => None,
        })
        .flat_map(|p| p.images.iter())
        .map(|i| i.crop.and_then(|c| c.placement))
        .collect();
    for (a, b) in placed[1].unwrap().iter().zip(to) {
        assert!((a - b).abs() < 1e-3, "{:?} vs {to:?}", placed[1]);
    }
    let (resaved, skips) = save(&again, &none);
    assert!(skips.is_empty(), "{skips:?}");
    assert_eq!(text(&resaved, MAIN), text(&saved, MAIN));
}

#[test]
fn a_crop_is_added_to_an_uncropped_picture_and_taken_away_from_a_cropped_one() {
    let original = picture_crop_docx();
    let session = DocSession::load(&original).unwrap();
    // Drawing 0 shows whole; drawing 5 is the anchored l = r = 25 %.
    let new: Crop = (0, 50_000, 0, 0);
    let to = placement(new, CROP_CASES[0].1);
    let whole = {
        let (cx, cy) = CROP_CASES[1].1;
        [
            cx as f32 / 12_700.0 / CROP_PNG_W as f32,
            0.0,
            0.0,
            cy as f32 / 12_700.0 / CROP_PNG_H as f32,
            0.0,
            0.0,
        ]
    };
    let (saved, skips) = save(&session, &|d| match d {
        0 => Some(Some(to)),
        5 => Some(Some(whole)),
        _ => None,
    });
    assert!(skips.is_empty(), "{skips:?}");
    let xml = text(&saved, MAIN);
    // Added after the blip, as Word orders the children of blipFill.
    assert!(xml.contains(r#"<a:blip r:embed="rImg"/><a:srcRect t="50000"/><a:stretch>"#));
    identical_except(&original, &saved, &[MAIN]);
    let got = crops(&saved);
    let mut want = crops(&original);
    want[0] = Some(new);
    want[5] = None;
    assert_eq!(got, want);
}

#[test]
fn a_picture_that_cannot_be_inverted_is_refused_and_left_as_it_was() {
    let original = picture_crop_docx();
    let session = DocSession::load(&original).unwrap();
    // A flipped picture, and one that leaves its frame bare at the left.
    let flipped = [-1.0, 0.0, 0.0, 1.0, 0.0, 0.0];
    let padded = {
        let mut p = placement((0, 0, 0, 0), CROP_CASES[0].1);
        p[4] = 20.0;
        p
    };
    let (saved, skips) = save(&session, &|d| match d {
        1 => Some(Some(flipped)),
        2 => Some(Some(padded)),
        _ => None,
    });
    assert_eq!(skips.len(), 2, "{skips:?}");
    assert!(skips[0].contains("picture 1") && skips[0].contains("flipped"));
    assert!(skips[1].contains("picture 2") && skips[1].contains("cover"));
    identical_except(&original, &saved, &[]);
}

#[test]
fn a_picture_of_unknown_size_reports_instead_of_writing() {
    // The same document with the media bytes replaced by a metafile header:
    // the picture's pixel size is not read, so the crop cannot be inverted.
    let original = picture_crop_docx();
    let mut pkg = OpcPackage::read(&original).unwrap();
    pkg.set_part(
        "word/media/image1.png",
        vec![0xD7, 0xCD, 0xC6, 0x9A, 0, 0, 0, 0],
    );
    let metafile = pkg.write().unwrap();
    let session = DocSession::load(&metafile).unwrap();
    let lowered = session.lowered();
    assert!(lowered
        .diagnostics
        .iter()
        .any(|d| d.message.contains("cropped picture")));
    let to = placement((10_000, 0, 10_000, 0), CROP_CASES[1].1);
    let (saved, skips) = save(&session, &|d| (d == 1).then_some(Some(to)));
    assert_eq!(skips.len(), 1, "{skips:?}");
    assert!(skips[0].contains("picture 1") && skips[0].contains("metafile"));
    identical_except(&metafile, &saved, &[]);
}

#[test]
fn a_crop_in_a_table_cell_is_written_back_inline_and_anchored() {
    let original = picture_crop_cell_docx();
    let session = DocSession::load(&original).unwrap();
    // Drawing 0 (inline, cell 0) and drawing 1 (anchored, cell 1).
    let a: Crop = (5_000, 5_000, 45_000, 5_000);
    let b: Crop = (0, 0, 12_500, 25_000);
    let (saved, skips) = save(&session, &|d| match d {
        0 => Some(Some(placement(a, CELL_CROP_CASES[0].1))),
        1 => Some(Some(placement(b, CELL_CROP_CASES[1].1))),
        _ => None,
    });
    assert!(skips.is_empty(), "{skips:?}");
    identical_except(&original, &saved, &[MAIN]);
    assert_eq!(crops(&saved), vec![Some(a), Some(b)]);
    let xml = text(&saved, MAIN);
    assert!(xml.contains(r#"<a:srcRect l="5000" t="5000" r="45000" b="5000"/>"#));
    assert!(xml.contains(r#"<a:srcRect r="12500" b="25000"/>"#));
}
