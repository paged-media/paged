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

//! Colours, fills, lines and effects (`a:` DrawingML paint).

use pptx_core::{Color, ColorBase, Effects, Fill, Gradient, Line, LineEnd, Shadow};

use crate::xml::{El, Ns};
use crate::Ctx;

const COLOR_TAGS: [&str; 6] = [
    "srgbClr",
    "schemeClr",
    "sysClr",
    "prstClr",
    "hslClr",
    "scrgbClr",
];

/// The first colour element among `el`'s children, if any.
pub fn color_in(el: &El) -> Option<Color> {
    el.children
        .iter()
        .find(|c| c.ns == Ns::A && COLOR_TAGS.contains(&c.local.as_str()))
        .and_then(color)
}

/// One colour element (`a:srgbClr`, `a:schemeClr`, …) with its transforms.
pub fn color(el: &El) -> Option<Color> {
    let base = match el.local.as_str() {
        "srgbClr" => ColorBase::Srgb(u32::from_str_radix(el.attr("val")?.trim(), 16).ok()?),
        "schemeClr" => ColorBase::Scheme(el.attr("val")?.to_string()),
        "sysClr" => ColorBase::System {
            name: el.attr("val")?.to_string(),
            last: el
                .attr("lastClr")
                .and_then(|v| u32::from_str_radix(v.trim(), 16).ok()),
        },
        "prstClr" => ColorBase::Preset(el.attr("val")?.to_string()),
        "hslClr" => ColorBase::Hsl(
            el.attr_i32("hue").unwrap_or(0),
            el.attr_i32("sat").unwrap_or(0),
            el.attr_i32("lum").unwrap_or(0),
        ),
        "scrgbClr" => ColorBase::ScRgb(
            el.attr_i32("r").unwrap_or(0),
            el.attr_i32("g").unwrap_or(0),
            el.attr_i32("b").unwrap_or(0),
        ),
        _ => return None,
    };
    let transforms = el
        .children
        .iter()
        .filter(|c| c.ns == Ns::A)
        .map(|c| (c.local.clone(), c.attr_i32("val").unwrap_or(0)))
        .collect();
    Some(Color { base, transforms })
}

/// The fill choice among `el`'s children (`a:noFill`, `a:solidFill`, …).
pub fn fill_in(el: &El, ctx: &Ctx) -> Option<Fill> {
    el.children.iter().find_map(|c| fill(c, ctx))
}

/// One fill element.
pub fn fill(el: &El, ctx: &Ctx) -> Option<Fill> {
    if el.ns != Ns::A {
        return None;
    }
    Some(match el.local.as_str() {
        "noFill" => Fill::None,
        "solidFill" => Fill::Solid(color_in(el)?),
        "gradFill" => Fill::Gradient(gradient(el)),
        "blipFill" => Fill::Blip(crate::shapes::blip(el, ctx)),
        "pattFill" => Fill::Pattern {
            preset: el.attr("prst").unwrap_or("pct5").to_string(),
            fg: el.child(Ns::A, "fgClr").and_then(color_in),
            bg: el.child(Ns::A, "bgClr").and_then(color_in),
        },
        "grpFill" => Fill::Group,
        _ => return None,
    })
}

fn gradient(el: &El) -> Gradient {
    let stops = el
        .child(Ns::A, "gsLst")
        .map(|l| {
            l.children_named(Ns::A, "gs")
                .filter_map(|gs| Some((gs.attr_i32("pos").unwrap_or(0), color_in(gs)?)))
                .collect()
        })
        .unwrap_or_default();
    let linear = el.child(Ns::A, "lin").map(|l| {
        (
            l.attr_i32("ang").unwrap_or(0),
            l.attr_bool("scaled").unwrap_or(false),
        )
    });
    let path = el.child(Ns::A, "path").map(|p| {
        (
            p.attr("path").unwrap_or("circle").to_string(),
            p.child(Ns::A, "fillToRect").map(rect_attrs),
        )
    });
    Gradient {
        stops,
        linear,
        path,
        rotate_with_shape: el.attr_bool("rotWithShape").unwrap_or(true),
    }
}

/// `l t r b` attributes in 1 000ths of a percent.
pub fn rect_attrs(el: &El) -> (i32, i32, i32, i32) {
    (
        el.attr_i32("l").unwrap_or(0),
        el.attr_i32("t").unwrap_or(0),
        el.attr_i32("r").unwrap_or(0),
        el.attr_i32("b").unwrap_or(0),
    )
}

/// `a:ln`.
pub fn line(el: &El, ctx: &Ctx) -> Line {
    let end = |name: &str| {
        el.child(Ns::A, name).map(|e| LineEnd {
            kind: e.attr("type").unwrap_or("none").to_string(),
            w: e.attr("w").map(str::to_string),
            len: e.attr("len").map(str::to_string),
        })
    };
    Line {
        width: el.attr_i64("w"),
        fill: fill_in(el, ctx),
        dash: el
            .child(Ns::A, "prstDash")
            .and_then(|d| d.attr("val"))
            .map(str::to_string),
        custom_dash: el
            .child(Ns::A, "custDash")
            .map(|c| {
                c.children_named(Ns::A, "ds")
                    .map(|ds| {
                        (
                            ds.attr_i32("d").unwrap_or(0),
                            ds.attr_i32("sp").unwrap_or(0),
                        )
                    })
                    .collect()
            })
            .unwrap_or_default(),
        cap: el.attr("cap").map(str::to_string),
        join: ["round", "bevel", "miter"]
            .iter()
            .find(|j| el.child(Ns::A, j).is_some())
            .map(|j| j.to_string()),
        compound: el.attr("cmpd").map(str::to_string),
        head: end("headEnd"),
        tail: end("tailEnd"),
    }
}

/// `a:effectLst` (the effects the engine can carry). Effects it cannot are
/// reported through `ctx`.
pub fn effects(el: &El, ctx: &Ctx) -> Effects {
    let shadow = |name: &str| {
        el.child(Ns::A, name).and_then(|s| {
            Some(Shadow {
                blur: s.attr_i64("blurRad").unwrap_or(0),
                dist: s.attr_i64("dist").unwrap_or(0),
                dir: s.attr_i32("dir").unwrap_or(0),
                color: color_in(s)?,
            })
        })
    };
    for c in &el.children {
        if !matches!(
            c.local.as_str(),
            "outerShdw" | "innerShdw" | "glow" | "softEdge"
        ) {
            ctx.note(format!("effect a:{} is not carried", c.local));
        }
    }
    Effects {
        outer_shadow: shadow("outerShdw"),
        inner_shadow: shadow("innerShdw"),
        glow: el
            .child(Ns::A, "glow")
            .and_then(|g| Some((g.attr_i64("rad").unwrap_or(0), color_in(g)?))),
        soft_edge: el.child(Ns::A, "softEdge").and_then(|s| s.attr_i64("rad")),
    }
}
