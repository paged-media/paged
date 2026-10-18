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

//! A reader of single bits, most significant bit of each byte first (the
//! order LZCOMP's bit stream uses).

use crate::{Error, Result};

pub(crate) struct BitReader<'a> {
    data: &'a [u8],
    next: usize,
    byte: u8,
    left: u8,
}

impl<'a> BitReader<'a> {
    pub(crate) fn new(data: &'a [u8]) -> Self {
        BitReader {
            data,
            next: 0,
            byte: 0,
            left: 0,
        }
    }

    /// The next bit; running past the end of the data is an error.
    pub(crate) fn bit(&mut self) -> Result<bool> {
        if self.left == 0 {
            self.byte = *self
                .data
                .get(self.next)
                .ok_or(Error::Truncated("LZCOMP bit stream"))?;
            self.next += 1;
            self.left = 8;
        }
        self.left -= 1;
        Ok((self.byte >> self.left) & 1 == 1)
    }

    /// The next `n` (at most 32) bits as a number, first bit highest.
    pub(crate) fn bits(&mut self, n: u32) -> Result<u32> {
        debug_assert!(n <= 32);
        let mut v = 0u32;
        for _ in 0..n {
            v = (v << 1) | u32::from(self.bit()?);
        }
        Ok(v)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bits_come_most_significant_first() {
        let mut r = BitReader::new(&[0b1010_0000, 0xFF]);
        assert!(r.bit().unwrap());
        assert!(!r.bit().unwrap());
        assert_eq!(r.bits(6).unwrap(), 0b10_0000);
        assert_eq!(r.bits(8).unwrap(), 0xFF);
        assert!(r.bit().is_err());
    }
}
