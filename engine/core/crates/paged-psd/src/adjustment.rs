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

//! ADJUSTMENT LAYERS — the additional-layer-info blocks that make a layer
//! an adjustment: read into plain values the layer stack maps onto its
//! typed adjustments, and WRITTEN back in the layouts Photoshop writes.
//!
//! Read and written: Curves (`curv`), Levels (`levl`), Exposure (`expA`),
//! Invert (`nvrt`), Hue/Saturation (`hue2`), Brightness/Contrast (`brit`
//! plus its `CgEd` descriptor), Color Balance (`blnc`), Vibrance (`vibA`),
//! Black & White (`blwh`), Photo Filter (`phfl`), Channel Mixer (`mixr`),
//! Posterize (`post`), Threshold (`thrs`), Gradient Map (`grdm`) and
//! Selective Color (`selc`). The legacy `hue ` and Color Lookup (`clrL`,
//! whose look Photoshop compiles into an embedded profile) are left to
//! the import's refusal list. A block that parses but carries something
//! the layer stack does not reproduce (Levels records past the RGB
//! channels, custom Hue/Saturation range bounds, a legacy
//! Brightness/Contrast, a tinted Black & White, a gradient with
//! transparency or moved midpoints) is reported by
//! [`Adjustment::unmodelled`] so the import can decline it by name rather
//! than approximate it.
//!
//! Writing ([`Adjustment::to_blocks`]) is the inverse: `parse(to_blocks(a))
//! == a` for every value, and the bytes follow Photoshop's own (version
//! words, padding, the descriptor style) so a written layer reopens in
//! Photoshop as the same live adjustment.
//!
//! Provenance: Adobe Photoshop File Formats specification — Adjustment
//! Layers (Levels, Curves, Exposure, Invert, Hue/Saturation 2,
//! Brightness and Contrast, Color Balance, Black and White, Photo Filter,
//! Channel Mixer, Posterize, Threshold, Gradient Map, Selective Color,
//! Vibrance) [PUB]; the layouts checked byte for byte against adjustment
//! layers Photoshop 27.10 wrote itself (`modules/image/image-conformance/
//! fixtures/photoshop/adjustment-layers/` and `adjustment-layers-ext/`)
//! [OBS].

use crate::descriptor::{
    build, read_versioned_descriptor, versioned_descriptor_bytes, Descriptor, DescriptorValue,
};
use crate::reader::ByteReader;
use crate::{PsdError, Result};

/// One Levels record: input floor/ceiling, output floor/ceiling (0–255)
/// and gamma (×100, so 100 = 1.0).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LevelsRecord {
    pub in_black: u16,
    pub in_white: u16,
    pub out_black: u16,
    pub out_white: u16,
    pub gamma_x100: u16,
}

impl LevelsRecord {
    pub const IDENTITY: LevelsRecord = LevelsRecord {
        in_black: 0,
        in_white: 255,
        out_black: 0,
        out_white: 255,
        gamma_x100: 100,
    };

    pub fn is_identity(&self) -> bool {
        *self == Self::IDENTITY
    }
}

/// Photoshop's default Hue/Saturation range bounds — begin ramp, begin
/// sustain, end sustain, end ramp, in degrees — for reds, yellows,
/// greens, cyans, blues and magentas.
pub const HUE_RANGE_DEFAULTS: [[i16; 4]; 6] = [
    [315, 345, 15, 45],
    [15, 45, 75, 105],
    [75, 105, 135, 165],
    [135, 165, 195, 225],
    [195, 225, 255, 285],
    [255, 285, 315, 345],
];

/// The Black & White tint colour Photoshop writes when the tint is off
/// (its dialog default), RGB 0–255 [OBS].
pub const BLACK_WHITE_DEFAULT_TINT: [f64; 3] = [225.0, 211.0, 179.0];

/// A Photo Filter's colour as stored: Photoshop 27.10 writes version 2
/// with a Lab colour (L ×100, a and b ×100, signed) [OBS]; version 2 may
/// carry RGB (16-bit components) and version 3 an XYZ triple [PUB].
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum FilterColor {
    /// L 0–100, a and b −128..127.
    Lab([f64; 3]),
    /// 0–65535 per component.
    Rgb([u16; 3]),
    /// The version-3 XYZ triple as stored (each a 32-bit integer).
    Xyz([u32; 3]),
}

/// A Gradient Map colour stop: where (0–4096), its midpoint to the next
/// (percent, 50 = halfway) and its RGB colour (16-bit components).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GradientMapStop {
    pub location: u32,
    pub midpoint: u32,
    pub rgb16: [u16; 3],
}

/// A Gradient Map transparency stop: location, midpoint, opacity (0–255).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GradientMapOpacity {
    pub location: u32,
    pub midpoint: u32,
    pub opacity: u16,
}

/// The fields after a Gradient Map's stops (noise parameters Photoshop
/// writes for every gradient), as Photoshop 27.10 wrote them with the
/// random seed zeroed [OBS]. Kept verbatim when a block is read.
const GRADIENT_MAP_TAIL: [u8; 42] = [
    0x00, 0x02, 0x10, 0x00, 0x00, 0x20, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x08, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x80, 0x00,
    0x80, 0x00, 0x80, 0x00, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00,
];

/// A parsed adjustment.
#[derive(Debug, Clone, PartialEq)]
pub enum Adjustment {
    /// Curves: `curves[0]` is the composite (RGB) curve, `[1..=3]` red,
    /// green and blue. A curve is its control points as (input, output),
    /// 0–255, in input order.
    Curves { curves: [Option<Vec<(u8, u8)>>; 4] },
    /// Levels: the composite record, then red, green and blue.
    /// `extra_records` is true when records past those four (the legacy
    /// 29 plus the `Lvls` extension) are not the identity.
    Levels {
        records: [LevelsRecord; 4],
        extra_records: bool,
    },
    /// Exposure: stops, offset, gamma.
    Exposure {
        exposure: f32,
        offset: f32,
        gamma: f32,
    },
    /// Invert: no parameters.
    Invert,
    /// Hue/Saturation: `master` and each range as (hue −180..180,
    /// saturation −100..100, lightness −100..100); `colorize` as (hue
    /// 0..360, saturation 0..100, lightness −100..100), applied instead of
    /// the master when `colorized`. `bounds` are the ranges' extents.
    HueSaturation {
        colorized: bool,
        colorize: [i16; 3],
        master: [i16; 3],
        ranges: [[i16; 3]; 6],
        bounds: [[i16; 4]; 6],
    },
    /// Brightness/Contrast (`CgEd`, the `brit` block beside it zeroed by
    /// Photoshop for the modern mode): brightness −150..150, contrast
    /// −50..100, the mean, Lab-only, `legacy` (the pre-CS3 formula) and
    /// `auto`.
    BrightnessContrast {
        brightness: i32,
        contrast: i32,
        mean: i32,
        lab: bool,
        legacy: bool,
        auto: bool,
    },
    /// Color Balance: shadows, midtones and highlights as (cyan–red,
    /// magenta–green, yellow–blue) −100..100, and Preserve Luminosity.
    ColorBalance {
        shadows: [i16; 3],
        midtones: [i16; 3],
        highlights: [i16; 3],
        preserve_luminosity: bool,
    },
    /// Vibrance and saturation, −100..100.
    Vibrance { vibrance: i32, saturation: i32 },
    /// Black & White: reds, yellows, greens, cyans, blues, magentas
    /// (percent, −200..300), the tint (when on) and its colour.
    BlackWhite {
        weights: [i32; 6],
        tint: bool,
        tint_rgb: [f64; 3],
    },
    /// Photo Filter: the filter colour, density 1–100, Preserve
    /// Luminosity.
    PhotoFilter {
        color: FilterColor,
        density: u32,
        preserve_luminosity: bool,
    },
    /// Channel Mixer: the red, green and blue output rows as `[from red,
    /// from green, from blue, constant]`, percent; `monochrome` uses the
    /// first row for every channel.
    ChannelMixer {
        rows: [[i16; 4]; 3],
        monochrome: bool,
    },
    /// Posterize: 2–255 levels.
    Posterize { levels: u16 },
    /// Threshold: the level 1–255.
    Threshold { level: u16 },
    /// Gradient Map: its stops, transparency stops, Reverse and Dither,
    /// and the interpolation method key of version 3 (`Gcls` classic).
    GradientMap {
        name: String,
        stops: Vec<GradientMapStop>,
        opacity: Vec<GradientMapOpacity>,
        reverse: bool,
        dither: bool,
        method: [u8; 4],
        tail: Vec<u8>,
    },
    /// Selective Color: reds, yellows, greens, cyans, blues, magentas,
    /// whites, neutrals and blacks as (cyan, magenta, yellow, black)
    /// −100..100; relative or absolute.
    SelectiveColor {
        ranges: [[i16; 4]; 9],
        absolute: bool,
    },
}

impl Adjustment {
    /// The additional-layer-info keys that make a layer one of these
    /// adjustments (`CgEd` rides beside `brit`).
    pub const KEYS: [&'static [u8; 4]; 15] = [
        b"curv", b"levl", b"expA", b"nvrt", b"hue2", b"brit", b"blnc", b"vibA", b"blwh", b"phfl",
        b"mixr", b"post", b"thrs", b"grdm", b"selc",
    ];

    /// Every block that belongs to an adjustment layer's adjustment —
    /// what a writer replacing the adjustment removes first (the modelled
    /// keys, `CgEd`, the legacy `hue ` and Color Lookup's `clrL`).
    pub const ALL_KEYS: [&'static [u8; 4]; 18] = [
        b"curv", b"levl", b"expA", b"nvrt", b"hue2", b"brit", b"blnc", b"vibA", b"blwh", b"phfl",
        b"mixr", b"post", b"thrs", b"grdm", b"selc", b"CgEd", b"hue ", b"clrL",
    ];

    /// Parse the payload of block `key` (the bytes after its length).
    /// `None` for a key this module does not read. A Brightness/Contrast
    /// read this way has only its legacy `brit` fields; a record's
    /// [`Adjustment::from_blocks`] reads its `CgEd` too.
    pub fn parse(key: &[u8; 4], payload: &[u8]) -> Result<Option<Adjustment>> {
        let mut r = ByteReader::new(payload);
        Ok(Some(match key {
            b"curv" => parse_curves(&mut r)?,
            b"levl" => parse_levels(&mut r)?,
            b"expA" => {
                let _version = r.u16()?;
                Adjustment::Exposure {
                    exposure: f32::from_bits(r.u32()?),
                    offset: f32::from_bits(r.u32()?),
                    gamma: f32::from_bits(r.u32()?),
                }
            }
            b"nvrt" => Adjustment::Invert,
            b"hue2" => parse_hue_saturation(&mut r)?,
            b"brit" => Adjustment::BrightnessContrast {
                brightness: i32::from(r.i16()?),
                contrast: i32::from(r.i16()?),
                mean: i32::from(r.i16()?),
                lab: r.u8()? != 0,
                legacy: true,
                auto: false,
            },
            b"blnc" => {
                let triple =
                    |r: &mut ByteReader| -> Result<[i16; 3]> { Ok([r.i16()?, r.i16()?, r.i16()?]) };
                Adjustment::ColorBalance {
                    shadows: triple(&mut r)?,
                    midtones: triple(&mut r)?,
                    highlights: triple(&mut r)?,
                    preserve_luminosity: r.u8()? != 0,
                }
            }
            b"vibA" => {
                let (_, d) = read_versioned_descriptor(&mut r)?;
                Adjustment::Vibrance {
                    vibrance: d.i32(b"vibrance").unwrap_or(0),
                    saturation: d.i32(b"Strt").unwrap_or(0),
                }
            }
            b"blwh" => parse_black_white(&mut r)?,
            b"phfl" => parse_photo_filter(&mut r)?,
            b"mixr" => parse_channel_mixer(&mut r)?,
            b"post" => Adjustment::Posterize { levels: r.u16()? },
            b"thrs" => Adjustment::Threshold { level: r.u16()? },
            b"grdm" => parse_gradient_map(&mut r)?,
            b"selc" => parse_selective_color(&mut r)?,
            _ => return Ok(None),
        }))
    }

    /// The adjustment a record's blocks make (`blocks` = each block's key
    /// and payload, in record order): the first [`Adjustment::KEYS`] block,
    /// a Brightness/Contrast completed from its `CgEd` descriptor.
    pub fn from_blocks<'a>(
        blocks: impl IntoIterator<Item = (&'a [u8; 4], &'a [u8])> + Clone,
    ) -> Result<Option<Adjustment>> {
        let Some((key, payload)) = blocks
            .clone()
            .into_iter()
            .find(|(k, _)| Adjustment::KEYS.contains(k))
        else {
            return Ok(None);
        };
        let adj = Adjustment::parse(key, payload)?;
        if key != b"brit" {
            return Ok(adj);
        }
        let Some((_, cged)) = blocks.into_iter().find(|(k, _)| *k == b"CgEd") else {
            return Ok(adj);
        };
        let (_, d) = read_versioned_descriptor(&mut ByteReader::new(cged))?;
        Ok(Some(Adjustment::BrightnessContrast {
            brightness: d.i32(b"Brgh").unwrap_or(0),
            contrast: d.i32(b"Cntr").unwrap_or(0),
            mean: d.i32(b"means").unwrap_or(127),
            lab: d.bool(b"Lab ").unwrap_or(false),
            legacy: d.bool(b"useLegacy").unwrap_or(false),
            auto: d.bool(b"Auto").unwrap_or(false),
        }))
    }

    /// What this adjustment carries that the layer stack's adjustments do
    /// not reproduce, as a phrase for the refusal; `None` when it is
    /// fully modelled.
    pub fn unmodelled(&self) -> Option<&'static str> {
        match self {
            Adjustment::Levels { extra_records, .. } => {
                extra_records.then_some("Levels on channels other than red, green and blue")
            }
            Adjustment::HueSaturation { bounds, .. } => (*bounds != HUE_RANGE_DEFAULTS)
                .then_some("Hue/Saturation colour ranges moved off their defaults"),
            Adjustment::BrightnessContrast { legacy, auto, .. } => {
                (*legacy || *auto).then_some("a legacy or automatic Brightness/Contrast")
            }
            Adjustment::BlackWhite { tint, .. } => tint.then_some("a tinted Black & White"),
            Adjustment::ColorBalance {
                preserve_luminosity,
                ..
            } => (!preserve_luminosity)
                .then_some("a Color Balance that does not preserve luminosity"),
            Adjustment::PhotoFilter { color, .. } => matches!(color, FilterColor::Xyz(_))
                .then_some("a Photo Filter colour stored as XYZ"),
            Adjustment::GradientMap { stops, opacity, .. } => {
                if stops.len() < 2 {
                    Some("a Gradient Map with fewer than two colour stops")
                } else if stops[..stops.len() - 1].iter().any(|s| s.midpoint != 50) {
                    Some("a Gradient Map with moved midpoints")
                } else if opacity.iter().any(|o| o.opacity != 255) {
                    Some("a Gradient Map with transparency")
                } else {
                    None
                }
            }
            Adjustment::Curves { .. }
            | Adjustment::Exposure { .. }
            | Adjustment::Invert
            | Adjustment::Vibrance { .. }
            | Adjustment::ChannelMixer { .. }
            | Adjustment::Posterize { .. }
            | Adjustment::Threshold { .. }
            | Adjustment::SelectiveColor { .. } => None,
        }
    }

    /// The blocks that make a layer this adjustment, in the order
    /// Photoshop writes them: each key and its payload (the bytes after
    /// the block length, before the record's even pad). Photoshop pads a
    /// descriptor block's payload to a multiple of four INSIDE its
    /// length (`vibA`: 58 bytes of descriptor, length 60) [OBS], and so
    /// does this.
    pub fn to_blocks(&self) -> Vec<([u8; 4], Vec<u8>)> {
        let mut blocks = self.blocks_unpadded();
        for (key, v) in &mut blocks {
            if matches!(&*key, b"vibA" | b"blwh" | b"CgEd") {
                while v.len() % 4 != 0 {
                    v.push(0);
                }
            }
            // Curves: padded to even inside the length [OBS].
            if &*key == b"curv" && v.len() % 2 == 1 {
                v.push(0);
            }
        }
        blocks
    }

    fn blocks_unpadded(&self) -> Vec<([u8; 4], Vec<u8>)> {
        let be16 = |v: &mut Vec<u8>, x: u16| v.extend_from_slice(&x.to_be_bytes());
        let i16s = |v: &mut Vec<u8>, x: i16| v.extend_from_slice(&x.to_be_bytes());
        match self {
            Adjustment::Invert => vec![(*b"nvrt", Vec::new())],
            Adjustment::Exposure {
                exposure,
                offset,
                gamma,
            } => {
                let mut v = Vec::new();
                be16(&mut v, 1);
                for x in [exposure, offset, gamma] {
                    v.extend_from_slice(&x.to_bits().to_be_bytes());
                }
                vec![(*b"expA", v)]
            }
            Adjustment::Levels { records, .. } => {
                let mut v = Vec::new();
                be16(&mut v, 2);
                for k in 0..29 {
                    let r = records.get(k).copied().unwrap_or(LevelsRecord::IDENTITY);
                    for x in [
                        r.in_black,
                        r.in_white,
                        r.out_black,
                        r.out_white,
                        r.gamma_x100,
                    ] {
                        be16(&mut v, x);
                    }
                }
                vec![(*b"levl", v)]
            }
            Adjustment::Curves { curves } => {
                let mut v = vec![0u8];
                be16(&mut v, 1);
                let map = curves
                    .iter()
                    .enumerate()
                    .filter(|(_, c)| c.as_ref().is_some_and(|c| !c.is_empty()))
                    .fold(0u32, |m, (i, _)| m | 1 << i);
                v.extend_from_slice(&map.to_be_bytes());
                let present: Vec<(u16, &Vec<(u8, u8)>)> = curves
                    .iter()
                    .enumerate()
                    .filter_map(|(i, c)| {
                        c.as_ref().filter(|c| !c.is_empty()).map(|c| (i as u16, c))
                    })
                    .collect();
                let points = |v: &mut Vec<u8>, c: &[(u8, u8)]| {
                    be16(v, c.len() as u16);
                    for &(input, output) in c {
                        // Output first, then input (Photoshop's order).
                        be16(v, u16::from(output));
                        be16(v, u16::from(input));
                    }
                };
                for (_, c) in &present {
                    points(&mut v, c);
                }
                // The `Crv ` extension repeats the curves keyed by channel
                // index; Photoshop 27.10 writes it and REFUSES to open a
                // file whose Curves block lacks it [OBS: psd-readback].
                v.extend_from_slice(b"Crv ");
                be16(&mut v, 4);
                v.extend_from_slice(&(present.len() as u32).to_be_bytes());
                for (i, c) in &present {
                    be16(&mut v, *i);
                    points(&mut v, c);
                }
                vec![(*b"curv", v)]
            }
            Adjustment::HueSaturation {
                colorized,
                colorize,
                master,
                ranges,
                bounds,
            } => {
                let mut v = Vec::new();
                be16(&mut v, 2);
                v.push(u8::from(*colorized));
                v.push(0);
                for x in colorize.iter().chain(master) {
                    i16s(&mut v, *x);
                }
                for (k, r) in ranges.iter().enumerate() {
                    for b in bounds[k] {
                        i16s(&mut v, b);
                    }
                    for x in r {
                        i16s(&mut v, *x);
                    }
                }
                vec![(*b"hue2", v)]
            }
            Adjustment::BrightnessContrast {
                brightness,
                contrast,
                mean,
                lab,
                legacy,
                auto,
            } => {
                // Photoshop zeroes the legacy block unless the legacy
                // formula is on, and keeps the truth in `CgEd` [OBS].
                let mut brit = Vec::new();
                if *legacy {
                    i16s(&mut brit, *brightness as i16);
                    i16s(&mut brit, *contrast as i16);
                    i16s(&mut brit, *mean as i16);
                    brit.push(u8::from(*lab));
                    brit.push(0);
                } else {
                    brit.extend_from_slice(&[0; 8]);
                }
                let d = build::desc(
                    b"null",
                    vec![
                        (b"Vrsn", DescriptorValue::Integer(1)),
                        (b"Brgh", DescriptorValue::Integer(*brightness)),
                        (b"Cntr", DescriptorValue::Integer(*contrast)),
                        (b"means", DescriptorValue::Integer(*mean)),
                        (b"Lab ", DescriptorValue::Bool(*lab)),
                        (b"useLegacy", DescriptorValue::Bool(*legacy)),
                        (b"Auto", DescriptorValue::Bool(*auto)),
                    ],
                );
                vec![(*b"brit", brit), (*b"CgEd", versioned_descriptor_bytes(&d))]
            }
            Adjustment::ColorBalance {
                shadows,
                midtones,
                highlights,
                preserve_luminosity,
            } => {
                let mut v = Vec::new();
                for x in shadows.iter().chain(midtones).chain(highlights) {
                    i16s(&mut v, *x);
                }
                v.push(u8::from(*preserve_luminosity));
                v.push(0);
                vec![(*b"blnc", v)]
            }
            Adjustment::Vibrance {
                vibrance,
                saturation,
            } => {
                let d = build::desc(
                    b"null",
                    vec![
                        (b"vibrance", DescriptorValue::Integer(*vibrance)),
                        (b"Strt", DescriptorValue::Integer(*saturation)),
                    ],
                );
                vec![(*b"vibA", versioned_descriptor_bytes(&d))]
            }
            Adjustment::BlackWhite {
                weights,
                tint,
                tint_rgb,
            } => {
                let w = |i: usize| DescriptorValue::Integer(weights[i]);
                let d = build::desc(
                    b"null",
                    vec![
                        (b"Rd  ", w(0)),
                        (b"Yllw", w(1)),
                        (b"Grn ", w(2)),
                        (b"Cyn ", w(3)),
                        (b"Bl  ", w(4)),
                        (b"Mgnt", w(5)),
                        (b"useTint", DescriptorValue::Bool(*tint)),
                        (b"tintColor", rgb_doubles(*tint_rgb)),
                        (b"bwPresetKind", DescriptorValue::Integer(4)),
                        (
                            b"blackAndWhitePresetFileName",
                            DescriptorValue::Text(String::new()),
                        ),
                    ],
                );
                vec![(*b"blwh", versioned_descriptor_bytes(&d))]
            }
            Adjustment::PhotoFilter {
                color,
                density,
                preserve_luminosity,
            } => {
                let mut v = Vec::new();
                match color {
                    FilterColor::Xyz(xyz) => {
                        be16(&mut v, 3);
                        for c in xyz {
                            v.extend_from_slice(&c.to_be_bytes());
                        }
                    }
                    FilterColor::Lab([l, a, b]) => {
                        be16(&mut v, 2);
                        be16(&mut v, 7);
                        be16(&mut v, (l * 100.0).round().clamp(0.0, 10000.0) as u16);
                        for c in [a, b] {
                            i16s(&mut v, (c * 100.0).round().clamp(-12800.0, 12700.0) as i16);
                        }
                        be16(&mut v, 0);
                    }
                    FilterColor::Rgb(rgb) => {
                        be16(&mut v, 2);
                        be16(&mut v, 0);
                        for c in rgb {
                            be16(&mut v, *c);
                        }
                        be16(&mut v, 0);
                    }
                }
                v.extend_from_slice(&density.to_be_bytes());
                v.push(u8::from(*preserve_luminosity));
                // Photoshop pads the block to a multiple of four [OBS].
                while v.len() % 4 != 0 {
                    v.push(0);
                }
                vec![(*b"phfl", v)]
            }
            Adjustment::ChannelMixer { rows, monochrome } => {
                let mut v = Vec::new();
                be16(&mut v, 1);
                be16(&mut v, u16::from(*monochrome));
                // Four output records of five words — red, green, blue,
                // an unused fourth source, the constant — the fourth
                // record all zero (an RGB document has no fourth output).
                for k in 0..4 {
                    let r = if *monochrome {
                        if k == 0 {
                            rows[0]
                        } else {
                            [0; 4]
                        }
                    } else {
                        rows.get(k).copied().unwrap_or([0; 4])
                    };
                    for x in [r[0], r[1], r[2], 0, r[3]] {
                        i16s(&mut v, x);
                    }
                }
                vec![(*b"mixr", v)]
            }
            Adjustment::Posterize { levels } => {
                let mut v = Vec::new();
                be16(&mut v, *levels);
                be16(&mut v, 0);
                vec![(*b"post", v)]
            }
            Adjustment::Threshold { level } => {
                let mut v = Vec::new();
                be16(&mut v, *level);
                be16(&mut v, 0);
                vec![(*b"thrs", v)]
            }
            Adjustment::GradientMap {
                name,
                stops,
                opacity,
                reverse,
                dither,
                method,
                tail,
            } => {
                let mut v = Vec::new();
                be16(&mut v, 3);
                v.push(u8::from(*reverse));
                v.push(u8::from(*dither));
                v.extend_from_slice(method);
                crate::descriptor::write_unicode_string(&mut v, name);
                be16(&mut v, stops.len() as u16);
                for s in stops {
                    v.extend_from_slice(&s.location.to_be_bytes());
                    v.extend_from_slice(&s.midpoint.to_be_bytes());
                    be16(&mut v, 0); // RGB
                    for c in s.rgb16 {
                        be16(&mut v, c);
                    }
                    be16(&mut v, 0);
                    be16(&mut v, 0);
                }
                be16(&mut v, opacity.len() as u16);
                for o in opacity {
                    v.extend_from_slice(&o.location.to_be_bytes());
                    v.extend_from_slice(&o.midpoint.to_be_bytes());
                    be16(&mut v, o.opacity);
                }
                if tail.is_empty() {
                    v.extend_from_slice(&GRADIENT_MAP_TAIL);
                } else {
                    v.extend_from_slice(tail);
                }
                vec![(*b"grdm", v)]
            }
            Adjustment::SelectiveColor { ranges, absolute } => {
                let mut v = Vec::new();
                be16(&mut v, 1);
                be16(&mut v, u16::from(*absolute));
                // Record 0 is reserved, then the nine ranges.
                v.extend_from_slice(&[0; 8]);
                for r in ranges {
                    for x in r {
                        i16s(&mut v, *x);
                    }
                }
                vec![(*b"selc", v)]
            }
        }
    }

    /// A Gradient Map with Photoshop's defaults around `stops` (opaque
    /// ends, midpoints at 50, classic interpolation).
    pub fn gradient_map(stops: Vec<GradientMapStop>, reverse: bool) -> Adjustment {
        Adjustment::GradientMap {
            name: "Custom".into(),
            stops,
            opacity: vec![
                GradientMapOpacity {
                    location: 0,
                    midpoint: 50,
                    opacity: 255,
                },
                GradientMapOpacity {
                    location: 4096,
                    midpoint: 50,
                    opacity: 255,
                },
            ],
            reverse,
            dither: false,
            method: *b"Gcls",
            tail: Vec::new(),
        }
    }
}

fn rgb_doubles(c: [f64; 3]) -> DescriptorValue {
    build::obj(
        b"RGBC",
        vec![
            (b"Rd  ", DescriptorValue::Double(c[0])),
            (b"Grn ", DescriptorValue::Double(c[1])),
            (b"Bl  ", DescriptorValue::Double(c[2])),
        ],
    )
}

fn rgb_of(d: &Descriptor) -> Option<[f64; 3]> {
    Some([d.number(b"Rd  ")?, d.number(b"Grn ")?, d.number(b"Bl  ")?])
}

/// `blwh`: a version-16 descriptor — six weights, the tint switch and
/// colour, the preset kind and file name [OBS].
fn parse_black_white(r: &mut ByteReader) -> Result<Adjustment> {
    let (_, d) = read_versioned_descriptor(r)?;
    let w = |k: &[u8]| d.i32(k).unwrap_or(0);
    Ok(Adjustment::BlackWhite {
        weights: [
            w(b"Rd  "),
            w(b"Yllw"),
            w(b"Grn "),
            w(b"Cyn "),
            w(b"Bl  "),
            w(b"Mgnt"),
        ],
        tint: d.bool(b"useTint").unwrap_or(false),
        tint_rgb: d
            .descriptor(b"tintColor")
            .and_then(rgb_of)
            .unwrap_or(BLACK_WHITE_DEFAULT_TINT),
    })
}

/// `phfl`: version 2 (a colour space and four words) or 3 (XYZ), the
/// density, Preserve Luminosity.
fn parse_photo_filter(r: &mut ByteReader) -> Result<Adjustment> {
    let version = r.u16()?;
    let color = match version {
        3 => FilterColor::Xyz([r.u32()?, r.u32()?, r.u32()?]),
        2 => {
            let space = r.u16()?;
            let c = [r.u16()?, r.u16()?, r.u16()?, r.u16()?];
            match space {
                0 => FilterColor::Rgb([c[0], c[1], c[2]]),
                7 => FilterColor::Lab([
                    f64::from(c[0]) / 100.0,
                    f64::from(c[1] as i16) / 100.0,
                    f64::from(c[2] as i16) / 100.0,
                ]),
                other => {
                    return Err(PsdError::Unsupported(format!(
                        "a Photo Filter colour in colour space {other} (RGB and Lab are read)"
                    )))
                }
            }
        }
        other => {
            return Err(PsdError::Unsupported(format!(
                "a Photo Filter block of version {other}"
            )))
        }
    };
    Ok(Adjustment::PhotoFilter {
        color,
        density: r.u32()?,
        preserve_luminosity: r.u8()? != 0,
    })
}

/// `mixr`: version, monochrome, then output records of five words (red,
/// green, blue, a fourth source, the constant).
fn parse_channel_mixer(r: &mut ByteReader) -> Result<Adjustment> {
    let _version = r.u16()?;
    let monochrome = r.u16()? != 0;
    let mut rows = [[0i16; 4]; 3];
    for row in &mut rows {
        if r.remaining() < 10 {
            break;
        }
        let w = [r.i16()?, r.i16()?, r.i16()?, r.i16()?, r.i16()?];
        *row = [w[0], w[1], w[2], w[4]];
    }
    if monochrome {
        rows[1] = [0; 4];
        rows[2] = [0; 4];
    }
    Ok(Adjustment::ChannelMixer { rows, monochrome })
}

/// `grdm`: version (1, or 3 with an interpolation method key), Reverse,
/// Dither, the name, the colour stops (location, midpoint, colour space,
/// four words, a pad word), the transparency stops (location, midpoint,
/// opacity), then the noise fields kept as they are.
fn parse_gradient_map(r: &mut ByteReader) -> Result<Adjustment> {
    let version = r.u16()?;
    let reverse = r.u8()? != 0;
    let dither = r.u8()? != 0;
    let method = if version >= 3 { r.fourcc()? } else { *b"Gcls" };
    let name = crate::descriptor::read_unicode_string(r)?;
    let n = r.u16()? as usize;
    let mut stops = Vec::with_capacity(n.min(256));
    for _ in 0..n {
        let location = r.u32()?;
        let midpoint = r.u32()?;
        let space = r.u16()?;
        let c = [r.u16()?, r.u16()?, r.u16()?, r.u16()?];
        let _pad = r.u16()?;
        if space != 0 {
            return Err(PsdError::Unsupported(format!(
                "a Gradient Map stop in colour space {space} (RGB is read)"
            )));
        }
        stops.push(GradientMapStop {
            location,
            midpoint,
            rgb16: [c[0], c[1], c[2]],
        });
    }
    let n = r.u16()? as usize;
    let mut opacity = Vec::with_capacity(n.min(256));
    for _ in 0..n {
        opacity.push(GradientMapOpacity {
            location: r.u32()?,
            midpoint: r.u32()?,
            opacity: r.u16()?,
        });
    }
    let tail = r.take(r.remaining())?.to_vec();
    Ok(Adjustment::GradientMap {
        name,
        stops,
        opacity,
        reverse,
        dither,
        method,
        tail,
    })
}

/// `selc`: version, method (0 relative, 1 absolute), then ten records of
/// four words — the first reserved, then reds … blacks.
fn parse_selective_color(r: &mut ByteReader) -> Result<Adjustment> {
    let _version = r.u16()?;
    let absolute = r.u16()? != 0;
    let _reserved = r.take(8)?;
    let mut ranges = [[0i16; 4]; 9];
    for range in &mut ranges {
        *range = [r.i16()?, r.i16()?, r.i16()?, r.i16()?];
    }
    Ok(Adjustment::SelectiveColor { ranges, absolute })
}

fn malformed(detail: String) -> PsdError {
    PsdError::Malformed {
        section: "adjustment layer",
        detail,
    }
}

/// `curv`: a pad byte, a version word, a 32-bit map of the curves
/// present (bit 0 the composite, then the channels in order), then per
/// curve its point count and points as (OUTPUT, INPUT) pairs [PUB, OBS:
/// output first]. An optional `Crv ` extension repeats the curves keyed
/// by channel index; the legacy section is complete for RGB, so it is
/// what is read.
fn parse_curves(r: &mut ByteReader) -> Result<Adjustment> {
    let _pad = r.u8()?;
    let _version = r.u16()?;
    let map = r.u32()?;
    let mut curves: [Option<Vec<(u8, u8)>>; 4] = Default::default();
    for bit in 0..32u32 {
        if map & (1 << bit) == 0 {
            continue;
        }
        let n = r.u16()? as usize;
        if n.saturating_mul(4) > r.remaining() {
            return Err(malformed(format!(
                "curve claims {n} points, more than the {} byte(s) left",
                r.remaining()
            )));
        }
        let mut pts = Vec::with_capacity(n);
        for _ in 0..n {
            let out = r.u16()?;
            let inp = r.u16()?;
            pts.push((inp.min(255) as u8, out.min(255) as u8));
        }
        if bit >= 4 {
            return Err(PsdError::Unsupported(format!(
                "a Curves adjustment on channel {bit} (composite and RGB only)"
            )));
        }
        curves[bit as usize] = Some(pts);
    }
    Ok(Adjustment::Curves { curves })
}

/// `levl`: a version word, then 29 records of five words (the composite,
/// then the channels); an optional `Lvls` extension (version 3, a total
/// record count) carries the records past 29.
fn parse_levels(r: &mut ByteReader) -> Result<Adjustment> {
    let _version = r.u16()?;
    let read = |r: &mut ByteReader| -> Result<LevelsRecord> {
        Ok(LevelsRecord {
            in_black: r.u16()?,
            in_white: r.u16()?,
            out_black: r.u16()?,
            out_white: r.u16()?,
            gamma_x100: r.u16()?,
        })
    };
    let mut records = [LevelsRecord::IDENTITY; 4];
    let mut extra_records = false;
    for slot in &mut records {
        *slot = read(r)?;
    }
    for _ in 4..29 {
        if !read(r)?.is_identity() {
            extra_records = true;
        }
    }
    if r.remaining() >= 8 && r.fourcc()? == *b"Lvls" {
        let _version = r.u16()?;
        let total = r.u16()? as usize;
        for _ in 0..total.saturating_sub(29) {
            if r.remaining() < 10 {
                break;
            }
            if !read(r)?.is_identity() {
                extra_records = true;
            }
        }
    }
    Ok(Adjustment::Levels {
        records,
        extra_records,
    })
}

/// `hue2`: version, colorize flag, pad, the colorize triple, the master
/// triple, then six ranges of four bounds and a triple.
fn parse_hue_saturation(r: &mut ByteReader) -> Result<Adjustment> {
    let _version = r.u16()?;
    let colorized = r.u8()? != 0;
    let _pad = r.u8()?;
    let triple = |r: &mut ByteReader| -> Result<[i16; 3]> { Ok([r.i16()?, r.i16()?, r.i16()?]) };
    let colorize = triple(r)?;
    let master = triple(r)?;
    let mut ranges = [[0i16; 3]; 6];
    let mut bounds = [[0i16; 4]; 6];
    for k in 0..6 {
        bounds[k] = [r.i16()?, r.i16()?, r.i16()?, r.i16()?];
        ranges[k] = triple(r)?;
    }
    Ok(Adjustment::HueSaturation {
        colorized,
        colorize,
        master,
        ranges,
        bounds,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn be(words: &[u16]) -> Vec<u8> {
        words.iter().flat_map(|w| w.to_be_bytes()).collect()
    }

    #[test]
    fn image_psd_adjustment_curves_points_are_output_then_input() {
        // pad, version 1, map = composite + blue, then two curves.
        let mut b = vec![0u8];
        b.extend(be(&[1]));
        b.extend(0b1001u32.to_be_bytes());
        b.extend(be(&[2, 0, 0, 255, 255]));
        b.extend(be(&[2, 30, 0, 220, 255]));
        let Some(Adjustment::Curves { curves }) = Adjustment::parse(b"curv", &b).unwrap() else {
            panic!()
        };
        assert_eq!(curves[0].as_deref(), Some(&[(0, 0), (255, 255)][..]));
        assert_eq!(curves[1], None);
        assert_eq!(curves[3].as_deref(), Some(&[(0, 30), (255, 220)][..]));
    }

    #[test]
    fn image_psd_adjustment_levels_reads_composite_then_channels() {
        let mut words = vec![2];
        words.extend([10, 240, 0, 255, 120]);
        words.extend([0, 200, 0, 255, 80]);
        for _ in 2..29 {
            words.extend([0, 255, 0, 255, 100]);
        }
        let Some(adj) = Adjustment::parse(b"levl", &be(&words)).unwrap() else {
            panic!()
        };
        let Adjustment::Levels {
            records,
            extra_records,
        } = &adj
        else {
            panic!()
        };
        assert_eq!(records[0].gamma_x100, 120);
        assert_eq!(records[1].in_white, 200);
        assert!(records[2].is_identity());
        assert!(!extra_records);
        assert_eq!(adj.unmodelled(), None);
    }

    #[test]
    fn image_psd_adjustment_unmodelled_parts_are_named() {
        let exposure = Adjustment::Exposure {
            exposure: 0.4,
            offset: -0.03,
            gamma: 1.2,
        };
        assert_eq!(
            exposure.unmodelled(),
            None,
            "an offset and gamma are a table"
        );
        let mut bounds = HUE_RANGE_DEFAULTS;
        bounds[0][0] = 300;
        let moved = Adjustment::HueSaturation {
            colorized: false,
            colorize: [0, 25, 0],
            master: [0; 3],
            ranges: [[0; 3]; 6],
            bounds,
        };
        assert!(moved.unmodelled().unwrap().contains("ranges"));
    }

    /// Every kind's blocks read back to the same value (`from_blocks` over
    /// `to_blocks`), the modern Brightness/Contrast through its `CgEd`.
    #[test]
    fn image_psd_adjustment_every_written_kind_reads_back() {
        let kinds = vec![
            Adjustment::Curves {
                curves: [
                    Some(vec![(0, 0), (128, 150), (255, 255)]),
                    None,
                    Some(vec![(0, 20), (255, 230)]),
                    None,
                ],
            },
            Adjustment::Levels {
                records: [
                    LevelsRecord {
                        in_black: 10,
                        in_white: 240,
                        out_black: 5,
                        out_white: 250,
                        gamma_x100: 120,
                    },
                    LevelsRecord::IDENTITY,
                    LevelsRecord::IDENTITY,
                    LevelsRecord::IDENTITY,
                ],
                extra_records: false,
            },
            Adjustment::Exposure {
                exposure: 0.5,
                offset: -0.02,
                gamma: 1.1,
            },
            Adjustment::Invert,
            Adjustment::HueSaturation {
                colorized: false,
                colorize: [0, 25, 0],
                master: [10, -20, 5],
                ranges: [[0, 0, 0], [3, 4, 5], [0; 3], [0; 3], [0; 3], [0; 3]],
                bounds: HUE_RANGE_DEFAULTS,
            },
            Adjustment::BrightnessContrast {
                brightness: 30,
                contrast: -40,
                mean: 127,
                lab: false,
                legacy: false,
                auto: false,
            },
            Adjustment::ColorBalance {
                shadows: [10, -20, 30],
                midtones: [-15, 25, 0],
                highlights: [5, 0, -40],
                preserve_luminosity: true,
            },
            Adjustment::Vibrance {
                vibrance: 40,
                saturation: -20,
            },
            Adjustment::BlackWhite {
                weights: [40, 60, 40, 60, 20, 80],
                tint: false,
                tint_rgb: BLACK_WHITE_DEFAULT_TINT,
            },
            Adjustment::PhotoFilter {
                color: FilterColor::Lab([67.19, 33.14, 72.79]),
                density: 50,
                preserve_luminosity: true,
            },
            Adjustment::ChannelMixer {
                rows: [[80, 20, 0, 0], [10, 70, 20, 5], [0, -10, 110, -5]],
                monochrome: false,
            },
            Adjustment::Posterize { levels: 5 },
            Adjustment::Threshold { level: 140 },
            Adjustment::gradient_map(
                vec![
                    GradientMapStop {
                        location: 0,
                        midpoint: 50,
                        rgb16: [0, 0, 0],
                    },
                    GradientMapStop {
                        location: 4096,
                        midpoint: 50,
                        rgb16: [65535, 0, 32896],
                    },
                ],
                true,
            ),
            Adjustment::SelectiveColor {
                ranges: [
                    [10, -20, 30, 0],
                    [0; 4],
                    [0; 4],
                    [0; 4],
                    [0; 4],
                    [0; 4],
                    [0; 4],
                    [-5, 0, 15, 10],
                    [0, 0, 0, 20],
                ],
                absolute: true,
            },
        ];
        for adj in kinds {
            let blocks = adj.to_blocks();
            let back = Adjustment::from_blocks(blocks.iter().map(|(k, v)| (k, v.as_slice())))
                .unwrap()
                .unwrap();
            let back = match (back, &adj) {
                // The tail is filled in on write and kept on read.
                (Adjustment::GradientMap { tail, .. }, Adjustment::GradientMap { .. }) => {
                    assert_eq!(tail, GRADIENT_MAP_TAIL);
                    Adjustment::from_blocks(blocks.iter().map(|(k, v)| (k, v.as_slice())))
                        .unwrap()
                        .map(|a| match a {
                            Adjustment::GradientMap {
                                name,
                                stops,
                                opacity,
                                reverse,
                                dither,
                                method,
                                ..
                            } => Adjustment::GradientMap {
                                name,
                                stops,
                                opacity,
                                reverse,
                                dither,
                                method,
                                tail: Vec::new(),
                            },
                            other => other,
                        })
                        .unwrap()
                }
                (b, _) => b,
            };
            assert_eq!(
                back,
                adj,
                "{:?}",
                blocks.iter().map(|b| b.0).collect::<Vec<_>>()
            );
            assert_eq!(adj.unmodelled(), None, "{adj:?}");
        }
    }
}
