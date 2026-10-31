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

//! File objects (PLRM 3.8): the program text, a decoded filter, a string
//! read as a file, and the `eexec` decryption view over another file.
//! Every file is read a byte at a time through [`PsFile::read`], so the
//! scanner, `readstring` and the filters see one position: a font's
//! `RD` reads its charstring bytes right after the token the scanner
//! stopped at.

use std::rc::Rc;

use crate::object::FileRef;

pub enum Source {
    /// Bytes in memory and the read position.
    Mem { data: Rc<[u8]>, pos: usize },
    /// The `eexec` view (Type 1 spec §7.2): bytes of `src`, hex or
    /// binary, decrypted with the running key `r`; the first four plain
    /// bytes are skipped.
    Eexec {
        src: FileRef,
        r: u16,
        hex: bool,
        skip: usize,
    },
    /// A decode filter over `input`, decoded when it is first read: by
    /// then the program has read the tokens after the `filter` call, and
    /// its source stands at the encoded data.
    Filter {
        name: String,
        params: paged_raster::filters::Params,
        input: FilterInput,
        decoded: Option<(Rc<[u8]>, usize)>,
    },
}

pub enum FilterInput {
    File(FileRef),
    Bytes(Vec<u8>),
}

pub struct PsFile {
    pub src: Source,
    pub closed: bool,
    peeked: Option<u8>,
}

/// The `eexec` key and the Type 1 constants c1, c2.
pub const EEXEC_KEY: u16 = 55665;
pub const C1: u16 = 52845;
pub const C2: u16 = 22719;

impl PsFile {
    pub fn mem(data: Rc<[u8]>) -> PsFile {
        PsFile {
            src: Source::Mem { data, pos: 0 },
            closed: false,
            peeked: None,
        }
    }

    pub fn from_vec(v: Vec<u8>) -> PsFile {
        PsFile::mem(Rc::from(v))
    }

    /// A decrypting view over `src`, its form (hex or binary) decided
    /// from the first four bytes after any whitespace (Type 1 spec §7.2).
    pub fn eexec(src: FileRef) -> PsFile {
        let hex = {
            let mut s = src.borrow_mut();
            while matches!(s.peek(), Some(b' ' | b'\t' | b'\r' | b'\n')) {
                s.read();
            }
            s.peek_n(4)
                .is_some_and(|b| b.len() == 4 && b.iter().all(u8::is_ascii_hexdigit))
        };
        PsFile {
            src: Source::Eexec {
                src,
                r: EEXEC_KEY,
                hex,
                skip: 4,
            },
            closed: false,
            peeked: None,
        }
    }

    pub fn filter(
        name: String,
        params: paged_raster::filters::Params,
        input: FilterInput,
    ) -> PsFile {
        PsFile {
            src: Source::Filter {
                name,
                params,
                input,
                decoded: None,
            },
            closed: false,
            peeked: None,
        }
    }

    /// Decode a filter now, if it has not been: its whole output, its
    /// source advanced past what that consumed. Data that does not
    /// decode reads as an empty file.
    fn decode_filter(&mut self) {
        let Source::Filter {
            name,
            params,
            input,
            decoded,
        } = &mut self.src
        else {
            return;
        };
        if decoded.is_some() {
            return;
        }
        let out = match input {
            FilterInput::Bytes(b) => paged_raster::filters::decode(name, b, params).map(|(d, _)| d),
            FilterInput::File(f) => {
                let rest = f.borrow_mut().rest();
                match rest {
                    Some(r) => paged_raster::filters::decode(name, &r, params).map(|(d, used)| {
                        f.borrow_mut().advance(used);
                        d
                    }),
                    None => {
                        let mut all = Vec::new();
                        let mut src = f.borrow_mut();
                        while let Some(b) = src.read() {
                            all.push(b);
                            if all.len() > params.max_output {
                                break;
                            }
                        }
                        paged_raster::filters::decode(name, &all, params).map(|(d, _)| d)
                    }
                }
            }
        };
        *decoded = Some((Rc::from(out.unwrap_or_default()), 0));
    }

    pub fn peek(&mut self) -> Option<u8> {
        if self.peeked.is_none() {
            self.peeked = self.read_raw();
        }
        self.peeked
    }

    pub fn read(&mut self) -> Option<u8> {
        if let Some(b) = self.peeked.take() {
            return Some(b);
        }
        self.read_raw()
    }

    /// Up to `n` bytes ahead without consuming them (memory files only;
    /// `None` otherwise).
    fn peek_n(&mut self, n: usize) -> Option<Vec<u8>> {
        if let Source::Mem { data, pos } = &self.src {
            let mut out: Vec<u8> = self.peeked.into_iter().collect();
            let rest = &data[(*pos).min(data.len())..];
            out.extend_from_slice(&rest[..rest.len().min(n - out.len().min(n))]);
            out.truncate(n);
            return Some(out);
        }
        None
    }

    fn read_raw(&mut self) -> Option<u8> {
        if self.closed {
            return None;
        }
        match &mut self.src {
            Source::Mem { data, pos } => {
                let b = data.get(*pos).copied();
                if b.is_some() {
                    *pos += 1;
                }
                b
            }
            Source::Eexec { src, r, hex, skip } => loop {
                let cipher = if *hex {
                    let mut s = src.borrow_mut();
                    let hi = loop {
                        let c = s.read()?;
                        if let Some(v) = hexval(c) {
                            break v;
                        }
                        if !c.is_ascii_whitespace() {
                            return None;
                        }
                    };
                    let lo = loop {
                        let c = s.read().unwrap_or(b'0');
                        if let Some(v) = hexval(c) {
                            break v;
                        }
                        if !c.is_ascii_whitespace() {
                            break 0;
                        }
                    };
                    (hi << 4) | lo
                } else {
                    src.borrow_mut().read()?
                };
                let plain = cipher ^ (*r >> 8) as u8;
                *r = (cipher as u16)
                    .wrapping_add(*r)
                    .wrapping_mul(C1)
                    .wrapping_add(C2);
                if *skip > 0 {
                    *skip -= 1;
                    continue;
                }
                return Some(plain);
            },
            Source::Filter { .. } => {
                self.decode_filter();
                let Source::Filter {
                    decoded: Some((d, pos)),
                    ..
                } = &mut self.src
                else {
                    return None;
                };
                let b = d.get(*pos).copied();
                if b.is_some() {
                    *pos += 1;
                }
                b
            }
        }
    }

    /// The unread rest of a memory file, for a filter to decode in one
    /// go; [`Self::advance`] then moves past what it consumed. `None` for
    /// a file that is not in memory.
    pub fn rest(&mut self) -> Option<Rc<[u8]>> {
        self.decode_filter();
        if let Source::Filter {
            decoded: Some((data, pos)),
            ..
        } = &mut self.src
        {
            if self.peeked.take().is_some() {
                *pos -= 1;
            }
            if self.closed {
                return Some(Rc::from(Vec::new()));
            }
            return Some(Rc::from(&data[(*pos).min(data.len())..]));
        }
        // A peeked byte goes back to the buffer: memory files only peek
        // one byte at a position they can step back from.
        if let Source::Mem { data, pos } = &mut self.src {
            if self.peeked.take().is_some() {
                *pos -= 1;
            }
            if self.closed {
                return Some(Rc::from(Vec::new()));
            }
            let start = (*pos).min(data.len());
            return Some(Rc::from(&data[start..]));
        }
        None
    }

    pub fn advance(&mut self, n: usize) {
        match &mut self.src {
            Source::Mem { data, pos }
            | Source::Filter {
                decoded: Some((data, pos)),
                ..
            } => *pos = (*pos + n).min(data.len()),
            _ => {}
        }
    }

    pub fn bytes_available(&self) -> i32 {
        match &self.src {
            Source::Mem { data, pos } if !self.closed => {
                (data.len().saturating_sub(*pos) + self.peeked.is_some() as usize) as i32
            }
            _ => -1,
        }
    }

    pub fn position(&self) -> Option<usize> {
        match &self.src {
            Source::Mem { pos, .. } => Some(pos - self.peeked.is_some() as usize),
            _ => None,
        }
    }

    pub fn set_position(&mut self, p: usize) -> bool {
        match &mut self.src {
            Source::Mem { data, pos } if p <= data.len() => {
                *pos = p;
                self.peeked = None;
                true
            }
            _ => false,
        }
    }

    pub fn close(&mut self) {
        self.closed = true;
        self.peeked = None;
    }
}

pub fn hexval(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

/// Type 1 charstring / eexec decryption of a whole buffer with key `r`,
/// dropping the first `skip` bytes (lenIV).
pub fn decrypt(data: &[u8], mut r: u16, skip: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len());
    for &c in data {
        out.push(c ^ (r >> 8) as u8);
        r = (c as u16).wrapping_add(r).wrapping_mul(C1).wrapping_add(C2);
    }
    if skip >= out.len() {
        Vec::new()
    } else {
        out.split_off(skip)
    }
}

/// The inverse of [`decrypt`], for tests that build an encrypted font.
pub fn encrypt(plain: &[u8], mut r: u16) -> Vec<u8> {
    let mut out = Vec::with_capacity(plain.len());
    for &p in plain {
        let c = p ^ (r >> 8) as u8;
        r = (c as u16).wrapping_add(r).wrapping_mul(C1).wrapping_add(C2);
        out.push(c);
    }
    out
}
