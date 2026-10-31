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

//! The Photoshop oracle of WP9.4 (ADR 1038), replayed: Photoshop 27.10
//! opened the files `paged-raster` writes and reads
//! (`modules/image/scripts/photoshop/probes/codecs-open.jsx`, recorded
//! into `tests/fixtures/photoshop/`).
//!
//! - Each recorded input is regenerated (`oracle_files`) and must be the
//!   same bytes, so the recording speaks about what this crate writes.
//! - The layered TIFF: Photoshop read the PSD's three layers back (names,
//!   opacity, blend, bounds), composited them as the blend modes say, and
//!   each layer shown alone is the layer data the TIFF's tag 37724
//!   carries.
//! - OpenEXR: the 32-bit float TIFF Photoshop saved holds the floats this
//!   crate decodes, alpha associated in both. Radiance HDR: Photoshop
//!   reads each mantissa at the middle of its step, a recorded convention.

use std::path::{Path, PathBuf};

use paged_raster::{decode, Alpha, DecodeOptions, RasterImage, Samples};
use serde_json::Value;

use crate::oracle_files::{oracle_files, LAYERED_PSD};

fn dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/photoshop")
}

fn recording() -> Value {
    let text = std::fs::read_to_string(dir().join("codecs-open.photoshop.json")).unwrap();
    serde_json::from_str(&text).unwrap()
}

fn case<'a>(rec: &'a Value, id: &str) -> &'a Value {
    rec["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["id"] == id)
        .unwrap_or_else(|| panic!("no case {id}"))
}

fn recorded(rel: &str) -> Vec<u8> {
    std::fs::read(dir().join(rel)).unwrap()
}

fn num(v: &Value) -> f64 {
    v.as_f64().unwrap()
}

#[test]
fn the_recorded_inputs_are_what_this_crate_writes__feat__images_graphics_codecs_long_tail() {
    for (name, bytes) in oracle_files() {
        assert!(
            recorded(&format!("codecs-open/{name}")) == bytes,
            "{name} differs from the recorded copy: re-record the oracle"
        );
    }
}

fn near(ps: &[Value], ours: [u8; 3]) -> bool {
    ps.iter()
        .zip(ours)
        .all(|(p, o)| (num(p).round() - f64::from(o)).abs() <= 1.0)
}

#[test]
fn photoshop_reopens_the_layered_tiff_with_its_layers__feat__images_graphics_codecs_long_tail() {
    let rec = recording();
    let c = case(&rec, "layered-tiff");
    let v = &c["values"];
    let tiff = recorded("codecs-open/layered.tif");
    let psd = paged_psd::PsdFile::parse(LAYERED_PSD).unwrap();

    // The layers: Photoshop lists them top first, PSD stores bottom first.
    let records = &psd.layer_mask.layers;
    let ps_layers = v["layers"].as_array().unwrap();
    assert_eq!(ps_layers.len(), records.len());
    let blend = |k: &[u8; 4]| match k {
        b"norm" => "NORMAL",
        b"mul " => "MULTIPLY",
        b"scrn" => "SCREEN",
        other => panic!("{other:?}"),
    };
    for (ps, r) in ps_layers.iter().zip(records.iter().rev()) {
        assert_eq!(ps["name"], r.name_legacy.text_lossy());
        assert_eq!((num(&ps["opacity"]) * 2.55).round() as u8, r.opacity);
        assert_eq!(ps["blend"], blend(&r.blend_key));
        assert_eq!(ps["visible"], true);
        let b: Vec<i32> = ps["bounds"]
            .as_array()
            .unwrap()
            .iter()
            .map(|n| num(n) as i32)
            .collect();
        assert_eq!(b, [r.left, r.top, r.right, r.bottom]);
    }

    // The layers Photoshop read are the ones tag 37724 carries.
    let data = crate::encode_tail::image_source_data_of(&tiff);
    let mut from_tiff = psd.clone();
    from_tiff.layer_mask.layers = paged_psd::image_source_data_layers(&data).unwrap().layers;
    from_tiff.layer_mask.section_raw = None;
    let plates = from_tiff.layer_plates_rgba8().unwrap();
    let at = |plate: &paged_psd::LayerPlate, x: i32, y: i32| -> Option<[f64; 4]> {
        let (ox, oy, w, h) = plate.rect.map_or((0, 0, plates.width, plates.height), |r| {
            (r.x, r.y, r.w, r.h)
        });
        let (lx, ly) = (x - ox, y - oy);
        if lx < 0 || ly < 0 || lx as u32 >= w || ly as u32 >= h {
            return None;
        }
        let i = ((ly as u32 * w + lx as u32) * 4) as usize;
        Some([0, 1, 2, 3].map(|c| f64::from(plate.rgba[i + c])))
    };

    // Photoshop composites the layers it read: the stored composite of
    // this synthetic file is its backdrop alone, so the samples are held
    // to the layers blended (Normal, Multiply, Screen at their opacity)
    // over the opaque backdrop.
    for s in v["composite"].as_array().unwrap() {
        let s = s.as_array().unwrap();
        let (x, y) = (num(&s[0]) as i32, num(&s[1]) as i32);
        let mut cb = [0.0f64; 3];
        for plate in &plates.layers {
            let Some(px) = at(plate, x, y) else { continue };
            let alpha = px[3] / 255.0 * f64::from(plate.opacity) / 255.0;
            for c in 0..3 {
                let (b, src) = (cb[c], px[c]);
                let blended = match &plate.blend_key {
                    b"mul " => b * src / 255.0,
                    b"scrn" => b + src - b * src / 255.0,
                    _ => src,
                };
                cb[c] = b + (blended - b) * alpha;
            }
        }
        let ours = cb.map(|v| v.round().clamp(0.0, 255.0) as u8);
        assert!(
            near(&s[2..5], ours),
            "composite at ({x},{y}): {s:?} vs {ours:?}"
        );
    }

    // Each layer alone, opaque and Normal, is its layer data.
    for s in v["alone"].as_array().unwrap() {
        let s = s.as_array().unwrap();
        let name = s[0].as_str().unwrap();
        let (x, y) = (num(&s[1]) as i32, num(&s[2]) as i32);
        let plate = plates.layers.iter().find(|p| p.name == name).unwrap();
        let px = at(plate, x, y).unwrap();
        let ours = [px[0], px[1], px[2]].map(|v| v as u8);
        assert_eq!(px[3], 255.0, "{name} is opaque there");
        assert!(
            near(&s[3..6], ours),
            "{name} at ({x},{y}): {s:?} vs {ours:?}"
        );
    }
}

#[test]
fn photoshop_reads_the_floats_of_openexr_as_this_crate_does__feat__images_graphics_codecs_long_tail(
) {
    if !cfg!(feature = "exr") {
        return;
    }
    let rec = recording();
    for (id, source) in [
        ("openexr", "scene.exr"),
        ("openexr-alpha", "scene-alpha.exr"),
    ] {
        let c = case(&rec, id);
        assert_eq!(c["values"]["bits"], 32, "{id}");
        let (ours, theirs) = floats(id, source);
        assert_eq!(
            (ours.alpha != Alpha::None),
            c["values"]["transparent"] == true,
            "{id}: Photoshop opens the alpha as transparency"
        );
        // Both read OpenEXR's colour as premultiplied (Photoshop's TIFF
        // says ExtraSamples 1, associated).
        assert_eq!(ours.alpha, theirs.alpha, "{id}");
        let (a, b) = (samples(&ours), samples(&theirs));
        let (ca, cb) = (ours.channels(), theirs.channels());
        assert_eq!(ca, cb, "{id}");
        for (pa, pb) in a.chunks_exact(ca).zip(b.chunks_exact(cb)) {
            // Photoshop holds the colour straight internally: dividing out
            // and multiplying by the alpha again costs the last float bit.
            for c in 0..3 {
                assert!(
                    (pa[c] - pb[c]).abs() <= pa[c].abs() * 1e-6,
                    "{id}: the colour floats are the file's: {pa:?} {pb:?}"
                );
            }
            if ca == 4 {
                // Photoshop keeps a 32-bit document's transparency at 16
                // bits and never at 0: an alpha of 0 comes back 1/65536.
                assert!(
                    (pa[3] - pb[3]).abs() <= 1.0 / 65536.0 + 1e-7,
                    "{id}: {pa:?} {pb:?}"
                );
            }
        }
    }
}

/// Radiance RGBE stores a shared exponent and an 8-bit mantissa per
/// channel. Photoshop reads a non-zero mantissa at the middle of its
/// step, `(m + 0.5) * 2^(e - 136)`, as Radiance's own reader does;
/// `image`'s decoder (this crate's) reads `m * 2^(e - 136)`, the value a
/// truncating encoder started from. A zero mantissa is 0 in both. A
/// recorded CONVENTION, held exactly: Photoshop's value is ours plus half
/// the step of the pixel's exponent.
#[test]
fn photoshop_reads_radiance_hdr_at_the_middle_of_each_mantissa_step__feat__images_graphics_codecs_long_tail(
) {
    let rec = recording();
    let c = case(&rec, "radiance-hdr");
    assert_eq!(c["values"]["bits"], 32);
    let (ours, theirs) = floats("radiance-hdr", "scene.hdr");
    let (a, b) = (samples(&ours), samples(&theirs));
    for (pa, pb) in a
        .as_chunks::<3>()
        .0
        .iter()
        .zip(b.chunks_exact(theirs.channels()))
    {
        let max = pa.iter().cloned().fold(0.0f32, f32::max);
        if max == 0.0 {
            assert_eq!(&pb[..3], &[0.0; 3]);
            continue;
        }
        // The exponent puts the largest mantissa in 128..=255.
        let step = 2f32.powi(max.log2().floor() as i32 - 7);
        for i in 0..3 {
            let want = if pa[i] == 0.0 {
                0.0
            } else {
                pa[i] + step / 2.0
            };
            assert!(
                (pb[i] - want).abs() <= want.abs() * 1e-6,
                "{pa:?}: Photoshop {pb:?}, expected {want} for channel {i}"
            );
        }
    }
}

/// This crate's decode of the source, and Photoshop's 32-bit float TIFF
/// of it.
fn floats(id: &str, source: &str) -> (RasterImage, RasterImage) {
    let ours = decode(
        &recorded(&format!("codecs-open/{source}")),
        DecodeOptions::default(),
    )
    .unwrap();
    let theirs = decode(
        &recorded(&format!("codecs-open/{id}.photoshop.tif")),
        DecodeOptions::default(),
    )
    .unwrap();
    assert_eq!(
        (theirs.width, theirs.height),
        (ours.width, ours.height),
        "{id}"
    );
    (ours, theirs)
}

fn samples(img: &RasterImage) -> &[f32] {
    match &img.data {
        Samples::F32(v) => v,
        other => panic!("not float: {} samples", other.len()),
    }
}
