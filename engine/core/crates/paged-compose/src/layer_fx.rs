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

//! The per-pixel layer effects of the effect stack (engine ADR 1008):
//! [`LayerEffect::Noise`] and [`LayerEffect::ColorAdjust`], applied to an
//! effect layer's premultiplied RGBA8 buffer when it pops.
//!
//! One definition for every lane: the CPU rasterizer runs it on its layer
//! buffer, the GPU lane on the CPU raster of the layer it composites, and
//! the PDF writer on the raster it embeds — so the three agree pixel for
//! pixel at one resolution.
//!
//! The formulas are the engine's minimal set, on sRGB-encoded,
//! un-premultiplied channels. The image module's adjustment kernels are
//! not a dependency of the engine; when the shared kernel crate lands
//! (plan C1/C4) these move onto its CPU twins.

use crate::LayerEffect;

/// Grain cells per pt: the noise is hashed on a 0.25 pt page-space grid,
/// sampled at each pixel's centre, so its pattern stays put on the page
/// across zoom levels and lanes.
const NOISE_CELLS_PER_PT: f32 = 4.0;

/// Apply a per-pixel layer effect to `data`, a `w`×`h` premultiplied RGBA8
/// buffer whose top-left pixel sits at `origin_px` page pixels, at
/// `px_per_pt` pixels per pt. Returns `false` (and leaves `data`) for an
/// effect that is not per-pixel (`None`, the blur).
pub fn apply_premul(
    data: &mut [u8],
    w: u32,
    h: u32,
    origin_px: (i32, i32),
    px_per_pt: f32,
    effect: &LayerEffect,
) -> bool {
    match *effect {
        LayerEffect::Noise {
            amount,
            monochromatic,
        } => {
            noise(data, w, h, origin_px, px_per_pt, amount, monochromatic);
            true
        }
        LayerEffect::ColorAdjust {
            brightness,
            contrast,
            saturation,
            hue_deg,
        } => {
            let adj = Adjust {
                brightness: brightness.clamp(-1.0, 1.0),
                contrast: contrast.clamp(-1.0, 1.0),
                saturation: saturation.clamp(-1.0, 1.0),
                hue_deg,
            };
            if !adj.is_identity() {
                for px in data.chunks_exact_mut(4) {
                    map_pixel(px, |rgb| adj.apply(rgb));
                }
            }
            true
        }
        _ => false,
    }
}

/// Whether `effect` is one [`apply_premul`] handles.
pub fn is_per_pixel(effect: &LayerEffect) -> bool {
    matches!(
        effect,
        LayerEffect::Noise { .. } | LayerEffect::ColorAdjust { .. }
    )
}

/// Un-premultiply, map the colour, premultiply again. A clear pixel stays
/// clear.
fn map_pixel(px: &mut [u8], f: impl FnOnce([f32; 3]) -> [f32; 3]) {
    let a = px[3];
    if a == 0 {
        return;
    }
    let af = a as f32 / 255.0;
    let un = |v: u8| ((v as f32 / 255.0) / af).clamp(0.0, 1.0);
    let out = f([un(px[0]), un(px[1]), un(px[2])]);
    for c in 0..3 {
        px[c] = (out[c].clamp(0.0, 1.0) * af * 255.0).round() as u8;
    }
}

fn hash(x: i32, y: i32, salt: u32) -> f32 {
    let k = (x as u32).wrapping_mul(73_856_093)
        ^ (y as u32).wrapping_mul(19_349_663)
        ^ salt.wrapping_mul(83_492_791);
    let k = k.wrapping_mul(2_654_435_761);
    let k = k ^ (k >> 15);
    (k.wrapping_mul(2_246_822_519) >> 8) as f32 / 16_777_215.0
}

fn noise(
    data: &mut [u8],
    w: u32,
    h: u32,
    origin_px: (i32, i32),
    px_per_pt: f32,
    amount: f32,
    monochromatic: bool,
) {
    let amount = amount.clamp(0.0, 1.0);
    if amount <= 0.0 || w == 0 {
        return;
    }
    let cells = NOISE_CELLS_PER_PT / px_per_pt.max(1e-6);
    for y in 0..h {
        let cy = ((origin_px.1 + y as i32) as f32 + 0.5) * cells;
        for x in 0..w {
            let i = ((y * w + x) * 4) as usize;
            let cx = ((origin_px.0 + x as i32) as f32 + 0.5) * cells;
            let (gx, gy) = (cx.floor() as i32, cy.floor() as i32);
            let d = |salt| (hash(gx, gy, salt) * 2.0 - 1.0) * amount;
            let deltas = if monochromatic {
                let v = d(0);
                [v, v, v]
            } else {
                [d(1), d(2), d(3)]
            };
            map_pixel(&mut data[i..i + 4], |rgb| {
                [rgb[0] + deltas[0], rgb[1] + deltas[1], rgb[2] + deltas[2]]
            });
        }
    }
}

/// The colour adjustment's parameters, normalised.
#[derive(Debug, Clone, Copy)]
pub struct Adjust {
    pub brightness: f32,
    pub contrast: f32,
    pub saturation: f32,
    pub hue_deg: f32,
}

impl Adjust {
    pub fn is_identity(&self) -> bool {
        self.brightness == 0.0
            && self.contrast == 0.0
            && self.saturation == 0.0
            && self.hue_deg.rem_euclid(360.0) == 0.0
    }

    /// Brightness shifts every channel by half its value; contrast scales
    /// about mid-grey by `1 + c` below zero and `1 / (1 − c)` above it (so
    /// +1 is a threshold); then hue rotates and saturation scales in HSL.
    pub fn apply(&self, rgb: [f32; 3]) -> [f32; 3] {
        let k = if self.contrast >= 0.0 {
            1.0 / (1.0 - self.contrast.min(0.99))
        } else {
            1.0 + self.contrast
        };
        let b = self.brightness * 0.5;
        let mut c = rgb.map(|v| ((v - 0.5) * k + 0.5 + b).clamp(0.0, 1.0));
        if self.saturation != 0.0 || self.hue_deg.rem_euclid(360.0) != 0.0 {
            let (hh, s, l) = rgb_to_hsl(c);
            let s = if self.saturation >= 0.0 {
                s + (1.0 - s) * self.saturation * s.min(1.0)
            } else {
                s * (1.0 + self.saturation)
            };
            let hh = (hh + self.hue_deg / 360.0).rem_euclid(1.0);
            c = hsl_to_rgb(hh, s.clamp(0.0, 1.0), l);
        }
        c
    }
}

/// HSL with every component in 0..=1.
pub fn rgb_to_hsl([r, g, b]: [f32; 3]) -> (f32, f32, f32) {
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let l = (max + min) / 2.0;
    let d = max - min;
    if d <= f32::EPSILON {
        return (0.0, 0.0, l);
    }
    let s = if l > 0.5 {
        d / (2.0 - max - min)
    } else {
        d / (max + min)
    };
    let h = if max == r {
        (g - b) / d + if g < b { 6.0 } else { 0.0 }
    } else if max == g {
        (b - r) / d + 2.0
    } else {
        (r - g) / d + 4.0
    };
    (h / 6.0, s, l)
}

pub fn hsl_to_rgb(h: f32, s: f32, l: f32) -> [f32; 3] {
    if s <= 0.0 {
        return [l, l, l];
    }
    let q = if l < 0.5 {
        l * (1.0 + s)
    } else {
        l + s - l * s
    };
    let p = 2.0 * l - q;
    let f = |t: f32| {
        let t = t.rem_euclid(1.0);
        if t < 1.0 / 6.0 {
            p + (q - p) * 6.0 * t
        } else if t < 0.5 {
            q
        } else if t < 2.0 / 3.0 {
            p + (q - p) * (2.0 / 3.0 - t) * 6.0
        } else {
            p
        }
    };
    [f(h + 1.0 / 3.0), f(h), f(h - 1.0 / 3.0)]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid(rgba: [u8; 4], n: usize) -> Vec<u8> {
        rgba.iter().copied().cycle().take(n * 4).collect()
    }

    #[test]
    fn an_identity_adjustment_changes_nothing() {
        let mut d = solid([200, 100, 50, 255], 4);
        let before = d.clone();
        let e = LayerEffect::ColorAdjust {
            brightness: 0.0,
            contrast: 0.0,
            saturation: 0.0,
            hue_deg: 0.0,
        };
        assert!(apply_premul(&mut d, 2, 2, (0, 0), 1.0, &e));
        assert_eq!(d, before);
    }

    #[test]
    fn full_desaturation_is_grey_and_keeps_alpha() {
        let mut d = solid([128, 0, 0, 128], 1);
        apply_premul(
            &mut d,
            1,
            1,
            (0, 0),
            1.0,
            &LayerEffect::ColorAdjust {
                brightness: 0.0,
                contrast: 0.0,
                saturation: -1.0,
                hue_deg: 0.0,
            },
        );
        assert_eq!(d[0], d[1]);
        assert_eq!(d[1], d[2]);
        assert_eq!(d[3], 128);
    }

    #[test]
    fn a_hue_turn_of_120_degrees_takes_red_to_green() {
        let out = Adjust {
            brightness: 0.0,
            contrast: 0.0,
            saturation: 0.0,
            hue_deg: 120.0,
        }
        .apply([1.0, 0.0, 0.0]);
        assert!(out[1] > 0.99 && out[0] < 0.01 && out[2] < 0.01, "{out:?}");
    }

    #[test]
    fn brightness_and_contrast_move_mid_grey_as_documented() {
        let a = Adjust {
            brightness: 0.5,
            contrast: 0.0,
            saturation: 0.0,
            hue_deg: 0.0,
        };
        assert!((a.apply([0.5; 3])[0] - 0.75).abs() < 1e-6);
        let c = Adjust {
            brightness: 0.0,
            contrast: 0.5,
            saturation: 0.0,
            hue_deg: 0.0,
        };
        assert!((c.apply([0.75; 3])[0] - 1.0).abs() < 1e-6);
    }

    #[test]
    fn noise_is_bounded_page_anchored_and_spares_clear_pixels() {
        let e = LayerEffect::Noise {
            amount: 0.1,
            monochromatic: true,
        };
        let mut a = solid([128, 128, 128, 255], 16);
        apply_premul(&mut a, 4, 4, (10, 10), 4.0, &e);
        for px in a.chunks(4) {
            assert!((px[0] as i32 - 128).abs() <= 26, "{px:?}");
            assert_eq!(px[0], px[1]);
        }
        assert!(a.chunks(4).any(|p| p[0] != 128));
        // The same page pixels in a buffer placed elsewhere carry the same
        // grain: pixel (11, 11) of `a` is pixel (0, 0) of `b`.
        let mut b = solid([128, 128, 128, 255], 1);
        apply_premul(&mut b, 1, 1, (11, 11), 4.0, &e);
        assert_eq!(&b[..4], &a[(4 + 1) * 4..(4 + 1) * 4 + 4]);
        let mut clear = solid([0, 0, 0, 0], 4);
        apply_premul(&mut clear, 2, 2, (0, 0), 1.0, &e);
        assert!(clear.iter().all(|v| *v == 0));
    }
}
