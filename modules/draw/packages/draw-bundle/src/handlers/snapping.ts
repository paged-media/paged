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

// Snapping for draw's point-placing tools (RFI C-68).
//
// Since engine protocol 67 the ENGINE snaps: `host.document.snapPoint`
// resolves a point against every visible element's anchors, centres and
// outlines, the page, ruler guides, the grid and the x / y lines through
// all of them, with the session's tolerance and switches — the same
// resolver the host's Pen, Direct Selection and move gesture use, so a
// draw tool snaps exactly like the host. `snapAsync` asks it.
//
// The plugin-side snapper stays as the FALLBACK, for a host whose engine
// predates v67 (it answers `tolerancePt: 0`): draw-geometry's `snapPoint`
// over the candidates a plugin can gather cheaply — the page's edges and
// centre (one `collection("pages")` read per gesture) and the tool's own
// placed points. Cmd held bypasses both.

import type {
  BundleHost,
  CanvasPointerEvent,
  SnapPointResult,
} from "@paged-media/plugin-api";

import {
  anchorTargets,
  pageTargets,
  snapPoint,
  type SnapResult,
  type SnapTarget,
  type Vec2,
} from "@paged-media/draw-geometry";

import { patternPageRect } from "../commands/pattern";

/** Screen pixels within which a point snaps on the FALLBACK path (the
 *  engine path uses the session's tolerance). */
export const SNAP_TOLERANCE_PX = 6;

export interface Snapper {
  /** Read the page's fallback targets for `pageId` (once; later calls for
   *  the same page are free). Resolves when they are in. */
  prepare(pageId: string): Promise<void>;
  /** Snap a pointer event's page point with the plugin-side resolver.
   *  `extra` are the tool's own points (e.g. the anchors it has placed so
   *  far). */
  snap(e: CanvasPointerEvent, extra?: readonly Vec2[]): Vec2 | null;
  /** Snap through the engine when the host can (v67), else `snap`. */
  snapAsync(e: CanvasPointerEvent, extra?: readonly Vec2[]): Promise<Vec2 | null>;
  /** The last plugin-side snap, for a host that draws smart guides. */
  last(): SnapResult | null;
  /** The last engine snap, when the engine answered. */
  lastEngine(): SnapPointResult | null;
  reset(): void;
}

export function createSnapper(host: BundleHost): Snapper {
  let page: string | null = null;
  let pageT: SnapTarget[] = [];
  let lastResult: SnapResult | null = null;
  let lastEngineResult: SnapPointResult | null = null;
  const engine = host.supports("document.snapPoint@1");
  const snap = (e: CanvasPointerEvent, extra: readonly Vec2[] = []): Vec2 | null => {
    if (!e.pagePoint) return null;
    if (e.modifiers.cmd) {
      lastResult = null;
      return e.pagePoint;
    }
    const targets =
      extra.length > 0 ? [...pageT, ...anchorTargets(extra, "own")] : pageT;
    lastResult = snapPoint(
      e.pagePoint,
      targets,
      host.viewport.pxToPt(SNAP_TOLERANCE_PX),
    );
    return lastResult.point;
  };
  return {
    async prepare(pageId) {
      if (page === pageId) return;
      page = pageId;
      pageT = [];
      const rect = await patternPageRect(host, pageId);
      if (rect && page === pageId) pageT = pageTargets(rect.width, rect.height);
    },
    snap,
    async snapAsync(e, extra = []) {
      lastEngineResult = null;
      if (!e.pagePoint) return null;
      if (e.modifiers.cmd) return e.pagePoint;
      if (engine && e.pageId) {
        const r = await host.document.snapPoint({
          pageId: e.pageId,
          point: [e.pagePoint[0], e.pagePoint[1]],
          // CSS px per pt at the current zoom.
          cameraScale: 1 / host.viewport.pxToPt(1),
          extraPoints: extra.map((p) => [p[0], p[1]] as [number, number]),
        });
        // `tolerancePt: 0` is a host that did not answer (an engine before
        // v67); anything else is the engine's verdict, snapped or not.
        if (r.tolerancePt > 0) {
          lastEngineResult = r;
          return [r.point[0], r.point[1]];
        }
      }
      return snap(e, extra);
    },
    last: () => lastResult,
    lastEngine: () => lastEngineResult,
    reset() {
      page = null;
      pageT = [];
      lastResult = null;
      lastEngineResult = null;
    },
  };
}
