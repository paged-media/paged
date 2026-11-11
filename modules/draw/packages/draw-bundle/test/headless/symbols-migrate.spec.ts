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

// WP6.8 (draw ADR 365) — a v0 symbol library (draw ADR 355 / 356: the
// definition a container part, an instance re-emitted artwork with a link
// on every leaf) moves onto the engine's symbols when the host keeps them:
// one symbol per definition (name and id kept), one instance per v0
// instance where it was (its transform fitted to the live anchors), the v0
// artwork gone, ONE undo step, and never twice. [plugin-draw.symbols]

import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import type { BundleHost, ElementId } from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";

import {
  drawBundle,
  insertPathMutationFor,
  migrateSymbolLibrary,
  readEngineSymbols,
  readInstanceStates,
  readSymbolLibrary,
  symbolFinishBatchFor,
  symbolInstances,
  symbolPlacePlanFor,
  writeSymbolLibrary,
  type SymbolDefinition,
} from "../../src";
import { packageWithSpread } from "../fixtures/build-idml";
import { poly, squareItem } from "../panels/panel-document";
import { openHost } from "./host";

const corner = (x: number, y: number) => ({
  anchor: [x, y] as [number, number],
  left: [x, y] as [number, number],
  right: [x, y] as [number, number],
});

/** The v0 definition of the 40 pt square "a" (top-left 50, 50): its
 *  registration point the centre, its piece in definition space. */
const TILE: SymbolDefinition = {
  id: "sym-1",
  name: "Tile",
  registration: "center",
  origin: [70, 70],
  pieces: [
    {
      table: {
        anchors: [
          corner(-20, -20),
          corner(20, -20),
          corner(20, 20),
          corner(-20, 20),
        ],
        subpathStarts: [0],
        subpathOpen: [false],
      },
      paint: { fill: "Color/Black", stroke: null, weight: null },
    },
  ],
};

/** A v0 instance as a document made before the engine kept symbols
 *  carries it: the definition re-emitted at `origin`, a link on each leaf. */
async function placeV0(
  host: BundleHost,
  pageId: string,
  instanceId: string,
  origin: [number, number],
): Promise<void> {
  const plan = symbolPlacePlanFor({ symbol: TILE, pageId, instanceId, origin });
  const leaves: ElementId[] = [];
  for (const piece of plan.pieces) {
    const out = await host.document.mutate(
      insertPathMutationFor(pageId, piece.table.anchors, false),
    );
    if (!out.applied || !out.createdId) throw new Error("insert refused");
    leaves.push(out.createdId);
  }
  const finished = await host.document.mutate(
    symbolFinishBatchFor({
      plan,
      bindings: leaves.map((keep, pieceIndex) => ({
        pieceIndex,
        keep,
        absorb: [],
      })),
    }),
  );
  expect(finished.applied).toBe(true);
}

describe("draw conformance — a v0 symbol library moves onto the engine (WP6.8) [plugin-draw.symbols]", () => {
  let h: HeadlessHost;

  beforeAll(async () => {
    h = await openHost();
    await h.load(packageWithSpread(squareItem("a", 50, 50, 40)));
    h.loadBundle(drawBundle);
  });
  afterAll(() => h?.dispose());

  it("definitions become engine symbols and v0 instances engine instances, in ONE undo step", async () => {
    // The v0 state: the library part and two re-emitted instances.
    const def = TILE;
    const [square] = await h.host.document.elementGeometry([poly("a")]);
    const pageId = square!.pageId!;
    expect(await writeSymbolLibrary(h.host, { v: 1, symbols: [TILE] })).toBe(
      true,
    );
    await placeV0(h.host, pageId, "si-1", [300, 200]);
    await placeV0(h.host, pageId, "si-2", [120, 500]);
    const v0 = await symbolInstances(h.host, def.id);
    expect(v0).toHaveLength(2);
    const v0Leaves = v0.flatMap((i) => i.leaves);

    const moved = await migrateSymbolLibrary(h.host);
    expect(moved).toEqual({ symbols: 1, instances: 2 });
    const rows = await readEngineSymbols(h.host);
    expect(rows.map((r) => [r.id, r.name])).toEqual([[def.id, "Tile"]]);
    expect(rows[0]!.instances).toHaveLength(2);
    // Each instance sits where its v0 artwork was: the 40 pt square's
    // centre at the registration point the v0 instance was placed at.
    const states = await readInstanceStates(
      h.host,
      rows[0]!.instances.map(
        (a) => ({ kind: "instance", id: a.slice(9) }) as never,
      ),
    );
    const centres = states
      .map((s) => [Math.round(s.matrix[4]), Math.round(s.matrix[5])])
      .sort((p, q) => p[0]! - q[0]!);
    expect(centres).toEqual([
      [120, 500],
      [300, 200],
    ]);
    for (const s of states)
      expect(
        s.matrix.slice(0, 4).map((v) => Math.round(v * 1e6) / 1e6),
      ).toEqual([1, 0, 0, 1]);
    // The v0 artwork is gone; the source square stays.
    const geo = await h.host.document.elementGeometry(v0Leaves);
    expect(geo).toHaveLength(0);
    expect(await h.host.document.elementGeometry([poly("a")])).toHaveLength(1);
    // The library records the move, and a second run moves nothing.
    expect((await readSymbolLibrary(h.host)).migrated).toEqual({
      [def.id]: def.id,
    });
    expect(await migrateSymbolLibrary(h.host)).toBeNull();
    // ONE undo takes the whole migration back.
    await h.host.document.undo();
    expect(await readEngineSymbols(h.host)).toEqual([]);
    expect(await h.host.document.elementGeometry(v0Leaves)).toHaveLength(
      v0Leaves.length,
    );
  });
});
