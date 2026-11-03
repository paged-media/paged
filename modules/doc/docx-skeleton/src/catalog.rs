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

//! The document's catalogue, built in Rust (doc ADR 625, slice 2): the
//! theme, the swatches and colour groups, and the paragraph and character
//! styles of the lowering, set on the skeleton's model in the order the
//! bundle's `buildStyleMutations` sends them. Each style property is the
//! field the engine's `setStyleProperty` sets (`paged-mutate`
//! `set_paragraph_style_field` / `set_character_style_field`), read the same
//! way (`""` clears a text slot, a count rounds); a property the model has no
//! field for refuses the whole catalogue, so the document opens by the old
//! pour, which says so. `paged-mutate` itself is not linked: it would add
//! 4.77 MiB to the doc wasm.

use std::collections::BTreeMap;

use docx_lower::ir::{LoweredDoc, PropValue, StyleCollection, StyleProp};
use paged_model::script::{CharacterDirection, FontHint};
use paged_model::{CharacterStyleDef, ColorEntry, ColorGroupEntry, ColorModel, ColorSpace};
use paged_model::{
    Composer, Justification, ParagraphDirection, SpanColumnType, SpanSplitColumnCount,
    StartParagraph, TabStop, Theme, ThemeColor, ThemeFonts, THEME_SLOTS,
};
use paged_model::{ParagraphStyleDef, THEME_SOURCE_OOXML};
use paged_scene::Document;

/// Why the catalogue could not be applied, for the caller to fall back to
/// the old path whole.
pub type CatalogError = String;

fn len(v: &PropValue) -> Option<f32> {
    match v {
        PropValue::Length(f) => Some(*f),
        _ => None,
    }
}

fn flag(v: &PropValue) -> Option<bool> {
    match v {
        PropValue::Bool(b) => Some(*b),
        _ => None,
    }
}

fn text(v: &PropValue) -> Option<&str> {
    match v {
        PropValue::Text(t) => Some(t),
        _ => None,
    }
}

/// A text slot: `""` clears it.
fn slot(v: &PropValue) -> Option<Option<String>> {
    text(v).map(|t| (!t.is_empty()).then(|| t.to_owned()))
}

fn count(f: f32) -> u32 {
    f.max(0.0).round() as u32
}

/// The character properties both kinds of style carry, with the names the
/// two definitions share. `true`: handled.
macro_rules! character_prop {
    ($d:expr, $p:expr) => {{
        let v = &$p.value;
        match $p.path.as_str() {
            "characterFontFamily" => slot(v).map(|x| $d.font = x).is_some(),
            "characterFontStyle" => slot(v).map(|x| $d.font_style = x).is_some(),
            "characterFontSize" => len(v).map(|x| $d.point_size = Some(x)).is_some(),
            "characterLeading" => len(v).map(|x| $d.leading = Some(x)).is_some(),
            "characterTracking" => len(v).map(|x| $d.tracking = Some(x)).is_some(),
            "characterFillColor" => match v {
                PropValue::ColorRef(c) => {
                    $d.fill_color = Some(c.clone());
                    true
                }
                _ => false,
            },
            "characterCase" => slot(v).map(|x| $d.capitalization = x).is_some(),
            "characterPosition" => slot(v).map(|x| $d.position = x).is_some(),
            "characterBaselineShift" => len(v).map(|x| $d.baseline_shift = Some(x)).is_some(),
            "characterUnderline" => flag(v).map(|x| $d.underline = Some(x)).is_some(),
            "characterStrikethru" => flag(v).map(|x| $d.strikethru = Some(x)).is_some(),
            "characterLigatures" => flag(v).map(|x| $d.ligatures_on = Some(x)).is_some(),
            "characterKerningMethod" => slot(v).map(|x| $d.kerning_method = x).is_some(),
            "characterEastAsianFont" => slot(v).map(|x| $d.script.east_asian_font = x).is_some(),
            "characterComplexFont" => slot(v).map(|x| $d.script.complex_font = x).is_some(),
            "characterComplexFontSize" => len(v)
                .filter(|f| f.is_finite() && *f > 0.0)
                .map(|x| $d.script.complex_point_size = Some(x))
                .is_some(),
            "characterComplexBold" => flag(v).map(|x| $d.script.complex_bold = Some(x)).is_some(),
            "characterComplexItalic" => flag(v)
                .map(|x| $d.script.complex_italic = Some(x))
                .is_some(),
            "characterComplexScript" => flag(v).map(|x| $d.script.complex = Some(x)).is_some(),
            "characterDirection" => text(v)
                .and_then(CharacterDirection::from_name)
                .map(|x| $d.script.direction = Some(x))
                .is_some(),
            "characterFontHint" => text(v)
                .and_then(FontHint::from_name)
                .map(|x| $d.script.hint = Some(x))
                .is_some(),
            _ => false,
        }
    }};
}

fn character_style_prop(d: &mut CharacterStyleDef, p: &StyleProp) -> bool {
    character_prop!(d, p)
}

fn paragraph_style_prop(d: &mut ParagraphStyleDef, p: &StyleProp) -> bool {
    if character_prop!(d, p) {
        return true;
    }
    let v = &p.value;
    match p.path.as_str() {
        "paragraphSpaceBefore" => len(v).map(|x| d.space_before = Some(x)).is_some(),
        "paragraphSpaceAfter" => len(v).map(|x| d.space_after = Some(x)).is_some(),
        "paragraphLeftIndent" => len(v).map(|x| d.left_indent = Some(x)).is_some(),
        "paragraphRightIndent" => len(v).map(|x| d.right_indent = Some(x)).is_some(),
        "paragraphFirstLineIndent" => len(v).map(|x| d.first_line_indent = Some(x)).is_some(),
        "paragraphJustification" => text(v)
            .and_then(Justification::from_idml)
            .map(|x| d.justification = Some(x))
            .is_some(),
        "paragraphKeepWithNext" => len(v).map(|x| d.keep_with_next = Some(count(x))).is_some(),
        "paragraphKeepFirstLines" => len(v)
            .map(|x| d.keep_first_lines = Some(count(x)))
            .is_some(),
        "paragraphKeepLastLines" => len(v).map(|x| d.keep_last_lines = Some(count(x))).is_some(),
        "paragraphKeepLinesTogether" => flag(v).map(|x| d.keep_lines_together = Some(x)).is_some(),
        "paragraphKeepAllLinesTogether" => flag(v)
            .map(|x| d.keep_all_lines_together = Some(x))
            .is_some(),
        "paragraphHyphenation" => flag(v).map(|x| d.hyphenation = Some(x)).is_some(),
        "paragraphAutoLeading" => len(v)
            .map(|x| d.line_setting.auto_leading = Some(x))
            .is_some(),
        "paragraphStartParagraph" => text(v)
            .and_then(StartParagraph::from_idml)
            .map(|x| d.start_paragraph = Some(x))
            .is_some(),
        "paragraphComposer" => text(v)
            .map(|x| d.composer = (!x.is_empty()).then(|| Composer::from_idml(x)))
            .is_some(),
        "paragraphListType" => slot(v).map(|x| d.bullets_list_type = x).is_some(),
        "paragraphNumberingFormat" => slot(v).map(|x| d.numbering_format = x).is_some(),
        "paragraphBulletCharacter" => text(v)
            .map(|x| d.bullet_character = x.chars().next().map(|c| c as u32))
            .is_some(),
        "paragraphStylePdfExportTag" => slot(v).map(|x| d.pdf_export_tag = x).is_some(),
        "paragraphDirection" => text(v)
            .and_then(ParagraphDirection::from_name)
            .map(|x| d.direction = Some(x))
            .is_some(),
        "paragraphSpanColumnType" => text(v)
            .and_then(SpanColumnType::from_idml)
            .map(|x| d.span_columns.column_type = Some(x))
            .is_some(),
        "paragraphSpanSplitColumnCount" => match v {
            PropValue::Text(t) => SpanSplitColumnCount::from_idml(t)
                .map(|x| d.span_columns.count = Some(x))
                .is_some(),
            PropValue::Length(n) if n.is_finite() && *n >= 1.0 && n.fract() == 0.0 => {
                d.span_columns.count = Some(SpanSplitColumnCount::Count(*n as u32));
                true
            }
            _ => false,
        },
        "paragraphSplitColumnInsideGutter" => len(v)
            .map(|x| d.span_columns.inside_gutter = Some(x))
            .is_some(),
        "paragraphSplitColumnOutsideGutter" => len(v)
            .map(|x| d.span_columns.outside_gutter = Some(x))
            .is_some(),
        "paragraphTabStops" => match v {
            PropValue::TabStops(stops) => {
                d.tab_list = stops
                    .iter()
                    .map(|s| TabStop {
                        position: s.position,
                        alignment: s.alignment.clone(),
                        alignment_character: s.alignment_character.clone(),
                        leader: s.leader.clone(),
                    })
                    .collect();
                true
            }
            _ => false,
        },
        _ => false,
    }
}

fn hex(value: &str) -> Result<String, CatalogError> {
    let v = value.trim().trim_start_matches('#');
    if v.len() == 6 && v.bytes().all(|b| b.is_ascii_hexdigit()) {
        Ok(v.to_ascii_uppercase())
    } else {
        Err(format!("{value:?} is not an RRGGBB colour"))
    }
}

/// The theme (engine ADR 1056): the part's slots, in the engine's order,
/// both font sets, and the part itself as the unedited source.
fn theme_of(t: &dml_native::theme::ThemeWire) -> Result<Theme, CatalogError> {
    let mut colors: Vec<ThemeColor> = Vec::new();
    for c in &t.colors {
        if !THEME_SLOTS.contains(&c.slot.as_str()) || colors.iter().any(|x| x.slot == c.slot) {
            return Err(format!("theme slot {:?}", c.slot));
        }
        colors.push(ThemeColor {
            slot: c.slot.clone(),
            value: hex(&c.value)?,
            system: c.system.clone().filter(|s| !s.is_empty()),
        });
    }
    colors.sort_by_key(|c| {
        THEME_SLOTS
            .iter()
            .position(|s| *s == c.slot)
            .unwrap_or(THEME_SLOTS.len())
    });
    let fonts = |f: &dml_native::theme::ThemeFontsWire| {
        let face = |x: &Option<String>| x.clone().filter(|x| !x.is_empty());
        ThemeFonts {
            latin: face(&f.latin),
            east_asian: face(&f.east_asian),
            complex: face(&f.complex),
            scripts: f
                .scripts
                .iter()
                .filter(|s| !s.script.is_empty() && !s.typeface.is_empty())
                .map(|s| (s.script.clone(), s.typeface.clone()))
                .collect(),
        }
    };
    Ok(Theme {
        name: t.name.clone(),
        color_scheme_name: t.color_scheme_name.clone(),
        colors,
        font_scheme_name: t.font_scheme_name.clone(),
        major: fonts(&t.major),
        minor: fonts(&t.minor),
        source: t.source.as_ref().map(|data| paged_model::SourceBlob {
            format: THEME_SOURCE_OOXML.into(),
            data: data.clone(),
        }),
        // A source given is a file read in: not edited.
        edited: t.source.is_none(),
    })
}

/// Apply the theme, swatches, colour groups and styles of `ir` to `document`.
pub fn apply_catalog(document: &mut Document, ir: &LoweredDoc) -> Result<(), CatalogError> {
    // Engine ADR 1056 — the theme first, so the swatches that follow its
    // slots find it.
    let themed = ir.theme.is_some();
    if let Some(theme) = &ir.theme {
        document.theme = Some(theme_of(theme)?);
    }
    for sw in &ir.swatches {
        if document.palette.colors.contains_key(&sw.id) {
            return Err(format!("swatch {} exists", sw.id));
        }
        let theme_ref = sw
            .theme_ref
            .clone()
            .filter(|r| themed && THEME_SLOTS.contains(&r.slot.as_str()));
        document.palette.colors.insert(
            sw.id.clone(),
            ColorEntry {
                self_id: sw.id.clone(),
                name: Some(sw.name.clone()),
                space: ColorSpace::from_attr(&sw.space),
                value: sw.value.clone(),
                model: ColorModel::Process,
                alternate_space: None,
                alternate_value: Vec::new(),
                tint: None,
                alpha: None,
                theme_ref,
            },
        );
    }
    for g in &ir.color_groups {
        if document.palette.color_groups.contains_key(&g.id) {
            return Err(format!("colour group {} exists", g.id));
        }
        document.palette.color_groups.insert(
            g.id.clone(),
            ColorGroupEntry {
                self_id: g.id.clone(),
                name: Some(g.name.clone()),
                members: g.members.clone(),
            },
        );
    }
    // The styles the lowering invented for direct formatting are named by
    // nothing a prefilled skeleton holds: the body, the headers and footers
    // and the text boxes are built with their properties.
    let mut known: BTreeMap<&str, ()> = BTreeMap::new();
    for style in &ir.styles {
        if crate::body::is_synthesized(&style.id) {
            continue;
        }
        if known.insert(style.id.as_str(), ()).is_some() {
            return Err(format!("style {} twice", style.id));
        }
        if let Some(parent) = &style.based_on {
            if !known.contains_key(parent.as_str()) {
                return Err(format!(
                    "{} is based on {parent}, which is not there",
                    style.id
                ));
            }
        }
        match style.collection {
            StyleCollection::Paragraph => {
                let mut def = ParagraphStyleDef {
                    self_id: style.id.clone(),
                    name: Some(style.name.clone()),
                    based_on: style.based_on.clone(),
                    ..ParagraphStyleDef::default()
                };
                for p in &style.props {
                    if !paragraph_style_prop(&mut def, p) {
                        return Err(format!("{}: no field for {}", style.id, p.path));
                    }
                }
                document
                    .styles
                    .paragraph_styles
                    .insert(style.id.clone(), def);
            }
            StyleCollection::Character => {
                let mut def = CharacterStyleDef {
                    self_id: style.id.clone(),
                    name: Some(style.name.clone()),
                    based_on: style.based_on.clone(),
                    ..CharacterStyleDef::default()
                };
                for p in &style.props {
                    if !character_style_prop(&mut def, p) {
                        return Err(format!("{}: no field for {}", style.id, p.path));
                    }
                }
                document
                    .styles
                    .character_styles
                    .insert(style.id.clone(), def);
            }
        }
    }
    Ok(())
}
