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

//! The qcms backend: 8-bit device-to-device only (Gray, RGB or CMYK in;
//! RGB or CMYK out). qcms has no PCS endpoint and no BPC, and is
//! perceptual/relative-colorimetric-centred: it takes all four intent
//! tags but degrades saturation and absolute to its nearest behaviour.
//! A float request is served by quantising to 8 bits.

use super::{decode_u8, encode_u8, CmsError, End, Intent, Leg, ProfileRef, Space};

fn intent(i: Intent) -> qcms::Intent {
    match i {
        Intent::Perceptual => qcms::Intent::Perceptual,
        Intent::RelativeColorimetric => qcms::Intent::RelativeColorimetric,
        Intent::Saturation => qcms::Intent::Saturation,
        Intent::AbsoluteColorimetric => qcms::Intent::AbsoluteColorimetric,
    }
}

fn open(p: ProfileRef<'_>) -> Result<Box<qcms::Profile>, CmsError> {
    match p {
        ProfileRef::Icc(bytes) => qcms::Profile::new_from_slice(bytes, false)
            .ok_or_else(|| CmsError::BadProfile("qcms rejected the profile".into())),
        ProfileRef::Srgb => Ok(qcms::Profile::new_sRGB()),
        ProfileRef::Gray(gamma) => Ok(qcms::Profile::new_gray_with_gamma(gamma)),
        ProfileRef::Lab => Err(CmsError::Unsupported("qcms has no Lab endpoint".into())),
    }
}

struct QcmsLeg {
    transform: qcms::Transform,
    src: Space,
    dst: Space,
}

impl Leg for QcmsLeg {
    fn run_u8(&self, src: &[u8], dst: &mut [u8]) -> bool {
        self.transform.convert(src, dst);
        true
    }

    fn run_f32(&self, src: &[f32], dst: &mut [f32]) {
        let mut a = vec![0u8; src.len()];
        encode_u8(self.src, src, &mut a);
        let mut b = vec![0u8; dst.len()];
        self.transform.convert(&a, &mut b);
        decode_u8(self.dst, &b, dst);
    }
}

pub(super) fn leg(src: End<'_>, dst: End<'_>, i: Intent) -> Result<Box<dyn Leg>, CmsError> {
    let (End::Device(sp, ss), End::Device(dp, ds)) = (src, dst) else {
        return Err(CmsError::Unsupported(
            "qcms converts device to device only (no PCS endpoint)".into(),
        ));
    };
    let src_ty = match ss {
        Space::Gray => qcms::DataType::Gray8,
        Space::Rgb => qcms::DataType::RGB8,
        Space::Cmyk => qcms::DataType::CMYK,
        Space::Lab => return Err(CmsError::Unsupported("qcms has no Lab endpoint".into())),
    };
    let dst_ty = match ds {
        Space::Rgb => qcms::DataType::RGB8,
        Space::Cmyk => qcms::DataType::CMYK,
        other => {
            return Err(CmsError::Unsupported(format!(
                "qcms cannot write {other:?} pixels"
            )))
        }
    };
    let sp = open(sp)?;
    let mut dp = open(dp)?;
    // Without the precache an RGB destination's output LUT stays empty
    // and CMYK lookups come out black.
    if ds == Space::Rgb {
        dp.precache_output_transform();
    }
    let transform = qcms::Transform::new_to(&sp, &dp, src_ty, dst_ty, intent(i))
        .ok_or_else(|| CmsError::Unsupported("qcms could not build the transform".into()))?;
    Ok(Box::new(QcmsLeg {
        transform,
        src: ss,
        dst: ds,
    }))
}
