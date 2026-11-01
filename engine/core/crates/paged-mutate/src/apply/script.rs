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

//! Engine ADR 1051 — the setters of a paragraph's base direction and a
//! run's script slots and direction: one helper shared by runs, paragraphs
//! and the style definitions, so every level reads a value the same way
//! and undoes it the same way. An unset value is `Value::Text("")` (or, for
//! the size, `Value::Length(None)`), which is what the inverse of a write
//! over an unset field carries, so the undo restores the model exactly.

use paged_model::{CharacterDirection, FontHint, ParagraphDirection, ScriptProperties};

use crate::error::OperationError;
use crate::operation::{PropertyPath, Value};

type Pair = (Value, Value);

fn mismatch(path: PropertyPath, expected: &str) -> OperationError {
    OperationError::TypeMismatch {
        path,
        expected: expected.to_string(),
    }
}

fn invalid(path: PropertyPath, reason: String) -> OperationError {
    OperationError::InvalidValue {
        node: crate::NodeId::Document(String::new()),
        path,
        reason,
    }
}

/// A named enum value: `Value::Text(name)`, `""` clears.
fn named<T: Copy>(
    path: PropertyPath,
    value: &Value,
    slot: &mut Option<T>,
    parse: impl Fn(&str) -> Option<T>,
    name: impl Fn(T) -> &'static str,
) -> Result<Pair, OperationError> {
    let Value::Text(s) = value else {
        return Err(mismatch(path, "Text"));
    };
    let next = if s.is_empty() {
        None
    } else {
        Some(parse(s).ok_or_else(|| invalid(path, format!("unknown value {s:?}")))?)
    };
    let prev = std::mem::replace(slot, next);
    Ok((
        Value::Text(prev.map(&name).unwrap_or("").to_string()),
        value.clone(),
    ))
}

fn text(
    path: PropertyPath,
    value: &Value,
    slot: &mut Option<String>,
) -> Result<Pair, OperationError> {
    let Value::Text(s) = value else {
        return Err(mismatch(path, "Text"));
    };
    let next = (!s.is_empty()).then(|| s.clone());
    let prev = std::mem::replace(slot, next);
    Ok((Value::Text(prev.unwrap_or_default()), value.clone()))
}

fn flag(
    path: PropertyPath,
    value: &Value,
    slot: &mut Option<bool>,
) -> Result<Pair, OperationError> {
    let next = match value {
        Value::Bool(b) => Some(*b),
        Value::Text(t) if t.is_empty() => None,
        _ => return Err(mismatch(path, "Bool")),
    };
    let prev = match std::mem::replace(slot, next) {
        Some(b) => Value::Bool(b),
        None => Value::Text(String::new()),
    };
    Ok((prev, value.clone()))
}

fn length(
    path: PropertyPath,
    value: &Value,
    slot: &mut Option<f32>,
) -> Result<Pair, OperationError> {
    let Value::Length(n) = value else {
        return Err(mismatch(path, "Length"));
    };
    if let Some(v) = n {
        if !(v.is_finite() && *v > 0.0) {
            return Err(invalid(path, format!("size must be positive, got {v}")));
        }
    }
    let prev = std::mem::replace(slot, *n);
    Ok((Value::Length(prev), Value::Length(*n)))
}

/// The character paths of ADR 1051 on one level's script properties.
/// `None` when `path` is not one of them.
pub(crate) fn set_script_field(
    script: &mut ScriptProperties,
    path: PropertyPath,
    value: &Value,
) -> Option<Result<Pair, OperationError>> {
    Some(match path {
        PropertyPath::CharacterDirection => named(
            path,
            value,
            &mut script.direction,
            CharacterDirection::from_name,
            CharacterDirection::as_name,
        ),
        PropertyPath::CharacterEastAsianFont => text(path, value, &mut script.east_asian_font),
        PropertyPath::CharacterComplexFont => text(path, value, &mut script.complex_font),
        PropertyPath::CharacterComplexFontSize => {
            length(path, value, &mut script.complex_point_size)
        }
        PropertyPath::CharacterComplexBold => flag(path, value, &mut script.complex_bold),
        PropertyPath::CharacterComplexItalic => flag(path, value, &mut script.complex_italic),
        PropertyPath::CharacterComplexScript => flag(path, value, &mut script.complex),
        PropertyPath::CharacterFontHint => named(
            path,
            value,
            &mut script.hint,
            FontHint::from_name,
            FontHint::as_name,
        ),
        _ => return None,
    })
}

/// The paragraph's base direction: `Value::Text` of `ltr`, `rtl`, `auto`,
/// `""` clears.
pub(crate) fn set_direction_field(
    slot: &mut Option<ParagraphDirection>,
    path: PropertyPath,
    value: &Value,
) -> Result<Pair, OperationError> {
    named(
        path,
        value,
        slot,
        ParagraphDirection::from_name,
        ParagraphDirection::as_name,
    )
}

/// Whether `path` is one of ADR 1051's character paths.
pub(crate) fn is_script_path(path: PropertyPath) -> bool {
    matches!(
        path,
        PropertyPath::CharacterDirection
            | PropertyPath::CharacterEastAsianFont
            | PropertyPath::CharacterComplexFont
            | PropertyPath::CharacterComplexFontSize
            | PropertyPath::CharacterComplexBold
            | PropertyPath::CharacterComplexItalic
            | PropertyPath::CharacterComplexScript
            | PropertyPath::CharacterFontHint
    )
}

/// A value an ADR 1051 path refuses, checked before any run splits.
pub(crate) fn validate(path: PropertyPath, value: &Value) -> Result<(), String> {
    let mut probe = ScriptProperties::default();
    let mut dir = None;
    let r = if path == PropertyPath::ParagraphDirection {
        set_direction_field(&mut dir, path, value).map(|_| ())
    } else {
        match set_script_field(&mut probe, path, value) {
            Some(r) => r.map(|_| ()),
            None => Ok(()),
        }
    };
    r.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_path_undoes_exactly() {
        let cases = [
            (PropertyPath::CharacterDirection, Value::Text("rtl".into())),
            (
                PropertyPath::CharacterEastAsianFont,
                Value::Text("MS Mincho".into()),
            ),
            (
                PropertyPath::CharacterComplexFont,
                Value::Text("Arial".into()),
            ),
            (
                PropertyPath::CharacterComplexFontSize,
                Value::Length(Some(14.0)),
            ),
            (PropertyPath::CharacterComplexBold, Value::Bool(true)),
            (PropertyPath::CharacterComplexItalic, Value::Bool(false)),
            (PropertyPath::CharacterComplexScript, Value::Bool(true)),
            (
                PropertyPath::CharacterFontHint,
                Value::Text("eastAsia".into()),
            ),
        ];
        for (path, value) in cases {
            let mut s = ScriptProperties::default();
            let (prev, _) = set_script_field(&mut s, path, &value).unwrap().unwrap();
            assert!(!s.is_unset(), "{path:?}");
            set_script_field(&mut s, path, &prev).unwrap().unwrap();
            assert!(s.is_unset(), "{path:?} undoes to unset");
        }
        let mut d = None;
        let (prev, _) = set_direction_field(
            &mut d,
            PropertyPath::ParagraphDirection,
            &Value::Text("rtl".into()),
        )
        .unwrap();
        assert_eq!(d, Some(ParagraphDirection::RightToLeft));
        set_direction_field(&mut d, PropertyPath::ParagraphDirection, &prev).unwrap();
        assert_eq!(d, None);
        assert!(validate(PropertyPath::ParagraphDirection, &Value::Text("up".into())).is_err());
        assert!(validate(PropertyPath::CharacterFontHint, &Value::Text("x".into())).is_err());
        assert!(validate(
            PropertyPath::CharacterComplexFontSize,
            &Value::Length(Some(-1.0))
        )
        .is_err());
    }
}
