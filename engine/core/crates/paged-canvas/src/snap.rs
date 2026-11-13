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

//! Gesture snapping (engine ADR 125).
//!
//! `update_gesture` runs one of these passes on every update and stores
//! the snapped delta on the session, so the commit lands exactly where the
//! last preview did. Each pass takes the raw pointer delta and returns the
//! delta adjusted onto its targets, the lines the overlay draws and the
//! targets it now holds:
//!
//! * [`compute_snap_adjustment_with`] — translate: the moving items'
//!   edges and centres (a rotated item through its oriented box) align
//!   with the page's edges and centre lines, its margins and columns,
//!   ruler guides, the grid and the other items' edges and centres, or
//!   take an equal gap between neighbours; Snap to Pixel takes an axis
//!   nothing else did.
//! * [`compute_resize_snap`] — the edges a resize handle moves.
//! * [`compute_scale_snap`] — the dragged handle of a scale.
//! * [`compute_rotate_snap`] — a turn onto 0/45/90° or another item's angle.
//!
//! Tolerances are screen pixels at the CURRENT camera scale (the session's
//! `camera_scale`, refreshed by every update that carries one): a target
//! is acquired within [`SNAP_TOLERANCE_CSS_PX`] and, once held, released
//! only beyond [`SNAP_RELEASE_CSS_PX`] (hysteresis, `UXI-SNP-003`), unless
//! another target within the acquire tolerance is strictly nearer. The
//! held target lives on the session ([`SnapHold`]). Among targets at the
//! same distance the ranking is fixed ([`SnapTargetKind`]'s order, then
//! position), so one document, camera, pointer and history always snap
//! the same way (`UXI-SNP-004`). Every line names its target's kind
//! (`UXI-SNP-002`).

use paged_renderer::PageId;
use serde::{Deserialize, Serialize};
use tsify_next::Tsify;

use crate::gesture::GestureSession;

/// Axis the snap line guides. `X` is a vertical guide (snaps the x
/// coordinate); `Y` is a horizontal guide (snaps the y coordinate).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi, missing_as_null)]
#[serde(rename_all = "camelCase")]
pub enum SnapAxis {
    X,
    Y,
}

/// v77 — what a snap line shows. Absent on the wire ⇒ `Alignment`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi, missing_as_null)]
#[serde(rename_all = "camelCase")]
pub enum SnapLineKind {
    /// An x or y line the moving edge, centre or point is on.
    Alignment,
    /// An equal gap: `from` → `to` spans it, `distance` is its width.
    Spacing,
    /// An angle guide (`angle`, degrees clockwise from +x on screen)
    /// from `from` (the point it runs through) to `to`. A rotate
    /// gesture's guide runs from the pivot.
    Angle,
}

/// One active snap line surfaced to the overlay. `position` is in
/// page-local pt on `page_id`.
///
/// v77 — the optional fields carry smart-guide extents and measurement
/// labels (editor ADR 287). An alignment line with `from` / `to` is drawn
/// between them (the point it came through and the snapped point) rather
/// than across the page, and `distance` (pt) is the label the host
/// formats in its units. All are absent from older engines and are
/// omitted from the JSON when unset, so a v76 reader sees the shape it
/// knows.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi, missing_as_null)]
#[serde(rename_all = "camelCase")]
pub struct SnapLine {
    pub axis: SnapAxis,
    pub position: f32,
    pub page_id: PageId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[tsify(optional)]
    pub kind: Option<SnapLineKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[tsify(optional)]
    pub from: Option<[f32; 2]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[tsify(optional)]
    pub to: Option<[f32; 2]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[tsify(optional)]
    pub angle: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[tsify(optional)]
    pub distance: Option<f32>,
    /// v79 (engine ADR 125, amendment 2) — what the line snaps to, for the
    /// overlay's label (`UXI-SNP-002`). Absent from older engines and on an
    /// angle line from a caller-supplied point.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[tsify(optional)]
    pub target_kind: Option<SnapTargetKind>,
}

impl SnapLine {
    /// A full-page alignment line.
    pub fn new(axis: SnapAxis, position: f32, page_id: PageId) -> Self {
        Self {
            axis,
            position,
            page_id,
            kind: None,
            from: None,
            to: None,
            angle: None,
            distance: None,
            target_kind: None,
        }
    }

    /// The line, naming its target's kind.
    pub fn with_target(mut self, kind: SnapTargetKind) -> Self {
        self.target_kind = Some(kind);
        self
    }
}

/// v79 (engine ADR 125, amendment 2) — the kind of target a snap landed on.
/// The declaration order is the ranking among targets at the same
/// distance (`UXI-SNP-001`, `UXI-SNP-004`): the explicit references (ruler
/// guides, margins, columns, the page, the grid) before the other items'
/// geometry, and equal spacing after both.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi)]
#[serde(rename_all = "camelCase")]
pub enum SnapTargetKind {
    /// A ruler guide.
    Guide,
    /// A page margin.
    Margin,
    /// An edge of a column of the page's margin box.
    Column,
    /// A page edge.
    PageEdge,
    /// A page centre line (or the page centre).
    PageCenter,
    /// A document gridline.
    Grid,
    /// A text baseline or the baseline grid. No gesture produces it yet
    /// (ADR 125's list of what is not built); reserved so the label set
    /// is complete on the wire.
    Baseline,
    /// Another item's edge (or a frame corner a point lines up with).
    ObjectEdge,
    /// Another item's centre.
    ObjectCenter,
    /// A path anchor, an oval's quadrant point or where two outlines
    /// cross.
    ObjectPoint,
    /// An equal gap between neighbours.
    EqualSpacing,
    /// An angle: a rotate onto 0/45/90° or another item's angle, or an
    /// angle guide.
    Angle,
    /// A point the caller supplied.
    Point,
    /// A whole point (Snap to Pixel).
    Pixel,
}

impl SnapTargetKind {
    /// The tie-break rank: lower wins among targets at the same distance.
    pub fn rank(self) -> u8 {
        self as u8
    }

    /// The kind of a point resolver's source; `position` and `extent`
    /// tell a page centre line from a page edge.
    pub(crate) fn of_source(
        source: crate::snap_point::SnapSource,
        position: f32,
        extent: f32,
    ) -> Self {
        use crate::snap_point::SnapSource as S;
        match source {
            S::Page if (position - extent * 0.5).abs() < 1e-3 => Self::PageCenter,
            S::Page => Self::PageEdge,
            S::Guide => Self::Guide,
            S::Margin => Self::Margin,
            S::Column => Self::Column,
            S::Grid => Self::Grid,
            S::Corner => Self::ObjectEdge,
            S::Center => Self::ObjectCenter,
            S::AnchorPoint | S::Intersection => Self::ObjectPoint,
            S::Extra => Self::Point,
            S::Pixel => Self::Pixel,
            S::Angle => Self::Angle,
            S::Spacing => Self::EqualSpacing,
        }
    }
}

/// v79 — a target a gesture holds on one axis (or, for a rotate, an
/// angle), kept on the session between updates for the release
/// hysteresis.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct HeldTarget {
    pub page_id: PageId,
    /// Page-local pt (the line's position; for an equal gap, where the
    /// selection's leading edge lands), or degrees for an angle.
    pub position: f32,
    pub kind: SnapTargetKind,
}

/// v79 — the targets a gesture holds, per axis.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct SnapHold {
    pub x: Option<HeldTarget>,
    pub y: Option<HeldTarget>,
    pub angle: Option<HeldTarget>,
}

/// Snap-adjusted delta + the active guides. Returned by
/// `compute_snap_adjustment`.
#[derive(Debug, Default, Clone)]
pub struct SnapAdjustment {
    pub delta: (f32, f32),
    pub lines: Vec<SnapLine>,
    /// v79 — the targets held after this update.
    pub(crate) hold: SnapHold,
}

impl SnapAdjustment {
    /// The raw delta, nothing snapped, nothing held.
    pub(crate) fn pass(delta: (f32, f32)) -> Self {
        Self {
            delta,
            ..Self::default()
        }
    }
}

/// Snap tolerance expressed in CSS px: a target within it is ACQUIRED.
/// Converted to doc-space pt through the current camera scale, so the
/// snap behaves the same at every zoom.
pub const SNAP_TOLERANCE_CSS_PX: f32 = 4.0;

/// v79 — a held target is RELEASED only beyond this distance, CSS px
/// (hysteresis, `UXI-SNP-003`). A session whose tolerance is not the
/// default scales it in the same proportion.
pub const SNAP_RELEASE_CSS_PX: f32 = 6.0;

/// The acquire and release tolerances of a gesture, pt, at its current
/// camera scale.
fn tolerances(session: &GestureSession, env: &SnapEnv) -> (f32, f32) {
    let scale = session.camera_scale.unwrap_or(1.0).max(1e-3);
    let acquire = env.settings.tolerance_px / scale;
    (
        acquire,
        acquire * SNAP_RELEASE_CSS_PX / SNAP_TOLERANCE_CSS_PX,
    )
}

/// Distances closer than this are a tie, settled by the ranking.
const TIE_PT: f32 = 1e-4;

/// One target within reach of one axis: the adjustment that lands the
/// nearest candidate on it.
#[derive(Debug, Clone)]
struct AxisMatch {
    adjustment: f32,
    target: f32,
    kind: SnapTargetKind,
    page_id: PageId,
    /// Equal spacing: the gap lines to draw.
    gaps: Vec<SnapLine>,
}

impl AxisMatch {
    /// Whether `self` ranks before `other` (`UXI-SNP-004`): nearer first,
    /// then the kind's rank, then the lower position, then the smaller
    /// adjustment, then the page id — a total order, so the choice never
    /// depends on the order the targets were found in.
    fn outranks(&self, other: &AxisMatch) -> bool {
        let (a, b) = (self.adjustment.abs(), other.adjustment.abs());
        if (a - b).abs() > TIE_PT {
            return a < b;
        }
        if self.kind != other.kind {
            return self.kind.rank() < other.kind.rank();
        }
        if (self.target - other.target).abs() > TIE_PT {
            return self.target < other.target;
        }
        if (self.adjustment - other.adjustment).abs() > TIE_PT {
            return self.adjustment < other.adjustment;
        }
        self.page_id.as_str() < other.page_id.as_str()
    }

    fn held(&self) -> HeldTarget {
        HeldTarget {
            page_id: self.page_id.clone(),
            position: self.target,
            kind: self.kind,
        }
    }

    fn holds(&self, held: &HeldTarget) -> bool {
        self.kind == held.kind
            && self.page_id == held.page_id
            && (self.target - held.position).abs() <= 1e-3
    }
}

/// Every target within `reach` of the candidates, each with the
/// adjustment of the candidate nearest it.
fn axis_matches(
    candidates: &[f32],
    targets: &[SnapTarget],
    reach: f32,
    page_id: &PageId,
    out: &mut Vec<AxisMatch>,
) {
    for t in targets {
        let mut best: Option<f32> = None;
        for &c in candidates {
            let d = t.position - c;
            if d.abs() <= reach && best.is_none_or(|b| d.abs() < b.abs() - TIE_PT) {
                best = Some(d);
            }
        }
        if let Some(adjustment) = best {
            out.push(AxisMatch {
                adjustment,
                target: t.position,
                kind: t.kind,
                page_id: page_id.clone(),
                gaps: Vec::new(),
            });
        }
    }
}

/// The hysteresis (`UXI-SNP-003`): the held target stays while it is
/// within the release tolerance (every match is), unless another target
/// within the acquire tolerance is strictly nearer; with nothing held,
/// the best-ranked target within the acquire tolerance is acquired.
fn choose(matches: &[AxisMatch], held: Option<&HeldTarget>, acquire: f32) -> Option<AxisMatch> {
    // Several moving members may reach the held target: the nearest holds.
    let kept = held.and_then(|h| {
        matches
            .iter()
            .enumerate()
            .filter(|(_, m)| m.holds(h))
            .min_by(|(_, a), (_, b)| a.adjustment.abs().total_cmp(&b.adjustment.abs()))
            .map(|(i, _)| i)
    });
    let challenger = matches
        .iter()
        .enumerate()
        .filter(|(i, m)| Some(*i) != kept && m.adjustment.abs() <= acquire)
        .map(|(_, m)| m)
        .fold(None::<&AxisMatch>, |best, m| match best {
            Some(b) if !m.outranks(b) => Some(b),
            _ => Some(m),
        });
    match kept.map(|i| &matches[i]) {
        Some(h) => match challenger {
            Some(c) if c.adjustment.abs() + TIE_PT < h.adjustment.abs() => Some(c.clone()),
            _ => Some(h.clone()),
        },
        None => challenger.cloned(),
    }
}

/// Legacy alias — same value, kept for tests that assert against a
/// doc-space tolerance at camera scale = 1.
pub const SNAP_TOLERANCE_PT: f32 = SNAP_TOLERANCE_CSS_PX;

/// Compute the snap-adjusted delta + active guides for a Translate
/// gesture. Phase H — multi-page aware: each moving frame snaps
/// against its OWN host page's targets; the single shared delta
/// picks the smallest-magnitude adjustment across every
/// (member, target) pair. Pass-through (delta unchanged, lines empty)
/// for any other gesture type or for any rotated member.
#[allow(dead_code)]
pub(crate) fn compute_snap_adjustment(
    session: &GestureSession,
    raw_delta: (f32, f32),
    pages: &[PageInfo],
    siblings: &[FrameRect],
) -> SnapAdjustment {
    compute_snap_adjustment_with(session, raw_delta, pages, siblings, &SnapEnv::default())
}

/// v67 — what a gesture's snap pass reads besides the geometry: the
/// session's settings and the document grid.
#[derive(Debug, Clone, Default)]
pub(crate) struct SnapEnv {
    pub settings: crate::snap_point::SnapSettings,
    /// (horizontal division, vertical division), pt.
    pub grid: Option<(f32, f32)>,
}

impl SnapEnv {
    /// Nearest document gridline to each candidate, when grid snapping is on.
    fn grid_lines(&self, axis: SnapAxis, candidates: &[f32]) -> Vec<f32> {
        if !self.settings.grid {
            return Vec::new();
        }
        let Some((h, v)) = self.grid else {
            return Vec::new();
        };
        let step = match axis {
            SnapAxis::X => v,
            SnapAxis::Y => h,
        };
        candidates
            .iter()
            .map(|c| (c / step).round() * step)
            .collect()
    }
}

pub(crate) fn compute_snap_adjustment_with(
    session: &GestureSession,
    raw_delta: (f32, f32),
    pages: &[PageInfo],
    siblings: &[FrameRect],
    env: &SnapEnv,
) -> SnapAdjustment {
    use crate::gesture::GestureType;
    // Plan-2 §8.4 — the bypass (and snapping off) passes the raw delta
    // through: no lines, nothing held, so a release resumes from scratch.
    if !matches!(session.gesture, GestureType::Translate)
        || !env.settings.enabled
        || session.modifiers.disable_snap
    {
        return SnapAdjustment::pass(raw_delta);
    }
    let (acquire, release) = tolerances(session, env);
    let (dx, dy) = raw_delta;

    // Every target within the release tolerance of a moving member's
    // edges or centre, per axis. v77 — a rotated (or sheared) member
    // snaps through its oriented box: the extremes of its four
    // transformed corners and its centre (`snapshot_aabb_in_page`), which
    // is where its visible edges are. Each member snaps against its own
    // host page's targets, so a line is tagged with its true page.
    let mut xs: Vec<AxisMatch> = Vec::new();
    let mut ys: Vec<AxisMatch> = Vec::new();
    for snap in session.snapshots.iter().filter(|s| !is_group(s)) {
        let Some(page) = host_page_for_snapshot(snap, pages) else {
            continue;
        };
        let Some(aabb) = snapshot_aabb_in_page(snap, &page) else {
            continue;
        };
        let cand_x = [
            aabb.left + dx,
            (aabb.left + aabb.right) * 0.5 + dx,
            aabb.right + dx,
        ];
        let cand_y = [
            aabb.top + dy,
            (aabb.top + aabb.bottom) * 0.5 + dy,
            aabb.bottom + dy,
        ];
        let targets_x = snap_targets_x(&page, siblings, &session.snapshots, env, &cand_x);
        let targets_y = snap_targets_y(&page, siblings, &session.snapshots, env, &cand_y);
        axis_matches(&cand_x, &targets_x, release, &page.page_id, &mut xs);
        axis_matches(&cand_y, &targets_y, release, &page.page_id, &mut ys);
    }

    // v77 — equal spacing: the selection's box between its neighbours (or
    // one gap on from a neighbour pair) competes as one more target; it
    // ranks after the edges, so it wins an axis only when strictly nearer.
    if env.settings.spacing {
        let spacing = spacing_snap(session, raw_delta, pages, siblings, release);
        xs.extend(spacing.x);
        ys.extend(spacing.y);
    }
    let win_x = choose(&xs, session.snap_hold.x.as_ref(), acquire);
    let win_y = choose(&ys, session.snap_hold.y.as_ref(), acquire);

    // v77 — Snap to Pixel: an axis nothing else took lands its box's
    // leading edge on a whole point.
    let pixel = |axis: SnapAxis, raw: f32| -> Option<f32> {
        if !env.settings.pixel {
            return None;
        }
        let snap = session.snapshots.iter().find(|s| !is_group(s))?;
        let page = host_page_for_snapshot(snap, pages)?;
        let aabb = snapshot_aabb_in_page(snap, &page)?;
        let edge = match axis {
            SnapAxis::X => aabb.left,
            SnapAxis::Y => aabb.top,
        } + raw;
        Some(edge.round() - edge)
    };
    let adj_dx = win_x
        .as_ref()
        .map(|m| m.adjustment)
        .or_else(|| pixel(SnapAxis::X, dx))
        .unwrap_or(0.0);
    let adj_dy = win_y
        .as_ref()
        .map(|m| m.adjustment)
        .or_else(|| pixel(SnapAxis::Y, dy))
        .unwrap_or(0.0);
    let mut lines = Vec::new();

    // Plan-2 §8.2 — Smart guides. The snap winner is one alignment;
    // surface every OTHER alignment that's also exactly true after
    // the chosen adjustment so the user sees co-aligned edges they're
    // already on. Pure visual hint — does not affect the delta. We
    // walk each member's candidates against every target and emit a
    // line wherever the post-adjusted candidate hits the target
    // within `SMART_GUIDE_EPSILON_PT` (sub-pixel noise tolerance).
    let post_dx = dx + adj_dx;
    let post_dy = dy + adj_dy;
    for snap in session.snapshots.iter().filter(|s| !is_group(s)) {
        let Some(page) = host_page_for_snapshot(snap, pages) else {
            continue;
        };
        let Some(aabb) = snapshot_aabb_in_page(snap, &page) else {
            continue;
        };
        let cand_x = [
            aabb.left + post_dx,
            (aabb.left + aabb.right) * 0.5 + post_dx,
            aabb.right + post_dx,
        ];
        let cand_y = [
            aabb.top + post_dy,
            (aabb.top + aabb.bottom) * 0.5 + post_dy,
            aabb.bottom + post_dy,
        ];
        let targets_x = snap_targets_x(&page, siblings, &session.snapshots, env, &cand_x);
        let targets_y = snap_targets_y(&page, siblings, &session.snapshots, env, &cand_y);
        for &cand in &cand_x {
            for target in &targets_x {
                if (target.position - cand).abs() <= SMART_GUIDE_EPSILON_PT {
                    push_unique_line(
                        &mut lines,
                        SnapLine::new(SnapAxis::X, target.position, page.page_id.clone())
                            .with_target(target.kind),
                    );
                }
            }
        }
        for &cand in &cand_y {
            for target in &targets_y {
                if (target.position - cand).abs() <= SMART_GUIDE_EPSILON_PT {
                    push_unique_line(
                        &mut lines,
                        SnapLine::new(SnapAxis::Y, target.position, page.page_id.clone())
                            .with_target(target.kind),
                    );
                }
            }
        }
    }

    // The winning snap line is already inside `lines` via the
    // smart-guide pass (its candidate aligns with its target by
    // construction). Keep the winner-first invariant the overlay
    // historically relied on by ensuring it comes first in its axis.
    let spacing = |m: &Option<AxisMatch>| {
        m.as_ref()
            .is_some_and(|m| m.kind == SnapTargetKind::EqualSpacing)
    };
    let (spacing_x, spacing_y) = (spacing(&win_x), spacing(&win_y));
    if !spacing_x {
        promote_winner(&mut lines, win_x.as_ref(), SnapAxis::X);
    }
    if !spacing_y {
        promote_winner(&mut lines, win_y.as_ref(), SnapAxis::Y);
    }
    if spacing_x {
        lines.extend(win_x.iter().flat_map(|m| m.gaps.iter().cloned()));
    }
    if spacing_y {
        lines.extend(win_y.iter().flat_map(|m| m.gaps.iter().cloned()));
    }

    SnapAdjustment {
        delta: (dx + adj_dx, dy + adj_dy),
        lines,
        hold: SnapHold {
            x: win_x.as_ref().map(AxisMatch::held),
            y: win_y.as_ref().map(AxisMatch::held),
            angle: None,
        },
    }
}

/// v77 — the equal-spacing targets of a translate, per axis.
#[derive(Debug, Clone, Default)]
struct SpacingSnap {
    x: Vec<AxisMatch>,
    y: Vec<AxisMatch>,
}

/// v77 — equal spacing for a translate (Illustrator's "equal spacing"
/// smart guide). The moving selection's box (the union of its members'
/// oriented boxes, on the first member's page) is compared with the
/// siblings in its row (for x: those overlapping it vertically) and
/// column (for y). Three positions give equal gaps: centred between the
/// nearest neighbour on each side; one gap on from the nearest neighbour
/// on one side, repeating the gap between it and the next one out; and
/// the same on the other side. Every one within `reach` is a target
/// (kind `EqualSpacing`, positioned where the box's leading edge lands).
fn spacing_snap(
    session: &GestureSession,
    raw_delta: (f32, f32),
    pages: &[PageInfo],
    siblings: &[FrameRect],
    reach: f32,
) -> SpacingSnap {
    let movers: Vec<&crate::gesture::NodeSnapshot> =
        session.snapshots.iter().filter(|s| !is_group(s)).collect();
    let Some(first) = movers.first() else {
        return SpacingSnap::default();
    };
    let Some(page) = host_page_for_snapshot(first, pages) else {
        return SpacingSnap::default();
    };
    let owned: Vec<crate::gesture::NodeSnapshot> = movers.iter().map(|s| (*s).clone()).collect();
    let Some(b) = union_aabb_in_page(&owned, &page) else {
        return SpacingSnap::default();
    };
    let moving_ids: std::collections::HashSet<&crate::element_selection::ElementId> =
        session.snapshots.iter().map(|s| &s.id).collect();
    let others: Vec<[f32; 4]> = siblings
        .iter()
        .filter(|f| f.page_id == page.page_id && !moving_ids.contains(&f.element_id))
        .map(|f| f.aabb)
        .collect();
    let (dx, dy) = raw_delta;
    let moved = [b.top + dy, b.left + dx, b.bottom + dy, b.right + dx];
    SpacingSnap {
        x: spacing_axis(&page.page_id, moved, &others, reach, SnapAxis::X),
        y: spacing_axis(&page.page_id, moved, &others, reach, SnapAxis::Y),
    }
}

/// One axis of [`spacing_snap`]. Boxes are `[top, left, bottom, right]`;
/// the axis picks which pair of sides is "along" (x: left/right) and
/// which is "across" (x: top/bottom).
fn spacing_axis(
    page_id: &PageId,
    moved: [f32; 4],
    others: &[[f32; 4]],
    reach: f32,
    axis: SnapAxis,
) -> Vec<AxisMatch> {
    // (lo, hi) along the axis and (lo, hi) across it.
    let along = |b: &[f32; 4]| match axis {
        SnapAxis::X => (b[1], b[3]),
        SnapAxis::Y => (b[0], b[2]),
    };
    let across = |b: &[f32; 4]| match axis {
        SnapAxis::X => (b[0], b[2]),
        SnapAxis::Y => (b[1], b[3]),
    };
    let (m_lo, m_hi) = along(&moved);
    let (c_lo, c_hi) = across(&moved);
    let size = m_hi - m_lo;
    let centre = (m_lo + m_hi) * 0.5;
    let in_row: Vec<&[f32; 4]> = others
        .iter()
        .filter(|o| {
            let (lo, hi) = across(o);
            lo < c_hi && hi > c_lo
        })
        .collect();
    // Nearest first on each side, by the facing edge.
    let mut before: Vec<(f32, f32, f32, f32)> = in_row
        .iter()
        .filter_map(|o| {
            let (lo, hi) = along(o);
            let (alo, ahi) = across(o);
            ((lo + hi) * 0.5 < centre && hi <= m_lo + reach).then_some((lo, hi, alo, ahi))
        })
        .collect();
    before.sort_by(|a, b| b.1.total_cmp(&a.1));
    let mut after: Vec<(f32, f32, f32, f32)> = in_row
        .iter()
        .filter_map(|o| {
            let (lo, hi) = along(o);
            let (alo, ahi) = across(o);
            ((lo + hi) * 0.5 > centre && lo >= m_hi - reach).then_some((lo, hi, alo, ahi))
        })
        .collect();
    after.sort_by(|a, b| a.0.total_cmp(&b.0));

    // A gap line between `from` and `to` along the axis, drawn across the
    // middle of the two boxes' overlap.
    let gap_line = |from: f32, to: f32, a: (f32, f32), b: (f32, f32)| {
        let lo = a.0.max(b.0);
        let hi = a.1.min(b.1);
        let mid = if lo <= hi {
            (lo + hi) * 0.5
        } else {
            (a.0 + a.1) * 0.5
        };
        let (p0, p1) = match axis {
            SnapAxis::X => ([from, mid], [to, mid]),
            SnapAxis::Y => ([mid, from], [mid, to]),
        };
        let mut line =
            SnapLine::new(axis, from, page_id.clone()).with_target(SnapTargetKind::EqualSpacing);
        line.kind = Some(SnapLineKind::Spacing);
        line.from = Some(p0);
        line.to = Some(p1);
        line.distance = Some(to - from);
        line
    };
    let me = (c_lo, c_hi);
    let mut out: Vec<AxisMatch> = Vec::new();
    let mut offer = |target_lo: f32, gaps: Vec<SnapLine>| {
        let adjustment = target_lo - m_lo;
        if adjustment.abs() <= reach {
            out.push(AxisMatch {
                adjustment,
                target: target_lo,
                kind: SnapTargetKind::EqualSpacing,
                page_id: page_id.clone(),
                gaps,
            });
        }
    };
    // Centred between the nearest neighbours.
    if let (Some(l), Some(r)) = (before.first(), after.first()) {
        let gap = (r.0 - l.1 - size) * 0.5;
        if gap > 0.0 {
            let t = l.1 + gap;
            offer(
                t,
                vec![
                    gap_line(l.1, t, (l.2, l.3), me),
                    gap_line(t + size, r.0, me, (r.2, r.3)),
                ],
            );
        }
    }
    // One gap on from a neighbour pair, before the selection…
    if let (Some(l1), Some(l2)) = (before.first(), before.get(1)) {
        let gap = l1.0 - l2.1;
        if gap > 0.0 {
            let t = l1.1 + gap;
            offer(
                t,
                vec![
                    gap_line(l2.1, l1.0, (l2.2, l2.3), (l1.2, l1.3)),
                    gap_line(l1.1, t, (l1.2, l1.3), me),
                ],
            );
        }
    }
    // …and after it.
    if let (Some(r1), Some(r2)) = (after.first(), after.get(1)) {
        let gap = r2.0 - r1.1;
        if gap > 0.0 {
            let t = r1.0 - gap - size;
            offer(
                t,
                vec![
                    gap_line(t + size, r1.0, me, (r1.2, r1.3)),
                    gap_line(r1.1, r2.0, (r1.2, r1.3), (r2.2, r2.3)),
                ],
            );
        }
    }
    out
}

/// v67 (RFI C-68) — resize snapping: the edge (or the two edges, at a
/// corner) a resize handle moves lands on the same page / margin / guide
/// / grid / sibling lines a translate aligns with, with the same
/// hysteresis. Each axis snaps on its own; an axis the handle does not
/// move is left alone. Rotated members pass through, as they do for
/// translate.
pub(crate) fn compute_resize_snap(
    session: &GestureSession,
    raw_delta: (f32, f32),
    pages: &[PageInfo],
    siblings: &[FrameRect],
    env: &SnapEnv,
) -> SnapAdjustment {
    use crate::gesture::GestureType;
    let pass = SnapAdjustment::pass(raw_delta);
    let GestureType::Resize { handle } = session.gesture else {
        return pass;
    };
    if !env.settings.enabled || session.modifiers.disable_snap {
        return pass;
    }
    // R6 — the edges that move: the selection box's when a group is
    // resized as one (ADR 191), else each item's own. A group's
    // snapshot has no geometry of its own and is never a candidate.
    let moving: Vec<crate::gesture::NodeSnapshot> = match session.resize_box {
        Some(rb) => match session.snapshots.first() {
            Some(first) => vec![crate::gesture::NodeSnapshot {
                bounds: rb.bounds,
                item_transform: rb.placement,
                ..first.clone()
            }],
            None => Vec::new(),
        },
        None => session
            .snapshots
            .iter()
            .filter(|s| !is_group(s))
            .cloned()
            .collect(),
    };
    if moving
        .iter()
        .any(|s| !is_pure_translate_or_identity(s.item_transform))
    {
        return pass;
    }
    let (acquire, release) = tolerances(session, env);
    let (dx, dy) = raw_delta;
    let mut xs: Vec<AxisMatch> = Vec::new();
    let mut ys: Vec<AxisMatch> = Vec::new();
    // v77 — the first moving edge per axis, for Snap to Pixel.
    let mut first_x: Option<f32> = None;
    let mut first_y: Option<f32> = None;
    for snap in &moving {
        let Some(page) = host_page_for_snapshot(snap, pages) else {
            continue;
        };
        let Some(aabb) = snapshot_aabb_in_page(snap, &page) else {
            continue;
        };
        let mut cand_x = Vec::new();
        if handle.moves_west() {
            cand_x.push(aabb.left + dx);
        }
        if handle.moves_east() {
            cand_x.push(aabb.right + dx);
        }
        let mut cand_y = Vec::new();
        if handle.moves_north() {
            cand_y.push(aabb.top + dy);
        }
        if handle.moves_south() {
            cand_y.push(aabb.bottom + dy);
        }
        first_x = first_x.or(cand_x.first().copied());
        first_y = first_y.or(cand_y.first().copied());
        if !cand_x.is_empty() {
            let targets = snap_targets_x(&page, siblings, &session.snapshots, env, &cand_x);
            axis_matches(&cand_x, &targets, release, &page.page_id, &mut xs);
        }
        if !cand_y.is_empty() {
            let targets = snap_targets_y(&page, siblings, &session.snapshots, env, &cand_y);
            axis_matches(&cand_y, &targets, release, &page.page_id, &mut ys);
        }
    }
    let win_x = choose(&xs, session.snap_hold.x.as_ref(), acquire);
    let win_y = choose(&ys, session.snap_hold.y.as_ref(), acquire);
    let mut lines = Vec::new();
    if let Some(m) = &win_x {
        lines.push(SnapLine::new(SnapAxis::X, m.target, m.page_id.clone()).with_target(m.kind));
    }
    if let Some(m) = &win_y {
        lines.push(SnapLine::new(SnapAxis::Y, m.target, m.page_id.clone()).with_target(m.kind));
    }
    // v77 — Snap to Pixel: a moving edge nothing else took lands on a
    // whole point.
    let pixel = |edge: Option<f32>| {
        edge.filter(|_| env.settings.pixel)
            .map_or(0.0, |e| e.round() - e)
    };
    SnapAdjustment {
        delta: (
            dx + win_x
                .as_ref()
                .map_or_else(|| pixel(first_x), |b| b.adjustment),
            dy + win_y
                .as_ref()
                .map_or_else(|| pixel(first_y), |b| b.adjustment),
        ),
        lines,
        hold: SnapHold {
            x: win_x.as_ref().map(AxisMatch::held),
            y: win_y.as_ref().map(AxisMatch::held),
            angle: None,
        },
    }
}

/// v77 (editor ADR 287) — scale snapping: the dragged handle (the
/// gesture's anchor, moved by the delta) lands on the same page / margin
/// / guide / grid / sibling / pixel lines a resize edge does, with the
/// same hysteresis. An axis the handle does not move (it sits level with
/// the pivot on that axis — a side handle) is left alone. With Shift
/// (proportional scale) only the nearer axis snaps, so the proportion
/// holds. Works for rotated selections too: the handle is a point on the
/// page whatever the items' angle.
pub(crate) fn compute_scale_snap(
    session: &GestureSession,
    raw_delta: (f32, f32),
    pages: &[PageInfo],
    siblings: &[FrameRect],
    env: &SnapEnv,
) -> SnapAdjustment {
    use crate::gesture::GestureType;
    let pass = SnapAdjustment::pass(raw_delta);
    if !matches!(session.gesture, GestureType::Scale)
        || !env.settings.enabled
        || session.modifiers.disable_snap
    {
        return pass;
    }
    let (Some(anchor), Some(pivot)) = (session.anchor_spread, session.pivot_spread) else {
        return pass;
    };
    let Some(page) = pages
        .iter()
        .find(|p| {
            anchor.0 >= p.spread_origin.0 - 1.0
                && anchor.0 <= p.spread_origin.0 + p.width_pt + 1.0
                && anchor.1 >= p.spread_origin.1 - 1.0
                && anchor.1 <= p.spread_origin.1 + p.height_pt + 1.0
        })
        .cloned()
    else {
        return pass;
    };
    let (acquire, release) = tolerances(session, env);
    let (dx, dy) = raw_delta;
    let hx = anchor.0 + dx - page.spread_origin.0;
    let hy = anchor.1 + dy - page.spread_origin.1;
    const LEVEL: f32 = 1e-3;
    let moves_x = (anchor.0 - pivot.0).abs() > LEVEL;
    let moves_y = (anchor.1 - pivot.1).abs() > LEVEL;
    let snap_on = |axis: SnapAxis, v: f32, held: Option<&HeldTarget>| -> Option<AxisMatch> {
        let cand = [v];
        let targets = match axis {
            SnapAxis::X => snap_targets_x(&page, siblings, &session.snapshots, env, &cand),
            SnapAxis::Y => snap_targets_y(&page, siblings, &session.snapshots, env, &cand),
        };
        let mut matches = Vec::new();
        axis_matches(&cand, &targets, release, &page.page_id, &mut matches);
        choose(&matches, held, acquire)
    };
    let mut mx = moves_x
        .then(|| snap_on(SnapAxis::X, hx, session.snap_hold.x.as_ref()))
        .flatten();
    let mut my = moves_y
        .then(|| snap_on(SnapAxis::Y, hy, session.snap_hold.y.as_ref()))
        .flatten();
    if session.modifiers.shift {
        match (&mx, &my) {
            (Some(a), Some(b)) if a.adjustment.abs() <= b.adjustment.abs() => my = None,
            (Some(_), Some(_)) => mx = None,
            _ => {}
        }
    }
    let pixel = |moves: bool, v: f32| {
        (moves && env.settings.pixel && !session.modifiers.shift).then(|| v.round() - v)
    };
    let mut lines = Vec::new();
    if let Some(m) = &mx {
        lines.push(SnapLine::new(SnapAxis::X, m.target, page.page_id.clone()).with_target(m.kind));
    }
    if let Some(m) = &my {
        lines.push(SnapLine::new(SnapAxis::Y, m.target, page.page_id.clone()).with_target(m.kind));
    }
    let ax = mx
        .as_ref()
        .map(|m| m.adjustment)
        .or_else(|| pixel(moves_x, hx))
        .unwrap_or(0.0);
    let ay = my
        .as_ref()
        .map(|m| m.adjustment)
        .or_else(|| pixel(moves_y, hy))
        .unwrap_or(0.0);
    SnapAdjustment {
        delta: (dx + ax, dy + ay),
        lines,
        hold: SnapHold {
            x: mx.as_ref().map(AxisMatch::held),
            y: my.as_ref().map(AxisMatch::held),
            angle: None,
        },
    }
}

/// The angles a rotate gesture snaps to, degrees: the axes and diagonals.
const ROTATE_ANGLES: [f32; 8] = [0.0, 45.0, 90.0, 135.0, 180.0, -45.0, -90.0, -135.0];

/// Rotate snapping tolerance, in degrees, at least — the pointer's screen
/// tolerance turned into an angle at its distance from the pivot, so a
/// far pointer is as easy to catch as a near one.
const ROTATE_MIN_TOLERANCE_DEG: f32 = 1.0;

fn wrap_deg(a: f32) -> f32 {
    let w = (a + 180.0).rem_euclid(360.0) - 180.0;
    if w <= -180.0 {
        w + 360.0
    } else {
        w
    }
}

/// v77 (editor ADR 287) — rotate snapping: the first item's angle after
/// the turn lands on 0/45/90/…° or on the angle of another item on the
/// page (`sibling_angles`, degrees) when within tolerance, and stays on
/// it until the release tolerance (v79). Shift's 15° steps (applied by
/// the gesture) take precedence: with Shift held this passes through.
/// The adjusted delta keeps the pointer's distance from the pivot, so the
/// gesture recomputes exactly the snapped angle. The guide is an `Angle`
/// line from the pivot at the snapped angle.
pub(crate) fn compute_rotate_snap(
    session: &GestureSession,
    raw_delta: (f32, f32),
    pages: &[PageInfo],
    sibling_angles: &[f32],
    env: &SnapEnv,
) -> SnapAdjustment {
    use crate::gesture::GestureType;
    let pass = SnapAdjustment::pass(raw_delta);
    if !matches!(session.gesture, GestureType::Rotate)
        || !env.settings.enabled
        || !env.settings.rotate
        || session.modifiers.disable_snap
        || session.modifiers.shift
    {
        return pass;
    }
    let (Some(anchor), Some(pivot)) = (session.anchor_spread, session.pivot_spread) else {
        return pass;
    };
    let Some(first) = session.snapshots.iter().find(|s| !is_group(s)) else {
        return pass;
    };
    let current = (anchor.0 + raw_delta.0, anchor.1 + raw_delta.1);
    let r_anchor = (anchor.0 - pivot.0).hypot(anchor.1 - pivot.1);
    let r_current = (current.0 - pivot.0).hypot(current.1 - pivot.1);
    if r_anchor < 1e-3 || r_current < 1e-3 {
        return pass;
    }
    let theta = ((current.1 - pivot.1).atan2(current.0 - pivot.0)
        - (anchor.1 - pivot.1).atan2(anchor.0 - pivot.0))
    .to_degrees();
    let m = first
        .item_transform
        .unwrap_or([1.0, 0.0, 0.0, 1.0, 0.0, 0.0]);
    let start = m[1].atan2(m[0]).to_degrees();
    let after = wrap_deg(start + theta);
    let (acquire_pt, release_pt) = tolerances(session, env);
    let degrees = |pt: f32, floor: f32| (pt / r_current).to_degrees().max(floor);
    let acquire = degrees(acquire_pt, ROTATE_MIN_TOLERANCE_DEG);
    let release = degrees(
        release_pt,
        ROTATE_MIN_TOLERANCE_DEG * SNAP_RELEASE_CSS_PX / SNAP_TOLERANCE_CSS_PX,
    );
    let host = host_page_for_snapshot(first, pages);
    let page_id = host
        .as_ref()
        .map_or_else(|| PageId(String::new()), |p| p.page_id.clone());
    let matches: Vec<AxisMatch> = ROTATE_ANGLES
        .iter()
        .chain(sibling_angles)
        .filter_map(|&t| {
            let d = wrap_deg(t - after);
            (d.abs() <= release).then(|| AxisMatch {
                adjustment: d,
                target: wrap_deg(t),
                kind: SnapTargetKind::Angle,
                page_id: page_id.clone(),
                gaps: Vec::new(),
            })
        })
        .collect();
    let Some(win) = choose(&matches, session.snap_hold.angle.as_ref(), acquire) else {
        return pass;
    };
    let snapped = (theta + win.adjustment).to_radians();
    let (sin, cos) = snapped.sin_cos();
    let (ax, ay) = (anchor.0 - pivot.0, anchor.1 - pivot.1);
    let k = r_current / r_anchor;
    let landed = (
        pivot.0 + k * (cos * ax - sin * ay),
        pivot.1 + k * (sin * ax + cos * ay),
    );
    let mut lines = Vec::new();
    if let Some(page) = host {
        let o = page.spread_origin;
        let from = [pivot.0 - o.0, pivot.1 - o.1];
        let to = [landed.0 - o.0, landed.1 - o.1];
        let mut line = SnapLine::new(SnapAxis::X, from[0], page.page_id.clone())
            .with_target(SnapTargetKind::Angle);
        line.kind = Some(SnapLineKind::Angle);
        line.from = Some(from);
        line.to = Some(to);
        line.angle = Some(win.target);
        line.distance = Some(r_current);
        lines.push(line);
    }
    SnapAdjustment {
        delta: (landed.0 - anchor.0, landed.1 - anchor.1),
        lines,
        hold: SnapHold {
            x: None,
            y: None,
            angle: Some(win.held()),
        },
    }
}

/// A group's snapshot carries no geometry of its own (its members are
/// snapshotted beside it): it is never a snap candidate, or its zero box
/// would snap a phantom point at the group's origin.
fn is_group(snap: &crate::gesture::NodeSnapshot) -> bool {
    matches!(snap.node_id, paged_mutate::NodeId::Group(_))
}

/// Tolerance (pt) within which a candidate edge counts as "exactly
/// aligned" with a target for smart-guide rendering. Tighter than the
/// snap tolerance (~4 pt) because smart guides describe an alignment
/// the post-snap frame is ON, not one it would BE PULLED INTO. Float
/// noise from accumulated transform math is the dominant signal.
const SMART_GUIDE_EPSILON_PT: f32 = 0.5;

/// Append `line` only when no existing entry covers the same
/// (axis, position-on-the-same-page) — multiple moving frames often
/// align with the same target and we don't want duplicate overlay
/// chrome. Position equality uses sub-pixel tolerance. Where two kinds
/// of target share a position, the line names the better-ranked one.
fn push_unique_line(lines: &mut Vec<SnapLine>, line: SnapLine) {
    if let Some(l) = lines.iter_mut().find(|l| {
        l.axis == line.axis
            && l.page_id == line.page_id
            && (l.position - line.position).abs() < 1e-3
    }) {
        if let Some(new) = line.target_kind {
            if l.target_kind.is_none_or(|old| new.rank() < old.rank()) {
                l.target_kind = Some(new);
            }
        }
        return;
    }
    lines.push(line);
}

/// Reorder so the winner-axis snap line lands at the front of the
/// axis's lines. Stable behaviour for callers (overlay, K.3 spec)
/// that historically read `lines[0]` / `lines.find(axis == X)` as
/// "the snap winner." The line names the winner's kind.
fn promote_winner(lines: &mut Vec<SnapLine>, winner: Option<&AxisMatch>, axis: SnapAxis) {
    let Some(m) = winner else { return };
    let Some(pos) = lines.iter().position(|l| {
        l.axis == axis && l.page_id == m.page_id && (l.position - m.target).abs() < 1e-3
    }) else {
        return;
    };
    lines[pos].target_kind = Some(m.kind);
    // Find the FIRST index in `lines` whose axis matches; move our
    // winner there. Stable; preserves relative order of other lines.
    let Some(first_for_axis) = lines.iter().position(|l| l.axis == axis) else {
        return;
    };
    if pos == first_for_axis {
        return;
    }
    let winner_line = lines.remove(pos);
    lines.insert(first_for_axis, winner_line);
}

/// Page summary fed into the snap pass.
#[derive(Debug, Clone, Default)]
pub(crate) struct PageInfo {
    pub page_id: PageId,
    pub width_pt: f32,
    pub height_pt: f32,
    /// Page origin in spread coords (matches `BuiltPage::spread_origin`).
    pub spread_origin: (f32, f32),
    /// Plan-2 §8.3 — ruler guides on this page. Vertical guide
    /// locations (x in page-local pt) and horizontal guide locations
    /// (y in page-local pt) are pre-split so the snap target builders
    /// can append them without re-discriminating per call. Empty for
    /// pages with no `<Guide>` declarations.
    pub vertical_guides: Vec<f32>,
    pub horizontal_guides: Vec<f32>,
    /// v79 — the page's margin and column lines (snapped with the
    /// guides, as InDesign's margin and column guides are).
    pub margins: crate::snap_point::MarginLines,
}

/// Snapshot of one frame's geometry used for snap targeting. Carries
/// the frame's AABB in PAGE-LOCAL pt + its identity so the moving
/// items are excluded from their own snap targets.
#[derive(Debug, Clone)]
pub(crate) struct FrameRect {
    pub element_id: crate::element_selection::ElementId,
    pub page_id: PageId,
    /// `[top, left, bottom, right]` in page-local pt.
    pub aabb: [f32; 4],
}

fn is_pure_translate_or_identity(m: Option<[f32; 6]>) -> bool {
    match m {
        None => true,
        Some([a, b, c, d, _, _]) => {
            (a - 1.0).abs() < 1e-4 && (d - 1.0).abs() < 1e-4 && b.abs() < 1e-4 && c.abs() < 1e-4
        }
    }
}

fn host_page_for_snapshot(
    snap: &crate::gesture::NodeSnapshot,
    pages: &[PageInfo],
) -> Option<PageInfo> {
    let aabb = snapshot_aabb_in_spread(snap);
    let cx = (aabb[1] + aabb[3]) * 0.5;
    let cy = (aabb[0] + aabb[2]) * 0.5;
    pages
        .iter()
        .find(|p| {
            cx >= p.spread_origin.0
                && cx <= p.spread_origin.0 + p.width_pt
                && cy >= p.spread_origin.1
                && cy <= p.spread_origin.1 + p.height_pt
        })
        .cloned()
}

#[derive(Debug, Clone, Copy)]
struct AabbPt {
    top: f32,
    left: f32,
    bottom: f32,
    right: f32,
}

/// Phase H — single-member AABB in page-local pt for a known host
/// page. Per-member companion to `union_aabb_in_page`.
fn snapshot_aabb_in_page(
    snap: &crate::gesture::NodeSnapshot,
    host_page: &PageInfo,
) -> Option<AabbPt> {
    let [t, l, b, r] = snapshot_aabb_in_spread(snap);
    let left = l - host_page.spread_origin.0;
    let right = r - host_page.spread_origin.0;
    let top = t - host_page.spread_origin.1;
    let bottom = b - host_page.spread_origin.1;
    Some(AabbPt {
        top,
        left,
        bottom,
        right,
    })
}

#[allow(dead_code)]
fn union_aabb_in_page(
    snapshots: &[crate::gesture::NodeSnapshot],
    host_page: &PageInfo,
) -> Option<AabbPt> {
    let (mut min_x, mut max_x, mut min_y, mut max_y) = (
        f32::INFINITY,
        f32::NEG_INFINITY,
        f32::INFINITY,
        f32::NEG_INFINITY,
    );
    for snap in snapshots {
        let [t, l, b, r] = snapshot_aabb_in_spread(snap);
        let l = l - host_page.spread_origin.0;
        let r = r - host_page.spread_origin.0;
        let t = t - host_page.spread_origin.1;
        let b = b - host_page.spread_origin.1;
        min_x = min_x.min(l);
        max_x = max_x.max(r);
        min_y = min_y.min(t);
        max_y = max_y.max(b);
    }
    if !min_x.is_finite() {
        return None;
    }
    Some(AabbPt {
        top: min_y,
        left: min_x,
        bottom: max_y,
        right: max_x,
    })
}

fn snapshot_aabb_in_spread(snap: &crate::gesture::NodeSnapshot) -> [f32; 4] {
    let b = snap.bounds;
    let m = snap
        .item_transform
        .unwrap_or([1.0, 0.0, 0.0, 1.0, 0.0, 0.0]);
    let corners = [
        paged_geom::affine::apply(&m, b.left, b.top),
        paged_geom::affine::apply(&m, b.right, b.top),
        paged_geom::affine::apply(&m, b.right, b.bottom),
        paged_geom::affine::apply(&m, b.left, b.bottom),
    ];
    let mut min_x = f32::INFINITY;
    let mut max_x = f32::NEG_INFINITY;
    let mut min_y = f32::INFINITY;
    let mut max_y = f32::NEG_INFINITY;
    for (x, y) in corners {
        min_x = min_x.min(x);
        max_x = max_x.max(x);
        min_y = min_y.min(y);
        max_y = max_y.max(y);
    }
    [min_y, min_x, max_y, max_x]
}

/// One snap target on one axis, page-local pt.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct SnapTarget {
    pub position: f32,
    pub kind: SnapTargetKind,
}

fn target(position: f32, kind: SnapTargetKind) -> SnapTarget {
    SnapTarget { position, kind }
}

/// The x targets of a moving item on `host_page`: the page's edges and
/// centre line, the grid, the other items' edges and centres, the ruler
/// guides, the margins and the column edges.
pub(crate) fn snap_targets_x(
    host_page: &PageInfo,
    siblings: &[FrameRect],
    moving: &[crate::gesture::NodeSnapshot],
    env: &SnapEnv,
    candidates: &[f32],
) -> Vec<SnapTarget> {
    use SnapTargetKind as K;
    let moving_ids: std::collections::HashSet<&crate::element_selection::ElementId> =
        moving.iter().map(|s| &s.id).collect();
    let mut out = if env.settings.page {
        vec![
            target(0.0, K::PageEdge),
            target(host_page.width_pt * 0.5, K::PageCenter),
            target(host_page.width_pt, K::PageEdge),
        ]
    } else {
        Vec::new()
    };
    out.extend(
        env.grid_lines(SnapAxis::X, candidates)
            .into_iter()
            .map(|p| target(p, K::Grid)),
    );
    for f in siblings.iter().filter(|_| env.settings.alignment) {
        if f.page_id != host_page.page_id {
            continue;
        }
        if moving_ids.contains(&f.element_id) {
            continue;
        }
        let [_top, left, _bottom, right] = f.aabb;
        out.push(target(left, K::ObjectEdge));
        out.push(target(right, K::ObjectEdge));
        out.push(target((left + right) * 0.5, K::ObjectCenter));
    }
    // Plan-2 §8.3 — vertical ruler guides snap on the x axis; v79 — so do
    // the margins and the column edges.
    if env.settings.guides {
        out.extend(
            host_page
                .vertical_guides
                .iter()
                .map(|&p| target(p, K::Guide)),
        );
        out.extend(host_page.margins.x.iter().map(|&p| target(p, K::Margin)));
        out.extend(
            host_page
                .margins
                .columns
                .iter()
                .map(|&p| target(p, K::Column)),
        );
    }
    out
}

/// The y targets of a moving item on `host_page` (as [`snap_targets_x`];
/// columns have no y edges of their own).
pub(crate) fn snap_targets_y(
    host_page: &PageInfo,
    siblings: &[FrameRect],
    moving: &[crate::gesture::NodeSnapshot],
    env: &SnapEnv,
    candidates: &[f32],
) -> Vec<SnapTarget> {
    use SnapTargetKind as K;
    let moving_ids: std::collections::HashSet<&crate::element_selection::ElementId> =
        moving.iter().map(|s| &s.id).collect();
    let mut out = if env.settings.page {
        vec![
            target(0.0, K::PageEdge),
            target(host_page.height_pt * 0.5, K::PageCenter),
            target(host_page.height_pt, K::PageEdge),
        ]
    } else {
        Vec::new()
    };
    out.extend(
        env.grid_lines(SnapAxis::Y, candidates)
            .into_iter()
            .map(|p| target(p, K::Grid)),
    );
    for f in siblings.iter().filter(|_| env.settings.alignment) {
        if f.page_id != host_page.page_id {
            continue;
        }
        if moving_ids.contains(&f.element_id) {
            continue;
        }
        let [top, _left, bottom, _right] = f.aabb;
        out.push(target(top, K::ObjectEdge));
        out.push(target(bottom, K::ObjectEdge));
        out.push(target((top + bottom) * 0.5, K::ObjectCenter));
    }
    // Plan-2 §8.3 — horizontal ruler guides snap on the y axis; v79 — so
    // do the top and bottom margins.
    if env.settings.guides {
        out.extend(
            host_page
                .horizontal_guides
                .iter()
                .map(|&p| target(p, K::Guide)),
        );
        out.extend(host_page.margins.y.iter().map(|&p| target(p, K::Margin)));
    }
    out
}

/// Legacy single-axis snap (Phase E v1), kept for the unit tests that
/// exercise it directly; the gesture passes use [`axis_matches`] and
/// [`choose`].
#[allow(dead_code)]
fn snap_axis(candidates: &[f32], targets: &[f32], tolerance: f32) -> (f32, Option<f32>) {
    let mut best: Option<(f32, f32)> = None; // (adjustment, target_pos)
    for &cand in candidates {
        for &target in targets {
            let diff = target - cand;
            if diff.abs() > tolerance {
                continue;
            }
            match best {
                None => best = Some((diff, target)),
                Some((cur, _)) if diff.abs() < cur.abs() => {
                    best = Some((diff, target));
                }
                _ => {}
            }
        }
    }
    match best {
        Some((adj, line)) => (adj, Some(line)),
        None => (0.0, None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::element_selection::ElementId;
    use crate::gesture::{GestureHandle, GestureModifiers, GestureType, NodeSnapshot};
    use paged_model::Bounds;
    use paged_mutate::NodeId;

    fn snap_for(bounds: Bounds, kind: &str, id: &str) -> NodeSnapshot {
        NodeSnapshot {
            id: match kind {
                "tf" => ElementId::TextFrame(id.to_string()),
                "rect" => ElementId::Rectangle(id.to_string()),
                _ => panic!("unknown kind"),
            },
            node_id: match kind {
                "tf" => NodeId::TextFrame(id.to_string()),
                "rect" => NodeId::Rectangle(id.to_string()),
                _ => panic!("unknown kind"),
            },
            bounds,
            item_transform: None,
            image_item_transform: None,
            path_anchors: Vec::new(),
            drawn_from_path: false,
        }
    }

    fn session(snapshots: Vec<NodeSnapshot>) -> GestureSession {
        GestureSession {
            handle: GestureHandle(1),
            gesture: GestureType::Translate,
            snapshots,
            current_delta: None,
            modifiers: GestureModifiers::default(),
            anchor_spread: None,
            pivot_spread: None,
            shear_axis: crate::gesture::ShearAxis::X,
            camera_scale: None,
            scale_frame: None,
            group_frames: std::collections::HashMap::new(),
            resize_box: None,
            preview_copies: None,
            snap_hold: Default::default(),
        }
    }

    fn session_at_scale(snapshots: Vec<NodeSnapshot>, scale: f32) -> GestureSession {
        let mut s = session(snapshots);
        s.camera_scale = Some(scale);
        s
    }

    fn page(id: &str, w: f32, h: f32) -> PageInfo {
        PageInfo {
            page_id: PageId(id.to_string()),
            width_pt: w,
            height_pt: h,
            spread_origin: (0.0, 0.0),
            vertical_guides: Vec::new(),
            horizontal_guides: Vec::new(),
            margins: Default::default(),
        }
    }

    #[test]
    fn snap_to_page_left_edge() {
        // Frame at left=20, drag by dx=-19 → would land at left=1.
        // Tolerance 4 → snaps left edge to 0. Effective delta = -20.
        let s = snap_for(
            Bounds {
                top: 100.0,
                left: 20.0,
                bottom: 200.0,
                right: 200.0,
            },
            "tf",
            "u1",
        );
        let sess = session(vec![s]);
        let pages = vec![page("p1", 612.0, 792.0)];
        let adj = compute_snap_adjustment(&sess, (-19.0, 0.0), &pages, &[]);
        assert!((adj.delta.0 - -20.0).abs() < 1e-3, "{:?}", adj);
        assert_eq!(adj.delta.1, 0.0);
        assert_eq!(adj.lines.len(), 1);
        assert!(matches!(adj.lines[0].axis, SnapAxis::X));
        assert!((adj.lines[0].position - 0.0).abs() < 1e-3);
    }

    #[test]
    fn disable_snap_modifier_bypasses_snap_pass() {
        // Same setup as `snap_to_page_left_edge`: drag by dx=-19 with
        // tolerance 4 would normally snap left edge to 0 (effective
        // delta -20). With `disable_snap` set the raw delta passes
        // through and no snap lines surface.
        let s = snap_for(
            Bounds {
                top: 100.0,
                left: 20.0,
                bottom: 200.0,
                right: 200.0,
            },
            "tf",
            "u1",
        );
        let mut sess = session(vec![s]);
        sess.modifiers.disable_snap = true;
        let pages = vec![page("p1", 612.0, 792.0)];
        let adj = compute_snap_adjustment(&sess, (-19.0, 0.0), &pages, &[]);
        assert!((adj.delta.0 - -19.0).abs() < 1e-6);
        assert_eq!(adj.delta.1, 0.0);
        assert!(adj.lines.is_empty());
    }

    #[test]
    fn no_snap_when_out_of_tolerance() {
        // Move by dx = -10. Closest target (page left) at x=0 from
        // candidate 10 → diff 10 → outside 4pt tolerance.
        let s = snap_for(
            Bounds {
                top: 100.0,
                left: 20.0,
                bottom: 200.0,
                right: 200.0,
            },
            "tf",
            "u1",
        );
        let sess = session(vec![s]);
        let pages = vec![page("p1", 612.0, 792.0)];
        let adj = compute_snap_adjustment(&sess, (-10.0, 0.0), &pages, &[]);
        assert!((adj.delta.0 - -10.0).abs() < 1e-3);
        assert!(adj.lines.is_empty());
    }

    #[test]
    fn snap_to_sibling_frame_right_edge() {
        // Moving frame's left edge approaches sibling's right edge.
        let s = snap_for(
            Bounds {
                top: 100.0,
                left: 100.0,
                bottom: 200.0,
                right: 200.0,
            },
            "tf",
            "u1",
        );
        let sess = session(vec![s]);
        let pages = vec![page("p1", 612.0, 792.0)];
        let sibling = FrameRect {
            element_id: ElementId::Rectangle("u_sib".to_string()),
            page_id: PageId("p1".to_string()),
            aabb: [50.0, 30.0, 180.0, 75.0], // top, left, bottom, right
        };
        // moving.left = 100 + dx → want = 75 (sibling right) → dx = -25.
        // tolerance 4 → snap when dx between -29 and -21.
        let adj = compute_snap_adjustment(&sess, (-24.0, 0.0), &pages, &[sibling]);
        assert!((adj.delta.0 - -25.0).abs() < 1e-3, "{:?}", adj);
        assert!(adj.lines.iter().any(|l| matches!(l.axis, SnapAxis::X)));
    }

    #[test]
    fn smart_guides_surface_secondary_alignment() {
        // Sibling A: short rectangle at top (height 30). Sibling B:
        // tall rectangle whose right edge sits at exactly the same x
        // as A's right edge (smart-guide alignment in y wouldn't
        // help — A and B aren't on the same y-line; the guide we
        // want is the SECONDARY x-alignment surfaced after the
        // winner.
        //
        // Moving frame: small rect aligned with sibling A on x.
        // Drag dy=-19 toward the page-top edge → snap wins on Y
        // pulling top to 0. The X axis isn't snapped (dx=0), but
        // the moving frame already lines up with A's left edge AND
        // B's right edge → smart guides should surface both.
        let s = snap_for(
            Bounds {
                top: 100.0,
                left: 50.0,
                bottom: 130.0,
                right: 100.0,
            },
            "tf",
            "u_move",
        );
        let sess = session(vec![s]);
        let pages = vec![page("p1", 612.0, 792.0)];
        let sib_a = FrameRect {
            element_id: ElementId::Rectangle("u_a".to_string()),
            page_id: PageId("p1".to_string()),
            aabb: [10.0, 50.0, 40.0, 200.0], // top, left, bottom, right
        };
        let sib_b = FrameRect {
            element_id: ElementId::Rectangle("u_b".to_string()),
            page_id: PageId("p1".to_string()),
            aabb: [400.0, 0.0, 500.0, 100.0], // right edge at x=100
        };
        // dy=-99 → moving.top = 100-99 = 1, within 4 pt of page top
        // (0) → snap pulls top to 0 (adjusted dy = -100).
        let adj = compute_snap_adjustment(&sess, (0.0, -99.0), &pages, &[sib_a, sib_b]);
        // Y snap winner exists.
        let y_lines: Vec<&SnapLine> = adj
            .lines
            .iter()
            .filter(|l| matches!(l.axis, SnapAxis::Y))
            .collect();
        assert!(!y_lines.is_empty(), "expected at least one Y snap line");
        // First Y line is the winner (top → 0).
        assert!((y_lines[0].position - 0.0).abs() < 1e-3);
        // Smart guides: dx=0 doesn't snap on X, but the moving
        // frame's left=50 lines up with sib_a's left=50, AND
        // moving's right=100 lines up with sib_b's right=100.
        // Both should surface as X snap lines.
        let x_positions: Vec<f32> = adj
            .lines
            .iter()
            .filter(|l| matches!(l.axis, SnapAxis::X))
            .map(|l| l.position)
            .collect();
        assert!(
            x_positions.iter().any(|&p| (p - 50.0).abs() < 1e-3),
            "expected smart-guide at x=50 (left-edge alignment), got {x_positions:?}",
        );
        assert!(
            x_positions.iter().any(|&p| (p - 100.0).abs() < 1e-3),
            "expected smart-guide at x=100 (right-edge alignment), got {x_positions:?}",
        );
    }

    #[test]
    fn vertical_ruler_guide_acts_as_snap_target() {
        // Frame at left=20; vertical guide at x=18. Drag dx=-1 →
        // candidate left lands at 19, within 4pt of the guide
        // (delta 1 < 4) → snap pulls left to 18 (effective dx=-2).
        let s = snap_for(
            Bounds {
                top: 100.0,
                left: 20.0,
                bottom: 200.0,
                right: 200.0,
            },
            "tf",
            "u1",
        );
        let sess = session(vec![s]);
        let mut pg = page("p1", 612.0, 792.0);
        pg.vertical_guides.push(18.0);
        let pages = vec![pg];
        let adj = compute_snap_adjustment(&sess, (-1.0, 0.0), &pages, &[]);
        assert!((adj.delta.0 - -2.0).abs() < 1e-3, "{:?}", adj);
        assert!(adj
            .lines
            .iter()
            .any(|l| matches!(l.axis, SnapAxis::X) && (l.position - 18.0).abs() < 1e-3));
    }

    #[test]
    fn moving_frame_excluded_from_its_own_snap_targets() {
        // The moving frame's own bounds must NOT appear as a target —
        // otherwise dx=0 would always snap to dx=0 and the user could
        // never move it.
        let s = snap_for(
            Bounds {
                top: 100.0,
                left: 100.0,
                bottom: 200.0,
                right: 200.0,
            },
            "tf",
            "u1",
        );
        let sess = session(vec![s.clone()]);
        let pages = vec![page("p1", 1000.0, 1000.0)];
        let same_as_moving = FrameRect {
            element_id: ElementId::TextFrame("u1".to_string()),
            page_id: PageId("p1".to_string()),
            aabb: [100.0, 100.0, 200.0, 200.0],
        };
        // Drag by 3 — well within tolerance to "snap back" if the
        // moving frame's own edges were targets.
        let adj = compute_snap_adjustment(&sess, (3.0, 0.0), &pages, &[same_as_moving]);
        assert!(
            (adj.delta.0 - 3.0).abs() < 1e-3,
            "moving frame should not snap to itself: {:?}",
            adj
        );
    }

    fn page_at(id: &str, origin: (f32, f32), w: f32, h: f32) -> PageInfo {
        PageInfo {
            page_id: PageId(id.to_string()),
            width_pt: w,
            height_pt: h,
            spread_origin: origin,
            vertical_guides: Vec::new(),
            horizontal_guides: Vec::new(),
            margins: Default::default(),
        }
    }

    #[test]
    fn multi_page_selection_snaps_against_per_member_pages() {
        // Two members on two different pages. Member A on page1
        // (origin 0,0) wants to snap its right edge to page1's right
        // edge (612). Member B on page2 (origin 612, 0) has plenty
        // of room; should NOT drag any snap.
        // After per-page snap, only A's edge snaps and the resulting
        // snap line is tagged with page1, not page2.
        let a = NodeSnapshot {
            id: ElementId::TextFrame("a".into()),
            node_id: NodeId::TextFrame("a".into()),
            // Page1 spread coords (0..612). Right edge at 610, snap
            // to 612 needs +2pt of dx.
            bounds: Bounds {
                top: 100.0,
                left: 500.0,
                bottom: 200.0,
                right: 610.0,
            },
            item_transform: None,
            image_item_transform: None,
            path_anchors: Vec::new(),
            drawn_from_path: false,
        };
        let b = NodeSnapshot {
            id: ElementId::TextFrame("b".into()),
            node_id: NodeId::TextFrame("b".into()),
            // Page2 spread coords (612..1224). Comfortably middle.
            bounds: Bounds {
                top: 100.0,
                left: 800.0,
                bottom: 200.0,
                right: 900.0,
            },
            item_transform: None,
            image_item_transform: None,
            path_anchors: Vec::new(),
            drawn_from_path: false,
        };
        let sess = session(vec![a, b]);
        let pages = vec![
            page_at("p1", (0.0, 0.0), 612.0, 792.0),
            page_at("p2", (612.0, 0.0), 612.0, 792.0),
        ];
        // dx = +1 — A's right candidate lands at 611 (within 4pt of
        // page1 right edge 612 → snaps to +2 total).
        let adj = compute_snap_adjustment(&sess, (1.0, 0.0), &pages, &[]);
        assert!((adj.delta.0 - 2.0).abs() < 1e-3, "{:?}", adj);
        // The snap line is on page1, not page2 (where neither edge
        // is near a target).
        let x_line = adj.lines.iter().find(|l| matches!(l.axis, SnapAxis::X));
        let x_line = x_line.expect("expected x snap line");
        assert_eq!(x_line.page_id, PageId("p1".into()));
        assert!((x_line.position - 612.0).abs() < 1e-3);
    }

    #[test]
    fn zoom_scales_the_doc_space_tolerance() {
        // At camera scale = 2 (zoomed in 2×), the doc-space tolerance
        // halves to 2pt. A 3pt-near-edge candidate that snaps at scale
        // 1 should NOT snap at scale 2.
        let s = snap_for(
            Bounds {
                top: 100.0,
                left: 20.0,
                bottom: 200.0,
                right: 200.0,
            },
            "tf",
            "u1",
        );
        let pages = vec![page("p1", 612.0, 792.0)];
        // dx = -17 → candidate left = 3, diff = -3 from page-left (0).
        // |diff| = 3pt is inside the 4pt tolerance at scale=1
        // (snaps) but outside the 2pt tolerance at scale=2 (doesn't).
        let snap_at_1 =
            compute_snap_adjustment(&session(vec![s.clone()]), (-17.0, 0.0), &pages, &[]);
        assert!(
            !snap_at_1.lines.is_empty(),
            "should snap at scale 1: {:?}",
            snap_at_1
        );

        let snap_at_2 =
            compute_snap_adjustment(&session_at_scale(vec![s], 2.0), (-17.0, 0.0), &pages, &[]);
        assert!(
            snap_at_2.lines.is_empty(),
            "should NOT snap at scale 2: {:?}",
            snap_at_2
        );
    }

    #[test]
    fn non_translate_gestures_pass_through() {
        let s = snap_for(
            Bounds {
                top: 0.0,
                left: 0.0,
                bottom: 100.0,
                right: 100.0,
            },
            "tf",
            "u1",
        );
        let mut sess = session(vec![s]);
        sess.gesture = GestureType::Rotate;
        let pages = vec![page("p1", 612.0, 792.0)];
        let adj = compute_snap_adjustment(&sess, (3.0, 3.0), &pages, &[]);
        assert_eq!(adj.delta, (3.0, 3.0));
        assert!(adj.lines.is_empty());
    }

    // ── v77 (editor ADR 287) — snapping v2 ──────────────────────────

    fn rect_snap(id: &str, b: (f32, f32, f32, f32)) -> NodeSnapshot {
        snap_for(
            Bounds {
                top: b.0,
                left: b.1,
                bottom: b.2,
                right: b.3,
            },
            "rect",
            id,
        )
    }

    fn sibling(id: &str, aabb: [f32; 4]) -> FrameRect {
        FrameRect {
            element_id: ElementId::Rectangle(id.to_string()),
            page_id: PageId("p1".to_string()),
            aabb,
        }
    }

    #[test]
    #[allow(non_snake_case)]
    fn a_rotated_item_snaps_through_its_oriented_box__feat__the_renderer_view_modes() {
        // A 100 × 100 square turned 45° about its centre (150, 150): its
        // oriented box reaches x = 150 − 70.71 on the left.
        let mut s = rect_snap("r", (100.0, 100.0, 200.0, 200.0));
        let (sin, cos) = std::f32::consts::FRAC_PI_4.sin_cos();
        let (cx, cy) = (150.0, 150.0);
        s.item_transform = Some([
            cos,
            sin,
            -sin,
            cos,
            cx - cos * cx + sin * cy,
            cy - sin * cx - cos * cy,
        ]);
        let left = 150.0 - 50.0 * std::f32::consts::SQRT_2;
        let sess = session(vec![s]);
        let pages = vec![page("p1", 612.0, 792.0)];
        // Drag so the left corner lands 2 pt right of the page edge.
        let adj = compute_snap_adjustment(&sess, (-left + 2.0, 0.0), &pages, &[]);
        assert!((adj.delta.0 - -left).abs() < 1e-2, "{adj:?}");
        assert!(adj
            .lines
            .iter()
            .any(|l| l.axis == SnapAxis::X && l.position.abs() < 1e-3));
    }

    #[test]
    fn equal_spacing_centres_the_item_between_its_neighbours() {
        // Neighbours at x 0..50 and 250..300, a 100-wide item: equal gaps
        // put its left edge at 100 (gaps of 50).
        let s = rect_snap("m", (300.0, 97.0, 340.0, 197.0));
        let sess = session(vec![s]);
        let pages = vec![page("p1", 2000.0, 2000.0)];
        let sibs = [
            sibling("a", [290.0, 0.0, 350.0, 50.0]),
            sibling("b", [290.0, 250.0, 350.0, 300.0]),
        ];
        let adj = compute_snap_adjustment(&sess, (1.0, 0.0), &pages, &sibs);
        assert!((adj.delta.0 - 3.0).abs() < 1e-3, "{adj:?}");
        let gaps: Vec<&SnapLine> = adj
            .lines
            .iter()
            .filter(|l| l.kind == Some(SnapLineKind::Spacing))
            .collect();
        assert_eq!(gaps.len(), 2, "{adj:?}");
        for g in gaps {
            assert!((g.distance.unwrap() - 50.0).abs() < 1e-3);
            assert!(g.from.is_some() && g.to.is_some());
        }
    }

    #[test]
    fn equal_spacing_repeats_a_neighbour_pairs_gap() {
        // a 0..40, b 60..100 (gap 20): the item lands at 120.
        let s = rect_snap("m", (0.0, 118.0, 40.0, 158.0));
        let sess = session(vec![s]);
        let pages = vec![page("p1", 2000.0, 2000.0)];
        let sibs = [
            sibling("a", [0.0, 0.0, 40.0, 40.0]),
            sibling("b", [0.0, 60.0, 40.0, 100.0]),
        ];
        let adj = compute_snap_adjustment(&sess, (1.0, 500.0), &pages, &sibs);
        // dy moves it out of the row: no x spacing.
        assert!((adj.delta.0 - 1.0).abs() < 1e-3, "{adj:?}");
        let adj = compute_snap_adjustment(&sess, (1.0, 0.0), &pages, &sibs);
        assert!((adj.delta.0 - 2.0).abs() < 1e-3, "{adj:?}");
        assert!(adj
            .lines
            .iter()
            .any(|l| l.kind == Some(SnapLineKind::Spacing)
                && (l.distance.unwrap() - 20.0).abs() < 1e-3));
    }

    #[test]
    fn spacing_off_leaves_the_gap_alone() {
        let s = rect_snap("m", (300.0, 97.0, 340.0, 197.0));
        let sess = session(vec![s]);
        let pages = vec![page("p1", 2000.0, 2000.0)];
        let sibs = [
            sibling("a", [290.0, 0.0, 350.0, 50.0]),
            sibling("b", [290.0, 250.0, 350.0, 300.0]),
        ];
        let env = SnapEnv {
            settings: crate::snap_point::SnapSettings {
                spacing: false,
                ..Default::default()
            },
            grid: None,
        };
        let adj = compute_snap_adjustment_with(&sess, (1.0, 0.0), &pages, &sibs, &env);
        assert!((adj.delta.0 - 1.0).abs() < 1e-3, "{adj:?}");
    }

    #[test]
    fn snap_to_pixel_lands_an_unsnapped_edge_on_a_whole_point() {
        let s = rect_snap("m", (300.25, 300.25, 340.0, 340.0));
        let sess = session(vec![s]);
        let pages = vec![page("p1", 2000.0, 2000.0)];
        let env = SnapEnv {
            settings: crate::snap_point::SnapSettings {
                pixel: true,
                ..Default::default()
            },
            grid: None,
        };
        let adj = compute_snap_adjustment_with(&sess, (10.1, 20.3), &pages, &[], &env);
        assert!((300.25 + adj.delta.0 - 310.0).abs() < 1e-3, "{adj:?}");
        assert!((300.25 + adj.delta.1 - 321.0).abs() < 1e-3, "{adj:?}");
        // Off, the move is the pointer's.
        let adj = compute_snap_adjustment(&sess, (10.1, 20.3), &pages, &[]);
        assert!((adj.delta.0 - 10.1).abs() < 1e-4);
    }

    #[test]
    fn the_host_grid_overrides_the_documents_divisions() {
        let settings = crate::snap_point::SnapSettings {
            grid: true,
            grid_every: Some(72.0),
            grid_subdivisions: Some(8),
            ..Default::default()
        };
        assert_eq!(
            settings.effective_grid(Some((12.0, 12.0))),
            Some((9.0, 9.0))
        );
        let plain = crate::snap_point::SnapSettings::default();
        assert_eq!(plain.effective_grid(Some((12.0, 12.0))), Some((12.0, 12.0)));
        // A move snaps its edge to the 9 pt grid.
        let s = rect_snap("m", (300.0, 300.0, 340.0, 340.0));
        let sess = session(vec![s]);
        let pages = vec![page("p1", 2000.0, 2000.0)];
        let env = SnapEnv {
            settings,
            grid: settings.effective_grid(None),
        };
        let adj = compute_snap_adjustment_with(&sess, (5.0, 0.0), &pages, &[], &env);
        // 305 → 306 (34 × 9).
        assert!((300.0 + adj.delta.0 - 306.0).abs() < 1e-3, "{adj:?}");
    }

    #[test]
    fn scale_snaps_the_dragged_handle_to_an_edge() {
        let s = rect_snap("m", (100.0, 100.0, 200.0, 200.0));
        let mut sess = session(vec![s]);
        sess.gesture = GestureType::Scale;
        sess.pivot_spread = Some((100.0, 100.0));
        sess.anchor_spread = Some((200.0, 200.0));
        let pages = vec![page("p1", 612.0, 792.0)];
        let sibs = [sibling("b", [400.0, 298.0, 500.0, 350.0])];
        let env = SnapEnv::default();
        // The handle at (200, 200) dragged to (296.5, 250): x snaps to 298.
        let adj = compute_scale_snap(&sess, (96.5, 50.0), &pages, &sibs, &env);
        assert!((adj.delta.0 - 98.0).abs() < 1e-3, "{adj:?}");
        assert!((adj.delta.1 - 50.0).abs() < 1e-3);
        assert_eq!(adj.lines.len(), 1);
        // A side handle level with the pivot on y leaves y alone.
        sess.anchor_spread = Some((200.0, 100.0));
        let adj = compute_scale_snap(&sess, (96.5, 1.0), &pages, &sibs, &env);
        assert!((adj.delta.1 - 1.0).abs() < 1e-4, "{adj:?}");
        // Translate is not scale.
        sess.gesture = GestureType::Translate;
        let adj = compute_scale_snap(&sess, (96.5, 50.0), &pages, &sibs, &env);
        assert_eq!(adj.delta, (96.5, 50.0));
    }

    #[test]
    #[allow(non_snake_case)]
    fn rotate_snaps_to_the_diagonal_and_a_neighbours_angle__feat__the_renderer_view_modes() {
        let s = rect_snap("m", (100.0, 100.0, 200.0, 200.0));
        let mut sess = session(vec![s]);
        sess.gesture = GestureType::Rotate;
        sess.pivot_spread = Some((150.0, 150.0));
        sess.anchor_spread = Some((250.0, 150.0)); // 100 pt right of the pivot
        let pages = vec![page("p1", 612.0, 792.0)];
        let env = SnapEnv::default();
        let at = |deg: f32| {
            let (s, c) = deg.to_radians().sin_cos();
            (150.0 + 100.0 * c - 250.0, 150.0 + 100.0 * s - 150.0)
        };
        let angle_of = |d: (f32, f32)| (d.1).atan2(100.0 + d.0).to_degrees();
        // 44° snaps to 45° (tolerance 4 px at 100 pt ≈ 2.3°).
        let adj = compute_rotate_snap(&sess, at(44.0), &pages, &[], &env);
        assert!((angle_of(adj.delta) - 45.0).abs() < 1e-2, "{adj:?}");
        let line = &adj.lines[0];
        assert_eq!(line.kind, Some(SnapLineKind::Angle));
        assert_eq!(line.from, Some([150.0, 150.0]));
        // 30.8° snaps to a neighbour turned 32°.
        let adj = compute_rotate_snap(&sess, at(30.8), &pages, &[32.0], &env);
        assert!((angle_of(adj.delta) - 32.0).abs() < 1e-2, "{adj:?}");
        // Far from every target, the pointer's angle stands.
        let adj = compute_rotate_snap(&sess, at(20.0), &pages, &[32.0], &env);
        assert!((angle_of(adj.delta) - 20.0).abs() < 1e-2);
        assert!(adj.lines.is_empty());
        // Shift's 15° steps are the gesture's: this passes through.
        sess.modifiers.shift = true;
        let adj = compute_rotate_snap(&sess, at(44.0), &pages, &[], &env);
        assert!((angle_of(adj.delta) - 44.0).abs() < 1e-2);
    }
}
