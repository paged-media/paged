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

//! The stored cell value (spec §5.1). `CellValue` is the on-the-wire
//! result type — what a cell holds and what crosses the engine boundary.
//! Calculation diagnostics that are NOT storable values (notably
//! circular-reference detection) live in `sheet-calc`, never here.

use compact_str::CompactString;

/// A computed/stored cell value. `Empty` models a blank cell (distinct
/// from `Text("")`) and is the `Default`.
#[derive(Clone, Debug, Default, PartialEq, serde::Serialize)]
pub enum CellValue {
    #[default]
    Empty,
    Number(f64),
    Text(CompactString),
    Bool(bool),
    Error(CellError),
}

/// The cell-error codes: the eight of ECMA-376 §18.17.4 (`#SPILL!` with
/// them), then the six errors of Excel 365 (W1.0 versioned amendment,
/// 2026-10-22, sheet ADR 513). `Copy`/`Eq`/`Hash` so errors flow through
/// interned literals and dedup cleanly.
///
/// The six newer codes have no literal in the file format: Excel writes them
/// as `#VALUE!` plus a rich value naming the real error, and the xlsx writer
/// stores `#VALUE!` (`sheet-xlsx` `stored_error`).
///
/// NOTE: `#CIRCULAR!` is intentionally absent. Circularity is a
/// sheet-calc *diagnostic*, never a stored wire value — a cycle member keeps
/// its last value (sheet ADR 514), so it has no place in the canonical value
/// enum.
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash, serde::Serialize)]
pub enum CellError {
    Div0,
    Value,
    Ref,
    Name,
    Num,
    Na,
    Null,
    Spill,
    /// `#CALC!` — an empty array, a nested array, a lambda used as a value.
    Calc,
    /// `#FIELD!` — a field of a data type that does not exist.
    Field,
    /// `#BUSY!` — a value still being computed elsewhere.
    Busy,
    /// `#CONNECT!` — a connection-backed function (cube) without its source.
    Connect,
    /// `#BLOCKED!` — a function the workbook may not run (a network call).
    Blocked,
    /// `#UNKNOWN!` — a value of a type this engine does not know.
    Unknown,
}

impl CellError {
    /// The display token, e.g. `Div0` -> `"#DIV/0!"`.
    pub fn as_str(self) -> &'static str {
        match self {
            CellError::Div0 => "#DIV/0!",
            CellError::Value => "#VALUE!",
            CellError::Ref => "#REF!",
            CellError::Name => "#NAME?",
            CellError::Num => "#NUM!",
            CellError::Na => "#N/A",
            CellError::Null => "#NULL!",
            CellError::Spill => "#SPILL!",
            CellError::Calc => "#CALC!",
            CellError::Field => "#FIELD!",
            CellError::Busy => "#BUSY!",
            CellError::Connect => "#CONNECT!",
            CellError::Blocked => "#BLOCKED!",
            CellError::Unknown => "#UNKNOWN!",
        }
    }

    /// Parse a display token back into a code. Exact-match on punctuation,
    /// case-insensitive on the letters (`#div/0!` == `#DIV/0!`). Returns
    /// `None` on any non-error string.
    pub fn parse(s: &str) -> Option<CellError> {
        // ASCII-uppercase the letters; punctuation/digits are unaffected.
        let upper = s.to_ascii_uppercase();
        match upper.as_str() {
            "#DIV/0!" => Some(CellError::Div0),
            "#VALUE!" => Some(CellError::Value),
            "#REF!" => Some(CellError::Ref),
            "#NAME?" => Some(CellError::Name),
            "#NUM!" => Some(CellError::Num),
            "#N/A" => Some(CellError::Na),
            "#NULL!" => Some(CellError::Null),
            "#SPILL!" => Some(CellError::Spill),
            "#CALC!" => Some(CellError::Calc),
            "#FIELD!" => Some(CellError::Field),
            "#BUSY!" => Some(CellError::Busy),
            "#CONNECT!" => Some(CellError::Connect),
            "#BLOCKED!" => Some(CellError::Blocked),
            "#UNKNOWN!" => Some(CellError::Unknown),
            _ => None,
        }
    }
}

impl CellError {
    /// Excel's `ERROR.TYPE` number: 1–8 for the classic codes (`#GETTING_DATA`
    /// is 8 and has no variant), then `#SPILL!` 9, `#CONNECT!` 10,
    /// `#BLOCKED!` 11, `#UNKNOWN!` 12, `#FIELD!` 13, `#CALC!` 14 (recorded:
    /// `ERROR.TYPE(SEQUENCE(0))` is 14) and `#BUSY!` 15 — the order of the
    /// rich-value `errorType` Excel stores for the newer codes.
    pub fn type_number(self) -> u8 {
        match self {
            CellError::Null => 1,
            CellError::Div0 => 2,
            CellError::Value => 3,
            CellError::Ref => 4,
            CellError::Name => 5,
            CellError::Num => 6,
            CellError::Na => 7,
            CellError::Spill => 9,
            CellError::Connect => 10,
            CellError::Blocked => 11,
            CellError::Unknown => 12,
            CellError::Field => 13,
            CellError::Calc => 14,
            CellError::Busy => 15,
        }
    }
}

impl CellValue {
    /// True only for `Empty` (a blank cell). `Text("")` is NOT blank.
    pub fn is_blank(&self) -> bool {
        matches!(self, CellValue::Empty)
    }
}

impl From<f64> for CellValue {
    fn from(n: f64) -> Self {
        CellValue::Number(n)
    }
}

impl From<bool> for CellValue {
    fn from(b: bool) -> Self {
        CellValue::Bool(b)
    }
}

impl From<&str> for CellValue {
    fn from(s: &str) -> Self {
        CellValue::Text(CompactString::new(s))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALL: [CellError; 14] = [
        CellError::Div0,
        CellError::Value,
        CellError::Ref,
        CellError::Name,
        CellError::Num,
        CellError::Na,
        CellError::Null,
        CellError::Spill,
        CellError::Calc,
        CellError::Field,
        CellError::Busy,
        CellError::Connect,
        CellError::Blocked,
        CellError::Unknown,
    ];

    #[test]
    fn cellerror_parse_as_str_roundtrip() {
        for e in ALL {
            assert_eq!(CellError::parse(e.as_str()), Some(e));
        }
    }

    #[test]
    fn cellerror_parse_case_insensitive() {
        assert_eq!(CellError::parse("#div/0!"), Some(CellError::Div0));
        assert_eq!(CellError::parse("#n/a"), Some(CellError::Na));
        assert_eq!(CellError::parse("#Name?"), Some(CellError::Name));
    }

    #[test]
    fn cellerror_parse_rejects_junk() {
        assert_eq!(CellError::parse("#FOO!"), None);
        assert_eq!(CellError::parse(""), None);
        assert_eq!(CellError::parse("DIV/0"), None);
    }

    #[test]
    fn is_blank_only_for_empty() {
        assert!(CellValue::Empty.is_blank());
        assert!(!CellValue::from("").is_blank());
        assert!(!CellValue::from(0.0).is_blank());
    }

    #[test]
    fn from_conversions() {
        assert_eq!(CellValue::from(1.5), CellValue::Number(1.5));
        assert_eq!(CellValue::from(true), CellValue::Bool(true));
        assert_eq!(
            CellValue::from("hi"),
            CellValue::Text(CompactString::new("hi"))
        );
    }
}
