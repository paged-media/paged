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

//! Soft proofing and the gamut check: two conversions through an output
//! (proof) profile.

use super::pcs::delta_e76;
use super::{
    decode_u8, profile_space, Backend, CmsError, Intent, Layout, ProfileRef, Rendering, Space,
    Transform,
};

/// How a soft proof simulates the output device, after the "Proof
/// Setup" dialogs of InDesign and Photoshop.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ProofOptions {
    /// The source-to-output conversion: what the press will be sent.
    pub rendering: Rendering,
    /// "Simulate Paper Color": the output's paper white and black are
    /// shown as measured (absolute colorimetric to the display). Implies
    /// [`Self::simulate_black_ink`].
    pub simulate_paper: bool,
    /// "Simulate Black Ink": the output's black is shown as measured
    /// (relative colorimetric without BPC). Off, the display leg
    /// compensates the black point, so the proof's shadows use the
    /// display's full range.
    pub simulate_black_ink: bool,
}

impl ProofOptions {
    /// The output-to-display conversion these options imply.
    pub fn display_rendering(&self) -> Rendering {
        if self.simulate_paper {
            Rendering::new(Intent::AbsoluteColorimetric, false)
        } else {
            Rendering::new(Intent::RelativeColorimetric, !self.simulate_black_ink)
        }
    }
}

const CHUNK: usize = 4096;

/// Source pixels shown as they would print: source → output device under
/// the proof's rendering, then output device → display.
pub struct SoftProof {
    to_device: Transform,
    to_display: Transform,
    src: Layout,
    dst: Layout,
    device: Space,
}

impl SoftProof {
    pub fn new(
        backend: Backend,
        src: ProfileRef<'_>,
        src_layout: Layout,
        output: ProfileRef<'_>,
        display: ProfileRef<'_>,
        display_layout: Layout,
        options: ProofOptions,
    ) -> Result<SoftProof, CmsError> {
        let device = profile_space(output)?;
        if device == Space::Lab {
            return Err(CmsError::Unsupported(
                "a proof needs an output device profile, not Lab".into(),
            ));
        }
        let dev = Layout::new(device, false);
        let to_device = Transform::new(
            backend,
            src,
            Layout::new(src_layout.space, false),
            output,
            dev,
            options.rendering,
        )?;
        let to_display = Transform::new(
            backend,
            output,
            dev,
            display,
            Layout::new(display_layout.space, false),
            options.display_rendering(),
        )?;
        Ok(SoftProof {
            to_device,
            to_display,
            src: src_layout,
            dst: display_layout,
            device,
        })
    }

    /// The source → output conversion alone.
    pub fn to_device(&self) -> &Transform {
        &self.to_device
    }

    /// Float pixels (the [`Layout`] conventions); the output device is
    /// carried in float between the two conversions.
    pub fn apply_f32(&self, src: &[f32], dst: &mut [f32]) {
        let (si, di) = (self.src.channels(), self.dst.channels());
        let (sc, dc) = (self.src.space.channels(), self.dst.space.channels());
        let n = src.len() / si;
        assert_eq!(src.len(), n * si, "source is not whole pixels");
        assert_eq!(dst.len(), n * di, "destination pixel count differs");
        let mut colour = vec![0f32; CHUNK.min(n) * sc];
        let mut dev = vec![0f32; CHUNK.min(n) * self.device.channels()];
        let mut out = vec![0f32; CHUNK.min(n) * dc];
        for start in (0..n).step_by(CHUNK) {
            let len = CHUNK.min(n - start);
            let s = &src[start * si..(start + len) * si];
            for (px, c) in s.chunks_exact(si).zip(colour.chunks_exact_mut(sc)) {
                c.copy_from_slice(&px[..sc]);
            }
            let dev = &mut dev[..len * self.device.channels()];
            self.to_device.apply_f32(&colour[..len * sc], dev);
            self.to_display.apply_f32(dev, &mut out[..len * dc]);
            let d = &mut dst[start * di..(start + len) * di];
            for ((px, c), sp) in d
                .chunks_exact_mut(di)
                .zip(out.chunks_exact(dc))
                .zip(s.chunks_exact(si))
            {
                px[..dc].copy_from_slice(c);
                if self.dst.alpha {
                    px[dc] = if self.src.alpha { sp[sc] } else { 1.0 };
                }
            }
        }
    }

    /// 8-bit pixels, through the float path.
    pub fn apply_u8(&self, src: &[u8], dst: &mut [u8]) {
        let mut fs = vec![0f32; src.len()];
        decode_layout(self.src, src, &mut fs);
        let mut fd = vec![0f32; dst.len()];
        self.apply_f32(&fs, &mut fd);
        encode_layout(self.dst, &fd, dst);
    }
}

fn decode_layout(layout: Layout, src: &[u8], dst: &mut [f32]) {
    let (ch, c) = (layout.channels(), layout.space.channels());
    for (s, d) in src.chunks_exact(ch).zip(dst.chunks_exact_mut(ch)) {
        decode_u8(layout.space, &s[..c], &mut d[..c]);
        if layout.alpha {
            d[c] = f32::from(s[c]) / 255.0;
        }
    }
}

fn encode_layout(layout: Layout, src: &[f32], dst: &mut [u8]) {
    let (ch, c) = (layout.channels(), layout.space.channels());
    for (s, d) in src.chunks_exact(ch).zip(dst.chunks_exact_mut(ch)) {
        super::encode_u8(layout.space, &s[..c], &mut d[..c]);
        if layout.alpha {
            d[c] = (s[c] * 255.0).round().clamp(0.0, 255.0) as u8;
        }
    }
}

/// Which source colours an output profile cannot reproduce.
///
/// A colour's reference is its own Lab (relative colorimetric); its
/// reproduction goes into the output device and back to Lab (relative
/// colorimetric both ways, no BPC: the colorimetric gamut, as the gamut
/// warnings of InDesign and Photoshop show it). A pixel is out of gamut
/// when the two differ by more than the threshold, in CIE76 ΔE*ab.
pub struct GamutCheck {
    reference: Transform,
    to_device: Transform,
    back: Transform,
    src: Layout,
    device: Space,
    threshold: f32,
}

/// What [`GamutCheck`] found, per pixel.
#[derive(Debug, Clone, PartialEq)]
pub struct GamutMask {
    /// The round-trip ΔE*ab of each pixel.
    pub delta_e: Vec<f32>,
    /// `delta_e > threshold`.
    pub out_of_gamut: Vec<bool>,
}

impl GamutMask {
    pub fn count(&self) -> usize {
        self.out_of_gamut.iter().filter(|&&o| o).count()
    }
}

impl GamutCheck {
    /// A common threshold: about the just-noticeable difference, above
    /// the noise an 8-bit round trip adds.
    pub const DEFAULT_THRESHOLD: f32 = 3.0;

    pub fn new(
        backend: Backend,
        src: ProfileRef<'_>,
        src_layout: Layout,
        output: ProfileRef<'_>,
        threshold_delta_e: f32,
    ) -> Result<GamutCheck, CmsError> {
        if !backend.reaches_pcs() {
            return Err(CmsError::Unsupported(format!(
                "{backend} has no Lab endpoint for the gamut check"
            )));
        }
        let device = profile_space(output)?;
        let colorimetric = Rendering::new(Intent::RelativeColorimetric, false);
        let src_colour = Layout::new(src_layout.space, false);
        let dev = Layout::new(device, false);
        Ok(GamutCheck {
            reference: Transform::new(
                backend,
                src,
                src_colour,
                ProfileRef::Lab,
                Layout::LAB,
                colorimetric,
            )?,
            to_device: Transform::new(backend, src, src_colour, output, dev, colorimetric)?,
            back: Transform::new(
                backend,
                output,
                dev,
                ProfileRef::Lab,
                Layout::LAB,
                colorimetric,
            )?,
            src: src_layout,
            device,
            threshold: threshold_delta_e,
        })
    }

    pub fn threshold(&self) -> f32 {
        self.threshold
    }

    /// Float pixels in the source layout.
    pub fn check_f32(&self, src: &[f32]) -> GamutMask {
        let (si, sc) = (self.src.channels(), self.src.space.channels());
        let n = src.len() / si;
        assert_eq!(src.len(), n * si, "source is not whole pixels");
        let colour: Vec<f32> = src
            .chunks_exact(si)
            .flat_map(|p| p[..sc].to_vec())
            .collect();
        let mut lab = vec![0f32; n * 3];
        self.reference.apply_f32(&colour, &mut lab);
        let mut dev = vec![0f32; n * self.device.channels()];
        self.to_device.apply_f32(&colour, &mut dev);
        let mut back = vec![0f32; n * 3];
        self.back.apply_f32(&dev, &mut back);
        let delta_e: Vec<f32> = lab
            .as_chunks::<3>()
            .0
            .iter()
            .zip(back.as_chunks::<3>().0)
            .map(|(a, b)| delta_e76([a[0], a[1], a[2]], [b[0], b[1], b[2]]))
            .collect();
        let out_of_gamut = delta_e.iter().map(|&d| d > self.threshold).collect();
        GamutMask {
            delta_e,
            out_of_gamut,
        }
    }

    /// 8-bit pixels in the source layout.
    pub fn check_u8(&self, src: &[u8]) -> GamutMask {
        let mut f = vec![0f32; src.len()];
        decode_layout(self.src, src, &mut f);
        self.check_f32(&f)
    }
}
