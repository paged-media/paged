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

//! Data-validation rules, read and authored (ECMA-376 §18.3.1.32–33; sheet
//! ADR 517). A rule is the whole `<dataValidation>`: kind, operator, the two
//! operand formulas (the OOXML storage dialect, no leading `=`, relative to
//! the top-left cell of the first range), the blank and dropdown flags, the
//! input message and the error alert. The sheet's captured
//! `<dataValidations>` stays the store: [`XlsxDocument::validation_rules`]
//! reads it, [`XlsxDocument::set_validation_rules`] writes it back, keeping
//! each untouched rule's element (and every attribute Paged does not model,
//! `xr:uid` say) as it was.

use crate::error::XlsxError;
use crate::xtree::XNode;
use crate::XlsxDocument;
use sheet_core::{col_to_a1, parse_a1, SheetId};

/// What a rule checks (`type=`).
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum DvType {
    /// `none`: any value (the rule only carries an input message).
    Any,
    Whole,
    Decimal,
    List,
    Date,
    Time,
    TextLength,
    Custom,
}

impl DvType {
    pub fn parse(s: &str) -> DvType {
        match s {
            "whole" => DvType::Whole,
            "decimal" => DvType::Decimal,
            "list" => DvType::List,
            "date" => DvType::Date,
            "time" => DvType::Time,
            "textLength" => DvType::TextLength,
            "custom" => DvType::Custom,
            _ => DvType::Any,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            DvType::Any => "none",
            DvType::Whole => "whole",
            DvType::Decimal => "decimal",
            DvType::List => "list",
            DvType::Date => "date",
            DvType::Time => "time",
            DvType::TextLength => "textLength",
            DvType::Custom => "custom",
        }
    }

    /// Whether the kind compares the value with `operator`.
    pub fn uses_operator(self) -> bool {
        matches!(
            self,
            DvType::Whole | DvType::Decimal | DvType::Date | DvType::Time | DvType::TextLength
        )
    }
}

/// The comparison (`operator=`, `between` by default).
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum DvOperator {
    Between,
    NotBetween,
    Equal,
    NotEqual,
    LessThan,
    LessThanOrEqual,
    GreaterThan,
    GreaterThanOrEqual,
}

impl DvOperator {
    pub fn parse(s: &str) -> Option<DvOperator> {
        Some(match s {
            "between" => DvOperator::Between,
            "notBetween" => DvOperator::NotBetween,
            "equal" => DvOperator::Equal,
            "notEqual" => DvOperator::NotEqual,
            "lessThan" => DvOperator::LessThan,
            "lessThanOrEqual" => DvOperator::LessThanOrEqual,
            "greaterThan" => DvOperator::GreaterThan,
            "greaterThanOrEqual" => DvOperator::GreaterThanOrEqual,
            _ => return None,
        })
    }

    pub fn as_str(self) -> &'static str {
        match self {
            DvOperator::Between => "between",
            DvOperator::NotBetween => "notBetween",
            DvOperator::Equal => "equal",
            DvOperator::NotEqual => "notEqual",
            DvOperator::LessThan => "lessThan",
            DvOperator::LessThanOrEqual => "lessThanOrEqual",
            DvOperator::GreaterThan => "greaterThan",
            DvOperator::GreaterThanOrEqual => "greaterThanOrEqual",
        }
    }

    /// Whether the operator takes two operands.
    pub fn binary(self) -> bool {
        matches!(self, DvOperator::Between | DvOperator::NotBetween)
    }

    /// `v op (a[, b])`.
    pub fn test(self, v: f64, a: f64, b: f64) -> bool {
        match self {
            DvOperator::Between => a <= v && v <= b,
            DvOperator::NotBetween => !(a <= v && v <= b),
            DvOperator::Equal => v == a,
            DvOperator::NotEqual => v != a,
            DvOperator::LessThan => v < a,
            DvOperator::LessThanOrEqual => v <= a,
            DvOperator::GreaterThan => v > a,
            DvOperator::GreaterThanOrEqual => v >= a,
        }
    }
}

/// The error alert's style (`errorStyle=`, `stop` by default).
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum DvErrorStyle {
    Stop,
    Warning,
    Information,
}

impl DvErrorStyle {
    pub fn parse(s: &str) -> DvErrorStyle {
        match s {
            "warning" => DvErrorStyle::Warning,
            "information" => DvErrorStyle::Information,
            _ => DvErrorStyle::Stop,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            DvErrorStyle::Stop => "stop",
            DvErrorStyle::Warning => "warning",
            DvErrorStyle::Information => "information",
        }
    }
}

/// A 0-based inclusive box `(r0, c0, r1, c1)`.
pub type Rect = (u32, u32, u32, u32);

/// One data-validation rule.
#[derive(Clone, Debug, PartialEq)]
pub struct DvRule {
    pub kind: DvType,
    pub operator: DvOperator,
    pub allow_blank: bool,
    /// The in-cell dropdown of a list rule is shown (the XML's
    /// `showDropDown="1"` HIDES it — the attribute is named backwards).
    pub in_cell_dropdown: bool,
    pub show_input: bool,
    pub show_error: bool,
    pub error_style: DvErrorStyle,
    pub error_title: Option<String>,
    pub error: Option<String>,
    pub prompt_title: Option<String>,
    pub prompt: Option<String>,
    pub ranges: Vec<Rect>,
    pub formula1: Option<String>,
    pub formula2: Option<String>,
    /// The element as read (its unknown attributes and children survive an
    /// edit of the rule); `None` for a rule authored here.
    pub raw: Option<XNode>,
}

impl Default for DvRule {
    fn default() -> Self {
        DvRule {
            kind: DvType::Any,
            operator: DvOperator::Between,
            allow_blank: true,
            in_cell_dropdown: true,
            show_input: true,
            show_error: true,
            error_style: DvErrorStyle::Stop,
            error_title: None,
            error: None,
            prompt_title: None,
            prompt: None,
            ranges: Vec::new(),
            formula1: None,
            formula2: None,
            raw: None,
        }
    }
}

/// Parse a `sqref` into boxes.
pub fn parse_sqref(sqref: &str) -> Vec<Rect> {
    sqref
        .split_whitespace()
        .filter_map(|tok| match tok.split_once(':') {
            Some((a, b)) => {
                let (r0, c0, _, _) = parse_a1(a)?;
                let (r1, c1, _, _) = parse_a1(b)?;
                Some((r0.min(r1), c0.min(c1), r0.max(r1), c0.max(c1)))
            }
            None => {
                let (r, c, _, _) = parse_a1(tok)?;
                Some((r, c, r, c))
            }
        })
        .collect()
}

/// Print boxes as a `sqref`.
pub fn print_sqref(ranges: &[Rect]) -> String {
    ranges
        .iter()
        .map(|&(r0, c0, r1, c1)| {
            if (r0, c0) == (r1, c1) {
                format!("{}{}", col_to_a1(c0), r0 + 1)
            } else {
                format!("{}{}:{}{}", col_to_a1(c0), r0 + 1, col_to_a1(c1), r1 + 1)
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// `a` minus `b`: up to four boxes.
pub fn rect_minus(a: Rect, b: Rect) -> Vec<Rect> {
    let (ar0, ac0, ar1, ac1) = a;
    let (br0, bc0, br1, bc1) = b;
    if br1 < ar0 || br0 > ar1 || bc1 < ac0 || bc0 > ac1 {
        return vec![a];
    }
    let mut out = Vec::new();
    if br0 > ar0 {
        out.push((ar0, ac0, br0 - 1, ac1));
    }
    if br1 < ar1 {
        out.push((br1 + 1, ac0, ar1, ac1));
    }
    let (mr0, mr1) = (ar0.max(br0), ar1.min(br1));
    if bc0 > ac0 {
        out.push((mr0, ac0, mr1, bc0 - 1));
    }
    if bc1 < ac1 {
        out.push((mr0, bc1 + 1, mr1, ac1));
    }
    out
}

impl DvRule {
    /// Whether the rule applies to `(row, col)`.
    pub fn covers(&self, row: u32, col: u32) -> bool {
        self.ranges
            .iter()
            .any(|&(r0, c0, r1, c1)| r0 <= row && row <= r1 && c0 <= col && col <= c1)
    }

    /// The cell the operand formulas are written relative to.
    pub fn anchor(&self) -> (u32, u32) {
        self.ranges.first().map_or((0, 0), |r| (r.0, r.1))
    }

    fn from_node(n: &XNode) -> DvRule {
        let text = |l: &str| {
            n.child(l)
                .map(|c| c.text.clone().unwrap_or_default())
                .filter(|s| !s.is_empty())
        };
        DvRule {
            kind: DvType::parse(&n.attr("type").unwrap_or_default()),
            operator: n
                .attr("operator")
                .and_then(|s| DvOperator::parse(&s))
                .unwrap_or(DvOperator::Between),
            allow_blank: n.flag("allowBlank", false),
            in_cell_dropdown: !n.flag("showDropDown", false),
            show_input: n.flag("showInputMessage", false),
            show_error: n.flag("showErrorMessage", false),
            error_style: DvErrorStyle::parse(&n.attr("errorStyle").unwrap_or_default()),
            error_title: n.attr("errorTitle"),
            error: n.attr("error"),
            prompt_title: n.attr("promptTitle"),
            prompt: n.attr("prompt"),
            ranges: parse_sqref(&n.attr("sqref").unwrap_or_default()),
            formula1: text("formula1"),
            formula2: text("formula2"),
            raw: Some(n.clone()),
        }
    }

    fn to_node(&self, prefix: &str) -> XNode {
        let mut n = self
            .raw
            .clone()
            .unwrap_or_else(|| XNode::new(format!("{prefix}dataValidation")));
        let flag = |b: bool| b.then(|| "1".to_string());
        n.set(
            "type",
            (self.kind != DvType::Any).then(|| self.kind.as_str().to_string()),
        );
        n.set(
            "errorStyle",
            (self.error_style != DvErrorStyle::Stop).then(|| self.error_style.as_str().to_string()),
        );
        n.set(
            "operator",
            (self.kind.uses_operator() && self.operator != DvOperator::Between)
                .then(|| self.operator.as_str().to_string()),
        );
        n.set("allowBlank", flag(self.allow_blank));
        n.set("showDropDown", flag(!self.in_cell_dropdown));
        n.set("showInputMessage", flag(self.show_input));
        n.set("showErrorMessage", flag(self.show_error));
        n.set("errorTitle", self.error_title.clone());
        n.set("error", self.error.clone());
        n.set("promptTitle", self.prompt_title.clone());
        n.set("prompt", self.prompt.clone());
        n.set("sqref", Some(print_sqref(&self.ranges)));
        // CT_DataValidation attribute order is free; keep `sqref` last as
        // Excel writes it.
        if let Some(i) = n.attrs.iter().position(|(k, _)| k == "sqref") {
            let a = n.attrs.remove(i);
            n.attrs.push(a);
        }
        n.remove_children("formula1");
        n.remove_children("formula2");
        let p = n.prefix().to_string();
        let mut at = 0;
        for (k, v) in [("formula1", &self.formula1), ("formula2", &self.formula2)] {
            if let Some(f) = v {
                n.children
                    .insert(at, XNode::new(format!("{p}{k}")).with_text(f.clone()));
                at += 1;
            }
        }
        n
    }
}

impl XlsxDocument {
    /// The sheet's data-validation rules, in document order.
    pub fn validation_rules(&self, sheet: SheetId) -> Vec<DvRule> {
        let Some(b) = self.ws_child(sheet, "dataValidations") else {
            return Vec::new();
        };
        let Ok(n) = XNode::parse(b) else {
            return Vec::new();
        };
        n.children_named("dataValidation")
            .map(DvRule::from_node)
            .collect()
    }

    /// Replace the sheet's rules (an empty list removes `<dataValidations>`).
    /// The read-only inventory (`data_validations_of`) follows.
    pub fn set_validation_rules(
        &mut self,
        sheet: SheetId,
        rules: &[DvRule],
    ) -> Result<(), XlsxError> {
        let rules: Vec<&DvRule> = rules.iter().filter(|r| !r.ranges.is_empty()).collect();
        if rules.is_empty() {
            self.set_ws_child(sheet, "dataValidations", None)?;
            self.data_validations.remove(&sheet);
            return Ok(());
        }
        let prefix = self.ws_prefix(sheet);
        let mut root = match self.ws_child(sheet, "dataValidations") {
            Some(b) => XNode::parse(b)?,
            None => XNode::new(format!("{prefix}dataValidations")),
        };
        let p = root.prefix().to_string();
        root.children.retain(|c| c.local() != "dataValidation");
        let kids: Vec<XNode> = rules.iter().map(|r| r.to_node(&p)).collect();
        // `dataValidation` elements are the only CT_DataValidations children.
        root.children.splice(0..0, kids);
        root.set("count", Some(rules.len().to_string()));
        let bytes = root.to_xml().into_bytes();
        let inv = crate::parts::data_validation::parse_block(&bytes)?;
        self.set_ws_child(sheet, "dataValidations", Some(bytes))?;
        match inv {
            Some(i) => {
                self.data_validations.insert(sheet, i);
            }
            None => {
                self.data_validations.remove(&sheet);
            }
        }
        Ok(())
    }
}

#[cfg(test)]
#[allow(non_snake_case)]
mod tests {
    use super::*;

    #[test]
    fn rule_round_trips_and_keeps_unknown_attrs__feat__sheet_validation_author() {
        let x = br#"<dataValidation type="whole" operator="greaterThan" allowBlank="1" showInputMessage="1" showErrorMessage="1" errorTitle="Bad" error="No" sqref="A1:A3 C1" xr:uid="{1}"><formula1>5</formula1></dataValidation>"#;
        let n = XNode::parse(x).unwrap();
        let r = DvRule::from_node(&n);
        assert_eq!(r.kind, DvType::Whole);
        assert_eq!(r.operator, DvOperator::GreaterThan);
        assert_eq!(r.ranges, vec![(0, 0, 2, 0), (0, 2, 0, 2)]);
        assert!(r.in_cell_dropdown && r.show_error && r.allow_blank);
        let out = r.to_node("").to_xml();
        assert!(out.contains(r#"xr:uid="{1}""#));
        assert!(out.contains("<formula1>5</formula1>"));
        assert_eq!(
            DvRule::from_node(&XNode::parse(out.as_bytes()).unwrap()).raw,
            {
                let mut r2 = r.clone();
                r2.raw = Some(XNode::parse(out.as_bytes()).unwrap());
                r2.raw
            }
        );
    }

    #[test]
    fn rect_minus_cuts_four_ways() {
        let a = (0, 0, 9, 9);
        let parts = rect_minus(a, (3, 3, 5, 5));
        let area: u32 = parts
            .iter()
            .map(|r| (r.2 - r.0 + 1) * (r.3 - r.1 + 1))
            .sum();
        assert_eq!(area, 100 - 9);
        assert_eq!(rect_minus(a, (20, 20, 21, 21)), vec![a]);
        assert!(rect_minus(a, (0, 0, 9, 9)).is_empty());
    }
}
