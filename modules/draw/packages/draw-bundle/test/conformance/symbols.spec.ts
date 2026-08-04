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

// SYMBOLS v0 conformance — the Illustrator Phase-2 row (§16.1
// registration points), through the REAL engine wasm the harness boots.
// What this pins:
//
//   (1) the PERSISTENCE shape — the library is a SECOND `.paged`
//       container part (`paged/media.paged.draw/symbols.json`, beside the
//       graphic-style one), read back through the REAL parts door, and a
//       corrupt / foreign / future-versioned part degrades to an empty
//       library instead of taking the document with it;
//   (2) REGISTRATION (§16.1): the nine-point grid resolved over the
//       definition's control-point hull, the point a place anchors at and
//       a reset re-anchors to;
//   (3) the exact WIRE shapes — insert (with the rebuild's tear-down
//       riding the same batch), the finish batch's compound re-merge /
//       paint / per-leaf stamp / group, and the one-batch unlink;
//   (4) the REAL undo counts (RFI C-15 — MEASURE them, never claim
//       "one"): define = 0, rename = 0, place = 2, reset = 2 per
//       instance, break link = 1 for the whole selection, delete = 1;
//   (5) the honest refusals and limits: a TEXT FRAME is refused (no
//       mutation can copy a story), a one-piece symbol is NOT wrapped in
//       a group, a rebuild MINTS NEW IDS while the instance id survives,
//       and an instance placed off-page hits the PAGE-KEYED geometry wall
//       (RFI C-23) — warned at place, and reset falls back to the
//       recorded origin rather than failing mutely.

import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";

import type {
  BundleHost,
  CommandContribution,
  ElementId,
  Mutation,
} from "@paged-media/plugin-api";
import type { AnchorTable } from "@paged-media/draw-geometry";
import type { HeadlessHost } from "@paged-media/plugin-sdk";

import {
  drawBundle,
  applyBreakSymbolLink,
  applyDefineSymbol,
  applyDeleteSymbol,
  applyMakeCompoundPath,
  applyPlaceSymbolInstance,
  applyRedefineSymbol,
  applyRenameSymbol,
  applyResetSymbolTransform,
  bindSymbolPieces,
  captureSymbolSources,
  compoundSourceOf,
  contourCountOf,
  expandToLeaves,
  findSymbol,
  liveInstanceOrigin,
  mintSymbolId,
  mintSymbolInstanceId,
  parseAnchorTable,
  parseSymbolLibrary,
  registrationPointOf,
  removeSymbolFrom,
  renameSymbolIn,
  serializeSymbolLibrary,
  symbolBoundsOf,
  symbolContourCounts,
  symbolDefinitionFrom,
  symbolFinishBatchFor,
  symbolInsertBatchFor,
  symbolInstanceOf,
  symbolInstances,
  symbolPlacePlanFor,
  symbolRowLabel,
  symbolUnlinkBatchFor,
  upsertSymbol,
  withSymbolInstance,
  readSymbolLibrary,
  writeSymbolLibrary,
  BREAK_SYMBOL_LINK_COMMAND_ID,
  DEFAULT_SYMBOL_REGISTRATION,
  DEFINE_SYMBOL_COMMAND_ID,
  DELETE_SYMBOL_COMMAND_ID,
  PLACE_SYMBOL_COMMAND_ID,
  REDEFINE_SYMBOL_COMMAND_ID,
  RENAME_SYMBOL_COMMAND_ID,
  RESET_SYMBOL_TRANSFORM_COMMAND_ID,
  SYMBOLS_COMMAND_IDS,
  SYMBOLS_NOTE,
  SYMBOLS_PANEL_ID,
  SYMBOLS_PART,
  SYMBOL_REGISTRATIONS,
  type SymbolDefinition,
  type SymbolPlacePlan,
} from "../../src";
import { F6_RING_PAIR } from "../fixtures/corpus";
import { openHost } from "./host";

const poly = (id: string): ElementId => ({ kind: "polygon", id }) as ElementId;

const OUTER = poly(F6_RING_PAIR.ids.polygon!);
const INNER = poly(F6_RING_PAIR.innerId);

const anchorAt = (p: [number, number]) => ({
  anchor: [p[0], p[1]] as [number, number],
  left: [p[0], p[1]] as [number, number],
  right: [p[0], p[1]] as [number, number],
});

/** An axis-aligned square, corner-collapsed handles — the pure fixture. */
const square = (
  cx: number,
  cy: number,
  half: number,
): AnchorTable => ({
  anchors: [
    anchorAt([cx - half, cy - half]),
    anchorAt([cx + half, cy - half]),
    anchorAt([cx + half, cy + half]),
    anchorAt([cx - half, cy + half]),
  ],
  subpathStarts: [0],
  subpathOpen: [false],
});

const BLACK = { fill: "Color/Black", stroke: null, weight: null };

/** A hand-built definition: one 100 × 100 square captured around (250,
 *  250) with a centre registration ⇒ definition space is −50 … +50. */
const SQUARE_SYMBOL: SymbolDefinition = symbolDefinitionFrom({
  id: "sym-1",
  name: "Tile",
  registration: "center",
  sources: [{ table: square(250, 250, 50), paint: BLACK }],
})!;

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

/** Everything a symbol operation can touch — the fingerprint an undo has
 *  to restore for a step count to be honest. */
async function signature(h: HeadlessHost): Promise<string> {
  const rows: unknown[] = [];
  for (const id of await leafIds(h)) {
    const element = poly(id);
    rows.push([
      id,
      await h.host.document.getMetadata(element),
      (await compoundSourceOf(h.host, element))?.table.anchors.map(
        (a) => a.anchor,
      ) ?? null,
    ]);
  }
  return JSON.stringify([rows, await groupShape(h)]);
}

/** The page-space width/height of one element (null when the page-keyed
 *  doors answer nothing — the C-23 case). */
async function sizeOf(
  h: HeadlessHost,
  id: ElementId,
): Promise<[number, number] | null> {
  const source = await compoundSourceOf(h.host, id);
  if (!source) return null;
  const bounds = symbolBoundsOf([source.table])!;
  return [bounds[2] - bounds[0], bounds[3] - bounds[1]];
}

describe("draw conformance — SYMBOLS (Illustrator Phase 2, §16.1)", () => {
  // ------------------------------------------------------- pure: library

  describe("the library part (pure)", () => {
    it("round-trips through the part bytes", () => {
      const library = { v: 1, symbols: [SQUARE_SYMBOL] };
      const bytes = serializeSymbolLibrary(library);
      // Indented JSON — the `spec` role exists to stay small and diffable.
      expect(new TextDecoder().decode(bytes)).toContain('\n  "symbols": [');
      expect(parseSymbolLibrary(bytes)).toEqual(library);
    });

    it("degrades to an EMPTY library rather than throwing", () => {
      const empty = { v: 1, symbols: [] };
      expect(parseSymbolLibrary(null)).toEqual(empty);
      expect(parseSymbolLibrary(new Uint8Array())).toEqual(empty);
      expect(parseSymbolLibrary(new TextEncoder().encode("not json{"))).toEqual(
        empty,
      );
      // A FUTURE library version is not guessed at.
      expect(
        parseSymbolLibrary(
          new TextEncoder().encode('{"v":99,"symbols":[{"id":"x"}]}'),
        ),
      ).toEqual(empty);
      // An id-less row is dropped; a name-less one falls back to its id,
      // an unknown registration to the default, an unreadable piece is
      // dropped rather than half-restored.
      expect(
        parseSymbolLibrary(
          new TextEncoder().encode(
            '{"v":1,"symbols":[{},{"id":"sym-4","registration":"nope",' +
              '"pieces":[{"table":{"anchors":[]}}]}]}',
          ),
        ),
      ).toEqual({
        v: 1,
        symbols: [
          {
            id: "sym-4",
            name: "sym-4",
            registration: DEFAULT_SYMBOL_REGISTRATION,
            origin: [0, 0],
            pieces: [],
          },
        ],
      });
    });

    it("parseAnchorTable is tolerant but never invents geometry", () => {
      expect(parseAnchorTable(null)).toBeNull();
      expect(parseAnchorTable({ anchors: [{ anchor: [0, 0] }] })).toBeNull();
      // A missing handle collapses onto its anchor; a missing
      // subpathStarts becomes the single contour it must be.
      expect(
        parseAnchorTable({
          anchors: [{ anchor: [1, 2] }, { anchor: [3, 4] }],
        }),
      ).toEqual({
        anchors: [
          { anchor: [1, 2], left: [1, 2], right: [1, 2] },
          { anchor: [3, 4], left: [3, 4], right: [3, 4] },
        ],
        subpathStarts: [0],
      });
      // A non-numeric anchor is not coerced — the whole table refuses.
      expect(
        parseAnchorTable({ anchors: [{ anchor: ["a", 2] }, { anchor: [3, 4] }] }),
      ).toBeNull();
    });

    it("mints ids deterministically, above the highest existing one", () => {
      expect(mintSymbolId({ v: 1, symbols: [] })).toBe("sym-1");
      expect(
        mintSymbolId({
          v: 1,
          symbols: [
            { ...SQUARE_SYMBOL, id: "sym-3" },
            { ...SQUARE_SYMBOL, id: "imported" },
          ],
        }),
      ).toBe("sym-4");
      expect(mintSymbolInstanceId([])).toBe("si-1");
      expect(mintSymbolInstanceId(["si-2", "foreign", "si-7"])).toBe("si-8");
    });

    it("upsert / rename / remove are pure and no-op on an unknown id", () => {
      const one = { v: 1, symbols: [SQUARE_SYMBOL] };
      const two = upsertSymbol(one, { ...SQUARE_SYMBOL, id: "sym-2", name: "B" });
      expect(two.symbols.map((s) => s.id)).toEqual(["sym-1", "sym-2"]);
      expect(one.symbols).toHaveLength(1); // the input is untouched
      // Upsert REPLACES in place (a redefine keeps the row's position).
      expect(
        upsertSymbol(two, { ...SQUARE_SYMBOL, name: "redefined" }).symbols.map(
          (s) => s.name,
        ),
      ).toEqual(["redefined", "B"]);

      expect(renameSymbolIn(one, "sym-1", "New").symbols[0]!.name).toBe("New");
      expect(renameSymbolIn(one, "nope", "New")).toEqual(one);
      expect(renameSymbolIn(one, "sym-1", "")).toEqual(one);
      expect(removeSymbolFrom(one, "sym-1").symbols).toEqual([]);
      expect(removeSymbolFrom(one, "nope")).toEqual(one);
      expect(findSymbol(one, "sym-1")?.name).toBe("Tile");
      expect(findSymbol(one, "nope")).toBeNull();
    });
  });

  // ------------------------------------------- pure: registration (§16.1)

  describe("registration points (§16.1, pure)", () => {
    it("resolves all nine grid points over the control-point hull", () => {
      expect(SYMBOL_REGISTRATIONS).toHaveLength(9);
      expect(DEFAULT_SYMBOL_REGISTRATION).toBe("center");
      const bounds = symbolBoundsOf([square(250, 250, 50)])!;
      expect(bounds).toEqual([200, 200, 300, 300]);
      expect(registrationPointOf(bounds, "center")).toEqual([250, 250]);
      expect(registrationPointOf(bounds, "topLeft")).toEqual([200, 200]);
      expect(registrationPointOf(bounds, "top")).toEqual([250, 200]);
      expect(registrationPointOf(bounds, "topRight")).toEqual([300, 200]);
      expect(registrationPointOf(bounds, "left")).toEqual([200, 250]);
      expect(registrationPointOf(bounds, "right")).toEqual([300, 250]);
      expect(registrationPointOf(bounds, "bottomLeft")).toEqual([200, 300]);
      expect(registrationPointOf(bounds, "bottom")).toEqual([250, 300]);
      expect(registrationPointOf(bounds, "bottomRight")).toEqual([300, 300]);
    });

    it("bounds are the hull of ANCHORS AND HANDLES, not anchors alone", () => {
      const withHandle: AnchorTable = {
        anchors: [
          { anchor: [0, 0], left: [-10, 0], right: [0, 0] },
          { anchor: [10, 10], left: [10, 10], right: [10, 25] },
        ],
        subpathStarts: [0],
      };
      expect(symbolBoundsOf([withHandle])).toEqual([-10, 0, 10, 25]);
      expect(symbolBoundsOf([])).toBeNull();
    });

    it("a definition stores DEFINITION-space pieces + its capture origin", () => {
      expect(SQUARE_SYMBOL.origin).toEqual([250, 250]);
      expect(SQUARE_SYMBOL.pieces).toHaveLength(1);
      expect(
        SQUARE_SYMBOL.pieces[0]!.table.anchors.map((a) => a.anchor),
      ).toEqual([
        [-50, -50],
        [50, -50],
        [50, 50],
        [-50, 50],
      ]);
      // A corner registration moves the origin, not the shape.
      const corner = symbolDefinitionFrom({
        id: "sym-2",
        name: "corner",
        registration: "topLeft",
        sources: [{ table: square(250, 250, 50), paint: BLACK }],
      })!;
      expect(corner.origin).toEqual([200, 200]);
      expect(corner.pieces[0]!.table.anchors[0]!.anchor).toEqual([0, 0]);
      // Nothing measurable ⇒ no definition (never a zero-size fiction).
      expect(
        symbolDefinitionFrom({
          id: "x",
          name: "x",
          registration: "center",
          sources: [],
        }),
      ).toBeNull();
    });
  });

  // ------------------------------------------------- pure: the leaf link

  describe("the instance link (pure)", () => {
    it("reads tolerantly and preserves every other draw key", () => {
      expect(symbolInstanceOf(null)).toBeNull();
      expect(symbolInstanceOf({ v: 1, data: {} })).toBeNull();
      expect(
        symbolInstanceOf({ v: 1, data: { symbolInstance: { symbol: "sym-1" } } }),
      ).toBeNull();
      expect(
        symbolInstanceOf({
          v: 1,
          data: { symbolInstance: { symbol: "sym-1", instance: "si-1" } },
        }),
      ).toEqual({ symbol: "sym-1", instance: "si-1", piece: 0, origin: [0, 0] });

      const stack = { fills: [{ color: "Color/Black" }], strokes: [] };
      const withStack = { v: 1, data: { appearance: stack } };
      const linked = withSymbolInstance(withStack, {
        symbol: "sym-1",
        instance: "si-1",
        piece: 2,
        origin: [4, 5],
      });
      expect(linked!.data).toEqual({
        appearance: stack,
        symbolInstance: {
          symbol: "sym-1",
          instance: "si-1",
          piece: 2,
          origin: [4, 5],
        },
      });
      // BREAKING the link keeps everything else — the whole point.
      expect(withSymbolInstance(linked, null)!.data).toEqual({
        appearance: stack,
      });
      // …and an envelope that held NOTHING else collapses to null.
      expect(
        withSymbolInstance(
          {
            v: 1,
            data: {
              symbolInstance: {
                symbol: "s",
                instance: "i",
                piece: 0,
                origin: [0, 0],
              },
            },
          },
          null,
        ),
      ).toBeNull();
    });
  });

  // -------------------------------------------------- pure: wire builders

  describe("the wire builders (pure — the no-second-copy rule)", () => {
    const plan: SymbolPlacePlan = symbolPlacePlanFor({
      symbol: SQUARE_SYMBOL,
      pageId: "usp",
      instanceId: "si-1",
      origin: [500, 500],
    });

    it("the plan translates definition space to the placement origin", () => {
      expect(plan.pieces[0]!.table.anchors.map((a) => a.anchor)).toEqual([
        [450, 450],
        [550, 450],
        [550, 550],
        [450, 550],
      ]);
      expect(symbolContourCounts(plan)).toEqual([1]);
    });

    it("batch 1 is one insertPath per piece per contour", () => {
      const batch = symbolInsertBatchFor(plan) as Extract<
        Mutation,
        { op: "batch" }
      >;
      expect(batch.op).toBe("batch");
      expect(batch.args.ops).toEqual([
        {
          op: "insertPath",
          args: {
            pageId: "usp",
            anchors: [
              anchorAt([450, 450]),
              anchorAt([550, 450]),
              anchorAt([550, 550]),
              anchorAt([450, 550]),
            ],
            open: false,
          },
        },
      ]);
    });

    it("a REBUILD tears the old instance down in BATCH 2, never batch 1", () => {
      // MEASURED, not preferred: a batch that DELETES and then INSERTS is
      // refused by the engine — the insert's z-position resolves against
      // the spread length the batch started with (see the engine test
      // below, which drives the real rebuild). So batch 1 stays inserts
      // only and the teardown leads batch 2, where it sits next to the
      // deletes the compound re-merge already performs.
      const bindings = bindSymbolPieces(plan, [poly("u1")])!;
      const ops = (
        symbolFinishBatchFor({
          plan,
          bindings,
          replace: {
            group: { kind: "group", id: "g1" } as ElementId,
            stale: [poly("old1"), poly("old2")],
          },
        }) as Extract<Mutation, { op: "batch" }>
      ).args.ops;
      expect(ops.map((m) => m.op)).toEqual([
        "dissolveGroup",
        "deleteFrame",
        "deleteFrame",
        "setElementProperty",
        "setElementProperty",
        "setPluginMetadata",
      ]);
    });

    it("bindSymbolPieces chunks the minted ids back onto their pieces", () => {
      expect(bindSymbolPieces(plan, [poly("u1")])).toEqual([
        { pieceIndex: 0, keep: poly("u1"), absorb: [] },
      ]);
      // A count mismatch is a REFUSAL, never a guess.
      expect(bindSymbolPieces(plan, [])).toBeNull();
      expect(bindSymbolPieces(plan, [poly("u1"), poly("u2")])).toBeNull();
    });

    it("batch 2 paints, stamps the per-leaf link and does NOT group ONE piece", () => {
      const bindings = bindSymbolPieces(plan, [poly("u1")])!;
      const ops = (
        symbolFinishBatchFor({ plan, bindings }) as Extract<
          Mutation,
          { op: "batch" }
        >
      ).args.ops;
      // fill, stroke, stamp — no weight op (the piece carries none) and
      // NO createGroup: a group of one member would hold nothing.
      expect(ops.map((m) => m.op)).toEqual([
        "setElementProperty",
        "setElementProperty",
        "setPluginMetadata",
      ]);
      const stamp = ops[2]!;
      if (stamp.op !== "setPluginMetadata") throw new Error("unreachable");
      expect(stamp.args.key).toBe("x-paged:media.paged.draw");
      expect(stamp.args.caller).toBe("media.paged.draw");
      expect(
        symbolInstanceOf(JSON.parse(stamp.args.value as string)),
      ).toEqual({
        symbol: "sym-1",
        instance: "si-1",
        piece: 0,
        origin: [500, 500],
      });
    });

    it("a COMPOUND piece is re-merged through framePath, extras deleted", () => {
      const ring = symbolDefinitionFrom({
        id: "sym-9",
        name: "ring",
        registration: "center",
        sources: [
          {
            table: {
              anchors: [
                ...square(250, 250, 50).anchors,
                ...square(250, 250, 20).anchors,
              ],
              subpathStarts: [0, 4],
              subpathOpen: [false, false],
            },
            paint: { fill: "Color/Black", stroke: "Color/Paper", weight: 3 },
          },
        ],
      })!;
      const ringPlan = symbolPlacePlanFor({
        symbol: ring,
        pageId: "usp",
        instanceId: "si-2",
        origin: [400, 400],
      });
      expect(symbolContourCounts(ringPlan)).toEqual([2]);
      const bindings = bindSymbolPieces(ringPlan, [poly("u1"), poly("u2")])!;
      expect(bindings[0]).toEqual({
        pieceIndex: 0,
        keep: poly("u1"),
        absorb: [poly("u2")],
      });
      const ops = (
        symbolFinishBatchFor({ plan: ringPlan, bindings }) as Extract<
          Mutation,
          { op: "batch" }
        >
      ).args.ops;
      expect((ops[0] as { args: { path: string } }).args.path).toBe("framePath");
      expect(
        (ops[0] as { args: { value: { value: { subpathStarts: number[] } } } })
          .args.value.value.subpathStarts,
      ).toEqual([0, 4]);
      expect(ops[1]).toEqual({ op: "deleteFrame", args: { frameId: "u2" } });
      // …and the weight op IS emitted for a piece that carries one.
      expect(ops.map((m) => m.op)).toEqual([
        "setElementProperty", // framePath
        "deleteFrame",
        "setElementProperty", // fill
        "setElementProperty", // stroke
        "setElementProperty", // weight
        "setPluginMetadata",
      ]);
    });

    it("the unlink is ONE batch of stamps, whatever the leaf count", () => {
      const batch = symbolUnlinkBatchFor([
        { id: poly("a"), envelope: { v: 1, data: { keepMe: 1 } } },
        { id: poly("b"), envelope: null },
      ]) as Extract<Mutation, { op: "batch" }>;
      expect(batch.args.ops).toHaveLength(2);
      const first = batch.args.ops[0]!;
      if (first.op !== "setPluginMetadata") throw new Error("unreachable");
      expect(JSON.parse(first.args.value as string).data).toEqual({ keepMe: 1 });
      const second = batch.args.ops[1]!;
      if (second.op !== "setPluginMetadata") throw new Error("unreachable");
      // Nothing left to keep ⇒ the envelope is CLEARED, not left as `{}`.
      expect(second.args.value).toBeNull();
    });
  });

  // ------------------------------------------- the honest capability gate

  describe("a host with no `.paged` container writer", () => {
    const warnings: string[] = [];
    const noParts = {
      supports: () => false,
      log: {
        debug: () => {},
        info: () => {},
        warn: (m: string) => void warnings.push(m),
        error: () => {},
      },
      parts: {
        write: async () => {
          throw new Error("must not be reached");
        },
        read: async () => null,
        list: async () => [],
      },
    } as unknown as BundleHost;

    it("degrades with a warn — an empty library and a refused write, never a throw", async () => {
      warnings.length = 0;
      expect(await readSymbolLibrary(noParts)).toEqual({ v: 1, symbols: [] });
      expect(
        await writeSymbolLibrary(noParts, { v: 1, symbols: [SQUARE_SYMBOL] }),
      ).toBe(false);
      expect(warnings).toHaveLength(2);
      expect(warnings[0]).toContain('supports("storage.parts@1") is false');
      expect(warnings[1]).toContain("NOT saved");
    });
  });

  // --------------------------------------------------- against the engine

  describe("against the real engine (F6)", () => {
    let h: HeadlessHost;

    beforeAll(async () => {
      h = await openHost();
      h.loadBundle(drawBundle);
    });
    afterAll(() => h?.dispose());

    // A pristine document + an empty library per test: symbol operations
    // INSERT and DELETE page items, so chaining state across tests would
    // make the undo arithmetic unreadable.
    beforeEach(async () => {
      await h.load(F6_RING_PAIR.bytes());
      await h.host.parts.write(
        SYMBOLS_PART,
        serializeSymbolLibrary({ v: 1, symbols: [] }),
      );
      await h.host.selection.set([]);
    });

    it("registers the seven commands + the right-docked panel", () => {
      expect(SYMBOLS_COMMAND_IDS).toEqual([
        DEFINE_SYMBOL_COMMAND_ID,
        PLACE_SYMBOL_COMMAND_ID,
        REDEFINE_SYMBOL_COMMAND_ID,
        BREAK_SYMBOL_LINK_COMMAND_ID,
        RESET_SYMBOL_TRANSFORM_COMMAND_ID,
        RENAME_SYMBOL_COMMAND_ID,
        DELETE_SYMBOL_COMMAND_ID,
      ]);
      for (const id of SYMBOLS_COMMAND_IDS) {
        expect(commandFor(h, id).category).toBe("Symbols");
      }
      // The titles carry the honest verbs (there is no description field).
      expect(commandFor(h, REDEFINE_SYMBOL_COMMAND_ID).title).toContain(
        "rebuilds every instance",
      );
      expect(commandFor(h, DELETE_SYMBOL_COMMAND_ID).title).toContain(
        "the placed artwork stays",
      );
      const panel = h.panelsContributed().find((p) => p.id === SYMBOLS_PANEL_ID);
      expect(panel).toBeDefined();
      expect(panel!.title).toBe("Symbols (draw)");
      expect(panel!.defaultDock).toBe("right");
      expect(typeof panel!.component).toBe("function");
    });

    it("the host wires the container parts door this feature rides", () => {
      expect(h.host.supports("storage.parts@1")).toBe(true);
    });

    it("DEFINE writes the library and does NOT touch the document (0 undo steps)", async () => {
      const before = await signature(h);
      await h.host.selection.set([INNER]);
      await commandFor(h, DEFINE_SYMBOL_COMMAND_ID).handler(undefined, {
        name: "Tile",
      });

      // (1) the persistence shape — a SECOND part, under this plugin's
      // namespace, beside the graphic-style library.
      expect(await h.host.parts.list("")).toContain(SYMBOLS_PART);
      const library = parseSymbolLibrary(await h.host.parts.read(SYMBOLS_PART));
      expect(library.v).toBe(1);
      expect(library.symbols).toHaveLength(1);
      const symbol = library.symbols[0]!;
      expect(symbol.id).toBe("sym-1");
      expect(symbol.name).toBe("Tile");
      expect(symbol.registration).toBe("center");
      // The inner quad spans 200…300 on both axes ⇒ centre (250, 250).
      expect(symbol.origin).toEqual([250, 250]);
      expect(symbol.pieces).toHaveLength(1);
      expect(symbol.pieces[0]!.paint.fill).toBe("Color/Black");
      expect(symbol.pieces[0]!.table.anchors.map((a) => a.anchor)).toEqual([
        [-50, -50],
        [50, -50],
        [50, 50],
        [-50, 50],
      ]);

      // (2) nothing in the DOCUMENT moved — define captures, it does not
      // convert the selection into an instance.
      expect(await signature(h)).toBe(before);
      expect(await symbolInstances(h.host)).toEqual([]);
    });

    it("PLACE emits a linked instance — exactly TWO batches (C-15: measure it)", async () => {
      await h.host.selection.set([INNER]);
      await applyDefineSymbol(h.host, { name: "Tile" });
      const before = await signature(h);

      const created = await applyPlaceSymbolInstance(h.host, "sym-1", {
        x: 500,
        y: 500,
      });
      expect(created).toHaveLength(1);
      // A ONE-piece symbol is not wrapped in a group.
      expect(await groupShape(h)).toBeNull();
      expect(await leafIds(h)).toHaveLength(4);
      // The artwork really is the definition, anchored at (500, 500).
      const table = (await compoundSourceOf(h.host, created[0]!))!.table;
      expect(table.anchors.map((a) => a.anchor)).toEqual([
        [450, 450],
        [550, 450],
        [550, 550],
        [450, 550],
      ]);
      // …carrying the definition's paint and the link.
      const ref = symbolInstanceOf(await h.host.document.getMetadata(created[0]!));
      expect(ref).toEqual({
        symbol: "sym-1",
        instance: "si-1",
        piece: 0,
        origin: [500, 500],
      });
      const instances = await symbolInstances(h.host);
      expect(instances).toHaveLength(1);
      expect(instances[0]!.leaves.map((l) => l.id)).toEqual([created[0]!.id]);
      // The new instance is selected.
      expect(h.host.selection.get().map((s) => s.id)).toEqual([created[0]!.id]);

      // …and TWO undos put the document back — MEASURED, not claimed.
      // (`insertPath` mints the ids batch 2 addresses, and this contract's
      // Mutation union carries no C-15 `bindCreated` arm to bind them
      // inside one batch — see the module header.)
      await h.host.document.undo();
      expect(await signature(h)).not.toBe(before);
      await h.host.document.undo();
      expect(await signature(h)).toBe(before);
    });

    it("a SECOND place mints a fresh instance id and both follow the symbol", async () => {
      await h.host.selection.set([INNER]);
      await applyDefineSymbol(h.host, { name: "Tile" });
      await applyPlaceSymbolInstance(h.host, "sym-1", { x: 450, y: 450 });
      await applyPlaceSymbolInstance(h.host, "sym-1", { x: 150, y: 600 });
      const instances = await symbolInstances(h.host, "sym-1");
      expect(instances.map((i) => i.instance).sort()).toEqual(["si-1", "si-2"]);
      expect(instances.map((i) => i.origin)).toEqual(
        expect.arrayContaining([
          [450, 450],
          [150, 600],
        ]),
      );
    });

    it("a MULTI-PIECE symbol places as a GROUP of linked leaves", async () => {
      await h.host.selection.set([INNER, OUTER]);
      const symbol = await applyDefineSymbol(h.host, { name: "Pair" });
      expect(symbol!.pieces).toHaveLength(2);
      // The hull of both quads is 100…400 ⇒ centre (250, 250).
      expect(symbol!.origin).toEqual([250, 250]);

      const created = await applyPlaceSymbolInstance(h.host, "sym-1", {
        x: 250,
        y: 550,
      });
      expect(created).toHaveLength(2);
      const group = await groupShape(h);
      expect(group!.members.sort()).toEqual(created.map((c) => c.id).sort());
      // Every leaf carries the link, with its own piece index.
      const refs = [];
      for (const id of created) {
        refs.push(symbolInstanceOf(await h.host.document.getMetadata(id)));
      }
      expect(refs.map((r) => r!.piece)).toEqual([0, 1]);
      expect(new Set(refs.map((r) => r!.instance))).toEqual(new Set(["si-1"]));
      // …and the instance reads back as ONE instance of two leaves.
      const instances = await symbolInstances(h.host);
      expect(instances).toHaveLength(1);
      expect(instances[0]!.leaves).toHaveLength(2);
    });

    it("a COMPOUND source keeps its HOLE through a place", async () => {
      await h.host.selection.set([OUTER, INNER]);
      expect(await applyMakeCompoundPath(h.host)).toBe(2);
      await h.host.selection.set([OUTER]);
      const symbol = await applyDefineSymbol(h.host, { name: "Ring" });
      expect(symbol!.pieces).toHaveLength(1);
      expect(symbol!.pieces[0]!.table.subpathStarts).toEqual([0, 4]);

      const created = await applyPlaceSymbolInstance(h.host, "sym-1", {
        x: 250,
        y: 550,
      });
      // The piece was inserted contour by contour and re-merged, so ONE
      // element survives — still a ring.
      expect(created).toHaveLength(1);
      expect(
        contourCountOf((await compoundSourceOf(h.host, created[0]!))!.table),
      ).toBe(2);
    });

    it("RESET TRANSFORM re-emits the definition in place — TWO undo steps", async () => {
      await h.host.selection.set([INNER]);
      await applyDefineSymbol(h.host, { name: "Tile" });
      const [placed] = await applyPlaceSymbolInstance(h.host, "sym-1", {
        x: 500,
        y: 500,
      });
      expect(await sizeOf(h, placed!)).toEqual([100, 100]);

      // Deform the instance: drag one anchor far out. Its artwork is no
      // longer the definition's shape…
      const moved = await h.host.document.mutate({
        op: "pathPointSet",
        args: {
          elementId: placed!,
          index: 0,
          role: "anchor",
          position: [350, 350],
        },
      });
      expect(moved.applied).toBe(true);
      expect(await sizeOf(h, placed!)).toEqual([200, 200]);
      const deformed = await signature(h);

      // MEASURED, and the reason `liveInstanceOrigin` reads contours and
      // not `elementGeometry`: an element's reported bounds are its
      // DECLARED GeometricBounds and do NOT follow an anchor edit, so a
      // reset anchored on them would re-emit at a stale centre.
      const reported = (await h.host.document.elementGeometry([placed!]))[0]!;
      expect(reported.bounds).toEqual([450, 450, 550, 550]);
      expect(
        await liveInstanceOrigin(
          h.host,
          (await symbolInstances(h.host))[0]!,
          "center",
        ),
      ).toEqual([450, 450]);

      // …and RESET puts the definition's own shape back, re-anchored at
      // the instance's CURRENT registration point (the deformed hull is
      // 350…550 ⇒ centre 450). Position survives, shape does not.
      await h.host.selection.set([placed!]);
      expect(await applyResetSymbolTransform(h.host)).toBe(1);
      const after = await symbolInstances(h.host);
      expect(after).toHaveLength(1);
      // A REBUILD mints new element ids — the INSTANCE id is what survives.
      expect(after[0]!.instance).toBe("si-1");
      expect(after[0]!.leaves[0]!.id).not.toBe(placed!.id);
      expect(await sizeOf(h, after[0]!.leaves[0]!)).toEqual([100, 100]);
      expect(
        (await compoundSourceOf(h.host, after[0]!.leaves[0]!))!.table.anchors.map(
          (a) => a.anchor,
        ),
      ).toEqual([
        [400, 400],
        [500, 400],
        [500, 500],
        [400, 500],
      ]);

      // TWO undos put the deformed instance back — measured.
      await h.host.document.undo();
      await h.host.document.undo();
      expect(await signature(h)).toBe(deformed);
    });

    it("REDEFINE rebuilds EVERY instance at its own position", async () => {
      await h.host.selection.set([INNER]);
      await applyDefineSymbol(h.host, { name: "Tile" });
      const [a] = await applyPlaceSymbolInstance(h.host, "sym-1", {
        x: 200,
        y: 550,
      });
      const [b] = await applyPlaceSymbolInstance(h.host, "sym-1", {
        x: 450,
        y: 550,
      });
      expect(await sizeOf(h, a!)).toEqual([100, 100]);

      // Redefine from the OUTER quad (300 × 300) under the same id/name.
      await h.host.selection.set([OUTER]);
      const redefined = await applyRedefineSymbol(h.host, "sym-1");
      expect(redefined!.id).toBe("sym-1");
      expect(redefined!.name).toBe("Tile"); // the name survives a redefine
      expect(
        parseSymbolLibrary(await h.host.parts.read(SYMBOLS_PART)).symbols[0]!
          .origin,
      ).toEqual([250, 250]);

      const instances = await symbolInstances(h.host, "sym-1");
      expect(instances.map((i) => i.instance).sort()).toEqual(["si-1", "si-2"]);
      // Both grew to the new definition, each around its OWN centre.
      for (const instance of instances) {
        expect(await sizeOf(h, instance.leaves[0]!)).toEqual([300, 300]);
      }
      expect(instances.map((i) => i.origin).sort()).toEqual([
        [200, 550],
        [450, 550],
      ]);
      // The old leaves are gone (a rebuild replaces artwork).
      expect(await leafIds(h)).not.toContain(a!.id);
      expect(await leafIds(h)).not.toContain(b!.id);
    });

    it("BREAK LINK drops the reference, keeps the artwork — ONE undo step", async () => {
      await h.host.selection.set([INNER, OUTER]);
      await applyDefineSymbol(h.host, { name: "Pair" });
      const created = await applyPlaceSymbolInstance(h.host, "sym-1", {
        x: 250,
        y: 550,
      });
      expect(created).toHaveLength(2);
      const before = await signature(h);
      const geometryBefore = await sizeOf(h, created[0]!);

      // Select ONE leaf: the whole instance unlinks (the link is per-leaf,
      // the instance is the unit).
      await h.host.selection.set([created[0]!]);
      await commandFor(h, BREAK_SYMBOL_LINK_COMMAND_ID).handler(undefined);
      expect(await symbolInstances(h.host)).toEqual([]);
      // The artwork and its group are untouched.
      expect(await leafIds(h)).toHaveLength(5);
      expect((await groupShape(h))!.members).toHaveLength(2);
      expect(await sizeOf(h, created[0]!)).toEqual(geometryBefore);

      // ONE undo restores both links — one batch, one step.
      await h.host.document.undo();
      expect(await signature(h)).toBe(before);
      expect(await symbolInstances(h.host)).toHaveLength(1);
    });

    it("selecting the GROUP reaches the instance the leaves carry", async () => {
      await h.host.selection.set([INNER, OUTER]);
      await applyDefineSymbol(h.host, { name: "Pair" });
      await applyPlaceSymbolInstance(h.host, "sym-1", { x: 250, y: 550 });
      const group = await groupShape(h);
      await h.host.selection.set([
        { kind: "group", id: group!.id } as ElementId,
      ]);
      // (A group cannot carry metadata at all — `setPluginMetadata`
      // answers `notImplemented` for a group id — which is exactly why the
      // link lives on every leaf and the selection is expanded.)
      expect(await applyBreakSymbolLink(h.host)).toBe(1);
      expect(await symbolInstances(h.host)).toEqual([]);
    });

    it("RENAME is library-only — no document mutation at all", async () => {
      await h.host.selection.set([INNER]);
      await applyDefineSymbol(h.host, { name: "Tile" });
      await applyPlaceSymbolInstance(h.host, "sym-1", { x: 500, y: 500 });
      const before = await signature(h);

      expect(await applyRenameSymbol(h.host, "sym-1", "  Badge  ")).toBe(true);
      expect(
        parseSymbolLibrary(await h.host.parts.read(SYMBOLS_PART)).symbols[0]!
          .name,
      ).toBe("Badge");
      // The leaf stores the ID and nothing else, so a rename never walks
      // the document — and nothing became undoable.
      expect(await signature(h)).toBe(before);
      expect((await symbolInstances(h.host))[0]!.symbol).toBe("sym-1");
      // An unknown id / an empty name refuse rather than corrupt.
      expect(await applyRenameSymbol(h.host, "nope", "x")).toBe(false);
      expect(await applyRenameSymbol(h.host, "sym-1", "   ")).toBe(false);
    });

    it("the LIBRARY is NOT on the undo stack (a container write is no mutation)", async () => {
      await h.host.selection.set([INNER]);
      await applyDefineSymbol(h.host, { name: "Tile" });
      await applyPlaceSymbolInstance(h.host, "sym-1", { x: 500, y: 500 });
      const leavesBefore = await leafIds(h);

      await writeSymbolLibrary(h.host, {
        v: 1,
        symbols: [{ ...SQUARE_SYMBOL, id: "sym-9", name: "probe" }],
      });
      // Undo unwinds the MUTATION (the place's batch 2) and leaves the
      // part exactly as written.
      await h.host.document.undo();
      expect(await leafIds(h)).toEqual(leavesBefore);
      expect(
        parseSymbolLibrary(await h.host.parts.read(SYMBOLS_PART)).symbols.map(
          (s) => s.id,
        ),
      ).toEqual(["sym-9"]);
    });

    it("DELETE unlinks every instance in ONE batch, and the ARTWORK STAYS", async () => {
      await h.host.selection.set([INNER]);
      await applyDefineSymbol(h.host, { name: "Doomed" });
      await applyPlaceSymbolInstance(h.host, "sym-1", { x: 200, y: 550 });
      await applyPlaceSymbolInstance(h.host, "sym-1", { x: 450, y: 550 });
      expect(await symbolInstances(h.host)).toHaveLength(2);
      const leavesBefore = await leafIds(h);
      const before = await signature(h);

      await commandFor(h, DELETE_SYMBOL_COMMAND_ID).handler(undefined, {
        symbolId: "sym-1",
      });
      expect(
        parseSymbolLibrary(await h.host.parts.read(SYMBOLS_PART)).symbols,
      ).toEqual([]);
      // No leaf is left pointing at a symbol that is gone…
      expect(await symbolInstances(h.host)).toEqual([]);
      // …and every placed element survives (deleting a symbol is not
      // deleting a page).
      expect(await leafIds(h)).toEqual(leavesBefore);

      // ONE undo restores both instances' links — one batch, one step.
      await h.host.document.undo();
      expect(await signature(h)).toBe(before);
    });

    it("REFUSES a text frame: no mutation can copy a story", async () => {
      const inserted = await h.host.document.mutate({
        op: "insertTextFrame",
        args: { pageId: F6_RING_PAIR.pageId, bounds: [600, 100, 700, 300] },
      });
      expect(inserted.applied).toBe(true);
      const textFrame = inserted.applied ? inserted.createdId : null;
      expect(textFrame).not.toBeNull();

      await h.host.selection.set([textFrame!]);
      expect(await captureSymbolSources(h.host, "probe")).toEqual([]);
      expect(await applyDefineSymbol(h.host, { name: "Words" })).toBeNull();
      expect(
        parseSymbolLibrary(await h.host.parts.read(SYMBOLS_PART)).symbols,
      ).toEqual([]);

      // A MIXED selection keeps the reachable half and refuses the rest.
      await h.host.selection.set([textFrame!, INNER]);
      const symbol = await applyDefineSymbol(h.host, { name: "Mixed" });
      expect(symbol!.pieces).toHaveLength(1);
    });

    it("RESIDUAL, pinned: an OFF-PAGE instance is real but unmeasurable (C-23)", async () => {
      await h.host.selection.set([INNER]);
      await applyDefineSymbol(h.host, { name: "Tile" });
      // Well outside the 612 × 792 page: the element IS created and IS in
      // the tree, but `elementGeometry` / `pathAnchors` are PAGE-KEYED and
      // an item outside every page belongs to no page.
      const created = await applyPlaceSymbolInstance(h.host, "sym-1", {
        x: 4000,
        y: 4000,
      });
      expect(created).toHaveLength(1);
      expect(await leafIds(h)).toContain(created[0]!.id);
      expect(await compoundSourceOf(h.host, created[0]!)).toBeNull();
      const instance = (await symbolInstances(h.host))[0]!;
      expect(await liveInstanceOrigin(h.host, instance, "center")).toBeNull();

      // Handled rather than left mute: RESET falls back to the RECORDED
      // origin, so the instance still rebuilds — in place, off-page.
      await h.host.selection.set([created[0]!]);
      expect(await applyResetSymbolTransform(h.host)).toBe(1);
      const rebuilt = (await symbolInstances(h.host))[0]!;
      expect(rebuilt.instance).toBe("si-1");
      expect(rebuilt.origin).toEqual([4000, 4000]);
      expect(rebuilt.leaves[0]!.id).not.toBe(created[0]!.id);
    });

    it("refuses honestly on an empty selection / an unknown symbol", async () => {
      await h.host.selection.set([]);
      expect(await applyDefineSymbol(h.host)).toBeNull();
      expect(await applyPlaceSymbolInstance(h.host, "sym-404")).toEqual([]);
      expect(await applyPlaceSymbolInstance(h.host, undefined)).toEqual([]);
      expect(await applyRedefineSymbol(h.host, "sym-404")).toBeNull();
      expect(await applyResetSymbolTransform(h.host)).toBe(0);
      expect(await applyBreakSymbolLink(h.host)).toBe(0);
      expect(await applyDeleteSymbol(h.host, "sym-404")).toBe(false);
      expect(await applyRenameSymbol(h.host, "", "x")).toBe(false);
      // Every command handler resolves rather than throwing.
      for (const id of SYMBOLS_COMMAND_IDS) {
        await expect(
          commandFor(h, id).handler(undefined, { symbolId: "sym-404" }),
        ).resolves.toBeUndefined();
      }
      expect(await leafIds(h)).toEqual(["uinner", "uopen", "uouter"]);
    });

    it("expandToLeaves resolves a GROUP to its leaves and dedupes", async () => {
      await h.host.selection.set([INNER, OUTER]);
      await applyDefineSymbol(h.host, { name: "Pair" });
      const created = await applyPlaceSymbolInstance(h.host, "sym-1", {
        x: 250,
        y: 550,
      });
      const group = await groupShape(h);
      const roots = await h.host.document.tree();
      expect(
        expandToLeaves(roots, [
          { kind: "group", id: group!.id } as ElementId,
          created[0]!,
        ]).map((e) => e.id),
      ).toEqual(created.map((c) => c.id));
      expect(expandToLeaves(roots, [INNER]).map((e) => e.id)).toEqual([
        INNER.id,
      ]);
    });
  });

  // ------------------------------------------------------------ the panel

  describe("the panel surface", () => {
    it("the row label names the artwork, the registration and the blast radius", () => {
      expect(symbolRowLabel(SQUARE_SYMBOL, 3)).toBe(
        "1 piece · center registration · 3 instances",
      );
      expect(
        symbolRowLabel(
          {
            ...SQUARE_SYMBOL,
            registration: "topLeft",
            pieces: [...SQUARE_SYMBOL.pieces, ...SQUARE_SYMBOL.pieces],
          },
          1,
        ),
      ).toBe("2 pieces · topLeft registration · 1 instance");
    });

    it("the inline note NAMES the semantics and every honest limit", () => {
      // The feature's substance.
      expect(SYMBOLS_NOTE).toContain("named DEFINITION");
      expect(SYMBOLS_NOTE).toContain("INSTANCE linked back to it");
      expect(SYMBOLS_NOTE).toContain("Redefine rebuilds every instance");
      expect(SYMBOLS_NOTE).toContain("Reset transform re-emits");
      expect(SYMBOLS_NOTE).toContain("Break link keeps the artwork");
      // The static-instance decision, stated where the author can read it.
      expect(SYMBOLS_NOTE).toContain("Instances are STATIC in v0");
      // Where the library lives — and that it is outside the undo stack.
      expect(SYMBOLS_NOTE).toContain("paged/media.paged.draw/symbols.json");
      expect(SYMBOLS_NOTE).toContain("NOT UNDOABLE");
      // The limits that are real and must not quietly disappear.
      expect(SYMBOLS_NOTE).toContain("no symbol primitive");
      expect(SYMBOLS_NOTE).toContain("no element-duplicate op");
      expect(SYMBOLS_NOTE).toContain("TEXT IS REFUSED");
      expect(SYMBOLS_NOTE).toContain("A rebuild mints new element ids");
      // The catalog rows this v0 explicitly does NOT build.
      expect(SYMBOLS_NOTE).toContain(
        "Sprayer, Shifter, Scruncher, Sizer, Spinner, Stainer, Screener, Styler",
      );
      expect(SYMBOLS_NOTE).toContain("nine-slice scaling and 3D mapping are NOT built");
    });
  });
});
