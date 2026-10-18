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

// The Width tool's state machine (wave 2) — host-agnostic. Points in
// (path-LOCAL pt — the bundle handler inverse-transforms the page
// pointer), width profiles out:
//
//   · down within `tolerance` of an anchor → the gesture arms, peaked
//     at that anchor (a miss is inert — no gesture);
//   · move → the drag DISTANCE from the down point becomes the peak's
//     extra width (`gain` pt of width per pt of drag, clamped to
//     `maxWidth`), spread over the neighbors by draw-geometry's
//     `peakedWidthProfile` linear falloff;
//   · up → commit `{ widths, peakIndex, peakWidth }` exactly once
//     (a zero-travel click cancels instead — no degenerate bake);
//   · Escape cancels.
//
// The machine never touches a host; the bundle sweeps the committed
// widths through the engine's `outlineStrokeVariable` op (a
// DESTRUCTIVE bake — documented in handlers/width.ts).

import {
  dist,
  peakedWidthProfile,
  type Vec2,
} from "@paged-media/draw-geometry";

export type WidthEvent =
  | { type: "down"; point: Vec2 }
  | { type: "move"; point: Vec2 }
  | { type: "up"; point: Vec2 }
  | { type: "key"; key: string };

export interface WidthOptions {
  /** The target path's anchor POSITIONS, path-local pt, in table
   *  order (1:1 with the widths the commit emits). */
  anchors: readonly Vec2[];
  /** Anchor pick radius in local pt (the host converts px→pt at zoom
   *  and divides out the item transform's scale). */
  tolerance: number;
  /** The profile's base width in pt — every non-peaked anchor's stop
   *  (the handler feeds the element's own stroke weight). */
  baseWidth: number;
  /** Neighbor distance (in anchors) over which the peak decays back
   *  to base (default 2). */
  falloff?: number;
  /** Width pt added per pt of drag distance (default 1). */
  gain?: number;
  /** Clamp on the peak width in pt (default 72). */
  maxWidth?: number;
}

export interface WidthCommit {
  /** Per-anchor width stops, 1:1 with `options.anchors` — the
   *  `outlineStrokeVariable.widths` payload. */
  widths: number[];
  peakIndex: number;
  peakWidth: number;
}

export interface WidthSnapshot {
  /** True while a drag is armed on an anchor. */
  active: boolean;
  /** The peaked anchor, or -1 when inactive. */
  peakIndex: number;
  /** The live profile while dragging (preview), null when inactive. */
  widths: number[] | null;
  /** Non-null exactly once, on the pointer-up that completes a drag. */
  commit: WidthCommit | null;
}

const DEFAULT_FALLOFF = 2;
const DEFAULT_GAIN = 1;
const DEFAULT_MAX_WIDTH = 72;

export class WidthMachine {
  private peak = -1;
  private downPoint: Vec2 | null = null;
  private peakWidth: number;

  constructor(private readonly options: WidthOptions) {
    this.peakWidth = options.baseWidth;
  }

  handle(event: WidthEvent): WidthSnapshot {
    switch (event.type) {
      case "down": {
        const index = this.nearestAnchor(event.point);
        if (index < 0) return this.inert();
        this.peak = index;
        this.downPoint = event.point;
        this.peakWidth = this.options.baseWidth;
        return this.live();
      }
      case "move": {
        if (this.downPoint === null) return this.inert();
        this.peakWidth = this.peakWidthFor(event.point);
        return this.live();
      }
      case "up": {
        if (this.downPoint === null) return this.inert();
        const peakWidth = this.peakWidthFor(event.point);
        const peakIndex = this.peak;
        const travelled = dist(this.downPoint, event.point) > 0;
        this.reset();
        if (!travelled) return this.inert(); // a click bakes nothing
        return {
          active: false,
          peakIndex: -1,
          widths: null,
          commit: {
            widths: this.profile(peakIndex, peakWidth),
            peakIndex,
            peakWidth,
          },
        };
      }
      case "key": {
        if (event.key === "Escape") this.reset();
        return this.inert();
      }
    }
  }

  private nearestAnchor(point: Vec2): number {
    let best = -1;
    let bestDist = this.options.tolerance;
    this.options.anchors.forEach((a, i) => {
      const d = dist(a, point);
      if (d <= bestDist) {
        best = i;
        bestDist = d;
      }
    });
    return best;
  }

  private peakWidthFor(point: Vec2): number {
    const gain = this.options.gain ?? DEFAULT_GAIN;
    const max = this.options.maxWidth ?? DEFAULT_MAX_WIDTH;
    const magnitude = dist(this.downPoint as Vec2, point) * gain;
    return Math.min(this.options.baseWidth + magnitude, max);
  }

  private profile(peakIndex: number, peakWidth: number): number[] {
    return peakedWidthProfile(
      this.options.anchors.length,
      peakIndex,
      peakWidth,
      this.options.baseWidth,
      this.options.falloff ?? DEFAULT_FALLOFF,
    );
  }

  private live(): WidthSnapshot {
    return {
      active: true,
      peakIndex: this.peak,
      widths: this.profile(this.peak, this.peakWidth),
      commit: null,
    };
  }

  private inert(): WidthSnapshot {
    return { active: false, peakIndex: -1, widths: null, commit: null };
  }

  private reset(): void {
    this.peak = -1;
    this.downPoint = null;
    this.peakWidth = this.options.baseWidth;
  }
}
