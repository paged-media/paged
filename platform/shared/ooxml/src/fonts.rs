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

//! Embedded fonts, the part every OOXML format shares: what a face's licence
//! lets a document do with it, and Word's obfuscated font parts.
//!
//! PowerPoint embeds Embedded OpenType (the decoder is `pptx-fonts`); Word
//! embeds an OpenType file whose first 32 bytes are XOR-obfuscated with the
//! font's GUID key (`word/fonts/fontN.odttf`, ECMA-376 Part 2 section 17.8.1,
//! [`deobfuscate`]). Both carry the OS/2 `fsType` embedding permissions, which
//! [`use_for_fs_type`] reads the same way for either.

/// What may be done with an embedded face.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FaceUse {
    /// The document may use it and be edited: installable or editable
    /// embedding.
    Editable,
    /// Licensed for preview and print only (the document must be
    /// read-only): not used.
    PreviewAndPrint,
    /// Not licensed for embedding: not used.
    Restricted,
    /// Only the face's bitmaps may be embedded: not used.
    BitmapOnly,
    /// Tied to named web addresses: not used.
    SitesOnly,
    /// The part could not be read: not used.
    Unreadable,
    /// The relationship names a part the package does not hold.
    Missing,
}

impl FaceUse {
    /// The camelCase name the import reports use.
    pub fn name(self) -> &'static str {
        match self {
            FaceUse::Editable => "editable",
            FaceUse::PreviewAndPrint => "previewAndPrint",
            FaceUse::Restricted => "restricted",
            FaceUse::BitmapOnly => "bitmapOnly",
            FaceUse::SitesOnly => "sitesOnly",
            FaceUse::Unreadable => "unreadable",
            FaceUse::Missing => "missing",
        }
    }
}

/// OS/2 `fsType` bit: only the face's bitmaps may be embedded.
pub const FS_BITMAP_ONLY: u16 = 0x0200;

/// The use an OS/2 `fsType` grants a document that opens for editing. Older
/// fonts may set several of bits 0 to 3; the least restrictive one applies.
pub fn use_for_fs_type(fs_type: u16) -> FaceUse {
    if fs_type & FS_BITMAP_ONLY != 0 {
        FaceUse::BitmapOnly
    } else if fs_type & 0x000E == 0 || fs_type & 0x0008 != 0 {
        FaceUse::Editable
    } else if fs_type & 0x0004 != 0 {
        FaceUse::PreviewAndPrint
    } else {
        FaceUse::Restricted
    }
}

/// Whether `bytes` start like an OpenType or TrueType file.
pub fn is_sfnt(bytes: &[u8]) -> bool {
    matches!(bytes.get(0..4), Some([0, 1, 0, 0] | b"true" | b"OTTO"))
}

/// The OS/2 `fsType` of an OpenType file: zero (the least restrictive) when
/// it has no OS/2 table, `None` when `font` is not one.
pub fn sfnt_fs_type(font: &[u8]) -> Option<u16> {
    if !is_sfnt(font) {
        return None;
    }
    let tables = u16::from_be_bytes([*font.get(4)?, *font.get(5)?]) as usize;
    for k in 0..tables {
        let rec = 12 + k * 16;
        let tag = font.get(rec..rec + 4)?;
        if tag == b"OS/2" {
            let off = u32::from_be_bytes(font.get(rec + 8..rec + 12)?.try_into().ok()?) as usize;
            let at = off.checked_add(8)?;
            let b = font.get(at..at + 2)?;
            return Some(u16::from_be_bytes([b[0], b[1]]));
        }
    }
    Some(0)
}

/// Undo Word's obfuscation of an embedded font part: the 16 bytes of the
/// font's GUID key (`w:fontKey`, `{XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}`),
/// read from the end of its text, are XORed into the first 32 bytes, twice.
/// `None` when the key is not a GUID.
pub fn deobfuscate(part: &[u8], font_key: &str) -> Option<Vec<u8>> {
    let hex: Vec<u8> = font_key
        .bytes()
        .filter(|b| !matches!(b, b'{' | b'}' | b'-'))
        .collect();
    if hex.len() != 32 {
        return None;
    }
    let mut key = [0u8; 16];
    for (k, pair) in hex.chunks(2).enumerate() {
        let hi = (pair[0] as char).to_digit(16)? as u8;
        let lo = (pair[1] as char).to_digit(16)? as u8;
        // The key is the GUID's text bytes in reverse order.
        key[15 - k] = (hi << 4) | lo;
    }
    let mut out = part.to_vec();
    for (i, b) in out.iter_mut().take(32).enumerate() {
        *b ^= key[i % 16];
    }
    Some(out)
}

/// Obfuscate a font for a part (the same XOR: it is its own inverse). Used by
/// tests that build a package.
pub fn obfuscate(font: &[u8], font_key: &str) -> Option<Vec<u8>> {
    deobfuscate(font, font_key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn xor_is_its_own_inverse_and_touches_32_bytes() {
        let font: Vec<u8> = (0..100u8).collect();
        let key = "{01234567-89AB-CDEF-0123-456789ABCDEF}";
        let o = obfuscate(&font, key).unwrap();
        assert_ne!(o[..32], font[..32]);
        assert_eq!(o[32..], font[32..]);
        assert_eq!(deobfuscate(&o, key).unwrap(), font);
    }

    #[test]
    fn key_bytes_run_from_the_end_of_the_text() {
        // GUID text 00112233-4455-6677-8899-AABBCCDDEEFF: the first part byte
        // is XORed with 0xFF (the last byte of the text), the second with 0xEE.
        let key = "{00112233-4455-6677-8899-AABBCCDDEEFF}";
        let o = deobfuscate(&[0u8; 32], key).unwrap();
        assert_eq!(&o[..4], &[0xFF, 0xEE, 0xDD, 0xCC]);
        assert_eq!(o[15], 0x00);
        assert_eq!(o[16], 0xFF);
        assert!(deobfuscate(&[0u8; 4], "not a guid").is_none());
    }

    #[test]
    fn licence_levels() {
        assert_eq!(use_for_fs_type(0), FaceUse::Editable);
        assert_eq!(use_for_fs_type(0x0008), FaceUse::Editable);
        assert_eq!(use_for_fs_type(0x000C), FaceUse::Editable);
        assert_eq!(use_for_fs_type(0x0004), FaceUse::PreviewAndPrint);
        assert_eq!(use_for_fs_type(0x0002), FaceUse::Restricted);
        assert_eq!(use_for_fs_type(0x0208), FaceUse::BitmapOnly);
    }

    #[test]
    fn fs_type_of_a_font_without_os2_is_zero() {
        let mut f = vec![0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        assert_eq!(sfnt_fs_type(&f), Some(0));
        f[0] = 1;
        assert_eq!(sfnt_fs_type(&f), None);
    }
}
