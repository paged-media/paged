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

//! View settings (v77, editor ADR 287; v81, engine ADR 1306) — how the
//! canvas draws the document on screen.
//!
//! Session state like the snap settings: set by `SetViewSettings`, kept
//! across document loads, never saved, never undoable, and never seen by
//! an export, a snapshot or a separation, which draw the document as
//! built. The mode reaches the rasterizers as
//! [`paged_gpu::RasterView`] plus Pixel Preview's flag; the model's build
//! (and so its display-list digest, ADR 101) does not depend on it. Two
//! flags are build options (v81, engine ADR 1306): hiding nonprinting
//! items and a proof's missing markers change the LIVE build, which the
//! model rebuilds when they change ([`ViewSettings::build_differs`]); an
//! export still builds the document as printed.

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
    /// v81 (engine ADR 1306) — leave the page items marked nonprinting
    /// off the screen, as the export leaves them out of print (engine ADR
    /// 1095): the editor's "Nonprinting items" aid off, and every proof.
    /// The live build omits them, and the hit test lands on none of them.
    /// Absent: shown, as InDesign's Normal view shows them.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    #[tsify(optional)]
    pub hide_nonprinting: bool,
    /// v81 (engine ADR 1306) — draw the screen as a proof (editor ADR
    /// 1212): no page edge on either lane and none of the live build's
    /// degraded-asset markers (the pink of a substituted font, the cross
    /// over a placed EPS or PDF whose link is missing), so the page is the
    /// export's. A missing image keeps InDesign's grey placeholder, which
    /// the export prints too. Absent: the editing screen.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    #[tsify(optional)]
    pub proof: bool,
}

impl ViewSettings {
    /// Whether the live build differs between `self` and `other`: the
    /// view mode is a raster-time rewrite, nonprinting items and the
    /// proof's markers are build options (engine ADR 1306).
    pub fn build_differs(&self, other: &ViewSettings) -> bool {
        self.hide_nonprinting != other.hide_nonprinting || self.proof != other.proof
    }

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

/// Engine ADR 1306 — where `page` draws on the screen, `[x, y, w, h]`
/// page-local pt: [`paged_gpu::screen::screen_extent`], the rect the CPU
/// lane's tile covers and the GPU lane clips to.
pub fn screen_extent(page: &paged_renderer::BuiltPage) -> [f32; 4] {
    let r = paged_gpu::screen::screen_extent(&page.list, page.width_pt, page.height_pt).rect;
    [r.x, r.y, r.w, r.h]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_wire_spells_the_modes_in_camel_case() {
        let json = serde_json::to_string(&ViewSettings {
            mode: ViewMode::OverprintPreview,
            ..ViewSettings::default()
        })
        .unwrap();
        assert_eq!(json, r#"{"mode":"overprintPreview"}"#);
        let back: ViewSettings = serde_json::from_str(r#"{"mode":"pixelPreview"}"#).unwrap();
        assert_eq!(back.mode, ViewMode::PixelPreview);
        // Every field defaults: an empty object is Preview.
        let empty: ViewSettings = serde_json::from_str("{}").unwrap();
        assert_eq!(empty.mode, ViewMode::Preview);
        assert!(!empty.hide_nonprinting && !empty.proof);
        // v81 — the proof flags, spelled in camel case and left out when off.
        let proof: ViewSettings =
            serde_json::from_str(r#"{"mode":"preview","hideNonprinting":true,"proof":true}"#)
                .unwrap();
        assert!(proof.hide_nonprinting && proof.proof);
        assert_eq!(
            serde_json::to_string(&proof).unwrap(),
            r#"{"mode":"preview","hideNonprinting":true,"proof":true}"#
        );
    }

    #[test]
    fn only_the_build_flags_make_the_build_differ() {
        let base = ViewSettings::default();
        let outline = ViewSettings {
            mode: ViewMode::Outline,
            ..base
        };
        assert!(!base.build_differs(&outline));
        for other in [
            ViewSettings {
                hide_nonprinting: true,
                ..base
            },
            ViewSettings {
                proof: true,
                ..base
            },
        ] {
            assert!(base.build_differs(&other));
        }
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
