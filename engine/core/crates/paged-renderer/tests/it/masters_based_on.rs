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

//! Engine ADR 1026 — a master based on a master. A master page's own
//! `AppliedMaster` stacks that master under it on every page that shows
//! it (InDesign's "Based on Master"; a PowerPoint layout over its slide
//! master), at most four masters deep, a cycle drawn once; a master
//! page's `OverrideList` hides items of the masters below it, and a body
//! page's hides items of any master it shows.

use std::io::Write;

use paged_compose::Color;
use paged_renderer::pipeline::{self, PipelineOptions};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

/// A filled square `x0 y0 x1 y1` in `color`.
fn square(id: &str, color: &str, x0: f32, y0: f32, x1: f32, y1: f32) -> String {
    let pt = |x: f32, y: f32| {
        format!(
            r#"<PathPointType Anchor="{x} {y}" LeftDirection="{x} {y}" RightDirection="{x} {y}"/>"#
        )
    };
    format!(
        r#"<Polygon Self="{id}" FillColor="Color/{color}" StrokeWeight="0" ItemTransform="1 0 0 1 0 0"><Properties><PathGeometry><GeometryPathType PathOpen="false"><PathPointArray>{}{}{}{}</PathPointArray></GeometryPathType></PathGeometry></Properties></Polygon>"#,
        pt(x0, y0),
        pt(x1, y0),
        pt(x1, y1),
        pt(x0, y1)
    )
}

/// A master `id` whose page applies `based_on` and hides `overrides`.
fn master(id: &str, based_on: Option<&str>, overrides: &str, items: &str) -> String {
    let applied = based_on
        .map(|b| format!(r#" AppliedMaster="{b}""#))
        .unwrap_or_default();
    let ovr = if overrides.is_empty() {
        String::new()
    } else {
        format!(r#" OverrideList="{overrides}""#)
    };
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:MasterSpread xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">
  <MasterSpread Self="{id}" Name="{id}" ItemTransform="1 0 0 1 0 0">
    <Page Self="{id}pg"{applied}{ovr} GeometricBounds="0 0 100 100" ItemTransform="1 0 0 1 0 0"/>
    {items}
  </MasterSpread>
</idPkg:MasterSpread>"#
    )
}

/// Masters:
///
/// * `A`: a blue page, a green square top-left (`logo`), a red square in
///   the middle (`ph`);
/// * `B` based on `A`, hiding `ph`, with a yellow square bottom-right;
/// * `C` and `D` based on each other (a cycle), grey and black squares;
/// * `E1` … `E5`, each based on the next, each with a square of its own
///   along the top edge.
///
/// Pages: `B`; `B` hiding `A`'s `logo`; `A`; `C`; `E1`.
fn build() -> Vec<u8> {
    let masters: Vec<(&str, String)> = vec![
        (
            "A",
            master(
                "A",
                None,
                "",
                &[
                    square("bg", "Blue", 0.0, 0.0, 100.0, 100.0),
                    square("logo", "Green", 0.0, 0.0, 20.0, 20.0),
                    square("ph", "Red", 40.0, 40.0, 60.0, 60.0),
                ]
                .concat(),
            ),
        ),
        (
            "B",
            master(
                "B",
                Some("MasterSpread/A"),
                "ph",
                &square("corner", "Yellow", 80.0, 80.0, 100.0, 100.0),
            ),
        ),
        (
            "C",
            master(
                "C",
                Some("D"),
                "",
                &square("c", "Grey", 0.0, 0.0, 50.0, 100.0),
            ),
        ),
        (
            "D",
            master(
                "D",
                Some("C"),
                "",
                &square("d", "Black", 50.0, 0.0, 100.0, 100.0),
            ),
        ),
        (
            "E1",
            master(
                "E1",
                Some("E2"),
                "",
                &square("e1", "Red", 0.0, 0.0, 10.0, 10.0),
            ),
        ),
        (
            "E2",
            master(
                "E2",
                Some("E3"),
                "",
                &square("e2", "Red", 20.0, 0.0, 30.0, 10.0),
            ),
        ),
        (
            "E3",
            master(
                "E3",
                Some("E4"),
                "",
                &square("e3", "Red", 40.0, 0.0, 50.0, 10.0),
            ),
        ),
        (
            "E4",
            master(
                "E4",
                Some("E5"),
                "",
                &square("e4", "Red", 60.0, 0.0, 70.0, 10.0),
            ),
        ),
        (
            "E5",
            master("E5", None, "", &square("e5", "Red", 80.0, 0.0, 90.0, 10.0)),
        ),
    ];
    let pages: Vec<(&str, &str, &str)> = vec![
        ("p1", "MasterSpread/B", ""),
        ("p2", "B", "logo"),
        ("p3", "A", ""),
        ("p4", "C", ""),
        ("p5", "E1", ""),
    ];

    let buf = std::io::Cursor::new(Vec::new());
    let mut zip = ZipWriter::new(buf);
    let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    let deflated = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    zip.start_file("mimetype", stored).unwrap();
    zip.write_all(b"application/vnd.adobe.indesign-idml-package")
        .unwrap();
    let mut dm = String::from(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">
  <idPkg:Graphic src="Resources/Graphic.xml"/>
"#,
    );
    for (id, _) in &masters {
        dm.push_str(&format!(
            "  <idPkg:MasterSpread src=\"MasterSpreads/MasterSpread_{id}.xml\"/>\n"
        ));
    }
    for (id, _, _) in &pages {
        dm.push_str(&format!(
            "  <idPkg:Spread src=\"Spreads/Spread_s{id}.xml\"/>\n"
        ));
    }
    dm.push_str("</Document>");
    zip.start_file("designmap.xml", deflated).unwrap();
    zip.write_all(dm.as_bytes()).unwrap();
    zip.start_file("Resources/Graphic.xml", deflated).unwrap();
    zip.write_all(
        br#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Graphic xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">
  <Color Self="Color/Blue" Model="Process" Space="RGB" ColorValue="0 0 255" Name="Blue"/>
  <Color Self="Color/Green" Model="Process" Space="RGB" ColorValue="0 200 0" Name="Green"/>
  <Color Self="Color/Red" Model="Process" Space="RGB" ColorValue="230 0 0" Name="Red"/>
  <Color Self="Color/Yellow" Model="Process" Space="RGB" ColorValue="255 230 0" Name="Yellow"/>
  <Color Self="Color/Grey" Model="Process" Space="RGB" ColorValue="128 128 128" Name="Grey"/>
  <Color Self="Color/Black" Model="Process" Space="RGB" ColorValue="0 0 0" Name="Black"/>
</idPkg:Graphic>"#,
    )
    .unwrap();
    for (id, xml) in &masters {
        zip.start_file(format!("MasterSpreads/MasterSpread_{id}.xml"), deflated)
            .unwrap();
        zip.write_all(xml.as_bytes()).unwrap();
    }
    for (i, (id, applied, overrides)) in pages.iter().enumerate() {
        let ovr = if overrides.is_empty() {
            String::new()
        } else {
            format!(r#" OverrideList="{overrides}""#)
        };
        let y = i as f32 * 120.0;
        zip.start_file(format!("Spreads/Spread_s{id}.xml"), deflated)
            .unwrap();
        zip.write_all(
            format!(
                r#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Spread xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">
  <Spread Self="s{id}" ItemTransform="1 0 0 1 0 {y}">
    <Page Self="{id}" AppliedMaster="{applied}"{ovr} GeometricBounds="0 0 100 100" ItemTransform="1 0 0 1 0 0"/>
  </Spread>
</idPkg:Spread>"#
            )
            .as_bytes(),
        )
        .unwrap();
    }
    zip.finish().unwrap().into_inner()
}

fn render() -> Vec<image::RgbaImage> {
    let document = idml_import::import_idml_doc(&build()).unwrap();
    let (_, images) =
        pipeline::render_document(&document, &PipelineOptions::default(), 72.0, Color::WHITE)
            .unwrap();
    images
}

fn is(px: [u8; 4], rgb: [u8; 3]) -> bool {
    px[..3]
        .iter()
        .zip(rgb)
        .all(|(a, b)| (*a as i32 - b as i32).abs() < 40)
}

const BLUE: [u8; 3] = [0, 0, 255];
const GREEN: [u8; 3] = [0, 200, 0];
const RED: [u8; 3] = [230, 0, 0];
const YELLOW: [u8; 3] = [255, 230, 0];
const WHITE: [u8; 3] = [255, 255, 255];

#[test]
fn a_master_based_on_a_master_draws_both_and_hides_what_it_overrides() {
    let images = render();
    let p1 = &images[0];
    let px = |x, y| p1.get_pixel(x, y).0;
    assert!(
        is(px(50, 30), BLUE),
        "A's page colour under B: {:?}",
        px(50, 30)
    );
    assert!(is(px(10, 10), GREEN), "A's logo under B: {:?}", px(10, 10));
    assert!(
        is(px(50, 50), BLUE),
        "B's OverrideList hides A's middle square: {:?}",
        px(50, 50)
    );
    assert!(is(px(90, 90), YELLOW), "B's own square: {:?}", px(90, 90));
}

#[test]
fn a_body_pages_override_list_hides_an_item_of_a_master_below_its_own() {
    let images = render();
    let p2 = &images[1];
    assert!(
        is(p2.get_pixel(10, 10).0, BLUE),
        "the body page hides A's logo through B: {:?}",
        p2.get_pixel(10, 10).0
    );
    assert!(is(p2.get_pixel(90, 90).0, YELLOW));
    // A applied directly still draws its middle square.
    let p3 = &images[2];
    assert!(
        is(p3.get_pixel(50, 50).0, RED),
        "{:?}",
        p3.get_pixel(50, 50).0
    );
    assert!(
        is(p3.get_pixel(90, 90).0, BLUE),
        "{:?}",
        p3.get_pixel(90, 90).0
    );
}

#[test]
fn masters_based_on_each_other_draw_once() {
    let images = render();
    let p4 = &images[3];
    // C (grey, left) over D (black, right): both drawn, nothing hangs.
    assert!(
        is(p4.get_pixel(25, 50).0, [128, 128, 128]),
        "{:?}",
        p4.get_pixel(25, 50).0
    );
    assert!(
        is(p4.get_pixel(75, 50).0, [0, 0, 0]),
        "{:?}",
        p4.get_pixel(75, 50).0
    );
}

#[test]
fn at_most_four_masters_stack() {
    let images = render();
    let p5 = &images[4];
    for x in [5, 25, 45, 65] {
        assert!(
            is(p5.get_pixel(x, 5).0, RED),
            "E at x={x}: {:?}",
            p5.get_pixel(x, 5).0
        );
    }
    assert!(
        is(p5.get_pixel(85, 5).0, WHITE),
        "the fifth master is not drawn: {:?}",
        p5.get_pixel(85, 5).0
    );
}
