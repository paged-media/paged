/*
 * This file is part of paged (https://paged.media), the commercial editor
 * for the paged IDML engine.
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

// Editing aids and Proof view (editor ADR "Editing aids and Proof view";
// the redesign strategy's §4.1 and §4.5; the interaction contract's
// UXI-GDE-003 / -004 and UXI-OVR-002).
//
// The canvas draws four kinds of thing over the page: the document, the
// EDITING AIDS (the nonprinting structure: frame edges, margins and
// columns, the ruler guides, the baseline grid, text threads, overset
// markers, hidden characters, nonprinting items), the EDITING CHROME (the
// selection, its handles and ports, path points, field and data markers,
// comment pins, page captions) and the transient feedback of a gesture
// (the marquee, the tool's preview, snap lines, the caret). Each aid is
// its own remembered toggle (`view-toggles.ts`); guides are a document's
// own lines and named as such, apart from the margins and the grids
// (GDE-003).
//
// PROOF VIEW is the screen mode that shows the publication: every aid and
// all editing chrome hidden, the pasteboard masked outside the trim
// (Proof view, InDesign's Preview), the bleed (Bleed) or the slug (Slug),
// with the trim marked — never the selection changed, so toggling it
// keeps what is selected. The overlay host is the one place that applies
// it (`overlayShown`): an overlay is listed here by its id, not asked to
// check a mode of its own.

import { defineMessages, t } from "@paged-media/strings";

import type { ScreenMode } from "./screen-mode-context";
import { OVERVIEW_HIDDEN_OVERLAYS, zoomTier } from "./semantic-zoom";
import type { EditingAidToggle, ViewToggle } from "./view-toggles";

/** The aids' names: one per aid, the same in the View menu and the
 *  bottom bar's control. Guides are the document's ruler guides, named
 *  apart from margins and columns and the grids (UXI-GDE-003). */
export const EDITING_AID_LABELS = defineMessages("shell.editingAids", {
  frameEdges: "Frame edges",
  marginsColumns: "Margins and columns",
  guides: "Ruler guides",
  baselineGrid: "Baseline grid",
  textThreads: "Text threads",
  oversetMarkers: "Overset markers",
  hiddenCharacters: "Hidden characters",
  nonprinting: "Nonprinting items",
  control: "Editing aids",
  proofView: "Proof view",
});

/** An aid's name in the editor's language. */
export function editingAidLabel(aid: EditingAidToggle): string {
  return t(EDITING_AID_LABELS[aid]);
}

/** The aid that is a render option of the engine rather than an overlay:
 *  with Nonprinting items off the engine leaves those items off the screen
 *  (`ViewSettings.hideNonprinting`, engine ADR 1306), as it does in every
 *  proof. `view-settings-sync.tsx` hands it over. */
export const RENDER_AIDS: ReadonlySet<EditingAidToggle> = new Set([
  "nonprinting",
]);

/** Is screen mode `mode` a proof (anything but Normal)? */
export function isProofMode(mode: ScreenMode | null | undefined): boolean {
  return mode != null && mode !== "normal";
}

/** The overlays each aid draws, by contribution id. */
export const AID_OVERLAYS: Readonly<Record<string, EditingAidToggle>> = {
  "paged.overlay.frameEdges": "frameEdges",
  "paged.margin-guides": "marginsColumns",
  "paged.guide-overlay": "guides",
  "paged.ruler-guides": "guides",
  "paged.overlay.baselineGrid": "baselineGrid",
  "paged.overlay.threadLines": "textThreads",
  "paged.overlay.oversetMarkers": "oversetMarkers",
  "paged.overlay.hiddenCharacters": "hiddenCharacters",
};

/** The editing chrome Proof view hides as well as the aids: the
 *  selection and its handles and ports, path points, the live-shape
 *  widgets, the content grabber, a table cell's outline, page captions,
 *  the document grid, data and template field markers, comment pins and
 *  the markup margin band. The marquee, a tool's preview, snap lines and
 *  the caret stay: they are the feedback of what the user is doing now. */
export const PROOF_HIDDEN_OVERLAYS: ReadonlySet<string> = new Set([
  "paged.selection-chrome",
  "paged.resize-handles",
  "paged.rotate-handle",
  "paged.threading-ports",
  "paged.live-shape-handles",
  "paged.content-grabber",
  "paged.path-edit",
  "paged.table-cell-overlay",
  "paged.page-decorations",
  "paged.grid",
  "paged.overlay.dataMarkers",
  "paged.template-fields",
  "paged.overlay.commentPins",
  "paged.marginBand",
  "paged.hit-marker",
]);

/** The overlay that draws the proof surface (shown only in a proof). */
export const PROOF_SURFACE_OVERLAY = "paged.overlay.proofSurface";

/**
 * Does overlay `id` draw, given the toggles (`toggle(aid)`), the screen
 * mode and the camera's scale? An aid's overlay draws while its aid is on
 * and the view is not a proof; the editing chrome draws outside a proof;
 * the proof surface only in one; the handles not in an overview (semantic
 * zoom, `semantic-zoom.ts`); every other overlay always.
 */
export function overlayShown(
  id: string,
  toggle: (which: ViewToggle) => boolean,
  mode: ScreenMode | null | undefined,
  scale?: number,
): boolean {
  const proof = isProofMode(mode);
  if (
    scale !== undefined &&
    zoomTier(scale) === "overview" &&
    OVERVIEW_HIDDEN_OVERLAYS.has(id)
  )
    return false;
  if (id === PROOF_SURFACE_OVERLAY) return proof;
  const aid = AID_OVERLAYS[id];
  if (aid) return !proof && toggle(aid);
  if (PROOF_HIDDEN_OVERLAYS.has(id)) return !proof;
  return true;
}
