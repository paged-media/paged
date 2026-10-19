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

//! The formatting locales (spec §9.1) as ONE data table.
//!
//! A locale affects ONLY the display kernels' output (`NUMBER` / `CURRENCY` /
//! `PERCENT` / `DATEFMT`): separators, grouping, the default currency symbol and
//! where it goes, and the default date pattern. The canonical value form stays
//! locale-free, and content hashing never sees a locale, so re-resolution is
//! idempotent and a refresh's change detection does not depend on who views it.
//!
//! Adding a locale is adding a ROW to [`LOCALES`] — there is no per-locale code.
//! [`Locale`] is a handle onto a row; it serializes as the row's BCP 47 tag
//! (`"en"`, `"de"`, `"en-GB"`, …), which is what the document payload and the
//! JavaScript boundary carry.
//!
//! ## Where the values come from
//!
//! Each row is a row of the built-ins' shared locale table
//! (`paged_fmt::locale`, platform/shared/fmt), which holds the tag, the picker
//! name, the decimal and group separators and the minimum grouping digits
//! (Unicode CLDR v45), plus what only these kernels read, also from CLDR v45:
//! `currencyFormats[latn]/standard` (the `¤` position and the space beside
//! it), the currency the region uses (supplementalData `currencyData`), and
//! the `dateFormats` order, written with this DSL's `DD`/`MM`/`YYYY` tokens and
//! a four-digit year.
//!
//! Two rows deliberately keep the behaviour documents were made with before the
//! table existed, and say so:
//! - `en` formats dates as ISO `YYYY-MM-DD` (CLDR en-US short is `M/d/yy`), and
//! - `de` separates amount and `€` with an ASCII space (CLDR uses U+00A0).
//!
//! Changing either would rewrite committed content on the next refresh of
//! every existing document. Every row added since follows CLDR exactly,
//! including its no-break spaces.

use std::fmt;

use paged_fmt::locale::{self as shared, LocaleFacts};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// One locale's formatting facts — a row of [`LOCALES`].
#[derive(Debug, PartialEq, Eq)]
pub struct LocaleDef {
    /// The shared row: tag, picker name, separators, minimum grouping digits.
    pub facts: &'static LocaleFacts,
    /// The currency symbol `CURRENCY` uses when the caller names none.
    pub currency_symbol: &'static str,
    /// CLDR `currencyFormats/standard`, reduced to placement: `¤` is the symbol,
    /// `#` the formatted amount, anything else is literal (the space beside
    /// the symbol).
    pub currency_pattern: &'static str,
    /// The default `DATEFMT` pattern (`DD`, `MM`, `YYYY` tokens).
    pub date_pattern: &'static str,
}

/// Every locale the display kernels know, in picker order. See the module
/// documentation for the source of each value.
pub static LOCALES: &[LocaleDef] = &[
    // en (en-US): "¤#,##0.00", USD. Date: ISO, kept (see the module docs).
    LocaleDef {
        facts: &shared::EN,
        currency_symbol: "$",
        currency_pattern: "¤#",
        date_pattern: "YYYY-MM-DD",
    },
    // de: "#,##0.00 ¤", EUR, dd.MM.y. The space before the symbol is ASCII,
    // kept (see the module docs).
    LocaleDef {
        facts: &shared::DE,
        currency_symbol: "€",
        currency_pattern: "# ¤",
        date_pattern: "DD.MM.YYYY",
    },
    // en-GB: "¤#,##0.00", GBP, dd/MM/y.
    LocaleDef {
        facts: &shared::EN_GB,
        currency_symbol: "£",
        currency_pattern: "¤#",
        date_pattern: "DD/MM/YYYY",
    },
    // de-AT: "¤ #,##0.00" (symbol leads, U+00A0), EUR, dd.MM.y.
    LocaleDef {
        facts: &shared::DE_AT,
        currency_symbol: "€",
        currency_pattern: "¤\u{a0}#",
        date_pattern: "DD.MM.YYYY",
    },
    // de-CH: "¤ #,##0.00" (U+00A0), CHF, dd.MM.y.
    LocaleDef {
        facts: &shared::DE_CH,
        currency_symbol: "CHF",
        currency_pattern: "¤\u{a0}#",
        date_pattern: "DD.MM.YYYY",
    },
    // fr: "#,##0.00 ¤" (U+00A0), EUR, dd/MM/y.
    LocaleDef {
        facts: &shared::FR,
        currency_symbol: "€",
        currency_pattern: "#\u{a0}¤",
        date_pattern: "DD/MM/YYYY",
    },
    // it: "#,##0.00 ¤" (U+00A0), EUR, dd/MM/y.
    LocaleDef {
        facts: &shared::IT,
        currency_symbol: "€",
        currency_pattern: "#\u{a0}¤",
        date_pattern: "DD/MM/YYYY",
    },
    // es: "#,##0.00 ¤" (U+00A0), EUR, dd/MM/y.
    LocaleDef {
        facts: &shared::ES,
        currency_symbol: "€",
        currency_pattern: "#\u{a0}¤",
        date_pattern: "DD/MM/YYYY",
    },
    // nl: "¤ #,##0.00" (U+00A0), EUR, dd-MM-y.
    LocaleDef {
        facts: &shared::NL,
        currency_symbol: "€",
        currency_pattern: "¤\u{a0}#",
        date_pattern: "DD-MM-YYYY",
    },
];

/// A formatting locale: a handle onto one row of [`LOCALES`]. `Copy`, compared
/// by row, serialized as the row's tag. The default is `en`.
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct Locale(&'static LocaleDef);

impl Locale {
    /// English (the default).
    pub const EN: Locale = Locale(&LOCALES[0]);
    /// German.
    pub const DE: Locale = Locale(&LOCALES[1]);

    /// The locale for a tag, matched case-insensitively (`"en-gb"` is
    /// `en-GB`; `_` is accepted for `-`). `None` for a tag the table lacks.
    pub fn from_tag(tag: &str) -> Option<Locale> {
        let facts = shared::by_tag(tag)?;
        LOCALES
            .iter()
            .find(|d| d.facts.tag == facts.tag)
            .map(Locale)
    }

    /// Every locale, in picker order.
    pub fn all() -> impl Iterator<Item = Locale> {
        LOCALES.iter().map(Locale)
    }

    /// The row behind this handle.
    pub fn def(self) -> &'static LocaleDef {
        self.0
    }
    /// The BCP 47 tag.
    pub fn tag(self) -> &'static str {
        self.0.facts.tag
    }
    /// The display name for a picker, in the locale's own language.
    pub fn name(self) -> &'static str {
        self.0.facts.name
    }
    /// The decimal separator.
    pub fn decimal_sep(self) -> &'static str {
        self.0.facts.decimal
    }
    /// The thousands-grouping separator.
    pub fn group_sep(self) -> &'static str {
        self.0.facts.group
    }
    /// CLDR `minimumGroupingDigits`.
    pub fn min_grouping(self) -> usize {
        self.0.facts.min_grouping as usize
    }
    /// The default currency symbol.
    pub fn currency_symbol(self) -> &'static str {
        self.0.currency_symbol
    }
    /// Place an already formatted `amount` and a `symbol` by the locale's
    /// currency pattern (`¤#` → `$1,234.50`; `#\u{a0}¤` → `1 234,50 €`).
    pub fn place_currency(self, amount: &str, symbol: &str) -> String {
        let mut out = String::with_capacity(amount.len() + symbol.len() + 2);
        for ch in self.0.currency_pattern.chars() {
            match ch {
                '¤' => out.push_str(symbol),
                '#' => out.push_str(amount),
                c => out.push(c),
            }
        }
        out
    }
    /// The default `DATEFMT` pattern when the caller supplies none.
    pub fn date_pattern(self) -> &'static str {
        self.0.date_pattern
    }
}

impl Default for Locale {
    fn default() -> Self {
        Locale::EN
    }
}

impl fmt::Debug for Locale {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Locale({})", self.0.facts.tag)
    }
}

impl fmt::Display for Locale {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.0.facts.tag)
    }
}

impl Serialize for Locale {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(self.0.facts.tag)
    }
}

impl<'de> Deserialize<'de> for Locale {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let tag = String::deserialize(d)?;
        Locale::from_tag(&tag).ok_or_else(|| {
            serde::de::Error::custom(format!(
                "unknown locale '{tag}' (known: {})",
                LOCALES
                    .iter()
                    .map(|l| l.facts.tag)
                    .collect::<Vec<_>>()
                    .join(", ")
            ))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tags_are_unique_and_round_trip() {
        let mut seen = std::collections::BTreeSet::new();
        for l in Locale::all() {
            assert!(
                seen.insert(l.tag().to_ascii_lowercase()),
                "duplicate {}",
                l.tag()
            );
            let json = serde_json::to_string(&l).unwrap();
            assert_eq!(serde_json::from_str::<Locale>(&json).unwrap(), l);
        }
        // The two tags documents were saved with before the table existed.
        assert_eq!(serde_json::to_string(&Locale::EN).unwrap(), "\"en\"");
        assert_eq!(serde_json::to_string(&Locale::DE).unwrap(), "\"de\"");
        assert_eq!(Locale::from_tag("en_gb").map(Locale::tag), Some("en-GB"));
        assert!(serde_json::from_str::<Locale>("\"xx\"").is_err());
    }

    #[test]
    fn every_row_places_the_amount_and_the_symbol_once() {
        for l in Locale::all() {
            let p = l.def().currency_pattern;
            assert_eq!(p.matches('¤').count(), 1, "{}", l.tag());
            assert_eq!(p.matches('#').count(), 1, "{}", l.tag());
            assert_ne!(l.decimal_sep(), l.group_sep(), "{}", l.tag());
            for t in ["DD", "MM", "YYYY"] {
                assert!(l.date_pattern().contains(t), "{} lacks {t}", l.tag());
            }
        }
    }
}
