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

//! Doc ADR 614 (content controls) — an inline `w:sdt`'s `w:sdtPr` read into
//! the control its runs carry. The kinds the engine edits are plain and
//! rich text, checkboxes (`w14:checkbox`), drop-downs and combo boxes, and
//! dates; any other (a building-block gallery, a picture, a citation, a
//! repeating section…) is shown as its content and stays in the source.

use docx_core::{ContentControl, ContentControlKind, ListItem};
use paged_ooxml::ooxmlsdk::schemas::schemas_openxmlformats_org_wordprocessingml_2006_main as wml;

/// The control `pr` describes, or `None` for a kind the engine does not edit.
pub(crate) fn read(pr: &wml::SdtProperties, ordinal: u32) -> Option<ContentControl> {
    use wml::SdtPropertiesChoice as C;
    let mut id = None;
    let mut tag = None;
    let mut alias = None;
    let mut lock = None;
    let mut showing = false;
    let mut kind = None;
    let mut unsupported = false;
    for c in &pr.sdt_properties_choice {
        match c {
            C::SdtId(i) => id = Some(i.val),
            C::Tag(t) => tag = Some(t.val.clone()),
            C::SdtAlias(a) => alias = Some(a.val.clone()),
            C::Lock(l) => lock = l.val.map(|v| v.to_string()),
            C::ShowingPlaceholder(s) => showing = s.val.is_none_or(|v| v.into()),
            C::SdtContentText(t) => {
                kind = Some(ContentControlKind::PlainText {
                    multi_line: t.multi_line.is_some_and(|v| v.into()),
                })
            }
            C::SdtContentRichText => kind = Some(ContentControlKind::RichText),
            C::SdtContentDropDownList(d) => {
                kind = Some(ContentControlKind::DropDown {
                    combo: false,
                    items: items(&d.list_item),
                    value: d.last_value.clone(),
                })
            }
            C::SdtContentComboBox(d) => {
                kind = Some(ContentControlKind::DropDown {
                    combo: true,
                    items: items(&d.list_item),
                    value: d.last_value.clone(),
                })
            }
            C::SdtContentDate(d) => {
                kind = Some(ContentControlKind::Date {
                    format: d.date_format.as_ref().map(|f| f.val.clone()),
                    value: d
                        .full_date
                        .as_ref()
                        .map(|v| v.chars().take(10).collect::<String>()),
                })
            }
            C::SdtContentCheckBox(cb) => {
                let glyph = |hex: Option<&String>, fallback: &str| {
                    hex.and_then(|h| u32::from_str_radix(h, 16).ok())
                        .and_then(char::from_u32)
                        .map(|c| c.to_string())
                        .unwrap_or_else(|| fallback.to_string())
                };
                kind = Some(ContentControlKind::Checkbox {
                    checked: cb
                        .checked
                        .as_ref()
                        .and_then(|c| c.val)
                        .is_some_and(|v| {
                            use paged_ooxml::ooxmlsdk::schemas::schemas_microsoft_com_office_word_2010_wordml::OnOffValues as V;
                            matches!(v, V::True | V::One)
                        }),
                    checked_glyph: glyph(
                        cb.checked_state.as_ref().and_then(|s| s.val.as_ref()),
                        "\u{2612}",
                    ),
                    checked_font: cb.checked_state.as_ref().and_then(|s| s.font.clone()),
                    unchecked_glyph: glyph(
                        cb.unchecked_state.as_ref().and_then(|s| s.val.as_ref()),
                        "\u{2610}",
                    ),
                    unchecked_font: cb.unchecked_state.as_ref().and_then(|s| s.font.clone()),
                })
            }
            C::SdtContentDocPartObject(_)
            | C::SdtContentDocPartList(_)
            | C::SdtContentPicture
            | C::SdtContentCitation
            | C::SdtContentBibliography
            | C::SdtContentEquation
            | C::SdtContentGroup
            | C::SdtRepeatedSection(_)
            | C::SdtRepeatedSectionItem
            | C::EntityPickerEmpty => unsupported = true,
            _ => {}
        }
    }
    if unsupported {
        return None;
    }
    Some(ContentControl {
        id: match id {
            Some(i) => format!("w{i}"),
            None => format!("sdt{ordinal}"),
        },
        // No type element: rich text, Word's default.
        kind: kind.unwrap_or(ContentControlKind::RichText),
        tag,
        alias,
        lock,
        showing_placeholder: showing,
        placeholder_style: None,
    })
}

fn items(list: &[wml::ListItem]) -> Vec<ListItem> {
    list.iter()
        .map(|i| {
            let display = i
                .display_text
                .clone()
                .or_else(|| i.value.clone())
                .unwrap_or_default();
            ListItem {
                value: i.value.clone().unwrap_or_else(|| display.clone()),
                display,
            }
        })
        .collect()
}
