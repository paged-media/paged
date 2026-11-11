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

// SYMBOLS — the v0 library a document made before the engine kept
// symbols (draw ADR 356), and the wire builders its migration emits
// (draw ADR 365). The commands run on the engine's symbols: their spec is
// symbols-engine.spec.ts; the migration's is symbols-migrate.spec.ts.
// What this pins:
//
//   (1) the PERSISTENCE shape — the library is a `.paged` container part
//       (`paged/media.paged.draw/symbols.json`), and a corrupt / foreign /
//       future-versioned part degrades to an empty library instead of
//       taking the document with it;
//   (2) REGISTRATION (§16.1): the nine-point grid resolved over bounds;
//   (3) the exact WIRE shapes of the place plan and the finish batch —
//       the rebuild's tear-down, the compound re-merge, the paint, the
//       per-leaf stamp, and no group around one piece;
//   (4) the commands and the panel the bundle registers.

import { describe, expect, it, beforeAll, afterAll } from "bun:test";

import type {
  CommandContribution,
  ElementId,
  Mutation,
} from "@paged-media/plugin-api";
import type { AnchorTable } from "@paged-media/vector-geometry";
import type { HeadlessHost } from "@paged-media/plugin-sdk";

import {
  drawBundle,
  parseAnchorTable,
  parseSymbolLibrary,
  registrationPointOf,
  serializeSymbolLibrary,
  symbolContourCounts,
  symbolFinishBatchFor,
  symbolInstanceOf,
  symbolPlacePlanFor,
  symbolRowLabel,
  BREAK_SYMBOL_LINK_COMMAND_ID,
  DEFAULT_SYMBOL_REGISTRATION,
  DEFINE_SYMBOL_COMMAND_ID,
  DELETE_SYMBOL_COMMAND_ID,
  PLACE_SYMBOL_COMMAND_ID,
  REDEFINE_SYMBOL_COMMAND_ID,
  RENAME_SYMBOL_COMMAND_ID,
  RESET_SYMBOL_TRANSFORM_COMMAND_ID,
  SYMBOLS_COMMAND_IDS,
  SYMBOLS_PANEL_ID,
  SYMBOL_REGISTRATIONS,
  type SymbolDefinition,
  type SymbolPlacePlan,
} from "../../src";
import { openHost } from "./host";

const poly = (id: string): ElementId => ({ kind: "polygon", id }) as ElementId;

const anchorAt = (p: [number, number]) => ({
  anchor: [p[0], p[1]] as [number, number],
  left: [p[0], p[1]] as [number, number],
  right: [p[0], p[1]] as [number, number],
});

/** An axis-aligned square, corner-collapsed handles — the pure fixture. */
const square = (cx: number, cy: number, half: number): AnchorTable => ({
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
const SQUARE_SYMBOL: SymbolDefinition = {
  id: "sym-1",
  name: "Tile",
  registration: "center",
  origin: [250, 250],
  pieces: [{ table: square(0, 0, 50), paint: BLACK }],
};

function commandFor(h: HeadlessHost, id: string): CommandContribution {
  const rec = h.contributions.find((c) => c.kind === "command" && c.id === id);
  if (!rec) throw new Error(`no command recorded for ${id}`);
  return rec.value as CommandContribution;
}

describe("draw conformance — SYMBOLS (Illustrator Phase 2, §16.1)", () => {
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
        parseAnchorTable({
          anchors: [{ anchor: ["a", 2] }, { anchor: [3, 4] }],
        }),
      ).toBeNull();
    });
  });

  describe("registration points (§16.1, pure)", () => {
    it("resolves all nine grid points over the control-point hull", () => {
      expect(SYMBOL_REGISTRATIONS).toHaveLength(9);
      expect(DEFAULT_SYMBOL_REGISTRATION).toBe("center");
      const bounds = [200, 200, 300, 300] as const;
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
  });

  describe("the instance link (pure)", () => {
    it("reads tolerantly", () => {
      expect(symbolInstanceOf(null)).toBeNull();
      expect(symbolInstanceOf({ v: 1, data: {} })).toBeNull();
      expect(
        symbolInstanceOf({
          v: 1,
          data: { symbolInstance: { symbol: "sym-1" } },
        }),
      ).toBeNull();
      expect(
        symbolInstanceOf({
          v: 1,
          data: { symbolInstance: { symbol: "sym-1", instance: "si-1" } },
        }),
      ).toEqual({
        symbol: "sym-1",
        instance: "si-1",
        piece: 0,
        origin: [0, 0],
      });
    });
  });

  describe("the wire builders (pure)", () => {
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

    it("a REBUILD tears the old instance down before the finish", () => {
      const bindings = [{ pieceIndex: 0, keep: poly("u1"), absorb: [] }];
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

    it("the finish paints, stamps the per-leaf link and does NOT group ONE piece", () => {
      const bindings = [{ pieceIndex: 0, keep: poly("u1"), absorb: [] }];
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
      expect(symbolInstanceOf(JSON.parse(stamp.args.value as string))).toEqual({
        symbol: "sym-1",
        instance: "si-1",
        piece: 0,
        origin: [500, 500],
      });
    });

    it("a COMPOUND piece is re-merged through framePath, extras deleted", () => {
      const ring: SymbolDefinition = {
        id: "sym-9",
        name: "ring",
        registration: "center",
        origin: [250, 250],
        pieces: [
          {
            table: {
              anchors: [
                ...square(0, 0, 50).anchors,
                ...square(0, 0, 20).anchors,
              ],
              subpathStarts: [0, 4],
              subpathOpen: [false, false],
            },
            paint: { fill: "Color/Black", stroke: "Color/Paper", weight: 3 },
          },
        ],
      };
      const ringPlan = symbolPlacePlanFor({
        symbol: ring,
        pageId: "usp",
        instanceId: "si-2",
        origin: [400, 400],
      });
      expect(symbolContourCounts(ringPlan)).toEqual([2]);
      const bindings = [
        { pieceIndex: 0, keep: poly("u1"), absorb: [poly("u2")] },
      ];
      const ops = (
        symbolFinishBatchFor({ plan: ringPlan, bindings }) as Extract<
          Mutation,
          { op: "batch" }
        >
      ).args.ops;
      expect((ops[0] as { args: { path: string } }).args.path).toBe(
        "framePath",
      );
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
  });

  describe("the bundle", () => {
    let h: HeadlessHost;

    beforeAll(async () => {
      h = await openHost();
      h.loadBundle(drawBundle);
    });
    afterAll(() => h?.dispose());

    it("registers the nine commands + the right-docked panel", () => {
      expect(SYMBOLS_COMMAND_IDS).toEqual([
        DEFINE_SYMBOL_COMMAND_ID,
        PLACE_SYMBOL_COMMAND_ID,
        REDEFINE_SYMBOL_COMMAND_ID,
        BREAK_SYMBOL_LINK_COMMAND_ID,
        RESET_SYMBOL_TRANSFORM_COMMAND_ID,
        RENAME_SYMBOL_COMMAND_ID,
        DELETE_SYMBOL_COMMAND_ID,
        // WP6.8 (draw ADR 365) — the engine lane's Replace and Options.
        "media.paged.draw.command.replaceSymbol",
        "media.paged.draw.command.symbolOptions",
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
      const panel = h
        .panelsContributed()
        .find((p) => p.id === SYMBOLS_PANEL_ID);
      expect(panel).toBeDefined();
      expect(panel!.title).toBe("Symbols");
      expect(panel!.defaultDock).toBe("right");
      expect(typeof panel!.component).toBe("function");
    });
  });

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
      ).toBe("2 pieces · top left registration · 1 instance");
    });
  });
});
