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

//! Engine ADR 1041 — pattern swatches on IDML export.
//!
//! IDML has no pattern swatch. [`lower_for_idml`] moves each frame's
//! pattern fill (stroke) into the frame's label (`paged:fillPattern`,
//! `paged:strokePattern`: the pattern and the frame's own pattern
//! transform, JSON) and gives the frame a stand-in swatch InDesign can
//! show — the first item colour that is a document colour, else `None`;
//! a paged import restores the pattern swatch and the frame's paint from
//! the label (`idml_import`). [`pattern_losses`] reports every such frame,
//! checked against the re-imported twin, and every pattern swatch no
//! frame uses (it has nowhere to ride).

use paged_model::{
    Graphic, PatternColor, PatternEntry, PATTERN_FILL_LABEL_KEY, PATTERN_ID_PREFIX,
    PATTERN_STROKE_LABEL_KEY,
};
use paged_scene::Document;
use serde::{Deserialize, Serialize};

/// What a pattern label holds.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PatternLabel {
    pattern: PatternEntry,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    transform: Option<[f32; 6]>,
}

/// A frame's paint slots, by kind.
struct Slots<'a> {
    kind: &'static str,
    id: &'a Option<String>,
    fill: Option<&'a mut Option<String>>,
    stroke: &'a mut Option<String>,
    transform: Option<[f32; 6]>,
}

fn for_each_frame(
    scene: &mut Document,
    mut f: impl FnMut(&mut Slots<'_>, &mut paged_model::Spread),
) {
    for parsed in &mut scene.spreads {
        // The frames are taken out so their spread's labels can be written.
        let mut sp = std::mem::take(&mut parsed.spread);
        let mut text_frames = std::mem::take(&mut sp.text_frames);
        let mut rectangles = std::mem::take(&mut sp.rectangles);
        let mut ovals = std::mem::take(&mut sp.ovals);
        let mut polygons = std::mem::take(&mut sp.polygons);
        let mut lines = std::mem::take(&mut sp.graphic_lines);
        for x in &mut text_frames {
            f(
                &mut Slots {
                    kind: "text frame",
                    id: &x.self_id,
                    fill: Some(&mut x.fill_color),
                    stroke: &mut x.stroke_color,
                    transform: x.pattern_transform,
                },
                &mut sp,
            );
        }
        for x in &mut rectangles {
            f(
                &mut Slots {
                    kind: "rectangle",
                    id: &x.self_id,
                    fill: Some(&mut x.fill_color),
                    stroke: &mut x.stroke_color,
                    transform: x.pattern_transform,
                },
                &mut sp,
            );
        }
        for x in &mut ovals {
            f(
                &mut Slots {
                    kind: "oval",
                    id: &x.self_id,
                    fill: Some(&mut x.fill_color),
                    stroke: &mut x.stroke_color,
                    transform: x.pattern_transform,
                },
                &mut sp,
            );
        }
        for x in &mut polygons {
            f(
                &mut Slots {
                    kind: "polygon",
                    id: &x.self_id,
                    fill: Some(&mut x.fill_color),
                    stroke: &mut x.stroke_color,
                    transform: x.pattern_transform,
                },
                &mut sp,
            );
        }
        for x in &mut lines {
            f(
                &mut Slots {
                    kind: "line",
                    id: &x.self_id,
                    fill: None,
                    stroke: &mut x.stroke_color,
                    transform: x.pattern_transform,
                },
                &mut sp,
            );
        }
        sp.text_frames = text_frames;
        sp.rectangles = rectangles;
        sp.ovals = ovals;
        sp.polygons = polygons;
        sp.graphic_lines = lines;
        parsed.spread = sp;
    }
}

/// The swatch InDesign shows instead of `pattern`.
fn stand_in(pattern: &PatternEntry, palette: &Graphic) -> String {
    pattern
        .items
        .iter()
        .find_map(|i| match &i.fill {
            Some(PatternColor::Swatch(id)) if palette.colors.contains_key(id) => Some(id.clone()),
            _ => None,
        })
        .unwrap_or_else(|| "Swatch/None".to_string())
}

/// Move every frame's pattern paint into its label, in `scene` (the
/// export's own copy), and drop the pattern swatches IDML cannot hold.
pub(crate) fn lower_for_idml(scene: &mut Document) {
    let palette = std::mem::take(&mut scene.palette);
    let label = |slot: &Option<String>, transform: Option<[f32; 6]>| -> Option<(String, String)> {
        let id = slot.as_deref()?;
        let pattern = palette.patterns.get(id)?;
        let json = serde_json::to_string(&PatternLabel {
            pattern: pattern.clone(),
            transform,
        })
        .ok()?;
        Some((stand_in(pattern, &palette), json))
    };
    for_each_frame(scene, |s, sp| {
        let Some(id) = s.id.clone() else {
            return;
        };
        let mut moved: Vec<(&str, String)> = Vec::new();
        if let Some(fill) = s.fill.as_deref_mut() {
            if let Some((stand, json)) = label(fill, s.transform) {
                *fill = Some(stand);
                moved.push((PATTERN_FILL_LABEL_KEY, json));
            }
        }
        if let Some((stand, json)) = label(s.stroke, s.transform) {
            *s.stroke = Some(stand);
            moved.push((PATTERN_STROKE_LABEL_KEY, json));
        }
        if moved.is_empty() {
            return;
        }
        let entries = sp.labels.entry(id).or_default();
        for (key, json) in moved {
            match entries.iter_mut().find(|(k, _)| k == key) {
                Some(slot) => slot.1 = json,
                None => entries.push((key.to_string(), json)),
            }
        }
    });
    scene.palette = palette;
    scene.palette.patterns.clear();
}

/// `(kind, frame id, "fill" | "stroke", pattern id)` for every frame
/// painted with a pattern.
fn pattern_uses(scene: &Document) -> Vec<(&'static str, String, &'static str, String)> {
    let mut out = Vec::new();
    let mut doc = scene.clone();
    let palette = scene.palette.clone();
    for_each_frame(&mut doc, |s, _| {
        let Some(id) = s.id.clone() else {
            return;
        };
        if let Some(Some(f)) = s.fill.as_deref() {
            if palette.patterns.contains_key(f) {
                out.push((s.kind, id.clone(), "fill", f.clone()));
            }
        }
        if let Some(st) = s.stroke.as_deref() {
            if palette.patterns.contains_key(st) {
                out.push((s.kind, id, "stroke", st.to_string()));
            }
        }
    });
    out
}

/// One line per frame whose pattern paint IDML cannot say (checked
/// against `twin`, the export re-imported, where there is one), and one
/// per pattern swatch no frame uses.
pub(crate) fn pattern_losses(scene: &Document, twin: Option<&Document>) -> Vec<String> {
    if scene.palette.patterns.is_empty() {
        return Vec::new();
    }
    let uses = pattern_uses(scene);
    let twin_uses = twin.map(pattern_uses).unwrap_or_default();
    let mut out: Vec<String> = uses
        .iter()
        .map(|(kind, id, slot, pid)| {
            let carried = twin.is_none()
                || twin_uses.iter().any(|(_, tid, ts, tp)| {
                    tid == id
                        && ts == slot
                        && tp == pid
                        && twin.and_then(|t| t.palette.patterns.get(tp))
                            == scene.palette.patterns.get(pid)
                });
            if carried {
                format!(
                    "the {slot} of {kind} `{id}` is the pattern swatch `{pid}`, a paged-native \
                     paint — IDML has none, so InDesign shows a stand-in swatch; the pattern \
                     rides in the frame's label and a paged import restores it. Save as \
                     `.paged` to keep it everywhere."
                )
            } else {
                format!(
                    "the {slot} of {kind} `{id}` is the pattern swatch `{pid}`, a paged-native \
                     paint — IDML has none, and the label meant to carry it did not survive \
                     the export. Save as `.paged` to keep it."
                )
            }
        })
        .collect();
    for pid in scene.palette.patterns.keys() {
        if pid.starts_with(PATTERN_ID_PREFIX) && !uses.iter().any(|(_, _, _, p)| p == pid) {
            out.push(format!(
                "the pattern swatch `{pid}` is used by no frame — IDML has no pattern swatch, \
                 so it is not written. Save as `.paged` to keep it."
            ));
        }
    }
    out
}
