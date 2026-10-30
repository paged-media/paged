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

// Slide ADRs 713 and 719 — a deck's theme and styles as document resources:
// the "Theme" swatch group (slots and tints), theme colours by reference,
// theme fonts on the root paragraph styles, placeholders' paragraph styles,
// and shape styles as object styles. Read back from the `.paged` package the
// way the engine reads it.

#![allow(non_snake_case)]

use std::collections::HashMap;
use std::io::Read;
use std::path::Path;

fn fixture(name: &str) -> Vec<u8> {
    let p = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join(format!("../slide-conformance/fixtures/{name}.pptx"));
    std::fs::read(p).unwrap()
}

fn open(name: &str) -> paged_scene::Document {
    let bytes = fixture(name);
    let deck = slide_resolve::resolve(&pptx_import::import_pptx(&bytes).unwrap());
    let pkg = paged_ooxml::OpcPackage::read(&bytes).unwrap();
    let images = |part: &str| pkg.part(part).map(|b| b.to_vec());
    let paged = slide_native::write(&deck, &images, name).unwrap().paged;
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(paged)).unwrap();
    let mut pgm = Vec::new();
    let mut blobs = HashMap::new();
    for i in 0..zip.len() {
        let mut f = zip.by_index(i).unwrap();
        let name = f.name().unwrap().to_string();
        let mut b = Vec::new();
        f.read_to_end(&mut b).unwrap();
        if name == paged_store::DOCUMENT_PGM_PATH {
            pgm = b;
        } else if let Some(n) = paged_store::blob_name_of(&name) {
            blobs.insert(n.to_string(), b);
        }
    }
    paged_store::from_parts(&pgm, blobs).unwrap()
}

#[test]
fn the_theme_is_a_swatch_group_of_its_slots_and_tints__feat__plugin_slide_import_native() {
    let doc = open("placeholders");
    let group = &doc.palette.color_groups["ColorGroup/Theme"];
    assert_eq!(group.name.as_deref(), Some("Theme"));
    assert!(group.members.len() >= 62, "{}", group.members.len());
    for slot in slide_resolve::theme::SLOTS {
        let id = format!("Color/{slot}");
        assert!(group.members.contains(&id), "{id}");
        assert!(doc.palette.colors.contains_key(&id), "{id}");
    }
    let tint = &doc.palette.colors["Color/accent1 lumMod60000 lumOff40000"];
    assert_eq!(tint.name.as_deref(), Some("Accent 1, Lighter 40%"));
    assert_eq!(
        doc.palette.colors["Color/accent1"].value,
        vec![0x15 as f32, 0x60 as f32, 0x82 as f32]
    );
    for m in &group.members {
        assert!(doc.palette.colors.contains_key(m), "{m} is a swatch");
    }
}

#[test]
fn placeholders_take_their_paragraph_styles_rooted_in_the_theme_fonts__feat__plugin_slide_import_native(
) {
    let doc = open("placeholders");
    let ps = &doc.styles.paragraph_styles;
    assert_eq!(
        ps["ParagraphStyle/Title"].font.as_deref(),
        Some("Aptos Display")
    );
    assert_eq!(ps["ParagraphStyle/Body"].font.as_deref(), Some("Aptos"));
    for n in 1..=9 {
        for p in ["Body", "Other"] {
            let s = &ps[&format!("ParagraphStyle/{p} L{n}")];
            assert_eq!(s.based_on.as_deref(), Some("ParagraphStyle/Body"));
            assert!(s.point_size.is_some());
        }
    }
    // The Office master's title: 44 pt in Text 1 (dark 1).
    let title = &ps["ParagraphStyle/Title"];
    assert_eq!(title.point_size, Some(44.0));
    assert_eq!(title.fill_color.as_deref(), Some("Color/dk1"));
    let cs = &doc.styles.character_styles;
    assert_eq!(
        cs["CharacterStyle/Headings font"].font.as_deref(),
        Some("Aptos Display")
    );
    assert_eq!(
        cs["CharacterStyle/Body font"].font.as_deref(),
        Some("Aptos")
    );

    // A title's runs take the font from their style and name a theme
    // swatch, not a value.
    let mut titled = 0;
    for s in &doc.stories {
        for p in &s.story.paragraphs {
            if p.paragraph_style.as_deref() != Some("ParagraphStyle/Title") {
                continue;
            }
            for r in &p.runs {
                titled += 1;
                assert_eq!(r.font, None, "{:?}", r.text);
                let fill = r.fill_color.as_deref().unwrap();
                assert!(
                    slide_resolve::theme::Key::of_swatch(fill).is_some(),
                    "{fill}"
                );
            }
        }
    }
    assert!(titled > 0);
}

#[test]
fn shape_styles_become_object_styles_of_theme_swatches__feat__plugin_slide_import_native() {
    let doc = open("geometry");
    let styles: Vec<_> = doc
        .styles
        .object_styles
        .values()
        .filter(|s| s.self_id.starts_with("ObjectStyle/Shape Style"))
        .collect();
    assert!(!styles.is_empty());
    let polygons: Vec<_> = doc
        .spreads
        .iter()
        .map(|s| &s.spread)
        .chain(doc.master_spreads.values().map(|m| &m.spread))
        .flat_map(|s| &s.polygons)
        .collect();
    let themed = styles.iter().filter(|s| {
        s.fill_color
            .as_deref()
            .is_some_and(|f| slide_resolve::theme::Key::of_swatch(f).is_some())
    });
    assert!(themed.count() > 0, "a style fills with a theme swatch");
    for style in &styles {
        let applied = polygons
            .iter()
            .filter(|p| p.applied_object_style.as_deref() == Some(style.self_id.as_str()))
            .count();
        assert!(applied > 0, "{} is applied", style.self_id);
    }
}
