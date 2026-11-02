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

//! Doc ADR 623 — a picture's crop written back.
//!
//! The lowering places a cropped picture in its anchored frame by the inner
//! image transform `[a, 0, 0, d, e, f]` (`docx_lower`, `crop_placement`:
//! the image is shown at `w / (1 - l - r)` by `h / (1 - t - b)` with its top
//! left corner `l` and `t` of that outside the frame). This module is the
//! inverse: the placement the canvas holds now ([`PictureIn::placement`],
//! read back with the story, engine ADR 1045's amendment) gives the
//! fractions left out at each side, in 1/1000 percent, and the picture's
//! `pic:blipFill/a:srcRect` is spliced to say so. Nothing else of the part
//! moves; a placement the lowering made is not written (an unedited
//! picture keeps its XML byte for byte).
//!
//! A drawing is found by its ordinal among the part's `wp:inline` and
//! `wp:anchor` elements (the import's, [`docx_core::Image::drawing`]), and
//! the splice checks that the `a:srcRect` it finds is the one the import
//! read before it changes anything. A picture whose pixel size the bytes do
//! not give (a metafile), a placement that is not a plain scale and shift
//! (a flip, a skew), and a placement that does not cover the frame (Word
//! pads with a negative rectangle, which the import does not carry) are
//! refused with a line in the ledger.

use docx_core::{Block, Crop, DocxDocument, Image};
use docx_lower::ir::{LoweredBlock, LoweredDoc, LoweredImage, LoweredParagraph};
use paged_ooxml::{OoxmlError, OpcPackage};
use quick_xml::events::{BytesStart, Event};
use quick_xml::name::ResolveResult;
use quick_xml::NsReader;
use serde::{Deserialize, Serialize};

use crate::overlay::TableParagraphs;

const NS_WP: &[u8] = b"http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing";
const NS_A: &[u8] = b"http://schemas.openxmlformats.org/drawingml/2006/main";
const NS_PIC: &[u8] = b"http://schemas.openxmlformats.org/drawingml/2006/picture";

/// A placement the lowering made is read back as the f32s it wrote; two
/// placements within this of each other (relative to the larger value, with
/// a point as the floor) are the same.
const SAME: f32 = 1e-3;
/// A side may come out this much below nothing before it is a padding
/// rather than a rounding (a fraction of the image).
const PAD: f32 = 5e-4;
/// A recomputed crop within this of the import's (1/1000 percent per side)
/// is the import's: the lowering's rounding, not an edit.
const SLACK: i32 = 2;

/// One picture of a read-back paragraph (the engine's `PictureContent`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PictureIn {
    /// The anchored frame's id.
    #[serde(default)]
    pub frame_id: String,
    /// The character offset of its anchor in the paragraph.
    #[serde(default)]
    pub offset: u32,
    /// The inner image transform of the frame, `None` while the picture
    /// fills it.
    #[serde(default)]
    pub placement: Option<[f32; 6]>,
}

/// The pictures of the read-back paragraphs: one entry per paragraph of the
/// merged body read-back (the paragraphs the text overlay maps onto the
/// lowered blocks), and the same for each native table cell read with its
/// paragraphs.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PicturesIn {
    #[serde(default)]
    pub body: Vec<Vec<PictureIn>>,
    #[serde(default)]
    pub cells: Vec<CellPicturesIn>,
}

/// The pictures of one native table cell's paragraphs.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CellPicturesIn {
    /// The table's lowered block and the cell's index in its lowered cells.
    pub block: usize,
    pub cell: usize,
    #[serde(default)]
    pub paragraphs: Vec<Vec<PictureIn>>,
}

/// The crop a placement stands for: `Ok(None)` for a picture that fills its
/// frame, else the sides left out in 1/1000 percent. `size` is the frame
/// (`wp:extent`, points), `pixels` the picture's own size.
pub fn crop_of_placement(
    placement: Option<[f32; 6]>,
    size: (f32, f32),
    pixels: (u32, u32),
) -> Result<Option<Crop>, String> {
    let Some([a, b, c, d, e, f]) = placement else {
        return Ok(None);
    };
    let (w, h) = size;
    if !(a > 0.0 && d > 0.0 && w > 0.0 && h > 0.0) {
        return Err("the picture is flipped or collapsed, which a:srcRect cannot say".into());
    }
    let tol = 1e-4;
    if b.abs() > tol || c.abs() > tol {
        return Err(
            "the picture is rotated or skewed in its frame, which a:srcRect cannot say".into(),
        );
    }
    let disp_w = a * pixels.0 as f32;
    let disp_h = d * pixels.1 as f32;
    let l = -e / disp_w;
    let t = -f / disp_h;
    let r = 1.0 - l - w / disp_w;
    let bt = 1.0 - t - h / disp_h;
    if [l, t, r, bt].iter().any(|v| *v < -PAD) {
        return Err(
            "the picture does not cover its frame (Word pads with a negative a:srcRect, \
             which is not carried)"
                .into(),
        );
    }
    let unit = |v: f32| (v.max(0.0) * 100_000.0).round() as i32;
    let crop = (unit(l), unit(t), unit(r), unit(bt));
    if crop.0 + crop.2 >= 100_000 || crop.1 + crop.3 >= 100_000 {
        return Err("the crop leaves no picture".into());
    }
    Ok(if crop == (0, 0, 0, 0) {
        None
    } else {
        Some(crop)
    })
}

fn same_placement(a: Option<[f32; 6]>, b: Option<[f32; 6]>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(a), Some(b)) => a
            .iter()
            .zip(&b)
            .all(|(x, y)| (x - y).abs() <= SAME * x.abs().max(y.abs()).max(1.0)),
        _ => false,
    }
}

fn near(a: Option<Crop>, b: Option<Crop>) -> bool {
    let z = (0, 0, 0, 0);
    let (a, b) = (a.unwrap_or(z), b.unwrap_or(z));
    (a.0 - b.0).abs() <= SLACK
        && (a.1 - b.1).abs() <= SLACK
        && (a.2 - b.2).abs() <= SLACK
        && (a.3 - b.3).abs() <= SLACK
}

/// A picture of the lowering paired with what the canvas holds of it.
struct Pair<'a> {
    image: &'a LoweredImage,
    read: PictureIn,
}

/// The pictures of one lowered paragraph paired with the ones read back for
/// it (in the order of their anchors, as the lowering lists them). A
/// paragraph whose counts disagree is left out: a picture added or removed
/// on the canvas leaves no way to tell which is which.
fn pair<'a>(
    p: &'a LoweredParagraph,
    read: &[PictureIn],
    at: &str,
    unmatched: &mut Vec<String>,
) -> Vec<Pair<'a>> {
    // Nothing read back: a host without the picture read (or the picture
    // removed on the canvas, which is not written either).
    if p.images.is_empty() || read.is_empty() {
        return Vec::new();
    }
    if p.images.len() != read.len() {
        unmatched.push(at.to_string());
        return Vec::new();
    }
    p.images
        .iter()
        .zip(read)
        .map(|(image, read)| Pair {
            image,
            read: read.clone(),
        })
        .collect()
}

/// The model's picture with `ordinal` among the body's drawings (tables
/// included, nested tables not).
fn model_image(model: &DocxDocument, ordinal: u32) -> Option<&Image> {
    fn in_paragraph(p: &docx_core::Paragraph, ordinal: u32) -> Option<&Image> {
        p.runs
            .iter()
            .flat_map(|r| r.images.iter())
            .find(|i| i.drawing == Some(ordinal))
    }
    model.body.iter().find_map(|b| match b {
        Block::Paragraph(p) => in_paragraph(p, ordinal),
        Block::Table(t) => t
            .rows
            .iter()
            .flat_map(|r| r.cells.iter())
            .flat_map(|c| c.paragraphs.iter())
            .find_map(|p| in_paragraph(p, ordinal)),
    })
}

/// What the splice does to one drawing.
#[derive(Debug, Clone, PartialEq)]
struct CropEdit {
    ordinal: u32,
    /// The crop the import read (what the part must still say).
    was: Option<Crop>,
    /// The crop to write.
    now: Option<Crop>,
}

/// Write the crops the canvas changed into `main_part`: `read` holds the
/// pictures of the story read back (its paragraphs lined up with
/// `lowered`'s blocks as the text overlay lines them up) and of the native
/// table cells read back. Answers what it refused.
pub fn save_crops(
    pkg: &mut OpcPackage,
    main_part: &str,
    model: &DocxDocument,
    lowered: &LoweredDoc,
    read: &PicturesIn,
    tables: TableParagraphs,
) -> Result<Vec<String>, OoxmlError> {
    let mut skips = Vec::new();
    let mut unmatched: Vec<String> = Vec::new();
    let mut pairs: Vec<Pair> = Vec::new();

    // The body: read-back paragraphs map onto the lowered paragraph blocks
    // in order, a block taking `1 + segments` of them (the overlay's rule).
    let mut ci = 0usize;
    for (b, block) in lowered.story.blocks.iter().enumerate() {
        match block {
            LoweredBlock::Table(t) => {
                ci += t.flow.iter().map(|p| 1 + p.segments.len()).sum::<usize>();
                if t.flow.is_empty() && tables == TableParagraphs::Own {
                    ci += 1;
                }
            }
            LoweredBlock::Paragraph(p) => {
                let parts = 1 + p.segments.len();
                if ci >= read.body.len() {
                    break;
                }
                let end = (ci + parts).min(read.body.len());
                let here: Vec<PictureIn> = read.body[ci..end].iter().flatten().cloned().collect();
                ci = end;
                let at = format!("block {b}");
                pairs.extend(pair(p, &here, &at, &mut unmatched));
            }
        }
    }
    // Native table cells: the styled read of a cell holds its pictures.
    for c in &read.cells {
        let Some(LoweredBlock::Table(t)) = lowered.story.blocks.get(c.block) else {
            continue;
        };
        let Some(cell) = t.cells.get(c.cell) else {
            continue;
        };
        if c.paragraphs.len() != cell.paragraphs.len() {
            continue;
        }
        for (k, (p, q)) in cell.paragraphs.iter().zip(&c.paragraphs).enumerate() {
            let at = format!("block {} cell {} paragraph {k}", c.block, c.cell);
            pairs.extend(pair(p, q, &at, &mut unmatched));
        }
    }

    let mut edits: Vec<CropEdit> = Vec::new();
    for Pair { image, read } in &pairs {
        let Some(ordinal) = image.drawing else {
            continue;
        };
        let was = image.crop.and_then(|c| c.placement);
        if same_placement(was, read.placement) {
            continue;
        }
        let label = format!("picture {ordinal}");
        let Some(source) = model_image(model, ordinal) else {
            skips.push(format!(
                "{label}: crop edit refused: not found in the import"
            ));
            continue;
        };
        let Some(pixels) = paged_ooxml::media::pixel_size(&source.bytes) else {
            skips.push(format!(
                "{label}: crop edit refused: the picture's size is not read from its bytes (a metafile)"
            ));
            continue;
        };
        let size = (
            source.width_emu as f32 / 12_700.0,
            source.height_emu as f32 / 12_700.0,
        );
        let now = match crop_of_placement(read.placement, size, pixels) {
            Ok(c) => c,
            Err(why) => {
                skips.push(format!("{label}: crop edit refused: {why}"));
                continue;
            }
        };
        if near(now, source.crop) {
            continue;
        }
        edits.push(CropEdit {
            ordinal,
            was: source.crop,
            now,
        });
    }
    if !unmatched.is_empty() {
        skips.push(format!(
            "{} paragraph(s) hold other pictures than the import ({}): their crops are not \
             written",
            unmatched.len(),
            unmatched.join(", ")
        ));
    }
    if edits.is_empty() {
        return Ok(skips);
    }
    let bytes = pkg.require(main_part)?.to_vec();
    let (out, mut more) = splice_crops(&bytes, &edits);
    skips.append(&mut more);
    if out != bytes {
        pkg.set_part(main_part, out);
    }
    Ok(skips)
}

/// Where a drawing's picture keeps its crop in the part.
#[derive(Debug, Clone, Default)]
struct BlipAt {
    /// Where an `a:srcRect` goes when there is none: after the `a:blip`.
    blip_end: Option<usize>,
    /// The prefix of the DrawingML main namespace as the blip writes it
    /// (`a:`, or none).
    prefix: String,
    /// The existing `a:srcRect`'s byte range.
    rect: Option<(usize, usize)>,
    /// What it says.
    says: Option<Crop>,
}

/// Every top-level `wp:inline` / `wp:anchor` of `part` in document order
/// (the import's drawings), each with where its picture's crop stands.
fn scan(part: &[u8]) -> Vec<BlipAt> {
    let mut reader = NsReader::from_reader(part);
    reader.config_mut().trim_text(false);
    let mut out: Vec<BlipAt> = Vec::new();
    // Depth inside the current drawing (the drawing is 0); `None` outside.
    let mut depth: Option<usize> = None;
    let mut in_fill = false;
    let mut seen_fill = false;
    let mut rect_start = 0usize;
    let mut buf = Vec::new();
    let resolve = |reader: &NsReader<&[u8]>, e: &BytesStart| -> (Vec<u8>, String) {
        let (res, local) = reader.resolver().resolve_element(e.name());
        let uri = match res {
            ResolveResult::Bound(n) => n.as_ref().to_vec(),
            _ => Vec::new(),
        };
        (uri, String::from_utf8_lossy(local.as_ref()).to_string())
    };
    loop {
        let before = reader.buffer_position() as usize;
        let ev = match reader.read_event_into(&mut buf) {
            Ok(e) => e,
            Err(_) => break,
        };
        let after = reader.buffer_position() as usize;
        match &ev {
            Event::Start(e) | Event::Empty(e) => {
                let empty = matches!(ev, Event::Empty(_));
                let (uri, local) = resolve(&reader, e);
                match depth {
                    None => {
                        if uri == NS_WP && (local == "inline" || local == "anchor") {
                            out.push(BlipAt::default());
                            if !empty {
                                depth = Some(0);
                                in_fill = false;
                                seen_fill = false;
                            }
                        }
                    }
                    Some(d) => {
                        let at = d + 1;
                        if at == 4 && uri == NS_PIC && local == "blipFill" && !seen_fill {
                            seen_fill = true;
                            in_fill = !empty;
                        } else if at == 5 && in_fill {
                            if let Some(cur) = out.last_mut() {
                                if uri == NS_A && local == "blip" {
                                    cur.prefix = qname_prefix(e);
                                    if empty {
                                        cur.blip_end = Some(after);
                                    }
                                } else if uri == NS_A && local == "srcRect" {
                                    cur.says = rect_of(e);
                                    if empty {
                                        cur.rect = Some((before, after));
                                    } else {
                                        rect_start = before;
                                    }
                                }
                            }
                        }
                        if !empty {
                            depth = Some(at);
                        }
                    }
                }
            }
            Event::End(e) => {
                if let Some(d) = depth {
                    if d == 0 {
                        depth = None;
                    } else {
                        if d == 5 && in_fill {
                            let (uri, local) = {
                                let (res, local) = reader.resolver().resolve_element(e.name());
                                let uri = match res {
                                    ResolveResult::Bound(n) => n.as_ref().to_vec(),
                                    _ => Vec::new(),
                                };
                                (uri, String::from_utf8_lossy(local.as_ref()).to_string())
                            };
                            if let Some(cur) = out.last_mut() {
                                if uri == NS_A && local == "blip" {
                                    cur.blip_end = Some(after);
                                } else if uri == NS_A && local == "srcRect" {
                                    cur.rect = Some((rect_start, after));
                                }
                            }
                        }
                        if d == 4 {
                            in_fill = false;
                        }
                        depth = Some(d - 1);
                    }
                }
            }
            Event::Eof => break,
            _ => {}
        }
        buf.clear();
    }
    out
}

/// The prefix (with its colon) a start tag's name carries; empty for none.
fn qname_prefix(e: &BytesStart) -> String {
    let name = e.name();
    let raw = name.as_ref();
    raw.iter()
        .position(|b| *b == b':')
        .map(|i| String::from_utf8_lossy(&raw[..=i]).to_string())
        .unwrap_or_default()
}

/// An `a:srcRect`'s sides (a missing one is 0), `None` when it crops
/// nothing.
fn rect_of(e: &BytesStart) -> Option<Crop> {
    let mut side = [0i32; 4];
    for a in e.attributes().flatten() {
        let i = match a.key.local_name().as_ref() {
            b"l" => 0,
            b"t" => 1,
            b"r" => 2,
            b"b" => 3,
            _ => continue,
        };
        side[i] = String::from_utf8_lossy(&a.value)
            .trim()
            .parse()
            .unwrap_or(0);
    }
    let c = (side[0], side[1], side[2], side[3]);
    (c != (0, 0, 0, 0)).then_some(c)
}

/// The `a:srcRect` for `crop`: Word writes only the sides it crops.
fn rect_text(prefix: &str, crop: Crop) -> String {
    let mut s = format!("<{prefix}srcRect");
    for (name, v) in [("l", crop.0), ("t", crop.1), ("r", crop.2), ("b", crop.3)] {
        if v != 0 {
            s.push_str(&format!(" {name}=\"{v}\""));
        }
    }
    s.push_str("/>");
    s
}

/// Splice `edits` into `part`: each drawing's `a:srcRect` replaced, added
/// after its `a:blip`, or removed. An edit whose drawing is missing, whose
/// crop is not the import's, or that has no blip is refused with a line.
fn splice_crops(part: &[u8], edits: &[CropEdit]) -> (Vec<u8>, Vec<String>) {
    let drawings = scan(part);
    let mut skips = Vec::new();
    // (start, end, replacement)
    let mut holes: Vec<(usize, usize, String)> = Vec::new();
    for e in edits {
        let label = format!("picture {}", e.ordinal);
        let Some(at) = drawings.get(e.ordinal as usize) else {
            skips.push(format!("{label}: crop edit refused: not found in the part"));
            continue;
        };
        if at.says != e.was {
            skips.push(format!(
                "{label}: crop edit refused: its a:srcRect is not the one the import read"
            ));
            continue;
        }
        let hole = match (at.rect, at.blip_end, e.now) {
            (Some((s, t)), _, Some(now)) => (s, t, rect_text(&at.prefix, now)),
            (Some((s, t)), _, None) => (s, t, String::new()),
            (None, Some(end), Some(now)) => (end, end, rect_text(&at.prefix, now)),
            (None, Some(_), None) => continue,
            (None, None, _) => {
                skips.push(format!(
                    "{label}: crop edit refused: the drawing has no a:blip"
                ));
                continue;
            }
        };
        holes.push(hole);
    }
    holes.sort_by_key(|h| std::cmp::Reverse(h.0));
    let mut out = part.to_vec();
    for (s, t, text) in holes {
        out.splice(s..t, text.into_bytes());
    }
    (out, skips)
}

#[cfg(test)]
mod tests {
    use super::*;

    const PIC: &str = "http://schemas.openxmlformats.org/drawingml/2006/picture";

    fn doc(rect: &str) -> String {
        format!(
            "<w:document xmlns:w=\"w\" xmlns:wp=\"{}\" xmlns:a=\"{}\" xmlns:pic=\"{PIC}\" \
             xmlns:r=\"r\"><w:body><w:p><w:r><w:drawing><wp:inline><wp:extent cx=\"1\" cy=\"1\"/>\
             <wp:docPr id=\"1\" name=\"x\"/><a:graphic><a:graphicData uri=\"{PIC}\"><pic:pic>\
             <pic:blipFill><a:blip r:embed=\"rId4\"/>{rect}<a:stretch><a:fillRect/></a:stretch>\
             </pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>\
             </w:p></w:body></w:document>",
            String::from_utf8_lossy(NS_WP),
            String::from_utf8_lossy(NS_A),
        )
    }

    fn edit(was: Option<Crop>, now: Option<Crop>) -> CropEdit {
        CropEdit {
            ordinal: 0,
            was,
            now,
        }
    }

    #[test]
    fn a_missing_rectangle_is_added_after_the_blip() {
        let src = doc("");
        let (out, skips) =
            splice_crops(src.as_bytes(), &[edit(None, Some((25_000, 0, 25_000, 0)))]);
        assert!(skips.is_empty(), "{skips:?}");
        let out = String::from_utf8(out).unwrap();
        assert!(out
            .contains("<a:blip r:embed=\"rId4\"/><a:srcRect l=\"25000\" r=\"25000\"/><a:stretch>"));
    }

    #[test]
    fn an_existing_rectangle_is_replaced_and_only_it() {
        let src = doc("<a:srcRect l=\"1000\" t=\"2000\"/>");
        let want = Some((1_000, 2_000, 0, 0));
        let (out, skips) = splice_crops(src.as_bytes(), &[edit(want, Some((0, 0, 10_000, 5_000)))]);
        assert!(skips.is_empty(), "{skips:?}");
        let out = String::from_utf8(out).unwrap();
        assert_eq!(
            out,
            src.replace(
                "<a:srcRect l=\"1000\" t=\"2000\"/>",
                "<a:srcRect r=\"10000\" b=\"5000\"/>"
            )
        );
    }

    #[test]
    fn a_crop_taken_away_removes_the_rectangle() {
        let src = doc("<a:srcRect l=\"1000\"></a:srcRect>");
        let (out, skips) = splice_crops(src.as_bytes(), &[edit(Some((1_000, 0, 0, 0)), None)]);
        assert!(skips.is_empty(), "{skips:?}");
        assert_eq!(String::from_utf8(out).unwrap(), doc(""));
    }

    #[test]
    fn a_rectangle_other_than_the_imports_is_refused() {
        let src = doc("<a:srcRect l=\"1000\"/>");
        let (out, skips) = splice_crops(src.as_bytes(), &[edit(Some((9, 0, 0, 0)), None)]);
        assert_eq!(out, src.as_bytes());
        assert_eq!(skips.len(), 1);
    }

    #[test]
    fn the_inverse_of_the_lowerings_placement() {
        // 200 x 100 pixels shown at 72 x 72 points, l = r = 25 %.
        let (l, t, r, b) = (0.25f32, 0.0f32, 0.25f32, 0.0f32);
        let (w, h) = (72.0f32, 72.0f32);
        let (dw, dh) = (w / (1.0 - l - r), h / (1.0 - t - b));
        let p = [dw / 200.0, 0.0, 0.0, dh / 100.0, -l * dw, -t * dh];
        assert_eq!(
            crop_of_placement(Some(p), (w, h), (200, 100)),
            Ok(Some((25_000, 0, 25_000, 0)))
        );
        assert_eq!(crop_of_placement(None, (w, h), (200, 100)), Ok(None));
        // A picture that fills its frame has no crop.
        let whole = [w / 200.0, 0.0, 0.0, h / 100.0, 0.0, 0.0];
        assert_eq!(crop_of_placement(Some(whole), (w, h), (200, 100)), Ok(None));
    }

    #[test]
    fn a_placement_that_cannot_be_a_crop_is_refused() {
        let (w, h) = (72.0f32, 72.0f32);
        // Flipped.
        assert!(
            crop_of_placement(Some([-1.0, 0.0, 0.0, 1.0, 0.0, 0.0]), (w, h), (72, 72)).is_err()
        );
        // Skewed.
        assert!(crop_of_placement(Some([1.0, 0.5, 0.0, 1.0, 0.0, 0.0]), (w, h), (72, 72)).is_err());
        // Does not cover the frame (shifted right: padding at the left).
        assert!(
            crop_of_placement(Some([1.0, 0.0, 0.0, 1.0, 10.0, 0.0]), (w, h), (72, 72)).is_err()
        );
        // Smaller than the frame.
        assert!(crop_of_placement(Some([0.5, 0.0, 0.0, 0.5, 0.0, 0.0]), (w, h), (72, 72)).is_err());
    }
}
