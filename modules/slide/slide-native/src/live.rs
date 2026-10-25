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

//! Live presets and connectors on the document (slide ADR 717).
//!
//! The importer labels each element of a slide's shape with its preset
//! (`prst`, `adj`, `flip`), the box its outline was drawn for (`box`) and,
//! for a connector, the shapes and sites its ends are glued to with where
//! each site was (`connector.st` / `connector.end`, `at`). The bundle hands
//! this module the labelled elements of the pages an edit touched, as the
//! host holds them; this module answers what to write so that
//!
//! - a resized preset is drawn again for its new box (with its companions:
//!   the stroke-only detail element and the text frame),
//! - a connector whose glued shape moved is routed again between the sites,
//!
//! and serves the adjust handles (where they are; the adjust values a drag
//! sets) and the Insert ▸ Shapes gallery (a preset drawn as a new element).
//! All geometry is `dml-geom`'s; this module knows the labels.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use slide_geom::live::{
    self as geom, apply, drag_handle, flatten, invert, part_of, refit_preset, route, sites_on_page,
    Affine, Anchor, Part, Refit,
};
use slide_geom::{Site, SubPath};

use crate::ascii;

/// One labelled page element, as the host holds it.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Element {
    /// The element's id (its `Self`).
    pub id: String,
    /// Its kind as the host names it: `polygon`, `rectangle`, `textFrame`, …
    pub kind: String,
    /// The slide label's envelope JSON (`x-paged:media.paged.slide`).
    pub label: String,
    /// A path element's anchors (`anchor`, `left`, `right`), in its own
    /// coordinates.
    #[serde(default)]
    pub anchors: Vec<[[f64; 2]; 3]>,
    #[serde(default)]
    pub starts: Vec<usize>,
    /// Own coordinates → page.
    pub transform: Affine,
    /// `[top, left, bottom, right]` in its own coordinates (a text frame).
    #[serde(default)]
    pub bounds: Option<[f64; 4]>,
}

/// What to write to one element. Absent fields stay as they are.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Write {
    pub id: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub anchors: Option<Vec<[[f64; 2]; 3]>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub starts: Option<Vec<usize>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transform: Option<Affine>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bounds: Option<[f64; 4]>,
    /// The new label envelope.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// The element's new outline on the page, as SVG path data (a drag's
    /// preview).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

/// An element's label, read.
#[derive(Debug, Clone)]
struct Label {
    data: Value,
}

impl Label {
    fn parse(json: &str) -> Option<Label> {
        let v: Value = serde_json::from_str(json).ok()?;
        let data = v.get("data")?.clone();
        data.is_object().then_some(Label { data })
    }
    fn envelope(&self) -> String {
        ascii(&json!({ "v": 1, "data": self.data }).to_string())
    }
    fn shape(&self) -> Option<&str> {
        self.data.get("shape").and_then(Value::as_str)
    }
    fn preset(&self) -> Option<(String, Vec<(String, String)>)> {
        let p = self.data.get("preset")?;
        let prst = p.get("prst")?.as_str()?.to_string();
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
        Some((prst, adj))
    }
    fn size(&self) -> Option<(f64, f64)> {
        let b = self.data.get("box")?.as_array()?;
        Some((b.first()?.as_f64()?, b.get(1)?.as_f64()?))
    }
    fn set_size(&mut self, w: f64, h: f64) {
        self.data["box"] = json!([r3(w), r3(h)]);
    }
    fn set_adj(&mut self, adj: &[(String, String)]) {
        if let Some(p) = self.data.get_mut("preset") {
            p["adj"] = json!(adj);
        }
    }
    /// The flips a transform spells, as `a:xfrm` writes them (a mirror
    /// is `flipH`; a half turn absorbs `flipV`).
    fn set_flip(&mut self, t: &Affine) {
        let det = t[0] * t[3] - t[1] * t[2];
        if let Some(p) = self.data.get_mut("preset").and_then(Value::as_object_mut) {
            if det < 0.0 {
                p.insert("flip".into(), json!([true, false]));
            } else {
                p.remove("flip");
            }
        }
    }
    /// A connector end: the shape id, the site index and where the site
    /// was.
    fn end(&self, which: &str) -> Option<End> {
        let e = self.data.get("connector")?.get(which)?;
        let at = e
            .get("at")
            .and_then(Value::as_array)
            .and_then(|a| Some((a.first()?.as_f64()?, a.get(1)?.as_f64()?)));
        Some((
            e.get("id")?.as_u64()? as u32,
            e.get("idx")?.as_u64()? as usize,
            at,
        ))
    }
    fn set_end_at(&mut self, which: &str, at: (f64, f64)) {
        if let Some(e) = self
            .data
            .get_mut("connector")
            .and_then(|c| c.get_mut(which))
        {
            e["at"] = json!([r3(at.0), r3(at.1)]);
        }
    }
}

/// A glued connector end: the shape's id, its site's index, and where that
/// site was when the connector was last routed.
type End = (u32, usize, Option<(f64, f64)>);

fn r3(v: f64) -> f64 {
    (v * 1000.0).round() / 1000.0
}

/// The bounding box of anchors' anchor points: `[top, left, bottom, right]`
/// (a path item's bounds, as the engine and the importer keep them).
fn anchor_bounds(a: &[Anchor]) -> Option<[f64; 4]> {
    let mut b = [f64::MAX, f64::MAX, f64::MIN, f64::MIN];
    for p in a {
        b = [
            b[0].min(p[0].1),
            b[1].min(p[0].0),
            b[2].max(p[0].1),
            b[3].max(p[0].0),
        ];
    }
    (b[0] <= b[2]).then_some(b)
}

fn anchors_of(e: &Element) -> Vec<Anchor> {
    e.anchors
        .iter()
        .map(|a| [(a[0][0], a[0][1]), (a[1][0], a[1][1]), (a[2][0], a[2][1])])
        .collect()
}

/// A path's anchors mapped onto its box, when the two disagree: the
/// engine's resize of one path item writes its bounds and leaves its
/// anchors (`None` when they agree).
fn anchors_on_bounds(e: &Element) -> Option<Vec<Anchor>> {
    let a = anchors_of(e);
    let (now, was) = (e.bounds?, anchor_bounds(&a)?);
    if e.kind != "polygon" || now.iter().zip(was).all(|(x, y)| (x - y).abs() < 0.01) {
        return None;
    }
    let axis = |lo: f64, hi: f64, nlo: f64, nhi: f64| {
        if (hi - lo).abs() < 1e-9 {
            (1.0, nlo - lo)
        } else {
            let s = (nhi - nlo) / (hi - lo);
            (s, nlo - s * lo)
        }
    };
    let (sx, ox) = axis(was[1], was[3], now[1], now[3]);
    let (sy, oy) = axis(was[0], was[2], now[0], now[2]);
    Some(
        a.iter()
            .map(|p| p.map(|(x, y)| (x * sx + ox, y * sy + oy)))
            .collect(),
    )
}

/// Refit an element: its anchors as they are, or, when they are still the
/// preset for its box but its bounds moved, the anchors on its bounds.
fn refit_element(
    prst: &str,
    adj: &[(String, String)],
    w: f64,
    h: f64,
    e: &Element,
) -> Option<Refit> {
    let r = refit_preset(prst, adj, w, h, &anchors_of(e), &e.starts, &e.transform)?;
    match (&r, anchors_on_bounds(e)) {
        (Refit::Same, Some(mapped)) => {
            refit_preset(prst, adj, w, h, &mapped, &e.starts, &e.transform)
        }
        _ => Some(r),
    }
}

/// A path write with the bounds its anchors give (the engine keeps a
/// path's bounds beside its anchors and does not derive them).
fn path_bounds(a: &[Anchor]) -> Option<[f64; 4]> {
    anchor_bounds(a).map(|b| b.map(r3))
}

fn wire_anchors(a: &[Anchor]) -> Vec<[[f64; 2]; 3]> {
    let q = |p: (f64, f64)| [r3(p.0), r3(p.1)];
    a.iter().map(|x| [q(x[0]), q(x[1]), q(x[2])]).collect()
}

fn near_t(a: &Affine, b: &Affine) -> bool {
    a.iter().take(4).zip(b).all(|(x, y)| (x - y).abs() < 1e-3)
        && (a[4] - b[4]).abs() < 0.01
        && (a[5] - b[5]).abs() < 0.01
}

/// The shape key's slide part and the shape's own `cNvPr` id (the key's
/// last step).
fn key_parts(key: &str) -> Option<(&str, u32)> {
    let (part, path) = key.split_once('#')?;
    let id = path.rsplit('/').next()?.parse().ok()?;
    Some((part, id))
}

/// Which of the preset's subpaths an element draws (from its anchors,
/// against the outline for its box).
fn part_drawn(prst: &str, adj: &[(String, String)], w: f64, h: f64, e: &Element) -> Option<Part> {
    let old = slide_geom::preset(prst, adj, w, h)?.subpaths;
    let anchors = anchors_of(e);
    [Part::Fill, Part::All, Part::Detail]
        .into_iter()
        .find(|&p| {
            let exp = part_of(&old, p);
            !exp.is_empty() && geom::fit(&exp, &anchors, &e.starts).is_some()
        })
}

/// SVG path data of `subpaths` placed by `t`.
pub fn svg_path(subpaths: &[SubPath], t: &Affine) -> String {
    let mut d = String::new();
    let f = |p: (f64, f64)| {
        let q = apply(t, p);
        format!("{:.2} {:.2}", q.0, q.1)
    };
    for s in subpaths {
        let pts = &s.points;
        let Some(first) = pts.first() else { continue };
        d.push_str(&format!("M{} ", f(first.anchor)));
        let segs = if s.closed { pts.len() } else { pts.len() - 1 };
        for i in 0..segs {
            let (a, b) = (pts[i], pts[(i + 1) % pts.len()]);
            d.push_str(&format!("C{} {} {} ", f(a.right), f(b.left), f(b.anchor)));
        }
        if s.closed {
            d.push('Z');
        }
    }
    d.trim_end().to_string()
}

/// What an edit to the pages of `elements` asks of the live presets and
/// connectors on them: the resized presets drawn again for their boxes,
/// with their companions, and the connectors whose glued shapes moved
/// routed again. Empty when the elements already agree with their labels
/// (an edit elsewhere on the page, or the answer of an earlier call).
pub fn follow(elements: &[Element]) -> Vec<Write> {
    let labels: Vec<Option<Label>> = elements.iter().map(|e| Label::parse(&e.label)).collect();
    let mut writes: Vec<Write> = Vec::new();
    // Elements already answered, with their new placement and box.
    let mut placed: std::collections::HashMap<usize, (Affine, f64, f64)> = Default::default();

    // 1. Resized presets.
    for (i, e) in elements.iter().enumerate() {
        if placed.contains_key(&i) || e.kind != "polygon" {
            continue;
        }
        let Some(label) = &labels[i] else { continue };
        let (Some((prst, adj)), Some((w, h))) = (label.preset(), label.size()) else {
            continue;
        };
        let Some(Refit::Regenerated(r)) = refit_element(&prst, &adj, w, h, e) else {
            continue;
        };
        let mut nl = label.clone();
        nl.set_size(r.w, r.h);
        nl.set_flip(&r.transform);
        let (a, s, _) = flatten(&r.subpaths);
        writes.push(Write {
            id: e.id.clone(),
            kind: e.kind.clone(),
            bounds: path_bounds(&a),
            anchors: Some(wire_anchors(&a)),
            starts: Some(s),
            transform: Some(r.transform),
            label: Some(nl.envelope()),
            ..Write::default()
        });
        placed.insert(i, (r.transform, r.w, r.h));
        // Its companions on the same box: the detail element and the text
        // frame, unless they were moved apart from it.
        let Some(key) = label.shape() else { continue };
        for (j, sib) in elements.iter().enumerate() {
            if j == i || placed.contains_key(&j) || !near_t(&sib.transform, &e.transform) {
                continue;
            }
            let Some(sl) = &labels[j] else { continue };
            if sl.shape() != Some(key) {
                continue;
            }
            let mut snl = sl.clone();
            snl.set_size(r.w, r.h);
            snl.set_flip(&r.transform);
            let mut w2 = Write {
                id: sib.id.clone(),
                kind: sib.kind.clone(),
                transform: Some(r.transform),
                label: Some(snl.envelope()),
                ..Write::default()
            };
            if sib.kind == "polygon" {
                let Some(part) = part_drawn(&prst, &adj, w, h, sib) else {
                    continue;
                };
                let Some(out) = slide_geom::preset(&prst, &adj, r.w, r.h) else {
                    continue;
                };
                let (a, s, _) = flatten(&part_of(&out.subpaths, part));
                w2.bounds = path_bounds(&a);
                w2.anchors = Some(wire_anchors(&a));
                w2.starts = Some(s);
            } else if let Some([t, l, b, rr]) = sib.bounds {
                let (sx, sy) = r.scale;
                w2.bounds = Some([r3(t * sy), r3(l * sx), r3(b * sy), r3(rr * sx)]);
            }
            writes.push(w2);
            placed.insert(j, (r.transform, r.w, r.h));
        }
    }

    // 2. Connectors whose glued shapes moved.
    let site_of = |shape_part: &str, id: u32, idx: usize| -> Option<Site> {
        // The shape's element: a path first (its own outline), then a
        // picture frame, then a text frame.
        let rank = |k: &str| match k {
            "polygon" => 0,
            "rectangle" => 1,
            "textFrame" => 2,
            _ => 3,
        };
        let (j, l) = elements
            .iter()
            .enumerate()
            .filter_map(|(j, _)| {
                let l = labels[j].as_ref()?;
                let (p, sid) = key_parts(l.shape()?)?;
                (p == shape_part && sid == id && l.data.get("connector").is_none())
                    .then_some((j, l))
            })
            .min_by_key(|(j, _)| rank(&elements[*j].kind))?;
        let (t, w, h) = match placed.get(&j) {
            Some(&(t, w, h)) => (t, w, h),
            None => {
                let (w, h) = l.size()?;
                (elements[j].transform, w, h)
            }
        };
        let (name, adj) = l.preset().unwrap_or(("rect".into(), Vec::new()));
        sites_on_page(&name, &adj, w, h, &t).get(idx).copied()
    };
    for (i, e) in elements.iter().enumerate() {
        if e.kind != "polygon" {
            continue;
        }
        let Some(label) = &labels[i] else { continue };
        if label.data.get("connector").is_none() {
            continue;
        }
        let (Some((prst, adj)), Some(key)) = (label.preset(), label.shape()) else {
            continue;
        };
        let Some((part, _)) = key_parts(key) else {
            continue;
        };
        let (t, anchors) = match writes.iter().find(|w| w.id == e.id) {
            // Resized above: route from what was just drawn.
            Some(w) => (
                w.transform.unwrap_or(e.transform),
                w.anchors
                    .as_ref()
                    .map(|a| {
                        a.iter()
                            .map(|x| [(x[0][0], x[0][1]), (x[1][0], x[1][1]), (x[2][0], x[2][1])])
                            .collect()
                    })
                    .unwrap_or_else(|| anchors_of(e)),
            ),
            None => (e.transform, anchors_of(e)),
        };
        let (Some(first), Some(last)) = (anchors.first(), anchors.last()) else {
            continue;
        };
        let mut moved = false;
        let mut ends: [Option<Site>; 2] = [None, None];
        for (k, which) in ["st", "end"].into_iter().enumerate() {
            let Some((id, idx, at)) = label.end(which) else {
                continue;
            };
            let Some(at) = at else { continue };
            let Some(site) = site_of(part, id, idx) else {
                continue;
            };
            if (site.pos.0 - at.0).abs() > 0.01 || (site.pos.1 - at.1).abs() > 0.01 {
                moved = true;
            }
            ends[k] = Some(site);
        }
        if !moved {
            continue;
        }
        // An end glued to nothing that is followed stays where it is.
        let start = ends[0].unwrap_or(Site {
            pos: apply(&t, first[0]),
            angle: 180.0,
        });
        let end = ends[1].unwrap_or(Site {
            pos: apply(&t, last[0]),
            angle: 0.0,
        });
        let Some(routed) = route(&prst, &adj, start, end) else {
            continue;
        };
        let mut nl = label.clone();
        nl.set_size(routed.w, routed.h);
        nl.set_flip(&routed.transform);
        if let Some(s) = ends[0] {
            nl.set_end_at("st", s.pos);
        }
        if let Some(s) = ends[1] {
            nl.set_end_at("end", s.pos);
        }
        let (a, s, _) = flatten(&routed.subpaths);
        writes.retain(|w| w.id != e.id);
        writes.push(Write {
            id: e.id.clone(),
            kind: e.kind.clone(),
            bounds: path_bounds(&a),
            anchors: Some(wire_anchors(&a)),
            starts: Some(s),
            transform: Some(routed.transform),
            label: Some(nl.envelope()),
            ..Write::default()
        });
    }
    writes
}

/// One adjust handle of a selected preset, on the page.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageHandle {
    pub index: usize,
    pub pos: [f64; 2],
    pub polar: bool,
}

/// The adjust handles of a live preset element (none for an element that
/// is no preset, or whose anchors no longer are its preset's).
pub fn handles(e: &Element) -> Vec<PageHandle> {
    let Some(label) = Label::parse(&e.label) else {
        return Vec::new();
    };
    let (Some((prst, adj)), Some((w, h))) = (label.preset(), label.size()) else {
        return Vec::new();
    };
    if label.data.get("connector").is_some()
        && (label.end("st").is_some() || label.end("end").is_some())
    {
        // A glued connector is routed, not adjusted by hand (yet).
        return Vec::new();
    }
    if e.kind == "polygon" && !matches!(refit_element(&prst, &adj, w, h, e), Some(Refit::Same)) {
        return Vec::new();
    }
    geom::handles(&prst, &adj, w, h)
        .unwrap_or_default()
        .into_iter()
        .enumerate()
        .map(|(index, hd)| {
            let p = apply(&e.transform, hd.pos);
            PageHandle {
                index,
                pos: [r3(p.0), r3(p.1)],
                polar: hd.polar,
            }
        })
        .collect()
}

/// Drag handle `index` of element `target` to `point` (page): the new
/// adjust values, written to every element of the shape (its outline, its
/// detail element and the labels of all), with the target's new outline as
/// SVG path data for a preview.
pub fn adjust(elements: &[Element], target: &str, index: usize, point: [f64; 2]) -> Vec<Write> {
    let Some(t) = elements.iter().find(|e| e.id == target) else {
        return Vec::new();
    };
    let Some(label) = Label::parse(&t.label) else {
        return Vec::new();
    };
    let (Some((prst, adj)), Some((w, h))) = (label.preset(), label.size()) else {
        return Vec::new();
    };
    let Some(inv) = invert(&t.transform) else {
        return Vec::new();
    };
    let local = apply(&inv, (point[0], point[1]));
    let Some(new_adj) = drag_handle(&prst, &adj, w, h, index, local) else {
        return Vec::new();
    };
    let Some(out) = slide_geom::preset(&prst, &new_adj, w, h) else {
        return Vec::new();
    };
    let key = label.shape().map(str::to_string);
    let mut writes = Vec::new();
    for e in elements {
        let Some(l) = Label::parse(&e.label) else {
            continue;
        };
        let same = if e.id == target {
            true
        } else {
            key.is_some() && l.shape() == key.as_deref() && near_t(&e.transform, &t.transform)
        };
        if !same {
            continue;
        }
        let mut nl = l.clone();
        nl.set_adj(&new_adj);
        let mut wr = Write {
            id: e.id.clone(),
            kind: e.kind.clone(),
            label: Some(nl.envelope()),
            ..Write::default()
        };
        if e.kind == "polygon" {
            let Some(part) = part_drawn(&prst, &adj, w, h, e) else {
                continue;
            };
            let sub = part_of(&out.subpaths, part);
            let (a, s, _) = flatten(&sub);
            wr.bounds = path_bounds(&a);
            wr.anchors = Some(wire_anchors(&a));
            wr.starts = Some(s);
            if e.id == target {
                wr.path = Some(svg_path(&sub, &e.transform));
            }
        }
        writes.push(wr);
    }
    writes
}

/// A preset drawn as a new shape (Insert ▸ Shapes): page items for the
/// host's paste door (`pasteElements`), one undo step. The outline element
/// and, for a preset with stroke-only detail paths, the detail element
/// above it, each labelled as a live preset with the box `(0, 0)`–`(w, h)`
/// (centred where the paste puts it).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewShape {
    /// The paste door's snippet JSON.
    pub snippet: String,
    /// How many elements it holds.
    pub elements: usize,
}

/// The fill and line a new shape takes: PowerPoint's default shape style
/// on the Office theme (Accent 1, its line a shade darker, 1 pt), until
/// the deck's own theme swatches are in the document (slide W3).
const NEW_FILL: (&str, [f32; 3]) = ("Color/paged.slide/shape-fill", [68.0, 114.0, 196.0]);
const NEW_LINE: (&str, [f32; 3]) = ("Color/paged.slide/shape-line", [47.0, 82.0, 143.0]);

/// Preset `prst` with its default adjust values, drawn for a `w` × `h`
/// box, its elements labelled with `key` (a shape key of the editor's own,
/// `new:…`, so its elements move together). `None` for an unknown preset.
pub fn new_shape(prst: &str, w: f64, h: f64, key: &str) -> Option<NewShape> {
    use paged_model::{Bounds, ColorEntry, ColorModel, ColorSpace, FrameRef, Polygon, Spread};
    let out = slide_geom::preset(prst, &[], w, h)?;
    let label = |detail: bool| {
        let mut data = json!({
            "shape": key,
            "preset": { "prst": prst, "adj": Vec::<(String, String)>::new() },
            "box": [r3(w), r3(h)],
        });
        if detail {
            data["part"] = json!("detail");
        }
        ascii(&json!({ "v": 1, "data": data }).to_string())
    };
    let filled = part_of(&out.subpaths, Part::Fill);
    let parts: Vec<(Vec<SubPath>, bool)> = if filled.is_empty() {
        vec![(part_of(&out.subpaths, Part::All), false)]
    } else {
        vec![
            (filled, true),
            (part_of(&out.subpaths, Part::Detail), false),
        ]
    };
    let mut spread = Spread::default();
    let name = format!("{} 1", crate::live::display_name(prst));
    for (i, (sub, fill)) in parts.into_iter().enumerate() {
        if sub.is_empty() {
            continue;
        }
        let id = format!("s{}", i + 1);
        let path = crate::Outline::of(&sub);
        let poly = Polygon {
            item_transform: Some([1.0, 0.0, 0.0, 1.0, 0.0, 0.0]),
            fill_color: Some(if fill { NEW_FILL.0 } else { crate::NONE_SWATCH }.to_string()),
            stroke_color: Some(NEW_LINE.0.to_string()),
            stroke_weight: Some(1.0),
            applied_object_style: Some(crate::NO_OBJECT_STYLE.into()),
            bounds: path.bounds(),
            anchors: path.anchors,
            subpath_starts: path.starts,
            subpath_open: path.open,
            ..Polygon::new(id.clone(), Bounds::ZERO)
        };
        spread.labels.insert(
            id.clone(),
            vec![(crate::SLIDE_LABEL_KEY.to_string(), label(i > 0))],
        );
        spread.item_names.insert(id.clone(), name.clone());
        spread.polygons.push(poly);
        spread
            .frames_in_order
            .push(FrameRef::Polygon(spread.polygons.len() - 1));
    }
    if spread.frames_in_order.is_empty() {
        return None;
    }
    let color = |(id, rgb): (&str, [f32; 3])| ColorEntry {
        self_id: id.to_string(),
        name: None,
        space: ColorSpace::Rgb,
        value: rgb.to_vec(),
        model: ColorModel::Process,
        alternate_space: None,
        alternate_value: Vec::new(),
        tint: None,
        alpha: None,
    };
    let elements = spread.frames_in_order.len();
    let snippet = json!({
        "format": "paged.snippet/1",
        "spread": spread,
        "stories": [],
        "bounds": [0.0, 0.0, h, w],
        "resources": {
            "colors": {
                NEW_FILL.0: color(NEW_FILL),
                NEW_LINE.0: color(NEW_LINE),
            }
        }
    });
    Some(NewShape {
        snippet: snippet.to_string(),
        elements,
    })
}

/// A preset's name as people read it: `roundRect` → `Round Rect`.
pub fn display_name(prst: &str) -> String {
    let mut out = String::new();
    for (i, c) in prst.chars().enumerate() {
        if i == 0 {
            out.extend(c.to_uppercase());
        } else if c.is_ascii_uppercase()
            || (c.is_ascii_digit() && !out.ends_with(|d: char| d.is_ascii_digit()))
        {
            out.push(' ');
            out.push(c);
        } else {
            out.push(c);
        }
    }
    out
}

/// The gallery: every preset, by PowerPoint's Insert ▸ Shapes category,
/// with a small outline to show (SVG path data in a 40 × 30 box).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GalleryItem {
    pub prst: String,
    pub category: &'static str,
    pub path: String,
}

/// PowerPoint's Insert ▸ Shapes category of a preset.
pub fn category(prst: &str) -> &'static str {
    const LINES: &[&str] = &[
        "line",
        "straightConnector1",
        "bentConnector2",
        "bentConnector3",
        "bentConnector4",
        "bentConnector5",
        "curvedConnector2",
        "curvedConnector3",
        "curvedConnector4",
        "curvedConnector5",
        "lineInv",
    ];
    const RECTS: &[&str] = &[
        "rect",
        "roundRect",
        "snip1Rect",
        "snip2SameRect",
        "snip2DiagRect",
        "snipRoundRect",
        "round1Rect",
        "round2SameRect",
        "round2DiagRect",
    ];
    const EQUATION: &[&str] = &[
        "mathPlus",
        "mathMinus",
        "mathMultiply",
        "mathDivide",
        "mathEqual",
        "mathNotEqual",
    ];
    if LINES.contains(&prst) {
        "lines"
    } else if RECTS.contains(&prst) {
        "rectangles"
    } else if EQUATION.contains(&prst) {
        "equation"
    } else if prst.starts_with("flowChart") {
        "flowchart"
    } else if prst.starts_with("actionButton") {
        "actionButtons"
    } else if prst.contains("Callout")
        || prst.starts_with("callout")
        || prst.starts_with("wedge")
        || prst == "cloudCallout"
    {
        "callouts"
    } else if prst.starts_with("star")
        || prst.contains("Ribbon")
        || prst.starts_with("ribbon")
        || prst.contains("Scroll")
        || prst == "wave"
        || prst == "doubleWave"
        || prst.starts_with("irregularSeal")
    {
        "starsAndBanners"
    } else if prst.contains("Arrow") || prst.starts_with("chevron") || prst == "homePlate" {
        "blockArrows"
    } else {
        "basicShapes"
    }
}

/// Every preset for the gallery, in category order, then by name.
pub fn gallery() -> Vec<GalleryItem> {
    const ORDER: &[&str] = &[
        "lines",
        "rectangles",
        "basicShapes",
        "blockArrows",
        "equation",
        "flowchart",
        "starsAndBanners",
        "callouts",
        "actionButtons",
    ];
    let mut items: Vec<GalleryItem> = slide_geom::preset_names()
        .into_iter()
        .filter_map(|n| {
            let o = slide_geom::preset(n, &[], 40.0, 30.0)?;
            Some(GalleryItem {
                prst: n.to_string(),
                category: category(n),
                path: svg_path(&o.subpaths, &geom::IDENTITY),
            })
        })
        .collect();
    items.sort_by_key(|i| (ORDER.iter().position(|c| *c == i.category), i.prst.clone()));
    items
}

#[cfg(test)]
mod tests {
    use super::*;

    fn label(data: Value) -> String {
        json!({ "v": 1, "data": data }).to_string()
    }

    /// A polygon element drawing `prst` for a `w` × `h` box, its anchors
    /// mapped by `local` (a host's resize) and placed by `t`.
    #[allow(clippy::too_many_arguments)]
    fn poly(
        id: &str,
        prst: &str,
        adj: &[(&str, &str)],
        w: f64,
        h: f64,
        local: [f64; 4],
        t: Affine,
        extra: Value,
    ) -> Element {
        let adj: Vec<(String, String)> = adj
            .iter()
            .map(|(a, b)| (a.to_string(), b.to_string()))
            .collect();
        let o = slide_geom::preset(prst, &adj, w, h).unwrap();
        let filled = part_of(&o.subpaths, Part::Fill);
        let sub = if filled.is_empty() {
            o.subpaths
        } else {
            filled
        };
        let (a, s, _) = flatten(&sub);
        let [sx, ox, sy, oy] = local;
        let mut data = json!({ "shape": "ppt/slides/slide1.xml#2", "preset": { "prst": prst, "adj": adj }, "box": [w, h] });
        if let (Some(d), Some(e)) = (data.as_object_mut(), extra.as_object()) {
            for (k, v) in e {
                d.insert(k.clone(), v.clone());
            }
        }
        Element {
            id: id.into(),
            kind: "polygon".into(),
            label: label(data),
            anchors: a
                .iter()
                .map(|p| p.map(|(x, y)| [x * sx + ox, y * sy + oy]))
                .collect(),
            starts: s,
            transform: t,
            bounds: None,
        }
    }

    fn apply_writes(els: &mut [Element], writes: &[Write]) {
        for w in writes {
            let e = els.iter_mut().find(|e| e.id == w.id).unwrap();
            if let Some(a) = &w.anchors {
                e.anchors = a.clone();
            }
            if let Some(s) = &w.starts {
                e.starts = s.clone();
            }
            if let Some(t) = w.transform {
                e.transform = t;
            }
            if let Some(b) = w.bounds {
                e.bounds = Some(b);
            }
            if let Some(l) = &w.label {
                e.label = l.clone();
            }
        }
    }

    #[test]
    fn a_resized_rounded_rectangle_is_drawn_again_and_then_left_alone() {
        let mut els = vec![poly(
            "u1",
            "roundRect",
            &[("adj", "val 30000")],
            180.0,
            108.0,
            [2.0, 0.0, 0.5, 0.0],
            [1.0, 0.0, 0.0, 1.0, 72.0, 57.6],
            json!({}),
        )];
        let w = follow(&els);
        assert_eq!(w.len(), 1);
        let l = Label::parse(w[0].label.as_deref().unwrap()).unwrap();
        assert_eq!(l.size(), Some((360.0, 54.0)));
        // The radius is 30 % of the new short side (54), not a scaled one.
        let a = w[0].anchors.as_ref().unwrap();
        let min_x = a
            .iter()
            .map(|p| p[0][0])
            .filter(|x| *x > 1e-6)
            .fold(f64::MAX, f64::min);
        assert!((min_x - 16.2).abs() < 0.01, "{min_x}");
        apply_writes(&mut els, &w);
        assert!(follow(&els).is_empty());
    }

    #[test]
    fn a_box_resized_without_its_anchors_is_followed() {
        // The engine's resize of one path writes its bounds alone.
        let mut e = poly(
            "u1",
            "roundRect",
            &[],
            200.0,
            100.0,
            [1.0, 0.0, 1.0, 0.0],
            [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
            json!({}),
        );
        e.bounds = Some([0.0, 0.0, 50.0, 400.0]);
        let w = follow(std::slice::from_ref(&e));
        assert_eq!(w.len(), 1);
        let l = Label::parse(w[0].label.as_deref().unwrap()).unwrap();
        assert_eq!(l.size(), Some((400.0, 50.0)));
        assert_eq!(w[0].bounds, Some([0.0, 0.0, 50.0, 400.0]));
    }

    #[test]
    fn the_text_frame_and_detail_follow_their_outline() {
        let t = [1.0, 0.0, 0.0, 1.0, 10.0, 10.0];
        let mut text = poly(
            "u1t",
            "can",
            &[],
            80.0,
            120.0,
            [1.0, 0.0, 1.0, 0.0],
            t,
            json!({}),
        );
        text.kind = "textFrame".into();
        text.anchors.clear();
        text.bounds = Some([30.0, 0.0, 120.0, 80.0]);
        let mut detail = poly(
            "u1s",
            "can",
            &[],
            80.0,
            120.0,
            [1.0, 0.0, 1.0, 0.0],
            t,
            json!({}),
        );
        let o = slide_geom::preset("can", &[], 80.0, 120.0).unwrap();
        let (a, s, _) = flatten(&part_of(&o.subpaths, Part::Detail));
        detail.anchors = a.iter().map(|p| p.map(|(x, y)| [x, y])).collect();
        detail.starts = s;
        let outline = poly(
            "u1p",
            "can",
            &[],
            80.0,
            120.0,
            [2.0, 0.0, 1.0, 0.0],
            t,
            json!({}),
        );
        let w = follow(&[outline, detail, text]);
        assert_eq!(w.len(), 3, "{w:?}");
        let tw = w.iter().find(|x| x.id == "u1t").unwrap();
        assert_eq!(tw.bounds, Some([30.0, 0.0, 120.0, 160.0]));
        let dw = w.iter().find(|x| x.id == "u1s").unwrap();
        let max_x = dw
            .anchors
            .as_ref()
            .unwrap()
            .iter()
            .map(|p| p[0][0])
            .fold(0.0, f64::max);
        assert!((max_x - 160.0).abs() < 0.01, "{max_x}");
    }

    #[test]
    fn a_moved_shape_takes_its_glued_connector_along() {
        // Box A (rect, id 6) and Box B (rect, id 7), a straight connector
        // from A's right side (site 3) to B's left side (site 1).
        let key = |id: u32| format!("ppt/slides/slide1.xml#{id}");
        let a_t = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];
        let b_t = [1.0, 0.0, 0.0, 1.0, 300.0, 100.0];
        let mut a = poly(
            "ua",
            "rect",
            &[],
            100.0,
            50.0,
            [1.0, 0.0, 1.0, 0.0],
            a_t,
            json!({}),
        );
        a.label = label(
            json!({ "shape": key(6), "preset": { "prst": "rect", "adj": [] }, "box": [100.0, 50.0] }),
        );
        let mut b = poly(
            "ub",
            "rect",
            &[],
            100.0,
            50.0,
            [1.0, 0.0, 1.0, 0.0],
            b_t,
            json!({}),
        );
        b.label = label(
            json!({ "shape": key(7), "preset": { "prst": "rect", "adj": [] }, "box": [100.0, 50.0] }),
        );
        // The connector from (100, 25) to (300, 125).
        let c_label = json!({
            "shape": key(8),
            "preset": { "prst": "straightConnector1", "adj": [] },
            "box": [200.0, 100.0],
            "connector": { "st": { "id": 6, "idx": 3, "at": [100.0, 25.0] }, "end": { "id": 7, "idx": 1, "at": [300.0, 125.0] } }
        });
        let mut c = poly(
            "uc",
            "straightConnector1",
            &[],
            200.0,
            100.0,
            [1.0, 0.0, 1.0, 0.0],
            [1.0, 0.0, 0.0, 1.0, 100.0, 25.0],
            json!({}),
        );
        c.label = label(c_label);
        let mut els = vec![a, b, c];
        // Nothing moved: nothing to do.
        assert!(follow(&els).is_empty());
        // B moves up by 200: the connector now runs up from A.
        els[1].transform = [1.0, 0.0, 0.0, 1.0, 300.0, -100.0];
        let w = follow(&els);
        assert_eq!(w.len(), 1, "{w:?}");
        let cw = &w[0];
        assert_eq!(cw.id, "uc");
        let t = cw.transform.unwrap();
        let anchors = cw.anchors.as_ref().unwrap();
        let p0 = apply(&t, (anchors[0][0][0], anchors[0][0][1]));
        let p1 = apply(
            &t,
            (anchors.last().unwrap()[0][0], anchors.last().unwrap()[0][1]),
        );
        assert!(
            (p0.0 - 100.0).abs() < 1e-6 && (p0.1 - 25.0).abs() < 1e-6,
            "{p0:?}"
        );
        assert!(
            (p1.0 - 300.0).abs() < 1e-6 && (p1.1 + 75.0).abs() < 1e-6,
            "{p1:?}"
        );
        let l = Label::parse(cw.label.as_deref().unwrap()).unwrap();
        assert_eq!(l.end("end").unwrap().2, Some((300.0, -75.0)));
        // A flipped box, as PowerPoint writes it: flipV.
        assert!(t[3] < 0.0);
        apply_writes(&mut els, &w);
        assert!(follow(&els).is_empty());
    }

    #[test]
    fn handles_are_on_the_page_and_a_drag_sets_the_adjust_value() {
        let t = [1.0, 0.0, 0.0, 1.0, 100.0, 50.0];
        let e = poly(
            "u1",
            "roundRect",
            &[],
            200.0,
            100.0,
            [1.0, 0.0, 1.0, 0.0],
            t,
            json!({}),
        );
        let hs = handles(&e);
        assert_eq!(hs.len(), 1);
        // Default adj 16 667 of the short side (100), at the top edge.
        assert!(
            (hs[0].pos[0] - 116.667).abs() < 0.01 && (hs[0].pos[1] - 50.0).abs() < 1e-9,
            "{:?}",
            hs[0]
        );
        let w = adjust(std::slice::from_ref(&e), "u1", 0, [140.0, 50.0]);
        assert_eq!(w.len(), 1);
        let l = Label::parse(w[0].label.as_deref().unwrap()).unwrap();
        assert_eq!(
            l.preset().unwrap().1,
            vec![("adj".to_string(), "val 40000".to_string())]
        );
        assert!(w[0].path.as_deref().unwrap().starts_with('M'));
        // A reshaped element has no handles.
        let mut bent = e.clone();
        bent.anchors[1][0][1] += 9.0;
        assert!(handles(&bent).is_empty());
    }

    #[test]
    fn a_new_shape_is_a_paste_snippet_of_live_presets() {
        let s = new_shape("can", 120.0, 80.0, "new:7").unwrap();
        assert_eq!(s.elements, 2);
        let v: Value = serde_json::from_str(&s.snippet).unwrap();
        assert_eq!(v["format"], "paged.snippet/1");
        let polys = v["spread"]["polygons"].as_array().unwrap();
        assert_eq!(polys.len(), 2);
        let labels = v["spread"]["labels"].as_object().unwrap();
        let l1 = Label::parse(labels["s1"][0][1].as_str().unwrap()).unwrap();
        assert_eq!(l1.size(), Some((120.0, 80.0)));
        assert_eq!(l1.shape(), Some("new:7"));
        let l2 = Label::parse(labels["s2"][0][1].as_str().unwrap()).unwrap();
        assert_eq!(l2.data["part"], "detail");
        // Every preset can be inserted.
        for n in slide_geom::preset_names() {
            assert!(new_shape(n, 100.0, 60.0, "new:1").is_some(), "{n}");
        }
    }

    #[test]
    fn the_gallery_holds_every_preset_once() {
        let g = gallery();
        assert_eq!(g.len(), 187);
        assert_eq!(g[0].category, "lines");
        assert!(g
            .iter()
            .any(|i| i.prst == "roundRect" && i.category == "rectangles"));
        assert!(g
            .iter()
            .any(|i| i.prst == "flowChartProcess" && i.category == "flowchart"));
        assert_eq!(display_name("roundRect"), "Round Rect");
        assert_eq!(display_name("star24"), "Star 24");
    }
}
