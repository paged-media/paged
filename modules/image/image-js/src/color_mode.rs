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
//! What a mode is NOT here: the stored channels. A CMYK document's layers
//! are not ink planes and its blends are not subtractive; Indexed,
//! Duotone and Multichannel are not offered. Those need N-channel planes
//! in the stack and a `paged-pixel` PixelFormat amendment (the ADR's
//! deferred half).

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
}

impl ColorMode {
    /// The wire name (`rgb`, `gray`, `cmyk`, `lab`).
    pub fn name(self) -> &'static str {
        match self {
            ColorMode::Rgb => "rgb",
            ColorMode::Gray => "gray",
            ColorMode::Cmyk => "cmyk",
            ColorMode::Lab => "lab",
        }
    }

    pub fn from_name(s: &str) -> Option<ColorMode> {
        Some(match s {
            "rgb" => ColorMode::Rgb,
            "gray" | "grey" | "grayscale" => ColorMode::Gray,
            "cmyk" => ColorMode::Cmyk,
            "lab" => ColorMode::Lab,
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
        }
    }

    /// The persisted code.
    pub fn code(self) -> u8 {
        match self {
            ColorMode::Rgb => 0,
            ColorMode::Gray => 1,
            ColorMode::Cmyk => 2,
            ColorMode::Lab => 3,
        }
    }

    pub fn from_code(c: u8) -> Option<ColorMode> {
        Some(match c {
            0 => ColorMode::Rgb,
            1 => ColorMode::Gray,
            2 => ColorMode::Cmyk,
            3 => ColorMode::Lab,
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
            _ => return None,
        };
        Some(DocMode {
            mode,
            cmyk_profile: (mode == ColorMode::Cmyk)
                .then(|| file.resources.icc_profile().map(Arc::from))
                .flatten(),
        })
    }

    /// Whether pixels are projected at all (RGB, and CMYK without a
    /// profile, hold every sRGB colour).
    pub fn projects(&self) -> bool {
        match self.mode {
            ColorMode::Rgb => false,
            ColorMode::Cmyk => self.cmyk_profile.is_some(),
            ColorMode::Gray | ColorMode::Lab => true,
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
            ColorMode::Gray => (ProfileRef::Gray(GRAY_GAMMA), Space::Gray),
            ColorMode::Lab => (ProfileRef::Lab, Space::Lab),
            ColorMode::Cmyk => (
                ProfileRef::Icc(mode.cmyk_profile.as_deref().expect("projects() checked")),
                Space::Cmyk,
            ),
            ColorMode::Rgb => unreachable!("projects() is false for RGB"),
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
        Ok(Some(ModeTransform { to, back, space }))
    }

    /// Project straight RGB floats (0..=1, three per pixel) in place: to
    /// the mode's space, stored at `depth`, and back.
    pub fn project_rgb(&self, rgb: &mut [f32], depth: SampleDepth) {
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
        };
        assert!(ModeTransform::new(&naive).unwrap().is_none());
    }

    #[test]
    fn grayscale_makes_every_pixel_neutral_and_keeps_alpha__feat__image_io_depth_color_modes() {
        let t = ModeTransform::new(&DocMode {
            mode: ColorMode::Gray,
            cmyk_profile: None,
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
