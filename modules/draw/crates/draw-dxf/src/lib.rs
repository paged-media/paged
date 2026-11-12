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

/// One row of a report: the shared [`paged_loss::LossEntry`] (capability
/// register C18), DXF's codes (`entity.TEXT`, `hatch.unreadable`) as data.
pub use paged_loss::LossEntry as Note;
use paged_loss::LossLog;
/// How a construct fared: the shared [`paged_loss::LossSeverity`].
pub use paged_loss::LossSeverity as Severity;

/// What a conversion carried and what it could not (the shape of the
/// engine's `SvgReport`, so the bundle logs both alike).
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    /// Import: the shapes written. Export: the entities written.
    pub items: u32,
    /// The losses, one row per code and message, in first-use order.
    pub losses: Vec<Note>,
}

impl Report {
    /// Count `n` occurrences of `code`.
    pub fn note_n(&mut self, code: &str, severity: Severity, message: &str, n: u32) {
        self.losses.note_n(code, severity, message, n as usize);
    }

    pub fn approximated(&mut self, code: &str, message: &str) {
        self.losses.approximated(code, message);
    }

    pub fn dropped(&mut self, code: &str, message: &str) {
        self.losses.dropped(code, message);
    }

    /// The row of `code`, if it happened.
    pub fn get(&self, code: &str) -> Option<&Note> {
        self.losses.loss(code)
    }
}

/// `s` escaped for an XML attribute.
pub(crate) fn escape(s: &str) -> String {
    let e = paged_fmt::xml::AttrEscape {
        controls: paged_fmt::xml::Controls::Space,
        ..Default::default()
    };
    paged_fmt::xml::escape_attr_with(s, e).into_owned()
}
