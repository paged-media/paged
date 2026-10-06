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

pub mod chart;

use serde::{Deserialize, Serialize};

/// English Metric Units: 914 400 per inch, 12 700 per point.
pub type Emu = i64;

/// EMU per point.
pub const EMU_PER_PT: f64 = 12_700.0;

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
    /// Every SmartArt drawing (the shapes PowerPoint drew for a diagram,
    /// in the diagram frame's own coordinates), keyed by part name.
    pub diagrams: std::collections::BTreeMap<String, Vec<Shape>>,
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
    pub slide_ids: Vec<u32>,
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

/// `a:custGeom`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct CustomGeometry {
    pub adjust: Vec<(String, String)>,
    pub guides: Vec<(String, String)>,
    pub paths: Vec<GeomPath>,
}

/// One `a:path` of a custom geometry, in its own coordinate space.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct GeomPath {
    pub w: Option<Emu>,
    pub h: Option<Emu>,
    /// `fill` (norm / none / lighten / …), `None` = norm.
    pub fill: Option<String>,
    pub stroke: bool,
    pub commands: Vec<PathCmd>,
}

/// One path command; points are guide names or literal numbers, as authored.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum PathCmd {
    MoveTo(String, String),
    LineTo(String, String),
    /// `arcTo wR hR stAng swAng`.
    ArcTo(String, String, String, String),
    QuadTo([(String, String); 2]),
    CubicTo([(String, String); 3]),
    Close,
}

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

/// `a:blipFill`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Blip {
    /// The image part (resolved from the `r:embed` relationship).
    pub part: Option<String>,
    /// An `r:link` to an external image.
    pub link: Option<String>,
    /// `a:srcRect` l, t, r, b in 1 000ths of a percent.
    pub src_rect: Option<RelRect>,
    /// `a:stretch` (true) or `a:tile` (false).
    pub stretch: bool,
    /// `a:alphaModFix amt`, 1 000ths of a percent.
    pub alpha: Option<i32>,
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

/// A colour as authored: a base and its transform chain.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Color {
    pub base: ColorBase,
    /// In document order: (`lumMod`, 75000), (`alpha`, 50000), …
    pub transforms: Vec<(String, i32)>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum ColorBase {
    /// `a:srgbClr val` as 0xRRGGBB.
    Srgb(u32),
    /// `a:schemeClr val` (bg1, tx1, accent1, phClr, …).
    Scheme(String),
    /// `a:sysClr val` + `lastClr`.
    System { name: String, last: Option<u32> },
    /// `a:prstClr val`.
    Preset(String),
    /// `a:hslClr`: hue in 60 000ths of a degree, sat/lum in 1 000ths of a percent.
    Hsl(i32, i32, i32),
    /// `a:scrgbClr`: linear r/g/b in 1 000ths of a percent.
    ScRgb(i32, i32, i32),
}

/// A fill.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Fill {
    None,
    Solid(Color),
    Gradient(Gradient),
    Blip(Blip),
    Pattern {
        preset: String,
        fg: Option<Color>,
        bg: Option<Color>,
    },
    /// `a:grpFill` — use the group's fill.
    Group,
}

/// `l t r b` in 1 000ths of a percent (`a:srcRect`, `a:fillToRect`).
pub type RelRect = (i32, i32, i32, i32);

/// `a:gradFill`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Gradient {
    /// (position in 1 000ths of a percent, colour).
    pub stops: Vec<(i32, Color)>,
    /// `a:lin ang` (60 000ths of a degree) + `scaled`.
    pub linear: Option<(i32, bool)>,
    /// `a:path path` (circle / rect / shape) + `a:fillToRect` l, t, r, b.
    pub path: Option<(String, Option<RelRect>)>,
    pub rotate_with_shape: bool,
}

/// `a:ln`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Line {
    pub width: Option<Emu>,
    pub fill: Option<Fill>,
    /// `a:prstDash val`.
    pub dash: Option<String>,
    /// `a:custDash` (dash, space) pairs in 1 000ths of a percent of the width.
    pub custom_dash: Vec<(i32, i32)>,
    /// `cap` (rnd / sq / flat).
    pub cap: Option<String>,
    /// round / bevel / miter.
    pub join: Option<String>,
    /// `cmpd` (sng / dbl / …).
    pub compound: Option<String>,
    pub head: Option<LineEnd>,
    pub tail: Option<LineEnd>,
}

/// `a:headEnd` / `a:tailEnd`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct LineEnd {
    pub kind: String,
    pub w: Option<String>,
    pub len: Option<String>,
}

/// `a:effectLst` — the effects the engine can carry; the rest go to diagnostics.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Effects {
    pub outer_shadow: Option<Shadow>,
    pub inner_shadow: Option<Shadow>,
    /// `a:glow rad` + colour.
    pub glow: Option<(Emu, Color)>,
    /// `a:softEdge rad`.
    pub soft_edge: Option<Emu>,
}

/// `a:outerShdw` / `a:innerShdw`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Shadow {
    pub blur: Emu,
    pub dist: Emu,
    /// 60 000ths of a degree.
    pub dir: i32,
    pub color: Color,
}

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
