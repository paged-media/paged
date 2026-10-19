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

//! `svg-filters.idml` — the placed-SVG fixtures of
//! `corpus/generated-fixtures/svg/` on pages (ADR 190).
//!
//! Every fixture is embedded in its `<Image>` (base64 `<Contents>`), so the
//! document needs no links folder. Pages 1–3 place them at 100 %, two to a
//! row; page 4 places three again at 200 %, at 50 % and rotated 20°, so a
//! render at any resolution shows how a placed SVG is sampled. No text,
//! no InDesign reference: the parity lane (`parity-diff.sh`) holds the GPU
//! lane to the CPU lane on it, and the SVG reference test
//! (`paged-gpu/tests/it/svg_reference.rs`) holds the CPU lane to `resvg`.

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

const SAMPLE: &str = "svg-filters";
const PAGE_W_PT: f32 = 595.276;
const PAGE_H_PT: f32 = 841.890;

macro_rules! fixture {
    ($name:literal, $w:literal, $h:literal) => {
        (
            $name,
            $w,
            $h,
            include_bytes!(concat!(
                "../../../../corpus/generated-fixtures/svg/",
                $name,
                ".svg"
            ))
            .as_slice(),
        )
    };
}

/// Name, size in pt (the SVG's own, one user unit a point), bytes.
const FIXTURES: &[(&str, f32, f32, &[u8])] = &[
    fixture!("blur", 240.0, 160.0),
    fixture!("drop-shadow", 240.0, 160.0),
    fixture!("color-matrix", 240.0, 160.0),
    fixture!("blend", 240.0, 160.0),
    fixture!("composite", 240.0, 160.0),
    fixture!("merge", 200.0, 120.0),
    fixture!("turbulence", 240.0, 160.0),
    fixture!("displacement", 240.0, 120.0),
    fixture!("component-transfer", 240.0, 160.0),
    fixture!("morphology", 240.0, 120.0),
    fixture!("lighting", 240.0, 160.0),
    fixture!("lighting-color", 240.0, 80.0),
    fixture!("convolve", 240.0, 80.0),
    fixture!("tile", 200.0, 120.0),
    fixture!("clip-mask", 240.0, 160.0),
    fixture!("gradients", 240.0, 160.0),
    fixture!("transformed", 240.0, 160.0),
    fixture!("text", 240.0, 100.0),
];

/// Page 4: a fixture again, scaled or turned in its frame.
struct Again {
    name: &'static str,
    at: (f32, f32),
    scale: f32,
    rotate: f32,
}

const AGAIN: &[Again] = &[
    Again {
        name: "drop-shadow",
        at: (40.0, 40.0),
        scale: 2.0,
        rotate: 0.0,
    },
    Again {
        name: "turbulence",
        at: (40.0, 420.0),
        scale: 0.5,
        rotate: 0.0,
    },
    Again {
        name: "blend",
        at: (300.0, 470.0),
        scale: 1.0,
        rotate: 20.0,
    },
];

fn placed(
    n: u32,
    name: &str,
    bytes: &[u8],
    size: (f32, f32),
    at: Matrix,
    art: Matrix,
    frame: (f32, f32),
) -> PageItem {
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
            link_resource_uri: format!("file:{name}.svg"),
            fitting: "None",
            left_crop: 0.0,
            top_crop: 0.0,
            right_crop: 0.0,
            bottom_crop: 0.0,
            image_self_id: self_id(SAMPLE, "Image", n),
            image_w_pt: size.0,
            image_h_pt: size.1,
            image_item_transform: Some(art),
            effective_ppi: None,
            actual_ppi: None,
            color_space: None,
            inline_bytes: Some(bytes.to_vec()),
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
    // Pages 1–3: two to a row, a new page when a row does not fit.
    let mut pages: Vec<Vec<PageItem>> = vec![Vec::new()];
    let (mut y, mut col, mut row_h) = (40.0f32, 0usize, 0.0f32);
    let mut n = 0u32;
    for &(name, w, h, bytes) in FIXTURES {
        if col == 2 {
            y += row_h + 24.0;
            col = 0;
            row_h = 0.0;
        }
        if col == 0 && y + h > PAGE_H_PT - 40.0 {
            pages.push(Vec::new());
            y = 40.0;
        }
        let x = if col == 0 { 40.0 } else { 315.0 };
        let item = placed(
            n,
            name,
            bytes,
            (w, h),
            translate(x, y),
            translate(0.0, 0.0),
            (w, h),
        );
        pages.last_mut().expect("a page").push(item);
        row_h = row_h.max(h);
        col += 1;
        n += 1;
    }
    let mut last = Vec::new();
    for again in AGAIN {
        let &(name, w, h, bytes) = FIXTURES
            .iter()
            .find(|f| f.0 == again.name)
            .expect("a fixture");
        let frame = (w * again.scale, h * again.scale);
        let at = compose(translate(again.at.0, again.at.1), rotate_deg(again.rotate));
        last.push(placed(
            n,
            name,
            bytes,
            (w, h),
            at,
            scale(again.scale, again.scale),
            frame,
        ));
        n += 1;
    }
    pages.push(last);

    let master_id = self_id(SAMPLE, "MasterSpread", 0);
    let spreads: Vec<(String, Vec<u8>)> = pages
        .into_iter()
        .enumerate()
        .map(|(i, items)| {
            let id = self_id(SAMPLE, "Spread", i as u32);
            let xml = write_spread(&Spread {
                self_id: id.clone(),
                page_self_id: self_id(SAMPLE, "Page", i as u32),
                page_name: (i + 1).to_string(),
                applied_master: format!("MasterSpread/{master_id}"),
                page_width_pt: PAGE_W_PT,
                page_height_pt: PAGE_H_PT,
                page_items: items,
                override_list: Vec::new(),
                margins: None,
                item_transform: None,
            });
            (id, xml)
        })
        .collect();
    Sample {
        container_xml: container_xml(),
        designmap_xml: write_designmap(&DesignMap {
            self_id: "d".to_string(),
            master_spreads: vec![master_id.clone()],
            spreads: spreads.iter().map(|(id, _)| id.clone()).collect(),
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
        spreads,
        stories: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every SVG of the fixtures folder is placed, at the size it declares.
    #[test]
    fn every_svg_fixture_is_placed_at_its_own_size() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../corpus/generated-fixtures/svg");
        let mut on_disk: Vec<String> = std::fs::read_dir(&dir)
            .expect("fixtures")
            .filter_map(|e| {
                let name = e.ok()?.file_name().into_string().ok()?;
                name.strip_suffix(".svg").map(str::to_string)
            })
            .collect();
        on_disk.sort();
        let mut placed: Vec<String> = FIXTURES.iter().map(|f| f.0.to_string()).collect();
        placed.sort();
        assert_eq!(on_disk, placed);
        for &(name, w, h, bytes) in FIXTURES {
            let svg = std::str::from_utf8(bytes).expect("utf-8");
            assert!(
                svg.contains(&format!(r#"width="{w}" height="{h}""#)),
                "{name} declares {w} × {h}"
            );
        }
    }
}
