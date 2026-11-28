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

//! Case-insensitive text, the one way the engine does it.
//!
//! Excel compares text without regard to case by mapping each character to
//! its counterpart of the other case, one character for one: `"Ä" = "ä"` and
//! `"Σ" = "σ" = "ς"`, but `"ß" <> "SS"`, since no single character is the
//! capital of `ß` under that mapping. This module is that simple (one-to-one)
//! mapping. Everything that matches text or names case-insensitively goes
//! through it: the comparison operators, criteria and lookups, sorting and
//! filtering, and sheet, table, column and defined-name lookup.
//!
//! The order of [`cmp`] is the code-point order of the folded text. It is not
//! a locale collation.

use std::cmp::Ordering;

/// The case-folded form of one character: its one-character capital mapped
/// back to lower case. A character whose capital is several characters
/// (`ß` → `SS`) has no one-character capital and stays itself.
#[inline]
pub fn fold_char(c: char) -> char {
    if c.is_ascii() {
        return c.to_ascii_lowercase();
    }
    let upper = single(c.to_uppercase()).unwrap_or(c);
    single(upper.to_lowercase()).unwrap_or(upper)
}

/// The one character of a case mapping, or `None` when it maps to several.
fn single(mut mapped: impl Iterator<Item = char>) -> Option<char> {
    let first = mapped.next()?;
    mapped.next().is_none().then_some(first)
}

/// The folded characters of `s`.
pub fn chars(s: &str) -> impl Iterator<Item = char> + Clone + '_ {
    s.chars().map(fold_char)
}

/// `s` folded: a key under which two texts are equal exactly when [`eq`]
/// says so (for a map or a set).
pub fn key(s: &str) -> String {
    if s.is_ascii() {
        s.to_ascii_lowercase()
    } else {
        chars(s).collect()
    }
}

/// Whether `a` and `b` are the same text, case aside.
pub fn eq(a: &str, b: &str) -> bool {
    if a.is_ascii() && b.is_ascii() {
        return a.eq_ignore_ascii_case(b);
    }
    chars(a).eq(chars(b))
}

/// Whether two characters are the same, case aside.
#[inline]
pub fn eq_char(a: char, b: char) -> bool {
    a == b || fold_char(a) == fold_char(b)
}

/// The order of `a` and `b`, case aside: the code-point order of the folded
/// texts. `Equal` exactly when [`eq`].
pub fn cmp(a: &str, b: &str) -> Ordering {
    chars(a).cmp(chars(b))
}

/// Whether `s` starts with `prefix`, case aside.
pub fn starts_with(s: &str, prefix: &str) -> bool {
    let mut s = chars(s);
    chars(prefix).all(|p| s.next() == Some(p))
}

/// Whether `haystack` contains `needle`, case aside.
pub fn contains(haystack: &str, needle: &str) -> bool {
    key(haystack).contains(key(needle).as_str())
}

#[cfg(test)]
#[allow(non_snake_case)]
mod tests {
    use super::*;

    #[test]
    fn ascii_and_accented_letters_fold__feat__sheet_calc_model() {
        assert!(eq("Hello", "hELLO"));
        assert!(eq("Ä", "ä"));
        assert!(eq("ÜBERSICHT", "übersicht"));
        assert!(eq("Été", "ÉTÉ"));
        assert!(eq("Привет", "ПРИВЕТ"));
        assert!(!eq("a", "ä"));
    }

    #[test]
    fn sharp_s_is_not_double_s__feat__sheet_calc_model() {
        assert!(!eq("straße", "STRASSE"));
        assert!(!eq("straße", "strasse"));
        assert!(eq("straße", "STRAßE"));
        assert_eq!(fold_char('ß'), 'ß');
    }

    #[test]
    fn both_sigmas_are_one_letter__feat__sheet_calc_model() {
        assert!(eq("ΟΔΟΣ", "οδος"));
        assert!(eq("οδος", "οδοσ"));
    }

    #[test]
    fn key_and_cmp_agree_with_eq__feat__sheet_calc_model() {
        for (a, b) in [("Ärger", "ÄRGER"), ("abc", "ABD"), ("straße", "STRASSE")] {
            assert_eq!(key(a) == key(b), eq(a, b));
            assert_eq!(cmp(a, b) == Ordering::Equal, eq(a, b));
        }
        assert_eq!(cmp("apple", "Banana"), Ordering::Less);
        assert_eq!(cmp("Zebra", "apple"), Ordering::Greater);
        assert_eq!(cmp("ä", "Ö"), Ordering::Less);
    }

    #[test]
    fn prefix_and_substring__feat__sheet_calc_model() {
        assert!(starts_with("Übersicht 2026", "ÜBER"));
        assert!(!starts_with("Üb", "über"));
        assert!(contains("Die Straße", "STRAßE"));
        assert!(!contains("Die Straße", "STRASSE"));
    }
}
