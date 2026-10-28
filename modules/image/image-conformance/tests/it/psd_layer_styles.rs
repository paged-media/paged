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

//! PHOTOSHOP-WRITTEN LAYER STYLES, replayed in CI.
//! `scripts/photoshop/probes/layer-styles.jsx` had Photoshop 27.10 draw one
//! small document per style and key parameter (every effect but the
//! pattern-based ones, plus the blending options that change how a style
//! composites) and save each as a PSD with REAL merged data.
//!
//! For each PSD the style goes through the shipping import (`lfx2`/`lmfx`
//! → `paged_psd::effects::LayerStyle`) and the GPU fold (`layers::styles`);
//! the result is compared with Photoshop's merged composite. [`EXPECT`]
//! holds each case's measured distance (8-bit levels: the largest, and the
//! mean over the canvas): an improvement passes, a regression fails.
//! Each row is classified honestly — AGREE where Photoshop's arithmetic is
//! matched, CONVENTION where the shape is Photoshop's but its exact
//! falloff is approximated (its blur, its bevel shading), with the
//! measured error recorded rather than hidden.
//!
//! `PAGED_STYLE_DUMP=<dir>` writes each render (`<id>.rgba`, raw RGBA8)
//! for a side-by-side look while calibrating.

use std::path::PathBuf;

use image_conformance::psd_corpus::{compare_rgba8, merged_data, MergedData, Reference};
use image_js::layers::LayerStack;
use image_psd::effects::{BevelStyle, GlowSource, LayerStyle, StrokePosition};
use image_psd::PsdFile;

fn dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures/photoshop/layer-styles")
}

/// (case, max levels, mean levels ×100) — at most that far from
/// Photoshop's merged composite. Measured 2026-10-25 against Photoshop
/// 27.10 (two levels and 0.15 mean of slack over the measurement).
const EXPECT: &[(&str, u8, u32)] = &[
    // CONVENTION: the sum of the bevel and stroke conventions
    ("bo-everything", 82, 115),
    // AGREE
    ("bo-fill0-inner-shadow", 5, 32),
    // AGREE
    ("bo-fill50-overlay", 3, 15),
    // AGREE
    ("bo-fill50-overlay-interior", 3, 16),
    // AGREE
    ("bo-mask-hides-shadow", 3, 16),
    // AGREE
    ("bo-mask-shapes-shadow", 3, 16),
    // CONVENTION: a size-2 blur is slightly wider than Photoshop's
    ("bo-two-shadows", 31, 121),
    // CONVENTION: bevel shading — face slopes match, edge and corner texels differ
    ("bv-altitude-60", 28, 66),
    // CONVENTION: bevel shading — face slopes match, edge and corner texels differ
    ("bv-angle-30-colours", 24, 75),
    // AGREE on the faces; the creases and edge texels (central differences) up to the max
    ("bv-chisel-hard", 56, 67),
    // CONVENTION: Chisel Soft's softening (a 1 px blur here) differs at the corners
    ("bv-chisel-soft", 111, 141),
    // CONVENTION: Photoshop's contour sub-pane shapes the profile; ours approximates where the range lands
    ("bv-contour-cone", 157, 281),
    // CONVENTION: bevel shading — face slopes match, edge and corner texels differ
    ("bv-depth-300", 17, 41),
    // CONVENTION: bevel shading — face slopes match, edge and corner texels differ
    ("bv-down", 18, 63),
    // CONVENTION: bevel shading — face slopes match, edge and corner texels differ
    ("bv-emboss", 29, 93),
    // CONVENTION: bevel shading — face slopes match, edge and corner texels differ
    ("bv-gloss-cone", 46, 116),
    // CONVENTION: bevel shading — face slopes match, edge and corner texels differ
    ("bv-inner-smooth", 43, 59),
    // CONVENTION: bevel shading — face slopes match, edge and corner texels differ
    ("bv-inner-smooth-10", 17, 63),
    // CONVENTION: bevel shading — face slopes match, edge and corner texels differ
    ("bv-outer", 23, 90),
    // CONVENTION: corner texels of the trough
    ("bv-pillow", 191, 348),
    // CONVENTION: corner creases
    ("bv-soften", 64, 122),
    // CONVENTION: the stroke's own bevel, approximated as an inner bevel of the stroked shape
    ("bv-stroke-emboss", 99, 260),
    // AGREE
    ("co-fill0", 3, 15),
    // AGREE
    ("ds-basic", 3, 18),
    // AGREE
    ("ds-contour-cone", 4, 37),
    // AGREE
    ("ds-fill0-knocks", 8, 46),
    // AGREE
    ("ds-fill0-shows", 8, 72),
    // AGREE
    ("ds-global-light", 3, 16),
    // AGREE
    ("ds-hard", 2, 15),
    // AGREE
    ("ds-layer-opacity-50", 5, 29),
    // CONVENTION: noise is a hashed stream, not Photoshop's; the density matches, the pixels cannot
    ("ds-noise", 145, 511),
    // AGREE
    ("ds-screen-blue", 7, 32),
    // AGREE
    ("ds-size10", 3, 25),
    // AGREE
    ("ds-size20", 3, 24),
    // AGREE but for the dilation's corner texels
    ("ds-spread100", 72, 58),
    // AGREE
    ("ds-spread50", 6, 28),
    // AGREE but for the seam column itself
    ("go-angle", 255, 50),
    // AGREE
    ("go-diamond", 3, 16),
    // AGREE
    ("go-linear", 3, 17),
    // AGREE
    ("go-multiply-60", 3, 20),
    // AGREE
    ("go-not-aligned", 3, 18),
    // AGREE
    ("go-radial", 3, 17),
    // AGREE
    ("go-reflected", 3, 17),
    // AGREE
    ("go-reverse-offset", 3, 16),
    // CONVENTION: at 30° with scale 50 Photoshop's lines run at ~27° (fitted); ours at 30°
    ("go-scale50-angle30", 28, 190),
    // AGREE
    ("go-transparency", 3, 20),
    // AGREE
    ("ig-center-black", 5, 34),
    // AGREE
    ("ig-edge", 4, 31),
    // AGREE
    ("ig-edge-black", 5, 35),
    // AGREE
    ("ig-precise-choke", 7, 37),
    // AGREE
    ("is-basic", 3, 17),
    // AGREE
    ("is-choke50", 3, 15),
    // AGREE
    ("is-hard", 2, 15),
    // CONVENTION: bevel shading — face slopes match, edge and corner texels differ
    ("og-gradient", 11, 56),
    // AGREE
    ("og-precise-black", 9, 40),
    // AGREE
    ("og-range25", 5, 51),
    // AGREE
    ("og-softer", 3, 22),
    // AGREE
    ("og-softer-black", 4, 42),
    // AGREE
    ("og-spread50", 9, 83),
    // AGREE
    ("sa-invert", 4, 22),
    // CONVENTION: the corners where satin's two copies cross a cone contour
    ("sa-normal-cone", 192, 160),
    // AGREE
    ("sa-plain", 3, 20),
    // CONVENTION: a curve's stroke edges (jump-flood distance, not exact geometry)
    ("st-center", 67, 83),
    // CONVENTION: as st-center
    ("st-gradient", 67, 214),
    // CONVENTION: as st-center
    ("st-inside", 43, 34),
    // CONVENTION: as st-center
    ("st-multiply-50", 35, 35),
    // AGREE but for the rounded corners' outer texels
    ("st-outside-square", 34, 25),
];

fn flatten(file: &PsdFile) -> Result<Vec<u8>, String> {
    let import = file.layer_plates_rgba8().map_err(|e| e.to_string())?;
    let ctx = image_conformance::device::test_device().ok_or("no-gpu")?;
    let stack = LayerStack::from_psd_plates_with(&import, Some(&file.layer_mask.layers))
        .map_err(|e| e.to_string())?;
    pollster::block_on(stack.composite(Some(ctx), None))
        .map(|p| p.to_vec())
        .map_err(|e| e.to_string())
}

fn ids() -> Vec<String> {
    let mut v: Vec<String> = std::fs::read_dir(dir())
        .expect("fixtures dir")
        .flatten()
        .filter_map(|e| {
            let n = e.file_name().to_string_lossy().into_owned();
            n.strip_suffix(".psd").map(str::to_string)
        })
        .collect();
    v.sort();
    v
}

#[test]
#[allow(non_snake_case)]
fn photoshop_layer_styles_composite_as_recorded__feat__image_layers_styles() {
    let have_gpu = image_conformance::device::test_device().is_some();
    let dump = std::env::var_os("PAGED_STYLE_DUMP").map(PathBuf::from);
    let mut report = Vec::new();
    let mut problems = Vec::new();
    for id in ids() {
        let bytes = std::fs::read(dir().join(format!("{id}.psd"))).expect("read fixture");
        let file = PsdFile::parse(&bytes).expect("parse");
        assert_eq!(
            merged_data(&file),
            MergedData::Real,
            "{id}: 0x0421 must vouch"
        );
        let theirs = file.composite_rgba8().expect("merged composite decodes");
        let ours = match flatten(&file) {
            Ok(o) => o,
            Err(e) if e == "no-gpu" => {
                eprintln!("SKIP {id}: no GPU adapter");
                continue;
            }
            Err(e) => {
                problems.push(format!("{id}: refused: {e}"));
                continue;
            }
        };
        if let Some(d) = &dump {
            std::fs::create_dir_all(d).ok();
            std::fs::write(d.join(format!("{id}.rgba")), &ours).ok();
        }
        let d = compare_rgba8(&ours, &theirs.rgba, Reference::Straight);
        let max = d.channels[..3].iter().map(|c| c.max).max().unwrap_or(0);
        let mean = d.channels[..3].iter().map(|c| c.mean).fold(0.0, f64::max);
        let mean100 = (mean * 100.0).round() as u32;
        report.push(format!(
            "    (\"{id}\", {max}, {mean100}), // p99 {}",
            d.channels[..3].iter().map(|c| c.p99).max().unwrap_or(0)
        ));
        match EXPECT.iter().find(|(e, _, _)| *e == id) {
            None => problems.push(format!(
                "{id}: no expectation recorded (max {max}, mean {mean:.2})"
            )),
            Some((_, wmax, wmean)) if max > *wmax || mean100 > *wmean => problems.push(format!(
                "{id}: expected max ≤ {wmax}, mean ≤ {:.2}; got max {max}, mean {mean:.2}",
                *wmean as f64 / 100.0
            )),
            Some(_) => {}
        }
    }
    println!("{}", report.join("\n"));
    if have_gpu {
        assert!(problems.is_empty(), "{}", problems.join("\n"));
    }
}

fn style_of(id: &str) -> LayerStyle {
    let bytes = std::fs::read(dir().join(format!("{id}.psd"))).expect("read fixture");
    let file = PsdFile::parse(&bytes).expect("parse");
    file.layer_mask
        .layers
        .iter()
        .find_map(image_js::psd_layer_ext::style_of)
        .expect("a styled layer")
}

/// Every key the probe set comes back from Photoshop's own file.
#[test]
#[allow(non_snake_case)]
fn photoshop_style_descriptors_read_into_the_model__feat__image_layers_styles() {
    let all = style_of("bo-everything");
    assert_eq!(
        all.enabled_keys(),
        vec!["ebbl", "FrFX", "IrGl", "ChFX", "GrFl", "OrGl", "DrSh"]
    );
    let ds = &all.drop_shadows[0];
    assert_eq!(
        (ds.opacity, ds.angle, ds.distance, ds.size),
        (75.0, 120.0, 5.0, 5.0)
    );
    assert!(ds.knocks_out && !ds.use_global_light);
    assert_eq!(all.inner_glow.as_ref().unwrap().source, GlowSource::Edge);
    assert_eq!(all.bevel.as_ref().unwrap().style, BevelStyle::InnerBevel);
    assert_eq!(all.strokes[0].size, 2.0);
    let two = style_of("bo-two-shadows");
    assert_eq!(two.drop_shadows.iter().filter(|s| s.enabled).count(), 2);
    assert!(two.is_multi());
    let st = style_of("st-center");
    assert_eq!(st.strokes[0].position, StrokePosition::Center);
    let cone = style_of("bv-contour-cone");
    let c = cone.bevel.unwrap().contour.unwrap();
    assert!(c.enabled && c.contour.points.len() == 3);
    let spread = style_of("ds-spread50");
    assert_eq!(spread.drop_shadows[0].spread, 50.0);
}

/// A style read from Photoshop's file, written by `paged-psd` and read
/// again is the same style; a whole stack saved back as a PSD keeps it.
#[test]
#[allow(non_snake_case)]
fn photoshop_styles_round_trip_through_the_writer__feat__image_layers_styles() {
    for id in ids() {
        let s = style_of(&id);
        let back = LayerStyle::parse(&s.to_payload()).expect("re-read");
        assert_eq!(back.to_payload(), s.to_payload(), "{id}");
        assert_eq!(back.enabled_keys(), s.enabled_keys(), "{id}");
    }
}

/// SAVE-BACK: every recorded stack written as a layered PSD by the module
/// (`psd_write_stack`, the styles through `paged-psd`'s descriptor writer,
/// the Global Light into its resources) imports again with the same
/// styles and composites to the same pixels.
#[test]
#[allow(non_snake_case)]
fn photoshop_styles_survive_the_layered_save__feat__image_layers_styles() {
    let ctx = image_conformance::device::test_device();
    for id in ids() {
        let bytes = std::fs::read(dir().join(format!("{id}.psd"))).expect("read fixture");
        let file = PsdFile::parse(&bytes).expect("parse");
        let import = file.layer_plates_rgba8().expect("imports");
        let stack = LayerStack::from_psd_plates_with(&import, Some(&file.layer_mask.layers))
            .expect("stack");
        let mut out = file.clone();
        let composite = file.composite_rgba8().expect("composite").rgba;
        image_js::saveback::psd_write_stack(&mut out, &stack, &composite).expect("written");
        let written = out.write().expect("bytes");
        let back_file = PsdFile::parse(&written).expect("re-parse");
        let back_import = back_file.layer_plates_rgba8().expect("re-imports");
        let back =
            LayerStack::from_psd_plates_with(&back_import, Some(&back_file.layer_mask.layers))
                .expect("re-stack");
        assert_eq!(
            back.style_doc().global_light,
            stack.style_doc().global_light,
            "{id}: global light"
        );
        for (a, b) in stack.layers().iter().zip(back.layers()) {
            let (sa, sb) = (a.ext.style.as_deref(), b.ext.style.as_deref());
            assert_eq!(
                sa.map(LayerStyle::enabled_keys),
                sb.map(LayerStyle::enabled_keys),
                "{id}"
            );
            if let (Some(sa), Some(sb)) = (sa, sb) {
                assert_eq!(sa.drop_shadows.len(), sb.drop_shadows.len(), "{id}");
                assert_eq!(sa.is_multi(), sb.is_multi(), "{id}");
            }
            assert_eq!(a.ext.style_options, b.ext.style_options, "{id}");
        }
        if let Some(ctx) = ctx {
            let x = pollster::block_on(stack.composite(Some(ctx), None)).expect("fold");
            let y = pollster::block_on(back.composite(Some(ctx), None)).expect("fold again");
            assert_eq!(x[..], y[..], "{id}: the saved stack composites the same");
        }
    }
}
