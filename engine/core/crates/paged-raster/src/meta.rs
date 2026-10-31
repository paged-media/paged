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

//! Embedded metadata: read from a file's headers, written back by the
//! encoders.
//!
//! [`read_metadata`] collects what a file carries besides its pixels: the
//! ICC profile, the EXIF payload (from its TIFF header on, the way a JPEG
//! APP1 or a PNG `eXIf` chunk stores it), the XMP packet, the IPTC-NAA
//! record and the Photoshop image resource blocks. The encoders take the
//! same [`Metadata`] back (`crate::EncodeOptions`), so an edit can keep
//! what the source said about itself.

use crate::{probe, sniff, Format};

/// What a raster file says about itself besides its pixels. Every field
/// is the raw payload as the formats store it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Metadata {
    /// The ICC profile.
    pub icc: Option<Vec<u8>>,
    /// The EXIF payload, starting at its TIFF header (`II*\0` / `MM\0*`).
    pub exif: Option<Vec<u8>>,
    /// The XMP packet (UTF-8 XML).
    pub xmp: Option<Vec<u8>>,
    /// The IPTC-NAA record (IIM datasets).
    pub iptc: Option<Vec<u8>>,
    /// Photoshop image resource blocks (`8BIM` records).
    pub photoshop_irb: Option<Vec<u8>>,
}

impl Metadata {
    /// Nothing at all.
    pub fn is_empty(&self) -> bool {
        self.icc.is_none()
            && self.exif.is_none()
            && self.xmp.is_none()
            && self.iptc.is_none()
            && self.photoshop_irb.is_none()
    }

    /// The same metadata without the ICC profile (an encoder is told the
    /// profile separately, because the pixels it writes may no longer be
    /// in the source's space).
    pub fn without_icc(&self) -> Metadata {
        Metadata {
            icc: None,
            ..self.clone()
        }
    }
}

/// The metadata a file carries. JPEG (APP1 EXIF and XMP, APP2 ICC, APP13
/// Photoshop resources with IPTC), PNG (`iCCP`, `eXIf`, the XMP `iTXt`),
/// WebP (`ICCP`, `EXIF`, `XMP `), TIFF and PSD (their tags and resources)
/// and the formats `probe` reads. Unreadable parts are left out; this
/// never fails.
pub fn read_metadata(bytes: &[u8]) -> Metadata {
    match sniff(bytes) {
        Some(Format::Jpeg) => jpeg_metadata(bytes),
        Some(Format::Png) => png_metadata(bytes),
        Some(Format::WebP) => webp_metadata(bytes),
        Some(_) => match probe(bytes) {
            Ok(info) => Metadata {
                icc: info.icc,
                exif: info.exif,
                xmp: info.xmp,
                iptc: info.iptc,
                photoshop_irb: info.photoshop_irb,
            },
            Err(_) => Metadata::default(),
        },
        None => Metadata::default(),
    }
}

/// The ICC profile of any format [`read_metadata`] reads (JPEG, PNG,
/// WebP, TIFF, PSD, ...), `None` when it has none.
pub fn extract_icc_any(bytes: &[u8]) -> Option<Vec<u8>> {
    read_metadata(bytes).icc
}

// ── JPEG ───────────────────────────────────────────────────────────────

const EXIF_ID: &[u8] = b"Exif\0\0";
pub(crate) const XMP_ID: &[u8] = b"http://ns.adobe.com/xap/1.0/\0";
pub(crate) const PHOTOSHOP_ID: &[u8] = b"Photoshop 3.0\0";

/// One marker segment before the scan: its marker byte, its payload
/// (after the length) and where the whole segment ends.
pub(crate) struct Segment<'b> {
    pub marker: u8,
    pub payload: &'b [u8],
    pub end: usize,
}

/// The marker segments of a JPEG up to (not including) the first SOS.
pub(crate) fn jpeg_segments(bytes: &[u8]) -> Vec<Segment<'_>> {
    let mut out = Vec::new();
    if !bytes.starts_with(&[0xFF, 0xD8]) {
        return out;
    }
    let mut i = 2usize;
    while i + 4 <= bytes.len() {
        if bytes[i] != 0xFF {
            break;
        }
        let marker = bytes[i + 1];
        if marker == 0xFF {
            // Fill byte.
            i += 1;
            continue;
        }
        if (0xD0..=0xD9).contains(&marker) || marker == 0x01 {
            i += 2;
            continue;
        }
        if marker == 0xDA {
            break;
        }
        let len = usize::from(u16::from_be_bytes([bytes[i + 2], bytes[i + 3]]));
        if len < 2 || i + 2 + len > bytes.len() {
            break;
        }
        out.push(Segment {
            marker,
            payload: &bytes[i + 4..i + 2 + len],
            end: i + 2 + len,
        });
        i += 2 + len;
    }
    out
}

fn jpeg_metadata(bytes: &[u8]) -> Metadata {
    let mut m = Metadata {
        icc: crate::icc::extract_icc(bytes),
        ..Metadata::default()
    };
    for seg in jpeg_segments(bytes) {
        match seg.marker {
            0xE1 if seg.payload.starts_with(EXIF_ID) && m.exif.is_none() => {
                m.exif = Some(seg.payload[EXIF_ID.len()..].to_vec());
            }
            0xE1 if seg.payload.starts_with(XMP_ID) && m.xmp.is_none() => {
                m.xmp = Some(seg.payload[XMP_ID.len()..].to_vec());
            }
            0xED if seg.payload.starts_with(PHOTOSHOP_ID) => {
                let irb = &seg.payload[PHOTOSHOP_ID.len()..];
                m.photoshop_irb
                    .get_or_insert_with(Vec::new)
                    .extend_from_slice(irb);
            }
            _ => {}
        }
    }
    m.iptc = m.photoshop_irb.as_deref().and_then(iptc_from_irb);
    m
}

/// The resolution a JPEG declares: the JFIF density (dots per inch or
/// per centimetre), else EXIF's X/YResolution.
pub(crate) fn jpeg_ppi(bytes: &[u8], exif: Option<&[u8]>) -> Option<(f64, f64)> {
    for seg in jpeg_segments(bytes) {
        let p = seg.payload;
        if seg.marker == 0xE0 && p.starts_with(b"JFIF\0") && p.len() >= 12 {
            let unit = p[7];
            let x = f64::from(u16::from_be_bytes([p[8], p[9]]));
            let y = f64::from(u16::from_be_bytes([p[10], p[11]]));
            let k = match unit {
                1 => 1.0,
                2 => 2.54,
                _ => continue,
            };
            if x > 0.0 && y > 0.0 {
                return Some((x * k, y * k));
            }
        }
    }
    let e = crate::exif::Exif::parse(exif?);
    Some((f64::from(e.dpi_x?), f64::from(e.dpi_y?)))
}

/// The IPTC-NAA record inside Photoshop image resources (resource 0x0404).
pub(crate) fn iptc_from_irb(irb: &[u8]) -> Option<Vec<u8>> {
    let mut i = 0usize;
    while i + 12 <= irb.len() {
        if &irb[i..i + 4] != b"8BIM" {
            return None;
        }
        let id = u16::from_be_bytes([irb[i + 4], irb[i + 5]]);
        // Pascal name, padded to an even length (count byte included).
        let name_len = usize::from(irb[i + 6]);
        let mut j = i + 6 + 1 + name_len;
        j += j.saturating_sub(i + 6) % 2;
        let size = u32::from_be_bytes(irb.get(j..j + 4)?.try_into().ok()?) as usize;
        let data = irb.get(j + 4..j + 4 + size)?;
        if id == 0x0404 {
            return Some(data.to_vec());
        }
        i = j + 4 + size + size % 2;
    }
    None
}

/// One Photoshop image resource block holding an IPTC-NAA record.
pub(crate) fn irb_with_iptc(iptc: &[u8]) -> Vec<u8> {
    let mut b = Vec::with_capacity(iptc.len() + 14);
    b.extend_from_slice(b"8BIM");
    b.extend_from_slice(&0x0404u16.to_be_bytes());
    b.extend_from_slice(&[0, 0]); // empty name, padded
    b.extend_from_slice(&(iptc.len() as u32).to_be_bytes());
    b.extend_from_slice(iptc);
    if iptc.len() % 2 == 1 {
        b.push(0);
    }
    b
}

// ── PNG ────────────────────────────────────────────────────────────────

/// The chunks of a PNG: type and data, in file order.
pub(crate) fn png_chunks(bytes: &[u8]) -> Vec<([u8; 4], &[u8], usize)> {
    let mut out = Vec::new();
    let mut i = 8usize;
    while i + 12 <= bytes.len() {
        let len = u32::from_be_bytes([bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]]) as usize;
        let Some(data) = bytes.get(i + 8..i + 8 + len) else {
            break;
        };
        let kind = [bytes[i + 4], bytes[i + 5], bytes[i + 6], bytes[i + 7]];
        out.push((kind, data, i));
        if &kind == b"IEND" {
            break;
        }
        i += 12 + len;
    }
    out
}

const XMP_KEYWORD: &[u8] = b"XML:com.adobe.xmp";

fn png_metadata(bytes: &[u8]) -> Metadata {
    let mut m = Metadata {
        icc: crate::icc::extract_icc(bytes),
        ..Metadata::default()
    };
    for (kind, data, _) in png_chunks(bytes) {
        match &kind {
            b"eXIf" => m.exif = Some(data.to_vec()),
            b"iTXt" if data.starts_with(XMP_KEYWORD) && data.get(XMP_KEYWORD.len()) == Some(&0) => {
                m.xmp = itxt_text(&data[XMP_KEYWORD.len() + 1..]);
            }
            _ => {}
        }
    }
    m
}

/// An iTXt chunk's text after its keyword: compression flag and method,
/// language tag, translated keyword, then the (possibly deflated) text.
fn itxt_text(rest: &[u8]) -> Option<Vec<u8>> {
    let (&flag, rest) = rest.split_first()?;
    let (_method, rest) = rest.split_first()?;
    let lang_end = rest.iter().position(|&b| b == 0)?;
    let rest = &rest[lang_end + 1..];
    let tk_end = rest.iter().position(|&b| b == 0)?;
    let text = &rest[tk_end + 1..];
    if flag == 0 {
        return Some(text.to_vec());
    }
    let mut out = Vec::new();
    use std::io::Read as _;
    flate2::read::ZlibDecoder::new(text)
        .read_to_end(&mut out)
        .ok()?;
    Some(out)
}

/// The resolution a PNG's `pHYs` chunk declares (unit: metre).
pub(crate) fn png_ppi(bytes: &[u8]) -> Option<(f64, f64)> {
    png_chunks(bytes).into_iter().find_map(|(kind, d, _)| {
        if &kind != b"pHYs" || d.len() < 9 || d[8] != 1 {
            return None;
        }
        let x = f64::from(u32::from_be_bytes([d[0], d[1], d[2], d[3]]));
        let y = f64::from(u32::from_be_bytes([d[4], d[5], d[6], d[7]]));
        (x > 0.0 && y > 0.0).then_some((x * 0.0254, y * 0.0254))
    })
}

/// One PNG chunk, length and CRC included.
pub(crate) fn png_chunk(kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
    let mut c = Vec::with_capacity(data.len() + 12);
    c.extend_from_slice(&(data.len() as u32).to_be_bytes());
    c.extend_from_slice(kind);
    c.extend_from_slice(data);
    let mut crc = flate2::Crc::new();
    crc.update(kind);
    crc.update(data);
    c.extend_from_slice(&crc.sum().to_be_bytes());
    c
}

/// An uncompressed iTXt chunk with the XMP keyword.
pub(crate) fn png_xmp_chunk(xmp: &[u8]) -> Vec<u8> {
    let mut d = Vec::with_capacity(xmp.len() + XMP_KEYWORD.len() + 5);
    d.extend_from_slice(XMP_KEYWORD);
    d.extend_from_slice(&[0, 0, 0, 0, 0]); // NUL, uncompressed, method, empty lang, empty key
    d.extend_from_slice(xmp);
    png_chunk(b"iTXt", &d)
}

// ── WebP ───────────────────────────────────────────────────────────────

fn webp_metadata(bytes: &[u8]) -> Metadata {
    let mut m = Metadata::default();
    let mut i = 12usize;
    while i + 8 <= bytes.len() {
        let kind = &bytes[i..i + 4];
        let len =
            u32::from_le_bytes([bytes[i + 4], bytes[i + 5], bytes[i + 6], bytes[i + 7]]) as usize;
        let Some(data) = bytes.get(i + 8..i + 8 + len) else {
            break;
        };
        match kind {
            b"ICCP" => m.icc = Some(data.to_vec()),
            b"EXIF" => {
                // Some writers keep JPEG's `Exif\0\0` prefix.
                let d = data.strip_prefix(EXIF_ID).unwrap_or(data);
                m.exif = Some(d.to_vec());
            }
            b"XMP " => m.xmp = Some(data.to_vec()),
            _ => {}
        }
        i += 8 + len + len % 2;
    }
    m
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn irb_round_trips_an_iptc_record() {
        for iptc in [&b"\x1c\x02\x05\0\x03abc"[..], &b"\x1c\x02\x05\0\x02ab"[..]] {
            let irb = irb_with_iptc(iptc);
            assert_eq!(iptc_from_irb(&irb).as_deref(), Some(iptc));
            let mut two = b"8BIM\x03\xed\0\0\0\0\0\x02xy".to_vec();
            two.extend_from_slice(&irb);
            assert_eq!(iptc_from_irb(&two).as_deref(), Some(iptc));
        }
    }

    #[test]
    fn png_chunks_carry_a_valid_crc() {
        // IEND's CRC is the well-known AE 42 60 82.
        assert_eq!(
            png_chunk(b"IEND", &[]),
            [0, 0, 0, 0, b'I', b'E', b'N', b'D', 0xAE, 0x42, 0x60, 0x82]
        );
    }
}
