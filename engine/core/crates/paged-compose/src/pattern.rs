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

//! Engine ADR 1041 — the pattern pool: what a [`crate::Paint::Pattern`]
//! paints.
//!
//! A [`PatternPaint`] is one USE of a pattern: the shared repeating
//! [`PatternTile`] (its period and the copies of its items that reach into
//! it, colours already resolved) and the affine taking pattern space to
//! the path's local space, which the drawing command's transform then
//! takes to the page. Every consumer draws the same period: the
//! rasterisers rasterise it once per display scale and repeat it as an
//! image brush; the PDF writer writes it as a tiling pattern's cell.

use std::sync::Arc;

use crate::{Paint, PathData, Stroke, Transform};

/// Index into [`crate::DisplayList::patterns`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct PatternId(pub u32);

/// One item of a tile, in tile space, colours resolved (`Paint::Solid` or
/// `Paint::Cmyk`).
#[derive(Debug, Clone, PartialEq)]
pub struct PatternShape {
    pub path: PathData,
    pub fill: Option<Paint>,
    pub stroke: Option<(Paint, Stroke)>,
}

/// The repeating cell of a pattern: `0..period.0 × 0..period.1` in pattern
/// space shows `items` drawn at every origin in `copies`, in order,
/// clipped to the cell. Repeated by the period it paints the plane.
#[derive(Debug, Clone, PartialEq)]
pub struct PatternTile {
    pub period: (f32, f32),
    pub items: Vec<PatternShape>,
    pub copies: Vec<(f32, f32)>,
    /// FNV-1a of the content: the raster cache's key and the digest's.
    pub hash: u64,
}

impl PatternTile {
    /// A tile, its content hashed.
    pub fn new(period: (f32, f32), items: Vec<PatternShape>, copies: Vec<(f32, f32)>) -> Self {
        use std::fmt::Write as _;
        let mut h = paged_pixel::Fnv1a64::default();
        let _ = write!(h, "{period:?}{items:?}{copies:?}");
        PatternTile {
            period,
            items,
            copies,
            hash: h.0,
        }
    }

    /// Whether the cell can paint anything.
    pub fn is_drawable(&self) -> bool {
        self.period.0.is_finite()
            && self.period.1.is_finite()
            && self.period.0 > 0.0
            && self.period.1 > 0.0
            && !self.items.is_empty()
            && !self.copies.is_empty()
    }
}

/// One use of a pattern.
#[derive(Debug, Clone, PartialEq)]
pub struct PatternPaint {
    pub tile: Arc<PatternTile>,
    /// Pattern space → the drawing path's local space.
    pub to_local: Transform,
}
