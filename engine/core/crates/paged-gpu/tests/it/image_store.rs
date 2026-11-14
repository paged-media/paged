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
#![cfg(feature = "cpu")]

//! Engine ADR 1311 — the decoded-picture store. A lazy picture (encoded
//! bytes, the size it is placed at) is decoded at the level its draw needs,
//! once per level while it is held; a picture the build decoded is drawn
//! at level 0; the store keeps to its budget, the oldest draw first.

use paged_compose::Transform as XF;
use paged_compose::{Color, DecodedImage, DisplayCommand as Cmd, DisplayList, ImageId};
use paged_gpu::image_store::{self, level_for};
use paged_gpu::{rasterize, RasterOptions};

/// A `w × h` JPEG of a horizontal ramp.
fn jpeg(w: u32, h: u32) -> Vec<u8> {
    use image::ImageEncoder;
    let img = image::RgbImage::from_fn(w, h, |x, _| image::Rgb([(x * 255 / w) as u8, 40, 200]));
    let mut out = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 90)
        .write_image(&img, w, h, image::ExtendedColorType::Rgb8)
        .unwrap();
    out
}

/// One page, `side` pt square, showing `img` over all of it.
fn page(img: DecodedImage, side: f32) -> DisplayList {
    let mut list = DisplayList::new();
    let id: ImageId = list.push_image(img);
    list.push(Cmd::Image {
        image_id: id,
        transform: XF([side, 0.0, 0.0, side, 0.0, 0.0]),
    });
    list
}

fn draw(list: &DisplayList, side: f32, dpi: f32) -> image::RgbaImage {
    let mut opts = RasterOptions::new(side, side);
    opts.dpi = dpi;
    opts.background = Color::WHITE;
    rasterize(list, &opts)
}

fn lazy(bytes: Vec<u8>, w: u32, h: u32) -> DecodedImage {
    DecodedImage {
        width: w,
        height: h,
        encoded: bytes.into(),
        rgba: Vec::new().into(),
        icc: None,
        rendering: None,
    }
}

#[test]
fn a_lazy_picture_is_decoded_at_the_level_its_draw_needs_and_kept() {
    image_store::clear();
    let list = page(lazy(jpeg(512, 512), 512, 512), 100.0);
    let before = image_store::stats();
    // 100 pt at 72 dpi: 100 px across a 512 px picture, level 2 (128 px).
    assert_eq!(level_for(512, 512, 100.0, 100.0), 2);
    let a = draw(&list, 100.0, 72.0);
    let s = image_store::stats();
    assert_eq!(s.decodes - before.decodes, 1);
    assert_eq!(s.entries, 1);
    assert_eq!(
        s.bytes,
        128 * 128 * 4,
        "level 2 is held, not the full picture"
    );
    // The same draw again is served from the store.
    let b = draw(&list, 100.0, 72.0);
    let s2 = image_store::stats();
    assert_eq!(s2.decodes, s.decodes);
    assert!(s2.hits > s.hits);
    assert_eq!(a.as_raw(), b.as_raw());
    // At 4x the picture is drawn from level 0, a second entry.
    let _ = draw(&list, 100.0, 72.0 * 6.0);
    let s3 = image_store::stats();
    assert_eq!(s3.decodes - s2.decodes, 1);
    assert_eq!(s3.bytes, 128 * 128 * 4 + 512 * 512 * 4);
    // The small draw shows the ramp: dark on the left, light on the right.
    let left = a.get_pixel(5, 50).0[0];
    let right = a.get_pixel(94, 50).0[0];
    assert!(left < 40 && right > 215, "{left} .. {right}");
}

#[test]
fn a_picture_the_build_decoded_is_drawn_at_level_zero() {
    image_store::clear();
    let rgba: Vec<u8> = (0..64 * 64).flat_map(|_| [10u8, 20, 30, 255]).collect();
    let eager = DecodedImage {
        width: 64,
        height: 64,
        encoded: Default::default(),
        rgba: rgba.into(),
        icc: None,
        rendering: None,
    };
    let _ = draw(&page(eager, 10.0), 10.0, 72.0);
    assert_eq!(image_store::stats().bytes, 64 * 64 * 4);
}

#[test]
fn the_store_keeps_to_its_budget_dropping_the_oldest_draw_first() {
    image_store::clear();
    image_store::set_budget(3 * 64 * 64 * 4);
    let pictures: Vec<DisplayList> = (0..4)
        .map(|_| page(lazy(jpeg(64, 64), 64, 64), 64.0))
        .collect();
    for p in &pictures {
        let _ = draw(p, 64.0, 72.0);
    }
    let s = image_store::stats();
    assert_eq!(s.entries, 3);
    assert!(s.bytes <= s.budget);
    assert!(s.evictions >= 1);
    // The first picture went: drawing it again decodes it again.
    let decodes = s.decodes;
    let _ = draw(&pictures[0], 64.0, 72.0);
    assert_eq!(image_store::stats().decodes, decodes + 1);
    // A picture larger than the whole budget is drawn and not kept.
    image_store::set_budget(1024);
    let big = draw(&page(lazy(jpeg(64, 64), 64, 64), 64.0), 64.0, 72.0);
    assert_eq!(big.dimensions(), (64, 64));
    let s = image_store::stats();
    assert_eq!(s.entries, 0);
    assert!(s.uncached >= 1);
    image_store::set_budget(image_store::DEFAULT_BUDGET_BYTES);
}
