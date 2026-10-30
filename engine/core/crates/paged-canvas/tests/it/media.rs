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

//! Engine ADR 1027 — movie and sound items through the canvas model: a
//! frame's `frameMedia` reads, writes and undoes; a medium out of range is
//! refused; the frame keeps drawing its poster; the IDML export keeps the
//! medium in a label (and reports it), the import reads it back; a `.paged`
//! keeps it with its media part; the media folder is write-once.

use paged_canvas::{
    channel::{ByteBuf, Mutation},
    element_selection::ElementId,
    CanvasModel, CanvasOptions, PageId,
};
use paged_compose::DisplayCommand;
use paged_model::{MediaItem, MediaKind, MediaPlay, MediaSource};
use paged_mutate::{PropertyPath, Value};

const PART: &str = "paged/core/media/5f2b.mp4";

fn png(w: u32, h: u32) -> Vec<u8> {
    let img = image::RgbaImage::from_pixel(w, h, image::Rgba([20, 90, 200, 255]));
    let mut out = std::io::Cursor::new(Vec::new());
    img.write_to(&mut out, image::ImageFormat::Png)
        .expect("encode png");
    out.into_inner()
}

/// A geometry sample with one picture frame: the poster.
fn model() -> (CanvasModel, ElementId) {
    let sample = paged_gen::samples::build("geometry").expect("geometry sample");
    let bytes = paged_gen::write_idml(&sample).expect("write idml");
    let mut m = CanvasModel::load("media", &bytes, CanvasOptions::default()).expect("load");
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
    .expect("poster bytes");
    (m, id)
}

fn movie() -> MediaItem {
    MediaItem {
        mime: Some("video/mp4".into()),
        name: Some("clip.mp4".into()),
        play: MediaPlay::Auto,
        looped: true,
        volume: 0.5,
        trim_start_ms: 250,
        trim_end_ms: 1000,
        hide_while_not_playing: true,
        ..MediaItem::new(MediaKind::Movie, MediaSource::Part { path: PART.into() })
    }
}

fn set(m: &mut CanvasModel, id: &ElementId, media: Option<MediaItem>) -> Result<(), String> {
    m.apply_mutation(&Mutation::SetElementProperty {
        element_id: id.clone(),
        path: PropertyPath::FrameMedia,
        value: Value::Media(media),
    })
    .map(|_| ())
    .map_err(|e| format!("{e:?}"))
}

fn read(m: &CanvasModel, id: &ElementId) -> Option<Value> {
    m.element_properties(id)?
        .entries
        .into_iter()
        .find(|e| e.path == PropertyPath::FrameMedia)
        .and_then(|e| e.value)
}

/// Whether page one draws a picture (the poster).
fn draws_poster(m: &CanvasModel) -> bool {
    let page = PageId(m.pages()[0].self_id.clone());
    let list = m.display_list_for_page(&page).expect("display list");
    list.commands
        .iter()
        .any(|c| matches!(c, DisplayCommand::Image { .. }))
}

#[test]
#[allow(non_snake_case)]
fn a_frame_becomes_a_movie_and_back__feat__slide_media() {
    let (mut m, id) = model();
    assert_eq!(read(&m, &id), Some(Value::Media(None)));
    set(&mut m, &id, Some(movie())).expect("set");
    assert_eq!(read(&m, &id), Some(Value::Media(Some(movie()))));
    assert!(
        draws_poster(&m),
        "the engine draws the poster, never the medium"
    );
    m.undo().expect("undo");
    assert_eq!(read(&m, &id), Some(Value::Media(None)));
    m.redo().expect("redo");
    assert_eq!(read(&m, &id), Some(Value::Media(Some(movie()))));
    set(&mut m, &id, None).expect("clear");
    assert_eq!(read(&m, &id), Some(Value::Media(None)));
}

#[test]
#[allow(non_snake_case)]
fn a_medium_out_of_range_is_refused__feat__slide_media() {
    let (mut m, id) = model();
    let bad = MediaItem {
        source: MediaSource::Part {
            path: "designmap.xml".into(),
        },
        ..movie()
    };
    let err = set(&mut m, &id, Some(bad)).unwrap_err();
    assert!(err.contains("out of its range"), "{err}");
    assert_eq!(read(&m, &id), Some(Value::Media(None)));
}

#[test]
#[allow(non_snake_case)]
fn the_idml_export_keeps_the_medium_in_a_label_and_reports_it__feat__slide_media() {
    let (mut m, id) = model();
    let clean = m.idml_export_losses();
    set(&mut m, &id, Some(movie())).expect("set");
    let losses: Vec<String> = m
        .idml_export_losses()
        .into_iter()
        .filter(|l| !clean.contains(l))
        .collect();
    assert_eq!(losses.len(), 1, "{losses:?}");
    assert!(losses[0].contains(id.raw_id()), "{}", losses[0]);
    assert!(losses[0].contains(PART), "{}", losses[0]);

    let bytes = m.export_idml().expect("export");
    let twin = idml_import::import_idml_doc(&bytes).expect("re-import");
    let rect = twin.spreads[0]
        .spread
        .rectangles
        .iter()
        .find(|r| r.self_id.as_deref() == Some(id.raw_id()))
        .expect("the frame is written");
    assert_eq!(
        rect.media,
        Some(movie()),
        "the label brings the medium back"
    );
    assert!(
        rect.has_image_element,
        "InDesign gets the poster's picture frame"
    );

    set(&mut m, &id, None).expect("clear");
    let bytes = m.export_idml().expect("export");
    let twin = idml_import::import_idml_doc(&bytes).expect("re-import");
    assert!(twin.spreads[0]
        .spread
        .rectangles
        .iter()
        .all(|r| r.media.is_none()));
}

#[test]
#[allow(non_snake_case)]
fn the_medium_and_its_part_survive_paged__feat__slide_media() {
    let (mut m, id) = model();
    let clip = b"\x00\x00\x00\x18ftypmp42 not really a movie".to_vec();
    m.set_paged_part_as(Some("media.paged.slide"), PART.into(), clip.clone())
        .expect("any caller adds a media part");
    set(&mut m, &id, Some(movie())).expect("set");
    m.refresh_model_part().expect("refresh model part");
    let bytes = m
        .export_paged(paged_canvas::channel::PROTOCOL_VERSION.0)
        .expect("export .paged");
    let reloaded =
        CanvasModel::load("media-reloaded", &bytes, CanvasOptions::default()).expect("reload");
    assert_eq!(read(&reloaded, &id), Some(Value::Media(Some(movie()))));
    assert_eq!(reloaded.get_paged_part(PART), Some(clip));
}

#[test]
#[allow(non_snake_case)]
fn a_media_part_is_never_changed__feat__slide_media() {
    let (mut m, _) = model();
    m.set_paged_part_as(Some("a.plugin"), PART.into(), b"one".to_vec())
        .expect("added");
    m.set_paged_part_as(Some("b.plugin"), PART.into(), b"one".to_vec())
        .expect("the same bytes again are a no-op");
    let err = m
        .set_paged_part_as(Some("b.plugin"), PART.into(), b"two".to_vec())
        .unwrap_err();
    assert!(err.contains("never changed"), "{err}");
    assert_eq!(m.get_paged_part(PART), Some(b"one".to_vec()));
    assert!(m
        .set_paged_part_as(
            Some("a.plugin"),
            "paged/core/media/sub/x.mp4".into(),
            vec![1]
        )
        .is_err());
    assert!(m
        .set_paged_part_as(Some("a.plugin"), "paged/core/model/x".into(), vec![1])
        .is_err());
}
