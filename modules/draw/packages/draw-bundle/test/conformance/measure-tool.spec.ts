// Phase 4c conformance — the Measure tool (READ-ONLY; honest subsets
// named in src/handlers/measure.ts). Pins:
//   · the `requestNearestPathPoint` wire door (B-06) answers headlessly
//     through the MARKED escape hatch the tool drives, and
//     `nearestPathPointOnPage` maps the reply back to page space with
//     the tolerance gate;
//   · the LIVE gesture handler publishes the measured line on the
//     overlay channel and the numeric readout as the
//     `media.paged.draw.measureReadout` binding (the shape-only overlay
//     channel cannot carry text — the named subset), and tears both
//     down on deactivate;
//   · the tool drives NO mutations (read-only proof: the document is
//     untouched).

import { describe, expect, it, beforeAll, afterAll } from "vitest";

import type {
  CanvasPointerEvent,
  ElementId,
  ToolPreviewPolyline,
} from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";
import type { MeasureReadout } from "@paged-media/draw-tools";

import {
  drawBundle,
  createMeasureHandler,
  nearestPathPointOnPage,
  BIND_MEASURE_READOUT,
} from "../../src";
import { F1_MULTI_SHAPE } from "../fixtures/corpus";
import { liveTable } from "../replay";
import { openHost } from "./host";

const POLY = { kind: "polygon", id: F1_MULTI_SHAPE.ids.polygon! } as ElementId;
const polyRef = { kind: "polygon", id: F1_MULTI_SHAPE.ids.polygon! };

function pointer(
  point: [number, number],
  shift = false,
): CanvasPointerEvent {
  return {
    pageId: F1_MULTI_SHAPE.pageId,
    pagePoint: point,
    docPoint: point,
    modifiers: { shift, alt: false, cmd: false, ctrl: false },
    maxDelta: 0,
    button: 0,
    target: null,
    pressure: 0.5,
    tiltX: 0,
    tiltY: 0,
    pointerType: "mouse",
  };
}

describe("draw conformance — measure tool (Phase 4c)", () => {
  let h: HeadlessHost;

  beforeAll(async () => {
    h = await openHost();
    await h.load(F1_MULTI_SHAPE.bytes());
    h.loadBundle(drawBundle);
  });
  afterAll(() => h?.dispose());

  it("the requestNearestPathPoint door answers and maps back to page space (escape hatch, B-06)", async () => {
    // [175, 500] is the midpoint of the polygon's first segment
    // ([100,400] → [250,600]); identity itemTransform on the fixture →
    // the page-space answer is the on-curve point itself.
    const snapped = await nearestPathPointOnPage(h.host, POLY, [175, 500], 6);
    expect(snapped).not.toBeNull();
    // The straight segment passes through the click — the snap is the
    // click itself (distance ~0, inside the 6 pt gate).
    expect(snapped![0]).toBeCloseTo(175, 5);
    expect(snapped![1]).toBeCloseTo(500, 5);
    // Out-of-tolerance queries answer null (the gate).
    expect(
      await nearestPathPointOnPage(h.host, POLY, [175, 560], 6),
    ).toBeNull();
  });

  it("the live handler publishes the line on the overlay channel + the readout binding; deactivate tears down", async () => {
    const before = await liveTable(h.host, polyRef);
    const handler = createMeasureHandler(h.host);
    handler.onActivate(undefined as never);

    handler.onPointerDown(pointer([10, 10]));
    handler.onPointerMove(pointer([40, 50]));
    const live = h.lastToolPreview() as ToolPreviewPolyline;
    expect(live).not.toBeNull();
    expect(live.points[0]).toEqual([10, 10]);
    expect(live.points[1]).toEqual([40, 50]);
    const liveReadout = h.host.bindings.get(
      BIND_MEASURE_READOUT,
    ) as MeasureReadout;
    expect(liveReadout.distance).toBeCloseTo(50);

    handler.onPointerUp(pointer([40, 50]));
    const frozen = h.host.bindings.get(BIND_MEASURE_READOUT) as MeasureReadout;
    expect(frozen.dx).toBe(30);
    expect(frozen.dy).toBe(40);
    expect(frozen.angleDeg).toBeCloseTo((Math.atan2(40, 30) * 180) / Math.PI);

    // Shift constrains the next measurement to 45° steps.
    handler.onPointerDown(pointer([0, 0]));
    handler.onPointerUp(pointer([100, 8], true));
    const constrained = h.host.bindings.get(
      BIND_MEASURE_READOUT,
    ) as MeasureReadout;
    expect(constrained.dy).toBeCloseTo(0);

    // READ-ONLY proof: no mutation reached the engine (the polygon's
    // table is byte-identical; measure registers nothing undoable).
    expect((await liveTable(h.host, polyRef)).anchors).toEqual(before.anchors);

    handler.onDeactivate("switch");
    expect(h.lastToolPreview()).toBeNull();
    expect(h.host.bindings.get(BIND_MEASURE_READOUT)).toBeUndefined();
  });
});
