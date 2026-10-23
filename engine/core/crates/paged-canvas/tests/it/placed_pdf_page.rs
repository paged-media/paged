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

//! Engine ADR 1003 — the page of a placed PDF, through the object model:
//! `framePdfPage` reads, writes, redraws and undoes; `pdfPageCount`
//! answers how many pages the placed PDF has, so a form can offer 1…N; a
//! frame whose picture is not a PDF refuses a page.

use paged_canvas::{
    channel::{ByteBuf, Mutation},
    CanvasModel, CanvasOptions, PageId,
};
use paged_compose::{DisplayCommand, Paint};
use paged_mutate::Value;
use paged_wire::{ElementId, VirtualTarget};

/// Two pages: 100 × 60 pt of red, then 60 × 100 pt of blue.
fn two_page_pdf() -> Vec<u8> {
    let objects = [
        "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
        "<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>".to_string(),
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 60] /Contents 4 0 R >>".to_string(),
        stream("1 0 0 rg 0 0 100 60 re f"),
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 60 100] /Contents 6 0 R >>".to_string(),
        stream("0 0 1 rg 0 0 60 100 re f"),
    ];
    let mut out = b"%PDF-1.4\n".to_vec();
    let mut offsets = Vec::new();
    for (i, o) in objects.iter().enumerate() {
        offsets.push(out.len());
        out.extend_from_slice(format!("{} 0 obj\n{o}\nendobj\n", i + 1).as_bytes());
    }
    let xref = out.len();
    out.extend_from_slice(
        format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).as_bytes(),
    );
    for off in offsets {
        out.extend_from_slice(format!("{off:010} 00000 n \n").as_bytes());
    }
    out.extend_from_slice(
        format!(
            "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n",
            objects.len() + 1
        )
        .as_bytes(),
    );
    out
}

fn stream(content: &str) -> String {
    format!(
        "<< /Length {} >>\nstream\n{content}\nendstream",
        content.len()
    )
}

fn png() -> Vec<u8> {
    let img = image::RgbaImage::from_pixel(2, 2, image::Rgba([200, 30, 30, 255]));
    let mut out = std::io::Cursor::new(Vec::new());
    img.write_to(&mut out, image::ImageFormat::Png)
        .expect("encode png");
    out.into_inner()
}

/// The geometry sample with a minted picture frame, holding `bytes`.
fn frame_with(bytes: Option<Vec<u8>>) -> (CanvasModel, ElementId) {
    let sample = paged_gen::samples::build("geometry").expect("geometry sample");
    let idml = paged_gen::write_idml(&sample).expect("write idml");
    let mut m = CanvasModel::load("pdf-page", &idml, CanvasOptions::default()).expect("load");
    let page_id = PageId(m.pages()[0].self_id.clone());
    let id = m
        .apply_mutation(&Mutation::InsertFrame {
            page_id,
            bounds: (100.0, 100.0, 200.0, 200.0),
        })
        .expect("insert")
        .created_id
        .expect("the frame's id");
    if let Some(bytes) = bytes {
        m.apply_mutation(&Mutation::ReplaceImageBytes {
            element_id: id.raw_id().to_string(),
            bytes: Some(ByteBuf(bytes)),
        })
        .expect("place the picture");
    }
    (m, id)
}

fn target(id: &ElementId) -> VirtualTarget {
    VirtualTarget::Element {
        element_id: id.clone(),
    }
}

fn set(m: &mut CanvasModel, id: &ElementId, value: Value) -> Result<(), String> {
    m.apply_mutation(&Mutation::Set {
        address: target(id).into(),
        path: "framePdfPage".to_string(),
        value,
    })
    .map(|_| ())
    .map_err(|e| format!("{e:?}"))
}

/// The solid colours the first page's list fills with.
fn fills(m: &CanvasModel) -> Vec<[f32; 3]> {
    let page = PageId(m.pages()[0].self_id.clone());
    m.display_list_for_page(&page)
        .expect("display list")
        .commands
        .iter()
        .filter_map(|c| match c {
            DisplayCommand::FillPath {
                paint: Paint::Solid(c),
                ..
            } => Some([c.r, c.g, c.b]),
            _ => None,
        })
        .collect()
}

const RED: [f32; 3] = [1.0, 0.0, 0.0];
const BLUE: [f32; 3] = [0.0, 0.0, 1.0];

#[test]
fn a_frame_reads_its_pdfs_page_count_and_page() {
    let (m, id) = frame_with(Some(two_page_pdf()));
    assert_eq!(
        m.get_property(&target(&id), "pdfPageCount"),
        Ok(Value::Length(Some(2.0)))
    );
    assert_eq!(
        m.get_property(&target(&id), "framePdfPage"),
        Ok(Value::Length(None))
    );
    // No picture, or one that is not a PDF: no page count.
    let (m, id) = frame_with(None);
    assert_eq!(
        m.get_property(&target(&id), "pdfPageCount"),
        Ok(Value::Length(None))
    );
    let (m, id) = frame_with(Some(png()));
    assert_eq!(
        m.get_property(&target(&id), "pdfPageCount"),
        Ok(Value::Length(None))
    );
}

#[test]
fn the_page_is_set_drawn_and_undone() {
    let (mut m, id) = frame_with(Some(two_page_pdf()));
    let before = fills(&m);
    assert!(
        before.contains(&RED) && !before.contains(&BLUE),
        "{before:?}"
    );
    set(&mut m, &id, Value::Length(Some(2.0))).expect("page 2");
    assert_eq!(
        m.get_property(&target(&id), "framePdfPage"),
        Ok(Value::Length(Some(2.0)))
    );
    let after = fills(&m);
    assert!(after.contains(&BLUE) && !after.contains(&RED), "{after:?}");
    m.undo().expect("undo");
    assert_eq!(
        m.get_property(&target(&id), "framePdfPage"),
        Ok(Value::Length(None))
    );
    assert_eq!(fills(&m), before);
}

#[test]
fn a_page_that_is_no_page_number_or_on_no_pdf_is_refused() {
    let (mut m, id) = frame_with(Some(two_page_pdf()));
    for bad in [0.0, 1.5, -2.0] {
        assert!(
            set(&mut m, &id, Value::Length(Some(bad))).is_err(),
            "{bad} is not a page"
        );
    }
    let (mut m, id) = frame_with(Some(png()));
    let refused = set(&mut m, &id, Value::Length(Some(2.0))).expect_err("a PNG has no pages");
    assert!(refused.contains("not a PDF"), "{refused}");
    let (mut m, id) = frame_with(None);
    let refused = set(&mut m, &id, Value::Length(Some(2.0))).expect_err("no picture");
    assert!(refused.contains("no picture"), "{refused}");
}
