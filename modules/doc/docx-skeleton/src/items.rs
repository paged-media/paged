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

//! Doc ADR 614 — the page items a Word document's floats and text boxes
//! become (`docx_lower::objects::plan_page_items`): a graphic frame with
//! the picture, or a text frame with an empty story the bundle pours, on a
//! story's authored page or on a master, with Word's text wrap and the
//! shape's fill and outline.

use docx_lower::ir::{LoweredItemHost, LoweredItemKind, LoweredPageItem, LoweredWrap};
use paged_model::{
    Bounds, ColorEntry, ColorModel, ColorSpace, ContourOptionType, FrameRef, Rectangle, Spread,
    StoryRef, TextWrap, TextWrapMode, TextWrapSide,
};
use paged_scene::Document;

use crate::native::{empty_story, text_frame};

const IDENTITY: [f32; 6] = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];
const NONE_SWATCH: &str = "Swatch/None";

/// The part path the model keeps for a page item's story.
fn item_story_src(story_id: &str) -> String {
    format!("Stories/Story_{story_id}.xml")
}

/// The engine's text wrap for a page item.
fn text_wrap(w: &LoweredWrap) -> TextWrap {
    TextWrap {
        mode: TextWrapMode::from_idml(&w.mode),
        offsets: w.offsets_pt,
        invert: None,
        contour_type: w.contour.as_deref().map(ContourOptionType::from_idml),
        include_inside_edges: None,
        side: w.side.as_deref().and_then(TextWrapSide::from_idml),
        apply_to_master_page_only: None,
    }
}

/// The swatch the skeleton gives a page item's colour `#RRGGBB` (its own
/// id, apart from the swatches the pour creates).
fn item_swatch(doc: &mut Document, hex: &str) -> String {
    let hex = hex.trim_start_matches('#').to_ascii_uppercase();
    let id = format!("Color/docx-o-{hex}");
    if !doc.palette.colors.contains_key(&id) {
        let channel = |i: usize| {
            u8::from_str_radix(hex.get(i..i + 2).unwrap_or("00"), 16).unwrap_or(0) as f32
        };
        doc.palette.colors.insert(
            id.clone(),
            ColorEntry {
                self_id: id.clone(),
                name: Some(format!("Word {hex}")),
                space: ColorSpace::Rgb,
                value: vec![channel(0), channel(2), channel(4)],
                model: ColorModel::Process,
                alternate_space: None,
                alternate_value: Vec::new(),
                tint: None,
                alpha: None,
            },
        );
    }
    id
}

/// The spread a page item stands on: a story's authored page's, or a
/// master's.
fn host_spread<'a>(doc: &'a mut Document, host: &LoweredItemHost) -> Option<&'a mut Spread> {
    match host {
        LoweredItemHost::Page { page_id } => {
            doc.spreads.iter_mut().map(|s| &mut s.spread).find(|s| {
                s.pages
                    .iter()
                    .any(|p| p.self_id.as_deref() == Some(page_id.as_str()))
            })
        }
        LoweredItemHost::Master { master_id } => {
            doc.master_spreads.get_mut(master_id).map(|m| &mut m.spread)
        }
    }
}

/// Add `items` to the skeleton `doc`.
pub fn add_page_items(doc: &mut Document, items: &[LoweredPageItem]) {
    for item in items {
        let [top, left, bottom, right] = item.bounds;
        let bounds = Bounds {
            top,
            left,
            bottom,
            right,
        };
        let fill = item
            .fx
            .as_ref()
            .and_then(|fx| fx.fill.clone())
            .map(|c| item_swatch(doc, &c));
        let stroke = item
            .fx
            .as_ref()
            .and_then(|fx| fx.stroke.clone())
            .map(|s| (item_swatch(doc, &s.color), s.weight));
        let wrap = item.wrap.as_ref().map(text_wrap);
        let made = match &item.item {
            LoweredItemKind::Picture { uri } => {
                let mut r = Rectangle::new(item.id.clone(), bounds);
                r.item_transform = Some(IDENTITY);
                r.fill_color = Some(fill.unwrap_or_else(|| NONE_SWATCH.into()));
                match &stroke {
                    Some((color, weight)) => {
                        r.stroke_color = Some(color.clone());
                        r.stroke_weight = Some(*weight);
                    }
                    None => {
                        r.stroke_color = Some(NONE_SWATCH.into());
                        r.stroke_weight = Some(0.0);
                    }
                }
                r.image_link = Some(uri.clone());
                r.has_image_element = true;
                r.text_wrap = wrap;
                Made::Rect(Box::new(r))
            }
            LoweredItemKind::TextBox {
                story_id,
                insets_pt,
                ..
            } => {
                let mut f = text_frame(&item.id, story_id, item.bounds);
                f.next_text_frame = None;
                f.inset_spacing = Some(*insets_pt);
                if let Some(fill) = fill {
                    f.fill_color = Some(fill);
                }
                if let Some((color, weight)) = &stroke {
                    f.stroke_color = Some(color.clone());
                    f.stroke_weight = Some(*weight);
                }
                f.text_wrap = wrap;
                doc.designmap.stories.push(StoryRef {
                    src: item_story_src(story_id),
                });
                doc.stories
                    .push(empty_story(item_story_src(story_id), story_id.clone()));
                Made::Text(Box::new(f))
            }
        };
        let Some(spread) = host_spread(doc, &item.host) else {
            continue;
        };
        let at = match made {
            Made::Rect(r) => {
                spread.rectangles.push(*r);
                FrameRef::Rectangle(spread.rectangles.len() - 1)
            }
            Made::Text(f) => {
                spread.text_frames.push(*f);
                FrameRef::TextFrame(spread.text_frames.len() - 1)
            }
        };
        // Behind the text: under the page's text frame, which a story's
        // authored page lists first.
        if item.behind {
            spread.frames_in_order.insert(0, at);
        } else {
            spread.frames_in_order.push(at);
        }
    }
}

enum Made {
    Rect(Box<Rectangle>),
    Text(Box<paged_model::TextFrame>),
}
