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

//! Writing the workbook's document-style mapping (sheet ADR 524) into
//! `styles.xml`: one paged `<ext>` in the style sheet's own `extLst`
//! ([`MAP_EXT_URI`]), spliced in place (ADR 503) — every other byte of the
//! part, other applications' extensions included, stays as it was. The model
//! follows by re-parsing the part, so the folded style table is the parser's
//! own output, exactly as on open.

use std::collections::BTreeSet;

use sheet_core::visual::DocColorModel;
use sheet_core::StyleTable;
use sheet_lower::DocStyleMap;

use crate::error::XlsxError;
use crate::parts::style_model::{DOC_EXT_NS, DOC_EXT_URI, MAP_EXT_URI};
use crate::parts::styles::{parse_with_context, ColorContext};
use crate::splice::{attr_local, attrs_of, children_of, escape_attr, root_children, splice};
use crate::style_edit::{parse_elem, records, root_prefix, section};
use crate::XlsxDocument;

/// The `<ext>` element carrying `map` (`None` when the map is the default:
/// off and empty — nothing to record).
fn render_ext(map: &DocStyleMap, prefix: &str) -> Option<String> {
    if !map.enabled && map.entries.is_empty() {
        return None;
    }
    let mut s = format!(
        "<{prefix}ext uri=\"{MAP_EXT_URI}\" xmlns:pg=\"{DOC_EXT_NS}\"><pg:docStyleMap enabled=\"{}\">",
        if map.enabled { "1" } else { "0" }
    );
    for (name, t) in &map.entries {
        s.push_str(&format!("<pg:map style=\"{}\"", escape_attr(name)));
        for (k, v) in [("para", &t.para), ("char", &t.char), ("cell", &t.cell)] {
            if let Some(v) = v {
                s.push_str(&format!(" {k}=\"{}\"", escape_attr(v)));
            }
        }
        s.push_str("/>");
    }
    s.push_str(&format!("</pg:docStyleMap></{prefix}ext>"));
    Some(s)
}

/// `xml` with the mapping extension replaced by `map`'s (see the module
/// docs). Pure: bytes in, bytes out.
pub fn splice_doc_map(xml: Vec<u8>, map: &DocStyleMap) -> Result<Vec<u8>, XlsxError> {
    let prefix = root_prefix(&xml)?;
    let (kids, root_close) = root_children(&xml)?;
    let Some(lst) = kids.iter().find(|k| k.local == "extLst") else {
        // No extension list: the mapping's own, as the last child.
        return Ok(match render_ext(map, &prefix) {
            Some(ext) => {
                let new = format!("<{prefix}extLst>{ext}</{prefix}extLst>");
                splice(&xml, root_close, root_close, new.as_bytes())
            }
            None => xml,
        });
    };
    // The list's own prefix for the `<ext>` (it may differ from the root's).
    let lst_prefix = lst.qname.strip_suffix("extLst").unwrap_or("").to_string();
    let ext = render_ext(map, &lst_prefix);
    if lst.empty {
        let Some(ext) = ext else { return Ok(xml) };
        let new = format!("<{q}>{ext}</{q}>", q = lst.qname);
        return Ok(splice(&xml, lst.start, lst.end, new.as_bytes()));
    }
    let (exts, close_at) = children_of(&xml, lst)?;
    let ours = exts.iter().find(|e| {
        e.local == "ext"
            && attrs_of(&xml, e)
                .ok()
                .and_then(|a| attr_local(&a, "uri"))
                .as_deref()
                == Some(MAP_EXT_URI)
    });
    Ok(match (ours, ext) {
        (Some(o), Some(ext)) => splice(&xml, o.start, o.end, ext.as_bytes()),
        (Some(_), None) if exts.len() == 1 => {
            // The list held only the mapping: drop the list.
            splice(&xml, lst.start, lst.end, b"")
        }
        (Some(o), None) => splice(&xml, o.start, o.end, b""),
        (None, Some(ext)) => splice(&xml, close_at, close_at, ext.as_bytes()),
        (None, None) => xml,
    })
}

/// Rewrite every `cellXfs` record whose document references name `from`
/// (a style id, or a swatch id — its sRGB fallback kept, its colour model
/// replaced by `model` when given). Records are rewritten in place, so
/// every positional id stays valid. Returns the bytes and how many records
/// changed.
pub fn splice_remap(
    xml: Vec<u8>,
    from: &str,
    to: &str,
    model: Option<DocColorModel>,
) -> Result<(Vec<u8>, u32), XlsxError> {
    let Some(sec) = section(&xml, "cellXfs")? else {
        return Ok((xml, 0));
    };
    let spans = records(&xml, &sec, "xf")?;
    let swatch_prefix = format!("{from}|");
    let mut edits: Vec<(usize, usize, String)> = Vec::new();
    for sp in &spans {
        let mut el = parse_elem(&xml[sp.start..sp.end])?;
        let mut changed = false;
        if let Some(lst) = el.children.iter_mut().find(|c| c.local() == "extLst") {
            for ext in lst
                .children
                .iter_mut()
                .filter(|e| e.local() == "ext" && e.attr("uri").as_deref() == Some(DOC_EXT_URI))
            {
                for doc in ext.children.iter_mut().filter(|c| c.local() == "doc") {
                    for (k, v) in doc.attrs.iter_mut() {
                        let local = k.rsplit(':').next().unwrap_or(k);
                        if matches!(local, "charStyle" | "paraStyle" | "cellStyle") {
                            if v == from {
                                *v = to.to_string();
                                changed = true;
                            }
                        } else if let Some(rest) = v.strip_prefix(&swatch_prefix) {
                            // `model|RRGGBB`
                            let (old_model, rgb) = rest.split_once('|').unwrap_or(("rgb", rest));
                            let m = model.map(|m| m.as_str()).unwrap_or(old_model);
                            *v = format!("{to}|{m}|{rgb}");
                            changed = true;
                        }
                    }
                }
            }
        }
        if changed {
            edits.push((sp.start, sp.end, el.to_xml()));
        }
    }
    let n = edits.len() as u32;
    let mut out = xml;
    for (start, end, new) in edits.into_iter().rev() {
        out = splice(&out, start, end, new.as_bytes());
    }
    Ok((out, n))
}

impl XlsxDocument {
    /// Point every reference to document style or swatch `from` at `to`:
    /// the cell records and the mapping table (sheet ADR 524 "Remap").
    /// Returns the style table the model must adopt and how many cell
    /// records and mapping entries changed.
    pub fn remap_doc_reference(
        &mut self,
        from: &str,
        to: &str,
        model: Option<DocColorModel>,
    ) -> Result<(StyleTable, u32), XlsxError> {
        let (mut xml, mut n) = splice_remap(self.styles_bytes(), from, to, model)?;
        let mut map = self.doc_style_map().clone();
        let mut map_changed = false;
        for t in map.entries.values_mut() {
            for id in [&mut t.para, &mut t.char, &mut t.cell]
                .into_iter()
                .flatten()
            {
                if id == from {
                    *id = to.to_string();
                    map_changed = true;
                    n += 1;
                }
            }
        }
        if map_changed {
            xml = splice_doc_map(xml, &map)?;
        }
        Ok((self.store_styles(xml)?, n))
    }

    /// Tell the mapping which document style ids exist (`None` = unknown):
    /// a mapped id the document lacks falls back to the workbook's look. The
    /// styles part is re-read, never rewritten. Returns the style table the
    /// model must adopt.
    pub fn set_doc_styles_available(
        &mut self,
        ids: Option<BTreeSet<String>>,
    ) -> Result<StyleTable, XlsxError> {
        let xml = self.styles_bytes();
        let mut table = StyleTable::new();
        let colors = ColorContext::new(&xml, self.theme_palette());
        let parsed = parse_with_context(&xml, &mut table, &colors, ids.as_ref())?;
        let mut visual = parsed.visual;
        visual.take_rich_from(&mut self.visual_styles);
        visual.set_doc_available(ids);
        self.visual_styles = visual;
        self.dxfs = parsed.dxfs;
        self.dxf_models = parsed.dxf_models;
        Ok(table)
    }

    /// The workbook's document-style mapping (sheet ADR 524).
    pub fn doc_style_map(&self) -> &DocStyleMap {
        self.visual_styles.doc_map()
    }

    /// Replace the workbook's document-style mapping: splice `styles.xml`
    /// and re-parse it. Returns the style table the model must adopt (the
    /// records and their positional ids are unchanged; what they resolve to
    /// is not).
    pub fn set_doc_style_map(&mut self, map: &DocStyleMap) -> Result<StyleTable, XlsxError> {
        let xml = splice_doc_map(self.styles_bytes(), map)?;
        self.store_styles(xml)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parts::style_model::StyleSheet;
    use sheet_lower::DocStyleTarget;

    const BASE: &str = r#"<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/></font></fonts><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs></styleSheet>"#;

    fn sample() -> DocStyleMap {
        let mut m = DocStyleMap {
            enabled: true,
            ..Default::default()
        };
        m.set(
            "Heading 1",
            DocStyleTarget {
                para: Some("ParagraphStyle/Heading 1".into()),
                char: None,
                cell: Some("CellStyle/Head & <Body>".into()),
            },
        );
        m.set(
            "Normal",
            DocStyleTarget {
                para: Some("ParagraphStyle/$ID/NormalParagraphStyle".into()),
                ..Default::default()
            },
        );
        m
    }

    #[test]
    #[allow(non_snake_case)]
    fn the_mapping_round_trips_through_styles_xml__feat__sheet_format_doc_style_map() {
        let xml = splice_doc_map(BASE.as_bytes().to_vec(), &sample()).unwrap();
        let back = StyleSheet::parse(&xml).unwrap().doc_map;
        assert_eq!(back, sample());
        // Turning it off keeps the table; clearing everything removes the
        // extension list it created.
        let mut off = sample();
        off.enabled = false;
        let xml2 = splice_doc_map(xml.clone(), &off).unwrap();
        assert_eq!(StyleSheet::parse(&xml2).unwrap().doc_map, off);
        let xml3 = splice_doc_map(xml2, &DocStyleMap::default()).unwrap();
        assert_eq!(String::from_utf8(xml3).unwrap(), BASE);
    }

    #[test]
    fn other_extensions_stay_byte_identical() {
        let other = r#"<extLst><ext uri="{EB79DEF2-80B8-43e5-95BD-54CBDDF9020C}" xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main"><x14:slicerStyles defaultSlicerStyle="SlicerStyleLight1"/></ext></extLst>"#;
        let base = BASE.replace("</styleSheet>", &format!("{other}</styleSheet>"));
        let xml = splice_doc_map(base.clone().into_bytes(), &sample()).unwrap();
        let text = String::from_utf8(xml.clone()).unwrap();
        assert!(
            text.contains(r#"<x14:slicerStyles defaultSlicerStyle="SlicerStyleLight1"/></ext>"#)
        );
        assert_eq!(StyleSheet::parse(&xml).unwrap().doc_map, sample());
        // Replacing then removing the mapping restores the original bytes.
        let mut changed = sample();
        changed.entries.clear();
        let xml = splice_doc_map(xml, &changed).unwrap();
        assert_eq!(StyleSheet::parse(&xml).unwrap().doc_map, changed);
        let xml = splice_doc_map(xml, &DocStyleMap::default()).unwrap();
        assert_eq!(String::from_utf8(xml).unwrap(), base);
    }

    #[test]
    fn remap_rewrites_records_in_place() {
        let xml = r#"<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"><extLst><ext uri="{6F3D1A52-8E0B-4C71-9B5A-2D7C4E9F1A30}" xmlns:pg="urn:paged:sheet:docstyles"><pg:doc fontColor="Color/Old|rgb|FF0000" paraStyle="ParagraphStyle/Old"/></ext></extLst></xf></cellXfs></styleSheet>"#;
        let (out, n) = splice_remap(
            xml.as_bytes().to_vec(),
            "ParagraphStyle/Old",
            "ParagraphStyle/New",
            None,
        )
        .unwrap();
        assert_eq!(n, 1);
        let (out, n) =
            splice_remap(out, "Color/Old", "Color/New", Some(DocColorModel::Spot)).unwrap();
        assert_eq!(n, 1);
        let sheet = StyleSheet::parse(&out).unwrap();
        assert_eq!(sheet.cell_xfs.len(), 2);
        let doc = &sheet.cell_xfs[1].doc;
        assert_eq!(doc.para_style.as_deref(), Some("ParagraphStyle/New"));
        let c = doc.font_color.as_ref().unwrap();
        assert_eq!(c.id, "Color/New");
        assert_eq!(c.model, DocColorModel::Spot);
        assert_eq!(c.fallback_rgb, (255, 0, 0));
    }
}
