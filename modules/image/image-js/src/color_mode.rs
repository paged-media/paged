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

//! The document's COLOUR MODE (Image ▸ Mode, image ADR 479): Grayscale,
//! RGB Color, CMYK Color or Lab Color.
//!
//! The layer stack keeps working in RGB (every kernel, the fold and the
//! tools speak RGBA); a mode is the set of colours the document may hold.
//! Converting to a mode puts every layer's pixels through the mode's
//! space and back — sRGB → Gray Gamma 2.2, → the CMYK profile, or → CIE
//! Lab (D50), each stored at the document's depth, then → sRGB — so the
//! pixels are exactly the colours a document of that mode can store, and
//! a pixel edit lands projected the same way inside its damage. The
//! conversions are `paged_color::cms` transforms (the engine's one CMS;
//! lcms2 on native, moxcms on wasm32) with the Color Settings default
//! rendering, relative colorimetric with black-point compensation.
//!
//! The stored channels are the planes' (image ADRs 481, 484): a CMYK,
//! Grayscale or Lab document folds in its own numbers. The single-image
//! modes (image ADR 484) are a mode and a table: INDEXED holds the colours
//! of its table (each pixel the nearest entry), MULTICHANNEL its spot
//! channels (from RGB, one ink a channel, which changes no colour), and a
//! DUOTONE read from a file is its grey with the file's specification
//! kept for the save.

use std::sync::Arc;

use image_core::{Region, SampleDepth};
use paged_color::cms::{Backend, Layout, ProfileRef, Rendering, Space, Transform};

use crate::ingest::IngestError;
use crate::pixels::Pixels;

/// The gamma of the built-in grey space ("Gray Gamma 2.2").
pub const GRAY_GAMMA: f32 = 2.2;

/// A document colour mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum ColorMode {
    #[default]
    Rgb,
    Gray,
    Cmyk,
    Lab,
    Indexed,
    Multichannel,
    Duotone,
}

impl ColorMode {
    /// The wire name (`rgb`, `gray`, `cmyk`, `lab`).
    pub fn name(self) -> &'static str {
        match self {
            ColorMode::Rgb => "rgb",
            ColorMode::Gray => "gray",
            ColorMode::Cmyk => "cmyk",
            ColorMode::Lab => "lab",
            ColorMode::Indexed => "indexed",
            ColorMode::Multichannel => "multichannel",
            ColorMode::Duotone => "duotone",
        }
    }

    pub fn from_name(s: &str) -> Option<ColorMode> {
        Some(match s {
            "rgb" => ColorMode::Rgb,
            "gray" | "grey" | "grayscale" => ColorMode::Gray,
            "cmyk" => ColorMode::Cmyk,
            "lab" => ColorMode::Lab,
            "indexed" => ColorMode::Indexed,
            "multichannel" => ColorMode::Multichannel,
            "duotone" => ColorMode::Duotone,
            _ => return None,
        })
    }

    /// Photoshop's menu label, the undo step's name.
    pub fn label(self) -> &'static str {
        match self {
            ColorMode::Rgb => "RGB Color",
            ColorMode::Gray => "Grayscale",
            ColorMode::Cmyk => "CMYK Color",
            ColorMode::Lab => "Lab Color",
            ColorMode::Indexed => "Indexed Color",
            ColorMode::Multichannel => "Multichannel",
            ColorMode::Duotone => "Duotone",
        }
    }

    /// The persisted code.
    pub fn code(self) -> u8 {
        match self {
            ColorMode::Rgb => 0,
            ColorMode::Gray => 1,
            ColorMode::Cmyk => 2,
            ColorMode::Lab => 3,
            ColorMode::Indexed => 4,
            ColorMode::Multichannel => 5,
            ColorMode::Duotone => 6,
        }
    }

    pub fn from_code(c: u8) -> Option<ColorMode> {
        Some(match c {
            0 => ColorMode::Rgb,
            1 => ColorMode::Gray,
            2 => ColorMode::Cmyk,
            3 => ColorMode::Lab,
            4 => ColorMode::Indexed,
            5 => ColorMode::Multichannel,
            6 => ColorMode::Duotone,
            _ => return None,
        })
    }
}

/// The document's mode and the profile its CMYK uses (none: the plain ink
/// formula, whose round trip changes nothing — said, not hidden).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct DocMode {
    pub mode: ColorMode,
    pub cmyk_profile: Option<Arc<[u8]>>,
    /// An Indexed document's colours, a Multichannel document's channels,
    /// a Duotone document's specification (image ADR 484).
    pub table: Option<Arc<ModeTable>>,
}

/// What a single-image mode holds beside its pixels.
#[derive(Debug, Clone, PartialEq)]
pub enum ModeTable {
    /// The colour table (at most 256 sRGB colours) and the transparent
    /// index, when there is one.
    Palette {
        colours: Vec<[u8; 3]>,
        transparent: Option<u8>,
    },
    /// The spot channels in order: name and display colour (sRGB).
    Spots(Vec<SpotChannel>),
    /// A Duotone file's Color Mode Data, kept byte for byte (its format is
    /// undocumented; the file format tells a reader to treat the image as
    /// grey and keep it).
    Duotone(Vec<u8>),
}

/// One Multichannel channel.
#[derive(Debug, Clone, PartialEq)]
pub struct SpotChannel {
    pub name: String,
    pub ink: [u8; 3],
}

impl ModeTable {
    pub fn palette(&self) -> Option<&[[u8; 3]]> {
        match self {
            ModeTable::Palette { colours, .. } => Some(colours),
            _ => None,
        }
    }

    pub fn spots(&self) -> Option<&[SpotChannel]> {
        match self {
            ModeTable::Spots(s) => Some(s),
            _ => None,
        }
    }
}

/// The Web palette: the 216 colours whose channels are multiples of 51,
/// red slowest (Photoshop's table order).
pub fn web_palette() -> Vec<[u8; 3]> {
    let v = [0u8, 51, 102, 153, 204, 255];
    let mut out = Vec::with_capacity(216);
    for &r in &v {
        for &g in &v {
            for &b in &v {
                out.push([r, g, b]);
            }
        }
    }
    out
}

/// Every distinct colour of `rgba` (opaque or not) when there are at most
/// 256 of them — Photoshop's Exact palette — in first-seen order.
pub fn exact_palette(rgba: &[u8]) -> Option<Vec<[u8; 3]>> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for p in rgba.as_chunks::<4>().0 {
        let c = [p[0], p[1], p[2]];
        if seen.insert(c) {
            out.push(c);
            if out.len() > 256 {
                return None;
            }
        }
    }
    Some(out)
}

/// An adaptive palette of at most `n` colours (median cut over the
/// opaque pixels: the box with the widest channel range is split at its
/// median until there are `n`; each box answers its mean).
pub fn adaptive_palette(rgba: &[u8], n: usize) -> Vec<[u8; 3]> {
    let mut px: Vec<[u8; 3]> = rgba
        .as_chunks::<4>()
        .0
        .iter()
        .filter(|p| p[3] > 0)
        .map(|p| [p[0], p[1], p[2]])
        .collect();
    if px.is_empty() {
        return vec![[0, 0, 0]];
    }
    let n = n.clamp(2, 256);
    let range = |b: &[[u8; 3]]| -> (usize, u8) {
        (0..3)
            .map(|c| {
                let (lo, hi) = b
                    .iter()
                    .fold((255u8, 0u8), |(lo, hi), p| (lo.min(p[c]), hi.max(p[c])));
                (c, hi - lo)
            })
            .max_by_key(|&(_, r)| r)
            .unwrap_or((0, 0))
    };
    let mut boxes: Vec<std::ops::Range<usize>> = Vec::with_capacity(n);
    boxes.push(0..px.len());
    while boxes.len() < n {
        let Some((i, c)) = boxes
            .iter()
            .enumerate()
            .filter(|(_, b)| b.len() > 1)
            .map(|(i, b)| (i, range(&px[b.clone()])))
            .filter(|(_, (_, r))| *r > 0)
            .max_by_key(|(_, (_, r))| *r)
            .map(|(i, (c, _))| (i, c))
        else {
            break;
        };
        let b = boxes.swap_remove(i);
        px[b.clone()].sort_unstable_by_key(|p| p[c]);
        let mid = b.start + b.len() / 2;
        boxes.push(b.start..mid);
        boxes.push(mid..b.end);
    }
    boxes
        .iter()
        .map(|b| {
            let mut sum = [0u64; 3];
            for p in &px[b.clone()] {
                for c in 0..3 {
                    sum[c] += u64::from(p[c]);
                }
            }
            let k = b.len().max(1) as u64;
            sum.map(|v| ((v + k / 2) / k) as u8)
        })
        .collect()
}

/// The entry of `palette` nearest `rgb` (squared distance in sRGB levels;
/// the first of equals).
pub fn nearest_index(palette: &[[u8; 3]], rgb: [u8; 3]) -> usize {
    let mut best = (u32::MAX, 0);
    for (i, p) in palette.iter().enumerate() {
        let d: u32 = (0..3)
            .map(|c| {
                let x = i32::from(p[c]) - i32::from(rgb[c]);
                (x * x) as u32
            })
            .sum();
        if d < best.0 {
            best = (d, i);
        }
    }
    best.1
}

impl DocMode {
    pub fn rgb() -> DocMode {
        DocMode::default()
    }

    /// The mode of a PSD document (`None` for RGB and for the modes the
    /// stack has no projection for); a CMYK document's profile is its own.
    pub fn of_psd(file: &image_psd::model::PsdFile) -> Option<DocMode> {
        use image_psd::model::ColorMode as P;
        let mode = match file.header.color_mode {
            P::Grayscale => ColorMode::Gray,
            P::Cmyk => ColorMode::Cmyk,
            P::Lab => ColorMode::Lab,
            P::Indexed => ColorMode::Indexed,
            P::Multichannel => ColorMode::Multichannel,
            P::Duotone => ColorMode::Duotone,
            _ => return None,
        };
        let table = match mode {
            ColorMode::Indexed => file.indexed_palette().map(|p| {
                let used = p.count.unwrap_or(256).clamp(1, 256);
                ModeTable::Palette {
                    colours: p.colours[..used].to_vec(),
                    transparent: p.transparent.and_then(|t| u8::try_from(t).ok()),
                }
            }),
            ColorMode::Multichannel => {
                let names = spot_names(file);
                let inks = spot_inks(file);
                let k = file.header.channels as usize;
                Some(ModeTable::Spots(
                    (0..k)
                        .map(|i| SpotChannel {
                            name: names
                                .get(i)
                                .cloned()
                                .unwrap_or_else(|| format!("Channel {}", i + 1)),
                            ink: inks
                                .get(i)
                                .map_or([0, 0, 0], |c| c.map(|v| (v * 255.0).round() as u8)),
                        })
                        .collect(),
                ))
            }
            ColorMode::Duotone => Some(ModeTable::Duotone(file.color_mode.raw.clone())),
            _ => None,
        };
        Some(DocMode {
            mode,
            cmyk_profile: (mode == ColorMode::Cmyk)
                .then(|| file.resources.icc_profile().map(Arc::from))
                .flatten(),
            table: table.map(Arc::new),
        })
    }

    /// An Indexed document of `colours` (image ADR 484).
    pub fn indexed(colours: Vec<[u8; 3]>) -> DocMode {
        DocMode {
            mode: ColorMode::Indexed,
            cmyk_profile: None,
            table: Some(Arc::new(ModeTable::Palette {
                colours,
                transparent: None,
            })),
        }
    }

    /// A Multichannel document made from RGB (Cyan, Magenta and Yellow
    /// inks, one a channel) or from grey (one Black ink): the channels
    /// Photoshop makes ([OBS] `color-modes/multichannel-8`).
    pub fn multichannel_from(from: ColorMode) -> Option<DocMode> {
        let spot = |name: &str, ink: [u8; 3]| SpotChannel {
            name: name.into(),
            ink,
        };
        let spots = match from {
            ColorMode::Rgb => vec![
                spot("Cyan", [0, 255, 255]),
                spot("Magenta", [255, 0, 255]),
                spot("Yellow", [255, 255, 0]),
            ],
            ColorMode::Gray => vec![spot("Black", [0, 0, 0])],
            _ => return None,
        };
        Some(DocMode {
            mode: ColorMode::Multichannel,
            cmyk_profile: None,
            table: Some(Arc::new(ModeTable::Spots(spots))),
        })
    }

    /// Whether pixels are projected at all (RGB, and CMYK without a
    /// profile, hold every sRGB colour).
    pub fn projects(&self) -> bool {
        match self.mode {
            ColorMode::Rgb => false,
            ColorMode::Cmyk => self.cmyk_profile.is_some(),
            ColorMode::Gray | ColorMode::Lab | ColorMode::Duotone => true,
            ColorMode::Indexed => self.table.as_ref().is_some_and(|t| t.palette().is_some()),
            // From RGB or grey, its inks reproduce every colour they held.
            ColorMode::Multichannel => false,
        }
    }
}

fn cms_err(e: paged_color::cms::CmsError) -> IngestError {
    IngestError::Unsupported(format!("colour mode: {e}"))
}

/// sRGB → the mode's space → sRGB, compiled once for one conversion.
pub struct ModeTransform {
    to: Transform,
    back: Transform,
    space: Space,
    /// Indexed: the colours a pixel may take (the nearest is taken).
    palette: Option<Vec<[u8; 3]>>,
}

impl ModeTransform {
    /// `None` when the mode holds every sRGB colour ([`DocMode::projects`]).
    pub fn new(mode: &DocMode) -> Result<Option<ModeTransform>, IngestError> {
        if !mode.projects() {
            return Ok(None);
        }
        let backend = Backend::preferred();
        let rendering = Rendering::default();
        let (profile, space) = match mode.mode {
            ColorMode::Gray | ColorMode::Duotone => (ProfileRef::Gray(GRAY_GAMMA), Space::Gray),
            ColorMode::Lab => (ProfileRef::Lab, Space::Lab),
            // The table is sRGB; the transform is the identity.
            ColorMode::Indexed => (ProfileRef::Srgb, Space::Rgb),
            ColorMode::Cmyk => (
                ProfileRef::Icc(mode.cmyk_profile.as_deref().expect("projects() checked")),
                Space::Cmyk,
            ),
            ColorMode::Rgb | ColorMode::Multichannel => {
                unreachable!("projects() is false for RGB and Multichannel")
            }
        };
        let dev = Layout::new(space, false);
        let to = Transform::new(
            backend,
            ProfileRef::Srgb,
            Layout::RGB,
            profile,
            dev,
            rendering,
        )
        .map_err(cms_err)?;
        let back = Transform::new(
            backend,
            profile,
            dev,
            ProfileRef::Srgb,
            Layout::RGB,
            rendering,
        )
        .map_err(cms_err)?;
        let palette = (mode.mode == ColorMode::Indexed)
            .then(|| {
                mode.table
                    .as_ref()
                    .and_then(|t| t.palette())
                    .map(<[_]>::to_vec)
            })
            .flatten();
        Ok(Some(ModeTransform {
            to,
            back,
            space,
            palette,
        }))
    }

    /// Project straight RGB floats (0..=1, three per pixel) in place: to
    /// the mode's space, stored at `depth`, and back.
    pub fn project_rgb(&self, rgb: &mut [f32], depth: SampleDepth) {
        if let Some(p) = &self.palette {
            for c in rgb.as_chunks_mut::<3>().0 {
                let q = c.map(|v| (v.clamp(0.0, 1.0) * 255.0).round() as u8);
                let e = p[nearest_index(p, q)];
                *c = e.map(|v| f32::from(v) / 255.0);
            }
            return;
        }
        let n = rgb.len() / 3;
        let mut dev = vec![0f32; n * self.space.channels()];
        self.to.apply_f32(rgb, &mut dev);
        quantize(self.space, &mut dev, depth);
        self.back.apply_f32(&dev, rgb);
        for v in rgb.iter_mut() {
            *v = v.clamp(0.0, 1.0);
        }
    }

    /// The device values of straight RGB floats (the mode's own numbers:
    /// grey, inks 0..=1, or L*a*b*) — what a CMYK or Lab document stores.
    pub fn device_of(&self, rgb: &[f32]) -> Vec<f32> {
        let mut dev = vec![0f32; rgb.len() / 3 * self.space.channels()];
        self.to.apply_f32(rgb, &mut dev);
        dev
    }

    /// Straight RGB floats of the mode's device values — the transform
    /// back ([`device_of`](Self::device_of)'s inverse).
    pub fn rgb_of(&self, dev: &[f32]) -> Vec<f32> {
        let mut rgb = vec![0f32; dev.len() / self.space.channels() * 3];
        self.back.apply_f32(dev, &mut rgb);
        rgb
    }

    /// `px` with every pixel of `region` (the whole buffer when `None`;
    /// `width` is the buffer's row length in pixels) projected; alpha and
    /// everything outside the region are kept. Same depth in and out.
    pub fn project_pixels(&self, px: &Pixels, width: u32, region: Option<Region>) -> Pixels {
        let n = px.pixel_count();
        if n == 0 || width == 0 {
            return px.clone();
        }
        let height = (n / width as usize) as u32;
        let r = region
            .and_then(|r| r.intersect(Region::new(0, 0, width, height)))
            .unwrap_or(Region::new(0, 0, width, height));
        if r.w == 0 || r.h == 0 {
            return px.clone();
        }
        if px.is_float() {
            return self.project_float(px, width, r);
        }
        let sixteen = px.is_16bit();
        let full = if sixteen { 65535.0 } else { 255.0 };
        let mut out = px.clone();
        let bpp = px.bytes_per_pixel();
        let row_px = r.w as usize;
        let mut rgb = vec![0f32; row_px * 3];
        let src = px.clone();
        let dst = out.make_mut();
        for y in r.y as usize..(r.y as usize + r.h as usize) {
            let first = y * width as usize + r.x as usize;
            for i in 0..row_px {
                for c in 0..3 {
                    rgb[i * 3 + c] = f32::from(src.sample16(first + i, c)) / 65535.0;
                }
            }
            self.project_rgb(&mut rgb, src.depth());
            for i in 0..row_px {
                let at = (first + i) * bpp;
                for c in 0..3 {
                    let v = (rgb[i * 3 + c] * full).round();
                    if sixteen {
                        let b = (v as u16).to_ne_bytes();
                        dst[at + c * 2..at + c * 2 + 2].copy_from_slice(&b);
                    } else {
                        dst[at + c] = v as u8;
                    }
                }
            }
        }
        out
    }
}

impl ModeTransform {
    /// [`project_pixels`](Self::project_pixels) for 32-bit float (linear
    /// light, scene-referred): a Grayscale document's grey is the linear
    /// luminance (`Y` of sRGB's primaries adapted to D50, the white of
    /// the grey space), which keeps values above 1 — Gray Gamma 2.2 is the
    /// same `Y` encoded, so an 8-bit grey document and a 32-bit one agree.
    /// The other modes have no float document (refused before this).
    fn project_float(&self, px: &Pixels, width: u32, r: Region) -> Pixels {
        if self.space != Space::Gray {
            return px.clone();
        }
        let mut v = px.to_f32_linear();
        for y in r.y as usize..(r.y as usize + r.h as usize) {
            for x in r.x as usize..(r.x as usize + r.w as usize) {
                let i = (y * width as usize + x) * 4;
                let g = 0.222_5 * v[i] + 0.716_9 * v[i + 1] + 0.060_6 * v[i + 2];
                v[i] = g;
                v[i + 1] = g;
                v[i + 2] = g;
            }
        }
        Pixels::from_rgba32f(&v)
    }
}

/// A Grayscale, Duotone or Lab PSD's STORED colours to sRGB (image ADR
/// 483): the numbers [`image_psd::CompositeSamples`] and the layer import
/// hand over (normalised; Lab's L* over the full range, a* and b* about
/// the middle) through the file's own grey profile (else Gray Gamma 2.2;
/// a Duotone is read as its grey, which is what the file format tells a
/// reader without its inks to do) or CIE Lab (D50). One transform for the
/// merged composite and the layer plates, so the layered open and the
/// flattened one cannot drift apart.
pub struct StoredToSrgb {
    t: Transform,
    lab: bool,
    sixteen: bool,
}

impl StoredToSrgb {
    /// `None` for a mode whose stored colours need no CMS here (RGB,
    /// CMYK through its ink lane, Indexed, Multichannel, and a 32-bit
    /// document, whose grey is linear light).
    pub fn for_psd(file: &image_psd::model::PsdFile) -> Result<Option<StoredToSrgb>, IngestError> {
        use image_psd::model::ColorMode as P;
        let h = &file.header;
        if h.depth == 32 {
            return Ok(None);
        }
        let icc = file.resources.icc_profile();
        let (profile, space, lab) = match h.color_mode {
            P::Grayscale | P::Duotone => (
                match icc {
                    Some(p) if is_gray_icc(p) => ProfileRef::Icc(p),
                    _ => ProfileRef::Gray(GRAY_GAMMA),
                },
                Space::Gray,
                false,
            ),
            P::Lab => (ProfileRef::Lab, Space::Lab, true),
            _ => return Ok(None),
        };
        let t = Transform::new(
            Backend::preferred(),
            profile,
            Layout::new(space, false),
            ProfileRef::Srgb,
            Layout::RGB,
            Rendering::default(),
        )
        .map_err(cms_err)?;
        Ok(Some(StoredToSrgb {
            t,
            lab,
            sixteen: h.depth == 16,
        }))
    }

    /// Straight sRGB (three a pixel, 0..=1) of stored samples (one a pixel
    /// for grey, three for Lab, normalised).
    pub fn rgb_of(&self, stored: &[f32]) -> Vec<f32> {
        let dev: Vec<f32> = if self.lab {
            stored
                .as_chunks::<3>()
                .0
                .iter()
                .flat_map(|p| {
                    let ab = |v: f32| {
                        if self.sixteen {
                            (v * 65535.0 - 32768.0) / 256.0
                        } else {
                            v * 255.0 - 128.0
                        }
                    };
                    [p[0] * 100.0, ab(p[1]), ab(p[2])]
                })
                .collect()
        } else {
            stored.to_vec()
        };
        let k = if self.lab { 3 } else { 1 };
        let mut rgb = vec![0f32; dev.len() / k * 3];
        self.t.apply_f32(&dev, &mut rgb);
        for v in &mut rgb {
            *v = v.clamp(0.0, 1.0);
        }
        rgb
    }
}

/// The display colours of a document's spot channels (Multichannel's
/// channels, in order), sRGB 0..=1: resource 1077 (DisplayInfo: a u32
/// version, then 13 bytes a channel — u16 colour space, four u16
/// components, u16 opacity, u8 kind) or the older 1007 (the same without
/// the version, 14 bytes a channel). RGB as stored; CMYK stored inverted
/// (65535 = no ink) by the plain ink formula; grey (0–10000) as grey;
/// Lab (L* 0–10000, a* b* signed) through CIE Lab. [OBS: Photoshop
/// 27.10's own Multichannel document, `color-modes/multichannel-8`.]
pub fn spot_inks(file: &image_psd::model::PsdFile) -> Vec<[f32; 3]> {
    let (data, at, stride) = match (file.resources.data(1077), file.resources.data(1007)) {
        (Some(d), _) => (d, 4usize, 13usize),
        (None, Some(d)) => (d, 0, 14),
        _ => return Vec::new(),
    };
    let mut out = Vec::new();
    let mut o = at;
    while o + 10 <= data.len() {
        let u = |i: usize| u16::from_be_bytes([data[o + i], data[o + i + 1]]);
        let (space, a, b, c, d) = (u(0), u(2), u(4), u(6), u(8));
        let f = |v: u16| f32::from(v) / 65535.0;
        out.push(match space {
            0 => [f(a), f(b), f(c)],
            2 => paged_color::math::naive_cmyk_to_srgb(
                1.0 - f(a),
                1.0 - f(b),
                1.0 - f(c),
                1.0 - f(d),
            ),
            8 => [1.0 - f32::from(a) / 10000.0; 3],
            7 => {
                let l = f32::from(a) / 100.0;
                let (aa, bb) = (f32::from(b as i16) / 100.0, f32::from(c as i16) / 100.0);
                lab_to_srgb([l, aa, bb])
            }
            _ => [0.0; 3],
        });
        o += stride;
    }
    out
}

/// The names of a document's channels beyond its colour channels, or of
/// a Multichannel document's channels: resource 1045 (Unicode alpha
/// names: u32 length in UTF-16 units, then the units, the last a 0),
/// else 1006 (Pascal strings).
pub fn spot_names(file: &image_psd::model::PsdFile) -> Vec<String> {
    if let Some(d) = file.resources.data(1045) {
        let mut out = Vec::new();
        let mut o = 0;
        while o + 4 <= d.len() {
            let n = u32::from_be_bytes([d[o], d[o + 1], d[o + 2], d[o + 3]]) as usize;
            o += 4;
            let units: Vec<u16> = (0..n)
                .filter_map(|i| d.get(o + i * 2..o + i * 2 + 2))
                .map(|b| u16::from_be_bytes([b[0], b[1]]))
                .take_while(|&u| u != 0)
                .collect();
            out.push(String::from_utf16_lossy(&units));
            o += n * 2;
        }
        return out;
    }
    let Some(d) = file.resources.data(1006) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let mut o = 0;
    while o < d.len() {
        let n = usize::from(d[o]);
        out.push(String::from_utf8_lossy(d.get(o + 1..o + 1 + n).unwrap_or(&[])).into_owned());
        o += 1 + n;
    }
    out
}

/// One CIE Lab (D50) colour as sRGB 0..=1 through the CMS.
fn lab_to_srgb(lab: [f32; 3]) -> [f32; 3] {
    let Ok(t) = Transform::new(
        Backend::preferred(),
        ProfileRef::Lab,
        Layout::new(Space::Lab, false),
        ProfileRef::Srgb,
        Layout::RGB,
        Rendering::default(),
    ) else {
        return [0.0; 3];
    };
    let mut rgb = [0f32; 3];
    t.apply_f32(&lab, &mut rgb);
    rgb.map(|v| v.clamp(0.0, 1.0))
}

/// Is this ICC profile a grey one (data colour space `GRAY`, header bytes
/// 16..20)?
fn is_gray_icc(p: &[u8]) -> bool {
    p.get(16..20) == Some(b"GRAY")
}

/// View ▸ Proof Colors and Gamut Warning on the image preview: what the
/// frame shows when the composite is simulated on an output (a CMYK press
/// through its profile, or Gray Gamma 2.2) and the colours that output
/// cannot reproduce are marked. A display transform only.
pub struct Proof {
    soft: Option<paged_color::cms::SoftProof>,
    gamut: Option<paged_color::cms::GamutCheck>,
}

/// Photoshop's default gamut-warning colour: grey, fully opaque.
pub const GAMUT_WARNING_RGB: [u8; 3] = [128, 128, 128];

impl Proof {
    /// `target` is the output simulated (`Gray`, or `Cmyk` with
    /// `cmyk_profile`); `colors` turns the soft proof on, `gamut` the
    /// warning. Refused for a CMYK target without a profile (there is no
    /// press to simulate) and for RGB or Lab (nothing to simulate).
    pub fn new(
        target: ColorMode,
        cmyk_profile: Option<&[u8]>,
        colors: bool,
        gamut: bool,
    ) -> Result<Proof, IngestError> {
        let output = match (target, cmyk_profile) {
            (ColorMode::Gray, _) => ProfileRef::Gray(GRAY_GAMMA),
            (ColorMode::Cmyk, Some(p)) => ProfileRef::Icc(p),
            (ColorMode::Cmyk, None) => {
                return Err(IngestError::Unsupported(
                    "a CMYK proof needs a CMYK profile (choose one first)".into(),
                ))
            }
            (m, _) => {
                return Err(IngestError::Unsupported(format!(
                    "nothing to proof in {} (Grayscale or CMYK)",
                    m.label()
                )))
            }
        };
        let backend = Backend::preferred();
        let soft = colors
            .then(|| {
                paged_color::cms::SoftProof::new(
                    backend,
                    ProfileRef::Srgb,
                    Layout::RGBA,
                    output,
                    ProfileRef::Srgb,
                    Layout::RGBA,
                    paged_color::cms::ProofOptions::default(),
                )
            })
            .transpose()
            .map_err(cms_err)?;
        let gamut = gamut
            .then(|| {
                paged_color::cms::GamutCheck::new(
                    backend,
                    ProfileRef::Srgb,
                    Layout::RGBA,
                    output,
                    paged_color::cms::GamutCheck::DEFAULT_THRESHOLD,
                )
            })
            .transpose()
            .map_err(cms_err)?;
        Ok(Proof { soft, gamut })
    }

    /// Straight RGBA8 as the proof shows it: the gamut is checked on the
    /// document's colours, the warning painted over the proofed ones.
    pub fn apply_rgba8(&self, rgba: &[u8]) -> Vec<u8> {
        let mask = self.gamut.as_ref().map(|g| g.check_u8(rgba));
        let mut out = match &self.soft {
            Some(p) => {
                let mut o = vec![0u8; rgba.len()];
                p.apply_u8(rgba, &mut o);
                o
            }
            None => rgba.to_vec(),
        };
        if let Some(m) = mask {
            for (px, &bad) in out.as_chunks_mut::<4>().0.iter_mut().zip(&m.out_of_gamut) {
                if bad && px[3] > 0 {
                    px[..3].copy_from_slice(&GAMUT_WARNING_RGB);
                }
            }
        }
        out
    }
}

/// Device samples as a document of `depth` stores them: grey and inks in
/// 255 or 65535 steps; Lab as Photoshop's 8-bit encoding (L* × 255/100,
/// a* and b* in whole units) or its 16-bit one (256 steps per unit).
fn quantize(space: Space, dev: &mut [f32], depth: SampleDepth) {
    let deep = depth != SampleDepth::U8;
    match space {
        Space::Lab => {
            for p in dev.as_chunks_mut::<3>().0 {
                let (ls, abs) = if deep {
                    (65535.0 / 100.0, 256.0)
                } else {
                    (255.0 / 100.0, 1.0)
                };
                p[0] = (p[0] * ls).round().clamp(0.0, 100.0 * ls) / ls;
                p[1] = (p[1] * abs).round().clamp(-128.0 * abs, 127.0 * abs) / abs;
                p[2] = (p[2] * abs).round().clamp(-128.0 * abs, 127.0 * abs) / abs;
            }
        }
        _ => {
            let steps = if deep { 65535.0 } else { 255.0 };
            for v in dev.iter_mut() {
                *v = (v.clamp(0.0, 1.0) * steps).round() / steps;
            }
        }
    }
}

#[cfg(test)]
#[allow(non_snake_case)]
mod tests {
    use super::*;

    fn rgb8(px: &[[u8; 3]]) -> Pixels {
        Pixels::from_rgba8(Arc::from(
            px.iter()
                .flat_map(|p| [p[0], p[1], p[2], 200])
                .collect::<Vec<u8>>(),
        ))
    }

    #[test]
    fn rgb_and_a_profileless_cmyk_project_nothing__feat__image_io_depth_color_modes() {
        assert!(ModeTransform::new(&DocMode::rgb()).unwrap().is_none());
        let naive = DocMode {
            mode: ColorMode::Cmyk,
            cmyk_profile: None,
            table: None,
        };
        assert!(ModeTransform::new(&naive).unwrap().is_none());
    }

    #[test]
    fn grayscale_makes_every_pixel_neutral_and_keeps_alpha__feat__image_io_depth_color_modes() {
        let t = ModeTransform::new(&DocMode {
            mode: ColorMode::Gray,
            cmyk_profile: None,
            table: None,
        })
        .unwrap()
        .expect("gray projects");
        let px = rgb8(&[
            [255, 0, 0],
            [0, 255, 0],
            [0, 0, 255],
            [255, 255, 255],
            [0, 0, 0],
        ]);
        let out = t.project_pixels(&px, 5, None);
        let b = out.raw();
        for p in b.as_chunks::<4>().0 {
            assert!(
                p[0].abs_diff(p[1]) <= 1 && p[1].abs_diff(p[2]) <= 1,
                "{p:?} is not neutral"
            );
            assert_eq!(p[3], 200, "alpha is untouched");
        }
        // White and black stay white and black (relative colorimetric + BPC).
        assert!(b[12] >= 254 && b[16] <= 1, "{:?}", &b[12..20]);
        // Green is the lightest primary, blue the darkest.
        assert!(b[4] > b[0] && b[0] > b[8], "{:?}", &b[..12]);
    }

    #[test]
    fn lab_keeps_srgb_within_its_encoding__feat__image_io_depth_color_modes() {
        let t = ModeTransform::new(&DocMode {
            mode: ColorMode::Lab,
            cmyk_profile: None,
            table: None,
        })
        .unwrap()
        .expect("lab projects");
        let src: Vec<[u8; 3]> = (0..=255u8)
            .step_by(15)
            .map(|v| [v, 255 - v, v / 2])
            .collect();
        let px = rgb8(&src);
        let out = t.project_pixels(&px, src.len() as u32, None);
        // 8-bit Lab is a coarser grid than 8-bit sRGB in places, so a
        // channel can move several levels (as in Photoshop's own RGB → Lab
        // → RGB); the colour moves by less than the encoding's step.
        let lab = |p: &[u8]| {
            paged_color::lab::srgb_to_lab_d50([p[0], p[1], p[2]].map(|v| f32::from(v) / 255.0))
        };
        let worst = out
            .raw()
            .as_chunks::<4>()
            .0
            .iter()
            .zip(px.raw().as_chunks::<4>().0)
            .map(|(a, b)| paged_color::cms::delta_e76(lab(a), lab(b)))
            .fold(0f32, f32::max);
        assert!(
            worst <= 1.5,
            "an 8-bit Lab round trip moved a colour by {worst} dE"
        );
        // At 16 bits the round trip keeps the colour.
        let deep = t.project_pixels(&px.at_depth(SampleDepth::U16), src.len() as u32, None);
        let back = deep.at_depth(SampleDepth::U8);
        let moved = back
            .raw()
            .iter()
            .zip(px.raw())
            .map(|(a, b)| a.abs_diff(*b))
            .max()
            .unwrap();
        assert!(
            moved <= 1,
            "a 16-bit Lab round trip moved a channel by {moved}"
        );
    }

    #[test]
    fn a_region_projects_only_its_pixels__feat__image_io_depth_color_modes() {
        let t = ModeTransform::new(&DocMode {
            mode: ColorMode::Gray,
            cmyk_profile: None,
            table: None,
        })
        .unwrap()
        .unwrap();
        let px = rgb8(&[[255, 0, 0], [255, 0, 0], [255, 0, 0], [255, 0, 0]]);
        let out = t.project_pixels(&px, 2, Some(Region::new(1, 1, 1, 1)));
        assert_eq!(
            &out.raw()[..12],
            &px.raw()[..12],
            "outside the region: untouched"
        );
        let p = &out.raw()[12..16];
        assert!(p[0] == p[1] && p[1] == p[2], "inside: grey {p:?}");
    }

    #[test]
    fn a_16bit_projection_stays_16bit__feat__image_io_depth_color_modes() {
        let t = ModeTransform::new(&DocMode {
            mode: ColorMode::Gray,
            cmyk_profile: None,
            table: None,
        })
        .unwrap()
        .unwrap();
        let ramp: Vec<u16> = (0..1024u32)
            .flat_map(|i| {
                let v = (i * 64) as u16;
                [v, v, v, u16::MAX]
            })
            .collect();
        let px = Pixels::from_rgba16(&ramp);
        let out = t.project_pixels(&px, 1024, None);
        assert!(out.is_16bit());
        let levels: std::collections::HashSet<u16> =
            (0..1024).map(|i| out.sample16(i, 0)).collect();
        assert!(
            levels.len() > 900,
            "{} levels survived a 16-bit grey projection",
            levels.len()
        );
    }

    #[test]
    fn a_cmyk_profile_clips_what_ink_cannot_print__feat__image_io_depth_color_modes() {
        // The engine's corpus/profiles (paged-color's crate dir is two
        // levels below it).
        let engine = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../engine/core/crates/paged-color"
        );
        let Some(profile) = paged_color::test_profiles::find_cmyk_profile(engine) else {
            eprintln!(
                "unavailable: {}",
                paged_color::test_profiles::NO_PROFILE_HINT
            );
            return;
        };
        let bytes = std::fs::read(profile.path()).expect("profile");
        let t = ModeTransform::new(&DocMode {
            mode: ColorMode::Cmyk,
            cmyk_profile: Some(Arc::from(bytes)),
            table: None,
        })
        .unwrap()
        .expect("cmyk projects");
        // Pure sRGB blue and green are outside every press gamut; a mid
        // grey is inside it.
        let px = rgb8(&[[0, 0, 255], [0, 255, 0], [128, 128, 128]]);
        let out = t.project_pixels(&px, 3, None);
        let b = out.raw();
        let moved = |i: usize| {
            (0..3)
                .map(|c| b[i * 4 + c].abs_diff(px.raw()[i * 4 + c]))
                .max()
                .unwrap()
        };
        assert!(
            moved(0) > 20 && moved(1) > 20,
            "saturated primaries clip: {b:?}"
        );
        assert!(moved(2) <= 6, "a mid grey survives the press: {b:?}");
        // Projecting again changes (almost) nothing: the result is in gamut.
        let again = t.project_pixels(&out, 3, None);
        let drift = again
            .raw()
            .iter()
            .zip(b)
            .map(|(a, b)| a.abs_diff(*b))
            .max()
            .unwrap();
        // Again, inks quantised to 8 bits: a level or three of wander.
        assert!(
            drift <= 4,
            "a projected colour is (nearly) a fixed point (drift {drift})"
        );
    }

    #[test]
    fn the_gamut_warning_marks_what_grey_cannot_show__feat__image_io_depth_color_modes() {
        let p = Proof::new(ColorMode::Gray, None, false, true).expect("grey proof");
        let px = rgb8(&[[255, 0, 0], [90, 90, 90], [0, 0, 0]]);
        let out = p.apply_rgba8(px.raw());
        assert_eq!(&out[..3], &GAMUT_WARNING_RGB, "red has no grey");
        assert_eq!(&out[4..7], &[90, 90, 90], "a grey is in the grey gamut");
        assert_eq!(out[3], 200, "alpha is kept");
    }

    #[test]
    fn a_grey_soft_proof_shows_the_grey_document__feat__image_io_depth_color_modes() {
        let p = Proof::new(ColorMode::Gray, None, true, false).expect("grey proof");
        let px = rgb8(&[[255, 0, 0], [0, 255, 0]]);
        let out = p.apply_rgba8(px.raw());
        for q in out.as_chunks::<4>().0 {
            assert!(
                q[0].abs_diff(q[1]) <= 1 && q[1].abs_diff(q[2]) <= 1,
                "{q:?}"
            );
        }
        assert!(Proof::new(ColorMode::Cmyk, None, true, false).is_err());
        assert!(Proof::new(ColorMode::Rgb, None, true, false).is_err());
    }
}
