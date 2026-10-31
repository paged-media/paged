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

//! The deck's outline (slide ADR 720), read from the document: for each
//! page, the text of its title placeholder and the paragraphs of its body
//! placeholders (body, object, subtitle) with their list level, as
//! PowerPoint's Outline view and its Outline/RTF export show them. Text
//! boxes, tables and pictures are not part of an outline.

use paged_scene::Document;
use slide_output::OutlineSlide;

use crate::native::{self, NShape};
use crate::probe::canonical;
use crate::text::level_of;

/// A paragraph's text, its line breaks kept as spaces.
fn paragraph_text(p: &paged_model::Paragraph) -> String {
    p.runs
        .iter()
        .map(|r| r.text.replace(['\u{2028}', '\n', '\r'], " "))
        .collect::<String>()
        .trim_end()
        .to_string()
}

fn collect(doc: &Document, shapes: &[NShape], out: &mut OutlineSlide) {
    for s in shapes {
        if !s.children.is_empty() && s.label.placeholder.is_none() {
            collect(doc, &s.children, out);
            continue;
        }
        let Some((kind, _)) = &s.label.placeholder else {
            continue;
        };
        let Some(story) = s.text_frame().and_then(|e| e.story()) else {
            continue;
        };
        let Some(paras) = native::story(doc, &story) else {
            continue;
        };
        match canonical(Some(kind.as_str())) {
            "title" => {
                let t: Vec<String> = paras
                    .iter()
                    .map(paragraph_text)
                    .filter(|t| !t.is_empty())
                    .collect();
                if !t.is_empty() {
                    if !out.title.is_empty() {
                        out.title.push(' ');
                    }
                    out.title.push_str(&t.join(" "));
                }
            }
            "body" | "subTitle" => {
                for p in paras {
                    let t = paragraph_text(p);
                    if !t.is_empty() {
                        out.body.push((level_of(p), t));
                    }
                }
            }
            _ => {}
        }
    }
}

/// The outline of `pages` (page ids, in order) of the document's `.paged`
/// serialization. A page the document does not have is left out.
pub fn outline(paged: &[u8], pages: &[String]) -> Result<Vec<OutlineSlide>, String> {
    let doc = native::read(paged)?;
    Ok(outline_of(&doc, pages))
}

/// [`outline`] over a read document.
pub fn outline_of(doc: &Document, pages: &[String]) -> Vec<OutlineSlide> {
    pages
        .iter()
        .filter_map(|pid| {
            let spread = native::spread_of(doc, pid)?;
            let mut s = OutlineSlide::default();
            collect(doc, &native::page_shapes(spread), &mut s);
            Some(s)
        })
        .collect()
}
