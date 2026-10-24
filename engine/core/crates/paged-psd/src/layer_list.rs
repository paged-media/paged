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

//! Layer lists that are not in the layer info sub-block, and a header
//! summary that copies no pixels.
//!
//! - [`PsdFile::layer_list`]: the document's layers at any depth. A 16-
//!   or 32-bit document leaves the layer info empty and keeps its layers
//!   in an `Lr16` / `Lr32` document block.
//! - [`image_source_data_layers`]: the layers Photoshop writes into a
//!   TIFF (tag 37724, ImageSourceData).
//! - [`summary`]: header, resources and the layer count of a PSD/PSB,
//!   read without copying a channel (what a raster probe needs).
//!
//! All three are pure READS; the preservation model is not touched.
//!
//! ImageSourceData is the signature `Adobe Photoshop Document Data
//! Block\0` followed by the layer & mask section's document-level blocks
//! (`8BIM` + key + u32 length + data, padded to 4): `Layr` (or `Lr16` /
//! `Lr32`) carries the layer info, `LMsk` the global mask, and so on. A
//! big-endian TIFF writes them big-endian. A little-endian TIFF writes
//! the payload little-endian (its signatures read `MIB8`); this reader
//! does not read that byte order and answers [`PsdError::Unsupported`],
//! naming it.
//!
//! A layer info body framed by its block starts with the layer count.
//! Some writers put the layer info's own length field first; both
//! framings are tried and the record parser's signature checks reject
//! the wrong one.
//!
//! Provenance: Adobe Photoshop File Format specification, "Layer and
//! Mask Information Section" and "Additional Layer Information" (`Lr16`,
//! `Lr32`, `Layr`); Adobe Photoshop TIFF Technical Notes (tag 37724).

use crate::container::{Container, LenWidth};
use crate::model::layers::parse_layer_info_body;
use crate::model::{ColorModeData, FileHeader, ImageResources, LayerRecord, PsdFile};
use crate::reader::ByteReader;
use crate::{PsdError, Result};

/// What a TIFF's ImageSourceData (tag 37724) starts with.
pub const IMAGE_SOURCE_DATA_SIGNATURE: &[u8] = b"Adobe Photoshop Document Data Block\0";

/// The keys of a block that holds a layer info body.
const LAYER_KEYS: [&[u8; 4]; 3] = [b"Layr", b"Lr16", b"Lr32"];

/// A layer list read from wherever the file keeps it.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct LayerList {
    /// The records in stored order (bottom-most first), group open and
    /// close markers (`lsct`) included. Each carries its channel payloads,
    /// except in a [`summary`] (which reads records only).
    pub layers: Vec<LayerRecord>,
    /// The stored layer count was negative (the merged composite's first
    /// extra channel is transparency).
    pub transparency_in_merged: bool,
    /// The block the list came from (`Layr`, `Lr16`, `Lr32`), `None` for
    /// the layer info sub-block itself.
    pub key: Option<[u8; 4]>,
}

impl PsdFile {
    /// The document's layers at any depth: the layer info sub-block's own
    /// records when it has any (an 8-bit document), else the first
    /// `Lr16` / `Lr32` / `Layr` document block. An empty list when the
    /// document has no layers.
    pub fn layer_list(&self) -> Result<LayerList> {
        if !self.layer_mask.layers.is_empty() {
            return Ok(LayerList {
                layers: self.layer_mask.layers.clone(),
                transparency_in_merged: self.layer_mask.transparency_in_merged,
                key: None,
            });
        }
        for block in &self.layer_mask.addl_global {
            if !LAYER_KEYS.contains(&&block.key) {
                continue;
            }
            let Some(raw) = block.raw_block.as_deref() else {
                continue;
            };
            let mut r = ByteReader::new(raw);
            r.fourcc()?;
            r.fourcc()?;
            let len = r.len_field(block_len_width(self.container, block.sig, block.key))? as usize;
            let data = r.take(len)?;
            return layer_info_block(data, self.container, block.key, true);
        }
        Ok(LayerList::default())
    }
}

/// The layer list in a TIFF's ImageSourceData (tag 37724) payload, with
/// the channel payloads. An empty list when the payload carries no
/// `Layr` / `Lr16` / `Lr32` block.
pub fn image_source_data_layers(data: &[u8]) -> Result<LayerList> {
    source_data_layers(data, true)
}

/// [`image_source_data_layers`] without the channel payloads: the records
/// only, nothing copied but their fields.
pub fn image_source_data_records(data: &[u8]) -> Result<LayerList> {
    source_data_layers(data, false)
}

fn source_data_layers(data: &[u8], channels: bool) -> Result<LayerList> {
    let Some(body) = data.strip_prefix(IMAGE_SOURCE_DATA_SIGNATURE) else {
        return Err(PsdError::BadSignature(
            "ImageSourceData does not start with `Adobe Photoshop Document Data Block`".into(),
        ));
    };
    let mut r = ByteReader::new(body);
    while r.remaining() >= 12 {
        let sig = r.fourcc()?;
        match &sig {
            b"8BIM" | b"8B64" => {}
            b"MIB8" | b"46B8" => {
                return Err(PsdError::Unsupported(
                    "little-endian ImageSourceData (the layers of a little-endian TIFF)".into(),
                ))
            }
            _ => {
                return Err(PsdError::Malformed {
                    section: "ImageSourceData",
                    detail: format!("bad block signature {:?}", String::from_utf8_lossy(&sig)),
                })
            }
        }
        let key = r.fourcc()?;
        let len = r.u32()? as usize;
        let start = r.pos();
        let block = r.take(len)?;
        if LAYER_KEYS.contains(&&key) {
            return layer_info_block(block, Container::Psd, key, channels);
        }
        if r.align(4, start).is_err() {
            break;
        }
    }
    Ok(LayerList::default())
}

/// A PSD/PSB's header facts, read without copying a channel.
#[derive(Debug, Clone, PartialEq)]
pub struct PsdSummary {
    pub container: Container,
    pub header: FileHeader,
    pub resources: ImageResources,
    /// The layer records (no channel payloads), from the layer info or,
    /// for a 16- or 32-bit document, its `Lr16` / `Lr32` block.
    pub layers: LayerList,
    /// The merged composite's compression code (0 RAW, 1 RLE, 2/3 ZIP).
    pub composite_compression: u16,
}

/// Read a PSD/PSB's header, image resources and layer records, skipping
/// every pixel payload. The full parse ([`PsdFile::parse`]) copies the
/// whole file into its model; a probe needs a few hundred bytes of it.
pub fn summary(bytes: &[u8]) -> Result<PsdSummary> {
    let mut r = ByteReader::new(bytes);
    let (container, header) = FileHeader::parse(&mut r)?;
    ColorModeData::parse(&mut r)?;
    let resources = ImageResources::parse(&mut r)?;

    let width = container.section_len_width();
    let total = r.len_field(width)? as usize;
    let mut section = r.sub(total)?;
    let mut layers = LayerList::default();
    if section.remaining() >= width.bytes() {
        let len = section.len_field(width)? as usize;
        if len > 0 {
            let mut info = section.sub(len)?;
            let (records, transparency_in_merged) =
                parse_layer_info_body(&mut info, container, false)?;
            layers = LayerList {
                layers: records,
                transparency_in_merged,
                key: None,
            };
        }
    }
    if layers.layers.is_empty() {
        // The global mask, then the document-level blocks, padded to 4.
        if section.remaining() >= 4 {
            let n = section.u32()? as usize;
            section.take(n)?;
        }
        while section.remaining() >= 12 {
            let sig = section.fourcc()?;
            if &sig != b"8BIM" && &sig != b"8B64" {
                break;
            }
            let key = section.fourcc()?;
            let len = section.len_field(block_len_width(container, sig, key))? as usize;
            let start = section.pos();
            let data = section.take(len)?;
            if LAYER_KEYS.contains(&&key) {
                layers = layer_info_block(data, container, key, false)?;
                break;
            }
            if section.align(4, start).is_err() {
                break;
            }
        }
    }
    let composite_compression = r.u16()?;
    Ok(PsdSummary {
        container,
        header,
        resources,
        layers,
        composite_compression,
    })
}

/// The width of a document-level block's length field: 8 bytes when the
/// block is signed `8B64` or its key is wide in a PSB.
fn block_len_width(container: Container, sig: [u8; 4], key: [u8; 4]) -> LenWidth {
    if &sig == b"8B64" || container.addl_len_is_wide(key) {
        LenWidth::U64
    } else {
        LenWidth::U32
    }
}

/// A layer info body framed by its block (see the module docs).
fn layer_info_block(
    data: &[u8],
    container: Container,
    key: [u8; 4],
    channels: bool,
) -> Result<LayerList> {
    let parse = |bytes: &[u8]| {
        let mut r = ByteReader::new(bytes);
        parse_layer_info_body(&mut r, container, channels)
    };
    if data.is_empty() {
        return Ok(LayerList {
            key: Some(key),
            ..LayerList::default()
        });
    }
    // Count first. A zero count over a block that holds more than the
    // count is the other framing's length field read as a count.
    let first = parse(data);
    let plausible = matches!(&first, Ok((layers, _)) if !layers.is_empty() || data.len() <= 4);
    let (layers, transparency_in_merged) = if plausible {
        first?
    } else {
        let width = container.section_len_width();
        let mut r = ByteReader::new(data);
        let framed = r
            .len_field(width)
            .ok()
            .and_then(|n| data.get(width.bytes()..width.bytes().checked_add(n as usize)?))
            .map(parse);
        match (framed, first) {
            (Some(Ok(list)), _) => list,
            (_, first) => first?,
        }
    };
    Ok(LayerList {
        layers,
        transparency_in_merged,
        key: Some(key),
    })
}
