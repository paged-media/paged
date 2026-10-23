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

//! Table parts, read whole and authored (W2.6, sheet ADR 517). The frozen
//! `sheet_core::Table` keeps what formulas need (name, extent, column names,
//! header/totals rows, style name); [`TableDef`] is the whole `<table>`
//! element — calculated-column formulas, totals functions and labels, the
//! style flags — over the part's XML, so an edit keeps every attribute and
//! child Paged does not model. A new table gets its part, its worksheet
//! relationship, its content type and its `<tablePart>`.

use crate::error::XlsxError;
use crate::rels::{parse_rels, part_dir, rels_part_name, resolve_target, REL_TABLE};
use crate::splice::{render_tag, root_children, splice};
use crate::xtree::XNode;
use crate::XlsxDocument;
use sheet_core::{col_to_a1, SheetId};

/// The table part's content type.
pub const CT_TABLE: &str = "application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml";
/// The table relationship type.
pub const REL_TABLE_FULL: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/table";
const NS_MAIN: &str = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const NS_REL: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/// One `<tableColumn>`.
#[derive(Clone, Debug, PartialEq, Default)]
pub struct TableColumnDef {
    pub id: u32,
    pub name: String,
    /// The calculated-column formula (storage dialect, no `=`), relative to
    /// the column's first data cell.
    pub calculated: Option<String>,
    /// `sum`, `min`, `max`, `average`, `count`, `countNums`, `stdDev`,
    /// `var`, `custom` (then `totals_formula`), or `None`.
    pub totals_function: Option<String>,
    pub totals_formula: Option<String>,
    pub totals_label: Option<String>,
}

/// A table part, read whole.
#[derive(Clone, Debug, PartialEq)]
pub struct TableDef {
    /// The part name (`xl/tables/table1.xml`).
    pub part: String,
    pub node: XNode,
}

impl TableDef {
    pub fn id(&self) -> u32 {
        self.node
            .attr("id")
            .and_then(|s| s.parse().ok())
            .unwrap_or(0)
    }

    /// The name formulas use (`displayName`, else `name`).
    pub fn name(&self) -> String {
        self.node
            .attr("displayName")
            .or_else(|| self.node.attr("name"))
            .unwrap_or_default()
    }

    /// The full extent `(r0, c0, r1, c1)`.
    pub fn range(&self) -> Option<(u32, u32, u32, u32)> {
        crate::parts::validation::parse_sqref(&self.node.attr("ref")?)
            .first()
            .copied()
    }

    pub fn header_rows(&self) -> u32 {
        self.node
            .attr("headerRowCount")
            .and_then(|s| s.parse().ok())
            .unwrap_or(1)
    }

    pub fn totals_rows(&self) -> u32 {
        self.node
            .attr("totalsRowCount")
            .and_then(|s| s.parse().ok())
            .unwrap_or(0)
    }

    pub fn columns(&self) -> Vec<TableColumnDef> {
        let Some(tc) = self.node.child("tableColumns") else {
            return Vec::new();
        };
        tc.children_named("tableColumn")
            .map(|c| TableColumnDef {
                id: c.attr("id").and_then(|s| s.parse().ok()).unwrap_or(0),
                name: c.attr("name").unwrap_or_default(),
                calculated: c
                    .child("calculatedColumnFormula")
                    .and_then(|f| f.text.clone())
                    .filter(|s| !s.is_empty()),
                totals_function: c.attr("totalsRowFunction"),
                totals_formula: c
                    .child("totalsRowFormula")
                    .and_then(|f| f.text.clone())
                    .filter(|s| !s.is_empty()),
                totals_label: c.attr("totalsRowLabel"),
            })
            .collect()
    }

    /// `(style name, first column, last column, row stripes, column stripes)`.
    pub fn style(&self) -> (Option<String>, bool, bool, bool, bool) {
        match self.node.child("tableStyleInfo") {
            Some(s) => (
                s.attr("name"),
                s.flag("showFirstColumn", false),
                s.flag("showLastColumn", false),
                s.flag("showRowStripes", false),
                s.flag("showColumnStripes", false),
            ),
            None => (None, false, false, false, false),
        }
    }

    /// Replace the columns (kept attributes and children of a column whose
    /// id stays are kept).
    pub fn set_columns(&mut self, cols: &[TableColumnDef]) {
        let p = self.node.prefix().to_string();
        let old: Vec<XNode> = self
            .node
            .child("tableColumns")
            .map(|t| t.children_named("tableColumn").cloned().collect())
            .unwrap_or_default();
        let mut tc = self
            .node
            .child("tableColumns")
            .cloned()
            .unwrap_or_else(|| XNode::new(format!("{p}tableColumns")));
        tc.children.retain(|c| c.local() != "tableColumn");
        let mut kids = Vec::new();
        for c in cols {
            let mut n = old
                .iter()
                .find(|o| o.attr("id").and_then(|s| s.parse::<u32>().ok()) == Some(c.id))
                .cloned()
                .unwrap_or_else(|| XNode::new(format!("{p}tableColumn")));
            n.set("id", Some(c.id.to_string()));
            n.set("name", Some(c.name.clone()));
            n.set("totalsRowFunction", c.totals_function.clone());
            n.set("totalsRowLabel", c.totals_label.clone());
            n.remove_children("calculatedColumnFormula");
            n.remove_children("totalsRowFormula");
            // CT_TableColumn: calculatedColumnFormula, totalsRowFormula,
            // xmlColumnPr, extLst.
            let mut at = 0;
            if let Some(f) = &c.calculated {
                n.children.insert(
                    at,
                    XNode::new(format!("{p}calculatedColumnFormula")).with_text(f.clone()),
                );
                at += 1;
            }
            if let Some(f) = &c.totals_formula {
                n.children.insert(
                    at,
                    XNode::new(format!("{p}totalsRowFormula")).with_text(f.clone()),
                );
            }
            kids.push(n);
        }
        tc.children.splice(0..0, kids);
        tc.set("count", Some(cols.len().to_string()));
        match self
            .node
            .children
            .iter()
            .position(|c| c.local() == "tableColumns")
        {
            Some(i) => self.node.children[i] = tc,
            None => {
                let at = self
                    .node
                    .children
                    .iter()
                    .position(|c| c.local() == "tableStyleInfo" || c.local() == "extLst")
                    .unwrap_or(self.node.children.len());
                self.node.children.insert(at, tc);
            }
        }
    }

    /// Set the extent; the autoFilter (when there is one, and the header row
    /// shows) follows the header and data rows.
    pub fn set_range(&mut self, r0: u32, c0: u32, r1: u32, c1: u32) {
        let a1 = |r: u32, c: u32| format!("{}{}", col_to_a1(c), r + 1);
        self.node
            .set("ref", Some(format!("{}:{}", a1(r0, c0), a1(r1, c1))));
        let data_end = r1 - self.totals_rows().min(r1 - r0);
        if let Some(af) = self.node.child_mut("autoFilter") {
            af.set("ref", Some(format!("{}:{}", a1(r0, c0), a1(data_end, c1))));
        }
    }

    pub fn set_totals_rows(&mut self, n: u32) {
        self.node
            .set("totalsRowCount", (n > 0).then(|| n.to_string()));
        if n > 0 {
            self.node.set("totalsRowShown", None);
        } else {
            self.node.set("totalsRowShown", Some("0".into()));
        }
    }

    pub fn set_style(
        &mut self,
        name: Option<&str>,
        first: bool,
        last: bool,
        rows: bool,
        cols: bool,
    ) {
        let p = self.node.prefix().to_string();
        let mut s = self
            .node
            .child("tableStyleInfo")
            .cloned()
            .unwrap_or_else(|| XNode::new(format!("{p}tableStyleInfo")));
        s.set("name", name.map(str::to_string));
        let f = |b: bool| Some(if b { "1" } else { "0" }.to_string());
        s.set("showFirstColumn", f(first));
        s.set("showLastColumn", f(last));
        s.set("showRowStripes", f(rows));
        s.set("showColumnStripes", f(cols));
        self.node.remove_children("tableStyleInfo");
        let at = self
            .node
            .children
            .iter()
            .position(|c| c.local() == "extLst")
            .unwrap_or(self.node.children.len());
        self.node.children.insert(at, s);
    }

    /// The part bytes.
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut out = br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
"#
        .to_vec();
        out.extend_from_slice(self.node.to_xml().as_bytes());
        out
    }
}

impl XlsxDocument {
    /// The sheet's table parts as `(part, relationship id)`.
    fn table_part_names(&self, sheet: SheetId) -> Vec<(String, String)> {
        let Some(ws_part) = self.part_name_of(sheet).map(str::to_string) else {
            return Vec::new();
        };
        let Some(raw) = self.part_bytes(&rels_part_name(&ws_part)) else {
            return Vec::new();
        };
        let Ok(rels) = parse_rels(&raw) else {
            return Vec::new();
        };
        let base = part_dir(&ws_part);
        rels.all_of_type(REL_TABLE)
            .map(|r| (resolve_target(base, &r.target), r.id.clone()))
            .collect()
    }

    /// The sheet's tables, read whole.
    pub fn table_defs(&self, sheet: SheetId) -> Vec<TableDef> {
        self.table_part_names(sheet)
            .into_iter()
            .filter_map(|(part, _)| {
                let b = self.part_bytes(&part)?;
                Some(TableDef {
                    node: XNode::parse(&b).ok()?,
                    part,
                })
            })
            .collect()
    }

    /// Every table of the workbook (for unique names and ids).
    pub fn all_table_defs(&self) -> Vec<TableDef> {
        let n = self.bindings.len() as SheetId;
        (0..n).flat_map(|s| self.table_defs(s)).collect()
    }

    /// Write a table's part back.
    pub fn store_table(&mut self, def: &TableDef) {
        self.set_part_bytes(&def.part, def.to_bytes());
    }

    /// Add a new table part for `sheet`: the part, the worksheet's
    /// relationship to it (the `.rels` part is created when the sheet has
    /// none), its content type and its `<tablePart>`. Returns the part name.
    pub fn add_table_part(&mut self, sheet: SheetId, node: XNode) -> Result<String, XlsxError> {
        let ws_part = self
            .part_name_of(sheet)
            .map(str::to_string)
            .ok_or_else(|| XlsxError::Structure(format!("sheet {sheet} has no part")))?;
        let mut n = 1;
        let part = loop {
            let cand = format!("xl/tables/table{n}.xml");
            if self.container.part(&cand).is_none() {
                break cand;
            }
            n += 1;
        };
        let def = TableDef {
            part: part.clone(),
            node,
        };
        self.container.parts.push(crate::opc::PartEntry::Opaque {
            name: part.clone(),
            bytes: def.to_bytes(),
        });
        self.container.dirty = true;
        self.add_override(&part, CT_TABLE)?;
        // The worksheet's relationship.
        let rels_part = rels_part_name(&ws_part);
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
        let target = format!("../tables/table{n}.xml");
        let tag = render_tag(
            "Relationship",
            &[
                ("Id".into(), rid.clone()),
                ("Type".into(), REL_TABLE_FULL.into()),
                ("Target".into(), target),
            ],
            true,
        );
        let out = splice(&raw, close, close, tag.as_bytes());
        if self.container.part(&rels_part).is_some() {
            self.set_part_bytes(&rels_part, out);
        } else {
            self.container.parts.push(crate::opc::PartEntry::Opaque {
                name: rels_part,
                bytes: out,
            });
        }
        // The `<tablePart>`.
        let prefix = self.ws_prefix(sheet);
        let mut tp = match self.ws_child(sheet, "tableParts") {
            Some(b) => XNode::parse(b)?,
            None => XNode::new(format!("{prefix}tableParts")),
        };
        let p = tp.prefix().to_string();
        let ws_declares_r = self
            .part_bytes(&ws_part)
            .map(|b| {
                let head = String::from_utf8_lossy(&b[..b.len().min(2048)]).into_owned();
                head.contains(&format!("xmlns:r=\"{NS_REL}\""))
            })
            .unwrap_or(false);
        let mut part_el = XNode::new(format!("{p}tablePart")).with_attr("r:id", rid);
        if !ws_declares_r && tp.attr("xmlns:r").is_none() {
            part_el = part_el.with_attr("xmlns:r", NS_REL);
        }
        tp.children.push(part_el);
        let count = tp.children_named("tablePart").count();
        tp.set("count", Some(count.to_string()));
        self.set_ws_child(sheet, "tableParts", Some(tp.to_xml().into_bytes()))?;
        Ok(part)
    }
}

/// A new `<table>` element: `id`, names, extent, columns, a header row, an
/// autoFilter over header and data, and the style.
pub fn new_table_node(
    id: u32,
    name: &str,
    range: (u32, u32, u32, u32),
    columns: &[String],
    style: &str,
) -> XNode {
    let (r0, c0, r1, c1) = range;
    let a1 = |r: u32, c: u32| format!("{}{}", col_to_a1(c), r + 1);
    let rf = format!("{}:{}", a1(r0, c0), a1(r1, c1));
    let mut cols = XNode::new("tableColumns").with_attr("count", columns.len().to_string());
    for (i, c) in columns.iter().enumerate() {
        cols.children.push(
            XNode::new("tableColumn")
                .with_attr("id", (i + 1).to_string())
                .with_attr("name", c.clone()),
        );
    }
    XNode::new("table")
        .with_attr("xmlns", NS_MAIN)
        .with_attr("id", id.to_string())
        .with_attr("name", name)
        .with_attr("displayName", name)
        .with_attr("ref", rf.clone())
        .with_attr("totalsRowShown", "0")
        .with_child(XNode::new("autoFilter").with_attr("ref", rf))
        .with_child(cols)
        .with_child(
            XNode::new("tableStyleInfo")
                .with_attr("name", style)
                .with_attr("showFirstColumn", "0")
                .with_attr("showLastColumn", "0")
                .with_attr("showRowStripes", "1")
                .with_attr("showColumnStripes", "0"),
        )
}
