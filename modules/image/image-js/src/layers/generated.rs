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

//! The layer stack's verbs for GENERATED pixels (image ADR 485, WP8.2):
//! what a model answered — Generative Fill, Generate Image, Generative
//! Expand, Remove Background — lands as an ORDINARY layer or mask, so it
//! is saved in the parts like any other and undone in ONE step.
//!
//! The pixels come from the host's ML service (the `ml.*@1` doors); no
//! model and no runtime live in this crate. These verbs only take
//! canvas-extent buffers and record them.

use std::sync::Arc;

use image_gpu::coverage::SelectionCoverage;

use super::{CanvasOp, LayerStack};
use crate::ingest::IngestError;

fn coverage(w: u32, h: u32, mask: Vec<u8>) -> Result<Arc<SelectionCoverage>, IngestError> {
    let len = mask.len();
    SelectionCoverage::from_data(w, h, mask)
        .map(Arc::new)
        .ok_or_else(|| {
            IngestError::Decode(format!(
                "layer mask: {len} bytes for {w}×{h} (expected {})",
                w as usize * h as usize
            ))
        })
}

impl LayerStack {
    /// A new pixel layer directly above the active one holding `pixels`
    /// (canvas-extent straight RGBA8), with `mask` (canvas-extent
    /// coverage, one byte per pixel) as its layer mask when given; made
    /// active — ONE undo step labelled `label`. Generative Fill (the
    /// selection as the mask) and Generate Image (no mask).
    pub fn add_generated(
        &mut self,
        label: &str,
        name: &str,
        pixels: Arc<[u8]>,
        mask: Option<Vec<u8>>,
    ) -> Result<usize, IngestError> {
        self.check_canvas_pixels(&pixels)?;
        let (w, h) = (self.width, self.height);
        let mask = mask.map(|m| coverage(w, h, m)).transpose()?;
        self.recorded(label, None, |s| {
            let at = s.add(name);
            s.layers[at].rgba = crate::pixels::Pixels::from_rgba8(pixels).into();
            if let Some(m) = mask {
                s.layers[at].mask = Some(m.into());
                s.layers[at].mask_enabled = true;
            }
            Ok(at)
        })
    }

    /// GENERATIVE EXPAND: the canvas grows to `width`×`height` at the
    /// anchor (`0` left/top, `1` centre, `2` right/bottom, as Canvas
    /// Size), and a new layer holds `pixels` (straight RGBA8 at the NEW
    /// extent) masked by `mask` (the new border, at the new extent) —
    /// both in ONE undo step, so undo restores the old canvas and drops
    /// the layer at once. Refused when the canvas would not grow.
    #[allow(clippy::too_many_arguments)]
    pub fn expand_generated(
        &mut self,
        label: &str,
        name: &str,
        width: u32,
        height: u32,
        anchor_x: u8,
        anchor_y: u8,
        pixels: Arc<[u8]>,
        mask: Vec<u8>,
    ) -> Result<usize, IngestError> {
        let old = (self.width, self.height);
        if width < old.0 || height < old.1 || (width, height) == old {
            return Err(IngestError::Unsupported(format!(
                "Generative Expand grows the canvas: {width}×{height} is not larger than {}×{}",
                old.0, old.1
            )));
        }
        let want = width as usize * height as usize * 4;
        if pixels.len() != want {
            return Err(IngestError::Decode(format!(
                "expanded pixels: {} bytes for {width}×{height} (expected {want})",
                pixels.len()
            )));
        }
        let mask = coverage(width, height, mask)?;
        let op = CanvasOp::Resize {
            width,
            height,
            anchor_x: anchor_x.min(2),
            anchor_y: anchor_y.min(2),
        };
        self.check_canvas_op(op)?;
        self.recorded(label, None, move |s| {
            s.transform_canvas_unrecorded(op);
            s.after_canvas_op(op, old);
            let at = s.add(name);
            s.layers[at].rgba = crate::pixels::Pixels::from_rgba8(pixels).into();
            s.layers[at].mask = Some(mask.into());
            s.layers[at].mask_enabled = true;
            Ok(at)
        })
    }

    /// Give layer `index` the mask `mask` (canvas-extent coverage),
    /// replacing one it had — ONE undo step labelled `label`. Remove
    /// Background: the subject's alpha as the layer's mask, the pixels
    /// untouched.
    pub fn set_generated_mask(
        &mut self,
        label: &str,
        index: usize,
        mask: Vec<u8>,
    ) -> Result<(), IngestError> {
        let (w, h) = (self.width, self.height);
        let mask = coverage(w, h, mask)?;
        self.layer_mut(index)?;
        self.recorded(label, None, |s| s.set_mask(index, mask))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn px(w: u32, h: u32, v: u8) -> Arc<[u8]> {
        Arc::from(vec![v; (w * h * 4) as usize].into_boxed_slice())
    }

    #[test]
    #[allow(non_snake_case)]
    fn a_generated_layer_with_its_mask_is_one_undo_step__feat__image_ml_generative_fill() {
        let mut s = LayerStack::from_image(4, 2, px(4, 2, 200)).expect("stack");
        let mask = vec![0, 255, 255, 0, 0, 255, 255, 0];
        let at = s
            .add_generated(
                "Generative Fill",
                "a red door",
                px(4, 2, 9),
                Some(mask.clone()),
            )
            .expect("add");
        assert_eq!((s.len(), s.active_index(), at), (2, 1, 1));
        let l = &s.layers()[at];
        assert_eq!(l.name, "a red door");
        assert_eq!(&*l.rgba.to_rgba8(), &px(4, 2, 9)[..]);
        assert_eq!(l.mask.as_ref().expect("mask").canvas().data(), &mask[..]);
        assert!(l.mask_enabled);
        assert_eq!(s.undo_label(), Some("Generative Fill"));
        assert!(s.undo().is_some());
        assert_eq!(s.len(), 1, "one undo takes the layer and its mask back");
        // Without a mask: Generate Image.
        s.add_generated("Generate Image", "g", px(4, 2, 1), None)
            .expect("add");
        assert!(s.layers()[1].mask.is_none());
        // A mis-sized mask or buffer changes nothing.
        assert!(s
            .add_generated("x", "x", px(4, 2, 1), Some(vec![0; 3]))
            .is_err());
        assert!(s.add_generated("x", "x", px(2, 2, 1), None).is_err());
        assert_eq!(s.len(), 2);
    }

    #[test]
    #[allow(non_snake_case)]
    fn generative_expand_grows_the_canvas_and_adds_the_border_layer_in_one_step__feat__image_ml_generative_expand(
    ) {
        let mut s = LayerStack::from_image(2, 2, px(2, 2, 200)).expect("stack");
        // Grow to 4×2 to the right (anchor left): the old pixels stay at
        // x 0..2 and the new border is x 2..4.
        let mask: Vec<u8> = (0..8).map(|i| if i % 4 >= 2 { 255 } else { 0 }).collect();
        let at = s
            .expand_generated(
                "Generative Expand",
                "Expand",
                4,
                2,
                0,
                1,
                px(4, 2, 7),
                mask.clone(),
            )
            .expect("expand");
        assert_eq!((s.width(), s.height(), s.len(), at), (4, 2, 2, 1));
        let bg = s.layers()[0].rgba.to_rgba8();
        assert_eq!(&bg[0..4], &[200, 200, 200, 200]);
        assert_eq!(
            bg[2 * 4 + 3],
            0,
            "the added canvas is transparent on the old layer"
        );
        assert_eq!(
            s.layers()[1].mask.as_ref().expect("mask").canvas().data(),
            &mask[..]
        );
        assert_eq!(s.undo_label(), Some("Generative Expand"));
        assert!(s.undo().is_some());
        assert_eq!(
            (s.width(), s.height(), s.len()),
            (2, 2, 1),
            "one undo restores both"
        );
        // Not a growth: refused, nothing changes.
        assert!(s
            .expand_generated("x", "x", 2, 2, 1, 1, px(2, 2, 0), vec![0; 4])
            .is_err());
        assert!(s
            .expand_generated("x", "x", 1, 4, 1, 1, px(1, 4, 0), vec![0; 4])
            .is_err());
        assert_eq!((s.width(), s.len()), (2, 1));
    }

    #[test]
    #[allow(non_snake_case)]
    fn remove_background_sets_the_layer_mask_in_one_step__feat__image_ml_remove_background() {
        let mut s = LayerStack::from_image(2, 1, px(2, 1, 200)).expect("stack");
        s.set_generated_mask("Remove Background", 0, vec![255, 0])
            .expect("mask");
        assert_eq!(
            s.layers()[0].mask.as_ref().expect("mask").canvas().data(),
            &[255, 0]
        );
        assert_eq!(
            &*s.layers()[0].rgba.to_rgba8(),
            &px(2, 1, 200)[..],
            "pixels untouched"
        );
        assert!(s.undo().is_some());
        assert!(s.layers()[0].mask.is_none());
        assert!(s.set_generated_mask("x", 0, vec![1]).is_err());
        assert!(s.set_generated_mask("x", 5, vec![1, 2]).is_err());
    }
}
