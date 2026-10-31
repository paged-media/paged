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

//! The Illustrator oracle, replayed (publish ADR 658). Illustrator 30.1
//! drew each case, saved it as a `.pdf` and as an `.ai` (PDF compatible;
//! one case without), and recorded its own model of what it drew
//! (`fixtures/illustrator/pdf-ai-export.illustrator.json`, recorded by
//! `modules/draw/scripts/illustrator/probes/pdf-ai-export.jsx`). The page
//! reader reads both files back; every path's anchors, fill, stroke and
//! fill rule, the clipping path, the gradients, the transparency and the
//! text must be Illustrator's.
//!
//! Tolerances: anchors 0.05 pt (Illustrator writes PDF coordinates with
//! four decimals); colours 2/255 (the document's RGB through the PDF's
//! colour space); a contour may start at another anchor of the same cycle.

mod support;

use std::path::PathBuf;

use pdf_import::vectors::ir::{Anchor, Contour, Item, Paint, PathItem, TextItem, VectorPage};
use pdf_import::vectors::{inspect, read_page, ReadError, ReadOptions};
use serde_json::Value;

fn dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/illustrator")
}

fn fixture() -> Value {
    let text =
        std::fs::read_to_string(dir().join("pdf-ai-export.illustrator.json")).expect("fixture");
    serde_json::from_str(&text).expect("json")
}

fn case<'a>(f: &'a Value, id: &str) -> &'a Value {
    f["cases"]
        .as_array()
        .expect("cases")
        .iter()
        .find(|c| c["id"] == id)
        .unwrap_or_else(|| panic!("no case {id}"))
}

fn read(id: &str, ext: &str) -> VectorPage {
    let bytes = std::fs::read(dir().join(format!("{id}.{ext}"))).expect("file");
    read_page(&bytes, 0, &ReadOptions::default()).unwrap_or_else(|e| panic!("{id}.{ext}: {e}"))
}

/// Paths in paint order, with the clip outlines of the groups they sit in
/// (outermost first).
fn paths(items: &[Item]) -> Vec<(&PathItem, Vec<&Contour>)> {
    fn walk<'a>(
        items: &'a [Item],
        clips: &[&'a Contour],
        out: &mut Vec<(&'a PathItem, Vec<&'a Contour>)>,
    ) {
        for i in items {
            match i {
                Item::Path(p) => out.push((p, clips.to_vec())),
                Item::Group(g) => {
                    let mut c = clips.to_vec();
                    if let Some(clip) = &g.clip {
                        c.extend(clip.contours.iter());
                    }
                    walk(&g.items, &c, out);
                }
                _ => {}
            }
        }
    }
    let mut out = Vec::new();
    walk(items, &[], &mut out);
    out
}

fn texts(items: &[Item]) -> Vec<&TextItem> {
    let mut out = Vec::new();
    for i in items {
        match i {
            Item::Text(t) => out.push(t),
            Item::Group(g) => out.extend(texts(&g.items)),
            _ => {}
        }
    }
    out
}

fn pt(v: &Value) -> [f32; 2] {
    [v[0].as_f64().unwrap() as f32, v[1].as_f64().unwrap() as f32]
}

/// Illustrator's anchors of one recorded path.
fn anchors(v: &Value) -> Vec<Anchor> {
    v["anchors"]
        .as_array()
        .expect("anchors")
        .iter()
        .map(|a| Anchor {
            anchor: pt(&a["anchor"]),
            left: pt(&a["left"]),
            right: pt(&a["right"]),
        })
        .collect()
}

fn close(a: [f32; 2], b: [f32; 2]) -> bool {
    (a[0] - b[0]).abs() <= 0.05 && (a[1] - b[1]).abs() <= 0.05
}

/// The same anchors, possibly from another start of the same cycle, or
/// the cycle run the other way (a PDF `re` runs counter to Illustrator's
/// own order; reversed, an anchor's handles trade places).
fn same_contour(ours: &Contour, theirs: &[Anchor]) -> bool {
    let n = theirs.len();
    if ours.anchors.len() != n {
        return false;
    }
    let reversed: Vec<Anchor> = theirs
        .iter()
        .rev()
        .map(|a| Anchor {
            anchor: a.anchor,
            left: a.right,
            right: a.left,
        })
        .collect();
    [theirs.to_vec(), reversed].iter().any(|t| {
        (0..n).any(|shift| {
            (0..n).all(|k| {
                let a = &ours.anchors[(k + shift) % n];
                let b = &t[k];
                close(a.anchor, b.anchor) && close(a.left, b.left) && close(a.right, b.right)
            })
        })
    })
}

fn rgb255(p: &Paint) -> [f32; 3] {
    match p {
        Paint::Solid { rgb, .. } => rgb.map(|v| v * 255.0),
        other => panic!("not solid: {other:?}"),
    }
}

fn close_rgb(a: [f32; 3], b: &Value) -> bool {
    (0..3).all(|k| (a[k] - b[k].as_f64().unwrap() as f32).abs() <= 2.0)
}

/// Every recorded path of a case (front to back in the fixture) found in
/// what the reader read, with its paint.
fn check_paths(id: &str, page: &VectorPage) {
    let f = fixture();
    let c = case(&f, id);
    let measured = c["measured"]["paths"].as_array().expect("paths");
    let paint = c["parameters"]["illustrator"]["paint"]
        .as_array()
        .expect("paint");
    let read = paths(&page.items);
    for (m, p) in measured.iter().zip(paint) {
        let theirs = anchors(m);
        if p["clipping"] == true {
            assert!(
                read.iter()
                    .any(|(_, clips)| clips.iter().any(|c| same_contour(c, &theirs))),
                "{id}: the clipping path is a group's clip"
            );
            continue;
        }
        let (ours, _) = read
            .iter()
            .find(|(path, _)| path.contours.iter().any(|c| same_contour(c, &theirs)))
            .unwrap_or_else(|| panic!("{id}: no path with Illustrator's anchors {theirs:?}"));
        assert_eq!(
            ours.fill_rule == "evenodd",
            m["evenodd"] == true && m.get("compound").is_some(),
            "{id}: fill rule"
        );
        if let Some(fill) = p.get("fill").filter(|f| f.is_array()) {
            let got = ours
                .fill
                .as_ref()
                .unwrap_or_else(|| panic!("{id}: unfilled"));
            assert!(close_rgb(rgb255(got), fill), "{id}: fill {got:?} vs {fill}");
        }
        if let Some(stroke) = p.get("stroke") {
            let s = ours
                .stroke
                .as_ref()
                .unwrap_or_else(|| panic!("{id}: unstroked"));
            assert!(close_rgb(rgb255(&s.paint), stroke), "{id}: stroke colour");
            assert!((s.width as f64 - p["strokeWidth"].as_f64().unwrap()).abs() < 1e-3);
            assert_eq!(s.cap, p["cap"].as_str().unwrap(), "{id}: cap");
            assert_eq!(s.join, p["join"].as_str().unwrap(), "{id}: join");
            let dashes: Vec<f32> = p["dashes"]
                .as_array()
                .unwrap()
                .iter()
                .map(|d| d.as_f64().unwrap() as f32)
                .collect();
            assert_eq!(s.dash, dashes, "{id}: dashes");
        }
        if let Some(o) = p["opacity"].as_f64().filter(|o| *o < 100.0) {
            assert!(
                (ours.opacity as f64 - o / 100.0).abs() < 0.01,
                "{id}: opacity {}",
                ours.opacity
            );
            assert_eq!(ours.blend, Some("Multiply"), "{id}: blend");
        }
    }
}

const BOTH: [&str; 2] = ["pdf", "ai"];

#[test]
#[allow(non_snake_case)]
fn fills_strokes_and_curves_are_illustrators__feat__editor_shell_import_svg_pdf_vectors() {
    for ext in BOTH {
        check_paths("fills-strokes", &read("fills-strokes", ext));
    }
}

#[test]
#[allow(non_snake_case)]
fn a_compound_path_keeps_its_even_odd_rule__feat__editor_shell_import_svg_pdf_vectors() {
    for ext in BOTH {
        let page = read("compound-evenodd", ext);
        check_paths("compound-evenodd", &page);
        let p = paths(&page.items);
        assert_eq!(p.len(), 1, "one compound path");
        assert_eq!(p[0].0.contours.len(), 2);
    }
}

#[test]
#[allow(non_snake_case)]
fn a_clipping_mask_is_a_clip_group__feat__editor_shell_import_svg_pdf_vectors() {
    for ext in BOTH {
        check_paths("clip-group", &read("clip-group", ext));
    }
}

#[test]
#[allow(non_snake_case)]
fn transparency_and_blend_are_illustrators__feat__editor_shell_import_svg_pdf_vectors() {
    for ext in BOTH {
        check_paths("opacity-blend", &read("opacity-blend", ext));
    }
}

#[test]
#[allow(non_snake_case)]
fn a_linear_gradient_keeps_its_axis_and_stops__feat__editor_shell_import_svg_pdf_vectors() {
    let f = fixture();
    let g = &case(&f, "linear-gradient")["parameters"]["illustrator"]["paint"][0]["fill"];
    let length = g["length"].as_f64().unwrap() as f32;
    for ext in BOTH {
        let page = read("linear-gradient", ext);
        let p = paths(&page.items);
        assert_eq!(p.len(), 1);
        let Some(Paint::Linear {
            start, end, stops, ..
        }) = &p[0].0.fill
        else {
            panic!("{ext}: {:?}", p[0].0.fill);
        };
        let (dx, dy) = (end[0] - start[0], end[1] - start[1]);
        assert!(
            (dx.hypot(dy) - length).abs() < 0.05,
            "{ext}: length {}",
            dx.hypot(dy)
        );
        // The probe turned the object 30 degrees, gradient with it.
        let angle = (-dy).atan2(dx).to_degrees();
        assert!((angle - 30.0).abs() < 0.01, "{ext}: angle {angle}");
        let first = &g["stops"][0]["color"];
        let last = &g["stops"][1]["color"];
        assert!(close_rgb(stops[0].rgb.map(|v| v * 255.0), first));
        assert!(close_rgb(
            stops[stops.len() - 1].rgb.map(|v| v * 255.0),
            last
        ));
    }
}

#[test]
#[allow(non_snake_case)]
fn a_radial_gradient_keeps_its_centre_and_radius__feat__editor_shell_import_svg_pdf_vectors() {
    let f = fixture();
    let c = case(&f, "radial-gradient");
    let g = &c["parameters"]["illustrator"]["paint"][0]["fill"];
    let top = f["produced_by"]["artboard_rect_app"][1].as_f64().unwrap();
    let origin = [
        g["origin"][0].as_f64().unwrap() as f32,
        (top - g["origin"][1].as_f64().unwrap()) as f32,
    ];
    let radius = g["length"].as_f64().unwrap() as f32;
    for ext in BOTH {
        let page = read("radial-gradient", ext);
        let p = paths(&page.items);
        let Some(Paint::Radial {
            center,
            radius: r,
            stops,
            ..
        }) = &p[0].0.fill
        else {
            panic!("{ext}: {:?}", p[0].0.fill);
        };
        assert!(
            close(*center, origin),
            "{ext}: centre {center:?} vs {origin:?}"
        );
        assert!((r - radius).abs() < 0.05, "{ext}: radius {r}");
        assert!(close_rgb(
            stops[0].rgb.map(|v| v * 255.0),
            &g["stops"][0]["color"]
        ));
    }
}

#[test]
#[allow(non_snake_case)]
fn text_keeps_its_words_font_and_size__feat__editor_shell_import_svg_pdf_vectors() {
    let f = fixture();
    let t = &case(&f, "text")["parameters"]["illustrator"]["text"];
    for ext in BOTH {
        let page = read("text", ext);
        let runs = texts(&page.items);
        let all: String = runs.iter().map(|r| r.text.as_str()).collect();
        assert_eq!(
            all.replace(' ', ""),
            t["contents"].as_str().unwrap().replace(' ', "")
        );
        let r = runs[0];
        assert_eq!(r.font_name.as_deref(), t["font"].as_str(), "{ext}: font");
        assert!((r.font_size_pt as f64 - t["size"].as_f64().unwrap()).abs() < 0.01);
        assert!(!r.outlines.is_empty(), "{ext}: outlines for a missing font");
        // The glyphs start at the frame's left edge (a side bearing in).
        assert!((r.bbox[0] as f64 - t["left"].as_f64().unwrap()).abs() < 4.0);
    }
}

#[test]
#[allow(non_snake_case)]
fn an_ai_without_pdf_content_is_refused_its_pdf_is_read__feat__editor_shell_import_svg_pdf_vectors()
{
    // Illustrator's own file for this case is not committed (its stand-in
    // page embeds a font that may not be redistributed): the recording says
    // what it holds, and this is that page built from bytes — the German
    // sentence Illustrator 30.1 (de_DE) wrote, in an unembedded font, and
    // the private-data marker.
    let ai = support::pdf(
        612.0,
        792.0,
        "/Font << /F0 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >>",
        "BT /F0 12 Tf 90 200 Td (Dies ist eine Adobe Illustrator-Datei, die ohne PDF-Inhalt) Tj 0 -14 Td (gespeichert wurde.) Tj ET",
        &[support::Obj("<< /AIPrivateData1 0 >>".into())],
    );
    assert!(matches!(inspect(&ai), Err(ReadError::AiWithoutPdf(_))));
    assert!(matches!(
        read_page(&ai, 0, &ReadOptions::default()),
        Err(ReadError::AiWithoutPdf(_))
    ));
    check_paths("no-pdf-content", &read("no-pdf-content", "pdf"));
    // Every other .ai reads as Illustrator's, its private data unread.
    let info = inspect(&std::fs::read(dir().join("clip-group.ai")).expect("ai")).expect("info");
    assert_eq!(info.format, "ai");
    assert!(info.ai.as_ref().is_some_and(|a| a.has_private_data));
}
