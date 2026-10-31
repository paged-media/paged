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

//! Slide masters and layouts written back (slide ADR 712). Import made one
//! master spread per slide master and one per layout; what the document
//! changed of them is written, and nothing else:
//!
//! * a renamed spread gets its `p:cSld name`, a changed Preserve flag its
//!   root's `preserve`;
//! * its shapes and placeholders go through the slide writer (ADR 711),
//!   as differences from what import made of them;
//! * a placeholder whose text style (size, bold, italic) changed gets it as
//!   its `a:lstStyle` level 1, which the slides that inherit it follow;
//! * a layout the document deleted is removed: its part, its
//!   relationships, its `p:sldLayoutId`, its master's relationship to it
//!   and its content type.
//!
//! A master or layout the document did not change keeps its bytes.

use std::collections::{BTreeMap, BTreeSet};

use paged_ooxml::opc::OpcPackage;
use paged_ooxml::rels::{part_dir, rels_part_name, resolve_target, Relationships};
use paged_scene::Document;
use slide_resolve::model::{Deck, MasterPage};

use crate::native;
use crate::slide::{self, Shared};
use crate::xml;

/// What writing the masters and layouts gave.
#[derive(Default)]
pub struct MastersOut {
    /// Parts written (masters, layouts and their relationship parts).
    pub parts: BTreeMap<String, Vec<u8>>,
    /// New parts with their content types (images, …).
    pub added: Vec<(String, &'static str)>,
    /// Image parts written.
    pub media: Vec<(String, Vec<u8>)>,
    /// Parts removed (a deleted layout and its relationship part).
    pub removed: BTreeSet<String>,
    /// What could not be written, one line each.
    pub lost: Vec<String>,
    /// What the package could not carry.
    pub diagnostics: Vec<String>,
}

fn rels(pkg: &OpcPackage, part: &str) -> Relationships {
    pkg.part(&rels_part_name(part))
        .map(Relationships::parse)
        .unwrap_or_default()
}

fn text(pkg: &OpcPackage, part: &str) -> Option<String> {
    pkg.part(part)
        .and_then(|b| String::from_utf8(b.to_vec()).ok())
}

/// The master label (`{master: {preserve}}`) of a master spread's page.
fn preserve_of(spread: &paged_model::Spread) -> bool {
    let Some(page) = spread.pages.first().and_then(|p| p.self_id.as_deref()) else {
        return false;
    };
    let v = native::page_state(spread, page);
    v.pointer("/master/preserve").and_then(|p| p.as_bool()) == Some(true)
}

/// Set the root element's `preserve` attribute.
fn set_preserve(part_xml: &str, preserve: bool) -> String {
    let Some(root) = xml::root(part_xml) else {
        return part_xml.to_string();
    };
    let open = root.open(part_xml);
    let tag = xml::set_attr(open, "preserve", preserve.then_some("1"));
    xml::splice(part_xml, root.start, root.start + open.len(), &tag)
}

/// Set `p:cSld`'s `name`.
fn set_name(part_xml: &str, name: &str) -> String {
    let Some(root) = xml::root(part_xml) else {
        return part_xml.to_string();
    };
    let Some(csld) = root.child(part_xml, "p:cSld") else {
        return part_xml.to_string();
    };
    let open = csld.open(part_xml);
    let tag = xml::set_attr(open, "name", Some(name));
    xml::splice(part_xml, csld.start, csld.start + open.len(), &tag)
}

/// The first run's size (pt) and font style of a placeholder's text, as a
/// spread holds it.
fn text_style(doc: &Document, shape: &native::NShape) -> Option<(Option<f32>, Option<String>)> {
    let frame = shape
        .elems
        .iter()
        .find(|e| matches!(e.kind, native::Kind::TextFrame))?;
    let story = frame.story()?;
    let paras = native::story(doc, &story)?;
    let run = paras.first()?.runs.first()?;
    Some((run.point_size, run.font_style.clone()))
}

/// The `a:defRPr` attributes of a text style: the size, and bold and
/// italic only when the run names its font style.
fn def_rpr_attrs(size: Option<f32>, style: Option<&str>) -> Vec<(&'static str, Option<String>)> {
    let flag = |on: bool| Some(if on { "1" } else { "0" }.to_string());
    let style = style.map(str::to_ascii_lowercase);
    vec![
        ("sz", size.map(|s| ((s * 100.0).round() as i64).to_string())),
        ("b", style.as_deref().and_then(|s| flag(s.contains("bold")))),
        (
            "i",
            style
                .as_deref()
                .and_then(|s| flag(s.contains("italic") || s.contains("oblique"))),
        ),
    ]
}

/// Write a placeholder's text style into the `a:lstStyle` of the shape
/// with `cNvPr id`: level 1's `a:defRPr` takes it.
pub fn set_level1_style(
    part_xml: &str,
    shape_id: u32,
    size: Option<f32>,
    style: Option<&str>,
) -> Option<String> {
    let root = xml::root(part_xml)?;
    let tree = root.path(part_xml, &["p:cSld", "p:spTree"])?;
    let sp = tree.children(part_xml).into_iter().find(|c| {
        c.name == "p:sp"
            && c.path(part_xml, &["p:nvSpPr", "p:cNvPr"])
                .and_then(|n| n.attr(part_xml, "id"))
                .and_then(|v| v.parse::<u32>().ok())
                == Some(shape_id)
    })?;
    let body = sp.child(part_xml, "p:txBody")?;
    let attrs = def_rpr_attrs(size, style);
    let def = |old: Option<&str>| -> String {
        let mut tag = old
            .map(str::to_string)
            .unwrap_or_else(|| "<a:defRPr/>".into());
        for (k, v) in &attrs {
            if v.is_some() {
                tag = xml::set_attr(&tag, k, v.as_deref());
            }
        }
        tag
    };
    match body.child(part_xml, "a:lstStyle") {
        Some(lst) => {
            let lvl = lst.child(part_xml, "a:lvl1pPr");
            match lvl {
                Some(l) => match l.child(part_xml, "a:defRPr") {
                    Some(d) => {
                        // The open tag only; its children (fills, fonts) stay.
                        let open = d.open(part_xml);
                        Some(xml::splice(
                            part_xml,
                            d.start,
                            d.start + open.len(),
                            &def(Some(open)),
                        ))
                    }
                    None => {
                        // `a:defRPr` follows the level's other children
                        // except `a:extLst`.
                        let at = l
                            .child(part_xml, "a:extLst")
                            .map(|e| e.start)
                            .unwrap_or(l.inner.1);
                        if l.inner.0 == l.inner.1 && l.inner.1 == l.end {
                            let open = l.open(part_xml);
                            let tag = format!(
                                "{}>{}</a:lvl1pPr>",
                                open.trim_end_matches("/>"),
                                def(None)
                            );
                            Some(xml::splice(part_xml, l.start, l.end, &tag))
                        } else {
                            Some(xml::splice(part_xml, at, at, &def(None)))
                        }
                    }
                },
                None => {
                    let tag = format!("<a:lvl1pPr>{}</a:lvl1pPr>", def(None));
                    if lst.inner.0 == lst.inner.1 && lst.inner.1 == lst.end {
                        Some(xml::splice(
                            part_xml,
                            lst.start,
                            lst.end,
                            &format!("<a:lstStyle>{tag}</a:lstStyle>"),
                        ))
                    } else {
                        // `a:defPPr` may come first; level 1 follows it.
                        let at = lst
                            .child(part_xml, "a:defPPr")
                            .map(|d| d.end)
                            .unwrap_or(lst.inner.0);
                        Some(xml::splice(part_xml, at, at, &tag))
                    }
                }
            }
        }
        None => {
            let after = body.child(part_xml, "a:bodyPr")?;
            Some(xml::splice(
                part_xml,
                after.end,
                after.end,
                &format!(
                    "<a:lstStyle><a:lvl1pPr>{}</a:lvl1pPr></a:lstStyle>",
                    def(None)
                ),
            ))
        }
    }
}

/// The part a master spread came from.
fn part_of(m: &MasterPage) -> &str {
    if m.is_master {
        &m.master_part
    } else {
        &m.layout_part
    }
}

/// Write what the document changed of the deck's masters and layouts.
/// `used` holds the layout parts the written slides use (a deleted layout
/// that a slide still names is kept).
#[allow(clippy::too_many_arguments)]
pub fn write(
    sh: &Shared<'_>,
    pkg: &OpcPackage,
    ir: &pptx_core::Presentation,
    deck: &Deck,
    base: &Document,
    cur: &Document,
    used: &BTreeSet<String>,
) -> MastersOut {
    let mut out = MastersOut::default();
    // Edited master and layout XML, by part (a layout deleted from its
    // master's list edits the master too).
    let mut edited: BTreeMap<String, (String, Relationships, bool)> = BTreeMap::new();
    let load = |edited: &mut BTreeMap<String, (String, Relationships, bool)>, part: &str| {
        if !edited.contains_key(part) {
            if let Some(x) = text(pkg, part) {
                edited.insert(part.to_string(), (x, rels(pkg, part), false));
            }
        }
    };
    for m in &deck.masters {
        let part = part_of(m).to_string();
        let Some(b) = base.master_spreads.get(&m.id) else {
            continue;
        };
        let Some(c) = cur.master_spreads.get(&m.id) else {
            // Deleted in the document.
            if m.is_master {
                out.lost.push(format!(
                    "{part}: deleting a slide master is not exported; it is kept"
                ));
                continue;
            }
            if used.contains(&part) {
                out.lost.push(format!(
                    "{part}: a slide still uses the deleted layout; it is kept"
                ));
                continue;
            }
            out.removed.insert(part.clone());
            out.removed.insert(rels_part_name(&part));
            load(&mut edited, &m.master_part);
            if let Some((mx, mr, changed)) = edited.get_mut(&m.master_part) {
                let dir = part_dir(&m.master_part).to_string();
                let rid = mr
                    .items
                    .iter()
                    .find(|r| resolve_target(&dir, &r.target) == part)
                    .map(|r| r.id.clone());
                if let Some(rid) = rid {
                    mr.items.retain(|r| r.id != rid);
                    // Its `p:sldLayoutId`.
                    if let Some(root) = xml::root(mx) {
                        if let Some(list) = root.child(mx, "p:sldLayoutIdLst") {
                            if let Some(entry) = list
                                .children(mx)
                                .into_iter()
                                .find(|e| e.attr(mx, "r:id").as_deref() == Some(rid.as_str()))
                            {
                                *mx = xml::splice(mx, entry.start, entry.end, "");
                            }
                        }
                    }
                    *changed = true;
                }
            }
            continue;
        };
        load(&mut edited, &part);
        let Some((px, pr, changed)) = edited.get_mut(&part) else {
            continue;
        };
        if c.name != b.name {
            *px = set_name(px, c.name.as_deref().unwrap_or(""));
            *changed = true;
        }
        if preserve_of(&c.spread) != preserve_of(&b.spread) {
            *px = set_preserve(px, preserve_of(&c.spread));
            *changed = true;
        }
        // The shapes: the slide writer, on the layout's (or master's) XML.
        let shapes: &[pptx_core::Shape] = if m.is_master {
            ir.master(&m.master_part)
                .map(|x| x.shapes.as_slice())
                .unwrap_or(&[])
        } else {
            ir.layout(&m.layout_part)
                .map(|x| x.shapes.as_slice())
                .unwrap_or(&[])
        };
        let probe_layout = if m.is_master {
            ir.master(&m.master_part)
                .and_then(|x| x.layouts.first().cloned())
        } else {
            Some(m.layout_part.clone())
        };
        let cur_shapes = native::page_shapes(&c.spread);
        let mut r = slide::rels_for(&part, pr.clone());
        let job = slide::Job {
            part: part.clone(),
            slide_no: 0,
            xml: px.clone(),
            shapes,
            items: &m.items,
            prefix: format!("{part}#"),
            base: Some(&b.spread),
            base_doc: base,
            cur: cur_shapes.clone(),
            layout: probe_layout,
        };
        match slide::write(sh, &job, &mut r) {
            Ok(Some(w)) => {
                *px = w.xml;
                *changed = true;
                out.media.extend(w.media);
                for (p, bytes, ct) in w.parts {
                    if let Some(ct) = ct {
                        out.added.push((p.clone(), ct));
                    }
                    out.parts.insert(p, bytes);
                }
                out.lost
                    .extend(w.lost.into_iter().map(|l| format!("{part}: {l}")));
                if r.changed {
                    *pr = r.rels;
                }
            }
            Ok(None) => {}
            Err(e) => out.lost.push(format!(
                "{part}: {e}; its shapes are written as the deck had them"
            )),
        }
        // Placeholder text styles: level 1 of the placeholder's list style.
        let base_shapes = native::page_shapes(&b.spread);
        let base_by = native::by_key(&base_shapes);
        for s in native::by_key(&cur_shapes).values() {
            if s.label.placeholder.is_none() {
                continue;
            }
            let Some(key) = s.key.as_deref() else {
                continue;
            };
            let Some(bs) = base_by.get(key) else { continue };
            let (Some(now), Some(was)) = (text_style(cur, s), text_style(base, bs)) else {
                continue;
            };
            if now == was {
                continue;
            }
            let Some(id) = key
                .rsplit('#')
                .next()
                .and_then(|p| p.rsplit('/').next())
                .and_then(|v| v.parse::<u32>().ok())
            else {
                continue;
            };
            match set_level1_style(px, id, now.0, now.1.as_deref()) {
                Some(x) => {
                    *px = x;
                    *changed = true;
                }
                None => out.lost.push(format!(
                    "{part}: the text style of placeholder {id} is not written"
                )),
            }
        }
    }
    for (part, (x, r, changed)) in edited {
        if !changed || out.removed.contains(&part) {
            continue;
        }
        if xml::root(&x).is_none() {
            out.diagnostics.push(format!(
                "{part}: the written part does not read; it is kept as it was"
            ));
            continue;
        }
        let rels_bytes = crate::write_rels_bytes(&r);
        if pkg.part(&rels_part_name(&part)).map(|b| b.to_vec()) != Some(rels_bytes.clone()) {
            out.parts.insert(rels_part_name(&part), rels_bytes);
        }
        out.parts.insert(part, x.into_bytes());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const LAYOUT: &str = r#"<?xml version="1.0"?><p:sldLayout xmlns:p="p" xmlns:a="a"><p:cSld name="Title Slide"><p:spTree><p:nvGrpSpPr/><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Title 1"/><p:cNvSpPr/><p:nvPr><p:ph type="ctrTitle"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>Click</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sldLayout>"#;

    #[test]
    fn a_placeholders_text_style_becomes_its_level_1_list_style() {
        let x = set_level1_style(LAYOUT, 2, Some(54.0), Some("Bold")).unwrap();
        assert!(
            x.contains(r#"<a:lstStyle><a:lvl1pPr><a:defRPr sz="5400" b="1" i="0"/></a:lvl1pPr></a:lstStyle>"#),
            "{x}"
        );
        // Again: the existing level's defaults are updated in place.
        let y = set_level1_style(&x, 2, Some(40.0), None).unwrap();
        // No font style named: bold and italic stay as they were.
        assert!(y.contains(r#"<a:defRPr sz="4000" b="1" i="0"/>"#), "{y}");
        assert_eq!(y.matches("<a:lvl1pPr").count(), 1, "{y}");
        assert!(set_level1_style(LAYOUT, 9, Some(40.0), None).is_none());
    }

    #[test]
    fn a_name_and_the_preserve_flag_are_set_on_their_elements() {
        let x = set_name(LAYOUT, "Big Title");
        assert!(x.contains(r#"<p:cSld name="Big Title">"#));
        let x = set_preserve(&x, true);
        assert!(
            x.contains(r#"<p:sldLayout xmlns:p="p" xmlns:a="a" preserve="1">"#),
            "{x}"
        );
        let x = set_preserve(&x, false);
        assert!(!x.contains("preserve"));
    }
}
