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

//! One colour-management API over the engine's three CMMs.
//!
//! [`Transform`] converts pixels between two profiles with an explicit
//! [`Intent`] and black-point compensation, whichever [`Backend`] runs
//! it:
//!
//! | backend | targets | endpoints | BPC |
//! |---|---|---|---|
//! | [`Backend::Lcms2`] | native | Gray, RGB, CMYK, Lab; 8-bit and float | lcms2's own |
//! | [`Backend::Moxcms`] | every target (feature `moxcms`) | Gray, RGB, CMYK, Lab; 8-bit and float | this module's ([`bpc`]) |
//! | [`Backend::Qcms`] | every target | Gray/RGB/CMYK in, RGB/CMYK out; 8-bit | none (refused) |
//!
//! The transform kinds are what the layouts say: RGB↔RGB, CMYK→RGB,
//! RGB→CMYK, Lab↔RGB/CMYK, Gray→RGB and back. Lab endpoints are CIELAB
//! under the ICC's D50 white, converted here to and from the XYZ PCS so a
//! backend only ever sees device profiles and XYZ.
//!
//! **Black-point compensation** follows Adobe's published algorithm
//! ("Adobe Systems' Implementation of Black Point Compensation", 2006):
//! the source and destination black points are detected from the
//! profiles ([`bpc`]) and the PCS is scaled in XYZ so the source black
//! lands on the destination black while white stays put. lcms2 implements
//! the same paper, so its BPC is the oracle the tests measure ours
//! against. BPC applies between two device profiles under the
//! perceptual, relative-colorimetric and saturation intents; absolute
//! colorimetric never compensates (it reproduces the source's black as
//! measured), and a Lab endpoint has the PCS black, which needs none.
//!
//! [`SoftProof`] simulates an output device on a display, and
//! [`GamutCheck`] flags the pixels an output profile cannot reproduce
//! within a ΔE threshold.

pub(crate) mod bpc;
mod icc;
#[cfg(not(target_arch = "wasm32"))]
mod lcms;
#[cfg(feature = "moxcms")]
mod mox;
mod pcs;
mod proof;
mod qc;

pub use crate::cmm::Intent;
pub use bpc::V4_PERCEPTUAL_BLACK;
pub use bpc::{detect_destination_black_point, detect_source_black_point};
pub use pcs::{delta_e76, lab_to_xyz, xyz_to_lab, D50};
pub use proof::{GamutCheck, GamutMask, ProofOptions, SoftProof};

/// The engines this module can drive. Every variant exists on every
/// target; [`Backend::is_available`] says whether this build has it, and
/// a transform on an unavailable one fails with [`CmsError::Unavailable`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Backend {
    /// Little CMS 2 (C, native only): the reference implementation and
    /// the fidelity gate's CMM (poppler uses it too).
    Lcms2,
    /// Mozilla's qcms 0.3 (pure Rust): Firefox's CMM, the wasm32 paint
    /// path since the engine first ran in a browser.
    Qcms,
    /// moxcms 0.8 (pure Rust, feature `moxcms`): every ICC intent, LUT
    /// and matrix-shaper profiles, 8-bit and float, on every target.
    Moxcms,
}

impl Backend {
    pub const ALL: [Backend; 3] = [Backend::Lcms2, Backend::Qcms, Backend::Moxcms];

    /// Whether this build carries the backend.
    pub fn is_available(self) -> bool {
        match self {
            Backend::Lcms2 => cfg!(not(target_arch = "wasm32")),
            Backend::Qcms => true,
            Backend::Moxcms => cfg!(feature = "moxcms"),
        }
    }

    /// The backend a caller without a preference should use: lcms2 on
    /// native, moxcms on wasm32 when the feature is on (it honours every
    /// intent and, through this module, BPC), else qcms.
    pub fn preferred() -> Backend {
        if Backend::Lcms2.is_available() {
            Backend::Lcms2
        } else if Backend::Moxcms.is_available() {
            Backend::Moxcms
        } else {
            Backend::Qcms
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Backend::Lcms2 => "lcms2",
            Backend::Qcms => "qcms",
            Backend::Moxcms => "moxcms",
        }
    }

    /// The backend compensates the black point itself.
    pub fn has_native_bpc(self) -> bool {
        self == Backend::Lcms2
    }

    /// The backend reaches the PCS (float samples, XYZ and Lab
    /// endpoints), which software BPC, soft proofing and the gamut check
    /// need.
    pub fn reaches_pcs(self) -> bool {
        matches!(self, Backend::Lcms2 | Backend::Moxcms)
    }
}

impl std::fmt::Display for Backend {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.name())
    }
}

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum CmsError {
    #[error("the {0} backend is not in this build")]
    Unavailable(Backend),
    #[error("profile rejected: {0}")]
    BadProfile(String),
    #[error("the profile's colour space is {profile:?}, the layout's is {layout:?}")]
    SpaceMismatch { profile: Space, layout: Space },
    #[error("unsupported: {0}")]
    Unsupported(String),
}

/// A colour space as pixels carry it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Space {
    Gray,
    Rgb,
    Cmyk,
    /// CIELAB, D50 white (the ICC PCS).
    Lab,
}

impl Space {
    pub fn channels(self) -> usize {
        match self {
            Space::Gray => 1,
            Space::Rgb | Space::Lab => 3,
            Space::Cmyk => 4,
        }
    }
}

/// Interleaved pixel layout: the colour channels, then alpha when
/// `alpha` is set.
///
/// Sample conventions. 8-bit: device channels 0..=255 (CMYK: 255 is full
/// ink); Lab in the ICC 8-bit encoding (L* × 255/100, a* + 128, b* + 128).
/// Float: device channels 0..=1 (CMYK: 1 is full ink); Lab as real values
/// (L* 0..=100, a* and b* about −128..=127); alpha 0..=1.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Layout {
    pub space: Space,
    pub alpha: bool,
}

impl Layout {
    pub const GRAY: Layout = Layout::new(Space::Gray, false);
    pub const RGB: Layout = Layout::new(Space::Rgb, false);
    pub const RGBA: Layout = Layout::new(Space::Rgb, true);
    pub const CMYK: Layout = Layout::new(Space::Cmyk, false);
    pub const LAB: Layout = Layout::new(Space::Lab, false);

    pub const fn new(space: Space, alpha: bool) -> Layout {
        Layout { space, alpha }
    }

    /// Samples per pixel.
    pub fn channels(self) -> usize {
        self.space.channels() + usize::from(self.alpha)
    }
}

/// A profile to build a transform from.
#[derive(Debug, Clone, Copy)]
pub enum ProfileRef<'a> {
    /// ICC profile bytes.
    Icc(&'a [u8]),
    /// The backend's built-in sRGB (IEC 61966-2-1).
    Srgb,
    /// CIELAB under D50: the PCS itself, for [`Space::Lab`] endpoints.
    Lab,
    /// A gray profile with a pure gamma TRC and the D50 white.
    Gray(f32),
}

/// The intent and black-point compensation of one conversion: the
/// rendering half of a document's (or a frame's) colour settings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Rendering {
    pub intent: Intent,
    pub bpc: bool,
}

impl Rendering {
    pub const fn new(intent: Intent, bpc: bool) -> Rendering {
        Rendering { intent, bpc }
    }
}

impl Default for Rendering {
    /// Relative colorimetric with BPC: InDesign's and Photoshop's Color
    /// Settings default, and the engine's since it first converted CMYK.
    fn default() -> Self {
        Rendering::new(Intent::RelativeColorimetric, true)
    }
}

/// How BPC is computed when it is requested.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum BpcMode {
    /// The backend's own when it has one, else this module's.
    #[default]
    Auto,
    /// Always this module's, even on lcms2 — how the tests hold the
    /// algorithm to lcms2's.
    Software,
}

/// What a transform did about black-point compensation.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum BpcApplied {
    /// Not requested.
    Off,
    /// Requested, and nothing to compensate: absolute colorimetric, a Lab
    /// endpoint, or the two black points are equal.
    NotNeeded,
    /// The backend's own (lcms2).
    Native,
    /// This module's, between these black points (XYZ, D50).
    Software {
        source: [f32; 3],
        destination: [f32; 3],
    },
}

/// Pixels per batch: bounds the scratch buffers.
const CHUNK: usize = 4096;

/// One end of a backend conversion: a device profile, or the XYZ PCS.
#[derive(Debug, Clone, Copy)]
pub(crate) enum End<'a> {
    Device(ProfileRef<'a>, Space),
    Xyz,
}

/// A backend conversion between two [`End`]s, over packed colour
/// channels (no alpha). Float samples follow the [`Layout`] conventions,
/// with XYZ as real values (Y = 1 is white).
pub(crate) trait Leg {
    /// 8-bit samples; `false` when the backend cannot run this leg in 8
    /// bits (an XYZ end), and the caller takes the float path.
    fn run_u8(&self, src: &[u8], dst: &mut [u8]) -> bool;
    fn run_f32(&self, src: &[f32], dst: &mut [f32]);
}

pub(crate) fn build_leg(
    backend: Backend,
    src: End<'_>,
    dst: End<'_>,
    intent: Intent,
    native_bpc: bool,
) -> Result<Box<dyn Leg>, CmsError> {
    if !backend.is_available() {
        return Err(CmsError::Unavailable(backend));
    }
    match backend {
        #[cfg(not(target_arch = "wasm32"))]
        Backend::Lcms2 => lcms::leg(src, dst, intent, native_bpc),
        #[cfg(feature = "moxcms")]
        Backend::Moxcms => {
            let _ = native_bpc;
            mox::leg(src, dst, intent)
        }
        Backend::Qcms => {
            let _ = native_bpc;
            qc::leg(src, dst, intent)
        }
        #[allow(unreachable_patterns)]
        other => Err(CmsError::Unavailable(other)),
    }
}

/// The profile's own colour space, read from its header (built-ins know
/// theirs).
pub fn profile_space(profile: ProfileRef<'_>) -> Result<Space, CmsError> {
    match profile {
        ProfileRef::Icc(bytes) => icc::Facts::parse(bytes).map(|f| f.space),
        ProfileRef::Srgb => Ok(Space::Rgb),
        ProfileRef::Lab => Ok(Space::Lab),
        ProfileRef::Gray(_) => Ok(Space::Gray),
    }
}

/// Resolve a (profile, layout) pair to a backend end, refusing a layout
/// that is not the profile's space.
fn end_for<'a>(profile: ProfileRef<'a>, space: Space) -> Result<Option<End<'a>>, CmsError> {
    let own = profile_space(profile)?;
    if own != space {
        return Err(CmsError::SpaceMismatch {
            profile: own,
            layout: space,
        });
    }
    Ok(match profile {
        ProfileRef::Lab => None,
        p => Some(End::Device(p, space)),
    })
}

enum Pipeline {
    /// Lab to Lab.
    Identity,
    /// One backend leg. `src_lab` / `dst_lab`: the user end is Lab and
    /// the leg's end is XYZ.
    Direct {
        leg: Box<dyn Leg>,
        src_lab: bool,
        dst_lab: bool,
    },
    /// Device → XYZ, the BPC scale, XYZ → device.
    Compensated {
        to_pcs: Box<dyn Leg>,
        from_pcs: Box<dyn Leg>,
        scale: bpc::Scale,
    },
}

/// A compiled conversion between two profiles. Build once, apply many.
pub struct Transform {
    src: Layout,
    dst: Layout,
    backend: Backend,
    rendering: Rendering,
    bpc: BpcApplied,
    pipeline: Pipeline,
}

impl std::fmt::Debug for Transform {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Transform")
            .field("src", &self.src)
            .field("dst", &self.dst)
            .field("backend", &self.backend)
            .field("rendering", &self.rendering)
            .field("bpc", &self.bpc)
            .finish_non_exhaustive()
    }
}

impl Transform {
    /// Compile `src` (pixels in `src_layout`) to `dst` (pixels in
    /// `dst_layout`) with `rendering`'s intent and BPC, BPC computed the
    /// [`BpcMode::Auto`] way.
    pub fn new(
        backend: Backend,
        src: ProfileRef<'_>,
        src_layout: Layout,
        dst: ProfileRef<'_>,
        dst_layout: Layout,
        rendering: Rendering,
    ) -> Result<Transform, CmsError> {
        Self::with_mode(
            backend,
            src,
            src_layout,
            dst,
            dst_layout,
            rendering,
            BpcMode::Auto,
        )
    }

    /// [`Self::new`] with an explicit [`BpcMode`].
    pub fn with_mode(
        backend: Backend,
        src: ProfileRef<'_>,
        src_layout: Layout,
        dst: ProfileRef<'_>,
        dst_layout: Layout,
        rendering: Rendering,
        mode: BpcMode,
    ) -> Result<Transform, CmsError> {
        if !backend.is_available() {
            return Err(CmsError::Unavailable(backend));
        }
        let src_end = end_for(src, src_layout.space)?;
        let dst_end = end_for(dst, dst_layout.space)?;
        let intent = rendering.intent;
        let make = |pipeline, bpc| Transform {
            src: src_layout,
            dst: dst_layout,
            backend,
            rendering,
            bpc,
            pipeline,
        };
        let requested = |applied| {
            if rendering.bpc {
                applied
            } else {
                BpcApplied::Off
            }
        };
        let (s, d) = match (src_end, dst_end) {
            (None, None) => return Ok(make(Pipeline::Identity, requested(BpcApplied::NotNeeded))),
            (Some(s), Some(d)) => (s, d),
            // A Lab end: the leg runs to or from XYZ, without BPC (the PCS
            // black needs none).
            (s, d) => {
                let leg = build_leg(
                    backend,
                    s.unwrap_or(End::Xyz),
                    d.unwrap_or(End::Xyz),
                    intent,
                    false,
                )?;
                return Ok(make(
                    Pipeline::Direct {
                        leg,
                        src_lab: s.is_none(),
                        dst_lab: d.is_none(),
                    },
                    requested(BpcApplied::NotNeeded),
                ));
            }
        };
        let direct = |native_bpc: bool, applied: BpcApplied| -> Result<Transform, CmsError> {
            let leg = build_leg(backend, s, d, intent, native_bpc)?;
            Ok(make(
                Pipeline::Direct {
                    leg,
                    src_lab: false,
                    dst_lab: false,
                },
                applied,
            ))
        };
        // ICC v4's perceptual and saturation tables share one reference
        // medium black, so a v4 destination under those intents
        // compensates whether or not BPC was asked for — lcms2 forces it,
        // and the software path does the same so the backends agree. A
        // backend without PCS access cannot, and keeps the request as is.
        let implied = backend.reaches_pcs()
            && matches!(intent, Intent::Perceptual | Intent::Saturation)
            && match d {
                End::Device(p, _) => icc::Facts::of(p)?.is_v4(),
                End::Xyz => false,
            };
        if !rendering.bpc && !implied {
            return direct(false, BpcApplied::Off);
        }
        if intent == Intent::AbsoluteColorimetric {
            return direct(false, BpcApplied::NotNeeded);
        }
        if backend.has_native_bpc() && mode == BpcMode::Auto {
            return direct(rendering.bpc, BpcApplied::Native);
        }
        if !backend.reaches_pcs() {
            return Err(CmsError::Unsupported(format!(
                "{backend} has no black-point compensation and no PCS access to compute one"
            )));
        }
        let (End::Device(sp, ss), End::Device(dp, ds)) = (s, d) else {
            unreachable!("both ends are devices here");
        };
        let source = bpc::detect_source_black_point(backend, sp, ss, intent)?;
        let destination = bpc::detect_destination_black_point(backend, dp, ds, intent)?;
        match bpc::Scale::between(source, destination) {
            None => direct(false, BpcApplied::NotNeeded),
            Some(scale) => {
                let to_pcs = build_leg(backend, s, End::Xyz, intent, false)?;
                let from_pcs = build_leg(backend, End::Xyz, d, intent, false)?;
                Ok(make(
                    Pipeline::Compensated {
                        to_pcs,
                        from_pcs,
                        scale,
                    },
                    BpcApplied::Software {
                        source,
                        destination,
                    },
                ))
            }
        }
    }

    pub fn src_layout(&self) -> Layout {
        self.src
    }

    pub fn dst_layout(&self) -> Layout {
        self.dst
    }

    pub fn backend(&self) -> Backend {
        self.backend
    }

    pub fn rendering(&self) -> Rendering {
        self.rendering
    }

    /// What was done about black-point compensation.
    pub fn bpc(&self) -> BpcApplied {
        self.bpc
    }

    fn pixels(&self, src_len: usize, dst_len: usize) -> usize {
        let (si, di) = (self.src.channels(), self.dst.channels());
        assert_eq!(src_len % si, 0, "source is not whole {si}-sample pixels");
        assert_eq!(
            dst_len % di,
            0,
            "destination is not whole {di}-sample pixels"
        );
        let n = src_len / si;
        assert_eq!(
            n,
            dst_len / di,
            "source and destination pixel counts differ"
        );
        n
    }

    /// Convert 8-bit pixels. Panics when the slices are not the same
    /// number of whole pixels of the two layouts.
    pub fn apply_u8(&self, src: &[u8], dst: &mut [u8]) {
        let n = self.pixels(src.len(), dst.len());
        let (si, di) = (self.src.channels(), self.dst.channels());
        let (sc, dc) = (self.src.space.channels(), self.dst.space.channels());
        let mut cs = vec![0u8; CHUNK.min(n) * sc];
        let mut cd = vec![0u8; CHUNK.min(n) * dc];
        let mut fs: Vec<f32> = Vec::new();
        let mut fd: Vec<f32> = Vec::new();
        for start in (0..n).step_by(CHUNK) {
            let len = CHUNK.min(n - start);
            let s = &src[start * si..(start + len) * si];
            for (px, out) in s.chunks_exact(si).zip(cs.chunks_exact_mut(sc)) {
                out.copy_from_slice(&px[..sc]);
            }
            let (cs, cd) = (&cs[..len * sc], &mut cd[..len * dc]);
            if !self.run_u8(cs, cd) {
                fs.resize(len * sc, 0.0);
                fd.resize(len * dc, 0.0);
                decode_u8(self.src.space, cs, &mut fs);
                self.run_f32(&mut fs, &mut fd);
                encode_u8(self.dst.space, &fd, cd);
            }
            let d = &mut dst[start * di..(start + len) * di];
            for ((px, colour), sp) in d
                .chunks_exact_mut(di)
                .zip(cd.chunks_exact(dc))
                .zip(s.chunks_exact(si))
            {
                px[..dc].copy_from_slice(colour);
                if self.dst.alpha {
                    px[dc] = if self.src.alpha { sp[sc] } else { 255 };
                }
            }
        }
    }

    /// Convert float pixels (see [`Layout`] for the sample conventions).
    pub fn apply_f32(&self, src: &[f32], dst: &mut [f32]) {
        let n = self.pixels(src.len(), dst.len());
        let (si, di) = (self.src.channels(), self.dst.channels());
        let (sc, dc) = (self.src.space.channels(), self.dst.space.channels());
        let mut cs = vec![0f32; CHUNK.min(n) * sc];
        let mut cd = vec![0f32; CHUNK.min(n) * dc];
        for start in (0..n).step_by(CHUNK) {
            let len = CHUNK.min(n - start);
            let s = &src[start * si..(start + len) * si];
            for (px, out) in s.chunks_exact(si).zip(cs.chunks_exact_mut(sc)) {
                out.copy_from_slice(&px[..sc]);
            }
            self.run_f32(&mut cs[..len * sc], &mut cd[..len * dc]);
            if self.dst.space != Space::Lab {
                // A device takes 0..=1; the float paths of both CMMs
                // extrapolate past it for colours outside its gamut.
                for v in &mut cd[..len * dc] {
                    *v = v.clamp(0.0, 1.0);
                }
            }
            let d = &mut dst[start * di..(start + len) * di];
            for ((px, colour), sp) in d
                .chunks_exact_mut(di)
                .zip(cd.chunks_exact(dc))
                .zip(s.chunks_exact(si))
            {
                px[..dc].copy_from_slice(colour);
                if self.dst.alpha {
                    px[dc] = if self.src.alpha { sp[sc] } else { 1.0 };
                }
            }
        }
    }

    /// Packed colour channels, 8-bit, when the pipeline has an 8-bit
    /// route; `false` sends the caller to the float path.
    fn run_u8(&self, src: &[u8], dst: &mut [u8]) -> bool {
        match &self.pipeline {
            Pipeline::Direct {
                leg,
                src_lab: false,
                dst_lab: false,
            } => leg.run_u8(src, dst),
            Pipeline::Identity => {
                dst.copy_from_slice(src);
                true
            }
            _ => false,
        }
    }

    /// Packed colour channels, float. `src` is scratch (a Lab source is
    /// converted to XYZ in place).
    fn run_f32(&self, src: &mut [f32], dst: &mut [f32]) {
        match &self.pipeline {
            Pipeline::Identity => dst.copy_from_slice(src),
            Pipeline::Direct {
                leg,
                src_lab,
                dst_lab,
            } => {
                if *src_lab {
                    for px in src.as_chunks_mut::<3>().0 {
                        let xyz = lab_to_xyz([px[0], px[1], px[2]]);
                        px.copy_from_slice(&xyz);
                    }
                }
                leg.run_f32(src, dst);
                if *dst_lab {
                    for px in dst.as_chunks_mut::<3>().0 {
                        let lab = xyz_to_lab([px[0], px[1], px[2]]);
                        px.copy_from_slice(&lab);
                    }
                }
            }
            Pipeline::Compensated {
                to_pcs,
                from_pcs,
                scale,
            } => {
                let mut xyz = vec![0f32; src.len() / self.src.space.channels() * 3];
                to_pcs.run_f32(src, &mut xyz);
                for px in xyz.as_chunks_mut::<3>().0 {
                    let v = scale.apply([px[0], px[1], px[2]]);
                    px.copy_from_slice(&v);
                }
                from_pcs.run_f32(&xyz, dst);
            }
        }
    }
}

/// 8-bit samples to the float convention of `space`.
pub(crate) fn decode_u8(space: Space, src: &[u8], dst: &mut [f32]) {
    if space == Space::Lab {
        for (s, d) in src
            .as_chunks::<3>()
            .0
            .iter()
            .zip(dst.as_chunks_mut::<3>().0)
        {
            d[0] = f32::from(s[0]) * 100.0 / 255.0;
            d[1] = f32::from(s[1]) - 128.0;
            d[2] = f32::from(s[2]) - 128.0;
        }
    } else {
        for (s, d) in src.iter().zip(dst.iter_mut()) {
            *d = f32::from(*s) / 255.0;
        }
    }
}

/// Float samples of `space` to 8 bits, rounded and clamped.
pub(crate) fn encode_u8(space: Space, src: &[f32], dst: &mut [u8]) {
    let q = |v: f32| v.round().clamp(0.0, 255.0) as u8;
    if space == Space::Lab {
        for (s, d) in src
            .as_chunks::<3>()
            .0
            .iter()
            .zip(dst.as_chunks_mut::<3>().0)
        {
            d[0] = q(s[0] * 255.0 / 100.0);
            d[1] = q(s[1] + 128.0);
            d[2] = q(s[2] + 128.0);
        }
    } else {
        for (s, d) in src.iter().zip(dst.iter_mut()) {
            *d = q(*s * 255.0);
        }
    }
}

/// The ICC bytes of moxcms's canonical sRGB profile: the working RGB
/// space the image module converts into when a document names none.
#[cfg(feature = "moxcms")]
pub fn moxcms_srgb_icc() -> Result<Vec<u8>, CmsError> {
    moxcms::ColorProfile::new_srgb()
        .encode()
        .map_err(|e| CmsError::BadProfile(format!("could not encode the sRGB profile: {e:?}")))
}

/// The ICC bytes of a grey space with a pure gamma TRC and D50 white —
/// "Gray Gamma 2.2" at `gamma` 2.2, the grey [`ProfileRef::Gray`] names: what
/// a Grayscale document written by the image module embeds, so a reader
/// takes its greys as they were made.
#[cfg(feature = "moxcms")]
pub fn moxcms_gray_icc(gamma: f32) -> Result<Vec<u8>, CmsError> {
    let mut p = moxcms::ColorProfile::new_gray_with_gamma(gamma);
    // A profile without a description is not a valid ICC profile, and
    // Photoshop ignores one (it then reads the greys in its working grey).
    p.description = Some(moxcms::ProfileText::Localizable(vec![
        moxcms::LocalizableString::new(
            "en".to_string(),
            "US".to_string(),
            format!("Gray Gamma {gamma}"),
        ),
    ]));
    p.encode()
        .map(stable_icc)
        .map_err(|e| CmsError::BadProfile(format!("could not encode the grey profile: {e:?}")))
}

/// The same profile whatever the day it was made: the creation date and
/// the profile ID (a digest that covers it) zeroed — an all-zero ID means
/// "not computed" (ICC.1:2010 7.2.18) — so a file that embeds it is the
/// same bytes every time it is written.
#[cfg(feature = "moxcms")]
fn stable_icc(mut icc: Vec<u8>) -> Vec<u8> {
    if icc.len() >= 100 {
        icc[24..36].fill(0);
        icc[84..100].fill(0);
    }
    icc
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(feature = "moxcms")]
    #[test]
    fn the_gray_profile_encodes_and_reads_back_as_grey() {
        let icc = moxcms_gray_icc(2.2).expect("encode");
        assert_eq!(&icc[36..40], b"acsp", "an ICC profile");
        assert_eq!(&icc[16..20], b"GRAY", "a grey colour space");
        let tags = u32::from_be_bytes(icc[128..132].try_into().expect("count"));
        let has =
            |sig: &[u8; 4]| (0..tags as usize).any(|i| &icc[132 + 12 * i..136 + 12 * i] == sig);
        assert!(has(b"desc") && has(b"kTRC"), "a description and a grey TRC");
        assert_eq!(
            icc,
            moxcms_gray_icc(2.2).expect("again"),
            "the same bytes every time"
        );
    }

    #[test]
    fn layouts_count_their_samples() {
        assert_eq!(Layout::RGBA.channels(), 4);
        assert_eq!(Layout::new(Space::Cmyk, true).channels(), 5);
        assert_eq!(Layout::GRAY.channels(), 1);
    }

    #[test]
    fn lab_8bit_encoding_round_trips() {
        let lab = [100.0f32, 0.0, 0.0, 50.0, -20.0, 30.0];
        let mut b = [0u8; 6];
        encode_u8(Space::Lab, &lab, &mut b);
        assert_eq!(b, [255, 128, 128, 128, 108, 158]);
        let mut back = [0f32; 6];
        decode_u8(Space::Lab, &b, &mut back);
        assert!((back[3] - 50.2).abs() < 0.1);
        assert_eq!(back[4], -20.0);
    }

    #[test]
    fn a_layout_that_is_not_the_profiles_space_is_refused() {
        let err = Transform::new(
            Backend::Qcms,
            ProfileRef::Srgb,
            Layout::CMYK,
            ProfileRef::Srgb,
            Layout::RGB,
            Rendering::new(Intent::Perceptual, false),
        )
        .unwrap_err();
        assert_eq!(
            err,
            CmsError::SpaceMismatch {
                profile: Space::Rgb,
                layout: Space::Cmyk
            }
        );
    }

    #[test]
    fn lab_to_lab_is_the_identity() {
        let t = Transform::new(
            Backend::Qcms,
            ProfileRef::Lab,
            Layout::LAB,
            ProfileRef::Lab,
            Layout::LAB,
            Rendering::default(),
        )
        .expect("identity");
        let mut out = [0f32; 3];
        t.apply_f32(&[50.0, 10.0, -10.0], &mut out);
        assert_eq!(out, [50.0, 10.0, -10.0]);
        assert_eq!(t.bpc(), BpcApplied::NotNeeded);
    }

    #[test]
    fn qcms_refuses_bpc_rather_than_ignoring_it() {
        let err = Transform::new(
            Backend::Qcms,
            ProfileRef::Srgb,
            Layout::RGB,
            ProfileRef::Srgb,
            Layout::RGB,
            Rendering::new(Intent::RelativeColorimetric, true),
        )
        .unwrap_err();
        assert!(matches!(err, CmsError::Unsupported(_)), "{err}");
    }

    #[test]
    fn preferred_backend_is_available() {
        assert!(Backend::preferred().is_available());
        assert!(Backend::Qcms.is_available());
    }
}
