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

//! Engine ADR 1037 — a picture placed through a filter stack is embedded
//! adjusted, at its own pixels (its effective ppi): Flate-coded pixels
//! that are the stack's result, never the source JPEG passed through.

use std::io::Write;

use paged_export_pdf::{export_pdf, ExportInkSettings, ExportInput, ExportOptions, ExportProfiles};
use paged_renderer::pipeline::{self, FontTable, PipelineOptions};
use paged_renderer::BytesResolver;

fn package(label: Option<&str>) -> Vec<u8> {
    use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};
    let props = label
        .map(|l| {
            format!(
                r#"<Properties><Label><KeyValuePair Key="paged:imageAdjustments" Value="{}"/></Label></Properties>"#,
                l.replace('"', "&quot;")
            )
        })
        .unwrap_or_default();
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
        format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Spread xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">
  <Spread Self="sp1">
    <Page Self="p1" GeometricBounds="0 0 200 200"/>
    <Rectangle Self="r1" GeometricBounds="40 40 160 160" StrokeWeight="0">
      {props}
      <FrameFittingOption LeftCrop="0" TopCrop="0" RightCrop="0" BottomCrop="0"/>
      <Image Self="i1" LinkResourceURI="picture.jpg"/>
    </Rectangle>
  </Spread>
</idPkg:Spread>"#
        )
        .as_bytes(),
    )
    .unwrap();
    zip.finish().unwrap().into_inner()
}

fn jpeg() -> Vec<u8> {
    let img = image::RgbImage::from_pixel(64, 48, image::Rgb([200, 30, 30]));
    let mut out = std::io::Cursor::new(Vec::new());
    img.write_to(&mut out, image::ImageFormat::Jpeg).unwrap();
    out.into_inner()
}

/// The exported PDF's picture XObjects (no soft masks): width, height,
/// filter, and the first decoded RGB pixel of a Flate one.
fn pictures(label: Option<&str>) -> Vec<(i64, i64, String, Option<[u8; 3]>)> {
    let mut br = BytesResolver::new();
    br.add_image("picture.jpg", jpeg());
    let document = idml_import::import_idml_doc(&package(label)).expect("import");
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
        let is_mask = d
            .get(b"ColorSpace")
            .and_then(|s| s.as_name())
            .is_ok_and(|n| n == b"DeviceGray");
        if !is_image || is_mask {
            continue;
        }
        let w = d.get(b"Width").and_then(|v| v.as_i64()).unwrap_or(0);
        let h = d.get(b"Height").and_then(|v| v.as_i64()).unwrap_or(0);
        let filter = d
            .get(b"Filter")
            .and_then(|v| v.as_name())
            .map(|n| String::from_utf8_lossy(n).into_owned())
            .unwrap_or_default();
        let first = (filter == "FlateDecode")
            .then(|| stream.decompressed_content().ok())
            .flatten()
            .map(|b| [b[0], b[1], b[2]]);
        out.push((w, h, filter, first));
    }
    out
}

#[test]
#[allow(non_snake_case)]
fn an_adjusted_picture_is_embedded_adjusted_at_its_own_size__feat__images_graphics_image_filter_stack(
) {
    let plain = pictures(None);
    assert_eq!(plain.len(), 1, "{plain:?}");
    assert_eq!(plain[0].2, "DCTDecode", "an unadjusted JPEG passes through");

    let adjusted = pictures(Some(r#"[{"op":"invert"}]"#));
    assert_eq!(adjusted.len(), 1, "only the adjusted picture: {adjusted:?}");
    let (w, h, filter, first) = &adjusted[0];
    assert_eq!((*w, *h), (64, 48), "at the picture's own pixels");
    assert_eq!(filter, "FlateDecode");
    let px = first.expect("decoded");
    // The JPEG's red (≈200, 30, 30), inverted.
    assert!(
        px[0].abs_diff(55) <= 4 && px[1].abs_diff(225) <= 4 && px[2].abs_diff(225) <= 4,
        "{px:?}"
    );
}
