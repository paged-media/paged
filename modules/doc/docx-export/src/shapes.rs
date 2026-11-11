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

//! Engine ADR 1096 — a Word shape's geometry written back.
//!
//! The import maps a shape's `a:prstGeom` + `a:avLst` onto the engine's
//! preset (`AnchoredFrame::preset`, doc ADR 627's frame along the outline).
//! This module is the writer's half: given what the canvas holds for a shape
//! now ([`ShapeIn`]: its preset and its anchors), the shape's geometry
//! element in `wps:spPr` is replaced by
//!
//! - `a:prstGeom prst=… ` with its `a:avLst` from the preset, while the
//!   anchors are still what the preset draws (`paged_preset_geom::model::
//!   anchors_are`; a turned shape's anchors are turned back first, since the
//!   lowering turns them), or
//! - `a:custGeom` of the anchors (`dml_geom::place::cust_geom`), turned and
//!   flipped back into the shape's own box, otherwise (a path edited by
//!   hand).
//!
//! A shape the canvas holds as the import drew it is not written: its XML
//! stays byte for byte. A shape whose box changed size is refused with a
//! line in the ledger (its extent and position are not written yet), as is
//! one whose geometry element is not where the import read it.

use docx_core::{Block, DocxDocument, Shape, ShapeGeometry};
use docx_lower::ir::{LoweredBlock, LoweredDoc, LoweredShape};
use paged_model::live_shape::PresetShape;
use paged_model::PathAnchor;
use paged_ooxml::{OoxmlError, OpcPackage};
use quick_xml::events::Event;
use quick_xml::name::ResolveResult;
use quick_xml::NsReader;
use serde::{Deserialize, Serialize};

const NS_WP: &[u8] = b"http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing";
const NS_A: &[u8] = b"http://schemas.openxmlformats.org/drawingml/2006/main";
const NS_WPS: &[u8] = b"http://schemas.microsoft.com/office/word/2010/wordprocessingShape";

/// Two coordinates this close (pt) are the same.
const SAME: f32 = 1e-3;

/// One Word shape as the canvas holds it now: the drawing it was read from
/// (`docx_core::Shape::drawing`, the frame's entry in the skeleton's
/// `NativeBody::shapes`), its preset (`frameShapePreset`) and its outline
/// (`[x, y, left x, left y, right x, right y]` in the frame's own box).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShapeIn {
    pub drawing: u32,
    #[serde(default)]
    pub preset: Option<PresetShape>,
    pub anchors: Vec<[f32; 6]>,
    #[serde(default)]
    pub starts: Vec<usize>,
    #[serde(default)]
    pub open: Vec<bool>,
}

/// A Word shape's frame as the canvas holds it, by the frame's id (the
/// skeleton's `docx_shape<n>`, or `docx_shape<n>_0` for a shape with line
/// ends): the host's read-back, turned into a [`ShapeIn`] by the frame's
/// entry in `NativeBody::shapes`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShapeFrameIn {
    pub frame_id: String,
    #[serde(default)]
    pub preset: Option<PresetShape>,
    pub anchors: Vec<[f32; 6]>,
    #[serde(default)]
    pub starts: Vec<usize>,
    /// Which contours are open; empty when the host does not say (the
    /// lowering's flags are taken while the contours are the same).
    #[serde(default)]
    pub open: Vec<bool>,
}

impl ShapeFrameIn {
    /// The shape of `drawing` this frame holds.
    pub fn at(&self, drawing: u32) -> ShapeIn {
        ShapeIn {
            drawing,
            preset: self.preset.clone(),
            anchors: self.anchors.clone(),
            starts: self.starts.clone(),
            open: self.open.clone(),
        }
    }
}

/// What a changed shape is written as.
#[derive(Debug, Clone, PartialEq)]
enum Geometry {
    Preset(PresetShape),
    Custom(String),
}

/// The import's shape of drawing `ordinal`, in a body paragraph or a table
/// cell's.
fn model_shape(model: &DocxDocument, ordinal: u32) -> Option<&Shape> {
    let in_paragraph = |p: &'_ docx_core::Paragraph| -> bool {
        p.runs
            .iter()
            .flat_map(|r| r.shapes.iter())
            .any(|s| s.drawing == Some(ordinal))
    };
    let paragraphs = model
        .body
        .iter()
        .flat_map(|b| -> Vec<&docx_core::Paragraph> {
            match b {
                Block::Paragraph(p) => vec![p],
                Block::Table(t) => t
                    .rows
                    .iter()
                    .flat_map(|r| r.cells.iter().flat_map(|c| c.paragraphs.iter()))
                    .collect(),
            }
        });
    for p in paragraphs {
        if in_paragraph(p) {
            return p
                .runs
                .iter()
                .flat_map(|r| r.shapes.iter())
                .find(|s| s.drawing == Some(ordinal));
        }
    }
    None
}

/// The lowering's shape of drawing `ordinal` (what the canvas was given).
fn lowered_shape(lowered: &LoweredDoc, ordinal: u32) -> Option<&LoweredShape> {
    lowered.story.blocks.iter().find_map(|b| match b {
        LoweredBlock::Paragraph(p) => p.shapes.iter().find(|s| s.drawing == Some(ordinal)),
        LoweredBlock::Table(t) => t
            .cells
            .iter()
            .flat_map(|c| c.paragraphs.iter())
            .flat_map(|p| p.shapes.iter())
            .find(|s| s.drawing == Some(ordinal)),
    })
}

fn emu_to_pt(v: i64) -> f32 {
    v as f32 / 12_700.0
}

fn same_anchors(a: &[[f32; 6]], b: &[[f32; 6]]) -> bool {
    a.len() == b.len()
        && a.iter()
            .zip(b)
            .all(|(p, q)| p.iter().zip(q).all(|(x, y)| (x - y).abs() < SAME))
}

fn same_preset(a: Option<&PresetShape>, b: Option<&PresetShape>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(a), Some(b)) => {
            a.name == b.name
                && a.adjusts == b.adjusts
                && a.flip_h == b.flip_h
                && a.flip_v == b.flip_v
                && a.part == b.part
                && a.frame
                    .iter()
                    .zip(&b.frame)
                    .all(|(x, y)| (x - y).abs() < SAME)
        }
        _ => false,
    }
}

/// `anchors` mapped by `m`.
fn mapped(anchors: &[[f32; 6]], m: &dml_geom::place::Affine) -> Vec<[f32; 6]> {
    anchors
        .iter()
        .map(|a| {
            let mut out = *a;
            for i in 0..3 {
                let (x, y) =
                    dml_geom::place::apply(m, (f64::from(a[i * 2]), f64::from(a[i * 2 + 1])));
                out[i * 2] = x as f32;
                out[i * 2 + 1] = y as f32;
            }
            out
        })
        .collect()
}

/// The turn (and the flips, with `flips`) the lowering gave `shape`'s
/// outline in its `w` x `h` box, about the box's centre.
fn placement(shape: &Shape, w: f32, h: f32, flips: bool) -> dml_geom::place::Affine {
    use dml_geom::place::{mul, orient, translate};
    let (cx, cy) = (f64::from(w) / 2.0, f64::from(h) / 2.0);
    let m = orient(
        f64::from(shape.rotation) / 60_000.0,
        flips && shape.flip_h,
        flips && shape.flip_v,
    );
    mul(&translate(cx, cy), &mul(&m, &translate(-cx, -cy)))
}

fn model_anchors(anchors: &[[f32; 6]]) -> Vec<PathAnchor> {
    anchors
        .iter()
        .map(|a| PathAnchor {
            anchor: (a[0], a[1]),
            left: (a[2], a[3]),
            right: (a[4], a[5]),
        })
        .collect()
}

/// What `read` asks to write for `shape` (box `w` x `h` pt), `Ok(None)`
/// when the canvas holds it as the lowering gave it (`given`).
fn plan(
    shape: &Shape,
    given: &LoweredShape,
    read: &ShapeIn,
    w: f32,
    h: f32,
) -> Result<Option<Geometry>, String> {
    // The host reads a preset back only while it is live (a turned shape's
    // or a line's cut under its heads reads none): unread is unchanged.
    if same_anchors(&given.anchors, &read.anchors)
        && (read.preset.is_none() || same_preset(given.preset.as_ref(), read.preset.as_ref()))
    {
        return Ok(None);
    }
    if read.anchors.is_empty() {
        return Err("the shape has no outline".into());
    }
    if let Some(p) = &read.preset {
        if (p.frame[2] - w).abs() > SAME || (p.frame[3] - h).abs() > SAME {
            return Err("the shape was resized; its new size is not written yet".into());
        }
        // The lowering turns the outline about the box's centre; the
        // preset draws it upright (its flips are its own).
        let back = dml_geom::place::invert(&placement(shape, w, h, false))
            .ok_or("the shape's turn cannot be undone")?;
        let upright = mapped(&read.anchors, &back);
        let starts = if read.starts.is_empty() {
            vec![0]
        } else {
            read.starts.clone()
        };
        // Upright after the turn is undone, or upright as they stand (the
        // engine draws a preset it redrew upright).
        if paged_preset_geom::model::anchors_are(p, &model_anchors(&upright), &starts)
            || (shape.rotation != 0
                && paged_preset_geom::model::anchors_are(p, &model_anchors(&read.anchors), &starts))
        {
            return Ok(Some(Geometry::Preset(p.clone())));
        }
    }
    if !given.heads.is_empty() {
        // Its anchors stop under the heads, which Word draws again.
        return Err("a reshaped line with arrowheads is not written yet".into());
    }
    // Reshaped: the anchors in the shape's own box, before its flips and
    // turn (which `a:xfrm` keeps saying).
    let back = dml_geom::place::invert(&placement(shape, w, h, true))
        .ok_or("the shape's turn cannot be undone")?;
    let own = mapped(&read.anchors, &back);
    let mut starts = read.starts.clone();
    if starts.first() != Some(&0) {
        starts.insert(0, 0);
    }
    // A host that does not read the open flags back: the lowering's, while
    // the contours are the same.
    let open = if read.open.is_empty() && given.open.len() == starts.len() {
        &given.open
    } else {
        &read.open
    };
    let contours: Vec<dml_geom::place::Contour> = starts
        .iter()
        .enumerate()
        .map(|(k, &s)| {
            let e = starts
                .get(k + 1)
                .copied()
                .unwrap_or(own.len())
                .min(own.len());
            let pts = own[s.min(e)..e]
                .iter()
                .map(|a| {
                    let p = |i: usize| (f64::from(a[i * 2]), f64::from(a[i * 2 + 1]));
                    [p(0), p(1), p(2)]
                })
                .collect();
            (pts, !open.get(k).copied().unwrap_or(false))
        })
        .collect();
    Ok(Some(Geometry::Custom(dml_geom::place::cust_geom(
        &contours,
        f64::from(w),
        f64::from(h),
    ))))
}

/// `a:prstGeom` for `p`, with its adjust values.
fn prst_geom(p: &PresetShape) -> String {
    use quick_xml::escape::escape;
    let mut av = String::new();
    for (name, fmla) in &p.adjusts {
        av.push_str(&format!(
            r#"<a:gd name="{}" fmla="{}"/>"#,
            escape(name.as_str()),
            escape(fmla.as_str())
        ));
    }
    let av = if av.is_empty() {
        "<a:avLst/>".to_string()
    } else {
        format!("<a:avLst>{av}</a:avLst>")
    };
    format!(
        r#"<a:prstGeom prst="{}">{av}</a:prstGeom>"#,
        escape(p.name.as_str())
    )
}

/// Where a drawing's shape keeps its geometry in the part.
#[derive(Debug, Clone, Default)]
struct GeomAt {
    /// The geometry element's byte range and local name.
    range: Option<(usize, usize)>,
    local: String,
    /// It is written with the `a:` prefix (the writers above write that).
    a_prefix: bool,
}

/// Every top-level `wp:inline` / `wp:anchor` of `part` in document order
/// (the import's drawings), each with where its `wps:wsp`'s geometry is.
fn scan(part: &[u8]) -> Vec<GeomAt> {
    let mut reader = NsReader::from_reader(part);
    reader.config_mut().trim_text(false);
    let mut out: Vec<GeomAt> = Vec::new();
    // The element path inside the current drawing (local names, with the
    // namespace matched where it matters); empty outside one.
    let mut path: Vec<(Vec<u8>, String)> = Vec::new();
    let mut inside = false;
    let mut geom_start: Option<usize> = None;
    let mut buf = Vec::new();
    loop {
        let before = reader.buffer_position() as usize;
        let ev = match reader.read_event_into(&mut buf) {
            Ok(e) => e,
            Err(_) => break,
        };
        let after = reader.buffer_position() as usize;
        match &ev {
            Event::Start(e) | Event::Empty(e) => {
                let empty = matches!(ev, Event::Empty(_));
                let (res, local) = reader.resolver().resolve_element(e.name());
                let uri = match res {
                    ResolveResult::Bound(n) => n.as_ref().to_vec(),
                    _ => Vec::new(),
                };
                let local = String::from_utf8_lossy(local.as_ref()).to_string();
                if !inside {
                    if uri == NS_WP && (local == "inline" || local == "anchor") {
                        out.push(GeomAt::default());
                        inside = !empty;
                        path.clear();
                    }
                } else {
                    // wp:anchor > a:graphic > a:graphicData > wps:wsp >
                    // wps:spPr > a:prstGeom | a:custGeom
                    let at_geom = path.len() == 4
                        && path[2].0 == NS_WPS
                        && path[2].1 == "wsp"
                        && path[3].0 == NS_WPS
                        && path[3].1 == "spPr"
                        && uri == NS_A
                        && (local == "prstGeom" || local == "custGeom");
                    if at_geom {
                        if let Some(cur) = out.last_mut() {
                            if cur.range.is_none() {
                                cur.local = local.clone();
                                cur.a_prefix = e.name().as_ref().starts_with(b"a:");
                                if empty {
                                    cur.range = Some((before, after));
                                } else {
                                    geom_start = Some(before);
                                }
                            }
                        }
                    }
                    if !empty {
                        path.push((uri, local));
                    }
                }
            }
            Event::End(_) => {
                if inside {
                    if path.is_empty() {
                        inside = false;
                    } else {
                        let (uri, local) = path.pop().unwrap_or_default();
                        if path.len() == 4
                            && uri == NS_A
                            && (local == "prstGeom" || local == "custGeom")
                        {
                            if let (Some(s), Some(cur)) = (geom_start.take(), out.last_mut()) {
                                if cur.range.is_none() {
                                    cur.range = Some((s, after));
                                }
                            }
                        }
                    }
                }
            }
            Event::Eof => break,
            _ => {}
        }
        buf.clear();
    }
    out
}

/// Write the shapes `read` changed back into `main_part` (see the module
/// documentation). Returns the refusal ledger.
pub fn save_shapes(
    pkg: &mut OpcPackage,
    main_part: &str,
    model: &DocxDocument,
    lowered: &LoweredDoc,
    read: &[ShapeIn],
) -> Result<Vec<String>, OoxmlError> {
    let mut skips = Vec::new();
    let mut edits: Vec<(u32, &'static str, Geometry)> = Vec::new();
    for r in read {
        let label = format!("drawing {}", r.drawing);
        let (Some(shape), Some(given)) = (
            model_shape(model, r.drawing),
            lowered_shape(lowered, r.drawing),
        ) else {
            skips.push(format!(
                "{label}: shape edit refused: not found in the import"
            ));
            continue;
        };
        let (w, h) = (emu_to_pt(shape.width_emu), emu_to_pt(shape.height_emu));
        match plan(shape, given, r, w, h) {
            Ok(None) => {}
            Ok(Some(g)) => {
                let was = match shape.geometry {
                    ShapeGeometry::Preset { .. } => "prstGeom",
                    ShapeGeometry::Custom(_) => "custGeom",
                };
                edits.push((r.drawing, was, g));
            }
            Err(why) => skips.push(format!("{label}: shape edit refused: {why}")),
        }
    }
    if edits.is_empty() {
        return Ok(skips);
    }
    let bytes = pkg.require(main_part)?.to_vec();
    let at = scan(&bytes);
    let mut cuts: Vec<(usize, usize, String)> = Vec::new();
    for (ordinal, was, g) in edits {
        let label = format!("drawing {ordinal}");
        let Some(GeomAt {
            range: Some((s, e)),
            local,
            a_prefix,
        }) = at.get(ordinal as usize).cloned()
        else {
            skips.push(format!(
                "{label}: shape edit refused: its geometry is not where the import read it"
            ));
            continue;
        };
        if local != was || !a_prefix {
            skips.push(format!(
                "{label}: shape edit refused: its geometry is not what the import read"
            ));
            continue;
        }
        let xml = match g {
            Geometry::Preset(p) => prst_geom(&p),
            Geometry::Custom(c) => c,
        };
        cuts.push((s, e, xml));
    }
    if cuts.is_empty() {
        return Ok(skips);
    }
    cuts.sort_by_key(|c| c.0);
    let mut out = Vec::with_capacity(bytes.len());
    let mut pos = 0usize;
    for (s, e, xml) in cuts {
        out.extend_from_slice(&bytes[pos..s]);
        out.extend_from_slice(xml.as_bytes());
        pos = e;
    }
    out.extend_from_slice(&bytes[pos..]);
    pkg.set_part(main_part, out);
    Ok(skips)
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
            width_emu: 1_270_000,
            height_emu: 635_000,
            ..Shape::default()
        }
    }

    /// What the lowering gave the canvas for `s` (no line ends).
    fn given(s: &Shape) -> LoweredShape {
        let r = read_of(s);
        LoweredShape {
            anchors: r.anchors,
            starts: r.starts,
            open: r.open,
            preset: r.preset,
            ..LoweredShape::default()
        }
    }

    fn plan_of(s: &Shape, read: &ShapeIn) -> Result<Option<Geometry>, String> {
        plan(s, &given(s), read, 100.0, 50.0)
    }

    fn read_of(s: &Shape) -> ShapeIn {
        let o = docx_lower::shape_geom::outline(s, 100.0, 50.0).unwrap();
        ShapeIn {
            drawing: 0,
            preset: docx_lower::shape_geom::preset_of(s, 100.0, 50.0),
            anchors: o.anchors,
            starts: o.starts,
            open: o.open,
        }
    }

    #[test]
    fn an_unedited_shape_is_not_written() {
        let s = shape("roundRect", &[("adj", 20000)]);
        assert_eq!(plan_of(&s, &read_of(&s)), Ok(None));
        let mut turned = s.clone();
        turned.rotation = 30 * 60_000;
        assert_eq!(plan_of(&turned, &read_of(&turned)), Ok(None));
    }

    #[test]
    fn a_new_adjust_value_is_the_preset_and_a_reshaped_path_custom() {
        let s = shape("roundRect", &[("adj", 20000)]);
        let mut read = read_of(&s);
        // The engine's adjust write: the preset with its new value, drawn.
        let mut p = read.preset.clone().unwrap();
        p.adjusts = vec![("adj".into(), "val 40000".into())];
        let d = paged_preset_geom::model::draw(&p).unwrap();
        read.anchors = d
            .anchors
            .iter()
            .map(|a| {
                [
                    a.anchor.0, a.anchor.1, a.left.0, a.left.1, a.right.0, a.right.1,
                ]
            })
            .collect();
        read.preset = Some(p.clone());
        assert_eq!(plan_of(&s, &read), Ok(Some(Geometry::Preset(p.clone()))));
        assert_eq!(
            prst_geom(&p),
            r#"<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val 40000"/></a:avLst></a:prstGeom>"#
        );
        // A point moved by hand: the outline as custom geometry.
        read.anchors[0][0] += 5.0;
        read.anchors[0][2] += 5.0;
        read.anchors[0][4] += 5.0;
        match plan_of(&s, &read) {
            Ok(Some(Geometry::Custom(xml))) => {
                assert!(
                    xml.starts_with("<a:custGeom>") && xml.contains("<a:close/>"),
                    "{xml}"
                )
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_turned_shapes_adjust_is_still_its_preset() {
        let mut s = shape("triangle", &[("adj", 50000)]);
        s.rotation = 45 * 60_000;
        s.flip_h = true;
        let mut read = read_of(&s);
        let mut p = read.preset.clone().unwrap();
        p.adjusts = vec![("adj".into(), "val 10000".into())];
        // The canvas draws the preset, and the lowering's turn is the frame's.
        let d = paged_preset_geom::model::draw(&p).unwrap();
        let flat: Vec<[f32; 6]> = d
            .anchors
            .iter()
            .map(|a| {
                [
                    a.anchor.0, a.anchor.1, a.left.0, a.left.1, a.right.0, a.right.1,
                ]
            })
            .collect();
        read.anchors = mapped(&flat, &placement(&s, 100.0, 50.0, false));
        read.preset = Some(p.clone());
        assert_eq!(plan_of(&s, &read), Ok(Some(Geometry::Preset(p))));
    }

    /// The host reads a preset back only while it is live: a turned shape
    /// reads none and is still unchanged; a reshaped line read without its
    /// open flags stays open.
    #[test]
    fn an_unread_preset_and_unread_open_flags_take_the_lowerings() {
        let mut turned = shape("roundRect", &[]);
        turned.rotation = 30 * 60_000;
        let mut read = read_of(&turned);
        read.preset = None;
        read.open.clear();
        assert_eq!(plan_of(&turned, &read), Ok(None));
        let line = shape("line", &[]);
        let mut read = read_of(&line);
        read.preset = None;
        read.open.clear();
        read.anchors[1][1] += 7.0;
        match plan_of(&line, &read) {
            Ok(Some(Geometry::Custom(xml))) => assert!(!xml.contains("<a:close/>"), "{xml}"),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_resized_shape_is_refused() {
        let s = shape("rect", &[]);
        let mut read = read_of(&s);
        read.preset.as_mut().unwrap().frame[2] = 120.0;
        assert!(plan_of(&s, &read).unwrap_err().contains("resized"));
    }
}
