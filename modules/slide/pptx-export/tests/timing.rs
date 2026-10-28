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

//! Animation timing written back (slide ADR 714): the timing the page
//! label carries, naming its shapes by page element and shape key, goes
//! back into the slide part with the ids the shapes were written under. An
//! unchanged timing keeps the deck's bytes; an edited one is written and
//! reads back as edited; an effect whose shape is gone is dropped and
//! reported.

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

use paged_model::FrameRef;
use paged_scene::Document;
use pptx_core::anim::{TargetEl, TimeNode, Timing};
use pptx_export::{export_with, native, ExportPlan, Exported, SlidePlan};

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

/// The page label's timing of page `page`.
fn label_timing(doc: &Document, page: usize) -> Option<Timing> {
    let sp = &doc.spreads[page].spread;
    let id = sp.pages[0].self_id.clone()?;
    let st = native::page_state(sp, &id);
    serde_json::from_value(st.get("timing")?.clone()).ok()
}

/// The plan the bundle sends, each slide's timing as its label holds it
/// (`edit` changes page `page`'s).
fn plan_of(doc: &Document, edit: Option<(usize, Timing)>) -> ExportPlan {
    ExportPlan {
        slides: doc
            .spreads
            .iter()
            .enumerate()
            .filter_map(|(i, s)| {
                let page = s.spread.pages.first()?;
                let id = page.self_id.clone()?;
                let st = native::page_state(&s.spread, &id);
                let timing = match &edit {
                    Some((p, t)) if *p == i => Some(t.clone()),
                    _ => label_timing(doc, i),
                };
                Some(SlidePlan {
                    source_part: st["part"].as_str().unwrap_or("").to_string(),
                    hidden: st["hidden"].as_bool().unwrap_or(false),
                    notes: st["notes"].as_str().map(str::to_string),
                    page_id: Some(id),
                    layout: st["layout"].as_str().map(str::to_string),
                    timing,
                    ..SlidePlan::default()
                })
            })
            .collect(),
        ..ExportPlan::default()
    }
}

fn export_doc(bytes: &[u8], doc: &Document, edit: Option<(usize, Timing)>) -> Exported {
    let paged = paged_store::package::wrap_document(doc, "deck", 960.0, 540.0).unwrap();
    export_with(bytes, &plan_of(doc, edit), Some(&paged)).unwrap()
}

/// Keep a written deck for PowerPoint's open-check (ADR 705) when
/// `PAGED_SLIDE_EXPORT_DIR` names a folder.
fn keep(bytes: &[u8], name: &str) {
    if let Ok(dir) = std::env::var("PAGED_SLIDE_EXPORT_DIR") {
        std::fs::write(PathBuf::from(dir).join(format!("{name}.pptx")), bytes).unwrap();
    }
}

fn parts(bytes: &[u8]) -> BTreeMap<String, Vec<u8>> {
    let pkg = paged_ooxml::opc::OpcPackage::read(bytes).unwrap();
    pkg.file_names()
        .map(|n| (n.to_string(), pkg.part(n).unwrap().to_vec()))
        .collect()
}

fn changed_parts(a: &[u8], b: &[u8]) -> Vec<String> {
    let (a, b) = (parts(a), parts(b));
    let names: BTreeSet<&String> = a.keys().chain(b.keys()).collect();
    names
        .into_iter()
        .filter(|n| a.get(*n) != b.get(*n))
        .cloned()
        .collect()
}

/// The timing import reads from the slide part `part` of a deck.
fn timing_of(bytes: &[u8], part: &str) -> Option<Timing> {
    pptx_import::import_pptx(bytes)
        .unwrap()
        .slides
        .into_iter()
        .find(|s| s.part == part)
        .and_then(|s| s.timing)
}

/// Every shape target's spid.
fn spids(t: &Timing) -> BTreeSet<String> {
    let mut t = t.clone();
    let mut out = BTreeSet::new();
    t.for_each_sp_target(&mut |spid, _, _| {
        out.insert(spid.clone());
    });
    out
}

/// The elements of the shape with `key` on page `page`.
fn elements(doc: &Document, page: usize, key: &str) -> Vec<FrameRef> {
    let sp = &doc.spreads[page].spread;
    sp.frames_in_order
        .iter()
        .filter(|r| {
            let id = match **r {
                FrameRef::Polygon(i) => sp.polygons[i].self_id.clone(),
                FrameRef::Rectangle(i) => sp.rectangles[i].self_id.clone(),
                FrameRef::TextFrame(i) => sp.text_frames[i].self_id.clone(),
                FrameRef::Group(i) => sp.groups[i].self_id.clone(),
                _ => None,
            };
            id.is_some_and(|id| native::label_of(sp, &id).shape.as_deref() == Some(key))
        })
        .copied()
        .collect()
}

/// The motion fixture's build slide (5): four shapes, ids 4 to 7, appear
/// and fade on click, with and after previous.
const BUILDS: usize = 4;
const BUILDS_PART: &str = "ppt/slides/slide5.xml";

#[test]
fn an_unchanged_timing_keeps_the_decks_bytes() {
    for name in ["motion", "animations"] {
        let bytes = fixture(name);
        let doc = imported(&bytes);
        let plan = plan_of(&doc, None);
        assert!(plan.slides.iter().any(|s| s.timing.is_some()), "{name}");
        let paged = paged_store::package::wrap_document(&doc, "deck", 960.0, 540.0).unwrap();
        let out = export_with(&bytes, &plan, Some(&paged)).unwrap();
        assert!(
            out.not_exported.is_empty(),
            "{name}: {:?}",
            out.not_exported
        );
        assert_eq!(
            out.bytes,
            bytes,
            "{name}: {:?}",
            changed_parts(&bytes, &out.bytes)
        );
        // Without the document the same.
        let out = pptx_export::export(&bytes, &plan).unwrap();
        assert_eq!(out.bytes, bytes, "{name}");
    }
}

#[test]
fn an_edited_timing_rewrites_that_slide_alone_and_reads_back_as_edited() {
    let bytes = fixture("motion");
    let doc = imported(&bytes);
    let mut t = label_timing(&doc, BUILDS).unwrap();
    // Slow the fade with previous down to 1.5 s.
    let mut slowed = 0;
    t.walk_mut(&mut |n| {
        if let TimeNode::AnimEffect { bhvr, .. } = n {
            if slowed == 0 {
                bhvr.ctn.dur = Some("1500".into());
                slowed += 1;
            }
        }
    });
    assert_eq!(slowed, 1);
    let out = export_doc(&bytes, &doc, Some((BUILDS, t.clone())));
    keep(&out.bytes, "timing-edited");
    assert!(out.not_exported.is_empty(), "{:?}", out.not_exported);
    assert_eq!(
        changed_parts(&bytes, &out.bytes),
        vec![BUILDS_PART.to_string()]
    );
    let back = timing_of(&out.bytes, BUILDS_PART).unwrap();
    assert_eq!(back, t.without_document_names());
    // Every other part of the slide is the deck's.
    let (a, b) = (parts(&bytes), parts(&out.bytes));
    let (a, b) = (
        String::from_utf8(a[BUILDS_PART].clone()).unwrap(),
        String::from_utf8(b[BUILDS_PART].clone()).unwrap(),
    );
    assert_eq!(
        a[..a.find("<p:timing").unwrap()],
        b[..b.find("<p:timing").unwrap()]
    );
}

#[test]
fn removing_every_animation_removes_the_timing() {
    let bytes = fixture("motion");
    let doc = imported(&bytes);
    let out = export_doc(&bytes, &doc, Some((BUILDS, Timing::default())));
    keep(&out.bytes, "timing-removed");
    assert_eq!(
        changed_parts(&bytes, &out.bytes),
        vec![BUILDS_PART.to_string()]
    );
    assert!(timing_of(&out.bytes, BUILDS_PART).is_none());
    let xml = String::from_utf8(parts(&out.bytes)[BUILDS_PART].clone()).unwrap();
    assert!(!xml.contains("<p:timing"));
}

#[test]
fn a_timing_on_a_slide_that_had_none_is_inserted_in_schema_order() {
    // Slide 1 of motion has a transition and no timing: the builds of
    // slide 5, copied onto its title (shape 3), go after the transition.
    let bytes = fixture("motion");
    let doc = imported(&bytes);
    let mut t = label_timing(&doc, BUILDS).unwrap();
    t.for_each_sp_target(&mut |spid, item, key| {
        *spid = "3".into();
        *item = None;
        *key = Some("ppt/slides/slide1.xml#3".into());
    });
    let out = export_doc(&bytes, &doc, Some((0, t.clone())));
    keep(&out.bytes, "timing-added");
    assert!(out.not_exported.is_empty(), "{:?}", out.not_exported);
    assert_eq!(
        changed_parts(&bytes, &out.bytes),
        vec!["ppt/slides/slide1.xml".to_string()]
    );
    let xml = String::from_utf8(parts(&out.bytes)["ppt/slides/slide1.xml"].clone()).unwrap();
    let tr = xml
        .find("</p:transition>")
        .or_else(|| xml.find("</mc:AlternateContent>"));
    assert!(tr.unwrap() < xml.find("<p:timing>").unwrap());
    assert_eq!(
        timing_of(&out.bytes, "ppt/slides/slide1.xml").unwrap(),
        t.without_document_names()
    );
}

#[test]
fn a_target_on_a_shape_made_in_the_editor_gets_its_new_id() {
    let bytes = fixture("motion");
    let mut doc = imported(&bytes);
    // A rectangle made in the editor on the build slide.
    let sp = &mut doc.spreads[BUILDS].spread;
    let mut r = paged_model::Polygon::new(
        "newbox",
        paged_model::Bounds {
            top: 0.0,
            left: 0.0,
            bottom: 50.0,
            right: 80.0,
        },
    );
    r.anchors = [(0.0, 0.0), (80.0, 0.0), (80.0, 50.0), (0.0, 50.0)]
        .into_iter()
        .map(|p| paged_model::PathAnchor {
            anchor: p,
            left: p,
            right: p,
        })
        .collect();
    r.item_transform = Some([1.0, 0.0, 0.0, 1.0, 100.0, 400.0]);
    sp.polygons.push(r);
    sp.frames_in_order
        .push(FrameRef::Polygon(sp.polygons.len() - 1));
    // Its own animation: the first click effect, retargeted.
    let mut t = label_timing(&doc, BUILDS).unwrap();
    t.for_each_sp_target(&mut |spid, item, key| {
        if spid == "7" {
            *spid = "0".into();
            *item = Some("newbox".into());
            *key = None;
        }
    });
    let out = export_doc(&bytes, &doc, Some((BUILDS, t)));
    keep(&out.bytes, "timing-new-shape");
    assert!(out.not_exported.is_empty(), "{:?}", out.not_exported);
    let ir = pptx_import::import_pptx(&out.bytes).unwrap();
    let slide = ir.slides.iter().find(|s| s.part == BUILDS_PART).unwrap();
    let ids: BTreeSet<u32> = slide
        .shapes
        .iter()
        .filter_map(|s| match s {
            pptx_core::Shape::Sp(sp) => Some(sp.nv.id),
            _ => None,
        })
        .collect();
    let new_id = *ids.iter().max().unwrap();
    assert!(new_id > 7, "{ids:?}");
    let got = spids(slide.timing.as_ref().unwrap());
    assert!(got.contains(&new_id.to_string()), "{got:?}");
    assert!(!got.contains("7") && !got.contains("0"), "{got:?}");
}

#[test]
fn an_effect_on_a_deleted_shape_is_dropped_and_reported() {
    let bytes = fixture("motion");
    let base = imported(&bytes);
    let mut doc = base.clone();
    // Delete shape 4 (the first build).
    let gone = elements(&doc, BUILDS, &format!("{BUILDS_PART}#4"));
    assert!(!gone.is_empty());
    doc.spreads[BUILDS]
        .spread
        .frames_in_order
        .retain(|r| !gone.contains(r));
    for timing in [None, label_timing(&base, BUILDS)] {
        let paged = paged_store::package::wrap_document(&doc, "deck", 960.0, 540.0).unwrap();
        let mut plan = plan_of(&doc, None);
        plan.slides[BUILDS].timing = timing.clone();
        let out = export_with(&bytes, &plan, Some(&paged)).unwrap();
        keep(&out.bytes, "timing-deleted-shape");
        assert_eq!(out.not_exported.len(), 1, "{:?}", out.not_exported);
        assert!(out.not_exported[0].contains("no longer on the slide"));
        let back = timing_of(&out.bytes, BUILDS_PART).unwrap();
        let got = spids(&back);
        assert!(!got.contains("4"), "{got:?}");
        assert_eq!(got, ["5", "6", "7"].map(String::from).into());
        // The rest still plays: three effects.
        let mut effects = 0;
        back.walk(&mut |n| {
            if n.container_ctn().is_some_and(|c| c.preset_class.is_some()) {
                effects += 1;
            }
        });
        assert_eq!(effects, 3);
        // No empty group is left behind.
        back.walk(&mut |n| {
            if let Some(c) = n.container_ctn() {
                assert!(!(c.has_children && c.children.is_empty()), "{n:?}");
            }
            if let TimeNode::Set { bhvr, .. } = n {
                assert!(matches!(bhvr.target, TargetEl::Sp(_)));
            }
        });
    }
}

#[test]
fn a_duplicated_slide_keeps_its_animations() {
    // The plan names the build slide twice: the copy's timing names the
    // same shape keys, and its part gets the same ids.
    let bytes = fixture("motion");
    let doc = imported(&bytes);
    let mut plan = plan_of(&doc, None);
    let dup = plan.slides[BUILDS].clone();
    plan.slides.push(dup);
    let out = pptx_export::export(&bytes, &plan).unwrap();
    keep(&out.bytes, "timing-duplicate");
    assert!(out.not_exported.is_empty(), "{:?}", out.not_exported);
    let ir = pptx_import::import_pptx(&out.bytes).unwrap();
    assert_eq!(ir.slides.len(), 6);
    assert_eq!(ir.slides[5].timing, ir.slides[BUILDS].timing);
    assert!(ir.slides[5].timing.is_some());
}

#[test]
fn an_empty_timing_on_a_slide_without_one_keeps_the_decks_bytes() {
    // The bundle sends `nodes: []` for "no animations": a slide that had
    // none keeps its bytes, with and without the document.
    let bytes = fixture("motion");
    let doc = imported(&bytes);
    let mut plan = plan_of(&doc, None);
    for s in plan.slides.iter_mut().filter(|s| s.timing.is_none()) {
        s.timing = Some(Timing::default());
    }
    let paged = paged_store::package::wrap_document(&doc, "deck", 960.0, 540.0).unwrap();
    let out = export_with(&bytes, &plan, Some(&paged)).unwrap();
    assert_eq!(out.bytes, bytes, "{:?}", changed_parts(&bytes, &out.bytes));
    let out = pptx_export::export(&bytes, &plan).unwrap();
    assert_eq!(out.bytes, bytes);
}
