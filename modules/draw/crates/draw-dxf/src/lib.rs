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

//! # paged.draw — DXF interchange (draw ADR 364)
//!
//! DXF goes in and out of the document THROUGH SVG, so there is one
//! lowering into native items and one reading of what a page draws — the
//! engine's (`paged-svg`, engine ADR 1031), never a second copy here:
//!
//! - **Import** ([`dxf_to_svg`]): the `dxf` crate reads the drawing, this
//!   crate writes its model space as an SVG document — one named group
//!   per layer, every curve as cubic Béziers in points — and the bundle
//!   hands that to the engine's `document.importSvg` door: one undo step,
//!   the engine's own swatches and compound paths.
//! - **Export** ([`svg_to_dxf`]): the bundle asks the engine's
//!   `document.exportSvg` door for what the selection (or the page)
//!   draws, and this crate walks that SVG with `paged-svg`'s one walker
//!   into DXF entities: `LWPOLYLINE` for straight contours, a cubic
//!   `SPLINE` (its Bézier pieces exactly) for curved ones.
//!
//! Both directions report what they could not carry (a [`Report`] of
//! coded rows), never a silent drop.

mod aci;
mod curves;
mod hatch;
mod read;
mod scan;
mod write;

pub use read::{dxf_to_svg, DxfImport};
pub use write::{svg_to_dxf, DxfExport};

/// How a construct fared.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Severity {
    /// Carried, but not exactly.
    Approximated,
    /// Left out.
    Dropped,
}

/// One row of a report: a code, what happened, how often.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub code: String,
    pub severity: Severity,
    pub message: String,
    pub count: u32,
}

/// What a conversion carried and what it could not (the shape of the
/// engine's `SvgReport`, so the bundle logs both alike).
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    /// Import: the shapes written. Export: the entities written.
    pub items: u32,
    pub notes: Vec<Note>,
}

impl Report {
    /// Count `n` occurrences of `code`.
    pub fn note_n(&mut self, code: &str, severity: Severity, message: &str, n: u32) {
        if let Some(note) = self.notes.iter_mut().find(|x| x.code == code) {
            note.count += n;
            return;
        }
        self.notes.push(Note {
            code: code.to_string(),
            severity,
            message: message.to_string(),
            count: n,
        });
    }

    pub fn approximated(&mut self, code: &str, message: &str) {
        self.note_n(code, Severity::Approximated, message, 1);
    }

    pub fn dropped(&mut self, code: &str, message: &str) {
        self.note_n(code, Severity::Dropped, message, 1);
    }

    /// The row of `code`, if it happened.
    pub fn get(&self, code: &str) -> Option<&Note> {
        self.notes.iter().find(|n| n.code == code)
    }
}

/// `s` escaped for an XML attribute.
pub(crate) fn escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            c if (c as u32) < 0x20 && c != '\t' => out.push(' '),
            c => out.push(c),
        }
    }
    out
}
