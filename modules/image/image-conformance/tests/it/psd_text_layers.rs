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

//! PHOTOSHOP-WRITTEN TEXT LAYERS, replayed in CI.
//! `scripts/photoshop/probes/text-layers.jsx` had Photoshop set a line of
//! type over white, dark and coloured backdrops, at 60 % opacity and in
//! Multiply, and save each as a PSD with REAL merged data.
//!
//! Photoshop composites text in a gamma space, so the import gives a text
//! layer in Normal mode `Layer::blend_gamma` (`TEXT_BLEND_GAMMA`) and the
//! fold blends it with `compose.normal_gamma`. [`EXPECT`] holds each
//! case's measured distance from Photoshop's merged composite.

use std::path::PathBuf;

use image_conformance::psd_corpus::{compare_rgba8, merged_data, MergedData, Reference};
use image_js::layers::LayerStack;
use image_psd::PsdFile;

fn dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures/photoshop/text-layers")
}

/// `Ok(max_levels)` = imported and at most that far from Photoshop's
/// merged composite (8-bit levels, any channel); `Err(text)` = refused,
/// the refusal containing `text`.
///
/// Recorded 2026-10-05 against Photoshop 27.10. A plain normal blend of
/// the stored text pixels was 19–40 levels off on anti-aliased edges; the
/// gamma blend is within 1–7 (the best gamma per case is 1.52–1.6, the
/// fold uses 1.55). Text in another mode keeps the plain blend: Photoshop
/// applies its text gamma there too, which is not modelled (17 levels on
/// Multiply's edges).
const EXPECT: &[(&str, Result<u8, &str>)] = &[
    ("black-on-white", Ok(7)),
    ("red-on-green", Ok(1)),
    ("text-at-60", Ok(2)),
    ("text-multiply", Ok(17)),
    ("white-on-dark", Ok(2)),
];

fn flatten(file: &PsdFile) -> Result<Vec<u8>, String> {
    let import = file.layer_plates_rgba8().map_err(|e| e.to_string())?;
    let ctx = image_conformance::device::test_device().ok_or("no-gpu")?;
    let stack = LayerStack::from_psd_plates(&import).map_err(|e| e.to_string())?;
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
fn photoshop_text_layers_composite_as_recorded__feat__image_psd_layer_import() {
    let have_gpu = image_conformance::device::test_device().is_some();
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
        let got: Result<u8, String> = match flatten(&file) {
            Ok(ours) => {
                let d = compare_rgba8(&ours, &theirs.rgba, Reference::Straight);
                report.push(format!(
                    "{id:<24} max {:>3} p99 {:>3} mean {:.2}",
                    d.channels[..3].iter().map(|c| c.max).max().unwrap_or(0),
                    d.channels[..3].iter().map(|c| c.p99).max().unwrap_or(0),
                    d.channels[..3].iter().map(|c| c.mean).fold(0.0, f64::max)
                ));
                Ok(d.channels[..3].iter().map(|c| c.max).max().unwrap_or(0))
            }
            Err(e) if e == "no-gpu" => {
                eprintln!("SKIP {id}: no GPU adapter");
                continue;
            }
            Err(e) => {
                report.push(format!("{id:<24} refused: {e}"));
                Err(e)
            }
        };
        match EXPECT.iter().find(|(e, _)| *e == id) {
            None => problems.push(format!("{id}: no expectation recorded ({got:?})")),
            Some((_, want)) => match (want, &got) {
                (Ok(w), Ok(g)) if g <= w => {}
                (Err(w), Err(g)) if g.contains(w) => {}
                _ => problems.push(format!("{id}: expected {want:?}, got {got:?}")),
            },
        }
    }
    println!("{}", report.join("\n"));
    if have_gpu {
        assert!(problems.is_empty(), "{}", problems.join("\n"));
    }
}

// ─────────────── WP5.10: the text stays editable ───────────────

fn stack_of(file: &PsdFile) -> LayerStack {
    let import = file.layer_plates_rgba8().expect("plates");
    LayerStack::from_psd_plates_with(&import, Some(&file.layer_mask.layers)).expect("stack")
}

fn text_layer(stack: &LayerStack) -> &image_js::layers::TypeLayer {
    stack
        .layers()
        .iter()
        .find_map(|l| l.type_layer())
        .expect("a type layer")
}

/// Photoshop's type layers open as TYPE layers: text, face, size, colour,
/// alignment and the baseline origin come from the `TySh` block, and the
/// pixels stay Photoshop's render.
#[test]
#[allow(non_snake_case)]
fn photoshop_text_layers_open_as_editable_type__feat__image_layers_type() {
    let cases: &[(&str, f64, [u8; 3])] = &[
        ("black-on-white", 22.0, [0, 0, 0]),
        ("white-on-dark", 22.0, [255, 255, 255]),
        ("red-on-green", 16.0, [220, 30, 30]),
        ("text-at-60", 22.0, [20, 40, 120]),
        ("text-multiply", 22.0, [60, 120, 200]),
    ];
    for (id, size, rgb) in cases {
        let bytes = std::fs::read(dir().join(format!("{id}.psd"))).expect("fixture");
        let file = PsdFile::parse(&bytes).expect("parse");
        let stack = stack_of(&file);
        let t = text_layer(&stack);
        let s = &t.source;
        assert_eq!(s.text, "Ragged 0123", "{id}");
        assert_eq!(
            s.frame,
            image_js::layers::TypeFrame::Point { x: 4.0, y: 40.0 },
            "{id}: the probe's position"
        );
        let run = &s.runs[0];
        assert_eq!(run.font, "Myriad Pro", "{id}");
        assert_eq!(run.postscript.as_deref(), Some("MyriadPro-Regular"));
        assert!((run.size - size).abs() < 1e-6, "{id}: size {}", run.size);
        for (got, want) in run.color.iter().zip(rgb) {
            assert!(got.abs_diff(*want) <= 1, "{id}: colour {:?}", run.color);
        }
        assert_eq!(s.paragraphs[0].align, "left");
        assert_eq!(s.warp.style, "none");
        assert!(!t.stale, "{id}: Photoshop's render is kept");
        assert!(t.psd.is_some(), "{id}: and its TySh block");
    }
}

/// Written back, an unedited type layer carries Photoshop's own `TySh`
/// block byte for byte; an edited one carries the new text, which reads
/// back as type.
#[test]
#[allow(non_snake_case)]
fn type_layers_are_written_back_as_type__feat__image_layers_type() {
    let bytes = std::fs::read(dir().join("black-on-white.psd")).expect("fixture");
    let original = PsdFile::parse(&bytes).expect("parse");
    let tysh = |f: &PsdFile| {
        f.layer_mask
            .layers
            .iter()
            .flat_map(|l| l.addl.iter())
            .find(|a| &a.key == b"TySh")
            .and_then(|a| a.raw_block.clone())
            .expect("a TySh block")
    };
    let mut stack = stack_of(&original);
    let composite = vec![0u8; (stack.width() * stack.height() * 4) as usize];

    let mut out = PsdFile::parse(&bytes).expect("parse");
    image_js::saveback::psd_write_stack(&mut out, &stack, &composite).expect("write");
    let written = PsdFile::parse(&out.write().expect("bytes")).expect("re-parse");
    assert_eq!(
        tysh(&written),
        tysh(&original),
        "unedited: Photoshop's bytes"
    );

    let index = stack
        .layers()
        .iter()
        .position(|l| l.type_layer().is_some())
        .expect("type");
    let mut source = stack.layers()[index].type_layer().unwrap().source.clone();
    source.text = "Edited text".into();
    source.runs[0].length = 11;
    source.warp.style = "flag".into();
    source.warp.bend = 0.3;
    let px = stack.layers()[index].rgba.canvas().to_rgba8().into_owned();
    stack
        .recorded("Edit Type", None, |s| s.set_type(index, source, px))
        .expect("edit");
    let mut out = PsdFile::parse(&bytes).expect("parse");
    image_js::saveback::psd_write_stack(&mut out, &stack, &composite).expect("write");
    let written = PsdFile::parse(&out.write().expect("bytes")).expect("re-parse");
    assert_ne!(tysh(&written), tysh(&original));
    let back = stack_of(&written);
    let t = text_layer(&back);
    assert_eq!(t.source.text, "Edited text");
    assert_eq!(t.source.runs[0].font, "Myriad Pro");
    assert_eq!(t.source.warp.style, "flag");
    assert!((t.source.warp.bend - 0.3).abs() < 1e-9);
    assert_eq!(
        t.source.frame,
        image_js::layers::TypeFrame::Point { x: 4.0, y: 40.0 }
    );
}
