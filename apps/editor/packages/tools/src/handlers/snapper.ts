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

// Snapping for the host's point-placing tools (RFI C-68) — the Pen and
// Direct Selection.
//
// The ENGINE resolves a point (engine ADR 125, protocol 67):
// `requestSnapPoint` snaps it against every visible element's anchors,
// centres and outlines, the page, ruler guides, the grid and the x / y
// lines through all of them — the same resolver the engine's own move,
// resize and path-edit gestures use, with the session's tolerance.
// `engineSnapPoint` is that query over the editor's wire;
// `createHostSnapper` is paged.draw's shared snapper (`createSnapper`,
// the one the draw Curvature tool uses too) with this host's transport
// and bypass.
//
// Both are bypassed while Cmd is held (Illustrator's "snap off while
// held") and while Shift constrains — a constrained angle wins over a
// snap that would pull the point off it. View ▸ Snap to points turns it
// off. Direct Selection keeps a LOCAL snap to the edited path's own
// anchors (`SNAP_TOLERANCE_PX`), only to answer a drag sample before the
// engine's answer for it arrives.

import type { SnapPointQuery, SnapPointResult } from "@paged-media/plugin-api";
import {
  getViewToggle,
  type CanvasPointerEvent,
  type PagedEditor,
} from "@paged-media/shell";
import type { Vec2 } from "@paged-media/draw/geometry";
import {
  createSnapper,
  snapAnswered,
  type Snapper,
} from "@paged-media/draw/machines";

/** Screen pixels within which Direct Selection's LOCAL snap pulls a
 *  dragged anchor before the engine answers (the engine path uses the
 *  session's tolerance). */
export const SNAP_TOLERANCE_PX = 6;

/** The `requestSnapPoint` query (the engine wire's `SnapPointQuery`). */
export type EngineSnapQuery = SnapPointQuery;

/** The engine's answer (the engine wire's `SnapPointResult`). */
export type EngineSnapResult = SnapPointResult;

type Send = PagedEditor["client"]["send"];

/** Ask the engine to snap `query`. `null` when it does not answer — no
 *  document, or a transport error. Never throws. */
export async function engineSnapPoint(
  send: Send,
  query: EngineSnapQuery,
): Promise<EngineSnapResult | null> {
  try {
    const reply = await send({ kind: "requestSnapPoint", payload: { query } });
    if (reply.kind !== "snapPoint") return null;
    const r = reply.payload.result;
    return snapAnswered(r) ? r : null;
  } catch {
    return null;
  }
}

/** Is snapping on for a sample with these modifiers? */
export function snappingOn(modifiers: {
  cmd?: boolean;
  shift?: boolean;
}): boolean {
  return getViewToggle("snapToPoints") && !modifiers.cmd && !modifiers.shift;
}

export interface HostSnapper {
  /** Snap `point` (page-local pt) through the engine. `extra` are the
   *  tool's own points. The point itself when bypassed or unanswered. */
  snapAsync(
    pageId: string,
    point: Vec2,
    e: CanvasPointerEvent,
    ptPerPx: number,
    extra?: readonly Vec2[],
  ): Promise<Vec2>;
  /** The engine's last answer, for a host that draws smart guides. */
  last(): EngineSnapResult | null;
  reset(): void;
}

export function createHostSnapper(
  paged: () => PagedEditor | null,
): HostSnapper {
  const snapper: Snapper = createSnapper(async (query) => {
    const p = paged();
    return p ? engineSnapPoint(p.client.send.bind(p.client), query) : null;
  });
  return {
    snapAsync: (pageId, point, e, ptPerPx, extra = []) =>
      snapper.snap({
        pageId,
        point,
        cameraScale: 1 / ptPerPx,
        extra,
        bypass: !snappingOn(e.modifiers),
      }),
    last: () => snapper.last(),
    reset: () => snapper.reset(),
  };
}
