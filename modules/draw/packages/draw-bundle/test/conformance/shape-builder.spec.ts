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

// Shape Builder conformance. TWO lanes:
//
//   · REGION (B-22, engine v57) — the real Illustrator interaction:
//     hover resolves + highlights the face under the cursor, a drag
//     collects the faces it crosses, release commits ONE
//     `pathfinderFaces` (keep) / Alt-release commits `remove`. Driven
//     here with synthetic pointer events against the REAL engine.
//   · ELEMENT (the documented fallback) — what shipped as the honest
//     B-22 subset and what still runs on an engine without the region
//     ops, or when the selection carries fewer than two path operands.
//
// The original Phase 9 (Tier B) assertions for the element lane:
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
  shapeBuilderFacesMutationFor,
  faceToPageSpace,
  pathfinderKindFor,
  type PlanarFaceWire,
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

// ---------------------------------------------------------------------
// B-22 — the REGION lane.

const OVERLAP_FACE = "0-1#0"; // the middle face of F4's arrangement
const UA_ONLY = "1#0";

async function until2(
  predicate: () => Promise<boolean>,
  what: string,
): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 3));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("draw conformance — Shape Builder REGION lane (B-22)", () => {
  describe("shapeBuilderFacesMutationFor — the exact wire shape", () => {
    it("a plain drag KEEPS the collected faces", () => {
      expect(
        shapeBuilderFacesMutationFor([B, A], [OVERLAP_FACE], "keep"),
      ).toEqual({
        op: "pathfinderFaces",
        args: {
          elementIds: [B, A],
          faces: [OVERLAP_FACE],
          mode: "keep",
        },
      } as unknown as Mutation);
    });

    it("an Alt-drag REMOVES them", () => {
      expect(
        shapeBuilderFacesMutationFor([B, A], [OVERLAP_FACE, UA_ONLY], "remove"),
      ).toEqual({
        op: "pathfinderFaces",
        args: {
          elementIds: [B, A],
          faces: [OVERLAP_FACE, UA_ONLY],
          mode: "remove",
        },
      } as unknown as Mutation);
    });

    it("no faces crossed, or fewer than two inputs, is the honest no-op (null)", () => {
      expect(shapeBuilderFacesMutationFor([B, A], [], "keep")).toBeNull();
      expect(
        shapeBuilderFacesMutationFor([B], [OVERLAP_FACE], "keep"),
      ).toBeNull();
    });
  });

  describe("faceToPageSpace — the raw↔page mapping the highlight rides", () => {
    const face: PlanarFaceWire = {
      id: OVERLAP_FACE,
      signature: [0, 1],
      anchors: [
        { anchor: [0, 0], left: [0, 0], right: [0, 0] },
        { anchor: [10, 0], left: [10, 0], right: [10, 0] },
        { anchor: [10, 10], left: [10, 10], right: [10, 10] },
      ],
      subpathStarts: [0],
      area: 50,
      inside: [5, 2],
    };

    it("an identity (or absent) transform leaves the outline untouched", () => {
      const mapped = faceToPageSpace(face, null);
      expect(mapped.id).toBe(OVERLAP_FACE);
      expect(mapped.anchors.map((a) => a.anchor)).toEqual([
        [0, 0],
        [10, 0],
        [10, 10],
      ]);
      expect(mapped.subpathStarts).toEqual([0]);
    });

    it("a translate/scale itemTransform maps every anchor AND its handles", () => {
      const mapped = faceToPageSpace(face, [2, 0, 0, 2, 100, 50]);
      expect(mapped.anchors.map((a) => a.anchor)).toEqual([
        [100, 50],
        [120, 50],
        [120, 70],
      ]);
      expect(mapped.anchors[1].left).toEqual([120, 50]);
    });
  });

  describe("the live handler drives a real pathfinderFaces (F4, real engine)", () => {
    let h: HeadlessHost;

    beforeAll(async () => {
      h = await openHost();
      await h.load(F4_OVERLAP.bytes());
      h.loadBundle(drawBundle);
    });
    afterAll(() => h?.dispose());

    /** The tool operates on the SELECTION (Illustrator's rule). */
    const arm = async () => {
      await h.host.selection.set([A, B]);
      const handler = createShapeBuilderHandler(h.host);
      handler.onActivate(undefined as never);
      // Let the op probe + the selection→scene-tree ordering settle.
      await new Promise((r) => setTimeout(r, 30));
      return handler;
    };

    it("hovering the overlap HIGHLIGHTS that face through the overlay tool-preview", async () => {
      const handler = await arm();
      handler.onPointerMove(pointer(F4_OVERLAP.pageId, [250, 250]));
      await until2(async () => {
        const p = h.lastToolPreview();
        return p !== null && "anchors" in p;
      }, "the face highlight");
      const preview = h.lastToolPreview() as unknown as {
        pageId: string;
        anchors: ReadonlyArray<{ anchor: [number, number] }>;
        close?: boolean;
      };
      expect(preview.pageId).toBe(F4_OVERLAP.pageId);
      expect(preview.close).toBe(true);
      // The highlighted outline IS the overlap square (page space).
      const xs = preview.anchors.map((a) => a.anchor[0]);
      const ys = preview.anchors.map((a) => a.anchor[1]);
      expect([
        Math.round(Math.min(...xs)),
        Math.round(Math.min(...ys)),
        Math.round(Math.max(...xs)),
        Math.round(Math.max(...ys)),
      ]).toEqual([200, 200, 300, 300]);
      handler.onDeactivate("switch");
    });

    it("a drag across the overlap commits pathfinderFaces KEEP; one undo restores both inputs", async () => {
      const handler = await arm();
      const before = await leafCount(h);

      handler.onPointerDown(pointer(F4_OVERLAP.pageId, [250, 250]));
      handler.onPointerMove(pointer(F4_OVERLAP.pageId, [260, 260]));
      await new Promise((r) => setTimeout(r, 30));
      handler.onPointerUp(pointer(F4_OVERLAP.pageId, [270, 270]));

      await until2(
        async () => (await leafCount(h)) === before - 1,
        "the keep commit",
      );
      // One survivor, clipped to the overlap — the region result, not a
      // whole-element union.
      const roots = await h.host.document.tree();
      const survivors: ElementId[] = [];
      const walk = (nodes: { id?: unknown; children?: unknown[] }[]) => {
        for (const n of nodes) {
          if (n.id) survivors.push(n.id as ElementId);
          if (n.children) walk(n.children as never);
        }
      };
      walk(roots as never);
      expect(survivors).toHaveLength(1);
      const table = await h.host.document.pathAnchors(survivors[0]);
      const xs = table!.anchors.map((a) => a.anchor[0]);
      expect([
        Math.round(Math.min(...xs)),
        Math.round(Math.max(...xs)),
      ]).toEqual([200, 300]);

      await h.host.document.undo();
      expect(await leafCount(h)).toBe(before);
      expect(await h.host.document.pathAnchors(A)).not.toBeNull();
      expect(await h.host.document.pathAnchors(B)).not.toBeNull();
      handler.onDeactivate("switch");
    });

    it("an Alt-drag across the overlap commits REMOVE — everything but that face", async () => {
      const handler = await arm();
      const before = await leafCount(h);

      handler.onPointerDown(pointer(F4_OVERLAP.pageId, [250, 250], true));
      handler.onPointerMove(pointer(F4_OVERLAP.pageId, [260, 260], true));
      await new Promise((r) => setTimeout(r, 30));
      handler.onPointerUp(pointer(F4_OVERLAP.pageId, [270, 270], true));

      await until2(
        async () => (await leafCount(h)) === before - 1,
        "the remove commit",
      );
      const roots = await h.host.document.tree();
      const survivors: ElementId[] = [];
      const walk = (nodes: { id?: unknown; children?: unknown[] }[]) => {
        for (const n of nodes) {
          if (n.id) survivors.push(n.id as ElementId);
          if (n.children) walk(n.children as never);
        }
      };
      walk(roots as never);
      const table = await h.host.document.pathAnchors(survivors[0]);
      // The union minus the overlap: twelve vertices spanning both.
      expect(table!.anchors).toHaveLength(12);
      await h.host.document.undo();
      expect(await leafCount(h)).toBe(before);
      handler.onDeactivate("switch");
    });

    it("a drag over the two DISJOINT faces keeps both (one compound result)", async () => {
      const handler = await arm();
      const before = await leafCount(h);

      // ua-only → ub-only, deliberately skipping the overlap sample.
      handler.onPointerDown(pointer(F4_OVERLAP.pageId, [150, 150]));
      await new Promise((r) => setTimeout(r, 20));
      handler.onPointerMove(pointer(F4_OVERLAP.pageId, [370, 370]));
      await new Promise((r) => setTimeout(r, 20));
      handler.onPointerUp(pointer(F4_OVERLAP.pageId, [370, 370]));

      await until2(
        async () => (await leafCount(h)) === before - 1,
        "the two-face commit",
      );
      // The REGION result, not an element union: the two L-shaped
      // remainders unite into a 12-vertex outline. An element-lane
      // pathfinderBoolean over the same drag would have produced the
      // 8-vertex FULL union (overlap included).
      const roots2 = await h.host.document.tree();
      const left: ElementId[] = [];
      const walk2 = (nodes: { id?: unknown; children?: unknown[] }[]) => {
        for (const n of nodes) {
          if (n.id) left.push(n.id as ElementId);
          if (n.children) walk2(n.children as never);
        }
      };
      walk2(roots2 as never);
      expect(
        (await h.host.document.pathAnchors(left[0]))!.anchors,
      ).toHaveLength(12);
      await h.host.document.undo();
      expect(await leafCount(h)).toBe(before);
      handler.onDeactivate("switch");
    });

    it("a gesture over empty space is a no-op — nothing committed, nothing thrown", async () => {
      const handler = await arm();
      const before = await leafCount(h);
      handler.onPointerDown(pointer(F4_OVERLAP.pageId, [20, 20]));
      handler.onPointerMove(pointer(F4_OVERLAP.pageId, [40, 40]));
      await new Promise((r) => setTimeout(r, 30));
      handler.onPointerUp(pointer(F4_OVERLAP.pageId, [60, 60]));
      await new Promise((r) => setTimeout(r, 40));
      expect(await leafCount(h)).toBe(before);
      handler.onDeactivate("switch");
    });

    it("with NOTHING selected the region lane cannot run and the ELEMENT fallback takes the gesture", async () => {
      await h.host.selection.set([]);
      const handler = createShapeBuilderHandler(h.host);
      handler.onActivate(undefined as never);
      await new Promise((r) => setTimeout(r, 20));
      const before = await leafCount(h);

      handler.onPointerDown(pointer(F4_OVERLAP.pageId, [150, 150]));
      handler.onPointerMove(pointer(F4_OVERLAP.pageId, [250, 250]));
      handler.onPointerMove(pointer(F4_OVERLAP.pageId, [350, 350]));
      await new Promise((r) => setTimeout(r, 40));
      handler.onPointerUp(pointer(F4_OVERLAP.pageId, [350, 350]));

      // The element lane's pathfinderBoolean: one operand consumed.
      await until2(
        async () => (await leafCount(h)) === before - 1,
        "the element-lane fallback commit",
      );
      // A single element survives and the SELECTION points at it (the
      // element lane's contract, unlike the region lane's clear).
      expect(h.host.selection.get()).toHaveLength(1);
      await h.host.document.undo();
      expect(await leafCount(h)).toBe(before);
      handler.onDeactivate("switch");
    });
  });
});
