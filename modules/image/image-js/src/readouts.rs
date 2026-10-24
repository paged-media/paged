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

//! READOUTS and file metadata for the Image menu and the filter dialogs:
//! pure CPU work that derives PARAMETERS (a rectangle, a colour, a
//! number) from pixels or bytes. Like the histogram and auto-enhance
//! (`image_gpu::reduce`), none of it is a kernel and none moves pixels:
//!
//! * [`trim_rect`] — Image ▸ Trim's rectangle (the crop then runs as the
//!   exact `CanvasOp::Crop`);
//! * [`coverage_mean`] — Filter ▸ Blur ▸ Average's colour (the fill then
//!   runs through `gen.solid`);
//! * [`auto_contrast_levels`] — Curves ▸ Auto's per-channel black and
//!   white points;
//! * [`read_ppi`] / [`stamp_ppi`] — the resolution a PNG or JPEG
//!   declares, read on open and written on export (Image Size's ppi).

use image_gpu::coverage::SelectionCoverage;

/// What Image ▸ Trim trims away.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrimBy {
    /// Fully transparent pixels (alpha 0).
    Transparent,
    /// Pixels of exactly the top-left pixel's colour.
    TopLeft,
    /// Pixels of exactly the bottom-right pixel's colour.
    BottomRight,
}

impl TrimBy {
    pub fn from_wire(s: &str) -> Option<Self> {
        match s {
            "transparent" => Some(Self::Transparent),
            "top-left" => Some(Self::TopLeft),
            "bottom-right" => Some(Self::BottomRight),
            _ => None,
        }
    }
}

/// The smallest rectangle `(x, y, w, h)` of a `w`×`h` straight-RGBA8
/// image that keeps every pixel Trim would NOT remove; `None` when it
/// would remove every pixel (Photoshop refuses that trim too).
pub fn trim_rect(rgba: &[u8], w: u32, h: u32, by: TrimBy) -> Option<(u32, u32, u32, u32)> {
    let n = w as usize * h as usize;
    if n == 0 || rgba.len() < n * 4 {
        return None;
    }
    let px = |x: u32, y: u32| {
        let i = (y as usize * w as usize + x as usize) * 4;
        [rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]]
    };
    let reference = match by {
        TrimBy::Transparent => None,
        TrimBy::TopLeft => Some(px(0, 0)),
        TrimBy::BottomRight => Some(px(w - 1, h - 1)),
    };
    let keep = |p: [u8; 4]| match reference {
        None => p[3] != 0,
        Some(r) => p != r,
    };
    let (mut x0, mut y0, mut x1, mut y1) = (u32::MAX, u32::MAX, 0u32, 0u32);
    for y in 0..h {
        for x in 0..w {
            if keep(px(x, y)) {
                x0 = x0.min(x);
                y0 = y0.min(y);
                x1 = x1.max(x);
                y1 = y1.max(y);
            }
        }
    }
    (x0 != u32::MAX).then(|| (x0, y0, x1 - x0 + 1, y1 - y0 + 1))
}

/// The average colour of a straight-RGBA8 image under `coverage` (every
/// pixel at full weight without one), as straight RGBA in `[0, 1]`.
/// Colour is averaged ALPHA-WEIGHTED — a transparent pixel has no
/// colour to contribute — and alpha by coverage alone. Fixed row-major
/// order, accumulated in f64. `None` when nothing is covered.
pub fn coverage_mean(
    rgba: &[u8],
    w: u32,
    h: u32,
    coverage: Option<&SelectionCoverage>,
) -> Option<[f32; 4]> {
    let mut wsum = 0f64;
    let mut asum = 0f64;
    let mut c = [0f64; 3];
    for y in 0..h {
        for x in 0..w {
            let k = coverage.map_or(1.0, |cov| f64::from(cov.coverage_at(x, y)) / 255.0);
            if k == 0.0 {
                continue;
            }
            let i = (y as usize * w as usize + x as usize) * 4;
            let a = f64::from(rgba[i + 3]) / 255.0;
            wsum += k;
            asum += k * a;
            for ch in 0..3 {
                c[ch] += k * a * f64::from(rgba[i + ch]) / 255.0;
            }
        }
    }
    if wsum == 0.0 {
        return None;
    }
    let col = |v: f64| if asum > 0.0 { (v / asum) as f32 } else { 0.0 };
    Some([col(c[0]), col(c[1]), col(c[2]), (asum / wsum) as f32])
}

/// Curves ▸ Auto, as Photoshop's "Enhance Per Channel Contrast": for
/// each of R, G and B the input levels below which `clip` of the pixels
/// fall (the black point) and above which `clip` fall (the white point),
/// from a 256-bin histogram per channel. Returns `[[black, white]; 3]`
/// in `[0, 1]`; a channel whose points would meet keeps `[0, 1]`
/// (a flat channel has no contrast to stretch). Transparent pixels are
/// not counted.
pub fn auto_contrast_levels(rgba: &[u8], clip: f64) -> [[f32; 2]; 3] {
    let mut hist = [[0u64; 256]; 3];
    let mut n = 0u64;
    for p in rgba.as_chunks::<4>().0 {
        if p[3] == 0 {
            continue;
        }
        n += 1;
        for c in 0..3 {
            hist[c][p[c] as usize] += 1;
        }
    }
    let mut out = [[0.0, 1.0]; 3];
    if n == 0 {
        return out;
    }
    let cut = (clip.clamp(0.0, 0.5) * n as f64).floor() as u64;
    for c in 0..3 {
        // Black: the first bin where MORE than `cut` pixels lie at or
        // below it; white: the same from the top.
        let mut acc = 0u64;
        let mut lo = 0usize;
        for (v, &k) in hist[c].iter().enumerate() {
            acc += k;
            if acc > cut {
                lo = v;
                break;
            }
        }
        let mut acc = 0u64;
        let mut hi = 255usize;
        for (v, &k) in hist[c].iter().enumerate().rev() {
            acc += k;
            if acc > cut {
                hi = v;
                break;
            }
        }
        if hi > lo {
            out[c] = [lo as f32 / 255.0, hi as f32 / 255.0];
        }
    }
    out
}

// ───────────────────────────── resolution ─────────────────────────────
//
// The resolution a raster file declares is metadata only — no pixel
// depends on it — so it is read from and written into the encoded bytes
// directly: PNG's `pHYs` chunk (pixels per metre) and JPEG's JFIF APP0
// density (dots per inch). The codec traits stay as they are (frozen);
// these work on their output.

const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";
const INCH_PER_METRE: f64 = 0.0254;

/// The ppi `bytes` declares: PNG `pHYs` with the metre unit, JPEG JFIF
/// with the inch or centimetre unit. `None` for anything else (no
/// declaration, an aspect-ratio-only one, another format).
pub fn read_ppi(bytes: &[u8]) -> Option<f32> {
    if bytes.starts_with(PNG_SIGNATURE) {
        let mut at = 8;
        while at + 8 <= bytes.len() {
            let len = u32::from_be_bytes(bytes[at..at + 4].try_into().ok()?) as usize;
            let kind = &bytes[at + 4..at + 8];
            let data = bytes.get(at + 8..at + 8 + len)?;
            if kind == b"pHYs" && len == 9 {
                let ppm = u32::from_be_bytes(data[0..4].try_into().ok()?);
                return (data[8] == 1 && ppm > 0).then(|| (f64::from(ppm) * INCH_PER_METRE) as f32);
            }
            if kind == b"IDAT" || kind == b"IEND" {
                return None;
            }
            at += 12 + len;
        }
        return None;
    }
    if bytes.starts_with(&[0xFF, 0xD8]) {
        let app0 = bytes.get(2..20)?;
        if app0[0] == 0xFF && app0[1] == 0xE0 && &app0[4..9] == b"JFIF\0" {
            let unit = app0[11];
            let x = u16::from_be_bytes([app0[12], app0[13]]);
            return match unit {
                1 if x > 0 => Some(f32::from(x)),
                2 if x > 0 => Some(f32::from(x) * 2.54),
                _ => None,
            };
        }
    }
    None
}

/// `bytes` declaring `ppi`: a PNG gains (or has replaced) its `pHYs`
/// chunk right after `IHDR`; a JPEG's JFIF APP0 density is set in place,
/// or an APP0 inserted after SOI when there is none. Anything else is
/// returned unchanged. The pixels are untouched either way.
pub fn stamp_ppi(bytes: &[u8], ppi: f32) -> Vec<u8> {
    if !(ppi.is_finite() && ppi > 0.0) {
        return bytes.to_vec();
    }
    if bytes.starts_with(PNG_SIGNATURE) {
        return stamp_png(bytes, ppi).unwrap_or_else(|| bytes.to_vec());
    }
    if bytes.starts_with(&[0xFF, 0xD8]) {
        return stamp_jpeg(bytes, ppi);
    }
    bytes.to_vec()
}

fn stamp_png(bytes: &[u8], ppi: f32) -> Option<Vec<u8>> {
    let ppm = (f64::from(ppi) / INCH_PER_METRE).round() as u32;
    let mut chunk = Vec::with_capacity(21);
    chunk.extend_from_slice(&9u32.to_be_bytes());
    chunk.extend_from_slice(b"pHYs");
    chunk.extend_from_slice(&ppm.to_be_bytes());
    chunk.extend_from_slice(&ppm.to_be_bytes());
    chunk.push(1);
    let crc = crc32(&chunk[4..]);
    chunk.extend_from_slice(&crc.to_be_bytes());

    let mut out = Vec::with_capacity(bytes.len() + chunk.len());
    out.extend_from_slice(&bytes[..8]);
    let mut at = 8;
    let mut placed = false;
    while at + 8 <= bytes.len() {
        let len = u32::from_be_bytes(bytes[at..at + 4].try_into().ok()?) as usize;
        let end = at.checked_add(12 + len)?;
        let kind = bytes.get(at + 4..at + 8)?;
        let whole = bytes.get(at..end)?;
        if kind != b"pHYs" {
            out.extend_from_slice(whole);
        }
        if kind == b"IHDR" && !placed {
            out.extend_from_slice(&chunk);
            placed = true;
        }
        at = end;
    }
    placed.then_some(out)
}

fn stamp_jpeg(bytes: &[u8], ppi: f32) -> Vec<u8> {
    let dpi = ppi.round().clamp(1.0, 65535.0) as u16;
    let mut out = bytes.to_vec();
    let has_jfif =
        bytes.len() >= 20 && bytes[2] == 0xFF && bytes[3] == 0xE0 && &bytes[6..11] == b"JFIF\0";
    if has_jfif {
        out[13] = 1;
        out[14..16].copy_from_slice(&dpi.to_be_bytes());
        out[16..18].copy_from_slice(&dpi.to_be_bytes());
        return out;
    }
    let mut app0 = vec![0xFF, 0xE0, 0x00, 0x10];
    app0.extend_from_slice(b"JFIF\0");
    app0.extend_from_slice(&[1, 1, 1]);
    app0.extend_from_slice(&dpi.to_be_bytes());
    app0.extend_from_slice(&dpi.to_be_bytes());
    app0.extend_from_slice(&[0, 0]);
    out.splice(2..2, app0);
    out
}

/// CRC-32 (ISO-HDLC, the PNG chunk checksum), bitwise.
fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for &b in data {
        crc ^= u32::from(b);
        for _ in 0..8 {
            crc = if crc & 1 != 0 {
                (crc >> 1) ^ 0xEDB8_8320
            } else {
                crc >> 1
            };
        }
    }
    !crc
}

#[cfg(test)]
mod tests {
    use super::*;

    fn img(w: u32, h: u32, f: impl Fn(u32, u32) -> [u8; 4]) -> Vec<u8> {
        let mut v = Vec::new();
        for y in 0..h {
            for x in 0..w {
                v.extend_from_slice(&f(x, y));
            }
        }
        v
    }

    #[test]
    #[allow(non_snake_case)]
    fn trim_finds_the_content_by_alpha_and_by_either_corner__feat__image_editor_canvas_ops() {
        // A 6×5 canvas: transparent border, a 2×2 red block at (2, 1).
        let t = img(6, 5, |x, y| {
            if (2..4).contains(&x) && (1..3).contains(&y) {
                [255, 0, 0, 255]
            } else {
                [0, 0, 0, 0]
            }
        });
        assert_eq!(trim_rect(&t, 6, 5, TrimBy::Transparent), Some((2, 1, 2, 2)));
        // White surround with a dark pixel at the bottom-right corner:
        // top-left trims the white, bottom-right trims nothing it matches.
        let c = img(6, 5, |x, y| {
            if (x, y) == (3, 2) {
                [10, 20, 30, 255]
            } else if (x, y) == (5, 4) {
                [1, 1, 1, 255]
            } else {
                [255, 255, 255, 255]
            }
        });
        assert_eq!(trim_rect(&c, 6, 5, TrimBy::TopLeft), Some((3, 2, 3, 3)));
        assert_eq!(trim_rect(&c, 6, 5, TrimBy::BottomRight), Some((0, 0, 6, 5)));
        let blank = img(3, 3, |_, _| [0, 0, 0, 0]);
        assert_eq!(trim_rect(&blank, 3, 3, TrimBy::Transparent), None);
        assert_eq!(TrimBy::from_wire("top-left"), Some(TrimBy::TopLeft));
        assert_eq!(TrimBy::from_wire("left"), None);
    }

    #[test]
    #[allow(non_snake_case)]
    fn average_is_alpha_weighted_and_follows_the_selection__feat__image_editor_filter_dialogs() {
        let p = img(2, 1, |x, _| {
            if x == 0 {
                [255, 0, 0, 255]
            } else {
                [0, 0, 255, 0]
            }
        });
        // The transparent blue has no colour to give; alpha averages.
        let m = coverage_mean(&p, 2, 1, None).expect("mean");
        assert_eq!(m, [1.0, 0.0, 0.0, 0.5]);
        let q = img(2, 1, |x, _| {
            if x == 0 {
                [200, 0, 0, 255]
            } else {
                [0, 0, 100, 255]
            }
        });
        let sel = SelectionCoverage::from_data(2, 1, vec![0, 255]).expect("sel");
        let m = coverage_mean(&q, 2, 1, Some(&sel)).expect("mean");
        assert!((m[2] - 100.0 / 255.0).abs() < 1e-6 && m[0] == 0.0, "{m:?}");
        let none = SelectionCoverage::from_data(2, 1, vec![0, 0]).expect("sel");
        assert_eq!(coverage_mean(&q, 2, 1, Some(&none)), None);
    }

    #[test]
    #[allow(non_snake_case)]
    fn auto_contrast_clips_each_channel_at_its_own_percentile__feat__image_editor_curves() {
        // Red spans 50..=150, green is flat, blue spans 0..=255 with one
        // outlier at each end that a 1 % clip drops.
        let mut px = Vec::new();
        for i in 0..200u32 {
            let r = 50 + (i % 101) as u8;
            let b = if i == 0 {
                0
            } else if i == 1 {
                255
            } else {
                100 + (i % 50) as u8
            };
            px.extend_from_slice(&[r, 80, b, 255]);
        }
        let lv = auto_contrast_levels(&px, 0.01);
        assert!(
            (lv[0][0] - 51.0 / 255.0).abs() < 0.01,
            "red black {:?}",
            lv[0]
        );
        assert!(
            (lv[0][1] - 149.0 / 255.0).abs() < 0.01,
            "red white {:?}",
            lv[0]
        );
        assert_eq!(lv[1], [0.0, 1.0], "a flat channel is left alone");
        assert!(
            lv[2][0] >= 100.0 / 255.0 && lv[2][1] <= 149.0 / 255.0,
            "{:?}",
            lv[2]
        );
        assert_eq!(auto_contrast_levels(&[], 0.001), [[0.0, 1.0]; 3]);
    }

    #[test]
    #[allow(non_snake_case)]
    fn ppi_round_trips_through_png_and_jpeg_bytes__feat__image_editor_canvas_ops() {
        let png = crate::saveback::encode_rgba8_opt(
            &[1, 2, 3, 255, 4, 5, 6, 255],
            2,
            1,
            crate::saveback::RasterFormat::Png,
            90,
            false,
        )
        .expect("png");
        assert_eq!(read_ppi(&png), None);
        let stamped = stamp_ppi(&png, 300.0);
        let got = read_ppi(&stamped).expect("ppi");
        assert!((got - 300.0).abs() < 0.05, "{got}");
        // Re-stamping replaces rather than duplicates the chunk.
        let again = stamp_ppi(&stamped, 72.0);
        assert_eq!(again.windows(4).filter(|w| w == b"pHYs").count(), 1);
        assert!((read_ppi(&again).expect("ppi") - 72.0).abs() < 0.05);
        // The stamped file still decodes to the same pixels.
        let decoded = crate::ingest::decode_rgba8(&again).expect("decode");
        assert_eq!((decoded.width, decoded.height), (2, 1));
        assert_eq!(crc32(b"IEND"), 0xAE42_6082, "the PNG IEND CRC");

        let jpeg = crate::saveback::encode_rgba8_opt(
            &[9u8; 8 * 8 * 4],
            8,
            8,
            crate::saveback::RasterFormat::Jpeg,
            90,
            false,
        )
        .expect("jpeg");
        let stamped = stamp_ppi(&jpeg, 240.0);
        assert_eq!(read_ppi(&stamped), Some(240.0));
        let decoded = crate::ingest::decode_rgba8(&stamped).expect("decode");
        assert_eq!((decoded.width, decoded.height), (8, 8));
        assert_eq!(stamp_ppi(b"GIF89a", 300.0), b"GIF89a".to_vec());
    }
}
