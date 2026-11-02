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

//! # The theme, once (engine ADR 1056)
//!
//! A Word, Excel or PowerPoint theme part is one `a:theme`; `paged_ooxml`
//! reads it once ([`paged_ooxml::drawingml::theme::Theme`]) and this module
//! is the one lowering of it onto the engine's model, for slide, doc and
//! sheet:
//!
//! - [`engine_theme`]: the part as `Document.theme` (twelve slots with the
//!   system colour names of `dk1` / `lt1`, both font sets with their
//!   scripts, the part itself as `source`, not edited);
//! - [`ThemeWire`]: the same theme as a module's lowered IR carries it to
//!   its host, which sends it as `setTheme` (the wire form of
//!   `paged_mutate::ThemeSpec`);
//! - the swatch convention: a theme-coloured fill or text takes a swatch
//!   that *follows* its slot ([`paged_model::ThemeRef`]: slot plus the
//!   DrawingML transforms after it), so a `setTheme` or `setThemeColor`
//!   recolours it in the same undo step. [`follow`] gives the reference
//!   only when the theme resolves it to the colour the document shows
//!   (following it then changes nothing today), [`lum_transforms`] spells a
//!   luminance tint or shade (Word's `themeTint` / `themeShade`, Excel's
//!   `tint`) as the `lumMod` / `lumOff` pair that computes it.
//!
//! A swatch's id and name stay the module's own (slide's `Color/accent1
//! lumMod60000`, Word's `Color/docx-theme-accent1-tint-99`): they are
//! identities its save path parses; the reference is what the engine reads.

use paged_model::{SourceBlob, Theme, ThemeColor, ThemeFonts, THEME_SOURCE_OOXML};
pub use paged_model::{Theme as EngineTheme, ThemeRef};
use paged_ooxml::drawingml::theme::Theme as Ooxml;
use paged_ooxml::drawingml::{color_in, ColorBase, FontSet};
use paged_ooxml::tree::{self, Ns};
use serde::{Deserialize, Serialize};

/// The theme part `bytes` as the engine's theme. `None` when the bytes are
/// not a theme part. The part is kept as `source` when it is UTF-8 text.
pub fn engine_theme(bytes: &[u8]) -> Option<Theme> {
    let t = Ooxml::parse(bytes)?;
    // `dk1` and `lt1` are system colours in Office's themes; the reader
    // resolves them to their last value, so ask the tree for the name.
    let root = tree::parse(bytes).ok();
    let system = |slot: &str| -> Option<String> {
        let scheme = root
            .as_ref()?
            .child(Ns::A, "themeElements")?
            .child(Ns::A, "clrScheme")?;
        match color_in(scheme.child(Ns::A, slot)?)?.base {
            ColorBase::System { name, .. } => Some(name),
            _ => None,
        }
    };
    let fonts = |f: &FontSet| ThemeFonts {
        latin: f.latin.clone(),
        east_asian: f.east_asian.clone(),
        complex: f.complex.clone(),
        scripts: f.scripts.clone(),
    };
    Some(Theme {
        name: t.name.clone().unwrap_or_default(),
        color_scheme_name: t.color_scheme_name.clone(),
        colors: t
            .colors
            .iter()
            .map(|(slot, _)| ThemeColor {
                slot: slot.clone(),
                value: t.hex(slot).unwrap_or_default(),
                system: system(slot),
            })
            .collect(),
        font_scheme_name: t.font_scheme_name.clone(),
        major: fonts(&t.major_font),
        minor: fonts(&t.minor_font),
        source: std::str::from_utf8(bytes).ok().map(|x| SourceBlob {
            format: THEME_SOURCE_OOXML.into(),
            data: x.to_string(),
        }),
        edited: false,
    })
}

/// A face a theme font set gives one script (the wire form).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScriptFontWire {
    pub script: String,
    pub typeface: String,
}

/// One half of a font scheme (the wire form).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeFontsWire {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latin: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub east_asian: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub complex: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub scripts: Vec<ScriptFontWire>,
}

/// One colour slot (the wire form).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeColorWire {
    pub slot: String,
    pub value: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system: Option<String>,
}

/// A theme as a lowered IR carries it: the argument of the engine's
/// `setTheme` (`paged_mutate::ThemeSpec`), `source` included, so the host
/// sends it unchanged and the part stays unedited.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeWire {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color_scheme_name: Option<String>,
    pub colors: Vec<ThemeColorWire>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font_scheme_name: Option<String>,
    pub major: ThemeFontsWire,
    pub minor: ThemeFontsWire,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

impl ThemeWire {
    /// The wire form of a theme part, `None` when it is no theme.
    pub fn of_part(bytes: &[u8]) -> Option<ThemeWire> {
        engine_theme(bytes).map(|t| ThemeWire::of(&t))
    }

    /// The wire form of an engine theme.
    pub fn of(t: &Theme) -> ThemeWire {
        let fonts = |f: &ThemeFonts| ThemeFontsWire {
            latin: f.latin.clone(),
            east_asian: f.east_asian.clone(),
            complex: f.complex.clone(),
            scripts: f
                .scripts
                .iter()
                .map(|(script, typeface)| ScriptFontWire {
                    script: script.clone(),
                    typeface: typeface.clone(),
                })
                .collect(),
        };
        ThemeWire {
            name: t.name.clone(),
            color_scheme_name: t.color_scheme_name.clone(),
            colors: t
                .colors
                .iter()
                .map(|c| ThemeColorWire {
                    slot: c.slot.clone(),
                    value: c.value.clone(),
                    system: c.system.clone(),
                })
                .collect(),
            font_scheme_name: t.font_scheme_name.clone(),
            major: fonts(&t.major),
            minor: fonts(&t.minor),
            source: t.source.as_ref().map(|s| s.data.clone()),
        }
    }
}

/// The reference `slot` + `transforms` stands for, when `theme` resolves it
/// to `value` (RGB on 0 to 255, as a swatch holds it): following the slot
/// then changes nothing today. `None` otherwise (a slot the theme lacks, a
/// colour the transforms compute differently), and the swatch stays literal.
pub fn follow(theme: &Theme, r: ThemeRef, value: &[f32]) -> Option<ThemeRef> {
    let rgb = theme.resolve(&r)?;
    let want: Vec<f32> = rgb.iter().map(|b| *b as f32).collect();
    (value == want.as_slice()).then_some(r)
}

/// The DrawingML transforms of a luminance step in HSL: the colour's
/// luminance times `mul` plus `add` (both in 0..=1 of the range) as `lumMod`
/// and `lumOff`, in 1/100000. A step of `mul` 1 and `add` 0 is no transform.
/// Word's `themeTint t` is `(t, 1 - t)`, `themeShade s` is `(s, 0)`; Excel's
/// `tint < 0` is `(1 + tint, 0)` and `tint > 0` is `(1 - tint, tint)`.
pub fn lum_transforms(mul: f64, add: f64) -> Vec<(String, i32)> {
    let q = |v: f64| (v * 100_000.0).round() as i32;
    let mut out = Vec::new();
    if q(mul) != 100_000 {
        out.push(("lumMod".to_string(), q(mul)));
    }
    if q(add) != 0 {
        out.push(("lumOff".to_string(), q(add)));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const PART: &str = r#"<?xml version="1.0"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="T"><a:themeElements><a:clrScheme name="C">
<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>
<a:dk2><a:srgbClr val="1F497D"/></a:dk2><a:lt2><a:srgbClr val="EEECE1"/></a:lt2>
<a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2>
<a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4>
<a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6>
<a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink>
</a:clrScheme><a:fontScheme name="F"><a:majorFont><a:latin typeface="Calibri Light"/><a:font script="Jpan" typeface="Yu Gothic"/></a:majorFont>
<a:minorFont><a:latin typeface="Calibri"/></a:minorFont></a:fontScheme></a:themeElements></a:theme>"#;

    #[test]
    fn the_part_becomes_the_engine_theme_unedited_with_its_source() {
        let t = engine_theme(PART.as_bytes()).unwrap();
        assert_eq!(t.name, "T");
        assert_eq!(t.colors.len(), 12);
        assert_eq!(t.colors[0].system.as_deref(), Some("windowText"));
        assert_eq!(t.colors[2].system, None);
        assert_eq!(t.major.scripts, [("Jpan".into(), "Yu Gothic".into())]);
        assert!(!t.edited);
        assert_eq!(t.source.as_ref().unwrap().data, PART);
        assert!(engine_theme(b"not xml").is_none());
    }

    #[test]
    fn the_wire_form_is_the_set_theme_argument() {
        let w = ThemeWire::of_part(PART.as_bytes()).unwrap();
        let j = serde_json::to_value(&w).unwrap();
        assert_eq!(j["colorSchemeName"], "C");
        assert_eq!(j["colors"][0]["system"], "windowText");
        assert_eq!(j["major"]["scripts"][0]["typeface"], "Yu Gothic");
        assert_eq!(j["source"], PART);
        assert!(j["minor"].get("scripts").is_none());
    }

    #[test]
    fn a_reference_is_followed_only_where_the_theme_gives_the_shown_colour() {
        let t = engine_theme(PART.as_bytes()).unwrap();
        let plain = ThemeRef {
            slot: "accent1".into(),
            transforms: vec![],
        };
        assert!(follow(&t, plain.clone(), &[68.0, 114.0, 196.0]).is_some());
        assert!(follow(&t, plain, &[68.0, 114.0, 197.0]).is_none());
        let missing = ThemeRef {
            slot: "accent1".into(),
            transforms: vec![("lumMod".into(), 50_000)],
        };
        assert!(follow(&Theme::default(), missing, &[0.0; 3]).is_none());
    }

    #[test]
    fn a_luminance_step_is_lum_mod_and_lum_off() {
        assert_eq!(lum_transforms(1.0, 0.0), []);
        // Word themeShade BF.
        assert_eq!(
            lum_transforms(0xBF as f64 / 255.0, 0.0),
            [("lumMod".to_string(), 74_902)]
        );
        // Excel tint 0.4.
        assert_eq!(
            lum_transforms(0.6, 0.4),
            [
                ("lumMod".to_string(), 60_000),
                ("lumOff".to_string(), 40_000)
            ]
        );
    }
}
