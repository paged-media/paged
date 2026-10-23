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

//! Data validation, interpreted (sheet ADR 517, amending ADR 504): an entry
//! is checked against its cell's rule, list rules give their items, every
//! Excel rule kind is authored with its input message and error alert, and
//! "circle invalid data" lists the cells breaking their rules.
//!
//! Excel's rules, as implemented:
//! - a blank entry passes when the rule allows blanks (`allowBlank`);
//! - whole / decimal / date / time compare the entered NUMBER with the
//!   operand formulas (a text entry fails; whole also needs an integer);
//! - text length compares the length of the entry as text;
//! - list: the entry must equal one item, text compared case-insensitively,
//!   numbers by value; the items are an inline list (`"a,b,c"`) or the cells
//!   of a reference (a range, a name, `OFFSET`/`INDIRECT` — a dynamic range);
//! - custom: the formula, evaluated with the entry in place, must be TRUE
//!   (a non-zero number counts; text and errors fail);
//! - a rule whose error alert is off (`showErrorMessage="0"`) never refuses.
//!
//! Only an ENTRY is checked (`enter_cell` / `check_entry`), as in Excel:
//! paste, fill, sort and undo write through the other doors unchecked.
//! The operand formulas are written relative to the top-left cell of the
//! rule's first range; a cell elsewhere reads them moved by its offset.

use sheet_core::{CellValue, Formula};
use sheet_format::{FormatCache, FormatCtx};
use sheet_parser::{parse, print_ooxml, rewrite_fill, strip_storage_prefixes};
use sheet_xlsx::parts::validation::{
    parse_sqref, print_sqref, rect_minus, DvErrorStyle, DvOperator, DvRule, DvType,
};

use super::{
    cell_display, cell_input_text, ModelParseCtx, ModelSheetNames, SessionError, SetCellResult,
    SheetSession, T0_LOWER_CELL_CAP,
};

/// One rule across the wasm door (camelCase). Formulas are display-dialect
/// text, with or without a leading `=`; a list's inline items may be given
/// as `listItems` instead of `formula1`.
#[derive(serde::Serialize, serde::Deserialize, Debug, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ValidationRuleArg {
    /// `any`/`none`, `whole`, `decimal`, `list`, `date`, `time`,
    /// `textLength`, `custom`.
    #[serde(rename = "type")]
    pub kind: String,
    /// `between` (default), `notBetween`, `equal`, `notEqual`, `lessThan`,
    /// `lessThanOrEqual`, `greaterThan`, `greaterThanOrEqual`.
    pub operator: Option<String>,
    pub formula1: Option<String>,
    pub formula2: Option<String>,
    pub list_items: Option<Vec<String>>,
    pub allow_blank: Option<bool>,
    pub in_cell_dropdown: Option<bool>,
    pub show_input: Option<bool>,
    pub prompt_title: Option<String>,
    pub prompt: Option<String>,
    pub show_error: Option<bool>,
    /// `stop` (default), `warning`, `information`.
    pub error_style: Option<String>,
    pub error_title: Option<String>,
    pub error: Option<String>,
}

/// One rule as the engine reports it.
#[derive(serde::Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ValidationRuleInfo {
    pub index: u32,
    /// The ranges, as a space-separated A1 list.
    pub sqref: String,
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub operator: &'static str,
    /// The operands in the display dialect, with `=` (`"=$A$1:$A$9"`,
    /// `"=\"a,b\""`), relative to the first range's top-left cell.
    pub formula1: Option<String>,
    pub formula2: Option<String>,
    pub allow_blank: bool,
    pub in_cell_dropdown: bool,
    pub show_input: bool,
    pub prompt_title: Option<String>,
    pub prompt: Option<String>,
    pub show_error: bool,
    pub error_style: &'static str,
    pub error_title: Option<String>,
    pub error: Option<String>,
}

/// The alert a refused (or questioned) entry raises — Excel's dialog.
#[derive(serde::Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ValidationAlert {
    /// `stop` (refused; Retry/Cancel), `warning` (Continue? Yes/No/Cancel),
    /// `information` (OK/Cancel).
    pub style: &'static str,
    pub title: String,
    pub message: String,
}

/// What `check_entry` answers.
#[derive(serde::Serialize, Debug, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct EntryCheck {
    pub valid: bool,
    pub alert: Option<ValidationAlert>,
}

/// What `enter_cell` answers: whether the entry was applied, the alert when
/// it was not, and the recalc when it was.
#[derive(serde::Serialize, Debug, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct EnterResult {
    pub applied: bool,
    pub alert: Option<ValidationAlert>,
    pub result: Option<SetCellResult>,
}

/// The validation at one cell, for the grid: the input message to show and
/// a list rule's items for the dropdown.
#[derive(serde::Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CellValidation {
    pub rule: ValidationRuleInfo,
    /// A list rule with its in-cell dropdown on: the items, in order.
    pub list_items: Option<Vec<String>>,
}

/// One cell breaking its rule.
#[derive(serde::Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InvalidCell {
    pub row: u32,
    pub col: u32,
    pub rule: u32,
}

/// Excel's default alert words.
const DEFAULT_TITLE: &str = "Microsoft Excel";
const DEFAULT_MESSAGE: &str =
    "This value doesn't match the data validation restrictions defined for this cell.";

fn info_of(index: usize, r: &DvRule) -> ValidationRuleInfo {
    let eq = |f: &Option<String>| f.as_ref().map(|s| format!("={s}"));
    ValidationRuleInfo {
        index: index as u32,
        sqref: print_sqref(&r.ranges),
        kind: r.kind.as_str(),
        operator: r.operator.as_str(),
        formula1: eq(&r.formula1),
        formula2: eq(&r.formula2),
        allow_blank: r.allow_blank,
        in_cell_dropdown: r.in_cell_dropdown,
        show_input: r.show_input,
        prompt_title: r.prompt_title.clone(),
        prompt: r.prompt.clone(),
        show_error: r.show_error,
        error_style: r.error_style.as_str(),
        error_title: r.error_title.clone(),
        error: r.error.clone(),
    }
}

fn alert_of(r: &DvRule) -> ValidationAlert {
    ValidationAlert {
        style: r.error_style.as_str(),
        title: r
            .error_title
            .clone()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| DEFAULT_TITLE.into()),
        message: r
            .error
            .clone()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| DEFAULT_MESSAGE.into()),
    }
}

/// The items of an inline list operand (`"a,b,c"`), `None` when the
/// operand is not a quoted list.
fn inline_items(f: &str) -> Option<Vec<String>> {
    let t = f.trim();
    let inner = t.strip_prefix('"')?.strip_suffix('"')?;
    Some(
        inner
            .replace("\"\"", "\"")
            .split(',')
            .map(|s| s.to_string())
            .collect(),
    )
}

fn truthy(v: &CellValue) -> bool {
    match v {
        CellValue::Bool(b) => *b,
        CellValue::Number(n) => *n != 0.0,
        _ => false,
    }
}

fn number_of(v: &CellValue) -> Option<f64> {
    match v {
        CellValue::Number(n) => Some(*n),
        CellValue::Bool(_) | CellValue::Text(_) | CellValue::Empty | CellValue::Error(_) => None,
        #[allow(unreachable_patterns)]
        _ => None,
    }
}

impl SheetSession {
    /// The sheet's rules.
    pub fn list_validation_rules(
        &self,
        sheet: u16,
    ) -> Result<Vec<ValidationRuleInfo>, SessionError> {
        self.validate_sheet(sheet)?;
        Ok(self
            .doc
            .validation_rules(sheet)
            .iter()
            .enumerate()
            .map(|(i, r)| info_of(i, r))
            .collect())
    }

    /// The index and rule covering `(row, col)`.
    fn rule_at(&self, sheet: u16, row: u32, col: u32) -> Option<(usize, DvRule)> {
        self.doc
            .validation_rules(sheet)
            .into_iter()
            .enumerate()
            .find(|(_, r)| r.covers(row, col))
    }

    /// Parse an operand (storage dialect) and move it from the rule's anchor
    /// to `(row, col)`.
    fn operand(
        &self,
        sheet: u16,
        rule: &DvRule,
        text: &str,
        row: u32,
        col: u32,
    ) -> Option<Formula> {
        let model = self.engine().model();
        let ctx = ModelParseCtx {
            model,
            current: sheet,
        };
        let f = parse(&strip_storage_prefixes(text), &ctx).ok()?;
        let (ar, ac) = rule.anchor();
        let (dr, dc) = (
            i64::from(row) - i64::from(ar),
            i64::from(col) - i64::from(ac),
        );
        Some(if dr == 0 && dc == 0 {
            f
        } else {
            rewrite_fill(&f, dr, dc)
        })
    }

    fn operand_value(
        &self,
        sheet: u16,
        rule: &DvRule,
        text: &str,
        row: u32,
        col: u32,
    ) -> CellValue {
        match self.operand(sheet, rule, text, row, col) {
            Some(f) => self.engine().eval_formula_at(sheet, row, col, &f),
            None => CellValue::Error(sheet_core::CellError::Name),
        }
    }

    /// A list rule's items at `(row, col)`: the inline list, or the shown
    /// text of every non-blank cell of the referenced area.
    fn list_items_of(&self, sheet: u16, rule: &DvRule, row: u32, col: u32) -> Vec<String> {
        let Some(f1) = rule.formula1.as_deref() else {
            return Vec::new();
        };
        if let Some(items) = inline_items(f1) {
            return items;
        }
        let Some(f) = self.operand(sheet, rule, f1, row, col) else {
            return Vec::new();
        };
        let engine = self.engine();
        let model = engine.model();
        let mut cache = FormatCache::default();
        let fctx = FormatCtx::new(model.calc.date_system, model.calc.locale);
        if let Some(area) = engine.eval_reference_at(sheet, row, col, &f) {
            let a = area.normalized();
            let cells =
                u64::from(a.end.row - a.start.row + 1) * u64::from(a.end.col - a.start.col + 1);
            if cells > T0_LOWER_CELL_CAP {
                return Vec::new();
            }
            let mut out = Vec::new();
            for r in a.start.row..=a.end.row {
                for c in a.start.col..=a.end.col {
                    let t = cell_display(model, a.start.sheet, r, c, &mut cache, &fctx);
                    if !t.is_empty() {
                        out.push(t);
                    }
                }
            }
            return out;
        }
        engine
            .eval_formula_block_at(sheet, row, col, &f)
            .into_iter()
            .flatten()
            .filter(|v| !matches!(v, CellValue::Empty))
            .map(|v| sheet_format::format_general(&v))
            .collect()
    }

    /// Whether `value` (the typed entry, or the cell's current value) passes
    /// `rule` at `(row, col)`. A custom rule reads the cell as it stands, so
    /// the caller puts the entry in place first.
    fn passes(&self, sheet: u16, rule: &DvRule, row: u32, col: u32, value: &CellValue) -> bool {
        if matches!(value, CellValue::Empty) || matches!(value, CellValue::Text(t) if t.is_empty())
        {
            return rule.allow_blank || rule.kind == DvType::Any;
        }
        let op = |v: f64| {
            let a = rule
                .formula1
                .as_deref()
                .map(|t| self.operand_value(sheet, rule, t, row, col));
            let b = rule
                .formula2
                .as_deref()
                .map(|t| self.operand_value(sheet, rule, t, row, col));
            let a = a.as_ref().and_then(number_of);
            let b = b.as_ref().and_then(number_of);
            match (a, rule.operator.binary(), b) {
                (Some(a), false, _) => rule.operator.test(v, a, a),
                (Some(a), true, Some(b)) => rule.operator.test(v, a, b),
                _ => false,
            }
        };
        match rule.kind {
            DvType::Any => true,
            DvType::Whole => number_of(value).is_some_and(|v| v.fract() == 0.0 && op(v)),
            DvType::Decimal | DvType::Date | DvType::Time => number_of(value).is_some_and(op),
            DvType::TextLength => {
                let text = match value {
                    CellValue::Text(t) => t.to_string(),
                    other => sheet_format::format_general(other),
                };
                op(text.chars().count() as f64)
            }
            DvType::List => {
                let items = self.list_items_of(sheet, rule, row, col);
                let shown = match value {
                    CellValue::Text(t) => t.to_string(),
                    other => sheet_format::format_general(other),
                };
                let num = number_of(value);
                items.iter().any(|it| {
                    it.trim().eq_ignore_ascii_case(shown.trim())
                        || num.is_some_and(|n| it.trim().parse::<f64>().ok() == Some(n))
                })
            }
            DvType::Custom => match rule.formula1.as_deref() {
                Some(t) => truthy(&self.operand_value(sheet, rule, t, row, col)),
                None => true,
            },
        }
    }

    /// Check `input` for `(row, col)` against its rule, with the entry in
    /// place for a custom rule (put back afterwards). Nothing changes.
    fn check(
        &mut self,
        sheet: u16,
        row: u32,
        col: u32,
        input: &str,
    ) -> Result<(EntryCheck, Option<DvRule>), SessionError> {
        self.validate_sheet(sheet)?;
        let Some((_, rule)) = self.rule_at(sheet, row, col) else {
            return Ok((
                EntryCheck {
                    valid: true,
                    alert: None,
                },
                None,
            ));
        };
        if !rule.show_error {
            return Ok((
                EntryCheck {
                    valid: true,
                    alert: None,
                },
                Some(rule),
            ));
        }
        let typed = self
            .engine()
            .parse_entry_at(sheet, row, col, input)
            .map_err(|e| SessionError(e.to_string()))?;
        let value = match &typed.input {
            sheet_calc::SetInput::Value(v) => v.clone(),
            sheet_calc::SetInput::Empty => CellValue::Empty,
            sheet_calc::SetInput::Formula(f) => self.engine().eval_formula_at(sheet, row, col, f),
        };
        let valid = if rule.kind == DvType::Custom {
            // Excel evaluates the formula with the entry in the cell.
            let prev = cell_input_text(self.engine().model(), sheet, row, col);
            let prev_input = self
                .engine()
                .parse_input(sheet, &prev)
                .map_err(|e| SessionError(e.to_string()))?;
            self.engine_mut()
                .set_cells(vec![(sheet, row, col, typed.input)]);
            let ok = self.passes(sheet, &rule, row, col, &value);
            self.engine_mut()
                .set_cells(vec![(sheet, row, col, prev_input)]);
            ok
        } else {
            self.passes(sheet, &rule, row, col, &value)
        };
        Ok((
            EntryCheck {
                valid,
                alert: (!valid).then(|| alert_of(&rule)),
            },
            Some(rule),
        ))
    }

    /// Whether `input` would pass the validation of `(row, col)`, and the
    /// alert Excel would show if not. Nothing changes.
    pub fn check_entry(
        &mut self,
        sheet: u16,
        row: u32,
        col: u32,
        input: &str,
    ) -> Result<EntryCheck, SessionError> {
        Ok(self.check(sheet, row, col, input)?.0)
    }

    /// Enter `input` into `(row, col)` as a person typing it: the cell's
    /// validation decides. A `stop` rule refuses (not applied, the alert
    /// returned); a `warning` or `information` rule returns its alert
    /// unapplied unless `confirmed` (the person answered Yes / OK), then
    /// applies. A valid entry applies like `set_cell`.
    pub fn enter_cell(
        &mut self,
        sheet: u16,
        row: u32,
        col: u32,
        input: &str,
        confirmed: bool,
    ) -> Result<EnterResult, SessionError> {
        self.guard_cells([(sheet, row, col)])?;
        let (check, rule) = self.check(sheet, row, col, input)?;
        if !check.valid {
            let stop = rule
                .as_ref()
                .is_none_or(|r| r.error_style == DvErrorStyle::Stop);
            if stop || !confirmed {
                return Ok(EnterResult {
                    applied: false,
                    alert: check.alert,
                    result: None,
                });
            }
        }
        let mut result = self.set_cell(sheet, row, col, input)?;
        // A typed entry grows a table it lands beside, and a formula in an
        // empty table column becomes its calculated column (ADR 517).
        if self.table_after_entry(sheet, row, col, input)? {
            result.changed = self.rebuilt_changes();
        }
        Ok(EnterResult {
            applied: true,
            alert: None,
            result: Some(result),
        })
    }

    /// The validation at `(row, col)`: its rule and, for a list rule with
    /// the in-cell dropdown on, the items.
    pub fn validation_at(
        &self,
        sheet: u16,
        row: u32,
        col: u32,
    ) -> Result<Option<CellValidation>, SessionError> {
        self.validate_sheet(sheet)?;
        Ok(self.rule_at(sheet, row, col).map(|(i, r)| CellValidation {
            list_items: (r.kind == DvType::List && r.in_cell_dropdown)
                .then(|| self.list_items_of(sheet, &r, row, col)),
            rule: info_of(i, &r),
        }))
    }

    /// Circle Invalid Data: every non-blank cell of the sheet's rules that
    /// breaks its rule (a blank cell breaks a rule that does not allow
    /// blanks only once it holds something, as in Excel).
    pub fn invalid_cells(&self, sheet: u16) -> Result<Vec<InvalidCell>, SessionError> {
        self.validate_sheet(sheet)?;
        let rules = self.doc.validation_rules(sheet);
        let model = self.engine().model();
        let ws = model.sheet(sheet).expect("validated");
        let mut out = Vec::new();
        for (&(row, col), cell) in ws.cells.iter() {
            if matches!(cell.value, CellValue::Empty) {
                continue;
            }
            if let Some((i, rule)) = rules.iter().enumerate().find(|(_, r)| r.covers(row, col)) {
                if !self.passes(sheet, rule, row, col, &cell.value) {
                    out.push(InvalidCell {
                        row,
                        col,
                        rule: i as u32,
                    });
                }
            }
        }
        Ok(out)
    }

    /// Build a [`DvRule`] from the wasm shape, its formulas parsed and
    /// printed in the storage dialect, relative to `anchor`.
    fn rule_from_arg(
        &self,
        sheet: u16,
        arg: &ValidationRuleArg,
        base: Option<&DvRule>,
    ) -> Result<DvRule, SessionError> {
        let mut r = base.cloned().unwrap_or_default();
        let kind = match arg.kind.as_str() {
            "" => r.kind,
            "any" | "none" => DvType::Any,
            k => {
                let t = DvType::parse(k);
                if t == DvType::Any {
                    return Err(SessionError(format!(
                        "unknown validation type {k:?} (any, whole, decimal, list, date, time, textLength, custom)"
                    )));
                }
                t
            }
        };
        r.kind = kind;
        if let Some(op) = &arg.operator {
            r.operator = DvOperator::parse(op)
                .ok_or_else(|| SessionError(format!("unknown validation operator {op:?}")))?;
        }
        let model = self.engine().model();
        let names = ModelSheetNames { model };
        let ctx = ModelParseCtx {
            model,
            current: sheet,
        };
        let storage = |text: &str| -> Result<String, SessionError> {
            let t = text.trim();
            let t = t.strip_prefix('=').unwrap_or(t);
            if inline_items(t).is_some() {
                return Ok(t.to_string());
            }
            let f = parse(t, &ctx)
                .map_err(|e| SessionError(format!("validation formula {text:?}: {e}")))?;
            Ok(print_ooxml(&f, sheet, &names))
        };
        if let Some(items) = &arg.list_items {
            if items.iter().any(|i| i.contains(',')) {
                return Err(SessionError(
                    "a list item cannot contain a comma (use a range as the source)".into(),
                ));
            }
            let joined = items.join(",");
            if joined.chars().count() > 255 {
                return Err(SessionError(
                    "an inline list is limited to 255 characters (use a range as the source)"
                        .into(),
                ));
            }
            r.formula1 = Some(format!("\"{}\"", joined.replace('"', "\"\"")));
        } else if let Some(f) = &arg.formula1 {
            r.formula1 = if f.trim().is_empty() {
                None
            } else {
                Some(storage(f)?)
            };
        }
        if let Some(f) = &arg.formula2 {
            r.formula2 = if f.trim().is_empty() {
                None
            } else {
                Some(storage(f)?)
            };
        }
        if !r.kind.uses_operator() || !r.operator.binary() {
            r.formula2 = None;
        }
        if r.kind == DvType::Any {
            r.formula1 = None;
        }
        let need1 = r.kind != DvType::Any;
        if need1 && r.formula1.is_none() {
            return Err(SessionError("the rule needs a value or source".into()));
        }
        if r.kind.uses_operator() && r.operator.binary() && r.formula2.is_none() {
            return Err(SessionError(
                "between and not between need a minimum and a maximum".into(),
            ));
        }
        if let Some(b) = arg.allow_blank {
            r.allow_blank = b;
        }
        if let Some(b) = arg.in_cell_dropdown {
            r.in_cell_dropdown = b;
        }
        if let Some(b) = arg.show_input {
            r.show_input = b;
        }
        if let Some(b) = arg.show_error {
            r.show_error = b;
        }
        if let Some(s) = &arg.error_style {
            r.error_style = match s.as_str() {
                "stop" => DvErrorStyle::Stop,
                "warning" => DvErrorStyle::Warning,
                "information" => DvErrorStyle::Information,
                other => return Err(SessionError(format!("unknown alert style {other:?}"))),
            };
        }
        let text = |v: &Option<String>, cur: &Option<String>, max: usize, what: &str| {
            let out = match v {
                Some(s) if s.is_empty() => None,
                Some(s) => Some(s.clone()),
                None => cur.clone(),
            };
            if out.as_ref().is_some_and(|s| s.chars().count() > max) {
                return Err(SessionError(format!(
                    "the {what} is limited to {max} characters"
                )));
            }
            Ok(out)
        };
        r.prompt_title = text(&arg.prompt_title, &r.prompt_title, 32, "input title")?;
        r.prompt = text(&arg.prompt, &r.prompt, 255, "input message")?;
        r.error_title = text(&arg.error_title, &r.error_title, 32, "error title")?;
        r.error = text(&arg.error, &r.error, 255, "error message")?;
        Ok(r)
    }

    fn guard_validation_edit(&self, sheet: u16) -> Result<(), SessionError> {
        if self.active_protection(sheet).is_some() {
            return Err(SessionError(
                "The sheet is protected: unprotect it to change data validation.".into(),
            ));
        }
        Ok(())
    }

    /// Data ▸ Validation ▸ OK: give `range` (A1 list, space- or
    /// comma-separated) the rule `arg`. The cells leave every other rule;
    /// operand formulas are relative to the range's top-left cell.
    pub fn set_validation(
        &mut self,
        sheet: u16,
        range: &str,
        arg: ValidationRuleArg,
    ) -> Result<Vec<ValidationRuleInfo>, SessionError> {
        self.validate_sheet(sheet)?;
        self.guard_validation_edit(sheet)?;
        let ranges = parse_sqref(&range.replace(',', " "));
        if ranges.is_empty() {
            return Err(SessionError(format!("{range:?} is not a range")));
        }
        let mut rule = self.rule_from_arg(sheet, &arg, None)?;
        rule.ranges = ranges.clone();
        let mut rules = self.doc.validation_rules(sheet);
        for r in &mut rules {
            for &cut in &ranges {
                r.ranges = r.ranges.iter().flat_map(|&a| rect_minus(a, cut)).collect();
            }
        }
        rules.retain(|r| !r.ranges.is_empty());
        rules.push(rule);
        self.write_rules(sheet, &rules)
    }

    /// Edit rule `index` in place (its ranges stay; absent fields are kept).
    pub fn update_validation(
        &mut self,
        sheet: u16,
        index: u32,
        arg: ValidationRuleArg,
    ) -> Result<Vec<ValidationRuleInfo>, SessionError> {
        self.validate_sheet(sheet)?;
        self.guard_validation_edit(sheet)?;
        let mut rules = self.doc.validation_rules(sheet);
        let base = rules
            .get(index as usize)
            .cloned()
            .ok_or_else(|| SessionError(format!("no validation rule {index}")))?;
        let mut r = self.rule_from_arg(sheet, &arg, Some(&base))?;
        r.ranges = base.ranges;
        rules[index as usize] = r;
        self.write_rules(sheet, &rules)
    }

    /// Data ▸ Validation ▸ Clear All over `range`.
    pub fn clear_validation(
        &mut self,
        sheet: u16,
        range: &str,
    ) -> Result<Vec<ValidationRuleInfo>, SessionError> {
        self.validate_sheet(sheet)?;
        self.guard_validation_edit(sheet)?;
        let ranges = parse_sqref(&range.replace(',', " "));
        let mut rules = self.doc.validation_rules(sheet);
        for r in &mut rules {
            for &cut in &ranges {
                r.ranges = r.ranges.iter().flat_map(|&a| rect_minus(a, cut)).collect();
            }
        }
        rules.retain(|r| !r.ranges.is_empty());
        self.write_rules(sheet, &rules)
    }

    fn write_rules(
        &mut self,
        sheet: u16,
        rules: &[DvRule],
    ) -> Result<Vec<ValidationRuleInfo>, SessionError> {
        self.doc
            .set_validation_rules(sheet, rules)
            .map_err(|e| SessionError(e.to_string()))?;
        self.extra_dirty.insert(sheet);
        self.list_validation_rules(sheet)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inline_lists() {
        assert_eq!(
            inline_items("\"a,b,c\""),
            Some(vec!["a".into(), "b".into(), "c".into()])
        );
        assert_eq!(inline_items("$A$1:$A$3"), None);
    }
}
