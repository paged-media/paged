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

// The docks' widths (editor ADR "Docks are resizable and the workspace
// adapts"): the bounds a divider moves within, the widths a double-click
// restores, and how the docks give way so the canvas keeps a width to work
// in. Pure: the cockpit layout holds the state, `cockpit-persistence.ts`
// remembers it per workflow mode.

/** The resizable columns of the cockpit. */
export type DockId = "left" | "right" | "form";

/** A dock is never narrower than this (CSS px). */
export const DOCK_MIN_PX = 240;
/** A dock is never wider than this (CSS px). */
export const DOCK_MAX_PX = 480;

/** The widths a double-click on a divider restores: the cockpit's
 *  original fixed columns (the kit's 262 / 320, the form's 340). */
export const DOCK_DEFAULT_PX: Readonly<Record<DockId, number>> = {
  left: 262,
  right: 320,
  form: 340,
};

/** The canvas's working minimum: no docked panel pushes the canvas below
 *  it. A dock that would is clamped, and a workspace too narrow for it
 *  turns its docks into overlays (`workspace-class.ts`). */
export const CANVAS_MIN_WORKING_PX = 640;

/** One divider step of the arrow keys, and of Shift + an arrow. */
export const DOCK_KEY_STEP_PX = 8;
export const DOCK_KEY_STEP_LARGE_PX = 40;

/** A dock's width held inside the bounds (a non-number: its default). */
export function clampDockWidth(dock: DockId, px: number): number {
  if (!Number.isFinite(px)) return DOCK_DEFAULT_PX[dock];
  return Math.round(Math.max(DOCK_MIN_PX, Math.min(DOCK_MAX_PX, px)));
}

/** The widths a user chose, per dock; a missing one is the default. */
export type DockWidths = Partial<Record<DockId, number>>;

/** `widths` with every dock filled in and clamped. */
export function resolvedDockWidths(
  widths: DockWidths | undefined,
): Record<DockId, number> {
  return {
    left: clampDockWidth("left", widths?.left ?? DOCK_DEFAULT_PX.left),
    right: clampDockWidth("right", widths?.right ?? DOCK_DEFAULT_PX.right),
    form: clampDockWidth("form", widths?.form ?? DOCK_DEFAULT_PX.form),
  };
}

/**
 * The widths the DOCKED columns get in a work area `workArea` px wide, so
 * the canvas keeps `CANVAS_MIN_WORKING_PX`: each docked column takes the
 * width chosen for it, and when together they leave the canvas less than
 * its minimum they give way — the left dock first, then the form, then the
 * right (the inspector the user works in) — never below `DOCK_MIN_PX`. A
 * dock that is not docked (hidden, an overlay) takes no width and is
 * absent from the result. An unmeasured work area (0) clamps nothing.
 */
export function fitDocks(
  workArea: number,
  wanted: Partial<Record<DockId, number>>,
): Partial<Record<DockId, number>> {
  const out: Partial<Record<DockId, number>> = { ...wanted };
  if (!(workArea > 0)) return out;
  const total = () =>
    (out.left ?? 0) +
    (out.right ?? 0) +
    (out.form ?? 0) +
    CANVAS_MIN_WORKING_PX;
  for (const dock of ["left", "form", "right"] as const) {
    const now = out[dock];
    if (now === undefined) continue;
    const excess = total() - workArea;
    if (excess <= 0) break;
    out[dock] = Math.max(DOCK_MIN_PX, now - excess);
  }
  return out;
}

/**
 * The widest `dock` may be dragged to in a work area `workArea` px wide
 * while the other docked columns keep `others` px: the canvas keeps its
 * working minimum, and the dock stays inside its bounds.
 */
export function maxDockWidth(workArea: number, others: number): number {
  if (!(workArea > 0)) return DOCK_MAX_PX;
  const room = workArea - others - CANVAS_MIN_WORKING_PX;
  return Math.max(DOCK_MIN_PX, Math.min(DOCK_MAX_PX, Math.floor(room)));
}

/** What a flyout or a drawer leaves of the canvas beside it: a strip the
 *  user can still press to close it. */
export const OVERLAY_GUTTER_PX = 48;

/** The widest a flyout or a drawer may be in a work area `workArea` px
 *  wide: it covers the canvas but leaves the gutter, inside the bounds. */
export function maxOverlayWidth(workArea: number): number {
  if (!(workArea > 0)) return DOCK_MAX_PX;
  return Math.max(
    DOCK_MIN_PX,
    Math.min(DOCK_MAX_PX, Math.floor(workArea - OVERLAY_GUTTER_PX)),
  );
}

/** The width after a divider key (`ArrowLeft`/`ArrowRight` move the
 *  divider, so they shrink or grow a dock by the side it is on; `Home` /
 *  `End` jump to the bounds; Enter restores the default). Null for a key
 *  the divider does not take. */
export function dockWidthForKey(
  dock: DockId,
  side: "start" | "end",
  width: number,
  key: string,
  shift: boolean,
  max: number,
): number | null {
  const step = shift ? DOCK_KEY_STEP_LARGE_PX : DOCK_KEY_STEP_PX;
  // A dock on the start side (the left dock) grows when its divider moves
  // right; one on the end side (the right dock) when it moves left.
  const grow = side === "start" ? "ArrowRight" : "ArrowLeft";
  const shrink = side === "start" ? "ArrowLeft" : "ArrowRight";
  let next: number;
  if (key === grow) next = width + step;
  else if (key === shrink) next = width - step;
  else if (key === "Home") next = DOCK_MIN_PX;
  else if (key === "End") next = max;
  // The default itself, as a double-click restores it: the layout gives
  // way where the space is short (`fitDocks`), the choice stays.
  else if (key === "Enter") return DOCK_DEFAULT_PX[dock];
  else return null;
  return Math.min(max, clampDockWidth(dock, next));
}
