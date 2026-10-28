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

//! `pdf-import` — the `@paged-media/pdf` bundle's Rust half: the mapper from
//! a reading-ordered Document IR (produced by the bundle's PDFium
//! reconstruction) into a native paged document, and the page reader of
//! place-as-vectors.
//!
//! Pipeline: [`ir::DocumentIr`] JSON → [`build::build_document`] →
//! `paged_scene::Document` → [`paged_store::package::wrap_document`] → `.paged`
//! OCF bytes that the editor opens through the existing
//! `host.nativeDocument.open` door with **no IDML parse** (the model rides inside `paged/core/model/document.pgm`).
//!
//! The mapper itself is PDF-blind: every text heuristic lives in the TS
//! bundle next to PDFium, and a model-shape change is a compile error here
//! rather than silent data loss in hand-rolled JSON.
//!
//! Beside it, [`vectors`] reads a page's drawing (paths, paints, clips,
//! groups, masks, images, glyph outlines) with the engine's own PDF
//! interpreter, and [`snippet`] lowers it — through the same model mapping
//! ([`lower`]) the open path uses — into an engine snippet the editor pastes:
//! place-as-vectors (publish ADR 658). [`pdf_to_paged`] opens a PDF with its
//! vectors read that way and its text from the IR.

pub mod build;
pub mod ir;
mod lower;
pub mod snippet;
pub mod vectors;

pub use lower::TextMode;

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

/// [`pdf_ir_to_paged`] with the PDF's bytes: vectors and images come from
/// the page reader, text from the IR ([`build::build_document_from`]).
pub fn pdf_to_paged(bytes: &[u8], ir_json: &str) -> Result<Vec<u8>, Error> {
    let ir: ir::DocumentIr = serde_json::from_str(ir_json)?;
    let doc = build::build_document_from(&ir, Some(bytes))?;
    let (w, h) = ir
        .pages
        .first()
        .map(|p| (p.width_pt, p.height_pt))
        .unwrap_or((612.0, 792.0));
    paged_store::package::wrap_document(&doc, FALLBACK_NAME, w, h).map_err(Error::Pgm)
}

/// What a file is ([`vectors::inspect`]) as JSON, or `"<code>: <why>"`.
pub fn pdf_inspect(bytes: &[u8]) -> Result<String, String> {
    let info = vectors::inspect(bytes).map_err(|e| format!("{}: {e}", e.code()))?;
    serde_json::to_string(&info).map_err(|e| format!("unreadable: {e}"))
}

/// A page placed as a snippet ([`snippet::place`]): the request and the
/// answer as JSON, a refusal as `"<code>: <why>"`.
pub fn pdf_place(bytes: &[u8], request_json: &str) -> Result<String, String> {
    let req: snippet::PlaceRequest =
        serde_json::from_str(request_json).map_err(|e| format!("invalidRequest: {e}"))?;
    let result = snippet::place(bytes, &req).map_err(|e| format!("{}: {e}", e.code()))?;
    serde_json::to_string(&result).map_err(|e| format!("invalidRequest: {e}"))
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

/// wasm-bindgen: [`pdf_to_paged`].
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn pdf_to_paged_wasm(bytes: &[u8], ir_json: &str) -> Result<Vec<u8>, wasm_bindgen::JsError> {
    pdf_to_paged(bytes, ir_json).map_err(|e| wasm_bindgen::JsError::new(&e.to_string()))
}

/// wasm-bindgen: [`pdf_inspect`].
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn pdf_inspect_wasm(bytes: &[u8]) -> Result<String, wasm_bindgen::JsError> {
    pdf_inspect(bytes).map_err(|e| wasm_bindgen::JsError::new(&e))
}

/// wasm-bindgen: [`pdf_place`].
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn pdf_place_wasm(bytes: &[u8], request_json: &str) -> Result<String, wasm_bindgen::JsError> {
    pdf_place(bytes, request_json).map_err(|e| wasm_bindgen::JsError::new(&e))
}
