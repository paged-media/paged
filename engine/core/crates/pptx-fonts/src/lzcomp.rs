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

//! LZCOMP decompression (MTX §3.3 and appendix C).
//!
//! A block is one bit saying whether its output is run-length coded, 24
//! bits giving the length of the LZ output, then symbols from three
//! adaptive Huffman trees: the symbol tree (a literal byte, a one-byte copy
//! from 2, 4 or 6 bytes back, or the start of a copy item), the length tree
//! (two more length bits per symbol, the third bit saying whether another
//! follows) and the distance tree (three distance bits per symbol). A copy
//! can reach into 7 168 bytes of fixed text the history starts with.

use crate::ahuff::AdaptiveHuffman;
use crate::bits::BitReader;
use crate::{malformed, Error, Result};

/// The fixed text in front of the history (`preLoadSize`).
const PRELOAD: usize = 2 * 32 * 96 + 4 * 256;
/// Copies from this far back are at least three bytes long.
const MAX_2BYTE_DIST: usize = 512;
/// Bits per length symbol, the highest of which says another follows.
const LEN_WIDTH: u32 = 3;
/// Bits per distance symbol.
const DIST_WIDTH: u32 = 3;

/// The history's fixed prefix: the pairs `(k, j)` for `k < 32`, `j < 96`,
/// then every byte value four times.
fn preload(h: &mut Vec<u8>) {
    for k in 0..32u8 {
        for j in 0..96u8 {
            h.push(k);
            h.push(j);
        }
    }
    for j in 0..=255u8 {
        h.extend_from_slice(&[j; 4]);
    }
    debug_assert_eq!(h.len(), PRELOAD);
}

/// The number of distance symbols a copy may use for output of `length`
/// bytes (`SetDistRange`): the smallest `n` with `2^(3n) >= length`.
fn dist_ranges(length: usize) -> usize {
    let mut n = 1usize;
    while (1usize << (DIST_WIDTH as usize * n)) < length {
        n += 1;
    }
    n
}

/// Where output goes: straight out, or through the run-length decoder.
enum Sink {
    Plain(Vec<u8>),
    RunLength {
        out: Vec<u8>,
        state: Rle,
        escape: u8,
        count: u8,
    },
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Rle {
    Initial,
    Normal,
    SeenEscape,
    NeedByte,
}

impl Sink {
    fn push(&mut self, v: u8, max: usize) -> Result<()> {
        match self {
            Sink::Plain(out) => out.push(v),
            Sink::RunLength {
                out,
                state,
                escape,
                count,
            } => match *state {
                // The first byte names the escape byte.
                Rle::Initial => {
                    *escape = v;
                    *state = Rle::Normal;
                }
                Rle::Normal if v == *escape => *state = Rle::SeenEscape,
                Rle::Normal => out.push(v),
                // Escape, 0: the escape byte itself.
                Rle::SeenEscape if v == 0 => {
                    out.push(*escape);
                    *state = Rle::Normal;
                }
                Rle::SeenEscape => {
                    *count = v;
                    *state = Rle::NeedByte;
                }
                // Escape, count, byte: a run.
                Rle::NeedByte => {
                    if out.len() + *count as usize > max {
                        return Err(Error::TooLarge(max));
                    }
                    out.resize(out.len() + *count as usize, v);
                    *state = Rle::Normal;
                }
            },
        }
        let len = match self {
            Sink::Plain(o) => o.len(),
            Sink::RunLength { out, .. } => out.len(),
        };
        if len > max {
            return Err(Error::TooLarge(max));
        }
        Ok(())
    }

    fn finish(self) -> Vec<u8> {
        match self {
            Sink::Plain(o) => o,
            Sink::RunLength { out, .. } => out,
        }
    }
}

/// Decompress one LZCOMP block. `version` is the MTX header's version
/// byte (version 1 blocks have no run-length bit). Output larger than
/// `max` bytes is [`Error::TooLarge`].
pub(crate) fn decompress(data: &[u8], version: u8, max: usize) -> Result<Vec<u8>> {
    let mut bits = BitReader::new(data);
    let run_length = version != 1 && bits.bit()?;
    let mut dist_tree = AdaptiveHuffman::new(1 << DIST_WIDTH);
    let mut len_tree = AdaptiveHuffman::new(1 << LEN_WIDTH);
    let out_len = bits.bits(24)? as usize;
    if out_len > max {
        return Err(Error::TooLarge(max));
    }
    let ranges = dist_ranges(out_len);
    let dup2 = 256 + (1usize << LEN_WIDTH) * ranges;
    let (dup4, dup6) = (dup2 + 1, dup2 + 2);
    let mut sym_tree = AdaptiveHuffman::new(dup2 + 3);

    // Reserve what the input can plausibly hold, not what it claims: a
    // few bytes must not reserve megabytes. The buffers grow past it.
    let reserve = out_len.min(data.len().saturating_mul(16));
    let mut hist = Vec::with_capacity(PRELOAD + reserve);
    preload(&mut hist);
    let mut sink = if run_length {
        Sink::RunLength {
            out: Vec::with_capacity(reserve),
            state: Rle::Initial,
            escape: 0,
            count: 0,
        }
    } else {
        Sink::Plain(Vec::with_capacity(reserve))
    };
    let end = PRELOAD + out_len;
    while hist.len() < end {
        let symbol = sym_tree.read(&mut bits)? as usize;
        let back = match symbol {
            s if s < 256 => {
                hist.push(s as u8);
                sink.push(s as u8, max)?;
                continue;
            }
            s if s == dup2 => 2,
            s if s == dup4 => 4,
            s if s == dup6 => 6,
            s => {
                // A copy item: the first symbol carries the number of
                // distance symbols and the first two length bits.
                let first = s - 256;
                let n_dist = first / (1 << LEN_WIDTH) + 1;
                let mut part = first % (1 << LEN_WIDTH);
                let mut length = 0usize;
                let mut parts = 0;
                loop {
                    length = (length << (LEN_WIDTH - 1)) | (part & 0b11);
                    if part & 0b100 == 0 {
                        break;
                    }
                    parts += 1;
                    if parts > 12 {
                        return malformed("LZCOMP copy length");
                    }
                    part = len_tree.read(&mut bits)? as usize;
                }
                length += 2;
                let mut distance = 0usize;
                for _ in 0..n_dist {
                    distance = (distance << DIST_WIDTH) | dist_tree.read(&mut bits)? as usize;
                }
                distance += 1;
                if distance >= MAX_2BYTE_DIST {
                    length += 1;
                }
                // The distance counts to the copy's last byte.
                let start = hist
                    .len()
                    .checked_sub(distance + length - 1)
                    .ok_or_else(|| Error::Malformed("LZCOMP copy before the history".into()))?;
                if hist.len() + length > end {
                    return malformed("LZCOMP copy past the block's length");
                }
                for j in 0..length {
                    let v = hist[start + j];
                    hist.push(v);
                    sink.push(v, max)?;
                }
                continue;
            }
        };
        let v = hist[hist.len() - back];
        hist.push(v);
        sink.push(v, max)?;
    }
    Ok(sink.finish())
}

/// The encoder's half, enough to drive the decoder in tests: literals,
/// one-byte copies and copy items, with the model the decoder runs.
#[cfg(test)]
pub(crate) mod encode {
    use super::*;

    pub(crate) enum Item {
        Literal(u8),
        Dup(usize),
        Copy { length: usize, distance: usize },
    }

    pub(crate) fn encode(items: &[Item], out_len: usize, run_length: bool) -> Vec<u8> {
        let mut bits = vec![run_length];
        let mut dist_tree = AdaptiveHuffman::new(8);
        let mut len_tree = AdaptiveHuffman::new(8);
        for i in (0..24).rev() {
            bits.push((out_len >> i) & 1 == 1);
        }
        let ranges = dist_ranges(out_len);
        let dup2 = 256 + 8 * ranges;
        let mut sym = AdaptiveHuffman::new(dup2 + 3);
        for item in items {
            match *item {
                Item::Literal(b) => sym.write(b as usize, &mut bits),
                Item::Dup(back) => sym.write(dup2 + back / 2 - 1, &mut bits),
                Item::Copy { length, distance } => {
                    let mut value = length - if distance >= MAX_2BYTE_DIST { 3 } else { 2 };
                    // Two-bit groups, most significant first.
                    let mut groups = Vec::new();
                    loop {
                        groups.push(value & 3);
                        value >>= 2;
                        if value == 0 {
                            break;
                        }
                    }
                    groups.reverse();
                    let mut n_dist = 1;
                    while (distance - 1) >> (3 * n_dist) != 0 {
                        n_dist += 1;
                    }
                    let more = |i: usize| if i + 1 < groups.len() { 4 } else { 0 };
                    sym.write(256 + (n_dist - 1) * 8 + (groups[0] | more(0)), &mut bits);
                    for (i, g) in groups.iter().enumerate().skip(1) {
                        len_tree.write(g | more(i), &mut bits);
                    }
                    for k in (0..n_dist).rev() {
                        dist_tree.write(((distance - 1) >> (3 * k)) & 7, &mut bits);
                    }
                }
            }
        }
        bits.chunks(8)
            .map(|c| {
                c.iter()
                    .enumerate()
                    .fold(0u8, |b, (i, &v)| b | (u8::from(v) << (7 - i)))
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::encode::{encode, Item};
    use super::*;

    #[test]
    fn the_preload_is_the_specified_text() {
        let mut h = Vec::new();
        preload(&mut h);
        assert_eq!(h.len(), 7168);
        assert_eq!(&h[..4], &[0, 0, 0, 1]);
        assert_eq!(&h[6144..6152], &[0, 0, 0, 0, 1, 1, 1, 1]);
        assert_eq!(h[7167], 255);
    }

    #[test]
    fn distance_ranges_follow_the_output_length() {
        assert_eq!(dist_ranges(0), 1);
        assert_eq!(dist_ranges(8), 1);
        assert_eq!(dist_ranges(9), 2);
        assert_eq!(dist_ranges(64), 2);
        assert_eq!(dist_ranges(65), 3);
        assert_eq!(dist_ranges(1 << 24), 8);
    }

    /// What `items` mean, applied the plain way.
    fn expand(items: &[Item]) -> Vec<u8> {
        let mut h = Vec::new();
        preload(&mut h);
        for item in items {
            match *item {
                Item::Literal(b) => h.push(b),
                Item::Dup(back) => h.push(h[h.len() - back]),
                Item::Copy { length, distance } => {
                    let start = h.len() + 1 - distance - length;
                    for j in 0..length {
                        h.push(h[start + j]);
                    }
                }
            }
        }
        h.split_off(PRELOAD)
    }

    #[test]
    fn literals_one_byte_copies_and_copy_items_decode() {
        let items = vec![
            Item::Literal(b'a'),
            Item::Literal(b'b'),
            Item::Literal(b'c'),
            // The copy's last byte is `distance` back: "abc" again.
            Item::Copy {
                length: 3,
                distance: 1,
            },
            Item::Literal(b'X'),
            Item::Copy {
                length: 2,
                distance: 6,
            },
            Item::Dup(2),
            Item::Dup(6),
            Item::Dup(4),
            Item::Copy {
                length: 9,
                distance: 2,
            },
        ];
        let want = expand(&items);
        assert_eq!(&want[..9], b"abcabcXab");
        let packed = encode(&items, want.len(), false);
        assert_eq!(decompress(&packed, 3, 1 << 20).unwrap(), want);
    }

    #[test]
    fn copies_reach_into_the_preload_and_far_back() {
        // Four zero bytes copied from the preload's run of zeros (its last
        // byte sits at 6 147); then a copy from more than 512 back, which
        // is at least three bytes long.
        let mut h = Vec::new();
        preload(&mut h);
        let mut want = vec![0u8; 4];
        let mut items = vec![Item::Copy {
            length: 4,
            distance: h.len() - 6147,
        }];
        for i in 0..600u32 {
            let b = (i * 7 % 251) as u8;
            want.push(b);
            items.push(Item::Literal(b));
        }
        let tail: Vec<u8> = want[4..24].to_vec();
        want.extend_from_slice(&tail);
        // It starts 600 bytes back; the distance counts to its last byte.
        items.push(Item::Copy {
            length: 20,
            distance: 600 - 20 + 1,
        });
        let packed = encode(&items, want.len(), false);
        assert_eq!(decompress(&packed, 3, 1 << 20).unwrap(), want);
    }

    #[test]
    fn run_length_output_expands_runs_and_escapes() {
        // LZ output: escape 0xEE, "A", run of 9 "B", the escape itself, "C".
        let lz = [0xEE, b'A', 0xEE, 9, b'B', 0xEE, 0, b'C'];
        let items: Vec<Item> = lz.iter().map(|&b| Item::Literal(b)).collect();
        let packed = encode(&items, lz.len(), true);
        assert_eq!(decompress(&packed, 3, 1 << 20).unwrap(), b"ABBBBBBBBB\xEEC");
        // Version 1 blocks have no run-length bit: the same bytes misread.
        assert_ne!(
            decompress(&packed, 1, 1 << 20).ok(),
            Some(b"ABBBBBBBBB\xEEC".to_vec())
        );
    }

    #[test]
    fn hostile_blocks_fail_without_panicking() {
        assert!(decompress(&[], 3, 1 << 20).is_err());
        // A huge declared length is refused before anything is allocated.
        assert_eq!(
            decompress(&[0x7F, 0xFF, 0xFF, 0xFF], 3, 1 << 20).unwrap_err(),
            Error::TooLarge(1 << 20)
        );
        // Every truncation and many bit flips of a real block.
        let items: Vec<Item> = (0..200u32)
            .map(|i| {
                if i % 5 == 4 {
                    Item::Copy {
                        length: 3 + (i as usize % 7),
                        distance: 1 + (i as usize % 40),
                    }
                } else {
                    Item::Literal((i * 13) as u8)
                }
            })
            .collect();
        let out_len = items
            .iter()
            .map(|it| match it {
                Item::Copy { length, .. } => *length,
                _ => 1,
            })
            .sum();
        let packed = encode(&items, out_len, false);
        assert_eq!(decompress(&packed, 3, 1 << 20).unwrap().len(), out_len);
        for cut in 0..packed.len() {
            let _ = decompress(&packed[..cut], 3, 1 << 20);
        }
        for i in 0..packed.len() * 8 {
            let mut m = packed.clone();
            m[i / 8] ^= 0x80 >> (i % 8);
            let _ = decompress(&m, 3, 1 << 20);
        }
    }
}
