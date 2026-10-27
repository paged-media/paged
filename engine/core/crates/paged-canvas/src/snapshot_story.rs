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

//! Engine ADR 10XX — a snapshot can draw a story the document does not
//! hold ([`SnapshotStory`]).
//!
//! The story is laid out by the same pipeline that lays out the page:
//! it is inserted, with a text frame at its bounds, into a COPY of the
//! scene, through the operation layer's own insert (so the frame and its
//! story are exactly what an `insertTextFrame` makes), and the page is
//! then built with nothing else visible. The document, its history and
//! its id counters are never touched.

use paged_mutate::{NodeId, NodeSpec, Operation};
use paged_renderer::{Document, PageId};

use crate::channel::LoadError;
use crate::model::CanvasModel;
use crate::snapshot::{SnapshotParagraph, SnapshotRun, SnapshotStory};

/// The ids the copy's frame, story and colours take. Never written to
/// the document; the prefix keeps them out of the way of minted ids.
const FRAME_ID: &str = "u_snapshot_story_frame";
const STORY_ID: &str = "Story/u_snapshot_story";

impl CanvasModel {
    /// The page `page_id` drawn with nothing on it but `story`, laid out
    /// in a frame at its bounds (page pt) in a copy of the scene.
    pub fn build_page_with_story(
        &self,
        page_id: &PageId,
        story: &SnapshotStory,
    ) -> Result<paged_renderer::BuiltPage, LoadError> {
        let (spread_id, (ox, oy), idx) = self
            .page_insert_context(page_id)
            .ok_or_else(|| LoadError::Build(format!("no page {page_id}")))?;
        let mut scene = self.scene.clone();
        insert_story(&mut scene, &spread_id, idx, (ox, oy), story)?;
        let only = [crate::element_selection::ElementId::TextFrame(
            FRAME_ID.to_string(),
        )];
        self.build_page_filtered_in(scene, page_id, &[], &only)
    }
}

/// Insert `story` and its frame into `scene` on spread `spread_idx`
/// (page origin `(ox, oy)` in spread coordinates).
fn insert_story(
    scene: &mut Document,
    spread_id: &str,
    spread_idx: usize,
    (ox, oy): (f32, f32),
    story: &SnapshotStory,
) -> Result<(), LoadError> {
    let [t, l, b, r] = story.bounds;
    let position = scene.spreads[spread_idx].spread.text_frames.len();
    paged_mutate::apply(
        scene,
        &Operation::InsertNode {
            parent: NodeId::Spread(spread_id.to_string()),
            position,
            node: NodeSpec::TextFrame {
                self_id: FRAME_ID.to_string(),
                bounds: [t + oy, l + ox, b + oy, r + ox],
                fill_color: None,
                stroke_color: None,
                stroke_weight: None,
                item_transform: None,
                parent_story: Some(STORY_ID.to_string()),
            },
            z_slot: None,
        },
    )
    .map_err(|e| LoadError::Build(format!("snapshot story frame: {e}")))?;

    // The frame: no inset, no wrap from the page's other items (they are
    // not drawn, and a type layer is not part of the page's layout).
    if let Some(frame) = scene.spreads[spread_idx]
        .spread
        .text_frames
        .iter_mut()
        .find(|f| f.self_id.as_deref() == Some(FRAME_ID))
    {
        frame.inset_spacing = Some([0.0; 4]);
        frame.ignore_wrap = Some(true);
        frame.text_wrap = None;
        if let Some(fb) = story.first_baseline.filter(|v| v.is_finite() && *v >= 0.0) {
            frame.first_baseline_offset = Some(paged_model::FirstBaselineOffset::FixedHeight);
            frame.minimum_first_baseline_offset = Some(fb);
        }
        frame.vertical_justification = story
            .vertical_justification
            .as_deref()
            .and_then(vertical_justification);
    }

    let mut paragraphs = Vec::with_capacity(story.paragraphs.len());
    for p in &story.paragraphs {
        paragraphs.push(paragraph(&mut scene.palette, p));
    }
    if paragraphs.is_empty() {
        paragraphs.push(paged_model::Paragraph {
            runs: vec![paged_model::CharacterRun::default()],
            ..Default::default()
        });
    }
    let parsed = scene
        .stories
        .iter_mut()
        .find(|s| s.self_id == STORY_ID)
        .ok_or_else(|| LoadError::Build("snapshot story was not minted".into()))?;
    parsed.story.paragraphs = paragraphs;
    scene.rebuild_indexes();
    Ok(())
}

fn vertical_justification(s: &str) -> Option<paged_model::VerticalJustification> {
    use paged_model::VerticalJustification as V;
    Some(match s {
        "top" => V::Top,
        "center" => V::Center,
        "bottom" => V::Bottom,
        "justify" => V::Justify,
        _ => return None,
    })
}

fn paragraph(palette: &mut paged_model::Graphic, p: &SnapshotParagraph) -> paged_model::Paragraph {
    let mut runs: Vec<paged_model::CharacterRun> = p.runs.iter().map(|r| run(palette, r)).collect();
    if runs.is_empty() {
        runs.push(paged_model::CharacterRun::default());
    }
    paged_model::Paragraph {
        justification: p
            .justification
            .as_deref()
            .and_then(paged_model::Justification::from_idml),
        first_line_indent: p.first_line_indent,
        left_indent: p.left_indent,
        right_indent: p.right_indent,
        space_before: p.space_before,
        space_after: p.space_after,
        hyphenation: p.hyphenation,
        composer: match p.composer.as_deref() {
            Some("paragraph") => Some(paged_model::Composer::Paragraph),
            Some("single") => Some(paged_model::Composer::SingleLine),
            _ => None,
        },
        runs,
        ..Default::default()
    }
}

fn run(palette: &mut paged_model::Graphic, r: &SnapshotRun) -> paged_model::CharacterRun {
    // A forced line break is U+2028 in a run (IDML's `<Br/>` inside a
    // paragraph is the paragraph end; the line separator is what the
    // text stack breaks a line on without ending the paragraph).
    let text = r.text.replace(['\n', '\r'], "\u{2028}");
    paged_model::CharacterRun {
        font: r.font.clone(),
        font_style: r.font_style.clone(),
        point_size: r.point_size,
        leading: r.leading,
        fill_color: r.fill_rgb.map(|rgb| rgb_colour(palette, rgb)),
        tracking: r.tracking,
        baseline_shift: r.baseline_shift,
        horizontal_scale: r.horizontal_scale,
        vertical_scale: r.vertical_scale,
        skew: r.skew,
        underline: r.underline,
        strikethru: r.strikethru,
        ligatures_on: r.ligatures,
        capitalization: r.capitalization.clone(),
        position: r.position.clone(),
        text,
        ..Default::default()
    }
}

/// The id of an RGB colour in `palette`, added when it is not there yet.
fn rgb_colour(palette: &mut paged_model::Graphic, [r, g, b]: [u8; 3]) -> String {
    let id = format!("Color/u_snapshot_rgb_{r:02x}{g:02x}{b:02x}");
    palette
        .colors
        .entry(id.clone())
        .or_insert_with(|| paged_model::ColorEntry {
            self_id: id.clone(),
            name: None,
            space: paged_model::ColorSpace::Rgb,
            value: vec![f32::from(r), f32::from(g), f32::from(b)],
            model: paged_model::ColorModel::Process,
            alternate_space: None,
            alternate_value: Vec::new(),
            tint: None,
            alpha: None,
        });
    id
}
