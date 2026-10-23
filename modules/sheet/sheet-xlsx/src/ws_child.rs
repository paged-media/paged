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

//! Authoring a captured `<worksheet>` child (sheet ADR 517): replace, add or
//! remove one singleton child (`sheetProtection`, `autoFilter`, `sortState`,
//! `dataValidations`, `sheetFormatPr`, …) of a sheet, in its ECMA-376
//! §18.3.1.99 position. The captured bytes stay the single store: a later
//! structural edit shifts what this wrote like anything else read from the
//! file (ADR 515), and the save splices it where the schema puts it
//! (`patch.rs` places an added child by [`ws_rank`]).

use crate::error::XlsxError;
use crate::preserve::{Anchor, CapturedSubtree};
use crate::write::captured_local;
use crate::XlsxDocument;
use sheet_core::SheetId;

/// The `<worksheet>` children in schema order (CT_Worksheet).
pub(crate) const WS_ORDER: &[&str] = &[
    "sheetPr",
    "dimension",
    "sheetViews",
    "sheetFormatPr",
    "cols",
    "sheetData",
    "sheetCalcPr",
    "sheetProtection",
    "protectedRanges",
    "scenarios",
    "autoFilter",
    "sortState",
    "dataConsolidate",
    "customSheetViews",
    "mergeCells",
    "phoneticPr",
    "conditionalFormatting",
    "dataValidations",
    "hyperlinks",
    "printOptions",
    "pageMargins",
    "pageSetup",
    "headerFooter",
    "rowBreaks",
    "colBreaks",
    "customProperties",
    "cellWatches",
    "ignoredErrors",
    "smartTags",
    "drawing",
    "legacyDrawing",
    "legacyDrawingHF",
    "drawingHF",
    "picture",
    "oleObjects",
    "controls",
    "webPublishItems",
    "tableParts",
    "extLst",
];

/// The schema rank of a `<worksheet>` child (unknown names rank last, before
/// nothing — they keep their place when read and are appended when added).
pub(crate) fn ws_rank(local: &str) -> usize {
    WS_ORDER
        .iter()
        .position(|n| *n == local)
        .unwrap_or(WS_ORDER.len())
}

fn rank_of_sheet_data() -> usize {
    ws_rank("sheetData")
}

impl XlsxDocument {
    /// The current bytes of the sheet's captured child `local` (the first one
    /// when the schema allows several).
    pub fn ws_child(&self, sheet: SheetId, local: &str) -> Option<&[u8]> {
        let b = self.bindings.iter().find(|b| b.sheet_id == sheet)?;
        b.captured
            .items
            .iter()
            .find(|c| captured_local(&c.bytes) == local)
            .map(|c| c.bytes.as_slice())
    }

    /// The namespace prefix the sheet's part writes its elements with (`""`
    /// for a default namespace, `"x:"` for a prefixed one).
    pub fn ws_prefix(&self, sheet: SheetId) -> String {
        let Some(part) = self
            .bindings
            .iter()
            .find(|b| b.sheet_id == sheet)
            .map(|b| b.part_name.clone())
        else {
            return String::new();
        };
        let Some(bytes) = self.part_bytes(&part) else {
            return String::new();
        };
        let mut reader = quick_xml::Reader::from_reader(bytes.as_slice());
        let mut buf = Vec::new();
        loop {
            match reader.read_event_into(&mut buf) {
                Ok(quick_xml::events::Event::Start(e)) | Ok(quick_xml::events::Event::Empty(e)) => {
                    let q = String::from_utf8_lossy(e.name().as_ref()).into_owned();
                    return crate::splice::prefix_of(&q).to_string();
                }
                Ok(quick_xml::events::Event::Eof) | Err(_) => return String::new(),
                _ => {}
            }
            buf.clear();
        }
    }

    /// Replace (`Some`) or remove (`None`) the sheet's captured singleton
    /// child `local`; a child the sheet does not have yet is added in schema
    /// position. The sheet is marked for re-encode by the caller (the
    /// session's dirty set), as every authoring write is.
    pub fn set_ws_child(
        &mut self,
        sheet: SheetId,
        local: &str,
        bytes: Option<Vec<u8>>,
    ) -> Result<(), XlsxError> {
        let binding = self
            .bindings
            .iter_mut()
            .find(|b| b.sheet_id == sheet)
            .ok_or_else(|| XlsxError::Structure(format!("sheet {sheet} has no part")))?;
        let items = &mut binding.captured.items;
        let at = items.iter().position(|c| captured_local(&c.bytes) == local);
        match (at, bytes) {
            (Some(i), Some(b)) => items[i].bytes = b,
            (Some(i), None) => {
                items.remove(i);
            }
            (None, None) => {}
            (None, Some(b)) => {
                let rank = ws_rank(local);
                let anchor = if rank < rank_of_sheet_data() {
                    Anchor::BeforeSheetData
                } else {
                    Anchor::AfterSheetData
                };
                let pos = items
                    .iter()
                    .position(|c| ws_rank(&captured_local(&c.bytes)) > rank)
                    .unwrap_or(items.len());
                items.insert(
                    pos,
                    CapturedSubtree {
                        anchor,
                        bytes: b,
                        span: None,
                    },
                );
            }
        }
        self.container.dirty = true;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_ranks_follow_ct_worksheet() {
        assert!(ws_rank("sheetProtection") < ws_rank("autoFilter"));
        assert!(ws_rank("autoFilter") < ws_rank("sortState"));
        assert!(ws_rank("sortState") < ws_rank("mergeCells"));
        assert!(ws_rank("mergeCells") < ws_rank("dataValidations"));
        assert!(ws_rank("dataValidations") < ws_rank("hyperlinks"));
        assert!(ws_rank("tableParts") < ws_rank("extLst"));
        assert_eq!(ws_rank("unknownThing"), WS_ORDER.len());
    }
}
