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

//! Engine ADR 1037 — the image filter stack of an image frame: quick
//! picture fixes (exposure, levels, curves, hue/saturation, duotone,
//! recolor, black & white, sharpen, blur and a few artistic ones) that a
//! placed picture is drawn through, in order, without opening it in an
//! image editor.
//!
//! The ops are data: the renderer evaluates them on the CPU through the
//! kernel twins of `paged-kernels`, the PDF export embeds the result, and
//! IDML, which has no such construct, keeps the stack in a label and
//! reports it as lost (`IMAGE_ADJUSTMENTS_LABEL`).
//!
//! Every colour value is in the picture's own encoded RGB, 0..=1; every
//! length (a blur radius) in the picture's own pixels, so the look does
//! not change with the size the picture is placed or drawn at.

use serde::{Deserialize, Serialize};

/// The `<KeyValuePair>` label key an IDML export writes the stack under
/// (its JSON form), and the import reads it back from.
pub const IMAGE_ADJUSTMENTS_LABEL: &str = "paged:imageAdjustments";

/// The number of settings a [`RasterOp::Develop`] carries (the layout of
/// `paged_kernels::families::develop`, whose `DEVELOP_LEN` it equals).
pub const DEVELOP_SETTINGS: usize = 61;

/// The largest colour cube edge a [`RasterOp::ColorLookup`] carries.
pub const COLOR_LOOKUP_MAX_SIZE: u32 = 65;

/// One Levels record: input black and white, the midtone gamma (1 the
/// identity), output black and white; levels 0..=1.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "wire", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wire", tsify(into_wasm_abi, from_wasm_abi))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct LevelsRecord {
    pub in_black: f32,
    pub in_white: f32,
    pub gamma: f32,
    pub out_black: f32,
    pub out_white: f32,
}

impl LevelsRecord {
    /// The record that leaves every level as it is.
    pub const IDENTITY: LevelsRecord = LevelsRecord {
        in_black: 0.0,
        in_white: 1.0,
        gamma: 1.0,
        out_black: 0.0,
        out_white: 1.0,
    };

    fn is_valid(&self) -> bool {
        let v = [
            self.in_black,
            self.in_white,
            self.gamma,
            self.out_black,
            self.out_white,
        ];
        let unit = |x: f32| (0.0..=1.0).contains(&x);
        v.iter().all(|x| x.is_finite())
            && unit(self.in_black)
            && unit(self.in_white)
            && self.in_black < self.in_white
            && self.gamma > 0.0
            && self.gamma <= 10.0
            && unit(self.out_black)
            && unit(self.out_white)
    }
}

/// A colour stop of a [`RasterOp::GradientMap`]: where (0..=1) and which
/// colour (RGB 0..=1).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "wire", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wire", tsify(into_wasm_abi, from_wasm_abi))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct GradientMapStop {
    pub at: f32,
    pub color: [f32; 3],
}

fn is_zero(v: &f32) -> bool {
    *v == 0.0
}
fn is_one(v: &f32) -> bool {
    *v == 1.0
}
fn one() -> f32 {
    1.0
}
fn is_false(v: &bool) -> bool {
    !*v
}
fn is_true(v: &bool) -> bool {
    *v
}
fn yes() -> bool {
    true
}

/// One step of an image frame's filter stack (engine ADR 1037), and of an
/// adjustment layer of paged.image (amendment 2026-11-11, "one adjustment
/// model"): the superset of Photoshop's adjustment layers, Office's picture
/// corrections and CSS's filter functions. Each format's encoding is mapped
/// onto these ops by its reader and off them by its writer.
///
/// A field added to an op after it shipped is optional on the wire: an op
/// written before reads with its default, and an op at the default writes
/// as before (so a stored stack hashes as before).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "wire", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wire", tsify(into_wasm_abi, from_wasm_abi, missing_as_null))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum RasterOp {
    /// Exposure in stops, applied to the light (a 2.2 decode): +1 doubles
    /// it. `adjust.exposure` on encoded input. Photoshop's `offset`
    /// (−0.5..=0.5, added to the light) and `gamma` (0.01..=9.99, the
    /// light raised to 1/gamma) are optional; with either set the op is
    /// Photoshop's measured exposure table.
    Exposure {
        ev: f32,
        #[serde(default, skip_serializing_if = "is_zero")]
        offset: f32,
        #[serde(default = "one", skip_serializing_if = "is_one")]
        gamma: f32,
    },
    /// Brightness as an offset (−1..=1) and contrast as a slope about
    /// mid-grey (1 the identity). `adjust.brightness_contrast`.
    BrightnessContrast { brightness: f32, contrast: f32 },
    /// Photoshop's Levels: input black and white points, the midtone
    /// gamma (1 the identity), output black and white — the composite
    /// record — and optionally one record per channel (`channels`: red,
    /// green, blue), applied before the composite, as Photoshop applies
    /// them. Evaluated as Photoshop's 8-bit tables.
    Levels {
        in_black: f32,
        in_white: f32,
        gamma: f32,
        out_black: f32,
        out_white: f32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        channels: Option<[LevelsRecord; 3]>,
    },
    /// A tone curve through control points `[input, output]` (0..=1),
    /// Photoshop's natural cubic spline, on every channel; optionally a
    /// curve per channel (`channels`: red, green, blue; an empty list is
    /// that channel's identity), applied before the composite one. At most
    /// 256 points: a freehand curve is the curve through every level.
    Curves {
        points: Vec<[f32; 2]>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        channels: Option<[Vec<[f32; 2]>; 3]>,
    },
    /// Hue (degrees), saturation and lightness (−1..=1) on the whole
    /// picture — `adjust.hue_saturation`'s master row — and optionally
    /// Photoshop's six colour ranges (`ranges`: reds, yellows, greens,
    /// cyans, blues, magentas, each hue, saturation, lightness) and its
    /// Colorize (`colorize`: hue 0..=360, saturation 0..=1, lightness
    /// −1..=1), which replaces the rest when set.
    HueSaturation {
        hue: f32,
        saturation: f32,
        lightness: f32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        ranges: Option<[[f32; 3]; 6]>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        colorize: Option<[f32; 3]>,
    },
    /// Recolour to one hue: the picture's tones in `hue` (degrees) at
    /// `saturation` (0..=1), lightness shifted by `lightness` (−1..=1).
    /// `adjust.hue_saturation`'s colorize.
    Recolor {
        hue: f32,
        saturation: f32,
        lightness: f32,
    },
    /// Two inks: the picture's luminance mapped from `shadow` to
    /// `highlight` (RGB). `adjust.gradient_map` with two stops.
    Duotone {
        shadow: [f32; 3],
        highlight: [f32; 3],
    },
    /// Photoshop's Black & White: a grey mixed from six colour ranges
    /// (its default weights are 0.4, 0.6, 0.4, 0.6, 0.2, 0.8).
    /// `adjust.black_white`.
    BlackWhite {
        reds: f32,
        yellows: f32,
        greens: f32,
        cyans: f32,
        blues: f32,
        magentas: f32,
    },
    /// Unsharp mask: `amount` (1 = 100 %) of the difference from a
    /// Gaussian blur of `radius` pixels (σ, at most 64). `conv.unsharp`.
    Sharpen { amount: f32, radius: f32 },
    /// Gaussian blur of `radius` pixels (σ, at most 64: a wide blur runs
    /// as several passes). `conv.gaussian_h`/`_v`.
    Blur { radius: f32 },
    /// Posterize to `levels` tones per channel (2..). `adjust.posterize`.
    Posterize { levels: f32 },
    /// Black where the luminance is below `level` (0..=1), white above.
    /// `adjust.threshold`.
    Threshold { level: f32 },
    /// A negative (alpha kept).
    Invert,
    /// Photoshop's Channel Mixer: each output channel (`red`, `green`,
    /// `blue`) is `[from red, from green, from blue, constant]` applied to
    /// the input, as fractions (1 = 100 %), the result clamped.
    /// `adjust.channel_mixer`. A CSS colour filter (`grayscale`, `sepia`,
    /// `saturate`, `hue-rotate`) is one exactly (amendment 2026-11-11).
    /// `monochrome` (Photoshop's checkbox) makes every output the red row.
    ChannelMixer {
        red: [f32; 4],
        green: [f32; 4],
        blue: [f32; 4],
        #[serde(default, skip_serializing_if = "is_false")]
        monochrome: bool,
    },
    /// Replace a colour: a pixel within `tolerance` (per channel, 0..=1) of
    /// `from` becomes `to`, its alpha multiplied by `alpha` (0 makes the
    /// colour transparent). Office's `a:clrChange` (amendment 2026-11-11).
    ColorReplace {
        from: [f32; 3],
        to: [f32; 3],
        alpha: f32,
        tolerance: f32,
    },
    /// Photoshop's Vibrance: `vibrance` (−1..=1) raises the saturation of
    /// the dull colours more than of the vivid ones, then `saturation`
    /// (−1..=1) scales every colour's. `adjust.vibrance`, `adjust.saturation`.
    Vibrance { vibrance: f32, saturation: f32 },
    /// Photoshop's Color Balance: per tonal range the (cyan–red,
    /// magenta–green, yellow–blue) shifts, −1..=1. `adjust.color_balance`,
    /// which keeps the luminosity; `preserve_luminosity` is carried for the
    /// formats that store it.
    ColorBalance {
        shadows: [f32; 3],
        midtones: [f32; 3],
        highlights: [f32; 3],
        #[serde(default = "yes", skip_serializing_if = "is_true")]
        preserve_luminosity: bool,
    },
    /// Photoshop's Photo Filter: a coloured gel (`color`, RGB 0..=1) at
    /// `density` (0..=1), the luminosity kept or not.
    /// `adjust.photo_filter`.
    PhotoFilter {
        color: [f32; 3],
        density: f32,
        #[serde(default = "yes", skip_serializing_if = "is_true")]
        preserve_luminosity: bool,
    },
    /// Photoshop's Selective Color: for each of nine ranges (reds, yellows,
    /// greens, cyans, blues, magentas, whites, neutrals, blacks) the
    /// (cyan, magenta, yellow, black) change, −1..=1, relative to the
    /// amount there or `absolute`. `adjust.selective_color`.
    SelectiveColor {
        ranges: [[f32; 4]; 9],
        #[serde(default, skip_serializing_if = "is_false")]
        absolute: bool,
    },
    /// Photoshop's Gradient Map: the luminance mapped through colour stops
    /// (two to 64, linear between them, flat beyond the ends), reversed
    /// when asked. `adjust.gradient_map`. A duotone is one with two stops.
    GradientMap {
        stops: Vec<GradientMapStop>,
        #[serde(default, skip_serializing_if = "is_false")]
        reverse: bool,
    },
    /// Photoshop's Color Lookup: a 3D colour table of `size`³ entries
    /// (`cube`: RGB triples 0..=1, red fastest, then green, then blue),
    /// interpolated trilinearly; `name` is the look it came from.
    /// `adjust.lut3d`.
    ColorLookup {
        #[serde(default, skip_serializing_if = "String::is_empty")]
        name: String,
        size: u32,
        cube: Vec<f32>,
    },
    /// The Camera Raw-class Develop adjustment: the [`DEVELOP_SETTINGS`]
    /// settings of `paged_kernels::families::develop`, in Lightroom /
    /// Camera Raw units. `develop.tone`, then `develop.detail`.
    Develop { settings: Vec<f32> },
    /// White balance as channel gains: red × (1 + `temperature`), green ×
    /// (1 + `tint`), blue × (1 − `temperature`), each −1..=1.
    /// `adjust.white_balance`.
    WhiteBalance { temperature: f32, tint: f32 },
}

impl RasterOp {
    /// Exposure in stops, without Photoshop's offset and gamma.
    pub fn exposure(ev: f32) -> RasterOp {
        RasterOp::Exposure {
            ev,
            offset: 0.0,
            gamma: 1.0,
        }
    }

    /// A composite curve alone.
    pub fn curves(points: Vec<[f32; 2]>) -> RasterOp {
        RasterOp::Curves {
            points,
            channels: None,
        }
    }

    /// The composite Levels record alone.
    pub fn levels(record: LevelsRecord) -> RasterOp {
        RasterOp::Levels {
            in_black: record.in_black,
            in_white: record.in_white,
            gamma: record.gamma,
            out_black: record.out_black,
            out_white: record.out_white,
            channels: None,
        }
    }

    /// Hue/saturation on the master row alone.
    pub fn hue_saturation(hue: f32, saturation: f32, lightness: f32) -> RasterOp {
        RasterOp::HueSaturation {
            hue,
            saturation,
            lightness,
            ranges: None,
            colorize: None,
        }
    }

    /// A colour channel mixer (not monochrome).
    pub fn channel_mixer(red: [f32; 4], green: [f32; 4], blue: [f32; 4]) -> RasterOp {
        RasterOp::ChannelMixer {
            red,
            green,
            blue,
            monochrome: false,
        }
    }

    /// The camelCase name the wire and the label spell the op with.
    pub fn name(&self) -> &'static str {
        match self {
            RasterOp::Exposure { .. } => "exposure",
            RasterOp::BrightnessContrast { .. } => "brightnessContrast",
            RasterOp::Levels { .. } => "levels",
            RasterOp::Curves { .. } => "curves",
            RasterOp::HueSaturation { .. } => "hueSaturation",
            RasterOp::Recolor { .. } => "recolor",
            RasterOp::Duotone { .. } => "duotone",
            RasterOp::BlackWhite { .. } => "blackWhite",
            RasterOp::Sharpen { .. } => "sharpen",
            RasterOp::Blur { .. } => "blur",
            RasterOp::Posterize { .. } => "posterize",
            RasterOp::Threshold { .. } => "threshold",
            RasterOp::Invert => "invert",
            RasterOp::ChannelMixer { .. } => "channelMixer",
            RasterOp::ColorReplace { .. } => "colorReplace",
            RasterOp::Vibrance { .. } => "vibrance",
            RasterOp::ColorBalance { .. } => "colorBalance",
            RasterOp::PhotoFilter { .. } => "photoFilter",
            RasterOp::SelectiveColor { .. } => "selectiveColor",
            RasterOp::GradientMap { .. } => "gradientMap",
            RasterOp::ColorLookup { .. } => "colorLookup",
            RasterOp::Develop { .. } => "develop",
            RasterOp::WhiteBalance { .. } => "whiteBalance",
        }
    }

    /// Whether every number is finite and in the op's range. A stack
    /// written through the wire is checked with it; the renderer clamps
    /// anyway.
    pub fn is_valid(&self) -> bool {
        let fin = |v: &[f32]| v.iter().all(|x| x.is_finite());
        let unit = |x: f32| (0.0..=1.0).contains(&x);
        let signed = |x: f32| (-1.0..=1.0).contains(&x);
        let curve =
            |p: &[[f32; 2]]| p.len() <= 256 && p.iter().all(|p| fin(p) && unit(p[0]) && unit(p[1]));
        match *self {
            RasterOp::Exposure { ev, offset, gamma } => {
                fin(&[ev, offset, gamma])
                    && ev.abs() <= 20.0
                    && offset.abs() <= 0.5
                    && (0.01..=10.0).contains(&gamma)
            }
            RasterOp::BrightnessContrast {
                brightness,
                contrast,
            } => {
                fin(&[brightness, contrast])
                    && signed(brightness)
                    && (0.0..=10.0).contains(&contrast)
            }
            RasterOp::Levels {
                in_black,
                in_white,
                gamma,
                out_black,
                out_white,
                ref channels,
            } => {
                LevelsRecord {
                    in_black,
                    in_white,
                    gamma,
                    out_black,
                    out_white,
                }
                .is_valid()
                    && channels
                        .as_ref()
                        .is_none_or(|c| c.iter().all(LevelsRecord::is_valid))
            }
            RasterOp::Curves {
                ref points,
                ref channels,
            } => curve(points) && channels.as_ref().is_none_or(|c| c.iter().all(|p| curve(p))),
            RasterOp::HueSaturation {
                hue,
                saturation,
                lightness,
                ranges,
                colorize,
            } => {
                let hsl =
                    |t: [f32; 3]| fin(&t) && t[0].abs() <= 360.0 && signed(t[1]) && signed(t[2]);
                hsl([hue, saturation, lightness])
                    && ranges.is_none_or(|r| r.iter().all(|t| hsl(*t)))
                    && colorize.is_none_or(|c| {
                        fin(&c) && (0.0..=360.0).contains(&c[0]) && unit(c[1]) && signed(c[2])
                    })
            }
            RasterOp::Recolor {
                hue,
                saturation,
                lightness,
            } => {
                fin(&[hue, saturation, lightness])
                    && hue.abs() <= 360.0
                    && unit(saturation)
                    && signed(lightness)
            }
            RasterOp::Duotone { shadow, highlight } => {
                fin(&shadow) && fin(&highlight) && shadow.iter().chain(&highlight).all(|&c| unit(c))
            }
            RasterOp::BlackWhite {
                reds,
                yellows,
                greens,
                cyans,
                blues,
                magentas,
            } => {
                let w = [reds, yellows, greens, cyans, blues, magentas];
                fin(&w) && w.iter().all(|x| (-2.0..=3.0).contains(x))
            }
            RasterOp::Sharpen { amount, radius } => {
                fin(&[amount, radius])
                    && (0.0..=5.0).contains(&amount)
                    && (0.0..=64.0).contains(&radius)
            }
            RasterOp::Blur { radius } => fin(&[radius]) && (0.0..=64.0).contains(&radius),
            RasterOp::Posterize { levels } => fin(&[levels]) && (2.0..=255.0).contains(&levels),
            RasterOp::Threshold { level } => fin(&[level]) && unit(level),
            RasterOp::Invert => true,
            RasterOp::ChannelMixer {
                red, green, blue, ..
            } => [red, green, blue].iter().all(|row| {
                fin(row) && row[..3].iter().all(|x| (-2.0..=2.0).contains(x)) && signed(row[3])
            }),
            RasterOp::ColorReplace {
                from,
                to,
                alpha,
                tolerance,
            } => {
                fin(&from)
                    && fin(&to)
                    && fin(&[alpha, tolerance])
                    && from.iter().chain(&to).all(|&c| unit(c))
                    && unit(alpha)
                    && unit(tolerance)
            }
            RasterOp::Vibrance {
                vibrance,
                saturation,
            } => fin(&[vibrance, saturation]) && signed(vibrance) && signed(saturation),
            RasterOp::ColorBalance {
                shadows,
                midtones,
                highlights,
                ..
            } => [shadows, midtones, highlights]
                .iter()
                .all(|t| fin(t) && t.iter().all(|&x| signed(x))),
            RasterOp::PhotoFilter { color, density, .. } => {
                fin(&color) && fin(&[density]) && color.iter().all(|&c| unit(c)) && unit(density)
            }
            RasterOp::SelectiveColor { ranges, .. } => ranges
                .iter()
                .all(|r| fin(r) && r.iter().all(|&x| signed(x))),
            RasterOp::GradientMap { ref stops, .. } => {
                (2..=64).contains(&stops.len())
                    && stops.iter().all(|s| {
                        fin(&[s.at])
                            && unit(s.at)
                            && fin(&s.color)
                            && s.color.iter().all(|&c| unit(c))
                    })
            }
            RasterOp::ColorLookup { size, ref cube, .. } => {
                let n = size as usize;
                (2..=COLOR_LOOKUP_MAX_SIZE).contains(&size)
                    && cube.len() == n * n * n * 3
                    && cube.iter().all(|&c| c.is_finite() && unit(c))
            }
            RasterOp::Develop { ref settings } => {
                settings.len() == DEVELOP_SETTINGS && fin(settings)
            }
            RasterOp::WhiteBalance { temperature, tint } => {
                fin(&[temperature, tint]) && signed(temperature) && signed(tint)
            }
        }
    }
}

/// The stack's JSON form: what the IDML label carries.
pub fn adjustments_to_json(ops: &[RasterOp]) -> String {
    // A `Vec` of plain data serialises without error.
    serde_json::to_string(ops).unwrap_or_default()
}

/// Reads a stack from its JSON form; `None` for text that is not one or
/// carries an op out of range.
pub fn adjustments_from_json(text: &str) -> Option<Vec<RasterOp>> {
    let ops: Vec<RasterOp> = serde_json::from_str(text).ok()?;
    ops.iter().all(RasterOp::is_valid).then_some(ops)
}

/// Every image frame of `spread` that carries a filter stack, as `(Self,
/// stack)`: rectangles, ovals and polygons (a group's members are on the
/// same lists).
fn stacks(spread: &crate::Spread) -> Vec<(&str, &[RasterOp])> {
    let rects = spread
        .rectangles
        .iter()
        .map(|r| (r.self_id.as_deref(), r.image_adjustments.as_slice()));
    let ovals = spread
        .ovals
        .iter()
        .map(|o| (o.self_id.as_deref(), o.image_adjustments.as_slice()));
    let polys = spread
        .polygons
        .iter()
        .map(|p| (p.self_id.as_deref(), p.image_adjustments.as_slice()));
    rects
        .chain(ovals)
        .chain(polys)
        .filter_map(|(id, ops)| Some((id?, ops)))
        .filter(|(_, ops)| !ops.is_empty())
        .collect()
}

/// IDML export: writes each image frame's stack into the spread's label
/// side map under [`IMAGE_ADJUSTMENTS_LABEL`] (and drops the key from a
/// frame whose stack is empty), so a paged → IDML → paged round trip keeps
/// it. Returns whether the spread carries any stack.
pub fn write_labels(spread: &mut crate::Spread) -> bool {
    let entries: Vec<(String, String)> = stacks(spread)
        .into_iter()
        .map(|(id, ops)| (id.to_string(), adjustments_to_json(ops)))
        .collect();
    for labels in spread.labels.values_mut() {
        labels.retain(|(k, _)| k != IMAGE_ADJUSTMENTS_LABEL);
    }
    spread.labels.retain(|_, v| !v.is_empty());
    let any = !entries.is_empty();
    for (id, json) in entries {
        spread
            .labels
            .entry(id)
            .or_default()
            .push((IMAGE_ADJUSTMENTS_LABEL.to_string(), json));
    }
    any
}

/// Whether any frame of `spread` carries a stack.
pub fn has_any(spread: &crate::Spread) -> bool {
    !stacks(spread).is_empty()
}

/// IDML import: moves each image frame's [`IMAGE_ADJUSTMENTS_LABEL`] off
/// the label side map onto the frame. A label that does not read as a
/// stack stays where it is, an ordinary label.
pub fn adopt_labels(spread: &mut crate::Spread) {
    if spread.labels.is_empty() {
        return;
    }
    let mut take = |id: Option<&str>, slot: &mut Vec<RasterOp>| {
        let Some(labels) = id.and_then(|id| spread.labels.get_mut(id)) else {
            return;
        };
        let Some(i) = labels
            .iter()
            .position(|(k, _)| k == IMAGE_ADJUSTMENTS_LABEL)
        else {
            return;
        };
        if let Some(ops) = adjustments_from_json(&labels[i].1) {
            *slot = ops;
            labels.remove(i);
        }
    };
    for r in &mut spread.rectangles {
        take(r.self_id.as_deref(), &mut r.image_adjustments);
    }
    for o in &mut spread.ovals {
        take(o.self_id.as_deref(), &mut o.image_adjustments);
    }
    for p in &mut spread.polygons {
        take(p.self_id.as_deref(), &mut p.image_adjustments);
    }
    spread.labels.retain(|_, v| !v.is_empty());
}

#[cfg(test)]
#[allow(non_snake_case)] // `__feat__` suffixes link the cockpit feature row.
mod tests {
    use super::*;

    #[test]
    fn a_stack_round_trips_through_its_json__feat__images_graphics_image_filter_stack() {
        let ops = vec![
            RasterOp::exposure(0.5),
            RasterOp::curves(vec![[0.0, 0.0], [0.5, 0.6], [1.0, 1.0]]),
            RasterOp::Duotone {
                shadow: [0.1, 0.1, 0.3],
                highlight: [1.0, 0.9, 0.7],
            },
            RasterOp::Invert,
        ];
        let json = adjustments_to_json(&ops);
        assert!(json.contains(r#""op":"exposure""#), "{json}");
        assert!(json.contains(r#""op":"invert""#), "{json}");
        assert_eq!(adjustments_from_json(&json), Some(ops));
    }

    #[test]
    fn the_fields_are_camel_case__feat__images_graphics_image_filter_stack() {
        let json = adjustments_to_json(&[RasterOp::levels(LevelsRecord {
            in_black: 0.1,
            in_white: 0.9,
            gamma: 1.2,
            out_black: 0.0,
            out_white: 1.0,
        })]);
        assert!(json.contains(r#""inBlack":0.1"#), "{json}");
    }

    #[test]
    fn a_stack_rides_a_label_and_back__feat__images_graphics_image_filter_stack() {
        let mut spread = crate::Spread::default();
        let mut r = crate::Rectangle::new("r1", crate::Bounds::ZERO);
        r.image_adjustments = vec![RasterOp::Invert];
        spread.rectangles.push(r);
        spread
            .rectangles
            .push(crate::Rectangle::new("r2", crate::Bounds::ZERO));
        spread
            .labels
            .insert("r2".into(), vec![("vendor".into(), "acme".into())]);
        assert!(write_labels(&mut spread));
        assert_eq!(
            spread.labels.get("r1"),
            Some(&vec![(
                IMAGE_ADJUSTMENTS_LABEL.to_string(),
                r#"[{"op":"invert"}]"#.to_string()
            )])
        );
        spread.rectangles[0].image_adjustments.clear();
        adopt_labels(&mut spread);
        assert_eq!(
            spread.rectangles[0].image_adjustments,
            vec![RasterOp::Invert]
        );
        assert!(
            !spread.labels.contains_key("r1"),
            "the label is the frame's now"
        );
        assert_eq!(
            spread.labels.get("r2").map(Vec::len),
            Some(1),
            "others stay"
        );
    }

    #[test]
    fn an_op_written_before_the_superset_reads_and_writes_as_before__feat__images_graphics_image_filter_stack(
    ) {
        // The JSON of the first ops, as a stored stack or a label carries it.
        let old = r#"[{"op":"exposure","ev":1.0},{"op":"levels","inBlack":0.1,"inWhite":0.9,"gamma":1.2,"outBlack":0.0,"outWhite":1.0},{"op":"curves","points":[[0.0,0.0],[1.0,1.0]]},{"op":"hueSaturation","hue":10.0,"saturation":0.5,"lightness":0.0},{"op":"channelMixer","red":[1.0,0.0,0.0,0.0],"green":[0.0,1.0,0.0,0.0],"blue":[0.0,0.0,1.0,0.0]}]"#;
        let ops = adjustments_from_json(old).expect("reads");
        assert_eq!(ops[0], RasterOp::exposure(1.0));
        assert!(matches!(ops[1], RasterOp::Levels { channels: None, .. }));
        assert_eq!(ops[2], RasterOp::curves(vec![[0.0, 0.0], [1.0, 1.0]]));
        assert_eq!(ops[3], RasterOp::hue_saturation(10.0, 0.5, 0.0));
        // At their defaults the new fields are not written: the JSON, and so
        // the state hash of a stored stack, is unchanged.
        assert_eq!(adjustments_to_json(&ops), old);
    }

    #[test]
    fn the_photoshop_superset_round_trips_through_its_json__feat__images_graphics_image_filter_stack(
    ) {
        let rec = |b: f32| LevelsRecord {
            in_black: b,
            in_white: 0.9,
            gamma: 1.1,
            out_black: 0.0,
            out_white: 1.0,
        };
        let ops = vec![
            RasterOp::Exposure {
                ev: 0.4,
                offset: -0.03,
                gamma: 1.2,
            },
            RasterOp::Levels {
                in_black: 0.0,
                in_white: 1.0,
                gamma: 1.0,
                out_black: 0.0,
                out_white: 1.0,
                channels: Some([rec(0.1), rec(0.2), rec(0.3)]),
            },
            RasterOp::Curves {
                points: vec![],
                channels: Some([vec![[0.0, 0.1], [1.0, 1.0]], vec![], vec![]]),
            },
            RasterOp::HueSaturation {
                hue: 0.0,
                saturation: 0.0,
                lightness: 0.0,
                ranges: Some([[5.0, 0.1, 0.0]; 6]),
                colorize: Some([200.0, 0.25, 0.0]),
            },
            RasterOp::Vibrance {
                vibrance: 0.3,
                saturation: -0.2,
            },
            RasterOp::ColorBalance {
                shadows: [0.1, 0.0, -0.1],
                midtones: [0.0; 3],
                highlights: [0.0, 0.2, 0.0],
                preserve_luminosity: false,
            },
            RasterOp::PhotoFilter {
                color: [0.9, 0.5, 0.0],
                density: 0.25,
                preserve_luminosity: true,
            },
            RasterOp::SelectiveColor {
                ranges: [[0.1, 0.0, 0.0, -0.1]; 9],
                absolute: true,
            },
            RasterOp::GradientMap {
                stops: vec![
                    GradientMapStop {
                        at: 0.0,
                        color: [0.0; 3],
                    },
                    GradientMapStop {
                        at: 1.0,
                        color: [1.0, 0.5, 0.0],
                    },
                ],
                reverse: true,
            },
            RasterOp::ColorLookup {
                name: "Warm".into(),
                size: 2,
                cube: (0..24).map(|i| (i % 2) as f32).collect(),
            },
            RasterOp::Develop {
                settings: vec![0.0; DEVELOP_SETTINGS],
            },
            RasterOp::WhiteBalance {
                temperature: 0.1,
                tint: -0.05,
            },
            RasterOp::ChannelMixer {
                red: [0.4, 0.4, 0.2, 0.0],
                green: [0.0, 1.0, 0.0, 0.0],
                blue: [0.0, 0.0, 1.0, 0.0],
                monochrome: true,
            },
        ];
        for op in &ops {
            assert!(op.is_valid(), "{op:?}");
        }
        let json = adjustments_to_json(&ops);
        assert!(json.contains(r#""op":"selectiveColor""#), "{json}");
        assert!(json.contains(r#""preserveLuminosity":false"#), "{json}");
        assert_eq!(adjustments_from_json(&json), Some(ops));
    }

    #[test]
    fn a_superset_op_out_of_range_is_refused__feat__images_graphics_image_filter_stack() {
        assert!(!RasterOp::Develop {
            settings: vec![0.0; 3]
        }
        .is_valid());
        assert!(!RasterOp::ColorLookup {
            name: String::new(),
            size: 3,
            cube: vec![0.0; 3],
        }
        .is_valid());
        assert!(!RasterOp::GradientMap {
            stops: vec![],
            reverse: false
        }
        .is_valid());
        assert!(!RasterOp::Vibrance {
            vibrance: 2.0,
            saturation: 0.0
        }
        .is_valid());
        assert!(!RasterOp::Exposure {
            ev: 0.0,
            offset: 0.0,
            gamma: 0.0
        }
        .is_valid());
    }

    #[test]
    fn an_op_out_of_range_is_refused__feat__images_graphics_image_filter_stack() {
        assert!(!RasterOp::Threshold { level: 2.0 }.is_valid());
        assert!(!RasterOp::exposure(f32::NAN).is_valid());
        assert!(!RasterOp::Posterize { levels: 1.0 }.is_valid());
        assert_eq!(
            adjustments_from_json(r#"[{"op":"threshold","level":2}]"#),
            None
        );
        assert_eq!(adjustments_from_json("not json"), None);
        assert_eq!(adjustments_from_json(r#"[{"op":"warp"}]"#), None);
    }
}
