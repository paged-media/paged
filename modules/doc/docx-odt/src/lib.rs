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

//! # docx-odt — OpenDocument Text onto docx-core (doc ADR 616)
//!
//! An `.odt` (or `.ott` template) package read onto the model the `.docx`
//! importer produces, so it opens like a Word document. Read only: the
//! document is saved as a `.docx` afterwards (paged.doc writes one with
//! `docx_export::write_docx`), never back to OpenDocument. Behind a flag in
//! the bundle while it is new.
//!
//! What is read: `text:p` and `text:h` (a heading's outline level picks
//! Word's `heading N`), `text:span`, `text:a` links, `text:s` / `text:tab` /
//! `text:line-break`, bookmarks; named paragraph and character styles with
//! their parents, automatic styles as direct formatting, the default
//! paragraph style as the document defaults; bullet and numbered lists with
//! their levels and indents; tables with column widths, header rows and row
//! and column spans; `draw:image` pictures from `Pictures/` (inline); the
//! page size, margins and columns of the standard master page; sections
//! and index bodies as their paragraphs. What is not — notes, comments,
//! tracked changes, headers and footers, drawings, frames anchored to the
//! page — is named in [`OdtRead::diagnostics`].

use std::collections::HashMap;

use docx_core::{
    Block, CellVAlign, Defaults, DocxDocument, Image, Justification, LineRule, LineSpacing,
    ListKind, ListMarker, ParaProps, Paragraph, Run, RunProps, Section, Shading, Style,
    StyleCatalog, StyleKind, TabStop, Table, TableCell, TableRow, VMerge, VertAlign, LINE_BREAK,
};
use quick_xml::events::{BytesStart, Event};
use quick_xml::name::ResolveResult;
use quick_xml::NsReader;

/// The `mimetype` of an OpenDocument text document.
pub const ODT_MIME: &str = "application/vnd.oasis.opendocument.text";
/// The `mimetype` of an OpenDocument text template.
pub const OTT_MIME: &str = "application/vnd.oasis.opendocument.text-template";

/// An `.odt` read onto docx-core, with what the reader left out.
#[derive(Debug, Clone, Default)]
pub struct OdtRead {
    pub doc: DocxDocument,
    /// One line per kind of content not carried.
    pub diagnostics: Vec<String>,
    /// The package is a template (`.ott`).
    pub template: bool,
}

/// True when `bytes` are an OpenDocument text package: a zip whose first
/// entry is the stored `mimetype` naming a text document or template.
pub fn is_odt(bytes: &[u8]) -> bool {
    bytes.starts_with(b"PK\x03\x04")
        && bytes.get(30..38) == Some(b"mimetype")
        && bytes
            .get(38..38 + ODT_MIME.len())
            .is_some_and(|m| m == ODT_MIME.as_bytes())
}

/// Read an `.odt` package. Fails when the bytes are not an OpenDocument
/// text package or its `content.xml` does not parse.
pub fn read_odt(bytes: &[u8]) -> Result<OdtRead, String> {
    let entries = paged_ooxml::read_zip(bytes, paged_ooxml::MAX_UNCOMPRESSED_BYTES)
        .map_err(|e| e.to_string())?;
    let mut files: HashMap<String, Vec<u8>> = HashMap::new();
    for e in entries {
        if let paged_ooxml::ZipEntry::File { name, bytes } = e {
            files.insert(name, bytes);
        }
    }
    let mime = files
        .get("mimetype")
        .map(|m| String::from_utf8_lossy(m).trim().to_string())
        .unwrap_or_default();
    if mime != ODT_MIME && mime != OTT_MIME {
        return Err(format!(
            "not an OpenDocument text document (mimetype {:?})",
            mime
        ));
    }
    let content = parse(files.get("content.xml").ok_or("content.xml is missing")?)?;
    let styles = match files.get("styles.xml") {
        Some(b) => Some(parse(b)?),
        None => None,
    };
    let mut r = Odt {
        files: &files,
        styles: HashMap::new(),
        lists: HashMap::new(),
        fonts: HashMap::new(),
        body: Vec::new(),
        list_ids: HashMap::new(),
        next_list: 1,
        notes: 0,
        comments: 0,
        tracked: 0,
        drawings: 0,
        headers: 0,
        defaults: Defaults::default(),
        section: Section::default(),
        used_named: Vec::new(),
    };
    if let Some(st) = &styles {
        r.read_fonts(st);
        r.read_styles(st, false);
        r.read_page(st);
    }
    r.read_fonts(&content);
    r.read_styles(&content, true);
    if let Some(text) = content
        .child("office:body")
        .and_then(|b| b.child("office:text"))
    {
        let blocks = r.blocks(text);
        r.body = blocks;
    }
    Ok(r.finish(mime == OTT_MIME))
}

// ---------------------------------------------------------------------------
// A small namespace-normalised tree with mixed content.

/// The namespaces ODF text uses, by URI, with the prefix the reader names
/// them by (whatever prefix the file binds).
const NAMESPACES: [(&str, &str); 9] = [
    ("urn:oasis:names:tc:opendocument:xmlns:office:1.0", "office"),
    ("urn:oasis:names:tc:opendocument:xmlns:style:1.0", "style"),
    ("urn:oasis:names:tc:opendocument:xmlns:text:1.0", "text"),
    ("urn:oasis:names:tc:opendocument:xmlns:table:1.0", "table"),
    ("urn:oasis:names:tc:opendocument:xmlns:drawing:1.0", "draw"),
    (
        "urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0",
        "fo",
    ),
    ("http://www.w3.org/1999/xlink", "xlink"),
    (
        "urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0",
        "svg",
    ),
    ("http://www.w3.org/XML/1998/namespace", "xml"),
];

#[derive(Debug, Clone)]
enum Node {
    El(El),
    Text(String),
}

#[derive(Debug, Clone, Default)]
struct El {
    /// `prefix:local` with the reader's prefix (`text:p`).
    name: String,
    attrs: Vec<(String, String)>,
    kids: Vec<Node>,
}

impl El {
    fn attr(&self, name: &str) -> Option<&str> {
        self.attrs
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    }

    fn child(&self, name: &str) -> Option<&El> {
        self.elements().find(|e| e.name == name)
    }

    fn elements(&self) -> impl Iterator<Item = &El> {
        self.kids.iter().filter_map(|k| match k {
            Node::El(e) => Some(e),
            Node::Text(_) => None,
        })
    }

    fn deep_text(&self) -> String {
        let mut s = String::new();
        for k in &self.kids {
            match k {
                Node::Text(t) => s.push_str(t),
                Node::El(e) => s.push_str(&e.deep_text()),
            }
        }
        s
    }
}

fn qualified(res: ResolveResult<'_>, local: &[u8]) -> String {
    let local = String::from_utf8_lossy(local);
    match res {
        ResolveResult::Bound(ns) => {
            let uri = String::from_utf8_lossy(ns.as_ref()).into_owned();
            match NAMESPACES.iter().find(|(u, _)| *u == uri) {
                Some((_, p)) => format!("{p}:{local}"),
                None => format!("?:{local}"),
            }
        }
        _ => local.into_owned(),
    }
}

fn element(reader: &NsReader<&[u8]>, start: &BytesStart<'_>) -> El {
    let (res, local) = reader.resolver().resolve_element(start.name());
    let name = qualified(res, local.as_ref());
    let mut attrs = Vec::new();
    for a in start.attributes().with_checks(false).flatten() {
        if a.key.as_namespace_binding().is_some() {
            continue;
        }
        let value = a
            .normalized_value(quick_xml::XmlVersion::Implicit1_0)
            .map(|v| v.into_owned())
            .unwrap_or_else(|_| String::from_utf8_lossy(&a.value).into_owned());
        let (res, local) = reader.resolver().resolve_attribute(a.key);
        attrs.push((qualified(res, local.as_ref()), value));
    }
    El {
        name,
        attrs,
        kids: Vec::new(),
    }
}

fn parse(bytes: &[u8]) -> Result<El, String> {
    let mut reader = NsReader::from_reader(bytes);
    reader.config_mut().trim_text(false);
    let mut stack: Vec<El> = Vec::new();
    let mut buf = Vec::new();
    let push_text = |stack: &mut Vec<El>, s: &str| {
        if let Some(top) = stack.last_mut() {
            if let Some(Node::Text(t)) = top.kids.last_mut() {
                t.push_str(s);
            } else {
                top.kids.push(Node::Text(s.to_string()));
            }
        }
    };
    loop {
        let event = reader
            .read_event_into(&mut buf)
            .map_err(|e| format!("xml at byte {}: {e}", reader.buffer_position()))?;
        match event {
            Event::Start(s) => {
                let el = element(&reader, &s);
                stack.push(el);
            }
            Event::Empty(s) => {
                let el = element(&reader, &s);
                match stack.last_mut() {
                    Some(p) => p.kids.push(Node::El(el)),
                    None => return Ok(el),
                }
            }
            Event::End(_) => {
                let done = stack.pop().ok_or("unbalanced end tag")?;
                match stack.last_mut() {
                    Some(p) => p.kids.push(Node::El(done)),
                    None => return Ok(done),
                }
            }
            Event::Text(t) => {
                let s = t.xml10_content().map_err(|e| e.to_string())?;
                push_text(&mut stack, &s);
            }
            Event::GeneralRef(r) => {
                if let Ok(Some(ch)) = r.resolve_char_ref() {
                    push_text(&mut stack, &ch.to_string());
                } else if let Ok(name) = r.decode() {
                    if let Some(v) = quick_xml::escape::resolve_predefined_entity(&name) {
                        push_text(&mut stack, v);
                    }
                }
            }
            Event::CData(t) => push_text(&mut stack, &String::from_utf8_lossy(&t)),
            Event::Eof => return Err("no root element".into()),
            _ => {}
        }
        buf.clear();
    }
}

// ---------------------------------------------------------------------------
// Units

/// An ODF length (`1.5cm`, `12pt`, `0.5in`, `10mm`, `2pc`, `16px`) in
/// twips.
fn twips(v: &str) -> Option<i32> {
    let v = v.trim();
    let split = v
        .find(|c: char| c.is_ascii_alphabetic() || c == '%')
        .unwrap_or(v.len());
    let (num, unit) = v.split_at(split);
    let n: f64 = num.trim().parse().ok()?;
    let factor = match unit {
        "pt" => 20.0,
        "cm" => 1440.0 / 2.54,
        "mm" => 144.0 / 2.54,
        "in" | "inch" => 1440.0,
        "pc" => 240.0,
        "px" => 15.0,
        _ => return None,
    };
    Some((n * factor).round() as i32)
}

fn percent(v: &str) -> Option<f64> {
    v.trim().strip_suffix('%')?.trim().parse().ok()
}

// ---------------------------------------------------------------------------
// Styles

#[derive(Debug, Clone, Default)]
struct OStyle {
    name: String,
    display: Option<String>,
    family: String,
    parent: Option<String>,
    auto: bool,
    run: RunProps,
    para: ParaProps,
    hidden: bool,
    /// A table column's width (`style:column-width`).
    column_width: Option<i32>,
    /// A cell's vertical alignment.
    valign: Option<CellVAlign>,
}

#[derive(Debug, Clone, Default)]
struct OLevel {
    bullet: Option<String>,
    format: Option<String>,
    font: Option<String>,
    left: Option<i32>,
    indent: Option<i32>,
}

struct Odt<'f> {
    files: &'f HashMap<String, Vec<u8>>,
    /// Styles by `(family, name)`.
    styles: HashMap<(String, String), OStyle>,
    lists: HashMap<String, HashMap<u8, OLevel>>,
    fonts: HashMap<String, String>,
    body: Vec<Block>,
    /// The `w:numId` each list (by its style name) continues with.
    list_ids: HashMap<String, i32>,
    next_list: i32,
    notes: u32,
    comments: u32,
    tracked: u32,
    drawings: u32,
    headers: u32,
    defaults: Defaults,
    section: Section,
    /// Named styles used by the body, in first-use order.
    used_named: Vec<(String, String)>,
}

impl Odt<'_> {
    fn read_fonts(&mut self, root: &El) {
        if let Some(decls) = root.child("office:font-face-decls") {
            for f in decls.elements().filter(|e| e.name == "style:font-face") {
                if let (Some(name), Some(family)) =
                    (f.attr("style:name"), f.attr("svg:font-family"))
                {
                    self.fonts.insert(
                        name.to_string(),
                        family.trim_matches(['\'', '"']).to_string(),
                    );
                }
            }
        }
    }

    fn read_styles(&mut self, root: &El, content: bool) {
        let containers: &[&str] = if content {
            &["office:automatic-styles"]
        } else {
            &["office:styles", "office:automatic-styles"]
        };
        for c in containers {
            let Some(container) = root.child(c) else {
                continue;
            };
            let auto = *c == "office:automatic-styles";
            for e in container.elements() {
                match e.name.as_str() {
                    "style:style" => {
                        let st = self.style(e, auto);
                        self.styles.insert((st.family.clone(), st.name.clone()), st);
                    }
                    "style:default-style" if e.attr("style:family") == Some("paragraph") => {
                        let st = self.style(e, false);
                        self.defaults.run = st.run;
                        self.defaults.para = st.para;
                    }
                    "text:list-style" => {
                        if let Some(name) = e.attr("style:name") {
                            let levels = list_levels(e, &self.fonts);
                            self.lists.insert(name.to_string(), levels);
                        }
                    }
                    _ => {}
                }
            }
        }
    }

    fn style(&self, e: &El, auto: bool) -> OStyle {
        let mut st = OStyle {
            name: e.attr("style:name").unwrap_or("").to_string(),
            display: e.attr("style:display-name").map(str::to_string),
            family: e.attr("style:family").unwrap_or("paragraph").to_string(),
            parent: e.attr("style:parent-style-name").map(str::to_string),
            auto,
            ..OStyle::default()
        };
        if let Some(tp) = e.child("style:text-properties") {
            text_props(tp, &self.fonts, &mut st.run, &mut st.hidden);
        }
        if let Some(pp) = e.child("style:paragraph-properties") {
            para_props(pp, &mut st.para);
        }
        if let Some(cp) = e.child("style:table-column-properties") {
            st.column_width = cp.attr("style:column-width").and_then(twips);
        }
        if let Some(cp) = e.child("style:table-cell-properties") {
            st.valign = match cp.attr("style:vertical-align") {
                Some("middle") => Some(CellVAlign::Center),
                Some("bottom") => Some(CellVAlign::Bottom),
                Some("top") => Some(CellVAlign::Top),
                _ => None,
            };
        }
        st
    }

    fn read_page(&mut self, styles: &El) {
        let master = styles.child("office:master-styles").and_then(|m| {
            m.elements()
                .find(|e| e.name == "style:master-page" && e.attr("style:name") == Some("Standard"))
                .or_else(|| m.elements().find(|e| e.name == "style:master-page"))
        });
        let Some(master) = master else {
            return;
        };
        let has_content = |name: &str| {
            master
                .child(name)
                .is_some_and(|h| !h.deep_text().trim().is_empty())
        };
        for h in [
            "style:header",
            "style:footer",
            "style:header-first",
            "style:footer-first",
        ] {
            if has_content(h) {
                self.headers += 1;
            }
        }
        let Some(layout_name) = master.attr("style:page-layout-name") else {
            return;
        };
        let layout = styles
            .child("office:automatic-styles")
            .and_then(|a| {
                a.elements().find(|e| {
                    e.name == "style:page-layout" && e.attr("style:name") == Some(layout_name)
                })
            })
            .and_then(|l| l.child("style:page-layout-properties"));
        let Some(p) = layout else {
            return;
        };
        let s = &mut self.section;
        if let Some(v) = p.attr("fo:page-width").and_then(twips) {
            s.page_width = v;
        }
        if let Some(v) = p.attr("fo:page-height").and_then(twips) {
            s.page_height = v;
        }
        if let Some(v) = p.attr("fo:margin-top").and_then(twips) {
            s.margin_top = v;
        }
        if let Some(v) = p.attr("fo:margin-bottom").and_then(twips) {
            s.margin_bottom = v;
        }
        if let Some(v) = p.attr("fo:margin-left").and_then(twips) {
            s.margin_left = v;
        }
        if let Some(v) = p.attr("fo:margin-right").and_then(twips) {
            s.margin_right = v;
        }
        if let Some(cols) = p.child("style:columns") {
            if let Some(n) = cols
                .attr("fo:column-count")
                .and_then(|c| c.parse::<u32>().ok())
            {
                s.columns = n.max(1);
            }
            if let Some(g) = cols.attr("fo:column-gap").and_then(twips) {
                s.column_space = g;
            }
        }
    }

    fn get(&self, family: &str, name: &str) -> Option<&OStyle> {
        self.styles.get(&(family.to_string(), name.to_string()))
    }

    /// The named style a (possibly automatic) style stands on, and the
    /// direct formatting its automatic layers add.
    fn resolve(
        &mut self,
        family: &str,
        name: Option<&str>,
    ) -> (Option<String>, RunProps, ParaProps, bool) {
        let mut run = RunProps::default();
        let mut para = ParaProps::default();
        let mut hidden = false;
        let mut layers: Vec<OStyle> = Vec::new();
        let mut cur = name.map(str::to_string);
        let mut named = None;
        let mut guard = 0;
        while let Some(n) = cur {
            guard += 1;
            if guard > 16 {
                break;
            }
            let Some(st) = self.get(family, &n).cloned() else {
                break;
            };
            if !st.auto {
                named = Some(n);
                break;
            }
            cur = st.parent.clone();
            layers.push(st);
        }
        // The outermost automatic layer wins: apply the innermost first.
        for st in layers.iter().rev() {
            overlay_run(&mut run, &st.run);
            overlay_para(&mut para, &st.para);
            hidden |= st.hidden;
        }
        if let Some(n) = &named {
            let key = (family.to_string(), n.clone());
            if !self.used_named.contains(&key) {
                self.used_named.push(key);
            }
        }
        (named, run, para, hidden)
    }

    // -----------------------------------------------------------------------
    // Body

    fn blocks(&mut self, container: &El) -> Vec<Block> {
        let mut out = Vec::new();
        for e in container.elements() {
            match e.name.as_str() {
                "text:p" | "text:h" => {
                    let p = self.paragraph(e, None);
                    out.push(Block::Paragraph(p));
                }
                "text:list" => self.list(e, 0, None, &mut out),
                "table:table" => out.push(Block::Table(self.table(e))),
                "text:section" | "text:index-body" => out.extend(self.blocks(e)),
                "text:table-of-content"
                | "text:alphabetical-index"
                | "text:illustration-index"
                | "text:table-index"
                | "text:object-index"
                | "text:user-index"
                | "text:bibliography" => {
                    if let Some(b) = e.child("text:index-body") {
                        out.extend(self.blocks(b));
                    }
                }
                "text:tracked-changes" => {
                    self.tracked += e.elements().count() as u32;
                }
                "draw:frame" | "draw:custom-shape" | "draw:rect" | "draw:line" | "draw:g" => {
                    self.drawings += 1;
                }
                _ => {}
            }
        }
        out
    }

    fn list(&mut self, e: &El, level: u8, style: Option<&str>, out: &mut Vec<Block>) {
        let style = e
            .attr("text:style-name")
            .map(str::to_string)
            .or_else(|| style.map(str::to_string));
        let num_id = match &style {
            Some(s) if level > 0 || e.attr("text:continue-numbering") == Some("true") => {
                match self.list_ids.get(s) {
                    Some(id) => *id,
                    None => self.new_list(s),
                }
            }
            Some(s) => self.new_list(s),
            None => 0,
        };
        for item in e
            .elements()
            .filter(|i| i.name == "text:list-item" || i.name == "text:list-header")
        {
            let header = item.name == "text:list-header";
            for c in item.elements() {
                match c.name.as_str() {
                    "text:p" | "text:h" => {
                        let marker = match (&style, header) {
                            (Some(s), false) => self.marker(s, num_id, level),
                            _ => None,
                        };
                        let p = self.paragraph(c, marker);
                        out.push(Block::Paragraph(p));
                    }
                    "text:list" => {
                        self.list(c, level.saturating_add(1).min(8), style.as_deref(), out)
                    }
                    "table:table" => out.push(Block::Table(self.table(c))),
                    _ => {}
                }
            }
        }
    }

    fn new_list(&mut self, style: &str) -> i32 {
        let id = self.next_list;
        self.next_list += 1;
        self.list_ids.insert(style.to_string(), id);
        id
    }

    fn marker(&self, style: &str, num_id: i32, level: u8) -> Option<ListMarker> {
        let lvl = self
            .lists
            .get(style)?
            .get(&level)
            .cloned()
            .unwrap_or_default();
        let (kind, bullet, format) = match (&lvl.bullet, &lvl.format) {
            (Some(b), _) => (ListKind::Bullet, Some(b.clone()), None),
            (None, Some(f)) => {
                let sample = match f.as_str() {
                    "I" => "I, II, III, IV...",
                    "i" => "i, ii, iii, iv...",
                    "A" => "A, B, C, D...",
                    "a" => "a, b, c, d...",
                    "" => return None,
                    _ => "1, 2, 3, 4...",
                };
                (ListKind::Numbered, None, Some(sample.to_string()))
            }
            (None, None) => (ListKind::Bullet, Some("\u{2022}".into()), None),
        };
        Some(ListMarker {
            kind,
            num_id,
            level,
            bullet_char: bullet,
            number_format: format,
            left_indent: lvl.left,
            first_line_indent: lvl.indent.filter(|i| *i > 0),
            hanging_indent: lvl.indent.filter(|i| *i < 0).map(|i| -i),
            marker_font: lvl.font,
            marker_half_pts: None,
        })
    }

    fn paragraph(&mut self, e: &El, list: Option<ListMarker>) -> Paragraph {
        let (named, run, para, hidden) = self.resolve("paragraph", e.attr("text:style-name"));
        let mut style_id = named.as_deref().map(style_id);
        if e.name == "text:h" && style_id.is_none() {
            // A heading without a heading style: Word's `heading N`.
            let level = e
                .attr("text:outline-level")
                .and_then(|l| l.parse::<u8>().ok())
                .unwrap_or(1)
                .clamp(1, 9);
            let name = format!("Heading_20_{level}");
            if self.get("paragraph", &name).is_none() {
                self.styles.insert(
                    ("paragraph".into(), name.clone()),
                    OStyle {
                        name: name.clone(),
                        display: Some(format!("Heading {level}")),
                        family: "paragraph".into(),
                        ..OStyle::default()
                    },
                );
            }
            let key = ("paragraph".to_string(), name.clone());
            if !self.used_named.contains(&key) {
                self.used_named.push(key);
            }
            style_id = Some(style_id_of_name(&name));
        }
        let mut p = Paragraph {
            style_id,
            props: para,
            list,
            ..Paragraph::default()
        };
        let mut runs = Vec::new();
        let base = Inline {
            run,
            style: None,
            link: None,
            hidden,
        };
        let mut at_start = true;
        self.inline(e, &base, &mut runs, &mut p.bookmarks, &mut at_start);
        p.runs = runs;
        p
    }

    fn inline(
        &mut self,
        e: &El,
        look: &Inline,
        runs: &mut Vec<Run>,
        bookmarks: &mut Vec<String>,
        at_start: &mut bool,
    ) {
        for k in &e.kids {
            match k {
                Node::Text(t) => {
                    // ODF collapses white space: tabs and line ends are
                    // spaces, runs of spaces one space, and a paragraph's
                    // leading space goes.
                    let mut s = String::new();
                    let mut prev_space =
                        *at_start || runs.last().is_some_and(|r| r.text.ends_with(' ')) || false;
                    for c in t.chars() {
                        let c = if matches!(c, '\t' | '\n' | '\r') {
                            ' '
                        } else {
                            c
                        };
                        if c == ' ' {
                            if prev_space {
                                continue;
                            }
                            prev_space = true;
                        } else {
                            prev_space = false;
                        }
                        s.push(c);
                    }
                    if !s.is_empty() {
                        *at_start = false;
                        push(runs, look, &s);
                    }
                }
                Node::El(c) => match c.name.as_str() {
                    "text:span" => {
                        let mut inner = look.clone();
                        if let Some(name) = c.attr("text:style-name") {
                            let (named, run, _, hidden) = self.resolve("text", Some(name));
                            overlay_run(&mut inner.run, &run);
                            if named.is_some() {
                                inner.style = named.as_deref().map(style_id);
                            }
                            inner.hidden |= hidden;
                        }
                        self.inline(c, &inner, runs, bookmarks, at_start);
                    }
                    "text:a" => {
                        let mut inner = look.clone();
                        inner.link = c.attr("xlink:href").map(str::to_string);
                        self.inline(c, &inner, runs, bookmarks, at_start);
                    }
                    "text:s" => {
                        let n = c
                            .attr("text:c")
                            .and_then(|n| n.parse::<usize>().ok())
                            .unwrap_or(1);
                        *at_start = false;
                        push(runs, look, &" ".repeat(n.min(1000)));
                    }
                    "text:tab" => {
                        *at_start = false;
                        push(runs, look, "\t");
                    }
                    "text:line-break" => {
                        *at_start = false;
                        push(runs, look, &LINE_BREAK.to_string());
                    }
                    "text:bookmark" | "text:bookmark-start" => {
                        if let Some(n) = c.attr("text:name") {
                            bookmarks.push(n.to_string());
                        }
                    }
                    "text:note" => self.notes += 1,
                    "office:annotation" => self.comments += 1,
                    "office:annotation-end" | "text:bookmark-end" | "text:soft-page-break" => {}
                    "text:change-start" | "text:change-end" | "text:change" => {}
                    "draw:frame" => {
                        let image = c.child("draw:image").and_then(|img| self.image(c, img));
                        match image {
                            Some(image) => {
                                *at_start = false;
                                runs.push(Run {
                                    props: look.run.clone(),
                                    style_id: look.style.clone(),
                                    hyperlink: look.link.clone(),
                                    images: vec![image],
                                    ..Run::default()
                                });
                            }
                            None => self.drawings += 1,
                        }
                    }
                    "draw:a" => {
                        let mut inner = look.clone();
                        inner.link = c.attr("xlink:href").map(str::to_string);
                        self.inline(c, &inner, runs, bookmarks, at_start);
                    }
                    "draw:custom-shape" | "draw:rect" | "draw:line" | "draw:g" | "draw:ellipse"
                    | "draw:polygon" | "draw:path" => self.drawings += 1,
                    // Fields (page numbers, dates, references, …): their
                    // text as shown.
                    _ => self.inline(c, look, runs, bookmarks, at_start),
                },
            }
        }
    }

    fn image(&self, frame: &El, img: &El) -> Option<Image> {
        let href = img.attr("xlink:href")?;
        let bytes = self.files.get(href.trim_start_matches("./"))?.clone();
        let lower = href.to_ascii_lowercase();
        let mime = if lower.ends_with(".png") {
            "image/png"
        } else if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
            "image/jpeg"
        } else if lower.ends_with(".gif") {
            "image/gif"
        } else {
            return None;
        };
        let w = frame.attr("svg:width").and_then(twips).unwrap_or(1440);
        let h = frame.attr("svg:height").and_then(twips).unwrap_or(1440);
        Some(Image {
            bytes,
            mime: mime.to_string(),
            width_emu: i64::from(w.max(1)) * 635,
            height_emu: i64::from(h.max(1)) * 635,
            float: None,
            band_offset_emu: None,
            look: None,
        })
    }

    fn table(&mut self, e: &El) -> Table {
        let mut widths = Vec::new();
        let mut rows = Vec::new();
        let mut pending = Vec::new();
        self.table_parts(e, &mut widths, &mut rows, false, &mut pending);
        let columns = rows.iter().map(|r: &TableRow| {
            r.cells
                .iter()
                .map(|c| c.grid_span.max(1) as usize)
                .sum::<usize>()
        });
        let n = columns.max().unwrap_or(0).max(widths.len());
        if widths.len() < n {
            let text_width =
                (self.section.page_width - self.section.margin_left - self.section.margin_right)
                    .max(1440);
            let each = text_width / i32::try_from(n.max(1)).unwrap_or(1);
            widths.resize(n, each.max(1));
        }
        Table {
            column_widths: widths,
            rows,
            ..Table::default()
        }
    }

    fn table_parts(
        &mut self,
        e: &El,
        widths: &mut Vec<i32>,
        rows: &mut Vec<TableRow>,
        header: bool,
        pending: &mut Vec<(i32, u32)>,
    ) {
        for c in e.elements() {
            match c.name.as_str() {
                "table:table-column" => {
                    let repeat = c
                        .attr("table:number-columns-repeated")
                        .and_then(|n| n.parse::<usize>().ok())
                        .unwrap_or(1)
                        .min(1000);
                    let w = c
                        .attr("table:style-name")
                        .and_then(|s| self.get("table-column", s))
                        .and_then(|s| s.column_width)
                        .unwrap_or(0);
                    for _ in 0..repeat {
                        widths.push(w);
                    }
                }
                "table:table-columns" | "table:table-column-group" => {
                    self.table_parts(c, widths, rows, header, pending)
                }
                "table:table-header-rows" => self.table_parts(c, widths, rows, true, pending),
                "table:table-rows" | "table:table-row-group" => {
                    self.table_parts(c, widths, rows, header, pending)
                }
                "table:table-row" => {
                    let repeat = c
                        .attr("table:number-rows-repeated")
                        .and_then(|n| n.parse::<usize>().ok())
                        .unwrap_or(1)
                        .clamp(1, 100);
                    for _ in 0..repeat {
                        let row = self.row(c, header, pending);
                        rows.push(row);
                    }
                }
                _ => {}
            }
        }
        // A column without a width takes an equal share later.
        if widths.iter().all(|w| *w == 0) {
            widths.clear();
        } else {
            let known: Vec<i32> = widths.iter().copied().filter(|w| *w > 0).collect();
            let avg = known.iter().sum::<i32>() / i32::try_from(known.len().max(1)).unwrap_or(1);
            for w in widths.iter_mut() {
                if *w == 0 {
                    *w = avg.max(1);
                }
            }
        }
    }

    /// One `table:table-row`. `pending[col]` is, for a cell spanning rows
    /// that starts in grid column `col`, the rows it still covers below and
    /// its column span.
    fn row(&mut self, e: &El, header: bool, pending: &mut Vec<(i32, u32)>) -> TableRow {
        let mut row = TableRow {
            is_header: header,
            ..TableRow::default()
        };
        let mut col = 0usize;
        // Covered cells that belong to the cell just emitted (its columns).
        let mut skip = 0u32;
        for c in e.elements() {
            match c.name.as_str() {
                "table:table-cell" => {
                    let span = c
                        .attr("table:number-columns-spanned")
                        .and_then(|n| n.parse::<u32>().ok())
                        .unwrap_or(1)
                        .clamp(1, 1000);
                    let rows_spanned = c
                        .attr("table:number-rows-spanned")
                        .and_then(|n| n.parse::<i32>().ok())
                        .unwrap_or(1);
                    let valign = c
                        .attr("table:style-name")
                        .and_then(|s| self.get("table-cell", s))
                        .and_then(|s| s.valign);
                    let mut paragraphs = Vec::new();
                    for k in c.elements() {
                        match k.name.as_str() {
                            "text:p" | "text:h" => paragraphs.push(self.paragraph(k, None)),
                            "text:list" => {
                                let mut blocks = Vec::new();
                                self.list(k, 0, None, &mut blocks);
                                for b in blocks {
                                    if let Block::Paragraph(p) = b {
                                        paragraphs.push(p);
                                    }
                                }
                            }
                            _ => {}
                        }
                    }
                    if paragraphs.is_empty() {
                        paragraphs.push(Paragraph::default());
                    }
                    if pending.len() <= col {
                        pending.resize(col + 1, (0, 1));
                    }
                    pending[col] = if rows_spanned > 1 {
                        (rows_spanned - 1, span)
                    } else {
                        (0, 1)
                    };
                    row.cells.push(TableCell {
                        paragraphs,
                        grid_span: span,
                        v_merge: if rows_spanned > 1 {
                            VMerge::Restart
                        } else {
                            VMerge::None
                        },
                        v_align: valign,
                        ..TableCell::default()
                    });
                    col += span as usize;
                    skip = span - 1;
                }
                "table:covered-table-cell" => {
                    if skip > 0 {
                        skip -= 1;
                        continue;
                    }
                    let Some(&(left, span)) = pending.get(col).filter(|p| p.0 > 0) else {
                        // Covered by a cell to its left whose span this
                        // reader already counted.
                        continue;
                    };
                    pending[col] = (left - 1, span);
                    row.cells.push(TableCell {
                        paragraphs: vec![Paragraph::default()],
                        grid_span: span,
                        v_merge: VMerge::Continue,
                        ..TableCell::default()
                    });
                    col += span as usize;
                    skip = span - 1;
                }
                _ => {}
            }
        }
        row
    }

    fn finish(mut self, template: bool) -> OdtRead {
        let mut styles = Vec::new();
        let mut i = 0;
        while i < self.used_named.len() {
            let (family, name) = self.used_named[i].clone();
            i += 1;
            let Some(st) = self.get(&family, &name).cloned() else {
                continue;
            };
            // Parents are written too.
            if let Some(parent) = &st.parent {
                let key = (family.clone(), parent.clone());
                if self.get(&family, parent).is_some() && !self.used_named.contains(&key) {
                    self.used_named.push(key);
                }
            }
            let kind = if family == "text" {
                StyleKind::Character
            } else {
                StyleKind::Paragraph
            };
            let id = style_id_of_name(&name);
            let display = st
                .display
                .clone()
                .unwrap_or_else(|| name.replace("_20_", " "));
            styles.push(Style {
                table: None,
                is_default: id == "Normal",
                style_id: id,
                name: Some(word_name(&display)),
                kind,
                based_on: st
                    .parent
                    .as_deref()
                    .filter(|p| self.get(&family, p).is_some())
                    .map(style_id_of_name),
                para: if kind == StyleKind::Paragraph {
                    st.para.clone()
                } else {
                    ParaProps::default()
                },
                run: st.run.clone(),
            });
        }
        let mut diagnostics = Vec::new();
        let mut note = |n: u32, what: &str| {
            if n > 0 {
                diagnostics.push(format!("{n} OpenDocument {what} not read"));
            }
        };
        note(self.notes, "note(s)");
        note(self.comments, "comment(s)");
        note(self.tracked, "tracked change(s)");
        note(self.drawings, "drawing(s) or frame(s)");
        note(self.headers, "header(s)/footer(s)");
        let doc = DocxDocument {
            body: self.body,
            styles: StyleCatalog {
                doc_defaults: self.defaults,
                styles,
            },
            sections: vec![self.section],
            ..DocxDocument::default()
        };
        OdtRead {
            doc,
            diagnostics,
            template,
        }
    }
}

/// What runs inherit inside a paragraph: the look, the character style, the
/// link, hidden text.
#[derive(Debug, Clone, Default)]
struct Inline {
    run: RunProps,
    style: Option<String>,
    link: Option<String>,
    hidden: bool,
}

fn push(runs: &mut Vec<Run>, look: &Inline, text: &str) {
    if look.hidden {
        return;
    }
    if let Some(last) = runs.last_mut() {
        if last.props == look.run
            && last.style_id == look.style
            && last.hyperlink == look.link
            && last.images.is_empty()
        {
            last.text.push_str(text);
            return;
        }
    }
    runs.push(Run {
        props: look.run.clone(),
        style_id: look.style.clone(),
        hyperlink: look.link.clone(),
        text: text.to_string(),
        ..Run::default()
    });
}

/// The Word style id of an ODF style name (`Heading_20_1` → `Heading1`;
/// the default paragraph style `Standard` → `Normal`).
fn style_id_of_name(name: &str) -> String {
    let display = name.replace("_20_", " ");
    match display.as_str() {
        "Standard" | "Default" | "Default Paragraph Style" => "Normal".into(),
        _ => display.chars().filter(|c| c.is_alphanumeric()).collect(),
    }
}

fn style_id(name: &str) -> String {
    style_id_of_name(name)
}

/// The Word name of an ODF display name: Word's built-in headings are
/// `heading N`, its default paragraph style `Normal`.
fn word_name(display: &str) -> String {
    let lower = display.to_ascii_lowercase();
    if let Some(n) = lower.strip_prefix("heading ") {
        if n.trim().parse::<u8>().is_ok_and(|n| (1..=9).contains(&n)) {
            return lower;
        }
    }
    match display {
        "Standard" | "Default" | "Default Paragraph Style" => "Normal".into(),
        _ => display.to_string(),
    }
}

fn list_levels(e: &El, fonts: &HashMap<String, String>) -> HashMap<u8, OLevel> {
    let mut out = HashMap::new();
    for l in e.elements() {
        let level = l
            .attr("text:level")
            .and_then(|n| n.parse::<u8>().ok())
            .unwrap_or(1)
            .clamp(1, 10)
            - 1;
        let mut lvl = OLevel::default();
        match l.name.as_str() {
            "text:list-level-style-bullet" => {
                lvl.bullet = Some(
                    l.attr("text:bullet-char")
                        .and_then(|c| c.chars().next())
                        .map_or_else(|| "\u{2022}".to_string(), bullet),
                );
            }
            "text:list-level-style-number" => {
                lvl.format = Some(l.attr("style:num-format").unwrap_or("1").to_string());
            }
            "text:list-level-style-image" => lvl.bullet = Some("\u{2022}".into()),
            _ => continue,
        }
        if let Some(tp) = l.child("style:text-properties") {
            lvl.font = tp
                .attr("style:font-name")
                .and_then(|f| fonts.get(f).cloned())
                .or_else(|| tp.attr("fo:font-family").map(str::to_string));
        }
        if let Some(lp) = l.child("style:list-level-properties") {
            if let Some(al) = lp.child("style:list-level-label-alignment") {
                lvl.left = al.attr("fo:margin-left").and_then(twips);
                lvl.indent = al.attr("fo:text-indent").and_then(twips);
            } else {
                // The older position model: space before + minimum label
                // width.
                let before = lp.attr("text:space-before").and_then(twips).unwrap_or(0);
                let width = lp.attr("text:min-label-width").and_then(twips).unwrap_or(0);
                if before > 0 || width > 0 {
                    lvl.left = Some(before + width);
                    lvl.indent = Some(-width);
                }
            }
        }
        out.insert(level.min(8), lvl);
    }
    out
}

fn bullet(c: char) -> String {
    match c {
        '\u{F0B7}' | '\u{2022}' => "\u{2022}".into(),
        '\u{F0A7}' | '\u{25AA}' => "\u{25AA}".into(),
        '\u{E00A}' | '\u{25A0}' => "\u{25A0}".into(),
        c if (c as u32) >= 0xE000 && (c as u32) < 0xF900 => "\u{2022}".into(),
        c => c.to_string(),
    }
}

fn text_props(tp: &El, fonts: &HashMap<String, String>, run: &mut RunProps, hidden: &mut bool) {
    if let Some(w) = tp.attr("fo:font-weight") {
        run.bold = Some(matches!(w, "bold" | "600" | "700" | "800" | "900"));
    }
    if let Some(s) = tp.attr("fo:font-style") {
        run.italic = Some(matches!(s, "italic" | "oblique"));
    }
    if let Some(u) = tp.attr("style:text-underline-style") {
        run.underline = Some(u != "none");
    }
    if let Some(s) = tp.attr("style:text-line-through-style") {
        run.strike = Some(s != "none");
    }
    match tp.attr("fo:font-variant") {
        Some("small-caps") => run.small_caps = Some(true),
        Some("normal") => run.small_caps = Some(false),
        _ => {}
    }
    match tp.attr("fo:text-transform") {
        Some("uppercase") => run.caps = Some(true),
        Some("none") => run.caps = Some(false),
        _ => {}
    }
    if let Some(c) = tp.attr("fo:color") {
        if let Some(hex) = c.strip_prefix('#').filter(|h| h.len() == 6) {
            run.color = Some(hex.to_ascii_uppercase());
        }
    }
    if let Some(sz) = tp.attr("fo:font-size") {
        if let Some(tw) = twips(sz) {
            run.size_half_pts = Some(((tw + 5) / 10).max(1) as u32);
        }
    }
    if let Some(f) = tp.attr("style:font-name") {
        run.font = Some(fonts.get(f).cloned().unwrap_or_else(|| f.to_string()));
    } else if let Some(f) = tp.attr("fo:font-family") {
        run.font = Some(f.trim_matches(['\'', '"']).to_string());
    }
    if let Some(pos) = tp.attr("style:text-position") {
        let first = pos.split_whitespace().next().unwrap_or("");
        run.vert_align = match first {
            "super" => Some(VertAlign::Superscript),
            "sub" => Some(VertAlign::Subscript),
            "0%" | "0" => Some(VertAlign::Baseline),
            p => match percent(p) {
                Some(v) if v > 0.0 => Some(VertAlign::Superscript),
                Some(v) if v < 0.0 => Some(VertAlign::Subscript),
                _ => None,
            },
        };
    }
    if let Some(ls) = tp.attr("fo:letter-spacing") {
        if ls != "normal" {
            run.spacing_twips = twips(ls);
        }
    }
    if let Some(bg) = tp.attr("fo:background-color") {
        if let Some(hex) = bg.strip_prefix('#').filter(|h| h.len() == 6) {
            run.shading = Some(Shading {
                fill: Some(hex.to_ascii_uppercase()),
                theme_fill: None,
            });
        }
    }
    if tp.attr("text:display") == Some("none") {
        *hidden = true;
    }
}

fn para_props(pp: &El, para: &mut ParaProps) {
    if let Some(a) = pp.attr("fo:text-align") {
        para.justification = match a {
            "center" => Some(Justification::Center),
            "end" | "right" => Some(Justification::Right),
            "justify" => Some(Justification::Both),
            _ => Some(Justification::Left),
        };
    }
    if let Some(v) = pp.attr("fo:margin-left").and_then(twips) {
        para.left_indent = Some(v);
    }
    if let Some(v) = pp.attr("fo:margin-right").and_then(twips) {
        para.right_indent = Some(v);
    }
    if let Some(v) = pp.attr("fo:text-indent").and_then(twips) {
        if v < 0 {
            para.hanging_indent = Some(-v);
            para.first_line_indent = None;
        } else {
            para.first_line_indent = Some(v);
            para.hanging_indent = None;
        }
    }
    if let Some(v) = pp.attr("fo:margin-top").and_then(twips) {
        para.space_before = Some(v);
    }
    if let Some(v) = pp.attr("fo:margin-bottom").and_then(twips) {
        para.space_after = Some(v);
    }
    if let Some(lh) = pp.attr("fo:line-height") {
        if let Some(p) = percent(lh) {
            para.line_spacing = Some(LineSpacing {
                value: (p * 2.4).round() as i32,
                rule: LineRule::Auto,
            });
        } else if let Some(t) = twips(lh) {
            para.line_spacing = Some(LineSpacing {
                value: t,
                rule: LineRule::Exact,
            });
        }
    }
    if let Some(t) = pp.attr("style:line-height-at-least").and_then(twips) {
        para.line_spacing = Some(LineSpacing {
            value: t,
            rule: LineRule::AtLeast,
        });
    }
    match pp.attr("fo:break-before") {
        Some("page") => para.page_break_before = Some(true),
        Some("auto") => para.page_break_before = Some(false),
        _ => {}
    }
    if let Some(k) = pp.attr("fo:keep-with-next") {
        para.keep_next = Some(k == "always");
    }
    if let Some(k) = pp.attr("fo:keep-together") {
        para.keep_lines = Some(k == "always");
    }
    if let Some(stops) = pp.child("style:tab-stops") {
        for t in stops.elements().filter(|t| t.name == "style:tab-stop") {
            let Some(pos) = t.attr("style:position").and_then(twips) else {
                continue;
            };
            let alignment = match t.attr("style:type") {
                Some("center") => "center",
                Some("right") => "right",
                Some("char") => "decimal",
                _ => "left",
            };
            let leader = t
                .attr("style:leader-text")
                .filter(|l| !l.trim().is_empty())
                .map(str::to_string)
                .or_else(|| match t.attr("style:leader-style") {
                    Some("dotted") => Some(".".into()),
                    Some("dash") => Some("-".into()),
                    Some("solid") => Some("_".into()),
                    _ => None,
                });
            para.tabs.push(TabStop {
                position: pos,
                alignment: Some(alignment.to_string()),
                leader,
            });
        }
    }
    if let Some(bg) = pp.attr("fo:background-color") {
        if let Some(hex) = bg.strip_prefix('#').filter(|h| h.len() == 6) {
            para.shading = Some(Shading {
                fill: Some(hex.to_ascii_uppercase()),
                theme_fill: None,
            });
        }
    }
}

fn overlay_run(to: &mut RunProps, from: &RunProps) {
    macro_rules! take {
        ($($f:ident),*) => {$(
            if from.$f.is_some() {
                to.$f = from.$f.clone();
            }
        )*};
    }
    take!(
        bold,
        italic,
        underline,
        strike,
        caps,
        small_caps,
        color,
        size_half_pts,
        font,
        vert_align,
        baseline_half_pts,
        spacing_twips,
        shading
    );
}

fn overlay_para(to: &mut ParaProps, from: &ParaProps) {
    macro_rules! take {
        ($($f:ident),*) => {$(
            if from.$f.is_some() {
                to.$f = from.$f.clone();
            }
        )*};
    }
    take!(
        justification,
        left_indent,
        right_indent,
        first_line_indent,
        hanging_indent,
        space_before,
        space_after,
        line_spacing,
        keep_next,
        keep_lines,
        page_break_before,
        widow_control,
        contextual_spacing,
        shading
    );
    if !from.tabs.is_empty() {
        to.tabs = from.tabs.clone();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// An `.odt` package from its `content.xml` and `styles.xml`.
    pub(crate) fn odt(content: &str, styles: &str, extra: &[(&str, &[u8])]) -> Vec<u8> {
        let mut cursor = std::io::Cursor::new(Vec::new());
        {
            let mut zip = zip::ZipWriter::new(&mut cursor);
            let stored = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);
            let deflated = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);
            zip.start_file("mimetype", stored).unwrap();
            zip.write_all(ODT_MIME.as_bytes()).unwrap();
            zip.start_file("content.xml", deflated).unwrap();
            zip.write_all(content.as_bytes()).unwrap();
            zip.start_file("styles.xml", deflated).unwrap();
            zip.write_all(styles.as_bytes()).unwrap();
            for (name, bytes) in extra {
                zip.start_file(*name, deflated).unwrap();
                zip.write_all(bytes).unwrap();
            }
            zip.finish().unwrap();
        }
        cursor.into_inner()
    }

    const NS: &str = r#"xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0""#;

    fn styles_xml() -> String {
        format!(
            r#"<?xml version="1.0" encoding="UTF-8"?><office:document-styles {NS}>
<office:font-face-decls><style:font-face style:name="Liberation Serif" svg:font-family="'Liberation Serif'"/></office:font-face-decls>
<office:styles>
<style:default-style style:family="paragraph"><style:text-properties style:font-name="Liberation Serif" fo:font-size="12pt"/></style:default-style>
<style:style style:name="Standard" style:family="paragraph"/>
<style:style style:name="Heading_20_1" style:display-name="Heading 1" style:family="paragraph" style:parent-style-name="Standard"><style:text-properties fo:font-size="18pt" fo:font-weight="bold"/></style:style>
<style:style style:name="Emphasis" style:family="text"><style:text-properties fo:font-style="italic"/></style:style>
<text:list-style style:name="L1"><text:list-level-style-bullet text:level="1" text:bullet-char="•"><style:list-level-properties text:list-level-position-and-space-mode="label-alignment"><style:list-level-label-alignment text:label-followed-by="listtab" fo:text-indent="-0.635cm" fo:margin-left="1.27cm"/></style:list-level-properties></text:list-level-style-bullet></text:list-style>
</office:styles>
<office:automatic-styles><style:page-layout style:name="pm1"><style:page-layout-properties fo:page-width="21cm" fo:page-height="29.7cm" fo:margin-top="2cm" fo:margin-bottom="2cm" fo:margin-left="2cm" fo:margin-right="2cm"/></style:page-layout></office:automatic-styles>
<office:master-styles><style:master-page style:name="Standard" style:page-layout-name="pm1"/></office:master-styles>
</office:document-styles>"#
        )
    }

    fn content(body: &str, auto: &str) -> String {
        format!(
            r#"<?xml version="1.0" encoding="UTF-8"?><office:document-content {NS}><office:automatic-styles>{auto}</office:automatic-styles><office:body><office:text>{body}</office:text></office:body></office:document-content>"#
        )
    }

    fn paragraphs(doc: &DocxDocument) -> Vec<&Paragraph> {
        doc.body
            .iter()
            .filter_map(|b| match b {
                Block::Paragraph(p) => Some(p),
                Block::Table(_) => None,
            })
            .collect()
    }

    fn text(p: &Paragraph) -> String {
        p.runs.iter().map(|r| r.text.as_str()).collect()
    }

    #[test]
    fn headings_paragraphs_spans_and_styles() {
        let auto = r##"<style:style style:name="P1" style:family="paragraph" style:parent-style-name="Standard"><style:paragraph-properties fo:text-align="center"/></style:style><style:style style:name="T1" style:family="text"><style:text-properties fo:font-weight="bold" fo:color="#ff0000"/></style:style>"##;
        let body = r#"<text:h text:style-name="Heading_20_1" text:outline-level="1">Title</text:h><text:p text:style-name="P1">Hello   <text:span text:style-name="T1">bold red</text:span><text:s text:c="2"/>and <text:span text:style-name="Emphasis">em</text:span><text:tab/>x<text:line-break/>y</text:p>"#;
        let bytes = odt(&content(body, auto), &styles_xml(), &[]);
        assert!(is_odt(&bytes));
        let read = read_odt(&bytes).unwrap();
        let ps = paragraphs(&read.doc);
        assert_eq!(ps.len(), 2);
        assert_eq!(ps[0].style_id.as_deref(), Some("Heading1"));
        assert_eq!(text(ps[0]), "Title");
        assert_eq!(ps[1].style_id.as_deref(), Some("Normal"));
        assert_eq!(ps[1].props.justification, Some(Justification::Center));
        assert_eq!(text(ps[1]), "Hello bold red  and em\tx\u{2028}y");
        let bold = ps[1].runs.iter().find(|r| r.text == "bold red").unwrap();
        assert_eq!(bold.props.bold, Some(true));
        assert_eq!(bold.props.color.as_deref(), Some("FF0000"));
        let em = ps[1].runs.iter().find(|r| r.text == "em").unwrap();
        assert_eq!(em.style_id.as_deref(), Some("Emphasis"));
        let h1 = read
            .doc
            .styles
            .styles
            .iter()
            .find(|s| s.style_id == "Heading1")
            .unwrap();
        assert_eq!(h1.name.as_deref(), Some("heading 1"));
        assert_eq!(h1.based_on.as_deref(), Some("Normal"));
        assert_eq!(h1.run.bold, Some(true));
        assert_eq!(h1.run.size_half_pts, Some(36));
        assert_eq!(
            read.doc.styles.doc_defaults.run.font.as_deref(),
            Some("Liberation Serif")
        );
        let s = &read.doc.sections[0];
        assert_eq!(s.page_width, 11906);
        assert_eq!(s.margin_left, 1134);
    }

    #[test]
    fn lists_and_tables() {
        let body = r#"<text:list text:style-name="L1"><text:list-item><text:p>One</text:p></text:list-item><text:list-item><text:p>Two</text:p><text:list><text:list-item><text:p>Two-a</text:p></text:list-item></text:list></text:list-item></text:list>
<table:table><table:table-column table:number-columns-repeated="2"/><table:table-header-rows><table:table-row><table:table-cell table:number-columns-spanned="2"><text:p>Head</text:p></table:table-cell><table:covered-table-cell/></table:table-row></table:table-header-rows>
<table:table-row><table:table-cell table:number-rows-spanned="2"><text:p>Tall</text:p></table:table-cell><table:table-cell><text:p>B1</text:p></table:table-cell></table:table-row>
<table:table-row><table:covered-table-cell/><table:table-cell><text:p>B2</text:p></table:table-cell></table:table-row></table:table>"#;
        let bytes = odt(&content(body, ""), &styles_xml(), &[]);
        let read = read_odt(&bytes).unwrap();
        let ps = paragraphs(&read.doc);
        assert_eq!(ps.len(), 3);
        let one = ps[0].list.as_ref().unwrap();
        assert_eq!(one.kind, ListKind::Bullet);
        assert_eq!(one.bullet_char.as_deref(), Some("\u{2022}"));
        assert_eq!(one.left_indent, Some(720));
        assert_eq!(one.hanging_indent, Some(360));
        assert_eq!(ps[2].list.as_ref().unwrap().level, 1);
        assert_eq!(ps[2].list.as_ref().unwrap().num_id, one.num_id);
        let Block::Table(t) = &read.doc.body[3] else {
            panic!("table expected")
        };
        assert_eq!(t.column_widths.len(), 2);
        assert_eq!(t.rows.len(), 3);
        assert!(t.rows[0].is_header);
        assert_eq!(t.rows[0].cells.len(), 1);
        assert_eq!(t.rows[0].cells[0].grid_span, 2);
        assert_eq!(t.rows[1].cells[0].v_merge, VMerge::Restart);
        assert_eq!(t.rows[2].cells.len(), 2);
        assert_eq!(t.rows[2].cells[0].v_merge, VMerge::Continue);
        assert_eq!(text(&t.rows[2].cells[1].paragraphs[0]), "B2");
    }

    #[test]
    fn pictures_links_and_left_out_content() {
        let png = b"\x89PNG\r\n\x1a\nodt-picture";
        let body = r#"<text:p>See <text:a xlink:href="https://paged.media/">paged</text:a><text:note><text:note-body><text:p>n</text:p></text:note-body></text:note><draw:frame svg:width="2.54cm" svg:height="1.27cm"><draw:image xlink:href="Pictures/a.png"/></draw:frame></text:p>"#;
        let bytes = odt(
            &content(body, ""),
            &styles_xml(),
            &[("Pictures/a.png", png.as_slice())],
        );
        let read = read_odt(&bytes).unwrap();
        let p = paragraphs(&read.doc)[0];
        let link = p.runs.iter().find(|r| r.text == "paged").unwrap();
        assert_eq!(link.hyperlink.as_deref(), Some("https://paged.media/"));
        let pic = p.runs.iter().find(|r| !r.images.is_empty()).unwrap();
        assert_eq!(pic.images[0].bytes, png.to_vec());
        assert_eq!(pic.images[0].width_emu, 1440 * 635);
        assert!(read.diagnostics.iter().any(|d| d.contains("note")));
        // The note's own text is not part of the paragraph.
        assert_eq!(text(p), "See paged");
    }

    #[test]
    fn not_odt_is_refused() {
        assert!(!is_odt(b"{\\rtf1}"));
        assert!(read_odt(b"PK\x03\x04garbage").is_err());
    }
}
