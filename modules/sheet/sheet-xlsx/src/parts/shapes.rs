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

//! Shapes of a sheet, read on demand: the `xdr:sp` and `xdr:cxnSp` anchors of
//! its drawing parts (sheet ADR 530).
//!
//! Nothing here is stored or rewritten: the drawing part round-trips
//! byte-identical (spec §10.2). The session asks for the shapes of a sheet
//! when it places it. A shape is read as authored: its anchor, its preset (or
//! custom) geometry with the adjust values, its flips and rotation, and its
//! fill, outline and effects through the shared DrawingML reader; the page
//! lowering evaluates the geometry (`dml-geom`) and maps the paint
//! (`dml-native`), the same two crates paged.slide lowers its shapes with.

use crate::parts::pictures::{anchor_of, PictureAnchor};
use crate::rels::{part_dir, resolve_target, REL_DRAWING};
use crate::xtree::XNode;
use crate::XlsxDocument;
use dml_geom::CustomGeometry;
use paged_ooxml::drawingml::{Fill, Line, ShapeProperties};
use paged_ooxml::tree::{El, Ns};
use sheet_core::SheetId;

/// The geometry a shape names.
#[derive(Clone, Debug, PartialEq)]
pub enum ShapeGeometry {
    /// `a:prstGeom` with its `a:avLst` as `(name, formula)`.
    Preset {
        name: String,
        adjust: Vec<(String, String)>,
    },
    /// `a:custGeom`.
    Custom(Box<CustomGeometry>),
}

/// One shape or connector of a sheet.
#[derive(Clone, Debug, PartialEq)]
pub struct SheetShape {
    /// A stable handle: `<drawing part>#<anchor index>`.
    pub id: String,
    pub name: String,
    pub anchor: PictureAnchor,
    /// An `xdr:cxnSp` (a line or connector), not an `xdr:sp`.
    pub connector: bool,
    pub geometry: ShapeGeometry,
    /// `a:xfrm` flips, rotation (60 000ths of a degree) and `a:ext` (EMU),
    /// when the shape states them.
    pub flip_h: bool,
    pub flip_v: bool,
    pub rot: i64,
    pub ext: Option<(i64, i64)>,
    /// Fill, outline and effects as authored, the style references
    /// (`xdr:style`) filled in for what the shape leaves out.
    pub props: ShapeProperties,
    /// The text of the shape's `xdr:txBody`, paragraphs joined by a newline.
    pub text: String,
    /// The outline has arrowheads (`a:headEnd` / `a:tailEnd`).
    pub arrowheads: bool,
}

/// `a:lnRef idx` to the width of the line style it names (EMU): the Office
/// theme's three line styles.
fn style_line_width(idx: i64) -> i64 {
    match idx {
        1 => 6_350,
        2 => 12_700,
        _ => 19_050,
    }
}

/// The `xdr:style` references fill in what `spPr` does not state: the fill
/// (`a:fillRef`) and the outline (`a:lnRef`). A reference of index 0 is none.
fn apply_style(props: &mut ShapeProperties, style: Option<&El>) {
    let Some(style) = style else {
        return;
    };
    if props.fill.is_none() {
        if let Some(f) = style.child(Ns::A, "fillRef") {
            if f.attr_i64("idx").unwrap_or(0) > 0 {
                props.fill = paged_ooxml::drawingml::color_in(f).map(Fill::Solid);
            }
        }
    }
    let ln = style.child(Ns::A, "lnRef");
    let idx = ln.and_then(|l| l.attr_i64("idx")).unwrap_or(0);
    let from_style = || -> Option<Fill> {
        (idx > 0)
            .then(|| paged_ooxml::drawingml::color_in(ln?))
            .flatten()
            .map(Fill::Solid)
    };
    match &mut props.line {
        None => {
            if let Some(fill) = from_style() {
                props.line = Some(Line {
                    width: Some(style_line_width(idx)),
                    fill: Some(fill),
                    ..Line::default()
                });
            }
        }
        Some(l) => {
            if l.fill.is_none() {
                l.fill = from_style();
            }
            if l.width.is_none() && idx > 0 {
                l.width = Some(style_line_width(idx));
            }
        }
    }
}

fn geometry_of(sp_pr: &El) -> Option<ShapeGeometry> {
    if let Some(p) = sp_pr.child(Ns::A, "prstGeom") {
        let adjust = p
            .child(Ns::A, "avLst")
            .map(|l| {
                l.children_named(Ns::A, "gd")
                    .filter_map(|g| {
                        Some((g.attr("name")?.to_string(), g.attr("fmla")?.to_string()))
                    })
                    .collect()
            })
            .unwrap_or_default();
        return Some(ShapeGeometry::Preset {
            name: p.attr("prst")?.to_string(),
            adjust,
        });
    }
    sp_pr
        .child(Ns::A, "custGeom")
        .map(|c| ShapeGeometry::Custom(Box::new(dml_geom::read::custom_geometry(c))))
}

fn text_of(body: Option<&El>) -> String {
    let Some(body) = body else {
        return String::new();
    };
    body.children_named(Ns::A, "p")
        .map(|p| {
            p.children
                .iter()
                .filter(|r| r.local == "r" || r.local == "fld")
                .filter_map(|r| r.child(Ns::A, "t").map(El::deep_text))
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("\n")
        .trim_matches('\n')
        .to_string()
}

impl XlsxDocument {
    /// Every shape and connector of a sheet's drawings, in anchor order.
    pub fn shapes_of(&self, sheet: SheetId) -> Vec<SheetShape> {
        let mut out = Vec::new();
        let Some(ws) = self.part_name_of(sheet) else {
            return out;
        };
        let Some(rels) = self.rels_of_part(ws) else {
            return out;
        };
        for rel in rels.all_of_type(REL_DRAWING) {
            let drawing = resolve_target(part_dir(ws), &rel.target);
            let Some(bytes) = self.part_bytes(&drawing) else {
                continue;
            };
            let (Ok(root), Ok(dml_root)) = (XNode::parse(&bytes), paged_ooxml::tree::parse(&bytes))
            else {
                continue;
            };
            for (i, a) in root.children.iter().enumerate() {
                let connector = a.child("cxnSp").is_some();
                if a.child("sp").is_none() && !connector {
                    continue;
                }
                let Some(anchor) = anchor_of(a) else {
                    continue;
                };
                let Some(el) = dml_root
                    .children
                    .get(i)
                    .filter(|el| el.local == a.local())
                    .and_then(|el| {
                        el.children
                            .iter()
                            .find(|c| c.local == "sp" || c.local == "cxnSp")
                    })
                else {
                    continue;
                };
                let Some(sp_pr) = el.children.iter().find(|c| c.local == "spPr") else {
                    continue;
                };
                let Some(geometry) = geometry_of(sp_pr) else {
                    continue;
                };
                let mut props = paged_ooxml::drawingml::shape_properties(sp_pr, &|_| None);
                apply_style(&mut props, el.children.iter().find(|c| c.local == "style"));
                let xfrm = sp_pr.child(Ns::A, "xfrm");
                let c_nv = el
                    .children
                    .iter()
                    .find(|c| c.local == "nvSpPr" || c.local == "nvCxnSpPr")
                    .and_then(|n| n.children.iter().find(|c| c.local == "cNvPr"));
                let arrowheads = props.line.as_ref().is_some_and(|l| {
                    [&l.head, &l.tail]
                        .iter()
                        .any(|e| e.as_ref().is_some_and(|e| e.kind != "none"))
                });
                out.push(SheetShape {
                    id: format!("{drawing}#{i}"),
                    name: c_nv
                        .and_then(|c| c.attr("name"))
                        .unwrap_or_default()
                        .to_string(),
                    anchor,
                    connector,
                    geometry,
                    flip_h: xfrm.and_then(|x| x.attr_bool("flipH")).unwrap_or(false),
                    flip_v: xfrm.and_then(|x| x.attr_bool("flipV")).unwrap_or(false),
                    rot: xfrm.and_then(|x| x.attr_i64("rot")).unwrap_or(0),
                    ext: xfrm
                        .and_then(|x| x.child(Ns::A, "ext"))
                        .and_then(|e| Some((e.attr_i64("cx")?, e.attr_i64("cy")?))),
                    props,
                    text: text_of(el.children.iter().find(|c| c.local == "txBody")),
                    arrowheads,
                });
            }
        }
        out
    }
}
