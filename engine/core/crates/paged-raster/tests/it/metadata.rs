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

//! ICC, XMP, IPTC, Photoshop resources, layers, resolution and
//! orientation: written, read back, and read from hand-built files.

use paged_raster::{
    decode, encode_tiff, extract_icc, probe, Alpha, ColorModel, DecodeOptions, TiffCompression,
    TiffEncodeOptions,
};

use crate::raw_tiff::{base, write, Page, V};
use crate::support::image;

/// Bytes that look like an ICC header for a CMYK profile (only the
/// signature matters to the tests; nothing parses it).
fn fake_icc(len: usize) -> Vec<u8> {
    let mut icc: Vec<u8> = (0..len).map(|i| (i * 31 % 251) as u8).collect();
    icc[16..20].copy_from_slice(b"CMYK");
    icc[36..40].copy_from_slice(b"acsp");
    icc
}

#[test]
fn icc_xmp_iptc_photoshop_and_resolution_round_trip__feat__images_graphics_tiff_raster() {
    let mut img = image(8, 6, ColorModel::Cmyk, Alpha::None, false, 4);
    let icc = fake_icc(3 * 1024 * 1024 + 7);
    let xmp = br#"<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF/></x:xmpmeta>"#.to_vec();
    let iptc = vec![0x1C, 0x02, 0x05, 0x00, 0x04, b'T', b'e', b's', b't'];
    let irb = b"8BIM\x03\xED\0\0\0\0\0\x10".to_vec();
    img.info.icc = Some(icc.clone());
    img.info.xmp = Some(xmp.clone());
    img.info.iptc = Some(iptc.clone());
    img.info.photoshop_irb = Some(irb.clone());
    img.info.resolution = Some((300.0, 150.5));
    for compression in [TiffCompression::None, TiffCompression::Lzw] {
        let bytes = encode_tiff(
            &img,
            TiffEncodeOptions {
                compression,
                ..Default::default()
            },
        )
        .unwrap();
        let info = probe(&bytes).unwrap();
        assert_eq!(
            info.icc.as_deref(),
            Some(&icc[..]),
            "a 3 MiB profile survives"
        );
        assert_eq!(info.xmp.as_deref(), Some(&xmp[..]));
        assert_eq!(info.iptc.as_deref(), Some(&iptc[..]));
        assert_eq!(info.photoshop_irb.as_deref(), Some(&irb[..]));
        assert_eq!(info.resolution, Some((300.0, 150.5)));
        assert!(!info.has_layers);
        assert_eq!(extract_icc(&bytes).as_deref(), Some(&icc[..]));
        let back = decode(&bytes, DecodeOptions::default()).unwrap();
        assert_eq!(back.info.icc.as_deref(), Some(&icc[..]));
        assert_eq!(back.data, img.data);
    }
}

#[test]
fn no_metadata_reads_as_none() {
    let img = image(3, 3, ColorModel::Gray, Alpha::None, false, 1);
    let bytes = encode_tiff(&img, TiffEncodeOptions::default()).unwrap();
    let info = probe(&bytes).unwrap();
    assert_eq!(info.icc, None);
    assert_eq!(info.xmp, None);
    // `tiff` writes 1/1 with ResolutionUnit none: no physical resolution.
    assert_eq!(info.resolution, None);
    assert_eq!(info.orientation, 1);
    assert_eq!(extract_icc(&bytes), None);
}

#[test]
fn centimetres_orientation_and_layers_from_the_header() {
    let mut tags = base(2, 2, &[8], 1);
    tags.push((282, V::Rational(vec![(118, 1)])));
    tags.push((283, V::Rational(vec![(236, 2)])));
    tags.push((296, V::Short(vec![3])));
    tags.push((274, V::Short(vec![6])));
    tags.push((
        37724,
        V::Undefined(b"Adobe Photoshop Document Data Block\0".to_vec()),
    ));
    let bytes = write(&[Page::strips(tags, vec![vec![1, 2, 3, 4]])], true);
    let info = probe(&bytes).unwrap();
    let (x, y) = info.resolution.unwrap();
    assert!(
        (x - 299.72).abs() < 1e-9 && (y - 299.72).abs() < 1e-9,
        "{x} {y}"
    );
    assert_eq!(info.orientation, 6);
    assert!(info.has_layers);
}
