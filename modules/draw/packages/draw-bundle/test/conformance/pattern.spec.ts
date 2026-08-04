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

// PATTERNS v0 — the DESTRUCTIVE step-and-repeat BAKE, through the REAL
// engine wasm the harness boots (protocol 57). Pins:
//   (1) the fixed v0 plan: 3 × 3 tiles minus cell (0,0), step = the
//       selection bounds + 6 pt, and the exact `insertPath` /
//       paint / `setPluginMetadata` / `createGroup` wire shapes;
//   (2) the document SHAPE a bake produces — one group holding the
//       source and its eight copies, each copy carrying the source's
//       paint and a `patternTile` marker, the source carrying the
//       `pattern` record that says `destructive: true`;
//   (3) the REAL undo count (RFI C-15): TWO batches ⇒ 2 undo steps;
//   (4) a COMPOUND source tiles WITH ITS HOLE — the copies are inserted
//       contour by contour and re-merged through the same `framePath`
//       door Make Compound Path uses;
//   (5) the honest scope: nothing selected, and the fact this is a bake
//       (editing the source afterwards leaves the tiles alone).

import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";

import type {
  CommandContribution,
  ElementId,
  Mutation,
} from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";

import {
  drawBundle,
  applyMakeCompoundPath,
  applyMakePattern,
  bindPatternCopies,
  compoundSourceOf,
  contourCountOf,
  offsetTable,
  patternBakeOf,
  patternCopiesFor,
  patternFinishBatchFor,
  patternInsertBatchFor,
  patternPlanFor,
  patternTileOf,
  patternTilesFor,
  selectionTileSize,
  withPatternBake,
  MAKE_PATTERN_COMMAND_ID,
  PATTERN_COLUMNS,
  PATTERN_ROWS,
  PATTERN_SPACING_PT,
  type PatternPlan,
} from "../../src";
import { F6_RING_PAIR } from "../fixtures/corpus";
import { openHost } from "./host";

const poly = (id: string): ElementId => ({ kind: "polygon", id }) as ElementId;

const OUTER = poly(F6_RING_PAIR.ids.polygon!);
const INNER = poly(F6_RING_PAIR.innerId);

function commandFor(h: HeadlessHost, id: string): CommandContribution {
  const rec = h.contributions.find((c) => c.kind === "command" && c.id === id);
  if (!rec) throw new Error(`no command recorded for ${id}`);
  return rec.value as CommandContribution;
}

async function leafIds(h: HeadlessHost): Promise<string[]> {
  const out: string[] = [];
  const walk = (nodes: { id?: { id?: unknown }; children?: unknown[] }[]) => {
    for (const node of nodes) {
      const children = (node.children ?? []) as never[];
      if (children.length > 0) walk(children);
      else if (node.id && typeof node.id.id === "string") out.push(node.id.id);
    }
  };
  walk((await h.host.document.tree()) as never);
  return out.sort();
}

/** The one group node in the tree (or null) plus its member ids. */
async function groupShape(
  h: HeadlessHost,
): Promise<{ id: string; members: string[] } | null> {
  let found: { id: string; members: string[] } | null = null;
  const walk = (
    nodes: { id?: { kind?: string; id?: unknown }; children?: unknown[] }[],
  ) => {
    for (const node of nodes) {
      if (node.id?.kind === "group" && typeof node.id.id === "string") {
        found = {
          id: node.id.id,
          members: ((node.children ?? []) as { id?: { id?: unknown } }[])
            .map((c) => c.id?.id)
            .filter((id): id is string => typeof id === "string"),
        };
        return;
      }
      if (node.children) walk(node.children as never);
    }
  };
  walk((await h.host.document.tree()) as never);
  return found;
}

async function readProp(
  h: HeadlessHost,
  id: ElementId,
  path: string,
): Promise<unknown> {
  const props = await h.host.document.elementProperties(id);
  for (const e of props?.entries ?? []) {
    if (e.path === path) return e.value;
  }
  return undefined;
}

const anchorAt = (p: [number, number]) => ({
  anchor: [p[0], p[1]] as [number, number],
  left: [p[0], p[1]] as [number, number],
  right: [p[0], p[1]] as [number, number],
});

/** A hand-built plan (one square source, one tile) — the pure builders
 *  are asserted against this, not against the engine. */
const SQUARE: PatternPlan = {
  pageId: "usp",
  step: [110, 110],
  sources: [
    {
      id: poly("us"),
      table: {
        anchors: [
          anchorAt([0, 0]),
          anchorAt([100, 0]),
          anchorAt([100, 100]),
          anchorAt([0, 100]),
        ],
        subpathStarts: [0],
        subpathOpen: [false],
      },
      paint: { fill: "Color/Black", stroke: null, weight: null },
    },
  ],
  tiles: [{ col: 1, row: 0, offset: [110, 0] }],
};

describe("draw conformance — PATTERNS v0 (a destructive step-and-repeat BAKE)", () => {
  describe("the fixed v0 plan", () => {
    it("tiles a columns × rows grid MINUS cell (0,0) — the selection itself", () => {
      const tiles = patternTilesFor(3, 3, [10, 20]);
      expect(tiles).toHaveLength(8);
      expect(tiles.some((t) => t.col === 0 && t.row === 0)).toBe(false);
      expect(tiles[0]).toEqual({ col: 1, row: 0, offset: [10, 0] });
      expect(tiles[7]).toEqual({ col: 2, row: 2, offset: [20, 40] });
      // The shipped v0 constants.
      expect([PATTERN_COLUMNS, PATTERN_ROWS, PATTERN_SPACING_PT]).toEqual([
        3, 3, 6,
      ]);
      expect(patternTilesFor(PATTERN_COLUMNS, PATTERN_ROWS, [1, 1])).toHaveLength(
        8,
      );
    });

    it("offsetTable translates every control point, boundaries preserved", () => {
      const moved = offsetTable(SQUARE.sources[0].table, 5, -5);
      expect(moved.anchors[0]).toEqual(anchorAt([5, -5]));
      expect(moved.anchors[2]).toEqual(anchorAt([105, 95]));
      expect(moved.subpathStarts).toEqual([0]);
    });

    it("patternCopiesFor counts a COMPOUND source's contours per copy", () => {
      const ring: PatternPlan = {
        ...SQUARE,
        sources: [
          {
            ...SQUARE.sources[0],
            table: {
              anchors: [
                ...SQUARE.sources[0].table.anchors,
                anchorAt([20, 20]),
                anchorAt([80, 20]),
                anchorAt([80, 80]),
                anchorAt([20, 80]),
              ],
              subpathStarts: [0, 4],
              subpathOpen: [false, false],
            },
          },
        ],
      };
      expect(patternCopiesFor(ring)).toEqual([
        { tile: ring.tiles[0], sourceIndex: 0, contours: 2 },
      ]);
      expect(patternCopiesFor(SQUARE)[0].contours).toBe(1);
    });
  });

  describe("the wire shapes", () => {
    it("batch 1 is one insertPath per copy per contour, offset applied", () => {
      const batch = patternInsertBatchFor(SQUARE) as Extract<
        Mutation,
        { op: "batch" }
      >;
      expect(batch.op).toBe("batch");
      expect(batch.args.ops).toHaveLength(1);
      expect(batch.args.ops[0]).toEqual({
        op: "insertPath",
        args: {
          pageId: "usp",
          anchors: [
            anchorAt([110, 0]),
            anchorAt([210, 0]),
            anchorAt([210, 100]),
            anchorAt([110, 100]),
          ],
          open: false,
        },
      });
    });

    it("bindPatternCopies chunks the minted ids back onto their copies", () => {
      expect(bindPatternCopies(SQUARE, [poly("u1")])).toEqual([
        { copy: patternCopiesFor(SQUARE)[0], keep: poly("u1"), absorb: [] },
      ]);
      // A count mismatch is a REFUSAL, never a guess.
      expect(bindPatternCopies(SQUARE, [])).toBeNull();
      expect(bindPatternCopies(SQUARE, [poly("u1"), poly("u2")])).toBeNull();
    });

    it("batch 2 paints, marks, records and groups — in that order", () => {
      const bindings = bindPatternCopies(SQUARE, [poly("u1")])!;
      const record = {
        step: [110, 110] as [number, number],
        spacing: 6,
        columns: 3,
        rows: 3,
        sources: ["us"],
        copies: ["u1"],
        destructive: true as const,
      };
      const batch = patternFinishBatchFor({
        plan: SQUARE,
        bindings,
        record,
        sourceEnvelopes: [null],
      }) as Extract<Mutation, { op: "batch" }>;
      const ops = batch.args.ops;
      // fill, stroke, tile marker, source record, group — no weight op
      // (the source carries none).
      expect(ops).toHaveLength(5);
      expect(ops[0]).toEqual({
        op: "setElementProperty",
        args: {
          elementId: poly("u1"),
          path: "frameFillColor",
          value: { type: "colorRef", value: "Color/Black" },
        },
      });
      expect((ops[2] as { op: string }).op).toBe("setPluginMetadata");
      expect(
        patternTileOf(
          JSON.parse(
            (ops[2] as { args: { value: string } }).args.value,
          ) as never,
        ),
      ).toEqual({ of: poly("us"), col: 1, row: 0 });
      expect(
        patternBakeOf(
          JSON.parse(
            (ops[3] as { args: { value: string } }).args.value,
          ) as never,
        ),
      ).toEqual(record);
      expect(ops[4]).toEqual({
        op: "createGroup",
        args: { memberIds: [poly("us"), poly("u1")] },
      });
    });

    it("a COMPOUND copy is re-merged through framePath, extras deleted", () => {
      const ring: PatternPlan = {
        ...SQUARE,
        sources: [
          {
            ...SQUARE.sources[0],
            table: {
              anchors: [
                ...SQUARE.sources[0].table.anchors,
                anchorAt([20, 20]),
                anchorAt([80, 20]),
                anchorAt([80, 80]),
                anchorAt([20, 80]),
              ],
              subpathStarts: [0, 4],
              subpathOpen: [false, false],
            },
          },
        ],
      };
      const bindings = bindPatternCopies(ring, [poly("u1"), poly("u2")])!;
      expect(bindings[0]).toEqual({
        copy: patternCopiesFor(ring)[0],
        keep: poly("u1"),
        absorb: [poly("u2")],
      });
      const ops = (
        patternFinishBatchFor({
          plan: ring,
          bindings,
          record: {
            step: [110, 110],
            spacing: 6,
            columns: 3,
            rows: 3,
            sources: ["us"],
            copies: ["u1"],
            destructive: true,
          },
          sourceEnvelopes: [null],
        }) as Extract<Mutation, { op: "batch" }>
      ).args.ops;
      expect((ops[0] as { args: { path: string } }).args.path).toBe("framePath");
      expect(
        (ops[0] as { args: { value: { value: { subpathStarts: number[] } } } })
          .args.value.value.subpathStarts,
      ).toEqual([0, 4]);
      expect(ops[1]).toEqual({
        op: "deleteFrame",
        args: { frameId: "u2" },
      });
    });

    it("withPatternBake / patternBakeOf round-trip, and reject junk", () => {
      const record = {
        step: [10, 20] as [number, number],
        spacing: 6,
        columns: 3,
        rows: 3,
        sources: ["a"],
        copies: ["b", "c"],
        destructive: true as const,
      };
      const env = withPatternBake({ v: 1, data: { keepMe: 1 } }, record);
      expect(env!.data.keepMe).toBe(1);
      expect(patternBakeOf(env)).toEqual(record);
      // Dropping the record preserves the other keys…
      expect(withPatternBake(env, null)!.data).toEqual({ keepMe: 1 });
      // …and an envelope with nothing left becomes null.
      expect(withPatternBake({ v: 1, data: {} }, null)).toBeNull();
      expect(patternBakeOf(null)).toBeNull();
      expect(patternBakeOf({ v: 1, data: { pattern: { step: "nope" } } })).toBeNull();
    });
  });

  describe("against the real engine (F6)", () => {
    let h: HeadlessHost;

    beforeAll(async () => {
      h = await openHost();
      await h.load(F6_RING_PAIR.bytes());
      h.loadBundle(drawBundle);
    });
    afterAll(() => h?.dispose());

    beforeEach(async () => {
      await h.host.selection.set([]);
    });

    it("the tile step is the SELECTION BOUNDS plus the v0 spacing", async () => {
      expect(await selectionTileSize(h.host, [INNER])).toEqual([100, 100]);
      await h.host.selection.set([INNER]);
      const plan = await patternPlanFor(h.host);
      expect(plan!.step).toEqual([106, 106]);
      expect(plan!.tiles).toHaveLength(8);
      expect(plan!.sources).toHaveLength(1);
      expect(plan!.pageId).toBe(F6_RING_PAIR.pageId);
    });

    it("BAKE inserts 8 copies, paints them and groups the field", async () => {
      const before = await leafIds(h);
      await h.host.selection.set([INNER]);
      const created = await applyMakePattern(h.host);
      expect(created).toHaveLength(8);

      // The group holds the source + its eight copies.
      const group = await groupShape(h);
      expect(group!.members).toHaveLength(9);
      expect(group!.members).toContain(F6_RING_PAIR.innerId);
      expect(await leafIds(h)).toHaveLength(before.length + 8);

      // Every copy carries the source's paint …
      expect(await readProp(h, created[0], "frameFillColor")).toEqual({
        type: "colorRef",
        value: "Color/Black",
      });
      // … and its cell marker.
      expect(patternTileOf(await h.host.document.getMetadata(created[0]))).toEqual(
        { of: INNER, col: 1, row: 0 },
      );
      // The last tile is (2,2) — row-major insertion order.
      expect(
        patternTileOf(await h.host.document.getMetadata(created[7])),
      ).toEqual({ of: INNER, col: 2, row: 2 });

      // The source carries the plan, and says out loud that it is a bake.
      const record = patternBakeOf(await h.host.document.getMetadata(INNER));
      expect(record!.step).toEqual([106, 106]);
      expect(record!.columns).toBe(3);
      expect(record!.destructive).toBe(true);
      expect(record!.copies).toHaveLength(8);

      // Tile (1,0) really is the source, moved one step right.
      const src = await compoundSourceOf(h.host, INNER);
      const tile = await compoundSourceOf(h.host, created[0]);
      expect(tile!.table.anchors[0].anchor).toEqual([
        src!.table.anchors[0].anchor[0] + 106,
        src!.table.anchors[0].anchor[1],
      ]);
    });

    it("UNDO — the bake is exactly TWO batches (C-15: assert, never claim)", async () => {
      // (continues from the bake above) Undo #1 unwinds the paint /
      // metadata / group batch; the eight inserted paths remain.
      const withTiles = await leafIds(h);
      await h.host.document.undo();
      expect(await groupShape(h)).toBeNull();
      expect(await leafIds(h)).toHaveLength(withTiles.length);
      expect(patternBakeOf(await h.host.document.getMetadata(INNER))).toBeNull();
      // Undo #2 unwinds the insert batch: back to the pre-bake document.
      await h.host.document.undo();
      expect(await leafIds(h)).toEqual(["uinner", "uopen", "uouter"]);
    });

    it("a COMPOUND source tiles WITH its hole (contours re-merged per copy)", async () => {
      // Build a SMALL ring at runtime: the F6 ring is 300 pt wide, and a
      // 3 × 3 grid of those runs off the 612 pt page (see the residual
      // this spec pins below). 100 pt keeps all nine tiles on the page.
      const before = new Set(await leafIds(h));
      const ins = await h.host.document.mutate({
        op: "batch",
        args: {
          ops: [
            {
              op: "insertPath",
              args: {
                pageId: F6_RING_PAIR.pageId,
                anchors: [
                  anchorAt([100, 500]),
                  anchorAt([200, 500]),
                  anchorAt([200, 600]),
                  anchorAt([100, 600]),
                ],
                open: false,
              },
            },
            {
              op: "insertPath",
              args: {
                pageId: F6_RING_PAIR.pageId,
                anchors: [
                  anchorAt([130, 530]),
                  anchorAt([170, 530]),
                  anchorAt([170, 570]),
                  anchorAt([130, 570]),
                ],
                open: false,
              },
            },
          ],
        },
      });
      expect(ins.applied).toBe(true);
      const [small, hole] = (await leafIds(h))
        .filter((id) => !before.has(id))
        .map(poly);

      await h.host.selection.set([small, hole]);
      expect(await applyMakeCompoundPath(h.host)).toBe(2);

      await h.host.selection.set([small]);
      const created = await applyMakePattern(h.host);
      expect(created).toHaveLength(8);
      // 8 copies × 2 contours were inserted and the finish batch merged
      // each pair back, so 8 elements survive — each still a ring.
      for (const id of created) {
        expect(contourCountOf((await compoundSourceOf(h.host, id))!.table)).toBe(2);
      }

      // Unwind: pattern (2) + make compound (1) + the setup insert (1).
      for (let i = 0; i < 4; i++) await h.host.document.undo();
      expect(await leafIds(h)).toEqual(["uinner", "uopen", "uouter"]);
    });

    it("RESIDUAL, pinned: a tile that lands OFF the page is created but unreadable", async () => {
      // The v0 grid is fixed, so a big selection can step past the page.
      // Those tiles exist in the tree, but `pathAnchors` /
      // `elementGeometry` answer nothing for them — an item outside every
      // page's bounds belongs to no page, and both doors are page-keyed.
      // Named here rather than worked around: the fix is a real tile
      // count / artboard-aware placement, which v0 does not have.
      await h.host.selection.set([OUTER]); // 300 pt wide ⇒ step 306
      const created = await applyMakePattern(h.host);
      expect(created).toHaveLength(8);
      const readable = [];
      for (const id of created) {
        if (await compoundSourceOf(h.host, id)) readable.push(id.id);
      }
      // Only the tiles still inside the 612 × 792 page answer.
      expect(readable).toHaveLength(3);
      // Every tile is nonetheless a real element in the tree.
      expect(await leafIds(h)).toHaveLength(3 + 8);

      for (let i = 0; i < 2; i++) await h.host.document.undo();
      expect(await leafIds(h)).toEqual(["uinner", "uopen", "uouter"]);
    });

    it("it is a BAKE: editing the source afterwards does NOT move the tiles", async () => {
      await h.host.selection.set([INNER]);
      const created = await applyMakePattern(h.host);
      const tileBefore = await compoundSourceOf(h.host, created[0]);

      // Drag one of the source's anchors somewhere else entirely.
      const moved = await h.host.document.mutate({
        op: "pathPointSet",
        args: { elementId: INNER, index: 0, role: "anchor", position: [0, 0] },
      });
      expect(moved.applied).toBe(true);
      const tileAfter = await compoundSourceOf(h.host, created[0]);
      expect(tileAfter!.table.anchors[0].anchor).toEqual(
        tileBefore!.table.anchors[0].anchor,
      );

      for (let i = 0; i < 3; i++) await h.host.document.undo();
      expect(await leafIds(h)).toEqual(["uinner", "uopen", "uouter"]);
    });

    it("nothing selected is a no-op", async () => {
      await h.host.selection.set([]);
      expect(await applyMakePattern(h.host)).toEqual([]);
      expect(await leafIds(h)).toEqual(["uinner", "uopen", "uouter"]);
      expect(await groupShape(h)).toBeNull();
    });

    it("the RECORDED command says BAKE in its title and drives the selection", async () => {
      const cmd = commandFor(h, MAKE_PATTERN_COMMAND_ID);
      expect(cmd.title).toContain("Bake");
      expect(cmd.title).toContain("not a live fill");
      expect(cmd.category).toBe("Pattern");

      await h.host.selection.set([INNER]);
      await cmd.handler({} as never, undefined as never);
      const group = await groupShape(h);
      expect(group).not.toBeNull();
      // The new group is selected (a page-item create echoes its id).
      expect(h.host.selection.get().map((s) => s.id)).toEqual([group!.id]);

      for (let i = 0; i < 2; i++) await h.host.document.undo();
      expect(await leafIds(h)).toEqual(["uinner", "uopen", "uouter"]);
    });
  });
});
