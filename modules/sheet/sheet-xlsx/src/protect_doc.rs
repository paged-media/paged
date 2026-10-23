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

//! The workbook-level writes of sheet ADR 517: sheet protection (a captured
//! worksheet child), workbook protection and a sheet tab's visibility (both
//! in `workbook.xml`, spliced in place).

use crate::error::XlsxError;
use crate::parts::protection::{SheetProtection, WorkbookProtection};
use crate::splice::{
    attrs_of, prefix_of, render_tag, replace_start_tag, root_children, set_attr, splice,
};
use crate::XlsxDocument;
use sheet_core::{SheetId, SheetState};

/// `CT_Workbook` children in schema order (ECMA-376 §18.2.27).
const WB_ORDER: &[&str] = &[
    "fileVersion",
    "fileSharing",
    "workbookPr",
    "AlternateContent",
    "revisionPtr",
    "absPath",
    "workbookProtection",
    "bookViews",
    "sheets",
    "functionGroups",
    "externalReferences",
    "definedNames",
    "calcPr",
    "oleSize",
    "customWorkbookViews",
    "pivotCaches",
    "smartTagPr",
    "smartTagTypes",
    "webPublishing",
    "fileRecoveryPr",
    "webPublishObjects",
    "extLst",
];

fn wb_rank(local: &str) -> usize {
    WB_ORDER
        .iter()
        .position(|n| *n == local)
        .unwrap_or(WB_ORDER.len())
}

impl XlsxDocument {
    /// The sheet's `<sheetProtection>`, when it has one (protected or not:
    /// `on` says which).
    pub fn sheet_protection(&self, sheet: SheetId) -> Option<SheetProtection> {
        self.ws_child(sheet, "sheetProtection")
            .and_then(SheetProtection::parse)
    }

    /// Write (`Some`) or remove (`None`) the sheet's `<sheetProtection>`.
    pub fn set_sheet_protection(
        &mut self,
        sheet: SheetId,
        p: Option<&SheetProtection>,
    ) -> Result<(), XlsxError> {
        let prefix = self.ws_prefix(sheet);
        self.set_ws_child(
            sheet,
            "sheetProtection",
            p.map(|p| p.to_xml(&prefix).into_bytes()),
        )
    }

    /// The workbook's `<workbookProtection>`, when it has one.
    pub fn workbook_protection(&self) -> Option<WorkbookProtection> {
        let wb = self.workbook_bytes().ok()?;
        let (kids, _) = root_children(&wb).ok()?;
        let k = kids.iter().find(|k| k.local == "workbookProtection")?;
        WorkbookProtection::parse(&wb[k.start..k.end])
    }

    /// Write (`Some`) or remove (`None`) the workbook's `<workbookProtection>`.
    pub fn set_workbook_protection(
        &mut self,
        p: Option<&WorkbookProtection>,
    ) -> Result<(), XlsxError> {
        let wb = self.workbook_bytes()?;
        let (kids, close) = root_children(&wb)?;
        let root_q = {
            let mut reader = quick_xml::Reader::from_reader(wb.as_slice());
            let mut buf = Vec::new();
            loop {
                match reader.read_event_into(&mut buf) {
                    Ok(quick_xml::events::Event::Start(e)) => {
                        break String::from_utf8_lossy(e.name().as_ref()).into_owned()
                    }
                    Ok(quick_xml::events::Event::Eof) | Err(_) => break String::new(),
                    _ => {}
                }
                buf.clear();
            }
        };
        let prefix = prefix_of(&root_q).to_string();
        let new = p.map(|p| p.to_xml(&prefix)).unwrap_or_default();
        let out = match kids.iter().find(|k| k.local == "workbookProtection") {
            Some(k) => splice(&wb, k.start, k.end, new.as_bytes()),
            None if new.is_empty() => return Ok(()),
            None => {
                let rank = wb_rank("workbookProtection");
                let at = kids
                    .iter()
                    .find(|k| wb_rank(&k.local) > rank)
                    .map_or(close, |k| k.start);
                splice(&wb, at, at, new.as_bytes())
            }
        };
        let part = self.workbook_part.clone();
        self.set_part_bytes(&part, out);
        Ok(())
    }

    /// Set a sheet tab's visibility (`<sheet state=…>` in `workbook.xml`).
    /// When the hidden sheet is the active tab, `active` names the visible
    /// sheet that becomes active (Excel never leaves a hidden sheet active).
    pub fn set_sheet_state(
        &mut self,
        sheet: SheetId,
        state: SheetState,
        active: Option<u32>,
    ) -> Result<(), XlsxError> {
        let wb = self.workbook_bytes()?;
        let (kids, _) = root_children(&wb)?;
        let sheets = kids
            .iter()
            .find(|k| k.local == "sheets")
            .ok_or_else(|| XlsxError::Structure("workbook has no <sheets>".into()))?;
        let (items, _) = crate::splice::children_of(&wb, sheets)?;
        let span = items
            .iter()
            .filter(|s| s.local == "sheet")
            .nth(sheet as usize)
            .ok_or_else(|| XlsxError::Structure(format!("no <sheet> row {sheet}")))?;
        let mut a = attrs_of(&wb, span)?;
        set_attr(&mut a, "state", state.as_xml().map(str::to_string));
        let mut out = replace_start_tag(&wb, span, &render_tag(&span.qname, &a, span.empty));
        if let (Some(active), true) = (active, state != SheetState::Visible) {
            let (kids, _) = root_children(&out)?;
            if let Some(bv) = kids.iter().find(|k| k.local == "bookViews") {
                let (views, _) = crate::splice::children_of(&out, bv)?;
                for v in views.iter().rev().filter(|v| v.local == "workbookView") {
                    let mut va = attrs_of(&out, v)?;
                    let cur: u32 = crate::splice::attr_local(&va, "activeTab")
                        .and_then(|s| s.parse().ok())
                        .unwrap_or(0);
                    if cur == sheet as u32 {
                        let keep = if active == 0 {
                            None
                        } else {
                            Some(active.to_string())
                        };
                        set_attr(&mut va, "activeTab", keep);
                        out = replace_start_tag(&out, v, &render_tag(&v.qname, &va, v.empty));
                    }
                }
            }
        }
        let part = self.workbook_part.clone();
        self.set_part_bytes(&part, out);
        Ok(())
    }
}

impl XlsxDocument {
    /// Keep `<sheetFormatPr outlineLevelRow/outlineLevelCol>` at the sheet's
    /// deepest outline levels (Excel draws the outline buttons from them).
    /// A sheet without the element gets one only when it has an outline.
    pub fn set_outline_levels(
        &mut self,
        sheet: SheetId,
        rows: u8,
        cols: u8,
    ) -> Result<(), XlsxError> {
        let prefix = self.ws_prefix(sheet);
        let mut n = match self.ws_child(sheet, "sheetFormatPr") {
            Some(b) => crate::xtree::XNode::parse(b)?,
            None if rows == 0 && cols == 0 => return Ok(()),
            None => crate::xtree::XNode::new(format!("{prefix}sheetFormatPr"))
                .with_attr("defaultRowHeight", "15"),
        };
        let before = n.clone();
        n.set("outlineLevelRow", (rows > 0).then(|| rows.to_string()));
        n.set("outlineLevelCol", (cols > 0).then(|| cols.to_string()));
        if n == before {
            return Ok(());
        }
        self.set_ws_child(sheet, "sheetFormatPr", Some(n.to_xml().into_bytes()))
    }
}
