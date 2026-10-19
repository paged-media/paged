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

//! The locale table: one row per locale the built-ins format for.
//!
//! A row holds the facts more than one formatter reads: the decimal and
//! group separators and CLDR's minimum grouping digits. The month and day
//! names are per language, beside the rows ([`EN_NAMES`], [`DE_NAMES`], …), so
//! a formatter that prints no names (paged.data's) links none. What only one
//! formatter reads stays with it, on top of the row:
//! paged.data's currency and date patterns, paged.sheet's list separator,
//! default date code and AM/PM ruling, and the places where Excel's own
//! output differs from these values (sheet-format's locale module names
//! each one).
//!
//! ## Where the values come from
//!
//! - **Separators and grouping:** the Unicode CLDR (common/main/<locale>.xml,
//!   v45): `numbers/symbols[numberSystem=latn]` `decimal` and `group`, and
//!   `numbers/minimumGroupingDigits`.
//! - **Month and day names:** the names Excel renders for `mmmm`, `mmm`,
//!   `dddd` and `ddd`, which paged.sheet's format conformance corpus pins
//!   (German abbreviates March as `Mrz`). English is also what InDesign
//!   writes for a date variable.
//!
//! Adding a locale is adding a row; no formatter has per-locale code.

/// Month and day names of one language.
#[derive(Debug, PartialEq, Eq)]
pub struct CalendarNames {
    /// January … December.
    pub months_full: [&'static str; 12],
    /// The abbreviated months, Jan … Dec.
    pub months_abbr: [&'static str; 12],
    /// Sunday … Saturday (index 0 is Sunday, as [`crate::calendar::weekday`]
    /// counts).
    pub days_full: [&'static str; 7],
    /// The abbreviated days, Sun … Sat.
    pub days_abbr: [&'static str; 7],
}

/// One locale's shared facts: a row of [`LOCALES`].
#[derive(Debug, PartialEq, Eq)]
pub struct LocaleFacts {
    /// The BCP 47 tag (`en`, `de`, `en-GB`, …).
    pub tag: &'static str,
    /// The name for a picker, in the locale's own language.
    pub name: &'static str,
    /// CLDR `decimal`.
    pub decimal: &'static str,
    /// CLDR `group`.
    pub group: &'static str,
    /// CLDR `minimumGroupingDigits` (see [`crate::digits::push_grouped`]).
    pub min_grouping: u8,
}

/// U+00A0 NO-BREAK SPACE, U+202F NARROW NO-BREAK SPACE and U+2019 RIGHT
/// SINGLE QUOTATION MARK, named so the table reads.
const NBSP: &str = "\u{a0}";
const NNBSP: &str = "\u{202f}";
const APOS: &str = "\u{2019}";

/// English.
pub static EN_NAMES: CalendarNames = CalendarNames {
    months_full: [
        "January",
        "February",
        "March",
        "April",
        "May",
        "June",
        "July",
        "August",
        "September",
        "October",
        "November",
        "December",
    ],
    months_abbr: [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ],
    days_full: [
        "Sunday",
        "Monday",
        "Tuesday",
        "Wednesday",
        "Thursday",
        "Friday",
        "Saturday",
    ],
    days_abbr: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
};

/// German. Excel abbreviates March as `Mrz`.
pub static DE_NAMES: CalendarNames = CalendarNames {
    months_full: [
        "Januar",
        "Februar",
        "März",
        "April",
        "Mai",
        "Juni",
        "Juli",
        "August",
        "September",
        "Oktober",
        "November",
        "Dezember",
    ],
    months_abbr: [
        "Jan", "Feb", "Mrz", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez",
    ],
    days_full: [
        "Sonntag",
        "Montag",
        "Dienstag",
        "Mittwoch",
        "Donnerstag",
        "Freitag",
        "Samstag",
    ],
    days_abbr: ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"],
};

/// French.
pub static FR_NAMES: CalendarNames = CalendarNames {
    months_full: [
        "janvier",
        "février",
        "mars",
        "avril",
        "mai",
        "juin",
        "juillet",
        "août",
        "septembre",
        "octobre",
        "novembre",
        "décembre",
    ],
    months_abbr: [
        "janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.",
        "déc.",
    ],
    days_full: [
        "dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi",
    ],
    days_abbr: ["dim.", "lun.", "mar.", "mer.", "jeu.", "ven.", "sam."],
};

/// Spanish.
pub static ES_NAMES: CalendarNames = CalendarNames {
    months_full: [
        "enero",
        "febrero",
        "marzo",
        "abril",
        "mayo",
        "junio",
        "julio",
        "agosto",
        "septiembre",
        "octubre",
        "noviembre",
        "diciembre",
    ],
    months_abbr: [
        "ene.", "feb.", "mar.", "abr.", "may.", "jun.", "jul.", "ago.", "sep.", "oct.", "nov.",
        "dic.",
    ],
    days_full: [
        "domingo",
        "lunes",
        "martes",
        "miércoles",
        "jueves",
        "viernes",
        "sábado",
    ],
    days_abbr: ["dom.", "lun.", "mar.", "mié.", "jue.", "vie.", "sáb."],
};

/// Italian.
pub static IT_NAMES: CalendarNames = CalendarNames {
    months_full: [
        "gennaio",
        "febbraio",
        "marzo",
        "aprile",
        "maggio",
        "giugno",
        "luglio",
        "agosto",
        "settembre",
        "ottobre",
        "novembre",
        "dicembre",
    ],
    months_abbr: [
        "gen", "feb", "mar", "apr", "mag", "giu", "lug", "ago", "set", "ott", "nov", "dic",
    ],
    days_full: [
        "domenica",
        "lunedì",
        "martedì",
        "mercoledì",
        "giovedì",
        "venerdì",
        "sabato",
    ],
    days_abbr: ["dom", "lun", "mar", "mer", "gio", "ven", "sab"],
};

/// English (en-US): `1,234.5`.
pub static EN: LocaleFacts = LocaleFacts {
    tag: "en",
    name: "English",
    decimal: ".",
    group: ",",
    min_grouping: 1,
};

/// German: `1.234,5`.
pub static DE: LocaleFacts = LocaleFacts {
    tag: "de",
    name: "Deutsch",
    decimal: ",",
    group: ".",
    min_grouping: 1,
};

/// English (UK): `1,234.5`.
pub static EN_GB: LocaleFacts = LocaleFacts {
    tag: "en-GB",
    name: "English (UK)",
    decimal: ".",
    group: ",",
    min_grouping: 1,
};

/// German (Austria): `1 234,5`, grouped with U+00A0.
pub static DE_AT: LocaleFacts = LocaleFacts {
    tag: "de-AT",
    name: "Deutsch (Österreich)",
    decimal: ",",
    group: NBSP,
    min_grouping: 1,
};

/// German (Switzerland): `1’234.5`, grouped with U+2019.
pub static DE_CH: LocaleFacts = LocaleFacts {
    tag: "de-CH",
    name: "Deutsch (Schweiz)",
    decimal: ".",
    group: APOS,
    min_grouping: 1,
};

/// French: `1 234,5`, grouped with U+202F.
pub static FR: LocaleFacts = LocaleFacts {
    tag: "fr",
    name: "Français",
    decimal: ",",
    group: NNBSP,
    min_grouping: 1,
};

/// Italian: `1.234,5`.
pub static IT: LocaleFacts = LocaleFacts {
    tag: "it",
    name: "Italiano",
    decimal: ",",
    group: ".",
    min_grouping: 1,
};

/// Spanish: `1234,5` but `12.345,5` (minimum grouping digits 2).
pub static ES: LocaleFacts = LocaleFacts {
    tag: "es",
    name: "Español",
    decimal: ",",
    group: ".",
    min_grouping: 2,
};

/// Dutch: `1.234,5`.
pub static NL: LocaleFacts = LocaleFacts {
    tag: "nl",
    name: "Nederlands",
    decimal: ",",
    group: ".",
    min_grouping: 1,
};

/// Every row, in paged.data's picker order.
pub static LOCALES: [&LocaleFacts; 9] = [&EN, &DE, &EN_GB, &DE_AT, &DE_CH, &FR, &IT, &ES, &NL];

/// The row for a BCP 47 tag, matched case-insensitively with `_` read as
/// `-` (`en_gb` is `en-GB`). `None` for a tag the table lacks.
pub fn by_tag(tag: &str) -> Option<&'static LocaleFacts> {
    LOCALES.iter().copied().find(|row| same_tag(row.tag, tag))
}

fn same_tag(row: &str, tag: &str) -> bool {
    row.len() == tag.len()
        && row.bytes().zip(tag.bytes()).all(|(a, b)| {
            let b = if b == b'_' { b'-' } else { b };
            a.eq_ignore_ascii_case(&b)
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tags_are_unique_and_found() {
        let mut seen = std::collections::BTreeSet::new();
        for row in LOCALES {
            assert!(seen.insert(row.tag.to_ascii_lowercase()), "{}", row.tag);
            assert!(std::ptr::eq(by_tag(row.tag).unwrap(), row));
            assert_ne!(row.decimal, row.group, "{}", row.tag);
            assert!(row.min_grouping >= 1, "{}", row.tag);
        }
        assert_eq!(by_tag("en_gb").map(|r| r.tag), Some("en-GB"));
        assert_eq!(by_tag("DE-ch").map(|r| r.tag), Some("de-CH"));
        assert_eq!(by_tag("xx"), None);
        assert_eq!(by_tag("e"), None);
    }

    #[test]
    fn names_have_no_blanks() {
        for n in [&EN_NAMES, &DE_NAMES, &FR_NAMES, &ES_NAMES, &IT_NAMES] {
            let all = n
                .months_full
                .iter()
                .chain(&n.months_abbr)
                .chain(&n.days_full)
                .chain(&n.days_abbr);
            for name in all {
                assert!(!name.trim().is_empty());
            }
        }
        assert_eq!(EN_NAMES.days_full[0], "Sunday");
        assert_eq!(DE_NAMES.months_abbr[2], "Mrz");
    }
}
