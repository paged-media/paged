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
    let losses: Vec<String> = m
        .idml_export_losses()
        .into_iter()
        .map(|l| l.message)
        .collect();
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
    assert!(!m
        .idml_export_losses()
        .iter()
        .any(|l| l.message.contains("theme")));
}

/// `idml` with `from` replaced by `to` in every text part (an edit made
/// outside paged), the entries stored as they were.
fn edited_outside(idml: &[u8], from: &str, to: &str) -> Vec<u8> {
    use std::io::{Read, Write};
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(idml)).expect("zip");
    let mut out = Vec::new();
    {
        let mut w = zip::ZipWriter::new(std::io::Cursor::new(&mut out));
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        for i in 0..zip.len() {
            let mut f = zip.by_index(i).expect("entry");
            let name = f.name().expect("name").to_string();
            let mut data = Vec::new();
            f.read_to_end(&mut data).expect("read");
            if name.ends_with(".xml") && name != "designmap.xml" {
                if let Ok(text) = String::from_utf8(data.clone()) {
                    data = text.replace(from, to).into_bytes();
                }
            }
            w.start_file(name, opts).expect("start");
            w.write_all(&data).expect("write");
        }
        w.finish().expect("finish");
    }
    out
}

fn cmyk_swatch(id: &str, v: [f32; 4]) -> Mutation {
    Mutation::CreateSwatch {
        spec: SwatchSpec {
            self_id: Some(id.into()),
            name: Some(id.trim_start_matches("Color/").into()),
            space: "CMYK".into(),
            value: v.to_vec(),
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
fn a_cmyk_swatch_follows_a_slot_in_cmyk_and_keeps_its_link_through_idml__feat__core_theme() {
    let mut m = model();
    m.apply_mutation(&cmyk_swatch("Color/Print", [83.85, 26.15, 0.0, 49.02]))
        .unwrap();
    m.apply_mutation(&Mutation::CreateThemeFromSwatches {
        name: "Print".into(),
        slots: vec![ThemeSlotSwatchSpec {
            slot: "accent1".into(),
            swatch: "Color/Print".into(),
        }],
        relink: false,
    })
    .unwrap();
    assert_eq!(
        m.scene()
            .theme
            .as_ref()
            .unwrap()
            .color("accent1")
            .unwrap()
            .value,
        "156082"
    );
    m.apply_mutation(&Mutation::SetThemeColor {
        slot: "accent1".into(),
        value: "FF0000".into(),
    })
    .unwrap();
    let print = &m.scene().palette.colors["Color/Print"];
    assert_eq!(print.space, paged_model::ColorSpace::Cmyk);
    assert_eq!(print.value, vec![0.0, 100.0, 100.0, 0.0]);
    // The collection says which space it is written in.
    let rows = m.collection(CollectionName::Swatches);
    let row = rows
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["selfId"] == "Color/Print")
        .unwrap();
    assert_eq!(row["space"], "cmyk");
    // IDML: the swatch is a plain CMYK colour and the link comes back.
    let idml = m.export_idml().expect("export");
    let back = CanvasModel::load("doc", &idml, CanvasOptions::default()).expect("reload");
    let c = &back.scene().palette.colors["Color/Print"];
    assert_eq!(c.space, paged_model::ColorSpace::Cmyk);
    assert_eq!(c.theme_ref.as_ref().unwrap().slot, "accent1");
    assert!(back.import_notes().is_empty(), "{:?}", back.import_notes());
    assert!(back
        .collection(CollectionName::ImportNotes)
        .as_array()
        .unwrap()
        .is_empty());
}

#[test]
fn a_spot_swatch_never_follows_a_slot_and_the_refusal_says_why__feat__core_theme() {
    let mut m = model();
    m.apply_mutation(&Mutation::CreateSwatch {
        spec: SwatchSpec {
            self_id: Some("Color/Spot".into()),
            name: Some("Spot".into()),
            space: "CMYK".into(),
            value: vec![0.0, 80.0, 90.0, 0.0],
            model: Some("Spot".into()),
            alternate_space: None,
            alternate_value: Vec::new(),
            tint: None,
            alpha: None,
            pattern: None,
            theme_ref: None,
        },
    })
    .unwrap();
    let err = m
        .apply_mutation(&Mutation::CreateThemeFromSwatches {
            name: "x".into(),
            slots: vec![ThemeSlotSwatchSpec {
                slot: "accent1".into(),
                swatch: "Color/Spot".into(),
            }],
            relink: true,
        })
        .expect_err("refused");
    assert!(format!("{err:?}").contains("spot"), "{err:?}");
    assert!(m.scene().theme.is_none());
}

#[test]
fn a_swatch_edited_outside_paged_is_reported_in_the_import_notes_collection__feat__core_theme() {
    let mut m = model();
    m.apply_mutation(&swatch("Color/Brand", [21.0, 96.0, 130.0]))
        .unwrap();
    m.apply_mutation(&Mutation::CreateThemeFromSwatches {
        name: "Mine".into(),
        slots: vec![ThemeSlotSwatchSpec {
            slot: "accent1".into(),
            swatch: "Color/Brand".into(),
        }],
        relink: false,
    })
    .unwrap();
    let idml = m.export_idml().expect("export");
    let edited = edited_outside(&idml, "21 96 130", "22 96 130");
    let back = CanvasModel::load("doc", &edited, CanvasOptions::default()).expect("reload");
    assert_eq!(
        back.scene().palette.colors["Color/Brand"].value,
        vec![22.0, 96.0, 130.0],
        "the edit reached the swatch"
    );
    assert!(back.scene().palette.colors["Color/Brand"]
        .theme_ref
        .is_none());
    let rows = back.collection(CollectionName::ImportNotes);
    let rows = rows.as_array().unwrap();
    assert_eq!(rows.len(), 1, "{rows:?}");
    assert!(rows[0]["message"]
        .as_str()
        .unwrap()
        .contains("edited outside paged"));
    // A document made in the editor has none.
    assert!(m
        .collection(CollectionName::ImportNotes)
        .as_array()
        .unwrap()
        .is_empty());
}

#[test]
fn a_style_reports_the_theme_font_it_follows__feat__core_theme() {
    let mut m = model();
    m.apply_mutation(&Mutation::SetTheme {
        theme: ThemeSpec {
            name: "T".into(),
            major: ThemeFontsSpec {
                latin: Some("Georgia".into()),
                ..Default::default()
            },
            ..Default::default()
        },
    })
    .unwrap();
    let rows = m.collection(CollectionName::ParagraphStyles);
    let id = rows[0]["selfId"].as_str().unwrap().to_string();
    assert!(rows[0]["fontRef"].is_null());
    m.apply_mutation(&Mutation::SetStyleThemeFont {
        collection: paged_mutate::StyleCollection::Paragraph,
        style_id: id.clone(),
        which: Some("major".into()),
    })
    .unwrap();
    let rows = m.collection(CollectionName::ParagraphStyles);
    let row = rows
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["selfId"] == id.as_str())
        .unwrap();
    assert_eq!(row["fontRef"], "major");
    m.apply_mutation(&Mutation::SetStyleThemeFont {
        collection: paged_mutate::StyleCollection::Paragraph,
        style_id: id.clone(),
        which: None,
    })
    .unwrap();
    let rows = m.collection(CollectionName::ParagraphStyles);
    let row = rows
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["selfId"] == id.as_str())
        .unwrap();
    assert!(row["fontRef"].is_null());
}
