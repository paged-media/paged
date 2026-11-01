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

//! Engine ADR 1041 — a pattern swatch in the PDF: a coloured tiling
//! pattern (`PatternType 1`, `PaintType 1`) whose cell is the period, its
//! items in their native colour spaces; held by poppler to the engine's
//! own raster of the same page; a pattern stroke through `/Pattern`.
#![allow(non_snake_case)]

use std::io::Write;

use lopdf::{Dictionary, Object};
use paged_color::{DisplaySetup, IccCmm};
use paged_compose::Color;
use paged_export_pdf::{export_pdf, ExportInkSettings, ExportInput, ExportOptions, ExportProfiles};
use paged_model::{
    FillRule, PathAnchor, PatternColor, PatternEntry, PatternItem, PatternLayout, PatternPlacement,
    PatternTileKind,
};
use paged_renderer::pipeline::{self, FontTable, PipelineOptions};
use paged_scene::Document;
use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

fn idml(item: &str) -> Vec<u8> {
    let mut zip = ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let o = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    zip.start_file("mimetype", o).unwrap();
    zip.write_all(b"application/vnd.adobe.indesign-idml-package")
        .unwrap();
    zip.start_file("designmap.xml", o).unwrap();
    zip.write_all(
        br#"<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">
  <idPkg:Graphic src="Resources/Graphic.xml"/>
  <idPkg:Spread src="Spreads/Spread_sp1.xml"/>
</Document>"#,
    )
    .unwrap();
    zip.start_file("Resources/Graphic.xml", o).unwrap();
    zip.write_all(
        br#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Graphic xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">
  <Graphic>
    <Color Self="Color/Red" Name="Red" Space="RGB" ColorValue="255 0 0"/>
    <Color Self="Color/Magenta" Name="Magenta" Space="CMYK" ColorValue="0 100 0 0"/>
  </Graphic>
</idPkg:Graphic>"#,
    )
    .unwrap();
    zip.start_file("Spreads/Spread_sp1.xml", o).unwrap();
    zip.write_all(
        format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Spread xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">
  <Spread Self="sp1">
    <Page Self="p1" GeometricBounds="0 0 300 400"/>
    {item}
  </Spread>
</idPkg:Spread>"#
        )
        .as_bytes(),
    )
    .unwrap();
    zip.finish().unwrap().into_inner()
}

const SQUARE: &str = r#"<Rectangle Self="r1" GeometricBounds="50 100 250 300" FillColor="Color/Red" StrokeWeight="0"/>"#;
const STROKED: &str = r#"<Rectangle Self="r1" GeometricBounds="50 100 250 300" FillColor="Swatch/None" StrokeColor="Color/Red" StrokeWeight="20"/>"#;

fn checker(kind: PatternTileKind, colour: &str) -> PatternEntry {
    let p = |x: f32, y: f32| PathAnchor {
        anchor: (x, y),
        left: (x, y),
        right: (x, y),
    };
    PatternEntry {
        self_id: "Pattern/check".into(),
        name: None,
        width: 20.0,
        height: 20.0,
        layout: PatternLayout {
            kind,
            ..Default::default()
        },
        placement: PatternPlacement::default(),
        items: vec![PatternItem {
            anchors: vec![p(0.0, 0.0), p(10.0, 0.0), p(10.0, 10.0), p(0.0, 10.0)],
            subpath_starts: vec![],
            subpath_open: vec![],
            fill_rule: FillRule::NonZero,
            fill: Some(PatternColor::Swatch(colour.into())),
            stroke: None,
            stroke_weight: 0.0,
        }],
    }
}

fn doc(item: &str, pattern: PatternEntry, stroke: bool) -> Document {
    let mut d = idml_import::import_idml_doc(&idml(item)).expect("import");
    let id = pattern.self_id.clone();
    d.palette.patterns.insert(id.clone(), pattern);
    let r = &mut d.spreads[0].spread.rectangles[0];
    if stroke {
        r.stroke_color = Some(id);
    } else {
        r.fill_color = Some(id);
    }
    d
}

fn export(document: &Document) -> Vec<u8> {
    export_with(document, None)
}

/// The export, with the document's CMYK working profile when given (so a
/// CMYK swatch keeps its inks, ADR 106).
fn export_with(document: &Document, cmyk_profile: Option<&[u8]>) -> Vec<u8> {
    let opts = PipelineOptions::default();
    let fonts = FontTable::build(document, &opts);
    let built = {
        let o = PipelineOptions {
            pre_built_font_table: Some(&fonts),
            cmyk_icc_profile: cmyk_profile,
            ..PipelineOptions::default()
        };
        pipeline::build_document(document, &o).expect("build document")
    };
    let cmm = IccCmm::new(None, DisplaySetup::default());
    export_pdf(ExportInput {
        doc: &built,
        palette: &document.palette,
        fonts: Some(&fonts),
        cmm: &cmm,
        profiles: ExportProfiles::default(),
        inks: ExportInkSettings::default(),
        options: ExportOptions::default(),
        doc_bleed: [0.0; 4],
        doc_slug: [0.0; 4],
    })
    .expect("export")
    .bytes
}

/// Every tiling pattern: its dictionary and decoded content.
fn tiling_patterns(pdf: &[u8]) -> Vec<(Dictionary, String)> {
    let parsed = lopdf::Document::load_mem(pdf).expect("re-parse");
    parsed
        .objects
        .values()
        .filter_map(|o| match o {
            Object::Stream(s) if s.dict.get(b"PatternType").ok()?.as_i64().ok()? == 1 => {
                let content = s
                    .decompressed_content()
                    .unwrap_or_else(|_| s.content.clone());
                Some((
                    s.dict.clone(),
                    String::from_utf8_lossy(&content).into_owned(),
                ))
            }
            _ => None,
        })
        .collect()
}

fn num(d: &Dictionary, key: &[u8]) -> f32 {
    match d.get(key).expect("key") {
        Object::Integer(i) => *i as f32,
        Object::Real(r) => *r,
        o => panic!("{o:?}"),
    }
}

/// The page rasterised by poppler's CAIRO backend at 72 dpi, or `None`
/// without it. Not `pdftoppm`: its Splash backend misplaces a TURNED
/// tiling pattern's cells (measured on `grid-turned`: shifted by about a
/// third of a cell), where Cairo, macOS's PDFKit and Illustrator draw the
/// lattice the matrix says — and the engine's raster.
fn rasterise(pdf: &[u8], tag: &str) -> Option<image::RgbImage> {
    paged_test_resources::tool("pdftocairo")?;
    let dir = std::env::temp_dir().join(format!("paged-pattern-{tag}-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("temp dir");
    let pdf_path = dir.join("page.pdf");
    std::fs::write(&pdf_path, pdf).expect("write pdf");
    let status = std::process::Command::new("pdftocairo")
        .args(["-r", "72", "-png", "-singlefile"])
        .arg(&pdf_path)
        .arg(dir.join("page"))
        .status()
        .expect("run pdftocairo");
    assert!(status.success(), "pdftocairo failed");
    let png = std::fs::read(dir.join("page.png")).expect("rasterised page");
    let _ = std::fs::remove_dir_all(&dir);
    Some(image::load_from_memory(&png).expect("decode").to_rgb8())
}

fn engine_raster(d: &Document) -> image::RgbaImage {
    let (_, images) = pipeline::render_document(d, &PipelineOptions::default(), 72.0, Color::WHITE)
        .expect("render");
    images.into_iter().next().unwrap()
}

#[test]
fn a_pattern_fill_is_a_coloured_tiling_pattern__feat__color_swatches_pattern_paint() {
    let pdf = export(&doc(
        SQUARE,
        checker(PatternTileKind::Grid, "Color/Red"),
        false,
    ));
    let pats = tiling_patterns(&pdf);
    assert_eq!(pats.len(), 1, "one tiling pattern");
    let (d, content) = &pats[0];
    assert_eq!(
        d.get(b"PaintType").unwrap().as_i64().unwrap(),
        1,
        "coloured"
    );
    assert_eq!(d.get(b"TilingType").unwrap().as_i64().unwrap(), 1);
    assert_eq!(num(d, b"XStep"), 20.0);
    assert_eq!(num(d, b"YStep"), 20.0);
    assert!(d.get(b"Matrix").is_ok() && d.get(b"Resources").is_ok());
    assert!(
        content.contains(
            "
f
"
        ),
        "the cell fills its item: {content}"
    );
    // A brick lattice's cell is two rows tall and holds the copy of the
    // shifted row (its square at x 10..20 of the 20 pt cell).
    let pdf = export(&doc(
        SQUARE,
        checker(PatternTileKind::BrickByRow, "Color/Red"),
        false,
    ));
    let pats = tiling_patterns(&pdf);
    assert_eq!(num(&pats[0].0, b"YStep"), 40.0);
    assert_eq!(pats[0].1.matches(" cm").count(), 2, "{}", pats[0].1);
    assert!(pats[0].1.contains("1 0 0 1 10 20 cm"), "{}", pats[0].1);
}

#[test]
fn a_cmyk_item_keeps_its_inks_in_the_cell__feat__color_swatches_pattern_paint() {
    let Some(profile) = paged_color::test_profiles::read_cmyk_profile(env!("CARGO_MANIFEST_DIR"))
    else {
        paged_test_resources::unavailable(
            paged_test_resources::Resource::Icc,
            paged_color::test_profiles::NO_PROFILE_HINT,
        );
        return;
    };
    let pdf = export_with(
        &doc(
            SQUARE,
            checker(PatternTileKind::Grid, "Color/Magenta"),
            false,
        ),
        Some(&profile),
    );
    let (_, content) = &tiling_patterns(&pdf)[0];
    assert!(!content.contains(" rg"), "not converted to RGB: {content}");
    assert!(
        content.contains(" k") || content.contains(" scn"),
        "a CMYK fill: {content}"
    );
}

#[test]
fn a_pattern_stroke_paints_through_the_pattern_space__feat__color_swatches_pattern_paint() {
    let pdf = export(&doc(
        STROKED,
        checker(PatternTileKind::Grid, "Color/Red"),
        true,
    ));
    assert_eq!(tiling_patterns(&pdf).len(), 1);
    let parsed = lopdf::Document::load_mem(&pdf).unwrap();
    let page = parsed.get_pages().into_values().next().unwrap();
    let content = String::from_utf8_lossy(&parsed.get_page_content(page)).into_owned();
    assert!(content.contains("/Pattern CS"), "{content}");
    assert!(content.contains(" SCN"), "{content}");
}

#[test]
fn poppler_draws_the_pattern_as_the_engine_does__feat__color_swatches_pattern_paint() {
    for (tag, kind, stroke, turn) in [
        ("grid", PatternTileKind::Grid, false, 0.0),
        ("grid-turned", PatternTileKind::Grid, false, 20.0),
        ("hex", PatternTileKind::HexByRow, false, 0.0),
        ("stroke", PatternTileKind::BrickByColumn, true, 0.0),
    ] {
        let mut p = checker(kind, "Color/Red");
        p.placement.rotation_deg = turn;
        let d = doc(if stroke { STROKED } else { SQUARE }, p, stroke);
        let pdf = export(&d);
        // `tool` reports poppler as unavailable when it is missing.
        let Some(poppler) = rasterise(&pdf, tag) else {
            return;
        };
        let ours = engine_raster(&d);
        // Over a lattice away from tile edges (antialiasing), the two agree.
        let (mut far, mut n) = (0, 0);
        for y in (52..248).step_by(3) {
            for x in (102..298).step_by(3) {
                let a = poppler.get_pixel(x, y).0;
                let b = ours.get_pixel(x, y).0;
                let d = (0..3).map(|i| a[i].abs_diff(b[i])).max().unwrap();
                n += 1;
                if d > 40 {
                    far += 1;
                }
            }
        }
        assert!(
            far * 100 <= n * 4,
            "{tag}: {far} of {n} lattice px differ by > 40"
        );
    }
}

fn oracle_dir() -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/pattern-oracle")
}

/// The oracle's cases: a grid turned 20°, a brick-by-row lattice, a
/// hex-by-column lattice whose copies overlap (the overlap order shows),
/// and a brick-by-column pattern stroke.
fn oracle_cases() -> Vec<(&'static str, Document)> {
    let mut turned = checker(PatternTileKind::Grid, "Color/Red");
    turned.placement.rotation_deg = 20.0;
    let brick = checker(PatternTileKind::BrickByRow, "Color/Red");
    let mut hex = checker(PatternTileKind::HexByColumn, "Color/Red");
    // A second, larger square in magenta that overruns the tile: the
    // copies overlap and the order decides which is in front.
    let p = |x: f32, y: f32| PathAnchor {
        anchor: (x, y),
        left: (x, y),
        right: (x, y),
    };
    hex.items.push(PatternItem {
        anchors: vec![p(6.0, 6.0), p(22.0, 6.0), p(22.0, 22.0), p(6.0, 22.0)],
        subpath_starts: vec![],
        subpath_open: vec![],
        fill_rule: FillRule::NonZero,
        fill: Some(PatternColor::Swatch("Color/Magenta".into())),
        stroke: None,
        stroke_weight: 0.0,
    });
    let stroke = checker(PatternTileKind::BrickByColumn, "Color/Red");
    vec![
        ("grid-turned", doc(SQUARE, turned, false)),
        ("brick-row", doc(SQUARE, brick, false)),
        ("hex-overlap", doc(SQUARE, hex, false)),
        ("stroke-brick", doc(STROKED, stroke, true)),
    ]
}

/// Write the oracle's input PDFs (the engine's own export of each case),
/// which `modules/draw/scripts/illustrator/probes/pattern-render.jsx`
/// opens in Illustrator. Run by hand before recording.
#[test]
#[ignore = "writes the Illustrator oracle's inputs"]
fn write_illustrator_pattern_inputs() {
    let dir = oracle_dir();
    std::fs::create_dir_all(&dir).expect("fixture dir");
    for (name, d) in oracle_cases() {
        std::fs::write(dir.join(format!("{name}.pdf")), export(&d)).expect("write input");
    }
}

/// The share of lattice pixels (every third, inside the frame) on which
/// Illustrator's PNG and the engine's raster may differ by more than
/// [`ORACLE_LEVELS`] where an edge is turned or a stroke's outline: the
/// partial pixels two antialiasers place differently. Recorded
/// (Illustrator 30.1, 2026-10-29): the turned grid 197 of 4356 (4.5 %),
/// the brick stroke 131 (3.0 %); the upright brick and the overlapping
/// hex lattices 0 — Illustrator draws every cell, and the overlap order,
/// where the engine does.
const ORACLE_FAR_PCT: usize = 5;
const ORACLE_LEVELS: u8 = 40;

/// Engine ADR 1041 — the Illustrator oracle (recorded by
/// `modules/draw/scripts/illustrator/probes/pattern-render.jsx`):
/// Illustrator opens the engine's tiling pattern as a pattern swatch on
/// the frame's path, draws it as the engine does, and writes it back as
/// a tiling pattern. Skips (reported) until the probe has been recorded.
#[test]
fn the_engine_draws_a_pattern_as_illustrator_does__feat__color_swatches_pattern_paint() {
    let dir = oracle_dir();
    let Ok(text) = std::fs::read_to_string(dir.join("pattern-render.illustrator.json")) else {
        paged_test_resources::unavailable(
            paged_test_resources::Resource::Corpus,
            "the Illustrator pattern oracle is not recorded (tests/fixtures/pattern-oracle)",
        );
        return;
    };
    let rec: serde_json::Value = serde_json::from_str(&text).expect("fixture json");
    let cases = rec["cases"].as_array().expect("cases");
    for (name, d) in oracle_cases() {
        let case = cases
            .iter()
            .find(|c| c["id"] == name)
            .unwrap_or_else(|| panic!("case {name} recorded"));
        assert!(
            case["pattern_swatches"].as_i64().unwrap_or(0) >= 1,
            "{name}: Illustrator reads a pattern swatch: {case}"
        );
        let png = image::open(dir.join(case["png"].as_str().unwrap()))
            .expect("illustrator png")
            .to_rgb8();
        let ours = engine_raster(&d);
        let (mut far, mut n) = (0usize, 0usize);
        for y in (52..248).step_by(3) {
            for x in (102..298).step_by(3) {
                let a = png.get_pixel(x, y).0;
                let b = ours.get_pixel(x, y).0;
                n += 1;
                if (0..3).any(|i| a[i].abs_diff(b[i]) > ORACLE_LEVELS) {
                    far += 1;
                }
            }
        }
        // Upright lattices agree on every lattice pixel; where an edge is
        // turned (or is a stroke's outline) the two antialiasers place
        // the partial pixels differently.
        let allowed = if name == "brick-row" || name == "hex-overlap" {
            0
        } else {
            ORACLE_FAR_PCT
        };
        assert!(
            far * 100 <= n * allowed,
            "{name}: {far} of {n} lattice px differ by > {ORACLE_LEVELS}"
        );
        let ai_pdf = std::fs::read(dir.join(case["pdf"].as_str().unwrap())).expect("ai pdf");
        assert!(
            !tiling_patterns(&ai_pdf).is_empty(),
            "{name}: Illustrator writes a tiling pattern back"
        );
    }
}
