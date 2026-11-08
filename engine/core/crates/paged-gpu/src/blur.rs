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

//! The SVG filter's large-σ blur: five box passes (`paged_kernels::blur`)
//! sized to a Gaussian. The exact Gaussians and the box pass themselves
//! are `paged_kernels::blur`, shared with the effects lane and the masks
//! (engine ADR 1013, amendment "Blur").

use paged_kernels::blur::{self, Edge, Round};

/// Five centred boxes whose successive blurs approximate a Gaussian of
/// `sigma` px: odd widths `wl` and `wl + 2`, as many of each as makes
/// their variances sum to σ² (Kovesi, "Fast almost-Gaussian filtering").
/// The Filter Effects specification allows any approximation and
/// describes three boxes; five follow the Gaussian about twice as
/// closely, at the same linear cost. Each box is its `(left, right)`
/// reach around the output pixel.
fn gauss_boxes(sigma: f32) -> [(usize, usize); 5] {
    const N: f32 = 5.0;
    let ideal = (12.0 * sigma * sigma / N + 1.0).sqrt();
    let mut wl = ideal.floor() as i32;
    if wl % 2 == 0 {
        wl -= 1;
    }
    let wl = wl.max(1);
    let wlf = wl as f32;
    let m = ((12.0 * sigma * sigma - N * wlf * wlf - 4.0 * N * wlf - 3.0 * N) / (-4.0 * wlf - 4.0))
        .round()
        .clamp(0.0, N) as usize;
    std::array::from_fn(|i| {
        let r = if i < m { (wl - 1) / 2 } else { (wl + 1) / 2 } as usize;
        (r, r)
    })
}

/// A Gaussian of σ ≥ 2 px, approximated by five box blurs per axis, over
/// a premultiplied RGBA8 buffer, transparent beyond it. Linear in σ,
/// where the kernel above grows with it. A σ of 0 leaves that axis
/// alone.
pub(crate) fn box_blur_premul(
    data: &mut [u8],
    width: u32,
    height: u32,
    sigma_x: f32,
    sigma_y: f32,
) {
    for (sigma, horizontal) in [(sigma_x, true), (sigma_y, false)] {
        if sigma <= 0.0 {
            continue;
        }
        for reach in gauss_boxes(sigma) {
            blur::box_pass::<4>(
                data,
                width,
                height,
                horizontal,
                reach,
                Edge::Transparent,
                Round::Nearest,
            );
        }
    }
}

#[cfg(all(test, feature = "svg"))]
mod tests {
    use super::*;

    #[test]
    fn the_boxes_add_up_to_the_gaussians_variance() {
        // A box of width w has variance (w² − 1) / 12.
        for sigma in [4.0f32, 4.5, 6.0, 8.0, 20.0] {
            let var: f32 = gauss_boxes(sigma)
                .iter()
                .map(|&(l, r)| {
                    let w = (l + r + 1) as f32;
                    (w * w - 1.0) / 12.0
                })
                .sum();
            let rel = (var - sigma * sigma).abs() / (sigma * sigma);
            assert!(rel < 0.05, "σ {sigma}: variance {var}");
        }
    }

    #[test]
    fn a_box_blur_keeps_the_ink_and_spreads_it_evenly() {
        // A single opaque pixel in the middle of a 41 × 1 row.
        let mut row = vec![0u8; 41 * 4];
        row[20 * 4..20 * 4 + 4].copy_from_slice(&[255; 4]);
        box_blur_premul(&mut row, 41, 1, 4.0, 0.0);
        let alpha: Vec<u32> = row.chunks(4).map(|p| p[3] as u32).collect();
        let total: u32 = alpha.iter().sum();
        assert!((240..=270).contains(&total), "{total}");
        for i in 0..20 {
            assert_eq!(alpha[20 - i], alpha[20 + i], "symmetric at {i}");
        }
        assert!(alpha[20] > alpha[24] && alpha[24] > alpha[28]);
    }
}
