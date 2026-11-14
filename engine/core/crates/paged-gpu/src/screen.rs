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

//! Engine ADR 1306 — what a page draws on the editor's screen, one rule
//! for both lanes (engine ADR 146).
//!
//! A page's artwork is not cut at the trim on screen: what bleeds, and
//! what was left on the pasteboard beside the page, shows there, as in
//! InDesign's Normal view. It is cut at the pasteboard's reach, one page
//! width and height past the trim on each side, so the CPU lane's tile
//! stays a bounded raster. The paper is the trim alone.
//!
//! The CPU lane draws exactly [`screen_extent`] as its tile; the GPU lane
//! draws the whole display list over the paper and clips it to the same
//! rect when the artwork reaches past it ([`ScreenExtent::clipped`]). The
//! proof views (editor ADR 1212) mask the pasteboard over either.

use paged_compose::{DisplayList, Rect};

/// Padding (pt) around what the display list reports it paints: the
/// extent walk rounds antialiasing and caps off.
const PAINT_PAD_PT: f32 = 1.0;

/// Where a page draws on screen, page-local pt (`(0, 0)` = the trim's
/// top-left).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ScreenExtent {
    /// The trim, grown to what the page paints (whole points, padded),
    /// within the pasteboard's reach.
    pub rect: Rect,
    /// Whether the page's artwork reaches past the pasteboard's reach, so
    /// a lane that draws the whole list must clip it to `rect`.
    pub clipped: bool,
}

impl ScreenExtent {
    /// The rect as `[x0, y0, x1, y1]`.
    pub fn edges(&self) -> [f32; 4] {
        let r = self.rect;
        [r.x, r.y, r.x + r.w, r.y + r.h]
    }
}

/// The pasteboard's reach of a `width_pt × height_pt` page: the trim grown
/// by a page width left and right and a page height above and below.
pub fn pasteboard_reach(width_pt: f32, height_pt: f32) -> Rect {
    Rect {
        x: -width_pt,
        y: -height_pt,
        w: 3.0 * width_pt,
        h: 3.0 * height_pt,
    }
}

/// The part of the canvas a page with `list` draws on screen (see the
/// module docs).
pub fn screen_extent(list: &DisplayList, width_pt: f32, height_pt: f32) -> ScreenExtent {
    let trim = [0.0, 0.0, width_pt.max(0.0), height_pt.max(0.0)];
    let reach = pasteboard_reach(width_pt.max(0.0), height_pt.max(0.0));
    let reach = [reach.x, reach.y, reach.x + reach.w, reach.y + reach.h];
    let painted = paged_compose::extent::painted_bounds(list)
        .filter(|b| b.x.is_finite() && b.y.is_finite() && b.w.is_finite() && b.h.is_finite());
    let Some(p) = painted else {
        return ScreenExtent {
            rect: rect_of(trim),
            clipped: false,
        };
    };
    let paint = [
        (p.x - PAINT_PAD_PT).floor(),
        (p.y - PAINT_PAD_PT).floor(),
        (p.x + p.w + PAINT_PAD_PT).ceil(),
        (p.y + p.h + PAINT_PAD_PT).ceil(),
    ];
    let clipped =
        paint[0] < reach[0] || paint[1] < reach[1] || paint[2] > reach[2] || paint[3] > reach[3];
    let grown = [
        trim[0].min(paint[0]).max(reach[0]),
        trim[1].min(paint[1]).max(reach[1]),
        trim[2].max(paint[2]).min(reach[2]),
        trim[3].max(paint[3]).min(reach[3]),
    ];
    ScreenExtent {
        rect: rect_of(grown),
        clipped,
    }
}

fn rect_of([x0, y0, x1, y1]: [f32; 4]) -> Rect {
    Rect {
        x: x0,
        y: y0,
        w: (x1 - x0).max(0.0),
        h: (y1 - y0).max(0.0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use paged_compose::{Color, DisplayCommand, Paint, PathData, PathSegment, Transform};

    fn page_with(rects: &[[f32; 4]]) -> DisplayList {
        let mut list = DisplayList::new();
        let mut p = PathData::default();
        p.segments.push(PathSegment::MoveTo { x: 0.0, y: 0.0 });
        p.segments.push(PathSegment::LineTo { x: 1.0, y: 0.0 });
        p.segments.push(PathSegment::LineTo { x: 1.0, y: 1.0 });
        p.segments.push(PathSegment::LineTo { x: 0.0, y: 1.0 });
        p.segments.push(PathSegment::Close);
        let unit = list.paths.push_anon(p);
        for &[x, y, w, h] in rects {
            list.commands.push(DisplayCommand::FillPath {
                path_id: unit,
                paint: Paint::Solid(Color::BLACK),
                transform: Transform([w, 0.0, 0.0, h, x, y]),
            });
        }
        list
    }

    #[test]
    fn a_page_that_stays_inside_its_trim_draws_its_trim() {
        let e = screen_extent(&page_with(&[[10.0, 10.0, 50.0, 50.0]]), 200.0, 300.0);
        assert_eq!(e.edges(), [0.0, 0.0, 200.0, 300.0]);
        assert!(!e.clipped);
        // A blank page too.
        let e = screen_extent(&DisplayList::new(), 200.0, 300.0);
        assert_eq!(e.edges(), [0.0, 0.0, 200.0, 300.0]);
    }

    #[test]
    fn bleed_artwork_grows_the_extent_by_what_it_paints() {
        // A background that bleeds 9 pt on every side.
        let e = screen_extent(&page_with(&[[-9.0, -9.0, 218.0, 318.0]]), 200.0, 300.0);
        assert_eq!(e.edges(), [-10.0, -10.0, 210.0, 310.0]);
        assert!(!e.clipped);
    }

    #[test]
    fn the_pasteboard_reach_cuts_what_lies_further_out() {
        let e = screen_extent(&page_with(&[[-500.0, 20.0, 50.0, 50.0]]), 200.0, 300.0);
        assert_eq!(e.edges(), [-200.0, 0.0, 200.0, 300.0]);
        assert!(e.clipped);
    }
}
