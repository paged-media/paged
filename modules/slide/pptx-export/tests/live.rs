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

//! Live presets and connectors through export (engine ADR 1096; slide ADR
//! 717), against PowerPoint: the `connectors` fixture holds the same shapes
//! on both slides, and on slide 2 PowerPoint itself moved "Box B"
//! (re-routing the three connectors glued to it) and resized "Rounded
//! Rectangle 1" to 4 × 1 in. Here slide 1 is edited the same way through the
//! engine's mutations, whose live-preset follow refits the preset and routes
//! the connectors, and the exported slide 1 must hold what PowerPoint wrote
//! on slide 2.

use std::path::PathBuf;

use paged_model::live_shape::{PresetPart, PresetShape};
use paged_model::{Polygon, Spread};
use paged_mutate::operation::{PathAnchorSpec, PathPointAddress, PathPointRole};
use paged_mutate::{NodeId, Operation, PropertyPath, Value};
use paged_scene::Document;
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

fn part_text(bytes: &[u8], part: &str) -> String {
    let pkg = paged_ooxml::opc::OpcPackage::read(bytes).unwrap();
    String::from_utf8(pkg.part(part).unwrap().to_vec()).unwrap()
}

/// The ids of the elements whose slide label names shape `key` on `page`.
fn ids_of(doc: &Document, page: usize, key: &str) -> Vec<String> {
    let mut ids: Vec<String> = doc.spreads[page]
        .spread
        .labels
        .iter()
        .filter(|(_, e)| {
            e.iter()
                .any(|(k, v)| k == native::LABEL_KEY && v.contains(&format!("\"shape\":\"{key}\"")))
        })
        .map(|(id, _)| id.clone())
        .collect();
    ids.sort();
    ids
}

fn spread(doc: &Document, page: usize) -> &Spread {
    &doc.spreads[page].spread
}

/// The outline element of the shape `key` on `page`.
fn outline<'a>(doc: &'a Document, page: usize, key: &str) -> &'a Polygon {
    let ids = ids_of(doc, page, key);
    spread(doc, page)
        .polygons
        .iter()
        .find(|p| ids.contains(p.self_id.as_ref().unwrap()))
        .unwrap_or_else(|| panic!("no outline of {key}"))
}

fn live(p: &Polygon) -> &PresetShape {
    paged_preset_geom::model::live_preset(p).expect("a live preset")
}

fn set(doc: &mut Document, node: NodeId, path: PropertyPath, value: Value) {
    paged_mutate::apply(doc, &Operation::SetProperty { node, path, value }).unwrap();
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
fn imported_shapes_are_the_engines_live_presets() {
    let doc = imported(&fixture("connectors"));
    // The rounded rectangle: its program, authored adjust value and box,
    // keyed as its shape; its text frame follows the same key.
    let key = format!("{S1}#2");
    let rr = outline(&doc, 0, &key);
    let p = live(rr);
    assert_eq!(p.name, "roundRect");
    assert_eq!(
        p.adjusts,
        vec![("adj".to_string(), "val 30000".to_string())]
    );
    assert_eq!(p.frame, [0.0, 0.0, 180.0, 108.0]);
    assert_eq!((p.flip_h, p.flip_v), (false, false));
    assert_eq!(p.key.as_deref(), Some(key.as_str()));
    assert!(spread(&doc, 0).text_frames.iter().any(|f| f
        .preset_text
        .as_ref()
        .map(|t| t.key.as_str())
        == Some(key.as_str())));
    // The elbow connector (`cNvPr` 9) is glued to the elements Box A (6)
    // and Box B (7) became.
    let elbow = outline(&doc, 0, &format!("{S1}#9"));
    let c = live(elbow).connector.as_ref().expect("glued");
    let a = outline(&doc, 0, &format!("{S1}#6"))
        .self_id
        .clone()
        .unwrap();
    let b = outline(&doc, 0, &format!("{S1}#7"))
        .self_id
        .clone()
        .unwrap();
    let (st, end) = (c.start.as_ref().unwrap(), c.end.as_ref().unwrap());
    assert_eq!((st.item.as_str(), st.site), (a.as_str(), 3));
    assert_eq!((end.item.as_str(), end.site), (b.as_str(), 2));
    // The label keeps the shape, not the geometry.
    for l in spread(&doc, 0).labels.values().flatten() {
        assert!(
            !l.1.contains("\"preset\"") && !l.1.contains("\"connector\""),
            "{}",
            l.1
        );
    }
}

#[test]
fn the_unedited_connectors_deck_exports_its_own_bytes() {
    let bytes = fixture("connectors");
    let doc = imported(&bytes);
    let out = export_doc(&bytes, &doc);
    assert!(out.bytes == bytes);
}

#[test]
fn a_moved_shape_reroutes_its_connectors_as_powerpoint_does() {
    let bytes = fixture("connectors");
    let mut doc = imported(&bytes);
    // Box B moved as PowerPoint moved it on slide 2: right 36 pt, down 72.
    // The engine routes the connectors glued to it in the same apply.
    for id in ids_of(&doc, 0, &format!("{S1}#7")) {
        let sp = spread(&doc, 0);
        let (node, t) =
            if let Some(p) = sp.polygons.iter().find(|p| p.self_id.as_ref() == Some(&id)) {
                (NodeId::Polygon(id.clone()), p.item_transform)
            } else if let Some(f) = sp
                .text_frames
                .iter()
                .find(|p| p.self_id.as_ref() == Some(&id))
            {
                (NodeId::TextFrame(id.clone()), f.item_transform)
            } else {
                continue;
            };
        let mut m = t.unwrap_or([1.0, 0.0, 0.0, 1.0, 0.0, 0.0]);
        m[4] += 36.0;
        m[5] += 72.0;
        set(
            &mut doc,
            node,
            PropertyPath::FrameTransform,
            Value::Transform(Some(m)),
        );
    }
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
        c.contains(r#"<a:stCxn id="6" idx="3"/>"#) && c.contains(r#"<a:endCxn id="7" idx="2"/>"#),
        "{c}"
    );
    // Re-imported, each connector is still a live, glued preset.
    let again = imported(&out.bytes);
    assert!(live(outline(&again, 0, &format!("{S1}#9")))
        .connector
        .is_some());
}

#[test]
fn a_connector_glued_to_a_deleted_shape_loses_that_end() {
    let bytes = fixture("connectors");
    let mut doc = imported(&bytes);
    // Box B's element named by the glue is gone from the page: the engine's
    // glue now names nothing there, so the end is written unglued.
    let b = outline(&doc, 0, &format!("{S1}#7"))
        .self_id
        .clone()
        .unwrap();
    let elbow = outline(&doc, 0, &format!("{S1}#9"))
        .self_id
        .clone()
        .unwrap();
    let sp = &mut doc.spreads[0].spread;
    let p = sp
        .polygons
        .iter_mut()
        .find(|p| p.self_id.as_ref() == Some(&elbow))
        .unwrap();
    let c = p.preset.as_mut().unwrap().connector.as_mut().unwrap();
    c.end.as_mut().unwrap().item = format!("{b}-gone");
    let out = export_doc(&bytes, &doc);
    let x = shape_xml(&part_text(&out.bytes, S1), "Elbow Connector 8").to_string();
    assert!(x.contains(r#"<a:stCxn id="6" idx="3"/>"#), "{x}");
    assert!(!x.contains("endCxn"), "{x}");
}

#[test]
fn a_resized_rounded_rectangle_stays_a_preset_as_powerpoint_keeps_it() {
    let bytes = fixture("connectors");
    let mut doc = imported(&bytes);
    // Resized to 4 × 1 in from its top left, as PowerPoint did on slide 2:
    // a host's resize scales the outline's anchors; the engine refits the
    // preset (the corners keep their radius) and its text frame follows.
    let key = format!("{S1}#2");
    let poly = outline(&doc, 0, &key).clone();
    let (sx, sy) = (288.0 / 180.0, 72.0 / 108.0);
    let anchors = poly
        .anchors
        .iter()
        .map(|a| {
            let f = |q: (f32, f32)| [q.0 * sx, q.1 * sy];
            PathAnchorSpec {
                anchor: f(a.anchor),
                left: f(a.left),
                right: f(a.right),
            }
        })
        .collect();
    set(
        &mut doc,
        NodeId::Polygon(poly.self_id.clone().unwrap()),
        PropertyPath::FramePath,
        Value::FramePath {
            anchors,
            subpath_starts: poly.subpath_starts.clone(),
        },
    );
    let p = live(outline(&doc, 0, &key));
    assert_eq!(p.part, PresetPart::Fill);
    assert!((p.frame[2] - 288.0).abs() < 0.01 && (p.frame[3] - 72.0).abs() < 0.01);
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
    let a = &outline(&again, 0, &key).anchors;
    let orig = imported(&bytes);
    let b = &outline(&orig, 1, &format!("{S2}#2")).anchors;
    assert_eq!(a.len(), b.len());
    for (p, q) in a.iter().zip(b) {
        assert!(
            (p.anchor.0 - q.anchor.0).abs() < 0.01 && (p.anchor.1 - q.anchor.1).abs() < 0.01,
            "{p:?} {q:?}"
        );
    }
}

#[test]
fn an_adjust_handle_drag_writes_the_new_adjust_value() {
    let bytes = fixture("connectors");
    let mut doc = imported(&bytes);
    let rr = outline(&doc, 0, &format!("{S1}#2")).clone();
    let hs = paged_preset_geom::model::handles(live(&rr));
    assert_eq!(hs.len(), 1);
    // Drag it 10 pt to the right (the item's own coordinates).
    set(
        &mut doc,
        NodeId::Polygon(rr.self_id.clone().unwrap()),
        PropertyPath::FrameShapePresetHandle,
        Value::PathPoint {
            address: PathPointAddress {
                index: 0,
                role: PathPointRole::Anchor,
            },
            position: [(hs[0].pos.0 + 10.0) as f32, hs[0].pos.1 as f32],
        },
    );
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

#[test]
fn a_reshaped_preset_is_written_as_custom_geometry() {
    let bytes = fixture("connectors");
    let mut doc = imported(&bytes);
    let rr = outline(&doc, 0, &format!("{S1}#2")).clone();
    // One anchor dragged by hand: the preset is no longer what it draws.
    set(
        &mut doc,
        NodeId::Polygon(rr.self_id.clone().unwrap()),
        PropertyPath::FramePathPoint,
        Value::PathPoint {
            address: PathPointAddress {
                index: 0,
                role: PathPointRole::Anchor,
            },
            position: [rr.anchors[0].anchor.0 + 9.0, rr.anchors[0].anchor.1 + 9.0],
        },
    );
    assert!(paged_preset_geom::model::live_preset(outline(&doc, 0, &format!("{S1}#2"))).is_none());
    let out = export_doc(&bytes, &doc);
    let mine = shape_xml(&part_text(&out.bytes, S1), "Rounded Rectangle 1").to_string();
    assert!(mine.contains("<a:custGeom>"), "{mine}");
    assert!(!mine.contains("prstGeom"), "{mine}");
}

#[test]
fn office_line_ends_are_written_and_read_back() {
    use paged_model::{ArrowheadType, OfficeHeadKind, OfficeHeadSize, OfficeLineEnd};
    let bytes = fixture("connectors");
    let mut doc = imported(&bytes);
    // The straight connector (`cNvPr` 10) takes a large-wide, short stealth
    // head at its end (engine ADR 1093, amendment 2).
    let id = outline(&doc, 0, &format!("{S1}#10"))
        .self_id
        .clone()
        .unwrap();
    let head = OfficeLineEnd {
        kind: OfficeHeadKind::Stealth,
        w: OfficeHeadSize::Lg,
        len: OfficeHeadSize::Sm,
    };
    let p = doc.spreads[0]
        .spread
        .polygons
        .iter_mut()
        .find(|p| p.self_id.as_ref() == Some(&id))
        .unwrap();
    p.end_office_head = Some(head);
    p.end_arrow = head.nearest_arrowhead();
    let out = export_doc(&bytes, &doc);
    assert!(out.not_exported.is_empty(), "{:?}", out.not_exported);
    let x = shape_xml(&part_text(&out.bytes, S1), "Straight Arrow Connector 9").to_string();
    assert!(
        x.contains(r#"<a:tailEnd type="stealth" w="lg" len="sm"/>"#),
        "{x}"
    );
    // Imported again, the head is Office's, with the nearest InDesign kind.
    let again = imported(&out.bytes);
    let p = outline(&again, 0, &format!("{S1}#10"));
    assert_eq!(p.end_office_head, Some(head));
    assert_eq!(p.end_arrow, ArrowheadType::Barbed);
    assert_eq!(p.start_office_head, None);
}

#[test]
fn a_document_saved_with_the_old_labels_exports_as_one_with_the_engines_fields() {
    let bytes = fixture("connectors");
    let now = imported(&bytes);
    // The earlier labels: the preset, its box and the glue as `cNvPr` ids,
    // with none of the engine's fields.
    let mut old = now.clone();
    for s in &mut old.spreads {
        let sp = &mut s.spread;
        let shape_of = |sp: &Spread, id: &str| -> Option<String> {
            let v: serde_json::Value = serde_json::from_str(
                &sp.labels
                    .get(id)?
                    .iter()
                    .find(|(k, _)| k == native::LABEL_KEY)?
                    .1,
            )
            .ok()?;
            Some(v["data"]["shape"].as_str()?.to_string())
        };
        let mut labels = Vec::new();
        for p in &sp.polygons {
            let Some(pr) = &p.preset else { continue };
            let id = p.self_id.clone().unwrap();
            let mut d = serde_json::json!({
                "shape": shape_of(sp, &id),
                "preset": { "prst": pr.name, "adj": pr.adjusts },
                "box": [pr.frame[2], pr.frame[3]],
            });
            if let Some(c) = &pr.connector {
                let end = |g: &Option<paged_model::live_shape::PresetGlue>| {
                    let k = shape_of(sp, &g.as_ref()?.item)?;
                    let cnv: u32 = k.rsplit('#').next()?.parse().ok()?;
                    Some(serde_json::json!({ "id": cnv, "idx": g.as_ref()?.site }))
                };
                d["connector"] = serde_json::json!({ "st": end(&c.start), "end": end(&c.end) });
            }
            labels.push((id, d));
        }
        for p in &mut sp.polygons {
            p.preset = None;
        }
        for f in &mut sp.text_frames {
            f.preset_text = None;
        }
        for (id, d) in labels {
            let e = sp.labels.get_mut(&id).unwrap();
            e.retain(|(k, _)| k != native::LABEL_KEY);
            e.push((
                native::LABEL_KEY.to_string(),
                serde_json::json!({ "v": 1, "data": d }).to_string(),
            ));
        }
    }
    // Unedited, it exports the deck's own bytes, as the new one does.
    assert!(export_doc(&bytes, &old).bytes == bytes);
    assert!(export_doc(&bytes, &now).bytes == bytes);
    // The rounded rectangle as the earlier version left it after a resize
    // to 4 × 1 in: drawn again for the new box, the label's box updated.
    let key = format!("{S1}#2");
    let id = outline(&old, 0, &key).self_id.clone().unwrap();
    let drawn = paged_preset_geom::model::draw(&PresetShape {
        adjusts: vec![("adj".into(), "val 30000".into())],
        part: PresetPart::Fill,
        ..PresetShape::new("roundRect", 288.0, 72.0)
    })
    .unwrap();
    let sp = &mut old.spreads[0].spread;
    let p = sp
        .polygons
        .iter_mut()
        .find(|p| p.self_id.as_ref() == Some(&id))
        .unwrap();
    p.bounds = drawn.bounds().unwrap();
    p.anchors = drawn.anchors;
    let slot = sp
        .labels
        .get_mut(&id)
        .unwrap()
        .iter_mut()
        .find(|(k, _)| k == native::LABEL_KEY)
        .unwrap();
    slot.1 = slot.1.replace("[180.0,108.0]", "[288.0,72.0]");
    assert!(slot.1.contains("[288.0,72.0]"), "{}", slot.1);
    let out = export_doc(&bytes, &old);
    let mine = shape_xml(&part_text(&out.bytes, S1), "Rounded Rectangle 1").to_string();
    let ppt = shape_xml(&part_text(&bytes, S2), "Rounded Rectangle 1").to_string();
    assert!(same_box(xfrm(&mine), xfrm(&ppt)), "{mine}");
    assert!(mine.contains(r#"<a:prstGeom prst="roundRect">"#), "{mine}");
}
