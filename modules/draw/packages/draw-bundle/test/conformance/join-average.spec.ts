// Phase 4c conformance — Join / Average over open-path endpoints (the
// pathPointSet consumers; the TRUE join/close is a NAMED engine-op gap
// — see src/commands/join-average.ts). Asserts (1) the pure planners'
// shapes, (2) the exact batch wire sequence the commands emit, and
// (3) the moves applied at the REAL engine (handles ride along —
// the apply layer drags both handles with the anchor) with undo
// round-trips, driven through the recorded command handlers.

import { describe, expect, it, beforeAll, afterAll } from "vitest";

import type {
  CommandContribution,
  ElementId,
  Mutation,
} from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";
import type { AnchorTable } from "@paged-media/draw-geometry";

import {
  drawBundle,
  planAverageEndpoints,
  planJoinEndpoints,
  endpointMovesMutationFor,
  JOIN_COMMAND_ID,
  AVERAGE_COMMAND_ID,
} from "../../src";
import { F1_MULTI_SHAPE } from "../fixtures/corpus";
import { liveTable } from "../replay";
import { openHost } from "./host";

const POLY = { kind: "polygon", id: F1_MULTI_SHAPE.ids.polygon! } as ElementId;
const LINE = {
  kind: "graphicLine",
  id: F1_MULTI_SHAPE.ids.graphicLine!,
} as ElementId;
const RECT = { kind: "rectangle", id: F1_MULTI_SHAPE.ids.rectangle! } as ElementId;

const openTable = (anchors: [number, number][]): AnchorTable => ({
  anchors: anchors.map((a) => ({ anchor: a, left: a, right: a })),
  subpathStarts: [0],
  subpathOpen: [true],
});

function commandFor(h: HeadlessHost, id: string): CommandContribution {
  const rec = h.contributions.find((c) => c.kind === "command" && c.id === id);
  if (!rec) throw new Error(`no command recorded for ${id}`);
  return rec.value as CommandContribution;
}

describe("draw conformance — join/average endpoints (Phase 4c)", () => {
  describe("the pure planners", () => {
    it("average of ONE open path moves both endpoints to their midpoint", () => {
      const moves = planAverageEndpoints([
        openTable([
          [0, 0],
          [50, 80],
          [100, 40],
        ]),
      ]);
      expect(moves).toEqual([
        { table: 0, index: 0, position: [50, 20] },
        { table: 0, index: 2, position: [50, 20] },
      ]);
    });

    it("join of ONE open path moves the LAST endpoint onto the FIRST (coincide subset)", () => {
      const moves = planJoinEndpoints([
        openTable([
          [0, 0],
          [50, 80],
          [100, 40],
        ]),
      ]);
      expect(moves).toEqual([{ table: 0, index: 2, position: [0, 0] }]);
    });

    it("across TWO open paths the CLOSEST endpoint pair operates", () => {
      const a = openTable([
        [0, 0],
        [100, 0],
      ]);
      const b = openTable([
        [104, 2],
        [300, 300],
      ]);
      // Closest pair: a[1]=(100,0) ↔ b[0]=(104,2).
      expect(planAverageEndpoints([a, b])).toEqual([
        { table: 0, index: 1, position: [102, 1] },
        { table: 1, index: 0, position: [102, 1] },
      ]);
      expect(planJoinEndpoints([a, b])).toEqual([
        { table: 1, index: 0, position: [100, 0] },
      ]);
    });

    it("closed / compound / oversized selections plan null (the honest no-op)", () => {
      const closed: AnchorTable = {
        ...openTable([
          [0, 0],
          [10, 0],
          [10, 10],
        ]),
        subpathOpen: [false],
      };
      expect(planAverageEndpoints([closed])).toBeNull();
      const compound: AnchorTable = {
        anchors: openTable([
          [0, 0],
          [10, 0],
          [20, 0],
          [30, 0],
        ]).anchors,
        subpathStarts: [0, 2],
        subpathOpen: [true, true],
      };
      expect(planJoinEndpoints([compound])).toBeNull();
      const t = openTable([
        [0, 0],
        [10, 0],
      ]);
      expect(planAverageEndpoints([t, t, t])).toBeNull();
    });

    it("already-coincident endpoints make join a no-op plan", () => {
      const a = openTable([
        [0, 0],
        [100, 0],
      ]);
      const b = openTable([
        [100, 0],
        [300, 300],
      ]);
      expect(planJoinEndpoints([a, b])).toBeNull();
    });
  });

  it("endpointMovesMutationFor emits ONE batch of pathPointSet{role:'anchor'} ops", () => {
    const m = endpointMovesMutationFor(
      [POLY, LINE],
      [
        { table: 0, index: 2, position: [10, 20] },
        { table: 1, index: 0, position: [10, 20] },
      ],
    ) as Extract<Mutation, { op: "batch" }>;
    expect(m).toEqual({
      op: "batch",
      args: {
        ops: [
          {
            op: "pathPointSet",
            args: { elementId: POLY, index: 2, role: "anchor", position: [10, 20] },
          },
          {
            op: "pathPointSet",
            args: { elementId: LINE, index: 0, role: "anchor", position: [10, 20] },
          },
        ],
      },
    });
  });

  describe("against the real engine (recorded handlers, undo round-trips)", () => {
    let h: HeadlessHost;
    const polyRef = { kind: "polygon", id: F1_MULTI_SHAPE.ids.polygon! };
    const lineRef = { kind: "graphicLine", id: F1_MULTI_SHAPE.ids.graphicLine! };

    beforeAll(async () => {
      h = await openHost();
      await h.load(F1_MULTI_SHAPE.bytes());
      h.loadBundle(drawBundle);
    });
    afterAll(() => h?.dispose());

    it("Average on the open polygon lands both endpoints at the midpoint; undo restores", async () => {
      const before = await liveTable(h.host, polyRef);
      const first = before.anchors[0].anchor;
      const last = before.anchors[before.anchors.length - 1].anchor;
      const mid: [number, number] = [
        (first[0] + last[0]) / 2,
        (first[1] + last[1]) / 2,
      ];
      await h.host.selection.set([POLY]);
      await commandFor(h, AVERAGE_COMMAND_ID).handler(undefined);
      const after = await liveTable(h.host, polyRef);
      expect(after.anchors[0].anchor).toEqual(mid);
      expect(after.anchors[after.anchors.length - 1].anchor).toEqual(mid);
      // One batch = ONE undo step restores both endpoints.
      await h.host.document.undo();
      const restored = await liveTable(h.host, polyRef);
      expect(restored.anchors).toEqual(before.anchors);
    });

    it("Join across polygon + line welds the closest endpoint pair (second onto first); undo restores", async () => {
      const beforePoly = await liveTable(h.host, polyRef);
      const beforeLine = await liveTable(h.host, lineRef);
      await h.host.selection.set([POLY, LINE]);
      await commandFor(h, JOIN_COMMAND_ID).handler(undefined);
      const afterPoly = await liveTable(h.host, polyRef);
      const afterLine = await liveTable(h.host, lineRef);
      // The polygon (first selected) is untouched; ONE line endpoint
      // now coincides with a polygon endpoint.
      expect(afterPoly.anchors).toEqual(beforePoly.anchors);
      const polyEnds = [
        afterPoly.anchors[0].anchor,
        afterPoly.anchors[afterPoly.anchors.length - 1].anchor,
      ];
      const lineEnds = [
        afterLine.anchors[0].anchor,
        afterLine.anchors[afterLine.anchors.length - 1].anchor,
      ];
      const welded = lineEnds.some((le) =>
        polyEnds.some((pe) => pe[0] === le[0] && pe[1] === le[1]),
      );
      expect(welded).toBe(true);
      await h.host.document.undo();
      expect((await liveTable(h.host, lineRef)).anchors).toEqual(
        beforeLine.anchors,
      );
    });

    it("a selection without an anchor table no-ops (rectangle is bounds-based — B-13 finding b)", async () => {
      const before = await liveTable(h.host, polyRef);
      await h.host.selection.set([RECT, POLY]);
      await expect(
        commandFor(h, JOIN_COMMAND_ID).handler(undefined),
      ).resolves.toBeUndefined();
      expect((await liveTable(h.host, polyRef)).anchors).toEqual(
        before.anchors,
      );
    });
  });
});
