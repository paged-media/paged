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

//! Pictures of a sheet, read on demand: the `xdr:pic` anchors of its drawing
//! parts and the images placed in cells (`vm=` value metadata pointing at a
//! `_localImage` rich value).
//!
//! Nothing here is stored or rewritten: the drawing, media and rich-data
//! parts round-trip byte-identical (spec §10.2); the session asks for the
//! pictures of a sheet when it draws or places it, and for a picture's bytes
//! by its media part name.
//!
//! In-cell images follow the chain Excel writes: the cell's `vm` (1-based)
//! picks a `<valueMetadata>` block in `xl/metadata.xml`, whose `<rc t v>`
//! names the `XLRICHVALUE` metadata type and a `<futureMetadata>` block,
//! whose `xlrd:rvb i` is an index into `xl/richData/rdrichvalue.xml`; that
//! rich value's `_rvRel:LocalImageIdentifier` key (by its structure in
//! `rdrichvaluestructure.xml`) indexes `richValueRel.xml`, whose relationship
//! names the media part.

use crate::rels::{part_dir, resolve_target, REL_DRAWING};
use crate::xtree::XNode;
use crate::XlsxDocument;
use sheet_core::SheetId;

/// EMUs per point (`paged_ooxml::units`).
pub use paged_ooxml::units::EMU_PER_PT;

/// A cell corner plus an offset into it (EMU).
#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub struct CellOffset {
    pub col: u32,
    pub col_off: i64,
    pub row: u32,
    pub row_off: i64,
}

/// Where a picture sits.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum PictureAnchor {
    /// Between two cell corners (moves and sizes with the cells).
    TwoCell { from: CellOffset, to: CellOffset },
    /// From a cell corner with a fixed size (EMU).
    OneCell { from: CellOffset, cx: i64, cy: i64 },
    /// At a fixed sheet position with a fixed size (EMU).
    Absolute { x: i64, y: i64, cx: i64, cy: i64 },
    /// Placed in a cell (fitted into it).
    InCell { row: u32, col: u32 },
}

/// One picture of a sheet.
#[derive(Clone, Debug, PartialEq)]
pub struct SheetPicture {
    /// A stable handle: `<drawing part>#<anchor index>` or `cell:<A1>`.
    pub id: String,
    pub name: String,
    pub descr: Option<String>,
    pub anchor: PictureAnchor,
    /// The media part holding the image bytes.
    pub media: String,
    pub content_type: String,
    /// A drawing picture's `a:blip` and its shape's `a:effectLst`, as
    /// authored (sheet ADR 527): the page lowers them through the shared
    /// DrawingML mapper. `None` for an image in a cell, or a picture with
    /// neither an alpha, a picture effect nor an effect list.
    pub dml: Option<Box<PictureDml>>,
}

/// What a drawing picture paints beyond its image (sheet ADR 527).
#[derive(Clone, Debug, PartialEq, Default)]
pub struct PictureDml {
    pub blip: paged_ooxml::drawingml::Blip,
    pub effects: paged_ooxml::drawingml::Effects,
}

/// The DrawingML look of an `xdr:pic` (its `xdr:blipFill` and `xdr:spPr`).
fn picture_dml(pic: &paged_ooxml::tree::El) -> Option<Box<PictureDml>> {
    let rels = |_: &str| None;
    let blip = pic
        .children
        .iter()
        .find(|c| c.local == "blipFill")
        .map(|b| paged_ooxml::drawingml::blip(b, &rels))
        .unwrap_or_default();
    let effects = pic
        .children
        .iter()
        .find(|c| c.local == "spPr")
        .map(|sp| paged_ooxml::drawingml::effects_in(sp, &rels))
        .unwrap_or_default();
    let plain = blip.alpha.is_none() && blip.effects.is_empty() && effects.is_empty();
    (!plain).then(|| Box::new(PictureDml { blip, effects }))
}

fn offset(n: Option<&XNode>) -> Option<CellOffset> {
    let n = n?;
    let num = |k: &str| -> Option<i64> { n.child(k)?.text.as_deref()?.trim().parse().ok() };
    Some(CellOffset {
        col: num("col")?.max(0) as u32,
        col_off: num("colOff").unwrap_or(0),
        row: num("row")?.max(0) as u32,
        row_off: num("rowOff").unwrap_or(0),
    })
}

fn ext(n: Option<&XNode>) -> Option<(i64, i64)> {
    let n = n?;
    Some((n.attr("cx")?.parse().ok()?, n.attr("cy")?.parse().ok()?))
}

impl XlsxDocument {
    /// The content type of a part.
    fn content_type_of_part(&self, part: &str) -> String {
        self.container
            .content_types
            .content_type_of(&format!("/{part}"))
            .unwrap_or("application/octet-stream")
            .to_string()
    }

    /// Every picture of a sheet: drawing pictures in anchor order, then the
    /// images in cells (row-major).
    pub fn pictures_of(&self, sheet: SheetId) -> Vec<SheetPicture> {
        let mut out = self.drawing_pictures(sheet);
        out.extend(self.in_cell_pictures(sheet));
        out
    }

    /// The bytes of a media part (a picture's image).
    pub fn media_bytes(&self, part: &str) -> Option<Vec<u8>> {
        if !part.starts_with("xl/media/") {
            return None;
        }
        self.part_bytes(part)
    }

    fn drawing_pictures(&self, sheet: SheetId) -> Vec<SheetPicture> {
        let mut out = Vec::new();
        let Some(ws) = self.part_name_of(sheet) else {
            return out;
        };
        let Some(rels) = self.rels_of_part(ws) else {
            return out;
        };
        for rel in rels.all_of_type(REL_DRAWING) {
            let drawing = resolve_target(part_dir(ws), &rel.target);
            let Some(bytes) = self.part_bytes(&drawing) else {
                continue;
            };
            let Some(root) = XNode::parse(&bytes).ok() else {
                continue;
            };
            // The same part through the shared DrawingML reader, for the
            // pictures' look (anchor `i` is the same element in both).
            let dml_root = paged_ooxml::tree::parse(&bytes).ok();
            let Some(drels) = self.rels_of_part(&drawing) else {
                continue;
            };
            for (i, a) in root.children.iter().enumerate() {
                let Some(pic) = a.child("pic") else {
                    continue;
                };
                let anchor = match a.local() {
                    "twoCellAnchor" => match (offset(a.child("from")), offset(a.child("to"))) {
                        (Some(from), Some(to)) => PictureAnchor::TwoCell { from, to },
                        _ => continue,
                    },
                    "oneCellAnchor" => match (offset(a.child("from")), ext(a.child("ext"))) {
                        (Some(from), Some((cx, cy))) => PictureAnchor::OneCell { from, cx, cy },
                        _ => continue,
                    },
                    "absoluteAnchor" => {
                        let pos = a.child("pos");
                        let x = pos.and_then(|p| p.attr("x")?.parse().ok()).unwrap_or(0);
                        let y = pos.and_then(|p| p.attr("y")?.parse().ok()).unwrap_or(0);
                        match ext(a.child("ext")) {
                            Some((cx, cy)) => PictureAnchor::Absolute { x, y, cx, cy },
                            None => continue,
                        }
                    }
                    _ => continue,
                };
                let c_nv = pic.child("nvPicPr").and_then(|n| n.child("cNvPr"));
                let Some(embed) = pic
                    .child("blipFill")
                    .and_then(|b| b.child("blip"))
                    .and_then(|b| b.attr("embed"))
                else {
                    continue;
                };
                let Some(target) = drels.items.iter().find(|r| r.id == embed) else {
                    continue;
                };
                if target.target_mode.as_deref() == Some("External") {
                    continue; // a linked picture: nothing in the package
                }
                let media = resolve_target(part_dir(&drawing), &target.target);
                let dml = dml_root
                    .as_ref()
                    .and_then(|r| r.children.get(i))
                    .filter(|el| el.local == a.local())
                    .and_then(|el| el.children.iter().find(|c| c.local == "pic"))
                    .and_then(picture_dml);
                out.push(SheetPicture {
                    id: format!("{drawing}#{i}"),
                    name: c_nv.and_then(|c| c.attr("name")).unwrap_or_default(),
                    descr: c_nv.and_then(|c| c.attr("descr")),
                    anchor,
                    content_type: self.content_type_of_part(&media),
                    media,
                    dml,
                });
            }
        }
        out
    }

    /// The `(row, col, vm)` of every cell with value metadata.
    fn vm_cells(&self, sheet: SheetId) -> Vec<(u32, u32, usize)> {
        use quick_xml::events::Event;
        let mut out = Vec::new();
        let Some(bytes) = self.part_name_of(sheet).and_then(|p| self.part_bytes(p)) else {
            return out;
        };
        // A cheap guard: most sheets have none.
        if !bytes.windows(4).any(|w| w == b" vm=") {
            return out;
        }
        let mut reader = quick_xml::Reader::from_reader(bytes.as_slice());
        let mut buf = Vec::new();
        loop {
            match reader.read_event_into(&mut buf) {
                Ok(Event::Start(e)) | Ok(Event::Empty(e)) if e.local_name().as_ref() == b"c" => {
                    let mut r = None;
                    let mut vm = None;
                    for a in e.attributes().flatten() {
                        match a.key.local_name().as_ref() {
                            b"r" => r = Some(String::from_utf8_lossy(&a.value).into_owned()),
                            b"vm" => {
                                vm = String::from_utf8_lossy(&a.value)
                                    .trim()
                                    .parse::<usize>()
                                    .ok()
                            }
                            _ => {}
                        }
                    }
                    if let (Some(r), Some(vm)) = (r, vm) {
                        if let Some((row, col, _, _)) = sheet_core::parse_a1(&r) {
                            out.push((row, col, vm));
                        }
                    }
                }
                Ok(Event::Eof) | Err(_) => break,
                _ => {}
            }
            buf.clear();
        }
        out
    }

    fn in_cell_pictures(&self, sheet: SheetId) -> Vec<SheetPicture> {
        let cells = self.vm_cells(sheet);
        if cells.is_empty() {
            return Vec::new();
        }
        let Some(chain) = RichImages::read(self) else {
            return Vec::new();
        };
        cells
            .into_iter()
            .filter_map(|(row, col, vm)| {
                let media = chain.media_of_vm(vm)?;
                let a1 = sheet_core::format_a1(row, col, false, false);
                Some(SheetPicture {
                    id: format!("cell:{a1}"),
                    name: format!("Picture in {a1}"),
                    descr: None,
                    anchor: PictureAnchor::InCell { row, col },
                    content_type: self.content_type_of_part(&media),
                    media,
                    dml: None,
                })
            })
            .collect()
    }
}

/// The rich-data chain of a workbook, resolved to media part names.
struct RichImages {
    /// Per value-metadata block (0-based): the rich value index, when the
    /// block is an `XLRICHVALUE`.
    vm_to_rv: Vec<Option<usize>>,
    /// Per rich value: the media part of its local image, if it is one.
    rv_media: Vec<Option<String>>,
}

impl RichImages {
    fn read(doc: &XlsxDocument) -> Option<RichImages> {
        let meta = XNode::parse(&doc.part_bytes("xl/metadata.xml")?).ok()?;
        let types: Vec<String> = meta
            .child("metadataTypes")
            .map(|t| {
                t.children_named("metadataType")
                    .map(|m| m.attr("name").unwrap_or_default())
                    .collect()
            })
            .unwrap_or_default();
        let future: Vec<Option<usize>> = meta
            .children_named("futureMetadata")
            .find(|f| f.attr("name").as_deref() == Some("XLRICHVALUE"))
            .map(|f| {
                f.children_named("bk")
                    .map(|bk| {
                        let ext = bk.child("extLst")?.child("ext")?;
                        ext.child("rvb")?.attr("i")?.parse().ok()
                    })
                    .collect()
            })
            .unwrap_or_default();
        let vm_to_rv = meta
            .child("valueMetadata")
            .map(|v| {
                v.children_named("bk")
                    .map(|bk| {
                        let rc = bk.child("rc")?;
                        let t: usize = rc.attr("t")?.parse().ok()?;
                        let v: usize = rc.attr("v")?.parse().ok()?;
                        if types.get(t.checked_sub(1)?)?.as_str() != "XLRICHVALUE" {
                            return None;
                        }
                        *future.get(v)?
                    })
                    .collect()
            })
            .unwrap_or_default();

        let structures: Vec<Option<usize>> =
            XNode::parse(&doc.part_bytes("xl/richData/rdrichvaluestructure.xml")?)
                .ok()?
                .children_named("s")
                .map(|s| {
                    s.children_named("k")
                        .position(|k| k.attr("n").as_deref() == Some("_rvRel:LocalImageIdentifier"))
                })
                .collect();
        let rel_root = XNode::parse(&doc.part_bytes("xl/richData/richValueRel.xml")?).ok()?;
        let rel_ids: Vec<String> = rel_root
            .children_named("rel")
            .map(|r| r.attr("id").unwrap_or_default())
            .collect();
        let rels = doc.rels_of_part("xl/richData/richValueRel.xml")?;
        let rv_media = XNode::parse(&doc.part_bytes("xl/richData/rdrichvalue.xml")?)
            .ok()?
            .children_named("rv")
            .map(|rv| {
                let s: usize = rv.attr("s")?.parse().ok()?;
                let key = (*structures.get(s)?)?;
                let idx: usize = rv
                    .children_named("v")
                    .nth(key)?
                    .text
                    .as_deref()?
                    .trim()
                    .parse()
                    .ok()?;
                let rid = rel_ids.get(idx)?;
                let rel = rels.items.iter().find(|r| &r.id == rid)?;
                Some(resolve_target("xl/richData", &rel.target))
            })
            .collect();
        Some(RichImages { vm_to_rv, rv_media })
    }

    fn media_of_vm(&self, vm: usize) -> Option<String> {
        let rv = (*self.vm_to_rv.get(vm.checked_sub(1)?)?)?;
        self.rv_media.get(rv)?.clone()
    }
}
