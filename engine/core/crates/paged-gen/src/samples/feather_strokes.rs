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

//! `feather-strokes.idml` — what an object feather fades besides the
//! fill: the frame's stroke and a text frame's text (ADR 204).
//!
//! InDesign feathers the whole object. On a stroked frame the feather's
//! band is measured from the stroke's OUTER edge, so an 8 pt centred
//! stroke starts fading 4 pt outside the path and an outside-aligned
//! one 8 pt outside it; an inside-aligned stroke lies within the path
//! and fades with the fill. A text frame's feather fades its text with
//! its box.
//!
//! Every item is a 120 × 80 pt frame over a yellow band that runs under
//! the lower half of its row, so what the feather removes shows the band
//! (and the paper) through. Cases, numbered on the page:
//!
//! * row 1 — basic feather (10 pt) on a magenta rectangle with an 8 pt
//!   black stroke: centred 1, outside 2, inside 3;
//! * row 2 — the same feather on a stroked oval 4, a directional feather
//!   on a stroked rectangle 5, a linear gradient feather on a stroked
//!   rectangle 6;
//! * row 3 — text frames with a basic feather: filled 7, text only 8,
//!   filled and stroked 9.

use crate::builders::{
    designmap::{write_designmap, DesignMap},
    master::{write_master, Master},
    page_item::{Oval, PageItem, Rect, TextFramePref},
    resources::{
        container_xml, fonts_xml, graphic_xml_with_extras, preferences_xml, styles_xml, ExtraColor,
    },
    spread::{write_spread, Spread},
    story::{write_story, Paragraph, Run, Story},
    xml_folder::{backing_story_xml, mapping_xml, tags_xml},
};
use crate::geometry::translate;
use crate::ids::self_id;
use crate::package::Sample;

const SAMPLE: &str = "feather-strokes";
const PAGE_W_PT: f32 = 595.276; // A4 portrait
const PAGE_H_PT: f32 = 841.890;
const FONT: &str = "Inter";
const COLS: [f32; 3] = [60.0, 238.0, 416.0];
const ROWS: [f32; 3] = [110.0, 330.0, 550.0];
pub const W: f32 = 120.0;
pub const H: f32 = 80.0;
/// The stroke every stroked case carries, in pt.
pub const STROKE: f32 = 8.0;

/// What a case is drawn as.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Shape {
    Rect,
    Oval,
    /// A text frame holding one line of large black text.
    Text,
}

#[derive(Clone, Debug)]
pub struct Case {
    pub n: u32,
    pub col: usize,
    pub row: usize,
    pub shape: Shape,
    pub label: &'static str,
    pub fill: Option<&'static str>,
    pub stroke: Option<f32>,
    /// `StrokeAlignment`, when not centred.
    pub alignment: Option<&'static str>,
    /// The `<TransparencySetting>` children, verbatim.
    pub object: String,
}

/// `(label, shape, fill, stroke weight, stroke alignment, effects)`.
type RawCase = (
    &'static str,
    Shape,
    Option<&'static str>,
    Option<f32>,
    Option<&'static str>,
    String,
);

/// Every case, in number order.
pub fn cases() -> Vec<Case> {
    let feather =
        r#"<FeatherSetting Mode="Standard" Width="10" ChokeAmount="0" CornerType="Sharp" Noise="0"/>"#
            .to_string();
    let directional = r#"<DirectionalFeatherSetting Applied="true" LeftWidth="24" RightWidth="0" TopWidth="12" BottomWidth="0" Angle="0"/>"#.to_string();
    let gradient = r#"<GradientFeatherSetting Applied="true" Type="Linear" Angle="0"><GradientStop Location="0" Opacity="100"/><GradientStop Location="100" Opacity="0"/></GradientFeatherSetting>"#.to_string();
    let magenta = Some("Color/Magenta");
    let raw: Vec<RawCase> = vec![
        (
            "feather, stroke centred",
            Shape::Rect,
            magenta,
            Some(STROKE),
            None,
            feather.clone(),
        ),
        (
            "feather, stroke outside",
            Shape::Rect,
            magenta,
            Some(STROKE),
            Some("OutsideAlignment"),
            feather.clone(),
        ),
        (
            "feather, stroke inside",
            Shape::Rect,
            magenta,
            Some(STROKE),
            Some("InsideAlignment"),
            feather.clone(),
        ),
        (
            "feather, stroked oval",
            Shape::Oval,
            magenta,
            Some(STROKE),
            None,
            feather.clone(),
        ),
        (
            "directional, stroked",
            Shape::Rect,
            magenta,
            Some(STROKE),
            None,
            directional,
        ),
        (
            "gradient feather, stroked",
            Shape::Rect,
            magenta,
            Some(STROKE),
            None,
            gradient,
        ),
        (
            "text frame, filled",
            Shape::Text,
            magenta,
            None,
            None,
            feather.clone(),
        ),
        (
            "text frame, text only",
            Shape::Text,
            None,
            None,
            None,
            feather.clone(),
        ),
        (
            "text frame, filled, stroked",
            Shape::Text,
            magenta,
            Some(4.0),
            None,
            feather,
        ),
    ];
    raw.into_iter()
        .enumerate()
        .map(
            |(i, (label, shape, fill, stroke, alignment, object))| Case {
                n: i as u32 + 1,
                col: i % 3,
                row: i / 3,
                shape,
                label,
                fill,
                stroke,
                alignment,
                object,
            },
        )
        .collect()
}

fn colors() -> Vec<ExtraColor> {
    let c = |id: &str, v: &str| ExtraColor {
        self_id: format!("Color/{id}"),
        name: id.to_string(),
        space: "CMYK",
        value: v.to_string(),
    };
    vec![c("Magenta", "0 100 0 0"), c("Yellow", "0 0 100 0")]
}

fn rect(id: String, w: f32, h: f32, x: f32, y: f32) -> Rect {
    Rect {
        self_id: id,
        width_pt: w,
        height_pt: h,
        item_transform: translate(x, y),
        fill_color: None,
        stroke_color: None,
        stroke_weight_pt: None,
        parent_story: None,
        next_text_frame: None,
        previous_text_frame: None,
        extra_attrs: Vec::new(),
        blending: None,
        drop_shadow: None,
        placed_image: None,
        text_wrap: None,
        anchored_setting: None,
        frame_effects: Vec::new(),
        text_frame_pref: None,
        custom_subpaths: None,
    }
}

fn one_line_story(story_id: &str, text: String, size: f32, leading: f32) -> Vec<u8> {
    write_story(&Story {
        extra_story_attrs: Vec::new(),
        self_id: story_id.to_string(),
        paragraphs: vec![Paragraph {
            extra_paragraph_attrs: vec![("Hyphenation", "false")],
            leading: Some(leading),
            justification: Some("LeftAlign"),
            runs: vec![Run {
                extra_char_attrs: Vec::new(),
                text,
                point_size: Some(size),
                fill_color: Some("Color/Black".into()),
                font_style: None,
                tracking: None,
                baseline_shift: None,
                underline: None,
                applied_font: Some(FONT),
                anchored_frame: None,
            }],
            ..Paragraph::plain("")
        }],
    })
}

/// Build the full `Sample` ready for `write_idml`.
pub fn build() -> Sample {
    let master_id = self_id(SAMPLE, "MasterSpread", 0);
    let master_page_id = self_id(SAMPLE, "MasterPage", 0);
    let mut next = 0u32;
    let mut id = |kind: &str| {
        next += 1;
        self_id(SAMPLE, kind, next)
    };
    let mut items: Vec<PageItem> = Vec::new();
    let mut splices: Vec<(String, String)> = Vec::new();
    let mut stories = Vec::new();
    let mut story_refs = Vec::new();
    for y in ROWS {
        let mut band = rect(
            id("Rectangle"),
            PAGE_W_PT - 40.0,
            H / 2.0 + 30.0,
            20.0,
            y + H / 2.0,
        );
        band.fill_color = Some("Color/Yellow".into());
        items.push(band.into());
    }
    for c in cases() {
        let (x, y) = (COLS[c.col], ROWS[c.row]);
        // The case's number and name above it.
        let story_id = id("Story");
        stories.push((
            story_id.clone(),
            one_line_story(&story_id, format!("{} · {}", c.n, c.label), 7.5, 9.0),
        ));
        story_refs.push(story_id.clone());
        let mut label = rect(id("TextFrame"), 150.0, 14.0, x, y - 34.0);
        label.parent_story = Some(story_id);
        label.text_frame_pref = Some(TextFramePref {
            inset_spacing: Some([0.0; 4]),
            ..Default::default()
        });
        items.push(label.into());
        let mut extra: Vec<(String, String)> = Vec::new();
        if let Some(a) = c.alignment {
            extra.push(("StrokeAlignment".into(), a.into()));
        }
        let stroke_color = c.stroke.map(|_| "Color/Black".to_string());
        let item_id;
        match c.shape {
            Shape::Rect => {
                item_id = id("Rectangle");
                let mut r = rect(item_id.clone(), W, H, x, y);
                r.fill_color = c.fill.map(Into::into);
                r.stroke_color = stroke_color;
                r.stroke_weight_pt = c.stroke;
                r.extra_attrs = extra;
                items.push(r.into());
            }
            Shape::Oval => {
                item_id = id("Oval");
                items.push(
                    Oval {
                        self_id: item_id.clone(),
                        width_pt: W,
                        height_pt: H,
                        item_transform: translate(x, y),
                        fill_color: c.fill.map(Into::into),
                        stroke_color,
                        stroke_weight_pt: c.stroke,
                        extra_attrs: extra,
                    }
                    .into(),
                );
            }
            Shape::Text => {
                item_id = id("TextFrame");
                let text_story = id("Story");
                stories.push((
                    text_story.clone(),
                    one_line_story(&text_story, "Feather".to_string(), 30.0, 36.0),
                ));
                story_refs.push(text_story.clone());
                let mut r = rect(item_id.clone(), W, H, x, y);
                r.parent_story = Some(text_story);
                r.fill_color = c.fill.map(Into::into);
                r.stroke_color = stroke_color;
                r.stroke_weight_pt = c.stroke;
                r.extra_attrs = extra;
                r.text_frame_pref = Some(TextFramePref {
                    inset_spacing: Some([14.0, 0.0, 0.0, 0.0]),
                    ..Default::default()
                });
                items.push(r.into());
            }
        }
        splices.push((
            item_id,
            format!("<TransparencySetting>{}</TransparencySetting>", c.object),
        ));
    }

    let spread_id = self_id(SAMPLE, "Spread", 0);
    let xml = write_spread(&Spread {
        self_id: spread_id.clone(),
        page_self_id: self_id(SAMPLE, "Page", 0),
        page_name: "feather-strokes · a feather fades the stroke and the text".to_string(),
        applied_master: format!("MasterSpread/{master_id}"),
        page_width_pt: PAGE_W_PT,
        page_height_pt: PAGE_H_PT,
        page_items: items,
        override_list: Vec::new(),
        margins: None,
        item_transform: None,
    });
    // Each block goes right after the item's own `</Properties>`, where
    // InDesign writes it.
    let mut s = String::from_utf8(xml).expect("utf-8");
    for (item, block) in &splices {
        let at = s.find(&format!(r#"Self="{item}""#)).expect("item written");
        let close = at + s[at..].find("</Properties>").expect("properties") + "</Properties>".len();
        s.insert_str(close, block);
    }

    let master_spreads = vec![(
        master_id.clone(),
        write_master(&Master {
            self_id: format!("MasterSpread/{master_id}"),
            page_self_id: master_page_id,
            page_width_pt: PAGE_W_PT,
            page_height_pt: PAGE_H_PT,
            page_items: Vec::new(),
        }),
    )];

    Sample {
        container_xml: container_xml(),
        designmap_xml: write_designmap(&DesignMap {
            self_id: "d".to_string(),
            master_spreads: vec![master_id],
            spreads: vec![spread_id.clone()],
            stories: story_refs,
        }),
        graphic_xml: graphic_xml_with_extras(&colors()),
        fonts_xml: fonts_xml(),
        styles_xml: styles_xml(),
        preferences_xml: preferences_xml(),
        backing_story_xml: backing_story_xml(),
        tags_xml: tags_xml(),
        mapping_xml: mapping_xml(),
        master_spreads,
        spreads: vec![(spread_id, s.into_bytes())],
        stories,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Through the engine's own reader: every case's frame carries its
    /// feather, the stroked ones their stroke and alignment.
    #[test]
    fn every_case_reads_back_with_its_feather() {
        let bytes = crate::package::write_idml(&build()).expect("package");
        let doc = idml_import::import_idml_doc(&bytes).expect("import");
        let spread = &doc.spreads[0].spread;
        macro_rules! feathered {
            ($items:expr) => {
                $items
                    .iter()
                    .filter(|i| {
                        i.effects.as_ref().is_some_and(|e| {
                            e.feather.is_some()
                                || e.directional_feather.is_some()
                                || e.gradient_feather.is_some()
                        })
                    })
                    .count()
            };
        }
        let rects = feathered!(spread.rectangles);
        let ovals = feathered!(spread.ovals);
        let frames = feathered!(spread.text_frames);
        assert_eq!((rects, ovals, frames), (5, 1, 3));
    }
}
