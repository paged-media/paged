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

//! AVIF still images: the container through `avif-parse`, the AV1
//! payload through `rav1d` (the Rust port of dav1d; the `sqzer-rav1d`
//! build of it, which compiles for wasm32 and has a safe API), on one
//! thread, without assembly.
//!
//! The colour and the alpha item decode to 8 bits (8-bit streams) or 16
//! bits (10 and 12-bit streams); YUV converts to RGB with the stream's
//! matrix coefficients (BT.601 when unspecified, BT.709, BT.2020, or
//! identity for GBR) and range, chroma upsampled by replication. The
//! values are taken as sRGB: other primaries and transfer functions (PQ,
//! HLG) and a container ICC profile are not converted. A sequence
//! (`avis`) decodes its first frame.

use crate::{DecodeOptions, Error, Format, RasterImage, RasterInfo, Result};

#[cfg(feature = "avif")]
mod imp {
    use super::*;
    use crate::{Alpha, ColorModel, SampleFormat, Samples};
    use rav1d::pixel::{MatrixCoefficients, YUVRange};
    use rav1d::{Decoder, Picture, PixelLayout, PlanarImageComponent, Rav1dError, Settings};

    fn malformed(detail: impl Into<String>) -> Error {
        Error::Malformed {
            format: Format::Avif,
            detail: detail.into(),
        }
    }

    fn av1(err: Rav1dError) -> Error {
        malformed(format!("AV1: {err:?}"))
    }

    /// One AV1 temporal unit to its picture.
    fn picture(data: &[u8]) -> Result<Picture> {
        let mut settings = Settings::new();
        // wasm32 has no threads; a still image gains little from them.
        settings.set_n_threads(1);
        settings.set_max_frame_delay(1);
        settings.set_apply_grain(true);
        let mut dec = Decoder::with_settings(&settings).map_err(av1)?;
        match dec.send_data(data.to_vec().into_boxed_slice(), None, None, None) {
            Ok(()) | Err(Rav1dError::TryAgain) => {}
            Err(e) => return Err(av1(e)),
        }
        for _ in 0..16 {
            match dec.get_picture() {
                Ok(p) => return Ok(p),
                Err(Rav1dError::TryAgain) => match dec.send_pending_data() {
                    Ok(()) | Err(Rav1dError::TryAgain) => {}
                    Err(e) => return Err(av1(e)),
                },
                Err(e) => return Err(av1(e)),
            }
        }
        dec.flush();
        dec.get_picture()
            .map_err(|_| malformed("the AV1 payload produced no picture"))
    }

    /// Sample `x` of row `y` of a plane, at the picture's depth.
    fn sample(plane: &[u8], stride: usize, wide: bool, x: usize, y: usize) -> u32 {
        if wide {
            let at = y * stride + x * 2;
            u32::from(u16::from_le_bytes([plane[at], plane[at + 1]]))
        } else {
            u32::from(plane[y * stride + x])
        }
    }

    struct Plane<'p> {
        data: &'p [u8],
        stride: usize,
    }

    fn plane(p: &Picture, c: PlanarImageComponent) -> Plane<'_> {
        Plane {
            data: p.plane(c),
            stride: p.stride(c) as usize,
        }
    }

    /// The image as interleaved full-scale samples: RGB, or gray for a
    /// monochrome stream, `max` the full scale.
    fn pixels(p: &Picture) -> Result<(Vec<u32>, bool, u32)> {
        let (w, h) = (p.width() as usize, p.height() as usize);
        let bpc = p.bit_depth() as u32;
        if !(8..=12).contains(&bpc) {
            return Err(Error::Unsupported {
                format: Format::Avif,
                what: format!("{bpc}-bit AV1"),
            });
        }
        let wide = bpc > 8;
        let max = (1u32 << bpc) - 1;
        let s = 1u32 << (bpc - 8);
        let full = p.color_range() == YUVRange::Full;
        let y_plane = plane(p, PlanarImageComponent::Y);
        let need = |pl: &Plane, rows: usize, cols: usize| {
            pl.data.len() >= (rows.saturating_sub(1)) * pl.stride + cols * (1 + usize::from(wide))
        };
        if !need(&y_plane, h, w) {
            return Err(malformed("a luma plane shorter than the picture"));
        }
        let luma = |v: u32| -> f32 {
            if full {
                v as f32 / max as f32
            } else {
                (v as f32 - 16.0 * s as f32) / (219.0 * s as f32)
            }
        };
        let layout = p.pixel_layout();
        if layout == PixelLayout::I400 {
            let mut out = Vec::with_capacity(w * h);
            for y in 0..h {
                for x in 0..w {
                    let v = luma(sample(y_plane.data, y_plane.stride, wide, x, y));
                    out.push((v.clamp(0.0, 1.0) * max as f32).round() as u32);
                }
            }
            return Ok((out, true, max));
        }
        let (sx, sy) = match layout {
            PixelLayout::I420 => (1, 1),
            PixelLayout::I422 => (1, 0),
            _ => (0, 0),
        };
        let (u, v) = (
            plane(p, PlanarImageComponent::U),
            plane(p, PlanarImageComponent::V),
        );
        let (cw, ch) = ((w + sx) >> sx, (h + sy) >> sy);
        if !need(&u, ch, cw) || !need(&v, ch, cw) {
            return Err(malformed("a chroma plane shorter than the picture"));
        }
        let chroma = |c: u32| -> f32 {
            let mid = (max + 1) as f32 / 2.0;
            if full {
                (c as f32 - mid) / max as f32
            } else {
                (c as f32 - 128.0 * s as f32) / (224.0 * s as f32)
            }
        };
        let identity = p.matrix_coefficients() == MatrixCoefficients::Identity;
        let (kr, kb) = match p.matrix_coefficients() {
            MatrixCoefficients::BT709 => (0.2126f32, 0.0722f32),
            MatrixCoefficients::BT2020NonConstantLuminance
            | MatrixCoefficients::BT2020ConstantLuminance => (0.2627, 0.0593),
            MatrixCoefficients::ST240M => (0.212, 0.087),
            MatrixCoefficients::BT470M => (0.30, 0.11),
            _ => (0.299, 0.114),
        };
        let kg = 1.0 - kr - kb;
        let q = |v: f32| (v.clamp(0.0, 1.0) * max as f32).round() as u32;
        let mut out = Vec::with_capacity(w * h * 3);
        for y in 0..h {
            for x in 0..w {
                let yy = sample(y_plane.data, y_plane.stride, wide, x, y);
                let cu = sample(u.data, u.stride, wide, x >> sx, y >> sy);
                let cv = sample(v.data, v.stride, wide, x >> sx, y >> sy);
                if identity {
                    // GBR: Y is green, U blue, V red.
                    out.extend_from_slice(&[cv, yy, cu]);
                    continue;
                }
                let (l, cb, cr) = (luma(yy), chroma(cu), chroma(cv));
                let r = l + (2.0 - 2.0 * kr) * cr;
                let b = l + (2.0 - 2.0 * kb) * cb;
                let g = (l - kr * r - kb * b) / kg;
                out.extend_from_slice(&[q(r), q(g), q(b)]);
            }
        }
        Ok((out, false, max))
    }

    fn to_samples(v: Vec<u32>, max: u32) -> Samples {
        if max == 255 {
            Samples::U8(v.into_iter().map(|s| s as u8).collect())
        } else {
            Samples::U16(
                v.into_iter()
                    .map(|s| ((s * 65535 + max / 2) / max) as u16)
                    .collect(),
            )
        }
    }

    /// Header facts from the container and the AV1 sequence header; the
    /// size is the sequence's maximum frame size, a still image's size.
    pub(super) fn probe(bytes: &[u8]) -> Result<RasterInfo> {
        let avif = avif_parse::read_avif(&mut &bytes[..]).map_err(|e| malformed(e.to_string()))?;
        let meta = avif
            .primary_item_metadata()
            .map_err(|e| malformed(e.to_string()))?;
        let alpha = match avif.alpha_item {
            None => Alpha::None,
            Some(_) if avif.premultiplied_alpha => Alpha::Associated,
            Some(_) => Alpha::Unassociated,
        };
        let colour = if meta.monochrome { 1 } else { 3 };
        Ok(info(
            meta.max_frame_width.get(),
            meta.max_frame_height.get(),
            colour,
            alpha,
            u16::from(meta.bit_depth),
        ))
    }

    fn info(w: u32, h: u32, colour: usize, alpha: Alpha, bits: u16) -> RasterInfo {
        RasterInfo {
            format: Format::Avif,
            width: w,
            height: h,
            channels: (colour + usize::from(alpha != Alpha::None)) as u16,
            bits_per_sample: bits,
            sample_format: SampleFormat::UInt,
            color_model: if colour == 1 {
                ColorModel::Gray
            } else {
                ColorModel::Rgb
            },
            alpha,
            icc: None,
            xmp: None,
            iptc: None,
            exif: None,
            photoshop_irb: None,
            has_layers: false,
            layer_count: Some(0),
            resolution: None,
            orientation: 1,
            page_count: 1,
        }
    }

    pub(super) fn decode(bytes: &[u8]) -> Result<RasterImage> {
        let avif = avif_parse::read_avif(&mut &bytes[..]).map_err(|e| malformed(e.to_string()))?;
        let colour = picture(&avif.primary_item)?;
        let (w, h) = (colour.width(), colour.height());
        let (rgb, gray, max) = pixels(&colour)?;
        let colour_channels = if gray { 1 } else { 3 };
        let mut alpha = Alpha::None;
        let mut data = rgb;
        if let Some(item) = avif.alpha_item.as_deref() {
            let a = picture(item)?;
            if (a.width(), a.height()) != (w, h) {
                return Err(malformed("an alpha item of another size"));
            }
            let (av, _, amax) = pixels(&a)?;
            // Alpha is the luma of a monochrome stream.
            let step = av.len() / (w as usize * h as usize).max(1);
            let mut merged =
                Vec::with_capacity(data.len() / colour_channels * (colour_channels + 1));
            for (i, px) in data.chunks_exact(colour_channels).enumerate() {
                merged.extend_from_slice(px);
                let a = av[i * step];
                merged.push(if amax == max { a } else { a * max / amax });
            }
            data = merged;
            alpha = if avif.premultiplied_alpha {
                Alpha::Associated
            } else {
                Alpha::Unassociated
            };
        }
        let model = if gray {
            ColorModel::Gray
        } else {
            ColorModel::Rgb
        };
        Ok(RasterImage {
            info: info(w, h, colour_channels, alpha, colour.bit_depth() as u16),
            width: w,
            height: h,
            model,
            alpha,
            data: to_samples(data, max),
        })
    }
}

fn single_page(page: usize) -> Result<()> {
    if page == 0 {
        Ok(())
    } else {
        Err(Error::PageOutOfRange { page, count: 1 })
    }
}

#[cfg(feature = "avif")]
pub(crate) fn probe(bytes: &[u8], page: usize) -> Result<RasterInfo> {
    single_page(page)?;
    imp::probe(bytes)
}

#[cfg(feature = "avif")]
pub(crate) fn decode(bytes: &[u8], opts: DecodeOptions) -> Result<RasterImage> {
    single_page(opts.page)?;
    let img = imp::decode(bytes)?;
    Ok(crate::shrink_image(img, opts.max_dim))
}

#[cfg(not(feature = "avif"))]
pub(crate) fn probe(_: &[u8], page: usize) -> Result<RasterInfo> {
    single_page(page)?;
    Err(missing())
}

#[cfg(not(feature = "avif"))]
pub(crate) fn decode(_: &[u8], opts: DecodeOptions) -> Result<RasterImage> {
    single_page(opts.page)?;
    Err(missing())
}

#[cfg(not(feature = "avif"))]
fn missing() -> Error {
    Error::Unsupported {
        format: Format::Avif,
        what: "AVIF (this build has no AVIF decoder: the `avif` feature is off)".into(),
    }
}
