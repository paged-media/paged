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

//! The layer stack's MASKING operations (image ADR 470): selection
//! changes as undo steps, the document's channels and paths, Quick Mask,
//! and painting a channel with the ordinary pixel tools.
//!
//! THE SELECTION ON THE UNDO LIST. The session selection lives in the
//! wasm realm (`selection.rs`), not in the stack; the stack keeps a
//! MIRROR of it (`MaskingState::live_selection`) that every structure
//! snapshot captures. A selection change is recorded as a structure step
//! whose only effect is the mirror ([`LayerStack::record_selection`]);
//! undoing any structure step restores the selection it was taken with
//! and raises `selection_dirty`, so the door copies it back. The mirror
//! is kept equal to the session selection: changes that are not steps (a
//! kept selection restored when an image reopens, a rebind) only sync it
//! ([`LayerStack::sync_selection`]).
//!
//! PAINTING A CHANNEL. With an edit channel chosen, the mask-target
//! hooks of the stack (`edit_target_is_mask`, `active_mask_as_grey`,
//! `edit_active_mask`, `composite_with_active_mask`) aim at the channel,
//! so every brush that can paint a layer mask paints the channel — the
//! stroke code does not know channels exist. Channel strokes are
//! journaled under their own scope bit and undo like any pixel step.

use std::sync::Arc;

use image_core::Region;
use image_gpu::coverage::SelectionCoverage;
use image_graph::journal::{FlatImage, RecordOutcome};

use super::{CanvasOp, LayerStack};
use crate::ingest::IngestError;
use crate::masking::{ChannelKind, DocChannel, MaskingDoc, SubPath};

/// A journal scope bit for channel strokes (the channel id below it);
/// layer pixels use the bare id and layer masks `MASK_SCOPE_BIT`.
pub(super) const CHANNEL_SCOPE_BIT: u64 = 1 << 33;

fn rot(p: [f32; 2], c: [f32; 2], degrees: f32, to: [f32; 2]) -> [f32; 2] {
    let (s, k) = degrees.to_radians().sin_cos();
    let (dx, dy) = (p[0] - c[0], p[1] - c[1]);
    [to[0] + dx * k - dy * s, to[1] + dx * s + dy * k]
}

/// Where a point (image px, on the continuous plane) lands under a
/// canvas op over a `w`×`h` canvas — what a path does when the canvas
/// turns, crops or resamples under it.
pub(super) fn map_point(op: CanvasOp, w: u32, h: u32, p: [f32; 2]) -> [f32; 2] {
    let (wf, hf) = (w as f32, h as f32);
    match op {
        CanvasOp::RotateCw => [hf - p[1], p[0]],
        CanvasOp::RotateCcw => [p[1], wf - p[0]],
        CanvasOp::Rotate180 => [wf - p[0], hf - p[1]],
        CanvasOp::FlipHorizontal => [wf - p[0], p[1]],
        CanvasOp::FlipVertical => [p[0], hf - p[1]],
        CanvasOp::Resize {
            width,
            height,
            anchor_x,
            anchor_y,
        } => {
            let off = |new: u32, old: u32, a: u8| -> f32 {
                ((i64::from(new) - i64::from(old)) * i64::from(a.min(2)) / 2) as f32
            };
            [
                p[0] + off(width, w, anchor_x),
                p[1] + off(height, h, anchor_y),
            ]
        }
        CanvasOp::Crop { x, y, .. } => [p[0] - x as f32, p[1] - y as f32],
        CanvasOp::Resample { width, height, .. } => [
            p[0] * width as f32 / wf.max(1.0),
            p[1] * height as f32 / hf.max(1.0),
        ],
        CanvasOp::Straighten {
            x,
            y,
            width,
            height,
            degrees,
        } => {
            let c = [
                x as f32 + width as f32 / 2.0,
                y as f32 + height as f32 / 2.0,
            ];
            let q = rot(p, c, -degrees, c);
            [q[0] - x as f32, q[1] - y as f32]
        }
        CanvasOp::RotateArbitrary { degrees } => {
            let (ow, oh) = super::rotated_bounds(w, h, degrees);
            rot(
                p,
                [wf / 2.0, hf / 2.0],
                degrees,
                [ow as f32 / 2.0, oh as f32 / 2.0],
            )
        }
        CanvasOp::Perspective {
            quad,
            width,
            height,
        } => match super::perspective_crop_maps(quad, width, height) {
            Some((forward, _)) => {
                let q = paged_warp::apply(&forward, (f64::from(p[0]), f64::from(p[1])));
                [q.0 as f32, q.1 as f32]
            }
            None => p,
        },
    }
}

fn err(e: String) -> IngestError {
    IngestError::Unsupported(e)
}

impl LayerStack {
    // ── the selection ───────────────────────────────────────────────

    /// The selection the undo list last saw.
    pub fn selection_mirror(&self) -> Option<&Arc<SelectionCoverage>> {
        self.masking.live_selection.as_ref()
    }

    /// Record a selection change as ONE undo step labelled `label`
    /// (consecutive changes with the same `merge_key` merge). `after` is
    /// the new selection (`None` = no selection).
    pub fn record_selection(
        &mut self,
        label: &str,
        merge_key: Option<&str>,
        after: Option<Arc<SelectionCoverage>>,
    ) {
        // `recorded` cannot fail here; its error type is the stack's.
        let _ = self.recorded(label, merge_key, |st| {
            st.masking.live_selection = after;
            Ok(())
        });
    }

    /// Keep the mirror equal to the session selection WITHOUT a step
    /// (a kept selection restored, a rebind that dropped it).
    pub fn sync_selection(&mut self, current: Option<Arc<SelectionCoverage>>) {
        self.masking.live_selection = current;
    }

    /// After an undo or redo: the selection to put back, when the step
    /// changed it (`Some(None)` = back to no selection).
    pub fn take_selection_change(&mut self) -> Option<Option<Arc<SelectionCoverage>>> {
        if std::mem::take(&mut self.masking.selection_dirty) {
            Some(self.masking.live_selection.clone())
        } else {
            None
        }
    }

    /// Restore a snapshot's selection (raising the dirty flag when it
    /// differs from the mirror).
    pub(super) fn restore_selection(&mut self, sel: Option<Arc<SelectionCoverage>>) {
        let same = match (&sel, &self.masking.live_selection) {
            (None, None) => true,
            (Some(a), Some(b)) => Arc::ptr_eq(a, b),
            _ => false,
        };
        if !same {
            self.masking.live_selection = sel;
            self.masking.selection_dirty = true;
        }
    }

    // ── channels and paths ──────────────────────────────────────────

    pub fn masking(&self) -> &MaskingDoc {
        &self.masking.doc
    }

    /// Change the channels / paths as one undo step.
    pub fn masking_edit<T>(
        &mut self,
        label: &str,
        f: impl FnOnce(&mut MaskingDoc, u32, u32) -> Result<T, String>,
    ) -> Result<T, IngestError> {
        let (w, h) = (self.width, self.height);
        self.recorded(label, None, |st| f(&mut st.masking.doc, w, h).map_err(err))
    }

    /// Replace the masking state wholesale WITHOUT a step (a stored
    /// session reopening).
    pub fn set_masking(&mut self, doc: MaskingDoc) {
        self.masking.doc = doc;
    }

    /// Save a selection (or everything, without one) as a new alpha
    /// channel. One step; answers the channel id.
    pub fn save_selection(
        &mut self,
        name: &str,
        selection: Option<&SelectionCoverage>,
    ) -> Result<u32, IngestError> {
        let data = selection
            .cloned()
            .unwrap_or_else(|| SelectionCoverage::full(self.width, self.height));
        self.check_size(&data)?;
        self.masking_edit("Save selection", |d, _, _| {
            Ok(d.add_channel(name, ChannelKind::Alpha, data))
        })
    }

    fn check_size(&self, c: &SelectionCoverage) -> Result<(), IngestError> {
        if c.width() != self.width || c.height() != self.height {
            return Err(IngestError::Decode(format!(
                "{}×{} coverage for a {}×{} canvas",
                c.width(),
                c.height(),
                self.width,
                self.height
            )));
        }
        Ok(())
    }

    /// A path from traced or drawn subpaths; one step, answers its id.
    pub fn add_path(&mut self, name: &str, subpaths: Vec<SubPath>) -> Result<u32, IngestError> {
        self.masking_edit("New path", |d, _, _| Ok(d.add_path(name, subpaths)))
    }

    // ── the channel edit target ─────────────────────────────────────

    /// The channel pixel tools paint, when one is chosen and exists.
    pub fn edit_channel(&self) -> Option<&DocChannel> {
        self.masking.doc.channel(self.masking.edit_channel?)
    }

    /// Paint a channel (`Some(id)`) or go back to the layers (`None`).
    pub fn set_edit_channel(&mut self, id: Option<u32>) -> Result<(), IngestError> {
        if let Some(id) = id {
            if self.masking.doc.channel(id).is_none() {
                return Err(err(format!("no channel {id}")));
            }
        }
        self.masking.edit_channel = id;
        self.masking.channel_preview = None;
        Ok(())
    }

    /// The channel stroke in flight, for the display view.
    pub fn channel_preview(&self) -> Option<&Arc<SelectionCoverage>> {
        self.masking.channel_preview.as_ref()
    }

    pub fn clear_channel_preview(&mut self) {
        self.masking.channel_preview = None;
    }

    /// The channel twin of `edit_active_mask`: journal the damaged tiles
    /// under the channel's scope, then take the new coverage.
    pub(super) fn edit_channel_data(
        &mut self,
        label: &str,
        damage: Region,
        data: SelectionCoverage,
    ) -> Result<RecordOutcome, IngestError> {
        let (w, h) = (self.width, self.height);
        let id = self
            .masking
            .edit_channel
            .ok_or_else(|| err("no channel is being edited".into()))?;
        let idx = self
            .masking
            .doc
            .channels
            .iter()
            .position(|c| c.id == id)
            .ok_or_else(|| err(format!("no channel {id}")))?;
        let clipped = damage
            .intersect(Region::new(0, 0, w, h))
            .unwrap_or(Region::new(0, 0, 0, 0));
        let outcome = {
            let old = &self.masking.doc.channels[idx].data;
            let view = FlatImage::new(w, h, 1, old.data())
                .ok_or_else(|| IngestError::Decode("channel is mis-sized".into()))?;
            let label = if self.masking.doc.channels[idx].kind == ChannelKind::QuickMask {
                "Paint Quick Mask"
            } else {
                label
            };
            self.journal
                .record(label, CHANNEL_SCOPE_BIT | u64::from(id), &view, clipped)
        };
        self.masking.doc.channels[idx].data = Arc::new(data);
        self.masking.channel_preview = None;
        if matches!(outcome, RecordOutcome::Recorded { .. }) {
            self.push_pixel_step();
        }
        self.sync_with_journal();
        Ok(outcome)
    }

    /// Replay one channel journal entry (the channel becomes the edit
    /// target, so the change is visibly where it happened).
    pub(super) fn apply_channel_entry(&mut self, id: u64, undo: bool) -> Option<String> {
        let (w, h) = (self.width, self.height);
        let idx = self
            .masking
            .doc
            .channels
            .iter()
            .position(|c| u64::from(c.id) == id)?;
        let mut buf = self.masking.doc.channels[idx].data.data().to_vec();
        let label = {
            let mut view = FlatImage::new(w, h, 1, buf.as_mut_slice())?;
            if undo {
                self.journal.undo(&mut view)
            } else {
                self.journal.redo(&mut view)
            }
        }?;
        self.masking.doc.channels[idx].data = Arc::new(SelectionCoverage::from_data(w, h, buf)?);
        self.masking.edit_channel = Some(id as u32);
        Some(label)
    }

    // ── Select and Mask output ──────────────────────────────────────

    /// Select and Mask ▸ Output to New Layer with Layer Mask: a copy of
    /// the active layer above it (its pixels replaced by `rgba`, the
    /// decontaminated colours, when given and the layer is 8-bit) masked
    /// by `mask`; the source is hidden, as Photoshop does. One step;
    /// answers the new layer's index.
    pub fn add_masked_copy(
        &mut self,
        rgba: Option<Arc<[u8]>>,
        mask: Arc<SelectionCoverage>,
    ) -> Result<usize, IngestError> {
        self.check_size(&mask)?;
        let src = self.active;
        self.recorded("Select and Mask", None, |st| {
            let at = st
                .duplicate(src)
                .ok_or_else(|| err(format!("no layer {src}")))?;
            if let Some(px) = rgba {
                let layer = &mut st.layers[at];
                let want = (st.width as usize) * (st.height as usize) * 4;
                if layer.rgba.depth() == image_core::SampleDepth::U8 && px.len() == want {
                    layer.rgba = crate::pixels::Pixels::from_rgba8(px).into();
                }
            }
            st.set_mask(at, mask)?;
            st.layers[src].visible = false;
            Ok(at)
        })
    }

    // ── Quick Mask ──────────────────────────────────────────────────

    /// Is Quick Mask on?
    pub fn quick_mask(&self) -> Option<u32> {
        self.masking.doc.quick_mask()
    }

    /// Enter Quick Mask: the selection (everything without one) becomes
    /// a temporary channel, which the pixel tools now paint. One step.
    pub fn enter_quick_mask(
        &mut self,
        selection: Option<&SelectionCoverage>,
    ) -> Result<u32, IngestError> {
        if let Some(id) = self.quick_mask() {
            self.masking.edit_channel = Some(id);
            return Ok(id);
        }
        let data = selection
            .cloned()
            .unwrap_or_else(|| SelectionCoverage::full(self.width, self.height));
        self.check_size(&data)?;
        let id = self.masking_edit("Enter Quick Mask", |d, _, _| {
            Ok(d.add_channel("", ChannelKind::QuickMask, data))
        })?;
        self.masking.edit_channel = Some(id);
        Ok(id)
    }

    /// Leave Quick Mask: the channel becomes the selection and goes away,
    /// as ONE step (undo brings the channel and the old selection back).
    /// Answers the new selection.
    pub fn exit_quick_mask(&mut self) -> Result<Arc<SelectionCoverage>, IngestError> {
        let id = self
            .quick_mask()
            .ok_or_else(|| err("Quick Mask is not on".into()))?;
        let data = Arc::clone(&self.masking.doc.channel(id).expect("found above").data);
        let sel = Arc::clone(&data);
        self.recorded("Exit Quick Mask", None, |st| {
            st.masking.doc.remove_channel(id).map_err(err)?;
            st.masking.live_selection = Some(sel);
            Ok(())
        })?;
        if self.masking.edit_channel == Some(id) {
            self.masking.edit_channel = None;
        }
        self.masking.channel_preview = None;
        Ok(data)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stack() -> LayerStack {
        LayerStack::from_image(4, 2, Arc::from(vec![9u8; 4 * 2 * 4])).unwrap()
    }

    fn rect() -> Arc<SelectionCoverage> {
        Arc::new(SelectionCoverage::rasterize_rect(4, 2, 0.0, 0.0, 2.0, 2.0))
    }

    #[test]
    #[allow(non_snake_case)]
    fn a_selection_change_is_one_undo_step__feat__image_selection_select_and_mask() {
        let mut s = stack();
        s.record_selection("Rectangular marquee", None, Some(rect()));
        assert_eq!(s.undo_label(), Some("Rectangular marquee"));
        assert!(
            s.take_selection_change().is_none(),
            "recording is not a change"
        );
        assert_eq!(s.undo().as_deref(), Some("Rectangular marquee"));
        assert_eq!(
            s.take_selection_change(),
            Some(None),
            "back to no selection"
        );
        assert_eq!(s.redo().as_deref(), Some("Rectangular marquee"));
        let back = s.take_selection_change().expect("redo changed it").unwrap();
        assert_eq!(back.data(), rect().data());
        // A structure step taken with a selection restores it on undo.
        let r = rect();
        s.sync_selection(Some(Arc::clone(&r)));
        s.recorded("New layer", None, |st| Ok(st.add("Layer 1")))
            .unwrap();
        s.sync_selection(None); // a rebind dropped it, no step
        s.undo();
        assert!(Arc::ptr_eq(
            &s.take_selection_change().unwrap().unwrap(),
            &r
        ));
        // Merge keys merge consecutive steps (a slider drag).
        let depth = s.history().depth;
        s.record_selection("Feather", Some("feather"), Some(rect()));
        s.record_selection("Feather", Some("feather"), None);
        assert_eq!(s.history().depth, depth + 1);
    }

    #[test]
    #[allow(non_snake_case)]
    fn channels_save_load_and_undo__feat__image_selection_select_and_mask() {
        let mut s = stack();
        let id = s.save_selection("", Some(&rect())).unwrap();
        assert_eq!(s.masking().channel(id).unwrap().name, "Alpha 1");
        assert_eq!(s.undo_label(), Some("Save selection"));
        s.masking_edit("Rename channel", |d, _, _| d.rename_channel(id, "Sky"))
            .unwrap();
        assert_eq!(s.masking().channel(id).unwrap().name, "Sky");
        s.undo();
        assert_eq!(s.masking().channel(id).unwrap().name, "Alpha 1");
        s.undo();
        assert!(s.masking().channels.is_empty());
        assert!(s
            .save_selection("", Some(&SelectionCoverage::full(3, 3)))
            .is_err());
        // Without a selection, Save Selection stores everything.
        let all = s.save_selection("", None).unwrap();
        assert!(s.masking().channel(all).unwrap().data.is_all_one());
    }

    #[test]
    #[allow(non_snake_case)]
    fn quick_mask_paints_a_channel_and_exits_to_the_selection__feat__image_selection_select_and_mask(
    ) {
        let mut s = stack();
        s.sync_selection(Some(rect()));
        let q = s.enter_quick_mask(Some(&rect())).unwrap();
        assert_eq!(s.quick_mask(), Some(q));
        assert!(s.edit_target_is_mask(), "the brushes now paint the channel");
        let grey = s.active_mask_as_grey().unwrap();
        assert_eq!(&grey[..4], &[255, 255, 255, 255]);
        // A "stroke": paint the right half selected too.
        let painted = SelectionCoverage::full(4, 2);
        s.edit_active_mask("Paint mask", Region::new(2, 0, 2, 2), painted)
            .unwrap();
        assert_eq!(s.undo_label(), Some("Paint Quick Mask"));
        assert!(s.masking().channel(q).unwrap().data.is_all_one());
        s.undo();
        assert_eq!(s.masking().channel(q).unwrap().data.data(), rect().data());
        s.redo();
        let sel = s.exit_quick_mask().unwrap();
        assert!(sel.is_all_one());
        assert_eq!(s.quick_mask(), None);
        assert!(!s.edit_target_is_mask());
        assert!(s.take_selection_change().is_none(), "the exit recorded it");
        // ONE undo brings the channel and the old selection back.
        s.undo();
        assert_eq!(s.quick_mask(), Some(q));
        let old = s.take_selection_change().unwrap().unwrap();
        assert_eq!(old.data(), rect().data());
        assert!(s.exit_quick_mask().is_ok());
        assert!(s.exit_quick_mask().is_err());
    }

    #[test]
    fn exact_canvas_ops_carry_channels_and_paths() {
        let mut s = stack();
        let id = s.save_selection("", Some(&rect())).unwrap();
        let p = s
            .add_path(
                "",
                vec![SubPath {
                    closed: true,
                    op: crate::masking::SubOp::COMBINE,
                    anchors: vec![crate::masking::PathAnchor::corner(1.0, 0.5)],
                }],
            )
            .unwrap();
        s.transform_canvas(CanvasOp::RotateCw).unwrap();
        let ch = s.masking().channel(id).unwrap();
        assert_eq!((ch.data.width(), ch.data.height()), (2, 4));
        // The left half of a 4×2 turned clockwise is the top half of 2×4.
        assert_eq!(ch.data.coverage_at(0, 0), 255);
        assert_eq!(ch.data.coverage_at(0, 3), 0);
        let a = s.masking().path(p).unwrap().subpaths[0].anchors[0].p;
        assert_eq!(a, [1.5, 1.0]);
        s.undo();
        assert_eq!(s.masking().channel(id).unwrap().data.width(), 4);
        assert_eq!(
            map_point(CanvasOp::FlipHorizontal, 4, 2, [1.0, 1.0]),
            [3.0, 1.0]
        );
        let q = map_point(
            CanvasOp::RotateArbitrary { degrees: 90.0 },
            4,
            2,
            [0.0, 0.0],
        );
        assert!((q[0] - 2.0).abs() < 1e-4 && q[1].abs() < 1e-4, "{q:?}");
    }

    #[test]
    #[allow(non_snake_case)]
    fn channels_and_paths_persist_with_the_layers__feat__image_selection_select_and_mask() {
        let mut s = stack();
        let id = s.save_selection("Sky", Some(&rect())).unwrap();
        s.add_path(
            "Outline",
            vec![SubPath {
                closed: true,
                op: crate::masking::SubOp::COMBINE,
                anchors: vec![crate::masking::PathAnchor::corner(0.0, 0.0)],
            }],
        )
        .unwrap();
        let (manifest, buffers) = s.export();
        let back = LayerStack::import(&manifest, &buffers).unwrap();
        assert_eq!(back.masking().channel(id).unwrap().name, "Sky");
        assert_eq!(
            back.masking().channel(id).unwrap().data.data(),
            rect().data()
        );
        assert_eq!(back.masking().paths[0].name, "Outline");
        // A stack without masking state writes the layer manifest alone.
        let (plain, _) = stack().export();
        assert!(!plain.windows(4).any(|w| w == b"PGMK"));
    }
}
