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

//! The page reader of place-as-vectors (publish ADR 658), one construct
//! per test, each on a PDF the test writes: what it paints comes back as
//! the items, paints and brackets the IR promises, in the page's own
//! points (top-left origin, y down).

mod support;

use pdf_import::vectors::ir::{Item, Paint, PathItem};
use pdf_import::vectors::{inspect, read_page, ReadError, ReadOptions};
use support::{obj, pdf, stream, Obj};

fn read(bytes: &[u8]) -> pdf_import::vectors::ir::VectorPage {
    read_page(bytes, 0, &ReadOptions::default()).expect("the page reads")
}

fn paths(items: &[Item]) -> Vec<&PathItem> {
    let mut out = Vec::new();
    for i in items {
        match i {
            Item::Path(p) => out.push(p),
            Item::Group(g) => out.extend(paths(&g.items)),
            _ => {}
        }
    }
    out
}

fn loss(page: &pdf_import::vectors::ir::VectorPage, code: &str) -> u32 {
    page.losses
        .iter()
        .find(|l| l.code == code)
        .map_or(0, |l| l.count)
}

#[test]
#[allow(non_snake_case)]
fn a_curve_keeps_its_handles__feat__editor_shell_import_svg_pdf_vectors() {
    // A circle of four cubics, r 50 at (100, 100) in PDF space; the page
    // is 200 high, so it sits at (100, 100) in the page's y-down space too.
    let k = 27.6;
    let c = format!(
        "1 0 0 rg 150 100 m 150 {a} {b} 150 100 150 c {c2} 150 50 {a} 50 100 c 50 {d} {c2} 50 100 50 c {b} 50 150 {d} 150 100 c h f",
        a = 100.0 + k,
        b = 100.0 + k,
        c2 = 100.0 - k,
        d = 100.0 - k
    );
    let page = read(&pdf(200.0, 200.0, "", &c, &[]));
    let p = paths(&page.items);
    assert_eq!(p.len(), 1);
    let contour = &p[0].contours[0];
    assert!(contour.closed);
    assert_eq!(
        contour.anchors.len(),
        4,
        "the closing anchor folds into the first"
    );
    let a0 = contour.anchors[0];
    assert_eq!(a0.anchor, [150.0, 100.0]);
    // Its outgoing handle runs down the page (PDF y up → page y down).
    assert!((a0.right[1] - (100.0 - k)).abs() < 1e-3, "{a0:?}");
    assert!((a0.left[1] - (100.0 + k)).abs() < 1e-3, "{a0:?}");
    assert!(
        matches!(p[0].fill, Some(Paint::Solid { rgb: [1.0, 0.0, 0.0], opacity }) if opacity == 1.0)
    );
    assert_eq!(p[0].fill_rule, "nonzero");
}

#[test]
#[allow(non_snake_case)]
fn even_odd_and_fill_and_stroke__feat__editor_shell_import_svg_pdf_vectors() {
    let c = "0 0 1 rg 1 0 0 RG 4 w 10 10 100 100 re 30 30 60 60 re B*";
    let page = read(&pdf(200.0, 200.0, "", c, &[]));
    let p = paths(&page.items);
    assert_eq!(p.len(), 1, "B* is one item, fill and stroke");
    assert_eq!(p[0].fill_rule, "evenodd");
    assert_eq!(p[0].contours.len(), 2);
    let s = p[0].stroke.as_ref().expect("stroked");
    assert_eq!(s.width, 4.0);
}

#[test]
#[allow(non_snake_case)]
fn a_stroke_keeps_cap_join_dash_and_scale__feat__editor_shell_import_svg_pdf_vectors() {
    let c = "2 0 0 2 0 0 cm 0 0 1 RG 3 w 1 J 2 j 7 M [4 2] 1 d 10 10 m 50 30 l 90 10 l S";
    let page = read(&pdf(200.0, 200.0, "", c, &[]));
    let p = paths(&page.items);
    let s = p[0].stroke.as_ref().expect("stroked");
    assert_eq!(s.width, 6.0, "the width scales with the transform");
    assert_eq!((s.cap, s.join), ("round", "bevel"));
    assert_eq!(s.miter_limit, 7.0);
    assert_eq!(s.dash, vec![8.0, 4.0]);
    assert_eq!(s.dash_phase, 2.0);
    assert!(!p[0].contours[0].closed);
    assert_eq!(p[0].contours[0].anchors[1].anchor, [100.0, 140.0]);
}

#[test]
#[allow(non_snake_case)]
fn a_clip_becomes_a_clip_group__feat__editor_shell_import_svg_pdf_vectors() {
    // A triangle clips two rectangles.
    let c = "q 20 20 m 180 20 l 100 180 l h W n 1 0 0 rg 0 0 100 200 re f 0 1 0 rg 100 0 100 200 re f Q";
    let page = read(&pdf(200.0, 200.0, "", c, &[]));
    assert_eq!(page.items.len(), 1);
    let Item::Group(g) = &page.items[0] else {
        panic!("{:?}", page.items[0]);
    };
    let clip = g.clip.as_ref().expect("a clip group");
    assert_eq!(clip.contours[0].anchors.len(), 3);
    assert_eq!(g.items.len(), 2);
}

#[test]
#[allow(non_snake_case)]
fn a_clip_filled_by_one_rectangle_is_that_path__feat__editor_shell_import_svg_pdf_vectors() {
    let c = "q 20 20 m 180 20 l 100 180 l h W n 1 0 0 rg 0 0 200 200 re f Q";
    let page = read(&pdf(200.0, 200.0, "", c, &[]));
    assert_eq!(page.items.len(), 1);
    let Item::Path(p) = &page.items[0] else {
        panic!("{:?}", page.items[0]);
    };
    assert_eq!(p.contours[0].anchors.len(), 3, "the clip's outline");
}

const AXIAL: &str = "<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [20 0 180 0] /Extend [true true] /Function << /FunctionType 2 /Domain [0 1] /C0 [1 0 0] /C1 [0 0 1] /N 1 >> >>";

#[test]
#[allow(non_snake_case)]
fn an_axial_shading_in_a_clip_is_a_linear_gradient_path__feat__editor_shell_import_svg_pdf_vectors()
{
    let c = "q 20 50 160 100 re W n /Sh0 sh Q";
    let page = read(&pdf(
        200.0,
        200.0,
        &format!("/Shading << /Sh0 {} 0 R >>", obj(1, 0)),
        c,
        &[Obj(AXIAL.into())],
    ));
    assert_eq!(page.items.len(), 1, "{:?}", page.items);
    let Item::Path(p) = &page.items[0] else {
        panic!("{:?}", page.items[0]);
    };
    let Some(Paint::Linear {
        start, end, stops, ..
    }) = &p.fill
    else {
        panic!("{:?}", p.fill);
    };
    assert!(
        (start[0] - 20.0).abs() < 1e-3 && (end[0] - 180.0).abs() < 1e-3,
        "{start:?} {end:?}"
    );
    assert!((start[1] - end[1]).abs() < 1e-3, "horizontal");
    assert_eq!(stops.len(), 2, "{stops:?}");
    assert!(
        (stops[0].rgb[0] - 1.0).abs() < 0.01 && (stops[stops.len() - 1].rgb[2] - 1.0).abs() < 0.01,
        "{stops:?}"
    );
    assert_eq!(loss(&page, "shading.no_extend"), 0);
}

#[test]
#[allow(non_snake_case)]
fn a_concentric_radial_shading_is_a_radial_gradient__feat__editor_shell_import_svg_pdf_vectors() {
    let sh = "<< /ShadingType 3 /ColorSpace /DeviceRGB /Coords [100 100 0 100 100 80] /Extend [true true] /Function << /FunctionType 2 /Domain [0 1] /C0 [1 1 1] /C1 [0 0 0] /N 1 >> >>";
    let c = "q 20 20 160 160 re W n /Sh0 sh Q";
    let page = read(&pdf(
        200.0,
        200.0,
        &format!("/Shading << /Sh0 {} 0 R >>", obj(1, 0)),
        c,
        &[Obj(sh.into())],
    ));
    let p = paths(&page.items);
    let Some(Paint::Radial {
        center,
        radius,
        stops,
        ..
    }) = &p[0].fill
    else {
        panic!("{:?}", p[0].fill);
    };
    assert_eq!(*center, [100.0, 100.0]);
    assert!((radius - 80.0).abs() < 1e-3);
    assert!(stops.len() >= 2);
}

#[test]
#[allow(non_snake_case)]
fn a_focal_radial_shading_is_sampled_and_reported__feat__editor_shell_import_svg_pdf_vectors() {
    let sh = "<< /ShadingType 3 /ColorSpace /DeviceRGB /Coords [80 80 0 100 100 80] /Extend [true true] /Function << /FunctionType 2 /Domain [0 1] /C0 [1 1 1] /C1 [0 0 0] /N 1 >> >>";
    let c = "q 20 20 160 160 re W n /Sh0 sh Q";
    let page = read(&pdf(
        200.0,
        200.0,
        &format!("/Shading << /Sh0 {} 0 R >>", obj(1, 0)),
        c,
        &[Obj(sh.into())],
    ));
    assert_eq!(loss(&page, "shading.focal_sampled"), 1);
    // The clip is the image's own box, so it cuts nothing and goes.
    assert!(
        matches!(&page.items[..], [Item::Image(i)] if i.mime == "image/png"
            && i.transform == [160.32, 0.0, 0.0, 160.32, 20.0, 20.0]),
        "{:?}",
        page.items.len()
    );
}

#[test]
#[allow(non_snake_case)]
fn constant_alpha_and_blend_mode__feat__editor_shell_import_svg_pdf_vectors() {
    let gs = "<< /Type /ExtGState /ca 0.5 /CA 0.25 /BM /Multiply >>";
    let c = "/G0 gs 1 0 0 rg 0 0 1 RG 10 10 50 50 re B";
    let page = read(&pdf(
        200.0,
        200.0,
        &format!("/ExtGState << /G0 {} 0 R >>", obj(1, 0)),
        c,
        &[Obj(gs.into())],
    ));
    let p = paths(&page.items);
    assert!(
        matches!(p[0].fill, Some(Paint::Solid { opacity, .. }) if (opacity - 0.5).abs() < 0.01),
        "{:?}",
        page.items
    );
    assert!(
        matches!(&p[0].stroke, Some(s) if matches!(s.paint, Paint::Solid { opacity, .. } if (opacity - 0.25).abs() < 0.01))
    );
    assert_eq!(p[0].blend, Some("Multiply"));
}

#[test]
#[allow(non_snake_case)]
fn a_luminosity_soft_mask_reaches_the_group__feat__editor_shell_import_svg_pdf_vectors() {
    // The mask: a white square in a transparency group.
    let mask_form = "<< /Type /XObject /Subtype /Form /BBox [0 0 200 200] /Group << /S /Transparency /CS /DeviceRGB >> /Length 26 >>\nstream\n1 1 1 rg 40 40 80 80 re f\nendstream";
    let gs = format!(
        "<< /Type /ExtGState /SMask << /S /Luminosity /G {} 0 R >> >>",
        obj(1, 1)
    );
    let c = "/G0 gs 1 0 0 rg 0 0 200 200 re f";
    let page = read(&pdf(
        200.0,
        200.0,
        &format!("/ExtGState << /G0 {} 0 R >>", obj(1, 0)),
        c,
        &[Obj(gs), Obj(mask_form.into())],
    ));
    let Item::Group(g) = &page.items[0] else {
        panic!("{:?}", page.items);
    };
    let mask = g.mask.as_ref().expect("masked");
    assert_eq!(mask.mask_type, "luminosity");
    assert_eq!(paths(&mask.items).len(), 1);
}

#[test]
#[allow(non_snake_case)]
fn an_image_keeps_its_placement__feat__editor_shell_import_svg_pdf_vectors() {
    // A 2 × 1 RGB image drawn 100 × 50 at (20, 30) in PDF space.
    let img = stream(
        "/Type /XObject /Subtype /Image /Width 2 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8",
        &[255, 0, 0, 0, 0, 255],
    );
    let c = "q 100 0 0 50 20 30 cm /Im0 Do Q";
    let page = read(&pdf(
        200.0,
        200.0,
        &format!("/XObject << /Im0 {} 0 R >>", obj(1, 0)),
        c,
        &[img],
    ));
    let Item::Image(i) = &page.items[0] else {
        panic!("{:?}", page.items);
    };
    assert_eq!((i.width_px, i.height_px), (2, 1));
    // The unit square's top-left at (20, 200 − 30 − 50), 100 × 50.
    assert_eq!(i.transform, [100.0, 0.0, 0.0, 50.0, 20.0, 120.0]);
    assert_eq!(i.mime, "image/png");
}

#[test]
#[allow(non_snake_case)]
fn a_tiling_pattern_expands_its_cell__feat__editor_shell_import_svg_pdf_vectors() {
    let pattern = "<< /Type /Pattern /PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 10 10] /XStep 20 /YStep 20 /Resources << >> /Length 21 >>\nstream\n0 0 1 rg 0 0 10 10 re f\nendstream";
    let c = "/Pattern cs /P0 scn 0 0 40 40 re f";
    let page = read(&pdf(
        200.0,
        200.0,
        &format!("/Pattern << /P0 {} 0 R >>", obj(1, 0)),
        c,
        &[Obj(pattern.into())],
    ));
    assert_eq!(loss(&page, "pattern.tiling_expanded"), 1);
    assert!(paths(&page.items).len() >= 4, "{:?}", page.items);
}

#[test]
#[allow(non_snake_case)]
fn a_function_shading_is_sampled__feat__editor_shell_import_svg_pdf_vectors() {
    let sh = "<< /ShadingType 1 /ColorSpace /DeviceGray /Domain [0 200 0 200] /Function << /FunctionType 2 /Domain [0 200] /C0 [0] /C1 [1] /N 1 >> >>";
    let c = "q 0 0 100 100 re W n /Sh0 sh Q";
    let page = read(&pdf(
        200.0,
        200.0,
        &format!("/Shading << /Sh0 {} 0 R >>", obj(1, 0)),
        c,
        &[Obj(sh.into())],
    ));
    assert_eq!(loss(&page, "shading.function_sampled"), 1);
}

#[test]
#[allow(non_snake_case)]
fn inspect_counts_pages_and_refuses_what_is_not_a_pdf__feat__editor_shell_import_svg_pdf_vectors() {
    let two = support::pdf_pages(&[(100.0, 200.0, "", ""), (300.0, 150.0, "", "")], &[]);
    let info = inspect(&two).expect("inspect");
    assert_eq!(info.format, "pdf");
    assert_eq!(info.pages.len(), 2);
    assert_eq!(
        (info.pages[1].width_pt, info.pages[1].height_pt),
        (300.0, 150.0)
    );
    assert_eq!(inspect(b"\x89PNG\r\n\x1a\n"), Err(ReadError::NotPdf));
    assert!(matches!(
        read_page(&two, 5, &ReadOptions::default()),
        Err(ReadError::NoSuchPage { page: 5, count: 2 })
    ));
}

#[test]
#[allow(non_snake_case)]
fn an_illustrator_file_without_pdf_content_is_refused__feat__editor_shell_import_svg_pdf_vectors() {
    // Illustrator's stand-in page, in the words it writes.
    let c = "BT /F0 12 Tf 30 100 Td (This is an Adobe Illustrator File that was) Tj 0 -14 Td (saved without PDF Content.) Tj ET";
    let mut bytes = pdf(200.0, 200.0, "", c, &[]);
    bytes.extend_from_slice(b"\n% /AIPrivateData1 marker\n");
    assert!(matches!(inspect(&bytes), Err(ReadError::AiWithoutPdf(_))));
    let ps = b"%!PS-Adobe-3.0\n%%Creator: Adobe Illustrator(R) 8.0\n";
    assert!(matches!(inspect(ps), Err(ReadError::AiWithoutPdf(_))));
}
