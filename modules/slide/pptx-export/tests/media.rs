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

//! Video and audio (slide ADR 718, engine ADR 1027): the `media` fixture
//! (PowerPoint-saved: an embedded video that plays automatically at 40 %,
//! looped and hidden while not playing, trimmed; an audio that plays on
//! the first click) is imported as movie and sound frames whose media are
//! parts of the document, and written back: unedited as the deck was, an
//! edited medium with its trim and timing, a medium made in the editor as
//! PowerPoint writes one. Media parts keep their bytes.

use std::collections::BTreeMap;
use std::path::PathBuf;

use paged_model::{Bounds, FrameRef, MediaItem, MediaKind, MediaPlay, MediaSource, Rectangle};
use paged_scene::Document;
use pptx_export::{export_with, native, ExportPlan, Exported, SlidePlan};

fn fixture(name: &str) -> Vec<u8> {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join(format!("../slide-conformance/fixtures/{name}.pptx"));
    std::fs::read(p).unwrap()
}

fn part(bytes: &[u8], name: &str) -> Option<Vec<u8>> {
    let pkg = paged_ooxml::opc::OpcPackage::read(bytes).unwrap();
    pkg.part(name).map(<[u8]>::to_vec)
}

fn text(bytes: &[u8], name: &str) -> String {
    String::from_utf8(part(bytes, name).unwrap()).unwrap()
}

/// The deck as import builds it, and its media parts.
fn imported(bytes: &[u8]) -> (Document, BTreeMap<String, Vec<u8>>) {
    let ir = pptx_import::import_pptx(bytes).unwrap();
    let deck = slide_resolve::resolve(&ir);
    let pkg = paged_ooxml::opc::OpcPackage::read(bytes).unwrap();
    let images = |p: &str| pkg.part(p).map(|b| b.to_vec());
    let built = slide_native::build(&deck, &images, "deck");
    (built.document, built.media)
}

fn plan_of(doc: &Document) -> ExportPlan {
    ExportPlan {
        slides: doc
            .spreads
            .iter()
            .filter_map(|s| {
                let page = s.spread.pages.first()?;
                let id = page.self_id.clone()?;
                let st = native::page_state(&s.spread, &id);
                Some(SlidePlan {
                    source_part: st["part"].as_str().unwrap_or("").to_string(),
                    page_id: Some(id),
                    ..SlidePlan::default()
                })
            })
            .collect(),
        ..ExportPlan::default()
    }
}

fn export(bytes: &[u8], doc: &Document, media: &BTreeMap<String, Vec<u8>>) -> Exported {
    let paged =
        paged_store::package::wrap_document_with_parts(doc, "deck", 960.0, 540.0, media).unwrap();
    export_with(bytes, &plan_of(doc), Some(&paged)).unwrap()
}

fn keep(bytes: &[u8], name: &str) {
    if let Ok(dir) = std::env::var("PAGED_SLIDE_EXPORT_DIR") {
        std::fs::write(PathBuf::from(dir).join(format!("{name}.pptx")), bytes).unwrap();
    }
}

fn media_rects(doc: &Document, slide: usize) -> Vec<&Rectangle> {
    doc.spreads[slide]
        .spread
        .rectangles
        .iter()
        .filter(|r| r.media.is_some())
        .collect()
}

#[test]
#[allow(non_snake_case)]
fn video_and_audio_import_as_movie_and_sound_frames__feat__plugin_slide_media() {
    let bytes = fixture("media");
    let ir = pptx_import::import_pptx(&bytes).unwrap();
    let pic = ir.slides[0]
        .shapes
        .iter()
        .find_map(|s| match s {
            pptx_core::Shape::Pic(p) => p.media.clone(),
            _ => None,
        })
        .expect("slide 1's video");
    assert_eq!(pic.part.as_deref(), Some("ppt/media/media1.mp4"));
    assert_eq!(pic.link, None, "PowerPoint's NULL link is no link");
    assert_eq!(
        (pic.trim_start_ms, pic.trim_end_ms),
        (Some(250.0), Some(500.0))
    );

    let (doc, media) = imported(&bytes);
    let video = media_rects(&doc, 0);
    assert_eq!(video.len(), 1);
    let m = video[0].media.as_ref().unwrap();
    assert_eq!(m.kind, MediaKind::Movie);
    assert_eq!(m.play, MediaPlay::Auto);
    assert!((m.volume - 0.4).abs() < 1e-6, "{}", m.volume);
    assert!(m.looped && m.hide_while_not_playing);
    assert_eq!((m.trim_start_ms, m.trim_end_ms), (250, 500));
    assert_eq!(m.mime.as_deref(), Some("video/mp4"));
    assert!(
        video[0].image_bytes.is_some(),
        "the poster is the frame's picture"
    );
    let path = m.part().expect("an embedded medium is a part");
    assert!(
        path.starts_with("paged/core/media/") && path.ends_with(".mp4"),
        "{path}"
    );
    assert_eq!(
        media.get(path),
        part(&bytes, "ppt/media/media1.mp4").as_ref(),
        "the media part is the deck's bytes"
    );

    let audio = media_rects(&doc, 1);
    assert_eq!(audio.len(), 1);
    let a = audio[0].media.as_ref().unwrap();
    assert_eq!(a.kind, MediaKind::Sound);
    assert_eq!(a.play, MediaPlay::OnClick);
    assert!((a.volume - 0.8).abs() < 1e-6);
    assert_eq!(a.mime.as_deref(), Some("audio/mp4"));
    assert!(!a.looped && !a.hide_while_not_playing);

    // The package the importer hands the host carries the media parts.
    let pkg = paged_ooxml::opc::OpcPackage::read(&bytes).unwrap();
    let images = |p: &str| pkg.part(p).map(|b| b.to_vec());
    let deck = slide_resolve::resolve(&ir);
    let written = slide_native::write(&deck, &images, "deck").unwrap();
    assert_eq!(native::media_parts(&written.paged).len(), 2);
}

#[test]
#[allow(non_snake_case)]
fn an_unedited_media_deck_exports_its_own_bytes__feat__plugin_slide_media() {
    let bytes = fixture("media");
    let (doc, media) = imported(&bytes);
    let out = export(&bytes, &doc, &media);
    assert_eq!(
        out.bytes, bytes,
        "{:?} {:?}",
        out.diagnostics, out.not_exported
    );
}

#[test]
#[allow(non_snake_case)]
fn an_edited_medium_is_written_with_its_trim_and_timing__feat__plugin_slide_media() {
    let bytes = fixture("media");
    let (mut doc, media) = imported(&bytes);
    {
        let r = doc.spreads[0]
            .spread
            .rectangles
            .iter_mut()
            .find(|r| r.media.is_some())
            .unwrap();
        let m = r.media.as_mut().unwrap();
        m.volume = 0.6;
        m.looped = false;
        m.trim_start_ms = 100;
        m.trim_end_ms = 0;
    }
    let out = export(&bytes, &doc, &media);
    keep(&out.bytes, "media-edited");
    assert!(out.not_exported.is_empty(), "{:?}", out.not_exported);
    let slide = text(&out.bytes, "ppt/slides/slide1.xml");
    assert!(slide.contains(r#"<p14:trim st="100"/>"#), "{slide}");
    assert!(slide.contains(r#"<p:cMediaNode vol="60000">"#), "{slide}");
    assert!(!slide.contains("repeatCount=\"indefinite\""), "{slide}");
    assert!(
        slide.contains(r#"display="0""#),
        "still hidden while not playing"
    );
    assert_eq!(slide.matches("<p:video>").count(), 1);
    assert_eq!(
        part(&out.bytes, "ppt/media/media1.mp4"),
        part(&bytes, "ppt/media/media1.mp4"),
        "the medium keeps its bytes"
    );
    assert_eq!(
        part(&out.bytes, "ppt/slides/slide2.xml"),
        part(&bytes, "ppt/slides/slide2.xml"),
        "the other slide keeps its bytes"
    );
    // It reads back as edited.
    let (back, _) = imported(&out.bytes);
    let m = media_rects(&back, 0)[0].media.clone().unwrap();
    assert!((m.volume - 0.6).abs() < 1e-6);
    assert_eq!((m.trim_start_ms, m.trim_end_ms, m.looped), (100, 0, false));
}

/// A movie made in the editor: `clip` placed on slide 2 with a poster.
fn place_movie(
    doc: &mut Document,
    media: &mut BTreeMap<String, Vec<u8>>,
    clip: &[u8],
    play: MediaPlay,
) {
    let path = paged_store::media_part_path(clip, "mp4");
    media.insert(path.clone(), clip.to_vec());
    let poster =
        b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR\0\0\0\x10\0\0\0\x09\x08\x06\0\0\0\0\0\0\0".to_vec();
    let sp = &mut doc.spreads[1].spread;
    let r = Rectangle {
        item_transform: Some([1.0, 0.0, 0.0, 1.0, 100.0, 80.0]),
        image_bytes: Some(poster),
        has_image_element: true,
        media: Some(MediaItem {
            mime: Some("video/mp4".into()),
            name: Some("clip.mp4".into()),
            play,
            volume: 0.5,
            ..MediaItem::new(MediaKind::Movie, MediaSource::Part { path })
        }),
        ..Rectangle::new(
            "newmovie",
            Bounds {
                top: 0.0,
                left: 0.0,
                bottom: 90.0,
                right: 160.0,
            },
        )
    };
    sp.rectangles.push(r);
    sp.frames_in_order
        .push(FrameRef::Rectangle(sp.rectangles.len() - 1));
}

#[test]
#[allow(non_snake_case)]
fn a_medium_made_in_the_editor_is_written_as_powerpoint_writes_one__feat__plugin_slide_media() {
    let bytes = fixture("media");
    let clip = part(&bytes, "ppt/media/media1.mp4").unwrap();
    // A clip of its own, so it gets a part of its own.
    let mut own = clip.clone();
    own.extend_from_slice(b"\0\0\0\x08free");
    let (mut doc, mut media) = imported(&bytes);
    place_movie(&mut doc, &mut media, &own, MediaPlay::OnClick);
    let out = export(&bytes, &doc, &media);
    keep(&out.bytes, "media-new");
    assert!(out.not_exported.is_empty(), "{:?}", out.not_exported);
    let slide = text(&out.bytes, "ppt/slides/slide2.xml");
    let pic = &slide[slide.rfind("<p:pic>").unwrap()..];
    assert!(pic.contains(r#"action="ppaction://media""#), "{pic}");
    assert!(pic.contains("<a:videoFile r:link="), "{pic}");
    assert!(pic.contains("<p14:media "), "{pic}");
    let rels = text(&out.bytes, "ppt/slides/_rels/slide2.xml.rels");
    assert!(
        rels.contains(r#"Target="NULL" TargetMode="External""#),
        "{rels}"
    );
    let target = rels
        .split("<Relationship ")
        .find(|r| r.contains("2007/relationships/media") && r.contains("media3"))
        .expect("the new medium's relationship");
    assert!(target.contains("../media/media3.mp4"), "{target}");
    assert_eq!(part(&out.bytes, "ppt/media/media3.mp4"), Some(own));
    // Slide 2 had a timing: the new movie's node joins it.
    assert_eq!(slide.matches("<p:video>").count(), 1, "{slide}");
    assert_eq!(slide.matches("<p:audio>").count(), 1);
    // It imports again as the movie it was.
    let (back, _) = imported(&out.bytes);
    let m = back.spreads[1]
        .spread
        .rectangles
        .iter()
        .filter_map(|r| r.media.as_ref())
        .find(|m| m.kind == MediaKind::Movie)
        .expect("the movie reads back");
    assert!((m.volume - 0.5).abs() < 1e-6);
    let ct = text(&out.bytes, "[Content_Types].xml");
    assert!(
        ct.contains(r#"Extension="mp4" ContentType="video/mp4""#),
        "{ct}"
    );
}

#[test]
#[allow(non_snake_case)]
fn a_new_movie_on_a_slide_without_timing_starts_as_it_says__feat__plugin_slide_media() {
    let bytes = fixture("effects");
    let clip = part(&fixture("media"), "ppt/media/media1.mp4").unwrap();
    let ir = pptx_import::import_pptx(&bytes).unwrap();
    let deck = slide_resolve::resolve(&ir);
    let pkg = paged_ooxml::opc::OpcPackage::read(&bytes).unwrap();
    let images = |p: &str| pkg.part(p).map(|b| b.to_vec());
    let built = slide_native::build(&deck, &images, "deck");
    let (mut doc, mut media) = (built.document, built.media);
    place_movie(&mut doc, &mut media, &clip, MediaPlay::Auto);
    let out = export(&bytes, &doc, &media);
    keep(&out.bytes, "media-auto");
    assert!(out.not_exported.is_empty(), "{:?}", out.not_exported);
    let slide = text(&out.bytes, "ppt/slides/slide2.xml");
    assert!(slide.contains(r#"presetClass="mediacall""#), "{slide}");
    assert!(slide.contains(r#"evt="onBegin""#), "{slide}");
    let (back, _) = imported(&out.bytes);
    let m = back.spreads[1]
        .spread
        .rectangles
        .iter()
        .find_map(|r| r.media.clone())
        .expect("the movie reads back");
    assert_eq!(m.play, MediaPlay::Auto);
}
