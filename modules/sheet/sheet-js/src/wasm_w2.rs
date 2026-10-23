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

//! The wasm doors of the W2.6–W2.8 work and the scope amendment (sheet ADR
//! 517): outline and visibility, protection, tables, sort and filter, data
//! validation, what-if. A forwarding shim like `lib.rs`'s: nothing computes
//! here.

use wasm_bindgen::prelude::*;

use crate::core::outline::Axis;
use crate::core::protect::ProtectOptions;
use crate::core::validation::ValidationRuleArg;
use crate::wasm::{map_err, to_js, SheetEngine};

fn axis(s: &str) -> Result<Axis, JsValue> {
    Axis::parse(s).map_err(map_err)
}

fn arg<T: serde::de::DeserializeOwned>(v: JsValue) -> Result<T, JsValue> {
    serde_wasm_bindgen::from_value(v).map_err(|e| JsValue::from_str(&e.to_string()))
}

#[wasm_bindgen]
impl SheetEngine {
    // ── outline and visibility (W2.8) ───────────────────────────────────

    /// `{rows, cols, maxRowLevel, maxColLevel, summaryBelow, summaryRight,
    /// hiddenRows, hiddenCols}` — each group `{first, last, level, collapsed,
    /// summary}`.
    pub fn outline(&self, sheet: u16) -> Result<JsValue, JsValue> {
        to_js(&self.session.outline(sheet).map_err(map_err)?)
    }

    /// Group `first..=last` (`axis` = `"rows"` / `"cols"`) one level deeper.
    pub fn group(
        &mut self,
        sheet: u16,
        axis_name: &str,
        first: u32,
        last: u32,
    ) -> Result<JsValue, JsValue> {
        let r = self
            .session
            .group(sheet, axis(axis_name)?, first, last)
            .map_err(map_err)?;
        to_js(&r)
    }

    pub fn ungroup(
        &mut self,
        sheet: u16,
        axis_name: &str,
        first: u32,
        last: u32,
    ) -> Result<JsValue, JsValue> {
        let r = self
            .session
            .ungroup(sheet, axis(axis_name)?, first, last)
            .map_err(map_err)?;
        to_js(&r)
    }

    /// Collapse or expand the innermost group at `at` (detail or summary).
    pub fn set_group_collapsed(
        &mut self,
        sheet: u16,
        axis_name: &str,
        at: u32,
        collapsed: bool,
    ) -> Result<JsValue, JsValue> {
        let r = self
            .session
            .set_group_collapsed(sheet, axis(axis_name)?, at, collapsed)
            .map_err(map_err)?;
        to_js(&r)
    }

    /// Excel's outline-level buttons (1 = only the top level shows).
    pub fn show_outline_level(
        &mut self,
        sheet: u16,
        axis_name: &str,
        level: u8,
    ) -> Result<JsValue, JsValue> {
        let r = self
            .session
            .show_outline_level(sheet, axis(axis_name)?, level)
            .map_err(map_err)?;
        to_js(&r)
    }

    /// Hide or unhide rows or columns.
    pub fn set_hidden(
        &mut self,
        sheet: u16,
        axis_name: &str,
        first: u32,
        last: u32,
        hidden: bool,
    ) -> Result<JsValue, JsValue> {
        let r = self
            .session
            .set_hidden(sheet, axis(axis_name)?, first, last, hidden)
            .map_err(map_err)?;
        to_js(&r)
    }

    /// `"visible"` / `"hidden"` / `"veryHidden"`.
    pub fn set_sheet_state(&mut self, sheet: u16, state: &str) -> Result<(), JsValue> {
        self.session.set_sheet_state(sheet, state).map_err(map_err)
    }

    // ── protection (W2.8) ───────────────────────────────────────────────

    pub fn sheet_protection(&self, sheet: u16) -> Result<JsValue, JsValue> {
        to_js(&self.session.sheet_protection(sheet).map_err(map_err)?)
    }

    /// `opts`: `{password?, formatCells?, formatColumns?, formatRows?,
    /// insertColumns?, insertRows?, insertHyperlinks?, deleteColumns?,
    /// deleteRows?, selectLockedCells?, selectUnlockedCells?, sort?,
    /// autoFilter?, pivotTables?, objects?, scenarios?}`.
    pub fn protect_sheet(&mut self, sheet: u16, opts: JsValue) -> Result<JsValue, JsValue> {
        let opts: ProtectOptions = if opts.is_undefined() || opts.is_null() {
            ProtectOptions::default()
        } else {
            arg(opts)?
        };
        to_js(&self.session.protect_sheet(sheet, opts).map_err(map_err)?)
    }

    pub fn unprotect_sheet(&mut self, sheet: u16, password: &str) -> Result<(), JsValue> {
        self.session
            .unprotect_sheet(sheet, password)
            .map_err(map_err)
    }

    pub fn workbook_protection(&self) -> Result<JsValue, JsValue> {
        to_js(&self.session.workbook_protection())
    }

    pub fn protect_workbook(
        &mut self,
        password: &str,
        structure: bool,
        windows: bool,
    ) -> Result<(), JsValue> {
        self.session
            .protect_workbook(password, structure, windows)
            .map_err(map_err)
    }

    pub fn unprotect_workbook(&mut self, password: &str) -> Result<(), JsValue> {
        self.session.unprotect_workbook(password).map_err(map_err)
    }

    /// `{locked, formulaHidden, sheetProtected}` of one cell.
    pub fn cell_protection(&self, sheet: u16, row: u32, col: u32) -> Result<JsValue, JsValue> {
        #[derive(serde::Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Out {
            locked: bool,
            formula_hidden: bool,
            sheet_protected: bool,
        }
        let (locked, formula_hidden, sheet_protected) = self
            .session
            .cell_protection(sheet, row, col)
            .map_err(map_err)?;
        to_js(&Out {
            locked,
            formula_hidden,
            sheet_protected,
        })
    }

    // ── data validation (ADR 517) ───────────────────────────────────────

    /// Every rule of the sheet `[{index, sqref, type, operator, formula1,
    /// formula2, allowBlank, inCellDropdown, showInput, promptTitle, prompt,
    /// showError, errorStyle, errorTitle, error}]`.
    pub fn list_validation_rules(&self, sheet: u16) -> Result<JsValue, JsValue> {
        to_js(&self.session.list_validation_rules(sheet).map_err(map_err)?)
    }

    /// `{rule, listItems?}` at a cell, or `undefined`.
    pub fn validation_at(&self, sheet: u16, row: u32, col: u32) -> Result<JsValue, JsValue> {
        match self
            .session
            .validation_at(sheet, row, col)
            .map_err(map_err)?
        {
            Some(v) => to_js(&v),
            None => Ok(JsValue::UNDEFINED),
        }
    }

    /// `{valid, alert?}` — would `input` pass? Nothing changes.
    pub fn check_entry(
        &mut self,
        sheet: u16,
        row: u32,
        col: u32,
        input: &str,
    ) -> Result<JsValue, JsValue> {
        to_js(
            &self
                .session
                .check_entry(sheet, row, col, input)
                .map_err(map_err)?,
        )
    }

    /// A typed entry, validated: `{applied, alert?, result?}`.
    pub fn enter_cell(
        &mut self,
        sheet: u16,
        row: u32,
        col: u32,
        input: &str,
        confirmed: bool,
    ) -> Result<JsValue, JsValue> {
        to_js(
            &self
                .session
                .enter_cell(sheet, row, col, input, confirmed)
                .map_err(map_err)?,
        )
    }

    /// Circle Invalid Data: `[{row, col, rule}]`.
    pub fn invalid_cells(&self, sheet: u16) -> Result<JsValue, JsValue> {
        to_js(&self.session.invalid_cells(sheet).map_err(map_err)?)
    }

    pub fn set_validation(
        &mut self,
        sheet: u16,
        range: &str,
        rule: JsValue,
    ) -> Result<JsValue, JsValue> {
        let rule: ValidationRuleArg = arg(rule)?;
        to_js(
            &self
                .session
                .set_validation(sheet, range, rule)
                .map_err(map_err)?,
        )
    }

    pub fn update_validation(
        &mut self,
        sheet: u16,
        index: u32,
        rule: JsValue,
    ) -> Result<JsValue, JsValue> {
        let rule: ValidationRuleArg = arg(rule)?;
        to_js(
            &self
                .session
                .update_validation(sheet, index, rule)
                .map_err(map_err)?,
        )
    }

    pub fn clear_validation(&mut self, sheet: u16, range: &str) -> Result<JsValue, JsValue> {
        to_js(
            &self
                .session
                .clear_validation(sheet, range)
                .map_err(map_err)?,
        )
    }
}
