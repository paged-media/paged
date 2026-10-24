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

//! Note (legacy comment) authoring: `xl/commentsN.xml` plus the VML shape
//! Excel draws each note with.
//!
//! A note is two things in a package: a `<comment ref authorId>` in the
//! sheet's comments part and a `v:shape` with `<x:ClientData
//! ObjectType="Note">` (its row and column) in the sheet's legacy VML
//! drawing, which the worksheet names with `<legacyDrawing r:id>`. Excel
//! repairs a workbook whose comment has no shape, so a write keeps the two in
//! step: a new note adds both (creating the parts, their relationships and
//! content types when the sheet has none), a delete takes both out (and the
//! parts when nothing is left in them). Everything else keeps its content:
//! other comments with their rich text and attributes (the comments part is
//! re-serialized), other VML shapes such as form controls (the VML part is
//! spliced, so they keep their bytes).
//!
//! Threaded comments (`xl/threadedComments/*`) stay preserved, never
//! rewritten: Excel keeps a legacy note for each thread, so the note of a
//! cell that carries a thread is refused here rather than desynchronised.

use crate::error::XlsxError;
use crate::links::NS_REL;
use crate::rels::{part_dir, rels_part_name, resolve_target, REL_COMMENTS};
use crate::xtree::XNode;
use crate::XlsxDocument;
use sheet_core::SheetId;

pub const REL_COMMENTS_FULL: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments";
pub const REL_VML_FULL: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/vmlDrawing";
/// A worksheet → threaded-comments relationship type suffix.
pub const REL_THREADED: &str = "/threadedComment";
pub const CT_COMMENTS: &str =
    "application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml";
pub const CT_VML: &str = "application/vnd.openxmlformats-officedocument.vmlDrawing";
const NS_MAIN: &str = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";

fn a1(row: u32, col: u32) -> String {
    sheet_core::format_a1(row, col, false, false).to_string()
}

/// One VML note shape for `(row, col)` with shape number `n`.
fn note_shape(n: u32, row: u32, col: u32) -> String {
    format!(
        concat!(
            r##"<v:shape id="_x0000_s{n}" type="#_x0000_t202" style='position:absolute;"##,
            r##"margin-left:59.25pt;margin-top:1.5pt;width:108pt;height:59.25pt;z-index:1;"##,
            r##"visibility:hidden' fillcolor="#ffffe1" o:insetmode="auto">"##,
            r##"<v:fill color2="#ffffe1"/><v:shadow on="t" color="black" obscured="t"/>"##,
            r##"<v:path o:connecttype="none"/><v:textbox style='mso-direction-alt:auto'>"##,
            r##"<div style='text-align:left'></div></v:textbox>"##,
            r##"<x:ClientData ObjectType="Note"><x:MoveWithCells/><x:SizeWithCells/>"##,
            r##"<x:Anchor>{c1}, 15, {r0}, 10, {c3}, 15, {r4}, 4</x:Anchor>"##,
            r##"<x:AutoFill>False</x:AutoFill><x:Row>{row}</x:Row><x:Column>{col}</x:Column>"##,
            r##"</x:ClientData></v:shape>"##
        ),
        n = n,
        c1 = col + 1,
        r0 = row,
        c3 = col + 3,
        r4 = row + 4,
        row = row,
        col = col
    )
}

/// A new legacy drawing holding one block of shape numbers (`idmap`).
fn new_vml(idmap: u32) -> String {
    format!(
        concat!(
            r#"<xml xmlns:v="urn:schemas-microsoft-com:vml" "#,
            r#"xmlns:o="urn:schemas-microsoft-com:office:office" "#,
            r#"xmlns:x="urn:schemas-microsoft-com:office:excel">"#,
            r#"<o:shapelayout v:ext="edit"><o:idmap v:ext="edit" data="{idmap}"/></o:shapelayout>"#,
            r#"<v:shapetype id="_x0000_t202" coordsize="21600,21600" o:spt="202" "#,
            r#"path="m,l,21600r21600,l21600,xe"><v:stroke joinstyle="miter"/>"#,
            r#"<v:path gradientshapeok="t" o:connecttype="rect"/></v:shapetype></xml>"#
        ),
        idmap = idmap
    )
}

/// The byte spans of the `<v:shape …>…</v:shape>` elements of a VML part.
fn shape_spans(vml: &str) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let mut at = 0;
    while let Some(i) = vml[at..].find("<v:shape ") {
        let s = at + i;
        let Some(j) = vml[s..].find("</v:shape>") else {
            break;
        };
        let e = s + j + "</v:shape>".len();
        out.push((s, e));
        at = e;
    }
    out
}

fn tag_value<'a>(s: &'a str, tag: &str) -> Option<&'a str> {
    let open = format!("<x:{tag}>");
    let i = s.find(&open)? + open.len();
    let j = s[i..].find("</x:")?;
    Some(s[i..i + j].trim())
}

/// The span of the note shape anchored at `(row, col)`.
fn note_span(vml: &str, row: u32, col: u32) -> Option<(usize, usize)> {
    shape_spans(vml).into_iter().find(|&(s, e)| {
        let sh = &vml[s..e];
        sh.contains("ObjectType=\"Note\"")
            && tag_value(sh, "Row").and_then(|v| v.parse().ok()) == Some(row)
            && tag_value(sh, "Column").and_then(|v| v.parse().ok()) == Some(col)
    })
}

/// The largest `_x0000_sN` shape number and `idmap` block in a VML part.
fn vml_numbers(vml: &str) -> (u32, u32) {
    let mut max_s = 0;
    let mut at = 0;
    while let Some(i) = vml[at..].find("_x0000_s") {
        let s = at + i + "_x0000_s".len();
        let digits: String = vml[s..].chars().take_while(char::is_ascii_digit).collect();
        if let Ok(n) = digits.parse::<u32>() {
            max_s = max_s.max(n);
        }
        at = s;
    }
    let mut max_map = 0;
    if let Some(i) = vml.find("<o:idmap") {
        if let Some(j) = vml[i..].find("data=\"") {
            let s = i + j + 6;
            if let Some(k) = vml[s..].find('"') {
                for d in vml[s..s + k].split(',') {
                    if let Ok(n) = d.trim().parse::<u32>() {
                        max_map = max_map.max(n);
                    }
                }
            }
        }
    }
    (max_s, max_map)
}

impl XlsxDocument {
    /// The comments part of a sheet, if it has one.
    fn comments_part_of(&self, sheet: SheetId) -> Option<String> {
        let ws = self.part_name_of(sheet)?;
        let rels = self.rels_of_part(ws)?;
        let rel = rels.by_type_suffix(REL_COMMENTS)?;
        Some(resolve_target(part_dir(ws), &rel.target))
    }

    /// The legacy VML drawing of a sheet (its `<legacyDrawing r:id>`), with
    /// the relationship id.
    fn vml_part_of(&self, sheet: SheetId) -> Option<(String, String)> {
        let ws = self.part_name_of(sheet)?;
        let node = XNode::parse(self.ws_child(sheet, "legacyDrawing")?).ok()?;
        let rid = node.attr("id")?;
        let rels = self.rels_of_part(ws)?;
        let rel = rels.items.iter().find(|r| r.id == rid)?;
        Some((resolve_target(part_dir(ws), &rel.target), rid))
    }

    /// The cells of a sheet that carry a threaded comment.
    pub fn threaded_comment_cells(&self, sheet: SheetId) -> Vec<(u32, u32)> {
        let Some(ws) = self.part_name_of(sheet) else {
            return Vec::new();
        };
        let Some(rels) = self.rels_of_part(ws) else {
            return Vec::new();
        };
        let mut out = Vec::new();
        for rel in rels.items.iter().filter(|r| r.is_type(REL_THREADED)) {
            let part = resolve_target(part_dir(ws), &rel.target);
            let Some(node) = self.part_bytes(&part).and_then(|b| XNode::parse(&b).ok()) else {
                continue;
            };
            for c in node.children_named("threadedComment") {
                if let Some((r, col, _, _)) = c.attr("ref").and_then(|s| sheet_core::parse_a1(&s)) {
                    if !out.contains(&(r, col)) {
                        out.push((r, col));
                    }
                }
            }
        }
        out
    }

    fn refuse_threaded(&self, sheet: SheetId, row: u32, col: u32) -> Result<(), XlsxError> {
        if self.threaded_comment_cells(sheet).contains(&(row, col)) {
            return Err(XlsxError::Structure(format!(
                "{} carries a threaded comment; its note is kept as it is",
                a1(row, col)
            )));
        }
        Ok(())
    }

    /// Set the note of a cell (adding it, or replacing its text and author).
    pub fn set_note(
        &mut self,
        sheet: SheetId,
        row: u32,
        col: u32,
        author: &str,
        text: &str,
    ) -> Result<(), XlsxError> {
        self.refuse_threaded(sheet, row, col)?;
        let ws = self.ws_part_of(sheet)?;
        // The comments part.
        let part = match self.comments_part_of(sheet) {
            Some(p) => p,
            None => {
                let mut n = 1;
                let part = loop {
                    let cand = format!("xl/comments{n}.xml");
                    if self.container.part(&cand).is_none() {
                        break cand;
                    }
                    n += 1;
                };
                let body = format!(
                    r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<comments xmlns="{NS_MAIN}"><authors/><commentList/></comments>"#
                );
                self.container.parts.push(crate::opc::PartEntry::Opaque {
                    name: part.clone(),
                    bytes: body.into_bytes(),
                });
                self.add_override(&part, CT_COMMENTS)?;
                let target = format!("../comments{n}.xml");
                self.add_part_rel(&ws, REL_COMMENTS_FULL, &target, false)?;
                part
            }
        };
        let raw = self
            .part_bytes(&part)
            .ok_or_else(|| XlsxError::Structure(format!("{part} is missing")))?;
        let mut root = XNode::parse(&raw)?;
        let p = root.prefix().to_string();
        if root.child("authors").is_none() {
            root.children.insert(0, XNode::new(format!("{p}authors")));
        }
        let authors = root.child_mut("authors").expect("just ensured");
        let found = authors
            .children_named("author")
            .position(|a| a.text.as_deref().unwrap_or("") == author);
        let author_id = match found {
            Some(i) => i,
            None => {
                authors
                    .children
                    .push(XNode::new(format!("{p}author")).with_text(author));
                authors.children_named("author").count() - 1
            }
        };
        if root.child("commentList").is_none() {
            let at = root
                .children
                .iter()
                .position(|c| c.local() == "authors")
                .map_or(0, |i| i + 1);
            root.children
                .insert(at, XNode::new(format!("{p}commentList")));
        }
        let list = root.child_mut("commentList").expect("just ensured");
        let reference = a1(row, col);
        let body = XNode::new(format!("{p}text")).with_child(
            XNode::new(format!("{p}t"))
                .with_attr("xml:space", "preserve")
                .with_text(text),
        );
        match list
            .children
            .iter_mut()
            .find(|c| c.local() == "comment" && c.attr("ref").as_deref() == Some(&reference))
        {
            Some(c) => {
                c.set("authorId", Some(author_id.to_string()));
                c.children.retain(|k| k.local() != "text");
                c.children.insert(0, body);
            }
            None => {
                // Keep the list in cell order (row-major), as Excel writes it.
                let at = list
                    .children
                    .iter()
                    .position(|c| {
                        c.attr("ref")
                            .and_then(|s| sheet_core::parse_a1(&s))
                            .is_some_and(|(r, cc, _, _)| (r, cc) > (row, col))
                    })
                    .unwrap_or(list.children.len());
                list.children.insert(
                    at,
                    XNode::new(format!("{p}comment"))
                        .with_attr("ref", reference)
                        .with_attr("authorId", author_id.to_string())
                        .with_child(body),
                );
            }
        }
        let xml = format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n{}",
            root.to_xml()
        );
        self.set_part_bytes(&part, xml.into_bytes());
        // The shape.
        self.ensure_note_shape(sheet, &ws, row, col)?;
        self.refresh_comments(sheet, &part);
        self.container.dirty = true;
        Ok(())
    }

    fn ensure_note_shape(
        &mut self,
        sheet: SheetId,
        ws: &str,
        row: u32,
        col: u32,
    ) -> Result<(), XlsxError> {
        let (vml_part, mut vml) = match self.vml_part_of(sheet) {
            Some((p, _)) => {
                let v = self
                    .part_bytes(&p)
                    .map(|b| String::from_utf8_lossy(&b).into_owned())
                    .unwrap_or_default();
                (p, v)
            }
            None => {
                // A new drawing takes the next free block of shape numbers
                // across the workbook's legacy drawings.
                let mut block = 0;
                let mut n = 1;
                for p in &self.container.parts {
                    if p.name().ends_with(".vml") {
                        let (_, m) = vml_numbers(&String::from_utf8_lossy(p.bytes()));
                        block = block.max(m);
                    }
                }
                let part = loop {
                    let cand = format!("xl/drawings/vmlDrawing{n}.vml");
                    if self.container.part(&cand).is_none() {
                        break cand;
                    }
                    n += 1;
                };
                self.ensure_default_ext("vml", CT_VML)?;
                let target = format!("../drawings/vmlDrawing{n}.vml");
                let rid = self.add_part_rel(ws, REL_VML_FULL, &target, false)?;
                let mut el = XNode::new(format!("{}legacyDrawing", self.ws_prefix(sheet)))
                    .with_attr("r:id", rid);
                if !self.ws_declares_r(sheet) {
                    el = el.with_attr("xmlns:r", NS_REL);
                }
                self.set_ws_child(sheet, "legacyDrawing", Some(el.to_xml().into_bytes()))?;
                let v = new_vml(block + 1);
                self.container.parts.push(crate::opc::PartEntry::Opaque {
                    name: part.clone(),
                    bytes: v.clone().into_bytes(),
                });
                (part, v)
            }
        };
        if note_span(&vml, row, col).is_some() {
            return Ok(());
        }
        let (max_s, block) = vml_numbers(&vml);
        let n = max_s.max(block.max(1) * 1024) + 1;
        let close = vml.rfind("</xml>").unwrap_or(vml.len());
        vml.insert_str(close, &note_shape(n, row, col));
        self.set_part_bytes(&vml_part, vml.into_bytes());
        Ok(())
    }

    /// Take the note of a cell out; `false` when it has none.
    pub fn delete_note(&mut self, sheet: SheetId, row: u32, col: u32) -> Result<bool, XlsxError> {
        self.refuse_threaded(sheet, row, col)?;
        let Some(part) = self.comments_part_of(sheet) else {
            return Ok(false);
        };
        let ws = self.ws_part_of(sheet)?;
        let raw = self.part_bytes(&part).unwrap_or_default();
        let mut root = XNode::parse(&raw)?;
        let reference = a1(row, col);
        let Some(list) = root.child_mut("commentList") else {
            return Ok(false);
        };
        let before = list.children.len();
        list.children
            .retain(|c| !(c.local() == "comment" && c.attr("ref").as_deref() == Some(&reference)));
        if list.children.len() == before {
            return Ok(false);
        }
        let empty = list.children.is_empty();
        let ws_rels = rels_part_name(&ws);
        if empty {
            // The part goes, with its relationship and content type.
            self.container.parts.retain(|p| p.name() != part);
            self.remove_override(&part)?;
            if let Some(rels) = self.rels_of_part(&ws) {
                if let Some(rel) = rels.by_type_suffix(REL_COMMENTS) {
                    let id = rel.id.clone();
                    self.remove_rel(&ws_rels, &id)?;
                }
            }
            self.comments.remove(&sheet);
        } else {
            let xml = format!(
                "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n{}",
                root.to_xml()
            );
            self.set_part_bytes(&part, xml.into_bytes());
            self.refresh_comments(sheet, &part);
        }
        if let Some((vml_part, rid)) = self.vml_part_of(sheet) {
            let mut vml = self
                .part_bytes(&vml_part)
                .map(|b| String::from_utf8_lossy(&b).into_owned())
                .unwrap_or_default();
            if let Some((s, e)) = note_span(&vml, row, col) {
                vml.replace_range(s..e, "");
            }
            if shape_spans(&vml).is_empty() {
                self.container.parts.retain(|p| p.name() != vml_part);
                self.remove_rel(&ws_rels, &rid)?;
                self.set_ws_child(sheet, "legacyDrawing", None)?;
            } else {
                self.set_part_bytes(&vml_part, vml.into_bytes());
            }
        }
        self.container.dirty = true;
        Ok(true)
    }

    fn refresh_comments(&mut self, sheet: SheetId, part: &str) {
        if let Some(parsed) = self
            .part_bytes(part)
            .and_then(|b| crate::parts::comments::parse(&b).ok())
        {
            if parsed.is_empty() {
                self.comments.remove(&sheet);
            } else {
                self.comments.insert(sheet, parsed);
            }
        }
    }

    /// Add a `[Content_Types]` default for an extension the package lacks.
    pub(crate) fn ensure_default_ext(&mut self, ext: &str, ct: &str) -> Result<(), XlsxError> {
        if self
            .container
            .content_types
            .defaults
            .iter()
            .any(|(e, _)| e.eq_ignore_ascii_case(ext))
        {
            return Ok(());
        }
        self.container
            .content_types
            .defaults
            .push((ext.to_string(), ct.to_string()));
        if let Some(raw) = self.part_bytes(crate::opc::CONTENT_TYPES_PART) {
            let (_, close) = crate::splice::root_children(&raw)?;
            let tag = crate::splice::render_tag(
                "Default",
                &[
                    ("Extension".into(), ext.into()),
                    ("ContentType".into(), ct.into()),
                ],
                true,
            );
            self.set_part_bytes(
                crate::opc::CONTENT_TYPES_PART,
                crate::splice::splice(&raw, close, close, tag.as_bytes()),
            );
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vml_shapes_are_found_by_cell_and_numbered_past_the_block() {
        let mut v = new_vml(2);
        let close = v.rfind("</xml>").unwrap();
        v.insert_str(close, &note_shape(2049, 3, 1));
        assert!(note_span(&v, 3, 1).is_some());
        assert!(note_span(&v, 1, 3).is_none());
        assert_eq!(vml_numbers(&v), (2049, 2));
        assert_eq!(shape_spans(&v).len(), 1);
    }
}
