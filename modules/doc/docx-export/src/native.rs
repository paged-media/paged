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

//! A native paged document as a Word document (doc ADR 616, "Save as
//! .docx" for documents not imported from Word).
//!
//! The bundle reads what the host can tell it: each story's paragraphs and
//! runs (`document.storyContent`), the paragraph and character styles they
//! name (`document.styleProperties`), the colours of the swatches they use,
//! and the first page's size and margins. This module turns that into a
//! [`DocxDocument`], which [`crate::write_docx`] writes as a package. The
//! style properties map through the same inverse the save-back uses
//! (`invert_props`, `invert_para_props`); a paragraph style whose list type
//! is a bullet or numbered list makes its paragraphs Word list items.
//! Tables, pictures and frames are not in the story read and are not
//! written.

use std::collections::{BTreeMap, HashMap};

use docx_core::{
    Block, DocxDocument, ListKind, ListMarker, ParaProps, Paragraph, Run, RunProps, Section, Style,
    StyleCatalog, StyleKind,
};
use docx_lower::ir::{LoweredDoc, PropValue, StyleProp};
use serde::Deserialize;

use crate::diff::{invert_para_props, invert_props};
use crate::overlay::{add_canvas_colors, StoryContentIn};
use crate::styles::{own_value, StyleIn};

/// The first page's geometry, in points.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageIn {
    pub width_pt: f32,
    pub height_pt: f32,
    #[serde(default)]
    pub margin_top_pt: Option<f32>,
    #[serde(default)]
    pub margin_bottom_pt: Option<f32>,
    #[serde(default)]
    pub margin_left_pt: Option<f32>,
    #[serde(default)]
    pub margin_right_pt: Option<f32>,
    #[serde(default)]
    pub columns: Option<u32>,
    #[serde(default)]
    pub column_gutter_pt: Option<f32>,
}

/// What the bundle hands over for "Save as .docx".
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeDocIn {
    /// The stories, in reading order.
    pub stories: Vec<StoryContentIn>,
    /// The styles the stories name, as the host reads them.
    #[serde(default)]
    pub styles: Vec<StyleIn>,
    /// Swatch id → `RRGGBB` for the colours the runs and styles use.
    #[serde(default)]
    pub colors: BTreeMap<String, String>,
    #[serde(default)]
    pub page: Option<PageIn>,
}

/// Engine style names that are Word's defaults.
fn is_basic_paragraph(name: &str) -> bool {
    matches!(
        name,
        "[Basic Paragraph]" | "[No Paragraph Style]" | "NormalParagraphStyle" | "Normal"
    )
}

fn is_no_character_style(name: &str) -> bool {
    matches!(name, "[No character style]" | "[None]")
}

/// The name a style token shows (`ParagraphStyle/Heading 1` → `Heading 1`).
fn token_name(token: &str) -> &str {
    token.rsplit('/').next().unwrap_or(token)
}

/// Word's id and name for an engine style.
fn word_style(name: &str, taken: &[String]) -> (String, String) {
    if is_basic_paragraph(name) {
        return ("Normal".into(), "Normal".into());
    }
    let word_name = match crate::write::heading_level(name) {
        Some(n) => format!("heading {n}"),
        None => name.to_string(),
    };
    let mut base: String = name.chars().filter(|c| c.is_alphanumeric()).collect();
    if let Some(first) = base.get(0..1) {
        base = first.to_uppercase() + &base[1..];
    }
    if base.is_empty() {
        base = "Style".into();
    }
    let mut id = base.clone();
    let mut k = 1;
    while taken.iter().any(|t| t == &id) {
        k += 1;
        id = format!("{base}{k}");
    }
    (id, word_name)
}

/// The document a native paged document is as a Word document.
pub fn native_document(input: &NativeDocIn) -> DocxDocument {
    let mut colours = LoweredDoc::default();
    add_canvas_colors(&mut colours, &input.colors);

    // Styles: the engine token → Word id.
    let mut ids: HashMap<(bool, String), String> = HashMap::new();
    let mut taken: Vec<String> = vec![
        "DefaultParagraphFont".into(),
        "TableNormal".into(),
        "TableGrid".into(),
    ];
    let mut styles: Vec<Style> = Vec::new();
    let mut list_styles: HashMap<String, ListKind> = HashMap::new();
    let mut based_tokens: Vec<(bool, Option<String>)> = Vec::new();
    for st in &input.styles {
        let paragraph = st.collection == "paragraph";
        let name = st
            .name
            .clone()
            .unwrap_or_else(|| token_name(&st.style_id).to_string());
        if !paragraph && is_no_character_style(&name) {
            continue;
        }
        let (id, word_name) = word_style(&name, &taken);
        if id == "Normal" && taken.contains(&id) {
            ids.insert((paragraph, st.style_id.clone()), id);
            continue;
        }
        taken.push(id.clone());
        ids.insert((paragraph, st.style_id.clone()), id.clone());
        let props: Vec<StyleProp> = st
            .entries
            .iter()
            .filter_map(|e| {
                Some(StyleProp {
                    path: e.path.clone(),
                    value: own_value(e.value.as_ref()?)?,
                })
            })
            .collect();
        if paragraph {
            if let Some(kind) = props.iter().find_map(|p| match (&*p.path, &p.value) {
                ("paragraphListType", PropValue::Text(t)) if t == "BulletList" => {
                    Some(ListKind::Bullet)
                }
                ("paragraphListType", PropValue::Text(t)) if t == "NumberedList" => {
                    Some(ListKind::Numbered)
                }
                _ => None,
            }) {
                list_styles.insert(id.clone(), kind);
            }
        }
        let size = props
            .iter()
            .find_map(|p| match (&*p.path, &p.value) {
                ("characterFontSize", PropValue::Length(v)) => Some(*v),
                _ => None,
            })
            .unwrap_or(12.0);
        based_tokens.push((paragraph, st.based_on.clone()));
        styles.push(Style {
            table: None,
            is_default: id == "Normal",
            style_id: id,
            name: Some(word_name),
            kind: if paragraph {
                StyleKind::Paragraph
            } else {
                StyleKind::Character
            },
            based_on: None,
            para: if paragraph {
                invert_para_props(&props)
            } else {
                ParaProps::default()
            },
            run: clean_run(invert_props(&props, size, &colours)),
        });
    }
    // `basedOn` tokens → Word ids (a style based on itself stands on its
    // own; one based on the engine's root on Normal).
    let lookup = |paragraph: bool, token: &Option<String>| -> Option<String> {
        let t = token.as_ref()?;
        ids.get(&(paragraph, t.clone())).cloned().or_else(|| {
            (paragraph && is_basic_paragraph(token_name(t))).then(|| "Normal".to_string())
        })
    };
    for (s, (paragraph, token)) in styles.iter_mut().zip(&based_tokens) {
        s.based_on = lookup(*paragraph, token).filter(|b| b != &s.style_id);
    }

    let mut body = Vec::new();
    let mut list_ids: HashMap<String, i32> = HashMap::new();
    for story in &input.stories {
        for p in &story.paragraphs {
            let style_id = lookup(true, &p.paragraph_style);
            let list = style_id.as_ref().and_then(|id| {
                let kind = *list_styles.get(id)?;
                let next = i32::try_from(list_ids.len()).unwrap_or(0) + 1;
                let num_id = *list_ids.entry(id.clone()).or_insert(next);
                Some(ListMarker {
                    kind,
                    num_id,
                    level: 0,
                    bullet_char: (kind == ListKind::Bullet).then(|| "\u{2022}".into()),
                    number_format: (kind == ListKind::Numbered).then(|| "1, 2, 3, 4...".into()),
                    left_indent: Some(720),
                    first_line_indent: None,
                    hanging_indent: Some(360),
                    marker_font: None,
                    marker_half_pts: None,
                })
            });
            let runs = p
                .runs
                .iter()
                .filter(|r| !r.text.is_empty())
                .map(|r| {
                    let overrides = r.overrides();
                    let size = r.point_size.unwrap_or(12.0);
                    Run {
                        style_id: lookup(false, &r.character_style),
                        props: clean_run(invert_props(&overrides, size, &colours)),
                        // The engine's paragraph-internal line break.
                        text: r.text.replace('\n', "\u{2028}"),
                        ..Run::default()
                    }
                })
                .collect();
            body.push(Block::Paragraph(Paragraph {
                style_id,
                runs,
                list,
                ..Paragraph::default()
            }));
        }
    }

    let mut section = Section::default();
    if let Some(page) = &input.page {
        let tw = |pt: f32| (pt * 20.0).round() as i32;
        if page.width_pt > 0.0 && page.height_pt > 0.0 {
            section.page_width = tw(page.width_pt);
            section.page_height = tw(page.height_pt);
        }
        if let Some(v) = page.margin_top_pt {
            section.margin_top = tw(v);
        }
        if let Some(v) = page.margin_bottom_pt {
            section.margin_bottom = tw(v);
        }
        if let Some(v) = page.margin_left_pt {
            section.margin_left = tw(v);
        }
        if let Some(v) = page.margin_right_pt {
            section.margin_right = tw(v);
        }
        if let Some(c) = page.columns {
            section.columns = c.max(1);
        }
        if let Some(g) = page.column_gutter_pt {
            section.column_space = tw(g);
        }
    }

    DocxDocument {
        body,
        styles: StyleCatalog {
            styles,
            ..StyleCatalog::default()
        },
        sections: vec![section],
        ..DocxDocument::default()
    }
}

/// A `Regular` font style reads as bold and italic off; Word needs neither
/// said where nothing turned them on.
fn clean_run(mut r: RunProps) -> RunProps {
    if r.bold == Some(false) {
        r.bold = None;
    }
    if r.italic == Some(false) {
        r.italic = None;
    }
    r
}
