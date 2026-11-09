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

//! Shrink text to fit (engine ADR 1061): how a fit sets a frame's text.
//!
//! The story keeps the sizes it was written in; the emitter reads each
//! run's resolved attributes through [`fit_run`], so the size, the leading
//! and the baseline shift are the fitted ones wherever the composer asks.
//! A `FixedHeight` first baseline follows the line pitch
//! ([`minimum_first_baseline`]). Paragraph spacing, indents and tab stops
//! keep their written values, as PowerPoint keeps them. Which fit a frame
//! gets is decided before layout, with the auto-size fits
//! (`auto_size::Measurer::fit_shrink`).

use paged_model::text_fit::ShrinkToFit;
use paged_model::{FirstBaselineOffset, TextFrame};

/// The fit a chain's emitter applies: its head frame's, when the story
/// is in that one frame (its column regions are clones of it) and the fit
/// changes something.
pub(super) fn chain_fit(chain: &[&TextFrame]) -> Option<ShrinkToFit> {
    let head = chain.first()?;
    if chain.iter().any(|f| f.self_id != head.self_id) {
        return None;
    }
    frame_fit(head)
}

/// A frame's fit, clamped; `None` when it has none or it changes nothing.
pub(super) fn frame_fit(frame: &TextFrame) -> Option<ShrinkToFit> {
    frame
        .shrink_to_fit
        .map(ShrinkToFit::clamped)
        .filter(|f| !f.is_none())
}

/// The frame's `MinimumFirstBaselineOffset`, scaled with the line pitch
/// when the frame shrinks its text and its first baseline is a fixed
/// height (the pitch it was measured from shrinks with the text).
pub(super) fn minimum_first_baseline(frame: &TextFrame) -> Option<f32> {
    let v = frame.minimum_first_baseline_offset?;
    match (frame.first_baseline_offset, frame_fit(frame)) {
        (Some(FirstBaselineOffset::FixedHeight), Some(fit)) => Some(v * fit.line_factor()),
        _ => Some(v),
    }
}

/// A run's resolved attributes as `fit` sets them. `default_pt` is the
/// size a run without one is set in; `auto_leading_pct` the paragraph's
/// auto leading (InDesign's 120 when it does not say).
pub(super) fn fit_run(
    mut attrs: paged_scene::ResolvedRunAttrs,
    fit: ShrinkToFit,
    default_pt: f32,
    auto_leading_pct: f32,
) -> paged_scene::ResolvedRunAttrs {
    let size = attrs.point_size.unwrap_or(default_pt) * fit.font_scale;
    attrs.point_size = Some(size);
    attrs.leading = match attrs.leading {
        Some(l) if l > 0.0 => Some(l * fit.line_factor()),
        // Auto leading follows the size by itself; a line spacing
        // reduction makes it an explicit one.
        _ if fit.line_spacing_reduction > 0.0 => {
            Some(size * auto_leading_pct / 100.0 * (1.0 - fit.line_spacing_reduction))
        }
        other => other,
    };
    attrs.baseline_shift = attrs.baseline_shift.map(|b| b * fit.font_scale);
    attrs
}

/// A frame clone that sets its text at `fit`.
pub(super) fn with_fit(frame: &TextFrame, fit: ShrinkToFit) -> TextFrame {
    let mut f = frame.clone();
    f.shrink_to_fit = Some(fit);
    f
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_fit_scales_size_leading_and_shift() {
        let attrs = paged_scene::ResolvedRunAttrs {
            point_size: Some(20.0),
            leading: Some(24.0),
            baseline_shift: Some(2.0),
            ..Default::default()
        };
        let fit = ShrinkToFit::new(0.5, 0.2);
        let a = fit_run(attrs.clone(), fit, 12.0, 120.0);
        assert_eq!(a.point_size, Some(10.0));
        assert!((a.leading.unwrap() - 9.6).abs() < 1e-5);
        assert_eq!(a.baseline_shift, Some(1.0));
        // Auto leading becomes explicit only when lines are reduced.
        let auto = paged_scene::ResolvedRunAttrs {
            point_size: None,
            ..Default::default()
        };
        let a = fit_run(auto.clone(), ShrinkToFit::new(0.5, 0.0), 12.0, 120.0);
        assert_eq!((a.point_size, a.leading), (Some(6.0), None));
        let a = fit_run(auto, ShrinkToFit::new(0.5, 0.1), 12.0, 120.0);
        assert!((a.leading.unwrap() - 6.48).abs() < 1e-5);
    }

    #[test]
    fn a_fixed_first_baseline_follows_the_pitch() {
        let mut f = TextFrame::new(
            "t",
            None,
            paged_model::Bounds {
                top: 0.0,
                left: 0.0,
                bottom: 10.0,
                right: 10.0,
            },
        );
        f.minimum_first_baseline_offset = Some(30.0);
        f.first_baseline_offset = Some(FirstBaselineOffset::FixedHeight);
        assert_eq!(minimum_first_baseline(&f), Some(30.0));
        f.shrink_to_fit = Some(ShrinkToFit::new(0.5, 0.2));
        assert!((minimum_first_baseline(&f).unwrap() - 12.0).abs() < 1e-5);
        f.first_baseline_offset = Some(FirstBaselineOffset::AscentOffset);
        assert_eq!(minimum_first_baseline(&f), Some(30.0));
        assert!(chain_fit(&[&f, &f]).is_some());
        let mut g = f.clone();
        g.self_id = Some("u".into());
        assert!(chain_fit(&[&f, &g]).is_none());
    }
}
