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

// THE STAR and FLARE tools' gesture machines.
//
// STAR — press at the CENTRE and drag: the distance to the pointer is
// Radius 1 (the tips) and the direction turns the star; Radius 2 keeps the
// RATIO to Radius 1 the drag started with (the tool option), so the star
// grows without changing its shape. Shift keeps it upright. Arrow Up /
// Arrow Down during the drag add / remove a point (3…1000). A CLICK
// (no drag) asks for the options at that centre — Illustrator's dialog —
// and the host decides what that is.
//
// FLARE — Illustrator's two-step gesture: press at the CENTRE and drag to
// size the centre disc and the halo (the rays scale with it); release;
// then press-drag-release a second time to put the END of the rings'
// line. Escape between the two commits the flare without rings at the
// first size (Illustrator keeps what has been set). A click on the first
// step asks for the options at that point.

import {
  dist,
  STAR_MAX_POINTS,
  STAR_MIN_POINTS,
  type Vec2,
  type Vec2Mut,
} from "@paged-media/draw-geometry";

export interface ShapeModifiers {
  shift: boolean;
}

export type StarEvent =
  | { type: "down"; point: Vec2; modifiers?: ShapeModifiers }
  | { type: "move"; point: Vec2; modifiers?: ShapeModifiers }
  | { type: "up"; point: Vec2; modifiers?: ShapeModifiers }
  | { type: "key"; key: "Escape" | "ArrowUp" | "ArrowDown" };

export interface StarMachineOptions {
  /** Tips at the start of the drag. */
  points: number;
  /** Radius 2 ÷ Radius 1 (> 0; > 1 puts the valleys outside). */
  ratio: number;
  /** pt — a press that travels less than this is a click. */
  clickTolerance: number;
}

export interface StarShape {
  cx: number;
  cy: number;
  radius1: number;
  radius2: number;
  points: number;
  rotationDeg: number;
}

export interface StarSnapshot {
  /** The star being dragged (the preview); null before a drag. */
  star: StarShape | null;
  commit: StarShape | null;
  /** Non-null once, on a click: open the options for a star here. */
  openOptions: Vec2Mut | null;
  active: boolean;
}

/** The rotation that puts the first tip at `point` (Shift: upright). */
function rotationOf(centre: Vec2, point: Vec2, upright: boolean): number {
  if (upright) return 0;
  return (
    (Math.atan2(point[1] - centre[1], point[0] - centre[0]) * 180) / Math.PI +
    90
  );
}

export class StarMachine {
  private centre: Vec2Mut | null = null;
  private points: number;
  private star: StarShape | null = null;
  private dragging = false;
  private done = false;

  constructor(private readonly options: StarMachineOptions) {
    this.points = clampPoints(options.points);
  }

  handle(event: StarEvent): StarSnapshot {
    if (this.done) return this.snapshot(null, null);
    switch (event.type) {
      case "down":
        this.centre = [event.point[0], event.point[1]];
        return this.snapshot(null, null);
      case "move":
        if (!this.centre) return this.snapshot(null, null);
        if (
          !this.dragging &&
          dist(this.centre, event.point) >= this.options.clickTolerance
        )
          this.dragging = true;
        if (this.dragging)
          this.track(event.point, event.modifiers?.shift ?? false);
        return this.snapshot(null, null);
      case "up": {
        if (!this.centre) return this.snapshot(null, null);
        this.done = true;
        if (
          !this.dragging &&
          dist(this.centre, event.point) < this.options.clickTolerance
        )
          return this.snapshot(null, [...this.centre]);
        this.track(event.point, event.modifiers?.shift ?? false);
        return this.snapshot(this.star, null);
      }
      case "key":
        if (event.key === "Escape") {
          this.done = true;
          this.star = null;
          return this.snapshot(null, null);
        }
        this.points = clampPoints(
          this.points + (event.key === "ArrowUp" ? 1 : -1),
        );
        if (this.star) this.star = { ...this.star, points: this.points };
        return this.snapshot(null, null);
    }
  }

  private track(point: Vec2, upright: boolean): void {
    const c = this.centre!;
    const r1 = dist(c, point);
    this.star = {
      cx: c[0],
      cy: c[1],
      radius1: r1,
      radius2: r1 * this.options.ratio,
      points: this.points,
      rotationDeg: rotationOf(c, point, upright),
    };
  }

  private snapshot(
    commit: StarShape | null,
    open: Vec2Mut | null,
  ): StarSnapshot {
    return { star: this.star, commit, openOptions: open, active: !this.done };
  }
}

function clampPoints(n: number): number {
  return Math.round(Math.min(STAR_MAX_POINTS, Math.max(STAR_MIN_POINTS, n)));
}

// ---------------------------------------------------------------- flare

export type FlareEvent =
  | { type: "down"; point: Vec2 }
  | { type: "move"; point: Vec2 }
  | { type: "up"; point: Vec2 }
  | { type: "key"; key: "Escape" };

export interface FlareGesture {
  centre: Vec2Mut;
  /** pt — the drag's length: the halo's radius. */
  size: number;
  /** The rings' end point; null = no rings line set. */
  end: Vec2Mut | null;
}

export interface FlareSnapshot {
  /** "size" during the first drag, "end" between / during the second. */
  step: "size" | "end";
  flare: FlareGesture | null;
  commit: FlareGesture | null;
  openOptions: Vec2Mut | null;
  active: boolean;
}

export class FlareMachine {
  private step: "size" | "end" = "size";
  private flare: FlareGesture | null = null;
  private pressing = false;
  private done = false;

  constructor(private readonly options: { clickTolerance: number }) {}

  handle(event: FlareEvent): FlareSnapshot {
    if (this.done) return this.snapshot(null, null);
    switch (event.type) {
      case "down":
        this.pressing = true;
        if (this.step === "size")
          this.flare = {
            centre: [event.point[0], event.point[1]],
            size: 0,
            end: null,
          };
        else if (this.flare)
          this.flare = { ...this.flare, end: [event.point[0], event.point[1]] };
        return this.snapshot(null, null);
      case "move":
        if (this.pressing) this.track(event.point);
        else if (this.step === "end" && this.flare)
          this.flare = { ...this.flare, end: [event.point[0], event.point[1]] };
        return this.snapshot(null, null);
      case "up": {
        if (!this.pressing || !this.flare) return this.snapshot(null, null);
        this.pressing = false;
        this.track(event.point);
        if (this.step === "size") {
          if (this.flare.size < this.options.clickTolerance) {
            this.done = true;
            const at = this.flare.centre;
            this.flare = null;
            return this.snapshot(null, [at[0], at[1]]);
          }
          this.step = "end";
          return this.snapshot(null, null);
        }
        this.done = true;
        return this.snapshot(this.flare, null);
      }
      case "key": {
        this.done = true;
        // Between the steps Escape keeps the flare as sized (no rings).
        const keep =
          this.step === "end" && this.flare
            ? { ...this.flare, end: null }
            : null;
        if (!keep) this.flare = null;
        return this.snapshot(keep, null);
      }
    }
  }

  private track(point: Vec2): void {
    if (!this.flare) return;
    if (this.step === "size")
      this.flare = { ...this.flare, size: dist(this.flare.centre, point) };
    else this.flare = { ...this.flare, end: [point[0], point[1]] };
  }

  private snapshot(
    commit: FlareGesture | null,
    open: Vec2Mut | null,
  ): FlareSnapshot {
    return {
      step: this.step,
      flare: this.flare,
      commit,
      openOptions: open,
      active: !this.done,
    };
  }
}
