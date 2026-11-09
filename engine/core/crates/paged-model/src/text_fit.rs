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

//! A text frame shrinks its text to fit (engine ADR 1061): PowerPoint's
//! `a:normAutofit`.
//!
//! The frame's story holds its text at the sizes it was written in. The
//! frame names the fit to start from (the one the authoring application last
//! computed and saved, `fontScale` / `lnSpcReduction`); the renderer sets the
//! text at that fit and, when the text no longer fits the frame, steps down
//! [`SHRINK_STEPS`] until it does. The scale is a layout result: nothing in
//! the story changes.

use serde::{Deserialize, Serialize};

/// The fit of a shrink-to-fit frame: every point size times `font_scale`,
/// every line's leading times `font_scale × (1 − line_spacing_reduction)`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct ShrinkToFit {
    /// Fraction of the written size the text is set at (PowerPoint
    /// `fontScale` / 100 000), in `(0, 1]`.
    pub font_scale: f32,
    /// Fraction the line spacing is reduced by (PowerPoint
    /// `lnSpcReduction` / 100 000), in `[0, 1)`.
    pub line_spacing_reduction: f32,
}

impl Default for ShrinkToFit {
    fn default() -> Self {
        Self::NONE
    }
}

/// The steps the renderer shrinks through, largest first: the values
/// PowerPoint writes (line spacing reduced by 10 % and then 20 %, then
/// the size in steps of 7.5 %, down to 25 %).
pub const SHRINK_STEPS: &[ShrinkToFit] = &[
    ShrinkToFit::new(1.0, 0.0),
    ShrinkToFit::new(1.0, 0.1),
    ShrinkToFit::new(1.0, 0.2),
    ShrinkToFit::new(0.925, 0.2),
    ShrinkToFit::new(0.85, 0.2),
    ShrinkToFit::new(0.775, 0.2),
    ShrinkToFit::new(0.7, 0.2),
    ShrinkToFit::new(0.625, 0.2),
    ShrinkToFit::new(0.55, 0.2),
    ShrinkToFit::new(0.475, 0.2),
    ShrinkToFit::new(0.4, 0.2),
    ShrinkToFit::new(0.325, 0.2),
    ShrinkToFit::new(0.25, 0.2),
];

const EPS: f32 = 1e-4;

impl ShrinkToFit {
    /// The text as written: no shrink.
    pub const NONE: ShrinkToFit = ShrinkToFit::new(1.0, 0.0);

    pub const fn new(font_scale: f32, line_spacing_reduction: f32) -> Self {
        Self {
            font_scale,
            line_spacing_reduction,
        }
    }

    /// The fit with both values clamped to their ranges (a scale of 0 or
    /// below reads as none, as PowerPoint reads a missing `fontScale`).
    pub fn clamped(self) -> Self {
        let font_scale = if self.font_scale.is_finite() && self.font_scale > 0.0 {
            self.font_scale.min(1.0)
        } else {
            1.0
        };
        let line_spacing_reduction = if self.line_spacing_reduction.is_finite() {
            self.line_spacing_reduction.clamp(0.0, 0.9)
        } else {
            0.0
        };
        Self::new(font_scale, line_spacing_reduction)
    }

    /// True when it changes nothing.
    pub fn is_none(&self) -> bool {
        (self.font_scale - 1.0).abs() < EPS && self.line_spacing_reduction.abs() < EPS
    }

    /// What a line's leading is multiplied by.
    pub fn line_factor(&self) -> f32 {
        self.font_scale * (1.0 - self.line_spacing_reduction)
    }

    /// True when `self` sets the text smaller than `other`: a smaller size,
    /// or the same size with more line spacing taken away.
    pub fn is_below(&self, other: &ShrinkToFit) -> bool {
        self.font_scale < other.font_scale - EPS
            || ((self.font_scale - other.font_scale).abs() < EPS
                && self.line_spacing_reduction > other.line_spacing_reduction + EPS)
    }

    /// The steps of [`SHRINK_STEPS`] below `self`, largest first.
    pub fn steps_below(self) -> impl Iterator<Item = ShrinkToFit> {
        SHRINK_STEPS
            .iter()
            .copied()
            .filter(move |s| s.is_below(&self))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn steps_below_a_saved_fit_go_down_from_it() {
        let saved = ShrinkToFit::new(0.925, 0.1);
        let below: Vec<_> = saved.steps_below().collect();
        assert_eq!(below[0], ShrinkToFit::new(0.925, 0.2));
        assert_eq!(below[1], ShrinkToFit::new(0.85, 0.2));
        assert_eq!(*below.last().unwrap(), ShrinkToFit::new(0.25, 0.2));
        assert!(ShrinkToFit::new(0.25, 0.2).steps_below().next().is_none());
        assert_eq!(
            ShrinkToFit::NONE.steps_below().count(),
            SHRINK_STEPS.len() - 1
        );
    }

    #[test]
    fn clamped_reads_a_missing_scale_as_none() {
        assert!(ShrinkToFit::new(0.0, 0.0).clamped().is_none());
        assert_eq!(ShrinkToFit::new(1.5, -1.0).clamped(), ShrinkToFit::NONE);
        let f = ShrinkToFit::new(0.4, 0.2);
        assert!((f.line_factor() - 0.32).abs() < 1e-6);
    }
}
