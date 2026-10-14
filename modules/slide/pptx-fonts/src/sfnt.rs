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

//! The OpenType file structure: reading a table directory, writing a font
//! with its checksums, and a big-endian reader the table decoders share.

use crate::{malformed, Error, Result};

/// A big-endian cursor over a table.
pub(crate) struct Be<'a> {
    pub(crate) b: &'a [u8],
    pub(crate) at: usize,
    what: &'static str,
}

impl<'a> Be<'a> {
    pub(crate) fn new(b: &'a [u8], what: &'static str) -> Self {
        Be { b, at: 0, what }
    }
    pub(crate) fn take(&mut self, n: usize) -> Result<&'a [u8]> {
        let end = self.at.checked_add(n).ok_or(Error::Truncated(self.what))?;
        let s = self
            .b
            .get(self.at..end)
            .ok_or(Error::Truncated(self.what))?;
        self.at = end;
        Ok(s)
    }
    pub(crate) fn peek(&self) -> Result<u8> {
        self.b
            .get(self.at)
            .copied()
            .ok_or(Error::Truncated(self.what))
    }
    pub(crate) fn u8(&mut self) -> Result<u8> {
        Ok(self.take(1)?[0])
    }
    pub(crate) fn u16(&mut self) -> Result<u16> {
        let s = self.take(2)?;
        Ok(u16::from_be_bytes([s[0], s[1]]))
    }
    pub(crate) fn i16(&mut self) -> Result<i16> {
        Ok(self.u16()? as i16)
    }
    pub(crate) fn u32(&mut self) -> Result<u32> {
        let s = self.take(4)?;
        Ok(u32::from_be_bytes([s[0], s[1], s[2], s[3]]))
    }
}

pub(crate) fn rd16(b: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_be_bytes([*b.get(at)?, *b.get(at + 1)?]))
}

/// One table of a font as it is read: its tag and bytes.
pub(crate) struct Table<'a> {
    pub(crate) tag: [u8; 4],
    pub(crate) data: &'a [u8],
}

/// The sfnt version and tables of `font`. A table whose record points
/// outside the font is an error, except an empty one (CTF's `loca`).
pub(crate) fn read(font: &[u8]) -> Result<(u32, Vec<Table<'_>>)> {
    let mut r = Be::new(font, "table directory");
    let version = r.u32()?;
    if !matches!(version, 0x0001_0000 | 0x7472_7565 | 0x4F54_544F) {
        return malformed(format!("sfnt version {version:#010x}"));
    }
    let n = r.u16()? as usize;
    r.take(6)?;
    let mut tables = Vec::with_capacity(n);
    for _ in 0..n {
        let tag: [u8; 4] = r.take(4)?.try_into().expect("four bytes");
        let _checksum = r.u32()?;
        let offset = r.u32()? as usize;
        let length = r.u32()? as usize;
        let data = if length == 0 {
            &font[0..0]
        } else {
            offset
                .checked_add(length)
                .and_then(|end| font.get(offset..end))
                .ok_or_else(|| {
                    Error::Malformed(format!(
                        "table {} outside the font",
                        String::from_utf8_lossy(&tag)
                    ))
                })?
        };
        tables.push(Table { tag, data });
    }
    Ok((version, tables))
}

/// Check that `font` is an OpenType file whose tables lie inside it.
pub(crate) fn check(font: &[u8]) -> Result<()> {
    read(font).map(|_| ())
}

/// OS/2 `fsType` of a font; zero (the least restrictive) when it has no
/// OS/2 table.
pub(crate) fn fs_type(font: &[u8]) -> Result<u16> {
    let (_, tables) = read(font)?;
    Ok(tables
        .iter()
        .find(|t| &t.tag == b"OS/2")
        .and_then(|t| rd16(t.data, 8))
        .unwrap_or(0))
}

/// The OpenType checksum of `data` (big-endian words, zero-padded).
pub(crate) fn checksum(data: &[u8]) -> u32 {
    data.chunks(4).fold(0u32, |sum, c| {
        let mut w = [0u8; 4];
        w[..c.len()].copy_from_slice(c);
        sum.wrapping_add(u32::from_be_bytes(w))
    })
}

/// Write a font: tables sorted by tag, each 4-byte aligned, with their
/// checksums and `head.checkSumAdjustment`.
pub(crate) fn write(version: u32, mut tables: Vec<([u8; 4], Vec<u8>)>) -> Vec<u8> {
    tables.sort_by(|a, b| a.0.cmp(&b.0));
    let n = tables.len();
    let pow = if n == 0 {
        0
    } else {
        usize::BITS - 1 - n.leading_zeros()
    };
    let search_range = (1usize << pow) * 16;
    let mut out = Vec::new();
    out.extend_from_slice(&version.to_be_bytes());
    out.extend_from_slice(&(n as u16).to_be_bytes());
    out.extend_from_slice(&(search_range as u16).to_be_bytes());
    out.extend_from_slice(&(pow as u16).to_be_bytes());
    out.extend_from_slice(&((n * 16).saturating_sub(search_range) as u16).to_be_bytes());
    let mut offset = 12 + 16 * n;
    let mut head_at = None;
    for (tag, data) in &mut tables {
        if tag == b"head" && data.len() >= 12 {
            data[8..12].copy_from_slice(&[0; 4]);
            head_at = Some(offset);
        }
        out.extend_from_slice(tag);
        out.extend_from_slice(&checksum(data).to_be_bytes());
        out.extend_from_slice(&(offset as u32).to_be_bytes());
        out.extend_from_slice(&(data.len() as u32).to_be_bytes());
        offset += data.len().div_ceil(4) * 4;
    }
    for (_, data) in &tables {
        out.extend_from_slice(data);
        out.resize(out.len().div_ceil(4) * 4, 0);
    }
    if let Some(at) = head_at {
        let adjust = 0xB1B0_AFBAu32.wrapping_sub(checksum(&out));
        out[at + 8..at + 12].copy_from_slice(&adjust.to_be_bytes());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_written_font_reads_back_with_valid_checksums() {
        let mut head = vec![0u8; 54];
        head[8..12].copy_from_slice(&[1, 2, 3, 4]);
        let font = write(
            0x0001_0000,
            vec![
                (*b"name", vec![1, 2, 3]),
                (*b"head", head),
                (*b"cmap", vec![9; 8]),
            ],
        );
        let (version, tables) = read(&font).unwrap();
        assert_eq!(version, 0x0001_0000);
        let tags: Vec<&[u8; 4]> = tables.iter().map(|t| &t.tag).collect();
        assert_eq!(tags, [b"cmap", b"head", b"name"]);
        assert_eq!(tables[2].data, &[1, 2, 3]);
        // The whole file sums to the magic once the adjustment is in.
        assert_eq!(checksum(&font), 0xB1B0_AFBA);
        assert_eq!(&font[4..12], &[0, 3, 0, 32, 0, 1, 0, 16]);
    }

    #[test]
    fn a_table_outside_the_font_is_an_error() {
        let mut font = write(0x0001_0000, vec![(*b"name", vec![1, 2, 3, 4])]);
        font.truncate(font.len() - 2);
        assert!(read(&font).is_err());
        assert!(read(b"\x00\x01").is_err());
    }
}
