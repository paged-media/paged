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

//! Picture formats (slide W4): what a picture's bytes are, how many pixels
//! they hold, and how PowerPoint carries them.
//!
//! The engine decodes every format `paged-raster` reads (and draws an SVG
//! as vectors), but a deck may only hold what PowerPoint opens: PNG, JPEG,
//! GIF, BMP and TIFF as `a:blip` parts, an SVG as an `asvg:svgBlip` beside
//! a PNG fallback. Everything else is written as a PNG of the picture. The
//! slide crates may not build on the engine's raster crates, so the format
//! is sniffed here by the same signatures `paged-sniff` uses, and only the
//! header is read.

/// A picture file's format.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PicFormat {
    Png,
    Jpeg,
    Gif,
    Bmp,
    Tiff,
    WebP,
    Svg,
    Ico,
    Psd,
    Tga,
    Qoi,
    Avif,
    Jxl,
    Hdr,
    Exr,
    Dng,
    Eps,
}

impl PicFormat {
    /// The file extension a part of this format is named with.
    pub fn extension(self) -> &'static str {
        match self {
            PicFormat::Png => "png",
            PicFormat::Jpeg => "jpeg",
            PicFormat::Gif => "gif",
            PicFormat::Bmp => "bmp",
            PicFormat::Tiff => "tiff",
            PicFormat::WebP => "webp",
            PicFormat::Svg => "svg",
            PicFormat::Ico => "ico",
            PicFormat::Psd => "psd",
            PicFormat::Tga => "tga",
            PicFormat::Qoi => "qoi",
            PicFormat::Avif => "avif",
            PicFormat::Jxl => "jxl",
            PicFormat::Hdr => "hdr",
            PicFormat::Exr => "exr",
            PicFormat::Dng => "dng",
            PicFormat::Eps => "eps",
        }
    }

    /// The media type (`[Content_Types].xml`, the file picker).
    pub fn mime(self) -> &'static str {
        match self {
            PicFormat::Png => "image/png",
            PicFormat::Jpeg => "image/jpeg",
            PicFormat::Gif => "image/gif",
            PicFormat::Bmp => "image/bmp",
            PicFormat::Tiff => "image/tiff",
            PicFormat::WebP => "image/webp",
            PicFormat::Svg => "image/svg+xml",
            PicFormat::Ico => "image/vnd.microsoft.icon",
            PicFormat::Psd => "image/vnd.adobe.photoshop",
            PicFormat::Tga => "image/x-tga",
            PicFormat::Qoi => "image/qoi",
            PicFormat::Avif => "image/avif",
            PicFormat::Jxl => "image/jxl",
            PicFormat::Hdr => "image/vnd.radiance",
            PicFormat::Exr => "image/x-exr",
            PicFormat::Dng => "image/x-adobe-dng",
            PicFormat::Eps => "application/postscript",
        }
    }

    /// PowerPoint opens a picture part of this format as it is.
    pub fn in_deck(self) -> bool {
        matches!(
            self,
            PicFormat::Png | PicFormat::Jpeg | PicFormat::Gif | PicFormat::Bmp | PicFormat::Tiff
        )
    }

    /// Every format, for the file picker.
    pub const ALL: [PicFormat; 17] = [
        PicFormat::Png,
        PicFormat::Jpeg,
        PicFormat::Gif,
        PicFormat::Bmp,
        PicFormat::Tiff,
        PicFormat::WebP,
        PicFormat::Svg,
        PicFormat::Ico,
        PicFormat::Psd,
        PicFormat::Tga,
        PicFormat::Qoi,
        PicFormat::Avif,
        PicFormat::Jxl,
        PicFormat::Hdr,
        PicFormat::Exr,
        PicFormat::Dng,
        PicFormat::Eps,
    ];
}

/// The content type of a picture part named with `ext`, for a `Default`
/// entry of `[Content_Types].xml`.
pub fn content_type_of_extension(ext: &str) -> Option<&'static str> {
    let ext = ext.to_ascii_lowercase();
    let ext = match ext.as_str() {
        "jpg" | "jpe" => "jpeg",
        "tif" => "tiff",
        e => e,
    };
    PicFormat::ALL
        .iter()
        .find(|f| f.extension() == ext)
        .map(|f| f.mime())
        .or(match ext {
            "emf" => Some("image/x-emf"),
            "wmf" => Some("image/x-wmf"),
            _ => None,
        })
}

fn be16(b: &[u8], at: usize) -> Option<u32> {
    Some(u16::from_be_bytes(b.get(at..at + 2)?.try_into().ok()?) as u32)
}
fn le16(b: &[u8], at: usize) -> Option<u32> {
    Some(u16::from_le_bytes(b.get(at..at + 2)?.try_into().ok()?) as u32)
}
fn be32(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_be_bytes(b.get(at..at + 4)?.try_into().ok()?))
}
fn le32(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(b.get(at..at + 4)?.try_into().ok()?))
}

/// What `bytes` are, by their signature.
pub fn sniff(b: &[u8]) -> Option<PicFormat> {
    if b.starts_with(&[0xFF, 0x0A]) || b.starts_with(b"\0\0\0\x0CJXL \r\n\x87\n") {
        return Some(PicFormat::Jxl);
    }
    let head = b.get(..4)?;
    match head {
        [b'I', b'I', 42 | 43, 0] | [b'M', b'M', 0, 42 | 43] => {
            return Some(if tiff_has_tag(b, 50706) {
                PicFormat::Dng
            } else {
                PicFormat::Tiff
            });
        }
        b"8BPS" => return Some(PicFormat::Psd),
        [0x89, b'P', b'N', b'G'] => return Some(PicFormat::Png),
        [0xFF, 0xD8, 0xFF, _] => return Some(PicFormat::Jpeg),
        b"GIF8" => return Some(PicFormat::Gif),
        [0xC5, 0xD0, 0xD3, 0xC6] | [b'%', b'!', b'P', b'S'] => return Some(PicFormat::Eps),
        b"qoif" => return Some(PicFormat::Qoi),
        [0x76, 0x2F, 0x31, 0x01] => return Some(PicFormat::Exr),
        [0, 0, 1, 0] if b.len() >= 22 && b[4..6] != [0, 0] => return Some(PicFormat::Ico),
        _ => {}
    }
    if b.len() >= 12 && &b[..4] == b"RIFF" && &b[8..12] == b"WEBP" {
        return Some(PicFormat::WebP);
    }
    if b.starts_with(b"BM") && b.len() >= 26 {
        return Some(PicFormat::Bmp);
    }
    if b.starts_with(b"#?RADIANCE") || b.starts_with(b"#?RGBE") {
        return Some(PicFormat::Hdr);
    }
    if b.get(4..8) == Some(b"ftyp") {
        let end = (be32(b, 0).unwrap_or(0) as usize).clamp(8, b.len().min(256));
        let brands = &b[8..end];
        if brands
            .as_chunks::<4>()
            .0
            .iter()
            .enumerate()
            .any(|(i, c)| i != 1 && (c == b"avif" || c == b"avis"))
        {
            return Some(PicFormat::Avif);
        }
    }
    if is_svg(b) {
        return Some(PicFormat::Svg);
    }
    if is_tga(b) {
        return Some(PicFormat::Tga);
    }
    None
}

/// An SVG document: text whose first element is `svg` (after an XML
/// declaration, comments and a doctype).
fn is_svg(b: &[u8]) -> bool {
    let head = &b[..b.len().min(4096)];
    let Ok(s) =
        std::str::from_utf8(head).or_else(|e| std::str::from_utf8(&head[..e.valid_up_to()]))
    else {
        return false;
    };
    let mut s = s.trim_start_matches('\u{feff}').trim_start();
    loop {
        if let Some(r) = s.strip_prefix("<?") {
            match r.find("?>") {
                Some(i) => s = r[i + 2..].trim_start(),
                None => return false,
            }
        } else if let Some(r) = s.strip_prefix("<!--") {
            match r.find("-->") {
                Some(i) => s = r[i + 3..].trim_start(),
                None => return false,
            }
        } else if let Some(r) = s.strip_prefix("<!") {
            match r.find('>') {
                Some(i) => s = r[i + 1..].trim_start(),
                None => return false,
            }
        } else {
            break;
        }
    }
    let Some(r) = s.strip_prefix('<') else {
        return false;
    };
    let name: String = r
        .chars()
        .take_while(|c| !c.is_whitespace() && *c != '>' && *c != '/')
        .collect();
    name == "svg" || name.ends_with(":svg")
}

/// TGA has no magic: the version-2 footer, or a consistent header.
fn is_tga(b: &[u8]) -> bool {
    if b.len() >= 26 && b.ends_with(b"TRUEVISION-XFILE.\0") {
        return true;
    }
    if b.len() < 18 {
        return false;
    }
    let (cmap, kind, depth) = (b[1], b[2], b[16]);
    let (w, h) = (le16(b, 12).unwrap_or(0), le16(b, 14).unwrap_or(0));
    cmap <= 1
        && matches!(kind, 1 | 2 | 3 | 9 | 10 | 11)
        && matches!(depth, 8 | 15 | 16 | 24 | 32)
        && w > 0
        && h > 0
        && (cmap == 1) == matches!(kind, 1 | 9)
}

/// The first IFD of a TIFF: its entries as (tag, value) for the integer
/// types, in the file's byte order.
fn tiff_entries(b: &[u8]) -> Vec<(u32, u32)> {
    let little = b.starts_with(b"II");
    let u16_at = |at: usize| if little { le16(b, at) } else { be16(b, at) };
    let u32_at = |at: usize| if little { le32(b, at) } else { be32(b, at) };
    if u16_at(2) != Some(42) {
        return Vec::new(); // BigTIFF: not read
    }
    let Some(ifd) = u32_at(4).map(|v| v as usize) else {
        return Vec::new();
    };
    let n = u16_at(ifd).unwrap_or(0) as usize;
    (0..n.min(4096))
        .filter_map(|i| {
            let at = ifd + 2 + i * 12;
            let tag = u16_at(at)?;
            let ty = u16_at(at + 2)?;
            let v = match ty {
                3 => u16_at(at + 8)?,
                4 => u32_at(at + 8)?,
                _ => 0,
            };
            Some((tag, v))
        })
        .collect()
}

fn tiff_has_tag(b: &[u8], tag: u32) -> bool {
    tiff_entries(b).iter().any(|(t, _)| *t == tag)
}

/// The picture's size in pixels, read from its header (an SVG's in CSS
/// pixels, from its `width` and `height` or its `viewBox`). `None` for a
/// format whose header is not read here (JPEG XL, OpenEXR) or one that does
/// not say.
pub fn pixel_size(b: &[u8]) -> Option<(u32, u32)> {
    let size = match sniff(b)? {
        PicFormat::Png => (be32(b, 16)?, be32(b, 20)?),
        PicFormat::Gif => (le16(b, 6)?, le16(b, 8)?),
        PicFormat::Jpeg => jpeg_size(b)?,
        PicFormat::Bmp => {
            if le32(b, 14)? == 12 {
                (le16(b, 18)?, le16(b, 20)?)
            } else {
                let w = le32(b, 18)? as i32;
                let h = le32(b, 22)? as i32;
                (w.unsigned_abs(), h.unsigned_abs())
            }
        }
        PicFormat::Tiff | PicFormat::Dng => {
            let e = tiff_entries(b);
            let get = |t| e.iter().find(|(tag, _)| *tag == t).map(|(_, v)| *v);
            (get(256)?, get(257)?)
        }
        PicFormat::WebP => match b.get(12..16)? {
            b"VP8 " => (le16(b, 26)? & 0x3fff, le16(b, 28)? & 0x3fff),
            b"VP8L" => {
                let v = le32(b, 21)?;
                ((v & 0x3fff) + 1, ((v >> 14) & 0x3fff) + 1)
            }
            b"VP8X" => {
                let w = le32(b, 24)? & 0xff_ffff;
                let h = le32(b, 27)? & 0xff_ffff;
                (w + 1, h + 1)
            }
            _ => return None,
        },
        PicFormat::Ico => {
            // The largest image the directory lists (0 means 256).
            let n = le16(b, 4)? as usize;
            (0..n)
                .filter_map(|i| {
                    let at = 6 + i * 16;
                    let w = *b.get(at)? as u32;
                    let h = *b.get(at + 1)? as u32;
                    Some((if w == 0 { 256 } else { w }, if h == 0 { 256 } else { h }))
                })
                .max_by_key(|(w, h)| w * h)?
        }
        PicFormat::Psd => (be32(b, 18)?, be32(b, 14)?),
        PicFormat::Qoi => (be32(b, 4)?, be32(b, 8)?),
        PicFormat::Tga => (le16(b, 12)?, le16(b, 14)?),
        PicFormat::Avif => {
            let i = b.windows(4).take(64 * 1024).position(|w| w == b"ispe")?;
            (be32(b, i + 8)?, be32(b, i + 12)?)
        }
        PicFormat::Hdr => {
            let head = std::str::from_utf8(&b[..b.len().min(2048)]).unwrap_or("");
            let line = head
                .split('\n')
                .find(|l| l.starts_with("-Y ") || l.starts_with("+Y "))?;
            let f: Vec<&str> = line.split_whitespace().collect();
            (f.get(3)?.parse().ok()?, f.get(1)?.parse().ok()?)
        }
        PicFormat::Eps => {
            // The bounding box, in points: a pixel per point.
            let head = String::from_utf8_lossy(&b[..b.len().min(64 * 1024)]);
            let line = head
                .lines()
                .find(|l| l.starts_with("%%BoundingBox:") && !l.contains("atend"))?;
            let v: Vec<f64> = line[14..]
                .split_whitespace()
                .filter_map(|x| x.parse().ok())
                .collect();
            if v.len() < 4 {
                return None;
            }
            (
                (v[2] - v[0]).abs().round() as u32,
                (v[3] - v[1]).abs().round() as u32,
            )
        }
        PicFormat::Svg => svg_size(b)?,
        PicFormat::Jxl | PicFormat::Exr => return None,
    };
    (size.0 > 0 && size.1 > 0).then_some(size)
}

fn jpeg_size(b: &[u8]) -> Option<(u32, u32)> {
    let mut i = 2;
    while i + 9 < b.len() {
        if b[i] != 0xff {
            i += 1;
            continue;
        }
        let marker = b[i + 1];
        if marker == 0xff || marker == 0x01 || (0xd0..=0xd8).contains(&marker) {
            i += if marker == 0xff { 1 } else { 2 };
            continue;
        }
        let len = be16(b, i + 2)? as usize;
        if (0xc0..=0xcf).contains(&marker) && !matches!(marker, 0xc4 | 0xc8 | 0xcc) {
            return Some((be16(b, i + 7)?, be16(b, i + 5)?));
        }
        i += 2 + len;
    }
    None
}

/// An SVG's size in CSS pixels (96 per inch), rounded up as the engine
/// rounds its raster: `width` and `height` in absolute units, else the
/// `viewBox`, else 300 × 150 (the CSS default replaced-element size).
fn svg_size(b: &[u8]) -> Option<(u32, u32)> {
    let head = String::from_utf8_lossy(&b[..b.len().min(64 * 1024)]);
    let start = head.find("<svg").or_else(|| head.find(":svg"))?;
    let end = head[start..].find('>')? + start;
    let tag = &head[start..end];
    let attr = |name: &str| -> Option<String> {
        let mut at = 0;
        while let Some(i) = tag[at..].find(name) {
            let p = at + i;
            let before = tag[..p].chars().last();
            let rest = tag[p + name.len()..].trim_start();
            if before.is_some_and(char::is_whitespace) {
                if let Some(r) = rest.strip_prefix('=') {
                    let r = r.trim_start();
                    let q = r.chars().next()?;
                    if q == '"' || q == '\'' {
                        let v = &r[1..];
                        return v.find(q).map(|e| v[..e].to_string());
                    }
                }
            }
            at = p + name.len();
        }
        None
    };
    let len = |v: &str| -> Option<f64> {
        let v = v.trim();
        let units: [(&str, f64); 7] = [
            ("px", 1.0),
            ("pt", 96.0 / 72.0),
            ("pc", 16.0),
            ("in", 96.0),
            ("cm", 96.0 / 2.54),
            ("mm", 96.0 / 25.4),
            ("", 1.0),
        ];
        if v.ends_with('%') || v.ends_with("em") || v.ends_with("ex") {
            return None;
        }
        for (u, k) in units {
            if let Some(n) = v.strip_suffix(u) {
                if let Ok(x) = n.trim().parse::<f64>() {
                    return Some(x * k);
                }
            }
        }
        None
    };
    let view: Option<(f64, f64)> = attr("viewBox").and_then(|v| {
        let n: Vec<f64> = v
            .split(|c: char| c == ',' || c.is_whitespace())
            .filter(|s| !s.is_empty())
            .filter_map(|s| s.parse().ok())
            .collect();
        (n.len() == 4 && n[2] > 0.0 && n[3] > 0.0).then(|| (n[2], n[3]))
    });
    let w = attr("width").and_then(|v| len(&v));
    let h = attr("height").and_then(|v| len(&v));
    let (w, h) = match (w, h, view) {
        (Some(w), Some(h), _) => (w, h),
        (Some(w), None, Some((vw, vh))) => (w, w * vh / vw),
        (None, Some(h), Some((vw, vh))) => (h * vw / vh, h),
        (None, None, Some(v)) => v,
        _ => (300.0, 150.0),
    };
    Some((w.ceil().max(1.0) as u32, h.ceil().max(1.0) as u32))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png(w: u32, h: u32) -> Vec<u8> {
        let mut b = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
        b.extend(w.to_be_bytes());
        b.extend(h.to_be_bytes());
        b.extend([8, 6, 0, 0, 0]);
        b
    }

    #[test]
    fn formats_are_sniffed_and_sized() {
        assert_eq!(sniff(&png(3, 2)), Some(PicFormat::Png));
        assert_eq!(pixel_size(&png(3, 2)), Some((3, 2)));
        let gif = b"GIF89a\x05\0\x04\0\x80\0\0".to_vec();
        assert_eq!(pixel_size(&gif), Some((5, 4)));
        let mut bmp = vec![0u8; 54];
        bmp[..2].copy_from_slice(b"BM");
        bmp[14..18].copy_from_slice(&40u32.to_le_bytes());
        bmp[18..22].copy_from_slice(&7i32.to_le_bytes());
        bmp[22..26].copy_from_slice(&(-3i32).to_le_bytes());
        assert_eq!(sniff(&bmp), Some(PicFormat::Bmp));
        assert_eq!(pixel_size(&bmp), Some((7, 3)));
        let mut psd = b"8BPS\0\x01\0\0\0\0\0\0\0\x03".to_vec();
        psd.extend(9u32.to_be_bytes()); // height
        psd.extend(11u32.to_be_bytes()); // width
        assert_eq!(pixel_size(&psd), Some((11, 9)));
        let mut qoi = b"qoif".to_vec();
        qoi.extend(4u32.to_be_bytes());
        qoi.extend(6u32.to_be_bytes());
        assert_eq!(pixel_size(&qoi), Some((4, 6)));
        let mut tga = vec![0u8; 18];
        tga[2] = 2;
        tga[12] = 5;
        tga[14] = 2;
        tga[16] = 24;
        assert_eq!(sniff(&tga), Some(PicFormat::Tga));
        assert_eq!(pixel_size(&tga), Some((5, 2)));
        assert_eq!(
            sniff(b"#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 2 +X 3\n"),
            Some(PicFormat::Hdr)
        );
        assert_eq!(
            pixel_size(b"#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 2 +X 3\n"),
            Some((3, 2))
        );
        // A classic little-endian TIFF with ImageWidth and ImageLength.
        let mut tif = b"II*\0\x08\0\0\0".to_vec();
        tif.extend(2u16.to_le_bytes());
        tif.extend([0, 1, 3, 0, 1, 0, 0, 0, 12, 0, 0, 0]);
        tif.extend([1, 1, 4, 0, 1, 0, 0, 0, 13, 0, 0, 0]);
        assert_eq!(sniff(&tif), Some(PicFormat::Tiff));
        assert_eq!(pixel_size(&tif), Some((12, 13)));
        let webp =
            b"RIFF\x1a\0\0\0WEBPVP8L\x0d\0\0\0\x2f\0\0\0\x10\x07\x10\x11\x11\x88\x88\xfe\x07\0";
        assert_eq!(pixel_size(webp), Some((1, 1)));
    }

    #[test]
    fn an_svg_is_sized_in_css_pixels() {
        let s = |x: &str| pixel_size(x.as_bytes());
        assert_eq!(
            s(r#"<svg xmlns="http://www.w3.org/2000/svg" width="48" height="24"/>"#),
            Some((48, 24))
        );
        assert_eq!(
            s(
                r#"<?xml version="1.0"?><!-- icon --><svg viewBox="0 0 96 48" xmlns="http://www.w3.org/2000/svg"></svg>"#
            ),
            Some((96, 48))
        );
        assert_eq!(s(r#"<svg width="1in" viewBox="0 0 2 1"/>"#), Some((96, 48)));
        assert_eq!(s(r#"<svg width="100%" height="100%"/>"#), Some((300, 150)));
        assert_eq!(sniff(b"<html><svg/></html>"), None);
    }

    #[test]
    fn deck_formats_and_content_types() {
        assert!(
            PicFormat::Tiff.in_deck() && !PicFormat::WebP.in_deck() && !PicFormat::Svg.in_deck()
        );
        assert_eq!(content_type_of_extension("svg"), Some("image/svg+xml"));
        assert_eq!(content_type_of_extension("JPG"), Some("image/jpeg"));
        assert_eq!(content_type_of_extension("tif"), Some("image/tiff"));
        assert_eq!(content_type_of_extension("bmp"), Some("image/bmp"));
        assert_eq!(content_type_of_extension("xml"), None);
    }
}
