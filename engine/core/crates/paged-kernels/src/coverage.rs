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

//! The 8-bit polygon coverage of paged.image's selections (engine ADR 1013,
//! amendment "Coverage"): the lasso, the region filter's polygons and every
//! other polygon selection fill through [`polygons`].
//!
//! Four sub-scanlines per pixel row, each crossed with every edge (half-open
//! in y, so a vertex on the scanline counts once); the inside spans add their
//! analytic x-coverage at a quarter each, in f32, rounded once at the end.

/// Which crossings of a scanline are inside.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FillRule {
    NonZero,
    EvenOdd,
}

/// The coverage of closed `polygons` filled together as one path under
/// `rule`, `width · height` bytes row-major (0 outside, 255 inside). A
/// polygon of fewer than three points adds nothing.
pub fn polygons(width: u32, height: u32, polygons: &[&[(f32, f32)]], rule: FillRule) -> Vec<u8> {
    let mut acc = vec![0.0f32; (width as usize) * (height as usize)];
    // (x, winding direction) per crossing of one sub-scanline.
    let mut xs: Vec<(f32, i32)> = Vec::with_capacity(16);
    for y in 0..height {
        for sub in 0..4u32 {
            let sy = y as f32 + (sub as f32 * 2.0 + 1.0) / 8.0;
            xs.clear();
            for poly in polygons.iter().filter(|p| p.len() >= 3) {
                let n = poly.len();
                for i in 0..n {
                    let (x0, y0) = poly[i];
                    let (x1, y1) = poly[(i + 1) % n];
                    let dir = if y0 <= sy && sy < y1 {
                        1
                    } else if y1 <= sy && sy < y0 {
                        -1
                    } else {
                        continue;
                    };
                    let t = (sy - y0) / (y1 - y0);
                    xs.push((x0 + t * (x1 - x0), dir));
                }
            }
            xs.sort_by(|a, b| a.0.partial_cmp(&b.0).expect("finite intersections"));
            let mut winding = 0i32;
            for k in 0..xs.len() {
                winding += xs[k].1;
                let inside = match rule {
                    FillRule::NonZero => winding != 0,
                    FillRule::EvenOdd => (k + 1) % 2 == 1,
                };
                if !inside || k + 1 == xs.len() {
                    continue;
                }
                let (xa, xb) = (xs[k].0.max(0.0), xs[k + 1].0.min(width as f32));
                if xb <= xa {
                    continue;
                }
                let first = xa.floor() as u32;
                let last = (xb.ceil() as u32).min(width);
                for px in first..last {
                    let cover = (xb.min(px as f32 + 1.0) - xa.max(px as f32)).max(0.0);
                    acc[(y * width + px) as usize] += cover * 0.25;
                }
            }
        }
    }
    acc.iter()
        .map(|a| (a.clamp(0.0, 1.0) * 255.0).round() as u8)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `image_gpu::SelectionCoverage::rasterize_polygon`'s body as it was
    /// before it called [`polygons`], verbatim: the oracle of the move.
    fn lasso(width: u32, height: u32, points: &[(f32, f32)]) -> Vec<u8> {
        let mut data = vec![0u8; (width as usize) * (height as usize)];
        if points.len() < 3 {
            return data;
        }
        let n = points.len();
        let mut acc = vec![0.0f32; (width as usize) * (height as usize)];
        let mut xs: Vec<f32> = Vec::with_capacity(8);
        for y in 0..height {
            for sub in 0..4u32 {
                let sy = y as f32 + (sub as f32 * 2.0 + 1.0) / 8.0;
                xs.clear();
                for i in 0..n {
                    let (x0, y0) = points[i];
                    let (x1, y1) = points[(i + 1) % n];
                    if (y0 <= sy && sy < y1) || (y1 <= sy && sy < y0) {
                        let t = (sy - y0) / (y1 - y0);
                        xs.push(x0 + t * (x1 - x0));
                    }
                }
                xs.sort_by(|a, b| a.partial_cmp(b).expect("finite intersections"));
                for pair in xs.as_chunks::<2>().0 {
                    let (xa, xb) = (pair[0].max(0.0), pair[1].min(width as f32));
                    if xb <= xa {
                        continue;
                    }
                    let first = xa.floor() as u32;
                    let last = (xb.ceil() as u32).min(width);
                    for px in first..last {
                        let cover = (xb.min(px as f32 + 1.0) - xa.max(px as f32)).max(0.0);
                        acc[(y * width + px) as usize] += cover * 0.25;
                    }
                }
            }
        }
        for (dst, &a) in data.iter_mut().zip(acc.iter()) {
            *dst = (a.clamp(0.0, 1.0) * 255.0).round() as u8;
        }
        data
    }

    #[test]
    fn one_polygon_even_odd_is_the_lasso_byte_for_byte() {
        let star: Vec<(f32, f32)> = (0..7)
            .map(|k| {
                let a = std::f32::consts::PI * (0.5 + 6.0 / 7.0 * k as f32);
                (20.3 + 14.7 * a.cos(), 15.1 - 13.9 * a.sin())
            })
            .collect();
        let cases: [Vec<(f32, f32)>; 5] = [
            vec![(3.0, 3.0), (27.5, 21.0), (27.5, 3.0), (3.0, 21.0)],
            vec![(0.0, 0.0), (16.0, 0.0), (0.0, 16.0)],
            vec![(-5.0, 2.25), (45.5, 4.75), (12.125, 33.0)],
            vec![(0.0, 0.0), (3.0, 3.0)],
            star,
        ];
        for pts in &cases {
            assert_eq!(
                polygons(40, 30, &[pts.as_slice()], FillRule::EvenOdd),
                lasso(40, 30, pts),
                "{pts:?}"
            );
        }
    }

    #[test]
    fn non_zero_fills_a_star_centre_and_keeps_an_opposite_hole() {
        let star: Vec<(f32, f32)> = (0..5)
            .map(|k| {
                let a = std::f32::consts::PI * (0.5 + 0.8 * k as f32);
                (20.0 + 12.0 * a.cos(), 15.0 - 12.0 * a.sin())
            })
            .collect();
        let at = |c: &[u8], x: usize, y: usize| c[y * 40 + x];
        assert_eq!(
            at(&polygons(40, 30, &[&star], FillRule::NonZero), 20, 15),
            255
        );
        assert_eq!(
            at(&polygons(40, 30, &[&star], FillRule::EvenOdd), 20, 15),
            0
        );
        let outer = [(2.0, 2.0), (30.0, 2.0), (30.0, 28.0), (2.0, 28.0)];
        let hole = [(10.0, 10.0), (10.0, 20.0), (20.0, 20.0), (20.0, 10.0)];
        let c = polygons(40, 30, &[&outer, &hole], FillRule::NonZero);
        assert_eq!((at(&c, 5, 5), at(&c, 15, 15)), (255, 0));
    }
}
