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

//! The wasm doors of files and dialect (sheet ADR 521): the package kind and
//! saving as another kind, the OpenDocument import, the CSV export and the
//! formula display dialect. A forwarding shim like `lib.rs`'s.

use wasm_bindgen::prelude::*;

use crate::core::files::CsvExportOptions;
use crate::core::SheetSession;
use crate::wasm::{map_err, to_js, SheetEngine};

#[wasm_bindgen]
impl SheetEngine {
    /// `"xlsx"` or `"xlsm"`: the kind of the open workbook (a template
    /// opens as the workbook kind).
    pub fn workbook_kind(&self) -> String {
        self.session.workbook_kind()
    }

    /// Whether the workbook carries a VBA project (kept byte for byte,
    /// never run).
    pub fn has_macros(&self) -> bool {
        self.session.has_macros()
    }

    /// The workbook as the package kind `ext` names (`"xlsx"`, `"xlsm"`,
    /// `"xltx"`, `"xltm"`). As `.xlsx` a macro workbook leaves its VBA
    /// project out; the open workbook keeps it.
    pub fn save_as(&mut self, ext: &str) -> Result<Vec<u8>, JsValue> {
        self.session.save_as(ext).map_err(map_err)
    }

    /// Import an OpenDocument spreadsheet (`.ods`, `.ots`) as a fresh
    /// workbook (replaces the current one).
    #[cfg(feature = "ods")]
    pub fn load_ods(&mut self, bytes: &[u8]) -> Result<(), JsValue> {
        let now = self.session.now_serial();
        self.session = SheetSession::load_ods(bytes, now).map_err(map_err)?;
        Ok(())
    }

    /// The sheet (or `range`, empty = the used range) as CSV text: the
    /// delimiter (`","`, `";"`, a tab), the formatted or the raw values, a
    /// leading BOM.
    pub fn export_csv(
        &self,
        sheet: u16,
        delimiter: &str,
        formatted: bool,
        bom: bool,
        range: &str,
    ) -> Result<String, JsValue> {
        let opts = CsvExportOptions {
            delimiter: delimiter.to_string(),
            formatted,
            bom,
            range: range.to_string(),
        };
        self.session.export_csv(sheet, &opts).map_err(map_err)
    }

    /// `{r1c1, lang}`: how formulas are shown and typed.
    pub fn formula_display(&self) -> Result<JsValue, JsValue> {
        to_js(&self.session.formula_display())
    }

    /// Show formulas in R1C1 (kept in the workbook) and in the language of
    /// `lang_tag` (`"de-DE"`; no table → English). Storage is unchanged.
    pub fn set_formula_display(&mut self, r1c1: bool, lang_tag: &str) -> Result<(), JsValue> {
        self.session
            .set_formula_display(r1c1, lang_tag)
            .map_err(map_err)
    }

    /// Canonical input → the display dialect, for the cell at `(row, col)`.
    pub fn formula_to_display(&self, row: u32, col: u32, input: &str) -> String {
        self.session.formula_to_display(row, col, input)
    }

    /// Display-dialect input → canonical input, for the cell at `(row, col)`.
    pub fn formula_from_display(&self, row: u32, col: u32, input: &str) -> String {
        self.session.formula_from_display(row, col, input)
    }
}
