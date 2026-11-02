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

// The Measure tool: drag to measure a distance and an angle in pt. READ-ONLY.
// The measured segment and its readout ("124.60 pt · 53.1°", at the
// midpoint, beside the line) are one tool preview, live and frozen after the
// release; Esc clears it. Shift constrains to 45° steps. The origin snaps to
// the nearest point ON the path under the press (within 8 screen px) when the
// engine can answer; otherwise the measurement starts at the raw point.
//
// WHY THIS LIVES IN THE EDITOR AND NOT IN A PLUGIN. A ruler between two
// points is a page-level instrument every context wants; the editor's own
// Measure was retired in favour of paged.draw's (built-in-tools.ts records
// it), which made the capability exist only with that bundle loaded. It is
// the host's again (PM-0017) and paged.draw's tool is gone. The state machine
// (`MeasureMachine`) stays in `@paged-media/draw/machines`, which this tool
// and nothing else drives.

import {
  affineScale,
  applyAffine,
  inverseApplyAffine,
  type Affine,
} from "@paged-media/draw/geometry";
import {
  MeasureMachine,
  type MeasureReadout,
  type MeasureSnapshot,
} from "@paged-media/draw/machines";
import type { ElementId } from "@paged-media/client";
import type {
  CanvasPointerEvent,
  GestureHandler,
  PagedEditor,
} from "@paged-media/shell";

import { pxToPt } from "./shared";

/** How far (page pt) the readout sits off the line, along its normal. */
const READOUT_OFFSET_PT = 10;

/** Screen-space radius within which the origin snaps to a hit path. */
const SNAP_TOLERANCE_PX = 8;

/** The path-bearing kinds worth snapping to. */
const PATH_KINDS = new Set([
  "polygon",
  "rectangle",
  "textFrame",
  "graphicLine",
]);

/** The label the readout shows: distance in pt and the angle. */
export function measureReadoutLabel(readout: MeasureReadout): string {
  return `${readout.distance.toFixed(2)} pt · ${readout.angleDeg.toFixed(1)}°`;
}

/** The text preview of a measurement: the label at the segment midpoint,
 *  pushed along its normal, on a backing plate. */
export function measureTextPreview(pageId: string, readout: MeasureReadout) {
  const [fx, fy] = readout.from;
  const [tx, ty] = readout.to;
  const len = Math.hypot(tx - fx, ty - fy);
  // A degenerate segment pushes straight up.
  const nx = len > 0 ? -(ty - fy) / len : 0;
  const ny = len > 0 ? (tx - fx) / len : -1;
  return {
    kind: "text" as const,
    pageId,
    x: (fx + tx) / 2 + nx * READOUT_OFFSET_PT,
    y: (fy + ty) / 2 + ny * READOUT_OFFSET_PT,
    text: measureReadoutLabel(readout),
    anchor: "middle" as const,
    background: true,
  };
}

/** The nearest point ON `target`'s path to `pagePoint`, in page space, or
 *  null when none is within `tolerancePt` or the engine cannot answer. The
 *  hit reply's transform maps between page and the element's local space. */
async function nearestOnPage(
  paged: PagedEditor,
  target: ElementId,
  pagePoint: [number, number],
  tolerancePt: number,
  matrix: Affine | null,
): Promise<[number, number] | null> {
  try {
    const local = inverseApplyAffine(matrix, pagePoint[0], pagePoint[1]);
    if (!local) return null;
    const reply = (await paged.client.send({
      kind: "requestNearestPathPoint",
      payload: { id: target, point: [local[0], local[1]] },
    } as never)) as {
      kind?: string;
      payload?: {
        result?: { point: [number, number]; distance: number } | null;
      };
    } | null;
    const result =
      reply?.kind === "nearestPathPoint" ? reply.payload?.result : null;
    // The reply's distance is local-space: scale the page tolerance in.
    if (!result || result.distance > tolerancePt / affineScale(matrix)) {
      return null;
    }
    const page = applyAffine(matrix, result.point[0], result.point[1]);
    return [page[0], page[1]];
  } catch {
    return null;
  }
}

export function createMeasureHandler(): GestureHandler {
  let paged: PagedEditor | null = null;
  let machine: MeasureMachine | null = null;
  let pageId: string | null = null;

  const render = (snapshot: MeasureSnapshot) => {
    if (!paged) return;
    if (!snapshot.line || !pageId) {
      paged.overlaySignals.setToolPreview(null);
      return;
    }
    const line = {
      pageId,
      points: [
        [snapshot.line[0][0], snapshot.line[0][1]],
        [snapshot.line[1][0], snapshot.line[1][1]],
      ] as [number, number][],
    };
    paged.overlaySignals.setToolPreviews(
      (snapshot.readout
        ? [line, measureTextPreview(pageId, snapshot.readout)]
        : [line]) as never,
    );
  };

  return {
    onActivate(p) {
      paged = p;
      machine = new MeasureMachine();
    },
    onDeactivate(reason) {
      if (reason === "suspend") return;
      paged?.overlaySignals.setToolPreview(null);
      machine = null;
      pageId = null;
      paged = null;
    },
    onPointerDown(e: CanvasPointerEvent) {
      if (!machine || e.button !== 0 || !e.pageId || !e.pagePoint) return;
      pageId = e.pageId;
      const point = e.pagePoint;
      render(
        machine.handle({
          type: "down",
          point,
          modifiers: { shift: e.modifiers.shift },
        }),
      );
      // Best-effort origin snap to a hit path (async; re-anchors the
      // in-flight measurement when it resolves).
      const editor = paged;
      if (!editor) return;
      void (async () => {
        try {
          const reply = await editor.client.send({
            kind: "hitTest",
            payload: { pageId: e.pageId!, docPoint: point, filter: "any" },
          });
          if (reply.kind !== "hitResult") return;
          const hit = reply.payload;
          const target = hit.element ?? null;
          if (!target || !PATH_KINDS.has(target.kind) || !machine) return;
          const snapped = await nearestOnPage(
            editor,
            target,
            point,
            pxToPt(editor, SNAP_TOLERANCE_PX),
            (hit.itemTransform ?? null) as Affine | null,
          );
          if (snapped && machine) render(machine.snapStart(snapped));
        } catch {
          /* snap is best-effort: measure from the raw point */
        }
      })();
    },
    onPointerMove(e: CanvasPointerEvent) {
      if (!machine || !e.pagePoint || e.pageId !== pageId) return;
      render(
        machine.handle({
          type: "move",
          point: e.pagePoint,
          modifiers: { shift: e.modifiers.shift },
        }),
      );
    },
    onPointerUp(e: CanvasPointerEvent) {
      if (!machine || !e.pagePoint || e.pageId !== pageId) return;
      render(
        machine.handle({
          type: "up",
          point: e.pagePoint,
          modifiers: { shift: e.modifiers.shift },
        }),
      );
    },
    onKey(e: KeyboardEvent) {
      if (!machine || e.key !== "Escape") return;
      render(machine.handle({ type: "key", key: "Escape" }));
    },
  };
}
