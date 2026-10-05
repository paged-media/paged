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

//! The wasm-bindgen surface of paged.slide. One module serves import and
//! export; the TypeScript bundle never interprets PresentationML itself.
//!
//! Import (ADR 700): `importPptx` reads the deck, resolves its inheritance
//! and writes the complete IDML package the host opens, plus a JSON report
//! of what the bundle stores beside it (per-slide notes, transitions and
//! hidden flags by page id), the font families the deck uses and every
//! diagnostic.

use serde::Serialize;
use wasm_bindgen::prelude::*;

/// Read a `.pptx` and return the format-level IR as JSON (inspection).
#[wasm_bindgen(js_name = readPptx)]
pub fn read_pptx(bytes: &[u8]) -> Result<String, JsError> {
    let deck = pptx_import::import_pptx(bytes).map_err(|e| JsError::new(&e.to_string()))?;
    serde_json::to_string(&deck).map_err(|e| JsError::new(&e.to_string()))
}

/// The result of [`import_pptx`]: the package and its report.
#[wasm_bindgen]
pub struct Imported {
    idml: Vec<u8>,
    report: String,
}

#[wasm_bindgen]
impl Imported {
    /// The IDML package for `host.nativeDocument.open`.
    #[wasm_bindgen(getter)]
    pub fn idml(&self) -> Vec<u8> {
        self.idml.clone()
    }

    /// [`Report`] as JSON.
    #[wasm_bindgen(getter)]
    pub fn report(&self) -> String {
        self.report.clone()
    }
}

/// What an import produced beside the package.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    /// Slide size in pt.
    pub width: f64,
    pub height: f64,
    pub slides: Vec<SlideReport>,
    /// Font families the deck's text uses (the host must have them).
    pub fonts: Vec<String>,
    pub diagnostics: Vec<String>,
}

/// One slide, addressed by the page id it opens as.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlideReport {
    pub page_id: String,
    /// The source slide part (`ppt/slides/slide3.xml`).
    pub part: String,
    pub hidden: bool,
    pub notes: Option<String>,
    pub transition: Option<pptx_core::Transition>,
    /// The slide's `p:timing` element as written, kept for export.
    pub timing_xml: Option<String>,
    /// Its top-level items, bottom to top.
    pub items: Vec<ItemReport>,
}

/// A top-level item: the page element it became and where it sits.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemReport {
    pub name: String,
    /// Wire element kind (`polygon`, `rectangle`, `textFrame`, `group`).
    pub kind: String,
    /// The element's `Self` id.
    pub id: String,
    /// Page-space bounds of its outline (l, t, r, b), pt.
    pub bounds: [f64; 4],
    /// PowerPoint's `cNvPr id`.
    pub shape_id: u32,
    /// Placeholder type and idx, when it fills one.
    pub placeholder: Option<(String, Option<u32>)>,
}

/// Read a `.pptx` into the IDML package of its native slides.
#[wasm_bindgen(js_name = importPptx)]
pub fn import_pptx(bytes: &[u8], name: &str) -> Result<Imported, JsError> {
    let (idml, report) = import(bytes, name).map_err(|e| JsError::new(&e))?;
    Ok(Imported {
        idml,
        report: serde_json::to_string(&report).map_err(|e| JsError::new(&e.to_string()))?,
    })
}

/// [`import_pptx`] without the wasm types (native tests use this).
pub fn import(bytes: &[u8], name: &str) -> Result<(Vec<u8>, Report), String> {
    let deck = pptx_import::import_pptx(bytes).map_err(|e| e.to_string())?;
    let resolved = slide_resolve::resolve(&deck);
    let pkg = paged_ooxml::OpcPackage::read(bytes).map_err(|e| e.to_string())?;
    let images = |part: &str| pkg.part(part).map(|b| b.to_vec());
    let written = slide_idml::write(&resolved, &images, name)?;
    let report = Report {
        width: resolved.width,
        height: resolved.height,
        slides: resolved
            .slides
            .iter()
            .map(|s| SlideReport {
                page_id: s.id.clone(),
                part: s.part.clone(),
                hidden: s.hidden,
                notes: s.notes.clone(),
                transition: s.transition.clone(),
                timing_xml: s.timing_xml.clone(),
                items: s
                    .items
                    .iter()
                    .filter_map(|it| {
                        let (kind, id) = written.elements.get(&it.id)?;
                        Some(ItemReport {
                            name: it.name.clone(),
                            kind: kind.to_string(),
                            id: id.clone(),
                            bounds: bounds(it),
                            shape_id: it.meta.shape_id,
                            placeholder: it.meta.placeholder.clone(),
                        })
                    })
                    .collect(),
            })
            .collect(),
        fonts: resolved.fonts.clone(),
        diagnostics: deck
            .diagnostics
            .iter()
            .chain(&resolved.diagnostics)
            .chain(&written.diagnostics)
            .cloned()
            .collect(),
    };
    Ok((written.idml, report))
}

/// Page-space bounds of an item's drawn outline (a group: its members').
fn bounds(it: &slide_resolve::model::Item) -> [f64; 4] {
    use slide_resolve::model::ItemKind;
    let mut b = [f64::MAX, f64::MAX, f64::MIN, f64::MIN];
    let mut add = |m: &[f64; 6], x: f64, y: f64| {
        let (px, py) = (m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]);
        b = [b[0].min(px), b[1].min(py), b[2].max(px), b[3].max(py)];
    };
    match &it.kind {
        ItemKind::Group { children } => {
            for c in children {
                let cb = bounds(c);
                add(&[1.0, 0.0, 0.0, 1.0, 0.0, 0.0], cb[0], cb[1]);
                add(&[1.0, 0.0, 0.0, 1.0, 0.0, 0.0], cb[2], cb[3]);
            }
        }
        // A filled shape's polygon carries its filled subpaths (the writer
        // puts stroke-only detail paths on a second polygon).
        ItemKind::Shape { outline, fill, .. } if !outline.is_empty() => {
            let filled = !matches!(fill, slide_resolve::model::Paint::None);
            for sp in outline.iter().filter(|s| s.filled || !filled) {
                for p in &sp.points {
                    add(&it.transform, p.anchor.0, p.anchor.1);
                }
            }
        }
        ItemKind::Picture { outline, .. } if !outline.is_empty() => {
            for sp in outline {
                for p in &sp.points {
                    add(&it.transform, p.anchor.0, p.anchor.1);
                }
            }
        }
        _ => {
            for (x, y) in [(0.0, 0.0), (it.w, 0.0), (it.w, it.h), (0.0, it.h)] {
                add(&it.transform, x, y);
            }
        }
    }
    b
}
