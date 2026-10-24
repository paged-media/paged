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

//! PALETTE TARGETING — reduce a raster to `N` colours (or `N` greys)
//! BEFORE the clusterer sees it.
//!
//! Illustrator's "3 Colors", "6 Colors", "16 Colors" and "Shades of Gray"
//! presets name a COUNT, which the hierarchical clusterer has no knob for:
//! its precision and layer difference decide how many clusters come out,
//! and that number follows the image. So the count is honoured one step
//! earlier. Every pixel is snapped to the nearest colour of a palette of
//! at most `N`, and the clusterer then walks regions of exactly those
//! colours.
//!
//! DETERMINISTIC on purpose: the palette is a k-means over a fixed stride
//! sample, seeded by farthest-point selection from the sample's darkest
//! pixel, with a fixed iteration count. The same raster and the same `N`
//! give the same palette on every run and every target — a re-trace with
//! unchanged options reproduces the artwork it replaces.

use visioncortex::{Color, ColorImage};

/// Pixels the palette is fitted on. A stride sample, so a 4 MP raster
/// costs the same as a 64 kpx one.
const SAMPLE: usize = 16_384;

/// Lloyd iterations. Fixed, so the result never depends on a tolerance.
const ITERATIONS: usize = 12;

/// Rec. 709 luma, 0..=255, of an opaque pixel.
pub(crate) fn luma8(c: Color) -> u8 {
    let y = 0.2126 * c.r as f64 + 0.7152 * c.g as f64 + 0.0722 * c.b as f64;
    y.round().clamp(0.0, 255.0) as u8
}

fn dist2(a: [f64; 3], b: [f64; 3]) -> f64 {
    let d = [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    d[0] * d[0] + d[1] * d[1] + d[2] * d[2]
}

fn nearest(palette: &[[f64; 3]], p: [f64; 3]) -> usize {
    let mut best = 0;
    let mut best_d = f64::INFINITY;
    for (i, c) in palette.iter().enumerate() {
        let d = dist2(*c, p);
        if d < best_d {
            best_d = d;
            best = i;
        }
    }
    best
}

/// A deterministic k-means palette of at most `k` colours over `samples`.
/// Fewer distinct samples than `k` give fewer colours (a two-colour
/// drawing asked for six comes back with two, not six with duplicates).
pub fn kmeans_palette(samples: &[[f64; 3]], k: usize) -> Vec<[f64; 3]> {
    if samples.is_empty() || k == 0 {
        return Vec::new();
    }
    // Seed: the darkest sample (lowest channel sum; first wins a tie),
    // then repeatedly the sample FARTHEST from every centre chosen so far.
    let mut first = 0;
    for (i, s) in samples.iter().enumerate() {
        if s[0] + s[1] + s[2] < samples[first][0] + samples[first][1] + samples[first][2] {
            first = i;
        }
    }
    let mut centres: Vec<[f64; 3]> = vec![samples[first]];
    let mut nearest_d: Vec<f64> = samples.iter().map(|s| dist2(*s, centres[0])).collect();
    while centres.len() < k {
        let mut far = 0;
        for i in 0..samples.len() {
            if nearest_d[i] > nearest_d[far] {
                far = i;
            }
        }
        if nearest_d[far] <= 0.0 {
            break; // every sample already sits on a centre
        }
        let c = samples[far];
        centres.push(c);
        for (i, s) in samples.iter().enumerate() {
            nearest_d[i] = nearest_d[i].min(dist2(*s, c));
        }
    }
    for _ in 0..ITERATIONS {
        let mut sum = vec![[0.0f64; 3]; centres.len()];
        let mut count = vec![0usize; centres.len()];
        for s in samples {
            let i = nearest(&centres, *s);
            for ch in 0..3 {
                sum[i][ch] += s[ch];
            }
            count[i] += 1;
        }
        for i in 0..centres.len() {
            if count[i] > 0 {
                for ch in 0..3 {
                    centres[i][ch] = sum[i][ch] / count[i] as f64;
                }
            }
        }
    }
    centres
}

fn rgb(c: Color) -> [f64; 3] {
    [c.r as f64, c.g as f64, c.b as f64]
}

fn to_color(p: [f64; 3]) -> Color {
    let q = |v: f64| v.round().clamp(0.0, 255.0) as u8;
    Color::new_rgba(q(p[0]), q(p[1]), q(p[2]), 255)
}

/// Snap every pixel of `image` to a palette of at most `max_colors`
/// colours — or, with `grayscale`, of at most `max_colors` GREY levels
/// (the image is converted to luma first, so a coloured photograph
/// comes back in shades of grey). `max_colors == 0` leaves colour
/// images untouched and only greys a `grayscale` one. Answers the
/// palette as it was used, in the order it was fitted.
pub fn quantize(image: &mut ColorImage, max_colors: usize, grayscale: bool) -> Vec<[u8; 3]> {
    let n = image.width * image.height;
    if n == 0 {
        return Vec::new();
    }
    if grayscale {
        for i in 0..n {
            let y = luma8(image.get_pixel_at(i));
            image.set_pixel_at(i, &Color::new_rgba(y, y, y, 255));
        }
    }
    if max_colors == 0 {
        return Vec::new();
    }
    let stride = n.div_ceil(SAMPLE).max(1);
    let samples: Vec<[f64; 3]> = (0..n)
        .step_by(stride)
        .map(|i| rgb(image.get_pixel_at(i)))
        .collect();
    let mut palette = kmeans_palette(&samples, max_colors);
    if grayscale {
        // Keep the levels exactly grey after the mean.
        for c in &mut palette {
            let y = (c[0] + c[1] + c[2]) / 3.0;
            *c = [y, y, y];
        }
    }
    for i in 0..n {
        let k = nearest(&palette, rgb(image.get_pixel_at(i)));
        image.set_pixel_at(i, &to_color(palette[k]));
    }
    palette
        .iter()
        .map(|p| {
            let c = to_color(*p);
            [c.r, c.g, c.b]
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn image_of(colors: &[[u8; 3]], w: usize, h: usize) -> ColorImage {
        let mut image = ColorImage::new_w_h(w, h);
        for i in 0..w * h {
            let c = colors[i % colors.len()];
            image.set_pixel_at(i, &Color::new_rgba(c[0], c[1], c[2], 255));
        }
        image
    }

    #[test]
    fn a_palette_never_has_more_colours_than_asked() {
        let colors: Vec<[u8; 3]> = (0..40u8).map(|i| [i * 6, 255 - i * 6, i * 3]).collect();
        let mut image = image_of(&colors, 40, 10);
        let palette = quantize(&mut image, 3, false);
        assert_eq!(palette.len(), 3);
        let mut seen = std::collections::BTreeSet::new();
        for i in 0..400 {
            let c = image.get_pixel_at(i);
            seen.insert([c.r, c.g, c.b]);
        }
        assert!(seen.len() <= 3, "{} distinct colours", seen.len());
    }

    #[test]
    fn fewer_distinct_colours_than_asked_give_fewer_colours() {
        let mut image = image_of(&[[0, 0, 0], [255, 255, 255]], 8, 8);
        let palette = quantize(&mut image, 6, false);
        assert_eq!(palette.len(), 2);
    }

    #[test]
    fn the_palette_is_deterministic() {
        let colors: Vec<[u8; 3]> = (0..97u32)
            .map(|i| {
                [
                    (i * 37 % 256) as u8,
                    (i * 91 % 256) as u8,
                    (i * 13 % 256) as u8,
                ]
            })
            .collect();
        let a = quantize(&mut image_of(&colors, 97, 7), 6, false);
        let b = quantize(&mut image_of(&colors, 97, 7), 6, false);
        assert_eq!(a, b);
    }

    #[test]
    fn grayscale_levels_are_grey() {
        let mut image = image_of(&[[255, 0, 0], [0, 255, 0], [0, 0, 255], [9, 9, 9]], 4, 4);
        let palette = quantize(&mut image, 4, true);
        assert!(!palette.is_empty());
        for c in palette {
            assert_eq!(c[0], c[1]);
            assert_eq!(c[1], c[2]);
        }
        for i in 0..16 {
            let c = image.get_pixel_at(i);
            assert_eq!((c.r, c.g), (c.g, c.b));
        }
    }
}
