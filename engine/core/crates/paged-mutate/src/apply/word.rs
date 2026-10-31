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

//! Engine ADR 1018 — the setters of Word's character and paragraph
//! additions: one helper per group, shared by runs, paragraphs and the
//! style definitions, so every level reads a value the same way and
//! undoes it the same way.

use paged_model::{CharacterDecorations, ParagraphBorder, ParagraphShading, UnderlineKind};

use crate::error::OperationError;
use crate::operation::{PropertyPath, Value};

type Pair = (Value, Value);

fn mismatch(path: PropertyPath, expected: &str) -> OperationError {
    OperationError::TypeMismatch {
        path,
        expected: expected.to_string(),
    }
}

fn color(
    path: PropertyPath,
    value: &Value,
    slot: &mut Option<String>,
) -> Result<Pair, OperationError> {
    let Value::ColorRef(c) = value else {
        return Err(mismatch(path, "ColorRef"));
    };
    let prev = std::mem::replace(slot, c.clone());
    Ok((Value::ColorRef(prev), Value::ColorRef(c.clone())))
}

/// A flag: `Value::Bool` sets it; `Value::Text("")` clears it back to
/// "inherit", which is what the inverse of a write over an unset flag
/// carries, so the undo restores the model exactly (ADR 197).
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
    let prev = std::mem::replace(slot, *n);
    Ok((Value::Length(prev), Value::Length(*n)))
}

/// The underline-type value grammar: `kind`, `kind@switch` or `@switch`,
/// where the switch is `on`, `off` or `inherit`. Returns the kind
/// (`None` for `""`) and the switch (`None` when not given).
pub(crate) fn parse_underline_type(
    s: &str,
) -> Result<(Option<UnderlineKind>, Option<Option<bool>>), String> {
    let (kind, switch) = match s.split_once('@') {
        Some((k, sw)) => (k, Some(sw)),
        None => (s, None),
    };
    let kind = if kind.is_empty() {
        None
    } else {
        Some(
            UnderlineKind::from_name(kind)
                .ok_or_else(|| format!("unknown underline kind {kind:?}"))?,
        )
    };
    let switch = match switch {
        None => None,
        Some("on") => Some(Some(true)),
        Some("off") => Some(Some(false)),
        Some("inherit") => Some(None),
        Some(other) => return Err(format!("unknown underline switch {other:?}")),
    };
    Ok((kind, switch))
}

fn underline_type_value(kind: Option<UnderlineKind>, underline: Option<bool>) -> String {
    let switch = match underline {
        Some(true) => "on",
        Some(false) => "off",
        None => "inherit",
    };
    format!(
        "{}@{switch}",
        kind.map(UnderlineKind::as_name).unwrap_or("")
    )
}

/// The character paths of ADR 1018 on one level's `decorations` (and its
/// `underline` switch, which the underline type moves with it). `None`
/// when `path` is not one of them.
pub(crate) fn set_decoration_field(
    decorations: &mut CharacterDecorations,
    underline: &mut Option<bool>,
    path: PropertyPath,
    value: &Value,
) -> Option<Result<Pair, OperationError>> {
    Some(match path {
        PropertyPath::CharacterHighlightColor => {
            color(path, value, &mut decorations.highlight_color)
        }
        PropertyPath::CharacterUnderlineColor => {
            color(path, value, &mut decorations.underline_color)
        }
        PropertyPath::CharacterHidden => flag(path, value, &mut decorations.hidden),
        PropertyPath::CharacterDoubleStrikethrough => {
            flag(path, value, &mut decorations.double_strikethrough)
        }
        PropertyPath::CharacterUnderlineType => (|| {
            let Value::Text(s) = value else {
                return Err(mismatch(path, "Text"));
            };
            let (kind, switch) =
                parse_underline_type(s).map_err(|reason| OperationError::InvalidValue {
                    node: crate::NodeId::Document(String::new()),
                    path,
                    reason,
                })?;
            let prev = underline_type_value(decorations.underline_kind, *underline);
            decorations.underline_kind = kind;
            match switch {
                Some(sw) => *underline = sw,
                // A bare kind turns the underline on, `none` off; a bare
                // `""` leaves the switch.
                None => {
                    if let Some(k) = kind {
                        *underline = Some(k != UnderlineKind::None);
                    }
                }
            }
            Ok((Value::Text(prev), Value::Text(s.clone())))
        })(),
        _ => return None,
    })
}

/// The paragraph shading and border paths of ADR 1018 on one level's
/// structs. `None` when `path` is not one of them.
pub(crate) fn set_shading_border_field(
    shading: &mut ParagraphShading,
    border: &mut ParagraphBorder,
    path: PropertyPath,
    value: &Value,
) -> Option<Result<Pair, OperationError>> {
    Some(match path {
        PropertyPath::ParagraphShadingOn => flag(path, value, &mut shading.on),
        PropertyPath::ParagraphShadingColor => color(path, value, &mut shading.color),
        PropertyPath::ParagraphShadingTint => length(path, value, &mut shading.tint),
        PropertyPath::ParagraphBorderOn => flag(path, value, &mut border.on),
        PropertyPath::ParagraphBorderColor => color(path, value, &mut border.color),
        PropertyPath::ParagraphBorderWeight => length(path, value, &mut border.weight),
        _ => return None,
    })
}

/// Whether `path` is one of ADR 1018's character paths.
pub(crate) fn is_decoration_path(path: PropertyPath) -> bool {
    matches!(
        path,
        PropertyPath::CharacterHighlightColor
            | PropertyPath::CharacterHidden
            | PropertyPath::CharacterUnderlineType
            | PropertyPath::CharacterUnderlineColor
            | PropertyPath::CharacterDoubleStrikethrough
    )
}

/// Whether `path` is one of ADR 1018's paragraph shading / border paths.
pub(crate) fn is_shading_border_path(path: PropertyPath) -> bool {
    matches!(
        path,
        PropertyPath::ParagraphShadingOn
            | PropertyPath::ParagraphShadingColor
            | PropertyPath::ParagraphShadingTint
            | PropertyPath::ParagraphBorderOn
            | PropertyPath::ParagraphBorderColor
            | PropertyPath::ParagraphBorderWeight
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn underline_type_sets_the_switch_and_undoes_exactly() {
        let mut d = CharacterDecorations::default();
        let mut u = None;
        let (prev, _) = set_decoration_field(
            &mut d,
            &mut u,
            PropertyPath::CharacterUnderlineType,
            &Value::Text("double".into()),
        )
        .unwrap()
        .unwrap();
        assert_eq!(d.underline_kind, Some(UnderlineKind::Double));
        assert_eq!(u, Some(true));
        set_decoration_field(&mut d, &mut u, PropertyPath::CharacterUnderlineType, &prev)
            .unwrap()
            .unwrap();
        assert_eq!((d.underline_kind, u), (None, None));
        set_decoration_field(
            &mut d,
            &mut u,
            PropertyPath::CharacterUnderlineType,
            &Value::Text("none".into()),
        )
        .unwrap()
        .unwrap();
        assert_eq!(u, Some(false));
        assert!(parse_underline_type("zigzag").is_err());
        assert!(parse_underline_type("single@maybe").is_err());
    }
}
