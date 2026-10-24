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

//! The workbook's document-style mapping doors (sheet ADR 524): "Use
//! document styles", the table from Excel named styles to document styles,
//! and the named styles the cells use with their counts. The map lives in
//! `styles.xml` (spliced, re-parsed); no value changes, nothing
//! recalculates — only what the cells resolve to.

use std::collections::BTreeMap;

use sheet_lower::docmap::NORMAL;
use sheet_lower::{DocStyleMap, DocStyleTarget};

use super::{SessionError, SheetSession};

/// One Excel named style as the mapping table lists it.
#[derive(serde::Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NamedStyleUsage {
    /// The style name (`Normal` for the workbook's built-in 0, whatever its
    /// localized name).
    pub name: String,
    pub builtin_id: Option<u32>,
    /// Populated cells (styled blanks included) that use it.
    pub cells: u32,
    /// Its font, for creating a document style from it: face, size (pt),
    /// bold, italic and the resolved colour `#RRGGBB`.
    pub font_name: Option<String>,
    pub font_size: Option<f64>,
    pub bold: bool,
    pub italic: bool,
    pub color: Option<String>,
}

impl SheetSession {
    /// The workbook's document-style mapping.
    pub fn doc_style_map(&self) -> DocStyleMap {
        self.doc.doc_style_map().clone()
    }

    /// Replace the whole mapping (one splice; the undo of any map change).
    pub fn set_doc_style_map(&mut self, map: DocStyleMap) -> Result<(), SessionError> {
        let mut clean = DocStyleMap {
            enabled: map.enabled,
            ..Default::default()
        };
        for (name, t) in map.entries {
            if name.trim().is_empty() {
                return Err(SessionError("a mapping needs a style name".into()));
            }
            clean.set(name.trim(), t);
        }
        if clean == *self.doc.doc_style_map() {
            return Ok(());
        }
        let table = self
            .doc
            .set_doc_style_map(&clean)
            .map_err(|e| SessionError(e.to_string()))?;
        self.engine_mut().replace_styles(table);
        Ok(())
    }

    /// Turn "Use document styles" on or off (the table is kept).
    pub fn set_doc_styles_enabled(&mut self, on: bool) -> Result<(), SessionError> {
        let mut map = self.doc_style_map();
        map.enabled = on;
        self.set_doc_style_map(map)
    }

    /// Map one Excel named style (an empty target clears its entry).
    pub fn set_doc_style_mapping(
        &mut self,
        style: &str,
        target: DocStyleTarget,
    ) -> Result<(), SessionError> {
        if style.trim().is_empty() {
            return Err(SessionError("a mapping needs a style name".into()));
        }
        let mut map = self.doc_style_map();
        map.set(style.trim(), target);
        self.set_doc_style_map(map)
    }

    /// The workbook's named styles (Normal first) with how many cells use
    /// each, and the styles cells use that the workbook does not list.
    pub fn named_style_usage(&self) -> Vec<NamedStyleUsage> {
        let vs = &self.doc.visual_styles;
        let mut counts: BTreeMap<String, u32> = BTreeMap::new();
        let mut by_id: BTreeMap<u32, String> = BTreeMap::new();
        for ws in &self.engine().model().sheets {
            for cell in ws.cells.values() {
                let name = by_id.entry(cell.style.0).or_insert_with(|| {
                    vs.model(cell.style)
                        .and_then(|m| m.named_style.clone())
                        .unwrap_or_else(|| NORMAL.to_string())
                });
                *counts.entry(name.clone()).or_default() += 1;
            }
        }
        let palette = vs.palette();
        let mut out: Vec<NamedStyleUsage> = Vec::new();
        for n in vs.named_styles() {
            let name = if n.builtin_id == Some(0) {
                NORMAL.to_string()
            } else {
                n.name.clone()
            };
            if out.iter().any(|u| u.name == name) {
                continue;
            }
            let f = &n.visual.font.font;
            out.push(NamedStyleUsage {
                cells: counts.remove(&name).unwrap_or(0),
                builtin_id: n.builtin_id,
                font_name: f.name.clone(),
                font_size: f.size,
                bold: f.bold,
                italic: f.italic,
                color: f
                    .color
                    .as_ref()
                    .and_then(|c| sheet_format::resolve(c, palette))
                    .map(|r| r.hex()),
                name,
            });
        }
        if !out.iter().any(|u| u.name == NORMAL) {
            let f = vs.default_font();
            out.insert(
                0,
                NamedStyleUsage {
                    name: NORMAL.to_string(),
                    builtin_id: Some(0),
                    cells: counts.remove(NORMAL).unwrap_or(0),
                    font_name: f.name.clone(),
                    font_size: f.size,
                    bold: f.bold,
                    italic: f.italic,
                    color: None,
                },
            );
        }
        // A style a cell names but the workbook does not list (defensive).
        for (name, cells) in counts {
            out.push(NamedStyleUsage {
                name,
                builtin_id: None,
                cells,
                font_name: None,
                font_size: None,
                bold: false,
                italic: false,
                color: None,
            });
        }
        // Normal first, then document order.
        if let Some(i) = out.iter().position(|u| u.name == NORMAL) {
            let n = out.remove(i);
            out.insert(0, n);
        }
        out
    }
}

/// The document styles and swatches the workbook names: in the cells' own
/// references and in the mapping table (for "N references missing").
#[derive(serde::Serialize, Debug, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct DocReferences {
    /// Paragraph / character / cell style ids, each with how many cells
    /// name it directly (0 = only the mapping names it).
    pub para_styles: BTreeMap<String, u32>,
    pub char_styles: BTreeMap<String, u32>,
    pub cell_styles: BTreeMap<String, u32>,
    /// Swatch ids with how many cells name them.
    pub swatches: BTreeMap<String, u32>,
}

impl SheetSession {
    /// Tell the mapping which document style ids exist (`None` = unknown).
    /// Returns whether anything the cells resolve to changed.
    pub fn set_document_styles_available(
        &mut self,
        ids: Option<Vec<String>>,
    ) -> Result<bool, SessionError> {
        let ids: Option<std::collections::BTreeSet<String>> = ids.map(|v| v.into_iter().collect());
        if self.doc.visual_styles.doc_available() == ids.as_ref() {
            return Ok(false);
        }
        let inert = self.doc.doc_style_map().is_inert();
        let table = self
            .doc
            .set_doc_styles_available(ids)
            .map_err(|e| SessionError(e.to_string()))?;
        self.engine_mut().replace_styles(table);
        Ok(!inert)
    }

    /// Every document style and swatch the workbook names.
    pub fn doc_references(&self) -> DocReferences {
        let vs = &self.doc.visual_styles;
        let mut per_style: BTreeMap<u32, u32> = BTreeMap::new();
        for ws in &self.engine().model().sheets {
            for cell in ws.cells.values() {
                *per_style.entry(cell.style.0).or_default() += 1;
            }
        }
        let mut out = DocReferences::default();
        let bump = |m: &mut BTreeMap<String, u32>, id: &Option<String>, n: u32| {
            if let Some(id) = id {
                *m.entry(id.clone()).or_default() += n;
            }
        };
        for (&id, &n) in &per_style {
            let Some(v) = vs.model(sheet_core::StyleId(id)) else {
                continue;
            };
            bump(&mut out.para_styles, &v.font.doc_para_style, n);
            bump(&mut out.char_styles, &v.font.doc_char_style, n);
            bump(&mut out.cell_styles, &v.doc_cell_style, n);
            let mut colors: Vec<&sheet_core::visual::ColorRef> = Vec::new();
            colors.extend(v.font.font.color.as_ref());
            match &v.fill {
                sheet_core::visual::CellFill::Pattern { fg, bg, .. } => {
                    colors.extend(fg.as_ref());
                    colors.extend(bg.as_ref());
                }
                sheet_core::visual::CellFill::Gradient { stops, .. } => {
                    colors.extend(stops.iter().map(|s| &s.color));
                }
                sheet_core::visual::CellFill::None => {}
            }
            let b = &v.border;
            for e in [&b.left, &b.right, &b.top, &b.bottom, &b.diagonal] {
                colors.extend(e.color.as_ref());
            }
            let mut seen = std::collections::BTreeSet::new();
            for c in colors {
                if let Some(d) = &c.doc {
                    if seen.insert(d.id.clone()) {
                        *out.swatches.entry(d.id.clone()).or_default() += n;
                    }
                }
            }
        }
        for t in self.doc.doc_style_map().entries.values() {
            bump(&mut out.para_styles, &t.para, 0);
            bump(&mut out.char_styles, &t.char, 0);
            bump(&mut out.cell_styles, &t.cell, 0);
        }
        out
    }

    /// Point every reference to document style or swatch `from` at `to`
    /// (`model` = the new swatch's colour model). Returns how many cell
    /// records and mapping entries changed.
    pub fn remap_doc_reference(
        &mut self,
        from: &str,
        to: &str,
        model: Option<&str>,
    ) -> Result<u32, SessionError> {
        if from.is_empty() || to.is_empty() {
            return Err(SessionError("remap needs both ids".into()));
        }
        let model = match model {
            None => None,
            Some(m) => Some(
                sheet_core::visual::DocColorModel::parse(m)
                    .ok_or_else(|| SessionError(format!("unknown colour model {m:?}")))?,
            ),
        };
        let (table, n) = self
            .doc
            .remap_doc_reference(from, to, model)
            .map_err(|e| SessionError(e.to_string()))?;
        self.engine_mut().replace_styles(table);
        Ok(n)
    }
}
