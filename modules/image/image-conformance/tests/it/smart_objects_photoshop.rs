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

//! SMART OBJECTS against Photoshop (image ADR 482). `scripts/photoshop/
//! probes/smart-objects.jsx` had Photoshop 27.10 make an embedded smart
//! object of a textured square of the colour-sweep stimulus, then
//! transform it, give it smart filters (with a filter mask, a switched-off
//! filter, a filter at half opacity) and edit its contents; each case is
//! the layered PSD it saved and what the ActionManager reported.
//!
//! The replay holds:
//! * the records to the report: the corners, the source size, the filter
//!   list, each filter's class and values, the filter mask;
//! * paged's render of each smart object FROM ITS EMBEDDED SOURCE through
//!   the recorded corners to the render Photoshop stored in the layer;
//! * the layered save: a smart object paged transforms, filters or
//!   re-contents is written LIVE — Photoshop's own record layout, the
//!   source in `lnk2`, the filter mask in `FEid`;
//! * on a GPU, a smart filter paged runs to Photoshop's stored render.

use std::path::PathBuf;
use std::sync::Arc;

use image_conformance::abr_corpus::json::Json;
use image_js::layers::LayerStack;
use image_js::smart::{render_placed, Quad};
use image_psd::smart_object::PlacedLayer;
use image_psd::PsdFile;

fn dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures/photoshop")
}

fn report() -> Json {
    Json::parse(
        &std::fs::read_to_string(dir().join("smart-objects.photoshop.json")).expect("report"),
    )
    .expect("json")
}

fn case<'a>(r: &'a Json, id: &str) -> &'a Json {
    r.get("cases")
        .and_then(Json::as_array)
        .and_then(|c| {
            c.iter()
                .find(|c| c.get("id").and_then(Json::as_str) == Some(id))
        })
        .unwrap_or_else(|| panic!("case {id}"))
}

fn file(id: &str) -> (Vec<u8>, PsdFile) {
    let bytes = std::fs::read(dir().join(format!("smart-objects/{id}.psd"))).expect("psd");
    let f = PsdFile::parse(&bytes).expect("parse");
    (bytes, f)
}

/// The smart object's record (the top layer, "art").
fn art(f: &PsdFile) -> (usize, PlacedLayer) {
    let i = f.layer_mask.layers.len() - 1;
    let p = image_js::smart::placed_layer(&f.layer_mask.layers[i], f.container)
        .expect("a smart object");
    (i, p)
}

fn quad_of(j: &Json) -> Quad {
    let a = j.as_array().expect("corners");
    let mut q = [0.0; 8];
    for (o, v) in q.iter_mut().zip(a) {
        *o = v.as_f64().expect("number");
    }
    q
}

/// The render Photoshop stored in the art layer, canvas-sized RGBA8.
fn stored(f: &PsdFile) -> Vec<u8> {
    let import = f.layer_plates_rgba8().expect("plates");
    let p = import.layers.last().expect("art");
    assert!(p.smart);
    p.canvas_rgba8(f.header.width, f.header.height)
}

/// How far two straight RGBA8 renders are apart, premultiplied (a pixel
/// that is transparent in both is equal whatever its colour): the share
/// of pixels more than `levels` off, and the largest difference.
fn distance(a: &[u8], b: &[u8], levels: u8) -> (f64, u8) {
    let mut off = 0usize;
    let mut worst = 0u8;
    let n = a.len() / 4;
    for (p, q) in a.as_chunks::<4>().0.iter().zip(b.as_chunks::<4>().0.iter()) {
        let pm = |x: &[u8], c: usize| (u32::from(x[c]) * u32::from(x[3]) + 127) / 255;
        let mut d = (i32::from(p[3]) - i32::from(q[3])).unsigned_abs();
        for c in 0..3 {
            d = d.max((pm(p, c) as i32 - pm(q, c) as i32).unsigned_abs());
        }
        let d = d.min(255) as u8;
        worst = worst.max(d);
        if d > levels {
            off += 1;
        }
    }
    (off as f64 * 100.0 / n as f64, worst)
}

/// How far paged's render from the source may be from Photoshop's stored
/// render: the share of pixels more than 8 levels off (premultiplied),
/// measured 2026-10-29. Identity, a flip and a scale down and up again
/// are exact; a resampling placement differs by CONVENTION — Photoshop's
/// "Bicubic Automatic" is not a published kernel: the differences sit on
/// the transparent edges of the source's content and, for the turn, along
/// its texture (a sub-pixel phase), never in the placement.
const RENDER_BAR: [(&str, f64); 7] = [
    ("so-plain", 0.0),
    ("so-scale-rotate", 5.5),
    ("so-skew", 2.5),
    ("so-flip", 0.0),
    ("so-upscale", 6.5),
    ("so-downscale-restore", 0.0),
    ("so-edit-contents", 1.0),
];

/// The cases without filters, and the transform each drew.
const PLACED: [&str; 7] = [
    "so-plain",
    "so-scale-rotate",
    "so-skew",
    "so-flip",
    "so-upscale",
    "so-downscale-restore",
    "so-edit-contents",
];

#[test]
#[allow(non_snake_case)]
fn the_records_say_what_photoshop_reported__feat__image_layers_smart_objects_full() {
    let r = report();
    for id in PLACED.iter().chain(&["sf-gaussian", "sf-transformed"]) {
        let (_, f) = file(id);
        let (_, p) = art(&f);
        let v = case(&r, id).get("values").expect("values");
        let want = quad_of(v.get("transform").expect("transform"));
        let got = p.quad().expect("corners");
        for (g, w) in got.iter().zip(want) {
            assert!(
                (g - w).abs() < 1e-6,
                "{id}: corners {got:?}, Photoshop {want:?}"
            );
        }
        let size = v.get("size").expect("size");
        assert_eq!(
            p.size(),
            Some((
                size.get("width").and_then(Json::as_f64).unwrap(),
                size.get("height").and_then(Json::as_f64).unwrap()
            )),
            "{id}"
        );
        assert!(p.warp_is_none(), "{id}");
        // The source is embedded in the document.
        let files = image_js::smart::psd_linked_files(&f);
        assert!(
            files.iter().any(|e| Some(e.uuid.as_str()) == p.uuid()),
            "{id}: source in lnk2"
        );
    }
}

#[test]
#[allow(non_snake_case)]
fn smart_objects_render_from_their_source_as_photoshop_stores_them__feat__image_layers_smart_objects_full(
) {
    let r = report();
    for id in PLACED {
        let (_, f) = file(id);
        let (_, p) = art(&f);
        let files = image_js::smart::psd_linked_files(&f);
        let entry = files
            .iter()
            .find(|e| Some(e.uuid.as_str()) == p.uuid())
            .expect("source");
        let file = image_js::smart::SmartFile::new(
            entry.uuid.clone(),
            entry.name.clone(),
            entry.file_type,
            Arc::from(entry.data.clone().into_boxed_slice()),
            None,
        );
        let raster = file.raster().expect("the embedded PSB decodes");
        let q = quad_of(
            case(&r, id)
                .get("values")
                .unwrap()
                .get("transform")
                .unwrap(),
        );
        let ours = render_placed(&raster, &q, f.header.width, f.header.height)
            .expect("render")
            .to_rgba8()
            .into_owned();
        let theirs = stored(&f);
        let (pct, worst) = distance(&ours, &theirs, 8);
        eprintln!("{id}: {pct:.2}% of pixels > 8 levels off, worst {worst}");
        let bar = RENDER_BAR
            .iter()
            .find(|(c, _)| *c == id)
            .map(|(_, b)| *b)
            .expect("a bar");
        assert!(
            pct <= bar,
            "{id}: {pct:.2}% of paged's render is more than 8 levels off Photoshop's (bar {bar}%)"
        );
    }
}

// ───────────────────────── the layered save ─────────────────────────

/// Photoshop's file opened as layers, its smart objects adopted (what
/// `layers_open_from_psd` does, without the composite check).
fn open(f: &PsdFile) -> LayerStack {
    let import = f.layer_plates_rgba8().expect("plates");
    let mut s =
        LayerStack::from_psd_plates_with(&import, Some(&f.layer_mask.layers)).expect("stack");
    let notes = s.adopt_psd_smart_objects(f);
    assert!(notes.is_empty(), "{notes:?}");
    s
}

fn save(f: &PsdFile, s: &LayerStack) -> Vec<u8> {
    let mut out = f.clone();
    // Photoshop recomposites a layered file; a flat grey merged image
    // keeps the bytes deterministic.
    let n = f.header.width as usize * f.header.height as usize;
    image_js::saveback::psd_write_stack(&mut out, s, &vec![128u8; n * 4]).expect("layered save");
    out.write().expect("bytes")
}

/// The smart object's index (the top layer).
fn top(s: &LayerStack) -> usize {
    s.len() - 1
}

/// A trapezoid on the 128 px canvas: the top edge pulled in (perspective).
const PERSPECTIVE: Quad = [40.0, 20.0, 88.0, 20.0, 110.0, 100.0, 18.0, 100.0];

fn filters_json(gauss: f64, motion_on: bool) -> String {
    format!(
        r#"{{"enabled":true,"filters":[{{"id":"gaussianBlur","values":{{"radius":{gauss}}},"enabled":true,"opacity":1,"mode":"normal"}},{{"id":"motionBlur","values":{{"angle":30,"length":10}},"enabled":{motion_on},"opacity":1,"mode":"normal"}}]}}"#
    )
}

/// The files paged writes for Photoshop to read back (`smart-readback`),
/// in a fixed order (the uuids paged mints are numbered per process).
fn readback_inputs() -> Vec<(String, Vec<u8>)> {
    let r = report();
    let (_, plain) = file("so-plain");
    let mut out = Vec::new();
    // 1. Transformed as Photoshop transformed so-scale-rotate.
    {
        let mut s = open(&plain);
        let q = quad_of(
            case(&r, "so-scale-rotate")
                .get("values")
                .unwrap()
                .get("transform")
                .unwrap(),
        );
        s.smart_place(top(&s), q).expect("place");
        out.push(("paged-transformed.psd".to_string(), save(&plain, &s)));
    }
    // 2. A perspective placement.
    {
        let mut s = open(&plain);
        s.smart_place(top(&s), PERSPECTIVE).expect("place");
        out.push(("paged-perspective.psd".to_string(), save(&plain, &s)));
    }
    // 3. Smart filters: a Gaussian Blur, a switched-off Motion Blur, a
    //    filter mask hiding the left part.
    {
        let mut s = open(&plain);
        let i = top(&s);
        let stack = image_js::smart::SmartFilterStack::from_json(&filters_json(3.0, false), None)
            .expect("json");
        let mut stack = stack;
        let mut m = vec![255u8; 128 * 128];
        for y in 0..128 {
            for x in 0..48 {
                m[y * 128 + x] = 0;
            }
        }
        stack.mask = image_gpu::SelectionCoverage::from_data(128, 128, m)
            .map(|c| image_js::layers::LayerMask::Canvas(Arc::new(c)));
        s.smart_set_filters("Smart Filters", i, stack)
            .expect("filters");
        out.push(("paged-filters.psd".to_string(), save(&plain, &s)));
    }
    // 4. Edited contents: a red square in the source, saved back.
    {
        let mut s = open(&plain);
        let i = top(&s);
        let src = s.layers()[i]
            .smart_source()
            .expect("smart")
            .raster()
            .expect("source");
        let mut px = src.rgba.to_vec();
        for y in 40..56usize {
            for x in 40..56usize {
                let k = (y * src.width as usize + x) * 4;
                px[k..k + 4].copy_from_slice(&[220, 20, 20, 255]);
            }
        }
        let contents = LayerStack::from_image(
            src.width,
            src.height,
            Arc::from(px.clone().into_boxed_slice()),
        )
        .expect("contents");
        let bytes = image_js::smart::contents_bytes(&contents, None, &px).expect("psb");
        let old = s.layers()[i].smart_source().unwrap().file.clone().unwrap();
        let file = image_js::smart::SmartFile::new(
            old.uuid.clone(),
            old.name.clone(),
            *b"8BPB",
            Arc::from(bytes.into_boxed_slice()),
            None,
        );
        s.smart_replace_source("Edit Contents", i, file)
            .expect("replace");
        out.push(("paged-edit-contents.psd".to_string(), save(&plain, &s)));
    }
    // 5. A smart object MADE in paged from a pixel layer.
    {
        let (_, f) = file("so-plain");
        let mut s = open(&f);
        let mut sq = vec![0u8; 128 * 128 * 4];
        for y in 70..110usize {
            for x in 10..60usize {
                let k = (y * 128 + x) * 4;
                sq[k..k + 4].copy_from_slice(&[30, 90, 200, 255]);
            }
        }
        let at = s
            .add_with_pixels("Add", "made in paged", Arc::from(sq.into_boxed_slice()))
            .expect("add");
        s.make_smart(at).expect("smart");
        s.smart_place(at, [10.0, 70.0, 70.0, 75.0, 65.0, 115.0, 5.0, 110.0])
            .expect("place");
        out.push(("paged-new-smart.psd".to_string(), save(&f, &s)));
    }
    out
}

fn hash(b: &[u8]) -> String {
    format!("{:016x}", image_core::ContentHash::of(b).0)
}

/// Stage the files `smart-readback.jsx` opens:
/// `PAGED_SMART_READBACK_OUT=<stage>/smart-readback cargo nextest run -p image-conformance
/// --run-ignored only write_smart_readback_inputs`.
#[test]
#[ignore = "maintainer: stages the smart-readback probe's inputs"]
fn write_smart_readback_inputs() {
    let Ok(dir) = std::env::var("PAGED_SMART_READBACK_OUT") else {
        paged_test_resources::skip!(
            paged_test_resources::Resource::Tools,
            "smart-readback inputs: PAGED_SMART_READBACK_OUT is not set"
        );
    };
    let dir = PathBuf::from(dir);
    std::fs::create_dir_all(&dir).expect("out dir");
    let mut manifest = String::new();
    for (name, bytes) in readback_inputs() {
        std::fs::write(dir.join(&name), &bytes).expect("write");
        manifest.push_str(&format!("{name}\t{}\n", hash(&bytes)));
    }
    std::fs::write(dir.join("manifest.txt"), manifest).expect("manifest");
}

// ───────────────────────── smart filters ─────────────────────────

/// Each recorded filter class and the catalogue entry it reads as.
const FILTERS: [(&str, &str, &str); 8] = [
    ("sf-gaussian", "gaussianBlur", r#"{"radius":3.0}"#),
    ("sf-box-blur", "boxBlur", r#"{"radius":3.0}"#),
    ("sf-high-pass", "highPass", r#"{"radius":2.0}"#),
    ("sf-median", "median", r#"{"radius":2.0}"#),
    ("sf-maximum", "maximum", r#"{"radius":2.0}"#),
    ("sf-minimum", "minimum", r#"{"radius":2.0}"#),
    ("sf-opacity", "gaussianBlur", r#"{"radius":3.0}"#),
    ("sf-transformed", "gaussianBlur", r#"{"radius":2.0}"#),
];

#[test]
#[allow(non_snake_case)]
fn photoshop_smart_filters_read_as_the_catalogue_and_write_back_as_photoshop_wrote_them__feat__image_layers_smart_objects_full(
) {
    for (id, filter, values) in FILTERS {
        let (_, f) = file(id);
        let s = open(&f);
        let src = s.layers()[top(&s)].smart_source().expect("smart");
        let fx = src.filters.as_deref().expect("filters");
        assert_eq!(fx.filters.len(), 1, "{id}");
        let e = &fx.filters[0];
        assert_eq!((e.id.as_str(), e.values.as_str()), (filter, values), "{id}");
        assert_eq!(
            e.opacity,
            if id == "sf-opacity" { 0.5 } else { 1.0 },
            "{id}"
        );
        assert!(fx.drawable().is_ok(), "{id}");
        // Written from paged's terms alone (no PSD form kept), the filter
        // is Photoshop's own descriptor, byte for byte.
        let mut fresh = e.clone();
        fresh.psd = None;
        let ours = image_js::smart::filter_to_psd(&fresh).expect("writable");
        let theirs = e.psd.as_ref().expect("read");
        let bytes = |d: &image_psd::Descriptor| {
            let mut b = Vec::new();
            image_psd::descriptor::write_descriptor(&mut b, d);
            b
        };
        // The class NAME is the display name, in the writer's language.
        let unnamed = |d: &image_psd::Descriptor| {
            let mut d = d.clone();
            d.class_name.clear();
            d
        };
        assert_eq!(
            bytes(&unnamed(&ours.filter)),
            bytes(&unnamed(&theirs.filter)),
            "{id}: Fltr"
        );
        assert_eq!(ours.filter_id, theirs.filter_id, "{id}: filterID");
        assert_eq!(ours.opacity, theirs.opacity, "{id}: opacity");
    }
    // A stack: the Motion Blur is there, switched off.
    let (_, f) = file("sf-stack");
    let s = open(&f);
    let fx = s.layers()[top(&s)]
        .smart_source()
        .unwrap()
        .filters
        .clone()
        .unwrap();
    let got: Vec<_> = fx
        .filters
        .iter()
        .map(|e| (e.id.as_str(), e.enabled))
        .collect();
    assert_eq!(got, vec![("gaussianBlur", true), ("motionBlur", false)]);
    assert_eq!(fx.filters[1].values, r#"{"angle":30.0,"length":10.0}"#);
}

#[test]
#[allow(non_snake_case)]
fn the_filter_mask_reads_from_the_filter_effects_cache__feat__image_layers_smart_objects_full() {
    let (_, f) = file("sf-mask");
    let s = open(&f);
    let fx = s.layers()[top(&s)]
        .smart_source()
        .unwrap()
        .filters
        .clone()
        .unwrap();
    let m = fx.mask.as_ref().expect("a filter mask");
    // Photoshop filled the left 48 columns black.
    assert_eq!(m.at(10, 64), 0);
    assert_eq!(m.at(47, 64), 0);
    assert_eq!(m.at(48, 64), 255);
    assert_eq!(m.at(100, 10), 255);
    assert!(fx.mask_enabled);
    // An object without a painted mask has none (all white is no mask).
    let (_, g) = file("sf-gaussian");
    let s = open(&g);
    assert!(s.layers()[top(&s)]
        .smart_source()
        .unwrap()
        .filters
        .as_ref()
        .unwrap()
        .mask
        .is_none());
}

// ─────────────────────────── the save ───────────────────────────

#[test]
#[allow(non_snake_case)]
fn a_transformed_smart_object_is_written_live_with_its_corners__feat__image_layers_smart_objects_full(
) {
    let inputs = readback_inputs();
    let get =
        |n: &str| PsdFile::parse(&inputs.iter().find(|(k, _)| k == n).unwrap().1).expect("parse");
    let r = report();
    let want = quad_of(
        case(&r, "so-scale-rotate")
            .get("values")
            .unwrap()
            .get("transform")
            .unwrap(),
    );
    for (name, quad) in [
        ("paged-transformed.psd", want),
        ("paged-perspective.psd", PERSPECTIVE),
    ] {
        let f = get(name);
        let (_, p) = art(&f);
        assert_eq!(p.quad(), Some(quad), "{name}");
        assert_eq!(p.transform(), Some(quad), "{name}");
        // The source is the one it was read with, still in lnk2.
        let files = image_js::smart::psd_linked_files(&f);
        assert!(
            files.iter().any(|e| Some(e.uuid.as_str()) == p.uuid()),
            "{name}"
        );
        // The legacy PlLd beside it.
        let rec = f.layer_mask.layers.last().unwrap();
        assert!(rec.addl.iter().any(|a| &a.key == b"PlLd"), "{name}");
        // Reopened, it is a smart object at that placement.
        let s = open(&f);
        assert_eq!(
            s.layers()[top(&s)].smart_source().unwrap().placement,
            Some(quad)
        );
    }
    // An unchanged smart object is the record it was read from.
    let (bytes, plain) = file("so-plain");
    let again = save(&plain, &open(&plain));
    let back = PsdFile::parse(&again).unwrap();
    assert_eq!(
        back.layer_mask.layers.last().unwrap().addl,
        plain.layer_mask.layers.last().unwrap().addl
    );
    let _ = bytes;
    // paged's render of the transform is the one Photoshop's own
    // transform of the same corners stored (within the bar above).
    let (_, ps) = file("so-scale-rotate");
    let theirs = stored(&ps);
    let f = get("paged-transformed.psd");
    let ours = stored(&f);
    let (pct, _) = distance(&ours, &theirs, 8);
    assert!(pct <= 5.5, "{pct}");
}

#[test]
#[allow(non_snake_case)]
fn smart_filters_and_their_mask_are_written_as_photoshop_reads_them__feat__image_layers_smart_objects_full(
) {
    let inputs = readback_inputs();
    let f = PsdFile::parse(
        &inputs
            .iter()
            .find(|(k, _)| k == "paged-filters.psd")
            .unwrap()
            .1,
    )
    .unwrap();
    let (_, p) = art(&f);
    let fx =
        image_psd::smart_object::SmartFilters::from_descriptor(p.filter_fx().expect("filterFX"))
            .unwrap();
    let classes: Vec<_> = fx
        .list
        .iter()
        .map(|x| (x.filter.class_id.text_lossy(), x.enabled))
        .collect();
    assert_eq!(
        classes,
        vec![("GsnB".to_string(), true), ("MtnB".to_string(), false)]
    );
    // The filter mask in the document's filter-effects cache.
    let effects = image_js::smart::psd_filter_effects(&f).expect("FEid");
    let entry = effects.entry(p.placed_id().unwrap()).expect("an entry");
    let (_, plane) = entry.mask_plane().unwrap().unwrap();
    assert_eq!(plane[64 * 128 + 10], 0);
    assert_eq!(plane[64 * 128 + 100], 255);
    assert!(f.layer_mask.addl_global.iter().any(|a| &a.key == b"FMsk"));
    // Reopened: the same stack.
    let s = open(&f);
    let back = s.layers()[top(&s)]
        .smart_source()
        .unwrap()
        .filters
        .clone()
        .unwrap();
    assert_eq!(back.filters.len(), 2);
    assert_eq!(back.mask.as_ref().unwrap().at(10, 64), 0);
}

#[test]
#[allow(non_snake_case)]
fn edited_contents_render_as_photoshop_rendered_its_own_edit__feat__image_layers_smart_objects_full() {
    // Photoshop edited the contents of a smart object at 75 % (a red
    // square at 40,40); paged makes the same edit to the source and
    // re-renders through the same corners.
    let r = report();
    let (_, ps) = file("so-edit-contents");
    let (_, plain) = file("so-plain");
    let mut s = open(&plain);
    let i = top(&s);
    let q = quad_of(
        case(&r, "so-edit-contents")
            .get("values")
            .unwrap()
            .get("transform")
            .unwrap(),
    );
    s.smart_place(i, q).expect("place");
    let src = s.layers()[i].smart_source().unwrap().raster().unwrap();
    let mut px = src.rgba.to_vec();
    for y in 40..56usize {
        for x in 40..56usize {
            let k = (y * src.width as usize + x) * 4;
            px[k..k + 4].copy_from_slice(&[220, 20, 20, 255]);
        }
    }
    let contents = LayerStack::from_image(
        src.width,
        src.height,
        Arc::from(px.clone().into_boxed_slice()),
    )
    .unwrap();
    let bytes = image_js::smart::contents_bytes(&contents, None, &px).expect("psb");
    let file = image_js::smart::SmartFile::new(
        "u",
        "art.psb",
        *b"8BPB",
        Arc::from(bytes.into_boxed_slice()),
        None,
    );
    let steps = s.undo_labels().len();
    s.smart_replace_source("Edit Contents", i, file)
        .expect("replace");
    assert_eq!(s.undo_labels().len(), steps + 1, "one undo step");
    let ours = s.layers()[i].rgba.to_rgba8().into_owned();
    let (pct, _) = distance(&ours, &stored(&ps), 8);
    assert!(pct <= 1.0, "{pct}");
    // The PSB paged wrote reopens to the edited pixels.
    let back = s.layers()[i].smart_source().unwrap().raster().unwrap();
    assert_eq!(&back.rgba[(45 * 80 + 45) * 4..][..4], &[220, 20, 20, 255]);
}

// ───────────────────── Photoshop reads paged's files ─────────────────────

fn readback() -> Json {
    Json::parse(
        &std::fs::read_to_string(dir().join("smart-readback.photoshop.json")).expect("readback"),
    )
    .expect("json")
}

fn png8(rel: &str) -> Vec<u8> {
    let bytes = std::fs::read(dir().join(rel)).expect("png");
    image_js::ingest::decode_rgba8(&bytes)
        .expect("png")
        .rgba
        .to_rgba8()
        .into_owned()
}

/// `layer` over `backdrop` (Normal, straight RGBA8).
fn over(backdrop: &[u8], layer: &[u8]) -> Vec<u8> {
    let mut out = backdrop.to_vec();
    for (o, s) in out
        .as_chunks_mut::<4>()
        .0
        .iter_mut()
        .zip(layer.as_chunks::<4>().0.iter())
    {
        let a = f32::from(s[3]) / 255.0;
        for c in 0..3 {
            o[c] = (f32::from(s[c]) * a + f32::from(o[c]) * (1.0 - a)).round() as u8;
        }
    }
    out
}

#[test]
#[allow(non_snake_case)]
fn photoshop_reopens_pageds_smart_objects_live_and_draws_them_as_paged_does__feat__image_layers_smart_objects_full(
) {
    let rb = readback();
    let inputs = readback_inputs();
    let cases = rb.get("cases").and_then(Json::as_array).expect("cases");
    assert_eq!(cases.len(), inputs.len());
    for c in cases {
        let id = c.get("id").and_then(Json::as_str).expect("id");
        let name = format!("{id}.psd");
        // The file Photoshop opened is the one the writer makes today.
        let (_, bytes) = inputs.iter().find(|(n, _)| *n == name).expect("input");
        let want_hash = c
            .get("params")
            .and_then(|p| p.get("hash"))
            .and_then(Json::as_str)
            .unwrap();
        assert_eq!(
            hash(bytes),
            want_hash,
            "{id}: the writer changed; record smart-readback again"
        );
        let f = PsdFile::parse(bytes).expect("parse");
        let layers = c
            .get("values")
            .and_then(|v| v.get("layers"))
            .and_then(Json::as_array)
            .unwrap();
        // Photoshop: the top layer is a live smart object whose contents
        // open, of the size paged wrote.
        let top_row = &layers[0];
        assert_eq!(
            top_row.get("kind").and_then(Json::as_str),
            Some("LayerKind.SMARTOBJECT"),
            "{id}"
        );
        let contents = top_row.get("contents").expect("contents");
        let s = open(&f);
        let src = s.layers()[top(&s)].smart_source().unwrap().clone();
        assert_eq!(
            (
                contents.get("width").and_then(Json::as_f64),
                contents.get("height").and_then(Json::as_f64)
            ),
            (Some(f64::from(src.width)), Some(f64::from(src.height))),
            "{id}: contents"
        );
        let smart = top_row.get("smart").expect("smart");
        let non_affine = quad_of(smart.get("non_affine").unwrap());
        for (g, w) in non_affine.iter().zip(src.quad()) {
            assert!(
                (g - w).abs() < 1e-6,
                "{id}: corners {non_affine:?} vs {:?}",
                src.quad()
            );
        }
        if id == "paged-filters" {
            let names: Vec<_> = smart
                .get("filters")
                .and_then(Json::as_array)
                .unwrap()
                .iter()
                .map(|x| {
                    (
                        x.get("enabled").and_then(Json::as_bool),
                        x.get("filter")
                            .and_then(|f| f.get("radius"))
                            .and_then(Json::as_f64),
                    )
                })
                .collect();
            assert_eq!(names, vec![(Some(true), Some(3.0)), (Some(false), None)]);
        }
        // Photoshop drew the object again from paged's record (at the
        // corners it reports after its 50 %/200 % round trip): paged draws
        // the same source at the same corners. The filters' case is
        // compared where its filter mask hides the blur.
        let after = quad_of(top_row.get("after_non_affine").unwrap());
        let ours_layer = render_placed(&src.raster().unwrap(), &after, 128, 128).unwrap();
        let import = f.layer_plates_rgba8().unwrap();
        let mut composite = import.layers[0].canvas_rgba8(128, 128);
        for p in &import.layers[1..import.layers.len() - 1] {
            composite = over(&composite, &p.canvas_rgba8(128, 128));
        }
        let ours = over(&composite, &ours_layer.to_rgba8());
        let theirs = png8(&format!("smart-readback/{id}.png"));
        let (a, b): (Vec<u8>, Vec<u8>) = if id == "paged-filters" {
            let cols = |px: &[u8]| -> Vec<u8> {
                px.as_chunks::<4>()
                    .0
                    .iter()
                    .enumerate()
                    .filter(|(i, _)| i % 128 < 40)
                    .flat_map(|(_, p)| p.to_vec())
                    .collect()
            };
            (cols(&ours), cols(&theirs))
        } else {
            (ours, theirs)
        };
        let (pct, worst) = distance(&a, &b, 8);
        eprintln!("{id}: {pct:.2}% > 8 levels off, worst {worst}");
        let bar = READBACK_BAR
            .iter()
            .find(|(c, _)| *c == id)
            .map(|(_, b)| *b)
            .unwrap();
        assert!(pct <= bar, "{id}: {pct:.2}% (bar {bar}%)");
    }
}

/// Photoshop's render of paged's records against paged's (share of
/// pixels more than 8 levels off, measured 2026-10-29); the conventions
/// of `RENDER_BAR`.
const READBACK_BAR: [(&str, f64); 5] = [
    ("paged-transformed", 5.5),
    ("paged-perspective", 2.0),
    ("paged-filters", 0.0),
    ("paged-edit-contents", 0.0),
    ("paged-new-smart", 1.5),
];

#[test]
#[allow(non_snake_case)]
fn a_gaussian_smart_filter_draws_as_photoshop_drew_it__feat__image_layers_smart_objects_full() {
    // The filter pass the bundle runs (the adjust chain's blur over the
    // unfiltered render, landed through the filter mask) against the
    // render Photoshop stored for sf-gaussian (radius 3) and sf-mask
    // (radius 4, left 48 columns masked).
    let Some(ctx) = image_conformance::device::test_device() else {
        return;
    };
    for (id, sigma) in [("sf-gaussian", 3.0f32), ("sf-mask", 4.0)] {
        let (_, f) = file(id);
        let mut s = open(&f);
        let i = top(&s);
        let base = s.smart_base(i).expect("base");
        let img = image_js::ingest::DecodedImage {
            width: 128,
            height: 128,
            // The pass blurs associated colour (`ASSOCIATED_FILTERS`).
            rgba: image_js::pixels::Pixels::from_rgba8(Arc::from(
                image_js::smart::associate(&base).into_boxed_slice(),
            )),
            display: image_js::display::DisplayTreatment::AssumedSrgb,
            depth_reduced: false,
        };
        let p = image_js::ingest::AdjustParams {
            blur_sigma: sigma,
            ..Default::default()
        };
        let blurred =
            pollster::block_on(image_js::ingest::adjust_rgba8(ctx, &img, &p, None)).expect("blur");
        let blurred = image_js::smart::dissociate(&blurred);
        s.smart_land_filters(i, &base, &blurred).expect("land");
        let ours = s.layers()[i].rgba.to_rgba8().into_owned();
        // What Photoshop shows: its stored channels through the filter
        // mask over its cached unfiltered render — what the import makes
        // of the layer.
        let theirs = open(&f).layers()[i].rgba.to_rgba8().into_owned();
        let (pct, worst) = distance(&ours, &theirs, 8);
        eprintln!("{id}: {pct:.2}% > 8 levels off, worst {worst}");
        assert!(pct <= 0.5, "{id}: {pct:.2}%");
    }
}
