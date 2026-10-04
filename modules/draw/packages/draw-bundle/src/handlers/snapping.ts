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

// Snapping for draw's point-placing tools (RFI C-68, plugin-side).
//
// The geometry is `snapPoint` in draw-geometry; this is the host half:
// it gathers the candidates ONCE per gesture (the page's edges and
// centre, read from the `pages` collection, plus whatever points the
// tool itself contributes — its own placed anchors), converts the
// screen tolerance at the current zoom, and is bypassed while Cmd is
// held (Illustrator's "snap off while held" convention is Ctrl/Cmd).
// One `collection("pages")` read per gesture, none per move.

import type { BundleHost, CanvasPointerEvent } from "@paged-media/plugin-api";

import {
  anchorTargets,
  pageTargets,
  snapPoint,
  type SnapResult,
  type SnapTarget,
  type Vec2,
} from "@paged-media/draw-geometry";

import { patternPageRect } from "../commands/pattern";

/** Screen pixels within which a point snaps. */
export const SNAP_TOLERANCE_PX = 6;

export interface Snapper {
  /** Read the page's targets for `pageId` (once; later calls for the
   *  same page are free). Resolves when they are in. */
  prepare(pageId: string): Promise<void>;
  /** Snap a pointer event's page point. `extra` are the tool's own
   *  points (e.g. the anchors it has placed so far). */
  snap(e: CanvasPointerEvent, extra?: readonly Vec2[]): Vec2 | null;
  /** The last snap, for a host that draws smart guides. */
  last(): SnapResult | null;
  reset(): void;
}

export function createSnapper(host: BundleHost): Snapper {
  let page: string | null = null;
  let pageT: SnapTarget[] = [];
  let lastResult: SnapResult | null = null;
  return {
    async prepare(pageId) {
      if (page === pageId) return;
      page = pageId;
      pageT = [];
      const rect = await patternPageRect(host, pageId);
      if (rect && page === pageId) pageT = pageTargets(rect.width, rect.height);
    },
    snap(e, extra = []) {
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
    },
    last: () => lastResult,
    reset() {
      page = null;
      pageT = [];
      lastResult = null;
    },
  };
}
