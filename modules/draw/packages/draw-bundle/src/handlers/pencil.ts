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

// The Pencil (freehand) tool's gesture handler — host-routed shim over
// draw-tools' PencilMachine: pointer samples feed the machine, the live
// stroke previews as a POLYLINE (the raw decimated samples — honest:
// smoothing happens at commit, so previewing the samples shows what was
// actually drawn), and the pointer-up commit (RDP-simplified +
// Catmull-Rom-fitted anchors) becomes ONE `insertPath` through
// `host.document.mutate`.

import type {
  BundleHost,
  CanvasPointerEvent,
  GestureHandler,
} from "@paged-media/plugin-api";

import { strokeWidthFromPressure } from "@paged-media/draw-geometry";
import { PencilMachine, type PencilSnapshot } from "@paged-media/draw-tools";

import { insertPathMutationFor } from "./insert-path";

/** Screen-space RDP fidelity: pointer wobble below this collapses. */
const SIMPLIFY_TOLERANCE_PX = 2;
/** B-08 pressure→width ramp (pt at pressure 0 → pt at 1). */
const PRESSURE_WIDTH_PROFILE = { min: 0.35, max: 4 };
/** Did a pressure device actually drive the stroke? A mouse reports a
 *  CONSTANT pressure, so any meaningful spread means real input. */
const pressuresVary = (pressures: number[]): boolean => {
  if (pressures.length < 2) return false;
  let min = 1;
  let max = 0;
  for (const p of pressures) {
    if (p < min) min = p;
    if (p > max) max = p;
  }
  return max - min > 0.05;
};
/** Screen-space lift-near-the-start radius that closes the contour. */
const CLOSE_TOLERANCE_PX = 8;

export function createPencilHandler(host: BundleHost): GestureHandler {
  let machine: PencilMachine | null = null;
  let pageId: string | null = null;

  const reset = () => {
    machine = null;
    pageId = null;
    host.overlay.setToolPreview(null);
  };

  const sync = (snapshot: PencilSnapshot) => {
    if (snapshot.commit && pageId) {
      const c = snapshot.commit;
      const page = pageId;
      reset();
      void host.document
        .mutate(insertPathMutationFor(page, c.anchors, c.open))
        .then(async (outcome) => {
          if (!outcome.applied) {
            host.log.warn(
              `pencil insertPath rejected by engine: ${JSON.stringify(outcome.error)}`,
            );
            return;
          }
          if (outcome.createdId) await host.selection.set([outcome.createdId]);
          // B-08 — pressure → variable-width stroke. When a pressure
          // device drove the stroke (the sample pressures actually VARY —
          // a mouse's constant NEUTRAL never triggers this) and the
          // contour is OPEN (the engine's v1 variable-outline scope), the
          // drawn path converts to a variable-width outline via the
          // `outlineStrokeVariable` wire op: per-anchor width stops from
          // the linear pressure ramp. Its own undo step — undo restores
          // the plain centerline path.
          if (
            outcome.createdId &&
            c.open &&
            pressuresVary(c.pressures)
          ) {
            const widths = c.pressures.map((pr) =>
              strokeWidthFromPressure(pr, PRESSURE_WIDTH_PROFILE),
            );
            const outlined = await host.document.mutate({
              op: "setElementProperty",
              args: {
                elementId: outcome.createdId,
                path: "outlineStrokeVariable",
                value: {
                  type: "outlineStrokeVariable",
                  value: { widths, cap: "round", join: "round", miterLimit: 4 },
                },
              },
            });
            if (!outlined.applied) {
              host.log.warn(
                `pencil variable-width outline rejected (path kept as centerline): ${JSON.stringify(outlined.error)}`,
              );
            }
          }
        })
        .catch((err) => host.log.warn(`pencil commit failed: ${err}`));
      return;
    }
    if (!snapshot.active) {
      reset();
      return;
    }
    host.overlay.setToolPreview(
      pageId && snapshot.points.length >= 2
        ? {
            pageId,
            points: snapshot.points.map(
              (p) => [p[0], p[1]] as [number, number],
            ),
          }
        : null,
    );
  };

  return {
    onActivate() {
      /* per-stroke state allocates on pointer-down */
    },
    onDeactivate(reason) {
      if (reason === "suspend") return;
      reset();
    },
    onPointerDown(e: CanvasPointerEvent) {
      if (e.button !== 0 || !e.pageId || !e.pagePoint) return;
      machine = new PencilMachine({
        tolerance: host.viewport.pxToPt(SIMPLIFY_TOLERANCE_PX),
        closeTolerance: host.viewport.pxToPt(CLOSE_TOLERANCE_PX),
      });
      pageId = e.pageId;
      sync(
        machine.handle({ type: "down", point: e.pagePoint, pressure: e.pressure }),
      );
    },
    onPointerMove(e: CanvasPointerEvent) {
      if (!machine || !e.pagePoint || e.pageId !== pageId) return;
      sync(
        machine.handle({ type: "move", point: e.pagePoint, pressure: e.pressure }),
      );
    },
    onPointerUp(e: CanvasPointerEvent) {
      if (!machine) return;
      // Lifting off-page commits at the last on-page sample.
      const point =
        e.pageId === pageId && e.pagePoint ? e.pagePoint : undefined;
      const snap = point
        ? machine.handle({ type: "up", point, pressure: e.pressure })
        : machine.handle({ type: "key", key: "Escape" });
      sync(snap);
    },
    onKey(e: KeyboardEvent) {
      if (!machine || e.key !== "Escape") return;
      sync(machine.handle({ type: "key", key: "Escape" }));
    },
  };
}
