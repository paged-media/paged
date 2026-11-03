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

use paged_model::{
    Bounds, CharacterRun, EndnoteRangeDef, FrameRef, Page, Paragraph, Spread, Story, TextFrame,
    ENDNOTE_NUMBER_MARKER,
};
use paged_scene::{Document, ParsedSpread, ParsedStory};

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
    let mut page = Page::new(ENDNOTE_PAGE, last.bounds);
    page.applied_master = last.applied_master.clone();
    let bounds = page.bounds;
    let mut spread = Spread {
        self_id: Some(ENDNOTE_SPREAD.into()),
        item_transform: Some([1.0, 0.0, 0.0, 1.0, 0.0, max_bottom + SPREAD_STACK_GAP_PT]),
        pages: vec![page],
        ..Spread::default()
    };
    spread
        .page_margins
        .insert(ENDNOTE_PAGE.into(), margins.clone());
    // The frame: the new page's margin box, in spread coordinates.
    let mut frame = TextFrame::new(
        ENDNOTE_FRAME,
        Some(ENDNOTE_STORY.into()),
        Bounds {
            top: bounds.top + margins.top,
            left: bounds.left + margins.left,
            bottom: bounds.bottom - margins.bottom,
            right: bounds.right - margins.right,
        },
    );
    frame.item_transform = None;
    spread.text_frames.push(frame);
    spread.frames_in_order.push(FrameRef::TextFrame(0));
    spread.endnote_frames.push(ENDNOTE_FRAME.into());
    document.spreads.insert(
        host + 1,
        ParsedSpread {
            src: format!("Spreads/Spread_{ENDNOTE_SPREAD}.xml"),
            spread,
        },
    );
    // The story: the title, then the ranges, each after a break from the one
    // before (`InsertEndnote` appends to the title's paragraph).
    let options = document
        .designmap
        .endnote_options
        .clone()
        .unwrap_or_default();
    let separator = options
        .separator_text
        .clone()
        .unwrap_or_else(|| "\t".to_string());
    let mut text = options
        .title
        .clone()
        .unwrap_or_else(|| "Endnotes".to_string());
    let mut ranges = Vec::with_capacity(notes.len());
    for n in notes {
        text.push('\n');
        text.push(BOM);
        text.push(ENDNOTE_NUMBER_MARKER);
        text.push_str(&separator);
        text.push_str(&n.text);
        text.push(BOM);
        ranges.push(EndnoteRangeDef {
            self_id: n.range_id.clone(),
            source: Some(n.id.clone()),
        });
    }
    document.stories.push(ParsedStory {
        // Minted post-parse: the writer emits a fresh part for it.
        src: String::new(),
        self_id: ENDNOTE_STORY.into(),
        story: Story {
            paragraphs: vec![Paragraph {
                paragraph_style: options.title_style.clone(),
                runs: vec![CharacterRun {
                    text,
                    ..CharacterRun::default()
                }],
                endnote_ranges: ranges,
                ..Paragraph::default()
            }],
            is_endnote_story: true,
            ..Story::default()
        },
    });
    Ok(())
}
