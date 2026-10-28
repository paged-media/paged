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

//! Image resources section: `8BIM` blocks keyed by u16 id. Typed
//! bodies for the ids the engine consumes (ICC 1039, resolution 1005,
//! grid and guides 1032);
//! everything else opaque-verbatim. Every block additionally keeps its
//! complete source bytes (`raw_block`, signature through padding) for
//! the lazy-verbatim guard.
//!
//! Provenance: Adobe Photoshop File Format specification, "Image
//! Resources Section" + "Image Resource IDs".

/// Resource ids the model types (everything else is `Opaque`).
pub const RES_RESOLUTION_INFO: u16 = 1005;
pub const RES_ICC_PROFILE: u16 = 1039;
pub const RES_GRID_AND_GUIDES: u16 = 1032;

/// Photoshop's default grid cycle in the 1032 record (both axes), as it
/// writes it for a document whose grid was never changed.
pub const DEFAULT_GRID_CYCLE: u32 = 576;

/// A Pascal string as stored: length byte + bytes, NO padding (padding
/// is contextual and applied by the emitters). Kept raw because PSD
/// names are MacRoman-ish legacy bytes, not guaranteed UTF-8.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PascalString {
    pub raw: Vec<u8>,
}

impl PascalString {
    /// Build from ASCII-safe text (lossy for anything else — the
    /// canonical name lives in `luni` anyway).
    pub fn new(s: &str) -> Self {
        let bytes: Vec<u8> = s.bytes().take(255).collect();
        let mut raw = Vec::with_capacity(bytes.len() + 1);
        raw.push(bytes.len() as u8);
        raw.extend_from_slice(&bytes);
        PascalString { raw }
    }

    pub fn text_lossy(&self) -> String {
        if self.raw.is_empty() {
            return String::new();
        }
        let n = self.raw[0] as usize;
        String::from_utf8_lossy(&self.raw[1..1 + n.min(self.raw.len() - 1)]).into_owned()
    }
}

/// Fixed-point resolution record (id 1005). Stored fields are the raw
/// 32-bit fixed-point values + display units — typed but lossless.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ResolutionInfo {
    /// Horizontal resolution, 16.16 fixed point, pixels per inch.
    pub h_res_fixed: u32,
    /// 1 = ppi, 2 = ppcm.
    pub h_res_unit: u16,
    /// 1 = inches, 2 = cm, 3 = points, 4 = picas, 5 = columns.
    pub width_unit: u16,
    pub v_res_fixed: u32,
    pub v_res_unit: u16,
    pub height_unit: u16,
}

impl ResolutionInfo {
    pub fn h_ppi(&self) -> f64 {
        self.h_res_fixed as f64 / 65536.0
    }

    pub fn v_ppi(&self) -> f64 {
        self.v_res_fixed as f64 / 65536.0
    }
}

/// One ruler guide of the grid-and-guides record (id 1032).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PsdGuide {
    /// Position in document coordinates, fixed point with 5 fractional
    /// bits: 1/32 of a pixel (a guide at x = 100 px is stored as 3200).
    pub location: i32,
    /// `true` for a horizontal guide (it marks a y position), `false`
    /// for a vertical one (an x position). Stored as 1 / 0.
    pub horizontal: bool,
}

impl PsdGuide {
    /// The position in pixels.
    pub fn pixels(&self) -> f64 {
        f64::from(self.location) / 32.0
    }

    /// A guide at `px` pixels, rounded to the record's 1/32 px.
    pub fn at_pixels(px: f64, horizontal: bool) -> PsdGuide {
        PsdGuide {
            location: (px * 32.0)
                .round()
                .clamp(f64::from(i32::MIN), f64::from(i32::MAX)) as i32,
            horizontal,
        }
    }
}

/// The grid-and-guides record (id 1032): u32 version (1), u32
/// horizontal and u32 vertical grid cycle, u32 guide count, and per
/// guide an i32 location (1/32 px) and a u8 direction (0 vertical,
/// 1 horizontal). Typed but lossless: every field round-trips.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GridAndGuides {
    pub version: u32,
    pub grid_cycle_h: u32,
    pub grid_cycle_v: u32,
    pub guides: Vec<PsdGuide>,
}

impl Default for GridAndGuides {
    fn default() -> Self {
        GridAndGuides {
            version: 1,
            grid_cycle_h: DEFAULT_GRID_CYCLE,
            grid_cycle_v: DEFAULT_GRID_CYCLE,
            guides: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum ResourceBody {
    IccProfile(Vec<u8>),
    ResolutionInfo(ResolutionInfo),
    GridAndGuides(GridAndGuides),
    Opaque,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ImageResourceBlock {
    pub id: u16,
    pub name: PascalString,
    /// Parsed view (`Opaque` for unmodeled ids; the bytes live in
    /// `raw_block`).
    pub body: ResourceBody,
    /// The complete block as read — signature, id, name (padded), size,
    /// data, padding. Verbatim re-emit unit (strategy 3); `None` only
    /// for constructed blocks, which re-encode canonically.
    pub raw_block: super::Raw,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct ImageResources {
    pub blocks: Vec<ImageResourceBlock>,
}

impl ImageResources {
    pub fn icc_profile(&self) -> Option<&[u8]> {
        self.blocks.iter().find_map(|b| match &b.body {
            ResourceBody::IccProfile(p) => Some(p.as_slice()),
            _ => None,
        })
    }

    pub fn resolution(&self) -> Option<&ResolutionInfo> {
        self.blocks.iter().find_map(|b| match &b.body {
            ResourceBody::ResolutionInfo(r) => Some(r),
            _ => None,
        })
    }

    /// The grid-and-guides record (id 1032), when the file has a
    /// well-formed one.
    pub fn grid_and_guides(&self) -> Option<&GridAndGuides> {
        self.blocks.iter().find_map(|b| match &b.body {
            ResourceBody::GridAndGuides(g) => Some(g),
            _ => None,
        })
    }

    /// The ruler guides (id 1032), in record order; empty without one.
    pub fn guides(&self) -> &[PsdGuide] {
        self.grid_and_guides().map_or(&[], |g| g.guides.as_slice())
    }

    /// Replace the ruler guides. The preservation rule holds: when
    /// `guides` equals what the file already says (including "none" on a
    /// file without the record) nothing changes, so an untouched file
    /// still writes byte for byte. Otherwise the record is re-encoded
    /// canonically, keeping its grid cycle; a file without one gains a
    /// record with Photoshop's default cycle, placed in id order. An
    /// unparseable 1032 block is replaced, not kept beside a second one.
    /// Answers whether anything changed.
    pub fn set_guides(&mut self, guides: &[PsdGuide]) -> bool {
        if self.guides() == guides {
            return false;
        }
        if let Some(b) = self.blocks.iter_mut().find(|b| b.id == RES_GRID_AND_GUIDES) {
            let mut g = match &b.body {
                ResourceBody::GridAndGuides(g) => g.clone(),
                _ => GridAndGuides::default(),
            };
            g.guides = guides.to_vec();
            b.body = ResourceBody::GridAndGuides(g);
            b.raw_block = None;
            return true;
        }
        let at = self
            .blocks
            .iter()
            .position(|b| b.id > RES_GRID_AND_GUIDES)
            .unwrap_or(self.blocks.len());
        self.blocks.insert(
            at,
            ImageResourceBlock {
                id: RES_GRID_AND_GUIDES,
                name: PascalString::new(""),
                body: ResourceBody::GridAndGuides(GridAndGuides {
                    guides: guides.to_vec(),
                    ..GridAndGuides::default()
                }),
                raw_block: None,
            },
        );
        true
    }
}

use crate::reader::ByteReader;
use crate::writer::ByteWriter;
use crate::{PsdError, Result};

pub const RESOURCE_SIGNATURE: [u8; 4] = *b"8BIM";

/// Signatures a real image-resource block may carry.
///
/// `8BIM` is Photoshop's, and the only one this parser accepted until
/// 2026-08-20 — when three Envato PSDs (`Mountain Bike {Facebook Post,
/// Instagram Post, Instagram Story}.psd`) failed outright with
/// "bad block signature MeSa". `MeSa` is ImageReady's, and files that
/// passed through it carry a mix of both. Rejecting the whole document
/// over an unrecognised RESOURCE signature is wrong twice: the block
/// layout is identical regardless of signature, and refusing to open a
/// file Photoshop opens fine is the opposite of the preservation
/// invariant.
///
/// Verbatim re-emit is unaffected — `raw_block` captures the signature
/// with everything else, so a `MeSa` block goes back out as `MeSa`.
pub const KNOWN_RESOURCE_SIGNATURES: [[u8; 4]; 5] = [
    *b"8BIM", // Photoshop
    *b"MeSa", // ImageReady
    *b"PHUT", // PhotoDeluxe
    *b"AgHg", // Adobe
    *b"DCSR", // Quark DCS
];

impl ResolutionInfo {
    fn parse(data: &[u8]) -> Option<ResolutionInfo> {
        // Fixed 16-byte record; anything else stays Opaque (raw_block
        // still preserves the bytes verbatim).
        if data.len() != 16 {
            return None;
        }
        let mut r = ByteReader::new(data);
        Some(ResolutionInfo {
            h_res_fixed: r.u32().ok()?,
            h_res_unit: r.u16().ok()?,
            width_unit: r.u16().ok()?,
            v_res_fixed: r.u32().ok()?,
            v_res_unit: r.u16().ok()?,
            height_unit: r.u16().ok()?,
        })
    }

    fn emit_data(&self, w: &mut ByteWriter) {
        w.u32(self.h_res_fixed);
        w.u16(self.h_res_unit);
        w.u16(self.width_unit);
        w.u32(self.v_res_fixed);
        w.u16(self.v_res_unit);
        w.u16(self.height_unit);
    }
}

impl GridAndGuides {
    fn parse(data: &[u8]) -> Option<GridAndGuides> {
        // A record whose guide count does not match its length stays
        // Opaque (and verbatim): we type only what we can read whole.
        let mut r = ByteReader::new(data);
        let version = r.u32().ok()?;
        let grid_cycle_h = r.u32().ok()?;
        let grid_cycle_v = r.u32().ok()?;
        let count = r.u32().ok()? as usize;
        if data.len() != 16 + count.checked_mul(5)? {
            return None;
        }
        let mut guides = Vec::with_capacity(count);
        for _ in 0..count {
            let location = r.i32().ok()?;
            let horizontal = match r.u8().ok()? {
                0 => false,
                1 => true,
                _ => return None,
            };
            guides.push(PsdGuide {
                location,
                horizontal,
            });
        }
        Some(GridAndGuides {
            version,
            grid_cycle_h,
            grid_cycle_v,
            guides,
        })
    }

    fn data_len(&self) -> usize {
        16 + 5 * self.guides.len()
    }

    fn emit_data(&self, w: &mut ByteWriter) {
        w.u32(self.version);
        w.u32(self.grid_cycle_h);
        w.u32(self.grid_cycle_v);
        w.u32(self.guides.len() as u32);
        for g in &self.guides {
            w.i32(g.location);
            w.u8(u8::from(g.horizontal));
        }
    }
}

impl ImageResources {
    /// Parse the length-framed resources section: `u32 total length` then
    /// `8BIM` blocks to the section end. Each block's complete source span
    /// (signature → trailing pad) is captured in `raw_block`.
    pub fn parse(r: &mut ByteReader) -> Result<ImageResources> {
        let total = r.u32()? as usize;
        let mut sub = r.sub(total)?;
        let mut blocks = Vec::new();
        while !sub.is_at_end() {
            blocks.push(ImageResourceBlock::parse(&mut sub)?);
        }
        Ok(ImageResources { blocks })
    }

    /// Emit the section length-framed; each block re-emits verbatim if it
    /// still carries `raw_block`, else re-encodes canonically.
    pub fn emit(&self, w: &mut ByteWriter) {
        w.framed(crate::container::LenWidth::U32, |w| {
            for b in &self.blocks {
                b.emit(w);
            }
        });
    }
}

impl ImageResourceBlock {
    fn parse(r: &mut ByteReader) -> Result<ImageResourceBlock> {
        // Probe the header on a clone to learn the full block length, then
        // take the whole block as one slice — that slice IS `raw_block`
        // (signature through trailing pad), so verbatim re-emit is exact.
        let mut probe = r.clone();
        let sig = probe.fourcc()?;
        if !KNOWN_RESOURCE_SIGNATURES.contains(&sig) {
            return Err(PsdError::Malformed {
                section: "image resource",
                detail: format!(
                    "unknown block signature {} (known: 8BIM, MeSa, PHUT, AgHg, DCSR)",
                    String::from_utf8_lossy(&sig)
                ),
            });
        }
        let id = probe.u16()?;
        let name_field_len = pascal_padded_even_len(&mut probe)?;
        let size = probe.u32()? as usize;
        // Data padded to even; the size field excludes the pad byte.
        let data_padded = size + (size & 1);
        let block_len = 4 + 2 + name_field_len + 4 + data_padded;
        let block = r.take(block_len)?;

        // Re-parse the captured slice into typed fields.
        let mut br = ByteReader::new(block);
        br.fourcc()?; // signature (validated above)
        br.u16()?; // id
        let name = read_pascal_field(&mut br, name_field_len)?;
        br.u32()?; // size
        let data = br.take(size)?;
        let body = match id {
            RES_ICC_PROFILE => ResourceBody::IccProfile(data.to_vec()),
            RES_RESOLUTION_INFO => match ResolutionInfo::parse(data) {
                Some(ri) => ResourceBody::ResolutionInfo(ri),
                None => ResourceBody::Opaque,
            },
            RES_GRID_AND_GUIDES => match GridAndGuides::parse(data) {
                Some(g) => ResourceBody::GridAndGuides(g),
                None => ResourceBody::Opaque,
            },
            _ => ResourceBody::Opaque,
        };
        Ok(ImageResourceBlock {
            id,
            name,
            body,
            raw_block: Some(block.to_vec()),
        })
    }

    fn emit(&self, w: &mut ByteWriter) {
        if let Some(raw) = &self.raw_block {
            w.bytes(raw);
            return;
        }
        w.fourcc(RESOURCE_SIGNATURE);
        w.u16(self.id);
        // Name field padded to even (anchored at the name's first byte).
        let name_start = w.len();
        if self.name.raw.is_empty() {
            // The empty name is still a length byte.
            w.u8(0);
        } else {
            w.bytes(&self.name.raw);
        }
        w.pad_to(2, name_start);
        // Data length-framed via a manual size write so we can re-encode
        // typed bodies; pad the data span to even, excluding the pad byte
        // from the stored size.
        match &self.body {
            ResourceBody::Opaque => {
                // Opaque blocks must carry raw_block; reaching here means a
                // constructed Opaque block, which is empty by definition.
                w.u32(0);
            }
            ResourceBody::IccProfile(p) => {
                w.u32(p.len() as u32);
                let data_start = w.len();
                w.bytes(p);
                w.pad_to(2, data_start);
            }
            ResourceBody::ResolutionInfo(ri) => {
                w.u32(16);
                let data_start = w.len();
                ri.emit_data(w);
                w.pad_to(2, data_start);
            }
            ResourceBody::GridAndGuides(g) => {
                w.u32(g.data_len() as u32);
                let data_start = w.len();
                g.emit_data(w);
                w.pad_to(2, data_start);
            }
        }
    }
}

/// Total byte length of a resource-name field: length byte + content,
/// padded so the field occupies an even byte count (2 minimum for the
/// empty name). Advances `r` past the field.
fn pascal_padded_even_len(r: &mut ByteReader) -> Result<usize> {
    let n = r.u8()? as usize;
    let _ = r.take(n)?;
    let content = 1 + n;
    let field = content + (content & 1);
    // Consume the pad byte so the probe stays aligned with the real read.
    if field != content {
        r.take(1)?;
    }
    Ok(field)
}

/// Read a resource-name field of known total length `field_len` (content
/// plus pad), returning the trimmed `PascalString` (length byte + content,
/// no pad — padding is contextual and re-applied by the emitter).
fn read_pascal_field(r: &mut ByteReader, field_len: usize) -> Result<PascalString> {
    let field = r.take(field_len)?;
    let n = field[0] as usize;
    Ok(PascalString {
        raw: field[..1 + n].to_vec(),
    })
}
