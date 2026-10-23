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

//! Cell-style AUTHORING (Wave 6): apply a [`StylePatch`] (number format, font,
//! fill, borders, alignment, wrap) to existing `cellXfs` records and keep
//! `styles.xml` in step.
//!
//! ## Mechanism
//!
//! Every write is a byte splice of `styles.xml` (`splice.rs`): a patched style
//! APPENDS the records it needs — a `<numFmt>`, `<font>`, `<fill>`,
//! `<border>` and finally the `<xf>` — at the end of their section, after
//! looking for an equal record first (dedup by canonical form, attribute
//! order ignored). Existing records are never rewritten, so every index a
//! cell, a `cellStyleXf`, a `dxf` or another part holds stays valid, and the
//! rest of the part (cell styles, dxfs, table styles, colours, extLst) is
//! untouched bytes.
//!
//! The model side follows by RE-PARSING the spliced part with the same
//! parser `open` uses ([`crate::parts::styles::parse`]): a new `StyleId` is
//! its new `cellXfs` index (positional ids), and the visual side table the
//! lowering reads is the parser's own output — so an authored style lowers
//! exactly like a loaded one.
//!
//! A package without a styles part gets one (Excel's minimal style sheet),
//! with its workbook relationship and content-type override.

use std::collections::{BTreeMap, BTreeSet};

use quick_xml::events::Event;
use sheet_core::{StyleId, StyleTable};

use crate::error::XlsxError;
use crate::opc::{ModeledKind, PartEntry};
use crate::parts::style_model::{
    doc_refs_attrs, doc_refs_of, StyleSheet, XfDocRefs, DOC_EXT_NS, DOC_EXT_URI,
};
use crate::parts::styles::{builtin_num_fmt, ColorAttrs, ColorContext};
use crate::parts::theme::ThemePalette;
use crate::rels::{parse_rels, part_dir, resolve_target};
use crate::splice::{
    attr_local, attrs_of, children_of, escape_attr, prefix_of, render_tag, root_children, set_attr,
    splice, Span,
};
use crate::XlsxDocument;
use sheet_core::visual::{
    builtin_style_name, CellFill, DocSwatchRef, GradientKind, PatternKind, UnderlineKind, VertAlign,
};

/// The styles part content type.
const CT_STYLES: &str = "application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml";
/// The workbook → styles relationship type.
const REL_STYLES_FULL: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles";

/// Excel's minimal style sheet: one font, the two reserved fills (`none`,
/// `gray125`), one empty border, the Normal cell style.
const MIN_STYLES: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>"#;

/// The `<styleSheet>` children in schema order (ECMA-376 §18.8.39).
const SECTION_ORDER: &[&str] = &[
    "numFmts",
    "fonts",
    "fills",
    "borders",
    "cellStyleXfs",
    "cellXfs",
    "cellStyles",
    "dxfs",
    "tableStyles",
    "colors",
    "extLst",
];

/// Excel's own `<font>` child order (CT_Font is an unordered choice, but
/// this is the order Excel writes and reads back unchanged).
const FONT_ORDER: &[&str] = &[
    "b",
    "i",
    "strike",
    "condense",
    "extend",
    "outline",
    "shadow",
    "u",
    "vertAlign",
    "sz",
    "color",
    "name",
    "family",
    "charset",
    "scheme",
];

/// The `<border>` child sequence (CT_Border).
const BORDER_ORDER: &[&str] = &[
    "start",
    "end",
    "left",
    "right",
    "top",
    "bottom",
    "diagonal",
    "vertical",
    "horizontal",
];

/// One border edge of a patch: an xlsx line style (`thin`, `medium`,
/// `thick`, `dashed`, `dotted`, `double`, `hair`, …; `none` removes the
/// line) and an optional `#RRGGBB` colour (`None` = automatic).
#[derive(Clone, Debug, PartialEq)]
pub struct EdgePatch {
    pub style: String,
    pub color: Option<String>,
    /// A document swatch the line colour references (W2.2): the concrete
    /// colour written is its `fallback_rgb`, the reference rides the
    /// record's paged extension.
    pub swatch: Option<DocSwatchRef>,
}

/// A gradient fill a patch sets (W2.2): `"linear"` at `degree`, or
/// `"path"` from the inner rectangle; stops `(position, #RRGGBB)`.
#[derive(Clone, Debug, PartialEq, Default)]
pub struct GradientPatch {
    pub kind: String,
    pub degree: f64,
    pub left: f64,
    pub right: f64,
    pub top: f64,
    pub bottom: f64,
    pub stops: Vec<(f64, String)>,
}

/// The W2.2 facets of a [`StylePatch`] (sheet ADR 518): the rest of the
/// cell visual model, document references and Excel named styles. Every
/// `Some` field is set; an EMPTY string clears a text field.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct StyleExt {
    /// A `patternFill` pattern (`solid`, `gray125`, `darkTrellis`, … the 18
    /// patterns, `none`); its foreground is `StylePatch::fill`, its
    /// background [`fill_bg`](Self::fill_bg).
    pub pattern: Option<String>,
    pub fill_bg: Option<String>,
    pub gradient: Option<GradientPatch>,
    pub border_diagonal: Option<EdgePatch>,
    pub diagonal_up: Option<bool>,
    pub diagonal_down: Option<bool>,
    /// Indent levels (0–250).
    pub indent: Option<u32>,
    /// `textRotation`: 0–180, 255 stacked.
    pub rotation: Option<u32>,
    pub shrink: Option<bool>,
    pub strike: Option<bool>,
    /// `baseline` / `superscript` / `subscript`.
    pub vert_align: Option<String>,
    /// `none` / `single` / `double` / `singleAccounting` / `doubleAccounting`.
    pub underline_style: Option<String>,
    /// The fill foreground as a document swatch.
    pub fill_swatch: Option<DocSwatchRef>,
    /// The pattern background as a document swatch.
    pub fill_bg_swatch: Option<DocSwatchRef>,
    /// The font colour as a document swatch.
    pub font_swatch: Option<DocSwatchRef>,
    /// Document character / paragraph / cell styles (empty clears).
    pub doc_char_style: Option<String>,
    pub doc_para_style: Option<String>,
    pub doc_cell_style: Option<String>,
    /// Apply an Excel named cell style by name (`Heading 1`, `Good`, …): a
    /// built-in the workbook lacks is added from Excel's definition.
    pub named_style: Option<String>,
}

impl StyleExt {
    fn touches_font(&self) -> bool {
        self.strike.is_some()
            || self.vert_align.is_some()
            || self.underline_style.is_some()
            || self.font_swatch.is_some()
    }

    fn touches_fill(&self) -> bool {
        self.pattern.is_some()
            || self.fill_bg.is_some()
            || self.gradient.is_some()
            || self.fill_swatch.is_some()
            || self.fill_bg_swatch.is_some()
    }

    fn touches_alignment(&self) -> bool {
        self.indent.is_some() || self.rotation.is_some() || self.shrink.is_some()
    }

    fn touches_border(&self) -> bool {
        self.border_diagonal.is_some() || self.diagonal_up.is_some() || self.diagonal_down.is_some()
    }
}

/// A partial cell style: every `Some` field is set, every `None` field is
/// left as the cell has it. Colours are `#RRGGBB`; an EMPTY colour string
/// clears it (no explicit font colour / no fill). `h_align` `"general"` and
/// `v_align` `"bottom"` are the defaults (they clear the attribute).
///
/// [`XlsxDocument::describe_style`] answers the same shape, fully populated.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct StylePatch {
    /// A number-format code (`"0.00"`, `"#,##0"`, `"yyyy-mm-dd"`, …).
    pub num_fmt: Option<String>,
    pub font_name: Option<String>,
    pub font_size: Option<f64>,
    pub bold: Option<bool>,
    pub italic: Option<bool>,
    pub underline: Option<bool>,
    pub font_color: Option<String>,
    pub fill: Option<String>,
    pub border_top: Option<EdgePatch>,
    pub border_right: Option<EdgePatch>,
    pub border_bottom: Option<EdgePatch>,
    pub border_left: Option<EdgePatch>,
    /// `general` / `left` / `center` / `right` / `justify` / `fill` /
    /// `centerContinuous` / `distributed`.
    pub h_align: Option<String>,
    /// `top` / `center` / `bottom` / `justify` / `distributed`.
    pub v_align: Option<String>,
    pub wrap: Option<bool>,
    /// Excel's quote prefix (`<xf quotePrefix="1">`): the cell's text was
    /// entered after a leading `'` (ruling `sheet.edit.typed-entry`).
    pub quote_prefix: Option<bool>,
    /// `<protection locked>`: a locked cell refuses an entry while its sheet
    /// is protected (Excel's default is locked; sheet ADR 517).
    pub locked: Option<bool>,
    /// `<protection hidden>`: the formula is not shown while the sheet is
    /// protected.
    pub formula_hidden: Option<bool>,
    /// The W2.2 facets (patterns, gradients, diagonals, indent, rotation,
    /// shrink, strike, super/subscript, underline kinds, document references,
    /// named styles).
    pub ext: StyleExt,
}

impl StylePatch {
    fn touches_font(&self) -> bool {
        self.font_name.is_some()
            || self.font_size.is_some()
            || self.bold.is_some()
            || self.italic.is_some()
            || self.underline.is_some()
            || self.font_color.is_some()
            || self.ext.touches_font()
    }

    fn edges(&self) -> [(&'static str, &Option<EdgePatch>); 4] {
        [
            ("top", &self.border_top),
            ("right", &self.border_right),
            ("bottom", &self.border_bottom),
            ("left", &self.border_left),
        ]
    }

    fn touches_border(&self) -> bool {
        self.edges().iter().any(|(_, e)| e.is_some()) || self.ext.touches_border()
    }

    fn touches_alignment(&self) -> bool {
        self.h_align.is_some()
            || self.v_align.is_some()
            || self.wrap.is_some()
            || self.ext.touches_alignment()
    }

    /// True when the patch sets nothing.
    pub fn is_empty(&self) -> bool {
        *self == StylePatch::default()
    }
}

// ───────────────────────────────────────────────────── a tiny element tree

/// A small owned XML element (style records are a few elements deep).
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Elem {
    /// The qualified name as written (prefix kept).
    pub(crate) name: String,
    pub(crate) attrs: Vec<(String, String)>,
    pub(crate) children: Vec<Elem>,
}

impl Elem {
    pub(crate) fn new(name: String) -> Elem {
        Elem {
            name,
            attrs: Vec::new(),
            children: Vec::new(),
        }
    }

    pub(crate) fn with_attr(mut self, k: &str, v: &str) -> Elem {
        self.attrs.push((k.to_string(), v.to_string()));
        self
    }

    pub(crate) fn local(&self) -> &str {
        self.name.rsplit(':').next().unwrap_or(&self.name)
    }

    pub(crate) fn attr(&self, local: &str) -> Option<String> {
        attr_local(&self.attrs, local)
    }

    pub(crate) fn set(&mut self, local: &str, v: Option<String>) {
        set_attr(&mut self.attrs, local, v);
    }

    pub(crate) fn child(&self, local: &str) -> Option<&Elem> {
        self.children.iter().find(|c| c.local() == local)
    }

    pub(crate) fn remove_children(&mut self, local: &str) {
        self.children.retain(|c| c.local() != local);
    }

    /// Stable-sort the children by `order` (unknown names last).
    fn order_children(&mut self, order: &[&str]) {
        let rank = |e: &Elem| {
            order
                .iter()
                .position(|n| *n == e.local())
                .unwrap_or(order.len())
        };
        self.children.sort_by_key(rank);
    }

    fn render(&self, out: &mut String) {
        if self.children.is_empty() {
            out.push_str(&render_tag(&self.name, &self.attrs, true));
        } else {
            out.push_str(&render_tag(&self.name, &self.attrs, false));
            for c in &self.children {
                c.render(out);
            }
            out.push_str("</");
            out.push_str(&self.name);
            out.push('>');
        }
    }

    pub(crate) fn to_xml(&self) -> String {
        let mut s = String::new();
        self.render(&mut s);
        s
    }

    /// The dedup key: local names, attributes sorted.
    fn canonical(&self) -> String {
        let mut attrs = self.attrs.clone();
        attrs.sort();
        let mut s = format!("<{}", self.local());
        for (k, v) in &attrs {
            s.push_str(&format!(" {k}=\"{}\"", escape_attr(v)));
        }
        s.push('>');
        for c in &self.children {
            s.push_str(&c.canonical());
        }
        s.push_str("</>");
        s
    }
}

/// Parse one element (the bytes of a span) into an [`Elem`] tree. Text and
/// comments are dropped — style records carry none.
pub(crate) fn parse_elem(xml: &[u8]) -> Result<Elem, XlsxError> {
    let mut reader = quick_xml::Reader::from_reader(xml);
    reader.config_mut().trim_text(false);
    let mut buf = Vec::new();
    let mut stack: Vec<Elem> = Vec::new();
    let to_elem = |e: &quick_xml::events::BytesStart<'_>| -> Result<Elem, XlsxError> {
        let mut el = Elem::new(String::from_utf8_lossy(e.name().as_ref()).into_owned());
        for a in e.attributes() {
            let a = a?;
            let k = String::from_utf8_lossy(a.key.as_ref()).into_owned();
            let v = a
                .normalized_value(quick_xml::XmlVersion::Implicit1_0)
                .map_err(XlsxError::Xml)?
                .into_owned();
            el.attrs.push((k, v));
        }
        Ok(el)
    };
    loop {
        match reader.read_event_into(&mut buf)? {
            Event::Start(e) => stack.push(to_elem(&e)?),
            Event::Empty(e) => {
                let el = to_elem(&e)?;
                match stack.last_mut() {
                    Some(parent) => parent.children.push(el),
                    None => return Ok(el),
                }
            }
            Event::End(_) => {
                let el = stack
                    .pop()
                    .ok_or_else(|| XlsxError::Structure("unbalanced style record".into()))?;
                match stack.last_mut() {
                    Some(parent) => parent.children.push(el),
                    None => return Ok(el),
                }
            }
            Event::Eof => {
                return Err(XlsxError::Structure("empty style record".into()));
            }
            _ => {}
        }
        buf.clear();
    }
}

// ───────────────────────────────────────────────────── part-level splices

/// The `<styleSheet>` element prefix (`""` or `"x:"`), so appended records
/// land in the part's own namespace binding.
fn root_prefix(xml: &[u8]) -> Result<String, XlsxError> {
    let mut reader = quick_xml::Reader::from_reader(xml);
    let mut buf = Vec::new();
    loop {
        match reader.read_event_into(&mut buf)? {
            Event::Start(e) | Event::Empty(e) => {
                let q = String::from_utf8_lossy(e.name().as_ref()).into_owned();
                return Ok(prefix_of(&q).to_string());
            }
            Event::Eof => return Ok(String::new()),
            _ => {}
        }
        buf.clear();
    }
}

/// The root child named `local`, if present.
fn section(xml: &[u8], local: &str) -> Result<Option<Span>, XlsxError> {
    let (kids, _) = root_children(xml)?;
    Ok(kids.into_iter().find(|k| k.local == local))
}

/// Make sure section `local` exists in open/close form (`<fonts></fonts>`),
/// inserting it at its schema position. Returns the new bytes.
fn ensure_section(xml: Vec<u8>, local: &str, prefix: &str) -> Result<Vec<u8>, XlsxError> {
    let (kids, root_close) = root_children(&xml)?;
    if let Some(sec) = kids.iter().find(|k| k.local == local) {
        if !sec.empty {
            return Ok(xml);
        }
        // `<fonts count="0"/>` → open/close form.
        let attrs = attrs_of(&xml, sec)?;
        let open = render_tag(&sec.qname, &attrs, false);
        let new = format!("{open}</{}>", sec.qname);
        return Ok(splice(&xml, sec.start, sec.end, new.as_bytes()));
    }
    let rank = SECTION_ORDER.iter().position(|n| *n == local).unwrap_or(0);
    let at = kids
        .iter()
        .find(|k| {
            SECTION_ORDER
                .iter()
                .position(|n| *n == k.local)
                .is_some_and(|r| r > rank)
        })
        .map(|k| k.start)
        .unwrap_or(root_close);
    let new = format!("<{prefix}{local} count=\"0\"></{prefix}{local}>");
    Ok(splice(&xml, at, at, new.as_bytes()))
}

/// The record spans (children named `rec`) of section `sec`.
fn records(xml: &[u8], sec: &Span, rec: &str) -> Result<Vec<Span>, XlsxError> {
    let (items, _) = children_of(xml, sec)?;
    Ok(items.into_iter().filter(|s| s.local == rec).collect())
}

/// Parse record `index` of section `sec_local` (`None` when absent).
fn record(xml: &[u8], sec_local: &str, rec: &str, index: usize) -> Result<Option<Elem>, XlsxError> {
    let Some(sec) = section(xml, sec_local)? else {
        return Ok(None);
    };
    let recs = records(xml, &sec, rec)?;
    match recs.get(index) {
        Some(sp) => Ok(Some(parse_elem(&xml[sp.start..sp.end])?)),
        None => Ok(None),
    }
}

/// Find a record equal to `el` in section `sec_local`, or append it (and
/// bump the section's `count`). Returns `(bytes, index)`.
fn find_or_append(
    xml: Vec<u8>,
    sec_local: &str,
    rec: &str,
    el: &Elem,
    prefix: &str,
) -> Result<(Vec<u8>, usize), XlsxError> {
    let xml = ensure_section(xml, sec_local, prefix)?;
    let sec = section(&xml, sec_local)?.expect("ensured");
    let recs = records(&xml, &sec, rec)?;
    let want = el.canonical();
    for (i, sp) in recs.iter().enumerate() {
        if parse_elem(&xml[sp.start..sp.end])?.canonical() == want {
            return Ok((xml, i));
        }
    }
    let index = recs.len();
    // Append before the section's end tag, then rewrite its `count`.
    let close_at = sec.end - format!("</{}>", sec.qname).len();
    let xml = splice(&xml, close_at, close_at, el.to_xml().as_bytes());
    let mut attrs = attrs_of(&xml, &sec)?;
    set_attr(&mut attrs, "count", Some((index + 1).to_string()));
    let tag = render_tag(&sec.qname, &attrs, false);
    let xml = splice(&xml, sec.start, sec.tag_end, tag.as_bytes());
    Ok((xml, index))
}

/// `#RRGGBB` → the xlsx `FFRRGGBB` ARGB form.
fn argb(rgb: &str) -> Result<String, XlsxError> {
    let hex = rgb.trim().trim_start_matches('#');
    if hex.len() == 6 && hex.chars().all(|c| c.is_ascii_hexdigit()) {
        Ok(format!("FF{}", hex.to_ascii_uppercase()))
    } else {
        Err(XlsxError::Structure(format!(
            "colour {rgb:?} is not #RRGGBB"
        )))
    }
}

/// The numFmtId for a format code: a built-in id when the code is one, an
/// existing custom id with the same code, or a new custom `<numFmt>`.
fn num_fmt_id(xml: Vec<u8>, code: &str, prefix: &str) -> Result<(Vec<u8>, u32), XlsxError> {
    if let Some(id) = (0..=49).find(|&i| builtin_num_fmt(i) == Some(code)) {
        return Ok((xml, id));
    }
    let mut max_custom = 163;
    if let Some(sec) = section(&xml, "numFmts")? {
        for sp in records(&xml, &sec, "numFmt")? {
            let a = attrs_of(&xml, &sp)?;
            let id = attr_local(&a, "numFmtId").and_then(|s| s.parse::<u32>().ok());
            if let Some(id) = id {
                if attr_local(&a, "formatCode").as_deref() == Some(code) {
                    return Ok((xml, id));
                }
                max_custom = max_custom.max(id);
            }
        }
    }
    let id = max_custom + 1;
    let el = Elem::new(format!("{prefix}numFmt"))
        .with_attr("numFmtId", &id.to_string())
        .with_attr("formatCode", code);
    let (xml, _) = find_or_append(xml, "numFmts", "numFmt", &el, prefix)?;
    Ok((xml, id))
}

/// The `<font>` a patch asks for, built from the base font.
fn patched_font(mut font: Elem, p: &StylePatch, prefix: &str) -> Result<Elem, XlsxError> {
    let flag = |font: &mut Elem, local: &str, on: Option<bool>| {
        if let Some(on) = on {
            font.remove_children(local);
            if on {
                font.children.push(Elem::new(format!("{prefix}{local}")));
            }
        }
    };
    flag(&mut font, "b", p.bold);
    flag(&mut font, "i", p.italic);
    flag(&mut font, "u", p.underline);
    if let Some(sz) = p.font_size {
        if !(sz.is_finite() && sz > 0.0 && sz <= 409.0) {
            return Err(XlsxError::Structure(format!("font size {sz} out of range")));
        }
        font.remove_children("sz");
        font.children
            .push(Elem::new(format!("{prefix}sz")).with_attr("val", &fmt_num(sz)));
    }
    if let Some(name) = &p.font_name {
        if name.trim().is_empty() {
            return Err(XlsxError::Structure("empty font name".into()));
        }
        font.remove_children("name");
        // A theme font (`<scheme val="minor"/>`) makes Excel ignore `name`.
        font.remove_children("scheme");
        font.children
            .push(Elem::new(format!("{prefix}name")).with_attr("val", name));
    }
    if let Some(color) = &p.font_color {
        font.remove_children("color");
        if !color.is_empty() {
            font.children
                .push(Elem::new(format!("{prefix}color")).with_attr("rgb", &argb(color)?));
        }
    }
    let x = &p.ext;
    if let Some(sw) = &x.font_swatch {
        font.remove_children("color");
        font.children
            .push(Elem::new(format!("{prefix}color")).with_attr("rgb", &argb_of(sw.fallback_rgb)));
    }
    flag(&mut font, "strike", x.strike);
    if let Some(v) = &x.vert_align {
        if !matches!(v.as_str(), "baseline" | "superscript" | "subscript") {
            return Err(XlsxError::Structure(format!(
                "vertical text alignment {v:?}"
            )));
        }
        font.remove_children("vertAlign");
        if v != "baseline" {
            font.children
                .push(Elem::new(format!("{prefix}vertAlign")).with_attr("val", v));
        }
    }
    if let Some(u) = &x.underline_style {
        let kind = UnderlineKind::parse(Some(u.as_str()));
        if kind == UnderlineKind::None && u != "none" {
            return Err(XlsxError::Structure(format!("underline {u:?}")));
        }
        font.remove_children("u");
        match kind {
            UnderlineKind::None => {}
            UnderlineKind::Single => font.children.push(Elem::new(format!("{prefix}u"))),
            k => font.children.push(
                Elem::new(format!("{prefix}u")).with_attr("val", k.as_xlsx().unwrap_or("single")),
            ),
        }
    }
    font.order_children(FONT_ORDER);
    Ok(font)
}

/// `(r, g, b)` → `FFRRGGBB`.
fn argb_of((r, g, b): (u8, u8, u8)) -> String {
    format!("FF{r:02X}{g:02X}{b:02X}")
}

/// The `<fill>` a patch asks for (`None` = the reserved `none` fill 0), from
/// the base fill: a pattern (solid unless the patch names one) with its
/// foreground and background, or a gradient.
fn patched_fill(
    base: Option<Elem>,
    p: &StylePatch,
    prefix: &str,
) -> Result<Option<Elem>, XlsxError> {
    let x = &p.ext;
    if let Some(g) = &x.gradient {
        let mut gf = Elem::new(format!("{prefix}gradientFill"));
        if g.kind == "path" {
            gf = gf
                .with_attr("type", "path")
                .with_attr("left", &fmt_num(g.left))
                .with_attr("right", &fmt_num(g.right))
                .with_attr("top", &fmt_num(g.top))
                .with_attr("bottom", &fmt_num(g.bottom));
        } else if g.degree != 0.0 {
            gf = gf.with_attr("degree", &fmt_num(g.degree));
        }
        if g.stops.len() < 2 {
            return Err(XlsxError::Structure("a gradient needs two stops".into()));
        }
        for (pos, c) in &g.stops {
            let mut st = Elem::new(format!("{prefix}stop")).with_attr("position", &fmt_num(*pos));
            st.children
                .push(Elem::new(format!("{prefix}color")).with_attr("rgb", &argb(c)?));
            gf.children.push(st);
        }
        let mut fill = Elem::new(format!("{prefix}fill"));
        fill.children.push(gf);
        return Ok(Some(fill));
    }
    // The base pattern's colours carry over unless the patch sets them.
    let base_pf = base.as_ref().and_then(|f| f.child("patternFill")).cloned();
    let base_type = base_pf.as_ref().and_then(|pf| pf.attr("patternType"));
    let fg_color = |c: &Elem| c.clone();
    let mut fg = base_pf
        .as_ref()
        .and_then(|pf| pf.child("fgColor"))
        .map(fg_color);
    let mut bg = base_pf
        .as_ref()
        .and_then(|pf| pf.child("bgColor"))
        .map(fg_color);
    if let Some(c) = &p.fill {
        if c.is_empty() && x.pattern.is_none() {
            return Ok(None);
        }
        fg = (!c.is_empty())
            .then(|| argb(c))
            .transpose()?
            .map(|a| Elem::new(format!("{prefix}fgColor")).with_attr("rgb", &a));
    }
    if let Some(sw) = &x.fill_swatch {
        fg =
            Some(Elem::new(format!("{prefix}fgColor")).with_attr("rgb", &argb_of(sw.fallback_rgb)));
    }
    if let Some(c) = &x.fill_bg {
        bg = (!c.is_empty())
            .then(|| argb(c))
            .transpose()?
            .map(|a| Elem::new(format!("{prefix}bgColor")).with_attr("rgb", &a));
    }
    if let Some(sw) = &x.fill_bg_swatch {
        bg =
            Some(Elem::new(format!("{prefix}bgColor")).with_attr("rgb", &argb_of(sw.fallback_rgb)));
    }
    let pattern = match &x.pattern {
        Some(t) => {
            if PatternKind::parse(t).is_none() {
                return Err(XlsxError::Structure(format!("fill pattern {t:?}")));
            }
            t.clone()
        }
        None => match base_type.as_deref() {
            Some(t) if t != "none" && t != "solid" && base.is_some() => t.to_string(),
            _ => "solid".to_string(),
        },
    };
    if pattern == "none" {
        return Ok(None);
    }
    let mut pf = Elem::new(format!("{prefix}patternFill")).with_attr("patternType", &pattern);
    if let Some(fg) = fg {
        pf.children.push(fg);
    }
    match bg {
        Some(bg) => pf.children.push(bg),
        None if pattern == "solid" => pf
            .children
            .push(Elem::new(format!("{prefix}bgColor")).with_attr("indexed", "64")),
        None => {}
    }
    let mut fill = Elem::new(format!("{prefix}fill"));
    fill.children.push(pf);
    Ok(Some(fill))
}

/// The `<border>` a patch asks for, built from the base border.
fn patched_border(mut border: Elem, p: &StylePatch, prefix: &str) -> Result<Elem, XlsxError> {
    let diagonal = [("diagonal", &p.ext.border_diagonal)];
    for (edge, patch) in p.edges().into_iter().chain(diagonal) {
        let Some(patch) = patch else { continue };
        border.remove_children(edge);
        let mut el = Elem::new(format!("{prefix}{edge}"));
        if patch.style != "none" {
            if !VALID_BORDER_STYLES.contains(&patch.style.as_str()) {
                return Err(XlsxError::Structure(format!(
                    "border style {:?} is not an xlsx line style",
                    patch.style
                )));
            }
            el.attrs.push(("style".into(), patch.style.clone()));
            let color = match (&patch.swatch, &patch.color) {
                (Some(sw), _) => {
                    Elem::new(format!("{prefix}color")).with_attr("rgb", &argb_of(sw.fallback_rgb))
                }
                (None, Some(c)) if !c.is_empty() => {
                    Elem::new(format!("{prefix}color")).with_attr("rgb", &argb(c)?)
                }
                _ => Elem::new(format!("{prefix}color")).with_attr("auto", "1"),
            };
            el.children.push(color);
        }
        border.children.push(el);
    }
    if let Some(up) = p.ext.diagonal_up {
        border.set("diagonalUp", up.then(|| "1".to_string()));
    }
    if let Some(down) = p.ext.diagonal_down {
        border.set("diagonalDown", down.then(|| "1".to_string()));
    }
    // Excel always writes the five CT_Border edges.
    for edge in ["left", "right", "top", "bottom", "diagonal"] {
        if border.child(edge).is_none() {
            border.children.push(Elem::new(format!("{prefix}{edge}")));
        }
    }
    border.order_children(BORDER_ORDER);
    Ok(border)
}

/// The xlsx line styles (ST_BorderStyle) a patch may name.
const VALID_BORDER_STYLES: &[&str] = &[
    "thin",
    "medium",
    "thick",
    "dashed",
    "dotted",
    "double",
    "hair",
    "mediumDashed",
    "dashDot",
    "mediumDashDot",
    "dashDotDot",
    "mediumDashDotDot",
    "slantDashDot",
];

const H_ALIGNS: &[&str] = &[
    "general",
    "left",
    "center",
    "right",
    "fill",
    "justify",
    "centerContinuous",
    "distributed",
];
const V_ALIGNS: &[&str] = &["top", "center", "bottom", "justify", "distributed"];

/// Format a number attribute without a trailing `.0`.
fn fmt_num(n: f64) -> String {
    if n.fract() == 0.0 {
        format!("{}", n as i64)
    } else {
        format!("{n}")
    }
}

/// Apply `patch` to `cellXfs[base]`, returning the new bytes and the index
/// of the (found or appended) resulting `<xf>`.
fn apply_to_xf(xml: Vec<u8>, base: usize, p: &StylePatch) -> Result<(Vec<u8>, usize), XlsxError> {
    let prefix = root_prefix(&xml)?;
    let mut xml = xml;
    if let Some(name) = &p.ext.named_style {
        xml = ensure_named_style(xml, name, &prefix)?;
    }
    let mut xf = match record(&xml, "cellXfs", "xf", base)? {
        Some(x) => x,
        None => record(&xml, "cellXfs", "xf", 0)?.unwrap_or_else(|| {
            Elem::new(format!("{prefix}xf"))
                .with_attr("numFmtId", "0")
                .with_attr("fontId", "0")
                .with_attr("fillId", "0")
                .with_attr("borderId", "0")
                .with_attr("xfId", "0")
        }),
    };
    let idx_of =
        |xf: &Elem, k: &str| -> usize { xf.attr(k).and_then(|s| s.parse().ok()).unwrap_or(0) };

    // An Excel named style: the record takes the style's formatting and
    // derives from it (`xfId`), as Excel's Cell Styles gallery applies it;
    // the patch's other facets then apply on top.
    if let Some(name) = &p.ext.named_style {
        let (xf_id, style_xf) = named_style_record(&xml, name)?;
        for k in ["numFmtId", "fontId", "fillId", "borderId"] {
            xf.set(k, Some(style_xf.attr(k).unwrap_or_else(|| "0".into())));
        }
        xf.set("xfId", Some(xf_id.to_string()));
        xf.remove_children("alignment");
        if let Some(al) = style_xf.child("alignment") {
            xf.children.insert(0, al.clone());
        }
    }

    if let Some(code) = &p.num_fmt {
        if code.is_empty() {
            return Err(XlsxError::Structure("empty number format".into()));
        }
        let (x, id) = num_fmt_id(xml, code, &prefix)?;
        xml = x;
        xf.set("numFmtId", Some(id.to_string()));
        xf.set("applyNumberFormat", Some("1".into()));
    }

    if p.touches_font() {
        let base_font = record(&xml, "fonts", "font", idx_of(&xf, "fontId"))?
            .unwrap_or_else(|| Elem::new(format!("{prefix}font")));
        let font = patched_font(base_font, p, &prefix)?;
        let (x, id) = find_or_append(xml, "fonts", "font", &font, &prefix)?;
        xml = x;
        xf.set("fontId", Some(id.to_string()));
        xf.set("applyFont", Some("1".into()));
    }

    if p.fill.is_some() || p.ext.touches_fill() {
        let base_fill = record(&xml, "fills", "fill", idx_of(&xf, "fillId"))?;
        let id = match patched_fill(base_fill, p, &prefix)? {
            None => 0, // the reserved `none` fill
            Some(el) => {
                let (x, id) = find_or_append(xml, "fills", "fill", &el, &prefix)?;
                xml = x;
                id
            }
        };
        xf.set("fillId", Some(id.to_string()));
        xf.set("applyFill", Some("1".into()));
    }

    if p.touches_border() {
        let base_border = record(&xml, "borders", "border", idx_of(&xf, "borderId"))?
            .unwrap_or_else(|| Elem::new(format!("{prefix}border")));
        let border = patched_border(base_border, p, &prefix)?;
        let (x, id) = find_or_append(xml, "borders", "border", &border, &prefix)?;
        xml = x;
        xf.set("borderId", Some(id.to_string()));
        xf.set("applyBorder", Some("1".into()));
    }

    if p.touches_alignment() {
        let mut al = xf
            .child("alignment")
            .cloned()
            .unwrap_or_else(|| Elem::new(format!("{prefix}alignment")));
        if let Some(h) = &p.h_align {
            if !H_ALIGNS.contains(&h.as_str()) {
                return Err(XlsxError::Structure(format!("horizontal alignment {h:?}")));
            }
            al.set("horizontal", (h != "general").then(|| h.clone()));
        }
        if let Some(v) = &p.v_align {
            if !V_ALIGNS.contains(&v.as_str()) {
                return Err(XlsxError::Structure(format!("vertical alignment {v:?}")));
            }
            al.set("vertical", (v != "bottom").then(|| v.clone()));
        }
        if let Some(w) = p.wrap {
            al.set("wrapText", w.then(|| "1".to_string()));
        }
        if let Some(i) = p.ext.indent {
            if i > 250 {
                return Err(XlsxError::Structure(format!("indent {i} out of range")));
            }
            al.set("indent", (i > 0).then(|| i.to_string()));
        }
        if let Some(r) = p.ext.rotation {
            if r > 180 && r != 255 {
                return Err(XlsxError::Structure(format!(
                    "text rotation {r} out of range"
                )));
            }
            al.set("textRotation", (r > 0).then(|| r.to_string()));
        }
        if let Some(sh) = p.ext.shrink {
            al.set("shrinkToFit", sh.then(|| "1".to_string()));
        }
        xf.remove_children("alignment");
        if !al.attrs.is_empty() {
            // CT_Xf: alignment comes first (then protection, extLst).
            xf.children.insert(0, al);
        }
        xf.set("applyAlignment", Some("1".into()));
    }

    if let Some(q) = p.quote_prefix {
        xf.set("quotePrefix", q.then(|| "1".to_string()));
    }

    if p.locked.is_some() || p.formula_hidden.is_some() {
        let mut pr = xf
            .child("protection")
            .cloned()
            .unwrap_or_else(|| Elem::new(format!("{prefix}protection")));
        if let Some(l) = p.locked {
            // Locked is the default: only an unlocked cell says so.
            pr.set("locked", (!l).then(|| "0".to_string()));
        }
        if let Some(h) = p.formula_hidden {
            pr.set("hidden", h.then(|| "1".to_string()));
        }
        xf.remove_children("protection");
        if !pr.attrs.is_empty() {
            // CT_Xf: alignment, protection, extLst.
            let at = usize::from(xf.child("alignment").is_some());
            xf.children.insert(at, pr);
        }
        xf.set("applyProtection", Some("1".into()));
    }

    // Document references (the record's paged extension): what the patch
    // sets replaces, a plain colour on the same facet clears.
    let mut refs = xf_doc_refs(&xf);
    let before = refs.clone();
    update_doc_refs(&mut refs, p);
    if refs != before {
        set_xf_doc_refs(&mut xf, &refs, &prefix);
    }

    find_or_append(xml, "cellXfs", "xf", &xf, &prefix)
}

/// The document references of an `<xf>` (its paged extension).
fn xf_doc_refs(xf: &Elem) -> XfDocRefs {
    xf.child("extLst")
        .and_then(|l| {
            l.children
                .iter()
                .find(|e| e.local() == "ext" && e.attr("uri").as_deref() == Some(DOC_EXT_URI))
        })
        .and_then(|e| e.children.iter().find(|c| c.local() == "doc"))
        .map(doc_refs_of)
        .unwrap_or_default()
}

/// Apply a patch's colour and style facets to the references.
fn update_doc_refs(refs: &mut XfDocRefs, p: &StylePatch) {
    let x = &p.ext;
    if p.fill.is_some() || x.gradient.is_some() {
        refs.fill_fg = None;
    }
    if x.fill_bg.is_some() || x.gradient.is_some() {
        refs.fill_bg = None;
    }
    if let Some(sw) = &x.fill_swatch {
        refs.fill_fg = Some(sw.clone());
    }
    if let Some(sw) = &x.fill_bg_swatch {
        refs.fill_bg = Some(sw.clone());
    }
    if p.font_color.is_some() {
        refs.font_color = None;
    }
    if let Some(sw) = &x.font_swatch {
        refs.font_color = Some(sw.clone());
    }
    let diagonal = [("diagonal", &x.border_diagonal)];
    for (edge, e) in p.edges().into_iter().chain(diagonal) {
        if let Some(e) = e {
            match &e.swatch {
                Some(sw) if e.style != "none" => {
                    refs.border.insert(edge.to_string(), sw.clone());
                }
                _ => {
                    refs.border.remove(edge);
                }
            }
        }
    }
    let text = |v: &Option<String>, slot: &mut Option<String>| {
        if let Some(v) = v {
            *slot = (!v.is_empty()).then(|| v.clone());
        }
    };
    text(&x.doc_char_style, &mut refs.char_style);
    text(&x.doc_para_style, &mut refs.para_style);
    text(&x.doc_cell_style, &mut refs.cell_style);
}

/// Write the references into the `<xf>`'s `extLst` (dropping the paged
/// extension when there are none; other extensions stay).
fn set_xf_doc_refs(xf: &mut Elem, refs: &XfDocRefs, prefix: &str) {
    let mut lst = xf
        .child("extLst")
        .cloned()
        .unwrap_or_else(|| Elem::new(format!("{prefix}extLst")));
    lst.children
        .retain(|e| !(e.local() == "ext" && e.attr("uri").as_deref() == Some(DOC_EXT_URI)));
    if !refs.is_empty() {
        let mut doc = Elem::new("pg:doc".to_string());
        doc.attrs = doc_refs_attrs(refs);
        let mut ext = Elem::new(format!("{prefix}ext"))
            .with_attr("uri", DOC_EXT_URI)
            .with_attr("xmlns:pg", DOC_EXT_NS);
        ext.children.push(doc);
        lst.children.push(ext);
    }
    xf.remove_children("extLst");
    if !lst.children.is_empty() {
        // CT_Xf: alignment, protection, extLst — the extension list is last.
        xf.children.push(lst);
    }
}

// ───────────────────────────────────────────────────── named cell styles

/// Excel's built-in cell styles as data (Office theme, Excel 2013+): name,
/// `builtinId`, and the `<font>` / `<fill>` / `<border>` children and number
/// format the style record carries. `{p}` is the part's prefix.
fn builtin_style_def(name: &str) -> Option<(u32, String, String, String, Option<&'static str>)> {
    let id = (0..=53).find(|&i| builtin_style_name(i) == Some(name))?;
    let font = |inner: &str| {
        format!("<{{p}}font>{inner}<{{p}}sz val=\"11\"/><{{p}}name val=\"Calibri\"/><{{p}}family val=\"2\"/><{{p}}scheme val=\"minor\"/></{{p}}font>")
    };
    let font_c = |inner: &str, color: &str| font(&format!("{inner}<{{p}}color {color}/>"));
    let solid = |color: &str| {
        format!("<{{p}}fill><{{p}}patternFill patternType=\"solid\"><{{p}}fgColor {color}/><{{p}}bgColor indexed=\"64\"/></{{p}}patternFill></{{p}}fill>")
    };
    let none_fill = "<{p}fill><{p}patternFill patternType=\"none\"/></{p}fill>".to_string();
    let edges = |l: &str, r: &str, t: &str, b: &str| {
        format!(
            "<{{p}}border>{}{}{}{}<{{p}}diagonal/></{{p}}border>",
            edge("left", l),
            edge("right", r),
            edge("top", t),
            edge("bottom", b)
        )
    };
    fn edge(n: &str, spec: &str) -> String {
        match spec.split_once(':') {
            Some((style, color)) => {
                format!("<{{p}}{n} style=\"{style}\"><{{p}}color {color}/></{{p}}{n}>")
            }
            None => format!("<{{p}}{n}/>"),
        }
    }
    let no_border = edges("", "", "", "");
    let all = |spec: &str| edges(spec, spec, spec, spec);
    let (f, fl, b, nf): (String, String, String, Option<&'static str>) = match id {
        0 => (font(""), none_fill, no_border, None),
        3 => (font(""), none_fill, no_border, Some("_(* #,##0.00_);_(* \\(#,##0.00\\);_(* \"-\"??_);_(@_)")),
        4 => (font(""), none_fill, no_border, Some("_(\"$\"* #,##0.00_);_(\"$\"* \\(#,##0.00\\);_(\"$\"* \"-\"??_);_(@_)")),
        5 => (font(""), none_fill, no_border, Some("0%")),
        6 => (font(""), none_fill, no_border, Some("_(* #,##0_);_(* \\(#,##0\\);_(* \"-\"_);_(@_)")),
        7 => (font(""), none_fill, no_border, Some("_(\"$\"* #,##0_);_(\"$\"* \\(#,##0\\);_(\"$\"* \"-\"_);_(@_)")),
        8 => (font_c("<{p}u/>", "theme=\"10\""), none_fill, no_border, None),
        9 => (font_c("<{p}u/>", "theme=\"11\""), none_fill, no_border, None),
        10 => (font(""), solid("rgb=\"FFFFFFCC\""), all("thin:rgb=\"FFB2B2B2\""), None),
        11 => (font_c("", "rgb=\"FFFF0000\""), none_fill, no_border, None),
        15 => (
            "<{p}font><{p}sz val=\"18\"/><{p}color theme=\"3\"/><{p}name val=\"Calibri Light\"/><{p}family val=\"2\"/><{p}scheme val=\"major\"/></{p}font>".to_string(),
            none_fill,
            no_border,
            None,
        ),
        16 => (
            "<{p}font><{p}b/><{p}sz val=\"15\"/><{p}color theme=\"3\"/><{p}name val=\"Calibri\"/><{p}family val=\"2\"/><{p}scheme val=\"minor\"/></{p}font>".to_string(),
            none_fill,
            edges("", "", "", "thick:theme=\"4\""),
            None,
        ),
        17 => (
            "<{p}font><{p}b/><{p}sz val=\"13\"/><{p}color theme=\"3\"/><{p}name val=\"Calibri\"/><{p}family val=\"2\"/><{p}scheme val=\"minor\"/></{p}font>".to_string(),
            none_fill,
            edges("", "", "", "thick:theme=\"4\" tint=\"0.499984740745262\""),
            None,
        ),
        18 => (font_c("<{p}b/>", "theme=\"3\""), none_fill, edges("", "", "", "medium:theme=\"4\" tint=\"0.39997558519241921\""), None),
        19 => (font_c("<{p}b/>", "theme=\"3\""), none_fill, no_border, None),
        20 => (font_c("", "rgb=\"FF3F3F76\""), solid("rgb=\"FFFFCC99\""), all("thin:rgb=\"FF7F7F7F\""), None),
        21 => (font_c("<{p}b/>", "rgb=\"FF3F3F3F\""), solid("rgb=\"FFF2F2F2\""), all("thin:rgb=\"FF3F3F3F\""), None),
        22 => (font_c("<{p}b/>", "rgb=\"FFFA7D00\""), solid("rgb=\"FFF2F2F2\""), all("thin:rgb=\"FF7F7F7F\""), None),
        23 => (font_c("<{p}b/>", "theme=\"0\""), solid("rgb=\"FFA5A5A5\""), all("double:rgb=\"FF3F3F3F\""), None),
        24 => (font_c("", "rgb=\"FFFA7D00\""), none_fill, edges("", "", "", "double:rgb=\"FFFF8001\""), None),
        25 => (font_c("<{p}b/>", "theme=\"1\""), none_fill, edges("", "", "thin:theme=\"4\"", "double:theme=\"4\""), None),
        26 => (font_c("", "rgb=\"FF006100\""), solid("rgb=\"FFC6EFCE\""), no_border, None),
        27 => (font_c("", "rgb=\"FF9C0006\""), solid("rgb=\"FFFFC7CE\""), no_border, None),
        28 => (font_c("", "rgb=\"FF9C5700\""), solid("rgb=\"FFFFEB9C\""), no_border, None),
        53 => (font_c("<{p}i/>", "rgb=\"FF7F7F7F\""), none_fill, no_border, None),
        29..=52 => {
            // Accent1–6 and their 20 % / 40 % / 60 % tints.
            let k = id - 29;
            let theme = 4 + k / 4;
            let (tint, white) = match k % 4 {
                0 => (None, true),
                1 => (Some("0.79998168889431442"), false),
                2 => (Some("0.59999389629810485"), false),
                _ => (Some("0.39997558519241921"), true),
            };
            let color = match tint {
                Some(t) => format!("theme=\"{theme}\" tint=\"{t}\""),
                None => format!("theme=\"{theme}\""),
            };
            let f = if white { font_c("", "theme=\"0\"") } else { font_c("", "theme=\"1\"") };
            (f, solid(&color), no_border, None)
        }
        _ => (font(""), none_fill, no_border, None),
    };
    Some((id, f, fl, b, nf))
}

/// Make sure the workbook carries the named style `name` (a built-in it
/// lacks is added: its font, fill and border records, a `cellStyleXfs`
/// record and the `cellStyle` entry). An unknown non-built-in name fails.
fn ensure_named_style(xml: Vec<u8>, name: &str, prefix: &str) -> Result<Vec<u8>, XlsxError> {
    if named_style_record(&xml, name).is_ok() {
        return Ok(xml);
    }
    let Some((builtin, font, fill, border, num_fmt)) = builtin_style_def(name) else {
        return Err(XlsxError::Structure(format!(
            "no cell style named {name:?}"
        )));
    };
    let el = |s: &str| parse_elem(s.replace("{p}", prefix).as_bytes());
    let (xml, font_id) = find_or_append(xml, "fonts", "font", &el(&font)?, prefix)?;
    let (xml, fill_id) = find_or_append(xml, "fills", "fill", &el(&fill)?, prefix)?;
    let (xml, border_id) = find_or_append(xml, "borders", "border", &el(&border)?, prefix)?;
    let (xml, fmt_id) = match num_fmt {
        Some(code) => num_fmt_id(xml, code, prefix)?,
        None => (xml, 0),
    };
    let mut sxf = Elem::new(format!("{prefix}xf"))
        .with_attr("numFmtId", &fmt_id.to_string())
        .with_attr("fontId", &font_id.to_string())
        .with_attr("fillId", &fill_id.to_string())
        .with_attr("borderId", &border_id.to_string());
    for (k, on) in [
        ("applyNumberFormat", num_fmt.is_some()),
        ("applyBorder", border_id != 0),
        ("applyFill", fill_id != 0),
    ] {
        if !on {
            sxf.attrs.push((k.into(), "0".into()));
        }
    }
    // A new record at the END of cellStyleXfs (existing indices stay).
    let xml = ensure_section(xml, "cellStyleXfs", prefix)?;
    let sec = section(&xml, "cellStyleXfs")?.expect("ensured");
    let xf_id = records(&xml, &sec, "xf")?.len();
    let close_at = sec.end - format!("</{}>", sec.qname).len();
    let xml = splice(&xml, close_at, close_at, sxf.to_xml().as_bytes());
    let mut attrs = attrs_of(&xml, &sec)?;
    set_attr(&mut attrs, "count", Some((xf_id + 1).to_string()));
    let tag = render_tag(&sec.qname, &attrs, false);
    let xml = splice(&xml, sec.start, sec.tag_end, tag.as_bytes());
    let cs = Elem::new(format!("{prefix}cellStyle"))
        .with_attr("name", name)
        .with_attr("xfId", &xf_id.to_string())
        .with_attr("builtinId", &builtin.to_string());
    let (xml, _) = find_or_append(xml, "cellStyles", "cellStyle", &cs, prefix)?;
    Ok(xml)
}

/// The `cellStyleXfs` index and record of the named style `name`.
fn named_style_record(xml: &[u8], name: &str) -> Result<(usize, Elem), XlsxError> {
    let Some(sec) = section(xml, "cellStyles")? else {
        return Err(XlsxError::Structure(format!(
            "no cell style named {name:?}"
        )));
    };
    for sp in records(xml, &sec, "cellStyle")? {
        let a = attrs_of(xml, &sp)?;
        if attr_local(&a, "name").as_deref() == Some(name) {
            let xf_id: usize = attr_local(&a, "xfId")
                .and_then(|v| v.parse().ok())
                .unwrap_or(0);
            let rec = record(xml, "cellStyleXfs", "xf", xf_id)?.ok_or_else(|| {
                XlsxError::Structure(format!("cell style {name:?} has no record"))
            })?;
            return Ok((xf_id, rec));
        }
    }
    Err(XlsxError::Structure(format!(
        "no cell style named {name:?}"
    )))
}

/// Resolve a `<color>`-shaped element against the workbook's colour
/// context (the same resolution the page lowering's parse uses).
fn color_of(el: Option<&Elem>, ctx: &ColorContext) -> Option<String> {
    let el = el?;
    ctx.resolve(&ColorAttrs {
        auto: el.attr("auto"),
        rgb: el.attr("rgb"),
        indexed: el.attr("indexed"),
        theme: el.attr("theme"),
        tint: el.attr("tint"),
    })
}

impl XlsxDocument {
    /// The current `styles.xml` bytes (Excel's minimal sheet when the
    /// package has none).
    fn styles_bytes(&self) -> Vec<u8> {
        self.styles_part
            .as_deref()
            .and_then(|p| self.part_bytes(p))
            .unwrap_or_else(|| MIN_STYLES.as_bytes().to_vec())
    }

    /// Apply `patch` to each style id (`StyleId.0`) in `bases`, splicing `styles.xml` (see the
    /// module docs). Returns the `old → new` StyleId map and the RE-PARSED
    /// style table the model must adopt (`StyleId == cellXfs index`, so
    /// every existing id keeps its meaning); the document's visual side
    /// table is refreshed from the same parse.
    pub fn apply_style_patch(
        &mut self,
        bases: &BTreeSet<u32>,
        patch: &StylePatch,
    ) -> Result<(BTreeMap<u32, StyleId>, StyleTable), XlsxError> {
        let mut xml = self.styles_bytes();
        let mut map = BTreeMap::new();
        for &base in bases {
            let (x, idx) = apply_to_xf(xml, base as usize, patch)?;
            xml = x;
            map.insert(base, StyleId(idx as u32));
        }

        let table = self.store_styles(xml)?;
        Ok((map, table))
    }

    /// Append one record to a `styles.xml` section (`dxfs`, …), dedup by
    /// canonical form, and return its index. `render` gets the part's
    /// element prefix. Every existing index keeps its meaning, so the
    /// model's style table stays valid (the re-parse only refreshes the
    /// visual tables and the differential formats).
    pub(crate) fn append_style_record(
        &mut self,
        section_local: &str,
        render: impl Fn(&str) -> String,
    ) -> Result<u32, XlsxError> {
        let xml = self.styles_bytes();
        let prefix = root_prefix(&xml)?;
        let el = parse_elem(render(&prefix).as_bytes())?;
        let rec = el.local().to_string();
        let (xml, idx) = find_or_append(xml, section_local, &rec, &el, &prefix)?;
        self.store_styles(xml)?;
        Ok(idx as u32)
    }

    /// Store new `styles.xml` bytes (creating the part when the package has
    /// none) and re-parse them with the loader's own parser: ids are
    /// positional, the visual side table and the dxfs are the parser's
    /// output. Returns the style table the model must adopt.
    fn store_styles(&mut self, xml: Vec<u8>) -> Result<StyleTable, XlsxError> {
        let mut table = StyleTable::new();
        let colors = ColorContext::new(&xml, self.theme_palette());
        let parsed = crate::parts::styles::parse_with_colors(&xml, &mut table, &colors)?;
        let mut visual = parsed.visual;
        visual.take_rich_from(&mut self.visual_styles);
        self.visual_styles = visual;
        self.dxfs = parsed.dxfs;
        self.dxf_models = parsed.dxf_models;

        let existing = self
            .styles_part
            .clone()
            .filter(|p| self.container.part(p).is_some());
        match existing {
            Some(part) => self.set_part_bytes(&part, xml),
            None => {
                let target = "styles.xml";
                let part = resolve_target(part_dir(&self.workbook_part), target);
                self.container.parts.push(PartEntry::Modeled {
                    name: part.clone(),
                    kind: ModeledKind::Styles,
                    raw: xml,
                    dirty: false,
                });
                self.container.dirty = true;
                self.add_override(&part, CT_STYLES)?;
                if self.styles_part.is_none() {
                    self.add_workbook_rel(REL_STYLES_FULL, target)?;
                }
                self.styles_part = Some(part);
            }
        }
        Ok(table)
    }

    /// The index of a differential format (`<dxfs>`) that paints a solid
    /// fill (`cell_color`) or a font colour `rgb` (`#RRGGBB`) — found, or
    /// appended. A colour sort or colour filter names its colour this way
    /// (sheet ADR 517). The cell style table is unchanged.
    pub fn color_dxf(&mut self, rgb: &str, cell_color: bool) -> Result<u32, XlsxError> {
        let xml = self.styles_bytes();
        let prefix = root_prefix(&xml)?;
        let c = argb(rgb)?;
        let el = if cell_color {
            Elem {
                name: format!("{prefix}dxf"),
                attrs: Vec::new(),
                children: vec![Elem {
                    name: format!("{prefix}fill"),
                    attrs: Vec::new(),
                    children: vec![Elem {
                        name: format!("{prefix}patternFill"),
                        attrs: vec![("patternType".into(), "solid".into())],
                        children: vec![
                            Elem::new(format!("{prefix}fgColor")).with_attr("rgb", &c),
                            Elem::new(format!("{prefix}bgColor")).with_attr("rgb", &c),
                        ],
                    }],
                }],
            }
        } else {
            Elem {
                name: format!("{prefix}dxf"),
                attrs: Vec::new(),
                children: vec![Elem {
                    name: format!("{prefix}font"),
                    attrs: Vec::new(),
                    children: vec![Elem::new(format!("{prefix}color")).with_attr("rgb", &c)],
                }],
            }
        };
        let (xml, idx) = find_or_append(xml, "dxfs", "dxf", &el, &prefix)?;
        // cellXfs is untouched, so the model's style table stays as it is.
        self.store_styles(xml)?;
        Ok(idx as u32)
    }

    /// The scheme of the theme part the workbook relates (`/theme`);
    /// `None` when there is none or it is unreadable.
    pub(crate) fn theme_palette(&self) -> Option<ThemePalette> {
        self.part_bytes(&self.wb_rels_part)
            .and_then(|raw| parse_rels(&raw).ok())
            .and_then(|rels| {
                rels.by_type_suffix("/theme")
                    .map(|r| resolve_target(part_dir(&self.workbook_part), &r.target))
            })
            .and_then(|part| self.part_bytes(&part))
            .and_then(|xml| ThemePalette::parse(&xml).ok())
    }

    /// The colour context of [`Self::describe_style`]: the theme part's
    /// scheme and the styles' `<indexedColors>`.
    fn color_ctx(&self, styles_xml: &[u8]) -> ColorContext {
        ColorContext::new(styles_xml, self.theme_palette())
    }

    /// What style `id` says, as a fully populated [`StylePatch`] (the shape a
    /// format panel shows and edits). Colours are reported resolved:
    /// explicit RGB, the workbook's indexed palette, and the theme part's
    /// scheme, each with its tint applied (Wave 9 — theme and indexed
    /// colours used to read as empty).
    pub fn describe_style(&self, id: StyleId) -> Result<StylePatch, XlsxError> {
        let xml = self.styles_bytes();
        let ctx = self.color_ctx(&xml);
        let Some(xf) =
            record(&xml, "cellXfs", "xf", id.0 as usize)?.or(record(&xml, "cellXfs", "xf", 0)?)
        else {
            return Ok(StylePatch::default());
        };
        let idx_of = |k: &str| -> usize { xf.attr(k).and_then(|s| s.parse().ok()).unwrap_or(0) };
        let fmt_id = idx_of("numFmtId") as u32;
        let mut num_fmt = builtin_num_fmt(fmt_id).map(str::to_owned);
        if num_fmt.is_none() {
            if let Some(sec) = section(&xml, "numFmts")? {
                for sp in records(&xml, &sec, "numFmt")? {
                    let a = attrs_of(&xml, &sp)?;
                    if attr_local(&a, "numFmtId").and_then(|s| s.parse::<u32>().ok())
                        == Some(fmt_id)
                    {
                        num_fmt = attr_local(&a, "formatCode");
                    }
                }
            }
        }
        let font = record(&xml, "fonts", "font", idx_of("fontId"))?;
        let flag = |l: &str| -> bool {
            font.as_ref()
                .and_then(|f| f.child(l))
                .is_some_and(|c| !matches!(c.attr("val").as_deref(), Some("0" | "false" | "none")))
        };
        let fill = record(&xml, "fills", "fill", idx_of("fillId"))?;
        let fill_rgb = fill
            .as_ref()
            .and_then(|f| f.child("patternFill"))
            .and_then(|pf| {
                (pf.attr("patternType").as_deref() == Some("solid"))
                    .then(|| color_of(pf.child("fgColor"), &ctx))
                    .flatten()
            });
        let border = record(&xml, "borders", "border", idx_of("borderId"))?;
        let refs = xf_doc_refs(&xf);
        let edge = |l: &str| -> Option<EdgePatch> {
            let e = border.as_ref()?.child(l)?;
            Some(EdgePatch {
                style: e.attr("style").unwrap_or_else(|| "none".into()),
                color: color_of(e.child("color"), &ctx),
                swatch: refs.border.get(l).cloned(),
            })
        };
        let al = xf.child("alignment");
        // The W2.2 facets, read through the visual model.
        let model = StyleSheet::parse(&xml)?;
        let palette = model.palette(ctx.theme_rgbs());
        let visual = model.cell_visual(id.0 as usize, &palette);
        let hex = |c: &Option<sheet_core::ColorRef>| {
            c.as_ref()
                .and_then(|c| sheet_format::resolve_hex(c, &palette))
                .unwrap_or_default()
        };
        let (pattern, fill_bg, gradient) = match &visual.fill {
            CellFill::None => ("none".to_string(), String::new(), None),
            CellFill::Pattern { pattern, bg, .. } => (pattern.as_xlsx().to_string(), hex(bg), None),
            CellFill::Gradient { gradient, stops } => {
                let mut g = GradientPatch {
                    stops: stops
                        .iter()
                        .map(|st| (st.position, hex(&Some(st.color.clone()))))
                        .collect(),
                    ..GradientPatch::default()
                };
                match gradient {
                    GradientKind::Linear { degree } => {
                        g.kind = "linear".into();
                        g.degree = *degree;
                    }
                    GradientKind::Path {
                        left,
                        right,
                        top,
                        bottom,
                    } => {
                        g.kind = "path".into();
                        (g.left, g.right, g.top, g.bottom) = (*left, *right, *top, *bottom);
                    }
                }
                ("gradient".to_string(), String::new(), Some(g))
            }
        };
        let font_m = &visual.font.font;
        let ext = StyleExt {
            pattern: Some(pattern),
            fill_bg: Some(fill_bg),
            gradient,
            border_diagonal: edge("diagonal"),
            diagonal_up: Some(visual.border.diagonal_up),
            diagonal_down: Some(visual.border.diagonal_down),
            indent: Some(visual.alignment.indent),
            rotation: Some(visual.alignment.rotation),
            shrink: Some(visual.alignment.shrink),
            strike: Some(font_m.strike),
            vert_align: Some(font_m.vert_align.as_xlsx().to_string()),
            underline_style: Some(font_m.underline.as_xlsx().unwrap_or("none").to_string()),
            fill_swatch: refs.fill_fg.clone(),
            fill_bg_swatch: refs.fill_bg.clone(),
            font_swatch: refs.font_color.clone(),
            doc_char_style: Some(refs.char_style.clone().unwrap_or_default()),
            doc_para_style: Some(refs.para_style.clone().unwrap_or_default()),
            doc_cell_style: Some(refs.cell_style.clone().unwrap_or_default()),
            named_style: Some(
                visual
                    .named_style
                    .clone()
                    .unwrap_or_else(|| "Normal".into()),
            ),
        };
        let _ = VertAlign::Baseline;
        Ok(StylePatch {
            ext,
            num_fmt: Some(num_fmt.unwrap_or_else(|| "General".into())),
            font_name: font
                .as_ref()
                .and_then(|f| f.child("name"))
                .and_then(|n| n.attr("val")),
            font_size: font
                .as_ref()
                .and_then(|f| f.child("sz"))
                .and_then(|n| n.attr("val"))
                .and_then(|v| v.parse().ok()),
            bold: Some(flag("b")),
            italic: Some(flag("i")),
            underline: Some(flag("u")),
            font_color: Some(
                color_of(font.as_ref().and_then(|f| f.child("color")), &ctx).unwrap_or_default(),
            ),
            fill: Some(fill_rgb.unwrap_or_default()),
            border_top: edge("top"),
            border_right: edge("right"),
            border_bottom: edge("bottom"),
            border_left: edge("left"),
            h_align: Some(
                al.and_then(|a| a.attr("horizontal"))
                    .unwrap_or_else(|| "general".into()),
            ),
            v_align: Some(
                al.and_then(|a| a.attr("vertical"))
                    .unwrap_or_else(|| "bottom".into()),
            ),
            wrap: Some(
                al.and_then(|a| a.attr("wrapText"))
                    .is_some_and(|w| w == "1" || w == "true"),
            ),
            quote_prefix: Some(
                xf.attr("quotePrefix")
                    .is_some_and(|q| q == "1" || q == "true"),
            ),
            locked: Some(
                !xf.child("protection")
                    .and_then(|p| p.attr("locked"))
                    .is_some_and(|v| v == "0" || v == "false"),
            ),
            formula_hidden: Some(
                xf.child("protection")
                    .and_then(|p| p.attr("hidden"))
                    .is_some_and(|v| v == "1" || v == "true"),
            ),
        })
    }

    /// The style ids (`cellXfs` indices) carrying Excel's quote prefix
    /// (`quotePrefix="1"`) — what typed entry reads to clear the attribute
    /// when a cell is re-typed without a leading `'`.
    /// The style ids (`cellXfs` indices) whose cells are NOT locked
    /// (`<protection locked="0">`) and those whose formulas are hidden
    /// (`hidden="1"`): what sheet protection reads (sheet ADR 517). Every
    /// other style is locked, Excel's default.
    pub fn protection_styles(&self) -> Result<(BTreeSet<u32>, BTreeSet<u32>), XlsxError> {
        let xml = self.styles_bytes();
        let (mut unlocked, mut hidden) = (BTreeSet::new(), BTreeSet::new());
        let Some(sec) = section(&xml, "cellXfs")? else {
            return Ok((unlocked, hidden));
        };
        for (i, sp) in records(&xml, &sec, "xf")?.iter().enumerate() {
            if sp.empty {
                continue;
            }
            let xf = parse_elem(&xml[sp.start..sp.end])?;
            if let Some(p) = xf.child("protection") {
                if matches!(p.attr("locked").as_deref(), Some("0" | "false")) {
                    unlocked.insert(i as u32);
                }
                if matches!(p.attr("hidden").as_deref(), Some("1" | "true")) {
                    hidden.insert(i as u32);
                }
            }
        }
        Ok((unlocked, hidden))
    }

    pub fn quote_prefixed_styles(&self) -> Result<BTreeSet<u32>, XlsxError> {
        let xml = self.styles_bytes();
        let mut out = BTreeSet::new();
        let Some(sec) = section(&xml, "cellXfs")? else {
            return Ok(out);
        };
        for (i, sp) in records(&xml, &sec, "xf")?.iter().enumerate() {
            let a = attrs_of(&xml, sp)?;
            if matches!(attr_local(&a, "quotePrefix").as_deref(), Some("1" | "true")) {
                out.insert(i as u32);
            }
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reparse(xml: &[u8], idx: usize) -> sheet_core::CellVisual {
        let sheet = StyleSheet::parse(xml).unwrap();
        sheet.cell_visual(idx, &sheet.palette(vec![]))
    }

    #[test]
    #[allow(non_snake_case)]
    fn the_full_visual_model_is_authored__feat__sheet_format_cell_style() {
        use sheet_core::visual::{BorderStyle, CellFill, HAlign, PatternKind, VertAlign};
        let p = StylePatch {
            fill: Some("#FF0000".into()),
            h_align: Some("distributed".into()),
            ext: StyleExt {
                pattern: Some("darkTrellis".into()),
                fill_bg: Some("#FFFF00".into()),
                border_diagonal: Some(EdgePatch {
                    style: "dashDot".into(),
                    color: Some("#0000FF".into()),
                    swatch: None,
                }),
                diagonal_down: Some(true),
                indent: Some(3),
                rotation: Some(255),
                shrink: Some(true),
                strike: Some(true),
                vert_align: Some("subscript".into()),
                underline_style: Some("doubleAccounting".into()),
                ..StyleExt::default()
            },
            ..Default::default()
        };
        let (xml, idx) = apply_to_xf(MIN_STYLES.as_bytes().to_vec(), 0, &p).unwrap();
        let v = reparse(&xml, idx);
        assert_eq!(
            v.fill,
            CellFill::Pattern {
                pattern: PatternKind::DarkTrellis,
                fg: Some(sheet_core::ColorRef::rgb(255, 0, 0)),
                bg: Some(sheet_core::ColorRef::rgb(255, 255, 0)),
            }
        );
        assert_eq!(v.border.diagonal.style, BorderStyle::DashDot);
        assert!(v.border.diagonal_down && !v.border.diagonal_up);
        assert_eq!(v.alignment.horizontal, HAlign::Distributed);
        assert_eq!(
            (v.alignment.indent, v.alignment.rotation, v.alignment.shrink),
            (3, 255, true)
        );
        assert!(v.font.font.strike);
        assert_eq!(v.font.font.vert_align, VertAlign::Subscript);
        assert_eq!(
            v.font.font.underline,
            sheet_core::UnderlineKind::DoubleAccounting
        );
        // A gradient replaces the pattern.
        let g = StylePatch {
            ext: StyleExt {
                gradient: Some(GradientPatch {
                    kind: "linear".into(),
                    degree: 90.0,
                    stops: vec![(0.0, "#FFFFFF".into()), (1.0, "#4472C4".into())],
                    ..GradientPatch::default()
                }),
                ..StyleExt::default()
            },
            ..Default::default()
        };
        let (xml, idx) = apply_to_xf(xml, idx, &g).unwrap();
        assert!(
            matches!(reparse(&xml, idx).fill, CellFill::Gradient { ref stops, .. } if stops.len() == 2)
        );
        // Bad values are refused.
        let bad = StylePatch {
            ext: StyleExt {
                rotation: Some(200),
                ..StyleExt::default()
            },
            ..Default::default()
        };
        assert!(apply_to_xf(MIN_STYLES.as_bytes().to_vec(), 0, &bad).is_err());
    }

    #[test]
    #[allow(non_snake_case)]
    fn document_references_round_trip_through_the_record__feat__sheet_format_cell_style() {
        use sheet_core::visual::CellFill;
        let brand = DocSwatchRef {
            id: "Color/Brand".into(),
            model: sheet_core::DocColorModel::Spot,
            fallback_rgb: (0xE3, 0x00, 0x0F),
        };
        let p = StylePatch {
            ext: StyleExt {
                fill_swatch: Some(brand.clone()),
                font_swatch: Some(brand.clone()),
                doc_char_style: Some("CharacterStyle/Emphasis".into()),
                ..StyleExt::default()
            },
            ..Default::default()
        };
        let (xml, idx) = apply_to_xf(MIN_STYLES.as_bytes().to_vec(), 0, &p).unwrap();
        let text = String::from_utf8(xml.clone()).unwrap();
        // The concrete colour is the swatch's sRGB; the reference rides the
        // record's paged extension.
        assert!(text.contains(r#"rgb="FFE3000F""#), "{text}");
        assert!(text.contains(DOC_EXT_URI), "{text}");
        let v = reparse(&xml, idx);
        match &v.fill {
            CellFill::Pattern { fg, .. } => {
                assert_eq!(fg.as_ref().unwrap().doc.as_ref(), Some(&brand))
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(
            v.font.font.color.as_ref().unwrap().doc.as_ref(),
            Some(&brand)
        );
        assert_eq!(
            v.font.doc_char_style.as_deref(),
            Some("CharacterStyle/Emphasis")
        );
        // A plain colour on the fill clears the fill's reference only.
        let plain = StylePatch {
            fill: Some("#00FF00".into()),
            ..Default::default()
        };
        let (xml2, idx2) = apply_to_xf(xml.clone(), idx, &plain).unwrap();
        let v2 = reparse(&xml2, idx2);
        match &v2.fill {
            CellFill::Pattern { fg, .. } => assert!(fg.as_ref().unwrap().doc.is_none()),
            other => panic!("{other:?}"),
        }
        assert!(v2.font.font.color.as_ref().unwrap().doc.is_some());
        // Another application changed the concrete colour behind the
        // reference: on re-import the stale reference is not restored.
        let edited = text.replacen(
            r#"<fgColor rgb="FFE3000F"/>"#,
            r#"<fgColor rgb="FF112233"/>"#,
            1,
        );
        let v3 = reparse(edited.as_bytes(), idx);
        match &v3.fill {
            CellFill::Pattern { fg, .. } => assert!(fg.as_ref().unwrap().doc.is_none()),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    #[allow(non_snake_case)]
    fn a_built_in_named_style_is_added_and_applied__feat__sheet_format_cell_style() {
        let p = StylePatch {
            ext: StyleExt {
                named_style: Some("Heading 1".into()),
                ..StyleExt::default()
            },
            ..Default::default()
        };
        let (xml, idx) = apply_to_xf(MIN_STYLES.as_bytes().to_vec(), 0, &p).unwrap();
        let sheet = StyleSheet::parse(&xml).unwrap();
        let named = sheet.named_styles();
        let h1 = named.iter().find(|n| n.name == "Heading 1").expect("added");
        assert_eq!(h1.builtin_id, Some(16));
        assert!(h1.visual.font.font.bold);
        assert_eq!(h1.visual.font.font.size, Some(15.0));
        let v = reparse(&xml, idx);
        assert_eq!(v.named_style.as_deref(), Some("Heading 1"));
        assert!(v.font.font.bold);
        assert_eq!(v.border.bottom.style, sheet_core::BorderStyle::Thick);
        // Applying it again reuses the style (no second cellStyle).
        let (xml2, idx2) = apply_to_xf(xml.clone(), 0, &p).unwrap();
        assert_eq!(idx2, idx);
        assert_eq!(StyleSheet::parse(&xml2).unwrap().cell_styles.len(), 2);
        // Every built-in name is defined; an unknown name is refused.
        for id in 0..=53 {
            if let Some(name) = builtin_style_name(id) {
                let p = StylePatch {
                    ext: StyleExt {
                        named_style: Some(name.into()),
                        ..StyleExt::default()
                    },
                    ..Default::default()
                };
                apply_to_xf(MIN_STYLES.as_bytes().to_vec(), 0, &p)
                    .unwrap_or_else(|e| panic!("{name}: {e}"));
            }
        }
        let bad = StylePatch {
            ext: StyleExt {
                named_style: Some("Fancy".into()),
                ..StyleExt::default()
            },
            ..Default::default()
        };
        assert!(apply_to_xf(MIN_STYLES.as_bytes().to_vec(), 0, &bad).is_err());
    }

    fn xf_count(xml: &[u8]) -> usize {
        let sec = section(xml, "cellXfs").unwrap().unwrap();
        records(xml, &sec, "xf").unwrap().len()
    }

    #[test]
    fn bold_appends_font_and_xf_then_dedups() {
        let xml = MIN_STYLES.as_bytes().to_vec();
        let p = StylePatch {
            bold: Some(true),
            ..Default::default()
        };
        let (xml, a) = apply_to_xf(xml, 0, &p).unwrap();
        assert_eq!(a, 1);
        let (xml, b) = apply_to_xf(xml, 0, &p).unwrap();
        assert_eq!(b, 1, "the same patch on the same base dedups");
        assert_eq!(xf_count(&xml), 2);
        let s = String::from_utf8(xml).unwrap();
        assert!(s.contains(r#"<fonts count="2">"#), "{s}");
        assert!(s.contains(r#"<cellXfs count="2">"#), "{s}");
        assert!(s.contains("<font><b/><sz val=\"11\"/>"), "{s}");
    }

    #[test]
    fn numfmts_section_is_created_first() {
        let p = StylePatch {
            num_fmt: Some("0.000".into()),
            ..Default::default()
        };
        let (xml, _) = apply_to_xf(MIN_STYLES.as_bytes().to_vec(), 0, &p).unwrap();
        let s = String::from_utf8(xml).unwrap();
        let nf = s.find("<numFmts").unwrap();
        assert!(nf < s.find("<fonts").unwrap());
        assert!(
            s.contains(r#"<numFmt numFmtId="164" formatCode="0.000"/>"#),
            "{s}"
        );
        // A built-in code reuses its id.
        let p = StylePatch {
            num_fmt: Some("0.00".into()),
            ..Default::default()
        };
        let (xml, idx) = apply_to_xf(s.into_bytes(), 0, &p).unwrap();
        let xf = record(&xml, "cellXfs", "xf", idx).unwrap().unwrap();
        assert_eq!(xf.attr("numFmtId").as_deref(), Some("2"));
    }

    #[test]
    fn prefixed_stylesheet_gets_prefixed_records() {
        let xml = MIN_STYLES
            .replace("<styleSheet xmlns=", "<x:styleSheet xmlns:x=")
            .replace("</styleSheet>", "</x:styleSheet>");
        // Prefix every element of the minimal sheet.
        let mut out = String::new();
        let mut rest = xml.as_str();
        while let Some(i) = rest.find('<') {
            out.push_str(&rest[..=i]);
            rest = &rest[i + 1..];
            let skip = rest.starts_with('?') || rest.starts_with("x:") || rest.starts_with("/x:");
            if !skip {
                if let Some(r) = rest.strip_prefix('/') {
                    out.push_str("/x:");
                    rest = r;
                } else {
                    out.push_str("x:");
                }
            }
        }
        out.push_str(rest);
        let p = StylePatch {
            fill: Some("#FFFF00".into()),
            ..Default::default()
        };
        let (xml, idx) = apply_to_xf(out.into_bytes(), 0, &p).unwrap();
        assert_eq!(idx, 1);
        let s = String::from_utf8(xml).unwrap();
        assert!(
            s.contains(r#"<x:fill><x:patternFill patternType="solid"><x:fgColor rgb="FFFFFF00"/>"#),
            "{s}"
        );
    }

    #[test]
    fn bad_values_are_refused() {
        let base = || MIN_STYLES.as_bytes().to_vec();
        for p in [
            StylePatch {
                fill: Some("yellow".into()),
                ..Default::default()
            },
            StylePatch {
                h_align: Some("middle".into()),
                ..Default::default()
            },
            StylePatch {
                border_top: Some(EdgePatch {
                    style: "wavy".into(),
                    color: None,
                    swatch: None,
                }),
                ..Default::default()
            },
            StylePatch {
                font_size: Some(0.0),
                ..Default::default()
            },
        ] {
            assert!(apply_to_xf(base(), 0, &p).is_err(), "{p:?}");
        }
    }
}
