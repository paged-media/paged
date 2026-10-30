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

import type { HeadlessHost } from "@paged-media/plugin-sdk";

import {
  applyDefineSymbol,
  applyPlaceSymbolInstance,
  drawBundle,
  migrateSymbolLibrary,
  readEngineSymbols,
  readInstanceStates,
  readSymbolLibrary,
  symbolInstances,
} from "../../src";
import { packageWithSpread } from "../fixtures/build-idml";
import { poly, squareItem } from "../panels/panel-document";
import { openHost } from "./host";

describe("draw conformance — a v0 symbol library moves onto the engine (WP6.8) [plugin-draw.symbols]", () => {
  let h: HeadlessHost;

  beforeAll(async () => {
    h = await openHost();
    await h.load(packageWithSpread(squareItem("a", 50, 50, 40)));
    h.loadBundle(drawBundle);
  });
  afterAll(() => h?.dispose());

  it("definitions become engine symbols and v0 instances engine instances, in ONE undo step", async () => {
    // Build the v0 state on a host that says it keeps no symbols.
    const supports = h.host.supports.bind(h.host);
    (h.host as { supports: (f: string) => boolean }).supports = (f) =>
      f !== "document.symbols@1" && supports(f);
    await h.host.selection.set([poly("a")]);
    const def = (await applyDefineSymbol(h.host, { name: "Tile" }))!;
    await applyPlaceSymbolInstance(h.host, def.id, { x: 300, y: 200 });
    await applyPlaceSymbolInstance(h.host, def.id, { x: 120, y: 500 });
    const v0 = await symbolInstances(h.host, def.id);
    expect(v0).toHaveLength(2);
    const v0Leaves = v0.flatMap((i) => i.leaves);
    // The engine is back.
    (h.host as { supports: (f: string) => boolean }).supports = supports;

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
