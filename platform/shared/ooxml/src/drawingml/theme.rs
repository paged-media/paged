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

//! # The DrawingML theme — one reader for doc, slide and sheet
//!
//! A theme part (`/word/theme/theme1.xml`, `/ppt/theme/theme1.xml`,
//! `/xl/theme/theme1.xml`, a `.thmx`) is the same `a:theme` in all three
//! formats: a colour scheme of twelve slots, a font scheme with a major
//! (headings) and a minor (body) set, and a format scheme of fills, lines
//! and effects. The first two were read five times (doc, slide ×2, sheet);
//! this reads them once, over the element tree.
//!
//! The format scheme's fills, lines and effects stay with the reader that
//! needs them (slide), built on [`super::paint`] and [`super::effect`]; they
//! are looked up from the same [`El`] this module reads ([`Theme::from_el`]).
//!
//! A [`Theme`] is a [`SchemeColors`]: pass it to [`super::resolve`] to
//! resolve a colour whose base is a plain scheme slot (`accent1`, `dk2`).
//! The colour *map* (`tx1` → `dk1`, per master or document) is the caller's.

use super::color::{color_in, resolve, ColorBase, Rgba, SchemeColors};
use crate::tree::{self, El, Ns};

/// The twelve colour-scheme slots, in DrawingML (`a:clrScheme`) order.
pub const SLOTS: [&str; 12] = [
    "dk1", "lt1", "dk2", "lt2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6",
    "hlink", "folHlink",
];

/// The default Office theme (2013 and later: Word, Excel, PowerPoint) as
/// `0xRRGGBB`, in [`SLOTS`] order: what a reader falls back on for a package
/// without a theme part, and for a slot its theme part lacks.
pub const OFFICE: [u32; 12] = [
    0x000000, 0xFFFFFF, 0x44546A, 0xE7E6E6, 0x4472C4, 0xED7D31, 0xA5A5A5, 0xFFC000, 0x5B9BD5,
    0x70AD47, 0x0563C1, 0x954F72,
];

/// One half of a font scheme (`a:majorFont` or `a:minorFont`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct FontSet {
    /// `a:latin typeface`.
    #[cfg_attr(feature = "serde", serde(default))]
    pub latin: Option<String>,
    /// `a:ea typeface`.
    #[cfg_attr(feature = "serde", serde(default))]
    pub east_asian: Option<String>,
    /// `a:cs typeface`.
    #[cfg_attr(feature = "serde", serde(default))]
    pub complex: Option<String>,
    /// `a:font script typeface`: the face for a script (`Jpan`, `Hans`, …), in file order.
    #[cfg_attr(feature = "serde", serde(default))]
    pub scripts: Vec<(String, String)>,
}

/// A theme's colour and font schemes.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Theme {
    /// `a:theme name`.
    pub name: Option<String>,
    /// `a:clrScheme name`.
    pub color_scheme_name: Option<String>,
    /// The slots the scheme gives, by their DrawingML name ([`SLOTS`]), in scheme order.
    /// A slot with no usable colour is absent.
    pub colors: Vec<(String, Rgba)>,
    /// `a:fontScheme name`.
    pub font_scheme_name: Option<String>,
    pub major_font: FontSet,
    pub minor_font: FontSet,
}

impl Theme {
    /// Read a theme part. `None` when it is not XML or has no `a:themeElements`.
    pub fn parse(bytes: &[u8]) -> Option<Theme> {
        let root = tree::parse(bytes).ok()?;
        Self::from_el(&root)
    }

    /// Read an `a:theme` element. `None` without `a:themeElements`.
    pub fn from_el(theme: &El) -> Option<Theme> {
        let elements = theme.child(Ns::A, "themeElements")?;
        let scheme = elements.child(Ns::A, "clrScheme");
        let fonts = elements.child(Ns::A, "fontScheme");
        let colors = scheme
            .map(|s| {
                SLOTS
                    .iter()
                    .filter_map(|slot| Some((slot.to_string(), slot_color(s.child(Ns::A, slot)?)?)))
                    .collect()
            })
            .unwrap_or_default();
        let set = |name: &str| fonts.and_then(|f| f.child(Ns::A, name)).map(font_set);
        Some(Theme {
            name: theme.attr("name").map(str::to_string),
            color_scheme_name: scheme.and_then(|s| s.attr("name")).map(str::to_string),
            colors,
            font_scheme_name: fonts.and_then(|f| f.attr("name")).map(str::to_string),
            major_font: set("majorFont").unwrap_or_default(),
            minor_font: set("minorFont").unwrap_or_default(),
        })
    }

    /// The colour of slot `name` (`accent1`, `dk2`, …), if the scheme gives one.
    pub fn color(&self, name: &str) -> Option<Rgba> {
        self.colors.iter().find(|(k, _)| k == name).map(|(_, c)| *c)
    }

    /// The slot as `RRGGBB` (upper case, no `#`).
    pub fn hex(&self, name: &str) -> Option<String> {
        self.color(name).map(|c| format!("{:06X}", c.hex()))
    }
}

impl SchemeColors for Theme {
    fn scheme(&self, name: &str) -> Option<Rgba> {
        self.color(name)
    }
}

/// A slot's colour: its one child colour element, resolved. A `sysClr` with no
/// `lastClr` gives no colour (the system value is the viewer's, not the file's).
fn slot_color(slot: &El) -> Option<Rgba> {
    let c = color_in(slot)?;
    if matches!(c.base, ColorBase::System { last: None, .. }) {
        return None;
    }
    Some(resolve(&c, &()))
}

fn font_set(el: &El) -> FontSet {
    let face = |n: &str| {
        el.child(Ns::A, n)
            .and_then(|e| e.attr("typeface"))
            .filter(|t| !t.is_empty())
            .map(str::to_string)
    };
    FontSet {
        latin: face("latin"),
        east_asian: face("ea"),
        complex: face("cs"),
        scripts: el
            .children_named(Ns::A, "font")
            .filter_map(|f| {
                let (script, face) = (f.attr("script")?, f.attr("typeface")?);
                (!face.is_empty()).then(|| (script.to_string(), face.to_string()))
            })
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const THEME: &str = r#"<?xml version="1.0"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office"><a:themeElements><a:clrScheme name="Custom">
<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>
<a:dk2><a:srgbClr val="1f497d"/></a:dk2><a:lt2><a:srgbClr val="EEECE1"/></a:lt2>
<a:accent1><a:srgbClr val="4F81BD"/></a:accent1><a:accent2><a:srgbClr val="C0504D"/></a:accent2>
<a:accent3><a:srgbClr val="9BBB59"/></a:accent3><a:accent4><a:srgbClr val="8064A2"/></a:accent4>
<a:accent5><a:srgbClr val="4BACC6"/></a:accent5><a:accent6><a:srgbClr val="F79646"/></a:accent6>
<a:hlink><a:srgbClr val="0000FF"/></a:hlink><a:folHlink><a:srgbClr val="800080"/></a:folHlink>
</a:clrScheme><a:fontScheme name="Office"><a:majorFont><a:latin typeface="Cambria"/><a:ea typeface=""/><a:cs typeface="Arial"/>
<a:font script="Jpan" typeface="ＭＳ Ｐゴシック"/><a:font script="Hans" typeface="宋体"/></a:majorFont>
<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme></a:themeElements></a:theme>"#;

    #[test]
    fn reads_names_slots_and_fonts() {
        let t = Theme::parse(THEME.as_bytes()).unwrap();
        assert_eq!(t.name.as_deref(), Some("Office"));
        assert_eq!(t.color_scheme_name.as_deref(), Some("Custom"));
        assert_eq!(t.font_scheme_name.as_deref(), Some("Office"));
        assert_eq!(t.colors.len(), 12);
        assert_eq!(t.colors[0].0, "dk1"); // scheme order, not slot-name order
        assert_eq!(t.hex("dk1").as_deref(), Some("000000")); // sysClr lastClr
        assert_eq!(t.hex("lt1").as_deref(), Some("FFFFFF"));
        assert_eq!(t.hex("dk2").as_deref(), Some("1F497D")); // upper-cased
        assert_eq!(t.hex("folHlink").as_deref(), Some("800080"));
        assert_eq!(t.hex("accent7"), None);
        assert_eq!(t.major_font.latin.as_deref(), Some("Cambria"));
        assert_eq!(t.major_font.east_asian, None); // empty typeface is no face
        assert_eq!(t.major_font.complex.as_deref(), Some("Arial"));
        assert_eq!(t.major_font.scripts.len(), 2);
        assert_eq!(t.major_font.scripts[1], ("Hans".into(), "宋体".into()));
        assert_eq!(t.minor_font.latin.as_deref(), Some("Calibri"));
        assert!(t.minor_font.scripts.is_empty());
    }

    #[test]
    fn a_system_colour_without_last_value_gives_no_slot() {
        let xml = r#"<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:themeElements><a:clrScheme name="x"><a:dk1><a:sysClr val="windowText"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1></a:clrScheme></a:themeElements></a:theme>"#;
        let t = Theme::parse(xml.as_bytes()).unwrap();
        assert_eq!(t.colors.len(), 1);
        assert_eq!(t.hex("dk1"), None);
        assert_eq!(t.hex("lt1").as_deref(), Some("FFFFFF"));
    }

    #[test]
    fn a_theme_is_a_scheme_for_colour_resolution() {
        let t = Theme::parse(THEME.as_bytes()).unwrap();
        let accent = color_in(
            &tree::parse(
                br#"<a:solidFill xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:schemeClr val="accent1"/></a:solidFill>"#,
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(resolve(&accent, &t).hex(), 0x4F81BD);
        assert_eq!(resolve(&accent, &()).hex(), 0x000000); // no theme: black
    }

    #[test]
    fn not_a_theme_is_none() {
        assert!(Theme::parse(b"not xml").is_none());
        assert!(Theme::parse(
            br#"<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"/>"#
        )
        .is_none());
    }
}
