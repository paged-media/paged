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

//! # pptx-fonts — a deck's embedded fonts
//!
//! PowerPoint stores each face it embeds as a part `ppt/fonts/fontN.fntdata`
//! in the Embedded OpenType format (EOT, W3C member submission of
//! 5 March 2008): a little-endian header naming the face and carrying its
//! embedding permissions, then the font data, compressed with MicroType
//! Express (MTX, W3C member submission of the same date) and possibly
//! XOR-obfuscated. [`decode`] turns such a part back into the TrueType file
//! it was made from; [`permissions`] reads only what the licence allows, so
//! a face that may not be used is never decompressed.
//!
//! The decoder is written from the two specifications:
//!
//! - the EOT header, versions 0x00010000, 0x00020001 and 0x00020002
//!   ([`eot`]);
//! - LZCOMP, the adaptive-Huffman LZ77 variant MTX compresses each of its
//!   three blocks with (modules `lzcomp`, `ahuff`);
//! - the Compact Table Format the blocks hold: `glyf` as contour triplets
//!   with the glyph programs' push data and instructions in blocks two and
//!   three, `loca` left out, `cvt ` as deltas, `hdmx` and `VDMX` as the
//!   error against a prediction (module `ctf`).
//!
//! It is written for hostile input: every read is bounds-checked, every
//! allocation is bounded by [`Limits`] or by the format's own field widths,
//! and a malformed part is an [`Error`], never a panic.

mod ahuff;
mod bits;
mod ctf;
pub mod eot;
mod lzcomp;
mod mtx;
mod sfnt;

pub use eot::{Embedding, EotHeader};

/// Why an embedded face could not be read.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum Error {
    /// Not an Embedded OpenType file (the magic number is missing).
    #[error("not an Embedded OpenType file")]
    NotEot,
    /// A structure runs past the end of its data.
    #[error("truncated: {0}")]
    Truncated(&'static str),
    /// A value the format does not allow.
    #[error("malformed: {0}")]
    Malformed(String),
    /// A version or form this decoder does not read.
    #[error("unsupported: {0}")]
    Unsupported(String),
    /// The decoded face would exceed [`Limits::max_font_bytes`].
    #[error("the decoded face would exceed {0} bytes")]
    TooLarge(usize),
}

pub(crate) type Result<T> = std::result::Result<T, Error>;

pub(crate) fn malformed<T>(what: impl Into<String>) -> Result<T> {
    Err(Error::Malformed(what.into()))
}

/// Bounds on what a decode may allocate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    /// The largest font (and the largest intermediate block) a decode
    /// produces; anything larger is [`Error::TooLarge`].
    pub max_font_bytes: usize,
}

impl Default for Limits {
    fn default() -> Self {
        // A large CJK face is 20 MB; nothing PowerPoint embeds is larger.
        Limits {
            max_font_bytes: 32 << 20,
        }
    }
}

/// A decoded embedded face.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmbeddedFace {
    /// The EOT header (names, weight, italic flag, processing flags), when
    /// the part is Embedded OpenType; a bare OpenType part has none.
    pub header: Option<EotHeader>,
    /// The face's permissions ([`Permissions`]).
    pub permissions: Permissions,
    /// The face as an OpenType/TrueType file.
    pub sfnt: Vec<u8>,
    /// What the decoder rebuilt differently from the original (a table it
    /// could not reconstruct and left out). Empty for a clean decode.
    pub notes: Vec<String>,
}

/// What a face's licence allows, read before anything is decompressed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Permissions {
    /// OS/2 `fsType`: the EOT header's copy, or a bare font's own (zero,
    /// the least restrictive, when it has no OS/2 table: EOT §2.3).
    pub fs_type: u16,
    /// The EOT root string names web addresses the face is tied to.
    pub restricted_to_sites: bool,
    /// The face holds only the glyphs the document uses (`TTEMBED_SUBSET`).
    pub subset: bool,
}

impl Permissions {
    /// The embedding level ([`Embedding`]).
    pub fn embedding(&self) -> Embedding {
        Embedding::from_fs_type(self.fs_type)
    }

    /// Only the face's bitmaps may be embedded: its outlines may not be
    /// used.
    pub fn bitmap_only(&self) -> bool {
        self.fs_type & eot::FS_BITMAP_ONLY != 0
    }
}

/// A bare OpenType file (some producers embed one instead of EOT).
fn is_sfnt(bytes: &[u8]) -> bool {
    matches!(bytes.get(0..4), Some([0, 1, 0, 0] | b"true" | b"OTTO"))
}

/// The permissions of an embedded face, Embedded OpenType or a bare
/// OpenType file, without decompressing anything.
pub fn permissions(bytes: &[u8]) -> Result<Permissions> {
    if is_sfnt(bytes) {
        return Ok(Permissions {
            fs_type: sfnt::fs_type(bytes)?,
            restricted_to_sites: false,
            subset: false,
        });
    }
    let (h, _) = eot::parse(bytes)?;
    Ok(Permissions {
        fs_type: h.fs_type,
        restricted_to_sites: h.restricted_to_sites(),
        subset: h.subset(),
    })
}

/// Read only the EOT header of `bytes`: the face's names and its embedding
/// permissions, without touching the font data.
pub fn header(bytes: &[u8]) -> Result<EotHeader> {
    eot::parse(bytes).map(|(h, _)| h)
}

/// Decode an embedded face with the default [`Limits`].
pub fn decode(bytes: &[u8]) -> Result<EmbeddedFace> {
    decode_with(bytes, &Limits::default())
}

/// Decode an embedded face: undo the XOR obfuscation and the MicroType
/// Express compression the EOT header's flags name, and return the
/// TrueType file. A bare OpenType file is checked and returned as it is.
/// The caller decides from [`EmbeddedFace::permissions`] whether the face
/// may be used at all.
pub fn decode_with(bytes: &[u8], limits: &Limits) -> Result<EmbeddedFace> {
    if is_sfnt(bytes) {
        if bytes.len() > limits.max_font_bytes {
            return Err(Error::TooLarge(limits.max_font_bytes));
        }
        sfnt::check(bytes)?;
        return Ok(EmbeddedFace {
            header: None,
            permissions: permissions(bytes)?,
            sfnt: bytes.to_vec(),
            notes: Vec::new(),
        });
    }
    let (header, data) = eot::parse(bytes)?;
    let mut data = data.to_vec();
    if header.xor_obfuscated() {
        for b in &mut data {
            *b ^= eot::XOR_KEY;
        }
    }
    let mut notes = Vec::new();
    let sfnt = if header.compressed() {
        mtx::decompress(&data, limits, &mut notes)?
    } else {
        if data.len() > limits.max_font_bytes {
            return Err(Error::TooLarge(limits.max_font_bytes));
        }
        sfnt::check(&data)?;
        data
    };
    Ok(EmbeddedFace {
        permissions: Permissions {
            fs_type: header.fs_type,
            restricted_to_sites: header.restricted_to_sites(),
            subset: header.subset(),
        },
        header: Some(header),
        sfnt,
        notes,
    })
}
