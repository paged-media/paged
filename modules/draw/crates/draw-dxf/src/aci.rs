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

//! The AutoCAD Color Index: the 255 colours a DXF names by number.
//!
//! 1–9 are named colours; 10–249 are 24 hues, 15° apart, each in ten
//! steps — a full colour and a half-saturated tint at five brightnesses
//! (255, 165, 127, 76, 38); 250–255 are greys. Index 7 is "white or
//! black, against the background": on paper it is black, and it is read
//! as black here.

/// The five brightnesses of a hue's steps.
const LEVELS: [f64; 5] = [255.0, 165.0, 127.0, 76.0, 38.0];
/// The greys of 250–255.
const GREYS: [u8; 6] = [51, 80, 105, 130, 190, 255];

/// The RGB of index `i` (1–255). 0 and 256 are BYBLOCK / BYLAYER and
/// have no colour of their own: they read as black here.
pub fn rgb(i: u8) -> [u8; 3] {
    match i {
        1 => [255, 0, 0],
        2 => [255, 255, 0],
        3 => [0, 255, 0],
        4 => [0, 255, 255],
        5 => [0, 0, 255],
        6 => [255, 0, 255],
        8 => [128, 128, 128],
        9 => [192, 192, 192],
        10..=249 => {
            let step = usize::from(i % 10);
            let hue = f64::from(i / 10 - 1) * 15.0;
            let v = LEVELS[step / 2];
            // An odd step is the tint: its weakest channel at half.
            let floor = if step % 2 == 1 { 0.5 } else { 0.0 };
            hsv(hue, floor, v)
        }
        250..=255 => {
            let g = GREYS[usize::from(i - 250)];
            [g, g, g]
        }
        _ => [0, 0, 0],
    }
}

/// A hue at brightness `v`, its channels between `v · floor` and `v`.
fn hsv(hue: f64, floor: f64, v: f64) -> [u8; 3] {
    let h = (hue / 60.0).rem_euclid(6.0);
    let f = h - h.floor();
    let lo = floor;
    let up = lo + (1.0 - lo) * f;
    let down = 1.0 - (1.0 - lo) * f;
    let (r, g, b) = match h as u32 {
        0 => (1.0, up, lo),
        1 => (down, 1.0, lo),
        2 => (lo, 1.0, up),
        3 => (lo, down, 1.0),
        4 => (up, lo, 1.0),
        _ => (1.0, lo, down),
    };
    // AutoCAD's table truncates: 11 is (255, 127, 127), 20 is (255, 63, 0).
    let c = |x: f64| (x * v + 1e-9).floor().clamp(0.0, 255.0) as u8;
    [c(r), c(g), c(b)]
}

/// The index whose colour is nearest `c` (1–255; black is 7, which reads
/// as black on paper).
pub fn nearest(c: [u8; 3]) -> u8 {
    if c == [0, 0, 0] {
        return 7;
    }
    let mut best = (u32::MAX, 7u8);
    for i in 1..=255u8 {
        if i == 7 {
            continue;
        }
        let d = distance(rgb(i), c);
        if d < best.0 {
            best = (d, i);
        }
    }
    best.1
}

fn distance(a: [u8; 3], b: [u8; 3]) -> u32 {
    a.iter()
        .zip(b)
        .map(|(&x, y)| {
            let d = i32::from(x) - i32::from(y);
            (d * d) as u32
        })
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_steps_of_a_hue_are_its_colour_and_tint_at_five_brightnesses() {
        assert_eq!(rgb(10), [255, 0, 0]);
        assert_eq!(rgb(11), [255, 127, 127]);
        assert_eq!(rgb(13), [165, 82, 82]);
        assert_eq!(rgb(12), [165, 0, 0]);
        assert_eq!(rgb(14), [127, 0, 0]);
        assert_eq!(rgb(18), [38, 0, 0]);
        // 15° on: red with a quarter of green.
        assert_eq!(rgb(20), [255, 63, 0]);
        assert_eq!(rgb(30), [255, 127, 0]);
        assert_eq!(rgb(170), [0, 0, 255]);
        assert_eq!(rgb(250), [51, 51, 51]);
        assert_eq!(rgb(7), [0, 0, 0]);
    }

    #[test]
    fn nearest_finds_an_exact_index_and_black_is_seven() {
        for i in [1u8, 5, 30, 141, 254] {
            assert_eq!(rgb(nearest(rgb(i))), rgb(i), "{i}");
        }
        assert_eq!(nearest([0, 0, 0]), 7);
    }
}
