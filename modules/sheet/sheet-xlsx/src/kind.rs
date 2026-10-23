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

//! The four SpreadsheetML package kinds and the workbook's reference mode
//! (sheet ADR 521).
//!
//! `.xlsx`, `.xlsm`, `.xltx` and `.xltm` are the same OPC package; only the
//! content type of the workbook part tells them apart (ECMA-376 Part 1
//! §12.3.23 and [MS-OFFMACRO2]). A macro-enabled package also holds the VBA
//! project (`xl/vbaProject.bin`, related from the workbook) — an opaque part
//! that round-trips byte for byte and is never executed. So every kind opens
//! through [`XlsxDocument::open`] unchanged; this module reads the kind and
//! changes it: a template becomes a workbook of the same macro flavour when
//! it is opened ([`WorkbookKind::instantiated`]), and saving a macro-enabled
//! workbook as `.xlsx` removes its VBA project, which Excel refuses to open
//! in an `.xlsx`.
//!
//! The reference mode is the workbook's `<calcPr refMode="R1C1"/>`: Excel
//! keeps the A1/R1C1 display choice in the file, so it travels with the
//! workbook. Formulas are stored in A1 either way.

use crate::error::XlsxError;
use crate::opc::{PartEntry, CONTENT_TYPES_PART};
use crate::rels::{parse_rels, part_dir, rels_part_name, resolve_target};
use crate::splice::{
    attr_local, attrs_of, prefix_of, render_tag, replace_start_tag, root_children, set_attr, splice,
};
use crate::XlsxDocument;

/// A SpreadsheetML package kind, by the workbook part's content type.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WorkbookKind {
    /// `.xlsx` — a workbook.
    Xlsx,
    /// `.xlsm` — a macro-enabled workbook.
    Xlsm,
    /// `.xltx` — a template.
    Xltx,
    /// `.xltm` — a macro-enabled template.
    Xltm,
}

impl WorkbookKind {
    /// The workbook part's content type.
    pub const fn content_type(self) -> &'static str {
        match self {
            WorkbookKind::Xlsx => {
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"
            }
            WorkbookKind::Xlsm => "application/vnd.ms-excel.sheet.macroEnabled.main+xml",
            WorkbookKind::Xltx => {
                "application/vnd.openxmlformats-officedocument.spreadsheetml.template.main+xml"
            }
            WorkbookKind::Xltm => "application/vnd.ms-excel.template.macroEnabled.main+xml",
        }
    }

    /// The kind a workbook-part content type names (`None`: not one of the
    /// four).
    pub fn from_content_type(ct: &str) -> Option<WorkbookKind> {
        let ct = ct.trim();
        [
            WorkbookKind::Xlsx,
            WorkbookKind::Xlsm,
            WorkbookKind::Xltx,
            WorkbookKind::Xltm,
        ]
        .into_iter()
        .find(|k| k.content_type().eq_ignore_ascii_case(ct))
    }

    /// The file extension (`"xlsm"`, without the dot).
    pub const fn extension(self) -> &'static str {
        match self {
            WorkbookKind::Xlsx => "xlsx",
            WorkbookKind::Xlsm => "xlsm",
            WorkbookKind::Xltx => "xltx",
            WorkbookKind::Xltm => "xltm",
        }
    }

    /// The kind an extension names (`"XLSM"` or `".xlsm"`).
    pub fn from_extension(ext: &str) -> Option<WorkbookKind> {
        let ext = ext.trim().trim_start_matches('.');
        [
            WorkbookKind::Xlsx,
            WorkbookKind::Xlsm,
            WorkbookKind::Xltx,
            WorkbookKind::Xltm,
        ]
        .into_iter()
        .find(|k| k.extension().eq_ignore_ascii_case(ext))
    }

    /// A template?
    pub const fn is_template(self) -> bool {
        matches!(self, WorkbookKind::Xltx | WorkbookKind::Xltm)
    }

    /// A macro-enabled kind?
    pub const fn has_macros(self) -> bool {
        matches!(self, WorkbookKind::Xlsm | WorkbookKind::Xltm)
    }

    /// What opening this kind gives: a template becomes a workbook of the
    /// same macro flavour (Excel's "new workbook from template").
    pub const fn instantiated(self) -> WorkbookKind {
        match self {
            WorkbookKind::Xltx => WorkbookKind::Xlsx,
            WorkbookKind::Xltm => WorkbookKind::Xlsm,
            k => k,
        }
    }
}

/// The workbook → VBA project relationship type (suffix).
const REL_VBA_PROJECT: &str = "/vbaProject";

impl XlsxDocument {
    /// The package kind, from the workbook part's content type. A package
    /// whose type is none of the four reads as `.xlsx`.
    pub fn kind(&self) -> WorkbookKind {
        self.container
            .content_types
            .content_type_of(&format!("/{}", self.workbook_part))
            .and_then(WorkbookKind::from_content_type)
            .unwrap_or(WorkbookKind::Xlsx)
    }

    /// Whether the package holds a VBA project part.
    pub fn has_vba_project(&self) -> bool {
        !self.vba_parts().is_empty()
    }

    /// Make the package a `kind`: the workbook part's content type changes
    /// (a byte splice of its `<Override>`), and a kind without macros loses
    /// the VBA project — the part, its own relationships' parts, their
    /// content types and the workbook relationship. Everything else is kept.
    pub fn set_kind(&mut self, kind: WorkbookKind) -> Result<(), XlsxError> {
        if !kind.has_macros() {
            self.drop_vba_project()?;
        }
        if self.kind() == kind {
            return Ok(());
        }
        let pn = format!("/{}", self.workbook_part);
        let ct = kind.content_type();
        let mut found = false;
        for (name, ty) in self.container.content_types.overrides.iter_mut() {
            if name.eq_ignore_ascii_case(&pn) {
                *ty = ct.to_string();
                found = true;
            }
        }
        if !found {
            return self.add_override(&self.workbook_part.clone(), ct);
        }
        if let Some(raw) = self.part_bytes(CONTENT_TYPES_PART) {
            let (kids, _) = root_children(&raw)?;
            let mut out = raw.clone();
            for span in kids.iter().rev().filter(|k| k.local == "Override") {
                let mut a = attrs_of(&raw, span)?;
                if attr_local(&a, "PartName").is_some_and(|p| p.eq_ignore_ascii_case(&pn)) {
                    set_attr(&mut a, "ContentType", Some(ct.to_string()));
                    out = replace_start_tag(&out, span, &render_tag(&span.qname, &a, span.empty));
                }
            }
            self.set_part_bytes(CONTENT_TYPES_PART, out);
        }
        Ok(())
    }

    /// The VBA project's parts: each part the workbook relates as a VBA
    /// project, and the parts that part relates in turn (its signature).
    fn vba_parts(&self) -> Vec<String> {
        let Some(rels) = self
            .part_bytes(&self.wb_rels_part)
            .and_then(|b| parse_rels(&b).ok())
        else {
            return Vec::new();
        };
        let base = part_dir(&self.workbook_part);
        let mut parts = Vec::new();
        for r in rels.items.iter().filter(|r| r.is_type(REL_VBA_PROJECT)) {
            let part = resolve_target(base, &r.target);
            if self.container.part(&part).is_none() {
                continue;
            }
            let own = rels_part_name(&part);
            if let Some(sub) = self.part_bytes(&own).and_then(|b| parse_rels(&b).ok()) {
                for s in &sub.items {
                    let target = resolve_target(part_dir(&part), &s.target);
                    if self.container.part(&target).is_some() {
                        parts.push(target);
                    }
                }
                parts.push(own);
            }
            parts.push(part);
        }
        parts
    }

    fn drop_vba_project(&mut self) -> Result<(), XlsxError> {
        let parts = self.vba_parts();
        if parts.is_empty() {
            return Ok(());
        }
        // The workbook relationship(s).
        if let Some(raw) = self.part_bytes(&self.wb_rels_part) {
            let (kids, _) = root_children(&raw)?;
            let mut out = raw.clone();
            for span in kids.iter().rev().filter(|k| k.local == "Relationship") {
                let a = attrs_of(&raw, span)?;
                if attr_local(&a, "Type").is_some_and(|t| t.ends_with(REL_VBA_PROJECT)) {
                    out = splice(&out, span.start, span.end, b"");
                }
            }
            let rels_part = self.wb_rels_part.clone();
            self.set_part_bytes(&rels_part, out);
        }
        // The content-type overrides of the dropped parts.
        let names: Vec<String> = parts.iter().map(|p| format!("/{p}")).collect();
        self.container
            .content_types
            .overrides
            .retain(|(pn, _)| !names.iter().any(|n| n.eq_ignore_ascii_case(pn)));
        if let Some(raw) = self.part_bytes(CONTENT_TYPES_PART) {
            let (kids, _) = root_children(&raw)?;
            let mut out = raw.clone();
            for span in kids.iter().rev().filter(|k| k.local == "Override") {
                let a = attrs_of(&raw, span)?;
                if attr_local(&a, "PartName")
                    .is_some_and(|p| names.iter().any(|n| n.eq_ignore_ascii_case(&p)))
                {
                    out = splice(&out, span.start, span.end, b"");
                }
            }
            self.set_part_bytes(CONTENT_TYPES_PART, out);
        }
        // The parts themselves.
        self.container
            .parts
            .retain(|p: &PartEntry| !parts.iter().any(|n| n == p.name()));
        self.container.dirty = true;
        Ok(())
    }

    /// Whether the workbook shows references in R1C1 (`<calcPr
    /// refMode="R1C1"/>`).
    pub fn ref_mode_r1c1(&self) -> bool {
        let Ok(wb) = self.workbook_bytes() else {
            return false;
        };
        let Ok((kids, _)) = root_children(&wb) else {
            return false;
        };
        kids.iter()
            .find(|k| k.local == "calcPr")
            .and_then(|span| attrs_of(&wb, span).ok())
            .and_then(|a| attr_local(&a, "refMode"))
            .is_some_and(|m| m.trim().eq_ignore_ascii_case("R1C1"))
    }

    /// Set the workbook's reference mode: a byte splice of `<calcPr>`'s
    /// `refMode` (A1 is the default, so it removes the attribute), or a new
    /// `<calcPr refMode="R1C1"/>` in schema position. No change, no splice.
    pub fn set_ref_mode_r1c1(&mut self, r1c1: bool) -> Result<(), XlsxError> {
        if self.ref_mode_r1c1() == r1c1 {
            return Ok(());
        }
        let wb = self.workbook_bytes()?;
        let (kids, close) = root_children(&wb)?;
        let value = r1c1.then(|| "R1C1".to_string());
        let out = if let Some(span) = kids.iter().find(|k| k.local == "calcPr") {
            let mut a = attrs_of(&wb, span)?;
            set_attr(&mut a, "refMode", value);
            replace_start_tag(&wb, span, &render_tag(&span.qname, &a, span.empty))
        } else {
            // ECMA-376 §18.2.27: after sheets / functionGroups /
            // externalReferences / definedNames.
            let anchor = kids
                .iter()
                .filter(|k| {
                    matches!(
                        k.local.as_str(),
                        "sheets" | "functionGroups" | "externalReferences" | "definedNames"
                    )
                })
                .map(|k| k.end)
                .max()
                .unwrap_or(close);
            let prefix = kids
                .iter()
                .find(|k| k.local == "sheets")
                .map(|k| prefix_of(&k.qname).to_string())
                .unwrap_or_default();
            let tag = render_tag(
                &format!("{prefix}calcPr"),
                &[("refMode".into(), "R1C1".into())],
                true,
            );
            splice(&wb, anchor, anchor, tag.as_bytes())
        };
        let part = self.workbook_part.clone();
        self.set_part_bytes(&part, out);
        Ok(())
    }
}

#[cfg(test)]
#[allow(non_snake_case)]
mod tests {
    use super::*;

    #[test]
    fn kinds_by_content_type_and_extension__feat__sheet_xlsx_roundtrip() {
        for k in [
            WorkbookKind::Xlsx,
            WorkbookKind::Xlsm,
            WorkbookKind::Xltx,
            WorkbookKind::Xltm,
        ] {
            assert_eq!(WorkbookKind::from_content_type(k.content_type()), Some(k));
            assert_eq!(WorkbookKind::from_extension(k.extension()), Some(k));
        }
        assert_eq!(WorkbookKind::Xltm.instantiated(), WorkbookKind::Xlsm);
        assert_eq!(WorkbookKind::Xltx.instantiated(), WorkbookKind::Xlsx);
        assert_eq!(
            WorkbookKind::from_extension(".XLSM"),
            Some(WorkbookKind::Xlsm)
        );
        assert_eq!(WorkbookKind::from_content_type("text/plain"), None);
    }
}
