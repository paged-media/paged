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

// SCISSORS AT ANY POINT through the REAL engine wasm. Pins what the two
// ops do together, on the engine's own terms:
//   (1) a CLOSED path clicked mid-segment OPENS there: the cut point is
//       both endpoints, every original edge is still drawn;
//   (2) an OPEN path clicked mid-segment splits into TWO open contours of
//       the same element meeting at the cut;
//   (3) the curve does not move — the cut point is ON it and the rest of
//       the curve is traced exactly as before;
//   (4) ONE mutation, ONE undo step, and undo restores the table exactly;
//   (5) a click ON an anchor is the host Scissors' cut (no insert); an
//       open endpoint is not a cut; a rotated path is cut where the click
//       landed on the page;
//   (6) the live tool: a click cuts, a drag does not.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { ElementId, PathAnchorsResult } from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";
import { evalCubic } from "@paged-media/draw-geometry";

import {
  applyScissorsAt,
  createScissorsHandler,
  drawBundle,
  CUT_TOOL_IDS,
  type ScissorsResult,
} from "../../src";
import { packageWithSpread, pathItem } from "../fixtures/build-idml";
import { poly, squareItem, PAGE_ID } from "../panels/panel-document";
import { countingHost } from "../perf/counting-host";
import { pointerAt, settle } from "../perf/pointer-stream";
import { openHost } from "./host";

const SQ = poly("sq");
const CURVE = poly("curve");

/** sq: closed 100 pt square at (100, 100). curve: an OPEN two-segment
 *  path, the first segment a real cubic. */
const DOC = () =>
  packageWithSpread(
    squareItem("sq", 100, 100, 100) +
      pathItem("Polygon", "curve", "250 100 330 400", true, [
        { a: [100, 300], r: [140, 250] },
        { a: [300, 300], l: [260, 250], r: [330, 320] },
        { a: [400, 330] },
      ]),
  );

const tableOf = async (h: HeadlessHost, id: ElementId): Promise<PathAnchorsResult> =>
  (await h.host.document.pathAnchors(id))!;

describe("draw conformance — Scissors at any point", () => {
  let h: HeadlessHost;

  beforeAll(async () => {
    h = await openHost();
    h.loadBundle(drawBundle);
  });
  afterAll(() => h?.dispose());
  beforeEach(async () => {
    await h.load(DOC());
    await h.host.selection.set([]);
  });

  it("is a keyless tool in the host's Scissors flyout", () => {
    const tool = h.toolsContributed().find((t) => t.id === CUT_TOOL_IDS[1]);
    expect(tool).toBeDefined();
    expect(tool!.group).toBe("scissors");
    expect(tool!.shortcut).toBeUndefined();
  });

  it("a CLOSED square clicked mid-edge OPENS there: the cut point is both ends, every edge kept", async () => {
    const before = await tableOf(h, SQ);
    const done = await applyScissorsAt(h.host, SQ, PAGE_ID, [140, 100.5]);
    expect(done?.plan.kind).toBe("segment");
    const after = await tableOf(h, SQ);
    expect(after.subpathOpen).toEqual([true]);
    // 4 corners + the inserted anchor + its coincident twin.
    expect(after.anchors).toHaveLength(6);
    const first = after.anchors[0]!.anchor;
    const last = after.anchors[after.anchors.length - 1]!.anchor;
    expect(first[0]).toBeCloseTo(140, 3);
    expect(first[1]).toBeCloseTo(100, 6);
    expect(last).toEqual(first);
    // Every original corner is still on the path.
    for (const c of before.anchors) {
      expect(after.anchors.some((a) => a.anchor[0] === c.anchor[0] && a.anchor[1] === c.anchor[1])).toBe(true);
    }
  });

  it("an OPEN path clicked mid-segment splits into TWO open contours meeting at the cut", async () => {
    const at = evalCubic([100, 300], [140, 250], [260, 250], [300, 300], 0.5);
    const done = await applyScissorsAt(h.host, CURVE, PAGE_ID, [at[0], at[1]]);
    expect(done?.plan.kind).toBe("segment");
    const after = await tableOf(h, CURVE);
    expect(after.subpathStarts).toHaveLength(2);
    expect(after.subpathOpen).toEqual([true, true]);
    const split = after.subpathStarts[1]!;
    const endOfFirst = after.anchors[split - 1]!.anchor;
    const startOfSecond = after.anchors[split]!.anchor;
    expect(endOfFirst).toEqual(startOfSecond);
    expect(endOfFirst[0]).toBeCloseTo(at[0], 1);
    expect(endOfFirst[1]).toBeCloseTo(at[1], 1);
  });

  it("the CURVE does not move: the two halves trace the original cubic", async () => {
    const t = 0.3;
    const at = evalCubic([100, 300], [140, 250], [260, 250], [300, 300], t);
    await applyScissorsAt(h.host, CURVE, PAGE_ID, [at[0], at[1]]);
    const after = await tableOf(h, CURVE);
    const a = after.anchors;
    // First half: anchor 0 → the cut anchor; second half: the twin → old anchor 1.
    for (const u of [0.25, 0.5, 0.75]) {
      // The first half covers t ∈ [0, t*] of the original.
      const half = evalCubic(a[0]!.anchor, a[0]!.right, a[1]!.left, a[1]!.anchor, u);
      const orig = evalCubic([100, 300], [140, 250], [260, 250], [300, 300], u * t);
      expect(half[0]).toBeCloseTo(orig[0], 1);
      expect(half[1]).toBeCloseTo(orig[1], 1);
    }
  });

  it("ONE mutation, ONE undo step — and undo restores the table exactly", async () => {
    const before = await tableOf(h, SQ);
    const { host, work } = countingHost(h.host);
    await applyScissorsAt(host, SQ, PAGE_ID, [200, 160]);
    expect(work.mutations).toEqual([{ op: "batch", ops: 4 }]);
    await h.host.document.undo();
    const restored = await tableOf(h, SQ);
    expect(restored.anchors).toEqual(before.anchors);
    expect(restored.subpathOpen ?? []).toEqual(before.subpathOpen ?? []);
  });

  it("the CLOSING edge of a closed contour cuts like any other", async () => {
    await applyScissorsAt(h.host, SQ, PAGE_ID, [100.4, 130]);
    const after = await tableOf(h, SQ);
    expect(after.subpathOpen).toEqual([true]);
    expect(after.anchors[0]!.anchor[0]).toBeCloseTo(100, 6);
    expect(after.anchors[0]!.anchor[1]).toBeCloseTo(130, 2);
  });

  it("a click ON an anchor is the host Scissors' cut: no insert, just pathOpenAt", async () => {
    const { host, work } = countingHost(h.host);
    const done = await applyScissorsAt(host, SQ, PAGE_ID, [200.5, 100.5]);
    expect(done?.plan).toEqual({ kind: "anchor", index: 1 });
    expect(work.mutations).toEqual([{ op: "batch", ops: 1 }]);
    const after = await tableOf(h, SQ);
    expect(after.anchors).toHaveLength(5);
    expect(after.anchors[0]!.anchor).toEqual([200, 100]);
  });

  it("an OPEN path's ENDPOINT is not a cut, and nothing is written", async () => {
    const { host, work } = countingHost(h.host);
    expect(await applyScissorsAt(host, CURVE, PAGE_ID, [100, 300])).toBeNull();
    expect(work.mutations).toEqual([]);
  });

  it("a ROTATED square is cut where the click landed ON THE PAGE", async () => {
    const r = Math.PI / 4;
    const c = Math.cos(r);
    const s = Math.sin(r);
    const m: [number, number, number, number, number, number] = [
      c,
      s,
      -s,
      c,
      150 - (c * 150 - s * 150),
      150 - (s * 150 + c * 150),
    ];
    await h.host.document.mutate({
      op: "setElementProperty",
      args: { elementId: SQ, path: "frameTransform", value: { type: "transform", value: m } },
    });
    // The inner top edge's midpoint (150, 100) is on the page at m·p.
    const page: [number, number] = [m[0] * 150 + m[2] * 100 + m[4], m[1] * 150 + m[3] * 100 + m[5]];
    const done = await applyScissorsAt(h.host, SQ, PAGE_ID, page);
    expect(done?.plan.kind).toBe("segment");
    const after = await tableOf(h, SQ);
    expect(after.anchors[0]!.anchor[0]).toBeCloseTo(150, 2);
    expect(after.anchors[0]!.anchor[1]).toBeCloseTo(100, 2);
  });

  describe("the live tool", () => {
    it("a click on an edge cuts it; a DRAG does not", async () => {
      let done: ScissorsResult | null | undefined;
      const handler = createScissorsHandler(h.host, { onCut: (r) => (done = r) });
      handler.onActivate(undefined as never);
      const drag = { ...pointerAt(PAGE_ID, [150, 100]), maxDelta: 40 };
      handler.onPointerUp(drag);
      await settle();
      expect(done).toBeUndefined();
      handler.onPointerUp(pointerAt(PAGE_ID, [150, 100]));
      await settle();
      expect(done?.target).toEqual(SQ);
      expect((await tableOf(h, SQ)).subpathOpen).toEqual([true]);
    });
  });
});
