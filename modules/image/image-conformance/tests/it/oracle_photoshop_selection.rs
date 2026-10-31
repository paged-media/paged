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

//! THE PHOTOSHOP ORACLE FOR SELECTIONS (image ADR 470): Select ▸ Color
//! Range and Select ▸ Grow / Similar, recorded by
//! `scripts/photoshop/probes/selection.jsx` on the `colour-sweep`
//! stimulus (each selection rendered as white-through-the-selection over
//! black, so the output's grey IS the coverage).
//!
//! Every case is CLASSIFIED in [`LEDGER`]:
//!
//! * `Agreement` — the replay holds our coverage within the stated bound
//!   (max and mean absolute difference, coverage 0…1);
//! * `Convention` — a documented difference (the note says what and why);
//!   the replay holds the MEASURED distance so it cannot silently grow.
//!
//! Color Range is replayed through the `select.color_range` CPU twin on
//! the 16-bit stimulus; with a GPU adapter the kernel itself is held to
//! the twin on the same stimulus (`gpu_kernel_agrees_with_its_twin`).
//! Grow / Similar replay `image_js::selection::grow_coverage` on the
//! stimulus quantised to 8 bits, the engine's working depth.

use std::path::PathBuf;

use image_conformance::abr_corpus::json::Json;
use image_gpu::SelectionCoverage;
use image_kernels::families::select::{color_range_px, ColorRangeParams, SELECT_COLOR_RANGE};
use zune_core::bytestream::ZCursor;
use zune_png::PngDecoder;

fn dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures/photoshop")
}

/// A 16-bit PNG's first three channels as 0…1.
fn read(path: &str) -> (usize, usize, Vec<[f32; 3]>) {
    let p = dir().join(path);
    let bytes = std::fs::read(&p).unwrap_or_else(|e| panic!("{}: {e}", p.display()));
    let mut dec = PngDecoder::new(ZCursor::new(&bytes));
    let res = dec.decode().expect("png");
    let (w, h) = dec.dimensions().expect("dims");
    let ch = dec.colorspace().expect("colorspace").num_components();
    let samples: Vec<f32> = match res {
        zune_core::result::DecodingResult::U16(v) => {
            v.iter().map(|&s| f32::from(s) / 65535.0).collect()
        }
        zune_core::result::DecodingResult::U8(v) => {
            v.iter().map(|&s| f32::from(s) / 255.0).collect()
        }
        _ => panic!("unexpected sample type"),
    };
    let px = samples
        .chunks_exact(ch)
        .map(|c| [c[0], c[1], c[2]])
        .collect();
    (w, h, px)
}

#[derive(Clone, Copy)]
enum Class {
    /// Holds within (max, mean).
    Agreement(f32, f32),
    /// A stated difference; the recorded (max, mean) may not grow.
    Convention(f32, f32, &'static str),
}

/// Every recorded case and its class.
const LEDGER: &[(&str, Class)] = &[
    (
        "sampled-red-f0",
        Class::Convention(
            0.63,
            0.0001,
            "fuzziness 0 selects only the exact colour: Photoshop gives the sampled \
         pixel itself 0.62 (its 8-bit Lab quantisation), we give 1",
        ),
    ),
    ("sampled-red-f10", Class::Agreement(0.02, 0.0005)),
    ("sampled-red-f40", Class::Agreement(0.02, 0.0005)),
    ("sampled-red-f100", Class::Agreement(0.02, 0.0005)),
    ("sampled-red-f200", Class::Agreement(0.02, 0.0010)),
    ("sampled-red-f40-invert", Class::Agreement(0.02, 0.0005)),
    ("sampled-box-f20", Class::Agreement(0.02, 0.0005)),
    ("sampled-grey-f40", Class::Agreement(0.02, 0.0005)),
    ("preset-reds", Class::Agreement(0.01, 0.0005)),
    ("preset-yellows", Class::Agreement(0.01, 0.0005)),
    ("preset-greens", Class::Agreement(0.01, 0.0005)),
    ("preset-cyans", Class::Agreement(0.01, 0.0005)),
    ("preset-blues", Class::Agreement(0.01, 0.0005)),
    ("preset-magentas", Class::Agreement(0.01, 0.0005)),
    // The tonal presets agree to the quantisation of Photoshop's 8-bit
    // luma: the steeper the falloff (the narrower the width), the larger
    // one luma level's worth of coverage.
    ("preset-highlights", Class::Agreement(0.05, 0.003)),
    ("preset-midtones", Class::Agreement(0.05, 0.004)),
    ("preset-shadows", Class::Agreement(0.05, 0.003)),
    ("preset-shadows-f40-u100", Class::Agreement(0.05, 0.003)),
    ("preset-highlights-f10-l200", Class::Agreement(0.10, 0.003)),
    (
        "preset-midtones-f30-l80-u160",
        Class::Agreement(0.08, 0.004),
    ),
    (
        "preset-skin",
        Class::Convention(
            1.0,
            0.25,
            "Photoshop's skin-tone model is unpublished and also selects bright \
         near-neutrals; ours is the classical Cb/Cr skin ellipse (Hsu et al. 2002)",
        ),
    ),
    (
        "grow-t16",
        Class::Convention(
            1.0,
            0.01,
            "Photoshop's Grow range is tighter than a per-channel box along \
         saturated hue ramps; ours is the selected colours' RGB box ± tolerance",
        ),
    ),
    ("grow-t32", Class::Convention(1.0, 0.02, "as grow-t16")),
    ("similar-t16", Class::Convention(1.0, 0.01, "as grow-t16")),
    ("similar-t32-grey", Class::Agreement(0.0, 0.0)),
];

/// Our params for a recorded case (None: not a Color Range case).
fn params(c: &Json) -> Option<ColorRangeParams> {
    let p = c.get("params")?;
    let f = |k: &str| p.get(k).and_then(Json::as_f64).map(|v| v as f32);
    let lab = |k: &str| -> Option<[f32; 3]> {
        let a = p.get(k)?.as_array()?;
        Some([
            a[0].as_f64()? as f32,
            a[1].as_f64()? as f32,
            a[2].as_f64()? as f32,
        ])
    };
    let invert = matches!(p.get("invert"), Some(Json::Bool(true)));
    match p.get("mode")?.as_str()? {
        "sampled" => Some(ColorRangeParams::sampled_box(
            lab("min")?,
            lab("max")?,
            f("fuzziness")?,
            invert,
        )),
        "preset" => {
            let name = p.get("preset")?.as_str()?;
            let hue = match name {
                "reds" => Some(0.0),
                "yellows" => Some(60.0),
                "greens" => Some(120.0),
                "cyans" => Some(180.0),
                "blues" => Some(240.0),
                "magentas" => Some(300.0),
                _ => None,
            };
            if let Some(h) = hue {
                return Some(ColorRangeParams::hue(h, invert));
            }
            let (lo, hi, fz) = match name {
                "highlights" => (190.0, 255.0, 20.0),
                "midtones" => (105.0, 150.0, 40.0),
                "shadows" => (0.0, 65.0, 20.0),
                "skin" => return Some(ColorRangeParams::skin(40.0, invert)),
                _ => return None,
            };
            Some(ColorRangeParams::tonal(
                f("lower").unwrap_or(lo),
                f("upper").unwrap_or(hi),
                f("fuzziness").unwrap_or(fz) / 100.0,
                name == "midtones",
                invert,
            ))
        }
        _ => None,
    }
}

fn ours(c: &Json, w: usize, stim: &[[f32; 3]]) -> Vec<f32> {
    if let Some(p) = params(c) {
        return stim
            .iter()
            .enumerate()
            .map(|(i, &rgb)| {
                let pos = [(i % w) as f32 + 0.5, (i / w) as f32 + 0.5];
                // Photoshop's selection is 8-bit.
                (color_range_px(rgb, pos, &p) * 255.0).round() / 255.0
            })
            .collect();
    }
    // Grow / Similar from the recorded rectangle, at 8 bits.
    let p = c.get("params").expect("params");
    let r: Vec<u32> = p
        .get("rect")
        .and_then(Json::as_array)
        .expect("rect")
        .iter()
        .map(|v| v.as_u64().expect("int") as u32)
        .collect();
    let h = stim.len() / w;
    let rgba: Vec<u8> = stim
        .iter()
        .flat_map(|c| {
            [
                (c[0] * 255.0).round() as u8,
                (c[1] * 255.0).round() as u8,
                (c[2] * 255.0).round() as u8,
                255,
            ]
        })
        .collect();
    let rect = SelectionCoverage::rasterize_rect(
        w as u32,
        h as u32,
        r[0] as f32,
        r[1] as f32,
        (r[2] - r[0]) as f32,
        (r[3] - r[1]) as f32,
    );
    let tol = p
        .get("tolerance")
        .and_then(Json::as_u64)
        .expect("tolerance") as u8;
    let contiguous = p.get("op").and_then(Json::as_str) == Some("grow");
    let g = image_js::selection::grow_coverage(&rect, &rgba, tol, contiguous).expect("grown");
    g.data().iter().map(|&v| f32::from(v) / 255.0).collect()
}

#[test]
#[allow(non_snake_case)]
fn every_selection_case_holds_its_ledger_row__feat__image_selection_select_and_mask() {
    let text = std::fs::read_to_string(dir().join("selection.photoshop.json")).expect("fixture");
    let fixture = Json::parse(&text).expect("json");
    let (w, _h, stim) = read("stimuli/colour-sweep.png");
    let mut problems = Vec::new();
    let mut seen = 0;
    for c in fixture
        .get("cases")
        .and_then(Json::as_array)
        .expect("cases")
    {
        let id = c.get("id").and_then(Json::as_str).expect("id");
        if id == "identity" {
            // The proof no colour conversion happened on the way in.
            let (_, _, out) = read(c.get("output").and_then(Json::as_str).expect("output"));
            let d = out
                .iter()
                .zip(&stim)
                .map(|(a, b)| (0..3).map(|k| (a[k] - b[k]).abs()).fold(0.0, f32::max))
                .fold(0.0, f32::max);
            assert!(d < 1e-4, "identity differs by {d}");
            continue;
        }
        seen += 1;
        let Some((_, class)) = LEDGER.iter().find(|(k, _)| *k == id) else {
            problems.push(format!("{id}: not in the ledger"));
            continue;
        };
        let (_, _, theirs) = read(c.get("output").and_then(Json::as_str).expect("output"));
        let mine = ours(c, w, &stim);
        let diffs: Vec<f32> = mine
            .iter()
            .zip(&theirs)
            .map(|(a, b)| (a - b[0]).abs())
            .collect();
        let max = diffs.iter().copied().fold(0.0, f32::max);
        let mean = diffs.iter().sum::<f32>() / diffs.len() as f32;
        eprintln!("{id}: max {max:.4} mean {mean:.5}");
        let (bmax, bmean) = match class {
            Class::Agreement(a, b) => (*a, *b),
            Class::Convention(a, b, why) => {
                eprintln!("  convention: {why}");
                (*a, *b)
            }
        };
        if max > bmax + 1e-4 || mean > bmean + 1e-6 {
            problems.push(format!(
                "{id}: max {max:.4} / mean {mean:.5} exceeds the ledger's {bmax} / {bmean}"
            ));
        }
    }
    assert_eq!(seen, LEDGER.len(), "every ledger row was recorded");
    assert!(problems.is_empty(), "\n{}", problems.join("\n"));
}

/// The kernel on a real adapter against its twin, on the stimulus
/// (premultiplied f16 like every tile input; the stimulus is opaque).
#[test]
#[allow(non_snake_case)]
fn gpu_kernel_agrees_with_its_twin__feat__image_selection_select_and_mask() {
    let Some(ctx) = image_gpu::test_support::device_or_skip("select.color_range parity") else {
        return;
    };
    let (w, h, stim) = read("stimuli/colour-sweep.png");
    let mut f16 = Vec::with_capacity(w * h * 8);
    for c in &stim {
        for v in [c[0], c[1], c[2], 1.0] {
            f16.extend_from_slice(&half::f16::from_f32(v).to_le_bytes());
        }
    }
    let cases = [
        ColorRangeParams::sampled_box([54.29, 80.8, 69.89], [54.29, 80.8, 69.89], 100.0, false),
        ColorRangeParams::sampled(
            &[
                ([60.0, -50.0, 40.0], [20.0, 30.0]),
                ([50.0, 0.0, 0.0], [90.0, 120.0]),
            ],
            60.0,
            false,
            Some(40.0),
        ),
        ColorRangeParams::hue(120.0, true),
        ColorRangeParams::tonal(105.0, 150.0, 0.4, true, false),
        ColorRangeParams::skin(40.0, false),
    ];
    for p in &cases {
        let out = image_gpu::execute_tile_once(
            ctx,
            &SELECT_COLOR_RANGE,
            &[image_gpu::TileInput { f16_bytes: &f16 }],
            p.as_bytes(),
            None,
            w as u32,
            h as u32,
        )
        .expect("dispatch");
        let mut worst = 0.0f32;
        for (i, t) in out.as_chunks::<8>().0.iter().enumerate() {
            let g = half::f16::from_le_bytes([t[0], t[1]]).to_f32();
            // The twin sees what the GPU saw: the f16-rounded stimulus.
            let s = stim[i].map(|v| half::f16::from_f32(v).to_f32());
            let pos = [(i % w) as f32 + 0.5, (i / w) as f32 + 0.5];
            worst = worst.max((g - color_range_px(s, pos, p)).abs());
        }
        // Within two 8-bit levels: the selection is stored at 8 bits.
        assert!(worst <= 2.0 / 255.0, "mode {:?}: worst {worst}", p.cfg);
    }
}
