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

//! Engine ADR 1037, amendment 2026-11-11 ("one adjustment model") — a
//! Photoshop ADJUSTMENT LAYER (`paged-psd`'s [`Adjustment`], read from and
//! written to its additional-layer-info blocks) mapped onto the engine's
//! [`RasterOp`] and back. Photoshop's encodings live here, at the PSD
//! boundary: levels 0..=255 and a gamma ×100, percentages, hue degrees, a
//! Lab or 16-bit filter colour, gradient locations in 4096ths. The engine
//! and paged.image's adjustment layers hold only the op.
//!
//! [`raster_op`] reads every adjustment `paged-psd` models; the blocks it
//! declines ([`Adjustment::unmodelled`]) never reach it. [`psd_adjustment`]
//! is the inverse for every op Photoshop has an adjustment layer of in this
//! form, so `raster_op(psd_adjustment(op)) == op` for an op read from a
//! file, and `psd_adjustment(raster_op(a)) == a` for every field the op
//! renders. Two fields are Photoshop dialog state with no effect on the
//! pixels and are written at Photoshop's defaults: the Colorize values of a
//! Hue/Saturation that is not colorized, and Brightness/Contrast's mean.
//! (A layer that is not edited is written back from its own bytes.)
//!
//! | Photoshop | op |
//! | --- | --- |
//! | Brightness/Contrast | `brightnessContrast` (brightness / 255, 1 + contrast / 100) |
//! | Levels | `levels` (the composite record; `channels` red, green, blue) |
//! | Curves | `curves` (the composite; `channels` red, green, blue) |
//! | Exposure | `exposure` (`ev`, `offset`, `gamma`) |
//! | Vibrance | `vibrance` (/ 100) |
//! | Hue/Saturation | `hueSaturation` (`ranges`, `colorize`) |
//! | Color Balance | `colorBalance` (/ 100) |
//! | Black & White | `blackWhite` (/ 100) |
//! | Photo Filter | `photoFilter` (Lab or RGB16 as sRGB, density / 100) |
//! | Channel Mixer | `channelMixer` (/ 100, `monochrome`) |
//! | Invert, Posterize, Threshold | `invert`, `posterize`, `threshold` (/ 255) |
//! | Gradient Map | `gradientMap` (locations / 4096, RGB16 as 8-bit) |
//! | Selective Color | `selectiveColor` (/ 100) |

use paged_model::{GradientMapStop, LevelsRecord, RasterOp};
use paged_psd::adjustment::{
    Adjustment, FilterColor, GradientMapStop as PsdStop, LevelsRecord as PsdLevels,
    BLACK_WHITE_DEFAULT_TINT, HUE_RANGE_DEFAULTS,
};

/// Photoshop's Colorize values of a Hue/Saturation that is not colorized.
pub const COLORIZE_DEFAULT: [i16; 3] = [0, 25, 0];

/// A 16-bit component as 8-bit (Photoshop's 257 steps per level).
fn byte16(v: u16) -> u8 {
    ((u32::from(v) + 128) / 257) as u8
}

/// An 8-bit fraction (`k / 255`) back to its level.
fn level(v: f32) -> u16 {
    (v * 255.0).round().clamp(0.0, 255.0) as u16
}

fn record(r: &PsdLevels) -> LevelsRecord {
    LevelsRecord {
        in_black: f32::from(r.in_black) / 255.0,
        in_white: f32::from(r.in_white) / 255.0,
        gamma: f32::from(r.gamma_x100) / 100.0,
        out_black: f32::from(r.out_black) / 255.0,
        out_white: f32::from(r.out_white) / 255.0,
    }
}

fn psd_record(r: &LevelsRecord) -> PsdLevels {
    PsdLevels {
        in_black: level(r.in_black),
        in_white: level(r.in_white),
        out_black: level(r.out_black),
        out_white: level(r.out_white),
        gamma_x100: (r.gamma * 100.0).round().clamp(10.0, 999.0) as u16,
    }
}

fn points(p: &[(u8, u8)]) -> Vec<[f32; 2]> {
    p.iter()
        .map(|&(i, o)| [f32::from(i) / 255.0, f32::from(o) / 255.0])
        .collect()
}

fn psd_points(p: &[[f32; 2]]) -> Vec<(u8, u8)> {
    p.iter()
        .map(|q| (level(q[0]) as u8, level(q[1]) as u8))
        .collect()
}

fn pct(v: f32) -> i32 {
    (v * 100.0).round() as i32
}

/// A filter colour as the 8-bit sRGB colour the layer stack evaluates.
fn filter_rgb(color: &FilterColor) -> [f32; 3] {
    let q = |v: f32| (v.clamp(0.0, 1.0) * 255.0).round() / 255.0;
    match color {
        FilterColor::Lab([l, a, b]) => {
            paged_color::lab::lab_d50_to_srgb_encoded(*l as f32, *a as f32, *b as f32).map(q)
        }
        FilterColor::Rgb(c) => c.map(|v| f32::from(byte16(v)) / 255.0),
        // Declined by `unmodelled`; the warming filter's colour.
        FilterColor::Xyz(_) => [236.0 / 255.0, 138.0 / 255.0, 0.0],
    }
}

/// A Photoshop adjustment as the engine's op.
pub fn raster_op(adj: &Adjustment) -> RasterOp {
    let p = |v: i16| f32::from(v) / 100.0;
    match adj {
        Adjustment::Curves { curves } => RasterOp::Curves {
            points: curves[0].as_deref().map(points).unwrap_or_default(),
            channels: curves[1..]
                .iter()
                .any(Option::is_some)
                .then(|| [1, 2, 3].map(|c| curves[c].as_deref().map(points).unwrap_or_default())),
        },
        Adjustment::Levels { records, .. } => {
            let m = record(&records[0]);
            RasterOp::Levels {
                in_black: m.in_black,
                in_white: m.in_white,
                gamma: m.gamma,
                out_black: m.out_black,
                out_white: m.out_white,
                channels: records[1..]
                    .iter()
                    .any(|r| !r.is_identity())
                    .then(|| [1, 2, 3].map(|c| record(&records[c]))),
            }
        }
        Adjustment::Exposure {
            exposure,
            offset,
            gamma,
        } => RasterOp::Exposure {
            ev: *exposure,
            offset: *offset,
            gamma: *gamma,
        },
        Adjustment::Invert => RasterOp::Invert,
        Adjustment::HueSaturation {
            colorized,
            colorize,
            master,
            ranges,
            ..
        } => RasterOp::HueSaturation {
            hue: f32::from(master[0]),
            saturation: p(master[1]),
            lightness: p(master[2]),
            ranges: ranges
                .iter()
                .any(|r| r.iter().any(|v| *v != 0))
                .then(|| ranges.map(|r| [f32::from(r[0]), p(r[1]), p(r[2])])),
            colorize: colorized.then(|| [f32::from(colorize[0]), p(colorize[1]), p(colorize[2])]),
        },
        Adjustment::BrightnessContrast {
            brightness,
            contrast,
            ..
        } => RasterOp::BrightnessContrast {
            brightness: *brightness as f32 / 255.0,
            contrast: 1.0 + *contrast as f32 / 100.0,
        },
        Adjustment::ColorBalance {
            shadows,
            midtones,
            highlights,
            preserve_luminosity,
        } => RasterOp::ColorBalance {
            shadows: shadows.map(p),
            midtones: midtones.map(p),
            highlights: highlights.map(p),
            preserve_luminosity: *preserve_luminosity,
        },
        Adjustment::Vibrance {
            vibrance,
            saturation,
        } => RasterOp::Vibrance {
            vibrance: *vibrance as f32 / 100.0,
            saturation: *saturation as f32 / 100.0,
        },
        Adjustment::BlackWhite { weights, .. } => {
            let w = weights.map(|w| w as f32 / 100.0);
            RasterOp::BlackWhite {
                reds: w[0],
                yellows: w[1],
                greens: w[2],
                cyans: w[3],
                blues: w[4],
                magentas: w[5],
            }
        }
        Adjustment::PhotoFilter {
            color,
            density,
            preserve_luminosity,
        } => RasterOp::PhotoFilter {
            color: filter_rgb(color),
            density: *density as f32 / 100.0,
            preserve_luminosity: *preserve_luminosity,
        },
        Adjustment::ChannelMixer { rows, monochrome } => RasterOp::ChannelMixer {
            red: rows[0].map(p),
            green: rows[1].map(p),
            blue: rows[2].map(p),
            monochrome: *monochrome,
        },
        Adjustment::Posterize { levels } => RasterOp::Posterize {
            levels: f32::from(*levels),
        },
        Adjustment::Threshold { level } => RasterOp::Threshold {
            level: f32::from(*level) / 255.0,
        },
        Adjustment::GradientMap { stops, reverse, .. } => RasterOp::GradientMap {
            stops: stops
                .iter()
                .map(|s| GradientMapStop {
                    at: (s.location as f32 / 4096.0).clamp(0.0, 1.0),
                    color: s.rgb16.map(|v| f32::from(byte16(v)) / 255.0),
                })
                .collect(),
            reverse: *reverse,
        },
        Adjustment::SelectiveColor { ranges, absolute } => RasterOp::SelectiveColor {
            ranges: ranges.map(|r| r.map(p)),
            absolute: *absolute,
        },
    }
}

/// The op as Photoshop's adjustment, for a layered PSD save: `None` for
/// what Photoshop has no adjustment layer of in this form — Develop (a
/// Camera Raw filter), Color Lookup (whose look Photoshop compiles into an
/// embedded profile, image ADR 478), and the ops Office and CSS bring
/// (recolor, duotone, colour replace, white balance, sharpen, blur).
pub fn psd_adjustment(op: &RasterOp) -> Option<Adjustment> {
    let i = |v: f32| (v * 100.0).round() as i16;
    Some(match op {
        RasterOp::Curves { points, channels } => Adjustment::Curves {
            curves: [0, 1, 2, 3].map(|c| {
                let p: &[[f32; 2]] = match (c, channels) {
                    (0, _) => points,
                    (_, Some(ch)) => &ch[c - 1],
                    (_, None) => &[],
                };
                (!p.is_empty()).then(|| psd_points(p))
            }),
        },
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
            Adjustment::Levels {
                records: [
                    psd_record(&master),
                    psd_record(&ch[0]),
                    psd_record(&ch[1]),
                    psd_record(&ch[2]),
                ],
                extra_records: false,
            }
        }
        RasterOp::Exposure { ev, offset, gamma } => Adjustment::Exposure {
            exposure: *ev,
            offset: *offset,
            gamma: *gamma,
        },
        RasterOp::Invert => Adjustment::Invert,
        RasterOp::HueSaturation {
            hue,
            saturation,
            lightness,
            ranges,
            colorize,
        } => Adjustment::HueSaturation {
            colorized: colorize.is_some(),
            colorize: colorize
                .map(|c| [c[0].round() as i16, i(c[1]), i(c[2])])
                .unwrap_or(COLORIZE_DEFAULT),
            master: [hue.round() as i16, i(*saturation), i(*lightness)],
            ranges: ranges
                .map(|r| r.map(|t| [t[0].round() as i16, i(t[1]), i(t[2])]))
                .unwrap_or([[0; 3]; 6]),
            bounds: HUE_RANGE_DEFAULTS,
        },
        RasterOp::BrightnessContrast {
            brightness,
            contrast,
        } => Adjustment::BrightnessContrast {
            brightness: (brightness * 255.0).round() as i32,
            contrast: pct(contrast - 1.0),
            mean: 127,
            lab: false,
            legacy: false,
            auto: false,
        },
        RasterOp::ColorBalance {
            shadows,
            midtones,
            highlights,
            preserve_luminosity,
        } => Adjustment::ColorBalance {
            shadows: shadows.map(i),
            midtones: midtones.map(i),
            highlights: highlights.map(i),
            preserve_luminosity: *preserve_luminosity,
        },
        RasterOp::Vibrance {
            vibrance,
            saturation,
        } => Adjustment::Vibrance {
            vibrance: pct(*vibrance),
            saturation: pct(*saturation),
        },
        RasterOp::BlackWhite {
            reds,
            yellows,
            greens,
            cyans,
            blues,
            magentas,
        } => Adjustment::BlackWhite {
            weights: [reds, yellows, greens, cyans, blues, magentas].map(|w| pct(*w)),
            tint: false,
            tint_rgb: BLACK_WHITE_DEFAULT_TINT,
        },
        RasterOp::PhotoFilter {
            color,
            density,
            preserve_luminosity,
        } => {
            // Photoshop stores the filter colour as Lab [OBS].
            let lab = paged_color::lab::srgb_to_lab_d50(*color);
            Adjustment::PhotoFilter {
                color: FilterColor::Lab(lab.map(|v| f64::from((v * 100.0).round()) / 100.0)),
                density: (density * 100.0).round().clamp(1.0, 100.0) as u32,
                preserve_luminosity: *preserve_luminosity,
            }
        }
        RasterOp::ChannelMixer {
            red,
            green,
            blue,
            monochrome,
        } => Adjustment::ChannelMixer {
            rows: [red.map(i), green.map(i), blue.map(i)],
            monochrome: *monochrome,
        },
        RasterOp::Posterize { levels } => Adjustment::Posterize {
            levels: levels.round().clamp(2.0, 255.0) as u16,
        },
        RasterOp::Threshold { level: t } => Adjustment::Threshold {
            level: level(*t).clamp(1, 255),
        },
        RasterOp::GradientMap { stops, reverse } => Adjustment::gradient_map(
            stops
                .iter()
                .map(|s| PsdStop {
                    location: (s.at.clamp(0.0, 1.0) * 4096.0).round() as u32,
                    midpoint: 50,
                    rgb16: s.color.map(|v| level(v) * 257),
                })
                .collect(),
            *reverse,
        ),
        RasterOp::SelectiveColor { ranges, absolute } => Adjustment::SelectiveColor {
            ranges: ranges.map(|r| r.map(i)),
            absolute: *absolute,
        },
        RasterOp::Develop { .. }
        | RasterOp::ColorLookup { .. }
        | RasterOp::Recolor { .. }
        | RasterOp::Duotone { .. }
        | RasterOp::ColorReplace { .. }
        | RasterOp::WhiteBalance { .. }
        | RasterOp::Sharpen { .. }
        | RasterOp::Blur { .. } => return None,
    })
}

#[cfg(test)]
#[allow(non_snake_case)] // `__feat__` suffixes link the cockpit feature row.
mod tests {
    use super::*;

    /// One adjustment of every kind `paged-psd` models, at values off their
    /// defaults (Photoshop's own ranges and steps).
    fn every_kind() -> Vec<Adjustment> {
        let rec = |ib: u16, g: u16| PsdLevels {
            in_black: ib,
            in_white: 240,
            out_black: 3,
            out_white: 250,
            gamma_x100: g,
        };
        vec![
            Adjustment::Curves {
                curves: [
                    Some(vec![(0, 0), (64, 80), (255, 255)]),
                    None,
                    Some(vec![(0, 10), (255, 245)]),
                    None,
                ],
            },
            Adjustment::Levels {
                records: [rec(5, 120), PsdLevels::IDENTITY, rec(12, 87), rec(0, 100)],
                extra_records: false,
            },
            Adjustment::Exposure {
                exposure: 0.4,
                offset: -0.03,
                gamma: 1.2,
            },
            Adjustment::Invert,
            Adjustment::HueSaturation {
                colorized: true,
                colorize: [210, 40, -10],
                master: [15, -20, 5],
                ranges: [[3, 10, -5], [0; 3], [0; 3], [-7, 0, 20], [0; 3], [0; 3]],
                bounds: HUE_RANGE_DEFAULTS,
            },
            Adjustment::BrightnessContrast {
                brightness: 37,
                contrast: -22,
                mean: 127,
                lab: false,
                legacy: false,
                auto: false,
            },
            Adjustment::ColorBalance {
                shadows: [10, -5, 0],
                midtones: [0, 0, 33],
                highlights: [-100, 100, 1],
                preserve_luminosity: true,
            },
            Adjustment::Vibrance {
                vibrance: 45,
                saturation: -12,
            },
            Adjustment::BlackWhite {
                weights: [40, 60, 40, 60, 20, 80],
                tint: false,
                tint_rgb: BLACK_WHITE_DEFAULT_TINT,
            },
            Adjustment::PhotoFilter {
                color: FilterColor::Rgb([65535, 32896, 0]),
                density: 25,
                preserve_luminosity: true,
            },
            Adjustment::ChannelMixer {
                rows: [[60, 30, 10, 0], [0, 100, 0, -5], [0, 0, 100, 0]],
                monochrome: false,
            },
            // A monochrome mixer stores its grey row alone [OBS].
            Adjustment::ChannelMixer {
                rows: [[40, 40, 20, 0], [0; 4], [0; 4]],
                monochrome: true,
            },
            Adjustment::Posterize { levels: 5 },
            Adjustment::Threshold { level: 140 },
            Adjustment::gradient_map(
                vec![
                    PsdStop {
                        location: 0,
                        midpoint: 50,
                        rgb16: [20 * 257, 10 * 257, 80 * 257],
                    },
                    PsdStop {
                        location: 2048,
                        midpoint: 50,
                        rgb16: [200 * 257, 60 * 257, 40 * 257],
                    },
                    PsdStop {
                        location: 4096,
                        midpoint: 50,
                        rgb16: [250 * 257, 240 * 257, 200 * 257],
                    },
                ],
                true,
            ),
            Adjustment::SelectiveColor {
                ranges: {
                    let mut r = [[0i16; 4]; 9];
                    r[0] = [-20, 10, 0, 5];
                    r[7] = [0, 0, -30, 0];
                    r
                },
                absolute: true,
            },
        ]
    }

    #[test]
    fn every_photoshop_adjustment_round_trips_through_its_op__feat__image_layers_photoshop_parity()
    {
        for adj in every_kind() {
            assert_eq!(adj.unmodelled(), None, "{adj:?}");
            let op = raster_op(&adj);
            assert!(op.is_valid(), "{adj:?} → {op:?}");
            let back = psd_adjustment(&op).expect("a Photoshop kind");
            // An RGB16 filter colour is written as Lab (Photoshop's own
            // spelling); it reads back as the same 8-bit colour.
            if let Adjustment::PhotoFilter { .. } = adj {
                assert_eq!(raster_op(&back), op, "{adj:?}");
                continue;
            }
            assert_eq!(back, adj, "{op:?}");
            assert_eq!(raster_op(&back), op);
        }
    }

    #[test]
    fn every_op_photoshop_holds_round_trips_through_its_blocks__feat__image_layers_photoshop_parity(
    ) {
        for adj in every_kind() {
            let op = raster_op(&adj);
            let blocks = psd_adjustment(&op).expect("a Photoshop kind").to_blocks();
            let read = Adjustment::from_blocks(blocks.iter().map(|(k, v)| (k, v.as_slice())))
                .expect("reads back")
                .expect("an adjustment");
            assert_eq!(raster_op(&read), op, "{adj:?}");
        }
    }

    #[test]
    fn a_hue_saturation_that_is_not_colorized_writes_photoshops_default_colorize() {
        let adj = Adjustment::HueSaturation {
            colorized: false,
            colorize: [100, 50, 10],
            master: [0, 10, 0],
            ranges: [[0; 3]; 6],
            bounds: HUE_RANGE_DEFAULTS,
        };
        let Some(Adjustment::HueSaturation { colorize, .. }) = psd_adjustment(&raster_op(&adj))
        else {
            panic!("a hue/saturation");
        };
        assert_eq!(colorize, COLORIZE_DEFAULT);
    }

    #[test]
    fn the_ops_photoshop_has_no_layer_for_are_not_written() {
        for op in [
            RasterOp::Develop {
                settings: vec![0.0; paged_model::image_adjust::DEVELOP_SETTINGS],
            },
            RasterOp::Blur { radius: 2.0 },
            RasterOp::WhiteBalance {
                temperature: 0.1,
                tint: 0.0,
            },
        ] {
            assert_eq!(psd_adjustment(&op), None);
        }
    }
}
