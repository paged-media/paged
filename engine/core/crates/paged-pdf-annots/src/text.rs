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

//! PDF text strings, dates and rich text, as an annotation carries them.

/// PDFDocEncoding's code points above Latin-1's (ISO 32000-1 annex D).
fn pdf_doc(b: u8) -> char {
    match b {
        0x18 => '\u{02D8}',
        0x19 => '\u{02C7}',
        0x1A => '\u{02C6}',
        0x1B => '\u{02D9}',
        0x1C => '\u{02DD}',
        0x1D => '\u{02DB}',
        0x1E => '\u{02DA}',
        0x1F => '\u{02DC}',
        0x80 => '\u{2022}',
        0x81 => '\u{2020}',
        0x82 => '\u{2021}',
        0x83 => '\u{2026}',
        0x84 => '\u{2014}',
        0x85 => '\u{2013}',
        0x86 => '\u{0192}',
        0x87 => '\u{2044}',
        0x88 => '\u{2039}',
        0x89 => '\u{203A}',
        0x8A => '\u{2212}',
        0x8B => '\u{2030}',
        0x8C => '\u{201E}',
        0x8D => '\u{201C}',
        0x8E => '\u{201D}',
        0x8F => '\u{2018}',
        0x90 => '\u{2019}',
        0x91 => '\u{201A}',
        0x92 => '\u{2122}',
        0x93 => '\u{FB01}',
        0x94 => '\u{FB02}',
        0x95 => '\u{0141}',
        0x96 => '\u{0152}',
        0x97 => '\u{0160}',
        0x98 => '\u{0178}',
        0x99 => '\u{017D}',
        0x9A => '\u{0131}',
        0x9B => '\u{0142}',
        0x9C => '\u{0153}',
        0x9D => '\u{0161}',
        0x9E => '\u{017E}',
        0xA0 => '\u{20AC}',
        other => other as char,
    }
}

/// A PDF text string as Rust text: UTF-16BE or UTF-8 with a byte-order mark,
/// else PDFDocEncoding. Line breaks (Acrobat writes a lone `\r`) become `\n`.
pub(crate) fn decode_text(bytes: &[u8]) -> String {
    let raw = if let Some(rest) = bytes.strip_prefix(&[0xFE, 0xFF]) {
        let units: Vec<u16> = rest
            .as_chunks::<2>()
            .0
            .iter()
            .map(|c| u16::from_be_bytes(*c))
            .collect();
        String::from_utf16_lossy(&units)
    } else if let Some(rest) = bytes.strip_prefix(&[0xFF, 0xFE]) {
        // Not in the standard; some writers emit it.
        let units: Vec<u16> = rest
            .as_chunks::<2>()
            .0
            .iter()
            .map(|c| u16::from_le_bytes(*c))
            .collect();
        String::from_utf16_lossy(&units)
    } else if let Some(rest) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        String::from_utf8_lossy(rest).into_owned()
    } else {
        bytes.iter().map(|&b| pdf_doc(b)).collect()
    };
    raw.replace("\r\n", "\n").replace('\r', "\n")
}

/// A PDF date (`D:YYYYMMDDHHmmSSOHH'mm'`, every part after the year optional)
/// as ISO 8601 with the zone the file gave: `Z`, or `+HH:MM` / `-HH:MM`. A
/// date with no zone stays without one (the PDF says it is unknown).
pub(crate) fn iso_date(raw: &str) -> Option<String> {
    let s = raw.trim().strip_prefix("D:").unwrap_or(raw.trim());
    let b = s.as_bytes();
    let num = |at: usize, len: usize| -> Option<u32> {
        let part = b.get(at..at + len)?;
        if !part.iter().all(u8::is_ascii_digit) {
            return None;
        }
        std::str::from_utf8(part).ok()?.parse().ok()
    };
    let year = num(0, 4)?;
    let month = num(4, 2).unwrap_or(1).clamp(1, 12);
    let day = num(6, 2).unwrap_or(1).clamp(1, 31);
    let hour = num(8, 2).unwrap_or(0).min(23);
    let minute = num(10, 2).unwrap_or(0).min(59);
    let second = num(12, 2).unwrap_or(0).min(59);
    let zone = match b.get(14) {
        Some(b'Z') | Some(b'z') => "Z".to_string(),
        Some(sign @ (b'+' | b'-')) => {
            let hh = num(15, 2).unwrap_or(0).min(23);
            // `HH'mm'` or the lenient `HHmm`.
            let mm_at = if b.get(17) == Some(&b'\'') { 18 } else { 17 };
            let mm = num(mm_at, 2).unwrap_or(0).min(59);
            if hh == 0 && mm == 0 {
                "Z".to_string()
            } else {
                format!("{}{hh:02}:{mm:02}", *sign as char)
            }
        }
        _ => String::new(),
    };
    Some(format!(
        "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}{zone}"
    ))
}

/// A sortable instant (seconds, UTC) of an [`iso_date`] result; used only to
/// order replies.
pub(crate) fn sort_key(iso: &str) -> Option<i64> {
    let n = |a: usize, l: usize| -> Option<i64> { iso.get(a..a + l)?.parse().ok() };
    let (y, mo, d, h, mi, s) = (
        n(0, 4)?,
        n(5, 2)?,
        n(8, 2)?,
        n(11, 2)?,
        n(14, 2)?,
        n(17, 2)?,
    );
    // Days from civil (Howard Hinnant).
    let y2 = if mo <= 2 { y - 1 } else { y };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let doy = (153 * (if mo > 2 { mo - 3 } else { mo + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let mut t = days * 86_400 + h * 3600 + mi * 60 + s;
    if let Some(zone) = iso.get(19..) {
        if let (Some(sign), Some(zh), Some(zm)) = (
            zone.chars().next().filter(|c| matches!(c, '+' | '-')),
            zone.get(1..3).and_then(|v| v.parse::<i64>().ok()),
            zone.get(4..6).and_then(|v| v.parse::<i64>().ok()),
        ) {
            let off = zh * 3600 + zm * 60;
            t -= if sign == '+' { off } else { -off };
        }
    }
    Some(t)
}

/// The plain text of a rich-text string (`/RC`, the XHTML subset of
/// ISO 32000-1 12.7.3.4): tags dropped, a paragraph or break ends a line,
/// the five XML entities and numeric references decoded.
pub(crate) fn strip_rich_text(rc: &str) -> String {
    let mut out = String::new();
    let mut rest = rc;
    while let Some(lt) = rest.find('<') {
        push_decoded(&mut out, &rest[..lt]);
        let after = &rest[lt + 1..];
        let Some(gt) = after.find('>') else {
            rest = "";
            break;
        };
        let tag = after[..gt].trim();
        let name = tag
            .trim_start_matches('/')
            .split(|c: char| c.is_whitespace() || c == '/')
            .next()
            .unwrap_or("")
            .to_ascii_lowercase();
        let closing = tag.starts_with('/');
        if (name == "br" || (name == "p" && closing)) && !out.is_empty() && !out.ends_with('\n') {
            out.push('\n');
        }
        rest = &after[gt + 1..];
    }
    push_decoded(&mut out, rest);
    out.trim_end_matches('\n').to_string()
}

fn push_decoded(out: &mut String, text: &str) {
    let mut rest = text;
    while let Some(amp) = rest.find('&') {
        out.push_str(&rest[..amp]);
        let after = &rest[amp + 1..];
        let decoded = after.find(';').filter(|&e| e <= 8).and_then(|semi| {
            let ch = match &after[..semi] {
                "lt" => '<',
                "gt" => '>',
                "amp" => '&',
                "quot" => '"',
                "apos" => '\'',
                n if n.starts_with("#x") || n.starts_with("#X") => {
                    char::from_u32(u32::from_str_radix(&n[2..], 16).ok()?)?
                }
                n if n.starts_with('#') => char::from_u32(n[1..].parse().ok()?)?,
                _ => return None,
            };
            Some((ch, semi))
        });
        match decoded {
            Some((ch, semi)) => {
                out.push(ch);
                rest = &after[semi + 1..];
            }
            None => {
                out.push('&');
                rest = after;
            }
        }
    }
    out.push_str(rest);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_strings_decode_in_all_three_encodings() {
        assert_eq!(decode_text(b"\xFE\xFF\x00H\x00\xe9\x20\x2c"), "Hé\u{202c}");
        assert_eq!(decode_text(b"\xEF\xBB\xBFcaf\xC3\xA9"), "café");
        assert_eq!(decode_text(b"a\x80b\xe9\r\nc\rd"), "a\u{2022}bé\nc\nd");
    }

    #[test]
    fn dates_keep_their_zone_and_order_by_instant() {
        assert_eq!(
            iso_date("D:20261101103000+01'00'").as_deref(),
            Some("2026-11-01T10:30:00+01:00")
        );
        assert_eq!(
            iso_date("D:20261101103000Z").as_deref(),
            Some("2026-11-01T10:30:00Z")
        );
        assert_eq!(
            iso_date("D:20261101103000-05'30'").as_deref(),
            Some("2026-11-01T10:30:00-05:30")
        );
        assert_eq!(iso_date("D:2026").as_deref(), Some("2026-01-01T00:00:00"));
        assert_eq!(iso_date("garbage"), None);
        let a = sort_key("2026-11-01T10:30:00+01:00").unwrap();
        let b = sort_key("2026-11-01T09:30:00Z").unwrap();
        assert_eq!(a, b);
        assert!(sort_key("2026-11-01T09:30:01Z").unwrap() > b);
    }

    #[test]
    fn rich_text_reduces_to_plain_lines() {
        let rc = r#"<?xml version="1.0"?><body xmlns="http://www.w3.org/1999/xhtml"><p dir="ltr"><span style="font-size:12pt">A &amp; B &lt;1&gt; &#233;</span></p><p>Second</p></body>"#;
        assert_eq!(strip_rich_text(rc), "A & B <1> \u{e9}\nSecond");
    }
}
