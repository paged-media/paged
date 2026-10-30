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

//! The param blocks of the adjustment and convolution kernels (moved from
//! paged.image's `image-kernels`, `families/adjust.rs` and
//! `families/conv.rs`). Each is the `repr(C)` uniform its WGSL module
//! declares, `_abi_pad` included; the kernel definitions (`KernelDef`, the
//! WGSL) stay in `image-kernels` and name these by re-export until the
//! whole crate moves (engine ADR 1013).

/// Exposure params: `ev` stops (powers of two; exp2(ev) is the gain);
/// `encoding` 0 = linear input, 1 = 2.2-gamma-encoded input.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, ::bytemuck::Pod, ::bytemuck::Zeroable)]
pub struct AdjustExposureParams {
    pub ev: f32,
    pub encoding: u32,
}

impl AdjustExposureParams {
    /// Exposure on linear input.
    pub fn new(ev: f32) -> Self {
        Self { ev, encoding: 0 }
    }

    /// Exposure on gamma-encoded input, applied to its light.
    pub fn encoded(ev: f32) -> Self {
        Self { ev, encoding: 1 }
    }

    pub fn as_bytes(&self) -> &[u8] {
        ::bytemuck::bytes_of(self)
    }
}

/// Brightness/contrast params (identity at brightness 0, contrast 1).
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, ::bytemuck::Pod, ::bytemuck::Zeroable)]
pub struct AdjustBrightnessContrastParams {
    pub brightness: f32,
    pub contrast: f32,
    pub _abi_pad: u32,
}

impl AdjustBrightnessContrastParams {
    pub fn new(brightness: f32, contrast: f32) -> Self {
        Self {
            brightness,
            contrast,
            _abi_pad: 0,
        }
    }

    pub fn as_bytes(&self) -> &[u8] {
        ::bytemuck::bytes_of(self)
    }
}

/// Levels params: input black/white, midtone gamma, output black/white.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, ::bytemuck::Pod, ::bytemuck::Zeroable)]
pub struct AdjustLevelsParams {
    pub in_black: f32,
    pub in_white: f32,
    pub gamma: f32,
    pub out_black: f32,
    pub out_white: f32,
    pub _abi_pad: u32,
}

impl AdjustLevelsParams {
    pub fn new(in_black: f32, in_white: f32, gamma: f32, out_black: f32, out_white: f32) -> Self {
        Self {
            in_black,
            in_white,
            gamma,
            out_black,
            out_white,
            _abi_pad: 0,
        }
    }

    pub fn as_bytes(&self) -> &[u8] {
        ::bytemuck::bytes_of(self)
    }
}

/// Per-channel levels params: in_black/in_white/gamma for r, g, b.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, ::bytemuck::Pod, ::bytemuck::Zeroable)]
pub struct AdjustLevelsRgbParams {
    pub r_in_black: f32,
    pub r_in_white: f32,
    pub r_gamma: f32,
    pub g_in_black: f32,
    pub g_in_white: f32,
    pub g_gamma: f32,
    pub b_in_black: f32,
    pub b_in_white: f32,
    pub b_gamma: f32,
    pub _abi_pad: u32,
}

impl AdjustLevelsRgbParams {
    /// Per channel: `[in_black, in_white, gamma]`.
    pub fn new(r: [f32; 3], g: [f32; 3], b: [f32; 3]) -> Self {
        Self {
            r_in_black: r[0],
            r_in_white: r[1],
            r_gamma: r[2],
            g_in_black: g[0],
            g_in_white: g[1],
            g_gamma: g[2],
            b_in_black: b[0],
            b_in_white: b[1],
            b_gamma: b[2],
            _abi_pad: 0,
        }
    }

    pub fn as_bytes(&self) -> &[u8] {
        ::bytemuck::bytes_of(self)
    }
}

/// Saturation params: `sat` (1 = identity, 0 = grayscale).
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, ::bytemuck::Pod, ::bytemuck::Zeroable)]
pub struct AdjustSaturationParams {
    pub sat: f32,
    pub _abi_pad: u32,
}

impl AdjustSaturationParams {
    pub fn new(sat: f32) -> Self {
        Self { sat, _abi_pad: 0 }
    }

    pub fn as_bytes(&self) -> &[u8] {
        ::bytemuck::bytes_of(self)
    }
}

/// Hue-rotate params: rotation angle in `degrees`.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, ::bytemuck::Pod, ::bytemuck::Zeroable)]
pub struct AdjustHueRotateParams {
    pub degrees: f32,
    pub _abi_pad: u32,
}

impl AdjustHueRotateParams {
    pub fn new(degrees: f32) -> Self {
        Self {
            degrees,
            _abi_pad: 0,
        }
    }

    pub fn as_bytes(&self) -> &[u8] {
        ::bytemuck::bytes_of(self)
    }
}

/// White-balance params: `temp` (amber↔blue) and `tint` (green↔magenta);
/// both 0 = identity.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, ::bytemuck::Pod, ::bytemuck::Zeroable)]
pub struct AdjustWhiteBalanceParams {
    pub temp: f32,
    pub tint: f32,
    pub _abi_pad: u32,
}

impl AdjustWhiteBalanceParams {
    pub fn new(temp: f32, tint: f32) -> Self {
        Self {
            temp,
            tint,
            _abi_pad: 0,
        }
    }

    pub fn as_bytes(&self) -> &[u8] {
        ::bytemuck::bytes_of(self)
    }
}

/// Vibrance params: `vibrance` (saturation-protected boost) and
/// `saturation` (uniform offset); both 0 = identity.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, ::bytemuck::Pod, ::bytemuck::Zeroable)]
pub struct AdjustVibranceParams {
    pub vibrance: f32,
    pub saturation: f32,
    pub _abi_pad: u32,
}

impl AdjustVibranceParams {
    pub fn new(vibrance: f32, saturation: f32) -> Self {
        Self {
            vibrance,
            saturation,
            _abi_pad: 0,
        }
    }

    pub fn as_bytes(&self) -> &[u8] {
        ::bytemuck::bytes_of(self)
    }
}

/// Color-balance params: per tonal range (shadows/midtones/highlights)
/// one offset per opponent axis (cyan-red, magenta-green, yellow-blue).
/// All 0 = identity.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, ::bytemuck::Pod, ::bytemuck::Zeroable)]
pub struct AdjustColorBalanceParams {
    pub sh_cr: f32,
    pub sh_mg: f32,
    pub sh_yb: f32,
    pub mid_cr: f32,
    pub mid_mg: f32,
    pub mid_yb: f32,
    pub hi_cr: f32,
    pub hi_mg: f32,
    pub hi_yb: f32,
    pub _abi_pad: u32,
}

#[allow(clippy::too_many_arguments)]
impl AdjustColorBalanceParams {
    pub fn new(shadows: [f32; 3], midtones: [f32; 3], highlights: [f32; 3]) -> Self {
        Self {
            sh_cr: shadows[0],
            sh_mg: shadows[1],
            sh_yb: shadows[2],
            mid_cr: midtones[0],
            mid_mg: midtones[1],
            mid_yb: midtones[2],
            hi_cr: highlights[0],
            hi_mg: highlights[1],
            hi_yb: highlights[2],
            _abi_pad: 0,
        }
    }

    pub fn as_bytes(&self) -> &[u8] {
        ::bytemuck::bytes_of(self)
    }
}

/// Black & White params: grayscale weights for the six hue sectors.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, ::bytemuck::Pod, ::bytemuck::Zeroable)]
pub struct AdjustBlackWhiteParams {
    pub reds: f32,
    pub yellows: f32,
    pub greens: f32,
    pub cyans: f32,
    pub blues: f32,
    pub magentas: f32,
    pub _abi_pad: u32,
}

#[allow(clippy::too_many_arguments)]
impl AdjustBlackWhiteParams {
    pub fn new(
        reds: f32,
        yellows: f32,
        greens: f32,
        cyans: f32,
        blues: f32,
        magentas: f32,
    ) -> Self {
        Self {
            reds,
            yellows,
            greens,
            cyans,
            blues,
            magentas,
            _abi_pad: 0,
        }
    }

    pub fn as_bytes(&self) -> &[u8] {
        ::bytemuck::bytes_of(self)
    }
}

/// Posterize params: `levels` — number of output values per channel
/// (effective minimum 2).
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, ::bytemuck::Pod, ::bytemuck::Zeroable)]
pub struct AdjustPosterizeParams {
    pub levels: f32,
    pub _abi_pad: u32,
}

impl AdjustPosterizeParams {
    pub fn new(levels: f32) -> Self {
        Self {
            levels,
            _abi_pad: 0,
        }
    }

    pub fn as_bytes(&self) -> &[u8] {
        ::bytemuck::bytes_of(self)
    }
}

/// Threshold params: luma `threshold` in [0,1].
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, ::bytemuck::Pod, ::bytemuck::Zeroable)]
pub struct AdjustThresholdParams {
    pub threshold: f32,
    pub _abi_pad: u32,
}

impl AdjustThresholdParams {
    pub fn new(threshold: f32) -> Self {
        Self {
            threshold,
            _abi_pad: 0,
        }
    }

    pub fn as_bytes(&self) -> &[u8] {
        ::bytemuck::bytes_of(self)
    }
}

/// Photo-filter params: filter color rgb, `density` in [0,1], and the
/// preserve-luminosity flag (0 = off, else on).
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, ::bytemuck::Pod, ::bytemuck::Zeroable)]
pub struct AdjustPhotoFilterParams {
    pub fr: f32,
    pub fg: f32,
    pub fb: f32,
    pub density: f32,
    pub preserve: u32,
    pub _abi_pad: u32,
}

impl AdjustPhotoFilterParams {
    pub fn new(filter: [f32; 3], density: f32, preserve: bool) -> Self {
        Self {
            fr: filter[0],
            fg: filter[1],
            fb: filter[2],
            density,
            preserve: u32::from(preserve),
            _abi_pad: 0,
        }
    }

    pub fn as_bytes(&self) -> &[u8] {
        ::bytemuck::bytes_of(self)
    }
}

/// Channel-mixer params: row-major 3×4 matrix (output channel × input
/// r,g,b + constant).
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, ::bytemuck::Pod, ::bytemuck::Zeroable)]
pub struct AdjustChannelMixerParams {
    pub rr: f32,
    pub rg: f32,
    pub rb: f32,
    pub rc: f32,
    pub gr: f32,
    pub gg: f32,
    pub gb: f32,
    pub gc: f32,
    pub br: f32,
    pub bg: f32,
    pub bb: f32,
    pub bc: f32,
    pub _abi_pad: u32,
}

impl AdjustChannelMixerParams {
    /// Rows are `[in_r, in_g, in_b, constant]` for the r, g, b outputs.
    pub fn new(r_row: [f32; 4], g_row: [f32; 4], b_row: [f32; 4]) -> Self {
        Self {
            rr: r_row[0],
            rg: r_row[1],
            rb: r_row[2],
            rc: r_row[3],
            gr: g_row[0],
            gg: g_row[1],
            gb: g_row[2],
            gc: g_row[3],
            br: b_row[0],
            bg: b_row[1],
            bb: b_row[2],
            bc: b_row[3],
            _abi_pad: 0,
        }
    }

    pub fn as_bytes(&self) -> &[u8] {
        ::bytemuck::bytes_of(self)
    }
}

/// A 256-entry RGB ramp, one entry per `vec4<f32>` (w unused).
#[repr(C)]
#[derive(Debug, Clone, Copy, ::bytemuck::Pod, ::bytemuck::Zeroable)]
pub struct AdjustGradientMapParams {
    pub ramp: [[f32; 4]; 256],
}

impl AdjustGradientMapParams {
    /// Build a ramp by interpolating between two endpoint colours — the
    /// two-stop gradient a UI exposes first.
    pub fn two_stop(shadow: [f32; 3], highlight: [f32; 3]) -> Self {
        Self::from_fn(|t| {
            [
                shadow[0] + (highlight[0] - shadow[0]) * t,
                shadow[1] + (highlight[1] - shadow[1]) * t,
                shadow[2] + (highlight[2] - shadow[2]) * t,
            ]
        })
    }

    /// Build from a closure over the normalized luminance.
    pub fn from_fn(f: impl Fn(f32) -> [f32; 3]) -> Self {
        let mut ramp = [[0.0f32; 4]; 256];
        for (i, e) in ramp.iter_mut().enumerate() {
            let v = f(i as f32 / 255.0);
            *e = [v[0], v[1], v[2], 0.0];
        }
        Self { ramp }
    }

    /// The identity-ish ramp: black to white, which maps an image to its
    /// own luminance (a greyscale conversion).
    pub fn greyscale() -> Self {
        Self::two_stop([0.0, 0.0, 0.0], [1.0, 1.0, 1.0])
    }

    pub fn as_bytes(&self) -> &[u8] {
        ::bytemuck::bytes_of(self)
    }
}

/// Hue/Saturation params. Each vec4 is (hue°, saturation, lightness, _)
/// with saturation and lightness in [−1, 1]; `colorize` is
/// (on, hue°, saturation 0–1, lightness −1–1).
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, ::bytemuck::Pod, ::bytemuck::Zeroable)]
pub struct AdjustHueSaturationParams {
    pub master: [f32; 4],
    pub ranges: [[f32; 4]; 6],
    pub colorize: [f32; 4],
}

impl AdjustHueSaturationParams {
    /// Every adjustment zero, colorize off — the identity.
    pub fn identity() -> Self {
        Self {
            master: [0.0; 4],
            ranges: [[0.0; 4]; 6],
            colorize: [0.0; 4],
        }
    }

    /// Is this the identity? SEMANTIC: every hue/saturation/lightness
    /// delta zero and colorize off, whatever colorize's own values are
    /// (a panel keeps a starting colour there while it is off).
    pub fn is_identity(&self) -> bool {
        let zero = |v: &[f32; 4]| v[..3].iter().all(|&x| x == 0.0);
        zero(&self.master) && self.ranges.iter().all(zero) && self.colorize[0] == 0.0
    }

    pub fn as_bytes(&self) -> &[u8] {
        ::bytemuck::bytes_of(self)
    }
}

/// Compile-time MAX Gaussian radius (the windowed ROI bound, §8.3).
pub const GAUSSIAN_MAX_RADIUS: u16 = 24;

/// Gaussian pass params: blur σ and the (clamped ≤ 24) integer radius.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, ::bytemuck::Pod, ::bytemuck::Zeroable)]
pub struct ConvGaussianParams {
    pub sigma: f32,
    pub radius: u32,
    pub _abi_pad: u32,
}

#[allow(clippy::new_without_default)]
impl ConvGaussianParams {
    pub fn new(sigma: f32, radius: u32) -> Self {
        Self {
            sigma,
            radius,
            _abi_pad: 0,
        }
    }

    pub fn as_bytes(&self) -> &[u8] {
        ::bytemuck::bytes_of(self)
    }
}

/// Unsharp params: sharpening `amount` and per-channel `threshold`.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, ::bytemuck::Pod, ::bytemuck::Zeroable)]
pub struct ConvUnsharpParams {
    pub amount: f32,
    pub threshold: f32,
    pub _abi_pad: u32,
}

#[allow(clippy::new_without_default)]
impl ConvUnsharpParams {
    pub fn new(amount: f32, threshold: f32) -> Self {
        Self {
            amount,
            threshold,
            _abi_pad: 0,
        }
    }

    pub fn as_bytes(&self) -> &[u8] {
        ::bytemuck::bytes_of(self)
    }
}
