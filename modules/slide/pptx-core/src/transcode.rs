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

//! Pictures PowerPoint cannot open, written as PNG (slide W4, ADR 723).
//!
//! A deck holds PNG, JPEG, GIF, BMP and TIFF as they are (and an SVG beside
//! a PNG fallback). A WebP, TGA, ICO or QOI picture is decoded here and
//! written as a PNG of all its pixels, so its crop stays a crop and the
//! export does not depend on the host rendering the frame. The other
//! formats (PSD, AVIF, JPEG XL, HDR, OpenEXR, DNG, EPS) need the engine's
//! raster decoders, which the slide crates may not build on: the host
//! renders those frames.
//!
//! [`png_rgba`] and [`png_indexed`] are the one PNG writer of the slide
//! crates: these transcodes and the pattern tiles of `slide-native`.

use std::io::Write;

use crate::media::{sniff, PicFormat};

/// Decoded pixels: `w × h`, RGBA, 8 bits a channel, rows top down.
#[derive(Debug, Clone, PartialEq)]
pub struct Rgba {
    pub w: u32,
    pub h: u32,
    pub px: Vec<u8>,
}

/// The largest picture decoded here, in pixels (64 Mpx: a 256 MiB buffer).
const MAX_PIXELS: u64 = 64 << 20;

fn fits(w: u32, h: u32) -> bool {
    w > 0 && h > 0 && (w as u64) * (h as u64) <= MAX_PIXELS
}

/// `bytes` as a PNG when they are a WebP, TGA, ICO or QOI picture this
/// module reads; `None` for any other format or a file it cannot read.
/// An ICO entry that is already a PNG is returned as it is.
pub fn to_png(bytes: &[u8]) -> Option<Vec<u8>> {
    match sniff(bytes)? {
        PicFormat::Ico => {
            let entry = ico_entry(bytes)?;
            if entry.starts_with(b"\x89PNG\r\n\x1a\n") {
                return Some(entry.to_vec());
            }
            encode(&dib(entry)?)
        }
        PicFormat::WebP => encode(&webp(bytes)?),
        PicFormat::Tga => encode(&tga(bytes)?),
        PicFormat::Qoi => encode(&qoi(bytes)?),
        _ => None,
    }
}

/// The formats [`to_png`] reads.
pub fn transcodes(format: PicFormat) -> bool {
    matches!(
        format,
        PicFormat::WebP | PicFormat::Tga | PicFormat::Ico | PicFormat::Qoi
    )
}

fn encode(img: &Rgba) -> Option<Vec<u8>> {
    Some(png_rgba(img.w, img.h, &img.px))
}

// ── PNG ──────────────────────────────────────────────────────────────────

fn crc32(chunks: &[&[u8]]) -> u32 {
    static TABLE: std::sync::OnceLock<[u32; 256]> = std::sync::OnceLock::new();
    let t = TABLE.get_or_init(|| {
        let mut t = [0u32; 256];
        for (n, slot) in t.iter_mut().enumerate() {
            let mut c = n as u32;
            for _ in 0..8 {
                c = if c & 1 != 0 {
                    0xEDB8_8320 ^ (c >> 1)
                } else {
                    c >> 1
                };
            }
            *slot = c;
        }
        t
    });
    let mut c = 0xFFFF_FFFFu32;
    for b in chunks.iter().flat_map(|c| c.iter()) {
        c = t[((c ^ *b as u32) & 0xFF) as usize] ^ (c >> 8);
    }
    c ^ 0xFFFF_FFFF
}

fn chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    out.extend_from_slice(kind);
    out.extend_from_slice(data);
    out.extend_from_slice(&crc32(&[kind, data]).to_be_bytes());
}

/// A PNG of `rows` (each `stride` bytes, filtered as type 0) with the
/// header fields given.
fn png(
    w: u32,
    h: u32,
    depth: u8,
    color: u8,
    extra: &[(&[u8; 4], Vec<u8>)],
    rows: &[u8],
) -> Vec<u8> {
    let stride = rows.len() / h.max(1) as usize;
    let mut raw = Vec::with_capacity(rows.len() + h as usize);
    for r in rows.chunks(stride.max(1)) {
        raw.push(0);
        raw.extend_from_slice(r);
    }
    let mut z = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
    // Writing into a Vec cannot fail.
    let _ = z.write_all(&raw);
    let idat = z.finish().unwrap_or_default();
    let mut ihdr = Vec::with_capacity(13);
    ihdr.extend_from_slice(&w.to_be_bytes());
    ihdr.extend_from_slice(&h.to_be_bytes());
    ihdr.extend_from_slice(&[depth, color, 0, 0, 0]);
    let mut out = b"\x89PNG\r\n\x1a\n".to_vec();
    chunk(&mut out, b"IHDR", &ihdr);
    for (k, d) in extra {
        chunk(&mut out, k, d);
    }
    chunk(&mut out, b"IDAT", &idat);
    chunk(&mut out, b"IEND", &[]);
    out
}

/// A PNG of `w × h` RGBA pixels (8 bits a channel, rows top down); RGB
/// when every pixel is opaque.
pub fn png_rgba(w: u32, h: u32, px: &[u8]) -> Vec<u8> {
    let (quads, _) = px.as_chunks::<4>();
    if quads.iter().all(|p| p[3] == 255) {
        let rgb: Vec<u8> = quads.iter().flat_map(|p| [p[0], p[1], p[2]]).collect();
        return png(w, h, 8, 2, &[], &rgb);
    }
    png(w, h, 8, 6, &[], px)
}

/// A PNG of `w × h` palette indices (one byte a pixel, rows top down) into
/// `palette` (RGBA; alpha goes to the `tRNS` chunk when not all opaque).
pub fn png_indexed(w: u32, h: u32, palette: &[[u8; 4]], idx: &[u8]) -> Vec<u8> {
    let plte: Vec<u8> = palette.iter().flat_map(|c| [c[0], c[1], c[2]]).collect();
    let mut extra = vec![(b"PLTE", plte)];
    if palette.iter().any(|c| c[3] != 255) {
        extra.push((b"tRNS", palette.iter().map(|c| c[3]).collect()));
    }
    png(w, h, 8, 3, &extra, idx)
}

// ── WebP ─────────────────────────────────────────────────────────────────

fn webp(b: &[u8]) -> Option<Rgba> {
    let mut d = image_webp::WebPDecoder::new(std::io::Cursor::new(b)).ok()?;
    let (w, h) = d.dimensions();
    if !fits(w, h) {
        return None;
    }
    let mut buf = vec![0u8; d.output_buffer_size()?];
    d.read_image(&mut buf).ok()?;
    let px = if d.has_alpha() {
        buf
    } else {
        buf.as_chunks::<3>()
            .0
            .iter()
            .flat_map(|p| [p[0], p[1], p[2], 255])
            .collect()
    };
    Some(Rgba { w, h, px })
}

// ── TGA ──────────────────────────────────────────────────────────────────

/// A Truevision TGA: colour-mapped, true-colour or grey, plain or
/// run-length encoded, 8 to 32 bits, any origin.
fn tga(b: &[u8]) -> Option<Rgba> {
    let id_len = *b.first()? as usize;
    let (cmap_type, kind) = (*b.get(1)?, *b.get(2)?);
    let cmap_first = u16::from_le_bytes([*b.get(3)?, *b.get(4)?]) as usize;
    let cmap_len = u16::from_le_bytes([*b.get(5)?, *b.get(6)?]) as usize;
    let cmap_depth = *b.get(7)?;
    let w = u16::from_le_bytes([*b.get(12)?, *b.get(13)?]) as u32;
    let h = u16::from_le_bytes([*b.get(14)?, *b.get(15)?]) as u32;
    let depth = *b.get(16)?;
    let desc = *b.get(17)?;
    if !fits(w, h) {
        return None;
    }
    let alpha_bits = desc & 0x0F;
    let mut at = 18 + id_len;
    let mut cmap: Vec<[u8; 4]> = Vec::new();
    if cmap_type == 1 {
        let eb = (cmap_depth as usize).div_ceil(8);
        for i in 0..cmap_len {
            let e = b.get(at + i * eb..at + (i + 1) * eb)?;
            cmap.push(tga_pixel(e, cmap_depth, alpha_bits)?);
        }
        at += cmap_len * eb;
    }
    let bpp = (depth as usize).div_ceil(8);
    let n = (w * h) as usize;
    let rle = kind >= 9;
    let base = kind & 7;
    let mut raw: Vec<u8> = Vec::with_capacity(n * bpp);
    if rle {
        while raw.len() < n * bpp {
            let head = *b.get(at)?;
            at += 1;
            let count = (head & 0x7F) as usize + 1;
            if head & 0x80 != 0 {
                let p = b.get(at..at + bpp)?;
                at += bpp;
                for _ in 0..count {
                    raw.extend_from_slice(p);
                }
            } else {
                raw.extend_from_slice(b.get(at..at + count * bpp)?);
                at += count * bpp;
            }
        }
        raw.truncate(n * bpp);
    } else {
        raw.extend_from_slice(b.get(at..at + n * bpp)?);
    }
    let mut px = vec![0u8; n * 4];
    let top_down = desc & 0x20 != 0;
    let right_left = desc & 0x10 != 0;
    for (i, p) in raw.chunks_exact(bpp).enumerate() {
        let (x, y) = ((i as u32) % w, (i as u32) / w);
        let x = if right_left { w - 1 - x } else { x };
        let y = if top_down { y } else { h - 1 - y };
        let c = match base {
            1 => {
                let k = if bpp == 1 {
                    p[0] as usize
                } else {
                    u16::from_le_bytes([p[0], p[1]]) as usize
                };
                *cmap.get(k.checked_sub(cmap_first)?)?
            }
            3 => [p[0], p[0], p[0], if bpp == 2 { p[1] } else { 255 }],
            _ => tga_pixel(p, depth, alpha_bits)?,
        };
        let o = ((y * w + x) * 4) as usize;
        px[o..o + 4].copy_from_slice(&c);
    }
    Some(Rgba { w, h, px })
}

/// One BGR(A) TGA pixel (or colour-map entry) as RGBA.
fn tga_pixel(p: &[u8], depth: u8, alpha_bits: u8) -> Option<[u8; 4]> {
    Some(match depth {
        15 | 16 => {
            let v = u16::from_le_bytes([*p.first()?, *p.get(1)?]);
            let c = |s: u16| (((v >> s) & 0x1F) as u32 * 255 / 31) as u8;
            let a = if depth == 16 && alpha_bits > 0 && v & 0x8000 == 0 {
                0
            } else {
                255
            };
            [c(10), c(5), c(0), a]
        }
        24 => [*p.get(2)?, *p.get(1)?, *p.first()?, 255],
        32 => [
            *p.get(2)?,
            *p.get(1)?,
            *p.first()?,
            if alpha_bits > 0 { *p.get(3)? } else { 255 },
        ],
        _ => return None,
    })
}

// ── ICO ──────────────────────────────────────────────────────────────────

/// The icon's best image: the largest, then the deepest.
fn ico_entry(b: &[u8]) -> Option<&[u8]> {
    let n = u16::from_le_bytes([*b.get(4)?, *b.get(5)?]) as usize;
    (0..n)
        .filter_map(|i| {
            let e = b.get(6 + i * 16..6 + (i + 1) * 16)?;
            let side = |v: u8| if v == 0 { 256u32 } else { v as u32 };
            let area = side(e[0]) * side(e[1]);
            let bpp = u16::from_le_bytes([e[6], e[7]]);
            let size = u32::from_le_bytes(e[8..12].try_into().ok()?) as usize;
            let off = u32::from_le_bytes(e[12..16].try_into().ok()?) as usize;
            Some(((area, bpp), b.get(off..off.checked_add(size)?)?))
        })
        .max_by_key(|(k, _)| *k)
        .map(|(_, d)| d)
}

/// An icon's device-independent bitmap: the colour bitmap over its AND
/// mask (height doubled), bottom up.
fn dib(d: &[u8]) -> Option<Rgba> {
    let rd32 = |at: usize| Some(u32::from_le_bytes(d.get(at..at + 4)?.try_into().ok()?));
    let rd16 = |at: usize| Some(u16::from_le_bytes(d.get(at..at + 2)?.try_into().ok()?));
    let head = rd32(0)? as usize;
    let w = rd32(4)? as i32;
    let h2 = rd32(8)? as i32;
    let bpp = rd16(14)? as u32;
    if rd32(16)? != 0 || w <= 0 || h2 == 0 {
        return None; // compressed DIBs: not in icons
    }
    let (w, h) = (w as u32, (h2.unsigned_abs()) / 2);
    if !fits(w, h) {
        return None;
    }
    let used = rd32(32)? as usize;
    let ncol = if bpp <= 8 {
        if used == 0 {
            1usize << bpp
        } else {
            used
        }
    } else {
        0
    };
    let pal_at = head;
    let palette: Vec<[u8; 4]> = (0..ncol)
        .map(|i| {
            let p = d.get(pal_at + i * 4..pal_at + i * 4 + 4)?;
            Some([p[2], p[1], p[0], 255])
        })
        .collect::<Option<_>>()?;
    let xor_at = pal_at + ncol * 4;
    let stride = ((w * bpp).div_ceil(32) * 4) as usize;
    let and_at = xor_at + stride * h as usize;
    let and_stride = (w.div_ceil(32) * 4) as usize;
    let mut px = vec![0u8; (w * h * 4) as usize];
    let mut any_alpha = false;
    for y in 0..h {
        let row = xor_at + (h - 1 - y) as usize * stride;
        for x in 0..w {
            let c = match bpp {
                1 | 4 | 8 => {
                    let bit = (x * bpp) as usize;
                    let byte = *d.get(row + bit / 8)?;
                    let k = (byte >> (8 - bpp as usize - bit % 8)) & ((1u16 << bpp) - 1) as u8;
                    *palette.get(k as usize)?
                }
                24 => {
                    let p = d.get(row + x as usize * 3..row + x as usize * 3 + 3)?;
                    [p[2], p[1], p[0], 255]
                }
                32 => {
                    let p = d.get(row + x as usize * 4..row + x as usize * 4 + 4)?;
                    any_alpha |= p[3] != 0;
                    [p[2], p[1], p[0], p[3]]
                }
                _ => return None,
            };
            let o = ((y * w + x) * 4) as usize;
            px[o..o + 4].copy_from_slice(&c);
        }
    }
    // The AND mask cuts out what a picture without alpha does not show.
    if !any_alpha {
        for y in 0..h {
            let row = and_at + (h - 1 - y) as usize * and_stride;
            for x in 0..w {
                let masked = d
                    .get(row + x as usize / 8)
                    .is_some_and(|b| b >> (7 - x % 8) & 1 == 1);
                px[((y * w + x) * 4 + 3) as usize] = if masked { 0 } else { 255 };
            }
        }
    }
    Some(Rgba { w, h, px })
}

// ── QOI ──────────────────────────────────────────────────────────────────

/// The Quite OK Image format (qoiformat.org, version 1.0).
fn qoi(b: &[u8]) -> Option<Rgba> {
    let w = u32::from_be_bytes(b.get(4..8)?.try_into().ok()?);
    let h = u32::from_be_bytes(b.get(8..12)?.try_into().ok()?);
    if !fits(w, h) {
        return None;
    }
    let n = (w * h) as usize;
    let mut px = Vec::with_capacity(n * 4);
    let mut seen = [[0u8; 4]; 64];
    let mut p = [0u8, 0, 0, 255];
    let mut at = 14;
    let end = b.len().saturating_sub(8);
    let mut run = 0usize;
    let hash = |p: [u8; 4]| {
        (p[0] as usize * 3 + p[1] as usize * 5 + p[2] as usize * 7 + p[3] as usize * 11) % 64
    };
    while px.len() < n * 4 {
        if run > 0 {
            run -= 1;
        } else if at < end {
            let op = b[at];
            at += 1;
            match op {
                0xFE => {
                    p[..3].copy_from_slice(b.get(at..at + 3)?);
                    at += 3;
                }
                0xFF => {
                    p.copy_from_slice(b.get(at..at + 4)?);
                    at += 4;
                }
                _ => match op >> 6 {
                    0 => p = seen[(op & 0x3F) as usize],
                    1 => {
                        p[0] = p[0].wrapping_add(((op >> 4) & 3).wrapping_sub(2));
                        p[1] = p[1].wrapping_add(((op >> 2) & 3).wrapping_sub(2));
                        p[2] = p[2].wrapping_add((op & 3).wrapping_sub(2));
                    }
                    2 => {
                        let dg = (op & 0x3F).wrapping_sub(32);
                        let b2 = *b.get(at)?;
                        at += 1;
                        p[0] = p[0].wrapping_add(dg.wrapping_add((b2 >> 4).wrapping_sub(8)));
                        p[1] = p[1].wrapping_add(dg);
                        p[2] = p[2].wrapping_add(dg.wrapping_add((b2 & 0x0F).wrapping_sub(8)));
                    }
                    _ => run = (op & 0x3F) as usize,
                },
            }
            seen[hash(p)] = p;
        } else {
            return None;
        }
        px.extend_from_slice(&p);
    }
    Some(Rgba { w, h, px })
}

#[cfg(test)]
#[allow(non_snake_case)]
mod tests {
    use super::*;

    /// The pixels of a PNG this module wrote (filter 0, 8-bit RGB or RGBA).
    fn read_png(png: &[u8]) -> Rgba {
        use std::io::Read;
        let w = u32::from_be_bytes(png[16..20].try_into().unwrap());
        let h = u32::from_be_bytes(png[20..24].try_into().unwrap());
        let color = png[25];
        let mut at = 8;
        let mut idat = Vec::new();
        while at < png.len() {
            let len = u32::from_be_bytes(png[at..at + 4].try_into().unwrap()) as usize;
            if &png[at + 4..at + 8] == b"IDAT" {
                idat.extend_from_slice(&png[at + 8..at + 8 + len]);
            }
            at += 12 + len;
        }
        let mut raw = Vec::new();
        flate2::read::ZlibDecoder::new(&idat[..])
            .read_to_end(&mut raw)
            .unwrap();
        let ch = if color == 6 { 4 } else { 3 };
        let mut px = Vec::new();
        for row in raw.chunks(1 + w as usize * ch) {
            for p in row[1..].chunks(ch) {
                px.extend_from_slice(&[p[0], p[1], p[2], if ch == 4 { p[3] } else { 255 }]);
            }
        }
        Rgba { w, h, px }
    }

    const BLUE: [u8; 4] = [0x44, 0x72, 0xC4, 255];

    fn uniform(w: u32, h: u32, c: [u8; 4]) -> Vec<u8> {
        (0..w * h).flat_map(|_| c).collect()
    }

    #[test]
    fn a_tga_is_written_as_a_png_of_its_pixels__feat__plugin_slide_pptx_export() {
        // 24-bit, bottom up: the first row in the file is the bottom one.
        let mut b = vec![0u8; 18];
        b[2] = 2;
        b[12] = 2;
        b[14] = 2;
        b[16] = 24;
        b.extend_from_slice(&[0, 0, 255, 0, 0, 255]); // bottom row: red
        b.extend_from_slice(&[0x44 + 0x80, 0x72, 0x44, 0xC4, 0x72, 0x44]); // top row
        let png = to_png(&b).expect("a TGA");
        let img = read_png(&png);
        assert_eq!((img.w, img.h), (2, 2));
        assert_eq!(&img.px[0..4], &[0x44, 0x72, 0xC4, 255]);
        assert_eq!(&img.px[8..12], &[255, 0, 0, 255]);
        // Run-length encoded, top down, 32 bits with alpha.
        let mut r = vec![0u8; 18];
        r[2] = 10;
        r[12] = 3;
        r[14] = 1;
        r[16] = 32;
        r[17] = 0x28;
        r.extend_from_slice(&[0x82, 0xC4, 0x72, 0x44, 0x80]);
        let img = read_png(&to_png(&r).expect("an RLE TGA"));
        assert_eq!(img.px, [0x44, 0x72, 0xC4, 0x80].repeat(3));
    }

    #[test]
    fn a_qoi_is_written_as_a_png_of_its_pixels__feat__plugin_slide_pptx_export() {
        let mut b = b"qoif".to_vec();
        b.extend_from_slice(&8u32.to_be_bytes());
        b.extend_from_slice(&4u32.to_be_bytes());
        b.extend_from_slice(&[3, 0, 0xFE, 0x44, 0x72, 0xC4, 0xC0 | 30]);
        b.extend_from_slice(&[0, 0, 0, 0, 0, 0, 0, 1]);
        let img = read_png(&to_png(&b).expect("a QOI"));
        assert_eq!(img.px, uniform(8, 4, BLUE));
    }

    #[test]
    fn an_ico_keeps_its_png_entry_and_decodes_a_bitmap_one__feat__plugin_slide_pptx_export() {
        let inner = png_rgba(2, 1, &[1, 2, 3, 255, 4, 5, 6, 255]);
        let mut ico = vec![0, 0, 1, 0, 1, 0, 2, 1, 0, 0, 1, 0, 32, 0];
        ico.extend_from_slice(&(inner.len() as u32).to_le_bytes());
        ico.extend_from_slice(&22u32.to_le_bytes());
        ico.extend_from_slice(&inner);
        assert_eq!(to_png(&ico).unwrap(), inner);
        // A 2 × 2 24-bit DIB whose AND mask hides its top-left pixel.
        let mut dibb = vec![0u8; 40];
        dibb[0] = 40;
        dibb[4] = 2;
        dibb[8] = 4;
        dibb[12] = 1;
        dibb[14] = 24;
        for _ in 0..2 {
            dibb.extend_from_slice(&[0xC4, 0x72, 0x44, 0xC4, 0x72, 0x44, 0, 0]);
        }
        dibb.extend_from_slice(&[0, 0, 0, 0]); // bottom row: shown
        dibb.extend_from_slice(&[0x80, 0, 0, 0]); // top row: first pixel masked
        let mut ico = vec![0, 0, 1, 0, 1, 0, 2, 2, 0, 0, 1, 0, 24, 0];
        ico.extend_from_slice(&(dibb.len() as u32).to_le_bytes());
        ico.extend_from_slice(&22u32.to_le_bytes());
        ico.extend_from_slice(&dibb);
        let img = read_png(&to_png(&ico).expect("a bitmap icon"));
        assert_eq!((img.w, img.h), (2, 2));
        assert_eq!(img.px[3], 0);
        assert_eq!(&img.px[4..8], &BLUE);
        assert_eq!(&img.px[8..16], &[BLUE, BLUE].concat());
    }

    #[test]
    fn a_webp_is_written_as_a_png_of_its_pixels__feat__plugin_slide_pptx_export() {
        // A 1 × 1 lossless WebP (the bundle's picture test's).
        let webp = [
            0x52, 0x49, 0x46, 0x46, 0x1a, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50,
            0x38, 0x4c, 0x0d, 0x00, 0x00, 0x00, 0x2f, 0x00, 0x00, 0x00, 0x10, 0x07, 0x10, 0x11,
            0x11, 0x88, 0x88, 0xfe, 0x07, 0x00,
        ];
        let img = read_png(&to_png(&webp).expect("a WebP"));
        assert_eq!((img.w, img.h), (1, 1));
        // Not a picture this module reads.
        assert!(to_png(b"\x89PNG\r\n\x1a\n....").is_none());
    }

    #[test]
    fn an_indexed_png_carries_its_palette_and_alpha() {
        let png = png_indexed(2, 1, &[[255, 0, 0, 255], [0, 0, 255, 128]], &[0, 1]);
        let has = |k: &[u8]| png.windows(4).any(|w| w == k);
        assert!(has(b"PLTE") && has(b"tRNS"));
        assert_eq!(png[25], 3);
    }
}
