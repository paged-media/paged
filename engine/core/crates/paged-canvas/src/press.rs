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

//! Engine ADR 1303 — the press: hit test, selection and gesture begin in
//! one call (`UXI-OWN-006`, `UXI-OWN-007`, `UXI-T58`).
//!
//! A press-drag used to take three round trips — a hit test, a selection
//! update, a gesture begin — and the host had to keep the press's geometry
//! and modifiers across all three and buffer the pointer meanwhile. Here
//! the engine answers all three against the same document state, at the
//! press point: what was hit, what the press selected, and the gesture's
//! handle (or that nothing was hit, so the drag is a marquee). The moves
//! that follow are deltas from the press point, so a drag that starts
//! before the answer arrives starts from where the pointer went down.

use serde::{Deserialize, Serialize};
use tsify_next::Tsify;

use crate::channel::HitFilter;
use crate::element_selection::ElementId;
use crate::gesture::{GestureAnchor, GestureError, GestureHandle, GestureModifiers, GestureType};
use crate::hit::HitTestResult;
use crate::model::CanvasModel;
use crate::PageId;

/// How a press changes the selection.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi)]
#[serde(rename_all = "camelCase")]
pub enum PressSelect {
    /// An item not selected becomes the whole selection; a press on a
    /// selected item keeps the selection, so the drag moves all of it
    /// (`UXI-SEL-004`).
    #[default]
    Replace,
    /// An item not selected joins the selection; a selected one stays in
    /// it. A drag never takes an item out: deselecting is the click's
    /// (D-01), which the host resolves on a release without a drag.
    Toggle,
    /// The selection is kept as it is and the drag moves it, whatever the
    /// press hit (a press inside the selection's box). With nothing
    /// selected it is `Replace`.
    Keep,
}

/// Which item a press on a group member takes.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum PressTarget {
    /// The outermost group holding the hit item, or the item when no group
    /// holds it (a click on the canvas).
    #[default]
    Outermost,
    /// The hit item itself, whatever group holds it (direct selection).
    Leaf,
    /// Inside the entered group `id`: the hit item when the group holds
    /// it, else the outermost group holding it (a press outside the
    /// entered group leaves it).
    InGroup { id: String },
}

/// `BeginGestureAt`'s payload: the press.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi, missing_as_null)]
#[serde(rename_all = "camelCase")]
pub struct GesturePress {
    /// The page the point is measured from.
    pub page_id: PageId,
    /// The press point, page-local pt (the hit test's `docPoint`).
    pub point: (f32, f32),
    /// The modifiers held at the press (the gesture's first ones); absent ⇒
    /// none.
    #[serde(default)]
    #[tsify(optional)]
    pub modifiers: GestureModifiers,
    /// Absent ⇒ `replace`.
    #[serde(default)]
    #[tsify(optional)]
    pub select: PressSelect,
    /// Absent ⇒ `outermost`.
    #[serde(default)]
    #[tsify(optional)]
    pub target: PressTarget,
    /// The root of the active edit context: an item outside its scope
    /// (engine ADR 1301) is neither selected nor moved (`UXI-CTX-010`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[tsify(optional)]
    pub scope: Option<ElementId>,
    /// The gesture to begin; absent ⇒ `translate`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[tsify(optional)]
    pub gesture: Option<GestureType>,
    /// The hit test's filter; absent ⇒ `any`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[tsify(optional)]
    pub filter: Option<HitFilter>,
    /// The camera scale (px/pt) shown at the press, for the snapping
    /// tolerance.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[tsify(optional)]
    pub camera_scale: Option<f32>,
}

/// What a press did ([`CanvasModel::begin_gesture_at`]).
#[derive(Debug, Default)]
pub struct PressOutcome {
    /// The hit test at the press point.
    pub hit: HitTestResult,
    /// The item the press took (by [`PressTarget`]); `None` when it hit
    /// nothing, kept the selection, or hit outside the scope.
    pub target: Option<ElementId>,
    /// The selection after the press.
    pub selection: Vec<ElementId>,
    /// Whether the press changed the selection.
    pub selection_changed: bool,
    /// The gesture begun; `None` when none was (see the other fields).
    pub handle: Option<GestureHandle>,
    /// Nothing was hit (and nothing was kept): the drag is a marquee. The
    /// selection is untouched; the marquee's release decides it.
    pub marquee: bool,
    /// The hit item lies outside `scope`: nothing changed.
    pub out_of_scope: bool,
    /// Why the gesture was not begun although the press took an item
    /// (locked, not permitted, a copy refused, another gesture active).
    /// The selection change stands: a locked item is selectable (D-08).
    pub refused: Option<GestureError>,
}

impl CanvasModel {
    /// Engine ADR 1303 — a press: hit test at `press.point`, the selection
    /// changed by `press.select`, and the gesture begun on the selection,
    /// anchored at the press point, in one call against one document
    /// state. A press while a gesture is active changes nothing and is
    /// refused (`AlreadyActive`).
    pub fn begin_gesture_at(&mut self, press: &GesturePress) -> PressOutcome {
        let mut out = PressOutcome::default();
        if let Some(active) = self.active_gesture_handle() {
            out.selection = self.element_selection.ids.clone();
            out.refused = Some(GestureError::AlreadyActive(active));
            return out;
        }
        out.hit = self.hit_test_filtered(
            &press.page_id,
            press.point,
            press.filter.unwrap_or(HitFilter::Any),
        );
        let keep = press.select == PressSelect::Keep && !self.element_selection.is_empty();
        if !keep {
            let Some(leaf) = out.hit.element.clone() else {
                out.marquee = true;
                out.selection = self.element_selection.ids.clone();
                return out;
            };
            let target = press_target(&leaf, &out.hit.group_chain, &press.target);
            if let Some(root) = press.scope.as_ref() {
                if !self.scope_subtree(root).contains(root, &target) {
                    out.out_of_scope = true;
                    out.selection = self.element_selection.ids.clone();
                    return out;
                }
            }
            if !self.element_selection.contains(&target) {
                match press.select {
                    PressSelect::Toggle => self.element_selection.add(target.clone()),
                    PressSelect::Replace | PressSelect::Keep => {
                        self.element_selection.set(vec![target.clone()])
                    }
                }
                out.selection_changed = true;
            }
            out.target = Some(target);
        }
        out.selection = self.element_selection.ids.clone();
        let anchor = GestureAnchor {
            page_id: press.page_id.clone(),
            point_in_page: press.point,
            pivot_in_page: None,
            shear_axis: None,
        };
        match self.begin_gesture_with(
            out.selection.clone(),
            press.gesture.unwrap_or(GestureType::Translate),
            Some(anchor),
            press.camera_scale,
            press.modifiers,
        ) {
            Ok(handle) => out.handle = Some(handle),
            Err(e) => out.refused = Some(e),
        }
        out
    }
}

/// The item a press on `leaf` takes, by `target`.
fn press_target(leaf: &ElementId, chain: &[String], target: &PressTarget) -> ElementId {
    let outermost = || {
        chain
            .first()
            .map_or_else(|| leaf.clone(), |g| ElementId::Group(g.clone()))
    };
    match target {
        PressTarget::Leaf => leaf.clone(),
        PressTarget::Outermost => outermost(),
        PressTarget::InGroup { id } if chain.iter().any(|g| g == id) => leaf.clone(),
        PressTarget::InGroup { .. } => outermost(),
    }
}
