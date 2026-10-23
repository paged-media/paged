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

//! Captured unknown subtrees inside an understood worksheet part
//! (preservation invariant, §10.2).
//!
//! T0 mechanism, two layers:
//!
//! 1. **Lazy-verbatim** (opc.rs): an un-dirty `Modeled` worksheet re-emits
//!    its original bytes, so *all* unknown content survives a no-op
//!    round-trip — unknown parts, unknown elements, AND unknown per-cell /
//!    per-row attributes.
//!
//! 2. **Captured subtrees** (this module): when a worksheet is marked dirty
//!    and re-encoded from the model, the cell grid is rebuilt, so any
//!    unknown *child element of `<worksheet>`* would be lost. We therefore
//!    capture those unknown children verbatim at parse time, tagged with a
//!    schema **anchor** (where they sit relative to `<sheetData>`), and
//!    re-emit them in their schema position on write.
//!
//! ## Granularity
//!
//! Capture is at the **worksheet-child** level. Unknown attributes on
//! `<row>`/`<c>` and unknown elements inside `<sheetData>` survive an edit
//! because the save patches the part row by row (patch.rs, ADR 503
//! amendment 2026-10-22) instead of regenerating it; each capture remembers
//! its span so it is spliced back where it stood.

/// Where a captured unknown `<worksheet>` child sits relative to the
/// schema-fixed `<sheetData>` element (ECMA-376 §18.3.1.99 child order).
/// We re-emit `Before*` children before `<sheetData>` and `After*` after it,
/// preserving the relative order of captures within each bucket.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Anchor {
    /// A `<worksheet>` child that appeared *before* `<sheetData>` in the
    /// source (e.g. `sheetPr`, `dimension`, `sheetViews`, `sheetFormatPr`,
    /// `cols`). Note `cols`/`dimension`/`mergeCells` may be modeled; only
    /// the unmodeled ones are captured here.
    BeforeSheetData,
    /// A `<worksheet>` child that appeared *after* `<sheetData>` (e.g.
    /// `conditionalFormatting`, `dataValidations`, `pageMargins`,
    /// `pageSetup`, `extLst`).
    AfterSheetData,
}

/// One captured unknown subtree: its anchor plus the verbatim source bytes
/// of the whole element (start tag through end tag, namespaces intact).
#[derive(Debug, Clone)]
pub struct CapturedSubtree {
    pub anchor: Anchor,
    /// The raw XML bytes of the element. As read they are exactly the source
    /// bytes; a structural edit (shift.rs) may rewrite them.
    pub bytes: Vec<u8>,
    /// Where the element stood in the part as read (`start..end`), so a save
    /// can patch the part in place; `None` for a child added since.
    pub span: Option<(usize, usize)>,
}

/// All captured unknown subtrees for one worksheet, in document order within
/// each anchor bucket.
#[derive(Debug, Clone, Default)]
pub struct CapturedSubtrees {
    pub items: Vec<CapturedSubtree>,
}

impl CapturedSubtrees {
    pub fn push(&mut self, anchor: Anchor, bytes: Vec<u8>) {
        self.items.push(CapturedSubtree {
            anchor,
            bytes,
            span: None,
        });
    }

    /// [`push`](Self::push) for a child read at `start..end` of its part.
    pub fn push_at(&mut self, anchor: Anchor, bytes: Vec<u8>, start: usize, end: usize) {
        self.items.push(CapturedSubtree {
            anchor,
            bytes,
            span: Some((start, end)),
        });
    }

    /// Captured children that re-emit *before* `<sheetData>`, in order.
    pub fn before(&self) -> impl Iterator<Item = &CapturedSubtree> {
        self.items
            .iter()
            .filter(|c| c.anchor == Anchor::BeforeSheetData)
    }

    /// Captured children that re-emit *after* `<sheetData>`, in order.
    pub fn after(&self) -> impl Iterator<Item = &CapturedSubtree> {
        self.items
            .iter()
            .filter(|c| c.anchor == Anchor::AfterSheetData)
    }

    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn buckets_keep_document_order() {
        let mut c = CapturedSubtrees::default();
        c.push(Anchor::BeforeSheetData, b"<sheetPr/>".to_vec());
        c.push(Anchor::AfterSheetData, b"<pageMargins/>".to_vec());
        c.push(Anchor::AfterSheetData, b"<extLst/>".to_vec());
        c.push(Anchor::BeforeSheetData, b"<sheetViews/>".to_vec());

        let before: Vec<&[u8]> = c.before().map(|s| s.bytes.as_slice()).collect();
        assert_eq!(before, vec![&b"<sheetPr/>"[..], &b"<sheetViews/>"[..]]);
        let after: Vec<&[u8]> = c.after().map(|s| s.bytes.as_slice()).collect();
        assert_eq!(after, vec![&b"<pageMargins/>"[..], &b"<extLst/>"[..]]);
        assert!(!c.is_empty());
    }
}
