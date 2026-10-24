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

// THE SCRUB — the freehand gesture three tools share: the Join tool
// scrubs over a gap or a crossing, the Path Eraser drags along a path,
// the Shaper draws a shape or a scribble. Host-agnostic: page-local pt
// samples in, the gesture's polyline out. What the polyline MEANS is each
// tool's own (draw-geometry `planJoinScrub`, `planPathErase`,
// `recogniseShape`); this machine only records it.
//
//   down     → start (first sample)
//   move     → append a sample once it travelled ≥ `minSampleDistance`
//   up       → COMMIT the samples (the release point appended) — unless
//              the whole gesture is shorter than `minLength` (a click,
//              a twitch), which cancels
//   Escape   → cancel
//
// No simplification: the eraser needs every sample it swept, and the
// Shaper's recogniser does its own outline.

import { clone, dist, type Vec2, type Vec2Mut } from "@paged-media/draw-geometry";

export type ScrubEvent =
  | { type: "down"; point: Vec2 }
  | { type: "move"; point: Vec2 }
  | { type: "up"; point: Vec2 }
  | { type: "key"; key: "Escape" };

export interface ScrubOptions {
  /** pt — a move closer than this to the last sample is dropped.
   *  Default 0.5. */
  minSampleDistance?: number;
  /** pt — a gesture shorter than this (summed) cancels. Default 1. */
  minLength?: number;
}

export interface ScrubSnapshot {
  /** The samples so far — the preview. */
  points: readonly Vec2[];
  /** Non-null exactly once, on the `up` that completes the gesture. */
  commit: Vec2Mut[] | null;
  /** False once committed or cancelled. */
  active: boolean;
}

export class ScrubMachine {
  private samples: Vec2Mut[] = [];
  private drawing = false;
  private done = false;

  constructor(private readonly options: ScrubOptions = {}) {}

  handle(event: ScrubEvent): ScrubSnapshot {
    if (this.done) return this.snapshot(null);
    switch (event.type) {
      case "down":
        this.drawing = true;
        this.samples = [clone(event.point)];
        return this.snapshot(null);
      case "move": {
        if (!this.drawing) return this.snapshot(null);
        const last = this.samples[this.samples.length - 1]!;
        if (dist(event.point, last) >= (this.options.minSampleDistance ?? 0.5))
          this.samples.push(clone(event.point));
        return this.snapshot(null);
      }
      case "up": {
        if (!this.drawing) return this.snapshot(null);
        this.drawing = false;
        this.done = true;
        const last = this.samples[this.samples.length - 1]!;
        if (dist(event.point, last) > 0) this.samples.push(clone(event.point));
        let length = 0;
        for (let i = 1; i < this.samples.length; i++)
          length += dist(this.samples[i - 1]!, this.samples[i]!);
        if (length < (this.options.minLength ?? 1)) {
          this.samples = [];
          return this.snapshot(null);
        }
        return this.snapshot(this.samples.map(clone));
      }
      case "key":
        this.done = true;
        this.drawing = false;
        this.samples = [];
        return this.snapshot(null);
    }
  }

  private snapshot(commit: Vec2Mut[] | null): ScrubSnapshot {
    return { points: this.samples, commit, active: !this.done };
  }
}
