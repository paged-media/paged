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

//! Compact Table Format back to TrueType (MTX §4–§7).
//!
//! The first block is a font whose `glyf`, `cvt `, `hdmx` and `VDMX` tables
//! are encoded and whose `loca` is empty; every other table is as it was.
//! `glyf` is rebuilt glyph by glyph, pulling each glyph program's initial
//! push values from the second block and the rest of its instructions from
//! the third, and `loca` is written from the rebuilt glyphs.

use crate::sfnt::{self, rd16, Be};
use crate::{malformed, Error, Limits, Result};

/// Rebuild the TrueType file from the three decompressed blocks.
pub(crate) fn rebuild(
    tables: &[u8],
    push: &[u8],
    code: &[u8],
    limits: &Limits,
    notes: &mut Vec<String>,
) -> Result<Vec<u8>> {
    let (version, dir) = sfnt::read(tables)?;
    let find = |tag: &[u8; 4]| dir.iter().find(|t| &t.tag == tag).map(|t| t.data);
    let num_glyphs = find(b"maxp").and_then(|m| rd16(m, 4)).unwrap_or(0) as usize;
    let mut out: Vec<([u8; 4], Vec<u8>)> = Vec::with_capacity(dir.len());
    let mut size = 0usize;
    let mut add = |out: &mut Vec<([u8; 4], Vec<u8>)>, tag: [u8; 4], data: Vec<u8>| -> Result<()> {
        size += data.len() + 16;
        if size > limits.max_font_bytes {
            return Err(Error::TooLarge(limits.max_font_bytes));
        }
        out.push((tag, data));
        Ok(())
    };

    let glyphs = match find(b"glyf") {
        Some(glyf) => Some(glyf::rebuild(glyf, push, code, num_glyphs, limits, notes)?),
        None => None,
    };
    for t in &dir {
        match &t.tag {
            // Rebuilt below; a signature cannot survive the rebuild.
            b"glyf" | b"loca" | b"DSIG" => {}
            b"cvt " => add(&mut out, t.tag, cvt(t.data)?)?,
            b"hdmx" => match hdmx(t.data, &dir, num_glyphs) {
                Ok(d) => add(&mut out, t.tag, d)?,
                Err(e) => notes.push(format!("hdmx left out: {e}")),
            },
            b"VDMX" => match vdmx(t.data) {
                Ok(d) => add(&mut out, t.tag, d)?,
                Err(e) => notes.push(format!("VDMX left out: {e}")),
            },
            _ => add(&mut out, t.tag, t.data.to_vec())?,
        }
    }
    if let Some((glyf, offsets)) = glyphs {
        let Some((_, head)) = out.iter_mut().find(|(tag, _)| tag == b"head") else {
            return malformed("a glyf table without a head table");
        };
        if head.len() < 54 {
            return Err(Error::Truncated("head"));
        }
        // Short offsets hold up to 0x1FFFE; switch to long ones past that.
        let short = rd16(head, 50) == Some(0) && glyf.len() <= 0x1FFFE;
        head[50..52].copy_from_slice(&(if short { 0u16 } else { 1u16 }).to_be_bytes());
        let mut loca = Vec::with_capacity(offsets.len() * if short { 2 } else { 4 });
        for &o in &offsets {
            if short {
                loca.extend_from_slice(&((o / 2) as u16).to_be_bytes());
            } else {
                loca.extend_from_slice(&o.to_be_bytes());
            }
        }
        add(&mut out, *b"glyf", glyf)?;
        add(&mut out, *b"loca", loca)?;
    }
    Ok(sfnt::write(version, out))
}

// ─── cvt ──────────────────────────────────────────────────────────────

/// `cvt `: a count, then each value's difference from the previous one in
/// one to three bytes (MTX §5.2).
fn cvt(data: &[u8]) -> Result<Vec<u8>> {
    const LOWEST: i32 = 238; // cvt_lowestCode == cvt_wordCode
    let mut r = Be::new(data, "cvt");
    let n = r.u16()? as usize;
    let mut out = Vec::with_capacity(2 * n);
    let mut last = 0u16;
    for _ in 0..n {
        let code = r.u8()? as i32;
        let delta = match code {
            c if c < LOWEST => c,
            // cvt_pos1 ..= cvt_pos8
            248..=255 => r.u8()? as i32 + (code - 247) * LOWEST,
            // cvt_neg0 ..= cvt_neg8
            239..=247 => -(r.u8()? as i32 + (code - 239) * LOWEST),
            _ => r.i16()? as i32,
        };
        last = last.wrapping_add(delta as u16);
        out.extend_from_slice(&last.to_be_bytes());
    }
    Ok(out)
}

// ─── hdmx and VDMX ────────────────────────────────────────────────────

/// Magnitude-dependent values (MTX §5.3): `n` one bits and a zero give the
/// magnitude `n`, then (when `n > 0`) a sign bit, `1` for negative. Bits
/// run from the least significant bit of each byte.
struct Magnitudes<'a> {
    b: &'a [u8],
    bit: usize,
}

impl Magnitudes<'_> {
    fn next_bit(&mut self) -> Result<bool> {
        let byte = *self
            .b
            .get(self.bit / 8)
            .ok_or(Error::Truncated("magnitude-coded values"))?;
        let v = (byte >> (self.bit % 8)) & 1 == 1;
        self.bit += 1;
        Ok(v)
    }
    fn value(&mut self) -> Result<i32> {
        let mut n = 0i32;
        while self.next_bit()? {
            n += 1;
            if n > 0xFFFF {
                return malformed("magnitude-coded value");
            }
        }
        if n > 0 && self.next_bit()? {
            n = -n;
        }
        Ok(n)
    }
    /// The byte after the current bit (rounding up within a byte).
    fn byte_after(&self) -> usize {
        self.bit.div_ceil(8)
    }
}

/// The advance width of each glyph (`hmtx` with `hhea`).
fn advances(dir: &[sfnt::Table<'_>], num_glyphs: usize) -> Result<Vec<u16>> {
    let find = |tag: &[u8; 4]| dir.iter().find(|t| &t.tag == tag).map(|t| t.data);
    let hhea = find(b"hhea").ok_or(Error::Truncated("hhea"))?;
    let hmtx = find(b"hmtx").ok_or(Error::Truncated("hmtx"))?;
    let n = rd16(hhea, 34).ok_or(Error::Truncated("hhea"))? as usize;
    if n == 0 {
        return malformed("no horizontal metrics");
    }
    let mut out = Vec::with_capacity(num_glyphs);
    for g in 0..num_glyphs {
        out.push(rd16(hmtx, 4 * g.min(n - 1)).ok_or(Error::Truncated("hmtx"))?);
    }
    Ok(out)
}

/// `hdmx`: each record's widths as the error against the advance width
/// scaled to its size (MTX §5.4). A version of `0xFFFF - v` marks a table
/// stored as it was.
fn hdmx(data: &[u8], dir: &[sfnt::Table<'_>], num_glyphs: usize) -> Result<Vec<u8>> {
    let mut r = Be::new(data, "hdmx");
    let version = r.u16()?;
    if version > 0x8000 {
        let mut out = data.to_vec();
        out[0..2].copy_from_slice(&(0xFFFF - version).to_be_bytes());
        return Ok(out);
    }
    let records = r.u16()? as usize;
    let record_size = r.u32()? as usize;
    if record_size < 2 + num_glyphs || record_size > 2 + num_glyphs + 8 {
        return malformed(format!(
            "hdmx record size {record_size} for {num_glyphs} glyphs"
        ));
    }
    let heads = r.take(2 * records)?;
    let units_per_em = dir
        .iter()
        .find(|t| &t.tag == b"head")
        .and_then(|t| rd16(t.data, 18))
        .filter(|&u| u > 0)
        .ok_or(Error::Truncated("head"))? as i64;
    let aw = advances(dir, num_glyphs)?;
    let mut bits = Magnitudes {
        b: &data[r.at..],
        bit: 0,
    };
    let mut out = Vec::with_capacity(8 + records * record_size);
    out.extend_from_slice(&version.to_be_bytes());
    out.extend_from_slice(&(records as u16).to_be_bytes());
    out.extend_from_slice(&(record_size as u32).to_be_bytes());
    for rec in heads.chunks_exact(2) {
        let (ppem, max_width) = (rec[0] as i64, rec[1]);
        let start = out.len();
        out.extend_from_slice(&[rec[0], max_width]);
        for &a in &aw {
            let predicted = ((64 * ppem * a as i64 + units_per_em / 2) / units_per_em + 32) / 64;
            let width = predicted + bits.value()? as i64;
            if !(0..=255).contains(&width) {
                return malformed("hdmx width out of range");
            }
            out.push(width as u8);
        }
        out.resize(start + record_size, 0);
    }
    Ok(out)
}

/// `VDMX`: each group's heights as the error against a prediction from
/// the group's two multipliers (MTX §5.5).
///
/// The compressor keeps the header, ratio offsets included, as it was, and
/// writes one compressed group per ratio, one after the other from the
/// first ratio's offset. The groups are read back the same way and laid out
/// again in offset order, which gives the original offsets back.
fn vdmx(data: &[u8]) -> Result<Vec<u8>> {
    let mut r = Be::new(data, "VDMX");
    let version = r.u16()?;
    if version > 1 {
        let real = 0xFFFFu16.wrapping_sub(version);
        if real > 1 {
            return malformed(format!("VDMX version {version:#06x}"));
        }
        let mut out = data.to_vec();
        out[0..2].copy_from_slice(&real.to_be_bytes());
        return Ok(out);
    }
    let _groups = r.u16()?;
    let ratios = r.u16()? as usize;
    let ratio_records = r.take(4 * ratios)?;
    let mut offsets = Vec::with_capacity(ratios);
    for _ in 0..ratios {
        offsets.push(r.u16()? as usize);
    }
    let mut at = offsets.first().copied().unwrap_or(r.at);
    // One compressed group per ratio, in ratio order.
    let mut bodies: Vec<Vec<u8>> = Vec::with_capacity(ratios);
    for _ in 0..ratios {
        let mut g = Be::new(data, "VDMX group");
        g.at = at;
        let recs = g.u16()? as usize;
        let y_max_mult = g.i16()? as i32;
        let y_min_mult = g.i16()? as i32;
        let mut bits = Magnitudes {
            b: data.get(g.at..).ok_or(Error::Truncated("VDMX group"))?,
            bit: 0,
        };
        let mut body = Vec::with_capacity(4 + 6 * recs);
        body.extend_from_slice(&(recs as u16).to_be_bytes());
        body.extend_from_slice(&[0, 0]); // startsz, endsz: below
        let mut predicted_ppem = 8i32;
        for j in 0..recs {
            let ppem = predicted_ppem + bits.value()?;
            let y_max = (ppem * y_max_mult + 1024) / 2048 + bits.value()?;
            let y_min = -((ppem * y_min_mult + 1024) / 2048) + bits.value()?;
            if !(0..=0xFFFF).contains(&ppem)
                || i16::try_from(y_max).is_err()
                || i16::try_from(y_min).is_err()
            {
                return malformed("VDMX value out of range");
            }
            if j == 0 {
                body[2] = ppem.min(255) as u8;
            }
            body[3] = ppem.min(255) as u8;
            body.extend_from_slice(&(ppem as u16).to_be_bytes());
            body.extend_from_slice(&(y_max as i16).to_be_bytes());
            body.extend_from_slice(&(y_min as i16).to_be_bytes());
            predicted_ppem = ppem + 1;
        }
        at = g.at + bits.byte_after();
        bodies.push(body);
    }
    // Each distinct offset is one group (the first ratio naming it), laid
    // out in offset order after the header.
    let mut distinct: Vec<(usize, usize)> = Vec::with_capacity(ratios);
    for (i, &off) in offsets.iter().enumerate() {
        if !distinct.iter().any(|&(o, _)| o == off) {
            distinct.push((off, i));
        }
    }
    distinct.sort_unstable();
    let mut placed = Vec::with_capacity(distinct.len());
    let mut pos = 6 + 6 * ratios;
    for &(off, i) in &distinct {
        placed.push((off, pos));
        pos += bodies[i].len();
    }
    if pos > 0xFFFF + 1 {
        return malformed("VDMX too large");
    }
    let mut out = Vec::with_capacity(pos);
    out.extend_from_slice(&version.to_be_bytes());
    out.extend_from_slice(&(distinct.len() as u16).to_be_bytes());
    out.extend_from_slice(&(ratios as u16).to_be_bytes());
    out.extend_from_slice(ratio_records);
    for off in &offsets {
        let (_, new) = placed
            .iter()
            .find(|(o, _)| o == off)
            .expect("every offset is placed");
        out.extend_from_slice(&(*new as u16).to_be_bytes());
    }
    for &(_, i) in &distinct {
        out.extend_from_slice(&bodies[i]);
    }
    Ok(out)
}

// ─── glyf ─────────────────────────────────────────────────────────────

pub(crate) mod glyf {
    use super::*;

    /// TrueType composite flags.
    const ARG_WORDS: u16 = 0x0001;
    const HAVE_SCALE: u16 = 0x0008;
    const MORE_COMPONENTS: u16 = 0x0020;
    const HAVE_XY_SCALE: u16 = 0x0040;
    const HAVE_2X2: u16 = 0x0080;
    const HAVE_INSTRUCTIONS: u16 = 0x0100;

    /// `255UShort` (MTX §6.1.1).
    pub(crate) fn u255(r: &mut Be<'_>) -> Result<u16> {
        Ok(match r.u8()? {
            253 => r.u16()?,
            255 => 253 + r.u8()? as u16,
            254 => 506 + r.u8()? as u16,
            c => c as u16,
        })
    }

    /// `255Short` (MTX §6.1.2).
    pub(crate) fn s255(r: &mut Be<'_>) -> Result<i16> {
        let mut code = r.u8()?;
        if code == 253 {
            return r.i16();
        }
        let negative = code == 250;
        if negative {
            code = r.u8()?;
        }
        let v = match code {
            255 => 250 + r.u8()? as i32,
            254 => 500 + r.u8()? as i32,
            c => c as i32,
        };
        Ok(if negative { -v } else { v } as i16)
    }

    /// A glyph program's initial push values, hop codes expanded (§6.2.4).
    pub(crate) fn push_values(r: &mut Be<'_>, count: usize) -> Result<Vec<i16>> {
        const HOP3: u8 = 251;
        const HOP4: u8 = 252;
        let mut v: Vec<i16> = Vec::with_capacity(count);
        while v.len() < count {
            let code = r.peek()?;
            if code == HOP3 || code == HOP4 {
                r.u8()?;
                let Some(&a) = v.len().checked_sub(2).and_then(|i| v.get(i)) else {
                    return malformed("a hop code without two values before it");
                };
                v.push(a);
                v.push(s255(r)?);
                v.push(a);
                if code == HOP4 {
                    v.push(s255(r)?);
                    v.push(a);
                }
            } else {
                v.push(s255(r)?);
            }
        }
        if v.len() != count {
            return malformed("push data runs past its count");
        }
        Ok(v)
    }

    /// TrueType instructions pushing `values`: byte runs as `PUSHB` /
    /// `NPUSHB`, the rest as `PUSHW` / `NPUSHW`.
    pub(crate) fn push_instructions(values: &[i16], out: &mut Vec<u8>) {
        let is_byte = |v: i16| (0..=255).contains(&v);
        let mut i = 0;
        while i < values.len() {
            let bytes = is_byte(values[i]);
            let mut j = i;
            while j < values.len() && is_byte(values[j]) == bytes && j - i < 255 {
                j += 1;
            }
            let run = &values[i..j];
            let n = run.len() as u8;
            match (bytes, run.len() <= 8) {
                (true, true) => out.push(0xB0 + n - 1),
                (false, true) => out.push(0xB8 + n - 1),
                (true, false) => out.extend_from_slice(&[0x40, n]),
                (false, false) => out.extend_from_slice(&[0x41, n]),
            }
            for &v in run {
                if bytes {
                    out.push(v as u8);
                } else {
                    out.extend_from_slice(&v.to_be_bytes());
                }
            }
            i = j;
        }
    }

    /// The three streams a glyph reads from.
    struct Streams<'a> {
        glyf: Be<'a>,
        push: Be<'a>,
        code: Be<'a>,
    }

    impl Streams<'_> {
        /// A glyph program: `pushCount` and `codeSize` from the glyph data,
        /// the values from the push block, the bytes from the code block.
        fn program(&mut self) -> Result<Vec<u8>> {
            let push_count = u255(&mut self.glyf)? as usize;
            let code_size = u255(&mut self.glyf)? as usize;
            let values = push_values(&mut self.push, push_count)?;
            let mut out = Vec::with_capacity(code_size + 3 * push_count);
            push_instructions(&values, &mut out);
            out.extend_from_slice(self.code.take(code_size)?);
            if out.len() > 0xFFFF {
                return malformed("glyph program longer than 65 535 bytes");
            }
            Ok(out)
        }
    }

    /// One point's displacement from its flag byte's index (§5.11).
    fn triplet(index: u8, r: &mut Be<'_>) -> Result<(i32, i32)> {
        let sign = |positive: bool, v: i32| if positive { v } else { -v };
        let i = index as i32;
        let x_pos = index & 1 != 0;
        let y_pos = index & 2 != 0;
        Ok(match index {
            0..=9 => (0, sign(x_pos, ((i & 14) << 7) + r.u8()? as i32)),
            10..=19 => (sign(x_pos, (((i - 10) & 14) << 7) + r.u8()? as i32), 0),
            20..=83 => {
                let (b0, b1) = (i - 20, r.u8()? as i32);
                (
                    sign(x_pos, 1 + (b0 & 0x30) + (b1 >> 4)),
                    sign(y_pos, 1 + ((b0 & 0x0C) << 2) + (b1 & 0x0F)),
                )
            }
            84..=119 => {
                let b0 = i - 84;
                let (bx, by) = (r.u8()? as i32, r.u8()? as i32);
                (
                    sign(x_pos, 1 + ((b0 / 12) << 8) + bx),
                    sign(y_pos, 1 + (((b0 % 12) >> 2) << 8) + by),
                )
            }
            120..=123 => {
                let b = r.take(3)?;
                let (b1, b2, b3) = (b[0] as i32, b[1] as i32, b[2] as i32);
                (
                    sign(x_pos, (b1 << 4) + (b2 >> 4)),
                    sign(y_pos, ((b2 & 0x0F) << 8) + b3),
                )
            }
            _ => {
                let b = r.take(4)?;
                (
                    sign(x_pos, (b[0] as i32) << 8 | b[1] as i32),
                    sign(y_pos, (b[2] as i32) << 8 | b[3] as i32),
                )
            }
        })
    }

    fn put16(out: &mut Vec<u8>, v: u16) {
        out.extend_from_slice(&v.to_be_bytes());
    }

    /// A simple glyph: contour ends, flags and point triplets, then its
    /// program (§5.9).
    fn simple(
        s: &mut Streams<'_>,
        contours: usize,
        bbox: Option<[i16; 4]>,
        out: &mut Vec<u8>,
    ) -> Result<()> {
        let mut ends = Vec::with_capacity(contours);
        let mut last = 0u32;
        for i in 0..contours {
            let v = u255(&mut s.glyf)? as u32;
            last = if i == 0 { v } else { last + v };
            if last > 0xFFFE {
                return malformed("glyph with more than 65 535 points");
            }
            ends.push(last as u16);
        }
        let points = if contours == 0 { 0 } else { last as usize + 1 };
        let flags = s.glyf.take(points)?;
        let (mut x, mut y) = (0i32, 0i32);
        let mut coords = Vec::with_capacity(points);
        for &f in flags {
            let (dx, dy) = triplet(f & 0x7F, &mut s.glyf)?;
            x += dx;
            y += dy;
            if i16::try_from(x).is_err() || i16::try_from(y).is_err() {
                return malformed("glyph coordinate out of range");
            }
            coords.push((dx, dy, f & 0x80 == 0));
        }
        let program = s.program()?;
        let bbox = bbox.unwrap_or_else(|| {
            let (mut px, mut py) = (0i32, 0i32);
            let mut b = [i16::MAX, i16::MAX, i16::MIN, i16::MIN];
            for &(dx, dy, _) in &coords {
                px += dx;
                py += dy;
                b = [
                    b[0].min(px as i16),
                    b[1].min(py as i16),
                    b[2].max(px as i16),
                    b[3].max(py as i16),
                ];
            }
            if coords.is_empty() {
                [0; 4]
            } else {
                b
            }
        });
        put16(out, contours as u16);
        for v in bbox {
            put16(out, v as u16);
        }
        for e in ends {
            put16(out, e);
        }
        put16(out, program.len() as u16);
        out.extend_from_slice(&program);
        // Flags (repeat-compressed), then the x and y deltas.
        let (mut xs, mut ys) = (Vec::new(), Vec::new());
        let mut fl: Vec<u8> = Vec::with_capacity(points);
        for &(dx, dy, on) in &coords {
            let mut f = u8::from(on);
            if dx == 0 {
                f |= 0x10;
            } else if dx.abs() < 256 {
                f |= 0x02 | if dx > 0 { 0x10 } else { 0 };
                xs.push(dx.unsigned_abs() as u8);
            } else {
                xs.extend_from_slice(&(dx as i16).to_be_bytes());
            }
            if dy == 0 {
                f |= 0x20;
            } else if dy.abs() < 256 {
                f |= 0x04 | if dy > 0 { 0x20 } else { 0 };
                ys.push(dy.unsigned_abs() as u8);
            } else {
                ys.extend_from_slice(&(dy as i16).to_be_bytes());
            }
            fl.push(f);
        }
        let mut i = 0;
        while i < fl.len() {
            let f = fl[i];
            let mut run = 1;
            while i + run < fl.len() && fl[i + run] == f && run < 256 {
                run += 1;
            }
            if run > 1 {
                out.extend_from_slice(&[f | 0x08, (run - 1) as u8]);
            } else {
                out.push(f);
            }
            i += run;
        }
        out.extend_from_slice(&xs);
        out.extend_from_slice(&ys);
        Ok(())
    }

    /// A composite glyph: its components as TrueType writes them, then its
    /// program when the last component says it has one (§5.10).
    fn composite(s: &mut Streams<'_>, bbox: [i16; 4], out: &mut Vec<u8>) -> Result<()> {
        put16(out, 0xFFFF);
        for v in bbox {
            put16(out, v as u16);
        }
        loop {
            let flags = s.glyf.u16()?;
            let glyph = s.glyf.u16()?;
            put16(out, flags);
            put16(out, glyph);
            let args = if flags & ARG_WORDS != 0 { 4 } else { 2 };
            let transform = if flags & HAVE_SCALE != 0 {
                2
            } else if flags & HAVE_XY_SCALE != 0 {
                4
            } else if flags & HAVE_2X2 != 0 {
                8
            } else {
                0
            };
            out.extend_from_slice(s.glyf.take(args + transform)?);
            if flags & MORE_COMPONENTS == 0 {
                if flags & HAVE_INSTRUCTIONS != 0 {
                    let program = s.program()?;
                    put16(out, program.len() as u16);
                    out.extend_from_slice(&program);
                }
                return Ok(());
            }
        }
    }

    fn bbox(r: &mut Be<'_>) -> Result<[i16; 4]> {
        Ok([r.i16()?, r.i16()?, r.i16()?, r.i16()?])
    }

    /// Rebuild `glyf` and the glyph offsets `loca` lists (`num_glyphs + 1`).
    pub(crate) fn rebuild(
        glyf: &[u8],
        push: &[u8],
        code: &[u8],
        num_glyphs: usize,
        limits: &Limits,
        notes: &mut Vec<String>,
    ) -> Result<(Vec<u8>, Vec<u32>)> {
        let mut s = Streams {
            glyf: Be::new(glyf, "CTF glyf"),
            push: Be::new(push, "CTF push data"),
            code: Be::new(code, "CTF instructions"),
        };
        let mut out = Vec::with_capacity(glyf.len() * 2);
        let mut offsets = Vec::with_capacity(num_glyphs + 1);
        for _ in 0..num_glyphs {
            offsets.push(out.len() as u32);
            let contours = s.glyf.i16()?;
            if contours < 0 {
                let b = bbox(&mut s.glyf)?;
                composite(&mut s, b, &mut out)?;
            } else if contours == 0x7FFF {
                let contours = s.glyf.i16()?;
                if contours < 0 {
                    return malformed("negative contour count after the bounding-box flag");
                }
                let b = bbox(&mut s.glyf)?;
                simple(&mut s, contours as usize, Some(b), &mut out)?;
            } else if contours > 0 {
                simple(&mut s, contours as usize, None, &mut out)?;
            }
            // Zero contours: an empty glyph, no data.
            out.resize(out.len().div_ceil(4) * 4, 0);
            if out.len() > limits.max_font_bytes {
                return Err(Error::TooLarge(limits.max_font_bytes));
            }
        }
        offsets.push(out.len() as u32);
        for (left, what) in [
            (glyf.len() - s.glyf.at, "glyph data"),
            (push.len() - s.push.at, "push data"),
            (code.len() - s.code.at, "instructions"),
        ] {
            if left > 3 {
                notes.push(format!("{left} bytes of {what} left after the last glyph"));
            }
        }
        Ok((out, offsets))
    }
}

#[cfg(test)]
mod tests {
    use super::glyf::*;
    use super::*;

    #[test]
    fn u255_and_s255_read_as_specified() {
        let mut r = Be::new(&[7, 255, 3, 254, 0, 253, 0x12, 0x34], "t");
        assert_eq!(u255(&mut r).unwrap(), 7);
        assert_eq!(u255(&mut r).unwrap(), 256);
        assert_eq!(u255(&mut r).unwrap(), 506);
        assert_eq!(u255(&mut r).unwrap(), 0x1234);
        let mut r = Be::new(
            &[249, 250, 5, 255, 0, 250, 254, 5, 253, 0xFF, 0xFE, 251],
            "t",
        );
        assert_eq!(s255(&mut r).unwrap(), 249);
        assert_eq!(s255(&mut r).unwrap(), -5);
        assert_eq!(s255(&mut r).unwrap(), 250);
        assert_eq!(s255(&mut r).unwrap(), -505);
        assert_eq!(s255(&mut r).unwrap(), -2);
        // Read as a value (no hop) it is the number itself.
        assert_eq!(s255(&mut r).unwrap(), 251);
    }

    #[test]
    fn hop_codes_repeat_the_value_two_back() {
        // A, X1, Hop3, X2 -> A, X1, A, X2, A; then Hop4 with X3, X4.
        let mut r = Be::new(&[9, 1, 251, 2, 252, 3, 4], "t");
        assert_eq!(
            push_values(&mut r, 10).unwrap(),
            [9, 1, 9, 2, 9, 2, 3, 2, 4, 2]
        );
        let mut r = Be::new(&[251, 1], "t");
        assert!(push_values(&mut r, 3).is_err());
        // A hop that runs past the count.
        let mut r = Be::new(&[1, 2, 251, 3], "t");
        assert!(push_values(&mut r, 4).is_err());
    }

    #[test]
    fn push_values_become_byte_and_word_pushes() {
        let mut out = Vec::new();
        push_instructions(&[1, 2, 300, -1, 4], &mut out);
        assert_eq!(out, [0xB1, 1, 2, 0xB9, 0x01, 0x2C, 0xFF, 0xFF, 0xB0, 4]);
        let mut out = Vec::new();
        push_instructions(&[7; 9], &mut out);
        assert_eq!(&out[..2], &[0x40, 9]);
        assert_eq!(out.len(), 11);
    }

    #[test]
    fn cvt_values_are_deltas_in_one_to_three_bytes() {
        // Four entries: +10, +(238 + 2), -5, then a word.
        let d = [0, 4, 10, 248, 2, 239, 5, 238, 0x80, 0x00];
        let out = cvt(&d).unwrap();
        let v: Vec<i16> = out
            .chunks(2)
            .map(|c| i16::from_be_bytes([c[0], c[1]]))
            .collect();
        assert_eq!(v, [10, 250, 245, 245i16.wrapping_add(i16::MIN)]);
    }

    #[test]
    fn magnitude_coding_matches_the_specification_example() {
        // MTX §5.3.1: the bits of 0x90 0x48 0x84, least significant
        // first, hold 0 0 0 0 +1 +1 0 +1 +1 0 +1 0 0 and the start of
        // another value.
        let mut m = Magnitudes {
            b: &[0x90, 0x48, 0x84],
            bit: 0,
        };
        let got: Vec<i32> = (0..13).map(|_| m.value().unwrap()).collect();
        assert_eq!(got, [0, 0, 0, 0, 1, 1, 0, 1, 1, 0, 1, 0, 0]);
        assert!(m.value().is_err());
        // Signs: 1 1 0 1 = -2.
        let mut m = Magnitudes {
            b: &[0b1011],
            bit: 0,
        };
        assert_eq!(m.value().unwrap(), -2);
    }
}
