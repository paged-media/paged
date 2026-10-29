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

// WP6.8 (draw ADR 365) through the REAL engine wasm: the Symbol Sprayer
// and the six Symbolism modifiers as live tool handlers, the 9-slice
// guides tool, Replace Symbol, Symbol Options and the move of a v0
// library onto the engine's symbols. Every gesture and command is ONE
// mutation and ONE undo step, and the undo restores what was there.
// [plugin-draw.symbols]

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";

import type { ElementId } from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";
import { covers } from "@paged-media/test-kit";
import type { Vec2 } from "@paged-media/draw-geometry";

import {
  applyDefineSymbol,
  applyPlaceSymbolInstance,
  applyReplaceSymbol,
  applySymbolOptions,
  chooseSymbol,
  createNineSliceHandler,
  createSymbolismHandler,
  drawBundle,
  readEngineSymbols,
  readInstanceStates,
  SYMBOLISM_TOOL_IDS,
} from "../../src";
import { packageWithSpread } from "../fixtures/build-idml";
import { poly, squareItem, PAGE_ID } from "../panels/panel-document";
import { countingHost } from "../perf/counting-host";
import { pointerAt, settle } from "../perf/pointer-stream";
import { openHost } from "./host";

const C = "media.paged.draw.command";

// Two squares to make symbols of, well apart.
const DOC = () =>
  packageWithSpread(squareItem("a", 50, 50, 40) + squareItem("b", 400, 50, 20));

const inst = (id: string): ElementId => ({ kind: "instance", id }) as ElementId;

/** The page's instances, read back: their matrix, tint and opacity. */
const states = async (h: HeadlessHost) => {
  const ids = (await readEngineSymbols(h.host)).flatMap((s) =>
    s.instances.map((a) => inst(a.slice("instance:".length))),
  );
  return readInstanceStates(h.host, ids);
};
const picture = async (h: HeadlessHost) =>
  JSON.stringify(
    (await states(h)).map((s) => [
      String(s.id.id),
      s.matrix,
      s.tint,
      s.opacity,
    ]),
  );

type Make = (onCommit: (applied: boolean) => void) => {
  onActivate(p: never): void;
  onPointerDown(e: never): void;
  onPointerMove(e: never): void;
  onPointerUp(e: never): void;
};

/** One drag with a fresh handler: press, the samples between, release —
 *  and wait for the handler to say what its commit did (null: it
 *  committed nothing). */
const drag = async (
  make: Make,
  pts: Vec2[],
  opts: { alt?: boolean } = {},
): Promise<boolean | null> => {
  let said: (a: boolean) => void = () => {};
  const done = new Promise<boolean>((r) => (said = r));
  const handler = make((a) => said(a));
  handler.onActivate(undefined as never);
  handler.onPointerDown(
    pointerAt(PAGE_ID, pts[0] as [number, number], opts) as never,
  );
  await settle();
  for (const p of pts.slice(1, -1)) {
    handler.onPointerMove(
      pointerAt(PAGE_ID, p as [number, number], opts) as never,
    );
    await settle();
  }
  handler.onPointerUp({
    ...pointerAt(PAGE_ID, pts[pts.length - 1] as [number, number], opts),
    maxDelta: 40,
  } as never);
  return Promise.race([
    done,
    new Promise<null>((r) => setTimeout(() => r(null), 10_000)),
  ]);
};

describe("draw conformance — live symbols (WP6.8) [plugin-draw.symbols]", () => {
  let h: HeadlessHost;
  let square: string;
  let placed: ElementId[];

  beforeAll(async () => {
    h = await openHost();
    h.loadBundle(drawBundle);
  });
  afterAll(() => h?.dispose());
  beforeEach(async () => {
    await h.load(DOC());
    await h.host.selection.set([poly("a")]);
    square = (await applyDefineSymbol(h.host, { name: "Square" }))!.id;
    placed = [];
    for (const [x, y] of [
      [200, 300],
      [230, 300],
      [500, 600],
    ] as const)
      placed.push(
        ...(await applyPlaceSymbolInstance(h.host, square, { x, y })),
      );
    chooseSymbol(h.host, square);
    await h.host.selection.set([]);
  });

  it("the eight tools are keyless, in one Symbolism flyout", () => {
    const tools = h.toolsContributed();
    const of = (id: string) => tools.find((t) => t.id === id);
    expect(SYMBOLISM_TOOL_IDS.map((id) => of(id)?.group)).toEqual(
      Array(8).fill("symbolism"),
    );
    for (const id of SYMBOLISM_TOOL_IDS)
      expect(of(id)?.shortcut).toBeUndefined();
  });

  it("the Symbol Sprayer places instances along the drag in ONE undo step; Alt removes what it sweeps", async () => {
    covers("tool:media.paged.draw.tool.symbolSprayer");
    const before = (await readEngineSymbols(h.host))[0]!.instances.length;
    const { host, work } = countingHost(h.host);
    const applied = await drag(
      (onCommit) =>
        createSymbolismHandler(host, "sprayer", { onCommit, dwellMs: 0 }),
      [
        [100, 500],
        [150, 500],
        [200, 500],
      ],
    );
    expect(applied).toBe(true);
    expect(work.mutations).toHaveLength(1);
    const after = (await readEngineSymbols(h.host))[0]!.instances.length;
    // Default density 5 over a 100 pt brush: a spray every 20 pt of the
    // 100 pt drag, and one at the press — six sprays of two (intensity 8).
    expect(after - before).toBe(12);
    await h.host.document.undo();
    expect((await readEngineSymbols(h.host))[0]!.instances.length).toBe(before);
    // Alt sweeps the two instances at (200, 300) and (230, 300) away.
    expect(
      await drag(
        (onCommit) =>
          createSymbolismHandler(h.host, "sprayer", { onCommit, dwellMs: 0 }),
        [
          [210, 300],
          [215, 300],
        ],
        { alt: true },
      ),
    ).toBe(true);
    expect((await readEngineSymbols(h.host))[0]!.instances).toEqual([
      `instance:${String(placed[2]!.id)}`,
    ]);
    await h.host.document.undo();
    expect((await readEngineSymbols(h.host))[0]!.instances.length).toBe(before);
  });

  const MODIFIERS = [
    ["shifter", (b: number[], a: number[]) => a[4]! > b[4]!],
    ["scruncher", (b: number[], a: number[]) => a[4]! !== b[4]!],
    ["sizer", (b: number[], a: number[]) => a[0]! > b[0]!],
    [
      "spinner",
      (b: number[], a: number[]) => Math.abs(a[1]!) > 1e-6 && b[1] === 0,
    ],
  ] as const;
  for (const [kind, moved] of MODIFIERS) {
    it(`the Symbol ${kind} changes only the instances under the brush, in ONE undo step`, async () => {
      covers(
        `tool:media.paged.draw.tool.symbol${kind[0]!.toUpperCase()}${kind.slice(1)}`,
      );
      const before = await picture(h);
      const far = (await states(h)).find(
        (s) => String(s.id.id) === String(placed[2]!.id),
      )!;
      const { host, work } = countingHost(h.host);
      const applied = await drag(
        (onCommit) =>
          createSymbolismHandler(host, kind, { onCommit, dwellMs: 0 }),
        [
          [205, 300],
          [215, 310],
          [225, 320],
        ],
      );
      expect(applied).toBe(true);
      expect(work.mutations).toHaveLength(1);
      const after = await states(h);
      const near = after.find(
        (s) => String(s.id.id) === String(placed[0]!.id),
      )!;
      const was = JSON.parse(before).find(
        (r: unknown[]) => r[0] === String(placed[0]!.id),
      );
      expect(moved(was[1], near.matrix)).toBe(true);
      // The far instance was never under the brush.
      expect(
        after.find((s) => String(s.id.id) === String(placed[2]!.id))!.matrix,
      ).toEqual(far.matrix);
      await h.host.document.undo();
      expect(await picture(h)).toBe(before);
    });
  }

  it("the Symbol Stainer tints and the Symbol Screener fades, each ONE undo step", async () => {
    covers("tool:media.paged.draw.tool.symbolStainer");
    covers("tool:media.paged.draw.tool.symbolScreener");
    const before = await picture(h);
    expect(
      await drag(
        (onCommit) =>
          createSymbolismHandler(h.host, "stainer", { onCommit, dwellMs: 0 }),
        [
          [200, 300],
          [201, 300],
        ],
      ),
    ).toBe(true);
    let s = (await states(h)).find(
      (x) => String(x.id.id) === String(placed[0]!.id),
    )!;
    expect(s.tint?.slice(0, 3)).toEqual([1, 0, 0]);
    expect(s.tint![3]).toBeGreaterThan(0);
    expect(
      await drag(
        (onCommit) =>
          createSymbolismHandler(h.host, "screener", { onCommit, dwellMs: 0 }),
        [
          [200, 300],
          [201, 300],
        ],
      ),
    ).toBe(true);
    s = (await states(h)).find(
      (x) => String(x.id.id) === String(placed[0]!.id),
    )!;
    expect(s.opacity).toBeLessThan(100);
    await h.host.document.undo();
    await h.host.document.undo();
    expect(await picture(h)).toBe(before);
  });

  it("the live tool writes without a commit hook (as the rail runs it)", async () => {
    const before = (await readEngineSymbols(h.host))[0]!.instances.length;
    const handler = createSymbolismHandler(h.host, "sprayer", { dwellMs: 0 });
    handler.onActivate(undefined as never);
    handler.onPointerDown(pointerAt(PAGE_ID, [100, 500]));
    await settle();
    handler.onPointerUp({ ...pointerAt(PAGE_ID, [140, 500]), maxDelta: 40 });
    const deadline = Date.now() + 10_000;
    while (
      (await readEngineSymbols(h.host))[0]!.instances.length === before &&
      Date.now() < deadline
    )
      await settle();
    expect(
      (await readEngineSymbols(h.host))[0]!.instances.length,
    ).toBeGreaterThan(before);
  });

  it("Escape mid-drag writes nothing", async () => {
    const quiet = countingHost(h.host);
    const handler = createSymbolismHandler(quiet.host, "sizer", { dwellMs: 0 });
    handler.onActivate(undefined as never);
    handler.onPointerDown(pointerAt(PAGE_ID, [200, 300]));
    await settle();
    handler.onKey!({ key: "Escape" } as KeyboardEvent);
    await settle();
    handler.onPointerUp(pointerAt(PAGE_ID, [200, 300]));
    await settle();
    expect(quiet.work.mutations).toHaveLength(0);
  });

  it("the 9-slice guides tool drags a guide of the selected instance's symbol, ONE undo step", async () => {
    covers("tool:media.paged.draw.tool.symbolNineSlice");
    await h.host.selection.set([placed[0]!]);
    let said: (a: boolean) => void = () => {};
    const done = new Promise<boolean>((r) => (said = r));
    const tool = createNineSliceHandler(h.host, { onCommit: (a) => said(a) });
    tool.onActivate(undefined as never);
    await settle();
    // The 40 pt square at (200, 300): default guides 10 pt in; the left
    // one is drawn at x = 190.
    tool.onPointerDown(pointerAt(PAGE_ID, [190, 300]));
    await settle();
    tool.onPointerMove(pointerAt(PAGE_ID, [195, 300]));
    await settle();
    tool.onPointerUp(pointerAt(PAGE_ID, [195, 300]));
    expect(await done).toBe(true);
    const sym = (await readEngineSymbols(h.host))[0]!;
    expect(sym.nineSlice?.map((v) => Math.round(v * 100) / 100)).toEqual([
      15, 10, 10, 10,
    ]);
    await h.host.document.undo();
    expect((await readEngineSymbols(h.host))[0]!.nineSlice).toBeNull();
    tool.onDeactivate("switch");
  });

  it("Symbol Options sets the name and the 9-slice guides, and [] removes them — one undo step each", async () => {
    covers(`command:${C}.symbolOptions`);
    await h.objects.invoke(`${C}.symbolOptions`, {
      symbol: square,
      name: "Tile",
      nineSlice: [5, 6, 7, 8],
    });
    let sym = (await readEngineSymbols(h.host))[0]!;
    expect(sym.name).toBe("Tile");
    expect(sym.nineSlice).toEqual([5, 6, 7, 8]);
    await applySymbolOptions(h.host, { symbolId: square, nineSlice: [] });
    expect((await readEngineSymbols(h.host))[0]!.nineSlice).toBeNull();
    await h.host.document.undo();
    expect((await readEngineSymbols(h.host))[0]!.nineSlice).toEqual([
      5, 6, 7, 8,
    ]);
    await h.host.document.undo();
    sym = (await readEngineSymbols(h.host))[0]!;
    expect(sym.name).toBe("Square");
    // Guides wider than the symbol are the engine's refusal.
    expect(
      await applySymbolOptions(h.host, {
        symbolId: square,
        nineSlice: [30, 0, 30, 0],
      }),
    ).toBe(false);
  });

  it("Replace Symbol points the selected instances at another symbol, keeping their ids, ONE undo step", async () => {
    covers(`command:${C}.replaceSymbol`);
    await h.host.selection.set([poly("b")]);
    const small = (await applyDefineSymbol(h.host, { name: "Small" }))!.id;
    await h.host.selection.set([placed[0]!, placed[1]!]);
    expect(await applyReplaceSymbol(h.host, small)).toBe(2);
    const rows = await readEngineSymbols(h.host);
    expect(rows.find((r) => r.id === small)!.instances.sort()).toEqual(
      [placed[0]!, placed[1]!].map((p) => `instance:${String(p.id)}`).sort(),
    );
    await h.host.document.undo();
    expect(
      (await readEngineSymbols(h.host)).find((r) => r.id === small)!.instances,
    ).toEqual([]);
    // The typed twin, by address.
    await h.host.selection.set([placed[2]!]);
    await h.objects.invoke(`${C}.replaceSymbol`, {
      targets: [`instance:${String(placed[2]!.id)}`],
      symbol: small,
    });
    expect(
      (await readEngineSymbols(h.host)).find((r) => r.id === small)!.instances,
    ).toEqual([`instance:${String(placed[2]!.id)}`]);
  });

  it("Select Same ▸ Symbol instance selects every instance of the reference's symbol", async () => {
    await h.host.selection.set([placed[0]!]);
    await h.objects.invoke(`${C}.selectSameSymbolInstance`, {
      targets: [`instance:${String(placed[0]!.id)}`],
    });
    expect(
      h.host.selection
        .get()
        .map((e) => String(e.id))
        .sort(),
    ).toEqual(placed.map((p) => String(p.id)).sort());
  });

  it("the object model lists the engine's symbols and instances", async () => {
    const D = "media.paged.draw";
    const symbols = await h.objects.query(`plugin:${D}/symbol`);
    expect(symbols).toEqual([`plugin:${D}/symbol/${square}`]);
    expect(await h.objects.get(symbols[0]!, "instanceCount")).toEqual({
      kind: "value",
      value: 3,
    });
    const instances = await h.objects.query(`plugin:${D}/symbolInstance`);
    expect(instances).toHaveLength(3);
    expect(await h.objects.get(instances[0]!, "symbol")).toEqual({
      kind: "value",
      value: `plugin:${D}/symbol/${square}`,
    });
  });
});
