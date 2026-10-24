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

//! Colour conversion: CMYK with an embedded profile goes through
//! paged-color, CMYK without one renders as `image` rendered it.

use std::cell::RefCell;

use paged_raster::{
    decode, decode_rgba8, encode_tiff, to_rgba8, Alpha, ColorModel, ColourConvert, DecodeOptions,
    Samples, TiffEncodeOptions,
};
use paged_test_resources::{skip, Resource};

use crate::support::image;

#[test]
fn profile_less_cmyk_matches_the_image_crate() {
    let img = image(17, 9, ColorModel::Cmyk, Alpha::None, false, 11);
    let bytes = encode_tiff(&img, TiffEncodeOptions::default()).unwrap();
    let ours = decode_rgba8(&bytes, None).unwrap();
    let theirs = image::load_from_memory(&bytes).unwrap().to_rgba8();
    assert_eq!(ours.data, theirs.into_raw());
}

#[test]
fn an_embedded_cmyk_profile_converts_through_paged_color__feat__images_graphics_tiff_raster() {
    let Some(profile) = paged_color::test_profiles::read_cmyk_profile(env!("CARGO_MANIFEST_DIR"))
    else {
        skip!(
            Resource::Icc,
            "{}",
            paged_color::test_profiles::NO_PROFILE_HINT
        );
    };
    let mut img = image(23, 11, ColorModel::Cmyk, Alpha::None, false, 5);
    img.info.icc = Some(profile.clone());
    let bytes = encode_tiff(&img, TiffEncodeOptions::default()).unwrap();
    let ours = decode_rgba8(&bytes, None).unwrap();

    let Samples::U8(cmyk) = &img.data else {
        unreachable!()
    };
    let src: Vec<[u8; 4]> = cmyk.as_chunks::<4>().0.to_vec();
    let mut rgb = vec![[0u8; 3]; src.len()];
    paged_color::IccTransform::cmyk_to_linear_rgb(&profile)
        .unwrap()
        .cmyk_bytes_to_rgb_bytes(&src, &mut rgb);
    let expect: Vec<u8> = rgb.iter().flat_map(|p| [p[0], p[1], p[2], 255]).collect();
    assert_eq!(ours.data, expect);

    // And it is not the naive conversion.
    let naive = to_rgba8(
        &decode(&bytes, DecodeOptions::default()).unwrap(),
        &paged_raster::NaiveColour,
    )
    .unwrap();
    assert_ne!(naive.data, expect);
}

/// A converter that records what it was handed.
#[derive(Default)]
struct Recorder {
    icc: RefCell<Option<Vec<u8>>>,
    pixels: RefCell<usize>,
}

impl ColourConvert for Recorder {
    fn cmyk_to_srgb(&self, icc: Option<&[u8]>, cmyk: &[[u8; 4]], rgb: &mut [[u8; 3]]) -> bool {
        *self.icc.borrow_mut() = icc.map(<[u8]>::to_vec);
        *self.pixels.borrow_mut() += cmyk.len();
        rgb.iter_mut().for_each(|p| *p = [1, 2, 3]);
        true
    }

    fn lab_to_srgb(&self, _: Option<&[u8]>, _: &[[f32; 3]], _: &mut [[u8; 3]]) -> bool {
        false
    }
}

#[test]
fn the_converter_receives_the_embedded_profile_and_every_pixel() {
    let mut img = image(70, 70, ColorModel::Cmyk, Alpha::Unassociated, false, 2);
    img.info.icc = Some(b"profile bytes".to_vec());
    let bytes = encode_tiff(&img, TiffEncodeOptions::default()).unwrap();
    let decoded = decode(&bytes, DecodeOptions::default()).unwrap();
    let rec = Recorder::default();
    let rgba = to_rgba8(&decoded, &rec).unwrap();
    assert_eq!(rec.icc.borrow().as_deref(), Some(&b"profile bytes"[..]));
    assert_eq!(*rec.pixels.borrow(), 70 * 70, "every pixel, in batches");
    let Samples::U8(src) = &img.data else {
        unreachable!()
    };
    assert_eq!(&rgba.data[..4], &[1, 2, 3, src[4]], "alpha passes through");
}
