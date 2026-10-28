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

//! Extensions ADR 338 — `render.snapshot@2`: `RequestSnapshot.only`, `clip`,
//! `format: "rgba"` and `background: "transparent"`.

use paged_canvas::{
    render_snapshot_request, CanvasModel, CanvasOptions, ElementId, SnapshotBackground,
    SnapshotClip, SnapshotError, SnapshotFormat, SnapshotPng, SnapshotRequest,
};
use paged_wire::PageId;

fn model(sample: &str) -> CanvasModel {
    let sample = paged_gen::samples::build(sample).expect("sample");
    let bytes = paged_gen::write_idml(&sample).expect("write");
    let inter = std::fs::read(
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../corpus/fonts/Inter.ttf"),
    )
    .expect("Inter.ttf");
    let opts = CanvasOptions {
        fonts: vec![inter],
        ..CanvasOptions::default()
    };
    CanvasModel::load("v2", &bytes, opts).expect("load")
}

fn first_page(m: &CanvasModel) -> PageId {
    PageId(m.pages()[0].self_id.clone())
}

fn rgba(m: &CanvasModel, req: SnapshotRequest<'_>) -> SnapshotPng {
    let snap = render_snapshot_request(
        m,
        &SnapshotRequest {
            format: SnapshotFormat::Rgba,
            ..req
        },
    )
    .expect("snapshot");
    assert_eq!(snap.format, SnapshotFormat::Rgba);
    assert!(snap.png_bytes.is_empty(), "an rgba reply carries no PNG");
    assert_eq!(
        snap.rgba.len(),
        (snap.width_px * snap.height_px * 4) as usize
    );
    snap
}

fn first_rect(m: &CanvasModel) -> String {
    m.scene()
        .spreads
        .iter()
        .flat_map(|s| s.spread.rectangles.iter())
        .find_map(|r| r.self_id.clone())
        .expect("a rectangle")
}

fn px(s: &SnapshotPng, x: u32, y: u32) -> [u8; 4] {
    let i = ((y * s.width_px + x) * 4) as usize;
    s.rgba[i..i + 4].try_into().unwrap()
}

fn close(a: [u8; 4], b: [u8; 4], tol: i32) -> bool {
    a.iter()
        .zip(b)
        .all(|(x, y)| (*x as i32 - y as i32).abs() <= tol)
}

#[test]
#[allow(non_snake_case)]
fn only_draws_the_item_alone_on_a_transparent_ground__feat__plugin_platform_render_snapshot_v2() {
    let m = model("strokes-fills");
    let page = first_page(&m);
    let rect = first_rect(&m);
    let full = rgba(&m, SnapshotRequest::page(&page, 200));
    let only = [ElementId::Rectangle(rect)];
    let alone = rgba(
        &m,
        SnapshotRequest {
            only: &only,
            background: SnapshotBackground::Transparent,
            ..SnapshotRequest::page(&page, 200)
        },
    );
    assert_eq!(
        (alone.width_px, alone.height_px),
        (full.width_px, full.height_px)
    );
    let (mut clear, mut solid) = (0, 0);
    for y in 0..alone.height_px {
        for x in 0..alone.width_px {
            let p = px(&alone, x, y);
            match p[3] {
                0 => {
                    clear += 1;
                    assert_eq!(p, [0, 0, 0, 0], "a clear pixel is clear black");
                }
                255 => {
                    solid += 1;
                    // Drawn where the page draws it: the same pixel.
                    assert!(
                        close(p, px(&full, x, y), 2),
                        "({x},{y}) {p:?} vs {:?}",
                        px(&full, x, y)
                    );
                }
                _ => {}
            }
        }
    }
    assert!(solid > 0, "the rectangle draws");
    assert!(clear > 0, "the rest of the page is transparent");
    // Every other item is gone: the plain page differs from the lone item
    // over paper somewhere.
    assert!(
        (0..full.height_px).any(|y| (0..full.width_px).any(|x| {
            let a = px(&alone, x, y);
            a[3] == 0 && px(&full, x, y) != [255, 255, 255, 255]
        })),
        "something else on the page is left out"
    );
}

#[test]
#[allow(non_snake_case)]
fn only_hides_the_text_of_frames_it_leaves_out__feat__plugin_platform_render_snapshot_v2() {
    let m = model("text");
    let page = first_page(&m);
    let frame = m
        .scene()
        .spreads
        .iter()
        .flat_map(|s| s.spread.text_frames.iter())
        .find(|f| f.self_id.is_some() && f.parent_story.is_some())
        .expect("a text frame")
        .clone();
    let transparent = |only: &[ElementId]| {
        let only = only.to_vec();
        rgba(
            &m,
            SnapshotRequest {
                only: &only,
                background: SnapshotBackground::Transparent,
                ..SnapshotRequest::page(&page, 300)
            },
        )
    };
    let opaque = |s: &SnapshotPng| {
        s.rgba
            .as_chunks::<4>()
            .0
            .iter()
            .filter(|p| p[3] > 0)
            .count()
    };
    let with_frame = transparent(&[ElementId::TextFrame(frame.self_id.clone().unwrap())]);
    assert!(opaque(&with_frame) > 0, "the frame's text draws");
    let nothing = transparent(&[ElementId::Rectangle("no-such-item".into())]);
    assert_eq!(
        opaque(&nothing),
        0,
        "a page with every item left out is empty"
    );
    // A story draws every frame of its thread.
    let story = frame.parent_story.clone().unwrap();
    let by_story = transparent(&[ElementId::StoryRange {
        story_id: story.clone(),
        start: 0,
        end: 0,
    }]);
    let frames: Vec<ElementId> = m
        .scene()
        .spreads
        .iter()
        .flat_map(|s| s.spread.text_frames.iter())
        .filter(|f| f.parent_story.as_deref() == Some(story.as_str()))
        .filter_map(|f| f.self_id.clone().map(ElementId::TextFrame))
        .collect();
    assert_eq!(by_story.rgba, transparent(&frames).rgba);
}

#[test]
#[allow(non_snake_case)]
fn a_clip_draws_the_region_grown_to_whole_pixels__feat__plugin_platform_render_snapshot_v2() {
    let m = model("strokes-fills");
    let page = first_page(&m);
    let full = rgba(
        &m,
        SnapshotRequest {
            dpi: Some(144.0),
            ..SnapshotRequest::page(&page, 0)
        },
    );
    let clip = SnapshotClip {
        x: 30.3,
        y: 41.9,
        width: 120.0,
        height: 90.2,
    };
    let part = rgba(
        &m,
        SnapshotRequest {
            dpi: Some(144.0),
            clip: Some(clip),
            ..SnapshotRequest::page(&page, 0)
        },
    );
    // 144 dpi = 2 px/pt: x 60.6 → 60, right 300.6 → 301; y 83.8 → 83,
    // bottom 264.2 → 265.
    let region = part.region.expect("a clipped reply names its region");
    assert_eq!((part.width_px, part.height_px), (241, 182));
    assert_eq!(
        (region.x, region.y, region.width, region.height),
        (30.0, 41.5, 120.5, 91.0)
    );
    // The region is the page's pixels: the same pixel grid, so only a
    // few antialiased glyph edges may round differently (the rasterizer's
    // fixed-point coverage is not exactly translation-invariant).
    let total = (part.width_px * part.height_px) as usize;
    let off = (0..part.height_px)
        .flat_map(|y| (0..part.width_px).map(move |x| (x, y)))
        .filter(|&(x, y)| !close(px(&part, x, y), px(&full, x + 60, y + 83), 2))
        .count();
    assert!(
        off * 200 < total,
        "{off} of {total} pixels differ from the page"
    );
    // One pixel over, it would not be the page's grid.
    let shifted = (0..part.height_px)
        .flat_map(|y| (0..part.width_px).map(move |x| (x, y)))
        .filter(|&(x, y)| !close(px(&part, x, y), px(&full, x + 61, y + 83), 2))
        .count();
    assert!(shifted > off * 10, "the region sits on the page's grid");
    // Without dpi, the target width sizes the REGION.
    let sized = rgba(
        &m,
        SnapshotRequest {
            clip: Some(SnapshotClip {
                x: 0.0,
                y: 0.0,
                width: 100.0,
                height: 50.0,
            }),
            ..SnapshotRequest::page(&page, 200)
        },
    );
    assert_eq!((sized.width_px, sized.height_px), (200, 100));
}

#[test]
#[allow(non_snake_case)]
fn a_png_carries_the_same_pixels_as_rgba__feat__plugin_platform_render_snapshot_v2() {
    let m = model("strokes-fills");
    let page = first_page(&m);
    let only = [ElementId::Rectangle(first_rect(&m))];
    let req = SnapshotRequest {
        only: &only,
        background: SnapshotBackground::Transparent,
        ..SnapshotRequest::page(&page, 160)
    };
    let raw = rgba(&m, req);
    let png = render_snapshot_request(&m, &req).expect("png");
    assert_eq!(png.format, SnapshotFormat::Png);
    assert!(png.rgba.is_empty());
    let decoded = image::load_from_memory(&png.png_bytes).unwrap().to_rgba8();
    assert_eq!(decoded.into_raw(), raw.rgba, "a PNG is straight alpha too");
}

#[test]
#[allow(non_snake_case)]
fn bad_clips_and_huge_images_are_refused__feat__plugin_platform_render_snapshot_v2() {
    let m = model("strokes-fills");
    let page = first_page(&m);
    let with = |clip: SnapshotClip, dpi: Option<f32>| {
        render_snapshot_request(
            &m,
            &SnapshotRequest {
                clip: Some(clip),
                dpi,
                ..SnapshotRequest::page(&page, 100)
            },
        )
    };
    let flat = SnapshotClip {
        x: 0.0,
        y: 0.0,
        width: 0.0,
        height: 10.0,
    };
    assert!(matches!(with(flat, None), Err(SnapshotError::InvalidClip)));
    let nan = SnapshotClip {
        x: f32::NAN,
        ..flat
    };
    assert!(matches!(with(nan, None), Err(SnapshotError::InvalidClip)));
    let big = SnapshotClip {
        x: 0.0,
        y: 0.0,
        width: 600.0,
        height: 600.0,
    };
    assert!(matches!(
        with(big, Some(7200.0)),
        Err(SnapshotError::TooLarge { .. })
    ));
}

#[test]
fn a_v1_request_reply_serializes_as_before() {
    let m = model("strokes-fills");
    let page = first_page(&m);
    let png = render_snapshot_request(&m, &SnapshotRequest::page(&page, 64)).unwrap();
    let json = serde_json::to_string(&png).unwrap();
    for key in ["\"format\"", "\"rgba\"", "\"region\"", "\"bytes\""] {
        assert!(!json.contains(key), "{key} leaked into a v1 reply: {json}");
    }
}

#[test]
#[allow(non_snake_case)]
fn trim_crops_to_what_the_item_draws__feat__plugin_platform_render_snapshot_v2() {
    let m = model("strokes-fills");
    let page = first_page(&m);
    let only = [ElementId::Rectangle(first_rect(&m))];
    let req = SnapshotRequest {
        only: &only,
        background: SnapshotBackground::Transparent,
        dpi: Some(72.0),
        ..SnapshotRequest::page(&page, 0)
    };
    let whole = rgba(&m, req);
    let trimmed = rgba(&m, SnapshotRequest { trim: true, ..req });
    let region = trimmed.region.expect("a trimmed reply names its region");
    // The drawn box of the whole-page image: the rectangle with its 6 pt
    // stroke (beyond its geometric bounds, 200 × 100 pt).
    let drawn: Vec<(u32, u32)> = (0..whole.height_px)
        .flat_map(|y| (0..whole.width_px).map(move |x| (x, y)))
        .filter(|&(x, y)| px(&whole, x, y)[3] > 0)
        .collect();
    let x0 = drawn.iter().map(|p| p.0).min().unwrap();
    let y0 = drawn.iter().map(|p| p.1).min().unwrap();
    let x1 = drawn.iter().map(|p| p.0).max().unwrap() + 1;
    let y1 = drawn.iter().map(|p| p.1).max().unwrap() + 1;
    assert_eq!(
        (region.x, region.y),
        (x0 as f32, y0 as f32),
        "72 dpi: 1 px per pt"
    );
    assert_eq!((trimmed.width_px, trimmed.height_px), (x1 - x0, y1 - y0));
    assert!(
        trimmed.width_px > 200 && trimmed.height_px > 100,
        "the stroke is in"
    );
    for y in 0..trimmed.height_px {
        for x in 0..trimmed.width_px {
            assert_eq!(px(&trimmed, x, y), px(&whole, x + x0, y + y0));
        }
    }
    // Nothing on the page: refused, not an empty image.
    let none = [ElementId::Rectangle("no-such-item".into())];
    assert!(matches!(
        render_snapshot_request(
            &m,
            &SnapshotRequest {
                only: &none,
                trim: true,
                ..req
            }
        ),
        Err(SnapshotError::NothingDrawn)
    ));
}

#[test]
fn a_hidden_text_frame_keeps_its_text_off_other_pages() {
    // W2.5 — the text of a hidden frame used to be routed to page 0 (the
    // hidden frame had no page) and painted there.
    let m = model("text");
    let page = first_page(&m);
    let others: Vec<ElementId> = m
        .scene()
        .spreads
        .iter()
        .skip(1)
        .flat_map(|s| s.spread.text_frames.iter())
        .filter_map(|f| f.self_id.clone().map(ElementId::TextFrame))
        .collect();
    assert!(
        !others.is_empty(),
        "the text sample has more than one spread"
    );
    let plain = rgba(&m, SnapshotRequest::page(&page, 300));
    let hiding = rgba(
        &m,
        SnapshotRequest {
            hide: &others,
            ..SnapshotRequest::page(&page, 300)
        },
    );
    assert_eq!(plain.rgba, hiding.rgba);
}

/// Editor ADR 2XX (asset export) — one request, the file `paged-raster`
/// writes: its container, the snapshot's size, its pixels.
fn encoded(m: &CanvasModel, req: SnapshotRequest<'_>, format: SnapshotFormat) -> SnapshotPng {
    let snap = render_snapshot_request(m, &SnapshotRequest { format, ..req }).expect("snapshot");
    assert_eq!(snap.format, format);
    assert!(snap.png_bytes.is_empty() && snap.rgba.is_empty());
    assert!(!snap.bytes.is_empty(), "the file is in `bytes`");
    snap
}

#[test]
#[allow(non_snake_case)]
fn jpeg_webp_and_tiff_are_written_by_paged_raster__feat__editor_shell_panels_asset_export() {
    let m = model("strokes-fills");
    let page = first_page(&m);
    let only = [ElementId::Rectangle(first_rect(&m))];
    let req = SnapshotRequest {
        only: &only,
        background: SnapshotBackground::Transparent,
        trim: true,
        dpi: Some(144.0),
        ..SnapshotRequest::page(&page, 0)
    };
    let raw = rgba(&m, req);
    for (format, sniffed) in [
        (SnapshotFormat::Jpeg, paged_raster::Format::Jpeg),
        (SnapshotFormat::Webp, paged_raster::Format::WebP),
        (SnapshotFormat::Tiff, paged_raster::Format::Tiff),
    ] {
        let file = encoded(&m, req, format);
        assert_eq!(
            paged_raster::sniff(&file.bytes),
            Some(sniffed),
            "{format:?}"
        );
        assert_eq!(
            (file.width_px, file.height_px),
            (raw.width_px, raw.height_px)
        );
        assert_eq!(file.region, raw.region, "the region travels with the file");
        let info = paged_raster::probe(&file.bytes).expect("probe");
        assert_eq!((info.width, info.height), (raw.width_px, raw.height_px));
        assert!(info.icc.is_some(), "{format:?} carries the sRGB profile");
        let back = paged_raster::decode_rgba8(&file.bytes, None).expect("decode");
        assert_eq!(back.data.len(), raw.rgba.len());
        if format != SnapshotFormat::Jpeg {
            // Lossless, alpha kept.
            assert_eq!(back.data, raw.rgba, "{format:?} keeps the pixels");
        }
    }
}

#[test]
#[allow(non_snake_case)]
fn a_jpeg_flattens_transparency_onto_white__feat__editor_shell_panels_asset_export() {
    let m = model("strokes-fills");
    let page = first_page(&m);
    let only = [ElementId::Rectangle(first_rect(&m))];
    // The whole page with one item on it: most of it is transparent.
    let req = SnapshotRequest {
        only: &only,
        background: SnapshotBackground::Transparent,
        ..SnapshotRequest::page(&page, 120)
    };
    let raw = rgba(&m, req);
    let jpeg = encoded(
        &m,
        SnapshotRequest {
            quality: Some(95),
            ..req
        },
        SnapshotFormat::Jpeg,
    );
    let back = paged_raster::decode_rgba8(&jpeg.bytes, None).expect("decode");
    let (mut clear, mut white) = (0, 0);
    for (src, out) in raw.rgba.chunks(4).zip(back.data.chunks(4)) {
        if src[3] == 0 {
            clear += 1;
            if out[..3].iter().all(|c| *c >= 250) {
                white += 1;
            }
        }
    }
    assert!(clear > 0);
    // JPEG ringing may tint a few pixels next to the item's edges.
    assert!(
        white * 100 >= clear * 95,
        "{white} of {clear} clear pixels white"
    );
}

#[test]
#[allow(non_snake_case)]
fn jpeg_quality_changes_the_file__feat__editor_shell_panels_asset_export() {
    let m = model("strokes-fills");
    let page = first_page(&m);
    let at = |quality| {
        encoded(
            &m,
            SnapshotRequest {
                quality: Some(quality),
                ..SnapshotRequest::page(&page, 300)
            },
            SnapshotFormat::Jpeg,
        )
        .bytes
        .len()
    };
    assert!(at(20) < at(100), "a lower quality writes a smaller file");
}

#[test]
#[allow(non_snake_case)]
fn the_wire_reads_a_file_format_and_its_quality__feat__editor_shell_panels_asset_export() {
    let json = r#"{"seq":1,"protocol":77,"kind":"requestSnapshot","payload":{"pageId":"p1","targetWidthPx":0,"dpi":144,"format":"jpeg","quality":80}}"#;
    let msg: paged_canvas::MainToWorker = serde_json::from_str(json).expect("parses");
    let paged_canvas::MainToWorkerKind::RequestSnapshot {
        format, quality, ..
    } = msg.kind
    else {
        panic!("a snapshot request");
    };
    assert_eq!((format, quality), (SnapshotFormat::Jpeg, Some(80)));
    for (name, format) in [
        ("webp", SnapshotFormat::Webp),
        ("tiff", SnapshotFormat::Tiff),
    ] {
        let parsed: SnapshotFormat = serde_json::from_str(&format!("\"{name}\"")).unwrap();
        assert_eq!(parsed, format);
    }
}
