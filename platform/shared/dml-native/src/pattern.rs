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

//! Preset patterns (`a:pattFill`) as tiles (slide ADR 723).
//!
//! The engine on main has no pattern paint yet (engine ADR 1041 is on a
//! branch), so a pattern fill is drawn as a picture of its tiles placed in
//! the shape and clipped by its outline; the module keeps the authored
//! `a:pattFill` and writes it back as it was. When pattern paint lands, the
//! cells here become its tiles.
//!
//! PowerPoint draws a preset pattern as an 8 x 8 cell of two colours, one
//! point a cell bit, repeated on an 8 pt grid that starts at the slide's
//! top-left corner and does not turn with the shape
//! ([`paged_ooxml::drawingml::pattern`], measured on PowerPoint's PDF).

use crate::PatternPaint;
pub use paged_ooxml::drawingml::pattern::{cell, CELLS, CELL_PT};

/// A pattern drawn as a picture: `w × h` palette indices (one byte a
/// pixel, top row first; 0 the background, 1 the foreground) at
/// `px_per_pt`, whose top-left pixel corner is at `origin` on the slide.
#[derive(Debug, Clone, PartialEq)]
pub struct PatternTile {
    pub w: u32,
    pub h: u32,
    pub px_per_pt: f64,
    pub origin: [f64; 2],
    /// RGBA: the background, then the foreground.
    pub palette: [[u8; 4]; 2],
    pub indices: Vec<u8>,
}

/// The largest side of a tile picture, pixels: a larger area is drawn at a
/// lower density.
pub const MAX_TILE_PX: f64 = 2048.0;

/// The density a tile picture is drawn at, pixels per point: two, so a
/// cell bit stays two pixels wide up to 200 % zoom.
pub const TILE_PX_PER_PT: f64 = 2.0;

/// The tiles of `pp` covering `bounds` (`[left, top, right, bottom]` on
/// the slide, pt), snapped outward to the 8 pt grid. `None` for an unknown
/// preset or an empty area.
pub fn tile(pp: &PatternPaint, bounds: [f64; 4]) -> Option<PatternTile> {
    let c = cell(&pp.preset)?;
    let [l, t, r, b] = bounds;
    if !(r > l && b > t) || ![l, t, r, b].iter().all(|v| v.is_finite()) {
        return None;
    }
    let x0 = (l / CELL_PT).floor() * CELL_PT;
    let y0 = (t / CELL_PT).floor() * CELL_PT;
    let x1 = (r / CELL_PT).ceil() * CELL_PT;
    let y1 = (b / CELL_PT).ceil() * CELL_PT;
    let (wpt, hpt) = (x1 - x0, y1 - y0);
    let k = TILE_PX_PER_PT.min(MAX_TILE_PX / wpt.max(hpt));
    let w = (wpt * k).round().max(1.0) as u32;
    let h = (hpt * k).round().max(1.0) as u32;
    let mut indices = vec![0u8; (w * h) as usize];
    for y in 0..h {
        // The cell bit under the pixel's centre, on the slide's grid.
        let py = y0 + (y as f64 + 0.5) / k;
        let row = c[(py.floor() as i64).rem_euclid(8) as usize];
        for x in 0..w {
            let px = x0 + (x as f64 + 0.5) / k;
            let bit = (px.floor() as i64).rem_euclid(8) as u32;
            indices[(y * w + x) as usize] = (row >> (7 - bit)) & 1;
        }
    }
    let a = |v: f64| (v.clamp(0.0, 1.0) * 255.0).round() as u8;
    Some(PatternTile {
        w,
        h,
        px_per_pt: k,
        origin: [x0, y0],
        palette: [
            [pp.bg[0], pp.bg[1], pp.bg[2], a(pp.bg_alpha)],
            [pp.fg[0], pp.fg[1], pp.fg[2], a(pp.fg_alpha)],
        ],
        indices,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_tile_starts_on_the_slides_grid() {
        let pp = PatternPaint {
            preset: "horz".into(),
            fg: [0, 0, 0],
            fg_alpha: 1.0,
            bg: [255, 255, 255],
            bg_alpha: 0.5,
        };
        let t = tile(&pp, [30.0, 30.0, 45.0, 41.0]).unwrap();
        assert_eq!(t.origin, [24.0, 24.0]);
        assert_eq!((t.w, t.h), (48, 48));
        // `horz` is its cell's top row: pixel rows 0–1, 16–17, 32–33.
        assert_eq!(t.indices[0], 1);
        assert_eq!(t.indices[2 * 48], 0);
        assert_eq!(t.indices[16 * 48 + 5], 1);
        assert_eq!(t.palette[0][3], 128);
        // A large shape is drawn at a lower density.
        let big = tile(&pp, [0.0, 0.0, 4000.0, 100.0]).unwrap();
        assert!(big.w <= 2048 && big.px_per_pt < 1.0);
        assert!(tile(
            &PatternPaint {
                preset: "nope".into(),
                ..pp
            },
            [0.0, 0.0, 8.0, 8.0]
        )
        .is_none());
    }
}
