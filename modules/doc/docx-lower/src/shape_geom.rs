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

//! Doc ADR 627 — a DrawingML shape's outline in the shape's own box, as the
//! path anchors the engine draws (`[x, y, left x, left y, right x, right y]`
//! in points, `(0, 0)` at the box's top left).
//!
//! A preset is evaluated by `dml-geom` from ECMA-376 Annex D's definitions
//! (all 187, with their `a:avLst` guides; doc ADR 629, which replaced the
//! hand port of fourteen that ADR 627 made while the definitions did not fit
//! the doc wasm). An authored `a:custGeom` is the same program, read and
//! evaluated by `dml-geom` too (amendment 4). The line ends are
//! `dml_geom::heads`, Office's one head geometry. A name that is not a
//! preset is told, never guessed.

use docx_core::{Shape, ShapeGeometry};

pub use dml_geom::heads::{cut_under_heads, heads, inset, Head, Outline};

/// `dml-geom`'s evaluated outline as the anchors the lowering draws. A
/// contour that is not filled (a detail line) is left open; a closed one
/// keeps its closing segment, drawn back to its first anchor.
fn anchors_of(o: &dml_geom::Outline) -> Outline {
    let mut out = Outline::default();
    let anchor = |p: &dml_geom::PathPoint| {
        [
            p.anchor.0 as f32,
            p.anchor.1 as f32,
            p.left.0 as f32,
            p.left.1 as f32,
            p.right.0 as f32,
            p.right.1 as f32,
        ]
    };
    for sp in &o.subpaths {
        let Some(first) = sp.points.first() else {
            continue;
        };
        out.starts.push(out.anchors.len());
        out.open.push(!(sp.closed && sp.filled));
        out.anchors.extend(sp.points.iter().map(anchor));
        if sp.closed && !sp.filled {
            // The closing segment, its incoming handle the first anchor's.
            let mut back = anchor(first);
            back[4] = back[0];
            back[5] = back[1];
            if let Some(last) = out.anchors.last() {
                if (last[0] - back[0]).abs() < 1e-3 && (last[1] - back[1]).abs() < 1e-3 {
                    continue;
                }
            }
            out.anchors.push(back);
        }
    }
    out
}

/// An authored geometry's outline through `dml-geom`'s evaluator (guides,
/// arcs and each path's own `w` x `h` space). It is evaluated in the
/// shape's own EMU space, as DrawingML defines it (a path that names no
/// space, and the `w` / `h` guides, are in EMU), then scaled to the box.
fn custom(geom: &dml_geom::CustomGeometry, shape: &Shape, w: f32, h: f32) -> Outline {
    let (ew, eh) = (
        shape.width_emu.max(1) as f64,
        shape.height_emu.max(1) as f64,
    );
    let mut o = dml_geom::custom(geom, ew, eh);
    let (sx, sy) = (w as f64 / ew, h as f64 / eh);
    let scale = |p: &mut (f64, f64)| *p = (p.0 * sx, p.1 * sy);
    for sp in &mut o.subpaths {
        for p in &mut sp.points {
            scale(&mut p.anchor);
            scale(&mut p.left);
            scale(&mut p.right);
        }
    }
    anchors_of(&o)
}

/// Turn the outline by `shape`'s flips and rotation, about the box's centre
/// (`dml-geom`'s orientation, the one slide and sheet place shapes with).
fn transform(out: &mut Outline, shape: &Shape, w: f32, h: f32) {
    if shape.rotation == 0 && !shape.flip_h && !shape.flip_v {
        return;
    }
    let (cx, cy) = (w as f64 / 2.0, h as f64 / 2.0);
    let m = dml_geom::place::orient(shape.rotation as f64 / 60_000.0, shape.flip_h, shape.flip_v);
    let m = dml_geom::place::mul(
        &dml_geom::place::translate(cx, cy),
        &dml_geom::place::mul(&m, &dml_geom::place::translate(-cx, -cy)),
    );
    for a in &mut out.anchors {
        for i in 0..3 {
            let (x, y) = dml_geom::place::apply(&m, (a[i * 2] as f64, a[i * 2 + 1] as f64));
            a[i * 2] = x as f32;
            a[i * 2 + 1] = y as f32;
        }
    }
}

/// A preset's outline in a `w` x `h` pt box through `dml-geom`'s evaluator
/// of Annex D's definitions. `None` for a name that is not a preset.
fn preset(name: &str, adjust: &[(String, i64)], w: f32, h: f32) -> Option<Outline> {
    let adjust: Vec<(String, String)> = adjust
        .iter()
        .map(|(n, v)| (n.clone(), format!("val {v}")))
        .collect();
    Some(anchors_of(&dml_geom::preset(
        name, &adjust, w as f64, h as f64,
    )?))
}

/// The outline of `shape` in a `w` x `h` pt box, or why it is not drawn.
pub fn outline(shape: &Shape, w: f32, h: f32) -> Result<Outline, String> {
    let mut out = match &shape.geometry {
        ShapeGeometry::Preset { name, adjust } => {
            preset(name, adjust, w, h).ok_or_else(|| format!("preset \u{201c}{name}\u{201d}"))?
        }
        ShapeGeometry::Custom(geom) => custom(geom, shape, w, h),
    };
    if out.anchors.is_empty() {
        return Err("an empty geometry".into());
    }
    transform(&mut out, shape, w, h);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shape(name: &str, adjust: &[(&str, i64)]) -> Shape {
        Shape {
            geometry: ShapeGeometry::Preset {
                name: name.into(),
                adjust: adjust.iter().map(|(n, v)| (n.to_string(), *v)).collect(),
            },
            ..Shape::default()
        }
    }

    fn pos(o: &Outline) -> Vec<(f32, f32)> {
        o.anchors.iter().map(|a| (a[0], a[1])).collect()
    }

    #[test]
    fn a_triangle_puts_its_apex_by_adj() {
        let o = outline(&shape("triangle", &[("adj", 25000)]), 100.0, 60.0).unwrap();
        assert_eq!(pos(&o), vec![(0.0, 60.0), (25.0, 0.0), (100.0, 60.0)]);
        assert_eq!((o.starts.clone(), o.open.clone()), (vec![0], vec![false]));
    }

    #[test]
    fn a_rounded_rectangle_rounds_by_the_short_side() {
        let o = outline(&shape("roundRect", &[("adj", 50000)]), 100.0, 40.0).unwrap();
        // adj 50 % of the short side: a stadium; the top edge runs from
        // `r` in to `r` from the right.
        let top: Vec<f32> = pos(&o)
            .iter()
            .filter(|(_, y)| y.abs() < 1e-3)
            .map(|(x, _)| *x)
            .collect();
        assert!(top.iter().any(|x| (x - 20.0).abs() < 1e-3), "{top:?}");
        assert!(top.iter().any(|x| (x - 80.0).abs() < 1e-3), "{top:?}");
        assert_eq!(o.open, vec![false]);
    }

    #[test]
    fn an_ellipse_passes_through_the_box_s_edge_midpoints() {
        let o = outline(&shape("ellipse", &[]), 80.0, 40.0).unwrap();
        let p = pos(&o);
        for want in [(0.0, 20.0), (40.0, 0.0), (80.0, 20.0), (40.0, 40.0)] {
            assert!(
                p.iter()
                    .any(|q| (q.0 - want.0).abs() < 1e-3 && (q.1 - want.1).abs() < 1e-3),
                "{want:?} in {p:?}"
            );
        }
    }

    #[test]
    fn every_annex_d_preset_is_drawn() {
        let o = outline(&shape("cloudCallout", &[]), 100.0, 60.0).unwrap();
        assert!(o.anchors.len() > 10);
        let o = outline(&shape("chevron", &[]), 100.0, 60.0).unwrap();
        assert_eq!(o.anchors.len(), 6);
    }

    #[test]
    fn a_line_is_open_and_flips() {
        let mut s = shape("line", &[]);
        s.flip_v = true;
        let o = outline(&s, 50.0, 30.0).unwrap();
        assert_eq!(pos(&o), vec![(0.0, 30.0), (50.0, 0.0)]);
        assert_eq!(o.open, vec![true]);
    }

    #[test]
    fn a_quarter_turn_swaps_the_axes_about_the_centre() {
        let mut s = shape("line", &[]);
        s.rotation = 90 * 60_000;
        let o = outline(&s, 40.0, 40.0).unwrap();
        let (x0, y0) = (o.anchors[0][0], o.anchors[0][1]);
        assert!((x0 - 40.0).abs() < 1e-3 && y0.abs() < 1e-3, "{x0} {y0}");
    }

    #[test]
    fn a_name_that_is_not_a_preset_is_told() {
        let e = outline(&shape("notAPreset", &[]), 10.0, 10.0).unwrap_err();
        assert!(e.contains("notAPreset"));
    }

    #[test]
    fn a_custom_path_scales_to_the_box_and_a_no_fill_path_stays_open() {
        let xml = r#"<a:custGeom xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:pathLst><a:path w="100" h="100" fill="none"><a:moveTo><a:pt x="0" y="0"/></a:moveTo><a:lnTo><a:pt x="100" y="0"/></a:lnTo><a:lnTo><a:pt x="100" y="100"/></a:lnTo><a:close/></a:path></a:pathLst></a:custGeom>"#;
        let s = custom_shape(xml);
        let o = outline(&s, 200.0, 50.0).unwrap();
        assert_eq!(
            pos(&o),
            vec![(0.0, 0.0), (200.0, 0.0), (200.0, 50.0), (0.0, 0.0)]
        );
        assert_eq!(o.open, vec![true]);
    }

    fn custom_shape(xml: &str) -> Shape {
        let el = paged_ooxml::tree::parse(xml.as_bytes()).unwrap();
        Shape {
            geometry: ShapeGeometry::Custom(Box::new(dml_geom::read::custom_geometry(&el))),
            width_emu: 1_270_000,
            height_emu: 635_000,
            ..Shape::default()
        }
    }

    /// An authored geometry with guides and an `a:arcTo` (which the
    /// literal-points reader refused) is drawn: a half disc.
    #[test]
    fn a_custom_geometry_with_guides_and_an_arc_is_drawn() {
        let xml = r#"<a:custGeom xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:gdLst><a:gd name="r" fmla="*/ w 1 2"/></a:gdLst><a:pathLst><a:path><a:moveTo><a:pt x="l" y="b"/></a:moveTo><a:arcTo wR="r" hR="h" stAng="10800000" swAng="10800000"/><a:close/></a:path></a:pathLst></a:custGeom>"#;
        let s = custom_shape(xml);
        let o = outline(&s, 100.0, 50.0).unwrap();
        let p = pos(&o);
        // From the bottom left over the top centre to the bottom right.
        assert!(
            p.iter()
                .any(|q| (q.0 - 50.0).abs() < 1e-2 && q.1.abs() < 1e-2),
            "{p:?}"
        );
        assert!(
            p.iter()
                .any(|q| (q.0 - 100.0).abs() < 1e-2 && (q.1 - 50.0).abs() < 1e-2),
            "{p:?}"
        );
        assert_eq!(o.open, vec![false]);
    }
}
