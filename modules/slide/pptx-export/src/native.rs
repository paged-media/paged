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

//! The native read model (ADR 704, ADR 711): the document as the editor
//! holds it (its `.paged` serialization), read back into the engine's
//! model, and each page's items gathered into the shapes of the slide they
//! came from.
//!
//! The importer labels every element of a slide's shape with the shape's
//! key (`cNvPr` ids from the slide's tree down, `bg` for the background)
//! and what export needs to write it back (placeholder, preset, click
//! action). A duplicated slide carries the same labels, so its items are
//! still the shapes of its source slide; an item without a key was made in
//! the editor.

use std::collections::{BTreeMap, HashMap};

use paged_model::{FrameRef, Group, Paragraph, Spread};
use paged_scene::Document;
use serde_json::Value;

/// The plugin-metadata key slide labels live under.
pub const LABEL_KEY: &str = "x-paged:media.paged.slide";

/// The model part of a `.paged` container.
const MODEL_PART: &str = "paged/core/model/document.pgm";

/// Read a `.paged` container's native document.
pub fn read(paged: &[u8]) -> Result<Document, String> {
    let entries = paged_ooxml::opc::read_zip(paged, 2 << 30).map_err(|e| e.to_string())?;
    let mut model = None;
    let mut blobs = HashMap::new();
    for e in entries {
        if let paged_ooxml::opc::ZipEntry::File { name, bytes } = e {
            if name == MODEL_PART {
                model = Some(bytes);
            } else if let Some(b) = paged_store::blob_name_of(&name) {
                blobs.insert(b.to_string(), bytes);
            }
        }
    }
    let model = model.ok_or("the document has no native model part")?;
    paged_store::from_parts(&model, blobs)
        .ok_or_else(|| "the native model part does not read".into())
}

/// A shape's click action as the importer labelled it.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Link {
    pub url: Option<String>,
    /// The slide part it jumps to.
    pub slide: Option<String>,
    pub action: Option<String>,
    pub tooltip: Option<String>,
}

/// What an element's label says.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Label {
    pub shape: Option<String>,
    pub placeholder: Option<(String, Option<u32>)>,
    pub preset: Option<(String, Vec<(String, String)>)>,
    pub link: Option<Link>,
    pub frame: Option<String>,
    /// The chart part a chart frame draws (ADR 715).
    pub chart: Option<String>,
}

fn s(v: &Value, k: &str) -> Option<String> {
    v.get(k).and_then(Value::as_str).map(str::to_string)
}

/// Parse a label's JSON envelope.
pub fn parse_label(json: &str) -> Label {
    let Ok(v) = serde_json::from_str::<Value>(json) else {
        return Label::default();
    };
    let d = v.get("data").cloned().unwrap_or(Value::Null);
    Label {
        shape: s(&d, "shape"),
        placeholder: d.get("placeholder").and_then(|p| {
            Some((
                s(p, "type")?,
                p.get("idx").and_then(Value::as_u64).map(|i| i as u32),
            ))
        }),
        preset: d.get("preset").and_then(|p| {
            let prst = s(p, "prst")?;
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
        }),
        link: d.get("link").map(|l| Link {
            url: s(l, "url"),
            slide: s(l, "slide"),
            action: s(l, "action"),
            tooltip: s(l, "tooltip"),
        }),
        frame: s(&d, "frame"),
        chart: s(&d, "chart"),
    }
}

/// The label of an element on a spread.
pub fn label_of(spread: &Spread, id: &str) -> Label {
    spread
        .labels
        .get(id)
        .and_then(|e| e.iter().find(|(k, _)| k == LABEL_KEY))
        .map(|(_, v)| parse_label(v))
        .unwrap_or_default()
}

/// The page's own slide state (`x-paged:media.paged.slide` on the page).
pub fn page_state(spread: &Spread, page_id: &str) -> Value {
    spread
        .labels
        .get(page_id)
        .and_then(|e| e.iter().find(|(k, _)| k == LABEL_KEY))
        .and_then(|(_, v)| serde_json::from_str::<Value>(v).ok())
        .and_then(|v| v.get("data").cloned())
        .unwrap_or(Value::Null)
}

/// The kind of a page element.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Polygon,
    Rectangle,
    Oval,
    Line,
    TextFrame,
}

/// One page element, as its model value (fields by name).
#[derive(Debug, Clone)]
pub struct Elem {
    pub kind: Kind,
    pub id: String,
    pub v: Value,
}

impl Elem {
    pub fn f(&self, k: &str) -> Option<f64> {
        self.v.get(k).and_then(Value::as_f64)
    }
    pub fn s(&self, k: &str) -> Option<String> {
        s(&self.v, k)
    }
    /// `item_transform`, identity when absent.
    pub fn transform(&self) -> [f64; 6] {
        arr6(self.v.get("item_transform")).unwrap_or([1.0, 0.0, 0.0, 1.0, 0.0, 0.0])
    }
    /// The element's local outline: its anchors, or its bounds' corners.
    pub fn anchors(&self) -> Vec<[(f64, f64); 3]> {
        let pts: Vec<[(f64, f64); 3]> = self
            .v
            .get("anchors")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|p| {
                        Some([
                            pt(p.get("anchor")?)?,
                            pt(p.get("left")?)?,
                            pt(p.get("right")?)?,
                        ])
                    })
                    .collect()
            })
            .unwrap_or_default();
        if !pts.is_empty() {
            return pts;
        }
        let (l, t, r, b) = self.bounds();
        [(l, t), (l, b), (r, b), (r, t)]
            .into_iter()
            .map(|p| [p, p, p])
            .collect()
    }
    /// Where each contour after the first starts, and which are open.
    pub fn contours(&self) -> (Vec<usize>, Vec<bool>) {
        let starts = self
            .v
            .get("subpath_starts")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_u64().map(|u| u as usize))
                    .collect()
            })
            .unwrap_or_default();
        let open = self
            .v
            .get("subpath_open")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(Value::as_bool).collect())
            .unwrap_or_default();
        (starts, open)
    }
    /// `bounds` as (l, t, r, b).
    pub fn bounds(&self) -> (f64, f64, f64, f64) {
        let b = self.v.get("bounds");
        let g = |k| {
            b.and_then(|b| b.get(k))
                .and_then(Value::as_f64)
                .unwrap_or(0.0)
        };
        (g("left"), g("top"), g("right"), g("bottom"))
    }
    pub fn story(&self) -> Option<String> {
        self.s("parent_story")
    }
}

fn pt(v: &Value) -> Option<(f64, f64)> {
    let a = v.as_array()?;
    Some((a.first()?.as_f64()?, a.get(1)?.as_f64()?))
}

pub fn arr6(v: Option<&Value>) -> Option<[f64; 6]> {
    let a = v?.as_array()?;
    if a.len() != 6 {
        return None;
    }
    let mut out = [0.0; 6];
    for (o, x) in out.iter_mut().zip(a) {
        *o = x.as_f64()?;
    }
    Some(out)
}

/// A shape of a page: the elements one slide shape became (an outline,
/// its stroke-only details, its text frame), or a group of shapes.
#[derive(Debug, Clone)]
pub struct NShape {
    pub key: Option<String>,
    pub label: Label,
    pub name: Option<String>,
    pub elems: Vec<Elem>,
    /// A group: its own model value and its member shapes.
    pub group: Option<(String, Value)>,
    pub children: Vec<NShape>,
}

impl NShape {
    /// The element that places the shape: its outline, else its picture
    /// frame, else its text frame.
    pub fn primary(&self) -> Option<&Elem> {
        self.elems
            .iter()
            .find(|e| e.kind != Kind::TextFrame)
            .or_else(|| self.elems.first())
    }
    pub fn text_frame(&self) -> Option<&Elem> {
        self.elems.iter().find(|e| e.kind == Kind::TextFrame)
    }
    /// The group's `item_transform`, identity for a shape or when absent.
    pub fn group_transform(&self) -> [f64; 6] {
        self.group
            .as_ref()
            .and_then(|(_, v)| arr6(v.get("item_transform")))
            .unwrap_or([1.0, 0.0, 0.0, 1.0, 0.0, 0.0])
    }
}

fn elem(spread: &Spread, r: &FrameRef) -> Option<Elem> {
    let (kind, v) = match *r {
        FrameRef::Polygon(i) => (
            Kind::Polygon,
            serde_json::to_value(spread.polygons.get(i)?).ok()?,
        ),
        FrameRef::Rectangle(i) => (
            Kind::Rectangle,
            serde_json::to_value(spread.rectangles.get(i)?).ok()?,
        ),
        FrameRef::Oval(i) => (Kind::Oval, serde_json::to_value(spread.ovals.get(i)?).ok()?),
        FrameRef::GraphicLine(i) => (
            Kind::Line,
            serde_json::to_value(spread.graphic_lines.get(i)?).ok()?,
        ),
        FrameRef::TextFrame(i) => (
            Kind::TextFrame,
            serde_json::to_value(spread.text_frames.get(i)?).ok()?,
        ),
        FrameRef::Group(_) => return None,
    };
    let id = s(&v, "self_id").unwrap_or_default();
    Some(Elem { kind, id, v })
}

/// The shapes of a list of frame references, bottom to top.
fn shapes_of(spread: &Spread, refs: &[FrameRef]) -> Vec<NShape> {
    let mut out: Vec<NShape> = Vec::new();
    for r in refs {
        if let FrameRef::Group(i) = *r {
            let Some(g) = spread.groups.get(i) else {
                continue;
            };
            out.push(group_shape(spread, g));
            continue;
        }
        let Some(e) = elem(spread, r) else { continue };
        let label = label_of(spread, &e.id);
        let name = spread.item_names.get(&e.id).cloned();
        // The elements of one slide shape are consecutive and share its key.
        if let Some(last) = out.last_mut() {
            if last.group.is_none() && label.shape.is_some() && last.key == label.shape {
                last.elems.push(e);
                continue;
            }
        }
        out.push(NShape {
            key: label.shape.clone(),
            label,
            name,
            elems: vec![e],
            group: None,
            children: Vec::new(),
        });
    }
    out
}

fn group_shape(spread: &Spread, g: &Group) -> NShape {
    let id = g.self_id.clone().unwrap_or_default();
    let label = label_of(spread, &id);
    NShape {
        key: label.shape.clone(),
        name: spread.item_names.get(&id).cloned(),
        label,
        elems: Vec::new(),
        group: Some((id, serde_json::to_value(g).unwrap_or(Value::Null))),
        children: shapes_of(spread, &g.members),
    }
}

/// A page's shapes, bottom to top.
pub fn page_shapes(spread: &Spread) -> Vec<NShape> {
    shapes_of(spread, &spread.frames_in_order)
}

/// Every keyed shape of a tree, by key, with its parent group's key.
pub fn by_key(shapes: &[NShape]) -> BTreeMap<String, &NShape> {
    fn walk<'a>(shapes: &'a [NShape], out: &mut BTreeMap<String, &'a NShape>) {
        for s in shapes {
            if let Some(k) = &s.key {
                out.entry(k.clone()).or_insert(s);
            }
            if s.label.frame.is_none() {
                walk(&s.children, out);
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(shapes, &mut out);
    out
}

/// A story's paragraphs by id.
pub fn story<'a>(doc: &'a Document, id: &str) -> Option<&'a [Paragraph]> {
    doc.stories
        .iter()
        .find(|s| s.self_id == id)
        .map(|s| s.story.paragraphs.as_slice())
}

/// The spread holding page `page_id`.
pub fn spread_of<'a>(doc: &'a Document, page_id: &str) -> Option<&'a Spread> {
    doc.spreads.iter().map(|s| &s.spread).find(|s| {
        s.pages
            .iter()
            .any(|p| p.self_id.as_deref() == Some(page_id))
    })
}

/// A swatch's colour as sRGB bytes (`None` for the None swatch, a
/// gradient or an unknown id). CMYK and Lab are converted naively.
pub fn swatch_rgb(doc: &Document, id: &str) -> Option<[u8; 3]> {
    let c = doc.palette.colors.get(id)?;
    let v = &c.value;
    let rgb = match c.space {
        paged_model::ColorSpace::Rgb if v.len() >= 3 => [v[0], v[1], v[2]],
        paged_model::ColorSpace::Cmyk if v.len() >= 4 => {
            let k = 1.0 - v[3] / 100.0;
            [
                255.0 * (1.0 - v[0] / 100.0) * k,
                255.0 * (1.0 - v[1] / 100.0) * k,
                255.0 * (1.0 - v[2] / 100.0) * k,
            ]
        }
        _ => return None,
    };
    let tint = c.tint.unwrap_or(100.0) / 100.0;
    let mix = |x: f32| (255.0 - (255.0 - x) * tint).round().clamp(0.0, 255.0) as u8;
    Some([mix(rgb[0]), mix(rgb[1]), mix(rgb[2])])
}
