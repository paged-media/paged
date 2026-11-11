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

//! ADJUSTMENT LAYERS hold engine [`RasterOp`]s (engine ADR 1037, amendment
//! 2026-11-11, "one adjustment model"): a Photoshop adjustment layer, an
//! Office picture correction and a CSS filter are the same ops, and only
//! the format adapters know their encodings — the PSD reader and writer
//! map Photoshop's blocks onto the ops (`paged_psd_fx::adjustment`). The
//! module's own typed adjustment model is gone.
//!
//! An adjustment layer is a stack of ops ([`AdjustmentOps`]): a typed layer
//! (Layer ▸ New Adjustment Layer, or a PSD's) is one op; a layer the Adjust
//! panel stacks from its chain is the chain's stages as ops, in the chain's
//! order ([`AdjustmentOps::of_chain`]), and so is a stored chain of an
//! older document, which migrates when it opens.
//!
//! Three faces, none of them a model of its own:
//!
//! * the PANEL's units ([`AdjustmentOps::values`], [`AdjustmentOps::from_wire`]):
//!   the Properties panel speaks Photoshop's units (levels 0–255,
//!   percentages), converted to and from the op at the wasm boundary;
//! * the GPU PLAN ([`AdjustmentOps::gpu_plan`]): how the layer fold
//!   evaluates the ops through the adjust chain's kernels (`adjust_f16`) or
//!   the point kernels dispatched on the accumulator. It is held to the
//!   engine's one CPU evaluator, `paged_image_adjust`, by
//!   `parity_tests::every_adjustment_kind_matches_the_engine_evaluator`;
//!   Photoshop's 8-bit tables (Levels, Curves, an Exposure's offset and
//!   gamma) are `paged_image_adjust::tables`, read by both;
//! * the PSD blocks, through `paged_psd_fx::adjustment`.

use image_kernels::families::adjust::{AdjustLut3dParams, LUT3D_EDGE};
use image_kernels::families::develop::DevelopSettings;
use image_kernels::KernelDef;
use paged_image_adjust::tables;
use paged_model::{GradientMapStop, LevelsRecord, RasterOp};

use crate::ingest::{
    AdjustParams, BlackWhiteParams, ChannelMixerParams, ColorBalanceParams, IngestError,
    LevelsParams, LevelsRgbParams, PhotoFilterParams,
};

/// Every typed kind's wire name, in the Layer ▸ New Adjustment Layer
/// order (Photoshop's menu order). Each is the name of its [`RasterOp`].
pub const ADJUSTMENT_KINDS: [&str; 17] = [
    "brightnessContrast",
    "levels",
    "curves",
    "exposure",
    "vibrance",
    "hueSaturation",
    "colorBalance",
    "blackWhite",
    "photoFilter",
    "channelMixer",
    "colorLookup",
    "invert",
    "posterize",
    "threshold",
    "gradientMap",
    "selectiveColor",
    "develop",
];

/// The sharpen radius (σ, pixels) of the Adjust panel's chain.
pub const CHAIN_SHARPEN_RADIUS: f32 = 1.5;

/// An adjustment layer's ops, applied in order (module docs).
#[derive(Debug, Clone, PartialEq)]
pub struct AdjustmentOps {
    pub ops: Vec<RasterOp>,
}

/// How the layer fold evaluates an adjustment layer on the GPU.
#[derive(Debug, Clone, PartialEq)]
pub enum GpuPlan {
    /// Adjust-chain blocks run one after the other (`adjust_f16`, each
    /// masked by the layer's coverage, as every stage of one chain is).
    Chain(Vec<AdjustParams>),
    /// Point kernels dispatched on the accumulator, in order, and mixed
    /// through the layer's coverage once.
    Direct(Vec<(&'static KernelDef, Vec<u8>)>),
}

fn bad(kind: &str, detail: impl std::fmt::Display) -> IngestError {
    IngestError::Unsupported(format!("{kind} adjustment: {detail}"))
}

/// A Photoshop-unit value as the panel reads it: four decimals, so a
/// value that went through the op's fraction reads as it was set.
fn ps(v: f32) -> f32 {
    (v * 1e4).round() / 1e4
}

/// The identity colour cube at the kernel's edge.
pub fn identity_cube() -> Vec<f32> {
    tables::identity_cube(LUT3D_EDGE)
}

/// The chain stage an op runs as (`adjust_stages`' order; the tables are
/// applied after every stage), or `None` for an op that is not a chain
/// stage. A range for an op that sets two consecutive stages.
fn chain_stages(op: &RasterOp) -> Option<(u8, u8)> {
    Some(match op {
        RasterOp::Exposure {
            offset: 0.0,
            gamma: 1.0,
            ..
        } => (1, 1),
        RasterOp::WhiteBalance { .. } => (2, 2),
        RasterOp::BrightnessContrast { .. } => (5, 5),
        RasterOp::ColorBalance { .. } => (6, 6),
        RasterOp::PhotoFilter { .. } => (7, 7),
        RasterOp::ChannelMixer { .. } => (8, 8),
        RasterOp::Vibrance { .. } => (9, 10),
        RasterOp::BlackWhite { .. } => (11, 11),
        RasterOp::Posterize { .. } => (12, 12),
        RasterOp::Threshold { .. } => (13, 13),
        RasterOp::HueSaturation { .. } | RasterOp::Recolor { .. } => (15, 15),
        RasterOp::Invert => (16, 16),
        RasterOp::Blur { .. } => (17, 17),
        RasterOp::Sharpen { radius, .. } if *radius == CHAIN_SHARPEN_RADIUS => (18, 18),
        _ => return None,
    })
}

/// An op's 8-bit tables: per channel (red, green, blue), then composite.
type Tables = (Option<[[u8; 256]; 3]>, Option<[u8; 256]>);

/// The tables an op is evaluated as (per channel, composite), for the ops
/// that are Photoshop's 8-bit tables.
fn op_tables(op: &RasterOp) -> Option<Tables> {
    match op {
        RasterOp::Exposure { ev, offset, gamma } if !(*offset == 0.0 && *gamma == 1.0) => {
            Some((None, Some(tables::exposure_table(*ev, *offset, *gamma))))
        }
        RasterOp::Levels {
            in_black,
            in_white,
            gamma,
            out_black,
            out_white,
            channels,
        } => {
            let master = LevelsRecord {
                in_black: *in_black,
                in_white: *in_white,
                gamma: *gamma,
                out_black: *out_black,
                out_white: *out_white,
            };
            let (rgb, comp) = paged_image_adjust::levels_tables(&master, channels.as_ref());
            if rgb.is_none() && comp.is_none() {
                return Some((None, None));
            }
            // Measured as Photoshop applies them: the channel tables, then
            // the composite one, which is always applied (identity or not).
            Some((rgb, Some(tables::levels_table(&master))))
        }
        RasterOp::Curves { points, channels } => {
            Some(paged_image_adjust::curves_tables(points, channels.as_ref()))
        }
        _ => None,
    }
}

/// Writes a chain-stage op into its block.
fn set_stage(p: &mut AdjustParams, op: &RasterOp) {
    match *op {
        RasterOp::Exposure { ev, .. } => p.exposure_ev = ev,
        RasterOp::WhiteBalance { temperature, tint } => {
            p.temp = temperature;
            p.tint = tint;
        }
        RasterOp::BrightnessContrast {
            brightness,
            contrast,
        } => {
            p.brightness = brightness;
            p.contrast = contrast;
        }
        RasterOp::ColorBalance {
            shadows,
            midtones,
            highlights,
            ..
        } => {
            p.color_balance = ColorBalanceParams {
                shadows,
                midtones,
                highlights,
            };
        }
        RasterOp::PhotoFilter {
            color,
            density,
            preserve_luminosity,
        } => {
            p.photo_filter = PhotoFilterParams {
                color,
                density,
                preserve_luminosity,
            };
        }
        RasterOp::ChannelMixer {
            red,
            green,
            blue,
            monochrome,
        } => {
            let (r, g, b) = if monochrome {
                (red, red, red)
            } else {
                (red, green, blue)
            };
            p.channel_mixer = ChannelMixerParams { r, g, b };
        }
        RasterOp::Vibrance {
            vibrance,
            saturation,
        } => {
            p.vibrance = vibrance;
            p.saturation = 1.0 + saturation;
        }
        RasterOp::BlackWhite {
            reds,
            yellows,
            greens,
            cyans,
            blues,
            magentas,
        } => {
            p.black_white = BlackWhiteParams {
                enabled: true,
                weights: [reds, yellows, greens, cyans, blues, magentas],
            };
        }
        RasterOp::Posterize { levels } => p.posterize = Some(levels),
        RasterOp::Threshold { level } => p.threshold = Some(level),
        RasterOp::HueSaturation {
            hue,
            saturation,
            lightness,
            ref ranges,
            colorize,
        } => {
            p.hue_sat = paged_image_adjust::hue_saturation_params(
                [hue, saturation, lightness],
                ranges.as_ref(),
                colorize,
            );
        }
        RasterOp::Recolor {
            hue,
            saturation,
            lightness,
        } => {
            p.hue_sat = paged_image_adjust::hue_saturation_params(
                [0.0; 3],
                None,
                Some([hue, saturation, lightness]),
            );
        }
        RasterOp::Invert => p.invert = true,
        RasterOp::Blur { radius } => p.blur_sigma = radius,
        RasterOp::Sharpen { amount, .. } => p.sharpen_amount = amount,
        _ => {}
    }
}

/// The point kernels a direct op runs, in order; `None` for an op that is
/// not one.
fn direct_ops(op: &RasterOp) -> Option<Vec<(&'static KernelDef, Vec<u8>)>> {
    use image_kernels::families::adjust::{
        ADJUST_GRADIENT_MAP, ADJUST_LUT3D, ADJUST_SELECTIVE_COLOR,
    };
    Some(match op {
        RasterOp::GradientMap { stops, reverse } => {
            let p = paged_image_adjust::gradient_map_params(stops, *reverse);
            vec![(&ADJUST_GRADIENT_MAP, p.as_bytes().to_vec())]
        }
        RasterOp::Duotone { shadow, highlight } => {
            let p = paged_kernels::params::AdjustGradientMapParams::two_stop(*shadow, *highlight);
            vec![(&ADJUST_GRADIENT_MAP, p.as_bytes().to_vec())]
        }
        RasterOp::SelectiveColor { ranges, absolute } => {
            paged_image_adjust::selective_color_params(ranges, *absolute)
                .into_iter()
                .map(|p| {
                    (
                        &ADJUST_SELECTIVE_COLOR as &'static KernelDef,
                        p.as_bytes().to_vec(),
                    )
                })
                .collect()
        }
        RasterOp::ColorLookup { size, cube, .. } => {
            let cube = tables::resample_cube(cube, *size as usize, LUT3D_EDGE);
            let mut p = AdjustLut3dParams::identity();
            for (i, e) in p.cube.iter_mut().enumerate() {
                *e = [cube[i * 3], cube[i * 3 + 1], cube[i * 3 + 2], 0.0];
            }
            vec![(&ADJUST_LUT3D, p.as_bytes().to_vec())]
        }
        // Tone, then detail; an identity half is skipped.
        RasterOp::Develop { settings } => DevelopSettings::from_values(settings)
            .map(|s| s.ops())
            .unwrap_or_default(),
        _ => return None,
    })
}

impl AdjustmentOps {
    /// A layer of one op.
    pub fn one(op: RasterOp) -> AdjustmentOps {
        AdjustmentOps { ops: vec![op] }
    }

    /// The Adjust panel's chain as ops, in the order the chain evaluates
    /// its stages (`adjust_stages`, the curve tables last): what the panel
    /// stacks as a layer and what a stored chain migrates to. The chain's
    /// hue rotation is the channel mixer of its matrix; its float Levels
    /// are Photoshop's Levels tables.
    pub fn of_chain(p: &AdjustParams) -> AdjustmentOps {
        let mut ops = Vec::new();
        if p.exposure_ev != 0.0 {
            ops.push(RasterOp::exposure(p.exposure_ev));
        }
        if p.temp != 0.0 || p.tint != 0.0 {
            ops.push(RasterOp::WhiteBalance {
                temperature: p.temp,
                tint: p.tint,
            });
        }
        if p.levels != LevelsParams::default() {
            let l = &p.levels;
            ops.push(RasterOp::levels(LevelsRecord {
                in_black: l.in_black,
                in_white: l.in_white,
                gamma: l.gamma,
                out_black: l.out_black,
                out_white: l.out_white,
            }));
        }
        if p.levels_rgb != LevelsRgbParams::default() {
            let r = |c: [f32; 3]| LevelsRecord {
                in_black: c[0],
                in_white: c[1],
                gamma: c[2],
                out_black: 0.0,
                out_white: 1.0,
            };
            let l = &p.levels_rgb;
            ops.push(RasterOp::Levels {
                in_black: 0.0,
                in_white: 1.0,
                gamma: 1.0,
                out_black: 0.0,
                out_white: 1.0,
                channels: Some([r(l.r), r(l.g), r(l.b)]),
            });
        }
        if p.brightness != 0.0 || p.contrast != 1.0 {
            ops.push(RasterOp::BrightnessContrast {
                brightness: p.brightness,
                contrast: p.contrast,
            });
        }
        if p.color_balance != ColorBalanceParams::default() {
            let c = &p.color_balance;
            ops.push(RasterOp::ColorBalance {
                shadows: c.shadows,
                midtones: c.midtones,
                highlights: c.highlights,
                preserve_luminosity: true,
            });
        }
        if p.photo_filter.density != 0.0 {
            let f = &p.photo_filter;
            ops.push(RasterOp::PhotoFilter {
                color: f.color,
                density: f.density,
                preserve_luminosity: f.preserve_luminosity,
            });
        }
        if p.channel_mixer != ChannelMixerParams::default() {
            let m = &p.channel_mixer;
            ops.push(RasterOp::channel_mixer(m.r, m.g, m.b));
        }
        if p.vibrance != 0.0 || p.saturation != 1.0 {
            ops.push(RasterOp::Vibrance {
                vibrance: p.vibrance,
                saturation: p.saturation - 1.0,
            });
        }
        if p.black_white.enabled {
            let w = p.black_white.weights;
            ops.push(RasterOp::BlackWhite {
                reds: w[0],
                yellows: w[1],
                greens: w[2],
                cyans: w[3],
                blues: w[4],
                magentas: w[5],
            });
        }
        if let Some(levels) = p.posterize {
            ops.push(RasterOp::Posterize { levels });
        }
        if let Some(level) = p.threshold {
            ops.push(RasterOp::Threshold { level });
        }
        if p.hue_degrees != 0.0 {
            ops.push(hue_rotation(p.hue_degrees));
        }
        if !p.hue_sat.is_identity() {
            let h = &p.hue_sat;
            let t = |v: [f32; 4]| [v[0], v[1], v[2]];
            let ranges = h.ranges.map(t);
            ops.push(RasterOp::HueSaturation {
                hue: h.master[0],
                saturation: h.master[1],
                lightness: h.master[2],
                ranges: ranges.iter().any(|r| *r != [0.0; 3]).then_some(ranges),
                colorize: (h.colorize[0] >= 0.5)
                    .then(|| [h.colorize[1], h.colorize[2], h.colorize[3]]),
            });
        }
        if p.invert {
            ops.push(RasterOp::Invert);
        }
        if p.blur_sigma > 0.0 {
            ops.push(RasterOp::Blur {
                radius: p.blur_sigma,
            });
        }
        if p.sharpen_amount > 0.0 {
            ops.push(RasterOp::Sharpen {
                amount: p.sharpen_amount,
                radius: CHAIN_SHARPEN_RADIUS,
            });
        }
        // The curve tables, last (`adjust_f16`): a curve through every
        // level reproduces its table exactly.
        let every = |t: &[u8; 256]| -> Vec<[f32; 2]> {
            t.iter()
                .enumerate()
                .map(|(i, &o)| [i as f32 / 255.0, f32::from(o) / 255.0])
                .collect()
        };
        if p.curve_lut.is_some() || p.curve_rgb.is_some() {
            ops.push(RasterOp::Curves {
                points: p.curve_lut.as_ref().map(every).unwrap_or_default(),
                channels: p
                    .curve_rgb
                    .as_deref()
                    .map(|c| [every(&c[0]), every(&c[1]), every(&c[2])]),
            });
        }
        AdjustmentOps { ops }
    }

    /// The wire name of the layer's kind: its op's, for a layer of one op
    /// of a typed kind; `"chain"` otherwise.
    pub fn kind_name(&self) -> &'static str {
        match self.ops.as_slice() {
            [op] if ADJUSTMENT_KINDS.contains(&op.name()) => op.name(),
            _ => "chain",
        }
    }

    /// The layer name Photoshop gives a new layer of this kind.
    pub fn default_layer_name(&self) -> &'static str {
        match self.kind_name() {
            "brightnessContrast" => "Brightness/Contrast",
            "levels" => "Levels",
            "curves" => "Curves",
            "exposure" => "Exposure",
            "vibrance" => "Vibrance",
            "hueSaturation" => "Hue/Saturation",
            "colorBalance" => "Color Balance",
            "blackWhite" => "Black & White",
            "photoFilter" => "Photo Filter",
            "channelMixer" => "Channel Mixer",
            "invert" => "Invert",
            "posterize" => "Posterize",
            "threshold" => "Threshold",
            "gradientMap" => "Gradient Map",
            "selectiveColor" => "Selective Color",
            "colorLookup" => "Color Lookup",
            "develop" => "Develop",
            _ => "Adjustment",
        }
    }

    /// A new layer's op of `kind` at Photoshop's defaults (the identity,
    /// except where Photoshop's default already does something: Invert,
    /// Posterize 4, Threshold 128, Black & White, a black-to-white Gradient
    /// Map, Photo Filter's warming filter at 25 %).
    pub fn default_for(kind: &str) -> Option<AdjustmentOps> {
        let op = match kind {
            "brightnessContrast" => RasterOp::BrightnessContrast {
                brightness: 0.0,
                contrast: 1.0,
            },
            "levels" => RasterOp::levels(LevelsRecord::IDENTITY),
            "curves" => RasterOp::curves(Vec::new()),
            "exposure" => RasterOp::exposure(0.0),
            "vibrance" => RasterOp::Vibrance {
                vibrance: 0.0,
                saturation: 0.0,
            },
            "hueSaturation" => RasterOp::hue_saturation(0.0, 0.0, 0.0),
            "colorBalance" => RasterOp::ColorBalance {
                shadows: [0.0; 3],
                midtones: [0.0; 3],
                highlights: [0.0; 3],
                preserve_luminosity: true,
            },
            "blackWhite" => RasterOp::BlackWhite {
                reds: 0.4,
                yellows: 0.6,
                greens: 0.4,
                cyans: 0.6,
                blues: 0.2,
                magentas: 0.8,
            },
            "photoFilter" => RasterOp::PhotoFilter {
                color: [236.0 / 255.0, 138.0 / 255.0, 0.0],
                density: 0.25,
                preserve_luminosity: true,
            },
            "channelMixer" => RasterOp::channel_mixer(
                [1.0, 0.0, 0.0, 0.0],
                [0.0, 1.0, 0.0, 0.0],
                [0.0, 0.0, 1.0, 0.0],
            ),
            "invert" => RasterOp::Invert,
            "posterize" => RasterOp::Posterize { levels: 4.0 },
            "threshold" => RasterOp::Threshold {
                level: 128.0 / 255.0,
            },
            "gradientMap" => RasterOp::GradientMap {
                stops: vec![
                    GradientMapStop {
                        at: 0.0,
                        color: [0.0; 3],
                    },
                    GradientMapStop {
                        at: 1.0,
                        color: [1.0; 3],
                    },
                ],
                reverse: false,
            },
            "selectiveColor" => RasterOp::SelectiveColor {
                ranges: [[0.0; 4]; 9],
                absolute: false,
            },
            "colorLookup" => RasterOp::ColorLookup {
                name: String::new(),
                size: LUT3D_EDGE as u32,
                cube: identity_cube(),
            },
            "develop" => RasterOp::Develop {
                settings: DevelopSettings::identity().0.to_vec(),
            },
            _ => return None,
        };
        Some(AdjustmentOps::one(op))
    }

    /// The flat parameter block the Properties panel reads, in Photoshop's
    /// units. Layouts:
    ///
    /// ```text
    /// brightnessContrast  brightness, contrast
    /// levels              4 × [in_black, in_white, gamma, out_black, out_white]
    /// curves              4 × [n, n × (input, output)]
    /// exposure            exposure, offset, gamma
    /// vibrance            vibrance, saturation
    /// hueSaturation       colorize, colorize h s l, master h s l, 6 × (h s l)
    /// colorBalance        shadows ×3, midtones ×3, highlights ×3
    /// blackWhite          reds, yellows, greens, cyans, blues, magentas
    /// photoFilter         r, g, b, density, preserve
    /// channelMixer        3 × [r, g, b, const], monochrome
    /// invert              —
    /// posterize           levels
    /// threshold           level
    /// gradientMap         reverse, n, n × (at, r, g, b)
    /// selectiveColor      absolute, 9 × (c, m, y, k)
    /// colorLookup         — (the cube is the blob, the name the label)
    /// develop             the 61 Develop settings (families::develop order)
    /// chain               — (the ops are the layer's `ops`)
    /// ```
    pub fn values(&self) -> Vec<f32> {
        let [op] = self.ops.as_slice() else {
            return Vec::new();
        };
        let b = |v: bool| if v { 1.0 } else { 0.0 };
        let lv = |v: f32| ps(v * 255.0);
        let pc = |v: f32| ps(v * 100.0);
        let rec = |r: &LevelsRecord| {
            [
                lv(r.in_black),
                lv(r.in_white),
                ps(r.gamma),
                lv(r.out_black),
                lv(r.out_white),
            ]
        };
        match op {
            RasterOp::BrightnessContrast {
                brightness,
                contrast,
            } => vec![lv(*brightness), pc(contrast - 1.0)],
            RasterOp::Levels {
                in_black,
                in_white,
                gamma,
                out_black,
                out_white,
                channels,
            } => {
                let master = LevelsRecord {
                    in_black: *in_black,
                    in_white: *in_white,
                    gamma: *gamma,
                    out_black: *out_black,
                    out_white: *out_white,
                };
                let ch = channels.unwrap_or([LevelsRecord::IDENTITY; 3]);
                [master, ch[0], ch[1], ch[2]].iter().flat_map(rec).collect()
            }
            RasterOp::Curves { points, channels } => {
                let empty = Vec::new();
                let all = [
                    points,
                    channels.as_ref().map_or(&empty, |c| &c[0]),
                    channels.as_ref().map_or(&empty, |c| &c[1]),
                    channels.as_ref().map_or(&empty, |c| &c[2]),
                ];
                let mut v = Vec::new();
                for c in all {
                    v.push(c.len() as f32);
                    for p in c {
                        v.push(lv(p[0]));
                        v.push(lv(p[1]));
                    }
                }
                v
            }
            RasterOp::Exposure { ev, offset, gamma } => vec![*ev, *offset, *gamma],
            RasterOp::Vibrance {
                vibrance,
                saturation,
            } => vec![pc(*vibrance), pc(*saturation)],
            RasterOp::HueSaturation {
                hue,
                saturation,
                lightness,
                ranges,
                colorize,
            } => {
                let hsl = |t: [f32; 3]| [ps(t[0]), pc(t[1]), pc(t[2])];
                let c = colorize.unwrap_or([0.0, 0.25, 0.0]);
                let mut v = vec![b(colorize.is_some())];
                v.extend_from_slice(&hsl(c));
                v.extend_from_slice(&hsl([*hue, *saturation, *lightness]));
                for r in ranges.unwrap_or([[0.0; 3]; 6]) {
                    v.extend_from_slice(&hsl(r));
                }
                v
            }
            RasterOp::ColorBalance {
                shadows,
                midtones,
                highlights,
                ..
            } => [*shadows, *midtones, *highlights]
                .iter()
                .flat_map(|t| t.map(pc))
                .collect(),
            RasterOp::BlackWhite {
                reds,
                yellows,
                greens,
                cyans,
                blues,
                magentas,
            } => [reds, yellows, greens, cyans, blues, magentas]
                .iter()
                .map(|w| pc(**w))
                .collect(),
            RasterOp::PhotoFilter {
                color,
                density,
                preserve_luminosity,
            } => vec![
                lv(color[0]),
                lv(color[1]),
                lv(color[2]),
                pc(*density),
                b(*preserve_luminosity),
            ],
            RasterOp::ChannelMixer {
                red,
                green,
                blue,
                monochrome,
            } => {
                let mut v: Vec<f32> = [red, green, blue].iter().flat_map(|r| r.map(pc)).collect();
                v.push(b(*monochrome));
                v
            }
            RasterOp::Invert => Vec::new(),
            RasterOp::Posterize { levels } => vec![*levels],
            RasterOp::Threshold { level } => vec![lv(*level)],
            RasterOp::GradientMap { stops, reverse } => {
                let mut v = vec![b(*reverse), stops.len() as f32];
                for s in stops {
                    v.push(s.at);
                    v.extend(s.color.map(lv));
                }
                v
            }
            RasterOp::SelectiveColor { ranges, absolute } => {
                let mut v = vec![b(*absolute)];
                for r in ranges {
                    v.extend(r.map(pc));
                }
                v
            }
            RasterOp::ColorLookup { .. } => Vec::new(),
            RasterOp::Develop { settings } => settings.clone(),
            _ => Vec::new(),
        }
    }

    /// The colour cube of a Color Lookup layer.
    pub fn blob(&self) -> Option<&[f32]> {
        match self.ops.as_slice() {
            [RasterOp::ColorLookup { cube, .. }] => Some(cube),
            _ => None,
        }
    }

    /// The look's name of a Color Lookup layer.
    pub fn label(&self) -> &str {
        match self.ops.as_slice() {
            [RasterOp::ColorLookup { name, .. }] => name,
            _ => "",
        }
    }

    /// Rebuild from [`values`](Self::values) (and a Color Lookup's cube
    /// and name), the panel's units mapped onto the op. Out-of-range values
    /// are clamped to Photoshop's ranges; a block of the wrong length is
    /// refused. `"chain"` is the Adjust panel's chain block
    /// (`AdjustParams::to_wire`).
    pub fn from_wire(
        kind: &str,
        values: &[f32],
        blob: &[f32],
        label: &str,
    ) -> Result<AdjustmentOps, IngestError> {
        let want = |n: usize| -> Result<(), IngestError> {
            if values.len() == n {
                Ok(())
            } else {
                Err(bad(kind, format!("{} values, expected {n}", values.len())))
            }
        };
        let on = |v: f32| v >= 0.5;
        let c = |v: f32, lo: f32, hi: f32| {
            if v.is_finite() {
                v.clamp(lo, hi)
            } else {
                0.0f32.clamp(lo, hi)
            }
        };
        // A level (0–255) as the op's fraction, at the byte Photoshop
        // stores where the value is a colour.
        let byte = |v: f32| c(v, 0.0, 255.0).round() / 255.0;
        let op = match kind {
            "chain" => return Ok(AdjustmentOps::of_chain(&AdjustParams::from_wire(values)?)),
            "brightnessContrast" => {
                want(2)?;
                RasterOp::BrightnessContrast {
                    brightness: c(values[0], -150.0, 150.0) / 255.0,
                    contrast: 1.0 + c(values[1], -50.0, 100.0) / 100.0,
                }
            }
            "levels" => {
                want(20)?;
                let mut records = [LevelsRecord::IDENTITY; 4];
                for (k, r) in records.iter_mut().enumerate() {
                    let v = &values[k * 5..k * 5 + 5];
                    let ib = c(v[0], 0.0, 253.0);
                    let iw = c(v[1], ib + 2.0, 255.0);
                    *r = LevelsRecord {
                        in_black: ib / 255.0,
                        in_white: iw / 255.0,
                        gamma: c(v[2], 0.1, 9.99),
                        out_black: c(v[3], 0.0, 255.0) / 255.0,
                        out_white: c(v[4], 0.0, 255.0) / 255.0,
                    };
                }
                let m = records[0];
                RasterOp::Levels {
                    in_black: m.in_black,
                    in_white: m.in_white,
                    gamma: m.gamma,
                    out_black: m.out_black,
                    out_white: m.out_white,
                    channels: records[1..]
                        .iter()
                        .any(|r| *r != LevelsRecord::IDENTITY)
                        .then(|| [records[1], records[2], records[3]]),
                }
            }
            "curves" => {
                let mut curves: [Vec<[f32; 2]>; 4] = Default::default();
                let mut at = 0usize;
                for curve in &mut curves {
                    let n = *values
                        .get(at)
                        .ok_or_else(|| bad(kind, "the block ends before a curve"))?;
                    at += 1;
                    let n = c(n, 0.0, 64.0) as usize;
                    let pts = values
                        .get(at..at + n * 2)
                        .ok_or_else(|| bad(kind, "a curve's points run past the block"))?;
                    at += n * 2;
                    let mut p: Vec<(u8, u8)> = pts
                        .as_chunks::<2>()
                        .0
                        .iter()
                        .map(|q| {
                            (
                                c(q[0], 0.0, 255.0).round() as u8,
                                c(q[1], 0.0, 255.0).round() as u8,
                            )
                        })
                        .collect();
                    p.sort_by_key(|q| q.0);
                    p.dedup_by_key(|q| q.0);
                    *curve = p
                        .iter()
                        .map(|&(i, o)| [f32::from(i) / 255.0, f32::from(o) / 255.0])
                        .collect();
                }
                if at != values.len() {
                    return Err(bad(kind, "values after the four curves"));
                }
                let [m, r, g, b] = curves;
                let channels =
                    (!(r.is_empty() && g.is_empty() && b.is_empty())).then_some([r, g, b]);
                RasterOp::Curves {
                    points: m,
                    channels,
                }
            }
            "exposure" => {
                want(3)?;
                RasterOp::Exposure {
                    ev: c(values[0], -20.0, 20.0),
                    offset: c(values[1], -0.5, 0.5),
                    gamma: c(values[2], 0.01, 9.99),
                }
            }
            "vibrance" => {
                want(2)?;
                RasterOp::Vibrance {
                    vibrance: c(values[0], -100.0, 100.0) / 100.0,
                    saturation: c(values[1], -100.0, 100.0) / 100.0,
                }
            }
            "hueSaturation" => {
                want(25)?;
                let hsl = |o: usize| {
                    [
                        c(values[o], -180.0, 360.0),
                        c(values[o + 1], -100.0, 100.0) / 100.0,
                        c(values[o + 2], -100.0, 100.0) / 100.0,
                    ]
                };
                let ranges: [[f32; 3]; 6] = std::array::from_fn(|k| hsl(7 + k * 3));
                let master = hsl(4);
                let colorize = hsl(1);
                RasterOp::HueSaturation {
                    hue: master[0],
                    saturation: master[1],
                    lightness: master[2],
                    ranges: ranges.iter().any(|r| *r != [0.0; 3]).then_some(ranges),
                    colorize: on(values[0])
                        .then(|| [colorize[0].rem_euclid(360.0), colorize[1], colorize[2]]),
                }
            }
            "colorBalance" => {
                want(9)?;
                let t = |o: usize| [0, 1, 2].map(|i| c(values[o + i], -100.0, 100.0) / 100.0);
                RasterOp::ColorBalance {
                    shadows: t(0),
                    midtones: t(3),
                    highlights: t(6),
                    preserve_luminosity: true,
                }
            }
            "blackWhite" => {
                want(6)?;
                let w: [f32; 6] = std::array::from_fn(|i| c(values[i], -200.0, 300.0) / 100.0);
                RasterOp::BlackWhite {
                    reds: w[0],
                    yellows: w[1],
                    greens: w[2],
                    cyans: w[3],
                    blues: w[4],
                    magentas: w[5],
                }
            }
            "photoFilter" => {
                want(5)?;
                RasterOp::PhotoFilter {
                    color: [byte(values[0]), byte(values[1]), byte(values[2])],
                    density: c(values[3], 0.0, 100.0) / 100.0,
                    preserve_luminosity: on(values[4]),
                }
            }
            "channelMixer" => {
                want(13)?;
                let row = |r: usize| -> [f32; 4] {
                    std::array::from_fn(|k| c(values[r * 4 + k], -200.0, 200.0) / 100.0)
                };
                RasterOp::ChannelMixer {
                    red: row(0),
                    green: row(1),
                    blue: row(2),
                    monochrome: on(values[12]),
                }
            }
            "invert" => {
                want(0)?;
                RasterOp::Invert
            }
            "posterize" => {
                want(1)?;
                RasterOp::Posterize {
                    levels: c(values[0], 2.0, 255.0).round(),
                }
            }
            "threshold" => {
                want(1)?;
                RasterOp::Threshold {
                    level: c(values[0], 1.0, 255.0).round() / 255.0,
                }
            }
            "gradientMap" => {
                let n = values
                    .get(1)
                    .map(|&n| c(n, 0.0, 64.0) as usize)
                    .ok_or_else(|| bad(kind, "no stop count"))?;
                want(2 + n * 4)?;
                if n < 2 {
                    return Err(bad(kind, "a gradient needs at least two stops"));
                }
                RasterOp::GradientMap {
                    stops: values[2..]
                        .as_chunks::<4>()
                        .0
                        .iter()
                        .map(|s| GradientMapStop {
                            at: c(s[0], 0.0, 1.0),
                            color: [byte(s[1]), byte(s[2]), byte(s[3])],
                        })
                        .collect(),
                    reverse: on(values[0]),
                }
            }
            "selectiveColor" => {
                want(37)?;
                RasterOp::SelectiveColor {
                    ranges: std::array::from_fn(|r| {
                        std::array::from_fn(|k| c(values[1 + r * 4 + k], -100.0, 100.0) / 100.0)
                    }),
                    absolute: on(values[0]),
                }
            }
            "colorLookup" => {
                want(0)?;
                let n = LUT3D_EDGE * LUT3D_EDGE * LUT3D_EDGE * 3;
                if blob.len() != n {
                    return Err(bad(
                        kind,
                        format!("a cube of {} values, expected {n}", blob.len()),
                    ));
                }
                RasterOp::ColorLookup {
                    name: label.to_string(),
                    size: LUT3D_EDGE as u32,
                    cube: blob.iter().map(|&v| c(v, 0.0, 1.0)).collect(),
                }
            }
            "develop" => {
                use image_kernels::families::develop::DEVELOP_LEN;
                want(DEVELOP_LEN)?;
                RasterOp::Develop {
                    settings: DevelopSettings::from_values(values)
                        .ok_or_else(|| bad(kind, "a Develop block of the wrong length"))?
                        .0
                        .to_vec(),
                }
            }
            other => {
                return Err(IngestError::Unsupported(format!(
                    "unknown adjustment kind \"{other}\" (one of {})",
                    ADJUSTMENT_KINDS.join(", ")
                )))
            }
        };
        Ok(AdjustmentOps::one(op))
    }

    /// How the layer fold evaluates the ops on the GPU: the chain-stage and
    /// table ops as consecutive adjust-chain blocks (a new block where an
    /// op's stage does not follow the block's last, or after a table), the
    /// point-kernel ops as direct dispatches. `None` for a stack that mixes
    /// the two, or carries an op no kernel evaluates in a layer (a colour
    /// replace, a sharpen of another radius than the chain's): no
    /// adjustment layer is made of one.
    pub fn gpu_plan(&self) -> Option<GpuPlan> {
        let mut blocks: Vec<AdjustParams> = Vec::new();
        let mut direct = Vec::new();
        let mut cur = AdjustParams::default();
        let mut last = 0u8;
        let mut has_table = false;
        let mut open = false;
        let mut is_direct = false;
        for op in &self.ops {
            if let Some(d) = direct_ops(op) {
                direct.extend(d);
                is_direct = true;
                continue;
            }
            if let Some((rgb, comp)) = op_tables(op) {
                if rgb.is_none() && comp.is_none() {
                    continue;
                }
                if has_table {
                    blocks.push(std::mem::take(&mut cur));
                    last = 0;
                }
                cur.curve_rgb = rgb.map(Box::new);
                cur.curve_lut = comp;
                has_table = true;
                open = true;
                continue;
            }
            let (lo, hi) = chain_stages(op)?;
            if has_table || lo <= last {
                blocks.push(std::mem::take(&mut cur));
                has_table = false;
            }
            set_stage(&mut cur, op);
            last = hi;
            open = true;
        }
        if open {
            blocks.push(cur);
        }
        match (blocks.is_empty(), is_direct) {
            (_, false) => Some(GpuPlan::Chain(blocks)),
            (true, true) => Some(GpuPlan::Direct(direct)),
            (false, true) => None,
        }
    }

    /// The single adjust-chain block of a layer that evaluates as one,
    /// `None` otherwise.
    pub fn to_chain(&self) -> Option<AdjustParams> {
        match self.gpu_plan()? {
            GpuPlan::Chain(mut b) if b.len() <= 1 => Some(b.pop().unwrap_or_default()),
            _ => None,
        }
    }

    /// Does this adjustment leave every pixel as it is?
    pub fn is_identity(&self) -> bool {
        self.ops.iter().all(|op| match op {
            RasterOp::SelectiveColor { ranges, .. } => {
                ranges.iter().all(|r| r.iter().all(|v| *v == 0.0))
            }
            RasterOp::ColorLookup { size, cube, .. } => {
                *cube == tables::identity_cube(*size as usize)
            }
            RasterOp::Develop { settings } => {
                DevelopSettings::from_values(settings).is_none_or(|s| s.is_identity())
            }
            RasterOp::GradientMap { .. } | RasterOp::Duotone { .. } => false,
            other => AdjustmentOps::one(other.clone())
                .to_chain()
                .is_some_and(|p| p.is_identity()),
        })
    }
}

/// The chain's hue rotation (the luminance-preserving rotation of
/// `adjust.hue_rotate`) as the channel mixer of its matrix, which is CSS's
/// `hue-rotate()` exactly.
pub fn hue_rotation(degrees: f32) -> RasterOp {
    let theta = degrees * std::f32::consts::PI / 180.0;
    let (cs, sn) = (theta.cos(), theta.sin());
    RasterOp::channel_mixer(
        [
            0.213 + cs * 0.787 + sn * (-0.213),
            0.715 + cs * (-0.715) + sn * (-0.715),
            0.072 + cs * (-0.072) + sn * 0.928,
            0.0,
        ],
        [
            0.213 + cs * (-0.213) + sn * 0.143,
            0.715 + cs * 0.285 + sn * 0.140,
            0.072 + cs * (-0.072) + sn * (-0.283),
            0.0,
        ],
        [
            0.213 + cs * (-0.213) + sn * (-0.787),
            0.715 + cs * (-0.715) + sn * 0.715,
            0.072 + cs * 0.928 + sn * 0.072,
            0.0,
        ],
    )
}

#[cfg(test)]
#[allow(non_snake_case)] // `__feat__` suffixes link the cockpit feature rows.
mod tests {
    use super::*;

    #[test]
    fn every_typed_kind_round_trips_its_wire_block__feat__image_layers_photoshop_parity() {
        for kind in ADJUSTMENT_KINDS {
            let a = AdjustmentOps::default_for(kind).expect("a default");
            assert_eq!(a.kind_name(), kind);
            assert!(a.ops.iter().all(RasterOp::is_valid), "{kind}");
            let back =
                AdjustmentOps::from_wire(kind, &a.values(), a.blob().unwrap_or(&[]), a.label())
                    .expect("wire");
            assert_eq!(back, a, "{kind}");
            // Every chain kind lowers; the four direct kinds dispatch.
            assert_eq!(
                a.to_chain().is_none(),
                matches!(
                    kind,
                    "gradientMap" | "selectiveColor" | "colorLookup" | "develop"
                ),
                "{kind}"
            );
        }
        assert!(AdjustmentOps::from_wire("levels", &[0.0; 3], &[], "").is_err());
        assert!(AdjustmentOps::from_wire("sepia", &[], &[], "").is_err());
    }

    #[test]
    fn photoshop_units_read_back_as_they_were_set__feat__image_layers_photoshop_parity() {
        let bc =
            AdjustmentOps::from_wire("brightnessContrast", &[37.0, -22.0], &[], "").expect("wire");
        assert_eq!(bc.values(), vec![37.0, -22.0]);
        let mut lv = vec![0.0, 255.0, 1.0, 0.0, 255.0];
        lv = [lv.as_slice(), &[12.0, 240.0, 0.87, 3.0, 250.0], &lv, &lv].concat();
        lv[0] = 5.0;
        let l = AdjustmentOps::from_wire("levels", &lv, &[], "").expect("wire");
        assert_eq!(l.values(), lv);
        assert!(matches!(
            l.ops[0],
            RasterOp::Levels {
                channels: Some(_),
                ..
            }
        ));
    }

    #[test]
    fn the_identity_kinds_are_the_identity__feat__image_layers_photoshop_parity() {
        for kind in [
            "brightnessContrast",
            "levels",
            "curves",
            "exposure",
            "vibrance",
            "hueSaturation",
            "colorBalance",
            "channelMixer",
            "selectiveColor",
            "colorLookup",
            "develop",
        ] {
            assert!(
                AdjustmentOps::default_for(kind)
                    .expect("kind")
                    .is_identity(),
                "{kind}"
            );
        }
        for kind in [
            "invert",
            "posterize",
            "threshold",
            "gradientMap",
            "blackWhite",
        ] {
            assert!(
                !AdjustmentOps::default_for(kind)
                    .expect("kind")
                    .is_identity(),
                "{kind}"
            );
        }
    }

    fn direct(a: &AdjustmentOps) -> Vec<&'static str> {
        match a.gpu_plan() {
            Some(GpuPlan::Direct(d)) => d.iter().map(|(k, _)| k.id).collect(),
            _ => Vec::new(),
        }
    }

    /// The Develop layer (WP5.2): its wire block is the 61 settings in
    /// `families::develop`'s order, values clamp to their ranges, the
    /// wrong length is refused, and it dispatches the develop kernels —
    /// tone then detail, an identity half skipped.
    #[test]
    fn a_develop_layer_carries_its_61_settings_and_dispatches_the_develop_kernels__feat__image_editor_filters(
    ) {
        use image_kernels::families::develop::DEVELOP_LEN;
        let d = AdjustmentOps::default_for("develop").expect("develop");
        assert_eq!(d.kind_name(), "develop");
        assert_eq!(d.default_layer_name(), "Develop");
        assert_eq!(d.values(), DevelopSettings::identity().0.to_vec());
        assert!(d.is_identity() && direct(&d).is_empty());
        let mut v = DevelopSettings::identity().0.to_vec();
        v[2] = 1.5; // exposure
        v[9] = 250.0; // clarity, past its range
        let a = AdjustmentOps::from_wire("develop", &v, &[], "").expect("wire");
        assert_eq!(a.values()[2], 1.5);
        assert_eq!(a.values()[9], 100.0, "clamped to the range");
        assert!(!a.is_identity());
        assert_eq!(direct(&a), ["develop.tone", "develop.detail"]);
        v[9] = 0.0;
        let tone_only = AdjustmentOps::from_wire("develop", &v, &[], "").expect("wire");
        assert_eq!(direct(&tone_only), ["develop.tone"]);
        assert!(AdjustmentOps::from_wire("develop", &[0.0; DEVELOP_LEN - 1], &[], "").is_err());
        assert_eq!(ADJUSTMENT_KINDS.last(), Some(&"develop"));
    }

    /// A one-stage chain opens as its typed layer; a chain of several
    /// stages becomes its stages as ops and evaluates as the same one
    /// block (the migration of a stored chain).
    #[test]
    fn a_stored_chain_migrates_to_its_ops__feat__image_layers_photoshop_parity() {
        let one = AdjustParams {
            exposure_ev: 0.75,
            ..AdjustParams::default()
        };
        let typed = AdjustmentOps::of_chain(&one);
        assert_eq!(typed.kind_name(), "exposure");
        assert_eq!(typed.to_chain(), Some(one));
        let post = AdjustParams {
            posterize: Some(5.0),
            ..AdjustParams::default()
        };
        assert_eq!(
            AdjustmentOps::of_chain(&post).ops,
            vec![RasterOp::Posterize { levels: 5.0 }]
        );
        let many = AdjustParams {
            exposure_ev: 0.5,
            brightness: 0.1,
            contrast: 1.2,
            temp: 0.1,
            vibrance: 0.3,
            black_white: BlackWhiteParams {
                enabled: true,
                weights: [0.4, 0.6, 0.4, 0.6, 0.2, 0.8],
            },
            invert: true,
            blur_sigma: 2.0,
            sharpen_amount: 0.5,
            ..AdjustParams::default()
        };
        let ops = AdjustmentOps::of_chain(&many);
        assert_eq!(ops.kind_name(), "chain");
        assert_eq!(ops.to_chain(), Some(many), "one block, field for field");
    }

    /// The panel's curve tables become curves through every level, which
    /// reproduce them exactly; its Levels, its hue rotation and a stage out
    /// of the chain's order start blocks of their own, in order.
    #[test]
    fn a_chain_with_tables_and_a_hue_rotation_keeps_its_order__feat__image_layers_photoshop_parity()
    {
        let lut: [u8; 256] =
            std::array::from_fn(|i| ((i as f32 / 255.0).powf(0.6) * 255.0).round() as u8);
        let mut rgb = [tables::identity_table(); 3];
        rgb[2] = std::array::from_fn(|i| (255 - i) as u8);
        let p = AdjustParams {
            curve_lut: Some(lut),
            curve_rgb: Some(Box::new(rgb)),
            ..AdjustParams::default()
        };
        let ops = AdjustmentOps::of_chain(&p);
        let back = ops.to_chain().expect("one block");
        assert_eq!(back.curve_lut, Some(lut));
        assert_eq!(back.curve_rgb.as_deref(), Some(&rgb));

        let p = AdjustParams {
            exposure_ev: 0.3,
            levels: LevelsParams {
                in_black: 0.1,
                ..LevelsParams::default()
            },
            brightness: 0.1,
            channel_mixer: ChannelMixerParams {
                r: [0.9, 0.1, 0.0, 0.0],
                ..ChannelMixerParams::default()
            },
            hue_degrees: 30.0,
            ..AdjustParams::default()
        };
        let Some(GpuPlan::Chain(blocks)) = AdjustmentOps::of_chain(&p).gpu_plan() else {
            panic!("chain blocks");
        };
        // exposure + the Levels table | brightness + the mixer | the
        // rotation's mixer.
        assert_eq!(blocks.len(), 3, "{blocks:?}");
        assert!(blocks[0].exposure_ev == 0.3 && blocks[0].curve_lut.is_some());
        assert!(blocks[1].brightness == 0.1 && blocks[1].channel_mixer.r[0] == 0.9);
        assert!(blocks[2].channel_mixer != ChannelMixerParams::default());
    }

    #[test]
    fn a_stack_no_kernel_evaluates_has_no_plan__feat__image_layers_photoshop_parity() {
        let replace = AdjustmentOps::one(RasterOp::ColorReplace {
            from: [1.0; 3],
            to: [0.0; 3],
            alpha: 1.0,
            tolerance: 0.0,
        });
        assert_eq!(replace.gpu_plan(), None);
        let mixed = AdjustmentOps {
            ops: vec![
                RasterOp::Invert,
                AdjustmentOps::default_for("gradientMap").expect("kind").ops[0].clone(),
            ],
        };
        assert_eq!(mixed.gpu_plan(), None);
    }
}
