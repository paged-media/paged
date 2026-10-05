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
    pub shadow: Option<Shadow>,
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
    },
    Group {
        children: Vec<Item>,
    },
    /// A table: column widths and rows of cells (pt).
    Table(Table),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum Paint {
    None,
    Solid {
        rgb: Rgb,
        alpha: f64,
        theme: Option<String>,
    },
    Linear {
        stops: Vec<(f64, Rgb)>,
        angle: f64,
    },
    Radial {
        stops: Vec<(f64, Rgb)>,
    },
    Image {
        part: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Stroke {
    pub width: f64,
    pub paint: Paint,
    pub dash: Option<String>,
    pub cap: Option<String>,
    pub join: Option<String>,
    pub head: Option<String>,
    pub tail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Shadow {
    pub dx: f64,
    pub dy: f64,
    pub blur: f64,
    pub rgb: Rgb,
    pub alpha: f64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ItemMeta {
    pub shape_id: u32,
    /// 1-based position in its shape tree (the order PowerPoint numbers
    /// shapes in, and paints them).
    pub order: usize,
    pub placeholder: Option<(String, Option<u32>)>,
    pub preset: Option<(String, Vec<(String, String)>)>,
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
    pub link: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Table {
    pub columns: Vec<f64>,
    pub rows: Vec<(f64, Vec<Cell>)>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Cell {
    pub span: (u32, u32),
    pub merged: bool,
    pub fill: Paint,
    pub text: Option<TextFrame>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParagraphStyle {
    pub name: String,
}
