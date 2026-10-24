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

//! A minimal reader of the TIFF container itself: the header, the IFD
//! chain and raw entry values. `tiff` decodes the pixels; this reads the
//! blobs it has no accessor for (ICC, XMP, IPTC, Photoshop resources) as
//! the file's own bytes, counts the pages, and finds the entry a palette
//! or CIE Lab decode rewrites.

/// Byte order and offset width of a TIFF file.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Header {
    le: bool,
    big: bool,
    first_ifd: u64,
}

/// More IFDs than any real file has; ends a malicious chain.
const MAX_IFDS: usize = 65_536;

impl Header {
    pub(crate) fn read(b: &[u8]) -> Option<Header> {
        let le = match b.get(..2)? {
            b"II" => true,
            b"MM" => false,
            _ => return None,
        };
        let mut h = Header {
            le,
            big: false,
            first_ifd: 0,
        };
        match h.u16(b, 2)? {
            42 => h.first_ifd = u64::from(h.u32(b, 4)?),
            43 => {
                // BigTIFF: offset size 8, a zero, then the first offset.
                if h.u16(b, 4)? != 8 {
                    return None;
                }
                h.big = true;
                h.first_ifd = h.u64(b, 8)?;
            }
            _ => return None,
        }
        Some(h)
    }

    fn u16(&self, b: &[u8], at: usize) -> Option<u16> {
        let s: [u8; 2] = b.get(at..at + 2)?.try_into().ok()?;
        Some(if self.le {
            u16::from_le_bytes(s)
        } else {
            u16::from_be_bytes(s)
        })
    }

    fn u32(&self, b: &[u8], at: usize) -> Option<u32> {
        let s: [u8; 4] = b.get(at..at + 4)?.try_into().ok()?;
        Some(if self.le {
            u32::from_le_bytes(s)
        } else {
            u32::from_be_bytes(s)
        })
    }

    fn u64(&self, b: &[u8], at: usize) -> Option<u64> {
        let s: [u8; 8] = b.get(at..at + 8)?.try_into().ok()?;
        Some(if self.le {
            u64::from_le_bytes(s)
        } else {
            u64::from_be_bytes(s)
        })
    }

    /// Entry count, first entry and entry size of the IFD at `ifd`.
    fn entries(&self, b: &[u8], ifd: u64) -> Option<(usize, usize, usize)> {
        let at = usize::try_from(ifd).ok()?;
        if self.big {
            let n = usize::try_from(self.u64(b, at)?).ok()?;
            Some((n, at + 8, 20))
        } else {
            Some((usize::from(self.u16(b, at)?), at + 2, 12))
        }
    }

    /// The offsets of every IFD in the main chain, in order.
    pub(crate) fn ifds(&self, b: &[u8]) -> Vec<u64> {
        let mut out = Vec::new();
        let mut next = self.first_ifd;
        while next != 0 && out.len() < MAX_IFDS && !out.contains(&next) {
            let Some((n, first, size)) = self.entries(b, next) else {
                break;
            };
            out.push(next);
            let after = first + n * size;
            next = if self.big {
                self.u64(b, after).unwrap_or(0)
            } else {
                self.u32(b, after).map(u64::from).unwrap_or(0)
            };
        }
        out
    }

    /// The byte offset of the entry for `tag` in the IFD at `ifd`.
    pub(crate) fn entry(&self, b: &[u8], ifd: u64, tag: u16) -> Option<usize> {
        let (n, first, size) = self.entries(b, ifd)?;
        (0..n)
            .map(|i| first + i * size)
            .find(|&at| self.u16(b, at) == Some(tag))
    }

    /// The raw value bytes of `tag` in the IFD at `ifd`, as they are in
    /// the file (inline or at their offset).
    pub(crate) fn value<'b>(&self, b: &'b [u8], ifd: u64, tag: u16) -> Option<&'b [u8]> {
        let at = self.entry(b, ifd, tag)?;
        let width = match self.u16(b, at + 2)? {
            1 | 2 | 6 | 7 => 1,
            3 | 8 => 2,
            4 | 9 | 11 | 13 => 4,
            5 | 10 | 12 | 16 | 17 | 18 => 8,
            _ => return None,
        };
        let (count, field, inline) = if self.big {
            (self.u64(b, at + 4)?, at + 12, 8)
        } else {
            (u64::from(self.u32(b, at + 4)?), at + 8, 4)
        };
        let len = usize::try_from(count.checked_mul(width)?).ok()?;
        let start = if len <= inline {
            field
        } else if self.big {
            usize::try_from(self.u64(b, field)?).ok()?
        } else {
            usize::try_from(self.u32(b, field)?).ok()?
        };
        b.get(start..start.checked_add(len)?)
    }

    /// The values of a numeric entry as `f64`: BYTE, SHORT, LONG, LONG8
    /// and IFD offsets as integers, RATIONAL and SRATIONAL divided out,
    /// SBYTE, SSHORT, SLONG signed, FLOAT and DOUBLE as they are.
    pub(crate) fn numbers(&self, b: &[u8], ifd: u64, tag: u16) -> Option<Vec<f64>> {
        let at = self.entry(b, ifd, tag)?;
        let ty = self.u16(b, at + 2)?;
        let v = self.value(b, ifd, tag)?;
        let n = |w: usize| v.len() / w;
        Some(match ty {
            1 | 7 => v.iter().map(|x| f64::from(*x)).collect(),
            6 => v.iter().map(|x| f64::from(*x as i8)).collect(),
            3 => (0..n(2))
                .map(|i| f64::from(self.u16(v, i * 2).unwrap_or(0)))
                .collect(),
            8 => (0..n(2))
                .map(|i| f64::from(self.u16(v, i * 2).unwrap_or(0) as i16))
                .collect(),
            4 | 13 => (0..n(4))
                .map(|i| f64::from(self.u32(v, i * 4).unwrap_or(0)))
                .collect(),
            9 => (0..n(4))
                .map(|i| f64::from(self.u32(v, i * 4).unwrap_or(0) as i32))
                .collect(),
            16 | 18 => (0..n(8))
                .map(|i| self.u64(v, i * 8).unwrap_or(0) as f64)
                .collect(),
            5 | 10 => (0..n(8))
                .map(|i| {
                    let (num, den) = (
                        self.u32(v, i * 8).unwrap_or(0),
                        self.u32(v, i * 8 + 4).unwrap_or(0),
                    );
                    let (num, den) = if ty == 10 {
                        (f64::from(num as i32), f64::from(den as i32))
                    } else {
                        (f64::from(num), f64::from(den))
                    };
                    if den == 0.0 {
                        0.0
                    } else {
                        num / den
                    }
                })
                .collect(),
            11 => (0..n(4))
                .map(|i| f64::from(f32::from_bits(self.u32(v, i * 4).unwrap_or(0))))
                .collect(),
            12 => (0..n(8))
                .map(|i| f64::from_bits(self.u64(v, i * 8).unwrap_or(0)))
                .collect(),
            _ => return None,
        })
    }

    /// The file is little-endian.
    pub(crate) fn little_endian(&self) -> bool {
        self.le
    }

    /// The first value of a SHORT or LONG entry.
    pub(crate) fn short(&self, b: &[u8], ifd: u64, tag: u16) -> Option<u32> {
        let at = self.entry(b, ifd, tag)?;
        let ty = self.u16(b, at + 2)?;
        let value = self.value(b, ifd, tag)?;
        match ty {
            3 => self.u16(value, 0).map(u32::from),
            4 => self.u32(value, 0),
            _ => None,
        }
    }

    /// Overwrite the first value of the SHORT or LONG entry at `entry`.
    pub(crate) fn patch_short(&self, b: &mut [u8], entry: usize, value: u16) -> bool {
        let field = entry + if self.big { 12 } else { 8 };
        let Some(ty) = self.u16(b, entry + 2) else {
            return false;
        };
        let bytes: Vec<u8> = match (ty, self.le) {
            (3, true) => value.to_le_bytes().to_vec(),
            (3, false) => value.to_be_bytes().to_vec(),
            (4, true) => u32::from(value).to_le_bytes().to_vec(),
            (4, false) => u32::from(value).to_be_bytes().to_vec(),
            _ => return false,
        };
        match b.get_mut(field..field + bytes.len()) {
            Some(dst) => {
                dst.copy_from_slice(&bytes);
                true
            }
            None => false,
        }
    }
}
