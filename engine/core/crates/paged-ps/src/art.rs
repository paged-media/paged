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

//! What an EPS draws: a list of vector elements in PostScript's default
//! user space (points, y up), in paint order. The renderer maps them to
//! its display list; nothing here depends on it.

use kurbo::{Affine, BezPath};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FillRule {
    NonZero,
    EvenOdd,
}

/// A colour in a device space, components 0..=1.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Color {
    Gray(f32),
    Rgb([f32; 3]),
    Cmyk([f32; 4]),
}

impl Color {
    /// The colour as sRGB-encoded components (CMYK by the engine's naive
    /// conversion; a renderer with a CMYK profile converts the CMYK
    /// itself).
    pub fn to_srgb(&self) -> [f32; 3] {
        match *self {
            Color::Gray(g) => [g, g, g],
            Color::Rgb(c) => c,
            Color::Cmyk([c, m, y, k]) => paged_color::math::naive_cmyk_to_srgb(c, m, y, k),
        }
    }
}

/// A paint: its device colour, and the separation (spot ink) it was
/// given in, if any, whose alternate the colour is.
#[derive(Clone, Debug, PartialEq)]
pub struct Paint {
    pub color: Color,
    pub separation: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LineCap {
    Butt,
    Round,
    Square,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LineJoin {
    Miter,
    Round,
    Bevel,
}

#[derive(Clone, Debug, PartialEq)]
pub struct StrokeStyle {
    /// In user space (the stroke's `transform` maps it).
    pub width: f64,
    pub cap: LineCap,
    pub join: LineJoin,
    pub miter_limit: f64,
    pub dash: Vec<f64>,
    pub dash_offset: f64,
}

/// Image samples, 8 bits per component, rows top (first in the data)
/// to bottom.
#[derive(Clone, Debug, PartialEq)]
pub enum Pixels {
    Gray(Vec<u8>),
    Rgb(Vec<u8>),
    Cmyk(Vec<u8>),
}

impl Pixels {
    pub fn len(&self) -> usize {
        match self {
            Pixels::Gray(v) | Pixels::Rgb(v) | Pixels::Cmyk(v) => v.len(),
        }
    }
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Image {
    pub width: u32,
    pub height: u32,
    pub pixels: Pixels,
    /// Coverage per sample (255 opaque), for a stencil mask
    /// (`imagemask`) or a masked image.
    pub alpha: Option<Vec<u8>>,
    /// Maps the unit square to default user space: (0, 0) is the corner
    /// of the first sample, (1, 0) the end of the first row, (0, 1) the
    /// start of the last row's far edge.
    pub transform: Affine,
}

#[derive(Clone, Debug, PartialEq)]
pub enum GradientKind {
    /// Colour ramps from `(x0, y0)` (t = 0) to `(x1, y1)` (t = 1).
    Axial { x0: f64, y0: f64, x1: f64, y1: f64 },
    /// Concentric circles about `(cx, cy)`: radius `r0` at t = 0, `r1`
    /// at t = 1.
    Radial { cx: f64, cy: f64, r0: f64, r1: f64 },
}

/// A smooth shading the renderer can draw as a gradient. It paints
/// everywhere inside the current clip (an unextended end is already a
/// clip), past its ends with the end colours.
#[derive(Clone, Debug, PartialEq)]
pub struct Gradient {
    pub kind: GradientKind,
    /// `(t, colour)`, t ascending in 0..=1.
    pub stops: Vec<(f32, Color)>,
    /// Shading space → default user space.
    pub transform: Affine,
    /// The area (default user space) to cover: the clip's box.
    pub area: [f64; 4],
}

#[derive(Clone, Debug, PartialEq)]
pub enum Element {
    /// A filled area; `path` in default user space.
    Fill {
        path: BezPath,
        rule: FillRule,
        paint: Paint,
    },
    /// A stroked path; `path` in the user space the stroke was made in,
    /// `transform` from there to default user space.
    Stroke {
        path: BezPath,
        transform: Affine,
        style: StrokeStyle,
        paint: Paint,
    },
    /// Intersect the clip with `path` (default user space) until the
    /// matching `PopClip`.
    PushClip {
        path: BezPath,
        rule: FillRule,
    },
    PopClip,
    Image(Image),
    Gradient(Gradient),
}

/// What the interpreter noticed while it ran.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Report {
    /// Each font the program asked for and did not define, with the face
    /// drawn in its place (`None`: no face was available, and the text
    /// was not drawn).
    pub substituted_fonts: Vec<(String, Option<String>)>,
    /// Features met and skipped (e.g. a smooth shading type), each once.
    pub unsupported: Vec<String>,
    /// Operators and tokens executed.
    pub operations: u64,
    /// The bounding box came from the drawing, not a `%%BoundingBox`.
    pub bbox_from_content: bool,
}

impl Report {
    pub fn unsupported(&mut self, what: &str) {
        if !self.unsupported.iter().any(|u| u == what) {
            self.unsupported.push(what.to_string());
        }
    }
}

/// An interpreted EPS.
#[derive(Clone, Debug, PartialEq)]
pub struct Art {
    /// `[llx, lly, urx, ury]` in default user space: the
    /// `%%HiResBoundingBox` when there is one, else `%%BoundingBox`.
    pub bbox: [f64; 4],
    pub elements: Vec<Element>,
    pub report: Report,
}
