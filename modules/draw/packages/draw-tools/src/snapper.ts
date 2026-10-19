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

// The point snapper of every point-placing tool: the host's Pen and
// paged.draw's Curvature (RFI C-68).
//
// The ENGINE snaps (engine ADR 125, protocol 67): `requestSnapPoint`
// resolves a page-local point against every visible element's anchors,
// centres and outlines, the page, ruler guides, the grid and the x / y
// lines through all of them, with the session's tolerance and switches.
// This module is the one client of that query the tools share. It is
// host-agnostic: the host hands it the transport (the editor's raw wire,
// or a bundle's `host.document.snapPoint`) and decides the bypass (Cmd,
// a Shift constraint, View ▸ Snap to points).
//
// An unanswered query (`null`, or `tolerancePt: 0`) leaves the point
// where the pointer put it. There is no second resolver in TypeScript any
// more: the engine and the tools ship at one revision, so the engine
// always answers, and the editor's Direct Selection keeps its own local
// snap (draw-geometry's `snapPoint`) only to answer a drag sample before
// the engine's answer arrives.

import type { SnapPointQuery, SnapPointResult } from "@paged-media/plugin-api";
import type { Vec2 } from "@paged-media/draw-geometry";

/** Ask the engine to snap one point. `null` when it does not answer. */
export type SnapQuery = (
  query: SnapPointQuery,
) => Promise<SnapPointResult | null | undefined>;

/** One point to snap. */
export interface SnapRequest {
  pageId: string;
  /** Page-local pt. */
  point: Vec2;
  /** CSS px per pt at the current zoom (the engine's tolerance is in
   *  screen pixels). */
  cameraScale: number;
  /** Points only the tool knows about, page-local: the anchors it has
   *  placed so far. */
  extra?: readonly Vec2[];
  /** True while the host's bypass holds (Cmd, a Shift constraint, View ▸
   *  Snap to points off): the point comes back unchanged and the engine
   *  is not asked. */
  bypass?: boolean;
}

export interface Snapper {
  /** The point after snapping: the engine's answer, or `point` itself
   *  when bypassed or unanswered. Never rejects. */
  snap(request: SnapRequest): Promise<Vec2>;
  /** The engine's last answer that this snapper used, for a host that
   *  draws smart guides (`lines`). Null after a bypassed or unanswered
   *  request. */
  last(): SnapPointResult | null;
  reset(): void;
}

/** Did the engine answer? A host whose engine did not reports a zero
 *  tolerance (the contract's `document.snapPoint` does). */
export function snapAnswered(
  result: SnapPointResult | null | undefined,
): result is SnapPointResult {
  return !!result && result.tolerancePt > 0;
}

export function createSnapper(query: SnapQuery): Snapper {
  let lastResult: SnapPointResult | null = null;
  return {
    async snap({ pageId, point, cameraScale, extra = [], bypass }) {
      lastResult = null;
      if (bypass) return point;
      let result: SnapPointResult | null | undefined;
      try {
        result = await query({
          pageId,
          point: [point[0], point[1]],
          cameraScale,
          extraPoints: extra.map((p) => [p[0], p[1]] as [number, number]),
        });
      } catch {
        return point;
      }
      if (!snapAnswered(result)) return point;
      lastResult = result;
      return [result.point[0], result.point[1]];
    },
    last: () => lastResult,
    reset() {
      lastResult = null;
    },
  };
}
