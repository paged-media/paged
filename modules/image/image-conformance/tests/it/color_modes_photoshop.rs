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

//! The colour modes and the depth of image ADR 484 against Photoshop,
//! replayed from `fixtures/photoshop/color-modes`
//! (`scripts/photoshop/probes/color-modes.jsx`, Photoshop 27.10).
//!
//! * BLENDING IN THE MODE — layered Lab and Grayscale documents (8 and 16
//!   bits) and a 32-bit float one, each with one feathered layer per
//!   blend mode over a three-colour background, saved with real merged
//!   data. The file's layers open as the app opens them and fold; the
//!   result is held, tile by tile, to Photoshop's own merged composite
//!   (through the same transform to sRGB, so only the blend is judged).
//!   The fold in RGB, which the stack ran before, is measured beside it.
//! * 32 BITS — Photoshop's 8/16 → 32 Bits/Channel of the `colour-sweep`
//!   stimulus against `Pixels::at_depth(F32)`.
//! * INDEXED — the Web palette without dither (our nearest-colour
//!   mapping against Photoshop's indices) and each document's decode
//!   against Photoshop's own sRGB render.
//! * MULTICHANNEL — the channels Photoshop makes from RGB and our decode
//!   of them.

#![allow(non_snake_case)]

use std::path::PathBuf;

use image_core::SampleDepth;
use image_js::color_mode::{DocMode, StoredToSrgb};
use image_js::layers::LayerStack;
use image_js::pixels::Pixels;
use image_psd::PsdFile;
use zune_core::bytestream::ZCursor;
use zune_core::result::DecodingResult;
use zune_png::PngDecoder;

fn dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures/photoshop")
}

fn psd(id: &str) -> PsdFile {
    let p = dir().join(format!("color-modes/{id}.psd"));
    PsdFile::parse(&std::fs::read(&p).expect("read fixture PSD")).expect("parse")
}

/// A 16-bit PNG's RGB samples.
fn png16(rel: &str) -> Vec<[u16; 3]> {
    let bytes = std::fs::read(dir().join(rel)).expect("png");
    let mut dec = PngDecoder::new(ZCursor::new(&bytes));
    let res = dec.decode().expect("decode");
    let ch = dec.colorspace().expect("colorspace").num_components();
    let DecodingResult::U16(v) = res else {
        panic!("{rel}: not 16-bit");
    };
    v.chunks_exact(ch).map(|p| [p[0], p[1], p[2]]).collect()
}

/// The document as `layers_open_from_psd` opens it: plates through the
/// file's transform, the mode adopted (`adopt` false: the stack's former
/// RGB fold, measured beside).
fn open(file: &PsdFile, adopt: bool) -> LayerStack {
    open_keeping(file, adopt, &|_| true)
}

/// [`open`], keeping only the layers `keep` names.
fn open_keeping(file: &PsdFile, adopt: bool, keep: &dyn Fn(&str) -> bool) -> LayerStack {
    let t = StoredToSrgb::for_psd(file).expect("transform");
    let import = match &t {
        Some(t) => file.layer_plates_device(&|d| t.rgb_of(d)),
        None => file.layer_plates_rgba8(),
    }
    .expect("imports");
    let mut s =
        LayerStack::from_psd_plates_with(&import, Some(&file.layer_mask.layers)).expect("stack");
    if adopt {
        if let Some(m) = DocMode::of_psd(file) {
            s.adopt_mode(m);
        }
    }
    for i in (0..s.len()).rev() {
        if !keep(&s.layers()[i].name) {
            s.remove(i).expect("remove");
        }
    }
    s
}

/// The modes a Lab document offers that the plane fold does not: Hue and
/// Saturation work on L*C*h; a Lab document with one folds in RGB (said
/// by `ink_fold_declines`) and their tiles are not judged. (Color and
/// Luminosity split into L* and chroma steps and are; a Grayscale
/// document offers none of the four, so its layers are Normal.)
const NONSEP: [&str; 2] = ["hue", "saturation"];

/// Photoshop's merged composite as straight sRGB floats (3 a pixel).
fn merged_rgb(file: &PsdFile) -> Vec<f32> {
    let c = file.composite_samples().expect("merged");
    match StoredToSrgb::for_psd(file).expect("transform") {
        Some(t) => t.rgb_of(&c.samples),
        None => c.samples.clone(),
    }
}

/// ΔE*ab (D50) of two sRGB colours.
fn de(a: [f32; 3], b: [f32; 3]) -> f64 {
    let l = |c: [f32; 3]| paged_color::lab::srgb_to_lab_d50(c.map(|v| v.clamp(0.0, 1.0)));
    f64::from(paged_color::cms::delta_e76(l(a), l(b)))
}

/// Per tile of the 5 × 4 layout: (max, p95) ΔE of `ours` against
/// `theirs` (sRGB floats, 3 a pixel, 160 wide).
fn tiles(ours: &[f32], theirs: &[f32]) -> Vec<(f64, f64)> {
    (0..20)
        .map(|i| {
            let (x0, y0) = ((i % 5) * 32, (i / 5) * 32);
            let mut d: Vec<f64> = (y0..y0 + 32)
                .flat_map(|y| (x0..x0 + 32).map(move |x| y * 160 + x))
                .map(|p| {
                    let g = |v: &[f32]| [v[p * 3], v[p * 3 + 1], v[p * 3 + 2]];
                    de(g(ours), g(theirs))
                })
                .collect();
            d.sort_by(f64::total_cmp);
            (d[d.len() - 1], d[(d.len() * 95) / 100])
        })
        .collect()
}

fn rgb_of(px: &Pixels) -> Vec<f32> {
    (0..px.pixel_count())
        .flat_map(|i| (0..3).map(move |c| f32::from(px.sample16(i, c)) / 65535.0))
        .collect()
}

const TILE_IDS: [&str; 20] = [
    "normal-100",
    "normal-50",
    "multiply",
    "screen",
    "overlay",
    "darken",
    "lighten",
    "color-burn",
    "color-dodge",
    "soft-light",
    "hard-light",
    "difference",
    "exclusion",
    "linear-burn",
    "linear-dodge",
    "hue",
    "saturation",
    "color",
    "luminosity",
    "multiply-50",
];

/// Stated per document: the worst tile's max and p95 ΔE*ab of the fold
/// in the document's own numbers, and the p95 the RGB fold is at least
/// (the improvement this record is for). Measured 2026-10-30.
/// The RGB fold was 8.7–43 (Lab) and 0.7–6.7 (grey) ΔE p95 off per tile.
/// Measured on Metal and on the CPU fold of CI (lab-8: 2.47 / 1.81 there).
const IN_MODE: &[(&str, f64, f64)] = &[
    ("lab-8", 2.7, 1.9),
    ("lab-16", 0.5, 0.25),
    ("gray-8", 1.5, 1.1),
    ("gray-16", 0.2, 0.1),
];

#[test]
fn lab_and_grayscale_documents_blend_in_their_own_numbers_as_photoshop_does__feat__image_io_depth_color_modes(
) {
    let ctx = image_conformance::device::test_device();
    let mut report = Vec::new();
    let mut problems = Vec::new();
    for &(id, max_de, p95_de) in IN_MODE {
        let file = psd(id);
        let theirs = merged_rgb(&file);
        let keep = |n: &str| !NONSEP.contains(&n);
        assert_eq!(
            open(&file, true).ink_fold_declines().is_some(),
            id.starts_with("lab"),
            "{id}: a Lab document's Hue … Luminosity layers fold in RGB"
        );
        let stack = open_keeping(&file, true, &keep);
        assert_eq!(
            stack.ink_fold_declines(),
            None,
            "{id}: every blend is separable here"
        );
        let ours = rgb_of(&pollster::block_on(stack.composite_px(ctx, None)).expect("fold"));
        let rgb = rgb_of(
            &pollster::block_on(open_keeping(&file, false, &keep).composite_px(ctx, None))
                .expect("rgb fold"),
        );
        let t = tiles(&ours, &theirs);
        let r = tiles(&rgb, &theirs);
        for (k, id_t) in TILE_IDS.iter().enumerate() {
            if NONSEP.contains(id_t) {
                continue;
            }
            report.push(format!(
                "{id:<7} {id_t:<12} in mode max {:>6.2} p95 {:>6.2} | rgb max {:>6.2} p95 {:>6.2}",
                t[k].0, t[k].1, r[k].0, r[k].1
            ));
        }
        let judged = || {
            t.iter()
                .zip(TILE_IDS)
                .filter(|(_, n)| !NONSEP.contains(n))
                .map(|(x, _)| *x)
        };
        let worst_max = judged().map(|x| x.0).fold(0.0, f64::max);
        let worst_p95 = judged().map(|x| x.1).fold(0.0, f64::max);
        if worst_max > max_de || worst_p95 > p95_de {
            problems.push(format!(
                "{id}: worst max {worst_max:.2} p95 {worst_p95:.2}, stated {max_de} / {p95_de}"
            ));
        }
    }
    println!("{}", report.join("\n"));
    assert!(
        problems.is_empty(),
        "{}\n{}",
        problems.join("\n"),
        report.join("\n")
    );
}

#[test]
fn a_float_document_folds_linear_light_as_photoshop_does__feat__image_io_depth_color_modes() {
    let file = psd("float-32");
    let c = file.composite_samples().expect("merged");
    assert_eq!(c.depth, 32);
    let stack = open(&file, true);
    assert_eq!(stack.depth(), SampleDepth::F32);
    let ctx = image_conformance::device::test_device();
    let ours = pollster::block_on(stack.composite_px(ctx, None)).expect("fold");
    assert!(ours.is_float());
    let lin = ours.to_f32_linear();
    let mut report = Vec::new();
    let mut problems = Vec::new();
    for (k, id) in TILE_IDS.iter().enumerate() {
        let (x0, y0) = ((k % 5) * 32, (k / 5) * 32);
        let mut worst = 0f32;
        for y in y0..y0 + 32 {
            for x in x0..x0 + 32 {
                let p = y * 160 + x;
                for ch in 0..3 {
                    worst = worst.max((lin[p * 4 + ch] - c.samples[p * 3 + ch]).abs());
                }
            }
        }
        report.push(format!("{id:<12} max |linear| {worst:.4}"));
        let stated = FLOAT_STATED
            .iter()
            .find(|t| t.0 == *id)
            .map_or(0.002, |t| t.1);
        if worst > stated {
            problems.push(format!("{id}: {worst:.4}, stated {stated}"));
        }
    }
    println!("{}", report.join("\n"));
    assert!(
        problems.is_empty(),
        "{}\n{}",
        problems.join("\n"),
        report.join("\n")
    );
}

/// The 32-bit tiles that are not within 0.002 of Photoshop's linear
/// values, measured 2026-10-30. Linear Dodge: the stack's compose kernels
/// clip the sum at 1 (`s_linear_dodge`), Photoshop's 32-bit Add does not
/// (a recorded defect: the tile adds two bright colours past white). Hue,
/// Color and Luminosity: Photoshop's 32-bit non-separable modes do not
/// measure luminosity on linear values with the stack's coefficients
/// (unmodelled). Every other tile — Normal at 100 and 50 %, Multiply,
/// Darken, Lighten, Difference, Saturation — is within 0.001; the tiles
/// of modes a 32-bit document does not offer stay Normal in the file.
const FLOAT_STATED: &[(&str, f32)] = &[
    ("linear-dodge", 0.73),
    ("hue", 0.06),
    ("color", 0.19),
    ("luminosity", 0.22),
];

#[test]
fn eight_and_sixteen_to_32_bits_is_photoshops_linearisation__feat__image_io_depth_color_modes() {
    let sweep = png16("stimuli/colour-sweep.png");
    let px16: Vec<u16> = sweep
        .iter()
        .flat_map(|p| [p[0], p[1], p[2], u16::MAX])
        .collect();
    // 16 → 32: the sRGB decode of every sample.
    let file = psd("float-from-16");
    let c = file.composite_samples().expect("merged");
    let lin = Pixels::from_rgba16(&px16)
        .at_depth(SampleDepth::F32)
        .to_f32_linear();
    let mut worst = 0f32;
    for i in 0..sweep.len() {
        for ch in 0..3 {
            worst = worst.max((lin[i * 4 + ch] - c.samples[i * 3 + ch]).abs());
        }
    }
    println!("float-from-16: max |linear| {worst:.6}");
    assert!(worst < 2e-4, "float-from-16: {worst}");
    // 8 → 32: every float Photoshop stored is the sRGB decode of an 8-bit
    // level (encoded back, within 0.02 of a whole level); the level is
    // ours within one — Photoshop's own 16 → 8 step rounds its 15-bit
    // samples, ours the PNG's 16-bit ones.
    let file = psd("float-from-8");
    let c = file.composite_samples().expect("merged");
    let ours = Pixels::from_rgba16(&px16).at_depth(SampleDepth::U8);
    let (mut off_level, mut off_ours, mut differ) = (0f32, 0i32, 0usize);
    for i in 0..sweep.len() {
        for ch in 0..3 {
            let e = paged_color::math::linear_to_srgb(c.samples[i * 3 + ch]) * 255.0;
            off_level = off_level.max((e - e.round()).abs());
            let d = (e.round() as i32 - i32::from(ours.raw()[i * 4 + ch])).abs();
            off_ours = off_ours.max(d);
            differ += usize::from(d != 0);
        }
    }
    println!("float-from-8: off a level {off_level:.4}, ours within {off_ours} ({differ} samples differ)");
    assert!(
        off_level < 0.03,
        "float-from-8 is not a decoded level: {off_level}"
    );
    assert!(off_ours <= 1, "float-from-8: {off_ours} levels from ours");
}

/// The `colour-sweep` stimulus at 8 bits, as Photoshop reduces it (its
/// 16 → 8 step, read back from the 8-bit documents it wrote, is not ours
/// to the level; the indexed and multichannel cases are judged from it).
fn sweep8_from(file: &PsdFile) -> Vec<[u8; 3]> {
    // Multichannel from RGB keeps the RGB channels' values: the 8-bit
    // sweep Photoshop converted, read back from that document.
    let c = file.composite_samples().expect("merged");
    (0..c.samples.len() / c.channels)
        .map(|i| {
            let s = |k: usize| (c.samples[i * c.channels + k] * 255.0).round() as u8;
            [s(0), s(1), s(2)]
        })
        .collect()
}

/// Indexed with the Web palette and no dither: each pixel takes the
/// nearest of the 216 colours. Photoshop's choice against ours (squared
/// distance in sRGB levels) on the 8-bit sweep, and the decode of both
/// Indexed documents against Photoshop's own sRGB render.
#[test]
fn indexed_documents_decode_and_map_to_the_nearest_colour_as_photoshop_does__feat__image_io_depth_color_modes(
) {
    // The 8-bit sweep as Photoshop reduced it (Multichannel from RGB keeps
    // the values, `multichannel_channels_are_the_rgb_values`).
    let sweep = sweep8_from(&psd("multichannel-8"));
    let file = psd("indexed-web");
    let pal = file.indexed_palette().expect("table");
    assert_eq!(pal.count, Some(216), "the Web palette");
    let web = image_js::color_mode::web_palette();
    let c = file.composite_samples().expect("indices");
    let mut differ = 0usize;
    let mut worst = 0i32;
    for (i, &rgb) in sweep.iter().enumerate() {
        let theirs = pal.colours[(c.samples[i] * 255.0).round() as usize];
        let ours = web[image_js::color_mode::nearest_index(&web, rgb)];
        if ours != theirs {
            differ += 1;
            worst = worst.max(
                (0..3)
                    .map(|k| (i32::from(ours[k]) - i32::from(theirs[k])).abs())
                    .max()
                    .unwrap(),
            );
        }
    }
    println!(
        "indexed-web: {differ} of {} pixels map elsewhere (worst {worst} levels)",
        sweep.len()
    );
    assert_eq!(differ, 0, "every pixel takes Photoshop's colour");
    assert!(worst <= 51, "one Web step at most: {worst}");
    for id in ["indexed-web", "indexed-exact"] {
        let file = psd(id);
        let img = image_js::ingest::decode_rgba8(
            &std::fs::read(dir().join(format!("color-modes/{id}.psd"))).expect("psd"),
        )
        .expect("decodes");
        let render = png16(&format!("color-modes/{id}.png"));
        let mut worst = 0u16;
        for (i, r) in render.iter().enumerate() {
            for (k, &v) in r.iter().enumerate() {
                worst = worst.max(img.rgba.sample16(i, k).abs_diff(v) / 257);
            }
        }
        println!("{id}: decode vs Photoshop's render, max {worst} levels");
        assert!(worst <= 1, "{id}: {worst}");
        assert_eq!(
            image_js::color_mode::DocMode::of_psd(&file).map(|m| m.mode),
            Some(image_js::color_mode::ColorMode::Indexed)
        );
    }
}

/// Multichannel from RGB: the Cyan, Magenta and Yellow channels hold the
/// red, green and blue values, displayed in their inks (resource 1077), so
/// the decode is the 8-bit image itself.
#[test]
fn multichannel_channels_are_the_rgb_values__feat__image_io_depth_color_modes() {
    let file = psd("multichannel-8");
    let mode = image_js::color_mode::DocMode::of_psd(&file).expect("multichannel");
    let spots = mode
        .table
        .as_ref()
        .and_then(|t| t.spots())
        .expect("channels")
        .to_vec();
    assert_eq!(spots.len(), 3);
    assert_eq!(
        spots.iter().map(|s| s.ink).collect::<Vec<_>>(),
        vec![[0, 255, 255], [255, 0, 255], [255, 255, 0]],
        "{spots:?}"
    );
    // The 8-bit reduction of the sweep against Photoshop's channels: the
    // red, green and blue values, within Photoshop's own 16 → 8 rounding.
    let sweep = png16("stimuli/colour-sweep.png");
    let theirs = sweep8_from(&file);
    let worst = sweep
        .iter()
        .zip(&theirs)
        .flat_map(|(s, t)| (0..3).map(move |k| (i32::from(s[k] >> 8) - i32::from(t[k])).abs()))
        .max()
        .unwrap();
    assert!(worst <= 1, "{worst}");
    let img = image_js::ingest::decode_rgba8(
        &std::fs::read(dir().join("color-modes/multichannel-8.psd")).expect("psd"),
    )
    .expect("decodes");
    let rgba = img.rgba.to_rgba8();
    for (i, t) in theirs.iter().enumerate() {
        assert_eq!(&rgba[i * 4..i * 4 + 3], t, "pixel {i}");
    }
}

// ─────────────── what the save writes, opened by Photoshop ───────────────

/// The documents the layered save writes in the modes and the depth of
/// image ADR 484, over the background of a Photoshop-written RGB file: a
/// painted square under Multiply at 70 %, then 32 bits; that image as
/// Indexed (Web palette) and as Multichannel. Each with our composite
/// (the CPU fold, deterministic).
fn saved_cases() -> Vec<(&'static str, Vec<u8>, Pixels)> {
    use image_js::color_mode::{web_palette, ColorMode as M};
    let base = || {
        let file = PsdFile::parse(
            &std::fs::read(dir().join("adjustment-layers-ext/vibrance.psd")).expect("fixture"),
        )
        .expect("parse");
        let mut bg = file.clone();
        bg.layer_mask.layers.truncate(1);
        bg.layer_mask.section_raw = None;
        let import = bg.layer_plates_rgba8().expect("background");
        let mut s =
            LayerStack::from_psd_plates_with(&import, Some(&bg.layer_mask.layers)).expect("stack");
        let j = s.add("painted");
        let (w, h) = (s.width(), s.height());
        let px: Vec<u8> = (0..w * h)
            .flat_map(|i| {
                let (x, y) = (i % w, i / w);
                if (32..96).contains(&x) && (32..96).contains(&y) {
                    [40, 160, 220, 255]
                } else {
                    [0, 0, 0, 0]
                }
            })
            .collect();
        s.set_active(j).expect("active");
        s.edit_active(
            "paint",
            image_core::Region::new(0, 0, w, h),
            Pixels::from_rgba8(std::sync::Arc::from(px.into_boxed_slice())),
        )
        .expect("paint");
        s.set_opacity(j, 0.7).expect("opacity");
        s.set_blend(j, "multiply").expect("blend");
        (file, s)
    };
    let write = |file: &PsdFile, s: &LayerStack| -> (Vec<u8>, Pixels) {
        let composite = pollster::block_on(s.composite_px(None, None)).expect("fold");
        let mut out = file.clone();
        image_js::psd_write::psd_write_stack_px(&mut out, s, &composite).expect("save");
        (out.write().expect("bytes"), composite)
    };
    let mut cases = Vec::new();
    let (file, mut s) = base();
    s.set_depth(SampleDepth::F32).expect("32 bits");
    let (b, c) = write(&file, &s);
    cases.push(("saved-float-32.psd", b, c));
    let (file, mut s) = base();
    pollster::block_on(s.convert_flat(None, DocMode::indexed(web_palette()))).expect("indexed");
    let (b, c) = write(&file, &s);
    cases.push(("saved-indexed-web.psd", b, c));
    let (file, mut s) = base();
    pollster::block_on(s.convert_flat(None, DocMode::multichannel_from(M::Rgb).expect("from RGB")))
        .expect("multichannel");
    let (b, c) = write(&file, &s);
    cases.push(("saved-multichannel.psd", b, c));
    cases
}

/// Writes the saved documents for a recording (`PAGED_MODE_READBACK_OUT`,
/// then `scripts/photoshop/probes/mode-readback.jsx`).
#[test]
#[ignore = "writes the mode-readback probe's inputs; run by hand with PAGED_MODE_READBACK_OUT"]
fn write_mode_readback_inputs() {
    let Ok(out) = std::env::var("PAGED_MODE_READBACK_OUT") else {
        return;
    };
    let out = PathBuf::from(out);
    std::fs::create_dir_all(&out).expect("out dir");
    let mut manifest = String::new();
    for (name, bytes, _) in saved_cases() {
        std::fs::write(out.join(name), &bytes).expect("write");
        manifest.push_str(name);
        manifest.push('\n');
    }
    std::fs::write(out.join("manifest.txt"), manifest).expect("manifest");
}

/// Photoshop opens what the save writes (`mode-readback.jsx`): the 32-bit
/// document with both layers live, the Indexed and the Multichannel
/// documents in their modes with their tables and channel names — and
/// merges each, in its own numbers, as our fold composited it.
#[test]
fn photoshop_opens_the_saved_float_indexed_and_multichannel_documents__feat__image_io_depth_color_modes(
) {
    let text = std::fs::read_to_string(dir().join("mode-readback.photoshop.json")).expect("json");
    let r = image_conformance::abr_corpus::json::Json::parse(&text).expect("parse");
    let cases = r.get("cases").and_then(|c| c.as_array()).expect("cases");
    let value = |id: &str, k: &str| -> String {
        let c = cases
            .iter()
            .find(|c| c.get("id").and_then(|v| v.as_str()) == Some(id))
            .unwrap_or_else(|| panic!("{id} recorded"));
        let v = c.get("values").and_then(|v| v.get(k)).expect("value");
        v.as_str()
            .map(str::to_string)
            .or_else(|| v.as_f64().map(|f| f.to_string()))
            .unwrap_or_else(|| format!("{v:?}"))
    };
    let merged = |id: &str| -> PsdFile {
        PsdFile::parse(
            &std::fs::read(dir().join(format!("mode-readback/{id}.merged.psd"))).expect("merged"),
        )
        .expect("parse")
    };
    for (name, _, ours) in saved_cases() {
        let id = name.trim_end_matches(".psd");
        let m = merged(id).composite_samples().expect("Photoshop's merge");
        match id {
            "saved-float-32" => {
                assert_eq!(value(id, "mode"), "DocumentMode.RGB");
                assert_eq!(value(id, "bits"), "32");
                assert_eq!(value(id, "layers"), "2", "both layers live");
                let lin = ours.to_f32_linear();
                let worst = (0..m.samples.len())
                    .map(|i| (lin[(i / 3) * 4 + i % 3] - m.samples[i]).abs())
                    .fold(0f32, f32::max);
                println!("{id}: Photoshop's merge vs ours, max |linear| {worst:.4}");
                assert!(worst < 2e-3, "{id}: {worst}");
            }
            "saved-indexed-web" => {
                assert_eq!(value(id, "mode"), "DocumentMode.INDEXEDCOLOR");
                let f = merged(id);
                let pal = f.indexed_palette().expect("table");
                let rgba = ours.to_rgba8();
                for i in 0..m.samples.len() {
                    let c = pal.colours[(m.samples[i] * 255.0).round() as usize];
                    assert_eq!(&rgba[i * 4..i * 4 + 3], &c, "pixel {i}");
                }
            }
            _ => {
                assert_eq!(value(id, "mode"), "DocumentMode.MULTICHANNEL");
                assert_eq!(m.channels, 3);
                let rgba = ours.to_rgba8();
                for i in 0..m.samples.len() {
                    let want = rgba[(i / 3) * 4 + i % 3];
                    assert_eq!((m.samples[i] * 255.0).round() as u8, want, "sample {i}");
                }
            }
        }
    }
}
