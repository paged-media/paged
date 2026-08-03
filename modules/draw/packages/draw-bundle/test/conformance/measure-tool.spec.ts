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

// Phase 4c conformance — the Measure tool (READ-ONLY; honest subsets
// named in src/handlers/measure.ts). Pins:
//   · the `requestNearestPathPoint` wire door (B-06) answers headlessly
//     through the MARKED escape hatch the tool drives, and
//     `nearestPathPointOnPage` maps the reply back to page space with
//     the tolerance gate;
//   · the LIVE gesture handler publishes the measured line on the
//     overlay channel and the numeric readout as the
//     `media.paged.draw.measureReadout` binding, and tears both down on
//     deactivate;
//   · the ON-CANVAS READOUT, BOTH branches of the `overlay.text@1`
//     guard: with the flag the frozen measurement publishes the
//     `ToolPreviewText` primitive (single-slot channel — the line while
//     dragging, the label once frozen); WITHOUT it (the installed
//     plugin-sdk 0.2.25-canary.0 predates the flag — real skew, not a
//     hypothetical) the line stays published and the binding remains the
//     only readout;
//   · the tool drives NO mutations (read-only proof: the document is
//     untouched).

import { describe, expect, it, beforeAll, afterAll } from "vitest";

import type {
  BundleHost,
  CanvasPointerEvent,
  ElementId,
  ToolPreviewPolyline,
} from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";
import type { MeasureReadout } from "@paged-media/draw-tools";

import {
  drawBundle,
  createMeasureHandler,
  measureReadoutLabel,
  measureTextPreview,
  nearestPathPointOnPage,
  BIND_MEASURE_READOUT,
  OVERLAY_TEXT_FEATURE,
  type ToolPreviewTextMirror,
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

  describe("the on-canvas readout (overlay.text@1)", () => {
    it("measureTextPreview places the label beside the segment midpoint", () => {
      const preview = measureTextPreview("pg1", {
        from: [0, 0],
        to: [100, 0],
        dx: 100,
        dy: 0,
        distance: 100,
        angleDeg: 0,
      });
      expect(preview.kind).toBe("text");
      expect(preview.pageId).toBe("pg1");
      // Midpoint (50, 0) pushed 10 pt along the segment normal.
      expect(preview.x).toBeCloseTo(50);
      expect(preview.y).toBeCloseTo(10);
      expect(preview.text).toBe("100.00 pt · 0.0°");
      expect(preview.anchor).toBe("middle");
      expect(preview.background).toBe(true);
      // A degenerate (zero-length) measurement still places a label.
      const degenerate = measureTextPreview("pg1", {
        from: [10, 10],
        to: [10, 10],
        dx: 0,
        dy: 0,
        distance: 0,
        angleDeg: 0,
      });
      expect(degenerate.x).toBeCloseTo(10);
      expect(degenerate.y).toBeCloseTo(0);
    });

    it("the label is distance + angle", () => {
      expect(
        measureReadoutLabel({
          from: [0, 0],
          to: [30, 40],
          dx: 30,
          dy: 40,
          distance: 50,
          angleDeg: 53.13010235,
        }),
      ).toBe("50.00 pt · 53.1°");
    });

    it("WITHOUT the flag the frozen measurement keeps the LINE (this host — real skew)", () => {
      // The installed @paged-media/plugin-sdk (0.2.25-canary.0) has no
      // `overlay.text@1` in HOST_FEATURES, so this is the branch the
      // harness actually exercises today.
      expect(h.host.supports(OVERLAY_TEXT_FEATURE)).toBe(false);
      const handler = createMeasureHandler(h.host);
      handler.onActivate(undefined as never);
      handler.onPointerDown(pointer([10, 10]));
      handler.onPointerUp(pointer([110, 10]));
      const frozen = h.lastToolPreview() as ToolPreviewPolyline;
      expect(frozen.points).toEqual([
        [10, 10],
        [110, 10],
      ]);
      // The binding is the ONLY readout on such a host.
      expect(
        (h.host.bindings.get(BIND_MEASURE_READOUT) as MeasureReadout).distance,
      ).toBeCloseTo(100);
      handler.onDeactivate("switch");
    });

    it("WITH the flag the frozen measurement publishes the TEXT primitive; the drag still shows the line", () => {
      // A host that DOES carry the flag (the contract's own shape — the
      // local plugin-api already defines `ToolPreviewText`). Everything
      // else delegates to the real headless host, so the preview lands
      // on the real overlay channel.
      const textHost = {
        ...h.host,
        supports: (feature: string) =>
          feature === OVERLAY_TEXT_FEATURE || h.host.supports(feature),
      } as unknown as BundleHost;

      const handler = createMeasureHandler(textHost);
      handler.onActivate(undefined as never);
      handler.onPointerDown(pointer([10, 10]));
      handler.onPointerMove(pointer([110, 10]));
      // Mid-drag: still the LINE (single-slot channel).
      const live = h.lastToolPreview() as ToolPreviewPolyline;
      expect(live.points).toEqual([
        [10, 10],
        [110, 10],
      ]);

      handler.onPointerUp(pointer([110, 10]));
      const frozen = h.lastToolPreview() as unknown as ToolPreviewTextMirror;
      expect(frozen.kind).toBe("text");
      expect(frozen.text).toBe("100.00 pt · 0.0°");
      expect(frozen.background).toBe(true);
      expect(frozen.x).toBeCloseTo(60);
      // The binding publishes in BOTH branches (panels read it).
      expect(
        (h.host.bindings.get(BIND_MEASURE_READOUT) as MeasureReadout).distance,
      ).toBeCloseTo(100);

      handler.onDeactivate("switch");
      expect(h.lastToolPreview()).toBeNull();
    });
  });
});
