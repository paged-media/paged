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

//! # pptx-core — the format-level IR of a `.pptx` deck
//!
//! A faithful, serialisable view of what the file AUTHORS: PresentationML and
//! DrawingML as written, with every inheritance link left unresolved. Lengths
//! are EMU (914 400 per inch, 12 700 per point), angles are 60 000ths of a
//! degree, percentages are 1 000ths of a percent — the units the file uses, so
//! nothing is rounded before the resolver (`slide-resolve`) applies
//! PowerPoint's rules. Placeholders keep their `type` / `idx`, colours keep
//! their scheme slot and transform chain, and text keeps its list levels; the
//! master → layout → slide cascade is reconstructed later, not here.
//!
//! Anything the importer does not model is carried as raw XML where it matters
//! for export (`Transition::xml`, `Slide::timing_xml`) and otherwise reported in
//! [`Presentation::diagnostics`].

pub mod anim;
pub mod chart;
pub mod media;
pub mod transcode;

use serde::{Deserialize, Serialize};

/// English Metric Units: 914 400 per inch, 12 700 per point.
pub type Emu = i64;

/// EMU per point (`paged_ooxml::units`).
pub use paged_ooxml::units::EMU_PER_PT;

/// A whole deck.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Presentation {
    /// `p:sldSz` (cx, cy).
    pub slide_size: (Emu, Emu),
    /// `p:notesSz` (cx, cy).
    pub notes_size: (Emu, Emu),
    /// Slides in presentation order (`p:sldIdLst`).
    pub slides: Vec<Slide>,
    /// Every slide master referenced by `p:sldMasterIdLst`.
    pub masters: Vec<Master>,
    /// Every layout referenced by a master, keyed by its part name.
    pub layouts: Vec<Layout>,
    /// Every theme referenced by a master.
    pub themes: Vec<Theme>,
    /// `p:defaultTextStyle`.
    pub default_text_style: Option<ListStyle>,
    /// `p:embeddedFontLst`.
    pub embedded_fonts: Vec<EmbeddedFont>,
    /// Sections from the `p14:sectionLst` extension.
    pub sections: Vec<Section>,
    /// Custom shows (`p:custShowLst`), each a named list of slides.
    pub custom_shows: Vec<CustomShow>,
    /// Every SmartArt drawing (the shapes PowerPoint drew for a diagram,
    /// in the diagram frame's own coordinates), keyed by part name.
    pub diagrams: std::collections::BTreeMap<String, Vec<Shape>>,
    /// Every SmartArt data model, keyed by its drawing's part name: the
    /// text points and which drawing shape shows which (slide W4, the text
    /// pane).
    #[serde(default)]
    pub diagram_models: std::collections::BTreeMap<String, DiagramModel>,
    /// Every chart a slide, layout or master shows, keyed by part name.
    pub charts: std::collections::BTreeMap<String, chart::Chart>,
    /// The table styles the deck defines (`ppt/tableStyles.xml`). A deck
    /// that uses only PowerPoint's built-in styles defines none: it names
    /// them by id, and the resolver knows their definitions.
    pub table_styles: Vec<TableStyle>,
    /// `a:tblStyleLst def`: the style new tables get.
    pub default_table_style: Option<String>,
    /// Things the importer met and did not model, one line each.
    pub diagnostics: Vec<String>,
}

/// A slide master (`p:sldMaster`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Master {
    pub part: String,
    pub theme_part: Option<String>,
    pub background: Option<Background>,
    pub shapes: Vec<Shape>,
    pub color_map: ColorMap,
    pub title_style: Option<ListStyle>,
    pub body_style: Option<ListStyle>,
    pub other_style: Option<ListStyle>,
    /// Part names of the layouts this master owns, in `p:sldLayoutIdLst` order.
    pub layouts: Vec<String>,
}

/// A slide layout (`p:sldLayout`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Layout {
    pub part: String,
    pub name: Option<String>,
    /// `type` (title, obj, twoObj, blank, …); `None` = custom.
    pub layout_type: Option<String>,
    pub master_part: String,
    /// `showMasterSp`, default true.
    pub show_master_shapes: bool,
    pub background: Option<Background>,
    pub shapes: Vec<Shape>,
    /// `p:clrMapOvr` — `None` = use the master's map.
    pub color_map_override: Option<ColorMap>,
}

/// A slide (`p:sld`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Slide {
    pub part: String,
    /// The `id` in `p:sldIdLst`.
    pub slide_id: u32,
    pub layout_part: Option<String>,
    pub name: Option<String>,
    /// `show="0"` hides the slide in a slideshow.
    pub hidden: bool,
    /// `showMasterSp`, default true.
    pub show_master_shapes: bool,
    pub background: Option<Background>,
    pub shapes: Vec<Shape>,
    pub color_map_override: Option<ColorMap>,
    /// The notes slide's body placeholder text.
    pub notes: Option<TextBody>,
    pub transition: Option<Transition>,
    /// `p:timing`, verbatim, for export and for the build-step parser.
    pub timing_xml: Option<String>,
    /// `p:timing` read as a tree (slide ADR 714); `None` when the slide has
    /// none or it did not read (then `timing_xml` still has it).
    #[serde(default)]
    pub timing: Option<anim::Timing>,
    /// The slide's review comments: modern threaded comments and legacy
    /// ones, in the order the deck lists them (slide ADR 711).
    pub comments: Vec<Comment>,
}

/// A review comment on a slide: a modern threaded comment
/// (`p188:cm`, PowerPoint 365) or a legacy one (`p:cm`).
///
/// The JSON form (camelCase) is what the slide bundle keeps per page and
/// hands back to export.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Comment {
    /// `{GUID}` for a modern comment; `legacy-<authorId>-<idx>` for a
    /// legacy one.
    pub id: String,
    /// The author's `{GUID}` (modern) or `legacy-<id>`.
    pub author_id: String,
    pub author: String,
    pub initials: String,
    /// The creation time as the deck wrote it.
    pub created: Option<String>,
    /// Plain text, one line per paragraph.
    pub text: String,
    /// The comment's position on the slide, pt (absent: on the slide as a
    /// whole).
    pub x: Option<f64>,
    pub y: Option<f64>,
    /// The `cNvPr id` of the shape the comment is anchored to.
    pub shape_id: Option<u32>,
    /// `active`, `resolved` or `closed` (absent: active).
    pub status: Option<String>,
    pub replies: Vec<CommentReply>,
    /// Read from a legacy `p:cm` (export writes it as a modern comment).
    pub legacy: bool,
    /// The `p188:cm` element as the deck wrote it, re-emitted verbatim
    /// while the comment is unchanged.
    #[serde(skip)]
    pub raw: Option<String>,
    /// Its marker list (`pc:sldMkLst`, `ac:deMkLst`, `ac:txMkLst`) as
    /// written.
    #[serde(skip)]
    pub marker_xml: Option<String>,
}

/// A reply in a comment's thread (`p188:reply`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CommentReply {
    pub id: String,
    pub author_id: String,
    pub author: String,
    pub initials: String,
    pub created: Option<String>,
    pub text: String,
}

impl Comment {
    /// The same comment as far as the model goes (what the user can see and
    /// change), ignoring the verbatim XML kept beside it.
    pub fn same_as(&self, other: &Comment) -> bool {
        let close = |a: Option<f64>, b: Option<f64>| match (a, b) {
            (Some(a), Some(b)) => (a - b).abs() < 1e-6,
            (None, None) => true,
            _ => false,
        };
        let active = |s: &Option<String>| s.clone().filter(|s| s != "active");
        self.id == other.id
            && self.author_id == other.author_id
            && self.author == other.author
            && self.initials == other.initials
            && self.created == other.created
            && self.text == other.text
            && close(self.x, other.x)
            && close(self.y, other.y)
            && self.shape_id == other.shape_id
            && active(&self.status) == active(&other.status)
            && self.replies == other.replies
            && self.legacy == other.legacy
    }
}

/// Two comment lists that are the same as far as the model goes.
pub fn same_comments(a: &[Comment], b: &[Comment]) -> bool {
    a.len() == b.len() && a.iter().zip(b).all(|(x, y)| x.same_as(y))
}

/// `p:bg`: either explicit properties or a reference into the theme's
/// background fill styles.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Background {
    Fill(Fill),
    /// `p:bgRef idx` + colour (1001+ indexes `bgFillStyleLst`).
    StyleRef {
        idx: u32,
        color: Option<Color>,
    },
}

/// `p:clrMap` / `a:overrideClrMapping`: logical slot → theme slot.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ColorMap {
    /// Pairs such as (`bg1`, `lt1`), (`tx1`, `dk1`), (`accent1`, `accent1`).
    pub entries: Vec<(String, String)>,
}

/// Every effect a `p:transition` can name, by the element's local name: what
/// [`Transition::kind`] holds. ECMA-376 Part 1 (`p:`), MS-PPTX (`p14:`,
/// PowerPoint 2010; `p15:prstTrans`, 2013, whose `prst` attribute names the
/// preset) and `p159:morph` (2019). The slide show's
/// shader manifest (slide ADR 721) covers each one; its tests check that
/// against this list.
pub const TRANSITION_KINDS: &[&str] = &[
    // ECMA-376 (p:)
    "blinds",
    "checker",
    "circle",
    "comb",
    "cover",
    "cut",
    "diamond",
    "dissolve",
    "fade",
    "newsflash",
    "plus",
    "pull",
    "push",
    "random",
    "randomBar",
    "split",
    "strips",
    "wedge",
    "wheel",
    "wipe",
    "zoom",
    // [MS-PPTX] PowerPoint 2010 (p14:)
    "conveyor",
    "doors",
    "ferris",
    "flash",
    "flip",
    "flythrough",
    "gallery",
    "glitter",
    "honeycomb",
    "pan",
    "prism",
    "reveal",
    "ripple",
    "shred",
    "switch",
    "vortex",
    "warp",
    "wheelReverse",
    "window",
    // [MS-PPTX] PowerPoint 2013 (p15:), PowerPoint 2019 (p159:)
    "prstTrans",
    "morph",
];

/// The presets of `p15:prstTrans` (its `prst` attribute; default `fallOver`).
pub const PRESET_TRANSITIONS: &[&str] = &[
    "airplane",
    "crush",
    "curtains",
    "drape",
    "fallOver",
    "fracture",
    "origami",
    "pageCurlDouble",
    "pageCurlSingle",
    "peelOff",
    "prestige",
    "wind",
];

/// A transition (`p:transition`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Transition {
    /// The element, verbatim (including any `mc:AlternateContent` wrapper).
    pub xml: String,
    /// The effect element's local name: `fade`, `push`, `wipe`, `cut`, … (`None` = no effect).
    pub kind: Option<String>,
    /// `dir` of the effect, when it has one.
    pub dir: Option<String>,
    /// `spd` (slow / med / fast).
    pub speed: Option<String>,
    /// `p14:dur` / `dur` in ms.
    pub duration_ms: Option<u32>,
    /// `advClick`, default true.
    pub advance_on_click: bool,
    /// `advTm` in ms.
    pub advance_after_ms: Option<u32>,
}

/// `p14:section`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Section {
    pub name: String,
    /// The section's `{GUID}`.
    pub id: String,
    pub slide_ids: Vec<u32>,
}

/// `p:custShow`: a named subset of the deck's slides, in its own order
/// (Slide Show ▸ Custom Slide Show).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct CustomShow {
    pub name: String,
    /// `id`, unique among the deck's custom shows.
    pub id: u32,
    /// The slide parts it plays, in order (a slide may appear twice).
    pub slides: Vec<String>,
}

/// `p:embeddedFont`: one family and the font parts of its faces.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct EmbeddedFont {
    pub typeface: String,
    pub regular: Option<String>,
    pub bold: Option<String>,
    pub italic: Option<String>,
    pub bold_italic: Option<String>,
}

// ─── shapes ─────────────────────────────────────────────────────────

/// One item of a shape tree.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Shape {
    /// `p:sp`.
    Sp(Sp),
    /// `p:pic`.
    Pic(Pic),
    /// `p:grpSp`.
    Group(Group),
    /// `p:cxnSp`.
    Connector(Sp),
    /// `p:graphicFrame`.
    Frame(GraphicFrame),
    /// Something the importer does not model (`p:contentPart`, OLE, …).
    Unknown { name: String, xfrm: Option<Xfrm> },
}

/// Non-visual properties shared by every shape kind.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct NvProps {
    pub id: u32,
    pub name: String,
    pub descr: Option<String>,
    pub hidden: bool,
    pub placeholder: Option<Placeholder>,
    pub hyperlink: Option<Hyperlink>,
}

/// `p:ph`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Placeholder {
    /// `type`; absent in the file means `obj` (body-like content).
    pub kind: Option<String>,
    pub idx: Option<u32>,
    pub orient: Option<String>,
    pub size: Option<String>,
}

/// `a:xfrm` / `p:xfrm`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Xfrm {
    pub off: (Emu, Emu),
    pub ext: (Emu, Emu),
    /// 60 000ths of a degree, clockwise.
    pub rot: i32,
    pub flip_h: bool,
    pub flip_v: bool,
    /// Group transforms only: the child coordinate space.
    pub ch_off: Option<(Emu, Emu)>,
    pub ch_ext: Option<(Emu, Emu)>,
}

/// A shape, connector or (with geometry) any drawn outline.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Sp {
    pub nv: NvProps,
    pub props: ShapeProps,
    pub style: Option<ShapeStyle>,
    pub text: Option<TextBody>,
    /// `useBgFill`.
    pub use_bg_fill: bool,
    /// `dsp:txXfrm`: a SmartArt shape's text box, which need not be the
    /// shape's own box (same coordinate space as the shape's `xfrm`).
    pub text_xfrm: Option<Xfrm>,
    /// A connector's `a:stCxn`: the shape and site its start is glued to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub st_cxn: Option<CxnRef>,
    /// A connector's `a:endCxn`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_cxn: Option<CxnRef>,
    /// A SmartArt drawing shape's `modelId`: the presentation point of the
    /// diagram's data model it draws.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
}

/// A SmartArt diagram's data model (`dgm:dataModel`), as far as its text
/// goes. There is no layout engine: the drawing PowerPoint laid out is what
/// is drawn, and an edit changes the text of points it already shows.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct DiagramModel {
    /// The data part (`ppt/diagrams/data1.xml`).
    pub data_part: String,
    /// The text points (`node` and `asst`), in the outline's order: a
    /// depth-first walk of the `parOf` connections from the document point.
    pub points: Vec<DiagramPoint>,
    /// Each drawing shape (by `modelId`) and the points whose text it shows,
    /// in order, with the number of paragraphs each gives it.
    pub shapes: std::collections::BTreeMap<String, Vec<(String, u32)>>,
}

/// One text point of a SmartArt data model.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct DiagramPoint {
    /// `modelId`.
    pub id: String,
    /// 0 for a top-level point.
    pub depth: u32,
    /// Its text, one string per paragraph.
    pub paragraphs: Vec<String>,
}

/// `a:stCxn` / `a:endCxn`: a shape on the same slide (its `cNvPr` id) and
/// the index of one of its connection sites.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CxnRef {
    pub id: u32,
    pub idx: u32,
}

/// `p:spPr` / `p:grpSpPr`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ShapeProps {
    pub xfrm: Option<Xfrm>,
    pub geometry: Option<Geometry>,
    pub fill: Option<Fill>,
    pub line: Option<Line>,
    pub effects: Option<Effects>,
}

/// `a:prstGeom` / `a:custGeom`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Geometry {
    Preset {
        name: String,
        /// `a:avLst` guides: (name, formula), e.g. ("adj", "val 16667").
        adjust: Vec<(String, String)>,
    },
    Custom(CustomGeometry),
}

// `a:custGeom` and its parts: the geometry program is the shared
// DrawingML geometry model (`platform/shared/dml-geom`, PM-0014), which also
// evaluates it.
pub use slide_geom::{AdjustHandle, ConnectionSite, CustomGeometry, GeomPath, HandleRef, PathCmd};

/// `p:style`: references into the theme's format scheme.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ShapeStyle {
    pub line_ref: Option<StyleRef>,
    pub fill_ref: Option<StyleRef>,
    pub effect_ref: Option<StyleRef>,
    /// `a:fontRef idx` (major / minor / none) + colour.
    pub font_ref: Option<(String, Option<Color>)>,
}

/// `a:lnRef` / `a:fillRef` / `a:effectRef`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct StyleRef {
    pub idx: u32,
    pub color: Option<Color>,
}

/// `p:pic`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Pic {
    pub nv: NvProps,
    pub props: ShapeProps,
    pub style: Option<ShapeStyle>,
    pub blip: Blip,
}

/// `p:grpSp`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Group {
    pub nv: NvProps,
    pub props: ShapeProps,
    pub children: Vec<Shape>,
}

/// `p:graphicFrame`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GraphicFrame {
    pub nv: NvProps,
    pub xfrm: Option<Xfrm>,
    pub content: FrameContent,
}

/// What a graphic frame holds.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum FrameContent {
    Table(Table),
    /// A chart part (`c:chart r:id`).
    Chart {
        part: Option<String>,
    },
    /// SmartArt: the data part and the `dsp:` drawing fallback part.
    Diagram {
        data_part: Option<String>,
        drawing_part: Option<String>,
    },
    /// Anything else, by its `a:graphicData uri`.
    Other {
        uri: String,
    },
}

/// `a:tbl`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Table {
    pub columns: Vec<Emu>,
    pub rows: Vec<TableRow>,
    /// `a:tableStyleId`.
    pub style_id: Option<String>,
    pub first_row: bool,
    pub first_col: bool,
    pub last_row: bool,
    pub last_col: bool,
    pub band_row: bool,
    pub band_col: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct TableRow {
    pub height: Emu,
    pub cells: Vec<TableCell>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct TableCell {
    pub text: Option<TextBody>,
    pub grid_span: u32,
    pub row_span: u32,
    pub h_merge: bool,
    pub v_merge: bool,
    pub fill: Option<Fill>,
    /// Borders: left, right, top, bottom.
    pub borders: [Option<Line>; 4],
    /// Margins l, r, t, b.
    pub margins: (Option<Emu>, Option<Emu>, Option<Emu>, Option<Emu>),
    pub anchor: Option<String>,
}

/// `a:tblStyle`: a table style's parts, keyed by part name (`wholeTbl`,
/// `band1H`, `band2H`, `band1V`, `band2V`, `firstCol`, `lastCol`,
/// `firstRow`, `lastRow`, `seCell`, `swCell`, `neCell`, `nwCell`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct TableStyle {
    /// `styleId`, a GUID in braces.
    pub id: String,
    pub name: String,
    /// `a:tblBg`: a fill behind the whole table, or a theme fill reference.
    pub background: Option<Fill>,
    pub background_ref: Option<StyleRef>,
    pub parts: std::collections::BTreeMap<String, TableStylePart>,
}

/// One part of a table style: `a:tcTxStyle` and `a:tcStyle`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct TableStylePart {
    pub bold: Option<bool>,
    pub italic: Option<bool>,
    /// Text colour.
    pub color: Option<Color>,
    /// `a:fontRef idx` (`major` / `minor`).
    pub font_ref: Option<String>,
    /// `a:latin typeface`.
    pub font: Option<String>,
    pub fill: Option<Fill>,
    /// `a:fillRef`: a theme fill style.
    pub fill_ref: Option<StyleRef>,
    pub borders: TableBorders,
}

/// `a:tcBdr`: lines a part draws. `left`/`right`/`top`/`bottom` are the
/// part's outer edges; `inside_h`/`inside_v` the edges between its cells.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct TableBorders {
    pub left: Option<Line>,
    pub right: Option<Line>,
    pub top: Option<Line>,
    pub bottom: Option<Line>,
    pub inside_h: Option<Line>,
    pub inside_v: Option<Line>,
}

// ─── paint ──────────────────────────────────────────────────────────

// DrawingML paint is read once for doc, slide and sheet
// (`paged_ooxml::drawingml`, slide ADR 722): the deck IR carries those
// types as authored, in the file's units.
pub use paged_ooxml::drawingml::{
    Blip, BlipEffect, Blur, Color, ColorBase, Effects, Fill, FillOverlay, Glow, Gradient,
    GradientStop, Line, LineEnd, Pattern, PresetShadow, Reflection, RelRect, Shade, Shadow, Tile,
};

// ─── text ───────────────────────────────────────────────────────────

/// `p:txBody` / `a:txBody`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct TextBody {
    pub body: BodyProps,
    pub list_style: Option<ListStyle>,
    pub paragraphs: Vec<Paragraph>,
}

/// `a:bodyPr` — every field optional, because a missing one inherits.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct BodyProps {
    /// l, t, r, b insets.
    pub insets: (Option<Emu>, Option<Emu>, Option<Emu>, Option<Emu>),
    /// t / ctr / b.
    pub anchor: Option<String>,
    pub anchor_center: Option<bool>,
    /// `wrap` square (true) / none (false).
    pub wrap: Option<bool>,
    /// `vert` (horz, vert, vert270, …).
    pub vert: Option<String>,
    /// 60 000ths of a degree.
    pub rot: Option<i32>,
    pub columns: Option<u32>,
    pub column_spacing: Option<Emu>,
    pub autofit: Option<Autofit>,
}

/// `a:noAutofit` / `a:normAutofit` / `a:spAutoFit`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Autofit {
    None,
    /// Shrink text on overflow: the scales PowerPoint last computed, in
    /// 1 000ths of a percent (100 000 = no change).
    Normal {
        font_scale: Option<i32>,
        line_spacing_reduction: Option<i32>,
    },
    /// Resize the shape to fit the text.
    Shape,
}

/// `a:lstStyle`: `a:defPPr` plus `a:lvl1pPr` … `a:lvl9pPr`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ListStyle {
    pub default: Option<ParagraphProps>,
    /// Index 0 is `lvl1pPr`.
    pub levels: [Option<ParagraphProps>; 9],
}

/// `a:pPr` / `a:lvlNpPr` — every field optional, because a missing one inherits.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ParagraphProps {
    /// `lvl`, 0-based (only on `a:pPr`).
    pub level: Option<u8>,
    pub margin_left: Option<Emu>,
    pub indent: Option<Emu>,
    /// l / ctr / r / just / dist.
    pub align: Option<String>,
    pub line_spacing: Option<Spacing>,
    pub space_before: Option<Spacing>,
    pub space_after: Option<Spacing>,
    pub bullet: Option<Bullet>,
    pub bullet_color: Option<BulletColor>,
    pub bullet_size: Option<BulletSize>,
    /// `a:buFont typeface`, or `a:buFontTx` (None inside = follow text).
    pub bullet_font: Option<Option<String>>,
    pub default_run: Option<RunProps>,
    pub tab_stops: Vec<(Emu, String)>,
    pub rtl: Option<bool>,
}

/// `a:spcPct` / `a:spcPts`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub enum Spacing {
    /// 1 000ths of a percent of the line (100 000 = single).
    Percent(i32),
    /// Hundredths of a point.
    Points(i32),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Bullet {
    /// `a:buNone`.
    None,
    /// `a:buChar char`.
    Char(String),
    /// `a:buAutoNum type startAt`.
    AutoNumber {
        scheme: String,
        start_at: Option<i32>,
    },
    /// `a:buBlip`.
    Picture,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum BulletColor {
    /// `a:buClrTx`.
    FollowText,
    Color(Color),
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub enum BulletSize {
    /// `a:buSzTx`.
    FollowText,
    /// `a:buSzPct`, 1 000ths of a percent.
    Percent(i32),
    /// `a:buSzPts`, hundredths of a point.
    Points(i32),
}

/// `a:p`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Paragraph {
    pub props: ParagraphProps,
    pub runs: Vec<Run>,
    /// `a:endParaRPr`.
    pub end_props: Option<RunProps>,
}

/// `a:r` / `a:br` / `a:fld`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Run {
    pub kind: RunKind,
    pub props: RunProps,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum RunKind {
    Text(String),
    /// `a:br`.
    Break,
    /// `a:fld type` with its last computed text (slidenum, datetime, …).
    Field {
        kind: Option<String>,
        text: String,
    },
}

/// `a:rPr` / `a:defRPr` / `a:endParaRPr` — every field optional.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct RunProps {
    /// Hundredths of a point.
    pub size: Option<i32>,
    pub bold: Option<bool>,
    pub italic: Option<bool>,
    /// `u` (sng, dbl, none, …).
    pub underline: Option<String>,
    /// `strike` (sngStrike, dblStrike, noStrike).
    pub strike: Option<String>,
    /// `cap` (all, small, none).
    pub caps: Option<String>,
    /// Tracking in hundredths of a point.
    pub spacing: Option<i32>,
    /// Baseline shift, 1 000ths of a percent.
    pub baseline: Option<i32>,
    /// `a:latin typeface` (may be a theme token such as `+mn-lt`).
    pub latin: Option<String>,
    pub east_asian: Option<String>,
    pub complex: Option<String>,
    pub fill: Option<Fill>,
    pub highlight: Option<Color>,
    pub hyperlink: Option<Hyperlink>,
    pub lang: Option<String>,
}

/// `a:hlinkClick`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Hyperlink {
    /// The external target (URL) from the relationship.
    pub url: Option<String>,
    /// The internal target part (a slide) from the relationship.
    pub target_part: Option<String>,
    /// `action` (e.g. `ppaction://hlinksldjump`, `ppaction://hlinkshowjump?jump=nextslide`).
    pub action: Option<String>,
    pub tooltip: Option<String>,
}

// ─── theme ──────────────────────────────────────────────────────────

/// `a:theme`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Theme {
    pub part: String,
    pub name: Option<String>,
    /// The twelve slots: dk1, lt1, dk2, lt2, accent1–6, hlink, folHlink.
    pub colors: Vec<(String, Color)>,
    pub major_font: FontSet,
    pub minor_font: FontSet,
    /// `a:fillStyleLst` (idx 1–3).
    pub fill_styles: Vec<Fill>,
    /// `a:lnStyleLst` (idx 1–3).
    pub line_styles: Vec<Line>,
    /// `a:effectStyleLst` (idx 1–3).
    pub effect_styles: Vec<Option<Effects>>,
    /// `a:bgFillStyleLst` (idx 1001–1003).
    pub background_fill_styles: Vec<Fill>,
}

/// `a:majorFont` / `a:minorFont`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct FontSet {
    pub latin: Option<String>,
    pub east_asian: Option<String>,
    pub complex: Option<String>,
}

impl Presentation {
    /// The layout with this part name.
    pub fn layout(&self, part: &str) -> Option<&Layout> {
        self.layouts.iter().find(|l| l.part == part)
    }
    /// The master with this part name.
    pub fn master(&self, part: &str) -> Option<&Master> {
        self.masters.iter().find(|m| m.part == part)
    }
    /// The theme with this part name.
    pub fn theme(&self, part: &str) -> Option<&Theme> {
        self.themes.iter().find(|t| t.part == part)
    }
}
