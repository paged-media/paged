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
//! Engine ADR 1037 — an image frame's filter stack in the renderer: the
//! display density it is evaluated at, its cache key, and the adjusted
//! twin of a decoded picture. The ops themselves are `paged-image-adjust`'s.

use paged_model::RasterOp;

pub use paged_image_adjust::apply_rgba8;

/// The scale a filter stack is evaluated at: 1 (the picture's own pixels)
/// when the build names no display density, else the density's share of
/// them, `px_per_pt · pt_per_px`, rounded UP to a power of two (1, ½, ¼ …)
/// so that zooming does not evaluate the stack again for every step.
pub(super) fn display_scale(px_per_pt: Option<f32>, pt_per_px: f32) -> f32 {
    let Some(density) = px_per_pt else {
        return 1.0;
    };
    let want = density * pt_per_px;
    if !(want.is_finite() && want > 0.0) || want >= 1.0 {
        return 1.0;
    }
    // 2^ceil(log2 want), never below 1/1024.
    (2f32).powi(want.log2().ceil().max(-10.0) as i32)
}

/// The cache key of a picture's adjusted twin: the picture, the stack (its
/// `Debug` form, hashed) and the scale.
pub(super) fn cache_key(picture: &str, ops: &[RasterOp], scale: f32) -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    format!("{ops:?}").hash(&mut h);
    format!("{picture}#adjust:{:016x}@{scale}", h.finish())
}

/// The adjusted twin of a decoded picture at `scale`: decoded (a lazily
/// decoded picture, the wasm32 build's, now), reduced to `scale` of its
/// size with the Lanczos-3 of paged-resample, run through `ops`. Kept
/// RGBA-only (no `encoded` bytes), so every consumer draws and embeds the
/// adjusted pixels; the source's ICC profile stays with them.
pub(super) fn adjust_decoded(
    src: &paged_compose::DecodedImage,
    ops: &[RasterOp],
    scale: f32,
) -> Option<paged_compose::DecodedImage> {
    if src.width == 0 || src.height == 0 {
        return None;
    }
    let tw = ((src.width as f32 * scale).round() as u32).max(1);
    let th = ((src.height as f32 * scale).round() as u32).max(1);
    let decoded;
    let (rgba, bw, bh): (&[u8], u32, u32) = if src.rgba.is_empty() {
        decoded = super::image_decode::decode_image_bytes_with(
            &src.encoded,
            tw.max(th),
            src.rendering.unwrap_or_default(),
        )?;
        (&decoded.rgba, decoded.width, decoded.height)
    } else {
        (&src.rgba, src.width, src.height)
    };
    if rgba.len() != (bw as usize) * (bh as usize) * 4 {
        return None;
    }
    let reduced;
    let (pixels, w, h) = if bw > tw || bh > th {
        reduced =
            paged_resample::resize_rgba8(rgba, bw, bh, tw, th, paged_resample::Filter::Lanczos3)
                .ok()?;
        (reduced.as_slice(), tw, th)
    } else {
        (rgba, bw, bh)
    };
    let eval_scale = w as f32 / src.width as f32;
    let out = apply_rgba8(pixels, w, h, ops, eval_scale);
    Some(paged_compose::DecodedImage {
        width: w,
        height: h,
        encoded: bytes::Bytes::new(),
        rgba: bytes::Bytes::from(out),
        icc: src.icc.clone(),
        rendering: None,
    })
}

#[cfg(test)]
#[allow(non_snake_case)] // `__feat__` suffixes link the cockpit feature row.
mod tests {
    use super::*;

    #[test]
    fn the_display_scale_is_a_power_of_two__feat__images_graphics_image_filter_stack() {
        assert_eq!(display_scale(None, 0.1), 1.0);
        assert_eq!(display_scale(Some(2.0), 1.0), 1.0);
        assert_eq!(display_scale(Some(2.0), 0.24), 0.5);
        assert_eq!(display_scale(Some(2.0), 0.2), 0.5);
        assert_eq!(display_scale(Some(2.0), 0.12), 0.25);
        let ops = [RasterOp::Invert];
        assert_ne!(cache_key("a", &ops, 1.0), cache_key("a", &ops, 0.5));
        assert_ne!(cache_key("a", &ops, 1.0), cache_key("b", &ops, 1.0));
        assert_ne!(
            cache_key("a", &ops, 1.0),
            cache_key("a", &[RasterOp::Blur { radius: 1.0 }], 1.0)
        );
    }

    #[test]
    fn a_picture_is_reduced_before_it_is_adjusted__feat__images_graphics_image_filter_stack() {
        let src = paged_compose::DecodedImage {
            width: 8,
            height: 4,
            encoded: bytes::Bytes::new(),
            rgba: bytes::Bytes::from(vec![200u8; 8 * 4 * 4]),
            icc: None,
            rendering: None,
        };
        let d = adjust_decoded(&src, &[RasterOp::Invert], 0.5).unwrap();
        assert_eq!((d.width, d.height), (4, 2));
        assert!(d.encoded.is_empty());
        assert!(d.rgba.chunks(4).all(|p| p[0] == 55));
    }
}
