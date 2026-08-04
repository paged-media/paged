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

//! Trace parameters, their v0 defaults, and the HARD CAPS.
//!
//! Every field is documented with its unit and its default, because the
//! command surface has no description field to carry them (the plugin
//! contract's `CommandContribution` is `{ id, title, category, handler }`)
//! and a v0 whose knobs are folklore is a v0 nobody can use.

use serde::{Deserialize, Serialize};

/// Largest edge, in pixels, the tracer accepts. **A hard refusal, not a
/// clamp:** past this [`crate::trace_rgba`] returns
/// [`TraceError::TooLarge`](crate::TraceError::TooLarge) and traces
/// nothing. The DECODER (draw-bundle's `io/raster-decode.ts`) is what
/// downsamples an over-cap placed image to fit, through the browser's own
/// `drawImage`, and it reports the factor it used — so a 6000×4000 photo
/// is traceable, at a stated loss of detail, and can never reach this
/// crate at full size.
pub const MAX_DIMENSION: u32 = 4096;

/// Largest pixel COUNT the tracer accepts (2048² = 4 194 304). Both caps
/// apply: 4096×2048 is refused for area even though each edge is legal.
///
/// The number is not arbitrary. Clustering + walking + fitting is
/// O(pixels) with a large constant, and it runs where it is called —
/// see [`crate::trace_rgba`]'s note on blocking.
pub const MAX_PIXELS: u32 = 4_194_304;

/// Per-channel floor at or above which [`TraceOptions::ignore_white`]
/// calls a COLOUR-mode region "paper". 250, not 255, so an off-white scan
/// background still counts.
pub const WHITE_CHANNEL_FLOOR: u8 = 250;

/// What the tracer reduces the raster to before walking boundaries.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TraceMode {
    /// Hierarchical COLOUR clustering (visioncortex `color_clusters`) —
    /// one region per colour cluster, filled with the cluster's mean
    /// colour. This is the real thing, not a posterise.
    Color,
    /// One luminance threshold, then binary clustering. Two tones, and
    /// [`TraceOptions::ignore_white`] decides whether the light one is
    /// artwork or background.
    Bw,
}

/// How a walked boundary becomes geometry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PathMode {
    /// Corner points only — the walked polygon, simplified. Every anchor
    /// is a corner (handles collapsed onto the anchor).
    Polygon,
    /// Curve-fitted cubics (visioncortex `Spline::from_image`, which is
    /// walk → simplify → subdivide-smooth → Schneider fit). The default.
    Spline,
}

/// Trace parameters. Deserialised from the bundle as camelCase JSON;
/// every field has a documented v0 default and every default is what
/// [`TraceOptions::default`] returns.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TraceOptions {
    /// Colour clustering or a single luminance threshold. Default
    /// [`TraceMode::Color`].
    pub mode: TraceMode,
    /// Geometry produced per contour. Default [`PathMode::Spline`].
    pub path_mode: PathMode,
    /// Bits of colour kept when deciding "same colour", 1..=8. Higher =
    /// more, smaller clusters. Default 6. (Lowered into visioncortex's
    /// `is_same_color_a = 8 - color_precision`, whose own assertion is
    /// `< 8`, hence the 1 floor.)
    pub color_precision: u8,
    /// Clusters smaller than this many PIXELS are discarded — the noise
    /// gate. Default 4. Also feeds the clusterer's `good_min_area`.
    pub filter_speckle: usize,
    /// How different a neighbouring colour must be before the clusterer
    /// splits a new layer off (visioncortex `deepen_diff`, sum of |ΔR| +
    /// |ΔG| + |ΔB|). Default 16. Colour mode only.
    pub layer_difference: i32,
    /// Luminance split for [`TraceMode::Bw`], 0..=255 (Rec. 709 over an
    /// alpha-composited-onto-white pixel). Default 128.
    pub bw_threshold: u8,
    /// Drop the PAPER. Default `true` — Illustrator's "Ignore White", and
    /// the reason a scanned drawing does not come back with a page-sized
    /// white rectangle under it.
    ///
    /// In [`TraceMode::Bw`] it means "emit only the dark side of the
    /// threshold". In [`TraceMode::Color`] it means "drop any region
    /// whose colour is at or above [`WHITE_CHANNEL_FLOOR`] on every
    /// channel" — which is a HEURISTIC, and it will drop genuinely white
    /// artwork just as Illustrator's checkbox does. Turn it off when the
    /// white is meant to be there.
    pub ignore_white: bool,
    /// Angle (DEGREES) above which a turn is kept as a corner rather than
    /// smoothed. Default 60. Spline mode only.
    pub corner_threshold_deg: f64,
    /// Shortest segment, in pixels, the smoothing pass will subdivide to.
    /// Larger = coarser, fewer anchors. Default 4. Spline mode only.
    pub segment_length: f64,
    /// Angle (DEGREES) above which the fitter splices a new curve rather
    /// than extending the current one. Default 45. Spline mode only.
    pub splice_threshold_deg: f64,
    /// Iteration ceiling for the subdivide-smooth pass. Default 10 (the
    /// visioncortex default).
    pub max_iterations: usize,
    /// Hard ceiling on emitted regions. Regions are sorted by descending
    /// |area| and the surplus is DROPPED, with the count reported on
    /// [`TraceResult::truncated`](crate::TraceResult::truncated). Default
    /// 512 — every region becomes at least one document element and one
    /// wire op, so this is a document-size gate as much as a time one.
    pub max_regions: usize,
    /// Emit STACKED regions (each cluster keeps its full area and the
    /// finer clusters paint on top) instead of CUT-OUT ones (a parent has
    /// its children carved out as holes). Default `false` = cut out,
    /// because cut-out regions are disjoint: the artwork then does not
    /// depend on z-order to look right, which matters when the emitted
    /// elements can be re-ordered by hand afterwards.
    pub stacked: bool,
}

impl Default for TraceOptions {
    fn default() -> Self {
        Self {
            mode: TraceMode::Color,
            path_mode: PathMode::Spline,
            color_precision: 6,
            filter_speckle: 4,
            layer_difference: 16,
            bw_threshold: 128,
            ignore_white: true,
            corner_threshold_deg: 60.0,
            segment_length: 4.0,
            splice_threshold_deg: 45.0,
            max_iterations: 10,
            max_regions: 512,
            stacked: false,
        }
    }
}

impl TraceOptions {
    /// Clamp every field into the range the kernel can actually honour.
    /// Called on the way in, so an out-of-range value from JS is a
    /// SATURATION, never a panic — `is_same_color_a >= 8` would trip
    /// visioncortex's own `assert!`, and an assert in a `panic = abort`
    /// wasm module is an unrecoverable abort of the whole bundle realm.
    pub fn sanitized(self) -> Self {
        Self {
            color_precision: self.color_precision.clamp(1, 8),
            filter_speckle: self.filter_speckle.min(1 << 20),
            layer_difference: self.layer_difference.clamp(0, 765),
            corner_threshold_deg: clamp_finite(self.corner_threshold_deg, 0.0, 180.0, 60.0),
            segment_length: clamp_finite(self.segment_length, 1.0, 1024.0, 4.0),
            splice_threshold_deg: clamp_finite(self.splice_threshold_deg, 0.0, 180.0, 45.0),
            max_iterations: self.max_iterations.clamp(1, 64),
            max_regions: self.max_regions.clamp(1, 20_000),
            ..self
        }
    }

    /// `is_same_color_a` for visioncortex's `RunnerConfig` — the shift
    /// applied before colours are compared. Always `< 8` (its assert).
    pub(crate) fn same_color_shift(self) -> i32 {
        (8 - self.color_precision.clamp(1, 8)) as i32
    }
}

fn clamp_finite(v: f64, lo: f64, hi: f64, fallback: f64) -> f64 {
    if v.is_finite() {
        v.clamp(lo, hi)
    } else {
        fallback
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_the_documented_v0_defaults() {
        let d = TraceOptions::default();
        assert_eq!(d.mode, TraceMode::Color);
        assert_eq!(d.path_mode, PathMode::Spline);
        assert_eq!(d.color_precision, 6);
        assert_eq!(d.filter_speckle, 4);
        assert_eq!(d.layer_difference, 16);
        assert_eq!(d.bw_threshold, 128);
        assert!(d.ignore_white);
        assert_eq!(d.max_regions, 512);
        assert!(!d.stacked);
    }

    #[test]
    fn sanitize_keeps_the_same_color_shift_under_visioncortex_assert() {
        // `Runner::builder` asserts `is_same_color_a < 8`; an abort there
        // would take the whole wasm realm down (panic = abort).
        for precision in [0u8, 1, 6, 8, 200] {
            let opts = TraceOptions {
                color_precision: precision,
                ..Default::default()
            }
            .sanitized();
            assert!(opts.same_color_shift() < 8);
            assert!(opts.same_color_shift() >= 0);
        }
    }

    #[test]
    fn sanitize_replaces_non_finite_angles_with_the_defaults() {
        let opts = TraceOptions {
            corner_threshold_deg: f64::NAN,
            segment_length: f64::INFINITY,
            splice_threshold_deg: -1.0,
            ..Default::default()
        }
        .sanitized();
        // NaN / ±∞ fall back to the DEFAULT (a clamp of a non-finite is
        // still non-finite); a merely out-of-range finite value clamps.
        assert_eq!(opts.corner_threshold_deg, 60.0);
        assert_eq!(opts.segment_length, 4.0);
        assert_eq!(opts.splice_threshold_deg, 0.0);
        assert_eq!(
            TraceOptions {
                segment_length: 1e9,
                ..Default::default()
            }
            .sanitized()
            .segment_length,
            1024.0
        );
    }

    #[test]
    fn options_round_trip_as_camel_case_json() {
        let json = r#"{"mode":"bw","pathMode":"polygon","colorPrecision":8,"ignoreWhite":false}"#;
        let opts: TraceOptions = serde_json::from_str(json).unwrap();
        assert_eq!(opts.mode, TraceMode::Bw);
        assert_eq!(opts.path_mode, PathMode::Polygon);
        assert_eq!(opts.color_precision, 8);
        assert!(!opts.ignore_white);
        // Unspecified fields keep their documented defaults.
        assert_eq!(opts.filter_speckle, 4);
        assert_eq!(opts.max_regions, 512);
    }
}
