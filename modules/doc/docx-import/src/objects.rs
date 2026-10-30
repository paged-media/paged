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

//! Wave W4a's reading (doc ADR 614): `w:lang`, text boxes (`wps:txbx`,
//! `v:textbox`), nested tables and the table look (`w:tblBorders`,
//! `w:tcBorders`, `w:shd`, `w:tblInd`, `w:jc`, `w:tblLayout`, `w:tblW`,
//! `w:tcW`, `w:trHeight/@w:hRule`, `w:cantSplit`), and table styles'
//! table properties. Kept apart from the body walk so the walk only calls
//! in.

use docx_core::{
    BorderEdge, Borders, CellLook, Float, FloatPosition, FloatWrap, HeightRule, Language,
    Paragraph, PictureLook, PreferredWidth, TableLook, TableStyleProps, TextBox, Theme, WidthKind,
};
use paged_ooxml::ooxmlsdk::schemas::schemas_microsoft_com_office_word as w10;
use paged_ooxml::ooxmlsdk::schemas::schemas_microsoft_com_vml as vml;
use paged_ooxml::ooxmlsdk::schemas::schemas_openxmlformats_org_drawingml_2006_main as aml;
use paged_ooxml::ooxmlsdk::schemas::schemas_openxmlformats_org_wordprocessingml_2006_main as wml;

use crate::{map_float, map_paragraph, theme, ImportCtx};

// ---------------------------------------------------------------------------
// Language

/// `w:lang` as written.
pub(crate) fn language(l: &wml::Languages) -> Language {
    let tag = |v: &Option<String>| {
        v.as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    Language {
        latin: tag(&l.val),
        east_asia: tag(&l.east_asia),
        bidi: tag(&l.bidi),
    }
}

// ---------------------------------------------------------------------------
// Text boxes

/// What the import keeps per part for text boxes: the shapes' DrawingML
/// look by `wp:docPr/@id` (read through the shared DrawingML reader, as the
/// pictures' are), and the running `w:txbxContent` ordinal.
#[derive(Default)]
pub(crate) struct PartObjects {
    looks: std::collections::HashMap<u32, std::collections::VecDeque<PictureLook>>,
    next_ordinal: u32,
}

impl PartObjects {
    /// A fresh part: its shapes' looks.
    pub(crate) fn for_part(part: &[u8]) -> Self {
        PartObjects {
            looks: shape_looks(part),
            next_ordinal: 0,
        }
    }
}

/// The WordprocessingML drawing namespace (`wp:`).
const NS_WP: &[u8] = b"http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing";

/// Every DrawingML shape's (`wps:wsp`) `wps:spPr` look in a part, by its
/// drawing's `wp:docPr/@id`, in document order.
fn shape_looks(
    part: &[u8],
) -> std::collections::HashMap<u32, std::collections::VecDeque<PictureLook>> {
    use paged_ooxml::drawingml;
    use paged_ooxml::tree::{self, Ns};
    let mut out: std::collections::HashMap<u32, std::collections::VecDeque<PictureLook>> =
        Default::default();
    let Ok(drawings) = tree::subtrees(part, |uri, local| {
        uri == NS_WP && (local == "inline" || local == "anchor")
    }) else {
        return out;
    };
    let no_rels = |_: &str| None;
    for d in &drawings {
        let Some(id) = d
            .children
            .iter()
            .find(|c| c.local == "docPr")
            .and_then(|p| p.attr_u32("id"))
        else {
            continue;
        };
        let Some(wsp) = d
            .path(&[(Ns::A, "graphic"), (Ns::A, "graphicData")])
            .and_then(|g| g.children.iter().find(|c| c.local == "wsp"))
        else {
            continue;
        };
        let shape = wsp
            .children
            .iter()
            .find(|c| c.local == "spPr")
            .map(|sp| drawingml::shape_properties(sp, &no_rels))
            .unwrap_or_default();
        out.entry(id).or_default().push_back(PictureLook {
            shape,
            blip: Default::default(),
        });
    }
    out
}

/// Word's default text box insets: 0.1" left and right, 0.05" top and
/// bottom (top, left, bottom, right).
const DEFAULT_INSETS: [i64; 4] = [45720, 91440, 45720, 91440];

/// The paragraphs of a `w:txbxContent`; `held` set when it holds content
/// the box's paragraphs do not show as they are (a table, a content
/// control).
fn content_paragraphs(c: &wml::TextBoxContent, ctx: &ImportCtx) -> (Vec<Paragraph>, bool) {
    let mut out = Vec::new();
    let mut held = false;
    for choice in &c.text_box_content_choice {
        match choice {
            wml::TextBoxContentChoice::Paragraph(p) => {
                let mut para = map_paragraph(p, ctx, 0, None);
                para.source_para_ord = out.len() as u32;
                out.push(para);
            }
            wml::TextBoxContentChoice::Table(t) => {
                held = true;
                flatten_table(t, ctx, &mut out);
            }
            wml::TextBoxContentChoice::SdtBlock(sdt) => {
                held = true;
                for c in sdt
                    .sdt_content_block
                    .iter()
                    .flat_map(|c| &c.sdt_content_block_choice)
                {
                    if let wml::SdtContentBlockChoice::Paragraph(p) = c {
                        let mut para = map_paragraph(p, ctx, 0, None);
                        para.held.in_content_control = true;
                        out.push(para);
                    }
                }
            }
            _ => {}
        }
    }
    (out, held)
}

/// A table's paragraphs in reading order, row by row and cell by cell,
/// each held (no save-back path reaches them).
fn flatten_table(t: &wml::Table, ctx: &ImportCtx, out: &mut Vec<Paragraph>) {
    for tc in &t.table_choice2 {
        let wml::TableChoice2::TableRow(tr) = tc else {
            continue;
        };
        for rc in &tr.table_row_choice {
            let wml::TableRowChoice::TableCell(cell) = rc else {
                continue;
            };
            for cc in &cell.table_cell_choice {
                match cc {
                    wml::TableCellChoice::Paragraph(p) => {
                        let mut para = map_paragraph(p, ctx, 0, None);
                        para.held.in_content_control = true;
                        out.push(para);
                    }
                    wml::TableCellChoice::Table(inner) => flatten_table(inner, ctx, out),
                    _ => {}
                }
            }
        }
    }
}

/// The next `w:txbxContent` ordinal of the part being mapped.
fn next_ordinal(ctx: &ImportCtx) -> u32 {
    let mut objects = ctx.objects.borrow_mut();
    let n = objects.next_ordinal;
    objects.next_ordinal += 1;
    n
}

/// A text box drawn by a `w:drawing` (`wps:wsp` with `wps:txbx`), or `None`
/// when the drawing is not one.
pub(crate) fn drawing_text_box(d: &wml::Drawing, ctx: &ImportCtx) -> Option<TextBox> {
    use paged_ooxml::ooxmlsdk::schemas::schemas_openxmlformats_org_drawingml_2006_wordprocessing_drawing as wp;
    let (width_emu, height_emu, graphic, float, doc_pr): (
        i64,
        i64,
        &aml::Graphic,
        Option<Float>,
        Option<u32>,
    ) = match d.drawing_choice.as_ref()? {
        wml::DrawingChoice::Inline(i) => (
            i.extent.cx,
            i.extent.cy,
            &i.graphic,
            None,
            Some(i.doc_properties.id),
        ),
        wml::DrawingChoice::Anchor(a) => {
            let a: &wp::Anchor = a;
            (
                a.extent.cx,
                a.extent.cy,
                &a.graphic,
                Some(map_float(a)),
                a.doc_properties.as_ref().map(|p| p.id),
            )
        }
    };
    let wsp = graphic
        .graphic_data
        .graphic_data_choice
        .iter()
        .find_map(|c| match c {
            aml::GraphicDataChoice::WordprocessingShape(s) => Some(s),
            _ => None,
        })?;
    let content = match wsp.wordprocessing_shape_choice2.as_ref()? {
        paged_ooxml::ooxmlsdk::schemas::schemas_microsoft_com_office_word_2010_wordprocessing_shape::WordprocessingShapeChoice2::TextBoxInfo2(t) => {
            t.text_box_content.as_ref()?
        }
        _ => return None,
    };
    let look = doc_pr.and_then(|id| {
        ctx.objects
            .borrow_mut()
            .looks
            .get_mut(&id)
            .and_then(|q| q.pop_front())
    });
    let ordinal = next_ordinal(ctx);
    let (paragraphs, held) = content_paragraphs(content, ctx);
    let mut insets = DEFAULT_INSETS;
    if let Some(b) = wsp.text_body_properties.as_deref() {
        if let Some(v) = b.top_inset {
            insets[0] = i64::from(v);
        }
        if let Some(v) = b.left_inset {
            insets[1] = i64::from(v);
        }
        if let Some(v) = b.bottom_inset {
            insets[2] = i64::from(v);
        }
        if let Some(v) = b.right_inset {
            insets[3] = i64::from(v);
        }
    }
    Some(TextBox {
        paragraphs,
        width_emu,
        height_emu,
        float,
        insets_emu: insets,
        look: look.filter(|l| !l.is_plain()).map(Box::new),
        ordinal,
        vml: false,
        held,
    })
}

/// A CSS declaration of a VML `style`.
fn css<'a>(style: &'a str, key: &str) -> Option<&'a str> {
    style.split(';').find_map(|decl| {
        let (k, v) = decl.split_once(':')?;
        (k.trim() == key).then(|| v.trim())
    })
}

/// A text box drawn by a legacy VML picture (`w:pict` → `v:shape` /
/// `v:rect` / `v:roundrect` with a `v:textbox`), or `None`.
pub(crate) fn vml_text_box(p: &wml::Picture, ctx: &ImportCtx) -> Option<TextBox> {
    for c in &p.picture_choice {
        let found: Option<(&str, &vml::TextBox, Option<&w10::TextWrap>)> = match c {
            wml::PictureChoice::Shape(s) => {
                let tb = s.shape_choice.iter().find_map(|sc| match sc {
                    vml::ShapeChoice::TextBox(t) => Some(t.as_ref()),
                    _ => None,
                });
                let wrap = s.shape_choice.iter().find_map(|sc| match sc {
                    vml::ShapeChoice::TextWrap(w) => Some(w),
                    _ => None,
                });
                tb.map(|t| (s.style.as_deref().unwrap_or(""), t, wrap))
            }
            wml::PictureChoice::Rectangle(r) => {
                let tb = r.rectangle_choice.iter().find_map(|sc| match sc {
                    vml::RectangleChoice::TextBox(t) => Some(t.as_ref()),
                    _ => None,
                });
                let wrap = r.rectangle_choice.iter().find_map(|sc| match sc {
                    vml::RectangleChoice::TextWrap(w) => Some(w),
                    _ => None,
                });
                tb.map(|t| (r.style.as_deref().unwrap_or(""), t, wrap))
            }
            _ => None,
        };
        let Some((style, tb, wrap)) = found else {
            continue;
        };
        let Some(vml::TextBoxChoice::TextBoxContent(content)) = tb.text_box_choice.as_ref() else {
            continue;
        };
        let length = |key: &str| css(style, key).and_then(crate::css_length_emu);
        let width_emu = length("width").unwrap_or(0);
        let height_emu = length("height").unwrap_or(0);
        let float = (css(style, "position") == Some("absolute")).then(|| vml_float(style, wrap));
        let ordinal = next_ordinal(ctx);
        let (paragraphs, held) = content_paragraphs(content, ctx);
        let mut insets = DEFAULT_INSETS;
        if let Some(inset) = tb.inset.as_deref() {
            // `left,top,right,bottom`, each a CSS length (empty = default).
            let parts: Vec<&str> = inset.split(',').collect();
            for (k, slot) in [(0usize, 1usize), (1, 0), (2, 3), (3, 2)] {
                if let Some(v) = parts.get(k).and_then(|v| crate::css_length_emu(v.trim())) {
                    insets[slot] = v;
                }
            }
        }
        return Some(TextBox {
            paragraphs,
            width_emu,
            height_emu,
            float,
            insets_emu: insets,
            look: None,
            ordinal,
            vml: true,
            held,
        });
    }
    None
}

/// A VML shape's CSS position as a [`Float`] (`margin-left` / `margin-top`
/// from `mso-position-horizontal-relative` / `-vertical-relative`, or an
/// `mso-position-horizontal` alignment), with its `w10:wrap`.
fn vml_float(style: &str, wrap: Option<&w10::TextWrap>) -> Float {
    let rel = |key: &str, default: &str| {
        let v = css(style, key).unwrap_or(default);
        match v {
            "page" => "page",
            "margin" => "margin",
            "text" => {
                if key.contains("horizontal") {
                    "column"
                } else {
                    "paragraph"
                }
            }
            "char" => "character",
            "line" => "line",
            _ => default,
        }
        .to_string()
    };
    let axis = |align_key: &str, rel_key: &str, margin_key: &str, default_rel: &str| {
        let mut p = FloatPosition {
            relative_from: rel(rel_key, default_rel),
            offset: None,
            align: None,
            percent: None,
        };
        match css(style, align_key) {
            Some(a) if a != "absolute" => p.align = Some(a.to_string()),
            _ => {
                p.offset = Some(
                    css(style, margin_key)
                        .and_then(crate::css_length_emu)
                        .unwrap_or(0),
                )
            }
        }
        p
    };
    let wrap_kind = wrap.and_then(|w| w.r#type);
    Float {
        horizontal: Some(axis(
            "mso-position-horizontal",
            "mso-position-horizontal-relative",
            "margin-left",
            "column",
        )),
        vertical: Some(axis(
            "mso-position-vertical",
            "mso-position-vertical-relative",
            "margin-top",
            "paragraph",
        )),
        wrap: match wrap_kind {
            Some(w10::WrapValues::Square) => FloatWrap::Square,
            Some(w10::WrapValues::Tight) => FloatWrap::Tight,
            Some(w10::WrapValues::Through) => FloatWrap::Through,
            Some(w10::WrapValues::TopAndBottom) => FloatWrap::TopAndBottom,
            // A VML shape without `w10:wrap` floats in front of the text.
            _ => FloatWrap::None,
        },
        behind_doc: css(style, "z-index").is_some_and(|z| z.trim_start().starts_with('-')),
        allow_overlap: true,
        ..Float::default()
    }
}

// ---------------------------------------------------------------------------
// Tables

/// One `w:tblBorders` / `w:tcBorders` edge as written.
macro_rules! edge {
    ($e:expr, $theme:expr) => {
        $e.as_ref().map(|b| BorderEdge {
            style: b.val.to_string(),
            size_eighths: b.size.unwrap_or(0),
            color: border_color(b.color.as_deref(), b.theme_color.map(|c| c.to_string()), $theme),
        })
    };
}

/// A border's colour as `RRGGBB` (`None` for `auto`); a theme colour wins
/// when the theme resolves it.
fn border_color(
    color: Option<&str>,
    theme_color: Option<String>,
    theme: Option<&Theme>,
) -> Option<String> {
    if let (Some(slot), Some(t)) = (theme_color.as_deref(), theme) {
        if let Some(hex) = t.base_color(slot) {
            return Some(hex.to_string());
        }
    }
    let c = color?.trim();
    (c.len() == 6 && c.chars().all(|ch| ch.is_ascii_hexdigit())).then(|| c.to_ascii_uppercase())
}

fn table_borders(b: &wml::TableBorders, theme: Option<&Theme>) -> Borders {
    Borders {
        top: edge!(b.top_border, theme),
        left: edge!(b.left_border, theme).or_else(|| edge!(b.start_border, theme)),
        bottom: edge!(b.bottom_border, theme),
        right: edge!(b.right_border, theme).or_else(|| edge!(b.end_border, theme)),
        inside_h: edge!(b.inside_horizontal_border, theme),
        inside_v: edge!(b.inside_vertical_border, theme),
    }
}

fn cell_borders(b: &wml::TableCellBorders, theme: Option<&Theme>) -> Borders {
    Borders {
        top: edge!(b.top_border, theme),
        left: edge!(b.left_border, theme).or_else(|| edge!(b.start_border, theme)),
        bottom: edge!(b.bottom_border, theme),
        right: edge!(b.right_border, theme).or_else(|| edge!(b.end_border, theme)),
        inside_h: None,
        inside_v: None,
    }
}

/// A `w:tblW` / `w:tcW` / `w:tblInd` measure.
fn preferred(
    width: &Option<paged_ooxml::ooxmlsdk::simple_type::MeasurementOrPercentValue>,
    kind: Option<String>,
) -> Option<PreferredWidth> {
    let raw = width.as_ref().map(|w| w.to_string()).unwrap_or_default();
    let kind = match kind.as_deref() {
        Some("dxa") => WidthKind::Dxa,
        Some("pct") => WidthKind::Pct,
        Some("nil") => WidthKind::Nil,
        Some("auto") | None => WidthKind::Auto,
        Some(_) => WidthKind::Auto,
    };
    let raw = raw.trim();
    let value = if let Some(pct) = raw.strip_suffix('%') {
        // `"50%"`: fiftieths of a percent.
        pct.trim()
            .parse::<f32>()
            .map(|v| (v * 50.0).round() as i32)
            .unwrap_or(0)
    } else {
        raw.parse::<f32>().map(|v| v.round() as i32).unwrap_or(0)
    };
    Some(PreferredWidth { kind, value })
}

/// `w:jc` of a table as Word's word.
fn table_jc(j: &wml::TableJustification) -> String {
    j.val.to_string()
}

/// `w:tblInd` in twips (a `dxa` measure; other units are not an indent
/// Word honours).
fn table_indent(i: &wml::TableIndentation) -> Option<i32> {
    let w = preferred(&i.width, i.r#type.map(|t| t.to_string()))?;
    matches!(w.kind, WidthKind::Dxa | WidthKind::Auto).then_some(w.value)
}

/// A table's `w:tblPr` look.
pub(crate) fn table_look(p: Option<&wml::TableProperties>, theme: Option<&Theme>) -> TableLook {
    let Some(p) = p else {
        return TableLook::default();
    };
    TableLook {
        style_id: p.table_style.as_ref().map(|s| s.val.clone()),
        borders: p
            .table_borders
            .as_deref()
            .map(|b| table_borders(b, theme))
            .unwrap_or_default(),
        shading: p.shading.as_ref().and_then(|s| theme::shading(s, theme)),
        indent: p.table_indentation.as_ref().and_then(table_indent),
        justification: p.table_justification.as_ref().map(table_jc),
        fixed_layout: p
            .table_layout
            .as_ref()
            .and_then(|l| l.r#type)
            .is_some_and(|t| t.to_string() == "fixed"),
        width: p
            .table_width
            .as_ref()
            .and_then(|w| preferred(&w.width, w.r#type.map(|t| t.to_string()))),
    }
}

/// A cell's `w:tcPr` look.
pub(crate) fn cell_look(p: Option<&wml::TableCellProperties>, theme: Option<&Theme>) -> CellLook {
    let Some(p) = p else {
        return CellLook::default();
    };
    CellLook {
        borders: p
            .table_cell_borders
            .as_deref()
            .map(|b| cell_borders(b, theme))
            .unwrap_or_default(),
        shading: p.shading.as_ref().and_then(|s| theme::shading(s, theme)),
        width: p
            .table_cell_width
            .as_ref()
            .and_then(|w| preferred(&w.width, w.r#type.map(|t| t.to_string()))),
    }
}

/// A row's `w:trHeight/@w:hRule` and `w:cantSplit`.
pub(crate) fn row_rules(p: Option<&wml::TableRowProperties>) -> (HeightRule, bool) {
    let Some(p) = p else {
        return (HeightRule::AtLeast, false);
    };
    let mut rule = HeightRule::AtLeast;
    let mut cant_split = false;
    for c in &p.table_row_properties_choice1 {
        match c {
            wml::TableRowPropertiesChoice::TableRowHeight(h) => {
                rule = match h.height_type.map(|t| t.to_string()).as_deref() {
                    Some("exact") => HeightRule::Exact,
                    Some("auto") => HeightRule::Auto,
                    _ => HeightRule::AtLeast,
                };
            }
            wml::TableRowPropertiesChoice::CantSplit(v) => {
                cant_split = v.val.is_none() || crate::on(&v.val);
            }
            _ => {}
        }
    }
    (rule, cant_split)
}

/// A table style's table-level properties (`w:tblPr`, the whole-table
/// `w:tcPr`); conditional regions are flagged, not read.
pub(crate) fn table_style_props(s: &wml::Style, theme: Option<&Theme>) -> Option<TableStyleProps> {
    let tp = s.style_table_properties.as_deref();
    let cp = s.style_table_cell_properties.as_deref();
    let props = TableStyleProps {
        borders: tp
            .and_then(|p| p.table_borders.as_deref())
            .map(|b| table_borders(b, theme))
            .unwrap_or_default(),
        shading: cp
            .and_then(|c| c.shading.as_ref())
            .or(tp.and_then(|p| p.shading.as_ref()))
            .and_then(|s| theme::shading(s, theme)),
        indent: tp
            .and_then(|p| p.table_indentation.as_ref())
            .and_then(table_indent),
        justification: tp
            .and_then(|p| p.table_justification.as_ref())
            .map(table_jc),
        conditional: !s.table_style_properties.is_empty(),
    };
    Some(props)
}

// ---------------------------------------------------------------------------
// Markup compatibility

/// The namespaces a raw `mc:Choice` / `mc:Fallback` child may use, which
/// its own start tag does not declare (they are on the part's root).
const CHILD_NS: &[(&str, &str)] = &[
    (
        "w",
        "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
    ),
    (
        "r",
        "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    ),
    (
        "wp",
        "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing",
    ),
    (
        "wp14",
        "http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing",
    ),
    ("a", "http://schemas.openxmlformats.org/drawingml/2006/main"),
    (
        "pic",
        "http://schemas.openxmlformats.org/drawingml/2006/picture",
    ),
    (
        "wps",
        "http://schemas.microsoft.com/office/word/2010/wordprocessingShape",
    ),
    (
        "wpg",
        "http://schemas.microsoft.com/office/word/2010/wordprocessingGroup",
    ),
    (
        "mc",
        "http://schemas.openxmlformats.org/markup-compatibility/2006",
    ),
    (
        "a14",
        "http://schemas.microsoft.com/office/drawing/2010/main",
    ),
    ("v", "urn:schemas-microsoft-com:vml"),
    ("o", "urn:schemas-microsoft-com:office:office"),
    ("w10", "urn:schemas-microsoft-com:office:word"),
    (
        "w14",
        "http://schemas.microsoft.com/office/word/2010/wordml",
    ),
];

/// `child` with the namespaces it uses but does not declare added to its
/// start tag.
fn declared(child: &[u8]) -> Vec<u8> {
    let Some(end) = child.iter().position(|b| *b == b'>') else {
        return child.to_vec();
    };
    let head = String::from_utf8_lossy(&child[..end]).to_string();
    let close = if head.ends_with('/') { end - 1 } else { end };
    let mut out = child[..close].to_vec();
    let text = String::from_utf8_lossy(child);
    for (prefix, uri) in CHILD_NS {
        let used = text.contains(&format!("<{prefix}:")) || text.contains(&format!(" {prefix}:"));
        if used && !head.contains(&format!("xmlns:{prefix}=")) {
            out.extend_from_slice(format!(" xmlns:{prefix}=\"{uri}\"").as_bytes());
        }
    }
    out.extend_from_slice(&child[close..]);
    out
}

/// The branch of an `mc:AlternateContent` in a run the import reads: the
/// first `mc:Choice` that requires only DrawingML shapes, pictures or
/// Word 2010 drawing extensions (`wps`, `wp14`, `a14`, `w14`), else the
/// `mc:Fallback`. Its pictures and text boxes join the run's.
pub(crate) fn alternate_content(
    ac: &paged_ooxml::ooxmlsdk::schemas::schemas_openxmlformats_org_markup_compatibility_2006::AlternateContent,
    ctx: &ImportCtx,
    images: &mut Vec<docx_core::Image>,
    text_boxes: &mut Vec<TextBox>,
    other_drawings: &mut u32,
) {
    use paged_ooxml::ooxmlsdk::schemas::schemas_openxmlformats_org_markup_compatibility_2006::AlternateContentChoice as B;
    const KNOWN: &[&str] = &["wps", "wp14", "a14", "w14"];
    let choice = ac.alternate_content_choice.iter().find_map(|b| match b {
        B::Choice(c) if c.requires.split_whitespace().all(|r| KNOWN.contains(&r)) => {
            Some((&c.xml_children, false))
        }
        _ => None,
    });
    let branch = choice.or_else(|| {
        ac.alternate_content_choice.iter().find_map(|b| match b {
            B::Fallback(f) => Some((&f.xml_children, true)),
            _ => None,
        })
    });
    let Some((children, fallback)) = branch else {
        return;
    };
    for child in children {
        let bytes = declared(child);
        let name = String::from_utf8_lossy(&bytes[..bytes.len().min(16)]).to_string();
        if name.starts_with("<w:drawing") {
            match paged_ooxml::parse_root::<wml::Drawing>("mc:AlternateContent", &bytes) {
                Ok(d) => match crate::map_drawing(&d, ctx) {
                    Some(img) => images.push(img),
                    None => match drawing_text_box(&d, ctx) {
                        Some(mut tb) => {
                            tb.held |= fallback;
                            text_boxes.push(tb);
                        }
                        None => *other_drawings += 1,
                    },
                },
                Err(_) => *other_drawings += 1,
            }
        } else if name.starts_with("<w:pict") {
            match paged_ooxml::parse_root::<wml::Picture>("mc:AlternateContent", &bytes) {
                Ok(p) => match crate::map_pict(&p, ctx) {
                    Some(img) => images.push(img),
                    None => match vml_text_box(&p, ctx) {
                        // Read from a fallback, the box does not hold the
                        // ordinal save-back counts (its choice does): held.
                        Some(mut tb) => {
                            tb.held = true;
                            text_boxes.push(tb);
                        }
                        None => ctx.unplaced_vml.set(ctx.unplaced_vml.get() + 1),
                    },
                },
                Err(_) => *other_drawings += 1,
            }
        }
    }
}
