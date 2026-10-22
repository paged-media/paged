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

//! Typed cell entry: what a person TYPES into a cell becomes the value Excel
//! would store, plus the number format Excel would give the cell (ruling
//! `sheet.edit.typed-entry`, ADR 511). One pure parser serves the session's
//! cell entry (`Engine::enter` / `SheetSession::set_cell`) and the CSV import.
//!
//! Every rule below is pinned by the Excel oracle's ENTRY lane
//! (`sheet-conformance/oracle/excel/recorded/entry*.tsv`: the raw texts typed
//! into real Excel, its stored value, type and number format read back).
//!
//! - A leading `'` forces text; the apostrophe is not part of the value and
//!   the cell gains the quote-prefix style attribute ([`Entry::quote_prefix`]).
//! - `TRUE` / `FALSE` (any case, no surrounding spaces) are booleans; the
//!   seven classic error literals (`#N/A`, `#DIV/0!`, … any case, exact) are
//!   errors. `#SPILL!` / `#CALC!` typed are TEXT (Excel never accepts them).
//! - Numbers ignore surrounding spaces, allow a sign (and spaces after it),
//!   accounting parentheses for a negative, the locale's group separator
//!   (every group after the first has at least three digits) and decimal
//!   separator, and an exponent. Digits past the 15th significant one are
//!   TRUNCATED (Excel stores `9999999999999999` as `9999999999999990`).
//! - `%` before or after a number divides by 100; the locale's currency
//!   symbol in its own position (`$5` en-US, `5 €` de-DE) marks currency; a
//!   leading `€` elsewhere is accepted as a plain number.
//! - Fractions need a whole part (`0 1/2`, `1 1/4`); a bare `1/2` is a DATE
//!   (2 January of the current year in en-US).
//! - Dates: numeric in the locale's order (en-US `m/d/y`, the others
//!   `d/m/y`) or ISO `y-m-d`; English month names (prefix of at least three
//!   letters: `Jan`, `Sept`, `January`); two-part forms are a day and month
//!   of the current year, else a month and year. Two-digit years 00–29 are
//!   20xx, 30–99 19xx; nothing before 1900 or after 9999.
//! - Times `h:mm`, `h:mm:ss`, fractional seconds, `AM`/`PM` after a space;
//!   a date and a time separated by a space are a date-time.
//!
//! The FORMAT a typed entry implies is a [`FormatHint`]; whether it replaces
//! the cell's current format is [`resolve_format`] (Excel's rule: General
//! always takes it; a format Excel itself assigns from typing takes a hint of
//! another category; any other format stays).

use sheet_core::{CellError, CellValue, DateSystem, Locale};

use crate::locale::locale_data;
use crate::serial::{serial_to_ymd, ymd_to_serial};

/// What the parser needs besides the text: the display locale (separators,
/// date order, currency), the workbook date system, and the session clock
/// (a date typed without a year lands in the current year).
#[derive(Copy, Clone, Debug)]
pub struct EntryCtx {
    pub locale: Locale,
    pub date_system: DateSystem,
    /// The `NOW()` serial of the session; its year completes `1/2` or
    /// `15-Jan`.
    pub now_serial: f64,
}

impl EntryCtx {
    pub fn new(locale: Locale, date_system: DateSystem, now_serial: f64) -> Self {
        EntryCtx {
            locale,
            date_system,
            now_serial,
        }
    }
}

/// The number format a typed entry implies (Excel's built-in choice for that
/// shape of text). [`FormatHint::code`] spells it for a locale.
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash)]
pub enum FormatHint {
    /// `1,234` → `#,##0`; `1,234.5` → `#,##0.00`.
    Thousands { decimals: bool },
    /// `45%` → `0%`; `12.5%` → `0.00%`.
    Percent { decimals: bool },
    /// `$5` → the locale's whole currency format; `$1.50` → with cents.
    Currency { decimals: bool },
    /// `1e3` → `0.00E+00`.
    Scientific,
    /// `1 1/4` → `# ?/?`; a denominator of two or more digits → `# ??/??`.
    Fraction { wide: bool },
    /// A full numeric date → the short date (built-in 14 in en-US).
    Date,
    /// `15-Jan`, `1/2` → `d-mmm`.
    DayMonth,
    /// `Jan 2024`, `1/2024` → `mmm-yy`.
    MonthYear,
    /// `15-Jan-2024`, `January 15, 2024` → `d-mmm-yy`.
    DayMonthYear,
    /// A date and a time → `m/d/yy h:mm` (en-US).
    DateTime,
    /// `9:30` → `h:mm`; with seconds `h:mm:ss`; with AM/PM the 12-hour forms.
    Time { seconds: bool, ampm: bool },
    /// `25:30` (an hour past 23) → `[h]:mm:ss`.
    Elapsed,
    /// Fractional seconds → `mm:ss.0`.
    FractionalSeconds,
}

/// The category a format belongs to: a typed entry's format replaces a
/// format Excel assigns from typing only when the categories differ.
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash)]
pub enum Category {
    Number,
    Percent,
    Currency,
    Scientific,
    Fraction,
    Date,
    Time,
}

/// en-US currency (Excel's built-ins 6 and 8 under en-US).
const USD_WHOLE: &str = "$#,##0_);[Red]($#,##0)";
const USD_CENTS: &str = "$#,##0.00_);[Red]($#,##0.00)";
/// The euro locales' currency (Excel's built-ins 6 and 8 under de/fr/es/it).
const EUR_WHOLE: &str = "#,##0 \"€\";[Red]-#,##0 \"€\"";
const EUR_CENTS: &str = "#,##0.00 \"€\";[Red]-#,##0.00 \"€\"";

/// The locale's numeric short date (built-in 14 renders the system short
/// date; the euro locales' codes are explicit customs because the engine's
/// built-in 14 is the en-US spelling).
fn short_date(locale: Locale) -> &'static str {
    match locale {
        Locale::EnUs => "m/d/yy",
        Locale::DeDe => "dd\\.mm\\.yyyy",
        Locale::FrFr | Locale::EsEs | Locale::ItIt => "dd/mm/yyyy",
    }
}

fn short_date_time(locale: Locale) -> &'static str {
    match locale {
        Locale::EnUs => "m/d/yy h:mm",
        Locale::DeDe => "dd\\.mm\\.yyyy h:mm",
        Locale::FrFr | Locale::EsEs | Locale::ItIt => "dd/mm/yyyy h:mm",
    }
}

impl FormatHint {
    /// The number-format code for `locale` (the token grammar is
    /// locale-neutral; only the currency and the short date differ).
    pub fn code(self, locale: Locale) -> &'static str {
        use FormatHint::*;
        match self {
            Thousands { decimals: false } => "#,##0",
            Thousands { decimals: true } => "#,##0.00",
            Percent { decimals: false } => "0%",
            Percent { decimals: true } => "0.00%",
            Currency { decimals } => match (locale, decimals) {
                (Locale::EnUs, false) => USD_WHOLE,
                (Locale::EnUs, true) => USD_CENTS,
                (_, false) => EUR_WHOLE,
                (_, true) => EUR_CENTS,
            },
            Scientific => "0.00E+00",
            Fraction { wide: false } => "# ?/?",
            Fraction { wide: true } => "# ??/??",
            Date => short_date(locale),
            DayMonth => "d-mmm",
            MonthYear => "mmm-yy",
            DayMonthYear => "d-mmm-yy",
            DateTime => short_date_time(locale),
            Time {
                seconds: false,
                ampm: false,
            } => "h:mm",
            Time {
                seconds: true,
                ampm: false,
            } => "h:mm:ss",
            Time {
                seconds: false,
                ampm: true,
            } => "h:mm AM/PM",
            Time {
                seconds: true,
                ampm: true,
            } => "h:mm:ss AM/PM",
            Elapsed => "[h]:mm:ss",
            FractionalSeconds => "mm:ss.0",
        }
    }

    pub fn category(self) -> Category {
        use FormatHint::*;
        match self {
            Thousands { .. } => Category::Number,
            Percent { .. } => Category::Percent,
            Currency { .. } => Category::Currency,
            Scientific => Category::Scientific,
            Fraction { .. } => Category::Fraction,
            Date | DayMonth | MonthYear | DayMonthYear | DateTime => Category::Date,
            Time { .. } | Elapsed | FractionalSeconds => Category::Time,
        }
    }

    /// Every hint, for tables and tests.
    pub const ALL: [FormatHint; 20] = [
        FormatHint::Thousands { decimals: false },
        FormatHint::Thousands { decimals: true },
        FormatHint::Percent { decimals: false },
        FormatHint::Percent { decimals: true },
        FormatHint::Currency { decimals: false },
        FormatHint::Currency { decimals: true },
        FormatHint::Scientific,
        FormatHint::Fraction { wide: false },
        FormatHint::Fraction { wide: true },
        FormatHint::Date,
        FormatHint::DayMonth,
        FormatHint::MonthYear,
        FormatHint::DayMonthYear,
        FormatHint::DateTime,
        FormatHint::Time {
            seconds: false,
            ampm: false,
        },
        FormatHint::Time {
            seconds: true,
            ampm: false,
        },
        FormatHint::Time {
            seconds: false,
            ampm: true,
        },
        FormatHint::Time {
            seconds: true,
            ampm: true,
        },
        FormatHint::Elapsed,
        FormatHint::FractionalSeconds,
    ];
}

/// The parsed entry.
#[derive(Clone, Debug, PartialEq)]
pub struct Entry {
    /// The value to store.
    pub value: CellValue,
    /// The format the text implies (see [`resolve_format`]).
    pub hint: Option<FormatHint>,
    /// A leading `'` forced text: the cell carries Excel's quote-prefix
    /// style attribute.
    pub quote_prefix: bool,
}

impl Entry {
    fn plain(value: CellValue) -> Entry {
        Entry {
            value,
            hint: None,
            quote_prefix: false,
        }
    }

    fn hinted(value: CellValue, hint: Option<FormatHint>) -> Entry {
        Entry {
            value,
            hint,
            quote_prefix: false,
        }
    }
}

/// Is `code` the Text format (`@`)? Typing into such a cell stores the text
/// verbatim (Excel; only a leading `'` is still taken off).
pub fn is_text_format(code: &str) -> bool {
    code.trim() == "@"
}

/// The category of a format Excel itself assigns from typing (its built-in
/// percent, scientific, fraction, date, time and currency formats), or
/// `None` for General, the plain number formats and every custom format —
/// those a typed entry never replaces (except General, see
/// [`resolve_format`]).
pub fn auto_category(code: &str) -> Option<Category> {
    const LOCALES: [Locale; 5] = [
        Locale::EnUs,
        Locale::DeDe,
        Locale::FrFr,
        Locale::EsEs,
        Locale::ItIt,
    ];
    for hint in FormatHint::ALL {
        if matches!(hint, FormatHint::Thousands { .. }) {
            continue; // `#,##0` is a plain number format: sticky
        }
        if LOCALES.iter().any(|&l| hint.code(l) == code) {
            return Some(hint.category());
        }
    }
    // Excel's other typing-family built-ins: `mm:ss` (45) and the en-US
    // currency formats without the red negative (5, 7).
    match code {
        "mm:ss" => Some(Category::Time),
        "$#,##0_);($#,##0)" | "$#,##0.00_);($#,##0.00)" => Some(Category::Currency),
        _ => None,
    }
}

/// Excel's rule for a typed entry's format against the cell's current
/// format (recorded: `entry.tsv` rows `pre-*`): a General cell takes the
/// hint; a cell whose format Excel assigns from typing takes a hint of a
/// DIFFERENT category, except the thousands hint (`#,##0` never replaces a
/// format); every other format (the plain number formats, customs) stays.
/// Returns the code to apply, or `None` to keep the current format.
pub fn resolve_format(current: &str, hint: FormatHint, locale: Locale) -> Option<&'static str> {
    let code = hint.code(locale);
    if current.is_empty() || current.eq_ignore_ascii_case("General") {
        return (code != current).then_some(code);
    }
    if matches!(hint, FormatHint::Thousands { .. }) {
        return None;
    }
    match auto_category(current) {
        Some(cat) if cat != hint.category() => Some(code),
        _ => None,
    }
}

/// Would re-typing `text` store anything other than this same text? Then a
/// re-enterable input of the text cell needs a leading `'` (the undo
/// journal's inverse; Excel shows such cells with the apostrophe).
pub fn needs_quote(text: &str, ctx: &EntryCtx) -> bool {
    if text.starts_with('=') || text.starts_with('\'') {
        return true;
    }
    let e = parse_entry(text, ctx);
    e.hint.is_some() || !matches!(&e.value, CellValue::Text(t) if t.as_str() == text)
}

/// Parse `raw` for a cell whose current number format is `current`: a Text
/// (`@`) cell keeps the text verbatim, every other cell is [`parse_entry`].
pub fn parse_entry_for_format(raw: &str, current: &str, ctx: &EntryCtx) -> Entry {
    if is_text_format(current) {
        return match raw.strip_prefix('\'') {
            Some(rest) => Entry {
                value: CellValue::Text(rest.into()),
                hint: None,
                quote_prefix: true,
            },
            None if raw.is_empty() => Entry::plain(CellValue::Empty),
            None => Entry::plain(CellValue::Text(raw.into())),
        };
    }
    parse_entry(raw, ctx)
}

/// Type one raw entry. A leading `=` is NOT a formula here (the engine's
/// entry door checks for formulas first; the CSV import keeps it as text):
/// it comes back as text.
pub fn parse_entry(raw: &str, ctx: &EntryCtx) -> Entry {
    if raw.is_empty() {
        return Entry::plain(CellValue::Empty);
    }
    if let Some(rest) = raw.strip_prefix('\'') {
        return Entry {
            value: CellValue::Text(rest.into()),
            hint: None,
            quote_prefix: true,
        };
    }
    if raw.starts_with('=') {
        return Entry::plain(CellValue::Text(raw.into()));
    }
    if raw.eq_ignore_ascii_case("TRUE") {
        return Entry::plain(CellValue::Bool(true));
    }
    if raw.eq_ignore_ascii_case("FALSE") {
        return Entry::plain(CellValue::Bool(false));
    }
    if let Some(e) = typed_error(raw) {
        return Entry::plain(CellValue::Error(e));
    }
    let t = raw.trim_matches(' ');
    let loc = Loc::of(ctx.locale);
    if let Some(n) = parse_number(t, &loc) {
        return match n.value {
            Some(v) => Entry::hinted(CellValue::Number(v), n.hint),
            // Out of Excel's range: kept as text, yet the exponent's format
            // is applied (recorded: `1e400`, `1E308`).
            None => Entry::hinted(CellValue::Text(raw.into()), n.hint),
        };
    }
    if let Some((v, hint)) = parse_fraction(t) {
        return Entry::hinted(CellValue::Number(v), Some(hint));
    }
    if let Some((v, hint)) = parse_date_time(t, ctx, &loc) {
        return Entry::hinted(CellValue::Number(v), hint);
    }
    Entry::plain(CellValue::Text(raw.into()))
}

/// The error literals a person can type (exact, any case). The newer errors
/// (`#SPILL!`, `#CALC!`) are text when typed; `#GETTING_DATA` has no model
/// value (recorded divergence).
fn typed_error(raw: &str) -> Option<CellError> {
    if !raw.starts_with('#') || matches!(CellError::parse(raw), Some(CellError::Spill)) {
        return None;
    }
    CellError::parse(raw)
}

/// The locale's entry spellings.
struct Loc {
    decimal: char,
    group: char,
    currency: &'static str,
    currency_prefix: bool,
    /// Numeric date separators besides `/` and `-` (`.` in de-DE).
    dot_dates: bool,
    /// `true`: numeric dates read month first (en-US).
    month_first: bool,
}

impl Loc {
    fn of(locale: Locale) -> Loc {
        let data = locale_data(locale);
        let ch = |s: &str| s.chars().next().unwrap_or(' ');
        Loc {
            decimal: ch(data.decimal),
            group: ch(data.group),
            currency: if locale == Locale::EnUs { "$" } else { "€" },
            currency_prefix: locale == Locale::EnUs,
            dot_dates: data.short_date.contains('.'),
            month_first: data.short_date.starts_with('m'),
        }
    }
}

/// A parsed number: `value` is `None` when out of Excel's range.
struct Num {
    value: Option<f64>,
    hint: Option<FormatHint>,
}

/// Excel's largest typable magnitude (`9.99999999999999E+307`).
const MAX_MAGNITUDE: f64 = 9.99999999999999e307;

fn parse_number(t: &str, loc: &Loc) -> Option<Num> {
    let mut s = t;
    let (mut sign, mut paren, mut pct, mut cur) = (false, false, false, false);
    let mut euro = false;
    let mut negative = false;
    // Peel the affixes, each at most once, in any order Excel accepts
    // (`-$5`, `$-5`, `($5)`, `$(5)`, `(5%)`, `%45`, `12.5 %`, `5 €`).
    loop {
        let before = s;
        if !paren && !sign && s.len() >= 2 && s.starts_with('(') && s.ends_with(')') {
            paren = true;
            negative = true;
            s = s[1..s.len() - 1].trim_matches(' ');
        }
        if !sign && !paren {
            if let Some(rest) = s.strip_prefix(['+', '-']) {
                sign = true;
                negative = s.starts_with('-');
                s = rest.trim_start_matches(' ');
            }
        }
        if !cur && !euro && !pct {
            if loc.currency_prefix {
                if let Some(rest) = s.strip_prefix(loc.currency) {
                    cur = true;
                    s = rest.trim_start_matches(' ');
                }
            } else if let Some(rest) = s.strip_suffix(loc.currency) {
                cur = true;
                s = rest.trim_end_matches(' ');
            }
        }
        // A leading euro sign outside its native position is accepted as a
        // plain number with no format (recorded in en-US `€5` and in de, es,
        // it `€1.234,50` / `€ 5`).
        if !cur && !euro && !pct {
            if let Some(rest) = s.strip_prefix('€') {
                euro = true;
                s = rest.trim_start_matches(' ');
            }
        }
        if !pct && !cur && !euro {
            if let Some(rest) = s.strip_suffix('%') {
                pct = true;
                s = rest.trim_end_matches(' ');
            } else if let Some(rest) = s.strip_prefix('%') {
                pct = true;
                s = rest;
            }
        }
        if s == before {
            break;
        }
    }
    let core = parse_core(s, loc)?;
    let mut hint = if core.exponent {
        Some(FormatHint::Scientific)
    } else if pct {
        Some(FormatHint::Percent {
            decimals: core.decimal,
        })
    } else if cur {
        Some(FormatHint::Currency {
            decimals: core.decimal,
        })
    } else if euro {
        None // `€1.234,50` stays General (recorded)
    } else if core.grouped {
        Some(FormatHint::Thousands {
            decimals: core.decimal,
        })
    } else {
        None
    };
    let shift = if pct { -2 } else { 0 };
    let value = core.value(shift).map(|v| {
        let v = if negative { -v } else { v };
        if v == 0.0 {
            0.0
        } else {
            v
        }
    });
    if value.is_none() && !core.exponent {
        hint = None;
    }
    Some(Num { value, hint })
}

/// The bare numeric core: digits, groups, decimal, exponent.
struct Core {
    /// The significant digits (leading zeros dropped).
    digits: String,
    /// The decimal exponent of the digit string's first digit position:
    /// value = 0.<digits> × 10^point.
    point: i64,
    grouped: bool,
    decimal: bool,
    exponent: bool,
}

impl Core {
    /// The value, truncated to 15 significant digits, scaled by
    /// 10^`shift`; `None` outside Excel's range.
    fn value(&self, shift: i64) -> Option<f64> {
        let sig: String = self.digits.chars().take(15).collect();
        if sig.is_empty() {
            return Some(0.0);
        }
        let v: f64 = format!("0.{sig}e{}", self.point + shift).parse().ok()?;
        if !v.is_finite() || v.abs() > MAX_MAGNITUDE || v.abs() < f64::MIN_POSITIVE {
            return None;
        }
        Some(v)
    }
}

fn parse_core(s: &str, loc: &Loc) -> Option<Core> {
    let (mant, exp) = match s.find(['e', 'E']) {
        Some(i) => (&s[..i], Some(&s[i + 1..])),
        None => (s, None),
    };
    let exp_val: i64 = match exp {
        None => 0,
        Some(e) => {
            let body = e.strip_prefix(['+', '-']).unwrap_or(e);
            if body.is_empty() || !body.bytes().all(|b| b.is_ascii_digit()) || body.len() > 6 {
                return None;
            }
            let n: i64 = body.parse().ok()?;
            if e.starts_with('-') {
                -n
            } else {
                n
            }
        }
    };
    let (int_part, frac_part) = match mant.find(loc.decimal) {
        Some(i) => (&mant[..i], Some(&mant[i + loc.decimal.len_utf8()..])),
        None => (mant, None),
    };
    let frac = frac_part.unwrap_or("");
    if !frac.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let mut groups = int_part.split(loc.group);
    let first = groups.next().unwrap_or("");
    let rest: Vec<&str> = groups.collect();
    let grouped = !rest.is_empty();
    if !first.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    if grouped && first.is_empty() {
        return None; // `,5` in en-US
    }
    for g in &rest {
        if g.len() < 3 || !g.bytes().all(|b| b.is_ascii_digit()) {
            return None; // `12,34` is not a number
        }
    }
    let int_digits: String = std::iter::once(first).chain(rest).collect();
    if int_digits.is_empty() && frac.is_empty() {
        return None;
    }
    let all = format!("{int_digits}{frac}");
    let lead = all.bytes().take_while(|&b| b == b'0').count();
    let digits = all[lead..].to_string();
    let point = int_digits.len() as i64 - lead as i64 + exp_val;
    Some(Core {
        digits,
        point,
        grouped,
        decimal: frac_part.is_some(),
        exponent: exp.is_some(),
    })
}

/// `W N/D` (a whole part is required): `1 1/4` → 1.25.
fn parse_fraction(t: &str) -> Option<(f64, FormatHint)> {
    let (negative, body) = match t.strip_prefix('-') {
        Some(r) => (true, r),
        None => (false, t.strip_prefix('+').unwrap_or(t)),
    };
    let (whole, frac) = body.split_once(' ')?;
    let frac = frac.trim_start_matches(' ');
    let (n, d) = frac.split_once('/')?;
    let digits = |s: &str| !s.is_empty() && s.len() <= 15 && s.bytes().all(|b| b.is_ascii_digit());
    if !digits(whole) || !digits(n) || !digits(d) {
        return None;
    }
    let (w, n, dv): (f64, f64, f64) = (whole.parse().ok()?, n.parse().ok()?, d.parse().ok()?);
    if dv == 0.0 {
        return None;
    }
    let v = w + n / dv;
    let v = if negative && v != 0.0 { -v } else { v };
    Some((v, FormatHint::Fraction { wide: d.len() > 1 }))
}

/// English month names, matched by a prefix of at least three letters.
const MONTHS: [&str; 12] = [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
];

fn month_name(s: &str) -> Option<u32> {
    if s.len() < 3 || !s.bytes().all(|b| b.is_ascii_alphabetic()) {
        return None;
    }
    let low = s.to_ascii_lowercase();
    MONTHS
        .iter()
        .position(|m| m.starts_with(&low))
        .map(|i| i as u32 + 1)
}

fn all_digits(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

/// A year as typed: 1–2 digits through the 00–29 / 30–99 window, 4 digits
/// as is (3 digits are not a year).
fn year_of(s: &str) -> Option<i32> {
    if !all_digits(s) {
        return None;
    }
    let y: i32 = s.parse().ok()?;
    match s.len() {
        1 | 2 => Some(if y < 30 { 2000 + y } else { 1900 + y }),
        4 => Some(y),
        _ => None,
    }
}

fn small(s: &str) -> Option<u32> {
    if !all_digits(s) || s.len() > 2 {
        return None;
    }
    s.parse().ok()
}

/// A date in the domain (1900/1904 system, 9999-12-31 the last).
fn date_serial(y: i32, m: u32, d: u32, ctx: &EntryCtx) -> Option<f64> {
    if y > 9999 {
        return None;
    }
    ymd_to_serial(y, m, d, ctx.date_system)
}

fn current_year(ctx: &EntryCtx) -> i32 {
    serial_to_ymd(ctx.now_serial, ctx.date_system)
        .map(|(y, _, _)| y)
        .unwrap_or(1900)
}

/// `[date] [time]` in either order, separated by a space.
fn parse_date_time(t: &str, ctx: &EntryCtx, loc: &Loc) -> Option<(f64, Option<FormatHint>)> {
    // An AM/PM marker after a space belongs to the time.
    let lower = t.to_ascii_lowercase();
    let (body, ampm) = ["am", "pm", "a", "p"]
        .iter()
        .find_map(|m| {
            let tail = format!(" {m}");
            lower.ends_with(&tail).then(|| {
                (
                    t[..t.len() - tail.len()].trim_end_matches(' '),
                    Some(m.starts_with('p')),
                )
            })
        })
        .unwrap_or((t, None));
    let words: Vec<&str> = body.split(' ').filter(|w| !w.is_empty()).collect();
    let time_at = words.iter().position(|w| w.contains(':')).or_else(|| {
        // `9 PM`: an hour alone, before the marker.
        (ampm.is_some() && words.last().is_some_and(|w| all_digits(w))).then(|| words.len() - 1)
    });
    match time_at {
        None => {
            if ampm.is_some() {
                return None;
            }
            parse_date(&words, ctx, loc).map(|(v, h)| (v, Some(h)))
        }
        Some(i) => {
            let (secs, time_hint) = parse_time(words[i], ampm, loc)?;
            let mut rest = words.clone();
            rest.remove(i);
            let tv = secs / 86400.0;
            if rest.is_empty() {
                return Some((tv, time_hint));
            }
            // A time must sit at an end of the date words.
            if i != 0 && i != words.len() - 1 {
                return None;
            }
            let (dv, _) = parse_date(&rest, ctx, loc)?;
            Some((dv + tv, Some(FormatHint::DateTime)))
        }
    }
}

/// `h:mm[:ss[.f]]` (or `mm:ss.f`, or an hour alone with AM/PM) → seconds.
fn parse_time(w: &str, ampm: Option<bool>, loc: &Loc) -> Option<(f64, Option<FormatHint>)> {
    let parts: Vec<&str> = w.split(':').collect();
    if parts.len() > 3 || parts.iter().any(|p| p.is_empty()) {
        return None;
    }
    // Fractional seconds on the last part, with the locale's decimal.
    let last = parts[parts.len() - 1];
    let (last_int, frac) = match last.split_once(loc.decimal) {
        Some((a, b)) if parts.len() > 1 && all_digits(b) => (a, Some(b)),
        Some(_) => return None,
        None => (last, None),
    };
    let nums: Vec<&str> = parts[..parts.len() - 1]
        .iter()
        .copied()
        .chain(std::iter::once(last_int))
        .collect();
    if nums.iter().any(|n| !all_digits(n) || n.len() > 9) {
        return None;
    }
    let n: Vec<f64> = nums
        .iter()
        .map(|s| s.parse::<f64>().unwrap_or(0.0))
        .collect();
    let frac_v = match frac {
        Some(f) => format!("0.{f}").parse::<f64>().ok()?,
        None => 0.0,
    };
    let (mut h, m, s, has_secs) = match (n.len(), frac.is_some()) {
        (1, _) => (n[0], 0.0, 0.0, false),
        // `30:45.5` reads minutes and seconds.
        (2, true) => (0.0, n[0], n[1] + frac_v, true),
        (2, false) => (n[0], n[1], 0.0, false),
        _ => (n[0], n[1], n[2] + frac_v, true),
    };
    if n.len() == 1 && ampm.is_none() {
        return None;
    }
    let overflow = m >= 60.0 || s >= 60.0;
    if let Some(pm) = ampm {
        if h > 12.0 {
            return None;
        }
        if h == 12.0 {
            h = 0.0;
        }
        if pm {
            h += 12.0;
        }
    }
    let secs = h * 3600.0 + m * 60.0 + s;
    let hint = if overflow {
        None
    } else if frac.is_some() {
        Some(FormatHint::FractionalSeconds)
    } else if ampm.is_some() {
        Some(FormatHint::Time {
            seconds: has_secs,
            ampm: true,
        })
    } else if h >= 24.0 {
        Some(FormatHint::Elapsed)
    } else {
        Some(FormatHint::Time {
            seconds: has_secs,
            ampm: false,
        })
    };
    Some((secs, hint))
}

/// The date words (already split on spaces) → serial + the date format.
fn parse_date(words: &[&str], ctx: &EntryCtx, loc: &Loc) -> Option<(f64, FormatHint)> {
    match words {
        [w] => parse_date_token(w, ctx, loc),
        _ => parse_spaced_date(words, ctx, loc),
    }
}

/// One space-free token: `1/15/2024`, `2024-01-15`, `15-Jan-24`, `1/2`.
fn parse_date_token(w: &str, ctx: &EntryCtx, loc: &Loc) -> Option<(f64, FormatHint)> {
    let sep = w
        .chars()
        .find(|&c| c == '/' || c == '-' || (c == '.' && loc.dot_dates))?;
    let parts: Vec<&str> = w.split(sep).collect();
    if parts.iter().any(|p| p.is_empty()) {
        return None;
    }
    // One separator kind per date (`1-2/3` is not a date).
    if parts.iter().any(|p| p.contains(['/', '-', '.'])) {
        return None;
    }
    if parts.iter().any(|p| month_name(p).is_some()) {
        return named_date(&parts, false, ctx);
    }
    numeric_date(&parts, ctx, loc)
}

/// Numeric parts in the locale's order (or ISO when the first has 4 digits).
fn numeric_date(parts: &[&str], ctx: &EntryCtx, loc: &Loc) -> Option<(f64, FormatHint)> {
    if !parts.iter().all(|p| all_digits(p)) {
        return None;
    }
    match parts {
        [a, b, c] => {
            let (y, m, d) = if a.len() == 4 {
                (year_of(a)?, small(b)?, small(c)?)
            } else if loc.month_first {
                (year_of(c)?, small(a)?, small(b)?)
            } else {
                (year_of(c)?, small(b)?, small(a)?)
            };
            date_serial(y, m, d, ctx).map(|v| (v, FormatHint::Date))
        }
        [a, b] => {
            let (m, d) = if loc.month_first {
                (small(a), small(b))
            } else {
                (small(b), small(a))
            };
            // A day and month of the current year...
            if let (Some(m), Some(d)) = (m, d) {
                if let Some(v) = date_serial(current_year(ctx), m, d, ctx) {
                    return Some((v, FormatHint::DayMonth));
                }
            }
            // ...else a month and year (`1/2024`, `12.34`).
            let m = small(a)?;
            let y = year_of(b)?;
            date_serial(y, m, 1, ctx).map(|v| (v, FormatHint::MonthYear))
        }
        _ => None,
    }
}

/// Parts where one is a month name: `15-Jan`, `Jan-24`, `15-Jan-2024`,
/// `Jan 2024`, `January 15, 2024` (`comma` = the day carried a comma).
fn named_date(parts: &[&str], comma: bool, ctx: &EntryCtx) -> Option<(f64, FormatHint)> {
    let mi = parts.iter().position(|p| month_name(p).is_some())?;
    let m = month_name(parts[mi])?;
    let others: Vec<&str> = parts
        .iter()
        .enumerate()
        .filter(|&(i, _)| i != mi)
        .map(|(_, p)| *p)
        .collect();
    match (mi, others.as_slice()) {
        // `15-Jan-2024` / `15 January 2024`: day, month, year.
        (1, [d, y]) if !comma => {
            let v = date_serial(year_of(y)?, m, small(d)?, ctx)?;
            Some((v, FormatHint::DayMonthYear))
        }
        // `January 15, 2024`: the comma is required.
        (0, [d, y]) if comma => {
            let v = date_serial(year_of(y)?, m, small(d)?, ctx)?;
            Some((v, FormatHint::DayMonthYear))
        }
        // `15-Jan`.
        (1, [d]) => {
            let v = date_serial(current_year(ctx), m, small(d)?, ctx)?;
            Some((v, FormatHint::DayMonth))
        }
        // `Jan 15` (a day when it can be one) or `Jan 2024` (a year).
        (0, [x]) => {
            if let Some(d) = small(x) {
                if let Some(v) = date_serial(current_year(ctx), m, d, ctx) {
                    return Some((v, FormatHint::DayMonth));
                }
            }
            let v = date_serial(year_of(x)?, m, 1, ctx)?;
            Some((v, FormatHint::MonthYear))
        }
        _ => None,
    }
}

/// Space-separated dates: `Jan 15`, `Jan 2024`, `15 January 2024`,
/// `January 15, 2024` and (dot-date locales) `15. Januar 2024`.
fn parse_spaced_date(words: &[&str], ctx: &EntryCtx, loc: &Loc) -> Option<(f64, FormatHint)> {
    if words.len() > 3 {
        return None;
    }
    let mut parts: Vec<&str> = Vec::with_capacity(words.len());
    let mut comma = false;
    for (i, w) in words.iter().enumerate() {
        let mut w = *w;
        if let Some(x) = w.strip_suffix(',') {
            // Only the day before the year may carry the comma.
            if i != 1 || words.len() != 3 {
                return None;
            }
            comma = true;
            w = x;
        }
        if loc.dot_dates && i == 0 {
            if let Some(x) = w.strip_suffix('.') {
                if all_digits(x) {
                    w = x;
                }
            }
        }
        if w.is_empty() || w.contains(['/', '-', '.']) {
            return None;
        }
        parts.push(w);
    }
    if !parts.iter().any(|p| month_name(p).is_some()) {
        return None;
    }
    named_date(&parts, comma, ctx)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn en() -> EntryCtx {
        // 2026-10-22, the en-US recording's session clock.
        EntryCtx::new(
            Locale::EnUs,
            DateSystem::Date1900,
            ymd_to_serial(2026, 10, 22, DateSystem::Date1900).unwrap(),
        )
    }

    fn n(raw: &str) -> (f64, Option<&'static str>) {
        let e = parse_entry(raw, &en());
        match e.value {
            CellValue::Number(v) => (v, e.hint.map(|h| h.code(Locale::EnUs))),
            other => panic!("{raw:?} -> {other:?}"),
        }
    }

    #[test]
    fn numbers_groups_and_truncation() {
        assert_eq!(n("1,234"), (1234.0, Some("#,##0")));
        assert_eq!(n("1,234."), (1234.0, Some("#,##0.00")));
        assert_eq!(n(" 12"), (12.0, None));
        assert_eq!(n("(123)"), (-123.0, None));
        assert_eq!(n("- 5"), (-5.0, None));
        assert_eq!(n("9999999999999999"), (9999999999999990.0, None));
        assert_eq!(n("-0").0.to_bits(), 0.0f64.to_bits());
        assert!(matches!(
            parse_entry("12,34", &en()).value,
            CellValue::Text(_)
        ));
    }

    #[test]
    fn percent_currency_scientific() {
        assert_eq!(n("12.345%"), (0.12345, Some("0.00%")));
        assert_eq!(n("%45"), (0.45, Some("0%")));
        assert_eq!(n("$(5)"), (-5.0, Some(USD_WHOLE)));
        assert_eq!(n("1.5e3%"), (15.0, Some("0.00E+00")));
        let e = parse_entry("1E308", &en());
        assert_eq!(e.value, CellValue::Text("1E308".into()));
        assert_eq!(e.hint, Some(FormatHint::Scientific));
    }

    #[test]
    fn dates_and_times() {
        assert_eq!(n("1/2"), (46024.0, Some("d-mmm")));
        assert_eq!(n("1/0"), (36526.0, Some("mmm-yy")));
        assert_eq!(n("Jan-24"), (46046.0, Some("d-mmm")));
        assert_eq!(n("2/29/1900"), (60.0, Some("m/d/yy")));
        assert_eq!(n("9:30 PM").1, Some("h:mm AM/PM"));
        assert_eq!(n("9:75").1, None);
        assert_eq!(n("25:30").1, Some("[h]:mm:ss"));
        assert!(matches!(
            parse_entry("9:30PM", &en()).value,
            CellValue::Text(_)
        ));
        assert!(matches!(
            parse_entry("January 15 2024", &en()).value,
            CellValue::Text(_)
        ));
    }

    #[test]
    fn resolve_format_follows_the_category_rule() {
        let pct = FormatHint::Percent { decimals: false };
        assert_eq!(resolve_format("General", pct, Locale::EnUs), Some("0%"));
        assert_eq!(resolve_format("h:mm", pct, Locale::EnUs), Some("0%"));
        assert_eq!(resolve_format("0.00%", pct, Locale::EnUs), None);
        assert_eq!(resolve_format("0.00", pct, Locale::EnUs), None);
        let th = FormatHint::Thousands { decimals: false };
        assert_eq!(resolve_format("0%", th, Locale::EnUs), None);
    }

    #[test]
    fn quote_and_text_format() {
        let e = parse_entry("'123", &en());
        assert_eq!(e.value, CellValue::Text("123".into()));
        assert!(e.quote_prefix);
        let e = parse_entry_for_format("1/2", "@", &en());
        assert_eq!(e.value, CellValue::Text("1/2".into()));
        assert!(needs_quote("45%", &en()));
        assert!(!needs_quote("abc", &en()));
    }
}
