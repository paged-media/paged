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

// Brush tools v0 conformance — the sweep composition proven through the
// REAL engine wasm: (1) the exact outlineStrokeVariable wire shape the
// commit emits, (2) the LIVE paintbrush handler authoring a FILLED
// CLOSED swept shape end-to-end (fill from the creation defaults,
// defaults restored after), (3) the blob brush UNITING with a same-fill
// selected element (and standing alone when nothing matches), (4) the
// eraser SUBTRACTING a uniform band from each selected path element
// with no transient sweep left behind, and a no-op without a selection.
//
// The commits are multi-mutation flows (defaults → insert → outline →
// restore [→ boolean]) — several undo steps by design (documented in
// handlers/brush.ts), so these specs assert forward outcomes rather
// than undo round-trips.

import { describe, expect, it, beforeAll, afterAll } from "vitest";

import type {
  CanvasPointerEvent,
  ElementId,
  Mutation,
} from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";

import {
  drawBundle,
  createPaintbrushHandler,
  createBlobBrushHandler,
  createEraserBrushHandler,
  outlineStrokeVariableMutationFor,
  FALLBACK_FILL_REF,
} from "../../src";
import { F1_MULTI_SHAPE, F4_OVERLAP } from "../fixtures/corpus";
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

/** The brush commits are longer mutation chains than the pencil's —
 *  poll with a larger budget than the freehand spec's helper. */
async function until(predicate: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 250; i++) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 4));
  }
  throw new Error("timed out waiting for the brush commit to land");
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

async function fillRefOf(
  h: HeadlessHost,
  id: ElementId,
): Promise<string | null | undefined> {
  const props = await h.host.document.elementProperties(id);
  for (const entry of props?.entries ?? []) {
    if (entry.path === "frameFillColor" && entry.value?.type === "colorRef") {
      return entry.value.value;
    }
  }
  return undefined;
}

/** Drive a full sweep gesture through a handler (down → moves → up). */
function sweep(
  handler: ReturnType<typeof createPaintbrushHandler>,
  pageId: string,
  points: [number, number][],
): void {
  handler.onActivate(undefined as never);
  handler.onPointerDown(pointer(pageId, points[0]));
  for (const p of points.slice(1)) handler.onPointerMove(pointer(pageId, p, 20));
  handler.onPointerUp(pointer(pageId, points[points.length - 1], 20));
}

describe("draw conformance — brush tools v0", () => {
  it("outlineStrokeVariableMutationFor emits the exact setElementProperty wire shape", () => {
    const id = { kind: "polygon", id: "u1" } as ElementId;
    const m = outlineStrokeVariableMutationFor(id, [2, 4, 6]) as Extract<
      Mutation,
      { op: "setElementProperty" }
    >;
    expect(m).toEqual({
      op: "setElementProperty",
      args: {
        elementId: id,
        path: "outlineStrokeVariable",
        value: {
          type: "outlineStrokeVariable",
          value: { widths: [2, 4, 6], cap: "round", join: "round", miterLimit: 4 },
        },
      },
    });
  });

  describe("paintbrush (live handler, F1)", () => {
    let h: HeadlessHost;

    beforeAll(async () => {
      h = await openHost();
      await h.load(F1_MULTI_SHAPE.bytes());
      h.loadBundle(drawBundle);
    });
    afterAll(() => h?.dispose());

    it("an L sweep lands as a FILLED CLOSED swept shape; creation defaults restored", async () => {
      const meta0 = await h.host.document.meta();
      const before = await leafCount(h);
      const handler = createPaintbrushHandler(h.host);
      handler.onActivate(undefined as never);
      handler.onPointerDown(pointer(F1_MULTI_SHAPE.pageId, [450, 80]));
      handler.onPointerMove(pointer(F1_MULTI_SHAPE.pageId, [480, 80], 30));
      // The in-flight stroke previews as a POLYLINE (honest — the sweep
      // happens at commit).
      expect(h.lastToolPreview()).not.toBeNull();
      handler.onPointerMove(pointer(F1_MULTI_SHAPE.pageId, [510, 80], 60));
      handler.onPointerMove(pointer(F1_MULTI_SHAPE.pageId, [510, 130], 110));
      handler.onPointerUp(pointer(F1_MULTI_SHAPE.pageId, [510, 130], 110));

      await until(async () => (await leafCount(h)) === before + 1);
      // Commit clears the preview and selects the swept shape.
      expect(h.lastToolPreview()).toBeNull();
      await until(async () => h.host.selection.get().length === 1);
      const created = h.host.selection.get()[0];

      // The element is the OUTLINE now: a CLOSED contour (the filled
      // swept shape), no longer the 3-anchor open centerline.
      const table = await h.host.document.pathAnchors(created);
      expect(table).not.toBeNull();
      expect(table!.subpathOpen?.[0]).toBe(false);
      expect(table!.anchors.length).toBeGreaterThanOrEqual(4);

      // Fill flowed through the creation defaults (with the Black
      // fallback when the document declares none — F1's case).
      expect(await fillRefOf(h, created)).toBe(
        meta0.defaultFillColor ?? FALLBACK_FILL_REF,
      );

      // The document's creation defaults are RESTORED after the sweep.
      const meta1 = await h.host.document.meta();
      expect(meta1.defaultFillColor ?? null).toBe(meta0.defaultFillColor ?? null);
      expect(meta1.defaultStrokeColor ?? null).toBe(
        meta0.defaultStrokeColor ?? null,
      );
      handler.onDeactivate("switch");
    });
  });

  describe("blob brush (F4 overlap pair)", () => {
    let h: HeadlessHost;
    const UA = { kind: "polygon", id: F4_OVERLAP.ids.polygon! } as ElementId;

    beforeAll(async () => {
      h = await openHost();
      await h.load(F4_OVERLAP.bytes());
      h.loadBundle(drawBundle);
    });
    afterAll(() => h?.dispose());

    it("a sweep UNITES with the selected same-fill element (kept = the selection)", async () => {
      const before = await leafCount(h);
      const tableBefore = await h.host.document.pathAnchors(UA);
      await h.host.selection.set([UA]);

      // The sweep sticks out past ua's left edge (x < 100), so the
      // union genuinely grows the kept element.
      sweep(createBlobBrushHandler(h.host), F4_OVERLAP.pageId, [
        [40, 150],
        [120, 150],
        [200, 150],
        [280, 150],
      ]);

      // Net zero: the sweep inserted (+1) then was consumed by the
      // unite (−1) and ua's contour GREW. Poll on the anchor change —
      // leaf count + selection alone also describe the pre-sweep state
      // (ua was already selected), so they can't be the settle signal.
      await until(async () => {
        if ((await leafCount(h)) !== before) return false;
        const t = await h.host.document.pathAnchors(UA);
        return !!t && t.anchors.length !== tableBefore!.anchors.length;
      });
      const sel = h.host.selection.get();
      expect(sel).toHaveLength(1);
      expect(sel[0].id).toBe(UA.id);
    });

    it("with no same-fill selected element the sweep stands alone (the paintbrush outcome)", async () => {
      await h.host.selection.set([]);
      const before = await leafCount(h);
      sweep(createBlobBrushHandler(h.host), F4_OVERLAP.pageId, [
        [420, 60],
        [460, 60],
        [500, 60],
      ]);
      await until(async () => (await leafCount(h)) === before + 1);
      await until(async () => h.host.selection.get().length === 1);
      const created = h.host.selection.get()[0];
      expect(created.id).not.toBe(UA.id);
      const table = await h.host.document.pathAnchors(created);
      expect(table!.subpathOpen?.[0]).toBe(false);
    });
  });

  describe("eraser brush (F4 overlap pair)", () => {
    let h: HeadlessHost;
    const UA = { kind: "polygon", id: F4_OVERLAP.ids.polygon! } as ElementId;
    const UB = { kind: "polygon", id: F4_OVERLAP.secondId } as ElementId;

    beforeAll(async () => {
      h = await openHost();
      await h.load(F4_OVERLAP.bytes());
      h.loadBundle(drawBundle);
    });
    afterAll(() => h?.dispose());

    it("a sweep SUBTRACTS from EACH selected path element; no transient sweep survives", async () => {
      await h.host.selection.set([UA, UB]);
      const before = await leafCount(h);
      const uaBefore = (await h.host.document.pathAnchors(UA))!.anchors.length;
      const ubBefore = (await h.host.document.pathAnchors(UB))!.anchors.length;

      // A horizontal band at y=250 crosses BOTH quads (ua x∈100..300,
      // ub x∈200..400) and both get a bite; every per-target sweep copy
      // is consumed by its subtract.
      sweep(createEraserBrushHandler(h.host), F4_OVERLAP.pageId, [
        [50, 250],
        [150, 250],
        [250, 250],
        [350, 250],
        [450, 250],
      ]);

      await until(async () => {
        if ((await leafCount(h)) !== before) return false;
        const ua = await h.host.document.pathAnchors(UA);
        const ub = await h.host.document.pathAnchors(UB);
        return (
          !!ua &&
          !!ub &&
          ua.anchors.length !== uaBefore &&
          ub.anchors.length !== ubBefore
        );
      });
      // A full crossing band bites anchors INTO each quad (a clean
      // crossing splits it into two subpaths — either way the contour
      // grew past the original 4 corners).
      const ua = await h.host.document.pathAnchors(UA);
      expect(ua!.anchors.length).toBeGreaterThan(uaBefore);
      // The targets stayed selected (the eraser never re-selects).
      expect(h.host.selection.get().map((s) => s.id).sort()).toEqual(
        [UA.id, UB.id].sort(),
      );
    });

    it("with nothing selected the eraser is a NO-OP (no stray shape)", async () => {
      await h.host.selection.set([]);
      const before = await leafCount(h);
      sweep(createEraserBrushHandler(h.host), F4_OVERLAP.pageId, [
        [50, 500],
        [150, 500],
        [250, 500],
      ]);
      // Give the (would-be) async commit ample time, then assert nothing
      // changed.
      await new Promise((r) => setTimeout(r, 100));
      expect(await leafCount(h)).toBe(before);
    });
  });
});
