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

use docx_lower::ir::{LoweredMaster, LoweredMasterFrame};
use paged_model::{
    Bounds, CharacterStyleDef, ColorEntry, ColorModel, ColorSpace, DesignMap, DocumentPreference,
    FirstBaselineOffset, FrameRef, Graphic, MarginPreference, NumberingStyle, ObjectStyleDef, Page,
    Paragraph, ParagraphStyleDef, PathAnchor, Section, Spread, SpreadRef, Story, StoryRef,
    StyleSheet, SwatchEntry, TextFrame, VerticalJustification, XmlTag,
};
use paged_scene::{Document, ParsedMasterSpread, ParsedSpread, ParsedStory};

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
    skeleton_document_with(pages, &[], name)
}

fn master_src(m: &LoweredMaster) -> String {
    format!("MasterSpreads/MasterSpread_{}.xml", m.id)
}

fn master_story_src(f: &LoweredMasterFrame) -> String {
    format!("Stories/Story_{}.xml", f.story_id)
}

/// One empty story: the pour fills it.
pub(crate) fn empty_story(src: String, self_id: String) -> ParsedStory {
    ParsedStory {
        src,
        self_id,
        story: Story {
            paragraphs: vec![Paragraph {
                paragraph_style: Some(NO_PARA_STYLE.into()),
                ..Paragraph::default()
            }],
            ..Story::default()
        },
    }
}

/// A text frame on `[top, left, bottom, right]` holding `story`, as the
/// skeleton's frames are: no fill or stroke, `LeadingOffset` first
/// baseline, zero insets.
pub(crate) fn text_frame(id: &str, story: &str, [top, left, bottom, right]: [f32; 4]) -> TextFrame {
    let corner = |x: f32, y: f32| PathAnchor {
        anchor: (x, y),
        left: (x, y),
        right: (x, y),
    };
    let mut frame = TextFrame::new(
        id.to_string(),
        Some(story.to_string()),
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
    frame
}

/// A section master (doc ADR 611): one page of the section's size with
/// its header frame and footer frame.
fn master_spread(m: &LoweredMaster) -> ParsedMasterSpread {
    let mut page = Page::new(
        format!("{}_pg", m.id),
        Bounds {
            top: 0.0,
            left: 0.0,
            bottom: m.page_height_pt,
            right: m.page_width_pt,
        },
    );
    page.item_transform = Some(IDENTITY);
    let mut spread = Spread {
        self_id: Some(m.id.clone()),
        item_transform: Some(IDENTITY),
        ..Spread::default()
    };
    spread.pages.push(page);
    for f in [&m.header, &m.footer].into_iter().flatten() {
        let mut frame = text_frame(&f.frame_id, &f.story_id, f.bounds);
        if f.bottom_aligned {
            frame.vertical_justification = Some(VerticalJustification::Bottom);
        }
        spread
            .frames_in_order
            .push(FrameRef::TextFrame(spread.text_frames.len()));
        spread.text_frames.push(frame);
    }
    ParsedMasterSpread {
        src: master_src(m),
        self_id: m.id.clone(),
        spread,
        name: Some(m.name.clone()),
    }
}

/// Word's `w:pgNumType/@w:fmt` as the section's numbering style.
fn numbering_style(fmt: Option<&str>) -> NumberingStyle {
    match fmt {
        Some("lowerRoman") => NumberingStyle::LowerRoman,
        Some("upperRoman") => NumberingStyle::UpperRoman,
        Some("lowerLetter") => NumberingStyle::LowerAlpha,
        Some("upperLetter") => NumberingStyle::UpperAlpha,
        Some("decimalZero") => NumberingStyle::SingleLeadingZeros,
        _ => NumberingStyle::Arabic,
    }
}

/// The page-numbering sections (doc ADR 611): one at each story page
/// whose Word section restarts its numbers or numbers in another format,
/// and one at the first page when any other exists.
fn sections(pages: &[SkeletonPage]) -> Vec<Section> {
    let numbered =
        |p: &SkeletonPage| p.page_number_start.is_some() || p.page_number_format.is_some();
    if !pages.iter().any(numbered) {
        return Vec::new();
    }
    pages
        .iter()
        .enumerate()
        .filter(|(k, p)| *k == 0 || numbered(p))
        .map(|(k, p)| Section {
            self_id: format!("docx_sec{k}"),
            page_start: Some(p.page_id.clone()),
            continue_numbering: k > 0 && p.page_number_start.is_none(),
            start_at: Some(p.page_number_start.map_or(1, |n| n.max(1) as u32)),
            numbering_style: numbering_style(p.page_number_format.as_deref()),
            section_prefix: None,
            marker: None,
            include_prefix: false,
        })
        .collect()
}

/// [`skeleton_document`] with the section masters (doc ADR 611): a master
/// spread each, their header and footer stories, the pages showing them,
/// and the page-numbering sections.
pub fn skeleton_document_with(
    pages: &[SkeletonPage],
    masters: &[LoweredMaster],
    name: &str,
) -> Document {
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
            .chain(
                masters
                    .iter()
                    .flat_map(|m| [&m.header, &m.footer])
                    .flatten()
                    .map(|f| StoryRef {
                        src: master_story_src(f),
                    }),
            )
            .collect(),
        master_spreads: masters.iter().map(master_src).collect(),
        sections: sections(pages),
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
            .map(|p| empty_story(story_src(p), p.story_id.clone()))
            .chain(
                masters
                    .iter()
                    .flat_map(|m| [&m.header, &m.footer])
                    .flatten()
                    .map(|f| empty_story(master_story_src(f), f.story_id.clone())),
            )
            .collect(),
        master_spreads: masters
            .iter()
            .map(|m| (m.id.clone(), master_spread(m)))
            .collect::<HashMap<_, _>>(),
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
    page.applied_master = Some(p.master.clone().unwrap_or_else(|| "n".into()));
    page.item_transform = Some(IDENTITY);
    page.master_page_transform = Some(IDENTITY);
    page.show_master_items = Some(true);

    let mut frame = text_frame(&p.frame_id, &p.story_id, p.frame_bounds());
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
