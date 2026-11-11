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

//! The lift of slide ADR 717's live-preset labels onto the engine's live
//! shapes (engine ADR 1096; ADR 717, amendment of 2026-11-11).
//!
//! A document saved before the move labels each element of a preset shape
//! (`x-paged:media.paged.slide`) with `preset` (`prst`, `adj`, `flip`), the
//! box its outline was drawn for (`box: [w, h]`), a connector's glue
//! (`connector.st` / `connector.end`: the glued shape's `cNvPr` id, its
//! site and where the site was) and, on a shape made in the editor, its
//! stroke-only element (`part: "detail"`). [`plan`] reads a spread's labels
//! and answers what the engine holds instead:
//!
//! - on a path still drawing its preset for that box: `Polygon::preset`
//!   (the program, its adjust values, the box, the part it draws, the
//!   shape key, a connector's glue mapped onto the glued shape's element);
//! - on the shape's text frame: `TextFrame::preset_text` (its key);
//! - every such label without those keys (a chart frame's `box` is the
//!   chart's and stays).
//!
//! [`apply`] writes a plan into the spread; [`document`] lifts a whole
//! document (export reads an old document through it). The bundle writes
//! the same plan through the host's mutations when such a document opens.

use paged_model::live_shape::{PresetConnector, PresetGlue, PresetPart, PresetShape, PresetText};
use paged_model::Spread;
use paged_scene::Document;
use serde::Serialize;
use serde_json::{Map, Value};

use crate::{ascii, SLIDE_LABEL_KEY};

/// The label keys the lift takes over (a chart's `box` excepted).
const OLD_KEYS: &[&str] = &["preset", "box", "connector", "part"];

/// What one element takes.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Lift {
    /// The element's wire kind: `polygon`, `rectangle`, `textFrame`, `oval`,
    /// `graphicLine`.
    pub kind: &'static str,
    /// Its `Self` id.
    pub id: String,
    /// A path's live preset.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preset: Option<PresetShape>,
    /// A text frame's preset key.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preset_text: Option<String>,
    /// The label's new envelope; `None` when nothing is left in it.
    pub label: Option<String>,
}

/// Whether a label (its envelope JSON) still carries the old keys.
pub fn is_old(label: &str) -> bool {
    old_data(label).is_some()
}

/// The label's data when it carries an old key.
fn old_data(label: &str) -> Option<Map<String, Value>> {
    let v: Value = serde_json::from_str(label).ok()?;
    let data = v.get("data")?.as_object()?.clone();
    let chart = data.contains_key("chart");
    OLD_KEYS
        .iter()
        .any(|k| data.contains_key(*k) && !(chart && *k == "box"))
        .then_some(data)
}

fn slide_label(spread: &Spread, id: &str) -> Option<String> {
    spread
        .labels
        .get(id)?
        .iter()
        .find(|(k, _)| k == SLIDE_LABEL_KEY)
        .map(|(_, v)| v.clone())
}

/// The kind of an element of the spread by its id.
fn kind_of(spread: &Spread, id: &str) -> Option<&'static str> {
    let has = |s: &Option<String>| s.as_deref() == Some(id);
    if spread.polygons.iter().any(|p| has(&p.self_id)) {
        Some("polygon")
    } else if spread.rectangles.iter().any(|p| has(&p.self_id)) {
        Some("rectangle")
    } else if spread.text_frames.iter().any(|p| has(&p.self_id)) {
        Some("textFrame")
    } else if spread.ovals.iter().any(|p| has(&p.self_id)) {
        Some("oval")
    } else if spread.graphic_lines.iter().any(|p| has(&p.self_id)) {
        Some("graphicLine")
    } else if spread
        .groups
        .iter()
        .any(|g| g.self_id.as_deref() == Some(id))
    {
        Some("group")
    } else {
        None
    }
}

/// A shape key's slide part and the shape's own `cNvPr` id (its last step).
fn key_parts(key: &str) -> Option<(&str, u32)> {
    let (part, path) = key.split_once('#')?;
    let id = path.rsplit('/').next()?.parse().ok()?;
    Some((part, id))
}

/// An old label's preset: its name, adjust values and box size.
type OldPreset = (String, Vec<(String, String)>, f32, f32);

fn preset_of(data: &Map<String, Value>) -> Option<OldPreset> {
    let p = data.get("preset")?;
    let name = p.get("prst")?.as_str()?.to_string();
    let adj = p
        .get("adj")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|g| {
                    let g = g.as_array()?;
                    Some((
                        g.first()?.as_str()?.to_string(),
                        g.get(1)?.as_str()?.to_string(),
                    ))
                })
                .collect()
        })
        .unwrap_or_default();
    let b = data.get("box")?.as_array()?;
    let (w, h) = (b.first()?.as_f64()?, b.get(1)?.as_f64()?);
    Some((name, adj, w as f32, h as f32))
}

/// What a spread's old labels become (empty when it has none).
pub fn plan(spread: &Spread) -> Vec<Lift> {
    // Every labelled element with an old key, in label order.
    let mut old: Vec<(String, &'static str, Map<String, Value>)> = spread
        .labels
        .keys()
        .filter_map(|id| {
            let data = old_data(&slide_label(spread, id)?)?;
            Some((id.clone(), kind_of(spread, id)?, data))
        })
        .collect();
    old.sort_by(|a, b| a.0.cmp(&b.0));
    let shape = |d: &Map<String, Value>| d.get("shape").and_then(Value::as_str).map(str::to_string);

    // 1. The paths still drawing their preset for their box.
    let mut presets: Vec<(String, PresetShape)> = Vec::new();
    for (id, kind, data) in &old {
        if *kind != "polygon" || data.contains_key("chart") {
            continue;
        }
        let Some((name, adjusts, w, h)) = preset_of(data) else {
            continue;
        };
        let Some(poly) = spread
            .polygons
            .iter()
            .find(|p| p.self_id.as_deref() == Some(id.as_str()))
        else {
            continue;
        };
        // The part import gives it: a filled outline draws the filled
        // paths, an unfilled one all of them, a stroke-only element above a
        // filled one the rest.
        let filled = poly
            .fill_color
            .as_deref()
            .is_some_and(|f| f != dml_native::NONE_SWATCH);
        let order = if filled {
            [PresetPart::Fill, PresetPart::All, PresetPart::Detail]
        } else {
            [PresetPart::All, PresetPart::Detail, PresetPart::Fill]
        };
        let part = order.into_iter().find(|&part| {
            let p = PresetShape {
                adjusts: adjusts.clone(),
                part,
                ..PresetShape::new(name.clone(), w, h)
            };
            paged_preset_geom::model::anchors_are(&p, &poly.anchors, &poly.subpath_starts)
        });
        let Some(part) = part else { continue };
        presets.push((
            id.clone(),
            PresetShape {
                adjusts,
                part,
                key: shape(data),
                ..PresetShape::new(name, w, h)
            },
        ));
    }

    // 2. A connector's glue: the glued shape's element on this spread (its
    //    outline first, then its picture frame, then its text frame).
    let rank = |k: &str| match k {
        "polygon" => 0,
        "rectangle" => 1,
        "textFrame" => 2,
        _ => 3,
    };
    let element_of = |slide_part: &str, cnv: u32| -> Option<String> {
        spread
            .labels
            .keys()
            .filter_map(|id| {
                let label = slide_label(spread, id)?;
                let v: Value = serde_json::from_str(&label).ok()?;
                let data = v.get("data")?;
                if data.get("connector").is_some() {
                    return None;
                }
                let (p, sid) = key_parts(data.get("shape")?.as_str()?)?;
                let kind = kind_of(spread, id)?;
                (p == slide_part && sid == cnv && kind != "group").then(|| (rank(kind), id.clone()))
            })
            .min()
            .map(|(_, id)| id)
    };
    for (id, _, data) in &old {
        let Some(c) = data.get("connector") else {
            continue;
        };
        let Some(slide_part) = data
            .get("shape")
            .and_then(Value::as_str)
            .and_then(key_parts)
            .map(|(p, _)| p)
        else {
            continue;
        };
        let glue = |which: &str| -> Option<PresetGlue> {
            let e = c.get(which)?;
            let cnv = e.get("id")?.as_u64()? as u32;
            let site = e.get("idx")?.as_u64()? as u32;
            Some(PresetGlue {
                item: element_of(slide_part, cnv)?,
                site,
            })
        };
        let connector = PresetConnector {
            start: glue("st"),
            end: glue("end"),
        };
        if let Some((_, p)) = presets.iter_mut().find(|(pid, _)| pid == id) {
            if connector.start.is_some() || connector.end.is_some() {
                p.connector = Some(connector);
            }
        }
    }

    // 3. Text frames of a lifted shape, and every old label rewritten.
    let lifted_keys: Vec<String> = presets.iter().filter_map(|(_, p)| p.key.clone()).collect();
    old.into_iter()
        .map(|(id, kind, mut data)| {
            let preset = presets
                .iter()
                .find(|(pid, _)| *pid == id)
                .map(|(_, p)| p.clone());
            let preset_text =
                shape(&data).filter(|k| kind == "textFrame" && lifted_keys.contains(k));
            let chart = data.contains_key("chart");
            for k in OLD_KEYS {
                if !(chart && *k == "box") {
                    data.remove(*k);
                }
            }
            let label = (!data.is_empty()).then(|| {
                ascii(&serde_json::json!({ "v": 1, "data": Value::Object(data) }).to_string())
            });
            Lift {
                kind,
                id,
                preset,
                preset_text,
                label,
            }
        })
        .collect()
}

/// Write a plan into its spread.
pub fn apply(spread: &mut Spread, lifts: &[Lift]) {
    for l in lifts {
        if let Some(p) = &l.preset {
            if let Some(poly) = spread
                .polygons
                .iter_mut()
                .find(|x| x.self_id.as_deref() == Some(l.id.as_str()))
            {
                poly.preset = Some(p.clone());
            }
        }
        if let Some(key) = &l.preset_text {
            if let Some(f) = spread
                .text_frames
                .iter_mut()
                .find(|x| x.self_id.as_deref() == Some(l.id.as_str()))
            {
                f.preset_text = Some(PresetText { key: key.clone() });
            }
        }
        if let Some(entries) = spread.labels.get_mut(&l.id) {
            match &l.label {
                Some(v) => {
                    if let Some(slot) = entries.iter_mut().find(|(k, _)| k == SLIDE_LABEL_KEY) {
                        slot.1 = v.clone();
                    }
                }
                None => entries.retain(|(k, _)| k != SLIDE_LABEL_KEY),
            }
            if entries.is_empty() {
                spread.labels.remove(&l.id);
            }
        }
    }
}

/// Lift every spread of a document; how many elements changed.
pub fn document(doc: &mut Document) -> usize {
    let mut n = 0;
    for s in &mut doc.spreads {
        let lifts = plan(&s.spread);
        n += lifts.len();
        apply(&mut s.spread, &lifts);
    }
    n
}

/// The plan of every spread of a `.paged` container, read as it was saved
/// (empty when nothing is to be lifted): what the bundle writes through
/// the host when such a document opens.
pub fn plan_paged(paged: &[u8]) -> Result<Vec<Lift>, String> {
    let doc = paged_store::package::read_document(paged)?;
    Ok(doc.spreads.iter().flat_map(|s| plan(&s.spread)).collect())
}
