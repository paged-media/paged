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

// THE REFLECT TOOL's gesture machine — Illustrator's three-part tool:
//
//   click            → the AXIS POINT moves there (it stays for every
//                      later gesture while the tool is active; before the
//                      first click it is the selection's centre, which the
//                      host hands in with `setDefaultPivot`)
//   drag             → the AXIS turns through the axis point to follow the
//                      pointer (its angle = the direction from the axis
//                      point to the pointer), previewed live; Shift snaps
//                      it to 45°. Release COMMITS a reflection across
//                      that axis — Alt held at release reflects a COPY
//   Alt+click        → the axis point moves there AND the options open
//                      (angle, copy) — the host raises its form
//   Escape           → cancels a drag in flight
//
// Host-agnostic: page-local pt in, the axis and the commit out. The
// reflection itself is `affineReflect(angleDeg, pivot)` — the same math
// the Reflect commands use (draw-bundle `commands/transform.ts`).

import { dist, type Vec2, type Vec2Mut } from "@paged-media/draw-geometry";

export interface ReflectModifiers {
  alt: boolean;
  shift: boolean;
}

export type ReflectEvent =
  | { type: "down"; point: Vec2; modifiers?: ReflectModifiers }
  | { type: "move"; point: Vec2; modifiers?: ReflectModifiers }
  | { type: "up"; point: Vec2; modifiers?: ReflectModifiers }
  | { type: "key"; key: "Escape" };

export interface ReflectOptions {
  /** pt — a press that travels less than this is a CLICK. */
  clickTolerance: number;
}

export interface ReflectCommit {
  pivot: Vec2Mut;
  /** The axis' angle, degrees from +x (y down). */
  angleDeg: number;
  copy: boolean;
}

export interface ReflectSnapshot {
  /** The axis point (null until clicked or defaulted). */
  pivot: Vec2Mut | null;
  /** The axis being dragged, degrees — null when not dragging. */
  axisAngleDeg: number | null;
  /** Non-null once, on the release that ends a drag. */
  commit: ReflectCommit | null;
  /** Non-null once, on an Alt+click: open the options, axis point here. */
  openOptions: Vec2Mut | null;
}

/** The step Shift snaps the axis to. */
export const REFLECT_SNAP_DEG = 45;

/** The axis angle from `pivot` toward `point`, degrees. */
export function axisAngleOf(pivot: Vec2, point: Vec2, snap: boolean): number {
  const deg =
    (Math.atan2(point[1] - pivot[1], point[0] - pivot[0]) * 180) / Math.PI;
  return snap ? Math.round(deg / REFLECT_SNAP_DEG) * REFLECT_SNAP_DEG : deg;
}

export class ReflectMachine {
  private pivot: Vec2Mut | null = null;
  private defaultPivot: Vec2Mut | null = null;
  private press: Vec2Mut | null = null;
  private dragging = false;
  private angle: number | null = null;

  constructor(private readonly options: ReflectOptions) {}

  /** The axis point before the user has clicked one (the selection's
   *  centre). An explicit click always wins. */
  setDefaultPivot(p: Vec2 | null): void {
    this.defaultPivot = p ? [p[0], p[1]] : null;
  }

  /** The axis point in force. */
  currentPivot(): Vec2Mut | null {
    return this.pivot ?? this.defaultPivot;
  }

  handle(event: ReflectEvent): ReflectSnapshot {
    switch (event.type) {
      case "down":
        this.press = [event.point[0], event.point[1]];
        this.dragging = false;
        this.angle = null;
        return this.snapshot(null, null);
      case "move": {
        if (!this.press) return this.snapshot(null, null);
        if (!this.dragging && dist(this.press, event.point) >= this.options.clickTolerance)
          this.dragging = true;
        const pivot = this.currentPivot();
        if (this.dragging && pivot && dist(pivot, event.point) > 0)
          this.angle = axisAngleOf(pivot, event.point, event.modifiers?.shift ?? false);
        return this.snapshot(null, null);
      }
      case "up": {
        if (!this.press) return this.snapshot(null, null);
        const wasDrag =
          this.dragging || dist(this.press, event.point) >= this.options.clickTolerance;
        this.press = null;
        this.dragging = false;
        if (!wasDrag) {
          this.angle = null;
          this.pivot = [event.point[0], event.point[1]];
          return this.snapshot(null, event.modifiers?.alt ? [...this.pivot] : null);
        }
        const pivot = this.currentPivot();
        if (!pivot || dist(pivot, event.point) === 0) {
          this.angle = null;
          return this.snapshot(null, null);
        }
        const angleDeg = axisAngleOf(pivot, event.point, event.modifiers?.shift ?? false);
        this.angle = null;
        return this.snapshot(
          { pivot: [pivot[0], pivot[1]], angleDeg, copy: event.modifiers?.alt ?? false },
          null,
        );
      }
      case "key":
        this.press = null;
        this.dragging = false;
        this.angle = null;
        return this.snapshot(null, null);
    }
  }

  private snapshot(
    commit: ReflectCommit | null,
    openOptions: Vec2Mut | null,
  ): ReflectSnapshot {
    const p = this.currentPivot();
    return {
      pivot: p ? [p[0], p[1]] : null,
      axisAngleDeg: this.angle,
      commit,
      openOptions,
    };
  }
}
