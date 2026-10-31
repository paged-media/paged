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

//! Document Structuring Conventions (DSC 3.0) and the EPS file forms
//! (EPSF 3.0): the PostScript section of a DOS-binary EPS, the bounding
//! boxes, and the binary sections a comment reader steps over.

/// The four magic bytes of a DOS-binary EPS header (EPSF 3.0 §5.2).
pub const DOS_MAGIC: [u8; 4] = [0xC5, 0xD0, 0xD3, 0xC6];

/// True for bytes that open as PostScript: `%!PS`, or the DOS-binary
/// EPS header around it.
pub fn is_postscript(bytes: &[u8]) -> bool {
    postscript_section(bytes).is_some()
}

/// The PostScript program of an EPS: the bytes after a DOS-binary header
/// (its offset and length fields), or the whole file when it starts with
/// `%!`.
pub fn postscript_section(bytes: &[u8]) -> Option<&[u8]> {
    if bytes.starts_with(&DOS_MAGIC) {
        let field = |i: usize| -> Option<usize> {
            Some(u32::from_le_bytes(bytes.get(i..i + 4)?.try_into().ok()?) as usize)
        };
        let (off, len) = (field(4)?, field(8)?);
        let section = bytes.get(off..off.checked_add(len)?)?;
        return section.starts_with(b"%!").then_some(section);
    }
    // A UTF-8 byte-order mark or a stray ^D before the header is skipped.
    let start = bytes.iter().take(8).position(|&b| b == b'%').filter(|&i| {
        bytes[..i]
            .iter()
            .all(|&b| matches!(b, 4 | 0xEF | 0xBB | 0xBF))
    })?;
    let body = &bytes[start..];
    body.starts_with(b"%!PS").then_some(body)
}

/// The DSC comments the interpreter uses.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Dsc {
    pub bbox: Option<[f64; 4]>,
    pub hires_bbox: Option<[f64; 4]>,
    /// The header says `EPSF-x.y`.
    pub eps: bool,
}

impl Dsc {
    /// The box the art is placed by: the high-resolution one when given.
    pub fn best_bbox(&self) -> Option<[f64; 4]> {
        self.hires_bbox.or(self.bbox)
    }
}

/// Read the header comments of `ps` (and, for a box given `(atend)`, the
/// trailer's), stepping over `%%BeginBinary`/`%%BeginData` sections.
pub fn parse(ps: &[u8]) -> Dsc {
    let mut dsc = Dsc::default();
    let first = ps
        .split(|&b| b == b'\n' || b == b'\r')
        .next()
        .unwrap_or(&[]);
    dsc.eps = first.windows(5).any(|w| w == b"EPSF-");
    let mut i = 0;
    let mut in_header = true;
    let mut atend = (false, false);
    while i < ps.len() {
        let end = ps[i..]
            .iter()
            .position(|&b| b == b'\n' || b == b'\r')
            .map_or(ps.len(), |p| i + p);
        let line = &ps[i..end];
        i = end + 1;
        if i < ps.len() && ps[end] == b'\r' && ps[i] == b'\n' {
            i += 1;
        }
        let text = String::from_utf8_lossy(line);
        let text = text.trim_end();
        if let Some(rest) = text.strip_prefix("%%BeginBinary:") {
            let n: usize = rest.trim().parse().unwrap_or(0);
            i = (i + n).min(ps.len());
            continue;
        }
        if let Some(rest) = text.strip_prefix("%%BeginData:") {
            let mut f = rest.split_whitespace();
            let n: usize = f.next().and_then(|v| v.parse().ok()).unwrap_or(0);
            let unit = f.nth(1).unwrap_or("Bytes");
            if unit.eq_ignore_ascii_case("Lines") {
                for _ in 0..n {
                    match ps[i.min(ps.len())..].iter().position(|&b| b == b'\n') {
                        Some(p) => i += p + 1,
                        None => i = ps.len(),
                    }
                }
            } else {
                i = (i + n).min(ps.len());
            }
            continue;
        }
        if in_header && (text == "%%EndComments" || !text.starts_with('%')) && !text.is_empty() {
            in_header = false;
            if !atend.0 && !atend.1 {
                break;
            }
        }
        let header_or_trailer = in_header || atend.0 || atend.1;
        if !header_or_trailer {
            continue;
        }
        if let Some(rest) = text.strip_prefix("%%BoundingBox:") {
            if rest.trim() == "(atend)" {
                atend.0 = true;
            } else if let Some(b) = four(rest) {
                if in_header || atend.0 {
                    dsc.bbox = Some(b);
                }
            }
        } else if let Some(rest) = text.strip_prefix("%%HiResBoundingBox:") {
            if rest.trim() == "(atend)" {
                atend.1 = true;
            } else if let Some(b) = four(rest) {
                if in_header || atend.1 {
                    dsc.hires_bbox = Some(b);
                }
            }
        }
    }
    dsc
}

fn four(s: &str) -> Option<[f64; 4]> {
    let v: Vec<f64> = s
        .split_whitespace()
        .map(|t| t.parse::<f64>())
        .collect::<Result<_, _>>()
        .ok()?;
    let b: [f64; 4] = v.try_into().ok()?;
    (b[2] > b[0] && b[3] > b[1] && b.iter().all(|v| v.is_finite())).then_some(b)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn header_boxes_are_read() {
        let d = parse(
            b"%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 100 50\n%%HiResBoundingBox: 0 0 99.5 49.25\n%%EndComments\n0 0 moveto\n",
        );
        assert!(d.eps);
        assert_eq!(d.bbox, Some([0.0, 0.0, 100.0, 50.0]));
        assert_eq!(d.best_bbox(), Some([0.0, 0.0, 99.5, 49.25]));
    }

    #[test]
    fn an_atend_box_is_read_from_the_trailer_past_binary_data() {
        let mut ps = b"%!PS-Adobe-3.0 EPSF-3.0\r\n%%BoundingBox: (atend)\r\n%%EndComments\r\n%%BeginBinary: 20\r\n".to_vec();
        ps.extend_from_slice(b"%%BoundingBox: 9 9 \n");
        ps.extend_from_slice(b"\r\n%%EndBinary\r\n%%Trailer\r\n%%BoundingBox: 1 2 30 40\r\n");
        assert_eq!(parse(&ps).bbox, Some([1.0, 2.0, 30.0, 40.0]));
    }

    #[test]
    fn the_dos_binary_header_points_at_the_postscript() {
        let ps = b"%!PS-Adobe-3.0 EPSF-3.0\n";
        let mut f = DOS_MAGIC.to_vec();
        f.extend_from_slice(&30u32.to_le_bytes());
        f.extend_from_slice(&(ps.len() as u32).to_le_bytes());
        f.extend_from_slice(&[0; 18]);
        f.extend_from_slice(ps);
        assert_eq!(postscript_section(&f), Some(&ps[..]));
        assert!(postscript_section(b"\x89PNG").is_none());
        assert!(is_postscript(b"%!PS-Adobe-2.0\n"));
        f[8] = 0xFF;
        assert!(postscript_section(&f).is_none());
    }
}
