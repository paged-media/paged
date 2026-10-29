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

//! The skeleton as a native document (ADR 606): the engine's own model
//! types, packaged by core's one `.paged` writer
//! ([`paged_store::package::wrap_document`]). Nothing is written as IDML.
//!
//! The document is, field for field, the one the engine's IDML importer
//! made of the IDML package this crate wrote before (compared on every
//! fixture and on the docx corpus lane when the change was made): the
//! open, the pour and save-back see the same pages, frames, stories and
//! styles.

use std::collections::HashMap;

use paged_model::{
    Bounds, CharacterStyleDef, ColorEntry, ColorModel, ColorSpace, DesignMap, DocumentPreference,
    FirstBaselineOffset, FrameRef, Graphic, MarginPreference, ObjectStyleDef, Page, Paragraph,
    ParagraphStyleDef, PathAnchor, Spread, SpreadRef, Story, StoryRef, StyleSheet, SwatchEntry,
    TextFrame, XmlTag,
};
use paged_scene::{Document, ParsedSpread, ParsedStory};

use crate::SkeletonPage;

const IDENTITY: [f32; 6] = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];
const NO_PARA_STYLE: &str = "ParagraphStyle/$ID/[No paragraph style]";
const NO_CHAR_STYLE: &str = "CharacterStyle/$ID/[No character style]";
const NO_OBJECT_STYLE: &str = "ObjectStyle/$ID/[None]";
const NONE_SWATCH: &str = "Swatch/None";
/// The interchange DOM version the model records. The engine reads it
/// only to report it; it is kept so the document reads as before.
const DOM_VERSION: &str = "20.0";

/// The part path the model keeps for story `k`'s spread and story (save
/// and IDML export name their parts by it).
fn spread_src(p: &SkeletonPage) -> String {
    format!("Spreads/Spread_{}.xml", p.spread_id)
}

fn story_src(p: &SkeletonPage) -> String {
    format!("Stories/Story_{}.xml", p.story_id)
}

/// The skeleton of `pages` as a native document named `name`.
pub fn skeleton_document(pages: &[SkeletonPage], name: &str) -> Document {
    // Word documents are single-sided: no facing pages, the first story's
    // page as the document's default size.
    let (w, h) = pages
        .first()
        .map(|p| (p.width, p.height))
        .unwrap_or((612.0, 792.0));
    let designmap = DesignMap {
        spreads: pages
            .iter()
            .map(|p| SpreadRef { src: spread_src(p) })
            .collect(),
        stories: pages
            .iter()
            .map(|p| StoryRef { src: story_src(p) })
            .collect(),
        dom_version: Some(DOM_VERSION.into()),
        document_name: Some(name.into()),
        document_preference: DocumentPreference {
            page_width: Some(w),
            page_height: Some(h),
            facing_pages: Some(false),
            ..DocumentPreference::default()
        },
        xml_tags: vec![XmlTag {
            self_id: "XMLTag/$ID/Root".into(),
            name: "Root".into(),
            color: None,
        }],
        ..DesignMap::default()
    };

    // The derived caches (`frame_for_story`, `text_frame_index`, the anchor
    // table) are not part of the model part; the engine rebuilds them when
    // it opens the package, so they stay empty here.
    Document {
        designmap,
        palette: palette(),
        spreads: pages.iter().map(spread).collect(),
        stories: pages
            .iter()
            .map(|p| ParsedStory {
                src: story_src(p),
                self_id: p.story_id.clone(),
                // One empty paragraph: the pour fills it.
                story: Story {
                    paragraphs: vec![Paragraph {
                        paragraph_style: Some(NO_PARA_STYLE.into()),
                        ..Paragraph::default()
                    }],
                    ..Story::default()
                },
            })
            .collect(),
        master_spreads: HashMap::new(),
        frame_for_story: HashMap::new(),
        text_frame_index: HashMap::new(),
        styles: styles(),
        anchors: Vec::new(),
        symbols: Vec::new(),
    }
}

/// The swatches every document has: Black, Paper and None.
fn palette() -> Graphic {
    let mut g = Graphic::default();
    for (id, name, value) in [
        ("Color/Black", "Black", [0.0, 0.0, 0.0, 100.0]),
        ("Color/Paper", "Paper", [0.0, 0.0, 0.0, 0.0]),
    ] {
        g.colors.insert(
            id.into(),
            ColorEntry {
                self_id: id.into(),
                name: Some(name.into()),
                space: ColorSpace::Cmyk,
                value: value.to_vec(),
                model: ColorModel::Process,
                alternate_space: None,
                alternate_value: Vec::new(),
                tint: None,
                alpha: None,
            },
        );
    }
    g.swatches.insert(
        NONE_SWATCH.into(),
        SwatchEntry {
            self_id: NONE_SWATCH.into(),
            name: Some("None".into()),
            color_ref: None,
        },
    );
    g
}

/// The root styles: no paragraph style, no character style, no object
/// style. The bundle adds the Word document's own on the wire.
fn styles() -> StyleSheet {
    let mut s = StyleSheet::default();
    s.paragraph_styles.insert(
        NO_PARA_STYLE.into(),
        ParagraphStyleDef {
            self_id: NO_PARA_STYLE.into(),
            name: Some("$ID/[No paragraph style]".into()),
            ..ParagraphStyleDef::default()
        },
    );
    s.character_styles.insert(
        NO_CHAR_STYLE.into(),
        CharacterStyleDef {
            self_id: NO_CHAR_STYLE.into(),
            name: Some("$ID/[No character style]".into()),
            ..CharacterStyleDef::default()
        },
    );
    s.object_styles.insert(
        NO_OBJECT_STYLE.into(),
        ObjectStyleDef {
            self_id: NO_OBJECT_STYLE.into(),
            name: Some("$ID/[None]".into()),
            ..ObjectStyleDef::default()
        },
    );
    s
}

/// Story `k`'s spread: its page with the section's size and margins, and
/// the text frame on the margin box. The frame's first baseline is
/// `LeadingOffset` with zero insets: Word fits a line only when its whole
/// line box fits, which is what that expresses.
fn spread(p: &SkeletonPage) -> ParsedSpread {
    let m = &p.margins;
    let mut page = Page::new(
        p.page_id.clone(),
        Bounds {
            top: 0.0,
            left: 0.0,
            bottom: p.height,
            right: p.width,
        },
    );
    page.applied_master = Some("n".into());
    page.item_transform = Some(IDENTITY);
    page.master_page_transform = Some(IDENTITY);
    page.show_master_items = Some(true);

    let [top, left, bottom, right] = p.frame_bounds();
    let corner = |x: f32, y: f32| PathAnchor {
        anchor: (x, y),
        left: (x, y),
        right: (x, y),
    };
    let mut frame = TextFrame::new(
        p.frame_id.clone(),
        Some(p.story_id.clone()),
        Bounds {
            top,
            left,
            bottom,
            right,
        },
    );
    frame.item_transform = Some(IDENTITY);
    frame.fill_color = Some(NONE_SWATCH.into());
    frame.stroke_color = Some(NONE_SWATCH.into());
    frame.stroke_weight = Some(0.0);
    frame.next_text_frame = Some("n".into());
    frame.first_baseline_offset = Some(FirstBaselineOffset::LeadingOffset);
    frame.inset_spacing = Some([0.0; 4]);
    frame.applied_object_style = Some(NO_OBJECT_STYLE.into());
    frame.anchors = vec![
        corner(left, top),
        corner(left, bottom),
        corner(right, bottom),
        corner(right, top),
    ];
    if m.column_count > 1 {
        frame.column_count = Some(m.column_count);
        frame.column_gutter = Some(m.column_gutter);
    }

    let mut spread = Spread {
        self_id: Some(p.spread_id.clone()),
        item_transform: Some(IDENTITY),
        ..Spread::default()
    };
    spread.page_margins.insert(
        p.page_id.clone(),
        MarginPreference {
            top: m.top,
            bottom: m.bottom,
            left: m.left,
            right: m.right,
            column_count: m.column_count,
            column_gutter: m.column_gutter,
        },
    );
    spread.pages.push(page);
    spread.text_frames.push(frame);
    spread.frames_in_order.push(FrameRef::TextFrame(0));
    ParsedSpread {
        src: spread_src(p),
        spread,
    }
}
