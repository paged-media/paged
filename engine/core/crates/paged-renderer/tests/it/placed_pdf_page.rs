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

//! A placed PDF shows the page the document names (engine ADR 1003).
//!
//! `<PDF><PDFAttribute PageNumber PDFCrop>` picks the page of a placed PDF
//! and the box of it the frame shows. The frame's fit is resolved against
//! that page's box, and the page is drawn from its own operations as
//! page 1 always was (ADR 154), so both rasterizers draw it from one list.

use std::io::Write;

use paged_compose::Color;
use paged_renderer::{pipeline, PipelineOptions};
use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

/// One page of [`pdf`]: its media box, its trim box and its content.
type PdfPage<'a> = ([f32; 4], Option<[f32; 4]>, &'a str);

/// A PDF built in code, one page per [`PdfPage`].
fn pdf(pages: &[PdfPage<'_>]) -> Vec<u8> {
    let mut objects: Vec<String> = vec![String::new(); 3 + 2 * pages.len()];
    objects[1] = "<< /Type /Catalog /Pages 2 0 R >>".to_string();
    let kids: Vec<String> = (0..pages.len())
        .map(|i| format!("{} 0 R", 3 + 2 * i))
        .collect();
    objects[2] = format!(
        "<< /Type /Pages /Kids [{}] /Count {} >>",
        kids.join(" "),
        pages.len()
    );
    let rect = |r: [f32; 4]| format!("[{} {} {} {}]", r[0], r[1], r[2], r[3]);
    for (i, (media, trim, content)) in pages.iter().enumerate() {
        let trim = trim
            .map(|t| format!(" /TrimBox {}", rect(t)))
            .unwrap_or_default();
        objects[3 + 2 * i] = format!(
            "<< /Type /Page /Parent 2 0 R /MediaBox {}{trim} /Contents {} 0 R >>",
            rect(*media),
            4 + 2 * i
        );
        objects[4 + 2 * i] = format!(
            "<< /Length {} >>\nstream\n{content}\nendstream",
            content.len()
        );
    }
    let mut out = b"%PDF-1.4\n".to_vec();
    let mut offsets = vec![0usize; objects.len()];
    for (n, o) in objects.iter().enumerate().skip(1) {
        offsets[n] = out.len();
        out.extend_from_slice(format!("{n} 0 obj\n{o}\nendobj\n").as_bytes());
    }
    let xref = out.len();
    out.extend_from_slice(format!("xref\n0 {}\n0000000000 65535 f \n", objects.len()).as_bytes());
    for off in offsets.iter().skip(1) {
        out.extend_from_slice(format!("{off:010} 00000 n \n").as_bytes());
    }
    out.extend_from_slice(
        format!(
            "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n",
            objects.len()
        )
        .as_bytes(),
    );
    out
}

/// Page 1: 100 × 60 pt of red. Page 2: 60 × 100 pt of blue. Page 3: a
/// 100 pt square of green whose trim box (25..75) is red.
fn three_pages() -> Vec<u8> {
    pdf(&[
        ([0.0, 0.0, 100.0, 60.0], None, "1 0 0 rg 0 0 100 60 re f"),
        ([0.0, 0.0, 60.0, 100.0], None, "0 0 1 rg 0 0 60 100 re f"),
        (
            [0.0, 0.0, 100.0, 100.0],
            Some([25.0, 25.0, 75.0, 75.0]),
            "0 1 0 rg 0 0 100 100 re f 1 0 0 rg 25 25 50 50 re f",
        ),
    ])
}

/// A one-spread package whose only item is a 100 pt frame at (10, 10)
/// placing `art.pdf` proportionally (no transform of its own), with the
/// `<PDFAttribute>` given.
fn package(pdf_attribute: &str) -> Vec<u8> {
    placed(
        r#"<FrameFittingOption FittingOnEmptyFrame="Proportionally" FittingAlignment="CenterAnchor"/>"#,
        "",
        pdf_attribute,
    )
}

/// The same frame with its own fitting option and the `<PDF>`'s own
/// attributes.
fn placed(fitting: &str, pdf_attrs: &str, pdf_attribute: &str) -> Vec<u8> {
    let rect = format!(
        r#"<Rectangle Self="r1" GeometricBounds="10 10 110 110" StrokeWeight="0">
      {fitting}
      <PDF Self="pdf1"{pdf_attrs}>
        {pdf_attribute}
        <Link Self="l1" LinkResourceURI="art.pdf"/>
      </PDF>
    </Rectangle>"#
    );
    let buf = std::io::Cursor::new(Vec::new());
    let mut zip = ZipWriter::new(buf);
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
    zip.start_file("Resources/Graphic.xml", deflated).unwrap();
    zip.write_all(
        br#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Graphic xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">
  <Graphic/>
</idPkg:Graphic>"#,
    )
    .unwrap();
    let spread = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Spread xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">
  <Spread Self="sp1">
    <Page Self="p1" GeometricBounds="0 0 120 120"/>
    {rect}
  </Spread>
</idPkg:Spread>"#
    );
    zip.start_file("Spreads/Spread_sp1.xml", deflated).unwrap();
    zip.write_all(spread.as_bytes()).unwrap();
    zip.finish().unwrap().into_inner()
}

fn resolver() -> paged_renderer::BytesResolver {
    let mut br = paged_renderer::BytesResolver::new();
    br.add_image("art.pdf", three_pages());
    br
}

fn render(pdf_attribute: &str) -> image::RgbaImage {
    render_package(&package(pdf_attribute))
}

fn render_package(idml: &[u8]) -> image::RgbaImage {
    let br = resolver();
    let options = PipelineOptions {
        assets: Some(&br),
        ..PipelineOptions::default()
    };
    let document = idml_import::import_idml_doc(idml).unwrap();
    let (_built, images) =
        pipeline::render_document(&document, &options, 72.0, Color::WHITE).unwrap();
    images.into_iter().next().unwrap()
}

/// The colour at page point `(x, y)`, as a name.
fn at(img: &image::RgbaImage, x: u32, y: u32) -> &'static str {
    match img.get_pixel(x, y).0 {
        [r, g, b, _] if r > 200 && g < 60 && b < 60 => "red",
        [r, g, b, _] if r < 60 && g < 60 && b > 200 => "blue",
        [r, g, b, _] if r < 60 && g > 200 && b < 60 => "green",
        [r, g, b, _] if r > 240 && g > 240 && b > 240 => "white",
        _ => "other",
    }
}

#[test]
fn the_named_page_is_drawn_and_the_fit_takes_its_size() {
    // Page 1 (100 × 60) fits the frame's width: red across, white above
    // and below it.
    for attr in ["", r#"<PDFAttribute PageNumber="1" PDFCrop="CropMedia"/>"#] {
        let img = render(attr);
        assert_eq!(at(&img, 60, 60), "red", "{attr}");
        assert_eq!(at(&img, 15, 60), "red", "{attr}");
        assert_eq!(at(&img, 60, 15), "white", "{attr}");
    }
    // Page 2 (60 × 100) fits the frame's height: blue down the middle,
    // white at the sides.
    let img = render(r#"<PDFAttribute PageNumber="2" PDFCrop="CropMedia"/>"#);
    assert_eq!(at(&img, 60, 60), "blue");
    assert_eq!(at(&img, 60, 15), "blue");
    assert_eq!(at(&img, 15, 60), "white");
}

#[test]
fn the_display_list_differs_by_page() {
    let br = resolver();
    let options = PipelineOptions {
        assets: Some(&br),
        ..PipelineOptions::default()
    };
    let fills = |attr: &str| {
        let document = idml_import::import_idml_doc(&package(attr)).unwrap();
        let built = pipeline::build_document(&document, &options).unwrap();
        built.pages[0]
            .list
            .commands
            .iter()
            .filter_map(|c| match c {
                paged_compose::DisplayCommand::FillPath {
                    paint: paged_compose::Paint::Solid(col),
                    ..
                } => Some([col.r, col.g, col.b]),
                _ => None,
            })
            .collect::<Vec<_>>()
    };
    let one = fills(r#"<PDFAttribute PageNumber="1"/>"#);
    let two = fills(r#"<PDFAttribute PageNumber="2"/>"#);
    assert!(one.contains(&[1.0, 0.0, 0.0]) && !one.contains(&[0.0, 0.0, 1.0]));
    assert!(two.contains(&[0.0, 0.0, 1.0]) && !two.contains(&[1.0, 0.0, 0.0]));
}

#[test]
fn the_crop_picks_the_box_of_the_page() {
    // Page 3's media box is green with a red trim box: cropped to its
    // media box the frame shows green at the edges, to its trim box red
    // across the whole frame.
    let media = render(r#"<PDFAttribute PageNumber="3" PDFCrop="CropMedia"/>"#);
    assert_eq!(at(&media, 15, 15), "green");
    assert_eq!(at(&media, 60, 60), "red");
    let trim = render(r#"<PDFAttribute PageNumber="3" PDFCrop="CropTrim"/>"#);
    assert_eq!(at(&trim, 15, 15), "red");
    assert_eq!(at(&trim, 105, 105), "red");
    // The PDF's crop box (no crop named) is its media box here.
    assert_eq!(
        at(&render(r#"<PDFAttribute PageNumber="3"/>"#), 15, 15),
        "green"
    );
}

#[test]
fn a_box_crops_what_lies_outside_it() {
    // Page 3 placed at 100 % with its trim box's corner at the frame's
    // (25, 25): the trim box shows red, the green around it is cropped
    // away, where the media box shows it.
    let at_scale = |crop: &str| {
        render_package(&placed(
            "",
            r#" ItemTransform="1 0 0 1 35 35""#,
            &format!(r#"<PDFAttribute PageNumber="3" PDFCrop="{crop}"/>"#),
        ))
    };
    let trim = at_scale("CropTrim");
    assert_eq!(at(&trim, 60, 60), "red");
    assert_eq!(at(&trim, 30, 30), "white");
    let media = at_scale("CropMedia");
    assert_eq!(at(&media, 40, 40), "green");
}

#[test]
fn a_page_past_the_last_shows_the_first() {
    let img = render(r#"<PDFAttribute PageNumber="9"/>"#);
    assert_eq!(at(&img, 60, 60), "red");
}

/// Engine ADR 1006 — a placed PDF fills `f*` and clips `W*` even-odd.
/// Page 1: two nested red squares filled `f*` (both `re`, so both turn
/// the same way: non-zero would fill the middle). Page 2: a blue page
/// clipped `W*` by the same two squares.
#[test]
#[allow(non_snake_case)]
fn a_placed_pdf_fills_and_clips_even_odd__feat__frames_paths_fill_rule_even_odd() {
    let art = pdf(&[
        (
            [0.0, 0.0, 100.0, 100.0],
            None,
            "1 0 0 rg 10 10 80 80 re 30 30 40 40 re f*",
        ),
        (
            [0.0, 0.0, 100.0, 100.0],
            None,
            "0 0 1 rg 0 0 100 100 re 25 25 50 50 re W* n 0 0 100 100 re f",
        ),
    ]);
    let mut br = paged_renderer::BytesResolver::new();
    br.add_image("art.pdf", art);
    let options = PipelineOptions {
        assets: Some(&br),
        ..PipelineOptions::default()
    };
    let draw = |page: u32| {
        let idml = package(&format!(
            r#"<PDFAttribute PageNumber="{page}" PDFCrop="CropMedia"/>"#
        ));
        let document = idml_import::import_idml_doc(&idml).unwrap();
        let (_built, images) =
            pipeline::render_document(&document, &options, 72.0, Color::WHITE).unwrap();
        images.into_iter().next().unwrap()
    };
    // The page sits at (10, 10), PDF y up: PDF (x, y) is page (10 + x, 110 - y).
    let fill = draw(1);
    assert_eq!(at(&fill, 30, 60), "red", "the ring fills");
    assert_eq!(at(&fill, 60, 60), "white", "f* leaves the middle empty");
    let clip = draw(2);
    assert_eq!(at(&clip, 20, 60), "blue", "inside the clip");
    assert_eq!(at(&clip, 60, 60), "white", "W* clips the middle away");
}
