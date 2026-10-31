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

//! The brush engine's COVERAGE pieces beyond the round tip: the oriented
//! tip (angle, roundness, flips, an optional bitmap), the texture and
//! dual-tip combine modes, and the [`Lowering`] that shapes accumulated
//! coverage on its way to the mask (dual tip, whole-stroke texture, wet
//! edges, noise).
//!
//! Like [`crate::dab`], everything here is MASK PREPARATION: no image
//! pixel is read or written. The coverage it produces is consumed by the
//! same registered kernel dispatches as every other stroke.
//!
//! # Conventions (recorded, and checked against Photoshop where a probe
//! # can reach them — `scripts/photoshop/probes/brush-strokes.jsx`)
//!
//! * **Angle** is in degrees, positive COUNTER-CLOCKWISE ON SCREEN. The
//!   image's y axis points down, so the tip's major axis runs along
//!   `(cos a, −sin a)` in image px.
//! * **Roundness** squashes the tip's minor axis — vertical at angle 0.
//! * A bitmap tip is MIRRORED first (in tip space), then squashed, then
//!   rotated.
//! * The combine modes ([`CombineKind`]) and the wet-edge and noise
//!   shapes are this engine's definitions, not measurements; each is
//!   stated where it is computed.

use std::sync::Arc;

use image_core::Region;

use crate::dab::{BrushTip, SampledTip, TipCoverage};

/// One dab's tip: a computed (elliptical) tip or a bitmap, at an angle,
/// squashed by a roundness, optionally mirrored.
#[derive(Debug, Clone, Copy)]
pub struct OrientedTip<'a> {
    pub diameter: f32,
    pub hardness: f32,
    /// `false` = the pencil's binary coverage.
    pub antialias: bool,
    /// Degrees, counter-clockwise on screen.
    pub angle_deg: f32,
    /// Minor/major axis ratio, `(0, 1]`.
    pub roundness: f32,
    pub flip_x: bool,
    pub flip_y: bool,
    /// The sampled tip, or `None` for the computed round/elliptical tip.
    pub bitmap: Option<&'a SampledTip>,
}

impl OrientedTip<'_> {
    /// Is this exactly the round [`BrushTip`] (no angle, no squash, no
    /// bitmap)? The stamp then goes through the round tip itself, so a
    /// stroke with every dynamics pane off is bit-identical to one
    /// painted before the panes existed.
    pub fn is_round(&self) -> bool {
        self.bitmap.is_none() && self.roundness >= 1.0 && self.angle_deg.rem_euclid(360.0) == 0.0
    }

    pub fn round(&self) -> BrushTip {
        BrushTip {
            diameter: self.diameter,
            hardness: self.hardness,
            antialias: self.antialias,
        }
    }

    fn roundness(&self) -> f32 {
        if self.roundness.is_finite() {
            self.roundness.clamp(0.01, 1.0)
        } else {
            1.0
        }
    }

    /// Image-px offset from the dab centre → tip space (un-rotated).
    fn tip_offset(&self, dx: f32, dy: f32) -> (f32, f32) {
        let a = self.angle_deg.to_radians();
        let (s, c) = a.sin_cos();
        // Inverse of x = tx·c + ty·s, y = −tx·s + ty·c.
        (dx * c - dy * s, dx * s + dy * c)
    }
}

impl TipCoverage for OrientedTip<'_> {
    fn coverage_at_pixel(&self, cx: f32, cy: f32, px: u32, py: u32) -> f32 {
        if self.is_round() {
            return self.round().coverage_at_pixel(cx, cy, px, py);
        }
        let dx = (px as f32 + 0.5) - cx;
        let dy = (py as f32 + 0.5) - cy;
        let (mut tx, mut ty) = self.tip_offset(dx, dy);
        let r = self.roundness();
        match self.bitmap {
            Some(bmp) => {
                bmp.coverage_in_tip_space(tx, ty, self.diameter, r, self.flip_x, self.flip_y)
            }
            None => {
                // An ellipse is symmetric, so the mirrors change nothing.
                if self.flip_x {
                    tx = -tx;
                }
                if self.flip_y {
                    ty = -ty;
                }
                let d = (tx * tx + (ty / r) * (ty / r)).sqrt();
                self.round().coverage_at_distance(d)
            }
        }
    }

    fn dab_bounds(&self, cx: f32, cy: f32, w: u32, h: u32) -> Option<Region> {
        if self.is_round() {
            return self.round().dab_bounds(cx, cy, w, h);
        }
        let reach = match self.bitmap {
            Some(bmp) => bmp.reach_at(self.diameter),
            None => self.diameter * 0.5,
        } + 1.0;
        if !(reach.is_finite() && cx.is_finite() && cy.is_finite()) || w == 0 || h == 0 {
            return None;
        }
        let x0 = (cx - reach).floor().max(0.0) as i64;
        let y0 = (cy - reach).floor().max(0.0) as i64;
        let x1 = (cx + reach).ceil().min(w as f32) as i64;
        let y1 = (cy + reach).ceil().min(h as f32) as i64;
        if x1 <= x0 || y1 <= y0 {
            return None;
        }
        Some(Region::new(
            x0 as i32,
            y0 as i32,
            (x1 - x0) as u32,
            (y1 - y0) as u32,
        ))
    }
}

/// How a texture or the dual tip combines with the primary coverage.
/// The order is the wire's (`brush_combine_modes`, the TS
/// `COMBINE_MODES`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum CombineKind {
    #[default]
    Multiply,
    Subtract,
    Darken,
    Overlay,
    ColorDodge,
    ColorBurn,
    LinearBurn,
    HardMix,
    LinearHeight,
    Height,
}

impl CombineKind {
    pub const ALL: [CombineKind; 10] = [
        CombineKind::Multiply,
        CombineKind::Subtract,
        CombineKind::Darken,
        CombineKind::Overlay,
        CombineKind::ColorDodge,
        CombineKind::ColorBurn,
        CombineKind::LinearBurn,
        CombineKind::HardMix,
        CombineKind::LinearHeight,
        CombineKind::Height,
    ];

    pub fn from_ordinal(o: f32) -> CombineKind {
        let i = if o.is_finite() { o.round() as i64 } else { 0 };
        CombineKind::ALL
            .get(i.clamp(0, 9) as usize)
            .copied()
            .unwrap_or_default()
    }

    pub fn as_wire(self) -> &'static str {
        match self {
            CombineKind::Multiply => "multiply",
            CombineKind::Subtract => "subtract",
            CombineKind::Darken => "darken",
            CombineKind::Overlay => "overlay",
            CombineKind::ColorDodge => "colorDodge",
            CombineKind::ColorBurn => "colorBurn",
            CombineKind::LinearBurn => "linearBurn",
            CombineKind::HardMix => "hardMix",
            CombineKind::LinearHeight => "linearHeight",
            CombineKind::Height => "height",
        }
    }

    /// Combine coverage `c` with `t` (the texture's brightness, or the
    /// dual tip's coverage — 1 = "paint here") at `depth` (`0` = no
    /// effect, `1` = full). All `0..=1`.
    ///
    /// The blend-style modes compute `r = f(c, t)` and return
    /// `mix(c, r, depth)`. The two HEIGHT modes read `t` as a height
    /// field the paint fills up to a level set by the depth: HEIGHT is a
    /// hard threshold (paint only on the peaks above `1 − depth`),
    /// LINEAR HEIGHT a linear ramp over the same range.
    pub fn combine(self, c: f32, t: f32, depth: f32) -> f32 {
        let (c, t, k) = (c.clamp(0.0, 1.0), t.clamp(0.0, 1.0), depth.clamp(0.0, 1.0));
        let r = match self {
            CombineKind::Multiply => c * t,
            CombineKind::Subtract | CombineKind::LinearBurn => (c + t - 1.0).max(0.0),
            CombineKind::Darken => c.min(t),
            CombineKind::Overlay => {
                if c < 0.5 {
                    2.0 * c * t
                } else {
                    1.0 - 2.0 * (1.0 - c) * (1.0 - t)
                }
            }
            CombineKind::ColorDodge => {
                if t >= 1.0 {
                    1.0f32.min(c * 1e6)
                } else {
                    (c / (1.0 - t)).min(1.0)
                }
            }
            CombineKind::ColorBurn => {
                if t <= 0.0 {
                    0.0
                } else {
                    1.0 - ((1.0 - c) / t).min(1.0)
                }
            }
            CombineKind::HardMix => {
                if c + t >= 1.0 {
                    c
                } else {
                    0.0
                }
            }
            CombineKind::Height => {
                return if t >= 1.0 - k { c } else { 0.0 };
            }
            CombineKind::LinearHeight => {
                if k <= 0.0 {
                    return 0.0;
                }
                return c * ((t - (1.0 - k)) / k).clamp(0.0, 1.0);
            }
        };
        c + (r - c) * k
    }
}

/// A brush TEXTURE: the defined pattern's brightness as a tiling field,
/// with the Texture pane's brightness, contrast, invert and scale baked
/// in at construction.
#[derive(Debug, Clone, PartialEq)]
pub struct TextureField {
    width: u32,
    height: u32,
    /// `0..=1`, row-major.
    value: Vec<f32>,
    scale: f32,
}

impl TextureField {
    /// From straight RGBA8 pattern pixels: brightness = Rec. 601 luma ×
    /// alpha (a transparent texel is "no paint"). `brightness` −150..150
    /// shifts the field by `brightness / 255`; `contrast` −50..100
    /// scales it about 0.5 by `(100 + contrast) / 100`; `invert` flips
    /// it. `scale` (`> 0`) is how many image px one pattern texel spans.
    pub fn from_rgba8(
        width: u32,
        height: u32,
        rgba: &[u8],
        scale: f32,
        brightness: f32,
        contrast: f32,
        invert: bool,
    ) -> Option<TextureField> {
        let n = (width as usize).checked_mul(height as usize)?;
        if n == 0 || rgba.len() != n * 4 {
            return None;
        }
        let gain = ((100.0 + contrast.clamp(-50.0, 100.0)) / 100.0).max(0.0);
        let shift = brightness.clamp(-150.0, 150.0) / 255.0;
        let value = rgba
            .as_chunks::<4>()
            .0
            .iter()
            .map(|p| {
                let l = (0.299 * p[0] as f32 + 0.587 * p[1] as f32 + 0.114 * p[2] as f32) / 255.0;
                let l = l * (p[3] as f32 / 255.0);
                let v = ((l - 0.5) * gain + 0.5 + shift).clamp(0.0, 1.0);
                if invert {
                    1.0 - v
                } else {
                    v
                }
            })
            .collect();
        Some(TextureField {
            width,
            height,
            value,
            scale: if scale.is_finite() && scale > 0.0 {
                scale
            } else {
                1.0
            },
        })
    }

    /// The field at image pixel `(x, y)` — the pattern TILES the canvas
    /// (anchored at the image origin, so overlapping dabs see the same
    /// grain, which is what makes a texture read as paper).
    pub fn at(&self, x: u32, y: u32) -> f32 {
        let tx = ((x as f32 + 0.5) / self.scale).floor() as i64;
        let ty = ((y as f32 + 0.5) / self.scale).floor() as i64;
        let ix = tx.rem_euclid(self.width as i64) as usize;
        let iy = ty.rem_euclid(self.height as i64) as usize;
        self.value[iy * self.width as usize + ix]
    }
}

/// How accumulated coverage is shaped on its way to the mask.
#[derive(Debug, Clone, Default)]
pub struct Lowering {
    /// The DUAL BRUSH: a second accumulator, combined with the primary.
    pub dual: Option<(Box<crate::dab::StrokeAccumulator>, CombineKind)>,
    /// A texture applied to the WHOLE stroke (`texture each tip` off):
    /// field, mode, depth.
    pub texture: Option<(Arc<TextureField>, CombineKind, f32)>,
    /// WET EDGES: paint pools at the rim.
    pub wet_edges: bool,
    /// NOISE in the soft edge, seeded per stroke.
    pub noise: Option<u64>,
}

impl Lowering {
    /// Shape coverage `a` (> 0) at `(x, y)`.
    pub fn shape(&self, x: u32, y: u32, a: f32) -> f32 {
        let mut a = a;
        if let Some((dual, mode)) = &self.dual {
            a = mode.combine(a, dual.value_at(x, y), 1.0);
        }
        if let Some((field, mode, depth)) = &self.texture {
            a = mode.combine(a, field.at(x, y), *depth);
        }
        if self.wet_edges {
            a = wet_edge(a);
        }
        if let Some(seed) = self.noise {
            a = noisy(a, x, y, seed);
        }
        a.clamp(0.0, 1.0)
    }
}

/// WET EDGES, this engine's shape: `a·(1 − ½·a⁴)`. Solid interior
/// coverage (1) lands at half, while the falling rim (around 0.8) lands
/// darker than the interior — paint pooling at the edge, which is what
/// the option is for. Monotone below the peak, so a soft brush stays
/// soft.
pub fn wet_edge(a: f32) -> f32 {
    let a2 = a * a;
    a * (1.0 - 0.5 * a2 * a2)
}

/// NOISE, this engine's shape: a per-pixel hash in `[−½, ½]` scaled by
/// `4·a·(1 − a)` — zero in the solid interior and outside, strongest
/// half-way down the rim, which is where Photoshop's noise shows.
pub fn noisy(a: f32, x: u32, y: u32, seed: u64) -> f32 {
    let h = hash3(x as u64, y as u64, seed);
    let n = (h >> 40) as f32 / (1u64 << 24) as f32 - 0.5;
    (a + n * 4.0 * a * (1.0 - a)).clamp(0.0, 1.0)
}

/// A stateless SplitMix64 mix of three words — the noise and the colour
/// gates use it so a pixel's value does not depend on visit order.
pub fn hash3(a: u64, b: u64, c: u64) -> u64 {
    let mut z = a
        .wrapping_mul(0x9E37_79B9_7F4A_7C15)
        .wrapping_add(b.wrapping_mul(0xC2B2_AE3D_27D4_EB4F))
        .wrapping_add(c.wrapping_mul(0x1656_67B1_9E37_79F9));
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

/// Everything one stamp deposits ([`crate::dab::StrokeAccumulator::stamp_spec`]).
pub struct StampSpec<'a> {
    pub tip: &'a dyn TipCoverage,
    pub cx: f32,
    pub cy: f32,
    pub flow: f32,
    /// The dab's own opacity ceiling (Transfer's opacity jitter), `0..1`.
    pub ceiling: f32,
    /// The dab's colour (colour dynamics), or `None` for the stroke's.
    pub color: Option<[f32; 3]>,
    /// A per-pixel coverage modulation `(x, y, c) → c'` — texture each
    /// tip, or the background eraser's colour gate.
    pub modulate: Option<&'a dyn Fn(u32, u32, f32) -> f32>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dab::StrokeAccumulator;

    fn tip(angle: f32, roundness: f32) -> OrientedTip<'static> {
        OrientedTip {
            diameter: 20.0,
            hardness: 1.0,
            antialias: true,
            angle_deg: angle,
            roundness,
            flip_x: false,
            flip_y: false,
            bitmap: None,
        }
    }

    #[test]
    fn image_editor_brush_engine_an_unrotated_round_oriented_tip_is_the_round_tip_bit_for_bit() {
        let o = tip(0.0, 1.0);
        let r = BrushTip::soft(20.0, 1.0);
        for y in 0..32 {
            for x in 0..32 {
                assert_eq!(
                    o.coverage_at_pixel(16.0, 16.0, x, y).to_bits(),
                    r.coverage_at_pixel(16.0, 16.0, x, y).to_bits()
                );
            }
        }
        assert_eq!(
            o.dab_bounds(16.0, 16.0, 32, 32),
            r.dab_bounds(16.0, 16.0, 32, 32)
        );
    }

    #[test]
    fn image_editor_brush_engine_roundness_squashes_the_vertical_axis_at_angle_zero() {
        let o = tip(0.0, 0.5); // 20 × 10
        assert!(o.coverage_at_pixel(16.0, 16.0, 16 + 8, 16) > 0.9, "along x");
        assert_eq!(
            o.coverage_at_pixel(16.0, 16.0, 16, 16 + 7),
            0.0,
            "squashed in y"
        );
    }

    #[test]
    fn image_editor_brush_engine_a_positive_angle_turns_the_major_axis_counter_clockwise_on_screen()
    {
        // 90° CCW on screen: the long axis now points UP (−y in image px).
        let o = tip(90.0, 0.3);
        assert!(o.coverage_at_pixel(16.0, 16.0, 16, 16 - 8) > 0.9, "up");
        assert_eq!(
            o.coverage_at_pixel(16.0, 16.0, 16 + 8, 16),
            0.0,
            "not across"
        );
        // 45° CCW: up-and-right is along the axis, down-and-right is not.
        let d = tip(45.0, 0.2);
        assert!(d.coverage_at_pixel(16.0, 16.0, 16 + 5, 16 - 6) > 0.5);
        assert_eq!(d.coverage_at_pixel(16.0, 16.0, 16 + 5, 16 + 5), 0.0);
    }

    #[test]
    fn image_editor_brush_engine_a_rotated_bitmap_mirrors_then_rotates() {
        // An L: a bar along x at the top, a bar down the left edge.
        let (w, h) = (8u32, 8u32);
        let mut alpha = vec![0u8; 64];
        alpha[..8].fill(255);
        for y in 0..8 {
            alpha[y * 8] = 255;
        }
        let bmp = SampledTip::new(w, h, alpha).expect("valid");
        let at = |angle: f32, fx: bool, px: u32, py: u32| {
            OrientedTip {
                diameter: 8.0,
                hardness: 1.0,
                antialias: true,
                angle_deg: angle,
                roundness: 1.0,
                flip_x: fx,
                flip_y: false,
                bitmap: Some(&bmp),
            }
            .coverage_at_pixel(8.0, 8.0, px, py)
        };
        // Unrotated: the top-left corner is painted, the top-right end of
        // the bar too, the bottom-right is not.
        assert!(at(0.0, false, 4, 4) > 0.5);
        assert!(at(0.0, false, 11, 4) > 0.5);
        assert_eq!(at(0.0, false, 11, 11), 0.0);
        // Flip X: the vertical bar moves to the right edge.
        assert!(at(0.0, true, 11, 11) > 0.5);
        assert_eq!(at(0.0, true, 4, 11), 0.0);
        // 90° CCW: the top bar becomes the LEFT bar, the left bar the BOTTOM.
        assert!(at(90.0, false, 4, 11) > 0.5, "left bar, low end");
        assert!(at(90.0, false, 11, 11) > 0.5, "bottom bar, right end");
        assert_eq!(at(90.0, false, 11, 4), 0.0);
    }

    #[test]
    fn image_editor_brush_engine_combine_modes_hold_their_identities() {
        for m in CombineKind::ALL {
            // Depth 0 is the identity for the blend-style modes.
            if !matches!(m, CombineKind::Height | CombineKind::LinearHeight) {
                assert_eq!(m.combine(0.6, 0.3, 0.0), 0.6, "{m:?}");
            }
            // Nothing in, nothing out.
            assert_eq!(m.combine(0.0, 0.7, 1.0), 0.0, "{m:?}");
            assert_eq!(
                CombineKind::from_ordinal(
                    CombineKind::ALL.iter().position(|x| *x == m).unwrap() as f32
                ),
                m
            );
        }
        assert_eq!(CombineKind::Multiply.combine(0.8, 0.5, 1.0), 0.4);
        assert_eq!(CombineKind::Darken.combine(0.8, 0.5, 1.0), 0.5);
        assert!((CombineKind::Subtract.combine(0.8, 0.5, 1.0) - 0.3).abs() < 1e-6);
        assert_eq!(
            CombineKind::Height.combine(0.8, 0.9, 0.5),
            0.8,
            "a peak above the level"
        );
        assert_eq!(
            CombineKind::Height.combine(0.8, 0.2, 0.5),
            0.0,
            "a valley below it"
        );
    }

    #[test]
    fn image_editor_brush_engine_wet_edges_pool_paint_at_the_rim() {
        assert_eq!(wet_edge(1.0), 0.5, "the interior lands at half");
        assert!(wet_edge(0.8) > wet_edge(1.0), "the rim lands darker");
        assert_eq!(wet_edge(0.0), 0.0);
    }

    #[test]
    fn image_editor_brush_engine_noise_lives_in_the_soft_edge_only() {
        for y in 0..16 {
            for x in 0..16 {
                assert_eq!(noisy(1.0, x, y, 7), 1.0, "solid stays solid");
                assert_eq!(noisy(0.0, x, y, 7), 0.0);
            }
        }
        let varied = (0..64).map(|x| noisy(0.5, x, 3, 7)).collect::<Vec<_>>();
        assert!(
            varied.iter().any(|v| (*v - 0.5).abs() > 0.05),
            "the rim is grainy"
        );
        assert_eq!(noisy(0.5, 9, 9, 7), noisy(0.5, 9, 9, 7), "deterministic");
    }

    #[test]
    fn image_editor_brush_engine_texture_tiles_and_bakes_its_adjustments() {
        // A 2×1 pattern: black, white.
        let px = [0, 0, 0, 255, 255, 255, 255, 255];
        let t = TextureField::from_rgba8(2, 1, &px, 1.0, 0.0, 0.0, false).unwrap();
        assert_eq!(t.at(0, 0), 0.0);
        assert_eq!(t.at(1, 0), 1.0);
        assert_eq!(t.at(2, 5), 0.0, "tiles in both axes");
        let inv = TextureField::from_rgba8(2, 1, &px, 1.0, 0.0, 0.0, true).unwrap();
        assert_eq!(inv.at(0, 0), 1.0);
        let big = TextureField::from_rgba8(2, 1, &px, 4.0, 0.0, 0.0, false).unwrap();
        assert_eq!(
            (big.at(0, 0), big.at(3, 0), big.at(4, 0)),
            (0.0, 0.0, 1.0),
            "scale"
        );
        assert!(TextureField::from_rgba8(2, 2, &px, 1.0, 0.0, 0.0, false).is_none());
    }

    #[test]
    fn image_editor_brush_engine_a_dab_ceiling_caps_its_own_deposit_and_never_lowers() {
        let t = BrushTip::soft(8.0, 1.0);
        let mut acc = StrokeAccumulator::new(16, 16);
        acc.stamp_spec(&StampSpec {
            tip: &t,
            cx: 8.0,
            cy: 8.0,
            flow: 1.0,
            ceiling: 0.4,
            color: None,
            modulate: None,
        });
        assert!((acc.value_at(8, 8) - 0.4).abs() < 1e-6);
        // A lower ceiling later never takes coverage away.
        acc.stamp_spec(&StampSpec {
            tip: &t,
            cx: 8.0,
            cy: 8.0,
            flow: 1.0,
            ceiling: 0.2,
            color: None,
            modulate: None,
        });
        assert!((acc.value_at(8, 8) - 0.4).abs() < 1e-6);
        // ceiling 1, no colour, no modulation IS the plain stamp.
        let mut a = StrokeAccumulator::new(16, 16);
        let mut b = StrokeAccumulator::new(16, 16);
        a.stamp(&t, 7.3, 8.6, 0.37);
        b.stamp_spec(&StampSpec {
            tip: &t,
            cx: 7.3,
            cy: 8.6,
            flow: 0.37,
            ceiling: 1.0,
            color: None,
            modulate: None,
        });
        for y in 0..16 {
            for x in 0..16 {
                assert_eq!(a.value_at(x, y).to_bits(), b.value_at(x, y).to_bits());
            }
        }
    }

    #[test]
    fn image_editor_brush_engine_coloured_dabs_build_a_colour_field_weighted_by_coverage() {
        let t = BrushTip::soft(8.0, 1.0);
        let mut acc = StrokeAccumulator::new(16, 16);
        for (x, rgb) in [(6.0, [1.0, 0.0, 0.0]), (10.0, [0.0, 0.0, 1.0])] {
            acc.stamp_spec(&StampSpec {
                tip: &t,
                cx: x,
                cy: 8.0,
                flow: 0.5,
                ceiling: 1.0,
                color: Some(rgb),
                modulate: None,
            });
        }
        assert!(acc.has_colors());
        let win = acc.color_window_f16(Region::new(0, 8, 16, 1), [0.0; 3]);
        let px = |x: usize, c: usize| {
            let i = (x * 4 + c) * 2;
            half::f16::from_le_bytes([win[i], win[i + 1]]).to_f32()
        };
        assert!(px(4, 0) > 0.99, "only the red dab reached x=4");
        assert!(px(12, 2) > 0.99, "only the blue dab reached x=12");
        assert!(px(8, 0) > 0.2 && px(8, 2) > 0.2, "the overlap mixes");
    }
}
