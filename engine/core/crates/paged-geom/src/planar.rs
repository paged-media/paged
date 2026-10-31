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

//! B-22 — the planar arrangement kernel: N overlapping paths → the
//! distinct AREAS (faces of the planar map) they divide the plane into.
//!
//! The engine's hit-testing resolves ELEMENTS. Region-level tools —
//! Shape Builder, Live Paint, and the Pathfinder verbs Divide / Trim /
//! Merge / Crop / Outline / Minus Back — need the level below that: the
//! faces of the arrangement, each addressable on its own.
//!
//! # Model
//!
//! A face is a maximal connected region of the plane whose *containment
//! signature* is constant. The signature of a point is the set of input
//! path indices whose interior contains it (even-odd, matching
//! `flo_curves`' convention that every edge is an exterior edge). Two
//! overlapping circles have three non-empty signatures — `{0}`, `{1}`,
//! `{0,1}` — and therefore three faces; three circles in general
//! position have seven. The empty signature (outside everything) is not
//! a face: the arrangement covers exactly the union of its inputs.
//!
//! A single signature can materialise as SEVERAL disconnected regions
//! (e.g. `A − B` where `B` cuts `A` in two), so faces are the connected
//! COMPONENTS of each signature's region. A component may carry holes —
//! those stay with it as extra subpaths (a compound path), exactly the
//! way Illustrator's Divide keeps an annulus as one object.
//!
//! # Design — one graph, one face walk (engine ADR 1019)
//!
//! 1. **Split.** `flo_curves`' [`GraphPath`] (`from_merged_paths` +
//!    `self_collide`) splits every input curve at every crossing,
//!    including an input's crossings with itself. That is the only
//!    numerically hard step, and it runs once.
//! 2. **Walk.** [`crate::planar_dcel`] reads the collided graph into a
//!    doubly-connected edge list — vertices merged, coincident edges
//!    collapsed, half-edges sorted by angle at every vertex — and walks
//!    every cycle once. Components nested inside a face become its holes.
//! 3. **Label.** Crossing an edge flips membership of the inputs that
//!    contributed it, so one breadth-first pass from the outside labels
//!    every face with its signature. Each face is then checked with ONE
//!    point-in-path test per input at an interior point; where the two
//!    disagree (a crossing the collision pass resolved inexactly), the
//!    point test wins.
//! 4. **Group.** Adjacent faces with the same signature are one face
//!    (an edge between them separates nothing), and every face's outline
//!    is read off the walk: no booleans, no ray casting, no
//!    `exterior_paths` — so the C-21 comparator is not on this path at
//!    all.
//!
//! Before the walk replaced it (B-22, 2026-08) each face was materialised
//! by a ray-casting pass over the whole graph (O(F·E)) with a boolean
//! fallback, which is why the caps were 12 inputs and 256 faces. They
//! are now [`MAX_PLANAR_INPUTS`] and [`MAX_PLANAR_FACES`], behind an
//! operation budget ([`PlanarLimits`]) that refuses with a named error
//! ([`PlanarError::OverBudget`]) instead of running for minutes.
//!
//! [`PlanarArrangement::complete`] stays the honest check: the summed
//! face area is compared against the area the walk's outer boundaries
//! enclose minus the empty faces, and a walk that met an inconsistency
//! says so.
//!
//! # Coordinate space
//!
//! Paths are combined in RAW path space (the anchors as stored), exactly
//! like [`crate::pathfinder`] — per-element `ItemTransform`s are not
//! composed in. Inputs with different transforms therefore arrange
//! approximately; that is the same residual `pathfinderBoolean` carries.
//!
//! # Residuals
//!
//! - **Live Paint** — its PERSISTENT face/edge graph with gap detection
//!   is out of scope here. That needs a document-resident object type
//!   that survives edits, not a query (RFI B-22).
//! - **Progress.** [`build_arrangement_with`] reports progress through a
//!   callback; the wire has no progress channel for a read
//!   (`RequestPlanarRegions` answers once), so the editor sees the
//!   budget refusal, not a progress bar.
//! - **C-21** (the `flo_curves` comparator) no longer applies to the
//!   arrangement, but [`union_faces`] still runs one `flo_curves` sweep
//!   and the inputs are still snapped onto [`PLANAR_ACCURACY`] — the
//!   collision pass is `flo_curves` code too.

use std::collections::BTreeMap;
use std::sync::Arc;

use flo_curves::bezier::path::{
    path_intersects_ray, path_remove_overlapped_points, GraphPath, PathLabel, SimpleBezierPath,
};
use flo_curves::bezier::BezierCurve;
use flo_curves::{Coord2, Coordinate2D};
use paged_model::PathAnchor;

use crate::bezier_conv::{flo_to_idml_path, idml_path_to_flo_on_grid, BOOLEAN_GRID};
use crate::planar_dcel::{AxisLine, Dcel, DcelError, P, UNBOUNDED};

/// Subdivision accuracy handed to `flo_curves`, AND the grid every input
/// path is snapped onto first. Matches [`crate::pathfinder`]'s constant —
/// 1/64 pt, well below any visible threshold, and it keeps recursion
/// bounded.
///
/// **C-21 — load-bearing for crash-safety; do not lower it.** It has to
/// stay strictly above `flo_curves` 0.8.0's hardcoded 0.01 sort epsilon,
/// because [`union_faces`] still ends in `exterior_paths`, whose point
/// sort is only a strict weak ordering on this grid. Full derivation in
/// the C-21 section of [`crate::bezier_conv`]. Pinned by
/// `planar_accuracy_grid_separates_above_the_flo_curves_sort_epsilon`.
const PLANAR_ACCURACY: f64 = BOOLEAN_GRID;

// C-21 — compile-time guard, so a lowered value breaks the BUILD rather
// than waiting for a test run. The f64-arithmetic half of the invariant
// is in the test named below.
const _: () = assert!(
    PLANAR_ACCURACY > crate::bezier_conv::FLO_SORT_EPSILON,
    "C-21: PLANAR_ACCURACY must stay strictly above flo_curves' 0.01 sort epsilon"
);

/// Cap on the number of input paths. Past it every entry point returns
/// [`PlanarError::TooManyInputs`] and does NO work — it never silently
/// truncates.
pub const MAX_PLANAR_INPUTS: usize = 1000;

/// Cap on the number of faces a full enumeration materialises. Hitting
/// it returns [`PlanarError::TooManyFaces`] — a refusal, not a
/// truncation, because a truncated arrangement is worse than none (its
/// faces no longer tile the union, and every verb built on it would
/// silently drop artwork).
pub const MAX_PLANAR_FACES: usize = 100_000;

/// Cap on the edges of the collided graph (each crossing adds two).
pub const MAX_PLANAR_EDGES: usize = 1_000_000;

/// Cap on the curve pairs whose bounding boxes overlap — the work the
/// collision pass will do, counted BEFORE it starts.
pub const MAX_PLANAR_COLLISION_PAIRS: u64 = 4_000_000;

/// Relative tolerance for the "do the faces tile the union?" check.
const AREA_TOLERANCE: f64 = 1e-3;

/// The arrangement's budget. An operation budget, not a wall-clock one:
/// it is deterministic (the same inputs are refused on every machine)
/// and it needs no clock, which the wasm worker does not have.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PlanarLimits {
    pub max_inputs: usize,
    pub max_faces: usize,
    pub max_edges: usize,
    pub max_collision_pairs: u64,
}

impl Default for PlanarLimits {
    fn default() -> Self {
        PlanarLimits {
            max_inputs: MAX_PLANAR_INPUTS,
            max_faces: MAX_PLANAR_FACES,
            max_edges: MAX_PLANAR_EDGES,
            max_collision_pairs: MAX_PLANAR_COLLISION_PAIRS,
        }
    }
}

/// The stages a build passes through, for progress and for the budget
/// refusal.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlanarStage {
    /// Splitting every curve at every crossing.
    Collide,
    /// Building the edge list and walking the faces.
    Walk,
    /// Reading each face's outline and checking its signature.
    Faces,
}

impl PlanarStage {
    fn name(self) -> &'static str {
        match self {
            PlanarStage::Collide => "collision",
            PlanarStage::Walk => "face walk",
            PlanarStage::Faces => "face outlines",
        }
    }
}

/// One progress report: `done` of `total` units of `stage`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PlanarProgress {
    pub stage: PlanarStage,
    pub done: u64,
    pub total: u64,
}

/// Honest refusals from the arrangement kernel.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlanarError {
    /// More inputs than [`MAX_PLANAR_INPUTS`].
    TooManyInputs { count: usize, cap: usize },
    /// The arrangement resolved more than [`MAX_PLANAR_FACES`] faces.
    TooManyFaces { cap: usize },
    /// Fewer than one input carried usable geometry.
    NoGeometry,
    /// A stage would exceed its share of the [`PlanarLimits`] budget.
    OverBudget {
        stage: PlanarStage,
        work: u64,
        budget: u64,
    },
}

impl std::fmt::Display for PlanarError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PlanarError::TooManyInputs { count, cap } => write!(
                f,
                "planar arrangement takes at most {cap} input paths (got {count})"
            ),
            PlanarError::TooManyFaces { cap } => write!(
                f,
                "planar arrangement resolved more than {cap} faces; refine the selection"
            ),
            PlanarError::NoGeometry => write!(f, "no input carried usable path geometry"),
            PlanarError::OverBudget {
                stage,
                work,
                budget,
            } => write!(
                f,
                "planar arrangement is over its budget in the {} stage ({work} > {budget}); \
                 refine the selection",
                stage.name()
            ),
        }
    }
}

/// One face of the arrangement: a connected region whose containment
/// signature is constant.
#[derive(Debug, Clone)]
pub struct PlanarFace {
    /// Stable id, derived from the signature plus the component's
    /// position: `"0-1#0"` = the first component of the region covered
    /// by inputs 0 and 1. Stable across repeated calls with the same
    /// inputs, which is what lets a hover query's id be handed straight
    /// back to `pathfinderFaces`.
    pub id: String,
    /// Sorted input indices whose interior contains this face.
    pub signature: Vec<usize>,
    /// The face outline. Closed; a component with holes carries them as
    /// extra subpaths.
    pub anchors: Vec<PathAnchor>,
    /// Per-contour boundaries into `anchors` (always non-empty).
    pub subpath_starts: Vec<usize>,
    /// Unsigned area (outer contour minus holes).
    pub area: f64,
    /// A point strictly inside the face — the anchor a hover highlight
    /// or a fill drop can use without re-deriving containment.
    pub inside: (f32, f32),
}

/// How much work a build did — deterministic counts, the arrangement's
/// work budget (`paged-perf`'s planar budgets gate on them).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PlanarStats {
    /// Curve pairs whose boxes overlap: what the collision pass clipped.
    pub collision_pairs: u64,
    /// Edges of the face walk (after merging and pruning).
    pub edges: usize,
    /// Elementary faces the walk found (empty ones included).
    pub elementary_faces: usize,
    /// Faces whose edge-toggled signature the point test corrected.
    pub signature_corrections: usize,
}

/// The full arrangement of N input paths.
#[derive(Debug, Clone)]
pub struct PlanarArrangement {
    /// Every face, ordered by signature then component position.
    pub faces: Vec<PlanarFace>,
    /// How many paths went in (faces index into this range).
    pub input_count: usize,
    /// Area of the union of all inputs.
    pub union_area: f64,
    /// Summed face area.
    pub faces_area: f64,
    /// `faces_area ≈ union_area` and the walk was consistent — the faces
    /// tile the union. `false` means a region was lost (a sliver thinner
    /// than the arrangement's resolution, or a crossing the collision
    /// pass resolved inconsistently); the faces returned are still real,
    /// the set is just not exhaustive. Callers that must be exact should
    /// refuse rather than proceed.
    pub complete: bool,
    /// The work the build did.
    pub stats: PlanarStats,
    /// The walk the faces were read from, kept so unions of faces come
    /// off the same edges ([`PlanarArrangement::union_of`]).
    graph: Arc<Dcel>,
    /// Elementary DCEL faces per entry of `faces`.
    members: Vec<Vec<u32>>,
}

impl PlanarArrangement {
    /// Look a face up by its stable id.
    pub fn face(&self, id: &str) -> Option<&PlanarFace> {
        self.faces.iter().find(|f| f.id == id)
    }

    /// The union of the faces whose ids are listed, read off the face
    /// walk: the half-edges with a listed face on one side and anything
    /// else on the other, chained. Boundaries two listed faces share
    /// dissolve; unknown ids are ignored. `(anchors, subpath_starts)`,
    /// empty when nothing is selected.
    pub fn union_of(&self, ids: &[&str]) -> (Vec<PathAnchor>, Vec<usize>) {
        let mut selected = vec![false; self.graph.faces.len()];
        for (face, members) in self.faces.iter().zip(&self.members) {
            if ids.contains(&face.id.as_str()) {
                for m in members {
                    selected[*m as usize] = true;
                }
            }
        }
        let group = |f: u32| -> u32 {
            if f != UNBOUNDED && selected[f as usize] {
                0
            } else {
                UNBOUNDED
            }
        };
        let mut cycles: Vec<(f64, Vec<u32>)> = self
            .graph
            .boundary_walk(&group)
            .into_iter()
            .map(|(_, hes)| (self.graph.cycle_area(&hes), hes))
            .filter(|(area, hes)| !is_sliver_cycle(&self.graph, hes, *area))
            .collect();
        // Outer contours first, largest first; holes after.
        cycles.sort_by(|a, b| b.0.total_cmp(&a.0));
        contours_to_anchors(&self.graph, cycles.iter().map(|(_, hes)| hes.as_slice()))
    }
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/// Build the full arrangement of `inputs` (each a flat anchor list +
/// `subpath_starts`, the idml path representation) within the default
/// [`PlanarLimits`].
pub fn build_arrangement(
    inputs: &[(Vec<PathAnchor>, Vec<usize>)],
) -> Result<PlanarArrangement, PlanarError> {
    build_arrangement_with(inputs, &PlanarLimits::default(), &mut |_| {})
}

/// [`build_arrangement`] with an explicit budget and a progress callback.
pub fn build_arrangement_with(
    inputs: &[(Vec<PathAnchor>, Vec<usize>)],
    limits: &PlanarLimits,
    progress: &mut dyn FnMut(PlanarProgress),
) -> Result<PlanarArrangement, PlanarError> {
    if inputs.len() > limits.max_inputs {
        return Err(PlanarError::TooManyInputs {
            count: inputs.len(),
            cap: limits.max_inputs,
        });
    }
    let flo = to_flo(inputs)?;
    let n = flo.len();

    // --- collide (budgeted before it starts) ---------------------------
    let collision_pairs = check_collision_budget(&flo, limits.max_collision_pairs)?;
    progress(PlanarProgress {
        stage: PlanarStage::Collide,
        done: 0,
        total: 1,
    });
    let graph = build_graph(&flo);
    progress(PlanarProgress {
        stage: PlanarStage::Collide,
        done: 1,
        total: 1,
    });

    // --- walk ----------------------------------------------------------
    // Elementary faces include the empty ones (holes nobody fills) and
    // the pieces a same-signature group is made of, so the walk gets
    // headroom over the output cap.
    let dcel = Dcel::build(
        &graph,
        &axis_lines(&flo),
        limits.max_edges,
        limits.max_faces.saturating_mul(4),
    )
    .map_err(|e| match e {
        DcelError::TooManyEdges { edges, cap } => PlanarError::OverBudget {
            stage: PlanarStage::Walk,
            work: edges as u64,
            budget: cap as u64,
        },
        DcelError::TooManyFaces { .. } => PlanarError::TooManyFaces {
            cap: limits.max_faces,
        },
    })?;
    drop(graph);
    progress(PlanarProgress {
        stage: PlanarStage::Walk,
        done: 1,
        total: 1,
    });

    let mut dcel = dcel;
    let total_faces = dcel.faces.len() as u64;

    // --- one point test per face: interior point + signature -----------
    let input_boxes: Vec<[f64; 4]> = flo.iter().map(|paths| paths_bbox(paths)).collect();
    let mut inside_of: Vec<Option<P>> = Vec::with_capacity(dcel.faces.len());
    let mut disagreements = 0usize;
    for f in 0..dcel.faces.len() as u32 {
        if f % 1024 == 0 {
            progress(PlanarProgress {
                stage: PlanarStage::Faces,
                done: f as u64,
                total: total_faces,
            });
        }
        let inside = if dcel.faces[f as usize].area > 0.0 {
            dcel.interior_point(f)
        } else {
            None
        };
        if let Some(p) = inside {
            if let Some(sig) = signature_at_boxed(&flo, &input_boxes, Coord2(p.0, p.1)) {
                let sig: Vec<u32> = sig.into_iter().map(|i| i as u32).collect();
                if sig != dcel.faces[f as usize].signature {
                    disagreements += 1;
                    dcel.faces[f as usize].signature = sig;
                }
            }
        }
        inside_of.push(inside);
    }

    // --- group adjacent faces of one signature --------------------------
    let nf = dcel.faces.len();
    let mut parent: Vec<u32> = (0..nf as u32).collect();
    fn find(parent: &mut [u32], mut x: u32) -> u32 {
        while parent[x as usize] != x {
            let p = parent[x as usize];
            parent[x as usize] = parent[p as usize];
            x = p;
        }
        x
    }
    for e in 0..dcel.edges.len() {
        let (f, g) = (dcel.he_face[2 * e], dcel.he_face[2 * e + 1]);
        if f == UNBOUNDED || g == UNBOUNDED || f == g {
            continue;
        }
        let sig_f = &dcel.faces[f as usize].signature;
        if sig_f.is_empty() || *sig_f != dcel.faces[g as usize].signature {
            continue;
        }
        let (rf, rg) = (find(&mut parent, f), find(&mut parent, g));
        if rf != rg {
            parent[rf.max(rg) as usize] = rf.min(rg);
        }
    }
    let mut group_of: Vec<u32> = vec![UNBOUNDED; nf];
    let mut group_members: Vec<Vec<u32>> = Vec::new();
    let mut group_index: BTreeMap<u32, u32> = BTreeMap::new();
    for f in 0..nf as u32 {
        if dcel.faces[f as usize].signature.is_empty() {
            continue;
        }
        let root = find(&mut parent, f);
        let g = *group_index.entry(root).or_insert_with(|| {
            group_members.push(Vec::new());
            (group_members.len() - 1) as u32
        });
        group_of[f as usize] = g;
        group_members[g as usize].push(f);
    }

    // --- outlines: one boundary walk for every group at once ------------
    let mut cycles_of_group: Vec<Vec<Vec<u32>>> = vec![Vec::new(); group_members.len()];
    for (g, hes) in dcel.boundary_walk(&|f: u32| {
        if f == UNBOUNDED {
            UNBOUNDED
        } else {
            group_of[f as usize]
        }
    }) {
        cycles_of_group[g as usize].push(hes);
    }

    let mut faces: Vec<PlanarFace> = Vec::new();
    let mut members_of: Vec<Vec<u32>> = Vec::new();
    for (g, cycles) in cycles_of_group.into_iter().enumerate() {
        let signature: Vec<usize> = dcel.faces[group_members[g][0] as usize]
            .signature
            .iter()
            .map(|i| *i as usize)
            .collect();
        for (outer, holes, area) in components_of(&dcel, cycles) {
            if is_sliver_cycle(&dcel, &outer, area) {
                continue;
            }
            // Members inside this component (one component per group in
            // all but pinched cases).
            let members: Vec<u32> = if group_members[g].len() == 1 {
                group_members[g].clone()
            } else {
                group_members[g]
                    .iter()
                    .copied()
                    .filter(|m| match inside_of[*m as usize] {
                        Some(p) => dcel.winding_of(&outer, p) != 0,
                        None => true,
                    })
                    .collect()
            };
            let inside = members
                .iter()
                .filter_map(|m| inside_of[*m as usize].map(|p| (dcel.faces[*m as usize].area, p)))
                .max_by(|a, b| a.0.total_cmp(&b.0))
                .map(|(_, p)| (p.0 as f32, p.1 as f32));
            let mut contours: Vec<&[u32]> = vec![outer.as_slice()];
            contours.extend(holes.iter().map(|h| h.as_slice()));
            let (anchors, subpath_starts) = contours_to_anchors(&dcel, contours.into_iter());
            if anchors.is_empty() {
                continue;
            }
            let inside = inside.unwrap_or(anchors[0].anchor);
            faces.push(PlanarFace {
                id: String::new(), // assigned below, after ordering
                signature: signature.clone(),
                anchors,
                subpath_starts,
                area,
                inside,
            });
            members_of.push(members);
            if faces.len() > limits.max_faces {
                return Err(PlanarError::TooManyFaces {
                    cap: limits.max_faces,
                });
            }
        }
    }
    progress(PlanarProgress {
        stage: PlanarStage::Faces,
        done: total_faces,
        total: total_faces,
    });

    // Deterministic order: by signature, then by the component's
    // top-left-most anchor (rounded, so float wobble can't reshuffle
    // ids between calls).
    let mut order: Vec<usize> = (0..faces.len()).collect();
    order.sort_by(|a, b| {
        faces[*a]
            .signature
            .cmp(&faces[*b].signature)
            .then_with(|| key_cmp(order_key(&faces[*a]), order_key(&faces[*b])))
    });
    let mut sorted_faces = Vec::with_capacity(faces.len());
    let mut sorted_members = Vec::with_capacity(faces.len());
    let mut slots: Vec<Option<PlanarFace>> = faces.into_iter().map(Some).collect();
    let mut member_slots: Vec<Option<Vec<u32>>> = members_of.into_iter().map(Some).collect();
    for i in order {
        sorted_faces.push(slots[i].take().expect("each face once"));
        sorted_members.push(member_slots[i].take().expect("each face once"));
    }
    let mut per_signature: BTreeMap<Vec<usize>, usize> = BTreeMap::new();
    for face in sorted_faces.iter_mut() {
        let slot = per_signature.entry(face.signature.clone()).or_insert(0);
        face.id = face_id(&face.signature, *slot);
        *slot += 1;
    }

    // The union is what the walk's outer boundaries enclose, less the
    // bounded faces nothing covers; a face lost on the way (a sliver, or
    // a group the walk could not close) shows up as a difference.
    let faces_area: f64 = sorted_faces.iter().map(|f| f.area).sum();
    let enclosed: f64 = dcel
        .top_level
        .iter()
        .map(|c| dcel.cycles[*c as usize].area.abs())
        .sum();
    let empty: f64 = dcel
        .faces
        .iter()
        .filter(|f| f.signature.is_empty())
        .map(|f| f.area.max(0.0))
        .sum();
    let union_area = (enclosed - empty).max(0.0);
    let complete =
        dcel.consistent && (faces_area - union_area).abs() <= AREA_TOLERANCE * union_area.max(1.0);
    let stats = PlanarStats {
        collision_pairs,
        edges: dcel.edges.len(),
        elementary_faces: dcel.faces.len(),
        signature_corrections: disagreements,
    };

    Ok(PlanarArrangement {
        faces: sorted_faces,
        input_count: n,
        union_area,
        faces_area,
        complete,
        stats,
        graph: Arc::new(dcel),
        members: sorted_members,
    })
}

/// The Shape Builder hover query: which face lies under `point`?
///
/// `None` (without building anything) when the point is outside every
/// input. Otherwise the arrangement is built and the face whose region
/// holds the point is returned — the same face, with the same id,
/// [`build_arrangement`] reports.
pub fn face_at_point(
    inputs: &[(Vec<PathAnchor>, Vec<usize>)],
    point: (f32, f32),
) -> Result<Option<PlanarFace>, PlanarError> {
    if inputs.len() > MAX_PLANAR_INPUTS {
        return Err(PlanarError::TooManyInputs {
            count: inputs.len(),
            cap: MAX_PLANAR_INPUTS,
        });
    }
    let flo = to_flo(inputs)?;
    let p = Coord2(point.0 as f64, point.1 as f64);
    let signature = signature_at(&flo, p).unwrap_or_default();
    if signature.is_empty() {
        return Ok(None);
    }
    let arrangement = build_arrangement(inputs)?;
    let q = (point.0 as f64, point.1 as f64);
    for (face, members) in arrangement.faces.iter().zip(&arrangement.members) {
        if face.signature != signature {
            continue;
        }
        if members
            .iter()
            .any(|m| arrangement.graph.face_contains(*m, q))
        {
            return Ok(Some(face.clone()));
        }
    }
    Ok(None)
}

/// Union a set of faces into one path (Shape Builder's click/drag
/// output). Shared boundaries between adjacent faces DISSOLVE — the
/// result is one clean outline, not a compound path with internal
/// edges.
///
/// For faces of one [`PlanarArrangement`], prefer
/// [`PlanarArrangement::union_of`], which reads the union off the face
/// walk instead of running a `flo_curves` sweep.
pub fn union_faces(faces: &[&PlanarFace]) -> (Vec<PathAnchor>, Vec<usize>) {
    // C-21: face outlines come back through f32 anchors, so re-snap
    // before the sweep — `path_remove_overlapped_points` ends in
    // `exterior_paths` like every other flo_curves boolean.
    let loops: Vec<SimpleBezierPath> = faces
        .iter()
        .flat_map(|face| {
            idml_path_to_flo_on_grid(&face.anchors, &face.subpath_starts, PLANAR_ACCURACY)
        })
        .collect();
    if loops.is_empty() {
        return (Vec::new(), Vec::new());
    }
    // Faces are pairwise disjoint, so an even-odd sweep over their
    // combined contours IS their union — and it dissolves the edges two
    // adjacent faces share (each such edge has inside on both sides, so
    // it never comes back out as exterior).
    let merged: Vec<SimpleBezierPath> = path_remove_overlapped_points(&loops, PLANAR_ACCURACY);
    let merged: Vec<SimpleBezierPath> = merged.into_iter().filter(|p| !is_sliver(p)).collect();
    flo_to_idml_path(&merged)
}

/// Every EDGE of the arrangement, split at each crossing, as an open
/// two-anchor path plus the index of the input that contributed it.
/// Backs the Outline verb (fills become strokes along the component
/// line segments).
pub fn arrangement_edges(
    inputs: &[(Vec<PathAnchor>, Vec<usize>)],
) -> Result<Vec<(usize, Vec<PathAnchor>)>, PlanarError> {
    if inputs.len() > MAX_PLANAR_INPUTS {
        return Err(PlanarError::TooManyInputs {
            count: inputs.len(),
            cap: MAX_PLANAR_INPUTS,
        });
    }
    let flo = to_flo(inputs)?;
    check_collision_budget(&flo, MAX_PLANAR_COLLISION_PAIRS)?;
    let graph = build_graph(&flo);
    let mut out: Vec<(usize, Vec<PathAnchor>)> = Vec::new();
    for edge_ref in graph.all_edge_refs().collect::<Vec<_>>() {
        let edge = graph.get_edge(edge_ref);
        let start = edge.start_point();
        let end = edge.end_point();
        let (cp1, cp2) = edge.control_points();
        // Degenerate (zero-length) edges are collision artefacts, not
        // segments anyone can stroke.
        if (start.x() - end.x()).abs() < 1e-6 && (start.y() - end.y()).abs() < 1e-6 {
            continue;
        }
        let PathLabel(label) = graph.edge_label(edge_ref);
        out.push((
            label as usize,
            vec![
                PathAnchor {
                    anchor: (start.x() as f32, start.y() as f32),
                    left: (start.x() as f32, start.y() as f32),
                    right: (cp1.x() as f32, cp1.y() as f32),
                },
                PathAnchor {
                    anchor: (end.x() as f32, end.y() as f32),
                    left: (cp2.x() as f32, cp2.y() as f32),
                    right: (end.x() as f32, end.y() as f32),
                },
            ],
        ));
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

fn to_flo(
    inputs: &[(Vec<PathAnchor>, Vec<usize>)],
) -> Result<Vec<Vec<SimpleBezierPath>>, PlanarError> {
    // Snapped ONCE here, so the collision pass, the point tests and the
    // standalone union all see identical geometry (C-21).
    let flo: Vec<Vec<SimpleBezierPath>> = inputs
        .iter()
        .map(|(anchors, starts)| idml_path_to_flo_on_grid(anchors, starts, PLANAR_ACCURACY))
        .collect();
    if flo.iter().all(|p| p.is_empty()) {
        return Err(PlanarError::NoGeometry);
    }
    Ok(flo)
}

/// Count the curve pairs whose bounding boxes overlap — exactly the pairs
/// the collision pass will clip against each other — with a sweep over
/// x, and refuse before any of that work starts when the count passes
/// `budget`.
fn check_collision_budget(flo: &[Vec<SimpleBezierPath>], budget: u64) -> Result<u64, PlanarError> {
    let mut boxes: Vec<[f64; 4]> = Vec::new();
    for paths in flo {
        for (start, segments) in paths {
            let mut from = *start;
            for (c1, c2, end) in segments {
                let xs = [from.x(), c1.x(), c2.x(), end.x()];
                let ys = [from.y(), c1.y(), c2.y(), end.y()];
                boxes.push([
                    xs.iter().copied().fold(f64::INFINITY, f64::min),
                    ys.iter().copied().fold(f64::INFINITY, f64::min),
                    xs.iter().copied().fold(f64::NEG_INFINITY, f64::max),
                    ys.iter().copied().fold(f64::NEG_INFINITY, f64::max),
                ]);
                from = *end;
            }
        }
    }
    boxes.sort_by(|a, b| a[0].total_cmp(&b[0]));
    let mut pairs: u64 = 0;
    // The sweep's own work is bounded too: a pathological input whose
    // boxes all overlap in x but not in y still stops here.
    let mut scanned: u64 = 0;
    for i in 0..boxes.len() {
        for j in (i + 1)..boxes.len() {
            if boxes[j][0] > boxes[i][2] {
                break;
            }
            scanned += 1;
            if boxes[j][1] <= boxes[i][3] && boxes[i][1] <= boxes[j][3] {
                pairs += 1;
            }
            if pairs > budget || scanned > budget.saturating_mul(4) {
                return Err(PlanarError::OverBudget {
                    stage: PlanarStage::Collide,
                    work: pairs.max(scanned / 4),
                    budget,
                });
            }
        }
    }
    Ok(pairs)
}

/// Every horizontal or vertical straight segment of the inputs (on the
/// grid already: the inputs are snapped).
fn axis_lines(flo: &[Vec<SimpleBezierPath>]) -> Vec<AxisLine> {
    let mut out = Vec::new();
    for paths in flo {
        for (start, segments) in paths {
            let mut from = *start;
            for (c1, c2, end) in segments {
                let on = |p: &Coord2, q: &Coord2| {
                    (p.x() - q.x()).abs() < 1e-9 && (p.y() - q.y()).abs() < 1e-9
                };
                let straight_h = from.y() == end.y() && c1.y() == from.y() && c2.y() == from.y();
                let straight_v = from.x() == end.x() && c1.x() == from.x() && c2.x() == from.x();
                if !on(&from, end) {
                    if straight_v {
                        out.push(AxisLine {
                            vertical: true,
                            at: from.x(),
                            from: from.y().min(end.y()),
                            to: from.y().max(end.y()),
                        });
                    } else if straight_h {
                        out.push(AxisLine {
                            vertical: false,
                            at: from.y(),
                            from: from.x().min(end.x()),
                            to: from.x().max(end.x()),
                        });
                    }
                }
                from = *end;
            }
        }
    }
    out
}

/// Merge every input (labelled by its index) into one graph and split
/// every curve at every crossing — including an input's crossings with
/// ITSELF, which is what makes a self-intersecting input arrange
/// correctly (its doubly-wound lobe reads as outside, the even-odd
/// convention flo_curves uses throughout).
fn build_graph(flo: &[Vec<SimpleBezierPath>]) -> GraphPath<Coord2, PathLabel> {
    let labelled: Vec<(&SimpleBezierPath, PathLabel)> = flo
        .iter()
        .enumerate()
        .flat_map(|(i, paths)| paths.iter().map(move |p| (p, PathLabel(i as u32))))
        .collect();
    let mut graph = GraphPath::from_merged_paths(labelled.iter().map(|(p, l)| (*p, *l)));
    graph.self_collide(PLANAR_ACCURACY);
    graph
}

/// Group one face's boundary cycles into components: every positive
/// cycle is an outer contour; every negative one a hole of the smallest
/// outer contour around it. `(outer, holes, area)`.
fn components_of(dcel: &Dcel, cycles: Vec<Vec<u32>>) -> Vec<(Vec<u32>, Vec<Vec<u32>>, f64)> {
    let mut outers: Vec<(Vec<u32>, f64, Vec<Vec<u32>>)> = Vec::new();
    let mut holes: Vec<(Vec<u32>, f64)> = Vec::new();
    for c in cycles {
        let area = dcel.cycle_area(&c);
        if area > 0.0 {
            outers.push((c, area, Vec::new()));
        } else {
            holes.push((c, area));
        }
    }
    outers.sort_by(|a, b| a.1.total_cmp(&b.1));
    for (hole, _) in holes {
        if outers.is_empty() {
            break;
        }
        let probe = dcel.cubic(hole[0]).eval(0.5);
        let host = if outers.len() == 1 {
            0
        } else {
            outers
                .iter()
                .position(|(o, _, _)| dcel.winding_of(o, probe) != 0)
                .unwrap_or(outers.len() - 1)
        };
        outers[host].2.push(hole);
    }
    outers
        .into_iter()
        .map(|(o, area, hs)| {
            let hole_area: f64 = hs.iter().map(|h| dcel.cycle_area(h).abs()).sum();
            (o, hs, (area - hole_area).max(0.0))
        })
        .collect()
}

/// Half-edge cycles → one anchor table with a subpath per cycle.
fn contours_to_anchors<'a>(
    dcel: &Dcel,
    contours: impl Iterator<Item = &'a [u32]>,
) -> (Vec<PathAnchor>, Vec<usize>) {
    let f = |p: P| (p.0 as f32, p.1 as f32);
    let mut anchors = Vec::new();
    let mut starts = Vec::new();
    for hes in contours {
        if hes.is_empty() {
            continue;
        }
        starts.push(anchors.len());
        let k = hes.len();
        // Start where `flo_curves`' exterior walk (which the faces used to
        // come from) starts: the first vertex in ITS point order — x
        // quantised into 0.01 pt columns, then y — so an outline that did
        // not change keeps its first anchor.
        let column = |p: P| (p.0 / 0.01).floor();
        let first = (0..k)
            .min_by(|a, b| {
                let (pa, pb) = (dcel.cubic(hes[*a]).p0, dcel.cubic(hes[*b]).p0);
                column(pa)
                    .total_cmp(&column(pb))
                    .then(pa.1.total_cmp(&pb.1))
            })
            .unwrap_or(0);
        for j in 0..k {
            let i = (first + j) % k;
            let c = dcel.cubic(hes[i]);
            let prev = dcel.cubic(hes[(i + k - 1) % k]);
            anchors.push(PathAnchor {
                anchor: f(c.p0),
                left: f(prev.c2),
                right: f(c.c1),
            });
        }
    }
    (anchors, starts)
}

/// A cycle thinner than the arrangement's resolution everywhere (area
/// below `accuracy × perimeter`): a lens two nearly coincident curves
/// leave, not a region.
fn is_sliver_cycle(dcel: &Dcel, hes: &[u32], area: f64) -> bool {
    let perimeter: f64 = hes
        .iter()
        .map(|h| {
            let c = dcel.cubic(*h);
            ((c.p3.0 - c.p0.0).powi(2) + (c.p3.1 - c.p0.1).powi(2)).sqrt()
        })
        .sum();
    area.abs() < PLANAR_ACCURACY * perimeter
}

fn paths_bbox(paths: &[SimpleBezierPath]) -> [f64; 4] {
    let mut b = [
        f64::INFINITY,
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::NEG_INFINITY,
    ];
    for (start, segments) in paths {
        for p in std::iter::once(start).chain(segments.iter().flat_map(|(c1, c2, e)| [c1, c2, e])) {
            b[0] = b[0].min(p.x());
            b[1] = b[1].min(p.y());
            b[2] = b[2].max(p.x());
            b[3] = b[3].max(p.y());
        }
    }
    b
}

/// [`signature_at`] with each input's bounding box tested first, so a
/// face only pays for the inputs that could contain it.
fn signature_at_boxed(
    flo: &[Vec<SimpleBezierPath>],
    boxes: &[[f64; 4]],
    point: Coord2,
) -> Option<Vec<usize>> {
    let mut signature = Vec::new();
    for (i, paths) in flo.iter().enumerate() {
        let b = boxes[i];
        if point.x() < b[0] || point.x() > b[2] || point.y() < b[1] || point.y() > b[3] {
            continue;
        }
        match point_inside(paths, point) {
            Some(true) => signature.push(i),
            Some(false) => {}
            None => return None,
        }
    }
    Some(signature)
}

/// The containment signature at a point: which inputs' interiors hold
/// it. `None` when any input's test was ambiguous (the point sits on an
/// outline) — the caller drops the probe rather than guessing.
fn signature_at(flo: &[Vec<SimpleBezierPath>], point: Coord2) -> Option<Vec<usize>> {
    let mut signature = Vec::new();
    for (i, paths) in flo.iter().enumerate() {
        match point_inside(paths, point) {
            Some(true) => signature.push(i),
            Some(false) => {}
            None => return None,
        }
    }
    Some(signature)
}

/// Even-odd point-in-path over one input's subpaths.
///
/// `None` when no probe direction gave an unambiguous answer (the point
/// sits on the outline, or every ray we tried grazed a joint) — the
/// caller drops that probe rather than guessing.
fn point_inside(paths: &[SimpleBezierPath], point: Coord2) -> Option<bool> {
    if paths.is_empty() {
        return Some(false);
    }
    // Directions chosen to be off-axis and mutually non-parallel, so a
    // path that is tangent to one is not tangent to the next.
    const DIRECTIONS: [(f64, f64); 4] = [
        (0.930_2, 0.367_0),
        (-0.317_1, 0.948_4),
        (0.634_9, -0.772_6),
        (-0.881_3, -0.472_5),
    ];
    let reach = paths
        .iter()
        .flat_map(|(start, segments)| {
            std::iter::once(*start).chain(segments.iter().map(|(_, _, end)| *end))
        })
        .fold(1.0_f64, |acc, p| {
            acc.max((p.x() - point.x()).abs())
                .max((p.y() - point.y()).abs())
        })
        * 4.0;
    for (dx, dy) in DIRECTIONS {
        let far = Coord2(point.x() + dx * reach, point.y() + dy * reach);
        let ray = (point, far);
        let mut crossings = 0usize;
        let mut ambiguous = false;
        for path in paths {
            for (_section, curve_t, line_t) in path_intersects_ray(path, &ray) {
                // A hit at the ray's origin means the probe sits ON the
                // outline; a hit at a segment joint would be counted
                // twice. Both make this direction unusable.
                if line_t < 1e-9 || !(1e-6..=1.0 - 1e-6).contains(&curve_t) {
                    ambiguous = true;
                    break;
                }
                crossings += 1;
            }
            if ambiguous {
                break;
            }
        }
        if !ambiguous {
            return Some(crossings % 2 == 1);
        }
    }
    None
}

/// True when a loop is thinner than the arrangement's own numerical
/// resolution EVERYWHERE — area below `accuracy × perimeter` means an
/// average width under `accuracy`.
fn is_sliver(path: &SimpleBezierPath) -> bool {
    let (start, segments) = path;
    let mut perimeter = 0.0;
    let mut from = *start;
    for (_, _, end) in segments {
        perimeter += ((end.x() - from.x()).powi(2) + (end.y() - from.y()).powi(2)).sqrt();
        from = *end;
    }
    path_area(path).abs() < PLANAR_ACCURACY * perimeter
}

/// Signed area of one closed cubic path via Green's theorem. The
/// integrand is degree 5 in `t`, so a 3-point Gauss-Legendre rule
/// integrates it EXACTLY — no flattening, no tolerance.
fn path_area(path: &SimpleBezierPath) -> f64 {
    let (start, segments) = path;
    let mut total = 0.0;
    let mut from = *start;
    for (cp1, cp2, end) in segments {
        let c = crate::planar_dcel::Cubic {
            p0: (from.x(), from.y()),
            c1: (cp1.x(), cp1.y()),
            c2: (cp2.x(), cp2.y()),
            p3: (end.x(), end.y()),
        };
        total += c.area_term();
        from = *end;
    }
    total
}

/// Unsigned area of a region given as a loop set.
///
/// Deliberately orientation-AGNOSTIC: nesting depth decides — a loop at
/// even depth is an outer contour and adds, a loop at odd depth is a
/// hole and subtracts.
#[cfg(test)]
fn region_area(loops: &[SimpleBezierPath]) -> f64 {
    let usable: Vec<&SimpleBezierPath> = loops.iter().filter(|p| !p.1.is_empty()).collect();
    let mut total = 0.0;
    for (k, loop_k) in usable.iter().enumerate() {
        let depth = usable
            .iter()
            .enumerate()
            .filter(|(j, other)| {
                *j != k && point_inside(std::slice::from_ref(**other), loop_k.0).unwrap_or(false)
            })
            .count();
        let area = path_area(loop_k).abs();
        if depth % 2 == 0 {
            total += area;
        } else {
            total -= area;
        }
    }
    total.max(0.0)
}

fn face_id(signature: &[usize], component: usize) -> String {
    let sig = signature
        .iter()
        .map(|i| i.to_string())
        .collect::<Vec<_>>()
        .join("-");
    format!("{sig}#{component}")
}

/// Ordering key for components of the same signature: the top-left-most
/// anchor, rounded so float wobble can't reshuffle ids between calls.
fn component_key(anchors: &[PathAnchor]) -> (f64, f64) {
    let mut best = (f64::INFINITY, f64::INFINITY);
    for a in anchors {
        let key = (
            (a.anchor.0 as f64 * 1000.0).round() / 1000.0,
            (a.anchor.1 as f64 * 1000.0).round() / 1000.0,
        );
        if key < best {
            best = key;
        }
    }
    best
}

fn order_key(face: &PlanarFace) -> (f64, f64) {
    component_key(&face.anchors)
}

/// Total order over `(f64, f64)` sort keys, so a NaN coordinate cannot panic
/// the sort (ADR 031). Identical to `partial_cmp` on finite keys: `+ 0.0`
/// folds `-0.0` into `+0.0` (which `total_cmp` alone would order apart),
/// so rounded keys keep the face/component ids they had.
fn key_cmp(a: (f64, f64), b: (f64, f64)) -> std::cmp::Ordering {
    (a.0 + 0.0)
        .total_cmp(&(b.0 + 0.0))
        .then_with(|| (a.1 + 0.0).total_cmp(&(b.1 + 0.0)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bezier_conv::{idml_path_to_flo, FLO_SORT_EPSILON};

    /// A closed circle as four cubic arcs (the standard 0.5523 kappa).
    fn circle(cx: f32, cy: f32, r: f32) -> Vec<PathAnchor> {
        let k = r * 0.552_284_8;
        vec![
            PathAnchor {
                anchor: (cx, cy - r),
                left: (cx - k, cy - r),
                right: (cx + k, cy - r),
            },
            PathAnchor {
                anchor: (cx + r, cy),
                left: (cx + r, cy - k),
                right: (cx + r, cy + k),
            },
            PathAnchor {
                anchor: (cx, cy + r),
                left: (cx + k, cy + r),
                right: (cx - k, cy + r),
            },
            PathAnchor {
                anchor: (cx - r, cy),
                left: (cx - r, cy + k),
                right: (cx - r, cy - k),
            },
        ]
    }

    fn rect(left: f32, top: f32, right: f32, bottom: f32) -> Vec<PathAnchor> {
        let p = |x: f32, y: f32| PathAnchor {
            anchor: (x, y),
            left: (x, y),
            right: (x, y),
        };
        vec![
            p(left, top),
            p(right, top),
            p(right, bottom),
            p(left, bottom),
        ]
    }

    fn input(anchors: Vec<PathAnchor>) -> (Vec<PathAnchor>, Vec<usize>) {
        (anchors, vec![0])
    }

    fn signatures(arr: &PlanarArrangement) -> Vec<Vec<usize>> {
        let mut sigs: Vec<Vec<usize>> = arr.faces.iter().map(|f| f.signature.clone()).collect();
        sigs.sort();
        sigs
    }

    #[test]
    fn two_overlapping_circles_resolve_three_faces() {
        let arr =
            build_arrangement(&[input(circle(0.0, 0.0, 10.0)), input(circle(8.0, 0.0, 10.0))])
                .expect("arrangement");
        assert_eq!(arr.faces.len(), 3, "A-only, B-only, A∩B");
        assert_eq!(signatures(&arr), vec![vec![0], vec![0, 1], vec![1]]);
        assert!(arr.complete, "faces must tile the union");
    }

    #[test]
    fn three_circle_venn_resolves_seven_faces() {
        let arr = build_arrangement(&[
            input(circle(0.0, 0.0, 10.0)),
            input(circle(9.0, 0.0, 10.0)),
            input(circle(4.5, 8.0, 10.0)),
        ])
        .expect("arrangement");
        assert_eq!(arr.faces.len(), 7, "the classic 7-region Venn diagram");
        assert_eq!(
            signatures(&arr),
            vec![
                vec![0],
                vec![0, 1],
                vec![0, 1, 2],
                vec![0, 2],
                vec![1],
                vec![1, 2],
                vec![2],
            ]
        );
        assert!(arr.complete);
    }

    #[test]
    fn disjoint_shapes_stay_one_face_each() {
        let arr = build_arrangement(&[
            input(rect(0.0, 0.0, 10.0, 10.0)),
            input(rect(50.0, 50.0, 60.0, 60.0)),
        ])
        .expect("arrangement");
        assert_eq!(arr.faces.len(), 2);
        assert_eq!(signatures(&arr), vec![vec![0], vec![1]]);
        for face in &arr.faces {
            assert!((face.area - 100.0).abs() < 1e-2, "area {}", face.area);
        }
        assert!(arr.complete);
    }

    #[test]
    fn nested_shapes_make_a_ring_face_with_a_hole() {
        // A strictly contains B: two faces — the ring (A only) and the
        // disc (A and B). The ring is ONE face carrying a hole.
        let arr = build_arrangement(&[input(circle(0.0, 0.0, 20.0)), input(circle(0.0, 0.0, 8.0))])
            .expect("arrangement");
        assert_eq!(arr.faces.len(), 2);
        let ring = arr
            .faces
            .iter()
            .find(|f| f.signature == vec![0])
            .expect("ring face");
        assert_eq!(ring.subpath_starts.len(), 2, "outer contour + hole");
        let disc = arr
            .faces
            .iter()
            .find(|f| f.signature == vec![0, 1])
            .expect("disc face");
        assert_eq!(disc.subpath_starts.len(), 1);
        // π(20² − 8²) ≈ 1055.6, π·8² ≈ 201.1 (the cubic circle
        // approximation is accurate to ~0.02%).
        assert!((ring.area - 1055.6).abs() < 2.0, "ring area {}", ring.area);
        assert!((disc.area - 201.1).abs() < 1.0, "disc area {}", disc.area);
        assert!(arr.complete);
    }

    #[test]
    fn a_split_in_two_yields_two_components_of_one_signature() {
        // A wide bar crossed by a taller bar: the wide bar's exclusive
        // area falls into TWO disconnected components, so one signature
        // yields two faces with distinct ids.
        let arr = build_arrangement(&[
            input(rect(0.0, 4.0, 30.0, 6.0)),
            input(rect(10.0, 0.0, 20.0, 10.0)),
        ])
        .expect("arrangement");
        let bar_only: Vec<&PlanarFace> = arr
            .faces
            .iter()
            .filter(|f| f.signature == vec![0])
            .collect();
        assert_eq!(bar_only.len(), 2, "left stub + right stub");
        assert_ne!(bar_only[0].id, bar_only[1].id);
        assert_eq!(bar_only[0].id, "0#0");
        assert_eq!(bar_only[1].id, "0#1");
        assert!(arr.complete);
    }

    #[test]
    fn self_intersecting_input_reads_even_odd() {
        // A bow-tie: two triangular lobes meeting at a crossing. Each
        // lobe is its own face of signature {0}.
        let p = |x: f32, y: f32| PathAnchor {
            anchor: (x, y),
            left: (x, y),
            right: (x, y),
        };
        let bowtie = vec![p(0.0, 0.0), p(10.0, 10.0), p(0.0, 10.0), p(10.0, 0.0)];
        let arr = build_arrangement(&[(bowtie, vec![0])]).expect("arrangement");
        assert_eq!(arr.faces.len(), 2, "two lobes");
        for face in &arr.faces {
            assert_eq!(face.signature, vec![0]);
            // Each lobe is the triangle (5,5)-(10,10)-(0,10) (and its
            // mirror): ½ · base 10 · height 5 = 25.
            assert!((face.area - 25.0).abs() < 0.5, "lobe area {}", face.area);
        }
    }

    #[test]
    fn tangent_contact_does_not_invent_a_face() {
        // Two circles touching at exactly one point: no overlap area,
        // so two faces and no {0,1}.
        let arr = build_arrangement(&[
            input(circle(0.0, 0.0, 10.0)),
            input(circle(20.0, 0.0, 10.0)),
        ])
        .expect("arrangement");
        assert_eq!(signatures(&arr), vec![vec![0], vec![1]]);
        assert!(arr.faces.iter().all(|f| f.signature.len() == 1));
    }

    #[test]
    fn shared_edge_contact_does_not_invent_a_face() {
        // Two rectangles sharing a full edge — the degenerate case the
        // collision code has to order consistently.
        let arr = build_arrangement(&[
            input(rect(0.0, 0.0, 10.0, 10.0)),
            input(rect(10.0, 0.0, 20.0, 10.0)),
        ])
        .expect("arrangement");
        assert_eq!(signatures(&arr), vec![vec![0], vec![1]]);
    }

    #[test]
    fn faces_are_disjoint_and_tile_the_union() {
        // The core invariant, checked directly: no two faces overlap,
        // and together they cover the union exactly.
        let inputs = vec![
            input(circle(0.0, 0.0, 10.0)),
            input(circle(9.0, 0.0, 10.0)),
            input(rect(-4.0, -4.0, 14.0, 4.0)),
        ];
        let arr = build_arrangement(&inputs).expect("arrangement");
        assert!(
            arr.complete,
            "faces {} union {}",
            arr.faces_area, arr.union_area
        );
        for (i, a) in arr.faces.iter().enumerate() {
            for b in arr.faces.iter().skip(i + 1) {
                // C-21: on the grid here too. Face outlines carry the
                // crossing points the graph invented, which are NOT
                // grid-aligned, and this is a real boolean call — the
                // rule "nothing unsnapped enters flo_curves" has no
                // exemption for test code.
                let overlap = flo_curves::bezier::path::path_intersect::<SimpleBezierPath>(
                    &idml_path_to_flo_on_grid(&a.anchors, &a.subpath_starts, PLANAR_ACCURACY),
                    &idml_path_to_flo_on_grid(&b.anchors, &b.subpath_starts, PLANAR_ACCURACY),
                    PLANAR_ACCURACY,
                );
                let area = region_area(&overlap);
                assert!(area < 1e-2, "faces {} and {} overlap by {area}", a.id, b.id);
            }
        }
    }

    #[test]
    fn face_at_point_answers_the_hover_query() {
        let inputs = vec![input(circle(0.0, 0.0, 10.0)), input(circle(8.0, 0.0, 10.0))];
        // (4, 0) is in both circles.
        let both = face_at_point(&inputs, (4.0, 0.0))
            .expect("query")
            .expect("a face under the point");
        assert_eq!(both.signature, vec![0, 1]);
        // (-8, 0) is only in the first.
        let left = face_at_point(&inputs, (-8.0, 0.0))
            .expect("query")
            .expect("a face under the point");
        assert_eq!(left.signature, vec![0]);
        // Far away: no face.
        assert!(face_at_point(&inputs, (100.0, 100.0))
            .expect("query")
            .is_none());
    }

    #[test]
    fn face_at_point_ids_match_the_full_enumeration() {
        let inputs = vec![
            input(rect(0.0, 4.0, 30.0, 6.0)),
            input(rect(10.0, 0.0, 20.0, 10.0)),
        ];
        let arr = build_arrangement(&inputs).expect("arrangement");
        for face in &arr.faces {
            let hit = face_at_point(&inputs, face.inside)
                .expect("query")
                .expect("the representative point must land on its own face");
            assert_eq!(hit.id, face.id, "signature {:?}", face.signature);
        }
    }

    #[test]
    fn union_of_all_faces_recovers_the_union_of_inputs() {
        let inputs = vec![input(circle(0.0, 0.0, 10.0)), input(circle(8.0, 0.0, 10.0))];
        let arr = build_arrangement(&inputs).expect("arrangement");
        let refs: Vec<&PlanarFace> = arr.faces.iter().collect();
        let (anchors, starts) = union_faces(&refs);
        let merged = idml_path_to_flo(&anchors, &starts);
        assert_eq!(merged.len(), 1, "one clean outline, no internal edges");
        assert!((region_area(&merged) - arr.union_area).abs() < 1e-1);
    }

    #[test]
    fn arrangement_edges_split_at_every_crossing() {
        // Two crossing rectangles: each contributes 4 sides, and the 8
        // crossings split them into 8 + 8 pieces.
        let edges = arrangement_edges(&[
            input(rect(0.0, 4.0, 30.0, 6.0)),
            input(rect(10.0, 0.0, 20.0, 10.0)),
        ])
        .expect("edges");
        assert_eq!(edges.len(), 16);
        assert_eq!(edges.iter().filter(|(label, _)| *label == 0).count(), 8);
        assert_eq!(edges.iter().filter(|(label, _)| *label == 1).count(), 8);
    }

    #[test]
    fn too_many_inputs_is_an_honest_refusal() {
        let inputs: Vec<(Vec<PathAnchor>, Vec<usize>)> = (0..MAX_PLANAR_INPUTS + 1)
            .map(|i| input(rect(i as f32, 0.0, i as f32 + 5.0, 5.0)))
            .collect();
        assert_eq!(
            build_arrangement(&inputs).unwrap_err(),
            PlanarError::TooManyInputs {
                count: MAX_PLANAR_INPUTS + 1,
                cap: MAX_PLANAR_INPUTS
            }
        );
        assert_eq!(
            face_at_point(&inputs, (1.0, 1.0)).unwrap_err(),
            PlanarError::TooManyInputs {
                count: MAX_PLANAR_INPUTS + 1,
                cap: MAX_PLANAR_INPUTS
            }
        );
    }

    /// C-21 GUARD — do not lower [`PLANAR_ACCURACY`].
    ///
    /// It is the grid every arrangement input is snapped onto, and the
    /// grid is what keeps `flo_curves`' `exterior_paths` point sort a
    /// strict weak ordering. A violated ordering is an abort, not a
    /// wrong pixel. Two properties: the step must exceed the
    /// comparator's hardcoded epsilon, and it must exceed it in f64
    /// ARITHMETIC at every reachable magnitude — a nominal 0.01 grid
    /// (this constant's previous value) fails the second test.
    #[test]
    fn planar_accuracy_grid_separates_above_the_flo_curves_sort_epsilon() {
        // `accuracy > FLO_SORT_EPSILON` is asserted at COMPILE time next
        // to the constant; the m = 0 step below re-checks it, and the rest
        // of the loop checks what a const assert cannot — that the
        // separation survives f64 arithmetic at every reachable magnitude.
        assert_eq!(
            PLANAR_ACCURACY.log2(),
            PLANAR_ACCURACY.log2().round(),
            "accuracy must be a power of two so the grid is exact in f64"
        );
        for m in -200_000_i64..=200_000 {
            let lo = (m as f64) * PLANAR_ACCURACY;
            let hi = ((m + 1) as f64) * PLANAR_ACCURACY;
            assert!(
                hi - lo > FLO_SORT_EPSILON,
                "grid step collapses under f64 at m={m}: {lo} → {hi}"
            );
        }
    }

    /// C-21 REGRESSION — arranging near-aligned anchors used to ABORT.
    /// A staircase whose x rises 0.006 pt per step while y falls makes
    /// every consecutive triple non-transitive under `exterior_paths`'
    /// comparator; the snap folds those steps into shared grid columns.
    #[test]
    fn dense_near_aligned_anchors_do_not_abort_the_arrangement() {
        let p = |x: f32, y: f32| PathAnchor {
            anchor: (x, y),
            left: (x, y),
            right: (x, y),
        };
        let mut comb = vec![p(0.0, 0.0)];
        for k in 1..40 {
            let x = k as f32 * 0.006;
            let y = -(k as f32);
            comb.push(p(x, y - 0.5));
            comb.push(p(x, y));
        }
        comb.extend([p(100.0, -40.0), p(100.0, 5.0), p(-5.0, 5.0)]);
        let arr = build_arrangement(&[input(comb), input(rect(-2.0, -2.0, 50.0, 2.0))])
            .expect("arrangement");
        assert!(!arr.faces.is_empty(), "overlapping shapes resolve faces");
    }

    #[test]
    fn empty_geometry_is_refused() {
        assert_eq!(
            build_arrangement(&[(Vec::new(), Vec::new())]).unwrap_err(),
            PlanarError::NoGeometry
        );
    }

    #[test]
    fn face_ids_are_stable_across_calls() {
        let inputs = vec![
            input(circle(0.0, 0.0, 10.0)),
            input(circle(9.0, 0.0, 10.0)),
            input(circle(4.5, 8.0, 10.0)),
        ];
        let a = build_arrangement(&inputs).expect("arrangement");
        let b = build_arrangement(&inputs).expect("arrangement");
        let ids_a: Vec<&str> = a.faces.iter().map(|f| f.id.as_str()).collect();
        let ids_b: Vec<&str> = b.faces.iter().map(|f| f.id.as_str()).collect();
        assert_eq!(ids_a, ids_b);
    }

    /// Property-style sweep over pseudo-random shape sets: the faces
    /// must tile the union exactly, carry unique ids, and each report an
    /// interior point whose containment set is its own signature.
    #[test]
    fn random_shape_sets_tile_their_union() {
        // Deterministic LCG — a fixed seed keeps a failure
        // reproducible, which a real rng would not. 300 cases keeps the
        // unit run ~2.5 s; the same sweep was taken to 1500 cases
        // locally (12 s) while the kernel was being hardened, and it was
        // this sweep that found BOTH real defects: the orientation bug
        // in `region_area` and the `heal_exterior_gaps` impostor face.
        let mut state: u64 = 0x2026_0803;
        let mut next = |lo: f32, hi: f32| {
            state = state
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            let unit = ((state >> 33) as f32) / ((1u64 << 31) as f32);
            lo + unit * (hi - lo)
        };
        for case in 0..300 {
            let count = 2 + (case % 4);
            // Mix straight-edged and curved inputs so the sweep covers
            // line/line, line/curve AND curve/curve crossings.
            let inputs: Vec<(Vec<PathAnchor>, Vec<usize>)> = (0..count)
                .map(|k| {
                    let x = next(0.0, 40.0);
                    let y = next(0.0, 40.0);
                    if (case + k) % 2 == 0 {
                        let w = next(8.0, 30.0);
                        let h = next(8.0, 30.0);
                        input(rect(x, y, x + w, y + h))
                    } else {
                        input(circle(x, y, next(6.0, 18.0)))
                    }
                })
                .collect();
            let arr = build_arrangement(&inputs).expect("arrangement");
            // 1. The faces tile the union: nothing missed, nothing extra.
            assert!(
                arr.complete,
                "case {case}: faces {} vs union {}",
                arr.faces_area, arr.union_area
            );
            // 2. Ids are unique — they are how callers address a face.
            let mut ids: Vec<&str> = arr.faces.iter().map(|f| f.id.as_str()).collect();
            ids.sort_unstable();
            let unique = ids.len();
            ids.dedup();
            assert_eq!(ids.len(), unique, "case {case}: duplicate face id");
            // 3. Every face's reported interior point really is inside
            //    it, and its signature is the containment set there.
            for face in &arr.faces {
                let hit = face_at_point(&inputs, face.inside)
                    .expect("query")
                    .unwrap_or_else(|| {
                        panic!("case {case}: {} has no face at {:?}", face.id, face.inside)
                    });
                assert_eq!(hit.id, face.id, "case {case}");
                assert_eq!(hit.signature, face.signature, "case {case}");
            }
            // 4. Disjointness follows from (1): every face lies inside
            //    the union, so faces summing to exactly the union area
            //    cannot overlap. The explicit pairwise boolean check
            //    lives in `faces_are_disjoint_and_tile_the_union` on
            //    fixed geometry — running N² `path_intersect`s over
            //    hundreds of random cases trips a LATENT flo_curves 0.8
            //    bug (see the residual note on `materialize`).
        }
    }
}
