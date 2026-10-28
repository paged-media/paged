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

//! Slides regenerated from the native document (ADR 704, ADR 711): the
//! document is what import builds (the engine opens it to the same model,
//! and serializes it back unchanged), edited here the way the editor's
//! mutations edit it; the written deck is read back.

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

use paged_model::FrameRef;
use paged_scene::Document;
use pptx_export::{export_with, native, ExportPlan, Exported, SlidePlan};
use slide_resolve::model::{Deck, Item, ItemKind};

const FIXTURES: &[&str] = &[
    "text",
    "geometry",
    "placeholders",
    "tables",
    "baselines",
    "motion",
    "smartart",
    "tablestyles",
];

fn fixture(name: &str) -> Vec<u8> {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join(format!("../slide-conformance/fixtures/{name}.pptx"));
    std::fs::read(p).unwrap()
}

/// The deck's native document, as import builds it.
fn imported(bytes: &[u8]) -> Document {
    let ir = pptx_import::import_pptx(bytes).unwrap();
    let deck = slide_resolve::resolve(&ir);
    let pkg = paged_ooxml::opc::OpcPackage::read(bytes).unwrap();
    let images = |p: &str| pkg.part(p).map(|b| b.to_vec());
    slide_native::build(&deck, &images, "deck").document
}

fn resolved(bytes: &[u8]) -> Deck {
    slide_resolve::resolve(&pptx_import::import_pptx(bytes).unwrap())
}

/// The plan the bundle sends: every page, in order, with its state.
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
    }
}

fn export_doc(bytes: &[u8], doc: &Document) -> Exported {
    let paged = paged_store::package::wrap_document(doc, "deck", 960.0, 540.0).unwrap();
    export_with(bytes, &plan_of(doc), Some(&paged)).unwrap()
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

/// A slide part's text.
fn part_text(bytes: &[u8], part: &str) -> String {
    String::from_utf8(parts(bytes)[part].clone()).unwrap()
}

/// The item of `slide` (0-based) with `shape_id` at the top level.
fn item(deck: &Deck, slide: usize, shape_id: u32) -> &Item {
    deck.slides[slide]
        .items
        .iter()
        .find(|i| i.meta.shape_id == shape_id)
        .unwrap_or_else(|| panic!("slide {slide}: no shape {shape_id}"))
}

fn text_of(it: &Item) -> Vec<String> {
    match &it.kind {
        ItemKind::Shape { text: Some(t), .. } => t
            .paragraphs
            .iter()
            .map(|p| p.runs.iter().map(|r| r.text.as_str()).collect())
            .collect(),
        _ => Vec::new(),
    }
}

/// The ids of the elements of the shape with `key` on page `page`.
fn elements(doc: &Document, page: usize, key: &str) -> Vec<FrameRef> {
    let sp = &doc.spreads[page].spread;
    let mut out = Vec::new();
    for r in &sp.frames_in_order {
        let id = match *r {
            FrameRef::Polygon(i) => sp.polygons[i].self_id.clone(),
            FrameRef::Rectangle(i) => sp.rectangles[i].self_id.clone(),
            FrameRef::TextFrame(i) => sp.text_frames[i].self_id.clone(),
            FrameRef::Group(i) => sp.groups[i].self_id.clone(),
            _ => None,
        };
        let Some(id) = id else { continue };
        if native::label_of(sp, &id).shape.as_deref() == Some(key) {
            out.push(*r);
        }
    }
    out
}

/// Move every element of a shape by (dx, dy), as `moveFrame` does.
fn move_shape(doc: &mut Document, page: usize, key: &str, dx: f32, dy: f32) {
    let refs = elements(doc, page, key);
    assert!(!refs.is_empty(), "no shape {key}");
    let sp = &mut doc.spreads[page].spread;
    for r in refs {
        let t = match r {
            FrameRef::Polygon(i) => &mut sp.polygons[i].item_transform,
            FrameRef::Rectangle(i) => &mut sp.rectangles[i].item_transform,
            FrameRef::TextFrame(i) => &mut sp.text_frames[i].item_transform,
            FrameRef::Group(i) => &mut sp.groups[i].item_transform,
            _ => continue,
        };
        let m = t.get_or_insert([1.0, 0.0, 0.0, 1.0, 0.0, 0.0]);
        m[4] += dx;
        m[5] += dy;
    }
}

/// The story of the shape's text frame.
fn story_of(doc: &Document, page: usize, key: &str) -> String {
    let sp = &doc.spreads[page].spread;
    elements(doc, page, key)
        .into_iter()
        .find_map(|r| match r {
            FrameRef::TextFrame(i) => sp.text_frames[i].parent_story.clone(),
            _ => None,
        })
        .unwrap()
}

fn story_mut<'a>(doc: &'a mut Document, id: &str) -> &'a mut paged_model::Story {
    &mut doc
        .stories
        .iter_mut()
        .find(|s| s.self_id == id)
        .unwrap()
        .story
}

/// The top-level shape keys of page `page`, in order.
fn top_keys(doc: &Document, page: usize) -> Vec<String> {
    let sp = &doc.spreads[page].spread;
    let mut out: Vec<String> = Vec::new();
    for s in native::page_shapes(sp) {
        if let Some(k) = s.key {
            if !k.ends_with("#bg") && !out.contains(&k) {
                out.push(k);
            }
        }
    }
    out
}

fn shape_id(key: &str) -> u32 {
    key.rsplit('#').next().unwrap().parse().unwrap()
}

#[test]
fn an_unedited_document_exports_the_original_bytes() {
    for name in FIXTURES {
        let bytes = fixture(name);
        let out = export_doc(&bytes, &imported(&bytes));
        assert!(
            out.bytes == bytes,
            "{name}: {:?}",
            changed_parts(&bytes, &out.bytes)
        );
        assert!(
            out.not_exported.is_empty(),
            "{name}: {:?}",
            out.not_exported
        );
    }
}

#[test]
fn moving_one_shape_rewrites_that_slide_alone_and_reads_back_moved() {
    for name in FIXTURES {
        let bytes = fixture(name);
        let base = imported(&bytes);
        let before = resolved(&bytes);
        for page in 0..base.spreads.len() {
            // The first, a middle and the last shape of each slide.
            let keys = top_keys(&base, page);
            let picks: BTreeSet<usize> = [0, keys.len() / 2, keys.len().saturating_sub(1)]
                .into_iter()
                .filter(|i| *i < keys.len())
                .collect();
            for key in picks.into_iter().map(|i| keys[i].clone()) {
                let mut doc = base.clone();
                move_shape(&mut doc, page, &key, 10.0, 5.0);
                let out = export_doc(&bytes, &doc);
                let part = before.slides[page].part.clone();
                assert_eq!(
                    changed_parts(&bytes, &out.bytes),
                    vec![part.clone()],
                    "{name} {key}: {:?}",
                    out.not_exported
                );
                assert!(
                    out.not_exported.is_empty(),
                    "{name} {key}: {:?}",
                    out.not_exported
                );
                let after = resolved(&out.bytes);
                let id = shape_id(&key);
                let (a, b) = (item(&before, page, id), item(&after, page, id));
                assert!(
                    (b.transform[4] - a.transform[4] - 10.0).abs() < 0.05
                        && (b.transform[5] - a.transform[5] - 5.0).abs() < 0.05,
                    "{name} {key}: {:?} → {:?}",
                    a.transform,
                    b.transform
                );
                assert!(
                    (a.w - b.w).abs() < 0.05 && (a.h - b.h).abs() < 0.05,
                    "{name} {key}: size"
                );
                // Every other shape of the slide keeps its XML.
                let after_xml = part_text(&out.bytes, &part);
                let before_xml = part_text(&bytes, &part);
                assert!(
                    after_xml.len().abs_diff(before_xml.len()) < 400,
                    "{name} {key}"
                );
            }
        }
    }
}

#[test]
fn a_resized_shape_reads_back_at_its_new_size() {
    let bytes = fixture("geometry");
    let base = imported(&bytes);
    let before = resolved(&bytes);
    let key = top_keys(&base, 0)[0].clone();
    let mut doc = base.clone();
    // resizeFrame: the outline's points scaled about its top-left.
    for r in elements(&doc, 0, &key) {
        if let FrameRef::Polygon(i) = r {
            let p = &mut doc.spreads[0].spread.polygons[i];
            let (l, t) = (p.bounds.left, p.bounds.top);
            let sc = |v: (f32, f32)| (l + (v.0 - l) * 1.5, t + (v.1 - t) * 2.0);
            for a in &mut p.anchors {
                a.anchor = sc(a.anchor);
                a.left = sc(a.left);
                a.right = sc(a.right);
            }
            p.bounds.right = l + (p.bounds.right - l) * 1.5;
            p.bounds.bottom = t + (p.bounds.bottom - t) * 2.0;
        }
    }
    let out = export_doc(&bytes, &doc);
    keep(&out.bytes, "resize");
    assert!(out.not_exported.is_empty(), "{:?}", out.not_exported);
    let after = resolved(&out.bytes);
    let id = shape_id(&key);
    let (a, b) = (item(&before, 0, id), item(&after, 0, id));
    assert!((b.w - a.w * 1.5).abs() < 0.1, "{} → {}", a.w, b.w);
    assert!((b.h - a.h * 2.0).abs() < 0.1, "{} → {}", a.h, b.h);
    // Still the preset it was.
    let xml = part_text(&out.bytes, &after.slides[0].part);
    assert_eq!(
        xml.matches("<a:prstGeom").count(),
        part_text(&bytes, &before.slides[0].part)
            .matches("<a:prstGeom")
            .count()
    );
}

#[test]
fn edited_text_reads_back_and_untouched_paragraphs_keep_their_xml() {
    let bytes = fixture("text");
    let base = imported(&bytes);
    let before = resolved(&bytes);
    let part = before.slides[0].part.clone();
    let mut doc = base.clone();
    // Title: new words. Body: paragraph 2 rewritten at 30 pt.
    let title = story_of(&doc, 0, &format!("{part}#4"));
    story_mut(&mut doc, &title).paragraphs[0].runs[0].text = "Edited <title> & more".into();
    let body = story_of(&doc, 0, &format!("{part}#5"));
    {
        let p = &mut story_mut(&mut doc, &body).paragraphs[1];
        p.runs[0].text = "Second level, rewritten".into();
        p.runs[0].point_size = Some(30.0);
    }
    let out = export_doc(&bytes, &doc);
    keep(&out.bytes, "text-edit");
    assert!(out.not_exported.is_empty(), "{:?}", out.not_exported);
    assert_eq!(changed_parts(&bytes, &out.bytes), vec![part.clone()]);
    let after = resolved(&out.bytes);
    assert_eq!(text_of(item(&after, 0, 4)), vec!["Edited <title> & more"]);
    let b = item(&after, 0, 5);
    let lines = text_of(b);
    assert_eq!(lines[1], "Second level, rewritten");
    assert_eq!(lines[0], "Level one");
    let ItemKind::Shape { text: Some(t), .. } = &b.kind else {
        panic!()
    };
    assert_eq!(t.paragraphs[1].runs[0].size, 30.0);
    assert_eq!(t.paragraphs[1].level, 1, "the list level is kept");
    // The other paragraphs' resolved runs are what they were.
    let ItemKind::Shape { text: Some(t0), .. } = &item(&before, 0, 5).kind else {
        panic!()
    };
    for i in [0usize, 2, 3, 4, 5] {
        assert_eq!(
            t.paragraphs[i].runs[0].size, t0.paragraphs[i].runs[0].size,
            "paragraph {i}"
        );
        assert_eq!(t.paragraphs[i].runs[0].font, t0.paragraphs[i].runs[0].font);
        assert_eq!(t.paragraphs[i].runs[0].rgb, t0.paragraphs[i].runs[0].rgb);
    }
    let xml = part_text(&out.bytes, &part);
    assert!(xml.contains(
        r#"<a:p><a:pPr lvl="2"/><a:r><a:rPr lang="de-DE"/><a:t>Level three</a:t></a:r></a:p>"#
    ));
}

#[test]
fn every_paragraph_rewritten_reads_back_as_it_was() {
    // Each text of each fixture written from the model alone (no paragraph
    // reused): what reads back is what import drew.
    for name in ["text", "placeholders", "baselines"] {
        let bytes = fixture(name);
        let base = imported(&bytes);
        let before = resolved(&bytes);
        for page in 0..base.spreads.len() {
            for key in top_keys(&base, page) {
                let mut doc = base.clone();
                let Some(story) = elements(&doc, page, &key)
                    .into_iter()
                    .find_map(|r| match r {
                        FrameRef::TextFrame(i) => {
                            doc.spreads[page].spread.text_frames[i].parent_story.clone()
                        }
                        _ => None,
                    })
                else {
                    continue;
                };
                let st = story_mut(&mut doc, &story);
                if st.paragraphs.iter().all(|p| p.runs.is_empty())
                    || st.paragraphs.iter().any(|p| p.table.is_some())
                {
                    continue;
                }
                // A trailing space on every run: every paragraph changes.
                for p in &mut st.paragraphs {
                    if let Some(r) = p.runs.last_mut() {
                        r.text.push('~');
                    }
                }
                let out = export_doc(&bytes, &doc);
                assert!(
                    out.not_exported.is_empty(),
                    "{name} {key}: {:?}",
                    out.not_exported
                );
                let after = resolved(&out.bytes);
                let id = shape_id(&key);
                let (ItemKind::Shape { text: Some(a), .. }, ItemKind::Shape { text: Some(b), .. }) =
                    (&item(&before, page, id).kind, &item(&after, page, id).kind)
                else {
                    continue;
                };
                assert_eq!(a.paragraphs.len(), b.paragraphs.len(), "{name} {key}");
                for (pa, pb) in a.paragraphs.iter().zip(&b.paragraphs) {
                    assert_eq!(pa.level, pb.level, "{name} {key}: level");
                    assert_eq!(pa.align, pb.align, "{name} {key}: align");
                    assert!(
                        (pa.margin_left - pb.margin_left).abs() < 0.1,
                        "{name} {key}: marL"
                    );
                    assert_eq!(
                        pa.bullet.is_some(),
                        pb.bullet.is_some(),
                        "{name} {key}: bullet"
                    );
                    let ra: Vec<_> = pa.runs.iter().filter(|r| !r.line_break).collect();
                    let rb: Vec<_> = pb.runs.iter().filter(|r| !r.line_break).collect();
                    for (x, y) in ra.iter().zip(&rb) {
                        assert!(
                            (x.size - y.size).abs() < 0.05,
                            "{name} {key}: size {} {}",
                            x.size,
                            y.size
                        );
                        assert_eq!(x.font, y.font, "{name} {key}");
                        assert_eq!(
                            (x.bold, x.italic, x.underline),
                            (y.bold, y.italic, y.underline),
                            "{name} {key}"
                        );
                        assert_eq!(x.rgb, y.rgb, "{name} {key}: colour");
                    }
                }
            }
        }
    }
}

#[test]
fn a_deleted_shape_is_gone_and_the_rest_stays() {
    let bytes = fixture("geometry");
    let base = imported(&bytes);
    let before = resolved(&bytes);
    let keys = top_keys(&base, 0);
    let mut doc = base.clone();
    let gone = elements(&doc, 0, &keys[0]);
    doc.spreads[0]
        .spread
        .frames_in_order
        .retain(|r| !gone.contains(r));
    let out = export_doc(&bytes, &doc);
    keep(&out.bytes, "delete");
    assert!(out.not_exported.is_empty(), "{:?}", out.not_exported);
    let after = resolved(&out.bytes);
    assert_eq!(
        after.slides[0].items.len(),
        before.slides[0].items.len() - 1
    );
    assert!(!after.slides[0]
        .items
        .iter()
        .any(|i| i.meta.shape_id == shape_id(&keys[0])));
    let a = pptx_import::import_pptx(&out.bytes).unwrap();
    let b = pptx_import::import_pptx(&bytes).unwrap();
    assert_eq!(a.slides[0].shapes.len(), b.slides[0].shapes.len() - 1);
}

#[test]
fn a_table_cell_edit_reads_back() {
    let bytes = fixture("tables");
    let base = imported(&bytes);
    let before = resolved(&bytes);
    let key = top_keys(&base, 0)
        .into_iter()
        .find(|k| matches!(item(&before, 0, shape_id(k)).kind, ItemKind::Table(_)))
        .expect("a table");
    let mut doc = base.clone();
    let story = story_of(&doc, 0, &key);
    {
        let t = story_mut(&mut doc, &story).paragraphs[0]
            .table
            .as_mut()
            .unwrap();
        let cell = t
            .cells
            .iter_mut()
            .find(|c| c.name.as_deref() == Some("1:1"))
            .unwrap();
        let p = &mut cell.paragraphs[0];
        if p.runs.is_empty() {
            p.runs.push(paged_model::CharacterRun::default());
        }
        p.runs[0].text = "Edited cell".into();
    }
    let out = export_doc(&bytes, &doc);
    keep(&out.bytes, "table-cell");
    assert!(out.not_exported.is_empty(), "{:?}", out.not_exported);
    assert_eq!(
        changed_parts(&bytes, &out.bytes),
        vec![before.slides[0].part.clone()]
    );
    let after = resolved(&out.bytes);
    let (ItemKind::Table(ta), ItemKind::Table(tb)) = (
        &item(&before, 0, shape_id(&key)).kind,
        &item(&after, 0, shape_id(&key)).kind,
    ) else {
        panic!()
    };
    let cell_text = |t: &slide_resolve::model::Table, r: usize, c: usize| -> String {
        t.rows[r].1[c]
            .text
            .as_ref()
            .map(|x| {
                x.paragraphs
                    .iter()
                    .flat_map(|p| p.runs.iter().map(|r| r.text.clone()))
                    .collect()
            })
            .unwrap_or_default()
    };
    assert_eq!(cell_text(tb, 1, 1), "Edited cell");
    let ra = &ta.rows[1].1[1].text.as_ref().unwrap().paragraphs[0].runs;
    let rb = &tb.rows[1].1[1].text.as_ref().unwrap().paragraphs[0].runs;
    if let Some(a) = ra.first() {
        assert_eq!(
            (a.size, &a.font, a.rgb, a.bold),
            (rb[0].size, &rb[0].font, rb[0].rgb, rb[0].bold)
        );
    }
    assert_eq!(cell_text(ta, 0, 0), cell_text(tb, 0, 0));
}

#[test]
fn a_slide_made_in_the_editor_is_exported_on_its_layout() {
    let bytes = fixture("text");
    let mut doc = imported(&bytes);
    let before = resolved(&bytes);
    // New slide from the first slide's layout: a copy of its page with only
    // its placeholders, and new text in them (what the Slides panel does).
    let mut spread = doc.spreads[0].clone();
    let old_page = spread.spread.pages[0].self_id.clone().unwrap();
    spread.spread.pages[0].self_id = Some("pnew".into());
    let layout = native::page_state(&spread.spread, &old_page)["layout"]
        .as_str()
        .unwrap()
        .to_string();
    spread.spread.labels.insert(
        "pnew".into(),
        vec![(
            native::LABEL_KEY.into(),
            format!(r#"{{"v":1,"data":{{"layout":"{layout}"}}}}"#),
        )],
    );
    spread.spread.labels.remove(&old_page);
    // New stories for its frames.
    let mut n = 0;
    for f in &mut spread.spread.text_frames {
        let Some(st) = f.parent_story.clone() else {
            continue;
        };
        n += 1;
        let new_id = format!("stnew{n}");
        let mut story = doc
            .stories
            .iter()
            .find(|s| s.self_id == st)
            .unwrap()
            .clone();
        story.self_id = new_id.clone();
        for p in &mut story.story.paragraphs {
            for r in &mut p.runs {
                r.text = format!("New {n}");
            }
        }
        doc.stories.push(story);
        f.parent_story = Some(new_id);
        f.self_id = f.self_id.as_ref().map(|s| format!("{s}new"));
    }
    let renamed: Vec<(String, Vec<(String, String)>)> = spread
        .spread
        .labels
        .iter()
        .filter(|(k, _)| *k != "pnew")
        .map(|(k, v)| (format!("{k}new"), v.clone()))
        .collect();
    spread.spread.labels.retain(|k, _| k == "pnew");
    spread.spread.labels.extend(renamed);
    doc.spreads.push(spread);

    let out = export_doc(&bytes, &doc);
    keep(&out.bytes, "new-slide");
    assert!(out.diagnostics.is_empty(), "{:?}", out.diagnostics);
    assert!(out.not_exported.is_empty(), "{:?}", out.not_exported);
    let ir = pptx_import::import_pptx(&out.bytes).unwrap();
    assert_eq!(ir.slides.len(), before.slides.len() + 1);
    let last = ir.slides.last().unwrap();
    let first = &ir.slides[0];
    assert_eq!(last.layout_part, first.layout_part, "on the same layout");
    let after = resolved(&out.bytes);
    let s = after.slides.last().unwrap();
    let texts: Vec<Vec<String>> = s
        .items
        .iter()
        .map(text_of)
        .filter(|t| !t.is_empty())
        .collect();
    assert!(texts.iter().any(|t| t[0] == "New 1"), "{texts:?}");
    assert!(texts.iter().any(|t| t[0] == "New 2"), "{texts:?}");
    // Placeholders inherit their place from the layout (no xfrm written).
    let xml = part_text(&out.bytes, &last.part);
    assert!(xml.contains("<p:ph type=\"title\"/>"), "{xml}");
    assert_eq!(xml.matches("<a:xfrm").count(), 1, "the tree's alone: {xml}");
    // Same placement and text formatting as the slide it was made like.
    for (a, b) in after.slides[0].items.iter().zip(&s.items) {
        assert!(
            geom_close(&a.transform, &b.transform),
            "{:?} {:?}",
            a.transform,
            b.transform
        );
    }
    let ct = part_text(&out.bytes, "[Content_Types].xml");
    assert!(ct.contains(&format!("PartName=\"/{}\"", last.part)));

    // A comment on the new slide (slide ADR 711) is written with it: a
    // modern comment part on the new slide part, naming its new slide id.
    let mut plan = plan_of(&doc);
    plan.slides.last_mut().unwrap().comments = Some(vec![pptx_core::Comment {
        id: "{C0C0C0C0-0000-4000-8000-0000000000AA}".into(),
        author: "Editor".into(),
        initials: "E".into(),
        created: Some("2026-10-25T13:00:00.000".into()),
        text: "On a new slide".into(),
        x: Some(12.0),
        y: Some(24.0),
        ..Default::default()
    }]);
    let paged = paged_store::package::wrap_document(&doc, "deck", 960.0, 540.0).unwrap();
    let out = export_with(&bytes, &plan, Some(&paged)).unwrap();
    keep(&out.bytes, "new-slide-comment");
    assert!(out.diagnostics.is_empty(), "{:?}", out.diagnostics);
    let ir = pptx_import::import_pptx(&out.bytes).unwrap();
    let last = ir.slides.last().unwrap();
    assert_eq!(last.comments.len(), 1);
    let c = &last.comments[0];
    assert_eq!(c.text, "On a new slide");
    assert_eq!(c.author, "Editor");
    assert_eq!((c.x, c.y), (Some(12.0), Some(24.0)));
    let xml = part_text(&out.bytes, &last.part);
    assert!(xml.contains("p188:commentRel"), "{xml}");
    let cm = paged_ooxml::opc::OpcPackage::read(&out.bytes)
        .unwrap()
        .file_names()
        .find(|n| n.contains("modernComment"))
        .map(str::to_string)
        .unwrap();
    assert!(
        part_text(&out.bytes, &cm).contains(&format!(r#"sldId="{}""#, last.slide_id)),
        "names its slide"
    );
    assert!(ir.slides[..ir.slides.len() - 1]
        .iter()
        .all(|s| s.comments.is_empty()));
}

fn geom_close(a: &[f64; 6], b: &[f64; 6]) -> bool {
    a.iter().zip(b).all(|(x, y)| (x - y).abs() < 0.05)
}

/// `text.pptx` with a URL link on slide 1's title run and a jump to the
/// next slide on its body placeholder.
fn linked_deck() -> Vec<u8> {
    let bytes = fixture("text");
    let mut pkg = paged_ooxml::opc::OpcPackage::read(&bytes).unwrap();
    let s = String::from_utf8(pkg.part("ppt/slides/slide1.xml").unwrap().to_vec()).unwrap();
    let s = s.replacen(
        r#"<a:rPr lang="de-DE"/><a:t>List levels</a:t>"#,
        r#"<a:rPr lang="de-DE"><a:hlinkClick r:id="rId90"/></a:rPr><a:t>List levels</a:t>"#,
        1,
    );
    let s = s.replacen(
        r#"name="Textplatzhalter 4">"#,
        r#"name="Textplatzhalter 4"><a:hlinkClick r:id="" action="ppaction://hlinkshowjump?jump=nextslide"/>"#,
        1,
    );
    pkg.set_part("ppt/slides/slide1.xml", s.into_bytes());
    let r = String::from_utf8(
        pkg.part("ppt/slides/_rels/slide1.xml.rels")
            .unwrap()
            .to_vec(),
    )
    .unwrap();
    let r = r.replace(
        "</Relationships>",
        r#"<Relationship Id="rId90" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://paged.media/" TargetMode="External"/></Relationships>"#,
    );
    pkg.set_part("ppt/slides/_rels/slide1.xml.rels", r.into_bytes());
    pkg.write().unwrap()
}

#[test]
fn text_and_shape_links_are_imported_and_round_trip() {
    let bytes = linked_deck();
    let doc = imported(&bytes);
    let part = "ppt/slides/slide1.xml";
    // Imported: the run's link as an engine hyperlink, the shape's action
    // as item metadata.
    let title = story_of(&doc, 0, &format!("{part}#4"));
    let st = doc.stories.iter().find(|s| s.self_id == title).unwrap();
    let src = st.story.paragraphs[0].runs[0]
        .hyperlink_source
        .clone()
        .expect("a link source");
    let h = doc
        .designmap
        .hyperlinks
        .iter()
        .find(|h| h.source.as_deref() == Some(&src))
        .unwrap();
    let d = doc
        .designmap
        .hyperlink_destinations
        .iter()
        .find(|d| Some(&d.self_id) == h.destination.as_ref())
        .unwrap();
    assert!(
        matches!(&d.kind, paged_model::HyperlinkDestinationKind::Url(u) if u == "https://paged.media/")
    );
    let body = native::page_shapes(&doc.spreads[0].spread)
        .into_iter()
        .find(|s| s.key.as_deref() == Some("ppt/slides/slide1.xml#5"))
        .unwrap();
    assert_eq!(
        body.label.link.and_then(|l| l.action).as_deref(),
        Some("ppaction://hlinkshowjump?jump=nextslide")
    );

    // Unedited: the bytes. Edited title text: the link is written again.
    assert!(export_doc(&bytes, &doc).bytes == bytes);
    let mut doc2 = doc.clone();
    story_mut(&mut doc2, &title).paragraphs[0].runs[0].text = "Linked title".into();
    let out = export_doc(&bytes, &doc2);
    keep(&out.bytes, "links");
    assert!(out.not_exported.is_empty(), "{:?}", out.not_exported);
    let ir = pptx_import::import_pptx(&out.bytes).unwrap();
    let pptx_core::Shape::Sp(t) = &ir.slides[0].shapes[0] else {
        panic!()
    };
    let run = &t.text.as_ref().unwrap().paragraphs[0].runs[0];
    assert_eq!(
        run.props.hyperlink.as_ref().and_then(|h| h.url.as_deref()),
        Some("https://paged.media/")
    );
    let pptx_core::Shape::Sp(b) = &ir.slides[0].shapes[1] else {
        panic!()
    };
    assert_eq!(
        b.nv.hyperlink.as_ref().and_then(|h| h.action.as_deref()),
        Some("ppaction://hlinkshowjump?jump=nextslide")
    );
}

#[test]
fn a_text_link_to_a_slide_targets_that_slide() {
    let bytes = fixture("text");
    let mut doc = imported(&bytes);
    let part = "ppt/slides/slide1.xml";
    let page3 = doc.spreads[2].spread.pages[0].self_id.clone().unwrap();
    doc.designmap
        .hyperlink_destinations
        .push(paged_model::HyperlinkDestination {
            self_id: "HyperlinkPageDestination/t1".into(),
            kind: paged_model::HyperlinkDestinationKind::Page(page3),
        });
    doc.designmap.hyperlinks.push(paged_model::Hyperlink {
        self_id: "Hyperlink/t1".into(),
        name: None,
        source: Some("HyperlinkTextSource/t1".into()),
        destination: Some("HyperlinkPageDestination/t1".into()),
    });
    let title = story_of(&doc, 0, &format!("{part}#4"));
    story_mut(&mut doc, &title).paragraphs[0].runs[0].hyperlink_source =
        Some("HyperlinkTextSource/t1".into());
    let out = export_doc(&bytes, &doc);
    keep(&out.bytes, "slide-link");
    assert!(out.not_exported.is_empty(), "{:?}", out.not_exported);
    let ir = pptx_import::import_pptx(&out.bytes).unwrap();
    let pptx_core::Shape::Sp(t) = &ir.slides[0].shapes[0] else {
        panic!()
    };
    let h = t.text.as_ref().unwrap().paragraphs[0].runs[0]
        .props
        .hyperlink
        .clone()
        .unwrap();
    assert_eq!(h.target_part.as_deref(), Some(ir.slides[2].part.as_str()));
    assert_eq!(h.action.as_deref(), Some("ppaction://hlinksldjump"));
}

#[test]
fn a_shape_made_in_the_editor_is_written() {
    let bytes = fixture("geometry");
    let mut doc = imported(&bytes);
    let before = resolved(&bytes);
    // An oval and a text frame, as insertOval / insertTextFrame make them.
    let sp = &mut doc.spreads[0].spread;
    let mut oval = paged_model::Polygon::new(
        "newoval",
        paged_model::Bounds {
            top: 0.0,
            left: 0.0,
            bottom: 50.0,
            right: 80.0,
        },
    );
    let k = 0.5523_f32;
    let (cx, cy, rx, ry) = (40.0f32, 25.0f32, 40.0f32, 25.0f32);
    oval.anchors = vec![
        paged_model::PathAnchor {
            anchor: (cx, 0.0),
            left: (cx - rx * k, 0.0),
            right: (cx + rx * k, 0.0),
        },
        paged_model::PathAnchor {
            anchor: (80.0, cy),
            left: (80.0, cy - ry * k),
            right: (80.0, cy + ry * k),
        },
        paged_model::PathAnchor {
            anchor: (cx, 50.0),
            left: (cx + rx * k, 50.0),
            right: (cx - rx * k, 50.0),
        },
        paged_model::PathAnchor {
            anchor: (0.0, cy),
            left: (0.0, cy + ry * k),
            right: (0.0, cy - ry * k),
        },
    ];
    oval.item_transform = Some([1.0, 0.0, 0.0, 1.0, 100.0, 120.0]);
    oval.fill_color = Some(
        doc.palette
            .colors
            .keys()
            .find(|k| k.starts_with("Color/R"))
            .cloned()
            .unwrap_or("Color/Black".into()),
    );
    sp.polygons.push(oval);
    sp.frames_in_order
        .push(FrameRef::Polygon(sp.polygons.len() - 1));
    let out = export_doc(&bytes, &doc);
    keep(&out.bytes, "new-shape");
    assert!(out.not_exported.is_empty(), "{:?}", out.not_exported);
    let after = resolved(&out.bytes);
    assert_eq!(
        after.slides[0].items.len(),
        before.slides[0].items.len() + 1
    );
    let new = after.slides[0].items.last().unwrap();
    assert!(
        (new.transform[4] - 100.0).abs() < 0.05 && (new.transform[5] - 120.0).abs() < 0.05,
        "{:?}",
        new.transform
    );
    assert!((new.w - 80.0).abs() < 0.05 && (new.h - 50.0).abs() < 0.05);
}

#[test]
fn deleting_a_shapes_outline_keeps_its_text() {
    // The editor deletes one item: a shape's outline, its text frame left.
    let bytes = fixture("geometry");
    let base = imported(&bytes);
    let before = resolved(&bytes);
    let (page, key) = (0..base.spreads.len())
        .flat_map(|p| top_keys(&base, p).into_iter().map(move |k| (p, k)))
        .find(|(p, k)| {
            let e = elements(&base, *p, k);
            e.iter().any(|r| matches!(r, FrameRef::Polygon(_)))
                && e.iter().any(|r| matches!(r, FrameRef::TextFrame(_)))
        })
        .expect("a shape with an outline and text");
    let mut doc = base.clone();
    let outline: Vec<FrameRef> = elements(&doc, page, &key)
        .into_iter()
        .filter(|r| matches!(r, FrameRef::Polygon(_)))
        .collect();
    doc.spreads[page]
        .spread
        .frames_in_order
        .retain(|r| !outline.contains(r));
    let out = export_doc(&bytes, &doc);
    assert!(out.not_exported.is_empty(), "{:?}", out.not_exported);
    let after = resolved(&out.bytes);
    let id = shape_id(&key);
    let b = item(&after, page, id);
    assert_eq!(text_of(b), text_of(item(&before, page, id)));
    let ItemKind::Shape { fill, stroke, .. } = &b.kind else {
        panic!()
    };
    assert!(matches!(fill, slide_resolve::model::Paint::None));
    assert!(stroke.is_none());
}
