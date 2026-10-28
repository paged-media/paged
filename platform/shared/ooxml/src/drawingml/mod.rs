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

//! # DrawingML paint and effects — one reader for doc, slide and sheet
//!
//! DrawingML (ECMA-376 Part 1, §20.1) describes how a shape, a picture or
//! a chart element is painted the same way in `.pptx`, `.docx` and
//! `.xlsx`. This module reads it ONCE, over the element tree ([`crate::tree`]):
//!
//! - [`color`], the six colour elements with their transform chains, and
//!   their resolution (`lumMod`, `tint`, `shade`, `alpha`, …) against the
//!   caller's scheme slots ([`SchemeColors`]);
//! - [`paint`], `a:noFill`, `a:solidFill`, `a:gradFill`, `a:pattFill`,
//!   `a:blipFill` with every picture effect of its `a:blip`, `a:grpFill`,
//!   and `a:ln`;
//! - [`effect`], `a:effectLst`;
//! - [`resolved`], the NEUTRAL resolved IR (points, degrees, fractions,
//!   sRGB bytes) the modules lower from, and the resolution into it;
//! - [`write`], the resolved IR back as DrawingML, for the save paths.
//!
//! The authored types keep the file's units and inheritance links (a
//! scheme slot is a name until it is resolved). The lowering onto the
//! engine's model lives beside this crate, in `platform/shared/dml-native`,
//! because this crate stays free of the engine (PM-0002).

pub mod color;
pub mod effect;
pub mod paint;
pub mod resolved;
pub mod write;

pub use color::{color, color_in, resolve, Color, ColorBase, Rgba, SchemeColors};
pub use effect::{effects, Blur, Effects, FillOverlay, Glow, PresetShadow, Reflection, Shadow};
pub use paint::{
    blip, fill, fill_in, gradient, line, rect_attrs, Blip, BlipEffect, Fill, Gradient,
    GradientStop, Line, LineEnd, Pattern, RelRect, Rels, Shade, Tile,
};

use crate::tree::{El, Ns};

/// What a shape's properties (`a:spPr`, `pic:spPr`, `wps:spPr`, …) paint
/// with, as authored: the fill, the line and the effect list (the geometry
/// and transform are the module's). A picture's `pic:spPr` fills behind
/// the image, outlines it and casts its effects.
#[derive(Debug, Clone, Default, PartialEq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct ShapeProperties {
    #[cfg_attr(feature = "serde", serde(default))]
    pub fill: Option<Fill>,
    #[cfg_attr(feature = "serde", serde(default))]
    pub line: Option<Line>,
    #[cfg_attr(feature = "serde", serde(default))]
    pub effects: Effects,
}

impl ShapeProperties {
    /// Neither a fill, a line nor an effect.
    pub fn is_empty(&self) -> bool {
        self.fill.is_none() && self.line.is_none() && self.effects.is_empty()
    }
}

/// Read a shape-properties element (whatever its namespace: the children
/// are DrawingML's).
pub fn shape_properties(sp_pr: &El, rels: Rels) -> ShapeProperties {
    ShapeProperties {
        fill: fill_in(sp_pr, rels),
        line: sp_pr.child(Ns::A, "ln").map(|l| line(l, rels)),
        effects: sp_pr
            .child(Ns::A, "effectLst")
            .map(|e| effects(e, rels))
            .unwrap_or_default(),
    }
}
