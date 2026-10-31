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

//! The Lowered IR of wave W4a (doc ADR 614): floating objects as the
//! engine's anchored objects or as page items, and the table look. Part of
//! [`crate::ir`] (re-exported there).

use serde::{Deserialize, Serialize};

use crate::ir::LoweredParagraph;

/// A floating drawing as an anchored object of its paragraph: the engine's
/// `AnchoredObjectSetting`, set with `setElementProperty` on the anchored
/// frame `insertAnchoredFrame` made. Values are the engine's vocabulary.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoweredAnchor {
    /// `anchoredPosition`: `Anchored` (custom, against a reference) or
    /// `AbovePosition` (a band of its own above the anchor line).
    pub position: String,
    /// `anchorPoint`: the frame's corner the reference point takes
    /// (`TopLeftAnchor`, `CenterAnchor`, …).
    pub anchor_point: String,
    /// `anchoredHorizontalReference`: `PageEdge`, `PageMargins`,
    /// `TextFrame`, `ColumnEdge`, `AnchorLocation`.
    pub horizontal_reference: String,
    /// `anchoredHorizontalAlignment`: `LeftAlign`, `CenterAlign`,
    /// `RightAlign` (an above-line object's alignment in its column).
    pub horizontal_alignment: String,
    /// `anchoredVerticalReference`: `PageEdge`, `PageMargins`,
    /// `TextFrame`, `TopOfLeading`.
    pub vertical_reference: String,
    /// `anchoredVerticalAlignment`: `TopAlign`, `CenterAlign`,
    /// `BottomAlign`.
    pub vertical_alignment: String,
    /// `anchoredXOffset` / `anchoredYOffset`, pt (an above-line object's
    /// y offset is the space after it).
    pub x_offset_pt: f32,
    pub y_offset_pt: f32,
}

/// How text wraps around a page item: the engine's `TextWrap`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoweredWrap {
    /// `frameTextWrapMode`: `BoundingBoxTextWrap` (Word's square),
    /// `JumpObjectTextWrap` (top and bottom), `ContourTextWrap` (tight,
    /// through).
    pub mode: String,
    /// `frameTextWrapOffsets`: top, left, bottom, right, pt (Word's
    /// distance from the text).
    pub offsets_pt: [f32; 4],
    /// `TextWrapSide`: `BothSides`, `LeftSide`, `RightSide`,
    /// `LargestArea` (Word's `wrapText`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub side: Option<String>,
    /// `frameTextWrapContourType` of a contour wrap.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contour: Option<String>,
    /// Word's `wp:wrapPolygon`, in the item's own points (top-left origin):
    /// carried for an engine that takes a custom contour.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub polygon_pt: Vec<(f32, f32)>,
}

/// Where a page item stands.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum LoweredItemHost {
    /// On a story's authored page (the skeleton's `docx_p{k}`).
    Page { page_id: String },
    /// On a master (header and footer objects): every page showing it.
    Master { master_id: String },
}

/// What a page item is.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum LoweredItemKind {
    /// A picture: a graphic frame the image is placed in (`placeImage`).
    Picture { uri: String },
    /// A text box: a text frame with a story of its own the pour fills.
    TextBox {
        story_id: String,
        paragraphs: Vec<LoweredParagraph>,
        /// The box's internal margins, top, left, bottom, right, pt.
        insets_pt: [f32; 4],
    },
}

/// A floating picture or a text box placed as a page item (doc ADR 614):
/// where the lowering knows its page — anchored in the first paragraph of
/// a story, whose page is the story's authored one, or in a header or
/// footer, which stands on the masters. The standalone skeleton writes the
/// frame (its picture, look and wrap, and a text box's empty story); the
/// bundle pours a text box's text.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoweredPageItem {
    /// The frame's id (`docx_o3`).
    pub id: String,
    pub host: LoweredItemHost,
    /// `[top, left, bottom, right]` in page points.
    pub bounds: [f32; 4],
    pub item: LoweredItemKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wrap: Option<LoweredWrap>,
    /// Word's `behindDoc`: drawn behind the text.
    #[serde(default)]
    pub behind: bool,
    /// The shape's or picture's look (fill, outline, effects).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fx: Option<dml_native::native::NativeFx>,
    /// Where it comes from in the Word file.
    pub source: LoweredItemSource,
}

/// A page item's origin, what save-back addresses a text box by.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoweredItemSource {
    /// The part: `word/document.xml`, `word/header1.xml`, ….
    pub part: String,
    /// The `w:txbxContent` ordinal in the part (text boxes).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ordinal: Option<u32>,
    /// The box is VML (`v:textbox`).
    #[serde(default)]
    pub vml: bool,
    /// The box's text can be saved back (it holds nothing the canvas does
    /// not show).
    #[serde(default)]
    pub editable: bool,
}

/// One cell edge as the engine strokes it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoweredEdge {
    /// Points; 0 for no line.
    pub weight_pt: f32,
    /// A swatch token (`Color/docx-000000`).
    pub color: String,
}

/// A cell's four edges and fill (doc ADR 614).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoweredCellLook {
    pub top: LoweredEdge,
    pub left: LoweredEdge,
    pub bottom: LoweredEdge,
    pub right: LoweredEdge,
    /// A swatch token, `None` for no fill.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fill: Option<String>,
}

/// What Word says of a table beyond its grid that the engine does not lay
/// out yet, carried for the later engine work (doc ADR 614).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoweredTableLayout {
    /// `w:tblLayout w:type="fixed"`.
    #[serde(default)]
    pub fixed: bool,
    /// `w:tblW`: points (`dxa`), or a percentage of the text width.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width_pt: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width_pct: Option<f32>,
    /// `w:tcW` per lowered cell, in points where Word gives `dxa`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub cell_widths_pt: Vec<Option<f32>>,
    /// `w:tblInd`, pt.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub indent_pt: Option<f32>,
    /// Per row: `w:cantSplit`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub cant_split: Vec<bool>,
    /// Per row: `w:hRule="exact"` (held at its height).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub exact_rows: Vec<bool>,
}
