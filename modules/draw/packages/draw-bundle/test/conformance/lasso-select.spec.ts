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

// Wave 2 conformance — Lasso select: the LIVE freehand-region handler
// against the real engine. Enumeration is the tree + ONE
// elementGeometry read (no hitTest grid sampling); membership is, by
// default, INTERSECTION with each element's outline (its real path for
// the path-bearing kinds — one pathAnchors read each — its transformed
// bounds otherwise), and the v0 CENTERS-inside rule behind the tool's
// `mode` option. handlers/lasso.ts documents both. F1's leaf centers:
// rectangle (200, 200), polygon (250, 500), line (250, 675).

import { describe, expect, it, beforeAll, beforeEach, afterAll } from "vitest";

import type { CanvasPointerEvent, ElementId } from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";
import { pointInPolygon } from "@paged-media/draw-geometry";

import {
  drawBundle,
  createLassoSelectHandler,
  lassoIntersections,
  lassoMatches,
  lassoTouchesOutline,
  outlineOfBounds,
  outlineOfPath,
  LASSO_OPTIONS,
} from "../../src";
import { F1_MULTI_SHAPE } from "../fixtures/corpus";
import { countingHost } from "../perf/counting-host";
import { openHost } from "./host";

function pointer(
  pageId: string,
  point: [number, number],
  maxDelta = 0,
): CanvasPointerEvent {
  return {
    pageId,
    pagePoint: point,
    docPoint: point,
    modifiers: { shift: false, alt: false, cmd: false, ctrl: false },
    maxDelta,
    button: 0,
    target: null,
    pressure: 0.5,
    tiltX: 0,
    tiltY: 0,
    pointerType: "mouse",
  };
}

async function until(predicate: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 250; i++) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 4));
  }
  throw new Error("timed out waiting for the lasso selection to land");
}

/** Drive a freehand loop through the handler (down → moves → up). */
function loop(
  handler: ReturnType<typeof createLassoSelectHandler>,
  pageId: string,
  points: [number, number][],
): void {
  handler.onActivate(undefined as never);
  handler.onPointerDown(pointer(pageId, points[0]));
  for (const p of points.slice(1, -1)) handler.onPointerMove(pointer(pageId, p, 40));
  handler.onPointerUp(pointer(pageId, points[points.length - 1], 40));
}

describe("draw conformance — lasso select (wave 2)", () => {
  it("lassoMatches applies the item transform before the center test", () => {
    const inside = lassoMatches(
      [
        {
          id: { kind: "rectangle", id: "a" },
          pageId: "usp",
          // Raw bounds center (5, 5)…
          bounds: [0, 0, 10, 10],
          // …translated by +100/+100 → page center (105, 105).
          itemTransform: [1, 0, 0, 1, 100, 100],
        },
      ] as never,
      [
        [100, 100],
        [110, 100],
        [110, 110],
        [100, 110],
      ],
    );
    expect(inside.map((e) => e.id)).toEqual(["a"]);
    // The SAME item against a ring around the RAW center misses.
    const missed = lassoMatches(
      [
        {
          id: { kind: "rectangle", id: "a" },
          pageId: "usp",
          bounds: [0, 0, 10, 10],
          itemTransform: [1, 0, 0, 1, 100, 100],
        },
      ] as never,
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
      ],
    );
    expect(missed).toHaveLength(0);
  });

  describe("against the real engine (F1)", () => {
    let h: HeadlessHost;

    beforeAll(async () => {
      h = await openHost();
      await h.load(F1_MULTI_SHAPE.bytes());
      h.loadBundle(drawBundle);
    });
    afterAll(() => h?.dispose());

    it("a loop around the polygon + line selects exactly those two", async () => {
      await h.host.selection.set([]);
      const handler = createLassoSelectHandler(h.host);
      // A loop spanning y 350..720, x 50..450: contains the polygon
      // center (250, 500) and the line center (250, 675), NOT the
      // rectangle center (200, 200).
      loop(handler, F1_MULTI_SHAPE.pageId, [
        [50, 350],
        [450, 350],
        [450, 720],
        [50, 720],
      ]);
      await until(async () => h.host.selection.get().length === 2);
      expect(
        h.host.selection
          .get()
          .map((e) => e.id)
          .sort(),
      ).toEqual(["uline", "upoly"]);
      handler.onDeactivate("switch");
    });

    it("an empty region CLEARS the selection (the marquee convention)", async () => {
      await h.host.selection.set([{ kind: "rectangle", id: "urect" } as never]);
      const handler = createLassoSelectHandler(h.host);
      // A small loop over empty canvas (x 500.., y 50..) holds no center.
      loop(handler, F1_MULTI_SHAPE.pageId, [
        [500, 50],
        [560, 50],
        [560, 90],
        [500, 90],
      ]);
      await until(async () => h.host.selection.get().length === 0);
      handler.onDeactivate("switch");
    });

    it("a click / short drag (< 3 points) leaves the selection alone (the default rule)", async () => {
      await h.host.selection.set([{ kind: "rectangle", id: "urect" } as never]);
      const handler = createLassoSelectHandler(h.host);
      handler.onActivate(undefined as never);
      handler.onPointerDown(pointer(F1_MULTI_SHAPE.pageId, [500, 50]));
      handler.onPointerUp(pointer(F1_MULTI_SHAPE.pageId, [500, 50]));
      await new Promise((r) => setTimeout(r, 100));
      expect(h.host.selection.get().map((e) => e.id)).toEqual(["urect"]);
      handler.onDeactivate("switch");
    });
  });

  // INTERSECTION — the default rule since the lasso grew a `mode` option.
  // Each scenario is run under BOTH rules, so it discriminates: the
  // lasso touches the outline and does not hold the bounds centre (or
  // holds the centre and touches nothing).
  describe("intersection with the OUTLINE (the default) vs the bounds CENTRE (real engine, F1)", () => {
    let h: HeadlessHost;
    const PAGE = F1_MULTI_SHAPE.pageId;
    const POLY = { kind: "polygon", id: "upoly" } as ElementId;
    const RECT = { kind: "rectangle", id: "urect" } as ElementId;

    /** Run one lasso under `mode` (null = no host store: the default)
     *  and answer the ids it selected, sorted. */
    const lassoIds = async (
      ring: [number, number][],
      mode: "intersect" | "centre" | null,
      host = h.host,
    ): Promise<string[]> => {
      await h.host.selection.set([{ kind: "rectangle", id: "urect" } as never]);
      await h.host.selection.set([]);
      const handler = createLassoSelectHandler(host);
      const paged =
        mode === null
          ? undefined
          : {
              toolSettings: {
                getValue: (tool: string, key: string) =>
                  tool === LASSO_OPTIONS.toolId && key === "mode" ? mode : undefined,
              },
            };
      handler.onActivate(paged as never);
      handler.onPointerDown(pointer(PAGE, ring[0]));
      for (const p of ring.slice(1, -1)) handler.onPointerMove(pointer(PAGE, p, 40));
      handler.onPointerUp(pointer(PAGE, ring[ring.length - 1], 40));
      // Settle: the commit is a few awaited reads, then one selection set.
      for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 2));
      handler.onDeactivate("switch");
      return h.host.selection
        .get()
        .map((e) => String(e.id))
        .sort();
    };

    beforeAll(async () => {
      h = await openHost();
      h.loadBundle(drawBundle);
    });
    beforeEach(async () => {
      await h.load(F1_MULTI_SHAPE.bytes());
    });
    afterAll(() => h?.dispose());

    it("a lasso across the rectangle's right EDGE (its centre far outside) selects it — centre mode does not", async () => {
      const acrossEdge: [number, number][] = [
        [280, 180],
        [340, 180],
        [340, 220],
        [280, 220],
      ];
      expect(await lassoIds(acrossEdge, null)).toEqual(["urect"]);
      expect(await lassoIds(acrossEdge, "intersect")).toEqual(["urect"]);
      expect(await lassoIds(acrossEdge, "centre")).toEqual([]);
    });

    it("a lasso around ONE END of the open polygon selects it — the outline is the open V, not its box", async () => {
      const atEnd: [number, number][] = [
        [90, 390],
        [120, 390],
        [120, 420],
        [90, 420],
      ];
      expect(await lassoIds(atEnd, null)).toEqual(["upoly"]);
      expect(await lassoIds(atEnd, "centre")).toEqual([]);
    });

    it("a lasso INSIDE the V's bounding box but clear of its path selects NOTHING — the path, not the box, decides", async () => {
      // upoly is (100,400) → (250,600) → (400,400); its box is
      // 100..400 × 400..600 and (250, 450) sits in it, above the V.
      const inTheBox: [number, number][] = [
        [240, 440],
        [260, 440],
        [260, 460],
        [240, 460],
      ];
      expect(await lassoIds(inTheBox, "intersect")).toEqual([]);
      // Contrast: the lasso lies INSIDE the item's transformed bounds, so
      // any box-based test (bounds overlap, a marquee) would have hit it.
      const [item] = await h.host.document.elementGeometry([POLY]);
      const box = outlineOfBounds(item).rings[0];
      expect(inTheBox.every((p) => pointInPolygon(p, box))).toBe(true);
    });

    it("a path MOVED by a framePath write is found where it IS — the bounds still say where it was (measured)", async () => {
      const moved = await h.host.document.mutate({
        op: "setElementProperty",
        args: {
          elementId: POLY,
          path: "framePath",
          value: {
            type: "framePath",
            value: {
              anchors: [
                { anchor: [450, 100], left: [450, 100], right: [450, 100] },
                { anchor: [520, 160], left: [520, 160], right: [520, 160] },
              ],
              subpathStarts: [0],
            },
          },
        },
      });
      expect(moved.applied).toBe(true);
      // The stale box — the reason intersection reads every path.
      const [item] = await h.host.document.elementGeometry([POLY]);
      expect(item.bounds).toEqual([400, 100, 600, 400]);
      const atNewPlace: [number, number][] = [
        [470, 110],
        [500, 110],
        [500, 150],
        [470, 150],
      ];
      expect(await lassoIds(atNewPlace, "intersect")).toEqual(["upoly"]);
    });

    it("a TRANSFORMED element is tested where it is drawn: its outline goes through its item transform", async () => {
      const out = await h.host.document.mutate({
        op: "setElementProperty",
        args: {
          elementId: RECT,
          path: "frameTransform",
          value: { type: "transform", value: [1, 0, 0, 1, 300, 400] },
        },
      });
      expect(out.applied).toBe(true);
      // The rectangle now spans 400..600 × 500..700: a lasso over its
      // translated top edge selects it; one over its untransformed edge
      // does not.
      const overNewEdge: [number, number][] = [
        [480, 490],
        [520, 490],
        [520, 510],
        [480, 510],
      ];
      const overOldEdge: [number, number][] = [
        [180, 90],
        [220, 90],
        [220, 110],
        [180, 110],
      ];
      expect(await lassoIds(overNewEdge, "intersect")).toEqual(["urect"]);
      expect(await lassoIds(overOldEdge, "intersect")).toEqual([]);
    });

    it("the loop around the polygon + line selects the same two under BOTH rules", async () => {
      const big: [number, number][] = [
        [50, 350],
        [450, 350],
        [450, 720],
        [50, 720],
      ];
      expect(await lassoIds(big, "intersect")).toEqual(["uline", "upoly"]);
      expect(await lassoIds(big, "centre")).toEqual(["uline", "upoly"]);
    });

    it("what it costs: intersection reads each PATH-bearing leaf once; centre mode reads no path at all", async () => {
      const big: [number, number][] = [
        [50, 350],
        [450, 350],
        [450, 720],
        [50, 720],
      ];
      const inter = countingHost(h.host);
      await lassoIds(big, "intersect", inter.host);
      expect(inter.work.count("document.tree")).toBe(1);
      expect(inter.work.count("document.elementGeometry")).toBe(1);
      // F1 is three path-bearing leaves (rectangle, polygon, line).
      expect(inter.work.count("document.pathAnchors")).toBe(3);
      const centre = countingHost(h.host);
      await lassoIds(big, "centre", centre.host);
      expect(centre.work.count("document.pathAnchors")).toBe(0);
      expect(centre.work.count("document.elementGeometry")).toBe(1);
    });
  });

  describe("the pure intersection core", () => {
    it("an OPEN outline is not closed for the test; a CLOSED one is", () => {
      // A U: open, its mouth faces down; a lasso in the mouth touches
      // the closed U's closing segment only.
      const read = {
        id: { kind: "polygon", id: "u" },
        anchors: [
          { anchor: [0, 10], left: [0, 10], right: [0, 10] },
          { anchor: [0, 0], left: [0, 0], right: [0, 0] },
          { anchor: [10, 0], left: [10, 0], right: [10, 0] },
          { anchor: [10, 10], left: [10, 10], right: [10, 10] },
        ],
        subpathStarts: [0],
        subpathOpen: [true],
      } as never;
      const inMouth: [number, number][] = [
        [3, 8],
        [7, 8],
        [7, 12],
        [3, 12],
      ];
      expect(lassoTouchesOutline(outlineOfPath(read)!, inMouth)).toBe(false);
      const closed = { ...(read as object), subpathOpen: [false] } as never;
      expect(lassoTouchesOutline(outlineOfPath(closed)!, inMouth)).toBe(true);
    });

    it("an item with no path outline falls back to its transformed bounds", () => {
      const items = [
        {
          id: { kind: "oval", id: "o" },
          pageId: "usp",
          bounds: [0, 0, 10, 10],
          itemTransform: [1, 0, 0, 1, 100, 100],
        },
      ] as never;
      const ring: [number, number][] = [
        [105, 95],
        [115, 95],
        [115, 105],
        [105, 105],
      ];
      expect(lassoIntersections(items, new Map(), ring).map((e) => e.id)).toEqual(["o"]);
      expect(
        lassoIntersections(items, new Map(), [
          [5, -5],
          [15, -5],
          [15, 5],
        ]),
      ).toEqual([]);
    });
  });

  describe("the mode option", () => {
    it("is declared on the tool, intersection first (the displayed default)", () => {
      expect(LASSO_OPTIONS.toolId).toBe("media.paged.draw.tool.lassoSelect");
      const mode = LASSO_OPTIONS.fields[0];
      expect(mode.kind).toBe("select");
      expect(mode.kind === "select" && mode.options.map((o) => o.value)).toEqual([
        "intersect",
        "centre",
      ]);
    });
  });

  describe("v0 regression lane (F1, as shipped)", () => {
    let h: HeadlessHost;

    beforeAll(async () => {
      h = await openHost();
      await h.load(F1_MULTI_SHAPE.bytes());
      h.loadBundle(drawBundle);
    });
    afterAll(() => h?.dispose());

    it("a click / short drag (< 3 points) leaves the selection alone", async () => {
      await h.host.selection.set([{ kind: "rectangle", id: "urect" } as never]);
      const handler = createLassoSelectHandler(h.host);
      handler.onActivate(undefined as never);
      handler.onPointerDown(pointer(F1_MULTI_SHAPE.pageId, [500, 50]));
      handler.onPointerUp(pointer(F1_MULTI_SHAPE.pageId, [500, 50]));
      await new Promise((r) => setTimeout(r, 100));
      expect(h.host.selection.get().map((e) => e.id)).toEqual(["urect"]);
      handler.onDeactivate("switch");
    });
  });
});
