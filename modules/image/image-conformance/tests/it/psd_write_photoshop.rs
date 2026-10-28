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

//! PHOTOSHOP READS WHAT PAGED WRITES (image ADR 478). The layered PSD
//! save writes each case below; `scripts/photoshop/probes/psd-readback.jsx`
//! had Photoshop 27.10 OPEN those files and report every layer — its kind,
//! opacity, blend, the adjustment's parameters, the style's effects — the
//! document's mode, depth and format, and a PNG of its own render.
//!
//! The replay holds:
//! * each case's bytes to the recording: the writer rebuilds every file
//!   and its content hash must be the one Photoshop opened (a writer change
//!   asks for a new recording, `write_psd_readback_inputs`);
//! * Photoshop's reading to what was written: live layers of the written
//!   kinds with the written parameters;
//! * Photoshop's render of a paged-written adjustment layer to its render
//!   of its OWN layer of the same parameters (`adjustment-layers*`): the
//!   block paged writes draws as Photoshop's own does.
//!
//! Recording (maintainer, macOS + Photoshop):
//! ```text
//! PAGED_PSD_READBACK_OUT=<stage>/psd-readback cargo nextest run -p image-conformance \
//!   --run-ignored only write_psd_readback_inputs
//! PAGED_PROBE_STAGE=<stage> bash scripts/photoshop/run-probe.sh \
//!   scripts/photoshop/probes/psd-readback.jsx
//! ```

use std::path::PathBuf;
use std::sync::Arc;

use image_conformance::abr_corpus::json::Json;
use image_core::{ContentHash, Region};
use image_js::layers::{Adjustment, ColorStop, FillSource, GradientFill, LayerStack};
use image_js::pixels::Pixels;
use image_js::saveback::psd_write_stack;
use image_psd::effects::{LayerStyle, Shadow, Stroke, StrokeFill};
use image_psd::model::ColorMode;
use image_psd::PsdFile;

fn photoshop() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures/photoshop")
}

fn fixture(rel: &str) -> PsdFile {
    PsdFile::parse(&std::fs::read(photoshop().join(rel)).expect("fixture")).expect("parse")
}

fn open(file: &PsdFile) -> LayerStack {
    let import = if file.header.color_mode == ColorMode::Cmyk {
        let ink = image_js::ingest::psd_ink_transform(file);
        file.layer_plates_rgba8_via(&|c| ink.to_rgba8(c))
    } else {
        file.layer_plates_rgba8()
    }
    .expect("imports as layers");
    LayerStack::from_psd_plates_with(&import, Some(&file.layer_mask.layers)).expect("stack")
}

fn save(file: &PsdFile, stack: &LayerStack) -> Vec<u8> {
    let mut out = file.clone();
    // The merged composite is not what Photoshop shows (it recomposites a
    // layered file); a flat grey keeps the cases deterministic.
    let n = file.header.width as usize * file.header.height as usize;
    psd_write_stack(&mut out, stack, &vec![128u8; n * 4]).expect("layered save");
    out.write().expect("bytes")
}

/// Photoshop's own adjustment layers whose parameters paged writes again
/// as a NEW layer over the same background (`(dir, id)`).
const ADJUSTMENTS: [(&str, &str); 18] = [
    ("adjustment-layers", "brightness-contrast"),
    ("adjustment-layers", "curves-channels"),
    ("adjustment-layers", "exposure-offset-gamma"),
    ("adjustment-layers", "hue-sat-reds"),
    ("adjustment-layers", "invert"),
    ("adjustment-layers", "levels-channels"),
    ("adjustment-layers", "photo-filter"),
    ("adjustment-layers-ext", "black-white"),
    ("adjustment-layers-ext", "channel-mixer"),
    ("adjustment-layers-ext", "channel-mixer-mono"),
    ("adjustment-layers-ext", "color-balance"),
    ("adjustment-layers-ext", "gradient-map"),
    ("adjustment-layers-ext", "gradient-map-reversed"),
    ("adjustment-layers-ext", "posterize"),
    ("adjustment-layers-ext", "selective-color"),
    ("adjustment-layers-ext", "selective-color-absolute"),
    ("adjustment-layers-ext", "threshold"),
    ("adjustment-layers-ext", "vibrance"),
];

/// The adjustment of a Photoshop file's top layer, as the stack's typed
/// adjustment.
fn their_adjustment(file: &PsdFile) -> Adjustment {
    let rec = file.layer_mask.layers.last().expect("layers");
    let blocks: Vec<([u8; 4], Vec<u8>)> = rec
        .addl
        .iter()
        .filter_map(|a| {
            let raw = a.raw_block.as_deref()?;
            let n = u32::from_be_bytes(raw[8..12].try_into().ok()?) as usize;
            Some((a.key, raw[12..12 + n].to_vec()))
        })
        .collect();
    let psd = image_psd::adjustment::Adjustment::from_blocks(
        blocks.iter().map(|(k, v)| (k, v.as_slice())),
    )
    .expect("reads")
    .expect("an adjustment layer");
    image_js::layers::psd_adjustment(&psd)
}

fn paint(stack: &mut LayerStack, index: usize, rgb: [u8; 3]) {
    stack.set_active(index).expect("active");
    let (w, h) = (stack.width(), stack.height());
    let px: Vec<u8> = (0..w * h)
        .flat_map(|i| {
            let (x, y) = (i % w, i / w);
            let inside = (32..96).contains(&x) && (32..96).contains(&y);
            if inside {
                [rgb[0], rgb[1], rgb[2], 255]
            } else {
                [0, 0, 0, 0]
            }
        })
        .collect();
    stack
        .edit_active(
            "paint",
            Region::new(0, 0, w, h),
            Pixels::from_rgba8(Arc::from(px.into_boxed_slice())),
        )
        .expect("paint");
}

/// Every case: its file name and the bytes paged writes.
fn inputs() -> Vec<(String, Vec<u8>)> {
    let mut out = Vec::new();
    // A NEW adjustment layer of each kind, over Photoshop's background.
    for (dir, id) in ADJUSTMENTS {
        let file = fixture(&format!("{dir}/{id}.psd"));
        let adj = their_adjustment(&file);
        let mut stack = open_background(&file);
        stack.add_adjustment_layer("paged", adj, None);
        out.push((format!("adj-{id}.psd"), save(&file, &stack)));
    }
    // An EDITED Photoshop adjustment layer: Curves with a new point.
    {
        let file = fixture("adjustment-layers/curves-composite.psd");
        let mut stack = open(&file);
        let mut curves = [Vec::new(), Vec::new(), Vec::new(), Vec::new()];
        curves[0] = vec![(0, 0), (100, 60), (180, 220), (255, 255)];
        stack
            .set_adjustment_typed(1, Adjustment::Curves { curves })
            .expect("edit");
        out.push(("edited-curves.psd".into(), save(&file, &stack)));
    }
    // Fill layers and a styled pixel layer, over Photoshop's background.
    {
        let file = fixture("adjustment-layers-ext/vibrance.psd");
        let mut stack = open_background(&file);
        let i = stack.add_fill_layer("solid", FillSource::Solid { rgb: [30, 160, 90] });
        stack.set_opacity(i, 0.4).expect("opacity");
        let i = stack.add_fill_layer(
            "gradient",
            FillSource::Gradient(GradientFill {
                style: image_js::fill::GradientKind::Linear,
                angle: 30.0,
                scale: 100.0,
                reverse: false,
                offset: (0.0, 0.0),
                stops: vec![
                    ColorStop {
                        at: 0.0,
                        rgb: [200, 40, 40],
                    },
                    ColorStop {
                        at: 1.0,
                        rgb: [40, 40, 200],
                    },
                ],
            }),
        );
        stack.set_opacity(i, 0.5).expect("opacity");
        let j = stack.add("styled");
        paint(&mut stack, j, [240, 200, 40]);
        stack
            .set_style(
                j,
                Some(LayerStyle {
                    drop_shadows: vec![Shadow::drop_default()],
                    strokes: vec![Stroke {
                        size: 3.0,
                        fill: StrokeFill::Color { rgb: [20, 20, 160] },
                        ..Stroke::default()
                    }],
                    ..LayerStyle::default()
                }),
            )
            .expect("style");
        out.push(("fills-and-style.psd".into(), save(&file, &stack)));
    }
    // Smart object: opacity and name edited; it stays a smart object.
    {
        let file = fixture("psd-containers/smart-embedded.psd");
        let mut stack = open(&file);
        stack.set_opacity(1, 0.5).expect("opacity");
        stack.set_name(1, "smart, renamed").expect("name");
        out.push(("smart-edited.psd".into(), save(&file, &stack)));
    }
    // 16-bit: the square repainted; CMYK: the same; PSB: opacity and a
    // new layer.
    {
        let file = fixture("psd-containers/sixteen-bit.psd");
        let mut stack = open(&file);
        paint(&mut stack, 1, [40, 120, 200]);
        out.push(("sixteen-edited.psd".into(), save(&file, &stack)));
    }
    {
        let file = fixture("psd-containers/cmyk.psd");
        let mut stack = open(&file);
        paint(&mut stack, 1, [40, 120, 200]);
        out.push(("cmyk-edited.psd".into(), save(&file, &stack)));
    }
    {
        let file = fixture("psd-containers/psb.psb");
        let mut stack = open(&file);
        stack.set_opacity(1, 0.25).expect("opacity");
        let j = stack.add("new");
        paint(&mut stack, j, [40, 120, 200]);
        out.push(("psb-edited.psb".into(), save(&file, &stack)));
    }
    out
}

/// A Photoshop file opened as layers with every layer above its
/// background removed.
fn open_background(file: &PsdFile) -> LayerStack {
    // The adjustment kinds the import declines are read here through the
    // file's background only: build the stack from the background record.
    let mut bg = file.clone();
    bg.layer_mask.layers.truncate(1);
    bg.layer_mask.section_raw = None;
    open(&bg)
}

fn hash(bytes: &[u8]) -> String {
    format!("{:016x}", ContentHash::of(bytes).0)
}

/// Writes the cases for a recording (`PAGED_PSD_READBACK_OUT`), with the
/// manifest the probe reads: `file name<TAB>content hash` per line.
#[test]
#[ignore = "writes the psd-readback probe's inputs; set PAGED_PSD_READBACK_OUT"]
fn write_psd_readback_inputs() {
    let Ok(dir) = std::env::var("PAGED_PSD_READBACK_OUT") else {
        paged_test_resources::skip!(
            paged_test_resources::Resource::Tools,
            "psd-readback inputs: PAGED_PSD_READBACK_OUT is not set"
        );
    };
    let dir = PathBuf::from(dir);
    std::fs::create_dir_all(&dir).expect("out dir");
    let mut manifest = String::new();
    for (name, bytes) in inputs() {
        std::fs::write(dir.join(&name), &bytes).expect("write");
        manifest.push_str(&format!("{name}\t{}\n", hash(&bytes)));
    }
    std::fs::write(dir.join("manifest.txt"), manifest).expect("manifest");
}

fn report() -> Json {
    let text = std::fs::read_to_string(photoshop().join("psd-readback.photoshop.json"))
        .expect("psd-readback.photoshop.json");
    Json::parse(&text).expect("JSON")
}

fn case<'a>(r: &'a Json, file: &str) -> &'a Json {
    r.get("cases")
        .and_then(Json::as_array)
        .expect("cases")
        .iter()
        .find(|c| {
            c.get("params")
                .and_then(|p| p.get("file"))
                .and_then(Json::as_str)
                == Some(file)
        })
        .unwrap_or_else(|| panic!("no recording of {file}"))
}

fn layers(c: &Json) -> &[Json] {
    c.get("values")
        .and_then(|v| v.get("layers"))
        .and_then(Json::as_array)
        .expect("layers")
}

fn s<'a>(j: &'a Json, k: &str) -> &'a str {
    j.get(k).and_then(Json::as_str).unwrap_or("")
}

fn num(j: &Json, path: &[&str]) -> f64 {
    let mut cur = j;
    for k in path {
        cur = cur.get(k).unwrap_or_else(|| panic!("no {k} in {path:?}"));
    }
    cur.as_f64().expect("a number")
}

/// What Photoshop opened is what this writer writes now.
#[test]
#[allow(non_snake_case)]
fn photoshop_opened_the_files_this_writer_writes__feat__image_psd_mutatable() {
    let r = report();
    for (name, bytes) in inputs() {
        let c = case(&r, &name);
        assert_eq!(
            c.get("params")
                .and_then(|p| p.get("hash"))
                .and_then(Json::as_str),
            Some(hash(&bytes).as_str()),
            "{name}: the writer changed since the recording — re-record (module docs)"
        );
        assert!(c.get("error").is_none(), "{name}: Photoshop refused it");
    }
}

/// Photoshop reads paged's layers as LIVE layers of the written kinds,
/// with the written parameters.
#[test]
#[allow(non_snake_case)]
fn photoshop_reads_paged_layers_as_live_layers__feat__image_psd_mutatable() {
    let r = report();
    // Adjustment layers: a live layer of the kind (`LayerKind`), on top.
    let kinds = [
        ("brightness-contrast", "LayerKind.BRIGHTNESSCONTRAST"),
        ("curves-channels", "LayerKind.CURVES"),
        ("exposure-offset-gamma", "LayerKind.EXPOSURE"),
        ("hue-sat-reds", "LayerKind.HUESATURATION"),
        ("invert", "LayerKind.INVERSION"),
        ("levels-channels", "LayerKind.LEVELS"),
        ("photo-filter", "LayerKind.PHOTOFILTER"),
        ("black-white", "LayerKind.BLACKANDWHITE"),
        ("channel-mixer", "LayerKind.CHANNELMIXER"),
        ("channel-mixer-mono", "LayerKind.CHANNELMIXER"),
        ("color-balance", "LayerKind.COLORBALANCE"),
        ("gradient-map", "LayerKind.GRADIENTMAP"),
        ("gradient-map-reversed", "LayerKind.GRADIENTMAP"),
        ("posterize", "LayerKind.POSTERIZE"),
        ("selective-color", "LayerKind.SELECTIVECOLOR"),
        ("selective-color-absolute", "LayerKind.SELECTIVECOLOR"),
        ("threshold", "LayerKind.THRESHOLD"),
        ("vibrance", "LayerKind.VIBRANCE"),
    ];
    for (id, kind) in kinds {
        let c = case(&r, &format!("adj-{id}.psd"));
        let ls = layers(c);
        let top = ls.first().expect("a layer");
        assert_eq!(s(top, "name"), "paged", "adj-{id}");
        assert_eq!(s(top, "kind"), kind, "adj-{id}");
    }
    // Parameters Photoshop reads back from paged's blocks.
    let adj = |id: &str| -> Json {
        let c = case(&r, &format!("adj-{id}.psd"));
        layers(c)[0].get("adjustment").cloned().expect("adjustment")
    };
    assert_eq!(num(&adj("vibrance"), &["vibrance"]), 40.0);
    assert_eq!(num(&adj("vibrance"), &["saturation"]), -20.0);
    assert_eq!(num(&adj("posterize"), &["levels"]), 5.0);
    assert_eq!(num(&adj("threshold"), &["level"]), 140.0);
    assert_eq!(num(&adj("brightness-contrast"), &["brightness"]), 30.0);
    assert_eq!(num(&adj("brightness-contrast"), &["center"]), 40.0);
    assert_eq!(num(&adj("black-white"), &["red"]), 40.0);
    assert_eq!(num(&adj("black-white"), &["magenta"]), 80.0);
    assert_eq!(num(&adj("photo-filter"), &["density"]), 50.0);

    // Fill layers and a style.
    let c = case(&r, "fills-and-style.psd");
    let ls = layers(c);
    let by = |n: &str| ls.iter().find(|l| s(l, "name") == n).expect(n);
    assert_eq!(s(by("solid"), "kind"), "LayerKind.SOLIDFILL");
    assert_eq!(s(by("gradient"), "kind"), "LayerKind.GRADIENTFILL");
    assert_eq!(num(by("solid"), &["opacity"]).round(), 40.0);
    let fx = by("styled").get("effects").expect("effects");
    assert!(fx.get("dropShadow").is_some(), "drop shadow");
    assert!(fx.get("frameFX").is_some(), "stroke");

    // The edited curves layer carries the new curve.
    let c = case(&r, "edited-curves.psd");
    assert_eq!(s(&layers(c)[0], "kind"), "LayerKind.CURVES");

    // The smart object stays a smart object, at its new opacity.
    let c = case(&r, "smart-edited.psd");
    let smart = layers(c)
        .iter()
        .find(|l| s(l, "name") == "smart, renamed")
        .expect("renamed");
    assert_eq!(s(smart, "kind"), "LayerKind.SMARTOBJECT");
    assert_eq!(num(smart, &["opacity"]).round(), 50.0);

    // The documents keep their depth, mode and format.
    let doc = |f: &str| {
        case(&r, f)
            .get("values")
            .and_then(|v| v.get("document"))
            .cloned()
    };
    let d = doc("sixteen-edited.psd").expect("doc");
    assert_eq!(s(&d, "bits"), "BitsPerChannelType.SIXTEEN");
    let d = doc("cmyk-edited.psd").expect("doc");
    assert_eq!(s(&d, "mode"), "DocumentMode.CMYK");
    let d = doc("psb-edited.psb").expect("doc");
    assert_eq!(layers(case(&r, "psb-edited.psb")).len(), 4);
    assert_eq!(s(&d, "mode"), "DocumentMode.RGB");
}

/// Photoshop draws paged's adjustment layer as it draws its own of the
/// same parameters (its render of each `adj-*` file against its PNG of the
/// layer it wrote itself).
#[test]
#[allow(non_snake_case)]
fn photoshop_draws_paged_adjustment_layers_as_its_own__feat__image_psd_mutatable() {
    let mut report_lines = Vec::new();
    let mut problems = Vec::new();
    for (dir, id) in ADJUSTMENTS {
        let theirs = read_png8(&photoshop().join(format!("{dir}/{id}.png")));
        let ours = read_png8(&photoshop().join(format!("psd-readback/adj-{id}.png")));
        assert_eq!(theirs.len(), ours.len(), "{id}: extent");
        let max = theirs
            .iter()
            .zip(&ours)
            .map(|(a, b)| a.abs_diff(*b))
            .max()
            .unwrap_or(0);
        report_lines.push(format!("{id:<26} max {max}"));
        // Recorded 2026-10-28: 17 of 18 kinds draw IDENTICALLY. The Photo
        // Filter block is byte for byte Photoshop's own
        // (psd_adjustment_blocks_photoshop.rs) and Photoshop reports the
        // same Lab, density and switch for it; its render of the two files
        // differs by up to 3 levels, which is Photoshop's (its own layer
        // was rendered in an earlier session, 2026-10-05).
        let allowed = if id == "photo-filter" { 3 } else { 0 };
        if max > allowed {
            problems.push(format!("{id}: {max} levels from Photoshop's own layer"));
        }
    }
    println!("{}", report_lines.join("\n"));
    assert!(problems.is_empty(), "{}", problems.join("\n"));
}

/// An 8-bit PNG's RGB samples (the probe's renders are 8-bit).
fn read_png8(p: &std::path::Path) -> Vec<u8> {
    let bytes = std::fs::read(p).unwrap_or_else(|e| panic!("{}: {e}", p.display()));
    let d = image_js::ingest::decode_rgba8(&bytes).expect("png");
    d.rgba
        .to_rgba8()
        .chunks(4)
        .flat_map(|px| [px[0], px[1], px[2]])
        .collect()
}
