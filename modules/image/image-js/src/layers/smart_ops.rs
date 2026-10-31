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

//! The layer stack's SMART-OBJECT verbs (image ADR 482): transform,
//! smart filters and their mask, replacing or relinking the source, and
//! a new smart layer from pixels or page items.
//!
//! Each verb is ONE structure undo step. The smart filters' GPU pass that
//! may follow a verb lands with [`LayerStack::smart_land_filters`], which
//! records nothing: it finishes the step the verb opened, so undo goes
//! back over both at once.

use std::sync::Arc;

use super::{Layer, LayerKind, LayerStack, SmartSource};
use crate::ingest::IngestError;
use crate::smart::{Quad, SmartFile, SmartFilterStack};

fn refuse(msg: impl Into<String>) -> IngestError {
    IngestError::Unsupported(msg.into())
}

fn smart_of(l: &mut Layer) -> Result<&mut SmartSource, IngestError> {
    let name = l.name.clone();
    match &mut l.kind {
        LayerKind::Smart(s) => Ok(s),
        _ => Err(refuse(format!("layer \"{name}\" is not a smart object"))),
    }
}

impl LayerStack {
    /// A counter that moves with every structure change: whether a stack
    /// has been edited since a moment (Edit Contents' "unchanged").
    pub fn structure_generation(&self) -> u64 {
        self.structure_generation
    }

    /// Make the layers a PSD import read from smart-object records SMART
    /// OBJECTS (ADR 482): each keeps the render Photoshop stored as its
    /// pixels and gains its source (the embedded or linked file), its
    /// placement and its smart filters, so a transform, a filter edit or
    /// Edit Contents re-renders it. Answers a note per object that keeps
    /// its stored render for good (a warp, an unknown filter, a source not
    /// in the file).
    pub fn adopt_psd_smart_objects(&mut self, file: &image_psd::PsdFile) -> Vec<String> {
        let files = crate::smart::psd_linked_files(file);
        let effects = crate::smart::psd_filter_effects(file);
        let (w, h) = (self.width, self.height);
        let mut notes = Vec::new();
        for l in &mut self.layers {
            if !matches!(l.kind, LayerKind::Pixels) {
                continue;
            }
            let Some(rec) = l.ext.source.as_ref().map(|s| &s.record) else {
                continue;
            };
            let Some(placed) = crate::smart::placed_layer(rec, file.container) else {
                continue;
            };
            let imported = crate::smart::import_smart(&placed, &files, effects.as_ref(), w, h);
            if let Some(n) = imported.note {
                notes.push(format!("\"{}\": {n}", l.name));
            }
            let record = rec.clone();
            // Photoshop stores a filtered object's channels BEFORE its
            // filter mask and draws them through the mask over the
            // unfiltered render it caches (FEid) [OBS]: the layer shows
            // that mix.
            let masked = imported
                .source
                .filters
                .as_deref()
                .filter(|f| f.mask_enabled && f.enabled)
                .and_then(|f| f.mask.clone());
            if let (Some(mask), Some(fx), Some(placed_id)) =
                (masked, effects.as_ref(), placed.placed_id())
            {
                if let Some(base) = crate::smart::fx_base(fx, placed_id, w, h) {
                    let stored = l.rgba.to_rgba8().into_owned();
                    let shown = crate::smart::through_filter_mask(&base, &stored, Some(&mask), w);
                    l.rgba = crate::pixels::Pixels::from_rgba8(Arc::from(shown.into_boxed_slice()))
                        .into();
                }
            }
            l.kind = LayerKind::Smart(Box::new(imported.source));
            // The layer as imported is now a smart object: the save
            // compares against that (ADR 478).
            crate::psd_source::attach(l, &record);
        }
        notes
    }

    /// Draw every smart object that can be drawn without its filters'
    /// GPU pass from its source, in place (no undo step: the import's
    /// stale-render recovery). Answers how many were drawn.
    pub fn rerender_smart_objects(&mut self) -> usize {
        let (w, h) = (self.width, self.height);
        let mut n = 0;
        for l in &mut self.layers {
            let ok = l.smart_source().is_some_and(|s| {
                !s.warped
                    && s.live_filters().is_none()
                    && s.file.as_ref().is_none_or(|f| f.is_available())
            });
            if ok && crate::smart::rerender(l, w, h).is_ok() {
                n += 1;
            }
        }
        n
    }

    fn smart_target(&mut self, index: usize) -> Result<&mut Layer, IngestError> {
        let l = self
            .layers
            .get_mut(index)
            .ok_or_else(|| refuse(format!("no layer {index}")))?;
        smart_of(l)?;
        Ok(l)
    }

    /// TRANSFORM a smart object: place its source on `quad` (its four
    /// corners, top-left first) and re-render from the source. One undo
    /// step. Answers whether its smart filters still have to run.
    pub fn smart_place(&mut self, index: usize, quad: Quad) -> Result<bool, IngestError> {
        if quad.iter().any(|v| !v.is_finite()) {
            return Err(refuse("the placement's corners must be finite"));
        }
        {
            let l = self.smart_target(index)?;
            l.position_editable()?;
        }
        let (w, h) = (self.width, self.height);
        self.recorded("Transform smart object", None, |s| {
            let l = &mut s.layers[index];
            let src = smart_of(l)?;
            src.placement = Some(quad);
            // A re-placed object is drawn by paged: a kept warp is gone.
            src.warped = false;
            crate::smart::rerender(l, w, h)?;
            Ok(smart_of(l)?.pending_filters)
        })
    }

    /// The smart objects whose filters still have to run, bottom first.
    pub fn smart_pending(&self) -> Vec<usize> {
        self.layers
            .iter()
            .enumerate()
            .filter(|(_, l)| l.smart_source().is_some_and(|s| s.pending_filters))
            .map(|(i, _)| i)
            .collect()
    }

    /// The UNFILTERED render of smart object `index`, canvas-sized
    /// straight RGBA8: what its filters run over.
    pub fn smart_base(&self, index: usize) -> Result<Vec<u8>, IngestError> {
        let l = self
            .layers
            .get(index)
            .ok_or_else(|| refuse(format!("no layer {index}")))?;
        let src = l
            .smart_source()
            .ok_or_else(|| refuse(format!("layer \"{}\" is not a smart object", l.name)))?;
        if src.warped {
            return Err(refuse(format!(
                "the smart object \"{}\" is warped, which paged does not draw",
                l.name
            )));
        }
        let raster = src.raster()?;
        let px = crate::smart::render_placed(&raster, &src.quad(), self.width, self.height)?;
        Ok(px.to_rgba8().into_owned())
    }

    /// LAND the filters' result: `filtered` (canvas-sized RGBA8, the
    /// stack run over [`smart_base`](Self::smart_base)) through the filter
    /// mask becomes the layer's pixels. Records nothing (see the module
    /// docs).
    pub fn smart_land_filters(
        &mut self,
        index: usize,
        base: &[u8],
        filtered: &[u8],
    ) -> Result<(), IngestError> {
        let (w, h) = (self.width, self.height);
        let want = w as usize * h as usize * 4;
        if base.len() != want || filtered.len() != want {
            return Err(refuse(format!(
                "a smart-filter result must be {w}×{h} RGBA8"
            )));
        }
        let l = self.smart_target(index)?;
        let src = smart_of(l)?;
        let mask = src
            .filters
            .as_deref()
            .filter(|f| f.mask_enabled)
            .and_then(|f| f.mask.clone());
        let out = crate::smart::through_filter_mask(base, filtered, mask.as_ref(), w);
        src.pending_filters = false;
        l.rgba = crate::pixels::Pixels::from_rgba8(Arc::from(out.into_boxed_slice())).into();
        self.structure_generation += 1;
        Ok(())
    }

    /// SET the smart filters of `index` (the list, the switches, the
    /// mask; Filter ▸ any filter on a smart object adds one, the panel
    /// edits, switches, reorders and deletes them). One undo step; the
    /// filters then run (pending) — or, when none draws, the layer is
    /// its unfiltered render at once.
    pub fn smart_set_filters(
        &mut self,
        label: &str,
        index: usize,
        stack: SmartFilterStack,
    ) -> Result<bool, IngestError> {
        let l = self.smart_target(index)?;
        l.pixels_editable()?;
        let (w, h) = (self.width, self.height);
        self.recorded(label, None, |s| {
            let l = &mut s.layers[index];
            let src = smart_of(l)?;
            src.filters =
                (!stack.filters.is_empty() || stack.mask.is_some()).then(|| Arc::new(stack));
            if src.warped {
                // Photoshop's render is all there is: it stays.
                src.pending_filters = false;
                return Ok(false);
            }
            crate::smart::rerender(l, w, h)?;
            Ok(smart_of(l)?.pending_filters)
        })
    }

    /// REPLACE the source of `index` with `file` (Replace Contents,
    /// Relink, Update Modified Content, a saved Edit Contents). The
    /// placement keeps its corners when the source keeps its size; a
    /// source of another size is placed at the same scale about the same
    /// first corner, as Photoshop does. One undo step.
    pub fn smart_replace_source(
        &mut self,
        label: &str,
        index: usize,
        file: SmartFile,
    ) -> Result<bool, IngestError> {
        let raster = file.raster()?;
        let file = Arc::new(file);
        let (w, h) = (self.width, self.height);
        {
            let l = self.smart_target(index)?;
            l.pixels_editable()?;
        }
        self.recorded(label, None, |s| {
            let l = &mut s.layers[index];
            let src = smart_of(l)?;
            if (src.width, src.height) != (raster.width, raster.height)
                && src.width > 0
                && src.height > 0
            {
                let q = src.quad();
                let (sx, sy) = (
                    f64::from(raster.width) / f64::from(src.width),
                    f64::from(raster.height) / f64::from(src.height),
                );
                // The corners move along the old edges by the new size.
                let (ox, oy) = (q[0], q[1]);
                let edge = |i: usize, k: f64, kk: f64| {
                    let (ux, uy) = (q[2] - ox, q[3] - oy);
                    let (vx, vy) = (q[6] - ox, q[7] - oy);
                    let (a, b) = match i {
                        1 => (k, 0.0),
                        2 => (k, kk),
                        3 => (0.0, kk),
                        _ => (0.0, 0.0),
                    };
                    (ox + ux * a + vx * b, oy + uy * a + vy * b)
                };
                let mut nq = q;
                for i in 1..4 {
                    let (x, y) = edge(i, sx, sy);
                    nq[2 * i] = x;
                    nq[2 * i + 1] = y;
                }
                src.placement = Some(nq);
            } else if src.placement.is_none() {
                src.placement = Some(src.quad());
            }
            src.width = raster.width;
            src.height = raster.height;
            src.rgba = Arc::from(Vec::new());
            src.file = Some(file);
            src.vector = None;
            src.warped = false;
            crate::smart::rerender(l, w, h)?;
            Ok(smart_of(l)?.pending_filters)
        })
    }

    /// A NEW smart layer above the active one: `source` placed on its
    /// quad and rendered. One undo step; the new layer is active.
    pub fn add_smart_layer(
        &mut self,
        label: &str,
        name: &str,
        source: SmartSource,
    ) -> Result<usize, IngestError> {
        let (w, h) = (self.width, self.height);
        // Render first: a source that cannot draw records nothing.
        let mut probe = Layer {
            kind: LayerKind::Smart(Box::new(source)),
            ..self.layers[self.active].clone()
        };
        crate::smart::rerender(&mut probe, w, h)?;
        self.recorded(label, None, |s| {
            let at = s.add(name);
            s.layers[at].rgba = probe.rgba;
            s.layers[at].kind = probe.kind;
            Ok(at)
        })
    }

    /// Re-rasterize a VECTOR smart object: the host drew its items again
    /// at `px_per_pt` (because the placement grew past what the source
    /// held). The placement stays; one undo step merged into the scale
    /// that asked for it (`merge_key`).
    pub fn smart_vector_source(
        &mut self,
        index: usize,
        rgba: Arc<[u8]>,
        width: u32,
        height: u32,
        px_per_pt: f64,
    ) -> Result<bool, IngestError> {
        if rgba.len() != width as usize * height as usize * 4 || width == 0 || height == 0 {
            return Err(refuse(
                "a vector smart object's source must be width×height RGBA8",
            ));
        }
        let (w, h) = (self.width, self.height);
        {
            let l = self.smart_target(index)?;
            let src = smart_of(l)?;
            if src.vector.is_none() {
                return Err(refuse(format!(
                    "layer \"{}\" is not a vector smart object",
                    l.name
                )));
            }
        }
        self.recorded("Transform smart object", Some("smart-vector"), |s| {
            let l = &mut s.layers[index];
            let src = smart_of(l)?;
            let q = src.quad();
            src.rgba = rgba;
            src.width = width;
            src.height = height;
            if let Some(v) = &mut src.vector {
                Arc::make_mut(v).px_per_pt = px_per_pt;
            }
            src.placement = Some(q);
            crate::smart::rerender(l, w, h)?;
            Ok(smart_of(l)?.pending_filters)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::smart::{rect_quad, SmartFilterEntry};

    fn px(w: u32, h: u32, v: u8) -> Arc<[u8]> {
        Arc::from(vec![v; (w * h * 4) as usize].into_boxed_slice())
    }

    fn stack_with_square() -> LayerStack {
        let mut s = LayerStack::from_image(16, 16, px(16, 16, 0)).expect("stack");
        let mut sq = vec![0u8; 16 * 16 * 4];
        for y in 4..12 {
            for x in 4..12 {
                let i = (y * 16 + x) * 4;
                sq[i..i + 4].copy_from_slice(&[200, 40, 40, 255]);
            }
        }
        s.add_with_pixels("Add", "square", Arc::from(sq.into_boxed_slice()))
            .expect("add");
        s
    }

    #[test]
    #[allow(non_snake_case)]
    fn converting_takes_the_pixels_own_extent_as_the_source__feat__image_layers_smart_objects_full()
    {
        let mut s = stack_with_square();
        s.make_smart(1).expect("smart");
        let src = s.layers()[1].smart_source().expect("source");
        assert_eq!((src.width, src.height), (8, 8));
        assert_eq!(src.placement, Some(rect_quad(4.0, 4.0, 8.0, 8.0)));
    }

    #[test]
    #[allow(non_snake_case)]
    fn a_transform_is_one_step_and_re_renders_from_the_source__feat__image_layers_smart_objects_full(
    ) {
        let mut s = stack_with_square();
        s.make_smart(1).expect("smart");
        let before = s.layers()[1].rgba.to_rgba8().into_owned();
        // Down to a quarter, then back: the source draws it again.
        s.smart_place(1, rect_quad(4.0, 4.0, 2.0, 2.0))
            .expect("small");
        s.smart_place(1, rect_quad(4.0, 4.0, 8.0, 8.0))
            .expect("back");
        assert_eq!(&*s.layers()[1].rgba.to_rgba8(), &before[..]);
        assert_eq!(s.undo_label(), Some("Transform smart object"));
        s.undo();
        let small = s.layers()[1].rgba.to_rgba8().into_owned();
        assert_ne!(small, before);
        s.undo();
        assert_eq!(&*s.layers()[1].rgba.to_rgba8(), &before[..]);
    }

    #[test]
    #[allow(non_snake_case)]
    fn filters_are_pending_until_landed_and_land_through_the_mask__feat__image_layers_smart_objects_full(
    ) {
        let mut s = stack_with_square();
        s.make_smart(1).expect("smart");
        let stack = SmartFilterStack {
            filters: vec![SmartFilterEntry {
                id: "gaussianBlur".into(),
                values: r#"{"radius":2}"#.into(),
                name: "Gaussian Blur".into(),
                enabled: true,
                opacity: 1.0,
                mode: "normal".into(),
                psd: None,
            }],
            ..Default::default()
        };
        assert!(s.smart_set_filters("Smart Filters", 1, stack).expect("set"));
        assert_eq!(s.smart_pending(), vec![1]);
        let base = s.smart_base(1).expect("base");
        let filtered = vec![7u8; base.len()];
        s.smart_land_filters(1, &base, &filtered).expect("land");
        assert!(s.smart_pending().is_empty());
        assert_eq!(&s.layers()[1].rgba.to_rgba8()[..4], &[7, 7, 7, 7]);
        // One undo takes the filters and their render back.
        s.undo();
        assert!(s.layers()[1].smart_source().unwrap().filters.is_none());
        assert_eq!(s.layers()[1].rgba.to_rgba8()[(5 * 16 + 5) * 4], 200);
    }

    #[test]
    #[allow(non_snake_case)]
    fn a_smart_object_is_not_painted_on_nor_merged_into__feat__image_layers_smart_objects_full() {
        let mut s = stack_with_square();
        s.make_smart(1).expect("smart");
        s.set_active(1).expect("active");
        let err = s
            .edit_active(
                "Brush",
                image_core::Region::new(0, 0, 16, 16),
                crate::pixels::Pixels::from_rgba8(px(16, 16, 9)),
            )
            .expect_err("refused");
        assert!(err.to_string().contains("not directly editable"), "{err}");
    }

    #[test]
    fn replacing_the_source_keeps_the_scale_about_the_first_corner() {
        let mut s = stack_with_square();
        s.make_smart(1).expect("smart");
        let file = SmartFile::new("u", "new.png", *b"png ", Arc::from(Vec::new()), None)
            .with_raster(crate::smart::SourceRaster {
                width: 4,
                height: 2,
                rgba: px(4, 2, 255),
            });
        s.smart_replace_source("Replace Contents", 1, file)
            .expect("replace");
        let src = s.layers()[1].smart_source().expect("source");
        assert_eq!((src.width, src.height), (4, 2));
        assert_eq!(src.placement, Some(rect_quad(4.0, 4.0, 4.0, 2.0)));
    }

    #[test]
    fn canvas_ops_move_the_placement_and_keep_the_source() {
        let mut s = stack_with_square();
        s.make_smart(1).expect("smart");
        s.transform_canvas(super::super::CanvasOp::FlipHorizontal)
            .expect("flip");
        let src = s.layers()[1].smart_source().expect("source");
        assert_eq!(
            src.placement,
            Some([12.0, 4.0, 4.0, 4.0, 4.0, 12.0, 12.0, 12.0])
        );
        s.transform_canvas(super::super::CanvasOp::Resize {
            width: 20,
            height: 16,
            anchor_x: 0,
            anchor_y: 0,
        })
        .expect("canvas size is no longer refused");
        s.transform_canvas(super::super::CanvasOp::Crop {
            x: 2,
            y: 2,
            width: 12,
            height: 12,
        })
        .expect("crop");
        let src = s.layers()[1].smart_source().expect("source");
        assert_eq!(src.placement.map(|q| q[2]), Some(2.0));
        assert_eq!((src.width, src.height), (8, 8));
    }
}
