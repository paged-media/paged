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

use crate::core::filter::{CriterionArg, FilterViewInfo};
use crate::core::outline::Axis;
use crate::core::protect::ProtectOptions;
use crate::core::sort::SortSpec;
use crate::core::tables::TableStyleArg;
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

    // ── sort and filter (W2.7) ──────────────────────────────────────────

    /// Excel's Sort dialog: `spec` = `{keys: [{index, descending?, sortBy?,
    /// color?, customList?}], hasHeader?, leftToRight?, caseSensitive?}`.
    pub fn sort_range_by(
        &mut self,
        sheet: u16,
        range: &str,
        spec: JsValue,
    ) -> Result<JsValue, JsValue> {
        let spec: SortSpec = arg(spec)?;
        to_js(
            &self
                .session
                .sort_range_by(sheet, range, spec)
                .map_err(map_err)?,
        )
    }

    pub fn set_autofilter(&mut self, sheet: u16, range: &str) -> Result<JsValue, JsValue> {
        to_js(&self.session.set_autofilter(sheet, range).map_err(map_err)?)
    }

    pub fn remove_autofilter(&mut self, sheet: u16) -> Result<JsValue, JsValue> {
        to_js(&self.session.remove_autofilter(sheet).map_err(map_err)?)
    }

    /// One column's criterion (`undefined` clears it): `{kind: "values",
    /// values, blanks?, dates?} | {kind: "custom", and?, conditions: [{op,
    /// val}]} | {kind: "contains", text} | {kind: "top", n, percent?, top?} |
    /// {kind: "dynamic", type} | {kind: "color", color, cellColor?} | {kind:
    /// "icon", set, id?}`.
    pub fn set_filter_column(
        &mut self,
        sheet: u16,
        range: &str,
        col: u32,
        criterion: JsValue,
    ) -> Result<JsValue, JsValue> {
        let c: Option<CriterionArg> = if criterion.is_undefined() || criterion.is_null() {
            None
        } else {
            Some(arg(criterion)?)
        };
        to_js(
            &self
                .session
                .set_filter_column(sheet, range, col, c)
                .map_err(map_err)?,
        )
    }

    pub fn clear_filter_criteria(&mut self, sheet: u16) -> Result<JsValue, JsValue> {
        to_js(&self.session.clear_filter_criteria(sheet).map_err(map_err)?)
    }

    pub fn reapply_filter(&mut self, sheet: u16) -> Result<JsValue, JsValue> {
        to_js(&self.session.reapply_filter(sheet).map_err(map_err)?)
    }

    /// `{range, columns: [{col, criterion?, applied}], hiddenRows}` or
    /// `undefined`.
    pub fn filter_state(&self, sheet: u16) -> Result<JsValue, JsValue> {
        match self.session.filter_state(sheet).map_err(map_err)? {
            Some(s) => to_js(&s),
            None => Ok(JsValue::UNDEFINED),
        }
    }

    /// The filter dropdown of one column.
    pub fn filter_column_values(&self, sheet: u16, col: u32) -> Result<JsValue, JsValue> {
        to_js(
            &self
                .session
                .filter_column_values(sheet, col)
                .map_err(map_err)?,
        )
    }

    pub fn save_filter_view(&mut self, sheet: u16, name: &str) -> Result<(), JsValue> {
        self.session.save_filter_view(sheet, name).map_err(map_err)
    }

    pub fn apply_filter_view(&mut self, sheet: u16, name: &str) -> Result<JsValue, JsValue> {
        to_js(
            &self
                .session
                .apply_filter_view(sheet, name)
                .map_err(map_err)?,
        )
    }

    pub fn delete_filter_view(&mut self, sheet: u16, name: &str) {
        self.session.delete_filter_view(sheet, name);
    }

    /// The named views (the bundle keeps them in the `.paged` part).
    pub fn list_filter_views(&self) -> Result<JsValue, JsValue> {
        to_js(&self.session.list_filter_views())
    }

    pub fn set_filter_views(&mut self, views: JsValue) -> Result<(), JsValue> {
        let v: Vec<FilterViewInfo> = arg(views)?;
        self.session.set_filter_views(v);
        Ok(())
    }

    // ── tables (W2.6) ───────────────────────────────────────────────────

    /// Every table, read whole: `[{name, sheet, range, headerRow, totalsRow,
    /// columns: [{name, calculatedFormula?, totalsFunction?, totalsFormula?,
    /// totalsLabel?}], style?, firstColumn, lastColumn, bandedRows,
    /// bandedColumns}]`.
    pub fn list_table_details(&self) -> Result<JsValue, JsValue> {
        to_js(&self.session.list_table_details())
    }

    pub fn table_detail(&self, name: &str) -> Result<JsValue, JsValue> {
        to_js(&self.session.table_detail(name).map_err(map_err)?)
    }

    pub fn table_style_names(&self) -> Result<JsValue, JsValue> {
        to_js(&self.session.table_style_names())
    }

    /// Insert ▸ Table. `style` / `name` empty: the defaults.
    pub fn create_table(
        &mut self,
        sheet: u16,
        range: &str,
        has_headers: bool,
        style: &str,
        name: &str,
    ) -> Result<JsValue, JsValue> {
        let style = (!style.is_empty()).then_some(style);
        let name = (!name.is_empty()).then_some(name);
        to_js(
            &self
                .session
                .create_table(sheet, range, has_headers, style, name)
                .map_err(map_err)?,
        )
    }

    pub fn resize_table(&mut self, name: &str, range: &str) -> Result<JsValue, JsValue> {
        to_js(&self.session.resize_table(name, range).map_err(map_err)?)
    }

    pub fn rename_table(&mut self, name: &str, new_name: &str) -> Result<JsValue, JsValue> {
        to_js(&self.session.rename_table(name, new_name).map_err(map_err)?)
    }

    pub fn set_table_totals(&mut self, name: &str, show: bool) -> Result<JsValue, JsValue> {
        to_js(&self.session.set_table_totals(name, show).map_err(map_err)?)
    }

    /// `function`: `sum`, `average`, `count`, `countNums`, `max`, `min`,
    /// `stdDev`, `var`, `custom` (`text` = the formula), `label` (`text` =
    /// the label), `none`.
    pub fn set_totals_function(
        &mut self,
        name: &str,
        column: &str,
        function: &str,
        text: &str,
    ) -> Result<JsValue, JsValue> {
        let text = (!text.is_empty()).then_some(text);
        to_js(
            &self
                .session
                .set_totals_function(name, column, function, text)
                .map_err(map_err)?,
        )
    }

    /// `formula` empty: remove the calculated formula.
    pub fn set_calculated_column(
        &mut self,
        name: &str,
        column: &str,
        formula: &str,
    ) -> Result<JsValue, JsValue> {
        let f = (!formula.is_empty()).then_some(formula);
        to_js(
            &self
                .session
                .set_calculated_column(name, column, f)
                .map_err(map_err)?,
        )
    }

    /// `{style?, firstColumn?, lastColumn?, bandedRows?, bandedColumns?}`.
    pub fn set_table_style(&mut self, name: &str, arg_v: JsValue) -> Result<JsValue, JsValue> {
        let a: TableStyleArg = arg(arg_v)?;
        to_js(&self.session.set_table_style(name, a).map_err(map_err)?)
    }

    // ── what-if (ADR 517) ───────────────────────────────────────────────

    /// Goal Seek: `{found, value, result, iterations, prevInput}`.
    #[allow(clippy::too_many_arguments)]
    pub fn goal_seek(
        &mut self,
        sheet: u16,
        set_row: u32,
        set_col: u32,
        target: f64,
        changing_sheet: u16,
        changing_row: u32,
        changing_col: u32,
    ) -> Result<JsValue, JsValue> {
        to_js(
            &self
                .session
                .goal_seek(
                    sheet,
                    set_row,
                    set_col,
                    target,
                    changing_sheet,
                    changing_row,
                    changing_col,
                )
                .map_err(map_err)?,
        )
    }

    /// Recalculate the data tables now (the result cells that changed,
    /// `[[sheet, row, col]]`).
    pub fn calculate_data_tables(&mut self) -> Result<JsValue, JsValue> {
        to_js(&self.session.calculate_data_tables().map_err(map_err)?)
    }

    /// The data tables: `[[sheet, "B6:C10"]]`.
    pub fn list_data_tables(&self) -> Result<JsValue, JsValue> {
        to_js(&self.session.list_data_tables())
    }

    /// The filter dropdown of a table's column (its own AutoFilter).
    pub fn table_filter_column_values(&self, name: &str, col: u32) -> Result<JsValue, JsValue> {
        to_js(
            &self
                .session
                .table_filter_column_values(name, col)
                .map_err(map_err)?,
        )
    }

    pub fn clear_table_filter(&mut self, name: &str) -> Result<JsValue, JsValue> {
        to_js(&self.session.clear_table_filter(name).map_err(map_err)?)
    }
}
