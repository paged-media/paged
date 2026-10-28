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

//! Draw ADR 364 — the Illustrator oracle of interchange, replayed.
//!
//! `scripts/illustrator/probes/interchange-open.jsx` (recorded with
//! Illustrator 30.1, `packages/draw-bundle/test/fixtures/oracle/
//! interchange-open.illustrator.json`) has, for one synthetic drawing:
//!
//! - `svg-export`: Illustrator OPEN the SVG paged.draw's exporter wrote
//!   and measure the paths it read;
//! - `illustrator-dxf`: Illustrator build the drawing and EXPORT it as DXF
//!   (the file's text recorded).
//!
//! The replay holds both to the drawing, up to one common offset (the
//! probe places artwork relative to an artboard whose position is
//! Illustrator's business): every path's bounds within 0.05 pt, its paint
//! colour exactly, its stroke width within 0.05 pt (DXF line weights are
//! hundredths of a millimetre).
//!
//! Recorded findings, kept here as assertions:
//! - Illustrator reads the exported SVG exactly (bounds to the recorded
//!   precision, all four paints).
//! - Illustrator writes a FILL as a SOLID `HATCH` of line edges, and the
//!   filled shape's boundary again as an `LWPOLYLINE` with no colour of
//!   its own (BYLAYER, black) — so the import shows the triangle filled
//!   AND outlined in black. Its curves are `SPLINE`s and its circle a
//!   `CIRCLE`; its layer, "Ebene 1" on a German install, arrives as a
//!   named group.

use std::path::PathBuf;

use paged_svg::usvg;
use serde_json::Value;

const TOL: f64 = 0.05;

fn fixture() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/draw-bundle/test/fixtures/oracle/interchange-open.illustrator.json");
    serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap()
}

fn case<'a>(f: &'a Value, id: &str) -> &'a Value {
    f["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["id"] == id)
        .unwrap_or_else(|| panic!("no case {id}"))
}

/// One painted path: its bounds, which paint, which colour, its width.
#[derive(Debug, Clone)]
struct Painted {
    bounds: [f64; 4],
    filled: bool,
    rgb: [u8; 3],
    width: Option<f64>,
}

/// What Illustrator measured.
fn measured(c: &Value) -> Vec<Painted> {
    c["measured"]["paths"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| {
            let b: Vec<f64> = p["bounds"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_f64().unwrap())
                .collect();
            let rgb = |v: &Value| {
                let a = v.as_array().unwrap();
                [0, 1, 2].map(|i| a[i].as_f64().unwrap().round() as u8)
            };
            let filled = p["filled"] == true;
            Painted {
                bounds: [b[0], b[1], b[2], b[3]],
                filled,
                rgb: if filled {
                    rgb(&p["fill"])
                } else {
                    rgb(&p["stroke"])
                },
                width: p["strokeWidth"].as_f64(),
            }
        })
        .collect()
}

/// What an SVG document draws, read with usvg.
fn drawn(svg: &str) -> Vec<Painted> {
    let opt = usvg::Options {
        dpi: 72.0,
        ..usvg::Options::default()
    };
    let tree = usvg::Tree::from_str(svg, &opt).unwrap();
    let mut out = Vec::new();
    fn walk(g: &usvg::Group, out: &mut Vec<Painted>) {
        for node in g.children() {
            match node {
                usvg::Node::Group(g) => walk(g, out),
                usvg::Node::Path(p) => {
                    let b = p.abs_bounding_box();
                    let bounds = [
                        f64::from(b.left()),
                        f64::from(b.top()),
                        f64::from(b.right()),
                        f64::from(b.bottom()),
                    ];
                    let colour = |paint: &usvg::Paint| match paint {
                        usvg::Paint::Color(c) => [c.red, c.green, c.blue],
                        _ => panic!("a solid paint"),
                    };
                    if let Some(f) = p.fill() {
                        out.push(Painted {
                            bounds,
                            filled: true,
                            rgb: colour(f.paint()),
                            width: None,
                        });
                    }
                    if let Some(s) = p.stroke() {
                        out.push(Painted {
                            bounds,
                            filled: false,
                            rgb: colour(s.paint()),
                            width: Some(f64::from(s.width().get())),
                        });
                    }
                }
                _ => {}
            }
        }
    }
    walk(tree.root(), &mut out);
    out
}

/// `paths` moved so the union of their bounds starts at the origin.
fn normalised(paths: &[Painted]) -> Vec<Painted> {
    let x = paths.iter().map(|p| p.bounds[0]).fold(f64::MAX, f64::min);
    let y = paths.iter().map(|p| p.bounds[1]).fold(f64::MAX, f64::min);
    paths
        .iter()
        .map(|p| Painted {
            bounds: [
                p.bounds[0] - x,
                p.bounds[1] - y,
                p.bounds[2] - x,
                p.bounds[3] - y,
            ],
            ..p.clone()
        })
        .collect()
}

/// Every expected path has a drawn one of the same paint and colour, its
/// bounds and width within tolerance.
fn assert_matches(expected: &[Painted], got: &[Painted], what: &str) {
    let (expected, got) = (normalised(expected), normalised(got));
    for e in &expected {
        let hit = got.iter().find(|g| {
            g.filled == e.filled
                && g.rgb == e.rgb
                && g.bounds.iter().zip(e.bounds).all(|(a, b)| (a - b).abs() <= TOL)
        });
        let Some(hit) = hit else {
            panic!("{what}: nothing drawn like {e:?}\ngot {got:#?}");
        };
        if let (Some(a), Some(b)) = (e.width, hit.width) {
            assert!((a - b).abs() <= TOL, "{what}: width {b} for {a}");
        }
    }
}

#[test]
fn illustrator_reads_the_svg_paged_draw_exports() {
    let f = fixture();
    let c = case(&f, "svg-export");
    let svg = c["parameters"]["text"].as_str().unwrap();
    let ours = drawn(svg);
    let theirs = measured(c);
    assert_eq!(theirs.len(), 4);
    assert_matches(&ours, &theirs, "svg-export");
}

#[test]
fn paged_draw_reads_the_dxf_illustrator_writes() {
    let f = fixture();
    let c = case(&f, "illustrator-dxf");
    let dxf = c["parameters"]["illustrator_dxf"].as_str().unwrap();
    let import = draw_dxf::dxf_to_svg(dxf.as_bytes()).unwrap();
    // Nothing was left out: the HATCH is read.
    assert!(import.report.notes.is_empty(), "{:?}", import.report);
    assert_eq!(import.layers, 1);
    assert!(import.svg.contains(r#"<g id="Ebene 1">"#), "{}", import.svg);
    // Millimetres: the 100 pt rectangle is 100 pt again.
    let ours = drawn(&import.svg);
    let theirs = measured(c);
    assert_matches(&theirs, &ours, "illustrator-dxf");
    // The convention: the filled triangle's boundary comes back as a black
    // outline too (Illustrator writes it as its own LWPOLYLINE).
    let triangle = theirs.iter().find(|p| p.filled).unwrap();
    let outline = normalised(&ours)
        .into_iter()
        .filter(|p| !p.filled && p.rgb == [0, 0, 0])
        .count();
    assert_eq!(outline, 1, "{triangle:?}");
}
