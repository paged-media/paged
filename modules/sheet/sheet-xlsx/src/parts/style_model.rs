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

//! `styles.xml` read into the cell visual model (W2.2, sheet ADR 518): fonts,
//! fills (all 18 patterns and gradients), borders (all line styles and the
//! diagonals), alignment (indent, rotation, shrink), the Excel named cell
//! styles (`cellStyleXfs` + `cellStyles`), the differential formats and the
//! workbook palette — every colour kept as a [`ColorRef`] (unresolved; the
//! one resolver is `sheet_format::resolve`).
//!
//! ## Document references (`extLst`)
//!
//! An xlsx save writes concrete colours only. Where a cell style references
//! a document swatch or style, the reference travels in a paged extension in
//! the `<xf>` record's own `extLst` ([`DOC_EXT_URI`]) — so the record's
//! identity (the dedup of authored styles) includes it and indices stay
//! positional:
//!
//! ```xml
//! <xf numFmtId="0" fontId="3" fillId="4" borderId="0" xfId="0">
//!   <extLst><ext uri="{6F3D1A52-8E0B-4C71-9B5A-2D7C4E9F1A30}" xmlns:pg="urn:paged:sheet:docstyles">
//!     <pg:doc fontColor="Color/Brand|spot|E3000F" charStyle="CharacterStyle/Emphasis"/>
//!   </ext></extLst>
//! </xf>
//! ```
//!
//! On read a colour reference is restored only when the concrete colour the
//! record stores still equals the recorded sRGB — another application that
//! changed the colour wins over the stale reference.

use crate::error::XlsxError;
use crate::style_edit::{parse_elem, Elem};
use sheet_core::visual::{
    BorderEdge, BorderStyle, CellAlignment, CellBorder, CellFill, CellVisual, ColorRef,
    ConcreteColor, DifferentialFormat, DocColorModel, DocSwatchRef, FontDelta, FontSpec,
    GradientKind, GradientStop, HAlign, NamedCellStyle, PatternKind, UnderlineKind, VAlign,
    VertAlign,
};
use sheet_format::ColorPalette;
use std::collections::BTreeMap;

/// The `uri` of the paged document-styles extension.
pub const DOC_EXT_URI: &str = "{6F3D1A52-8E0B-4C71-9B5A-2D7C4E9F1A30}";
/// Its namespace.
pub const DOC_EXT_NS: &str = "urn:paged:sheet:docstyles";

/// One `<xf>` record.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct XfRecord {
    pub num_fmt_id: u32,
    pub font_id: u32,
    pub fill_id: u32,
    pub border_id: u32,
    /// `xfId` (cellXfs only): the `cellStyleXfs` record it derives from.
    pub xf_id: u32,
    pub apply_font: Option<bool>,
    pub apply_fill: Option<bool>,
    pub apply_border: Option<bool>,
    pub alignment: CellAlignment,
    /// The document references in the record's paged extension.
    pub doc: XfDocRefs,
}

/// The document references of one `cellXfs` record (the extension row).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct XfDocRefs {
    pub fill_fg: Option<DocSwatchRef>,
    pub fill_bg: Option<DocSwatchRef>,
    pub font_color: Option<DocSwatchRef>,
    pub border: BTreeMap<String, DocSwatchRef>,
    pub char_style: Option<String>,
    pub para_style: Option<String>,
    pub cell_style: Option<String>,
}

impl XfDocRefs {
    pub fn is_empty(&self) -> bool {
        *self == XfDocRefs::default()
    }
}

/// The style sheet as the visual model sees it.
#[derive(Clone, Debug, Default)]
pub struct StyleSheet {
    pub num_fmts: BTreeMap<u32, String>,
    pub fonts: Vec<FontSpec>,
    pub fills: Vec<CellFill>,
    pub borders: Vec<CellBorder>,
    pub cell_xfs: Vec<XfRecord>,
    pub style_xfs: Vec<XfRecord>,
    /// `(name, xfId, builtinId)` of `cellStyles`.
    pub cell_styles: Vec<(String, u32, Option<u32>)>,
    pub dxfs: Vec<DifferentialFormat>,
    /// `<colors><indexedColors>` (empty = the default palette).
    pub indexed: Vec<Option<(u8, u8, u8)>>,
}

fn flag(el: &Elem, local: &str) -> Option<bool> {
    el.child(local)
        .map(|c| !matches!(c.attr("val").as_deref(), Some("0" | "false")))
}

fn u32_attr(el: &Elem, k: &str) -> u32 {
    el.attr(k).and_then(|s| s.trim().parse().ok()).unwrap_or(0)
}

fn bool_attr(el: &Elem, k: &str) -> Option<bool> {
    el.attr(k).map(|v| !matches!(v.as_str(), "0" | "false"))
}

/// `#RRGGBB` / `RRGGBB` / `AARRGGBB` → bytes.
pub fn rgb_bytes(hex: &str) -> Option<(u8, u8, u8)> {
    match ColorRef::from_hex(hex)?.concrete {
        ConcreteColor::Rgb { r, g, b } => Some((r, g, b)),
        _ => None,
    }
}

/// A `CT_Color` element → a [`ColorRef`] (`rgb` wins, then `indexed`, then
/// `theme`; a tint on an `rgb`/`indexed` colour is folded into an RGB).
pub(crate) fn color_of(el: &Elem) -> ColorRef {
    if el.attr("auto").is_some_and(|v| v == "1" || v == "true") {
        return ColorRef::auto();
    }
    let tint = el
        .attr("tint")
        .and_then(|v| v.trim().parse::<f64>().ok())
        .unwrap_or(0.0);
    if let Some(rgb) = el.attr("rgb").and_then(|v| rgb_bytes(&v)) {
        let rgb = sheet_format::resolve::tint_rgb(rgb, tint);
        return ColorRef::rgb(rgb.0, rgb.1, rgb.2);
    }
    if let Some(i) = el
        .attr("indexed")
        .and_then(|v| v.trim().parse::<u32>().ok())
    {
        return ColorRef::indexed(i);
    }
    if let Some(t) = el.attr("theme").and_then(|v| v.trim().parse::<u32>().ok()) {
        return ColorRef::theme(t, tint);
    }
    ColorRef::auto()
}

/// A `<font>` (or a `<rPr>` run font) → a [`FontSpec`].
pub(crate) fn font_of(el: &Elem) -> FontSpec {
    let val = |l: &str| el.child(l).and_then(|c| c.attr("val"));
    FontSpec {
        // `<rPr>` names the face `rFont`.
        name: val("name").or_else(|| val("rFont")),
        size: val("sz").and_then(|v| v.trim().parse().ok()),
        bold: flag(el, "b").unwrap_or(false),
        italic: flag(el, "i").unwrap_or(false),
        underline: el
            .child("u")
            .map(|u| UnderlineKind::parse(u.attr("val").as_deref()))
            .unwrap_or_default(),
        strike: flag(el, "strike").unwrap_or(false),
        vert_align: val("vertAlign")
            .map(|v| VertAlign::parse(&v))
            .unwrap_or_default(),
        color: el.child("color").map(color_of),
        scheme: val("scheme"),
    }
}

/// A `<font>` inside a `<dxf>`: only the present facets.
pub(crate) fn font_delta_of(el: &Elem) -> FontDelta {
    let val = |l: &str| el.child(l).and_then(|c| c.attr("val"));
    FontDelta {
        name: val("name"),
        size: val("sz").and_then(|v| v.trim().parse().ok()),
        bold: flag(el, "b"),
        italic: flag(el, "i"),
        underline: el
            .child("u")
            .map(|u| UnderlineKind::parse(u.attr("val").as_deref())),
        strike: flag(el, "strike"),
        vert_align: val("vertAlign").map(|v| VertAlign::parse(&v)),
        color: el.child("color").map(color_of),
    }
}

/// A `<fill>` → a [`CellFill`]. `dxf`: a differential fill, whose solid
/// colour Excel writes as `<bgColor>` and whose pattern may be omitted.
pub(crate) fn fill_of(el: &Elem, dxf: bool) -> CellFill {
    if let Some(g) = el.child("gradientFill") {
        let num = |k: &str| g.attr(k).and_then(|v| v.trim().parse::<f64>().ok());
        let gradient = if g.attr("type").as_deref() == Some("path") {
            GradientKind::Path {
                left: num("left").unwrap_or(0.0),
                right: num("right").unwrap_or(0.0),
                top: num("top").unwrap_or(0.0),
                bottom: num("bottom").unwrap_or(0.0),
            }
        } else {
            GradientKind::Linear {
                degree: num("degree").unwrap_or(0.0),
            }
        };
        let stops = g
            .children
            .iter()
            .filter(|c| c.local() == "stop")
            .map(|s| GradientStop {
                position: s
                    .attr("position")
                    .and_then(|v| v.trim().parse().ok())
                    .unwrap_or(0.0),
                color: s
                    .child("color")
                    .map(color_of)
                    .unwrap_or_else(ColorRef::auto),
            })
            .collect();
        return CellFill::Gradient { gradient, stops };
    }
    let Some(p) = el.child("patternFill") else {
        return CellFill::None;
    };
    let fg = p.child("fgColor").map(color_of);
    let bg = p.child("bgColor").map(color_of);
    let pattern = match p.attr("patternType") {
        Some(t) => PatternKind::parse(&t).unwrap_or(PatternKind::None),
        // A dxf fill without a pattern is solid in its bgColor.
        None if dxf && (fg.is_some() || bg.is_some()) => PatternKind::Solid,
        None => PatternKind::None,
    };
    if pattern == PatternKind::None {
        return CellFill::None;
    }
    if dxf && pattern == PatternKind::Solid {
        // Excel paints a differential solid fill in bgColor (fgColor when
        // only that is given).
        return CellFill::Pattern {
            pattern,
            fg: bg.or(fg),
            bg: None,
        };
    }
    CellFill::Pattern { pattern, fg, bg }
}

/// A `<border>` → a [`CellBorder`].
pub(crate) fn border_of(el: &Elem) -> CellBorder {
    let edge = |l: &str| -> BorderEdge {
        el.child(l)
            .map(|e| BorderEdge {
                style: e
                    .attr("style")
                    .and_then(|s| BorderStyle::parse(&s))
                    .unwrap_or_default(),
                color: e.child("color").map(color_of),
            })
            .unwrap_or_default()
    };
    CellBorder {
        // `start`/`end` are the bidi-neutral spellings of left/right.
        left: Some(edge("left"))
            .filter(|e| !e.is_none())
            .unwrap_or_else(|| edge("start")),
        right: Some(edge("right"))
            .filter(|e| !e.is_none())
            .unwrap_or_else(|| edge("end")),
        top: edge("top"),
        bottom: edge("bottom"),
        diagonal: edge("diagonal"),
        diagonal_up: bool_attr(el, "diagonalUp").unwrap_or(false),
        diagonal_down: bool_attr(el, "diagonalDown").unwrap_or(false),
    }
}

/// An `<alignment>` → a [`CellAlignment`].
pub(crate) fn alignment_of(el: &Elem) -> CellAlignment {
    CellAlignment {
        horizontal: el
            .attr("horizontal")
            .map(|v| HAlign::parse(&v))
            .unwrap_or_default(),
        vertical: el
            .attr("vertical")
            .map(|v| VAlign::parse(&v))
            .unwrap_or_default(),
        wrap: bool_attr(el, "wrapText").unwrap_or(false),
        indent: u32_attr(el, "indent"),
        rotation: u32_attr(el, "textRotation"),
        shrink: bool_attr(el, "shrinkToFit").unwrap_or(false),
    }
}

fn xf_of(el: &Elem) -> XfRecord {
    XfRecord {
        num_fmt_id: u32_attr(el, "numFmtId"),
        font_id: u32_attr(el, "fontId"),
        fill_id: u32_attr(el, "fillId"),
        border_id: u32_attr(el, "borderId"),
        xf_id: u32_attr(el, "xfId"),
        apply_font: bool_attr(el, "applyFont"),
        apply_fill: bool_attr(el, "applyFill"),
        apply_border: bool_attr(el, "applyBorder"),
        alignment: el.child("alignment").map(alignment_of).unwrap_or_default(),
        doc: el
            .child("extLst")
            .and_then(|l| {
                l.children
                    .iter()
                    .find(|e| e.local() == "ext" && e.attr("uri").as_deref() == Some(DOC_EXT_URI))
            })
            .and_then(|e| e.children.iter().find(|c| c.local() == "doc"))
            .map(doc_refs_of)
            .unwrap_or_default(),
    }
}

/// A `<dxf>` → a [`DifferentialFormat`].
pub(crate) fn dxf_of(el: &Elem) -> DifferentialFormat {
    DifferentialFormat {
        font: el.child("font").map(font_delta_of),
        fill: el.child("fill").map(|f| fill_of(f, true)),
        border: el.child("border").map(border_of),
        num_fmt: el.child("numFmt").and_then(|n| n.attr("formatCode")),
        alignment: el.child("alignment").map(alignment_of),
    }
}

/// `id|model|RRGGBB` → a [`DocSwatchRef`].
fn parse_doc_ref(v: &str) -> Option<DocSwatchRef> {
    let mut it = v.rsplitn(3, '|');
    let rgb = rgb_bytes(it.next()?)?;
    let model = DocColorModel::parse(it.next()?)?;
    let id = it.next()?.to_string();
    (!id.is_empty()).then_some(DocSwatchRef {
        id,
        model,
        fallback_rgb: rgb,
    })
}

/// A [`DocSwatchRef`] → `id|model|RRGGBB`.
pub fn render_doc_ref(d: &DocSwatchRef) -> String {
    let (r, g, b) = d.fallback_rgb;
    format!("{}|{}|{r:02X}{g:02X}{b:02X}", d.id, d.model.as_str())
}

/// The `<pg:doc>` element → the record's document references.
pub(crate) fn doc_refs_of(doc: &Elem) -> XfDocRefs {
    let r = |k: &str| doc.attr(k).and_then(|v| parse_doc_ref(&v));
    let mut refs = XfDocRefs {
        fill_fg: r("fillFg"),
        fill_bg: r("fillBg"),
        font_color: r("fontColor"),
        char_style: doc.attr("charStyle"),
        para_style: doc.attr("paraStyle"),
        cell_style: doc.attr("cellStyle"),
        ..XfDocRefs::default()
    };
    for e in ["left", "right", "top", "bottom", "diagonal"] {
        if let Some(d) = r(&format!("border{}", capitalize(e))) {
            refs.border.insert(e.to_string(), d);
        }
    }
    refs
}

/// The record's document references → its `<pg:doc>` attributes (empty
/// when there are none).
pub(crate) fn doc_refs_attrs(refs: &XfDocRefs) -> Vec<(String, String)> {
    let mut a = Vec::new();
    let mut put = |k: &str, d: &Option<DocSwatchRef>| {
        if let Some(d) = d {
            a.push((k.to_string(), render_doc_ref(d)));
        }
    };
    put("fillFg", &refs.fill_fg);
    put("fillBg", &refs.fill_bg);
    put("fontColor", &refs.font_color);
    for (e, d) in &refs.border {
        a.push((format!("border{}", capitalize(e)), render_doc_ref(d)));
    }
    for (k, v) in [
        ("charStyle", &refs.char_style),
        ("paraStyle", &refs.para_style),
        ("cellStyle", &refs.cell_style),
    ] {
        if let Some(v) = v {
            a.push((k.to_string(), v.clone()));
        }
    }
    a
}

pub(crate) fn capitalize(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
}

impl StyleSheet {
    /// Read a styles part (a part with no `styleSheet` root reads as empty).
    pub fn parse(xml: &[u8]) -> Result<StyleSheet, XlsxError> {
        let root = match parse_elem(xml) {
            Ok(r) => r,
            Err(_) => return Ok(StyleSheet::default()),
        };
        let mut out = StyleSheet::default();
        let sec = |l: &str| root.children.iter().find(|c| c.local() == l);
        let items = |l: &str, rec: &'static str| -> Vec<&Elem> {
            sec(l)
                .map(|s| s.children.iter().filter(|c| c.local() == rec).collect())
                .unwrap_or_default()
        };
        for n in items("numFmts", "numFmt") {
            if let (Some(id), Some(code)) = (
                n.attr("numFmtId")
                    .and_then(|v| v.trim().parse::<u32>().ok()),
                n.attr("formatCode"),
            ) {
                out.num_fmts.insert(id, code);
            }
        }
        out.fonts = items("fonts", "font").into_iter().map(font_of).collect();
        out.fills = items("fills", "fill")
            .into_iter()
            .map(|f| fill_of(f, false))
            .collect();
        out.borders = items("borders", "border")
            .into_iter()
            .map(border_of)
            .collect();
        out.cell_xfs = items("cellXfs", "xf").into_iter().map(xf_of).collect();
        out.style_xfs = items("cellStyleXfs", "xf").into_iter().map(xf_of).collect();
        out.cell_styles = items("cellStyles", "cellStyle")
            .into_iter()
            .map(|c| {
                (
                    c.attr("name").unwrap_or_default(),
                    u32_attr(c, "xfId"),
                    c.attr("builtinId").and_then(|v| v.parse().ok()),
                )
            })
            .collect();
        out.dxfs = items("dxfs", "dxf").into_iter().map(dxf_of).collect();
        if let Some(colors) = sec("colors") {
            if let Some(ic) = colors.child("indexedColors") {
                out.indexed = ic
                    .children
                    .iter()
                    .filter(|c| c.local() == "rgbColor")
                    .map(|c| c.attr("rgb").and_then(|v| rgb_bytes(&v)))
                    .collect();
            }
        }
        Ok(out)
    }

    /// The number-format code of a record.
    pub fn num_fmt_code(&self, id: u32) -> String {
        self.num_fmts
            .get(&id)
            .cloned()
            .or_else(|| crate::parts::styles::builtin_num_fmt(id).map(str::to_owned))
            .unwrap_or_else(|| "General".to_owned())
    }

    /// The named style a `cellStyleXfs` index belongs to (not Normal).
    fn named_style_of(&self, xf_id: u32) -> Option<String> {
        self.cell_styles
            .iter()
            .find(|(_, id, _)| *id == xf_id)
            .filter(|(_, _, b)| *b != Some(0))
            .map(|(name, _, _)| name.clone())
            .filter(|n| n != "Normal")
    }

    fn visual_of_record(&self, xf: &XfRecord, honour_apply: bool) -> CellVisual {
        let mut v = CellVisual::default();
        if !honour_apply || xf.apply_font.unwrap_or(true) {
            if let Some(f) = self.fonts.get(xf.font_id as usize) {
                v.font.font = f.clone();
            }
        }
        if !honour_apply || xf.apply_fill.unwrap_or(true) {
            if let Some(f) = self.fills.get(xf.fill_id as usize) {
                v.fill = f.clone();
            }
        }
        if !honour_apply || xf.apply_border.unwrap_or(true) {
            if let Some(b) = self.borders.get(xf.border_id as usize) {
                v.border = b.clone();
            }
        }
        v.alignment = xf.alignment.clone();
        v
    }

    /// The visual of `cellXfs[index]`, with the document references the
    /// extension records for it restored where the concrete colours match.
    pub fn cell_visual(&self, index: usize, palette: &ColorPalette) -> CellVisual {
        let Some(xf) = self.cell_xfs.get(index) else {
            return CellVisual::default();
        };
        let mut v = self.visual_of_record(xf, true);
        v.named_style = self.named_style_of(xf.xf_id);
        if !xf.doc.is_empty() {
            apply_doc_refs(&mut v, &xf.doc, palette);
        }
        v
    }

    /// The Excel named cell styles.
    pub fn named_styles(&self) -> Vec<NamedCellStyle> {
        self.cell_styles
            .iter()
            .map(|(name, xf_id, builtin)| {
                let rec = self
                    .style_xfs
                    .get(*xf_id as usize)
                    .cloned()
                    .unwrap_or_default();
                NamedCellStyle {
                    name: name.clone(),
                    builtin_id: *builtin,
                    xf_id: *xf_id,
                    visual: self.visual_of_record(&rec, false),
                    num_fmt: self.num_fmt_code(rec.num_fmt_id),
                    doc_cell_style: None,
                }
            })
            .collect()
    }

    /// The palette colours resolve against (`theme` from the theme part).
    pub fn palette(&self, theme: Vec<Option<(u8, u8, u8)>>) -> ColorPalette {
        ColorPalette {
            theme,
            indexed: self.indexed.clone(),
        }
    }
}

/// Restore a document reference on `color` when its concrete colour still
/// resolves to the recorded sRGB.
fn restore(color: &mut Option<ColorRef>, doc: &Option<DocSwatchRef>, palette: &ColorPalette) {
    if let (Some(c), Some(d)) = (color.as_mut(), doc) {
        let concrete = ColorRef {
            concrete: c.concrete.clone(),
            doc: None,
        };
        if sheet_format::resolve(&concrete, palette).map(|r| r.rgb) == Some(d.fallback_rgb) {
            c.doc = Some(d.clone());
        }
    }
}

fn apply_doc_refs(v: &mut CellVisual, refs: &XfDocRefs, palette: &ColorPalette) {
    restore(&mut v.font.font.color, &refs.font_color, palette);
    if let CellFill::Pattern { fg, bg, .. } = &mut v.fill {
        restore(fg, &refs.fill_fg, palette);
        restore(bg, &refs.fill_bg, palette);
    }
    for (edge, d) in &refs.border {
        let e = match edge.as_str() {
            "left" => &mut v.border.left,
            "right" => &mut v.border.right,
            "top" => &mut v.border.top,
            "bottom" => &mut v.border.bottom,
            _ => &mut v.border.diagonal,
        };
        restore(&mut e.color, &Some(d.clone()), palette);
    }
    v.font.doc_char_style = refs.char_style.clone();
    v.font.doc_para_style = refs.para_style.clone();
    v.doc_cell_style = refs.cell_style.clone();
}

#[cfg(test)]
#[allow(non_snake_case)]
mod tests {
    use super::*;

    const XML: &str = r#"<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="0.0%"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font>
<font><b/><strike/><u val="doubleAccounting"/><vertAlign val="superscript"/><sz val="9"/><color theme="4" tint="0.4"/><name val="Arial"/></font></fonts>
<fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="lightTrellis"><fgColor rgb="FFFF0000"/><bgColor indexed="13"/></patternFill></fill>
<fill><gradientFill degree="90"><stop position="0"><color rgb="FFFFFFFF"/></stop><stop position="1"><color theme="4"/></stop></gradientFill></fill></fills>
<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>
<border diagonalUp="1"><left style="mediumDashDot"><color rgb="FF00FF00"/></left><right/><top/><bottom style="double"/><diagonal style="thin"><color auto="1"/></diagonal></border></borders>
<cellStyleXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/><xf numFmtId="164" fontId="1" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="164" fontId="1" fillId="2" borderId="1" xfId="1" applyFont="1"><alignment horizontal="distributed" indent="2" textRotation="135" shrinkToFit="1"/><extLst><ext uri="{6F3D1A52-8E0B-4C71-9B5A-2D7C4E9F1A30}" xmlns:pg="urn:paged:sheet:docstyles"><pg:doc fillFg="Color/Red|spot|FF0000" borderLeft="Color/Green|cmyk|00FF00" fontColor="Color/Stale|rgb|123456" charStyle="CharacterStyle/Em"/></ext></extLst></xf></cellXfs>
<cellStyles count="2"><cellStyle name="Normal" xfId="0" builtinId="0"/><cellStyle name="Heading 1" xfId="1" builtinId="16"/></cellStyles>
<dxfs count="1"><dxf><font><b val="0"/><color rgb="FF9C0006"/></font><fill><patternFill><bgColor rgb="FFFFC7CE"/></patternFill></fill><numFmt numFmtId="165" formatCode="0.00"/></dxf></dxfs>
<colors><indexedColors><rgbColor rgb="FF000000"/></indexedColors></colors>
</styleSheet>"#;

    #[test]
    fn the_style_sheet_reads_into_the_visual_model__feat__sheet_format_cell_style() {
        let s = StyleSheet::parse(XML.as_bytes()).unwrap();
        let f = &s.fonts[1];
        assert!(f.bold && f.strike);
        assert_eq!(f.underline, UnderlineKind::DoubleAccounting);
        assert_eq!(f.vert_align, VertAlign::Superscript);
        assert_eq!(f.color, Some(ColorRef::theme(4, 0.4)));
        assert_eq!(
            s.fills[1],
            CellFill::Pattern {
                pattern: PatternKind::Gray125,
                fg: None,
                bg: None
            }
        );
        match &s.fills[2] {
            CellFill::Pattern { pattern, fg, bg } => {
                assert_eq!(*pattern, PatternKind::LightTrellis);
                assert_eq!(fg, &Some(ColorRef::rgb(255, 0, 0)));
                assert_eq!(bg, &Some(ColorRef::indexed(13)));
            }
            other => panic!("{other:?}"),
        }
        assert!(matches!(&s.fills[3], CellFill::Gradient { stops, .. } if stops.len() == 2));
        let b = &s.borders[1];
        assert_eq!(b.left.style, BorderStyle::MediumDashDot);
        assert_eq!(b.bottom.style, BorderStyle::Double);
        assert!(b.diagonal_up && !b.diagonal_down);
        let al = &s.cell_xfs[1].alignment;
        assert_eq!(
            (al.horizontal, al.indent, al.rotation, al.shrink),
            (HAlign::Distributed, 2, 135, true)
        );
        let d = &s.dxfs[0];
        assert_eq!(d.font.as_ref().unwrap().bold, Some(false));
        assert_eq!(
            d.fill,
            Some(CellFill::Pattern {
                pattern: PatternKind::Solid,
                fg: Some(ColorRef::rgb(0xFF, 0xC7, 0xCE)),
                bg: None
            })
        );
        assert_eq!(d.num_fmt.as_deref(), Some("0.00"));
        assert_eq!(s.indexed.len(), 1);
        let named = s.named_styles();
        assert_eq!(named[1].name, "Heading 1");
        assert_eq!(named[1].builtin_id, Some(16));
        assert_eq!(named[1].num_fmt, "0.0%");

        // The cell's visual: named style, document references restored only
        // where the concrete colour still matches.
        let pal = s.palette(vec![]);
        let v = s.cell_visual(1, &pal);
        assert_eq!(v.named_style.as_deref(), Some("Heading 1"));
        match &v.fill {
            CellFill::Pattern { fg, .. } => {
                assert_eq!(fg.as_ref().unwrap().doc.as_ref().unwrap().id, "Color/Red")
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(
            v.border
                .left
                .color
                .as_ref()
                .unwrap()
                .doc
                .as_ref()
                .unwrap()
                .id,
            "Color/Green"
        );
        // The font colour changed since the reference was written: dropped.
        assert!(v.font.font.color.as_ref().unwrap().doc.is_none());
        assert_eq!(v.font.doc_char_style.as_deref(), Some("CharacterStyle/Em"));
    }
}
