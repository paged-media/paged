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

//! The **vector page IR** — what [`super::read_page`] returns: one PDF page
//! as the items it paints, in paint order, ready to lower to native page
//! items (publish ADR 658). The TypeScript twin is
//! `packages/pdf-bundle/src/vectors/ir.ts`; the two move together.
//!
//! Everything is in **points** in the page's own space: the origin at the
//! top-left of the page box the read was asked for (the crop box unless
//! told otherwise), y growing downward — the convention of the Document IR
//! ([`crate::ir`]). Colours are sRGB, each channel `0.0..=1.0`.

use serde::Serialize;

/// What a file is, before any page is read: its pages, and whether it is
/// an Illustrator file and how it can be read.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PdfInfo {
    /// `"pdf"` or `"ai"`.
    pub format: &'static str,
    /// Every page, in order, at the size of its crop box.
    pub pages: Vec<PageInfo>,
    /// Illustrator facts; `None` for a plain PDF.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ai: Option<AiInfo>,
}

/// One page's size in points.
#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
pub struct PageInfo {
    pub width_pt: f32,
    pub height_pt: f32,
}

/// What the reader knows about an Illustrator file.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct AiInfo {
    /// The file was saved with "Create PDF Compatible File": it carries a
    /// PDF the reader opens. Without it there is nothing to read and the
    /// read refuses ([`super::ReadError::AiWithoutPdf`]).
    pub pdf_compatible: bool,
    /// The file carries Illustrator's own private data (`AIPrivateData`
    /// streams, or the `/Illustrator` piece dictionary). It is never
    /// parsed: the artwork comes from the PDF Illustrator wrote beside it.
    pub has_private_data: bool,
    /// The `Creator` the file names, when it names one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub creator: Option<String>,
}

/// One page as vector items.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct VectorPage {
    pub page_index: usize,
    pub width_pt: f32,
    pub height_pt: f32,
    /// Paint order: the first item is the bottom-most.
    pub items: Vec<Item>,
    /// What could not be carried exactly, one entry per kind of loss.
    pub losses: Vec<Loss>,
}

/// A painted item.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Item {
    Path(PathItem),
    Image(ImageItem),
    Group(GroupItem),
    Text(TextItem),
}

/// A filled and/or stroked path.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PathItem {
    pub contours: Vec<Contour>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fill: Option<Paint>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stroke: Option<StrokeIr>,
    /// `"nonzero"` or `"evenodd"` (`f*`, `B*`).
    pub fill_rule: &'static str,
    /// The item's own opacity, over its fill's and stroke's: a
    /// transparency group around this one item, folded into it.
    pub opacity: f32,
    /// The PDF blend mode in IDML's spelling (`"Multiply"`, …); absent
    /// for `Normal`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blend: Option<&'static str>,
}

/// One contour as Bézier anchors: each anchor with the handle that comes
/// into it (`left`) and the one that leaves it (`right`); a straight
/// segment has both handles on their anchors. Quadratic segments arrive
/// raised to cubics.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Contour {
    pub anchors: Vec<Anchor>,
    pub closed: bool,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
pub struct Anchor {
    pub anchor: [f32; 2],
    pub left: [f32; 2],
    pub right: [f32; 2],
}

/// A fill or stroke paint.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Paint {
    Solid {
        rgb: [f32; 3],
        /// The PDF's constant alpha for this paint (`ca` / `CA`).
        opacity: f32,
    },
    /// An axial shading: the ramp runs from `start` to `end`.
    Linear {
        start: [f32; 2],
        end: [f32; 2],
        stops: Vec<Stop>,
        opacity: f32,
        /// `[before start, after end]`: the PDF's `Extend`. A native ramp
        /// always pads, so a `false` is reported where it shows.
        extend: [bool; 2],
    },
    /// A radial shading drawn as one circle: centred at `center`, the
    /// ramp running from it to `radius`. A shading whose two circles do
    /// not share a centre, or whose inner circle has a radius, is mapped
    /// to its outer circle with the stops placed along the radius, and
    /// reported.
    Radial {
        center: [f32; 2],
        radius: f32,
        stops: Vec<Stop>,
        opacity: f32,
        extend: [bool; 2],
    },
}

/// One colour stop of a ramp: `offset` in `0.0..=1.0`.
#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
pub struct Stop {
    pub offset: f32,
    pub rgb: [f32; 3],
}

/// A stroke, in page space: its width and dashes are scaled by the
/// transform it was drawn under.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct StrokeIr {
    pub paint: Paint,
    pub width: f32,
    /// `"butt"`, `"round"` or `"square"`.
    pub cap: &'static str,
    /// `"miter"`, `"round"` or `"bevel"`.
    pub join: &'static str,
    pub miter_limit: f32,
    /// Dash and gap lengths; empty for a solid line.
    pub dash: Vec<f32>,
    pub dash_phase: f32,
}

/// An image: `transform` maps the unit square (top-left origin, y down)
/// onto the page, as the image's pixels are laid out.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ImageItem {
    pub transform: [f32; 6],
    pub width_px: u32,
    pub height_px: u32,
    /// The image's bytes, base64: the PDF's own JPEG when the stream is one
    /// the engine decodes as it stands, else a PNG (with alpha when the
    /// image has a mask).
    pub data_b64: String,
    /// `"image/jpeg"` or `"image/png"`.
    pub mime: &'static str,
    pub opacity: f32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blend: Option<&'static str>,
}

/// Items painted together: under a clip, as one transparency group, or
/// through a soft mask.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct GroupItem {
    pub items: Vec<Item>,
    /// The members paint inside this outline (an Illustrator clipping
    /// mask; a PDF `W n`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub clip: Option<ClipIr>,
    /// The group's constant alpha (1 for a plain or clip group).
    pub opacity: f32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blend: Option<&'static str>,
    pub isolated: bool,
    pub knockout: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mask: Option<MaskIr>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ClipIr {
    pub contours: Vec<Contour>,
    pub fill_rule: &'static str,
}

/// A soft mask: the luminosity (or alpha) of `items` modulates the group.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct MaskIr {
    /// `"luminosity"` or `"alpha"`.
    pub mask_type: &'static str,
    pub items: Vec<Item>,
    /// A luminosity mask's backdrop (`BC`), when it is not black.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backdrop_rgb: Option<[f32; 3]>,
}

/// A run of text as the page paints it: where it lies, what it says, and
/// its glyphs' outlines. The editable text comes from the bundle's own
/// text reader; this item says where in the paint order the text sits and
/// carries the outlines that stand in for a font the host does not have.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct TextItem {
    /// `[x, y, width, height]`.
    pub bbox: [f32; 4],
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub font_name: Option<String>,
    pub font_size_pt: f32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fill: Option<Paint>,
    /// The glyphs' outlines, filled non-zero, in page space.
    pub outlines: Vec<Contour>,
    /// The run is not upright (rotated, sheared or mirrored text).
    pub rotated: bool,
    /// See [`PathItem::opacity`].
    pub opacity: f32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blend: Option<&'static str>,
}

/// One kind of loss, with how often it happened on the page.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Loss {
    /// Stable code (`"shading.sampled"`, …); the bundle words it.
    pub code: &'static str,
    pub count: u32,
}
