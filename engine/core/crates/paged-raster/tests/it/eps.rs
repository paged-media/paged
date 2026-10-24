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

//! EPS previews, built in the test: a DOS EPS binary file whose TIFF
//! preview `encode_tiff` writes, and EPSI files with hexadecimal previews.

use paged_raster::{
    decode, decode_rgba8, encode_tiff, eps_bounding_box, probe, sniff, Alpha, ColorModel,
    DecodeOptions, Error, Format, RasterImage, Samples, TiffEncodeOptions,
};

use crate::support;

/// A DOS EPS binary file of `ps`, a metafile of `wmf` and a TIFF.
pub fn dos_eps(ps: &[u8], wmf: &[u8], tiff: &[u8]) -> Vec<u8> {
    let mut out = vec![0xC5, 0xD0, 0xD3, 0xC6];
    let mut at = 30u32;
    for len in [ps.len(), wmf.len(), tiff.len()] {
        let len = len as u32;
        out.extend(if len == 0 { 0 } else { at }.to_le_bytes());
        out.extend(len.to_le_bytes());
        at += len;
    }
    out.extend([0xFF, 0xFF]);
    out.extend(ps);
    out.extend(wmf);
    out.extend(tiff);
    out
}

const PS: &[u8] = b"%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 36 18\n%%EndComments\n0 0 moveto\n";

fn preview_tiff() -> (RasterImage, Vec<u8>) {
    let mut img = support::image(72, 36, ColorModel::Rgb, Alpha::None, false, 3);
    img.info.width = 72;
    img.info.height = 36;
    let tiff = encode_tiff(&img, TiffEncodeOptions::default()).unwrap();
    (img, tiff)
}

#[test]
fn dos_eps_draws_its_tiff_preview__feat__images_graphics_format_extensions() {
    let (img, tiff) = preview_tiff();
    let eps = dos_eps(PS, &[], &tiff);
    assert_eq!(sniff(&eps), Some(Format::Eps));
    let info = probe(&eps).unwrap();
    assert_eq!(
        (info.format, info.width, info.height),
        (Format::Eps, 72, 36)
    );
    // 72 pixels over 36 points: 144 ppi.
    assert_eq!(info.resolution, Some((144.0, 144.0)));
    assert_eq!(eps_bounding_box(&eps), Some([0.0, 0.0, 36.0, 18.0]));
    let decoded = decode(&eps, DecodeOptions::default()).unwrap();
    assert_eq!(decoded.data, img.data);
    assert_eq!(
        decode_rgba8(&eps, None).unwrap().data,
        decode_rgba8(&tiff, None).unwrap().data
    );
    let small = decode_rgba8(&eps, Some(36)).unwrap();
    assert_eq!((small.width, small.height), (36, 18));
}

/// An EPSI file with a `w` x `h` preview of `depth` bits from `rows`.
fn epsi(w: u32, h: u32, depth: u32, rows: &[Vec<u8>]) -> Vec<u8> {
    let mut s = String::from("%!PS-Adobe-3.0 EPSF-3.0\n%%HiResBoundingBox: 10 20 14.5 22\n");
    s.push_str("%%BoundingBox: 10 20 15 22\n%%EndComments\n");
    s.push_str(&format!("%%BeginPreview: {w} {h} {depth} {}\n", rows.len()));
    for r in rows {
        s.push('%');
        for b in r {
            s.push_str(&format!("{b:02X}"));
        }
        s.push('\n');
    }
    s.push_str("%%EndPreview\nshowpage\n");
    s.into_bytes()
}

#[test]
fn epsi_previews_read_at_every_depth() {
    // 1 bit, 0 white: 0b1010_0000 -> black, white, black, white.
    let one = epsi(4, 2, 1, &[vec![0xA0], vec![0x50]]);
    assert_eq!(sniff(&one), Some(Format::Eps));
    let img = decode(&one, DecodeOptions::default()).unwrap();
    assert_eq!((img.width, img.height, img.model), (4, 2, ColorModel::Gray));
    assert_eq!(img.data, Samples::U8(vec![0, 255, 0, 255, 255, 0, 255, 0]));
    // The HiRes box wins: 4 pixels over 4.5 points.
    assert_eq!(eps_bounding_box(&one), Some([10.0, 20.0, 14.5, 22.0]));
    let info = probe(&one).unwrap();
    assert_eq!(info.bits_per_sample, 1);
    assert_eq!(info.resolution, Some((4.0 * 72.0 / 4.5, 2.0 * 72.0 / 2.0)));

    // 2 bits: levels 0..3 -> 255, 170, 85, 0.
    let two = epsi(4, 1, 2, &[vec![0b0001_1011]]);
    assert_eq!(
        decode(&two, DecodeOptions::default()).unwrap().data,
        Samples::U8(vec![255, 170, 85, 0])
    );
    // 4 bits, a row padded to a byte.
    let four = epsi(3, 1, 4, &[vec![0x0F, 0x80]]);
    assert_eq!(
        decode(&four, DecodeOptions::default()).unwrap().data,
        Samples::U8(vec![255, 0, 119])
    );
    // 8 bits, data split over lines anyhow.
    let mut eight = String::from_utf8(epsi(2, 1, 8, &[vec![0x00]])).unwrap();
    eight = eight.replace("%00\n", "%0\n% 0 4\n%0\n");
    let img = decode(eight.as_bytes(), DecodeOptions::default()).unwrap();
    assert_eq!(img.data, Samples::U8(vec![255, 191]));
}

#[test]
fn an_eps_without_a_readable_preview_is_refused_by_name() {
    let only_wmf = dos_eps(PS, b"\x01\x00\x09\x00", &[]);
    match decode(&only_wmf, DecodeOptions::default()) {
        Err(Error::Unsupported { format, what }) => {
            assert_eq!(format, Format::Eps);
            assert!(what.contains("Windows metafile"), "{what}");
        }
        other => panic!("{other:?}"),
    }
    match probe(PS) {
        Err(Error::Unsupported { what, .. }) => assert!(what.contains("without a preview")),
        other => panic!("{other:?}"),
    }
    let short = epsi(4, 4, 1, &[vec![0xA0]]);
    assert!(matches!(
        decode(&short, DecodeOptions::default()),
        Err(Error::Malformed { .. })
    ));
    assert_eq!(
        eps_bounding_box(b"%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: (atend)\n"),
        None
    );
    assert_eq!(eps_bounding_box(b"not an eps"), None);
}
