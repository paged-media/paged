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

//! Engine ADR 1052 — a content control: a range of a paragraph's text that
//! is a form field (Word's inline `w:sdt`). The control's text is ordinary
//! runs, each carrying the control ([`crate::CharacterRun::control`]); the
//! control says what the text means and how it may change: free text, a
//! checkbox drawn as its glyph, a value chosen from a list, or a date.
//! Setting a value, toggling a checkbox or choosing an item rewrites the
//! control's runs as one undo step.

use serde::{Deserialize, Serialize};

use crate::word_field::{format_word_date, CivilDateTime};

/// A content control on a run. Every run of one control carries the same
/// control (same [`ContentControl::id`]); the runs are contiguous in one
/// paragraph.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentControl {
    /// The control's id in its story (Word's `w:id`, or one minted).
    pub id: String,
    /// What the control holds.
    pub kind: ContentControlKind,
    /// Word's `w:tag` — the author's machine name for it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tag: Option<String>,
    /// Word's `w:alias` — its title.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alias: Option<String>,
    /// Word's `w:lock`: `sdtLocked`, `contentLocked`, `sdtContentLocked`.
    /// A content lock refuses every value change.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lock: Option<String>,
    /// The text shown is the placeholder (Word's `w:showingPlcHdr`): the
    /// first value set replaces it.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub showing_placeholder: bool,
    /// The character style the placeholder text is drawn in, taken off
    /// the runs when a value replaces it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub placeholder_style: Option<String>,
}

/// The kinds of content control.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ContentControlKind {
    /// Plain text (`w:text`): its value is set as one run.
    PlainText {
        #[serde(default)]
        multi_line: bool,
    },
    /// Rich text (no type element): its runs keep their own formatting; a
    /// value set takes the first run's.
    RichText,
    /// A checkbox (`w14:checkbox`): drawn as its state's glyph in that
    /// glyph's font.
    Checkbox {
        checked: bool,
        checked_glyph: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        checked_font: Option<String>,
        unchecked_glyph: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        unchecked_font: Option<String>,
    },
    /// A drop-down list (`w:dropDownList`) or, with `combo`, a combo box
    /// (`w:comboBox`, which also takes free text). `value` is the chosen
    /// item's value.
    DropDown {
        #[serde(default)]
        combo: bool,
        items: Vec<ListItem>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        value: Option<String>,
    },
    /// A date (`w:date`): `value` is the date (`YYYY-MM-DD`, Word's
    /// `w:fullDate`), drawn with `format` (a Word date picture,
    /// `w:dateFormat`).
    Date {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        format: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        value: Option<String>,
    },
}

/// One item of a drop-down or combo box (`w:listItem`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListItem {
    /// What the list shows and the text draws (`w:displayText`).
    pub display: String,
    /// What the control's value is (`w:value`).
    pub value: String,
}

/// The default checkbox glyphs (Word's: ☒ and ☐ in MS Gothic).
pub const CHECKED_GLYPH: &str = "\u{2612}";
pub const UNCHECKED_GLYPH: &str = "\u{2610}";

impl ContentControl {
    /// A content lock refuses value changes.
    pub fn content_locked(&self) -> bool {
        matches!(
            self.lock.as_deref(),
            Some("contentLocked" | "sdtContentLocked")
        )
    }

    /// The text a value draws as, and the control with that value. `Err`
    /// when the kind refuses it: a drop-down only takes one of its items (by
    /// value or by display text; a combo box also free text), a date only
    /// `YYYY-MM-DD`, a checkbox `true`, `false` or `toggle`.
    pub fn with_value(&self, value: &str) -> Result<(ContentControl, String), String> {
        let mut next = self.clone();
        next.showing_placeholder = false;
        let text = match &mut next.kind {
            ContentControlKind::PlainText { multi_line } => {
                if *multi_line {
                    value.to_string()
                } else {
                    value.replace(['\n', '\r', '\u{2028}'], " ")
                }
            }
            ContentControlKind::RichText => value.to_string(),
            ContentControlKind::Checkbox {
                checked,
                checked_glyph,
                unchecked_glyph,
                ..
            } => {
                *checked = match value {
                    "true" | "1" => true,
                    "false" | "0" => false,
                    "toggle" => !*checked,
                    other => return Err(format!("a checkbox takes true or false, not {other:?}")),
                };
                if *checked {
                    checked_glyph.clone()
                } else {
                    unchecked_glyph.clone()
                }
            }
            ContentControlKind::DropDown {
                combo,
                items,
                value: chosen,
            } => match items
                .iter()
                .find(|i| i.value == value)
                .or_else(|| items.iter().find(|i| i.display == value))
            {
                Some(item) => {
                    *chosen = Some(item.value.clone());
                    item.display.clone()
                }
                None if *combo => {
                    *chosen = None;
                    value.to_string()
                }
                None => return Err(format!("{value:?} is not an item of the list")),
            },
            ContentControlKind::Date {
                format,
                value: date,
            } => {
                let at = CivilDateTime::parse(value)
                    .ok_or_else(|| format!("a date takes YYYY-MM-DD, not {value:?}"))?;
                *date = Some(format!("{:04}-{:02}-{:02}", at.year, at.month, at.day));
                format_word_date(format.as_deref(), &at, false)
            }
        };
        Ok((next, text))
    }

    /// The font the checkbox's current glyph is drawn in, when it names one.
    pub fn glyph_font(&self) -> Option<&str> {
        match &self.kind {
            ContentControlKind::Checkbox {
                checked: true,
                checked_font,
                ..
            } => checked_font.as_deref(),
            ContentControlKind::Checkbox {
                checked: false,
                unchecked_font,
                ..
            } => unchecked_font.as_deref(),
            _ => None,
        }
    }

    /// The checkbox's state, `None` for any other kind.
    pub fn checked(&self) -> Option<bool> {
        match &self.kind {
            ContentControlKind::Checkbox { checked, .. } => Some(*checked),
            _ => None,
        }
    }

    /// The kind's name as the wire spells it.
    pub fn kind_name(&self) -> &'static str {
        match &self.kind {
            ContentControlKind::PlainText { .. } => "plainText",
            ContentControlKind::RichText => "richText",
            ContentControlKind::Checkbox { .. } => "checkbox",
            ContentControlKind::DropDown { combo: false, .. } => "dropDown",
            ContentControlKind::DropDown { combo: true, .. } => "comboBox",
            ContentControlKind::Date { .. } => "date",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn control(kind: ContentControlKind) -> ContentControl {
        ContentControl {
            id: "1".into(),
            kind,
            tag: None,
            alias: None,
            lock: None,
            showing_placeholder: true,
            placeholder_style: None,
        }
    }

    #[test]
    fn values_by_kind() {
        let cb = control(ContentControlKind::Checkbox {
            checked: false,
            checked_glyph: CHECKED_GLYPH.into(),
            checked_font: Some("MS Gothic".into()),
            unchecked_glyph: UNCHECKED_GLYPH.into(),
            unchecked_font: Some("MS Gothic".into()),
        });
        let (on, text) = cb.with_value("true").unwrap();
        assert_eq!(text, CHECKED_GLYPH);
        assert_eq!(on.checked(), Some(true));
        assert!(!on.showing_placeholder);
        assert!(cb.with_value("maybe").is_err());
        assert_eq!(on.with_value("toggle").unwrap().0.checked(), Some(false));
        let dd = control(ContentControlKind::DropDown {
            combo: false,
            items: vec![
                ListItem {
                    display: "Red".into(),
                    value: "r".into(),
                },
                ListItem {
                    display: "Blue".into(),
                    value: "b".into(),
                },
            ],
            value: None,
        });
        let (next, text) = dd.with_value("b").unwrap();
        assert_eq!(text, "Blue");
        assert!(
            matches!(next.kind, ContentControlKind::DropDown { value: Some(ref v), .. } if v == "b")
        );
        assert_eq!(dd.with_value("Red").unwrap().1, "Red");
        assert!(dd.with_value("Green").is_err());
        let date = control(ContentControlKind::Date {
            format: Some("d MMMM yyyy".into()),
            value: None,
        });
        assert_eq!(date.with_value("2026-10-30").unwrap().1, "30 October 2026");
        assert!(date.with_value("tomorrow").is_err());
        let plain = control(ContentControlKind::PlainText { multi_line: false });
        assert_eq!(plain.with_value("a\nb").unwrap().1, "a b");
    }

    #[test]
    fn serialises_with_its_kind_tag() {
        let c = control(ContentControlKind::Date {
            format: None,
            value: Some("2026-01-02".into()),
        });
        let json = serde_json::to_string(&c).unwrap();
        assert!(json.contains(r#""type":"date""#), "{json}");
        let back: ContentControl = serde_json::from_str(&json).unwrap();
        assert_eq!(back, c);
    }
}
