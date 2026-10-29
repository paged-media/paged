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

//! Image ▸ Mode against Photoshop (image ADR 479), replayed from
//! `fixtures/photoshop/mode-conversions` (`scripts/photoshop/probes/
//! mode-conversions.jsx`).
//!
//! * MODES — the `colour-sweep` stimulus converted to CMYK (Coated
//!   FOGRA39, the profile read from the PSD Photoshop wrote), Gray Gamma
//!   2.2 and Lab and back to sRGB, at 16 and at 8 bits per channel:
//!   [`image_js::color_mode::ModeTransform`] on the same stimulus against
//!   Photoshop's sRGB result, in 8-bit levels. [`MODES`] holds the stated
//!   tolerances and the distances measured when they were set.
//! * DEPTH — a Levels gamma of 2.2 on the `deep-ramp` stimulus (16384
//!   levels): the shipping 16-bit chain (`ingest::adjust_px`) against
//!   Photoshop's 16-bit result, and the number of distinct levels each
//!   keeps, against Photoshop's 8-bit result (at most 256).

#![allow(non_snake_case)]

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;

use image_core::SampleDepth;
use image_js::color_mode::{ColorMode, DocMode, ModeTransform};
use image_js::pixels::Pixels;
use zune_core::bytestream::ZCursor;
use zune_core::result::DecodingResult;
use zune_png::PngDecoder;

fn dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures/photoshop")
}

/// A 16-bit PNG's RGB samples.
fn png16(rel: &str) -> (usize, usize, Vec<[u16; 3]>) {
    let path = dir().join(rel);
    let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    let mut dec = PngDecoder::new(ZCursor::new(&bytes));
    let res = dec.decode().expect("decode");
    let (w, h) = dec.dimensions().expect("dimensions");
    let ch = dec.colorspace().expect("colorspace").num_components();
    let DecodingResult::U16(v) = res else {
        panic!("{rel}: not 16-bit");
    };
    (
        w,
        h,
        v.chunks_exact(ch).map(|p| [p[0], p[1], p[2]]).collect(),
    )
}

/// The stimulus as layer pixels at `depth` (opaque).
fn pixels_of(px: &[[u16; 3]], depth: SampleDepth) -> Pixels {
    let s: Vec<u16> = px
        .iter()
        .flat_map(|p| [p[0], p[1], p[2], u16::MAX])
        .collect();
    Pixels::from_rgba16(&s).at_depth(depth)
}

/// Max, 99th percentile and mean of a list.
fn stats(mut d: Vec<f64>) -> (f64, f64, f64) {
    d.sort_by(f64::total_cmp);
    let max = *d.last().unwrap();
    let p99 = d[(d.len() * 99) / 100];
    let mean = d.iter().sum::<f64>() / d.len() as f64;
    (max, p99, mean)
}

/// Distance in 8-bit levels, per channel.
fn dist(ours: &Pixels, theirs: &[[u16; 3]]) -> (f64, f64, f64) {
    let mut d: Vec<f64> = Vec::with_capacity(theirs.len() * 3);
    for (i, t) in theirs.iter().enumerate() {
        for (c, &tv) in t.iter().enumerate() {
            d.push((f64::from(ours.sample16(i, c)) - f64::from(tv)).abs() / 257.0);
        }
    }
    stats(d)
}

/// ΔE*ab (1976, D50) per pixel between our sRGB and Photoshop's.
fn delta_e(ours: &Pixels, theirs: &[[u16; 3]]) -> (f64, f64, f64) {
    let lab =
        |rgb: [u16; 3]| paged_color::lab::srgb_to_lab_d50(rgb.map(|v| f32::from(v) / 65535.0));
    let d = theirs
        .iter()
        .enumerate()
        .map(|(i, t)| {
            let o = [
                ours.sample16(i, 0),
                ours.sample16(i, 1),
                ours.sample16(i, 2),
            ];
            f64::from(paged_color::cms::delta_e76(lab(o), lab(*t)))
        })
        .collect();
    stats(d)
}

/// The ICC profile Photoshop embedded in a recorded PSD.
fn profile_of(rel: &str) -> Arc<[u8]> {
    let bytes = std::fs::read(dir().join(rel)).expect("psd");
    let file = image_psd::PsdFile::parse(&bytes).expect("parse");
    Arc::from(
        file.resources
            .icc_profile()
            .expect("an embedded profile")
            .to_vec(),
    )
}

/// One mode case and its stated tolerances: ΔE*ab p99 and max, and the
/// 99th percentile in 8-bit levels.
struct ModeCase {
    id: &'static str,
    mode: ColorMode,
    depth: SampleDepth,
    de_p99: f64,
    de_max: f64,
    levels_p99: f64,
}

/// Measured on lcms2 when set (levels max / p99 / mean; ΔE max / p99 /
/// mean): cmyk-16 18.45 / 6.13 / 0.77, 1.90 / 1.31 / 0.57; cmyk-8 21.0 /
/// 6.0 / 0.83, 2.60 / 1.64 / 0.69; gray-16 0.04 / 0.02 / 0.01, 0.01 /
/// 0.01 / 0.00; gray-8 2.0 / 2.0 / 0.23, 1.00 / 0.74 / 0.09; lab-16 0.22 /
/// 0.05 / 0.01, 0.02 / 0.01 / 0.01; lab-8 35.0 / 9.0 / 1.00, 2.65 / 1.78 /
/// 0.65.
///
/// Grey and 16-bit Lab agree to the last level. CMYK differs where the
/// stimulus is outside the press gamut (saturated sRGB cyans and yellows):
/// both CMMs clip through the profile's own table, Photoshop's ACE and
/// lcms2 land up to 21 levels apart in one channel there, under 2 ΔE. An
/// 8-bit Lab round trip is lossy in both applications and ill-conditioned
/// for sRGB cyans (the red channel carries almost no lightness), so the
/// two land up to 35 levels apart in that channel, 2.65 ΔE at most.
const MODES: &[ModeCase] = &[
    ModeCase {
        id: "cmyk-16",
        mode: ColorMode::Cmyk,
        depth: SampleDepth::U16,
        de_p99: 1.6,
        de_max: 2.4,
        levels_p99: 7.0,
    },
    ModeCase {
        id: "cmyk-8",
        mode: ColorMode::Cmyk,
        depth: SampleDepth::U8,
        de_p99: 2.0,
        de_max: 3.2,
        levels_p99: 7.0,
    },
    ModeCase {
        id: "gray-16",
        mode: ColorMode::Gray,
        depth: SampleDepth::U16,
        de_p99: 0.1,
        de_max: 0.1,
        levels_p99: 0.5,
    },
    ModeCase {
        id: "gray-8",
        mode: ColorMode::Gray,
        depth: SampleDepth::U8,
        de_p99: 1.0,
        de_max: 1.2,
        levels_p99: 2.0,
    },
    ModeCase {
        id: "lab-16",
        mode: ColorMode::Lab,
        depth: SampleDepth::U16,
        de_p99: 0.1,
        de_max: 0.1,
        levels_p99: 0.5,
    },
    ModeCase {
        id: "lab-8",
        mode: ColorMode::Lab,
        depth: SampleDepth::U8,
        de_p99: 2.2,
        de_max: 3.2,
        levels_p99: 10.0,
    },
];

#[test]
fn the_stimulus_was_not_converted_on_open__feat__image_io_depth_color_modes() {
    let (_, _, stim) = png16("stimuli/colour-sweep.png");
    let (_, _, ident) = png16("mode-conversions/identity.png");
    // Photoshop holds 16 bits as 0..=32768: a round trip moves a sample
    // by a unit or two of 65535, never more.
    let worst = stim
        .iter()
        .zip(&ident)
        .flat_map(|(a, b)| (0..3).map(move |c| a[c].abs_diff(b[c])))
        .max()
        .unwrap();
    assert!(
        worst <= 2,
        "the untagged stimulus was converted on open ({worst} units)"
    );
}

#[test]
fn image_mode_conversions_agree_with_photoshop__feat__image_io_depth_color_modes() {
    let (w, _, stim) = png16("stimuli/colour-sweep.png");
    let mut report = Vec::new();
    let mut failed = false;
    for case in MODES {
        let cmyk_profile = (case.mode == ColorMode::Cmyk)
            .then(|| profile_of(&format!("mode-conversions/{}.cmyk.psd", case.id)));
        let t = ModeTransform::new(&DocMode {
            mode: case.mode,
            cmyk_profile,
        })
        .expect("transform")
        .expect("the mode projects");
        let ours = t.project_pixels(&pixels_of(&stim, case.depth), w as u32, None);
        let (_, _, theirs) = png16(&format!("mode-conversions/{}.png", case.id));
        let (lmax, lp99, lmean) = dist(&ours, &theirs);
        let (dmax, dp99, dmean) = delta_e(&ours, &theirs);
        let ok = dp99 <= case.de_p99 && dmax <= case.de_max && lp99 <= case.levels_p99;
        failed |= !ok;
        report.push(format!(
            "{}{}: levels max {lmax:.2} p99 {lp99:.2} mean {lmean:.3}; dE max {dmax:.2} p99 {dp99:.2} mean {dmean:.3} (stated dE p99 {} max {}, levels p99 {})",
            if ok { "" } else { "OVER " },
            case.id,
            case.de_p99,
            case.de_max,
            case.levels_p99
        ));
    }
    eprintln!("{}", report.join("\n"));
    assert!(!failed, "{}", report.join("\n"));
}

/// Distinct values of channel 0.
fn levels(px: &[[u16; 3]]) -> usize {
    px.iter().map(|p| p[0]).collect::<HashSet<_>>().len()
}

#[test]
fn a_16bit_levels_keeps_the_levels_photoshop_keeps__feat__image_io_depth_color_modes() {
    let Some(ctx) = image_gpu::test_support::device_or_skip("16-bit levels replay") else {
        return;
    };
    let (w, h, ramp) = png16("stimuli/deep-ramp.png");
    let img = image_js::ingest::DecodedImage {
        width: w as u32,
        height: h as u32,
        rgba: pixels_of(&ramp, SampleDepth::U16),
        display: image_js::display::DisplayTreatment::AssumedSrgb,
        depth_reduced: false,
    };
    let params = image_js::ingest::AdjustParams {
        levels: image_js::ingest::LevelsParams {
            in_black: 0.0,
            in_white: 1.0,
            gamma: 2.2,
            out_black: 0.0,
            out_white: 1.0,
        },
        ..Default::default()
    };
    let ours =
        pollster::block_on(image_js::ingest::adjust_px(ctx, &img, &params, None)).expect("adjust");
    let ours_rgb: Vec<[u16; 3]> = (0..ours.pixel_count())
        .map(|i| {
            [
                ours.sample16(i, 0),
                ours.sample16(i, 1),
                ours.sample16(i, 2),
            ]
        })
        .collect();
    let (_, _, ps16) = png16("mode-conversions/ramp-levels-16.png");
    let (_, _, ps8) = png16("mode-conversions/ramp-levels-8.png");
    // Above 15 % input Photoshop's Levels gamma is the plain power curve
    // the kernel draws; below it Photoshop bends the shadows down (at
    // 0.24 % input it answers 732 where x^(1/2.2) is 4256; its 8-bit
    // result shows the same bend). That toe is a recorded defect of
    // `adjust.levels` (both depths), not of the depth: it is held, not
    // asserted away.
    let split = |pred: &dyn Fn(u16) -> bool| -> (f64, f64, f64) {
        let d: Vec<f64> = ps16
            .iter()
            .enumerate()
            .filter(|(i, _)| pred(ramp[*i][0]))
            .map(|(i, t)| (f64::from(ours.sample16(i, 0)) - f64::from(t[0])).abs() / 257.0)
            .collect();
        stats(d)
    };
    let (max, p99, mean) = split(&|v| v >= 9830);
    let (toe_max, _, _) = split(&|v| v < 9830);
    let ours_levels = levels(&ours_rgb);
    let report = format!(
        "above 15%: max {max:.3} p99 {p99:.3} mean {mean:.4} levels; toe max {toe_max:.2}; \
         distinct levels ours {ours_levels}, Photoshop 16-bit {}, Photoshop 8-bit {}",
        levels(&ps16),
        levels(&ps8)
    );
    eprintln!("{report}");
    assert!(max <= 1.0, "{report}");
    assert!(toe_max <= 21.5, "the toe grew: {report}");
    // f16 working tiles keep about 11 bits in the highlights: far more
    // levels than an 8-bit document (Photoshop's own 8-bit result keeps
    // 184 of 16384), far fewer than Photoshop's 15-bit store.
    assert!(ours_levels >= 10 * levels(&ps8), "{report}");
}

/// Photoshop's 16-bit layered document (`psd-containers/sixteen-bit.psd`)
/// opens its layers at 16 bits, and the layered save writes an edited
/// layer's 16-bit samples back without narrowing them.
#[test]
fn a_16bit_psd_opens_and_saves_its_layers_at_16_bits__feat__image_io_depth_color_modes() {
    use image_js::layers::LayerStack;
    use image_psd::PsdFile;
    let bytes = std::fs::read(dir().join("psd-containers/sixteen-bit.psd")).expect("fixture");
    let file = PsdFile::parse(&bytes).expect("parse");
    assert_eq!(file.header.depth, 16);
    let import = file.layer_plates_rgba8().expect("layers");
    assert!(
        !import.depth_reduced,
        "every layer came with its 16-bit samples"
    );
    let deep = import.layers.iter().filter(|p| p.rgba16.is_some()).count();
    assert!(deep > 0, "the plates carry 16-bit samples");
    for p in &import.layers {
        if let Some(d) = &p.rgba16 {
            // The 8-bit view is the samples' high bytes.
            let hi: Vec<u8> = d.iter().map(|s| (s >> 8) as u8).collect();
            assert_eq!(hi, p.rgba, "layer {:?}", p.name);
        }
    }
    let mut stack =
        LayerStack::from_psd_plates_with(&import, Some(&file.layer_mask.layers)).expect("stack");
    assert_eq!(stack.depth(), SampleDepth::U16);
    // A 16-bit edit with low bytes an 8-bit store would drop.
    let (w, h) = (stack.width(), stack.height());
    // The pixel layer "square" (the file's top layer is a Curves layer).
    let square = stack
        .layers()
        .iter()
        .position(|l| l.name == "square")
        .expect("square");
    stack.set_active(square).expect("active");
    let s: Vec<u16> = (0..w * h)
        .flat_map(|_| [0x1234u16, 0x5678, 0x9ABC, 0xFFFF])
        .collect();
    stack
        .edit_active(
            "paint",
            image_core::Region::new(0, 0, w, h),
            Pixels::from_rgba16(&s),
        )
        .expect("edit");
    let mut out = file.clone();
    let n = w as usize * h as usize;
    image_js::psd_write::psd_write_stack(&mut out, &stack, &vec![128u8; n * 4]).expect("save");
    let back = PsdFile::parse(&out.write().expect("bytes")).expect("reparse");
    let again = back.layer_plates_rgba8().expect("layers");
    assert!(!again.depth_reduced);
    let edited = again
        .layers
        .iter()
        .find(|p| p.name == "square")
        .and_then(|p| p.rgba16.as_ref())
        .expect("16-bit");
    assert_eq!(
        &edited[..4],
        &[0x1234, 0x5678, 0x9ABC, 0xFFFF],
        "the samples survived the save"
    );
}
