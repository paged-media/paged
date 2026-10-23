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

//! AutoFilter as a FILTER VIEW (Wave 7). A [`FilterView`] is a range whose
//! first row is the header and whose remaining rows are kept or hidden by
//! per-column criteria (ECMA-376 §18.3.2 `autoFilter` / `filterColumn`).
//!
//! Two sources fill [`crate::Worksheet::filters`]:
//! - the workbook's own `<autoFilter>` (sheet-level, or a table's), read by
//!   `sheet-xlsx` so the criteria are KNOWN (the XML still re-emits
//!   verbatim — preservation is unchanged);
//! - a Paged filter view set through `sheet-js` (`set_filter`), which is a
//!   VIEW: it changes which rows the page lowering shows, it is not written
//!   into the xlsx.
//!
//! Which rows a view hides is computed by `sheet-js` (it formats values) into
//! [`crate::Worksheet::filtered_rows`] when the view is set — like Excel, a
//! filter is applied when set, not re-evaluated on every edit. Rows the file
//! saved as hidden are [`crate::Worksheet::hidden_rows`]. The page lowering
//! skips both ([`crate::Worksheet::row_hidden`]).

use compact_str::CompactString;

use crate::refs::RangeRef;

/// One filter view over a range (header row first).
#[derive(Clone, Debug, PartialEq)]
pub struct FilterView {
    /// The filtered range INCLUDING its header row.
    pub range: RangeRef,
    /// Per-column criteria; a row is shown iff it satisfies every one.
    pub columns: Vec<ColumnFilter>,
    /// True when the view came from the workbook (`<autoFilter>`), false for
    /// a Paged view.
    pub from_file: bool,
}

/// The criterion on one column of a [`FilterView`].
#[derive(Clone, Debug, PartialEq)]
pub struct ColumnFilter {
    /// 0-based column offset within [`FilterView::range`] (`colId`).
    pub col: u32,
    pub criterion: FilterCriterion,
}

/// A column criterion (ECMA-376 §18.3.2.2–.10). Everything Excel's filter
/// dropdown writes has a variant (the ADR 517 amendment added `DateGroups`,
/// `Custom`, `Dynamic`, `Color` and `Icon`); [`FilterCriterion::Unsupported`]
/// is what is left — an extension criterion Paged does not read, preserved
/// in the file and not applied.
#[derive(Clone, Debug, PartialEq)]
pub enum FilterCriterion {
    /// Keep rows whose displayed text equals one of `values`
    /// (case-insensitive); `blanks` also keeps empty cells (`<filters>`).
    Values {
        values: Vec<CompactString>,
        blanks: bool,
    },
    /// Keep rows whose displayed text contains `text` (case-insensitive) —
    /// Excel's `customFilter val="*text*"`.
    Contains(CompactString),
    /// Keep the `n` largest (`top`) or smallest numbers, or that percentage
    /// of them when `percent` (`<top10>`).
    Top { n: f64, percent: bool, top: bool },
    /// Any other criterion (not applied).
    Unsupported,
    /// A value list with date groups (`<filters>` holding `<dateGroupItem>`s):
    /// keep rows whose text is one of `values`, whose date falls in one of
    /// `dates`, or (with `blanks`) that are empty. ADR 517 amendment.
    DateGroups {
        values: Vec<CompactString>,
        blanks: bool,
        dates: Vec<DateGroup>,
    },
    /// One or two operator conditions (`<customFilters [and="1"]>`); text
    /// operands may carry the wildcards `*`, `?` and `~`. ADR 517 amendment.
    Custom {
        and: bool,
        conditions: Vec<CustomCondition>,
    },
    /// A dynamic filter (`<dynamicFilter type=…>`): `aboveAverage`,
    /// `belowAverage`, `today`, `thisWeek`, `lastMonth`, `Q1`…`Q4`,
    /// `M1`…`M12`, `yearToDate`, … `val`/`max_val` are the bounds Excel
    /// computed when the filter was applied. ADR 517 amendment.
    Dynamic {
        kind: CompactString,
        val: Option<f64>,
        max_val: Option<f64>,
    },
    /// Keep rows whose cell (`cell_color`) or font colour is the colour of
    /// differential format `dxf_id` (`<colorFilter>`). ADR 517 amendment.
    Color {
        cell_color: bool,
        dxf_id: Option<u32>,
    },
    /// Keep rows whose conditional-format icon is icon `id` of icon set `set`
    /// (`<iconFilter>`; no `id`: no icon). ADR 517 amendment.
    Icon { set: CompactString, id: Option<u32> },
}

/// The comparison of a [`CustomCondition`] (`ST_FilterOperator`).
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum FilterOp {
    Equal,
    NotEqual,
    LessThan,
    LessThanOrEqual,
    GreaterThan,
    GreaterThanOrEqual,
}

impl FilterOp {
    pub fn parse(s: &str) -> Option<FilterOp> {
        Some(match s {
            "equal" => FilterOp::Equal,
            "notEqual" => FilterOp::NotEqual,
            "lessThan" => FilterOp::LessThan,
            "lessThanOrEqual" => FilterOp::LessThanOrEqual,
            "greaterThan" => FilterOp::GreaterThan,
            "greaterThanOrEqual" => FilterOp::GreaterThanOrEqual,
            _ => return None,
        })
    }

    pub fn as_str(self) -> &'static str {
        match self {
            FilterOp::Equal => "equal",
            FilterOp::NotEqual => "notEqual",
            FilterOp::LessThan => "lessThan",
            FilterOp::LessThanOrEqual => "lessThanOrEqual",
            FilterOp::GreaterThan => "greaterThan",
            FilterOp::GreaterThanOrEqual => "greaterThanOrEqual",
        }
    }
}

/// One `<customFilter operator val>`.
#[derive(Clone, Debug, PartialEq)]
pub struct CustomCondition {
    pub op: FilterOp,
    pub val: CompactString,
}

/// One `<dateGroupItem>`: a year, optionally narrowed to a month, day,
/// hour, minute or second (`grouping` says how deep).
#[derive(Clone, Debug, PartialEq)]
pub struct DateGroup {
    pub year: u32,
    pub month: Option<u32>,
    pub day: Option<u32>,
    pub hour: Option<u32>,
    pub minute: Option<u32>,
    pub second: Option<u32>,
}
