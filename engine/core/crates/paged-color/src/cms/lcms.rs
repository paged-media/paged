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

//! The lcms2 backend (native). 8-bit legs are built exactly as
//! [`crate::IccTransform`] builds its CMYK transform (built-in sRGB,
//! `CMYK_8` → `RGB_8`), so a transform through this module is
//! bit-identical to the one the renderer always used.

use lcms2::{CIExyY, Flags, Intent as LIntent, PixelFormat, Profile, ToneCurve, Transform};

use super::{CmsError, End, Intent, Leg, ProfileRef, Space};

fn intent(i: Intent) -> LIntent {
    match i {
        Intent::Perceptual => LIntent::Perceptual,
        Intent::RelativeColorimetric => LIntent::RelativeColorimetric,
        Intent::Saturation => LIntent::Saturation,
        Intent::AbsoluteColorimetric => LIntent::AbsoluteColorimetric,
    }
}

fn open(p: ProfileRef<'_>) -> Result<Profile, CmsError> {
    match p {
        ProfileRef::Icc(bytes) => Profile::new_icc(bytes)
            .map_err(|e| CmsError::BadProfile(format!("lcms2 rejected the profile: {e}"))),
        ProfileRef::Srgb => Ok(Profile::new_srgb()),
        ProfileRef::Gray(gamma) => {
            let d50 = CIExyY {
                x: 0.3457,
                y: 0.3585,
                Y: 1.0,
            };
            Profile::new_gray(&d50, &ToneCurve::new(f64::from(gamma)))
                .map_err(|e| CmsError::BadProfile(format!("lcms2 gray profile: {e}")))
        }
        ProfileRef::Lab => Err(CmsError::Unsupported(
            "a Lab end is converted to XYZ before the backend".into(),
        )),
    }
}

fn format(space: Space, float: bool) -> PixelFormat {
    match (space, float) {
        (Space::Gray, false) => PixelFormat::GRAY_8,
        (Space::Rgb, false) => PixelFormat::RGB_8,
        (Space::Cmyk, false) => PixelFormat::CMYK_8,
        (Space::Gray, true) => PixelFormat::GRAY_FLT,
        (Space::Rgb, true) => PixelFormat::RGB_FLT,
        (Space::Cmyk, true) => PixelFormat::CMYK_FLT,
        (Space::Lab, _) => PixelFormat::XYZ_FLT,
    }
}

/// lcms2 float CMYK is 0..=100 (ink percent); every other float space
/// already matches the module's convention.
fn cmyk_scale(space: Space) -> f32 {
    if space == Space::Cmyk {
        100.0
    } else {
        1.0
    }
}

struct LcmsLeg {
    u8: Option<Transform<u8, u8>>,
    f32: Transform<u8, u8>,
    src: Space,
    dst: Space,
}

impl Leg for LcmsLeg {
    fn run_u8(&self, src: &[u8], dst: &mut [u8]) -> bool {
        match &self.u8 {
            Some(t) => {
                t.transform_pixels(src, dst);
                true
            }
            None => false,
        }
    }

    fn run_f32(&self, src: &[f32], dst: &mut [f32]) {
        let (ss, ds) = (cmyk_scale(self.src), cmyk_scale(self.dst));
        let input: Vec<u8> = src.iter().flat_map(|v| (v * ss).to_ne_bytes()).collect();
        let mut output = vec![0u8; dst.len() * 4];
        self.f32.transform_pixels(&input, &mut output);
        for (d, b) in dst.iter_mut().zip(output.as_chunks::<4>().0) {
            *d = f32::from_ne_bytes(*b) / ds;
        }
    }
}

pub(super) fn leg(
    src: End<'_>,
    dst: End<'_>,
    i: Intent,
    native_bpc: bool,
) -> Result<Box<dyn Leg>, CmsError> {
    // XYZ ends use lcms2's built-in XYZ profile; `Space::Lab` stands for
    // the PCS end in `format` (XYZ_FLT).
    let side = |e: End<'_>| -> Result<(Profile, Space, bool), CmsError> {
        match e {
            End::Device(p, space) => Ok((open(p)?, space, true)),
            // Version 2: lcms2 forces BPC into a v4 profile under the
            // perceptual and saturation intents, and the PCS end must
            // not compensate (the caller decides).
            End::Xyz => {
                let mut xyz = Profile::new_xyz();
                xyz.set_version(2.1);
                Ok((xyz, Space::Lab, false))
            }
        }
    };
    let (sp, ss, s_dev) = side(src)?;
    let (dp, ds, d_dev) = side(dst)?;
    let flags = if native_bpc {
        Flags::BLACKPOINT_COMPENSATION
    } else {
        Flags::default()
    };
    let build = |float: bool| {
        Transform::new_flags(
            &sp,
            format(ss, float),
            &dp,
            format(ds, float),
            intent(i),
            flags,
        )
        .map_err(|e| CmsError::Unsupported(format!("lcms2 could not build the transform: {e}")))
    };
    let u8 = if s_dev && d_dev {
        Some(build(false)?)
    } else {
        None
    };
    Ok(Box::new(LcmsLeg {
        u8,
        f32: build(true)?,
        src: ss,
        dst: ds,
    }))
}
