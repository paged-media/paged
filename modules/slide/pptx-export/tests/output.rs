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

//! Slide ADR 720, the package-level outputs: Save as template (`.potx`),
//! custom shows and sections written from the document and read back, the
//! import labels that carry them, and the outline read from the document.

use std::path::PathBuf;

use paged_scene::Document;
use pptx_export::presentation::{
    CustomShowPlan, Format, SectionPlan, CT_PRESENTATION, CT_TEMPLATE,
};
use pptx_export::{export, native, outline, ExportPlan, SlidePlan};

fn fixture(name: &str) -> Vec<u8> {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join(format!("../slide-conformance/fixtures/{name}.pptx"));
    std::fs::read(p).unwrap()
}

/// Keep a written deck for PowerPoint's open-check (ADR 705) when
/// `PAGED_SLIDE_EXPORT_DIR` names a folder.
fn keep(bytes: &[u8], name: &str) {
    if let Ok(dir) = std::env::var("PAGED_SLIDE_EXPORT_DIR") {
        std::fs::write(PathBuf::from(dir).join(name), bytes).unwrap();
    }
}

/// The deck as it is, each slide on page `p<n>` (the import's page ids).
fn as_is(bytes: &[u8]) -> ExportPlan {
    let ir = pptx_import::import_pptx(bytes).unwrap();
    ExportPlan {
        slides: ir
            .slides
            .iter()
            .enumerate()
            .map(|(i, s)| SlidePlan {
                source_part: s.part.clone(),
                hidden: s.hidden,
                notes: s
                    .notes
                    .as_ref()
                    .map(slide_resolve::text::plain)
                    .filter(|n| !n.trim().is_empty()),
                page_id: Some(format!("p{}", i + 1)),
                ..SlidePlan::default()
            })
            .collect(),
        ..ExportPlan::default()
    }
}

fn content_types(bytes: &[u8]) -> String {
    let pkg = paged_ooxml::opc::OpcPackage::read(bytes).unwrap();
    String::from_utf8(pkg.part("[Content_Types].xml").unwrap().to_vec()).unwrap()
}

fn imported(bytes: &[u8]) -> Document {
    let ir = pptx_import::import_pptx(bytes).unwrap();
    let deck = slide_resolve::resolve(&ir);
    let pkg = paged_ooxml::opc::OpcPackage::read(bytes).unwrap();
    let images = |p: &str| pkg.part(p).map(|b| b.to_vec());
    slide_native::build(&deck, &images, "deck").document
}

#[test]
fn save_as_template_writes_the_template_content_type() {
    let bytes = fixture("placeholders");
    let mut plan = as_is(&bytes);
    plan.format = Some(Format::Potx);
    let out = export(&bytes, &plan).unwrap();
    let ct = content_types(&out.bytes);
    assert!(ct.contains(CT_TEMPLATE), "{ct}");
    assert!(!ct.contains(CT_PRESENTATION));
    keep(&out.bytes, "w6-template.potx");
    // A template reads back as the same deck.
    let a = pptx_import::import_pptx(&bytes).unwrap();
    let b = pptx_import::import_pptx(&out.bytes).unwrap();
    assert_eq!(a.slides.len(), b.slides.len());
    // Saved as a deck again: the presentation content type, and the
    // original bytes where nothing else changed.
    let mut back = as_is(&out.bytes);
    back.format = Some(Format::Pptx);
    let again = export(&out.bytes, &back).unwrap();
    assert!(content_types(&again.bytes).contains(CT_PRESENTATION));
    let mut same = as_is(&bytes);
    same.format = Some(Format::Pptx);
    assert!(
        export(&bytes, &same).unwrap().bytes == bytes,
        "a .pptx saved as .pptx is unchanged"
    );
}

#[test]
fn custom_shows_round_trip_and_follow_the_slides() {
    let bytes = fixture("placeholders");
    let mut plan = as_is(&bytes);
    assert!(plan.slides.len() >= 4);
    plan.custom_shows = Some(vec![
        CustomShowPlan {
            id: None,
            name: "Short & sweet".into(),
            pages: vec!["p3".into(), "p1".into(), "p3".into()],
        },
        CustomShowPlan {
            id: None,
            name: "Ende".into(),
            pages: vec!["p4".into()],
        },
    ]);
    let out = export(&bytes, &plan).unwrap();
    assert!(out.diagnostics.is_empty(), "{:?}", out.diagnostics);
    keep(&out.bytes, "w6-custom-shows.pptx");
    let ir = pptx_import::import_pptx(&out.bytes).unwrap();
    let part = |i: usize| ir.slides[i].part.clone();
    assert_eq!(ir.custom_shows.len(), 2);
    assert_eq!(ir.custom_shows[0].name, "Short & sweet");
    assert_eq!(ir.custom_shows[0].slides, vec![part(2), part(0), part(2)]);
    assert_eq!(ir.custom_shows[1].slides, vec![part(3)]);
    assert_ne!(ir.custom_shows[0].id, ir.custom_shows[1].id);

    // Import carries them to the document label by page id.
    let doc = imported(&out.bytes);
    let label = doc
        .designmap
        .labels
        .iter()
        .find(|(k, _)| k == native::LABEL_KEY)
        .map(|(_, v)| serde_json::from_str::<serde_json::Value>(v).unwrap())
        .unwrap();
    let shows = &label["data"]["customShows"];
    assert_eq!(shows[0]["name"], "Short & sweet");
    assert_eq!(shows[0]["pages"], serde_json::json!(["p3", "p1", "p3"]));

    // The same shows written again: the same bytes.
    let mut again = as_is(&out.bytes);
    again.custom_shows = Some(
        ir.custom_shows
            .iter()
            .map(|c| CustomShowPlan {
                id: Some(c.id),
                name: c.name.clone(),
                pages: c
                    .slides
                    .iter()
                    .map(|p| {
                        let i = ir.slides.iter().position(|s| &s.part == p).unwrap();
                        format!("p{}", i + 1)
                    })
                    .collect(),
            })
            .collect(),
    );
    assert!(export(&out.bytes, &again).unwrap().bytes == out.bytes);

    // A deleted slide leaves the shows that played it (plan without shows:
    // the deck's own, pruned).
    let mut fewer = as_is(&out.bytes);
    fewer.slides.remove(0);
    let pruned = export(&out.bytes, &fewer).unwrap();
    let ir2 = pptx_import::import_pptx(&pruned.bytes).unwrap();
    assert_eq!(ir2.custom_shows[0].slides.len(), 2, "slide 1 left the show");

    // No shows: the list goes.
    let mut none = as_is(&out.bytes);
    none.custom_shows = Some(vec![]);
    let gone = export(&out.bytes, &none).unwrap();
    assert!(pptx_import::import_pptx(&gone.bytes)
        .unwrap()
        .custom_shows
        .is_empty());
}

#[test]
fn sections_round_trip_through_import_labels() {
    let bytes = fixture("placeholders");
    let mut plan = as_is(&bytes);
    let n = plan.slides.len();
    plan.sections = Some(vec![
        SectionPlan {
            id: None,
            name: "Opening".into(),
            first_page: "p1".into(),
        },
        SectionPlan {
            id: None,
            name: "Hauptteil".into(),
            first_page: "p3".into(),
        },
    ]);
    let out = export(&bytes, &plan).unwrap();
    keep(&out.bytes, "w6-sections.pptx");
    let ir = pptx_import::import_pptx(&out.bytes).unwrap();
    assert_eq!(ir.sections.len(), 2);
    assert_eq!(ir.sections[0].name, "Opening");
    assert_eq!(ir.sections[0].slide_ids.len(), 2);
    assert_eq!(ir.sections[1].slide_ids.len(), n - 2);
    assert!(ir.sections.iter().all(|s| s.id.starts_with('{')));

    // Import puts each section on the page it starts at.
    let doc = imported(&out.bytes);
    let state = |pid: &str| {
        let spread = native::spread_of(&doc, pid).unwrap();
        native::page_state(spread, pid)
    };
    assert_eq!(state("p1")["section"]["name"], "Opening");
    assert_eq!(state("p1")["section"]["id"], ir.sections[0].id.as_str());
    assert!(state("p2")["section"].is_null());
    assert_eq!(state("p3")["section"]["name"], "Hauptteil");

    // Renamed, moved: the slide that started the second section now opens
    // the deck's last section.
    let mut edit = as_is(&out.bytes);
    let moved = edit.slides.remove(2);
    edit.slides.push(moved);
    edit.sections = Some(vec![
        SectionPlan {
            id: Some(ir.sections[0].id.clone()),
            name: "Start".into(),
            first_page: "p1".into(),
        },
        SectionPlan {
            id: Some(ir.sections[1].id.clone()),
            name: "Hauptteil".into(),
            first_page: "p3".into(),
        },
    ]);
    let out2 = export(&out.bytes, &edit).unwrap();
    let ir2 = pptx_import::import_pptx(&out2.bytes).unwrap();
    assert_eq!(ir2.sections[0].name, "Start");
    assert_eq!(ir2.sections[0].slide_ids.len(), n - 1);
    assert_eq!(ir2.sections[1].slide_ids.len(), 1);
    keep(&out2.bytes, "w6-sections-moved.pptx");

    // No sections: the list and its extension go.
    let mut none = as_is(&out.bytes);
    none.sections = Some(vec![]);
    let gone = export(&out.bytes, &none).unwrap();
    assert!(pptx_import::import_pptx(&gone.bytes)
        .unwrap()
        .sections
        .is_empty());
}

#[test]
fn the_outline_reads_titles_and_body_levels_from_the_document() {
    let bytes = fixture("placeholders");
    let doc = imported(&bytes);
    let ir = pptx_import::import_pptx(&bytes).unwrap();
    let pages: Vec<String> = (1..=ir.slides.len()).map(|i| format!("p{i}")).collect();
    let paged = paged_store::package::wrap_document(&doc, "deck", 960.0, 540.0).unwrap();
    let o = outline::outline(&paged, &pages).unwrap();
    assert_eq!(o.len(), ir.slides.len());
    assert!(o.iter().any(|s| !s.title.is_empty()), "{o:?}");
    assert!(o.iter().any(|s| !s.body.is_empty()), "{o:?}");
    // Each title is the slide's title placeholder text, as import read it.
    for (s, page) in ir.slides.iter().zip(&o) {
        let title: Vec<String> = s
            .shapes
            .iter()
            .filter_map(|sh| match sh {
                pptx_core::Shape::Sp(sp) => {
                    let ph = sp.nv.placeholder.as_ref()?;
                    matches!(ph.kind.as_deref(), Some("title") | Some("ctrTitle"))
                        .then(|| sp.text.as_ref().map(slide_resolve::text::plain))?
                }
                _ => None,
            })
            .collect();
        let want = title
            .join(" ")
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        let got = page.title.split_whitespace().collect::<Vec<_>>().join(" ");
        assert_eq!(got, want, "{}", s.part);
    }
    // The text and RTF forms carry every title.
    let txt = slide_output::outline_txt(&o);
    let rtf = slide_output::outline_rtf(&o);
    for s in &o {
        assert!(txt.contains(&s.title));
        assert!(rtf.contains("\\outlinelevel0"));
    }
    // A page the document does not have is left out.
    assert!(outline::outline(&paged, &["nope".into()])
        .unwrap()
        .is_empty());
}
