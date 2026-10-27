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

//! Raster format sniffing: which container a file's first bytes name.
//!
//! The one definition of "what format is this picture" for the engine.
//! `paged-raster` re-exports [`sniff`] and [`Format`] and decodes what it
//! names; a crate that only has to name or label an image (the IDML
//! writer picks a file extension) depends on this crate alone and links
//! no decoder.

#![forbid(unsafe_code)]

/// A raster container.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Format {
    /// TIFF, classic (`II*\0` / `MM\0*`) or BigTIFF (`II+\0` / `MM\0+`).
    Tiff,
    Png,
    Jpeg,
    WebP,
    Gif,
    Bmp,
    /// Photoshop document or large document (`8BPS`).
    Psd,
    /// Encapsulated PostScript: a DOS EPS binary file (`C5 D0 D3 C6`) or a
    /// PostScript text file (`%!PS`). Only its preview is read.
    Eps,
    /// A Digital Negative: a TIFF whose first IFD carries DNGVersion.
    Dng,
    /// AVIF: an ISO BMFF file whose `ftyp` names the `avif` or `avis` brand.
    Avif,
    /// JPEG XL, a bare codestream (`FF 0A`) or the ISO BMFF container.
    Jxl,
    /// Truevision TGA (no magic number: the version-2 footer, or a header
    /// that holds together).
    Tga,
    /// Quite OK Image (`qoif`).
    Qoi,
    /// Windows icon (`00 00 01 00`).
    Ico,
    /// Radiance RGBE (`#?RADIANCE` / `#?RGBE`).
    Hdr,
    /// OpenEXR (`76 2F 31 01`).
    Exr,
}

impl Format {
    /// Floating-point samples of this format are scene-linear light, not
    /// sRGB-encoded values.
    pub fn is_scene_linear(self) -> bool {
        matches!(self, Format::Hdr | Format::Exr)
    }

    /// The usual file extension, without the dot.
    pub fn extension(self) -> &'static str {
        match self {
            Format::Tiff => "tif",
            Format::Png => "png",
            Format::Jpeg => "jpg",
            Format::WebP => "webp",
            Format::Gif => "gif",
            Format::Bmp => "bmp",
            Format::Psd => "psd",
            Format::Eps => "eps",
            Format::Dng => "dng",
            Format::Avif => "avif",
            Format::Jxl => "jxl",
            Format::Tga => "tga",
            Format::Qoi => "qoi",
            Format::Ico => "ico",
            Format::Hdr => "hdr",
            Format::Exr => "exr",
        }
    }

    /// The media type.
    pub fn mime(self) -> &'static str {
        match self {
            Format::Tiff => "image/tiff",
            Format::Png => "image/png",
            Format::Jpeg => "image/jpeg",
            Format::WebP => "image/webp",
            Format::Gif => "image/gif",
            Format::Bmp => "image/bmp",
            Format::Psd => "image/vnd.adobe.photoshop",
            Format::Eps => "application/postscript",
            Format::Dng => "image/x-adobe-dng",
            Format::Avif => "image/avif",
            Format::Jxl => "image/jxl",
            Format::Tga => "image/x-tga",
            Format::Qoi => "image/qoi",
            Format::Ico => "image/vnd.microsoft.icon",
            Format::Hdr => "image/vnd.radiance",
            Format::Exr => "image/x-exr",
        }
    }
}

/// The format the bytes start with, if any.
pub fn sniff(bytes: &[u8]) -> Option<Format> {
    if bytes.starts_with(&[0xFF, 0x0A]) {
        return Some(Format::Jxl);
    }
    let head = |n: usize| bytes.get(..n);
    match head(4)? {
        [b'I', b'I', 42 | 43, 0] | [b'M', b'M', 0, 42 | 43] => {
            return Some(if is_dng(bytes) {
                Format::Dng
            } else {
                Format::Tiff
            });
        }
        b"8BPS" => return Some(Format::Psd),
        [0x89, b'P', b'N', b'G'] => return Some(Format::Png),
        [0xFF, 0xD8, 0xFF, _] => return Some(Format::Jpeg),
        b"GIF8" => return Some(Format::Gif),
        [0xC5, 0xD0, 0xD3, 0xC6] | [b'%', b'!', b'P', b'S'] => return Some(Format::Eps),
        b"qoif" => return Some(Format::Qoi),
        [0x76, 0x2F, 0x31, 0x01] => return Some(Format::Exr),
        [0, 0, 1, 0] if bytes.len() >= 22 && bytes[4..6] != [0, 0] => return Some(Format::Ico),
        _ => {}
    }
    if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some(Format::WebP);
    }
    if bytes.starts_with(b"BM") && bytes.len() >= 14 {
        return Some(Format::Bmp);
    }
    if bytes.starts_with(b"#?RADIANCE") || bytes.starts_with(b"#?RGBE") {
        return Some(Format::Hdr);
    }
    if bytes.starts_with(b"\0\0\0\x0CJXL \r\n\x87\n") {
        return Some(Format::Jxl);
    }
    if is_avif(bytes) {
        return Some(Format::Avif);
    }
    if is_tga(bytes) {
        return Some(Format::Tga);
    }
    None
}

/// The DNGVersion tag (50706) of a TIFF's first IFD.
const DNG_VERSION: u64 = 50706;

/// A TIFF whose first IFD carries DNGVersion: classic or BigTIFF, either
/// byte order. Only IFD0's entry tags are read.
fn is_dng(bytes: &[u8]) -> bool {
    let little = bytes.starts_with(b"II");
    let int = |at: usize, n: usize| -> Option<u64> {
        let s = bytes.get(at..at.checked_add(n)?)?;
        Some(if little {
            s.iter().rev().fold(0u64, |a, &b| (a << 8) | u64::from(b))
        } else {
            s.iter().fold(0u64, |a, &b| (a << 8) | u64::from(b))
        })
    };
    let big = int(2, 2) == Some(43);
    let (ifd0, count_len, entry_len) = if big {
        (int(8, 8), 8, 20)
    } else {
        (int(4, 4), 2, 12)
    };
    let Some(ifd0) = ifd0.and_then(|o| usize::try_from(o).ok()) else {
        return false;
    };
    let Some(count) = int(ifd0, count_len) else {
        return false;
    };
    (0..count.min(4096) as usize).any(|i| {
        let at = ifd0 + count_len + i * entry_len;
        int(at, 2) == Some(DNG_VERSION)
    })
}

/// An ISO BMFF `ftyp` box whose major or a compatible brand is `avif`
/// (a still image) or `avis` (a sequence, read for its first frame).
fn is_avif(bytes: &[u8]) -> bool {
    if bytes.get(4..8) != Some(b"ftyp") {
        return false;
    }
    let Some(size) = bytes
        .get(..4)
        .map(|s| u32::from_be_bytes([s[0], s[1], s[2], s[3]]))
    else {
        return false;
    };
    let end = (size as usize).clamp(8, bytes.len().min(256));
    let brands = &bytes[8..end];
    // Major brand, minor version, then the compatible brands.
    brands
        .as_chunks::<4>()
        .0
        .iter()
        .enumerate()
        .filter(|(i, _)| *i != 1)
        .any(|(_, b)| b == b"avif" || b == b"avis")
}

/// TGA has no magic number. A version-2 file ends with the
/// `TRUEVISION-XFILE.` footer; an older one is accepted when its 18-byte
/// header is consistent: a colour-map type of 0 or 1, an image type TGA
/// defines, a pixel depth it allows, a non-zero size, and a colour map
/// exactly when the type is colour-mapped.
fn is_tga(bytes: &[u8]) -> bool {
    if bytes.len() >= 26 && bytes.ends_with(b"TRUEVISION-XFILE.\0") {
        return true;
    }
    let Some(h) = bytes.get(..18) else {
        return false;
    };
    let cmap_type = h[1];
    let image_type = h[2];
    let width = u16::from_le_bytes([h[12], h[13]]);
    let height = u16::from_le_bytes([h[14], h[15]]);
    let depth = h[16];
    let mapped = matches!(image_type, 1 | 9);
    matches!(image_type, 1 | 2 | 3 | 9 | 10 | 11)
        && cmap_type == u8::from(mapped)
        && matches!(depth, 8 | 15 | 16 | 24 | 32)
        && width > 0
        && height > 0
        && h[17] & 0xC0 == 0
        && (!mapped || matches!(h[7], 15 | 16 | 24 | 32))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn magic_numbers() {
        assert_eq!(sniff(b"II*\0rest"), Some(Format::Tiff));
        assert_eq!(sniff(b"MM\0*rest"), Some(Format::Tiff));
        assert_eq!(sniff(b"II+\0\x08\0\0\0"), Some(Format::Tiff));
        assert_eq!(sniff(b"MM\0+\0\x08\0\0"), Some(Format::Tiff));
        assert_eq!(sniff(b"8BPS\0\x01"), Some(Format::Psd));
        assert_eq!(sniff(b"\x89PNG\r\n\x1a\n"), Some(Format::Png));
        assert_eq!(sniff(b"\xFF\xD8\xFF\xE0"), Some(Format::Jpeg));
        assert_eq!(sniff(b"GIF89a"), Some(Format::Gif));
        assert_eq!(sniff(b"RIFF\0\0\0\0WEBPVP8 "), Some(Format::WebP));
        assert_eq!(sniff(b"BM\0\0\0\0\0\0\0\0\0\0\0\0"), Some(Format::Bmp));
        assert_eq!(sniff(b"%!PS-Adobe-3.0 EPSF-3.0"), Some(Format::Eps));
        assert_eq!(sniff(b"\xC5\xD0\xD3\xC6\x1e\0\0\0"), Some(Format::Eps));
        assert_eq!(sniff(b"\xFF\x0A\xfa"), Some(Format::Jxl));
        assert_eq!(
            sniff(b"\0\0\0\x0CJXL \r\n\x87\n\0\0\0\x14ftypjxl "),
            Some(Format::Jxl)
        );
        assert_eq!(
            sniff(b"\0\0\0\x1cftypavif\0\0\0\0avifmif1miaf"),
            Some(Format::Avif)
        );
        assert_eq!(
            sniff(b"\0\0\0\x18ftypmif1\0\0\0\0mif1avif"),
            Some(Format::Avif)
        );
        // A HEIC names `heic`, never `avif`.
        assert_eq!(sniff(b"\0\0\0\x18ftypheic\0\0\0\0mif1heic"), None);
        assert_eq!(sniff(b"qoif\0\0\0\x01"), Some(Format::Qoi));
        assert_eq!(sniff(b"v/1\x01\x02\0\0\0"), Some(Format::Exr));
        assert_eq!(
            sniff(b"#?RADIANCE\nFORMAT=32-bit_rle_rgbe"),
            Some(Format::Hdr)
        );
        let mut ico = vec![0u8, 0, 1, 0, 1, 0];
        ico.resize(22, 0);
        assert_eq!(sniff(&ico), Some(Format::Ico));
        // An uncompressed true-colour TGA header, 2x1 at 24 bits.
        let mut tga = vec![0u8, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 1, 0, 24, 0];
        tga.extend_from_slice(&[0; 6]);
        assert_eq!(sniff(&tga), Some(Format::Tga));
        tga[2] = 4;
        assert_eq!(sniff(&tga), None, "image type 4 is not TGA's");
        assert_eq!(sniff(b"II"), None);
    }

    /// A one-entry IFD0, little or big endian, classic or BigTIFF.
    fn tiff_with_tag(tag: u16, little: bool, big: bool) -> Vec<u8> {
        let mut b = Vec::new();
        let w16 = |b: &mut Vec<u8>, v: u16| {
            b.extend_from_slice(&if little {
                v.to_le_bytes()
            } else {
                v.to_be_bytes()
            })
        };
        b.extend_from_slice(if little { b"II" } else { b"MM" });
        if big {
            w16(&mut b, 43);
            w16(&mut b, 8);
            w16(&mut b, 0);
            let off = 16u64;
            b.extend_from_slice(&if little {
                off.to_le_bytes()
            } else {
                off.to_be_bytes()
            });
            let n = 1u64;
            b.extend_from_slice(&if little {
                n.to_le_bytes()
            } else {
                n.to_be_bytes()
            });
            w16(&mut b, tag);
            b.extend_from_slice(&[0; 18]);
        } else {
            w16(&mut b, 42);
            let off = 8u32;
            b.extend_from_slice(&if little {
                off.to_le_bytes()
            } else {
                off.to_be_bytes()
            });
            w16(&mut b, 1);
            w16(&mut b, tag);
            b.extend_from_slice(&[0; 10]);
        }
        b
    }

    #[test]
    fn a_dng_is_a_tiff_with_dng_version_in_ifd0() {
        for little in [true, false] {
            for big in [true, false] {
                assert_eq!(
                    sniff(&tiff_with_tag(50706, little, big)),
                    Some(Format::Dng),
                    "little {little} big {big}"
                );
                assert_eq!(
                    sniff(&tiff_with_tag(256, little, big)),
                    Some(Format::Tiff),
                    "little {little} big {big}"
                );
            }
        }
    }

    #[test]
    fn every_format_names_an_extension_and_a_media_type() {
        for f in [
            Format::Tiff,
            Format::Png,
            Format::Jpeg,
            Format::WebP,
            Format::Gif,
            Format::Bmp,
            Format::Psd,
            Format::Eps,
            Format::Dng,
            Format::Avif,
            Format::Jxl,
            Format::Tga,
            Format::Qoi,
            Format::Ico,
            Format::Hdr,
            Format::Exr,
        ] {
            assert!(!f.extension().is_empty());
            assert!(f.mime().contains('/'));
        }
    }
}
