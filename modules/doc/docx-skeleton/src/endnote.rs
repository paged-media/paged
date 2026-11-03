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

//! The endnote story, built in Rust (doc ADR 625, slice 7: endnotes). A
//! hand port of what the engine's `CreateEndnoteStory` and `InsertEndnote`
//! operations make (`paged-mutate` `apply/endnote.rs`, as InDesign 20.0.1
//! makes them), on the model's plain data: a page added at the end of the
//! document, an endnote text frame over its margin box, and the story in it
//! holding the title and, one range after another in reference order, each
//! endnote (`\u{FEFF}`, the number marker, the separator, the text,
//! `\u{FEFF}`). The reference side is the body's: the engine's reference
//! marker in a run of its own and an [`EndnoteReference`] on the paragraph
//! (`body`).
//!
//! `paged-mutate` is not linked (it adds 4.77 MiB to the doc wasm). The
//! options (title, separator) are the engine's defaults, as in the old pour,
//! which set the document's note options after the pour.

use paged_model::{CharacterRun, EndnoteRangeDef, ENDNOTE_NUMBER_MARKER};
use paged_scene::Document;

use crate::native::empty_story;
use crate::{Margins, SkeletonPage};

/// The byte-order mark InDesign opens and closes an endnote's range with.
const BOM: char = '\u{FEFF}';

/// The gap the engine leaves between the pasteboard spreads, pt.
const SPREAD_STACK_GAP_PT: f32 = 72.0;

/// One endnote of the body: its id and its range's, and its text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeEndnote {
    pub id: String,
    pub range_id: String,
    pub text: String,
}

/// Id of the endnote story's spread, page, text frame and story.
pub const ENDNOTE_SPREAD: &str = "docx_en_sp";
pub const ENDNOTE_PAGE: &str = "docx_en_pg";
pub const ENDNOTE_FRAME: &str = "docx_en_f";
pub const ENDNOTE_STORY: &str = "docx_en_s";

/// Add the endnote story `notes` fill to `document`, as the engine makes it
/// when the first endnote is inserted (`CreateEndnoteStory`), then one range
/// per note in `notes` (already in reference order). Nothing for no notes.
pub fn add_endnote_story(document: &mut Document, notes: &[NativeEndnote]) -> Result<(), String> {
    if notes.is_empty() {
        return Ok(());
    }
    if document.stories.iter().any(|s| s.story.is_endnote_story) {
        return Err("the document has an endnote story".into());
    }
    // The page goes after the last one, on its master.
    let (host, last) = document
        .spreads
        .iter()
        .enumerate()
        .flat_map(|(i, p)| p.spread.pages.iter().map(move |pg| (i, pg)))
        .next_back()
        .map(|(i, pg)| (i, pg.clone()))
        .ok_or("the document has no page")?;
    // Stacked below everything on the pasteboard.
    let mut max_bottom: f32 = 0.0;
    for parsed in &document.spreads {
        let sty = parsed.spread.item_transform.map(|m| m[5]).unwrap_or(0.0);
        for p in &parsed.spread.pages {
            let pty = p.item_transform.map(|m| m[5]).unwrap_or(0.0);
            max_bottom = max_bottom.max(sty + pty + p.bounds.bottom);
        }
    }
    // The page takes the margins of the page it follows (the masters of a
    // Word document declare none).
    let margins = last
        .self_id
        .as_deref()
        .and_then(|id| document.spreads[host].spread.page_margins.get(id))
        .cloned()
        .unwrap_or_default();
    // The spread is the skeleton's own (`native::spread`, a page, its margin
    // box and a text frame), set back to what the engine's page and frame
    // operations make: no transforms, no fill, outline, object style or
    // first-baseline rule, one column.
    let width = last.bounds.right - last.bounds.left;
    let height = last.bounds.bottom - last.bounds.top;
    let mut parsed = crate::native::spread(&SkeletonPage {
        story_id: ENDNOTE_STORY.into(),
        page_id: ENDNOTE_PAGE.into(),
        spread_id: ENDNOTE_SPREAD.into(),
        frame_id: ENDNOTE_FRAME.into(),
        width,
        height,
        margins: Margins {
            top: margins.top,
            bottom: margins.bottom,
            left: margins.left,
            right: margins.right,
            column_count: 1,
            column_gutter: 0.0,
        },
        master: last.applied_master.clone(),
        page_number_start: None,
        page_number_format: None,
    });
    let spread = &mut parsed.spread;
    spread.item_transform = Some([1.0, 0.0, 0.0, 1.0, 0.0, max_bottom + SPREAD_STACK_GAP_PT]);
    spread.page_margins.insert(ENDNOTE_PAGE.into(), margins);
    spread.endnote_frames.push(ENDNOTE_FRAME.into());
    let page = &mut spread.pages[0];
    page.item_transform = None;
    page.master_page_transform = None;
    page.show_master_items = None;
    let frame = &mut spread.text_frames[0];
    frame.item_transform = None;
    frame.fill_color = None;
    frame.stroke_color = None;
    frame.stroke_weight = None;
    frame.next_text_frame = None;
    frame.first_baseline_offset = None;
    frame.inset_spacing = None;
    frame.applied_object_style = None;
    frame.anchors.clear();
    document.spreads.insert(host + 1, parsed);
    // The story: the title, then the ranges, each after a break from the one
    // before (`InsertEndnote` appends to the title's paragraph). The note
    // options are the engine's defaults here: the skeleton sets none, and the
    // pour sets the document's after it (title "Endnotes", a tab for the
    // separator, no title style).
    let mut text = String::from("Endnotes");
    let mut ranges = Vec::with_capacity(notes.len());
    for n in notes {
        text.push('\n');
        text.push(BOM);
        text.push(ENDNOTE_NUMBER_MARKER);
        text.push('\t');
        text.push_str(&n.text);
        text.push(BOM);
        ranges.push(EndnoteRangeDef {
            self_id: n.range_id.clone(),
            source: Some(n.id.clone()),
        });
    }
    let mut story = empty_story(String::new(), ENDNOTE_STORY.into());
    story.story.is_endnote_story = true;
    let title = &mut story.story.paragraphs[0];
    title.paragraph_style = None;
    title.runs.push(CharacterRun::default());
    title.runs[0].text = text;
    title.endnote_ranges = ranges;
    document.stories.push(story);
    Ok(())
}
