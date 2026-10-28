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

//! The moxcms backend (pure Rust, every target).
//!
//! moxcms selects the per-intent A2B/B2A table from
//! `TransformOptions::rendering_intent`, so all four intents are real.
//! It has no BPC (0.8 comments the option out) and no reliable Lab or
//! XYZ pixel endpoint, so this module reaches the PCS through a *proxy*:
//! an RGB matrix-shaper profile whose colorants are the identity (its
//! linear RGB IS PCS XYZ) and whose TRC is the CIE L\* companding curve,
//! so moxcms's LUT sampling sees perceptually even steps in the shadows.
//! XYZ is encoded into, and decoded out of, the proxy here.

use std::sync::Arc;

use moxcms::{
    ColorProfile, Layout as MLayout, RenderingIntent, ToneReprCurve, Transform8BitExecutor,
    TransformF32Executor, TransformOptions, Xyzd,
};

use super::pcs::D50;
use super::{CmsError, End, Intent, Leg, ProfileRef, Space};

fn intent(i: Intent) -> RenderingIntent {
    match i {
        Intent::Perceptual => RenderingIntent::Perceptual,
        Intent::RelativeColorimetric => RenderingIntent::RelativeColorimetric,
        Intent::Saturation => RenderingIntent::Saturation,
        Intent::AbsoluteColorimetric => RenderingIntent::AbsoluteColorimetric,
    }
}

/// CIE L* companding as an ICC parametric curve (type 4: `Y = (aX + b)^g`
/// above `d`, `Y = cX` below): `X` is L*/100 of the component.
fn lstar_curve() -> ToneReprCurve {
    ToneReprCurve::Parametric(vec![3.0, 1.0 / 1.16, 0.16 / 1.16, 1.0 / 9.033, 0.08])
}

fn proxy() -> ColorProfile {
    let mut p = ColorProfile::new_srgb();
    p.red_colorant = Xyzd {
        x: 1.0,
        y: 0.0,
        z: 0.0,
    };
    p.green_colorant = Xyzd {
        x: 0.0,
        y: 1.0,
        z: 0.0,
    };
    p.blue_colorant = Xyzd {
        x: 0.0,
        y: 0.0,
        z: 1.0,
    };
    p.red_trc = Some(lstar_curve());
    p.green_trc = Some(lstar_curve());
    p.blue_trc = Some(lstar_curve());
    p.media_white_point = Some(moxcms::WHITE_POINT_D50.to_xyzd());
    p.cicp = None;
    p
}

fn encode(c: f32) -> f32 {
    if c > 216.0 / 24389.0 {
        1.16 * c.cbrt() - 0.16
    } else {
        c * 24389.0 / 27.0 / 100.0
    }
}

fn decode(v: f32) -> f32 {
    if v >= 0.08 {
        let t = (v + 0.16) / 1.16;
        t * t * t
    } else {
        v * 100.0 * 27.0 / 24389.0
    }
}

fn open(p: ProfileRef<'_>) -> Result<ColorProfile, CmsError> {
    match p {
        ProfileRef::Icc(bytes) => ColorProfile::new_from_slice(bytes)
            .map_err(|e| CmsError::BadProfile(format!("moxcms rejected the profile: {e:?}"))),
        ProfileRef::Srgb => Ok(ColorProfile::new_srgb()),
        ProfileRef::Gray(gamma) => Ok(ColorProfile::new_gray_with_gamma(gamma)),
        ProfileRef::Lab => Err(CmsError::Unsupported(
            "a Lab end is converted to XYZ before the backend".into(),
        )),
    }
}

fn layout(space: Space) -> MLayout {
    match space {
        Space::Gray => MLayout::Gray,
        Space::Rgb | Space::Lab => MLayout::Rgb,
        // moxcms carries four inks in the four-slot layout.
        Space::Cmyk => MLayout::Rgba,
    }
}

/// How a leg's XYZ end reaches moxcms.
#[derive(Clone, Copy, PartialEq)]
enum Pcs {
    /// The proxy profile (see the module docs).
    Proxy,
    /// A linear gray profile, for a gray device on the other end: moxcms
    /// converts gray to RGB by copying the luminance into all three
    /// channels, which in the proxy would be XYZ (Y, Y, Y) — not neutral.
    /// Gray to linear gray is the luminance; the PCS neutral is D50·Y.
    Gray,
}

struct MoxLeg {
    u8: Option<Arc<Transform8BitExecutor>>,
    f32: Arc<TransformF32Executor>,
    src_pcs: Option<Pcs>,
    dst_pcs: Option<Pcs>,
}

impl Leg for MoxLeg {
    fn run_u8(&self, src: &[u8], dst: &mut [u8]) -> bool {
        match &self.u8 {
            Some(t) => {
                t.transform(src, dst)
                    .expect("moxcms 8-bit: caller-checked lengths cannot fail");
                true
            }
            None => false,
        }
    }

    fn run_f32(&self, src: &[f32], dst: &mut [f32]) {
        let encoded: Vec<f32>;
        let input = match self.src_pcs {
            None => src,
            Some(Pcs::Proxy) => {
                encoded = src.iter().map(|&c| encode(c)).collect();
                &encoded[..]
            }
            Some(Pcs::Gray) => {
                encoded = src.as_chunks::<3>().0.iter().map(|xyz| xyz[1]).collect();
                &encoded[..]
            }
        };
        match self.dst_pcs {
            Some(Pcs::Gray) => {
                let mut y = vec![0f32; dst.len() / 3];
                self.f32
                    .transform(input, &mut y)
                    .expect("moxcms float: caller-checked lengths cannot fail");
                for (xyz, y) in dst.as_chunks_mut::<3>().0.iter_mut().zip(y) {
                    xyz.copy_from_slice(&[D50[0] * y, y, D50[2] * y]);
                }
            }
            pcs => {
                self.f32
                    .transform(input, dst)
                    .expect("moxcms float: caller-checked lengths cannot fail");
                if pcs == Some(Pcs::Proxy) {
                    for v in dst.iter_mut() {
                        *v = decode(*v);
                    }
                }
            }
        }
    }
}

pub(super) fn leg(src: End<'_>, dst: End<'_>, i: Intent) -> Result<Box<dyn Leg>, CmsError> {
    let gray = |e: End<'_>| matches!(e, End::Device(_, Space::Gray));
    let side =
        |e: End<'_>, other_gray: bool| -> Result<(ColorProfile, MLayout, Option<Pcs>), CmsError> {
            match e {
                End::Device(p, space) => Ok((open(p)?, layout(space), None)),
                End::Xyz if other_gray => Ok((
                    ColorProfile::new_gray_with_gamma(1.0),
                    MLayout::Gray,
                    Some(Pcs::Gray),
                )),
                End::Xyz => Ok((proxy(), MLayout::Rgb, Some(Pcs::Proxy))),
            }
        };
    let (sp, sl, src_pcs) = side(src, gray(dst))?;
    let (dp, dl, dst_pcs) = side(dst, gray(src))?;
    let options = TransformOptions {
        rendering_intent: intent(i),
        ..Default::default()
    };
    let err = |e: moxcms::CmsError| {
        CmsError::Unsupported(format!("moxcms could not build the transform: {e:?}"))
    };
    let u8 = if src_pcs.is_some() || dst_pcs.is_some() {
        None
    } else {
        Some(
            sp.create_transform_8bit(sl, &dp, dl, options)
                .map_err(err)?,
        )
    };
    // The float leg keeps moxcms's float matrices: its fixed-point path
    // (Q2.13) overflows on the proxy's matrix, whose inverse to a display
    // space has entries beyond its range.
    let float = TransformOptions {
        prefer_fixed_point: false,
        ..options
    };
    let f32 = sp.create_transform_f32(sl, &dp, dl, float).map_err(err)?;
    Ok(Box::new(MoxLeg {
        u8,
        f32,
        src_pcs,
        dst_pcs,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_proxy_curve_round_trips() {
        for c in [0.0f32, 0.001, 0.008, 0.01, 0.18, 0.5, 0.9642, 1.0] {
            assert!((decode(encode(c)) - c).abs() < 1e-6, "{c}");
        }
    }
}
