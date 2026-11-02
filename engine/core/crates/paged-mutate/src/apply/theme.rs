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

use paged_model::{Theme, ThemeColor, ThemeFonts, THEME_SLOTS};
use paged_scene::Document;

use crate::error::OperationError;
use crate::operation::{AppliedOperation, InvalidationHint, Operation, ThemeFontsSpec, ThemeSpec};

fn refuse(msg: impl Into<String>) -> OperationError {
    OperationError::InvalidDocumentMetadata { reason: msg.into() }
}

fn capture(doc: &Document) -> Operation {
    let followers: Vec<(&String, &Vec<f32>)> = doc
        .palette
        .colors
        .iter()
        .filter(|(_, c)| c.theme_ref.is_some())
        .map(|(id, c)| (id, &c.value))
        .collect();
    Operation::RestoreTheme {
        // Plain data: serializing it cannot fail.
        theme_json: doc
            .theme
            .as_ref()
            .map(|t| serde_json::to_string(t).expect("model data serializes")),
        swatches_json: Some(serde_json::to_string(&followers).expect("model data serializes")),
    }
}

/// The swatches that follow a theme slot take their colour under the
/// document's theme (a slot the theme lacks leaves its swatch as it is).
fn recolour(doc: &mut Document) {
    let Some(theme) = &doc.theme else {
        return;
    };
    for c in doc.palette.colors.values_mut() {
        let Some(rgb) = c.theme_ref.as_ref().and_then(|r| theme.resolve(r)) else {
            continue;
        };
        c.value = rgb.iter().map(|b| *b as f32).collect();
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
) -> Result<AppliedOperation, OperationError> {
    let theme: Option<Theme> = theme_json
        .map(serde_json::from_str)
        .transpose()
        .map_err(|e| refuse(format!("theme: {e}")))?;
    let swatches: Option<Vec<(String, Vec<f32>)>> = swatches_json
        .map(serde_json::from_str)
        .transpose()
        .map_err(|e| refuse(format!("theme swatches: {e}")))?;
    let inverse = capture(doc);
    doc.theme = theme;
    for (id, value) in swatches.into_iter().flatten() {
        if let Some(c) = doc.palette.colors.get_mut(&id) {
            c.value = value;
        }
    }
    Ok(applied(
        Operation::RestoreTheme {
            theme_json: theme_json.map(str::to_string),
            swatches_json: swatches_json.map(str::to_string),
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
        } = a.inverse
        else {
            panic!("inverse is RestoreTheme");
        };
        apply_restore(doc, theme_json.as_deref(), swatches_json.as_deref()).unwrap();
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
}
