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

// Phase 9 (Tier B) conformance — Shape Builder (the gesture-driven
// pathfinderBoolean tool). Asserts:
//   (1) the EXACT `pathfinderBoolean` wire shape `shapeBuilderMutationFor`
//       emits per mode (unite = union, alt = subtract; first swept =
//       kept), and the fewer-than-two-operands no-op (null);
//   (2) the live GESTURE HANDLER, driven with synthetic pointer events
//       that sweep two overlapping polygons (F4), commits ONE
//       pathfinderBoolean at the REAL engine — the consumed element
//       leaves the tree and undo restores it (the same round-trip the
//       Pathfinder commands prove, reached through the drag gesture).
//
// The handler hit-tests the engine along the drag (async, fire-and-
// forget) and feeds the resolved element ids to the pure machine; the
// pointer-up commits. We poll for the landed mutation (the host-handler
// fire-and-forget idiom).

import { describe, expect, it, beforeAll, afterAll } from "vitest";

import type {
  CanvasPointerEvent,
  ElementId,
  Mutation,
} from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";

import {
  drawBundle,
  createShapeBuilderHandler,
  shapeBuilderMutationFor,
  pathfinderKindFor,
} from "../../src";
import { F4_OVERLAP } from "../fixtures/corpus";
import { openHost } from "./host";

const A = { kind: "polygon", id: F4_OVERLAP.ids.polygon! } as ElementId; // ua
const B = { kind: "polygon", id: F4_OVERLAP.secondId } as ElementId; // ub

function pointer(
  pageId: string,
  point: [number, number],
  alt = false,
  button = 0,
): CanvasPointerEvent {
  return {
    pageId,
    pagePoint: point,
    docPoint: point,
    modifiers: { shift: false, alt, cmd: false, ctrl: false },
    maxDelta: 0,
    button,
    target: null,
    pressure: 0.5,
    tiltX: 0,
    tiltY: 0,
    pointerType: "mouse",
  };
}

async function leafCount(h: HeadlessHost): Promise<number> {
  const roots = await h.host.document.tree();
  let n = 0;
  const walk = (nodes: { id?: unknown; children?: unknown[] }[]) => {
    for (const node of nodes) {
      if (node.id) n++;
      if (node.children) walk(node.children as never);
    }
  };
  walk(roots as never);
  return n;
}

async function until(predicate: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 80; i++) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 3));
  }
  throw new Error("timed out waiting for the shape-builder mutation to land");
}

describe("draw conformance — Shape Builder (Phase 9 Tier B)", () => {
  describe("shapeBuilderMutationFor — the exact wire shape", () => {
    it("unite mode → pathfinderBoolean union, first swept = kept", () => {
      const m = shapeBuilderMutationFor([A, B], "unite") as Extract<
        Mutation,
        { op: "pathfinderBoolean" }
      >;
      expect(m).toEqual({
        op: "pathfinderBoolean",
        args: { kept: A, others: [B], kind: "union" },
      });
    });

    it("subtract mode → pathfinderBoolean subtract (kept minus the rest)", () => {
      const m = shapeBuilderMutationFor([A, B], "subtract") as Extract<
        Mutation,
        { op: "pathfinderBoolean" }
      >;
      expect(m).toEqual({
        op: "pathfinderBoolean",
        args: { kept: A, others: [B], kind: "subtract" },
      });
    });

    it("maps mode → wire kind", () => {
      expect(pathfinderKindFor("unite")).toBe("union");
      expect(pathfinderKindFor("subtract")).toBe("subtract");
    });

    it("fewer than two swept operands is a no-op (null)", () => {
      expect(shapeBuilderMutationFor([], "unite")).toBeNull();
      expect(shapeBuilderMutationFor([A], "unite")).toBeNull();
    });
  });

  describe("the live gesture handler drives a real pathfinderBoolean (F4)", () => {
    let h: HeadlessHost;

    beforeAll(async () => {
      h = await openHost();
      await h.load(F4_OVERLAP.bytes());
      h.loadBundle(drawBundle);
    });
    afterAll(() => h?.dispose());

    it("a drag across both overlapping polygons unites them; undo restores", async () => {
      const handler = createShapeBuilderHandler(h.host);
      handler.onActivate(undefined as never);
      const before = await leafCount(h);

      // Drag from inside ua (150,150) through the overlap (250,250) into
      // ub (350,350) — the hit-test sweeps both elements.
      handler.onPointerDown(pointer(F4_OVERLAP.pageId, [150, 150]));
      handler.onPointerMove(pointer(F4_OVERLAP.pageId, [250, 250]));
      handler.onPointerMove(pointer(F4_OVERLAP.pageId, [350, 350]));
      // Give the async sweeps a few ticks to resolve both elements.
      await new Promise((r) => setTimeout(r, 30));
      handler.onPointerUp(pointer(F4_OVERLAP.pageId, [350, 350]));

      // The boolean lands: one element consumed.
      await until(async () => (await leafCount(h)) === before - 1);
      expect(await leafCount(h)).toBe(before - 1);
      // The kept (first swept) element survives with a path table.
      const sel = h.host.selection.get();
      expect(sel).toHaveLength(1);
      expect(await h.host.document.pathAnchors(sel[0])).not.toBeNull();

      await h.host.document.undo();
      expect(await leafCount(h)).toBe(before);
      // Both operands intact again.
      expect(await h.host.document.pathAnchors(A)).not.toBeNull();
      expect(await h.host.document.pathAnchors(B)).not.toBeNull();
    });

    it("an Alt-drag across both shapes commits a SUBTRACT", async () => {
      const handler = createShapeBuilderHandler(h.host);
      handler.onActivate(undefined as never);
      const before = await leafCount(h);

      handler.onPointerDown(pointer(F4_OVERLAP.pageId, [150, 150], true));
      handler.onPointerMove(pointer(F4_OVERLAP.pageId, [250, 250], true));
      handler.onPointerMove(pointer(F4_OVERLAP.pageId, [350, 350], true));
      await new Promise((r) => setTimeout(r, 30));
      handler.onPointerUp(pointer(F4_OVERLAP.pageId, [350, 350], true));

      await until(async () => (await leafCount(h)) === before - 1);
      expect(await leafCount(h)).toBe(before - 1);
      await h.host.document.undo();
      expect(await leafCount(h)).toBe(before);
    });

    it("a drag that sweeps only one shape is a no-op (no throw, tree intact)", async () => {
      const handler = createShapeBuilderHandler(h.host);
      handler.onActivate(undefined as never);
      const before = await leafCount(h);

      // Stay inside ua only (110..190) — never reaches ub.
      handler.onPointerDown(pointer(F4_OVERLAP.pageId, [120, 120]));
      handler.onPointerMove(pointer(F4_OVERLAP.pageId, [150, 150]));
      await new Promise((r) => setTimeout(r, 20));
      handler.onPointerUp(pointer(F4_OVERLAP.pageId, [180, 180]));
      // Let any (absent) mutation attempt settle.
      await new Promise((r) => setTimeout(r, 20));
      expect(await leafCount(h)).toBe(before);
    });
  });
});
