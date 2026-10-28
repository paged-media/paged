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

//! The resolved deck: everything PowerPoint would draw, in page points, with
//! no inheritance left — the input of the IDML writer.

use serde::{Deserialize, Serialize};
use slide_geom::SubPath;

/// sRGB bytes.
pub type Rgb = [u8; 3];

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Deck {
    pub width: f64,
    pub height: f64,
    /// Named theme colours (`accent1` …) of the first master's theme, in
    /// scheme order — written as a colour group.
    pub theme_colors: Vec<(String, Rgb)>,
    /// One per used layout: the slide master's and the layout's own art.
    pub masters: Vec<MasterPage>,
    pub slides: Vec<SlidePage>,
    /// Paragraph styles the text uses (`Title`, `Body L1` …), per master.
    pub paragraph_styles: Vec<ParagraphStyle>,
    /// Font families the text names, for the host to register.
    pub fonts: Vec<String>,
    pub diagnostics: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MasterPage {
    /// Stable id derived from the layout part (`m1` …).
    pub id: String,
    /// The layout's name (`Title Slide`, …).
    pub name: String,
    pub layout_part: String,
    pub master_part: String,
    pub items: Vec<Item>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SlidePage {
    pub id: String,
    pub index: usize,
    pub part: String,
    pub master: Option<String>,
    pub show_master_items: bool,
    pub items: Vec<Item>,
    pub hidden: bool,
    pub notes: Option<String>,
    pub transition: Option<pptx_core::Transition>,
    pub timing_xml: Option<String>,
}

/// A page item, positioned by `transform` (its local box `(0,0)`–`(w,h)` →
/// page points).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Item {
    pub id: String,
    pub name: String,
    /// `[a, b, c, d, tx, ty]`.
    pub transform: [f64; 6],
    pub w: f64,
    pub h: f64,
    pub kind: ItemKind,
    /// 0–1; 1 is opaque.
    pub opacity: f64,
    /// The item's DrawingML effects (shadows, glow, soft edge, …).
    #[serde(default)]
    pub effects: Effects,
    /// What export and editing need to know about where it came from.
    pub meta: ItemMeta,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ItemKind {
    /// An outlined shape, optionally carrying text.
    Shape {
        outline: Vec<SubPath>,
        fill: Paint,
        stroke: Option<Stroke>,
        text: Option<TextFrame>,
    },
    /// A picture in a frame.
    Picture {
        outline: Vec<SubPath>,
        stroke: Option<Stroke>,
        image_part: String,
        /// Crop in fractions of the image: l, t, r, b.
        crop: (f64, f64, f64, f64),
        /// The blip's picture effects (`a:duotone`, `a:lum`, …).
        #[serde(default)]
        image_effects: Vec<ImageEffect>,
    },
    Group {
        children: Vec<Item>,
    },
    /// A table: column widths and rows of cells (pt).
    Table(Table),
}

// The resolved paint is the shared neutral IR (`paged_ooxml::drawingml::
// resolved`, slide ADR 722): what doc lowers from too, and what the shared
// mapper (`dml-native`) turns into the engine's model.
pub use paged_ooxml::drawingml::resolved::{
    radial_reach, Effects, ImageEffect, Paint, PatternPaint, Shadow, Stop, Stroke,
};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ItemMeta {
    pub shape_id: u32,
    /// 1-based position in its shape tree (the order PowerPoint numbers
    /// shapes in, and paints them).
    pub order: usize,
    pub placeholder: Option<(String, Option<u32>)>,
    pub preset: Option<(String, Vec<(String, String)>)>,
    /// What a graphic frame drawn as a group holds (`chart`, `diagram`):
    /// its members are a drawing of it, not shapes of the slide.
    #[serde(default)]
    pub frame: Option<String>,
    /// The chart part a chart frame draws (ADR 715: its live workbook is
    /// found by it).
    #[serde(default)]
    pub chart: Option<String>,
    /// The shape's click action (`a:hlinkClick` on `p:cNvPr`).
    #[serde(default)]
    pub link: Option<pptx_core::Hyperlink>,
    /// The `a:xfrm` flips (`flipH`, `flipV`) a live preset keeps.
    #[serde(default)]
    pub flip: (bool, bool),
    /// A connector's glued ends (slide ADR 717).
    #[serde(default)]
    pub connector: Option<Connector>,
}

/// A connector's glued ends.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Connector {
    pub st: Option<CxnEnd>,
    pub end: Option<CxnEnd>,
}

/// One glued end: the shape (`cNvPr` id on the same slide), the index of
/// its connection site, and where that site is on the page at import
/// (`None` when the shape is not one whose sites the editor follows: a
/// group, or a shape not drawn).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CxnEnd {
    pub id: u32,
    pub idx: u32,
    pub at: Option<(f64, f64)>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TextFrame {
    /// The frame within the item's box: l, t, r, b insets already applied.
    pub inset: (f64, f64, f64, f64),
    /// The text rectangle from the geometry (l, t, r, b in the item's box).
    pub rect: (f64, f64, f64, f64),
    /// top / middle / bottom.
    pub anchor: String,
    pub wrap: bool,
    pub columns: u32,
    pub column_gap: f64,
    /// Grow the frame to its text (`spAutoFit`).
    pub grow: bool,
    /// The shrink PowerPoint computed (`normAutofit`): font and line scale.
    pub shrink: Option<(f64, f64)>,
    /// 0 / 90 / 270: `vert` text rotation.
    pub rotation: f64,
    pub paragraphs: Vec<Para>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Para {
    /// The paragraph style the level maps to (`Body L2`, …), if any.
    pub style: Option<String>,
    pub level: u8,
    pub align: String,
    pub margin_left: f64,
    pub indent: f64,
    /// Leading in pt, or `None` for the engine's auto (when 100 %).
    pub leading: Option<f64>,
    /// Multiple of the font's own line height, when the deck gave a %.
    pub line_percent: Option<f64>,
    pub space_before: f64,
    pub space_after: f64,
    pub bullet: Option<Bullet>,
    pub runs: Vec<TextRun>,
    /// Size of an empty paragraph's line (from `endParaRPr`).
    pub empty_size: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum Bullet {
    Char {
        ch: String,
        font: Option<String>,
        rgb: Option<Rgb>,
        size_percent: f64,
    },
    Number {
        scheme: String,
        start: i32,
        rgb: Option<Rgb>,
        size_percent: f64,
    },
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TextRun {
    pub text: String,
    /// A line break (`a:br`) rather than text.
    pub line_break: bool,
    pub size: f64,
    pub font: String,
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    pub strike: bool,
    pub caps: Option<String>,
    pub tracking: f64,
    pub baseline: f64,
    pub rgb: Rgb,
    pub alpha: f64,
    /// The run's `a:hlinkClick`: a URL, a slide or a show action.
    pub link: Option<pptx_core::Hyperlink>,
    /// `a:fld type` (`slidenum`, `datetime1`, …); `text` holds the value
    /// PowerPoint last computed.
    pub field: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Table {
    pub columns: Vec<f64>,
    pub rows: Vec<(f64, Vec<Cell>)>,
    /// The table style's background (`a:tblBg`), behind every cell.
    pub background: Paint,
    /// The native table style the table's look maps to, when it has one.
    pub look: Option<TableLook>,
}

impl Table {
    /// The background's colour at (x, y) pt in the table (a linear
    /// gradient runs across the table's box projected on its direction, as
    /// PowerPoint spans it).
    pub fn backdrop_at(&self, x: f64, y: f64) -> Option<Rgb> {
        let w: f64 = self.columns.iter().sum();
        let h: f64 = self.rows.iter().map(|r| r.0).sum();
        let t = match &self.background {
            Paint::Linear { angle, .. } => {
                let (sn, cs) = angle.to_radians().sin_cos();
                let span = w * cs.abs() + h * sn.abs();
                if span <= 0.0 {
                    0.5
                } else {
                    ((x - w / 2.0) * cs + (y - h / 2.0) * sn) / span + 0.5
                }
            }
            Paint::Radial { center, .. } => {
                let (cx, cy) = (center.0 * w, center.1 * h);
                let (dx, dy) = (x - cx, y - cy);
                (dx * dx + dy * dy).sqrt() / radial_reach(*center, w, h).max(1e-9)
            }
            _ => 0.0,
        };
        self.background.color_at(t).map(|(c, _)| c)
    }
}

/// A table style as the engine's own table model holds it: region fills
/// (header and footer rows, first and last column, body) and alternating
/// row or column fills. Cells this cannot express carry their own fill.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableLook {
    pub name: String,
    pub header_rows: u32,
    pub footer_rows: u32,
    pub header: Paint,
    pub footer: Paint,
    pub left: Paint,
    pub right: Paint,
    pub body: Paint,
    pub alternate: Option<Alternate>,
}

/// Alternating fills: by rows (body rows) or by columns.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Alternate {
    pub rows: bool,
    pub start: Paint,
    pub end: Paint,
    pub skip_first: u32,
    pub skip_last: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Cell {
    /// (rows, columns).
    pub span: (u32, u32),
    /// A continuation of a merged cell: drawn by the cell it merges into.
    pub merged: bool,
    pub fill: Paint,
    /// The table's native style already paints `fill` here.
    pub fill_from_style: bool,
    /// left, right, top, bottom; `None` draws no line.
    pub borders: [Option<Stroke>; 4],
    pub text: Option<TextFrame>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParagraphStyle {
    pub name: String,
}
