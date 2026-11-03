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

//! Engine ADR 1056 — the document's theme.
//!
//! Every operation here edits `Document::theme` and sets its `edited` flag
//! (the model no longer matches the `source` part, which a writer then
//! patches instead of re-emitting). Each is undone by
//! [`Operation::RestoreTheme`], which carries the theme as it was.

use paged_model::{
    ColorModel, ColorSpace, Theme, ThemeColor, ThemeFontRef, ThemeFonts, ThemeRef, THEME_SLOTS,
};
use paged_scene::Document;

use crate::error::OperationError;
use crate::operation::{
    AppliedOperation, InvalidationHint, Operation, StyleCollection, ThemeFontsSpec,
    ThemeSlotSwatchSpec, ThemeSpec,
};

fn refuse(msg: impl Into<String>) -> OperationError {
    OperationError::InvalidDocumentMetadata { reason: msg.into() }
}

/// One style's face and theme font reference, as `RestoreTheme` carries it:
/// `(kind, id, font, font_ref)` with `kind` `paragraph` or `character`.
type StyleFont = (String, String, Option<String>, Option<ThemeFontRef>);

/// One swatch's `(id, themeRef, value)`, as `RestoreTheme` carries it.
type SwatchRef = (String, Option<ThemeRef>, Vec<f32>);

fn style_fonts(doc: &Document, extra: &[(&str, &str)]) -> Vec<StyleFont> {
    let mut out = Vec::new();
    for (id, d) in &doc.styles.paragraph_styles {
        if d.font_ref.is_some() || extra.contains(&("paragraph", id.as_str())) {
            out.push(("paragraph".into(), id.clone(), d.font.clone(), d.font_ref));
        }
    }
    for (id, d) in &doc.styles.character_styles {
        if d.font_ref.is_some() || extra.contains(&("character", id.as_str())) {
            out.push(("character".into(), id.clone(), d.font.clone(), d.font_ref));
        }
    }
    out
}

/// The inverse of every theme operation: the theme, every swatch's
/// reference and value, and the styles that follow a font (plus `extra`).
fn capture_with(doc: &Document, extra: &[(&str, &str)]) -> Operation {
    let refs: Vec<(&String, &Option<ThemeRef>, &Vec<f32>)> = doc
        .palette
        .colors
        .iter()
        .map(|(id, c)| (id, &c.theme_ref, &c.value))
        .collect();
    Operation::RestoreTheme {
        // Plain data: serializing it cannot fail.
        theme_json: doc
            .theme
            .as_ref()
            .map(|t| serde_json::to_string(t).expect("model data serializes")),
        swatches_json: None,
        refs_json: Some(serde_json::to_string(&refs).expect("model data serializes")),
        styles_json: Some(
            serde_json::to_string(&style_fonts(doc, extra)).expect("model data serializes"),
        ),
    }
}

fn capture(doc: &Document) -> Operation {
    capture_with(doc, &[])
}

/// The styles that follow a theme font take its Latin face (a set the theme
/// gives no face for leaves its styles as they are).
fn follow_fonts(doc: &mut Document) {
    let Some(theme) = &doc.theme else {
        return;
    };
    let face = |r: Option<ThemeFontRef>| -> Option<String> {
        r.and_then(|r| theme.font_face(r)).map(str::to_string)
    };
    for d in doc.styles.paragraph_styles.values_mut() {
        if let Some(f) = face(d.font_ref) {
            d.font = Some(f);
        }
    }
    for d in doc.styles.character_styles.values_mut() {
        if let Some(f) = face(d.font_ref) {
            d.font = Some(f);
        }
    }
}

/// The swatches that follow a theme slot take their colour under the
/// document's theme (a slot the theme lacks leaves its swatch as it is).
/// A swatch stays in its own space (engine ADR 1057): an RGB follower takes
/// the slot's sRGB bytes, a CMYK process follower the CMYK percentages
/// [`cmyk_of`] derives from them. Nothing else follows (see [`follow_error`]);
/// a reference found on such a swatch (a document written by another tool)
/// is left alone.
fn recolour(doc: &mut Document) {
    let Some(theme) = &doc.theme else {
        return;
    };
    for c in doc.palette.colors.values_mut() {
        let Some(rgb) = c.theme_ref.as_ref().and_then(|r| theme.resolve(r)) else {
            continue;
        };
        match (c.space, c.model) {
            (ColorSpace::Rgb, _) => c.value = rgb.iter().map(|b| *b as f32).collect(),
            (ColorSpace::Cmyk, ColorModel::Process) => c.value = cmyk_of(rgb),
            _ => {}
        }
    }
}

/// The CMYK percentages (0..=100, two decimals) of a slot's sRGB bytes: the
/// inverse of the engine's profile-free conversion, so a document with no
/// CMYK profile shows the follower exactly as the slot, and the numbers are
/// the same on every host and every replay of the operation (ADR 1057). With
/// a CMYK profile configured the renderer sends these numbers through the
/// CMS like any CMYK swatch.
fn cmyk_of(rgb: [u8; 3]) -> Vec<f32> {
    let [c, m, y, k] = paged_color::math::srgb_to_naive_cmyk([
        rgb[0] as f32 / 255.0,
        rgb[1] as f32 / 255.0,
        rgb[2] as f32 / 255.0,
    ]);
    [c, m, y, k]
        .iter()
        .map(|v| (v * 10_000.0).round() / 100.0)
        .collect()
}

/// A slot's sRGB bytes as the CMYK swatch `value` shows them: the engine's
/// profile-free conversion, rounded to the byte.
fn cmyk_to_rgb(value: &[f32]) -> Option<[u8; 3]> {
    if value.len() < 4 {
        return None;
    }
    let [r, g, b] = paged_color::math::naive_cmyk_to_srgb(
        value[0] / 100.0,
        value[1] / 100.0,
        value[2] / 100.0,
        value[3] / 100.0,
    );
    let byte = |v: f32| (v * 255.0).round().clamp(0.0, 255.0) as u8;
    Some([byte(r), byte(g), byte(b)])
}

/// Why a swatch cannot follow a theme slot, in words for the user, or
/// `None` when it can (a process swatch in RGB or CMYK). Spot, mixed ink,
/// Lab, gray and pattern-like swatches never follow: a spot ink IS its
/// colour (a plate), and the others have no inverse the engine could keep
/// exact (engine ADR 1057).
pub(crate) fn follow_error(c: &paged_model::ColorEntry) -> Option<String> {
    let label = c.name.as_deref().unwrap_or(&c.self_id);
    match (c.model, c.space) {
        (ColorModel::Spot, _) => Some(format!(
            "swatch {label:?} is a spot colour; a spot swatch never follows a theme slot \
             (its ink is the colour). Use a process swatch"
        )),
        (ColorModel::MixedInk, _) => Some(format!(
            "swatch {label:?} is a mixed ink; only process RGB and CMYK swatches follow a theme slot"
        )),
        (ColorModel::Process, ColorSpace::Rgb) if c.value.len() >= 3 => None,
        (ColorModel::Process, ColorSpace::Cmyk) if c.value.len() >= 4 => None,
        _ => Some(format!(
            "swatch {label:?} is not a process RGB or CMYK colour; only those follow a theme slot"
        )),
    }
}

fn applied(op: Operation, inverse: Operation) -> AppliedOperation {
    AppliedOperation {
        op,
        inverse,
        invalidation: InvalidationHint::default(),
    }
}

/// `value` as `RRGGBB`, upper case.
fn hex(value: &str) -> Result<String, OperationError> {
    let v = value.trim().trim_start_matches('#');
    if v.len() == 6 && v.bytes().all(|b| b.is_ascii_hexdigit()) {
        Ok(v.to_ascii_uppercase())
    } else {
        Err(refuse(format!("{value:?} is not an RRGGBB colour")))
    }
}

fn slot_rank(slot: &str) -> usize {
    THEME_SLOTS
        .iter()
        .position(|s| *s == slot)
        .unwrap_or(THEME_SLOTS.len())
}

fn fonts_of(spec: &ThemeFontsSpec) -> ThemeFonts {
    let face = |f: &Option<String>| f.clone().filter(|f| !f.is_empty());
    ThemeFonts {
        latin: face(&spec.latin),
        east_asian: face(&spec.east_asian),
        complex: face(&spec.complex),
        scripts: spec
            .scripts
            .iter()
            .filter(|s| !s.script.is_empty() && !s.typeface.is_empty())
            .map(|s| (s.script.clone(), s.typeface.clone()))
            .collect(),
    }
}

pub(super) fn apply_set_theme(
    doc: &mut Document,
    spec: &ThemeSpec,
) -> Result<AppliedOperation, OperationError> {
    let mut colors: Vec<ThemeColor> = Vec::new();
    for c in &spec.colors {
        if !THEME_SLOTS.contains(&c.slot.as_str()) {
            return Err(refuse(format!("{:?} is not a theme colour slot", c.slot)));
        }
        if colors.iter().any(|x| x.slot == c.slot) {
            return Err(refuse(format!("theme slot {:?} given twice", c.slot)));
        }
        colors.push(ThemeColor {
            slot: c.slot.clone(),
            value: hex(&c.value)?,
            system: c.system.clone().filter(|s| !s.is_empty()),
        });
    }
    colors.sort_by_key(|c| slot_rank(&c.slot));
    let inverse = capture(doc);
    // A source given is a file read in (kept, unedited); else the document's
    // own source stays and the theme is edited.
    let imported = spec.source.is_some();
    let source = match &spec.source {
        Some(text) => Some(paged_model::SourceBlob {
            format: paged_model::THEME_SOURCE_OOXML.into(),
            data: text.clone(),
        }),
        None => doc.theme.as_ref().and_then(|t| t.source.clone()),
    };
    doc.theme = Some(Theme {
        name: spec.name.clone(),
        color_scheme_name: spec.color_scheme_name.clone(),
        colors,
        font_scheme_name: spec.font_scheme_name.clone(),
        major: fonts_of(&spec.major),
        minor: fonts_of(&spec.minor),
        source,
        edited: !imported,
    });
    recolour(doc);
    follow_fonts(doc);
    Ok(applied(
        Operation::SetTheme {
            theme: spec.clone(),
        },
        inverse,
    ))
}

pub(super) fn apply_set_color(
    doc: &mut Document,
    slot: &str,
    value: &str,
) -> Result<AppliedOperation, OperationError> {
    if !THEME_SLOTS.contains(&slot) {
        return Err(refuse(format!("{slot:?} is not a theme colour slot")));
    }
    let value = hex(value)?;
    if doc.theme.is_none() {
        return Err(refuse("the document has no theme"));
    }
    let inverse = capture(doc);
    let theme = doc.theme.as_mut().expect("checked above");
    let color = ThemeColor {
        slot: slot.to_string(),
        value: value.clone(),
        // A system colour is the viewer's; an edited slot is a fixed one.
        system: None,
    };
    match theme.colors.iter_mut().find(|c| c.slot == slot) {
        Some(c) => *c = color,
        None => {
            let at = theme
                .colors
                .iter()
                .position(|c| slot_rank(&c.slot) > slot_rank(slot))
                .unwrap_or(theme.colors.len());
            theme.colors.insert(at, color);
        }
    }
    theme.edited = true;
    recolour(doc);
    Ok(applied(
        Operation::SetThemeColor {
            slot: slot.to_string(),
            value,
        },
        inverse,
    ))
}

pub(super) fn apply_set_fonts(
    doc: &mut Document,
    which: &str,
    fonts: &ThemeFontsSpec,
) -> Result<AppliedOperation, OperationError> {
    if which != "major" && which != "minor" {
        return Err(refuse(format!(
            "{which:?} is not a theme font set (major or minor)"
        )));
    }
    if doc.theme.is_none() {
        return Err(refuse("the document has no theme"));
    }
    let inverse = capture(doc);
    let theme = doc.theme.as_mut().expect("checked above");
    let set = fonts_of(fonts);
    if which == "major" {
        theme.major = set;
    } else {
        theme.minor = set;
    }
    theme.edited = true;
    follow_fonts(doc);
    Ok(applied(
        Operation::SetThemeFonts {
            which: which.to_string(),
            fonts: fonts.clone(),
        },
        inverse,
    ))
}

pub(super) fn apply_restore(
    doc: &mut Document,
    theme_json: Option<&str>,
    swatches_json: Option<&str>,
    refs_json: Option<&str>,
    styles_json: Option<&str>,
) -> Result<AppliedOperation, OperationError> {
    let theme: Option<Theme> = theme_json
        .map(serde_json::from_str)
        .transpose()
        .map_err(|e| refuse(format!("theme: {e}")))?;
    let swatches: Option<Vec<(String, Vec<f32>)>> = swatches_json
        .map(serde_json::from_str)
        .transpose()
        .map_err(|e| refuse(format!("theme swatches: {e}")))?;
    let refs: Option<Vec<SwatchRef>> = refs_json
        .map(serde_json::from_str)
        .transpose()
        .map_err(|e| refuse(format!("theme swatch references: {e}")))?;
    let styles: Option<Vec<StyleFont>> = styles_json
        .map(serde_json::from_str)
        .transpose()
        .map_err(|e| refuse(format!("theme styles: {e}")))?;
    // The styles this restore names, so its own inverse puts them back.
    let named: Vec<(&str, &str)> = styles
        .iter()
        .flatten()
        .map(|(k, id, _, _)| (k.as_str(), id.as_str()))
        .collect();
    let inverse = capture_with(doc, &named);
    doc.theme = theme;
    for (id, value) in swatches.into_iter().flatten() {
        if let Some(c) = doc.palette.colors.get_mut(&id) {
            c.value = value;
        }
    }
    for (id, r, value) in refs.into_iter().flatten() {
        if let Some(c) = doc.palette.colors.get_mut(&id) {
            c.theme_ref = r;
            c.value = value;
        }
    }
    for (kind, id, font, font_ref) in styles.into_iter().flatten() {
        match kind.as_str() {
            "paragraph" => {
                if let Some(d) = doc.styles.paragraph_styles.get_mut(&id) {
                    d.font = font;
                    d.font_ref = font_ref;
                }
            }
            _ => {
                if let Some(d) = doc.styles.character_styles.get_mut(&id) {
                    d.font = font;
                    d.font_ref = font_ref;
                }
            }
        }
    }
    Ok(applied(
        Operation::RestoreTheme {
            theme_json: theme_json.map(str::to_string),
            swatches_json: swatches_json.map(str::to_string),
            refs_json: refs_json.map(str::to_string),
            styles_json: styles_json.map(str::to_string),
        },
        inverse,
    ))
}

/// Engine ADR 1057 — the tints a swatch is matched against when a theme is
/// made from swatches: the DrawingML transform chains behind Office's
/// "Lighter 80 / 60 / 40 %" and "Darker 25 / 50 %" names.
const TINT_LADDER: [&[(&str, i32)]; 6] = [
    &[],
    &[("lumMod", 20_000), ("lumOff", 80_000)],
    &[("lumMod", 40_000), ("lumOff", 60_000)],
    &[("lumMod", 60_000), ("lumOff", 40_000)],
    &[("lumMod", 75_000)],
    &[("lumMod", 50_000)],
];

/// The sRGB bytes of a swatch that can follow a slot: a process RGB swatch's
/// own, a process CMYK swatch's through the profile-free conversion
/// ([`cmyk_to_rgb`]); `None` for any other (see [`follow_error`]).
fn process_rgb(c: &paged_model::ColorEntry) -> Option<[u8; 3]> {
    if follow_error(c).is_some() {
        return None;
    }
    if c.space == ColorSpace::Cmyk {
        return cmyk_to_rgb(&c.value);
    }
    let b = |v: f32| v.round().clamp(0.0, 255.0) as u8;
    Some([b(c.value[0]), b(c.value[1]), b(c.value[2])])
}

pub(super) fn apply_create_from_swatches(
    doc: &mut Document,
    name: &str,
    slots: &[ThemeSlotSwatchSpec],
    relink: bool,
) -> Result<AppliedOperation, OperationError> {
    if doc.theme.is_some() {
        return Err(refuse(
            "the document already has a theme (replace it with setTheme)",
        ));
    }
    if slots.is_empty() {
        return Err(refuse("no theme slot was given a swatch"));
    }
    let mut colors: Vec<ThemeColor> = Vec::new();
    let mut assigned: Vec<(String, &str)> = Vec::new();
    for s in slots {
        if !THEME_SLOTS.contains(&s.slot.as_str()) {
            return Err(refuse(format!("{:?} is not a theme colour slot", s.slot)));
        }
        if colors.iter().any(|x| x.slot == s.slot) {
            return Err(refuse(format!("theme slot {:?} given twice", s.slot)));
        }
        let id = doc
            .palette
            .colors
            .iter()
            .find(|(id, c)| **id == s.swatch || c.name.as_deref() == Some(s.swatch.as_str()))
            .map(|(id, _)| id.clone())
            .ok_or_else(|| refuse(format!("no swatch {:?}", s.swatch)))?;
        let rgb = process_rgb(&doc.palette.colors[&id])
            .ok_or_else(|| refuse(follow_error(&doc.palette.colors[&id]).unwrap_or_default()))?;
        colors.push(ThemeColor {
            slot: s.slot.clone(),
            value: format!("{:02X}{:02X}{:02X}", rgb[0], rgb[1], rgb[2]),
            system: None,
        });
        assigned.push((id, s.slot.as_str()));
    }
    colors.sort_by_key(|c| slot_rank(&c.slot));
    let inverse = capture(doc);
    let theme = Theme {
        name: if name.is_empty() {
            "Theme".into()
        } else {
            name.into()
        },
        colors,
        edited: true,
        ..Theme::default()
    };
    // The swatches the user named follow their slot exactly.
    for (id, slot) in &assigned {
        if let Some(c) = doc.palette.colors.get_mut(id) {
            c.theme_ref = Some(ThemeRef {
                slot: (*slot).to_string(),
                transforms: Vec::new(),
            });
        }
    }
    if relink {
        for (id, c) in doc.palette.colors.iter_mut() {
            if c.theme_ref.is_some() || assigned.iter().any(|(a, _)| a == id) {
                continue;
            }
            let Some(rgb) = process_rgb(c) else {
                continue;
            };
            'slots: for t in &theme.colors {
                for chain in TINT_LADDER {
                    let r = ThemeRef {
                        slot: t.slot.clone(),
                        transforms: chain.iter().map(|(n, v)| ((*n).to_string(), *v)).collect(),
                    };
                    if theme.resolve(&r) == Some(rgb) {
                        c.theme_ref = Some(r);
                        break 'slots;
                    }
                }
            }
        }
    }
    doc.theme = Some(theme);
    Ok(applied(
        Operation::CreateThemeFromSwatches {
            name: name.to_string(),
            slots: slots.to_vec(),
            relink,
        },
        inverse,
    ))
}

pub(super) fn apply_set_style_font(
    doc: &mut Document,
    collection: StyleCollection,
    style_id: &str,
    which: Option<&str>,
) -> Result<AppliedOperation, OperationError> {
    let r = match which {
        None => None,
        Some(w) => Some(
            ThemeFontRef::parse(w)
                .ok_or_else(|| refuse(format!("{w:?} is not a theme font set (major or minor)")))?,
        ),
    };
    let kind = match collection {
        StyleCollection::Paragraph => "paragraph",
        StyleCollection::Character => "character",
        _ => return Err(refuse("only paragraph and character styles follow a font")),
    };
    let exists = match collection {
        StyleCollection::Paragraph => doc.styles.paragraph_styles.contains_key(style_id),
        _ => doc.styles.character_styles.contains_key(style_id),
    };
    if !exists {
        return Err(refuse(format!("no {kind} style {style_id:?}")));
    }
    if r.is_some() && doc.theme.is_none() {
        return Err(refuse("the document has no theme"));
    }
    let inverse = capture_with(doc, &[(kind, style_id)]);
    let face = r.and_then(|r| {
        doc.theme
            .as_ref()
            .and_then(|t| t.font_face(r))
            .map(str::to_string)
    });
    match collection {
        StyleCollection::Paragraph => {
            let d = doc
                .styles
                .paragraph_styles
                .get_mut(style_id)
                .expect("checked");
            d.font_ref = r;
            if face.is_some() {
                d.font = face;
            }
        }
        _ => {
            let d = doc
                .styles
                .character_styles
                .get_mut(style_id)
                .expect("checked");
            d.font_ref = r;
            if face.is_some() {
                d.font = face;
            }
        }
    }
    Ok(applied(
        Operation::SetStyleThemeFont {
            collection,
            style_id: style_id.to_string(),
            which: which.map(str::to_string),
        },
        inverse,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::operation::{ScriptFontSpec, ThemeColorSpec};
    use paged_model::{SourceBlob, THEME_SOURCE_OOXML};

    fn doc_with_theme() -> Document {
        Document {
            theme: Some(Theme {
                name: "Office".into(),
                colors: vec![
                    ThemeColor {
                        slot: "dk1".into(),
                        value: "000000".into(),
                        system: Some("windowText".into()),
                    },
                    ThemeColor {
                        slot: "accent1".into(),
                        value: "156082".into(),
                        system: None,
                    },
                ],
                source: Some(SourceBlob {
                    format: THEME_SOURCE_OOXML.into(),
                    data: "<a:theme/>".into(),
                }),
                ..Theme::default()
            }),
            ..Document::default()
        }
    }

    fn undo(doc: &mut Document, a: AppliedOperation) {
        let Operation::RestoreTheme {
            theme_json,
            swatches_json,
            refs_json,
            styles_json,
        } = a.inverse
        else {
            panic!("inverse is RestoreTheme");
        };
        apply_restore(
            doc,
            theme_json.as_deref(),
            swatches_json.as_deref(),
            refs_json.as_deref(),
            styles_json.as_deref(),
        )
        .unwrap();
    }

    #[test]
    fn a_slot_colour_marks_the_theme_edited_and_keeps_its_source() {
        let mut doc = doc_with_theme();
        assert!(!doc.theme.as_ref().unwrap().edited);
        let a = apply_set_color(&mut doc, "accent1", "#ff0000").unwrap();
        let t = doc.theme.as_ref().unwrap();
        assert_eq!(t.color("accent1").unwrap().value, "FF0000");
        assert!(t.edited);
        assert_eq!(t.source.as_ref().unwrap().data, "<a:theme/>");
        undo(&mut doc, a);
        let t = doc.theme.as_ref().unwrap();
        assert_eq!(t.color("accent1").unwrap().value, "156082");
        assert!(!t.edited);
    }

    #[test]
    fn an_edited_system_slot_becomes_a_fixed_colour_and_a_new_slot_keeps_scheme_order() {
        let mut doc = doc_with_theme();
        apply_set_color(&mut doc, "dk1", "111111").unwrap();
        apply_set_color(&mut doc, "lt1", "FFFFFF").unwrap();
        let t = doc.theme.as_ref().unwrap();
        assert_eq!(t.color("dk1").unwrap().system, None);
        let slots: Vec<&str> = t.colors.iter().map(|c| c.slot.as_str()).collect();
        assert_eq!(slots, ["dk1", "lt1", "accent1"]);
    }

    #[test]
    fn bad_input_is_refused_and_changes_nothing() {
        let mut doc = doc_with_theme();
        assert!(apply_set_color(&mut doc, "accent9", "FF0000").is_err());
        assert!(apply_set_color(&mut doc, "accent1", "red").is_err());
        assert!(apply_set_fonts(&mut doc, "heading", &ThemeFontsSpec::default()).is_err());
        assert!(!doc.theme.as_ref().unwrap().edited);
        let mut none = Document::default();
        assert!(apply_set_color(&mut none, "accent1", "FF0000").is_err());
        assert!(apply_set_fonts(&mut none, "major", &ThemeFontsSpec::default()).is_err());
    }

    #[test]
    fn swatches_that_follow_a_slot_are_recoloured_in_the_same_step_and_undone_with_it() {
        use paged_model::{ColorEntry, ColorModel, ColorSpace, ThemeRef};
        let mut doc = doc_with_theme();
        let entry = |id: &str, r: ThemeRef, v: Vec<f32>| ColorEntry {
            self_id: id.into(),
            name: None,
            space: ColorSpace::Rgb,
            value: v,
            model: ColorModel::Process,
            alternate_space: None,
            alternate_value: Vec::new(),
            tint: None,
            alpha: None,
            theme_ref: Some(r),
        };
        let slot = |s: &str, t: Vec<(String, i32)>| ThemeRef {
            slot: s.into(),
            transforms: t,
        };
        doc.palette.colors.insert(
            "Color/accent1".into(),
            entry(
                "Color/accent1",
                slot("accent1", vec![]),
                vec![21.0, 96.0, 130.0],
            ),
        );
        doc.palette.colors.insert(
            "Color/accent1 lighter".into(),
            entry(
                "Color/accent1 lighter",
                slot(
                    "accent1",
                    vec![("lumMod".into(), 60_000), ("lumOff".into(), 40_000)],
                ),
                vec![0.0; 3],
            ),
        );
        // A literal swatch is left alone.
        let mut plain = entry("Color/Plain", slot("accent1", vec![]), vec![1.0, 2.0, 3.0]);
        plain.theme_ref = None;
        doc.palette.colors.insert("Color/Plain".into(), plain);

        let a = apply_set_color(&mut doc, "accent1", "FF0000").unwrap();
        let v = |d: &Document, id: &str| d.palette.colors[id].value.clone();
        assert_eq!(v(&doc, "Color/accent1"), vec![255.0, 0.0, 0.0]);
        assert_eq!(v(&doc, "Color/accent1 lighter"), vec![255.0, 102.0, 102.0]);
        assert_eq!(v(&doc, "Color/Plain"), vec![1.0, 2.0, 3.0]);
        undo(&mut doc, a);
        assert_eq!(v(&doc, "Color/accent1"), vec![21.0, 96.0, 130.0]);
        assert_eq!(v(&doc, "Color/accent1 lighter"), vec![0.0; 3]);
    }

    #[test]
    fn a_created_swatch_with_a_reference_follows_the_slot_and_keeps_it_through_delete_and_undo() {
        use crate::apply::layer::{apply_create_swatch, apply_delete_swatch};
        use crate::operation::{SwatchSpec, ThemeRefSpec};
        let mut doc = doc_with_theme();
        let spec = SwatchSpec {
            self_id: Some("Color/t".into()),
            name: None,
            space: "RGB".into(),
            value: vec![21.0, 96.0, 130.0],
            model: None,
            alternate_space: None,
            alternate_value: Vec::new(),
            tint: None,
            alpha: None,
            pattern: None,
            theme_ref: Some(ThemeRefSpec {
                slot: "accent1".into(),
                transforms: vec![],
            }),
        };
        apply_create_swatch(&mut doc, &spec).unwrap();
        // An unknown slot is no reference.
        let mut bad = spec.clone();
        bad.self_id = Some("Color/bad".into());
        bad.theme_ref.as_mut().unwrap().slot = "accent9".into();
        apply_create_swatch(&mut doc, &bad).unwrap();
        assert!(doc.palette.colors["Color/bad"].theme_ref.is_none());
        apply_set_color(&mut doc, "accent1", "00FF00").unwrap();
        assert_eq!(doc.palette.colors["Color/t"].value, vec![0.0, 255.0, 0.0]);
        let del = apply_delete_swatch(&mut doc, "Color/t").unwrap();
        assert!(!doc.palette.colors.contains_key("Color/t"));
        let Operation::CreateSwatch { spec } = del.inverse else {
            panic!("inverse is CreateSwatch");
        };
        apply_create_swatch(&mut doc, &spec).unwrap();
        assert_eq!(
            doc.palette.colors["Color/t"]
                .theme_ref
                .as_ref()
                .unwrap()
                .slot,
            "accent1"
        );
    }

    #[test]
    fn a_theme_given_with_its_source_is_a_file_read_in_and_not_edited() {
        let mut doc = doc_with_theme();
        let spec = ThemeSpec {
            name: "Other".into(),
            source: Some("<a:theme name=\"Other\"/>".into()),
            ..ThemeSpec::default()
        };
        apply_set_theme(&mut doc, &spec).unwrap();
        let t = doc.theme.as_ref().unwrap();
        assert!(!t.edited);
        assert_eq!(t.source.as_ref().unwrap().data, "<a:theme name=\"Other\"/>");
    }

    #[test]
    fn fonts_replace_a_set_and_undo_restores_it() {
        let mut doc = doc_with_theme();
        let a = apply_set_fonts(
            &mut doc,
            "major",
            &ThemeFontsSpec {
                latin: Some("Georgia".into()),
                scripts: vec![ScriptFontSpec {
                    script: "Jpan".into(),
                    typeface: "Yu Gothic".into(),
                }],
                ..Default::default()
            },
        )
        .unwrap();
        let t = doc.theme.as_ref().unwrap();
        assert_eq!(t.major.latin.as_deref(), Some("Georgia"));
        assert_eq!(t.major.scripts.len(), 1);
        undo(&mut doc, a);
        assert_eq!(doc.theme.as_ref().unwrap().major, ThemeFonts::default());
    }

    #[test]
    fn set_theme_creates_one_and_keeps_the_source_of_the_one_it_replaces() {
        let mut none = Document::default();
        let spec = ThemeSpec {
            name: "Mine".into(),
            colors: vec![
                ThemeColorSpec {
                    slot: "accent2".into(),
                    value: "00ff00".into(),
                    system: None,
                },
                ThemeColorSpec {
                    slot: "dk1".into(),
                    value: "000000".into(),
                    system: None,
                },
            ],
            ..Default::default()
        };
        let a = apply_set_theme(&mut none, &spec).unwrap();
        let t = none.theme.as_ref().unwrap();
        assert_eq!(t.colors[0].slot, "dk1");
        assert_eq!(t.colors[1].value, "00FF00");
        assert!(t.source.is_none());
        undo(&mut none, a);
        assert!(none.theme.is_none());

        let mut doc = doc_with_theme();
        apply_set_theme(&mut doc, &spec).unwrap();
        assert_eq!(
            doc.theme.as_ref().unwrap().source.as_ref().unwrap().data,
            "<a:theme/>"
        );
        let mut twice = spec.clone();
        twice.colors.push(twice.colors[0].clone());
        assert!(apply_set_theme(&mut doc, &twice).is_err());
    }

    fn rgb_swatch(doc: &mut Document, id: &str, v: [f32; 3]) {
        use paged_model::ColorEntry;
        doc.palette.colors.insert(
            id.into(),
            ColorEntry {
                self_id: id.into(),
                name: Some(id.into()),
                space: ColorSpace::Rgb,
                value: v.to_vec(),
                model: ColorModel::Process,
                alternate_space: None,
                alternate_value: Vec::new(),
                tint: None,
                alpha: None,
                theme_ref: None,
            },
        );
    }

    #[test]
    fn a_theme_is_made_from_swatches_relinks_their_tints_and_undoes_in_one_step() {
        let mut doc = Document::default();
        rgb_swatch(&mut doc, "Brand", [21.0, 96.0, 130.0]);
        rgb_swatch(&mut doc, "Ink", [0.0, 0.0, 0.0]);
        rgb_swatch(&mut doc, "Odd", [1.0, 2.0, 3.0]);
        // The 60 % lighter tint of Brand, as the engine computes it.
        let probe = Theme {
            colors: vec![ThemeColor {
                slot: "accent1".into(),
                value: "156082".into(),
                system: None,
            }],
            ..Theme::default()
        };
        let tint = probe
            .resolve(&ThemeRef {
                slot: "accent1".into(),
                transforms: vec![("lumMod".into(), 60_000), ("lumOff".into(), 40_000)],
            })
            .unwrap();
        rgb_swatch(&mut doc, "Tint", tint.map(f32::from));
        let slots = [
            ThemeSlotSwatchSpec {
                slot: "accent1".into(),
                swatch: "Brand".into(),
            },
            ThemeSlotSwatchSpec {
                slot: "dk1".into(),
                swatch: "Ink".into(),
            },
        ];
        let a = apply_create_from_swatches(&mut doc, "Mine", &slots, true).unwrap();
        let t = doc.theme.as_ref().unwrap();
        assert_eq!(t.color("accent1").unwrap().value, "156082");
        let slot = |id: &str| doc.palette.colors[id].theme_ref.clone();
        assert_eq!(slot("Brand").unwrap().slot, "accent1");
        assert_eq!(slot("Tint").unwrap().transforms.len(), 2);
        assert!(slot("Odd").is_none());
        // A second theme is refused; recolouring follows.
        assert!(apply_create_from_swatches(&mut doc, "x", &slots, true).is_err());
        apply_set_color(&mut doc, "accent1", "FF0000").unwrap();
        assert_eq!(doc.palette.colors["Brand"].value, vec![255.0, 0.0, 0.0]);
        // Undo of the colour then of the creation: no theme, no references.
        let mut again = Document::default();
        rgb_swatch(&mut again, "Brand", [21.0, 96.0, 130.0]);
        let b = apply_create_from_swatches(&mut again, "Mine", &slots[..1], false).unwrap();
        undo(&mut again, b);
        assert!(again.theme.is_none());
        assert!(again.palette.colors["Brand"].theme_ref.is_none());
        let _ = a;
    }

    #[test]
    fn a_theme_from_swatches_refuses_spot_malformed_unknown_and_empty_input() {
        let mut doc = Document::default();
        // A CMYK swatch with three values is malformed, not followable.
        rgb_swatch(&mut doc, "Cmyk", [0.0, 0.0, 0.0]);
        doc.palette.colors.get_mut("Cmyk").unwrap().space = ColorSpace::Cmyk;
        rgb_swatch(&mut doc, "Spot", [0.0, 0.0, 0.0]);
        doc.palette.colors.get_mut("Spot").unwrap().model = ColorModel::Spot;
        let one = |slot: &str, swatch: &str| {
            vec![ThemeSlotSwatchSpec {
                slot: slot.into(),
                swatch: swatch.into(),
            }]
        };
        assert!(apply_create_from_swatches(&mut doc, "", &[], true).is_err());
        assert!(apply_create_from_swatches(&mut doc, "", &one("accent1", "Cmyk"), true).is_err());
        let spot = apply_create_from_swatches(&mut doc, "", &one("accent1", "Spot"), true)
            .expect_err("a spot swatch never follows a slot")
            .to_string();
        assert!(spot.contains("spot"), "{spot}");
        assert!(apply_create_from_swatches(&mut doc, "", &one("accent9", "Cmyk"), true).is_err());
        assert!(apply_create_from_swatches(&mut doc, "", &one("accent1", "None"), true).is_err());
        assert!(doc.theme.is_none());
    }

    fn cmyk_swatch(doc: &mut Document, id: &str, v: [f32; 4]) {
        rgb_swatch(doc, id, [0.0; 3]);
        let c = doc.palette.colors.get_mut(id).unwrap();
        c.space = ColorSpace::Cmyk;
        c.value = v.to_vec();
    }

    #[test]
    fn a_cmyk_swatch_takes_a_slot_stays_cmyk_when_the_slot_recolours_and_undoes_with_it() {
        let mut doc = Document::default();
        // The naive CMYK of 156082 (so the slot takes exactly that colour).
        cmyk_swatch(&mut doc, "Brand", [83.85, 26.15, 0.0, 49.02]);
        cmyk_swatch(&mut doc, "Ink", [0.0, 0.0, 0.0, 100.0]);
        let slots = [
            ThemeSlotSwatchSpec {
                slot: "accent1".into(),
                swatch: "Brand".into(),
            },
            ThemeSlotSwatchSpec {
                slot: "dk1".into(),
                swatch: "Ink".into(),
            },
        ];
        let a = apply_create_from_swatches(&mut doc, "Mine", &slots, true).unwrap();
        let t = doc.theme.as_ref().unwrap();
        assert_eq!(t.color("accent1").unwrap().value, "156082");
        assert_eq!(t.color("dk1").unwrap().value, "000000");
        assert_eq!(
            doc.palette.colors["Brand"].theme_ref.as_ref().unwrap().slot,
            "accent1"
        );
        // The slot recolours: the follower stays CMYK, with the slot's colour.
        let b = apply_set_color(&mut doc, "accent1", "FF0000").unwrap();
        let brand = &doc.palette.colors["Brand"];
        assert_eq!(brand.space, ColorSpace::Cmyk);
        assert_eq!(brand.value, vec![0.0, 100.0, 100.0, 0.0]);
        assert_eq!(cmyk_to_rgb(&brand.value), Some([255, 0, 0]));
        // A CMYK follower of a tint resolves through the same chain.
        apply_set_color(&mut doc, "accent1", "156082").unwrap();
        assert_eq!(
            cmyk_to_rgb(&doc.palette.colors["Brand"].value),
            Some([21, 96, 130])
        );
        undo(&mut doc, b);
        assert_eq!(doc.palette.colors["Brand"].space, ColorSpace::Cmyk);
        undo(&mut doc, a);
        assert!(doc.theme.is_none());
        assert!(doc.palette.colors["Brand"].theme_ref.is_none());
        assert_eq!(
            doc.palette.colors["Brand"].value,
            vec![83.85, 26.15, 0.0, 49.02]
        );
    }

    #[test]
    fn a_cmyk_swatch_that_is_an_exact_tint_of_a_slot_is_relinked_and_a_spot_never_is() {
        let mut doc = Document::default();
        rgb_swatch(&mut doc, "Brand", [21.0, 96.0, 130.0]);
        let probe = Theme {
            colors: vec![ThemeColor {
                slot: "accent1".into(),
                value: "156082".into(),
                system: None,
            }],
            ..Theme::default()
        };
        let tint = probe
            .resolve(&ThemeRef {
                slot: "accent1".into(),
                transforms: vec![("lumMod".into(), 60_000), ("lumOff".into(), 40_000)],
            })
            .unwrap();
        let v = cmyk_of(tint);
        cmyk_swatch(&mut doc, "Tint", [v[0], v[1], v[2], v[3]]);
        cmyk_swatch(&mut doc, "Plain", [10.0, 20.0, 30.0, 40.0]);
        // A spot swatch with the same numbers as the tint: never linked.
        cmyk_swatch(&mut doc, "SpotTint", [v[0], v[1], v[2], v[3]]);
        doc.palette.colors.get_mut("SpotTint").unwrap().model = ColorModel::Spot;
        let slots = [ThemeSlotSwatchSpec {
            slot: "accent1".into(),
            swatch: "Brand".into(),
        }];
        apply_create_from_swatches(&mut doc, "Mine", &slots, true).unwrap();
        let r = |id: &str| doc.palette.colors[id].theme_ref.clone();
        assert_eq!(r("Tint").unwrap().transforms.len(), 2);
        assert!(r("Plain").is_none());
        assert!(r("SpotTint").is_none());
        // The tint follows a recolour as CMYK.
        apply_set_color(&mut doc, "accent1", "FF0000").unwrap();
        let t = &doc.palette.colors["Tint"];
        assert_eq!(t.space, ColorSpace::Cmyk);
        assert_eq!(t.value.len(), 4);
        assert_eq!(cmyk_to_rgb(&t.value), Some([255, 102, 102]));
        // The spot swatch is untouched.
        assert_eq!(
            doc.palette.colors["SpotTint"].value,
            vec![v[0], v[1], v[2], v[3]]
        );
    }

    #[test]
    fn a_spot_swatch_cannot_be_made_to_follow_a_slot_by_create_or_edit() {
        use crate::apply::layer::{apply_create_swatch, apply_edit_swatch};
        use crate::operation::{SwatchSpec, ThemeRefSpec};
        let mut doc = doc_with_theme();
        let spec = |model: &str, space: &str, value: Vec<f32>| SwatchSpec {
            self_id: Some("Color/s".into()),
            name: None,
            space: space.into(),
            value,
            model: Some(model.into()),
            alternate_space: None,
            alternate_value: Vec::new(),
            tint: None,
            alpha: None,
            pattern: None,
            theme_ref: Some(ThemeRefSpec {
                slot: "accent1".into(),
                transforms: Vec::new(),
            }),
        };
        let err = apply_create_swatch(&mut doc, &spec("Spot", "CMYK", vec![0.0, 0.0, 0.0, 100.0]))
            .expect_err("refused")
            .to_string();
        assert!(err.contains("spot"), "{err}");
        assert!(!doc.palette.colors.contains_key("Color/s"));
        // A CMYK process follower is accepted; making it a spot is refused.
        apply_create_swatch(
            &mut doc,
            &spec("Process", "CMYK", vec![0.0, 0.0, 0.0, 100.0]),
        )
        .unwrap();
        let mut edit = spec("Spot", "CMYK", vec![0.0, 0.0, 0.0, 100.0]);
        edit.theme_ref = None;
        assert!(apply_edit_swatch(&mut doc, "Color/s", &edit).is_err());
        assert_eq!(doc.palette.colors["Color/s"].model, ColorModel::Process);
    }

    #[test]
    fn a_style_follows_the_font_scheme_and_undo_restores_face_and_reference() {
        use paged_model::CharacterStyleDef;
        let mut doc = doc_with_theme();
        doc.styles.character_styles.insert(
            "CharacterStyle/Head".into(),
            CharacterStyleDef {
                self_id: "CharacterStyle/Head".into(),
                font: Some("Times".into()),
                ..Default::default()
            },
        );
        apply_set_fonts(
            &mut doc,
            "major",
            &ThemeFontsSpec {
                latin: Some("Georgia".into()),
                ..Default::default()
            },
        )
        .unwrap();
        // Not following yet: untouched.
        let font = |d: &Document| {
            d.styles.character_styles["CharacterStyle/Head"]
                .font
                .clone()
        };
        assert_eq!(font(&doc).as_deref(), Some("Times"));
        let a = apply_set_style_font(
            &mut doc,
            StyleCollection::Character,
            "CharacterStyle/Head",
            Some("major"),
        )
        .unwrap();
        assert_eq!(font(&doc).as_deref(), Some("Georgia"));
        let b = apply_set_fonts(
            &mut doc,
            "major",
            &ThemeFontsSpec {
                latin: Some("Verdana".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(font(&doc).as_deref(), Some("Verdana"));
        undo(&mut doc, b);
        assert_eq!(font(&doc).as_deref(), Some("Georgia"));
        undo(&mut doc, a);
        assert_eq!(font(&doc).as_deref(), Some("Times"));
        assert!(doc.styles.character_styles["CharacterStyle/Head"]
            .font_ref
            .is_none());
        // Bad input.
        assert!(
            apply_set_style_font(&mut doc, StyleCollection::Object, "x", Some("major")).is_err()
        );
        assert!(apply_set_style_font(
            &mut doc,
            StyleCollection::Character,
            "CharacterStyle/Head",
            Some("heading")
        )
        .is_err());
        let mut none = Document::default();
        assert!(apply_set_style_font(&mut none, StyleCollection::Paragraph, "x", None).is_err());
    }
}
