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

//! Format sniffing from the first bytes.

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
}

/// The format the bytes start with, if any.
pub fn sniff(bytes: &[u8]) -> Option<Format> {
    let head = |n: usize| bytes.get(..n);
    match head(4)? {
        [b'I', b'I', 42 | 43, 0] | [b'M', b'M', 0, 42 | 43] => return Some(Format::Tiff),
        b"8BPS" => return Some(Format::Psd),
        [0x89, b'P', b'N', b'G'] => return Some(Format::Png),
        [0xFF, 0xD8, 0xFF, _] => return Some(Format::Jpeg),
        b"GIF8" => return Some(Format::Gif),
        _ => {}
    }
    if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some(Format::WebP);
    }
    if bytes.starts_with(b"BM") && bytes.len() >= 14 {
        return Some(Format::Bmp);
    }
    None
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
        assert_eq!(sniff(b"%!PS-Adobe"), None);
        assert_eq!(sniff(b"II"), None);
    }
}
