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

//! Merged-composite decode (the M4 ingest slice of spec §10.4): turn the
//! [`GlobalImageData`] section — every PSD's embedded render oracle —
//! into interleaved RGBA8 pixels for the editor placement path
//! (C-5 bytes in → decode → adjust → C-1 scene-layer composite).
//!
//! Scope: 8- and 16-bit (reduced, reported) RGB[A] and Grayscale[+A]
//! through [`PsdFile::composite_rgba8`]; 8- and 16-bit CMYK[+A] through
//! [`PsdFile::composite_cmyk8`], which hands back INK (the conversion to
//! RGB needs the file's ICC profile and a CMS, and lives in `image-js`).
//! RAW (0) and RLE (1) compression, PSD and PSB count-table widths.
//! 1/32-bit, Lab/Indexed/Bitmap/Duotone and ZIP-compressed composites
//! answer [`PsdError::Unsupported`]. The PRESERVATION model is untouched: this is a pure
//! READ over the already-parsed section (the verbatim re-emit guarantees
//! hold regardless of whether the composite decodes).
//!
//! Alpha: the merged composite's first extra channel is transparency
//! ONLY when the layer-count sign flag said so
//! (`LayerAndMaskInfo::transparency_in_merged`); otherwise extra
//! channels are alpha/spot channels and the merged result is opaque
//! (Adobe Photoshop File Format specification — Layer Info, "If it is a
//! negative number, its absolute value is the number of layers and the
//! first alpha channel contains the transparency data").

use crate::compression::packbits;
use crate::model::{ColorMode, PsdFile};
use crate::{Container, PsdError, Result};

/// A decoded merged composite: tightly packed, interleaved RGBA8.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompositeRgba8 {
    pub width: u32,
    pub height: u32,
    /// `width * height * 4` bytes, row-major RGBA, straight alpha.
    pub rgba: Vec<u8>,
    /// The source was 16 bits per channel and was REDUCED to 8 here.
    ///
    /// Reported rather than hidden, and reported rather than refused.
    /// Refusing was the previous behaviour and it meant a 16-bit scan
    /// simply could not be opened; reducing silently would be worse
    /// still. The consumer states it, the same way the CMS lane states
    /// "sRGB assumed" instead of pretending it managed colour.
    pub depth_reduced: bool,
}

/// Composite compression codes (Image Data Section). The section is one
/// tag for ALL channels, unlike per-layer channels — RAW stores the
/// planes back to back; RLE prefixes ONE count table covering every
/// channel's scanlines (`channels * height` entries), then the packed
/// scanlines in channel-major order.
const COMPRESSION_RAW: u16 = 0;
const COMPRESSION_RLE: u16 = 1;

/// What resource 0x0421 (version info) says about the merged composite.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MergedData {
    /// `hasRealMergedData` = 1: the composite is Photoshop's own render.
    Real,
    /// `hasRealMergedData` = 0: the composite is a placeholder (the file
    /// was saved without "maximize compatibility").
    NotReal,
    /// No 0x0421 resource at all — nothing vouches for the composite.
    Absent,
}

impl MergedData {
    pub fn as_str(self) -> &'static str {
        match self {
            MergedData::Real => "real",
            MergedData::NotReal => "flag-false",
            MergedData::Absent => "no-version-info",
        }
    }
}

/// Version-info resource id (Adobe Photoshop File Format specification,
/// Image Resource IDs: 0x0421 "Version Info … hasRealMergedData").
pub const RESOURCE_VERSION_INFO: u16 = 0x0421;

impl PsdFile {
    /// Read `hasRealMergedData` from the retained 0x0421 block.
    ///
    /// The block is kept verbatim (`raw_block`: signature, id, padded
    /// Pascal name, u32 size, data); the data is `u32 version`, then the
    /// flag byte.
    pub fn merged_data(&self) -> MergedData {
        let Some(block) = self
            .resources
            .blocks
            .iter()
            .find(|b| b.id == RESOURCE_VERSION_INFO)
        else {
            return MergedData::Absent;
        };
        let Some(raw) = block.raw_block.as_deref() else {
            return MergedData::Absent;
        };
        // 4 sig + 2 id, then the Pascal name padded to an even total.
        let Some(&name_len) = raw.get(6) else {
            return MergedData::Absent;
        };
        let name_total = (1 + name_len as usize).next_multiple_of(2);
        let data_at = 6 + name_total + 4;
        match raw.get(data_at + 4) {
            Some(0) => MergedData::NotReal,
            Some(_) => MergedData::Real,
            None => MergedData::Absent,
        }
    }

    /// Decode the merged composite to straight RGBA8. See the module
    /// docs for the supported subset; everything outside it is a clean
    /// [`PsdError::Unsupported`] (never a wrong-looking image).
    pub fn composite_rgba8(&self) -> Result<CompositeRgba8> {
        let h = &self.header;
        // 16-BIT IS ACCEPTED, REDUCED AND REPORTED — not refused. The
        // layer stack downstream is 8-bit, so the extra precision cannot
        // survive anyway; what the refusal actually bought was "this
        // file will not open at all", which is the worse of the two
        // honest options. The reduction takes the HIGH byte, which is
        // the correct nearest-8-bit reading of a 16-bit sample.
        if h.depth != 8 && h.depth != 16 {
            return Err(PsdError::Unsupported(format!(
                "composite decode at depth {} (8- and 16-bit only; 1-bit and \
                 32-bit float are separate lanes)",
                h.depth
            )));
        }
        let color_channels: usize = match h.color_mode {
            ColorMode::Rgb => 3,
            ColorMode::Grayscale => 1,
            ColorMode::Cmyk => {
                return Err(PsdError::Unsupported(
                    "composite decode for color mode Cmyk to RGBA8 needs a colour \
                     transform: read the ink with `composite_cmyk8` and convert it \
                     through the file's profile (image-js does)"
                        .into(),
                ));
            }
            other => {
                return Err(PsdError::Unsupported(format!(
                    "composite decode for color mode {other:?} (RGB/Grayscale, and CMYK \
                     through `composite_cmyk8`; Lab and the indexed modes are not decoded)"
                )));
            }
        };
        if (h.channels as usize) < color_channels {
            return Err(PsdError::Malformed {
                section: "image data",
                detail: format!(
                    "{:?} needs {color_channels} channel(s), header says {}",
                    h.color_mode, h.channels
                ),
            });
        }

        let planes = decode_planes(self)?;
        let depth_reduced = h.depth == 16;

        // The first channel BEYOND the color channels is transparency
        // exactly when the layer-count sign flag declared it.
        let alpha = if self.layer_mask.transparency_in_merged {
            planes.get(color_channels)
        } else {
            None
        };

        let (w, hh) = (h.width as usize, h.height as usize);
        let n = w * hh;
        let mut rgba = vec![0u8; n * 4];
        for i in 0..n {
            let (r, g, b) = match h.color_mode {
                ColorMode::Rgb => (planes[0][i], planes[1][i], planes[2][i]),
                // Grayscale: replicate the single plane.
                _ => (planes[0][i], planes[0][i], planes[0][i]),
            };
            let a = alpha.map_or(255, |p| p[i]);
            // Photoshop stores a transparent merged image MATTED against
            // white: stored = colour·α + 255·(1 − α). Undo it, so the
            // decode is straight colour like every other source (left
            // matted, every soft edge of a placed PSD came in lightened
            // toward white — up to ~200 levels at low alpha, measured
            // against Photoshop's own export).
            let unmatte = |v: u8| unmatte_white(v, a);
            let o = i * 4;
            rgba[o] = unmatte(r);
            rgba[o + 1] = unmatte(g);
            rgba[o + 2] = unmatte(b);
            rgba[o + 3] = a;
        }
        Ok(CompositeRgba8 {
            width: h.width,
            height: h.height,
            rgba,
            depth_reduced,
        })
    }
}

/// A decoded CMYK merged composite: the INK, not a colour. Turning ink
/// into RGB needs the file's ICC profile and a CMS, which this crate
/// deliberately does not have (it is plain data); `image-js` converts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompositeCmyk8 {
    pub width: u32,
    pub height: u32,
    /// `width * height * 4` bytes, row-major, interleaved C, M, Y, K as
    /// INK AMOUNTS: 0 = no ink (paper), 255 = 100 % ink. The file stores
    /// the inverse (see [`PsdFile::composite_cmyk8`]); this is already
    /// flipped, so it is the convention an ICC CMYK device profile and
    /// `image-js`'s ink cast expect.
    pub cmyk: Vec<u8>,
    /// Straight transparency, one byte per pixel, when the document has
    /// it (the layer-count sign flag); `None` = opaque. The ink above is
    /// already UN-MATTED, so it is straight colour like `alpha` is.
    pub alpha: Option<Vec<u8>>,
    /// The source was 16 bits per channel and was REDUCED to 8 here.
    pub depth_reduced: bool,
}

impl PsdFile {
    /// Decode a CMYK document's merged composite to straight 4-ink CMYK8.
    ///
    /// INK POLARITY. A CMYK PSD stores every ink plane INVERTED: 255 (or
    /// 65535) is NO ink, 0 is 100 % ink. Measured, not assumed — the
    /// `patches` fixture Photoshop recorded (`modules/image/image-conformance/fixtures/
    /// photoshop/cmyk-stacks`) fills known ink percentages, and its
    /// paper-white patch stores 255 in all four planes while 100 % cyan
    /// stores 0 in the cyan plane. This flips it back to ink amounts.
    ///
    /// CHANNELS. The header's channel count is 4 inks plus extras; the
    /// first extra is transparency exactly when the layer-count sign flag
    /// says so (the same rule as RGB). Any other extra channel — a saved
    /// selection, a spot plate — is ignored: it has no composite meaning
    /// in the merged image (the fixture carries one saved alpha channel
    /// and an opaque merged image).
    ///
    /// MATTE. A transparent document's merged composite is matted against
    /// the paper, i.e. against NO ink, which in the stored (inverted)
    /// numbers is 255 — so the stored values obey the same
    /// `v·α + 255·(1 − α)` the RGB composite does, and are un-matted the
    /// same way before the flip.
    ///
    /// 16-bit is accepted, reduced to the high byte and reported, exactly
    /// as for RGB.
    pub fn composite_cmyk8(&self) -> Result<CompositeCmyk8> {
        let h = &self.header;
        if h.color_mode != ColorMode::Cmyk {
            return Err(PsdError::Unsupported(format!(
                "composite_cmyk8 on a {:?} document",
                h.color_mode
            )));
        }
        if h.depth != 8 && h.depth != 16 {
            return Err(PsdError::Unsupported(format!(
                "composite decode at depth {} (8- and 16-bit only; 1-bit and \
                 32-bit float are separate lanes)",
                h.depth
            )));
        }
        if h.channels < 4 {
            return Err(PsdError::Malformed {
                section: "image data",
                detail: format!("Cmyk needs 4 channel(s), header says {}", h.channels),
            });
        }
        let planes = decode_planes(self)?;
        let alpha = if self.layer_mask.transparency_in_merged {
            planes.get(4).cloned()
        } else {
            None
        };
        let n = (h.width as usize) * (h.height as usize);
        let mut cmyk = vec![0u8; n * 4];
        for i in 0..n {
            let a = alpha.as_ref().map_or(255, |p| p[i]);
            for c in 0..4 {
                cmyk[i * 4 + c] = 255 - unmatte_white(planes[c][i], a);
            }
        }
        Ok(CompositeCmyk8 {
            width: h.width,
            height: h.height,
            cmyk,
            alpha,
            depth_reduced: h.depth == 16,
        })
    }
}

/// A merged composite in the document's OWN numbers, whatever its mode
/// and depth ([`PsdFile::composite_samples`]): what a consumer with a
/// colour engine converts (Lab, Grayscale, Indexed through its colour
/// table, Multichannel, Duotone as its grey) — this crate has none.
#[derive(Debug, Clone, PartialEq)]
pub struct CompositeSamples {
    pub width: u32,
    pub height: u32,
    pub mode: ColorMode,
    /// Bits per sample as stored: 8, 16 or 32 (float).
    pub depth: u16,
    /// Colour channels a pixel: 1 for Grayscale, Indexed and Duotone, 3
    /// for RGB and Lab, 4 for CMYK, every channel for Multichannel.
    pub channels: usize,
    /// Interleaved, `channels` a pixel, as STORED and normalised: an
    /// integer sample is `v / (2^depth − 1)` (an index stays its byte
    /// over 255; CMYK is the stored ink BRIGHTNESS, 1 = no ink; Lab is
    /// L* over the full range and a*, b* about the middle), a 32-bit one
    /// is the float itself (linear light). Un-matted when `alpha` is set.
    pub samples: Vec<f32>,
    /// Straight transparency (the first extra channel, when the layer
    /// count's sign says so), normalised.
    pub alpha: Option<Vec<f32>>,
}

impl PsdFile {
    /// The merged composite as the file stores it, for every mode but
    /// Bitmap, at 8, 16 or 32 bits ([`CompositeSamples`]). RAW at any
    /// depth, RLE at 8 bits (the encodings Photoshop writes a composite
    /// in; a ZIP composite and 16-bit RLE are refused as in
    /// [`composite_rgba8`](Self::composite_rgba8)).
    ///
    /// A transparent document's composite is matted against WHITE in the
    /// stored numbers (`v·α + white·(1 − α)`: 1 for every channel but
    /// Lab's a* and b*, whose white is their middle) and is un-matted
    /// here, as the RGB and CMYK decodes do.
    pub fn composite_samples(&self) -> Result<CompositeSamples> {
        let h = &self.header;
        if !matches!(h.depth, 8 | 16 | 32) {
            return Err(PsdError::Unsupported(format!(
                "composite decode at depth {} (8, 16 and 32 bits)",
                h.depth
            )));
        }
        let channels = match h.color_mode {
            ColorMode::Grayscale | ColorMode::Indexed | ColorMode::Duotone => 1,
            ColorMode::Rgb | ColorMode::Lab => 3,
            ColorMode::Cmyk => 4,
            ColorMode::Multichannel => h.channels as usize,
            ColorMode::Bitmap => {
                return Err(PsdError::Unsupported(
                    "composite decode of a Bitmap (1-bit) document".into(),
                ))
            }
        };
        if (h.channels as usize) < channels || channels == 0 {
            return Err(PsdError::Malformed {
                section: "image data",
                detail: format!(
                    "{:?} needs {channels} channel(s), header says {}",
                    h.color_mode, h.channels
                ),
            });
        }
        let planes = decode_planes_f32(self)?;
        let alpha =
            if self.layer_mask.transparency_in_merged && h.color_mode != ColorMode::Multichannel {
                planes.get(channels).cloned()
            } else {
                None
            };
        let n = (h.width as usize) * (h.height as usize);
        let mid = if h.depth == 16 {
            32768.0 / 65535.0
        } else {
            128.0 / 255.0
        };
        let white = |c: usize| -> f32 {
            if h.color_mode == ColorMode::Lab && c > 0 {
                mid
            } else {
                1.0
            }
        };
        let mut samples = Vec::with_capacity(n * channels);
        for i in 0..n {
            let a = alpha.as_ref().map_or(1.0, |p| p[i].clamp(0.0, 1.0));
            for (c, plane) in planes.iter().take(channels).enumerate() {
                let v = plane[i];
                samples.push(if a >= 1.0 {
                    v
                } else if a <= 0.0 {
                    0.0
                } else {
                    let w = white(c);
                    let u = (v - w * (1.0 - a)) / a;
                    if h.depth == 32 {
                        u
                    } else {
                        u.clamp(0.0, 1.0)
                    }
                });
            }
        }
        Ok(CompositeSamples {
            width: h.width,
            height: h.height,
            mode: h.color_mode,
            depth: h.depth,
            channels,
            samples,
            alpha,
        })
    }

    /// The colour table of an Indexed document (the Color Mode Data
    /// section: 256 reds, then 256 greens, then 256 blues), with the
    /// transparent index (resource 1047) when there is one.
    pub fn indexed_palette(&self) -> Option<IndexedPalette> {
        if self.header.color_mode != ColorMode::Indexed {
            return None;
        }
        let raw = &self.color_mode.raw;
        if raw.len() < 768 {
            return None;
        }
        let colours = (0..256)
            .map(|i| [raw[i], raw[256 + i], raw[512 + i]])
            .collect();
        let count = self
            .resources
            .data(RESOURCE_INDEXED_COUNT)
            .and_then(|d| d.get(..2))
            .map(|d| usize::from(u16::from_be_bytes([d[0], d[1]])));
        let transparent = self
            .resources
            .data(RESOURCE_TRANSPARENT_INDEX)
            .and_then(|d| d.get(..2))
            .map(|d| u16::from_be_bytes([d[0], d[1]]));
        Some(IndexedPalette {
            colours,
            count,
            transparent,
        })
    }
}

/// Resource 1046: the number of colours an Indexed table holds.
const RESOURCE_INDEXED_COUNT: u16 = 1046;
/// Resource 1047: the index that is transparent.
const RESOURCE_TRANSPARENT_INDEX: u16 = 1047;

/// An Indexed document's colour table ([`PsdFile::indexed_palette`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IndexedPalette {
    /// 256 sRGB-as-stored colours (the table is always 768 bytes).
    pub colours: Vec<[u8; 3]>,
    /// How many of them are used (resource 1046), when the file says.
    pub count: Option<usize>,
    /// The transparent index (resource 1047; 0xFFFF = none), when said.
    pub transparent: Option<u16>,
}

/// [`decode_planes`] normalised to `0..=1` floats, at full depth: RAW at
/// 8, 16 and 32 bits, RLE at 8.
fn decode_planes_f32(file: &PsdFile) -> Result<Vec<Vec<f32>>> {
    let h = &file.header;
    if file.composite.compression != COMPRESSION_RAW || h.depth == 8 {
        if h.depth == 32 {
            return Err(PsdError::Unsupported(format!(
                "32-bit composite with compression {} (RAW is read)",
                file.composite.compression
            )));
        }
        let max = 255.0;
        return Ok(decode_planes(file)?
            .into_iter()
            .map(|p| p.into_iter().map(|v| f32::from(v) / max).collect())
            .collect());
    }
    let channels = h.channels as usize;
    let plane_len = (h.width as usize)
        .checked_mul(h.height as usize)
        .ok_or_else(|| malformed("composite plane size overflows usize"))?;
    let sample = usize::from(h.depth / 8);
    let stride = plane_len * sample;
    let data = &file.composite.raw;
    if data.len() != stride * channels {
        return Err(malformed(format!(
            "RAW composite is {} byte(s), expected {}",
            data.len(),
            stride * channels
        )));
    }
    Ok((0..channels)
        .map(|c| {
            let plane = &data[c * stride..(c + 1) * stride];
            match h.depth {
                16 => plane
                    .as_chunks::<2>()
                    .0
                    .iter()
                    .map(|s| f32::from(u16::from_be_bytes(*s)) / 65535.0)
                    .collect(),
                _ => plane
                    .as_chunks::<4>()
                    .0
                    .iter()
                    .map(|s| f32::from_be_bytes(*s))
                    .collect(),
            }
        })
        .collect())
}

/// Undo the merged composite's matte against white (`v·α + 255·(1 − α)`
/// on the STORED value). Fully transparent pixels answer 0.
fn unmatte_white(v: u8, a: u8) -> u8 {
    match a {
        255 => v,
        0 => 0,
        _ => {
            let al = f32::from(a) / 255.0;
            ((f32::from(v) - 255.0 * (1.0 - al)) / al)
                .round()
                .clamp(0.0, 255.0) as u8
        }
    }
}

/// Decode every channel of the composite section into planar 8-bit
/// buffers (`width * height` each), channel-major as stored.
fn decode_planes(file: &PsdFile) -> Result<Vec<Vec<u8>>> {
    let h = &file.header;
    let channels = h.channels as usize;
    let rows = h.height as usize;
    let cols = h.width as usize;
    let plane_len = rows.checked_mul(cols).ok_or_else(|| PsdError::Malformed {
        section: "image data",
        detail: format!("plane size {rows}×{cols} overflows usize"),
    })?;
    // Bytes per SAMPLE on the wire. The planes this returns are always
    // 8-bit; a 16-bit source is reduced as it is read.
    let sample_bytes = if h.depth == 16 { 2 } else { 1 };
    let data = &file.composite.raw;

    match file.composite.compression {
        COMPRESSION_RAW => {
            let stride = plane_len
                .checked_mul(sample_bytes)
                .ok_or_else(|| malformed("RAW composite plane size overflows usize"))?;
            let expect = stride
                .checked_mul(channels)
                .ok_or_else(|| malformed("RAW composite size overflows usize"))?;
            if data.len() != expect {
                return Err(malformed(format!(
                    "RAW composite is {} byte(s), expected {expect}",
                    data.len()
                )));
            }
            Ok((0..channels)
                .map(|c| {
                    let plane = &data[c * stride..(c + 1) * stride];
                    if sample_bytes == 1 {
                        plane.to_vec()
                    } else {
                        // BIG-ENDIAN 16-bit samples; the high byte IS
                        // the 8-bit value.
                        plane.as_chunks::<2>().0.iter().map(|s| s[0]).collect()
                    }
                })
                .collect())
        }
        COMPRESSION_RLE if h.depth == 16 => {
            // REFUSED, with the same evidence the per-layer reader
            // gives: no corpus fixture is 16-bit at all, and whether the
            // row table counts compressed bytes of 16-bit samples or
            // Photoshop splits high and low planes is unresolved.
            // Guessing would produce a wrong-looking image, which is the
            // one outcome worse than a refusal.
            Err(PsdError::Unsupported(
                "16-bit RLE composite: the row-table semantics for 16-bit \
                 samples are unverified (no corpus fixture), and a guess \
                 would decode to a wrong-looking image"
                    .into(),
            ))
        }
        COMPRESSION_RLE => {
            // ONE count table for all channels' scanlines, then the
            // packed rows back to back, channel-major.
            let count_width = match file.container {
                Container::Psd => 2,
                Container::Psb => 4,
            };
            let table_entries = rows
                .checked_mul(channels)
                .ok_or_else(|| malformed("RLE count table size overflows usize"))?;
            let table_len = table_entries * count_width;
            if data.len() < table_len {
                return Err(malformed(format!(
                    "RLE count table needs {table_len} byte(s), section has {}",
                    data.len()
                )));
            }
            let mut counts = Vec::with_capacity(table_entries);
            for e in 0..table_entries {
                let off = e * count_width;
                let n = match count_width {
                    2 => u16::from_be_bytes([data[off], data[off + 1]]) as usize,
                    _ => {
                        u32::from_be_bytes([data[off], data[off + 1], data[off + 2], data[off + 3]])
                            as usize
                    }
                };
                counts.push(n);
            }
            let packed_total: usize = counts.iter().sum();
            let packed = &data[table_len..];
            // A file may end in ZERO padding past the packed rows: the
            // PSB Photoshop embeds in a new smart object is padded to
            // 1 MiB (image ADR 482) [OBS]. Anything else is a mismatch.
            let padded =
                packed.len() > packed_total && packed[packed_total..].iter().all(|&b| b == 0);
            if packed.len() != packed_total && !padded {
                return Err(malformed(format!(
                    "RLE packed rows total {} byte(s), count table claims {packed_total}",
                    packed.len()
                )));
            }

            let mut planes = Vec::with_capacity(channels);
            let mut src_off = 0usize;
            for c in 0..channels {
                let mut plane = vec![0u8; plane_len];
                for r in 0..rows {
                    let n = counts[c * rows + r];
                    let row_src = &packed[src_off..src_off + n];
                    src_off += n;
                    packbits::decode(row_src, &mut plane[r * cols..r * cols + cols])?;
                }
                planes.push(plane);
            }
            Ok(planes)
        }
        other => Err(PsdError::Unsupported(format!(
            "composite compression {other} (RAW/RLE only in the M4 ingest slice; \
             ZIP composites are the M2 lane)"
        ))),
    }
}

fn malformed(detail: impl Into<String>) -> PsdError {
    PsdError::Malformed {
        section: "image data",
        detail: detail.into(),
    }
}
