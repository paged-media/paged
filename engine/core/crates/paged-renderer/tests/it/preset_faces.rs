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

//! Engine ADR 1096, amendment 1 — a live preset's shaded faces.
//!
//! One path item holds a cube's three filled faces; while it is the live
//! preset, the renderer fills each face with the item's fill shaded as the
//! program says (`darkenLess`, `lightenLess`), as PowerPoint 16 draws them:
//! a fill of RGB 200 100 50 shows 211 130 90 on the lid and 160 80 40 on the
//! side (`tooling/oracle/office/powerpoint`, measured on a saved PDF). A
//! point edit ends the preset and the faces paint plainly. A can's rim, a
//! stroke-only contour of the whole preset, is never filled.

use std::io::Write;

use paged_gpu::RasterOptions;
use paged_model::live_shape::{PresetPart, PresetShape};
use paged_renderer::pipeline::{build_document, PipelineOptions};
use paged_scene::Document;

fn idml() -> Vec<u8> {
    use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};
    let spread = r#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Spread xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">
  <Spread Self="sp1">
    <Page Self="p1" GeometricBounds="0 0 200 200"/>
    <Polygon Self="cube" FillColor="Color/Orange" StrokeWeight="0">
      <Properties><PathGeometry><GeometryPathType PathOpen="false"><PathPointArray>
        <PathPointType Anchor="0 0" LeftDirection="0 0" RightDirection="0 0"/>
        <PathPointType Anchor="10 0" LeftDirection="10 0" RightDirection="10 0"/>
        <PathPointType Anchor="10 10" LeftDirection="10 10" RightDirection="10 10"/>
      </PathPointArray></GeometryPathType></PathGeometry></Properties>
    </Polygon>
  </Spread>
</idPkg:Spread>"#;
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
  <idPkg:Graphic src="Resources/Graphic.xml"/>
  <idPkg:Spread src="Spreads/Spread_sp1.xml"/>
</Document>"#,
    )
    .unwrap();
    zip.start_file("Resources/Graphic.xml", deflated).unwrap();
    zip.write_all(
        br#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Graphic xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">
  <Color Self="Color/Orange" Model="Process" Space="RGB" ColorValue="200 100 50" Name="Orange"/>
</idPkg:Graphic>"#,
    )
    .unwrap();
    zip.start_file("Spreads/Spread_sp1.xml", deflated).unwrap();
    zip.write_all(spread.as_bytes()).unwrap();
    zip.finish().unwrap().into_inner()
}

/// The page with the polygon drawn as `preset` for a 100 pt box at 50, 50.
fn doc(name: &str, part: PresetPart) -> Document {
    let mut d = idml_import::import_idml_doc(&idml()).expect("import");
    let p = PresetShape {
        part,
        ..PresetShape::new(name, 100.0, 100.0).with_frame([50.0, 50.0, 100.0, 100.0])
    };
    let drawn = paged_preset_geom::model::draw(&p).expect("a preset");
    let poly = &mut d.spreads[0].spread.polygons[0];
    poly.anchors = drawn.anchors;
    poly.subpath_starts = drawn.starts;
    poly.subpath_open = drawn.open;
    poly.preset = Some(p);
    d
}

/// The page at 72 dpi: one pixel per pt.
fn pixels(d: &Document) -> image::RgbaImage {
    let built = build_document(d, &PipelineOptions::default()).expect("build");
    let list = built.pages.into_iter().next().expect("a page").list;
    let mut opts = RasterOptions::new(200.0, 200.0);
    opts.dpi = 72.0;
    paged_gpu::rasterize(&list, &opts)
}

fn rgb(img: &image::RgbaImage, x: u32, y: u32) -> [u8; 3] {
    let p = img.get_pixel(x, y).0;
    [p[0], p[1], p[2]]
}

fn near(got: [u8; 3], want: [u8; 3]) -> bool {
    got.iter()
        .zip(want)
        .all(|(g, w)| (i32::from(*g) - i32::from(w)).abs() <= 2)
}

#[test]
fn a_cubes_faces_are_shaded_as_powerpoint_shades_them() {
    // The cube's depth is a quarter of the box: the lid spans y 50–75,
    // the side x 125–150.
    let img = pixels(&doc("cube", PresetPart::Fill));
    let (front, lid, side) = (rgb(&img, 80, 120), rgb(&img, 110, 62), rgb(&img, 140, 110));
    assert!(near(front, [200, 100, 50]), "front {front:?}");
    assert!(near(lid, [211, 130, 90]), "lid {lid:?}");
    assert!(near(side, [160, 80, 40]), "side {side:?}");
}

#[test]
fn a_reshaped_cube_paints_plainly() {
    let mut d = doc("cube", PresetPart::Fill);
    d.spreads[0].spread.polygons[0].anchors[0].anchor.0 += 1.0;
    let img = pixels(&d);
    let lid = rgb(&img, 110, 62);
    assert!(near(lid, [200, 100, 50]), "lid {lid:?}");
}

#[test]
fn a_whole_cans_lid_is_lighter_and_its_rim_unfilled() {
    let img = pixels(&doc("can", PresetPart::All));
    // The lid (`lighten`): 40 % of the way to white.
    let lid = rgb(&img, 100, 62);
    assert!(near(lid, [222, 162, 132]), "lid {lid:?}");
    let body = rgb(&img, 100, 120);
    assert!(near(body, [200, 100, 50]), "body {body:?}");
}
