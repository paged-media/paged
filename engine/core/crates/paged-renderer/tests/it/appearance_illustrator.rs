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

//! Engine ADR 1043 — native appearance against Adobe Illustrator.
//!
//! `tests/fixtures/illustrator/appearance/` holds the recording of
//! `modules/draw/scripts/illustrator/probes/appearance.jsx`: for each case
//! an object built with the Appearance panel's Add New Fill / Add New Stroke
//! (a yellow 100 pt square, sometimes over a grey backdrop), Illustrator's
//! PNG-24 export of the artboard at 72 ppi, and what Expand Appearance made
//! of it. Each case is rebuilt here from the recorded steps as a native
//! appearance — the frame's yellow fill, then one layer per added fill or
//! stroke, in the order they were added — drawn on the CPU lane at 72 dpi
//! and compared with Illustrator's pixels.
//!
//! What the recording settles about Illustrator:
//!
//! - a new fill or stroke goes ABOVE the one targeted, so the stack is the
//!   order of the steps, and a fill added after the strokes covers them
//!   (`strokes-blend`);
//! - strokes are centred on the outline and a wide stroke under a narrow
//!   one shows on both sides of it (`two-strokes`);
//! - the DOM's `opacity` and `blendingMode`, written after a layer was
//!   added, land on the OBJECT, not the layer: Expand Appearance answers
//!   with every part at 100 % Normal inside a group that carries them. So
//!   these cases are the item's opacity and blend mode applied once to all
//!   its layers together; a layer's own opacity and blend mode cannot be
//!   set through Illustrator's scripting model and are not recorded.
//!
//! The comparison skips pixels within 1.5 px of an edge of any painted
//! band (anti-aliasing differs between rasterizers) and requires every
//! other pixel to agree within 3 levels per channel.

use std::collections::BTreeSet;
use std::io::Write;
use std::path::PathBuf;

use paged_gpu::RasterOptions;
use paged_model::appearance::PaintLayer;
use paged_renderer::pipeline::{build_document, PipelineOptions};
use serde_json::Value as J;

const TOLERANCE: i32 = 3;
const EDGE_PX: f32 = 1.5;

fn dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/illustrator/appearance")
}

fn swatch(rgb: [u8; 3]) -> String {
    format!("Color/c{}_{}_{}", rgb[0], rgb[1], rgb[2])
}

fn rgb_of(v: &J) -> [u8; 3] {
    let a = v.as_array().expect("an [r, g, b] colour");
    [0, 1, 2].map(|i| a[i].as_u64().expect("0..255") as u8)
}

fn rect_xml(id: &str, b: [f32; 4], fill: [u8; 3]) -> String {
    // GeometricBounds is top left bottom right; the probe's paths are in
    // the artboard's frame, origin top-left, Y down — the page's frame.
    format!(
        r#"<Rectangle Self="{id}" GeometricBounds="{} {} {} {}" FillColor="{}" StrokeWeight="0" ItemTransform="1 0 0 1 0 0"/>"#,
        b[1],
        b[0],
        b[3],
        b[2],
        swatch(fill)
    )
}

fn idml(colours: &BTreeSet<[u8; 3]>, items: &str) -> Vec<u8> {
    use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};
    let swatches: String = colours
        .iter()
        .map(|c| {
            format!(
                r#"<Color Self="{}" Model="Process" Space="RGB" ColorValue="{} {} {}" Name="{}"/>"#,
                swatch(*c),
                c[0],
                c[1],
                c[2],
                swatch(*c)
            )
        })
        .collect();
    let mut zip = ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    zip.start_file("mimetype", stored).unwrap();
    zip.write_all(b"application/vnd.adobe.indesign-idml-package")
        .unwrap();
    let mut put = |name: &str, body: String| {
        zip.start_file(name, stored).unwrap();
        zip.write_all(body.as_bytes()).unwrap();
    };
    put(
        "designmap.xml",
        r#"<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">
  <idPkg:Graphic src="Resources/Graphic.xml"/>
  <idPkg:Spread src="Spreads/Spread_sp1.xml"/>
</Document>"#
            .to_string(),
    );
    put(
        "Resources/Graphic.xml",
        format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Graphic xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">{swatches}</idPkg:Graphic>"#
        ),
    );
    put(
        "Spreads/Spread_sp1.xml",
        format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Spread xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">
  <Spread Self="sp1"><Page Self="p1" GeometricBounds="0 0 792 612"/>{items}</Spread>
</idPkg:Spread>"#
        ),
    );
    zip.finish().unwrap().into_inner()
}

fn bounds(path: &J) -> [f32; 4] {
    // [minX, minY, maxX, maxY] from the recorded anchors.
    let mut b = [f32::MAX, f32::MAX, f32::MIN, f32::MIN];
    for a in path["anchors"].as_array().unwrap() {
        let p = &a["anchor"];
        let (x, y) = (p[0].as_f64().unwrap() as f32, p[1].as_f64().unwrap() as f32);
        b = [b[0].min(x), b[1].min(y), b[2].max(x), b[3].max(y)];
    }
    b
}

struct Outcome {
    id: String,
    compared: usize,
    worst: i32,
    off: usize,
    first_off: Option<(u32, u32, [u8; 3], [u8; 3])>,
}

fn replay(case: &J) -> Outcome {
    let id = case["id"].as_str().unwrap().to_string();
    let inputs = case["input"]["paths"].as_array().unwrap();
    let steps = case["parameters"]["steps"].as_array().unwrap();
    let parts = case["parameters"]["parts"].as_array().unwrap();
    // The recording's own verdict: every expanded part is 100 % Normal, and
    // the one group carries the object's opacity and blend mode.
    let group = parts
        .iter()
        .find(|p| p["group"].as_bool() == Some(true))
        .expect("Expand Appearance made a group");
    for p in parts.iter().filter(|p| p["group"].is_null()) {
        assert_eq!(p["opacity"].as_f64(), Some(100.0), "{id}: a part's opacity");
        assert_eq!(p["blend"].as_str(), Some("Normal"), "{id}: a part's blend");
    }
    let object_opacity = group["opacity"].as_f64().unwrap() as f32;
    let object_blend = group["blend"].as_str().unwrap().to_string();

    let mut colours = BTreeSet::new();
    let mut items = String::new();
    let mut edges: Vec<f32> = Vec::new();
    for (i, p) in inputs.iter().enumerate() {
        let fill = rgb_of(&p["fill"]);
        colours.insert(fill);
        let b = bounds(p);
        edges.extend([b[0], b[1], b[2], b[3]]);
        items.push_str(&rect_xml(&format!("i{i}"), b, fill));
    }
    let square = bounds(inputs.last().unwrap());
    let mut layers = Vec::new();
    for s in steps {
        if s["object"].as_bool() == Some(true) {
            continue;
        }
        let c = rgb_of(&s["color"]);
        colours.insert(c);
        layers.push(match s["add"].as_str().unwrap() {
            "fill" => PaintLayer::fill(swatch(c)),
            _ => {
                let w = s["width"].as_f64().unwrap() as f32;
                for e in [square[0], square[1], square[2], square[3]] {
                    edges.extend([e - w / 2.0, e + w / 2.0]);
                }
                PaintLayer::stroke(swatch(c), w)
            }
        });
    }
    let mut doc = idml_import::import_idml_doc(&idml(&colours, &items)).expect("import");
    {
        let sp = &mut doc.spreads[0].spread;
        let sq = sp.rectangles.last_mut().unwrap();
        sq.appearance = layers;
        if object_opacity < 100.0 {
            sq.opacity = Some(object_opacity);
        }
        if object_blend != "Normal" {
            sq.blend_mode = Some(object_blend);
        }
    }
    let built = build_document(&doc, &PipelineOptions::default()).expect("build");
    let list = &built.pages[0].list;
    let mut opts = RasterOptions::new(612.0, 792.0);
    opts.dpi = 72.0;
    let ours = paged_gpu::rasterize(list, &opts);
    let theirs = image::open(dir().join(format!("{id}.png")))
        .expect("Illustrator's PNG")
        .to_rgb8();
    assert_eq!((theirs.width(), theirs.height()), (612, 792));
    assert_eq!((ours.width(), ours.height()), (612, 792));

    let near_edge = |v: f32| edges.iter().any(|e| (v - e).abs() <= EDGE_PX);
    let mut out = Outcome {
        id,
        compared: 0,
        worst: 0,
        off: 0,
        first_off: None,
    };
    for y in 0..792u32 {
        let cy = y as f32 + 0.5;
        if near_edge(cy) {
            continue;
        }
        for x in 0..612u32 {
            let cx = x as f32 + 0.5;
            if near_edge(cx) {
                continue;
            }
            let a = ours.get_pixel(x, y).0;
            let b = theirs.get_pixel(x, y).0;
            let d = (0..3)
                .map(|i| (i32::from(a[i]) - i32::from(b[i])).abs())
                .max()
                .unwrap();
            out.compared += 1;
            out.worst = out.worst.max(d);
            if d > TOLERANCE {
                out.off += 1;
                out.first_off
                    .get_or_insert((x, y, [a[0], a[1], a[2]], [b[0], b[1], b[2]]));
            }
        }
    }
    out
}

#[test]
#[allow(non_snake_case)]
fn every_recorded_appearance_draws_as_illustrator_draws_it__feat__frames_paths_native_appearance() {
    let json: J = serde_json::from_slice(
        &std::fs::read(dir().join("appearance.illustrator.json")).expect("the recording"),
    )
    .unwrap();
    let cases = json["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 7);
    let outcomes: Vec<Outcome> = cases.iter().map(replay).collect();
    let report: Vec<String> = outcomes
        .iter()
        .map(|o| {
            format!(
                "{}: {} px compared, worst {} levels, {} over {TOLERANCE}{}",
                o.id,
                o.compared,
                o.worst,
                o.off,
                o.first_off
                    .map(|(x, y, a, b)| format!(
                        " (first at {x},{y}: ours {a:?}, Illustrator {b:?})"
                    ))
                    .unwrap_or_default()
            )
        })
        .collect();
    eprintln!("{}", report.join("\n"));
    for o in &outcomes {
        assert!(o.compared > 300_000, "{}", report.join("\n"));
    }
    assert!(
        outcomes.iter().all(|o| o.off == 0),
        "the engine disagrees with Illustrator:\n{}",
        report.join("\n")
    );
}
