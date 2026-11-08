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

//! The Mathematical Alphanumeric Symbols (Unicode U+1D400 block) a run's
//! [`Variant`] asks for (engine ADR 1090).
//!
//! Office Math sets an ordinary Latin letter italic by writing it as the
//! math-italic code point, not by choosing an italic face: a math font holds
//! the styled letters as their own characters. [`styled`] maps a character
//! to the one its variant names; digits and operators keep theirs, and so
//! does a letter the block has no place for. The few letters that were in
//! Unicode before the block (ℎ, ℬ, ℭ, …) are the holes the block leaves
//! for them.

use crate::model::Variant;

/// `c` in the alphabet `variant` names, or `c` itself.
pub fn styled(c: char, variant: Variant) -> char {
    let upper = c.is_ascii_uppercase();
    let lower = c.is_ascii_lowercase();
    let digit = c.is_ascii_digit();
    let greek_lower = ('\u{03b1}'..='\u{03c9}').contains(&c);
    let at = |base: u32, k: u32| char::from_u32(base + k).unwrap_or(c);
    let letter = |cap: u32, small: u32| {
        if upper {
            Some(at(cap, c as u32 - 'A' as u32))
        } else if lower {
            Some(at(small, c as u32 - 'a' as u32))
        } else {
            None
        }
    };
    let digit_in = |base: u32| digit.then(|| at(base, c as u32 - '0' as u32));
    let mapped = match variant {
        Variant::Plain => None,
        Variant::Italic => match c {
            'h' => Some('\u{210e}'),
            _ if greek_lower => Some(at(0x1d6fc, c as u32 - 0x03b1)),
            _ => letter(0x1d434, 0x1d44e),
        },
        Variant::Bold => letter(0x1d400, 0x1d41a).or_else(|| digit_in(0x1d7ce)),
        Variant::BoldItalic => match c {
            _ if greek_lower => Some(at(0x1d736, c as u32 - 0x03b1)),
            _ => letter(0x1d468, 0x1d482),
        },
        Variant::Script => match c {
            'B' => Some('\u{212c}'),
            'E' => Some('\u{2130}'),
            'F' => Some('\u{2131}'),
            'H' => Some('\u{210b}'),
            'I' => Some('\u{2110}'),
            'L' => Some('\u{2112}'),
            'M' => Some('\u{2133}'),
            'R' => Some('\u{211b}'),
            'e' => Some('\u{212f}'),
            'g' => Some('\u{210a}'),
            'o' => Some('\u{2134}'),
            _ => letter(0x1d49c, 0x1d4b6),
        },
        Variant::Fraktur => match c {
            'C' => Some('\u{212d}'),
            'H' => Some('\u{210c}'),
            'I' => Some('\u{2111}'),
            'R' => Some('\u{211c}'),
            'Z' => Some('\u{2128}'),
            _ => letter(0x1d504, 0x1d51e),
        },
        Variant::DoubleStruck => match c {
            'C' => Some('\u{2102}'),
            'H' => Some('\u{210d}'),
            'N' => Some('\u{2115}'),
            'P' => Some('\u{2119}'),
            'Q' => Some('\u{211a}'),
            'R' => Some('\u{211d}'),
            'Z' => Some('\u{2124}'),
            _ => letter(0x1d538, 0x1d552).or_else(|| digit_in(0x1d7d8)),
        },
        Variant::SansSerif => letter(0x1d5a0, 0x1d5ba).or_else(|| digit_in(0x1d7e2)),
        Variant::Monospace => letter(0x1d670, 0x1d68a).or_else(|| digit_in(0x1d7f6)),
    };
    mapped.unwrap_or(c)
}

/// Whether the variant slants a letter: the renderer leans the plain letter
/// when the face has no math-italic one.
pub fn slants(variant: Variant) -> bool {
    matches!(variant, Variant::Italic | Variant::BoldItalic)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn italic_latin_and_the_planck_hole() {
        assert_eq!(styled('a', Variant::Italic), '\u{1d44e}');
        assert_eq!(styled('x', Variant::Italic), '\u{1d465}');
        assert_eq!(styled('A', Variant::Italic), '\u{1d434}');
        assert_eq!(styled('h', Variant::Italic), '\u{210e}');
        assert_eq!(styled('\u{03b1}', Variant::Italic), '\u{1d6fc}');
    }

    #[test]
    fn digits_and_operators_stay() {
        for v in [Variant::Italic, Variant::Plain, Variant::Script] {
            assert_eq!(styled('2', v), '2');
            assert_eq!(styled('+', v), '+');
        }
        assert_eq!(styled('2', Variant::Bold), '\u{1d7d0}');
        assert_eq!(styled('x', Variant::Plain), 'x');
    }

    #[test]
    fn the_alphabets_holes() {
        assert_eq!(styled('R', Variant::DoubleStruck), '\u{211d}');
        assert_eq!(styled('A', Variant::DoubleStruck), '\u{1d538}');
        assert_eq!(styled('L', Variant::Script), '\u{2112}');
        assert_eq!(styled('A', Variant::Script), '\u{1d49c}');
        assert_eq!(styled('Z', Variant::Fraktur), '\u{2128}');
        assert_eq!(styled('z', Variant::Monospace), '\u{1d6a3}');
    }
}
