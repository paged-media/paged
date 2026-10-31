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

//! SNAPSHOTS, the journal's bounds and PAST STATES (ADR 477).
//!
//! * A snapshot is the whole stack at one moment ([`super::Snapshot`],
//!   the same record a structure step holds). Layer pixels are shared
//!   `Arc`s and an edit REPLACES a layer's buffer, never writes through
//!   it, so taking one copies pointers; what it costs is the buffers the
//!   stack has replaced since, which [`LayerStack::snapshot_bytes`]
//!   counts. Taking a snapshot is not an undo step (Photoshop's rule);
//!   restoring one is ONE structure step, so a restore is undoable and
//!   the steps it went back over stay on the list.
//! * The journal's bounds are a preference: [`set_default_history_budget`]
//!   sets them for every stack opened from then on and
//!   [`LayerStack::set_history_budget`] for the open one. The structure
//!   list's bound rises with the depth.
//! * A past state of one layer, for the History brush: the layer right
//!   after any step on the undo or redo list ([`LayerStack::layer_after_step`]),
//!   read by walking a copy of the layer through the journal without
//!   moving it, or the layer in a snapshot.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use image_graph::journal::{FlatImage, JournalBudget, DEFAULT_MAX_BYTES, DEFAULT_MAX_ENTRIES};

use super::{LayerStack, Snapshot, Step, MAX_STRUCTURE_STEPS};
use crate::ingest::IngestError;
use crate::pixels::Pixels;

/// The most steps a preference may ask the journal to keep.
pub const MAX_HISTORY_DEPTH: usize = 1000;
/// The smallest and largest byte budget a preference may set.
pub const MIN_HISTORY_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_HISTORY_BYTES: usize = 2048 * 1024 * 1024;

static DEFAULT_ENTRIES: AtomicUsize = AtomicUsize::new(DEFAULT_MAX_ENTRIES);
static DEFAULT_BYTES: AtomicUsize = AtomicUsize::new(DEFAULT_MAX_BYTES);

/// Clamp a requested budget to what a preference may set.
pub fn clamp_budget(max_entries: usize, max_bytes: usize) -> JournalBudget {
    JournalBudget {
        max_entries: max_entries.clamp(1, MAX_HISTORY_DEPTH),
        max_bytes: max_bytes.clamp(MIN_HISTORY_BYTES, MAX_HISTORY_BYTES),
    }
}

/// The bounds a newly opened stack's journal takes.
pub fn default_budget() -> JournalBudget {
    JournalBudget {
        max_entries: DEFAULT_ENTRIES.load(Ordering::Relaxed),
        max_bytes: DEFAULT_BYTES.load(Ordering::Relaxed),
    }
}

/// Set the bounds every stack opened from now on starts with (clamped;
/// answers what was set).
pub fn set_default_history_budget(max_entries: usize, max_bytes: usize) -> JournalBudget {
    let b = clamp_budget(max_entries, max_bytes);
    DEFAULT_ENTRIES.store(b.max_entries, Ordering::Relaxed);
    DEFAULT_BYTES.store(b.max_bytes, Ordering::Relaxed);
    b
}

/// One named snapshot.
#[derive(Debug, Clone)]
pub(crate) struct NamedSnapshot {
    pub id: u32,
    pub name: String,
    state: Snapshot,
}

/// A snapshot as the panel lists it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnapshotInfo {
    pub id: u32,
    pub name: String,
    pub width: u32,
    pub height: u32,
}

impl LayerStack {
    pub(super) fn take_step_id(&mut self) -> u64 {
        let id = self.next_step_id;
        self.next_step_id += 1;
        id
    }

    /// Record a pixel step (its tiles are the journal's newest entry).
    pub(super) fn push_pixel_step(&mut self) {
        let id = self.take_step_id();
        self.steps.push(Step::Pixels { id });
        self.undone.clear();
    }

    /// The structure list keeps at least [`MAX_STRUCTURE_STEPS`], and as
    /// many as the journal's depth when that is set higher.
    pub(super) fn structure_step_bound(&self) -> usize {
        MAX_STRUCTURE_STEPS.max(self.journal.budget().max_entries)
    }

    /// Set this stack's journal bounds (clamped; answers what was set).
    /// A tighter bound drops the oldest steps at once, and says so in
    /// [`super::HistoryStats::dropped`].
    pub fn set_history_budget(&mut self, max_entries: usize, max_bytes: usize) -> JournalBudget {
        let b = clamp_budget(max_entries, max_bytes);
        self.journal.set_budget(b);
        self.sync_with_journal();
        self.enforce_step_bound();
        b
    }

    /// Every step's id, undo list oldest first, then the redo list next
    /// first (the orders of `undo_labels` / `redo_labels`).
    pub fn step_ids(&self) -> (Vec<u64>, Vec<u64>) {
        let id = |s: &Step| match s {
            Step::Pixels { id } | Step::Structure { id, .. } => *id,
        };
        (
            self.steps.iter().map(id).collect(),
            self.undone.iter().rev().map(id).collect(),
        )
    }

    // ── snapshots ───────────────────────────────────────────────────

    /// Name the current state. Not an undo step. Answers its id.
    pub fn take_snapshot(&mut self, name: &str) -> u32 {
        let id = self.next_snapshot_id;
        self.next_snapshot_id += 1;
        self.snapshots.push(NamedSnapshot {
            id,
            name: name.to_string(),
            state: self.snapshot(),
        });
        id
    }

    pub fn snapshots(&self) -> Vec<SnapshotInfo> {
        self.snapshots
            .iter()
            .map(|s| SnapshotInfo {
                id: s.id,
                name: s.name.clone(),
                width: s.state.width,
                height: s.state.height,
            })
            .collect()
    }

    fn snapshot_index(&self, id: u32) -> Result<usize, IngestError> {
        self.snapshots
            .iter()
            .position(|s| s.id == id)
            .ok_or_else(|| IngestError::Unsupported(format!("no snapshot {id}")))
    }

    /// Return the stack to snapshot `id` as ONE undo step labelled
    /// `label`; the snapshot stays.
    pub fn restore_snapshot(&mut self, id: u32, label: &str) -> Result<(), IngestError> {
        let state = self.snapshots[self.snapshot_index(id)?].state.clone();
        self.recorded(label, None, |st| {
            st.restore(state);
            if st.active >= st.layers.len() {
                st.active = st.layers.len().saturating_sub(1);
            }
            st.edit_mask = false;
            Ok(())
        })
    }

    pub fn rename_snapshot(&mut self, id: u32, name: &str) -> Result<(), IngestError> {
        let name = name.trim();
        if name.is_empty() {
            return Err(IngestError::Unsupported("a snapshot needs a name".into()));
        }
        let i = self.snapshot_index(id)?;
        self.snapshots[i].name = name.to_string();
        Ok(())
    }

    pub fn delete_snapshot(&mut self, id: u32) -> Result<(), IngestError> {
        let i = self.snapshot_index(id)?;
        self.snapshots.remove(i);
        Ok(())
    }

    /// The bytes the snapshots hold that nothing else does: each stored
    /// layer buffer once, leaving out the ones the current stack still
    /// uses (a snapshot of an unchanged layer costs nothing).
    pub fn snapshot_bytes(&self) -> usize {
        let mut seen: std::collections::HashSet<usize> =
            self.layers.iter().map(|l| l.rgba.storage_key()).collect();
        let mut bytes = 0usize;
        for s in &self.snapshots {
            for l in &s.state.layers {
                if seen.insert(l.rgba.storage_key()) {
                    bytes += l.rgba.stored_bytes();
                }
            }
        }
        bytes
    }

    // ── past states ─────────────────────────────────────────────────

    /// Layer `layer_id` in snapshot `id`, as canvas-extent RGBA8. `None`
    /// when the snapshot has no such layer or another canvas size.
    pub(super) fn layer_in_snapshot(&self, layer_id: u32, id: u32) -> Option<Arc<[u8]>> {
        let s = &self.snapshots.iter().find(|s| s.id == id)?.state;
        if (s.width, s.height) != (self.width, self.height) {
            return None;
        }
        let l = s
            .layers
            .iter()
            .find(|l| l.id == layer_id && l.is_pixels())?;
        Some(Arc::from(l.rgba.to_rgba8().into_owned().into_boxed_slice()))
    }

    /// Layer `layer_id` as it was right after step `step_id` (on the undo
    /// or the redo list), as canvas-extent RGBA8, computed on a copy: the
    /// journal and the stack do not move. `None` when no such step is
    /// held, the layer did not exist then, or the canvas had another size.
    pub(super) fn layer_after_step(&self, layer_id: u32, step_id: u64) -> Option<Arc<[u8]>> {
        let (undo_ids, redo_ids) = self.step_ids();
        let current = self.layers.iter().find(|l| l.id == layer_id)?;
        let mut cur: Option<Pixels> = Some(current.rgba.canvas().clone());
        let (mut w, mut h) = (self.width, self.height);
        if let Some(p) = undo_ids.iter().position(|&i| i == step_id) {
            // Walk back from the newest step down to p + 1. The journal's
            // undo entries line up with the pixel steps from the END
            // (older entries may be held past the step list's bound).
            let mut newer_pixels = 0usize;
            let held = self.journal.depth();
            for step in self.steps[p + 1..].iter().rev() {
                match step {
                    Step::Pixels { .. } => {
                        let ji = held.checked_sub(newer_pixels + 1)?;
                        newer_pixels += 1;
                        if self.journal.undo_scope_at(ji) == Some(u64::from(layer_id)) {
                            cur = Some(self.peek(cur?, w, h, |j, v| j.peek_undo_into(ji, v))?);
                        }
                    }
                    Step::Structure { other, .. } => {
                        (w, h) = (other.width, other.height);
                        cur = layer_px(other, layer_id);
                    }
                }
            }
        } else {
            let p = redo_ids.iter().position(|&i| i == step_id)?;
            // Walk forward through the redo list, next first, up to p.
            let mut pixels = 0usize;
            for step in self.undone.iter().rev().take(p + 1) {
                match step {
                    Step::Pixels { .. } => {
                        let ri = pixels;
                        pixels += 1;
                        if self.journal.redo_scope_at(ri) == Some(u64::from(layer_id)) {
                            cur = Some(self.peek(cur?, w, h, |j, v| j.peek_redo_into(ri, v))?);
                        }
                    }
                    Step::Structure { other, .. } => {
                        (w, h) = (other.width, other.height);
                        cur = layer_px(other, layer_id);
                    }
                }
            }
        }
        if (w, h) != (self.width, self.height) {
            return None;
        }
        let px = cur?;
        Some(Arc::from(px.to_rgba8().into_owned().into_boxed_slice()))
    }

    /// Apply one journal entry to a copy of `px`.
    fn peek(
        &self,
        px: Pixels,
        w: u32,
        h: u32,
        apply: impl FnOnce(&image_graph::journal::TileJournal, &mut FlatImage<&mut [u8]>) -> bool,
    ) -> Option<Pixels> {
        let depth = px.depth();
        let bpp = px.bytes_per_pixel();
        let mut buf = px.raw().to_vec();
        {
            let mut view = FlatImage::new(w, h, bpp, buf.as_mut_slice())?;
            if !apply(&self.journal, &mut view) {
                return None;
            }
        }
        Some(Pixels::from_raw(Arc::from(buf.into_boxed_slice()), depth))
    }
}

/// A pixel layer's canvas-extent pixels in a structure snapshot.
fn layer_px(s: &Snapshot, layer_id: u32) -> Option<Pixels> {
    s.layers
        .iter()
        .find(|l| l.id == layer_id && l.is_pixels())
        .map(|l| l.rgba.canvas().clone())
}

#[cfg(test)]
mod tests {
    use super::super::{HistoryKind, LayerStack};
    use image_core::Region;
    use std::sync::Arc;

    fn px(w: u32, h: u32, v: u8) -> Arc<[u8]> {
        Arc::from(vec![v; (w * h * 4) as usize].into_boxed_slice())
    }

    fn paint(s: &mut LayerStack, v: u8) {
        let (w, h) = (s.width(), s.height());
        s.edit_active("Paint", Region::new(0, 0, w, h), px(w, h, v).into())
            .expect("paint");
    }

    fn active(s: &LayerStack) -> Vec<u8> {
        s.active().rgba.to_rgba8().into_owned()
    }

    #[test]
    #[allow(non_snake_case)]
    fn a_snapshot_restores_as_one_undoable_step__feat__image_editor_snapshots_presets() {
        let mut s = LayerStack::from_image(4, 4, px(4, 4, 10)).expect("stack");
        let opened = s.take_snapshot("Opened");
        assert!(s.undo_labels().is_empty(), "taking one is not a step");
        paint(&mut s, 50);
        s.recorded("New layer", None, |st| Ok(st.add("B")))
            .expect("add");
        let two = s.take_snapshot("Two layers");
        paint(&mut s, 90);
        assert_eq!(s.snapshots().len(), 2);

        s.restore_snapshot(opened, "Restore Opened")
            .expect("restore");
        assert_eq!(s.len(), 1);
        assert_eq!(active(&s), vec![10; 64]);
        assert_eq!(s.undo_labels().last().copied(), Some("Restore Opened"));
        // One undo returns to where the user was.
        assert_eq!(s.undo().as_deref(), Some("Restore Opened"));
        assert_eq!(s.len(), 2);
        assert_eq!(active(&s), vec![90; 64]);

        s.restore_snapshot(two, "Restore").expect("restore");
        assert_eq!(s.len(), 2);
        assert_eq!(active(&s), vec![0; 64], "the new layer, empty, is active");

        s.rename_snapshot(two, "Mine").expect("rename");
        assert!(s.rename_snapshot(two, "  ").is_err());
        assert_eq!(s.snapshots()[1].name, "Mine");
        s.delete_snapshot(opened).expect("delete");
        assert_eq!(s.snapshots().len(), 1);
        assert!(s.restore_snapshot(opened, "x").is_err(), "gone");
    }

    #[test]
    #[allow(non_snake_case)]
    fn snapshot_memory_counts_only_buffers_nothing_else_holds__feat__image_editor_snapshots_presets(
    ) {
        let mut s = LayerStack::from_image(8, 8, px(8, 8, 10)).expect("stack");
        s.take_snapshot("A");
        assert_eq!(s.snapshot_bytes(), 0, "the layer is still the current one");
        paint(&mut s, 20);
        assert_eq!(s.snapshot_bytes(), 8 * 8 * 4, "the replaced buffer");
        s.take_snapshot("B");
        assert_eq!(s.snapshot_bytes(), 8 * 8 * 4, "B shares the current layer");
    }

    #[test]
    #[allow(non_snake_case)]
    fn the_history_brush_reads_the_layer_after_any_step__feat__image_editor_snapshots_presets() {
        let mut s = LayerStack::from_image(4, 4, px(4, 4, 10)).expect("stack");
        paint(&mut s, 20);
        s.recorded("Layer opacity", None, |st| st.set_opacity(0, 0.5))
            .expect("opacity");
        paint(&mut s, 30);
        paint(&mut s, 40);
        let (undo, _) = s.step_ids();
        assert_eq!(undo.len(), 4);
        let at = |s: &LayerStack, id: u64| s.history_source(HistoryKind::Step(id)).map(|p| p[0]);
        assert_eq!(at(&s, undo[0]), Some(20));
        assert_eq!(
            at(&s, undo[1]),
            Some(20),
            "a structure step keeps the pixels"
        );
        assert_eq!(at(&s, undo[2]), Some(30));
        assert_eq!(at(&s, undo[3]), Some(40), "the newest step is now");
        assert_eq!(s.history().depth, 4, "nothing moved");
        assert_eq!(active(&s)[0], 40);

        // Redo steps read forward.
        s.undo();
        s.undo();
        let (_, redo) = s.step_ids();
        assert_eq!(redo, vec![undo[2], undo[3]], "ids survive undo");
        assert_eq!(at(&s, redo[0]), Some(30));
        assert_eq!(at(&s, redo[1]), Some(40));
        assert_eq!(at(&s, undo[0]), Some(20));
        assert_eq!(at(&s, 999), None, "an unknown step");

        // A snapshot is a source too.
        let snap = s.take_snapshot("S");
        paint(&mut s, 70);
        assert_eq!(
            s.history_source(HistoryKind::Snapshot(snap)).map(|p| p[0]),
            Some(20)
        );
        assert_eq!(HistoryKind::from_wire("step:7"), Some(HistoryKind::Step(7)));
        assert_eq!(
            HistoryKind::from_wire("snapshot:3"),
            Some(HistoryKind::Snapshot(3))
        );
        assert_eq!(HistoryKind::from_wire("step:x"), None);
    }

    #[test]
    #[allow(non_snake_case)]
    fn a_state_from_another_canvas_size_is_refused__feat__image_editor_snapshots_presets() {
        let mut s = LayerStack::from_image(4, 2, px(4, 2, 10)).expect("stack");
        paint(&mut s, 20);
        let snap = s.take_snapshot("S");
        let (undo, _) = s.step_ids();
        s.transform_canvas(super::super::CanvasOp::RotateCw)
            .expect("rotate");
        assert_eq!((s.width(), s.height()), (2, 4));
        assert_eq!(s.history_source(HistoryKind::Step(undo[0])), None);
        assert_eq!(s.history_source(HistoryKind::Snapshot(snap)), None);
    }

    #[test]
    #[allow(non_snake_case)]
    fn the_depth_preference_raises_the_32_step_cap__feat__image_editor_snapshots_presets() {
        let mut s = LayerStack::from_image(4, 4, px(4, 4, 10)).expect("stack");
        for v in 0..40u8 {
            paint(&mut s, v);
        }
        assert_eq!(s.history().depth, 32, "the default journal depth");
        let b = s.set_history_budget(100, 64 * 1024 * 1024);
        assert_eq!(b.max_entries, 100);
        for v in 0..60u8 {
            paint(&mut s, v);
        }
        assert_eq!(s.history().depth, 92);
        assert_eq!(s.history().max_entries, 100);
        s.set_history_budget(5, 64 * 1024 * 1024);
        assert_eq!(s.history().depth, 5, "a tighter bound drops at once");
        assert_eq!(
            s.undo_labels().len(),
            5,
            "the step list follows the journal"
        );
        assert_eq!(super::clamp_budget(0, 0).max_entries, 1);
        assert_eq!(
            super::clamp_budget(5000, usize::MAX).max_entries,
            super::MAX_HISTORY_DEPTH
        );
    }
}
