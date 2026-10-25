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

//! A placed EPS is drawn from its PostScript (engine ADR 1016): the
//! frame's display list carries the program's fills, strokes and clips
//! under the placement, no raster, and the pixels show it.
//!
//! The `__feat__images_graphics_eps_postscript` suffix links these tests
//! to the cockpit feature.

#![allow(non_snake_case)]

use std::io::Write;

use paged_compose::{Color, DisplayCommand, Paint};
use paged_renderer::{pipeline, PipelineOptions};
use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

/// 120 × 80 points: the left half red, the top right quarter blue, a
/// CMYK black dashed line, a Type 3 glyph and a clipped disc.
pub const ART: &str = "%!PS-Adobe-3.0 EPSF-3.0
%%BoundingBox: 0 0 120 80
%%EndComments
1 0 0 setrgbcolor 0 0 60 80 rectfill
0 0 1 setrgbcolor 60 40 60 40 rectfill
0 0 0 1 setcmykcolor 2 setlinewidth [4 2] 0 setdash newpath 0 0 moveto 120 80 lineto stroke
gsave newpath 60 0 40 40 rectclip 0 1 0 setrgbcolor newpath 100 20 30 0 360 arc fill grestore
showpage
%%EOF
";

/// A one-spread package placing `link` in the frame (20, 20)–(140, 100).
pub fn package(link: &str) -> Vec<u8> {
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
    <Page Self="p1" GeometricBounds="0 0 120 160"/>
    <Rectangle Self="r1" GeometricBounds="20 20 100 140" StrokeWeight="0">
      <EPS Self="e1" ItemTransform="1 0 0 1 20 20" LinkResourceURI="{link}"/>
    </Rectangle>
  </Spread>
</idPkg:Spread>"#
    );
    zip.start_file("Spreads/Spread_sp1.xml", deflated).unwrap();
    zip.write_all(spread.as_bytes()).unwrap();
    zip.finish().unwrap().into_inner()
}

pub fn resolver(bytes: &[u8]) -> paged_renderer::BytesResolver {
    let mut br = paged_renderer::BytesResolver::new();
    br.add_image("art.eps", bytes.to_vec());
    br
}

fn options(br: &paged_renderer::BytesResolver) -> PipelineOptions<'_> {
    PipelineOptions {
        assets: Some(br),
        ..PipelineOptions::default()
    }
}

#[test]
fn a_placed_eps_emits_vector_commands_and_no_image__feat__images_graphics_eps_postscript() {
    let br = resolver(ART.as_bytes());
    let document = idml_import::import_idml_doc(&package("art.eps")).unwrap();
    let built = pipeline::build_document(&document, &options(&br)).unwrap();
    let list = &built.pages[0].list;
    let count = |f: fn(&DisplayCommand) -> bool| list.commands.iter().filter(|c| f(c)).count();
    assert_eq!(count(|c| matches!(c, DisplayCommand::Image { .. })), 0);
    assert!(list.images.is_empty(), "no raster of the EPS");
    // The two rectangles and the disc.
    assert_eq!(count(|c| matches!(c, DisplayCommand::FillPath { .. })), 3);
    let stroke = list.commands.iter().find_map(|c| match c {
        DisplayCommand::StrokePath { stroke, paint, .. } => Some((*stroke, *paint)),
        _ => None,
    });
    assert!(stroke.is_some_and(|(s, p)| s.width == 2.0
        && s.dash.as_slice() == [4.0, 2.0]
        && matches!(p, Paint::Cmyk { k, .. } if k == 1.0)));
    // The frame clip, the EPS box, the rectclip; balanced.
    assert_eq!(count(|c| matches!(c, DisplayCommand::PushClip { .. })), 3);
    assert_eq!(count(|c| matches!(c, DisplayCommand::PopClip(_))), 3);
}

#[test]
fn a_placed_eps_renders_its_art_where_the_frame_places_it() {
    let br = resolver(ART.as_bytes());
    let document = idml_import::import_idml_doc(&package("art.eps")).unwrap();
    let (_built, images) =
        pipeline::render_document(&document, &options(&br), 72.0, Color::WHITE).unwrap();
    let img = &images[0];
    let px = |x: u32, y: u32| img.get_pixel(x, y).0;
    let red = px(50, 60);
    assert!(red[0] > 240 && red[1] < 20 && red[2] < 20, "{red:?}");
    let blue = px(110, 30);
    assert!(blue[2] > 240 && blue[0] < 20, "{blue:?}");
    // Inside the rectclip: the green disc.
    let green = px(115, 92);
    assert!(green[1] > 200 && green[0] < 40, "{green:?}");
    // The disc outside its clip is not drawn: right half bottom, beyond
    // x = 100 in EPS space (page 120..140) above y 40 is blue, not green.
    let outside = px(135, 45);
    assert!(outside[1] < 200 || outside[0] > 200, "{outside:?}");
    // Outside the frame: page white.
    assert_eq!(&px(5, 5)[..3], &[255, 255, 255]);
}

#[test]
fn an_eps_the_interpreter_refuses_falls_back_to_the_raster_path() {
    let br = resolver(b"%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 10 10\nnosuchoperator\n");
    let document = idml_import::import_idml_doc(&package("art.eps")).unwrap();
    let built = pipeline::build_document(&document, &options(&br)).unwrap();
    let list = &built.pages[0].list;
    assert!(!list
        .commands
        .iter()
        .any(|c| matches!(c, DisplayCommand::StrokePath { .. })));
}
