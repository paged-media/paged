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

//! Text bodies: `a:bodyPr`, `a:lstStyle`, paragraphs and runs.

use pptx_core::{
    Autofit, BodyProps, Bullet, BulletColor, BulletSize, ListStyle, Paragraph, ParagraphProps, Run,
    RunKind, RunProps, Spacing, TextBody,
};

use crate::paint::{color_in, fill_in};
use crate::xml::{El, Ns};
use crate::Ctx;

/// `p:txBody` / `a:txBody`.
pub fn text_body(el: &El, ctx: &Ctx) -> TextBody {
    TextBody {
        body: el
            .child(Ns::A, "bodyPr")
            .map(body_props)
            .unwrap_or_default(),
        list_style: el.child(Ns::A, "lstStyle").map(|l| list_style(l, ctx)),
        paragraphs: el
            .children_named(Ns::A, "p")
            .map(|p| paragraph(p, ctx))
            .collect(),
    }
}

fn body_props(el: &El) -> BodyProps {
    let autofit = if el.child(Ns::A, "noAutofit").is_some() {
        Some(Autofit::None)
    } else if let Some(n) = el.child(Ns::A, "normAutofit") {
        Some(Autofit::Normal {
            font_scale: n.attr_i32("fontScale"),
            line_spacing_reduction: n.attr_i32("lnSpcReduction"),
        })
    } else if el.child(Ns::A, "spAutoFit").is_some() {
        Some(Autofit::Shape)
    } else {
        None
    };
    BodyProps {
        insets: (
            el.attr_i64("lIns"),
            el.attr_i64("tIns"),
            el.attr_i64("rIns"),
            el.attr_i64("bIns"),
        ),
        anchor: el.attr("anchor").map(str::to_string),
        anchor_center: el.attr_bool("anchorCtr"),
        wrap: el.attr("wrap").map(|w| w != "none"),
        vert: el.attr("vert").map(str::to_string),
        rot: el.attr_i32("rot"),
        columns: el.attr_u32("numCol"),
        column_spacing: el.attr_i64("spcCol"),
        autofit,
    }
}

/// `a:lstStyle`, `p:titleStyle`, `p:bodyStyle`, `p:otherStyle`, `p:defaultTextStyle`.
pub fn list_style(el: &El, ctx: &Ctx) -> ListStyle {
    let mut ls = ListStyle {
        default: el.child(Ns::A, "defPPr").map(|p| paragraph_props(p, ctx)),
        ..Default::default()
    };
    for (i, slot) in ls.levels.iter_mut().enumerate() {
        let name = format!("lvl{}pPr", i + 1);
        *slot = el.child(Ns::A, &name).map(|p| paragraph_props(p, ctx));
    }
    ls
}

fn spacing(el: Option<&El>) -> Option<Spacing> {
    let el = el?;
    if let Some(p) = el.child(Ns::A, "spcPct") {
        return p.attr_i32("val").map(Spacing::Percent);
    }
    if let Some(p) = el.child(Ns::A, "spcPts") {
        return p.attr_i32("val").map(Spacing::Points);
    }
    None
}

/// `a:pPr` / `a:lvlNpPr`.
pub fn paragraph_props(el: &El, ctx: &Ctx) -> ParagraphProps {
    let bullet = if el.child(Ns::A, "buNone").is_some() {
        Some(Bullet::None)
    } else if let Some(c) = el.child(Ns::A, "buChar") {
        Some(Bullet::Char(c.attr("char").unwrap_or("•").to_string()))
    } else if let Some(a) = el.child(Ns::A, "buAutoNum") {
        Some(Bullet::AutoNumber {
            scheme: a.attr("type").unwrap_or("arabicPeriod").to_string(),
            start_at: a.attr_i32("startAt"),
        })
    } else if el.child(Ns::A, "buBlip").is_some() {
        Some(Bullet::Picture)
    } else {
        None
    };
    let bullet_color = if el.child(Ns::A, "buClrTx").is_some() {
        Some(BulletColor::FollowText)
    } else {
        el.child(Ns::A, "buClr")
            .and_then(color_in)
            .map(BulletColor::Color)
    };
    let bullet_size = if el.child(Ns::A, "buSzTx").is_some() {
        Some(BulletSize::FollowText)
    } else if let Some(p) = el.child(Ns::A, "buSzPct") {
        p.attr_i32("val").map(BulletSize::Percent)
    } else {
        el.child(Ns::A, "buSzPts")
            .and_then(|p| p.attr_i32("val"))
            .map(BulletSize::Points)
    };
    let bullet_font = if el.child(Ns::A, "buFontTx").is_some() {
        Some(None)
    } else {
        el.child(Ns::A, "buFont")
            .and_then(|f| f.attr("typeface"))
            .map(|t| Some(t.to_string()))
    };
    ParagraphProps {
        level: el.attr_u32("lvl").map(|l| l.min(8) as u8),
        margin_left: el.attr_i64("marL"),
        indent: el.attr_i64("indent"),
        align: el.attr("algn").map(str::to_string),
        line_spacing: spacing(el.child(Ns::A, "lnSpc")),
        space_before: spacing(el.child(Ns::A, "spcBef")),
        space_after: spacing(el.child(Ns::A, "spcAft")),
        bullet,
        bullet_color,
        bullet_size,
        bullet_font,
        default_run: el.child(Ns::A, "defRPr").map(|r| run_props(r, ctx)),
        tab_stops: el
            .child(Ns::A, "tabLst")
            .map(|t| {
                t.children_named(Ns::A, "tab")
                    .map(|tab| {
                        (
                            tab.attr_i64("pos").unwrap_or(0),
                            tab.attr("algn").unwrap_or("l").to_string(),
                        )
                    })
                    .collect()
            })
            .unwrap_or_default(),
        rtl: el.attr_bool("rtl"),
    }
}

/// `a:rPr` / `a:defRPr` / `a:endParaRPr`.
pub fn run_props(el: &El, ctx: &Ctx) -> RunProps {
    let font = |name: &str| {
        el.child(Ns::A, name)
            .and_then(|f| f.attr("typeface"))
            .map(str::to_string)
    };
    RunProps {
        size: el.attr_i32("sz"),
        bold: el.attr_bool("b"),
        italic: el.attr_bool("i"),
        underline: el.attr("u").map(str::to_string),
        strike: el.attr("strike").map(str::to_string),
        caps: el.attr("cap").map(str::to_string),
        spacing: el.attr_i32("spc"),
        baseline: el.attr_i32("baseline"),
        latin: font("latin"),
        east_asian: font("ea"),
        complex: font("cs"),
        fill: fill_in(el, ctx),
        highlight: el.child(Ns::A, "highlight").and_then(color_in),
        hyperlink: el
            .child(Ns::A, "hlinkClick")
            .map(|h| crate::shapes::hyperlink(h, ctx)),
        lang: el.attr("lang").map(str::to_string),
    }
}

fn paragraph(el: &El, ctx: &Ctx) -> Paragraph {
    let mut runs = Vec::new();
    for c in &el.children {
        if c.ns != Ns::A {
            continue;
        }
        let props = || {
            c.child(Ns::A, "rPr")
                .map(|r| run_props(r, ctx))
                .unwrap_or_default()
        };
        match c.local.as_str() {
            "r" => runs.push(Run {
                kind: RunKind::Text(
                    c.child(Ns::A, "t")
                        .map(|t| t.text.clone())
                        .unwrap_or_default(),
                ),
                props: props(),
            }),
            "br" => runs.push(Run {
                kind: RunKind::Break,
                props: props(),
            }),
            "fld" => runs.push(Run {
                kind: RunKind::Field {
                    kind: c.attr("type").map(str::to_string),
                    text: c
                        .child(Ns::A, "t")
                        .map(|t| t.text.clone())
                        .unwrap_or_default(),
                },
                props: props(),
            }),
            _ => {}
        }
    }
    Paragraph {
        props: el
            .child(Ns::A, "pPr")
            .map(|p| paragraph_props(p, ctx))
            .unwrap_or_default(),
        runs,
        end_props: el.child(Ns::A, "endParaRPr").map(|r| run_props(r, ctx)),
    }
}
