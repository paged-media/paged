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

//! The doc-reach documents: drop caps (`w:framePr w:dropCap`) and cropped
//! pictures (`a:srcRect`). `dump-fixture <out> drop-cap|picture-crop|picture-crop-cell` writes
//! them; `scripts/word-pagination-probe.sh` has Word render them to PDF.

use std::io::Write;

use crate::{zip_parts, ROOT_RELS, THEME_CONTENT_TYPES, THEME_DOC_RELS, THEME_STYLES, THEME_XML};

const NS: &str = r#"xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture""#;

/// The picture the crop documents use: 200 x 100 pixels, red growing to
/// the right, green growing downward, a blue 20-pixel checker, and a white
/// 1-pixel frame, so any crop reads off the colours.
pub const CROP_PNG_W: u32 = 200;
/// See [`CROP_PNG_W`].
pub const CROP_PNG_H: u32 = 100;

/// The crop picture as a PNG.
pub fn crop_png() -> Vec<u8> {
    fn chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
        out.extend_from_slice(&(data.len() as u32).to_be_bytes());
        let mut crc = flate2::Crc::new();
        crc.update(kind);
        crc.update(data);
        out.extend_from_slice(kind);
        out.extend_from_slice(data);
        out.extend_from_slice(&crc.sum().to_be_bytes());
    }
    let (w, h) = (CROP_PNG_W, CROP_PNG_H);
    let mut raw = Vec::new();
    for y in 0..h {
        raw.push(0u8);
        for x in 0..w {
            if x == 0 || y == 0 || x == w - 1 || y == h - 1 {
                raw.extend_from_slice(&[255, 255, 255]);
            } else {
                let checker = ((x / 20) + (y / 20)) % 2 == 0;
                raw.extend_from_slice(&[
                    (x * 255 / w) as u8,
                    (y * 255 / h) as u8,
                    if checker { 255 } else { 0 },
                ]);
            }
        }
    }
    let mut z = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
    z.write_all(&raw).unwrap();
    let z = z.finish().unwrap();
    let mut out = b"\x89PNG\r\n\x1a\n".to_vec();
    let mut ihdr = Vec::new();
    ihdr.extend_from_slice(&w.to_be_bytes());
    ihdr.extend_from_slice(&h.to_be_bytes());
    ihdr.extend_from_slice(&[8, 2, 0, 0, 0]);
    chunk(&mut out, b"IHDR", &ihdr);
    chunk(&mut out, b"IDAT", &z);
    chunk(&mut out, b"IEND", &[]);
    out
}

pub(crate) fn package(body: &str, with_image: bool) -> Vec<u8> {
    let document = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document {NS}><w:body>{body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>"#
    );
    let content_types = THEME_CONTENT_TYPES.replace(
        r#"<Default Extension="xml" ContentType="application/xml"/>"#,
        r#"<Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>"#,
    );
    let rels = if with_image {
        THEME_DOC_RELS.replace(
            "</Relationships>",
            r#"  <Relationship Id="rImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>
</Relationships>"#,
        )
    } else {
        THEME_DOC_RELS.to_string()
    };
    let settings = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:clrSchemeMapping w:bg1="light1" w:t1="dark1" w:bg2="light2" w:t2="dark2" w:accent1="accent1" w:accent2="accent2" w:accent3="accent3" w:accent4="accent4" w:accent5="accent5" w:accent6="accent6" w:hyperlink="hyperlink" w:followedHyperlink="followedHyperlink"/></w:settings>"#;
    let png = crop_png();
    let mut parts: Vec<(&str, &[u8])> = vec![
        ("[Content_Types].xml", content_types.as_bytes()),
        ("_rels/.rels", ROOT_RELS.as_bytes()),
        ("word/document.xml", document.as_bytes()),
        ("word/_rels/document.xml.rels", rels.as_bytes()),
        ("word/styles.xml", THEME_STYLES.as_bytes()),
        ("word/settings.xml", settings.as_bytes()),
        ("word/theme/theme1.xml", THEME_XML.as_bytes()),
    ];
    if with_image {
        parts.push(("word/media/image1.png", &png));
    }
    zip_parts(&parts)
}

/// The filler the drop-cap paragraphs run on: a few lines of body text.
pub const DROP_CAP_FILLER: &str = "he quick brown fox jumps over the lazy dog while the five boxing wizards jump quickly and pack my box with five dozen liquor jugs, so that the paragraph runs to many lines beside the big letter.";

/// A Word drop cap as Word writes it: a framed paragraph holding the cap
/// characters (`w:framePr w:dropCap`, exact line spacing of `lines` lines,
/// the run enlarged and lowered), then the paragraph proper.
pub fn drop_cap_paragraphs(kind: &str, lines: u32, cap: &str, rest: &str) -> String {
    // Calibri 11 pt: 13.4 pt a line. Word enlarges the cap so that its
    // capital height spans the lines and lowers it by the lines beyond
    // the first.
    let line_pt = 13.4_f64;
    let exact = (line_pt * f64::from(lines) * 20.0).round() as u32;
    let size_half_pt = (line_pt * f64::from(lines) * 2.0 * 1.2).round() as u32;
    let lower = ((f64::from(lines) - 1.0) * line_pt * 0.5 * 2.0).round() as i32;
    format!(
        r#"<w:p><w:pPr><w:framePr w:dropCap="{kind}" w:lines="{lines}" w:wrap="around" w:vAnchor="text" w:hAnchor="margin"/><w:spacing w:after="0" w:line="{exact}" w:lineRule="exact"/><w:textAlignment w:val="baseline"/></w:pPr><w:r><w:rPr><w:position w:val="-{lower}"/><w:sz w:val="{size_half_pt}"/></w:rPr><w:t>{cap}</w:t></w:r></w:p><w:p><w:r><w:t>{rest}</w:t></w:r></w:p>"#
    )
}

/// Drop caps: one character over three lines, two over two, and a margin
/// drop cap, each between plain paragraphs.
pub fn drop_cap_docx() -> Vec<u8> {
    let plain = |t: &str| format!(r#"<w:p><w:r><w:t>{t}</w:t></w:r></w:p>"#);
    let body = [
        plain("P0 a plain paragraph before the drop caps."),
        drop_cap_paragraphs("drop", 3, "T", DROP_CAP_FILLER),
        plain("P2 a plain paragraph between them."),
        drop_cap_paragraphs("drop", 2, "Th", &DROP_CAP_FILLER[1..]),
        plain("P4 a plain paragraph between them."),
        drop_cap_paragraphs("margin", 3, "T", DROP_CAP_FILLER),
        plain("P6 the last paragraph."),
    ]
    .concat();
    package(&body, false)
}

/// An `a:srcRect` (`l`, `t`, `r`, `b`, 1/1000 percent) and the extent in
/// EMU the cropped picture is shown at.
pub type CropCase = ((i32, i32, i32, i32), (i64, i64));

/// One `a:srcRect` per picture.
pub const CROP_CASES: &[CropCase] = &[
    ((0, 0, 0, 0), (1_828_800, 914_400)),
    ((25_000, 0, 25_000, 0), (914_400, 914_400)),
    ((0, 10_000, 0, 40_000), (1_828_800, 457_200)),
    ((10_000, 20_000, 30_000, 10_000), (1_097_280, 640_080)),
];

fn src_rect((l, t, r, b): (i32, i32, i32, i32)) -> String {
    let attr = |n: &str, v: i32| {
        if v == 0 {
            String::new()
        } else {
            format!(r#" {n}="{v}""#)
        }
    };
    if (l, t, r, b) == (0, 0, 0, 0) {
        String::new()
    } else {
        format!(
            "<a:srcRect{}{}{}{}/>",
            attr("l", l),
            attr("t", t),
            attr("r", r),
            attr("b", b)
        )
    }
}

fn pic(id: usize, crop: (i32, i32, i32, i32), (cx, cy): (i64, i64)) -> String {
    format!(
        r#"<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="{id}" name="image1.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rImg"/>{}<a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="{cx}" cy="{cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic>"#,
        src_rect(crop)
    )
}

/// Cropped pictures: every [`CROP_CASES`] entry inline, then the same
/// anchored (top-and-bottom wrap, against the column and the paragraph).
pub fn picture_crop_docx() -> Vec<u8> {
    let mut body = String::new();
    for (i, (crop, (cx, cy))) in CROP_CASES.iter().enumerate() {
        let id = i + 1;
        body.push_str(&format!(
            r#"<w:p><w:r><w:t>Inline {id}</w:t></w:r></w:p><w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="{cx}" cy="{cy}"/><wp:docPr id="{id}" name="Picture {id}"/><wp:cNvGraphicFramePr/>{}</wp:inline></w:drawing></w:r></w:p>"#,
            pic(id, *crop, (*cx, *cy))
        ));
    }
    for (i, (crop, (cx, cy))) in CROP_CASES.iter().enumerate() {
        let id = i + 11;
        body.push_str(&format!(
            r#"<w:p><w:r><w:t>Anchored {id}</w:t></w:r><w:r><w:drawing><wp:anchor distT="0" distB="0" distL="114300" distR="114300" simplePos="0" relativeHeight="251659264" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="column"><wp:posOffset>2743200</wp:posOffset></wp:positionH><wp:positionV relativeFrom="paragraph"><wp:posOffset>0</wp:posOffset></wp:positionV><wp:extent cx="{cx}" cy="{cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapSquare wrapText="bothSides"/><wp:docPr id="{id}" name="Picture {id}"/><wp:cNvGraphicFramePr/>{}</wp:anchor></w:drawing></w:r></w:p><w:p><w:r><w:t>after {id}</w:t></w:r></w:p><w:p/><w:p/><w:p/>"#,
            pic(id, *crop, (*cx, *cy))
        ));
    }
    package(&body, true)
}

/// The pictures of [`picture_crop_cell_docx`]: an `a:srcRect` and the extent
/// in EMU, one inline and one anchored, each in a cell of its own.
pub const CELL_CROP_CASES: &[CropCase] = &[
    ((25_000, 0, 25_000, 0), (914_400, 914_400)),
    ((0, 10_000, 0, 40_000), (1_828_800, 457_200)),
];

/// Cropped pictures in table cells (doc ADR 623): a table of one row and
/// two cells, the first holding an inline cropped picture, the second the
/// same kind of picture anchored (against the cell), each after a line of
/// text, and a paragraph before and after the table.
pub fn picture_crop_cell_docx() -> Vec<u8> {
    let (inline_crop, (icx, icy)) = CELL_CROP_CASES[0];
    let (float_crop, (fcx, fcy)) = CELL_CROP_CASES[1];
    let inline = format!(
        r#"<w:p><w:r><w:t>Inline in a cell</w:t></w:r></w:p><w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="{icx}" cy="{icy}"/><wp:docPr id="21" name="Picture 21"/><wp:cNvGraphicFramePr/>{}</wp:inline></w:drawing></w:r></w:p>"#,
        pic(21, inline_crop, (icx, icy))
    );
    let anchored = format!(
        r#"<w:p><w:r><w:t>Anchored in a cell</w:t></w:r><w:r><w:drawing><wp:anchor distT="0" distB="0" distL="114300" distR="114300" simplePos="0" relativeHeight="251659264" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="column"><wp:posOffset>0</wp:posOffset></wp:positionH><wp:positionV relativeFrom="paragraph"><wp:posOffset>182880</wp:posOffset></wp:positionV><wp:extent cx="{fcx}" cy="{fcy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapSquare wrapText="bothSides"/><wp:docPr id="22" name="Picture 22"/><wp:cNvGraphicFramePr/>{}</wp:anchor></w:drawing></w:r></w:p>"#,
        pic(22, float_crop, (fcx, fcy))
    );
    let cell = |w: u32, content: &str| {
        format!(r#"<w:tc><w:tcPr><w:tcW w:w="{w}" w:type="dxa"/></w:tcPr>{content}</w:tc>"#)
    };
    let body = format!(
        r#"<w:p><w:r><w:t>Before the table</w:t></w:r></w:p><w:tbl><w:tblPr><w:tblW w:w="9000" w:type="dxa"/><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/></w:tblBorders></w:tblPr><w:tblGrid><w:gridCol w:w="4500"/><w:gridCol w:w="4500"/></w:tblGrid><w:tr>{}{}</w:tr></w:tbl><w:p><w:r><w:t>After the table</w:t></w:r></w:p>"#,
        cell(4500, &inline),
        cell(4500, &anchored)
    );
    package(&body, true)
}
