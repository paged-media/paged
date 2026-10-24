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

//! Whole-factor box shrink, for decodes capped at a longest edge.

use crate::Samples;

/// The whole factor a `width` x `height` image is shrunk by so that its
/// longer edge is at most `max_dim` (1 when it already fits).
pub(crate) fn factor(width: u32, height: u32, max_dim: Option<u32>) -> u32 {
    match max_dim {
        Some(max) if max > 0 && width.max(height) > max => width.max(height).div_ceil(max),
        _ => 1,
    }
}

/// The size a decode capped at `max_dim` returns for a `width` x `height`
/// image: each edge divided by the shrink factor, rounded up.
pub fn shrunk_dimensions(width: u32, height: u32, max_dim: Option<u32>) -> (u32, u32) {
    let k = factor(width, height, max_dim);
    (width.div_ceil(k), height.div_ceil(k))
}

/// Average `k` x `k` boxes of an interleaved `channels`-sample image. The
/// boxes at the right and bottom edge average the pixels they cover.
pub(crate) fn shrink(
    data: Samples,
    width: u32,
    height: u32,
    channels: usize,
    k: u32,
) -> (Samples, u32, u32) {
    if k <= 1 {
        return (data, width, height);
    }
    let (out_w, out_h) = (width.div_ceil(k), height.div_ceil(k));
    let sums = box_sums(&data, width as usize, height as usize, channels, k as usize);
    let out = match data {
        Samples::U8(_) => Samples::U8(sums.iter().map(|v| v.round() as u8).collect()),
        Samples::U16(_) => Samples::U16(sums.iter().map(|v| v.round() as u16).collect()),
        Samples::F32(_) => Samples::F32(sums),
    };
    (out, out_w, out_h)
}

fn box_sums(data: &Samples, w: usize, h: usize, channels: usize, k: usize) -> Vec<f32> {
    let raw = |i: usize| -> f32 {
        match data {
            Samples::U8(v) => f32::from(v[i]),
            Samples::U16(v) => f32::from(v[i]),
            Samples::F32(v) => v[i],
        }
    };
    let (out_w, out_h) = (w.div_ceil(k), h.div_ceil(k));
    let mut out = vec![0.0f32; out_w * out_h * channels];
    let mut acc = vec![0.0f64; channels];
    for oy in 0..out_h {
        let y1 = ((oy + 1) * k).min(h);
        for ox in 0..out_w {
            let x1 = ((ox + 1) * k).min(w);
            acc.iter_mut().for_each(|a| *a = 0.0);
            let mut n = 0u32;
            for y in oy * k..y1 {
                for x in ox * k..x1 {
                    let base = (y * w + x) * channels;
                    for (c, a) in acc.iter_mut().enumerate() {
                        *a += f64::from(raw(base + c));
                    }
                    n += 1;
                }
            }
            let dst = (oy * out_w + ox) * channels;
            for (c, a) in acc.iter().enumerate() {
                out[dst + c] = (*a / f64::from(n)) as f32;
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dimensions() {
        assert_eq!(shrunk_dimensions(100, 50, None), (100, 50));
        assert_eq!(shrunk_dimensions(100, 50, Some(100)), (100, 50));
        assert_eq!(shrunk_dimensions(101, 50, Some(100)), (51, 25));
        assert_eq!(shrunk_dimensions(9000, 5760, Some(4096)), (3000, 1920));
    }

    #[test]
    fn averages_boxes() {
        let data = Samples::U8(vec![0, 10, 20, 30, 40, 50, 60, 70, 80]);
        let (out, w, h) = shrink(data, 3, 3, 1, 2);
        assert_eq!((w, h), (2, 2));
        assert_eq!(out, Samples::U8(vec![20, 35, 65, 80]));
    }
}
