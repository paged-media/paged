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

// SCISSORS AT ANY POINT — the click tool beside the host's own Scissors.
// The host's cuts at ANCHORS (its `pathOpenAt` takes an anchor index);
// this one cuts wherever the click lands on a segment: the segment is
// split there first (the de Casteljau insert the Add Anchor tool plans),
// then opened at the new anchor — ONE batch, one undo step
// (draw-tools `scissors.ts` plans it; this file only resolves the
// target and the click).
//
// The target is what the click hits, or — a hairline is hard to hit —
// the single selected path. The click is mapped into the path's own
// space through its transform, with the pick tolerance scaled so it
// stays a constant 6 px on screen (the anchor tools' idiom).

import type {
  BundleHost,
  CanvasPointerEvent,
  ElementId,
  GestureHandler,
} from "@paged-media/plugin-api";
import { CLICK_DRAG_THRESHOLD_PX } from "@paged-media/plugin-sdk";

import { affineScale, inverseApplyAffine, type Affine } from "@paged-media/draw-geometry";
import {
  planScissorsAt,
  scissorsMutation,
  type ScissorsPlan,
} from "@paged-media/draw-tools";

/** Screen-space pick radius around anchors and segments. */
const PICK_TOLERANCE_PX = 6;

/** The path kinds `pathOpenAt` accepts. */
const CUTTABLE = new Set(["polygon", "rectangle", "textFrame", "graphicLine"]);

/** What one click did. */
export interface ScissorsResult {
  target: ElementId;
  plan: ScissorsPlan;
}

/**
 * Cut `target` at `pagePoint` (page-local pt on `pageId`). Null when the
 * point is on no anchor or segment of it within the pick tolerance, when
 * it is an open contour's endpoint, or when the engine refuses.
 */
export async function applyScissorsAt(
  host: BundleHost,
  target: ElementId,
  pageId: string,
  pagePoint: [number, number],
): Promise<ScissorsResult | null> {
  if (!CUTTABLE.has(target.kind)) return null;
  const read = await host.document.pathAnchors(target).catch(() => null);
  if (!read || read.anchors.length < 2 || read.pageId !== pageId) return null;
  const m = (read.itemTransform ?? null) as Affine | null;
  const local = inverseApplyAffine(m, pagePoint[0], pagePoint[1]);
  if (!local) return null;
  const tolerance = host.viewport.pxToPt(PICK_TOLERANCE_PX) / affineScale(m);
  const plan = planScissorsAt(
    {
      anchors: read.anchors,
      subpathStarts: read.subpathStarts,
      subpathOpen: read.subpathOpen,
    },
    local,
    tolerance,
  );
  if (!plan) return null;
  const outcome = await host.document.mutate(scissorsMutation(plan, target));
  if (!outcome.applied) {
    host.log.warn(`scissors: the cut was refused: ${JSON.stringify(outcome.error)}`);
    return null;
  }
  return { target, plan };
}

export function createScissorsHandler(
  host: BundleHost,
  options: { onCut?: (result: ScissorsResult | null) => void } = {},
): GestureHandler {
  const act = async (e: CanvasPointerEvent): Promise<ScissorsResult | null> => {
    if (!e.pageId || !e.pagePoint) return null;
    let target: ElementId | null = null;
    try {
      const hit = await host.document.hitTest(e.pageId, e.pagePoint, "any");
      target = hit?.element ?? null;
    } catch {
      /* fall through to the selection */
    }
    if (!target || !CUTTABLE.has(target.kind)) {
      const selection = host.selection.get();
      target = selection.length === 1 ? selection[0]! : null;
    }
    if (!target) return null;
    return applyScissorsAt(host, target, e.pageId, e.pagePoint);
  };

  return {
    onActivate() {
      /* a click tool — nothing to capture */
    },
    onDeactivate() {
      /* nothing in flight */
    },
    onPointerDown() {
      /* acts on pointer-up, where click-vs-drag is decidable */
    },
    onPointerMove() {},
    onPointerUp(e: CanvasPointerEvent) {
      if (e.button !== 0 || e.maxDelta > CLICK_DRAG_THRESHOLD_PX) return;
      void act(e)
        .then((r) => options.onCut?.(r))
        .catch((err) => host.log.warn(`scissors: the cut failed: ${String(err)}`));
    },
  };
}
