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

//! Wave W4a's lowering (doc ADR 614): Word's floating objects and text
//! boxes onto the engine's anchored objects and page items, the table
//! look onto cell strokes and fills, and `w:lang` onto the applied
//! language.
//!
//! ## Floats: page item or anchored object
//!
//! A Word float stands on the page its anchor paragraph lands on. Where
//! the lowering knows that page it places the float as a PAGE ITEM, which
//! the engine wraps text around (engine ADRs 139 / 143 / 151): a float
//! anchored in the first paragraph of a story (the story's authored page,
//! `docx_p{k}`) and every float of a header or footer (its masters).
//! Square wraps as the bounding box, top-and-bottom as a jump object,
//! tight and through as a contour; in front of or behind the text, no
//! wrap.
//!
//! Anywhere else the page is only known after layout, so the float is an
//! ANCHORED OBJECT of its paragraph, which follows the text to its page:
//! - top and bottom (and a square / tight / through float that leaves
//!   less than [`NARROWEST_SIDE_PT`] of text beside it): ABOVE THE LINE,
//!   aligned in its column, so the text resumes below it as in Word (its
//!   vertical offset is not kept: the band starts at the anchor line);
//! - square, tight, through, in front, behind: CUSTOM, at Word's position
//!   against the page, the margins, the column, the paragraph or the
//!   line. The engine's anchored objects take no text wrap yet, so text
//!   runs under a square float until they do.
//!
//! Text boxes have no anchored form on the wire (`insertAnchoredFrame`
//! makes a graphic frame), so only the page-item cases place one.

use docx_core::{BorderEdge, Borders, DocxDocument, Image, Run, TextBox};

use crate::ir::{
    LoweredAnchor, LoweredCellLook, LoweredEdge, LoweredFloat, LoweredFloatPosition,
    LoweredItemHost, LoweredItemKind, LoweredItemSource, LoweredPageItem, LoweredSection,
    LoweredWrap,
};
use crate::sections::{self, LowerOptions};
use crate::{emu_to_pt, lower_float, lower_image, structure, twip_to_pt};

/// A square, tight or through float that leaves less than this much text
/// width beside it on the side(s) its text may take (pt): Word sets no
/// line there, so it is placed as top and bottom (a band of its own).
pub const NARROWEST_SIDE_PT: f32 = 36.0;

// ---------------------------------------------------------------------------
// Language

/// The engine's applied language (InDesign's names, which the engine's
/// hyphenation resolves: `paged_text::hyphenate::Language::from_idml`) for
/// a Word language tag. A language the engine has no patterns for keeps
/// its own name, so it is not hyphenated as English.
pub fn applied_language(tag: &str) -> String {
    let lower = tag.trim().to_ascii_lowercase().replace('_', "-");
    let mut parts = lower.split('-');
    let lang = parts.next().unwrap_or("");
    let region = parts.next().unwrap_or("");
    let name = match (lang, region) {
        ("en", "gb" | "ie" | "au" | "nz" | "za" | "in") => "English: UK",
        ("en", "ca") => "English: Canadian",
        ("en", _) => "English: USA",
        ("de", "ch") => "de_CH_2006",
        ("de", _) => "de_DE_2006",
        ("fr", "ca") => "French: Canadian",
        ("fr", _) => "French",
        ("es", _) => "Spanish: Castilian",
        ("it", _) => "Italian",
        ("nl", _) => "nl_NL_2005",
        ("pt", "br") => "Portuguese: Brazilian",
        ("pt", _) => "Portuguese",
        ("sv", _) => "Swedish",
        ("da", _) => "Danish",
        ("nb" | "no", _) => "Norwegian: Bokmal",
        ("nn", _) => "Norwegian: Nynorsk",
        ("fi", _) => "Finnish",
        ("pl", _) => "Polish",
        ("cs", _) => "Czech",
        ("sk", _) => "Slovak",
        ("hu", _) => "Hungarian",
        ("ro", _) => "Romanian",
        ("ru", _) => "Russian",
        ("uk", _) => "Ukrainian",
        ("el", _) => "Greek",
        ("tr", _) => "Turkish",
        ("ca", _) => "Catalan",
        ("hr", _) => "Croatian",
        ("sl", _) => "Slovenian",
        ("bg", _) => "Bulgarian",
        ("et", _) => "Estonian",
        ("lv", _) => "Latvian",
        ("lt", _) => "Lithuanian",
        ("he", _) => "Hebrew",
        ("ar", _) => "Arabic",
        ("ja", _) => "Japanese",
        ("zh", _) => "Chinese",
        ("ko", _) => "Korean",
        // `x-none` and the like: no language, so no hyphenation.
        _ => "[No Language]",
    };
    format!("$ID/{name}")
}

// ---------------------------------------------------------------------------
// Geometry

/// A page's geometry in points (top-left origin).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PageGeo {
    pub width: f32,
    pub height: f32,
    pub top: f32,
    pub bottom: f32,
    pub left: f32,
    pub right: f32,
}

impl PageGeo {
    pub fn of_section(s: &docx_core::Section) -> Self {
        PageGeo {
            width: twip_to_pt(s.page_width),
            height: twip_to_pt(s.page_height),
            top: twip_to_pt(s.margin_top),
            bottom: twip_to_pt(s.margin_bottom),
            left: twip_to_pt(s.margin_left),
            right: twip_to_pt(s.margin_right),
        }
    }

    pub fn of_lowered(s: &LoweredSection) -> Self {
        PageGeo {
            width: s.page_width_pt,
            height: s.page_height_pt,
            top: s.margin_top_pt,
            bottom: s.margin_bottom_pt,
            left: s.margin_left_pt,
            right: s.margin_right_pt,
        }
    }

    /// The span `relative_from` names on an axis, in page points. `para_top`
    /// is where the anchor paragraph (and its line) starts.
    fn span(&self, relative_from: &str, horizontal: bool, para_top: f32) -> (f32, f32) {
        if horizontal {
            match relative_from {
                "page" => (0.0, self.width),
                "leftMargin" | "insideMargin" => (0.0, self.left),
                "rightMargin" | "outsideMargin" => (self.width - self.right, self.width),
                // `margin`, `column`, `character`: the text area (one
                // column; the anchor character is taken at the column's
                // start).
                _ => (self.left, self.width - self.right),
            }
        } else {
            match relative_from {
                "page" => (0.0, self.height),
                "margin" => (self.top, self.height - self.bottom),
                "topMargin" | "insideMargin" => (0.0, self.top),
                "bottomMargin" | "outsideMargin" => (self.height - self.bottom, self.height),
                // `paragraph`, `line`: the anchor paragraph's top.
                _ => (para_top, para_top),
            }
        }
    }
}

/// Where Word puts the near edge of an object `size` long on one axis,
/// in page points.
fn place(p: &LoweredFloatPosition, span: (f32, f32), size: f32) -> f32 {
    if let Some(a) = &p.align {
        return match a.as_str() {
            "center" => (span.0 + span.1 - size) * 0.5,
            "right" | "bottom" | "outside" => span.1 - size,
            _ => span.0,
        };
    }
    if let Some(pct) = p.percent {
        return span.0 + pct / 100.0 * (span.1 - span.0);
    }
    span.0 + p.offset_pt.unwrap_or(0.0)
}

/// A float's page bounds `[top, left, bottom, right]`, its anchor paragraph
/// starting at `para_top`.
pub fn page_bounds(f: &LoweredFloat, w: f32, h: f32, geo: &PageGeo, para_top: f32) -> [f32; 4] {
    let (x, y) = match f.simple_pos_pt {
        Some((x, y)) => (x, y),
        None => {
            let column = LoweredFloatPosition {
                relative_from: "column".into(),
                ..LoweredFloatPosition::default()
            };
            let para = LoweredFloatPosition {
                relative_from: "paragraph".into(),
                ..LoweredFloatPosition::default()
            };
            let hp = f.horizontal.as_ref().unwrap_or(&column);
            let vp = f.vertical.as_ref().unwrap_or(&para);
            (
                place(hp, geo.span(&hp.relative_from, true, para_top), w),
                place(vp, geo.span(&vp.relative_from, false, para_top), h),
            )
        }
    };
    [y, x, y + h, x + w]
}

/// The engine's text wrap for a float, `None` for one in front of or behind
/// the text.
pub fn wrap_for(f: &LoweredFloat) -> Option<LoweredWrap> {
    let (mode, contour) = match f.wrap.as_str() {
        "wrapSquare" => ("BoundingBoxTextWrap", None),
        "wrapTopAndBottom" => ("JumpObjectTextWrap", None),
        "wrapTight" | "wrapThrough" => ("ContourTextWrap", Some("GraphicFrame".to_string())),
        _ => return None,
    };
    let side = match f.wrap_text.as_deref() {
        Some("left") => Some("LeftSide"),
        Some("right") => Some("RightSide"),
        Some("largest") => Some("LargestArea"),
        Some("bothSides") => Some("BothSides"),
        _ => None,
    };
    Some(LoweredWrap {
        mode: mode.into(),
        offsets_pt: [
            f.dist_top_pt,
            f.dist_left_pt,
            f.dist_bottom_pt,
            f.dist_right_pt,
        ],
        side: side.map(str::to_string),
        contour,
        polygon_pt: f.wrap_polygon_pt.clone(),
    })
}

/// How an anchored float was placed, for the diagnostics.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AnchorCase {
    /// Custom, at Word's position; its wrap is not applied.
    Custom { wraps: bool },
    /// Above the line (top and bottom, or no room beside it); `moved` when
    /// Word's horizontal offset is not one of the column's three alignments.
    AboveLine { moved: bool },
}

/// One axis of an anchored float: the engine's reference and alignment,
/// the corner (`0` near, `1` centre, `2` far) and the offset.
fn anchor_axis(
    p: &LoweredFloatPosition,
    horizontal: bool,
    size: f32,
    geo: &PageGeo,
) -> (&'static str, u8, f32) {
    let native = if horizontal {
        match p.relative_from.as_str() {
            "page" => Some("PageEdge"),
            "margin" => Some("TextFrame"),
            "column" => Some("ColumnEdge"),
            "character" => Some("AnchorLocation"),
            _ => None,
        }
    } else {
        match p.relative_from.as_str() {
            "page" => Some("PageEdge"),
            "margin" => Some("TextFrame"),
            "paragraph" | "line" => Some("TopOfLeading"),
            _ => None,
        }
    };
    let line_like = !horizontal && matches!(p.relative_from.as_str(), "paragraph" | "line");
    match native {
        Some(r) if !line_like || p.align.is_none() => {
            if let Some(a) = &p.align {
                let corner = match a.as_str() {
                    "center" => 1,
                    "right" | "bottom" | "outside" => 2,
                    _ => 0,
                };
                return (r, corner, 0.0);
            }
            let offset = match p.percent {
                Some(pct) => {
                    let (a, b) = geo.span(&p.relative_from, horizontal, 0.0);
                    pct / 100.0 * (b - a)
                }
                None => p.offset_pt.unwrap_or(0.0),
            };
            (r, 0, offset)
        }
        // A line-relative alignment: the line's top.
        Some(r) => (r, 0, 0.0),
        // Part of the page (a margin band): its edge, Word's offset from it.
        None => (
            "PageEdge",
            0,
            place(p, geo.span(&p.relative_from, horizontal, 0.0), size),
        ),
    }
}

fn anchor_point(v: u8, h: u8) -> &'static str {
    match (v, h) {
        (0, 0) => "TopLeftAnchor",
        (0, 1) => "TopCenterAnchor",
        (0, _) => "TopRightAnchor",
        (1, 0) => "LeftCenterAnchor",
        (1, 1) => "CenterAnchor",
        (1, _) => "RightCenterAnchor",
        (_, 0) => "BottomLeftAnchor",
        (_, 1) => "BottomCenterAnchor",
        (_, _) => "BottomRightAnchor",
    }
}

/// The anchored-object settings of a float `w` x `h` pt, on a page of
/// `geo`'s geometry.
pub fn anchor_for(f: &LoweredFloat, w: f32, h: f32, geo: &PageGeo) -> (LoweredAnchor, AnchorCase) {
    let column = (geo.left, geo.width - geo.right);
    let bounds = page_bounds(f, w, h, geo, geo.top);
    let side_room = || {
        let left = bounds[1] - f.dist_left_pt - column.0;
        let right = column.1 - bounds[3] - f.dist_right_pt;
        match f.wrap_text.as_deref() {
            Some("left") => left,
            Some("right") => right,
            _ => left.max(right),
        }
    };
    let band = match f.wrap.as_str() {
        "wrapTopAndBottom" => true,
        "wrapSquare" | "wrapTight" | "wrapThrough" => side_room() < NARROWEST_SIDE_PT,
        _ => false,
    };
    if band {
        let (x, align, moved) = match f.horizontal.as_ref().and_then(|p| p.align.as_deref()) {
            Some("center") => (0.0, "CenterAlign", false),
            Some("right" | "outside") => (0.0, "RightAlign", false),
            Some(_) => (0.0, "LeftAlign", false),
            None => {
                let left = bounds[1] - column.0;
                let right = column.1 - bounds[3];
                let centre = (left - right).abs() * 0.5;
                let near = left.abs().min(right.abs()).min(centre);
                let align = if near == left.abs() {
                    "LeftAlign"
                } else if near == right.abs() {
                    "RightAlign"
                } else {
                    "CenterAlign"
                };
                (0.0, align, near > 1.0)
            }
        };
        return (
            LoweredAnchor {
                position: "AbovePosition".into(),
                anchor_point: "TopLeftAnchor".into(),
                horizontal_reference: "ColumnEdge".into(),
                horizontal_alignment: align.into(),
                vertical_reference: "TopOfLeading".into(),
                vertical_alignment: "TopAlign".into(),
                x_offset_pt: x,
                // The space after the band: Word's distance below it.
                y_offset_pt: f.dist_bottom_pt,
            },
            AnchorCase::AboveLine { moved },
        );
    }
    let (href, hc, hoff, vref, vc, voff) = match f.simple_pos_pt {
        Some((x, y)) => ("PageEdge", 0, x, "PageEdge", 0, y),
        None => {
            let column_pos = LoweredFloatPosition {
                relative_from: "column".into(),
                ..LoweredFloatPosition::default()
            };
            let para_pos = LoweredFloatPosition {
                relative_from: "paragraph".into(),
                ..LoweredFloatPosition::default()
            };
            let (hr, hc, ho) =
                anchor_axis(f.horizontal.as_ref().unwrap_or(&column_pos), true, w, geo);
            let (vr, vc, vo) = anchor_axis(f.vertical.as_ref().unwrap_or(&para_pos), false, h, geo);
            (hr, hc, ho, vr, vc, vo)
        }
    };
    let h_align = ["LeftAlign", "CenterAlign", "RightAlign"][hc as usize];
    let v_align = ["TopAlign", "CenterAlign", "BottomAlign"][vc as usize];
    (
        LoweredAnchor {
            position: "Anchored".into(),
            anchor_point: anchor_point(vc, hc).into(),
            horizontal_reference: href.into(),
            horizontal_alignment: h_align.into(),
            vertical_reference: vref.into(),
            vertical_alignment: v_align.into(),
            x_offset_pt: hoff,
            y_offset_pt: voff,
        },
        AnchorCase::Custom {
            wraps: matches!(f.wrap.as_str(), "wrapSquare" | "wrapTight" | "wrapThrough"),
        },
    )
}

/// Whether a float's vertical reference is its paragraph (or none, which
/// Word reads as the paragraph): the anchor then stands at the paragraph's
/// start, whose first line the engine measures from.
pub fn paragraph_relative(f: &LoweredFloat) -> bool {
    f.simple_pos_pt.is_none()
        && f.vertical
            .as_ref()
            .is_none_or(|v| v.relative_from == "paragraph")
}

// ---------------------------------------------------------------------------
// Page items

/// Where a planned page item comes from: the body block or the header /
/// footer part (index into `DocxDocument::headers_footers`), and which
/// paragraph, run and object of the run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ItemOrigin {
    Body {
        block: usize,
        run: usize,
        object: ObjectRef,
    },
    Part {
        part: usize,
        paragraph: usize,
        run: usize,
        object: ObjectRef,
    },
}

/// A run's picture or text box, by index.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ObjectRef {
    Picture(usize),
    TextBox(usize),
}

/// The page item id of the `n`-th planned object.
pub fn item_id(n: usize) -> String {
    format!("docx_o{n}")
}

/// The story of the `n`-th planned object (a text box).
pub fn item_story_id(n: usize) -> String {
    format!("docx_o{n}_s")
}

/// The page id the skeleton gives story `k`'s authored page.
fn story_page_id(k: usize) -> String {
    format!("docx_p{k}")
}

/// The page items a document's floats and text boxes become (doc ADR
/// 614), with where each comes from. Text boxes' paragraphs are left
/// empty: [`crate::lower_with`] lowers them. Shared by the lowering and the
/// skeleton, so the two agree on ids and frames.
pub fn plan_page_items(
    doc: &DocxDocument,
    options: LowerOptions,
) -> Vec<(ItemOrigin, LoweredPageItem)> {
    let placements = sections::place_sections_with(&doc.sections, options, &mut Vec::new());
    let (masters, _) = structure::plan_masters(doc, &placements);
    let slots: Vec<(String, paged_ooxml::drawingml::Rgba)> = doc
        .theme
        .as_ref()
        .map(docx_core::Theme::drawingml_slots)
        .unwrap_or_default();
    let mut out: Vec<(ItemOrigin, LoweredPageItem)> = Vec::new();
    // The body: each story's first block, on the story's authored page.
    let mut stories = 0usize;
    for (sec, p) in doc.sections.iter().zip(&placements) {
        if p.story != stories {
            continue;
        }
        stories += 1;
        let page = story_page_id(p.story);
        let geo = PageGeo::of_section(sec);
        let Some(docx_core::Block::Paragraph(para)) = doc.body.get(sec.first_block) else {
            continue;
        };
        for (ri, run) in para.runs.iter().enumerate() {
            for (object, made) in run_items(run, &geo, geo.top, true, &slots) {
                let n = out.len();
                out.push((
                    ItemOrigin::Body {
                        block: sec.first_block,
                        run: ri,
                        object,
                    },
                    made.finish(
                        n,
                        LoweredItemHost::Page {
                            page_id: page.clone(),
                        },
                        "word/document.xml",
                    ),
                ));
            }
        }
    }
    // Headers and footers: every object of the part, on each master
    // showing it.
    for m in &masters {
        let geo = doc
            .sections
            .get(m.section)
            .map(PageGeo::of_section)
            .unwrap_or(PageGeo {
                width: m.page_width_pt,
                height: m.page_height_pt,
                top: 72.0,
                bottom: 72.0,
                left: 72.0,
                right: 72.0,
            });
        for frame in [&m.header, &m.footer].into_iter().flatten() {
            let Some(part) = doc.headers_footers.get(frame.part) else {
                continue;
            };
            for (pi, para) in part.paragraphs.iter().enumerate() {
                for (ri, run) in para.runs.iter().enumerate() {
                    for (object, made) in run_items(run, &geo, frame.bounds[0], false, &slots) {
                        let n = out.len();
                        out.push((
                            ItemOrigin::Part {
                                part: frame.part,
                                paragraph: pi,
                                run: ri,
                                object,
                            },
                            made.finish(
                                n,
                                LoweredItemHost::Master {
                                    master_id: m.id.clone(),
                                },
                                &part.part,
                            ),
                        ));
                    }
                }
            }
        }
    }
    out
}

/// A page item before it has its id.
struct Made {
    bounds: [f32; 4],
    wrap: Option<LoweredWrap>,
    behind: bool,
    fx: Option<dml_native::native::NativeFx>,
    picture: Option<String>,
    text_box: Option<([f32; 4], u32, bool, bool)>,
}

impl Made {
    fn finish(self, n: usize, host: LoweredItemHost, part: &str) -> LoweredPageItem {
        let (item, source) = match (self.picture, self.text_box) {
            (Some(uri), _) => (
                LoweredItemKind::Picture { uri },
                LoweredItemSource {
                    part: part.to_string(),
                    ..LoweredItemSource::default()
                },
            ),
            (None, Some((insets_pt, ordinal, vml, held))) => (
                LoweredItemKind::TextBox {
                    story_id: item_story_id(n),
                    paragraphs: Vec::new(),
                    insets_pt,
                },
                LoweredItemSource {
                    part: part.to_string(),
                    ordinal: Some(ordinal),
                    vml,
                    editable: !held,
                },
            ),
            (None, None) => unreachable!("a page item is a picture or a text box"),
        };
        LoweredPageItem {
            id: item_id(n),
            host,
            bounds: self.bounds,
            item,
            wrap: self.wrap,
            behind: self.behind,
            fx: self.fx,
            source,
        }
    }
}

/// The run's pictures and text boxes that become page items. In the body
/// (`body`) a float or text box of the story's first paragraph; in a
/// header or footer every float and text box (inline pictures stay in the
/// text, unpoured as before).
fn run_items(
    run: &Run,
    geo: &PageGeo,
    para_top: f32,
    body: bool,
    slots: &[(String, paged_ooxml::drawingml::Rgba)],
) -> Vec<(ObjectRef, Made)> {
    let mut out = Vec::new();
    for (i, img) in run.images.iter().enumerate() {
        let Some(f) = img
            .float
            .as_ref()
            .map(|f| lower_float(f, img.width_emu, img.height_emu))
        else {
            continue;
        };
        if f.layout_in_cell && !body {
            continue;
        }
        let w = emu_to_pt(img.width_emu);
        let h = emu_to_pt(img.height_emu);
        out.push((
            ObjectRef::Picture(i),
            Made {
                bounds: page_bounds(&f, w, h, geo, para_top),
                wrap: wrap_for(&f),
                behind: f.behind_doc,
                fx: picture_fx(img, w, h, slots),
                picture: Some(lower_image(img).uri),
                text_box: None,
            },
        ));
    }
    for (i, tb) in run.text_boxes.iter().enumerate() {
        let w = emu_to_pt(tb.width_emu);
        let h = emu_to_pt(tb.height_emu);
        let (bounds, wrap, behind) = match tb
            .float
            .as_ref()
            .map(|f| lower_float(f, tb.width_emu, tb.height_emu))
        {
            Some(f) => (
                page_bounds(&f, w, h, geo, para_top),
                wrap_for(&f),
                f.behind_doc,
            ),
            // An inline box of the first paragraph: at the text area's
            // top-left (its line's other text is not measured).
            None if body => (
                [para_top, geo.left, para_top + h, geo.left + w],
                None,
                false,
            ),
            None => continue,
        };
        out.push((
            ObjectRef::TextBox(i),
            Made {
                bounds,
                wrap,
                behind,
                fx: box_fx(tb, w, h, slots),
                picture: None,
                text_box: Some((box_insets(tb), tb.ordinal, tb.vml, tb.held)),
            },
        ));
    }
    out
}

/// A text box's internal margins in points, top, left, bottom, right.
pub fn box_insets(tb: &TextBox) -> [f32; 4] {
    tb.insets_emu.map(emu_to_pt)
}

fn picture_fx(
    img: &Image,
    w: f32,
    h: f32,
    slots: &[(String, paged_ooxml::drawingml::Rgba)],
) -> Option<dml_native::native::NativeFx> {
    let look = img.look.as_ref()?;
    let mut mapper = dml_native::native::Lowering::new(slots.to_vec());
    let fx = mapper.picture(&look.blip, &look.shape, w as f64, h as f64);
    (!fx.is_empty()).then_some(fx)
}

fn box_fx(
    tb: &TextBox,
    w: f32,
    h: f32,
    slots: &[(String, paged_ooxml::drawingml::Rgba)],
) -> Option<dml_native::native::NativeFx> {
    let look = tb.look.as_ref()?;
    let mut mapper = dml_native::native::Lowering::new(slots.to_vec());
    let fx = mapper.picture(&look.blip, &look.shape, w as f64, h as f64);
    (!fx.is_empty()).then_some(fx)
}

/// Whether `origin` is planned as a page item.
pub fn is_planned(plan: &[(ItemOrigin, LoweredPageItem)], origin: ItemOrigin) -> bool {
    plan.iter().any(|(o, _)| *o == origin)
}

// ---------------------------------------------------------------------------
// Tables

/// One Word border edge as the engine strokes it: its weight (0 for no
/// line) and colour (Word's `auto` is black).
pub fn edge_of(e: Option<&BorderEdge>, swatch: &mut dyn FnMut(&str) -> String) -> LoweredEdge {
    match e.filter(|e| e.visible()) {
        Some(e) => LoweredEdge {
            weight_pt: e.size_eighths as f32 / 8.0,
            color: swatch(e.color.as_deref().unwrap_or("000000")),
        },
        None => LoweredEdge {
            weight_pt: 0.0,
            color: swatch("000000"),
        },
    }
}

/// A cell's four edges as Word resolves them: the cell's own `w:tcBorders`
/// side, else the table's (`w:tblBorders` over its style's): its outer
/// side at the table's edge, its inside-H / inside-V edge between cells.
pub fn cell_edges<'a>(
    own: &'a Borders,
    table: &'a Borders,
    first_row: bool,
    last_row: bool,
    first_col: bool,
    last_col: bool,
) -> [Option<&'a BorderEdge>; 4] {
    let pick = |own: &'a Option<BorderEdge>,
                outer: &'a Option<BorderEdge>,
                inside: &'a Option<BorderEdge>,
                at_edge: bool| {
        own.as_ref().or(if at_edge {
            outer.as_ref()
        } else {
            inside.as_ref()
        })
    };
    [
        pick(&own.top, &table.top, &table.inside_h, first_row),
        pick(&own.left, &table.left, &table.inside_v, first_col),
        pick(&own.bottom, &table.bottom, &table.inside_h, last_row),
        pick(&own.right, &table.right, &table.inside_v, last_col),
    ]
}

/// A lowered cell's look from its four edges and fill.
pub fn cell_look(
    edges: [Option<&BorderEdge>; 4],
    fill: Option<String>,
    swatch: &mut dyn FnMut(&str) -> String,
) -> LoweredCellLook {
    LoweredCellLook {
        top: edge_of(edges[0], swatch),
        left: edge_of(edges[1], swatch),
        bottom: edge_of(edges[2], swatch),
        right: edge_of(edges[3], swatch),
        fill,
    }
}

/// The paragraph justification that aligns a table as Word's `w:jc` does.
pub fn table_justification(jc: &str) -> Option<&'static str> {
    match jc {
        "center" => Some("CenterAlign"),
        "right" | "end" => Some("RightAlign"),
        _ => None,
    }
}

/// The lowering's W4a state: the page-item plan, what is being lowered,
/// and what the diagnostics report.
#[derive(Default)]
pub(crate) struct W4 {
    pub plan: Vec<(ItemOrigin, LoweredPageItem)>,
    pub scope: Scope,
    /// The page geometry of the section being lowered.
    pub geo: Option<PageGeo>,
    /// Floats placed as custom anchored objects (of them, square / tight /
    /// through, whose wrap is not applied), above the line (of them, whose
    /// horizontal offset is not kept), as page items.
    pub custom: usize,
    pub custom_wrapping: usize,
    pub above_line: usize,
    pub above_moved: usize,
    /// Text boxes that are not page items, and so are not placed.
    pub unplaced_boxes: usize,
    /// Nested tables shown as their paragraphs.
    pub nested_tables: usize,
    /// Rows Word holds at an exact height, and tables with an indent or a
    /// table style's conditional regions.
    pub exact_rows: usize,
    pub indented_tables: usize,
    pub conditional_styles: usize,
}

/// What the lowering is lowering, for the page-item plan's origins.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Scope {
    #[default]
    Other,
    Body,
    /// Paragraph `.1` of header / footer part `.0`.
    Part(usize, usize),
}

impl W4 {
    /// The origin of object `object` of run `run` in what is being lowered.
    pub fn origin(&self, block: usize, run: usize, object: ObjectRef) -> Option<ItemOrigin> {
        match self.scope {
            Scope::Body => Some(ItemOrigin::Body { block, run, object }),
            Scope::Part(part, paragraph) => Some(ItemOrigin::Part {
                part,
                paragraph,
                run,
                object,
            }),
            Scope::Other => None,
        }
    }

    pub fn planned(&self, block: usize, run: usize, object: ObjectRef) -> bool {
        self.origin(block, run, object)
            .is_some_and(|o| is_planned(&self.plan, o))
    }
}

impl crate::Lowering {
    /// Place a floating picture as an anchored object of its paragraph
    /// (doc ADR 614): its settings, and its anchor at the paragraph's start
    /// unless Word measures it from its line.
    pub(crate) fn anchor_float(&mut self, li: &mut crate::ir::LoweredImage) {
        let Some(f) = li.float.clone() else {
            return;
        };
        let geo = self.w4.geo.unwrap_or(PageGeo {
            width: 612.0,
            height: 792.0,
            top: 72.0,
            bottom: 72.0,
            left: 72.0,
            right: 72.0,
        });
        let (anchor, case) = anchor_for(&f, li.width_pt, li.height_pt, &geo);
        match case {
            AnchorCase::Custom { wraps } => {
                self.w4.custom += 1;
                if wraps {
                    self.w4.custom_wrapping += 1;
                }
            }
            AnchorCase::AboveLine { moved } => {
                self.w4.above_line += 1;
                if moved {
                    self.w4.above_moved += 1;
                }
            }
        }
        let by_line = f
            .vertical
            .as_ref()
            .is_some_and(|v| v.relative_from == "line");
        if !by_line {
            li.at = 0;
        }
        li.anchor = Some(anchor);
    }
}

/// A table's look as Word resolves it from its style chain and its own
/// `w:tblPr` (doc ADR 614).
#[derive(Debug, Clone, Default)]
pub(crate) struct ResolvedTable {
    pub borders: Borders,
    /// The table's fill (`w:shd`), `RRGGBB`.
    pub fill: Option<String>,
    pub justification: Option<String>,
    pub indent: Option<i32>,
    pub conditional: bool,
}

/// The text box `origin` names.
fn text_box_at(doc: &DocxDocument, origin: ItemOrigin) -> Option<&TextBox> {
    let (paragraph, run, object) = match origin {
        ItemOrigin::Body { block, run, object } => match doc.body.get(block)? {
            docx_core::Block::Paragraph(p) => (p, run, object),
            docx_core::Block::Table(_) => return None,
        },
        ItemOrigin::Part {
            part,
            paragraph,
            run,
            object,
        } => (
            doc.headers_footers.get(part)?.paragraphs.get(paragraph)?,
            run,
            object,
        ),
    };
    match object {
        ObjectRef::TextBox(i) => paragraph.runs.get(run)?.text_boxes.get(i),
        ObjectRef::Picture(_) => None,
    }
}

impl crate::Lowering {
    /// The page items, text boxes with their paragraphs lowered at the
    /// box's inner width.
    pub(crate) fn lower_page_items(&mut self, doc: &DocxDocument) -> Vec<LoweredPageItem> {
        let plan = std::mem::take(&mut self.w4.plan);
        let saved = (
            self.text_width,
            self.section_indent,
            self.section_columns,
            self.in_cell,
        );
        let mut out = Vec::with_capacity(plan.len());
        for (origin, item) in &plan {
            let mut item = item.clone();
            let width = item.bounds[3] - item.bounds[1];
            if let LoweredItemKind::TextBox {
                paragraphs,
                insets_pt,
                ..
            } = &mut item.item
            {
                if let Some(tb) = text_box_at(doc, *origin) {
                    self.text_width = Some((width - insets_pt[1] - insets_pt[3]).max(1.0));
                    self.section_indent = (0.0, 0.0);
                    self.section_columns = sections::SectionColumns::Frame;
                    self.in_cell = false;
                    *paragraphs = tb
                        .paragraphs
                        .iter()
                        .enumerate()
                        .map(|(i, p)| {
                            self.spacing_override = (None, false);
                            self.lower_body_paragraph(p, i as u32, None, Some(false)).0
                        })
                        .collect();
                }
            }
            out.push(item);
        }
        (
            self.text_width,
            self.section_indent,
            self.section_columns,
            self.in_cell,
        ) = saved;
        self.w4.plan = plan;
        out
    }

    /// The table's look: its style chain's table properties (the document's
    /// default table style when it names none) under its own.
    pub(crate) fn resolved_table_look(&mut self, t: &docx_core::Table) -> ResolvedTable {
        let style_id = t.look.style_id.clone().or_else(|| {
            self.word_styles
                .values()
                .find(|s| s.kind == docx_core::StyleKind::Table && s.is_default)
                .map(|s| s.style_id.clone())
        });
        let mut out = ResolvedTable::default();
        for s in self.style_chain(style_id.as_deref()).into_iter().rev() {
            let Some(tp) = &s.table else {
                continue;
            };
            out.borders = out.borders.merged(&tp.borders);
            if let Some(sh) = tp.shading.as_ref().and_then(|s| s.fill.clone()) {
                out.fill = Some(sh);
            }
            if tp.justification.is_some() {
                out.justification = tp.justification.clone();
            }
            if tp.indent.is_some() {
                out.indent = tp.indent;
            }
            out.conditional |= tp.conditional;
        }
        out.borders = out.borders.merged(&t.look.borders);
        if let Some(sh) = t.look.shading.as_ref().and_then(|s| s.fill.clone()) {
            out.fill = Some(sh);
        }
        if t.look.justification.is_some() {
            out.justification = t.look.justification.clone();
        }
        if t.look.indent.is_some() {
            out.indent = t.look.indent;
        }
        if out.conditional {
            self.w4.conditional_styles += 1;
        }
        if out.indent.is_some_and(|i| i != 0) {
            self.w4.indented_tables += 1;
        }
        out.borders = out.borders.clone();
        out
    }

    /// A cell's look at grid row `row`, column `col`, `span` columns wide, in
    /// a table of `rows` x `cols`.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn lowered_cell_look(
        &mut self,
        table: &ResolvedTable,
        cell: &docx_core::TableCell,
        row: usize,
        rows: usize,
        col: u32,
        span: u32,
        cols: u32,
    ) -> LoweredCellLook {
        let edges = cell_edges(
            &cell.look.borders,
            &table.borders,
            row == 0,
            row + 1 >= rows,
            col == 0,
            col + span >= cols,
        );
        let fill = cell
            .look
            .shading
            .as_ref()
            .and_then(|s| s.fill.clone())
            .or_else(|| table.fill.clone())
            .map(|hex| self.swatch_for(&hex));
        let mut swatch = |hex: &str| self.swatch_for(hex);
        cell_look(edges, fill, &mut swatch)
    }

    /// The bottom edge of a vertically merged cell: the last merged cell's.
    pub(crate) fn merged_bottom(
        &mut self,
        table: &ResolvedTable,
        cell: &docx_core::TableCell,
        row: usize,
        rows: usize,
    ) -> LoweredEdge {
        let own = cell.look.borders.bottom.as_ref();
        let edge = own.or(if row + 1 >= rows {
            table.borders.bottom.as_ref()
        } else {
            table.borders.inside_h.as_ref()
        });
        let mut swatch = |hex: &str| self.swatch_for(hex);
        edge_of(edge, &mut swatch)
    }

    /// The paragraph style that aligns a table as Word's `w:jc` (centre or
    /// right); `None` for a left-aligned one.
    pub(crate) fn table_para_style(&mut self, table: &ResolvedTable) -> Option<String> {
        let j = table_justification(table.justification.as_deref()?)?;
        Some(self.synthesize(
            crate::ir::StyleCollection::Paragraph,
            None,
            vec![crate::text("paragraphJustification", j)],
        ))
    }

    /// What the engine does not lay out of a table yet, carried.
    pub(crate) fn table_layout(
        &mut self,
        t: &docx_core::Table,
        table: &ResolvedTable,
    ) -> crate::ir::LoweredTableLayout {
        use docx_core::WidthKind;
        let width = t.look.width;
        let exact: Vec<bool> = t
            .rows
            .iter()
            .map(|r| r.height.is_some() && r.height_rule == docx_core::HeightRule::Exact)
            .collect();
        self.w4.exact_rows += exact.iter().filter(|e| **e).count();
        crate::ir::LoweredTableLayout {
            fixed: t.look.fixed_layout,
            width_pt: width
                .filter(|w| w.kind == WidthKind::Dxa)
                .map(|w| twip_to_pt(w.value)),
            width_pct: width
                .filter(|w| w.kind == WidthKind::Pct)
                .map(|w| w.value as f32 / 50.0),
            cell_widths_pt: t
                .rows
                .iter()
                .flat_map(|r| r.cells.iter())
                .filter(|c| c.v_merge != docx_core::VMerge::Continue)
                .map(|c| {
                    c.look
                        .width
                        .filter(|w| w.kind == WidthKind::Dxa)
                        .map(|w| twip_to_pt(w.value))
                })
                .collect(),
            indent_pt: table.indent.map(twip_to_pt),
            cant_split: if t.rows.iter().any(|r| r.cant_split) {
                t.rows.iter().map(|r| r.cant_split).collect()
            } else {
                Vec::new()
            },
            exact_rows: if exact.iter().any(|e| *e) {
                exact
            } else {
                Vec::new()
            },
        }
    }

    /// The diagnostics of wave W4a.
    pub(crate) fn w4_diagnostics(&mut self) {
        use crate::ir::Diagnostic;
        let w = &self.w4;
        let mut out = Vec::new();
        let pictures = w
            .plan
            .iter()
            .filter(|(_, i)| matches!(i.item, LoweredItemKind::Picture { .. }))
            .count();
        let boxes = w.plan.len() - pictures;
        if pictures + boxes > 0 {
            out.push(Diagnostic::info(
                format!(
                    "{pictures} floating picture(s) and {boxes} text box(es) placed as page \
                     items at Word's position, with Word's text wrap (anchored in a section's \
                     first paragraph, or in a header or footer)"
                ),
                2,
            ));
        }
        if w.custom > 0 {
            let mut msg = format!(
                "{} floating picture(s) placed at Word's position as anchored objects that \
                 follow their paragraph",
                w.custom
            );
            if w.custom_wrapping > 0 {
                msg.push_str(&format!(
                    "; {} of them wrap text in Word (square, tight or through), which the \
                     engine's anchored objects do not do yet, so text runs under them",
                    w.custom_wrapping
                ));
            }
            out.push(Diagnostic::info(msg, 2));
        }
        if w.above_line > 0 {
            let mut msg = format!(
                "{} floating picture(s) with text above and below (top and bottom, or no \
                 room for text beside them) placed in a band of their own above their \
                 anchor line, so the text resumes below them as in Word; their vertical \
                 offset is not kept",
                w.above_line
            );
            if w.above_moved > 0 {
                msg.push_str(&format!(
                    "; {} of them are aligned to the nearest of the column's left, centre \
                     or right, not at Word's horizontal offset",
                    w.above_moved
                ));
            }
            out.push(Diagnostic::info(msg, 2));
        }
        if w.unplaced_boxes > 0 {
            out.push(Diagnostic::warning(
                format!(
                    "{} text box(es) are NOT shown: a text box is placed only where its page \
                     is known (anchored in a section's first paragraph, or in a header or \
                     footer); elsewhere it would need an anchored text frame, which the \
                     engine cannot create yet. They are kept in the .docx and round-trip \
                     on save",
                    w.unplaced_boxes
                ),
                2,
            ));
        }
        if w.nested_tables > 0 {
            out.push(Diagnostic::warning(
                format!(
                    "{} table(s) nested in a table cell are shown as their paragraphs, in \
                     reading order, without their grid: no operation creates a table inside \
                     a cell yet. Edits to them are not saved back; the nested tables \
                     round-trip unchanged",
                    w.nested_tables
                ),
                2,
            ));
        }
        if w.exact_rows > 0 {
            out.push(Diagnostic::info(
                format!(
                    "{} table row(s) Word holds at an exact height grow with their text \
                     here: the engine's row has no fixed height on the wire yet",
                    w.exact_rows
                ),
                2,
            ));
        }
        if w.indented_tables > 0 {
            out.push(Diagnostic::info(
                format!(
                    "{} table(s) with an indent (w:tblInd) start at the column's edge: the \
                     engine does not indent a table yet",
                    w.indented_tables
                ),
                2,
            ));
        }
        if w.conditional_styles > 0 {
            out.push(Diagnostic::info(
                format!(
                    "{} table(s) use a table style with conditional formatting (header row, \
                     banding, first column): only the style's whole-table borders and \
                     shading are applied",
                    w.conditional_styles
                ),
                3,
            ));
        }
        self.diagnostics.extend(out);
    }
}
