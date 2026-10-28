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

//! Live presets and connectors through export (slide ADR 717), against
//! PowerPoint: the `connectors` fixture holds the same shapes on both
//! slides, and on slide 2 PowerPoint itself moved "Box B" (re-routing the
//! three connectors glued to it) and resized "Rounded Rectangle 1" to
//! 4 × 1 in. Here slide 1 is edited the same way through the document, the
//! live presets and connectors follow (`slide_native::live`, what the
//! bundle runs after an edit), and the exported slide 1 must hold what
//! PowerPoint wrote on slide 2.

use std::path::PathBuf;

use paged_model::{Bounds, FrameRef, PathAnchor};
use paged_scene::Document;
use pptx_export::{export_with, native, ExportPlan, Exported, SlidePlan};
use slide_native::live::{self, Element, Write};

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

fn part_text(bytes: &[u8], part: &str) -> String {
    let pkg = paged_ooxml::opc::OpcPackage::read(bytes).unwrap();
    String::from_utf8(pkg.part(part).unwrap().to_vec()).unwrap()
}

fn raw_label(doc: &Document, page: usize, id: &str) -> Option<String> {
    doc.spreads[page]
        .spread
        .labels
        .get(id)?
        .iter()
        .find(|(k, _)| k == native::LABEL_KEY)
        .map(|(_, v)| v.clone())
}

fn t64(t: Option<[f32; 6]>) -> [f64; 6] {
    t.unwrap_or([1.0, 0.0, 0.0, 1.0, 0.0, 0.0]).map(f64::from)
}

fn wire(a: &[PathAnchor]) -> Vec<[[f64; 2]; 3]> {
    let p = |q: (f32, f32)| [q.0 as f64, q.1 as f64];
    a.iter()
        .map(|x| [p(x.anchor), p(x.left), p(x.right)])
        .collect()
}

/// The labelled elements of page `page`, as the bundle hands them over.
fn elements(doc: &Document, page: usize) -> Vec<Element> {
    let sp = &doc.spreads[page].spread;
    let mut out = Vec::new();
    fn walk(doc: &Document, page: usize, refs: &[FrameRef], out: &mut Vec<Element>) {
        let sp = &doc.spreads[page].spread;
        for r in refs {
            let e = match *r {
                FrameRef::Polygon(i) => {
                    let p = &sp.polygons[i];
                    let id = p.self_id.clone().unwrap_or_default();
                    raw_label(doc, page, &id).map(|label| Element {
                        id,
                        kind: "polygon".into(),
                        label,
                        anchors: wire(&p.anchors),
                        starts: p.subpath_starts.clone(),
                        transform: t64(p.item_transform),
                        bounds: Some(
                            [p.bounds.top, p.bounds.left, p.bounds.bottom, p.bounds.right]
                                .map(f64::from),
                        ),
                    })
                }
                FrameRef::TextFrame(i) => {
                    let f = &sp.text_frames[i];
                    let id = f.self_id.clone().unwrap_or_default();
                    let b = f.bounds;
                    raw_label(doc, page, &id).map(|label| Element {
                        id,
                        kind: "textFrame".into(),
                        label,
                        anchors: Vec::new(),
                        starts: Vec::new(),
                        transform: t64(f.item_transform),
                        bounds: Some([b.top, b.left, b.bottom, b.right].map(f64::from)),
                    })
                }
                FrameRef::Group(i) => {
                    walk(doc, page, &sp.groups[i].members.clone(), out);
                    None
                }
                _ => None,
            };
            out.extend(e);
        }
    }
    walk(doc, page, &sp.frames_in_order.clone(), &mut out);
    out
}

/// Write what `follow` / `adjust` answered, as the bundle's batch does.
fn write(doc: &mut Document, page: usize, writes: &[Write]) {
    let sp = &mut doc.spreads[page].spread;
    let f = |v: f64| v as f32;
    for w in writes {
        if let Some(l) = &w.label {
            let e = sp.labels.entry(w.id.clone()).or_default();
            e.retain(|(k, _)| k != native::LABEL_KEY);
            e.push((native::LABEL_KEY.to_string(), l.clone()));
        }
        if let Some(p) = sp
            .polygons
            .iter_mut()
            .find(|p| p.self_id.as_deref() == Some(&w.id))
        {
            if let Some(a) = &w.anchors {
                p.anchors = a
                    .iter()
                    .map(|x| PathAnchor {
                        anchor: (f(x[0][0]), f(x[0][1])),
                        left: (f(x[1][0]), f(x[1][1])),
                        right: (f(x[2][0]), f(x[2][1])),
                    })
                    .collect();
            }
            if let Some(s) = &w.starts {
                p.subpath_starts = s.clone();
            }
            if let Some(t) = w.transform {
                p.item_transform = Some(t.map(f));
            }
            if let Some([t, l, b, r]) = w.bounds {
                p.bounds = Bounds {
                    top: f(t),
                    left: f(l),
                    bottom: f(b),
                    right: f(r),
                };
            }
        }
        if let Some(tf) = sp
            .text_frames
            .iter_mut()
            .find(|p| p.self_id.as_deref() == Some(&w.id))
        {
            if let Some(t) = w.transform {
                tf.item_transform = Some(t.map(f));
            }
            if let Some([t, l, b, r]) = w.bounds {
                tf.bounds = Bounds {
                    top: f(t),
                    left: f(l),
                    bottom: f(b),
                    right: f(r),
                };
            }
        }
    }
}

/// The ids of the elements of the shape with `key` on `page`.
fn ids_of(doc: &Document, page: usize, key: &str) -> Vec<String> {
    elements(doc, page)
        .into_iter()
        .filter(|e| e.label.contains(&format!("\"shape\":\"{key}\"")))
        .map(|e| e.id)
        .collect()
}

/// `name`'s element (XML) in a slide part.
fn shape_xml<'a>(xml: &'a str, name: &str) -> &'a str {
    let at = xml
        .find(&format!("name=\"{name}\""))
        .unwrap_or_else(|| panic!("no {name}"));
    let start = xml[..at]
        .rfind("<p:sp>")
        .max(xml[..at].rfind("<p:cxnSp>"))
        .unwrap();
    let end_tag = if xml[start..].starts_with("<p:cxnSp>") {
        "</p:cxnSp>"
    } else {
        "</p:sp>"
    };
    let end = start + xml[start..].find(end_tag).unwrap() + end_tag.len();
    &xml[start..end]
}

/// `a:xfrm` as (off x, off y, ext cx, ext cy, flipH, flipV, rot).
fn xfrm(el: &str) -> (i64, i64, i64, i64, bool, bool, i64) {
    let x = &el[el.find("<a:xfrm").unwrap()..];
    let x = &x[..x.find("</a:xfrm>").unwrap()];
    let num = |k: &str| -> i64 {
        x.find(&format!("{k}=\""))
            .map(|i| {
                let s = &x[i + k.len() + 2..];
                s[..s.find('"').unwrap()].parse().unwrap()
            })
            .unwrap_or(0)
    };
    (
        num(" x"),
        num(" y"),
        num("cx"),
        num("cy"),
        x.contains("flipH=\"1\""),
        x.contains("flipV=\"1\""),
        num("rot"),
    )
}

/// The same placement within a few EMU (the document keeps single
/// precision). A connector's flips may be spelt as a half turn.
fn same_box(
    a: (i64, i64, i64, i64, bool, bool, i64),
    b: (i64, i64, i64, i64, bool, bool, i64),
) -> bool {
    let close = |x: i64, y: i64| (x - y).abs() <= 130;
    close(a.0, b.0) && close(a.1, b.1) && close(a.2, b.2) && close(a.3, b.3)
}

const S1: &str = "ppt/slides/slide1.xml";
const S2: &str = "ppt/slides/slide2.xml";

#[test]
fn the_unedited_connectors_deck_exports_its_own_bytes() {
    let bytes = fixture("connectors");
    let doc = imported(&bytes);
    let out = export_doc(&bytes, &doc);
    assert!(out.bytes == bytes);
    // Nothing on an unedited page asks to be followed.
    for page in 0..doc.spreads.len() {
        assert!(
            live::follow(&elements(&doc, page)).is_empty(),
            "page {page}"
        );
    }
}

#[test]
fn a_moved_shape_reroutes_its_connectors_as_powerpoint_does() {
    let bytes = fixture("connectors");
    let mut doc = imported(&bytes);
    // Box B moved as PowerPoint moved it on slide 2: right 36 pt, down 72.
    for id in ids_of(&doc, 0, &format!("{S1}#7")) {
        let sp = &mut doc.spreads[0].spread;
        for t in sp
            .polygons
            .iter_mut()
            .filter(|p| p.self_id.as_deref() == Some(&id))
            .map(|p| &mut p.item_transform)
            .chain(
                sp.text_frames
                    .iter_mut()
                    .filter(|p| p.self_id.as_deref() == Some(&id))
                    .map(|p| &mut p.item_transform),
            )
        {
            let m = t.get_or_insert([1.0, 0.0, 0.0, 1.0, 0.0, 0.0]);
            m[4] += 36.0;
            m[5] += 72.0;
        }
    }
    let w = live::follow(&elements(&doc, 0));
    // The three connectors glued to Box B, nothing else.
    assert_eq!(w.len(), 3, "{w:?}");
    write(&mut doc, 0, &w);
    assert!(live::follow(&elements(&doc, 0)).is_empty());
    let out = export_doc(&bytes, &doc);
    keep(&out.bytes, "live-connectors-moved");
    assert!(out.not_exported.is_empty(), "{:?}", out.not_exported);
    let mine = part_text(&out.bytes, S1);
    let ppt = part_text(&bytes, S2);
    for name in [
        "Box B",
        "Elbow Connector 8",
        "Straight Arrow Connector 9",
        "Curved Connector 10",
    ] {
        let (a, b) = (xfrm(shape_xml(&mine, name)), xfrm(shape_xml(&ppt, name)));
        assert!(same_box(a, b), "{name}: ours {a:?}, PowerPoint's {b:?}");
    }
    // A connector stays a connector: its preset and its glue.
    let c = shape_xml(&mine, "Elbow Connector 8");
    assert!(c.contains(r#"<a:prstGeom prst="bentConnector3">"#), "{c}");
    assert!(
        c.contains(r#"<a:stCxn id="6" idx="3"/>"#) && c.contains(r#"<a:endCxn id="7" idx="2"/>"#)
    );
    // Re-imported, each connector is glued where it now ends.
    let again = imported(&out.bytes);
    assert!(live::follow(&elements(&again, 0)).is_empty());
}

#[test]
fn a_resized_rounded_rectangle_stays_a_preset_as_powerpoint_keeps_it() {
    let bytes = fixture("connectors");
    let mut doc = imported(&bytes);
    // Resized to 4 × 1 in from its top left, as PowerPoint did on slide 2:
    // the host scales the outline's anchors (and the text frame's box).
    let key = format!("{S1}#2");
    let ids = ids_of(&doc, 0, &key);
    let poly = doc.spreads[0]
        .spread
        .polygons
        .iter()
        .find(|p| ids.contains(p.self_id.as_ref().unwrap()))
        .unwrap()
        .clone();
    let (sx, sy) = (288.0 / 180.0, 72.0 / 108.0);
    let id = poly.self_id.clone().unwrap();
    {
        let p = doc.spreads[0]
            .spread
            .polygons
            .iter_mut()
            .find(|p| p.self_id.as_deref() == Some(&id))
            .unwrap();
        for a in &mut p.anchors {
            for q in [&mut a.anchor, &mut a.left, &mut a.right] {
                *q = (q.0 * sx, q.1 * sy);
            }
        }
    }
    let w = live::follow(&elements(&doc, 0));
    assert!(w.iter().any(|x| x.id == id), "{w:?}");
    write(&mut doc, 0, &w);
    let out = export_doc(&bytes, &doc);
    keep(&out.bytes, "live-roundrect-resized");
    let mine = shape_xml(&part_text(&out.bytes, S1), "Rounded Rectangle 1").to_string();
    let ppt = shape_xml(&part_text(&bytes, S2), "Rounded Rectangle 1").to_string();
    assert!(
        same_box(xfrm(&mine), xfrm(&ppt)),
        "{:?} vs {:?}",
        xfrm(&mine),
        xfrm(&ppt)
    );
    assert!(
        mine.contains(r#"<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val 30000"/></a:avLst></a:prstGeom>"#),
        "{mine}"
    );
    assert!(!mine.contains("custGeom"));
    // Read back, it is the shape PowerPoint drew on slide 2: same box, same
    // outline.
    let again = imported(&out.bytes);
    let a = &elements(&again, 0);
    let b = &elements(&imported(&bytes), 1);
    let outline = |els: &[Element]| {
        els.iter()
            .find(|e| e.kind == "polygon" && e.label.contains("roundRect"))
            .unwrap()
            .anchors
            .clone()
    };
    let (oa, ob) = (outline(a), outline(b));
    assert_eq!(oa.len(), ob.len());
    for (p, q) in oa.iter().zip(&ob) {
        assert!(
            (p[0][0] - q[0][0]).abs() < 0.01 && (p[0][1] - q[0][1]).abs() < 0.01,
            "{p:?} {q:?}"
        );
    }
}

#[test]
fn an_adjust_handle_drag_writes_the_new_adjust_value() {
    let bytes = fixture("connectors");
    let mut doc = imported(&bytes);
    let els = elements(&doc, 0);
    let target = els
        .iter()
        .find(|e| e.kind == "polygon" && e.label.contains("roundRect"))
        .unwrap()
        .clone();
    let hs = live::handles(&target);
    assert_eq!(hs.len(), 1);
    // Drag it 10 pt to the right.
    let w = live::adjust(&els, &target.id, 0, [hs[0].pos[0] + 10.0, hs[0].pos[1]]);
    assert!(!w.is_empty());
    write(&mut doc, 0, &w);
    assert!(live::follow(&elements(&doc, 0)).is_empty());
    let out = export_doc(&bytes, &doc);
    keep(&out.bytes, "live-roundrect-adjusted");
    let mine = shape_xml(&part_text(&out.bytes, S1), "Rounded Rectangle 1").to_string();
    // 30 000 of the short side (108 pt) is 32.4 pt; 42.4 pt is 39 259.
    assert!(
        mine.contains(r#"<a:gd name="adj" fmla="val 39259"/>"#),
        "{mine}"
    );
    assert!(same_box(
        xfrm(&mine),
        xfrm(shape_xml(&part_text(&bytes, S1), "Rounded Rectangle 1"))
    ));
    // Only slide 1 changed.
    assert_eq!(part_text(&out.bytes, S2), part_text(&bytes, S2));
}
