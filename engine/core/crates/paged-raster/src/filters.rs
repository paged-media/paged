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

//! The PostScript/PDF decode filters (PLRM 3.13): ASCIIHex, ASCII85,
//! RunLength, LZW and Flate (with the TIFF and PNG predictors), DCT and
//! SubFile. Each decodes its whole input to its end-of-data marker and
//! reports how many input bytes that consumed, so a reader of a stream
//! (paged-ps's `currentfile`) continues right after the encoded data.
//! Flate, LZW and DCT use the crates the engine already decodes PNG, TIFF
//! and JPEG with. The raster crate is their one home (PM-0014, shared
//! capability C5): paged-ps reads EPS image data through them.

#[derive(Debug)]
pub enum FilterError {
    /// The data does not decode (`ioerror`).
    Data,
    /// A filter this module does not provide.
    Unsupported,
    /// The output would pass [`Params::max_output`].
    TooLarge,
}

pub struct Params {
    pub early_change: i32,
    pub predictor: i32,
    pub colors: usize,
    pub bits: usize,
    pub columns: usize,
    pub eod_count: i32,
    pub eod_string: Vec<u8>,
    /// The most bytes a filter may produce (a decompression bomb stops
    /// here with [`FilterError::TooLarge`]).
    pub max_output: usize,
}

impl Default for Params {
    fn default() -> Self {
        Params {
            early_change: 1,
            predictor: 1,
            colors: 1,
            bits: 8,
            columns: 1,
            eod_count: 0,
            eod_string: Vec::new(),
            max_output: usize::MAX,
        }
    }
}

/// Decoded bytes, and the input consumed to produce them.
pub type Decoded = (Vec<u8>, usize);

pub fn decode(name: &str, input: &[u8], p: &Params) -> Result<Decoded, FilterError> {
    match name {
        "ASCIIHexDecode" => Ok(ascii_hex(input)),
        "ASCII85Decode" => ascii85(input),
        "RunLengthDecode" => run_length(input, p.max_output),
        "LZWDecode" => {
            let (d, n) = lzw(input, p.early_change != 0, p.max_output)?;
            Ok((predict(d, p)?, n))
        }
        "FlateDecode" => {
            let (d, n) = flate(input, p.max_output)?;
            Ok((predict(d, p)?, n))
        }
        "DCTDecode" => dct(input).map(|(d, n, _)| (d, n)),
        "SubFileDecode" => Ok(subfile(input, p.eod_count, &p.eod_string)),
        "NullEncode" => Ok((input.to_vec(), input.len())),
        _ => Err(FilterError::Unsupported),
    }
}

fn ascii_hex(input: &[u8]) -> Decoded {
    let mut out = Vec::with_capacity(input.len() / 2);
    let mut hi: Option<u8> = None;
    let mut i = 0;
    while i < input.len() {
        let c = input[i];
        i += 1;
        if c == b'>' {
            break;
        }
        let Some(v) = (c as char).to_digit(16).map(|d| d as u8) else {
            continue;
        };
        match hi.take() {
            None => hi = Some(v),
            Some(h) => out.push((h << 4) | v),
        }
    }
    if let Some(h) = hi {
        out.push(h << 4);
    }
    (out, i)
}

fn ascii85(input: &[u8]) -> Result<Decoded, FilterError> {
    let mut out = Vec::with_capacity(input.len() * 4 / 5);
    let mut group = [0u8; 5];
    let mut n = 0;
    let mut i = 0;
    let flush = |group: &[u8; 5], n: usize, out: &mut Vec<u8>| -> Result<(), FilterError> {
        if n == 0 {
            return Ok(());
        }
        if n == 1 {
            return Err(FilterError::Data);
        }
        let mut g = *group;
        for v in g.iter_mut().skip(n) {
            *v = 84;
        }
        let mut acc: u64 = 0;
        for v in g {
            acc = acc * 85 + v as u64;
        }
        if acc > u32::MAX as u64 {
            return Err(FilterError::Data);
        }
        let b = (acc as u32).to_be_bytes();
        out.extend_from_slice(&b[..n - 1]);
        Ok(())
    };
    while i < input.len() {
        let c = input[i];
        i += 1;
        match c {
            b'~' => {
                if input.get(i) == Some(&b'>') {
                    i += 1;
                }
                flush(&group, n, &mut out)?;
                return Ok((out, i));
            }
            b'z' if n == 0 => out.extend_from_slice(&[0, 0, 0, 0]),
            b'!'..=b'u' => {
                group[n] = c - b'!';
                n += 1;
                if n == 5 {
                    flush(&group, 5, &mut out)?;
                    n = 0;
                }
            }
            c if c.is_ascii_whitespace() || c == 0 => {}
            _ => return Err(FilterError::Data),
        }
    }
    flush(&group, n, &mut out)?;
    Ok((out, i))
}

fn run_length(input: &[u8], max: usize) -> Result<Decoded, FilterError> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < input.len() {
        let n = input[i];
        i += 1;
        match n {
            0..=127 => {
                let end = (i + n as usize + 1).min(input.len());
                out.extend_from_slice(&input[i..end]);
                i = end;
            }
            128 => break,
            _ => {
                if let Some(&b) = input.get(i) {
                    out.extend(std::iter::repeat_n(b, 257 - n as usize));
                    if out.len() > max {
                        return Err(FilterError::TooLarge);
                    }
                    i += 1;
                }
            }
        }
    }
    Ok((out, i))
}

fn lzw(input: &[u8], early: bool, max: usize) -> Result<Decoded, FilterError> {
    use weezl::{decode::Decoder, BitOrder, LzwStatus};
    let mut dec = if early {
        Decoder::with_tiff_size_switch(BitOrder::Msb, 8)
    } else {
        Decoder::new(BitOrder::Msb, 8)
    };
    let mut out = Vec::new();
    let mut buf = vec![0u8; 1 << 16];
    let mut pos = 0;
    loop {
        let r = dec.decode_bytes(&input[pos..], &mut buf);
        pos += r.consumed_in;
        out.extend_from_slice(&buf[..r.consumed_out]);
        if out.len() > max {
            return Err(FilterError::TooLarge);
        }
        match r.status {
            Ok(LzwStatus::Done) => break,
            Ok(LzwStatus::NoProgress) => break,
            Ok(LzwStatus::Ok) => {
                if r.consumed_in == 0 && r.consumed_out == 0 {
                    break;
                }
            }
            // Data past a missing end-of-data code: what decoded stands.
            Err(_) if !out.is_empty() => break,
            Err(_) => return Err(FilterError::Data),
        }
    }
    Ok((out, pos))
}

fn flate(input: &[u8], max: usize) -> Result<Decoded, FilterError> {
    let mut d = flate2::Decompress::new(true);
    let mut out = Vec::with_capacity(input.len() * 3);
    loop {
        if out.capacity() - out.len() < 1 << 15 {
            if out.len() > max {
                return Err(FilterError::TooLarge);
            }
            out.reserve(out.capacity().max(1 << 16));
        }
        let before_in = d.total_in();
        let before_out = d.total_out();
        let r = d.decompress_vec(
            &input[d.total_in() as usize..],
            &mut out,
            flate2::FlushDecompress::None,
        );
        match r {
            Ok(flate2::Status::StreamEnd) => break,
            Ok(_) => {
                if d.total_in() == before_in && d.total_out() == before_out {
                    break;
                }
            }
            Err(_) if !out.is_empty() => break,
            Err(_) => return Err(FilterError::Data),
        }
    }
    Ok((out, d.total_in() as usize))
}

/// A JPEG's samples, interleaved, 8 bits each, and its component count.
pub fn dct(input: &[u8]) -> Result<(Vec<u8>, usize, usize), FilterError> {
    let mut cursor = std::io::Cursor::new(input);
    let mut dec = jpeg_decoder::Decoder::new(&mut cursor);
    let pixels = dec.decode().map_err(|_| FilterError::Data)?;
    let info = dec.info().ok_or(FilterError::Data)?;
    let (data, comps) = match info.pixel_format {
        jpeg_decoder::PixelFormat::L8 => (pixels, 1),
        jpeg_decoder::PixelFormat::L16 => (pixels.chunks(2).map(|c| c[0]).collect(), 1),
        jpeg_decoder::PixelFormat::RGB24 => (pixels, 3),
        jpeg_decoder::PixelFormat::CMYK32 => (pixels, 4),
    };
    // The decoder reads the stream through its end marker; anything it
    // buffered past that is not ours to keep, so find the marker.
    let consumed = eoi_end(input).unwrap_or(cursor.position() as usize);
    Ok((data, consumed, comps))
}

fn eoi_end(input: &[u8]) -> Option<usize> {
    input
        .windows(2)
        .rposition(|w| w == [0xFF, 0xD9])
        .map(|i| i + 2)
}

fn subfile(input: &[u8], count: i32, eod: &[u8]) -> Decoded {
    if eod.is_empty() {
        if count <= 0 {
            return (input.to_vec(), input.len());
        }
        let n = (count as usize).min(input.len());
        return (input[..n].to_vec(), n);
    }
    // Pass data up to the (count+1)-th occurrence of the EOD string.
    let mut seen = 0;
    let mut i = 0;
    while i + eod.len() <= input.len() {
        if &input[i..i + eod.len()] == eod {
            if seen == count.max(0) {
                return (input[..i].to_vec(), i + eod.len());
            }
            seen += 1;
            i += eod.len();
        } else {
            i += 1;
        }
    }
    (input.to_vec(), input.len())
}

/// The TIFF (2) and PNG (10..15) predictors of LZW and Flate.
fn predict(data: Vec<u8>, p: &Params) -> Result<Vec<u8>, FilterError> {
    if p.predictor <= 1 {
        return Ok(data);
    }
    let bpp = (p.colors * p.bits).div_ceil(8).max(1);
    let row = (p.colors * p.bits * p.columns).div_ceil(8);
    if row == 0 {
        return Ok(data);
    }
    if p.predictor == 2 {
        if p.bits != 8 {
            return Err(FilterError::Unsupported);
        }
        let mut out = data;
        for line in out.chunks_mut(row) {
            for i in bpp..line.len() {
                line[i] = line[i].wrapping_add(line[i - bpp]);
            }
        }
        return Ok(out);
    }
    let mut out = Vec::with_capacity(data.len());
    let mut prev = vec![0u8; row];
    for chunk in data.chunks(row + 1) {
        if chunk.len() < 2 {
            break;
        }
        let kind = chunk[0];
        let mut line = chunk[1..].to_vec();
        line.resize(row, 0);
        for i in 0..row {
            let a = if i >= bpp { line[i - bpp] } else { 0 } as i32;
            let b = prev[i] as i32;
            let c = if i >= bpp { prev[i - bpp] } else { 0 } as i32;
            let add = match kind {
                1 => a,
                2 => b,
                3 => (a + b) / 2,
                4 => {
                    let pp = a + b - c;
                    let (pa, pb, pc) = ((pp - a).abs(), (pp - b).abs(), (pp - c).abs());
                    if pa <= pb && pa <= pc {
                        a
                    } else if pb <= pc {
                        b
                    } else {
                        c
                    }
                }
                _ => 0,
            };
            line[i] = (line[i] as i32 + add) as u8;
        }
        out.extend_from_slice(&line);
        prev = line;
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ascii_hex_ignores_whitespace_and_pads_an_odd_digit() {
        assert_eq!(ascii_hex(b"48 65\n6c6C6f>rest"), (b"Hello".to_vec(), 13));
        assert_eq!(ascii_hex(b"4>").0, vec![0x40]);
    }

    /// ASCII85 of `data` (PLRM 3.13.3), for the round trip.
    pub(crate) fn a85(data: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        for chunk in data.chunks(4) {
            let mut b = [0u8; 4];
            b[..chunk.len()].copy_from_slice(chunk);
            let mut v = u32::from_be_bytes(b);
            if v == 0 && chunk.len() == 4 {
                out.push(b'z');
                continue;
            }
            let mut g = [0u8; 5];
            for i in (0..5).rev() {
                g[i] = (v % 85) as u8 + b'!';
                v /= 85;
            }
            out.extend_from_slice(&g[..chunk.len() + 1]);
        }
        out.extend_from_slice(b"~>");
        out
    }

    #[test]
    fn ascii85_decodes_groups_z_and_a_short_tail() {
        assert_eq!(ascii85(b"9jqo^~>").unwrap().0, b"Man ");
        let data = b"Man is distinguished\0\0\0\0 by z";
        let mut enc = a85(data);
        let len = enc.len();
        enc.extend_from_slice(b"tail");
        let (d, n) = ascii85(&enc).unwrap();
        assert_eq!(d, data.to_vec());
        assert_eq!(n, len);
        assert!(ascii85(b"9jqo^\x7f~>").is_err());
    }

    #[test]
    fn run_length_copies_repeats_and_stops_at_128() {
        let (d, n) = run_length(&[2, b'a', b'b', b'c', 254, b'x', 128, 9], usize::MAX).unwrap();
        assert_eq!(d, b"abcxxx");
        assert_eq!(n, 7);
    }

    #[test]
    fn subfile_stops_at_the_eod_string() {
        let (d, n) = subfile(b"abc%%EndData rest", 0, b"%%EndData");
        assert_eq!(d, b"abc");
        assert_eq!(n, 12);
        assert_eq!(subfile(b"abcdef", 4, b"").0, b"abcd");
    }

    #[test]
    fn flate_and_lzw_report_what_they_consumed() {
        use std::io::Write as _;
        let mut z = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
        z.write_all(b"hello hello hello").unwrap();
        let mut enc = z.finish().unwrap();
        let len = enc.len();
        enc.extend_from_slice(b" trailing");
        let (d, n) = flate(&enc, usize::MAX).unwrap();
        assert_eq!(d, b"hello hello hello");
        assert_eq!(n, len);

        let mut e = weezl::encode::Encoder::with_tiff_size_switch(weezl::BitOrder::Msb, 8);
        let lz = e.encode(b"ababababab").unwrap();
        assert_eq!(lzw(&lz, true, usize::MAX).unwrap().0, b"ababababab");
        assert!(matches!(
            run_length(&[129, 0, 129, 0], 100),
            Err(FilterError::TooLarge)
        ));
    }

    #[test]
    fn png_up_predictor_adds_the_row_above() {
        let p = Params {
            predictor: 12,
            columns: 2,
            ..Params::default()
        };
        let out = predict(vec![0, 1, 2, 2, 1, 1], &p).unwrap();
        assert_eq!(out, vec![1, 2, 2, 3]);
    }
}
