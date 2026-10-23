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

//! The workbook's document chart style (sheet ADR 525) in `workbook.xml`:
//! one paged extension at the end of the workbook's `<extLst>`, read at
//! open and spliced in place when it changes — the rest of the part stays
//! byte-identical (ADR 503).
//!
//! ```xml
//! <extLst><ext uri="{8E2A6C41-3B7D-4F09-A1C5-6D9E2B7F4A18}" xmlns:pg="urn:paged:sheet:chartstyle">
//!   <pg:chartStyle>
//!     <pg:role name="plotArea" swatch="Color/Paper|cmyk|F0EEE6"/>
//!     <pg:role name="legend" paragraph="ParagraphStyle/Caption" swatch="Color/Ink|lab|141414"/>
//!     <pg:palette group="ColorGroup/Brand">
//!       <pg:swatch ref="Color/A|cmyk|0A141E"/><pg:swatch ref="Color/B|spot|28323C"/>
//!     </pg:palette>
//!   </pg:chartStyle>
//! </ext></extLst>
//! ```
//!
//! A swatch is `id|model|RRGGBB` (its colour model and the sRGB a reader
//! without the document shows), as the cell references of ADR 518 write
//! it. Spreadsheet applications ignore an extension they do not know.

use std::collections::BTreeMap;

use crate::error::XlsxError;
use crate::splice::{children_of, escape_attr, prefix_of, root_children, splice};
use sheet_chart::style::{is_role, ChartStyle, RoleStyle, SeriesPalette};
use sheet_core::visual::{DocColorModel, DocSwatchRef};

/// The `ext` uri of the workbook chart style.
pub const CHART_STYLE_EXT_URI: &str = "{8E2A6C41-3B7D-4F09-A1C5-6D9E2B7F4A18}";
/// Its element namespace.
pub const CHART_STYLE_NS: &str = "urn:paged:sheet:chartstyle";

/// `id|model|RRGGBB`.
pub fn encode_swatch(s: &DocSwatchRef) -> String {
    let (r, g, b) = s.fallback_rgb;
    format!("{}|{}|{r:02X}{g:02X}{b:02X}", s.id, s.model.as_str())
}

/// The inverse of [`encode_swatch`] (an id may itself contain `|`).
pub fn decode_swatch(v: &str) -> Option<DocSwatchRef> {
    let mut it = v.rsplitn(3, '|');
    let rgb = it.next()?;
    let model = DocColorModel::parse(it.next()?)?;
    let id = it.next()?;
    if id.is_empty() || rgb.len() != 6 {
        return None;
    }
    let p = |i: usize| u8::from_str_radix(&rgb[i..i + 2], 16).ok();
    Some(DocSwatchRef {
        id: id.to_string(),
        model,
        fallback_rgb: (p(0)?, p(2)?, p(4)?),
    })
}

/// The chart style a `workbook.xml` carries (empty without the extension;
/// unknown roles and malformed references are skipped).
pub fn parse(workbook_xml: &[u8]) -> ChartStyle {
    let Ok(root) = paged_ooxml::tree::parse(workbook_xml) else {
        return ChartStyle::default();
    };
    let Some(style) = root
        .children
        .iter()
        .filter(|e| e.local == "extLst")
        .flat_map(|l| l.children.iter())
        .find(|e| e.local == "ext" && e.attr("uri") == Some(CHART_STYLE_EXT_URI))
        .and_then(|ext| ext.children.iter().find(|e| e.local == "chartStyle"))
    else {
        return ChartStyle::default();
    };
    let mut out = ChartStyle::default();
    for el in &style.children {
        match el.local.as_str() {
            "role" => {
                let Some(name) = el.attr("name").filter(|n| is_role(n)) else {
                    continue;
                };
                let r = RoleStyle {
                    swatch: el.attr("swatch").and_then(decode_swatch),
                    paragraph: el.attr("paragraph").map(str::to_string),
                    character: el.attr("character").map(str::to_string),
                };
                if !r.is_empty() {
                    out.roles.insert(name.to_string(), r);
                }
            }
            "palette" => {
                let Some(group) = el.attr("group") else {
                    continue;
                };
                out.palette = Some(SeriesPalette {
                    group: group.to_string(),
                    swatches: el
                        .children
                        .iter()
                        .filter(|s| s.local == "swatch")
                        .filter_map(|s| s.attr("ref").and_then(decode_swatch))
                        .collect(),
                });
            }
            _ => {}
        }
    }
    out
}

/// The extension element for `style` (with `prefix`, the workbook's main
/// namespace prefix, `""` or `x:`).
fn render(style: &ChartStyle, prefix: &str) -> String {
    let mut s = format!(
        r#"<{prefix}ext uri="{CHART_STYLE_EXT_URI}" xmlns:pg="{CHART_STYLE_NS}"><pg:chartStyle>"#
    );
    let roles: BTreeMap<_, _> = style.roles.iter().filter(|(_, r)| !r.is_empty()).collect();
    for (name, r) in roles {
        s.push_str(&format!(r#"<pg:role name="{}""#, escape_attr(name)));
        if let Some(sw) = &r.swatch {
            s.push_str(&format!(r#" swatch="{}""#, escape_attr(&encode_swatch(sw))));
        }
        if let Some(p) = &r.paragraph {
            s.push_str(&format!(r#" paragraph="{}""#, escape_attr(p)));
        }
        if let Some(c) = &r.character {
            s.push_str(&format!(r#" character="{}""#, escape_attr(c)));
        }
        s.push_str("/>");
    }
    if let Some(p) = &style.palette {
        s.push_str(&format!(
            r#"<pg:palette group="{}">"#,
            escape_attr(&p.group)
        ));
        for sw in &p.swatches {
            s.push_str(&format!(
                r#"<pg:swatch ref="{}"/>"#,
                escape_attr(&encode_swatch(sw))
            ));
        }
        s.push_str("</pg:palette>");
    }
    s.push_str(&format!("</pg:chartStyle></{prefix}ext>"));
    s
}

/// `workbook.xml` with its chart style set to `style` (an empty style takes
/// the extension out; the `<extLst>` it leaves empty goes too). Only the
/// extension's bytes change.
pub fn splice_into(workbook_xml: &[u8], style: &ChartStyle) -> Result<Vec<u8>, XlsxError> {
    let (kids, root_close) = root_children(workbook_xml)?;
    let prefix = kids.first().map_or("", |k| prefix_of(&k.qname)).to_string();
    let empty = style.is_empty();
    let Some(list) = kids.iter().find(|k| k.local == "extLst") else {
        if empty {
            return Ok(workbook_xml.to_vec());
        }
        let ext = render(style, &prefix);
        let block = format!("<{prefix}extLst>{ext}</{prefix}extLst>");
        return Ok(splice(
            workbook_xml,
            root_close,
            root_close,
            block.as_bytes(),
        ));
    };
    let (exts, list_close) = if list.empty {
        (Vec::new(), list.end)
    } else {
        children_of(workbook_xml, list)?
    };
    let mine = exts.iter().find(|e| {
        e.local == "ext"
            && crate::splice::attrs_of(workbook_xml, e)
                .ok()
                .and_then(|a| crate::splice::attr_local(&a, "uri"))
                .as_deref()
                == Some(CHART_STYLE_EXT_URI)
    });
    match (mine, empty) {
        (Some(_), true) if exts.len() == 1 => {
            // The extension was the list's only child: the list goes.
            Ok(splice(workbook_xml, list.start, list.end, b""))
        }
        (Some(m), true) => Ok(splice(workbook_xml, m.start, m.end, b"")),
        (Some(m), false) => {
            let ext = render(style, prefix_of(&m.qname));
            Ok(splice(workbook_xml, m.start, m.end, ext.as_bytes()))
        }
        (None, true) => Ok(workbook_xml.to_vec()),
        (None, false) => {
            let ext = render(style, prefix_of(&list.qname));
            if list.empty {
                let lp = prefix_of(&list.qname).to_string();
                let block = format!("<{lp}extLst>{ext}</{lp}extLst>");
                Ok(splice(workbook_xml, list.start, list.end, block.as_bytes()))
            } else {
                Ok(splice(workbook_xml, list_close, list_close, ext.as_bytes()))
            }
        }
    }
}

#[cfg(test)]
#[allow(non_snake_case)] // `__feat__<id>` test-name links (cockpit rule)
mod tests {
    use super::*;

    const WB: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets><calcPr calcId="191029"/></workbook>"#;

    fn sw(id: &str, model: DocColorModel, rgb: (u8, u8, u8)) -> DocSwatchRef {
        DocSwatchRef {
            id: id.into(),
            model,
            fallback_rgb: rgb,
        }
    }

    fn style() -> ChartStyle {
        let mut s = ChartStyle::default();
        s.roles.insert(
            "plotArea".into(),
            RoleStyle {
                swatch: Some(sw("Color/Paper", DocColorModel::Cmyk, (240, 238, 230))),
                ..RoleStyle::default()
            },
        );
        s.roles.insert(
            "legend".into(),
            RoleStyle {
                swatch: Some(sw("Color/a|b", DocColorModel::Lab, (20, 20, 20))),
                paragraph: Some("ParagraphStyle/Caption & Notes".into()),
                character: Some("CharacterStyle/Small".into()),
            },
        );
        s.palette = Some(SeriesPalette {
            group: "ColorGroup/Brand".into(),
            swatches: vec![
                sw("Color/A", DocColorModel::Spot, (10, 20, 30)),
                sw("Color/B", DocColorModel::Rgb, (40, 50, 60)),
            ],
        });
        s
    }

    #[test]
    fn swatches_encode_with_their_model__feat__sheet_chart_style_roles() {
        let s = sw("Color/x|y", DocColorModel::Spot, (1, 2, 255));
        assert_eq!(encode_swatch(&s), "Color/x|y|spot|0102FF");
        assert_eq!(decode_swatch(&encode_swatch(&s)), Some(s));
        assert_eq!(decode_swatch("Color/x|hsv|010203"), None);
        assert_eq!(decode_swatch("|rgb|010203"), None);
    }

    #[test]
    fn a_style_splices_in_and_reads_back__feat__sheet_chart_style_roles() {
        let out = splice_into(WB.as_bytes(), &style()).unwrap();
        let text = String::from_utf8(out.clone()).unwrap();
        // Everything before the extension is the part as it was.
        assert!(text.starts_with(&WB[..WB.len() - "</workbook>".len()]));
        assert!(text.ends_with("</ext></extLst></workbook>"));
        assert_eq!(parse(&out), style());
        // Re-setting replaces, never duplicates.
        let mut other = style();
        other.palette = None;
        let again = splice_into(&out, &other).unwrap();
        assert_eq!(parse(&again), other);
        assert_eq!(
            String::from_utf8(again.clone())
                .unwrap()
                .matches(CHART_STYLE_EXT_URI)
                .count(),
            1
        );
        // Clearing takes the extension (and the list it made) out again.
        let cleared = splice_into(&again, &ChartStyle::default()).unwrap();
        assert_eq!(cleared, WB.as_bytes());
    }

    #[test]
    fn other_extensions_and_prefixes_are_kept__feat__sheet_chart_style_roles() {
        let wb = r#"<x:workbook xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><x:sheets/><x:extLst><x:ext uri="{140A7094-0E35-4892-8432-C4D2E57EDEB5}"><x15:workbookPr xmlns:x15="urn:x15"/></x:ext></x:extLst></x:workbook>"#;
        let out = splice_into(wb.as_bytes(), &style()).unwrap();
        let text = String::from_utf8(out.clone()).unwrap();
        assert!(
            text.contains(r#"<x15:workbookPr xmlns:x15="urn:x15"/></x:ext><x:ext uri="{8E2A6C41"#)
        );
        assert_eq!(parse(&out), style());
        let cleared = splice_into(&out, &ChartStyle::default()).unwrap();
        assert_eq!(cleared, wb.as_bytes());
        assert!(parse(wb.as_bytes()).is_empty());
    }
}
