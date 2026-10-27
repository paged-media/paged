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

//! Engine ADR 10XX — `RequestSnapshot.story`: a story the document does not
//! hold, laid out by the engine and drawn alone (paged.image's type layers).

use paged_canvas::{
    render_snapshot_request, CanvasModel, CanvasOptions, SnapshotBackground, SnapshotFormat,
    SnapshotParagraph, SnapshotPng, SnapshotRequest, SnapshotRun, SnapshotStory,
};
use paged_wire::PageId;

fn model() -> CanvasModel {
    let sample = paged_gen::samples::build("strokes-fills").expect("sample");
    let bytes = paged_gen::write_idml(&sample).expect("write");
    let inter = std::fs::read(
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../corpus/fonts/Inter.ttf"),
    )
    .expect("Inter.ttf");
    let opts = CanvasOptions {
        fonts: vec![inter],
        ..CanvasOptions::default()
    };
    CanvasModel::load("story", &bytes, opts).expect("load")
}

fn page(m: &CanvasModel) -> PageId {
    PageId(m.pages()[0].self_id.clone())
}

fn story(width: f32, text: &str, justification: &str, size: f32) -> SnapshotStory {
    SnapshotStory {
        bounds: [10.0, 10.0, 210.0, 10.0 + width],
        paragraphs: vec![SnapshotParagraph {
            runs: vec![SnapshotRun {
                text: text.into(),
                point_size: Some(size),
                fill_rgb: Some([220, 20, 30]),
                ..Default::default()
            }],
            justification: Some(justification.into()),
            ..Default::default()
        }],
        vertical_justification: None,
        first_baseline: None,
    }
}

fn draw(m: &CanvasModel, s: &SnapshotStory) -> SnapshotPng {
    let p = page(m);
    render_snapshot_request(
        m,
        &SnapshotRequest {
            dpi: Some(72.0),
            format: SnapshotFormat::Rgba,
            background: SnapshotBackground::Transparent,
            story: Some(s),
            ..SnapshotRequest::page(&p, 0)
        },
    )
    .expect("story snapshot")
}

/// Rows with ink, and the ink's mean x (px) and colour.
fn ink(s: &SnapshotPng) -> (Vec<u32>, f64, [u8; 3]) {
    let mut rows = Vec::new();
    let (mut sx, mut n) = (0.0f64, 0.0f64);
    let mut colour = [0u8; 3];
    for y in 0..s.height_px {
        let mut any = false;
        for x in 0..s.width_px {
            let i = ((y * s.width_px + x) * 4) as usize;
            if s.rgba[i + 3] > 128 {
                any = true;
                sx += f64::from(x);
                n += 1.0;
                if s.rgba[i + 3] == 255 {
                    colour = [s.rgba[i], s.rgba[i + 1], s.rgba[i + 2]];
                }
            }
        }
        if any {
            rows.push(y);
        }
    }
    (rows, if n > 0.0 { sx / n } else { -1.0 }, colour)
}

/// Bands of consecutive inked rows: the lines of type.
fn lines(rows: &[u32]) -> usize {
    let mut bands = 0;
    let mut last: Option<u32> = None;
    for &r in rows {
        if last.is_none_or(|l| r > l + 2) {
            bands += 1;
        }
        last = Some(r);
    }
    bands
}

#[test]
#[allow(non_snake_case)]
fn a_story_the_document_does_not_hold_is_drawn_alone__feat__image_layers_type() {
    let m = model();
    let before = m.current_state_hash();
    let stories = m.scene().stories.len();
    let s = story(180.0, "Type layer", "LeftAlign", 24.0);
    let snap = draw(&m, &s);
    assert!(snap.story, "the reply says the story was drawn");
    // The frame's box at 72 dpi: one pixel per pt.
    assert_eq!((snap.width_px, snap.height_px), (180, 200));
    let r = snap.region.expect("region");
    assert_eq!((r.x, r.y, r.width, r.height), (10.0, 10.0, 180.0, 200.0));
    let (rows, _, colour) = ink(&snap);
    assert!(!rows.is_empty(), "the story drew ink");
    assert_eq!(lines(&rows), 1);
    assert!(
        colour[0] > 180 && colour[1] < 80 && colour[2] < 80,
        "the run's fill: {colour:?}"
    );
    // Nothing of the page's own artwork: every pixel is clear or ink.
    // And the document did not change.
    assert_eq!(m.current_state_hash(), before);
    assert_eq!(m.scene().stories.len(), stories);
}

#[test]
#[allow(non_snake_case)]
fn the_engine_wraps_and_aligns_the_story__feat__image_layers_type() {
    let m = model();
    let text = "The quick brown fox jumps over the lazy dog again and again";
    let wide = draw(&m, &story(190.0, text, "LeftAlign", 14.0));
    let narrow = draw(&m, &story(70.0, text, "LeftAlign", 14.0));
    let (wl, nl) = (lines(&ink(&wide).0), lines(&ink(&narrow).0));
    assert!(nl > wl, "a narrower frame breaks more lines: {nl} vs {wl}");

    let left = ink(&draw(&m, &story(190.0, "Hi", "LeftAlign", 14.0))).1;
    let centre = ink(&draw(&m, &story(190.0, "Hi", "CenterAlign", 14.0))).1;
    let right = ink(&draw(&m, &story(190.0, "Hi", "RightAlign", 14.0))).1;
    assert!(left < 40.0, "left-aligned ink sits left: {left}");
    assert!((centre - 95.0).abs() < 15.0, "centred ink: {centre}");
    assert!(right > 150.0, "right-aligned ink: {right}");
}

#[test]
#[allow(non_snake_case)]
fn a_forced_line_break_and_paragraphs_make_lines__feat__image_layers_type() {
    let m = model();
    let one = draw(&m, &story(190.0, "Alpha Beta", "LeftAlign", 14.0));
    let broken = draw(&m, &story(190.0, "Alpha\nBeta", "LeftAlign", 14.0));
    assert_eq!(lines(&ink(&one).0), 1);
    assert_eq!(lines(&ink(&broken).0), 2);
    let mut two = story(190.0, "Alpha", "LeftAlign", 14.0);
    two.paragraphs.push(two.paragraphs[0].clone());
    assert_eq!(lines(&ink(&draw(&m, &two)).0), 2);
}

#[test]
fn a_story_with_no_area_is_refused() {
    let m = model();
    let p = page(&m);
    let mut s = story(100.0, "x", "LeftAlign", 12.0);
    s.bounds = [10.0, 10.0, 10.0, 50.0];
    assert!(render_snapshot_request(
        &m,
        &SnapshotRequest {
            story: Some(&s),
            dpi: Some(72.0),
            ..SnapshotRequest::page(&p, 0)
        },
    )
    .is_err());
}

#[test]
#[allow(non_snake_case)]
fn a_fixed_first_baseline_puts_the_line_where_it_is_asked__feat__image_layers_type() {
    let m = model();
    let mut s = story(190.0, "xxxx", "LeftAlign", 20.0);
    let mut bottoms = Vec::new();
    for fb in [30.0f32, 60.0] {
        s.first_baseline = Some(fb);
        let rows = ink(&draw(&m, &s)).0;
        bottoms.push(*rows.last().expect("ink") as f32);
    }
    // An x has no descender: its ink ends on the baseline.
    assert!((bottoms[1] - bottoms[0] - 30.0).abs() <= 1.0, "{bottoms:?}");
    assert!((bottoms[0] - 30.0).abs() <= 1.5, "{bottoms:?}");
}
