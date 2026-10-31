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

//! Image bytes for the image frames a page's images become.

use base64::Engine as _;

/// Tightly packed RGBA8 as PNG bytes: RGB when every pixel is opaque.
pub(super) fn png(width: u32, height: u32, rgba: &[u8]) -> Option<Vec<u8>> {
    let n = width as usize * height as usize;
    if width == 0 || height == 0 || rgba.len() < n * 4 {
        return None;
    }
    let opaque = rgba.as_chunks::<4>().0.iter().take(n).all(|p| p[3] == 255);
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, width, height);
        enc.set_depth(png::BitDepth::Eight);
        let data: Vec<u8> = if opaque {
            enc.set_color(png::ColorType::Rgb);
            rgba.as_chunks::<4>()
                .0
                .iter()
                .take(n)
                .flat_map(|p| [p[0], p[1], p[2]])
                .collect()
        } else {
            enc.set_color(png::ColorType::Rgba);
            rgba[..n * 4].to_vec()
        };
        let mut writer = enc.write_header().ok()?;
        writer.write_image_data(&data).ok()?;
    }
    Some(out)
}

pub(super) fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opaque_pixels_write_rgb_and_translucent_ones_rgba() {
        let opaque = png(1, 1, &[255, 0, 0, 255]).unwrap();
        let clear = png(1, 1, &[255, 0, 0, 128]).unwrap();
        assert_eq!(&opaque[..8], b"\x89PNG\r\n\x1a\n");
        // IHDR's colour type byte: 2 = RGB, 6 = RGBA.
        assert_eq!(opaque[25], 2);
        assert_eq!(clear[25], 6);
        assert!(png(0, 1, &[]).is_none());
    }
}
