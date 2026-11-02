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

//! Engine ADR 1056 — the document's theme: twelve colour slots and a font
//! scheme, the same `a:theme` Word, PowerPoint and Excel carry.
//!
//! This is slice 1 of the model: the type, its `.paged` encoding and the
//! read-only `theme` view. Swatches do not reference slots yet and no
//! operation edits it; the original theme part rides along as a
//! [`SourceBlob`] so a writer can re-emit it untouched.

use serde::{Deserialize, Serialize};

use crate::SourceBlob;

/// The twelve colour slots, in DrawingML (`a:clrScheme`) order, as
/// PowerPoint, Word and Excel write them.
pub const THEME_SLOTS: [&str; 12] = [
    "dk1", "lt1", "dk2", "lt2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6",
    "hlink", "folHlink",
];

/// The `source.format` of a theme read from an OOXML package.
pub const THEME_SOURCE_OOXML: &str = "ooxml-theme";

/// A swatch that follows a theme slot (engine ADR 1056, slice 3): the slot
/// and the DrawingML transforms after it (`accent1` with `lumMod 60000`,
/// `lumOff 40000` is "Accent 1, Lighter 40%"). A theme change recolours
/// every swatch that carries one.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeRef {
    /// One of [`THEME_SLOTS`].
    pub slot: String,
    /// The transforms in document order (`lumMod`, `lumOff`, `tint`, …).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub transforms: Vec<(String, i32)>,
}

/// One colour slot of a theme.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeColor {
    /// One of [`THEME_SLOTS`].
    pub slot: String,
    /// The colour as `RRGGBB` (upper case, no `#`); a system colour by its
    /// last value.
    pub value: String,
    /// The system colour the slot names (`windowText`, `window`), when the
    /// file gave one: `dk1` and `lt1` are system colours in Office's themes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system: Option<String>,
}

impl ThemeColor {
    /// The colour as sRGB bytes; `None` when `value` is not six hex digits.
    pub fn rgb(&self) -> Option<[u8; 3]> {
        if self.value.len() != 6 {
            return None;
        }
        let v = u32::from_str_radix(&self.value, 16).ok()?;
        Some([(v >> 16) as u8, (v >> 8) as u8, v as u8])
    }
}

/// One half of a font scheme (`a:majorFont`, the headings; `a:minorFont`, the body).
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeFonts {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latin: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub east_asian: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub complex: Option<String>,
    /// The face for a script (`Jpan`, `Hans`, `Arab`, …), in file order.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub scripts: Vec<(String, String)>,
}

/// The document's theme.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Theme {
    /// `a:theme name` (`Office Theme`, `Facet`).
    pub name: String,
    /// `a:clrScheme name`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color_scheme_name: Option<String>,
    /// The slots the theme gives, in [`THEME_SLOTS`] order; a slot the file
    /// has no colour for is absent.
    pub colors: Vec<ThemeColor>,
    /// `a:fontScheme name`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font_scheme_name: Option<String>,
    /// The headings font set.
    #[serde(default)]
    pub major: ThemeFonts,
    /// The body font set.
    #[serde(default)]
    pub minor: ThemeFonts,
    /// The theme part as the file wrote it (`format` is
    /// [`THEME_SOURCE_OOXML`]); a writer re-emits it untouched until the
    /// theme is edited.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<SourceBlob>,
    /// Set by every theme operation: the model no longer matches `source`.
    /// A writer re-emits an unedited `source` byte for byte; an edited one
    /// it patches with the model's colour and font schemes (keeping the
    /// format scheme and everything else in the part), or renders from the
    /// model when there is no `source`.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub edited: bool,
}

impl Theme {
    /// The sRGB colour a swatch following `r` takes under this theme: the
    /// slot's colour with the transforms applied, as `paged-ooxml` resolves
    /// a scheme colour. `None` when the theme gives no such slot.
    pub fn resolve(&self, r: &ThemeRef) -> Option<[u8; 3]> {
        let base = paged_colour_math::Rgba::from_bytes(self.color(&r.slot)?.rgb()?);
        let mut c = base;
        for (name, val) in &r.transforms {
            c = paged_colour_math::transform(c, name, *val);
        }
        Some(
            paged_colour_math::Rgba {
                r: c.r.clamp(0.0, 1.0),
                g: c.g.clamp(0.0, 1.0),
                b: c.b.clamp(0.0, 1.0),
                a: c.a.clamp(0.0, 1.0),
            }
            .bytes(),
        )
    }

    /// The Latin face of the `major` or `minor` set a style follows.
    pub fn font_face(&self, r: ThemeFontRef) -> Option<&str> {
        match r {
            ThemeFontRef::Major => self.major.latin.as_deref(),
            ThemeFontRef::Minor => self.minor.latin.as_deref(),
        }
    }

    /// The slot's colour.
    pub fn color(&self, slot: &str) -> Option<&ThemeColor> {
        self.colors.iter().find(|c| c.slot == slot)
    }
}

/// Engine ADR 1057 — which half of the font scheme a style's face follows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ThemeFontRef {
    /// The headings set (`a:majorFont`).
    Major,
    /// The body set (`a:minorFont`).
    Minor,
}

impl ThemeFontRef {
    /// `major` or `minor`.
    pub fn parse(which: &str) -> Option<Self> {
        match which {
            "major" => Some(Self::Major),
            "minor" => Some(Self::Minor),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Major => "major",
            Self::Minor => "minor",
        }
    }
}

/// Engine ADR 1057 — the theme presets, defined once. Hosts read them (the
/// `themePresets` collection); applying one is `setTheme`.
pub mod presets {
    use super::{Theme, ThemeColor, ThemeFonts, THEME_SLOTS};

    /// The Office theme of Word, Excel and PowerPoint 2013 to 2022 as
    /// `0xRRGGBB`, in [`THEME_SLOTS`] order.
    pub const OFFICE_2013_RGB: [u32; 12] = [
        0x000000, 0xFFFFFF, 0x44546A, 0xE7E6E6, 0x4472C4, 0xED7D31, 0xA5A5A5, 0xFFC000, 0x5B9BD5,
        0x70AD47, 0x0563C1, 0x954F72,
    ];

    /// The Office theme of PowerPoint 2023 and later (the oracle recorded in
    /// ADR 1056) as `0xRRGGBB`, in [`THEME_SLOTS`] order.
    pub const OFFICE_2023_RGB: [u32; 12] = [
        0x000000, 0xFFFFFF, 0x0E2841, 0xE8E8E8, 0x156082, 0xE97132, 0x196B24, 0x0F9ED5, 0xA02B93,
        0x4EA72E, 0x467886, 0x96607D,
    ];

    fn build(name: &str, rgb: &[u32; 12], major: &str, minor: &str) -> Theme {
        let colors = THEME_SLOTS
            .iter()
            .zip(rgb)
            .enumerate()
            .map(|(i, (slot, v))| ThemeColor {
                slot: (*slot).to_string(),
                value: format!("{v:06X}"),
                system: match i {
                    0 => Some("windowText".to_string()),
                    1 => Some("window".to_string()),
                    _ => None,
                },
            })
            .collect();
        let fonts = |face: &str| ThemeFonts {
            latin: Some(face.to_string()),
            ..ThemeFonts::default()
        };
        Theme {
            name: name.to_string(),
            color_scheme_name: Some(name.to_string()),
            colors,
            font_scheme_name: Some(name.to_string()),
            major: fonts(major),
            minor: fonts(minor),
            source: None,
            edited: false,
        }
    }

    /// `Office 2013-2022`: Calibri Light and Calibri.
    pub fn office_2013() -> Theme {
        build(
            "Office 2013-2022",
            &OFFICE_2013_RGB,
            "Calibri Light",
            "Calibri",
        )
    }

    /// `Office 2023`: Aptos Display and Aptos.
    pub fn office_2023() -> Theme {
        build("Office 2023", &OFFICE_2023_RGB, "Aptos Display", "Aptos")
    }

    /// Every preset, with the id a host names it by.
    pub fn all() -> Vec<(&'static str, Theme)> {
        vec![
            ("office-2013", office_2013()),
            ("office-2023", office_2023()),
        ]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Theme {
        Theme {
            name: "Probe".into(),
            color_scheme_name: Some("Probe Colours".into()),
            colors: vec![
                ThemeColor {
                    slot: "dk1".into(),
                    value: "000000".into(),
                    system: Some("windowText".into()),
                },
                ThemeColor {
                    slot: "accent1".into(),
                    value: "FF0000".into(),
                    system: None,
                },
            ],
            font_scheme_name: Some("Probe Fonts".into()),
            major: ThemeFonts {
                latin: Some("Georgia".into()),
                scripts: vec![("Jpan".into(), "Yu Gothic".into())],
                ..ThemeFonts::default()
            },
            minor: ThemeFonts {
                latin: Some("Verdana".into()),
                ..ThemeFonts::default()
            },
            source: Some(SourceBlob {
                format: THEME_SOURCE_OOXML.into(),
                data: "<a:theme/>".into(),
            }),
            edited: true,
        }
    }

    #[test]
    fn presets_have_twelve_slots_and_system_dk1_lt1() {
        for (_, t) in presets::all() {
            assert_eq!(t.colors.len(), 12);
            assert_eq!(
                t.color("dk1").unwrap().system.as_deref(),
                Some("windowText")
            );
            assert!(t.major.latin.is_some() && t.minor.latin.is_some());
        }
        assert_eq!(
            presets::office_2013().color("accent1").unwrap().value,
            "4472C4"
        );
    }

    #[test]
    fn a_theme_round_trips_through_json() {
        let t = sample();
        let back: Theme = serde_json::from_str(&serde_json::to_string(&t).unwrap()).unwrap();
        assert_eq!(back, t);
    }

    #[test]
    fn a_slot_reads_as_srgb() {
        let t = sample();
        assert_eq!(t.color("accent1").unwrap().rgb(), Some([255, 0, 0]));
        assert!(t.color("accent2").is_none());
    }

    #[test]
    fn a_swatch_reference_resolves_with_its_transforms() {
        let t = sample();
        let plain = ThemeRef {
            slot: "accent1".into(),
            transforms: vec![],
        };
        assert_eq!(t.resolve(&plain), Some([255, 0, 0]));
        let lighter = ThemeRef {
            slot: "accent1".into(),
            transforms: vec![("lumMod".into(), 60_000), ("lumOff".into(), 40_000)],
        };
        assert_eq!(t.resolve(&lighter), Some([255, 102, 102]));
        assert_eq!(
            t.resolve(&ThemeRef {
                slot: "accent2".into(),
                transforms: vec![]
            }),
            None
        );
    }

    #[test]
    fn the_slot_order_is_the_schemes() {
        assert_eq!(THEME_SLOTS[0], "dk1");
        assert_eq!(THEME_SLOTS[4], "accent1");
        assert_eq!(THEME_SLOTS[11], "folHlink");
    }
}
