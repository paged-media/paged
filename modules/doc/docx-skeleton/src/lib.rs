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

//! paged.doc — the page skeleton for DOCX standalone open (ADR 029), built
//! as a **native document** (ADR 606).
//!
//! The skeleton is the engine's own model (`paged_scene::Document`, built in
//! [`native`]) packaged by core's one `.paged` writer
//! (`paged_store::package::wrap_document`). The bundle opens the bytes
//! through the SDK door `host.nativeDocument.open`, which reads the model
//! part with no IDML parse.
//!
//! A Word document is lowered as ONE STORY PER SECTION that starts a page:
//! each such section gets a page of its size with its margins, its margin
//! box as the text frame, and a story with
//! one empty paragraph. The frame's first baseline is `LeadingOffset` with
//! zero insets: Word fits a line only when its whole line box fits, which is
//! what that expresses.
//!
//! The GROW RULE (the story adding pages while it oversets, after its last
//! frame, so section 1's pages land before section 2's, where Word puts
//! them) is the bundle's: it sets it on the wire after opening
//! (`setFlowGrowRule` with `copyFrameOptions`, protocol 64), then pours each
//! section's paragraphs into its story.
//!
//! A `continuous` / `nextColumn` section that Word continues on the same page
//! JOINS the story before it (no page of its own) when the native model can
//! say what Word does there; `docx_lower::sections` decides, measured against
//! Word (`docx-conformance/fixtures/continuous.word.json`), and the lowering
//! assigns each section the same story index, so the pour and save-back stay
//! aligned with this skeleton.

#[doc(hidden)]
pub mod idml;
pub mod native;

use docx_core::{DocxDocument, Section};
use docx_lower::sections::{LowerOptions, StoryColumns};

/// The skeleton: `.paged` bytes for `host.nativeDocument.open`, and the
/// story ids, in story order (the pour's targets; sections that join a
/// story share its id, see [`story_sections`]).
#[derive(Debug, Clone)]
pub struct Skeleton {
    pub paged: Vec<u8>,
    pub section_stories: Vec<String>,
}

/// Id of native story `k` (0-based).
pub fn section_story_id(k: usize) -> String {
    format!("docx_s{k}")
}

/// Id of the text frame on story `k`'s authored page (the bundle binds the
/// Word source to story 0's frame).
pub fn section_frame_id(k: usize) -> String {
    format!("docx_f{k}")
}

/// Id of story `k`'s authored page.
pub fn section_page_id(k: usize) -> String {
    format!("docx_p{k}")
}

/// Id of the spread holding story `k`'s authored page.
pub fn section_spread_id(k: usize) -> String {
    format!("docx_sp{k}")
}

fn twips(v: i32) -> f32 {
    v as f32 / 20.0
}

/// A page's margins and column grid, in points.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Margins {
    pub top: f32,
    pub bottom: f32,
    pub left: f32,
    pub right: f32,
    pub column_count: u32,
    pub column_gutter: f32,
}

/// One skeleton story's authored page: its size, margins, and the frame on
/// its margin box. Points, page coordinates (origin top-left).
#[derive(Debug, Clone, PartialEq)]
pub struct SkeletonPage {
    pub story_id: String,
    pub page_id: String,
    pub spread_id: String,
    pub frame_id: String,
    pub width: f32,
    pub height: f32,
    pub margins: Margins,
}

impl SkeletonPage {
    /// The frame's bounds, `[top, left, bottom, right]`: the margin box.
    pub fn frame_bounds(&self) -> [f32; 4] {
        let m = &self.margins;
        [m.top, m.left, self.height - m.bottom, self.width - m.right]
    }
}

/// The first section of every native story, in story order, with the
/// story frame's columns: a section that joins the story before it
/// (`docx_lower::sections`) gets no page of its own, and a story whose
/// sections change the columns mid-page gets the frame columns the lowering
/// chose for it (span or split columns, ADR 029).
pub fn story_sections(doc: &DocxDocument, options: LowerOptions) -> Vec<(&Section, StoryColumns)> {
    let placements =
        docx_lower::sections::place_sections_with(&doc.sections, options, &mut Vec::new());
    let mut out = Vec::new();
    for (sec, p) in doc.sections.iter().zip(&placements) {
        if p.story == out.len() {
            out.push((sec, p.frame));
        }
    }
    out
}

/// The story ids of the skeleton, in story order (the pour's targets).
pub fn story_ids(doc: &DocxDocument) -> Vec<String> {
    story_ids_with(doc, LowerOptions::default())
}

/// [`story_ids`] for an engine that can lay out what `options` says.
pub fn story_ids_with(doc: &DocxDocument, options: LowerOptions) -> Vec<String> {
    (0..story_sections(doc, options).len())
        .map(section_story_id)
        .collect()
}

/// The skeleton's pages, one per native story, in story order.
pub fn skeleton_pages(doc: &DocxDocument) -> Vec<SkeletonPage> {
    skeleton_pages_with(doc, LowerOptions::default())
}

/// [`skeleton_pages`] for an engine that can lay out what `options` says.
pub fn skeleton_pages_with(doc: &DocxDocument, options: LowerOptions) -> Vec<SkeletonPage> {
    story_sections(doc, options)
        .into_iter()
        .enumerate()
        .map(|(k, (sec, frame))| SkeletonPage {
            story_id: section_story_id(k),
            page_id: section_page_id(k),
            spread_id: section_spread_id(k),
            frame_id: section_frame_id(k),
            width: twips(sec.page_width),
            height: twips(sec.page_height),
            margins: Margins {
                top: twips(sec.margin_top),
                bottom: twips(sec.margin_bottom),
                left: twips(sec.margin_left),
                right: twips(sec.margin_right),
                column_count: frame.count.max(1),
                column_gutter: frame.gutter_pt,
            },
        })
        .collect()
}

/// The skeleton packaged as a `.paged` document, named `name`.
pub fn skeleton(doc: &DocxDocument, name: &str) -> Result<Skeleton, String> {
    skeleton_with(doc, name, LowerOptions::default())
}

/// [`skeleton`] for an engine that can lay out what `options` says.
pub fn skeleton_with(
    doc: &DocxDocument,
    name: &str,
    options: LowerOptions,
) -> Result<Skeleton, String> {
    let pages = skeleton_pages_with(doc, options);
    let document = native::skeleton_document(&pages, name);
    // The container's fallback page (read only if the model part ever
    // fails to decode) takes the first story's page size.
    let (w, h) = pages
        .first()
        .map(|p| (p.width, p.height))
        .unwrap_or((612.0, 792.0));
    let paged = paged_store::package::wrap_document(&document, name, w, h)
        .map_err(|e| format!("package the skeleton: {e}"))?;
    Ok(Skeleton {
        paged,
        section_stories: pages.into_iter().map(|p| p.story_id).collect(),
    })
}
