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

//! One slide written back from the native document (ADR 704, ADR 711).
//!
//! The slide's shape tree is walked in the document's order. A shape whose
//! items are what import made of it keeps its original XML, byte for byte;
//! an edited one is its original XML with only the edited parts rewritten
//! (placement, outline, fill, line, text, a picture's crop or image, a
//! table's cells); a shape made in the editor is written whole. Shapes the
//! document never drew (hidden ones, OLE objects, content parts) keep their
//! place. What cannot be written is reported, never silently dropped.

use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};

use paged_model::Spread;
use paged_ooxml::rels::{part_dir, Relationship, Relationships};
use paged_scene::Document;
use pptx_core::{Presentation, Shape, Xfrm, EMU_PER_PT};
use serde_json::Value;
use slide_resolve::model::{Item, ItemKind};

use crate::geom::{self, Affine, Placed, Space, IDENTITY};
use crate::native::{self, Elem, Kind, NShape};
use crate::probe::{self, Defaults, Probed};
use crate::text::{self, Colors, Reuse, TextCtx};
use crate::xml::{self, esc, El};

pub const REL_HYPERLINK: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink";
pub const REL_IMAGE: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image";
pub const REL_SLIDE: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide";
pub const REL_LAYOUT: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout";

/// The default text box of the probe slide (new text frames' defaults).
const TEXT_BOX_PROBE: u32 = 0x7fff_0000;

/// A slide's relationships while it is written.
#[derive(Debug, Clone, Default)]
pub struct Rels {
    pub rels: Relationships,
    /// The slide part's folder (targets are relative to it).
    pub dir: String,
    pub changed: bool,
}

impl Rels {
    /// The id of a relationship of `ty` to `target`, added when absent.
    pub fn add(&mut self, ty: &str, target: &str, external: bool) -> String {
        let mode = external.then(|| "External".to_string());
        if let Some(r) = self
            .rels
            .items
            .iter()
            .find(|r| r.rel_type == ty && r.target == target && r.target_mode == mode)
        {
            return r.id.clone();
        }
        let id = (1..)
            .map(|n| format!("rId{n}"))
            .find(|id| self.rels.by_id(id).is_none())
            .expect("an unused id");
        self.rels.items.push(Relationship {
            id: id.clone(),
            rel_type: ty.to_string(),
            target: target.to_string(),
            target_mode: mode,
        });
        self.changed = true;
        id
    }
}

/// The target of package part `to` relative to the folder `from_dir`.
pub fn relative(from_dir: &str, to: &str) -> String {
    let from: Vec<&str> = from_dir.split('/').filter(|s| !s.is_empty()).collect();
    let to_parts: Vec<&str> = to.split('/').collect();
    let common = from
        .iter()
        .zip(to_parts.iter())
        .take_while(|(a, b)| a == b)
        .count();
    let mut out: Vec<&str> = vec![".."; from.len() - common];
    out.extend(&to_parts[common..]);
    out.join("/")
}

/// What every slide of one export shares.
pub struct Shared<'a> {
    pub ir: &'a Presentation,
    pub cur: &'a Document,
    pub theme: &'a [(String, [u8; 3])],
    /// The written part of each page of the document, by page id.
    pub page_part: BTreeMap<String, String>,
    /// The written part of each slide of the original deck (its first
    /// copy), by source part.
    pub source_part: BTreeMap<String, String>,
    /// Image parts already written, by content hash, and the next number.
    pub media: RefCell<(BTreeMap<u64, String>, u32)>,
    /// The chart parts whose data the document changed (ADR 715): their
    /// frames are redrawn, and the chart part is written from the workbook.
    pub live_charts: std::collections::BTreeSet<String>,
}

/// One slide to write.
pub struct Job<'a> {
    /// The part it is written to.
    pub part: String,
    pub slide_no: usize,
    /// The slide part's XML to start from (the original slide, or a
    /// generated one holding the new slide's placeholders).
    pub xml: String,
    /// Its shapes as import read them, and as the resolver placed them.
    pub shapes: &'a [Shape],
    pub items: &'a [Item],
    /// The key prefix of its shapes (`<part>#`).
    pub prefix: String,
    /// What import made of it, and the document it is in.
    pub base: Option<&'a Spread>,
    pub base_doc: &'a Document,
    /// The page as the document holds it now.
    pub cur: Vec<NShape>,
    pub layout: Option<String>,
}

/// A written slide.
pub struct Out {
    pub xml: String,
    /// New image parts: (part, bytes).
    pub media: Vec<(String, Vec<u8>)>,
    pub lost: Vec<String>,
}

/// An original shape of the slide.
#[derive(Clone)]
struct Orig<'a> {
    el: El,
    key: Option<String>,
    shape: Option<&'a Shape>,
    item: Option<&'a Item>,
    parent: Option<String>,
}

fn nv(s: &Shape) -> Option<&pptx_core::NvProps> {
    match s {
        Shape::Sp(sp) | Shape::Connector(sp) => Some(&sp.nv),
        Shape::Pic(p) => Some(&p.nv),
        Shape::Group(g) => Some(&g.nv),
        Shape::Frame(f) => Some(&f.nv),
        Shape::Unknown { .. } => None,
    }
}

/// The `cNvPr id` of a shape element.
fn el_id(xml: &str, el: &El) -> Option<u32> {
    let nvpr = el
        .children(xml)
        .into_iter()
        .find(|c| c.name.starts_with("p:nv"))?;
    nvpr.child(xml, "p:cNvPr")?.attr(xml, "id")?.parse().ok()
}

/// The shape elements of a tree level (the content of `p:spTree` or a
/// `p:grpSp`, less its own properties).
fn level_els(xml: &str, parent: &El) -> Vec<El> {
    parent
        .children(xml)
        .into_iter()
        .filter(|c| !matches!(c.name.as_str(), "p:nvGrpSpPr" | "p:grpSpPr"))
        .collect()
}

/// Shapes by key: IR shapes and resolved items, as slide-native keys them.
fn index_ir<'a>(
    prefix: &str,
    shapes: &'a [Shape],
    out: &mut BTreeMap<String, &'a Shape>,
    path: &str,
) {
    for s in shapes {
        let Some(n) = nv(s) else { continue };
        let k = if path.is_empty() {
            n.id.to_string()
        } else {
            format!("{path}/{}", n.id)
        };
        out.entry(format!("{prefix}{k}")).or_insert(s);
        if let Shape::Group(g) = s {
            index_ir(prefix, &g.children, out, &k);
        }
    }
}

fn index_items<'a>(
    prefix: &str,
    items: &'a [Item],
    out: &mut BTreeMap<String, &'a Item>,
    path: Option<&str>,
) {
    for it in items {
        let k = match path {
            None => slide_native::slide_key(it),
            Some(p) => format!("{p}/{}", it.meta.shape_id),
        };
        if let ItemKind::Group { children } = &it.kind {
            if it.meta.frame.is_none() {
                index_items(prefix, children, out, Some(&k));
            }
        }
        out.entry(format!("{prefix}{k}")).or_insert(it);
    }
}

/// A shape's signature: its items' model values without ids, with their
/// stories' text. Two shapes with the same signature draw the same.
fn sig(s: &NShape, doc: &Document) -> String {
    fn strip(v: &Value) -> Value {
        let mut v = v.clone();
        if let Some(m) = v.as_object_mut() {
            for k in [
                "self_id",
                "parent_story",
                "next_text_frame",
                "previous_text_frame",
                "members",
            ] {
                m.remove(k);
            }
            if let Some(b) = m.remove("image_bytes") {
                m.insert("image_hash".into(), hash(&b.to_string()).into());
            }
        }
        v
    }
    let mut parts: Vec<Value> = Vec::new();
    if let Some((_, g)) = &s.group {
        parts.push(strip(g));
        for c in &s.children {
            parts.push(Value::String(sig(c, doc)));
        }
    }
    for e in &s.elems {
        parts.push(strip(&e.v));
        if let Some(st) = e.story() {
            parts.push(serde_json::to_value(native::story(doc, &st)).unwrap_or(Value::Null));
        }
    }
    Value::Array(parts).to_string()
}

fn hash(s: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    s.hash(&mut h);
    h.finish()
}

fn hash_bytes(b: &[u8]) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    b.hash(&mut h);
    h.finish()
}

/// Keys of two model values whose values differ.
fn changed_keys(a: &Value, b: &Value) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    let (Some(a), Some(b)) = (a.as_object(), b.as_object()) else {
        return out;
    };
    for k in a.keys().chain(b.keys()) {
        if a.get(k) != b.get(k) {
            out.insert(k.clone());
        }
    }
    out
}

const PLACE: &[&str] = &[
    "item_transform",
    "bounds",
    "anchors",
    "subpath_starts",
    "subpath_open",
];
const FILL: &[&str] = &[
    "fill_color",
    "fill_tint",
    "gradient_fill_angle",
    "gradient_fill_length",
    "gradient_fill_start",
];
const LINE: &[&str] = &[
    "stroke_color",
    "stroke_weight",
    "stroke_type",
    "stroke_tint",
    "end_cap",
    "end_join",
    "start_arrow",
    "end_arrow",
    "stroke_dash",
    "miter_limit",
    "stroke_dash",
];
const FRAME: &[&str] = &[
    "inset_spacing",
    "vertical_justification",
    "auto_sizing",
    "auto_sizing_reference_point",
    "first_baseline_offset",
    "minimum_first_baseline_offset",
];
/// The item's drop shadow and effects: written back as `a:effectLst`.
const EFFECTS: &[&str] = &["drop_shadow", "effects"];
/// What `spPr` holds before an effect list.
const BEFORE_EFFECTS: &[&str] = &[
    "a:xfrm",
    "a:prstGeom",
    "a:custGeom",
    "a:noFill",
    "a:solidFill",
    "a:gradFill",
    "a:blipFill",
    "a:pattFill",
    "a:grpFill",
    "a:ln",
];
const IMAGE: &[&str] = &["image_item_transform", "image_bytes", "image_link"];
const IGNORE: &[&str] = &[
    "self_id",
    "parent_story",
    "next_text_frame",
    "previous_text_frame",
    "opacity",
];

/// The local box of an element's outline (l, t, r, b).
fn bbox(e: &Elem) -> (f64, f64, f64, f64) {
    let mut b = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
    for p in e.anchors() {
        let (x, y) = p[0];
        b = (b.0.min(x), b.1.min(y), b.2.max(x), b.3.max(y));
    }
    b
}

/// The map taking box `a` onto box `b`.
fn box_map(a: (f64, f64, f64, f64), b: (f64, f64, f64, f64)) -> Affine {
    let sx = if (a.2 - a.0).abs() > 1e-6 {
        (b.2 - b.0) / (a.2 - a.0)
    } else {
        1.0
    };
    let sy = if (a.3 - a.1).abs() > 1e-6 {
        (b.3 - b.1) / (a.3 - a.1)
    } else {
        1.0
    };
    [sx, 0.0, 0.0, sy, b.0 - a.0 * sx, b.1 - a.1 * sy]
}

fn emu(v: f64) -> i64 {
    (v * EMU_PER_PT).round() as i64
}

/// Where each placement-relevant transform of a level comes from.
#[derive(Clone, Copy)]
struct Ctx {
    /// The space shapes of this level are written in.
    space: Space,
    /// The document's transforms of the enclosing groups, now and at import.
    fx_cur: Affine,
    fx_base: Affine,
}

/// The writer of one slide.
struct Writer<'a, 'j> {
    sh: &'a Shared<'a>,
    job: &'j Job<'a>,
    rels: RefCell<&'j mut Rels>,
    lost: RefCell<Vec<String>>,
    media: RefCell<Vec<(String, Vec<u8>)>>,
    orig: BTreeMap<String, Orig<'a>>,
    base_by_key: BTreeMap<String, NShape>,
    probed: Probed,
    probe_of: BTreeMap<String, u32>,
    colors: Colors<'a>,
    lang: String,
    seen: RefCell<BTreeSet<String>>,
    next_id: RefCell<u32>,
}

/// Write `job`. `None` when the page is the slide as import made it.
pub fn write<'a>(
    sh: &'a Shared<'a>,
    job: &Job<'a>,
    rels: &mut Rels,
) -> Result<Option<Out>, String> {
    let xml = job.xml.as_str();
    let root = xml::root(xml).ok_or("the slide part does not read")?;
    let tree = root
        .path(xml, &["p:cSld", "p:spTree"])
        .ok_or("the slide has no shape tree")?;

    let base_shapes = job.base.map(native::page_shapes).unwrap_or_default();
    // Unchanged: the same shapes, in the same order, each the same.
    if base_shapes.len() == job.cur.len()
        && base_shapes
            .iter()
            .zip(&job.cur)
            .all(|(b, c)| b.key == c.key && sig(b, job.base_doc) == sig(c, sh.cur))
    {
        return Ok(None);
    }

    let mut ir_by_key = BTreeMap::new();
    index_ir(&job.prefix, job.shapes, &mut ir_by_key, "");
    let mut item_by_key = BTreeMap::new();
    index_items(&job.prefix, job.items, &mut item_by_key, None);
    let mut orig = BTreeMap::new();
    #[allow(clippy::too_many_arguments)]
    fn walk<'a>(
        xml: &str,
        parent: &El,
        path: &str,
        parent_key: Option<String>,
        prefix: &str,
        ir: &BTreeMap<String, &'a Shape>,
        items: &BTreeMap<String, &'a Item>,
        out: &mut BTreeMap<String, Orig<'a>>,
    ) {
        for el in level_els(xml, parent) {
            let Some(id) = el_id(xml, &el) else { continue };
            let p = if path.is_empty() {
                id.to_string()
            } else {
                format!("{path}/{id}")
            };
            let key = format!("{prefix}{p}");
            if el.name == "p:grpSp" {
                walk(xml, &el, &p, Some(key.clone()), prefix, ir, items, out);
            }
            out.entry(key.clone()).or_insert(Orig {
                el,
                key: Some(key.clone()),
                shape: ir.get(&key).copied(),
                item: items.get(&key).copied(),
                parent: parent_key.clone(),
            });
        }
    }
    walk(
        xml,
        &tree,
        "",
        None,
        &job.prefix,
        &ir_by_key,
        &item_by_key,
        &mut orig,
    );

    let mut base_by_key = BTreeMap::new();
    fn keyed(shapes: &[NShape], out: &mut BTreeMap<String, NShape>) {
        for s in shapes {
            if let Some(k) = &s.key {
                out.entry(k.clone()).or_insert_with(|| s.clone());
            }
            if s.label.frame.is_none() {
                keyed(&s.children, out);
            }
        }
    }
    keyed(&base_shapes, &mut base_by_key);

    // Text defaults: every original shape with text or a table, and a
    // default text box, on a probe slide of the slide's layout.
    let mut probes = Vec::new();
    let mut probe_of = BTreeMap::new();
    for (id, (k, s)) in (1u32..).zip(ir_by_key.iter()) {
        let mut p = probe::probe_shape(s);
        match &mut p {
            Shape::Sp(sp) | Shape::Connector(sp) => sp.nv.id = id,
            Shape::Frame(f) => f.nv.id = id,
            _ => continue,
        }
        probe_of.insert(k.clone(), id);
        probes.push(p);
    }
    probes.push(Shape::Sp(pptx_core::Sp {
        nv: pptx_core::NvProps {
            id: TEXT_BOX_PROBE,
            name: "TextBox".into(),
            ..Default::default()
        },
        props: pptx_core::ShapeProps {
            xfrm: Some(Xfrm {
                ext: (914_400, 914_400),
                ..Default::default()
            }),
            geometry: Some(pptx_core::Geometry::Preset {
                name: "rect".into(),
                adjust: Vec::new(),
            }),
            ..Default::default()
        },
        text: Some(probe::probe_body(None)),
        ..Default::default()
    }));
    let probed = probe::probe(sh.ir, job.layout.as_deref(), probes);

    // Colours: theme slots as the slide's master maps them.
    let master = job
        .layout
        .as_deref()
        .and_then(|l| sh.ir.layout(l))
        .and_then(|l| sh.ir.master(&l.master_part))
        .or(sh.ir.masters.first());
    let mut logical = BTreeMap::new();
    if let Some(m) = master {
        for (log, slot) in &m.color_map.entries {
            if matches!(log.as_str(), "tx1" | "bg1" | "tx2" | "bg2") {
                logical.entry(slot.clone()).or_insert_with(|| log.clone());
            }
        }
    }
    let lang = xml
        .find(" lang=\"")
        .and_then(|i| {
            let s = &xml[i + 7..];
            s.find('"').map(|j| s[..j].to_string())
        })
        .unwrap_or_else(|| "en-US".into());
    let max_id = ids_in(xml).into_iter().max().unwrap_or(1);

    let w = Writer {
        sh,
        job,
        rels: RefCell::new(rels),
        lost: RefCell::new(Vec::new()),
        media: RefCell::new(Vec::new()),
        orig,
        base_by_key,
        probed,
        probe_of,
        colors: Colors {
            doc: sh.cur,
            theme: sh.theme,
            logical,
        },
        lang,
        seen: RefCell::new(BTreeSet::new()),
        next_id: RefCell::new(max_id),
    };
    let top: Vec<El> = level_els(xml, &tree);
    let ctx = Ctx {
        space: Space::PAGE,
        fx_cur: IDENTITY,
        fx_base: IDENTITY,
    };
    let body = w.level(&job.cur, &top, None, &ctx);
    // The tree's own properties stay; its shapes are the written ones.
    let head_end = tree
        .children(xml)
        .into_iter()
        .filter(|c| matches!(c.name.as_str(), "p:nvGrpSpPr" | "p:grpSpPr"))
        .map(|c| c.end)
        .max()
        .unwrap_or(tree.inner.0);
    let out = xml::splice(xml, head_end, tree.inner.1, &body);
    check_well_formed(&out)?;
    let lost = w.lost.into_inner();
    let media = w.media.into_inner();
    Ok(Some(Out {
        xml: out,
        media,
        lost,
    }))
}

/// Every `cNvPr id` of a part.
fn ids_in(xml: &str) -> Vec<u32> {
    let mut out = Vec::new();
    let mut at = 0;
    while let Some(i) = xml[at..].find("<p:cNvPr ") {
        let s = at + i;
        let e = xml[s..].find('>').map(|e| s + e).unwrap_or(xml.len());
        if let Some(id) = xml::attr(&xml[s..e], "id").and_then(|v| v.parse().ok()) {
            out.push(id);
        }
        at = e;
    }
    out
}

/// A written part must read back as XML.
pub fn check_well_formed(xml: &str) -> Result<(), String> {
    let mut r = quick_xml::Reader::from_str(xml);
    let mut depth = 0i64;
    loop {
        match r.read_event() {
            Ok(quick_xml::events::Event::Start(_)) => depth += 1,
            Ok(quick_xml::events::Event::End(_)) => depth -= 1,
            Ok(quick_xml::events::Event::Eof) => break,
            Err(e) => return Err(format!("the written slide does not read: {e}")),
            _ => {}
        }
    }
    if depth != 0 {
        return Err("the written slide is not balanced".into());
    }
    Ok(())
}

impl<'a> Writer<'a, '_> {
    fn note(&self, name: &str, what: impl Into<String>) {
        let name = if name.is_empty() { "a shape" } else { name };
        self.lost.borrow_mut().push(format!(
            "slide {}: {name}: {}",
            self.job.slide_no,
            what.into()
        ));
    }

    fn fresh_id(&self) -> u32 {
        let mut n = self.next_id.borrow_mut();
        *n += 1;
        *n
    }

    /// One level of the tree: the document's shapes in its order, with the
    /// shapes it never drew kept where they stood.
    fn level(&self, cur: &[NShape], orig: &[El], parent: Option<&str>, ctx: &Ctx) -> String {
        let xml = self.job.xml.as_str();
        // Original elements of this level: (key, drawn by the document).
        let keyed: Vec<(Option<String>, bool)> = orig
            .iter()
            .map(|el| {
                let key = el_id(xml, el).map(|id| {
                    let path = match parent {
                        None => id.to_string(),
                        Some(p) => {
                            format!("{}/{id}", p.strip_prefix(&self.job.prefix).unwrap_or(p))
                        }
                    };
                    format!("{}{path}", self.job.prefix)
                });
                let drawn = key
                    .as_ref()
                    .is_some_and(|k| self.base_by_key.contains_key(k));
                (key, drawn)
            })
            .collect();
        let index_of = |k: &str| keyed.iter().position(|(key, _)| key.as_deref() == Some(k));
        let mut out = String::new();
        let mut flushed = 0usize;
        let flush = |upto: usize, flushed: &mut usize, out: &mut String| {
            while *flushed < upto.min(orig.len()) {
                if !keyed[*flushed].1 {
                    out.push_str(orig[*flushed].text(xml));
                }
                *flushed += 1;
            }
        };
        for c in cur {
            if let Some(i) = c.key.as_deref().and_then(index_of) {
                flush(i, &mut flushed, &mut out);
            }
            out.push_str(&self.shape(c, parent, ctx));
        }
        flush(orig.len(), &mut flushed, &mut out);
        out
    }

    /// One shape of the document.
    fn shape(&self, c: &NShape, parent: Option<&str>, ctx: &Ctx) -> String {
        let xml = self.job.xml.as_str();
        let found = c.key.as_ref().and_then(|k| {
            let o = self.orig.get(k)?;
            let b = self.base_by_key.get(k)?;
            Some((k.clone(), o, b))
        });
        let Some((k, o, b)) = found else {
            return self.generate(c, ctx);
        };
        // A second shape with the key (a copy on the same slide) is a new
        // shape: the original's XML under a new id.
        let copy = !self.seen.borrow_mut().insert(k.clone());
        let same_parent = o.parent.as_deref() == parent;
        if !copy && same_parent && sig(b, self.job.base_doc) == sig(c, self.sh.cur) {
            return o.el.text(xml).to_string();
        }
        let new_id = copy.then(|| self.fresh_id());
        match self.patch(o, b, c, ctx, new_id) {
            Ok(s) => s,
            Err(e) => {
                let name = c.name.clone().unwrap_or_default();
                self.note(&name, format!("{e}; written as the deck had it"));
                if copy {
                    String::new()
                } else {
                    o.el.text(xml).to_string()
                }
            }
        }
    }

    /// The change of placement from what import made to what the document
    /// holds: a map of the page, and whether an outline was reshaped
    /// beyond it.
    fn delta(&self, b: &NShape, c: &NShape, ctx: &Ctx) -> Result<(Affine, bool), String> {
        if b.group.is_some() || c.group.is_some() {
            let nb = geom::mul(&ctx.fx_base, &b.group_transform());
            let nc = geom::mul(&ctx.fx_cur, &c.group_transform());
            let inv = geom::invert(&nb).ok_or("a degenerate group transform")?;
            return Ok((geom::mul(&nc, &inv), false));
        }
        let mut chosen = None;
        let mut reshaped = false;
        for (eb, ec) in pairs(b, c)?.into_iter().filter_map(|(x, y)| Some((x, y?))) {
            let nb = geom::mul(&ctx.fx_base, &eb.transform());
            let nc = geom::mul(&ctx.fx_cur, &ec.transform());
            let s = box_map(bbox(eb), bbox(ec));
            let inv = geom::invert(&nb).ok_or("a degenerate transform")?;
            let d = geom::mul(&nc, &geom::mul(&s, &inv));
            if eb.kind == Kind::Polygon && !reshaped {
                let pa = eb.anchors();
                let pc = ec.anchors();
                reshaped = pa.len() != pc.len()
                    || eb.contours() != ec.contours()
                    || pa.iter().zip(&pc).any(|(x, y)| {
                        (0..3).any(|k| {
                            let q = geom::apply(&s, x[k]);
                            (q.0 - y[k].0).abs() > 0.05 || (q.1 - y[k].1).abs() > 0.05
                        })
                    });
            }
            if chosen.is_none() && !geom::near(&d, &IDENTITY, 1e-5, 0.005) {
                chosen = Some(d);
            }
        }
        Ok((chosen.unwrap_or(IDENTITY), reshaped))
    }

    /// The shape's new placement: `None` when it did not move.
    fn new_place(
        &self,
        o: &Orig,
        d: &Affine,
        ctx: &Ctx,
        moved_level: bool,
    ) -> Result<Option<(Placed, Xfrm)>, String> {
        if geom::near(d, &IDENTITY, 1e-5, 0.005) && !moved_level {
            return Ok(None);
        }
        let it = o.item.ok_or("its placement was not resolved at import")?;
        let a = Placed {
            map: it.transform,
            w: it.w,
            h: it.h,
        };
        let p = Placed::normalised(geom::mul(d, &a.map), a.w, a.h)
            .ok_or("it is skewed, which DrawingML cannot place")?;
        let x = ctx.space.xfrm_of(&p).ok_or("its group cannot hold it")?;
        Ok(Some((p, x)))
    }

    fn patch(
        &self,
        o: &Orig,
        b: &NShape,
        c: &NShape,
        ctx: &Ctx,
        new_id: Option<u32>,
    ) -> Result<String, String> {
        let xml = self.job.xml.as_str();
        let mut x = o.el.text(xml).to_string();
        if let Some(id) = new_id {
            x = set_shape_id(&x, id);
        }
        let name = c.name.clone().unwrap_or_default();
        if c.label.frame.is_some() {
            return self.patch_frame(&x, o, b, c, ctx);
        }
        match o.el.name.as_str() {
            "p:sp" | "p:cxnSp" => self.patch_sp(x, o, b, c, ctx, &name),
            "p:pic" => self.patch_pic(x, o, b, c, ctx, &name),
            "p:grpSp" => self.patch_group(x, o, b, c, ctx),
            "p:graphicFrame" => self.patch_table(x, o, b, c, ctx, &name),
            other => Err(format!("{other} edits are not exported")),
        }
    }

    /// A chart or SmartArt drawn as a group: it may move; what is inside
    /// is the part's, not the document's.
    fn patch_frame(
        &self,
        x: &str,
        o: &Orig,
        b: &NShape,
        c: &NShape,
        ctx: &Ctx,
    ) -> Result<String, String> {
        let (d, _) = self.delta(b, c, ctx)?;
        // The members moved with the group, or the group moved: both read
        // as the same map on every member.
        let inner_same = b.children.len() == c.children.len()
            && b.children.iter().zip(&c.children).all(|(cb, cc)| {
                let mut cb = cb.clone();
                let mut cc = cc.clone();
                for e in cb.elems.iter_mut().chain(cc.elems.iter_mut()) {
                    if let Some(m) = e.v.as_object_mut() {
                        m.remove("item_transform");
                    }
                }
                sig(&cb, self.job.base_doc) == sig(&cc, self.sh.cur)
            });
        // A live chart redrawn from its edited workbook (ADR 715): its
        // drawing is the chart part's, written beside the slide.
        let redrawn = c
            .label
            .chart
            .as_ref()
            .is_some_and(|p| self.sh.live_charts.contains(p));
        if !inner_same && !redrawn {
            return Err(format!(
                "edits inside the {} are not exported",
                c.label.frame.as_deref().unwrap_or("frame")
            ));
        }
        let mut x = x.to_string();
        if let Some((_, nx)) = self.new_place(o, &d, ctx, false)? {
            x = set_frame_xfrm(&x, &nx)?;
        }
        Ok(x)
    }

    fn patch_sp(
        &self,
        mut x: String,
        o: &Orig,
        b: &NShape,
        c: &NShape,
        ctx: &Ctx,
        name: &str,
    ) -> Result<String, String> {
        // A live preset (slide ADR 717) is placed by its box, and stays a
        // preset: drawn again for a new box or with new adjust values.
        let live = c
            .elems
            .iter()
            .find(|e| e.kind == Kind::Polygon)
            .and_then(|e| live_box(&c.label, e).map(|bx| (e, bx)))
            .zip(c.label.preset.as_ref());
        let (d, reshaped) = match live {
            Some(_) => (IDENTITY, false),
            None => self.delta(b, c, ctx)?,
        };
        let place = match live {
            Some(_) => None,
            None => self.new_place(o, &d, ctx, false)?,
        };
        if let Some((_, nx)) = &place {
            x = set_sppr(
                &x,
                &["a:xfrm"],
                Some(&geom::xfrm_xml("a", &with_ch(nx, None))),
                &[],
            )?;
        }
        if let Some(((poly, (w, h)), (prst, adj))) = live {
            let m = geom::mul(&ctx.fx_cur, &poly.transform());
            let p =
                Placed::normalised(m, w, h).ok_or("it is skewed, which DrawingML cannot place")?;
            let nx = ctx.space.xfrm_of(&p).ok_or("its group cannot hold it")?;
            let was = o
                .item
                .map(|it| Placed {
                    map: it.transform,
                    w: it.w,
                    h: it.h,
                })
                .and_then(|p| ctx.space.xfrm_of(&p));
            if !was.is_some_and(|w| geom::same_xfrm(&w, &nx)) {
                x = set_sppr(
                    &x,
                    &["a:xfrm"],
                    Some(&geom::xfrm_xml("a", &with_ch(&nx, None))),
                    &[],
                )?;
            }
            if b.label.preset.as_ref() != Some(&(prst.clone(), adj.clone())) {
                x = set_sppr(
                    &x,
                    &["a:prstGeom", "a:custGeom"],
                    Some(&preset_xml(prst, adj)),
                    &["a:xfrm"],
                )?;
            }
        } else if reshaped {
            let poly = c
                .elems
                .iter()
                .find(|e| e.kind == Kind::Polygon)
                .ok_or("no outline")?;
            let p = match &place {
                Some((p, _)) => *p,
                None => {
                    let it = o.item.ok_or("unresolved")?;
                    Placed {
                        map: it.transform,
                        w: it.w,
                        h: it.h,
                    }
                }
            };
            let g = self.cust_geom(poly, &p, ctx)?;
            x = set_sppr(&x, &["a:prstGeom", "a:custGeom"], Some(&g), &["a:xfrm"])?;
        }
        // An element of the shape deleted on its own: its outline (the
        // shape paints nothing) or its text (the shape keeps no text).
        let paired = pairs(b, c)?;
        if paired
            .iter()
            .any(|(e, m)| m.is_none() && e.kind == Kind::Polygon)
            && !c.elems.iter().any(|e| e.kind == Kind::Polygon)
        {
            x = set_sppr(
                &x,
                &[
                    "a:noFill",
                    "a:solidFill",
                    "a:gradFill",
                    "a:blipFill",
                    "a:pattFill",
                    "a:grpFill",
                ],
                Some("<a:noFill/>"),
                &["a:xfrm", "a:prstGeom", "a:custGeom"],
            )?;
            x = set_sppr(
                &x,
                &["a:ln"],
                Some("<a:ln><a:noFill/></a:ln>"),
                &[
                    "a:xfrm",
                    "a:prstGeom",
                    "a:custGeom",
                    "a:noFill",
                    "a:solidFill",
                    "a:gradFill",
                    "a:blipFill",
                    "a:pattFill",
                    "a:grpFill",
                ],
            )?;
        }
        if paired
            .iter()
            .any(|(e, m)| m.is_none() && e.kind == Kind::TextFrame)
        {
            let root = xml::root(&x).ok_or("unreadable shape")?;
            if let Some(body) = root.child(&x, "p:txBody") {
                let paras: Vec<El> = body
                    .children(&x)
                    .into_iter()
                    .filter(|e| e.name == "a:p")
                    .collect();
                if let (Some(f), Some(l)) = (paras.first(), paras.last()) {
                    let empty = format!(
                        r#"<a:p><a:endParaRPr lang="{}" dirty="0"/></a:p>"#,
                        esc(&self.lang)
                    );
                    x = xml::splice(&x, f.start, l.end, &empty);
                }
            }
        }
        // Fill, line: from the outline (or a text frame that paints).
        let mut other: BTreeSet<String> = BTreeSet::new();
        for (eb, ec) in paired.iter().filter_map(|(x, y)| Some((*x, (*y)?))) {
            let keys = changed_keys(&eb.v, &ec.v);
            let has = |set: &[&str]| keys.iter().any(|k| set.contains(&k.as_str()));
            if eb.kind != Kind::TextFrame || b.elems.len() == 1 {
                if has(FILL) || (keys.contains("opacity") && eb.kind != Kind::TextFrame) {
                    let fill = self.fill_of(ec);
                    x = set_sppr(
                        &x,
                        &[
                            "a:noFill",
                            "a:solidFill",
                            "a:gradFill",
                            "a:blipFill",
                            "a:pattFill",
                            "a:grpFill",
                        ],
                        Some(&fill),
                        &["a:xfrm", "a:prstGeom", "a:custGeom"],
                    )?;
                }
                if has(LINE) && eb.kind != Kind::TextFrame {
                    let ln = self.line_of(ec);
                    x = set_sppr(
                        &x,
                        &["a:ln"],
                        Some(&ln),
                        &[
                            "a:xfrm",
                            "a:prstGeom",
                            "a:custGeom",
                            "a:noFill",
                            "a:solidFill",
                            "a:gradFill",
                            "a:blipFill",
                            "a:pattFill",
                            "a:grpFill",
                        ],
                    )?;
                }
            }
            if has(EFFECTS) && eb.kind != Kind::TextFrame {
                x = set_sppr(
                    &x,
                    &["a:effectLst", "a:effectDag"],
                    self.effects_of(ec).as_deref(),
                    BEFORE_EFFECTS,
                )?;
            }
            for k in keys {
                let known = [PLACE, FILL, LINE, FRAME, IGNORE, EFFECTS]
                    .iter()
                    .any(|s| s.contains(&k.as_str()));
                if !known {
                    other.insert(k);
                }
            }
        }
        if !other.is_empty() {
            self.note(
                name,
                format!(
                    "{} not exported",
                    other.into_iter().collect::<Vec<_>>().join(", ")
                ),
            );
        }
        // Text.
        if let (Some(fb), Some(fc)) = (b.text_frame(), c.text_frame()) {
            x = self.patch_text(x, o, fb, fc, name)?;
        }
        Ok(x)
    }

    fn patch_text(
        &self,
        mut x: String,
        o: &Orig,
        fb: &Elem,
        fc: &Elem,
        name: &str,
    ) -> Result<String, String> {
        let pb = fb
            .story()
            .and_then(|s| native::story(self.job.base_doc, &s))
            .unwrap_or(&[]);
        let pc = fc
            .story()
            .and_then(|s| native::story(self.sh.cur, &s))
            .unwrap_or(&[]);
        let text_changed = serde_json::to_string(pb).ok() != serde_json::to_string(pc).ok();
        let keys = changed_keys(&fb.v, &fc.v);
        if text_changed {
            let root = xml::root(&x).ok_or("unreadable shape")?;
            let body = root
                .child(&x, "p:txBody")
                .ok_or("the shape has no text body")?;
            let paras: Vec<El> = body
                .children(&x)
                .into_iter()
                .filter(|e| e.name == "a:p")
                .collect();
            let defaults = self.defaults(o.key.as_deref());
            let reuse = Reuse {
                base: pb,
                xml: &x,
                els: paras.clone(),
            };
            let written = self.paragraphs(pc, &defaults, Some(&reuse), name);
            let (a, z) = match (paras.first(), paras.last()) {
                (Some(f), Some(l)) => (f.start, l.end),
                _ => {
                    let after = body
                        .children(&x)
                        .into_iter()
                        .filter(|e| matches!(e.name.as_str(), "a:bodyPr" | "a:lstStyle"))
                        .map(|e| e.end)
                        .max()
                        .unwrap_or(body.inner.0);
                    (after, after)
                }
            };
            x = xml::splice(&x, a, z, &written);
        }
        if keys.contains("inset_spacing") || keys.contains("vertical_justification") {
            let root = xml::root(&x).ok_or("unreadable shape")?;
            if let Some(bp) = root.path(&x, &["p:txBody", "a:bodyPr"]) {
                let mut tag = bp.open(&x).to_string();
                if let Some(ins) = fc.v.get("inset_spacing").and_then(Value::as_array) {
                    let g = |i: usize| ins.get(i).and_then(Value::as_f64).unwrap_or(0.0);
                    for (k, v) in [
                        ("tIns", g(0)),
                        ("lIns", g(1)),
                        ("bIns", g(2)),
                        ("rIns", g(3)),
                    ] {
                        tag = xml::set_attr(&tag, k, Some(&emu(v).to_string()));
                    }
                }
                if let Some(vj) = fc.s("vertical_justification") {
                    let a = match vj.as_str() {
                        "Center" | "CenterAlign" => "ctr",
                        "Bottom" | "BottomAlign" => "b",
                        _ => "t",
                    };
                    tag = xml::set_attr(&tag, "anchor", Some(a));
                }
                let end = bp.start + bp.open(&x).len();
                x = xml::splice(&x, bp.start, end, &tag);
            }
        }
        Ok(x)
    }

    fn defaults(&self, key: Option<&str>) -> Defaults {
        key.and_then(|k| self.probe_of.get(k))
            .and_then(|id| self.probed.text.get(id))
            .or_else(|| self.probed.text.get(&TEXT_BOX_PROBE))
            .cloned()
            .unwrap_or(Defaults {
                levels: Vec::new(),
                font_scale: 1.0,
            })
    }

    fn paragraphs(
        &self,
        cur: &[paged_model::Paragraph],
        defaults: &Defaults,
        reuse: Option<&Reuse>,
        name: &str,
    ) -> String {
        let ctx = TextCtx {
            colors: &self.colors,
            lang: self.lang.clone(),
            slide_no: self.job.slide_no,
        };
        let mut lost = Vec::new();
        let mut link = |src: &str| self.text_link(src);
        let s = text::paragraphs(cur, defaults, reuse, &ctx, &mut link, &mut lost);
        lost.sort();
        lost.dedup();
        for l in lost {
            self.note(name, l);
        }
        s
    }

    /// A run's hyperlink as `a:hlinkClick`, its relationship added.
    fn text_link(&self, source: &str) -> Option<String> {
        let dm = &self.sh.cur.designmap;
        let h = dm
            .hyperlinks
            .iter()
            .find(|h| h.source.as_deref() == Some(source))?;
        let dest = dm
            .hyperlink_destinations
            .iter()
            .find(|d| Some(&d.self_id) == h.destination.as_ref())?;
        use paged_model::HyperlinkDestinationKind as K;
        match &dest.kind {
            K::Url(u) if u.starts_with("ppaction://") => {
                Some(format!(r#"<a:hlinkClick r:id="" action="{}"/>"#, esc(u)))
            }
            K::Url(u) => {
                let id = self.rels.borrow_mut().add(REL_HYPERLINK, u, true);
                Some(format!(r#"<a:hlinkClick r:id="{id}"/>"#))
            }
            K::Page(p) => match self.sh.page_part.get(p) {
                Some(part) => {
                    let dir = self.rels.borrow().dir.clone();
                    let id = self
                        .rels
                        .borrow_mut()
                        .add(REL_SLIDE, &relative(&dir, part), false);
                    Some(format!(
                        r#"<a:hlinkClick r:id="{id}" action="ppaction://hlinksldjump"/>"#
                    ))
                }
                None => {
                    self.note("a text link", "its slide is not in the deck; dropped");
                    None
                }
            },
            K::TextAnchor(_) => None,
        }
    }

    /// A shape's click action (from its label) as `a:hlinkClick`.
    fn shape_link(&self, l: &native::Link) -> Option<String> {
        let tip = l
            .tooltip
            .as_ref()
            .map(|t| format!(r#" tooltip="{}""#, esc(t)))
            .unwrap_or_default();
        let action = l
            .action
            .as_ref()
            .map(|a| format!(r#" action="{}""#, esc(a)))
            .unwrap_or_default();
        let id = if let Some(u) = &l.url {
            self.rels.borrow_mut().add(REL_HYPERLINK, u, true)
        } else if let Some(p) = &l.slide {
            let part = self.sh.source_part.get(p)?;
            let dir = self.rels.borrow().dir.clone();
            self.rels
                .borrow_mut()
                .add(REL_SLIDE, &relative(&dir, part), false)
        } else {
            String::new()
        };
        Some(format!(r#"<a:hlinkClick r:id="{id}"{action}{tip}/>"#))
    }

    fn fill_of(&self, e: &Elem) -> String {
        let alpha = e.f("opacity").map(|o| o / 100.0);
        self.colors.fill(
            e.s("fill_color").as_deref(),
            alpha,
            e.f("gradient_fill_angle"),
        )
    }

    /// An element's drop shadow and effects as `a:effectLst` (the shared
    /// mapper's inverse); `None` when it has none.
    fn effects_of(&self, e: &Elem) -> Option<String> {
        let drop: Option<paged_model::DropShadowSetting> =
            e.v.get("drop_shadow")
                .and_then(|v| serde_json::from_value(v.clone()).ok());
        let fx: Option<paged_model::FrameEffects> =
            e.v.get("effects")
                .and_then(|v| serde_json::from_value(v.clone()).ok());
        let back = dml_native::effects_of(drop.as_ref(), fx.as_ref(), &|id| self.colors.rgb(id));
        paged_ooxml::drawingml::write::effects(&back, &|rgb, a| self.colors.rgb_color(rgb, a))
    }

    fn line_of(&self, e: &Elem) -> String {
        let w = e.f("stroke_weight").unwrap_or(0.0);
        let color = e.s("stroke_color").filter(|c| c != "Swatch/None");
        let Some(color) = color.filter(|_| w > 0.0) else {
            return "<a:ln><a:noFill/></a:ln>".into();
        };
        let alpha = e.f("opacity").map(|o| o / 100.0);
        let fill = self.colors.fill(Some(&color), alpha, None);
        let cap = match e.s("end_cap").as_deref() {
            Some("RoundEndCap") => r#" cap="rnd""#,
            Some("ProjectingEndCap") => r#" cap="sq""#,
            _ => "",
        };
        let pattern: Vec<f32> =
            e.v.get("stroke_dash")
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .unwrap_or_default();
        // The dash pattern when the item has one (a preset back as its
        // name), else the stroke style's.
        let dash = match dml_native::dash_of(&pattern, w) {
            Some(Ok(name)) => format!(r#"<a:prstDash val="{name}"/>"#),
            Some(Err(pairs)) => format!(
                "<a:custDash>{}</a:custDash>",
                pairs
                    .iter()
                    .map(|(d, sp)| format!(r#"<a:ds d="{d}" sp="{sp}"/>"#))
                    .collect::<String>()
            ),
            None => match e.s("stroke_type").as_deref() {
                Some(t) if t.contains("Dash") => r#"<a:prstDash val="dash"/>"#.into(),
                Some(t) if t.contains("Dotted") => r#"<a:prstDash val="sysDot"/>"#.into(),
                _ => String::new(),
            },
        };
        let lim = e
            .f("miter_limit")
            .map(|m| (m * 100_000.0).round() as i64)
            .unwrap_or(800_000);
        let join = match e.s("end_join").as_deref() {
            Some("RoundEndJoin") => "<a:round/>".to_string(),
            Some("BevelEndJoin") => "<a:bevel/>".to_string(),
            Some("MiterEndJoin") => format!(r#"<a:miter lim="{lim}"/>"#),
            _ => String::new(),
        };
        let arrow = |k: &str, tag: &str| -> String {
            match e.s(k).as_deref() {
                None | Some("None") => String::new(),
                Some(a) => {
                    let t = match a {
                        "Simple" | "SimpleWide" => "arrow",
                        "Barbed" => "stealth",
                        "Square" | "SquareSolid" => "diamond",
                        "CircleSolid" | "Circle" => "oval",
                        _ => "triangle",
                    };
                    format!(r#"<a:{tag} type="{t}"/>"#)
                }
            }
        };
        format!(
            r#"<a:ln w="{}"{cap}>{fill}{dash}{join}{}{}</a:ln>"#,
            emu(w),
            arrow("start_arrow", "headEnd"),
            arrow("end_arrow", "tailEnd")
        )
    }

    /// An outline as custom geometry in the box `p`.
    fn cust_geom(&self, e: &Elem, p: &Placed, ctx: &Ctx) -> Result<String, String> {
        let inv = geom::invert(&p.map).ok_or("a degenerate box")?;
        let m = geom::mul(&inv, &geom::mul(&ctx.fx_cur, &e.transform()));
        let pts = e.anchors();
        let (starts, open) = e.contours();
        let mut bounds: Vec<usize> = if starts.is_empty() { vec![0] } else { starts };
        bounds.push(pts.len());
        let mut contours = Vec::new();
        for (k, w) in bounds.windows(2).enumerate() {
            let c: Vec<[(f64, f64); 3]> = pts[w[0]..w[1]]
                .iter()
                .map(|q| {
                    [
                        geom::apply(&m, q[0]),
                        geom::apply(&m, q[1]),
                        geom::apply(&m, q[2]),
                    ]
                })
                .collect();
            let closed = !open.get(k).copied().unwrap_or(false);
            contours.push((c, closed));
        }
        Ok(geom::cust_geom(&contours, p.w, p.h))
    }

    fn patch_pic(
        &self,
        mut x: String,
        o: &Orig,
        b: &NShape,
        c: &NShape,
        ctx: &Ctx,
        name: &str,
    ) -> Result<String, String> {
        let (d, reshaped) = self.delta(b, c, ctx)?;
        if reshaped {
            self.note(name, "a reshaped picture frame is not exported");
        }
        if let Some((_, nx)) = self.new_place(o, &d, ctx, false)? {
            x = set_sppr(
                &x,
                &["a:xfrm"],
                Some(&geom::xfrm_xml("a", &with_ch(&nx, None))),
                &[],
            )?;
        }
        let (Some(eb), Some(ec)) = (b.primary(), c.primary()) else {
            return Ok(x);
        };
        let keys = changed_keys(&eb.v, &ec.v);
        if keys.contains("image_bytes") {
            if let Some(bytes) = image_bytes(ec) {
                let rid = self.add_image(&bytes)?;
                let root = xml::root(&x).ok_or("unreadable picture")?;
                let blip = root.path(&x, &["p:blipFill", "a:blip"]).ok_or("no blip")?;
                let tag = xml::set_attr(blip.open(&x), "r:embed", Some(&rid));
                let end = blip.start + blip.open(&x).len();
                x = xml::splice(&x, blip.start, end, &tag);
            }
        }
        if keys.contains("image_item_transform")
            || keys.contains("bounds")
            || keys.contains("image_bytes")
        {
            let (cb, cc) = (crop_of(eb), crop_of(ec));
            if let (Some(cb), Some(cc)) = (cb, cc) {
                if (0..4).any(|i| (cb[i] - cc[i]).abs() > 0.001) {
                    let src = format!(
                        r#"<a:srcRect l="{}" t="{}" r="{}" b="{}"/>"#,
                        (cc[0] * 100_000.0).round() as i64,
                        (cc[1] * 100_000.0).round() as i64,
                        (cc[2] * 100_000.0).round() as i64,
                        (cc[3] * 100_000.0).round() as i64
                    );
                    x = set_child(&x, &["p:blipFill"], &["a:srcRect"], Some(&src), &["a:blip"])?;
                }
            }
        }
        if keys.iter().any(|k| EFFECTS.contains(&k.as_str())) {
            x = set_sppr(
                &x,
                &["a:effectLst", "a:effectDag"],
                self.effects_of(ec).as_deref(),
                BEFORE_EFFECTS,
            )?;
        }
        let other: Vec<String> = keys
            .into_iter()
            .filter(|k| {
                ![PLACE, IMAGE, IGNORE, LINE, EFFECTS]
                    .iter()
                    .any(|s| s.contains(&k.as_str()))
            })
            .collect();
        if !other.is_empty() {
            self.note(name, format!("{} not exported", other.join(", ")));
        }
        Ok(x)
    }

    /// A new image part and the slide's relationship to it.
    fn add_image(&self, bytes: &[u8]) -> Result<String, String> {
        let ext = image_ext(bytes).ok_or("the image is not PNG, JPEG or GIF")?;
        let h = hash_bytes(bytes);
        let part = {
            let mut m = self.sh.media.borrow_mut();
            if let Some(p) = m.0.get(&h) {
                p.clone()
            } else {
                m.1 += 1;
                let p = format!("ppt/media/image{}.{ext}", m.1);
                m.0.insert(h, p.clone());
                self.media.borrow_mut().push((p.clone(), bytes.to_vec()));
                p
            }
        };
        let dir = self.rels.borrow().dir.clone();
        Ok(self
            .rels
            .borrow_mut()
            .add(REL_IMAGE, &relative(&dir, &part), false))
    }

    fn patch_group(
        &self,
        x: String,
        o: &Orig,
        b: &NShape,
        c: &NShape,
        ctx: &Ctx,
    ) -> Result<String, String> {
        let gx = match o.shape {
            Some(Shape::Group(g)) => g.props.xfrm.clone().unwrap_or_default(),
            _ => return Err("the group was not read at import".into()),
        };
        let (d, _) = self.delta(b, c, ctx)?;
        let mut x = x;
        let mut new_gx = gx.clone();
        if let Some((_, nx)) = self.new_place(o, &d, ctx, false)? {
            new_gx = Xfrm {
                ch_off: gx.ch_off.or(Some(gx.off)),
                ch_ext: gx.ch_ext.or(Some(gx.ext)),
                ..nx
            };
            x = set_child(
                &x,
                &["p:grpSpPr"],
                &["a:xfrm"],
                Some(&geom::xfrm_xml("a", &new_gx)),
                &[],
            )?;
        }
        let inner = Ctx {
            space: ctx.space.child(&new_gx),
            fx_cur: geom::mul(&ctx.fx_cur, &c.group_transform()),
            fx_base: geom::mul(&ctx.fx_base, &b.group_transform()),
        };
        // The members, in the document's order, in the group's space.
        let root = xml::root(&x).ok_or("unreadable group")?;
        let kids = level_els(&x, &root);
        let head_end = root
            .children(&x)
            .into_iter()
            .filter(|e| matches!(e.name.as_str(), "p:nvGrpSpPr" | "p:grpSpPr"))
            .map(|e| e.end)
            .max()
            .unwrap_or(root.inner.0);
        // Members are located in the slide's own text; the group's text
        // here may have been rewritten above, so read them from the slide.
        let xml = self.job.xml.as_str();
        let orig_kids = level_els(xml, &o.el);
        let _ = kids;
        let body = self.level(&c.children, &orig_kids, o.key.as_deref(), &inner);
        Ok(xml::splice(&x, head_end, root.inner.1, &body))
    }

    fn patch_table(
        &self,
        mut x: String,
        o: &Orig,
        b: &NShape,
        c: &NShape,
        ctx: &Ctx,
        name: &str,
    ) -> Result<String, String> {
        let (d, _) = self.delta(b, c, ctx)?;
        if let Some((_, nx)) = self.new_place(o, &d, ctx, false)? {
            x = set_frame_xfrm(&x, &nx)?;
        }
        let (Some(fb), Some(fc)) = (b.text_frame(), c.text_frame()) else {
            return Ok(x);
        };
        let tb = fb
            .story()
            .and_then(|s| native::story(self.job.base_doc, &s))
            .and_then(|p| p.first())
            .and_then(|p| p.table.as_ref());
        let tc = fc
            .story()
            .and_then(|s| native::story(self.sh.cur, &s))
            .and_then(|p| p.first())
            .and_then(|p| p.table.as_ref());
        let (Some(tb), Some(tc)) = (tb, tc) else {
            return Ok(x);
        };
        let (vb, vc) = (
            serde_json::to_value(tb).unwrap_or_default(),
            serde_json::to_value(tc).unwrap_or_default(),
        );
        if vb == vc {
            return Ok(x);
        }
        let rows = |v: &Value| {
            v.get("rows")
                .and_then(Value::as_array)
                .map(Vec::len)
                .unwrap_or(0)
        };
        let cols = |v: &Value| {
            v.get("columns")
                .and_then(Value::as_array)
                .map(Vec::len)
                .unwrap_or(0)
        };
        let cells = |v: &Value| -> BTreeMap<String, Value> {
            v.get("cells")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(|c| Some((c.get("name")?.as_str()?.to_string(), c.clone())))
                        .collect()
                })
                .unwrap_or_default()
        };
        let (cb, cc) = (cells(&vb), cells(&vc));
        let spans = |m: &BTreeMap<String, Value>| -> Vec<(String, Value, Value)> {
            m.iter()
                .map(|(k, v)| {
                    (
                        k.clone(),
                        v.get("row_span").cloned().unwrap_or_default(),
                        v.get("column_span").cloned().unwrap_or_default(),
                    )
                })
                .collect()
        };
        if rows(&vb) != rows(&vc) || cols(&vb) != cols(&vc) || spans(&cb) != spans(&cc) {
            self.note(
                name,
                "added, removed or merged table rows and columns are not exported",
            );
            return Ok(x);
        }
        let probe_id = o.key.as_ref().and_then(|k| self.probe_of.get(k)).copied();
        // Column widths and row heights.
        for (i, (cbv, ccv)) in vb["columns"]
            .as_array()
            .unwrap_or(&vec![])
            .iter()
            .zip(vc["columns"].as_array().unwrap_or(&vec![]))
            .enumerate()
        {
            if cbv.get("single_column_width") != ccv.get("single_column_width") {
                if let Some(w) = ccv.get("single_column_width").and_then(Value::as_f64) {
                    x = set_nth_attr(
                        &x,
                        &["a:graphic", "a:graphicData", "a:tbl", "a:tblGrid"],
                        "a:gridCol",
                        i,
                        "w",
                        &emu(w).to_string(),
                    )?;
                }
            }
        }
        for (i, (rbv, rcv)) in vb["rows"]
            .as_array()
            .unwrap_or(&vec![])
            .iter()
            .zip(vc["rows"].as_array().unwrap_or(&vec![]))
            .enumerate()
        {
            if rbv.get("single_row_height") != rcv.get("single_row_height") {
                if let Some(h) = rcv.get("single_row_height").and_then(Value::as_f64) {
                    x = set_nth_attr(
                        &x,
                        &["a:graphic", "a:graphicData", "a:tbl"],
                        "a:tr",
                        i,
                        "h",
                        &emu(h).to_string(),
                    )?;
                }
            }
        }
        let mut other = BTreeSet::new();
        for (nm, vcc) in &cc {
            let Some(vbc) = cb.get(nm) else { continue };
            for k in changed_keys(vbc, vcc) {
                if k != "paragraphs" && k != "self_id" {
                    other.insert(format!("cell {k}"));
                }
            }
            if vbc.get("paragraphs") == vcc.get("paragraphs") {
                continue;
            }
            let Some((ci, ri)) = nm
                .split_once(':')
                .and_then(|(a, b)| Some((a.parse::<usize>().ok()?, b.parse::<usize>().ok()?)))
            else {
                continue;
            };
            let cell_paras = |t: &paged_model::Table| -> Vec<paged_model::Paragraph> {
                t.cells
                    .iter()
                    .find(|c| c.name.as_deref() == Some(nm.as_str()))
                    .map(|c| c.paragraphs.clone())
                    .unwrap_or_default()
            };
            let (pb, pc) = (cell_paras(tb), cell_paras(tc));
            let defaults = probe_id
                .and_then(|id| self.probed.cells.get(&(id, ri, ci)))
                .cloned()
                .unwrap_or_else(|| self.defaults(None));
            let root = xml::root(&x).ok_or("unreadable table")?;
            let tbl = root
                .path(&x, &["a:graphic", "a:graphicData", "a:tbl"])
                .ok_or("no table")?;
            let tr = tbl
                .children(&x)
                .into_iter()
                .filter(|e| e.name == "a:tr")
                .nth(ri)
                .ok_or("no such row")?;
            let tc = tr
                .children(&x)
                .into_iter()
                .filter(|e| e.name == "a:tc")
                .nth(ci)
                .ok_or("no such cell")?;
            let written;
            let (a, z);
            match tc.child(&x, "a:txBody") {
                Some(body) => {
                    let paras: Vec<El> = body
                        .children(&x)
                        .into_iter()
                        .filter(|e| e.name == "a:p")
                        .collect();
                    let reuse = Reuse {
                        base: &pb,
                        xml: &x,
                        els: paras.clone(),
                    };
                    written = self.paragraphs(&pc, &defaults, Some(&reuse), name);
                    match (paras.first(), paras.last()) {
                        (Some(f), Some(l)) => {
                            a = f.start;
                            z = l.end;
                        }
                        _ => {
                            a = body.inner.1;
                            z = body.inner.1;
                        }
                    }
                }
                None => {
                    written = format!(
                        "<a:txBody><a:bodyPr/><a:lstStyle/>{}</a:txBody>",
                        self.paragraphs(&pc, &defaults, None, name)
                    );
                    a = tc.inner.0;
                    z = tc.inner.0;
                }
            }
            x = xml::splice(&x, a, z, &written);
        }
        if !other.is_empty() {
            self.note(
                name,
                format!(
                    "{} not exported",
                    other.into_iter().collect::<Vec<_>>().join(", ")
                ),
            );
        }
        Ok(x)
    }

    /// A shape made in the editor, written whole.
    fn generate(&self, c: &NShape, ctx: &Ctx) -> String {
        let name = c.name.clone().unwrap_or_default();
        if let Some(f) = &c.label.frame {
            self.note(&name, format!("a copied {f} is not exported"));
            return String::new();
        }
        if c.group.is_some() {
            return self.generate_group(c, ctx);
        }
        let mut out = String::new();
        for e in &c.elems {
            // A preset's stroke-only detail is in the preset its outline
            // element writes.
            if c.label.detail && live_box(&c.label, e).is_some() {
                continue;
            }
            match self.generate_elem(e, c, ctx) {
                Ok(s) => out.push_str(&s),
                Err(err) => self.note(&name, format!("{err}; not exported")),
            }
        }
        out
    }

    fn generate_group(&self, c: &NShape, ctx: &Ctx) -> String {
        let name = c.name.clone().unwrap_or_else(|| "Group".into());
        let gt = c.group_transform();
        // The group's box: its members' outlines on the page.
        let fx = geom::mul(&ctx.fx_cur, &gt);
        let mut bb = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
        fn visit(s: &NShape, fx: &Affine, bb: &mut (f64, f64, f64, f64)) {
            let fx2 = geom::mul(fx, &s.group_transform());
            for e in &s.elems {
                let m = geom::mul(&fx2, &e.transform());
                for p in e.anchors() {
                    let q = geom::apply(&m, p[0]);
                    *bb = (bb.0.min(q.0), bb.1.min(q.1), bb.2.max(q.0), bb.3.max(q.1));
                }
            }
            for ch in &s.children {
                visit(ch, &fx2, bb);
            }
        }
        for ch in &c.children {
            visit(ch, &fx, &mut bb);
        }
        if bb.0 > bb.2 {
            return String::new();
        }
        let placed = Placed {
            map: geom::translate(bb.0, bb.1),
            w: bb.2 - bb.0,
            h: bb.3 - bb.1,
        };
        let Some(gx) = ctx.space.xfrm_of(&placed) else {
            self.note(&name, "its group cannot hold it; not exported");
            return String::new();
        };
        let gx = Xfrm {
            ch_off: Some(gx.off),
            ch_ext: Some(gx.ext),
            ..gx
        };
        let inner = Ctx {
            space: ctx.space.child(&gx),
            fx_cur: fx,
            fx_base: IDENTITY,
        };
        let mut kids = String::new();
        for ch in &c.children {
            kids.push_str(&self.generate(ch, &inner));
        }
        let id = self.fresh_id();
        format!(
            r#"<p:grpSp><p:nvGrpSpPr><p:cNvPr id="{id}" name="{}"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr>{}</p:grpSpPr>{kids}</p:grpSp>"#,
            esc(&name),
            geom::xfrm_xml("a", &gx)
        )
    }

    fn generate_elem(&self, e: &Elem, c: &NShape, ctx: &Ctx) -> Result<String, String> {
        let m = geom::mul(&ctx.fx_cur, &e.transform());
        // A live preset is placed by its box (slide ADR 717), which its
        // outline need not fill (a callout's tip, an arc).
        let placed = match live_box(&c.label, e) {
            Some((w, h)) => Placed::normalised(m, w, h),
            None => {
                let (l, t, r, b) = bbox(e);
                Placed::normalised(geom::mul(&m, &geom::translate(l, t)), r - l, b - t)
            }
        }
        .ok_or("it is skewed, which DrawingML cannot place")?;
        let xf = ctx
            .space
            .xfrm_of(&placed)
            .ok_or("its group cannot hold it")?;
        let id = self.fresh_id();
        let name = c.name.clone().unwrap_or_else(|| match e.kind {
            Kind::TextFrame => format!("TextBox {}", id - 1),
            Kind::Rectangle if image_bytes(e).is_some() => format!("Picture {}", id - 1),
            Kind::Line => format!("Straight Connector {}", id - 1),
            _ => format!("Shape {}", id - 1),
        });
        let link = c
            .label
            .link
            .as_ref()
            .and_then(|l| self.shape_link(l))
            .unwrap_or_default();
        let cnv = if link.is_empty() {
            format!(r#"<p:cNvPr id="{id}" name="{}"/>"#, esc(&name))
        } else {
            format!(
                r#"<p:cNvPr id="{id}" name="{}">{link}</p:cNvPr>"#,
                esc(&name)
            )
        };
        let xfrm = geom::xfrm_xml("a", &xf);
        match e.kind {
            Kind::Rectangle if image_bytes(e).is_some() => {
                let bytes = image_bytes(e).unwrap_or_default();
                let rid = self.add_image(&bytes)?;
                let crop = crop_of(e)
                    .filter(|c| c.iter().any(|v| v.abs() > 0.001))
                    .map(|c| {
                        format!(
                            r#"<a:srcRect l="{}" t="{}" r="{}" b="{}"/>"#,
                            (c[0] * 100_000.0).round() as i64,
                            (c[1] * 100_000.0).round() as i64,
                            (c[2] * 100_000.0).round() as i64,
                            (c[3] * 100_000.0).round() as i64
                        )
                    })
                    .unwrap_or_default();
                Ok(format!(
                    r#"<p:pic><p:nvPicPr>{cnv}<p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="{rid}"/>{crop}<a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>{xfrm}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>{}</p:spPr></p:pic>"#,
                    self.line_of(e)
                ))
            }
            Kind::Line => {
                let pts = e.anchors();
                let (mut x2, mut y2) = (0.0, 0.0);
                let flip_v = match (pts.first(), pts.last()) {
                    (Some(a), Some(z)) => {
                        let p0 = geom::apply(&m, a[0]);
                        let p1 = geom::apply(&m, z[0]);
                        x2 = p1.0 - p0.0;
                        y2 = p1.1 - p0.1;
                        (x2 >= 0.0) != (y2 >= 0.0)
                    }
                    _ => false,
                };
                let _ = (x2, y2);
                let xf = Xfrm { flip_v, ..xf };
                Ok(format!(
                    r#"<p:cxnSp><p:nvCxnSpPr>{cnv}<p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr><p:spPr>{}<a:prstGeom prst="line"><a:avLst/></a:prstGeom>{}</p:spPr></p:cxnSp>"#,
                    geom::xfrm_xml("a", &xf),
                    self.line_of(e)
                ))
            }
            Kind::TextFrame => {
                let story = e
                    .story()
                    .and_then(|s| native::story(self.sh.cur, &s))
                    .unwrap_or(&[]);
                let defaults = self.defaults(None);
                let paras = self.paragraphs(story, &defaults, None, &name);
                let ins =
                    e.v.get("inset_spacing")
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default();
                let g = |i: usize| {
                    ins.get(i).and_then(Value::as_f64).unwrap_or(match i {
                        0 | 2 => 3.6,
                        _ => 7.2,
                    })
                };
                let anchor = match e.s("vertical_justification").as_deref() {
                    Some("Center") | Some("CenterAlign") => "ctr",
                    Some("Bottom") | Some("BottomAlign") => "b",
                    _ => "t",
                };
                Ok(format!(
                    r#"<p:sp><p:nvSpPr>{cnv}<p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr>{xfrm}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>{}</p:spPr><p:txBody><a:bodyPr wrap="square" lIns="{}" tIns="{}" rIns="{}" bIns="{}" rtlCol="0" anchor="{anchor}"><a:spAutoFit/></a:bodyPr><a:lstStyle/>{paras}</p:txBody></p:sp>"#,
                    self.fill_of(e),
                    emu(g(1)),
                    emu(g(0)),
                    emu(g(3)),
                    emu(g(2))
                ))
            }
            _ => {
                let geom_xml = match (&c.label.preset, e.kind) {
                    (Some((prst, adj)), Kind::Polygon) => preset_xml(prst, adj),
                    (_, Kind::Oval) => preset_xml("ellipse", &[]),
                    (_, Kind::Rectangle) => preset_xml("rect", &[]),
                    _ if is_plain_box(e) => preset_xml("rect", &[]),
                    _ => self.cust_geom(
                        e,
                        &placed,
                        &Ctx {
                            fx_cur: ctx.fx_cur,
                            ..*ctx
                        },
                    )?,
                };
                Ok(format!(
                    r#"<p:sp><p:nvSpPr>{cnv}<p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>{xfrm}{geom_xml}{}{}</p:spPr><p:txBody><a:bodyPr rtlCol="0" anchor="ctr"/><a:lstStyle/><a:p><a:endParaRPr lang="{}" dirty="0"/></a:p></p:txBody></p:sp>"#,
                    self.fill_of(e),
                    self.line_of(e),
                    esc(&self.lang)
                ))
            }
        }
    }
}

/// The elements of a shape at import paired with the document's, by kind
/// in order: `None` for one the document deleted. An element of a kind the
/// shape did not have is an error (the shape changed what it is).
fn pairs<'s>(b: &'s NShape, c: &'s NShape) -> Result<Vec<(&'s Elem, Option<&'s Elem>)>, String> {
    let mut used = vec![false; c.elems.len()];
    let mut out = Vec::new();
    for eb in &b.elems {
        let m = c
            .elems
            .iter()
            .enumerate()
            .find(|(i, ec)| !used[*i] && ec.kind == eb.kind)
            .map(|(i, ec)| {
                used[i] = true;
                ec
            });
        out.push((eb, m));
    }
    if used.iter().any(|u| !u) {
        return Err("its items changed kind".into());
    }
    Ok(out)
}

/// The box of a live preset element (slide ADR 717): its label names a
/// preset and the box it was drawn for, and its anchors are still that
/// preset drawn for that box (not reshaped by hand since).
fn live_box(label: &native::Label, e: &Elem) -> Option<(f64, f64)> {
    let ((prst, adj), (w, h)) = (label.preset.as_ref()?, label.size?);
    if e.kind != Kind::Polygon {
        return None;
    }
    let anchors: Vec<slide_geom::live::Anchor> = e.anchors().into_iter().collect();
    let (starts, _) = e.contours();
    // Only the element's own anchors count here; a scale in its transform
    // is moved into the box when it is placed.
    matches!(
        slide_geom::live::refit_preset(prst, adj, w, h, &anchors, &starts, &IDENTITY),
        Some(slide_geom::live::Refit::Same)
    )
    .then_some((w, h))
}

fn preset_xml(prst: &str, adj: &[(String, String)]) -> String {
    let gds: String = adj
        .iter()
        .map(|(n, f)| format!(r#"<a:gd name="{}" fmla="{}"/>"#, esc(n), esc(f)))
        .collect();
    if gds.is_empty() {
        format!(
            r#"<a:prstGeom prst="{}"><a:avLst/></a:prstGeom>"#,
            esc(prst)
        )
    } else {
        format!(
            r#"<a:prstGeom prst="{}"><a:avLst>{gds}</a:avLst></a:prstGeom>"#,
            esc(prst)
        )
    }
}

/// One closed contour of four sharp corners on two x and two y values.
fn is_plain_box(e: &Elem) -> bool {
    let a = e.anchors();
    let (starts, open) = e.contours();
    if a.len() != 4 || starts.len() > 1 || open.iter().any(|&o| o) {
        return false;
    }
    let sharp = a.iter().all(|p| p[0] == p[1] && p[0] == p[2]);
    let mut xs: Vec<f64> = a.iter().map(|p| p[0].0).collect();
    let mut ys: Vec<f64> = a.iter().map(|p| p[0].1).collect();
    xs.sort_by(f64::total_cmp);
    ys.sort_by(f64::total_cmp);
    let eq = |a: f64, b: f64| (a - b).abs() < 1e-3;
    sharp && eq(xs[0], xs[1]) && eq(xs[2], xs[3]) && eq(ys[0], ys[1]) && eq(ys[2], ys[3])
}

fn with_ch(x: &Xfrm, from: Option<&Xfrm>) -> Xfrm {
    Xfrm {
        ch_off: from.and_then(|f| f.ch_off),
        ch_ext: from.and_then(|f| f.ch_ext),
        ..x.clone()
    }
}

/// An element's image bytes (base64 in the model value).
fn image_bytes(e: &Elem) -> Option<Vec<u8>> {
    use base64::Engine;
    let v = e.v.get("image_bytes")?;
    match v {
        Value::String(s) => base64::engine::general_purpose::STANDARD.decode(s).ok(),
        Value::Array(a) => a.iter().map(|x| x.as_u64().map(|u| u as u8)).collect(),
        _ => None,
    }
    .filter(|b: &Vec<u8>| !b.is_empty())
}

fn image_ext(b: &[u8]) -> Option<&'static str> {
    if b.starts_with(b"\x89PNG") {
        Some("png")
    } else if b.starts_with(&[0xff, 0xd8]) {
        Some("jpeg")
    } else if b.starts_with(b"GIF8") {
        Some("gif")
    } else {
        None
    }
}

/// Pixel size of a PNG, JPEG or GIF.
fn image_size(b: &[u8]) -> Option<(u32, u32)> {
    if b.len() > 24 && b.starts_with(b"\x89PNG") {
        let w = u32::from_be_bytes(b[16..20].try_into().ok()?);
        let h = u32::from_be_bytes(b[20..24].try_into().ok()?);
        return Some((w, h));
    }
    if b.len() > 10 && b.starts_with(b"GIF8") {
        return Some((
            u16::from_le_bytes([b[6], b[7]]) as u32,
            u16::from_le_bytes([b[8], b[9]]) as u32,
        ));
    }
    if b.len() > 4 && b[0] == 0xff && b[1] == 0xd8 {
        let mut i = 2;
        while i + 9 < b.len() {
            if b[i] != 0xff {
                i += 1;
                continue;
            }
            let marker = b[i + 1];
            let len = u16::from_be_bytes([b[i + 2], b[i + 3]]) as usize;
            if (0xc0..=0xcf).contains(&marker) && !matches!(marker, 0xc4 | 0xc8 | 0xcc) {
                let h = u16::from_be_bytes([b[i + 5], b[i + 6]]) as u32;
                let w = u16::from_be_bytes([b[i + 7], b[i + 8]]) as u32;
                return Some((w, h));
            }
            i += 2 + len;
        }
    }
    None
}

/// A picture frame's crop (l, t, r, b as fractions of the image).
fn crop_of(e: &Elem) -> Option<[f64; 4]> {
    let m = native::arr6(e.v.get("image_item_transform"))?;
    let (pw, ph) = image_size(&image_bytes(e)?)?;
    let (l, t, r, b) = e.bounds();
    let dw = m[0] * pw as f64;
    let dh = m[3] * ph as f64;
    if dw.abs() < 1e-9 || dh.abs() < 1e-9 {
        return None;
    }
    let cl = (l - m[4]) / dw;
    let ct = (t - m[5]) / dh;
    Some([cl, ct, 1.0 - cl - (r - l) / dw, 1.0 - ct - (b - t) / dh])
}

/// The shape element with its `cNvPr id` replaced.
fn set_shape_id(x: &str, id: u32) -> String {
    if let Some(i) = x.find("<p:cNvPr ") {
        let e = x[i..].find('>').map(|e| i + e + 1).unwrap_or(x.len());
        let tag = xml::set_attr(&x[i..e], "id", Some(&id.to_string()));
        return xml::splice(x, i, e, &tag);
    }
    x.to_string()
}

/// Replace (or insert, or remove) a child of `spPr` of the shape element
/// `x`: the first child named one of `names`; a new one goes after the last
/// child named in `after` (first when none).
fn set_sppr(x: &str, names: &[&str], new: Option<&str>, after: &[&str]) -> Result<String, String> {
    set_child(x, &["p:spPr"], names, new, after)
}

fn set_child(
    x: &str,
    path: &[&str],
    names: &[&str],
    new: Option<&str>,
    after: &[&str],
) -> Result<String, String> {
    let root = xml::root(x).ok_or("unreadable shape")?;
    let parent = root
        .path(x, path)
        .ok_or_else(|| format!("no {}", path.join("/")))?;
    // An empty element is opened up first.
    if parent.inner.0 == parent.inner.1 && parent.inner.1 == parent.end {
        let open = parent.text(x);
        let name = &parent.name;
        let expanded = format!("{}></{name}>", open.trim_end_matches("/>").trim_end());
        let x2 = xml::splice(x, parent.start, parent.end, &expanded);
        return set_child(&x2, path, names, new, after);
    }
    let kids = parent.children(x);
    if let Some(k) = kids.iter().find(|k| names.contains(&k.name.as_str())) {
        return Ok(xml::splice(x, k.start, k.end, new.unwrap_or("")));
    }
    let Some(new) = new else {
        return Ok(x.to_string());
    };
    let at = kids
        .iter()
        .filter(|k| after.contains(&k.name.as_str()))
        .map(|k| k.end)
        .max()
        .unwrap_or(parent.inner.0);
    Ok(xml::splice(x, at, at, new))
}

/// Set attribute `attr` of the `n`-th `name` child of the element at
/// `path`.
fn set_nth_attr(
    x: &str,
    path: &[&str],
    name: &str,
    n: usize,
    attr: &str,
    value: &str,
) -> Result<String, String> {
    let root = xml::root(x).ok_or("unreadable shape")?;
    let parent = root.path(x, path).ok_or("no such element")?;
    let el = parent
        .children(x)
        .into_iter()
        .filter(|e| e.name == name)
        .nth(n)
        .ok_or("no such element")?;
    let open = el.open(x);
    let tag = xml::set_attr(open, attr, Some(value));
    Ok(xml::splice(x, el.start, el.start + open.len(), &tag))
}

/// A graphic frame's `p:xfrm`.
fn set_frame_xfrm(x: &str, nx: &Xfrm) -> Result<String, String> {
    let root = xml::root(x).ok_or("unreadable frame")?;
    let xf = root
        .child(x, "p:xfrm")
        .ok_or("the frame has no placement")?;
    Ok(xml::splice(
        x,
        xf.start,
        xf.end,
        &geom::xfrm_xml("p", &with_ch(nx, None)),
    ))
}

/// The written part's directory for its relationships.
pub fn rels_for(part: &str, rels: Relationships) -> Rels {
    Rels {
        rels,
        dir: part_dir(part).to_string(),
        changed: false,
    }
}

/// Drop `a:hlinkClick` elements that use relationship `rid`.
pub fn drop_links(xml: &str, rid: &str) -> String {
    let mut out = xml.to_string();
    let needle = format!(r#"r:id="{rid}""#);
    let find = |out: &str| -> Option<usize> {
        let mut at = 0;
        while let Some(j) = out[at..].find("<a:hlinkClick") {
            let s = at + j;
            let e = out[s..].find('>').map(|e| s + e + 1)?;
            if out[s..e].contains(&needle) {
                return Some(s);
            }
            at = e;
        }
        None
    };
    while let Some(i) = find(&out) {
        let e = out[i..].find('>').map(|e| i + e + 1).unwrap_or(out.len());
        let end = if out[i..e].ends_with("/>") {
            e
        } else {
            out[e..]
                .find("</a:hlinkClick>")
                .map(|j| e + j + "</a:hlinkClick>".len())
                .unwrap_or(e)
        };
        out.replace_range(i..end, "");
    }
    out
}
