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

// THE RESHAPE TOOL's gesture machine. Press on a path — on an anchor, or
// anywhere on a segment, where an anchor is added first (the Add Anchor
// tool's de Casteljau insert, so the curve does not move) — and drag: the
// anchor follows the pointer and its contour's other anchors follow it by
// a falloff of their distance ALONG the path (draw-geometry
// `reshapeTable`), so the neighbouring segments reshape proportionally.
//
//   down    → pick the anchor (or plan the insert); a miss does nothing
//   move    → the preview table
//   up      → COMMIT the whole table (the host writes it in ONE
//             `framePath`), when it moved — or when the press added an
//             anchor, which is then the whole edit (Illustrator's click)
//   Escape  → cancel
//
// Path-INNER space throughout: the host maps the pointer through the
// path's transform before handing it in, as the anchor tools do.

import {
  reshapeTable,
  type AnchorTable,
  type Vec2,
  type Vec2Mut,
} from "@paged-media/draw-geometry";

import { nearestAnchorIndex, planAnchorAdd } from "./anchor-machine";
import { applyPathOps } from "./apply-path-ops";
import { anchorEditOps } from "./path-edit-ops";

export type ReshapeEvent =
  | { type: "down"; point: Vec2 }
  | { type: "move"; point: Vec2 }
  | { type: "up"; point: Vec2 }
  | { type: "key"; key: "Escape" };

export interface ReshapeOptions {
  /** The path's table, inner space. */
  table: AnchorTable;
  /** pt — the pick radius around anchors and segments. */
  tolerance: number;
  /** pt — the falloff radius along the path. */
  radius: number;
}

export interface ReshapeSnapshot {
  /** The table as it would be written (the preview); null before a hit. */
  table: AnchorTable | null;
  /** The anchor being dragged (flat index into `table`). */
  index: number | null;
  /** Non-null once, on the release that ends an edit. */
  commit: AnchorTable | null;
  active: boolean;
}

export class ReshapeMachine {
  private base: AnchorTable | null = null;
  private index: number | null = null;
  private start: Vec2Mut | null = null;
  private current: AnchorTable | null = null;
  private inserted = false;
  private done = false;

  constructor(private readonly options: ReshapeOptions) {}

  handle(event: ReshapeEvent): ReshapeSnapshot {
    if (this.done) return this.snapshot(null);
    switch (event.type) {
      case "down": {
        const t = this.options.table;
        let index = nearestAnchorIndex(t, event.point, this.options.tolerance);
        let base: AnchorTable = t;
        if (index < 0) {
          const plan = planAnchorAdd(t, event.point, this.options.tolerance);
          if (!plan || plan.kind !== "insert") {
            this.done = true;
            return this.snapshot(null);
          }
          base = applyPathOps(t, anchorEditOps(plan));
          index = plan.insertIndex;
          this.inserted = true;
        }
        this.base = base;
        this.index = index;
        // The drag is measured from the PRESS, so the anchor keeps its
        // offset from the pointer instead of jumping onto it.
        this.start = [event.point[0], event.point[1]];
        this.current = base;
        return this.snapshot(null);
      }
      case "move":
        if (this.base && this.index !== null && this.start) this.track(event.point);
        return this.snapshot(null);
      case "up": {
        if (!this.base || this.index === null || !this.start) {
          this.done = true;
          return this.snapshot(null);
        }
        this.track(event.point);
        this.done = true;
        const moved = event.point[0] !== this.start[0] || event.point[1] !== this.start[1];
        return this.snapshot(moved || this.inserted ? this.current : null);
      }
      case "key":
        this.done = true;
        this.current = null;
        return this.snapshot(null);
    }
  }

  private track(point: Vec2): void {
    const delta: Vec2 = [point[0] - this.start![0], point[1] - this.start![1]];
    this.current = reshapeTable(this.base!, this.index!, delta, this.options.radius);
  }

  private snapshot(commit: AnchorTable | null): ReshapeSnapshot {
    return {
      table: this.current,
      index: this.index,
      commit,
      active: !this.done,
    };
  }
}
