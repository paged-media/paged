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

//! SmartArt (doc ADR 629): a diagram's `dgm:relIds r:dm` names its data
//! part, whose `dsp:dataModelExt/@relId` names (among the document part's
//! relationships) the drawing Word saves of its last layout, a `dsp:drawing`
//! whose shape tree reads as PresentationML's (`paged_ooxml::tree` maps the
//! namespace onto it). Each `dsp:sp` is read as a Word shape is (ADR 627:
//! the outline, the transform, the look completed from `dsp:style`), with
//! its text and the box Word sets it in.

use docx_core::{DiagramParagraph, DiagramRun, DiagramShape, DiagramText, PictureLook, Shape};
use paged_ooxml::drawingml::{self, color_in, Fill};
use paged_ooxml::resolve_target;
use paged_ooxml::tree::{self, El, Ns};

use crate::objects::{complete_from_style, read_geometry};
use crate::ImageResolver;

/// The drawing part of the diagram whose data part `dm` names, and its
/// shapes; `None` when the diagram has no drawing (a file Word did not
/// lay out) or a part cannot be read.
pub(crate) fn read(images: &ImageResolver, dm: &str) -> Option<(String, Vec<DiagramShape>)> {
    let part = |rid: &str| {
        let rel = images.rels.by_id(rid)?;
        if rel
            .target_mode
            .as_deref()
            .is_some_and(|m| m.eq_ignore_ascii_case("External"))
        {
            return None;
        }
        let target = resolve_target(&images.base_dir, &rel.target);
        let root = tree::parse(images.package.part(&target)?).ok()?;
        Some((target, root))
    };
    let (_, data) = part(dm)?;
    let drawing_rid = find(&data, "dataModelExt")?.attr("relId")?.to_string();
    let (name, drawing) = part(&drawing_rid)?;
    let tree = drawing.children.iter().find(|c| c.local == "spTree")?;
    let mut shapes = Vec::new();
    walk(tree, Place::default(), &mut shapes);
    Some((name, shapes))
}

/// The first element named `local` in `el`'s subtree.
fn find<'a>(el: &'a El, local: &str) -> Option<&'a El> {
    if el.local == local {
        return Some(el);
    }
    el.children.iter().find_map(|c| find(c, local))
}

/// A group's mapping of its children's coordinates onto the diagram's box.
#[derive(Clone, Copy)]
struct Place {
    sx: f64,
    sy: f64,
    dx: f64,
    dy: f64,
}

impl Default for Place {
    fn default() -> Self {
        Place {
            sx: 1.0,
            sy: 1.0,
            dx: 0.0,
            dy: 0.0,
        }
    }
}

impl Place {
    fn point(&self, x: i64, y: i64) -> (i64, i64) {
        (
            (x as f64 * self.sx + self.dx).round() as i64,
            (y as f64 * self.sy + self.dy).round() as i64,
        )
    }

    fn size(&self, w: i64, h: i64) -> (i64, i64) {
        (
            (w as f64 * self.sx).round() as i64,
            (h as f64 * self.sy).round() as i64,
        )
    }
}

/// An `a:xfrm`'s offset and extent (and, for a group, its children's).
fn xfrm(x: &El) -> ((i64, i64), (i64, i64)) {
    let pair = |name: &str, a: &str, b: &str| {
        x.children
            .iter()
            .find(|c| c.local == name)
            .map(|c| (c.attr_i64(a).unwrap_or(0), c.attr_i64(b).unwrap_or(0)))
    };
    (
        pair("off", "x", "y").unwrap_or((0, 0)),
        pair("ext", "cx", "cy").unwrap_or((0, 0)),
    )
}

fn walk(tree: &El, place: Place, out: &mut Vec<DiagramShape>) {
    for el in &tree.children {
        match el.local.as_str() {
            "sp" => out.extend(shape(el, place)),
            "grpSp" => {
                let x = el
                    .children
                    .iter()
                    .find(|c| c.local == "grpSpPr")
                    .and_then(|g| g.children.iter().find(|c| c.local == "xfrm"));
                let inner = match x {
                    Some(x) => {
                        let ((ox, oy), (cx, cy)) = xfrm(x);
                        let ch = |name: &str, a: &str, b: &str| {
                            x.children
                                .iter()
                                .find(|c| c.local == name)
                                .map(|c| (c.attr_i64(a).unwrap_or(0), c.attr_i64(b).unwrap_or(0)))
                        };
                        let (chx, chy) = ch("chOff", "x", "y").unwrap_or((ox, oy));
                        let (chw, chh) = ch("chExt", "cx", "cy").unwrap_or((cx, cy));
                        let (sx, sy) = (
                            if chw > 0 { cx as f64 / chw as f64 } else { 1.0 },
                            if chh > 0 { cy as f64 / chh as f64 } else { 1.0 },
                        );
                        let (gx, gy) = place.point(ox, oy);
                        Place {
                            sx: place.sx * sx,
                            sy: place.sy * sy,
                            dx: gx as f64 - chx as f64 * place.sx * sx,
                            dy: gy as f64 - chy as f64 * place.sy * sy,
                        }
                    }
                    None => place,
                };
                walk(el, inner, out);
            }
            _ => {}
        }
    }
}

/// One `dsp:sp`.
fn shape(sp: &El, place: Place) -> Option<DiagramShape> {
    let sp_pr = sp.children.iter().find(|c| c.local == "spPr")?;
    let x = sp_pr.children.iter().find(|c| c.local == "xfrm")?;
    let ((ox, oy), (cx, cy)) = xfrm(x);
    let (x_emu, y_emu) = place.point(ox, oy);
    let (width_emu, height_emu) = place.size(cx, cy);
    let look = complete_from_style(drawingml::shape_properties(sp_pr, &|_: &str| None), sp);
    let line_ends = look
        .line
        .as_ref()
        .is_some_and(|l| l.head.is_some() || l.tail.is_some());
    let look = PictureLook {
        shape: look,
        blip: Default::default(),
    };
    let shape = Shape {
        width_emu,
        height_emu,
        float: None,
        geometry: read_geometry(sp_pr),
        rotation: x.attr_i32("rot").unwrap_or(0),
        flip_h: x.attr_bool("flipH").unwrap_or(false),
        flip_v: x.attr_bool("flipV").unwrap_or(false),
        look: Some(Box::new(look)).filter(|l| !l.is_plain()),
        line_ends,
    };
    let text = sp
        .children
        .iter()
        .find(|c| c.local == "txBody")
        .and_then(|body| {
            // The text's own box, or the shape's; it turns with the shape
            // and by its own `rot` (doc ADR 629, amendment).
            let (tx, ty, tw, th, turn) = match sp.children.iter().find(|c| c.local == "txXfrm") {
                Some(t) => {
                    let ((ox, oy), (cx, cy)) = xfrm(t);
                    let (x, y) = place.point(ox, oy);
                    let (w, h) = place.size(cx, cy);
                    (x, y, w, h, t.attr_i32("rot").unwrap_or(0))
                }
                None => (x_emu, y_emu, width_emu, height_emu, 0),
            };
            text(body, sp, (tx, ty, tw, th)).map(|mut t| {
                t.rotation = (shape.rotation + turn).rem_euclid(21_600_000);
                t
            })
        });
    Some(DiagramShape {
        x_emu,
        y_emu,
        shape,
        text,
    })
}

/// A `dsp:txBody`, with the shape style's font colour for runs that state
/// none; `None` when it holds no text.
fn text(body: &El, sp: &El, (x, y, w, h): (i64, i64, i64, i64)) -> Option<DiagramText> {
    let font_fill = sp
        .children
        .iter()
        .find(|c| c.local == "style")
        .and_then(|s| s.children.iter().find(|c| c.local == "fontRef"))
        .and_then(color_in)
        .map(Fill::Solid);
    let pr = body.child(Ns::A, "bodyPr");
    let inset = |name: &str, default: i64| pr.and_then(|p| p.attr_i64(name)).unwrap_or(default);
    let paragraphs: Vec<DiagramParagraph> = body
        .children_named(Ns::A, "p")
        .map(|p| {
            let ppr = p.child(Ns::A, "pPr");
            DiagramParagraph {
                align: ppr.and_then(|q| q.attr("algn")).map(str::to_string),
                line_pct: ppr
                    .and_then(|q| q.path(&[(Ns::A, "lnSpc"), (Ns::A, "spcPct")]))
                    .and_then(|s| s.attr_i32("val")),
                runs: p
                    .children
                    .iter()
                    .filter(|r| r.ns == Ns::A && (r.local == "r" || r.local == "fld"))
                    .map(|r| {
                        let rpr = r.child(Ns::A, "rPr");
                        DiagramRun {
                            text: r.child(Ns::A, "t").map(El::deep_text).unwrap_or_default(),
                            size: rpr.and_then(|q| q.attr_i32("sz")),
                            bold: rpr.and_then(|q| q.attr_bool("b")),
                            italic: rpr.and_then(|q| q.attr_bool("i")),
                            fill: rpr
                                .and_then(|q| drawingml::fill_in(q, &|_: &str| None))
                                .or_else(|| font_fill.clone()),
                            latin: rpr
                                .and_then(|q| q.child(Ns::A, "latin"))
                                .and_then(|l| l.attr("typeface"))
                                .map(str::to_string),
                        }
                    })
                    .collect(),
            }
        })
        .collect();
    if paragraphs
        .iter()
        .all(|p| p.runs.iter().all(|r| r.text.trim().is_empty()))
    {
        return None;
    }
    Some(DiagramText {
        x_emu: x,
        y_emu: y,
        width_emu: w,
        height_emu: h,
        insets_emu: [
            inset("lIns", 91_440),
            inset("tIns", 45_720),
            inset("rIns", 91_440),
            inset("bIns", 45_720),
        ],
        anchor: pr.and_then(|p| p.attr("anchor")).unwrap_or("t").to_string(),
        paragraphs,
        rotation: 0,
    })
}
