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

//! Engine ADR 1051 — a paragraph's base direction and a run's script slots.
//!
//! A paragraph sets its text left to right, right to left, or from its first
//! strong character ([`ParagraphDirection`]). In a right-to-left paragraph the
//! alignment, the indents, the tab ruler and the list marker are logical: the
//! start edge is the right one.
//!
//! A run names up to three faces, as Word's `w:rFonts` does: its own
//! ([`crate::CharacterRun::font`], Word's `ascii`/`hAnsi`), one for East Asian
//! text and one for complex-script text ([`ScriptProperties`]). Which one a
//! character takes is decided by its script ([`ScriptClass::of`]), the run's
//! direction and the run's hint ([`FontHint`]). An unset slot falls back to the
//! run's own font, so a document that never sets one draws exactly as before.

use serde::{Deserialize, Serialize};

/// A paragraph's base direction (Word's `w:bidi`, IDML's
/// `ParagraphDirection`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ParagraphDirection {
    /// Left to right.
    LeftToRight,
    /// Right to left: the start edge is the right one.
    RightToLeft,
    /// From the paragraph's first strong character (UAX #9 P2/P3); left to
    /// right when it has none.
    Auto,
}

impl ParagraphDirection {
    /// IDML's spelling (`LeftToRightDirection`, `RightToLeftDirection`).
    /// InDesign has no automatic direction; `Auto` is written as left to
    /// right.
    pub fn from_idml(s: &str) -> Option<Self> {
        match s {
            "LeftToRightDirection" => Some(Self::LeftToRight),
            "RightToLeftDirection" => Some(Self::RightToLeft),
            _ => None,
        }
    }

    /// IDML's spelling.
    pub fn as_idml(self) -> &'static str {
        match self {
            Self::RightToLeft => "RightToLeftDirection",
            Self::LeftToRight | Self::Auto => "LeftToRightDirection",
        }
    }

    /// The property path's spelling: `ltr`, `rtl`, `auto`.
    pub fn from_name(s: &str) -> Option<Self> {
        match s {
            "ltr" | "leftToRight" => Some(Self::LeftToRight),
            "rtl" | "rightToLeft" => Some(Self::RightToLeft),
            "auto" => Some(Self::Auto),
            _ => None,
        }
    }

    /// The property path's spelling.
    pub fn as_name(self) -> &'static str {
        match self {
            Self::LeftToRight => "ltr",
            Self::RightToLeft => "rtl",
            Self::Auto => "auto",
        }
    }

    /// The direction a paragraph of `text` is set in: `Auto` resolves to
    /// its first strong character's.
    pub fn resolve(self, text: &str) -> ResolvedDirection {
        match self {
            Self::LeftToRight => ResolvedDirection::LeftToRight,
            Self::RightToLeft => ResolvedDirection::RightToLeft,
            Self::Auto => first_strong(text).unwrap_or(ResolvedDirection::LeftToRight),
        }
    }
}

/// A paragraph direction once `Auto` is resolved.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResolvedDirection {
    LeftToRight,
    RightToLeft,
}

/// The direction of the first strong character of `text`, if any. Strong
/// right-to-left: Hebrew, Arabic, Syriac, Thaana, NKo, Samaritan, Mandaic and
/// their presentation forms; strong left-to-right: a letter of any other
/// script.
pub fn first_strong(text: &str) -> Option<ResolvedDirection> {
    text.chars().find_map(|c| {
        if is_strong_rtl(c) {
            Some(ResolvedDirection::RightToLeft)
        } else if c.is_alphabetic() {
            Some(ResolvedDirection::LeftToRight)
        } else {
            None
        }
    })
}

/// A strong right-to-left character (the ranges of UAX #9's R and AL
/// classes the engine meets).
pub fn is_strong_rtl(c: char) -> bool {
    matches!(
        c as u32,
        0x0590..=0x08FF | 0xFB1D..=0xFDFF | 0xFE70..=0xFEFC | 0x10800..=0x10FFF | 0x1E800..=0x1EFFF
    ) && !c.is_ascii()
        && !matches!(c as u32, 0x0660..=0x0669 | 0x06F0..=0x06F9)
}

/// A run's direction (Word's `w:rtl`, IDML's `CharacterDirection`). It
/// embeds the run's weak and neutral characters (digits, punctuation,
/// spaces) at that direction, so `w:rtl` digits and punctuation inside a
/// left-to-right paragraph order as right-to-left text.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum CharacterDirection {
    LeftToRight,
    RightToLeft,
}

impl CharacterDirection {
    /// IDML's spelling; `DefaultDirection` is `None`.
    pub fn from_idml(s: &str) -> Option<Self> {
        match s {
            "LeftToRightDirection" => Some(Self::LeftToRight),
            "RightToLeftDirection" => Some(Self::RightToLeft),
            _ => None,
        }
    }

    /// IDML's spelling.
    pub fn as_idml(self) -> &'static str {
        match self {
            Self::LeftToRight => "LeftToRightDirection",
            Self::RightToLeft => "RightToLeftDirection",
        }
    }

    /// The property path's spelling: `ltr`, `rtl`.
    pub fn from_name(s: &str) -> Option<Self> {
        match s {
            "ltr" => Some(Self::LeftToRight),
            "rtl" => Some(Self::RightToLeft),
            _ => None,
        }
    }

    /// The property path's spelling.
    pub fn as_name(self) -> &'static str {
        match self {
            Self::LeftToRight => "ltr",
            Self::RightToLeft => "rtl",
        }
    }
}

/// Word's `w:rFonts/@w:hint`: which slot the characters Word counts as
/// shared between scripts take (`eastAsia` sends them to the East Asian
/// face; `cs` to the complex-script face).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum FontHint {
    Default,
    EastAsia,
    ComplexScript,
}

impl FontHint {
    /// Word's spelling (`default`, `eastAsia`, `cs`).
    pub fn from_name(s: &str) -> Option<Self> {
        match s {
            "default" => Some(Self::Default),
            "eastAsia" => Some(Self::EastAsia),
            "cs" => Some(Self::ComplexScript),
            _ => None,
        }
    }

    /// Word's spelling.
    pub fn as_name(self) -> &'static str {
        match self {
            Self::Default => "default",
            Self::EastAsia => "eastAsia",
            Self::ComplexScript => "cs",
        }
    }
}

/// Which of a run's faces a character is drawn in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ScriptClass {
    /// The run's own font (Word's `ascii` / `hAnsi`).
    Latin,
    /// Han, Kana, Hangul, Bopomofo, CJK punctuation and full-width forms.
    EastAsian,
    /// Arabic, Hebrew, Syriac, Thaana, Thai, Lao, the Indic scripts,
    /// Khmer, Myanmar, Tibetan and the other complex scripts.
    Complex,
    /// A character that keeps the class of its neighbours: spaces,
    /// punctuation and symbols shared between scripts, combining marks.
    Neutral,
}

impl ScriptClass {
    /// The class of `c` on its own.
    pub fn of(c: char) -> ScriptClass {
        let u = c as u32;
        match u {
            // Combining marks attach to their base.
            0x0300..=0x036F | 0x200C | 0x200D | 0xFE00..=0xFE0F => ScriptClass::Neutral,
            // Hebrew, Arabic, Syriac, Arabic supplement, Thaana, NKo,
            // Samaritan, Mandaic, Syriac supplement, Arabic extended.
            0x0590..=0x08FF => ScriptClass::Complex,
            // Devanagari … Malayalam, Sinhala, Thai, Lao, Tibetan, Myanmar.
            0x0900..=0x109F => ScriptClass::Complex,
            // Hangul Jamo.
            0x1100..=0x11FF => ScriptClass::EastAsian,
            // Khmer, Mongolian, Tai Le, New Tai Lue, Khmer symbols, Buginese,
            // Tai Tham, Balinese, Sundanese, Batak, Lepcha.
            0x1780..=0x18AF | 0x1950..=0x19FF | 0x1A00..=0x1AAF | 0x1B00..=0x1C4F => {
                ScriptClass::Complex
            }
            // CJK radicals, Kangxi, ideographic description, CJK symbols
            // and punctuation, Hiragana, Katakana, Bopomofo, Hangul
            // compatibility Jamo, Kanbun, CJK strokes, Katakana extension,
            // enclosed CJK, CJK compatibility, CJK extension A, Yijing
            // (shared, left neutral), unified ideographs, Yi.
            0x2E80..=0x2FDF | 0x2FF0..=0x31FF | 0x3200..=0x4DBF | 0x4E00..=0x9FFF => {
                ScriptClass::EastAsian
            }
            0xA000..=0xA4CF => ScriptClass::EastAsian,
            // Devanagari extended, Javanese, Myanmar extended, Cham, Tai Viet,
            // Meetei Mayek.
            0xA8E0..=0xA8FF | 0xA980..=0xAADF | 0xABC0..=0xABFF => ScriptClass::Complex,
            // Hangul syllables and Jamo extended B.
            0xAC00..=0xD7FF => ScriptClass::EastAsian,
            // CJK compatibility ideographs.
            0xF900..=0xFAFF => ScriptClass::EastAsian,
            // Hebrew and Arabic presentation forms.
            0xFB1D..=0xFDFF | 0xFE70..=0xFEFF => ScriptClass::Complex,
            // Vertical forms, CJK compatibility forms, small form variants.
            0xFE10..=0xFE1F | 0xFE30..=0xFE6F => ScriptClass::EastAsian,
            // Half-width and full-width forms.
            0xFF00..=0xFFEF => ScriptClass::EastAsian,
            // Kana supplement, CJK extensions B–H.
            0x1B000..=0x1B16F | 0x20000..=0x3FFFF => ScriptClass::EastAsian,
            _ => {
                if c.is_alphanumeric() {
                    ScriptClass::Latin
                } else {
                    ScriptClass::Neutral
                }
            }
        }
    }
}

/// A run's script slots and direction (engine ADR 1051): the faces Word's
/// `w:rFonts` names besides the run's own, the complex-script size and
/// weight (`w:szCs`, `w:bCs`, `w:iCs`), the run's direction (`w:rtl`),
/// whether the run is complex script as a whole (`w:cs`) and the font hint.
/// Every field `None` inherits through the style cascade; skipped when
/// unset, so a document without them serialises and hashes as before.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ScriptProperties {
    /// The run's direction.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub direction: Option<CharacterDirection>,
    /// The face of the run's East Asian characters (`w:rFonts/@w:eastAsia`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub east_asian_font: Option<String>,
    /// The face of the run's complex-script characters (`w:rFonts/@w:cs`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub complex_font: Option<String>,
    /// The size of the complex-script characters in pt (`w:szCs`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub complex_point_size: Option<f32>,
    /// Bold for the complex-script characters (`w:bCs`); unset takes the
    /// run's own style.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub complex_bold: Option<bool>,
    /// Italic for the complex-script characters (`w:iCs`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub complex_italic: Option<bool>,
    /// The whole run is complex script (`w:cs`): every character takes the
    /// complex-script slot.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub complex: Option<bool>,
    /// Which slot the shared characters take.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hint: Option<FontHint>,
}

impl ScriptProperties {
    /// True when no field is set.
    pub fn is_unset(&self) -> bool {
        *self == Self::default()
    }

    /// Fill every unset field from the level below.
    pub fn fill_from(&mut self, below: &ScriptProperties) {
        self.direction = self.direction.or(below.direction);
        if self.east_asian_font.is_none() {
            self.east_asian_font.clone_from(&below.east_asian_font);
        }
        if self.complex_font.is_none() {
            self.complex_font.clone_from(&below.complex_font);
        }
        self.complex_point_size = self.complex_point_size.or(below.complex_point_size);
        self.complex_bold = self.complex_bold.or(below.complex_bold);
        self.complex_italic = self.complex_italic.or(below.complex_italic);
        self.complex = self.complex.or(below.complex);
        self.hint = self.hint.or(below.hint);
    }

    /// Whether a run with these slots can draw any character in a face
    /// other than its own: a slot names a font, or the complex-script
    /// size or weight differs.
    pub fn splits_runs(&self) -> bool {
        self.east_asian_font.is_some()
            || self.complex_font.is_some()
            || self.complex_point_size.is_some()
            || self.complex_bold.is_some()
            || self.complex_italic.is_some()
    }

    /// The slot each character of `text` takes, by Word's rules: a
    /// right-to-left or `w:cs` run is complex script throughout; otherwise
    /// a character's own script decides, and a neutral one follows the
    /// character before it (the first ones the character after them) —
    /// except that the hint sends a shared character that is not ASCII to
    /// its slot. Returns `(byte offset, class)` at every change, starting
    /// at 0; empty for empty text. Never [`ScriptClass::Neutral`].
    pub fn segments(&self, text: &str) -> Vec<(usize, ScriptClass)> {
        if text.is_empty() {
            return Vec::new();
        }
        if self.complex == Some(true) || self.direction == Some(CharacterDirection::RightToLeft) {
            return vec![(0, ScriptClass::Complex)];
        }
        let hinted = match self.hint {
            Some(FontHint::EastAsia) => Some(ScriptClass::EastAsian),
            Some(FontHint::ComplexScript) => Some(ScriptClass::Complex),
            _ => None,
        };
        let classes: Vec<(usize, ScriptClass)> = text
            .char_indices()
            .map(|(i, c)| {
                let own = ScriptClass::of(c);
                let class = match (own, hinted) {
                    (ScriptClass::Neutral, Some(h)) if !c.is_ascii() => h,
                    (ScriptClass::Latin, Some(h))
                        if !c.is_ascii() && h == ScriptClass::EastAsian =>
                    {
                        // Word's eastAsia hint takes the Latin-1 and general
                        // punctuation letters shared with CJK fonts.
                        h
                    }
                    _ => own,
                };
                (i, class)
            })
            .collect();
        let first_strong = classes
            .iter()
            .map(|(_, c)| *c)
            .find(|c| *c != ScriptClass::Neutral)
            .unwrap_or(ScriptClass::Latin);
        let mut out: Vec<(usize, ScriptClass)> = Vec::new();
        let mut current = first_strong;
        for (i, class) in classes {
            let class = if class == ScriptClass::Neutral {
                current
            } else {
                class
            };
            current = class;
            if out.last().map(|(_, c)| *c) != Some(class) {
                out.push((i, class));
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classes_and_segments() {
        assert_eq!(ScriptClass::of('a'), ScriptClass::Latin);
        assert_eq!(ScriptClass::of('日'), ScriptClass::EastAsian);
        assert_eq!(ScriptClass::of('か'), ScriptClass::EastAsian);
        assert_eq!(ScriptClass::of('한'), ScriptClass::EastAsian);
        assert_eq!(ScriptClass::of('ب'), ScriptClass::Complex);
        assert_eq!(ScriptClass::of('ש'), ScriptClass::Complex);
        assert_eq!(ScriptClass::of('ก'), ScriptClass::Complex);
        assert_eq!(ScriptClass::of(' '), ScriptClass::Neutral);
        let s = ScriptProperties::default();
        let text = "Hello 日本語 world";
        let seg = s.segments(text);
        assert_eq!(
            seg,
            vec![
                (0, ScriptClass::Latin),
                (6, ScriptClass::EastAsian),
                (16, ScriptClass::Latin)
            ]
        );
        // A right-to-left run is complex script throughout.
        let rtl = ScriptProperties {
            direction: Some(CharacterDirection::RightToLeft),
            ..Default::default()
        };
        assert_eq!(rtl.segments("abc 12"), vec![(0, ScriptClass::Complex)]);
        // The eastAsia hint takes shared non-ASCII punctuation.
        let hinted = ScriptProperties {
            hint: Some(FontHint::EastAsia),
            ..Default::default()
        };
        assert_eq!(
            hinted.segments("a\u{201C}b"),
            vec![
                (0, ScriptClass::Latin),
                (1, ScriptClass::EastAsian),
                (4, ScriptClass::Latin)
            ]
        );
    }

    #[test]
    fn direction_names_and_auto() {
        for d in [
            ParagraphDirection::LeftToRight,
            ParagraphDirection::RightToLeft,
            ParagraphDirection::Auto,
        ] {
            assert_eq!(ParagraphDirection::from_name(d.as_name()), Some(d));
        }
        assert_eq!(
            ParagraphDirection::Auto.resolve("123 שלום abc"),
            ResolvedDirection::RightToLeft
        );
        assert_eq!(
            ParagraphDirection::Auto.resolve("abc שלום"),
            ResolvedDirection::LeftToRight
        );
        assert_eq!(
            ParagraphDirection::from_idml("RightToLeftDirection"),
            Some(ParagraphDirection::RightToLeft)
        );
    }
}
