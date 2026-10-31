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

//! The theme part (slide ADR 713). The theme the document shows is read
//! from the document itself: each slot's swatch (`Color/accent1`, or the
//! swatch the deck's theme remaps it to), the fonts of the root paragraph
//! styles `Title` and `Body`, and the theme's name from the deck label. When
//! it is not the deck's own theme, every slide master's theme part is
//! written with its colour scheme, its Latin fonts and its name; the slides
//! keep their `a:schemeClr` colours and recolour in PowerPoint as they do
//! here. Everything else in the part (the format scheme) stays.

use std::collections::{BTreeMap, BTreeSet};

use paged_model::ColorSpace;
use paged_ooxml::OpcPackage;
use paged_scene::Document;
use serde_json::Value;
use slide_resolve::theme::{ThemeIr, SLOTS};

use crate::native::LABEL_KEY;

/// The deck label's `theme` (name, variant, remap), if any.
fn label_theme(doc: &Document) -> Value {
    doc.designmap
        .labels
        .iter()
        .find(|(k, _)| k == LABEL_KEY)
        .and_then(|(_, v)| serde_json::from_str::<Value>(v).ok())
        .and_then(|v| v.get("data")?.get("theme").cloned())
        .unwrap_or(Value::Null)
}

/// A swatch's sRGB, from an RGB or (naively) a CMYK colour.
fn swatch_rgb(doc: &Document, id: &str) -> Option<[u8; 3]> {
    let c = doc.palette.resolve(id)?;
    let q = |x: f32| x.round().clamp(0.0, 255.0) as u8;
    match c.space {
        ColorSpace::Rgb if c.value.len() >= 3 => {
            Some([q(c.value[0]), q(c.value[1]), q(c.value[2])])
        }
        ColorSpace::Cmyk if c.value.len() >= 4 => {
            let k = 1.0 - c.value[3] / 100.0;
            let ch = |v: f32| q(255.0 * (1.0 - v / 100.0) * k);
            Some([ch(c.value[0]), ch(c.value[1]), ch(c.value[2])])
        }
        _ => None,
    }
}

/// The theme the document shows, on the deck's own theme `deck`.
pub fn document_theme(doc: &Document, deck: &ThemeIr) -> ThemeIr {
    let label = label_theme(doc);
    let remap: BTreeMap<String, String> = label
        .get("remap")
        .and_then(|r| serde_json::from_value(r.clone()).ok())
        .unwrap_or_default();
    let target = |id: &str| remap.get(id).cloned().unwrap_or_else(|| id.to_string());
    let colors = SLOTS
        .iter()
        .map(|slot| {
            let hex = swatch_rgb(doc, &target(&format!("Color/{slot}")))
                .map(|c| format!("{:02X}{:02X}{:02X}", c[0], c[1], c[2]))
                .or_else(|| {
                    deck.colors
                        .iter()
                        .find(|(s, _)| s == slot)
                        .map(|(_, h)| h.clone())
                })
                .unwrap_or_else(|| "000000".into());
            (slot.to_string(), hex)
        })
        .collect();
    let font = |id: &str, or: &str| {
        doc.styles
            .paragraph_styles
            .get(&target(id))
            .and_then(|s| s.font.clone())
            .filter(|f| !f.is_empty())
            .unwrap_or_else(|| or.to_string())
    };
    ThemeIr {
        name: label
            .get("name")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| deck.name.clone()),
        colors,
        major: font(slide_native::TITLE_STYLE, &deck.major),
        minor: font(slide_native::BODY_STYLE, &deck.minor),
        variant: label
            .get("variant")
            .and_then(Value::as_str)
            .map(str::to_string),
    }
}

/// Whether two themes draw the same (colours and fonts; names aside).
fn same_look(a: &ThemeIr, b: &ThemeIr) -> bool {
    a.major == b.major && a.minor == b.minor && SLOTS.iter().all(|s| a.rgb(s) == b.rgb(s))
}

/// Write the slide masters' theme parts into `out` when the document's
/// theme is not the deck's. `primary` is the deck's first theme part.
pub fn write_themes(
    pkg: &OpcPackage,
    ir: &pptx_core::Presentation,
    doc: &Document,
    primary: Option<&str>,
    out: &mut BTreeMap<String, Vec<u8>>,
    diagnostics: &mut Vec<String>,
) {
    let Some(deck) = primary.and_then(|p| ir.theme(p)) else {
        return;
    };
    let deck = ThemeIr::of(deck);
    let now = document_theme(doc, &deck);
    if same_look(&now, &deck) && now.name == deck.name && now.variant.is_none() {
        return;
    }
    let parts: BTreeSet<&str> = ir
        .masters
        .iter()
        .filter_map(|m| m.theme_part.as_deref())
        .collect();
    for part in parts {
        let Some(xml) = pkg.part(part).and_then(|b| std::str::from_utf8(b).ok()) else {
            continue;
        };
        match slide_resolve::theme::rewrite_theme_xml(xml, &now) {
            Some(x) => {
                out.insert(part.to_string(), x.into_bytes());
            }
            None => diagnostics.push(format!(
                "{part}: the theme has no colour or font scheme to write; written as the deck had it"
            )),
        }
    }
}
