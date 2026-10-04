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

// PATTERN EDITING v1 — the re-editable tile FIELD, through the REAL
// engine wasm the harness boots (protocol 58). Pins, in order:
//   (1) the HARD BOUNDARY: this is not a pattern swatch and the module
//       says so in words the test owns (`PATTERN_SWATCH_NOTE`), because
//       there is no pattern paint type in IDML / the engine / the wire
//       (RFI C-31);
//   (2) the PARAMETERS v0 did not have — grid / brick / hex lattices,
//       tile size, spacing incl. NEGATIVE (overlap), copy counts,
//       dimming, and the overlap ORDER (which copy paints in front);
//   (3) the ARTBOARD-AWARE tile count that closes v0's residual — every
//       placed tile is READABLE, where v0's fixed grid left five of
//       eight unreadable (RFI C-23, still pinned via
//       `fitToArtboard: false`);
//   (4) RE-EDITABILITY: re-plan (new parameters + fresh source
//       geometry), release (keep the artwork), delete tiles (un-bake),
//       select tiles — none of which v0 had;
//   (5) the MEASURED undo counts (RFI C-15): make = 1, re-plan = 1,
//       release = 1, delete tiles = 1 — plus the batch-ORDERING rules
//       the engine enforces. Make and re-plan were 2 each until
//       `bindCreated` reached the contract; that two-batch lane is still
//       the FALLBACK, and every bake is run through both and through a
//       host that cannot say what a batch created — the same document
//       must come out of each;
//   (6) the honest refusals kept from v0: a text frame is skipped, a
//       source with no readable geometry is skipped, nothing selected
//       is a no-op.

import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";

import type {
  BundleHost,
  CommandContribution,
  ElementId,
  Mutation,
} from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";

import {
  drawBundle,
  applyDeletePatternTiles,
  applyEditPattern,
  applyMakeCompoundPath,
  applyMakePattern,
  applyReleasePattern,
  applySelectPatternTiles,
  bindPatternCopies,
  compoundSourceOf,
  contourCountOf,
  fitTilesToPage,
  findPatternField,
  mintPatternId,
  offsetTable,
  orderPatternTiles,
  parsePatternLibrary,
  patternCopiesFor,
  patternDeleteBatchFor,
  patternFinishBatchFor,
  patternInsertBatchFor,
  patternLinks,
  patternPageRect,
  patternParamsFrom,
  patternPlanFor,
  patternReleaseBatchFor,
  patternRowLabel,
  patternSourceOf,
  patternStepFor,
  patternTileOf,
  patternTilesFor,
  readPatternLibrary,
  removePatternFieldFrom,
  selectionBoundsOf,
  selectionTileSize,
  serializePatternLibrary,
  upsertPatternField,
  withPatternKey,
  writePatternLibrary,
  EDIT_PATTERN_COMMAND_ID,
  DELETE_PATTERN_TILES_COMMAND_ID,
  HEX_ROW_FACTOR,
  MAKE_PATTERN_COMMAND_ID,
  PATTERN_COLUMNS,
  PATTERN_COMMAND_IDS,
  PATTERN_DEFAULTS,
  PATTERN_LEGACY_FIELD,
  PATTERN_LIBRARY_VERSION,
  PATTERN_MAX_TILES,
  PATTERN_PANEL_NOTE,
  PATTERN_PART,
  PATTERN_ROWS,
  PATTERN_SPACING_PT,
  PATTERN_SWATCH_NOTE,
  RELEASE_PATTERN_COMMAND_ID,
  SELECT_PATTERN_TILES_COMMAND_ID,
  type PatternPlan,
} from "../../src";
import {
  patternBatchFor,
  patternHandle,
  patternHandleBindings,
} from "../../src/commands/pattern";
import { F6_RING_PAIR } from "../fixtures/corpus";
import { countingHost } from "../perf/counting-host";
import { openHost } from "./host";
import {
  NO_BIND_CREATED,
  refusingBindCreated,
  runThrough,
  type LaneName,
} from "./one-batch";

const poly = (id: string): ElementId => ({ kind: "polygon", id }) as ElementId;

const OUTER = poly(F6_RING_PAIR.ids.polygon!);
const INNER = poly(F6_RING_PAIR.innerId);
/** The pristine document's three leaves, SORTED (every assertion that
 *  uses this compares ids, not order — the order-sensitive ones read
 *  `leafIds` directly). */
const PRISTINE = ["uinner", "uopen", "uouter"];

function commandFor(h: HeadlessHost, id: string): CommandContribution {
  const rec = h.contributions.find((c) => c.kind === "command" && c.id === id);
  if (!rec) throw new Error(`no command recorded for ${id}`);
  return rec.value as CommandContribution;
}

/** Leaf ids in TREE order — insertion order == tree order, so this is
 *  also PAINT order (the appearance-bake finding). */
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
  return out;
}

const sortedLeafIds = async (h: HeadlessHost) => (await leafIds(h)).sort();

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

/** Undo until the document is pristine again — used only where the
 *  count is NOT what the test is about (the undo counts get their own
 *  exact assertions below). */
async function undoTo(h: HeadlessHost, steps: number): Promise<void> {
  for (let i = 0; i < steps; i++) await h.host.document.undo();
}

const anchorAt = (p: [number, number]) => ({
  anchor: [p[0], p[1]] as [number, number],
  left: [p[0], p[1]] as [number, number],
  right: [p[0], p[1]] as [number, number],
});

const SQUARE_TABLE = {
  anchors: [
    anchorAt([0, 0]),
    anchorAt([100, 0]),
    anchorAt([100, 100]),
    anchorAt([0, 100]),
  ],
  subpathStarts: [0],
  subpathOpen: [false],
};

/** A hand-built plan (one square source, one tile) — the pure builders
 *  are asserted against this, not against the engine. */
const SQUARE: PatternPlan = {
  pageId: "usp",
  field: "pat-1",
  params: PATTERN_DEFAULTS,
  step: [110, 110],
  bounds: { top: 0, left: 0, bottom: 100, right: 100 },
  sources: [
    {
      id: poly("us"),
      table: SQUARE_TABLE,
      paint: { fill: "Color/Black", stroke: null, weight: null },
    },
  ],
  tiles: [{ col: 1, row: 0, offset: [110, 0] }],
  dropped: [],
};

const RING: PatternPlan = {
  ...SQUARE,
  sources: [
    {
      ...SQUARE.sources[0],
      table: {
        anchors: [
          ...SQUARE_TABLE.anchors,
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

describe("draw conformance — PATTERN EDITING v1 (a re-editable tile FIELD, not a swatch)", () => {
  describe("the hard boundary (RFI C-31)", () => {
    it("the module says, in words this test owns, that a pattern SWATCH is not buildable", () => {
      expect(PATTERN_SWATCH_NOTE).toContain("THIS IS NOT A PATTERN SWATCH");
      // The three places the paint type is absent — named, because a
      // reader has to be able to check the claim.
      expect(PATTERN_SWATCH_NOTE).toContain("no pattern paint type in the format");
      expect(PATTERN_SWATCH_NOTE).toContain("Graphic model");
      expect(PATTERN_SWATCH_NOTE).toContain(
        "SwatchSpec and GradientSpec are the only two shapes",
      );
      expect(PATTERN_SWATCH_NOTE).toContain("would render nothing and lie on save");
      expect(PATTERN_SWATCH_NOTE).toContain("RFI C-31");
      // The panel repeats it AND adds the two limits its own form cannot
      // hide.
      expect(PATTERN_PANEL_NOTE).toContain("THIS IS NOT A PATTERN SWATCH");
      expect(PATTERN_PANEL_NOTE).toContain("always paint ABOVE the source");
      expect(PATTERN_PANEL_NOTE).toContain("real frameOpacity");
      // Baking and re-planning are ONE undo step each (measured below);
      // the note said TWO until it was corrected to match, and the
      // stepwise fallback's two is named as the older engine's.
      expect(PATTERN_PANEL_NOTE).toContain(
        "Baking, re-planning, releasing and deleting the tiles are ONE undo step each",
      );
      expect(PATTERN_PANEL_NOTE).toContain("an older engine that refuses the one batch");
      expect(PATTERN_PANEL_NOTE).not.toContain("TWO undo steps");
    });

    it("every command TITLE carries what the contract has no field to say", () => {
      expect(PATTERN_COMMAND_IDS).toEqual([
        "media.paged.draw.command.makePatternFromSelection",
        "media.paged.draw.command.editPatternField",
        "media.paged.draw.command.selectPatternTiles",
        "media.paged.draw.command.deletePatternTiles",
        "media.paged.draw.command.releasePatternField",
      ]);
    });
  });

  describe("the parameters (v0 had none)", () => {
    it("patternParamsFrom merges a loose payload over a base and clamps it", () => {
      expect(patternParamsFrom(undefined)).toEqual(PATTERN_DEFAULTS);
      // v0's fixed constants ARE v1's defaults.
      expect([
        PATTERN_DEFAULTS.columns,
        PATTERN_DEFAULTS.rows,
        PATTERN_DEFAULTS.spacing,
      ]).toEqual([PATTERN_COLUMNS, PATTERN_ROWS, [PATTERN_SPACING_PT, PATTERN_SPACING_PT]]);
      const p = patternParamsFrom({
        layout: "hex",
        spacing: -4,
        columns: 2.4,
        rows: "nope",
        dim: 250,
        offset: -3,
        overlap: { horizontal: "leftInFront" },
        fitToArtboard: false,
      });
      expect(p.layout).toBe("hex");
      // A scalar spacing means both axes; a NEGATIVE one is kept — that
      // is the geometric overlap.
      expect(p.spacing).toEqual([-4, -4]);
      expect(p.columns).toBe(2); // rounded
      expect(p.rows).toBe(PATTERN_DEFAULTS.rows); // junk falls back
      expect(p.dim).toBe(100); // clamped to 0..100
      expect(p.offset).toBe(0); // clamped to 0..1
      expect(p.overlap).toEqual({
        horizontal: "leftInFront",
        vertical: "bottomInFront", // the half not named keeps the base
      });
      expect(p.fitToArtboard).toBe(false);
      // An unknown layout is refused into the base rather than accepted.
      expect(patternParamsFrom({ layout: "spiral" }).layout).toBe("grid");
      // A zero/negative tile size means "use the selection bounds".
      expect(patternParamsFrom({ tile: [0, 10] }).tile).toBeNull();
      expect(patternParamsFrom({ tile: [40, 20] }).tile).toEqual([40, 20]);
    });

    it("the step is tile + spacing, and hex compresses the VERTICAL step", () => {
      const grid = patternParamsFrom({ spacing: [6, 6] });
      expect(patternStepFor(grid, [100, 50])).toEqual([106, 56]);
      // An explicit tile size overrides the selection bounds.
      expect(patternStepFor(patternParamsFrom({ tile: [40, 40] }), [100, 50])).toEqual(
        [46, 46],
      );
      // Negative spacing is a real overlap: the step is SHORTER than
      // the tile.
      expect(patternStepFor(patternParamsFrom({ spacing: -20 }), [100, 100])).toEqual([
        80, 80,
      ]);
      const hex = patternParamsFrom({ layout: "hex", spacing: [0, 0] });
      expect(patternStepFor(hex, [100, 100])).toEqual([100, 100 * HEX_ROW_FACTOR]);
      expect(HEX_ROW_FACTOR).toBeCloseTo(0.8660254, 6);
    });

    it("grid / brick / hex are three different lattices", () => {
      const of = (raw: unknown) => {
        const params = patternParamsFrom(raw);
        return patternTilesFor(params, patternStepFor(params, [100, 100]));
      };
      // GRID — a plain step-and-repeat, cell (0,0) omitted.
      const grid = of({ columns: 2, rows: 2, spacing: 0 });
      expect(grid.map((t) => t.offset)).toEqual([
        [100, 0],
        [0, 100],
        [100, 100],
      ]);
      // BRICK — odd ROWS shift by offset × stepX; the row step is
      // unchanged.
      const brick = of({ layout: "brick", columns: 2, rows: 2, spacing: 0 });
      expect(brick.map((t) => t.offset)).toEqual([
        [100, 0],
        [50, 100],
        [150, 100],
      ]);
      // HEX — the same shift AND a √3/2 vertical step.
      const hex = of({ layout: "hex", columns: 2, rows: 2, spacing: 0 });
      expect(hex[0].offset).toEqual([100, 0]);
      expect(hex[1].offset[0]).toBe(50);
      expect(hex[1].offset[1]).toBeCloseTo(100 * HEX_ROW_FACTOR, 9);
      // A 3 × 3 grid with the defaults is still v0's eight copies.
      expect(of({}).length).toBe(8);
    });

    it("overlap is the EMISSION order, and the vertical choice wins", () => {
      const tiles = [
        { col: 1, row: 0, offset: [1, 0] as [number, number] },
        { col: 2, row: 0, offset: [2, 0] as [number, number] },
        { col: 1, row: 1, offset: [1, 1] as [number, number] },
      ];
      // Default: bottom + right in front ⇒ ascending row, ascending col
      // (the last emitted paints on top).
      expect(
        orderPatternTiles(tiles, {
          horizontal: "rightInFront",
          vertical: "bottomInFront",
        }).map((t) => [t.row, t.col]),
      ).toEqual([
        [0, 1],
        [0, 2],
        [1, 1],
      ]);
      // Left in front ⇒ the leftmost column is emitted LAST within a row.
      expect(
        orderPatternTiles(tiles, {
          horizontal: "leftInFront",
          vertical: "bottomInFront",
        }).map((t) => [t.row, t.col]),
      ).toEqual([
        [0, 2],
        [0, 1],
        [1, 1],
      ]);
      // Top in front ⇒ rows descend. This is the OUTER key, so it wins:
      // row 1 is emitted before row 0 no matter the horizontal choice.
      expect(
        orderPatternTiles(tiles, {
          horizontal: "rightInFront",
          vertical: "topInFront",
        }).map((t) => [t.row, t.col]),
      ).toEqual([
        [1, 1],
        [0, 1],
        [0, 2],
      ]);
    });

    it("offsetTable translates every control point, boundaries preserved", () => {
      const moved = offsetTable(SQUARE.sources[0].table, 5, -5);
      expect(moved.anchors[0]).toEqual(anchorAt([5, -5]));
      expect(moved.anchors[2]).toEqual(anchorAt([105, 95]));
      expect(moved.subpathStarts).toEqual([0]);
    });

    it("patternCopiesFor counts a COMPOUND source's contours per copy", () => {
      expect(patternCopiesFor(RING)).toEqual([
        { tile: RING.tiles[0], sourceIndex: 0, contours: 2 },
      ]);
      expect(patternCopiesFor(SQUARE)[0].contours).toBe(1);
    });
  });

  describe("the artboard fit (v0's named residual)", () => {
    it("keeps only the tiles that land FULLY inside the page rect", () => {
      const bounds = { top: 100, left: 100, bottom: 400, right: 400 };
      const page = { pageId: "usp", width: 612, height: 792 };
      const params = patternParamsFrom({});
      const tiles = patternTilesFor(params, [306, 306]);
      expect(tiles).toHaveLength(8);
      const fit = fitTilesToPage(tiles, bounds, page);
      // Only (0,1) survives: everything else runs past 612 pt across or
      // 792 pt down.
      expect(fit.placed.map((t) => [t.col, t.row])).toEqual([[0, 1]]);
      expect(fit.dropped).toHaveLength(7);
      // An UNREADABLE page rect keeps every tile — the honest degrade,
      // never a silent drop.
      expect(fitTilesToPage(tiles, bounds, null).placed).toHaveLength(8);
      expect(fitTilesToPage(tiles, bounds, null).dropped).toHaveLength(0);
    });
  });

  describe("the container part", () => {
    it("parse / serialize round-trip, and junk reads as an EMPTY library", () => {
      const field = {
        id: "pat-1",
        name: "Ring field",
        params: patternParamsFrom({ layout: "brick", dim: 40 }),
        sources: [{ kind: "polygon", id: "uinner" }],
      };
      const bytes = serializePatternLibrary({
        v: PATTERN_LIBRARY_VERSION,
        fields: [field],
      });
      expect(parsePatternLibrary(bytes)).toEqual({
        v: PATTERN_LIBRARY_VERSION,
        fields: [field],
      });
      // Diffable: indented, newline-terminated.
      expect(new TextDecoder().decode(bytes)).toContain('\n  "fields": [');
      expect(parsePatternLibrary(null).fields).toEqual([]);
      expect(parsePatternLibrary(new Uint8Array())).toEqual({
        v: PATTERN_LIBRARY_VERSION,
        fields: [],
      });
      expect(
        parsePatternLibrary(new TextEncoder().encode("{ not json")).fields,
      ).toEqual([]);
      // A FUTURE version reads as empty rather than half-understood.
      expect(
        parsePatternLibrary(new TextEncoder().encode('{"v":99,"fields":[{"id":"x"}]}'))
          .fields,
      ).toEqual([]);
      // A field with no id is dropped; a field with junk params falls
      // back to the defaults rather than poisoning a later plan.
      const loose = parsePatternLibrary(
        new TextEncoder().encode(
          '{"v":1,"fields":[{"name":"no id"},{"id":"pat-9","params":{"layout":"nope"}}]}',
        ),
      );
      expect(loose.fields.map((f) => f.id)).toEqual(["pat-9"]);
      expect(loose.fields[0].params).toEqual(PATTERN_DEFAULTS);
      expect(loose.fields[0].name).toBe("pat-9");
    });

    it("mint / upsert / find / remove are pure and order-stable", () => {
      const empty = { v: PATTERN_LIBRARY_VERSION, fields: [] };
      expect(mintPatternId(empty)).toBe("pat-1");
      const one = upsertPatternField(empty, {
        id: "pat-1",
        name: "A",
        params: PATTERN_DEFAULTS,
        sources: [],
      });
      expect(mintPatternId(one)).toBe("pat-2");
      const renamed = upsertPatternField(one, {
        id: "pat-1",
        name: "B",
        params: PATTERN_DEFAULTS,
        sources: [],
      });
      expect(renamed.fields).toHaveLength(1);
      expect(findPatternField(renamed, "pat-1")!.name).toBe("B");
      expect(findPatternField(renamed, "pat-7")).toBeNull();
      expect(removePatternFieldFrom(renamed, "pat-1").fields).toEqual([]);
      // Removing an unknown id is a no-op, and the input is untouched.
      expect(removePatternFieldFrom(renamed, "pat-7").fields).toHaveLength(1);
      expect(one.fields).toHaveLength(1);
    });

    it("the element links round-trip and never clobber a sibling key", () => {
      const env = withPatternKey({ v: 1, data: { keepMe: 1 } }, "patternSource", {
        pattern: "pat-1",
        index: 2,
      });
      expect(env!.data.keepMe).toBe(1);
      expect(patternSourceOf(env)).toEqual({ pattern: "pat-1", index: 2 });
      expect(withPatternKey(env, "patternSource", null)!.data).toEqual({ keepMe: 1 });
      expect(withPatternKey({ v: 1, data: {} }, "patternSource", null)).toBeNull();
      expect(patternSourceOf(null)).toBeNull();
      expect(patternSourceOf({ v: 1, data: { patternSource: 7 } })).toBeNull();

      const tile = withPatternKey(null, "patternTile", {
        pattern: "pat-1",
        of: poly("us"),
        col: 1,
        row: 2,
      });
      expect(patternTileOf(tile)).toEqual({
        pattern: "pat-1",
        of: poly("us"),
        col: 1,
        row: 2,
      });
      // A v0 stamp carried NO `pattern` field — it reads as the legacy
      // field id so an already-baked document stays releasable.
      expect(
        patternTileOf({
          v: 1,
          data: { patternTile: { of: poly("us"), col: 1, row: 0 } },
        }),
      ).toEqual({ pattern: PATTERN_LEGACY_FIELD, of: poly("us"), col: 1, row: 0 });
      expect(PATTERN_LEGACY_FIELD).toBe("");
    });
  });

  describe("the wire shapes", () => {
    it("THE ONE BATCH: every contour inserted and NAMED, then the finish through those names", () => {
      const ops = (
        patternBatchFor({ plan: RING, sourceEnvelopes: [null] }) as Extract<
          Mutation,
          { op: "batch" }
        >
      ).args.ops as { op: string; args: Record<string, unknown> }[];
      expect(ops.map((o) => o.op)).toEqual([
        // the ring copy: outer contour, hole — each insert named at once
        "insertPath",
        "bindCreated",
        "insertPath",
        "bindCreated",
        // the finish, addressing them by handle
        "setElementProperty", // framePath: the hole merged back in
        "deleteFrame", // …and the absorbed contour dropped
        "setElementProperty", // fill
        "setElementProperty", // stroke
        "setPluginMetadata", // tile link
        "setPluginMetadata", // source link
        "createGroup",
      ]);
      expect(ops[1]!.args).toEqual({ handle: patternHandle(0, 0) });
      expect(ops[3]!.args).toEqual({ handle: patternHandle(0, 1) });
      const kept = { kind: "polygon", id: "$h:pt0_0" };
      expect(ops[4]!.args.elementId).toEqual(kept);
      expect(ops[4]!.args.path).toBe("framePath");
      expect(ops[5]).toEqual({ op: "deleteFrame", args: { frameId: "$h:pt0_1" } });
      expect(ops[10]).toEqual({
        op: "createGroup",
        args: { memberIds: [poly("us"), kept] },
      });
      // The finish IS the stepwise lane's batch 2, word for word, over
      // the handle bindings — one builder, so the lanes cannot drift.
      expect(ops.slice(4)).toEqual(
        (
          patternFinishBatchFor({
            plan: RING,
            bindings: patternHandleBindings(RING),
            sourceEnvelopes: [null],
          }) as Extract<Mutation, { op: "batch" }>
        ).args.ops,
      );
    });

    it("THE ONE BATCH of a re-plan: inserts FIRST, then dissolve, then the deletes, the group LAST", () => {
      const ops = (
        patternBatchFor({
          plan: SQUARE,
          sourceEnvelopes: [null],
          dissolve: { kind: "group", id: "ug" } as ElementId,
          stale: [poly("uold1"), poly("uold2")],
        }) as Extract<Mutation, { op: "batch" }>
      ).args.ops as { op: string }[];
      expect(ops.map((o) => o.op)).toEqual([
        "insertPath",
        "bindCreated",
        "dissolveGroup",
        "deleteFrame",
        "deleteFrame",
        "setElementProperty",
        "setElementProperty",
        "setPluginMetadata",
        "setPluginMetadata",
        "createGroup",
      ]);
    });

    it("the STEPWISE lane's batch 1 is one insertPath per copy per contour, offset applied", () => {
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

    it("the finish paints, links and groups — and writes NO dim op at 100 %", () => {
      const bindings = bindPatternCopies(SQUARE, [poly("u1")])!;
      const batch = patternFinishBatchFor({
        plan: SQUARE,
        bindings,
        sourceEnvelopes: [null],
      }) as Extract<Mutation, { op: "batch" }>;
      const ops = batch.args.ops;
      // fill, stroke, tile link, source link, group — no weight op (the
      // source carries none) and no opacity op (dim is 100).
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
          JSON.parse((ops[2] as { args: { value: string } }).args.value) as never,
        ),
      ).toEqual({ pattern: "pat-1", of: poly("us"), col: 1, row: 0 });
      expect(
        patternSourceOf(
          JSON.parse((ops[3] as { args: { value: string } }).args.value) as never,
        ),
      ).toEqual({ pattern: "pat-1", index: 0 });
      expect(ops[4]).toEqual({
        op: "createGroup",
        args: { memberIds: [poly("us"), poly("u1")] },
      });
    });

    it("DIMMING is a real frameOpacity length written on every COPY", () => {
      const plan: PatternPlan = {
        ...SQUARE,
        params: patternParamsFrom({ dim: 35 }),
      };
      const ops = (
        patternFinishBatchFor({
          plan,
          bindings: bindPatternCopies(plan, [poly("u1")])!,
          sourceEnvelopes: [null],
        }) as Extract<Mutation, { op: "batch" }>
      ).args.ops;
      expect(ops[2]).toEqual({
        op: "setElementProperty",
        args: {
          elementId: poly("u1"),
          path: "frameOpacity",
          value: { type: "length", value: 35 },
        },
      });
      // The SOURCE is only stamped — its own opacity is never touched.
      const sourceOps = ops.filter(
        (o) =>
          (o as { args?: { elementId?: ElementId } }).args?.elementId?.id === "us",
      );
      expect(sourceOps.map((o) => (o as { op: string }).op)).toEqual([
        "setPluginMetadata",
      ]);
    });

    it("a COMPOUND copy is re-merged through framePath, extras deleted", () => {
      const bindings = bindPatternCopies(RING, [poly("u1"), poly("u2")])!;
      expect(bindings[0]).toEqual({
        copy: patternCopiesFor(RING)[0],
        keep: poly("u1"),
        absorb: [poly("u2")],
      });
      const ops = (
        patternFinishBatchFor({ plan: RING, bindings, sourceEnvelopes: [null] }) as Extract<
          Mutation,
          { op: "batch" }
        >
      ).args.ops;
      expect((ops[0] as { args: { path: string } }).args.path).toBe("framePath");
      expect(
        (ops[0] as { args: { value: { value: { subpathStarts: number[] } } } }).args
          .value.value.subpathStarts,
      ).toEqual([0, 4]);
      expect(ops[1]).toEqual({ op: "deleteFrame", args: { frameId: "u2" } });
    });

    it("a RE-PLAN dissolves the old group BEFORE deleting its members", () => {
      // The order is not a style choice: deleting a member first leaves
      // the group holding a hole and the engine refuses the dissolve
      // with "group has an id-less member that cannot round-trip"
      // (measured — the live path is asserted against the engine below).
      const ops = (
        patternFinishBatchFor({
          plan: SQUARE,
          bindings: bindPatternCopies(SQUARE, [poly("u1")])!,
          sourceEnvelopes: [null],
          dissolve: { kind: "group", id: "ug" } as ElementId,
          stale: [poly("uold1"), poly("uold2")],
        }) as Extract<Mutation, { op: "batch" }>
      ).args.ops;
      expect(ops[0]).toEqual({ op: "dissolveGroup", args: { groupId: "ug" } });
      expect(ops[1]).toEqual({ op: "deleteFrame", args: { frameId: "uold1" } });
      expect(ops[2]).toEqual({ op: "deleteFrame", args: { frameId: "uold2" } });
    });

    it("release unlinks only; delete-tiles dissolves, deletes, then unlinks", () => {
      const release = patternReleaseBatchFor([
        { id: poly("us"), envelope: { v: 1, data: { keepMe: 1 } }, key: "patternSource" },
        { id: poly("u1"), envelope: null, key: "patternTile" },
      ]) as Extract<Mutation, { op: "batch" }>;
      expect(release.args.ops.map((o) => (o as { op: string }).op)).toEqual([
        "setPluginMetadata",
        "setPluginMetadata",
      ]);
      // A sibling key survives the release …
      expect(
        JSON.parse((release.args.ops[0] as { args: { value: string } }).args.value),
      ).toEqual({ v: 1, data: { keepMe: 1 } });
      // … and an envelope with nothing left is cleared to null.
      expect((release.args.ops[1] as { args: { value: unknown } }).args.value).toBeNull();

      const del = patternDeleteBatchFor({
        group: { kind: "group", id: "ug" } as ElementId,
        tiles: [poly("u1"), poly("u2")],
        sources: [{ id: poly("us"), envelope: null }],
      }) as Extract<Mutation, { op: "batch" }>;
      expect(del.args.ops.map((o) => (o as { op: string }).op)).toEqual([
        "dissolveGroup",
        "deleteFrame",
        "deleteFrame",
        "setPluginMetadata",
      ]);
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
      await writePatternLibrary(h.host, { v: PATTERN_LIBRARY_VERSION, fields: [] });
    });

    it("the page RECT is readable, which is what makes the fit possible", async () => {
      expect(await patternPageRect(h.host, F6_RING_PAIR.pageId)).toEqual({
        pageId: F6_RING_PAIR.pageId,
        width: 612,
        height: 792,
      });
      // An unknown page answers null rather than a guessed rect.
      expect(await patternPageRect(h.host, "nope")).toBeNull();
    });

    it("the tile step is the SELECTION BOUNDS plus the spacing", async () => {
      expect(await selectionBoundsOf(h.host, [INNER])).toEqual({
        top: 200,
        left: 200,
        bottom: 300,
        right: 300,
      });
      expect(await selectionTileSize(h.host, [INNER])).toEqual([100, 100]);
      const plan = await patternPlanFor(h.host, {
        field: "pat-1",
        params: PATTERN_DEFAULTS,
        ids: [INNER],
        label: "test",
      });
      expect(plan!.step).toEqual([106, 106]);
      expect(plan!.tiles).toHaveLength(8);
      expect(plan!.dropped).toHaveLength(0);
      expect(plan!.sources).toHaveLength(1);
      expect(plan!.pageId).toBe(F6_RING_PAIR.pageId);
    });

    it("BAKE places 8 copies, paints, links, groups and saves the recipe", async () => {
      const before = await leafIds(h);
      await h.host.selection.set([INNER]);
      const created = await applyMakePattern(h.host, { name: "Ring field" });
      expect(created).toHaveLength(8);

      const group = await groupShape(h);
      expect(group!.members).toHaveLength(9);
      expect(group!.members).toContain(F6_RING_PAIR.innerId);
      expect(await leafIds(h)).toHaveLength(before.length + 8);

      // Every copy carries the source's paint …
      expect(await readProp(h, created[0], "frameFillColor")).toEqual({
        type: "colorRef",
        value: "Color/Black",
      });
      // … and its tile link, naming the field it belongs to.
      expect(patternTileOf(await h.host.document.getMetadata(created[0]))).toEqual({
        pattern: "pat-1",
        of: INNER,
        col: 1,
        row: 0,
      });
      expect(patternTileOf(await h.host.document.getMetadata(created[7]))).toEqual({
        pattern: "pat-1",
        of: INNER,
        col: 2,
        row: 2,
      });
      // The SOURCE carries the back-link.
      expect(patternSourceOf(await h.host.document.getMetadata(INNER))).toEqual({
        pattern: "pat-1",
        index: 0,
      });

      // The recipe is a REAL container part, at the declared path.
      const bytes = await h.host.parts.read(PATTERN_PART);
      const library = parsePatternLibrary(bytes);
      expect(library.fields).toHaveLength(1);
      expect(library.fields[0].id).toBe("pat-1");
      expect(library.fields[0].name).toBe("Ring field");
      expect(library.fields[0].params).toEqual(PATTERN_DEFAULTS);
      expect(library.fields[0].sources).toEqual([
        { kind: "polygon", id: F6_RING_PAIR.innerId },
      ]);

      // Tile (1,0) really is the source, moved one step right.
      const src = await compoundSourceOf(h.host, INNER);
      const tile = await compoundSourceOf(h.host, created[0]);
      expect(tile!.table.anchors[0].anchor).toEqual([
        src!.table.anchors[0].anchor[0] + 106,
        src!.table.anchors[0].anchor[1],
      ]);
    });

    it("UNDO — the bake is exactly ONE batch (C-15: assert, never claim)", async () => {
      // (continues from the bake above) ONE undo unwinds the whole bake —
      // the inserts, the paint, the links and the group together. It
      // was two: the first used to leave eight unpainted paths behind.
      expect(await leafIds(h)).toHaveLength(3 + 8);
      await h.host.document.undo();
      expect(await groupShape(h)).toBeNull();
      expect(patternSourceOf(await h.host.document.getMetadata(INNER))).toBeNull();
      expect(await sortedLeafIds(h)).toEqual(PRISTINE);
    });

    it("what the one batch stands on — the ENGINE speaks C-15", async () => {
      // Re-verified rather than assumed. `bindCreated` IS in the booted
      // engine's op vocabulary and resolves end-to-end when it follows
      // the creating child …
      const ok = await h.host.document.mutate({
        op: "batch",
        args: {
          ops: [
            {
              op: "insertPath",
              args: {
                pageId: F6_RING_PAIR.pageId,
                anchors: [anchorAt([10, 10]), anchorAt([20, 10]), anchorAt([20, 20])],
                open: false,
              },
            },
            { op: "bindCreated", args: { handle: "h1" } },
            {
              op: "setElementProperty",
              args: {
                elementId: { kind: "polygon", id: "$h:h1" },
                path: "frameFillColor",
                value: { type: "colorRef", value: "Color/Black" },
              },
            },
          ],
        },
        // This cast used to be the point — the contract had no
        // `bindCreated` arm, so the bundle stayed at two batches by
        // contract discipline and this test was the receipt that the
        // collapse was one merge away. The arm landed; the collapse is
        // `patternBatchFor`, and this is still what it stands on.
      } as never);
      expect(ok.applied).toBe(true);
      await h.host.document.undo();

      // … and refuses when it comes FIRST, with its own sentence.
      const early = await h.host.document.mutate({
        op: "batch",
        args: {
          ops: [
            { op: "bindCreated", args: { handle: "h1" } },
            {
              op: "insertPath",
              args: {
                pageId: F6_RING_PAIR.pageId,
                anchors: [anchorAt([10, 10]), anchorAt([20, 10]), anchorAt([20, 20])],
                open: false,
              },
            },
          ],
        },
      } as never);
      expect(early.applied).toBe(false);
      expect(JSON.stringify(early)).toContain("has nothing to name");
      expect(await sortedLeafIds(h)).toEqual(PRISTINE);
    });

    it("a batch that DELETES then INSERTS is refused — so the inserts go FIRST", async () => {
      const out = await h.host.document.mutate({
        op: "batch",
        args: {
          ops: [
            { op: "deleteFrame", args: { frameId: F6_RING_PAIR.innerId } },
            {
              op: "insertPath",
              args: {
                pageId: F6_RING_PAIR.pageId,
                anchors: [anchorAt([10, 10]), anchorAt([20, 10]), anchorAt([20, 20])],
                open: false,
              },
            },
          ],
        },
      });
      expect(out.applied).toBe(false);
      // The engine's own words: the insert's z-position resolves against
      // the spread length the batch STARTED with.
      expect(JSON.stringify(out)).toContain("out of range for parent");
      expect(await sortedLeafIds(h)).toEqual(PRISTINE);
    });

    it("ARTBOARD FIT — every placed tile is READABLE (v0 left five of eight blind)", async () => {
      // OUTER is 300 pt wide on a 612 × 792 page, so a default 3 × 3
      // grid steps clean off it. v1 fits the count to the page …
      await h.host.selection.set([OUTER]);
      const fitted = await applyMakePattern(h.host);
      expect(fitted).toHaveLength(1);
      for (const id of fitted) {
        // The whole point of the fit: a placed tile ANSWERS.
        expect(await compoundSourceOf(h.host, id)).not.toBeNull();
      }
      await undoTo(h, 1);
      expect(await sortedLeafIds(h)).toEqual(PRISTINE);

      // … and the v0 behaviour is still reachable, still measured, and
      // still exactly as bad: eight tiles created, five of them
      // unreadable because `pathAnchors` / `elementGeometry` are
      // PAGE-KEYED and an item outside every page belongs to no page
      // (RFI C-23).
      await h.host.selection.set([OUTER]);
      const loose = await applyMakePattern(h.host, { fitToArtboard: false });
      expect(loose).toHaveLength(8);
      const readable: string[] = [];
      for (const id of loose) {
        if (await compoundSourceOf(h.host, id)) readable.push(String(id.id));
      }
      expect(readable).toHaveLength(3);
      expect(await leafIds(h)).toHaveLength(3 + 8);
      await undoTo(h, 1);
      expect(await sortedLeafIds(h)).toEqual(PRISTINE);
    });

    it("BRICK + DIMMING land on the page, and the dim is a real property", async () => {
      await h.host.selection.set([INNER]);
      const tiles = await applyMakePattern(h.host, {
        layout: "brick",
        columns: 2,
        rows: 2,
        spacing: 0,
        dim: 40,
      });
      expect(tiles).toHaveLength(3);
      // Row 1 is shifted by half a step (offset defaults to 0.5).
      const src = await compoundSourceOf(h.host, INNER);
      const shifted = await compoundSourceOf(h.host, tiles[1]);
      expect(shifted!.table.anchors[0].anchor).toEqual([
        src!.table.anchors[0].anchor[0] + 50,
        src!.table.anchors[0].anchor[1] + 100,
      ]);
      // Every copy is dimmed; the SOURCE is not.
      for (const id of tiles) {
        expect(await readProp(h, id, "frameOpacity")).toEqual({
          type: "length",
          value: 40,
        });
      }
      expect(await readProp(h, INNER, "frameOpacity")).toEqual({
        type: "length",
        value: null,
      });
      await undoTo(h, 1);
      expect(await sortedLeafIds(h)).toEqual(PRISTINE);
    });

    it("NEGATIVE spacing really overlaps, and the overlap ORDER is paint order", async () => {
      await h.host.selection.set([INNER]);
      // -60 pt on a 100 pt tile ⇒ a 40 pt step: the copies overlap.
      const tiles = await applyMakePattern(h.host, {
        columns: 3,
        rows: 1,
        spacing: -60,
        overlap: { horizontal: "leftInFront", vertical: "bottomInFront" },
      });
      expect(tiles).toHaveLength(2);
      const first = await compoundSourceOf(h.host, tiles[0]);
      const src = await compoundSourceOf(h.host, INNER);
      // "left in front" emits the RIGHTMOST column first, so tiles[0] is
      // column 2 (two steps out) and tiles[1] is column 1 …
      expect(first!.table.anchors[0].anchor[0]).toBe(
        src!.table.anchors[0].anchor[0] + 80,
      );
      expect(patternTileOf(await h.host.document.getMetadata(tiles[0]))!.col).toBe(2);
      expect(patternTileOf(await h.host.document.getMetadata(tiles[1]))!.col).toBe(1);
      // … and insertion order IS tree order, so column 1 really does
      // paint above column 2 (the only z-control the wire offers).
      const order = await leafIds(h);
      expect(order.indexOf(String(tiles[1].id))).toBeGreaterThan(
        order.indexOf(String(tiles[0].id)),
      );
      await undoTo(h, 1);
      expect(await sortedLeafIds(h)).toEqual(PRISTINE);
    });

    it("RE-PLAN rebuilds the field with new parameters and FRESH geometry", async () => {
      await h.host.selection.set([INNER]);
      const first = await applyMakePattern(h.host, { columns: 2, rows: 1 });
      expect(first).toHaveLength(1);

      // Move the SOURCE — v0's residual was that this changed nothing.
      const moved = await h.host.document.mutate({
        op: "pathPointSet",
        args: { elementId: INNER, index: 0, role: "anchor", position: [210, 210] },
      });
      expect(moved.applied).toBe(true);
      // Still nothing, by itself: the tiles are copies.
      expect((await compoundSourceOf(h.host, first[0]))!.table.anchors[0].anchor).toEqual(
        [306, 200],
      );

      // A re-plan picks the edit up AND applies the new parameters.
      const replanned = await applyEditPattern(h.host, { columns: 3, rows: 1, dim: 50 });
      expect(replanned).toHaveLength(2);
      // Fresh geometry: the moved anchor rode along.
      expect(
        (await compoundSourceOf(h.host, replanned[0]))!.table.anchors[0].anchor,
      ).toEqual([316, 210]);
      // New parameters: dimmed now, where the first bake was not.
      expect(await readProp(h, replanned[0], "frameOpacity")).toEqual({
        type: "length",
        value: 50,
      });
      // The OLD tile is gone and the field is one group again.
      expect(await leafIds(h)).not.toContain(String(first[0].id));
      const group = await groupShape(h);
      expect(group!.members).toHaveLength(3);
      // The recipe kept the field id and took the new parameters.
      const library = await readPatternLibrary(h.host);
      expect(library.fields.map((f) => f.id)).toEqual(["pat-1"]);
      expect(library.fields[0].params.columns).toBe(3);
      expect(library.fields[0].params.dim).toBe(50);

      // UNDO — a re-plan is exactly ONE batch, like a bake: one step and
      // the old field is back whole — its tile, its group, no leftovers.
      await h.host.document.undo();
      expect(await leafIds(h)).toContain(String(first[0].id));
      expect(await leafIds(h)).toHaveLength(3 + 1);
      expect((await groupShape(h))!.members).toHaveLength(2);
      // …and then the source move, then the first bake.
      await undoTo(h, 2);
      expect(await sortedLeafIds(h)).toEqual(PRISTINE);
    });

    it("SELECT TILES puts the field's copies on the selection", async () => {
      await h.host.selection.set([INNER]);
      const tiles = await applyMakePattern(h.host, { columns: 2, rows: 2 });
      expect(tiles).toHaveLength(3);
      const selected = await applySelectPatternTiles(h.host, {});
      expect(selected.map((s) => String(s.id)).sort()).toEqual(
        tiles.map((t) => String(t.id)).sort(),
      );
      expect(h.host.selection.get()).toHaveLength(3);
      // …and, on request, the sources too.
      const withSources = await applySelectPatternTiles(h.host, {
        includeSources: true,
      });
      expect(withSources).toHaveLength(4);
      await undoTo(h, 1);
      expect(await sortedLeafIds(h)).toEqual(PRISTINE);
    });

    it("DELETE TILES un-bakes in ONE batch: copies gone, sources untouched", async () => {
      await h.host.selection.set([INNER]);
      const tiles = await applyMakePattern(h.host, { columns: 2, rows: 2 });
      expect(tiles).toHaveLength(3);
      const sourceBefore = await compoundSourceOf(h.host, INNER);

      const removed = await applyDeletePatternTiles(h.host, {});
      expect(removed).toBe(3);
      expect(await sortedLeafIds(h)).toEqual(PRISTINE);
      expect(await groupShape(h)).toBeNull();
      // The source kept its geometry AND lost only the pattern link.
      expect((await compoundSourceOf(h.host, INNER))!.table.anchors).toEqual(
        sourceBefore!.table.anchors,
      );
      expect(patternSourceOf(await h.host.document.getMetadata(INNER))).toBeNull();
      // The recipe is gone from the container part.
      expect((await readPatternLibrary(h.host)).fields).toEqual([]);

      // ONE batch ⇒ one undo step brings the whole field back.
      await h.host.document.undo();
      expect(await leafIds(h)).toHaveLength(3 + 3);
      expect((await patternLinks(h.host, "pat-1")).tiles).toHaveLength(3);
      await undoTo(h, 1);
      expect(await sortedLeafIds(h)).toEqual(PRISTINE);
    });

    it("RELEASE keeps every piece of artwork and drops only the tracking", async () => {
      await h.host.selection.set([INNER]);
      const tiles = await applyMakePattern(h.host, { columns: 2, rows: 2 });
      expect(tiles).toHaveLength(3);

      expect(await applyReleasePattern(h.host, {})).toBe(true);
      // Artwork AND group survive …
      expect(await leafIds(h)).toHaveLength(3 + 3);
      expect(await groupShape(h)).not.toBeNull();
      // … every link is gone …
      const links = await patternLinks(h.host);
      expect(links.tiles).toEqual([]);
      expect(links.sources).toEqual([]);
      // … and so is the recipe.
      expect((await readPatternLibrary(h.host)).fields).toEqual([]);

      // ONE batch ⇒ one undo step restores the links (not the recipe —
      // a container write is not on the undo stack).
      await h.host.document.undo();
      expect((await patternLinks(h.host, "pat-1")).tiles).toHaveLength(3);
      await undoTo(h, 1);
      expect(await sortedLeafIds(h)).toEqual(PRISTINE);
    });

    it("a COMPOUND source tiles WITH its hole (contours re-merged per copy)", async () => {
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
      const created = await applyMakePattern(h.host, { columns: 2, rows: 2 });
      expect(created).toHaveLength(3);
      // Each copy came in as 2 contours and was merged back into a ring.
      for (const id of created) {
        expect(contourCountOf((await compoundSourceOf(h.host, id))!.table)).toBe(2);
      }

      // Unwind: pattern (1) + make compound (1) + the setup insert (1).
      await undoTo(h, 3);
      expect(await sortedLeafIds(h)).toEqual(PRISTINE);
    });

    it("refuses honestly: no selection, a text frame, and an oversized field", async () => {
      await h.host.selection.set([]);
      expect(await applyMakePattern(h.host)).toEqual([]);
      expect(await sortedLeafIds(h)).toEqual(PRISTINE);
      expect(await groupShape(h)).toBeNull();

      // A TEXT FRAME is skipped, not silently copied: no wire op
      // duplicates a story, and `insertPath` makes Polygons.
      const plan = await patternPlanFor(h.host, {
        field: "pat-1",
        params: PATTERN_DEFAULTS,
        ids: [{ kind: "textFrame", id: "utext" } as ElementId],
        label: "test",
      });
      expect(plan).toBeNull();

      // The copy ceiling REFUSES rather than truncating.
      await h.host.selection.set([INNER]);
      expect(
        await applyMakePattern(h.host, { columns: 40, rows: 40, fitToArtboard: false }),
      ).toEqual([]);
      expect(await sortedLeafIds(h)).toEqual(PRISTINE);
      expect(PATTERN_MAX_TILES).toBe(400);

      // Nothing to release / un-bake / re-plan is a no-op, never a throw.
      expect(await applyReleasePattern(h.host, { patternId: "pat-9" })).toBe(false);
      expect(await applyDeletePatternTiles(h.host, { patternId: "pat-9" })).toBe(0);
      expect(await applyEditPattern(h.host, { patternId: "pat-9" })).toEqual([]);
      expect(await sortedLeafIds(h)).toEqual(PRISTINE);
    });

    it("a v0-stamped field is releasable but NOT re-plannable", async () => {
      // Stamp a v0-shaped tile link (no `pattern` field) by hand.
      const stamped = await h.host.document.setMetadata(poly("uopen"), {
        v: 1,
        data: { patternTile: { of: INNER, col: 1, row: 0 } },
      });
      expect(stamped.applied).toBe(true);
      const links = await patternLinks(h.host, PATTERN_LEGACY_FIELD);
      expect(links.tiles).toHaveLength(1);
      // Re-plan refuses with the reason, because v0 stored no parameters.
      expect(await applyEditPattern(h.host, { patternId: PATTERN_LEGACY_FIELD })).toEqual(
        [],
      );
      // Release still works on it.
      expect(await applyReleasePattern(h.host, { patternId: PATTERN_LEGACY_FIELD })).toBe(
        true,
      );
      expect(await h.host.document.getMetadata(poly("uopen"))).toBeNull();
      await undoTo(h, 2);
      expect(await sortedLeafIds(h)).toEqual(PRISTINE);
    });

    it("the panel's row label reports requested AND placed", () => {
      const field = {
        id: "pat-1",
        name: "A",
        params: patternParamsFrom({ layout: "hex", columns: 3, rows: 3 }),
        sources: [],
      };
      expect(patternRowLabel(field, 1)).toBe(
        "hex · 3 × 3 (8 copies requested, 1 placed)",
      );
      expect(
        patternRowLabel(
          { ...field, params: patternParamsFrom({ columns: 2, rows: 1 }) },
          1,
        ),
      ).toBe("grid · 2 × 1 (1 copy requested, 1 placed)");
    });

    it("the RECORDED commands drive the same lane and the selection", async () => {
      const make = commandFor(h, MAKE_PATTERN_COMMAND_ID);
      expect(make.title).toContain("NOT a pattern swatch");
      expect(make.category).toBe("Pattern");
      expect(commandFor(h, EDIT_PATTERN_COMMAND_ID).title).toContain("Re-plan");
      expect(commandFor(h, SELECT_PATTERN_TILES_COMMAND_ID).title).toContain(
        "Select the field's tiles",
      );
      expect(commandFor(h, DELETE_PATTERN_TILES_COMMAND_ID).title).toContain("un-bake");
      expect(commandFor(h, RELEASE_PATTERN_COMMAND_ID).title).toContain(
        "keep the artwork",
      );

      await h.host.selection.set([INNER]);
      await make.handler({} as never, { columns: 2, rows: 2 } as never);
      const group = await groupShape(h);
      expect(group).not.toBeNull();
      // The new group is selected, so a follow-up command addresses the
      // field as one object.
      expect(h.host.selection.get().map((s) => s.id)).toEqual([group!.id]);

      await commandFor(h, RELEASE_PATTERN_COMMAND_ID).handler(
        {} as never,
        undefined as never,
      );
      expect((await patternLinks(h.host)).tiles).toEqual([]);
      await undoTo(h, 2);
      expect(await sortedLeafIds(h)).toEqual(PRISTINE);
    });

    // A batch can apply and still be the wrong edit. So every bake below
    // runs through FIVE hosts — as shipped, and four with something taken
    // away (`./one-batch.ts`) — and each must leave the SAME document:
    // the same tree, the same paint and outline on every leaf, the same
    // links, the same recipe, the same selection. Ids are compared as
    // positions, because each run mints its own.
    //
    //                      mutations   undo steps   tree reads
    //   as found  make         2            2            3
    //             re-plan      2            2            4
    //   now       make         1            1            0
    //             re-plan      1            1            1  (the link walk)
    //
    // The "as found" row is not remembered: it is what the `asFound`
    // lane measures today, on a host that refuses `bindCreated` and has
    // no raw client — the engine these flows were written against.
    describe("one batch — and the same document every other lane leaves", () => {
      const RECIPE = [PATTERN_PART];
      /** A ring: a 100 pt square with a 40 pt hole, as ONE compound
       *  source — so a copy is two contours, one of them absorbed. */
      const ringSource = async (): Promise<ElementId> => {
        const before = new Set(await leafIds(h));
        const at = (x: number, y: number, s: number) => ({
          op: "insertPath" as const,
          args: {
            pageId: F6_RING_PAIR.pageId,
            anchors: [
              anchorAt([x, y]),
              anchorAt([x + s, y]),
              anchorAt([x + s, y + s]),
              anchorAt([x, y + s]),
            ],
            open: false,
          },
        });
        const ins = await h.host.document.mutate({
          op: "batch",
          args: { ops: [at(100, 500, 100), at(130, 530, 40)] },
        });
        expect(ins.applied).toBe(true);
        const [small, hole] = (await leafIds(h))
          .filter((id) => !before.has(id))
          .map(poly);
        await h.host.selection.set([small!, hole!]);
        expect(await applyMakeCompoundPath(h.host)).toBe(2);
        return small!;
      };

      /** The bakes. Each names what it is run on and what it expects of
       *  the shipped lane. */
      const scenarios: {
        name: string;
        setup?: () => Promise<ElementId[]>;
        run: (host: BundleHost) => Promise<ElementId[]>;
        tiles: number;
        /** Children of the one batch. */
        ops: number;
        /** `document.tree()` reads as shipped. */
        trees: number;
        /** …and as the flow was found: two batches, the created ids from
         *  a tree diff, the group from a third read. */
        asFound: number;
      }[] = [
        {
          name: "make, 3 × 3 of a square",
          setup: async () => [INNER],
          run: (host) => applyMakePattern(host, { name: "Field" }),
          tiles: 8,
          // 8 × (insert, bind, fill, stroke, link) + source link + group
          ops: 8 * 5 + 2,
          trees: 0,
          asFound: 3,
        },
        {
          name: "make, brick + dim of a COMPOUND source (a hole per copy)",
          setup: async () => [await ringSource()],
          run: (host) =>
            applyMakePattern(host, {
              layout: "brick",
              columns: 2,
              rows: 2,
              spacing: 4,
              dim: 40,
            }),
          tiles: 3,
          // 3 × (2 inserts, 2 binds, framePath, delete, fill, stroke,
          // weight, dim, link) + source link + group
          ops: 3 * 11 + 2,
          trees: 0,
          asFound: 3,
        },
        {
          name: "re-plan, 2 × 1 → 3 × 1 with fresh geometry",
          setup: async () => {
            await h.host.selection.set([INNER]);
            expect(await applyMakePattern(h.host, { columns: 2, rows: 1 })).toHaveLength(1);
            const moved = await h.host.document.mutate({
              op: "pathPointSet",
              args: { elementId: INNER, index: 0, role: "anchor", position: [210, 210] },
            });
            expect(moved.applied).toBe(true);
            return [];
          },
          run: (host) => applyEditPattern(host, { columns: 3, rows: 1, dim: 50 }),
          tiles: 2,
          // 2 × (insert, bind) + dissolve + 1 delete
          //   + 2 × (fill, stroke, dim, link) + source link + group
          ops: 2 * 2 + 2 + 2 * 4 + 2,
          // The link walk's one tree — which also finds the old group.
          trees: 1,
          // …that one, the diff's two, and the new group's lookup.
          asFound: 4,
        },
      ];

      for (const scenario of scenarios) {
        it(`${scenario.name}`, async () => {
          const through = (lane: LaneName) =>
            runThrough(h, lane, {
              carrier: OUTER,
              parts: RECIPE,
              setup: async () => {
                const select = (await scenario.setup?.()) ?? [];
                await h.host.selection.set(select);
              },
              command: scenario.run,
            });

          const shipped = await through("oneBatch");
          expect(shipped.result).toHaveLength(scenario.tiles);
          // ONE batch, ONE undo step, and that step restores the document.
          expect(shipped.work.mutations).toEqual([{ op: "batch", ops: scenario.ops }]);
          expect(shipped.undoSteps).toBe(1);
          expect(shipped.restored).toBe(true);
          expect(shipped.work.count("document.tree")).toBe(scenario.trees);

          // STEPWISE — the engine refuses the bind batch: the two batches
          // this was before, and exactly the same document.
          const stepwise = await through("stepwise");
          expect(stepwise.picture).toBe(shipped.picture);
          expect(stepwise.result).toHaveLength(scenario.tiles);
          expect(stepwise.work.mutations.map((m) => m.op)).toEqual([
            "batch", // the one batch, refused
            "batch", // insert
            "batch", // finish
          ]);
          expect(stepwise.undoSteps).toBe(2);
          expect(stepwise.restored).toBe(true);

          // DIFF and UNLISTED — one batch still, with the created ids
          // found the old way. Same document, still one undo step.
          for (const lane of ["diff", "unlisted"] as const) {
            const run = await through(lane);
            expect(run.picture, lane).toBe(shipped.picture);
            expect(run.work.mutations, lane).toEqual([
              { op: "batch", ops: scenario.ops },
            ]);
            expect(run.undoSteps, lane).toBe(1);
            expect(run.restored, lane).toBe(true);
            expect(run.work.count("document.tree"), lane).toBe(scenario.trees + 2);
          }

          // AS FOUND — no bind, no raw client. The numbers this flow
          // started from, measured — plus ONE read: the refused first
          // attempt had read its "before" by the time it was refused.
          const asFound = await through("asFound");
          expect(asFound.picture).toBe(shipped.picture);
          expect(asFound.undoSteps).toBe(2);
          expect(asFound.work.count("document.tree")).toBe(scenario.asFound + 1);

          expect(await sortedLeafIds(h)).toEqual(PRISTINE);
        });
      }

      /** `host`, with everything it logs kept. */
      const recording = (host: BundleHost, sink: string[]): BundleHost =>
        new Proxy(host, {
          get(target, prop, receiver) {
            const keep = (m: string) => void sink.push(m);
            return prop === "log"
              ? { ...target.log, debug: keep, info: keep, warn: keep }
              : (Reflect.get(target, prop, receiver) as unknown);
          },
        });

      it("a refused one-batch build says so, in the engine's sentence, and takes the stepwise lane", async () => {
        const logged: string[] = [];
        await h.host.selection.set([INNER]);
        const tiles = await applyMakePattern(
          recording(refusingBindCreated(h.host), logged),
          { columns: 2, rows: 1 },
        );
        expect(tiles).toHaveLength(1);
        expect(logged.join("\n")).toContain("the one-batch build was refused");
        expect(logged.join("\n")).toContain(NO_BIND_CREATED);
        await undoTo(h, 2);
        expect(await sortedLeafIds(h)).toEqual(PRISTINE);
      });

      // FIXED in 0.65.0 (`minted.spec.ts` pins the engine half). On 0.64.0
      // a field that was not the TOPMOST group on its page could not be
      // re-planned: deleting its old tiles left the group above with stale
      // member references, the one batch was refused ("a member already
      // belongs to another group"), and the stepwise fallback left the new
      // tiles loose on the page. Now the one batch applies.
      it("FIXED in 0.65.0 — a re-plan under another group is ONE batch, and one undo restores the old field", async () => {
        await h.host.selection.set([INNER]);
        const first = await applyMakePattern(h.host, { columns: 2, rows: 1 });
        expect(first).toHaveLength(1);
        await h.host.selection.set([poly("uopen")]);
        const above = await applyMakePattern(h.host, {
          columns: 2,
          rows: 1,
          fitToArtboard: false,
        });
        expect(above).toHaveLength(1);
        const before = await leafIds(h);
        const oldTiles = (await patternLinks(h.host, "pat-1")).tiles.map((t) => String(t.id.id));
        expect(oldTiles.length).toBeGreaterThan(0);

        const logged: string[] = [];
        const { host, work } = countingHost(recording(h.host, logged));
        const replanned = await applyEditPattern(host, {
          patternId: "pat-1",
          columns: 3,
          rows: 1,
        });
        expect(work.mutations.map((m) => m.op)).toEqual(["batch"]);
        expect(logged.join("\n")).not.toContain("a member already belongs to another group");
        // The field now has the new tiles, linked; the old ones are gone.
        expect(replanned).toHaveLength(2);
        expect(
          (await patternLinks(h.host, "pat-1")).tiles.map((t) => String(t.id.id)).sort(),
        ).toEqual(replanned.map((t) => String(t.id)).sort());
        const now = await leafIds(h);
        for (const old of oldTiles) expect(now).not.toContain(old);
        // ONE undo puts the old field back.
        await undoTo(h, 1);
        expect(await leafIds(h)).toEqual(before);
        await undoTo(h, 2);
        expect(await sortedLeafIds(h)).toEqual(PRISTINE);
      });
    });
  });
});
