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

//! Reading a DrawingML geometry: an authored `a:custGeom`, and (with the
//! same elements) a preset's definition from `presetShapeDefinitions.xml`,
//! through the shared OOXML element tree (`paged_ooxml::tree`).

use paged_ooxml::tree::{El, Ns};

use crate::{AdjustHandle, ConnectionSite, CustomGeometry, GeomPath, HandleRef, PathCmd};

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

fn point(p: &El) -> (String, String) {
    (
        p.attr("x").unwrap_or("0").to_string(),
        p.attr("y").unwrap_or("0").to_string(),
    )
}

/// A handle coordinate: the adjust value it moves and its range.
fn handle_ref(el: &El, guide: &str, min: &str, max: &str) -> Option<HandleRef> {
    Some(HandleRef {
        guide: el.attr(guide)?.to_string(),
        min: el.attr(min).unwrap_or("-2147483647").to_string(),
        max: el.attr(max).unwrap_or("2147483647").to_string(),
    })
}

fn handles(el: Option<&El>) -> Vec<AdjustHandle> {
    let Some(l) = el else {
        return Vec::new();
    };
    l.children
        .iter()
        .filter_map(|h| {
            let pos = h.child(Ns::A, "pos").map(point)?;
            match h.local.as_str() {
                "ahXY" => Some(AdjustHandle::Xy {
                    x: handle_ref(h, "gdRefX", "minX", "maxX"),
                    y: handle_ref(h, "gdRefY", "minY", "maxY"),
                    pos,
                }),
                "ahPolar" => Some(AdjustHandle::Polar {
                    r: handle_ref(h, "gdRefR", "minR", "maxR"),
                    ang: handle_ref(h, "gdRefAng", "minAng", "maxAng"),
                    pos,
                }),
                _ => None,
            }
        })
        .collect()
}

fn connections(el: Option<&El>) -> Vec<ConnectionSite> {
    el.map(|l| {
        l.children_named(Ns::A, "cxn")
            .filter_map(|c| {
                Some(ConnectionSite {
                    ang: c.attr("ang").unwrap_or("0").to_string(),
                    pos: c.child(Ns::A, "pos").map(point)?,
                })
            })
            .collect()
    })
    .unwrap_or_default()
}

/// `a:custGeom` (and, with the same elements, a preset definition from
/// `presetShapeDefinitions.xml`).
pub fn custom_geometry(el: &El) -> CustomGeometry {
    let pts =
        |c: &El| -> Vec<(String, String)> { c.children_named(Ns::A, "pt").map(point).collect() };
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
        handles: handles(el.child(Ns::A, "ahLst")),
        connections: connections(el.child(Ns::A, "cxnLst")),
    }
}
