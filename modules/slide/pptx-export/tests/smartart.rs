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

//! SmartArt text edits (slide W4, the text pane) on the PowerPoint-authored
//! `smartart` fixture: the document's text of a diagram's shapes is written
//! to the diagram's data and drawing parts, and reads back.

use std::path::PathBuf;

use paged_model::FrameRef;
use paged_scene::Document;
use pptx_export::{export_with, native, ExportPlan, Exported, SlidePlan};
use slide_resolve::model::{Item, ItemKind};

fn fixture() -> Vec<u8> {
    std::fs::read(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../slide-conformance/fixtures/smartart.pptx"),
    )
    .unwrap()
}

fn imported(bytes: &[u8]) -> Document {
    let ir = pptx_import::import_pptx(bytes).unwrap();
    let deck = slide_resolve::resolve(&ir);
    let pkg = paged_ooxml::opc::OpcPackage::read(bytes).unwrap();
    let images = |p: &str| pkg.part(p).map(|b| b.to_vec());
    slide_native::build(&deck, &images, "deck").document
}

fn export(bytes: &[u8], doc: &Document) -> Exported {
    let paged = paged_store::package::wrap_document(doc, "deck", 960.0, 540.0).unwrap();
    let plan = ExportPlan {
        slides: doc
            .spreads
            .iter()
            .filter_map(|s| {
                let id = s.spread.pages.first()?.self_id.clone()?;
                let st = native::page_state(&s.spread, &id);
                Some(SlidePlan {
                    source_part: st["part"].as_str().unwrap_or("").to_string(),
                    page_id: Some(id),
                    ..SlidePlan::default()
                })
            })
            .collect(),
        ..ExportPlan::default()
    };
    export_with(bytes, &plan, Some(&paged)).unwrap()
}

fn keep(bytes: &[u8], name: &str) {
    if let Ok(dir) = std::env::var("PAGED_SLIDE_EXPORT_DIR") {
        std::fs::write(PathBuf::from(dir).join(format!("{name}.pptx")), bytes).unwrap();
    }
}

/// The story of the diagram text frame on page `page` whose text is `text`.
fn story_with(doc: &Document, page: usize, text: &str) -> String {
    let sp = &doc.spreads[page].spread;
    sp.frames_in_order
        .iter()
        .chain(sp.groups.iter().flat_map(|g| g.members.iter()))
        .find_map(|r| match r {
            FrameRef::TextFrame(i) => {
                let st = sp.text_frames[*i].parent_story.clone()?;
                let paras = native::story(doc, &st)?;
                let all: String = paras
                    .iter()
                    .flat_map(|p| p.runs.iter().map(|r| r.text.as_str()))
                    .collect();
                all.contains(text).then_some(st)
            }
            _ => None,
        })
        .unwrap_or_else(|| panic!("no frame with {text:?}"))
}

/// Replace `from` with `to` in the story's runs.
fn edit(doc: &mut Document, story: &str, from: &str, to: &str) {
    let st = doc.stories.iter_mut().find(|s| s.self_id == story).unwrap();
    for p in &mut st.story.paragraphs {
        for r in &mut p.runs {
            r.text = r.text.replace(from, to);
        }
    }
}

fn texts(it: &Item, out: &mut Vec<String>) {
    match &it.kind {
        ItemKind::Group { children } => children.iter().for_each(|c| texts(c, out)),
        ItemKind::Shape { text: Some(t), .. } => {
            for p in &t.paragraphs {
                out.push(p.runs.iter().map(|r| r.text.as_str()).collect());
            }
        }
        _ => {}
    }
}

fn slide_texts(bytes: &[u8], slide: usize) -> Vec<String> {
    let deck = slide_resolve::resolve(&pptx_import::import_pptx(bytes).unwrap());
    let mut out = Vec::new();
    for it in &deck.slides[slide].items {
        texts(it, &mut out);
    }
    out
}

#[test]
fn diagram_shapes_name_the_points_they_show() {
    let ir = pptx_import::import_pptx(&fixture()).unwrap();
    let m = &ir.diagram_models["ppt/diagrams/drawing1.xml"];
    assert_eq!(m.data_part, "ppt/diagrams/data1.xml");
    let names: Vec<&str> = m.points.iter().map(|p| p.paragraphs[0].as_str()).collect();
    assert_eq!(names, ["Alpha", "Beta", "Gamma", "Delta", "Epsilon"]);
    assert!(m.points.iter().all(|p| p.depth == 0));
    // Diagram 4's one shape shows five points, in their drawing order.
    let m4 = &ir.diagram_models["ppt/diagrams/drawing4.xml"];
    let multi = m4
        .shapes
        .values()
        .find(|v| v.len() == 5)
        .expect("a shape of five points");
    let by_id: std::collections::BTreeMap<&str, &str> = m4
        .points
        .iter()
        .map(|p| (p.id.as_str(), p.paragraphs[0].as_str()))
        .collect();
    let shown: Vec<&str> = multi.iter().map(|(id, _)| by_id[id.as_str()]).collect();
    assert_eq!(shown, ["Board", "Design", "Fonts", "Engineering", "Engine"]);
}

#[test]
fn a_point_edited_in_the_document_is_written_to_the_data_and_the_drawing() {
    let bytes = fixture();
    let mut doc = imported(&bytes);
    let st = story_with(&doc, 0, "Gamma");
    edit(&mut doc, &st, "Gamma", "Omega & co");
    let out = export(&bytes, &doc);
    keep(&out.bytes, "smartart-text");
    assert!(out.not_exported.is_empty(), "{:?}", out.not_exported);
    let pkg = paged_ooxml::opc::OpcPackage::read(&out.bytes).unwrap();
    let text = |p: &str| String::from_utf8(pkg.part(p).unwrap().to_vec()).unwrap();
    // New parts for the slide; the old ones stay as they were.
    let rels = text("ppt/slides/_rels/slide1.xml.rels");
    assert!(
        rels.contains("../diagrams/data9.xml") && rels.contains("../diagrams/drawing9.xml"),
        "{rels}"
    );
    assert!(text("ppt/diagrams/data1.xml").contains("<a:t>Gamma</a:t>"));
    assert!(text("ppt/diagrams/data9.xml").contains("<a:t>Omega &amp; co</a:t>"));
    let drawing = text("ppt/diagrams/drawing9.xml");
    assert!(
        drawing.contains(r#"<a:rPr lang="en-US" sz="5500" kern="1200"/><a:t>Omega &amp; co</a:t>"#),
        "{drawing}"
    );
    let ct = text("[Content_Types].xml");
    assert!(ct.contains(r#"PartName="/ppt/diagrams/data9.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.diagramData+xml""#));
    assert!(ct.contains(r#"PartName="/ppt/diagrams/drawing9.xml" ContentType="application/vnd.ms-office.drawingml.diagramDrawing+xml""#));
    // It reads back: the drawing draws the new text, the model holds it.
    assert!(slide_texts(&out.bytes, 0).contains(&"Omega & co".to_string()));
    let ir = pptx_import::import_pptx(&out.bytes).unwrap();
    let m = &ir.diagram_models["ppt/diagrams/drawing9.xml"];
    assert_eq!(m.points[2].paragraphs, ["Omega & co"]);
    // Only slide 1 changed among the slides.
    for n in 2..=8 {
        let p = format!("ppt/slides/slide{n}.xml");
        let orig = paged_ooxml::opc::OpcPackage::read(&bytes).unwrap();
        assert_eq!(pkg.part(&p), orig.part(&p), "{p}");
    }
}

#[test]
fn one_point_of_a_shape_of_several_is_written_alone() {
    let bytes = fixture();
    let mut doc = imported(&bytes);
    let st = story_with(&doc, 3, "Fonts");
    edit(&mut doc, &st, "Fonts", "Type");
    let out = export(&bytes, &doc);
    keep(&out.bytes, "smartart-multi");
    assert!(out.not_exported.is_empty(), "{:?}", out.not_exported);
    let t = slide_texts(&out.bytes, 3);
    assert!(
        t.contains(&"Type".to_string()) && t.contains(&"Engineering".to_string()),
        "{t:?}"
    );
    assert!(!t.contains(&"Fonts".to_string()));
}

#[test]
fn an_unedited_diagram_keeps_its_parts() {
    let bytes = fixture();
    let doc = imported(&bytes);
    assert_eq!(export(&bytes, &doc).bytes, bytes);
}
