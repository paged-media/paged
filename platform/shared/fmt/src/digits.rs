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

//! Digit grouping: a separator between every three digits of an integer
//! part, counted from the right (`1234567` → `1,234,567`).

/// Append `digits` to `out` with `sep` before every group of three, counted
/// from the right.
///
/// `min_grouping` is CLDR's `minimumGroupingDigits`: nothing is grouped
/// unless there are at least `3 + min_grouping` digits. `1`, the rule of most
/// locales and of Excel, groups from four digits on (`1,234`); Spanish CLDR
/// data has `2`, which leaves `1234` alone and groups `12.345`. `0` counts as
/// `1`. `digits` is the integer part only: no sign, no decimal separator.
pub fn push_grouped(out: &mut String, digits: &str, sep: &str, min_grouping: usize) {
    let n = digits.chars().count();
    if n < 3 + min_grouping.max(1) {
        out.push_str(digits);
        return;
    }
    out.reserve(digits.len() + (n - 1) / 3 * sep.len());
    for (i, ch) in digits.chars().enumerate() {
        if i > 0 && (n - i).is_multiple_of(3) {
            out.push_str(sep);
        }
        out.push(ch);
    }
}

/// [`push_grouped`] into a new string.
pub fn grouped(digits: &str, sep: &str, min_grouping: usize) -> String {
    let mut out = String::new();
    push_grouped(&mut out, digits, sep, min_grouping);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn groups_of_three_from_the_right() {
        assert_eq!(grouped("", ",", 1), "");
        assert_eq!(grouped("1", ",", 1), "1");
        assert_eq!(grouped("123", ",", 1), "123");
        assert_eq!(grouped("1234", ",", 1), "1,234");
        assert_eq!(grouped("123456", ",", 1), "123,456");
        assert_eq!(grouped("1234567", ".", 1), "1.234.567");
        assert_eq!(grouped("1234567", "\u{202f}", 1), "1\u{202f}234\u{202f}567");
        assert_eq!(grouped("1234", ",", 0), "1,234");
    }

    #[test]
    fn minimum_grouping_digits() {
        assert_eq!(grouped("1234", ".", 2), "1234");
        assert_eq!(grouped("12345", ".", 2), "12.345");
        assert_eq!(grouped("1234567", ".", 2), "1.234.567");
    }

    #[test]
    fn appends() {
        let mut s = String::from("-");
        push_grouped(&mut s, "1000", "'", 1);
        assert_eq!(s, "-1'000");
    }
}
