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

//! Place as vectors (publish ADR 658): a page lowered into an engine
//! snippet that the engine's own paste (`InsertSnippet`, engine ADR 193)
//! grafts onto a document — native items, one operation, undone whole.

mod support;

use pdf_import::ir::{DocumentIr, PageIr};
use pdf_import::snippet::{place, PlaceRequest};
use support::{obj, pdf, Obj};

fn request(page: usize) -> PlaceRequest {
    serde_json::from_value(serde_json::json!({
        "page": page,
        "placement": [1.0, 0.0, 0.0, 1.0, 50.0, 60.0],
        "name": "art"
    }))
    .expect("request")
}

/// A blank one-page document to paste into.
fn blank() -> paged_scene::Document {
    let ir = DocumentIr {
        pages: vec![PageIr {
            width_pt: 600.0,
            height_pt: 800.0,
            background_png_b64: None,
            frames: Vec::new(),
        }],
    };
    pdf_import::build::build_document(&ir).expect("blank")
}

fn paste(doc: &mut paged_scene::Document, snippet: &str) -> paged_mutate::Operation {
    let spread = doc.spreads[0].spread.self_id.clone().expect("spread id");
    let applied = paged_mutate::apply(
        doc,
        &paged_mutate::Operation::InsertSnippet {
            snippet: snippet.to_string(),
            spread,
            dx: 0.0,
            dy: 0.0,
            ids: Vec::new(),
            story_ids: Vec::new(),
            added: Vec::new(),
        },
    )
    .expect("the engine takes the snippet");
    applied.inverse
}

const ART: &str = "1 0 0 rg 10 10 100 50 re f 0 0 1 RG 2 w 10 100 m 100 150 l S q 120 20 m 180 20 l 150 80 l h W n 0 1 0 rg 100 0 100 100 re f 1 1 0 rg 0 0 300 30 re f Q";

#[test]
#[allow(non_snake_case)]
fn a_page_pastes_as_native_items_and_undoes_whole__feat__editor_shell_import_svg_pdf_vectors() {
    let bytes = pdf(200.0, 200.0, "", ART, &[]);
    let r = place(&bytes, &request(0)).expect("placed");
    assert_eq!(r.counts.clip_groups, 1, "{:?}", r.counts);
    assert!(r.counts.paths >= 3);
    // One group wraps what landed, named after the file.
    let mut doc = blank();
    let before = doc.spreads[0].spread.frames_in_order.len();
    let inverse = paste(&mut doc, &r.snippet);
    let spread = &doc.spreads[0].spread;
    assert_eq!(spread.frames_in_order.len(), before + 1);
    assert!(
        spread.groups.iter().any(|g| g.clip),
        "the clip group landed"
    );
    assert!(spread.item_names.values().any(|n| n == "art"));
    // The red rectangle sits at the placement: (10, 200-10-50) + (50, 60).
    let red = spread
        .polygons
        .iter()
        .find(|p| p.fill_color.as_deref() == Some("Color/pdf_255_0_0"))
        .expect("the red rectangle");
    assert_eq!(red.bounds.left, 60.0);
    assert_eq!(red.bounds.top, 200.0);
    assert!(doc.palette.colors.contains_key("Color/pdf_255_0_0"));
    paged_mutate::apply(&mut doc, &inverse).expect("undo");
    assert_eq!(doc.spreads[0].spread.frames_in_order.len(), before);
    assert!(doc.spreads[0].spread.polygons.is_empty());
}

#[test]
#[allow(non_snake_case)]
fn a_gradient_lands_with_its_ramp_where_the_pdf_drew_it__feat__editor_shell_import_svg_pdf_vectors()
{
    let sh = "<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [20 0 180 0] /Extend [true true] /Function << /FunctionType 2 /Domain [0 1] /C0 [1 0 0] /C1 [0 0 1] /N 1 >> >>";
    let bytes = pdf(
        200.0,
        200.0,
        &format!("/Shading << /Sh0 {} 0 R >>", obj(1, 0)),
        "q 20 50 160 100 re W n /Sh0 sh Q",
        &[Obj(sh.into())],
    );
    let r = place(&bytes, &request(0)).expect("placed");
    assert_eq!(r.counts.gradients, 1);
    let mut doc = blank();
    paste(&mut doc, &r.snippet);
    let p = &doc.spreads[0].spread.polygons[0];
    let id = p.fill_color.as_deref().expect("filled");
    assert!(id.starts_with("Gradient/pdf_"), "{id}");
    assert_eq!(p.gradient_fill_start, Some([70.0, 260.0]));
    assert_eq!(p.gradient_fill_length, Some(160.0));
    assert_eq!(p.gradient_fill_angle, Some(0.0));
    assert!(doc.palette.gradients.contains_key(id));
}

#[test]
#[allow(non_snake_case)]
fn a_soft_mask_lands_as_an_opacity_mask__feat__editor_shell_import_svg_pdf_vectors() {
    let mask_form = "<< /Type /XObject /Subtype /Form /BBox [0 0 200 200] /Group << /S /Transparency /CS /DeviceRGB >> /Length 26 >>\nstream\n1 1 1 rg 40 40 80 80 re f\nendstream";
    let gs = format!(
        "<< /Type /ExtGState /SMask << /S /Luminosity /G {} 0 R >> >>",
        obj(1, 1)
    );
    let bytes = pdf(
        200.0,
        200.0,
        &format!("/ExtGState << /G0 {} 0 R >>", obj(1, 0)),
        "/G0 gs 1 0 0 rg 0 0 200 200 re f",
        &[Obj(gs), Obj(mask_form.into())],
    );
    let r = place(&bytes, &request(0)).expect("placed");
    assert_eq!(r.counts.opacity_masks, 1, "{:?}", r.losses);
    let mut doc = blank();
    let inverse = paste(&mut doc, &r.snippet);
    let spread = &doc.spreads[0].spread;
    assert_eq!(spread.opacity_masks.len(), 1, "the paste carried the mask");
    let (target, mask) = spread.opacity_masks.iter().next().expect("one");
    assert!(spread
        .polygons
        .iter()
        .any(|p| p.self_id.as_deref() == Some(target)));
    assert!(spread
        .polygons
        .iter()
        .any(|p| p.self_id.as_deref() == Some(mask.mask_item.as_str())));
    assert!(!spread
        .frames_in_order
        .iter()
        .any(|r| matches!(r, paged_model::FrameRef::Polygon(i) if spread.polygons[*i].self_id.as_deref() == Some(mask.mask_item.as_str()))));
    paged_mutate::apply(&mut doc, &inverse).expect("undo");
    assert!(doc.spreads[0].spread.opacity_masks.is_empty());
}

#[test]
#[allow(non_snake_case)]
fn text_frames_land_where_their_runs_paint__feat__editor_shell_import_svg_pdf_vectors() {
    // A rectangle, then text the reader cannot draw (an unembedded font):
    // the recovered frame lands on top, with its run's font and size.
    let bytes = pdf(
        200.0,
        200.0,
        "/Font << /F0 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >>",
        "0.9 g 0 0 200 200 re f BT /F0 12 Tf 20 150 Td (Hello) Tj ET",
        &[],
    );
    let mut req = request(0);
    req.text_frames = serde_json::from_value(serde_json::json!([{
        "kind": "text", "x_pt": 18.0, "y_pt": 38.0, "width_pt": 40.0, "height_pt": 16.0,
        "paragraphs": [{ "runs": [{ "text": "Hello", "font_size_pt": 12.0, "font_family": "Helvetica" }] }]
    }]))
    .expect("frames");
    let r = place(&bytes, &req).expect("placed");
    assert_eq!(r.counts.text_frames, 1);
    let mut doc = blank();
    paste(&mut doc, &r.snippet);
    let story = doc
        .stories
        .iter()
        .find(|s| {
            s.story
                .paragraphs
                .iter()
                .any(|p| p.runs.iter().any(|r| r.text == "Hello"))
        })
        .expect("the story landed");
    let run = &story.story.paragraphs[0].runs[0];
    assert_eq!(run.font.as_deref(), Some("Helvetica"));
    assert_eq!(run.point_size, Some(12.0));
}

#[test]
#[allow(non_snake_case)]
fn a_clip_outline_crops_a_converted_frame__feat__editor_shell_import_svg_pdf_vectors() {
    let bytes = pdf(200.0, 200.0, "", ART, &[]);
    let mut req = request(0);
    req.clip = Some(vec![
        [50.0, 60.0],
        [150.0, 60.0],
        [150.0, 160.0],
        [50.0, 160.0],
    ]);
    let r = place(&bytes, &req).expect("placed");
    let mut doc = blank();
    paste(&mut doc, &r.snippet);
    let spread = &doc.spreads[0].spread;
    let root = spread.frames_in_order.last().copied().expect("root");
    let paged_model::FrameRef::Group(gi) = root else {
        panic!("{root:?}");
    };
    assert!(spread.groups[gi].clip, "the root clips to the frame");
}

#[test]
#[allow(non_snake_case)]
fn a_bad_request_is_refused__feat__editor_shell_import_svg_pdf_vectors() {
    let bytes = pdf(200.0, 200.0, "", ART, &[]);
    let mut req = request(0);
    req.placement = [0.0, 0.0, 0.0, 0.0, 0.0, 0.0];
    assert_eq!(place(&bytes, &req).unwrap_err().code(), "invalidRequest");
    assert_eq!(place(&bytes, &request(3)).unwrap_err().code(), "noSuchPage");
    let empty = pdf(200.0, 200.0, "", "", &[]);
    assert_eq!(place(&empty, &request(0)).unwrap_err().code(), "empty");
}

#[test]
#[allow(non_snake_case)]
fn opening_a_pdf_takes_its_vectors_from_the_page_reader__feat__editor_shell_import_svg_pdf_vectors()
{
    // The open path: the IR's polyline vectors are replaced by the page
    // reader's items — the curve keeps its handles, the clip is a clip
    // group — and the IR's text frames stay.
    let content = format!("{ART} 0 0 0 rg 20 190 m 60 199 100 199 140 190 c 140 195 l h f");
    let bytes = pdf(200.0, 200.0, "", &content, &[]);
    let ir: DocumentIr = serde_json::from_value(serde_json::json!({ "pages": [{
        "width_pt": 200.0, "height_pt": 200.0,
        "frames": [
            { "kind": "vector", "subpaths": [{ "points": [{ "x_pt": 0.0, "y_pt": 0.0 }, { "x_pt": 9.0, "y_pt": 9.0 }], "closed": false }] },
            { "kind": "text", "x_pt": 10.0, "y_pt": 10.0, "width_pt": 50.0, "height_pt": 14.0,
              "paragraphs": [{ "runs": [{ "text": "Kept", "font_size_pt": 10.0 }] }] }
        ]
    }]}))
    .expect("ir");
    let doc = pdf_import::build::build_document_from(&ir, Some(&bytes)).expect("built");
    let spread = &doc.spreads[0].spread;
    assert!(spread.groups.iter().any(|g| g.clip), "a clip group");
    assert!(
        spread.polygons.iter().any(|p| p
            .anchors
            .iter()
            .any(|a| a.left != a.anchor || a.right != a.anchor)),
        "a curve keeps its handles"
    );
    assert_eq!(spread.text_frames.len(), 1, "the IR's text frame");
    assert!(!spread
        .polygons
        .iter()
        .any(|p| p.anchors.len() == 2 && p.anchors[1].anchor == (9.0, 9.0)));
    // Without the bytes the IR alone builds the page, as before.
    let ir_only = pdf_import::build::build_document(&ir).expect("built");
    assert_eq!(ir_only.spreads[0].spread.polygons.len(), 1);
}
