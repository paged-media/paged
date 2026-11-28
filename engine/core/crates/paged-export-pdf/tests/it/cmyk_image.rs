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

//! A placed CMYK picture that is not a JPEG (a TIFF) is embedded with
//! its own ink values, as a CMYK image: the RGB the renderer decoded for
//! the screen is not written back and re-separated by the printer, which
//! would turn a pure black into a four-colour one.

use std::io::Write;

use paged_export_pdf::{export_pdf, ExportInkSettings, ExportInput, ExportOptions, ExportProfiles};
use paged_raster::{Alpha, ColorModel, RasterImage, RasterInfo, Samples};
use paged_renderer::pipeline::{self, FontTable, PipelineOptions};
use paged_renderer::BytesResolver;

const W: u32 = 6;
const H: u32 = 4;

fn package() -> Vec<u8> {
    use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};
    let mut zip = ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    let deflated = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    zip.start_file("mimetype", stored).unwrap();
    zip.write_all(b"application/vnd.adobe.indesign-idml-package")
        .unwrap();
    zip.start_file("designmap.xml", deflated).unwrap();
    zip.write_all(
        br#"<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">
  <idPkg:Spread src="Spreads/Spread_sp1.xml"/>
</Document>"#,
    )
    .unwrap();
    zip.start_file("Spreads/Spread_sp1.xml", deflated).unwrap();
    zip.write_all(
        br#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Spread xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">
  <Spread Self="sp1">
    <Page Self="p1" GeometricBounds="0 0 200 200"/>
    <Rectangle Self="r1" GeometricBounds="40 40 160 160" StrokeWeight="0">
      <FrameFittingOption LeftCrop="0" TopCrop="0" RightCrop="0" BottomCrop="0"/>
      <Image Self="i1" LinkResourceURI="picture.tif"/>
    </Rectangle>
  </Spread>
</idPkg:Spread>"#,
    )
    .unwrap();
    zip.finish().unwrap().into_inner()
}

/// The picture's ink values: a pure black first, then a pattern.
fn inks(alpha: bool) -> Vec<u8> {
    let channels = if alpha { 5 } else { 4 };
    let mut out = Vec::new();
    for i in 0..(W * H) {
        let px: [u8; 5] = if i == 0 {
            [0, 0, 0, 255, 255]
        } else {
            [
                (i * 11 % 256) as u8,
                (i * 29 % 256) as u8,
                (i * 53 % 256) as u8,
                (i * 7 % 256) as u8,
                if i % 2 == 0 { 255 } else { 96 },
            ]
        };
        out.extend_from_slice(&px[..channels]);
    }
    out
}

fn tiff(alpha: bool) -> Vec<u8> {
    let alpha_kind = if alpha {
        Alpha::Unassociated
    } else {
        Alpha::None
    };
    let info = RasterInfo {
        format: paged_raster::Format::Tiff,
        width: W,
        height: H,
        channels: if alpha { 5 } else { 4 },
        bits_per_sample: 8,
        sample_format: paged_raster::SampleFormat::UInt,
        color_model: ColorModel::Cmyk,
        alpha: alpha_kind,
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
    };
    let img = RasterImage {
        info,
        width: W,
        height: H,
        model: ColorModel::Cmyk,
        alpha: alpha_kind,
        data: Samples::U8(inks(alpha)),
    };
    paged_raster::encode_tiff(&img, paged_raster::TiffEncodeOptions::default()).expect("a TIFF")
}

/// One image XObject of the export: its colour space name, bits, the
/// decoded samples, and the decoded samples of its soft mask.
struct Picture {
    space: String,
    bits: i64,
    samples: Vec<u8>,
    mask: Option<Vec<u8>>,
}

fn export(picture: Vec<u8>) -> Vec<Picture> {
    let mut br = BytesResolver::new();
    br.add_image("picture.tif", picture);
    let document = idml_import::import_idml_doc(&package()).expect("import");
    let opts = PipelineOptions {
        assets: Some(&br),
        ..PipelineOptions::default()
    };
    let fonts = FontTable::build(&document, &opts);
    let doc = {
        let o = PipelineOptions {
            pre_built_font_table: Some(&fonts),
            ..opts
        };
        pipeline::build_document(&document, &o).expect("build document")
    };
    let cmm = paged_color::IccCmm::new(None, paged_color::DisplaySetup::default());
    let pdf = export_pdf(ExportInput {
        doc: &doc,
        palette: &document.palette,
        fonts: Some(&fonts),
        cmm: &cmm,
        profiles: ExportProfiles::default(),
        inks: ExportInkSettings::default(),
        options: ExportOptions::default(),
        doc_bleed: [0.0; 4],
        doc_slug: [0.0; 4],
    })
    .expect("export")
    .bytes;
    let parsed = lopdf::Document::load_mem(&pdf).expect("re-parse");
    let mut out = Vec::new();
    for obj in parsed.objects.values() {
        let Ok(stream) = obj.as_stream() else {
            continue;
        };
        let d = &stream.dict;
        let is_image = d
            .get(b"Subtype")
            .and_then(|s| s.as_name())
            .is_ok_and(|n| n == b"Image");
        // A soft mask is reached from its picture below.
        let space = d
            .get(b"ColorSpace")
            .and_then(|s| s.as_name())
            .map(|n| String::from_utf8_lossy(n).into_owned())
            .unwrap_or_default();
        if !is_image || space == "DeviceGray" {
            continue;
        }
        let mask = d.get(b"SMask").ok().map(|m| {
            parsed
                .dereference(m)
                .expect("soft mask")
                .1
                .as_stream()
                .expect("stream")
                .decompressed_content()
                .expect("inflate")
        });
        out.push(Picture {
            space,
            bits: d
                .get(b"BitsPerComponent")
                .and_then(|v| v.as_i64())
                .unwrap_or(0),
            samples: stream.decompressed_content().expect("inflate"),
            mask,
        });
    }
    out
}

#[test]
fn a_cmyk_tiff_keeps_its_ink_values() {
    let pictures = export(tiff(false));
    assert_eq!(pictures.len(), 1, "one picture");
    let p = &pictures[0];
    assert_eq!((p.space.as_str(), p.bits), ("DeviceCMYK", 8));
    assert_eq!(p.samples, inks(false), "the file's own samples");
    // The pure black stays one ink.
    assert_eq!(&p.samples[..4], &[0, 0, 0, 255]);
    assert!(p.mask.is_none());
}

#[test]
fn a_cmyk_tiff_with_alpha_keeps_its_inks_under_a_soft_mask() {
    let pictures = export(tiff(true));
    assert_eq!(pictures.len(), 1, "one picture");
    let p = &pictures[0];
    assert_eq!((p.space.as_str(), p.bits), ("DeviceCMYK", 8));
    let with_alpha = inks(true);
    let colour: Vec<u8> = with_alpha
        .as_chunks::<5>()
        .0
        .iter()
        .flat_map(|px| px[..4].to_vec())
        .collect();
    let alpha: Vec<u8> = with_alpha
        .as_chunks::<5>()
        .0
        .iter()
        .map(|px| px[4])
        .collect();
    assert_eq!(p.samples, colour);
    assert_eq!(p.mask.as_deref(), Some(alpha.as_slice()));
}
