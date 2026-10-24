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

//! Colour conversion of decoded rasters to straight-alpha sRGB bytes.

use crate::{Alpha, ColorModel, Error, RasterImage, Result, Rgba8, Samples};

/// The colour conversions [`to_rgba8`] delegates. Each returns `false`
/// when it did not convert, and [`to_rgba8`] then takes its fallback:
/// the naive CMYK formula `image` applies to TIFF, or the plain CIE
/// Lab (D50) to sRGB arithmetic of `paged_color::lab`.
pub trait ColourConvert {
    /// CMYK bytes (0 = no ink, 255 = full ink) to sRGB bytes. `icc` is
    /// the image's embedded profile.
    fn cmyk_to_srgb(&self, icc: Option<&[u8]>, cmyk: &[[u8; 4]], rgb: &mut [[u8; 3]]) -> bool;

    /// CIE L*a*b* (D50; L* 0..=100) to sRGB bytes.
    fn lab_to_srgb(&self, icc: Option<&[u8]>, lab: &[[f32; 3]], rgb: &mut [[u8; 3]]) -> bool;
}

/// No colour management: every conversion takes [`to_rgba8`]'s fallback.
#[derive(Clone, Copy, Debug, Default)]
pub struct NaiveColour;

impl ColourConvert for NaiveColour {
    fn cmyk_to_srgb(&self, _: Option<&[u8]>, _: &[[u8; 4]], _: &mut [[u8; 3]]) -> bool {
        false
    }

    fn lab_to_srgb(&self, _: Option<&[u8]>, _: &[[f32; 3]], _: &mut [[u8; 3]]) -> bool {
        false
    }
}

/// The engine's conversion: a CMYK raster with an embedded profile goes
/// through `paged_color::IccTransform::cmyk_to_linear_rgb` (lcms2 on
/// native, qcms on wasm32), the transform the renderer has always used
/// for CMYK JPEGs. Lab uses `paged_color::lab`.
#[derive(Clone, Copy, Debug, Default)]
pub struct PagedColour;

impl ColourConvert for PagedColour {
    fn cmyk_to_srgb(&self, icc: Option<&[u8]>, cmyk: &[[u8; 4]], rgb: &mut [[u8; 3]]) -> bool {
        let Some(profile) = icc else {
            return false;
        };
        match paged_color::IccTransform::cmyk_to_linear_rgb(profile) {
            Ok(xform) => {
                xform.cmyk_bytes_to_rgb_bytes(cmyk, rgb);
                true
            }
            Err(err) => {
                tracing::warn!(error = %err, "CMYK raster's ICC profile rejected; using naive");
                false
            }
        }
    }

    fn lab_to_srgb(&self, _: Option<&[u8]>, lab: &[[f32; 3]], rgb: &mut [[u8; 3]]) -> bool {
        lab_math(lab, rgb);
        true
    }
}

fn lab_math(lab: &[[f32; 3]], rgb: &mut [[u8; 3]]) {
    for (src, dst) in lab.iter().zip(rgb.iter_mut()) {
        let e = paged_color::lab::lab_d50_to_srgb_encoded(src[0], src[1], src[2]);
        *dst = [q(e[0]), q(e[1]), q(e[2])];
    }
}

/// The naive CMYK to RGB `image` applies to CMYK TIFF (truncating), so a
/// profile-less CMYK TIFF renders as it did before this crate.
fn naive_cmyk(cmyk: &[[u8; 4]], rgb: &mut [[u8; 3]]) {
    for (s, d) in cmyk.iter().zip(rgb.iter_mut()) {
        let kf = 1. - f32::from(s[3]) / 255.;
        *d = [
            ((255. - f32::from(s[0])) * kf) as u8,
            ((255. - f32::from(s[1])) * kf) as u8,
            ((255. - f32::from(s[2])) * kf) as u8,
        ];
    }
}

fn q(v: f32) -> u8 {
    (v.clamp(0.0, 1.0) * 255.0).round() as u8
}

/// Pixels per conversion batch: bounds the scratch buffers.
const CHUNK: usize = 4096;

/// Convert a decoded raster to straight-alpha sRGB bytes. Associated
/// alpha is divided out first, in the source colour space.
pub fn to_rgba8(img: &RasterImage, conv: &dyn ColourConvert) -> Result<Rgba8> {
    let n = img.width as usize * img.height as usize;
    let ch = img.channels();
    if img.data.len() != n * ch {
        return Err(Error::Malformed {
            format: img.info.format,
            detail: format!(
                "{} samples for {}x{} at {ch} per pixel",
                img.data.len(),
                img.width,
                img.height
            ),
        });
    }
    let has_alpha = img.alpha != Alpha::None;
    let premultiplied = img.alpha == Alpha::Associated;
    let colour = img.model.colour_channels();
    let icc = img.info.icc.as_deref();
    let mut out = vec![0u8; n * 4];

    // The common case, copied straight.
    if let (Samples::U8(src), false, ColorModel::Rgb | ColorModel::Gray) =
        (&img.data, premultiplied, img.model)
    {
        for (px, dst) in src.chunks_exact(ch).zip(out.as_chunks_mut::<4>().0) {
            let a = if has_alpha { px[ch - 1] } else { 255 };
            *dst = match img.model {
                ColorModel::Gray => [px[0], px[0], px[0], a],
                _ => [px[0], px[1], px[2], a],
            };
        }
        return Ok(Rgba8 {
            width: img.width,
            height: img.height,
            data: out,
        });
    }

    // Sample `c` of pixel `p`, alpha divided out.
    let pixel = |p: usize, values: &mut [f32; 5]| -> f32 {
        let base = p * ch;
        let a = if has_alpha {
            img.data.unit(base + ch - 1)
        } else {
            1.0
        };
        for (c, v) in values.iter_mut().enumerate().take(colour) {
            let raw = img.data.unit(base + c);
            *v = if premultiplied {
                if a > 0.0 {
                    raw / a
                } else {
                    0.0
                }
            } else {
                raw
            };
        }
        a
    };

    match img.model {
        ColorModel::Gray | ColorModel::Rgb => {
            // Scene-linear floats (Radiance, OpenEXR) are clipped at 1 and
            // sRGB-encoded: a display-referred default without tone mapping.
            let linear = img.info.format.is_scene_linear() && matches!(img.data, Samples::F32(_));
            let mut v = [0.0f32; 5];
            for (p, dst) in out.as_chunks_mut::<4>().0.iter_mut().enumerate() {
                let a = pixel(p, &mut v);
                if linear {
                    v.iter_mut()
                        .take(colour)
                        .for_each(|s| *s = crate::dng::srgb_encode(s.clamp(0.0, 1.0)));
                }
                *dst = if colour == 1 {
                    let g = q(v[0]);
                    [g, g, g, q(a)]
                } else {
                    [q(v[0]), q(v[1]), q(v[2]), q(a)]
                };
            }
        }
        ColorModel::Cmyk => {
            let mut cmyk = vec![[0u8; 4]; CHUNK];
            let mut rgb = vec![[0u8; 3]; CHUNK];
            let mut managed: Option<bool> = None;
            let mut v = [0.0f32; 5];
            for start in (0..n).step_by(CHUNK) {
                let len = CHUNK.min(n - start);
                for i in 0..len {
                    let a = pixel(start + i, &mut v);
                    cmyk[i] = [q(v[0]), q(v[1]), q(v[2]), q(v[3])];
                    out[(start + i) * 4 + 3] = q(a);
                }
                let done =
                    managed != Some(false) && conv.cmyk_to_srgb(icc, &cmyk[..len], &mut rgb[..len]);
                if managed.is_none() {
                    managed = Some(done);
                }
                if !done {
                    naive_cmyk(&cmyk[..len], &mut rgb[..len]);
                }
                for i in 0..len {
                    out[(start + i) * 4..(start + i) * 4 + 3].copy_from_slice(&rgb[i]);
                }
            }
        }
        ColorModel::Lab => {
            let Samples::F32(_) = img.data else {
                return Err(Error::Malformed {
                    format: img.info.format,
                    detail: "Lab samples must be floats".into(),
                });
            };
            let mut lab = vec![[0.0f32; 3]; CHUNK];
            let mut rgb = vec![[0u8; 3]; CHUNK];
            let mut v = [0.0f32; 5];
            for start in (0..n).step_by(CHUNK) {
                let len = CHUNK.min(n - start);
                for i in 0..len {
                    let a = pixel(start + i, &mut v);
                    lab[i] = [v[0], v[1], v[2]];
                    out[(start + i) * 4 + 3] = q(a);
                }
                if !conv.lab_to_srgb(icc, &lab[..len], &mut rgb[..len]) {
                    lab_math(&lab[..len], &mut rgb[..len]);
                }
                for i in 0..len {
                    out[(start + i) * 4..(start + i) * 4 + 3].copy_from_slice(&rgb[i]);
                }
            }
        }
        ColorModel::Palette | ColorModel::YCbCr => {
            return Err(Error::Malformed {
                format: img.info.format,
                detail: format!(
                    "{:?} samples reach to_rgba8 only expanded to RGB",
                    img.model
                ),
            });
        }
    }
    Ok(Rgba8 {
        width: img.width,
        height: img.height,
        data: out,
    })
}
