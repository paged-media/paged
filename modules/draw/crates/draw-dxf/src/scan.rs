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

//! The entity types an ASCII DXF's `ENTITIES` section lists, counted
//! from its group codes — so a type the `dxf` crate skips while reading
//! (it models no `HATCH`, for one) is still reported, never dropped
//! silently. A binary DXF is not scanned.

/// `(type, count)` in order of first appearance.
pub fn entity_counts(bytes: &[u8]) -> Vec<(String, u32)> {
    let mut out: Vec<(String, u32)> = Vec::new();
    if bytes.starts_with(b"AutoCAD Binary DXF") {
        return out;
    }
    let text = String::from_utf8_lossy(bytes);
    let mut lines = text.lines().map(str::trim);
    let mut in_entities = false;
    let mut expect_section_name = false;
    while let (Some(code), Some(value)) = (lines.next(), lines.next()) {
        if code != "0" && code != "2" {
            continue;
        }
        if code == "2" {
            if expect_section_name {
                in_entities = value == "ENTITIES";
                expect_section_name = false;
            }
            continue;
        }
        expect_section_name = value == "SECTION";
        if value == "ENDSEC" {
            in_entities = false;
            continue;
        }
        if in_entities && !expect_section_name {
            match out.iter_mut().find(|(n, _)| n == value) {
                Some((_, n)) => *n += 1,
                None => out.push((value.to_string(), 1)),
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_entities_section_is_counted_by_type() {
        let dxf = "0\nSECTION\n2\nBLOCKS\n0\nCIRCLE\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n0\nHATCH\n8\n0\n0\nLINE\n0\nHATCH\n0\nENDSEC\n0\nEOF\n";
        assert_eq!(
            entity_counts(dxf.as_bytes()),
            vec![("HATCH".to_string(), 2), ("LINE".to_string(), 1)]
        );
    }
}
