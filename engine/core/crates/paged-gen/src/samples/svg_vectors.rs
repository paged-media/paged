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

//! `svg-vectors.idml` — a placed SVG the display list draws as vectors
//! (ADR 190, amendment of 2026-10-20).
//!
//! `corpus/generated-fixtures/svg-vectors/art.svg` (paths, a dashed
//! stroke, an even-odd ring, a linear and a radial gradient, a clip path,
//! a group at 50 % and a multiply group) is embedded in its `<Image>` and
//! placed five times on one page: at 100 %, 200 % and 50 %, rotated 20°,
//! and stretched 150 % × 100 %, which the vectors cannot follow (a stroke
//! keeps one width), so that one draws the SVG's raster. No InDesign
//! reference: the parity lane holds the GPU lane to the CPU lane on it and
//! the export lane the exported PDF to the CPU render.

use crate::builders::{
    designmap::{write_designmap, DesignMap},
    master::{write_master, Master},
    page_item::{PageItem, PlacedImage, Rect},
    resources::{container_xml, fonts_xml, graphic_xml, preferences_xml, styles_xml},
    spread::{write_spread, Spread},
    xml_folder::{backing_story_xml, mapping_xml, tags_xml},
};
use crate::geometry::{compose, rotate_deg, scale, translate, Matrix};
use crate::ids::self_id;
use crate::package::Sample;

const SAMPLE: &str = "svg-vectors";
const PAGE_W_PT: f32 = 595.276;
const PAGE_H_PT: f32 = 841.890;

const ART: &[u8] = include_bytes!("../../../../corpus/generated-fixtures/svg-vectors/art.svg");
/// The art's own size in pt (one user unit a point).
const ART_W: f32 = 120.0;
const ART_H: f32 = 80.0;

/// Where a placement stands (pt), its scale (x, y), and its turn (°).
type Placement = ((f32, f32), (f32, f32), f32);

const PLACEMENTS: &[Placement] = &[
    ((40.0, 40.0), (1.0, 1.0), 0.0),
    ((40.0, 160.0), (2.0, 2.0), 0.0),
    ((320.0, 40.0), (0.5, 0.5), 0.0),
    ((510.0, 160.0), (1.0, 1.0), 20.0),
    ((40.0, 360.0), (1.5, 1.0), 0.0),
];

fn placed(n: u32, at: Matrix, art: Matrix, frame: (f32, f32)) -> PageItem {
    Rect {
        self_id: self_id(SAMPLE, "Frame", n),
        width_pt: frame.0,
        height_pt: frame.1,
        item_transform: at,
        fill_color: None,
        stroke_color: None,
        stroke_weight_pt: None,
        parent_story: None,
        next_text_frame: None,
        previous_text_frame: None,
        extra_attrs: Vec::new(),
        blending: None,
        drop_shadow: None,
        placed_image: Some(PlacedImage {
            link_resource_uri: "file:art.svg".to_string(),
            fitting: "None",
            left_crop: 0.0,
            top_crop: 0.0,
            right_crop: 0.0,
            bottom_crop: 0.0,
            image_self_id: self_id(SAMPLE, "Image", n),
            image_w_pt: ART_W,
            image_h_pt: ART_H,
            image_item_transform: Some(art),
            effective_ppi: None,
            actual_ppi: None,
            color_space: None,
            inline_bytes: Some(ART.to_vec()),
            clipping_path: None,
            pdf: None,
        }),
        text_wrap: None,
        anchored_setting: None,
        frame_effects: Vec::new(),
        text_frame_pref: None,
        custom_subpaths: None,
    }
    .into()
}

/// Build the full `Sample` ready for `write_idml`.
pub fn build() -> Sample {
    let items: Vec<PageItem> = PLACEMENTS
        .iter()
        .enumerate()
        .map(|(n, &((x, y), (sx, sy), turn))| {
            placed(
                n as u32,
                compose(translate(x, y), rotate_deg(turn)),
                scale(sx, sy),
                (ART_W * sx, ART_H * sy),
            )
        })
        .collect();
    let master_id = self_id(SAMPLE, "MasterSpread", 0);
    let id = self_id(SAMPLE, "Spread", 0);
    let spread = write_spread(&Spread {
        self_id: id.clone(),
        page_self_id: self_id(SAMPLE, "Page", 0),
        page_name: "1".to_string(),
        applied_master: format!("MasterSpread/{master_id}"),
        page_width_pt: PAGE_W_PT,
        page_height_pt: PAGE_H_PT,
        page_items: items,
        override_list: Vec::new(),
        margins: None,
        item_transform: None,
    });
    Sample {
        container_xml: container_xml(),
        designmap_xml: write_designmap(&DesignMap {
            self_id: "d".to_string(),
            master_spreads: vec![master_id.clone()],
            spreads: vec![id.clone()],
            stories: Vec::new(),
        }),
        graphic_xml: graphic_xml(),
        fonts_xml: fonts_xml(),
        styles_xml: styles_xml(),
        preferences_xml: preferences_xml(),
        backing_story_xml: backing_story_xml(),
        tags_xml: tags_xml(),
        mapping_xml: mapping_xml(),
        master_spreads: vec![(
            master_id.clone(),
            write_master(&Master {
                self_id: format!("MasterSpread/{master_id}"),
                page_self_id: self_id(SAMPLE, "MasterPage", 0),
                page_width_pt: PAGE_W_PT,
                page_height_pt: PAGE_H_PT,
                page_items: Vec::new(),
            }),
        )],
        spreads: vec![(id, spread)],
        stories: Vec::new(),
    }
}
