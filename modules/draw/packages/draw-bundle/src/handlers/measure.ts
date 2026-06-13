// The Measure tool — READ-ONLY: a drag measures distance/angle in pt,
// the measured segment displays through the shared tool-preview overlay
// channel, and the numbers publish as a named binding (+ an info log).
//
// HONEST SUBSET, named:
//   · the overlay channel (`host.overlay.setToolPreview`) carries
//     SHAPES only — there is no text primitive, so the numeric readout
//     cannot render on-canvas. It publishes through `host.bindings`
//     (`media.paged.draw.measureReadout`, a JSON object) for any panel/
//     host surface to display, and mirrors to `host.log.info` on
//     pointer-up. An overlay TEXT primitive is an RFI candidate.
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
} from "@paged-media/plugin-api";

import {
  affineScale,
  applyAffine,
  inverseApplyAffine,
} from "@paged-media/draw-geometry";
import {
  MeasureMachine,
  type MeasureSnapshot,
} from "@paged-media/draw-tools";

/** The published readout binding (a `MeasureReadout` JSON object,
 *  deleted when nothing is measured). */
export const BIND_MEASURE_READOUT = "media.paged.draw.measureReadout";

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

  const render = (snapshot: MeasureSnapshot) => {
    if (!snapshot.line || !pageId) {
      host.overlay.setToolPreview(null);
      host.bindings.delete(BIND_MEASURE_READOUT);
      return;
    }
    host.overlay.setToolPreview({
      pageId,
      points: [
        [snapshot.line[0][0], snapshot.line[0][1]],
        [snapshot.line[1][0], snapshot.line[1][1]],
      ],
    });
    if (snapshot.readout) {
      // The on-canvas numeric readout is NOT drawable through the
      // shape-only preview channel — publish for host surfaces instead
      // (module-header honesty note).
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
