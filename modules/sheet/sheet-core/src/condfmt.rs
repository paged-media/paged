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

//! The conditional-formatting model — the W2.4 amendment of the frozen
//! types (sheet ADR 523). One model for every rule kind Excel writes in
//! `<conditionalFormatting>` and its `x14` extension, shared by the xlsx
//! reader / writer, the evaluator (`sheet_calc::cf`) and the authoring API.
//! Formulas are kept as TEXT in the en dialect, relative to the top-left
//! cell of the block's first range (as the file stores them); the evaluator
//! parses them once and moves relative references per cell.

use crate::visual::{ColorRef, DifferentialFormat};

/// A block's cell range `(r0, c0, r1, c1)`, 0-based inclusive.
pub type CfRange = (u32, u32, u32, u32);

/// The comparison of a `cellIs` rule.
#[derive(Copy, Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CfOp {
    Equal,
    NotEqual,
    GreaterThan,
    GreaterThanOrEqual,
    LessThan,
    LessThanOrEqual,
    Between,
    NotBetween,
}

impl CfOp {
    pub fn parse(s: &str) -> Option<CfOp> {
        Some(match s {
            "equal" => CfOp::Equal,
            "notEqual" => CfOp::NotEqual,
            "greaterThan" => CfOp::GreaterThan,
            "greaterThanOrEqual" => CfOp::GreaterThanOrEqual,
            "lessThan" => CfOp::LessThan,
            "lessThanOrEqual" => CfOp::LessThanOrEqual,
            "between" => CfOp::Between,
            "notBetween" => CfOp::NotBetween,
            _ => return None,
        })
    }

    pub fn as_xlsx(self) -> &'static str {
        match self {
            CfOp::Equal => "equal",
            CfOp::NotEqual => "notEqual",
            CfOp::GreaterThan => "greaterThan",
            CfOp::GreaterThanOrEqual => "greaterThanOrEqual",
            CfOp::LessThan => "lessThan",
            CfOp::LessThanOrEqual => "lessThanOrEqual",
            CfOp::Between => "between",
            CfOp::NotBetween => "notBetween",
        }
    }

    /// Takes two operands.
    pub fn is_range(self) -> bool {
        matches!(self, CfOp::Between | CfOp::NotBetween)
    }
}

/// The text test of a text rule.
#[derive(Copy, Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CfTextOp {
    Contains,
    NotContains,
    BeginsWith,
    EndsWith,
}

impl CfTextOp {
    /// The rule `type` attribute.
    pub fn rule_type(self) -> &'static str {
        match self {
            CfTextOp::Contains => "containsText",
            CfTextOp::NotContains => "notContainsText",
            CfTextOp::BeginsWith => "beginsWith",
            CfTextOp::EndsWith => "endsWith",
        }
    }

    /// The `operator` attribute.
    pub fn operator(self) -> &'static str {
        match self {
            CfTextOp::Contains => "containsText",
            CfTextOp::NotContains => "notContains",
            CfTextOp::BeginsWith => "beginsWith",
            CfTextOp::EndsWith => "endsWith",
        }
    }
}

/// A `timePeriod` rule's period (relative to today).
#[derive(Copy, Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CfTimePeriod {
    Today,
    Yesterday,
    Tomorrow,
    Last7Days,
    ThisWeek,
    LastWeek,
    NextWeek,
    ThisMonth,
    LastMonth,
    NextMonth,
}

/// Every period with its xlsx token.
pub const TIME_PERIODS: [(CfTimePeriod, &str); 10] = [
    (CfTimePeriod::Today, "today"),
    (CfTimePeriod::Yesterday, "yesterday"),
    (CfTimePeriod::Tomorrow, "tomorrow"),
    (CfTimePeriod::Last7Days, "last7Days"),
    (CfTimePeriod::ThisWeek, "thisWeek"),
    (CfTimePeriod::LastWeek, "lastWeek"),
    (CfTimePeriod::NextWeek, "nextWeek"),
    (CfTimePeriod::ThisMonth, "thisMonth"),
    (CfTimePeriod::LastMonth, "lastMonth"),
    (CfTimePeriod::NextMonth, "nextMonth"),
];

impl CfTimePeriod {
    pub fn parse(s: &str) -> Option<CfTimePeriod> {
        TIME_PERIODS.iter().find(|(_, t)| *t == s).map(|(p, _)| *p)
    }

    pub fn as_xlsx(self) -> &'static str {
        TIME_PERIODS
            .iter()
            .find(|(p, _)| *p == self)
            .map(|(_, t)| *t)
            .unwrap_or("today")
    }
}

/// How a colour-scale / data-bar / icon-set threshold is found (`cfvo`).
#[derive(Copy, Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CfvoKind {
    Min,
    Max,
    Num,
    Percent,
    Percentile,
    Formula,
    /// x14: the minimum, or 0 when every value is positive (data bars).
    AutoMin,
    /// x14: the maximum, or 0 when every value is negative.
    AutoMax,
}

impl CfvoKind {
    pub fn parse(s: &str) -> Option<CfvoKind> {
        Some(match s {
            "min" => CfvoKind::Min,
            "max" => CfvoKind::Max,
            "num" => CfvoKind::Num,
            "percent" => CfvoKind::Percent,
            "percentile" => CfvoKind::Percentile,
            "formula" => CfvoKind::Formula,
            "autoMin" => CfvoKind::AutoMin,
            "autoMax" => CfvoKind::AutoMax,
            _ => return None,
        })
    }

    pub fn as_xlsx(self) -> &'static str {
        match self {
            CfvoKind::Min => "min",
            CfvoKind::Max => "max",
            CfvoKind::Num => "num",
            CfvoKind::Percent => "percent",
            CfvoKind::Percentile => "percentile",
            CfvoKind::Formula => "formula",
            CfvoKind::AutoMin => "autoMin",
            CfvoKind::AutoMax => "autoMax",
        }
    }
}

/// One threshold (`cfvo`): its kind, its value (a number or a formula, as
/// text) and whether the comparison is `>=` (`gte`, the default) or `>`.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Cfvo {
    pub kind: CfvoKind,
    pub val: Option<String>,
    pub gte: bool,
}

impl Cfvo {
    pub fn new(kind: CfvoKind, val: Option<&str>) -> Cfvo {
        Cfvo {
            kind,
            val: val.map(str::to_string),
            gte: true,
        }
    }
}

/// Where a data bar's axis sits (x14).
#[derive(Copy, Clone, Debug, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AxisPosition {
    /// At the zero point of the bar's domain when it holds negatives.
    #[default]
    Automatic,
    /// In the middle of the cell.
    Middle,
    /// No axis: negative values draw like positive ones.
    None,
}

/// A data bar's direction (x14).
#[derive(Copy, Clone, Debug, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum BarDirection {
    #[default]
    Context,
    LeftToRight,
    RightToLeft,
}

/// A data bar (the 2006 `<dataBar>` plus its `x14:dataBar` extension).
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataBarRule {
    pub min: Cfvo,
    pub max: Cfvo,
    pub color: ColorRef,
    pub show_value: bool,
    /// Shortest / longest bar as a percentage of the cell (0–100).
    pub min_length: u32,
    pub max_length: u32,
    /// Gradient (true, the 2006 look) or solid fill.
    pub gradient: bool,
    pub border: bool,
    pub border_color: Option<ColorRef>,
    pub negative_color: Option<ColorRef>,
    pub negative_border_color: Option<ColorRef>,
    /// Negative bars take the positive colours.
    pub negative_same_as_positive: bool,
    pub axis_position: AxisPosition,
    pub axis_color: Option<ColorRef>,
    pub direction: BarDirection,
}

impl DataBarRule {
    /// A 2006 data bar (no x14 extension): gradient, min/max lengths 10/90.
    pub fn new(min: Cfvo, max: Cfvo, color: ColorRef) -> DataBarRule {
        DataBarRule {
            min,
            max,
            color,
            show_value: true,
            min_length: 10,
            max_length: 90,
            gradient: true,
            border: false,
            border_color: None,
            negative_color: None,
            negative_border_color: None,
            negative_same_as_positive: false,
            axis_position: AxisPosition::Automatic,
            axis_color: None,
            direction: BarDirection::Context,
        }
    }
}

/// An icon set (2006 `<iconSet>` or `x14:iconSet`, custom icons included).
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IconSetRule {
    /// The set name (`3TrafficLights1`, `5Arrows`, `3Stars`, `NoIcons`, …).
    pub set: String,
    /// The thresholds, lowest icon first (`cfvos[0]` is the floor).
    pub cfvos: Vec<Cfvo>,
    pub reverse: bool,
    pub show_value: bool,
    /// x14 custom icons: per position `(set, icon index)` overriding the
    /// set's own (`None` = the set's icon).
    pub custom: Vec<Option<(String, u32)>>,
}

/// What a rule tests and paints.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
// A data bar is the large variant; rules are few per sheet and cloned
// rarely, so it stays inline rather than boxed.
#[allow(clippy::large_enum_variant)]
pub enum CfKind {
    /// `cellIs`: the value compared with one or two formula operands.
    CellIs {
        op: CfOp,
        formulas: Vec<String>,
    },
    /// `expression`: a formula that is true for a painted cell.
    Expression {
        formula: String,
    },
    /// `top10`: the top/bottom N items or N percent of the range.
    Top10 {
        rank: u32,
        percent: bool,
        bottom: bool,
    },
    /// `aboveAverage`: above/below the mean, `equal` including it,
    /// `std_dev` standard deviations away (0 = the mean itself).
    AboveAverage {
        above: bool,
        equal: bool,
        std_dev: u32,
    },
    /// `duplicateValues` / `uniqueValues`.
    Duplicates {
        unique: bool,
    },
    /// `containsText` / `notContainsText` / `beginsWith` / `endsWith`.
    Text {
        op: CfTextOp,
        text: String,
    },
    /// `timePeriod`.
    TimePeriod {
        period: CfTimePeriod,
    },
    /// `containsBlanks` / `notContainsBlanks`.
    Blanks {
        blank: bool,
    },
    /// `containsErrors` / `notContainsErrors`.
    Errors {
        error: bool,
    },
    /// `colorScale`: 2 or 3 thresholds and their colours.
    ColorScale {
        cfvos: Vec<Cfvo>,
        colors: Vec<ColorRef>,
    },
    DataBar(DataBarRule),
    IconSet(IconSetRule),
    /// A rule type this model does not know (kept, not evaluated).
    Unknown {
        name: String,
    },
}

impl CfKind {
    /// Whether the rule paints its differential format (as against a
    /// scale, a bar or an icon).
    pub fn paints_dxf(&self) -> bool {
        !matches!(
            self,
            CfKind::ColorScale { .. }
                | CfKind::DataBar(_)
                | CfKind::IconSet(_)
                | CfKind::Unknown { .. }
        )
    }
}

/// One rule.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CfRule {
    pub kind: CfKind,
    /// Lower is earlier (wins).
    pub priority: i64,
    pub stop_if_true: bool,
    /// The differential format a matching dxf rule applies (the workbook's
    /// `dxfs` entry, resolved by id on read).
    pub dxf: Option<DifferentialFormat>,
    /// The `dxfId` the rule was read with (the writer keeps it when the
    /// format is unchanged).
    pub dxf_id: Option<u32>,
    /// The x14 rule id (`{GUID}`) linking a 2006 rule to its extension.
    pub ext_id: Option<String>,
}

impl CfRule {
    pub fn new(kind: CfKind, priority: i64) -> CfRule {
        CfRule {
            kind,
            priority,
            stop_if_true: false,
            dxf: None,
            dxf_id: None,
            ext_id: None,
        }
    }
}

/// One `<conditionalFormatting>` block: its ranges and rules.
#[derive(Clone, Debug, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CfBlock {
    pub ranges: Vec<CfRange>,
    pub rules: Vec<CfRule>,
    /// The block came from the `x14` extension only (no 2006 counterpart).
    pub x14_only: bool,
}

impl CfBlock {
    pub fn contains(&self, row: u32, col: u32) -> bool {
        self.ranges
            .iter()
            .any(|&(r0, c0, r1, c1)| row >= r0 && row <= r1 && col >= c0 && col <= c1)
    }

    /// The cell relative references in its formulas are written from: the
    /// top-left of the first range.
    pub fn anchor(&self) -> (u32, u32) {
        self.ranges.first().map(|r| (r.0, r.1)).unwrap_or((0, 0))
    }
}

/// A sheet's conditional formats.
#[derive(Clone, Debug, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetCf {
    pub blocks: Vec<CfBlock>,
}

impl SheetCf {
    pub fn is_empty(&self) -> bool {
        self.blocks.is_empty()
    }
}
