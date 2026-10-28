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

//! VECTORS INSIDE THE IMAGE (image ADR 476, WP5.11): the one geometry
//! the Paths panel, the vector masks and the shape layers share, and how
//! it becomes pixels.
//!
//! * A path's geometry is [`SubPath`]s in image px, each carrying how it
//!   joins the shape ([`SubOp`]: the PSD length record's operation and
//!   fill rule). The document's paths (`masking::DocPath`) and a layer's
//!   vector mask ([`LayerVectorMask`]) hold the same thing, so the Pen,
//!   Direct Selection and Path Selection edit either one alike.
//! * Every drawing of that geometry — a vector mask, a shape layer's
//!   shape, a path loaded as a selection, a path filled — goes through
//!   ONE rasterizer, the one fitted to Photoshop's own renders
//!   (`psd_vector_mask::rasterize`, 17 × 15 samples, per-sample
//!   booleans). Drawing coverage geometry is mask PREPARATION, which the
//!   GPU-only constitution leaves on the CPU; no image pixel is touched
//!   here.
//! * The PSD side ([`to_psd`] / [`from_psd`]) is `paged-psd`'s
//!   `VectorMask` model: the same records Photoshop writes for a `vmsk`
//!   block and for the path resources.
//! * A SHAPE LAYER is a fill layer with a vector mask, as in Photoshop:
//!   the fill renders over the canvas and the mask cuts the shape out.

use std::sync::{Arc, Mutex};

use image_gpu::SelectionCoverage;
use image_psd::vector_mask::{FillRule, Knot, PathComponent, PathOp, PathPoint, VectorMask};

use crate::layers::LayerMask;
use crate::masking::{PathAnchor, SubOp, SubPath};

/// The tolerance under which two handles count as collinear with their
/// anchor (|sin| of the deviation), for the PSD "linked" knot selector.
const LINKED_TOLERANCE: f64 = 1e-3;

fn point(p: [f32; 2]) -> PathPoint {
    PathPoint {
        x: f64::from(p[0]),
        y: f64::from(p[1]),
    }
}

fn unpoint(p: PathPoint) -> [f32; 2] {
    [p.x as f32, p.y as f32]
}

/// Does the anchor carry two extended, collinear handles on opposite
/// sides — a SMOOTH point, which Photoshop stores as a linked knot?
fn is_linked(a: &PathAnchor) -> bool {
    let (ix, iy) = (f64::from(a.i[0] - a.p[0]), f64::from(a.i[1] - a.p[1]));
    let (ox, oy) = (f64::from(a.o[0] - a.p[0]), f64::from(a.o[1] - a.p[1]));
    let (li, lo) = (ix.hypot(iy), ox.hypot(oy));
    if li < 1e-6 || lo < 1e-6 {
        return false;
    }
    let cross = (ix * oy - iy * ox) / (li * lo);
    let dot = (ix * ox + iy * oy) / (li * lo);
    cross.abs() < LINKED_TOLERANCE && dot < 0.0
}

/// The geometry as `paged-psd` components: a subpath whose operation is
/// `0xFFFF` joins the component before it (a first one starts a
/// combining component), every other one starts a component of its own.
pub fn to_psd(subpaths: &[SubPath]) -> Vec<PathComponent> {
    let mut out: Vec<PathComponent> = Vec::new();
    for sp in subpaths {
        let sub = image_psd::vector_mask::SubPath {
            closed: sp.closed,
            knots: sp
                .anchors
                .iter()
                .map(|a| Knot {
                    linked: is_linked(a),
                    control_in: point(a.i),
                    anchor: point(a.p),
                    control_out: point(a.o),
                })
                .collect(),
        };
        match (sp.op.op, out.last_mut()) {
            (0xFFFF, Some(c)) => c.subpaths.push(sub),
            (op, _) => out.push(PathComponent {
                op: match op {
                    0 => PathOp::Exclude,
                    2 => PathOp::Subtract,
                    3 => PathOp::Intersect,
                    _ => PathOp::Combine,
                },
                fill_rule: if sp.op.rule == 2 {
                    FillRule::NonZero
                } else {
                    FillRule::EvenOdd
                },
                subpaths: vec![sub],
            }),
        }
    }
    out
}

/// `paged-psd` components as the geometry ([`to_psd`]'s inverse).
pub fn from_psd(components: &[PathComponent]) -> Vec<SubPath> {
    let mut out = Vec::new();
    for c in components {
        for (i, sub) in c.subpaths.iter().enumerate() {
            let op = if i == 0 {
                SubOp {
                    op: match c.op {
                        PathOp::Exclude => 0,
                        PathOp::Combine => 1,
                        PathOp::Subtract => 2,
                        PathOp::Intersect => 3,
                    },
                    rule: match c.fill_rule {
                        FillRule::EvenOdd => 1,
                        FillRule::NonZero => 2,
                    },
                }
            } else {
                SubOp::CONTINUE
            };
            out.push(SubPath {
                closed: sub.closed,
                op,
                anchors: sub
                    .knots
                    .iter()
                    .map(|k| PathAnchor {
                        p: unpoint(k.anchor),
                        i: unpoint(k.control_in),
                        o: unpoint(k.control_out),
                    })
                    .collect(),
            });
        }
    }
    out
}

/// The geometry drawn as coverage on a `width × height` canvas, the way
/// Photoshop draws a vector mask. No subpath at all is an empty
/// coverage.
pub fn coverage(subpaths: &[SubPath], width: u32, height: u32) -> SelectionCoverage {
    let mask = VectorMask {
        version: 3,
        invert: false,
        not_linked: false,
        disabled: false,
        initial_fill: false,
        components: to_psd(subpaths),
    };
    crate::psd_vector_mask::rasterize(&mask, width, height)
}

/// Is the geometry usable as a shape — at least one subpath with two
/// anchors and every point finite?
pub fn check(subpaths: &[SubPath]) -> Result<(), String> {
    if !subpaths.iter().any(|s| s.anchors.len() >= 2) {
        return Err("a path needs a subpath of at least two anchors".into());
    }
    let finite = subpaths
        .iter()
        .flat_map(|s| &s.anchors)
        .flat_map(|a| [a.p, a.i, a.o])
        .all(|p| p[0].is_finite() && p[1].is_finite());
    if !finite {
        return Err("a path point is not a finite number".into());
    }
    Ok(())
}

/// Move every point of the geometry through `f` (a canvas operation, a
/// path moved with Path Selection).
pub fn map_points(subpaths: &mut [SubPath], f: impl Fn([f32; 2]) -> [f32; 2]) {
    for s in subpaths {
        for a in &mut s.anchors {
            a.p = f(a.p);
            a.i = f(a.i);
            a.o = f(a.o);
        }
    }
}

/// The document's PATHS as a PSD stores them (image ADR 476): every
/// saved path (image resources 2000–2997, the name in the resource's
/// name field) and the work path (1025), in file order, as `(name, work,
/// geometry)`. A path resource that cannot be read is skipped and named
/// in the second list, never guessed.
#[allow(clippy::type_complexity)]
pub fn paths_from_psd(
    file: &image_psd::PsdFile,
) -> (Vec<(String, bool, Vec<SubPath>)>, Vec<String>) {
    use image_psd::vector_mask::{is_path_resource, parse_path_records, RES_WORK_PATH};
    let (w, h) = (file.header.width, file.header.height);
    let mut out = Vec::new();
    let mut skipped = Vec::new();
    for b in &file.resources.blocks {
        if !is_path_resource(b.id) {
            continue;
        }
        let name = b.name.text_lossy();
        match b.data().map(|d| parse_path_records(d, w, h)) {
            Some(Ok((components, _))) => {
                out.push((name, b.id == RES_WORK_PATH, from_psd(&components)));
            }
            Some(Err(e)) => skipped.push(format!("path \"{name}\" (resource {}): {e}", b.id)),
            None => skipped.push(format!("path \"{name}\" (resource {}): no data", b.id)),
        }
    }
    (out, skipped)
}

/// Write the document's PATHS into `file`'s image resources (image ADR
/// 476): every path resource it had is replaced by the paths `doc` holds
/// — the saved ones as 2000, 2001, … in the Paths panel's order, the work
/// path as 1025. Refused past 998 saved paths (the id range's size).
pub fn paths_into_psd(
    file: &mut image_psd::PsdFile,
    doc: &crate::masking::MaskingDoc,
) -> Result<(), String> {
    use image_psd::model::{ImageResourceBlock, PascalString};
    use image_psd::vector_mask::{
        encode_path_records, is_path_resource, RES_PATH_FIRST, RES_PATH_LAST, RES_WORK_PATH,
    };
    let (w, h) = (file.header.width, file.header.height);
    let saved = doc.paths.iter().filter(|p| !p.work).count();
    if saved > usize::from(RES_PATH_LAST - RES_PATH_FIRST) + 1 {
        return Err(format!("{saved} saved paths do not fit a PSD (998 do)"));
    }
    file.resources.blocks.retain(|b| !is_path_resource(b.id));
    let mut next = RES_PATH_FIRST;
    for p in &doc.paths {
        let data = encode_path_records(&to_psd(&p.subpaths), false, w, h);
        let (id, name) = if p.work {
            (RES_WORK_PATH, PascalString::default())
        } else {
            let id = next;
            next += 1;
            (id, PascalString::new(&p.name))
        };
        file.resources
            .blocks
            .push(ImageResourceBlock::constructed(id, name, &data));
    }
    Ok(())
}

/// A layer's VECTOR MASK: the geometry, its switches, and its drawing.
///
/// What the fold applies is the drawing multiplied with the layer's user
/// mask (Photoshop's cached render of the pair is their product); the
/// drawing depends only on the geometry, `invert` and the canvas, so it
/// is made once per edit, and the product once per user mask
/// ([`combined`](Self::combined)), which keeps the fold's mask upload
/// cache warm across composites.
pub struct LayerVectorMask {
    pub subpaths: Vec<SubPath>,
    /// Flag bit 0: the mask hides what the path encloses.
    pub invert: bool,
    /// Flag bit 2 cleared: the mask applies. A disabled mask is kept.
    pub enabled: bool,
    /// Flag bit 1: the mask does not move with the layer. No pixel
    /// effect; kept for the PSD.
    pub not_linked: bool,
    raster: Arc<SelectionCoverage>,
    /// The last product: the user mask it was made with (held, so its
    /// identity cannot be reused by another allocation) and the result.
    memo: Mutex<Option<(LayerMask, LayerMask)>>,
}

impl std::fmt::Debug for LayerVectorMask {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LayerVectorMask")
            .field("subpaths", &self.subpaths.len())
            .field("invert", &self.invert)
            .field("enabled", &self.enabled)
            .finish()
    }
}

impl PartialEq for LayerVectorMask {
    fn eq(&self, o: &Self) -> bool {
        self.subpaths == o.subpaths
            && self.invert == o.invert
            && self.enabled == o.enabled
            && self.not_linked == o.not_linked
    }
}

impl LayerVectorMask {
    /// A mask of `subpaths` on a `width × height` canvas.
    pub fn new(
        subpaths: Vec<SubPath>,
        invert: bool,
        enabled: bool,
        width: u32,
        height: u32,
    ) -> LayerVectorMask {
        let mut cov = coverage(&subpaths, width, height);
        if invert {
            cov.invert();
        }
        LayerVectorMask {
            subpaths,
            invert,
            enabled,
            not_linked: false,
            raster: Arc::new(cov),
            memo: Mutex::new(None),
        }
    }

    /// REVEAL ALL (no path: everything shows) or HIDE ALL (no path,
    /// inverted: nothing shows) — Photoshop's two empty vector masks.
    pub fn empty(reveal_all: bool, width: u32, height: u32) -> LayerVectorMask {
        // No path draws nothing; reveal all is that drawing inverted.
        LayerVectorMask::new(Vec::new(), reveal_all, true, width, height)
    }

    /// A PSD vector mask (paths in canvas px).
    pub fn from_psd_mask(v: &VectorMask, width: u32, height: u32) -> LayerVectorMask {
        let mut m = LayerVectorMask::new(
            from_psd(&v.components),
            v.invert,
            !v.disabled,
            width,
            height,
        );
        m.not_linked = v.not_linked;
        m
    }

    /// As the PSD's model, for the `vmsk` block.
    pub fn to_psd_mask(&self) -> VectorMask {
        VectorMask {
            version: 3,
            invert: self.invert,
            not_linked: self.not_linked,
            disabled: !self.enabled,
            initial_fill: false,
            components: to_psd(&self.subpaths),
        }
    }

    /// The same switches over new geometry (or a new canvas).
    pub fn with_subpaths(&self, subpaths: Vec<SubPath>, width: u32, height: u32) -> Self {
        let mut m = LayerVectorMask::new(subpaths, self.invert, self.enabled, width, height);
        m.not_linked = self.not_linked;
        m
    }

    /// The same geometry with `invert` / `enabled` changed.
    pub fn with_flags(&self, invert: bool, enabled: bool) -> Self {
        let (w, h) = (self.raster.width(), self.raster.height());
        let mut m = LayerVectorMask::new(self.subpaths.clone(), invert, enabled, w, h);
        m.not_linked = self.not_linked;
        m
    }

    /// The drawing (inversion applied), canvas-sized.
    pub fn raster(&self) -> &Arc<SelectionCoverage> {
        &self.raster
    }

    /// What applies with the user mask `user` beside it: the drawing
    /// alone, or the product of the two. The product is made once per
    /// user mask and handed back as the same allocation after that.
    pub fn combined(&self, user: Option<&LayerMask>) -> LayerMask {
        let Some(user) = user else {
            return LayerMask::Canvas(Arc::clone(&self.raster));
        };
        let mut memo = self.memo.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((k, m)) = memo.as_ref() {
            if k.same(user) {
                return m.clone();
            }
        }
        let canvas = user.to_canvas();
        let data = canvas
            .data()
            .iter()
            .zip(self.raster.data())
            .map(|(&a, &b)| ((u32::from(a) * u32::from(b) + 127) / 255) as u8)
            .collect();
        let product = SelectionCoverage::from_data(canvas.width(), canvas.height(), data)
            .map(|c| LayerMask::Canvas(Arc::new(c)))
            .unwrap_or_else(|| LayerMask::Canvas(Arc::clone(&self.raster)));
        *memo = Some((user.clone(), product.clone()));
        product
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x0: f32, y0: f32, x1: f32, y1: f32, op: SubOp) -> SubPath {
        SubPath {
            closed: true,
            op,
            anchors: vec![
                PathAnchor::corner(x0, y0),
                PathAnchor::corner(x1, y0),
                PathAnchor::corner(x1, y1),
                PathAnchor::corner(x0, y1),
            ],
        }
    }

    #[test]
    #[allow(non_snake_case)]
    fn geometry_round_trips_through_the_psd_model__feat__image_paths_vectors() {
        let smooth = PathAnchor {
            p: [20.0, 10.0],
            i: [15.0, 10.0],
            o: [26.0, 10.0],
        };
        let subpaths = vec![
            rect(0.0, 0.0, 30.0, 30.0, SubOp::COMBINE),
            rect(10.0, 10.0, 20.0, 20.0, SubOp::CONTINUE),
            rect(4.5, 6.25, 40.0, 28.0, SubOp { op: 2, rule: 2 }),
            SubPath {
                closed: false,
                op: SubOp::component(3),
                anchors: vec![smooth, PathAnchor::corner(30.0, 2.0)],
            },
        ];
        let comps = to_psd(&subpaths);
        assert_eq!(comps.len(), 3, "the continuation joins the first component");
        assert_eq!(comps[0].subpaths.len(), 2);
        assert_eq!(
            (comps[1].op, comps[1].fill_rule),
            (PathOp::Subtract, FillRule::NonZero)
        );
        assert!(
            comps[2].subpaths[0].knots[0].linked,
            "a smooth anchor is linked"
        );
        assert!(!comps[2].subpaths[0].knots[1].linked, "a corner is not");
        assert_eq!(from_psd(&comps), subpaths);
        // Through the bytes Photoshop reads, too.
        let m = LayerVectorMask::new(subpaths.clone(), false, true, 64, 32);
        let bytes = m.to_psd_mask().encode(64, 32);
        let back = VectorMask::parse(&bytes, 64, 32).expect("parses");
        let again = LayerVectorMask::from_psd_mask(&back, 64, 32);
        assert_eq!(again.subpaths, subpaths);
        assert_eq!(again, m);
    }

    #[test]
    #[allow(non_snake_case)]
    fn a_vector_mask_draws_its_operations_and_inverts__feat__image_paths_vectors() {
        // A 10×10 square with a 4×4 hole (the inner square subtracts).
        let subpaths = vec![
            rect(0.0, 0.0, 10.0, 10.0, SubOp::COMBINE),
            rect(3.0, 3.0, 7.0, 7.0, SubOp::component(2)),
        ];
        let m = LayerVectorMask::new(subpaths.clone(), false, true, 12, 12);
        let r = m.raster();
        assert_eq!(r.coverage_at(1, 1), 255);
        assert_eq!(r.coverage_at(5, 5), 0, "the subtracted hole");
        assert_eq!(r.coverage_at(11, 11), 0, "outside the path");
        let inv = m.with_flags(true, true);
        assert_eq!(inv.raster().coverage_at(5, 5), 255);
        assert_eq!(inv.raster().coverage_at(1, 1), 0);
        // Reveal all and hide all.
        let all = LayerVectorMask::empty(true, 4, 4);
        assert!(all.raster().data().iter().all(|&v| v == 255));
        let none = LayerVectorMask::empty(false, 4, 4);
        assert!(none.raster().data().iter().all(|&v| v == 0));
        // The coverage a path loads as a selection is the same drawing.
        assert_eq!(coverage(&subpaths, 12, 12).data(), r.data());
    }

    #[test]
    #[allow(non_snake_case)]
    fn the_product_with_a_user_mask_is_made_once__feat__image_paths_vectors() {
        let m = LayerVectorMask::new(
            vec![rect(0.0, 0.0, 2.0, 4.0, SubOp::COMBINE)],
            false,
            true,
            4,
            4,
        );
        assert!(Arc::ptr_eq(
            match &m.combined(None) {
                LayerMask::Canvas(c) => c,
                LayerMask::Bounded(_) => panic!("canvas"),
            },
            m.raster()
        ));
        let user = LayerMask::Canvas(Arc::new(
            SelectionCoverage::from_data(4, 4, vec![128; 16]).expect("4×4"),
        ));
        let a = m.combined(Some(&user));
        let b = m.combined(Some(&user));
        let (LayerMask::Canvas(a), LayerMask::Canvas(b)) = (a, b) else {
            panic!("canvas masks");
        };
        assert!(
            Arc::ptr_eq(&a, &b),
            "the second call hands back the same product"
        );
        assert_eq!(a.coverage_at(0, 0), 128);
        assert_eq!(a.coverage_at(3, 0), 0);
    }

    #[test]
    #[allow(non_snake_case)]
    fn check_refuses_a_path_without_a_segment__feat__image_paths_vectors() {
        assert!(check(&[]).is_err());
        assert!(check(&[SubPath::new(true, vec![PathAnchor::corner(1.0, 1.0)])]).is_err());
        let bad = SubPath::new(
            true,
            vec![
                PathAnchor::corner(0.0, 0.0),
                PathAnchor::corner(f32::NAN, 1.0),
            ],
        );
        assert!(check(&[bad]).is_err());
        assert!(check(&[rect(0.0, 0.0, 1.0, 1.0, SubOp::COMBINE)]).is_ok());
    }
}
