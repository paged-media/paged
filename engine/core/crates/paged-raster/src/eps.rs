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

//! The preview of an Encapsulated PostScript file.
//!
//! The engine has no PostScript interpreter, so an EPS is read for the
//! picture it carries for screens:
//!
//! - a **DOS EPS binary** file (`C5 D0 D3 C6`) stores the PostScript, a
//!   Windows metafile and a TIFF side by side; the TIFF decodes through
//!   this crate's TIFF reader. A metafile is not read, so a file with only
//!   a metafile preview is refused by name;
//! - an **EPSI** file carries a `%%BeginPreview: width height depth lines`
//!   bitmap in comment lines of hexadecimal: 1, 2, 4 or 8 bits of gray per
//!   pixel, each row padded to a byte, the top row first, and 0 for white
//!   (the EPSF convention; Ghostscript's `ps2epsi` writes it so).
//!
//! The preview is a stand-in for the artwork, usually at 72 ppi.
//! [`bounding_box`] reads the `%%BoundingBox` (or `%%HiResBoundingBox`)
//! the artwork occupies, in points, so a caller can place the preview
//! over the area the PostScript would draw; [`RasterInfo::resolution`]
//! states the preview's pixels per inch against it.

use crate::{
    Alpha, ColorModel, DecodeOptions, Error, Format, RasterImage, RasterInfo, Result, SampleFormat,
    Samples,
};

const DOS_MAGIC: [u8; 4] = [0xC5, 0xD0, 0xD3, 0xC6];

fn unsupported(what: impl Into<String>) -> Error {
    Error::Unsupported {
        format: Format::Eps,
        what: what.into(),
    }
}

fn malformed(detail: impl Into<String>) -> Error {
    Error::Malformed {
        format: Format::Eps,
        detail: detail.into(),
    }
}

/// The three sections of a DOS EPS binary file, or the whole file as
/// PostScript.
struct Sections<'b> {
    ps: &'b [u8],
    wmf: &'b [u8],
    tiff: &'b [u8],
}

fn sections(bytes: &[u8]) -> Result<Sections<'_>> {
    if !bytes.starts_with(&DOS_MAGIC) {
        return Ok(Sections {
            ps: bytes,
            wmf: &[],
            tiff: &[],
        });
    }
    let word = |at: usize| -> Result<usize> {
        let s: [u8; 4] = bytes
            .get(at..at + 4)
            .and_then(|s| s.try_into().ok())
            .ok_or_else(|| malformed("short DOS EPS header"))?;
        Ok(u32::from_le_bytes(s) as usize)
    };
    let section = |off: usize, len: usize| -> Result<&[u8]> {
        if len == 0 {
            return Ok(&[]);
        }
        off.checked_add(len)
            .and_then(|end| bytes.get(off..end))
            .ok_or_else(|| malformed("a DOS EPS section runs past the end of the file"))
    };
    Ok(Sections {
        ps: section(word(4)?, word(8)?)?,
        wmf: section(word(12)?, word(16)?)?,
        tiff: section(word(20)?, word(24)?)?,
    })
}

/// The DSC header comments: the lines up to `%%EndComments` (or the first
/// line that is not a comment), at most 64 KiB in.
fn header_lines(ps: &[u8]) -> impl Iterator<Item = &[u8]> {
    let head = &ps[..ps.len().min(64 << 10)];
    head.split(|b| *b == b'\n' || *b == b'\r')
        .filter(|l| !l.is_empty())
        .take_while(|l| l.starts_with(b"%") && !l.starts_with(b"%%EndComments"))
}

fn numbers(rest: &[u8]) -> Vec<f64> {
    String::from_utf8_lossy(rest)
        .split_whitespace()
        .map_while(|t| t.parse::<f64>().ok())
        .collect()
}

/// The artwork's bounding box in PostScript points, `[llx, lly, urx, ury]`:
/// `%%HiResBoundingBox` when the header has one, else `%%BoundingBox`.
/// `None` for bytes that are not an EPS, and for a box that is absent,
/// deferred (`(atend)`) or empty.
pub fn bounding_box(bytes: &[u8]) -> Option<[f64; 4]> {
    if crate::sniff(bytes) != Some(Format::Eps) {
        return None;
    }
    let ps = sections(bytes).ok()?.ps;
    let mut plain = None;
    for line in header_lines(ps) {
        let parsed = |tag: &[u8]| {
            line.strip_prefix(tag).and_then(|rest| {
                let n = numbers(rest);
                (n.len() == 4 && n[2] > n[0] && n[3] > n[1]).then(|| [n[0], n[1], n[2], n[3]])
            })
        };
        if let Some(b) = parsed(b"%%HiResBoundingBox:") {
            return Some(b);
        }
        if plain.is_none() {
            plain = parsed(b"%%BoundingBox:");
        }
    }
    plain
}

/// An EPSI preview: its header and the hexadecimal data lines.
struct Epsi {
    width: u32,
    height: u32,
    depth: u32,
    data: Vec<u8>,
}

/// Find and read the `%%BeginPreview` section (it follows the header
/// comments; searched in the first 16 MiB).
fn epsi(ps: &[u8]) -> Result<Option<Epsi>> {
    const TAG: &[u8] = b"%%BeginPreview:";
    let scan = &ps[..ps.len().min(16 << 20)];
    let Some(start) = scan.windows(TAG.len()).position(|w| w == TAG) else {
        return Ok(None);
    };
    let mut lines = scan[start + TAG.len()..].split(|b| *b == b'\n' || *b == b'\r');
    let n = numbers(lines.next().unwrap_or_default());
    if n.len() < 3 || n.iter().take(3).any(|v| *v < 1.0 || v.fract() != 0.0) {
        return Err(malformed(
            "a %%BeginPreview line without width, height and depth",
        ));
    }
    let (width, height, depth) = (n[0] as u32, n[1] as u32, n[2] as u32);
    if !matches!(depth, 1 | 2 | 4 | 8) {
        return Err(unsupported(format!("an EPSI preview of depth {depth}")));
    }
    let row = (width as usize * depth as usize).div_ceil(8);
    let want = row
        .checked_mul(height as usize)
        .filter(|n| *n <= 256 << 20)
        .ok_or_else(|| unsupported("an EPSI preview larger than the decode limits"))?;
    let mut data = Vec::with_capacity(want);
    let mut nibble: Option<u8> = None;
    'lines: for line in lines {
        if line.starts_with(b"%%EndPreview") {
            break;
        }
        let Some(hex) = line.strip_prefix(b"%") else {
            continue;
        };
        for &c in hex {
            let v = match c {
                b'0'..=b'9' => c - b'0',
                b'a'..=b'f' => c - b'a' + 10,
                b'A'..=b'F' => c - b'A' + 10,
                _ => continue,
            };
            match nibble.take() {
                Some(hi) => {
                    data.push(hi << 4 | v);
                    if data.len() == want {
                        break 'lines;
                    }
                }
                None => nibble = Some(v),
            }
        }
    }
    if data.len() < want {
        return Err(malformed(format!(
            "the EPSI preview holds {} of its {want} bytes",
            data.len()
        )));
    }
    Ok(Some(Epsi {
        width,
        height,
        depth,
        data,
    }))
}

/// Which preview the file carries.
enum Preview<'b> {
    Tiff(&'b [u8]),
    Epsi(Epsi),
}

fn preview(bytes: &[u8]) -> Result<Preview<'_>> {
    let s = sections(bytes)?;
    if !s.tiff.is_empty() {
        return Ok(Preview::Tiff(s.tiff));
    }
    if let Some(e) = epsi(s.ps)? {
        return Ok(Preview::Epsi(e));
    }
    if !s.wmf.is_empty() {
        return Err(unsupported(
            "an EPS whose only preview is a Windows metafile",
        ));
    }
    Err(unsupported(
        "an EPS without a preview (no PostScript interpreter)",
    ))
}

/// Pixels per inch of a `w` x `h` preview over the bounding box.
fn resolution(bytes: &[u8], w: u32, h: u32) -> Option<(f64, f64)> {
    let [llx, lly, urx, ury] = bounding_box(bytes)?;
    Some((
        f64::from(w) * 72.0 / (urx - llx),
        f64::from(h) * 72.0 / (ury - lly),
    ))
}

fn single_page(page: usize) -> Result<()> {
    if page == 0 {
        Ok(())
    } else {
        Err(Error::PageOutOfRange { page, count: 1 })
    }
}

/// The preview's facts, `format` [`Format::Eps`]. A TIFF preview's
/// metadata (its profile, say) is the TIFF's.
pub(crate) fn probe(bytes: &[u8], page: usize) -> Result<RasterInfo> {
    single_page(page)?;
    let mut info = match preview(bytes)? {
        Preview::Tiff(tiff) => crate::tif::probe(tiff, 0)?,
        Preview::Epsi(e) => epsi_info(&e),
    };
    info.format = Format::Eps;
    info.page_count = 1;
    info.resolution = resolution(bytes, info.width, info.height);
    Ok(info)
}

fn epsi_info(e: &Epsi) -> RasterInfo {
    RasterInfo {
        format: Format::Eps,
        width: e.width,
        height: e.height,
        channels: 1,
        bits_per_sample: e.depth as u16,
        sample_format: SampleFormat::UInt,
        color_model: ColorModel::Gray,
        alpha: Alpha::None,
        icc: None,
        xmp: None,
        iptc: None,
        exif: None,
        photoshop_irb: None,
        has_layers: false,
        layer_count: Some(0),
        resolution: None,
        orientation: 1,
        page_count: 1,
    }
}

/// The preview's pixels: a TIFF preview as the TIFF decodes, an EPSI one
/// as 8-bit gray (white 255).
pub(crate) fn decode(bytes: &[u8], opts: DecodeOptions) -> Result<RasterImage> {
    single_page(opts.page)?;
    let mut img = match preview(bytes)? {
        Preview::Tiff(tiff) => crate::tif::decode(tiff, DecodeOptions { page: 0, ..opts })?,
        Preview::Epsi(e) => {
            let row = (e.width as usize * e.depth as usize).div_ceil(8);
            let max = (1u32 << e.depth) - 1;
            let mut gray = Vec::with_capacity(e.width as usize * e.height as usize);
            for r in e.data.chunks_exact(row).take(e.height as usize) {
                for x in 0..e.width as usize {
                    let bit = x * e.depth as usize;
                    let v = (u32::from(r[bit / 8]) >> (8 - e.depth as usize - bit % 8)) & max;
                    gray.push((255 - v * 255 / max) as u8);
                }
            }
            let full = RasterImage {
                info: epsi_info(&e),
                width: e.width,
                height: e.height,
                model: ColorModel::Gray,
                alpha: Alpha::None,
                data: Samples::U8(gray),
            };
            crate::shrink_image(full, opts.max_dim)
        }
    };
    img.info.format = Format::Eps;
    img.info.page_count = 1;
    img.info.resolution = resolution(bytes, img.info.width, img.info.height);
    Ok(img)
}
