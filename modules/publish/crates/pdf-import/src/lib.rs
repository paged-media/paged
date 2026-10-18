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

//! `pdf-import` — the **PDF-blind** mapper from a reading-ordered Document IR
//! (produced by the `@paged-media/pdf` bundle's pdf.js reconstruction) into a
//! native paged document.
//!
//! Pipeline: [`ir::DocumentIr`] JSON → [`build::build_document`] →
//! `paged_scene::Document` → [`paged_store::package::wrap_document`] → `.paged`
//! OCF bytes that the editor opens through the existing
//! `host.nativeDocument.open` door with **no IDML parse** (the model rides inside `paged/core/model/document.pgm`).
//!
//! Deliberately tiny: serde + zip + the paged model. It knows nothing about
//! PDF — pdf.js and every reconstruction heuristic live in the TS bundle, so
//! the wasm stays small and rebuilds rarely, and a model-shape change is a
//! compile error here rather than silent data loss in hand-rolled JSON.

pub mod build;
pub mod ir;

/// Errors mapping a Document IR into `.paged` bytes.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("invalid Document IR json: {0}")]
    Json(#[from] serde_json::Error),
    /// pgm encode of the built model (distinct from IR parse so drift is
    /// attributable). Constructed from [`paged_store::package::wrap_document`].
    #[error("native pgm encode failed: {0}")]
    Pgm(serde_json::Error),
    #[error("base64 image decode: {0}")]
    Base64(#[from] base64::DecodeError),
    #[error("model build: {0}")]
    Build(String),
}

/// Map a Document-IR JSON string to `.paged` OCF bytes. The single entry the
/// wasm binding and the native tests share.
pub fn pdf_ir_to_paged(ir_json: &str) -> Result<Vec<u8>, Error> {
    let ir: ir::DocumentIr = serde_json::from_str(ir_json)?;
    let doc = build::build_document(&ir)?;
    // The container is core's one `.paged` writer (shared with every native
    // producer, so the format cannot drift between plugins). Its IDML fallback
    // skeleton (only parsed if the pgm ever fails to decode) takes the first
    // page's size so a drift-degraded open is at least the right paper size;
    // Letter if the document has no pages.
    let (w, h) = ir
        .pages
        .first()
        .map(|p| (p.width_pt, p.height_pt))
        .unwrap_or((612.0, 792.0));
    paged_store::package::wrap_document(&doc, FALLBACK_NAME, w, h).map_err(Error::Pgm)
}

/// The document name the fallback designmap carries. The IR has no source
/// file name, so this stays the fixed name the private writer always used.
const FALLBACK_NAME: &str = "Imported.pdf";

/// wasm-bindgen surface consumed by the bundle's `engine-loader.ts`. Returns
/// the `.paged` bytes or a JS error carrying the mapper's message.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn pdf_ir_to_paged_wasm(ir_json: &str) -> Result<Vec<u8>, wasm_bindgen::JsError> {
    pdf_ir_to_paged(ir_json).map_err(|e| wasm_bindgen::JsError::new(&e.to_string()))
}
