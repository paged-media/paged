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

//! Per-channel image data. Stored as the on-disk compressed payload —
//! decode-on-demand (preservation + the 500 MB-PSB streaming budget).
//! RAW (0) and RLE (1) decode↔encode in M0; ZIP (2/3) inflate landed in
//! M1 (the `rendered` tier's data feed). Decode is on-demand: the stored
//! `bytes` (the verbatim on-disk payload, minus the 2-byte compression
//! tag the parser strips) stay canonical and are never mutated by a
//! decode — preservation + zero-edit byte-identity hold regardless.
//!
//! # Decode model (spec §10.4)
//!
//! `ChannelData::decode` produces a *planar* 8-bit buffer of
//! `rows * cols` bytes (one channel plane, row-major):
//!
//! * **RAW (0)** — `bytes` already IS the plane; validate length, copy.
//! * **RLE (1)** — `bytes` = a per-row byte-count table (`u16` in PSD,
//!   `u32` in PSB, one entry per row) followed by the PackBits-packed
//!   rows. Each row decodes to exactly `cols` bytes.
//! * **ZIP (2)** — `bytes` = a zlib stream; inflate to the plane.
//! * **ZIP-with-prediction (3)** — inflate, then undo the per-row
//!   horizontal delta within each row — over bytes at depth 8, over
//!   big-endian 16-bit SAMPLES at depth 16 (Photoshop's 16-bit layers,
//!   read back from its own files). At depth 32 each row's floats are
//!   stored as four BYTE PLANES (every sample's most significant byte,
//!   then every second byte, …) and the delta runs over that row's bytes
//!   [OBS: Photoshop 27.10's own `Lr32` layers, `color-modes/float-32`].
//!   Method 2 just inflates raw bytes for any depth.
//!
//! Provenance: Adobe Photoshop File Format specification, "Channel
//! Image Data"; zlib/DEFLATE (RFC 1950/1951); TIFF horizontal
//! differencing predictor (the prediction model for method 3).

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Compression {
    Raw,
    Rle,
    Zip,
    ZipPrediction,
}

impl Compression {
    pub const fn code(self) -> u16 {
        match self {
            Compression::Raw => 0,
            Compression::Rle => 1,
            Compression::Zip => 2,
            Compression::ZipPrediction => 3,
        }
    }

    pub fn from_code(c: u16) -> Option<Self> {
        Some(match c {
            0 => Compression::Raw,
            1 => Compression::Rle,
            2 => Compression::Zip,
            3 => Compression::ZipPrediction,
            _ => return None,
        })
    }
}

/// One channel's image data: the compression tag + the payload exactly
/// as stored (for RLE this INCLUDES the per-row byte-count table that
/// precedes the packed rows).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChannelData {
    pub compression: Compression,
    pub bytes: Vec<u8>,
}

use crate::compression::packbits;
use crate::{Container, PsdError, Result};

impl ChannelData {
    /// Decode this channel's stored payload into a planar 8-bit buffer
    /// of exactly `rows * cols` bytes (decode-on-demand; `self.bytes`
    /// is not mutated and remains the canonical on-disk form).
    ///
    /// `container` selects the RLE count-table width (`u16`/`u32`).
    /// `depth` is the per-sample bit depth: it is consulted only by
    /// ZIP-with-prediction (method 3), where any depth other than 8 is
    /// `Unsupported` (M2). Method 2 inflates the raw bytes for any depth.
    pub fn decode(
        &self,
        container: Container,
        rows: u32,
        cols: u32,
        depth: u16,
    ) -> Result<Vec<u8>> {
        let plane_len = (rows as usize)
            .checked_mul(cols as usize)
            .ok_or_else(|| malformed(format!("plane size {rows}×{cols} overflows usize")))?;
        match self.compression {
            // A 32-bit plane as 8 bits: the value clamped to 0..=1 (a
            // mask's or a transparency channel's coverage; a colour
            // channel's display view is the caller's, through the transfer).
            _ if depth == 32 => Ok(self
                .decode_samples32(rows, cols)?
                .iter()
                .map(|v| (v.clamp(0.0, 1.0) * 255.0).round() as u8)
                .collect()),
            Compression::Raw => self.decode_raw(plane_len, depth),
            // 16-bit RLE is REFUSED, and on evidence rather than effort:
            // no corpus fixture is 16-bit, and whether the row table
            // counts compressed bytes of 16-bit samples or Photoshop
            // splits high and low byte planes is genuinely unknown (spec
            // §2.4 GAP). RAW has no such ambiguity — its samples are
            // big-endian, the same convention the merged composite reads
            // and a test verifies — which is why one ships and the other
            // does not.
            Compression::Rle if depth == 16 => Err(PsdError::Unsupported(
                "16-bit RLE channel: the row-table semantics for 16-bit samples \
                 are unverified (no corpus fixture), and a guess would decode to \
                 a wrong-looking image"
                    .into(),
            )),
            Compression::Rle => self.decode_rle(container, rows, cols, plane_len),
            Compression::Zip => inflate(&self.bytes, plane_len),
            Compression::ZipPrediction => match depth {
                8 => {
                    let mut plane = inflate(&self.bytes, plane_len)?;
                    undo_prediction_8bit(&mut plane, rows as usize, cols as usize);
                    Ok(plane)
                }
                // 16-bit: the delta runs over big-endian SAMPLES (what
                // Photoshop writes into a 16-bit document's `Lr16`
                // block, checked on its own files); reduced to the high
                // byte like RAW.
                16 => {
                    let samples = self.decode_samples16(rows, cols)?;
                    Ok(samples.iter().map(|s| (s >> 8) as u8).collect())
                }
                _ => Err(PsdError::Unsupported(format!(
                    "ZIP-with-prediction at depth {depth} (8- and 16-bit are read)"
                ))),
            },
        }
    }

    /// RAW samples, reduced to 8 bits.
    ///
    /// At depth 16 the samples are BIG-ENDIAN and the high byte is the
    /// correct nearest-8-bit reading — the same convention the merged
    /// composite reads, verified there by test. The returned plane is
    /// always one byte per pixel, because the layer stack downstream is
    /// 8-bit; this is what lets a 16-bit PSD's LAYERS import at all
    /// instead of the whole file falling back to a flattened composite.
    fn decode_raw(&self, plane_len: usize, depth: u16) -> Result<Vec<u8>> {
        let sample_bytes = if depth == 16 { 2 } else { 1 };
        let want = plane_len * sample_bytes;
        if self.bytes.len() != want {
            return Err(malformed(format!(
                "RAW channel is {} byte(s), expected {want}",
                self.bytes.len()
            )));
        }
        if sample_bytes == 1 {
            return Ok(self.bytes.clone());
        }
        Ok(self.bytes.as_chunks::<2>().0.iter().map(|s| s[0]).collect())
    }

    fn decode_rle(
        &self,
        container: Container,
        rows: u32,
        cols: u32,
        plane_len: usize,
    ) -> Result<Vec<u8>> {
        let count_width = count_width(container);
        let rows = rows as usize;
        let cols = cols as usize;
        let table_len = rows
            .checked_mul(count_width)
            .ok_or_else(|| malformed("RLE count table size overflows usize".into()))?;
        if self.bytes.len() < table_len {
            return Err(malformed(format!(
                "RLE count table needs {table_len} byte(s), payload has {}",
                self.bytes.len()
            )));
        }

        // Per-row packed-byte counts, then the packed rows back to back.
        let mut counts = Vec::with_capacity(rows);
        for r in 0..rows {
            let off = r * count_width;
            let n = match count_width {
                2 => u16::from_be_bytes([self.bytes[off], self.bytes[off + 1]]) as usize,
                4 => u32::from_be_bytes([
                    self.bytes[off],
                    self.bytes[off + 1],
                    self.bytes[off + 2],
                    self.bytes[off + 3],
                ]) as usize,
                _ => unreachable!("count_width is 2 or 4"),
            };
            counts.push(n);
        }
        let packed_total: usize = counts.iter().sum();
        let packed = &self.bytes[table_len..];
        if packed.len() != packed_total {
            return Err(malformed(format!(
                "RLE packed rows total {} byte(s), count table claims {packed_total}",
                packed.len()
            )));
        }

        let mut plane = vec![0u8; plane_len];
        let mut src_off = 0usize;
        for (r, &n) in counts.iter().enumerate() {
            let row_src = &packed[src_off..src_off + n];
            src_off += n;
            let dst = &mut plane[r * cols..r * cols + cols];
            packbits::decode(row_src, dst)?;
        }
        Ok(plane)
    }

    /// The 16-bit SAMPLES of a 16-bit channel stored RAW or
    /// ZIP-with-prediction (`rows * cols` of them), at full precision.
    pub fn decode_samples16(&self, rows: u32, cols: u32) -> Result<Vec<u16>> {
        let n = (rows as usize)
            .checked_mul(cols as usize)
            .ok_or_else(|| malformed(format!("plane size {rows}×{cols} overflows usize")))?;
        let bytes = match self.compression {
            Compression::Raw => {
                if self.bytes.len() != n * 2 {
                    return Err(malformed(format!(
                        "16-bit RAW channel is {} byte(s), expected {}",
                        self.bytes.len(),
                        n * 2
                    )));
                }
                self.bytes.clone()
            }
            Compression::Zip => inflate(&self.bytes, n * 2)?,
            Compression::ZipPrediction => inflate(&self.bytes, n * 2)?,
            Compression::Rle => {
                return Err(PsdError::Unsupported(
                    "16-bit RLE channel samples (see `decode`)".into(),
                ))
            }
        };
        let mut samples: Vec<u16> = bytes
            .as_chunks::<2>()
            .0
            .iter()
            .map(|b| u16::from_be_bytes(*b))
            .collect();
        if self.compression == Compression::ZipPrediction {
            let cols = cols as usize;
            for row in samples.chunks_mut(cols.max(1)) {
                for i in 1..row.len() {
                    row[i] = row[i].wrapping_add(row[i - 1]);
                }
            }
        }
        Ok(samples)
    }

    /// The 32-bit float samples of a 32-bit channel stored RAW, ZIP or
    /// ZIP-with-prediction (`rows * cols` of them), big-endian IEEE 754 on
    /// disk. With prediction every row is four byte planes delta-coded
    /// over the row's bytes (module docs). RLE has no 32-bit form.
    pub fn decode_samples32(&self, rows: u32, cols: u32) -> Result<Vec<f32>> {
        let n = (rows as usize)
            .checked_mul(cols as usize)
            .ok_or_else(|| malformed(format!("plane size {rows}×{cols} overflows usize")))?;
        let mut bytes = match self.compression {
            Compression::Raw => {
                if self.bytes.len() != n * 4 {
                    return Err(malformed(format!(
                        "32-bit RAW channel is {} byte(s), expected {}",
                        self.bytes.len(),
                        n * 4
                    )));
                }
                self.bytes.clone()
            }
            Compression::Zip | Compression::ZipPrediction => inflate(&self.bytes, n * 4)?,
            Compression::Rle => {
                return Err(PsdError::Unsupported(
                    "32-bit RLE channel (Photoshop writes 32-bit channels RAW or ZIP)".into(),
                ))
            }
        };
        if self.compression == Compression::ZipPrediction {
            let cols = cols as usize;
            let mut planar = vec![0u8; cols * 4];
            for row in bytes.chunks_mut((cols * 4).max(1)) {
                for i in 1..row.len() {
                    row[i] = row[i].wrapping_add(row[i - 1]);
                }
                planar.copy_from_slice(row);
                for x in 0..cols {
                    for b in 0..4 {
                        row[x * 4 + b] = planar[b * cols + x];
                    }
                }
            }
        }
        Ok(bytes
            .as_chunks::<4>()
            .0
            .iter()
            .map(|b| f32::from_be_bytes(*b))
            .collect())
    }

    /// Build a ZIP-with-prediction `ChannelData` from 32-bit float samples
    /// (`rows * cols` of them): each row as four byte planes, delta-coded
    /// over its bytes, deflated — what Photoshop writes into an `Lr32`
    /// block ([`decode_samples32`](Self::decode_samples32) reads it back).
    pub fn encode_zip_predicted32(samples: &[f32], rows: u32, cols: u32) -> Result<ChannelData> {
        let cols = cols as usize;
        let n = (rows as usize)
            .checked_mul(cols)
            .ok_or_else(|| malformed(format!("plane size {rows}×{cols} overflows usize")))?;
        if samples.len() != n {
            return Err(malformed(format!(
                "ZIP encode: {} sample(s), expected {n}",
                samples.len()
            )));
        }
        let mut bytes = Vec::with_capacity(n * 4);
        let mut row = vec![0u8; cols * 4];
        for line in samples.chunks(cols.max(1)) {
            for (x, v) in line.iter().enumerate() {
                let be = v.to_be_bytes();
                for b in 0..4 {
                    row[b * cols + x] = be[b];
                }
            }
            let mut prev = 0u8;
            for (i, &v) in row.iter().enumerate() {
                bytes.push(if i == 0 { v } else { v.wrapping_sub(prev) });
                prev = v;
            }
        }
        Ok(ChannelData {
            compression: Compression::ZipPrediction,
            bytes: miniz_oxide::deflate::compress_to_vec_zlib(&bytes, 6),
        })
    }

    /// Build a ZIP-with-prediction `ChannelData` (compression 3, what
    /// Photoshop writes for a 16-bit document's layers) from 16-bit
    /// samples, `rows * cols` of them: each row's samples after the first
    /// become their difference from the previous one, the big-endian
    /// result is deflated into a zlib stream.
    pub fn encode_zip_predicted16(samples: &[u16], rows: u32, cols: u32) -> Result<ChannelData> {
        let cols = cols as usize;
        let n = (rows as usize)
            .checked_mul(cols)
            .ok_or_else(|| malformed(format!("plane size {rows}×{cols} overflows usize")))?;
        if samples.len() != n {
            return Err(malformed(format!(
                "ZIP encode: {} sample(s), expected {n}",
                samples.len()
            )));
        }
        let mut bytes = Vec::with_capacity(n * 2);
        for row in samples.chunks(cols.max(1)) {
            let mut prev = 0u16;
            for (i, &s) in row.iter().enumerate() {
                let d = if i == 0 { s } else { s.wrapping_sub(prev) };
                bytes.extend_from_slice(&d.to_be_bytes());
                prev = s;
            }
        }
        Ok(ChannelData {
            compression: Compression::ZipPrediction,
            bytes: miniz_oxide::deflate::compress_to_vec_zlib(&bytes, 6),
        })
    }

    /// Build a RAW `ChannelData` from a planar 8-bit buffer (writer-side
    /// feed for M2 edits). The stored payload IS the plane verbatim.
    pub fn encode_raw(planar: &[u8]) -> ChannelData {
        ChannelData {
            compression: Compression::Raw,
            bytes: planar.to_vec(),
        }
    }

    /// Build an RLE `ChannelData` from a planar 8-bit buffer: the per-row
    /// count table (`u16`/`u32` per `container`) followed by the
    /// canonically PackBits-encoded rows. `planar.len()` must be
    /// `rows * cols`.
    pub fn encode_rle(
        planar: &[u8],
        container: Container,
        rows: u32,
        cols: u32,
    ) -> Result<ChannelData> {
        let rows = rows as usize;
        let cols = cols as usize;
        let plane_len = rows
            .checked_mul(cols)
            .ok_or_else(|| malformed(format!("plane size {rows}×{cols} overflows usize")))?;
        if planar.len() != plane_len {
            return Err(malformed(format!(
                "RLE encode: planar buffer is {} byte(s), expected {plane_len}",
                planar.len()
            )));
        }
        let count_width = count_width(container);

        // Pack each row, recording its packed length for the table.
        let mut packed_rows: Vec<Vec<u8>> = Vec::with_capacity(rows);
        for r in 0..rows {
            packed_rows.push(packbits::encode(&planar[r * cols..r * cols + cols]));
        }

        let mut bytes = Vec::new();
        for row in &packed_rows {
            match count_width {
                2 => {
                    let n = u16::try_from(row.len()).map_err(|_| {
                        malformed(format!(
                            "RLE row of {} byte(s) exceeds u16 count",
                            row.len()
                        ))
                    })?;
                    bytes.extend_from_slice(&n.to_be_bytes());
                }
                4 => bytes.extend_from_slice(&(row.len() as u32).to_be_bytes()),
                _ => unreachable!("count_width is 2 or 4"),
            }
        }
        for row in &packed_rows {
            bytes.extend_from_slice(row);
        }
        Ok(ChannelData {
            compression: Compression::Rle,
            bytes,
        })
    }
}

/// RLE per-row count-table entry width: PSD = 2, PSB = 4.
fn count_width(container: Container) -> usize {
    match container {
        Container::Psd => 2,
        Container::Psb => 4,
    }
}

/// Inflate a zlib stream into a buffer of exactly `expected` bytes.
fn inflate(zlib: &[u8], expected: usize) -> Result<Vec<u8>> {
    let plane = miniz_oxide::inflate::decompress_to_vec_zlib(zlib)
        .map_err(|e| malformed(format!("ZIP inflate failed: {e:?}")))?;
    if plane.len() != expected {
        return Err(malformed(format!(
            "ZIP inflated to {} byte(s), expected {expected}",
            plane.len()
        )));
    }
    Ok(plane)
}

/// Undo TIFF-style horizontal differencing for an 8-bit plane, per row:
/// each sample after the first in a row holds its delta from the
/// previous sample, so `out[i] += out[i-1]` (wrapping) reconstructs it.
fn undo_prediction_8bit(plane: &mut [u8], rows: usize, cols: usize) {
    for r in 0..rows {
        let row = &mut plane[r * cols..r * cols + cols];
        for i in 1..row.len() {
            row[i] = row[i].wrapping_add(row[i - 1]);
        }
    }
}

#[inline]
fn malformed(detail: String) -> PsdError {
    PsdError::Malformed {
        section: "channel image data",
        detail,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn image_psd_thirty_two_bit_channels_round_trip_through_the_byte_plane_prediction() {
        let samples: Vec<f32> = (0..15)
            .map(|i| i as f32 * 0.37 - 1.5)
            .chain([3.25e3])
            .collect();
        let ch = ChannelData::encode_zip_predicted32(&samples, 4, 4).expect("encode");
        assert_eq!(ch.compression, Compression::ZipPrediction);
        assert_eq!(ch.decode_samples32(4, 4).expect("decode"), samples);
        // RAW is big-endian floats; the 8-bit view clamps.
        let raw = ChannelData {
            compression: Compression::Raw,
            bytes: [0.5f32, 2.0].iter().flat_map(|v| v.to_be_bytes()).collect(),
        };
        assert_eq!(raw.decode_samples32(1, 2).expect("raw"), vec![0.5, 2.0]);
        assert_eq!(
            raw.decode(Container::Psd, 1, 2, 32).expect("8-bit view"),
            vec![128, 255]
        );
    }

    /// 16-bit RAW reduces by the HIGH byte — the same convention the
    /// merged composite reads, and the reason this one ships while RLE
    /// does not: RAW's sample order is unambiguous, RLE's row-table
    /// semantics for 16-bit are not.
    #[test]
    fn image_psd_layer_channel_data_raw_sixteen_bit_reduces_by_the_high_byte() {
        let ch = ChannelData {
            compression: Compression::Raw,
            // Two big-endian 16-bit samples: 0xAABB, 0xCCDD.
            bytes: vec![0xAA, 0xBB, 0xCC, 0xDD],
        };
        let plane = ch.decode(Container::Psd, 1, 2, 16).expect("16-bit RAW");
        assert_eq!(plane, vec![0xAA, 0xCC]);
    }

    /// The length check counts SAMPLES, not bytes — a 16-bit plane that
    /// is short must be a clean error, never a half-read image.
    #[test]
    fn image_psd_layer_channel_data_raw_sixteen_bit_length_is_checked_in_samples() {
        let ch = ChannelData {
            compression: Compression::Raw,
            bytes: vec![0xAA, 0xBB],
        };
        assert!(ch.decode(Container::Psd, 1, 2, 16).is_err());
        // …and the same bytes ARE a valid 2-pixel 8-bit plane.
        assert!(ch.decode(Container::Psd, 1, 2, 8).is_ok());
    }

    /// 16-bit RLE stays refused, and the refusal cites its evidence
    /// rather than reading as "nobody got to it".
    #[test]
    fn image_psd_layer_channel_data_zip_prediction_sixteen_bit_round_trips() {
        let samples: Vec<u16> = (0..12u16).map(|i| i * 5000 + 7).collect();
        let cd = ChannelData::encode_zip_predicted16(&samples, 3, 4).unwrap();
        assert_eq!(cd.compression, Compression::ZipPrediction);
        assert_eq!(cd.decode_samples16(3, 4).unwrap(), samples);
        let reduced = cd.decode(Container::Psd, 3, 4, 16).unwrap();
        assert_eq!(
            reduced,
            samples.iter().map(|s| (s >> 8) as u8).collect::<Vec<_>>()
        );
    }

    #[test]
    fn image_psd_layer_channel_data_rle_sixteen_bit_is_refused_with_its_reason() {
        let ch = ChannelData {
            compression: Compression::Rle,
            bytes: vec![0; 16],
        };
        let err = ch.decode(Container::Psd, 1, 2, 16).expect_err("unverified");
        let msg = err.to_string();
        assert!(msg.contains("16-bit RLE"), "{msg}");
        assert!(msg.contains("unverified"), "{msg}");
    }
}
