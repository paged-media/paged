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

//! Gradient stop interpolation, once for every consumer: the effect
//! masks (`mask`), the CPU rasteriser's gradient feather, the renderer's
//! stroke bands (engine ADR 1007) and the GPU lane's sweep re-basing.
//!
//! A ramp's colour blends in sRGB-encoded values, the way both
//! rasterisers (peniko) and the PDF shading blend a gradient's stops; its
//! alpha blends linearly and apart from the colour (unpremultiplied).

use crate::{Color, GradientStop};

/// An alpha ramp `(location, alpha)` sampled at `t` (0..=1), linearly
/// between stops and padded past both ends. Empty is opaque.
pub fn sample_alpha(stops: &[(f32, f32)], t: f32) -> f32 {
    if stops.is_empty() {
        return 1.0;
    }
    if t <= stops[0].0 {
        return stops[0].1;
    }
    if t >= stops[stops.len() - 1].0 {
        return stops[stops.len() - 1].1;
    }
    for w in stops.windows(2) {
        let (l0, a0) = w[0];
        let (l1, a1) = w[1];
        if t >= l0 && t <= l1 {
            let span = (l1 - l0).max(1e-6);
            return a0 + (a1 - a0) * ((t - l0) / span);
        }
    }
    stops[stops.len() - 1].1
}

/// A colour ramp (stops sorted by offset) sampled at `t`, padded past
/// both ends: its colour blended in sRGB-encoded values, its alpha
/// linearly. Empty is opaque black.
pub fn sample_ramp(stops: &[GradientStop], t: f32) -> Color {
    let Some(first) = stops.first() else {
        return Color::BLACK;
    };
    if t <= first.offset {
        return first.color;
    }
    for w in stops.windows(2) {
        let (a, b) = (w[0], w[1]);
        if t <= b.offset {
            let span = b.offset - a.offset;
            let f = if span > 1e-6 {
                (t - a.offset) / span
            } else {
                1.0
            };
            let mix = |x: f32, y: f32| {
                let (x, y) = (srgb_encode(x), srgb_encode(y));
                srgb_decode(x + (y - x) * f)
            };
            return Color::rgba(
                mix(a.color.r, b.color.r),
                mix(a.color.g, b.color.g),
                mix(a.color.b, b.color.b),
                a.color.a + (b.color.a - a.color.a) * f,
            );
        }
    }
    stops[stops.len() - 1].color
}

/// Linear light → the sRGB-encoded value (0..=1, clamped).
pub fn srgb_encode(v: f32) -> f32 {
    let v = v.clamp(0.0, 1.0);
    if v <= 0.003_130_8 {
        12.92 * v
    } else {
        1.055 * v.powf(1.0 / 2.4) - 0.055
    }
}

/// An sRGB-encoded value → linear light.
pub fn srgb_decode(v: f32) -> f32 {
    if v <= 0.040_45 {
        v / 12.92
    } else {
        ((v + 0.055) / 1.055).powf(2.4)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn alpha_is_linear_and_padded() {
        let s = [(0.2, 1.0), (0.8, 0.0)];
        assert_eq!(sample_alpha(&s, 0.0), 1.0);
        assert!((sample_alpha(&s, 0.5) - 0.5).abs() < 1e-6);
        assert_eq!(sample_alpha(&s, 1.0), 0.0);
        assert_eq!(sample_alpha(&[], 0.3), 1.0);
    }

    #[test]
    fn colour_blends_in_srgb_values_and_alpha_apart() {
        let stops = [
            GradientStop {
                offset: 0.0,
                color: Color::rgba(1.0, 0.0, 0.0, 1.0),
            },
            GradientStop {
                offset: 1.0,
                color: Color::rgba(0.0, 0.0, 1.0, 0.0),
            },
        ];
        let c = sample_ramp(&stops, 0.5);
        assert!((c.r - srgb_decode(0.5)).abs() < 1e-5);
        assert!((c.b - srgb_decode(0.5)).abs() < 1e-5);
        assert!((c.a - 0.5).abs() < 1e-6);
    }
}
