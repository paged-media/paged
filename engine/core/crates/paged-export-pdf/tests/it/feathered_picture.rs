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

//! A feathered picture frame exports its picture under the feather's
//! soft mask. The frame has no fill; before the run could open at the
//! `BeginFeatheredObject` marker, the feather found no fill to mask and
//! the picture exported at full strength.

use std::io::Write;

use paged_export_pdf::{export_pdf, ExportInkSettings, ExportInput, ExportOptions, ExportProfiles};
use paged_renderer::pipeline::{self, FontTable, PipelineOptions};
use paged_renderer::BytesResolver;
use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

fn package() -> Vec<u8> {
    let mut zip = ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    let deflated = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    zip.start_file("mimetype", stored).unwrap();
    zip.write_all(b"application/vnd.adobe.indesign-idml-package")
        .unwrap();
    for (name, body) in [
        (
            "designmap.xml",
            r#"<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">
  <idPkg:Spread src="Spreads/Spread_sp1.xml"/>
</Document>"#,
        ),
        (
            "Resources/Graphic.xml",
            r#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Graphic xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">
  <Graphic/>
</idPkg:Graphic>"#,
        ),
        (
            "Spreads/Spread_sp1.xml",
            r#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Spread xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">
  <Spread Self="sp1">
    <Page Self="p1" GeometricBounds="0 0 200 200"/>
    <Rectangle Self="r1" GeometricBounds="40 40 160 160" StrokeWeight="0">
      <TransparencySetting>
        <FeatherSetting Mode="Standard" Width="20" CornerType="Sharp"/>
      </TransparencySetting>
      <FrameFittingOption LeftCrop="0" TopCrop="0" RightCrop="0" BottomCrop="0" FittingOnEmptyFrame="FillProportionally"/>
      <Image Self="i1" LinkResourceURI="picture.png"/>
    </Rectangle>
  </Spread>
</idPkg:Spread>"#,
        ),
    ] {
        zip.start_file(name, deflated).unwrap();
        zip.write_all(body.as_bytes()).unwrap();
    }
    zip.finish().unwrap().into_inner()
}

fn green_png() -> Vec<u8> {
    let img = image::RgbaImage::from_pixel(4, 4, image::Rgba([0, 200, 0, 255]));
    let mut bytes = Vec::new();
    image::DynamicImage::ImageRgba8(img)
        .write_to(
            &mut std::io::Cursor::new(&mut bytes),
            image::ImageFormat::Png,
        )
        .unwrap();
    bytes
}

/// The picture's `Do` paints after the soft-mask graphics state is set
/// and before it is restored.
#[test]
fn a_feathered_picture_exports_under_the_feather_soft_mask() {
    let mut assets = BytesResolver::new();
    assets.add_image("picture.png", green_png());
    let opts = PipelineOptions {
        assets: Some(&assets),
        ..PipelineOptions::default()
    };
    let document = idml_import::import_idml_doc(&package()).unwrap();
    let fonts = FontTable::build(&document, &opts);
    let doc = pipeline::build_document(&document, &opts).unwrap();
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
    let pdf = lopdf::Document::load_mem(&pdf).expect("re-parse");
    let (_, page) = pdf.get_pages().into_iter().next().unwrap();
    let content = String::from_utf8_lossy(&pdf.get_page_content(page)).into_owned();
    let mask = content
        .find("/GsSm")
        .unwrap_or_else(|| panic!("no feather soft mask in the page:\n{content}"));
    let picture = content
        .find("/Im")
        .unwrap_or_else(|| panic!("no picture in the page:\n{content}"));
    assert!(
        mask < picture,
        "the picture paints under the feather's soft mask:\n{content}"
    );
}
