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

//! The document theme (`word/theme/theme1.xml`) and the references a run,
//! a paragraph or a style makes to it (doc ADR 609).
//!
//! Word writes a theme colour as `w:color w:val="1F3864" w:themeColor="accent1"
//! w:themeShade="BF"`: the `val` is its cached rendering, the reference is
//! what counts. A theme font is `w:rFonts w:asciiTheme="minorHAnsi"`. The
//! import keeps the reference ([`ThemeColorRef`], `RunProps::font_theme`)
//! and resolves it to a concrete colour and family through [`Theme`], so the
//! lowering and the engine see concrete values while save-back can write
//! the reference again.

use serde::{Deserialize, Serialize};

/// A reference to a theme colour, as Word writes it on `w:color`, `w:shd`
/// or `w:u`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ThemeColorRef {
    /// `@w:themeColor` as written (`accent1`, `text1`, `hyperlink`, …).
    pub slot: String,
    /// `@w:themeTint`, the byte as written (`99`): the colour lightened
    /// toward white, keeping `tint / 255` of it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tint: Option<u8>,
    /// `@w:themeShade` (`BF`): the colour darkened toward black, keeping
    /// `shade / 255` of it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shade: Option<u8>,
}

impl ThemeColorRef {
    /// Word's attribute value for a tint or shade byte (two upper-case hex
    /// digits).
    pub fn hex_byte(v: u8) -> String {
        format!("{v:02X}")
    }

    /// Parse `@w:themeTint` / `@w:themeShade` (hex, `00`–`FF`).
    pub fn parse_byte(v: &str) -> Option<u8> {
        u8::from_str_radix(v.trim(), 16).ok()
    }
}

/// `w:shd`: a run's or a paragraph's shading. Only the fill is kept (the
/// pattern colour of a `clear` shading is unused); `None` for `auto`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Shading {
    /// `@w:fill` as `RRGGBB` (resolved from `theme_fill` when there is one).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fill: Option<String>,
    /// `@w:themeFill` with `@w:themeFillTint` / `@w:themeFillShade`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub theme_fill: Option<ThemeColorRef>,
}

/// A theme's font scheme half (`a:majorFont` or `a:minorFont`): its Latin,
/// East Asian and complex-script typefaces (`None` where the theme leaves
/// one empty).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ThemeFonts {
    pub latin: Option<String>,
    pub east_asia: Option<String>,
    pub complex_script: Option<String>,
}

/// The document theme: its colour scheme, its fonts, and `settings.xml`'s
/// `w:clrSchemeMapping` (which scheme slot `text1`, `background1`, … mean).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Theme {
    /// `a:theme/@name`.
    #[serde(default)]
    pub name: Option<String>,
    /// The colour scheme as `(slot, RRGGBB)` in scheme order, the slot by
    /// Word's name (`dark1`, `light1`, `dark2`, `light2`, `accent1`…`accent6`,
    /// `hyperlink`, `followedHyperlink`).
    pub colors: Vec<(String, String)>,
    pub major: ThemeFonts,
    pub minor: ThemeFonts,
    /// `w:clrSchemeMapping`, `(Word slot, scheme slot)`: `text1` → `dark1`
    /// and so on. Slots it leaves out take Word's default mapping
    /// ([`Theme::scheme_slot`]).
    #[serde(default)]
    pub mapping: Vec<(String, String)>,
}

/// The twelve scheme slots by Word's name, in scheme order, with their
/// `a:clrScheme` element name.
pub const SCHEME_SLOTS: [(&str, &str); 12] = [
    ("dark1", "dk1"),
    ("light1", "lt1"),
    ("dark2", "dk2"),
    ("light2", "lt2"),
    ("accent1", "accent1"),
    ("accent2", "accent2"),
    ("accent3", "accent3"),
    ("accent4", "accent4"),
    ("accent5", "accent5"),
    ("accent6", "accent6"),
    ("hyperlink", "hlink"),
    ("followedHyperlink", "folHlink"),
];

impl Theme {
    /// The scheme slot a Word theme-colour value names: the mapped slot for
    /// `text1` / `background1` / `text2` / `background2` (default `dark1`,
    /// `light1`, `dark2`, `light2`), and for the accents and hyperlinks
    /// when `w:clrSchemeMapping` remaps them; the value itself otherwise.
    pub fn scheme_slot<'a>(&'a self, word: &'a str) -> &'a str {
        if let Some((_, to)) = self.mapping.iter().find(|(from, _)| from == word) {
            return to;
        }
        match word {
            "text1" => "dark1",
            "background1" => "light1",
            "text2" => "dark2",
            "background2" => "light2",
            other => other,
        }
    }

    /// The scheme colour (`RRGGBB`) a Word theme-colour value names, before
    /// any tint or shade.
    pub fn base_color(&self, word: &str) -> Option<&str> {
        let slot = self.scheme_slot(word);
        self.colors
            .iter()
            .find(|(s, _)| s == slot)
            .map(|(_, c)| c.as_str())
    }

    /// The family a theme font value names (`minorHAnsi`, `majorEastAsia`,
    /// `minorBidi`, …).
    pub fn font(&self, slot: &str) -> Option<&str> {
        let half = if slot.starts_with("major") {
            &self.major
        } else if slot.starts_with("minor") {
            &self.minor
        } else {
            return None;
        };
        let face = if slot.ends_with("EastAsia") {
            &half.east_asia
        } else if slot.ends_with("Bidi") {
            &half.complex_script
        } else {
            &half.latin
        };
        face.as_deref().filter(|f| !f.is_empty())
    }
}

/// Word's display name for a theme colour value (`accent1` → `Accent 1`,
/// `followedHyperlink` → `Followed Hyperlink`, `text1` → `Text 1`).
pub fn theme_color_name(word: &str) -> String {
    let mut out = String::new();
    for (i, c) in word.chars().enumerate() {
        if i == 0 {
            out.extend(c.to_uppercase());
        } else if c.is_ascii_uppercase() || (c.is_ascii_digit() && !out.ends_with(' ')) {
            out.push(' ');
            out.push(c);
        } else {
            out.push(c);
        }
    }
    out
}

/// The colour a tint or shade makes of `rgb` (`RRGGBB`), as Word computes
/// it: the HSL luminance moves toward white (`tint`: `L·t + (1 − t)`) or
/// toward black (`shade`: `L·s`), `t` and `s` the byte over 255, hue and
/// saturation kept. `None` for a value that is not six hex digits.
pub fn tinted(rgb: &str, tint: Option<u8>, shade: Option<u8>) -> Option<String> {
    if rgb.len() != 6 || !rgb.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let ch = |i: usize| u8::from_str_radix(&rgb[i..i + 2], 16).unwrap_or(0) as f64 / 255.0;
    let (r, g, b) = (ch(0), ch(2), ch(4));
    if tint.is_none() && shade.is_none() {
        return Some(rgb.to_ascii_uppercase());
    }
    let (h, s, mut l) = rgb_to_hsl(r, g, b);
    if let Some(t) = tint {
        let t = t as f64 / 255.0;
        l = l * t + (1.0 - t);
    }
    if let Some(sh) = shade {
        l *= sh as f64 / 255.0;
    }
    let (r, g, b) = hsl_to_rgb(h, s, l.clamp(0.0, 1.0));
    let byte = |v: f64| (v * 255.0).round().clamp(0.0, 255.0) as u8;
    Some(format!("{:02X}{:02X}{:02X}", byte(r), byte(g), byte(b)))
}

fn rgb_to_hsl(r: f64, g: f64, b: f64) -> (f64, f64, f64) {
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let l = (max + min) / 2.0;
    if (max - min).abs() < 1e-12 {
        return (0.0, 0.0, l);
    }
    let d = max - min;
    let s = if l > 0.5 {
        d / (2.0 - max - min)
    } else {
        d / (max + min)
    };
    let h = if max == r {
        (g - b) / d + if g < b { 6.0 } else { 0.0 }
    } else if max == g {
        (b - r) / d + 2.0
    } else {
        (r - g) / d + 4.0
    };
    (h / 6.0, s, l)
}

fn hsl_to_rgb(h: f64, s: f64, l: f64) -> (f64, f64, f64) {
    if s <= 0.0 {
        return (l, l, l);
    }
    let q = if l < 0.5 {
        l * (1.0 + s)
    } else {
        l + s - l * s
    };
    let p = 2.0 * l - q;
    let hue = |mut t: f64| {
        if t < 0.0 {
            t += 1.0;
        }
        if t > 1.0 {
            t -= 1.0;
        }
        if t < 1.0 / 6.0 {
            p + (q - p) * 6.0 * t
        } else if t < 0.5 {
            q
        } else if t < 2.0 / 3.0 {
            p + (q - p) * (2.0 / 3.0 - t) * 6.0
        } else {
            p
        }
    };
    (hue(h + 1.0 / 3.0), hue(h), hue(h - 1.0 / 3.0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn word_names_its_theme_colours() {
        assert_eq!(theme_color_name("accent1"), "Accent 1");
        assert_eq!(theme_color_name("followedHyperlink"), "Followed Hyperlink");
        assert_eq!(theme_color_name("text2"), "Text 2");
        assert_eq!(theme_color_name("dark1"), "Dark 1");
    }

    #[test]
    fn tints_and_shades_move_the_luminance() {
        // Office 2013 Accent 1 (4472C4): Word caches "Darker 25%"
        // (themeShade BF) as 2F5496, exactly this; "Lighter 40%" (themeTint
        // 99) as 8EAADB, one step from this formula's 8FAADC in each channel.
        assert_eq!(
            tinted("4472C4", Some(0x99), None).as_deref(),
            Some("8FAADC")
        );
        assert_eq!(
            tinted("4472C4", None, Some(0xBF)).as_deref(),
            Some("2F5496")
        );
        assert_eq!(tinted("4472C4", None, None).as_deref(), Some("4472C4"));
        assert_eq!(tinted("auto", None, None), None);
    }

    #[test]
    fn the_mapping_names_text_and_background() {
        let theme = Theme {
            colors: vec![
                ("dark1".into(), "000000".into()),
                ("light1".into(), "FFFFFF".into()),
            ],
            ..Default::default()
        };
        assert_eq!(theme.base_color("text1"), Some("000000"));
        assert_eq!(theme.base_color("background1"), Some("FFFFFF"));
        let swapped = Theme {
            mapping: vec![("text1".into(), "light1".into())],
            ..theme
        };
        assert_eq!(swapped.base_color("text1"), Some("FFFFFF"));
    }
}
