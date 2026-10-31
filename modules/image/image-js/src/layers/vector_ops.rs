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

//! The layer stack's VECTOR verbs (image ADR 476, WP5.11): a layer's
//! vector mask (add, edit its paths, switch it, delete, rasterize),
//! SHAPE LAYERS (a solid fill layer whose vector mask is the shape), and
//! the document's paths edited as geometry (the work path, Save Path).
//!
//! Each verb is ONE structure undo step, like every other structure
//! change (ADR 463); a refusal records nothing.

use std::sync::Arc;

use super::{FillSource, LayerKind, LayerMask, LayerStack};
use crate::ingest::IngestError;
use crate::masking::SubPath;
use crate::vectors::LayerVectorMask;

fn refuse(msg: impl Into<String>) -> IngestError {
    IngestError::Unsupported(msg.into())
}

/// What a new vector mask starts as.
#[derive(Debug, Clone)]
pub enum VectorMaskStart {
    /// Photoshop's Reveal All: no path, everything shows.
    RevealAll,
    /// Photoshop's Hide All: no path, nothing shows.
    HideAll,
    /// The shape of these paths (Layer ▸ Vector Mask ▸ Current Path).
    Paths(Vec<SubPath>),
}

impl LayerStack {
    /// The vector mask of `index`, when it has one.
    pub fn vector_mask(&self, index: usize) -> Option<&LayerVectorMask> {
        self.layers.get(index)?.ext.vector_mask.as_deref()
    }

    fn vector_target(&self, index: usize) -> Result<(), IngestError> {
        let l = self
            .layers
            .get(index)
            .ok_or_else(|| refuse(format!("no layer {index}")))?;
        l.appearance_editable()?;
        Ok(())
    }

    /// ADD A VECTOR MASK to `index`. Refused when it has one already. One
    /// step.
    pub fn add_vector_mask(
        &mut self,
        index: usize,
        start: VectorMaskStart,
    ) -> Result<(), IngestError> {
        self.vector_target(index)?;
        if self.layers[index].ext.vector_mask.is_some() {
            return Err(refuse(format!(
                "layer \"{}\" already has a vector mask",
                self.layers[index].name
            )));
        }
        let (w, h) = (self.width, self.height);
        let mask = match start {
            VectorMaskStart::RevealAll => LayerVectorMask::empty(true, w, h),
            VectorMaskStart::HideAll => LayerVectorMask::empty(false, w, h),
            VectorMaskStart::Paths(p) => {
                crate::vectors::check(&p).map_err(refuse)?;
                LayerVectorMask::new(p, false, true, w, h)
            }
        };
        self.recorded("Add vector mask", None, move |s| {
            s.layers[index].ext.vector_mask = Some(Arc::new(mask));
            Ok(())
        })
    }

    /// Replace the paths of `index`'s vector mask (the Pen, Direct
    /// Selection and Path Selection edit it so). One step.
    pub fn set_vector_mask_paths(
        &mut self,
        index: usize,
        subpaths: Vec<SubPath>,
    ) -> Result<(), IngestError> {
        self.vector_target(index)?;
        let (w, h) = (self.width, self.height);
        let old = self.layers[index]
            .ext
            .vector_mask
            .clone()
            .ok_or_else(|| refuse(format!("layer {index} has no vector mask")))?;
        if !subpaths.is_empty() {
            crate::vectors::check(&subpaths).map_err(refuse)?;
        }
        let mask = old.with_subpaths(subpaths, w, h);
        self.recorded("Edit vector mask", None, move |s| {
            s.layers[index].ext.vector_mask = Some(Arc::new(mask));
            Ok(())
        })
    }

    /// Switch `index`'s vector mask: `enabled` (Disable / Enable Vector
    /// Mask) and `invert`. One step; no change records none.
    pub fn set_vector_mask_flags(
        &mut self,
        index: usize,
        enabled: bool,
        invert: bool,
    ) -> Result<bool, IngestError> {
        self.vector_target(index)?;
        let old = self.layers[index]
            .ext
            .vector_mask
            .clone()
            .ok_or_else(|| refuse(format!("layer {index} has no vector mask")))?;
        if old.enabled == enabled && old.invert == invert {
            return Ok(false);
        }
        let mask = old.with_flags(invert, enabled);
        let label = if old.enabled != enabled {
            if enabled {
                "Enable vector mask"
            } else {
                "Disable vector mask"
            }
        } else {
            "Invert vector mask"
        };
        self.recorded(label, None, move |s| {
            s.layers[index].ext.vector_mask = Some(Arc::new(mask));
            Ok(true)
        })
    }

    /// DELETE `index`'s vector mask (the shape is gone; a shape layer
    /// becomes a plain fill layer). One step.
    pub fn delete_vector_mask(&mut self, index: usize) -> Result<(), IngestError> {
        self.vector_target(index)?;
        if self.layers[index].ext.vector_mask.is_none() {
            return Err(refuse(format!("layer {index} has no vector mask")));
        }
        self.recorded("Delete vector mask", None, move |s| {
            s.layers[index].ext.vector_mask = None;
            Ok(())
        })
    }

    /// RASTERIZE `index`'s vector mask: its drawing multiplies into the
    /// layer's user mask (made, all-revealing, when there is none) and
    /// the vector mask is gone — what Photoshop's Layer ▸ Rasterize ▸
    /// Vector Mask leaves. A disabled vector mask is refused (rasterizing
    /// it would apply what is switched off). One step.
    pub fn rasterize_vector_mask(&mut self, index: usize) -> Result<(), IngestError> {
        self.vector_target(index)?;
        let l = &self.layers[index];
        let v = l
            .ext
            .vector_mask
            .clone()
            .ok_or_else(|| refuse(format!("layer {index} has no vector mask")))?;
        if !v.enabled {
            return Err(refuse(
                "the vector mask is disabled — enable it before rasterizing it",
            ));
        }
        let user = l.mask.as_ref().filter(|_| l.mask_enabled);
        let product = match v.combined(user) {
            LayerMask::Canvas(c) => c,
            LayerMask::Bounded(b) => Arc::new(LayerMask::Bounded(b).to_canvas().as_ref().clone()),
        };
        self.recorded("Rasterize vector mask", None, move |s| {
            let l = &mut s.layers[index];
            l.mask = Some(product.into());
            l.mask_enabled = true;
            l.ext.vector_mask = None;
            Ok(())
        })
    }

    /// A SHAPE LAYER: a solid colour fill layer above the active one whose
    /// vector mask is `subpaths` (Photoshop's Shape mode). Its render is
    /// due, like any new fill layer. An empty `name` takes Photoshop's
    /// ("Shape 1"). One step; answers its index.
    pub fn add_shape_layer(
        &mut self,
        name: &str,
        rgb: [u8; 3],
        subpaths: Vec<SubPath>,
    ) -> Result<usize, IngestError> {
        crate::vectors::check(&subpaths).map_err(refuse)?;
        let (w, h) = (self.width, self.height);
        let name = if name.is_empty() {
            self.numbered("Shape")
        } else {
            name.to_string()
        };
        let mask = LayerVectorMask::new(subpaths, false, true, w, h);
        self.recorded("New shape layer", None, move |s| {
            let i = s.add_fill_layer(&name, FillSource::Solid { rgb });
            s.layers[i].ext.vector_mask = Some(Arc::new(mask));
            Ok(i)
        })
    }

    /// Is `index` a SHAPE layer — a fill layer with a vector mask?
    pub fn is_shape_layer(&self, index: usize) -> bool {
        self.layers
            .get(index)
            .is_some_and(|l| matches!(l.kind, LayerKind::Fill(_)) && l.ext.vector_mask.is_some())
    }

    // ── the document's paths as geometry ────────────────────────────

    /// Put `subpaths` in the WORK PATH (created, or replaced). One step;
    /// answers its id.
    pub fn set_work_path(&mut self, subpaths: Vec<SubPath>) -> Result<u32, IngestError> {
        crate::vectors::check(&subpaths).map_err(refuse)?;
        self.masking_edit("Work path", |d, _, _| Ok(d.set_work_path(subpaths)))
    }

    /// Replace a stored path's geometry. One step.
    pub fn set_path_subpaths(
        &mut self,
        id: u32,
        subpaths: Vec<SubPath>,
    ) -> Result<(), IngestError> {
        crate::vectors::check(&subpaths).map_err(refuse)?;
        self.masking_edit("Edit path", |d, _, _| d.set_path_subpaths(id, subpaths))
    }

    /// Save Path: the work path becomes a saved path. One step.
    pub fn save_path(&mut self, id: u32, name: &str) -> Result<(), IngestError> {
        self.masking_edit("Save path", |d, _, _| d.save_path(id, name))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::masking::{PathAnchor, SubOp};

    fn stack(w: u32, h: u32) -> LayerStack {
        LayerStack::from_image(w, h, Arc::from(vec![200u8; (w * h * 4) as usize])).expect("a stack")
    }

    fn rect(x0: f32, y0: f32, x1: f32, y1: f32) -> SubPath {
        SubPath::new(
            true,
            vec![
                PathAnchor::corner(x0, y0),
                PathAnchor::corner(x1, y0),
                PathAnchor::corner(x1, y1),
                PathAnchor::corner(x0, y1),
            ],
        )
    }

    #[test]
    #[allow(non_snake_case)]
    fn a_vector_mask_is_added_edited_switched_and_deleted_one_step_each__feat__image_paths_vectors()
    {
        let mut s = stack(8, 8);
        let depth = |s: &LayerStack| s.history().depth;
        let d0 = depth(&s);
        s.add_vector_mask(0, VectorMaskStart::Paths(vec![rect(0.0, 0.0, 4.0, 8.0)]))
            .expect("adds");
        assert_eq!(depth(&s), d0 + 1);
        let m = s.layers()[0].live_mask().expect("the mask applies");
        assert_eq!((m.at(1, 1), m.at(6, 1)), (255, 0));
        assert!(
            s.add_vector_mask(0, VectorMaskStart::RevealAll).is_err(),
            "a second vector mask is refused"
        );
        assert_eq!(depth(&s), d0 + 1, "and records nothing");
        s.set_vector_mask_paths(0, vec![rect(4.0, 0.0, 8.0, 8.0)])
            .expect("edits");
        let m = s.layers()[0].live_mask().expect("applies");
        assert_eq!((m.at(1, 1), m.at(6, 1)), (0, 255));
        assert!(s.set_vector_mask_flags(0, false, false).expect("disables"));
        assert!(
            s.layers()[0].live_mask().is_none(),
            "a disabled mask is kept, not applied"
        );
        assert!(!s.set_vector_mask_flags(0, false, false).expect("no change"));
        assert!(s.set_vector_mask_flags(0, true, true).expect("inverts"));
        let m = s.layers()[0].live_mask().expect("applies");
        assert_eq!((m.at(1, 1), m.at(6, 1)), (255, 0));
        s.delete_vector_mask(0).expect("deletes");
        assert!(s.vector_mask(0).is_none());
        assert_eq!(depth(&s), d0 + 5);
        // Undo walks back through every step to the inverted mask.
        assert!(s.undo().is_some());
        assert!(s.vector_mask(0).is_some_and(|v| v.invert));
    }

    #[test]
    #[allow(non_snake_case)]
    fn reveal_all_hide_all_and_rasterize_into_the_user_mask__feat__image_paths_vectors() {
        let mut s = stack(4, 4);
        s.add_vector_mask(0, VectorMaskStart::RevealAll)
            .expect("adds");
        assert!(
            s.layers()[0].live_mask().is_none(),
            "reveal all changes nothing"
        );
        s.delete_vector_mask(0).expect("deletes");
        s.add_vector_mask(0, VectorMaskStart::HideAll)
            .expect("adds");
        assert_eq!(s.layers()[0].live_mask().expect("hides").at(2, 2), 0);
        s.set_vector_mask_paths(0, vec![rect(0.0, 0.0, 2.0, 4.0)])
            .expect("edits");
        s.set_vector_mask_flags(0, false, false).expect("disables");
        assert!(
            s.rasterize_vector_mask(0).is_err(),
            "a disabled mask is not rasterized"
        );
        s.set_vector_mask_flags(0, true, false).expect("enables");
        s.rasterize_vector_mask(0).expect("rasterizes");
        let l = &s.layers()[0];
        assert!(l.ext.vector_mask.is_none());
        let m = l.mask.as_ref().expect("now a user mask");
        assert_eq!((m.at(0, 0), m.at(3, 0)), (255, 0));
    }

    #[test]
    #[allow(non_snake_case)]
    fn a_shape_layer_is_a_fill_layer_cut_by_its_path__feat__image_paths_vectors() {
        let mut s = stack(8, 8);
        let i = s
            .add_shape_layer("", [255, 0, 0], vec![rect(2.0, 2.0, 6.0, 6.0)])
            .expect("adds");
        assert!(s.is_shape_layer(i));
        assert_eq!(s.layers()[i].name, "Shape 1");
        assert!(matches!(
            s.layers()[i].fill().map(|f| &f.source),
            Some(FillSource::Solid { rgb: [255, 0, 0] })
        ));
        let m = s.layers()[i].live_mask().expect("the shape cuts");
        assert_eq!((m.at(3, 3), m.at(0, 0)), (255, 0));
        assert!(s.add_shape_layer("", [0, 0, 0], Vec::new()).is_err());
        // Moving the shape layer moves its (linked) shape.
        assert!(s.translate(&[i], 1, 0).expect("moves"));
        let m = s.layers()[i].live_mask().expect("still cuts");
        assert_eq!((m.at(2, 3), m.at(6, 3)), (0, 255));
    }

    #[test]
    #[allow(non_snake_case)]
    fn the_work_path_is_replaced_saved_and_edited__feat__image_paths_vectors() {
        let mut s = stack(8, 8);
        let w = s
            .set_work_path(vec![rect(0.0, 0.0, 2.0, 2.0)])
            .expect("work path");
        assert_eq!(
            s.masking().path(w).map(|p| (p.name.as_str(), p.work)),
            Some(("Work Path", true))
        );
        let again = s
            .set_work_path(vec![rect(1.0, 1.0, 3.0, 3.0)])
            .expect("replaced");
        assert_eq!(again, w, "the work path keeps its id");
        assert_eq!(s.masking().paths.len(), 1);
        s.save_path(w, "").expect("saves");
        assert_eq!(
            s.masking().path(w).map(|p| (p.name.as_str(), p.work)),
            Some(("Path 1", false))
        );
        assert!(
            s.save_path(w, "x").is_err(),
            "a saved path is not saved again"
        );
        let fresh = s
            .set_work_path(vec![rect(0.0, 0.0, 1.0, 1.0)])
            .expect("a new work path");
        assert_ne!(fresh, w);
        let mut moved = vec![rect(4.0, 4.0, 6.0, 6.0)];
        moved[0].op = SubOp::component(2);
        s.set_path_subpaths(w, moved.clone()).expect("edits");
        assert_eq!(s.masking().path(w).map(|p| p.subpaths.clone()), Some(moved));
        assert!(s
            .set_path_subpaths(99, vec![rect(0.0, 0.0, 1.0, 1.0)])
            .is_err());
        assert!(
            s.set_work_path(Vec::new()).is_err(),
            "an empty path is refused"
        );
    }

    #[test]
    #[allow(non_snake_case)]
    fn vector_masks_persist_with_the_layer_data__feat__image_paths_vectors() {
        let mut s = stack(8, 8);
        let mut sub = rect(1.0, 1.0, 5.0, 7.0);
        sub.op = SubOp { op: 2, rule: 2 };
        s.add_vector_mask(
            0,
            VectorMaskStart::Paths(vec![rect(0.0, 0.0, 8.0, 8.0), sub]),
        )
        .expect("adds");
        s.set_vector_mask_flags(0, true, true).expect("inverts");
        s.set_work_path(vec![rect(0.0, 0.0, 2.0, 2.0)])
            .expect("work path");
        let (m, bufs) = s.export();
        let back = LayerStack::import(&m, &bufs).expect("reopens");
        assert_eq!(back.vector_mask(0), s.vector_mask(0));
        assert_eq!(
            back.layers()[0]
                .live_mask()
                .map(|m| m.to_canvas().data().to_vec()),
            s.layers()[0]
                .live_mask()
                .map(|m| m.to_canvas().data().to_vec())
        );
        assert_eq!(back.masking().paths, s.masking().paths);
        assert!(back.masking().paths[0].work);
    }
}
