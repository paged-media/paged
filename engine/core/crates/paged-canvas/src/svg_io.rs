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

//! SVG in and out of a document (engine ADR 1031): the model side of
//! `RequestSvgImport` and `ExportSvg`. The lowering itself is
//! `paged-svg`'s; this module hands it the page, the document's fonts and
//! swatches, and a page's display list.

use std::collections::HashMap;

use paged_svg::{
    ExportFont, ExportInput, FontName, ImportDocument, ImportFont, ImportTarget, SvgExportOptions,
    SvgImportOptions, SvgImportPlan, SvgReport,
};

use crate::element_selection::ElementId;
use crate::model::CanvasModel;
use paged_renderer::PageId;

/// The document's swatches, as the import sees them.
struct Swatches<'a>(&'a paged_scene::Document);

impl ImportDocument for Swatches<'_> {
    fn swatch_rgb(&self, id: &str) -> Option<[f32; 3]> {
        let c = self.0.palette.colors.get(id)?;
        (c.space == paged_model::ColorSpace::Rgb && c.value.len() == 3)
            .then(|| [c.value[0], c.value[1], c.value[2]])
    }
    fn has_gradient(&self, id: &str) -> bool {
        self.0.palette.gradients.contains_key(id)
    }
}

/// The faces of a list's glyph runs by font id: the document's
/// registered faces by the name they were registered with, then any other
/// face of the font table by the (family, style) that resolves to it
/// without substitution.
struct Fonts(HashMap<u32, ExportFont>);

/// The renderer's font id of a face: FNV-1a over the whole file.
fn font_id(bytes: &[u8]) -> u32 {
    let mut h: u32 = 0x811c_9dc5;
    for &b in bytes {
        h ^= b as u32;
        h = h.wrapping_mul(0x0100_0193);
    }
    h
}

impl Fonts {
    fn of(table: &paged_renderer::FontTable, registry: &[crate::model::FontEntry]) -> Self {
        let mut out = HashMap::new();
        for f in registry {
            let Some(upem) = paged_svg::units_per_em(&f.bytes) else {
                continue;
            };
            out.entry(font_id(&f.bytes)).or_insert(ExportFont {
                family: f.family.clone(),
                style: f.style.clone(),
                units_per_em: upem,
            });
        }
        for (family, style) in table.keys() {
            let Some((id, substituted)) = table.resolution(family, style.as_deref()) else {
                continue;
            };
            if substituted || out.contains_key(&id) {
                continue;
            }
            let Some(upem) = table.face_data(id).and_then(paged_svg::units_per_em) else {
                continue;
            };
            out.insert(
                id,
                ExportFont {
                    family: family.clone(),
                    style: style.clone(),
                    units_per_em: upem,
                },
            );
        }
        Fonts(out)
    }
}

impl FontName for Fonts {
    fn font(&self, font_id: u32) -> Option<ExportFont> {
        self.0.get(&font_id).cloned()
    }
}

/// Why an SVG export could not be written.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SvgExportError {
    UnknownPage(String),
    /// Some of the items are not on the page.
    Build(String),
}

impl std::fmt::Display for SvgExportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SvgExportError::UnknownPage(p) => write!(f, "no page {p}"),
            SvgExportError::Build(e) => write!(f, "{e}"),
        }
    }
}

impl CanvasModel {
    /// Engine ADR 1031 — plan the import of `svg` onto `page_id`: one
    /// batch (apply it with `Mutate`, one undo step) and the report of
    /// what was approximated or left out. Reads only.
    pub fn svg_import_plan(
        &self,
        page_id: &PageId,
        svg: &[u8],
        options: &SvgImportOptions,
    ) -> SvgImportPlan {
        let Some((_, origin, _)) = self.page_insert_context(page_id) else {
            return SvgImportPlan {
                mutation: None,
                report: SvgReport::default(),
                width: 0.0,
                height: 0.0,
                error: Some(format!("no page {}", page_id.0)),
            };
        };
        let size = self
            .pages()
            .into_iter()
            .find(|p| p.self_id == page_id.0)
            .map(|p| p.size_pt)
            .unwrap_or([612.0, 792.0]);
        let target = ImportTarget {
            page_id: page_id.clone(),
            page_origin: [origin.0, origin.1],
            page_size: size,
        };
        // One face per family: the import lays text out with it and
        // keeps text whose family the document has.
        let mut fonts: Vec<ImportFont<'_>> = Vec::new();
        for f in self.document_fonts() {
            if !fonts.iter().any(|x| x.family == f.family) {
                fonts.push(ImportFont {
                    family: &f.family,
                    bytes: &f.bytes,
                });
            }
        }
        paged_svg::plan_import(svg, &target, options, &fonts, &Swatches(self.scene()))
    }

    /// Engine ADR 1031 — the page `page_id` as an SVG document; with
    /// `only`, nothing but those items, the region fitted to what they
    /// draw. Reads only.
    pub fn export_svg(
        &self,
        page_id: &PageId,
        only: &[ElementId],
        options: &SvgExportOptions,
    ) -> Result<(String, SvgReport), SvgExportError> {
        // The export build: the glyph-run side channel is on there, so
        // text can be written as text (and the page is drawn as the
        // exports draw it, without the canvas's markers).
        let unknown = || SvgExportError::UnknownPage(page_id.0.clone());
        let doc;
        let filtered;
        let page = if only.is_empty() {
            doc = self
                .export_build()
                .map_err(|e| SvgExportError::Build(e.to_string()))?;
            doc.pages
                .iter()
                .find(|p| &p.id == page_id)
                .ok_or_else(unknown)?
        } else {
            filtered = self
                .build_page_filtered(page_id, &[], only)
                .map_err(|_| unknown())?;
            &filtered
        };
        let fonts = Fonts::of(self.font_table(), self.document_fonts());
        let input = ExportInput {
            list: &page.list,
            width: page.width_pt,
            height: page.height_pt,
            fonts: &fonts,
            fit_to_content: !only.is_empty(),
        };
        Ok(paged_svg::export_display_list(&input, options))
    }
}
