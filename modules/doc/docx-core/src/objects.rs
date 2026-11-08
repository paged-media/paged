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

//! Wave W4a's model (doc ADR 614): languages, text boxes, nested tables and
//! table borders, shading, widths and row rules, as Word writes them. Lengths
//! in twips (tables) or EMU (drawings), unconverted.

use serde::{Deserialize, Serialize};

use crate::{Float, Paragraph, PictureLook, Shading, Table};

/// `w:lang`'s three slots, each `None` where the element leaves it out.
/// The Latin one is lowered to the engine's applied language (which picks
/// the hyphenation patterns); the other two are read for later waves.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Language {
    /// `@w:val`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latin: Option<String>,
    /// `@w:eastAsia`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub east_asia: Option<String>,
    /// `@w:bidi`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bidi: Option<String>,
}

impl Language {
    pub fn is_empty(&self) -> bool {
        self.latin.is_none() && self.east_asia.is_none() && self.bidi.is_none()
    }

    /// `over` laid over `self`: each slot `over` states wins.
    pub fn merged(&self, over: &Language) -> Language {
        Language {
            latin: over.latin.clone().or_else(|| self.latin.clone()),
            east_asia: over.east_asia.clone().or_else(|| self.east_asia.clone()),
            bidi: over.bidi.clone().or_else(|| self.bidi.clone()),
        }
    }
}

/// A text box: a DrawingML shape's `wps:txbx` or a legacy VML `v:textbox`,
/// each holding a `w:txbxContent`. Where Word writes both (an
/// `mc:AlternateContent` whose fallback repeats the box in VML), the import
/// reads the choice it understands, once.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TextBox {
    /// The box's paragraphs (tables inside it are flattened into their
    /// cells' paragraphs and marked held).
    pub paragraphs: Vec<Paragraph>,
    /// The shape's extent (`wp:extent`, or the VML CSS `width` / `height`).
    pub width_emu: i64,
    pub height_emu: i64,
    /// Where the box floats; `None` for a box set inline (`wp:inline`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub float: Option<Float>,
    /// The box's internal margins (`wps:bodyPr` `lIns` / `tIns` / `rIns` /
    /// `bIns`, or `v:textbox/@inset`), top, left, bottom, right, in EMU.
    /// Word's defaults are 91440 left and right, 45720 top and bottom.
    pub insets_emu: [i64; 4],
    /// The shape's DrawingML look (`wps:spPr`: fill, outline, effects), as
    /// a picture's is read (doc ADR 618); `None` for a plain box and for
    /// a VML one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub look: Option<Box<PictureLook>>,
    /// The box's number among the `w:txbxContent`s of its part, in document
    /// order, counting only those the import reads (an `mc:Fallback`'s copy
    /// is not counted): what save-back addresses the box by.
    pub ordinal: u32,
    /// Its content is VML (`v:textbox`), not DrawingML (`wps:txbx`).
    #[serde(default)]
    pub vml: bool,
    /// Content the box holds that the lowering does not show as text (a
    /// table, a content control): its paragraphs are held, and an edit of
    /// the box is refused.
    #[serde(default)]
    pub held: bool,
}

/// A DrawingML shape that holds no text (`wps:wsp` without `wps:txbx`: a
/// rectangle, an ellipse, a line, a freeform), doc ADR 627. A shape with text
/// is a [`TextBox`] and is drawn as its box.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Shape {
    /// The shape's extent (`wp:extent`), before any rotation.
    pub width_emu: i64,
    pub height_emu: i64,
    /// Where the shape floats; `None` for a shape set inline (`wp:inline`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub float: Option<Float>,
    /// `a:prstGeom` or `a:custGeom`.
    pub geometry: ShapeGeometry,
    /// `a:xfrm/@rot`, in 60 000ths of a degree, clockwise.
    #[serde(default, skip_serializing_if = "is_zero_i32")]
    pub rotation: i32,
    /// `a:xfrm/@flipH` and `@flipV`.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub flip_h: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub flip_v: bool,
    /// The shape's look (`wps:spPr` fill, outline and effects, completed
    /// from the `wps:style` references it leaves to the theme); `None` for a
    /// shape that paints nothing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub look: Option<Box<PictureLook>>,
    /// `a:ln` has a `headEnd` or `tailEnd` (arrow heads): not drawn.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub line_ends: bool,
}

fn is_zero_i32(n: &i32) -> bool {
    *n == 0
}

/// A shape's outline as DrawingML writes it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum ShapeGeometry {
    /// `a:prstGeom`: the preset's name (`rect`, `ellipse`, `triangle`, …)
    /// and its `a:avLst` guides (`adj`, `adj1`, … with their `val NNN`).
    Preset {
        name: String,
        adjust: Vec<(String, i64)>,
    },
    /// `a:custGeom`'s paths whose points are literal numbers; a path with a
    /// guide reference or an arc is not carried ([`ShapeGeometry::Unsupported`]).
    Custom(Vec<CustomPath>),
    /// A custom geometry this reader does not take (a guide formula, an
    /// `a:arcTo`): the shape is not drawn, and the lowering says so.
    Unsupported,
}

impl Default for ShapeGeometry {
    fn default() -> Self {
        ShapeGeometry::Preset {
            name: "rect".into(),
            adjust: Vec::new(),
        }
    }
}

/// One `a:path` of a custom geometry, in its own `w` x `h` coordinate space.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct CustomPath {
    pub w: i64,
    pub h: i64,
    /// `fill="none"`: only stroked.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub no_fill: bool,
    /// `stroke="0"`: only filled.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub no_stroke: bool,
    pub commands: Vec<PathCommand>,
}

/// One command of a [`CustomPath`].
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub enum PathCommand {
    Move(i64, i64),
    Line(i64, i64),
    /// `a:quadBezTo`: control point, end point.
    Quad([i64; 4]),
    /// `a:cubicBezTo`: two control points, end point.
    Cubic([i64; 6]),
    Close,
}

/// A chart drawn by a `w:drawing` (`a:graphicData` of the chart namespace,
/// `c:chart r:id`), doc ADR 628: the chart part read by the shared DrawingML
/// chart reader with the cached values Word draws from. The part itself is
/// carried by the package and saved as it was.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ChartDrawing {
    /// The drawing's extent (`wp:extent`).
    pub width_emu: i64,
    pub height_emu: i64,
    /// Where the chart floats; `None` for a chart set inline.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub float: Option<Float>,
    /// The chart part's name (`word/charts/chart1.xml`).
    pub part: String,
    /// The chart as read (`c:chartSpace`), with the paints and text
    /// properties as authored.
    pub chart: Box<pptx_core::chart::Chart>,
}

/// A SmartArt diagram drawn by a `w:drawing` (`a:graphicData` of the
/// diagram namespace), doc ADR 629: the shapes of the drawing Word saves
/// beside the diagram's data (`word/diagrams/drawingN.xml`, `dsp:drawing`),
/// which is how Word itself last laid the diagram out. The diagram's parts
/// are carried by the package and saved as they were.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct DiagramDrawing {
    /// The drawing's extent (`wp:extent`).
    pub width_emu: i64,
    pub height_emu: i64,
    /// Where the diagram floats; `None` for a diagram set inline.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub float: Option<Float>,
    /// The drawing part's name (`word/diagrams/drawing1.xml`).
    pub part: String,
    /// The shapes, in z-order, placed in the diagram's box.
    pub shapes: Vec<DiagramShape>,
}

/// One shape of a [`DiagramDrawing`].
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct DiagramShape {
    /// The shape's top left in the diagram's box (groups' transforms
    /// applied), EMU.
    pub x_emu: i64,
    pub y_emu: i64,
    /// Its extent, outline, rotation, flips and look (`float` unused).
    pub shape: Shape,
    /// Its text, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<DiagramText>,
}

/// A diagram shape's text (`dsp:txBody`) and the box Word sets it in
/// (`dsp:txXfrm`, or the shape's box).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct DiagramText {
    pub x_emu: i64,
    pub y_emu: i64,
    pub width_emu: i64,
    pub height_emu: i64,
    /// `a:bodyPr` insets: left, top, right, bottom, EMU.
    pub insets_emu: [i64; 4],
    /// `a:bodyPr/@anchor`: `t`, `ctr` or `b`.
    pub anchor: String,
    pub paragraphs: Vec<DiagramParagraph>,
}

/// One `a:p` of a diagram shape's text.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct DiagramParagraph {
    /// `a:pPr/@algn` (`l`, `ctr`, `r`, `just`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub align: Option<String>,
    /// `a:lnSpc/a:spcPct`, 1 000ths of a percent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line_pct: Option<i32>,
    pub runs: Vec<DiagramRun>,
}

/// One run (`a:r`, `a:fld`) of a [`DiagramParagraph`].
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct DiagramRun {
    pub text: String,
    /// `sz`, hundredths of a point.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bold: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub italic: Option<bool>,
    /// The run's fill, or the shape style's font colour (`a:fontRef`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fill: Option<paged_ooxml::drawingml::Fill>,
    /// `a:latin/@typeface` (may be `+mn-lt`, `+mj-lt`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latin: Option<String>,
}

/// One border edge (`w:top`, `w:insideH`, … in `w:tblBorders` /
/// `w:tcBorders`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct BorderEdge {
    /// `@w:val`: `single`, `double`, `dashed`, … ; `nil` / `none` is no line.
    pub style: String,
    /// `@w:sz`, eighths of a point.
    pub size_eighths: u32,
    /// `@w:color` as `RRGGBB`; `None` for `auto` (black on white).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

impl BorderEdge {
    /// Whether the edge draws a line.
    pub fn visible(&self) -> bool {
        !matches!(self.style.as_str(), "nil" | "none" | "") && self.size_eighths > 0
    }
}

/// A table's or a cell's borders, each side as declared (`None` = not
/// declared here, inherited from the next level).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Borders {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub top: Option<BorderEdge>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub left: Option<BorderEdge>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bottom: Option<BorderEdge>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub right: Option<BorderEdge>,
    /// The edges between rows and between columns (table level only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inside_h: Option<BorderEdge>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inside_v: Option<BorderEdge>,
}

impl Borders {
    pub fn is_empty(&self) -> bool {
        *self == Borders::default()
    }

    /// `over` laid over `self`, side by side.
    pub fn merged(&self, over: &Borders) -> Borders {
        let pick = |a: &Option<BorderEdge>, b: &Option<BorderEdge>| b.clone().or_else(|| a.clone());
        Borders {
            top: pick(&self.top, &over.top),
            left: pick(&self.left, &over.left),
            bottom: pick(&self.bottom, &over.bottom),
            right: pick(&self.right, &over.right),
            inside_h: pick(&self.inside_h, &over.inside_h),
            inside_v: pick(&self.inside_v, &over.inside_v),
        }
    }
}

/// A preferred width (`w:tblW` / `w:tcW`) as written.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PreferredWidth {
    /// `@w:type`: `dxa` (twips), `pct` (fiftieths of a percent, or `"50%"`
    /// read as 2500), `auto`, `nil`.
    pub kind: WidthKind,
    /// `@w:w` in the unit `kind` names.
    pub value: i32,
}

/// The unit of a [`PreferredWidth`].
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum WidthKind {
    #[default]
    Auto,
    Dxa,
    Pct,
    Nil,
}

/// `w:trHeight/@w:hRule`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum HeightRule {
    /// `atLeast` (Word's default when `w:val` is given).
    #[default]
    AtLeast,
    /// `exact`: the row is held at its height, whatever its cells hold.
    Exact,
    /// `auto`: the height is ignored, the row is as tall as its content.
    Auto,
}

/// What a table carries beyond its grid and rows (doc ADR 614): its look
/// and its widths, as Word writes them in `w:tblPr` (and, for the style's
/// share, in the table style's `w:tblPr` / `w:tcPr`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct TableLook {
    /// `w:tblStyle/@w:val`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub style_id: Option<String>,
    /// `w:tblBorders`.
    #[serde(default, skip_serializing_if = "Borders::is_empty")]
    pub borders: Borders,
    /// `w:tblPr/w:shd`: every cell's fill unless the cell has its own.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shading: Option<Shading>,
    /// `w:tblInd/@w:w` in twips (`dxa`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub indent: Option<i32>,
    /// `w:jc/@w:val`: `left`/`start`, `center`, `right`/`end`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub justification: Option<String>,
    /// `w:tblLayout w:type="fixed"`: Word keeps the grid's widths instead of
    /// fitting the columns to their content.
    #[serde(default)]
    pub fixed_layout: bool,
    /// `w:tblW`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<PreferredWidth>,
}

/// What a cell carries beyond its paragraphs, spans and margins.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct CellLook {
    /// `w:tcBorders`.
    #[serde(default, skip_serializing_if = "Borders::is_empty")]
    pub borders: Borders,
    /// `w:tcPr/w:shd`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shading: Option<Shading>,
    /// `w:tcW`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<PreferredWidth>,
}

/// The table properties a table style holds (`w:style[@w:type="table"]`
/// `w:tblPr` and its whole-table `w:tcPr`); conditional regions
/// (`w:tblStylePr`, first row and the like) are not read.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct TableStyleProps {
    #[serde(default, skip_serializing_if = "Borders::is_empty")]
    pub borders: Borders,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shading: Option<Shading>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub indent: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub justification: Option<String>,
    /// The style declares conditional formatting (`w:tblStylePr`), which is
    /// not applied.
    #[serde(default)]
    pub conditional: bool,
}

/// A table set inside a table cell (engine ADR 176 holds nested tables;
/// no mutation can create one inside a cell yet). The cell's
/// [`crate::TableCell::paragraphs`] show its content flattened and held,
/// at `first_para .. first_para + para_count`; the structure is kept here
/// for the native lowering.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct NestedTable {
    pub first_para: u32,
    pub para_count: u32,
    pub table: Table,
}
