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

// SYMBOLS on the engine's instance node (engine ADR 1039) — the draw
// commands through the REAL engine wasm, on a host that says
// `supports("document.symbols@1")`: define keeps the selection and adds a
// document symbol, place makes an `instance:` item, redefine reaches every
// instance, break link gives the artwork back, rename and delete are one
// undo step each — and the re-emitted lane (`symbols.spec.ts`) stays the
// fallback for a host without the flag.

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";

import type { CommandContribution, ElementId } from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";

import {
  drawBundle,
  applyBreakSymbolLink,
  applyDefineSymbol,
  applyDeleteSymbol,
  applyPlaceSymbolInstance,
  applyRedefineSymbol,
  applyRenameSymbol,
  applyResetSymbolTransform,
  SELECT_SAME_SYMBOL_COMMAND_ID,
} from "../../src";
import {
  ENGINE_SYMBOLS_FEATURE,
  engineSymbols,
  readEngineSymbols,
} from "../../src/commands/symbols-engine";
import { F6_RING_PAIR } from "../fixtures/corpus";
import { openHost, withoutEngineSymbols } from "./host";

const poly = (id: string): ElementId => ({ kind: "polygon", id }) as ElementId;
const INNER = poly(F6_RING_PAIR.innerId);
const OUTER = poly(F6_RING_PAIR.ids.polygon!);

describe("symbols on the engine (document.symbols@1)", () => {
  let h: HeadlessHost;

  beforeAll(async () => {
    h = await openHost();
    h.loadBundle(drawBundle);
  });
  afterAll(() => h?.dispose());

  beforeEach(async () => {
    await h.load(F6_RING_PAIR.bytes());
    await h.host.selection.set([]);
  });

  it("the engine carries symbols, and the lane follows the flag", async () => {
    expect(h.host.supports(ENGINE_SYMBOLS_FEATURE)).toBe(true);
    expect(engineSymbols(h.host)).toBe(true);
    const other = withoutEngineSymbols(await openHost());
    try {
      expect(engineSymbols(other.host)).toBe(false);
    } finally {
      other.dispose();
    }
  });

  it("DEFINE adds a document symbol and leaves the selection as it was", async () => {
    await h.host.selection.set([INNER]);
    const symbol = await applyDefineSymbol(h.host, { name: "Tile" });
    expect(symbol?.name).toBe("Tile");
    const rows = await readEngineSymbols(h.host);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.instances).toEqual([]);
    // The inner square is 100 pt on a side, centred on the origin.
    expect(rows[0]!.bounds).toEqual([-50, -50, 50, 50]);
    expect(await h.host.document.elementGeometry([INNER])).toHaveLength(1);
    // One undo step removes the symbol again.
    await h.host.document.undo();
    expect(await readEngineSymbols(h.host)).toEqual([]);
  });

  it("SELECT SAME symbol instance selects the engine instances of the reference's symbol, not its source", async () => {
    await h.host.selection.set([INNER]);
    const symbol = (await applyDefineSymbol(h.host, { name: "Tile" }))!;
    const a = (await applyPlaceSymbolInstance(h.host, symbol.id, {
      x: 300,
      y: 300,
    }))!;
    const b = (await applyPlaceSymbolInstance(h.host, symbol.id, {
      x: 500,
      y: 500,
    }))!;
    await h.host.selection.set([a[0]!]);
    const rec = h.contributions.find(
      (c) => c.kind === "command" && c.id === SELECT_SAME_SYMBOL_COMMAND_ID,
    );
    await (rec!.value as CommandContribution).handler(undefined, undefined);
    const ids = h.host.selection
      .get()
      .map((e) => `${e.kind}:${String(e.id)}`)
      .sort();
    expect(ids).toEqual(
      [a[0]!, b[0]!].map((e) => `${e.kind}:${String(e.id)}`).sort(),
    );
  });

  it("PLACE, REDEFINE, RESET, BREAK, RENAME and DELETE are one undo step each", async () => {
    await h.host.selection.set([INNER]);
    const symbol = (await applyDefineSymbol(h.host, { name: "Tile" }))!;
    const placed = await applyPlaceSymbolInstance(h.host, symbol.id, {
      x: 500,
      y: 500,
    });
    expect(placed).toHaveLength(1);
    expect((placed[0] as { kind: string }).kind).toBe("instance");
    expect(h.host.selection.get()).toEqual(placed);
    const geometry = await h.host.document.elementGeometry([placed[0]!]);
    expect(geometry).toHaveLength(1);
    let rows = await readEngineSymbols(h.host);
    expect(rows[0]!.instances).toEqual([`instance:${placed[0]!.id}`]);

    // Redefine from the OUTER contour: the instance follows, one step.
    await h.host.selection.set([OUTER]);
    expect(await applyRedefineSymbol(h.host, symbol.id)).not.toBeNull();
    rows = await readEngineSymbols(h.host);
    expect(rows[0]!.revision).toBe(1);
    expect(rows[0]!.instances).toHaveLength(1);
    await h.host.document.undo();
    expect((await readEngineSymbols(h.host))[0]!.revision).toBe(0);

    // Rename — one step.
    expect(await applyRenameSymbol(h.host, symbol.id, "Square")).toBe(true);
    expect((await readEngineSymbols(h.host))[0]!.name).toBe("Square");
    await h.host.document.undo();
    expect((await readEngineSymbols(h.host))[0]!.name).toBe("Tile");

    // Reset transform: a scaled instance comes back to its own size.
    await h.host.document.mutate({
      op: "setElementProperty",
      args: {
        elementId: placed[0]!,
        path: "frameTransform",
        value: { type: "transform", value: [2, 0, 0, 2, 500, 500] },
      },
    } as never);
    await h.host.selection.set(placed);
    expect(await applyResetSymbolTransform(h.host)).toBe(1);
    const props = await h.host.document.elementProperties(placed[0]!);
    const t = (
      props?.entries.find((e) => e.path === "frameTransform")?.value as {
        value: number[];
      }
    ).value;
    expect(t).toEqual([1, 0, 0, 1, 500, 500]);

    // Break link: the instance becomes a square, one step.
    expect(await applyBreakSymbolLink(h.host)).toBe(1);
    rows = await readEngineSymbols(h.host);
    expect(rows[0]!.instances).toEqual([]);
    await h.host.document.undo();
    rows = await readEngineSymbols(h.host);
    expect(rows[0]!.instances).toHaveLength(1);

    // Delete: the instance is broken first, so the artwork stays.
    expect(await applyDeleteSymbol(h.host, symbol.id)).toBe(true);
    expect(await readEngineSymbols(h.host)).toEqual([]);
    await h.host.document.undo();
    expect(await readEngineSymbols(h.host)).toHaveLength(1);
  });
});
