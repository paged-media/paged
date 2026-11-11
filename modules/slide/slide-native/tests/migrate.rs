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

//! A document saved with slide ADR 717's live-preset labels (`preset`,
//! `box`, `connector` in `x-paged:media.paged.slide`) is lifted onto the
//! engine's live shapes (engine ADR 1096) exactly as import lowers the same
//! deck today.

use std::path::PathBuf;

use paged_scene::Document;
use serde_json::{json, Value};
use slide_native::{migrate, SLIDE_LABEL_KEY};

fn imported(name: &str) -> Document {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join(format!("../slide-conformance/fixtures/{name}.pptx"));
    let bytes = std::fs::read(p).unwrap();
    let ir = pptx_import::import_pptx(&bytes).unwrap();
    let deck = slide_resolve::resolve(&ir);
    let pkg = paged_ooxml::opc::OpcPackage::read(&bytes).unwrap();
    let images = |p: &str| pkg.part(p).map(|b| b.to_vec());
    slide_native::build(&deck, &images, name).document
}

/// The shape key's own `cNvPr` id.
fn cnv(key: &str) -> u64 {
    key.rsplit(['#', '/']).next().unwrap().parse().unwrap()
}

/// `doc` as the earlier version saved it: every element of a preset shape
/// labelled with `preset` and `box`, a connector with its glue as `cNvPr`
/// ids (and where each site was), and none of the engine's fields.
fn as_saved_before(doc: &Document) -> Document {
    let mut old = doc.clone();
    for s in &mut old.spreads {
        let sp = &mut s.spread;
        // The shape key of every element, for a glue's `cNvPr` id.
        let key_of = |labels: &std::collections::HashMap<String, Vec<(String, String)>>,
                      id: &str|
         -> Option<String> {
            let v: Value = serde_json::from_str(
                &labels
                    .get(id)?
                    .iter()
                    .find(|(k, _)| k == SLIDE_LABEL_KEY)?
                    .1,
            )
            .ok()?;
            Some(v["data"]["shape"].as_str()?.to_string())
        };
        let mut extra: Vec<(String, Value)> = Vec::new();
        for p in &mut sp.polygons {
            let Some(preset) = p.preset.take() else {
                continue;
            };
            let id = p.self_id.clone().unwrap();
            let mut data = json!({
                "preset": { "prst": preset.name, "adj": preset.adjusts },
                "box": [preset.frame[2], preset.frame[3]],
            });
            if let Some(c) = &preset.connector {
                let end = |g: &Option<paged_model::live_shape::PresetGlue>| {
                    let g = g.as_ref()?;
                    let k = key_of(&sp.labels, &g.item)?;
                    Some(json!({ "id": cnv(&k), "idx": g.site, "at": [0.0, 0.0] }))
                };
                data["connector"] = json!({ "st": end(&c.start), "end": end(&c.end) });
            }
            extra.push((id, data));
        }
        for f in &mut sp.text_frames {
            if f.preset_text.take().is_some() {
                // A text frame carried the box (and the preset) too.
                let id = f.self_id.clone().unwrap();
                let key = key_of(&sp.labels, &id).unwrap();
                let outline = extra
                    .iter()
                    .find(|(pid, _)| key_of(&sp.labels, pid).as_deref() == Some(key.as_str()))
                    .map(|(_, d)| d.clone())
                    .unwrap();
                extra.push((
                    id,
                    json!({ "preset": outline["preset"], "box": outline["box"] }),
                ));
            }
        }
        for (id, data) in extra {
            let entry = sp.labels.get_mut(&id).unwrap();
            let slot = entry
                .iter_mut()
                .find(|(k, _)| k == SLIDE_LABEL_KEY)
                .unwrap();
            let mut v: Value = serde_json::from_str(&slot.1).unwrap();
            for (k, x) in data.as_object().unwrap() {
                v["data"][k] = x.clone();
            }
            slot.1 = v.to_string();
        }
    }
    old
}

fn engine_fields(doc: &Document) -> Vec<String> {
    let mut out = Vec::new();
    for s in &doc.spreads {
        for p in &s.spread.polygons {
            out.push(format!("{:?} {:?}", p.self_id, p.preset));
        }
        for f in &s.spread.text_frames {
            out.push(format!("{:?} {:?}", f.self_id, f.preset_text));
        }
    }
    out
}

fn slide_labels(doc: &Document) -> Vec<(String, Value)> {
    let mut out = Vec::new();
    for s in &doc.spreads {
        for (id, e) in &s.spread.labels {
            for (k, v) in e {
                if k == SLIDE_LABEL_KEY {
                    out.push((
                        id.clone(),
                        serde_json::from_str::<Value>(v).unwrap()["data"].clone(),
                    ));
                }
            }
        }
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

#[test]
fn old_labels_lift_onto_the_engines_live_shapes() {
    for name in ["connectors", "geometry", "text"] {
        let now = imported(name);
        let mut old = as_saved_before(&now);
        assert!(slide_labels(&old)
            .iter()
            .any(|(_, d)| d.get("box").is_some()));
        let lifted = migrate::document(&mut old);
        assert!(lifted > 0, "{name}");
        assert_eq!(engine_fields(&old), engine_fields(&now), "{name}");
        assert_eq!(slide_labels(&old), slide_labels(&now), "{name}");
        // A second pass finds nothing: the lift runs once.
        assert_eq!(migrate::document(&mut old), 0, "{name}");
    }
}

#[test]
fn a_reshaped_path_loses_its_old_preset_and_a_chart_keeps_its_box() {
    let now = imported("connectors");
    let mut old = as_saved_before(&now);
    // Reshape the rounded rectangle by hand before the lift.
    let sp = &mut old.spreads[0].spread;
    let rr = sp
        .polygons
        .iter_mut()
        .find(|p| {
            sp.labels
                .get(p.self_id.as_ref().unwrap())
                .is_some_and(|e| e.iter().any(|(_, v)| v.contains("roundRect")))
        })
        .unwrap();
    rr.anchors[0].anchor.0 += 9.0;
    let rid = rr.self_id.clone().unwrap();
    // A chart frame's box is the chart's, not a preset's.
    let chart = json!({ "v": 1, "data": { "chart": "ppt/charts/chart1.xml", "box": [1.0, 2.0, 3.0, 4.0] } });
    let frame = sp.text_frames[0].self_id.clone().unwrap();
    sp.labels.insert(
        frame.clone(),
        vec![(SLIDE_LABEL_KEY.to_string(), chart.to_string())],
    );
    migrate::document(&mut old);
    let sp = &old.spreads[0].spread;
    let rr = sp
        .polygons
        .iter()
        .find(|p| p.self_id.as_deref() == Some(&rid))
        .unwrap();
    assert!(rr.preset.is_none());
    assert!(!sp.labels[&rid][0].1.contains("roundRect"));
    assert_eq!(sp.labels[&frame][0].1, chart.to_string());
}
