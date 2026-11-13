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

//! Engine ADR 1305 — what an opened document does not carry or show as its
//! source did, as loss entries on the load's reply (`UXI-FIL-002`,
//! `UXI-T66`): the import report's engine half.
//!
//! The IDML reader records one loss of its own: frames nested in a way it
//! cannot represent are left out (`Spread::skipped_nested_frames`). The rest
//! is what the build that follows the read could not draw as the source
//! asks: a font served by a substitute, a link that resolves to nothing or
//! does not decode, content without an interpreter, art drawn from its
//! preview, a clipping path not applied, page numbers computed by a fallback
//! rule. Layout states the source has too (overset text, a footnote that
//! does not fit) are the document's, not the import's, and are not listed.
//!
//! Codes are `idml.import.<what>`; one entry per code and message, counted,
//! with the items and the 0-based pages it stood on.

use paged_model::report::{LossEntry, LossLog, LossSeverity};
use paged_renderer::DiagnosticCode;

use crate::model::CanvasModel;

/// The code of frames the reader left out.
pub const NESTED_FRAME: &str = "idml.import.nestedFrame";

impl CanvasModel {
    /// Engine ADR 1305 — the losses of the open document against its
    /// source, as the last build found them (see the module docs). Empty
    /// for a document that carries and draws everything it names.
    pub fn import_losses(&self) -> Vec<LossEntry> {
        let mut out: Vec<LossEntry> = Vec::new();
        let skipped: usize = self
            .scene
            .spreads
            .iter()
            .map(|s| s.spread.skipped_nested_frames)
            .sum();
        if skipped > 0 {
            out.note_n(
                NESTED_FRAME,
                LossSeverity::Dropped,
                "a frame nested in another frame in a way this editor cannot hold was left out",
                skipped,
            );
        }
        for d in &self.built.diagnostics.items {
            let (code, severity) = match d.code {
                DiagnosticCode::FontSubstituted => {
                    ("idml.import.fontSubstituted", LossSeverity::Approximated)
                }
                DiagnosticCode::ImageLinkMissing => {
                    ("idml.import.linkMissing", LossSeverity::Dropped)
                }
                DiagnosticCode::ImageDecodeFailed => {
                    ("idml.import.imageUndecoded", LossSeverity::Dropped)
                }
                DiagnosticCode::ImageContentUnrenderable => {
                    ("idml.import.contentUnrenderable", LossSeverity::Dropped)
                }
                DiagnosticCode::ImageDrawnFromPreview => {
                    ("idml.import.drawnFromPreview", LossSeverity::Approximated)
                }
                DiagnosticCode::ImageClippingPathDeferred => {
                    ("idml.import.clippingPath", LossSeverity::Approximated)
                }
                DiagnosticCode::SectionNumberingFallback => {
                    ("idml.import.pageNumbering", LossSeverity::Info)
                }
                // The document's own layout states, not the import's.
                DiagnosticCode::OversetTextDropped | DiagnosticCode::FootnoteOverflow => continue,
            };
            let mut entry = LossEntry::new(code, severity, d.message.clone());
            if let Some(page) = d.page_index {
                entry.pages.push(page);
            }
            if let Some(frame) = d.frame_id.as_deref() {
                entry = entry.on(frame);
            }
            out.push_loss(entry);
        }
        out
    }
}
