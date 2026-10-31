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

//! Colour maths without a profile (PM-0014, shared capability C4): the
//! sRGB transfer curve, the naive CMYK conversion, HSB. One definition
//! for the engine; the CMS uses the same curve and naive CMYK.

/// sRGB-encoded `c` (0..=1) in linear light (the sRGB EOTF).
pub fn srgb_to_linear(c: f32) -> f32 {
    if c <= 0.040_45 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
}

/// Linear light `c` as sRGB-encoded (the sRGB OETF, the inverse of
/// [`srgb_to_linear`]). Not clamped: a scene-referred value above 1 stays
/// above 1 (the caller clamps for a display); below 0 answers 0.
pub fn linear_to_srgb(c: f32) -> f32 {
    if c <= 0.003_130_8 {
        c.max(0.0) * 12.92
    } else {
        1.055 * c.powf(1.0 / 2.4) - 0.055
    }
}

/// CMYK (each 0..=1) as sRGB-encoded RGB, multiplicatively: the
/// conversion the engine uses wherever no CMYK profile is configured.
pub fn naive_cmyk_to_srgb(c: f32, m: f32, y: f32, k: f32) -> [f32; 3] {
    [
        (1.0 - c) * (1.0 - k),
        (1.0 - m) * (1.0 - k),
        (1.0 - y) * (1.0 - k),
    ]
}

/// HSB (hue, saturation, brightness, each 0..=1) as RGB.
pub fn hsb_to_rgb(h: f64, s: f64, b: f64) -> [f64; 3] {
    let h = (h.clamp(0.0, 1.0) * 6.0) % 6.0;
    let (s, v) = (s.clamp(0.0, 1.0), b.clamp(0.0, 1.0));
    let k = h.floor();
    let f = h - k;
    let (p, q, t) = (v * (1.0 - s), v * (1.0 - s * f), v * (1.0 - s * (1.0 - f)));
    match k as i32 {
        0 => [v, t, p],
        1 => [q, v, p],
        2 => [p, v, t],
        3 => [p, q, v],
        4 => [t, p, v],
        _ => [v, p, q],
    }
}

/// RGB (each 0..=1) as HSB.
pub fn rgb_to_hsb([r, g, b]: [f64; 3]) -> [f64; 3] {
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let d = max - min;
    let s = if max > 0.0 { d / max } else { 0.0 };
    let h = if d == 0.0 {
        0.0
    } else if max == r {
        ((g - b) / d).rem_euclid(6.0) / 6.0
    } else if max == g {
        ((b - r) / d + 2.0) / 6.0
    } else {
        ((r - g) / d + 4.0) / 6.0
    };
    [h, s, max]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hsb_round_trips_and_cmyk_is_multiplicative() {
        for rgb in [[1.0, 0.0, 0.0], [0.2, 0.6, 0.4], [0.5, 0.5, 0.5]] {
            let [h, s, b] = rgb_to_hsb(rgb);
            let back = hsb_to_rgb(h, s, b);
            for k in 0..3 {
                assert!((back[k] - rgb[k]).abs() < 1e-9);
            }
        }
        assert_eq!(naive_cmyk_to_srgb(0.0, 0.0, 0.0, 1.0), [0.0, 0.0, 0.0]);
        assert_eq!(naive_cmyk_to_srgb(0.5, 0.0, 0.0, 0.5), [0.25, 0.5, 0.5]);
        assert_eq!(srgb_to_linear(1.0), 1.0);
        for i in 0..=255 {
            let v = i as f32 / 255.0;
            assert!((linear_to_srgb(srgb_to_linear(v)) - v).abs() < 1e-5);
        }
        assert_eq!(linear_to_srgb(-0.5), 0.0);
        assert!(linear_to_srgb(2.0) > 1.0, "scene-referred stays above 1");
    }
}
