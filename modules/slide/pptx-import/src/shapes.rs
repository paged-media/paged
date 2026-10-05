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

//! Shape trees: `p:spTree` and everything in it.

use pptx_core::{
    Blip, CustomGeometry, FrameContent, GeomPath, Geometry, GraphicFrame, Group, Hyperlink,
    NvProps, PathCmd, Pic, Placeholder, Shape, ShapeProps, ShapeStyle, Sp, StyleRef, Table,
    TableCell, TableRow, Xfrm,
};

use crate::paint::{color_in, effects, fill_in, line};
use crate::text::text_body;
use crate::xml::{alternate, El, Ns};
use crate::Ctx;

/// Every item of a shape tree (`p:spTree` / `p:grpSp`), in paint order.
pub fn shape_tree(el: &El, ctx: &Ctx) -> Vec<Shape> {
    let mut out = Vec::new();
    for c in &el.children {
        if let Some(s) = shape(c, ctx) {
            out.push(s);
        }
    }
    out
}

fn shape(el: &El, ctx: &Ctx) -> Option<Shape> {
    if el.is(Ns::Mc, "AlternateContent") {
        // The Choice needs a newer reader (p14 / a14 content); the Fallback is
        // the rendering PowerPoint itself writes for readers without it.
        let (choice, fallback) = alternate(el);
        let pick = fallback.or(choice)?;
        return pick.children.iter().find_map(|c| shape(c, ctx));
    }
    if el.ns != Ns::P {
        return None;
    }
    Some(match el.local.as_str() {
        "sp" => Shape::Sp(sp(el, "nvSpPr", ctx)),
        "cxnSp" => Shape::Connector(sp(el, "nvCxnSpPr", ctx)),
        "pic" => Shape::Pic(pic(el, ctx)),
        "grpSp" => Shape::Group(Group {
            nv: el
                .child(Ns::P, "nvGrpSpPr")
                .map(|n| nv_props(n, ctx))
                .unwrap_or_default(),
            props: el
                .child(Ns::P, "grpSpPr")
                .map(|p| shape_props(p, ctx))
                .unwrap_or_default(),
            children: shape_tree(el, ctx),
        }),
        "graphicFrame" => Shape::Frame(graphic_frame(el, ctx)),
        "nvGrpSpPr" | "grpSpPr" | "extLst" => return None,
        other => {
            ctx.note(format!("shape p:{other} is not modelled"));
            Shape::Unknown {
                name: other.to_string(),
                xfrm: el.child(Ns::P, "xfrm").map(xfrm),
            }
        }
    })
}

fn sp(el: &El, nv_name: &str, ctx: &Ctx) -> Sp {
    Sp {
        nv: el
            .child(Ns::P, nv_name)
            .map(|n| nv_props(n, ctx))
            .unwrap_or_default(),
        props: el
            .child(Ns::P, "spPr")
            .map(|p| shape_props(p, ctx))
            .unwrap_or_default(),
        style: el.child(Ns::P, "style").map(shape_style),
        text: el.child(Ns::P, "txBody").map(|t| text_body(t, ctx)),
        use_bg_fill: el.attr_bool("useBgFill").unwrap_or(false),
    }
}

/// `p:nvSpPr` / `p:nvPicPr` / … : `p:cNvPr` + `p:nvPr/p:ph`.
fn nv_props(el: &El, ctx: &Ctx) -> NvProps {
    let c = el.child(Ns::P, "cNvPr");
    let ph = el.path(&[(Ns::P, "nvPr"), (Ns::P, "ph")]);
    NvProps {
        id: c.and_then(|c| c.attr_u32("id")).unwrap_or(0),
        name: c.and_then(|c| c.attr("name")).unwrap_or("").to_string(),
        descr: c.and_then(|c| c.attr("descr")).map(str::to_string),
        hidden: c.and_then(|c| c.attr_bool("hidden")).unwrap_or(false),
        placeholder: ph.map(|p| Placeholder {
            kind: p.attr("type").map(str::to_string),
            idx: p.attr_u32("idx"),
            orient: p.attr("orient").map(str::to_string),
            size: p.attr("sz").map(str::to_string),
        }),
        hyperlink: c
            .and_then(|c| c.child(Ns::A, "hlinkClick"))
            .map(|h| hyperlink(h, ctx)),
    }
}

/// `a:hlinkClick`: the relationship resolved to a URL or a part.
pub fn hyperlink(el: &El, ctx: &Ctx) -> Hyperlink {
    let mut h = Hyperlink {
        action: el.attr("action").map(str::to_string),
        tooltip: el.attr("tooltip").map(str::to_string),
        ..Default::default()
    };
    if let Some(id) = el.attr_ns(Ns::R, "id").filter(|id| !id.is_empty()) {
        if let Some(rel) = ctx.rels.by_id(id) {
            if rel.target_mode.as_deref() == Some("External") {
                h.url = Some(rel.target.clone());
            } else {
                h.target_part = Some(ctx.resolve(&rel.target));
            }
        }
    }
    h
}

/// `a:xfrm` / `p:xfrm`.
pub fn xfrm(el: &El) -> Xfrm {
    let pair = |name: &str, a: &str, b: &str| {
        el.child(Ns::A, name)
            .map(|e| (e.attr_i64(a).unwrap_or(0), e.attr_i64(b).unwrap_or(0)))
    };
    Xfrm {
        off: pair("off", "x", "y").unwrap_or((0, 0)),
        ext: pair("ext", "cx", "cy").unwrap_or((0, 0)),
        rot: el.attr_i32("rot").unwrap_or(0),
        flip_h: el.attr_bool("flipH").unwrap_or(false),
        flip_v: el.attr_bool("flipV").unwrap_or(false),
        ch_off: pair("chOff", "x", "y"),
        ch_ext: pair("chExt", "cx", "cy"),
    }
}

/// `p:spPr` / `p:grpSpPr`.
pub fn shape_props(el: &El, ctx: &Ctx) -> ShapeProps {
    ShapeProps {
        xfrm: el.child(Ns::A, "xfrm").map(xfrm),
        geometry: if let Some(p) = el.child(Ns::A, "prstGeom") {
            Some(Geometry::Preset {
                name: p.attr("prst").unwrap_or("rect").to_string(),
                adjust: guides(p.child(Ns::A, "avLst")),
            })
        } else {
            el.child(Ns::A, "custGeom")
                .map(|c| Geometry::Custom(custom_geometry(c)))
        },
        fill: fill_in(el, ctx),
        line: el.child(Ns::A, "ln").map(|l| line(l, ctx)),
        effects: el.child(Ns::A, "effectLst").map(|e| effects(e, ctx)),
    }
}

fn guides(el: Option<&El>) -> Vec<(String, String)> {
    el.map(|l| {
        l.children_named(Ns::A, "gd")
            .map(|g| {
                (
                    g.attr("name").unwrap_or("").to_string(),
                    g.attr("fmla").unwrap_or("").to_string(),
                )
            })
            .collect()
    })
    .unwrap_or_default()
}

/// `a:custGeom` (and, with the same elements, a preset definition from
/// `presetShapeDefinitions.xml`).
pub fn custom_geometry(el: &El) -> CustomGeometry {
    let pt = |p: &El| {
        (
            p.attr("x").unwrap_or("0").to_string(),
            p.attr("y").unwrap_or("0").to_string(),
        )
    };
    let pts = |c: &El| -> Vec<(String, String)> { c.children_named(Ns::A, "pt").map(pt).collect() };
    let paths = el
        .child(Ns::A, "pathLst")
        .map(|l| {
            l.children_named(Ns::A, "path")
                .map(|p| GeomPath {
                    w: p.attr_i64("w"),
                    h: p.attr_i64("h"),
                    fill: p.attr("fill").map(str::to_string),
                    stroke: p.attr_bool("stroke").unwrap_or(true),
                    commands: p
                        .children
                        .iter()
                        .filter_map(|c| {
                            let ps = pts(c);
                            Some(match c.local.as_str() {
                                "moveTo" => {
                                    let (x, y) = ps.first()?.clone();
                                    PathCmd::MoveTo(x, y)
                                }
                                "lnTo" => {
                                    let (x, y) = ps.first()?.clone();
                                    PathCmd::LineTo(x, y)
                                }
                                "arcTo" => PathCmd::ArcTo(
                                    c.attr("wR").unwrap_or("0").to_string(),
                                    c.attr("hR").unwrap_or("0").to_string(),
                                    c.attr("stAng").unwrap_or("0").to_string(),
                                    c.attr("swAng").unwrap_or("0").to_string(),
                                ),
                                "quadBezTo" if ps.len() >= 2 => {
                                    PathCmd::QuadTo([ps[0].clone(), ps[1].clone()])
                                }
                                "cubicBezTo" if ps.len() >= 3 => {
                                    PathCmd::CubicTo([ps[0].clone(), ps[1].clone(), ps[2].clone()])
                                }
                                "close" => PathCmd::Close,
                                _ => return None,
                            })
                        })
                        .collect(),
                })
                .collect()
        })
        .unwrap_or_default();
    CustomGeometry {
        adjust: guides(el.child(Ns::A, "avLst")),
        guides: guides(el.child(Ns::A, "gdLst")),
        paths,
    }
}

fn shape_style(el: &El) -> ShapeStyle {
    let r = |name: &str| {
        el.child(Ns::A, name).map(|e| StyleRef {
            idx: e.attr_u32("idx").unwrap_or(0),
            color: color_in(e),
        })
    };
    ShapeStyle {
        line_ref: r("lnRef"),
        fill_ref: r("fillRef"),
        effect_ref: r("effectRef"),
        font_ref: el
            .child(Ns::A, "fontRef")
            .map(|f| (f.attr("idx").unwrap_or("none").to_string(), color_in(f))),
    }
}

/// `a:blipFill` / `p:blipFill`.
pub fn blip(el: &El, ctx: &Ctx) -> Blip {
    let b = el.child(Ns::A, "blip");
    let rel = |attr: &str| {
        b.and_then(|b| b.attr_ns(Ns::R, attr))
            .and_then(|id| ctx.rels.by_id(id))
    };
    Blip {
        part: rel("embed").map(|r| ctx.resolve(&r.target)),
        link: rel("link").map(|r| r.target.clone()),
        src_rect: el.child(Ns::A, "srcRect").map(crate::paint::rect_attrs),
        stretch: el.child(Ns::A, "tile").is_none(),
        alpha: b
            .and_then(|b| b.child(Ns::A, "alphaModFix"))
            .and_then(|a| a.attr_i32("amt")),
    }
}

fn pic(el: &El, ctx: &Ctx) -> Pic {
    Pic {
        nv: el
            .child(Ns::P, "nvPicPr")
            .map(|n| nv_props(n, ctx))
            .unwrap_or_default(),
        props: el
            .child(Ns::P, "spPr")
            .map(|p| shape_props(p, ctx))
            .unwrap_or_default(),
        style: el.child(Ns::P, "style").map(shape_style),
        blip: el
            .child(Ns::P, "blipFill")
            .map(|b| blip(b, ctx))
            .unwrap_or_default(),
    }
}

fn graphic_frame(el: &El, ctx: &Ctx) -> GraphicFrame {
    let nv = el
        .child(Ns::P, "nvGraphicFramePr")
        .map(|n| nv_props(n, ctx))
        .unwrap_or_default();
    let data = el.path(&[(Ns::A, "graphic"), (Ns::A, "graphicData")]);
    let uri = data.and_then(|d| d.attr("uri")).unwrap_or("").to_string();
    let content = match data {
        Some(d) if d.child(Ns::A, "tbl").is_some() => {
            FrameContent::Table(table(d.child(Ns::A, "tbl").unwrap(), ctx))
        }
        Some(d) if uri.ends_with("/chart") => FrameContent::Chart {
            part: d
                .children
                .iter()
                .find(|c| c.local == "chart")
                .and_then(|c| c.attr_ns(Ns::R, "id"))
                .and_then(|id| ctx.rels.by_id(id))
                .map(|r| ctx.resolve(&r.target)),
        },
        Some(d) if uri.ends_with("/diagram") => {
            let rel_ids = d.children.iter().find(|c| c.local == "relIds");
            let data_part = rel_ids
                .and_then(|r| r.attr_ns(Ns::R, "dm"))
                .and_then(|id| ctx.rels.by_id(id))
                .map(|r| ctx.resolve(&r.target));
            // The drawing fallback is linked from the data part's own rels;
            // the slide's rels also carry it as a diagramDrawing relationship.
            let drawing_part = ctx
                .rels
                .items
                .iter()
                .find(|r| r.rel_type.ends_with("/diagramDrawing"))
                .map(|r| ctx.resolve(&r.target));
            FrameContent::Diagram {
                data_part,
                drawing_part,
            }
        }
        _ => {
            ctx.note(format!("graphic frame {uri:?} is not modelled"));
            FrameContent::Other { uri }
        }
    };
    GraphicFrame {
        nv,
        xfrm: el.child(Ns::P, "xfrm").map(xfrm),
        content,
    }
}

fn table(el: &El, ctx: &Ctx) -> Table {
    let pr = el.child(Ns::A, "tblPr");
    let flag = |name: &str| pr.and_then(|p| p.attr_bool(name)).unwrap_or(false);
    Table {
        columns: el
            .child(Ns::A, "tblGrid")
            .map(|g| {
                g.children_named(Ns::A, "gridCol")
                    .map(|c| c.attr_i64("w").unwrap_or(0))
                    .collect()
            })
            .unwrap_or_default(),
        rows: el
            .children_named(Ns::A, "tr")
            .map(|tr| TableRow {
                height: tr.attr_i64("h").unwrap_or(0),
                cells: tr
                    .children_named(Ns::A, "tc")
                    .map(|tc| cell(tc, ctx))
                    .collect(),
            })
            .collect(),
        style_id: pr
            .and_then(|p| p.child(Ns::A, "tableStyleId"))
            .map(|s| s.text.trim().to_string()),
        first_row: flag("firstRow"),
        first_col: flag("firstCol"),
        last_row: flag("lastRow"),
        last_col: flag("lastCol"),
        band_row: flag("bandRow"),
        band_col: flag("bandCol"),
    }
}

fn cell(el: &El, ctx: &Ctx) -> TableCell {
    let pr = el.child(Ns::A, "tcPr");
    let border = |name: &str| pr.and_then(|p| p.child(Ns::A, name)).map(|l| line(l, ctx));
    TableCell {
        text: el.child(Ns::A, "txBody").map(|t| text_body(t, ctx)),
        grid_span: el.attr_u32("gridSpan").unwrap_or(1),
        row_span: el.attr_u32("rowSpan").unwrap_or(1),
        h_merge: el.attr_bool("hMerge").unwrap_or(false),
        v_merge: el.attr_bool("vMerge").unwrap_or(false),
        fill: pr.and_then(|p| fill_in(p, ctx)),
        borders: [border("lnL"), border("lnR"), border("lnT"), border("lnB")],
        margins: (
            pr.and_then(|p| p.attr_i64("marL")),
            pr.and_then(|p| p.attr_i64("marR")),
            pr.and_then(|p| p.attr_i64("marT")),
            pr.and_then(|p| p.attr_i64("marB")),
        ),
        anchor: pr.and_then(|p| p.attr("anchor")).map(str::to_string),
    }
}
