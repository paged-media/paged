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

//! Engine ADR 1022 — Word fields in IDML. InDesign has no fields; where it
//! has a text variable that does the same, a field is written as an
//! instance of one:
//!
//! | Word field | InDesign |
//! |---|---|
//! | `PAGE` | the current page number marker (`<?ACE 18?>`) |
//! | `NUMPAGES` | `LastPageNumberType`, document scope |
//! | `SECTIONPAGES` | `LastPageNumberType`, section scope |
//! | `STYLEREF "S"` (`\l`) | `MatchParagraphStyleType`, `FirstOnPage` (`LastOnPage`) |
//! | `DATE` / `TIME` | `OutputDateType` with the picture in InDesign's tokens |
//!
//! InDesign's last page number is the last page's LABEL, so `NUMPAGES` and
//! `SECTIONPAGES` agree with Word's counts only when numbering starts at 1
//! and does not restart (thoughts ADR 033). Every other field (`REF`,
//! `PAGEREF`, `SEQ`, an opaque one) is written as its result, as text. The
//! `.paged` model part keeps the fields themselves.

use paged_model::{TextVariable, WordFieldKind};
use paged_scene::Document;

/// `Self` of the variable a Word field kind is written as.
fn variable_id(name: &str) -> String {
    format!("dTextVariablenWord {name}")
}

/// A Word date picture in InDesign's date tokens: `ddd` → `EEE`, `dddd` →
/// `EEEE`, `am/pm` → `a`; the rest (`d` `M` `y` `h` `H` `m` `s`, quoted
/// literals) is the same in both.
pub(crate) fn indesign_date_format(word: &str) -> String {
    let mut out = String::new();
    let chars: Vec<char> = word.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '\'' {
            out.push(c);
            i += 1;
            while i < chars.len() && chars[i] != '\'' {
                out.push(chars[i]);
                i += 1;
            }
            if i < chars.len() {
                out.push('\'');
                i += 1;
            }
            continue;
        }
        if c == 'd' {
            let n = chars[i..].iter().take_while(|&&x| x == 'd').count();
            out.push_str(match n {
                1 => "d",
                2 => "dd",
                3 => "EEE",
                _ => "EEEE",
            });
            i += n;
            continue;
        }
        if (c == 'a' || c == 'A') && i + 5 <= chars.len() {
            let w: String = chars[i..i + 5].iter().collect();
            if w.eq_ignore_ascii_case("am/pm") {
                out.push('a');
                i += 5;
                continue;
            }
        }
        out.push(c);
        i += 1;
    }
    out
}

/// The document with its Word fields lowered as above, or `None` when it
/// has none (so an ordinary document is written as it is).
pub(crate) fn lower(doc: &Document) -> Option<Document> {
    let has = doc.stories.iter().any(|s| {
        s.story
            .paragraphs
            .iter()
            .any(|p| p.runs.iter().any(|r| r.field.is_some()))
    });
    if !has {
        return None;
    }
    let mut out = doc.clone();
    let mut variables: Vec<TextVariable> = Vec::new();
    for parsed in &mut out.stories {
        for para in &mut parsed.story.paragraphs {
            for run in &mut para.runs {
                let Some(field) = run.field.take() else {
                    continue;
                };
                let var = match &field.kind {
                    WordFieldKind::Page => {
                        run.text = paged_model::AUTO_PAGE_NUMBER_MARKER.to_string();
                        None
                    }
                    WordFieldKind::NumPages => Some(TextVariable {
                        self_id: variable_id("NUMPAGES"),
                        name: Some("Word NUMPAGES".into()),
                        variable_type: Some("LastPageNumberType".into()),
                        page_number_scope: Some("DocumentScope".into()),
                        ..Default::default()
                    }),
                    WordFieldKind::SectionPages => Some(TextVariable {
                        self_id: variable_id("SECTIONPAGES"),
                        name: Some("Word SECTIONPAGES".into()),
                        variable_type: Some("LastPageNumberType".into()),
                        page_number_scope: Some("SectionScope".into()),
                        ..Default::default()
                    }),
                    WordFieldKind::StyleRef { style, last } => {
                        let style_id = paged_renderer_style_id(doc, style);
                        style_id.map(|id| {
                            let key =
                                format!("STYLEREF {style}{}", if *last { " last" } else { "" });
                            TextVariable {
                                self_id: variable_id(&key),
                                name: Some(format!("Word {key}")),
                                variable_type: Some("MatchParagraphStyleType".into()),
                                running_header_style: Some(id),
                                running_header_use: Some(
                                    if *last { "LastOnPage" } else { "FirstOnPage" }.into(),
                                ),
                                ..Default::default()
                            }
                        })
                    }
                    WordFieldKind::Date { format, time } => {
                        let picture = format.clone().unwrap_or_else(|| {
                            if *time { "h:mm am/pm" } else { "M/d/yyyy" }.to_string()
                        });
                        let key = format!("DATE {picture}");
                        Some(TextVariable {
                            self_id: variable_id(&key),
                            name: Some(format!("Word {key}")),
                            variable_type: Some("OutputDateType".into()),
                            date_format: Some(indesign_date_format(&picture)),
                            ..Default::default()
                        })
                    }
                    _ => None,
                };
                if let Some(var) = var {
                    // An empty `ResultText` is dropped on import (C-39).
                    if run.text.is_empty() {
                        run.text = " ".to_string();
                    }
                    run.text_variable = Some(var.self_id.clone());
                    if !variables.iter().any(|v| v.self_id == var.self_id) {
                        variables.push(var);
                    }
                }
            }
        }
    }
    for var in variables {
        if !out
            .designmap
            .text_variables
            .iter()
            .any(|v| v.self_id == var.self_id)
        {
            out.designmap.text_variables.push(var);
        }
    }
    Some(out)
}

/// The paragraph style a `STYLEREF` names (its `Self`, its name, or
/// `ParagraphStyle/<name>`).
fn paged_renderer_style_id(doc: &Document, name: &str) -> Option<String> {
    let styles = &doc.styles.paragraph_styles;
    if styles.contains_key(name) {
        return Some(name.to_string());
    }
    let prefixed = format!("ParagraphStyle/{name}");
    if styles.contains_key(&prefixed) {
        return Some(prefixed);
    }
    styles
        .iter()
        .find(|(_, s)| {
            s.name
                .as_deref()
                .is_some_and(|n| n.eq_ignore_ascii_case(name))
        })
        .map(|(id, _)| id.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn word_date_pictures_become_indesign_tokens() {
        assert_eq!(
            indesign_date_format("dddd, d MMMM yyyy"),
            "EEEE, d MMMM yyyy"
        );
        assert_eq!(indesign_date_format("ddd h:mm am/pm"), "EEE h:mm a");
        assert_eq!(indesign_date_format("'day' dd"), "'day' dd");
    }
}
