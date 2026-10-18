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

// The KNIFE tool's gesture machine — host-agnostic: pointer samples in
// (page-local pt), the CUT out. What the cut does to the document is the
// bundle's (`draw-bundle` `commands/knife.ts`); this machine only decides
// which line the user drew.
//
//   down              → start the cut (first sample)
//   move (down)       → append a sample once it travelled ≥
//                       `minSampleDistance` from the last one
//   Alt held          → a STRAIGHT cut from the press point to the
//                       pointer (Illustrator's Option-drag), the freehand
//                       samples set aside; Alt+Shift snaps it to 45°.
//                       Read on every event, so releasing Alt mid-drag
//                       goes back to the freehand line already drawn.
//   up                → COMMIT: the freehand samples RDP-simplified at
//                       `tolerance` (the endpoints always kept), or the
//                       straight two-point line
//   Escape            → cancel; nothing is committed
//
// A cut shorter than `minLength` (a click, a twitch) cancels rather than
// committing — a knife that "cuts" with a click would split whatever is
// under the pointer along a zero-length line, which the bundle would
// then have to refuse anyway.

import {
  clone,
  constrainAngle,
  dist,
  simplifyRdp,
  type Vec2,
  type Vec2Mut,
} from "@paged-media/draw-geometry";

export interface KnifeModifiers {
  alt: boolean;
  shift: boolean;
}

export type KnifeEvent =
  | { type: "down"; point: Vec2; modifiers?: KnifeModifiers }
  | { type: "move"; point: Vec2; modifiers?: KnifeModifiers }
  | { type: "up"; point: Vec2; modifiers?: KnifeModifiers }
  | { type: "key"; key: "Escape" };

export interface KnifeOptions {
  /** RDP tolerance in page pt (the host converts a screen-px fidelity at
   *  the current zoom). */
  tolerance: number;
  /** Decimation floor (pt): a move closer than this to the last sample
   *  is dropped. Default 0.5. */
  minSampleDistance?: number;
  /** The shortest cut (pt, summed along the line) that commits. Default
   *  1. */
  minLength?: number;
}

/** What one completed gesture cuts along: an OPEN polyline, ≥ 2 points,
 *  page-local pt. */
export interface KnifeCommit {
  cut: Vec2Mut[];
  /** Whether it was drawn as the Alt straight line. */
  straight: boolean;
}

export interface KnifeSnapshot {
  /** The line to preview: the freehand samples so far, or the straight
   *  two-point line while Alt is held. */
  points: readonly Vec2[];
  /** Non-null exactly once, on the `up` that completes a cut. */
  commit: KnifeCommit | null;
  /** False once committed or cancelled. */
  active: boolean;
  /** Is the preview the Alt straight line? */
  straight: boolean;
}

const DEFAULT_MIN_SAMPLE_DISTANCE = 0.5;
const DEFAULT_MIN_LENGTH = 1;

/** Summed segment length of a polyline. */
function lengthOf(points: readonly Vec2[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += dist(points[i - 1], points[i]);
  return total;
}

export class KnifeMachine {
  private samples: Vec2Mut[] = [];
  private drawing = false;
  private done = false;
  private straightEnd: Vec2Mut | null = null;

  constructor(private readonly options: KnifeOptions) {}

  handle(event: KnifeEvent): KnifeSnapshot {
    if (this.done) return this.snapshot(null);
    switch (event.type) {
      case "down":
        this.drawing = true;
        this.samples = [clone(event.point)];
        this.straightEnd = null;
        return this.snapshot(null);
      case "move":
        if (!this.drawing) return this.snapshot(null);
        this.track(event.point, event.modifiers);
        return this.snapshot(null);
      case "up":
        return this.onUp(event.point, event.modifiers);
      case "key":
        this.cancel();
        return this.snapshot(null);
    }
  }

  /** Follow the pointer: the straight line while Alt is held, else a
   *  decimated freehand sample. */
  private track(point: Vec2, modifiers: KnifeModifiers | undefined): void {
    if (modifiers?.alt) {
      const start = this.samples[0];
      this.straightEnd = modifiers.shift ? constrainAngle(start, point) : clone(point);
      return;
    }
    this.straightEnd = null;
    const last = this.samples[this.samples.length - 1];
    const floor = this.options.minSampleDistance ?? DEFAULT_MIN_SAMPLE_DISTANCE;
    if (dist(point, last) >= floor) this.samples.push(clone(point));
  }

  private onUp(point: Vec2, modifiers: KnifeModifiers | undefined): KnifeSnapshot {
    if (!this.drawing) return this.snapshot(null);
    this.drawing = false;
    this.done = true;
    const minLength = this.options.minLength ?? DEFAULT_MIN_LENGTH;
    if (modifiers?.alt) {
      const start = this.samples[0];
      const end = modifiers.shift ? constrainAngle(start, point) : clone(point);
      this.straightEnd = end;
      if (dist(start, end) < minLength) return this.cancelled();
      return this.snapshot({ cut: [clone(start), end], straight: true });
    }
    this.straightEnd = null;
    const last = this.samples[this.samples.length - 1];
    if (dist(point, last) > 0) this.samples.push(clone(point));
    const simplified = simplifyRdp(this.samples, this.options.tolerance).map(
      (p) => clone(p),
    );
    if (simplified.length < 2 || lengthOf(simplified) < minLength) {
      return this.cancelled();
    }
    return this.snapshot({ cut: simplified, straight: false });
  }

  private cancel(): void {
    this.done = true;
    this.drawing = false;
    this.samples = [];
    this.straightEnd = null;
  }

  private cancelled(): KnifeSnapshot {
    this.cancel();
    return this.snapshot(null);
  }

  private snapshot(commit: KnifeCommit | null): KnifeSnapshot {
    const straight = this.straightEnd !== null;
    return {
      points:
        straight && this.samples.length > 0
          ? [this.samples[0], this.straightEnd!]
          : this.samples,
      commit,
      active: !this.done,
      straight,
    };
  }
}
