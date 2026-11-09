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

// THE FLARE tool's gesture machine. (Star is the host's: Object ▸ Insert
// star… and the Polygon tool's Star option.)
//
// FLARE — Illustrator's two-step gesture: press at the CENTRE and drag to
// size the centre disc and the halo (the rays scale with it); release;
// then press-drag-release a second time to put the END of the rings'
// line. Escape between the two commits the flare without rings at the
// first size (Illustrator keeps what has been set). A click on the first
// step asks for the options at that point.

import { dist, type Vec2, type Vec2Mut } from "@paged-media/vector-geometry";

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
