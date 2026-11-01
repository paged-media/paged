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

//! Engine ADR 1056 over the wire: the document's theme is set, recoloured and
//! given fonts by named, undoable steps; the `theme` collection reads it; it
//! survives the native `.paged` encoding.
// Test names carry their feature row (`…__feat__…`).
#![allow(non_snake_case)]

use paged_canvas::channel::CollectionName;
use paged_canvas::{CanvasModel, CanvasOptions, Mutation};
use paged_mutate::operation::{ScriptFontSpec, ThemeColorSpec, ThemeFontsSpec, ThemeSpec};

fn model() -> CanvasModel {
    let idml = paged_gen::write_idml(&paged_gen::samples::notes::build()).expect("idml");
    CanvasModel::load("doc", &idml, CanvasOptions::default()).expect("load")
}

fn theme() -> ThemeSpec {
    ThemeSpec {
        name: "Probe".into(),
        colors: vec![ThemeColorSpec {
            slot: "accent1".into(),
            value: "ff0000".into(),
            system: None,
        }],
        major: ThemeFontsSpec {
            latin: Some("Georgia".into()),
            ..Default::default()
        },
        ..Default::default()
    }
}

#[test]
fn a_document_without_a_theme_lists_none__feat__core_theme() {
    let m = model();
    assert_eq!(
        m.collection(CollectionName::Theme),
        serde_json::Value::Array(Vec::new())
    );
}

#[test]
fn the_theme_is_set_recoloured_and_undone_step_by_step__feat__core_theme() {
    let mut m = model();
    let before = m.scene().canonical_hash();
    m.apply_mutation(&Mutation::SetTheme { theme: theme() })
        .unwrap();
    m.apply_mutation(&Mutation::SetThemeColor {
        slot: "accent2".into(),
        value: "#00FF00".into(),
    })
    .unwrap();
    m.apply_mutation(&Mutation::SetThemeFonts {
        which: "minor".into(),
        fonts: ThemeFontsSpec {
            latin: Some("Verdana".into()),
            scripts: vec![ScriptFontSpec {
                script: "Jpan".into(),
                typeface: "Yu Gothic".into(),
            }],
            ..Default::default()
        },
    })
    .unwrap();

    let rows = m.collection(CollectionName::Theme);
    let row = &rows[0];
    assert_eq!(row["name"], "Probe");
    assert_eq!(row["edited"], true);
    assert_eq!(row["colors"][0]["slot"], "accent1");
    assert_eq!(row["colors"][0]["value"], "FF0000");
    assert_eq!(row["colors"][1]["slot"], "accent2");
    assert_eq!(row["colors"][1]["value"], "00FF00");
    assert_eq!(row["major"]["latin"], "Georgia");
    assert_eq!(row["minor"]["scripts"][0][1], "Yu Gothic");

    // One named undo step each, back to the document without a theme.
    for _ in 0..3 {
        m.undo().expect("undo");
    }
    assert!(m.scene().theme.is_none());
    assert_eq!(m.scene().canonical_hash(), before);
    m.redo().expect("redo");
    assert_eq!(m.scene().theme.as_ref().unwrap().name, "Probe");
}

#[test]
fn a_refused_theme_edit_leaves_the_document_alone__feat__core_theme() {
    let mut m = model();
    let before = m.scene().canonical_hash();
    assert!(m
        .apply_mutation(&Mutation::SetThemeColor {
            slot: "accent1".into(),
            value: "FF0000".into(),
        })
        .is_err());
    assert_eq!(m.scene().canonical_hash(), before);
}

#[test]
fn the_theme_survives_the_native_encoding__feat__core_theme() {
    let mut m = model();
    m.apply_mutation(&Mutation::SetTheme { theme: theme() })
        .unwrap();
    let bytes = paged_store::to_bytes(m.scene()).expect("encode");
    let back = paged_store::from_bytes(&bytes).expect("decode");
    assert_eq!(back.theme, m.scene().theme);
    assert!(back.theme.unwrap().edited);
}
