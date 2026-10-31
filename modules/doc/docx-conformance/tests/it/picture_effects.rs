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

//! Doc ADR 618 — a picture's DrawingML look (`pic:spPr` fill, outline and
//! effect list; the `a:blip`'s alpha and picture effects) is read by the
//! shared DrawingML reader, lowered by the shared mapper (`dml-native`)
//! into the IR, and what the page does not show is reported. The source
//! keeps every drawing byte for byte, edited or not.

#![allow(non_snake_case)]

use docx_conformance::picture_effects_docx;
use docx_core::Block;
use docx_export::EditSet;
use docx_js::DocSession;
use docx_lower::ir::{LoweredBlock, LoweredImage};
use paged_ooxml::OpcPackage;

fn pictures() -> (
    docx_core::DocxDocument,
    Vec<LoweredImage>,
    docx_lower::ir::LoweredDoc,
) {
    let doc = docx_import::import_docx(&picture_effects_docx()).unwrap();
    let ir = docx_lower::lower(&doc);
    let images = ir
        .story
        .blocks
        .iter()
        .filter_map(|b| match b {
            LoweredBlock::Paragraph(p) => Some(p.images.clone()),
            _ => None,
        })
        .flatten()
        .collect();
    (doc, images, ir)
}

#[test]
fn every_picture_keeps_its_look_as_authored__feat__plugin_doc_native_effects() {
    let (doc, ..) = pictures();
    let looks: Vec<_> = doc
        .body
        .iter()
        .filter_map(|b| match b {
            Block::Paragraph(p) => p.runs.iter().flat_map(|r| &r.images).next(),
            _ => None,
        })
        .map(|i| i.look.as_deref())
        .collect();
    assert_eq!(looks.len(), 5);
    let p1 = looks[0].expect("P1 look");
    assert_eq!(p1.shape.line.as_ref().and_then(|l| l.width), Some(88_900));
    assert!(p1.shape.effects.outer_shadow.is_some());
    assert_eq!(looks[1].expect("P2 look").blip.alpha, Some(60_000));
    assert_eq!(looks[2].expect("P3 look").blip.effects.len(), 1);
    assert!(looks[3].is_none(), "a plain picture holds no look");
    assert!(looks[4].expect("P5 look").shape.fill.is_some());
}

#[test]
fn a_frame_and_a_drop_shadow_lower_to_native_fields__feat__plugin_doc_native_effects() {
    let (_, images, _) = pictures();
    let fx = images[0].fx.as_ref().expect("P1 fx");
    let s = fx.stroke.as_ref().expect("outline");
    assert_eq!((s.color.as_str(), s.weight), ("#FFFFFF", 7.0));
    assert_eq!(s.cap.as_deref(), Some("ProjectingEndCap"));
    assert_eq!(s.miter_limit, Some(8.0));
    let d = fx.drop_shadow.as_ref().expect("drop shadow");
    assert_eq!((d.opacity, d.color.as_str()), (70.0, "#000000"));
    assert!((d.size - 2.165).abs() < 1e-3, "{}", d.size);
    assert!(d.x_offset.abs() < 1e-3 && (d.y_offset - 1.417).abs() < 1e-3);
    assert!(images[0].losses.is_empty(), "{:?}", images[0].losses);
}

#[test]
fn alpha_glow_and_soft_edge_lower_against_the_document_theme__feat__plugin_doc_native_effects() {
    let (_, images, _) = pictures();
    let p2 = &images[1];
    assert!(p2.float.is_some(), "the floating picture keeps its float");
    let fx = p2.fx.as_ref().expect("P2 fx");
    assert_eq!(fx.opacity, Some(60.0));
    let g = fx.outer_glow.as_ref().expect("glow");
    // Accent 1 of the document theme.
    assert_eq!(
        (g.size, g.opacity, g.color.as_str()),
        (5.0, 40.0, "#4472C4")
    );
    assert_eq!(fx.feather, Some(2.5));
}

#[test]
fn what_the_engine_cannot_hold_is_reported_per_kind__feat__plugin_doc_native_effects() {
    let (_, images, ir) = pictures();
    let p3 = &images[2];
    let i = p3
        .fx
        .as_ref()
        .and_then(|f| f.inner_shadow.as_ref())
        .expect("inner shadow");
    assert_eq!((i.angle, i.size, i.opacity), (-45.0, 2.5, 50.0));
    assert!((i.distance - 4.0).abs() < 2e-3);
    // The reflection rides the look's effect stack (engine ADR 1008).
    let stack = &p3.fx.as_ref().unwrap().effect_stack;
    assert!(stack.iter().any(|e| e.kind == "reflection"), "{stack:?}");
    assert!(
        !p3.losses.iter().any(|l| l.contains("reflection")),
        "{:?}",
        p3.losses
    );
    assert!(
        p3.losses.iter().any(|l| l.contains("a:grayscl")),
        "{:?}",
        p3.losses
    );
    assert!(images[3].fx.is_none() && images[3].losses.is_empty());
    let messages: Vec<&str> = ir.diagnostics.iter().map(|d| d.message.as_str()).collect();
    let shown = messages
        .iter()
        .find(|m| m.contains("carry a DrawingML look"))
        .expect("the look diagnostic");
    assert!(shown.starts_with("4 picture(s)"), "{shown}");
    // Engine ADR 1045, doc ADR 619: drawn, so said as a note, not a loss.
    assert!(shown.contains("drawn natively"), "{shown}");
    assert!(!shown.contains("NOT shown"), "{shown}");
    let look = ir
        .diagnostics
        .iter()
        .find(|d| d.message.contains("carry a DrawingML look"))
        .unwrap();
    assert_eq!(look.severity, "info");
    for kind in [
        "drop shadow",
        "glow",
        "inner shadow",
        "outline",
        "soft edge",
        "reflection",
    ] {
        assert!(shown.contains(kind), "{kind}: {shown}");
    }
    assert_eq!(
        messages
            .iter()
            .filter(|m| m.starts_with("picture look in 1 picture(s)") && m.contains("a:grayscl"))
            .count(),
        1,
        "{messages:?}"
    );
}

#[test]
fn a_gradient_behind_and_a_dashed_outline__feat__plugin_doc_native_effects() {
    let (_, images, _) = pictures();
    let fx = images[4].fx.as_ref().expect("P5 fx");
    let g = fx.gradient.as_ref().expect("gradient");
    assert_eq!(g.kind, "linear");
    assert_eq!(
        g.stops,
        vec![(0.0, "#4472C4".to_string()), (100.0, "#FFFFFF".to_string())]
    );
    // Top to bottom across the 144 × 96 pt picture, from its top edge.
    assert_eq!(
        (g.angle, g.length, g.start),
        (Some(-90.0), Some(96.0), Some((72.0, 0.0)))
    );
    let gf = fx
        .gradient_feather
        .as_ref()
        .expect("alpha stops fade the item");
    assert_eq!(gf.stops, vec![(0.0, 100.0), (100.0, 0.0)]);
    let s = fx.stroke.as_ref().expect("outline");
    assert_eq!((s.color.as_str(), s.weight), ("#ED7D31", 1.0));
    assert_eq!(s.dash, [4.0, 3.0]);
}

#[test]
fn the_ir_carries_the_look_for_the_host_model__feat__plugin_doc_native_effects() {
    let (_, _, ir) = pictures();
    let json = serde_json::to_value(&ir).unwrap();
    let img = &json["story"]["blocks"][1]["images"][0];
    assert_eq!(img["fx"]["dropShadow"]["opacity"], 70.0);
    assert_eq!(img["fx"]["stroke"]["color"], "#FFFFFF");
    assert!(json["story"]["blocks"][7]["images"][0].get("fx").is_none());
}

/// The `<w:drawing>` elements of a `document.xml`, as written.
fn drawings(xml: &str) -> Vec<&str> {
    xml.match_indices("<w:drawing>")
        .map(|(i, _)| {
            let end = xml[i..].find("</w:drawing>").unwrap() + i + "</w:drawing>".len();
            &xml[i..end]
        })
        .collect()
}

fn document_xml(bytes: &[u8]) -> String {
    let pkg = OpcPackage::read(bytes).unwrap();
    String::from_utf8(pkg.part("word/document.xml").unwrap().to_vec()).unwrap()
}

#[test]
fn pictures_with_a_look_save_back_byte_identical__feat__plugin_doc_native_effects() {
    let original = picture_effects_docx();
    let session = DocSession::load(&original).unwrap();
    // Unedited: every part as it was.
    let (saved, _) = session.save_edited(&EditSet::default()).unwrap();
    let (a, b) = (
        OpcPackage::read(&original).unwrap(),
        OpcPackage::read(&saved).unwrap(),
    );
    for name in a.file_names() {
        assert_eq!(a.part(name), b.part(name), "part {name}");
    }
    // Edited elsewhere: the text changes, every drawing stays as written.
    let (model, _pkg, _main) = docx_import::import_docx_with_package(&original).unwrap();
    let bindings = docx_export::build_bindings(&model);
    let base = docx_lower::lower(&model);
    let mut edited = base.clone();
    if let LoweredBlock::Paragraph(p) = &mut edited.story.blocks[0] {
        p.runs[0].text = "P1 edited.".into();
    }
    let edits = docx_export::diff(&base, &edited, &bindings);
    assert_eq!(edits.runs.len(), 1);
    let (saved, _) = session.save_edited(&edits).unwrap();
    // `scripts/word-picture-effects-probe.sh` has Word open this very file.
    if let Ok(path) = std::env::var("PICTURE_EFFECTS_EDITED_OUT") {
        std::fs::write(path, &saved).expect("write the edited save");
    }
    let (before, after) = (document_xml(&original), document_xml(&saved));
    assert!(after.contains("P1 edited."));
    assert_eq!(drawings(&before), drawings(&after));
    assert_eq!(drawings(&after).len(), 5);
}

/// Doc ADR 619 — every colour a look paints with is a document swatch the
/// host model names (`Color/docx-RRGGBB`), so the look's ops resolve.
#[test]
fn a_looks_colours_are_document_swatches__feat__plugin_doc_native_effects() {
    let (_, images, ir) = pictures();
    let mut checked = 0;
    for img in &images {
        let Some(fx) = &img.fx else { continue };
        for c in fx.colors() {
            let id = format!("Color/docx-{}", c.trim_start_matches('#'));
            assert!(ir.swatches.iter().any(|s| s.id == id), "{id} not minted");
            checked += 1;
        }
    }
    assert!(
        checked >= 5,
        "the fixture's looks paint with colours: {checked}"
    );
}
