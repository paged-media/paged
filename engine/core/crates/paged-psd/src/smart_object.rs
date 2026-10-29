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

//! SMART OBJECTS (image ADR 482): the blocks that make a layer a placed,
//! re-renderable document rather than pixels.
//!
//! - A layer's **placed-layer record** — `SoLd` (or `SoLE`, the same
//!   layout) with the legacy `PlLd` beside it — names the source by uuid
//!   (`Idnt`), carries the four corners the source's rectangle maps onto
//!   in the document (`Trnf`, and `nonAffineTransform` for a distort or
//!   perspective), the source size (`Sz  `), its warp and its smart
//!   filters (`filterFX`). [`PlacedLayer`] reads and edits it, and builds
//!   the record of a new embedded smart object as Photoshop writes one.
//! - The document's **linked-file blocks** — `lnk2` (and `lnkD`/`lnk3`)
//!   — hold the sources: `liFD` an embedded file's bytes, `liFE` a linked
//!   file's location, `liFA` an alias. [`LinkedFile`] reads them, keeps an
//!   unedited entry's bytes verbatim and writes a new embedded entry.
//! - The document's **filter-effects block** — `FEid` (or `FXid`) —
//!   holds, per smart object with filters (keyed by the record's
//!   `placed` id), the cached unfiltered render and the FILTER MASK.
//!   [`FilterEffects`] reads and writes it.
//!
//! # Provenance
//!
//! The Adobe Photoshop File Format specification (sections "Placed Layer",
//! "Linked Layer", "Filter Effects", "Filter Mask"), checked against and
//! completed from files Photoshop 27.10 wrote with known content
//! (`modules/image/scripts/photoshop/probes/smart-objects.jsx`): the
//! `liFD` version 8 tail (a child document id, an asset time, a lock flag
//! and a `contentID` descriptor), the `FEid` channels' 4-byte row counts,
//! and the filter mask after each entry's framed part are [OBS].

use crate::compression::packbits;
use crate::descriptor::build::{desc, key};
use crate::descriptor::{
    read_unicode_string, read_versioned_descriptor, write_unicode_string,
    write_versioned_descriptor, Descriptor, DescriptorValue, Key,
};
use crate::reader::ByteReader;
use crate::{PsdError, Result};

fn malformed(detail: impl Into<String>) -> PsdError {
    PsdError::Malformed {
        section: "smart object",
        detail: detail.into(),
    }
}

/// The record keys of a placed layer, newest first.
pub const PLACED_KEYS: [&[u8; 4]; 3] = [b"SoLd", b"SoLE", b"PlLd"];

/// The document keys that hold linked files.
pub const LINKED_KEYS: [&[u8; 4]; 4] = [b"lnk2", b"lnkD", b"lnk3", b"lnkE"];

/// The document keys of the filter-effects cache.
pub const FILTER_EFFECTS_KEYS: [&[u8; 4]; 2] = [b"FEid", b"FXid"];

// ───────────────────────────── placed layer ─────────────────────────────

/// A smart object's placed-layer record (`SoLd`/`SoLE`): the version word
/// and the descriptor, every item of which is kept, so an edit replaces
/// only what it changes.
#[derive(Debug, Clone, PartialEq)]
pub struct PlacedLayer {
    /// `SoLd` or `SoLE`.
    pub key: [u8; 4],
    /// The record version (4).
    pub version: u32,
    pub descriptor: Descriptor,
}

/// Four corners, `[x0, y0, x1, y1, x2, y2, x3, y3]`: top-left, top-right,
/// bottom-right, bottom-left of the source, in document pixels.
pub type Quad = [f64; 8];

fn doubles8(v: &DescriptorValue) -> Option<Quad> {
    let l = v.as_list()?;
    if l.len() != 8 {
        return None;
    }
    let mut q = [0.0; 8];
    for (o, x) in q.iter_mut().zip(l) {
        *o = x.as_number()?;
    }
    Some(q)
}

fn list8(q: Quad) -> DescriptorValue {
    DescriptorValue::List(q.iter().map(|&v| DescriptorValue::Double(v)).collect())
}

/// The axis-aligned bounds of a quad: `(left, top, right, bottom)`.
pub fn quad_bounds(q: &Quad) -> (f64, f64, f64, f64) {
    let xs = [q[0], q[2], q[4], q[6]];
    let ys = [q[1], q[3], q[5], q[7]];
    let min = |a: [f64; 4]| a.iter().copied().fold(f64::INFINITY, f64::min);
    let max = |a: [f64; 4]| a.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    (min(xs), min(ys), max(xs), max(ys))
}

fn set_item(d: &mut Descriptor, k: &[u8], v: DescriptorValue) {
    if let Some(slot) = d.items.iter_mut().find(|(key, _)| key.matches(k)) {
        slot.1 = v;
    } else {
        d.items.push((key(k), v));
    }
}

impl PlacedLayer {
    /// Read a `SoLd`/`SoLE` payload (after the block's length).
    pub fn parse(block_key: &[u8; 4], payload: &[u8]) -> Result<Self> {
        let mut r = ByteReader::new(payload);
        let tag = r.fourcc()?;
        if &tag != b"soLD" {
            return Err(malformed(format!(
                "a placed-layer record starts with {:?}, not soLD",
                String::from_utf8_lossy(&tag)
            )));
        }
        let version = r.u32()?;
        let (_, descriptor) = read_versioned_descriptor(&mut r)?;
        Ok(Self {
            key: *block_key,
            version,
            descriptor,
        })
    }

    /// The payload, as [`parse`](Self::parse) reads it.
    pub fn to_payload(&self) -> Vec<u8> {
        let mut out = b"soLD".to_vec();
        out.extend_from_slice(&self.version.to_be_bytes());
        write_versioned_descriptor(&mut out, &self.descriptor);
        out
    }

    /// The source's uuid (`Idnt`): the `lnk2` entry that holds it.
    pub fn uuid(&self) -> Option<&str> {
        self.descriptor.text(b"Idnt")
    }

    /// The placement's own id (`placed`): the `FEid` entry of its filters.
    pub fn placed_id(&self) -> Option<&str> {
        self.descriptor.text(b"placed")
    }

    /// The affine corners (`Trnf`).
    pub fn transform(&self) -> Option<Quad> {
        self.descriptor.get(b"Trnf").and_then(doubles8)
    }

    /// The corners as drawn: `nonAffineTransform` when present (a
    /// distort or perspective), else `Trnf`.
    pub fn quad(&self) -> Option<Quad> {
        self.descriptor
            .get(b"nonAffineTransform")
            .and_then(doubles8)
            .or_else(|| self.transform())
    }

    /// The source's size in its own pixels (`Sz  `).
    pub fn size(&self) -> Option<(f64, f64)> {
        let sz = self.descriptor.descriptor(b"Sz  ")?;
        Some((sz.number(b"Wdth")?, sz.number(b"Hght")?))
    }

    /// The source's resolution in ppi (`Rslt`).
    pub fn resolution(&self) -> Option<f64> {
        self.descriptor.unit_float(b"Rslt").map(|(_, v)| v)
    }

    /// The page of a multi-page source (`PgNm`, 1-based).
    pub fn page(&self) -> Option<i32> {
        self.descriptor.i32(b"PgNm")
    }

    /// Is the warp the identity (`warpNone` without a custom mesh)? A
    /// placement with any other warp is drawn by Photoshop through a
    /// Bézier mesh this module does not evaluate.
    pub fn warp_is_none(&self) -> bool {
        let Some(w) = self.descriptor.descriptor(b"warp") else {
            return true;
        };
        let none = w
            .enum_value(b"warpStyle")
            .is_none_or(|(_, v)| v.matches(b"warpNone"));
        none && !w.contains(b"customEnvelopeWarp")
    }

    /// Move the placement to `q`: `Trnf` and `nonAffineTransform` both
    /// take it, and the warp's bounds follow its bounding box.
    pub fn set_quad(&mut self, q: Quad) {
        set_item(&mut self.descriptor, b"Trnf", list8(q));
        set_item(&mut self.descriptor, b"nonAffineTransform", list8(q));
        let (l, t, r, b) = quad_bounds(&q);
        if let Some((_, DescriptorValue::Descriptor(w))) = self
            .descriptor
            .items
            .iter_mut()
            .find(|(k, _)| k.matches(b"warp"))
        {
            set_item(w, b"bounds", warp_bounds(t, l, b, r));
        }
    }

    /// Name another source (`Idnt`).
    pub fn set_uuid(&mut self, uuid: &str) {
        set_item(
            &mut self.descriptor,
            b"Idnt",
            DescriptorValue::Text(uuid.to_string()),
        );
    }

    /// The source's size (`Sz  `), after its contents changed.
    pub fn set_size(&mut self, width: f64, height: f64) {
        set_item(
            &mut self.descriptor,
            b"Sz  ",
            DescriptorValue::Descriptor(desc(
                b"Pnt ",
                vec![
                    (b"Wdth", DescriptorValue::Double(width)),
                    (b"Hght", DescriptorValue::Double(height)),
                ],
            )),
        );
    }

    /// The smart filters (`filterFX`), when the object has any.
    pub fn filter_fx(&self) -> Option<&Descriptor> {
        self.descriptor.descriptor(b"filterFX")
    }

    /// Replace (or with `None` remove) the smart filters. A new
    /// `filterFX` goes before `comp`, where Photoshop writes it.
    pub fn set_filter_fx(&mut self, fx: Option<Descriptor>) {
        let at = self
            .descriptor
            .items
            .iter()
            .position(|(k, _)| k.matches(b"filterFX"));
        match (at, fx) {
            (Some(i), Some(fx)) => self.descriptor.items[i].1 = DescriptorValue::Descriptor(fx),
            (Some(i), None) => {
                self.descriptor.items.remove(i);
            }
            (None, Some(fx)) => {
                let before = self
                    .descriptor
                    .items
                    .iter()
                    .position(|(k, _)| k.matches(b"comp"))
                    .unwrap_or(self.descriptor.items.len());
                self.descriptor
                    .items
                    .insert(before, (key(b"filterFX"), DescriptorValue::Descriptor(fx)));
            }
            (None, None) => {}
        }
    }

    /// The record of a NEW embedded raster smart object, as Photoshop 27
    /// writes one (`newPlacedLayer`): source `uuid`, placement id
    /// `placed`, a `width`×`height` source at `ppi`, drawn onto `q`.
    pub fn embedded(uuid: &str, placed: &str, width: f64, height: f64, ppi: f64, q: Quad) -> Self {
        use DescriptorValue as V;
        let frac = || {
            V::Descriptor(desc(
                b"null",
                vec![
                    (b"numerator", V::Integer(0)),
                    (b"denominator", V::Integer(600)),
                ],
            ))
        };
        let (l, t, r, b) = quad_bounds(&q);
        let d = desc(
            b"null",
            vec![
                (b"Idnt", V::Text(uuid.to_string())),
                (b"placed", V::Text(placed.to_string())),
                (b"PgNm", V::Integer(1)),
                (b"totalPages", V::Integer(1)),
                (b"Crop", V::Integer(1)),
                (b"frameStep", frac()),
                (b"duration", frac()),
                (b"frameCount", V::Integer(1)),
                (b"Annt", V::Integer(16)),
                (b"Type", V::Integer(2)),
                (b"Trnf", list8(q)),
                (b"nonAffineTransform", list8(q)),
                (b"warp", V::Descriptor(warp_none(t, l, b, r))),
                (
                    b"Sz  ",
                    V::Descriptor(desc(
                        b"Pnt ",
                        vec![(b"Wdth", V::Double(width)), (b"Hght", V::Double(height))],
                    )),
                ),
                (
                    b"Rslt",
                    V::UnitFloat {
                        unit: *b"#Rsl",
                        value: ppi,
                    },
                ),
                (b"comp", V::Integer(-1)),
                (
                    b"compInfo",
                    V::Descriptor(desc(
                        b"null",
                        vec![
                            (b"compID", V::Integer(-1)),
                            (b"originalCompID", V::Integer(-1)),
                        ],
                    )),
                ),
                (
                    b"ClMg",
                    V::Descriptor(desc(
                        b"ClMg",
                        vec![(
                            b"placedLayerOCIOConversion",
                            V::Enum {
                                type_key: key(b"placedLayerOCIOConversion"),
                                value: key(b"placedLayerOCIOConvertEmbedded"),
                            },
                        )],
                    )),
                ),
            ],
        );
        Self {
            key: *b"SoLd",
            version: 4,
            descriptor: d,
        }
    }

    /// The legacy `PlLd` payload Photoshop writes beside this record:
    /// `plcL`, version 3, the uuid, page, page count, anti-alias policy,
    /// layer type, the affine corners, then the warp (version 0, a
    /// version-16 descriptor).
    pub fn plld_payload(&self) -> Vec<u8> {
        let mut out = b"plcL".to_vec();
        out.extend_from_slice(&3u32.to_be_bytes());
        let uuid = self.uuid().unwrap_or("");
        let id = &uuid.as_bytes()[..uuid.len().min(255)];
        out.push(id.len() as u8);
        out.extend_from_slice(id);
        let page = self.page().unwrap_or(1).max(1) as u32;
        let pages = self.descriptor.i32(b"totalPages").unwrap_or(1).max(1) as u32;
        out.extend_from_slice(&page.to_be_bytes());
        out.extend_from_slice(&pages.to_be_bytes());
        out.extend_from_slice(&self.descriptor.i32(b"Annt").unwrap_or(16).to_be_bytes());
        out.extend_from_slice(&self.descriptor.i32(b"Type").unwrap_or(2).to_be_bytes());
        for v in self.transform().unwrap_or([0.0; 8]) {
            out.extend_from_slice(&v.to_bits().to_be_bytes());
        }
        out.extend_from_slice(&0u32.to_be_bytes());
        let warp = self
            .descriptor
            .descriptor(b"warp")
            .cloned()
            .unwrap_or_else(|| {
                let (l, t, r, b) = quad_bounds(&self.quad().unwrap_or([0.0; 8]));
                warp_none(t, l, b, r)
            });
        write_versioned_descriptor(&mut out, &warp);
        out
    }
}

fn warp_bounds(t: f64, l: f64, b: f64, r: f64) -> DescriptorValue {
    DescriptorValue::Descriptor(desc(
        b"classFloatRect",
        vec![
            (b"Top ", DescriptorValue::Double(t)),
            (b"Left", DescriptorValue::Double(l)),
            (b"Btom", DescriptorValue::Double(b)),
            (b"Rght", DescriptorValue::Double(r)),
        ],
    ))
}

/// The identity warp over a bounding box, as Photoshop writes it.
fn warp_none(t: f64, l: f64, b: f64, r: f64) -> Descriptor {
    use DescriptorValue as V;
    desc(
        b"warp",
        vec![
            (
                b"warpStyle",
                V::Enum {
                    type_key: key(b"warpStyle"),
                    value: key(b"warpNone"),
                },
            ),
            (b"warpValue", V::Double(0.0)),
            (b"warpPerspective", V::Double(0.0)),
            (b"warpPerspectiveOther", V::Double(0.0)),
            (
                b"warpRotate",
                V::Enum {
                    type_key: key(b"Ornt"),
                    value: key(b"Hrzn"),
                },
            ),
            (b"bounds", warp_bounds(t, l, b, r)),
            (b"uOrder", V::Integer(4)),
            (b"vOrder", V::Integer(4)),
        ],
    )
}

// ───────────────────────────── smart filters ────────────────────────────

/// One smart filter of a `filterFX` list.
#[derive(Debug, Clone, PartialEq)]
pub struct SmartFilter {
    /// The name the Layers panel shows (`Nm  `, localised by the writer).
    pub name: String,
    /// The filter's own descriptor (`Fltr`): its class is the filter
    /// (`GsnB` Gaussian Blur, `MtnB` Motion Blur, …), its items the
    /// dialog's values.
    pub filter: Descriptor,
    /// `filterID`: the filter's event id.
    pub filter_id: i32,
    pub enabled: bool,
    /// Blending options: opacity in percent and the mode's key.
    pub opacity: f64,
    pub mode: Key,
    /// The filter has a dialog (`hasoptions`).
    pub has_options: bool,
    /// The foreground and background colours the filter was run with.
    pub fg: [f64; 3],
    pub bg: [f64; 3],
}

/// The `filterFX` block: the list, bottom (first applied) first, and the
/// filter mask's switches.
#[derive(Debug, Clone, PartialEq)]
pub struct SmartFilters {
    /// The whole list is on (the eye beside "Smart Filters").
    pub enabled: bool,
    pub valid_at_position: bool,
    pub mask_enabled: bool,
    pub mask_linked: bool,
    pub mask_extend_with_white: bool,
    pub list: Vec<SmartFilter>,
}

fn rgb_of(d: Option<&Descriptor>) -> Option<[f64; 3]> {
    let d = d?;
    Some([d.number(b"Rd  ")?, d.number(b"Grn ")?, d.number(b"Bl  ")?])
}

fn rgb_desc(c: [f64; 3]) -> DescriptorValue {
    DescriptorValue::Descriptor(desc(
        b"RGBC",
        vec![
            (b"Rd  ", DescriptorValue::Double(c[0])),
            (b"Grn ", DescriptorValue::Double(c[1])),
            (b"Bl  ", DescriptorValue::Double(c[2])),
        ],
    ))
}

impl SmartFilters {
    /// Read a `filterFX` descriptor. An item that is not a filter is an
    /// error: the list is what draws.
    pub fn from_descriptor(d: &Descriptor) -> Result<Self> {
        let mut list = Vec::new();
        for v in d.list(b"filterFXList").unwrap_or(&[]) {
            let f = v
                .as_descriptor()
                .ok_or_else(|| malformed("a filterFXList item is not a descriptor"))?;
            let filter = f
                .descriptor(b"Fltr")
                .cloned()
                .ok_or_else(|| malformed("a smart filter without its Fltr descriptor"))?;
            let blend = f.descriptor(b"blendOptions");
            list.push(SmartFilter {
                name: f.text(b"Nm  ").unwrap_or("").to_string(),
                filter,
                filter_id: f.i32(b"filterID").unwrap_or(0),
                enabled: f.bool(b"enab").unwrap_or(true),
                opacity: blend
                    .and_then(|b| b.unit_float(b"Opct"))
                    .map_or(100.0, |(_, v)| v),
                mode: blend
                    .and_then(|b| b.enum_value(b"Md  "))
                    .map_or_else(|| key(b"normal"), |(_, v)| v.clone()),
                has_options: f.bool(b"hasoptions").unwrap_or(true),
                fg: rgb_of(f.descriptor(b"FrgC")).unwrap_or([0.0; 3]),
                bg: rgb_of(f.descriptor(b"BckC")).unwrap_or([255.0; 3]),
            });
        }
        Ok(Self {
            enabled: d.bool(b"enab").unwrap_or(true),
            valid_at_position: d.bool(b"validAtPosition").unwrap_or(true),
            mask_enabled: d.bool(b"filterMaskEnable").unwrap_or(true),
            mask_linked: d.bool(b"filterMaskLinked").unwrap_or(false),
            mask_extend_with_white: d.bool(b"filterMaskExtendWithWhite").unwrap_or(true),
            list,
        })
    }

    /// The descriptor, in the order Photoshop writes it.
    pub fn to_descriptor(&self) -> Descriptor {
        use DescriptorValue as V;
        let list = self
            .list
            .iter()
            .map(|f| {
                V::Descriptor(desc(
                    b"filterFX",
                    vec![
                        (b"Nm  ", V::Text(f.name.clone())),
                        (
                            b"blendOptions",
                            V::Descriptor(desc(
                                b"blendOptions",
                                vec![
                                    (
                                        b"Opct",
                                        V::UnitFloat {
                                            unit: *b"#Prc",
                                            value: f.opacity,
                                        },
                                    ),
                                    (
                                        b"Md  ",
                                        V::Enum {
                                            type_key: key(b"BlnM"),
                                            value: f.mode.clone(),
                                        },
                                    ),
                                ],
                            )),
                        ),
                        (b"enab", V::Bool(f.enabled)),
                        (b"hasoptions", V::Bool(f.has_options)),
                        (b"FrgC", rgb_desc(f.fg)),
                        (b"BckC", rgb_desc(f.bg)),
                        (b"Fltr", V::Descriptor(f.filter.clone())),
                        (b"filterID", V::Integer(f.filter_id)),
                    ],
                ))
            })
            .collect();
        desc(
            b"filterFXStyle",
            vec![
                (b"enab", V::Bool(self.enabled)),
                (b"validAtPosition", V::Bool(self.valid_at_position)),
                (b"filterMaskEnable", V::Bool(self.mask_enabled)),
                (b"filterMaskLinked", V::Bool(self.mask_linked)),
                (
                    b"filterMaskExtendWithWhite",
                    V::Bool(self.mask_extend_with_white),
                ),
                (b"filterFXList", V::List(list)),
            ],
        )
    }
}

// ───────────────────────────── linked files ─────────────────────────────

/// What a linked-file entry holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkKind {
    /// `liFD`: the file's bytes, embedded.
    Data,
    /// `liFE`: the file's location outside the document.
    External,
    /// `liFA`: a Mac alias.
    Alias,
}

impl LinkKind {
    fn tag(self) -> [u8; 4] {
        match self {
            Self::Data => *b"liFD",
            Self::External => *b"liFE",
            Self::Alias => *b"liFA",
        }
    }
}

/// One source of a `lnk2`/`lnkD`/`lnk3`/`lnkE` block.
#[derive(Debug, Clone, PartialEq)]
pub struct LinkedFile {
    pub kind: LinkKind,
    /// The entry's version (1–8).
    pub version: u32,
    /// The uuid a placed-layer record names (`Idnt`).
    pub uuid: String,
    /// The original file name.
    pub name: String,
    /// The file type (`8BPB` a PSB, `8BPS` a PSD, `png `, …) and creator.
    pub file_type: [u8; 4],
    pub creator: [u8; 4],
    /// The embedded bytes (`liFD`; empty for a link without a copy).
    pub data: Vec<u8>,
    /// The file-open descriptor (the page or layer comp to open).
    pub open_descriptor: Option<Descriptor>,
    /// `liFE`: the link's descriptor (its path, `fullPath` / `relPath`),
    /// when the entry carries one.
    pub link_descriptor: Option<Descriptor>,
    /// The entry exactly as read, length word included: an UNEDITED
    /// entry is written back from it byte for byte.
    pub raw: Option<Vec<u8>>,
}

impl LinkedFile {
    /// A path the link names (`liFE`): `fullPath`, else `relPath`, else
    /// the original file name.
    pub fn link_path(&self) -> &str {
        let d = self.link_descriptor.as_ref();
        d.and_then(|d| d.text(b"fullPath"))
            .or_else(|| d.and_then(|d| d.text(b"relPath")))
            .unwrap_or(&self.name)
    }

    /// A new embedded entry (`liFD`, version 7) for `bytes`.
    pub fn embedded(uuid: &str, name: &str, file_type: [u8; 4], bytes: Vec<u8>) -> Self {
        Self {
            kind: LinkKind::Data,
            version: 7,
            uuid: uuid.to_string(),
            name: name.to_string(),
            file_type,
            creator: *b"8BIM",
            data: bytes,
            open_descriptor: Some(desc(
                b"null",
                vec![(
                    b"compInfo",
                    DescriptorValue::Descriptor(desc(
                        b"null",
                        vec![
                            (b"compID", DescriptorValue::Integer(-1)),
                            (b"originalCompID", DescriptorValue::Integer(-1)),
                        ],
                    )),
                )],
            )),
            link_descriptor: None,
            raw: None,
        }
    }

    /// The entry's bytes, length word first: the bytes it was read from
    /// when unedited, else built (an embedded or external entry at its
    /// version, with an empty child-document id, no asset time, unlocked).
    pub fn to_bytes(&self) -> Vec<u8> {
        if let Some(raw) = &self.raw {
            return raw.clone();
        }
        let mut b = Vec::new();
        b.extend_from_slice(&self.kind.tag());
        b.extend_from_slice(&self.version.to_be_bytes());
        let id = &self.uuid.as_bytes()[..self.uuid.len().min(255)];
        b.push(id.len() as u8);
        b.extend_from_slice(id);
        write_unicode_string(&mut b, &self.name);
        b.extend_from_slice(&self.file_type);
        b.extend_from_slice(&self.creator);
        let data_len = if self.kind == LinkKind::Data {
            self.data.len() as u64
        } else {
            0
        };
        b.extend_from_slice(&data_len.to_be_bytes());
        match &self.open_descriptor {
            Some(d) => {
                b.push(1);
                write_versioned_descriptor(&mut b, d);
            }
            None => b.push(0),
        }
        if self.kind == LinkKind::External {
            let d = self
                .link_descriptor
                .clone()
                .unwrap_or_else(|| desc(b"ExternalFileLink", vec![]));
            write_versioned_descriptor(&mut b, &d);
            if self.version > 3 {
                // Year, month, day, hour, minute, seconds: unknown.
                b.extend_from_slice(&[0, 0, 0, 0, 0, 0, 0, 0]);
                b.extend_from_slice(&0f64.to_bits().to_be_bytes());
            }
            // The file size, then (no copy) nothing.
            b.extend_from_slice(&0u64.to_be_bytes());
        }
        if self.kind == LinkKind::Data {
            b.extend_from_slice(&self.data);
        }
        if self.version >= 5 {
            write_unicode_string(&mut b, "");
        }
        if self.version >= 6 {
            b.extend_from_slice(&0f64.to_bits().to_be_bytes());
        }
        if self.version >= 7 {
            b.push(0);
        }
        let mut out = (b.len() as u64).to_be_bytes().to_vec();
        out.extend_from_slice(&b);
        out
    }
}

/// Read the entries of a linked-file block's payload. Each entry is
/// framed by an 8-byte length and padded to 4 bytes.
pub fn parse_linked_files(payload: &[u8]) -> Result<Vec<LinkedFile>> {
    let mut out = Vec::new();
    let mut at = 0usize;
    while payload.len().saturating_sub(at) >= 8 {
        let len = u64::from_be_bytes(payload[at..at + 8].try_into().expect("8 bytes")) as usize;
        if len == 0 {
            break;
        }
        let end = at
            .checked_add(8)
            .and_then(|s| s.checked_add(len))
            .filter(|&e| e <= payload.len())
            .ok_or_else(|| malformed(format!("a linked file of {len} bytes overruns its block")))?;
        let body = &payload[at + 8..end];
        let mut f = parse_entry(body)?;
        f.raw = Some(payload[at..end].to_vec());
        out.push(f);
        at = end.div_ceil(4) * 4;
    }
    Ok(out)
}

fn parse_entry(body: &[u8]) -> Result<LinkedFile> {
    let mut r = ByteReader::new(body);
    let tag = r.fourcc()?;
    let kind = match &tag {
        b"liFD" => LinkKind::Data,
        b"liFE" => LinkKind::External,
        b"liFA" => LinkKind::Alias,
        other => {
            return Err(malformed(format!(
                "linked file of type {:?}",
                String::from_utf8_lossy(other)
            )))
        }
    };
    let version = r.u32()?;
    let n = r.u8()? as usize;
    let uuid = String::from_utf8_lossy(r.take(n)?).into_owned();
    let name = read_unicode_string(&mut r)?;
    let file_type = r.fourcc()?;
    let creator = r.fourcc()?;
    let data_len = r.u64()? as usize;
    let open_descriptor = if r.u8()? != 0 {
        Some(read_versioned_descriptor(&mut r)?.1)
    } else {
        None
    };
    let mut link_descriptor = None;
    let mut data = Vec::new();
    match kind {
        LinkKind::Data => data = r.take(data_len)?.to_vec(),
        LinkKind::External => {
            link_descriptor = Some(read_versioned_descriptor(&mut r)?.1);
            // The rest (the file's date and size, a copy at version 2)
            // is kept in `raw`, not modelled.
        }
        LinkKind::Alias => {}
    }
    Ok(LinkedFile {
        kind,
        version,
        uuid,
        name,
        file_type,
        creator,
        data,
        open_descriptor,
        link_descriptor,
        raw: None,
    })
}

/// A linked-file block's payload from its entries, each padded to 4.
pub fn write_linked_files(files: &[LinkedFile]) -> Vec<u8> {
    let mut out = Vec::new();
    for f in files {
        out.extend_from_slice(&f.to_bytes());
        while !out.len().is_multiple_of(4) {
            out.push(0);
        }
    }
    out
}

/// The file type a source's bytes announce (a PSB, a PSD, a PNG, a JPEG,
/// a TIFF), for a new `liFD` entry.
pub fn file_type_of(bytes: &[u8]) -> [u8; 4] {
    match bytes {
        [b'8', b'B', b'P', b'S', 0, 2, ..] => *b"8BPB",
        [b'8', b'B', b'P', b'S', ..] => *b"8BPS",
        [0x89, b'P', b'N', b'G', ..] => *b"png ",
        [0xFF, 0xD8, ..] => *b"JPEG",
        [b'I', b'I', ..] | [b'M', b'M', ..] => *b"TIFF",
        _ => *b"    ",
    }
}

// ─────────────────────────── filter effects ─────────────────────────────

/// One channel of a filter-effects entry: its compression and the
/// payload after it.
#[derive(Debug, Clone, PartialEq)]
pub struct FxChannel {
    pub compression: u16,
    pub data: Vec<u8>,
}

/// A rectangle `top, left, bottom, right`.
pub type FxRect = [i32; 4];

/// The filter mask of a filter-effects entry.
#[derive(Debug, Clone, PartialEq)]
pub struct FxMask {
    pub rect: FxRect,
    pub channel: FxChannel,
}

/// A smart object's entry in the filter-effects cache, keyed by its
/// placed-layer record's `placed` id.
#[derive(Debug, Clone, PartialEq)]
pub struct FilterEffectsEntry {
    pub id: String,
    pub version: u32,
    pub rect: FxRect,
    pub depth: u32,
    pub max_channels: u32,
    /// `max_channels + 2` slots; `None` where nothing is written. Slots
    /// 0–2 hold the unfiltered render's colour, the last its transparency.
    pub channels: Vec<Option<FxChannel>>,
    pub mask: Option<FxMask>,
}

/// The filter-effects block (`FEid`/`FXid`).
#[derive(Debug, Clone, PartialEq)]
pub struct FilterEffects {
    pub version: u32,
    pub entries: Vec<FilterEffectsEntry>,
}

fn read_rect(r: &mut ByteReader) -> Result<FxRect> {
    Ok([r.i32()?, r.i32()?, r.i32()?, r.i32()?])
}

fn read_fx_channel(r: &mut ByteReader) -> Result<FxChannel> {
    let len = r.u64()? as usize;
    if len < 2 {
        return Err(malformed(
            "a filter-effects channel shorter than its compression",
        ));
    }
    let compression = r.u16()?;
    Ok(FxChannel {
        compression,
        data: r.take(len - 2)?.to_vec(),
    })
}

fn write_fx_channel(out: &mut Vec<u8>, c: &FxChannel) {
    out.extend_from_slice(&(c.data.len() as u64 + 2).to_be_bytes());
    out.extend_from_slice(&c.compression.to_be_bytes());
    out.extend_from_slice(&c.data);
}

impl FilterEffects {
    pub fn parse(payload: &[u8]) -> Result<Self> {
        let mut r = ByteReader::new(payload);
        let version = r.u32()?;
        let total = r.u64()? as usize;
        let mut body = r.sub(total.min(r.remaining()))?;
        let mut entries = Vec::new();
        while body.remaining() > 0 {
            let n = body.u8()? as usize;
            if n == 0 && body.rest().iter().all(|&b| b == 0) {
                break;
            }
            let id = String::from_utf8_lossy(body.take(n)?).into_owned();
            let ev = body.u32()?;
            let len = body.u64()? as usize;
            let mut e = body.sub(len)?;
            let rect = read_rect(&mut e)?;
            let depth = e.u32()?;
            let max_channels = e.u32()?;
            let mut channels = Vec::new();
            for _ in 0..max_channels as usize + 2 {
                if e.remaining() == 0 {
                    break;
                }
                channels.push(if e.u32()? != 0 {
                    Some(read_fx_channel(&mut e)?)
                } else {
                    None
                });
            }
            let mask = if body.remaining() > 0 && body.u8()? != 0 {
                let rect = read_rect(&mut body)?;
                Some(FxMask {
                    rect,
                    channel: read_fx_channel(&mut body)?,
                })
            } else {
                None
            };
            entries.push(FilterEffectsEntry {
                id,
                version: ev,
                rect,
                depth,
                max_channels,
                channels,
                mask,
            });
        }
        Ok(Self { version, entries })
    }

    pub fn to_payload(&self) -> Vec<u8> {
        let mut body = Vec::new();
        for e in &self.entries {
            let id = &e.id.as_bytes()[..e.id.len().min(255)];
            body.push(id.len() as u8);
            body.extend_from_slice(id);
            body.extend_from_slice(&e.version.to_be_bytes());
            let mut inner = Vec::new();
            for v in e.rect {
                inner.extend_from_slice(&v.to_be_bytes());
            }
            inner.extend_from_slice(&e.depth.to_be_bytes());
            inner.extend_from_slice(&e.max_channels.to_be_bytes());
            for c in &e.channels {
                match c {
                    Some(c) => {
                        inner.extend_from_slice(&1u32.to_be_bytes());
                        write_fx_channel(&mut inner, c);
                    }
                    None => inner.extend_from_slice(&0u32.to_be_bytes()),
                }
            }
            body.extend_from_slice(&(inner.len() as u64).to_be_bytes());
            body.extend_from_slice(&inner);
            match &e.mask {
                Some(m) => {
                    body.push(1);
                    for v in m.rect {
                        body.extend_from_slice(&v.to_be_bytes());
                    }
                    write_fx_channel(&mut body, &m.channel);
                }
                None => body.push(0),
            }
        }
        let mut out = self.version.to_be_bytes().to_vec();
        out.extend_from_slice(&(body.len() as u64).to_be_bytes());
        out.extend_from_slice(&body);
        out
    }

    /// The entry of the placement `placed`.
    pub fn entry(&self, placed: &str) -> Option<&FilterEffectsEntry> {
        self.entries.iter().find(|e| e.id == placed)
    }
}

fn rect_size(rect: &FxRect) -> (usize, usize) {
    (
        (rect[3] - rect[1]).max(0) as usize,
        (rect[2] - rect[0]).max(0) as usize,
    )
}

/// Decode one 8-bit filter-effects channel over `rect`: raw, or PackBits
/// with 4-byte row counts [OBS].
pub fn decode_fx_channel(c: &FxChannel, rect: &FxRect) -> Result<Vec<u8>> {
    let (w, h) = rect_size(rect);
    match c.compression {
        0 => {
            if c.data.len() < w * h {
                return Err(malformed("a raw filter-effects channel is short"));
            }
            Ok(c.data[..w * h].to_vec())
        }
        1 => {
            let mut r = ByteReader::new(&c.data);
            let mut counts = Vec::with_capacity(h);
            for _ in 0..h {
                counts.push(r.u32()? as usize);
            }
            let mut out = vec![0u8; w * h];
            for (y, n) in counts.into_iter().enumerate() {
                packbits::decode(r.take(n)?, &mut out[y * w..(y + 1) * w])?;
            }
            Ok(out)
        }
        other => Err(PsdError::Unsupported(format!(
            "filter-effects channel compression {other}"
        ))),
    }
}

/// Encode an 8-bit plane over a `w`-wide rectangle the way Photoshop
/// writes the filter-effects channels: PackBits, 4-byte row counts.
pub fn encode_fx_channel(plane: &[u8], w: usize) -> FxChannel {
    let w = w.max(1);
    let rows: Vec<Vec<u8>> = plane.chunks(w).map(packbits::encode).collect();
    let mut data = Vec::new();
    for r in &rows {
        data.extend_from_slice(&(r.len() as u32).to_be_bytes());
    }
    for r in &rows {
        data.extend_from_slice(r);
    }
    FxChannel {
        compression: 1,
        data,
    }
}

impl FilterEffectsEntry {
    /// The filter mask as a coverage plane over `rect` (255 = the filters
    /// show), or `None` without one.
    pub fn mask_plane(&self) -> Result<Option<(FxRect, Vec<u8>)>> {
        match &self.mask {
            Some(m) => Ok(Some((m.rect, decode_fx_channel(&m.channel, &m.rect)?))),
            None => Ok(None),
        }
    }

    /// A NEW entry: the unfiltered render (straight RGBA8 over `rect`)
    /// in slots 0–2 and the last, and a filter mask over the same
    /// rectangle (`None`: all white, which Photoshop always writes).
    pub fn build(placed: &str, rect: FxRect, rgba: &[u8], mask: Option<&[u8]>) -> Self {
        const MAX_CHANNELS: u32 = 24;
        let (w, h) = rect_size(&rect);
        let plane = |c: usize| -> Vec<u8> {
            rgba.as_chunks::<4>()
                .0
                .iter()
                .take(w * h)
                .map(|p| {
                    // Photoshop keeps colour under transparency white.
                    if c < 3 && p[3] == 0 {
                        255
                    } else {
                        p[c]
                    }
                })
                .collect()
        };
        let mut channels: Vec<Option<FxChannel>> = vec![None; MAX_CHANNELS as usize + 2];
        for (slot, c) in [
            (0usize, 0usize),
            (1, 1),
            (2, 2),
            (MAX_CHANNELS as usize + 1, 3),
        ] {
            channels[slot] = Some(encode_fx_channel(&plane(c), w));
        }
        let white = vec![255u8; w * h];
        let mask_plane = mask.unwrap_or(&white);
        Self {
            id: placed.to_string(),
            version: 1,
            rect,
            depth: 8,
            max_channels: MAX_CHANNELS,
            channels,
            mask: Some(FxMask {
                rect,
                channel: encode_fx_channel(mask_plane, w),
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::descriptor::read_versioned_descriptor as rvd;

    fn quad() -> Quad {
        [10.0, 20.0, 74.0, 20.0, 74.0, 84.0, 10.0, 84.0]
    }

    #[test]
    fn a_built_record_reads_back_its_placement() {
        let p = PlacedLayer::embedded("u-1", "p-1", 64.0, 64.0, 72.0, quad());
        let back = PlacedLayer::parse(b"SoLd", &p.to_payload()).expect("parse");
        assert_eq!(back, p);
        assert_eq!(back.uuid(), Some("u-1"));
        assert_eq!(back.placed_id(), Some("p-1"));
        assert_eq!(back.quad(), Some(quad()));
        assert_eq!(back.size(), Some((64.0, 64.0)));
        assert!(back.warp_is_none());
    }

    #[test]
    fn set_quad_moves_both_transforms_and_the_warp_bounds() {
        let mut p = PlacedLayer::embedded("u", "p", 8.0, 8.0, 72.0, quad());
        let q = [0.0, 0.0, 16.0, 4.0, 12.0, 20.0, -4.0, 16.0];
        p.set_quad(q);
        assert_eq!(p.transform(), Some(q));
        assert_eq!(p.quad(), Some(q));
        let b = p
            .descriptor
            .descriptor(b"warp")
            .and_then(|w| w.descriptor(b"bounds"))
            .expect("bounds");
        assert_eq!(b.number(b"Left"), Some(-4.0));
        assert_eq!(b.number(b"Btom"), Some(20.0));
    }

    #[test]
    fn the_legacy_record_carries_the_uuid_corners_and_warp() {
        let p = PlacedLayer::embedded("abc", "p", 8.0, 8.0, 72.0, quad());
        let b = p.plld_payload();
        assert_eq!(&b[..4], b"plcL");
        assert_eq!(&b[8..12], &[3, b'a', b'b', b'c']);
        let mut r = ByteReader::new(&b[12 + 16..]);
        for want in quad() {
            assert_eq!(f64::from_bits(r.u64().unwrap()), want);
        }
        assert_eq!(r.u32().unwrap(), 0);
        let (v, w) = rvd(&mut r).expect("warp");
        assert_eq!((v, w.class_id.as_bytes()), (16, &b"warp"[..]));
    }

    #[test]
    fn smart_filters_round_trip_through_their_descriptor() {
        let f = SmartFilters {
            enabled: true,
            valid_at_position: true,
            mask_enabled: true,
            mask_linked: false,
            mask_extend_with_white: true,
            list: vec![SmartFilter {
                name: "Gaussian Blur...".into(),
                filter: desc(
                    b"GsnB",
                    vec![(
                        b"Rds ",
                        DescriptorValue::UnitFloat {
                            unit: *b"#Pxl",
                            value: 3.0,
                        },
                    )],
                ),
                filter_id: 1_198_747_202,
                enabled: false,
                opacity: 50.0,
                mode: key(b"normal"),
                has_options: true,
                fg: [0.0; 3],
                bg: [255.0; 3],
            }],
        };
        let back = SmartFilters::from_descriptor(&f.to_descriptor()).expect("read");
        assert_eq!(back, f);
        let mut p = PlacedLayer::embedded("u", "p", 8.0, 8.0, 72.0, quad());
        p.set_filter_fx(Some(f.to_descriptor()));
        let keys: Vec<_> = p
            .descriptor
            .items
            .iter()
            .map(|(k, _)| k.text_lossy())
            .collect();
        let fx = keys.iter().position(|k| k == "filterFX").expect("fx");
        assert_eq!(keys[fx + 1], "comp", "filterFX goes before comp");
        p.set_filter_fx(None);
        assert!(p.filter_fx().is_none());
    }

    #[test]
    fn a_built_embedded_entry_reads_back() {
        let f = LinkedFile::embedded("uuid-x", "art.psb", *b"8BPB", vec![1, 2, 3, 4, 5]);
        let block = write_linked_files(&[f.clone(), f.clone()]);
        assert!(block.len().is_multiple_of(4));
        let back = parse_linked_files(&block).expect("parse");
        assert_eq!(back.len(), 2);
        assert_eq!(back[0].uuid, "uuid-x");
        assert_eq!(back[0].name, "art.psb");
        assert_eq!(back[0].data, vec![1, 2, 3, 4, 5]);
        assert_eq!(back[0].kind, LinkKind::Data);
        // An unedited entry writes back its own bytes.
        assert_eq!(write_linked_files(&back), block);
    }

    #[test]
    fn a_filter_effects_entry_round_trips_with_its_mask() {
        let rgba: Vec<u8> = (0..4 * 3 * 2).map(|i| i as u8 * 7).collect();
        let mask = [0u8, 0, 255, 255, 128, 64];
        let e = FilterEffectsEntry::build("pl", [1, 2, 3, 5], &rgba, Some(&mask));
        let fx = FilterEffects {
            version: 3,
            entries: vec![e],
        };
        let back = FilterEffects::parse(&fx.to_payload()).expect("parse");
        assert_eq!(back, fx);
        let (rect, plane) = back.entry("pl").unwrap().mask_plane().unwrap().unwrap();
        assert_eq!(rect, [1, 2, 3, 5]);
        assert_eq!(plane, mask);
    }

    #[test]
    fn file_types_are_sniffed() {
        assert_eq!(file_type_of(b"8BPS\0\x02xx"), *b"8BPB");
        assert_eq!(file_type_of(b"8BPS\0\x01xx"), *b"8BPS");
        assert_eq!(file_type_of(&[0x89, b'P', b'N', b'G']), *b"png ");
    }
}
