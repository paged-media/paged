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

//! Engine ADR 1018 — SVG import and export through the canvas model.
//!
//! Every SVG here is written in the test. Each import is planned by the
//! model (`svg_import_plan`), applied as the one batch it is, and then
//! checked where it matters: in the document (kinds, paint, structure),
//! in the pixels of the page, and in the undo log (one step).

use paged_canvas::{
    channel::Mutation, render_snapshot_request, CanvasModel, CanvasOptions, ElementId, FontEntry,
    PageId, SnapshotFormat, SnapshotRequest,
};
use paged_svg::{SvgExportOptions, SvgImportOptions, SvgImportPlan, SvgTextMode};

fn corpus(rel: &str) -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../corpus")
        .join(rel)
}

fn blank_with(fonts: Vec<FontEntry>) -> (CanvasModel, PageId) {
    let idml = paged_canvas::blank::blank_idml(612.0, 792.0);
    let opts = CanvasOptions {
        font_registry: fonts,
        ..CanvasOptions::default()
    };
    let m = CanvasModel::load("svg", &idml, opts).expect("load");
    let page = PageId(m.pages()[0].self_id.clone());
    (m, page)
}

fn blank() -> (CanvasModel, PageId) {
    blank_with(Vec::new())
}

fn inter() -> FontEntry {
    let mut e = paged_canvas::font_registry_from_paths(&[corpus("fonts/Inter.ttf")]);
    e.remove(0)
}

/// The SVG's user units are the page's points, its corner on the page's.
fn at_origin() -> SvgImportOptions {
    SvgImportOptions {
        origin: Some([0.0, 0.0]),
        ..SvgImportOptions::default()
    }
}

fn import(m: &mut CanvasModel, page: &PageId, svg: &str, o: &SvgImportOptions) -> SvgImportPlan {
    let plan = m.svg_import_plan(page, svg.as_bytes(), o);
    assert!(plan.error.is_none(), "{:?}", plan.error);
    let batch = plan.mutation.clone().expect("the SVG draws something");
    m.apply_mutation(&batch)
        .unwrap_or_else(|e| panic!("the batch applies: {e:?}\n{batch:#?}"));
    plan
}

/// Page items on the first spread (top-level and nested).
fn counts(m: &CanvasModel) -> (usize, usize, usize, usize) {
    let s = &m.scene().spreads[0].spread;
    (
        s.polygons.len(),
        s.rectangles.len(),
        s.text_frames.len(),
        s.groups.len(),
    )
}

/// The page drawn at 72 dpi (one pixel per point), RGBA.
fn pixels(m: &CanvasModel, page: &PageId) -> (u32, Vec<u8>) {
    let snap = render_snapshot_request(
        m,
        &SnapshotRequest {
            dpi: Some(72.0),
            format: SnapshotFormat::Rgba,
            ..SnapshotRequest::page(page, 612)
        },
    )
    .expect("snapshot");
    (snap.width_px, snap.rgba)
}

fn px(img: &(u32, Vec<u8>), x: u32, y: u32) -> [u8; 3] {
    let i = ((y * img.0 + x) * 4) as usize;
    [img.1[i], img.1[i + 1], img.1[i + 2]]
}

fn near(a: [u8; 3], b: [u8; 3], tol: i32) -> bool {
    a.iter()
        .zip(b.iter())
        .all(|(x, y)| (*x as i32 - *y as i32).abs() <= tol)
}

const WHITE: [u8; 3] = [255, 255, 255];

#[test]
#[allow(non_snake_case)]
fn shapes_land_with_their_paint_as_one_undo_step__feat__editor_shell_import_svg_pdf_vectors() {
    let (mut m, page) = blank();
    let svg = r##"<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200">
        <rect x="10" y="10" width="80" height="40" fill="#ff0000"/>
        <circle cx="150" cy="50" r="30" fill="#0000ff" stroke="#00ff00" stroke-width="4"
                stroke-dasharray="6 3" stroke-linecap="round" stroke-linejoin="bevel"/>
        <path d="M10 120 L90 120 L50 190 Z" fill="#00ff00" fill-opacity="0.5"/>
    </svg>"##;
    let plan = import(&mut m, &page, svg, &at_origin());
    assert!(plan.report.is_exact(), "{:?}", plan.report);
    let (polys, _, _, groups) = counts(&m);
    assert_eq!((polys, groups), (3, 1), "three shapes, grouped once");

    let img = pixels(&m, &page);
    assert!(
        near(px(&img, 50, 30), [255, 0, 0], 2),
        "{:?}",
        px(&img, 50, 30)
    );
    assert!(
        near(px(&img, 150, 50), [0, 0, 255], 2),
        "{:?}",
        px(&img, 150, 50)
    );
    // Half-opaque green over paper.
    assert!(
        near(px(&img, 50, 150), [128, 255, 128], 6),
        "{:?}",
        px(&img, 50, 150)
    );
    assert_eq!(px(&img, 120, 150), WHITE);

    // The stroke's properties are native.
    let s = &m.scene().spreads[0].spread;
    let circle = s
        .polygons
        .iter()
        .find(|p| p.stroke_color.is_some())
        .expect("the stroked circle");
    assert_eq!(circle.stroke_weight, Some(4.0));
    assert_eq!(circle.end_join.as_deref(), Some("BevelEndJoin"));

    m.undo().expect("undo");
    assert_eq!(counts(&m), (0, 0, 0, 0), "one undo removes the whole file");
    assert!(m.undo().is_none(), "and it was the only step");
}

#[test]
#[allow(non_snake_case)]
fn use_defs_symbol_and_css_classes_resolve() {
    let (mut m, page) = blank();
    let svg = r##"<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="300" height="100">
        <style>.hot { fill: #ff0000 } #b { fill: #0000ff }</style>
        <defs><rect id="sq" width="40" height="40"/></defs>
        <symbol id="dot" viewBox="0 0 10 10"><circle cx="5" cy="5" r="5"/></symbol>
        <use xlink:href="#sq" x="10" y="10" class="hot"/>
        <use href="#sq" x="60" y="10" id="b"/>
        <use href="#dot" x="120" y="10" width="40" height="40" fill="#00ff00"/>
    </svg>"##;
    let plan = import(&mut m, &page, svg, &at_origin());
    assert!(plan.report.is_exact(), "{:?}", plan.report);
    let img = pixels(&m, &page);
    assert!(near(px(&img, 30, 30), [255, 0, 0], 2));
    assert!(near(px(&img, 80, 30), [0, 0, 255], 2));
    assert!(near(px(&img, 140, 30), [0, 255, 0], 2));
    assert_eq!(px(&img, 105, 30), WHITE);
}

#[test]
#[allow(non_snake_case)]
fn nested_transforms_are_baked_into_the_anchors() {
    let (mut m, page) = blank();
    let svg = r##"<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300">
        <g transform="translate(100 100)"><g transform="rotate(45)"><g transform="scale(2)">
            <rect x="-10" y="-10" width="20" height="20" fill="#000000"/>
        </g></g></g>
    </svg>"##;
    import(&mut m, &page, svg, &at_origin());
    let img = pixels(&m, &page);
    // A 40-pt square turned 45°: its corners reach 28 pt along the axes.
    assert!(near(px(&img, 100, 100), [0, 0, 0], 2));
    assert!(near(px(&img, 100, 74), [0, 0, 0], 2), "the top corner");
    assert_eq!(
        px(&img, 120, 80),
        WHITE,
        "outside, where the unturned square would be"
    );
}

#[test]
#[allow(non_snake_case)]
fn even_odd_and_a_ring_keep_their_holes__feat__editor_shell_import_svg_pdf_vectors() {
    let (mut m, page) = blank();
    let svg = r##"<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200">
        <path fill-rule="evenodd" fill="#000000" d="M10 10 H110 V110 H10 Z M40 40 H80 V80 H40 Z"/>
        <path fill="#000000" d="M150 10 H250 V110 H150 Z M180 40 V80 H220 V40 Z"/>
    </svg>"##;
    import(&mut m, &page, svg, &at_origin());
    let (polys, ..) = counts(&m);
    assert_eq!(polys, 2, "each shape is one compound element");
    let img = pixels(&m, &page);
    assert!(near(px(&img, 20, 20), [0, 0, 0], 2));
    assert_eq!(px(&img, 60, 60), WHITE, "even-odd hole");
    assert!(near(px(&img, 160, 20), [0, 0, 0], 2));
    assert_eq!(
        px(&img, 200, 60),
        WHITE,
        "non-zero hole wound the other way"
    );
}

#[test]
#[allow(non_snake_case)]
fn gradients_with_stop_opacity_are_native__feat__editor_shell_import_svg_pdf_vectors() {
    let (mut m, page) = blank();
    let svg = r##"<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300">
        <defs>
          <linearGradient id="lg" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#0000ff"/>
          </linearGradient>
          <linearGradient id="fade" gradientUnits="userSpaceOnUse" x1="10" y1="0" x2="210" y2="0">
            <stop offset="0" stop-color="#000000" stop-opacity="1"/>
            <stop offset="1" stop-color="#000000" stop-opacity="0"/>
          </linearGradient>
          <radialGradient id="rg" cx="250" cy="250" r="40" gradientUnits="userSpaceOnUse">
            <stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#00aa00"/>
          </radialGradient>
        </defs>
        <rect x="10" y="10" width="200" height="50" fill="url(#lg)"/>
        <rect x="10" y="100" width="200" height="50" fill="url(#fade)"/>
        <circle cx="250" cy="250" r="40" fill="url(#rg)"/>
    </svg>"##;
    let plan = import(&mut m, &page, svg, &at_origin());
    assert!(plan.report.is_exact(), "{:?}", plan.report);
    assert_eq!(
        m.scene().palette.gradients.len(),
        3,
        "three native gradients"
    );
    let img = pixels(&m, &page);
    let left = px(&img, 15, 35);
    let right = px(&img, 205, 35);
    assert!(left[0] > 200 && left[2] < 60, "red at the start: {left:?}");
    assert!(
        right[2] > 200 && right[0] < 60,
        "blue at the end: {right:?}"
    );
    // The stop opacity is a feather on the same axis: dark, then paper.
    let a = px(&img, 15, 125);
    let b = px(&img, 205, 125);
    assert!(a[0] < 40, "opaque at the start: {a:?}");
    assert!(b[0] > 220, "clear at the end: {b:?}");
    // Radial: white centre, green rim.
    let c = px(&img, 250, 250);
    let rim = px(&img, 250, 287);
    assert!(c[0] > 220 && c[2] > 220, "{c:?}");
    assert!(rim[1] > 140 && rim[0] < 80, "{rim:?}");
}

#[test]
#[allow(non_snake_case)]
fn a_clip_path_clips_every_item_of_its_group__feat__editor_shell_import_svg_pdf_vectors() {
    let (mut m, page) = blank();
    let svg = r##"<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300">
        <defs><clipPath id="c"><circle cx="100" cy="100" r="50"/></clipPath></defs>
        <g clip-path="url(#c)">
          <rect x="0" y="0" width="200" height="100" fill="#ff0000"/>
          <rect x="0" y="100" width="200" height="100" fill="#0000ff"/>
        </g>
    </svg>"##;
    let plan = import(&mut m, &page, svg, &at_origin());
    assert!(plan.report.is_exact(), "{:?}", plan.report);
    let s = &m.scene().spreads[0].spread;
    assert_eq!(
        s.nested_children.len(),
        2,
        "each rectangle pasted into a clip frame"
    );
    let img = pixels(&m, &page);
    assert!(near(px(&img, 100, 70), [255, 0, 0], 2));
    assert!(near(px(&img, 100, 130), [0, 0, 255], 2));
    assert_eq!(px(&img, 20, 20), WHITE, "outside the circle");
    assert_eq!(px(&img, 180, 180), WHITE, "outside the circle");
    m.undo().expect("undo");
    assert_eq!(counts(&m), (0, 0, 0, 0));
}

#[test]
#[allow(non_snake_case)]
fn a_mask_is_a_native_opacity_mask() {
    let (mut m, page) = blank();
    let svg = r##"<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300">
        <defs><mask id="k"><rect x="0" y="0" width="100" height="200" fill="#ffffff"/></mask></defs>
        <rect x="0" y="0" width="200" height="200" fill="#ff0000" mask="url(#k)"/>
    </svg>"##;
    let plan = import(&mut m, &page, svg, &at_origin());
    assert!(plan.report.is_exact(), "{:?}", plan.report);
    assert_eq!(m.scene().spreads[0].spread.opacity_masks.len(), 1);
    let img = pixels(&m, &page);
    assert!(
        near(px(&img, 50, 50), [255, 0, 0], 3),
        "{:?}",
        px(&img, 50, 50)
    );
    assert_eq!(px(&img, 150, 50), WHITE, "masked out");
}

/// A 2×2 PNG: red, green / blue, white.
fn png_2x2() -> Vec<u8> {
    let img = image::RgbaImage::from_fn(2, 2, |x, y| match (x, y) {
        (0, 0) => image::Rgba([255, 0, 0, 255]),
        (1, 0) => image::Rgba([0, 255, 0, 255]),
        (0, 1) => image::Rgba([0, 0, 255, 255]),
        _ => image::Rgba([255, 255, 255, 255]),
    });
    let mut out = std::io::Cursor::new(Vec::new());
    img.write_to(&mut out, image::ImageFormat::Png).unwrap();
    out.into_inner()
}

#[test]
#[allow(non_snake_case)]
fn an_embedded_image_is_a_placed_picture() {
    use base64::Engine as _;
    let data = base64::engine::general_purpose::STANDARD.encode(png_2x2());
    let (mut m, page) = blank();
    let svg = format!(
        r##"<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300">
        <image x="10" y="10" width="100" height="100" preserveAspectRatio="none" href="data:image/png;base64,{data}"/>
        <image href="data:image/png;base64,{data}" width="100" height="100" preserveAspectRatio="none" transform="translate(200 150) rotate(90)"/>
        <image href="missing.png" width="10" height="10"/>
    </svg>"##
    );
    let plan = import(&mut m, &page, &svg, &at_origin());
    assert_eq!(plan.report.get("image.external").map(|n| n.count), Some(1));
    let (_, rects, ..) = counts(&m);
    assert_eq!(rects, 2);
    let img = pixels(&m, &page);
    assert!(
        near(px(&img, 30, 30), [255, 0, 0], 8),
        "{:?}",
        px(&img, 30, 30)
    );
    assert!(
        near(px(&img, 90, 30), [0, 255, 0], 8),
        "{:?}",
        px(&img, 90, 30)
    );
    assert!(
        near(px(&img, 30, 90), [0, 0, 255], 8),
        "{:?}",
        px(&img, 30, 90)
    );
    // Turned 90° about (200, 150): the image's top-left (red) is now at
    // the top-right of its box (100..200, 150..250).
    assert!(
        near(px(&img, 180, 170), [255, 0, 0], 8),
        "{:?}",
        px(&img, 180, 170)
    );
    assert!(
        near(px(&img, 120, 230), [255, 255, 255], 8),
        "{:?}",
        px(&img, 120, 230)
    );
}

#[test]
#[allow(non_snake_case)]
fn text_is_a_text_frame_in_a_document_font_and_reported_without_one() {
    let svg = r##"<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200">
        <text x="20" y="60" font-family="Inter" font-size="24" fill="#ff0000">Hello SVG</text>
        <text x="20" y="120" font-family="NoSuchFace" font-size="24">Outlined</text>
    </svg>"##;
    // No font at all: the text cannot be laid out and is reported.
    let (m0, page0) = blank();
    let plan = m0.svg_import_plan(&page0, svg.as_bytes(), &at_origin());
    assert_eq!(plan.report.get("text.noFont").map(|n| n.count), Some(2));

    let (mut m, page) = blank_with(vec![inter()]);
    let plan = import(&mut m, &page, svg, &at_origin());
    let (polys, _, frames, _) = counts(&m);
    assert_eq!(frames, 1, "the Inter line is a text frame");
    assert!(polys > 0, "the other line is its outlines");
    assert!(plan.report.get("text.outlined").is_some());
    let story = m
        .scene()
        .stories
        .iter()
        .find(|s| {
            s.story
                .paragraphs
                .iter()
                .any(|p| p.runs.iter().any(|r| r.text.contains("Hello")))
        })
        .expect("the story");
    let run = &story.story.paragraphs[0].runs[0];
    assert_eq!(run.font.as_deref(), Some("Inter"));
    assert_eq!(run.point_size, Some(24.0));
}

#[test]
#[allow(non_snake_case)]
fn svg_text_options_force_outlines() {
    let svg = r##"<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200">
        <text x="20" y="60" font-family="Inter" font-size="24">Hi</text></svg>"##;
    let (mut m, page) = blank_with(vec![inter()]);
    let o = SvgImportOptions {
        text: Some(paged_svg::SvgImportText::Outlines),
        ..at_origin()
    };
    import(&mut m, &page, svg, &o);
    let (polys, _, frames, _) = counts(&m);
    assert_eq!(frames, 0);
    assert!(polys >= 1);
}

#[test]
#[allow(non_snake_case)]
fn filters_and_patterns_are_reported_not_dropped_silently() {
    let (mut m, page) = blank();
    let svg = r##"<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300">
        <defs>
          <filter id="b"><feGaussianBlur stdDeviation="3"/></filter>
          <pattern id="p" width="10" height="10" patternUnits="userSpaceOnUse"><rect width="5" height="5"/></pattern>
          <radialGradient id="f" cx="0.5" cy="0.5" fx="0.2" fy="0.2" r="0.5"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#000"/></radialGradient>
        </defs>
        <rect x="10" y="10" width="50" height="50" fill="#000" filter="url(#b)"/>
        <rect x="100" y="10" width="50" height="50" fill="url(#p)" stroke="#000"/>
        <rect x="200" y="10" width="50" height="50" fill="url(#f)"/>
    </svg>"##;
    let plan = import(&mut m, &page, svg, &at_origin());
    for code in ["filter", "pattern", "gradient.focal"] {
        assert!(plan.report.get(code).is_some(), "{code}: {:?}", plan.report);
    }
}

#[test]
#[allow(non_snake_case)]
fn a_second_import_reuses_its_swatches() {
    let (mut m, page) = blank();
    let svg = r##"<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="10" height="10" fill="#123456"/></svg>"##;
    import(&mut m, &page, svg, &at_origin());
    let n = m.scene().palette.colors.len();
    let plan = m.svg_import_plan(&page, svg.as_bytes(), &at_origin());
    let Some(Mutation::Batch { ops }) = &plan.mutation else {
        panic!("a batch")
    };
    assert!(!ops
        .iter()
        .any(|o| matches!(o, Mutation::CreateSwatch { .. })));
    m.apply_mutation(plan.mutation.as_ref().unwrap()).unwrap();
    assert_eq!(m.scene().palette.colors.len(), n);
}

#[test]
#[allow(non_snake_case)]
fn an_unreadable_file_is_an_error_not_a_panic() {
    let (m, page) = blank();
    let plan = m.svg_import_plan(&page, b"<svg", &at_origin());
    assert!(plan.error.is_some());
    assert!(plan.mutation.is_none());
}

// ------------------------------------------------------------- export

#[test]
#[allow(non_snake_case)]
fn a_page_exports_as_svg_with_gradients_clips_and_images__feat__editor_shell_import_svg_pdf_vectors(
) {
    use base64::Engine as _;
    let data = base64::engine::general_purpose::STANDARD.encode(png_2x2());
    let (mut m, page) = blank();
    let svg = format!(
        r##"<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300">
        <defs>
          <linearGradient id="lg"><stop offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#0000ff"/></linearGradient>
          <clipPath id="c"><circle cx="200" cy="200" r="40"/></clipPath>
        </defs>
        <rect x="10" y="10" width="100" height="50" fill="url(#lg)" opacity="0.5"/>
        <rect x="150" y="150" width="100" height="100" fill="#00ff00" clip-path="url(#c)"/>
        <rect x="10" y="100" width="50" height="50" fill="#000" style="mix-blend-mode:multiply"/>
        <image x="10" y="200" width="40" height="40" href="data:image/png;base64,{data}"/>
    </svg>"##
    );
    import(&mut m, &page, &svg, &at_origin());
    let (out, report) = m
        .export_svg(&page, &[], &SvgExportOptions::default())
        .expect("export");
    assert!(
        out.starts_with("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"612pt\""),
        "{out}"
    );
    assert!(out.contains("<linearGradient"), "{out}");
    assert!(out.contains("<clipPath"), "{out}");
    assert!(out.contains("mix-blend-mode:multiply"), "{out}");
    assert!(out.contains("data:image/png;base64,"), "{out}");
    assert!(report.items >= 4, "{report:?}");
    // Minified is the same drawing on one line.
    let (min, _) = m
        .export_svg(
            &page,
            &[],
            &SvgExportOptions {
                minify: Some(true),
                ..Default::default()
            },
        )
        .unwrap();
    assert!(!min.trim_end().contains('\n'));
    assert!(min.len() < out.len());
}

#[test]
#[allow(non_snake_case)]
fn import_export_import_is_stable__feat__editor_shell_import_svg_pdf_vectors() {
    let svg = r##"<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300">
        <rect x="10" y="10" width="80" height="40" fill="#ff0000"/>
        <path fill-rule="evenodd" fill="#000000" d="M110 10 H210 V110 H110 Z M140 40 H180 V80 H140 Z"/>
        <circle cx="60" cy="200" r="30" fill="none" stroke="#0000ff" stroke-width="3"/>
    </svg>"##;
    let (mut a, pa) = blank();
    import(&mut a, &pa, svg, &at_origin());
    let (out, _) = a
        .export_svg(&pa, &[], &SvgExportOptions::default())
        .unwrap();
    let (mut b, pb) = blank();
    import(&mut b, &pb, &out, &at_origin());
    assert_eq!(counts(&a).0, counts(&b).0, "the same shapes");
    let (ia, ib) = (pixels(&a, &pa), pixels(&b, &pb));
    let diff =
        ia.1.chunks(4)
            .zip(ib.1.chunks(4))
            .filter(|(x, y)| {
                x.iter()
                    .zip(y.iter())
                    .any(|(p, q)| (*p as i32 - *q as i32).abs() > 24)
            })
            .count();
    assert!(diff < 200, "{diff} pixels differ after a round trip");
    // And its own export is the same document again.
    let (out2, _) = b
        .export_svg(&pb, &[], &SvgExportOptions::default())
        .unwrap();
    assert_eq!(out, out2, "export → import → export is a fixed point");
}

#[test]
#[allow(non_snake_case)]
fn a_selection_exports_alone_fitted_to_what_it_draws() {
    let (mut m, page) = blank();
    let svg = r##"<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300">
        <rect x="10" y="10" width="80" height="40" fill="#ff0000"/>
        <rect x="200" y="200" width="20" height="20" fill="#0000ff"/>
    </svg>"##;
    let o = SvgImportOptions {
        group: Some(false),
        ..at_origin()
    };
    import(&mut m, &page, svg, &o);
    let red = m.scene().spreads[0]
        .spread
        .polygons
        .iter()
        .find(|p| p.fill_color.as_deref() == Some("Color/svg-ff0000"))
        .and_then(|p| p.self_id.clone())
        .expect("the red rectangle");
    let first = ElementId::Polygon(red);
    let (out, report) = m
        .export_svg(&page, &[first], &SvgExportOptions::default())
        .unwrap();
    assert_eq!(report.items, 1, "{out}");
    assert!(out.contains("viewBox=\"10 10 80 40\""), "{out}");
    assert!(!out.contains("#0000ff"));
    assert!(
        out.contains("<path d=\"M10 10L90 10L90 50L10 50L10 10Z\""),
        "corners are lines: {out}"
    );
}

#[test]
#[allow(non_snake_case)]
fn text_exports_as_text_naming_its_font() {
    let svg = r##"<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200">
        <text x="20" y="60" font-family="Inter" font-size="24" fill="#ff0000">Hi</text></svg>"##;
    let (mut m, page) = blank_with(vec![inter()]);
    import(&mut m, &page, svg, &at_origin());
    let (text, rep) = m
        .export_svg(
            &page,
            &[],
            &SvgExportOptions {
                text: Some(SvgTextMode::Text),
                ..Default::default()
            },
        )
        .unwrap();
    assert!(text.contains("font-family=\"Inter\""), "{text} {rep:?}");
    assert!(text.contains(">Hi</text>"), "{text}");
    let (outlines, _) = m
        .export_svg(&page, &[], &SvgExportOptions::default())
        .unwrap();
    assert!(!outlines.contains("<text"), "{outlines}");
}
