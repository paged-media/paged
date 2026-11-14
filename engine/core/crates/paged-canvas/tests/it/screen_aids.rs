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

//! Engine ADR 1306 — the engine's side of the editor's editing aids and
//! Proof view (editor ADR 1212): where the hidden characters stand, the
//! screen without nonprinting items, a proof without the page edge and the
//! degraded-asset markers, the screen extent the CPU tile covers, and the
//! text frames' own baseline grids. None of them changes the document.

use std::io::Write;

use paged_canvas::invisibles::HiddenCharacterKind as K;
use paged_canvas::view::{ViewMode, ViewSettings};
use paged_canvas::{CanvasModel, CanvasOptions, PageId};

fn inter() -> Vec<u8> {
    std::fs::read(
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../corpus/fonts/Inter.ttf"),
    )
    .expect("Inter.ttf fixture")
}

/// One 400 × 400 page: a text frame of three paragraphs (a space, a tab
/// and a forced line break in the first), a frame turned a quarter, a
/// frame with a grid of its own, a black nonprinting square and a black
/// square that bleeds 9 pt past the page's top-left corner. `font` sets
/// the text.
fn idml(font: &str) -> Vec<u8> {
    use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};
    let mut zip = ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    let mut file = |name: &str, body: &str| {
        zip.start_file(name, stored).unwrap();
        zip.write_all(body.as_bytes()).unwrap();
    };
    file("mimetype", "application/vnd.adobe.indesign-idml-package");
    file(
        "designmap.xml",
        r#"<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging" Self="d1">
  <idPkg:Graphic src="Resources/Graphic.xml"/>
  <idPkg:Spread src="Spreads/Spread_sp1.xml"/>
  <idPkg:Story src="Stories/Story_s1.xml"/>
  <idPkg:Story src="Stories/Story_s2.xml"/>
  <idPkg:Story src="Stories/Story_s3.xml"/>
</Document>"#,
    );
    file(
        "Resources/Graphic.xml",
        r#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Graphic xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">
  <Color Self="Color/Black" Model="Process" Space="CMYK" ColorValue="0 0 0 100" Name="Black"/>
</idPkg:Graphic>"#,
    );
    file(
        "Spreads/Spread_sp1.xml",
        r#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Spread xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">
  <Spread Self="sp1">
    <Page Self="p1" GeometricBounds="0 0 400 400"/>
    <TextFrame Self="frameA" ParentStory="s1" GeometricBounds="20 20 120 380"/>
    <TextFrame Self="frameT" ParentStory="s2" GeometricBounds="0 0 40 200" ItemTransform="0 1 -1 0 380 150"/>
    <TextFrame Self="frameG" ParentStory="s3" GeometricBounds="200 20 300 200">
      <TextFramePreference TextColumnCount="1"/>
      <BaselineFrameGridOption UseCustomBaselineFrameGrid="true"
          StartingOffsetForBaselineFrameGrid="5" BaselineFrameGridRelativeOption="TopOfFrame"
          BaselineFrameGridIncrement="13"/>
    </TextFrame>
    <Rectangle Self="np" GeometricBounds="320 20 380 100" FillColor="Color/Black" StrokeWeight="0" Nonprinting="true"/>
    <Rectangle Self="bleed" GeometricBounds="-9 -9 10 10" FillColor="Color/Black" StrokeWeight="0"/>
  </Spread>
</idPkg:Spread>"#,
    );
    let story = |id: &str, content: &str| {
        format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Story xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">
  <Story Self="{id}">
    <ParagraphStyleRange>
      <CharacterStyleRange AppliedFont="{font}" PointSize="12">{content}</CharacterStyleRange>
    </ParagraphStyleRange>
  </Story>
</idPkg:Story>"#
        )
    };
    file(
        "Stories/Story_s1.xml",
        &story(
            "s1",
            "<Content>One two&#9;three&#x2028;four</Content><Br/><Content>Five</Content><Br/><Content>Six</Content>",
        ),
    );
    file(
        "Stories/Story_s2.xml",
        &story("s2", "<Content>Turned text</Content>"),
    );
    file(
        "Stories/Story_s3.xml",
        &story("s3", "<Content>On a grid</Content>"),
    );
    zip.finish().unwrap().into_inner()
}

fn load(font: &str) -> CanvasModel {
    let opts = CanvasOptions {
        fonts: vec![inter()],
        ..CanvasOptions::default()
    };
    CanvasModel::load("screen-aids", &idml(font), opts).expect("load")
}

fn page() -> PageId {
    PageId("p1".into())
}

fn view(hide_nonprinting: bool, proof: bool) -> ViewSettings {
    ViewSettings {
        mode: ViewMode::Preview,
        hide_nonprinting,
        proof,
    }
}

#[test]
fn the_hidden_characters_stand_where_the_lines_hold_them() {
    let m = load("Inter");
    let pages = m.hidden_characters(&[page(), PageId("nope".into())]);
    assert_eq!(pages.len(), 1, "an unknown page is left out");
    let lines: Vec<_> = pages[0]
        .lines
        .iter()
        .filter(|l| l.story_id == "s1")
        .collect();
    let kinds: Vec<K> = lines
        .iter()
        .flat_map(|l| l.marks.iter().map(|m| m.kind))
        .collect();
    assert_eq!(
        kinds,
        [
            K::Space,
            K::Tab,
            K::ForcedLineBreak,
            K::ParagraphEnd,
            K::ParagraphEnd,
            K::StoryEnd
        ],
        "{lines:#?}"
    );
    let first = lines[0];
    assert_eq!(first.frame_id.as_deref(), Some("frameA"));
    assert!(
        first.turn.is_none(),
        "an upright frame's line is not turned"
    );
    assert!(
        first.baseline > 20.0 && first.baseline < 120.0,
        "the baseline lies in the frame: {}",
        first.baseline
    );
    assert!(
        (first.size - 12.0).abs() < 1.5,
        "the marks take the text's size: {}",
        first.size
    );
    // Left to right on the first line: the space, the tab, then the break
    // where the line's text ends; each inside the frame.
    let xs: Vec<f32> = first.marks.iter().map(|m| m.x).collect();
    assert!(xs.windows(2).all(|w| w[0] < w[1]), "{xs:?}");
    assert!(xs[0] > 20.0 && xs[2] < 380.0, "{xs:?}");
    assert!(first.marks[0].width > 0.0, "a space takes its width");
    assert!(first.marks[1].width > first.marks[0].width, "a tab, more");
    // A turned frame's line says how the page turns it.
    let turned = pages[0]
        .lines
        .iter()
        .find(|l| l.story_id == "s2")
        .expect("the turned frame's line");
    let t = turned.turn.expect("a turned line");
    assert!(
        t[0].abs() < 1e-4 && (t[1] - 1.0).abs() < 1e-4,
        "a quarter turn: {t:?}"
    );
}

#[test]
fn hiding_nonprinting_items_rebuilds_the_screen_and_changes_no_document() {
    let mut m = load("Inter");
    let hash = m.scene().canonical_hash();
    let steps = m.applied_log_len();
    let hit = |m: &CanvasModel| {
        m.hit_test(&page(), (60.0, 350.0))
            .element
            .map(|e| e.raw_id().to_string())
    };
    assert_eq!(hit(&m).as_deref(), Some("np"), "shown, it is hit");
    let shown = m.page(&page()).unwrap().list.commands.len();
    // Drawn on screen, left out of print: the live build is not the
    // export's.
    assert!(!m.live_build_is_export_faithful());

    assert!(m.set_view_settings(view(true, false)).unwrap(), "rebuilt");
    assert!(
        m.page(&page()).unwrap().list.commands.len() < shown,
        "the square left the screen"
    );
    assert_eq!(hit(&m), None, "and nothing lands on it");
    assert!(m.live_build_is_export_faithful());
    // The same settings again: nothing to rebuild.
    assert!(!m.set_view_settings(view(true, false)).unwrap());
    // A mode change alone is drawn at raster time.
    let outline = ViewSettings {
        mode: ViewMode::Outline,
        ..view(true, false)
    };
    assert!(!m.set_view_settings(outline).unwrap());

    assert!(m.set_view_settings(view(false, false)).unwrap());
    assert_eq!(m.page(&page()).unwrap().list.commands.len(), shown);
    assert_eq!(hit(&m).as_deref(), Some("np"));
    assert_eq!(m.scene().canonical_hash(), hash, "the document is the same");
    assert_eq!(m.applied_log_len(), steps, "and no undo step was made");
}

/// The pixels that read as the substituted-font pink (snapshot_markers.rs).
fn pink_pixels(png: &[u8]) -> usize {
    let img = image::load_from_memory(png).expect("decode").to_rgba8();
    img.pixels()
        .filter(|p| {
            let [r, g, b, a] = p.0;
            a > 200 && r > 230 && g > 90 && g < 190 && b > g + 8 && b < r - 30
        })
        .count()
}

#[test]
fn a_proof_draws_without_the_degraded_asset_markers() {
    // Nobody has "Ghost Family": the text is set in a substitute, which the
    // editing screen marks pink.
    let mut m = load("Ghost Family");
    assert!(m.live_build_has_markers());
    let (tile, _) = paged_canvas::snapshot::render_screen_tile_png(&m, &page(), 400).expect("tile");
    assert!(pink_pixels(&tile) > 50, "the editing screen marks it");

    assert!(m.set_view_settings(view(true, true)).unwrap());
    assert!(!m.live_build_has_markers());
    let (proof, _) =
        paged_canvas::snapshot::render_screen_tile_png(&m, &page(), 400).expect("tile");
    assert_eq!(pink_pixels(&proof), 0, "a proof draws the page as exported");

    assert!(m.set_view_settings(view(false, false)).unwrap());
    let (back, _) = paged_canvas::snapshot::render_screen_tile_png(&m, &page(), 400).expect("tile");
    assert_eq!(
        back, tile,
        "leaving the proof draws the editing screen again"
    );
}

#[test]
fn the_cpu_tile_covers_the_bleed_on_a_transparent_ground() {
    let m = load("Inter");
    let built = m.page(&page()).unwrap();
    let extent = paged_canvas::view::screen_extent(built);
    // The square bleeds 9 pt past the top-left corner: the extent takes it
    // in, a point padded, and keeps the trim.
    assert_eq!(extent, [-10.0, -10.0, 410.0, 410.0]);
    let (png, at) = paged_canvas::snapshot::render_screen_tile_png(&m, &page(), 400).expect("tile");
    assert_eq!(at, extent, "the tile says where it goes");
    let img = image::load_from_memory(&png).expect("decode").to_rgba8();
    // 400 px across the 400 pt trim: one pixel per point, the extent
    // 410 px wide.
    assert_eq!(img.width(), 410);
    let px = |x: f32, y: f32| img.get_pixel((x - at[0]) as u32, (y - at[1]) as u32).0;
    let bleed = px(-5.0, -5.0);
    assert!(
        bleed[3] > 250 && bleed[0] < 40,
        "the bleed is drawn: {bleed:?}"
    );
    let paper = px(200.0, 390.0);
    assert_eq!(paper[3], 0, "no paper in the tile: {paper:?}");
}

#[test]
fn a_frame_with_a_grid_of_its_own_reports_it() {
    let m = load("Inter");
    let grids = m.frame_baseline_grids(&[]);
    assert_eq!(grids.len(), 1, "{grids:?}");
    let g = &grids[0];
    assert_eq!(g.frame_id, "frameG");
    assert_eq!(g.page_id, page());
    assert_eq!(g.bounds, [200.0, 20.0, 300.0, 200.0]);
    assert_eq!(g.start, 5.0);
    assert_eq!(g.increment, 13.0);
    assert_eq!(
        g.relative_to,
        paged_canvas::frame_grids::FrameGridReference::TopOfFrame
    );
    assert_eq!(m.frame_baseline_grids(&[page()]).len(), 1);
    assert!(m.frame_baseline_grids(&[PageId("nope".into())]).is_empty());
}
