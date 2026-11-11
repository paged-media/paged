/*
 * This file is part of paged (https://paged.media), the commercial editor
 * for the paged IDML engine.
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

// Editor-ops — the Scissors tool's gesture handler: the one Scissors of
// every context (editor ADR 311). A click cuts the path under it wherever
// it lands: on an anchor (within 6 screen px) a `pathOpenAt` there; on a
// segment the de Casteljau insert, then `pathOpenAt` at the new anchor, in
// one batch (one undo step). A closed contour opens at the cut; an open
// one splits in two. The click is taken into the path's own space through
// its transform, so a turned or scaled path cuts where it is drawn. The
// plan and the write are `@paged-media/vector-tools`' `applyScissorsAt`
// (paged.draw's `scissorsAt` command cuts through it too). The target is
// the clicked element (worker hit-test), falling back to the single
// selection so a precise click on a hairline is not required.

import type {
  CanvasPointerEvent,
  GestureHandler,
  PagedEditor,
} from "@paged-media/shell";
import { applyScissorsAt, type ScissorsDoor } from "@paged-media/vector-tools";

import { CLICK_DRAG_THRESHOLD_PX, pxToPt } from "./shared";

/** Screen-space pick radius around anchors and segments. */
const PICK_TOLERANCE_PX = 6;

export function createScissorsHandler(): GestureHandler {
  let paged: PagedEditor | null = null;

  const cutAt = async (e: CanvasPointerEvent) => {
    if (!paged || !e.pageId || !e.pagePoint) return;
    const client = paged.client;
    // Resolve the target: hit-test first, selection as fallback.
    let target = null;
    try {
      const reply = await client.send({
        kind: "hitTest",
        payload: { pageId: e.pageId, docPoint: e.pagePoint, filter: "any" },
      });
      if (reply.kind === "hitResult") target = reply.payload.element ?? null;
    } catch {
      /* fall through to the selection */
    }
    if (!target && paged.selection.elementSelection.length === 1) {
      target = paged.selection.elementSelection[0];
    }
    if (!target) return;
    const door: ScissorsDoor = {
      pathAnchors: (id) => client.pathAnchors(id),
      async mutate(m) {
        const reply = await client.mutate(m as never);
        if (reply.kind === "mutationFailed") {
          // Ovals / single-anchor contours are rejected engine-side.
          // eslint-disable-next-line no-console
          console.warn(
            "scissors: the cut was refused:",
            JSON.stringify((reply as { payload?: unknown }).payload),
          );
          return false;
        }
        return true;
      },
    };
    await applyScissorsAt(
      door,
      target,
      e.pageId,
      e.pagePoint,
      pxToPt(paged, PICK_TOLERANCE_PX),
    );
  };

  return {
    onActivate(p) {
      paged = p;
    },
    onDeactivate() {
      /* click tool — nothing in flight */
    },
    onPointerDown() {
      /* acts on pointer-up so click-vs-drag is decidable */
    },
    onPointerMove() {},
    onPointerUp(e: CanvasPointerEvent) {
      if (e.button !== 0 || e.maxDelta > CLICK_DRAG_THRESHOLD_PX) return;
      void cutAt(e).catch((err) => {
        // eslint-disable-next-line no-console
        console.warn("scissors cut failed:", err);
      });
    },
  };
}
