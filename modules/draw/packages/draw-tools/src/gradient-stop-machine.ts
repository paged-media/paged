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

// ON-CANVAS GRADIENT STOPS — the gesture machine behind the Gradient
// Annotator's stop markers. Host-agnostic: the annotator AXIS (where the
// ramp is drawn on the page) and the stops' locations in; marker
// positions, the stop being dragged and, on release, the ONE location
// change out. What a change writes is the bundle's
// (`handlers/gradient-annotator.ts`).
//
//   down on a marker  → grab that stop (the NEAREST marker within
//                       `hitTolerance`); down anywhere else → not this
//                       machine's gesture (`grabbed: false`), and the
//                       host does what it did before (the axis drag)
//   move              → the stop follows the pointer's PROJECTION onto
//                       the axis, as a percentage of its length, CLAMPED
//                       between its two neighbours — a stop never passes
//                       another, so the ramp's order (and each stop's
//                       midpoint, which belongs to the stop it follows)
//                       keeps its meaning
//   up                → COMMIT `{ index, locationPct }` when the location
//                       changed; a press that did not move commits nothing
//   Escape            → cancel; the markers go back where they were
//
// Locations are IDML's 0..100 `Location`, rounded to 0.01 % on commit.

import type { Vec2, Vec2Mut } from "@paged-media/draw-geometry";

/** Where the ramp is drawn: from `origin`, `lengthPt` along `angleDeg`
 *  (degrees from +x, y down — the `frameGradientFillAngle` convention). */
export interface GradientAxis {
  origin: Vec2;
  angleDeg: number;
  lengthPt: number;
}

export type GradientStopEvent =
  | { type: "down"; point: Vec2 }
  | { type: "move"; point: Vec2 }
  | { type: "up"; point: Vec2 }
  | { type: "key"; key: "Escape" };

export interface GradientStopOptions {
  axis: GradientAxis;
  /** Each stop's location, 0..100, in ramp order. */
  locations: readonly number[];
  /** Page pt within which a press grabs a marker. */
  hitTolerance: number;
}

export interface GradientStopCommit {
  index: number;
  locationPct: number;
}

export interface GradientStopSnapshot {
  /** Every stop's location as previewed (the dragged one moved). */
  locations: readonly number[];
  /** Where each marker sits on the page. */
  points: readonly Vec2Mut[];
  /** The stop being dragged, or null. */
  dragging: number | null;
  /** True on a `down` this machine took (a marker was hit). */
  grabbed: boolean;
  /** Non-null exactly once, on the `up` that moved a stop. */
  commit: GradientStopCommit | null;
}

/** The page point at `pct` % along the axis. Pure. */
export function pointOnAxis(axis: GradientAxis, pct: number): Vec2Mut {
  const r = (axis.angleDeg * Math.PI) / 180;
  const d = (pct / 100) * axis.lengthPt;
  return [axis.origin[0] + Math.cos(r) * d, axis.origin[1] + Math.sin(r) * d];
}

/** `point` projected onto the axis, as a percentage of its length
 *  (unclamped; NaN-free — a zero-length axis answers 0). Pure. */
export function axisPercentAt(axis: GradientAxis, point: Vec2): number {
  if (!(axis.lengthPt > 0)) return 0;
  const r = (axis.angleDeg * Math.PI) / 180;
  const along =
    (point[0] - axis.origin[0]) * Math.cos(r) + (point[1] - axis.origin[1]) * Math.sin(r);
  return (along / axis.lengthPt) * 100;
}

/** `pct` clamped between stop `index`'s neighbours (and to 0..100). */
export function clampStopLocation(
  locations: readonly number[],
  index: number,
  pct: number,
): number {
  const lo = index > 0 ? locations[index - 1]! : 0;
  const hi = index < locations.length - 1 ? locations[index + 1]! : 100;
  return Math.min(Math.max(pct, Math.max(0, lo)), Math.min(100, hi));
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export class GradientStopMachine {
  private readonly base: number[];
  private live: number[];
  private dragging: number | null = null;

  constructor(private readonly options: GradientStopOptions) {
    this.base = [...options.locations];
    this.live = [...options.locations];
  }

  handle(event: GradientStopEvent): GradientStopSnapshot {
    switch (event.type) {
      case "down": {
        const hit = this.hitAt(event.point);
        if (hit === null) return this.snapshot({ grabbed: false });
        this.dragging = hit;
        return this.snapshot({ grabbed: true });
      }
      case "move":
        if (this.dragging !== null) this.follow(this.dragging, event.point);
        return this.snapshot();
      case "up": {
        if (this.dragging === null) return this.snapshot();
        const index = this.dragging;
        this.follow(index, event.point);
        this.dragging = null;
        const pct = round2(this.live[index]!);
        if (pct === round2(this.base[index]!)) {
          this.live = [...this.base];
          return this.snapshot();
        }
        this.live[index] = pct;
        return this.snapshot({ commit: { index, locationPct: pct } });
      }
      case "key":
        this.dragging = null;
        this.live = [...this.base];
        return this.snapshot();
    }
  }

  /** The nearest marker within the tolerance, or null. */
  private hitAt(point: Vec2): number | null {
    let best: number | null = null;
    let bestD = this.options.hitTolerance;
    this.live.forEach((pct, i) => {
      const p = pointOnAxis(this.options.axis, pct);
      const d = Math.hypot(p[0] - point[0], p[1] - point[1]);
      if (d <= bestD) {
        best = i;
        bestD = d;
      }
    });
    return best;
  }

  private follow(index: number, point: Vec2): void {
    const next = [...this.live];
    next[index] = clampStopLocation(this.base, index, axisPercentAt(this.options.axis, point));
    this.live = next;
  }

  private snapshot(
    extra: { grabbed?: boolean; commit?: GradientStopCommit } = {},
  ): GradientStopSnapshot {
    return {
      locations: this.live,
      points: this.live.map((pct) => pointOnAxis(this.options.axis, pct)),
      dragging: this.dragging,
      grabbed: extra.grabbed ?? false,
      commit: extra.commit ?? null,
    };
  }
}
