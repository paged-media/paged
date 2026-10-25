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

// THE PERSPECTIVE GRID TOOL and THE PERSPECTIVE SELECTION TOOL — their
// gesture machines, and the PLANE-SWITCHING WIDGET's layout.
//
// PerspectiveGridMachine (the grid's own handles):
//   down   → on a handle (draw-geometry `gridHandleAt`): drag it; on the
//            plane widget: switch the active plane (a commit of the grid
//            with only `activePlane` changed); else nothing. A LOCKED grid
//            refuses handle drags (the widget still switches planes)
//   move   → the grid with that handle at the pointer (`moveGridHandle`)
//   up     → COMMIT the new grid when it changed
//   Escape → cancel
//
// PerspectiveSelectMachine (artwork on the grid):
//   down   → the host says what is under the press: ATTACHED artwork (its
//            plane and flat, object-frame geometry), FREE artwork (its
//            page-space geometry), or nothing
//   move   → ATTACHED: moved along its own plane (`moveOnPlane`); FREE:
//            previewed attached to the ACTIVE plane where the pointer is
//            (`attachToPlane`, the press point as the grab point); NOTHING
//            with a shape option: a rectangle / ellipse on the active
//            plane, from the press to the pointer, in plane coordinates
//   up     → COMMIT { kind, plane, flat, page } — the host writes the page
//            geometry and records `plane` + `flat` on the element, so a
//            later move re-projects the flat geometry exactly instead of
//            un-projecting its own output
//   Escape → cancel
//
// THE WIDGET is Illustrator's plane switcher: four cells (left plane,
// floor, right plane, no plane) in a 2 × 2 block whose top-left corner
// and cell size the host chooses (screen-constant: it converts px at
// zoom). Keys 1–4 select the same four, as in Illustrator.

import {
  attachToPlane,
  flatEllipse,
  flatRect,
  gridHandleAt,
  moveGridHandle,
  moveOnPlane,
  pageToPlane,
  projectOntoPlane,
  type AnchorTable,
  type GridHandleId,
  type PerspectiveGrid,
  type PlaneId,
  type Vec2,
  type Vec2Mut,
} from "@paged-media/draw-geometry";

export type PlaneChoice = PlaneId | "none";

export interface PlaneWidgetCell {
  plane: PlaneChoice;
  /** [x0, y0, x1, y1], page pt. */
  box: [number, number, number, number];
}

/** The widget's four cells: left | right on top, floor | none below. */
export function planeWidgetLayout(at: Vec2, cell: number): PlaneWidgetCell[] {
  const [x, y] = at;
  const c = cell;
  return [
    { plane: "left", box: [x, y, x + c, y + c] },
    { plane: "right", box: [x + c, y, x + 2 * c, y + c] },
    { plane: "floor", box: [x, y + c, x + c, y + 2 * c] },
    { plane: "none", box: [x + c, y + c, x + 2 * c, y + 2 * c] },
  ];
}

/** The widget cell under `p`, or null. */
export function planeWidgetHit(
  cells: readonly PlaneWidgetCell[],
  p: Vec2,
): PlaneChoice | null {
  for (const c of cells)
    if (
      p[0] >= c.box[0] &&
      p[0] <= c.box[2] &&
      p[1] >= c.box[1] &&
      p[1] <= c.box[3]
    )
      return c.plane;
  return null;
}

/** Illustrator's keys: 1 left, 2 floor, 3 right, 4 none. */
export function planeForKey(key: string): PlaneChoice | null {
  return key === "1"
    ? "left"
    : key === "2"
      ? "floor"
      : key === "3"
        ? "right"
        : key === "4"
          ? "none"
          : null;
}

// ------------------------------------------------------------ the grid

export type GridEvent =
  | { type: "down"; point: Vec2 }
  | { type: "move"; point: Vec2 }
  | { type: "up"; point: Vec2 }
  | { type: "key"; key: string };

export interface GridMachineOptions {
  grid: PerspectiveGrid;
  /** pt — handle pick radius. */
  tolerance: number;
  /** The widget's cells (page pt), when the host shows it. */
  widget?: readonly PlaneWidgetCell[];
}

export interface GridSnapshot {
  grid: PerspectiveGrid;
  handle: GridHandleId | null;
  commit: PerspectiveGrid | null;
  active: boolean;
}

export class PerspectiveGridMachine {
  private grid: PerspectiveGrid;
  private handleId: GridHandleId | null = null;
  private done = false;

  constructor(private readonly opts: GridMachineOptions) {
    this.grid = opts.grid;
  }

  handle(event: GridEvent): GridSnapshot {
    if (this.done) return this.snapshot(null);
    switch (event.type) {
      case "down": {
        const cell = this.opts.widget
          ? planeWidgetHit(this.opts.widget, event.point)
          : null;
        if (cell) {
          this.done = true;
          this.grid = { ...this.grid, activePlane: cell };
          return this.snapshot(
            cell === this.opts.grid.activePlane ? null : this.grid,
          );
        }
        if (this.opts.grid.locked) {
          this.done = true;
          return this.snapshot(null);
        }
        this.handleId = gridHandleAt(
          this.grid,
          event.point,
          this.opts.tolerance,
        );
        if (!this.handleId) this.done = true;
        return this.snapshot(null);
      }
      case "move":
        if (this.handleId) {
          this.grid = moveGridHandle(
            this.opts.grid,
            this.handleId,
            event.point,
          );
        }
        return this.snapshot(null);
      case "up": {
        if (!this.handleId) {
          this.done = true;
          return this.snapshot(null);
        }
        this.grid = moveGridHandle(this.opts.grid, this.handleId, event.point);
        this.done = true;
        const changed =
          JSON.stringify(this.grid) !== JSON.stringify(this.opts.grid);
        return this.snapshot(changed ? this.grid : null);
      }
      case "key": {
        if (event.key === "Escape") {
          this.done = true;
          this.grid = this.opts.grid;
          return this.snapshot(null);
        }
        const plane = planeForKey(event.key);
        if (plane && !this.handleId) {
          this.done = true;
          this.grid = { ...this.grid, activePlane: plane };
          return this.snapshot(
            plane === this.opts.grid.activePlane ? null : this.grid,
          );
        }
        return this.snapshot(null);
      }
    }
  }

  private snapshot(commit: PerspectiveGrid | null): GridSnapshot {
    return {
      grid: this.grid,
      handle: this.handleId,
      commit,
      active: !this.done,
    };
  }
}

// ---------------------------------------------------- the selection tool

/** What the host found under the press. */
export type PerspectiveHit =
  | { kind: "attached"; plane: PlaneId; flat: AnchorTable }
  | { kind: "free"; table: AnchorTable }
  | { kind: "none" };

export type PerspectiveSelectEvent =
  | { type: "down"; point: Vec2; hit: PerspectiveHit }
  | { type: "move"; point: Vec2 }
  | { type: "up"; point: Vec2 }
  | { type: "key"; key: "Escape" };

export interface PerspectiveSelectOptions {
  grid: PerspectiveGrid;
  /** What a press on nothing draws: nothing, a rectangle or an ellipse. */
  shape: "none" | "rectangle" | "ellipse";
  /** pt — curve subdivision tolerance for the projection. */
  tolerance?: number;
}

export interface PerspectiveCommit {
  kind: "attach" | "move" | "draw";
  plane: PlaneId;
  /** Object-frame geometry on the plane. */
  flat: AnchorTable;
  /** Its projection, page space. */
  page: AnchorTable;
}

export interface PerspectiveSelectSnapshot {
  preview: AnchorTable | null;
  commit: PerspectiveCommit | null;
  active: boolean;
}

export class PerspectiveSelectMachine {
  private hit: PerspectiveHit = { kind: "none" };
  private start: Vec2Mut | null = null;
  private current: PerspectiveCommit | null = null;
  private done = false;

  constructor(private readonly opts: PerspectiveSelectOptions) {}

  private get active(): PlaneId | null {
    const p = this.opts.grid.activePlane;
    return p === "none" ? null : p;
  }

  private track(point: Vec2): void {
    const tol = this.opts.tolerance ?? 0.1;
    const g = this.opts.grid;
    const s = this.start!;
    const h = this.hit;
    if (h.kind === "attached") {
      const r = moveOnPlane(g, h.plane, h.flat, s, point, tol);
      this.current = r ? { kind: "move", plane: h.plane, ...r } : null;
      return;
    }
    const plane = this.active;
    if (!plane) {
      this.current = null;
      return;
    }
    if (h.kind === "free") {
      const r = attachToPlane(g, plane, h.table, s, point, tol);
      this.current = r ? { kind: "attach", plane, ...r } : null;
      return;
    }
    if (this.opts.shape === "none") return;
    const a = pageToPlane(g, plane, s);
    const b = pageToPlane(g, plane, point);
    if (!a || !b || a[0] === b[0] || a[1] === b[1]) {
      this.current = null;
      return;
    }
    const flat =
      this.opts.shape === "rectangle" ? flatRect(a, b) : flatEllipse(a, b);
    const page = projectOntoPlane(g, plane, flat, tol);
    this.current = page ? { kind: "draw", plane, flat, page } : null;
  }

  handle(event: PerspectiveSelectEvent): PerspectiveSelectSnapshot {
    if (this.done) return this.snapshot(null);
    switch (event.type) {
      case "down":
        this.hit = event.hit;
        this.start = [event.point[0], event.point[1]];
        if (event.hit.kind === "none" && this.opts.shape === "none") {
          this.done = true;
          return this.snapshot(null);
        }
        if (event.hit.kind !== "attached" && !this.active) {
          this.done = true;
          return this.snapshot(null);
        }
        return this.snapshot(null);
      case "move":
        if (this.start) this.track(event.point);
        return this.snapshot(null);
      case "up": {
        if (!this.start) {
          this.done = true;
          return this.snapshot(null);
        }
        const moved =
          event.point[0] !== this.start[0] || event.point[1] !== this.start[1];
        if (moved) this.track(event.point);
        this.done = true;
        return this.snapshot(moved ? this.current : null);
      }
      case "key":
        this.done = true;
        this.current = null;
        return this.snapshot(null);
    }
  }

  private snapshot(
    commit: PerspectiveCommit | null,
  ): PerspectiveSelectSnapshot {
    return { preview: this.current?.page ?? null, commit, active: !this.done };
  }
}
