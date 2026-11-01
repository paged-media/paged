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
}

impl Theme {
    /// The slot's colour.
    pub fn color(&self, slot: &str) -> Option<&ThemeColor> {
        self.colors.iter().find(|c| c.slot == slot)
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
        }
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
    fn the_slot_order_is_the_schemes() {
        assert_eq!(THEME_SLOTS[0], "dk1");
        assert_eq!(THEME_SLOTS[4], "accent1");
        assert_eq!(THEME_SLOTS[11], "folHlink");
    }
}
