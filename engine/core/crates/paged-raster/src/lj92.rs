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

//! Lossless JPEG (ITU T.81 process 14, `SOF3`), the compression of most
//! DNG files (TIFF compression 7). Huffman coding, predictors 1 to 7, any
//! number of components at 1x1 sampling, restart intervals and a point
//! transform. Arithmetic coding and hierarchical frames are refused.

/// A decoded frame: `width` x `height` pixels of `components` interleaved
/// samples, row by row from the top.
pub(crate) struct Frame {
    pub width: usize,
    pub height: usize,
    pub components: usize,
    pub samples: Vec<u16>,
}

/// A canonical Huffman table (T.81 Annex C), decoded bit by bit.
#[derive(Clone, Default)]
struct Huffman {
    /// For each code length 1..=16: the largest code of that length + 1
    /// (0 when none), the first code, and the index of its first value.
    maxcode: [i32; 17],
    mincode: [i32; 17],
    valptr: [usize; 17],
    values: Vec<u8>,
}

impl Huffman {
    fn new(counts: &[u8; 16], values: Vec<u8>) -> Huffman {
        let mut h = Huffman {
            values,
            ..Huffman::default()
        };
        let mut code = 0i32;
        let mut k = 0usize;
        for len in 1..=16 {
            let n = counts[len - 1] as usize;
            h.valptr[len] = k;
            h.mincode[len] = code;
            code += n as i32;
            k += n;
            h.maxcode[len] = if n > 0 { code } else { -1 };
            code <<= 1;
        }
        h
    }

    fn decode(&self, bits: &mut Bits) -> Option<u8> {
        let mut code = 0i32;
        for len in 1..=16 {
            code = (code << 1) | bits.bit() as i32;
            if self.maxcode[len] >= 0 && code < self.maxcode[len] && code >= self.mincode[len] {
                let i = self.valptr[len] + (code - self.mincode[len]) as usize;
                return self.values.get(i).copied();
            }
        }
        None
    }
}

/// The entropy-coded bits, with `FF 00` stuffing removed. A marker ends
/// the data: reads past it return zero bits.
struct Bits<'b> {
    data: &'b [u8],
    pos: usize,
    acc: u32,
    count: u32,
}

impl<'b> Bits<'b> {
    fn bit(&mut self) -> u32 {
        if self.count == 0 {
            let mut byte = 0u8;
            if let Some(&b) = self.data.get(self.pos) {
                if b == 0xFF {
                    // `FF 00` is a stuffed FF; anything else a marker to
                    // stay on.
                    if self.data.get(self.pos + 1) == Some(&0) {
                        byte = 0xFF;
                        self.pos += 2;
                    }
                } else {
                    byte = b;
                    self.pos += 1;
                }
            }
            self.acc = u32::from(byte);
            self.count = 8;
        }
        self.count -= 1;
        (self.acc >> self.count) & 1
    }

    fn bits(&mut self, n: u32) -> u32 {
        (0..n).fold(0, |v, _| (v << 1) | self.bit())
    }

    /// Skip to the next `RSTn` marker and past it.
    fn restart(&mut self) {
        self.count = 0;
        while self.pos + 1 < self.data.len() {
            if self.data[self.pos] == 0xFF && (0xD0..=0xD7).contains(&self.data[self.pos + 1]) {
                self.pos += 2;
                return;
            }
            self.pos += 1;
        }
    }
}

struct Component {
    id: u8,
    table: usize,
}

fn be16(b: &[u8], at: usize) -> Option<usize> {
    Some(usize::from(u16::from_be_bytes([
        *b.get(at)?,
        *b.get(at + 1)?,
    ])))
}

/// Decode one lossless JPEG stream.
pub(crate) fn decode(data: &[u8]) -> Result<Frame, String> {
    if !data.starts_with(&[0xFF, 0xD8]) {
        return Err("not a JPEG stream".into());
    }
    let mut tables: [Option<Huffman>; 4] = Default::default();
    let mut frame: Option<(usize, usize, usize, Vec<u8>)> = None;
    let mut restart_interval = 0usize;
    let mut pos = 2usize;
    loop {
        // Fill bytes may precede a marker.
        while data.get(pos) == Some(&0xFF) && data.get(pos + 1) == Some(&0xFF) {
            pos += 1;
        }
        let (Some(0xFF), Some(&marker)) = (data.get(pos), data.get(pos + 1)) else {
            return Err("no start of scan".into());
        };
        pos += 2;
        if marker == 0xD9 {
            return Err("end of image before a scan".into());
        }
        let len = be16(data, pos).ok_or("a truncated marker segment")?;
        let seg = data
            .get(pos + 2..pos + len)
            .ok_or("a marker segment runs past the end")?;
        match marker {
            0xC4 => {
                let mut i = 0;
                while i < seg.len() {
                    let id = (seg[i] & 0x0F) as usize;
                    let counts: [u8; 16] = seg
                        .get(i + 1..i + 17)
                        .and_then(|c| c.try_into().ok())
                        .ok_or("a truncated Huffman table")?;
                    let n: usize = counts.iter().map(|c| *c as usize).sum();
                    let values = seg
                        .get(i + 17..i + 17 + n)
                        .ok_or("a truncated Huffman table")?
                        .to_vec();
                    if id > 3 {
                        return Err(format!("Huffman table {id}"));
                    }
                    tables[id] = Some(Huffman::new(&counts, values));
                    i += 17 + n;
                }
            }
            0xC3 => {
                let precision = *seg.first().ok_or("a truncated frame header")? as usize;
                let height = be16(seg, 1).ok_or("a truncated frame header")?;
                let width = be16(seg, 3).ok_or("a truncated frame header")?;
                let nf = *seg.get(5).ok_or("a truncated frame header")? as usize;
                let mut ids = Vec::with_capacity(nf);
                for c in 0..nf {
                    let at = 6 + c * 3;
                    let sampling = *seg.get(at + 1).ok_or("a truncated frame header")?;
                    if sampling != 0x11 {
                        return Err("subsampled lossless JPEG components".into());
                    }
                    ids.push(seg[at]);
                }
                if !(2..=16).contains(&precision) || width == 0 || height == 0 || nf == 0 {
                    return Err("an invalid lossless JPEG frame".into());
                }
                frame = Some((precision, width, height, ids));
            }
            0xC0..=0xC2 | 0xC5..=0xC7 | 0xC9..=0xCB | 0xCD..=0xCF => {
                return Err(format!("JPEG process SOF{} (not lossless)", marker - 0xC0));
            }
            0xDD => restart_interval = be16(seg, 0).ok_or("a truncated restart interval")?,
            0xDA => {
                let (precision, width, height, ids) = frame.take().ok_or("a scan before SOF3")?;
                let ns = *seg.first().ok_or("a truncated scan header")? as usize;
                let mut comps = Vec::with_capacity(ns);
                for c in 0..ns {
                    let id = *seg.get(1 + c * 2).ok_or("a truncated scan header")?;
                    let table =
                        (*seg.get(2 + c * 2).ok_or("a truncated scan header")? >> 4) as usize;
                    comps.push(Component { id, table });
                }
                let predictor = *seg.get(1 + ns * 2).ok_or("a truncated scan header")?;
                let point = *seg.get(3 + ns * 2).ok_or("a truncated scan header")? & 0x0F;
                if ns != ids.len() || comps.iter().zip(&ids).any(|(c, id)| c.id != *id) {
                    return Err("a lossless JPEG with several scans".into());
                }
                let huff: Vec<&Huffman> = comps
                    .iter()
                    .map(|c| tables.get(c.table).and_then(Option::as_ref))
                    .collect::<Option<_>>()
                    .ok_or("a scan names a missing Huffman table")?;
                let bits = Bits {
                    data: &data[pos + len..],
                    pos: 0,
                    acc: 0,
                    count: 0,
                };
                return scan(
                    bits,
                    &huff,
                    precision,
                    width,
                    height,
                    predictor,
                    point,
                    restart_interval,
                );
            }
            _ => {}
        }
        pos += len;
    }
}

#[allow(clippy::too_many_arguments)]
fn scan(
    mut bits: Bits,
    huff: &[&Huffman],
    precision: usize,
    width: usize,
    height: usize,
    predictor: u8,
    point: u8,
    restart_interval: usize,
) -> Result<Frame, String> {
    if !(0..=7).contains(&predictor) {
        return Err(format!("lossless JPEG predictor {predictor}"));
    }
    let nc = huff.len();
    let total = width
        .checked_mul(height)
        .and_then(|n| n.checked_mul(nc))
        .filter(|n| *n <= 1 << 30)
        .ok_or("a lossless JPEG frame larger than the decode limits")?;
    let mut out = vec![0u16; total];
    let row_len = width * nc;
    let initial = 1i32 << (precision as i32 - i32::from(point) - 1);
    let mask = (1i32 << precision) - 1;
    let mut since_restart = 0usize;
    // The first pixel, and the first after a restart, predicts from the
    // initial value; the rest of its row from the left, as the first row.
    let mut start = true;
    let mut fresh_row = true;
    for y in 0..height {
        for x in 0..width {
            if restart_interval > 0 && since_restart == restart_interval {
                bits.restart();
                since_restart = 0;
                start = true;
                fresh_row = true;
            }
            for (c, table) in huff.iter().enumerate() {
                let ssss = u32::from(table.decode(&mut bits).ok_or("a bad Huffman code")?);
                let diff = match ssss {
                    0 => 0,
                    16 => 32768,
                    n if n < 16 => {
                        let v = bits.bits(n) as i32;
                        if v < 1 << (n - 1) {
                            v - (1 << n) + 1
                        } else {
                            v
                        }
                    }
                    _ => return Err("a bad difference category".into()),
                };
                let i = y * row_len + x * nc + c;
                let left = || i32::from(out[i - nc]);
                let above = || i32::from(out[i - row_len]);
                let pred = if start {
                    initial
                } else if fresh_row || predictor == 0 {
                    left()
                } else if x == 0 {
                    above()
                } else {
                    let (a, b, cc) = (left(), above(), i32::from(out[i - row_len - nc]));
                    match predictor {
                        1 => a,
                        2 => b,
                        3 => cc,
                        4 => a + b - cc,
                        5 => a + ((b - cc) >> 1),
                        6 => b + ((a - cc) >> 1),
                        _ => (a + b) >> 1,
                    }
                };
                out[i] = ((pred + diff) & mask) as u16;
            }
            start = false;
            since_restart += 1;
        }
        fresh_row = false;
    }
    if point > 0 {
        out.iter_mut().for_each(|s| *s <<= point);
    }
    Ok(Frame {
        width,
        height,
        components: nc,
        samples: out,
    })
}
