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

//! Digital Negative (DNG 1.0 to 1.7), developed with a good default.
//!
//! A DNG is a TIFF whose first IFD carries DNGVersion. Its raw image is
//! the IFD (the first, or one of its SubIFDs) whose NewSubFileType is 0
//! and whose PhotometricInterpretation is CFA (32803) or LinearRaw
//! (34892). The samples are read from its strips or tiles, uncompressed
//! (any depth up to 16 bits) or lossless JPEG (compression 7,
//! [`crate::lj92`]); other compressions are refused by name.
//!
//! The develop is the plain pipeline every raw converter starts from:
//!
//! 1. LinearizationTable, then BlackLevel (with its repeat pattern and
//!    the per-row and per-column deltas) and WhiteLevel scale the
//!    samples to 0..1, inside the ActiveArea;
//! 2. a CFA image is demosaiced bilinearly: each missing colour is the
//!    mean of the nearest same-colour neighbours (3x3, else 5x5), which
//!    is the bilinear interpolation for a Bayer pattern and works for any
//!    repeat pattern of red, green and blue (X-Trans included);
//! 3. white balance divides by AsShotNeutral, BaselineExposure scales;
//! 4. ColorMatrix (the one calibrated for D65 when there are two, else
//!    the second) takes camera RGB to linear sRGB, as dcraw does: the
//!    matrix times sRGB-to-XYZ, rows normalised so white stays white,
//!    inverted;
//! 5. clipped to 0..1, the sRGB transfer curve, DefaultCrop, 16 bits.
//!
//! Opcode lists (lens corrections, gain maps), ForwardMatrix, the
//! camera calibration and profile tags, AnalogBalance and the highlight
//! recovery a raw converter does are not applied: finer control is the
//! image module's Develop adjustment.

use crate::lj92;
use crate::shrink;
use crate::tif::raw::Header;
use crate::{
    Alpha, ColorModel, DecodeOptions, Error, Format, RasterImage, RasterInfo, Result, SampleFormat,
    Samples,
};

const NEW_SUBFILE_TYPE: u16 = 254;
const WIDTH: u16 = 256;
const HEIGHT: u16 = 257;
const BITS: u16 = 258;
const COMPRESSION: u16 = 259;
const PHOTOMETRIC: u16 = 262;
const STRIP_OFFSETS: u16 = 273;
const ORIENTATION: u16 = 274;
const SAMPLES_PER_PIXEL: u16 = 277;
const ROWS_PER_STRIP: u16 = 278;
const STRIP_BYTE_COUNTS: u16 = 279;
const PLANAR: u16 = 284;
const TILE_WIDTH: u16 = 322;
const TILE_LENGTH: u16 = 323;
const TILE_OFFSETS: u16 = 324;
const TILE_BYTE_COUNTS: u16 = 325;
const SUB_IFDS: u16 = 330;
const CFA_REPEAT_DIM: u16 = 33421;
const CFA_PATTERN: u16 = 33422;
const CFA_PLANE_COLOR: u16 = 50710;
const CFA_LAYOUT: u16 = 50711;
const LINEARIZATION: u16 = 50712;
const BLACK_REPEAT_DIM: u16 = 50713;
const BLACK_LEVEL: u16 = 50714;
const BLACK_DELTA_H: u16 = 50715;
const BLACK_DELTA_V: u16 = 50716;
const WHITE_LEVEL: u16 = 50717;
const DEFAULT_CROP_ORIGIN: u16 = 50719;
const DEFAULT_CROP_SIZE: u16 = 50720;
const COLOR_MATRIX_1: u16 = 50721;
const COLOR_MATRIX_2: u16 = 50722;
const AS_SHOT_NEUTRAL: u16 = 50728;
const BASELINE_EXPOSURE: u16 = 50730;
const ILLUMINANT_1: u16 = 50778;
const ILLUMINANT_2: u16 = 50779;
const ACTIVE_AREA: u16 = 50829;
const OPCODE_LISTS: [u16; 3] = [51008, 51009, 51022];
const ICC: u16 = 34675;

const CFA: u32 = 32803;
const LINEAR_RAW: u32 = 34892;

/// EXIF LightSource D65.
const D65: f64 = 21.0;

/// sRGB (D65) to CIE XYZ.
const XYZ_RGB: [[f64; 3]; 3] = [
    [0.412_453, 0.357_580, 0.180_423],
    [0.212_671, 0.715_160, 0.072_169],
    [0.019_334, 0.119_193, 0.950_227],
];

fn unsupported(what: impl Into<String>) -> Error {
    Error::Unsupported {
        format: Format::Dng,
        what: what.into(),
    }
}

fn malformed(detail: impl Into<String>) -> Error {
    Error::Malformed {
        format: Format::Dng,
        detail: detail.into(),
    }
}

/// The file, its first IFD and its raw IFD.
struct Dng<'b> {
    bytes: &'b [u8],
    h: Header,
    ifd0: u64,
    raw: u64,
}

impl<'b> Dng<'b> {
    fn open(bytes: &'b [u8]) -> Result<Dng<'b>> {
        let h = Header::read(bytes).ok_or_else(|| malformed("bad TIFF header"))?;
        let ifd0 = *h
            .ifds(bytes)
            .first()
            .ok_or_else(|| malformed("no image file directory"))?;
        let mut candidates = vec![ifd0];
        if let Some(subs) = h.numbers(bytes, ifd0, SUB_IFDS) {
            candidates.extend(subs.into_iter().map(|o| o as u64));
        }
        let raw = candidates
            .into_iter()
            .find(|&ifd| {
                h.short(bytes, ifd, NEW_SUBFILE_TYPE).unwrap_or(0) & 1 == 0
                    && matches!(h.short(bytes, ifd, PHOTOMETRIC), Some(CFA | LINEAR_RAW))
            })
            .ok_or_else(|| malformed("no raw image (a CFA or LinearRaw IFD)"))?;
        Ok(Dng {
            bytes,
            h,
            ifd0,
            raw,
        })
    }

    fn short(&self, ifd: u64, tag: u16) -> Option<u32> {
        self.h.short(self.bytes, ifd, tag)
    }

    fn numbers(&self, ifd: u64, tag: u16) -> Option<Vec<f64>> {
        self.h
            .numbers(self.bytes, ifd, tag)
            .filter(|v| !v.is_empty())
    }

    /// A tag of the raw IFD, else of IFD0 (a DNG may put the per-image
    /// colour tags in either).
    fn any(&self, tag: u16) -> Option<Vec<f64>> {
        self.numbers(self.raw, tag)
            .or_else(|| self.numbers(self.ifd0, tag))
    }

    fn size(&self) -> Result<(usize, usize)> {
        let w = self.short(self.raw, WIDTH).unwrap_or(0) as usize;
        let h = self.short(self.raw, HEIGHT).unwrap_or(0) as usize;
        if w == 0 || h == 0 {
            return Err(malformed("a raw image without a size"));
        }
        if w.saturating_mul(h) > 1 << 28 {
            return Err(unsupported("a raw image larger than the decode limits"));
        }
        Ok((w, h))
    }

    fn spp(&self) -> usize {
        self.short(self.raw, SAMPLES_PER_PIXEL).unwrap_or(1).max(1) as usize
    }

    /// The active area `[top, left, bottom, right]` in the raw image.
    fn active_area(&self, w: usize, h: usize) -> [usize; 4] {
        match self.numbers(self.raw, ACTIVE_AREA).as_deref() {
            Some([t, l, b, r]) if *b as usize <= h && *r as usize <= w && b > t && r > l => {
                [*t as usize, *l as usize, *b as usize, *r as usize]
            }
            _ => [0, 0, h, w],
        }
    }

    /// The default crop `(x, y, w, h)` within an active area of `w` x `h`.
    fn default_crop(&self, w: usize, h: usize) -> (usize, usize, usize, usize) {
        let origin = self.numbers(self.raw, DEFAULT_CROP_ORIGIN);
        let size = self.numbers(self.raw, DEFAULT_CROP_SIZE);
        if let (Some([ox, oy]), Some([cw, ch])) = (origin.as_deref(), size.as_deref()) {
            let (ox, oy) = (ox.max(0.0) as usize, oy.max(0.0) as usize);
            let (cw, ch) = (cw.round() as usize, ch.round() as usize);
            if cw > 0 && ch > 0 && ox + cw <= w && oy + ch <= h {
                return (ox, oy, cw, ch);
            }
        }
        (0, 0, w, h)
    }

    /// The developed size: the default crop of the active area.
    fn output_size(&self) -> Result<(usize, usize)> {
        let (w, h) = self.size()?;
        let [t, l, b, r] = self.active_area(w, h);
        let (_, _, cw, ch) = self.default_crop(r - l, b - t);
        Ok((cw, ch))
    }

    fn info(&self) -> Result<RasterInfo> {
        let (w, h) = self.output_size()?;
        let photometric = self.short(self.raw, PHOTOMETRIC).unwrap_or(0);
        let gray = photometric == LINEAR_RAW && self.spp() == 1;
        Ok(RasterInfo {
            format: Format::Dng,
            width: w as u32,
            height: h as u32,
            channels: if gray { 1 } else { 3 },
            bits_per_sample: 16,
            sample_format: SampleFormat::UInt,
            color_model: if gray {
                ColorModel::Gray
            } else {
                ColorModel::Rgb
            },
            alpha: Alpha::None,
            icc: None,
            xmp: self
                .h
                .value(self.bytes, self.ifd0, crate::tif::XMP)
                .map(<[u8]>::to_vec),
            iptc: None,
            exif: None,
            photoshop_irb: None,
            has_layers: false,
            layer_count: Some(0),
            resolution: None,
            orientation: self
                .short(self.ifd0, ORIENTATION)
                .and_then(|o| u16::try_from(o).ok())
                .filter(|o| (1..=8).contains(o))
                .unwrap_or(1),
            page_count: 1,
        })
    }

    /// The raw samples, `w * h * spp`, as stored.
    fn samples(&self) -> Result<Vec<u16>> {
        let (w, h) = self.size()?;
        let spp = self.spp();
        let bits = self.short(self.raw, BITS).unwrap_or(16);
        if !(1..=16).contains(&bits) {
            return Err(unsupported(format!("{bits}-bit raw samples")));
        }
        if self.short(self.raw, PLANAR).unwrap_or(1) != 1 {
            return Err(unsupported("planar raw samples"));
        }
        let compression = self.short(self.raw, COMPRESSION).unwrap_or(1);
        // Chunks: tiles, or strips as tiles one image wide.
        let tiled = self.short(self.raw, TILE_WIDTH).is_some();
        let (tw, th, offsets, counts) = if tiled {
            (
                self.short(self.raw, TILE_WIDTH).unwrap_or(0) as usize,
                self.short(self.raw, TILE_LENGTH).unwrap_or(0) as usize,
                self.numbers(self.raw, TILE_OFFSETS),
                self.numbers(self.raw, TILE_BYTE_COUNTS),
            )
        } else {
            (
                w,
                (self.short(self.raw, ROWS_PER_STRIP).unwrap_or(h as u32) as usize).min(h),
                self.numbers(self.raw, STRIP_OFFSETS),
                self.numbers(self.raw, STRIP_BYTE_COUNTS),
            )
        };
        let (Some(offsets), Some(counts)) = (offsets, counts) else {
            return Err(malformed("a raw image without strips or tiles"));
        };
        if tw == 0 || th == 0 {
            return Err(malformed("a zero tile size"));
        }
        let across = w.div_ceil(tw);
        let down = h.div_ceil(th);
        if offsets.len() < across * down || counts.len() < across * down {
            return Err(malformed("fewer strips or tiles than the image needs"));
        }
        let mut out = vec![0u16; w * h * spp];
        for ty in 0..down {
            for tx in 0..across {
                let i = ty * across + tx;
                let (off, len) = (offsets[i] as usize, counts[i] as usize);
                let chunk = off
                    .checked_add(len)
                    .and_then(|end| self.bytes.get(off..end))
                    .ok_or_else(|| malformed("a strip or tile runs past the end"))?;
                let rows = if tiled { th } else { th.min(h - ty * th) };
                let tile = match compression {
                    1 => unpack(chunk, tw * spp, rows, bits, self.h.little_endian()),
                    7 => {
                        let f = lj92::decode(chunk).map_err(malformed)?;
                        if f.width * f.height * f.components < tw * rows * spp {
                            return Err(malformed("a lossless JPEG tile smaller than its tile"));
                        }
                        f.samples
                    }
                    8 => return Err(unsupported("compression Deflate (8)")),
                    34892 => return Err(unsupported("compression lossy JPEG (34892)")),
                    52546 => return Err(unsupported("compression JPEG XL (52546)")),
                    n => return Err(unsupported(format!("compression {n}"))),
                };
                for r in 0..rows {
                    let y = ty * th + r;
                    if y >= h {
                        break;
                    }
                    let x0 = tx * tw;
                    let n = tw.min(w - x0) * spp;
                    let src = tile
                        .get(r * tw * spp..r * tw * spp + n)
                        .ok_or_else(|| malformed("a short strip or tile"))?;
                    out[(y * w + x0) * spp..(y * w + x0) * spp + n].copy_from_slice(src);
                }
            }
        }
        Ok(out)
    }
}

/// Uncompressed samples of `bits` bits, `per_row` to a row padded to a
/// byte: 8 and 16 bits in the file's byte order, other depths packed
/// most significant bit first.
fn unpack(src: &[u8], per_row: usize, rows: usize, bits: u32, le: bool) -> Vec<u16> {
    let mut out = Vec::with_capacity(per_row * rows);
    match bits {
        8 => {
            for r in 0..rows {
                for i in 0..per_row {
                    out.push(u16::from(src.get(r * per_row + i).copied().unwrap_or(0)));
                }
            }
        }
        16 => {
            for i in 0..per_row * rows {
                let s = [
                    src.get(i * 2).copied().unwrap_or(0),
                    src.get(i * 2 + 1).copied().unwrap_or(0),
                ];
                out.push(if le {
                    u16::from_le_bytes(s)
                } else {
                    u16::from_be_bytes(s)
                });
            }
        }
        _ => {
            let stride = (per_row * bits as usize).div_ceil(8);
            for r in 0..rows {
                let row = src.get(r * stride..).unwrap_or(&[]);
                let mut acc = 0u32;
                let mut have = 0u32;
                let mut at = 0usize;
                for _ in 0..per_row {
                    while have < bits {
                        acc = (acc << 8) | u32::from(row.get(at).copied().unwrap_or(0));
                        at += 1;
                        have += 8;
                    }
                    have -= bits;
                    out.push(((acc >> have) & ((1 << bits) - 1)) as u16);
                }
            }
        }
    }
    out
}

pub(crate) fn probe(bytes: &[u8], page: usize) -> Result<RasterInfo> {
    if page != 0 {
        return Err(Error::PageOutOfRange { page, count: 1 });
    }
    Dng::open(bytes)?.info()
}

pub(crate) fn decode(bytes: &[u8], opts: DecodeOptions) -> Result<RasterImage> {
    if opts.page != 0 {
        return Err(Error::PageOutOfRange {
            page: opts.page,
            count: 1,
        });
    }
    let d = Dng::open(bytes)?;
    let mut info = d.info()?;
    for tag in OPCODE_LISTS {
        if d.h.entry(bytes, d.raw, tag).is_some() || d.h.entry(bytes, d.ifd0, tag).is_some() {
            tracing::debug!(tag, "DNG opcode list not applied");
        }
    }
    if d.h.entry(bytes, d.ifd0, ICC).is_some() {
        tracing::debug!("DNG AsShotICCProfile not applied");
    }
    let (w, h) = d.size()?;
    let spp = d.spp();
    let photometric = d.short(d.raw, PHOTOMETRIC).unwrap_or(0);
    let raw = d.samples()?;

    // 1. Linear 0..1 inside the active area.
    let [top, left, bottom, right] = d.active_area(w, h);
    let (aw, ah) = (right - left, bottom - top);
    let lin = linear(&d, &raw, w, spp, [top, left, bottom, right])?;

    // 2. Camera RGB per pixel.
    let mut cam: Vec<[f32; 3]> = if photometric == CFA {
        if spp != 1 {
            return Err(unsupported(format!(
                "a CFA image of {spp} samples per pixel"
            )));
        }
        if d.short(d.raw, CFA_LAYOUT).unwrap_or(1) != 1 {
            return Err(unsupported("a CFA layout other than rectangular"));
        }
        let pattern = cfa_pattern(&d)?;
        demosaic(&lin, aw, ah, &pattern)
    } else if spp >= 3 {
        lin.chunks_exact(spp).map(|p| [p[0], p[1], p[2]]).collect()
    } else if spp == 1 {
        lin.iter().map(|v| [*v, *v, *v]).collect()
    } else {
        return Err(unsupported(format!("LinearRaw of {spp} samples per pixel")));
    };

    // 3./4. White balance, exposure and the colour matrix.
    let gray = info.color_model == ColorModel::Gray;
    let xform = if gray { None } else { camera_to_srgb(&d) };
    let neutral = d
        .any(AS_SHOT_NEUTRAL)
        .filter(|n| n.len() >= 3 && n.iter().all(|v| *v > 0.0));
    let mut wb = match &neutral {
        Some(n) => [1.0 / n[0], 1.0 / n[1], 1.0 / n[2]],
        None => [1.0; 3],
    };
    let least = wb.iter().cloned().fold(f64::INFINITY, f64::min);
    wb.iter_mut().for_each(|m| *m /= least);
    let gain = 2f64.powf(d.any(BASELINE_EXPOSURE).map_or(0.0, |v| v[0]));
    let m: [[f32; 3]; 3] = {
        let base = xform.unwrap_or([[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]]);
        let mut m = [[0f32; 3]; 3];
        for (r, row) in m.iter_mut().enumerate() {
            for (c, v) in row.iter_mut().enumerate() {
                *v = (base[r][c] * wb[c] * gain) as f32;
            }
        }
        m
    };
    for p in cam.iter_mut() {
        let [r, g, b] = *p;
        *p = [
            m[0][0] * r + m[0][1] * g + m[0][2] * b,
            m[1][0] * r + m[1][1] * g + m[1][2] * b,
            m[2][0] * r + m[2][1] * g + m[2][2] * b,
        ];
    }

    // 5. Crop, encode.
    let (cx, cy, cw, ch) = d.default_crop(aw, ah);
    let channels = if gray { 1 } else { 3 };
    let mut out = Vec::with_capacity(cw * ch * channels);
    let enc = |v: f32| (srgb_encode(v.clamp(0.0, 1.0)) * 65535.0).round() as u16;
    for y in cy..cy + ch {
        for x in cx..cx + cw {
            let p = cam[y * aw + x];
            if gray {
                out.push(enc(p[0]));
            } else {
                out.extend_from_slice(&[enc(p[0]), enc(p[1]), enc(p[2])]);
            }
        }
    }
    info.width = cw as u32;
    info.height = ch as u32;
    let k = shrink::factor(cw as u32, ch as u32, opts.max_dim);
    let (data, ow, oh) = shrink::shrink(Samples::U16(out), cw as u32, ch as u32, channels, k);
    Ok(RasterImage {
        info,
        width: ow,
        height: oh,
        model: if gray {
            ColorModel::Gray
        } else {
            ColorModel::Rgb
        },
        alpha: Alpha::None,
        data,
    })
}

/// The samples of the active area, linearised and scaled to 0..1 by the
/// black and white levels.
fn linear(d: &Dng, raw: &[u16], w: usize, spp: usize, area: [usize; 4]) -> Result<Vec<f32>> {
    let [top, left, bottom, right] = area;
    let (aw, ah) = (right - left, bottom - top);
    let bits = d.short(d.raw, BITS).unwrap_or(16);
    let table = d.numbers(d.raw, LINEARIZATION);
    let (br, bc) = match d.numbers(d.raw, BLACK_REPEAT_DIM).as_deref() {
        Some([r, c]) if *r >= 1.0 && *c >= 1.0 => (*r as usize, *c as usize),
        _ => (1, 1),
    };
    let black = d.numbers(d.raw, BLACK_LEVEL).unwrap_or_else(|| vec![0.0]);
    let delta_h = d.numbers(d.raw, BLACK_DELTA_H).unwrap_or_default();
    let delta_v = d.numbers(d.raw, BLACK_DELTA_V).unwrap_or_default();
    let white = d
        .numbers(d.raw, WHITE_LEVEL)
        .unwrap_or_else(|| vec![f64::from((1u32 << bits) - 1)]);
    let mut out = Vec::with_capacity(aw * ah * spp);
    for y in 0..ah {
        for x in 0..aw {
            for c in 0..spp {
                let v = f64::from(raw[((top + y) * w + left + x) * spp + c]);
                let v = match &table {
                    Some(t) => t[(v as usize).min(t.len() - 1)],
                    None => v,
                };
                let bi = ((y % br) * bc + x % bc) * spp + c;
                let b = black.get(bi).or(black.first()).copied().unwrap_or(0.0)
                    + delta_h.get(x).copied().unwrap_or(0.0)
                    + delta_v.get(y).copied().unwrap_or(0.0);
                let wl = white.get(c).or(white.first()).copied().unwrap_or(65535.0);
                let range = (wl - b).max(1.0);
                out.push(((v - b) / range) as f32);
            }
        }
    }
    Ok(out)
}

/// The CFA repeat pattern as colour indices 0 (red), 1 (green), 2 (blue).
struct Pattern {
    rows: usize,
    cols: usize,
    colour: Vec<u8>,
}

impl Pattern {
    fn at(&self, x: usize, y: usize) -> u8 {
        self.colour[(y % self.rows) * self.cols + x % self.cols]
    }
}

fn cfa_pattern(d: &Dng) -> Result<Pattern> {
    let (rows, cols) = match d.numbers(d.raw, CFA_REPEAT_DIM).as_deref() {
        Some([r, c]) if (1.0..=16.0).contains(r) && (1.0..=16.0).contains(c) => {
            (*r as usize, *c as usize)
        }
        _ => return Err(malformed("a CFA image without CFARepeatPatternDim")),
    };
    let pattern = d
        .numbers(d.raw, CFA_PATTERN)
        .filter(|p| p.len() >= rows * cols)
        .ok_or_else(|| malformed("a CFA image without CFAPattern"))?;
    let planes = d
        .numbers(d.raw, CFA_PLANE_COLOR)
        .unwrap_or_else(|| vec![0.0, 1.0, 2.0]);
    let mut colour = Vec::with_capacity(rows * cols);
    for p in &pattern[..rows * cols] {
        let c = planes.get(*p as usize).copied().unwrap_or(*p);
        if !(0.0..=2.0).contains(&c) {
            return Err(unsupported(
                "a CFA with colours other than red, green and blue",
            ));
        }
        colour.push(c as u8);
    }
    for c in 0..3u8 {
        if !colour.contains(&c) {
            return Err(unsupported("a CFA pattern missing one of red, green, blue"));
        }
    }
    Ok(Pattern { rows, cols, colour })
}

/// Bilinear demosaic: each colour a pixel lacks is the mean of that
/// colour's samples among its 3x3 neighbours, or 5x5 when the 3x3 has
/// none.
fn demosaic(lin: &[f32], w: usize, h: usize, p: &Pattern) -> Vec<[f32; 3]> {
    let mut out = vec![[0f32; 3]; w * h];
    for y in 0..h {
        for x in 0..w {
            let own = p.at(x, y) as usize;
            let mut px = [0f32; 3];
            px[own] = lin[y * w + x];
            for (c, slot) in px.iter_mut().enumerate() {
                if c == own {
                    continue;
                }
                for radius in [1isize, 2] {
                    let (mut sum, mut n) = (0f32, 0u32);
                    for dy in -radius..=radius {
                        for dx in -radius..=radius {
                            let (sx, sy) = (x as isize + dx, y as isize + dy);
                            if sx < 0 || sy < 0 || sx >= w as isize || sy >= h as isize {
                                continue;
                            }
                            let (sx, sy) = (sx as usize, sy as usize);
                            if p.at(sx, sy) as usize == c {
                                sum += lin[sy * w + sx];
                                n += 1;
                            }
                        }
                    }
                    if n > 0 {
                        *slot = sum / n as f32;
                        break;
                    }
                }
            }
            out[y * w + x] = px;
        }
    }
    out
}

/// Camera RGB to linear sRGB from the ColorMatrix (dcraw's derivation),
/// `None` without a usable matrix.
fn camera_to_srgb(d: &Dng) -> Option<[[f64; 3]; 3]> {
    let m1 = d.numbers(d.ifd0, COLOR_MATRIX_1).filter(|m| m.len() >= 9);
    let m2 = d.numbers(d.ifd0, COLOR_MATRIX_2).filter(|m| m.len() >= 9);
    let ill = |tag| d.numbers(d.ifd0, tag).map(|v| v[0]);
    let m = match (m1, m2) {
        (Some(a), Some(b)) => {
            if ill(ILLUMINANT_1) == Some(D65) && ill(ILLUMINANT_2) != Some(D65) {
                a
            } else {
                b
            }
        }
        (Some(a), None) => a,
        (None, Some(b)) => b,
        (None, None) => return None,
    };
    let cam_xyz = [[m[0], m[1], m[2]], [m[3], m[4], m[5]], [m[6], m[7], m[8]]];
    let mut cam_rgb = [[0f64; 3]; 3];
    for r in 0..3 {
        for c in 0..3 {
            cam_rgb[r][c] = (0..3).map(|k| cam_xyz[r][k] * XYZ_RGB[k][c]).sum();
        }
        let sum: f64 = cam_rgb[r].iter().sum();
        if sum.abs() < 1e-9 {
            return None;
        }
        cam_rgb[r].iter_mut().for_each(|v| *v /= sum);
    }
    invert(cam_rgb)
}

fn invert(m: [[f64; 3]; 3]) -> Option<[[f64; 3]; 3]> {
    let det = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
        - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
        + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    if det.abs() < 1e-12 {
        return None;
    }
    let c = |a: usize, b: usize, cc: usize, dd: usize| m[a][b] * m[cc][dd] - m[a][dd] * m[cc][b];
    Some([
        [
            c(1, 1, 2, 2) / det,
            -c(0, 1, 2, 2) / det,
            c(0, 1, 1, 2) / det,
        ],
        [
            -c(1, 0, 2, 2) / det,
            c(0, 0, 2, 2) / det,
            -c(0, 0, 1, 2) / det,
        ],
        [
            c(1, 0, 2, 1) / det,
            -c(0, 0, 2, 1) / det,
            c(0, 0, 1, 1) / det,
        ],
    ])
}

/// The sRGB transfer curve, linear light to encoded.
pub(crate) fn srgb_encode(v: f32) -> f32 {
    if v <= 0.003_130_8 {
        v * 12.92
    } else {
        1.055 * v.powf(1.0 / 2.4) - 0.055
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inverse_is_inverse() {
        let m = [[2.0, 0.5, 0.1], [0.3, 1.5, 0.2], [0.0, 0.4, 1.2]];
        let inv = invert(m).unwrap();
        for (r, row) in m.iter().enumerate() {
            for c in 0..3 {
                let v: f64 = row.iter().zip(&inv).map(|(a, col)| a * col[c]).sum();
                assert!((v - f64::from(u8::from(r == c))).abs() < 1e-9);
            }
        }
    }

    #[test]
    fn packed_samples_unpack_msb_first() {
        // Two 12-bit samples: 0xABC, 0x123.
        assert_eq!(unpack(&[0xAB, 0xC1, 0x23], 2, 1, 12, true), [0xABC, 0x123]);
        assert_eq!(unpack(&[0x34, 0x12], 1, 1, 16, true), [0x1234]);
        assert_eq!(unpack(&[0x12, 0x34], 1, 1, 16, false), [0x1234]);
    }
}
