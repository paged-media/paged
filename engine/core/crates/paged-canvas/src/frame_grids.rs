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

//! Per-frame baseline grids (v81, engine ADR 1306): the text frames that
//! use a grid of their own (Text Frame Options ▸ Baseline Options ▸ Use
//! Custom Baseline Grid), with the grid the composer sets their aligned
//! lines on — so the editor's Baseline grid aid draws them where the
//! lines stand, not only the document's grid.

use paged_renderer::PageId;
use serde::{Deserialize, Serialize};
use tsify_next::Tsify;

use crate::model::{page_space_transform, CanvasModel};

/// What a frame's grid is measured from (IDML
/// `BaselineFrameGridRelativeOption`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi)]
#[serde(rename_all = "camelCase")]
pub enum FrameGridReference {
    TopOfPage,
    TopOfMargin,
    TopOfFrame,
    TopOfInset,
}

impl From<paged_model::BaselineFrameGridRelativeOption> for FrameGridReference {
    fn from(o: paged_model::BaselineFrameGridRelativeOption) -> Self {
        use paged_model::BaselineFrameGridRelativeOption as O;
        match o {
            O::TopOfPage => Self::TopOfPage,
            O::TopOfMargin => Self::TopOfMargin,
            O::TopOfFrame => Self::TopOfFrame,
            O::TopOfInset => Self::TopOfInset,
        }
    }
}

/// One text frame's own baseline grid.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi, missing_as_null)]
#[serde(rename_all = "camelCase")]
pub struct FrameBaselineGrid {
    pub frame_id: String,
    pub page_id: PageId,
    /// The frame's box in its own coordinates, `[top, left, bottom,
    /// right]` pt (as `ElementGeometryItem.bounds`).
    pub bounds: [f32; 4],
    /// Its own coordinates → the page's (as
    /// `ElementGeometryItem.itemTransform`); absent: the identity.
    pub item_transform: Option<[f32; 6]>,
    /// The first grid line, pt below the frame's top edge.
    pub start: f32,
    /// The distance between grid lines, pt.
    pub increment: f32,
    /// What the frame's grid is measured from.
    pub relative_to: FrameGridReference,
}

impl CanvasModel {
    /// v81 (engine ADR 1306) — the custom baseline grids of the text
    /// frames on `page_ids` (every page when empty).
    pub fn frame_baseline_grids(&self, page_ids: &[PageId]) -> Vec<FrameBaselineGrid> {
        let mut out = Vec::new();
        for parsed in &self.scene().spreads {
            let spread = &parsed.spread;
            for frame in &spread.text_frames {
                let Some((reference, _, _)) = frame.baseline_frame_grid.and_then(|g| g.custom())
                else {
                    continue;
                };
                let Some(id) = frame.self_id.as_ref() else {
                    continue;
                };
                if !frame.visible {
                    continue;
                }
                let Some(page) = self.host_page(spread, frame.bounds, frame.item_transform) else {
                    continue;
                };
                if !page_ids.is_empty() && !page_ids.contains(&page.id) {
                    continue;
                }
                let Some((start, increment)) =
                    paged_renderer::pipeline::frame_custom_grid(self.scene(), frame, page)
                else {
                    continue;
                };
                let b = frame.bounds;
                out.push(FrameBaselineGrid {
                    frame_id: id.clone(),
                    page_id: page.id.clone(),
                    bounds: [b.top, b.left, b.bottom, b.right],
                    item_transform: page_space_transform(Some(page), frame.item_transform),
                    start,
                    increment,
                    relative_to: reference.into(),
                });
            }
        }
        out
    }
}
