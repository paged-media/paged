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

//! Engine ADR 1057 over the wire: a theme is made from swatches (one undo
//! step), the presets are listed, and the theme survives IDML export and
//! re-import through the document label while InDesign-visible output stays
//! plain swatches.
// Test names carry their feature row (`…__feat__…`).
#![allow(non_snake_case)]

use paged_canvas::channel::CollectionName;
use paged_canvas::{CanvasModel, CanvasOptions, Mutation};
use paged_mutate::operation::{ThemeColorSpec, ThemeFontsSpec, ThemeSlotSwatchSpec, ThemeSpec};
use paged_mutate::SwatchSpec;

fn model() -> CanvasModel {
    let idml = paged_gen::write_idml(&paged_gen::samples::notes::build()).expect("idml");
    CanvasModel::load("doc", &idml, CanvasOptions::default()).expect("load")
}

fn swatch(id: &str, rgb: [f32; 3]) -> Mutation {
    Mutation::CreateSwatch {
        spec: SwatchSpec {
            self_id: Some(id.into()),
            name: Some(id.trim_start_matches("Color/").into()),
            space: "RGB".into(),
            value: rgb.to_vec(),
            model: None,
            alternate_space: None,
            alternate_value: Vec::new(),
            tint: None,
            alpha: None,
            pattern: None,
            theme_ref: None,
        },
    }
}

#[test]
fn the_presets_are_listed_once__feat__core_theme() {
    let rows = model().collection(CollectionName::ThemePresets);
    let ids: Vec<&str> = rows
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, ["office-2013", "office-2023"]);
    assert_eq!(rows[0]["theme"]["colors"][4]["value"], "4472C4");
}

#[test]
fn a_theme_is_made_from_swatches_in_one_undo_step__feat__core_theme() {
    let mut m = model();
    m.apply_mutation(&swatch("Color/Brand", [21.0, 96.0, 130.0]))
        .unwrap();
    let before = m.scene().canonical_hash();
    m.apply_mutation(&Mutation::CreateThemeFromSwatches {
        name: "Mine".into(),
        slots: vec![ThemeSlotSwatchSpec {
            slot: "accent1".into(),
            swatch: "Color/Brand".into(),
        }],
        relink: true,
    })
    .unwrap();
    let t = m.scene().theme.as_ref().unwrap();
    assert_eq!(t.color("accent1").unwrap().value, "156082");
    assert_eq!(
        m.scene().palette.colors["Color/Brand"]
            .theme_ref
            .as_ref()
            .unwrap()
            .slot,
        "accent1"
    );
    m.undo().expect("undo");
    assert!(m.scene().theme.is_none());
    assert_eq!(m.scene().canonical_hash(), before);
}

#[test]
fn the_theme_survives_an_idml_round_trip_as_plain_swatches_plus_a_label__feat__core_theme() {
    let mut m = model();
    m.apply_mutation(&Mutation::SetTheme {
        theme: ThemeSpec {
            name: "Round".into(),
            colors: vec![ThemeColorSpec {
                slot: "accent1".into(),
                value: "156082".into(),
                system: None,
            }],
            major: ThemeFontsSpec {
                latin: Some("Georgia".into()),
                ..Default::default()
            },
            ..Default::default()
        },
    })
    .unwrap();
    m.apply_mutation(&swatch("Color/Brand", [21.0, 96.0, 130.0]))
        .unwrap();
    m.apply_mutation(&Mutation::CreateThemeFromSwatches {
        name: "x".into(),
        slots: vec![],
        relink: false,
    })
    .expect_err("a document with a theme refuses");
    // The export reports the theme as written plain.
    let losses = m.idml_export_losses();
    assert!(
        losses
            .iter()
            .any(|l| l.contains("theme \"Round\" is written as plain swatches")),
        "{losses:?}"
    );
    // A swatch that follows the slot, set up with the slot's own colour.
    let idml = m.export_idml().expect("export");
    let back = CanvasModel::load("doc", &idml, CanvasOptions::default()).expect("reload");
    let t = back.scene().theme.as_ref().expect("the theme came back");
    assert_eq!(t.name, "Round");
    assert_eq!(t.major.latin.as_deref(), Some("Georgia"));
    // Re-exporting the reloaded document gives the same theme again.
    let again = CanvasModel::load(
        "doc",
        &back.export_idml().unwrap(),
        CanvasOptions::default(),
    )
    .expect("reload twice");
    assert_eq!(again.scene().theme.as_ref().unwrap().name, "Round");
    assert!(back.import_notes().is_empty(), "{:?}", back.import_notes());
}

#[test]
fn a_document_without_a_theme_exports_no_theme_line__feat__core_theme() {
    let m = model();
    assert!(!m.idml_export_losses().iter().any(|l| l.contains("theme")));
}
