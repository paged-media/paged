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

//! A picture's crop (`a:srcRect`) as the engine's picture placement, and
//! back: the one mapping of paged.slide, paged.doc and paged.sheet.
//!
//! DrawingML stretches the part of the image the source rectangle leaves
//! over the frame. The engine places the whole image in its frame by the
//! inner image transform `[a, 0, 0, d, e, f]` (natural pixels to points, in
//! the frame's own box): the image is shown at `w / (1 - l - r)` by
//! `h / (1 - t - b)`, its top left corner `l` and `t` of that outside the
//! frame. A negative side pads (PowerPoint shows the frame's fill there).

/// The sides of an `a:srcRect` (left, top, right, bottom; 1/1000 percent)
/// as fractions of the image.
pub use paged_ooxml::drawingml::paint::rel_rect_fractions as fractions;

/// Fractions back as `a:srcRect` sides, rounded to the unit.
pub use paged_ooxml::drawingml::paint::rel_rect_of as src_rect;

/// A crop a lane that does not pad carries: every side non-negative, some
/// side cropping, and a picture left in both directions. Word and Excel
/// (doc ADR 623, sheet ADR 529) carry only these; PowerPoint pads too.
pub fn is_plain(sides: [f64; 4]) -> bool {
    let [l, t, r, b] = sides;
    sides.iter().all(|v| *v >= 0.0) && sides.iter().any(|v| *v != 0.0) && l + r < 1.0 && t + b < 1.0
}

/// The size the whole image is shown at in a `w` × `h` frame cropped by
/// `sides` (a crop that leaves nothing is held to a millionth).
pub fn display_size(sides: [f64; 4], (w, h): (f64, f64)) -> (f64, f64) {
    let [l, t, r, b] = sides;
    (w / (1.0 - l - r).max(1e-6), h / (1.0 - t - b).max(1e-6))
}

/// The image's placement in its `w` × `h` frame for `pixels` source
/// pixels and the crop `sides` (fractions): the inner image transform.
/// `None` for an image without a pixel size.
pub fn placement(sides: [f64; 4], frame: (f64, f64), pixels: (u32, u32)) -> Option<[f64; 6]> {
    let (pw, ph) = pixels;
    if pw == 0 || ph == 0 {
        return None;
    }
    let (dw, dh) = display_size(sides, frame);
    Some([
        dw / f64::from(pw),
        0.0,
        0.0,
        dh / f64::from(ph),
        -sides[0] * dw,
        -sides[1] * dh,
    ])
}

/// The image's own pixels per point as a frame of `display` points shows
/// `pixels` (the mean of the two directions): a picture blur's radius is
/// in the image's own pixels (engine ADR 1037).
pub fn px_per_pt(pixels: (u32, u32), display: (f64, f64)) -> Option<f64> {
    let (dw, dh) = display;
    (dw > 0.0 && dh > 0.0 && pixels.0 > 0 && pixels.1 > 0)
        .then(|| (f64::from(pixels.0) / dw + f64::from(pixels.1) / dh) / 2.0)
}

/// The part of the image a placement shows in its `w` × `h` frame, `[x, y,
/// w, h]` in the image's own pixels (what a painter cuts from the decoded
/// image); `None` for an image shown at no size.
pub fn source_rect(m: [f64; 6], (w, h): (f64, f64)) -> Option<[f64; 4]> {
    (m[0].abs() > 1e-12 && m[3].abs() > 1e-12)
        .then(|| [-m[4] / m[0], -m[5] / m[3], w / m[0], h / m[3]])
}

/// The crop a placement stands for, the inverse of [`placement`]: the
/// fractions of the image left out at each side of the frame whose box is
/// `[left, top, right, bottom]` (in the same inner coordinates as the
/// transform `m`). `None` for an image shown at no size.
pub fn of_placement(m: [f64; 6], frame: [f64; 4], pixels: (u32, u32)) -> Option<[f64; 4]> {
    let [fl, ft, fr, fb] = frame;
    let dw = m[0] * f64::from(pixels.0);
    let dh = m[3] * f64::from(pixels.1);
    if dw.abs() < 1e-9 || dh.abs() < 1e-9 {
        return None;
    }
    let l = (fl - m[4]) / dw;
    let t = (ft - m[5]) / dh;
    Some([l, t, 1.0 - l - (fr - fl) / dw, 1.0 - t - (fb - ft) / dh])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_middle_half_fills_the_frame() {
        // l = r = 25 %: the middle half of a 200 x 100 px image fills a
        // 100 x 50 pt frame, so the image is shown 200 x 100 pt, 50 pt left.
        let s = fractions((25_000, 0, 25_000, 0));
        assert!(is_plain(s));
        let m = placement(s, (100.0, 50.0), (200, 100)).unwrap();
        assert_eq!(m, [1.0, 0.0, 0.0, 0.5, -50.0, 0.0]);
        assert_eq!(px_per_pt((200, 100), (200.0, 100.0)), Some(1.0));
        assert_eq!(
            source_rect(m, (100.0, 50.0)),
            Some([50.0, 0.0, 100.0, 100.0])
        );
    }

    #[test]
    fn a_crop_round_trips() {
        let s = fractions((10_000, 20_000, 30_000, 5_000));
        let m = placement(s, (120.0, 80.0), (640, 480)).unwrap();
        let back = of_placement(m, [0.0, 0.0, 120.0, 80.0], (640, 480)).unwrap();
        assert_eq!(src_rect(back), (10_000, 20_000, 30_000, 5_000));
        // The same frame elsewhere in its inner box.
        let mut moved = m;
        moved[4] += 7.0;
        moved[5] -= 3.0;
        let back = of_placement(moved, [7.0, -3.0, 127.0, 77.0], (640, 480)).unwrap();
        assert_eq!(src_rect(back), (10_000, 20_000, 30_000, 5_000));
    }

    #[test]
    fn what_a_plain_crop_is() {
        assert!(!is_plain([0.0; 4]));
        assert!(!is_plain(fractions((-5_000, 0, 0, 0))));
        assert!(!is_plain(fractions((60_000, 0, 40_000, 0))));
        // PowerPoint pads: the placement still says it.
        let m = placement(fractions((-50_000, 0, 0, 0)), (150.0, 100.0), (100, 100)).unwrap();
        assert_eq!(m, [1.0, 0.0, 0.0, 1.0, 50.0, 0.0]);
        assert!(placement([0.0; 4], (1.0, 1.0), (0, 10)).is_none());
    }
}
