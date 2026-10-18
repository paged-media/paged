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

// The Measure tool's state machine — host-agnostic and READ-ONLY (it
// drives no mutations): a drag in, a measured line + readout out.
//
//   down          → set the measure origin
//   move (down)   → live readout to the pointer (Shift constrains the
//                   measured ray to 45° steps)
//   up            → freeze the readout (the line stays displayed until
//                   the next down or Escape)
//   Escape        → clear
//
// Units: everything is page-local pt (distance/dx/dy); `angleDeg` is
// degrees from +x, y-down screen-style (CCW-negative), in (−180, 180].

import { clone, constrainAngle, type Vec2 } from "@paged-media/draw-geometry";

export interface MeasureModifiers {
  shift: boolean;
}

export type MeasureEvent =
  | { type: "down"; point: Vec2; modifiers: MeasureModifiers }
  | { type: "move"; point: Vec2; modifiers: MeasureModifiers }
  | { type: "up"; point: Vec2; modifiers: MeasureModifiers }
  | { type: "key"; key: "Escape" };

/** What the host displays/publishes. All lengths in pt. */
export interface MeasureReadout {
  from: [number, number];
  to: [number, number];
  dx: number;
  dy: number;
  distance: number;
  /** Degrees from +x (y down), in (−180, 180]. */
  angleDeg: number;
}

export interface MeasureSnapshot {
  /** The measured segment to draw, or null when nothing is measured. */
  line: readonly [Vec2, Vec2] | null;
  /** The live (while dragging) or frozen (after up) readout. */
  readout: MeasureReadout | null;
  /** True while a drag is in flight (the readout is live). */
  measuring: boolean;
}

export function measureReadout(from: Vec2, to: Vec2): MeasureReadout {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  return {
    from: [from[0], from[1]],
    to: [to[0], to[1]],
    dx,
    dy,
    distance: Math.hypot(dx, dy),
    angleDeg: (Math.atan2(dy, dx) * 180) / Math.PI,
  };
}

export class MeasureMachine {
  private start: Vec2 | null = null;
  private end: Vec2 | null = null;
  private dragging = false;

  handle(event: MeasureEvent): MeasureSnapshot {
    switch (event.type) {
      case "down":
        this.start = clone(event.point);
        this.end = clone(event.point);
        this.dragging = true;
        return this.snapshot();
      case "move":
        if (this.dragging && this.start) {
          this.end = this.endFor(event.point, event.modifiers);
        }
        return this.snapshot();
      case "up":
        if (this.dragging && this.start) {
          this.end = this.endFor(event.point, event.modifiers);
          this.dragging = false;
        }
        return this.snapshot();
      case "key":
        this.start = null;
        this.end = null;
        this.dragging = false;
        return this.snapshot();
    }
  }

  /** Re-anchor the measure origin (the host's nearest-path-point snap
   *  replaces the raw down point with the engine-resolved one). */
  snapStart(point: Vec2): MeasureSnapshot {
    if (this.start) {
      this.start = clone(point);
      if (!this.dragging) this.end = this.end ?? clone(point);
    }
    return this.snapshot();
  }

  private endFor(point: Vec2, modifiers: MeasureModifiers): Vec2 {
    return modifiers.shift && this.start
      ? constrainAngle(this.start, point)
      : clone(point);
  }

  private snapshot(): MeasureSnapshot {
    if (!this.start || !this.end) {
      return { line: null, readout: null, measuring: false };
    }
    return {
      line: [this.start, this.end],
      readout: measureReadout(this.start, this.end),
      measuring: this.dragging,
    };
  }
}
