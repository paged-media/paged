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

//! The Embedded OpenType container (W3C member submission, 5 March 2008,
//! §3): the `EMBEDDEDFONT` header and where its font data sits.
//!
//! Every value in the header is little-endian; the font data after it is an
//! ordinary big-endian OpenType file (once decompressed).

use crate::{Error, Result};

/// The magic number every EOT header carries at offset 34 (`0x504C`).
const MAGIC: u16 = 0x504C;
/// The key `TTEMBED_XORENCRYPTDATA` data is XORed with, byte by byte.
pub(crate) const XOR_KEY: u8 = 0x50;

/// `TTEMBED_SUBSET`: the face holds only the glyphs the document needs.
pub const FLAG_SUBSET: u32 = 0x0000_0001;
/// `TTEMBED_TTCOMPRESSED`: the font data is MicroType Express compressed.
pub const FLAG_COMPRESSED: u32 = 0x0000_0004;
/// `TTEMBED_XORENCRYPTDATA`: the font data is XORed with `0x50`.
pub const FLAG_XOR: u32 = 0x1000_0000;

/// OS/2 `fsType` bit: only the face's bitmaps may be embedded.
pub const FS_BITMAP_ONLY: u16 = 0x0200;

/// What a face's licence lets the document do with it (OS/2 `fsType`,
/// EOT §4.1). Older fonts may set several of bits 0–3; the least
/// restrictive one applies.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Embedding {
    /// No restriction bit set: the face may be embedded and even installed.
    Installable,
    /// `0x0008`: the face may be loaded while the document is open; the
    /// document may be edited and saved.
    Editable,
    /// `0x0004`: the face may be loaded while the document is open, to view
    /// and print it; the document must be read-only.
    PreviewAndPrint,
    /// `0x0002` alone: the face may not be embedded or used at all.
    Restricted,
}

impl Embedding {
    /// The level `fs_type` grants (bits 0–3; the least restrictive wins).
    pub fn from_fs_type(fs_type: u16) -> Self {
        if fs_type & 0x000E == 0 {
            Embedding::Installable
        } else if fs_type & 0x0008 != 0 {
            Embedding::Editable
        } else if fs_type & 0x0004 != 0 {
            Embedding::PreviewAndPrint
        } else {
            Embedding::Restricted
        }
    }

    /// Whether a document may be edited while it uses the face.
    pub fn allows_editing(self) -> bool {
        matches!(self, Embedding::Installable | Embedding::Editable)
    }
}

/// An EOT header (`EMBEDDEDFONT` without its font data).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EotHeader {
    /// `0x00010000`, `0x00020001` or `0x00020002`.
    pub version: u32,
    /// Processing flags (`FLAG_*`).
    pub flags: u32,
    /// The face's family name (name ID 1).
    pub family: String,
    /// Its subfamily (name ID 2): `Regular`, `Bold`, `Italic`, ...
    pub style: String,
    /// Its full name (name ID 4).
    pub full_name: String,
    /// Its version string (name ID 5).
    pub version_name: String,
    /// OS/2 `usWeightClass`.
    pub weight: u32,
    /// OS/2 `fsSelection` has the italic bit.
    pub italic: bool,
    /// OS/2 `fsType`: the embedding permissions.
    pub fs_type: u16,
    /// The URLs the face may be used from (version 2 headers), separated by
    /// NULs; empty when the face is not tied to any.
    pub root_string: String,
}

impl EotHeader {
    /// The font data is MicroType Express compressed.
    pub fn compressed(&self) -> bool {
        self.flags & FLAG_COMPRESSED != 0
    }

    /// The font data is XOR-obfuscated.
    pub fn xor_obfuscated(&self) -> bool {
        self.flags & FLAG_XOR != 0
    }

    /// The face is a subset holding only the glyphs the document uses.
    pub fn subset(&self) -> bool {
        self.flags & FLAG_SUBSET != 0
    }

    /// What the licence allows ([`Embedding`]).
    pub fn embedding(&self) -> Embedding {
        Embedding::from_fs_type(self.fs_type)
    }

    /// Only the face's bitmaps may be embedded: its outlines may not be
    /// used.
    pub fn bitmap_only(&self) -> bool {
        self.fs_type & FS_BITMAP_ONLY != 0
    }

    /// The face may be used only from the web addresses in its root string.
    pub fn restricted_to_sites(&self) -> bool {
        self.root_string
            .chars()
            .any(|c| c != '\0' && !c.is_whitespace())
    }
}

/// A little-endian reader over the header.
struct Le<'a> {
    b: &'a [u8],
    at: usize,
}

impl<'a> Le<'a> {
    fn take(&mut self, n: usize, what: &'static str) -> Result<&'a [u8]> {
        let end = self.at.checked_add(n).ok_or(Error::Truncated(what))?;
        let s = self.b.get(self.at..end).ok_or(Error::Truncated(what))?;
        self.at = end;
        Ok(s)
    }
    fn u8(&mut self, what: &'static str) -> Result<u8> {
        Ok(self.take(1, what)?[0])
    }
    fn u16(&mut self, what: &'static str) -> Result<u16> {
        let s = self.take(2, what)?;
        Ok(u16::from_le_bytes([s[0], s[1]]))
    }
    fn u32(&mut self, what: &'static str) -> Result<u32> {
        let s = self.take(4, what)?;
        Ok(u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
    }
    /// A size-prefixed UTF-16LE string.
    fn utf16(&mut self, what: &'static str) -> Result<String> {
        let n = self.u16(what)? as usize;
        let s = self.take(n, what)?;
        let units: Vec<u16> = s
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        Ok(String::from_utf16_lossy(&units)
            .trim_end_matches('\0')
            .to_string())
    }
}

/// Parse the header of `bytes` and return it with the font data it
/// describes (still compressed and obfuscated as the flags say).
pub(crate) fn parse(bytes: &[u8]) -> Result<(EotHeader, &[u8])> {
    if bytes.len() < 36 || u16::from_le_bytes([bytes[34], bytes[35]]) != MAGIC {
        return Err(Error::NotEot);
    }
    let mut r = Le { b: bytes, at: 0 };
    let _eot_size = r.u32("EOTSize")?;
    let font_data_size = r.u32("FontDataSize")? as usize;
    let version = r.u32("Version")?;
    if !matches!(version, 0x0001_0000 | 0x0002_0001 | 0x0002_0002) {
        return Err(Error::Unsupported(format!("EOT version {version:#010x}")));
    }
    let flags = r.u32("Flags")?;
    r.take(10, "FontPANOSE")?;
    let _charset = r.u8("Charset")?;
    let italic = r.u8("Italic")? != 0;
    let weight = r.u32("Weight")?;
    let fs_type = r.u16("fsType")?;
    let _magic = r.u16("MagicNumber")?;
    // UnicodeRange1–4, CodePageRange1–2, CheckSumAdjustment, Reserved1–4.
    r.take(44, "ranges")?;
    let _padding1 = r.u16("Padding1")?;
    let family = r.utf16("FamilyName")?;
    let _padding2 = r.u16("Padding2")?;
    let style = r.utf16("StyleName")?;
    let _padding3 = r.u16("Padding3")?;
    let version_name = r.utf16("VersionName")?;
    let _padding4 = r.u16("Padding4")?;
    let full_name = r.utf16("FullName")?;
    let mut root_string = String::new();
    if version >= 0x0002_0001 {
        let _padding5 = r.u16("Padding5")?;
        root_string = r.utf16("RootString")?;
    }
    if version == 0x0002_0002 {
        let _root_checksum = r.u32("RootStringCheckSum")?;
        let _eudc_code_page = r.u32("EUDCCodePage")?;
        let _padding6 = r.u16("Padding6")?;
        let signature = r.u16("SignatureSize")? as usize;
        r.take(signature, "Signature")?;
        let _eudc_flags = r.u32("EUDCFlags")?;
        let eudc = r.u32("EUDCFontSize")? as usize;
        r.take(eudc, "EUDCFontData")?;
    }
    let data = r.take(font_data_size, "FontData")?;
    Ok((
        EotHeader {
            version,
            flags,
            family,
            style,
            full_name,
            version_name,
            weight,
            italic,
            fs_type,
            root_string,
        },
        data,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_least_restrictive_embedding_bit_wins() {
        assert_eq!(Embedding::from_fs_type(0), Embedding::Installable);
        assert_eq!(Embedding::from_fs_type(0x0001), Embedding::Installable);
        assert_eq!(Embedding::from_fs_type(0x0002), Embedding::Restricted);
        assert_eq!(Embedding::from_fs_type(0x0004), Embedding::PreviewAndPrint);
        assert_eq!(Embedding::from_fs_type(0x0008), Embedding::Editable);
        assert_eq!(Embedding::from_fs_type(0x0006), Embedding::PreviewAndPrint);
        assert_eq!(Embedding::from_fs_type(0x000C), Embedding::Editable);
        assert_eq!(Embedding::from_fs_type(0x0108), Embedding::Editable);
        assert!(Embedding::Editable.allows_editing());
        assert!(!Embedding::PreviewAndPrint.allows_editing());
    }

    #[test]
    fn a_short_or_foreign_file_is_not_eot() {
        assert_eq!(parse(&[]).unwrap_err(), Error::NotEot);
        assert_eq!(parse(&[0u8; 64]).unwrap_err(), Error::NotEot);
        assert_eq!(
            parse(b"\0\x01\0\0 a TrueType file").unwrap_err(),
            Error::NotEot
        );
    }
}
