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

//! The layer KINDS and PROPERTIES Photoshop's Layers panel has and the
//! plain pixel stack did not: typed adjustment layers, fill layers,
//! blending ranges (Blend If), fill opacity, knockout, the four locks,
//! colour labels, links and layer comps.
//!
//! # Typed adjustment layers
//!
//! An adjustment layer holds ONE adjustment, in Photoshop's own units
//! (Levels as five numbers per channel, Curves as control points, Hue/
//! Saturation as degrees and percentages), so its Properties show what
//! Photoshop's do and a PSD's adjustment layer maps onto it field for
//! field. It is EVALUATED in one of two ways:
//!
//! * most kinds lower onto the adjust chain ([`Adjustment::to_chain`]) —
//!   the same `AdjustParams`, and so the same kernels and tables, the
//!   layered PSD import has always composited them with;
//! * Gradient Map, Selective Color, Color Lookup and Develop have no chain stage:
//!   they are point kernels the fold dispatches directly on the resident
//!   accumulator ([`Adjustment::direct_ops`]).
//!
//! The chain-shaped layers stacks were saved with before typed layers
//! existed stay a kind of their own, [`Adjustment::Chain`]: a chain with
//! one stage opens as that stage's typed layer when the typed layer
//! evaluates to the same parameters ([`Adjustment::from_chain`]); a chain
//! of several stages stays a chain, because splitting it into layers would
//! change how a mask and an opacity apply to it.
//!
//! # Fill layers
//!
//! A fill layer's pixels are a RENDER of its source (a colour, a gradient,
//! a pattern) at the canvas, by the `gen.*` kernels — the layer keeps the
//! source and the render, like a smart object keeps its source and its
//! render. Every reader of layer pixels (the fold, merge, save-back) reads
//! the render; an edit re-renders. A render that no longer matches its
//! source is STALE and is rendered before the next composite.

use std::sync::Arc;

use image_kernels::families::develop::{DevelopSettings, DEVELOP_LEN};
use image_kernels::KernelDef;

use crate::fill::GradientKind;
use crate::ingest::{
    AdjustParams, BlackWhiteParams, ChannelMixerParams, ColorBalanceParams, IngestError,
    PhotoFilterParams,
};

// ───────────────────────── typed adjustments ─────────────────────────

/// One adjustment layer's adjustment, in Photoshop's units.
// The chain variant is large; the whole enum is boxed inside
// `LayerKind::Adjustment`, so no layer pays for it.
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, PartialEq)]
pub enum Adjustment {
    /// A stored adjust chain of several stages (the shape every
    /// adjustment layer had before typed layers; see the module docs).
    Chain(AdjustParams),
    /// Brightness −150..150, contrast −50..100.
    BrightnessContrast {
        brightness: f32,
        contrast: f32,
    },
    /// Composite, red, green, blue: `[in_black, in_white, gamma,
    /// out_black, out_white]`, levels 0–255, gamma 0.1–9.99.
    Levels {
        records: [[f32; 5]; 4],
    },
    /// Composite, red, green, blue: control points `(input, output)`,
    /// 0–255, in input order; an empty list is that channel's identity.
    Curves {
        curves: [Vec<(u8, u8)>; 4],
    },
    /// Exposure in stops, offset −0.5..0.5, gamma 0.01..9.99.
    Exposure {
        exposure: f32,
        offset: f32,
        gamma: f32,
    },
    /// Vibrance and saturation, −100..100.
    Vibrance {
        vibrance: f32,
        saturation: f32,
    },
    /// Master and the six ranges as (hue −180..180, saturation −100..100,
    /// lightness −100..100); `colorize` replaces them with (hue 0..360,
    /// saturation 0..100, lightness −100..100).
    HueSaturation {
        colorize: bool,
        colorize_hsl: [f32; 3],
        master: [f32; 3],
        ranges: [[f32; 3]; 6],
    },
    /// Shadows, midtones, highlights: (cyan–red, magenta–green,
    /// yellow–blue), −100..100.
    ColorBalance {
        shadows: [f32; 3],
        midtones: [f32; 3],
        highlights: [f32; 3],
    },
    /// Reds, yellows, greens, cyans, blues, magentas, percent.
    BlackWhite {
        weights: [f32; 6],
    },
    /// The filter colour, density 0..100, and whether luminosity is kept.
    PhotoFilter {
        color: [u8; 3],
        density: f32,
        preserve_luminosity: bool,
    },
    /// Output rows (red, green, blue) of `[from red, from green, from
    /// blue, constant]`, percent; `monochrome` makes every row the red one.
    ChannelMixer {
        rows: [[f32; 4]; 3],
        monochrome: bool,
    },
    Invert,
    /// 2..255 levels per channel.
    Posterize {
        levels: f32,
    },
    /// The luminosity level 1..255 at and above which a pixel is white.
    Threshold {
        level: f32,
    },
    /// The luminosity mapped through a ramp of colour stops.
    GradientMap {
        stops: Vec<ColorStop>,
        reverse: bool,
    },
    /// Reds, yellows, greens, cyans, blues, magentas, whites, neutrals,
    /// blacks: (cyan, magenta, yellow, black) −100..100; relative or
    /// absolute.
    SelectiveColor {
        ranges: [[f32; 4]; 9],
        absolute: bool,
    },
    /// A colour cube (`LUT3D_EDGE³` rgb triples, red fastest, 0–1) and the
    /// name of the look it came from.
    ColorLookup {
        name: String,
        cube: Arc<[f32]>,
    },
    /// The Camera Raw-class Develop adjustment (WP5.2): the 61 settings
    /// of `image_kernels::families::develop` in Lightroom / Camera Raw
    /// units. Photoshop has no Develop adjustment layer (its Camera Raw
    /// Filter is a smart filter), so a PSD save takes the flatten path.
    Develop {
        settings: [f32; DEVELOP_LEN],
    },
}

/// Every typed kind's wire name, in the Layer ▸ New Adjustment Layer
/// order (Photoshop's menu order).
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

/// A colour stop of a gradient: where (0–1) and which colour.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ColorStop {
    pub at: f32,
    pub rgb: [u8; 3],
}

/// The 256-entry RGB ramp of `stops` (sorted by position, linear between
/// them, flat beyond the ends), reversed when asked.
pub fn stop_ramp(stops: &[ColorStop], reverse: bool) -> [[f32; 3]; 256] {
    let mut s: Vec<ColorStop> = stops.to_vec();
    s.sort_by(|a, b| a.at.total_cmp(&b.at));
    let mut out = [[0.0f32; 3]; 256];
    if s.is_empty() {
        for (i, e) in out.iter_mut().enumerate() {
            *e = [i as f32 / 255.0; 3];
        }
        return out;
    }
    let col = |c: [u8; 3]| c.map(|v| f32::from(v) / 255.0);
    for (i, e) in out.iter_mut().enumerate() {
        let t = i as f32 / 255.0;
        let t = if reverse { 1.0 - t } else { t };
        let first = s[0];
        let last = s[s.len() - 1];
        *e = if t <= first.at {
            col(first.rgb)
        } else if t >= last.at {
            col(last.rgb)
        } else {
            let k = s.windows(2).position(|w| t >= w[0].at && t <= w[1].at);
            match k {
                Some(k) => {
                    let (a, b) = (s[k], s[k + 1]);
                    let span = (b.at - a.at).max(f32::EPSILON);
                    let f = (t - a.at) / span;
                    let (ca, cb) = (col(a.rgb), col(b.rgb));
                    [0, 1, 2].map(|c| ca[c] + (cb[c] - ca[c]) * f)
                }
                None => col(last.rgb),
            }
        };
    }
    out
}

/// One Levels record as a 256-entry table: the input range normalised,
/// raised to 1/gamma, mapped onto the output range (Photoshop's order —
/// the layered PSD import's measured mapping, ADR 464's neighbour). The
/// gamma is taken at Photoshop's two decimals so a value that came from a
/// file's ×100 integer is evaluated exactly as that integer.
pub fn levels_table(r: [f32; 5]) -> [u8; 256] {
    let (ib, iw) = (f64::from(r[0]), f64::from(r[1]));
    let (ob, ow) = (f64::from(r[3]), f64::from(r[4]));
    let g = ((f64::from(r[2]) * 100.0).round() / 100.0).max(0.01);
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

/// A Curves channel as a table — Photoshop's natural cubic spline.
fn curve_table(pts: &[(u8, u8)]) -> [u8; 256] {
    let pts: Vec<(f32, f32)> = pts
        .iter()
        .map(|&(i, o)| (f32::from(i) / 255.0, f32::from(o) / 255.0))
        .collect();
    image_core::curve_lut_natural(&pts)
}

const LEVELS_IDENTITY: [f32; 5] = [0.0, 255.0, 1.0, 0.0, 255.0];

fn bad(kind: &str, detail: impl std::fmt::Display) -> IngestError {
    IngestError::Unsupported(format!("{kind} adjustment: {detail}"))
}

impl Adjustment {
    /// The wire name of this adjustment's kind (`"chain"` for a stored
    /// chain).
    pub fn kind_name(&self) -> &'static str {
        match self {
            Adjustment::Chain(_) => "chain",
            Adjustment::BrightnessContrast { .. } => "brightnessContrast",
            Adjustment::Levels { .. } => "levels",
            Adjustment::Curves { .. } => "curves",
            Adjustment::Exposure { .. } => "exposure",
            Adjustment::Vibrance { .. } => "vibrance",
            Adjustment::HueSaturation { .. } => "hueSaturation",
            Adjustment::ColorBalance { .. } => "colorBalance",
            Adjustment::BlackWhite { .. } => "blackWhite",
            Adjustment::PhotoFilter { .. } => "photoFilter",
            Adjustment::ChannelMixer { .. } => "channelMixer",
            Adjustment::Invert => "invert",
            Adjustment::Posterize { .. } => "posterize",
            Adjustment::Threshold { .. } => "threshold",
            Adjustment::GradientMap { .. } => "gradientMap",
            Adjustment::SelectiveColor { .. } => "selectiveColor",
            Adjustment::ColorLookup { .. } => "colorLookup",
            Adjustment::Develop { .. } => "develop",
        }
    }

    /// The layer name Photoshop gives a new layer of this kind.
    pub fn default_layer_name(&self) -> &'static str {
        match self {
            Adjustment::Chain(_) => "Adjustment",
            Adjustment::BrightnessContrast { .. } => "Brightness/Contrast",
            Adjustment::Levels { .. } => "Levels",
            Adjustment::Curves { .. } => "Curves",
            Adjustment::Exposure { .. } => "Exposure",
            Adjustment::Vibrance { .. } => "Vibrance",
            Adjustment::HueSaturation { .. } => "Hue/Saturation",
            Adjustment::ColorBalance { .. } => "Color Balance",
            Adjustment::BlackWhite { .. } => "Black & White",
            Adjustment::PhotoFilter { .. } => "Photo Filter",
            Adjustment::ChannelMixer { .. } => "Channel Mixer",
            Adjustment::Invert => "Invert",
            Adjustment::Posterize { .. } => "Posterize",
            Adjustment::Threshold { .. } => "Threshold",
            Adjustment::GradientMap { .. } => "Gradient Map",
            Adjustment::SelectiveColor { .. } => "Selective Color",
            Adjustment::ColorLookup { .. } => "Color Lookup",
            Adjustment::Develop { .. } => "Develop",
        }
    }

    /// A new layer's adjustment of `kind` at Photoshop's defaults (the
    /// identity, except where Photoshop's default already does something:
    /// Invert, Posterize 4, Threshold 128, Black & White, a black-to-white
    /// Gradient Map, Photo Filter's warming filter at 25 %).
    pub fn default_for(kind: &str) -> Option<Adjustment> {
        Some(match kind {
            "brightnessContrast" => Adjustment::BrightnessContrast {
                brightness: 0.0,
                contrast: 0.0,
            },
            "levels" => Adjustment::Levels {
                records: [LEVELS_IDENTITY; 4],
            },
            "curves" => Adjustment::Curves {
                curves: Default::default(),
            },
            "exposure" => Adjustment::Exposure {
                exposure: 0.0,
                offset: 0.0,
                gamma: 1.0,
            },
            "vibrance" => Adjustment::Vibrance {
                vibrance: 0.0,
                saturation: 0.0,
            },
            "hueSaturation" => Adjustment::HueSaturation {
                colorize: false,
                colorize_hsl: [0.0, 25.0, 0.0],
                master: [0.0; 3],
                ranges: [[0.0; 3]; 6],
            },
            "colorBalance" => Adjustment::ColorBalance {
                shadows: [0.0; 3],
                midtones: [0.0; 3],
                highlights: [0.0; 3],
            },
            "blackWhite" => Adjustment::BlackWhite {
                weights: [40.0, 60.0, 40.0, 60.0, 20.0, 80.0],
            },
            "photoFilter" => Adjustment::PhotoFilter {
                color: [236, 138, 0],
                density: 25.0,
                preserve_luminosity: true,
            },
            "channelMixer" => Adjustment::ChannelMixer {
                rows: [
                    [100.0, 0.0, 0.0, 0.0],
                    [0.0, 100.0, 0.0, 0.0],
                    [0.0, 0.0, 100.0, 0.0],
                ],
                monochrome: false,
            },
            "invert" => Adjustment::Invert,
            "posterize" => Adjustment::Posterize { levels: 4.0 },
            "threshold" => Adjustment::Threshold { level: 128.0 },
            "gradientMap" => Adjustment::GradientMap {
                stops: vec![
                    ColorStop {
                        at: 0.0,
                        rgb: [0, 0, 0],
                    },
                    ColorStop {
                        at: 1.0,
                        rgb: [255, 255, 255],
                    },
                ],
                reverse: false,
            },
            "selectiveColor" => Adjustment::SelectiveColor {
                ranges: [[0.0; 4]; 9],
                absolute: false,
            },
            "colorLookup" => Adjustment::ColorLookup {
                name: String::new(),
                cube: identity_cube(),
            },
            "develop" => Adjustment::Develop {
                settings: DevelopSettings::identity().0,
            },
            _ => return None,
        })
    }

    /// The flat parameter block (the wire and the manifest). Layouts:
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
    /// chain               AdjustParams::to_wire
    /// ```
    pub fn values(&self) -> Vec<f32> {
        let b = |v: bool| if v { 1.0 } else { 0.0 };
        match self {
            Adjustment::Chain(p) => p.to_wire(),
            Adjustment::BrightnessContrast {
                brightness,
                contrast,
            } => vec![*brightness, *contrast],
            Adjustment::Levels { records } => records.iter().flatten().copied().collect(),
            Adjustment::Curves { curves } => {
                let mut v = Vec::new();
                for c in curves {
                    v.push(c.len() as f32);
                    for &(i, o) in c {
                        v.push(f32::from(i));
                        v.push(f32::from(o));
                    }
                }
                v
            }
            Adjustment::Exposure {
                exposure,
                offset,
                gamma,
            } => vec![*exposure, *offset, *gamma],
            Adjustment::Vibrance {
                vibrance,
                saturation,
            } => vec![*vibrance, *saturation],
            Adjustment::HueSaturation {
                colorize,
                colorize_hsl,
                master,
                ranges,
            } => {
                let mut v = vec![b(*colorize)];
                v.extend_from_slice(colorize_hsl);
                v.extend_from_slice(master);
                for r in ranges {
                    v.extend_from_slice(r);
                }
                v
            }
            Adjustment::ColorBalance {
                shadows,
                midtones,
                highlights,
            } => [*shadows, *midtones, *highlights].concat(),
            Adjustment::BlackWhite { weights } => weights.to_vec(),
            Adjustment::PhotoFilter {
                color,
                density,
                preserve_luminosity,
            } => vec![
                f32::from(color[0]),
                f32::from(color[1]),
                f32::from(color[2]),
                *density,
                b(*preserve_luminosity),
            ],
            Adjustment::ChannelMixer { rows, monochrome } => {
                let mut v: Vec<f32> = rows.iter().flatten().copied().collect();
                v.push(b(*monochrome));
                v
            }
            Adjustment::Invert => Vec::new(),
            Adjustment::Posterize { levels } => vec![*levels],
            Adjustment::Threshold { level } => vec![*level],
            Adjustment::GradientMap { stops, reverse } => {
                let mut v = vec![b(*reverse), stops.len() as f32];
                for s in stops {
                    v.push(s.at);
                    v.extend(s.rgb.map(f32::from));
                }
                v
            }
            Adjustment::SelectiveColor { ranges, absolute } => {
                let mut v = vec![b(*absolute)];
                for r in ranges {
                    v.extend_from_slice(r);
                }
                v
            }
            Adjustment::ColorLookup { .. } => Vec::new(),
            Adjustment::Develop { settings } => settings.to_vec(),
        }
    }

    /// The colour cube of a Color Lookup layer.
    pub fn blob(&self) -> Option<&[f32]> {
        match self {
            Adjustment::ColorLookup { cube, .. } => Some(cube),
            _ => None,
        }
    }

    /// The look's name of a Color Lookup layer.
    pub fn label(&self) -> &str {
        match self {
            Adjustment::ColorLookup { name, .. } => name,
            _ => "",
        }
    }

    /// Rebuild from [`values`](Self::values) (and a Color Lookup's cube
    /// and name). Out-of-range values are clamped to Photoshop's ranges; a
    /// block of the wrong length is refused.
    pub fn from_wire(
        kind: &str,
        values: &[f32],
        blob: &[f32],
        label: &str,
    ) -> Result<Adjustment, IngestError> {
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
        let byte = |v: f32| c(v, 0.0, 255.0).round() as u8;
        Ok(match kind {
            "chain" => Adjustment::Chain(AdjustParams::from_wire(values)?),
            "brightnessContrast" => {
                want(2)?;
                Adjustment::BrightnessContrast {
                    brightness: c(values[0], -150.0, 150.0),
                    contrast: c(values[1], -50.0, 100.0),
                }
            }
            "levels" => {
                want(20)?;
                let mut records = [LEVELS_IDENTITY; 4];
                for (k, r) in records.iter_mut().enumerate() {
                    let v = &values[k * 5..k * 5 + 5];
                    let ib = c(v[0], 0.0, 253.0);
                    let iw = c(v[1], ib + 2.0, 255.0);
                    *r = [
                        ib,
                        iw,
                        c(v[2], 0.1, 9.99),
                        c(v[3], 0.0, 255.0),
                        c(v[4], 0.0, 255.0),
                    ];
                }
                Adjustment::Levels { records }
            }
            "curves" => {
                let mut curves: [Vec<(u8, u8)>; 4] = Default::default();
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
                        .map(|q| (byte(q[0]), byte(q[1])))
                        .collect();
                    p.sort_by_key(|q| q.0);
                    p.dedup_by_key(|q| q.0);
                    *curve = p;
                }
                if at != values.len() {
                    return Err(bad(kind, "values after the four curves"));
                }
                Adjustment::Curves { curves }
            }
            "exposure" => {
                want(3)?;
                Adjustment::Exposure {
                    exposure: c(values[0], -20.0, 20.0),
                    offset: c(values[1], -0.5, 0.5),
                    gamma: c(values[2], 0.01, 9.99),
                }
            }
            "vibrance" => {
                want(2)?;
                Adjustment::Vibrance {
                    vibrance: c(values[0], -100.0, 100.0),
                    saturation: c(values[1], -100.0, 100.0),
                }
            }
            "hueSaturation" => {
                want(25)?;
                let hsl = |o: usize| {
                    [
                        c(values[o], -180.0, 360.0),
                        c(values[o + 1], -100.0, 100.0),
                        c(values[o + 2], -100.0, 100.0),
                    ]
                };
                let mut ranges = [[0.0; 3]; 6];
                for (k, r) in ranges.iter_mut().enumerate() {
                    *r = hsl(7 + k * 3);
                }
                Adjustment::HueSaturation {
                    colorize: on(values[0]),
                    colorize_hsl: hsl(1),
                    master: hsl(4),
                    ranges,
                }
            }
            "colorBalance" => {
                want(9)?;
                let t = |o: usize| [0, 1, 2].map(|i| c(values[o + i], -100.0, 100.0));
                Adjustment::ColorBalance {
                    shadows: t(0),
                    midtones: t(3),
                    highlights: t(6),
                }
            }
            "blackWhite" => {
                want(6)?;
                Adjustment::BlackWhite {
                    weights: std::array::from_fn(|i| c(values[i], -200.0, 300.0)),
                }
            }
            "photoFilter" => {
                want(5)?;
                Adjustment::PhotoFilter {
                    color: [byte(values[0]), byte(values[1]), byte(values[2])],
                    density: c(values[3], 0.0, 100.0),
                    preserve_luminosity: on(values[4]),
                }
            }
            "channelMixer" => {
                want(13)?;
                Adjustment::ChannelMixer {
                    rows: std::array::from_fn(|r| {
                        std::array::from_fn(|k| c(values[r * 4 + k], -200.0, 200.0))
                    }),
                    monochrome: on(values[12]),
                }
            }
            "invert" => {
                want(0)?;
                Adjustment::Invert
            }
            "posterize" => {
                want(1)?;
                Adjustment::Posterize {
                    levels: c(values[0], 2.0, 255.0).round(),
                }
            }
            "threshold" => {
                want(1)?;
                Adjustment::Threshold {
                    level: c(values[0], 1.0, 255.0).round(),
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
                let stops = values[2..]
                    .as_chunks::<4>()
                    .0
                    .iter()
                    .map(|s| ColorStop {
                        at: c(s[0], 0.0, 1.0),
                        rgb: [byte(s[1]), byte(s[2]), byte(s[3])],
                    })
                    .collect();
                Adjustment::GradientMap {
                    stops,
                    reverse: on(values[0]),
                }
            }
            "selectiveColor" => {
                want(37)?;
                Adjustment::SelectiveColor {
                    ranges: std::array::from_fn(|r| {
                        std::array::from_fn(|k| c(values[1 + r * 4 + k], -100.0, 100.0))
                    }),
                    absolute: on(values[0]),
                }
            }
            "colorLookup" => {
                want(0)?;
                use image_kernels::families::adjust::LUT3D_EDGE;
                let n = LUT3D_EDGE * LUT3D_EDGE * LUT3D_EDGE * 3;
                if blob.len() != n {
                    return Err(bad(
                        kind,
                        format!("a cube of {} values, expected {n}", blob.len()),
                    ));
                }
                Adjustment::ColorLookup {
                    name: label.to_string(),
                    cube: Arc::from(blob.iter().map(|&v| c(v, 0.0, 1.0)).collect::<Vec<_>>()),
                }
            }
            "develop" => {
                want(DEVELOP_LEN)?;
                Adjustment::Develop {
                    settings: DevelopSettings::from_values(values)
                        .ok_or_else(|| bad(kind, "a Develop block of the wrong length"))?
                        .0,
                }
            }
            other => {
                return Err(IngestError::Unsupported(format!(
                    "unknown adjustment kind \"{other}\" (one of {})",
                    ADJUSTMENT_KINDS.join(", ")
                )))
            }
        })
    }

    /// MIGRATION of a stored chain: the typed layer whose parameters are
    /// exactly `p`, or the chain itself (module docs).
    pub fn from_chain(p: AdjustParams) -> Adjustment {
        let d = AdjustParams::default();
        // The one stage the chain runs, read back into Photoshop's units.
        let candidates = [
            Adjustment::BrightnessContrast {
                brightness: p.brightness * 255.0,
                contrast: (p.contrast - 1.0) * 100.0,
            },
            Adjustment::Exposure {
                exposure: p.exposure_ev,
                offset: 0.0,
                gamma: 1.0,
            },
            Adjustment::Vibrance {
                vibrance: p.vibrance * 100.0,
                saturation: (p.saturation - 1.0) * 100.0,
            },
            Adjustment::ColorBalance {
                shadows: p.color_balance.shadows.map(|v| v * 100.0),
                midtones: p.color_balance.midtones.map(|v| v * 100.0),
                highlights: p.color_balance.highlights.map(|v| v * 100.0),
            },
            Adjustment::BlackWhite {
                weights: p.black_white.weights.map(|v| v * 100.0),
            },
            Adjustment::Invert,
            Adjustment::Posterize {
                levels: p.posterize.unwrap_or(0.0),
            },
            Adjustment::Threshold {
                level: p.threshold.unwrap_or(0.0) * 255.0,
            },
        ];
        if p == d {
            return Adjustment::Chain(p);
        }
        for cand in candidates {
            if cand.to_chain().as_ref() == Some(&p) {
                return cand;
            }
        }
        Adjustment::Chain(p)
    }

    /// The adjust chain this layer evaluates as — `None` for the kinds
    /// the fold dispatches directly ([`direct_ops`](Self::direct_ops)).
    pub fn to_chain(&self) -> Option<AdjustParams> {
        let mut p = AdjustParams::default();
        match self {
            Adjustment::Chain(c) => return Some(c.clone()),
            Adjustment::BrightnessContrast {
                brightness,
                contrast,
            } => {
                p.brightness = brightness / 255.0;
                p.contrast = 1.0 + contrast / 100.0;
            }
            // Levels as TABLES, the way Photoshop applies them: each
            // channel's record first, then the composite's — so a
            // per-channel OUTPUT range, which the levels stages have no
            // field for, is exact too. Measured on Photoshop-written
            // layers: within 2 levels (channel then composite; the other
            // order is 13 off).
            Adjustment::Levels { records } => {
                if records.iter().all(|r| *r == LEVELS_IDENTITY) {
                    return Some(p);
                }
                p.curve_lut = Some(levels_table(records[0]));
                if records[1..].iter().any(|r| *r != LEVELS_IDENTITY) {
                    p.curve_rgb = Some(Box::new([1, 2, 3].map(|c| levels_table(records[c]))));
                }
            }
            Adjustment::Curves { curves } => {
                p.curve_lut = (!curves[0].is_empty()).then(|| curve_table(&curves[0]));
                if curves[1..].iter().any(|c| !c.is_empty()) {
                    let id = curve_table(&[(0, 0), (255, 255)]);
                    p.curve_rgb = Some(Box::new([1, 2, 3].map(|c| {
                        if curves[c].is_empty() {
                            id
                        } else {
                            curve_table(&curves[c])
                        }
                    })));
                }
            }
            // Plain exposure is the exposure stage (it agrees with
            // Photoshop within 2 levels); an offset or gamma is a table.
            Adjustment::Exposure {
                exposure,
                offset,
                gamma,
            } => {
                if *offset == 0.0 && *gamma == 1.0 {
                    p.exposure_ev = *exposure;
                } else {
                    p.curve_lut = Some(exposure_table(*exposure, *offset, *gamma));
                }
            }
            Adjustment::Vibrance {
                vibrance,
                saturation,
            } => {
                p.vibrance = vibrance / 100.0;
                p.saturation = 1.0 + saturation / 100.0;
            }
            Adjustment::HueSaturation {
                colorize,
                colorize_hsl,
                master,
                ranges,
            } => {
                let hsl = |t: &[f32; 3]| [t[0], t[1] / 100.0, t[2] / 100.0, 0.0];
                p.hue_sat.master = hsl(master);
                for (k, r) in ranges.iter().enumerate() {
                    p.hue_sat.ranges[k] = hsl(r);
                }
                if *colorize {
                    p.hue_sat.colorize = [
                        1.0,
                        colorize_hsl[0].rem_euclid(360.0),
                        colorize_hsl[1] / 100.0,
                        colorize_hsl[2] / 100.0,
                    ];
                }
            }
            Adjustment::ColorBalance {
                shadows,
                midtones,
                highlights,
            } => {
                p.color_balance = ColorBalanceParams {
                    shadows: shadows.map(|v| v / 100.0),
                    midtones: midtones.map(|v| v / 100.0),
                    highlights: highlights.map(|v| v / 100.0),
                };
            }
            Adjustment::BlackWhite { weights } => {
                p.black_white = BlackWhiteParams {
                    enabled: true,
                    weights: weights.map(|v| v / 100.0),
                };
            }
            Adjustment::PhotoFilter {
                color,
                density,
                preserve_luminosity,
            } => {
                p.photo_filter = PhotoFilterParams {
                    color: color.map(|v| f32::from(v) / 255.0),
                    density: density / 100.0,
                    preserve_luminosity: *preserve_luminosity,
                };
            }
            Adjustment::ChannelMixer { rows, monochrome } => {
                let row = |r: &[f32; 4]| r.map(|v| v / 100.0);
                let (r, g, b) = if *monochrome {
                    (row(&rows[0]), row(&rows[0]), row(&rows[0]))
                } else {
                    (row(&rows[0]), row(&rows[1]), row(&rows[2]))
                };
                p.channel_mixer = ChannelMixerParams { r, g, b };
            }
            Adjustment::Invert => p.invert = true,
            Adjustment::Posterize { levels } => p.posterize = Some(*levels),
            Adjustment::Threshold { level } => p.threshold = Some(level / 255.0),
            Adjustment::GradientMap { .. }
            | Adjustment::SelectiveColor { .. }
            | Adjustment::ColorLookup { .. }
            | Adjustment::Develop { .. } => return None,
        }
        Some(p)
    }

    /// The point kernels a direct kind runs on the accumulator, in order
    /// (each unmasked; the fold mixes the result through the layer's
    /// coverage once). Empty for the chain kinds.
    pub fn direct_ops(&self) -> Vec<(&'static KernelDef, Vec<u8>)> {
        use image_kernels::families::adjust::{
            AdjustGradientMapParams, AdjustLut3dParams, SelectiveColorParams, ADJUST_GRADIENT_MAP,
            ADJUST_LUT3D, ADJUST_SELECTIVE_COLOR,
        };
        match self {
            Adjustment::GradientMap { stops, reverse } => {
                let ramp = stop_ramp(stops, *reverse);
                let p = AdjustGradientMapParams::from_fn(|t| {
                    ramp[((t * 255.0).round() as usize).min(255)]
                });
                vec![(&ADJUST_GRADIENT_MAP, p.as_bytes().to_vec())]
            }
            Adjustment::SelectiveColor { ranges, absolute } => ranges
                .iter()
                .enumerate()
                .filter(|(_, r)| r.iter().any(|v| *v != 0.0))
                .map(|(k, r)| {
                    let p = SelectiveColorParams::new(
                        k as u32,
                        r[0] / 100.0,
                        r[1] / 100.0,
                        r[2] / 100.0,
                        r[3] / 100.0,
                        *absolute,
                    );
                    (
                        &ADJUST_SELECTIVE_COLOR as &'static KernelDef,
                        p.as_bytes().to_vec(),
                    )
                })
                .collect(),
            Adjustment::ColorLookup { cube, .. } => {
                let mut p = AdjustLut3dParams::identity();
                for (i, e) in p.cube.iter_mut().enumerate() {
                    *e = [cube[i * 3], cube[i * 3 + 1], cube[i * 3 + 2], 0.0];
                }
                vec![(&ADJUST_LUT3D, p.as_bytes().to_vec())]
            }
            // Tone, then detail; an identity half is skipped.
            Adjustment::Develop { settings } => DevelopSettings(*settings).ops(),
            _ => Vec::new(),
        }
    }

    /// Does this adjustment leave every pixel as it is?
    pub fn is_identity(&self) -> bool {
        match self.to_chain() {
            Some(p) => p.is_identity(),
            None => match self {
                Adjustment::SelectiveColor { ranges, .. } => {
                    ranges.iter().all(|r| r.iter().all(|v| *v == 0.0))
                }
                Adjustment::ColorLookup { cube, .. } => cube[..] == identity_cube()[..],
                Adjustment::Develop { settings } => DevelopSettings(*settings).is_identity(),
                _ => false,
            },
        }
    }
}

/// The identity colour cube at the kernel's edge.
pub fn identity_cube() -> Arc<[f32]> {
    use image_kernels::families::adjust::LUT3D_EDGE;
    let n = (LUT3D_EDGE - 1) as f32;
    let mut v = Vec::with_capacity(LUT3D_EDGE * LUT3D_EDGE * LUT3D_EDGE * 3);
    for b in 0..LUT3D_EDGE {
        for g in 0..LUT3D_EDGE {
            for r in 0..LUT3D_EDGE {
                v.extend_from_slice(&[r as f32 / n, g as f32 / n, b as f32 / n]);
            }
        }
    }
    Arc::from(v)
}

// ───────────────────────────── fill layers ─────────────────────────────

/// What a fill layer paints.
#[derive(Debug, Clone, PartialEq)]
pub enum FillSource {
    /// One colour everywhere.
    Solid {
        rgb: [u8; 3],
    },
    Gradient(GradientFill),
    Pattern(PatternFill),
}

/// A gradient fill, as Photoshop's Gradient Fill dialog sets it: the
/// style, the angle (degrees, counter-clockwise from 3 o'clock), the scale
/// (percent of the span across the canvas at that angle), reverse, the
/// offset of the centre (percent of the canvas) and the colour stops.
#[derive(Debug, Clone, PartialEq)]
pub struct GradientFill {
    pub style: GradientKind,
    pub angle: f32,
    pub scale: f32,
    pub reverse: bool,
    pub offset: (f32, f32),
    pub stops: Vec<ColorStop>,
}

/// A pattern fill: the tile (straight RGBA8, `width × height`), the name
/// it is known by, its scale (percent) and angle (degrees).
#[derive(Debug, Clone, PartialEq)]
pub struct PatternFill {
    pub name: String,
    pub tile: Arc<[u8]>,
    pub width: u32,
    pub height: u32,
    pub scale: f32,
    pub angle: f32,
}

/// A fill layer: its source and whether its render is out of date.
#[derive(Debug, Clone, PartialEq)]
pub struct FillLayer {
    pub source: FillSource,
    /// The layer's pixels no longer show `source` (it was edited, or the
    /// canvas changed); the next composite renders it.
    pub stale: bool,
}

impl FillSource {
    /// The wire name: `solid`, `gradient` or `pattern`.
    pub fn kind_name(&self) -> &'static str {
        match self {
            FillSource::Solid { .. } => "solid",
            FillSource::Gradient(_) => "gradient",
            FillSource::Pattern(_) => "pattern",
        }
    }

    /// Photoshop's name for a new layer of this fill.
    pub fn default_layer_name(&self) -> &'static str {
        match self {
            FillSource::Solid { .. } => "Color Fill",
            FillSource::Gradient(_) => "Gradient Fill",
            FillSource::Pattern(_) => "Pattern Fill",
        }
    }

    /// The flat parameter block:
    ///
    /// ```text
    /// solid     r, g, b
    /// gradient  style (0 linear, 1 radial, 2 angle, 3 reflected, 4 diamond),
    ///           angle, scale, reverse, offset x, offset y, n, n × (at, r, g, b)
    /// pattern   scale, angle   (the tile is a buffer of its own)
    /// ```
    pub fn values(&self) -> Vec<f32> {
        match self {
            FillSource::Solid { rgb } => rgb.map(f32::from).to_vec(),
            FillSource::Gradient(g) => {
                let style = match g.style {
                    GradientKind::Linear => 0.0,
                    GradientKind::Radial => 1.0,
                    GradientKind::Angular => 2.0,
                    GradientKind::Reflected => 3.0,
                    GradientKind::Diamond => 4.0,
                };
                let mut v = vec![
                    style,
                    g.angle,
                    g.scale,
                    if g.reverse { 1.0 } else { 0.0 },
                    g.offset.0,
                    g.offset.1,
                    g.stops.len() as f32,
                ];
                for s in &g.stops {
                    v.push(s.at);
                    v.extend(s.rgb.map(f32::from));
                }
                v
            }
            FillSource::Pattern(p) => vec![p.scale, p.angle],
        }
    }

    /// Rebuild from [`values`](Self::values); a pattern takes its tile
    /// and name alongside (`tile` is `(rgba, width, height)`).
    pub fn from_wire(
        kind: &str,
        values: &[f32],
        tile: Option<(Arc<[u8]>, u32, u32)>,
        name: &str,
    ) -> Result<FillSource, IngestError> {
        let c = |v: f32, lo: f32, hi: f32| {
            if v.is_finite() {
                v.clamp(lo, hi)
            } else {
                lo.max(0.0).min(hi)
            }
        };
        let byte = |v: f32| c(v, 0.0, 255.0).round() as u8;
        let bad = |d: String| IngestError::Unsupported(format!("{kind} fill: {d}"));
        Ok(match kind {
            "solid" => {
                if values.len() != 3 {
                    return Err(bad(format!("{} values, expected 3", values.len())));
                }
                FillSource::Solid {
                    rgb: [byte(values[0]), byte(values[1]), byte(values[2])],
                }
            }
            "gradient" => {
                if values.len() < 7 {
                    return Err(bad(format!("{} values, expected 7 or more", values.len())));
                }
                let n = c(values[6], 0.0, 64.0) as usize;
                if values.len() != 7 + n * 4 || n < 2 {
                    return Err(bad(format!(
                        "{} values for {n} stops (two at least, four values each)",
                        values.len()
                    )));
                }
                let style = match values[0].round() as i32 {
                    0 => GradientKind::Linear,
                    1 => GradientKind::Radial,
                    2 => GradientKind::Angular,
                    3 => GradientKind::Reflected,
                    4 => GradientKind::Diamond,
                    s => return Err(bad(format!("style {s}"))),
                };
                FillSource::Gradient(GradientFill {
                    style,
                    angle: c(values[1], -360.0, 360.0),
                    scale: c(values[2], 10.0, 1000.0),
                    reverse: values[3] >= 0.5,
                    offset: (c(values[4], -100.0, 100.0), c(values[5], -100.0, 100.0)),
                    stops: values[7..]
                        .as_chunks::<4>()
                        .0
                        .iter()
                        .map(|s| ColorStop {
                            at: c(s[0], 0.0, 1.0),
                            rgb: [byte(s[1]), byte(s[2]), byte(s[3])],
                        })
                        .collect(),
                })
            }
            "pattern" => {
                if values.len() != 2 {
                    return Err(bad(format!("{} values, expected 2", values.len())));
                }
                let (tile, width, height) =
                    tile.ok_or_else(|| bad("no pattern tile (define a pattern first)".into()))?;
                if width == 0 || height == 0 || tile.len() != width as usize * height as usize * 4 {
                    return Err(bad(format!(
                        "a {width}×{height} tile of {} bytes",
                        tile.len()
                    )));
                }
                FillSource::Pattern(PatternFill {
                    name: name.to_string(),
                    tile,
                    width,
                    height,
                    scale: c(values[0], 1.0, 1000.0),
                    angle: c(values[1], -360.0, 360.0),
                })
            }
            other => {
                return Err(IngestError::Unsupported(format!(
                    "unknown fill kind \"{other}\" (solid | gradient | pattern)"
                )))
            }
        })
    }
}

// ─────────────────────────── blending options ───────────────────────────

/// One channel's blending ranges: This Layer's and the Underlying
/// Layer's `[black low, black high, white low, white high]` (0–255; an
/// unsplit slider has low = high).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BlendIfChannel {
    pub this: [u8; 4],
    pub under: [u8; 4],
}

/// The sliders that pass everything.
pub const BLEND_IF_OPEN: [u8; 4] = [0, 0, 255, 255];

impl Default for BlendIfChannel {
    fn default() -> Self {
        BlendIfChannel {
            this: BLEND_IF_OPEN,
            under: BLEND_IF_OPEN,
        }
    }
}

/// BLEND IF — gray, red, green, blue.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct BlendIf {
    pub channels: [BlendIfChannel; 4],
}

impl BlendIf {
    /// Every slider open: no effect.
    pub fn is_open(&self) -> bool {
        self.channels
            .iter()
            .all(|c| c.this == BLEND_IF_OPEN && c.under == BLEND_IF_OPEN)
    }

    /// Does anything depend on what lies beneath?
    pub fn uses_underlying(&self) -> bool {
        self.channels.iter().any(|c| c.under != BLEND_IF_OPEN)
    }

    /// The `band.blend_if` parameter block: each slider pair as a ramp
    /// `clamp(v·k + o)` on the 0–1 value. A pair rises (black) or falls
    /// (white) over `high − low + 1` levels — a one-level step when the
    /// slider is not split, so an 8-bit level at the slider is in and the
    /// one beyond it is out — and an open pair is `k = 0, o = 1`.
    pub fn kernel_params(&self) -> image_kernels::families::band::BandBlendIfParams {
        let rise = |lo: u8, hi: u8| -> (f32, f32) {
            if lo == 0 && hi == 0 {
                return (0.0, 1.0);
            }
            let (lo, hi) = (f32::from(lo), f32::from(hi.max(lo)));
            let span = hi - lo + 1.0;
            (255.0 / span, -(lo - 1.0) / span)
        };
        let fall = |lo: u8, hi: u8| -> (f32, f32) {
            if lo == 255 && hi == 255 {
                return (0.0, 1.0);
            }
            let (lo, hi) = (f32::from(lo.min(hi)), f32::from(hi));
            let span = hi - lo + 1.0;
            (-255.0 / span, (hi + 1.0) / span)
        };
        let mut v = [0f32; 32];
        for (side, pick) in [0usize, 1].iter().zip([true, false]) {
            for ch in 0..4 {
                let s = if pick {
                    self.channels[ch].this
                } else {
                    self.channels[ch].under
                };
                let (lk, lo) = rise(s[0], s[1]);
                let (hk, ho) = fall(s[2], s[3]);
                // Field order: per side, lk0..3, lo0..3, hk0..3, ho0..3.
                let base = side * 16;
                v[base + ch] = lk;
                v[base + 4 + ch] = lo;
                v[base + 8 + ch] = hk;
                v[base + 12 + ch] = ho;
            }
        }
        image_kernels::families::band::BandBlendIfParams::new(
            v[0], v[1], v[2], v[3], v[4], v[5], v[6], v[7], v[8], v[9], v[10], v[11], v[12], v[13],
            v[14], v[15], v[16], v[17], v[18], v[19], v[20], v[21], v[22], v[23], v[24], v[25],
            v[26], v[27], v[28], v[29], v[30], v[31],
        )
    }

    /// As 32 bytes: per channel, This Layer's four then the Underlying's.
    pub fn to_bytes(&self) -> [u8; 32] {
        let mut out = [0u8; 32];
        for (ch, c) in self.channels.iter().enumerate() {
            out[ch * 8..ch * 8 + 4].copy_from_slice(&c.this);
            out[ch * 8 + 4..ch * 8 + 8].copy_from_slice(&c.under);
        }
        out
    }

    /// [`to_bytes`](Self::to_bytes)' inverse; a pair out of order is put
    /// in order.
    pub fn from_bytes(b: &[u8; 32]) -> BlendIf {
        let fix = |s: [u8; 4]| {
            let (b0, b1) = (s[0].min(s[1]), s[0].max(s[1]));
            let (w0, w1) = (s[2].min(s[3]), s[2].max(s[3]));
            [b0, b1, w0, w1]
        };
        let mut bi = BlendIf::default();
        for (ch, c) in bi.channels.iter_mut().enumerate() {
            c.this = fix(b[ch * 8..ch * 8 + 4].try_into().expect("4"));
            c.under = fix(b[ch * 8 + 4..ch * 8 + 8].try_into().expect("4"));
        }
        bi
    }
}

/// KNOCKOUT — where a layer's pixels are, the layers beneath it inside its
/// group (shallow) or down to the Background layer (deep) are cut away, so
/// the layer blends onto what is under them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Knockout {
    #[default]
    None,
    Shallow,
    Deep,
}

impl Knockout {
    pub fn from_wire(s: &str) -> Option<Knockout> {
        Some(match s {
            "none" => Knockout::None,
            "shallow" => Knockout::Shallow,
            "deep" => Knockout::Deep,
            _ => return None,
        })
    }

    pub fn as_wire(self) -> &'static str {
        match self {
            Knockout::None => "none",
            Knockout::Shallow => "shallow",
            Knockout::Deep => "deep",
        }
    }

    pub fn code(self) -> u8 {
        match self {
            Knockout::None => 0,
            Knockout::Shallow => 1,
            Knockout::Deep => 2,
        }
    }

    pub fn from_code(c: u8) -> Knockout {
        match c {
            1 => Knockout::Shallow,
            2 => Knockout::Deep,
            _ => Knockout::None,
        }
    }
}

/// The locks beyond the image-pixels lock (`Layer::locked`). The artboard
/// lock is not offered: the stack has no artboards to lock.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct LayerLocks {
    /// Paint, fills and filters keep each pixel's alpha.
    pub transparency: bool,
    /// The layer does not move (Move, nudge, align, distribute).
    pub position: bool,
    /// Everything: pixels, transparency, position and the blending
    /// properties (opacity, fill, mode, blend-if, knockout).
    pub all: bool,
}

impl LayerLocks {
    pub fn bits(self) -> u8 {
        u8::from(self.transparency) | u8::from(self.position) << 1 | u8::from(self.all) << 2
    }

    pub fn from_bits(b: u8) -> LayerLocks {
        LayerLocks {
            transparency: b & 1 != 0,
            position: b & 2 != 0,
            all: b & 4 != 0,
        }
    }
}

/// Photoshop's colour labels, in its order (0 = none).
pub const COLOR_LABELS: [&str; 8] = [
    "none", "red", "orange", "yellow", "green", "blue", "violet", "gray",
];

/// The Photoshop-parity properties every layer carries, in one place so a
/// layer literal names them once.
#[derive(Debug, Clone, PartialEq)]
pub struct LayerExt {
    /// FILL opacity, 0–1: the layer's own pixels, apart from its opacity.
    /// Outside the eight special modes it multiplies with the opacity; on
    /// them it acts inside the blend (`band.fade_neutral`).
    pub fill_opacity: f32,
    /// BLEND IF; `None` (or all open) passes everything.
    pub blend_if: Option<Box<BlendIf>>,
    pub knockout: Knockout,
    pub locks: LayerLocks,
    /// An index into [`COLOR_LABELS`].
    pub color: u8,
    /// The LINK this layer belongs to: linked layers move together.
    pub link: Option<u32>,
    /// The layer's STYLE (Photoshop's layer effects, `paged-psd`'s model);
    /// `None` for none. Shared: a snapshot copies the pointer.
    pub style: Option<Arc<image_psd::effects::LayerStyle>>,
    /// The blending options that change how a style composites.
    pub style_options: StyleOptions,
}

/// Blending Options ▸ Advanced Blending: the switches that change how a
/// layer's STYLE composites (Photoshop's `infx`, `clbl`, `tsly`, `lmgm`
/// and `vmgm` blocks).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StyleOptions {
    /// Blend Interior Effects as Group: the overlays, satin and inner glow
    /// join the layer before its mode and fill opacity apply.
    pub blend_interior: bool,
    /// Blend Clipped Layers as Group (the default, and the only way the
    /// stack draws a clipping group).
    pub blend_clipped: bool,
    /// Transparency Shapes Layer (the default; effects follow the layer's
    /// transparency).
    pub transparency_shapes: bool,
    /// Layer Mask Hides Effects: the mask hides the drawn effects instead
    /// of shaping them.
    pub mask_hides_effects: bool,
    /// Vector Mask Hides Effects (the stack keeps the vector mask in the
    /// layer's one mask, so either switch hides through it).
    pub vector_mask_hides_effects: bool,
}

impl Default for StyleOptions {
    fn default() -> Self {
        StyleOptions {
            blend_interior: false,
            blend_clipped: true,
            transparency_shapes: true,
            mask_hides_effects: false,
            vector_mask_hides_effects: false,
        }
    }
}

impl StyleOptions {
    /// Does the mask hide the effects (rather than shape them)?
    pub fn hides(&self) -> bool {
        self.mask_hides_effects || self.vector_mask_hides_effects
    }

    /// The five switches as bits (persistence): 1 interior, 2 clipped,
    /// 4 transparency shapes, 8 mask hides, 16 vector mask hides.
    pub fn bits(&self) -> u8 {
        u8::from(self.blend_interior)
            | u8::from(self.blend_clipped) << 1
            | u8::from(self.transparency_shapes) << 2
            | u8::from(self.mask_hides_effects) << 3
            | u8::from(self.vector_mask_hides_effects) << 4
    }

    pub fn from_bits(b: u8) -> StyleOptions {
        StyleOptions {
            blend_interior: b & 1 != 0,
            blend_clipped: b & 2 != 0,
            transparency_shapes: b & 4 != 0,
            mask_hides_effects: b & 8 != 0,
            vector_mask_hides_effects: b & 16 != 0,
        }
    }
}

impl Default for LayerExt {
    fn default() -> Self {
        LayerExt {
            fill_opacity: 1.0,
            blend_if: None,
            knockout: Knockout::None,
            locks: LayerLocks::default(),
            color: 0,
            link: None,
            style: None,
            style_options: StyleOptions::default(),
        }
    }
}

/// Photoshop's eight special blend modes and each one's NEUTRAL colour —
/// the source value that blends to the backdrop unchanged, toward which
/// fill opacity moves the source. `None` for every other mode.
pub fn special_fill_neutral(blend: &KernelDef) -> Option<f32> {
    Some(match blend.id {
        "compose.color_dodge" | "compose.linear_dodge" | "compose.difference" => 0.0,
        "compose.color_burn" | "compose.linear_burn" => 1.0,
        "compose.vivid_light" | "compose.linear_light" | "compose.hard_mix" => 0.5,
        _ => return None,
    })
}

// ───────────────────────────── layer comps ─────────────────────────────

/// What a layer comp recorded about one layer.
#[derive(Debug, Clone)]
pub struct CompEntry {
    /// The layer's stable id.
    pub id: u32,
    pub visible: bool,
    /// POSITION: the layer's pixels as they were placed. The stack's
    /// layers have no position apart from their pixels, so a comp keeps
    /// the pixels (a shared buffer, not a copy) and applying it puts them
    /// back.
    pub pixels: Option<crate::pixels::LayerPixels>,
    pub appearance: Option<CompAppearance>,
}

/// APPEARANCE: the blending properties.
#[derive(Debug, Clone, PartialEq)]
pub struct CompAppearance {
    pub opacity: f32,
    pub fill_opacity: f32,
    pub blend: &'static KernelDef,
    pub blend_if: Option<Box<BlendIf>>,
    pub knockout: Knockout,
}

/// A LAYER COMP: a named record of the layers' visibility, position and
/// appearance (Photoshop's three), applied in one undo step.
#[derive(Debug, Clone)]
pub struct LayerComp {
    pub id: u32,
    pub name: String,
    pub visibility: bool,
    pub position: bool,
    pub appearance: bool,
    pub entries: Vec<CompEntry>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[allow(non_snake_case)]
    fn every_typed_kind_round_trips_its_wire_block__feat__image_layers_photoshop_parity() {
        for kind in ADJUSTMENT_KINDS {
            let a = Adjustment::default_for(kind).expect("a default");
            assert_eq!(a.kind_name(), kind);
            let back = Adjustment::from_wire(kind, &a.values(), a.blob().unwrap_or(&[]), a.label())
                .expect("wire");
            assert_eq!(back, a, "{kind}");
            // Every chain kind lowers; the three direct kinds dispatch.
            assert_eq!(
                a.to_chain().is_none(),
                matches!(
                    kind,
                    "gradientMap" | "selectiveColor" | "colorLookup" | "develop"
                ),
                "{kind}"
            );
        }
        assert!(Adjustment::from_wire("levels", &[0.0; 3], &[], "").is_err());
        assert!(Adjustment::from_wire("sepia", &[], &[], "").is_err());
    }

    #[test]
    #[allow(non_snake_case)]
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
                Adjustment::default_for(kind).expect("kind").is_identity(),
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
                !Adjustment::default_for(kind).expect("kind").is_identity(),
                "{kind}"
            );
        }
    }

    /// The Develop layer (WP5.2): its wire block is the 61 settings in
    /// `families::develop`'s order, values clamp to their ranges, the
    /// wrong length is refused, and it dispatches the develop kernels —
    /// tone then detail, an identity half skipped.
    #[test]
    #[allow(non_snake_case)]
    fn a_develop_layer_carries_its_61_settings_and_dispatches_the_develop_kernels__feat__image_editor_filters(
    ) {
        use image_kernels::families::develop::{DevelopSettings, DEVELOP_LEN};
        let d = Adjustment::default_for("develop").expect("develop");
        assert_eq!(d.kind_name(), "develop");
        assert_eq!(d.default_layer_name(), "Develop");
        assert_eq!(d.values(), DevelopSettings::identity().0.to_vec());
        assert!(d.is_identity() && d.direct_ops().is_empty());
        let mut v = DevelopSettings::identity().0.to_vec();
        v[2] = 1.5; // exposure
        v[9] = 250.0; // clarity, past its range
        let a = Adjustment::from_wire("develop", &v, &[], "").expect("wire");
        assert_eq!(a.values()[2], 1.5);
        assert_eq!(a.values()[9], 100.0, "clamped to the range");
        assert!(!a.is_identity());
        let ids: Vec<&str> = a.direct_ops().iter().map(|(k, _)| k.id).collect();
        assert_eq!(ids, ["develop.tone", "develop.detail"]);
        v[9] = 0.0;
        let tone_only = Adjustment::from_wire("develop", &v, &[], "").expect("wire");
        let ids: Vec<&str> = tone_only.direct_ops().iter().map(|(k, _)| k.id).collect();
        assert_eq!(ids, ["develop.tone"]);
        assert!(Adjustment::from_wire("develop", &[0.0; DEVELOP_LEN - 1], &[], "").is_err());
        assert_eq!(ADJUSTMENT_KINDS.last(), Some(&"develop"));
    }

    /// A one-stage chain opens as its typed layer; a two-stage chain stays
    /// a chain; and the typed layer evaluates exactly as the chain did.
    #[test]
    #[allow(non_snake_case)]
    fn a_stored_chain_migrates_to_its_typed_layer__feat__image_layers_photoshop_parity() {
        let one = AdjustParams {
            exposure_ev: 0.75,
            ..AdjustParams::default()
        };
        let typed = Adjustment::from_chain(one.clone());
        assert_eq!(typed.kind_name(), "exposure");
        assert_eq!(typed.to_chain(), Some(one));
        let inv = AdjustParams {
            invert: true,
            ..AdjustParams::default()
        };
        assert_eq!(Adjustment::from_chain(inv), Adjustment::Invert);
        let two = AdjustParams {
            exposure_ev: 0.5,
            invert: true,
            ..AdjustParams::default()
        };
        assert_eq!(Adjustment::from_chain(two.clone()), Adjustment::Chain(two));
        let post = AdjustParams {
            posterize: Some(5.0),
            ..AdjustParams::default()
        };
        assert_eq!(
            Adjustment::from_chain(post),
            Adjustment::Posterize { levels: 5.0 }
        );
    }

    #[test]
    #[allow(non_snake_case)]
    fn a_stop_ramp_interpolates_and_reverses__feat__image_layers_photoshop_parity() {
        let stops = [
            ColorStop {
                at: 0.0,
                rgb: [0, 0, 0],
            },
            ColorStop {
                at: 1.0,
                rgb: [255, 0, 255],
            },
        ];
        let r = stop_ramp(&stops, false);
        assert_eq!(r[0], [0.0, 0.0, 0.0]);
        assert_eq!(r[255], [1.0, 0.0, 1.0]);
        assert!((r[128][0] - 128.0 / 255.0).abs() < 1e-5);
        let rev = stop_ramp(&stops, true);
        assert_eq!(rev[0], [1.0, 0.0, 1.0]);
    }

    /// The ramps the kernel gets: open passes everything; an unsplit black
    /// slider at 64 lets 64 through and stops 63; a split one rises across
    /// its span.
    #[test]
    #[allow(non_snake_case)]
    fn blend_if_sliders_become_ramps__feat__image_layers_photoshop_parity() {
        let ramp = |k: f32, o: f32, level: f32| (level / 255.0 * k + o).clamp(0.0, 1.0);
        let open = BlendIf::default();
        assert!(open.is_open());
        let p = open.kernel_params();
        assert_eq!((p.slk0, p.slo0, p.shk0, p.sho0), (0.0, 1.0, 0.0, 1.0));
        let mut bi = BlendIf::default();
        bi.channels[0].this = [64, 64, 255, 255];
        bi.channels[1].under = [0, 0, 200, 220];
        let p = bi.kernel_params();
        assert!(ramp(p.slk0, p.slo0, 64.0) >= 0.999);
        assert!(ramp(p.slk0, p.slo0, 63.0) <= 0.001);
        assert!(ramp(p.dhk1, p.dho1, 200.0) >= 0.999);
        assert!(ramp(p.dhk1, p.dho1, 221.0) <= 0.001);
        let mid = ramp(p.dhk1, p.dho1, 210.0);
        assert!(mid > 0.3 && mid < 0.7, "{mid}");
        assert_eq!(BlendIf::from_bytes(&bi.to_bytes()), bi);
        assert!(bi.uses_underlying());
    }
}
