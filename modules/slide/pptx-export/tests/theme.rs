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

//! The live theme through export (slide ADR 713): a theme applied to the
//! document (its swatches recoloured by key, the root styles' fonts, the
//! deck label's name, which is what the bundle's one mutation does) writes
//! the masters' theme part and leaves every slide's bytes alone; a theme
//! colour picked for an edited run is written as `a:schemeClr` with its
//! transforms.

#![allow(non_snake_case)]

use std::path::PathBuf;

use paged_scene::Document;
use pptx_export::{export_with, native, ExportPlan, Exported, SlidePlan};
use slide_resolve::theme::{gallery, swatch_values, Key, ThemeIr};

fn fixture(name: &str) -> Vec<u8> {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join(format!("../slide-conformance/fixtures/{name}.pptx"));
    std::fs::read(p).unwrap()
}

fn imported(bytes: &[u8]) -> Document {
    let ir = pptx_import::import_pptx(bytes).unwrap();
    let deck = slide_resolve::resolve(&ir);
    let pkg = paged_ooxml::opc::OpcPackage::read(bytes).unwrap();
    let images = |p: &str| pkg.part(p).map(|b| b.to_vec());
    slide_native::build(&deck, &images, "deck").document
}

fn plan_of(doc: &Document) -> ExportPlan {
    ExportPlan {
        slides: doc
            .spreads
            .iter()
            .filter_map(|s| {
                let page = s.spread.pages.first()?;
                let id = page.self_id.clone()?;
                let st = native::page_state(&s.spread, &id);
                Some(SlidePlan {
                    source_part: st["part"].as_str().unwrap_or("").to_string(),
                    hidden: st["hidden"].as_bool().unwrap_or(false),
                    notes: st["notes"].as_str().map(str::to_string),
                    content_edited: false,
                    page_id: Some(id),
                    layout: st["layout"].as_str().map(str::to_string),
                    comments: None,
                    timing: None,
                })
            })
            .collect(),
        ..ExportPlan::default()
    }
}

fn export_doc(bytes: &[u8], doc: &Document) -> Exported {
    let paged = paged_store::package::wrap_document(doc, "deck", 960.0, 540.0).unwrap();
    export_with(bytes, &plan_of(doc), Some(&paged)).unwrap()
}

fn keep(bytes: &[u8], name: &str) {
    if let Ok(dir) = std::env::var("PAGED_SLIDE_EXPORT_DIR") {
        std::fs::write(PathBuf::from(dir).join(format!("{name}.pptx")), bytes).unwrap();
    }
}

fn part(bytes: &[u8], name: &str) -> Vec<u8> {
    let pkg = paged_ooxml::opc::OpcPackage::read(bytes).unwrap();
    pkg.part(name).unwrap().to_vec()
}

/// What Design ▸ Themes does to the document: every theme swatch takes its
/// key's colour, the root styles and the theme-font character styles take
/// the fonts, the deck label names the theme.
fn apply(doc: &mut Document, theme: &ThemeIr) {
    let ids: Vec<String> = doc.palette.colors.keys().cloned().collect();
    for (id, rgb) in swatch_values(theme, &ids) {
        let c = doc.palette.colors.get_mut(&id).unwrap();
        c.value = rgb.iter().map(|&v| v as f32).collect();
    }
    let font = |s: &mut Option<String>, f: &str| *s = Some(f.to_string());
    font(
        &mut doc
            .styles
            .paragraph_styles
            .get_mut(slide_native::TITLE_STYLE)
            .unwrap()
            .font,
        &theme.major,
    );
    font(
        &mut doc
            .styles
            .paragraph_styles
            .get_mut(slide_native::BODY_STYLE)
            .unwrap()
            .font,
        &theme.minor,
    );
    font(
        &mut doc
            .styles
            .character_styles
            .get_mut(slide_native::HEADINGS_FONT_STYLE)
            .unwrap()
            .font,
        &theme.major,
    );
    let label = doc
        .designmap
        .labels
        .iter_mut()
        .find(|(k, _)| k == native::LABEL_KEY)
        .unwrap();
    let mut v: serde_json::Value = serde_json::from_str(&label.1).unwrap();
    v["data"]["theme"] = serde_json::to_value(theme).unwrap();
    label.1 = v.to_string();
}

#[test]
fn an_applied_theme_writes_the_theme_part_and_keeps_every_slide__feat__plugin_slide_pptx_export() {
    let bytes = fixture("placeholders");
    let mut doc = imported(&bytes);
    let paper = gallery().into_iter().find(|g| g.id == "paper").unwrap();
    let dark = paper.variants[1].clone();
    apply(&mut doc, &dark);
    let out = export_doc(&bytes, &doc);
    keep(&out.bytes, "theme-paper-dark");
    let theme = String::from_utf8(part(&out.bytes, "ppt/theme/theme1.xml")).unwrap();
    assert!(
        theme.contains(r#"<a:clrScheme name="Paper Dark">"#),
        "{theme}"
    );
    assert!(theme.contains(r#"<a:dk1><a:srgbClr val="FFFFFF"/></a:dk1>"#));
    assert!(theme.contains(r#"<a:lt1><a:srgbClr val="1B1B1B"/></a:lt1>"#));
    assert!(theme.contains(r#"<a:majorFont><a:latin typeface="Georgia"/>"#));
    assert!(theme.contains(r#"<a:minorFont><a:latin typeface="Verdana"/>"#));
    assert!(theme.contains("<a:fmtScheme"), "the format scheme stays");
    // Every slide keeps its bytes: its colours are scheme colours.
    let pkg = paged_ooxml::opc::OpcPackage::read(&bytes).unwrap();
    for name in pkg
        .file_names()
        .filter(|n| n.starts_with("ppt/slides/slide"))
    {
        assert!(part(&out.bytes, name) == part(&bytes, name), "{name}");
    }
    // Read back, the deck is the theme.
    let back = slide_resolve::resolve(&pptx_import::import_pptx(&out.bytes).unwrap());
    let t = back.theme.unwrap();
    assert_eq!(t.major, "Georgia");
    assert_eq!(t.rgb("accent1"), dark.rgb("accent1"));
    // And the original theme exports the deck's own theme part again.
    let mut again = imported(&bytes);
    let office = gallery().into_iter().find(|g| g.id == "office").unwrap();
    apply(&mut again, &office.theme);
    let out = export_doc(&bytes, &again);
    assert!(part(&out.bytes, "ppt/theme/theme1.xml") == part(&bytes, "ppt/theme/theme1.xml"));
}

#[test]
fn a_theme_tint_on_an_edited_run_is_written_as_a_scheme_colour__feat__plugin_slide_pptx_export() {
    let bytes = fixture("text");
    let mut doc = imported(&bytes);
    let tint = Key::parse("accent2 lumMod75000").unwrap().swatch_id();
    assert!(
        doc.palette.colors.contains_key(&tint),
        "the picker's tint is a swatch"
    );
    // The first run of the first slide story.
    let story = doc
        .stories
        .iter_mut()
        .find(|s| s.story.paragraphs.iter().any(|p| !p.runs.is_empty()))
        .unwrap();
    let run = story
        .story
        .paragraphs
        .iter_mut()
        .flat_map(|p| p.runs.iter_mut())
        .find(|r| !r.text.trim().is_empty())
        .unwrap();
    run.fill_color = Some(tint);
    let out = export_doc(&bytes, &doc);
    keep(&out.bytes, "theme-tint-run");
    let pkg = paged_ooxml::opc::OpcPackage::read(&out.bytes).unwrap();
    let written: String = pkg
        .file_names()
        .filter(|n| n.starts_with("ppt/slides/slide") && n.ends_with(".xml"))
        .map(|n| String::from_utf8(pkg.part(n).unwrap().to_vec()).unwrap())
        .collect();
    assert!(
        written.contains(r#"<a:schemeClr val="accent2"><a:lumMod val="75000"/></a:schemeClr>"#),
        "the tint is a theme colour"
    );
}
