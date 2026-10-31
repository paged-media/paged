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

//! Engine ADR 1037 — `frameImageAdjustments` through the canvas model: a
//! placed picture is drawn through its stack, the write reads back,
//! redraws and undoes; out-of-range ops are refused; the IDML export keeps
//! the stack in a label (and reports it), the import reads it back; a
//! `.paged` keeps it.

use paged_canvas::{
    channel::{ByteBuf, Mutation},
    element_selection::ElementId,
    CanvasModel, CanvasOptions, PageId,
};
use paged_compose::DisplayCommand;
use paged_model::RasterOp;
use paged_mutate::{PropertyPath, Value};

fn png(w: u32, h: u32) -> Vec<u8> {
    let img = image::RgbaImage::from_pixel(w, h, image::Rgba([200, 30, 30, 255]));
    let mut out = std::io::Cursor::new(Vec::new());
    img.write_to(&mut out, image::ImageFormat::Png)
        .expect("encode png");
    out.into_inner()
}

/// A geometry sample with one rectangle placing an 8×8 red picture.
fn model() -> (CanvasModel, ElementId) {
    let sample = paged_gen::samples::build("geometry").expect("geometry sample");
    let bytes = paged_gen::write_idml(&sample).expect("write idml");
    let mut m = CanvasModel::load("image-adjust", &bytes, CanvasOptions::default()).expect("load");
    let page_id = PageId(m.pages()[0].self_id.clone());
    let id = m
        .apply_mutation(&Mutation::InsertFrame {
            page_id,
            bounds: (100.0, 100.0, 260.0, 220.0),
        })
        .expect("insert")
        .created_id
        .expect("created");
    m.apply_mutation(&Mutation::ReplaceImageBytes {
        element_id: id.raw_id().to_string(),
        bytes: Some(ByteBuf(png(8, 8))),
    })
    .expect("image bytes");
    (m, id)
}

/// The first picture drawn on page one: its size and first pixel.
fn drawn(m: &CanvasModel) -> ((u32, u32), [u8; 4]) {
    let page = PageId(m.pages()[0].self_id.clone());
    let list = m.display_list_for_page(&page).expect("display list");
    let id = list
        .commands
        .iter()
        .find_map(|c| match c {
            DisplayCommand::Image { image_id, .. } => Some(*image_id),
            _ => None,
        })
        .expect("an image is drawn");
    let img = list.image(id).expect("pooled");
    let px: [u8; 4] = img.rgba[..4].try_into().expect("decoded pixels");
    ((img.width, img.height), px)
}

fn set(m: &mut CanvasModel, id: &ElementId, ops: Vec<RasterOp>) -> Result<(), String> {
    m.apply_mutation(&Mutation::SetElementProperty {
        element_id: id.clone(),
        path: PropertyPath::FrameImageAdjustments,
        value: Value::ImageAdjustments(ops),
    })
    .map(|_| ())
    .map_err(|e| format!("{e:?}"))
}

fn read(m: &CanvasModel, id: &ElementId) -> Option<Value> {
    m.element_properties(id)?
        .entries
        .into_iter()
        .find(|e| e.path == PropertyPath::FrameImageAdjustments)
        .and_then(|e| e.value)
}

#[test]
#[allow(non_snake_case)]
fn the_stack_is_set_drawn_and_undone__feat__images_graphics_image_filter_stack() {
    let (mut m, id) = model();
    assert_eq!(read(&m, &id), Some(Value::ImageAdjustments(vec![])));
    assert_eq!(drawn(&m).1, [200, 30, 30, 255]);

    set(&mut m, &id, vec![RasterOp::Invert]).expect("set");
    assert_eq!(
        read(&m, &id),
        Some(Value::ImageAdjustments(vec![RasterOp::Invert]))
    );
    assert_eq!(drawn(&m).1, [55, 225, 225, 255], "drawn through the stack");

    set(
        &mut m,
        &id,
        vec![RasterOp::Invert, RasterOp::Threshold { level: 0.5 }],
    )
    .expect("set");
    assert_eq!(drawn(&m).1, [255, 255, 255, 255]);

    m.undo().expect("undo");
    assert_eq!(drawn(&m).1, [55, 225, 225, 255]);
    m.undo().expect("undo");
    assert_eq!(read(&m, &id), Some(Value::ImageAdjustments(vec![])));
    assert_eq!(drawn(&m).1, [200, 30, 30, 255], "undo restores the picture");
}

#[test]
#[allow(non_snake_case)]
fn an_op_out_of_range_is_refused__feat__images_graphics_image_filter_stack() {
    let (mut m, id) = model();
    let err = set(&mut m, &id, vec![RasterOp::Threshold { level: 3.0 }]).unwrap_err();
    assert!(err.contains("threshold"), "{err}");
    assert_eq!(read(&m, &id), Some(Value::ImageAdjustments(vec![])));
}

#[test]
#[allow(non_snake_case)]
fn the_idml_export_keeps_the_stack_in_a_label_and_reports_it__feat__images_graphics_image_filter_stack(
) {
    let (mut m, id) = model();
    let clean = m.idml_export_losses();
    let ops = vec![
        RasterOp::Exposure { ev: 0.5 },
        RasterOp::Duotone {
            shadow: [0.1, 0.1, 0.3],
            highlight: [1.0, 0.9, 0.7],
        },
    ];
    set(&mut m, &id, ops.clone()).expect("set");
    let losses: Vec<String> = m
        .idml_export_losses()
        .into_iter()
        .filter(|l| !clean.contains(l))
        .collect();
    assert_eq!(losses.len(), 1, "{losses:?}");
    assert!(losses[0].contains(id.raw_id()), "{}", losses[0]);
    assert!(losses[0].contains("exposure, duotone"), "{}", losses[0]);

    let bytes = m.export_idml().expect("export");
    let twin = idml_import::import_idml_doc(&bytes).expect("re-import");
    let rect = twin.spreads[0]
        .spread
        .rectangles
        .iter()
        .find(|r| r.self_id.as_deref() == Some(id.raw_id()))
        .expect("the frame is written");
    assert_eq!(
        rect.image_adjustments, ops,
        "the label brings the stack back"
    );
    assert!(
        twin.spreads[0]
            .spread
            .labels
            .get(id.raw_id())
            .is_none_or(|l| l
                .iter()
                .all(|(k, _)| k != paged_model::image_adjust::IMAGE_ADJUSTMENTS_LABEL)),
        "the label is the frame's again, not a free label"
    );

    // Cleared, the next export drops the label.
    set(&mut m, &id, vec![]).expect("clear");
    let bytes = m.export_idml().expect("export");
    let twin = idml_import::import_idml_doc(&bytes).expect("re-import");
    assert!(twin.spreads[0]
        .spread
        .rectangles
        .iter()
        .all(|r| r.image_adjustments.is_empty()));
}

#[test]
#[allow(non_snake_case)]
fn the_stack_survives_paged__feat__images_graphics_image_filter_stack() {
    let (mut m, id) = model();
    set(&mut m, &id, vec![RasterOp::Blur { radius: 1.5 }]).expect("set");
    m.refresh_model_part().expect("refresh model part");
    let bytes = m
        .export_paged(paged_canvas::channel::PROTOCOL_VERSION.0)
        .expect("export .paged");
    let reloaded = CanvasModel::load("image-adjust-reloaded", &bytes, CanvasOptions::default())
        .expect("reload");
    assert_eq!(
        read(&reloaded, &id),
        Some(Value::ImageAdjustments(vec![RasterOp::Blur {
            radius: 1.5
        }]))
    );
}
