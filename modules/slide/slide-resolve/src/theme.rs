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

//! The live theme (slide ADR 713): theme colours as swatches the items
//! refer to, the theme as data, and the Design gallery.
//!
//! A colour that is a theme colour (`a:schemeClr`, through the colour map
//! and any `phClr`) is kept as a **key**: the theme slot it lands on and the
//! transforms that make it (`accent1 lumMod60000 lumOff40000`). The key is
//! the swatch's id (`Color/<key>`), so a swatch is the same colour of the
//! theme whatever the theme is; applying another theme recolours each
//! swatch by its key, and export writes the key back as `a:schemeClr`.

use paged_ooxml::colour::{hsl_to_rgb, rgb_to_hsl};
use paged_ooxml::drawingml::{self, Color, ColorBase, Rgba};
use pptx_core::{ColorMap, Theme};
use serde::{Deserialize, Serialize};

use crate::model::Rgb;

/// The twelve theme colour slots, in scheme order.
pub const SLOTS: [&str; 12] = [
    "dk1", "lt1", "dk2", "lt2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6",
    "hlink", "folHlink",
];

/// The slots PowerPoint's colour picker shows with tints (all but the
/// hyperlink colours).
pub const TINTED: [&str; 10] = [
    "dk1", "lt1", "dk2", "lt2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6",
];

/// The name the swatches panel shows for a slot.
pub fn slot_name(slot: &str) -> String {
    match slot {
        "dk1" => "Dark 1".into(),
        "lt1" => "Light 1".into(),
        "dk2" => "Dark 2".into(),
        "lt2" => "Light 2".into(),
        "hlink" => "Hyperlink".into(),
        "folHlink" => "Followed Hyperlink".into(),
        s if s.starts_with("accent") => format!("Accent {}", &s[6..]),
        s => s.to_string(),
    }
}

/// The swatch group the theme's swatches are members of.
pub const GROUP_ID: &str = "ColorGroup/Theme";
pub const GROUP_NAME: &str = "Theme";

/// A theme colour as a swatch key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Key {
    /// The theme, when it is not the deck's first (`theme2`).
    pub theme: Option<String>,
    /// One of [`SLOTS`].
    pub slot: String,
    /// The colour transforms after the slot, alpha left out.
    pub transforms: Vec<(String, i32)>,
}

/// A transform that moves the alpha only (kept as the item's opacity).
fn alpha_only(op: &str) -> bool {
    matches!(op, "alpha" | "alphaMod" | "alphaOff")
}

impl Key {
    /// A slot with no transform.
    pub fn slot(slot: &str) -> Key {
        Key {
            theme: None,
            slot: slot.to_string(),
            transforms: Vec::new(),
        }
    }

    /// Read a key's text (`theme2:accent1 lumMod60000 lumOff40000`).
    pub fn parse(text: &str) -> Option<Key> {
        let mut words = text.split(' ').filter(|w| !w.is_empty());
        let head = words.next()?;
        let (theme, slot) = match head.split_once(':') {
            Some((t, s)) if !t.is_empty() => (Some(t.to_string()), s),
            Some(_) => return None,
            None => (None, head),
        };
        if !SLOTS.contains(&slot) {
            return None;
        }
        let mut transforms = Vec::new();
        for w in words {
            let at = w.find(|c: char| c == '-' || c.is_ascii_digit())?;
            let (op, v) = w.split_at(at);
            if op.is_empty() || !op.chars().all(|c| c.is_ascii_alphabetic()) {
                return None;
            }
            transforms.push((op.to_string(), v.parse().ok()?));
        }
        Some(Key {
            theme,
            slot: slot.to_string(),
            transforms,
        })
    }

    /// The key of a swatch id (`Color/<key>`), if it is one.
    pub fn of_swatch(id: &str) -> Option<Key> {
        Key::parse(id.strip_prefix("Color/")?)
    }

    pub fn text(&self) -> String {
        let mut s = match &self.theme {
            Some(t) => format!("{t}:{}", self.slot),
            None => self.slot.clone(),
        };
        for (op, v) in &self.transforms {
            s.push_str(&format!(" {op}{v}"));
        }
        s
    }

    pub fn swatch_id(&self) -> String {
        format!("Color/{}", self.text())
    }

    /// The name the swatches panel shows: PowerPoint's for its tints
    /// (`Accent 1, Lighter 40%`), the transforms spelled out otherwise.
    pub fn name(&self) -> String {
        let base = slot_name(&self.slot);
        let base = match &self.theme {
            Some(t) => format!("{base} ({t})"),
            None => base,
        };
        let t = &self.transforms;
        let pct = |v: i32| {
            let p = v as f64 / 1000.0;
            if (p - p.round()).abs() < 1e-9 {
                format!("{}", p.round() as i64)
            } else {
                format!("{p}")
            }
        };
        match t.as_slice() {
            [] => base,
            [(a, m), (b, o)] if a == "lumMod" && b == "lumOff" && m + o == 100_000 => {
                format!("{base}, Lighter {}%", pct(*o))
            }
            [(a, m)] if a == "lumMod" && *m < 100_000 => {
                format!("{base}, Darker {}%", pct(100_000 - m))
            }
            _ => format!(
                "{base} ({})",
                t.iter()
                    .map(|(op, v)| format!("{op} {}%", pct(*v)))
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        }
    }

    /// The DrawingML colour the key stands for (`a:schemeClr` of its slot
    /// with its transforms).
    pub fn color(&self) -> Color {
        Color {
            base: ColorBase::Scheme(self.slot.clone()),
            transforms: self.transforms.clone(),
        }
    }

    /// The key's colour in a theme of `colors` (slot → sRGB).
    pub fn rgb(&self, colors: &[(String, Rgb)]) -> Option<Rgb> {
        let (_, base) = colors.iter().find(|(s, _)| *s == self.slot)?;
        let table: Vec<(String, Rgba)> = vec![(
            self.slot.clone(),
            Rgba::from_hex(u32::from_be_bytes([0, base[0], base[1], base[2]])),
        )];
        Some(drawingml::resolve(&self.color(), &table).bytes())
    }
}

/// A logical colour name through a colour map to its theme slot
/// (PowerPoint's defaults for a map that lacks it).
pub fn mapped_slot(map: &ColorMap, name: &str) -> String {
    map.entries
        .iter()
        .find(|(k, _)| k == name)
        .map(|(_, v)| v.clone())
        .unwrap_or_else(|| {
            match name {
                "bg1" => "lt1",
                "tx1" => "dk1",
                "bg2" => "lt2",
                "tx2" => "dk2",
                other => other,
            }
            .to_string()
        })
}

/// The key of a colour, when it is a theme colour: a scheme colour through
/// `map` to its slot, or `phClr` as `placeholder` (the style reference's
/// key) with this colour's transforms after the reference's. `theme` names a
/// theme other than the deck's first.
pub fn key_of(
    c: &Color,
    map: &ColorMap,
    placeholder: Option<&str>,
    theme: Option<&str>,
) -> Option<String> {
    let ColorBase::Scheme(name) = &c.base else {
        return None;
    };
    let own = c
        .transforms
        .iter()
        .filter(|(op, _)| !alpha_only(op))
        .cloned();
    let key = if name == "phClr" {
        let mut k = Key::parse(placeholder?)?;
        k.transforms.extend(own);
        k
    } else {
        let slot = mapped_slot(map, name);
        if !SLOTS.contains(&slot.as_str()) {
            return None;
        }
        Key {
            theme: theme.map(str::to_string),
            slot,
            transforms: own.collect(),
        }
    };
    Some(key.text())
}

/// The colour picker's five tints and shades of a slot whose colour is
/// `rgb`, as transforms: lighter 80/60/40 % and darker 25/50 % for a mid
/// colour; lighter 50 … 5 % for black, darker 5 … 50 % for white; lighter
/// 90 … 10 % for a very dark colour, darker 10 … 90 % for a very light one.
pub fn standard_tints(rgb: Rgb) -> Vec<Vec<(String, i32)>> {
    let f = |c: u8| c as f64 / 255.0;
    let (_, _, l) = rgb_to_hsl(f(rgb[0]), f(rgb[1]), f(rgb[2]));
    let lighter = |p: i32| vec![("lumMod".into(), 100_000 - p), ("lumOff".into(), p)];
    let darker = |p: i32| vec![("lumMod".to_string(), 100_000 - p)];
    if l <= 0.0 + 1e-9 {
        [50_000, 35_000, 25_000, 15_000, 5_000]
            .map(lighter)
            .to_vec()
    } else if l >= 1.0 - 1e-9 {
        [5_000, 15_000, 25_000, 35_000, 50_000].map(darker).to_vec()
    } else if l < 0.2 {
        [90_000, 75_000, 50_000, 25_000, 10_000]
            .map(lighter)
            .to_vec()
    } else if l > 0.8 {
        [10_000, 25_000, 50_000, 75_000, 90_000]
            .map(darker)
            .to_vec()
    } else {
        vec![
            lighter(80_000),
            lighter(60_000),
            lighter(40_000),
            darker(25_000),
            darker(50_000),
        ]
    }
}

/// The keys of the "Theme" swatch group: each slot, then each tinted
/// slot's five tints, in the colour picker's order.
pub fn group_keys(colors: &[(String, Rgb)]) -> Vec<Key> {
    let mut out: Vec<Key> = SLOTS.iter().map(|s| Key::slot(s)).collect();
    for slot in TINTED {
        let Some((_, rgb)) = colors.iter().find(|(s, _)| s == slot) else {
            continue;
        };
        for transforms in standard_tints(*rgb) {
            out.push(Key {
                theme: None,
                slot: slot.to_string(),
                transforms,
            });
        }
    }
    out
}

// ─── the theme as data ──────────────────────────────────────────────

/// A theme as the deck keeps it (its label) and as the gallery lists it:
/// name, the twelve slots as `RRGGBB`, the major and minor Latin fonts.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeIr {
    pub name: String,
    pub colors: Vec<(String, String)>,
    pub major: String,
    pub minor: String,
    /// The variant applied, by name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub variant: Option<String>,
}

fn hex(rgb: Rgb) -> String {
    format!("{:02X}{:02X}{:02X}", rgb[0], rgb[1], rgb[2])
}

fn unhex(s: &str) -> Option<Rgb> {
    let v = u32::from_str_radix(s.trim().trim_start_matches('#'), 16).ok()?;
    Some([(v >> 16) as u8, (v >> 8) as u8, v as u8])
}

impl ThemeIr {
    /// A deck's theme part as data (a system colour by its last value).
    pub fn of(t: &Theme) -> ThemeIr {
        ThemeIr {
            name: t.name.clone().unwrap_or_else(|| "Theme".into()),
            colors: SLOTS
                .iter()
                .map(|s| {
                    let rgb = t
                        .colors
                        .iter()
                        .find(|(k, _)| k == s)
                        .map(|(_, c)| drawingml::resolve(c, &()).bytes())
                        .unwrap_or([0, 0, 0]);
                    (s.to_string(), hex(rgb))
                })
                .collect(),
            major: t.major_font.latin.clone().unwrap_or_default(),
            minor: t.minor_font.latin.clone().unwrap_or_default(),
            variant: None,
        }
    }

    /// The slots as sRGB.
    pub fn rgb_table(&self) -> Vec<(String, Rgb)> {
        self.colors
            .iter()
            .filter_map(|(s, h)| Some((s.clone(), unhex(h)?)))
            .collect()
    }

    /// The slot's colour.
    pub fn rgb(&self, slot: &str) -> Option<Rgb> {
        self.colors
            .iter()
            .find(|(s, _)| s == slot)
            .and_then(|(_, h)| unhex(h))
    }

    /// The same theme with these slot colours.
    fn with_colors(&self, f: impl Fn(&str, Rgb) -> Rgb, variant: &str) -> ThemeIr {
        let table = self.rgb_table();
        ThemeIr {
            colors: SLOTS
                .iter()
                .map(|s| {
                    let rgb = table
                        .iter()
                        .find(|(k, _)| k == s)
                        .map(|(_, c)| *c)
                        .unwrap_or([0, 0, 0]);
                    (s.to_string(), hex(f(s, rgb)))
                })
                .collect(),
            variant: Some(variant.into()),
            ..self.clone()
        }
    }
}

/// The colour of each key under `theme`, by swatch id, for every id given
/// that is a theme key (a key of another of the deck's themes takes the
/// applied theme too: a theme is applied to every master, as PowerPoint
/// does).
pub fn swatch_values(theme: &ThemeIr, ids: &[String]) -> Vec<(String, Rgb)> {
    let table = theme.rgb_table();
    ids.iter()
        .filter_map(|id| Some((id.clone(), Key::of_swatch(id)?.rgb(&table)?)))
        .collect()
}

// ─── variants and the gallery ───────────────────────────────────────

/// A colour with its HSL saturation scaled.
fn saturate(rgb: Rgb, k: f64) -> Rgb {
    let f = |c: u8| c as f64 / 255.0;
    let (h, s, l) = rgb_to_hsl(f(rgb[0]), f(rgb[1]), f(rgb[2]));
    let (r, g, b) = hsl_to_rgb(h, (s * k).clamp(0.0, 1.0), l);
    let q = |x: f64| (x.clamp(0.0, 1.0) * 255.0).round() as u8;
    [q(r), q(g), q(b)]
}

/// A theme's four variants, PowerPoint's Design ▸ Variants: the theme as
/// it is, dark (the dark and light slots swapped, so text is light on a dark
/// background), its accents in another order, and muted accents. Fonts stay.
pub fn variants(base: &ThemeIr) -> Vec<ThemeIr> {
    let table = base.rgb_table();
    let get = |s: &str| {
        table
            .iter()
            .find(|(k, _)| k == s)
            .map(|(_, c)| *c)
            .unwrap_or([0, 0, 0])
    };
    vec![
        base.with_colors(|_, c| c, "Original"),
        base.with_colors(
            |s, c| match s {
                "dk1" => get("lt1"),
                "lt1" => get("dk1"),
                "dk2" => get("lt2"),
                "lt2" => get("dk2"),
                _ => c,
            },
            "Dark",
        ),
        base.with_colors(
            |s, c| match s
                .strip_prefix("accent")
                .and_then(|n| n.parse::<usize>().ok())
            {
                Some(n) => get(&format!("accent{}", (n + 1) % 6 + 1)),
                None => c,
            },
            "Shifted",
        ),
        base.with_colors(
            |s, c| {
                if s.starts_with("accent") {
                    saturate(c, 0.45)
                } else {
                    c
                }
            },
            "Muted",
        ),
    ]
}

/// One theme of the Design gallery, with its variants.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GalleryTheme {
    pub id: String,
    pub name: String,
    pub theme: ThemeIr,
    pub variants: Vec<ThemeIr>,
}

#[derive(Deserialize)]
struct GalleryFile {
    themes: Vec<GalleryEntry>,
}

#[derive(Deserialize)]
struct GalleryEntry {
    id: String,
    name: String,
    colors: Vec<(String, String)>,
    major: String,
    minor: String,
}

/// The gallery's themes (`themes/gallery.json`, written by
/// `scripts/gen-theme-gallery.py`).
pub fn gallery() -> Vec<GalleryTheme> {
    let file: GalleryFile = serde_json::from_str(include_str!("../themes/gallery.json"))
        .expect("themes/gallery.json is valid");
    file.themes
        .into_iter()
        .map(|e| {
            let theme = ThemeIr {
                name: e.name.clone(),
                colors: e.colors,
                major: e.major,
                minor: e.minor,
                variant: None,
            };
            GalleryTheme {
                variants: variants(&theme),
                id: e.id,
                name: e.name,
                theme,
            }
        })
        .collect()
}

/// A theme part's XML with `theme`'s colour scheme, Latin fonts and name;
/// everything else (the format scheme, the other scripts' fonts, the
/// extensions) as it was. `None` when the part has no colour or font scheme.
pub fn rewrite_theme_xml(xml: &str, theme: &ThemeIr) -> Option<String> {
    let esc = |s: &str| {
        s.replace('&', "&amp;")
            .replace('"', "&quot;")
            .replace('<', "&lt;")
    };
    let name = match &theme.variant {
        Some(v) if v != "Original" => format!("{} {v}", theme.name),
        _ => theme.name.clone(),
    };
    // The scheme element, as `<a:clrScheme name="…">…</a:clrScheme>`.
    let (pre, rest) = xml.split_at(xml.find("<a:clrScheme")?);
    let end = rest.find("</a:clrScheme>")? + "</a:clrScheme>".len();
    let slots: String = SLOTS
        .iter()
        .map(|s| {
            let v = theme.rgb(s).map(hex).unwrap_or_else(|| "000000".into());
            format!(r#"<a:{s}><a:srgbClr val="{v}"/></a:{s}>"#)
        })
        .collect();
    let mut out = format!(
        r#"{pre}<a:clrScheme name="{}">{slots}</a:clrScheme>{}"#,
        esc(&name),
        &rest[end..]
    );
    // The Latin fonts of the major and minor fonts.
    for (tag, face) in [("a:majorFont", &theme.major), ("a:minorFont", &theme.minor)] {
        let at = out.find(&format!("<{tag}>"))?;
        let latin = at + out[at..].find("<a:latin ")?;
        let close = latin + out[latin..].find("/>")? + 2;
        out.replace_range(
            latin..close,
            &format!(r#"<a:latin typeface="{}"/>"#, esc(face)),
        );
    }
    // The theme's and the font scheme's names.
    for tag in ["<a:theme ", "<a:fontScheme "] {
        if let Some(at) = out.find(tag) {
            let head_end = at + out[at..].find('>')?;
            if let Some(n) = out[at..head_end].find(" name=\"") {
                let v0 = at + n + 7;
                let v1 = v0 + out[v0..].find('"')?;
                out.replace_range(v0..v1, &esc(&name));
            }
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_key_reads_back_its_text_and_names_powerpoints_tints() {
        let k = Key::parse("accent1 lumMod60000 lumOff40000").unwrap();
        assert_eq!(k.slot, "accent1");
        assert_eq!(k.text(), "accent1 lumMod60000 lumOff40000");
        assert_eq!(k.name(), "Accent 1, Lighter 40%");
        assert_eq!(
            Key::parse("dk1 lumMod75000").unwrap().name(),
            "Dark 1, Darker 25%"
        );
        assert_eq!(
            Key::parse("theme2:accent2 shade50000").unwrap().name(),
            "Accent 2 (theme2) (shade 50%)"
        );
        assert_eq!(Key::of_swatch("Color/hlink").unwrap().name(), "Hyperlink");
        assert!(Key::parse("tx1").is_none());
        assert!(Key::of_swatch("Color/R112233").is_none());
        assert!(Key::parse("accent1 lumMod").is_none());
        assert_eq!(
            Key::parse("accent1 hueOff-3000").unwrap().transforms,
            vec![("hueOff".to_string(), -3000)]
        );
    }

    #[test]
    fn a_scheme_colour_keys_its_mapped_slot_and_a_ph_clr_its_reference() {
        let map = ColorMap {
            entries: vec![("bg1".into(), "dk1".into()), ("tx1".into(), "lt1".into())],
        };
        let c = Color {
            base: ColorBase::Scheme("bg1".into()),
            transforms: vec![("lumMod".into(), 85_000), ("alpha".into(), 50_000)],
        };
        assert_eq!(
            key_of(&c, &map, None, None).as_deref(),
            Some("dk1 lumMod85000")
        );
        let ph = Color {
            base: ColorBase::Scheme("phClr".into()),
            transforms: vec![("shade".into(), 50_000)],
        };
        assert_eq!(
            key_of(&ph, &map, Some("accent2"), None).as_deref(),
            Some("accent2 shade50000")
        );
        assert_eq!(key_of(&ph, &map, None, None), None);
        assert_eq!(key_of(&Color::srgb(0xffffff), &map, None, None), None);
        assert_eq!(
            key_of(
                &Color {
                    base: ColorBase::Scheme("accent1".into()),
                    transforms: vec![]
                },
                &ColorMap::default(),
                None,
                Some("theme2")
            )
            .as_deref(),
            Some("theme2:accent1")
        );
    }

    #[test]
    fn a_key_recolours_under_another_theme() {
        let office = gallery().into_iter().find(|g| g.id == "office").unwrap();
        let t = office.theme.rgb_table();
        // Office 2023 accent1 156082, lighter 40 %: PowerPoint shows 4EA6D0
        // … computed by the same HSL arithmetic the resolver draws with.
        let k = Key::parse("accent1 lumMod60000 lumOff40000").unwrap();
        let before = k.rgb(&t).unwrap();
        assert_eq!(Key::slot("accent1").rgb(&t), Some([0x15, 0x60, 0x82]));
        let dark = &office.variants[1];
        assert_eq!(dark.rgb("lt1"), Some([0, 0, 0]));
        assert_eq!(dark.rgb("dk1"), Some([255, 255, 255]));
        let v = swatch_values(
            dark,
            &[
                "Color/lt1".into(),
                "Color/accent1 lumMod60000 lumOff40000".into(),
                "Color/R102030".into(),
            ],
        );
        assert_eq!(v.len(), 2);
        assert_eq!(v[0], ("Color/lt1".into(), [0, 0, 0]));
        assert_eq!(v[1].1, before, "the dark variant keeps the accents");
    }

    #[test]
    fn the_picker_tints_follow_the_slots_lightness() {
        assert_eq!(standard_tints([0, 0, 0])[0][1], ("lumOff".into(), 50_000));
        assert_eq!(
            standard_tints([255, 255, 255])[0],
            vec![("lumMod".into(), 95_000)]
        );
        let mid = standard_tints([0x15, 0x60, 0x82]);
        assert_eq!(
            mid.iter().map(|t| t.len()).collect::<Vec<_>>(),
            vec![2, 2, 2, 1, 1]
        );
        let keys = group_keys(&gallery()[0].theme.rgb_table());
        assert_eq!(keys.len(), 12 + 50);
    }

    #[test]
    fn the_gallery_has_its_themes_each_with_four_variants() {
        let g = gallery();
        assert!(g.len() >= 6);
        for t in &g {
            assert_eq!(t.theme.colors.len(), 12, "{}", t.id);
            assert_eq!(t.variants.len(), 4);
            assert!(!t.theme.major.is_empty() && !t.theme.minor.is_empty());
        }
        assert_eq!(g[0].theme.major, "Aptos Display");
    }

    #[test]
    fn a_theme_part_is_rewritten_with_the_themes_colours_fonts_and_name() {
        let xml = r#"<a:theme xmlns:a="x" name="Office"><a:themeElements><a:clrScheme name="Office"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1></a:clrScheme><a:fontScheme name="Office"><a:majorFont><a:latin typeface="Aptos Display" panose="1"/><a:ea typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Aptos"/></a:minorFont></a:fontScheme><a:fmtScheme name="Office"/></a:themeElements></a:theme>"#;
        let paper = gallery().into_iter().find(|g| g.id == "paper").unwrap();
        let out = rewrite_theme_xml(xml, &paper.variants[1]).unwrap();
        assert!(
            out.contains(r#"<a:theme xmlns:a="x" name="Paper Dark">"#),
            "{out}"
        );
        assert!(out.contains(
            r#"<a:clrScheme name="Paper Dark"><a:dk1><a:srgbClr val="FFFFFF"/></a:dk1>"#
        ));
        assert!(out.contains(r#"<a:majorFont><a:latin typeface="Georgia"/><a:ea typeface=""/>"#));
        assert!(out.contains(r#"<a:minorFont><a:latin typeface="Verdana"/>"#));
        assert!(out.contains(r#"<a:fmtScheme name="Office"/>"#));
        assert_eq!(out.matches("<a:accent6>").count(), 1);
    }
}
