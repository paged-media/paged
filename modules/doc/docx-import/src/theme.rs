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

//! The theme part and theme references (doc ADR 609): `word/theme/theme1.xml`
//! read into [`Theme`], and `w:color` / `w:shd` / `w:rFonts` resolved through
//! it, the reference kept beside the concrete value.

use docx_core::{theme::tinted, RunProps, Shading, Theme, ThemeColorRef, ThemeFonts};
use paged_ooxml::ooxmlsdk::schemas::schemas_openxmlformats_org_wordprocessingml_2006_main as wml;
use paged_ooxml::tree::{self, El, Ns};
use paged_ooxml::{part_dir, rels, resolve_target, OpcPackage};

/// The theme part name (via the main document's `.rels`).
pub(crate) fn theme_part(pkg: &OpcPackage, main_part: &str) -> Option<String> {
    let rels_bytes = pkg.part(&rels::rels_part_name(main_part))?;
    let rels = rels::Relationships::parse(rels_bytes);
    let r = rels.by_type_suffix("/theme")?;
    Some(resolve_target(part_dir(main_part), &r.target))
}

/// Read a theme part (`a:theme`): its colour scheme and font scheme. `None`
/// when it does not parse or has no colour scheme.
pub(crate) fn parse_theme(bytes: &[u8]) -> Option<Theme> {
    let root = tree::parse(bytes).ok()?;
    let elements = root.child(Ns::A, "themeElements")?;
    let scheme = elements.child(Ns::A, "clrScheme")?;
    let mut colors = Vec::new();
    for (word, element) in docx_core::theme::SCHEME_SLOTS {
        if let Some(hex) = scheme.child(Ns::A, element).and_then(color_value) {
            colors.push((word.to_string(), hex));
        }
    }
    if colors.is_empty() {
        return None;
    }
    let fonts = elements.child(Ns::A, "fontScheme");
    let half = |name: &str| {
        fonts
            .and_then(|f| f.child(Ns::A, name))
            .map(|h| {
                let face = |n: &str| {
                    h.child(Ns::A, n)
                        .and_then(|e| e.attr("typeface"))
                        .filter(|t| !t.is_empty())
                        .map(str::to_string)
                };
                ThemeFonts {
                    latin: face("latin"),
                    east_asia: face("ea"),
                    complex_script: face("cs"),
                }
            })
            .unwrap_or_default()
    };
    Some(Theme {
        name: root.attr("name").map(str::to_string),
        colors,
        major: half("majorFont"),
        minor: half("minorFont"),
        mapping: Vec::new(),
    })
}

/// A scheme slot's colour: `a:srgbClr/@val`, or `a:sysClr/@lastClr` (the
/// colour the system colour had when the file was saved).
fn color_value(slot: &El) -> Option<String> {
    let hex = if let Some(c) = slot.child(Ns::A, "srgbClr") {
        c.attr("val")?
    } else {
        slot.child(Ns::A, "sysClr")?.attr("lastClr")?
    };
    (hex.len() == 6 && hex.chars().all(|c| c.is_ascii_hexdigit())).then(|| hex.to_ascii_uppercase())
}

/// `w:clrSchemeMapping` as `(Word slot, scheme slot)` pairs.
pub(crate) fn color_mapping(m: &wml::ColorSchemeMapping) -> Vec<(String, String)> {
    let pairs = [
        ("background1", m.background1),
        ("text1", m.text1),
        ("background2", m.background2),
        ("text2", m.text2),
        ("accent1", m.accent1),
        ("accent2", m.accent2),
        ("accent3", m.accent3),
        ("accent4", m.accent4),
        ("accent5", m.accent5),
        ("accent6", m.accent6),
        ("hyperlink", m.hyperlink),
        ("followedHyperlink", m.followed_hyperlink),
    ];
    pairs
        .into_iter()
        .filter_map(|(from, to)| Some((from.to_string(), to?.to_string())))
        .collect()
}

fn theme_ref(
    slot: Option<wml::ThemeColorValues>,
    tint: &Option<String>,
    shade: &Option<String>,
) -> Option<ThemeColorRef> {
    let slot = slot?.to_string();
    if slot == "none" {
        return None;
    }
    Some(ThemeColorRef {
        slot,
        tint: tint.as_deref().and_then(ThemeColorRef::parse_byte),
        shade: shade.as_deref().and_then(ThemeColorRef::parse_byte),
    })
}

/// A theme reference's colour through `theme`, or `None` without one.
pub(crate) fn resolve(theme: Option<&Theme>, r: &ThemeColorRef) -> Option<String> {
    tinted(theme?.base_color(&r.slot)?, r.tint, r.shade)
}

/// `w:val` as `RRGGBB`, `None` for `auto` or anything else.
fn hex(val: &Option<String>) -> Option<String> {
    let v = val.as_ref()?;
    (v.len() == 6 && v.chars().all(|c| c.is_ascii_hexdigit())).then(|| v.to_ascii_uppercase())
}

/// Apply a `w:color` to `props`: the theme reference wins over `w:val`
/// (Word's rule), resolved through the theme; without a theme part the
/// cached `w:val` stands in for it.
pub(crate) fn apply_color(c: &wml::Color, theme: Option<&Theme>, props: &mut RunProps) {
    match theme_ref(c.theme_color, &c.theme_tint, &c.theme_shade) {
        Some(r) => {
            props.color = resolve(theme, &r).or_else(|| hex(&c.val));
            props.theme_color = props.color.is_some().then_some(r);
        }
        None => {
            props.color = hex(&c.val);
            props.theme_color = None;
        }
    }
}

/// A `w:shd` as its fill (theme first), `None` when it fills nothing.
pub(crate) fn shading(s: &wml::Shading, theme: Option<&Theme>) -> Option<Shading> {
    let theme_fill = theme_ref(s.theme_fill, &s.theme_fill_tint, &s.theme_fill_shade);
    let fill = theme_fill
        .as_ref()
        .and_then(|r| resolve(theme, r))
        .or_else(|| hex(&s.fill));
    fill.is_some().then(|| Shading {
        fill,
        theme_fill: theme_fill.filter(|_| theme.is_some()),
    })
}

/// Apply a `w:rFonts` to `props`: each script's family, a theme font
/// (`w:asciiTheme`, `w:eastAsiaTheme`, `w:cstheme`) winning over the named
/// one, as in Word. The Latin (`ascii`) theme slot is kept.
pub(crate) fn apply_fonts(f: &wml::RunFonts, theme: Option<&Theme>, props: &mut RunProps) {
    let slot = |v: Option<wml::ThemeFontValues>| v.map(|v| v.to_string());
    let latin_theme = slot(f.ascii_theme);
    let by_theme = latin_theme
        .as_deref()
        .and_then(|s| theme?.font(s))
        .map(str::to_string);
    match by_theme {
        Some(face) => {
            props.font = Some(face);
            props.font_theme = latin_theme;
        }
        None => {
            if let Some(a) = f.ascii.clone() {
                props.font = Some(a);
                props.font_theme = None;
            }
        }
    }
    let ea = slot(f.east_asia_theme)
        .and_then(|s| theme?.font(&s).map(str::to_string))
        .or_else(|| f.east_asia.clone());
    if ea.is_some() {
        props.font_east_asia = ea;
    }
    let cs = slot(f.complex_script_theme)
        .and_then(|s| theme?.font(&s).map(str::to_string))
        .or_else(|| f.complex_script.clone());
    if cs.is_some() {
        props.font_cs = cs;
    }
}

/// The Latin family a paragraph mark's or a list level's `w:rFonts` names.
pub(crate) fn latin_font(f: &wml::RunFonts, theme: Option<&Theme>) -> Option<String> {
    let mut props = RunProps::default();
    apply_fonts(f, theme, &mut props);
    props.font
}
