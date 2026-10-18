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

//! The MicroType Express container (MTX §2): a ten-byte header, then three
//! LZCOMP blocks: the font's tables in Compact Table Format, the glyph
//! programs' push data, and the rest of their instructions.

use crate::{ctf, lzcomp, malformed, Limits, Result};

fn be24(b: &[u8]) -> usize {
    (b[0] as usize) << 16 | (b[1] as usize) << 8 | b[2] as usize
}

/// Decompress MicroType Express data into an OpenType file.
pub(crate) fn decompress(data: &[u8], limits: &Limits, notes: &mut Vec<String>) -> Result<Vec<u8>> {
    if data.len() < 10 {
        return malformed("MicroType Express header");
    }
    let version = data[0];
    if !(1..=3).contains(&version) {
        return Err(crate::Error::Unsupported(format!(
            "MicroType Express version {version}"
        )));
    }
    // data[1..4] is the copy limit the compressor used; decoding does not
    // need it. The two offsets count from the start of the data.
    let (offset2, offset3) = (be24(&data[4..7]), be24(&data[7..10]));
    if !(10 <= offset2 && offset2 <= offset3 && offset3 <= data.len()) {
        return malformed(format!(
            "MicroType Express block offsets {offset2}, {offset3} in {} bytes",
            data.len()
        ));
    }
    let max = limits.max_font_bytes;
    let block = |b: &[u8]| -> Result<Vec<u8>> {
        if b.is_empty() {
            Ok(Vec::new())
        } else {
            lzcomp::decompress(b, version, max)
        }
    };
    let tables = block(&data[10..offset2])?;
    let push = block(&data[offset2..offset3])?;
    let code = block(&data[offset3..])?;
    ctf::rebuild(&tables, &push, &code, limits, notes)
}
