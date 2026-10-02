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
// Catmull-Rom-fitted anchors) becomes ONE mutation through
// `host.document.mutate`: an `insertPath`, or — for a pressure stroke —
// one batch that inserts the path and outlines it.
//
// The preview is APPENDED TO, not re-mapped: `./stroke-preview.ts` owns
// the one array a stroke hands the overlay, and says what the overlay
// door still costs.

import type {
  BundleHost,
  CanvasPointerEvent,
  GestureHandler,
} from "@paged-media/plugin-api";

import { strokeWidthFromPressure } from "@paged-media/draw-geometry";
import {
  PencilMachine,
  type PencilCommit,
  type PencilSnapshot,
} from "@paged-media/draw-tools";

import { outlineStrokeVariableMutationFor } from "./brush";
import { insertPathMutationFor } from "./insert-path";
import { createStrokePreview } from "./stroke-preview";
import {
  batchMutationFor,
  bindCreatedMutationFor,
  handleElementId,
} from "../commands/v59-wire";

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
/** The handle a pressure stroke is named by inside its own batch. */
const STROKE_HANDLE = "stroke";

export function createPencilHandler(host: BundleHost): GestureHandler {
  let machine: PencilMachine | null = null;
  let pageId: string | null = null;
  const preview = createStrokePreview(host);

  const reset = () => {
    machine = null;
    pageId = null;
    preview.clear();
  };

  /** The lift, as one promise. A mouse stroke is ONE `insertPath`. A
   *  PRESSURE stroke used to be two mutations and two undo steps (the
   *  insert, then the variable-width outline, each its own rebuild); it
   *  is ONE batch now — `bindCreated` names the path the batch just
   *  inserted so the outline can address it — and one undo step.
   *
   *  A refused batch falls back to the two steps as they shipped, which
   *  keeps the degrade they always had: an outline the kernel rejects
   *  leaves the plain centerline standing rather than nothing at all. */
  const commit = async (page: string, c: PencilCommit): Promise<void> => {
    const insert = insertPathMutationFor(page, c.anchors, c.open);
    // B-08 — pressure → variable-width stroke. When a pressure device
    // drove the stroke (the sample pressures actually VARY — a mouse's
    // constant NEUTRAL never triggers this) and the contour is OPEN (the
    // engine's v1 variable-outline scope), the drawn path becomes a
    // variable-width outline via the `outlineStrokeVariable` wire op:
    // per-anchor width stops from the linear pressure ramp.
    const widths =
      c.open && pressuresVary(c.pressures)
        ? c.pressures.map((pr) =>
            strokeWidthFromPressure(pr, PRESSURE_WIDTH_PROFILE),
          )
        : null;

    if (widths) {
      const outlined = await host.document.mutate(
        batchMutationFor([
          insert,
          bindCreatedMutationFor(STROKE_HANDLE),
          outlineStrokeVariableMutationFor(
            handleElementId(STROKE_HANDLE),
            widths,
          ),
        ]),
      );
      if (outlined.applied) {
        if (outlined.createdId) await host.selection.set([outlined.createdId]);
        return;
      }
      host.log.debug(
        `pencil: the one-batch pressure commit was refused (${JSON.stringify(outlined.error)}) — ` +
          "falling back to insert, then outline",
      );
    }

    const outcome = await host.document.mutate(insert);
    if (!outcome.applied) {
      host.log.warn(
        `pencil insertPath rejected by engine: ${JSON.stringify(outcome.error)}`,
      );
      return;
    }
    if (outcome.createdId) await host.selection.set([outcome.createdId]);
    if (outcome.createdId && widths) {
      // The stepwise outline: its own undo step — undo restores the
      // plain centerline path.
      const outlined = await host.document.mutate(
        outlineStrokeVariableMutationFor(outcome.createdId, widths),
      );
      if (!outlined.applied) {
        host.log.warn(
          `pencil variable-width outline rejected (path kept as centerline): ${JSON.stringify(outlined.error)}`,
        );
      }
    }
  };

  const sync = (snapshot: PencilSnapshot) => {
    if (snapshot.commit && pageId) {
      const c = snapshot.commit;
      const page = pageId;
      reset();
      void commit(page, c).catch((err) =>
        host.log.warn(`pencil commit failed: ${err}`),
      );
      return;
    }
    if (!snapshot.active) {
      reset();
      return;
    }
    if (pageId) preview.show(pageId, snapshot.points);
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
