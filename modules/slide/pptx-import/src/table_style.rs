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

//! `ppt/tableStyles.xml` → [`TableStyle`]s.

use pptx_core::{StyleRef, TableBorders, TableStyle, TableStylePart};

use crate::paint::{color_in, fill_in, line};
use crate::xml::{El, Ns};
use crate::Ctx;

/// The part names a table style may define.
pub const PARTS: [&str; 13] = [
    "wholeTbl", "band1H", "band2H", "band1V", "band2V", "lastCol", "firstCol", "lastRow", "seCell",
    "swCell", "firstRow", "neCell", "nwCell",
];

/// `a:tblStyleLst`: its styles and its default style id.
pub fn table_style_list(el: &El, ctx: &Ctx) -> (Vec<TableStyle>, Option<String>) {
    let styles = el
        .children_named(Ns::A, "tblStyle")
        .map(|s| table_style(s, ctx))
        .collect();
    (styles, el.attr("def").map(str::to_string))
}

/// One `a:tblStyle`.
pub fn table_style(el: &El, ctx: &Ctx) -> TableStyle {
    let bg = el.child(Ns::A, "tblBg");
    TableStyle {
        id: el.attr("styleId").unwrap_or_default().to_string(),
        name: el.attr("styleName").unwrap_or_default().to_string(),
        background: bg
            .and_then(|b| b.child(Ns::A, "fill"))
            .and_then(|f| fill_in(f, ctx)),
        background_ref: bg.and_then(|b| b.child(Ns::A, "fillRef")).map(style_ref),
        parts: PARTS
            .iter()
            .filter_map(|name| {
                el.child(Ns::A, name)
                    .map(|p| (name.to_string(), part(p, ctx)))
            })
            .collect(),
    }
}

fn style_ref(el: &El) -> StyleRef {
    StyleRef {
        idx: el.attr_u32("idx").unwrap_or(0),
        color: color_in(el),
    }
}

fn on_off(v: Option<&str>) -> Option<bool> {
    match v {
        Some("on") => Some(true),
        Some("off") => Some(false),
        _ => None,
    }
}

fn part(el: &El, ctx: &Ctx) -> TableStylePart {
    let tx = el.child(Ns::A, "tcTxStyle");
    let tc = el.child(Ns::A, "tcStyle");
    let bdr = tc.and_then(|t| t.child(Ns::A, "tcBdr"));
    let edge = |name: &str| {
        bdr.and_then(|b| b.child(Ns::A, name))
            .and_then(|e| e.child(Ns::A, "ln"))
            .map(|l| line(l, ctx))
    };
    TableStylePart {
        bold: tx.and_then(|t| on_off(t.attr("b"))),
        italic: tx.and_then(|t| on_off(t.attr("i"))),
        color: tx.and_then(color_in),
        font_ref: tx
            .and_then(|t| t.child(Ns::A, "fontRef"))
            .and_then(|f| f.attr("idx"))
            .map(str::to_string),
        font: tx
            .and_then(|t| t.path(&[(Ns::A, "font"), (Ns::A, "latin")]))
            .and_then(|l| l.attr("typeface"))
            .map(str::to_string),
        fill: tc
            .and_then(|t| t.child(Ns::A, "fill"))
            .and_then(|f| fill_in(f, ctx)),
        fill_ref: tc.and_then(|t| t.child(Ns::A, "fillRef")).map(style_ref),
        borders: TableBorders {
            left: edge("left"),
            right: edge("right"),
            top: edge("top"),
            bottom: edge("bottom"),
            inside_h: edge("insideH"),
            inside_v: edge("insideV"),
        },
    }
}
