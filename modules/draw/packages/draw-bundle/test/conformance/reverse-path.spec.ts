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

// REVERSE PATH DIRECTION through the REAL engine wasm. Pins:
//   (1) the pure reversal — handles swap, an open contour reverses
//       outright, a closed one keeps its start anchor, every contour by
//       its OWN flag;
//   (2) what the engine STORES after the framePath write: exactly the
//       reversed table, in the element's own space, with the open flag
//       intact (the wire value carries no `subpathOpen` — the element's
//       own flag has to survive, and does);
//   (3) the visible consequence that matters — WINDING: a closed
//       contour's signed area flips, and a compound path's hole stays a
//       hole (its contours keep OPPOSITE windings);
//   (4) a second reversal is the identity, every selected path rides ONE
//       batch, and ONE undo restores.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type {
  CommandContribution,
  ElementId,
  PathAnchorsResult,
} from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";
import { contourSignedArea } from "@paged-media/draw-geometry";

import {
  drawBundle,
  applyMakeCompoundPath,
  applyReversePath,
  reversePathBatchFor,
  reversePathTableOf,
  reverseTable,
  REVERSE_PATH_COMMAND_ID,
} from "../../src";
import { F1_MULTI_SHAPE, F3_CURVED_OPEN, F6_RING_PAIR } from "../fixtures/corpus";
import { countingHost } from "../perf/counting-host";
import { openHost } from "./host";

const poly = (id: string): ElementId => ({ kind: "polygon", id }) as ElementId;

const CURVE = poly(F3_CURVED_OPEN.ids.polygon!);
const OUTER = poly(F6_RING_PAIR.ids.polygon!);
const INNER = poly(F6_RING_PAIR.innerId);
const OPEN = poly(F6_RING_PAIR.openId);

function commandFor(h: HeadlessHost, id: string): CommandContribution {
  const rec = h.contributions.find((c) => c.kind === "command" && c.id === id);
  if (!rec) throw new Error(`no command recorded for ${id}`);
  return rec.value as CommandContribution;
}

const shapeOf = (t: PathAnchorsResult | null) =>
  t && {
    anchors: t.anchors.map((a) => ({ anchor: a.anchor, left: a.left, right: a.right })),
    subpathStarts: t.subpathStarts,
    subpathOpen: t.subpathOpen,
  };

/** Each contour's signed area (sign = winding). */
function areasOf(t: PathAnchorsResult): number[] {
  const starts = t.subpathStarts.length > 0 ? t.subpathStarts : [0];
  return starts.map((from, i) =>
    contourSignedArea(t.anchors.slice(from, starts[i + 1] ?? t.anchors.length)),
  );
}

const A = (x: number, y: number, l?: [number, number], r?: [number, number]) => ({
  anchor: [x, y] as [number, number],
  left: l ?? ([x, y] as [number, number]),
  right: r ?? ([x, y] as [number, number]),
});

describe("draw conformance — reverse path direction", () => {
  describe("the pure reversal", () => {
    it("an OPEN contour reverses outright and every handle swaps sides", () => {
      const out = reverseTable({
        anchors: [A(0, 0, [-1, 0], [1, 0]), A(10, 0, [9, 1], [11, 1]), A(20, 5)],
        subpathStarts: [0],
        subpathOpen: [true],
      });
      expect(out.anchors).toEqual([A(20, 5), A(10, 0, [11, 1], [9, 1]), A(0, 0, [1, 0], [-1, 0])]);
      expect(out.subpathOpen).toEqual([true]);
    });

    it("a CLOSED contour keeps its first anchor first (the start point does not move)", () => {
      const out = reverseTable({
        anchors: [A(0, 0), A(10, 0), A(10, 10), A(0, 10)],
        subpathStarts: [0],
        subpathOpen: [false],
      });
      expect(out.anchors.map((a) => a.anchor)).toEqual([
        [0, 0],
        [0, 10],
        [10, 10],
        [10, 0],
      ]);
    });

    it("an ABSENT flag is closed (the renderer's default), and each contour of a compound uses its OWN flag", () => {
      const bare = reverseTable({
        anchors: [A(0, 0), A(1, 0), A(1, 1)],
        subpathStarts: [0],
      });
      expect(bare.anchors.map((a) => a.anchor)).toEqual([
        [0, 0],
        [1, 1],
        [1, 0],
      ]);
      expect(bare).not.toHaveProperty("subpathOpen");

      const mixed = reverseTable({
        anchors: [A(0, 0), A(1, 0), A(1, 1), A(5, 5), A(6, 5), A(7, 5)],
        subpathStarts: [0, 3],
        subpathOpen: [false, true],
      });
      expect(mixed.anchors.map((a) => a.anchor)).toEqual([
        [0, 0],
        [1, 1],
        [1, 0],
        [7, 5],
        [6, 5],
        [5, 5],
      ]);
      expect(mixed.subpathStarts).toEqual([0, 3]);
      expect(mixed.subpathOpen).toEqual([false, true]);
    });

    it("reversing twice is the identity", () => {
      const t = {
        anchors: [A(0, 0, [-1, 2], [1, -2]), A(10, 0, [9, 3], [11, -3]), A(5, 8, [3, 8], [7, 8])],
        subpathStarts: [0],
        subpathOpen: [false],
      };
      expect(reverseTable(reverseTable(t))).toEqual(t);
    });

    it("the batch is one framePath write per target, and nothing for nothing", () => {
      expect(reversePathBatchFor([])).toBeNull();
      const t = { anchors: [A(0, 0), A(1, 0)], subpathStarts: [0], subpathOpen: [true] };
      const b = reversePathBatchFor([
        [CURVE, t],
        [OUTER, t],
      ]) as { op: string; args: { ops: { op: string; args: { path: string } }[] } };
      expect(b.op).toBe("batch");
      expect(b.args.ops.map((o) => [o.op, o.args.path])).toEqual([
        ["setElementProperty", "framePath"],
        ["setElementProperty", "framePath"],
      ]);
    });
  });

  describe("an OPEN curved path (F3)", () => {
    let h: HeadlessHost;

    beforeAll(async () => {
      h = await openHost();
      h.loadBundle(drawBundle);
    });
    beforeEach(async () => {
      await h.load(F3_CURVED_OPEN.bytes());
    });
    afterAll(() => h?.dispose());

    it("the engine stores EXACTLY the reversed table, handles swapped, still OPEN; one undo restores", async () => {
      const before = (await h.host.document.pathAnchors(CURVE))!;
      expect(before.subpathOpen).toEqual([true]);
      await h.host.selection.set([CURVE]);
      const counted = countingHost(h.host);
      expect(await applyReversePath(counted.host)).toEqual([CURVE]);
      expect(counted.work.mutations).toEqual([{ op: "batch", ops: 1 }]);

      const after = (await h.host.document.pathAnchors(CURVE))!;
      expect(shapeOf(after)).toEqual(shapeOf({ ...before, ...reverseTable(reversePathTableOf(before)) } as PathAnchorsResult));
      // The endpoints swapped, and the curve's handles went with them.
      expect(after.anchors[0].anchor).toEqual(before.anchors[1].anchor);
      expect(after.anchors[0].right).toEqual(before.anchors[1].left);
      expect(after.anchors[1].left).toEqual(before.anchors[0].right);
      // The open flag SURVIVED a write whose value has no field for it.
      expect(after.subpathOpen).toEqual([true]);

      await h.host.document.undo();
      expect(shapeOf(await h.host.document.pathAnchors(CURVE))).toEqual(shapeOf(before));
    });

    it("the RECORDED command, run twice, is the identity", async () => {
      const before = await h.host.document.pathAnchors(CURVE);
      await h.host.selection.set([CURVE]);
      await commandFor(h, REVERSE_PATH_COMMAND_ID).handler(undefined);
      expect(shapeOf(await h.host.document.pathAnchors(CURVE))).not.toEqual(shapeOf(before));
      await commandFor(h, REVERSE_PATH_COMMAND_ID).handler(undefined);
      expect(shapeOf(await h.host.document.pathAnchors(CURVE))).toEqual(shapeOf(before));
    });

    it("a TRANSFORMED path reverses in its own space: the transform is untouched, the page-space curve is the same curve backwards", async () => {
      const out = await h.host.document.mutate({
        op: "setElementProperty",
        args: {
          elementId: CURVE,
          path: "frameTransform",
          value: { type: "transform", value: [0, 1, -1, 0, 500, 0] },
        },
      });
      expect(out.applied).toBe(true);
      const before = (await h.host.document.pathAnchors(CURVE))!;
      await h.host.selection.set([CURVE]);
      await applyReversePath(h.host);
      const after = (await h.host.document.pathAnchors(CURVE))!;
      expect(after.itemTransform).toEqual(before.itemTransform);
      expect(after.anchors.map((a) => a.anchor)).toEqual(
        [...before.anchors].reverse().map((a) => a.anchor),
      );
    });
  });

  describe("closed contours and a compound path (F6)", () => {
    let h: HeadlessHost;

    beforeAll(async () => {
      h = await openHost();
      h.loadBundle(drawBundle);
    });
    beforeEach(async () => {
      await h.load(F6_RING_PAIR.bytes());
    });
    afterAll(() => h?.dispose());

    it("a closed quad's WINDING flips, its start anchor stays, it stays closed", async () => {
      const before = (await h.host.document.pathAnchors(OUTER))!;
      await h.host.selection.set([OUTER]);
      await applyReversePath(h.host);
      const after = (await h.host.document.pathAnchors(OUTER))!;
      expect(Math.sign(areasOf(after)[0])).toBe(-Math.sign(areasOf(before)[0]));
      expect(Math.abs(areasOf(after)[0])).toBeCloseTo(Math.abs(areasOf(before)[0]), 6);
      expect(after.anchors[0].anchor).toEqual(before.anchors[0].anchor);
      expect(after.subpathOpen?.[0] ?? false).toBe(false);
    });

    it("a COMPOUND path: both contours flip, so the hole is STILL a hole (opposite windings)", async () => {
      await h.host.selection.set([OUTER, INNER]);
      expect(await applyMakeCompoundPath(h.host)).toBe(2);
      const ring = (await h.host.document.pathAnchors(OUTER))!;
      expect(ring.subpathStarts).toEqual([0, 4]);
      const [outer, inner] = areasOf(ring);
      expect(Math.sign(outer)).toBe(-Math.sign(inner));

      await h.host.selection.set([OUTER]);
      await applyReversePath(h.host);
      const reversed = (await h.host.document.pathAnchors(OUTER))!;
      expect(reversed.subpathStarts).toEqual([0, 4]);
      const [outer2, inner2] = areasOf(reversed);
      expect(Math.sign(outer2)).toBe(-Math.sign(outer));
      expect(Math.sign(inner2)).toBe(-Math.sign(inner));
      expect(Math.sign(outer2)).toBe(-Math.sign(inner2));
    });

    it("SEVERAL selected paths — closed and open — reverse in ONE batch, and ONE undo restores all of them", async () => {
      const ids = [OUTER, INNER, OPEN];
      const before = await Promise.all(ids.map((id) => h.host.document.pathAnchors(id)));
      await h.host.selection.set(ids);
      const counted = countingHost(h.host);
      expect(await applyReversePath(counted.host)).toEqual(ids);
      expect(counted.work.mutations).toEqual([{ op: "batch", ops: 3 }]);
      const after = await Promise.all(ids.map((id) => h.host.document.pathAnchors(id)));
      after.forEach((t, i) => expect(shapeOf(t)).not.toEqual(shapeOf(before[i])));
      expect(after[2]!.subpathOpen).toEqual([true]);

      await h.host.document.undo();
      const restored = await Promise.all(ids.map((id) => h.host.document.pathAnchors(id)));
      restored.forEach((t, i) => expect(shapeOf(t)).toEqual(shapeOf(before[i])));
    });
  });

  describe("no-ops (F1)", () => {
    let h: HeadlessHost;

    beforeAll(async () => {
      h = await openHost();
      await h.load(F1_MULTI_SHAPE.bytes());
      h.loadBundle(drawBundle);
    });
    afterAll(() => h?.dispose());

    it("nothing selected: no mutation, no throw", async () => {
      await h.host.selection.set([]);
      const counted = countingHost(h.host);
      expect(await applyReversePath(counted.host)).toEqual([]);
      expect(counted.work.mutations).toEqual([]);
    });

  });
});
