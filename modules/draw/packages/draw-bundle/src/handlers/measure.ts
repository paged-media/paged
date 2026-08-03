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

// The Measure tool — READ-ONLY: a drag measures distance/angle in pt,
// the measured segment displays through the shared tool-preview overlay
// channel, and the numbers publish as a named binding (+ an info log).
//
// THE ON-CANVAS READOUT (the RFI gap "the overlay channel carries
// shapes only" — CLOSED by the `ToolPreviewText` primitive, guarded by
// `host.supports("overlay.text@1")`):
//   · while the drag is IN FLIGHT the preview slot carries the measured
//     LINE (the geometry feedback that matters mid-drag);
//   · the moment the drag ENDS the slot carries the readout as TEXT —
//     `"124.60 pt · 53.1°"`, anchored at the segment midpoint, offset
//     perpendicular to the line so it reads beside where it was
//     measured, with the backing plate on for legibility over content.
//   · WHY the swap and not both at once: `overlay.setToolPreview` is a
//     SINGLE-SLOT channel (one `ToolPreviewShape`, last write wins) —
//     the host has no preview LIST. So the frozen line is traded for
//     the frozen numbers; that trade is named here rather than hidden.
//     A multi-primitive preview channel is the follow-up RFI item.
//   · FALLBACK: on a host whose plugin-sdk predates `overlay.text@1`
//     (the shipped 0.2.25-canary.0 does — the contract lags the local
//     build) `supports` answers false and the tool keeps publishing the
//     LINE after pointer-up, exactly as before.
//   · The `media.paged.draw.measureReadout` BINDING publishes in BOTH
//     branches (panels and host surfaces read it), and pointer-up still
//     mirrors to `host.log.info`.
//
// HONEST SUBSET, named:
//   · nearest-path-point SNAP: the wire carries
//     `requestNearestPathPoint` (B-06) but `host.document` has no
//     facade door for it yet — the snap goes through the MARKED v0
//     escape hatch `host.editor.client.send` (DESIGN.md §4.9). A
//     `document.nearestPathPoint` facade door (and curating
//     `NearestPathPointResult` into plugin-api's wire subset) is the
//     RFI follow-up; the reply shape is typed locally below until then.
//     When the snap fails the tool measures from the raw point
//     (best-effort, never a throw).

import type {
  BundleHost,
  CanvasPointerEvent,
  ElementId,
  GestureHandler,
  ToolPreviewShape,
} from "@paged-media/plugin-api";

import {
  affineScale,
  applyAffine,
  inverseApplyAffine,
} from "@paged-media/draw-geometry";
import {
  MeasureMachine,
  type MeasureReadout,
  type MeasureSnapshot,
} from "@paged-media/draw-tools";

/** The published readout binding (a `MeasureReadout` JSON object,
 *  deleted when nothing is measured). */
export const BIND_MEASURE_READOUT = "media.paged.draw.measureReadout";

/** The host feature flag that gates the on-canvas readout. */
export const OVERLAY_TEXT_FEATURE = "overlay.text@1";

/** How far (page pt) the readout sits off the measured line, along its
 *  normal — "beside the line", not on top of it. */
const READOUT_OFFSET_PT = 10;

/** The overlay TEXT primitive (contract `ToolPreviewText`).
 *
 *  SKEW, named: the INSTALLED `@paged-media/plugin-api`
 *  (0.2.25-canary.0) predates the variant, so its `ToolPreviewShape`
 *  union does not carry it and this is a local MIRROR of the contract
 *  shape — the same fields, verbatim. The single cast lives in
 *  `measureTextPreview` below; when the published contract catches up,
 *  delete this interface and import the type. */
export interface ToolPreviewTextMirror {
  kind: "text";
  pageId: string;
  x: number;
  y: number;
  text: string;
  size?: number;
  anchor?: "start" | "middle" | "end";
  background?: boolean;
}

/** The label the on-canvas readout shows: distance in pt + the angle. */
export function measureReadoutLabel(readout: MeasureReadout): string {
  return `${readout.distance.toFixed(2)} pt · ${readout.angleDeg.toFixed(1)}°`;
}

/** The TEXT preview for a frozen measurement: the label at the segment
 *  MIDPOINT, pushed `READOUT_OFFSET_PT` along the segment normal, with
 *  the backing plate on. Exported so the conformance spec asserts the
 *  exact primitive the live tool publishes (no second copy). */
export function measureTextPreview(
  pageId: string,
  readout: MeasureReadout,
): ToolPreviewTextMirror {
  const [fx, fy] = readout.from;
  const [tx, ty] = readout.to;
  const len = Math.hypot(tx - fx, ty - fy);
  // Unit normal of the segment (−dy, dx)/len; a degenerate segment just
  // pushes straight up.
  const nx = len > 0 ? -(ty - fy) / len : 0;
  const ny = len > 0 ? (tx - fx) / len : -1;
  return {
    kind: "text",
    pageId,
    x: (fx + tx) / 2 + nx * READOUT_OFFSET_PT,
    y: (fy + ty) / 2 + ny * READOUT_OFFSET_PT,
    text: measureReadoutLabel(readout),
    anchor: "middle",
    background: true,
  };
}

/** Screen-space radius within which the measure origin snaps to the
 *  nearest point ON a hit path. */
const SNAP_TOLERANCE_PX = 8;

/** The path-bearing kinds worth snapping to. */
const PATH_KINDS = new Set(["polygon", "rectangle", "textFrame", "graphicLine"]);

/** The `nearestPathPoint` reply payload (wire B-06) — typed LOCALLY
 *  because plugin-api's curated wire subset doesn't carry it yet (no
 *  facade door exists; see the module-header honesty note). */
interface NearestPathPointWire {
  segStart: number;
  segEnd: number;
  t: number;
  point: [number, number];
  distance: number;
}

/** Resolve the nearest on-path point to `pagePoint` on `target`, in
 *  PAGE coordinates — or null when out of tolerance / unavailable.
 *  Wire-level `requestNearestPathPoint` via the MARKED escape hatch;
 *  the engine answers in the element's local (PathAnchors) space, which
 *  maps back to the page through the itemTransform. Exported for the
 *  conformance spec (the exact door the live tool drives). */
export async function nearestPathPointOnPage(
  host: BundleHost,
  target: ElementId,
  pagePoint: [number, number],
  tolerancePt: number,
): Promise<[number, number] | null> {
  try {
    const table = await host.document.pathAnchors(target);
    if (!table) return null;
    const matrix = table.itemTransform ?? null;
    const local = inverseApplyAffine(matrix, pagePoint[0], pagePoint[1]);
    if (!local) return null;
    // ESCAPE HATCH (named): no `document.nearestPathPoint` facade door
    // exists yet — wire-level `requestNearestPathPoint` via host.editor.
    const reply = await host.editor.client.send({
      kind: "requestNearestPathPoint",
      payload: { id: target, point: [local[0], local[1]] },
    });
    if (reply.kind !== "nearestPathPoint") return null;
    const result = (
      reply.payload as { result: NearestPathPointWire | null }
    ).result;
    // The reply's distance is LOCAL-space — scale the page-space
    // tolerance into local (the anchors.ts pick-tolerance idiom).
    if (!result || result.distance > tolerancePt / affineScale(matrix)) {
      return null;
    }
    const page = applyAffine(matrix, result.point[0], result.point[1]);
    return [page[0], page[1]];
  } catch {
    return null;
  }
}

export function createMeasureHandler(host: BundleHost): GestureHandler {
  let machine: MeasureMachine | null = null;
  let pageId: string | null = null;

  // Probed ONCE per handler: the host either has the overlay TEXT
  // primitive or it doesn't — the answer cannot change mid-gesture.
  const canDrawText = host.supports(OVERLAY_TEXT_FEATURE);

  const render = (snapshot: MeasureSnapshot) => {
    if (!snapshot.line || !pageId) {
      host.overlay.setToolPreview(null);
      host.bindings.delete(BIND_MEASURE_READOUT);
      return;
    }
    // Single-slot channel: the LINE while the drag is in flight, the
    // TEXT readout once it freezes (module-header honesty note). Without
    // `overlay.text@1` the line stays in both states — the old behavior.
    if (canDrawText && !snapshot.measuring && snapshot.readout) {
      host.overlay.setToolPreview(
        measureTextPreview(
          pageId,
          snapshot.readout,
        ) as unknown as ToolPreviewShape,
      );
    } else {
      host.overlay.setToolPreview({
        pageId,
        points: [
          [snapshot.line[0][0], snapshot.line[0][1]],
          [snapshot.line[1][0], snapshot.line[1][1]],
        ],
      });
    }
    if (snapshot.readout) {
      // The binding publishes in BOTH branches — panels and host
      // surfaces read it, and it is the ONLY readout on a host without
      // the text primitive.
      host.bindings.publish(BIND_MEASURE_READOUT, snapshot.readout);
    }
  };

  return {
    onActivate() {
      machine = new MeasureMachine();
    },
    onDeactivate(reason) {
      if (reason === "suspend") return;
      machine = null;
      pageId = null;
      host.overlay.setToolPreview(null);
      host.bindings.delete(BIND_MEASURE_READOUT);
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
      void (async () => {
        try {
          const hit = await host.document.hitTest(e.pageId!, point, "any");
          const target = hit?.element ?? null;
          if (!target || !PATH_KINDS.has(target.kind) || !machine) return;
          const snapped = await nearestPathPointOnPage(
            host,
            target,
            point,
            host.viewport.pxToPt(SNAP_TOLERANCE_PX),
          );
          if (snapped && machine) render(machine.snapStart(snapped));
        } catch {
          /* snap is best-effort — measure from the raw point */
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
      const snap = machine.handle({
        type: "up",
        point: e.pagePoint,
        modifiers: { shift: e.modifiers.shift },
      });
      render(snap);
      if (snap.readout) {
        const r = snap.readout;
        host.log.info(
          `measure: ${r.distance.toFixed(2)} pt (dx ${r.dx.toFixed(2)}, ` +
            `dy ${r.dy.toFixed(2)}, angle ${r.angleDeg.toFixed(1)}°)`,
        );
      }
    },
    onKey(e: KeyboardEvent) {
      if (!machine || e.key !== "Escape") return;
      render(machine.handle({ type: "key", key: "Escape" }));
    },
  };
}
