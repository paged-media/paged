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

//! Engine ADR 1022 — Word's fields.
//!
//! A Word field is a run of text whose content is the field's result, tagged
//! with its instruction ([`WordField::code`], Word's `w:instrText`) and the
//! kind the engine reads out of it ([`WordFieldKind`]). The kinds the engine
//! computes are the ones a Word document's structure leans on: the date and
//! time, the page count of the document and of the section, the page number,
//! a bookmark's text and page (`REF`, `PAGEREF`), numbered captions (`SEQ`)
//! and running heads (`STYLEREF`). Every other field is
//! [`WordFieldKind::Opaque`]: it shows the result it came with, and an
//! update leaves it alone.
//!
//! [`WordField::parse`] reads Word's instruction grammar: a field name, then
//! arguments (bare or in double quotes) and switches (`\h`, `\* roman`,
//! `\@ "d MMMM yyyy"`).

use serde::{Deserialize, Serialize};

use crate::NumberingStyle;

/// A Word field on a run ([`crate::CharacterRun::field`]).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WordField {
    /// The instruction as Word writes it (`PAGEREF _Ref123 \h`), trimmed.
    pub code: String,
    /// What the engine reads it as.
    pub kind: WordFieldKind,
    /// The `\*` number format (`roman`, `ROMAN`, `alphabetic`, `ALPHABETIC`,
    /// `Arabic`) of a numeric result; `None` is Arabic. `MERGEFORMAT` and
    /// `CHARFORMAT` are not number formats and are not kept here.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub number_format: Option<String>,
}

/// The kinds of Word field the engine computes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum WordFieldKind {
    /// `DATE` / `TIME` with its `\@` picture (`None`: Word's default,
    /// `M/d/yyyy` for a date, `h:mm am/pm` for a time). Updated from the
    /// clock the host passes; the engine reads no clock.
    Date {
        #[serde(default)]
        format: Option<String>,
        #[serde(default)]
        time: bool,
    },
    /// `NUMPAGES` — the document's page COUNT (not the last page's label).
    NumPages,
    /// `SECTIONPAGES` — the page count of the field's section.
    SectionPages,
    /// `PAGE` — the number of the page the field stands on.
    Page,
    /// `REF bookmark` — the bookmark's text (its paragraph's, from the
    /// bookmark on).
    Ref { bookmark: String },
    /// `PAGEREF bookmark` — the label of the page the bookmark stands on;
    /// with `\p` ("relative"), "above" or "below" when the bookmark is on
    /// the field's own page, else "on page N".
    PageRef {
        bookmark: String,
        #[serde(default)]
        relative: bool,
    },
    /// `SEQ identifier` — the item's number in its sequence, in document
    /// order; `\r n` resets it to `n`, `\c` repeats the previous number.
    Seq {
        identifier: String,
        #[serde(default)]
        reset: Option<u32>,
        #[serde(default)]
        repeat: bool,
    },
    /// `STYLEREF "style"` — the text of the paragraph in that style on the
    /// page (the first; the last with `\l`), carried from earlier pages
    /// when the page has none: a running head.
    StyleRef {
        style: String,
        #[serde(default)]
        last: bool,
    },
    /// Any other field: its result is the text it came with.
    Opaque,
}

impl WordField {
    /// Read a Word field instruction.
    pub fn parse(code: &str) -> WordField {
        let code = code.trim().to_string();
        let tokens = tokenize(&code);
        let name = tokens
            .first()
            .map(|t| t.text.to_ascii_uppercase())
            .unwrap_or_default();
        let args: Vec<&Token> = tokens.iter().skip(1).collect();
        // The first argument that is not a switch (nor a switch's value).
        let mut positional: Vec<&str> = Vec::new();
        let mut switches: Vec<(String, Option<String>)> = Vec::new();
        let mut i = 0;
        while i < args.len() {
            let t = args[i];
            if !t.quoted && t.text.starts_with('\\') {
                let sw = t.text[1..].to_string();
                // `\*`, `\@`, `\r`, `\s`, `\#` take a value.
                let takes_value = matches!(sw.as_str(), "*" | "@" | "#" | "r" | "s");
                let value = if takes_value && i + 1 < args.len() {
                    i += 1;
                    Some(args[i].text.clone())
                } else {
                    None
                };
                switches.push((sw, value));
            } else {
                positional.push(&t.text);
            }
            i += 1;
        }
        let has = |s: &str| switches.iter().any(|(k, _)| k == s);
        let value_of = |s: &str| {
            switches
                .iter()
                .find(|(k, _)| k == s)
                .and_then(|(_, v)| v.clone())
        };
        let number_format = switches
            .iter()
            .filter(|(k, _)| k == "*")
            .filter_map(|(_, v)| v.clone())
            .find(|v| {
                !matches!(
                    v.to_ascii_uppercase().as_str(),
                    "MERGEFORMAT" | "CHARFORMAT"
                )
            });
        let first = positional.first().map(|s| s.to_string());
        let kind = match name.as_str() {
            "DATE" => WordFieldKind::Date {
                format: value_of("@"),
                time: false,
            },
            "TIME" => WordFieldKind::Date {
                format: value_of("@"),
                time: true,
            },
            "NUMPAGES" => WordFieldKind::NumPages,
            "SECTIONPAGES" => WordFieldKind::SectionPages,
            "PAGE" => WordFieldKind::Page,
            "REF" => match first {
                Some(bookmark) => WordFieldKind::Ref { bookmark },
                None => WordFieldKind::Opaque,
            },
            "PAGEREF" => match first {
                Some(bookmark) => WordFieldKind::PageRef {
                    bookmark,
                    relative: has("p"),
                },
                None => WordFieldKind::Opaque,
            },
            "SEQ" => match first {
                Some(identifier) => WordFieldKind::Seq {
                    identifier,
                    reset: value_of("r").and_then(|v| v.parse().ok()),
                    repeat: has("c"),
                },
                None => WordFieldKind::Opaque,
            },
            "STYLEREF" => match first {
                Some(style) => WordFieldKind::StyleRef {
                    style,
                    last: has("l"),
                },
                None => WordFieldKind::Opaque,
            },
            _ => WordFieldKind::Opaque,
        };
        WordField {
            code,
            kind,
            number_format,
        }
    }

    /// Whether the field's result follows the layout at every build (the
    /// page-dependent kinds) rather than waiting for an update.
    pub fn is_live(&self) -> bool {
        matches!(
            self.kind,
            WordFieldKind::NumPages
                | WordFieldKind::SectionPages
                | WordFieldKind::Page
                | WordFieldKind::PageRef { .. }
                | WordFieldKind::StyleRef { .. }
        )
    }

    /// What "show field codes" sets in the field's place.
    pub fn code_display(&self) -> String {
        format!("{{ {} }}", self.code)
    }

    /// `n` in the field's `\*` number format.
    pub fn format_number(&self, n: u32) -> String {
        format_word_number(n, self.number_format.as_deref())
    }
}

/// `n` in a Word `\*` number format (`None`: Arabic).
pub fn format_word_number(n: u32, format: Option<&str>) -> String {
    let style = match format {
        Some("roman") => NumberingStyle::LowerRoman,
        Some("ROMAN") | Some("Roman") => NumberingStyle::UpperRoman,
        Some("alphabetic") => NumberingStyle::LowerAlpha,
        Some("ALPHABETIC") | Some("Alphabetic") => NumberingStyle::UpperAlpha,
        _ => NumberingStyle::Arabic,
    };
    style.format(n)
}

#[derive(Debug)]
struct Token {
    text: String,
    quoted: bool,
}

/// Split an instruction into words, double-quoted strings (quotes removed,
/// `\"` an escaped quote) and switches.
fn tokenize(code: &str) -> Vec<Token> {
    let mut out = Vec::new();
    let mut chars = code.chars().peekable();
    while let Some(&c) = chars.peek() {
        if c.is_whitespace() {
            chars.next();
            continue;
        }
        if c == '"' {
            chars.next();
            let mut text = String::new();
            while let Some(c) = chars.next() {
                match c {
                    '\\' if chars.peek() == Some(&'"') => {
                        text.push('"');
                        chars.next();
                    }
                    '"' => break,
                    c => text.push(c),
                }
            }
            out.push(Token { text, quoted: true });
            continue;
        }
        let mut text = String::new();
        while let Some(&c) = chars.peek() {
            if c.is_whitespace() || (c == '"' && !text.is_empty()) {
                break;
            }
            text.push(c);
            chars.next();
        }
        out.push(Token {
            text,
            quoted: false,
        });
    }
    out
}

/// A civil date and time, as a host passes "now" (`2026-10-25T14:05:09`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CivilDateTime {
    pub year: i32,
    pub month: u32,
    pub day: u32,
    pub hour: u32,
    pub minute: u32,
    pub second: u32,
}

impl CivilDateTime {
    /// Read `YYYY-MM-DD`, optionally followed by `THH:MM[:SS]` (anything
    /// after the seconds, such as a zone, is ignored). `None` when it does
    /// not read.
    pub fn parse(s: &str) -> Option<CivilDateTime> {
        let s = s.trim();
        let (date, time) = match s.split_once(['T', ' ']) {
            Some((d, t)) => (d, Some(t)),
            None => (s, None),
        };
        let mut d = date.split('-');
        let year: i32 = d.next()?.parse().ok()?;
        let month: u32 = d.next()?.parse().ok()?;
        let day: u32 = d.next()?.parse().ok()?;
        if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
            return None;
        }
        let (mut hour, mut minute, mut second) = (0, 0, 0);
        if let Some(t) = time {
            let t: String = t
                .chars()
                .take_while(|c| c.is_ascii_digit() || *c == ':')
                .collect();
            let mut p = t.split(':');
            hour = p.next().and_then(|v| v.parse().ok()).unwrap_or(0);
            minute = p.next().and_then(|v| v.parse().ok()).unwrap_or(0);
            second = p.next().and_then(|v| v.parse().ok()).unwrap_or(0);
        }
        Some(CivilDateTime {
            year,
            month,
            day,
            hour,
            minute,
            second,
        })
    }

    /// 0 = Sunday … 6 = Saturday.
    fn weekday(&self) -> u32 {
        // Days from 1970-01-01 (a Thursday), Howard Hinnant's algorithm.
        let y = if self.month <= 2 {
            self.year - 1
        } else {
            self.year
        };
        let era = if y >= 0 { y } else { y - 399 } / 400;
        let yoe = (y - era * 400) as i64;
        let m = self.month as i64;
        let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + self.day as i64 - 1;
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        let days = era as i64 * 146_097 + doe - 719_468;
        ((days + 4).rem_euclid(7)) as u32
    }
}

const MONTHS: [&str; 12] = [
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
];
const DAYS: [&str; 7] = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
];

/// Format `at` with a Word date-time picture (`\@`): `d` `dd` `ddd` `dddd`,
/// `M` `MM` `MMM` `MMMM`, `yy` `yyyy`, `h` `hh` (12-hour), `H` `HH`, `m`
/// `mm`, `s` `ss`, `AM/PM` `am/pm`, and `'literal'` text. Names are English
/// (Word writes them in the document's language; the engine has English).
/// `None`: Word's defaults, `M/d/yyyy` for a date and `h:mm am/pm` for a time.
pub fn format_word_date(picture: Option<&str>, at: &CivilDateTime, time: bool) -> String {
    let picture = picture.unwrap_or(if time { "h:mm am/pm" } else { "M/d/yyyy" });
    let chars: Vec<char> = picture.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    let run = |i: usize, c: char| chars[i..].iter().take_while(|&&x| x == c).count();
    while i < chars.len() {
        let c = chars[i];
        match c {
            '\'' => {
                i += 1;
                while i < chars.len() && chars[i] != '\'' {
                    out.push(chars[i]);
                    i += 1;
                }
                i += 1;
            }
            'd' => {
                let n = run(i, 'd');
                match n {
                    1 => out.push_str(&at.day.to_string()),
                    2 => out.push_str(&format!("{:02}", at.day)),
                    3 => out.push_str(&DAYS[at.weekday() as usize][..3]),
                    _ => out.push_str(DAYS[at.weekday() as usize]),
                }
                i += n;
            }
            'M' => {
                let n = run(i, 'M');
                let name = MONTHS[(at.month - 1) as usize];
                match n {
                    1 => out.push_str(&at.month.to_string()),
                    2 => out.push_str(&format!("{:02}", at.month)),
                    3 => out.push_str(&name[..3]),
                    _ => out.push_str(name),
                }
                i += n;
            }
            'y' | 'Y' => {
                let n = run(i, c);
                if n <= 2 {
                    out.push_str(&format!("{:02}", at.year.rem_euclid(100)));
                } else {
                    out.push_str(&at.year.to_string());
                }
                i += n;
            }
            'h' => {
                let n = run(i, 'h');
                let h12 = match at.hour % 12 {
                    0 => 12,
                    h => h,
                };
                out.push_str(&if n == 1 {
                    h12.to_string()
                } else {
                    format!("{h12:02}")
                });
                i += n;
            }
            'H' => {
                let n = run(i, 'H');
                out.push_str(&if n == 1 {
                    at.hour.to_string()
                } else {
                    format!("{:02}", at.hour)
                });
                i += n;
            }
            'm' => {
                let n = run(i, 'm');
                out.push_str(&if n == 1 {
                    at.minute.to_string()
                } else {
                    format!("{:02}", at.minute)
                });
                i += n;
            }
            's' => {
                let n = run(i, 's');
                out.push_str(&if n == 1 {
                    at.second.to_string()
                } else {
                    format!("{:02}", at.second)
                });
                i += n;
            }
            'A' | 'a' if chars[i..].len() >= 5 => {
                let word: String = chars[i..i + 5].iter().collect();
                if word.eq_ignore_ascii_case("am/pm") {
                    let pm = at.hour >= 12;
                    let s = if pm { "PM" } else { "AM" };
                    out.push_str(&if c == 'a' {
                        s.to_lowercase()
                    } else {
                        s.to_string()
                    });
                    i += 5;
                } else {
                    out.push(c);
                    i += 1;
                }
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_kinds_word_writes() {
        let f = WordField::parse(r#" PAGEREF _Ref12345 \h \p "#);
        assert_eq!(f.code, r"PAGEREF _Ref12345 \h \p");
        assert_eq!(
            f.kind,
            WordFieldKind::PageRef {
                bookmark: "_Ref12345".into(),
                relative: true
            }
        );
        assert_eq!(
            WordField::parse(r#"STYLEREF "Heading 1" \l"#).kind,
            WordFieldKind::StyleRef {
                style: "Heading 1".into(),
                last: true
            }
        );
        assert_eq!(
            WordField::parse(r#"DATE \@ "d MMMM yyyy""#).kind,
            WordFieldKind::Date {
                format: Some("d MMMM yyyy".into()),
                time: false
            }
        );
        let seq = WordField::parse(r"SEQ Figure \* ARABIC \r 3");
        assert_eq!(
            seq.kind,
            WordFieldKind::Seq {
                identifier: "Figure".into(),
                reset: Some(3),
                repeat: false
            }
        );
        assert_eq!(seq.number_format.as_deref(), Some("ARABIC"));
        let pages = WordField::parse(r"NUMPAGES \* roman \* MERGEFORMAT");
        assert_eq!(pages.kind, WordFieldKind::NumPages);
        assert_eq!(pages.format_number(4), "iv");
        assert_eq!(
            WordField::parse("REF bm1 \\h").kind,
            WordFieldKind::Ref {
                bookmark: "bm1".into()
            }
        );
        assert_eq!(
            WordField::parse(r#"HYPERLINK "x""#).kind,
            WordFieldKind::Opaque
        );
        assert_eq!(WordField::parse("PAGEREF").kind, WordFieldKind::Opaque);
        assert!(WordField::parse("SECTIONPAGES").is_live());
        assert!(!WordField::parse("SEQ Table").is_live());
    }

    #[test]
    fn formats_word_date_pictures() {
        let at = CivilDateTime::parse("2026-10-25T14:05:09Z").unwrap();
        assert_eq!(format_word_date(None, &at, false), "10/25/2026");
        assert_eq!(format_word_date(None, &at, true), "2:05 pm");
        assert_eq!(
            format_word_date(Some("dddd, d MMMM yyyy"), &at, false),
            "Sunday, 25 October 2026"
        );
        assert_eq!(
            format_word_date(Some("dd.MM.yy HH:mm:ss"), &at, false),
            "25.10.26 14:05:09"
        );
        assert_eq!(
            format_word_date(Some("'Week of' MMM d"), &at, false),
            "Week of Oct 25"
        );
        assert_eq!(format_word_date(Some("h AM/PM"), &at, true), "2 PM");
        assert!(CivilDateTime::parse("not a date").is_none());
    }
}
