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

// The Curvature tool's gesture handler — a thin, host-routed shim over
// draw-tools' CurvatureMachine (the pen-machine division of labor):
// pointer/key events feed the machine, the snapshot's rubber curve goes
// out through `host.overlay.setToolPreview` as the cubic
// `ToolPreviewPath` (B-07), and the commit becomes ONE `insertPath`
// through `host.document.mutate` (facade-only — B-17).

import type {
  BundleHost,
  CanvasPointerEvent,
  GestureHandler,
} from "@paged-media/plugin-api";

import {
  CurvatureMachine,
  curvaturePreview,
  type CurvatureSnapshot,
} from "@paged-media/draw-tools";

import { insertPathMutationFor } from "./insert-path";
import { createSnapper } from "./snapping";

/** Screen-space radius for close-the-path / corner-toggle clicks. */
const CLICK_TOLERANCE_PX = 8;

export function createCurvatureHandler(host: BundleHost): GestureHandler {
  let machine: CurvatureMachine | null = null;
  let pageId: string | null = null;

  const reset = () => {
    machine = null;
    pageId = null;
    host.overlay.setToolPreview(null);
  };

  const commit = (snapshot: CurvatureSnapshot) => {
    const c = snapshot.commit;
    const page = pageId;
    reset();
    if (!c || !page) return;
    void host.document
      .mutate(insertPathMutationFor(page, c.anchors, c.open))
      .then(async (outcome) => {
        if (!outcome.applied) {
          host.log.warn(
            `curvature insertPath rejected by engine: ${JSON.stringify(outcome.error)}`,
          );
          return;
        }
        if (outcome.createdId) await host.selection.set([outcome.createdId]);
      })
      .catch((err) => host.log.warn(`curvature commit failed: ${err}`));
  };

  const sync = (snapshot: CurvatureSnapshot) => {
    if (snapshot.commit) {
      commit(snapshot);
      return;
    }
    if (!snapshot.active) {
      reset();
      return;
    }
    host.overlay.setToolPreview(
      pageId ? curvaturePreview(snapshot, pageId, { dashed: true }) : null,
    );
  };

  // C-68 — points snap through the engine (v67: every visible element,
  // guides, the page, this run's own placed points); on an older host,
  // to the page and the placed points. Cmd held bypasses. The engine
  // answer is asynchronous, so pointer and key events run IN ORDER on one
  // chain — a machine must never see an up before the down it follows.
  const snapper = createSnapper(host);
  let placed: [number, number][] = [];
  const at = async (e: CanvasPointerEvent): Promise<[number, number] | null> => {
    const p = await snapper.snapAsync(e, placed);
    return p ? [p[0], p[1]] : null;
  };
  let chain: Promise<void> = Promise.resolve();
  const enqueue = (step: () => Promise<void> | void) => {
    chain = chain
      .then(step)
      .catch((err) => host.log.warn(`curvature: ${String(err)}`));
  };

  return {
    onActivate() {
      /* machine is created lazily on the first down (per-run state) */
    },
    onDeactivate(reason) {
      if (reason === "suspend") return;
      // A real tool switch cancels the in-flight run (pen convention).
      reset();
    },
    onPointerDown(e: CanvasPointerEvent) {
      if (e.button !== 0 || !e.pageId || !e.pagePoint) return;
      enqueue(async () => {
        if (!machine) {
          machine = new CurvatureMachine({
            closeTolerance: host.viewport.pxToPt(CLICK_TOLERANCE_PX),
          });
          pageId = e.pageId;
          placed = [];
          await snapper.prepare(e.pageId!);
        }
        if (e.pageId !== pageId) return; // one page per run
        const point = (await at(e))!;
        if (!machine) return;
        placed.push(point);
        sync(
          machine.handle({
            type: "down",
            point,
            modifiers: { alt: e.modifiers.alt },
          }),
        );
      });
    },
    onPointerMove(e: CanvasPointerEvent) {
      if (!e.pagePoint) return;
      enqueue(async () => {
        if (!machine || e.pageId !== pageId) return;
        const point = (await at(e))!;
        if (machine) sync(machine.handle({ type: "move", point }));
      });
    },
    onPointerUp(e: CanvasPointerEvent) {
      if (!e.pagePoint) return;
      enqueue(async () => {
        if (!machine || e.pageId !== pageId) return;
        const point = (await at(e))!;
        if (machine) sync(machine.handle({ type: "up", point }));
      });
    },
    onKey(e: KeyboardEvent) {
      const key = e.key;
      if (key !== "Enter" && key !== "Escape") return;
      enqueue(() => {
        if (machine) sync(machine.handle({ type: "key", key }));
      });
    },
  };
}
