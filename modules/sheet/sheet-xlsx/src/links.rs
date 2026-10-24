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

//! Hyperlinks (ECMA-376 §18.3.1.47 `<hyperlinks>`): read and author.
//!
//! A worksheet lists its links in the captured `<hyperlinks>` child: each
//! `<hyperlink ref>` names a cell range and either an external target (an
//! `r:id` whose worksheet relationship has `TargetMode="External"`) or a
//! `location` inside the workbook (`Sheet2!A1`, a defined name), with an
//! optional `display` and `tooltip`. An edit rewrites only that child (a kept
//! link keeps every attribute it had, `xr:uid` included) and adds or drops
//! the external relationships it needs; the cell's own value is what Excel
//! shows, so the text is the caller's business.

use crate::error::XlsxError;
use crate::parts::cf_model::parse_sqref;
use crate::rels::{parse_rels, rels_part_name, Relationships};
use crate::splice::{render_tag, root_children, splice};
use crate::xtree::XNode;
use crate::XlsxDocument;
use sheet_core::condfmt::CfRange;
use sheet_core::SheetId;

/// The relationship type of an external hyperlink target.
pub const REL_HYPERLINK_FULL: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink";
/// The relationships namespace (`r:`).
pub const NS_REL: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/// One hyperlink of a sheet.
#[derive(Clone, Debug, PartialEq, Default)]
pub struct Hyperlink {
    /// The cells it covers `(r0, c0, r1, c1)`, 0-based inclusive.
    pub range: CfRange,
    /// The external target (a URL, `mailto:`, a file path).
    pub url: Option<String>,
    /// A place in the workbook (`Sheet2!A1`, a defined name), or the
    /// fragment of an external target.
    pub location: Option<String>,
    pub display: Option<String>,
    pub tooltip: Option<String>,
    /// The worksheet relationship that names `url`.
    pub rel_id: Option<String>,
}

/// What a new hyperlink points to.
#[derive(Clone, Debug, PartialEq, Default)]
pub struct HyperlinkSpec {
    pub url: Option<String>,
    pub location: Option<String>,
    pub display: Option<String>,
    pub tooltip: Option<String>,
}

fn contains(r: &CfRange, row: u32, col: u32) -> bool {
    r.0 <= row && row <= r.2 && r.1 <= col && col <= r.3
}

fn intersects(a: &CfRange, b: &CfRange) -> bool {
    a.0 <= b.2 && b.0 <= a.2 && a.1 <= b.3 && b.1 <= a.3
}

impl XlsxDocument {
    /// The worksheet part of `sheet`.
    pub(crate) fn ws_part_of(&self, sheet: SheetId) -> Result<String, XlsxError> {
        self.part_name_of(sheet)
            .map(str::to_string)
            .ok_or_else(|| XlsxError::Structure(format!("sheet {sheet} has no part")))
    }

    /// The relationships of a part (`None` when it has none).
    pub(crate) fn rels_of_part(&self, part: &str) -> Option<Relationships> {
        let raw = self.part_bytes(&rels_part_name(part))?;
        parse_rels(&raw).ok()
    }

    /// Add a relationship from `source` (its `.rels` part is created when it
    /// has none); returns the new id.
    pub(crate) fn add_part_rel(
        &mut self,
        source: &str,
        rel_type: &str,
        target: &str,
        external: bool,
    ) -> Result<String, XlsxError> {
        let rels_part = rels_part_name(source);
        let raw = self.part_bytes(&rels_part).unwrap_or_else(|| {
            br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>"#
                .to_vec()
        });
        let rels = parse_rels(&raw)?;
        let used: std::collections::BTreeSet<&str> =
            rels.items.iter().map(|r| r.id.as_str()).collect();
        let mut k = rels.items.len() + 1;
        let rid = loop {
            let cand = format!("rId{k}");
            if !used.contains(cand.as_str()) {
                break cand;
            }
            k += 1;
        };
        let (_, close) = root_children(&raw)?;
        let mut attrs = vec![
            ("Id".to_string(), rid.clone()),
            ("Type".to_string(), rel_type.to_string()),
            ("Target".to_string(), target.to_string()),
        ];
        if external {
            attrs.push(("TargetMode".to_string(), "External".to_string()));
        }
        let tag = render_tag("Relationship", &attrs, true);
        let out = splice(&raw, close, close, tag.as_bytes());
        if self.container.part(&rels_part).is_some() {
            self.set_part_bytes(&rels_part, out);
        } else {
            self.container.parts.push(crate::opc::PartEntry::Opaque {
                name: rels_part,
                bytes: out,
            });
        }
        self.container.dirty = true;
        Ok(rid)
    }

    /// Whether the worksheet's root declares `xmlns:r`.
    pub(crate) fn ws_declares_r(&self, sheet: SheetId) -> bool {
        let Some(part) = self.part_name_of(sheet) else {
            return false;
        };
        self.part_bytes(part)
            .map(|b| {
                let head = String::from_utf8_lossy(&b[..b.len().min(4096)]).into_owned();
                head.contains(&format!("xmlns:r=\"{NS_REL}\""))
            })
            .unwrap_or(false)
    }

    /// The sheet's hyperlinks, in file order.
    pub fn hyperlinks_of(&self, sheet: SheetId) -> Vec<Hyperlink> {
        let Some(node) = self
            .ws_child(sheet, "hyperlinks")
            .and_then(|b| XNode::parse(b).ok())
        else {
            return Vec::new();
        };
        let rels = self.part_name_of(sheet).and_then(|p| self.rels_of_part(p));
        node.children_named("hyperlink")
            .filter_map(|h| {
                let range = parse_sqref(&h.attr("ref")?).first().copied()?;
                let rel_id = h.attr("id");
                let url = rel_id.as_ref().and_then(|id| {
                    rels.as_ref()?
                        .items
                        .iter()
                        .find(|r| &r.id == id)
                        .map(|r| r.target.clone())
                });
                Some(Hyperlink {
                    range,
                    url,
                    location: h.attr("location"),
                    display: h.attr("display"),
                    tooltip: h.attr("tooltip"),
                    rel_id,
                })
            })
            .collect()
    }

    /// The hyperlink covering a cell.
    pub fn hyperlink_at(&self, sheet: SheetId, row: u32, col: u32) -> Option<Hyperlink> {
        self.hyperlinks_of(sheet)
            .into_iter()
            .find(|h| contains(&h.range, row, col))
    }

    /// Link `range` to `spec`: every link over the range's first cell or the
    /// same range is replaced. A spec with neither a URL nor a location is
    /// refused.
    pub fn set_hyperlink(
        &mut self,
        sheet: SheetId,
        range: CfRange,
        spec: &HyperlinkSpec,
    ) -> Result<(), XlsxError> {
        let url = spec.url.as_deref().filter(|u| !u.trim().is_empty());
        let location = spec.location.as_deref().filter(|l| !l.trim().is_empty());
        if url.is_none() && location.is_none() {
            return Err(XlsxError::Structure(
                "a hyperlink needs a URL or a location".into(),
            ));
        }
        let ws_part = self.ws_part_of(sheet)?;
        let mut node = self.hyperlinks_node(sheet)?;
        let dropped = take_links(&mut node, |r| contains(r, range.0, range.1) || *r == range);
        let p = node.prefix().to_string();
        let mut el =
            XNode::new(format!("{p}hyperlink")).with_attr("ref", crate::cf_edit::range_a1(&range));
        if let Some(u) = url {
            let rid = self.add_part_rel(&ws_part, REL_HYPERLINK_FULL, u, true)?;
            el = el.with_attr("r:id", rid);
            if !self.ws_declares_r(sheet) && node.attr("xmlns:r").is_none() {
                node.attrs.push(("xmlns:r".into(), NS_REL.into()));
            }
        }
        if let Some(l) = location {
            el = el.with_attr("location", l);
        }
        if let Some(d) = spec.display.as_deref().filter(|d| !d.is_empty()) {
            el = el.with_attr("display", d);
        }
        if let Some(t) = spec.tooltip.as_deref().filter(|t| !t.is_empty()) {
            el = el.with_attr("tooltip", t);
        }
        node.children.push(el);
        self.store_hyperlinks(sheet, node, &dropped)
    }

    /// Remove every hyperlink that touches `range`; returns how many.
    pub fn remove_hyperlinks(
        &mut self,
        sheet: SheetId,
        range: CfRange,
    ) -> Result<usize, XlsxError> {
        let mut node = self.hyperlinks_node(sheet)?;
        let dropped = take_links(&mut node, |r| intersects(r, &range));
        let n = dropped.len();
        if n > 0 {
            self.store_hyperlinks(sheet, node, &dropped)?;
        }
        Ok(n)
    }

    /// The sheet's `<hyperlinks>` element, or a new empty one.
    fn hyperlinks_node(&self, sheet: SheetId) -> Result<XNode, XlsxError> {
        Ok(match self.ws_child(sheet, "hyperlinks") {
            Some(b) => XNode::parse(b)?,
            None => XNode::new(format!("{}hyperlinks", self.ws_prefix(sheet))),
        })
    }

    /// Write the element back (dropped when empty) and remove the external
    /// relationships no remaining link names.
    fn store_hyperlinks(
        &mut self,
        sheet: SheetId,
        node: XNode,
        dropped: &[Option<String>],
    ) -> Result<(), XlsxError> {
        let still: Vec<String> = node
            .children_named("hyperlink")
            .filter_map(|h| h.attr("id"))
            .collect();
        let has_links = node.children_named("hyperlink").next().is_some();
        self.set_ws_child(
            sheet,
            "hyperlinks",
            has_links.then(|| node.to_xml().into_bytes()),
        )?;
        let ws_part = self.ws_part_of(sheet)?;
        let rels_part = rels_part_name(&ws_part);
        for id in dropped.iter().flatten() {
            if !still.contains(id) {
                self.remove_rel(&rels_part, id)?;
            }
        }
        Ok(())
    }
}

/// Take out the `<hyperlink>` children whose range matches; returns their
/// relationship ids.
fn take_links(node: &mut XNode, hit: impl Fn(&CfRange) -> bool) -> Vec<Option<String>> {
    let mut dropped = Vec::new();
    node.children.retain(|h| {
        if h.local() != "hyperlink" {
            return true;
        }
        let r = h.attr("ref").and_then(|s| parse_sqref(&s).first().copied());
        match r {
            Some(r) if hit(&r) => {
                dropped.push(h.attr("id"));
                false
            }
            _ => true,
        }
    });
    dropped
}
