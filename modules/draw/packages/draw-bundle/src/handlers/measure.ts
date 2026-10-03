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
// THE ON-CANVAS READOUT (the `ToolPreviewText` primitive, guarded by
// `host.supports("overlay.text@1")`): `"124.60 pt · 53.1°"`, anchored at
// the segment midpoint, offset perpendicular to the line so it reads
// beside where it was measured, with the backing plate on.
//
// LINE AND READOUT TOGETHER. This tool used to trade the frozen line for
// the frozen numbers at pointer-up, because it believed the overlay was
// SINGLE-SLOT — and it was, until K-9 put a multi-shape door in the
// contract (`host.overlay.setToolPreviews`, probed by
// `overlay.multiPreview@1`). On a host with the multi-shape sink the
// line and its readout are ONE publish, `[line, text]`, while dragging
// AND after the drag ends. The two older postures keep what they had:
//   · text but NO multi-shape sink (an editor between the two doors):
//     the single-slot swap — the line in flight, the text once frozen;
//   · NO text primitive: the line throughout.
//   · The `media.paged.draw.measureReadout` BINDING publishes in BOTH
//     branches (panels and host surfaces read it), and pointer-up still
//     mirrors to `host.log.info`.
//
// HONEST SUBSET, named:
//   · nearest-path-point SNAP: the wire carries
//     `requestNearestPathPoint` (B-06) but `host.document` has no
//     facade door for it (RFI K-14) — the snap goes through the MARKED v0
//     escape hatch, and only through `raw-wire.ts`, the ONE guarded seam
//     every hatch read in this bundle uses (it types the reply locally,
//     answers null on a host without the hatch, a throwing send or a
//     wrong reply kind). When the snap fails the tool measures from the
//     raw point (best-effort, never a throw).

import type {
  BundleHost,
  CanvasPointerEvent,
  ElementId,
  GestureHandler,
  ToolPreviewText,
} from "@paged-media/plugin-api";

import {
  affineScale,
  applyAffine,
  inverseApplyAffine,
  type Affine,
} from "@paged-media/draw-geometry";
import {
  MeasureMachine,
  type MeasureReadout,
  type MeasureSnapshot,
} from "@paged-media/draw-tools";

import { rawNearestPathPoint } from "../raw-wire";

/** The published readout binding (a `MeasureReadout` JSON object,
 *  deleted when nothing is measured). */
export const BIND_MEASURE_READOUT = "media.paged.draw.measureReadout";

/** The host feature flag that gates the on-canvas readout. */
export const OVERLAY_TEXT_FEATURE = "overlay.text@1";

/** The host feature flag that says the multi-shape preview sink is real
 *  (`setToolPreviews` otherwise forwards only its first shape). */
export const OVERLAY_MULTI_FEATURE = "overlay.multiPreview@1";

/** How far (page pt) the readout sits off the measured line, along its
 *  normal — "beside the line", not on top of it. */
const READOUT_OFFSET_PT = 10;

/** The overlay TEXT primitive.
 *
 *  SKEW CLOSED (`0.2.28-canary.0`): this used to be a local MIRROR of
 *  the contract shape with a cast, because the installed
 *  `0.2.25-canary.0` predated the variant. The published
 *  `ToolPreviewShape` union now carries `ToolPreviewText`, so the mirror
 *  is an ALIAS and the cast is gone. The name is kept because it is part
 *  of this bundle's exported surface. */
export type ToolPreviewTextMirror = ToolPreviewText;

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
const PATH_KINDS = new Set([
  "polygon",
  "rectangle",
  "textFrame",
  "graphicLine",
]);

/** Resolve the nearest on-path point to `pagePoint` on `target`, in
 *  PAGE coordinates — or null when out of tolerance / unavailable.
 *  Wire-level `requestNearestPathPoint` via the MARKED escape hatch;
 *  the engine answers in the element's local (PathAnchors) space, which
 *  maps back to the page through the itemTransform. Exported for the
 *  conformance spec (the exact door the live tool drives).
 *
 *  `known` — the element's itemTransform when the caller ALREADY HOLDS
 *  it (null = identity). The only thing this function wants from the
 *  element is that one matrix, and without `known` it has to read the
 *  whole anchor table to get it: 10 000 anchors across the door for six
 *  numbers, measured on a long path. A hit-test reply carries the same
 *  matrix (`HitResult.itemTransform` and `PathAnchorsResult
 *  .itemTransform` are both the frame's own ItemTransform), so the live
 *  tool — which has just hit-tested to find `target` — passes it and
 *  reads no table. Without `known` the table is read, as before. */
export async function nearestPathPointOnPage(
  host: BundleHost,
  target: ElementId,
  pagePoint: [number, number],
  tolerancePt: number,
  known?: { itemTransform: Affine | null },
): Promise<[number, number] | null> {
  try {
    let matrix: Affine | null;
    if (known) {
      matrix = known.itemTransform;
    } else {
      const table = await host.document.pathAnchors(target);
      if (!table) return null;
      matrix = table.itemTransform ?? null;
    }
    const local = inverseApplyAffine(matrix, pagePoint[0], pagePoint[1]);
    if (!local) return null;
    // ESCAPE HATCH (named, RFI K-14): no `document.nearestPathPoint`
    // facade — the read goes through the ONE guarded seam.
    const result = await rawNearestPathPoint(host, target, [local[0], local[1]]);
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
  // primitive / the multi-shape sink or it doesn't — the answer cannot
  // change mid-gesture.
  const canDrawText = host.supports(OVERLAY_TEXT_FEATURE);
  const canDrawBoth = canDrawText && host.supports(OVERLAY_MULTI_FEATURE);

  const render = (snapshot: MeasureSnapshot) => {
    if (!snapshot.line || !pageId) {
      host.overlay.setToolPreview(null);
      host.bindings.delete(BIND_MEASURE_READOUT);
      return;
    }
    const line = {
      pageId,
      points: [
        [snapshot.line[0][0], snapshot.line[0][1]],
        [snapshot.line[1][0], snapshot.line[1][1]],
      ] as [number, number][],
    };
    if (canDrawBoth) {
      // The line AND its readout, in one publish, live and frozen.
      host.overlay.setToolPreviews(
        snapshot.readout ? [line, measureTextPreview(pageId, snapshot.readout)] : [line],
      );
    } else if (canDrawText && !snapshot.measuring && snapshot.readout) {
      // A single-slot host: the frozen numbers replace the frozen line.
      host.overlay.setToolPreview(measureTextPreview(pageId, snapshot.readout));
    } else {
      host.overlay.setToolPreview(line);
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
          // The hit-test reply already carries the hit element's
          // transform — hand it over rather than re-reading the path.
          const snapped = await nearestPathPointOnPage(
            host,
            target,
            point,
            host.viewport.pxToPt(SNAP_TOLERANCE_PX),
            { itemTransform: hit?.itemTransform ?? null },
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
