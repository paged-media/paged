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

//! Images and stencil masks with data through each decode filter.

use crate::{eps_bytes, run};
use paged_ps::{Element, Image, Options, Pixels};

/// A 2 × 2 RGB image: red, green / blue, white.
const RGB: [u8; 12] = [255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255];

fn hex(b: &[u8]) -> String {
    b.iter().map(|v| format!("{v:02x}")).collect::<String>() + ">"
}

fn a85(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    for chunk in data.chunks(4) {
        let mut b = [0u8; 4];
        b[..chunk.len()].copy_from_slice(chunk);
        let mut v = u32::from_be_bytes(b);
        if v == 0 && chunk.len() == 4 {
            out.push(b'z');
            continue;
        }
        let mut g = [0u8; 5];
        for i in (0..5).rev() {
            g[i] = (v % 85) as u8 + b'!';
            v /= 85;
        }
        out.extend_from_slice(&g[..chunk.len() + 1]);
    }
    out.extend_from_slice(b"~>");
    out
}

fn run_length(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    for chunk in data.chunks(128) {
        out.push((chunk.len() - 1) as u8);
        out.extend_from_slice(chunk);
    }
    out.push(128);
    out
}

fn flate(data: &[u8]) -> Vec<u8> {
    use std::io::Write as _;
    let mut z = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
    z.write_all(data).unwrap();
    z.finish().unwrap()
}

fn lzw(data: &[u8]) -> Vec<u8> {
    weezl::encode::Encoder::with_tiff_size_switch(weezl::BitOrder::Msb, 8)
        .encode(data)
        .unwrap()
}

fn image_of(art: &paged_ps::Art) -> &Image {
    art.elements
        .iter()
        .find_map(|e| match e {
            Element::Image(i) => Some(i),
            _ => None,
        })
        .expect("an image")
}

/// The dictionary-form image of `RGB` reading `filters` (applied to
/// currentfile in order) and the encoded data after it.
fn through(filters: &[&str], data: &[u8]) -> paged_ps::Art {
    let chain: String = filters.iter().map(|f| format!(" /{f} filter")).collect();
    let mut body = format!(
        "/DeviceRGB setcolorspace 10 10 translate 20 20 scale
         << /ImageType 1 /Width 2 /Height 2 /BitsPerComponent 8 /Decode [0 1 0 1 0 1]
            /ImageMatrix [2 0 0 -2 0 2] /DataSource currentfile{chain} >> image\n"
    )
    .into_bytes();
    body.extend_from_slice(data);
    body.extend_from_slice(b"\n0 0 1 1 rectfill\n");
    paged_ps::interpret(&eps_bytes(&body), &Options::default()).unwrap()
}

#[test]
fn an_image_reads_its_data_through_each_filter__feat__images_graphics_eps_postscript() {
    let cases: Vec<(Vec<&str>, Vec<u8>)> = vec![
        (vec!["ASCIIHexDecode"], hex(&RGB).into_bytes()),
        (vec!["ASCII85Decode"], a85(&RGB)),
        (
            vec!["ASCII85Decode", "RunLengthDecode"],
            a85(&run_length(&RGB)),
        ),
        (vec!["ASCII85Decode", "LZWDecode"], a85(&lzw(&RGB))),
        (vec!["ASCII85Decode", "FlateDecode"], a85(&flate(&RGB))),
        // Binary straight from the file.
        (vec!["FlateDecode"], flate(&RGB)),
    ];
    for (filters, data) in cases {
        let art = through(&filters, &data);
        let img = image_of(&art);
        assert_eq!((img.width, img.height), (2, 2), "{filters:?}");
        assert_eq!(img.pixels, Pixels::Rgb(RGB.to_vec()), "{filters:?}");
        // The program goes on after the data.
        assert_eq!(
            art.elements
                .iter()
                .filter(|e| matches!(e, Element::Fill { .. }))
                .count(),
            1,
            "{filters:?}"
        );
        // ImageMatrix [2 0 0 -2 0 2]: the first row is the top.
        let top_left = img.transform.as_coeffs();
        assert_eq!(top_left, [20.0, 0.0, 0.0, -20.0, 10.0, 30.0], "{filters:?}");
    }
}

#[test]
fn a_jpeg_decodes_through_dctdecode() {
    let mut gray = image::GrayImage::new(8, 8);
    for (x, y, p) in gray.enumerate_pixels_mut() {
        p.0 = [if x < 4 { 0 } else { 255 }];
        let _ = y;
    }
    let mut jpg = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpg, 95)
        .encode_image(&gray)
        .unwrap();
    let mut body = b"/DeviceGray setcolorspace 8 8 scale
        << /ImageType 1 /Width 8 /Height 8 /BitsPerComponent 8 /Decode [0 1]
           /ImageMatrix [8 0 0 -8 0 8] /DataSource currentfile /ASCII85Decode filter /DCTDecode filter >> image\n"
        .to_vec();
    body.extend_from_slice(&a85(&jpg));
    let art = paged_ps::interpret(&eps_bytes(&body), &Options::default()).unwrap();
    let Pixels::Gray(px) = &image_of(&art).pixels else {
        panic!()
    };
    assert!(px[0] < 30 && px[7] > 225, "{:?}", &px[..8]);
}

#[test]
fn operand_forms_procedures_and_colorimage() {
    // Level 1 `image` with a procedure reading hex rows from currentfile.
    let art = run(
        "/row 2 string def 2 2 8 [2 0 0 -2 0 2] {currentfile row readhexstring pop} image
                   00ff
                   ff00",
    );
    assert_eq!(image_of(&art).pixels, Pixels::Gray(vec![0, 255, 255, 0]));
    // colorimage with one procedure per component, called in turn.
    let art = run("/r 1 string def /g 1 string def /b 1 string def
                   1 1 8 [1 0 0 1 0 0] {currentfile r readhexstring pop} {currentfile g readhexstring pop}
                   {currentfile b readhexstring pop} true 3 colorimage
                   10 20 30");
    assert_eq!(image_of(&art).pixels, Pixels::Rgb(vec![0x10, 0x20, 0x30]));
    // 4-bit CMYK from a string; a 1-bit image with a Decode inverting it.
    let art = run("2 1 4 [2 0 0 1 0 0] <f0000000 0f000000> false 4 colorimage");
    assert_eq!(
        image_of(&art).pixels,
        Pixels::Cmyk(vec![255, 0, 0, 0, 0, 0, 0, 0])
    );
    let art = run("/DeviceGray setcolorspace << /ImageType 1 /Width 8 /Height 1 /BitsPerComponent 1 /Decode [1 0]
                   /ImageMatrix [8 0 0 1 0 0] /DataSource <0f> >> image");
    assert_eq!(
        image_of(&art).pixels,
        Pixels::Gray(vec![255, 255, 255, 255, 0, 0, 0, 0])
    );
}

#[test]
fn indexed_and_separation_images_resolve_their_samples() {
    let art = run("[/Indexed /DeviceRGB 1 <0000ff ffff00>] setcolorspace
                   << /ImageType 1 /Width 2 /Height 1 /BitsPerComponent 8 /Decode [0 255]
                      /ImageMatrix [2 0 0 1 0 0] /DataSource <0001> >> image");
    assert_eq!(
        image_of(&art).pixels,
        Pixels::Rgb(vec![0, 0, 255, 255, 255, 0])
    );
    let art = run("[/Separation /Spot /DeviceCMYK {0 exch 0 0}] setcolorspace
                   << /ImageType 1 /Width 2 /Height 1 /BitsPerComponent 8 /Decode [0 1]
                      /ImageMatrix [2 0 0 1 0 0] /DataSource <00ff> >> image");
    assert_eq!(
        image_of(&art).pixels,
        Pixels::Cmyk(vec![0, 0, 0, 0, 0, 255, 0, 0])
    );
}

#[test]
fn imagemask_paints_the_current_colour_where_the_mask_says() {
    let art = run("1 0 0 setrgbcolor 4 1 true [4 0 0 1 0 0] <a0> imagemask");
    let img = image_of(&art);
    assert_eq!(img.alpha.as_deref(), Some(&[255, 0, 255, 0][..]));
    assert_eq!(img.pixels, Pixels::Rgb([255, 0, 0].repeat(4)));
    let art = run("0 setgray << /ImageType 1 /Width 4 /Height 1 /Decode [0 1] /ImageMatrix [4 0 0 1 0 0] /DataSource <a0> >> imagemask");
    assert_eq!(image_of(&art).alpha.as_deref(), Some(&[0, 255, 0, 255][..]));
}

#[test]
fn a_masked_image_type_4_drops_its_key_colour() {
    let art = run("/DeviceGray setcolorspace << /ImageType 4 /Width 3 /Height 1 /BitsPerComponent 8 /MaskColor [0 10]
                   /ImageMatrix [3 0 0 1 0 0] /DataSource <05ff0a> >> image");
    assert_eq!(image_of(&art).alpha.as_deref(), Some(&[0, 255, 0][..]));
}
