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

//! A placed EPS reaches the PDF as vectors (engine ADR 1033): its fills
//! and strokes are page content, and no image of it is embedded.

#![allow(non_snake_case)]

use std::io::Write;

use paged_export_pdf::{
    export_pdf, ExportInkSettings, ExportInput, ExportOptions, ExportProfiles, PdfStandard,
};
use paged_renderer::pipeline::{self, FontTable, PipelineOptions};
use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

const ART: &str = "%!PS-Adobe-3.0 EPSF-3.0
%%BoundingBox: 0 0 120 80
1 0 0 setrgbcolor 0 0 60 80 rectfill
0 0 0 1 setcmykcolor 2 setlinewidth newpath 0 0 moveto 120 80 lineto stroke
newpath 90 40 20 0 360 arc 0 0 1 setrgbcolor fill
";

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
<Document xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging"><idPkg:Spread src="Spreads/Spread_sp1.xml"/></Document>"#,
        ),
        (
            "Resources/Graphic.xml",
            r#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Graphic xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging"><Graphic/></idPkg:Graphic>"#,
        ),
        (
            "Spreads/Spread_sp1.xml",
            r#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Spread xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging"><Spread Self="sp1">
<Page Self="p1" GeometricBounds="0 0 120 160"/>
<Rectangle Self="r1" GeometricBounds="20 20 100 140" StrokeWeight="0"><EPS Self="e1" ItemTransform="1 0 0 1 20 20" LinkResourceURI="art.eps"/></Rectangle>
</Spread></idPkg:Spread>"#,
        ),
    ] {
        zip.start_file(name, deflated).unwrap();
        zip.write_all(body.as_bytes()).unwrap();
    }
    zip.finish().unwrap().into_inner()
}

/// The exported PDF of the package with `art` linked (none: unlinked).
fn exported(art: Option<&str>) -> lopdf::Document {
    let document = idml_import::import_idml_doc(&package()).unwrap();
    let mut br = paged_renderer::BytesResolver::new();
    if let Some(a) = art {
        br.add_image("art.eps", a.as_bytes().to_vec());
    }
    let opts = PipelineOptions {
        assets: Some(&br),
        missing_image_placeholder: false,
        ..PipelineOptions::default()
    };
    let fonts = FontTable::build(&document, &opts);
    let doc = pipeline::build_document(&document, &opts).unwrap();
    let palette = document.palette.clone();
    let cmm = paged_color::IccCmm::new(None, paged_color::DisplaySetup::default());
    let input = ExportInput {
        doc: &doc,
        palette: &palette,
        fonts: Some(&fonts),
        cmm: &cmm,
        profiles: ExportProfiles {
            cmyk_working: None,
            output_intent: None,
            srgb: None,
        },
        inks: ExportInkSettings::default(),
        options: ExportOptions {
            standard: PdfStandard::Pdf17,
            ..Default::default()
        },
        doc_bleed: [0.0; 4],
        doc_slug: [0.0; 4],
    };
    let pdf = export_pdf(input).expect("export").bytes;
    lopdf::Document::load_mem(&pdf).expect("lopdf re-parse")
}

fn page_content(doc: &lopdf::Document) -> Vec<u8> {
    let (_, page) = doc.get_pages().into_iter().next().unwrap();
    doc.get_page_content(page)
}

fn images(doc: &lopdf::Document) -> usize {
    doc.objects
        .values()
        .filter(|o| match o {
            lopdf::Object::Stream(s) => {
                s.dict.get(b"Subtype").ok().and_then(|s| s.as_name().ok()) == Some(b"Image")
            }
            _ => false,
        })
        .count()
}

#[test]
fn a_placed_eps_exports_as_vectors__feat__images_graphics_eps_postscript() {
    let with = exported(Some(ART));
    let without = exported(None);
    assert_eq!(images(&with), 0, "no raster of the EPS");
    let (a, b) = (page_content(&with), page_content(&without));
    assert!(a.len() > b.len() + 100, "{} vs {}", a.len(), b.len());
    let text = String::from_utf8_lossy(&a);
    // The disc's curves and the stroke are path operators in the content.
    assert!(text.contains(" c\n") || text.contains(" c "), "{text}");
    assert!(
        text.lines()
            .any(|l| l.trim_end().ends_with(" S") || l.trim() == "S"),
        "{text}"
    );
}
