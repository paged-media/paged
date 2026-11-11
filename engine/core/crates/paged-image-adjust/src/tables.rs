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

//! Photoshop's 8-bit tables (engine ADR 1037, amendment 2026-11-11): the
//! Levels, Exposure (with offset and gamma) and Curves of an adjustment are
//! evaluated as 256-entry tables, measured against Photoshop-written layers
//! by paged.image (Levels within 2 levels, channel then composite;
//! Exposure within 1 level). They moved here from paged.image's typed
//! adjustment model so that the engine's filter stack and the image
//! module's GPU chain read one table: they are the reference both are held
//! to.

use paged_model::{GradientMapStop, LevelsRecord};

/// A level given as a fraction, in Photoshop's 0..=255: a value within a
/// thousandth of a level of an integer is that integer, so a level that
/// came from a file's integer (or the panel's) is evaluated exactly as it.
fn level(v: f32) -> f64 {
    let x = f64::from(v) * 255.0;
    if (x - x.round()).abs() < 1e-3 {
        x.round()
    } else {
        x
    }
}

/// One Levels record as a 256-entry table: the input range normalised,
/// raised to 1/gamma, mapped onto the output range (Photoshop's order). The
/// gamma is taken at Photoshop's two decimals, so a value that came from a
/// file's ×100 integer is evaluated exactly as that integer.
pub fn levels_table(r: &LevelsRecord) -> [u8; 256] {
    let (ib, iw) = (level(r.in_black), level(r.in_white));
    let (ob, ow) = (level(r.out_black), level(r.out_white));
    let g = ((f64::from(r.gamma) * 100.0).round() / 100.0).max(0.01);
    let mut lut = [0u8; 256];
    for (x, slot) in lut.iter_mut().enumerate() {
        let t = ((x as f64 - ib) / (iw - ib).max(1.0)).clamp(0.0, 1.0);
        *slot = (ob + t.powf(1.0 / g) * (ow - ob)).round().clamp(0.0, 255.0) as u8;
    }
    lut
}

/// Photoshop's Exposure as a table: the code decoded to light with a 2.2
/// power, scaled by 2^exposure, offset, raised to 1/gamma, re-encoded.
/// Measured on a Photoshop-written layer (exposure 0.4, offset −0.03,
/// gamma 1.2): within 1 level.
pub fn exposure_table(exposure: f32, offset: f32, gamma: f32) -> [u8; 256] {
    let (e, o, g) = (
        f64::from(exposure),
        f64::from(offset),
        f64::from(gamma).max(0.01),
    );
    let mut lut = [0u8; 256];
    for (x, slot) in lut.iter_mut().enumerate() {
        let light = (x as f64 / 255.0).powf(2.2) * e.exp2() + o;
        let v = light.max(0.0).powf(1.0 / g).min(1.0).powf(1.0 / 2.2);
        *slot = (v * 255.0).round().clamp(0.0, 255.0) as u8;
    }
    lut
}

/// A curve as a table — Photoshop's natural cubic spline through `points`
/// (`[input, output]`, 0..=1).
pub fn curve_table(points: &[[f32; 2]]) -> [u8; 256] {
    let pts: Vec<(f32, f32)> = points.iter().map(|p| (p[0], p[1])).collect();
    paged_pixel::curve_lut_natural(&pts)
}

/// The identity table.
pub fn identity_table() -> [u8; 256] {
    std::array::from_fn(|i| i as u8)
}

/// The 256-entry RGB ramp of a gradient map's stops (sorted by position,
/// linear between them, flat beyond the ends), reversed when asked.
pub fn gradient_ramp(stops: &[GradientMapStop], reverse: bool) -> [[f32; 3]; 256] {
    let mut s: Vec<GradientMapStop> = stops.to_vec();
    s.sort_by(|a, b| a.at.total_cmp(&b.at));
    let mut out = [[0.0f32; 3]; 256];
    if s.is_empty() {
        for (i, e) in out.iter_mut().enumerate() {
            *e = [i as f32 / 255.0; 3];
        }
        return out;
    }
    for (i, e) in out.iter_mut().enumerate() {
        let t = i as f32 / 255.0;
        let t = if reverse { 1.0 - t } else { t };
        let first = s[0];
        let last = s[s.len() - 1];
        *e = if t <= first.at {
            first.color
        } else if t >= last.at {
            last.color
        } else {
            let k = s.windows(2).position(|w| t >= w[0].at && t <= w[1].at);
            match k {
                Some(k) => {
                    let (a, b) = (s[k], s[k + 1]);
                    let span = (b.at - a.at).max(f32::EPSILON);
                    let f = (t - a.at) / span;
                    [0, 1, 2].map(|c| a.color[c] + (b.color[c] - a.color[c]) * f)
                }
                None => last.color,
            }
        };
    }
    out
}

/// The identity colour cube of edge `size` (red fastest).
pub fn identity_cube(size: usize) -> Vec<f32> {
    let n = (size.max(2) - 1) as f32;
    let mut v = Vec::with_capacity(size * size * size * 3);
    for b in 0..size {
        for g in 0..size {
            for r in 0..size {
                v.extend_from_slice(&[r as f32 / n, g as f32 / n, b as f32 / n]);
            }
        }
    }
    v
}

/// A colour cube resampled to edge `to` (trilinear), the cube a kernel of a
/// fixed edge evaluates a look of another size through.
pub fn resample_cube(cube: &[f32], size: usize, to: usize) -> Vec<f32> {
    if size == to {
        return cube.to_vec();
    }
    let id = identity_cube(to);
    id.as_chunks::<3>()
        .0
        .iter()
        .flat_map(|c| {
            let p = paged_kernels::cpu::lut3d_cube(
                paged_kernels::Px([c[0], c[1], c[2], 1.0]),
                cube,
                size,
            );
            [p.0[0], p.0[1], p.0[2]]
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_level_given_as_a_fraction_is_its_integer() {
        for k in 0..=255u16 {
            assert_eq!(level(f32::from(k) / 255.0), f64::from(k), "{k}");
        }
    }

    #[test]
    fn the_identity_tables_are_the_identity() {
        assert_eq!(levels_table(&LevelsRecord::IDENTITY), identity_table());
        assert_eq!(exposure_table(0.0, 0.0, 1.0), identity_table());
        assert_eq!(curve_table(&[[0.0, 0.0], [1.0, 1.0]]), identity_table());
    }
}
