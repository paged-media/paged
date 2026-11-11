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

pub use pptx_fonts::eot::FS_BITMAP_ONLY;
/// The sniff and the `fsType` reader of every embedded face (`pptx-fonts`).
pub use pptx_fonts::{is_sfnt, sfnt_fs_type};

/// The use an OS/2 `fsType` grants a document that opens for editing: the
/// licence levels of [`pptx_fonts::Embedding`] (the one `fsType` table), an
/// installable face used as an editable one.
pub fn use_for_fs_type(fs_type: u16) -> FaceUse {
    use pptx_fonts::Embedding;
    if fs_type & FS_BITMAP_ONLY != 0 {
        return FaceUse::BitmapOnly;
    }
    match Embedding::from_fs_type(fs_type) {
        Embedding::Installable | Embedding::Editable => FaceUse::Editable,
        Embedding::PreviewAndPrint => FaceUse::PreviewAndPrint,
        Embedding::Restricted => FaceUse::Restricted,
    }
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
