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

//! Embedded ICC profiles, read from the headers only.

use crate::sniff::{sniff, Format};

/// The ICC profile embedded in a JPEG (APP2 `ICC_PROFILE` segments,
/// reassembled in chunk order), a PNG (`iCCP`, inflated) or a TIFF (tag
/// 34675 of the first page). No pixel decode.
pub fn extract_icc(bytes: &[u8]) -> Option<Vec<u8>> {
    match sniff(bytes)? {
        Format::Jpeg => jpeg_icc(bytes),
        Format::Png => png_icc(bytes),
        Format::Tiff => crate::tif::icc(bytes),
        _ => None,
    }
}

fn jpeg_icc(bytes: &[u8]) -> Option<Vec<u8>> {
    const MARKER: &[u8] = b"ICC_PROFILE\0";
    let mut chunks: Vec<(u8, &[u8])> = Vec::new();
    let mut i = 2usize;
    while i + 4 <= bytes.len() {
        if bytes[i] != 0xFF {
            break;
        }
        let marker = bytes[i + 1];
        // Standalone markers without length.
        if (0xD0..=0xD9).contains(&marker) || marker == 0x01 {
            i += 2;
            continue;
        }
        let len = u16::from_be_bytes([bytes[i + 2], bytes[i + 3]]) as usize;
        if len < 2 || i + 2 + len > bytes.len() {
            break;
        }
        let seg = &bytes[i + 4..i + 2 + len];
        if marker == 0xE2 && seg.len() > MARKER.len() + 2 && seg.starts_with(MARKER) {
            let seq = seg[MARKER.len()];
            let data = &seg[MARKER.len() + 2..];
            chunks.push((seq, data));
        }
        // Stop at start-of-scan: APP segments precede it.
        if marker == 0xDA {
            break;
        }
        i += 2 + len;
    }
    if chunks.is_empty() {
        return None;
    }
    chunks.sort_by_key(|(seq, _)| *seq);
    let total: usize = chunks.iter().map(|(_, d)| d.len()).sum();
    let mut icc = Vec::with_capacity(total);
    for (_, d) in chunks {
        icc.extend_from_slice(d);
    }
    Some(icc)
}

fn png_icc(bytes: &[u8]) -> Option<Vec<u8>> {
    let mut i = 8usize;
    while i + 8 <= bytes.len() {
        let len = u32::from_be_bytes(bytes[i..i + 4].try_into().ok()?) as usize;
        let kind = &bytes[i + 4..i + 8];
        if kind == b"iCCP" {
            let data = bytes.get(i + 8..i + 8 + len)?;
            // profile name (latin1, NUL-terminated) + compression
            // method byte (0 = zlib) + compressed profile.
            let nul = data.iter().position(|b| *b == 0)?;
            let method = *data.get(nul + 1)?;
            if method != 0 {
                return None;
            }
            let compressed = data.get(nul + 2..)?;
            let mut out = Vec::new();
            let mut dec = flate2::read::ZlibDecoder::new(compressed);
            use std::io::Read as _;
            dec.read_to_end(&mut out).ok()?;
            return Some(out);
        }
        if kind == b"IDAT" || kind == b"IEND" {
            break;
        }
        i += 12 + len; // length + type + data + crc
    }
    None
}
