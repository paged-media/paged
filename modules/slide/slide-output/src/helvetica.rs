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

//! Helvetica, one of the PDF standard fonts every reader has: the
//! WinAnsiEncoding byte of a character and its advance, for breaking notes
//! text into lines. The advances of printable ASCII are the font's metrics
//! (1/1000 em); a Latin-1 letter takes its base letter's advance, which is
//! what Helvetica's accented letters have.

/// Advances of U+0020…U+007E.
const ASCII: [u16; 95] = [
    278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278,
    278, // ' '…'/'
    556, 556, 556, 556, 556, 556, 556, 556, 556, 556, // 0…9
    278, 278, 584, 584, 584, 556, 1015, // : ; < = > ? @
    667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, // A…M
    722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, // N…Z
    278, 278, 278, 469, 556, 333, // [ \ ] ^ _ `
    556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, // a…m
    556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, // n…z
    334, 260, 334, 584, // { | } ~
];

/// The characters WinAnsiEncoding puts at 0x80…0x9F (cp1252); `\0` where
/// it has none.
const CP1252_HIGH: [char; 32] = [
    '€', '\0', '‚', 'ƒ', '„', '…', '†', '‡', 'ˆ', '‰', 'Š', '‹', 'Œ', '\0', 'Ž', '\0', '\0', '‘',
    '’', '“', '”', '•', '–', '—', '˜', '™', 'š', '›', 'œ', '\0', 'ž', 'Ÿ',
];

/// `c` in WinAnsiEncoding, or None when the encoding has no such character.
pub fn win_ansi(c: char) -> Option<u8> {
    let u = c as u32;
    if (0x20..0x7f).contains(&u) || (0xa0..=0xff).contains(&u) {
        return Some(u as u8);
    }
    CP1252_HIGH
        .iter()
        .position(|&h| h == c && h != '\0')
        .map(|i| 0x80 + i as u8)
}

/// The ASCII letter a Latin-1 letter is drawn on (its advance).
fn base(c: char) -> char {
    match c {
        'À'..='Å' => 'A',
        'Æ' => 'W', // 1000 in the font; W is the nearest wide capital
        'Ç' => 'C',
        'È'..='Ë' => 'E',
        'Ì'..='Ï' => 'I',
        'Ð' => 'D',
        'Ñ' => 'N',
        'Ò'..='Ö' | 'Ø' => 'O',
        'Ù'..='Ü' => 'U',
        'Ý' => 'Y',
        'Þ' => 'P',
        'ß' => 'b',
        'à'..='å' => 'a',
        'æ' => 'm',
        'ç' => 'c',
        'è'..='ë' => 'e',
        'ì'..='ï' => 'i',
        'ð' | 'ò'..='ö' | 'ø' => 'o',
        'ñ' => 'n',
        'ù'..='ü' => 'u',
        'ý' | 'ÿ' => 'y',
        'þ' => 'p',
        'Š' => 'S',
        'š' => 's',
        'Ž' => 'Z',
        'ž' => 'z',
        'Ÿ' => 'Y',
        'Œ' => 'W',
        'œ' => 'm',
        '–' | '€' | '•' | '†' | '‡' => '0',
        '—' | '…' | '‰' | '™' => 'M',
        '‘' | '’' | '‚' | '‹' | '›' => '\'',
        '“' | '”' | '„' => '"',
        _ => '0',
    }
}

/// The advance of `c` at 1 pt, as drawn (a character the encoding lacks is
/// drawn as `?`).
pub fn advance(c: char) -> f64 {
    let c = if win_ansi(c).is_some() { c } else { '?' };
    let a = if (' '..='~').contains(&c) { c } else { base(c) };
    ASCII[(a as usize) - 0x20] as f64 / 1000.0
}

/// The width of `s` at `size` pt.
pub fn width(s: &str, size: f64) -> f64 {
    s.chars().map(advance).sum::<f64>() * size
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encoding_and_advances() {
        assert_eq!(win_ansi('A'), Some(0x41));
        assert_eq!(win_ansi('ä'), Some(0xe4));
        assert_eq!(win_ansi('€'), Some(0x80));
        assert_eq!(win_ansi('—'), Some(0x97));
        assert_eq!(win_ansi('Ω'), None);
        assert!((advance(' ') - 0.278).abs() < 1e-9);
        assert!((advance('W') - 0.944).abs() < 1e-9);
        assert!((advance('ü') - advance('u')).abs() < 1e-9);
        assert!((width("Hi", 10.0) - (7.22 + 2.22)).abs() < 1e-9);
    }
}
