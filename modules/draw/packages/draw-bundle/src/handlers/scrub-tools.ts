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

// THE JOIN TOOL, THE PATH ERASER and THE SHAPER — three host-routed
// shims over draw-tools' `ScrubMachine`. Each previews the gesture as a
// polyline while it is drawn and hands the finished polyline to its
// command (`commands/path-tools.ts`, `commands/shaper.ts`), which says
// what it does to the document. A gesture that leaves its page is
// cancelled: the commands work on one page.
//
// Tolerances are screen-constant (the anchor tools' idiom): the Join
// tool's pick radius and the eraser's band are a fixed number of PIXELS,
// converted to pt at the current zoom when the gesture starts.

import type {
  BundleHost,
  CanvasPointerEvent,
  GestureHandler,
} from "@paged-media/plugin-api";
import type { Vec2Mut } from "@paged-media/draw-geometry";

import { ScrubMachine, type ScrubSnapshot } from "@paged-media/draw-tools";

import {
  applyJoinScrub,
  applyPathErase,
  type EraseResult,
  type JoinResult,
} from "../commands/path-tools";
import { applyShaperStroke, type ShaperResult } from "../commands/shaper";

/** The Join tool's pick radius around endpoints and overhangs (px). */
export const JOIN_TOLERANCE_PX = 8;
/** The Path Eraser's band, full width (px). */
export const PATH_ERASER_WIDTH_PX = 10;

function scrubHandler(
  host: BundleHost,
  label: string,
  minSamplePx: number,
  commit: (pageId: string, points: Vec2Mut[]) => Promise<unknown>,
): GestureHandler {
  let machine: ScrubMachine | null = null;
  let pageId: string | null = null;

  const reset = () => {
    machine = null;
    pageId = null;
    host.overlay.setToolPreview(null);
  };

  const sync = (snap: ScrubSnapshot) => {
    if (snap.commit && pageId) {
      const page = pageId;
      const points = snap.commit;
      reset();
      void commit(page, points).catch((err) =>
        host.log.warn(`${label}: ${String(err)}`),
      );
      return;
    }
    if (!snap.active) {
      reset();
      return;
    }
    if (pageId && snap.points.length >= 2) {
      host.overlay.setToolPreview({
        pageId,
        points: snap.points.map((p) => [p[0], p[1]] as [number, number]),
      });
    }
  };

  return {
    onActivate() {
      /* per-gesture state allocates on pointer-down */
    },
    onDeactivate(reason) {
      if (reason === "suspend") return;
      reset();
    },
    onPointerDown(e: CanvasPointerEvent) {
      if (e.button !== 0 || !e.pageId || !e.pagePoint) return;
      machine = new ScrubMachine({
        minSampleDistance: host.viewport.pxToPt(minSamplePx),
        minLength: host.viewport.pxToPt(2),
      });
      pageId = e.pageId;
      sync(machine.handle({ type: "down", point: e.pagePoint }));
    },
    onPointerMove(e: CanvasPointerEvent) {
      if (!machine || !e.pagePoint || e.pageId !== pageId) return;
      sync(machine.handle({ type: "move", point: e.pagePoint }));
    },
    onPointerUp(e: CanvasPointerEvent) {
      if (!machine) return;
      sync(
        e.pageId === pageId && e.pagePoint
          ? machine.handle({ type: "up", point: e.pagePoint })
          : machine.handle({ type: "key", key: "Escape" }),
      );
    },
    onKey(e: KeyboardEvent) {
      if (!machine || e.key !== "Escape") return;
      sync(machine.handle({ type: "key", key: "Escape" }));
    },
  };
}

/** JOIN — scrub over a gap or a crossing. */
export function createJoinHandler(
  host: BundleHost,
  options: { onJoin?: (r: JoinResult) => void } = {},
): GestureHandler {
  return scrubHandler(host, "join", 1, async (page, points) => {
    const r = await applyJoinScrub(
      host,
      page,
      points,
      host.viewport.pxToPt(JOIN_TOLERANCE_PX),
    );
    if (!r.applied) host.log.info(`join: ${r.reason}`);
    options.onJoin?.(r);
  });
}

/** PATH ERASER — drag along a path to remove that part of it. */
export function createPathEraserHandler(
  host: BundleHost,
  options: { onErase?: (r: EraseResult) => void } = {},
): GestureHandler {
  return scrubHandler(host, "path eraser", 1, async (page, points) => {
    const r = await applyPathErase(
      host,
      page,
      points,
      host.viewport.pxToPt(PATH_ERASER_WIDTH_PX),
    );
    options.onErase?.(r);
  });
}

/** SHAPER — draw a shape (recognised) or scribble over shapes. */
export function createShaperHandler(
  host: BundleHost,
  options: { onShape?: (r: ShaperResult) => void } = {},
): GestureHandler {
  return scrubHandler(host, "shaper", 1.5, async (page, points) => {
    const r = await applyShaperStroke(host, page, points);
    if (!r.applied) host.log.info(`shaper: ${r.reason}`);
    options.onShape?.(r);
  });
}
