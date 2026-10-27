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

//! View settings (v77, editor ADR 287) — how the canvas draws the
//! document on screen.
//!
//! Session state like the snap settings: set by `SetViewSettings`, kept
//! across document loads, never saved, never undoable, and never seen by
//! an export, a snapshot or a separation, which draw the document as
//! built. The mode reaches the rasterizers as
//! [`paged_gpu::RasterView`] plus Pixel Preview's flag; the model's build
//! (and so its display-list digest, ADR 101) does not depend on it.

use paged_gpu::RasterView;
use serde::{Deserialize, Serialize};
use tsify_next::Tsify;

/// Illustrator's four screen modes.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi, missing_as_null)]
#[serde(rename_all = "camelCase")]
pub enum ViewMode {
    /// Artwork in colour; overprinting inks knock out, as Illustrator's
    /// and InDesign's screens draw them by default.
    #[default]
    Preview,
    /// Paths as one-pixel hairlines, placed images as a box with a cross;
    /// no fills, strokes, effects or transparency.
    Outline,
    /// Preview with overprint simulated: an overprinting ink mixes with
    /// the inks below it, as on press.
    OverprintPreview,
    /// Preview as a 72 ppi raster — one pixel per point — enlarged with
    /// nearest-neighbour sampling, so edges show the pixels a 72 ppi
    /// export has.
    PixelPreview,
}

impl ViewMode {
    /// The rasterizer view this mode draws with.
    pub fn raster_view(self) -> RasterView {
        match self {
            ViewMode::Preview | ViewMode::PixelPreview => RasterView::Knockout,
            ViewMode::Outline => RasterView::Outline,
            ViewMode::OverprintPreview => RasterView::Composite,
        }
    }

    /// Whether the screen draws the 72 ppi raster.
    pub fn pixel_preview(self) -> bool {
        matches!(self, ViewMode::PixelPreview)
    }
}

/// `SetViewSettings` payload and `ViewSettingsApplied` reply.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi, missing_as_null)]
#[serde(rename_all = "camelCase", default)]
pub struct ViewSettings {
    pub mode: ViewMode,
}

impl ViewSettings {
    /// Raster options for drawing a `width_pt × height_pt` page on screen
    /// at `dpi` under these settings.
    pub fn raster_options(
        &self,
        width_pt: f32,
        height_pt: f32,
        dpi: f32,
        background: paged_compose::Color,
    ) -> paged_gpu::RasterOptions {
        let mut opts = paged_gpu::RasterOptions::new(width_pt, height_pt);
        opts.dpi = dpi;
        opts.background = background;
        opts.view = self.mode.raster_view();
        opts.pixel_preview = self.mode.pixel_preview();
        opts
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_wire_spells_the_modes_in_camel_case() {
        let json = serde_json::to_string(&ViewSettings {
            mode: ViewMode::OverprintPreview,
        })
        .unwrap();
        assert_eq!(json, r#"{"mode":"overprintPreview"}"#);
        let back: ViewSettings = serde_json::from_str(r#"{"mode":"pixelPreview"}"#).unwrap();
        assert_eq!(back.mode, ViewMode::PixelPreview);
        // Every field defaults: an empty object is Preview.
        let empty: ViewSettings = serde_json::from_str("{}").unwrap();
        assert_eq!(empty.mode, ViewMode::Preview);
    }

    #[test]
    fn each_mode_maps_to_its_raster_view() {
        assert_eq!(ViewMode::Preview.raster_view(), RasterView::Knockout);
        assert_eq!(ViewMode::Outline.raster_view(), RasterView::Outline);
        assert_eq!(
            ViewMode::OverprintPreview.raster_view(),
            RasterView::Composite
        );
        assert_eq!(ViewMode::PixelPreview.raster_view(), RasterView::Knockout);
        assert!(ViewMode::PixelPreview.pixel_preview());
        assert!(!ViewMode::Outline.pixel_preview());
    }
}
