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
// elementGeometry read (no hitTest grid sampling); membership is the
// CENTERS-inside rule (handlers/lasso.ts documents the honest v0
// semantics). F1's leaf centers: rectangle (200, 200), polygon
// (250, 500), line (250, 675).

import { describe, expect, it, beforeAll, afterAll } from "vitest";

import type { CanvasPointerEvent } from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";

import { drawBundle, createLassoSelectHandler, lassoMatches } from "../../src";
import { F1_MULTI_SHAPE } from "../fixtures/corpus";
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
